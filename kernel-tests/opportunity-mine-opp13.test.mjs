// P3 · OPP-13 复发升级（2026-10-27）：修完之后又复发 ⇒ 出候选，且"立刻复发"可辨。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mineCandidates, THRESHOLDS, RULE_KINDS, adviceOf } from '../kernel/opportunity-mine.mjs'

const attrItem = (over = {}) => ({
  fp: 'fp-abc', count: 4, originCount: 3,
  firstAt: '2026-10-20T00:00:00.000Z', lastAt: '2026-10-26T00:00:00.000Z',
  sources: ['journal', 'log'],
  origin: [
    { src: 'journal', ref: 's1#3', at: Date.parse('2026-10-21T00:00:00.000Z'), fp: 'fp-abc' },
    { src: 'log', ref: 's1#9', at: Date.parse('2026-10-23T00:00:00.000Z'), fp: 'fp-abc' },
  ],
  fixes: [{ src: 'journal', ref: 's1#5', at: Date.parse('2026-10-22T00:00:00.000Z'), fp: 'fp-abc' }],
  candidates: [], recurring: true, immediate: false,
  ...over,
})

const mine = (attribution) => mineCandidates([], { now: '2026-10-27T00:00:00.000Z', attribution })

test('OPP-13：recurring 的指纹出候选，带复发次数/修次数/来源', () => {
  const [c] = mine({ items: [attrItem()] })
  assert.equal(c.ruleId, 'OPP-13')
  assert.equal(c.kind, RULE_KINDS['OPP-13'])
  assert.equal(c.subject, 'fp-abc')
  assert.equal(c.metrics.recurrences, 2, '两次再现')
  assert.equal(c.metrics.fixes, 1)
  assert.equal(c.metrics.immediate, false)
  assert.deepEqual(c.metrics.sources, ['journal', 'log'])
})

test('OPP-13：★ 48h 内再现标记 immediate（界面与 healer 据此停自动修）', () => {
  const [c] = mine({ items: [attrItem({ immediate: true })] })
  assert.equal(c.metrics.immediate, true)
})

test('OPP-13：不复发的不出候选（没复发就没有"没治好"这件事）', () => {
  assert.deepEqual(mine({ items: [attrItem({ recurring: false })] }), [])
})

test('OPP-13：没有可指认的再现事件 ⇒ fail-closed 不出（不猜）', () => {
  assert.deepEqual(mine({ items: [attrItem({ origin: [] })] }), [])
})

test('OPP-13：未注入归因 ⇒ 不出候选（纯函数不读盘）', () => {
  assert.deepEqual(mineCandidates([], { now: '2026-10-27T00:00:00.000Z' }), [])
})

test('OPP-13：证据取再现事件的会话与序号（ref = sessionId#seq）', () => {
  const [c] = mine({ items: [attrItem()] })
  assert.deepEqual(c.evidence[0], { sessionId: 's1', seq: 3, ts: '2026-10-21T00:00:00.000Z' })
})

test('OPP-13：建议只出"重新诊断/查环境"，不建任何件', () => {
  const a = adviceOf('OPP-13', { recurrences: 2, originCount: 3, immediate: true })
  assert.equal(a.actions.some((x) => String(x.route).startsWith('draft:')), false, '复发时建件是噪音')
  assert.deepEqual(a.actions.map((x) => x.code), ['diagnose-failure', 'check-env'])
  assert.equal(a.hypoth[0].code, 'env-flaky', '48h 内复发更像环境反复')
  assert.equal(adviceOf('OPP-13', { recurrences: 0 }).actions.length, 0, '没数字就不出建议')
  assert.equal(THRESHOLDS['OPP-13'].immediateHours, 48)
})
