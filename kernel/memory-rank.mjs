// kernel/memory-rank.mjs —— 「经验条目级召回」的**唯一排序与渲染真源**（2026-09-30）
//
// ═══ 为什么单独成模块（实测：同一意图曾有两套实现，语义不同且其一常返回空）═══
// 改造前，**从经验库取出相关条目**这件事有两份独立实现：
//   · `kernel/memory.mjs#buildRelevantMemory`（workflow 的 memory 节点用）
//       —— 仅关键词打分、预算按 **UTF-8 字节**、输出**原始行** `it.text`
//   · `kernel/graph.mjs#search`（legacy 模式的提示注入用）
//       —— `0.7×向量余弦 + 0.3×关键词`、预算按 **UTF-16 字符**、输出**重拼**行
// 后果（实测）：中文条目 665 字 ≈ **1995 字节**，在 2048 字节预算下**一条都塞不下**
//   ⇒ `buildRelevantMemory` 经常整体返回空（`['无限重渲染','回测'] → 0 条`，而单关键词 → 1 条）。
//   同类口径分叉还会让"同一批数据、同一个查询"在两条路上给出**不同的排序**，无法互相验证。
//
// ═══ 分层（重要：本模块**只**负责"经验条目级"召回，不要拿它替换块级知识检索）═══
//   A. **经验条目级**（本模块）：语料 = 经验库的**条目**（`- [主题|标签] 摘要 -- 全文` 一整行）；
//      意图 = "把相关经验喂给模型 / 节点"。使用者：`memory.mjs#buildRelevantMemory`、
//      `graph.mjs#search`。**这就是被统一的两条路。**
//   B. **知识库块级**（`kernel/knowledge.mjs` 的 BM25F + 倒排，经 `knowledge-inject` 组装）：
//      语料 = 知识库**块**（可跨空间：experience / session-memory / 项目库…），并带**空间配额**、
//      块级锚点、索引年龄等语义。**不并入本模块**，理由：
//        · 语料粒度与范围不同（条目 vs 块、单库 vs 多库白名单），合并会破坏块级锚点与配额；
//        · 打分函数不同（BM25F 有长度归一与字段权重，本模块是 tf-idf 余弦 + 关键词），
//          强行统一等于"换掉块级检索的正解"，收益不明而回归风险明确。
//      两者的**关系**：B 是"召回面更宽的另一层"，A 是"条目级精确层"；
//      `knowledge-inject` 的 unified 模式走 B，legacy 模式走 A 的 `graph.search`。
//
// ═══ 本模块的契约 ═══
//   · 纯函数、零反向依赖（只依赖 `shared/knowledge-core.mjs`）⇒ 不引入任何环；
//   · **预算单位统一为字符**（`maxChars`）：对中英公平，且与提示实际消耗更贴近
//     （UTF-8 字节对中文会误判成"3 倍体积"）；
//   · **无 idf 时优雅退化**为关键词打分（保留旧 memory 路径的排序语义），
//     有 idf 时两条路**完全同质**（同公式、同排序、同渲染）。
import { buildIdf, cosine, gramTokens, keywordScore, vectorizeText } from '../shared/knowledge-core.mjs'

/** 抽调块的标题行 —— **唯一真源**（此前两个模块各写一份同样的字符串） */
export const RELEVANT_HEADER =
  '\n\n【相关经验抽调】根据当前任务关键词，以下过往经验与任务直接相关，可直接参考（格式：-[主题|标签] 摘要 -- 全文）：\n'

/** 默认预算（**字符**）。2048 字符 ≈ 30~45 条短条目，或 3 条长条目 + 余量 */
export const DEFAULT_RELEVANT_MAX_CHARS = 2048

/** 向量项权重（与 `graph.mjs` 原口径一致：0.7 向量 + 0.3 关键词） */
export const VECTOR_WEIGHT = 0.7
/** 关键词项权重 */
export const KEYWORD_WEIGHT = 0.3
/** `keywordScore` 的实测上限（3+2+2+1=8）——用它把关键词分归一到 0~1 才能与余弦同尺度相加 */
export const KEYWORD_NORM_DIVISOR = 8
/** 关键词最短长度：过短的词（单字）对中文几乎命中一切，只增噪声 */
export const MIN_KEYWORD_LEN = 2

/**
 * 解析预算（**唯一口径**）。
 *
 * ★ 2026-09-30 实测缺陷（我自己的实现踩的）：写过
 *   `Number.isFinite(Number(maxChars)) ? Number(maxChars) : fallback`
 *   —— `Number(null) === 0`、`Number('') === 0` 都**是有限数** ⇒ 未传的预算被判成 **0**
 *   ⇒ 渲染时"一行都放不下" ⇒ 两条路**同时整体返回空**（被 experience-dedup 与 graph.search
 *   两个既有用例当场抓住）。⇒ 判"有没有给"必须用 `!= null` 与空串判断，不能用 Number() 的可转换性。
 */
export function resolveBudget({ maxChars = null, maxBytes = null, fallback = DEFAULT_RELEVANT_MAX_CHARS } = {}) {
  const pick = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  return pick(maxChars) ?? pick(maxBytes) ?? fallback
}

/** 参与向量化的文本口径（**必须**与 graph 节点的文本口径一致，否则两条路的向量不可比） */
export function rankTextOf(c) {
  if (!c || typeof c !== 'object') return ''
  return `${c.theme || ''} ${c.tag || ''} ${c.summary || ''} ${c.full || ''}`
}

/**
 * 条目向量化时**有标签**的 boost 值。
 *
 * ★ 2026-09-30 实测（我自己的统一还不彻底）：`graph.mjs#entryToNode` 建节点向量时用
 *   `tagBoost: tag ? 3 : 1`，而本模块 `scoreCandidate` 起初用**默认 tagBoost 1**
 *   ⇒ 两条路的向量口径**仍不一致**——对拍能过只是**小样本排序恰好相同**的巧合。
 *   向量口径属于"评分的输入"，必须同源；故提升为常量并由 `entryVector()` 统一使用，
 *   `graph.mjs` 建节点向量也改为调用它（否则持久化的 vec 与现算的 vec 不可比）。
 */
export const TAG_BOOST_WITH_TAG = 3

/** 条目向量（**唯一口径**）：标签存在时加权（标签是人工判定，比正文更可信） */
export function entryVector(c, idf = null) {
  const tag = c && c.tag ? String(c.tag) : ''
  return vectorizeText(rankTextOf(c), { tagBoost: tag ? TAG_BOOST_WITH_TAG : 1, idf })
}

/** 渲染一行（**唯一格式真源**） */
export function renderLine(it) {
  if (!it) return ''
  const tag = it.tag ? '|' + it.tag : ''
  const summary = String(it.summary ?? '').trim()
  const full = String(it.full ?? '').trim()
  return `- [${it.theme || ''}${tag}] ${summary} -- ${full}`
}

/** 归一化关键词表（去空、转小写、丢弃过短项） */
export function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return []
  return [...new Set(keywords.map((k) => String(k ?? '').trim().toLowerCase()).filter((k) => k.length >= MIN_KEYWORD_LEN))]
}

/**
 * 语料 idf（两遍法的第一遍）。候选**自带 `vec`** 时可不调用（graph 的节点已持久化 vec）。
 * @param {Array<{theme?:string,tag?:string,summary?:string,full?:string}>} candidates
 */
export function buildRankIdf(candidates) {
  const docs = (Array.isArray(candidates) ? candidates : [])
    .filter(Boolean)
    .map((c) => ({ gramCounts: new Map([...gramTokens(rankTextOf(c))].map((g) => [g, 1])) }))
  return buildIdf(docs)
}

/**
 * 单条打分（**唯一公式真源**）。
 * · 无 `qvec` ⇒ 只有关键词项（0~1）——与统一前 memory 路径的排序一致（退化但不为 0）；
 * · 有 `qvec` ⇒ `VECTOR_WEIGHT × 余弦 + KEYWORD_WEIGHT × 关键词`。
 * 候选自带 `vec` 则直接复用（graph 的节点已算好，避免重复向量化）。
 */
export function scoreCandidate(c, { keywords = [], qvec = null, idf = null } = {}) {
  const kw = Math.min(keywordScore(c || {}, keywords) / KEYWORD_NORM_DIVISOR, 1)
  if (!qvec) return kw
  const vec = (c && c.vec) || entryVector(c, idf)   // 唯一向量化口径（tagBoost 与 graph 节点一致）
  return VECTOR_WEIGHT * cosine(vec, qvec) + KEYWORD_WEIGHT * kw
}

/**
 * 排序（唯一排序真源）。
 * 排序键：score desc → summary `localeCompare`（**不依赖时间戳**：同一批数据在任何调用点上
 * 都必须得到同一顺序，否则"两条路结果一致"无法验证，见本文件头的对拍测试）。
 *
 * @returns {{ ranked: Array, idf: Map|null, qvec: any|null }}
 */
export function rankRelevant(candidates, { query = '', keywords = [], idf = null, minScore = 0.001, useVector = true } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean)
  const kws = normalizeKeywords(keywords)
  if (!list.length) return { ranked: [], idf: null, qvec: null }
  const q = String(query || '').trim() || kws.join(' ')

  // 向量项：候选**都**自带 vec 时不必建 idf（graph 路径的情形）；否则按需建（一致的两遍法）
  let corpusIdf = idf
  let qvec = null
  if (useVector && q) {
    const allHaveVec = list.every((c) => c.vec)
    if (!corpusIdf && !allHaveVec) corpusIdf = buildRankIdf(list)
    qvec = vectorizeText(q, corpusIdf ? { idf: corpusIdf } : {})
  }

  const ranked = list
    .map((c) => ({ ...c, score: scoreCandidate(c, { keywords: kws, qvec, idf: corpusIdf }) }))
    .filter((c) => c.score > minScore)
    // 排序必须构成**全序**（score → summary → 整行）：前两级打平时不能落到"输入顺序"上 ——
    // 两条路的数据来源顺序不同（A 按 readdir、B 按 memoryRoot 扫描），若 tie-break 不完整，
    // 同一批数据会给出不同顺序 ⇒ 对拍失败、且用户看到的排序"看运气"。
    // （本断言由 memory-rank.test.mjs 的同数据不同入参顺序用例逼出来。）
    .sort((a, b) => b.score - a.score
      || String(a.summary || '').localeCompare(String(b.summary || ''))
      || renderLine(a).localeCompare(renderLine(b)))
  return { ranked, idf: corpusIdf, qvec }
}

/**
 * 渲染抽调块（唯一渲染真源）。**按字符**计预算，超预算即停（不截断半行）。
 * @param {Array} ranked 已排序的条目
 * @param {{ maxChars?: number, withHeader?: boolean, topK?: number }} [opts]
 * @returns {string} 无任何条目可放时返回 `''`（**不返回只有标题的空块**）
 */
export function renderRelevantBlock(ranked, { maxChars = DEFAULT_RELEVANT_MAX_CHARS, withHeader = true, topK = 0 } = {}) {
  const header = withHeader ? RELEVANT_HEADER : ''
  let out = header
  const seen = new Set()
  let n = 0
  for (const it of Array.isArray(ranked) ? ranked : []) {
    // `topK = 0` = 不限（memory 路径原语义：遍历全部直到预算用尽）；
    // graph 路径原先自己 `slice(0, topK)`，现在改为同一个入口参数 ⇒ 两条路口径一致
    if (topK > 0 && n >= topK) break
    const line = renderLine(it)
    if (!line || seen.has(line)) continue
    const add = line.length + 1
    if (out.length + add > maxChars) break
    seen.add(line)
    out += line + '\n'
    n++
  }
  return out === header ? '' : out
}

/** 一步到位：候选 → 排序 → 渲染（两条通路的共同入口） */
export function buildRelevantBlock(candidates, opts = {}) {
  const { ranked } = rankRelevant(candidates, opts)
  return renderRelevantBlock(ranked, opts)
}
