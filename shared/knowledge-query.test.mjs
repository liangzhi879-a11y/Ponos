/**
 * 检索语法层（`shared/knowledge-query.mjs`）用例。
 *
 * 这一组是整个批次 3 的地基：内核的过滤/枚举/严格判定全部建立在这份解析结果上，
 * 解析错了上层怎么修都白搭。重点钉三类"错了不报错、只是结果不对"的行为：
 *   ① **未知字段回落成文本** —— 做错会让 `10:30` / `http://a.com` 这类查询恒空
 *   ② **OR 语义一路贯彻到过滤层** —— 做错会让 `tag:A OR tag:B` 返回 0 条
 *   ③ **negative / strict 的边界** —— 做错会让"排除项"静默失效（结果里照样出现）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSearchQuery, matchDocQuery, matchBlockQuery, matchTextParts, enclosingHeading,
} from '../shared/knowledge-query.mjs'

/** 构造一个最小 doc：doc.blocks 按 line 递增（section 回溯依赖这个顺序） */
function doc(rel, tags, blocks) {
  return {
    id: `notes/${rel}`, spaceId: 'notes', rel, tags,
    blocks: blocks.map((b, i) => ({ n: i + 1, id: `b${i + 1}`, line: b.line ?? i + 1, kind: b.kind ?? 'para', text: b.text, heading: b.heading })),
  }
}

const DOC_A = doc('reports/a.md', ['财务', '季度'], [
  { kind: 'heading', text: '# 财务' },
  { kind: 'heading', text: '## 背景' },
  { text: '营收增长 30%。' },
  { kind: 'heading', text: '## 草稿' },
  { text: '未定稿内容。' },
])
const DOC_B = doc('reports/b.md', ['财务'], [
  { kind: 'heading', text: '# 报告' },
  { text: '季度报告已发布。' },
])
const DOC_C = doc('tech/c.md', ['技术'], [
  { kind: 'heading', text: '# 技术' },
  { text: '营收相关系统设计。' },
])

// ── ① 未知字段回落成文本（最关键） ─────────────────────────────────────────────
test('批次3：未知字段 / 时间 / URL 一律回落成普通文本（不静默变成"字段过滤"）', () => {
  for (const q of ['10:30', 'http://example.com', 'a:b', 'ratio 1:2']) {
    const p = parseSearchQuery(q)
    assert.equal(p.filters.length, 0, `${q} 不该解析出过滤条件`)
    assert.ok(p.terms.length > 0, `${q} 应作为检索词`)
  }
  // 具体到 `10:30`：若被当成 `字段 10 = 30`，过滤层会恒假 → 查询恒空且不报错（最难排查）
  const p = parseSearchQuery('10:30')
  assert.deepEqual(p.terms, ['10:30'])
  assert.equal(p.filterOnly, false)
})

test('批次3：字段别名与容忍写法（tags/heading/line/# 前缀/^ 前缀/大小写）', () => {
  assert.equal(parseSearchQuery('tags:财务').filters[0].field, 'tag')
  assert.equal(parseSearchQuery('heading:背景').filters[0].field, 'section')
  assert.equal(parseSearchQuery('line:营收').filters[0].field, 'content')
  assert.equal(parseSearchQuery('TAG:财务').filters[0].field, 'tag')
  // 值里的 `#` / `^` 由匹配层容错，解析层原样保留（不在解析层剥 —— 否则 `tag:#` 这种值会变空）
  assert.equal(parseSearchQuery('tag:#财务').filters[0].value, '#财务')
})

// ── ② OR 语义（必须一路贯彻到过滤层） ─────────────────────────────────────────
test('批次3：OR 分组解析 + tag:A OR tag:B 必须能出结果（扁平 AND 会恒空）', () => {
  const p = parseSearchQuery('tag:财务 OR tag:技术')
  assert.equal(p.orGroups.length, 2, 'OR 应拆成两组')
  assert.equal(p.filterOnly, true)
  // 关键断言：OR 的两组是"任一组满足"，不是"两个标签同时存在"
  assert.equal(matchDocQuery(DOC_A, p), true, '有 财务 → 应通过')
  assert.equal(matchDocQuery(DOC_C, p), true, '有 技术 → 应通过')
  assert.equal(matchDocQuery(doc('x.md', ['其他'], []), p), false)
})

test('批次3：OR 大小写敏感 —— 小写 or 是普通词（否则毁掉所有英文查询）', () => {
  const p = parseSearchQuery('arm or leg')
  assert.equal(p.orGroups.length, 0, '小写 or 不该分组')
  assert.deepEqual(p.terms, ['arm', 'or', 'leg'])
  assert.equal(parseSearchQuery('arm OR leg').orGroups.length, 2)
})

test('批次3：组内多项要同时满足（OR 两侧各自 AND）', () => {
  const p = parseSearchQuery('tag:财务 营收 OR tag:技术')
  // 组1 = 财务 + 营收；组2 = 技术
  assert.equal(matchDocQuery(DOC_A, p), true, '财务 + 营收 都在 → 通过')
  assert.equal(matchDocQuery(DOC_B, p), false, '只有 财务、没有 营收 → 组1 不满足（组2 也不满足）')
  assert.equal(matchDocQuery(DOC_C, p), true, '技术 → 组2 满足')
})

// ── ③ 否定与严格模式 ─────────────────────────────────────────────────────────
test('批次3：否定过滤（-tag:x）排除整篇；且不影响其它条件', () => {
  const p = parseSearchQuery('-tag:技术 营收')
  // 否定**过滤**不启用严格文本模式：`-tag:技术` 的语义由文档级过滤完成，
  // 不该顺带把 `营收` 变成必须命中的 AND 词（用户没写布尔文本逻辑，改语义=行为回退）
  assert.equal(p.strict, false, '否定过滤 ≠ 布尔文本模式')
  assert.equal(matchDocQuery(DOC_A, p), true, '没有技术标签 → 通过')
  assert.equal(matchDocQuery(DOC_C, p), false, '有技术标签 → 排除')
})

test('批次3：否定的一元算子作用于整串（-foo 与 -tag:x 都要生效）', () => {
  const p = parseSearchQuery('-foo bar')
  assert.deepEqual(p.terms, ['bar'], '否定词不进正向词表（否则会被打分链当成要命中的词）')
  assert.equal(p.strict, true)
  assert.equal(matchTextParts('bar baz', p), true)
  assert.equal(matchTextParts('bar foo', p), false, '含 foo → 应被排除')
})

test('批次3：strict 的开关边界 —— 没写布尔逻辑时不启用（保住既有"部分命中"行为）', () => {
  // 这条是**行为回退防线**：老查询 `季度 报告` 在打分链里允许"只含季度"的块进结果。
  // 无条件改成 AND 会让用户突然发现结果变少而不知原因 —— 那是回退，不是修 bug。
  assert.equal(parseSearchQuery('季度 报告').strict, false)
  assert.equal(parseSearchQuery('"季度 报告"').strict, false, '单纯短语不算布尔逻辑')
  assert.equal(parseSearchQuery('tag:财务').strict, false, '单纯过滤不算布尔逻辑')
  assert.equal(parseSearchQuery('tag:财务 OR tag:技术').strict, true)
  // 否定的**过滤**不算布尔文本模式（它的语义由文档级过滤完成，不该顺带把检索词变成 AND）
  assert.equal(parseSearchQuery('-tag:技术').strict, false)
  // 否定的**文本**项才算（`-foo` 必须逐块排除）
  assert.equal(parseSearchQuery('-foo').strict, true)
})

// ── section 回溯（做错会让 `section:背景 营收` 恒空） ──────────────────────────
test('批次3：section 过滤要回溯所属标题（正文块文本里没有那行标题）', () => {
  const contentBlock = DOC_A.blocks[2]           // 正文块：文本 "营收增长 30%。"，无 heading 字段
  assert.equal(contentBlock.heading, undefined)
  assert.equal(enclosingHeading(DOC_A, contentBlock), '背景', '应回溯到最近的前置标题')
  assert.equal(enclosingHeading(DOC_A, DOC_A.blocks[4]), '草稿')
  const p = parseSearchQuery('section:背景 营收')
  assert.equal(matchBlockQuery(contentBlock, DOC_A, p), true, 'section:背景 + 营收 应同时命中正文块')
  assert.equal(matchBlockQuery(DOC_A.blocks[4], DOC_A, p), false, '草稿块不该命中（section 不符且无营收）')
})

test('批次3：块级过滤 —— content: / block: 与别名 line: 等价', () => {
  const p1 = parseSearchQuery('content:未定稿')
  assert.equal(matchBlockQuery(DOC_A.blocks[4], DOC_A, p1), true)
  assert.equal(matchBlockQuery(DOC_A.blocks[2], DOC_A, p1), false)
  // line: 是 content: 的别名
  const p2 = parseSearchQuery('line:未定稿')
  assert.equal(matchBlockQuery(DOC_A.blocks[4], DOC_A, p2), true)
  // block: 按 id 包含（容忍 `^` 前缀）
  const p3 = parseSearchQuery('block:^b5')
  assert.equal(matchBlockQuery(DOC_A.blocks[4], DOC_A, p3), true, '`^b5` 应命中 id=b5')
  assert.equal(matchBlockQuery(DOC_A.blocks[2], DOC_A, p3), false)
})

// ── 文本项与正则 ─────────────────────────────────────────────────────────────
test('批次3：短语不拆词、正则可用、无效正则报错（不静默降级成文本）', () => {
  const p = parseSearchQuery('"季度 报告"')
  assert.deepEqual(p.phrases, ['季度 报告'])
  assert.deepEqual(p.terms, [])
  assert.equal(matchTextParts('本季度 报告已发布', p), true, '短语整体匹配（跨空格）')
  assert.equal(matchTextParts('季度数据与报告编制', p), false, '拆开的两段不算命中')

  const r = parseSearchQuery('/\\d{4}-\\d{2}/')
  assert.equal(r.ok, true)
  assert.equal(r.regexes.length, 1)
  assert.equal(matchTextParts('期间 2026-09 数据', r), true)
  assert.equal(matchTextParts('期间 2026年09月 数据', r), false)

  // 无效正则必须 ok=false：静默当文本搜会给出"看起来能搜到、语义完全不同"的结果
  const bad = parseSearchQuery('/[/')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /^bad-regex/)
})

test('批次3：正则不带 g 标志（带 g 时 lastIndex 会跨 test() 残留 → 间隔性失配）', () => {
  const p = parseSearchQuery('/foo/')
  assert.equal(p.regexes[0].re.flags.includes('g'), false)
  // 同一个正则对象连用两次结果必须一致（带 g 时会一次 true 一次 false）
  assert.equal(matchTextParts('foo', p), true)
  assert.equal(matchTextParts('foo', p), true)
})

// ── 派生字段与边界 ───────────────────────────────────────────────────────────
test('批次3：`enumerate` 是 `filterOnly` 的超集 —— 纯正则查询也必须走枚举', () => {
  // 这条钉的是一个**实测漏掉就静默返回空**的漏洞：`/\d+%/` 没有过滤条件，于是
  // filterOnly=false；但同样没有可向量化的文本 → 打分链恒空 → 用户看到"0 条"，
  // 既没报错也没提示，完全无从判断是语法问题还是库里真没有。
  const re = parseSearchQuery('/\\d+%/')
  assert.equal(re.filterOnly, false, '没有过滤条件，所以不是 filterOnly')
  assert.equal(re.enumerate, true, '但必须走枚举路径')
  assert.equal(re.textQuery, '', '没有可打分的文本')

  // 只有否定文本项时**不该**枚举：没有正向依据，枚举出来的是"所有块"，等于没有约束
  assert.equal(parseSearchQuery('-foo').enumerate, false)
  const f = parseSearchQuery('tag:财务')
  assert.equal(f.filterOnly, true)
  assert.equal(f.enumerate, true, 'filterOnly 一定是 enumerate')
  assert.equal(parseSearchQuery('营收').enumerate, false, '有检索词就走打分')
})

test('批次3：纯否定查询不枚举 —— 与"否定词返回空"保持同一口径', () => {
  // 这条钉的是一个**写法不同、结果不同**的不一致（实测踩到）：
  // 最初 `-tag:x`（否定过滤）会枚举出"全库里所有不带该标签的文档"（几千条，看起来像过滤没生效），
  // 而 `-foo`（否定词）在打分链里必然返回空。同一个"排除"意图给出两种结果，
  // 用户会当成 bug 报上来。统一口径：**没有正向依据就没有结果可给**。
  for (const q of ['-tag:x', '-foo', '-/\\d+/', '-content:未定稿']) {
    const p = parseSearchQuery(q)
    assert.equal(p.enumerate, false, `${q} 不该走枚举（没有正向依据）`)
    assert.equal(p.filterOnly, false)
  }
  // 但"正向 + 否定"组合仍要枚举（有正向依据，否定只是收窄）
  const mixed = parseSearchQuery('tag:财务 -tag:草稿')
  assert.equal(mixed.enumerate, true)
  assert.equal(mixed.filterOnly, true)
})

test('批次3：filterOnly / textQuery / hint 三个派生字段', () => {
  const only = parseSearchQuery('tag:财务 path:reports/')
  assert.equal(only.filterOnly, true)
  assert.equal(only.textQuery, '', '仅过滤查询没有可打分的文本')
  assert.deepEqual(only.hint, ['tag', 'path'], 'hint 去重且保序')

  const mixed = parseSearchQuery('tag:财务 营收')
  assert.equal(mixed.filterOnly, false, '有检索词就不是"仅过滤"')
  assert.equal(mixed.textQuery, '营收', '打分文本必须剥掉算子（否则 tag:财务 会污染倒排命中）')

  // 纯否定：既不是 filterOnly（没有过滤条件），也没有可打分的正向文本
  const negOnly = parseSearchQuery('-foo')
  assert.equal(negOnly.filterOnly, false)
  assert.equal(negOnly.textQuery, '')
  assert.equal(negOnly.strict, true)
})

test('批次3：空查询 / 超长查询 / 手抖 OR 的容错', () => {
  const empty = parseSearchQuery('   ')
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.terms, [])
  assert.equal(empty.filterOnly, false)

  // 超长：报错而不是截断后继续（截断会让用户以为"搜的就是我粘的那段"）
  const long = parseSearchQuery('a'.repeat(2001))
  assert.equal(long.ok, false)
  assert.match(long.error, /^query-too-long/)

  // `OR foo` / `foo OR OR bar` / 尾随 OR：丢掉空组、不报错（手抖不值得打断搜索）
  assert.equal(parseSearchQuery('OR foo').orGroups.length, 0, '开头 OR 不分组，等于没写')
  assert.deepEqual(parseSearchQuery('OR foo').terms, ['foo'])
  assert.deepEqual(parseSearchQuery('foo OR').terms, ['foo'])
  assert.equal(parseSearchQuery('foo OR').orGroups.length, 0, '尾随 OR 不该留下空组')
  // `foo OR OR bar` 是双 OR 手抖：按 `foo OR bar` 理解（符合意图），而不是报错或产生空组
  assert.equal(parseSearchQuery('foo OR OR bar').orGroups.length, 2)
})

test('批次3：`tag:` 前缀匹配与 `#` 容忍（用户少打一个字符不该搜不到）', () => {
  const p1 = parseSearchQuery('tag:财')
  assert.equal(matchDocQuery(DOC_A, p1), true, '前缀匹配：财 → 财务')
  const p2 = parseSearchQuery('tag:#财务')
  assert.equal(matchDocQuery(DOC_A, p2), true, '容忍 # 前缀')
  const p3 = parseSearchQuery('tag:技术')
  assert.equal(matchDocQuery(DOC_A, p3), false, '不该跨标签命中')
})

test('批次3：path / file 语义（路径包含 vs 文件名包含）', () => {
  const byPath = parseSearchQuery('path:reports/')
  assert.equal(matchDocQuery(DOC_A, byPath), true)
  assert.equal(matchDocQuery(DOC_C, byPath), false)
  // `path:a` 会命中 reports/a.md（路径包含）；`file:a` 只看 basename
  assert.equal(matchDocQuery(DOC_A, parseSearchQuery('path:a.md')), true)
  assert.equal(matchDocQuery(DOC_A, parseSearchQuery('file:a.md')), true)
  assert.equal(matchDocQuery(DOC_A, parseSearchQuery('file:reports')), false, 'file: 不看目录部分')
})
