// S5 Task 2：索引文本口径统一（`kernel/knowledge.mjs`）的回归测试。
//
// 被钉住的三件事：
//   ① 索引文本 = relationContent(b)（= stripTypePrefix(full || text)）——正文进倒排，
//      `snippet` 仍取 `b.text`（行为不变）；
//   ② INDEX_VERSION 1→2 后，**旧版本索引必须整体重建**（不报错、不静默返回空集），
//      且重建幂等、可重入（中断后重跑结果一致）；
//   ③ 全量构建与增量更新（updateDoc）**同一口径**，否则"改过一个文件"的库与全量重建
//      结果不一致（幂等性被打破）。
//
// 隔离纪律：全部走 mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking / ~/.yfw。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

// 深部词（'zqdeep'）刻意放在正文 60 字之后：旧口径（`b.text` = 类型前缀 + t.slice(0,60)）
// 根本索引不到它，新口径（full 去前缀）能召回 —— 这正是口径变更的可观测收益。
const DEEP = 'zqdeep'
const FILLER = '甲'.repeat(80)
const ENTRY_A = `- [会话|索引口径] 摘要短句 ${'摘要补齐'.repeat(2)} -- ${FILLER} ${DEEP} 后段标记`
// 摘要独有词（'zqsummary'）**只**在摘要里，正文与标签都没有 —— 口径变更的已知代价。
const ENTRY_B = `- [会话|索引口径] 独有摘要词 zqsummary 的条目 -- 正文与摘要无重叠的词`

function makeFixture({ entryB = ENTRY_B } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kidxtext-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', '---', ENTRY_A, entryB,
  ].join('\n') + '\n', 'utf-8')
  return { dir, personal }
}

const idxDir = (dir) => join(dir, 'knowledge', '.index')

test('索引文本取 relationContent：正文（full）深部词可召回，snippet 仍取 text', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })

    const r = store.search({ query: DEEP, topK: 3 })
    assert.equal(r.degraded, false, '正文 gram 进倒排 → 不降级')
    assert.ok(r.count >= 1, '只出现在正文深部（60 字之后）的词必须可召回')
    const top = r.items[0]
    assert.equal(top.blockId, 'experience/workflow.md#0', '命中的是正文含该词的条目块')
    // snippet 行为不变：仍取 `b.text`（摘要），不含正文独有词 —— 前端高亮/展示逻辑不受影响
    assert.match(top.snippet, /摘要短句/)
    assert.ok(!top.snippet.includes(DEEP), 'snippet 不得变成正文（否则前端展示会位移）')
    // mode='full' 仍返回正文（供消费方按需取全文）
    const full = store.search({ query: DEEP, topK: 1, mode: 'full' })
    assert.ok(full.items[0].snippet.includes(DEEP), "mode='full' 返回 full 正文")
    assert.equal(full.items[0].full.includes(DEEP), true, 'item.full 字段仍是正文')
    assert.ok(top.text.includes('摘要短句'), 'item.text 仍是摘要（未改口径）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('已知代价（钉住行为）：只出现在摘要、正文与标签都没有的词不再可检索', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    // 为什么钉住"查不到"：这是 S5 §8 口径变更的**真实代价**（真实库实测 59/76 条目的
    // 摘要与正文无重叠），不是缺陷、也不是漏改。写成用例是为了：若将来把口径改成
    // "relationContent ∪ 摘要"（Task 2 报告里的建议项），这条会立刻红，提醒改口径的人
    // 一并更新文档与前后对比，而不是悄悄漂移。
    const bare = store.search({ query: 'zqsummary', topK: 5 })
    assert.equal(bare.count, 0, '摘要独有词不进索引（两条路径口径一致，都不能召回）')
    const kw = store.search({ query: 'zqsummary', keywords: ['zqsummary'], topK: 5 })
    assert.equal(kw.count, 0, '关键词路同口径，也不能召回')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('manifest.version 不符（旧索引）→ load() 自动全量重建，非报错、非空集', async () => {
  const { dir } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    assert.equal(s1.stats().docs, 1)
    const manPath = join(idxDir(dir), 'manifest.json')
    const man = JSON.parse(readFileSync(manPath, 'utf-8'))
    assert.equal(man.version, 2, 'INDEX_VERSION 已 bump 到 2（spec §8）')
    // 伪造"口径变更前的旧索引"：版本号改回 1，并**清空 docs.jsonl**。
    // 若上层把旧索引当可复用，docs 会是 0（静默空集，S1 最怕的故障模式）；
    // 正确行为是判定"过期派生物"→ 整库重建。
    writeFileSync(manPath, JSON.stringify({ ...man, version: 1 }), 'utf-8')
    writeFileSync(join(idxDir(dir), 'docs.jsonl'), '', 'utf-8')

    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load() // 不传 force：走 loadIndexFromDisk → 版本不符 → buildIndex
    assert.equal(s2.stats().docs, 1, '版本不符必须触发重建（而不是复用出空集）')
    assert.equal(s2.stats().version, 2)
    assert.equal(JSON.parse(readFileSync(manPath, 'utf-8')).version, 2, '重建后 manifest 版本回写为 2')
    assert.ok(s2.search({ query: DEEP, topK: 3 }).count > 0, '重建后立即可检索')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('重建幂等且可重入：两次 force 落盘逐字节一致；索引被截断后 load() 可重跑', async () => {
  const { dir } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    const docs1 = readFileSync(join(idxDir(dir), 'docs.jsonl'), 'utf-8')
    const inv1 = readFileSync(join(idxDir(dir), 'inverted.jsonl'), 'utf-8')
    const hits1 = s1.search({ query: DEEP, topK: 3 }).items.map((x) => x.blockId)

    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load({ force: true })
    assert.equal(readFileSync(join(idxDir(dir), 'docs.jsonl'), 'utf-8'), docs1, '两次重建 docs.jsonl 逐字节一致')
    assert.equal(readFileSync(join(idxDir(dir), 'inverted.jsonl'), 'utf-8'), inv1, '两次重建 inverted.jsonl 逐字节一致')
    assert.deepEqual(s2.search({ query: DEEP, topK: 3 }).items.map((x) => x.blockId), hits1, '两次重建命中一致')

    // 模拟落盘中断（半写）：inverted.jsonl 截断成一半 → 行数少于 manifest.invLines
    writeFileSync(join(idxDir(dir), 'inverted.jsonl'), inv1.slice(0, Math.floor(inv1.length / 2)), 'utf-8')
    const s3 = createKnowledgeStore({ configDir: dir })
    await s3.load() // 不传 force：截断检测 → buildIndex
    assert.equal(s3.stats().docs, 1)
    assert.equal(readFileSync(join(idxDir(dir), 'inverted.jsonl'), 'utf-8'), inv1, '重跑后索引恢复为完整内容')
    assert.deepEqual(s3.search({ query: DEEP, topK: 3 }).items.map((x) => x.blockId), hits1, '重跑后命中一致')

    // 索引文件整体缺失（首次运行/被清理）也必须能重建
    rmSync(idxDir(dir), { recursive: true, force: true })
    const s4 = createKnowledgeStore({ configDir: dir })
    await s4.load()
    assert.equal(existsSync(join(idxDir(dir), 'manifest.json')), true)
    assert.ok(s4.search({ query: DEEP, topK: 3 }).count > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('增量（updateDoc）与全量（force）同口径：改后正文立即可检索且 top-1 一致', async () => {
  const { dir, personal } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.equal(store.search({ query: DEEP, topK: 1 }).items[0].blockId, 'experience/workflow.md#0')

    // 改文件：正文里的深部词换成 DEEP2（摘要不变）
    const DEEP2 = 'zqdeep2'
    writeFileSync(join(personal, 'workflow.md'), [
      '---', 'name: workflow', '---', ENTRY_A.replace(DEEP, DEEP2), ENTRY_B,
    ].join('\n') + '\n', 'utf-8')
    const r = await store.updateDoc('experience/workflow.md')
    assert.equal(r.updated, true)
    assert.equal(store.search({ query: DEEP2, topK: 3 }).items[0].blockId, 'experience/workflow.md#0',
      '增量路必须用同一 indexTextOf —— 否则改过的文档与其余文档不同口径')
    assert.equal(store.search({ query: DEEP, topK: 3 }).count, 0, '旧正文词随内容替换退出索引')

    // 与"另起一个实例全量重建"的结果对齐（同口径 ⇒ 同一 top-1）
    const fresh = createKnowledgeStore({ configDir: dir })
    await fresh.load({ force: true })
    assert.equal(fresh.search({ query: DEEP2, topK: 3 }).items[0].blockId, 'experience/workflow.md#0')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
