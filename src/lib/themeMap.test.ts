// src/lib/themeMap.test.ts
// node --test src/lib/themeMap.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateThemeId, THEME_IDS } from './themeMap.ts'

test('旧值 6 个 → 新 3 值', () => {
  assert.equal(migrateThemeId('yuanfang'), 'dark')
  assert.equal(migrateThemeId('dark'), 'dark')
  assert.equal(migrateThemeId('yuanfang-light'), 'light')
  assert.equal(migrateThemeId('light'), 'light')
  assert.equal(migrateThemeId('glass'), 'dark-glass')
  assert.equal(migrateThemeId('glass-warm'), 'dark-glass')
})
test('已删除主题（浅色玻璃）→ 同明暗的新主题，不落 dark', () => {
  // 老用户磁盘上的设置若是浅色玻璃，迁移必须保持"浅色"语义（只丢磨砂壳），
  // 否则夜间浅色偏好被静默翻成深色 —— 比"少一个主题"严重得多的体验回归
  assert.equal(migrateThemeId('light-glass'), 'light')
})
test('THEME_IDS 收敛为 3 个且包含全部迁移目标', () => {
  assert.deepEqual([...THEME_IDS], ['dark', 'light', 'dark-glass'])
  for (const legacy of ['yuanfang', 'yuanfang-light', 'glass', 'glass-warm', 'light-glass', '??']) {
    assert.ok((THEME_IDS as readonly string[]).includes(migrateThemeId(legacy)),
      `${legacy} 的迁移目标不在 THEME_IDS 内`)
  }
})
test('缺省/垃圾值 → dark', () => {
  assert.equal(migrateThemeId(undefined), 'dark')
  assert.equal(migrateThemeId(''), 'dark')
  assert.equal(migrateThemeId('??'), 'dark')
})
test('新值幂等', () => {
  for (const id of THEME_IDS) assert.equal(migrateThemeId(id), id)
})
