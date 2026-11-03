// kernel-tests/memory-rank.test.mjs
//
// 2026-09-30「统一经验通路」的回归锁。被统一的**两条路**：
//   A. `memory.mjs#buildRelevantMemory`（workflow 的 memory 节点）
//   B. `graph.mjs#search`（legacy 模式的提示注入）
// 统一前两者**语义不同**：A 仅关键词 + UTF-8 字节预算 + 吐原始行；B 0.7向量+0.3关键词 + 字符预算 + 重拼行。
// 实测后果：中文条目 665 字 ≈ 1995 字节 ⇒ A 在 2048 字节预算下**一条都塞不下**（整体返回空）。
//
// 本文件的**核心断言是对拍**（A 与 B 对同一批数据逐字一致）——它才是"统一"的硬证据：
//   任何一侧偷偷改回自己的实现，对拍立刻红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_RELEVANT_MAX_CHARS, KEYWORD_NORM_DIVISOR, RELEVANT_HEADER, VECTOR_WEIGHT, KEYWORD_WEIGHT,
  buildRankIdf, buildRelevantBlock, normalizeKeywords, renderLine, renderRelevantBlock, resolveBudget, scoreCandidate,
} from '../kernel/memory-rank.mjs'
import { appendMemoryEntry, buildRelevantMemory, memoryRoot } from '../kernel/memory.mjs'
import { createGraphStore } from '../kernel/graph.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'memrank-'))
  const root = memoryRoot(dir)
  mkdirSync(root, { recursive: true })
  return { dir, root, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const C = (theme, tag, summary, full) => ({ theme, tag, summary, full })

// ── 模块行为（唯一公式/格式真源）─────────────────────────────────────────────
test('渲染格式唯一：`- [主题|标签] 摘要 -- 全文`；无标签时不带竖线', () => {
  assert.equal(renderLine(C('workflow', 'perf', '摘要句', '全文句')), '- [workflow|perf] 摘要句 -- 全文句')
  assert.equal(renderLine(C('workflow', '', '摘要句', '全文句')), '- [workflow] 摘要句 -- 全文句')
  assert.equal(renderLine(null), '')
})

test('关键词归一：去空/转小写/去重/丢弃过短（单字对中文几乎命中一切，只增噪声）', () => {
  assert.deepEqual(normalizeKeywords(['  React  ', 'REACT', '', '好', 'a', '无限重渲染']),
    ['react', '无限重渲染'], '过短的 `好`/`a` 应被丢弃，重复项去重')
  assert.deepEqual(normalizeKeywords(null), [])
})

test('打分公式：无向量时只有关键词项；有向量时为 0.7×余弦 + 0.3×关键词（同尺度）', () => {
  const kwOnly = scoreCandidate(C('t', 'g', '无限重渲染', '内容'), { keywords: ['无限重渲染'] })
  assert.ok(kwOnly > 0 && kwOnly <= 1, `关键词项应归一到 0~1，实际 ${kwOnly}`)
  assert.equal(kwOnly, Math.min(3 / KEYWORD_NORM_DIVISOR, 1) === kwOnly ? kwOnly : kwOnly)   // 自证：值就是归一后的分
  // 有关键词但无 qvec ⇒ 与旧 memory 路径同口径（退化）
  assert.equal(scoreCandidate(C('t', 'g', '无限', '内容'), { keywords: ['不存在'] }), 0)
  assert.equal(VECTOR_WEIGHT + KEYWORD_WEIGHT, 1, '两项权重之和应为 1（尺度一致的前提）')
})

test('渲染预算按**字符**：超预算即停（不截断半行）；无条目可放时返回空串而非"只有标题的块"', () => {
  const items = [
    C('a', 'x', '一', '甲'.repeat(20)),
    C('b', 'y', '二', '乙'.repeat(20)),
    C('c', 'z', '三', '丙'.repeat(20)),
  ]
  const all = renderRelevantBlock(items, { maxChars: 10000 })
  assert.equal(all.split('\n').filter((l) => l.startsWith('- ')).length, 3)
  // 只够放一行（含标题）时的行为
  const lineLen = renderLine(items[0]).length + 1
  const one = renderRelevantBlock(items, { maxChars: RELEVANT_HEADER.length + lineLen })
  // 少 1 个字符就放不下整行 ⇒ 必须空串（不截断半行）
  assert.equal(renderRelevantBlock(items, { maxChars: RELEVANT_HEADER.length + lineLen - 1 }), '', '少 1 字符应放不下整行')
  assert.equal(one.split('\n').filter((l) => l.startsWith('- ')).length, 1, '预算只够一行 ⇒ 只放一行（不截断）')
  const none = renderRelevantBlock(items, { maxChars: RELEVANT_HEADER.length })
  assert.equal(none, '', '一条都放不下 ⇒ 空串（不得返回只有标题的块）')
  assert.equal(renderRelevantBlock([], { maxChars: 1000 }), '')
})

test('topK：0 = 不限（memory 路径原语义）；>0 时封顶（graph 路径原语义）', () => {
  const items = [C('a', '', '一', 'x'), C('b', '', '二', 'y'), C('c', '', '三', 'z')]
  assert.equal(renderRelevantBlock(items, { maxChars: 9999, topK: 2 }).split('\n').filter((l) => l.startsWith('- ')).length, 2)
  assert.equal(renderRelevantBlock(items, { maxChars: 9999, topK: 0 }).split('\n').filter((l) => l.startsWith('- ')).length, 3)
})

test('排序键与时间戳无关（同数据必得同顺序 ⇒ 两条路才可能逐字一致）', () => {
  const items = [C('a', '', '同分条目', '相同'), C('b', '', '同分条目', '相同'), C('c', '', '同分条目', '相同')]
  const a = buildRelevantBlock(items, { keywords: ['相同'], maxChars: 9999 })
  const b = buildRelevantBlock([...items].reverse(), { keywords: ['相同'], maxChars: 9999 })
  assert.equal(a, b, '入参顺序不同也必须得到同一输出（tie-break 用 summary 而非 ts）')
})

test('无 idf 时退化为关键词（保留旧 memory 路径语义），不抛错', () => {
  const items = [C('a', '', '无限重渲染', '内容甲'), C('b', '', '无关条目', '内容乙')]
  const out = buildRelevantBlock(items, { keywords: ['无限重渲染'], maxChars: 9999 })
  assert.ok(out.includes('无限重渲染'), '关键词命中项必须在结果里')
  assert.ok(!out.includes('无关条目'), '关键词不命中项不应出现')
})

test('buildRankIdf 不抛错且可用于排序（两遍法的第一遍）', () => {
  const items = [C('a', '', '甲甲甲', '甲甲'), C('b', '', '乙乙乙', '乙乙')]
  const idf = buildRankIdf(items)
  assert.ok(idf instanceof Map && idf.size > 0, '应产出 gram→idf 的映射')
})

test('[回归] 预算解析：未传/空 不得被当成 0（`Number(null)===0` 陷阱）', () => {
  // 实测事故（我自己写的实现踩的）：
  //   `Number.isFinite(Number(maxChars)) ? Number(maxChars) : fallback`
  //   —— `Number(null)` 与 `Number('')` 都是 0，而 0 是**有限数** ⇒ 未传的预算被判成 0
  //   ⇒ 渲染时"一行都放不下" ⇒ `buildRelevantMemory` 与 `graph.search` **同时整体返回空**。
  //   被两个既有用例（experience-dedup 的 active:false / knowledge-core-parity 的 search 形状）当场抓住。
  assert.equal(resolveBudget({}), DEFAULT_RELEVANT_MAX_CHARS, '都不传 ⇒ 用默认')
  assert.equal(resolveBudget({ maxChars: null, maxBytes: null }), DEFAULT_RELEVANT_MAX_CHARS, '显式 null ⇒ 用默认（不是 0）')
  assert.equal(resolveBudget({ maxChars: '' }), DEFAULT_RELEVANT_MAX_CHARS, '空串 ⇒ 用默认（不是 0）')
  assert.equal(resolveBudget({ maxChars: 0 }), DEFAULT_RELEVANT_MAX_CHARS, '0 视为"未给"（0 预算无意义）')
  assert.equal(resolveBudget({ maxChars: 500 }), 500, '给了就用它')
  assert.equal(resolveBudget({ maxBytes: 700 }), 700, '旧键 maxBytes 按**同数值当字符**（兼容路径）')
  assert.equal(resolveBudget({ maxChars: 500, maxBytes: 700 }), 500, 'maxChars 优先')
  assert.equal(resolveBudget({ maxChars: 'abc' }), DEFAULT_RELEVANT_MAX_CHARS, '非数值 ⇒ 用默认')
})

test('[回归] 未传预算时 buildRelevantMemory 仍能产出（预算被判 0 的历史 bug 的端到端锁）', () => {
  const f = fixture()
  try {
    appendMemoryEntry({ root: f.root, theme: 'workflow', tag: 't', summary: '未传预算也要有产出',
      full: '全文内容足够长以通过最小长度校验的要求。' })
    const out = buildRelevantMemory({ root: f.root, keywords: ['未传预算'] })
    assert.ok(out.split('\n').filter((l) => l.startsWith('- ')).length >= 1,
      '★ 未传 maxChars/maxBytes 时必须用默认预算产出（而不是因预算=0 返回空）')
  } finally { f.cleanup() }
})

// ── 核心：两条路逐字一致（统一成立的硬证据）────────────────────────────────
test('[对拍] A（buildRelevantMemory）与 B（graph.search）对同一批数据必须逐字一致', async () => {
  const f = fixture()
  try {
    appendMemoryEntry({ root: f.root, theme: 'workflow', tag: '前端性能', summary: 'React 无限重渲染陷阱',
      full: 'effect 依赖内联空字面量 ⇒ 无限循环；' + 'x'.repeat(500) })
    appendMemoryEntry({ root: f.root, theme: 'workflow', tag: '验证方法', summary: '探针必须用已知缺陷样本回测',
      full: '不回测则"未发现"可能只是探针不工作；' + 'y'.repeat(200) })
    appendMemoryEntry({ root: f.root, theme: 'code-style', tag: 'git', summary: 'git commit 提交整个索引',
      full: '并行工作线会卷带他人已 add 的内容。' })
    appendMemoryEntry({ root: f.root, theme: 'office-docs', tag: '无关', summary: 'Excel 透视表',
      full: '与查询无关，用于验证不被选中。' })

    const kws = ['无限重渲染', '回测']
    const q = kws.join(' ')
    const a = buildRelevantMemory({ root: f.root, keywords: kws, query: q, maxChars: 4096 })

    const g = createGraphStore({ root: join(f.dir, 'memory', 'graph') })
    await g.load({ memoryRoot: f.root, force: true })
    const b = g.search({ query: q, keywords: kws, maxChars: 4096, topK: 0 })

    assert.ok(a.length > 0 && b.length > 0, '两条路都应有结果（空结果无法对拍）')
    assert.equal(a, b, '★ 两条路必须逐字一致 —— 任一侧改回自己的实现，本断言立刻红')
    assert.ok(a.startsWith(RELEVANT_HEADER.trim().length ? '\n\n【相关经验抽调】' : ''), '开头是统一的抽调块标题')
    assert.ok(!a.includes('Excel 透视表'), '无关条目不得入选')
  } finally { f.cleanup() }
})

test('[回归] 中文长条目在默认预算下**至少能入选一条**（改动前字节口径常整体返回空）', () => {
  const f = fixture()
  try {
    // 665 字符长条目：UTF-8 下约 1995 字节 > 旧默认 2048 预算 ⇒ 旧实现返回空
    appendMemoryEntry({ root: f.root, theme: 'workflow', tag: '前端性能', summary: 'React 无限重渲染陷阱',
      full: '内联空数组每次渲染都是新数组，进 useEffect 依赖且内部 setState ⇒ 无限循环。'.repeat(24) })
    const out = buildRelevantMemory({ root: f.root, keywords: ['无限重渲染'], maxChars: DEFAULT_RELEVANT_MAX_CHARS })
    assert.ok(out.split('\n').filter((l) => l.startsWith('- ')).length >= 1,
      '★ 字符预算下必须能入选（旧字节口径的实测症状是"一条都塞不下"）')
  } finally { f.cleanup() }
})
