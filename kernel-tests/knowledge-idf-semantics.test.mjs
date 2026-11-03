// 守卫 spec §2.5 的陷阱：盘上 inverted.df 是**文档级**，而 load() 算 idf 用**块级** df。
// 两者实测仅 43.8% 相等；若有人"顺手复用盘上 df 省 buildIdf"，排序会静默改变。
// ★ 关键设计：fixture 让同一个 gram 在**同一文档的两个块**里出现 ⇒ 块级 df 严格大于文档级 df，
//   于是"两种口径不同"这件事在测试里可断言（而不是靠抽样或"看起来不同"）。
//
// ★ 与实施计划的一处**实测校正**（2026-09-30，实施时发现，已记入汇报）：
//   计划稿里假定 `getIdf()` 的键是 `hashLine(gram)`；实测**不是** ——
//     · `idf` 的键是 **gram 文本**（`buildIdf` 直接吃 `gramCounts.keys()`，未过 hash）；
//     · 只有倒排（内存 `inverted` / 盘上 `inverted.jsonl#g`）的键才是 **8 位 hash 串**。
//   故本测试同时维护两个键空间：idf 比对用 gram 文本，盘上 df 比对用 hash。
//   口径断言（块级 df + N=块数；盘上 df 是文档级）**一字未改**，实测 68/68 逐 gram 相等。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import {
  countGrams, hashLine, blockIndexText, retrievalText, parseJsonl,
} from '../shared/knowledge-core.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-idf-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  // a.md 里「研发」出现在**两个块**（heading + entry）⇒ 该 gram 块级 df = 2、文档级 df = 1
  writeFileSync(join(personal, 'a.md'), [
    '---', 'name: a', '---',
    '## 研发费用',
    '- [会话|高企口径] 研发费用归集口径 -- 人员人工、直接投入、折旧费用、无形资产摊销、其他费用五类',
    '## 收入口径',
    '- [会话|高企口径] 高新收入占比 -- 近一年高新技术产品收入占同期总收入比例不低于60%',
  ].join('\n') + '\n', 'utf-8')
  writeFileSync(join(personal, 'b.md'), [
    '---', 'name: b', '---',
    '- [会话|知识产权] 研发费用与知识产权 -- 一类知识产权按1件计，二类按数量折算',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

// 与 kernel/knowledge.mjs#indexTextOf 同式（逐字对齐；改了那边就必须改这里，这是有意的"双写守卫"）
const indexTextOf = (b) => blockIndexText({ kind: b.kind, text: retrievalText(b), entryTag: b.tag })

/**
 * 现场重算两种 df（M10：绝不读实现内部变量，也不读实现自己的产物当答案）。
 * 两个键空间都要给出（见文件头注释）：
 *   · `blockDf` / `docDf`   = **gram 文本** → 计数（`idf` 的键空间）
 *   · `blockDfHash` / `docDfHash` = **gram hash** → 计数（`inverted.jsonl#g` 的键空间）
 */
function recompute(store) {
  const blockDf = new Map()
  const docDf = new Map()
  const blockDfHash = new Map()
  const docDfHash = new Map()
  let nBlocks = 0
  for (const d of store.getDocs()) {
    const perDoc = new Set()
    const perDocHash = new Set()
    for (const b of d.blocks) {
      nBlocks += 1
      for (const g of countGrams(indexTextOf(b)).keys()) {
        blockDf.set(g, (blockDf.get(g) || 0) + 1)
        const h = hashLine(g)
        blockDfHash.set(h, (blockDfHash.get(h) || 0) + 1)
        perDoc.add(g)
        perDocHash.add(h)
      }
    }
    for (const g of perDoc) docDf.set(g, (docDf.get(g) || 0) + 1)
    for (const h of perDocHash) docDfHash.set(h, (docDfHash.get(h) || 0) + 1)
  }
  return { blockDf, docDf, blockDfHash, docDfHash, nBlocks }
}

/**
 * 断言 `store.getIdf()` 与现场重算的「块级 df + N=块数」逐 gram 一致。
 *
 * ★ 为什么要抽成函数并在**两条路径**上各调一次（首建 / 从盘重载）：
 *   计划稿原本只在"首次 load"上断言，而首建走的是 `buildIndex()`；真正有"顺手复用盘上 df"
 *   诱惑的是 `loadIndexFromDisk()`（那正是 spec §2.2 里 696 ms 的全库重算所在，
 *   盘上恰好躺着一份**文档级** df 看起来能直接省掉它）。实测：把 idf 改成复用盘上 df 后，
 *   只跑首建路径的断言**照样全绿** ⇒ 那条守卫守不住它声称要守的东西。
 *   故这里对"从盘重载"同样逐 gram 断言，并用 `builtAt` 证明确实走的是重载（而非悄悄重建）。
 */
function assertIdfMatches(store, label) {
  const { blockDf, nBlocks } = recompute(store)
  assert.ok(nBlocks > 0 && blockDf.size > 0, '现场重算不得为空（fail-closed）')
  const idf = store.getIdf()
  assert.equal(idf.size, blockDf.size, `${label}: idf 词表规模必须等于现场重算的块级词表规模`)
  for (const [g, df] of blockDf) {
    const expect = Math.log((nBlocks + 1) / (df + 1)) + 1
    const got = idf.get(g)
    assert.ok(got !== undefined, `${label}: idf 缺少 gram ${g}`)
    assert.ok(Math.abs(got - expect) < 1e-9, `${label}: gram ${g}: got ${got}, expect ${expect}（N 必须是块数）`)
  }
}

test('load 后的 idf == 现场重算的「块级 df + N=块数」idf（逐 gram；首建 + 从盘重载两条路径）', () => {
  const dir = fixture()
  // 路径 A：索引不存在 ⇒ buildIndex()（全库分词 → buildIdf）
  const built = createKnowledgeStore({ configDir: dir })
  built.load({})
  assertIdfMatches(built, '首建路径')
  // 路径 B：索引已在盘上 ⇒ loadIndexFromDisk()（"顺手复用盘上文档级 df"的诱惑点）
  const onDisk = JSON.parse(readFileSync(join(dir, 'knowledge', '.index', 'manifest.json'), 'utf-8'))
  const reloaded = createKnowledgeStore({ configDir: dir })
  reloaded.load({})
  assert.equal(reloaded.stats().builtAt, onDisk.builtAt,
    '重载路径必须真的读到盘上索引（builtAt 与 manifest 不符 ⇒ 它其实重建了，本断言会退化成空断言）')
  assertIdfMatches(reloaded, '从盘重载路径')
})

test('盘上 inverted.df 的语义是**文档级**（改它必须同步改 load 与 idf 来源）', () => {
  const dir = fixture()
  const store = createKnowledgeStore({ configDir: dir })
  store.load({})
  const { docDfHash } = recompute(store)
  const rows = parseJsonl(readFileSync(join(dir, 'knowledge', '.index', 'inverted.jsonl'), 'utf-8'))
  assert.ok(rows.length > 0, '倒排文件必须存在')
  let compared = 0
  for (const r of rows) {
    const expect = docDfHash.get(String(r.g))
    if (expect === undefined) continue
    compared += 1
    assert.equal(r.df, expect, `盘上 df 必须是文档级（gram ${r.g}）`)
  }
  assert.ok(compared > 0, '至少比对到一个 gram（空集合 = fail-open）')
})

test('两口径确实不同：同一 gram 跨块出现时 块级 df > 文档级 df', () => {
  const dir = fixture()
  const store = createKnowledgeStore({ configDir: dir })
  store.load({})
  const { blockDfHash, docDfHash, blockDf, docDf } = recompute(store)
  // 找出 fixture 里实际跨块出现的 gram（不写死 bigram 字面量，避免分词边界差异导致假红）
  const strict = [...blockDfHash.keys()].filter((h) => blockDfHash.get(h) > (docDfHash.get(h) || 0))
  assert.ok(strict.length > 0, 'fixture 必须造出"跨块出现的 gram"（否则本测试无法证明两口径不同）')
  const h = strict[0]
  assert.ok(blockDfHash.get(h) > docDfHash.get(h), `块级 df 必须严格大于文档级 df（gram hash ${h}）`)
  // 同一批 gram 在 gram 文本键空间上也是"块级 > 文档级"（证明两个键空间口径一致，不是映射错了）
  const strictText = [...blockDf.keys()].filter((g) => blockDf.get(g) > (docDf.get(g) || 0))
  assert.ok(strictText.length > 0, 'gram 文本键空间同样必须存在跨块 gram')
})
