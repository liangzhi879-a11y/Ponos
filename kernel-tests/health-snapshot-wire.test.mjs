// 快照上 wire（端到端）：快照只写在模块里而没上帧，等于没做。
// 同时钉住两条最容易被改坏的性质：① 快照**捎带**（不额外触发帧 ⇒ 不产生噪音）；
// ② 未注入 provider 时**不输出该字段**（老内核/老 GUI 兼容，逐字回旧行为）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHealth } from '../kernel/health.mjs'
import { buildHealthSnapshot } from '../kernel/health-snapshot.mjs'

function collect() {
  const frames = []
  return { frames, wire: { health: (f) => frames.push(f) } }
}

const SNAP = {
  pressure: { remainingPct: 42, remainingTurns: 7, compactCount: 2, attentionCeiling: 160_000 },
  fidelity: { memory: 0.9, coherence: 0.8, goal: 0.85, issues: [] },
  cost: { tokens: 100, requests: 2, costUsd: 0.01, budgetUsd: null, overBudget: null },
  guard: { hits: [], injections: 0, ladder: null },
  disk: { sites: {}, total: { count: 0, ms: 0, slow: 0, failures: 0 }, maxMs: 0, slowestSite: null, p95Ms: null, health: 'ok', healLevel: null },
}

test('注入 buildSnapshot ⇒ health 帧带 snapshot 字段，且内容逐字透传', () => {
  const { frames, wire } = collect()
  const health = createHealth({ wire, contextWindow: 1000, buildSnapshot: () => SNAP })
  health.record({ inputTokens: 100, outputTokens: 10 })
  health.emitIfChanged(true)
  assert.ok(frames.length >= 1, '应发出 health 帧')
  const f = frames[frames.length - 1]
  assert.deepEqual(f.snapshot, SNAP, '快照应逐字透传（聚合器已保证形状，此处不做二次加工）')
  assert.equal(typeof f.remainingPct, 'number', '既有字段不得受影响')
})

test('★ 未注入 buildSnapshot ⇒ 帧里**没有** snapshot 字段（老内核/老 GUI 逐字兼容）', () => {
  const { frames, wire } = collect()
  const health = createHealth({ wire, contextWindow: 1000 })
  health.record({ inputTokens: 100, outputTokens: 10 })
  health.emitIfChanged(true)
  const f = frames[frames.length - 1]
  assert.ok(!('snapshot' in f), '无 provider ⇒ 不得输出该键（不是输出 null）')
})

test('★ provider 抛错不得打断 health 上报（观测失败不能变成功能失败）', () => {
  const { frames, wire } = collect()
  const health = createHealth({ wire, contextWindow: 1000, buildSnapshot: () => { throw new Error('boom') } })
  health.record({ inputTokens: 100, outputTokens: 10 })
  assert.doesNotThrow(() => health.emitIfChanged(true), 'provider 异常须被吞掉')
  const f = frames[frames.length - 1]
  assert.equal(typeof f.remainingPct, 'number', '既有字段照旧上报')
  assert.ok(!('snapshot' in f), '异常时省略该字段（不输出半个快照）')
})

test('★ 快照是**捎带**：不因快照变化而额外发帧（防噪音）', () => {
  const { frames, wire } = collect()
  let snap = SNAP
  const health = createHealth({ wire, contextWindow: 1000, buildSnapshot: () => snap })
  health.record({ inputTokens: 100, outputTokens: 10 })
  health.emitIfChanged(true)
  const n1 = frames.length
  snap = { ...SNAP, cost: { ...SNAP.cost, tokens: 999 } } // 快照变了，但 health 数值未变
  health.emitIfChanged(false) // 非强制且 health 未变 ⇒ 不应发帧
  assert.equal(frames.length, n1, '快照变化本身不得触发新帧（它只是搭车字段）')
})

// ── 求值时机（Task 5 补）────────────────────────────────────────────────────
// 契约声明"provider 只在真要发帧时被调用"，但原先无用例钉住：把求值提到 `if (changed)` 之外，
// 既有用例全绿而 provider **每次重估**都被调用（本目录实测：5 次"非强制且档位未变"的重估
// ⇒ 计数 0 → 5；其余 44 例照旧全绿）。故按**调用计数**钉住时机。
test('★ 求值时机：档位未变的非强制重估不调 provider；一次强制发帧恰调 1 次', () => {
  let calls = 0
  const { frames, wire } = collect()
  const health = createHealth({ wire, contextWindow: 200_000, buildSnapshot: () => { calls += 1; return SNAP } })
  health.record({ usage: { input_tokens: 1 }, lastUsage: { input_tokens: 1 }, compactCount: 0 }) // 轮末 force 发一帧（2026-10-08 口径）
  assert.equal(frames.length, 1, '前提：轮末必发一帧（档位 green 也发）')
  assert.equal(calls, 1, '前提：发帧才求值 ⇒ 计数从 1 起')
  for (let i = 0; i < 5; i++) health.emitIfChanged(false) // 非强制且档位未变
  assert.equal(calls, 1, '不得求值（求值=为档位未变的轮次买单）')
  assert.equal(frames.length, 1, '非强制且档位未变：不发帧')
  health.emitIfChanged(true) // 真要发帧
  assert.equal(calls, 2, '恰好 +1')
  assert.equal(frames.length, 2, '只有强制那次发了帧')
})

// ── 水位基准对外暴露（Task 5 修复：此前该字段恒 null）────────────────────────
test('★ attentionCeiling：health 对外快照给当前窗口的水位基准（数字）；无有效窗口 ⇒ null', () => {
  const { wire } = collect()
  const h = createHealth({ wire, contextWindow: 1000 })
  assert.equal(h.snapshotState().attentionCeiling, 800, '= floor(1000 × 0.8)；与 remainingPct 的分母同源')
  h.setWindow(131_072)
  assert.equal(h.snapshotState().attentionCeiling, Math.floor(131_072 * 0.8), '窗口被真实采纳后基准随之变（这就是要看分母的理由）')
  const noWin = createHealth({ wire, contextWindow: -1 }) // win 被钳为 0 ⇒ 无有效水位基准
  assert.equal(noWin.snapshotState().attentionCeiling, null, '缺项如实 null（不填 0）')
  assert.equal(buildHealthSnapshot({ health: noWin.snapshotState() }).pressure.attentionCeiling, null, '聚合器不得把 null 变成 0')
})

// ── 真实接线（Task 5 Step 4）────────────────────────────────────────────────
// 为什么必须有这条：上面三条注入的是**测试自造**的 provider ⇒ 接不接线都绿。真链路上 health 在
// cli 装配期先建、engine 后建，而 cost/guard 的真源在 engine 闭包里 ⇒ provider 只能由 engine 晚
// 绑定注入。这条守的正是"计划写了接线、实际没人调用注入位"那种静默漏接线（快照永远上不了帧）。
test('★ 真实接线：engine 装配后 health 帧自带 snapshot（provider 由 engine 注入，非测试自造）', async () => {
  const frames = []
  const noop = () => {}
  const wire = new Proxy(
    { health: (f) => frames.push(f) },
    { get: (t, k) => (k in t ? t[k] : noop) }, // 其余 wire 出口一律 noop（本用例不跑轮次）
  )
  const health = createHealth({ wire, model: 'm', contextWindow: 1000 })
  const { createEngine } = await import('../kernel/engine.mjs')
  createEngine({ opts: { model: 'm' }, wire, session: null, health })
  health.emitIfChanged(true)
  const f = frames[frames.length - 1]
  assert.ok(f && 'snapshot' in f, 'engine 必须把自己的只读闭包注入 health（否则快照上不了帧）')
  assert.deepEqual(
    Object.keys(f.snapshot).sort(),
    ['cost', 'disk', 'fidelity', 'guard', 'pressure'],
    '五段齐备（聚合器形状）',
  )
  assert.equal(f.snapshot.fidelity, null, 'fidelity 段恒 null：失真走既有独立通道，本快照不重复采集')
  assert.equal(f.snapshot.guard, null, '本轮还没跑过 ⇒ guard 如实 null（**不得**虚报"零命中"）')
  assert.equal(typeof f.snapshot.cost.tokens, 'number', 'cost.tokens 取会话累计（engine 闭包内的真源）')
  // pressure 两字段都必须**真来自 health 自身**（不是测试自造 provider）：数值与 health 的对外快照逐字相同。
  // `attentionCeiling` 此前恒 null（聚合器用 str() 收数字 ⇒ 真值被丢），本断言钉住它已接通。
  assert.equal(typeof f.snapshot.pressure.remainingPct, 'number', 'pressure.remainingPct 来自 health.snapshotState()')
  assert.equal(f.snapshot.pressure.attentionCeiling, health.snapshotState().attentionCeiling, '聚合器读的就是 health 的当前水位基准')
  assert.equal(f.snapshot.pressure.attentionCeiling, 800, 'contextWindow 1000 × 0.8 ⇒ 800（不再是恒 null 的缺项）')
})
