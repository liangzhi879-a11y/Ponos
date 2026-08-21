// server/cost.test.mjs —— 成本计费（docs/production/observability.md O4-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf, withBudget } from '../kernel/cost.mjs'

test('costOf：cache 计费对齐 benchmark 口径（1000in/500out/100K cache_read/2K creation）', () => {
  const usd = costOf({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100000, cache_creation_input_tokens: 2000 })
  // 1000/1e6*0.2 + 500/1e6*1.2 + 100000/1e6*0.2*0.1 + 2000/1e6*0.2
  const expect = 1000 / 1e6 * 0.2 + 500 / 1e6 * 1.2 + 100000 / 1e6 * 0.2 * 0.1 + 2000 / 1e6 * 0.2
  assert.ok(Math.abs(usd - expect) < 1e-9)
  assert.ok(usd > 0)
})

test('costOf：缺省字段按 0 计；自定义单价生效', () => {
  assert.equal(costOf({}), 0)
  const custom = costOf({ input_tokens: 1000000, output_tokens: 0 }, { pricePerMInput: 1, pricePerMOutput: 3, cacheReadRatio: 0 })
  assert.equal(custom, 1)
})

test('withBudget：总成本 + 超限标记', () => {
  const rows = [{ cost_usd: 0.6 }, { cost_usd: 0.5 }]
  const r = withBudget(rows, 1)
  assert.equal(r.totalUsd, 1.1)
  assert.equal(r.overBudget, true)
  assert.equal(withBudget(rows, 2).overBudget, false)
})
