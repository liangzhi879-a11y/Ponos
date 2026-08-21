// server/context-predict.test.mjs —— P5 L4-1 上下文预测与提前预警
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { predictTurns } from '../kernel/context.mjs'
import { createHealth } from '../kernel/health.mjs'

test('predictTurns：增长速率 = 最近 k 轮增量均值 → 预测轮数', () => {
  // 每轮 input 增长 1000（从 50000 起）
  const recent = [50000, 51000, 52000, 53000, 54000].map((v) => ({ usage: { input_tokens: v } }))
  const r = predictTurns({ recent, window: 200_000, thresholdRatio: 0.8 })
  assert.equal(r.growthPerTurn, 1000)
  assert.equal(r.threshold, 160_000)
  assert.equal(r.predictedTurns, 106) // floor((160000-54000)/1000)
  assert.equal(r.lastInput, 54000)
})

test('predictTurns：数据不足 → 保守默认 1000', () => {
  const r = predictTurns({ recent: [{ usage: { input_tokens: 100 } }], window: 200_000, thresholdRatio: 0.8 })
  assert.equal(r.growthPerTurn, 1000)
  assert.equal(r.predictedTurns, 159)
})

test('health 集成：yfw_health 事件含 predictedTurns/growthPerTurn，红档触发', () => {
  const events = []
  const wire = { health: (h) => events.push(h), summary: () => {} }
  const h = createHealth({ wire, model: 'deepseek-v4-flash', contextWindow: 200_000, env: {} })
  // 两轮：input 从 100000（绿）涨到 120000 → 增长 20000/轮；ceiling=160000，
  // 剩余轮数 floor((160000-120000)/20000)=2 <5 → forceRed → 红档触发（档位变更才发）
  h.record({ usage: { input_tokens: 100_000 }, compactCount: 0 })
  h.record({ usage: { input_tokens: 120_000 }, compactCount: 0 })
  assert.equal(events.length, 1)
  assert.equal(events[0].tier, 'red')
  assert.ok(Number.isInteger(events[0].predictedTurns))
  assert.equal(events[0].growthPerTurn, 20_000)
})
