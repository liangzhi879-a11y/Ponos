// cli 接线端到端：loop 载荷驱动轮次推进 + loop_command 指令族路由 + 零回归锁②③。
// ---------------------------------------------------------------------------
// 环境（按仓库既有 CLI spawn 测试实测口径，非计划原文）：
//   · 参数：--print --output-format stream-json --input-format stream-json --verbose
//     --dangerously-skip-permissions --add-dir <dir>（`--skip-permissions` 在内核
//     parseArgs 里是**未知参数**，会被静默忽略 → 审批档位回落默认 → 验真 Bash 会挂在
//     审批上；必须用契约里的全名）
//   · mock：PONOS_MOCK_API=1（内核内置幂等 mock 流，无网络）
//   · 会话 home：CLAUDE_CONFIG_DIR（resolveConfigDir 第一优先级；同时给 PONOS_HOME
//     兜底，与 chat-mode.test.mjs 同口径）
// 覆盖：loop start/iter/end 帧推进、loop_command（status/replay/memory/stop）回执、
// 零回归锁②（无 loop 字段的普通消息不得发任何 loop 帧）、doneWhen 失败轮 iter 带
// verify 摘要且上限耗尽能收尾。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')
const FMT = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeKernel(extraEnv = {}, opts = {}) {
  // opts.dir/home 供 --resume 用例复用同一 home（两次 spawn 读同一份落盘 loop 状态）；
  // 共享时 keepDir 跳过 rmSync，由调用方统一清理。
  const dir = opts.dir || mkdtempSync(join(tmpdir(), 'ponos-loope2e-'))
  const home = opts.home || join(dir, 'home')
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    CLAUDE_CONFIG_DIR: home,
    PONOS_HOME: home,
    PONOS_BUDGET_USD: '0',
    // [mock:write]（本文件 doneWhen 用例用）写文件的目标目录：固定为本次临时 add-dir，
    // 免得 mock 的产物落到仓库工作区里（spawn 未指定 cwd ⇒ 默认是仓库根）
    PONOS_MOCK_WRITE_DIR: dir,
    ...extraEnv,
  }
  const proc = spawn(process.execPath, [KERNEL_CLI, ...FMT, '--dangerously-skip-permissions', '--add-dir', dir, ...(opts.extraArgs || [])], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  const stderr = []
  let buf = ''
  // 数据块会把一行切两半 → 必须按 NDJSON 行缓冲解析（不能对 raw 正则）
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行/脏行跳过 */ }
    }
  })
  proc.stderr.on('data', (d) => { stderr.push(String(d)) })
  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n')
  const waitFor = async (pred, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = events.find(pred)
      if (hit) return hit
      await sleep(15)
    }
    return null
  }
  return {
    proc, events, send, waitFor, dir,
    diag: () => `events=${JSON.stringify(events.map((e) => `${e.type}${e.state ? ':' + e.state : ''}${e.subtype ? ':' + e.subtype : ''}`))}\nstderr=${stderr.join('').slice(-1500)}`,
    // 模拟崩溃：直接 kill，不等优雅退出（resume 用例需保留未终结的落盘状态）
    crash: () => { try { proc.kill('SIGKILL') } catch { /* 已退出 */ } },
    cleanup: async () => {
      try { proc.stdin.end() } catch { /* 已关闭 */ }
      await Promise.race([once(proc, 'close'), sleep(2000)])
      try { proc.kill() } catch { /* 已退出 */ }
      await sleep(50)
      if (opts.keepDir) return
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄释放竞态：目录残留不影响断言 */ }
    },
  }
}

test('loop 载荷驱动多轮推进：start → iter → end(completed)', async () => {
  const k = makeKernel()
  try {
    assert.ok(await k.waitFor((e) => e.type === 'system' && e.subtype === 'init'), '应发 init')
    k.send({ type: 'user', message: { role: 'user', content: '你好' }, loop: { count: 2 } })
    const start = await k.waitFor((e) => e.type === 'loop' && e.state === 'start')
    assert.ok(start, `应发 loop start 帧；${k.diag()}`)
    assert.equal(start.total, 2)
    // 零回归锁③：既有字段仍在（until/fresh/index）
    assert.equal(start.until, '')
    assert.equal(start.fresh, false)
    assert.equal(start.index, 0)
    const end = await k.waitFor((e) => e.type === 'loop' && e.state === 'end')
    assert.ok(end, `应发 loop end 帧；${k.diag()}`)
    assert.equal(end.reason, 'completed')
    assert.equal(end.index, 2)
    assert.equal(typeof end.total, 'number')
    const iters = k.events.filter((e) => e.type === 'loop' && e.state === 'iter')
    assert.equal(iters.length, 2, '两轮各一条 iter')
  } finally { await k.cleanup() }
})

test('loop_command status：回执含状态与轮次（新增指令族路由）', async () => {
  const k = makeKernel()
  try {
    assert.ok(await k.waitFor((e) => e.type === 'system' && e.subtype === 'init'), '应发 init')
    k.send({ type: 'loop_command', op: 'status', args: [], requestId: 'req-1' })
    const r = await k.waitFor((e) => e.type === 'system' && e.subtype === 'loop_result' && e.requestId === 'req-1')
    assert.ok(r, `应回 loop_result；${k.diag()}`)
    assert.equal(r.op, 'status')
    assert.equal(r.ok, true)
    assert.match(String(r.text), /loop 状态/)
  } finally { await k.cleanup() }
})

test('loop_command replay / memory / stop 回执可用', async () => {
  const k = makeKernel()
  try {
    assert.ok(await k.waitFor((e) => e.type === 'system' && e.subtype === 'init'), '应发 init')
    for (const op of ['replay', 'memory', 'stop']) {
      k.send({ type: 'loop_command', op, args: [], requestId: `req-${op}` })
    }
    for (const op of ['replay', 'memory', 'stop']) {
      const r = await k.waitFor((e) => e.type === 'system' && e.subtype === 'loop_result' && e.requestId === `req-${op}`)
      assert.ok(r, `${op} 应有回执；${k.diag()}`)
      assert.equal(r.ok, true, `${op} 应成功`)
      assert.ok(String(r.text).length > 0, `${op} 应有文本回执`)
    }
  } finally { await k.cleanup() }
})

test('零回归锁②：普通消息（无 loop 字段）不触发 loop 帧', async () => {
  const k = makeKernel()
  try {
    assert.ok(await k.waitFor((e) => e.type === 'system' && e.subtype === 'init'), '应发 init')
    k.send({ type: 'user', message: { role: 'user', content: '你好' } })
    assert.ok(await k.waitFor((e) => e.type === 'result'), `应完成一轮；${k.diag()}`)
    await sleep(200) // 轮末 finally 已跑完（loop 推进在此处）
    assert.equal(k.events.filter((e) => e.type === 'loop').length, 0, '无 loop 字段不得发 loop 帧')
  } finally { await k.cleanup() }
})

test('doneWhen 命令式验真失败 → 继续下一轮且 iter 带 verify 摘要；次数耗尽以 failed 收尾', async () => {
  // 本用例曾**绕过**一个真实缺陷：控制器 doneWhen 分支不检查 count 上限 → `--done` 永不通过的
  // loop 无视次数上限无限跑，测试当时靠 maxWallMs 兜底并放宽断言为 completed|budget_exceeded。
  // 缺陷已在 kernel/loop.mjs 修复（轮数用尽 + 验真未过 → end('failed')），故此处改为严格断言：
  // 不给任何预算护栏，仅靠次数上限收尾，且收尾原因必须是 failed。
  // [mock:write] 意图：让每轮都产生工具调用 → iter 帧的 steps 必须 > 0。若 cli 没把
  // engine.runTurn 的返回值（toolDigest）喂给 loop.onTurnEnd，steps 恒为 0 —— 该断言就是
  // "轮次 outcome 采集"的检测口。
  // PONOS_LOOP_NOPROGRESS_N=99：本用例每轮指纹必然相同（同工具同路径），默认阈值 3 会在
  // 第 3 轮触发"无进展升级"抢占收尾；关掉后只剩"次数耗尽"一条收尾路径 → 确定性。
  const k = makeKernel({ PONOS_LOOP_NOPROGRESS_N: '99' })
  try {
    assert.ok(await k.waitFor((e) => e.type === 'system' && e.subtype === 'init'), '应发 init')
    k.send({
      type: 'user', message: { role: 'user', content: '[mock:write] 修 bug' },
      loop: { count: 2, doneWhen: [{ type: 'cmd', run: 'node -e "process.exit(1)"' }] },
    })
    const end = await k.waitFor((e) => e.type === 'loop' && e.state === 'end', 25_000)
    assert.ok(end, `验证始终失败 → 应由次数上限收尾（不得无限跑）；${k.diag()}`)
    assert.equal(end.reason, 'failed', `轮数用尽而目标未达成应为 failed；实际 ${end.reason}`)
    const iters = k.events.filter((e) => e.type === 'loop' && e.state === 'iter')
    assert.equal(iters.length, 2, `count=2 应恰好跑 2 轮后收尾；${k.diag()}`)
    assert.ok(iters.some((e) => e.verify && e.verify.passed === false), `iter 帧应带 verify 摘要；${k.diag()}`)
    assert.ok(iters.some((e) => e.steps > 0), `iter 帧 steps 应 >0（toolDigest 采集生效）；${k.diag()}`)
  } finally { await k.cleanup() }
})

// 回归：--every 间隔的延迟投递必须可取消。
// 修复前：定时器到点无条件投递下一轮 → handleUser 见 !loop.isActive() 把已 cancelled
// 的 loop 重新 start（表现为"点了停止，过了一会儿又自己跑起来"）。
test('--every 间隔期间 stop → 不得再投递下一轮（停止后不再跑）', async () => {
  const k = makeKernel({ PONOS_LOOP_NOPROGRESS_N: '99' })
  try {
    assert.ok(await k.waitFor((e) => e.type === 'system' && e.subtype === 'init'), '应发 init')
    k.send({ type: 'user', message: { role: 'user', content: '[mock:echo] 巡检' }, loop: { count: 9, everyMs: 600 } })
    const it1 = await k.waitFor((e) => e.type === 'loop' && e.state === 'iter', 20_000)
    assert.ok(it1, `应完成第 1 轮；${k.diag()}`)
    // 第 1 轮结束进入 600ms 延迟投递窗口，在此期间停止
    k.send({ type: 'loop_command', op: 'stop', args: [], requestId: 'stop-1' })
    const stopRes = await k.waitFor((e) => e.type === 'system' && e.subtype === 'loop_result' && e.requestId === 'stop-1', 10_000)
    assert.ok(stopRes?.ok, `stop 应有成功回执；${k.diag()}`)
    assert.ok(await k.waitFor((e) => e.type === 'loop' && e.state === 'end' && e.reason === 'cancelled', 10_000), `应 end(cancelled)；${k.diag()}`)
    // 越过多轮投递窗口：不得出现新的 iter（新 iter 即"停止后又跑一轮"）
    await new Promise((r) => setTimeout(r, 1500))
    const iters = k.events.filter((e) => e.type === 'loop' && e.state === 'iter')
    assert.equal(iters.length, 1, `停止后不得推进轮次，实际 iter=${iters.length}；${k.diag()}`)
  } finally { await k.cleanup() }
})

// 回归：--resume 断点续跑。
// 修复前：cli 只在启动时调 loop.load()（还原 status='running'、index=1）而**不投递**
// 下一轮 —— onTurnEnd 仅在轮末被调用，故恢复后静默停住，"断点续跑"形同虚设。
test('--resume 恢复未终结 loop 并继续推进（断点续跑）', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'ponos-loopresume-'))
  const k1 = makeKernel({}, { dir: shared, home: join(shared, 'home'), keepDir: true })
  try {
    const init = await k1.waitFor((e) => e.type === 'system' && e.subtype === 'init')
    assert.ok(init, `轮 1 应发 init；${k1.diag()}`)
    const sid = init.session_id
    assert.ok(sid, 'init 应带 session_id（--resume 需复用它）')

    // everyMs 取大值：第 1 轮后进入长等待窗口，便于在"未终结"状态下杀掉进程
    k1.send({ type: 'user', message: { role: 'user', content: '巡检' }, loop: { count: 3, everyMs: 60000 } })
    const it1 = await k1.waitFor((e) => e.type === 'loop' && e.state === 'iter', 30_000)
    assert.ok(it1, `轮 1 应完成 iter；${k1.diag()}`)
    assert.equal(it1.index, 1)
    k1.crash() // 模拟崩溃：此时 index=1 / status=running 已落盘
    await k1.cleanup()

    const k2 = makeKernel({}, { dir: shared, home: join(shared, 'home'), keepDir: true, extraArgs: ['--resume', sid] })
    try {
      const resumed = await k2.waitFor((e) => e.type === 'loop' && e.state === 'start', 30_000)
      assert.ok(resumed, `--resume 应发 loop start（resumed）；${k2.diag()}`)
      assert.equal(resumed.resumed, true, 'start 帧应标记 resumed:true')
      // 关键：不得静默停住 —— 恢复后应续跑下一轮（且无需再等 60s 间隔）
      const it2 = await k2.waitFor((e) => e.type === 'loop' && e.state === 'iter', 25_000)
      assert.ok(it2, `恢复后应续跑下一轮（不得静默停住）；${k2.diag()}`)
      assert.equal(it2.index, 2, '轮次应接着 1 往后走')
    } finally { await k2.cleanup() }
  } finally {
    try { rmSync(shared, { recursive: true, force: true }) } catch { /* 句柄竞态 */ }
  }
})
