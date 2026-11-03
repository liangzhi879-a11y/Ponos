// 前缀缓存观测 · 引擎接线契约（2026-09-18 spec §4/§6）
// ---------------------------------------------------------------------------
// 本文件锁四件事：
//   1) **默认关**：不设 PONOS_CACHE_OBS 时 stderr 零 `[cache]`，轮次照常收尾
//      （内核 stderr 会 ① 转发 ② 落 kernel-stderr.log ③ 转发渲染器——每请求一行是真实成本）。
//   2) **行形状**：字段齐全、定长字段名，便于 grep/awk。
//   3) **unsupported 真实可达**：mock 的 MOCK_USAGE 不含 cache 字段（api.mjs:245），
//      故本夹具下必判 unsupported——这恰好也是本地 vLLM 端点的真实形态，
//      断言它证明"不假警"这条设计约束在端到端链路上成立。
//   4) **开关惰性读**：走 settings.json 的 env 通道同样生效（perf.mjs 头注 1 的坑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const FIXTURE = '[mock:tool-safe] 跑一次安全命令'

// 行形状：[cache] turn=1 req=1 in=10 read=0 new=0 total=10 hit=0.000 st=unsupported
// 可选后缀：cause=post-aged / cause=history-rewrite / cause=server-compact / drop=90000
// ★ v2 A5 权威版本（替换原「cause 二值 + 美元符号锚点」版本）：四值 + (?![\\s\\S]) 末尾锚点
const LINE_RE = new RegExp(
  '^\\[cache\\] turn=(\\d+) req=(\\d+) in=(\\d+) read=(\\d+) new=(\\d+) total=(\\d+)' +
  ' hit=(\\d+\\.\\d{3}) st=(ok|suspicious|compacted|unsupported)' +
  '(?: cause=(post-compaction|post-aged|history-rewrite|server-compact))?(?: drop=(\\d+))?(?![\\s\\S])',
)

function spawnKernel(env, dir) {
  const base = { ...process.env }
  delete base.PONOS_CACHE_OBS
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], {
    env: { ...base, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: dir, YFW_HOME: dir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let err = ''
  const events = []
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行跳过 */ }
    }
  })
  proc.stderr.on('data', (d) => err += d)
  // A-2（评审 Minor-6）：stderr 是**另一条管道**——只等 stdout 的 result 事件会少读最后
  // 一行 [cache]（轮末结算 engine.mjs:1171 走 stderr）。'end' 在**所有已写数据被消费后**
  // 才触发，是"stderr 已读全"的确定性信号（比等 result 后 setTimeout 更可靠）。
  let errEnded = false
  proc.stderr.on('end', () => { errEnded = true })
  proc.stderr.on('close', () => { errEnded = true })
  // 子进程已退出后再写/关 stdin 会 EPIPE：无监听器会变成未捕获异常（关 stdin 是 A-2 的收尾动作）
  proc.stdin.on('error', () => { /* EPIPE 静默：仅发生在子进程先退出时 */ })
  return { proc, events, get err() { return err }, get errEnded() { return errEnded } }
}

const waitFor = async (fn, ms = 20_000, step = 100) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return fn()
}

const cacheLines = (err) => err.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[cache]'))

async function runTurn({ env = {}, settings = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cache-obs-'))
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8')
  const k = spawnKernel(env, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    k.proc.stdin.write(JSON.stringify({
      type: 'user', session_id: 'cache-obs-session',
      message: { role: 'user', content: FIXTURE },
    }) + '\n')
    // 评审 Finding 2：waitFor 超时只返回 false，不纳入断言就会退化成"20s 空等 + 可能
    // flake"而非硬红。本文件仅两处 waitFor（等 result、等 stderr 读全），两处都纳入断言。
    assert.ok(
      await waitFor(() => k.events.some((e) => e.type === 'result') || k.proc.exitCode !== null, 20_000),
      '本轮应在超时前产出 result 事件（或子进程已退出）',
    )
    // A-2（评审 Minor-6）：只等 result **不够**——result 走 stdout、最后一行 [cache] 走
    // stderr，两条管道异步 ⇒ 此时快照 stderr 存在极小概率少读一行（下方 >= 2 断言 flake）。
    // 修法：等 result 后主动关 stdin（cli.mjs:1608 的 readline close → 本轮收尾后 shutdown(0)），
    // 再等 stderr 通道读全（errEnded）。等子进程退出同样可行，但 stdin 保持打开时内核不会
    // 自行退出（stream-json 输入模式），必须显式 end()。
    try { k.proc.stdin.end() } catch { /* 子进程已退出 */ }
    // 评审 Finding 2：本行原为"裸 await（结果丢弃）"——超时无人管，stderr 少读一行会在下游
    // 以"行数不足"的形式偶发报错。返回值纳入断言后，通道未读全即在此硬红。
    assert.ok(await waitFor(() => k.errEnded, 20_000), 'stderr 通道未在读全前结束（[cache] 行可能被漏读）')
    return { dir, events: k.events, err: k.err, lines: cacheLines(k.err), cleanup() {
      try { k.proc.kill() } catch { /* 已退出 */ }
      rmSync(dir, { recursive: true, force: true })
    } }
  } catch (e) {
    try { k.proc.kill() } catch { /* 已退出 */ }
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

// ★ 2026-10-20（T0.5，口径反转）：默认从**关**改为**开**（`PONOS_CACHE_OBS !== '0'`）。
//   为什么反转：观测是纯只读（只分类 usage 帧，不发请求、不改请求体），而"缓存命中率到底多少"
//   此前在真实会话里长期没有数据 —— 它正是判断"前缀削减值不值"的唯一依据。
//   ★ 同时收紧了一条判据（同日实测）：`unsupported`（模型不报缓存字段 ⇒ 没有数据可观测）
//   默认**不写行**。理由：默认开之后它变成"每请求一行纯噪声"，按请求量往 stderr 灌 I/O，
//   实测让一条 busy-spin 时序用例从绿变红（纯负载副作用）。要看它请 `PONOS_CACHE_OBS=verbose`。
//   ⇒ 本用例用**真有缓存字段的 mock**（PONOS_MOCK_CACHE_SEQ）断言默认态确实出数据行 ——
//   这比"断言有一行 unsupported"强得多：它证明的是"真数据流到了日志"，不是"代码路径走过了"。
test('★ T0.5 默认开：不设 PONOS_CACHE_OBS ⇒ 真有缓存数据时出 [cache] 行', async () => {
  const r = await runTurn({ env: { PONOS_MOCK_CACHE_SEQ: 'in:10000,read:90000|in:10000,read:90000' } })
  try {
    assert.ok(r.events.some((e) => e.type === 'result'), `夹具应正常收尾\nstderr=${r.err.slice(-400)}`)
    assert.ok(r.lines.length >= 1, `★ 默认必须观测并出 [cache] 行（实测 ${r.lines.length} 行）\nstderr=${r.err.slice(-400)}`)
    for (const line of r.lines) {
      const m = LINE_RE.exec(line)
      assert.ok(m, `行形状不符：${line}`)
      assert.notEqual(m[8], 'unsupported', '★ 默认态不该出现 unsupported（那是无数据可观测的形态，默认静默）')
    }
  } finally { r.cleanup() }
})

test('★ T0.5 默认态对 unsupported 静默（每请求一行纯噪声 = 按请求量灌 I/O）', async () => {
  // mock 的 MOCK_USAGE 不带缓存字段 ⇒ 判 unsupported ⇒ 默认不写行（要看得设 verbose）
  const r = await runTurn()
  try {
    assert.ok(r.events.some((e) => e.type === 'result'), '轮次应正常收尾')
    assert.deepEqual(r.lines, [], `★ unsupported 默认必须静默（实测 ${JSON.stringify(r.lines)}）`)
  } finally { r.cleanup() }
  // 显式 verbose ⇒ 照旧逐请求记录（诊断能力没有被拿掉）
  const v = await runTurn({ env: { PONOS_CACHE_OBS: 'verbose' } })
  try {
    assert.ok(v.events.some((e) => e.type === 'result'), '轮次应正常收尾')
    assert.ok(v.lines.length >= 1, `PONOS_CACHE_OBS=verbose 必须恢复逐请求记录（实测 ${v.lines.length} 行）`)
    for (const line of v.lines) assert.equal(LINE_RE.exec(line)?.[8], 'unsupported')
  } finally { v.cleanup() }
})

test('★ PONOS_CACHE_OBS=0：显式关闭 ⇒ stderr 零 [cache] 行（含"cache 字样"整体静默）', async () => {
  const r = await runTurn({ env: { PONOS_CACHE_OBS: '0' } })
  try {
    assert.ok(r.events.some((e) => e.type === 'result'), `夹具应正常收尾\nstderr=${r.err.slice(-400)}`)
    assert.deepEqual(r.lines, [], `关闭时必须零 [cache] 输出\n实际=${JSON.stringify(r.lines)}`)
    // 原有约束原样保留（只锁 `[cache]` 前缀行；stderr 还有内核既有诊断如 "kernel start"）：
    // 关闭时不得出现任何**提到 cache** 的 stderr 行（观测器唯一出口就是 [cache] 行）。
    // ★ 必须先剔除夹具目录名（tmpdir 前缀就叫 "cache-obs-"，它出现在 "kernel start" 的 cwd 里）
    //   —— 不剔除会永远假红（**路径回声 ≠ 观测器诊断**）。
    const dirName = r.dir.split(/[\\/]/).pop()
    const stripped = r.err.split(dirName).join('<DIR>')
    const cacheMentions = stripped.split('\n').filter((l) => l.trim() && /cache/i.test(l))
    assert.deepEqual(cacheMentions, [], `关闭时不得有任何缓存观测诊断\n实际=${JSON.stringify(cacheMentions)}`)
  } finally { r.cleanup() }
})

test('PONOS_CACHE_OBS=1：出现 [cache] 行、形状正确、mock 无缓存字段 → unsupported', async () => {
  const r = await runTurn({ env: { PONOS_CACHE_OBS: '1' } })
  try {
    assert.ok(r.events.some((e) => e.type === 'result'), `夹具应正常收尾\nstderr=${r.err.slice(-400)}`)
    assert.ok(r.lines.length >= 2, `夹具含 1 次工具调用（2 迭代）应至少 2 行（实际 ${r.lines.length}）\nstderr=${r.err.slice(-500)}`)
    for (const line of r.lines) {
      const m = LINE_RE.exec(line)
      assert.ok(m, `行形状不符（字段缺失/改名/分隔符变化）：${line}`)
      assert.equal(m[8], 'unsupported', `mock 的 MOCK_USAGE 不含 cache 字段，必判 unsupported（不假警）：${line}`)
      assert.equal(m[3], '10', `in 应等于 mock 的 input_tokens=10：${line}`)
      assert.equal(m[4], '0', `read 应为 0：${line}`)
      assert.equal(m[7], '0.000', `hitRatio 应为 0.000：${line}`)
    }
    // req 序号连续递增，证明"每请求一条、不重不漏"
    const seqs = r.lines.map((l) => Number(LINE_RE.exec(l)[2]))
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `req 序号应连续 1..N（实际 ${JSON.stringify(seqs)}）`)
    // A-3（评审 Minor-5）配套：观测器**不得有第二个输出出口**。本夹具下内核既有的 stderr
    // 诊断是结构化 JSON 行（cli.mjs 的 "kernel start"），其余非 JSON 行必须全是 [cache] 行
    // ——若将来观测器另加一行自由文本诊断（无论叫什么名字），本断言在打开态即变红。
    // ★ 2026-10-09 并入集成树对账（四条线合并）：知识线另有**独立**的结构化 stderr 诊断
    //   `[el1] {...}`（cli.mjs S4.5④-3 观察期登记；为何走 stderr 见 cli.mjs 该处实测教训）
    //   ——与本观测器无关，故列入已知 tag 白名单。白名单外的一切非 JSON 行（含观测器未来
    //   另加的自由文本诊断）照旧变红 ⇒ 本断言"抓新出口"的能力不减。
    const KNOWN_STDERR_TAGS = ['[cache] ', '[el1] ']
    const plain = r.err.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('{'))
    for (const l of plain) assert.ok(KNOWN_STDERR_TAGS.some((t) => l.startsWith(t)), `观测器新增诊断的唯一合法出口是 [cache] 行：${l}`)
  } finally { r.cleanup() }
})

test('开关惰性读：settings.json 的 env.PONOS_CACHE_OBS=1 同样生效', async () => {
  // spawn env 里没有 PONOS_CACHE_OBS（spawnKernel 已 delete），只能靠 cli.mjs 的
  // settings.env 注入 → 若开关写成模块级常量，这里必红。
  const r = await runTurn({ settings: { env: { PONOS_CACHE_OBS: '1' } } })
  try {
    assert.ok(r.events.some((e) => e.type === 'result'), `夹具应正常收尾\nstderr=${r.err.slice(-400)}`)
    assert.ok(r.lines.length >= 2, `settings.json 通道应同样点亮观测（实际 ${r.lines.length} 行）\nstderr=${r.err.slice(-400)}`)
    for (const line of r.lines) assert.ok(LINE_RE.test(line), `行形状不符：${line}`)
  } finally { r.cleanup() }
})
