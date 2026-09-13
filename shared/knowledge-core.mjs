// shared/knowledge-core.mjs —— 知识内核纯函数层
// ---------------------------------------------------------------------------
// 为什么是 shared/：内核以 `bun build --target=node --external=node:*` 打成单文件
// （scripts/build-kernel.mjs），server 侧走 electron-builder 的 files 打包；两端都要
// 同一套切块/向量/打分算法，唯一可行的共享位置是 repo 根——一级 `../shared/` 逃逸
// 同时被 bun 内联（打进 bundle）与 server/bridge.mjs:619 mirrorKernelParentDeps
// （镜像到 <home>/runtime/）支持，先例 ../version.mjs。
//
// 依赖纪律（不可破）：本文件只许 import 'node:path'（纯字符串）。禁止 node:fs /
// node:child_process / 第三方包——内核运行在无 node_modules 的镜像目录。
//
// 迁移说明：gramTokens/vectorizeText/cosine/buildIdf 与 hashLine 原在
// kernel/graph.mjs 与 kernel/memory.mjs（且 server/experience.mjs 有一份重复）；
// 本模块是唯一权威实现，原处改为 re-export（Task 4），行为逐字不变。
// 本文件已落地的函数（Task 1：切块/frontmatter/条目解析；Task 2：向量/IDF/关键词分/
// 结构加权/融合评分/snippet）——凡标注"迁移自"的，函数体都是从原处**逐字复制**，
// 不要在此"优化"：偏差会在 Task 13 的双端对拍里变成真实检索分数漂移。

export const INDEX_VERSION = 1

// ── 基础：行指纹 ──────────────────────────────────────────────────────────
// 与 kernel/memory.mjs:13 / server/experience.mjs:24 现行算法逐字相同。
// 它是条目去重与索引稳定 ID 的基础，**改动会改变已落盘的 hash**，故永久冻结。
export function hashLine(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ── 基础：经验条目行 ──────────────────────────────────────────────────────
// 格式：- [会话|任务标签] 摘要 -- 全文（标签/摘要均可省略；无 ' -- ' 时摘要即全文）
export const ENTRY_LINE_RE = /^- \[([^\]]*)\]\s*(.*)$/

export function parseEntryLine(line) {
  const text = String(line).trim()
  const m = ENTRY_LINE_RE.exec(text)
  const inner = m ? m[1] : ''
  let src = m ? m[2].trim() : text.replace(/^- /, '')
  let tag = null
  const bar = inner.lastIndexOf('|')
  if (bar >= 0) tag = inner.slice(bar + 1).trim() || null
  const sep = src.indexOf(' -- ')
  let summary, full
  if (sep >= 0) { summary = src.slice(0, sep).trim(); full = src.slice(sep + 4).trim() }
  else { summary = src; full = src }
  return { tag, summary: summary || full, full }
}

// ── 基础：frontmatter ─────────────────────────────────────────────────────
// 极简实现（与 kernel/memory.mjs:17 同款语义），但额外给出 body 起始行号——
// 块切分要把 "行号" 回溯到**原始文件**（含 frontmatter），否则跳转会错位。
export function parseFrontmatter(raw) {
  // 去 BOM：Windows 记事本等保存的 md 可能以 \uFEFF 开头，否则 frontmatter 匹配失败、
  // title/tags 全丢（整段被当正文）。注意只作用于解析，hashLine 的指纹仍基于原始字符串。
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { front: {}, body: text, bodyStartLine: 1 }
  const front = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) front[kv[1]] = kv[2]
  }
  return { front, body: text.slice(m[0].length), bodyStartLine: m[0].split(/\r?\n/).length }
}

// ── 块切分 ────────────────────────────────────────────────────────────────
// 确定性、无模型。顺序有讲究：
//   围栏代码 → 标题 → 表格 → 经验条目 → 列表 → 段落
// 经验条目必须**先于**列表判断（它长得像列表项 `- [...]`）。
// 代码块整体成块不切分：切开会让 bigram 噪声污染语义（`const` 之类的碎词）。
export function splitBlocks(body, { startLine = 1 } = {}) {
  // 去 BOM：splitBlocks 可能被直接喂原始文本（未经 parseFrontmatter），BOM 会让首行
  // 的 `# `/``` 匹配失败而降级成段落。BOM 只占首行行首，去除不改变任何行号。
  const lines = String(body ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  const blocks = []
  let n = 0
  let i = 0
  const push = (b) => { blocks.push({ n: n++, level: 0, ...b }) }
  const isHeading = (l) => /^(#{1,6})\s+/.test(l)
  const isFence = (l) => /^\s*(`{3,}|~{3,})/.test(l)
  const isTable = (l) => /^\s*\|/.test(l)
  const isList = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l)
  const isEntry = (l) => ENTRY_LINE_RE.test(l.trim())

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const lineNo = startLine + i

    if (isFence(line)) {
      // CommonMark 闭合规则（开围栏 = 3+ 个同类字符；闭合须同类、长度 >= 开围栏、行内
      // 只有围栏字符、缩进不比开围栏深 3 格以上）。旧实现只判 startsWith(3 个反引号)，
      // 三种误闭合都会把单块切成多段（已用 micromark 作 CommonMark 参考实测）：
      //  ① 四反引号围栏（````md … ````）：仓库 public/sample-skills/writing-skills/
      //     anthropic-best-practices.md 14 处，旧实现切成 19 段碎片；
      //  ② 围栏行带 info string（` ```js ` 之类）被当闭合：公开技能模板里的内嵌示例
      //     即此形状（requesting-code-review/code-reviewer.md）；
      //  ③ 内层缩进围栏被当外层闭合（同文件的 4 缩进内层块）。
      const fence = /^\s*(`{3,}|~{3,})/.exec(line)[1]
      const ch = fence[0]
      const minLen = fence.length
      const indent = line.length - line.trimStart().length
      const isClose = (l) => {
        const t = l.trim()
        if (t.length < minLen) return false
        for (let k = 0; k < t.length; k++) if (t[k] !== ch) return false
        return l.length - l.trimStart().length <= indent + 3
      }
      const buf = [line]
      i++
      while (i < lines.length) {
        buf.push(lines[i])
        const closed = isClose(lines[i])
        i++
        if (closed) break
      }
      push({ kind: 'code', text: buf.join('\n'), line: lineNo })
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      push({ kind: 'heading', level: h[1].length, text: h[2].trim(), line: lineNo })
      i++
      continue
    }

    if (isTable(line)) {
      const buf = []
      while (i < lines.length && isTable(lines[i])) { buf.push(lines[i]); i++ }
      push({ kind: 'table', text: buf.join('\n'), line: lineNo })
      continue
    }

    if (isEntry(line)) {
      const e = parseEntryLine(line)
      push({ kind: 'entry', text: e.summary, line: lineNo, entryTag: e.tag, entryFull: e.full })
      i++
      continue
    }

    if (isList(line)) {
      // 续行遇到条目行必须断开：starter 模板播种的经验文件是「3 条 bullet 头部 +
      // 条目行相邻」的形状，若把条目吞进 list 块，该文件 entry 块数恒为 0、
      // 单条经验检索整文件失效。
      const buf = []
      while (i < lines.length && isList(lines[i]) && !isEntry(lines[i])) { buf.push(lines[i]); i++ }
      push({ kind: 'list', text: buf.join('\n'), line: lineNo })
      continue
    }

    const buf = []
    while (i < lines.length && lines[i].trim()
      && !isHeading(lines[i]) && !isFence(lines[i]) && !isTable(lines[i])
      && !isEntry(lines[i]) && !isList(lines[i])) {
      buf.push(lines[i]); i++
    }
    if (buf.length) push({ kind: 'para', text: buf.join(' ').trim(), line: lineNo })
    else i++ // 防御：理论不可达；万一某行同时被上面的判断漏掉，保证前进不空转
  }
  return blocks
}

// ── 块 → 索引文本 ─────────────────────────────────────────────────────────
// 经验条目的任务标签要参与检索（"企微CLI化"这类标签命中价值很高），故把 tag 前缀
// 进索引文本；展示用的 text 仍是纯摘要（UI 不该看到重复的标签）。
export function blockIndexText(block) {
  const t = String(block?.text ?? '')
  return block?.kind === 'entry' && block.entryTag ? `${block.entryTag} ${t}` : t
}

// 条目块的向量化用 tagBoost=3（同 kernel/graph.mjs:120 的既有语义：标签命中额外加权）
export function blockTagBoost(block) {
  return block?.kind === 'entry' && block.entryTag ? 3 : 1
}

// ── 分词与向量 ────────────────────────────────────────────────────────────
// 迁移自 kernel/graph.mjs:20-88，逐字保持（含注释里的边界语义，测试断言依赖它）。
const CJK = /[\u4e00-\u9fff]/
const WORD = /[A-Za-z0-9]/

// 切分：中文段字符 bigram + 英文/数字段单词小写。
// 段边界语义（对齐 test 断言 ['ps','表与','与r','rd','rd表']）：
//   - word 段 -> 整体小写；cjk 段 -> 内部滑动 bigram
//   - cjk->word 边界 -> 末 cjk 字 + 首词字（小写）组成的跨界 bigram
//   - word->末段 cjk 边界 -> 整体小写词 + 首 cjk 字（避免孤立尾字丢失）
export function* gramTokens(text) {
  const s = String(text ?? '').trim()
  const runs = [] // { type: 'word' | 'cjk', text }
  let cur = ''
  let curType = null
  const flush = (type) => {
    if (cur) runs.push({ type: curType, text: cur })
    cur = ''
    curType = type
  }
  for (const ch of s) {
    const t = CJK.test(ch) ? 'cjk' : WORD.test(ch) ? 'word' : null
    if (t === null) { flush(null); continue } // 空白/标点分词，不参与 n-gram
    if (t !== curType) flush(t)
    cur += ch
  }
  flush(null)
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const next = runs[i + 1]
    if (r.type === 'word') {
      yield r.text.toLowerCase()
      if (next && next.type === 'cjk' && i + 1 === runs.length - 1) {
        yield r.text.toLowerCase() + [...next.text][0] // word->末段 cjk 边界
      }
    } else {
      const chars = [...r.text]
      for (let j = 0; j + 1 < chars.length; j++) yield chars[j] + chars[j + 1]
      if (next && next.type === 'word') {
        yield chars[chars.length - 1] + next.text[0].toLowerCase() // cjk->word 边界
      }
    }
  }
}

// gram -> 词频。索引构建与 IDF 统计都用"文本键"，因为哈希 id 查不到 idf
// （见 kernel/graph.mjs:108 的踩坑注释）。
export function countGrams(text) {
  const tf = new Map()
  for (const g of gramTokens(text)) tf.set(g, (tf.get(g) || 0) + 1)
  return tf
}

// 归一化**前**的向量与范数（索引构建要把未归一化权重落进 postings，查询时点积才是真余弦）。
// tagBoost 不在此处参与：它按 graph.mjs 的既有语义在归一化之后乘，见 vectorizeText。
export function vectorizeRaw(text, { idf = null } = {}) {
  const tf = countGrams(text)
  const raw = []
  for (const [gram, count] of tf) {
    const w = (1 + Math.sqrt(count)) * (idf?.get(gram) ?? 1)
    raw.push([hashLine(gram), w])
  }
  const norm = Math.sqrt(raw.reduce((s, [, w]) => s + w * w, 0))
  return { raw, norm }
}

export function vectorizeText(text, { tagBoost = 1, idf = null } = {}) {
  const { raw, norm } = vectorizeRaw(text, { idf })
  // tagBoost 在归一化之后乘（kernel/graph.mjs 的既有测试断言依赖此顺序，勿改）
  const boost = tagBoost || 1
  return norm > 0 ? raw.map(([id, w]) => [id, (w / norm) * boost]) : []
}

// 两个向量都已归一化 → 点积即余弦。参数顺序无关（都是求交）。
export function cosine(a, b) {
  const bm = new Map(b)
  let dot = 0
  for (const [id, wa] of a) { const wb = bm.get(id); if (wb) dot += wa * wb }
  return dot
}

export function buildIdf(docs) {
  const df = new Map()
  const N = docs.length
  for (const d of docs) for (const gram of d.gramCounts.keys()) df.set(gram, (df.get(gram) || 0) + 1)
  const idf = new Map()
  // 标准 IDF：ln((N+1)/(df+1)) + 1，df 高者 idf 低
  for (const [gram, count] of df) idf.set(gram, Math.log((N + 1) / (count + 1)) + 1)
  return idf
}

// ── 关键词精确分 ──────────────────────────────────────────────────────────
// 迁移自 kernel/memory.mjs:117-132，权重不变：标签命中 3 > 主题 2 = 摘要 2 > 全文 1。
// 单字关键词（长度 < 2）被过滤：中文单字命中噪声过大，会把无关条目拉上榜。
export function keywordScore({ tag = '', summary = '', full = '', theme = '' }, keywords = []) {
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter((k) => k.length >= 2)
  if (!kws.length) return 0
  const tagL = String(tag || '').toLowerCase()
  const sumL = String(summary || '').toLowerCase()
  const fullL = String(full || '').toLowerCase()
  const themeL = String(theme || '').toLowerCase()
  let score = 0
  for (const k of kws) {
    if (tagL.includes(k)) score += 3
    if (themeL.includes(k)) score += 2
    if (sumL.includes(k)) score += 2
    if (fullL.includes(k)) score += 1
  }
  return score
}

// ── 打分融合（spec §5.4）──────────────────────────────────────────────────
// 三路权重之和为 1：向量（语义召回主路）压倒关键词与结构分，避免"精确命中关键词的
// 无关长文"挤掉语义最相关的块。
export const W_VECTOR = 0.60
export const W_KEYWORD = 0.25
export const W_STRUCT = 0.15
export const GRAPH_DECAY = 0.9

// 结构加权：文档标题被查询命中是最强信号（1.0），文档标签次之（0.67——标签是稀疏人工
// 标注，命中即强相关），heading 有底价（0.5——标题本身就是高信息块），条目块 0.4
// （经验条目是高信息密度单元），普通段落 0（结构上无信号）。
export function structBoostOf({ block = null, doc = null, query = '', keywords = [] } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter((k) => k.length >= 2)
  let s = 0
  const title = String(doc?.title || '').toLowerCase()
  if (title && q && title.includes(q)) s = 1
  const tags = (doc?.tags || []).map((t) => String(t).toLowerCase())
  // 双向包含匹配：查询"企微"要能命中标签"企微CLI化"，反之亦然
  if (tags.length && kws.length && tags.some((t) => kws.some((k) => t.includes(k) || k.includes(t)))) {
    s = Math.max(s, 0.67)
  }
  if (block?.kind === 'heading') s = Math.max(s, 0.5)
  if (block?.kind === 'entry') s = Math.max(s, 0.4)
  return s
}

// 关键词分除以 8 折到 [0,1] 再参与加权：标签+摘要+全文全命中约 8 分即满格，
// 防止"同一关键词在标签与摘要里重复命中"把总分推过向量分（会被截断）。
export function fuseScore({ cos = 0, kw = 0, struct = 0, graph = false } = {}) {
  const base = W_VECTOR * cos + W_KEYWORD * Math.min(kw / 8, 1) + W_STRUCT * struct
  return graph ? base * GRAPH_DECAY : base
}

// 检索结果摘要：压平换行/连续空白（行内条目与卡片都需要单行），超长按上限截断加省略号。
export function makeSnippet(text, { maxLen = 160 } = {}) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= maxLen) return s
  return s.slice(0, Math.max(1, maxLen - 1)) + '…'
}
