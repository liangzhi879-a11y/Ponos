// 注入总账（S1+ / O4）单测
// 契约（plan 批1 Task 2）：
//   · 渠道五分 CHANNELS = static/bridge/guard/derived/payload（**注入渠道**维度）
//   · 来源七分 BY_SOURCE
//   · buildSegmentMeters 固定段序、只取长度、缺失按 0
//   · summarizeInjection 渠道缺失为 null（区分"未走"与"0 命中"），但显式 0 必须保留
//   · ledgerTotals 汇总分段/渠道/来源
//   · getInjectStats() **只增不删**（既有字段一个都不能少）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNELS, BY_SOURCE, buildSegmentMeters, summarizeInjection, ledgerTotals,
  nextTurnSeq, resetTurnSeq,
} from '../kernel/inject-ledger.mjs'

// ── 契约常量 ──────────────────────────────────────────────────────────────

test('渠道五分与来源清单为规范值（A13 可归因的前提）', () => {
  assert.deepEqual(CHANNELS, ['static', 'bridge', 'guard', 'derived', 'payload'])
  assert.deepEqual(BY_SOURCE, ['systemPrompt', 'toolSchema', 'skill', 'experience', 'knowledge', 'protocol', 'payload'])
})

// ── buildSegmentMeters ────────────────────────────────────────────────────

test('buildSegmentMeters：固定段序、只取长度、缺失按 0 不抛错', () => {
  assert.deepEqual(
    buildSegmentMeters({ systemPromptBytes: 1200, toolSchemaBytes: 3400, skillBytes: 900, injectedBytes: 150 }),
    [{ id: 'systemPrompt', bytes: 1200 }, { id: 'toolSchema', bytes: 3400 }, { id: 'skill', bytes: 900 }, { id: 'injected', bytes: 150 }],
  )
  assert.deepEqual(buildSegmentMeters({}).map((m) => m.bytes), [0, 0, 0, 0])
  assert.equal(buildSegmentMeters({ systemPromptBytes: '10' })[0].bytes, 10)
})

test('buildSegmentMeters：负值/NaN/小数/未知键都按 0（不造数）', () => {
  const m = buildSegmentMeters({ systemPromptBytes: -5, toolSchemaBytes: NaN, skillBytes: 1.9, injectedBytes: undefined, bonus: 999 })
  assert.deepEqual(m.map((x) => x.bytes), [0, 0, 1, 0], '未知键 bonus 不得被计入任何段')
})

// ── summarizeInjection ────────────────────────────────────────────────────

test('summarizeInjection：五渠道全部就位，缺失渠道为 null（区分未用与 0 命中）', () => {
  const rec = summarizeInjection({ turn: 3, seq: 7, segments: [{ id: 'injected', bytes: 42 }] })
  assert.equal(rec.turn, 3)
  assert.equal(rec.seq, 7)
  assert.equal(rec.totalBytes, 42)
  for (const c of CHANNELS) assert.ok(c in rec.channels, `缺渠道 ${c}`)
  assert.equal(rec.channels.static, null)
})

test('summarizeInjection：渠道计数透传（calls/hits/injectedBytes）', () => {
  const rec = summarizeInjection({
    turn: 1, seq: 1, segments: [{ id: 'injected', bytes: 5 }],
    channels: { guard: { calls: 2, hits: 1, injectedBytes: 300 } },
  })
  assert.deepEqual(rec.channels.guard, { calls: 2, hits: 1, injectedBytes: 300 })
  assert.equal(rec.channels.bridge, null)
})

test('★ 记忆注入关闭时记 0 而非不记（spec :211）', () => {
  const rec = summarizeInjection({ turn: 1, seq: 1, channels: { derived: { calls: 0, hits: 0, injectedBytes: 0 } } })
  assert.deepEqual(rec.channels.derived, { calls: 0, hits: 0, injectedBytes: 0 })
  assert.notEqual(rec.channels.derived, null, '显式 0 必须保留（否则"关闭"与"未走该渠道"无法区分）')
})

test('summarizeInjection：场景三元组齐备（跨场景混算会让 5% 假红）', () => {
  const rec = summarizeInjection({ turn: 1, seq: 1, promptTier: 'full', sessionMode: 'task', kb: 'on' })
  assert.equal(rec.promptTier, 'full')
  assert.equal(rec.sessionMode, 'task')
  assert.equal(rec.kb, 'on')
  const empty = summarizeInjection({})
  assert.equal(empty.promptTier, null)
  assert.equal(empty.sessionMode, null)
  assert.equal(empty.kb, null)
})

test('bySource 归因：来源缺失按 0，存在则透传（七项齐备）', () => {
  const rec = summarizeInjection({ turn: 1, seq: 1, bySource: { experience: 90, knowledge: 10 } })
  assert.equal(rec.bySource.experience, 90)
  assert.equal(rec.bySource.knowledge, 10)
  assert.equal(rec.bySource.guard ?? 0, 0)
  for (const k of BY_SOURCE) assert.equal(typeof rec.bySource[k], 'number', `缺来源 ${k}`)
})

// ── ledgerTotals ──────────────────────────────────────────────────────────

test('ledgerTotals：汇总分段、五渠道与来源', () => {
  const recs = [
    summarizeInjection({ turn: 1, seq: 1, segments: [{ id: 'injected', bytes: 10 }, { id: 'skill', bytes: 5 }], channels: { guard: { calls: 1, hits: 1, injectedBytes: 10 } }, bySource: { experience: 10 } }),
    summarizeInjection({ turn: 2, seq: 2, segments: [{ id: 'injected', bytes: 20 }], channels: { guard: { calls: 1, hits: 0, injectedBytes: 0 } }, bySource: { experience: 20 } }),
  ]
  const t = ledgerTotals(recs)
  assert.equal(t.totalBytes, 35)
  assert.equal(t.bySegment.injected, 30)
  assert.equal(t.bySegment.skill, 5)
  assert.equal(t.byChannel.guard.calls, 2)
  assert.equal(t.byChannel.guard.hits, 1)
  assert.equal(t.bySource.experience, 30)
})

test('ledgerTotals：空输入返回零形状（不抛错）', () => {
  const t = ledgerTotals([])
  assert.equal(t.totalBytes, 0)
  assert.deepEqual(t.bySegment, {})
  assert.deepEqual(t.byChannel, {})
  for (const k of BY_SOURCE) assert.equal(t.bySource[k], 0)
})

// ── 逐轮序号 ──────────────────────────────────────────────────────────────

test('nextTurnSeq：单调递增 + 可重置（判"快照是否连续/丢轮"用）', () => {
  resetTurnSeq()
  assert.equal(nextTurnSeq(), 1)
  assert.equal(nextTurnSeq(), 2)
  assert.equal(nextTurnSeq(), 3)
  resetTurnSeq()
  assert.equal(nextTurnSeq(), 1)
})

// ── 只增不删守护（对既有 getInjectStats）──────────────────────────────────

test('★ getInjectStats 保留既有字段且新增 channels/bySource（只增不删）', async () => {
  const mod = await import('../kernel/knowledge-inject.mjs')
  mod.resetInjectStats?.()
  const now = mod.getInjectStats()
  const fields = Object.keys(now).sort()
  assert.ok(fields.length > 0, '既有返回不得为空')
  // 既有字段（实测基线，逐个列出以防被删改）
  for (const k of ['calls', 'strategy', 'indexLines', 'recallBlocks', 'elapsedMs', 'indexAgeMs', 'degraded', 'queries', 'hitQueries', 'scope', 'spacesDropped', 'spacesCapped', 'hitRate']) {
    assert.ok(k in now, `既有字段被删: ${k}`)
  }
  // 新增
  assert.ok('channels' in now, 'channels 字段应存在')
  assert.ok('bySource' in now, 'bySource 字段应存在')
  for (const c of CHANNELS) assert.ok(c in now.channels, `channels 缺 ${c}`)
  for (const s of BY_SOURCE) assert.ok(s in now.bySource, `bySource 缺 ${s}`)
})
