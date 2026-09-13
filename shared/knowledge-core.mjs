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
  const text = String(raw ?? '')
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
  const lines = String(body ?? '').split(/\r?\n/)
  const blocks = []
  let n = 0
  let i = 0
  const push = (b) => { blocks.push({ n: n++, level: 0, ...b }) }
  const isHeading = (l) => /^(#{1,6})\s+/.test(l)
  const isFence = (l) => /^\s*(```|~~~)/.test(l)
  const isTable = (l) => /^\s*\|/.test(l)
  const isList = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l)
  const isEntry = (l) => ENTRY_LINE_RE.test(l.trim())

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const lineNo = startLine + i

    if (isFence(line)) {
      const marker = /^\s*(```|~~~)/.exec(line)[1]
      const buf = [line]
      i++
      while (i < lines.length) {
        buf.push(lines[i])
        const closed = lines[i].trim().startsWith(marker)
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
      const buf = []
      while (i < lines.length && isList(lines[i])) { buf.push(lines[i]); i++ }
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
