// src/lib/effortUi.test.ts
// node --test src/lib/effortUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EFFORT_OPTIONS, normalizeEffortUi } from './effortUi.ts'

test('EFFORT_OPTIONS：六档值 + labelKey 顺序与 i18n effort.* 对齐', () => {
  assert.deepEqual(EFFORT_OPTIONS.map(o => o.value), ['auto', 'off', 'low', 'medium', 'high', 'max'])
  assert.deepEqual(EFFORT_OPTIONS.map(o => o.labelKey), [
    'effort.auto', 'effort.off', 'effort.low', 'effort.medium', 'effort.high', 'effort.max',
  ])
})

test('normalizeEffortUi：null / undefined / 非法值 → auto', () => {
  assert.equal(normalizeEffortUi(null), 'auto')
  assert.equal(normalizeEffortUi(undefined), 'auto')
  assert.equal(normalizeEffortUi('bogus'), 'auto')
  assert.equal(normalizeEffortUi(''), 'auto')
})

test('normalizeEffortUi：合法值原样返回', () => {
  assert.equal(normalizeEffortUi('auto'), 'auto')
  assert.equal(normalizeEffortUi('medium'), 'medium')
  assert.equal(normalizeEffortUi('max'), 'max')
  assert.equal(normalizeEffortUi('off'), 'off')
  assert.equal(normalizeEffortUi('low'), 'low')
  assert.equal(normalizeEffortUi('high'), 'high')
})
