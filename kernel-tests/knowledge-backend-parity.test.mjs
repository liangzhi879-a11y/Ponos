// T5 守卫：**两个后端的结果必须逐位相同**（spec §8.1 的验收硬指标）+ sqlite 侧 idf 口径一致。
//
// 为什么这三条是分开的（而不是一条大断言）：
//  ① 逐位对拍（blockId 序列 + 分数）：守"换存储不改结果"这条验收；
//  ② sqlite 侧 idf 口径：守 spec §2.5 的陷阱在**新后端**里没有复现（jsonl 侧由
//     knowledge-idf-semantics.test.mjs 守）；
//  ③ 候选非空：守"真走了倒排"而不是"空集放行"（空集合 = fail-open，本仓明令判红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import {
  migrateToSqlite, dbPathOf, loadIdf, queryPostings, fetchPostings,
} from '../kernel/knowledge-backend-sqlite.mjs'

const QUERIES = ['研发费用 归集', '高新收入 占比', '知识产权 一类', '立项报告', '辅助账']

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-bpar-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'a.md'), [
    '---', 'name: a', '---', '## 研发费用',
    '- [会话|高企口径] 研发费用归集口径 -- 人员人工、直接投入、折旧费用、无形资产摊销、其他费用',
    '', '| 项目 | 金额 |', '| --- | --- |', '| 人员人工 | 100 |',
  ].join('\n') + '\n', 'utf-8')
  writeFileSync(join(personal, 'b.md'), [
    '---', 'name: b', '---',
    '- [会话|高企口径] 高新收入占比 -- 近一年不低于60%',
  ].join('\n') + '\n', 'utf-8')
  writeFileSync(join(personal, 'c.md'), [
    '---', 'name: c', '---',
    '## 知识产权', '- [会话|知识产权] 一类知识产权 -- 按1件计',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

function toSqlite(dir) {
  // 迁移源显式构造（`migrateToSqlite` 不再隐式自造 —— 见 kernel/knowledge-paths.mjs 头注释）
  migrateToSqlite({ configDir: dir, store: createKnowledgeStore({ configDir: dir }) })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ knowledgeIndexBackend: 'sqlite' }), 'utf-8')
  const s = createKnowledgeStore({ configDir: dir })
  s.load({ force: true })
  // ★ fail-closed：内核在库不可用时会**静默回落 jsonl**（只打一条 warn）——
  //   若不在测试里钉住"实际生效的后端"，本文件的三条断言就可能在"两边都是 jsonl"的情况下
  //   全绿（实测踩过：漏一个 import 就复现了这个假绿）。这一行是这些断言的**前提校验**。
  assert.equal(s.getBackend(), 'sqlite', '必须真的跑在 sqlite 后台上（静默回落会让本文件的断言变成空断言）')
  return s
}

test('jsonl 与 sqlite 两后端 top-5 blockId 序列与分数逐位相同', () => {
  const dir = fixture()
  const s1 = createKnowledgeStore({ configDir: dir }); s1.load({})
  const base = QUERIES.map((q) => s1.search({ query: q, topK: 5 }).items.map((i) => [i.blockId, i.score]))
  assert.ok(base.some((r) => r.length > 0), 'fixture 必须至少有一条查询命中（空集合 = fail-open）')

  const s2 = toSqlite(dir)
  const after = QUERIES.map((q) => s2.search({ query: q, topK: 5 }).items.map((i) => [i.blockId, i.score]))
  assert.deepEqual(after, base, '两后端结果必须逐位相同（blockId 序列 + 分数）')
})

test('sqlite 侧 idf 必须是「块级 df + N=块数」口径（与 jsonl 侧逐 gram 一致）', () => {
  const dir = fixture()
  const s1 = createKnowledgeStore({ configDir: dir }); s1.load({})
  const jsonlIdf = s1.getIdf()
  toSqlite(dir)
  const db = new DatabaseSync(dbPathOf(dir))
  const sqliteIdf = loadIdf(db)
  const nBlocks = Number(db.prepare('SELECT v FROM meta WHERE k=?').get('nBlocks').v)
  db.close()
  assert.equal(nBlocks, s1.stats().blocks, 'meta.nBlocks 必须等于块数')
  assert.ok(sqliteIdf.size > 0, 'idf 表不得为空（fail-closed）')
  // 只比对两侧都有的 gram（jsonl 侧会剪枝高频 gram：PRUNE_DF_RATIO，缺的是剪枝结果，不是口径差异）
  let compared = 0
  for (const [h, v] of sqliteIdf) {
    const j = jsonlIdf.get(h)
    if (j === undefined) continue
    compared += 1
    assert.ok(Math.abs(j - v) < 1e-9, `gram ${h}: jsonl ${j} vs sqlite ${v}（口径必须一致）`)
  }
  assert.ok(compared > 0, '至少比对到一个 gram（空集合 = fail-open）')
})

test('查询 gram 能取到候选（真走了倒排，而不是空集放行）', () => {
  const dir = fixture()
  const s = toSqlite(dir)
  const r = s.search({ query: '研发费用 归集', topK: 5 })
  assert.ok(r.count > 0, 'sqlite 读路径必须真有命中')
  assert.ok(r.items.some((i) => String(i.docId).endsWith('a.md')))
})

// ── 以下三条是**超出计划稿**的加固（实施时实测发现计划稿的断言不够强，见汇报"偏离"一节）──
// 原因（实测）：计划稿的三条断言在 3 篇文档的 fixture 上全部为真，即使把 sqlite 侧的候选累加
// 公式改错（丢查询权重 wq）也**照样全绿** —— 因为候选池只有 3 个、永不触发 `candTopN` 截断，
// 而最终排序用的是块级分数（与候选累加权重无关）。也就是说那三条守的是"最终结果"，
// 守不住"候选生成本身"。故补齐：① 直接对 queryPostings 做现场重算；② 造 >20 篇候选的语料，
// 让候选截断真正参与排序。

test('★ queryPostings 的 score == 现场按 postings 重算的 Σ(wq×wd)（候选排序不得漂移）', () => {
  const dir = fixture()
  toSqlite(dir)
  const db = new DatabaseSync(dbPathOf(dir))
  // 取库里任意两个 gram 当查询（不写死 bigram 字面量：分词边界差异不该让本测试假红）
  const rows = db.prepare('SELECT gram FROM inverted ORDER BY gram LIMIT 2').all().map((r) => String(r.gram))
  assert.equal(rows.length, 2, '库里至少要有两个 gram（否则本断言无意义）')
  // 两个权重刻意取不同值：丢权重（`wq*wd` → `wd`）会让顺序与数值都变
  const weights = new Map([[rows[0], 0.75], [rows[1], 0.125]])
  const got = queryPostings(db, [...weights.keys()], weights)
  const postings = fetchPostings(db, [...weights.keys()])
  /** 现场重算（M10：自己按 postings 累加，不读被测实现的任何中间量） */
  const expect = new Map()
  for (const h of weights.keys()) {
    const e = postings.get(h)
    if (!e) continue
    for (const [di, wd] of e.p) expect.set(di, (expect.get(di) || 0) + weights.get(h) * wd)
  }
  db.close()
  assert.ok(expect.size > 0, '现场重算不得为空（空集合 = fail-open）')
  assert.deepEqual([...got.keys()].sort((a, b) => a - b), [...expect.keys()].sort((a, b) => a - b),
    '候选集合必须与现场重算一致')
  for (const [di, v] of expect) {
    assert.ok(Math.abs(got.get(di).score - v) < 1e-12,
      `候选 ${di}: got ${got.get(di).score}, expect ${v}（必须是 Σ wq×wd，不是 Σ wd）`)
  }
  // `df` = 命中的查询 gram 数（不是恒 0 —— 那是字段摆设）
  assert.ok([...got.values()].some((v) => v.df >= 1), 'df 必须表达"几路查询 gram 命中"')
})

test('★ 候选池超 20 篇（触发 candTopN 截断）时两后端仍逐位相同', () => {
  // 造 26 篇文档、都含同一个查询词 ⇒ 候选 > max(topK*4, 20) = 20 ⇒ 候选**截断**参与决策。
  // 截断依据是候选累加权重（Σ wq×wd），故这条能覆盖"候选生成本身"的差异（计划稿的 fixture 覆盖不到）。
  const dir = mkdtempSync(join(tmpdir(), 'yfw-bpar-many-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  for (let i = 0; i < 26; i++) {
    const reps = '研发费用'.repeat(1 + (i % 5))   // 词频不同 ⇒ postings 权重不同
    writeFileSync(join(personal, `doc${String(i).padStart(2, '0')}.md`), [
      '---', `name: doc${i}`, '---', `## 文档 ${i}`,
      `- [会话|口径] ${reps} 归集口径第${i}条 -- 人员人工、直接投入、折旧费用五类`,
    ].join('\n') + '\n', 'utf-8')
  }
  const s1 = createKnowledgeStore({ configDir: dir }); s1.load({ force: true })
  const q = '研发费用 归集 口径'
  const base = s1.search({ query: q, topK: 5 })
  // 截断确实发生了：26 篇全部含查询词，而 `total`（截断前参与打分的条数）正好等于候选池上限 20
  // —— 差额 6 篇是被 `cand` 的 `.slice(0, max(candTopN, topK*4, 20))` 丢掉的。
  assert.equal(s1.stats().docs, 26, 'fixture 必须是 26 篇（全含查询词）')
  assert.equal(base.total, 20, `候选必须被截断到 20 才能覆盖截断路径（实际 total=${base.total}）`)
  const baseItems = base.items.map((i) => [i.blockId, i.score])
  const s2 = toSqlite(dir)
  const after = s2.search({ query: q, topK: 5 })
  assert.deepEqual(after.items.map((i) => [i.blockId, i.score]), baseItems,
    '候选截断路径下两后端也必须逐位相同')
})
