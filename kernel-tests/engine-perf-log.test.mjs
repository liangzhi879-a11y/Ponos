// K0 观测基线契约（2026-09-13「任务运行慢·系统性优化」Task 1）
// ---------------------------------------------------------------------------
// 背景：内核此前 `performance.now()` / `[perf]` / `hrtime` **零命中**——「每步 420–680ms
// 固定开销」只能靠外部探针估，无法在真实任务里定位到"这一步到底付在哪」。K1 的每一项
// 改动都要求前后有数据背书，故先把这一层钉死。
//
// 本文件锁四件事：
//   1) **默认关**：不设 PONOS_PERF 时 stderr 零 `[perf]`，且轮次照常收尾（埋点必须是惰性的）。
//      内核 stderr 经桥会 ① console.error 转发 ② 写 <home>/logs/kernel-stderr.log
//      ③ 作为 stderr 事件转发渲染器——每步一行是真实成本（kernel-stderr.log 已 2.16MB）。
//   2) **行数 = 步数**：step 号连续 0..N-1、不重不漏。emit 放**迭代头**是为了一处覆盖
//      十余处 `continue` 出口（967/1345/1362/1382/1405/1414/1422/1433/1448…），
//      这条断言就是那个设计的回归护栏。
//   3) **字段齐全且形状正确**：pre/req/est/tools 为 `次数/毫秒`，ttfb/gen/tail 为毫秒。
//   4) **开关惰性读**：走 settings.json 的 `env` 通道同样生效。`cli.mjs` 的
//      `settings.env` 注入发生在**所有 ESM 模块求值之后**，写成模块级常量必然读不到
//      （同一个坑 engine-adaptive-firstbyte.test.mjs 头注已记录）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

// 夹具：`[mock:tool-safe]` → iter0 出 Bash tool_use（echo，非高危，无需审批）→ 工具执行
// → iter1 回填 tool_result 收尾。恰 2 迭代/轮 = 恰 2 行 `[perf]`（step=0、step=1）。
const FIXTURE = '[mock:tool-safe] 跑一次安全命令'

// 单行形状：[perf] turn=1 step=0 ms=123 pre=1/12.3 req=5/3.9 est=2/4.1 tools=6/131.4 dynHit=0 ttfb=284 gen=612 tail=41
const LINE_RE = new RegExp(
  '^\\[perf\\] turn=(\\d+) step=(\\d+) ms=(\\d+|-)' +
  ' pre=(\\d+)/(\\d+(?:\\.\\d+)?) req=(\\d+)/(\\d+(?:\\.\\d+)?)' +
  ' est=(\\d+)/(\\d+(?:\\.\\d+)?) tools=(\\d+)/(\\d+(?:\\.\\d+)?)' +
  ' dynHit=(\\d+) ttfb=(\\d+(?:\\.\\d+)?) gen=(\\d+(?:\\.\\d+)?) tail=(\\d+(?:\\.\\d+)?)$',
)

function spawnKernel(env, dir) {
  // PONOS_PERF 必须**不在**子进程 env 里（否则测不出默认关与 settings 通道）
  const base = { ...process.env }
  delete base.PONOS_PERF
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], {
    env: { ...base, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: dir, YFW_HOME: dir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const events = [] // 按 NDJSON 行解析（数据块可能把一行切成两半，不能用 includes）
  let buf = ''
  proc.stdout.on('data', (d) => {
    out += d
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行/脏行跳过 */ }
    }
  })
  proc.stderr.on('data', (d) => err += d)
  return { proc, events, get out() { return out }, get err() { return err } }
}

const waitFor = async (fn, ms = 20_000, step = 100) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return fn()
}

const perfLines = (err) => err.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[perf]'))

/** 起内核 → 跑一轮夹具 → 收集 stderr 里的 [perf] 行 */
async function runTurn({ env = {}, settings = null, timeoutMs = 20_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-log-'))
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8')
  const k = spawnKernel(env, dir)
  try {
    await new Promise((r) => setTimeout(r, 800)) // 等 init
    k.proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'perf-session', message: { role: 'user', content: FIXTURE } }) + '\n')
    await waitFor(() => k.events.some((e) => e.type === 'result') || k.proc.exitCode !== null, timeoutMs)
    return {
      dir,
      events: k.events,
      err: k.err,
      out: k.out,
      lines: perfLines(k.err),
      cleanup() {
        try { k.proc.kill() } catch { /* 已退出 */ }
        rmSync(dir, { recursive: true, force: true })
      },
    }
  } catch (e) {
    try { k.proc.kill() } catch { /* 已退出 */ }
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

test('默认关：不设 PONOS_PERF → stderr 零 [perf]，轮次照常收尾', async () => {
  const r = await runTurn()
  try {
    assert.ok(r.events.some((e) => e.type === 'result'), `夹具应正常收尾（埋点必须惰性）\nstderr=${r.err.slice(-400)}`)
    assert.deepEqual(r.lines, [], `默认必须零输出（内核 stderr 会落盘 + 转发渲染器）\n实际=${JSON.stringify(r.lines)}`)
  } finally { r.cleanup() }
})

test('PONOS_PERF=1：行数 = 步数、step 连续、字段齐全', async () => {
  const r = await runTurn({ env: { PONOS_PERF: '1' } })
  try {
    assert.ok(r.events.some((e) => e.type === 'result'), `夹具应正常收尾\nstderr=${r.err.slice(-400)}`)
    assert.ok(r.lines.length >= 2, `含 1 次工具调用的轮至少有 2 步（实际 ${r.lines.length}）\n${r.lines.join('\n')}`)

    const steps = []
    let rebuilds = 0
    for (const line of r.lines) {
      const m = LINE_RE.exec(line)
      assert.ok(m, `行形状不符（字段缺失/改名/分隔符变化）：${line}`)
      const [, turn, step, , preN, , reqN, , estN, , toolsN] = m
      const dynHitN = Number(m[12])
      assert.equal(turn, '1', `单轮用例 turn 应为 1：${line}`)
      steps.push(Number(step))
      // 每步都应真实走到这三条路径（est 是 K1.1 的主指标，req 是 K1.4、tools 是 K1.2）：
      // 次数掉到 0 说明调用点被删/被包错层，是 K1 的回归信号。
      assert.ok(Number(preN) >= 1, `pre 次数应 ≥1：${line}`)
      assert.ok(Number(reqN) >= 1, `req 次数应 ≥1：${line}`)
      assert.ok(Number(estN) >= 1, `est 次数应 ≥1：${line}`)
      assert.ok(Number(toolsN) >= 1, `tools 次数应 ≥1：${line}`)
      assert.ok(dynHitN <= Number(toolsN), `命中数不可能超过求值次数：${line}`)
      // 每个非命中的求值 = 一次工具表构建（K1.2 前是 22.2ms/次 × 6 次/步）
      rebuilds += Number(toolsN) - dynHitN
    }
    // K1.2 端到端护栏：缓存真的在服务请求（被静默关掉 / 键一直在变 → 这里的构建数会飙升）。
    // 上界 2 = 首轮"签名补上文件集"的固有代价（未开帐时点，见 dyntools.toolSourceSignature）；
    // 稳态下每步都该是 0 次构建。不设缓存时这个数 ≈ 步数 × 6。
    assert.ok(rebuilds <= 2, `稳定盘面整轮至多 2 次构建（实际 ${rebuilds}）：\n${r.lines.join('\n')}`)
    // 不重不漏：emit 在迭代头 + 轮末补最后一步 ⇒ 恰 0..N-1
    assert.deepEqual(steps, steps.map((_, i) => i), `step 号应连续 0..N-1（实际 ${JSON.stringify(steps)}）\n${r.lines.join('\n')}`)
  } finally { r.cleanup() }
})

test('开关惰性读：settings.json 的 env.PONOS_PERF=1 同样生效', async () => {
  // spawn env 里没有 PONOS_PERF（spawnKernel 已 delete），只能靠 cli.mjs 的
  // settings.env 注入 → 若 perf.mjs 把开关写成模块级常量，这里必红。
  const r = await runTurn({ settings: { env: { PONOS_PERF: '1' } } })
  try {
    assert.ok(r.events.some((e) => e.type === 'result'), `夹具应正常收尾\nstderr=${r.err.slice(-400)}`)
    assert.ok(r.lines.length >= 2, `settings.json 通道应同样点亮观测（实际 ${r.lines.length} 行）\nstderr=${r.err.slice(-400)}`)
    for (const line of r.lines) assert.ok(LINE_RE.test(line), `行形状不符：${line}`)
  } finally { r.cleanup() }
})
