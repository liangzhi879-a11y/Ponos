// src/lib/knowledgeBlocks.test.ts
// 运行：node --test src/lib/knowledgeBlocks.test.ts（Node 原生 TS，相对导入必须带 `.ts` 后缀）
//
// 本文件的核心价值：把 S1 §11.4 的**渲染层裁定**变成自动化验收——
// 「含 `- [ ]` 行的任务清单类文档，阅读视图不得出现经验卡片」。
// 该裁定无法在组件层测（仓库无 DOM 测试环境），但判定逻辑一旦抽成纯函数就能钉死：
// 只要 planBlockRender 对这些块不产出 entryCard，界面就不可能画卡片。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  clampLevel, isEntryCard, normalizeAnchorText, normalizeTags, pickTargetIndex, pickTargetIndexByBlock,
  planBlockRender, resolveAnchorIndex, splitWikiLinks, wikiTargetCandidates,
  type BlockLike,
} from './knowledgeBlocks.ts'

/** 造 `- [ ] Step N` 形状的块：内核把它判成 entry，但 entryTag 为 null（见 shared/knowledge-core.mjs:39,41-54） */
const checkItem = (n: number, text: string, line: number): BlockLike =>
  ({ n, kind: 'entry', text, line, tag: null, full: text })

test('S1 裁定：含 `- [ ]` 的复选框行不得渲染成经验卡片', () => {
  // 形状照 kernel splitBlocks 实测输出：每条 `- [ ] Step N` 独立成 entry 块，tag=null，text 只剩摘要
  const blocks: BlockLike[] = [
    { n: 0, kind: 'heading', level: 2, text: '任务清单', line: 1 },
    checkItem(1, 'Step 1 读取台账', 2),
    checkItem(2, 'Step 2 跑 typecheck', 3),
    checkItem(3, 'Step 3 提交', 4),
  ]
  const plan = planBlockRender(blocks)
  assert.equal(plan.filter(r => r.type === 'entryCard').length, 0, 'task list 里一个经验卡片都不能有')
  assert.equal(plan.filter(r => r.type === 'markdown').length, 3, '三条复选框行各按普通段落渲染')
  assert.deepEqual(plan.map(r => r.type), ['heading', 'markdown', 'markdown', 'markdown'])
  // 行号锚点必须保留（跳转定位依赖它）
  assert.deepEqual(plan.map(r => r.line), [1, 2, 3, 4])
})

test('isEntryCard：只有 kind=entry 且 tag 为非空字符串才成立', () => {
  assert.equal(isEntryCard({ kind: 'entry', text: 's', line: 1, tag: '经验' }), true)
  assert.equal(isEntryCard({ kind: 'entry', text: 's', line: 1, tag: ' 经验 ' }), true, '两侧空白不影响判定')
  assert.equal(isEntryCard({ kind: 'entry', text: 's', line: 1, tag: null }), false, 'null → 非卡片（硬约束）')
  assert.equal(isEntryCard({ kind: 'entry', text: 's', line: 1 }), false, '字段缺失 → 非卡片')
  assert.equal(isEntryCard({ kind: 'entry', text: 's', line: 1, tag: '   ' }), false, '纯空白 → 非卡片')
  assert.equal(isEntryCard({ kind: 'para', text: 's', line: 1, tag: '经验' }), false, 'kind 不是 entry → 非卡片')
})

test('planBlockRender：带 tag 的条目 → entryCard（tag 去空白、full 缺省回落 summary）', () => {
  const plan = planBlockRender([
    { n: 0, kind: 'entry', text: ' 企微 CLI 化能省掉 4 个 tab ', line: 7, tag: ' 企微 ', full: ' 完整做法：… ' },
    { n: 1, kind: 'entry', text: '只有摘要', line: 9, tag: '经验', full: null },
  ])
  assert.equal(plan.length, 2)
  assert.deepEqual(plan[0], {
    type: 'entryCard', key: 'b0', line: 7, tag: '企微',
    summary: '企微 CLI 化能省掉 4 个 tab', full: '完整做法：…',
  })
  assert.deepEqual(plan[1], {
    type: 'entryCard', key: 'b1', line: 9, tag: '经验', summary: '只有摘要', full: '只有摘要',
  }, 'full 为空时回落 summary（卡片展开钮据此隐藏，见 KnowledgeEntryCard）')
})

test('planBlockRender：heading 归一 level，其余块按 markdown 原样透传', () => {
  const plan = planBlockRender([
    { n: 0, kind: 'heading', level: 9, text: '## 越界级别', line: 3 },
    { n: 1, kind: 'code', text: '```js\nconst a = 1\n```', line: 5 },
    { n: 2, kind: 'table', text: '| a | b |\n| - | - |', line: 9 },
    { n: 3, kind: 'list', text: '- a\n- b', line: 12 },
    { n: 4, kind: 'para', text: '正文', line: 15 },
  ])
  assert.deepEqual(plan.map(r => r.type), ['heading', 'markdown', 'markdown', 'markdown', 'markdown'])
  assert.deepEqual(plan[0], { type: 'heading', key: 'b0', line: 3, level: 6, text: '## 越界级别' },
    'level 上限 6（md 只有 6 级）；text 是内核给的纯文本，不再带 `#`')
  assert.equal(plan[1].type === 'markdown' && plan[1].text.includes('```js'), true, '代码块连围栏一起透传，react-markdown 才能高亮')
})

test('planBlockRender：空文本块被丢弃，key 用块序号（缺 n 时用下标兜底）', () => {
  const plan = planBlockRender([
    { n: 0, kind: 'para', text: '   ', line: 1 },
    { kind: 'para', text: '有内容', line: 2 },
  ])
  assert.equal(plan.length, 1, '空白块不产出（否则留一个吃间距的空 div）')
  assert.equal(plan[0].key, 'b1', '缺 n 时用下标兜底，key 仍唯一')
})

test('clampLevel：非法级别一律回落到 1', () => {
  assert.equal(clampLevel(3), 3)
  assert.equal(clampLevel(6), 6)
  assert.equal(clampLevel(7), 6)
  assert.equal(clampLevel(0), 1)
  assert.equal(clampLevel(-2), 1)
  assert.equal(clampLevel(Number.NaN), 1)
  assert.equal(clampLevel(undefined), 1)
  assert.equal(clampLevel(2.9), 2)
})

test('pickTargetIndex：目标行落在块内部/边界/范围外都有确定落点', () => {
  const plan = planBlockRender([
    { n: 0, kind: 'heading', level: 1, text: '标题', line: 1 },
    { n: 1, kind: 'para', text: '段落', line: 4 },
    { n: 2, kind: 'para', text: '末段', line: 20 },
  ])
  assert.equal(pickTargetIndex(plan, 4), 1, '精确命中')
  assert.equal(pickTargetIndex(plan, 6), 1, '落在块内部（4..19）→ 该块')
  assert.equal(pickTargetIndex(plan, 1), 0)
  assert.equal(pickTargetIndex(plan, 99), 2, '超出末块 → 末块（跳到最后而不是不动）')
  assert.equal(pickTargetIndex(plan, 0), null, '0 不是合法行号（内核行号从 1 起）→ 不跳转')
  assert.equal(pickTargetIndex(plan, -3), null)
  assert.equal(pickTargetIndex(plan, Number.NaN), null)
  assert.equal(pickTargetIndex(plan, null), null)
  assert.equal(pickTargetIndex(plan, undefined), null)
  assert.equal(pickTargetIndex([], 3), null, '空计划 → null（不能返回 0 让调用方取到 undefined）')
})

test('pickTargetIndex：targetLine 早于首块 → 0（frontmatter 区命中也要给出落点）', () => {
  const plan = planBlockRender([{ n: 0, kind: 'para', text: '正文', line: 8 }])
  assert.equal(pickTargetIndex(plan, 3), 0)
})

test('normalizeTags：trim、去空、去重、忽略非字符串', () => {
  assert.deepEqual(normalizeTags([' 经验 ', '经验', '', '   ', 'workflow', 42, null, 'workflow']),
    ['经验', 'workflow'])
  assert.deepEqual(normalizeTags(undefined), [])
  assert.deepEqual(normalizeTags(null), [])
})

// —— S5 Task 9：块级定位（关联锚点跳转）——

test('planBlockRender(docId)：条目渲染项带 blockId（`<docId>#<n>`），不给 docId 时一个键都不多', () => {
  const blocks = [
    { n: 0, kind: 'entry', text: '摘要', line: 7, tag: '经验', full: '全文' },
    { n: 5, kind: 'entry', text: '摘要二', line: 9, tag: '经验', full: null },
  ]
  const withId = planBlockRender(blocks, 'notes/a.md')
  assert.equal((withId[0] as { blockId?: string }).blockId, 'notes/a.md#0')
  assert.equal((withId[1] as { blockId?: string }).blockId, 'notes/a.md#5', '序号取块的 n，不是数组下标')

  // 缺省（S2 既有调用方）不得多出 blockId 键：deepEqual 的既有断言据此保持逐字可比
  assert.deepEqual(planBlockRender(blocks), [
    { type: 'entryCard', key: 'b0', line: 7, tag: '经验', summary: '摘要', full: '全文' },
    { type: 'entryCard', key: 'b5', line: 9, tag: '经验', summary: '摘要二', full: '摘要二' },
  ])
  // 缺 n 的脏数据：blockId 用下标兜底（与 key 的兜底同源，否则锚点永远匹配不上）
  const noN = planBlockRender([{ kind: 'entry', text: 'x', line: 1, tag: '经验' }], 'notes/a.md')
  assert.equal((noN[0] as { blockId?: string }).blockId, 'notes/a.md#0')
})

test('pickTargetIndexByBlock：命中块 id → 下标；未给/不在本篇 → null（绝不回落别处）', () => {
  const plan = planBlockRender([
    { n: 0, kind: 'heading', text: '标题', line: 1, level: 1 },
    { n: 1, kind: 'entry', text: '摘要', line: 3, tag: '经验', full: null },
    { n: 2, kind: 'para', text: '正文', line: 5 },
  ], 'notes/a.md')
  assert.equal(pickTargetIndexByBlock(plan, 'notes/a.md#1'), 1)
  assert.equal(pickTargetIndexByBlock(plan, 'notes/a.md#2'), null, '锚点只会指向条目块；指向非条目块 → 不定位')
  assert.equal(pickTargetIndexByBlock(plan, 'notes/b.md#1'), null, '别的文档的块 id 不属于本篇')
  assert.equal(pickTargetIndexByBlock(plan, null), null)
  assert.equal(pickTargetIndexByBlock([], 'notes/a.md#1'), null)
})

// ── 2026-09-14 对标 Obsidian 批次 1：`[[wiki 链接]]` 切分与目标候选 ──────────

test('splitWikiLinks：普通文本 / 单独链接 / 别名 / 混排顺序', () => {
  assert.deepEqual(splitWikiLinks('没有链接'), [{ type: 'text', text: '没有链接' }])
  const one = splitWikiLinks('看 [[目标]] 这里')
  assert.deepEqual(one.map(c => c.type), ['text', 'wiki', 'text'])
  assert.equal(one[1].target, '目标')
  assert.equal(one[1].label, '目标')
  assert.equal(one[0].text, '看 ')
  assert.equal(one[2].text, ' 这里')

  const alias = splitWikiLinks('[[目标|显示名]]')
  assert.equal(alias.length, 1)
  assert.equal(alias[0].target, '目标', '别名只影响显示，不影响解析目标')
  assert.equal(alias[0].label, '显示名')
})

test('splitWikiLinks：行内代码 / 空目标 / 多链接边界', () => {
  // 行内代码里的 `[[x]]` 是在讲语法，不是链接
  assert.deepEqual(splitWikiLinks('用 `[[目标]]` 表示链接'), [{ type: 'text', text: '用 `[[目标]]` 表示链接' }])
  // 空目标不是链接（渲染出来会点了没反应）
  assert.deepEqual(splitWikiLinks('[[]]'), [{ type: 'text', text: '[[]]' }])
  assert.deepEqual(splitWikiLinks('[[ ]]').map(c => c.type), ['text'])
  // 同一段里多个链接：顺序与下标不能错位
  const two = splitWikiLinks('[[a]] 与 [[b|别名]]')
  assert.deepEqual(two.filter(c => c.type === 'wiki').map(c => c.target), ['a', 'b'])
  assert.equal(two.filter(c => c.type === 'wiki')[1].label, '别名')
  // 未闭合的 `[[` 保持原文
  assert.deepEqual(splitWikiLinks('[[未闭合').map(c => c.type), ['text'])
})

test('wikiTargetCandidates：与内核 resolveLinkTarget 同序的候选表', () => {
  // 同目录文档：原样 → 加 .md
  assert.deepEqual(wikiTargetCandidates('笔记', 'a/b.md'), ['笔记', '笔记.md', 'a/笔记', 'a/笔记.md'])
  // 已是 .md 不重复加后缀
  assert.deepEqual(wikiTargetCandidates('笔记.md', 'a/b.md'), ['笔记.md', 'a/笔记.md'])
  // `./` 前缀剔除；根级文档没有目录前缀
  assert.deepEqual(wikiTargetCandidates('./笔记', 'top.md'), ['笔记', '笔记.md'])
  assert.deepEqual(wikiTargetCandidates('', 'a.md'), [])
})

// ── 2026-09-14 批次 2：引用体系（锚点 / 嵌入 / 同文档锚点 / 锚点归一）──────────

test('splitWikiLinks：`![[嵌入]]` 与 `[[引用]]` 必须可区分，且锚点/别名拆分顺序正确', () => {
  const [embed] = splitWikiLinks('![[snippet]]')
  assert.equal(embed.embed, true, '`![[x]]` 是嵌入')

  const [quote] = splitWikiLinks('[[snippet]]')
  assert.equal(quote.embed, false, '`[[x]]` 是引用')

  const [anchored] = splitWikiLinks('[[guide#安装步骤]]')
  assert.equal(anchored.target, 'guide')
  assert.equal(anchored.anchorRef, '安装步骤')
  assert.equal(anchored.anchorKind, 'heading')
  assert.equal(anchored.label, '安装步骤', '无别名时显示锚点文本（Obsidian 口径）')

  // 拆分顺序：先 `|` 分别名，再在目标段拆 `#锚点`。反过来会把锚点吃进别名。
  const [both] = splitWikiLinks('[[guide#安装步骤|看这里]]')
  assert.equal(both.target, 'guide')
  assert.equal(both.anchorRef, '安装步骤')
  assert.equal(both.label, '看这里')

  // 块锚点：`^` 是语法标记，不属于 ID
  const [blockRef] = splitWikiLinks('[[guide#^abc123]]')
  assert.equal(blockRef.anchorRef, 'abc123')
  assert.equal(blockRef.anchorKind, 'block')

  // 同文档锚点：目标是空串，但**不能**按"空目标"丢弃（旧实现在这里把整条引用丢了）
  const [selfRef] = splitWikiLinks('[[#本地小节]]')
  assert.equal(selfRef.self, true)
  assert.equal(selfRef.target, '')
  assert.equal(selfRef.anchorRef, '本地小节')
  assert.equal(selfRef.label, '本地小节')

  // 嵌入 + 锚点 + 别名同时出现
  const [full] = splitWikiLinks('![[guide#^b1|别名]]')
  assert.equal(full.embed, true)
  assert.equal(full.anchorKind, 'block')
  assert.equal(full.label, '别名')
})

test('splitWikiLinks：空目标仍被拒绝（`[[ ]]` / `[[|x]]`），避免渲染不可点控件', () => {
  assert.deepEqual(splitWikiLinks('[[]]').map(c => c.type), ['text'])
  assert.deepEqual(splitWikiLinks('[[|只有别名]]').map(c => c.type), ['text'])
  // `#` 后为空（`[[a#]]`）→ 合法引用，只是没有锚点
  const [bare] = splitWikiLinks('[[a#]]')
  assert.equal(bare.target, 'a')
  assert.equal(bare.anchorRef, '')
})

test('normalizeAnchorText：大小写 / 空白 / `-` / 前导 `#` 等价（锚点匹配的前提）', () => {
  assert.equal(normalizeAnchorText('安装步骤'), '安装步骤')
  assert.equal(normalizeAnchorText('  安装 步骤 '), '安装 步骤')
  assert.equal(normalizeAnchorText('安装 - 步骤'), '安装-步骤')
  assert.equal(normalizeAnchorText('安装-步骤'), '安装-步骤')
  assert.equal(normalizeAnchorText('## 安装步骤'), '安装步骤')
  assert.equal(normalizeAnchorText('API Reference'), normalizeAnchorText('api reference'))
})

test('resolveAnchorIndex：标题锚点（含归一化匹配）/ 块 ID / 解析不到返回 null', () => {
  const blocks = [
    { kind: 'heading', level: 1, text: '指南', line: 1 },
    { kind: 'para', text: '正文', line: 3 },
    { kind: 'heading', level: 2, text: '安装步骤', line: 5 },
    { kind: 'para', text: '第一步。', line: 7 },
    { kind: 'para', text: '这段有块 ID ^abc123', line: 9 },
  ] as BlockLike[]
  assert.equal(resolveAnchorIndex(blocks, '安装步骤'), 2)
  assert.equal(resolveAnchorIndex(blocks, '## 安装步骤'), 2, '前导 # 要容忍')
  assert.equal(resolveAnchorIndex(blocks, '安装步骤'), 2)
  assert.equal(resolveAnchorIndex(blocks, '不存在的节'), null, '解析不到必须返回 null（不要悄悄跳文档开头）')
  assert.equal(resolveAnchorIndex(blocks, 'abc123', 'block'), 4)
  assert.equal(resolveAnchorIndex(blocks, 'abc', 'block'), null, '块 ID 不匹配前缀（^abc ≠ ^abc123）')
  assert.equal(resolveAnchorIndex(blocks, ''), null)
})
