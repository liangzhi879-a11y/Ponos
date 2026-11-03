// T4.1 / T4.2（治理计划 2026-10-20-token-context-governance）：
// 演化投影器看得见 token/成本，且 C_success 口径可证。
//
// 问题（问0）：`TaskRecord` 此前**没有 usage 字段**（`grep -E "token|usage|cost"` 在
// kernel/trace-project.mjs 零命中）⇒ 演化环 6 条规则全是行为/质量信号，**零成本维度**；
// 而数据本来就在 transcript 里（`message.usage`，session.mjs:298-300）。
//
// 本文件钉住 6 条（前 4 条在改动前必红）：
//   ① usage 四字段按条目求和，且 total = 四者之和
//   ② ★ 缺 usage ⇒ **null**（写成 0 = 把"没有证据"说成"免费"）
//   ③ ★ 计价按**每条自己的 model**（混模型会话不得被同一组价抹平）
//   ④ compact.count = compaction 条目数（压缩是历史面最大支出，必须可见）
//   ⑤ ★ C_success：分母只含"有证据且成功"的会话（缺证据压低成本 = 拿缺失当利好）
//   ⑥ ★ 零成功 ⇒ null（不得 Infinity/NaN）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectSession, projectRecords, summarizeRecords, groupCostByStrategies, buildEvolutionReport, TASK_RECORD_V } from '../kernel/trace-project.mjs'

/** 固定价注入：让断言确定、可复现（不依赖 env / 内置价表） */
const priceOf = (model) => ({
  'model-a': { pricePerMInput: 1, pricePerMOutput: 10, cacheReadRatio: 0.1 },
  'model-b': { pricePerMInput: 100, pricePerMOutput: 1000, cacheReadRatio: 0.1 },
}[model] || { pricePerMInput: 1, pricePerMOutput: 1, cacheReadRatio: 0.1 })

const asst = (model, usage, extra = {}) => ({ type: 'assistant', message: { model, usage, ...extra } })

test('① usage 四字段按条目求和，total = 四者之和', () => {
  const rec = projectSession('s1', [
    asst('model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 }),
    asst('model-a', { input_tokens: 200, output_tokens: 60 }),
  ], { priceOf })
  assert.equal(rec.usage.input, 300)
  assert.equal(rec.usage.output, 110)
  assert.equal(rec.usage.cacheRead, 1000)
  assert.equal(rec.usage.cacheCreate, 10)
  assert.equal(rec.usage.total, 300 + 110 + 1000 + 10)
  assert.equal(rec.v, TASK_RECORD_V, 'schema 版本必须随字段形状 +1（v2）')
})

test('★ ② 缺 usage ⇒ null（不得为 0：没有证据 ≠ 免费）', () => {
  const rec = projectSession('s2', [asst('model-a', undefined), { type: 'user', message: { role: 'user', content: 'hi' } }], { priceOf })
  assert.equal(rec.usage, null, '★ 无任何 usage 条目时必须 null（写成 {input:0,…} 即红）')
  // 只有部分条目有 usage ⇒ 仍要如实汇总（不是 null，也不是 0）
  const mixed = projectSession('s3', [asst('model-a', undefined), asst('model-a', { input_tokens: 7, output_tokens: 3 })], { priceOf })
  assert.equal(mixed.usage.input, 7)
  assert.equal(mixed.usage.output, 3)
})

test('★ ③ 计价按每条自己的 model（混模型不得被同一组价抹平）', () => {
  const rec = projectSession('s4', [
    asst('model-a', { input_tokens: 1_000_000, output_tokens: 0 }), // 1 美元/百万
    asst('model-b', { input_tokens: 1_000_000, output_tokens: 0 }), // 100 美元/百万
  ], { priceOf })
  assert.equal(rec.usage.byModel['model-a'].costUsd, 1)
  assert.equal(rec.usage.byModel['model-b'].costUsd, 100)
  assert.equal(rec.usage.costUsd, 101, '总成本 = 各模型之和（101 而不是"同一组价 × 2"）')
})

test('★ ④ compact.count = compaction 条目数', () => {
  const rec = projectSession('s5', [
    { type: 'assistant', kind: 'compaction', message: { content: [{ type: 'text', text: '<compacted-summary>' }] } },
    { type: 'assistant', kind: 'compaction', message: { content: [{ type: 'text', text: '<compacted-summary>' }] } },
    asst('model-a', { input_tokens: 1, output_tokens: 1 }),
  ], { priceOf })
  assert.equal(rec.compact.count, 2)
  // 无压缩 ⇒ 0（这是"数出来是 0"，不是"缺证据"——与 usage 的 null 语义不同，刻意如此）
  assert.deepEqual(projectSession('s6', [asst('model-a', { input_tokens: 1, output_tokens: 1 })], { priceOf }).compact, { count: 0 })
})

test('⑤ 汇总：usageTotals / compactTotal / qualityGuard 并列（不合成单一总分）', () => {
  const ok = projectSession('s7', [asst('model-a', { input_tokens: 1_000_000, output_tokens: 0 })], { priceOf }) // 成功 + 有证据
  const noEvidence = projectSession('s8', [{ type: 'user', message: { role: 'user', content: 'hi' } }], { priceOf })
  const sum = summarizeRecords([ok, noEvidence])
  assert.equal(sum.usageTotals.costUsd, 1)
  assert.equal(sum.usageSessions, 1)
  // 两者并列存在，互不覆盖
  assert.equal(sum.qualityGuard.correctionsRate, 0)
  assert.equal(sum.qualityGuard.errorRate, 0)
})

test('★ ⑤b C_success 分母只含"有证据且成功"的会话（缺证据不得压低成本）', () => {
  // 一个成功且有证据（1 美元）+ 两个成功但无证据 ⇒ C_success 必须是 1，不是 1/3
  const withEvidence = projectSession('s9', [asst('model-a', { input_tokens: 1_000_000, output_tokens: 0 })], { priceOf })
  const noEv1 = projectSession('s10', [asst('model-a', undefined, { content: [{ type: 'text', text: '完成' }] })], { priceOf })
  const noEv2 = projectSession('s11', [asst('model-a', undefined, { content: [{ type: 'text', text: '完成' }] })], { priceOf })
  const sum = summarizeRecords([withEvidence, noEv1, noEv2])
  assert.equal(sum.outcomes.ok, 3, '三个会话都是成功（纯文本收束）')
  assert.equal(sum.okWithUsage, 1, '★ 只有 1 个"成功且有证据"')
  assert.equal(sum.costPerSuccess, 1, '★ C_success = 1/1（取全部成功会话当分母会得 0.3333 ⇒ 红）')
  assert.equal(sum.tokensPerSuccess, 1_000_000)
})

test('★ ⑥ 零成功 / 零证据 ⇒ null（不得 Infinity/NaN）', () => {
  const failed = projectSession('s12', [
    asst('model-a', { input_tokens: 1_000_000, output_tokens: 0 }),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x', is_error: true }] } },
  ], { priceOf })
  const s1 = summarizeRecords([failed])
  assert.equal(s1.outcomes.error, 1)
  assert.equal(s1.costPerSuccess, null, '★ 无成功任务 ⇒ null（Infinity 即红）')
  assert.equal(s1.tokensPerSuccess, null)
  const s2 = summarizeRecords([])
  assert.equal(s2.costPerSuccess, null, '空集合 ⇒ null（空集合判红：不得当 0）')
  assert.equal(s2.usageTotals.costUsd, 0)
})

test('projectRecords 透传 priceOf（报告层与投影层同一口径）', () => {
  const entries = [
    { type: 'assistant', sessionId: 'x1', message: { model: 'model-a', usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
  ]
  const recs = projectRecords(entries, { priceOf })
  assert.equal(recs.length, 1)
  assert.equal(recs[0].usage.costUsd, 1, '注入的价必须一路传到 record（否则报告与 /api/usage 又分叉）')
})

// ── T3.2 读侧（2026-10-20）：按策略组合分组聚合 C_success ──────────────────────
// 没有这组，"turn.activeStrategies 落了盘但没人看" —— 归因仍然只能整体猜。


const priceOf1 = () => ({ pricePerMInput: 1, pricePerMOutput: 0, cacheReadRatio: 0.1 })

/** 造一条带策略标记的会话：1M input = $1 */
function sessionWith(id, usd, strategies) {
  const entries = [
    { type: 'meta', kind: 'turn', turnIndex: 1, activeStrategies: strategies, seq: 1 },
    {
      type: 'assistant', seq: 2, timestamp: '2026-10-01T00:00:00Z',
      message: { model: 'm', content: [{ type: 'text', text: '完成' }], usage: { input_tokens: Math.round(usd * 1e6), output_tokens: 0 } },
    },
  ]
  return projectSession(id, entries, { priceOf: priceOf1 })
}

test('★ T3.2 投影带上 activeStrategies（缺字段 ⇒ null，不是空数组）', () => {
  assert.deepEqual(sessionWith('s1', 1, ['a', 'b']).activeStrategies, ['a', 'b'])
  const noField = projectSession('s2', [
    { type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: { model: 'm', content: [{ type: 'text', text: 'x' }] } },
  ], { priceOf: priceOf1 })
  assert.equal(noField.activeStrategies, null, '★ 缺字段必须是 null（""没测到" ≠ "一条都没开""）')
})

test('★ T3.2 按策略**组合**分组（不拆单条：同时开的策略拆开 = 假样本量）', () => {
  const recs = [
    sessionWith('a1', 1, ['x', 'y']), sessionWith('a2', 1, ['y', 'x']),  // 同组合不同顺序 ⇒ 同组
    sessionWith('b1', 2, ['x']), sessionWith('b2', 2, ['x']),
    sessionWith('b3', 2, ['x']),
  ]
  const { groups, ungrouped } = groupCostByStrategies(recs, { minSessions: 1 })
  assert.equal(ungrouped, 0)
  const xy = groups.find((g) => g.key === 'x+y')
  assert.ok(xy, `应有 "x+y" 组（实测 ${groups.map((g) => g.key).join(' / ')}）`)
  assert.equal(xy.sessions, 2)
  assert.equal(xy.costPerSuccess, 1)
  assert.equal(groups.find((g) => g.key === 'x').costPerSuccess, 2)
})

test('★ T3.2 小样本组不给结论（costPerSuccess=null，原始值另存）', () => {
  const recs = [sessionWith('a1', 1, ['only'])]
  const { groups } = groupCostByStrategies(recs, { minSessions: 3 })
  const g = groups.find((x) => x.key === 'only')
  assert.equal(g.costPerSuccess, null, '★ 样本不足必须给 null（小样本上的数字会被误读成结论）')
  assert.equal(g.costPerSuccessRaw, 1, '原始值仍可见（供人自己判断）')
  assert.match(g.note, /样本不足/)
})

test('★ T3.2 无策略字段的会话不进分组（单独计数，不伪造归因）', () => {
  const noField = projectSession('old', [
    { type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: { model: 'm', content: [{ type: 'text', text: 'x' }] } },
  ], { priceOf: priceOf1 })
  const { groups, ungrouped } = groupCostByStrategies([noField, sessionWith('a1', 1, ['x'])], { minSessions: 1 })
  assert.equal(ungrouped, 1, '★ 旧会话无归因依据 ⇒ 单独计数（不许塞进 "none" 组混淆视听）')
  assert.deepEqual(groups.map((g) => g.key), ['x'])
})

test('★ T3.2 空集合判红：无记录 ⇒ 空 groups + ungrouped=0', () => {
  assert.deepEqual(groupCostByStrategies([], {}), { groups: [], ungrouped: 0 })
  assert.deepEqual(groupCostByStrategies(null, {}), { groups: [], ungrouped: 0 })
})

test('★ T3.2 报告里真的有 strategyGroups（防"只留导出、没有读侧"）', () => {
  // 报告是演化环唯一数据源：这一段不在报告里，A/B 归因就没有落点。
  const entries = sessionWith('g1', 1, ['x']).__entries ?? null
  void entries
  const rep = buildEvolutionReport([
    { type: 'meta', kind: 'turn', turnIndex: 1, activeStrategies: ['tool-desc-budget'], sessionId: 'sg1', seq: 1 },
    {
      type: 'assistant', sessionId: 'sg1', seq: 2, timestamp: '2026-10-01T00:00:00Z',
      message: { model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    },
  ], { priceOf: priceOf1 })
  assert.ok(rep.strategyGroups, '★ 报告必须含 strategyGroups 段（否则 activeStrategies 落了盘没人看）')
  assert.equal(rep.strategyGroups.groups.length, 1)
  assert.deepEqual(rep.strategyGroups.groups[0].strategies, ['tool-desc-budget'])
  assert.equal(rep.strategyGroups.ungrouped, 0)
})
