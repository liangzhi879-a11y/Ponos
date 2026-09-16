// P1-7 最小基准门禁（2026-09-16）
// ---------------------------------------------------------------------------
// 来源：docs/2026-09-15-五引擎架构性能对比分析.md §5 P1-7 —— 「ponos 已能用『合成
// 2.5MB / 1,482 条历史』夹具定位热点（context.mjs 相关），把它固化为 kernel-tests
// 里的耗时断言即可（**无需引入基准框架**）」。本文件即该固化，不依赖任何基准库。
//
// 为什么不是重复劳动（旧断言的假绿缺口）：
//   `context-cache.test.mjs` 已有「2.5MB 连调 3 次 < 200ms」。实测该红线**分辨不出**
//   「优化生效」与「缓存根本没生效」——
//     缓存在生效：3 次 ≈ 0.8ms   → 绿（远低于 200ms）
//     缓存被关掉：3 次 ≈ 23.4ms  → **仍然绿**（同样低于 200ms）
//   两者相差 80 倍却给出同一结论。这正是 perf plan Task 11 记下的教训：缓存的"开/关"
//   在绝对毫秒上都"够快"，只有**相对比值**能区分。故本文件的主断言一律是相对量
//   （不受机器速度影响），绝对上限只用于拦"数量级劣化"且留 ≥7x 余量（抗 CI 抖动）。
//
// 覆盖范围：旧断言只锁 estimateRequest；本文件补齐**压缩前置链**其余热点
// （findCutPoint / splitCoveredIntoChunks / extractKeyInfo / assembleSummaryRequest），
// 它们同样每步/每次压缩都跑，此前**无任何耗时门禁**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateRequest, estimateHistory, estimateMessage } from '../kernel/context.mjs'
import { findCutPoint, splitCoveredIntoChunks, extractKeyInfo, assembleSummaryRequest } from '../kernel/compact.mjs'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const turnStart = (s) => ({ role: 'user', content: [{ type: 'text', text: s }] })
const assistantText = (s) => ({ role: 'assistant', content: [{ type: 'text', text: s }] })
const assistantTool = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: 'x' } }] })
const toolResult = (id, text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] })

/**
 * 合成大历史，形状贴近真实（**这是能否复现真热点的前提**）：
 * 每 turn = user 文本起点 + assistant tool_use + user tool_result + assistant 文本。
 *
 * ⚠️ 必须含**真实 turn 起点**（role==='user' 且无 tool_result）：否则 findCutPoint 的
 * `while (start > 0 && !isTurnStart(m)) start--` 会一路退到 0 → 返回 null → 后续断言
 * 全部拿不到数据（首版探针即踩此坑，"绿"得毫无意义）。
 *
 * 默认 turns=370 → 1480 条 / ≈1366KB（与文档所述 1,482 条同量级）。
 */
function makeBigHistory({ turns = 370, chunk = 1700 } = {}) {
  const filler = 'x'.repeat(chunk)
  const msgs = []
  for (let i = 0; i < turns; i++) {
    msgs.push(turnStart(`第 ${i} 轮任务：请处理 src/lib/mod${i}.ts`))
    msgs.push(assistantTool(`tu_${i}`, 'Read'))
    msgs.push(toolResult(`tu_${i}`, `结果 ${i} ${filler}`))
    msgs.push(assistantText(`第 ${i} 轮结论 ${filler}`))
  }
  return msgs
}

/** 中位数（抗抖动）：跑 runs 次取中间值 */
function median(fn, runs = 5) {
  const xs = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    fn()
    xs.push(performance.now() - t)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

const bytesOf = (msgs) => Buffer.byteLength(JSON.stringify(msgs), 'utf8')
const MB = 1024 * 1024

// 共享夹具：内容相同的**同一批对象**（真实历史就是这样被反复估算的，缓存也靠对象身份）
const HISTORY = makeBigHistory()
const CUT = findCutPoint({ messages: HISTORY, retainTokens: 32_000, estimateMessage })

// ---------------------------------------------------------------------------
// ① 规模守卫：防「夹具被改小 → 断言空跑变绿」
// ---------------------------------------------------------------------------
test('规模守卫：夹具必须够大（否则下面的耗时断言是空跑）', () => {
  assert.ok(HISTORY.length >= 1450, `夹具消息数应 ≥1450（实际 ${HISTORY.length}）`)
  assert.ok(bytesOf(HISTORY) >= 1.2 * MB, `夹具应 ≥1.2MB（实际 ${(bytesOf(HISTORY) / MB).toFixed(2)}MB）`)
  const total = estimateRequest({ system: 'sys', messages: HISTORY }).total
  assert.ok(total >= 350_000, `夹具 token 量应 ≥350k（实际 ${total}）`)
  // findCutPoint 必须真的切出遮蔽区间 —— 否则压缩链断言全部空跑（见本文件头注的坑）
  assert.ok(CUT && Array.isArray(CUT.covered), '夹具必须能被切出 covered 区间（含真实 turn 起点）')
  assert.ok(CUT.covered.length >= 1000, `covered 应具规模（实际 ${CUT.covered?.length}）`)
})

// ---------------------------------------------------------------------------
// ② 缓存生效（相对断言 —— 主断言，不受机器速度影响）
// ---------------------------------------------------------------------------
test('缓存生效：warm 中位数 ≤ cold 中位数 / 10（旧红线抓不到的那件事）', () => {
  // cold 必须用**全新**夹具对象：缓存是 WeakMap 以对象为键，同一批对象第二次就是 warm
  const cold = median(() => estimateRequest({ system: 'sys', messages: makeBigHistory() }), 3)
  const warm = median(() => estimateRequest({ system: 'sys', messages: HISTORY }))
  assert.ok(
    warm <= cold / 10,
    `warm 应显著快于 cold（cold ${cold.toFixed(1)}ms → warm ${warm.toFixed(2)}ms，`
    + `比值 ${(cold / warm).toFixed(1)}x；若接近 1 说明估算缓存失效/未接线）`,
  )
})

test('缓存开/关比值：关掉缓存后 ≥5x 慢（钉住"缓存被静默关掉"）', () => {
  const on = median(() => estimateRequest({ system: 'sys', messages: HISTORY }), 3)
  let off
  process.env.PONOS_ESTIMATE_CACHE = '0'
  try {
    off = median(() => estimateRequest({ system: 'sys', messages: HISTORY }), 3)
  } finally {
    delete process.env.PONOS_ESTIMATE_CACHE // 必须清理：同进程其他用例不得受影响
  }
  assert.ok(
    off >= on * 5,
    `关缓存后应明显变慢（on ${on.toFixed(2)}ms → off ${off.toFixed(1)}ms，比值 ${(off / on).toFixed(1)}x）——`
    + '若比值≈1 说明缓存在默认路径上已失效（PONOS_ESTIMATE_CACHE 的判据被改坏）',
  )
  // 恢复后必须回到开缓存的速度（证明清理干净、且默认就是开）
  const back = median(() => estimateRequest({ system: 'sys', messages: HISTORY }), 3)
  assert.ok(back <= off / 5, `清理 env 后应恢复缓存（off ${off.toFixed(1)}ms → back ${back.toFixed(2)}ms）`)
})

// ---------------------------------------------------------------------------
// ③ 每步固定开销（绝对上限，留 ≥7x 余量 —— 只拦数量级劣化）
// ---------------------------------------------------------------------------
test('每步固定开销：6× warm 估算 < 60ms（真实每步调 3–6 次）', () => {
  const t = performance.now()
  for (let i = 0; i < 6; i++) estimateRequest({ system: 'sys', messages: HISTORY })
  const ms = performance.now() - t
  // 实测 ~1.7ms；未记忆化时单次即 ~20ms（6 次 ~120ms）
  assert.ok(ms < 60, `6 次 warm 估算应 <60ms（实际 ${ms.toFixed(2)}ms，单次 ${(ms / 6).toFixed(3)}ms）`)
})

test('冷启动：单次 cold 估算 < 150ms（含首次全量扫描）', () => {
  const ms = median(() => estimateRequest({ system: 'sys', messages: makeBigHistory() }), 3)
  assert.ok(ms < 150, `单次 cold 估算应 <150ms（实际 ${ms.toFixed(1)}ms）`)
})

// ---------------------------------------------------------------------------
// ④ 压缩前置链热点（此前无任何耗时门禁）
// ---------------------------------------------------------------------------
test('压缩前置：findCutPoint < 30ms（每次压缩都要算）', () => {
  const ms = median(() => findCutPoint({ messages: HISTORY, retainTokens: 32_000, estimateMessage }))
  assert.ok(ms < 30, `findCutPoint 应 <30ms（实际 ${ms.toFixed(2)}ms）`)
})

test('压缩前置：splitCoveredIntoChunks < 80ms（分块路径最重的确定性步骤）', () => {
  const ms = median(() => splitCoveredIntoChunks({ covered: CUT.covered, chunkBudget: 20_500, estimateMessage }))
  assert.ok(ms < 80, `splitCoveredIntoChunks 应 <80ms（实际 ${ms.toFixed(2)}ms）`)
  // 附带契约：块并集 = covered（防"为了快而漏块"）
  const chunks = splitCoveredIntoChunks({ covered: CUT.covered, chunkBudget: 20_500, estimateMessage })
  assert.equal(chunks.reduce((s, c) => s + c.length, 0), CUT.covered.length, '块并集必须等于 covered')
})

test('压缩前置：extractKeyInfo < 30ms、assembleSummaryRequest < 30ms', () => {
  const k = median(() => extractKeyInfo(CUT.covered))
  assert.ok(k < 30, `extractKeyInfo 应 <30ms（实际 ${k.toFixed(2)}ms）`)
  const a = median(() => assembleSummaryRequest({
    system: 'sys', messages: HISTORY, cut: CUT, lastSummary: null, keyInfo: '', sessionMemory: '',
  }))
  assert.ok(a < 30, `assembleSummaryRequest 应 <30ms（实际 ${a.toFixed(2)}ms）`)
})

// ---------------------------------------------------------------------------
// ⑤ 线性度（防 O(n²) 退化 —— 相对断言，不受机器速度影响）
// ---------------------------------------------------------------------------
test('线性度：2n 的冷估耗时 ≤ 3.2 × n 的冷估耗时（O(n²) 会≈4）', () => {
  const n = makeBigHistory({ turns: 185 })
  const n2 = makeBigHistory({ turns: 370 })
  const t1 = median(() => estimateHistory(n), 3)
  const t2 = median(() => estimateHistory(n2), 3)
  assert.ok(
    t2 <= t1 * 3.2,
    `数据量翻倍耗时应接近翻倍（${t1.toFixed(2)}ms → ${t2.toFixed(2)}ms，比值 ${(t2 / t1).toFixed(2)}）——`
    + '超过 3.2 提示出现 O(n²) 级退化（如逐块重算全量/重复 stringify）',
  )
})
