import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, reduceSettings } from './state.ts'

test('reduceSettings 归并 settings key 的 changed 事件，忽略其他 key', () => {
  let s = DEFAULT_SETTINGS
  s = reduceSettings(s, { key: 'settings', value: { theme: 'dark' }, version: 1 })
  assert.equal(s.theme, 'dark')
  s = reduceSettings(s, { key: 'other', value: 1 })
  assert.equal(s.theme, 'dark', '非 settings key 应忽略')
  assert.equal(reduceSettings(DEFAULT_SETTINGS, { key: 'settings' }).theme, 'vaporwave', '缺 value 时保持默认')
})
