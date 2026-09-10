// src/lib/themeMap.test.ts
// node --test src/lib/themeMap.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateThemeId, THEME_IDS } from './themeMap.ts'

test('旧值 6 个 → 新 4 值', () => {
  assert.equal(migrateThemeId('yuanfang'), 'dark')
  assert.equal(migrateThemeId('dark'), 'dark')
  assert.equal(migrateThemeId('yuanfang-light'), 'light')
  assert.equal(migrateThemeId('light'), 'light')
  assert.equal(migrateThemeId('glass'), 'dark-glass')
  assert.equal(migrateThemeId('glass-warm'), 'dark-glass')
})
test('缺省/垃圾值 → dark', () => {
  assert.equal(migrateThemeId(undefined), 'dark')
  assert.equal(migrateThemeId(''), 'dark')
  assert.equal(migrateThemeId('??'), 'dark')
})
test('新值幂等', () => {
  for (const id of THEME_IDS) assert.equal(migrateThemeId(id), id)
})
