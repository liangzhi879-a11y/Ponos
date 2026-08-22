// 思考深度测试（对齐 Claude Code /effort 档位 + DeepSeek reasoning_effort 注入）：
// normalizeEffort 档位规范化 + effortParam 请求体字段注入
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effortParam } from '../kernel/api.mjs'
import { normalizeEffort } from '../kernel/engine.mjs'

test('normalizeEffort：off/low/high/max 原样保留', () => {
  assert.equal(normalizeEffort('off'), 'off')
  assert.equal(normalizeEffort('low'), 'low')
  assert.equal(normalizeEffort('high'), 'high')
  assert.equal(normalizeEffort('max'), 'max')
  assert.equal(normalizeEffort('MAX'), 'max')
})

test('normalizeEffort：medium 并入 high（DeepSeek 旧映射）', () => {
  assert.equal(normalizeEffort('medium'), 'high')
  assert.equal(normalizeEffort('MEDIUM'), 'high')
})

test('normalizeEffort：auto/空/未知 → null（不注入，模型原生自适应）', () => {
  assert.equal(normalizeEffort('auto'), null)
  assert.equal(normalizeEffort(''), null)
  assert.equal(normalizeEffort(undefined), null)
  assert.equal(normalizeEffort(null), null)
  assert.equal(normalizeEffort('nonsense'), null)
  assert.equal(normalizeEffort('4096'), null) // 数字 budget 体系不再支持
})

test('effortParam：low/high/max → reasoning_effort 字段', () => {
  assert.deepEqual(effortParam('low'), { reasoning_effort: 'low' })
  assert.deepEqual(effortParam('high'), { reasoning_effort: 'high' })
  assert.deepEqual(effortParam('max'), { reasoning_effort: 'max' })
})

test('effortParam：off → thinking disabled；auto/空 → 不注入任何字段', () => {
  assert.deepEqual(effortParam('off'), { thinking: { type: 'disabled' } })
  assert.deepEqual(effortParam('auto'), {})
  assert.deepEqual(effortParam(null), {})
  assert.deepEqual(effortParam(undefined), {})
})

test('effortParam 组合：off 与 effort 永不并发生发（避免 DeepSeek #1397 400）', () => {
  for (const eff of ['off', 'low', 'high', 'max']) {
    const p = effortParam(eff)
    const hasBoth = 'thinking' in p && 'reasoning_effort' in p
    assert.equal(hasBoth, false, `off 与 effort 同发：${eff}`)
  }
})

test('normalizeEffort + effortParam 端到端：用户档位 → 请求体字段', () => {
  const cases = [
    ['auto', {}],
    ['off', { thinking: { type: 'disabled' } }],
    ['low', { reasoning_effort: 'low' }],
    ['medium', { reasoning_effort: 'high' }], // medium 归一为 high
    ['high', { reasoning_effort: 'high' }],
    ['max', { reasoning_effort: 'max' }],
  ]
  for (const [user, want] of cases) {
    assert.deepEqual(effortParam(normalizeEffort(user)), want, user)
  }
})
