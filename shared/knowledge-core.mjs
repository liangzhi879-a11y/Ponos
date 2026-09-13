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
// 结构加权/融合评分/snippet；Task 3：标识/链接解析/索引序列化/内置空间规格）——
// 凡标注"迁移自"的，函数体都是从原处**逐字复制**，不要在此"优化"：偏差会在 Task 13
// 的双端对拍里变成真实检索分数漂移。
//
// Task 3 的部分是**全新契约**（kernel 侧无对应实现），语义以
// docs/superpowers/specs/2026-09-13-knowledge-core-design.md §5.1/§5.2 与 Task 5-8 的
// 调用形状为准：docId = "spaceId/relPath"（POSIX 分隔符，跨平台稳定）。

import { join } from 'node:path' // 本模块唯一的 node 依赖（纯字符串拼接，无 IO 副作用）

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

// 查询分词：按空白/标点切词元（与 gramTokens 的"空白/标点分词"同源），丢空串、统一小写。
// 只用于标题判定，**不参与向量化**（向量仍走 gramTokens 的 bigram 语义）。
function queryTokens(q) {
  return String(q ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((t) => t.toLowerCase())
}

// 结构加权：文档标题被查询命中是最强信号（1.0），文档标签次之（0.67——标签是稀疏人工
// 标注，命中即强相关），heading 有底价（0.5——标题本身就是高信息块），条目块 0.4
// （经验条目是高信息密度单元），普通段落 0（结构上无信号）。
//
// 标题判定是"整串 OR 逐词元"（Task 7 验收项）：
// 检索把**整串用户查询**（如 'PS表 RD表 交叉校验'）传进 query，若只做 title.includes(整串)，
// 标题 'PS表' 永远命不中，0.15 的结构权重静默失效（Task 2 评审实测）。故保留整串判定
// （单字符查询等旧行为不变），并追加"任一词元（≥2 字符）被标题包含即命中"。
export function structBoostOf({ block = null, doc = null, query = '', keywords = [] } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter((k) => k.length >= 2)
  let s = 0
  const title = String(doc?.title || '').toLowerCase()
  if (title && q) {
    if (title.includes(q)) s = 1
    else if (queryTokens(q).some((t) => t.length >= 2 && title.includes(t))) s = 1
  }
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

// ── 标识（Task 3）────────────────────────────────────────────────────────
// docId = "spaceId/relPath"，分隔符一律 **POSIX 正斜杠**（spec §5.2）：Windows 下
// node:path.relative 产出反斜杠，若原样入 ID，同一文件在两端会得到不同 ID、索引与
// 图谱都会错位。故所有入口统一归一：反斜杠 → 正斜杠、连续/首尾分隔符收敛。
export function toDocId(spaceId, relPath) {
  const rel = String(relPath ?? '').split(/[\\/]+/).filter(Boolean).join('/')
  return `${String(spaceId ?? '')}/${rel}`
}

// 逆运算：按**首个**斜杠切分（空间 id 的约定是不含斜杠，见 spec §5.1 各 spaceId 取值）
export function docIdToParts(docId) {
  const s = String(docId ?? '')
  const i = s.indexOf('/')
  return i < 0 ? { spaceId: s, relPath: '' } : { spaceId: s.slice(0, i), relPath: s.slice(i + 1) }
}

// 块 ID = "<docId>#<n>"（spec §5.2 Block.id）；n 是 splitBlocks 给出的块序号，从 0 起。
export function toBlockId(docId, n) {
  return `${docId}#${n}`
}

// ── 链接（Task 3）────────────────────────────────────────────────────────
// 只认两类站内引用：[[wiki]]（含 `[[目标|别名]]`，别名作 anchor）与相对路径 md 链接。
// 外链（含协议）与纯锚点不算边——它们连不到本文档集内的任何文档，进图只会是噪声。
// 去重按 `to`（同一目标多次出现只留首次，anchor 取首次出现的别名）：
// links.jsonl 与图扩展都按目标聚合，重复边只会放大同一文档的权重。
export function extractLinks(text) {
  const wikiRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
  const mdRe = /\[([^\]]*)\]\(([^)\s]+)\)/g
  const out = []
  const seen = new Set()
  const push = (to, anchor) => {
    const t = String(to ?? '').trim()
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push({ to: t, anchor: anchor || '' })
  }
  const src = String(text ?? '')
  let m
  while ((m = wikiRe.exec(src))) push(m[1], m[2] || '')
  while ((m = mdRe.exec(src))) {
    const href = String(m[2] || '')
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith('#')) continue
    push(href)
  }
  return out
}

// 相对路径段归一：`.` 跳过、`..` 回退一级；**越出根部的 `..` 原样保留**——它必然匹配
// 不到 docIds（docId 只由空间内真实 relPath 构成），于是顺带成了链接层的穿越防护
// （`../../etc/passwd.md` 不可能解析成任何文档）。
// 不引入 node:path 的 normalize/join：本模块要的是 POSIX 语义的纯字符串处理，
// 用 node:path 会把 Windows 分隔符与盘符语义混进来。
function normalizeRelPath(p) {
  const out = []
  for (const seg of String(p ?? '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

// 把原始链接目标解析成**同空间**的 docId；解析不到（断链）返回 null。
// 候选顺序（刻意如此，别"优化"）：
//   ① 原样   ② 加 .md   ③ 相对当前文档目录   ④ 相对目录加 .md
// ①② 在前是因为 wiki 链接（`[[workflow]]`）按**库根**语义解析（Obsidian 同为
// vault-wide），带路径的写法（`[[sub/a]]`）由 ①② 直接命中；③④ 兜住 `./x.md`、`../x.md`
// 这类相对当前文档目录的 md 链接（候选串先做 `.`/`..` 段归一，否则
// `rules/../customization.md` 这种字符串永远等不上真实 docId——仓库实测 4 条父目录
// 相对链接：shadcn/rules/styling.md、subagent-driven-development/SKILL.md、
// writing-skills/SKILL.md×2）。
//
// `#fragment` 在匹配前剥掉：`[x](./SKILL.md#updating-components)` 是**指向文档**的有效
// 链接（只多指定了章节）。仓库实测 3 条（shadcn/cli.md:128,287、shadcn/customization.md:209、
// shadcn/rules/forms.md:150 按 `to` 去重后 3 条）；不剥会让它们全被误判为断链，
// 图扩展少掉真实邻居。
// 注意 `to` 本身存原文（links.jsonl 落原文，`--knowledge links` 展示不丢信息）；
// 纯锚点（`#sec`）依旧一律 null——它连不到本文档集内的任何文档。
export function resolveLinkTarget({ fromRel = '', to = '', spaceId = '', docIds = null } = {}) {
  const src = String(to ?? '').trim()
  if (!src || /^[a-z]+:\/\//i.test(src) || src.startsWith('#')) return null
  const raw = src.replace(/#.*$/, '').replace(/^\.\//, '')
  if (!raw) return null
  const dir = String(fromRel ?? '').split(/[\\/]+/).filter(Boolean).slice(0, -1).join('/')
  const cands = []
  const add = (s) => { const t = normalizeRelPath(s); if (t && !cands.includes(t)) cands.push(t) }
  add(raw)
  if (!/\.md$/i.test(raw)) add(`${raw}.md`)
  if (dir) {
    add(`${dir}/${raw}`)
    if (!/\.md$/i.test(raw)) add(`${dir}/${raw}.md`)
  }
  for (const c of cands) {
    const id = toDocId(spaceId, c)
    if (!docIds || docIds.has(id)) return id
  }
  return null
}

// ── 索引序列化（Task 3）──────────────────────────────────────────────────
// 三份 JSONL 共用同一批次写入（同一原子替换）：docs.jsonl 的行序**就是** docIdx 的定义，
// 与 inverted.jsonl 的 postings 下标强耦合，二者绝不可分批写。
// tags 是单个 JSON 对象（不是 JSONL）：按 tag 聚合后一次性写入，无逐行追加需求。
// 空数组产出空串而非"\n"：避免 parseJsonl 之外的下游把空行当半截行报警。
export function serializeIndex({ docs = [], inverted = [], links = [], tags = {} } = {}) {
  const jsonl = (arr) => (arr.length ? arr.map((x) => JSON.stringify(x)).join('\n') + '\n' : '')
  return {
    docs: jsonl(docs),
    inverted: jsonl(inverted),
    links: jsonl(links),
    tags: JSON.stringify(tags),
  }
}

// 容错解析：半截行（进程被杀/磁盘满导致的截断）与损坏行一律跳过。
// 索引是**派生物**（spec §4.1"删掉 .index/ 毫发无损"），容错即降级，绝不因一行坏数据
// 让整个检索不可用（对齐 kernel/graph.mjs:145 的既有纪律）。
export function parseJsonl(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 半截行/损坏行跳过 */ }
  }
  return out
}

// ── 内置空间（Task 3）────────────────────────────────────────────────────
// root 一律外挂既有目录（**物理不动**，spec §5.1）：经验文件留在 ~/.yfw/memory/personal，
// 知识库只是把它注册成一个空间——"统一为同一后端"是能力统一，不是搬迁。
// source 取值被下游依赖：Task 5 的 collectTags 用 source==='experience'/'memory' 决定
// 文件名是否进 tags，路由把整个 spec 透出给 GUI 区分空间来源，**改动会静默改变检索结果**。
// 迁移（spec §12）是独立后续任务，届时只改这里三行 root。
export function builtinSpaceSpecs(configDir) {
  const base = String(configDir ?? '')
  return [
    {
      id: 'experience', name: '个人经验',
      description: '跨会话沉淀的个人经验条目',
      root: join(base, 'memory', 'personal'), writable: true, source: 'experience',
    },
    {
      id: 'session-memory', name: '会话记忆',
      description: '各会话轮末写入的工作记忆',
      root: join(base, 'memory', 'session'), writable: true, source: 'memory',
    },
    {
      id: 'skill-experience', name: '技能经验库',
      description: '技能执行中沉淀的经验（预留）',
      root: join(base, 'memory', 'skill_experiences'), writable: true, source: 'skill_exp',
    },
  ]
}
