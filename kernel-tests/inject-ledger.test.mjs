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

// ── ★ skillCatalogBytes：技能清单字节数进台账（spec §5 S1.4 验收项，2026-09-26 终审修复轮）──
// 落点裁决：**顶层观测字段**，不进 `segments` —— 目录段是 `skill` 段的**子集**，进分段会让
// `totalBytes` 重复计数、破坏 A13 的"字节和 = 实测注入量"，也会破坏 SEGMENT_ORDER 的互斥口径。
test('★ skillCatalogBytes 进台账：顶层字段透传、归一化，且**不进** segments/totalBytes（子集不得重复计数）', () => {
  const rec = summarizeInjection({
    turn: 1, seq: 1,
    segments: [{ id: 'systemPrompt', bytes: 100 }, { id: 'skill', bytes: 900 }, { id: 'injected', bytes: 50 }],
    skillCatalogBytes: 640,
  })
  assert.equal(rec.skillCatalogBytes, 640, '目录段字节必须原样进台账（spec §5 S1.4：技能清单字节数进台账）')
  assert.equal(rec.totalBytes, 1050, 'totalBytes 只数 segments ⇒ 不得把目录段再加一遍（1050 而非 1690）')
  assert.deepEqual(rec.segments.map((s) => s.id), ['systemPrompt', 'skill', 'injected'],
    '不得把目录段塞进 segments（它是 skill 段的子集）')
  // 归一化口径与 segments.bytes 同款：缺失/负值/NaN/非数字一律 0，正数取整
  assert.equal(summarizeInjection({}).skillCatalogBytes, 0, '缺省 ⇒ 0（不抛错、不记 undefined）')
  for (const bad of [-5, Number.NaN, Infinity, 'abc', {}, null]) {
    assert.equal(summarizeInjection({ skillCatalogBytes: bad }).skillCatalogBytes, 0, `${String(bad)} ⇒ 0`)
  }
  assert.equal(summarizeInjection({ skillCatalogBytes: '640' }).skillCatalogBytes, 640, '数字字符串按数字处理')
  assert.equal(summarizeInjection({ skillCatalogBytes: 1.9 }).skillCatalogBytes, 1, '取整（与 segments.bytes 同口径）')
})

test('★ 分段口径不得被 skillCatalogBytes 污染：buildSegmentMeters 仍固定 4 段（收到该键也只按 4 段取）', () => {
  const m = buildSegmentMeters({ systemPromptBytes: 1, toolSchemaBytes: 2, skillBytes: 3, injectedBytes: 4, skillCatalogBytes: 999 })
  assert.deepEqual(m.map((x) => x.id), ['systemPrompt', 'toolSchema', 'skill', 'injected'],
    '目录段是顶层观测字段 ⇒ SEGMENT_ORDER 仍 4 段（加第 5 段会让 totalBytes 重复计数并破坏互斥口径）')
  assert.equal(m.reduce((a, x) => a + x.bytes, 0), 10, '四段之和恰为 static 渠道字节；skillCatalogBytes 不得被加进来')
})

// ── ★ toolListLineBytes / toolSchemaCount：T0.1 口径修正的留痕字段 ──────────────
// **口径修正**（不是放宽断言）：`toolSchema` **段**自 T0.1 起计 `tools[]` 真实 schema 字节
// （实测 ≈31 KB/请求；此前只记 system 文本里「可用工具：…」那一行 ≈237 B ⇒ 少记 99%）。
// 那行旧读数与新段**不是子集关系**（一个在 system 文本里、一个在 `tools[]` 面），
// 故另立两个**顶层观测字段**留痕，不进 `segments`（进了会把两个不同的数混成一个）。
test('★ T0.1 口径修正：toolListLineBytes/toolSchemaCount 为顶层字段，不进 segments/totalBytes', () => {
  const rec = summarizeInjection({
    turn: 1, seq: 1,
    segments: [{ id: 'systemPrompt', bytes: 100 }, { id: 'toolSchema', bytes: 31_116 }],
    toolListLineBytes: 237,
    toolSchemaCount: 23,
  })
  assert.equal(rec.toolListLineBytes, 237, '「可用工具：…」那行的字节必须留痕（旧口径可追溯）')
  assert.equal(rec.toolSchemaCount, 23, '本轮发出的 schema 条数必须进台账')
  assert.equal(rec.totalBytes, 31_216, 'totalBytes 只数 segments ⇒ toolSchema 段已是真实工具面（31,116 B）')
  assert.deepEqual(rec.segments.map((s) => s.id), ['systemPrompt', 'toolSchema'], '两个新字段不得塞进 segments')
  // 归一化与 segments.bytes 同款
  const empty = summarizeInjection({})
  assert.equal(empty.toolListLineBytes, 0, '缺省 ⇒ 0（不抛错、不记 undefined）')
  assert.equal(empty.toolSchemaCount, 0)
  for (const bad of [-5, Number.NaN, Infinity, 'abc', {}, null]) {
    assert.equal(summarizeInjection({ toolListLineBytes: bad, toolSchemaCount: bad }).toolListLineBytes, 0)
    assert.equal(summarizeInjection({ toolListLineBytes: bad, toolSchemaCount: bad }).toolSchemaCount, 0)
  }
  assert.equal(summarizeInjection({ toolListLineBytes: '237', toolSchemaCount: '23' }).toolListLineBytes, 237)
  assert.equal(summarizeInjection({ toolListLineBytes: '237', toolSchemaCount: '23' }).toolSchemaCount, 23)
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
