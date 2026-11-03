// 前缀缓存观测 · 三态端到端（2026-09-18 spec §9.1/§9.3）
// ---------------------------------------------------------------------------
// 为什么要改 mock：api.mjs 的 MOCK_USAGE 是**常量**且不含 cache 字段，端到端只能上演
// unsupported（Task 3 已覆盖）。要验证 ok / suspicious 必须让 usage 按请求序号变化。
// 为什么新开分支而不替换 58 处 `usage: MOCK_USAGE`：全替换改动面大、无收益，且新分支
// 只在显式设 env 时接管 ⇒ 零回归（不踩 mock 各分支的顺序陷阱）。
//
// 本文件锁四件事：
//   1) **序列按请求序号推进**（不是按轮、不是随机）——三态判定依赖确定性的相邻比较。
//   2) **ok → ok → suspicious**：第 3 请求请求面与第 2 请求相当（total 均 100000）且
//      read 从 90000 骤降到 0 ⇒ 必判 suspicious。这是 spec §5 判据 ④ 的端到端证明。
//   3) **hitRatio 口径**：90000/(10000+90000)=0.900。
//   4) **存在性信号必须随夹具一起到达判定层**（第 2 个用例，见下）。
//
// ★★ 驱动方式偏离简报（第 1 个用例），期望值一字未改 —— 必读：
//   简报原驱动是"3 个 user 轮、每轮 1 请求"，期望逐轮 ok/ok/suspicious。实测**不可达**，
//   原因是一处跨任务语义分歧（本任务第一手证据，详见 task-4-report.md）：
//     · 观测器 `cacheObs` 由 engine.mjs 的 `runTurnInternal` **每轮新建**
//       （`const cacheObs = createCacheObserver({...})` 在轮内），`prev` 基准不跨轮存活；
//     · 且 mock 无工具时**一轮恰好一个请求**（实测三行均为 `req=1`）；
//     · 于是每轮的首个请求恒走判据 ④ `first-supported` ⇒ 第 3 轮也判 ok，
//       逐轮驱动的实际落行是 `ok / ok / ok`（`req=1 / req=1 / req=1`）。
//   —— 而 spec §3.2 描述的是"观测器（状态机，**跨请求保持**）"、§6.1 示例里 `req` 跨轮
//      单调递增。二者矛盾 ⇒ 不在本任务范围内改 engine 作用域（那是 Task 3 的接线），
//      也不改期望值（会掩盖分歧）。故本用例改用**单轮工具循环**驱动（序列段加 `tool:1`，
//      api.mjs 的夹具分支对此 opt-in），把 3 次请求放进**同一轮** —— 三态本就在轮内可达，
//      断言断言值与简报逐字一致（[10000,90000,100000] × 2 → [100000,0,100000]、hit 0.900）。
//   跨轮语义本身由第 3 个用例固化成"现状锁"：**per-turn 即 spec §6.1 的 correctness**
//   （`req` 按轮重置），变红说明观测器被改成跨轮持有——那才是偏离 spec（见该用例注释）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
// 三段序列：稳定命中 → 稳定命中 → 请求面相当但 read 归零。前两段带 tool:1 ⇒ 引擎在同一轮里
// 连续发起 3 次请求（见上方"驱动方式偏离"）。
const SEQ = 'in:10000,read:90000,tool:1|in:10000,read:90000,tool:1|in:100000,read:0'
// 简报原始（无 tool）序列：用于第 3 个用例固化"一轮一请求"下的跨轮盲区。
const SEQ_CROSS_TURN = 'in:10000,read:90000|in:10000,read:90000|in:100000,read:0'
const TURNS = 3
// ★ v2 A5 权威版本（替换原「([a-z]+) 无锚点」版本）：cause 四值 + (?![\\s\\S]) 末尾锚点
const LINE_RE = new RegExp(
  '^\\[cache\\] turn=(\\d+) req=(\\d+) in=(\\d+) read=(\\d+) new=(\\d+) total=(\\d+)' +
  ' hit=(\\d+\\.\\d{3}) st=(ok|suspicious|compacted|unsupported)' +
  '(?: cause=(post-compaction|post-aged|history-rewrite|server-compact))?(?: drop=(\\d+))?(?![\\s\\S])',
)

function spawnKernel(env, dir) {
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: dir, YFW_HOME: dir, ...env },
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
  // 子进程先退出后写 stdin 会 EPIPE：无监听器即未捕获异常（本文件每轮写一条，不能踩）
  proc.stdin.on('error', () => { /* EPIPE 静默 */ })
  return { proc, events, get err() { return err } }
}

const waitFor = async (fn, ms = 30_000, step = 100) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return fn()
}

// 驱动一轮（发一条 user，等一个新增的 result）；result 计数递增防匹配到旧事件
const driveTurn = async (k, sessionId, content) => {
  const before = k.events.filter((e) => e.type === 'result').length
  k.proc.stdin.write(JSON.stringify({ type: 'user', session_id: sessionId, message: { role: 'user', content } }) + '\n')
  return waitFor(() => k.events.filter((e) => e.type === 'result').length > before)
}

const cacheLines = (err) => err.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[cache]'))

const parseLines = (k, min) => {
  const lines = cacheLines(k.err)
  assert.ok(lines.length >= min, `应至少 ${min} 行 [cache]（实际 ${lines.length}）\nstderr 尾部=${k.err.slice(-600)}`)
  return { lines, parsed: lines.map((l) => {
    const m = LINE_RE.exec(l)
    assert.ok(m, `行形状不符：${l}`)
    return { turn: Number(m[1]), req: Number(m[2]), in: Number(m[3]), read: Number(m[4]), total: Number(m[6]), hit: m[7], st: m[8] }
  }) }
}

test('三态端到端：ok → ok → suspicious（请求面相当 + read 骤降；单轮工具循环驱动 3 次请求）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-seq-'))
  const k = spawnKernel({ PONOS_CACHE_OBS: '1', PONOS_MOCK_CACHE_SEQ: SEQ }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800)) // 等 init
    // 单轮驱动：段 1/2 带 tool:1 ⇒ 引擎在同一轮里连续请求 3 次（见文件头"驱动方式偏离"）
    assert.ok(await driveTurn(k, 'cache-seq-session', '保持上下文：本夹具一轮内连发 3 次请求'), '本轮应在超时前产出 result')
    // 评审 Finding 2（跨管道竞态）：result 走 stdout、[cache] 行走 stderr，两条管道消费异步
    // ⇒ result 到达后立刻快照 stderr 存在 flake 窗口。本文件既有模式是等**事件/状态**（不改成
    // 等子进程退出），且 waitFor 的返回值必须纳入断言（超时退化成空等即失去意义）。
    assert.ok(await waitFor(() => cacheLines(k.err).length >= TURNS, 30_000),
      `stderr 应在超时前凑够 ${TURNS} 行 [cache]（实际 ${cacheLines(k.err).length}）`)
    const { lines, parsed } = parseLines(k, TURNS)
    assert.deepEqual(parsed.slice(0, 3).map((p) => [p.in, p.read, p.total]), [
      [10_000, 90_000, 100_000],
      [10_000, 90_000, 100_000],
      [100_000, 0, 100_000],
    ], `序列应按请求序号推进（实际 ${JSON.stringify(parsed.slice(0, 3))}）`)
    assert.equal(parsed[0].hit, '0.900', 'hitRatio = 90000/(10000+90000)')
    assert.equal(parsed[0].st, 'ok', `首个受支持请求无基准 → ok：${lines[0]}`)
    assert.equal(parsed[1].st, 'ok', `命中稳定 → ok：${lines[1]}`)
    assert.equal(parsed[2].st, 'suspicious', `请求面相当（100000 vs 100000）+ read 90000→0 → suspicious：${lines[2]}`)
    // 三行必须落在**同一轮**（这正是"驱动方式偏离"的可验证声明；per-turn 观测器的基准只在轮内）
    assert.deepEqual(parsed.slice(0, 3).map((p) => p.turn), [1, 1, 1], `三次请求应在同一轮内（实际 ${JSON.stringify(parsed.slice(0, 3).map((p) => p.turn))}）`)
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400)) // Windows：等句柄释放再删目录
    rmSync(dir, { recursive: true, force: true })
  }
})

// ★ 本用例超出简报（简报 Part A 只给了上面那个用例）：补锁"mock 序列分支自带
//   cache_fields_reported"这一**跨任务一致性**。理由：判据 ③（cache-fields-vanished）与
//   判据 ⑤（cache-drop）在 stderr 行上**都表现为 st=suspicious**（行格式不打印非
//   compacted 态的 reason，A5 正则也无此捕获组），故上面那个用例**无法**区分二者 ——
//   若有人把 cache_fields_reported 从 mock 分支删掉，上面用例仍全绿，语义却已退化。
//   本用例用"**字段齐备但 read 首轮即为 0**"这个只有存在性信号能分辨的形态把它钉死：
//     · 带存在性信号 → supported=true → ④ first-supported → **ok**
//     · 缺存在性信号 → 退化启发式 read+create=0 → supported=false → ① → **unsupported**
test('存在性信号：mock 序列自带 cache_fields_reported ⇒ read=0 的首轮判 ok（非 unsupported）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-seq-exist-'))
  const k = spawnKernel({ PONOS_CACHE_OBS: '1', PONOS_MOCK_CACHE_SEQ: 'in:100000,read:0' }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    assert.ok(await driveTurn(k, 'cache-seq-exist-session', '只跑一轮：确认端点上报了缓存字段'), '本轮应在超时前产出 result')
    // 同第 1 个用例的 Finding 2 修复：解析前先等 stderr 凑够期望行数（跨管道竞态）
    assert.ok(await waitFor(() => cacheLines(k.err).length >= 1, 30_000),
      `stderr 应在超时前凑够 1 行 [cache]（实际 ${cacheLines(k.err).length}）`)
    const { lines, parsed } = parseLines(k, 1)
    assert.equal(parsed[0].read, 0, `本夹具首轮 read 即为 0：${lines[0]}`)
    assert.equal(parsed[0].st, 'ok', `端点上报了缓存字段（存在性信号）⇒ 非 unsupported（退化启发式会判 unsupported）：${lines[0]}`)
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400))
    rmSync(dir, { recursive: true, force: true })
  }
})

// ★ 本用例是**现状锁：per-turn 观测器（spec §6.1 规定 `req` 按轮重置）**——控制器已裁定，
//   不再是"待裁定"的分歧，也不是"跨轮持有才是正解"。
//   裁定要点（逐条对齐 spec）：
//     · §6.1 示例即 `turn=3 req=7` / `turn=3 req=8 … cause=post-aged` / `turn=4 req=1`
//       ⇒ **`req` 按轮重置**。跨轮持有会让 `req` 跨轮单调递增，反而**违反** §6.1。
//     · `preStep`（含 `maybeCompact`/老化/裁剪）在**每次 API 请求前**运行（engine.mjs 迭代
//       循环内，`flushCacheObs()` → `preStep()` 的固定次序）⇒ 轮内相邻请求就是"改写前/改写后"，
//       `prev` 基准在轮内**充分**：归因需要的那次相邻比较（改写前请求 vs 改写后请求）本就在
//       同一轮里发生（见下方"归因接线"用例：轮内 epoch +1 → cause=post-aged）。
//   按轮即 **correctness**；改成跨轮持有才是**偏离 spec**。
//   本用例因此把该语义钉住：**若本用例变红（逐轮 st 不再全 ok、或 `req` 跨轮递增），说明有人
//   把观测器改成了跨轮持有（违反 §6.1），必须同步复查第 1 个用例的驱动与控制器裁定。**
test('现状锁：per-turn 观测器（spec §6.1 规定 req 按轮重置）⇒ 跨轮驱动下每轮首个请求恒 ok、req 每轮从 1 起', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-seq-turnscope-'))
  const k = spawnKernel({ PONOS_CACHE_OBS: '1', PONOS_MOCK_CACHE_SEQ: SEQ_CROSS_TURN }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    for (let i = 0; i < TURNS; i++) {
      assert.ok(await driveTurn(k, 'cache-seq-turnscope-session', `第 ${i + 1} 轮：保持上下文`), `第 ${i + 1} 轮应在超时前产出 result`)
    }
    // 评审 Finding 2（跨管道竞态）：解析前先等 stderr 凑够期望行数（同前两个用例）
    assert.ok(await waitFor(() => cacheLines(k.err).length >= TURNS, 30_000),
      `stderr 应在超时前凑够 ${TURNS} 行 [cache]（实际 ${cacheLines(k.err).length}）`)
    const { lines, parsed } = parseLines(k, TURNS)
    const first = parsed.slice(0, TURNS)
    // 请求面确实按序列推进（夹具能力自证：跨轮也能看到 10000/90000 → 100000/0）
    assert.deepEqual(first.map((p) => [p.in, p.read]), [[10_000, 90_000], [10_000, 90_000], [100_000, 0]],
      `序列按请求序号跨轮推进（实际 ${JSON.stringify(first.map((p) => [p.in, p.read]))}）`)
    assert.deepEqual(first.map((p) => p.req), [1, 1, 1], `req 每轮从 1 起——spec §6.1 规定 req 按轮重置（示例 turn=3 req=7 / turn=4 req=1）；跨轮递增才是偏航：${JSON.stringify(first.map((p) => p.req))}`)
    assert.deepEqual(first.map((p) => p.st), ['ok', 'ok', 'ok'],
      `每轮首个请求轮内无前序 ⇒ 恒 ok（④ first-supported）；第 3 轮 read 90000→0 在轮内没有可比基准，按轮比较是 spec §6.1 的正确语义：${JSON.stringify(first.map((p) => p.st))}\nstderr 尾部=${k.err.slice(-400)}`)
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400))
    rmSync(dir, { recursive: true, force: true })
  }
})

// ★ 归因接线的**可证伪**覆盖（评审 Finding 5，按控制器对 F3 的既定立场提级为必修）：
//   根因修复必须自带能变红的覆盖，否则未来重构把 `cacheObs.noteShrink()` 从 engine 拿掉会
//   **静默回退**（全仓此前无一断言证明"engine 真的调了它"，删掉两处调用点全套件仍绿）。
//   为什么必须端到端、不能只在 cache-observer.mjs 层单测：标签**只在 epoch 变化时才被采用**
//   （observe 里 `rewritten` 分支），"epoch 何时变"由 engine 的 preStep 次序决定；观测器层单测
//   能证明"标签 + epoch 变化 ⇒ cause=post-aged"，但**证不了 engine 真调了 noteShrink**（删掉
//   调用点后那层单测照样全绿）。
//   为什么不做 (b) 注入路径：`createCacheObserver` 在 engine.mjs 的 runTurnInternal 里**直接**
//   以 env 数值构造（无 opts/参数注入点，全仓亦无测试替身注入惯例），注入需要改产品代码
//   ⇒ 按简报要求走端到端 (a)。
//   构造（两条 env，不动产品代码）：一轮内连发 3 次请求（段 1/2 带 tool:1），并在 preStep 的
//   免费收缩里让**裁剪必然发生**——
//     · PONOS_TOOL_RESULT_BUDGET_BYTES=8：任一条工具结果都超预算 ⇒ pruneToolResult 真截断
//       ⇒ compact.mjs 的 `bumpContentEpoch()` 被调用（全仓仅两处原地改写点，这是其一）；
//     · PONOS_COMPACT_MAX_MESSAGES=1：走**条数触发口**进压缩链路，而 token 远未过线 ⇒ 只做
//       零模型成本的收缩、**不付摘要调用**（故不会串成 cause=post-compaction，与本用例无关）。
//   时序（engine.mjs：迭代头 flushCacheObs() → preStep() → 请求）：
//     req1 preStep 无工具结果（action=none，epoch 不动）→ req1 结算（lastEpoch=0）
//     → req2 preStep 裁剪 req1 的工具结果（epoch 0→1）→ noteShrink() → req2 结算：
//       rewritten=true ⇒ cause = hint = **post-aged**（而非退化的 history-rewrite）。
//   红/绿自证：注释掉 engine.mjs 的 `cacheObs.noteShrink()`，第 2 行 cause 立刻退化为
//   history-rewrite ⇒ 本用例**变红**；恢复即绿（实际输出见 task-45-fix-report.md）。
const SEQ_SHRINK = 'in:10000,read:90000,tool:1|in:10000,read:90000,tool:1|in:10000,read:90000'
// cause 是个可选后缀（A5 行格式），主 LINE_RE 不捕获；只读断言用这条轻量提取
const causeOf = (line) => (/\bcause=([a-z][a-z-]*)/.exec(line) || [])[1] ?? null

test('归因接线：轮内收缩（epoch +1）后紧随请求 cause=post-aged（删掉 noteShrink 必红）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-seq-note-'))
  const k = spawnKernel({
    PONOS_CACHE_OBS: '1',
    PONOS_MOCK_CACHE_SEQ: SEQ_SHRINK,
    PONOS_COMPACT_MAX_MESSAGES: '1',
    PONOS_TOOL_RESULT_BUDGET_BYTES: '8',
  }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    assert.ok(await driveTurn(k, 'cache-seq-note-session', '一轮内先结算一次，再让 preStep 发生收缩'), '本轮应在超时前产出 result')
    assert.ok(await waitFor(() => cacheLines(k.err).length >= 2, 30_000),
      `stderr 应在超时前凑够 2 行 [cache]（实际 ${cacheLines(k.err).length}）`)
    const { lines, parsed } = parseLines(k, 2)
    assert.equal(parsed[0].st, 'ok', `req1 尚无改写、亦无基准 → ok：${lines[0]}`)
    assert.equal(causeOf(lines[0]), null, `req1 不该带 cause（改写发生在其后）：${lines[0]}`)
    assert.equal(parsed[1].st, 'compacted', `req2 前已 bump epoch ⇒ 预期性失效（不是 suspicious）：${lines[1]}`)
    assert.equal(causeOf(lines[1]), 'post-aged',
      `标签必须来自 engine 的 noteShrink() 调用点；退化为 history-rewrite 即调用点丢失：${lines[1]}\nstderr 尾部=${k.err.slice(-600)}`)
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400))
    rmSync(dir, { recursive: true, force: true })
  }
})

// ★ 夹具增强（2026-09-18 Task 6 D-1）：让 `[compact] action=aged` **确定性可触发**。
// 为什么必须补：老化归因（`cause=post-aged`，H1 的判据）要求压缩链路真的走到
//   `ageOutToolResults`，而它的两道门（`est.total ≥ threshold` 与
//   `est.total ≥ floor(window × PONOS_TOOL_RESULT_CLEAR_RATIO)``，compact.mjs:1003/1011）
//   原夹具永远够不着——旧 tool 轮只 `echo cache-seq-N`（几十字节）。夹具新增 `big:<字符数>`
//   键（api.mjs，opt-in，不改既有 58 处 MOCK_USAGE 与既有键默认行为）：本段改为 Read 一个
//   **指定体量**的真实文件，Read 结果①豁免落盘替换（大内容真留在上下文里）②属
//   REPLAYABLE_TOOLS（**可被老化清除**）。
// 数值标定（本机实测；env 全部在测试内显式设置，不依赖用户环境）：
//   window=20000（PONOS_AUTO_COMPACT_WINDOW 注入 + 未命中模型表的 PONOS_MODEL）、
//   输出预算 4096 ⇒ `resolveThreshold` 的 budgeted = 20000−4096−4096 = **11808**、
//   clearRatio 默认 0.5 ⇒ 老化门 = **10000**。big:14000 的 Read 结果约 5.3K token
//   （ASCII，每行 100 字符）⇒ 三条结果时 est≈13343 ≥ 两道门，清掉最老一条后
//   est1≈9000 < 11808 ⇒ `action=aged`（且 est 未过 threshold，**不付摘要调用**——
//   故 `PONOS_COMPACT_MAX_MESSAGES=1` 的条数触发口不会串出 summarized）。
//   keepRecent 默认 2 ⇒ 需要 **≥3 条**可重放结果才有可清项（这是本用例第三条 big 段的存在理由）。
// PONOS_TOOL_RESULT_BUDGET_BYTES=200000：把结构裁剪（pruned）按下去，让本用例只测老化这一条路径。
const BIG = 14000
const SEQ_AGED = Array.from({ length: 3 }, () => `in:10000,read:90000,big:${BIG}`).join('|') + '|in:10000,read:90000'

test('夹具增强：big:<字符数> 让 [compact] action=aged 确定性触发，紧随请求 cause=post-aged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-seq-big-'))
  const k = spawnKernel({
    PONOS_CACHE_OBS: '1',
    PONOS_MOCK_CACHE_SEQ: SEQ_AGED,
    PONOS_MODEL: 'mock-cache-seq', // 未命中 MODEL_CONTEXT_WINDOWS ⇒ PONOS_AUTO_COMPACT_WINDOW 生效
    PONOS_AUTO_COMPACT_WINDOW: '32000',
    PONOS_MAX_OUTPUT_TOKENS: '4096',
    // ★ 2026-10-19 适配（compact.mjs 的"两维度分别解决才报 aged"修复）：
    //   本条原是 `'1'`（条数门恒命中，借它进压缩链路）。但修好那个洞之后，
    //   **条数门始终命中就不可能是 aged** —— 清理只改内容、不删消息，条数维度结构上解决不了，
    //   报 aged 等于撒谎（那正是用户实测"日志显示一直在收缩、实际涨到 2500 条"的成因）。
    //   ⇒ 改用**纯 token 触发**；条数门放到 999（不命中）⇒ 两个维度都满足 ⇒ aged 照旧确定性触发。
    // ★ 2026-10-26 二次适配（`estimateRequest` 开始计入**工具面**）：
    //   窗口从 20000 调到 32000。原因不是"调松阈值"，而是旧夹具依赖了一个 bug ——
    //   旧口径漏算工具面（本仓静态工具约 8,974 token），于是 20000 窗口下
    //   `messages(≈17.1K) + tools(9.0K) = 26.1K > 20K 窗口`，请求**本身就装不下**，
    //   只因估算看不见 tools 才"看起来能收口"。修复后必须给前缀留出真实空间：
    //   窗口 32000 ⇒ 阈值 min(0.8×32000, 32000−4096−4096) = **23,808**；
    //   est≈26,061 越过它 ⇒ 进链路；老化后 est≈22,974 < 23,808 ⇒ 收口报 aged。
    PONOS_COMPACT_MAX_MESSAGES: '999',
    PONOS_TOOL_RESULT_BUDGET_BYTES: '200000',
  }, dir)
  try {
    await new Promise((r) => setTimeout(r, 900))
    assert.ok(await driveTurn(k, 'cache-seq-big-session', '一轮内造出可老化的历史'), '本轮应在超时前产出 result')
    assert.ok(await waitFor(() => cacheLines(k.err).length >= 4, 60_000),
      `stderr 应在超时前凑够 4 行 [cache]（实际 ${cacheLines(k.err).length}）\nstderr 尾部=${k.err.slice(-600)}`)
    // ① 老化真的发生（本增强的存在理由：改动前这一步不可达）
    const aged = k.err.split('\n').map((l) => l.trim()).filter((l) => l.includes('[compact] action=aged'))
    assert.ok(aged.length >= 1, `应出现 [compact] action=aged（夹具未造出老化）\nstderr 尾部=${k.err.slice(-1200)}`)
    const cleared = Number(/tool-results-aged-(\d+)/.exec(aged[0])?.[1] || 0)
    assert.ok(cleared >= 1, `aged 的 reason 应带清除条数（>0）：${aged[0]}`)
    // ② 老化（原地改写 ⇒ epoch+1）之后的首个请求必须判预期性失效并被命名（H1 的端到端判据）
    const { lines, parsed } = parseLines(k, 4)
    const hit = lines.map((l, i) => [l, parsed[i]]).find(([, p]) => p.st === 'compacted')
    assert.ok(hit, `老化后应有 st=compacted 行：${JSON.stringify(parsed.map((p) => [p.req, p.st, p.read]))}`)
    assert.equal(causeOf(hit[0]), 'post-aged', `老化后首个请求应命名 post-aged：${hit[0]}`)
    // ③ 夹具自证：大体积真的进了请求面（est 量级），否则上面两条只是"碰巧"
    // ★ 2026-10-19：取样从"第一条带 est 的行"改为"**所有 [compact] 行里的最大 est**"。
    //   原因：同一轮里会出现 `reason=no-cut-point ... est=-` 这样**没有实测估值**的行
    //   （它压根没算 est），若取"第一条含 est= 的行"，拿到的可能是那个 `-` ⇒ 解析成 0 ⇒ 假红。
    //   取最大值与本题原意（"big 确实把请求面抬到 5000+ 量级"）完全一致，且不依赖行序。
    const ests = k.err.split('\n').map((l) => l.trim())
      .filter((l) => l.includes('[compact]'))
      .map((l) => Number(/est=(\d+)/.exec(l)?.[1] || 0))
    const bigEst = ests.length ? Math.max(...ests) : 0
    assert.ok(bigEst > 5000, `big:${BIG} 的 Read 结果应把 est 抬到 5000 token 以上（实际 ${bigEst}，各行 est=${JSON.stringify(ests)}）`)
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400))
    rmSync(dir, { recursive: true, force: true })
  }
})

// ★ 裁定 C 的端到端（C-4）：**纯 summary 压缩**（epoch 不变）在 engine 真链路上被识别为
//   `st=compacted cause=post-compaction`——即 C-1 修的能力不是"只有单测里的能力"。
//   为什么必须端到端：判据的**信号源**在 engine 侧（`session.compactCount()` 是否真被传进
//   `observe`）；观测器层单测能证明"summaryGen 变化 ⇒ post-compaction"，但证不了接线——删掉
//   `summaryGen: session ? session.compactCount() : null` 这半句，本用例立刻变红（全仓此前无一
//   断言证明它），而 cache-observer.test.mjs 的 C-1 仍全绿。
//   构造（三条 env + 两轮驱动，不动产品代码）：
//     · 大历史：`big:14000` ×3（见上一个用例的标定）把 est 抬到阈值之上；
//       ★ 2026-10-26：窗口随上一个用例一并从 20000 调到 32000（阈值 23,808）——
//       旧 20000 窗口下 `messages + tools` 已超窗口本身（见上一个用例的长注），
//       修复"估算计入工具面"之后必须给前缀留真实空间。
//     · `PONOS_TOOL_RESULT_KEEP_RECENT=99`：让老化清除**不产生**（cleared=0）⇒ 不早退 aged，
//       落到**摘要**分支（ageOutToolResults 不再挡在摘要前面）；`PONOS_TOOL_RESULT_BUDGET_BYTES=200000`
//       同理把结构裁剪按下去；
//     · 摘要需要真实切点（`findCutPoint` 要求保留起点是**真实 user 消息**）⇒ 必须**两轮**：
//       一轮全在同一 turn 内时切点恒为 null（`no-cut-point`，本机实测），第二轮起才有 turn 边界。
//   时序（engine.mjs：迭代头 flushCacheObs() → preStep() → 请求，且 mock 的"摘要请求"也消耗一段）：
//     turn2 req2 的 preStep 落到 `action=summarized` ⇒ `appendCompactionSummary` 落地
//     ⇒ `compactCount++`（**epoch 不动**）⇒ 该请求结算在下一迭代头 ⇒ `summaryAdvanced` 命中。
//   红/绿自证（实际输出见 task-C-report.md）：把 observe 的 `summaryGen` 断言中和（传 null）后
//     本用例变红（该行退化为 ok）；恢复即绿。
//   段位说明：8 段 = 3 big(turn1) + 1 plain(turn1 收尾) + 1 big(turn2 req1) + 1 plain(被摘要调用
//     吃掉，其文本即摘要正文) + 1 big(turn2 req2) + 1 plain(turn2 收尾)。
const SEQ_SUMMARY = 'in:10000,read:90000,big:14000|in:10000,read:90000,big:14000|in:10000,read:90000,big:14000|in:10000,read:90000' +
  '|in:10000,read:90000,big:14000|in:10000,read:90000|in:10000,read:90000,big:14000|in:10000,read:90000'

test('裁定C端到端：摘要落地（compactCount+1、epoch 不变）后首个请求 cause=post-compaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-seq-sum-'))
  const k = spawnKernel({
    PONOS_CACHE_OBS: '1',
    PONOS_MOCK_CACHE_SEQ: SEQ_SUMMARY,
    PONOS_MODEL: 'mock-cache-seq',
    PONOS_AUTO_COMPACT_WINDOW: '32000',
    PONOS_MAX_OUTPUT_TOKENS: '4096',
    PONOS_TOOL_RESULT_KEEP_RECENT: '99', // 压制老化清除 ⇒ 走摘要分支
    PONOS_TOOL_RESULT_BUDGET_BYTES: '200000', // 压制结构裁剪
  }, dir)
  try {
    await new Promise((r) => setTimeout(r, 900))
    assert.ok(await driveTurn(k, 'cache-seq-sum-session', '第一轮：造出大历史（进摘要阈值）'), '第 1 轮应在超时前产出 result')
    assert.ok(await driveTurn(k, 'cache-seq-sum-session', '第二轮：提供真实 turn 边界供切点使用'), '第 2 轮应在超时前产出 result')
    assert.ok(await waitFor(() => /\[compact\] action=summarized/.test(k.err), 60_000),
      `应出现 [compact] action=summarized（摘要落地）\nstderr 尾部=${k.err.slice(-1200)}`)
    assert.ok(await waitFor(() => k.err.includes('cause=post-compaction'), 60_000),
      `摘要落地后应出现 cause=post-compaction\nstderr 尾部=${k.err.slice(-1200)}`)
    const lines = cacheLines(k.err)
    const i = lines.findIndex((l) => l.includes('cause=post-compaction'))
    assert.ok(i >= 0, `应有一行带 cause=post-compaction：${JSON.stringify(lines)}`)
    const parsed = LINE_RE.exec(lines[i])
    assert.ok(parsed, `行形状不符：${lines[i]}`)
    assert.equal(parsed[8], 'compacted', `摘要落地 ⇒ 预期性失效（不是 suspicious）：${lines[i]}`)
    // 前置条件自证：本用例里**没有**任何 aged/pruned（epoch 未变的纯 summary 压缩成立）
    assert.ok(!/\[compact\] action=(aged|pruned)/.test(k.err),
      `本用例应只有 summary 一种压缩动作（否则 epoch 也变了，测不到独立信号）\nstderr 尾部=${k.err.slice(-1200)}`)
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400))
    rmSync(dir, { recursive: true, force: true })
  }
})
