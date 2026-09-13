// src/lib/compactIndicator.test.ts —— 压缩指示条兜底判定单测（2026-09-13 常驻事故收口）
// 运行：node --test src/lib/compactIndicator.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 也随 npm test 一起跑（package.json 的 glob 含 src/**/*.test.ts）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPACT_INDICATOR_MAX_MS, staleCompactionSids } from './compactIndicator.ts'

const BOUND = 60_000

test('无任何压缩会话 → 不返回任何 id', () => {
  assert.deepEqual(staleCompactionSids({}, {}, 1_000_000, BOUND), [])
})

test('未在压缩（false/缺省）的会话一律不管，哪怕 since 陈旧', () => {
  const compacting = { a: false, b: undefined }
  const since = { a: 0, b: 1 }
  assert.deepEqual(staleCompactionSids(compacting, since, 1_000_000, BOUND), [])
})

test('新鲜压缩（未到上限）不误清', () => {
  const now = 1_000_000
  const compacting = { a: true }
  const since = { a: now - (BOUND - 1) }
  assert.deepEqual(staleCompactionSids(compacting, since, now, BOUND), [])
})

test('正好到点仍算新鲜（严格大于才超限）', () => {
  const now = 1_000_000
  assert.deepEqual(staleCompactionSids({ a: true }, { a: now - BOUND }, now, BOUND), [])
})

test('超过上限 → 判为 done 帧丢失（返回该会话）', () => {
  const now = 1_000_000
  assert.deepEqual(staleCompactionSids({ a: true }, { a: now - BOUND - 1 }, now, BOUND), ['a'])
})

test('在压缩但缺时间基准 → 立即判超限（没有基准就无法证明新鲜，宁清不留）', () => {
  const now = 1_000_000
  assert.deepEqual(staleCompactionSids({ a: true }, {}, now, BOUND), ['a'])
  assert.deepEqual(staleCompactionSids({ a: true }, { a: NaN }, now, BOUND), ['a'])
  assert.deepEqual(staleCompactionSids({ a: true }, { a: Infinity }, now, BOUND), ['a'])
})

test('多会话互不干扰：只清超限的那些', () => {
  const now = 1_000_000
  const compacting = { stale1: true, fresh: true, off: false, stale2: true }
  const since = {
    stale1: now - BOUND * 3,
    fresh: now - 1_000,
    off: now - BOUND * 9,
    stale2: now - BOUND * 2,
  }
  assert.deepEqual(staleCompactionSids(compacting, since, now, BOUND), ['stale1', 'stale2'])
})

test('默认上限是 20 分钟（跨树一致性另有 server/compact-indicator-parity.test.mjs 守）', () => {
  assert.equal(COMPACT_INDICATOR_MAX_MS, 20 * 60 * 1000)
})
