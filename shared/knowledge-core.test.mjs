// shared 纯函数测试：块切分 / frontmatter / 经验条目解析。
// 本文件不碰文件系统（shared 层的依赖纪律：只允许 node:path）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashLine, parseFrontmatter, parseEntryLine, splitBlocks, ENTRY_LINE_RE,
  // S5 Task 1 追加：关联锚点纯函数层
  INDEX_VERSION, SIM_THRESHOLD, DUP_COS, MIN_LEN, MAX_RELATED, MAX_TAG_RELATED,
  MAX_CONTENT_RELATED, RELATION_TAG_BOOST, stripTypePrefix, relationContent, blockContentSig,
  sharedFeatures, relatedCandidates, validateRelation, // vectorizeText/cosine/countGrams 沿用下方 Task 2 的既有 import
} from './knowledge-core.mjs'

// 造条目块的测试辅助：blockId = "<docId>#<n>"（与 kernel 侧 toBlockId 同构），
// 同时给全显式 docId/n 字段（骨架层排序键优先取显式字段，其次才反解 blockId）。
function entry(blockId, tag, full) {
  const i = blockId.lastIndexOf('#')
  return { blockId, docId: blockId.slice(0, i), n: Number(blockId.slice(i + 1)), tag, text: full.slice(0, 30), full }
}

test('hashLine 与既有实现逐字相同（钉住稳定 ID）', () => {
  // 期望值取自 kernel/memory.mjs 现行算法：h=((h<<5)-h+c)|0，无符号 hex 8 位
  assert.equal(hashLine('- [会话|PS材料] 摘要 -- 全文'), hashLine('- [会话|PS材料] 摘要 -- 全文'))
  assert.match(hashLine('任意文本'), /^[0-9a-f]{8}$/)
  assert.notEqual(hashLine('a'), hashLine('b'))
})

test('parseFrontmatter 分离 front 与 body 并给出 body 起始行号', () => {
  const raw = '---\nname: workflow\ndescription: 工作流\n---\n- [会话] 甲 -- 乙\n'
  const r = parseFrontmatter(raw)
  assert.equal(r.front.name, 'workflow')
  assert.equal(r.front.description, '工作流')
  assert.equal(r.body, '- [会话] 甲 -- 乙\n')
  assert.equal(r.bodyStartLine, 5) // body 首行（条目行）是原文第 5 行：4 行 frontmatter+分隔 之后
})

test('parseFrontmatter 无 frontmatter 时 body 原样、起始行为 1', () => {
  const r = parseFrontmatter('普通正文\n第二行\n')
  assert.deepEqual(r.front, {})
  assert.equal(r.body, '普通正文\n第二行\n')
  assert.equal(r.bodyStartLine, 1)
})

test('parseEntryLine 解析标签/摘要/全文，兼容无标签与无分隔符', () => {
  const a = parseEntryLine('- [会话|企微CLI化] 只发文件传输助手 -- 完整背景与做法')
  assert.deepEqual(a, { tag: '企微CLI化', summary: '只发文件传输助手', full: '完整背景与做法' })
  const b = parseEntryLine('- [会话] 无标签条目 -- 全文')
  assert.deepEqual(b, { tag: null, summary: '无标签条目', full: '全文' })
  const c = parseEntryLine('- [会话|X] 只有摘要没有分隔符')
  assert.deepEqual(c, { tag: 'X', summary: '只有摘要没有分隔符', full: '只有摘要没有分隔符' })
})

test('splitBlocks 切出 heading/para/list/code/table/entry 六类，line 可回溯', () => {
  const body = [
    '## 标题一',            // 1 heading
    '',                     // 2
    '一段正文。',            // 3 para
    '',                     // 4
    '- 列表甲',              // 5 list
    '- 列表乙',              // 6 list
    '',                     // 7
    '```js',                // 8 code
    'const a = 1',
    '```',                  // 10
    '',                     // 11
    '| 列 | 值 |',           // 12 table
    '| --- | --- |',
    '| a | 1 |',            // 14
    '',                     // 15
    '- [会话|标签] 摘要 -- 全文',  // 16 entry
  ].join('\n')
  const blocks = splitBlocks(body, { startLine: 1 })
  const kinds = blocks.map(b => b.kind)
  assert.deepEqual(kinds, ['heading', 'para', 'list', 'code', 'table', 'entry'])
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[0].line, 1)
  assert.equal(blocks[1].line, 3)
  assert.equal(blocks[2].text, '- 列表甲\n- 列表乙')
  assert.ok(blocks[3].text.startsWith('```js'))
  assert.ok(blocks[3].text.endsWith('```'))
  assert.equal(blocks[4].kind, 'table')
  assert.equal(blocks[5].entryTag, '标签')
  assert.equal(blocks[5].text, '摘要')
  assert.equal(blocks[5].entryFull, '全文')
  assert.equal(blocks[5].line, 16)
})

test('splitBlocks 起点行号随 startLine 平移（frontmatter 之后仍可回溯原文）', () => {
  const blocks = splitBlocks('## 标题\n', { startLine: 5 })
  assert.equal(blocks[0].line, 5)
})

test('splitBlocks 对空 body 与纯空行返回空数组', () => {
  assert.deepEqual(splitBlocks(''), [])
  assert.deepEqual(splitBlocks('\n\n\n'), [])
})

test('ENTRY_LINE_RE 只认行首条目形状', () => {
  assert.ok(ENTRY_LINE_RE.test('- [会话] 甲 -- 乙'))
  assert.ok(!ENTRY_LINE_RE.test('  - 普通列表项'))
  assert.ok(!ENTRY_LINE_RE.test('文本 - [会话] 甲'))
})

test('列表项紧邻经验条目时，条目单独成块并保留 entryTag（真实经验文件形状）', () => {
  // 真实安装路径（installer.nsh:237 播种 starter + 首次 appendMemoryEntry）产出的文件
  // 就是「bullet 头部 + 条目行相邻」，若条目被并入 list 块则单条经验检索完全失效。
  const body = [
    '**更新记录**：',
    '- 记录一：做了什么',
    '- 记录二：为什么这么做',
    '- [会话|企微CLI化] 只发文件传输助手 -- 真实沟通渠道的测试只发文件传输助手',
    '- [会话|申报材料] 四表联动 -- 口径必须对齐',
  ].join('\n')
  const blocks = splitBlocks(body, { startLine: 1 })
  const kinds = blocks.map((b) => b.kind)
  assert.deepEqual(kinds, ['para', 'list', 'entry', 'entry'])
  const entries = blocks.filter((b) => b.kind === 'entry')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].entryTag, '企微CLI化')
  assert.equal(entries[0].text, '只发文件传输助手')
  assert.equal(entries[0].line, 4, 'line 指向原文第 4 行')
  assert.equal(entries[1].entryTag, '申报材料')
  assert.equal(entries[1].line, 5)
})

test('纯列表文件 / 有序列表 / 缩进列表仍整体成 list 块（修 list 循环不得破坏这些）', () => {
  const plain = splitBlocks('- 甲\n- 乙\n- 丙\n')
  assert.deepEqual(plain.map((b) => b.kind), ['list'])
  assert.equal(plain[0].text, '- 甲\n- 乙\n- 丙')

  const ordered = splitBlocks('1. 甲\n2. 乙\n')
  assert.deepEqual(ordered.map((b) => b.kind), ['list'])

  const indented = splitBlocks('  - 甲\n  - 乙\n')
  assert.deepEqual(indented.map((b) => b.kind), ['list'])

  // 连续多个条目行：必须逐条成块（这是经验文件的主形态，绝不能回归）
  const entries = splitBlocks('- [会话|A] 甲 -- a\n- [会话|B] 乙 -- b\n- [会话|C] 丙 -- c\n')
  assert.deepEqual(entries.map((b) => b.kind), ['entry', 'entry', 'entry'])
  assert.deepEqual(entries.map((b) => b.entryTag), ['A', 'B', 'C'])
})

test('四反引号围栏整体成一个 code 块（仓库 BUILD.md 大量使用）', () => {
  const body = [
    '````md',
    '```js',
    'const a = 1',
    '```',
    '````',
  ].join('\n')
  const blocks = splitBlocks(body, { startLine: 1 })
  assert.deepEqual(blocks.map((b) => b.kind), ['code'])
  assert.ok(blocks[0].text.startsWith('````md'))
  assert.ok(blocks[0].text.endsWith('````'))
})

test('波浪号围栏与未闭合围栏均不崩', () => {
  assert.deepEqual(splitBlocks('~~~\n正文\n~~~\n').map((b) => b.kind), ['code'])
  // 未闭合：吃到文件末尾，不抛错
  const open = splitBlocks('```js\nconst a = 1\n')
  assert.deepEqual(open.map((b) => b.kind), ['code'])
})

test('UTF-8 BOM 开头的文件仍能解析 frontmatter（Windows 记事本场景）', () => {
  const r = parseFrontmatter('\uFEFF---\nname: workflow\n---\n- [会话] 甲 -- 乙\n')
  assert.equal(r.front.name, 'workflow')
  assert.equal(r.body, '- [会话] 甲 -- 乙\n')
  assert.equal(r.bodyStartLine, 4)
})

test('splitBlocks 对 BOM 开头的无 frontmatter 文本正常工作', () => {
  const blocks = splitBlocks('\uFEFF# 标题\n\n正文\n', { startLine: 1 })
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'para'])
})

// ── Task 2: 向量与打分 ────────────────────────────────────────────────────
// 期望值一律以 kernel/graph.mjs、kernel/memory.mjs 的**实跑输出**为准：Task 4 会把那些
// 函数改成 re-export 本模块，任何"看起来更合理"的偏差都会在双端对拍时暴露。
import {
  gramTokens, vectorizeText, vectorizeRaw, cosine, buildIdf, countGrams,
  keywordScore, structBoostOf, fuseScore, makeSnippet, blockIndexText, blockTagBoost,
  W_VECTOR, W_KEYWORD, W_STRUCT, GRAPH_DECAY,
} from './knowledge-core.mjs'

test('gramTokens 与 kernel/graph.mjs 逐字一致（含跨界 bigram 特例）', () => {
  // 权威示例取自 kernel/graph.mjs:21-26 注释（已实跑核对）
  assert.deepEqual([...gramTokens('ps 表与 rd 表')], ['ps', '表与', '与r', 'rd', 'rd表'])
  // word -> 末段 cjk：孤立尾字**不**单独产出，而是与词并成跨界 bigram 'rd表'
  assert.deepEqual([...gramTokens('rd表')], ['rd', 'rd表'])
  assert.deepEqual([...gramTokens('PS 表')], ['ps', 'ps表'])
  // 中文段内部滑动 bigram；空白/标点作分隔不参与
  assert.deepEqual([...gramTokens('知识库')], ['知识', '识库'])
  assert.deepEqual([...gramTokens('')], [])
  assert.deepEqual([...gramTokens('   ')], [])
})

test('vectorizeRaw 给出归一化前的范数', () => {
  const { raw, norm } = vectorizeRaw('知识库 知识库')
  assert.ok(raw.length > 0)
  assert.ok(norm > 0)
  const manual = Math.sqrt(raw.reduce((s, [, w]) => s + w * w, 0))
  assert.ok(Math.abs(manual - norm) < 1e-9)
})

test('vectorizeText 归一化后乘 tagBoost（既有语义：结果非单位范数）', () => {
  const a = vectorizeText('知识库', { tagBoost: 1 })
  const b = vectorizeText('知识库', { tagBoost: 3 })
  assert.equal(a.length, b.length)
  for (const [g, wa] of a) {
    const wb = new Map(b).get(g)
    assert.ok(Math.abs(wb - wa * 3) < 1e-9, 'tagBoost 应在归一化之后整体放大')
  }
})

test('vectorizeText 对空串返回空数组（不产生 NaN）', () => {
  assert.deepEqual(vectorizeText(''), [])
  assert.deepEqual(vectorizeText('   '), [])
  assert.deepEqual(vectorizeText('', { tagBoost: 3 }), [])
  assert.deepEqual(vectorizeText('   ', { tagBoost: 3 }), [])
})

test('cosine 对相同文本为 1、无关文本接近 0', () => {
  const v = vectorizeText('知识库检索')
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9)
  const u = vectorizeText('完全不同的内容 xyz')
  assert.ok(cosine(v, u) < 0.2)
})

test('buildIdf 高频 gram 的 idf 低于低频 gram', () => {
  const docs = [countGrams('知识库'), countGrams('知识库'), countGrams('罕见词条目')]
    .map((gramCounts) => ({ gramCounts }))
  const idf = buildIdf(docs)
  // 注意用 '罕见'（真实产出的 bigram），单字 '罕' 不在 gramTokens 输出里（查不到 → undefined）
  assert.ok(idf.get('知识') < idf.get('罕见'))
  assert.equal(idf.size, 6) // 知识/识库/罕见/见词/词条/条目
})

test('keywordScore 标签命中(3) > 主题(2) = 摘要(2) > 全文(1)', () => {
  const e = { tag: 'PS材料', theme: 'workflow', summary: 'PS材料整理', full: 'PS材料整理的做法' }
  // theme 'workflow' 不含 'ps材料' → 主题项不计分：3(标签) + 2(摘要) + 1(全文) = 6
  assert.equal(keywordScore(e, ['ps材料']), 6)
  // 主题命中确实 +2（钉住 theme 分支，避免上面那条断言因"分支失效"而恒真）
  assert.equal(keywordScore({ theme: 'workflow' }, ['workflow']), 2)
  assert.equal(keywordScore(e, ['流程']), 0)     // 关键词须 ≥2 字符且需命中
  assert.equal(keywordScore(e, ['x']), 0)        // 单字符关键词被过滤
})

test('structBoostOf：标题全等查询最重，heading 有底价，条目次之', () => {
  const doc = { title: 'workflow.md', tags: ['企微CLI化'] }
  assert.equal(structBoostOf({ block: { kind: 'para' }, doc, query: 'workflow.md' }), 1)
  assert.equal(structBoostOf({ block: { kind: 'para' }, doc, query: '无', keywords: ['企微CLI化'] }), 0.67)
  assert.equal(structBoostOf({ block: { kind: 'heading' }, doc, query: '无' }), 0.5)
  assert.equal(structBoostOf({ block: { kind: 'entry' }, doc, query: '无' }), 0.4)
  assert.equal(structBoostOf({ block: { kind: 'para' }, doc, query: '无' }), 0)
})

// Task 7 验收项：检索把**整串**用户查询传进 query（如 'PS表 RD表 交叉校验'），
// 若标题判定只做 title.includes(整串)，标题 'PS表' 永远命不中 → 结构加权（0.15）静默失效。
test('structBoostOf：标题按词元逐一判定，整串查询也能命中单词元标题', () => {
  assert.equal(structBoostOf({ doc: { title: 'PS表' }, query: 'PS表 RD表 交叉校验' }), 1)
  // 词元顺序无关、大小写无关
  assert.equal(structBoostOf({ doc: { title: '企微CLI化' }, query: 'rd表 企微cli化 校验' }), 1)
  // 任一标题词元命中整串查询同样算（双向：标题更长、查询是其中一个词）
  assert.equal(structBoostOf({ doc: { title: 'PS表 RD表' }, query: 'RD表' }), 1)
  // 无任何词元命中 → 仍为 0（不退化成"凡有查询就加分"）
  assert.equal(structBoostOf({ doc: { title: 'PS表' }, query: 'RD表 交叉校验' }), 0)
})

test('fuseScore 三路权重正确，图扩展打 0.9 折扣', () => {
  const s = fuseScore({ cos: 1, kw: 8, struct: 1 })
  assert.ok(Math.abs(s - (W_VECTOR * 1 + W_KEYWORD * 1 + W_STRUCT * 1)) < 1e-9)
  assert.ok(Math.abs(fuseScore({ cos: 1, kw: 8, struct: 1, graph: true }) - s * GRAPH_DECAY) < 1e-9)
  // kw 超过 8 分被截到 1（防标签多次命中把分数推爆）
  assert.equal(fuseScore({ kw: 80 }), fuseScore({ kw: 8 }))
})

test('makeSnippet 压平空白并按上限截断加省略号', () => {
  assert.equal(makeSnippet('  a\n\n b  '), 'a b')
  const long = makeSnippet('x'.repeat(200), { maxLen: 10 })
  assert.equal(long.length, 10)
  assert.ok(long.endsWith('…'))
})

test('blockIndexText 只对经验条目加标签前缀；blockTagBoost 只给它 3 倍', () => {
  const entry = { kind: 'entry', text: '摘要', entryTag: '企微CLI化' }
  assert.equal(blockIndexText(entry), '企微CLI化 摘要')
  assert.equal(blockTagBoost(entry), 3)
  const para = { kind: 'para', text: '正文', entryTag: 'x' }
  assert.equal(blockIndexText(para), '正文')
  assert.equal(blockTagBoost(para), 1)
})

// ── Task 3: 标识 / 链接 / 索引序列化 / 内置空间 ────────────────────────────
// 本组全部是新增契约（无 kernel 侧参照），期望值判据 = spec §5.1/§5.2 的形状与
// 后续任务（Task 5-8）的实际调用方式，已逐条实跑核对。
import {
  toDocId, docIdToParts, toBlockId, extractLinks, resolveLinkTarget,
  serializeIndex, parseJsonl, builtinSpaceSpecs,
} from './knowledge-core.mjs'
import { join } from 'node:path'

test('toDocId 反斜杠归一为正斜杠（跨平台稳定 ID）', () => {
  assert.equal(toDocId('experience', 'workflow.md'), 'experience/workflow.md')
  assert.equal(toDocId('experience', 'a\\b\\c.md'), 'experience/a/b/c.md')
})

test('toDocId 收敛连续分隔符与首尾分隔符（relPath 的脏形态不产生双斜杠 docId）', () => {
  assert.equal(toDocId('notes', 'sub//a.md'), 'notes/sub/a.md')
  assert.equal(toDocId('notes', '\\sub\\a.md'), 'notes/sub/a.md')
  assert.equal(toDocId('notes', 'sub\\\\a.md'), 'notes/sub/a.md')
})

test('docIdToParts 与 toDocId 互逆（含空间 id 内无斜杠的约定）', () => {
  assert.deepEqual(docIdToParts('my-notes/a/b.md'), { spaceId: 'my-notes', relPath: 'a/b.md' })
  // 空间 id 约定不含斜杠（spec §5.1）→ 无斜杠的裸 id 整体即 spaceId、relPath 为空
  assert.deepEqual(docIdToParts('notes'), { spaceId: 'notes', relPath: '' })
  assert.deepEqual(docIdToParts(toDocId('notes', 'sub\\a.md')), { spaceId: 'notes', relPath: 'sub/a.md' })
})

test('toBlockId 拼接', () => {
  assert.equal(toBlockId('experience/workflow.md', 3), 'experience/workflow.md#3')
  // n 从 0 起（splitBlocks 的块序号），首块也不能少拼
  assert.equal(toBlockId('a/b.md', 0), 'a/b.md#0')
})

test('extractLinks 取 wiki 链接与相对 md 链接，忽略外链与纯锚点', () => {
  const md = [
    '见 [[code-style]] 与 [[workflow|工作流]]。',
    '也见 [说明](./docs/policy.md) 与外链 [站点](https://example.com) 与 [锚](#sec)。',
  ].join('\n')
  const links = extractLinks(md)
  const tos = links.map((l) => l.to)
  assert.ok(tos.includes('code-style'))
  assert.ok(tos.includes('workflow'))
  assert.ok(tos.includes('./docs/policy.md'))
  assert.ok(!tos.some((t) => t.startsWith('http')))
  assert.ok(!tos.some((t) => t.startsWith('#')))
  assert.equal(links.find((l) => l.to === 'workflow').anchor, '工作流')
})

test('extractLinks 无别名的 wiki 链接 anchor 为空串（不是 undefined，落盘要能 JSON 化）', () => {
  const links = extractLinks('[[code-style]]')
  assert.deepEqual(links, [{ to: 'code-style', anchor: '' }])
  assert.equal(typeof links[0].anchor, 'string')
})

test('extractLinks 去重（同一目标只出现一次）', () => {
  const links = extractLinks('[[a]] 和 [[a]]')
  assert.equal(links.length, 1)
})

test('extractLinks 去重按 to：同一目标的不同别名只留首次出现的 anchor', () => {
  assert.deepEqual(extractLinks('[[a|甲]] 与 [[a|乙]]'), [{ to: 'a', anchor: '甲' }])
})

test('extractLinks 对空/无链接文本返回空数组', () => {
  assert.deepEqual(extractLinks(''), [])
  assert.deepEqual(extractLinks('纯文本，没有链接。'), [])
})

test('resolveLinkTarget 相对当前文档目录解析并补 .md 后缀', () => {
  const docIds = new Set(['notes/sub/policy.md', 'notes/root.md'])
  assert.equal(
    resolveLinkTarget({ fromRel: 'sub/note.md', to: './policy.md', spaceId: 'notes', docIds }),
    'notes/sub/policy.md',
  )
  assert.equal(
    resolveLinkTarget({ fromRel: 'sub/note.md', to: 'root', spaceId: 'notes', docIds }),
    'notes/root.md',
  )
})

test('resolveLinkTarget 根目录文档（无目录）按「原样 → 加 .md」解析，不产出多余候选', () => {
  const both = new Set(['notes/b', 'notes/b.md'])
  // 原样候选优先于补后缀候选（顺序契约：原样 → .md → 相对目录 → 相对目录+.md）
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: 'b', spaceId: 'notes', docIds: both }), 'notes/b')
  // 只有补后缀命中
  assert.equal(
    resolveLinkTarget({ fromRel: 'a.md', to: 'b', spaceId: 'notes', docIds: new Set(['notes/b.md']) }),
    'notes/b.md',
  )
  // docIds 未给（null）时不校验存在性，返回第一候选——Task 6 建链时总是传集合，这里是兜底契约
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: 'b', spaceId: 'notes' }), 'notes/b')
  // 根目录文档的断链
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: '不存在', spaceId: 'notes', docIds: both }), null)
})

test('resolveLinkTarget 对断链/外链返回 null', () => {
  const docIds = new Set(['notes/a.md'])
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: '不存在', spaceId: 'notes', docIds }), null)
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: 'https://x.com', spaceId: 'notes', docIds }), null)
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: '#sec', spaceId: 'notes', docIds }), null)
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: '', spaceId: 'notes', docIds }), null)
})

test('resolveLinkTarget 剥掉 #fragment 后匹配文档，纯锚点仍为 null（仓库真实形状）', () => {
  // 仓库内真实出现：public/sample-skills/shadcn/cli.md:128 `[..](./SKILL.md#updating-components)`
  const docIds = new Set(['notes/sub/SKILL.md'])
  assert.equal(
    resolveLinkTarget({ fromRel: 'sub/note.md', to: './SKILL.md#updating-components', spaceId: 'notes', docIds }),
    'notes/sub/SKILL.md',
  )
  assert.equal(
    resolveLinkTarget({ fromRel: 'rules/forms.md', to: './base-vs-radix.md#togglegroup', spaceId: 'notes', docIds: new Set(['notes/rules/base-vs-radix.md']) }),
    'notes/rules/base-vs-radix.md',
  )
  // 纯锚点（如 gxtz-achievement-materials/SKILL.md:330 的 `[..](#v1330-..)`）不是边
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: '#v1330-新增章节', spaceId: 'notes', docIds }), null)
  // 剥完只剩空串（`./#x`）不得拼出脏 docId
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: './#x', spaceId: 'notes', docIds }), null)
})

test('resolveLinkTarget 候选串做 . / .. 段归一：父目录相对链接可解析（仓库真实形状）', () => {
  // 仓库实测 4 条：public/sample-skills/shadcn/rules/styling.md -> ../customization.md 等
  assert.equal(
    resolveLinkTarget({ fromRel: 'rules/forms.md', to: '../customization.md', spaceId: 'notes', docIds: new Set(['notes/customization.md']) }),
    'notes/customization.md',
  )
  // Windows 写法（`..\x.md`）等价
  assert.equal(
    resolveLinkTarget({ fromRel: 'rules/forms.md', to: '..\\customization.md', spaceId: 'notes', docIds: new Set(['notes/customization.md']) }),
    'notes/customization.md',
  )
  // `./x.md` 归一后仍落同目录（不是仅靠字符串前缀匹配）
  const docIds = new Set(['notes/rules/base-vs-radix.md'])
  assert.equal(
    resolveLinkTarget({ fromRel: 'rules/forms.md', to: './base-vs-radix.md', spaceId: 'notes', docIds }),
    'notes/rules/base-vs-radix.md',
  )
  // 越出空间根的 `..` 不算穿越：解析不到（docId 只由空间内真实 relPath 构成）
  assert.equal(
    resolveLinkTarget({ fromRel: 'a.md', to: '../../etc/passwd.md', spaceId: 'notes', docIds: new Set(['etc/passwd.md']) }),
    null,
  )
})

test('serializeIndex 产出 JSONL 行数与 parseJsonl 往返一致', () => {
  const s = serializeIndex({
    docs: [{ i: 0, id: 'a/x.md' }, { i: 1, id: 'a/y.md' }],
    inverted: [{ g: 'deadbeef', df: 2, p: [[0, 0.5], [1, 0.25]] }],
    links: [{ from: 'a/x.md', to: 'a/y.md' }],
    tags: { 标签: ['a/x.md'] },
  })
  assert.equal(parseJsonl(s.docs).length, 2)
  assert.equal(parseJsonl(s.inverted).length, 1)
  assert.equal(parseJsonl(s.links).length, 1)
  assert.deepEqual(JSON.parse(s.tags), { 标签: ['a/x.md'] })
})

test('serializeIndex 行序即 docIdx 定义（postings 下标强耦合，往返后顺序不变）', () => {
  const docs = [{ i: 0, id: 'a.md' }, { i: 1, id: 'b.md' }, { i: 2, id: 'c.md' }]
  const s = serializeIndex({ docs })
  assert.deepEqual(parseJsonl(s.docs).map((d) => d.i), [0, 1, 2])
  assert.ok(s.docs.endsWith('\n'), '每行以 \\n 收尾（末行也有，便于原子替换后追加）')
  assert.ok(!s.docs.endsWith('\n\n'), '不产出空行')
})

test('serializeIndex 空输入产出空串（不产出半截行）', () => {
  const s = serializeIndex({})
  assert.equal(s.docs, '')
  assert.equal(s.inverted, '')
  assert.equal(s.links, '')
  assert.equal(s.tags, '{}')
})

test('parseJsonl 跳过半截行与空行', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n{"bad"\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }])
})

test('parseJsonl 支持 CRLF、保留合法非对象行，空输入不崩', () => {
  assert.deepEqual(parseJsonl('{"a":1}\r\n[1,2]\r\n'), [{ a: 1 }, [1, 2]])
  assert.deepEqual(parseJsonl(''), [])
  assert.deepEqual(parseJsonl('   \n  \n'), [])
  assert.deepEqual(parseJsonl(null), [])
})

test('builtinSpaceSpecs 给出三个内置空间，root 挂在 configDir 下', () => {
  const specs = builtinSpaceSpecs('/tmp/home')
  assert.deepEqual(specs.map((s) => s.id), ['experience', 'session-memory', 'skill-experience'])
  const exp = specs[0]
  assert.equal(exp.root, join('/tmp/home', 'memory', 'personal'))
  assert.equal(exp.writable, true)
  assert.equal(exp.source, 'experience')
  assert.equal(specs[2].root, join('/tmp/home', 'memory', 'skill_experiences'))
})

test('builtinSpaceSpecs 每项字段齐备（GUI 与 collectTags 依赖），且每次返回全新对象', () => {
  const a = builtinSpaceSpecs('/home')
  // source 必须与 spec §5.1 表格一致：Task 5 的 collectTags 靠 source==='memory' 决定文件名进 tags
  assert.deepEqual(a.map((s) => s.source), ['experience', 'memory', 'skill_exp'])
  for (const s of a) {
    assert.equal(typeof s.name, 'string')
    assert.ok(s.name.length > 0)
    assert.equal(typeof s.description, 'string')
    assert.ok(s.description.length > 0)
    assert.equal(typeof s.root, 'string')
    assert.equal(s.writable, true)
  }
  // 纯函数：就地改写返回值不得污染下一次调用（discoverSpaces 会把它 push 进结果集）
  a[0].writable = false
  const b = builtinSpaceSpecs('/home')
  assert.equal(b[0].writable, true)
  assert.notEqual(a[0], b[0])
  assert.equal(new Set(b.map((s) => s.id)).size, 3)
})

// ═══════════════════════════════════════════════════════════════════════════
// S5 Task 1：关联锚点纯函数层（spec §5/§7.1；阈值来自 spec §13 真实库校准）
// ═══════════════════════════════════════════════════════════════════════════

test('S5 Task1：常量与 spec §7.1 一致（阈值改动必须重跑校准）', () => {
  assert.equal(INDEX_VERSION, 2) // 1→2：索引文本口径 b.text → relationContent(b)
  // 二次校准（spec §13.5）：首轮 0.32 的 idf 口径与线上不同源（blockIndexText vs relationContent），
  // 且线上按块统计 → 0.32 在两种口径下都命中 0 对（覆盖层空转）。修正为按文档 idf 后实测
  // 跨 tag 对最高 0.312，0.15 命中 16 对（18/69 条获得锚点，含无 tag 的 5/9）。改前请重跑校准。
  assert.equal(SIM_THRESHOLD, 0.15)
  assert.equal(DUP_COS, 0.95)
  assert.equal(MIN_LEN, 20)
  assert.equal(MAX_RELATED, 8)
  assert.equal(MAX_TAG_RELATED, 5)
  assert.equal(MAX_CONTENT_RELATED, 5)
  assert.equal(RELATION_TAG_BOOST, 1) // 覆盖层必须 tagBoost=1（见常量注释）
})

test('S5 Task1：stripTypePrefix 剥掉开头到首个中文冒号的类型前缀', () => {
  assert.equal(stripTypePrefix('流程要点：先备份再改'), '先备份再改')
  assert.equal(stripTypePrefix('用户偏好（以后都）：用 pnpm 装依赖'), '用 pnpm 装依赖')
  assert.equal(stripTypePrefix('业务要点（请注意）：导出要写绝对路径'), '导出要写绝对路径')
  assert.equal(stripTypePrefix('用户纠正（不要再）：以后不要用 npm'), '以后不要用 npm')
  assert.equal(stripTypePrefix('没有前缀的正文'), '没有前缀的正文') // 无中文冒号 → 原样
  assert.equal(stripTypePrefix('结论：A：B'), 'A：B') // 只认**首个**中文冒号，余下的真实内容保留
  assert.equal(stripTypePrefix(''), '')
  assert.equal(stripTypePrefix(null), '')
  assert.equal(stripTypePrefix(undefined), '')
  assert.equal(stripTypePrefix(42), '42') // 非字符串字段不得抛（块字段可能为 null/数字）
})

test('S5 Task1：relationContent 优先 full（实测 text 45 字 vs full 471 字）并去前缀', () => {
  const long = '提交并实现目录任务，知识库实施阶段一完成切块与向量索引构建，'.repeat(5)
  const block = { text: '流程要点：短摘要', full: '流程要点：' + long }
  assert.equal(relationContent(block), long) // 用 full，不用 60 字截断的 text
  assert.ok(long.length > block.text.length * 5, '两条路径信息量差 10 倍，必须用 full')
  assert.equal(relationContent({ text: '流程要点：摘要', full: null }), '摘要') // full 缺失回落 text
  assert.equal(relationContent({ text: '用户纠正（不要再）：以后不要用 npm' }), '以后不要用 npm')
  assert.equal(relationContent({}), '')
  assert.equal(relationContent(null), '')
})

test('S5 Task1：blockContentSig = sha1 前 12 位（对 relationContent，用于读时校验）', () => {
  const a = { text: '流程要点：短', full: '流程要点：' + '正文甲'.repeat(12) }
  const same = { text: '流程要点：短', full: '流程要点：' + '正文甲'.repeat(12) }
  const changed = { text: '流程要点：短', full: '流程要点：' + '正文甲'.repeat(12) + '改动一处' }
  assert.equal(blockContentSig(a), blockContentSig(same))
  assert.match(blockContentSig(a), /^[0-9a-f]{12}$/)
  assert.notEqual(blockContentSig(a), blockContentSig(changed))
  // 只改 text（full 优先）不影响指纹；只改 full 才影响 —— 读时校验的语义正依赖这条
  assert.equal(blockContentSig(a), blockContentSig({ full: a.full, text: '完全不同的摘要' }))
})

test('S5 Task1：sharedFeatures 按 idf×min(tf) 取 topN，且同权重按字典序稳定', () => {
  const tfA = new Map([['甲甲', 3], ['乙乙', 1], ['丙丙', 2]])
  const tfB = new Map([['甲甲', 1], ['乙乙', 1], ['丁丁', 5]])
  const idf = new Map([['甲甲', 1], ['乙乙', 9]])
  // 甲甲：1×min(3,1)=1；乙乙：9×min(1,1)=9 → 乙乙在前
  assert.deepEqual(sharedFeatures(tfA, tfB, { idf, topN: 5 }), ['乙乙', '甲甲'])
  assert.deepEqual(sharedFeatures(tfA, tfB, { idf, topN: 1 }), ['乙乙'])
  assert.deepEqual(sharedFeatures(tfA, tfB, { idf, topN: 0 }), []) // 上限 0 → 空（用于验证丢弃分支）
  assert.deepEqual(sharedFeatures(tfA, new Map(), { idf }), []) // 无共有 gram
  // idf=null → 权重退化为 min(tf)：甲甲 min(3,1)=1、乙乙 min(1,1)=1 同权重，
  // 按 gram 字典序 = UTF-16 码位序（乙 U+4E59 < 甲 U+7532）——**期望值以实跑为准**
  assert.deepEqual(sharedFeatures(tfA, tfB, {}), ['乙乙', '甲甲'])
  const tfC = new Map([['aaa', 1], ['bbb', 1], ['ccc', 1]])
  const tfD = new Map([['ccc', 1], ['bbb', 1], ['aaa', 1]])
  assert.deepEqual(sharedFeatures(tfC, tfD, {}), ['aaa', 'bbb', 'ccc']) // 同权重 → gram 字典序
  // 普通对象形态的词频表也可用（调用方可能落盘成 JSON 再读回）
  assert.deepEqual(sharedFeatures({ 甲甲: 1 }, { 甲甲: 1 }, {}), ['甲甲'])
})

test('S5 Task1：tagBoost=1 时 cosine ∈ [0,1]（钉住校准结论）；=3 自点积溢出到 9', () => {
  const t = '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建'
  const v1 = vectorizeText(t, { tagBoost: 1 })
  const self = cosine(v1, v1)
  assert.ok(self <= 1 + 1e-9, `tagBoost=1 的余弦上限必须是 1，实测 ${self}`)
  assert.ok(self > 0.99)
  const other = vectorizeText('提交实现目录任务git流程说明，关联锚点设计完成阈值校准与覆盖层验证', { tagBoost: 1 })
  const c = cosine(v1, other)
  assert.ok(c >= 0 && c <= 1, `相似度必须落在 [0,1]，实测 ${c}`)
  // 对照（说明为什么必须用 1）：boost 在归一化之后乘 → 范数=boost、自点积=boost²，非度量余弦
  const v3 = vectorizeText(t, { tagBoost: 3 })
  assert.ok(Math.abs(cosine(v3, v3) - 9) < 1e-6)
})

test('S5 Task1：MIN_LEN=20 过滤——10 字空模板条目两端都不参与关联', () => {
  const g0 = entry('experience/a.md#0', null, '流程要点：用户回答：')
  const g1 = entry('experience/a.md#1', null, '流程要点：用户回答：')
  assert.equal(relationContent(g0).length, 5) // 实测存量垃圾：去前缀后只剩模板词
  assert.ok(relationContent(g0).length < MIN_LEN)
  // ① 作为发起方：内容 < MIN_LEN → 直接无候选
  assert.deepEqual(relatedCandidates(g0, [g1], {}), [])
  // ② 作为候选方：垃圾条目两两文本全同（cos=1.000，会灌入"完美相似但零信息"的边）也必须被过滤
  const good = entry('experience/a.md#2', null, '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建')
  assert.deepEqual(relatedCandidates(good, [g0, g1], {}), [])
})

test('S5 Task1：cos>=DUP_COS 归 duplicate，且不计入 MAX_RELATED 预算', () => {
  const text = '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建'
  const from = entry('experience/a.md#0', null, text)
  // 9 条同文本条目（实测精确重复形态 cos=1.000）：全部 duplicate，不被 8 条预算截断
  const pool = Array.from({ length: MAX_RELATED + 1 }, (_, i) => entry(`experience/b.md#${i}`, null, text))
  const out = relatedCandidates(from, pool, {})
  assert.equal(out.length, MAX_RELATED + 1)
  assert.ok(out.every((x) => x.why.kind === 'duplicate'))
  assert.ok(out.every((x) => x.why.score >= DUP_COS))
  assert.ok(out.every((x) => !('shared' in x.why))) // duplicate 不要求 shared（不是"关联"）
})

test('S5 Task1：DUP_COS 边界——实测 0.9393（略低于 0.95）的对归 content 而非 duplicate', () => {
  const a = '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建'
  const near = a + '新增内容'
  const cosNear = cosine(vectorizeText(a, { tagBoost: 1 }), vectorizeText(near, { tagBoost: 1 }))
  assert.ok(cosNear < DUP_COS, `本对必须落在 0.95 之下，实测 ${cosNear}`)
  assert.ok(cosNear >= SIM_THRESHOLD)
  const from = entry('experience/a.md#0', null, a)
  const to = entry('experience/b.md#1', null, near)
  const out = relatedCandidates(from, [to], {})
  assert.equal(out.length, 1)
  assert.equal(out[0].why.kind, 'content') // 不是 duplicate（只有精确重复才归它）
  assert.equal(out[0].why.score, Number(cosNear.toFixed(4)))
  assert.ok(out[0].why.shared.length > 0)
  // minScore 边界是 `>=`：等于实测 cos 时保留，略高即剔除（钉住比较符，防后人改 > 或加偏移）
  assert.equal(relatedCandidates(from, [to], { minScore: cosNear }).length, 1)
  assert.equal(relatedCandidates(from, [to], { minScore: cosNear + 0.0001 }).length, 0)
})

test('S5 Task1：content 边 shared 为空 → 丢弃（硬约束：只有分数无法解释 = 宁缺勿滥）', () => {
  const a = '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建'
  const near = a + '新增内容'
  const from = entry('experience/a.md#0', null, a)
  const to = entry('experience/b.md#1', null, near)
  // topN=0 → sharedFeatures 恒空；这对 cos 已过阈值，但拿不出可解释的共有特征词 → 必须丢弃
  assert.deepEqual(relatedCandidates(from, [to], { topN: 0 }), [])
  // 同 tag 时骨架边不受影响（tag 边不依赖 shared，骨架层零噪声）
  const tagOut = relatedCandidates(entry('experience/a.md#0', 'T', a), [entry('experience/b.md#1', 'T', near)], { topN: 0 })
  assert.equal(tagOut.length, 1)
  assert.equal(tagOut[0].why.kind, 'tag')
  assert.equal(tagOut[0].why.tag, 'T')
})

test('S5 Task1：骨架层排序——同文档按 |Δn| 升序，跨文档次之并按 (docId,n) 字典序（可复现）', () => {
  const body = '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建'
  const from = entry('experience/b-workflow.md#5', '应用智控', body)
  const pool = [
    entry('experience/a-first.md#7', '应用智控', '第一段完全无关的正文'.repeat(3)), // 跨文档
    entry('experience/b-workflow.md#6', '应用智控', '第二段无关正文'.repeat(3)), // 同文档 |Δn|=1
    entry('experience/b-workflow.md#2', '应用智控', '第三段无关正文'.repeat(3)), // 同文档 |Δn|=3
    entry('experience/a-first.md#1', '应用智控', '第四段无关正文'.repeat(3)), // 跨文档（docId 字典序在前）
  ]
  const out = relatedCandidates(from, pool, {})
  assert.deepEqual(out.map((x) => x.to), [
    'experience/b-workflow.md#6', 'experience/b-workflow.md#2', // 同文档：|Δn| 1 < 3
    'experience/a-first.md#1', 'experience/a-first.md#7', // 跨文档：按 (docId, n)
  ])
  assert.ok(out.every((x) => x.why.kind === 'tag'))
  assert.deepEqual(relatedCandidates(from, pool, {}), out) // 同输入两次同序（物化可复现）
})

test('S5 Task1：单块上限——骨架 5 / 覆盖 5 / 总数 8（骨架先占预算）', () => {
  const LONG = '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建'
  const from = entry('experience/a.md#0', 'T', LONG)
  const sameTag = Array.from({ length: 8 }, (_, i) => entry(`experience/a.md#${i + 1}`, 'T', `第${i}段同标签无关正文`.repeat(3)))
  const tagOut = relatedCandidates(from, sameTag, {})
  assert.equal(tagOut.length, MAX_TAG_RELATED)
  assert.ok(tagOut.every((x) => x.why.kind === 'tag'))
  // 跨 tag 但内容近（cos≈0.93 < DUP_COS）→ 覆盖层，只取分数最高的 5 条
  const cross = Array.from({ length: 8 }, (_, i) => entry(`experience/b.md#${i}`, `X${i}`, LONG + '新增内容' + i))
  const cOut = relatedCandidates(from, cross, {}).filter((x) => x.why.kind === 'content')
  assert.equal(cOut.length, MAX_CONTENT_RELATED)
  assert.deepEqual([...cOut].sort((a, b) => b.why.score - a.why.score), cOut) // 按 score 降序
  const mixed = relatedCandidates(from, [...sameTag, ...cross], {})
  assert.equal(mixed.length, MAX_RELATED)
  assert.equal(mixed.filter((x) => x.why.kind === 'tag').length, MAX_TAG_RELATED)
  assert.equal(mixed.filter((x) => x.why.kind === 'content').length, MAX_RELATED - MAX_TAG_RELATED)
})

test('S5 Task1：relatedCandidates 排除自身，且池里带预计算 relContent/gramCounts 时口径不变', () => {
  const LONG = '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建'
  const near = LONG + '新增内容'
  const from = entry('experience/a.md#0', null, LONG)
  const to = entry('experience/b.md#1', null, near)
  const plain = relatedCandidates(from, [from, to], {})
  assert.equal(plain.length, 1) // 自身不入候选
  // 预计算钩子（Task 4 全量物化用）：relContent 与 relationContent 同义，结果必须逐字段一致
  const cached = { ...to, relContent: relationContent(to), gramCounts: countGrams(relationContent(to)) }
  assert.deepEqual(relatedCandidates({ ...from, relContent: relationContent(from), gramCounts: countGrams(relationContent(from)) }, [cached], {}), plain)
})

test('S5 Task1：validateRelation 三条检查（端点存在 / tag 相等 / 内容指纹一致）', () => {
  const a = entry('experience/a.md#0', 'T1', '提交实现目录任务git流程说明，知识库实施阶段一完成切块与向量索引构建')
  const b = entry('experience/b.md#1', 'T1', '关联锚点设计完成阈值校准与覆盖层验证，含真实库实测证据')
  const tagEdge = { from: a.blockId, to: b.blockId, why: { kind: 'tag', tag: 'T1' }, sigFrom: blockContentSig(a), sigTo: blockContentSig(b) }
  const byMap = new Map([[a.blockId, a], [b.blockId, b]])
  assert.equal(validateRelation(tagEdge, byMap), true)
  assert.equal(validateRelation(tagEdge, new Map([[a.blockId, a]])), false) // ① 端点被删
  assert.equal(validateRelation(tagEdge, new Map([[a.blockId, a], [b.blockId, { ...b, tag: 'T2' }]])), false) // ② tag 变更
  assert.equal(validateRelation(tagEdge, new Map([[a.blockId, { ...a, tag: null }], [b.blockId, b]])), false) // 一端无 tag
  const cEdge = { from: a.blockId, to: b.blockId, why: { kind: 'content', score: 0.44, shared: ['提交'] }, sigFrom: blockContentSig(a), sigTo: blockContentSig(b) }
  assert.equal(validateRelation(cEdge, byMap), true)
  assert.equal(validateRelation(cEdge, new Map([[a.blockId, { ...a, full: '内容被改写之后完全不同的一段正文'.repeat(2) }], [b.blockId, b]])), false) // ③ 内容被改
  assert.equal(validateRelation({ ...cEdge, sigTo: 'deadbeef0000' }, byMap), false)
  // lookup 三种形态等价：函数 / Map / 普通对象（kernel 侧可任选）
  const byObj = { [a.blockId]: a, [b.blockId]: b }
  assert.equal(validateRelation(tagEdge, byObj), true)
  assert.equal(validateRelation(tagEdge, (id) => byObj[id] || null), true)
  assert.equal(validateRelation({ ...tagEdge, why: { kind: 'unknown' } }, byObj), false) // 未知 kind 保守判否
})
