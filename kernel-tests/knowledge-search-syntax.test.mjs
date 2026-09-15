/**
 * 检索语法层的内核集成用例（批次 3）。
 *
 * 单测（`shared/knowledge-query.test.mjs`）钉的是"解析对不对"，这一组钉的是
 * **"解析结果真的被用上了"** —— 这是本仓库反复踩到的一类问题：
 * 逻辑单元都对，但接线处漏了一环（参数没转发、过滤器接了却没用、元信息没透出），
 * 症状是"功能看起来做了但没效果"。所以每条都要**端到端**验到结果集。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

const HOMES = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-q-'))
  HOMES.push(dir)
  const sp = join(dir, 'knowledge', 'spaces', 'notes')
  mkdirSync(join(sp, 'reports'), { recursive: true })
  mkdirSync(join(sp, 'tech'), { recursive: true })
  writeFileSync(join(sp, 'reports', 'a.md'),
    '---\ntags: [财务, 季度]\n---\n# 财务\n\n## 背景\n\n营收增长 30%。\n\n## 草稿\n\n未定稿内容。\n', 'utf-8')
  writeFileSync(join(sp, 'reports', 'b.md'),
    '---\ntags: [财务]\n---\n# 报告\n\n季度报告已发布。\n', 'utf-8')
  writeFileSync(join(sp, 'tech', 'c.md'),
    '---\ntags: [技术]\n---\n# 技术\n\n营收相关系统设计。\n', 'utf-8')
  const store = createKnowledgeStore({ configDir: dir })
  store.load({})
  return { dir, store }
}
after(() => { for (const d of HOMES) rmSync(d, { recursive: true, force: true }) })

/** 结果里的文档名集合（去掉 spaceId 前缀，便于断言） */
const rels = (r) => r.items.map((i) => i.docId.replace('notes/', '')).sort()
/** 是否命中某篇（按 rel 后缀匹配，避免依赖绝对路径） */
const has = (r, suffix) => r.items.some((i) => i.docId.endsWith(suffix))

test('批次3：tag: 过滤走枚举路径并出结果（打分链在无词时恒空，不能复用它）', () => {
  const { store } = makeStore()
  const r = store.search({ query: 'tag:财务', topK: 10 })
  assert.equal(r.query?.filterOnly, true, '仅过滤查询应被标记')
  assert.equal(r.orderedBy, 'path', '枚举结果按路径排序（稳定可预测）')
  assert.deepEqual(rels(r), ['reports/a.md', 'reports/b.md'])
  // 关键：这类查询**不能**返回 0 条 —— 打分链需要文本证据，没有词时全为 0，
  // 若复用它，用户会看到"库里明明有这个标签却搜不到"
  assert.equal(r.count, 2)
})

test('批次3：path: / file: 过滤生效，且能叠加检索词', () => {
  const { store } = makeStore()
  assert.deepEqual(rels(store.search({ query: 'path:reports/', topK: 10 })), ['reports/a.md', 'reports/b.md'])
  assert.deepEqual(rels(store.search({ query: 'file:b.md', topK: 10 })), ['reports/b.md'])
  // 过滤 + 检索词：打分在这两篇里做
  const r = store.search({ query: 'path:reports/ 未定稿', topK: 10 })
  assert.equal(r.query?.filterOnly, false)
  assert.ok(has(r, 'reports/a.md'), `应命中 a.md：${JSON.stringify(rels(r))}`)
  assert.ok(!has(r, 'tech/c.md'), '过滤条件必须真的排除掉 tech/ —— 否则 path: 等于没写')
})

test('批次3：tag:A OR tag:B 能出结果（扁平 AND 会返回 0 条）', () => {
  const { store } = makeStore()
  const r = store.search({ query: 'tag:财务 OR tag:技术', topK: 10 })
  assert.equal(r.query?.or, true)
  assert.deepEqual(rels(r), ['reports/a.md', 'reports/b.md', 'tech/c.md'])
})

test('批次3：否定过滤排除整篇；否定文本项与否定块过滤排除块', () => {
  const { store } = makeStore()
  const byTag = store.search({ query: '-tag:技术 营收', topK: 10 })
  assert.ok(!has(byTag, 'tech/c.md'), 'tech/c.md 有技术标签 → 必须排除')
  assert.ok(has(byTag, 'reports/a.md'))

  // 否定**文本**项：a.md 的块 "未定稿内容。" 含"定稿" → 该块被排除，
  // 而库里没有别的块含"未定稿" → 结果为空。
  // （注意不是 `-草稿`：`未定稿` 里没有"草稿"这个子串，用它测不出否定是否生效）
  const negTerm = store.search({ query: '未定稿 -定稿', topK: 10 })
  assert.equal(negTerm.count, 0, '含"定稿"的块应被否定项排除')

  // 否定**块过滤**必须精确到块：`-content:未定稿` 只排掉那一块，
  // 同一篇里其它块照常能命中（若按"有一块命中就排除整篇"处理，这里会返回 0 条 —— 实测踩过）
  const negBlock = store.search({ query: 'tag:财务 -content:未定稿', topK: 10 })
  assert.deepEqual(rels(negBlock), ['reports/a.md', 'reports/b.md'], '排除单块不该牵连整篇')
  // 反向证明它**真的生效**了：把"营收"所在的块整体排除 → 无块可命中
  const allNeg = store.search({ query: '营收 -content:营收', topK: 10 })
  assert.equal(allNeg.count, 0, '含"营收"的块被排除后应无结果（否则说明否定块过滤被静默忽略）')
})

test('批次3：section: 回溯所属标题（正文块文本里没有那行标题）', () => {
  const { store } = makeStore()
  const hit = store.search({ query: 'section:背景 营收', topK: 10 })
  assert.ok(has(hit, 'reports/a.md'), `section:背景 + 营收 应命中 a.md：${JSON.stringify(rels(hit))}`)
  // 反例：a.md 的"草稿"段没有营收 → 不该因为"同文档里另有营收"而命中
  const miss = store.search({ query: 'section:草稿 营收', topK: 10 })
  assert.equal(miss.count, 0, 'section:草稿 的块里没有"营收"→ 不该命中')
})

test('批次3：无效正则报错（queryError），而不是静默当文本搜或当成 0 条', () => {
  const { store } = makeStore()
  const r = store.search({ query: '/[/' })
  assert.equal(r.count, 0)
  assert.match(String(r.queryError), /^bad-regex/)
  // 与之对照：合法正则正常工作
  const ok = store.search({ query: '/\\d+%/', topK: 10 })
  // 无错时**不返回该键**（仓库约定：可选成员只在有值时出现，避免给所有调用方的
  // deepEqual 断言塞进噪音）→ 断言 falsy 而不是严格 null
  assert.ok(!ok.queryError, '无语法错误时不该有 queryError')
  assert.ok(has(ok, 'reports/a.md'), '30% 应被正则命中')
})

test('批次3：图扩展不突破过滤条件（否则"过滤生效"的判断会被越界结果推翻）', () => {
  const { store } = makeStore()
  // 造一个链接：tech/c.md 链接到 reports/a.md。搜 tag:技术 时，a.md 没有该标签，
  // 不该因为"是 c.md 的链接目标"而被带出来。
  writeFileSync(join(HOMES[HOMES.length - 1], 'knowledge', 'spaces', 'notes', 'tech', 'c.md'),
    '---\ntags: [技术]\n---\n# 技术\n\n营收相关系统设计。\n\n见 [[a]]\n', 'utf-8')
  store.load({})
  const r = store.search({ query: 'tag:技术', topK: 10 })
  assert.deepEqual(rels(r), ['tech/c.md'], '链接目标不得因图扩展越过过滤条件出现')
})

test('批次3：结果带回算子元信息（GUI 靠它回显"哪些算子生效"）', () => {
  const { store } = makeStore()
  const r = store.search({ query: 'tag:财务 营收 OR -file:zzz', topK: 10 })
  assert.ok(r.query, 'search 结果必须带 query 元信息')
  assert.equal(typeof r.query.filterOnly, 'boolean')
  assert.equal(typeof r.query.strict, 'boolean')
  assert.ok(Array.isArray(r.query.filters))
  // 正则实例不能出现在元信息里（JSON 序列化会变成 `{}`，调用方只能猜"正则到底生效没"）
  assert.deepEqual(r.query.regexes, [])
  assert.ok(r.query.filters.every((f) => typeof f.field === 'string' && typeof f.value === 'string'))
  assert.ok(r.query.fields.includes('tag'))
  assert.ok(r.query.fields.includes('file'))
})

test('批次3：无算子的普通查询行为不变（这是行为回退防线）', () => {
  const { store } = makeStore()
  const plain = store.search({ query: '季度 报告', topK: 10 })
  assert.ok(plain.count > 0, '普通多词查询必须照旧能搜到（部分命中即可）')
  assert.equal(plain.query?.strict, false, '没写布尔逻辑就不该进严格模式')
  assert.equal(plain.query?.filterOnly, false)
  // 标签直连（拿标签名当查询词）仍要生效 —— 这是用户最自然的动作，也是 agent 侧按标签找料的依据
  const tagHit = store.search({ query: '财务', topK: 10 })
  assert.ok(has(tagHit, 'reports/a.md'), '裸标签名仍应命中')
})

test('批次3：纯否定查询返回空且不报错（没有正向依据就没有结果可给）', () => {
  const { store } = makeStore()
  // 否定**词**与否定**过滤**必须同一口径：`-财务`（词）和 `-tag:技术`（过滤）都返回空。
  // 若只让后者枚举，它会返回"全库里不带该标签的文档"——同一个排除意图两种结果。
  const negTerm = store.search({ query: '-财务' })
  assert.equal(negTerm.count, 0)
  assert.ok(!negTerm.queryError, '这不是语法错误，不该报错')
  assert.equal(negTerm.query?.strict, true)

  const negFilter = store.search({ query: '-tag:技术' })
  assert.equal(negFilter.count, 0, '否定过滤不得枚举出全库')
  assert.ok(!negFilter.queryError)
  assert.equal(negFilter.query?.enumerate, false)

  // 正向 + 否定：正常枚举并收窄
  const mixed = store.search({ query: 'tag:财务 -tag:技术', topK: 10 })
  assert.deepEqual(rels(mixed), ['reports/a.md', 'reports/b.md'])
})
