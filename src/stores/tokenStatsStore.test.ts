import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyStats, addUsage, toDayKey, backfillConversation, useTokenStatsStore } from './tokenStatsStore.ts'

test('createEmptyStats 全零', () => {
  const s = createEmptyStats()
  assert.equal(s.totalInput, 0); assert.equal(s.totalOutput, 0)
  assert.deepEqual(s.byDay, {}); assert.deepEqual(s.byConversation, {}); assert.deepEqual(s.byModel, {})
})

test('addUsage 四维累加', () => {
  let s = createEmptyStats()
  s = addUsage(s, { input: 100, output: 50 }, { day: '2026-08-31', conversationId: 'c1', model: 'deepseek-v4-pro' })
  s = addUsage(s, { input: 10, output: 5 }, { day: '2026-08-31', conversationId: 'c1', model: 'deepseek-v4-pro' })
  s = addUsage(s, { input: 1, output: 1 }, { day: '2026-08-30', conversationId: 'c2', model: 'minimax' })
  assert.equal(s.totalInput, 111); assert.equal(s.totalOutput, 56)
  assert.deepEqual(s.byDay['2026-08-31'], { input: 110, output: 55 })
  assert.deepEqual(s.byConversation['c1'], { input: 110, output: 55 })
  assert.deepEqual(s.byModel['deepseek-v4-pro'], { input: 110, output: 55 })
})

test('toDayKey 本地时区 YYYY-MM-DD', () => {
  const d = new Date(2026, 7, 31, 12, 0, 0)  // 2026-08-31 本地
  assert.equal(toDayKey(d.getTime()), '2026-08-31')
})

test('backfillConversation 解析原始 transcript usage 并累加', async () => {
  const entries = [
    { type: 'assistant', timestamp: Date.now(), usage: { input_tokens: 200, output_tokens: 80 }, model: 'deepseek-v4-pro' },
    { type: 'assistant', timestamp: Date.now(), usage: { input_tokens: 50, output_tokens: 20 } },  // 无 model → byModel 跳过
    { type: 'user', timestamp: Date.now() },  // 非 assistant 跳过
  ]
  // mock bridge /transcript/load
  const mockFetch = async (url: string) => {
    assert.ok(String(url).includes('/transcript/load'))
    return { ok: true, json: async () => ({ ok: true, entries }) } as Response
  }
  globalThis.fetch = mockFetch as typeof fetch
  let s = createEmptyStats()
  const r = await backfillConversation(s, 'C:/proj', 'sess-1', 'c1', 'http://mock')
  s = r.stats
  assert.equal(s.totalInput, 250); assert.equal(s.totalOutput, 100)
  assert.deepEqual(s.byModel['deepseek-v4-pro'], { input: 200, output: 80 })
  // 成功加载 transcript → ok 必须为 true
  assert.equal(r.ok, true)
})

test('refreshFromServer 映射 /transcript/stats 到 stats', async () => {
  const serverResp = {
    ok: true,
    totals: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    byDate: { '2026-08-30': { input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    byModel: { 'deepseek-v4-pro': { input_tokens: 700, output_tokens: 300, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
  }
  const mockFetch = async (url: string) => {
    assert.ok(String(url).includes('/transcript/stats'))
    return { ok: true, json: async () => serverResp } as Response
  }
  globalThis.fetch = mockFetch as typeof fetch
  const store = useTokenStatsStore
  store.setState({ stats: createEmptyStats(), lastError: null })
  const ok = await store.getState().refreshFromServer('http://mock')
  assert.equal(ok, true)
  const s = store.getState().stats
  assert.equal(s.totalInput, 1000)
  assert.equal(s.totalOutput, 400)
  assert.deepEqual(s.byDay['2026-08-30'], { input: 300, output: 100 })
  assert.deepEqual(s.byModel['deepseek-v4-pro'], { input: 700, output: 300 })
})

test('refreshFromServer 失败置 lastError 且保留旧 stats', async () => {
  globalThis.fetch = (async () => {
    throw new Error('bridge down')
  }) as typeof fetch
  const store = useTokenStatsStore
  store.setState({ stats: createEmptyStats(), lastError: null })
  const ok = await store.getState().refreshFromServer('http://mock')
  assert.equal(ok, false)
  assert.equal(store.getState().lastError, 'bridge down')
})
