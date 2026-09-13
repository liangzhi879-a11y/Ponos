// src/components/settings/experienceFormat.test.ts —— 设置页格式化纯函数（S2 Task 10）
// node --test src/components/settings/experienceFormat.test.ts（相对导入带 .ts 后缀）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtAge, fmtBytes, normalizeInjectMax } from './experienceFormat.ts'

test('fmtAge：无数据/负数/NaN → —（不许把"没数据"显示成 0 分钟前）', () => {
  assert.equal(fmtAge(null), '—')
  assert.equal(fmtAge(undefined), '—')
  assert.equal(fmtAge(Number.NaN), '—')
  assert.equal(fmtAge(-1), '—')
})

test('fmtAge：分钟/小时/天分档', () => {
  assert.equal(fmtAge(0), '刚刚')
  assert.equal(fmtAge(59_000), '刚刚')
  assert.equal(fmtAge(60_000), '1 分钟前')
  assert.equal(fmtAge(59 * 60_000), '59 分钟前')
  assert.equal(fmtAge(60 * 60_000), '1 小时前')
  assert.equal(fmtAge(25 * 3600_000), '1 天前')
})

test('fmtBytes：B/KB/MB 分档，无数据 → —', () => {
  assert.equal(fmtBytes(null), '—')
  assert.equal(fmtBytes(0), '0 B')
  assert.equal(fmtBytes(2048), '2.0 KB')
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.00 MB')
})

test('normalizeInjectMax：脏值回退 4096（与 server/bridge.mjs 默认值同口径）', () => {
  assert.equal(normalizeInjectMax(8192), 8192)
  assert.equal(normalizeInjectMax('2048'), 2048)
  assert.equal(normalizeInjectMax(0), 4096)
  assert.equal(normalizeInjectMax(-5), 4096)
  assert.equal(normalizeInjectMax(undefined), 4096)
  assert.equal(normalizeInjectMax('abc'), 4096)
})
