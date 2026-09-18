// 检索量尺**自身**的测试（P0 配套，2026-09-18）
// ---------------------------------------------------------------------------
// 量尺是"改打分公式"的判据 —— 判据本身错了，比没有判据更糟（会把人引向错误结论）。
// 故这里锁住四件事：
//   ① 构造出的金标用例，其正解在**当前实现**下确实可达（否则指标里的 miss 是量尺的锅）；
//   ② 可复现：同 seed → 同一套用例（否则基线 diff 混入抽样噪声）；
//   ③ 判定口径：负例假阳性、diff 的 regression 判定按文档承诺工作；
//   ④ 语料指纹随语料变化（指纹不变说明它没真的参与计算）。
//
// 语料用临时 configDir 隔离（同 knowledge-search.test.mjs 的 fixture 纪律）：
// 绝不去读用户的真实库 —— 测试必须可离线、可重复、不依赖本机数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import {
  buildGoldCases, buildHumanCases, buildNegativeCases, runEval, corpusDigest, diffSummary,
} from '../scripts/eval-retrieval.mjs'

/**
 * 造一小库（**错开共享**是刻意的）。
 *
 * 金标构造的 `minDf=2` 要求候选 gram 至少出现在 2 个块里（df=1 的 gram 在中文语料里
 * 几乎必然是跨词边界的噪音片段，见 buildGoldCases 的 minDf 注释）。但"df≥2"与
 * "组合能收敛到唯一块"是**一对张力**：若所有共享词都覆盖同一批块，交集永远收敛不下来。
 * 故这里让共享关系**错开**：f1 与 f2 共享"渠道"、f1 与 f3 共享"锚点" ——
 * 于是 f1 能被两个词的组合唯一定位（f1 的用例可构造），而 f2/f3 单独构不成唯一（正常：
 * 真实语料里也有大量 skippedNotUnique，量尺不该假装每个块都能当金标）。
 *
 * 每篇**一个文件**：连续的 `- ` 行会被 splitBlocks 合并成一个 list 块，同文件多条会塌成一块。
 */
function fixture({ extra = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-eval-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  const w = (name, body) => writeFileSync(join(personal, name), `${body}\n`, 'utf-8')
  w('f1.md', '- [会话|甲] 渠道 锚点 -- 两条共享词同时落在这个块里，它就能被组合唯一定位')
  w('f2.md', '- [会话|乙] 渠道 补记 -- 与 f1 共享"渠道"，单独成不了唯一正解')
  w('f3.md', '- [会话|丙] 锚点 补记 -- 与 f1 共享"锚点"，单独也成不了唯一正解')
  if (extra) w('other.md', extra)
  return dir
}

function load(dir) {
  const store = createKnowledgeStore({ configDir: dir })
  store.load({})
  return store
}

test('量尺：金标用例可构造且正解在当前实现下可达', () => {
  const dir = fixture()
  try {
    const store = load(dir)
    const gold = buildGoldCases(store, { limit: 20, seed: 1 })
    assert.ok(gold.blocks > 0, '语料里应看到块')
    assert.ok(gold.cases.length > 0, `应构造出用例（跳过统计 ${JSON.stringify({ noGram: gold.skippedNoGram, notUnique: gold.skippedNotUnique })}）`)
    for (const c of gold.cases) {
      assert.ok(c.expect && c.expect.includes('#'), '正解必须是块 id')
      assert.ok(c.query.trim().length > 0)
      assert.ok(['precise', 'noisy'].includes(c.type))
    }
    const r = runEval({ store, cases: gold.cases, topK: 5 })
    // 小库里每个块的内容都独特 → 定位应全中。这里有 miss 就说明"量尺构造的金标"与
    // "引擎实际能返回的东西"不一致（量尺的锅），必须修量尺而不是改引擎。
    assert.equal(r.summary.recallAtK, 1, `小库应全中，实际 ${JSON.stringify(r.results.filter((x) => !x.hitAtK))}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('量尺：同 seed 产出同一套用例（可复现），不同 seed 允许不同', () => {
  const dir = fixture()
  try {
    const store = load(dir)
    const a = buildGoldCases(store, { limit: 20, seed: 42 })
    const b = buildGoldCases(store, { limit: 20, seed: 42 })
    assert.deepEqual(a.cases, b.cases, '同 seed 必须逐字段一致，否则基线 diff 混入抽样噪声')
    // 语料很小、用例数远少于块数时两 seed 可能恰好同序：只在"存在多块可选"时比较
    const c = buildGoldCases(store, { limit: 20, seed: 43 })
    assert.equal(c.cases.length, a.cases.length, '样例条数不应随 seed 变（只应换样本）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('量尺：负例集不含真实 gram，且实测零假阳性', () => {
  const dir = fixture()
  try {
    const store = load(dir)
    const neg = buildNegativeCases(store, { count: 8 })
    assert.ok(neg.length > 0)
    const r = runEval({ store, cases: [], negatives: neg, topK: 5 })
    assert.equal(r.summary.negatives.falsePositive, 0,
      `乱码查询不应有命中，实际 ${JSON.stringify(r.negResults.filter((x) => x.count > 0))}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('量尺：human 集跳过"期望文档不在本库"的条目（不把它算成 miss）', () => {
  const dir = fixture()
  try {
    const store = load(dir)
    const { cases, skipped } = buildHumanCases(store, [
      { query: '渠道 锚点', expectDoc: 'f1.md' },                    // 存在
      { query: '不存在的主题', expectDoc: 'nope/whatever.md' },       // 不存在 → 跳过
    ])
    assert.equal(cases.length, 1)
    assert.equal(skipped.length, 1)
    assert.equal(cases[0].type, 'human')
    const r = runEval({ store, cases, topK: 5 })
    // human 走**文档级**判定：命中同文档即算命中，不要求块号
    assert.equal(r.summary.cases, 1)
    assert.ok(r.results[0].docRank !== null, '应记录文档级排名')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('量尺：语料指纹随语料变化，diff 只在同语料下判定通过', () => {
  const dir = fixture()
  const dir2 = fixture({ extra: '- [会话|额外] 新增一篇 -- 这篇文档的内容只在第二个库里出现\n' })
  try {
    const s1 = load(dir)
    const s2 = load(dir2)
    const d1 = corpusDigest(s1)
    const d2 = corpusDigest(s2)
    assert.notEqual(d1.digest, d2.digest, '加了文档，指纹必须变（不变说明没参与计算）')
    assert.equal(corpusDigest(load(dir)).digest, d1.digest, '同一库两次必须一致')

    const gold = buildGoldCases(s1, { limit: 10, seed: 5 })
    const r = runEval({ store: s1, cases: gold.cases, topK: 5 })
    const cur = { summary: r.summary, corpus: d1 }
    const same = diffSummary({ summary: r.summary, corpus: d1 }, cur)
    assert.equal(same.sameCorpus, true)
    assert.equal(same.regression.ok, true, '自己比自己必须判定通过')

    // 退化场景：召回下降必须被判为回归（否则门禁形同虚设）
    const worse = {
      summary: { ...r.summary, autoRecallAtK: r.summary.autoRecallAtK - 0.1 },
      corpus: d1,
    }
    const d = diffSummary({ summary: r.summary, corpus: d1 }, worse)
    assert.equal(d.regression.ok, false)
    assert.ok(d.regression.worse.includes('autoRecallAtK'))

    // 负例假阳性上升同样必须判回归（比漏召回更伤人）
    const fp = { summary: { ...r.summary, negatives: { ...r.summary.negatives, rate: 0.2 } }, corpus: d1 }
    assert.ok(diffSummary({ summary: r.summary, corpus: d1 }, fp).regression.worse.includes('negativeFp'))

    // 语料变了必须出声（防止拿"换了语料"冒充"改好了"）
    assert.equal(diffSummary({ summary: r.summary, corpus: d1 }, { summary: r.summary, corpus: d2 }).sameCorpus, false)
    // 指纹挂在 meta.corpus 下（CLI 落盘的完整 payload 形状）也必须认得 —— 否则
    // `--baseline <完整 payload>` 会恒报"语料不同"，把真警告稀释成例行噪声（狼来了）
    assert.equal(
      diffSummary({ meta: { corpus: d1 }, summary: r.summary }, { summary: r.summary, corpus: d1 }).sameCorpus,
      true,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
  }
})

test('量尺：空语料不抛异常（新装用户跑量尺应得到明确结论而非崩溃）', () => {
  const dir = join(tmpdir(), `ponos-eval-empty-${process.pid}-${Date.now()}`)
  try {
    const store = load(dir)
    const gold = buildGoldCases(store, { limit: 10 })
    assert.equal(gold.cases.length, 0)
    assert.equal(gold.blocks, 0)
    const neg = buildNegativeCases(store, { count: 3 })
    assert.equal(neg.length, 3, '没有语料时任何 gram 都"不存在"，负例应能凑齐')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
