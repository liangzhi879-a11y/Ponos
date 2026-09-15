// health 失真档装配（2026-09-12 spec §6.1）：ponos_health 新增可选 distortion 字段。
// 三条铁律（本文件即其回归网）：
//   ① 压力 tier 语义冻结——血条继续读它，失真档变化不得影响压力档；
//   ② 两个 tier 严禁互相赋值（本文件断言互不干扰）；
//   ③ distortion 为纯增量可选字段——无失真信号时恒 green 且不发事件（默认健康，不打扰）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHealth, computeHealthScore } from '../kernel/health.mjs'

const mk = () => {
  const ev = []
  const sum = []
  return { ev, sum, wire: { health: (d) => ev.push(d), summary: (s, c) => sum.push({ s, c }) } }
}

const GREEN_DIST = (d) => d.tier === 'green' && d.trigger === null && d.score === 0

test('压力档语义不变：红档判定与承诺字段（15811 场景的回归网）', () => {
  const r = computeHealthScore({ compactCount: 1, remainingPct: 9, remainingTurns: 158, model: 'Qwen3.8-27B' })
  assert.equal(r.tier, 'red')
  assert.equal(r.suggestNewSession, true, '压力档字段保持原语义')
  // reason 文案属压力侧实现细节（会随文案优化调整），此处只断"档位与承诺字段"不变量；
  // 失真侧的承诺是：压力档的任何取值都不得影响 distortion（见下方互不干扰用例）
  assert.equal(typeof r.reason, 'string')
  assert.ok(r.reason.length > 0)
})

test('无失真信号：不发事件（默认健康不打扰），distortionTier 恒 green', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordTurnContent({ user: '实现 A', assistant: '好的，开始实现 A', toolDigest: [] })
  assert.equal(ev.length, 0, '压力绿 + 失真绿：不发事件')
  assert.equal(h.getState().distortionTier, 'green')
  assert.equal(h.getState().tier, 'green')
})

test('失真档变化也发事件（压力档不变时），且 pressure tier 不受影响', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  assert.equal(ev.length, 0)
  // S2 强证据：关键实体成片丢失 → 失真红，而压力仍绿
  h.recordCompactionAudit({
    entities: ['src/a.ts', 'src/b.ts', 'src/c.ts', '阈值 120'],
    missing: ['src/a.ts', 'src/b.ts'],
    ratio: 0.5,
  })
  assert.equal(ev.length, 1, '失真转红必须发事件')
  const last = ev[0]
  assert.equal(last.distortion.tier, 'red')
  assert.equal(last.tier, 'green', '两个 tier 互不干扰：压力档不因失真变化')
  assert.equal(last.distortion.trigger, 'm:summary:src/a.ts')
  assert.equal(typeof last.distortion.anchorText, 'string', 'red 时下发锚点文本')
  assert.ok(last.distortion.issues.length > 0, 'red 必须带证据清单（可审计）')
})

test('non-red 不下发 anchorText（省流量）；amber 只带档位与证据', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  // 缺失率 2/6 ≈ 0.33：落在 medium 区间 → 两条中证据 → amber（不弹窗、无锚点）
  h.recordCompactionAudit({
    entities: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'],
    missing: ['a.md', 'b.md'],
    ratio: 0.33,
  })
  assert.equal(ev.length, 1)
  const last = ev[0]
  assert.equal(last.distortion.tier, 'amber')
  assert.equal(last.distortion.trigger, null, 'amber 不弹窗')
  assert.equal(last.distortion.anchorText, undefined, 'non-red 不下发锚点')
  assert.equal(last.distortion.anchorAvailable, false)
})

test('markFidelityResolved 后回绿并发事件（失真档有回绿路径，压力档没有）', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit({
    entities: ['a.md', 'b.md', 'c.md', 'd.md'], missing: ['a.md', 'b.md'], ratio: 0.5,
  })
  assert.equal(ev[ev.length - 1].distortion.tier, 'red')
  const ids = h.fidelityEvidence().active.map((i) => i.id)
  const n = h.markFidelityResolved(ids)
  assert.equal(n, ids.length)
  const last = ev[ev.length - 1]
  assert.equal(last.distortion.tier, 'green', '锚定生效 → 立即回绿')
  assert.equal(last.tier, 'green')
})

test('总开关 PONOS_FIDELITY=0：失真信号不产生事件（彻底静默）', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: { PONOS_FIDELITY: '0' } })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit({
    entities: ['a.md', 'b.md', 'c.md', 'd.md'], missing: ['a.md', 'b.md'], ratio: 0.5,
  })
  assert.equal(ev.length, 0, '关闭时不产生任何失真事件')
  assert.equal(h.getState().distortionTier, 'green')
})

test('静默降级：fidelity 抛异常不影响压力档与主流程', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {}, getAnchorSource: () => { throw new Error('boom') } })
  assert.doesNotThrow(() => {
    h.recordTurnContent({ user: 'u', assistant: 'a', toolDigest: null })
    h.recordCompactionAudit({ entities: ['a.md', 'b.md', 'c.md', 'd.md'], missing: ['a.md', 'b.md'], ratio: 0.5 })
    h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  })
  const last = ev[ev.length - 1]
  assert.equal(last.distortion.tier, 'red')
  assert.equal(typeof last.distortion.anchorText, 'string', '锚点源抛异常时仍给出可用锚点（含任务）')
  assert.match(last.distortion.anchorText, /原来任务|u|锚定/)
})

test('缺 distortion 字段 = green 的语义前提：老内核不发字段时前端按 green（契约断言）', () => {
  // 该断言保护"纯增量"承诺：distortion 必须是**可选**字段，前端才敢按 green 兜底
  const { wire } = mk()
  const h = createHealth({ wire, env: {} })
  const s = h.snapshotState()
  assert.ok(s.distortion, 'snapshot 总带 distortion（新内核）')
  assert.equal(GREEN_DIST(s.distortion), true)
})

test('压缩次数 seed：PONOS_ 与 YFW_ 双名都能读（bridge 注入名不一致的兼容）', () => {
  // 背景：bridge 注入 YFW_HEALTH_COMPACT_COUNT，内核曾只读 PONOS_HEALTH_COMPACT_COUNT，
  // 导致进程回收后 resume 的血条压缩史从未恢复。双名读取兼容已装旧桥与未来新桥。
  const { wire } = mk()
  const a = createHealth({ wire, env: { PONOS_HEALTH_COMPACT_COUNT: '3' } })
  assert.equal(a.getState().compactCount, 3)
  const b = createHealth({ wire, env: { YFW_HEALTH_COMPACT_COUNT: '5' } })
  assert.equal(b.getState().compactCount, 5, 'YFW_ 旧名必须生效')
  const c = createHealth({ wire, env: { PONOS_HEALTH_COMPACT_COUNT: '2', YFW_HEALTH_COMPACT_COUNT: '7' } })
  assert.equal(c.getState().compactCount, 7, '两名并存时两者取 max（不因旧名较小而丢历史）')
  assert.equal(createHealth({ wire, env: {} }).getState().compactCount, 0)
  assert.equal(createHealth({ wire, env: { PONOS_HEALTH_COMPACT_COUNT: 'abc' } }).getState().compactCount, 0, '非法值回落 0')
})
