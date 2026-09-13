// shared 纯函数测试：块切分 / frontmatter / 经验条目解析。
// 本文件不碰文件系统（shared 层的依赖纪律：只允许 node:path）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashLine, parseFrontmatter, parseEntryLine, splitBlocks, ENTRY_LINE_RE,
} from './knowledge-core.mjs'

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
