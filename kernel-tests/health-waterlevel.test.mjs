// 健康度水位信号修复（2026-09-11 用户事故："已连续压缩 1 次，剩余约 15811 轮，建议开启新会话"）：
// ① predictTurns 增长下限按窗口相对化 + 预测封顶（上下文持平时不再爆 15811 轮）
// ② 水位口径 = 完整请求面（input+缓存），优先"最近一次单请求" lastUsage（轮级合计 usage 失真）
// ③ 压缩去旧：压缩刚落地/落在本轮时不用失真数据打假红档
// ④ 红档 reason 跟随实际触发因子（不再固定"压缩 N 次 + M 轮"）
// ⑤ attentionCeiling 死代码 min 清理；setWindow 承接 compactor 真实窗口采纳
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestTokens, predictTurns } from '../kernel/context.mjs'
import { computeHealthScore, createHealth, attentionCeiling } from '../kernel/health.mjs'

test('requestTokens：完整请求面 = input + 缓存读 + 缓存写', () => {
  assert.equal(requestTokens({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }), 1050)
  assert.equal(requestTokens({ input_tokens: 100 }), 100)
  assert.equal(requestTokens(undefined), 0)
})

test('predictTurns：上下文持平时 growth 取窗口相对下限（不再爆 15811 轮）', () => {
  // 事故场景：200K 窗，水位 144189/160000（90%），近轮完全持平（delta=0）
  const recent = [144189, 144189, 144189, 144189, 144189].map((v) => ({ lastUsage: { input_tokens: v } }))
  const p = predictTurns({ recent, window: 200_000 })
  assert.equal(p.growthPerTurn, 100, '下限 = 0.05% 窗口 ≈ 100 token/轮（旧实现钳到 1）')
  assert.equal(p.predictedTurns, Math.floor((160_000 - 144_189) / 100), '≈158 轮，不再是 15811')
})

test('predictTurns：预测轮数封顶 999', () => {
  const recent = [0, 0, 0].map((v) => ({ lastUsage: { input_tokens: v } }))
  const p = predictTurns({ recent, window: 200_000 })
  assert.equal(p.predictedTurns, 999, '(160000-0)/100=1600 → 封顶 999')
})

test('predictTurns：缓存字段计入水位；lastUsage 优先、缺失回退 usage', () => {
  const cached = predictTurns({ recent: [{ lastUsage: { input_tokens: 10, cache_read_input_tokens: 150_000 } }], window: 200_000 })
  assert.equal(cached.lastInput, 150_010, '缓存读是上下文主体，必须计入')
  const legacy = predictTurns({ recent: [{ usage: { input_tokens: 42 } }], window: 200_000 })
  assert.equal(legacy.lastInput, 42, '旧 turnStats 无 lastUsage 时回退 usage')
})

test('attentionCeiling：水位基准 = 0.8 窗口（对齐压缩阈值；旧 min(0.9w,0.8w) 恒 0.8w 死代码清理）', () => {
  assert.equal(attentionCeiling(200_000), 160_000)
  assert.equal(attentionCeiling(65_536), Math.floor(65_536 * 0.8))
})

test('computeHealthScore：红档 reason 跟随实际触发因子（不再固定"压缩 N 次 + M 轮"）', () => {
  const r = computeHealthScore({ compactCount: 1, remainingPct: 9.87, remainingTurns: 158, model: 'Qwen3.8-27B' })
  assert.equal(r.tier, 'red')
  assert.match(r.reason, /水位仅剩 10%/, '真实因子（低水位）要进文案')
  assert.match(r.reason, /已连续压缩 1 次/)
  assert.match(r.reason, /建议开启新会话/)
  assert.doesNotMatch(r.reason, /15811/, '荒谬轮数不再进入文案')
  const g = computeHealthScore({ compactCount: 0, remainingPct: 100, remainingTurns: 100, failures: 3 })
  assert.equal(g.tier, 'green')
  assert.equal(g.reason, '上下文健康')
  const a = computeHealthScore({ compactCount: 1, remainingPct: 81 })
  assert.equal(a.tier, 'amber')
  assert.match(a.reason, /已连续压缩 1 次/)
})

test('压缩重估链路：压缩落地瞬间不再假红档（去旧 + 单请求水位）', () => {
  const events = []
  const wire = { health: (d) => events.push(d) }
  const h = createHealth({ wire, model: 'Qwen3.8-27B', contextWindow: 200_000, env: {} })
  // ① 上下文饱和：最近单请求持平 144189（160K 基准的 90%）；usage 为轮级合计（100 万，旧信号口径）
  for (let i = 0; i < 5; i++) {
    h.record({ usage: { input_tokens: 1_000_000 }, lastUsage: { input_tokens: 144_189 }, compactCount: 0 })
  }
  let last = events[events.length - 1]
  assert.equal(last.tier, 'red', '水位 9% → 红档（由水位因子触发，reason 应如实反映）')
  assert.ok(last.remainingTurns <= 999, '剩余轮数封顶，不再爆 15811')
  assert.match(last.reason, /水位仅剩 10%/)
  // ② pre-step 触发压缩 → recordCompaction 立即重估（recent 最后一项仍是压缩前 turnStats）
  h.recordCompaction('摘要…', 1)
  last = events[events.length - 1]
  assert.equal(last.tier, 'amber', '压缩刚落地：去旧 → 水位中性 + 压缩计次底分 40 → 黄档，不再假红')
  assert.equal(last.remainingPct, 100)
  assert.match(last.reason, /已连续压缩 1 次/)
  // ③ 含压缩的轮次收尾：turnStats.count=1 领先上一轮 → 去旧继续中性（其 usage 为 压缩前+摘要+压缩后 之和）
  h.record({ usage: { input_tokens: 2_000_000 }, lastUsage: { input_tokens: 30_000 }, compactCount: 1 })
  let s = h.snapshotState()
  assert.equal(s.tier, 'amber')
  assert.equal(s.remainingPct, 100, '去旧窗口内不采用失真合计')
  // ④ 压缩后的正常轮：恢复实测水位（30K → 剩 81%）
  h.record({ usage: { input_tokens: 30_000 }, lastUsage: { input_tokens: 30_000 }, compactCount: 1 })
  s = h.snapshotState()
  assert.equal(s.tier, 'amber')
  assert.equal(s.remainingPct, 81)
  assert.equal(s.predictedTurns, 999, '压缩后回落增长取负 → 下限 100/轮 → (160000-30000)/100 封顶 999')
})

test('setWindow：真实窗口采纳后水位立即按真实窗口重估', () => {
  const events = []
  const wire = { health: (d) => events.push(d) }
  const h = createHealth({ wire, contextWindow: 256_000, env: {} })
  h.setWindow(131_072)
  // 单请求 100K：按 256K 配置窗 → 基准 204800 → 剩 51%（无压力）；按 131K 真实窗 → 基准 104857 → 剩 4.6%（红档）
  h.record({ usage: { input_tokens: 100_000 }, lastUsage: { input_tokens: 100_000 }, compactCount: 0 })
  const last = events[events.length - 1]
  assert.equal(last.tier, 'red', '真实窗口采纳后压力即时可见')
  assert.equal(last.remainingPct, 5, Math.round(100 - (100_000 / Math.floor(131_072 * 0.8)) * 100))
})

test('兼容：旧格式 turnStats（无 lastUsage/compactCount）不报错、按 usage 回退', () => {
  const events = []
  const wire = { health: (d) => events.push(d) }
  const h = createHealth({ wire, contextWindow: 200_000, env: {} })
  h.record({ usage: { input_tokens: 50_000 } })
  const s = h.snapshotState()
  assert.equal(s.remainingPct, Math.round(100 - (50_000 / 160_000) * 100))
  assert.equal(s.tier, 'green')
  assert.equal(events.length, 0, '绿档不发事件（首轮即绿不打扰）')
})
