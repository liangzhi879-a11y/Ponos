// EL1 线索层（S4.5④）：R1–R6 六条渲染契约 + 边界
// ---------------------------------------------------------------------------
// 目的（注入 spec §3.2.1）：经验/知识供给从"预装全文"改为"只发索引线索"——
// agent 自主决定读不读、读哪条。R1–R6 就是这份渲染契约，逐条对应一个用例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRecommendSection, renderRecommendLine, shouldInjectEl1, HYDRATE_EL1_MAX_BYTES, EL1_SNIPPET_MAX,
} from '../kernel/knowledge-recommend.mjs'

const item = (over = {}) => ({
  blockId: 'experience/workflow.md#1',
  space: 'experience',
  title: '注入总线',
  snippet: '把散在 12 处的注入收敛到一条总线',
  related: [],
  ...over,
})

test('R1：永不升级全文（upgraded 恒 false，输入含 full 也不得进入输出）', () => {
  const r = buildRecommendSection([item({ full: '整篇正文……' })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.upgraded, false)
  assert.ok(!r.text.includes('整篇正文'), 'R1：不得注入正文')
  // ★ 有效断言：即使输入带 full 且预算充足，输出长度也不得因正文而膨胀
  const withoutFull = buildRecommendSection([item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.bytes, withoutFull.bytes, 'R1：带上 full 输入不得改变注入字节数（否则等于注正文）')
})

test('R2：无线索凭据（blockId）的行不渲染', () => {
  const r = buildRecommendSection([item({ blockId: '' }), item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.lines.length, 1, '仅含 blockId 的那条渲染')
})

test('R2：blockId 形状非法（非 <docId>#<数字>）也不渲染 —— 走 isBlockId 既有校验', () => {
  const bad = ['没有井号', '#1', 'a#', 'a#x', '']
  const r = buildRecommendSection(bad.map((b) => item({ blockId: b })), { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.lines.length, 0, '形状非法者一律不渲染（否则模型拿着展开不了的 id 白跑一轮）')
})

test('R3：摘要走 makeSnippet，且不超过 EL1_SNIPPET_MAX(300)', () => {
  assert.equal(EL1_SNIPPET_MAX, 300)
  const long = 'x'.repeat(2000)
  const r = buildRecommendSection([item({ snippet: long })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  const lineLen = r.lines[0].snippet.length
  assert.ok(lineLen <= EL1_SNIPPET_MAX, `摘要应 ≤300，实际 ${lineLen}`)
})

test('R3：默认摘要上限是 160（仅线索层放宽至 300），与 makeSnippet 同源', () => {
  // 160 < len ≤ 300 的摘要：线索层**不截**（放宽生效），但压平空白与省略号仍走 makeSnippet
  const text = 'y'.repeat(200)
  const r = buildRecommendSection([item({ snippet: text })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.lines[0].snippet.length, 200, '200 ≤ 300 ⇒ 不截断')
  const flat = buildRecommendSection([item({ snippet: 'a\n\nb   c' })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(flat.lines[0].snippet, 'a b c', '换行/连续空白压平（makeSnippet 既有行为）')
})

test('R4：一跳锚点 ≤3 且剔除 duplicate', () => {
  const related = [
    { blockId: 'a#1', why: { kind: 'same-space' } },
    { blockId: 'b#2', why: { kind: 'duplicate' } },
    { blockId: 'c#3', why: { kind: 'keyword' } },
    { blockId: 'd#4', why: { kind: 'keyword' } },
    { blockId: 'e#5', why: { kind: 'keyword' } },
  ]
  const r = buildRecommendSection([item({ related })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.lines[0].related.length, 3, 'R4：最多 3 个锚点')
  assert.ok(!r.lines[0].related.some((x) => x.blockId === 'b#2'), 'R4：必须剔除 duplicate')
})

test('R4：锚点按 why.kind 打理由，标签口径与既有 anchorTextOf 一致', () => {
  const r = buildRecommendSection([item({
    related: [
      { blockId: 'a#1', why: { kind: 'tag', tag: '四表' } },
      { blockId: 'c#3', why: { kind: 'content' }, score: 0.812 },
    ],
  })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  const labels = r.lines[0].related.map((x) => x.label)
  assert.deepEqual(labels, ['同标签:四表', '内容相似0.81'], '不得另造一套理由措辞')
})

test('R5：未授权空间只给 related / mode:full 的替代路径，且不得指向 Read', () => {
  const r = buildRecommendSection(
    [item({ space: 'secret', readable: false })],
    { budgetBytes: HYDRATE_EL1_MAX_BYTES, readableSpaces: [] },
  )
  assert.ok(r.lines[0].hint.includes("mode:'full'"), 'R5：须写明 mode:full 替代路径')
  assert.ok(r.lines[0].hint.includes('related'), 'R5：须写明 related 替代路径')
  assert.ok(!r.lines[0].hint.includes('Read'), 'R5：无权限时不得指向 Read（会失败）')
})

test('R5：三态 —— readableSpaces 为 Set 时据实分支（授权空间给展开指引，不给权限告警）', () => {
  const ok = buildRecommendSection([item({ related: [{ blockId: 'a#1', why: { kind: 'keyword' } }] })],
    { budgetBytes: HYDRATE_EL1_MAX_BYTES, readableSpaces: new Set(['experience']) })
  assert.ok(!ok.lines[0].hint.includes('无'), '授权空间不得出现"无读取权限"告警')
  assert.ok(ok.lines[0].hint.includes('展开'), '授权空间应给展开动作')

  const no = buildRecommendSection([item()],
    { budgetBytes: HYDRATE_EL1_MAX_BYTES, readableSpaces: new Set(['other']) })
  assert.ok(no.lines[0].hint.includes("mode:'full'"), '不在放行集里 ⇒ 给替代路径')
})

test('R5：readableSpaces === null（调用方未给可读性）⇒ 不加权限告警（零回归口径）', () => {
  const r = buildRecommendSection([item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES, readableSpaces: null })
  assert.ok(!r.lines[0].hint.includes('权限'), '未给可读性信息时不得凭空告警')
})

test('R6：预算按字节记账，装不下丢弃整行（不截断行内正文）', () => {
  const many = Array.from({ length: 20 }, (_, i) => item({ blockId: `s#${i}`, title: `标题${i}` }))
  const r = buildRecommendSection(many, { budgetBytes: 200 })
  assert.ok(r.bytes <= 200, `字节数不得超预算，实际 ${r.bytes}`)
  assert.ok(r.lines.length >= 1, '至少首条（首条无条件放入）')
  assert.ok(r.lines.length < 20, `预算不足 ⇒ 必须丢行，实际装入 ${r.lines.length}`)
  assert.ok(r.dropped > 0, '应记录被丢弃的行数')
  // ★ 不得截断行内正文：装入的每行 text 必须与渲染结果逐字相等（未被切短）
  for (const line of r.lines) {
    assert.equal(line.text, renderRecommendLine(many.find((x) => x.blockId === line.blockId), {}).text,
      '装入的行不得被截断')
  }
})

test('R6：预算小到只装得下首条时，只剩首条（首条无条件放入）', () => {
  const many = Array.from({ length: 20 }, (_, i) => item({ blockId: `s#${i}`, title: `标题${i}` }))
  const one = buildRecommendSection([many[0]], { budgetBytes: 1 }).bytes          // 实测单行字节
  const r = buildRecommendSection(many, { budgetBytes: one })                     // 只够一条
  assert.equal(r.lines.length, 1, `预算=${one} 时只剩首条，实际 ${r.lines.length}`)
})

test('R6：首条即使超预算也放入（无条件）', () => {
  const huge = item({ title: 'x'.repeat(500), snippet: 'y'.repeat(300) })
  const r = buildRecommendSection([huge], { budgetBytes: 10 })
  assert.equal(r.lines.length, 1)
})

test('related 为空时不渲染展开指引（降级）', () => {
  const r = buildRecommendSection([item({ related: [] })], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.ok(!r.text.includes('展开'), '无锚点则不给展开动作')
})

test('offered 返回 blockId 列表（供观察期采纳率统计）', () => {
  const r = buildRecommendSection([item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.deepEqual(r.offered, ['experience/workflow.md#1'])
})

test('空输入返回空段（不抛错）', () => {
  const r = buildRecommendSection([], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.text, '')
  assert.equal(r.lines.length, 0)
  assert.equal(r.bytes, 0)
})

test('非法输入不抛错（null/字符串项混入 ⇒ 跳过）', () => {
  const r = buildRecommendSection([null, 'x', item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(r.lines.length, 1)
})

// ── Task 8：S4.5⑤⑥ 接线判据（A18 前置 / A20 互斥 / 逃生阀 / 观察期分名）──────────

test('A20：strategy=legacy 时 EL1 生效；unified 时关闭（互斥）', () => {
  assert.equal(shouldInjectEl1({ strategy: 'legacy', relateMode: 'on', enabled: true }), true)
  assert.equal(shouldInjectEl1({ strategy: 'unified', relateMode: 'on', enabled: true }), false)
})

test('A18：前置 knowledgeRelateMode === on（off 时不注入）', () => {
  assert.equal(shouldInjectEl1({ strategy: 'legacy', relateMode: 'off', enabled: true }), false)
})

test('逃生阀：PONOS_MEMORY_EL1=0 时关闭（与 PONOS_MEMORY_INJECT 不耦合）', () => {
  assert.equal(shouldInjectEl1({ strategy: 'legacy', relateMode: 'on', enabled: false }), false)
})

test('观察期：dryRun 下 offered 有值但 text 为空（offeredDryRun 语义）', () => {
  const r = buildRecommendSection([item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES, dryRun: true })
  assert.equal(r.dryRun, true)
  assert.deepEqual(r.offered, ['experience/workflow.md#1'], '观察期也要登记推荐集合（否则无从评估）')
  assert.equal(r.text, '', 'dryRun 不产生可注入文本')
  assert.ok(r.bytes > 0, '字节仍要记账（面板要显示"若不注入会花多少"）')
})

test('★ offered 与 offeredDryRun 分名：转正后 dryRun=false（混用会污染采纳率口径）', () => {
  const on = buildRecommendSection([item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES })
  assert.equal(on.dryRun, false)
  assert.ok(on.text.length > 0)
})

test('A19：观察期 adopted 语义为"不适用"(null) —— 不得记 0（记 0 会被算成"未被采纳"）', () => {
  // adopted/adoptRate 由调用方（cli）在登记时填；本层只提供 observed 集合口径。
  const r = buildRecommendSection([item()], { budgetBytes: HYDRATE_EL1_MAX_BYTES, dryRun: true })
  assert.ok(!('adopted' in r), '本层不伪造 adopted —— 观察期该字段由登记方显式写 null')
  assert.equal(r.dryRun, true)
})

test('dryRun 下 R1–R6 仍全部生效（观察期不得绕过契约）', () => {
  const r = buildRecommendSection(
    [item({ blockId: '', full: 'x'.repeat(50) }), item({ related: [{ blockId: 'a#1', why: { kind: 'duplicate' } }] })],
    { budgetBytes: 1, dryRun: true },   // 极小预算：R6 首条无条件放入
  )
  assert.equal(r.lines.length, 1, 'R2：非法 blockId 的行仍不渲染')
  assert.equal(r.lines[0].related.length, 0, 'R4：duplicate 仍被剔除')
  assert.equal(r.upgraded, false)
})
