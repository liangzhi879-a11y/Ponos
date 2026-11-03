// 磁盘原子写的 rename 重试（2026-10-18，由 loop-e2e 间歇假红追出的**真实缺陷**）
//
// 【怎么发现的】`loop-e2e-resurrect` 在全量下间歇失败：断言「第 1 轮后应武装未来的 nextRunAt」
//   拿到 `nextRunAt=0`，而 `status=running`、`index=1`、`everyMs=300000`。单跑永远通过。
//   加观察历史后确认：磁盘上**从未**出现过未来的 nextRunAt。
//
// 【根因（已用实验证实，不是推测）】写者用 `writeFileSync(tmp) + renameSync(tmp, dst)`，
//   读者每 25ms `readFileSync(dst)`。实测 3000 次 rename 中 **50 次 EPERM（1.7%）**：
//   Windows 上目标文件正被读句柄打开时，rename 覆盖会偶发失败。
//
// 【为什么这是生产缺陷而不只是测试问题】
//   `kernel/loop.mjs#persist()` 正是这个写法，而**桥主管与 GUI 都在轮询**循环状态文件
//   （`aliveAt` 心跳就靠它）。persist 失败只 `warning` 一次然后静默 ⇒ 磁盘长期停留在旧状态
//   ⇒ 循环的 `nextRunAt` 永远是 0 ⇒ **内核被回收后主管无法唤醒，断点续跑能力静默失效**。
//   `shared/atomic-write.mjs` 同样没有重试（它被知识库写入、配置保存等多处使用）。
//
// 【修法】把 rename 抽成 `renameWithRetrySync`：对**瞬时**错误码（EPERM/EACCES/EBUSY/EMFILE/ENFILE）
//   短暂退避重试；对**确定性**错误（ENOENT/EXDEV…）立即抛 —— 重试它们只会拖慢失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renameWithRetrySync, RENAME_RETRY_CODES } from '../shared/atomic-write.mjs'

/** 造一个"前 n 次失败、之后成功"的假 rename */
function flakyRename(failTimes, code = 'EPERM') {
  let n = 0
  const fn = (from, to) => {
    n += 1
    fn.calls = n          // ★ 每次调用都要计数（第一版只在成功路径赋值 ⇒ 抛错时 calls 恒为 0，
                          //   把"只调用 1 次就抛"和"调用了 8 次"都测成了 0，两条断言假失败）
    if (n <= failTimes) {
      const e = new Error(`${code}: simulated`)
      e.code = code
      throw e
    }
    fn.lastArgs = [from, to]
    return undefined
  }
  fn.calls = 0
  fn.lastArgs = null
  return fn
}

test('★ 瞬时 EPERM 必须重试成功（正是实测 1.7% 失败的那个码）', () => {
  const impl = flakyRename(2, 'EPERM')
  renameWithRetrySync('/tmp/a.tmp', '/tmp/a.json', { renameImpl: impl, sleepImpl: () => {} })
  assert.equal(impl.calls, 3, '前 2 次 EPERM 后第 3 次成功 —— 应共调用 3 次')
  assert.deepEqual(impl.lastArgs, ['/tmp/a.tmp', '/tmp/a.json'], '必须用原参数重试，不得换路径')
})

test('★ 其余瞬时码也必须重试（EACCES / EBUSY / EMFILE / ENFILE）', () => {
  for (const code of ['EACCES', 'EBUSY', 'EMFILE', 'ENFILE']) {
    assert.ok(RENAME_RETRY_CODES.has(code), `${code} 应属瞬时错误集合`)
    const impl = flakyRename(1, code)
    renameWithRetrySync('/x.tmp', '/x.json', { renameImpl: impl, sleepImpl: () => {} })
    assert.equal(impl.calls, 2, `${code} 应重试一次后成功`)
  }
})

test('★ 确定性错误必须立即抛（重试它们只会拖慢失败）', () => {
  for (const code of ['ENOENT', 'EXDEV', 'ENOSPC']) {
    const impl = flakyRename(99, code)
    assert.throws(
      () => renameWithRetrySync('/x.tmp', '/x.json', { renameImpl: impl, sleepImpl: () => {} }),
      (e) => e.code === code,
      `${code} 必须原样抛给调用方`,
    )
    assert.equal(impl.calls, 1, `${code} 不得重试（调用 1 次即抛）`)
  }
})

test('★ 重试必须有上限（一直 EPERM 时不得无限循环）', () => {
  const impl = flakyRename(999, 'EPERM')
  assert.throws(
    () => renameWithRetrySync('/x.tmp', '/x.json', { renameImpl: impl, sleepImpl: () => {}, attempts: 4 }),
    (e) => e.code === 'EPERM',
  )
  assert.equal(impl.calls, 4, '应恰好尝试 attempts 次后抛出（实得 ' + impl.calls + '）')
})

test('★ 退避必须真的等待（不是空转烧 CPU）', () => {
  const sleeps = []
  const impl = flakyRename(3, 'EPERM')
  renameWithRetrySync('/x.tmp', '/x.json', {
    renameImpl: impl,
    attempts: 6,
    baseDelayMs: 10,
    sleepImpl: (ms) => { sleeps.push(ms) },
  })
  assert.equal(sleeps.length, 3, '3 次失败应有 3 次退避')
  assert.ok(sleeps.every((ms) => ms > 0), '退避时长必须为正')
  // 递增（或至少不递减）：避免高频硬撞同一个锁
  assert.ok(sleeps[1] >= sleeps[0] && sleeps[2] >= sleeps[1], `退避应递增，实得 ${JSON.stringify(sleeps)}`)
})

test('★★ 真实文件系统：并发读者存在时也不得失败（修前实测 1.7% EPERM）', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')

  const dir = mkdtempSync(join(tmpdir(), 'ponos-rename-retry-'))
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({ n: -1 }), 'utf-8')

  // 读者子进程：模拟 readArmed 的 25ms 轮询 + 桥主管/GUI 的轮询
  const reader = spawn(process.execPath, ['-e', `
    const { readFileSync } = require('node:fs')
    const file = ${JSON.stringify(file)}
    const t0 = Date.now()
    while (Date.now() - t0 < 6000) {
      try { readFileSync(file, 'utf-8') } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  `], { stdio: 'ignore' })

  try {
    // 给读者一点时间先跑起来，制造真实的"读句柄正打开"竞争
    await new Promise((r) => setTimeout(r, 150))
    let failed = 0
    const N = 800
    for (let i = 0; i < N; i++) {
      const tmp = `${file}.tmp`
      try {
        writeFileSync(tmp, JSON.stringify({ n: i }), 'utf-8')
        renameWithRetrySync(tmp, file)   // ← 被测函数
      } catch {
        failed += 1
        try { rmSync(tmp, { force: true }) } catch {}
      }
    }
    assert.equal(failed, 0,
      `${N} 次并发读下的写入**不得有失败**（修前实测约 1.7% EPERM）—— 实得 ${failed} 次。`
      + 'persist 失败会让磁盘长期停留在旧状态，循环的 nextRunAt 永远是 0、断点续跑静默失效')
    // 内容必须是**完整的**一次写入（原子性未丢）
    const final = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(typeof final.n, 'number', '最终内容必须是完整 JSON（原子性不得因重试而丢失）')
  } finally {
    try { reader.kill('SIGKILL') } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
  }
})

test('★ 接线：atomic-write 与 loop persist 都必须走重试版（不得各写一份裸 rename）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const read = (p) => readFileSync(new URL(p, `file://${root}`.replace(/\\/g, '/')), 'utf8')

  const aw = read('shared/atomic-write.mjs')
  const loop = read('kernel/loop.mjs')

  // atomic-write：writeFileAtomicSync 内部必须用重试版
  assert.match(aw, /renameWithRetrySync\(/, 'atomic-write.mjs 必须用 renameWithRetrySync')

  // loop：persist 必须走**共享的可靠写**。
  // ★ 2026-10-18 后续（耐久性修复）：loop persist 已从"直接调 renameWithRetrySync"
  //   升级为"调 writeFileAtomicSync"（它内部既 fsync 又用 renameWithRetrySync）。
  //   ⇒ 断言守**意图**而非具体函数名：只要用的是共享实现即可，**关键是不许自己手写裸 rename**。
  const usesShared = /writeFileAtomicSync\(/.test(loop) || /renameWithRetrySync\(/.test(loop)
  assert.ok(usesShared,
    'loop 状态落盘必须走共享的可靠写（writeFileAtomicSync 或 renameWithRetrySync）—— '
    + '`nextRunAt` 是桥主管据以唤醒的唯一依据')
  // 反向守卫：不得再出现"自己 writeFileSync 到 tmp 再 rename"的手写组合
  assert.ok(!/writeFileSync\([^)]*\.tmp[^)]*\)[\s\S]{0,200}?renameSync\(/.test(loop),
    'loop.mjs 不得残留手写 tmp+rename（无 fsync，断电会留下空/半截文件）')
})
