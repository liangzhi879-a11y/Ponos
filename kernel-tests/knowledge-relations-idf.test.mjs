// S5 二次校准修正：**覆盖层必须真的产出 content 边** + 关联层 idf 口径 = 按文档聚合。
//
// 病灶（实测）：Task 4/5 落地后真实库 `related.jsonl` 里 tag 边 258 / duplicate 2 /
// **content 边 0 条**——覆盖层空转。根因：① 首轮校准的 idf 口径（`blockIndexText`）与线上
// （`relationContent`）不同源；② 线上 idf 是**按块**统计（每块一个 gramCounts），高频词 df
// 增长快于文档数 → 常见词权重被抬高 → 向量平均化 → 区分度下降（实测跨 tag 对最高 cos
// 按块 0.238 vs 按文档 0.312），阈值 0.32 在两种口径下都命中 0 对。
//
// 本文件钉住两件事：
//   ① 阈值 0.15 + 按文档 idf ⇒ 语义相近、tag 不同的条目**能**产出 content 边（不是空转），
//      且每条带非空 `shared`（可解释性硬约束）；
//   ② **关联层用的是「按文档」idf，不是检索那份「按块」idf** —— 用"边上的 score 必须等于
//      按文档口径算出的余弦、且该语料下按块口径明显不同（>0.01）"这条可观测断言锁住口径。
//      谁把 `buildRelIdf()` 换回检索 idf，这个断言立刻红。
//
// 隔离纪律：mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking / ~/.yfw。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import {
  SIM_THRESHOLD, DUP_COS, MIN_LEN,
  relationContent, countGrams, buildIdf, vectorizeText, cosine,
} from '../shared/knowledge-core.mjs'

const idxDir = (dir) => join(dir, 'knowledge', '.index')
const relRows = (dir) => readFileSync(join(idxDir(dir), 'related.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
const relLineCount = (dir) => readFileSync(join(idxDir(dir), 'related.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).length
const manifestOf = (dir) => JSON.parse(readFileSync(join(idxDir(dir), 'manifest.json'), 'utf-8'))

function makePersonal(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  return { dir, personal }
}

// ── ① 覆盖层产出性夹具：两对语义相近但 tag 不同 + 一条无关条目（噪声护栏）────────
const T1 = '核销单导出流程要先把明细按门店汇总再写盘，否则同一门店被拆成多行导致对账失败'
const T2 = '核销单导出流程要先把明细按门店汇总再写盘，否则同门店拆成多行会让对账结果对不上'
const T3 = '打包知识包前必须校验清单与文件一一对应，缺一个就会让安装方静默少装文档'
const T4 = '打包知识包之前要逐条校验清单和文件是否对应，缺项会让安装方少装文档且不报错'
const T5 = '企微通讯录同步需要先拉全量再按部门做差集比对，避免把已离职同事重新写回组织架构'

function makeCoverageFixture() {
  const { dir, personal } = makePersonal('ponos-krel-idf-')
  const lines = [
    `- [会话|核销甲] 核销条目甲 -- ${T1}`,
    `- [会话|核销乙] 核销条目乙 -- ${T2}`,
    `- [会话|打包甲] 打包条目甲 -- ${T3}`,
    `- [会话|打包乙] 打包条目乙 -- ${T4}`,
    `- [会话|通讯录] 通讯录条目 -- ${T5}`,
  ]
  writeFileSync(join(personal, 'coverage.md'), lines.join('\n') + '\n', 'utf-8')
  return { dir }
}

test('覆盖层产出性：语义相近的跨 tag 条目必须产出 content 边（阈值 0.15 的回归锁）', async () => {
  const { dir } = makeCoverageFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const rows = relRows(dir)
    const doc = 'experience/coverage.md'
    const outOf = (n) => rows.filter((r) => r.from === `${doc}#${n}`)

    // 覆盖层不是空转：两对相近条目各自产出 content 边（双向物化 ⇒ 每对 2 行）
    const pair = (a, b) => outOf(a).find((r) => r.to === `${doc}#${b}`)
    const c1 = pair(0, 1)
    const c2 = pair(2, 3)
    assert.equal(c1?.why.kind, 'content', `跨 tag 相近对 #0↔#1 必须是 content 边（实测 ${JSON.stringify(c1?.why)}）`)
    assert.equal(c2?.why.kind, 'content', `跨 tag 相近对 #2↔#3 必须是 content 边（实测 ${JSON.stringify(c2?.why)}）`)
    for (const c of [c1, c2]) {
      assert.ok(c.why.score >= SIM_THRESHOLD && c.why.score < DUP_COS,
        `content 边分数必须落在 [${SIM_THRESHOLD}, ${DUP_COS})（实测 ${c.why.score}）`)
      assert.ok(Array.isArray(c.why.shared) && c.why.shared.length > 0, 'content 边必须有可解释的 shared')
    }
    // 全库每条 content 边都带非空 shared（可解释性硬约束，spec §5.4）
    for (const r of rows.filter((x) => x.why.kind === 'content')) {
      assert.ok(r.why.shared.length > 0, `content 边 ${r.from}->${r.to} 的 shared 为空`)
    }
    // 噪声护栏：与任何条目都不相近的 #4 不得被卷进 content 边（阈值不是低到"人人有份"）
    assert.ok(!outOf(4).some((r) => r.why.kind === 'content'),
      `无关条目 #4 不该有 content 锚点（实测 ${JSON.stringify(outOf(4).map((r) => [r.to, r.why]))}）`)
    // 顺带：relLines 指纹仍与实际行数一致（改口径不许破坏物化不变量）
    assert.equal(manifestOf(dir).relLines, relLineCount(dir))
    assert.equal(manifestOf(dir).relLines, rows.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── ② 口径锁夹具：目标对相近 + 一批「通用说明」填充块（抬高按块 idf 的常见词 df）────
const COMMON = '本条通用工程说明用于验证阈值行为，涉及目录清理与产物校验的常规步骤记录，属于噪声填充文本'
const PA = '前端构建说明：产物目录必须先清空再打包，否则旧 chunk 会被一起发布，用户拿到不一致的版本'
const PB = '前端构建说明：打包前要清空产物目录，旧 chunk 一起发布会让用户拿到不一致版本'

function makeIdfCaliberFixture() {
  const { dir, personal } = makePersonal('ponos-krel-idf-cal-')
  for (let d = 0; d < 6; d++) {
    const lines = []
    for (let i = 0; i < 4; i++) lines.push(`- [会话|通用${d}-${i}] 通用${d}-${i} -- ${COMMON}（文档${d}第${i}段）`)
    for (let i = 0; i < 3; i++) {
      lines.push(`- [会话|专有${d}-${i}] 专有${d}-${i} -- 文档${d}第${i}条独有记录，讨论完全不同的主题与结论`)
    }
    writeFileSync(join(personal, `f${d}.md`), lines.join('\n') + '\n', 'utf-8')
  }
  writeFileSync(join(personal, 't1.md'), `- [会话|前端甲] 目标甲 -- ${PA}\n`, 'utf-8')
  writeFileSync(join(personal, 't2.md'), `- [会话|前端乙] 目标乙 -- ${PB}\n`, 'utf-8')
  return { dir }
}

/** 在给定 idf 样本集下重算 content 边的余弦（与内核同款公式）。 */
function cosUnder(idfSamples, a, b) {
  const idf = buildIdf(idfSamples)
  return cosine(
    vectorizeText(a, { tagBoost: 1, idf }),
    vectorizeText(b, { tagBoost: 1, idf }),
  )
}

test('口径锁：content 边分数 = 按文档 idf 的余弦（不是检索那份按块 idf）', async () => {
  const { dir } = makeIdfCaliberFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const rows = relRows(dir)
    const edge = rows.find((r) => r.from === 'experience/t1.md#0' && r.to === 'experience/t2.md#0')
    assert.equal(edge?.why.kind, 'content', `夹具必须产出目标 content 边（实测 ${JSON.stringify(edge?.why)}）`)

    // 用索引里的真实块文本重建两种 idf 口径（与 kernel 的 buildRelIdf / buildIndex 同款）
    const docs = readFileSync(join(idxDir(dir), 'docs.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const relContentOf = new Map()
    for (const d of docs) for (const b of d.blocks) relContentOf.set(`${d.id}#${b.n}`, relationContent(b))
    const all = [...relContentOf.values()]
    const perBlock = all.map((rc) => ({ gramCounts: countGrams(rc) }))
    const perDoc = docs.map((d) => {
      const m = new Map()
      for (const b of d.blocks) for (const [g, c] of countGrams(relationContent(b))) m.set(g, (m.get(g) || 0) + c)
      return { gramCounts: m }
    })
    const A = relContentOf.get('experience/t1.md#0')
    const B = relContentOf.get('experience/t2.md#0')
    assert.ok(A.length >= MIN_LEN && B.length >= MIN_LEN)

    const docBased = cosUnder(perDoc, A, B)
    const blockBased = cosUnder(perBlock, A, B)
    // 前提：该语料下两种口径确实不同 —— 否则下面的断言区分不了口径，等于没锁
    assert.ok(Math.abs(docBased - blockBased) > 0.01,
      `夹具必须让两种 idf 口径产生可区分的分数（按文档 ${docBased} / 按块 ${blockBased}）`)
    // 边上的 score 是 round4 后的值 ⇒ 必须等于按文档口径的那一个
    assert.equal(edge.why.score, Number(docBased.toFixed(4)),
      `content 边分数必须来自「按文档 idf」（按块口径会是 ${blockBased.toFixed(4)}）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
