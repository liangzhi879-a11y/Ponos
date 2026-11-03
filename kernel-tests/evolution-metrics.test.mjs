// P3 度量看板：复发率 / 修复有效率 / 打扰率（含红线判定）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMetrics, INTERRUPTION_RED_LINE, INTERRUPTION_TARGET, METRICS_V } from '../kernel/evolution-metrics.mjs'

const item = ({ fixes = 1, recurring = false, immediate = false } = {}) => ({
  fp: 'fp-' + Math.random().toString(36).slice(2, 7),
  fixes: Array.from({ length: fixes }, () => ({ src: 'journal', probeId: 'p' })),
  origin: [{ src: 'journal', at: 1 }],
  recurring, immediate,
})

test('复发率：分母只算"修过的指纹"（没修过的谈不上复发）', () => {
  const m = computeMetrics({
    attribution: { items: [item({ recurring: true }), item({ recurring: false }), item({ fixes: 0 })], window: { days: 30 } },
    now: '2026-10-27T00:00:00.000Z',
  })
  assert.equal(m.faults.total, 3)
  assert.equal(m.faults.fixed, 2, '没修过的不进分母')
  assert.equal(m.faults.recurring, 1)
  assert.equal(m.faults.recurringRate, 0.5)
  assert.equal(m.v, METRICS_V)
  assert.deepEqual(m.window, { days: 30 })
})

test('★ 算不出来 ⇒ null（不返回 0%，0% 会被读成"完美"）', () => {
  const m = computeMetrics({ attribution: { items: [] } })
  assert.equal(m.faults.recurringRate, null)
  assert.equal(m.fixes.effectiveRate, null)
  assert.equal(m.interruption.rate, null)
  assert.equal(m.interruption.verdict, null, '没样本就不给绿灯')
})

test('修复有效率：分母是修复次数；复发过的指纹记 1 次无效（保守口径）', () => {
  const m = computeMetrics({ attribution: { items: [item({ fixes: 3, recurring: true }), item({ fixes: 2 })] } })
  assert.equal(m.fixes.total, 5)
  assert.equal(m.fixes.effective, 4, '5 次修复里 1 次被判无效')
  assert.equal(Math.round(m.fixes.effectiveRate * 100), 80)
})

test('打扰率三档：ok ≤30% / watch 30–50% / red >50%', () => {
  const mk = (dismissed, seen) => computeMetrics({
    candidates: [
      ...Array.from({ length: dismissed }, () => ({ id: 'd', state: 'dismissed' })),
      ...Array.from({ length: seen }, () => ({ id: 's', state: 'seen' })),
    ],
  }).interruption
  assert.equal(mk(1, 9).rate, 0.1)
  assert.equal(mk(1, 9).verdict, 'ok')
  assert.equal(mk(2, 8).verdict, 'ok')          // 恰好 20%
  assert.equal(mk(4, 8).verdict, 'watch')       // 33%
  assert.equal(mk(6, 9).verdict, 'watch')       // 6/15 = 40% 落在 30–50% 之间
  assert.equal(mk(8, 7).verdict, 'red')         // 53% > 红线
  assert.equal(INTERRUPTION_TARGET, 0.3)
  assert.equal(INTERRUPTION_RED_LINE, 0.5)
})

test('打扰率：new（还没露过面）不进分母', () => {
  const m = computeMetrics({ candidates: [{ id: 'a', state: 'new' }, { id: 'b', state: 'dismissed' }, { id: 'c', state: 'seen' }] })
  assert.equal(m.interruption.surfaced, 2)
  assert.equal(m.interruption.rate, 0.5)
})
