// shared/knowledge-core.mjs —— 知识内核纯函数层
// ---------------------------------------------------------------------------
// 为什么是 shared/：内核以 `bun build --target=node --external=node:*` 打成单文件
// （scripts/build-kernel.mjs），server 侧走 electron-builder 的 files 打包；两端都要
// 同一套切块/向量/打分算法，唯一可行的共享位置是 repo 根——一级 `../shared/` 逃逸
// 同时被 bun 内联（打进 bundle）与 server/bridge.mjs:619 mirrorKernelParentDeps
// （镜像到 <home>/runtime/）支持，先例 ../version.mjs。
//
// 依赖纪律（不可破）：本文件只许 import node 内置模块（'node:path' 纯字符串、'node:crypto'
// 仅用于内容指纹 sha1）。禁止 node:fs / node:child_process / 第三方包——内核运行在无
// node_modules 的镜像目录，且以 `--external=node:*` 打包（node 内置模块在两端都恒存在）。
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

import { join } from 'node:path' // 纯字符串拼接，无 IO 副作用
import { createHash } from 'node:crypto' // 仅内容指纹（sha1），无 IO

// 1 → 2（S5）：索引文本口径由 `b.text`（60 字截断摘要，实测 45 字 vs full 471 字）
// 改为 `relationContent(b)`（full 去类型前缀，spec §8）。口径变了，**旧索引必须整体重建**
// ——kernel/knowledge.mjs 靠版本号不等触发重建（不得报错或返回空集，S5 全局约束 5）。
//
// v3（2026-09-14 对标 Obsidian 批次 1）：标签来源变了 —— ① frontmatter 支持 YAML 子集
// （block 列表 / flow 数组 / 引号 / 行尾注释 / 多行折叠，见 parseYamlSubset）；② 正文内联
// `#tag` 进索引（见 extractInlineTags）。**必须 bump**：这两项都改变 doc.tags，而被改的
// .md 文件可能 size/mtime 未变（用户在别处敲了个内联标签就另存），indexStale() 的逐文件
// 指纹发现不了 → 不 bump 就会拿着旧标签集一直跑（"文件里有、知识库没有"这类最难查的分裂）。
// v4（2026-09-14 对标 Obsidian 批次 2）：**引用体系**。links 的 `to` 语义变了 ——
// `[[a#x]]` 的 `to` 从 `'a#x'` 改为剥离锚点的 `'a'`，锚点移入新字段 `anchorRef`/`anchorKind`；
// 同时新增 `embed`（`![[x]]`）与 `self`（`[[#x]]` 同文档锚点，旧实现在 to 为空时直接丢弃）。
// **必须 bump**：① `to` 的取值变了（反链比对、图边、前端解析全依赖它）；② 老索引里同文档锚点
// **整条缺失**（不是"字段缺失"而是"数据从来没落盘"），只追加字段无法恢复 —— 只能重建。
// 另：`relinkDoc`（增量路径）曾只写 `{from,to,target}` 丢字段，已改为与全量共用 linkRowsOf；
// 那个 bug 造成的既存数据（被编辑过的文档缺 line/block/锚点）也只有重建才会修复。
export const INDEX_VERSION = 4

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
//
// 2026-09-14（对标 Obsidian 批次 1）：原实现只认单行 `key: 值`，而 Obsidian Properties
// 的**标准写法**恰恰是 YAML block 列表：
//     tags:
//       - 财务
//       - 税务
// 旧实现把 `tags:` 记成空串、`- 财务` 这行直接丢弃（不匹配 `^([\w-]+):`）→ **标签全丢**；
// 另一种常见写法 `tags: [a, b]` 会得到字面量 `'[a, b]'`，下游按 `/[,\s]+/` 拆出
// `['[a','b]']` 这种带方括号的脏 tag（检索、关联网全被污染）。
// 现改为走 parseYamlSubset 的**标量/列表子集**（不做嵌套 map、不做锚点别名——批次 1 范围）。
export function parseFrontmatter(raw) {
  // 去 BOM：Windows 记事本等保存的 md 可能以 \uFEFF 开头，否则 frontmatter 匹配失败、
  // title/tags 全丢（整段被当正文）。注意只作用于解析，hashLine 的指纹仍基于原始字符串。
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { front: {}, body: text, bodyStartLine: 1 }
  const front = parseYamlSubset(m[1])
  return { front, body: text.slice(m[0].length), bodyStartLine: m[0].split(/\r?\n/).length }
}

/**
 * YAML **子集**解析（frontmatter 专用，不是通用 YAML 实现）。支持：
 *   `k: v`            → `'v'`（**含 `v` 里的逗号也不拆**——保持旧行为，下游 collectTags 自己拆）
 *   `k: a, b`         → `'a, b'`（同上：旧行为是字符串，不因"看起来像列表"而改变类型）
 *   `k: [a, b]`       → `['a', 'b']`（flow 数组，尊重引号内的逗号）
 *   `k:` + 缩进 `- x` → `['x', ...]`（block 列表，Obsidian Properties 的标准写法）
 *   `k: "x"` / `'x'`  → `'x'`（去引号；引号内 `#` 不当注释）
 *   `k: v # 注释`      → `'v'`（行尾注释剔除；`#` 仅在**前面是空白或行首**时才算注释）
 *   `k: >` / `k: |`   → 后续缩进行折叠成一行（`>` 用空格连、`|` 用 \n 连）
 * 不支持（刻意，批次 1 范围外）：嵌套 map（缩进子键 **丢弃**，与旧行为一致）、
 * 锚点/别名 `&a`/`*a`、时间戳类型化（一律字符串）、多文档 `---` 分隔。
 */
export function parseYamlSubset(text) {
  const out = {}
  const lines = String(text ?? '').split(/\r?\n/)

  /** 剔除行尾注释：只在引号外、且 `#` 前是行首/空白时才截断（URL 里的 `#` 与 `"a#b"` 要留住） */
  const stripComment = (s) => {
    let quote = null
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (quote) { if (c === quote) quote = null; continue }
      if (c === '"' || c === "'") { quote = c; continue }
      if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
    }
    return s
  }
  /** 去引号（只去**成对**的首尾引号，`'don't'` 这种保留内部撇号） */
  const unquote = (s) => {
    const t = s.trim()
    if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
      return t.slice(1, -1)
    }
    return t
  }
  /** flow 数组的逗号拆分：`[a, 'b, c']` 的第二个元素不能被中间的逗号切开 */
  const splitFlow = (body) => {
    const parts = []
    let buf = ''
    let quote = null
    for (const c of body) {
      if (quote) { buf += c; if (c === quote) quote = null; continue }
      if (c === '"' || c === "'") { quote = c; buf += c; continue }
      if (c === ',') { parts.push(buf); buf = ''; continue }
      buf += c
    }
    parts.push(buf)
    return parts.map(unquote).filter((x) => x !== '')
  }
  const indentOf = (l) => l.length - l.trimStart().length

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    // 顶层键必须**不缩进**：缩进行是上一键的子内容（block 列表 / 多行文本），在上面各自的分支里消费
    if (indentOf(line) > 0) continue
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const rest = stripComment(kv[2]).trim()

    if (rest === '' ) {
      // 空值：看后续**缩进更深**的行决定是 block 列表还是多行标量；都没有 → `''`（旧行为）
      const items = []
      const buf = []
      let mode = null                                  // 'list' | 'text' | null
      let base = null
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (!l.trim()) { if (mode === 'text') buf.push(''); continue }
        const ind = indentOf(l)
        if (ind === 0) break                           // 回到顶层 → 本键结束
        if (base === null) base = ind
        if (ind < base) break
        const item = /^\s*-\s*(.*)$/.exec(l)
        if (item && mode !== 'text') { mode = 'list'; items.push(unquote(stripComment(item[1]))); continue }
        if (mode === 'list') break                     // 列表里冒出非 `-` 行 → 收工（不做混合结构）
        // 缩进行的形状是 `子键: 值` → 这是**嵌套 map**（frontmatter 里常见于自定义属性）。
        // 批次 1 不解析嵌套（与旧行为一致：旧实现丢弃全部缩进行）——保留键、值置空串，
        // 绝不能把 `b: 1` 当成上一键的多行文本拼进去（那会把结构数据变成一串假正文）。
        if (/^[\w-]+\s*:/.test(l.trim())) { mode = 'map'; break }
        mode = mode || 'text'
        buf.push(l.trim())
      }
      i = j - 1
      out[key] = mode === 'list' ? items.filter((x) => x !== '') : (buf.length ? buf.join(' ') : '')
      continue
    }

    if (rest === '>' || rest === '|') {
      const buf = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (!l.trim()) { buf.push(''); continue }
        if (indentOf(l) === 0) break
        buf.push(l.trim())
      }
      i = j - 1
      out[key] = buf.join(rest === '|' ? '\n' : ' ').trim()
      continue
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = splitFlow(rest.slice(1, -1))
      continue
    }

    out[key] = unquote(rest)
  }
  return out
}

/**
 * 正文内联 `#tag` 提取（Obsidian 口径，2026-09-14 批次 1 新增）。
 *
 * 为什么必须有：Obsidian 用户敲标签的主力形态是**正文里的 `#标签`**，而不是 frontmatter。
 * 旧实现只从三个来源收标签（frontmatter.tags / 文件名 / entry 行的 `|tag`），正文内联标签
 * **完全不进索引** → 导入 Obsidian vault 后"标签体系凭空消失"，而标签正是 related.jsonl
 * 骨架层（why.kind='tag'）与注入检索的主力信号。
 *
 * 规则（对齐 Obsidian）：
 *   · `#` 前必须是**行首或空白**（`a#b` 不是标签，`[x](#anchor)` 的锚点不是标签）；
 *   · tag 体 `[\p{L}\p{N}_][\p{L}\p{N}_/-]*`，允许中文与层级 `#a/b`；
 *   · **至少一个非数字字符**（`#123` 是纯数字 → 不是标签；`#2024财务` 是）；
 *   · 行内代码 `` `#x` `` 与 markdown 链接目标 `[x](#anchor)` 内不提取
 *     （原地**等长**清空成空格后再匹配：长度不变所以不影响任何下标，下游若要用位置也不会错位）；
 *   · 去重且**保持原样大小写**（Obsidian 标签大小写不敏感，但展示用原文）
 */
export function extractInlineTags(text) {
  const src = String(text ?? '')
  // 屏蔽两步（顺序无关，都是等长替换）：
  //  ① 行内代码：`#x` 里的 `#x` 是**示例代码**，不是标签（否则"怎么用标签"的说明文档
  //     会凭空长出一堆假标签）；
  //  ② markdown 链接目标：`[文字](#锚点)` / `[文字](note.md#片段)` 的 `#` 是锚点，
  //     不是标签。只屏蔽 `](...)` 这一段（保留 `[文字]`），免得把正文里
  //     `（#财务）` 这种中文全角括号包住的真标签也误伤。
  const masked = src
    .replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length))
    .replace(/\]\([^)\n]*\)/g, (s) => ' '.repeat(s.length))
  const out = []
  const seen = new Set()
  // 边界用**非捕获组**（只卡位），故 tag 就是 `m[1]`；`m` 标志让 `^` 命中每一行行首
  const re = /(?:^|[\s(（【\[])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gmu
  for (const m of masked.matchAll(re)) {
    const tag = m[1].replace(/[/-]+$/, '')             // `#a/b/` 收尾斜杠不是标签的一部分
    if (!tag) continue
    if (!/[\p{L}_]/u.test(tag)) continue              // 纯数字（含 #123/#12-34）不是标签
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
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

/**
 * `toBlockId` 的**形状**逆校验（S5 §7.3/§7.4 的 CLI/路由共用一处口径）。
 * 切分口径照 `kernel/knowledge.mjs` 的 `docIdOfBlockId`：取**最后**一个 '#'，而不是
 * "唯一 '#' 或首个 '#'"——文件名里带 '#' 是合法的（`space/a#1.md#0`），按首个 '#' 判定会把它
 * 判成非法：明明查得到的 id 却回 400，比不校验更糟（假阴性最贵）。
 * 只判形状、不判存在性：**参数写错**当场暴露，"库里没有"交给内核视图（空数组）。
 * 放在 shared 而非各写一份：kernel 与 server 双向禁止 import，shared 是唯一不漂移的落点。
 */
export function isBlockId(value) {
  const s = String(value ?? '')
  const i = s.lastIndexOf('#')
  if (i <= 0) return false // 无 '#' 或 docId 部分为空
  return /^\d+$/.test(s.slice(i + 1))
}

// ── 链接（Task 3；2026-09-14 批次 2 扩展为"引用体系"）──────────────────────
// 认两类站内引用：`[[wiki]]`（含 `[[目标|别名]]`、`[[目标#锚点]]`、`![[嵌入]]`）与
// 相对路径 md 链接。外链（含协议）与纯锚点 md 链接不算边——它们连不到本文档集内的文档。
//
// 2026-09-14（对标 Obsidian 批次 2）新增四件事，**每一项都是实测出来的缺口**：
//   ① `![[x]]` 嵌入：旧实现把它当**普通链接**（正则从 `[[` 起匹配），于是"嵌入"与"引用"
//      在数据层不可区分 —— 阅读视图没法把它渲染成内联内容，图谱也把嵌入当普通边。
//   ② `[[note#heading]]` 标题锚点：旧实现把 `#heading` 当成**目标的一部分**（`to='note#heading'`），
//      只在 resolveLinkTarget 里剥掉，于是锚点在落盘时丢了 → 点链接只能到文档、到不了那一节。
//   ③ `[[note#^blockId]]` 块锚点：同上，且 `^` 前缀没有任何语义（块根本没有 ID）。
//   ④ `[[#heading]]` **同文档锚点**：旧实现因 `to` 为空被直接丢弃（`!t` 短路）→
//      文档内部的目录/跳转链接整批消失。
//
// 字段契约（**to 的语义变了**，故 INDEX_VERSION 3→4）：
//   · `to`       目标原文，**锚点已剥离**（`[[a#x]]` → `'a'`）；同文档锚点为 `''`
//   · `self`     同文档锚点（`[[#x]]`）——调用方据此用"来源文档自身"作目标
//   · `anchorRef` 锚点原文（`#` 之后；block 锚点已去掉 `^`）
//   · `anchorKind` `'heading' | 'block' | ''`
//   · `anchor`   `|别名`（**保持原语义**：展示用别名，与锚点无关）
//   · `embed`    `![[...]]` 为 true
//   · `index`    匹配在原文中的字符下标（调用方据此定位所属块）
//
// 去重键 = `to` + `anchorRef`（不是只按 `to`）：`[[a#第一章]]` 与 `[[a#第二章]]` 是两个
// 不同的引用位置，反链要能分别显示；只按 `to` 去重会把第二个锚点吞掉。
//
// 返回项带 `index`（匹配在原文中的字符下标）：调用方据此把链接**定位到所属块**
// （S5.1：条目级 ref 关联要知道"是哪条经验引用了这篇文档"）。
export function extractLinks(text) {
  // 组：1=`!`（嵌入标记）2=目标（含可能的 `#锚点`）3=别名
  const wikiRe = /(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
  const mdRe = /\[([^\]]*)\]\(([^)\s]+)\)/g
  const out = []
  const seen = new Set()
  const src = String(text ?? '')

  // 防护①：排除**代码跨度**内的匹配。统计匹配位置之前的反引号数量，奇数 = 位于行内代码内。
  // 依据（真实库实测）：workflow.md 讲 JS 写法时写了 `` `anyOf:[['a','b']]` ``，
  // wiki 正则 /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/ 会把 JS 嵌套数组当成 [[wiki 引用]]，
  // 于是 links.jsonl 多出一行垃圾 `{"to":"'a','b'"}`（全库 7 个文档就这 1 条链接，还是假的）。
  // 这是**通用**防护：文档里"教人怎么写 wiki 链接"的示例段落同样会被挡住。
  const inCode = (idx) => ((src.slice(0, idx).match(/`/g) || []).length % 2) === 1

  // 防护②：**目标形状校验**——路径字符集之外的字符一律拒绝。
  // `'a','b'` 含引号与逗号 → 被拦；这挡住的是"代码/JSON/伪代码片段被当成路径"这类误判，
  // 补足防护①（若片段在代码块 ``` 内而反引号计数为偶数时，仅靠①会漏）。
  const badShape = (t) => /[\s'"(){}\[\]<>,;|]/.test(t)

  const push = (to, alias, index, opt = {}) => {
    const t = String(to ?? '').trim()
    const anchorRef = String(opt.anchorRef ?? '').trim()
    const self = opt.self === true
    // 同文档锚点 `[[#x]]` 的 to 是空串：**不能按"空目标"丢弃**（那是它合法且常见的形态）。
    if (!t && !self) return
    if (t && badShape(t)) return
    if (inCode(index)) return
    const key = `${t}\u0000${anchorRef}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      to: t,
      anchor: alias || '',
      anchorRef,
      anchorKind: anchorRef ? (opt.anchorKind || '') : '',
      embed: opt.embed === true,
      ...(self ? { self: true } : {}),
      index,
    })
  }
  let m
  while ((m = wikiRe.exec(src))) {
    const parsed = splitWikiAnchor(m[2])
    push(parsed.target, m[3] || '', m.index, {
      anchorRef: parsed.anchorRef,
      anchorKind: parsed.anchorKind,
      self: parsed.self,
      embed: m[1] === '!',
    })
  }
  while ((m = mdRe.exec(src))) {
    const href = String(m[2] || '')
    if (/^[a-z]+:\/\//i.test(href)) continue
    // 纯锚点 md 链接 `[x](#y)`：Obsidian 里是页内跳转。我们**不做**页内滚动到任意标题
    // （阅读视图的锚点跳转只服务 wiki 语法，见 lib/knowledgeBlocks），故继续跳过——
    // 否则会凭空多出一批 `to=''` 的边，把反链列表塞满无意义条目。
    if (href.startsWith('#')) continue
    const parsed = splitWikiAnchor(href)
    push(parsed.target, '', m.index, {
      anchorRef: parsed.anchorRef,
      anchorKind: parsed.anchorKind,
      self: false,
      embed: false,
    })
  }
  return out
}

/**
 * 拆分引用的锚点部分（2026-09-14 批次 2）。Obsidian 的锚点语法：
 *   `目标#标题`     → heading 锚点（标题文本，大小写不敏感、空格/`-` 等价）
 *   `目标#^块ID`    → block 锚点（`^` 后是块 ID；`^` 本身是语法标记，不属于 ID）
 *   `#标题` / `#^块ID` → **同文档**锚点（目标为空，`self: true`）
 *   `目标`          → 无锚点
 *
 * 为什么用 `lastIndexOf('#')` 而不是第一个：文件名里含 `#` 虽罕见但合法
 * （`issue#42.md`）。取最后一个 `#` 的代价是"锚点里含 `#`"会拆错——而 Obsidian 的标题里
 * 出现 `#` 同样会歧义（官方也按最后一段解释），两边一致即可，不为特例改规则。
 */
export function splitWikiAnchor(raw) {
  const s = String(raw ?? '').trim()
  const hash = s.lastIndexOf('#')
  if (hash < 0) return { target: s, anchorRef: '', anchorKind: '', self: false }
  const target = s.slice(0, hash).trim()
  const ref = s.slice(hash + 1).trim()
  if (!ref) return { target, anchorRef: '', anchorKind: '', self: !target }
  if (ref.startsWith('^')) {
    const id = ref.slice(1).trim()
    return { target, anchorRef: id, anchorKind: id ? 'block' : '', self: !target }
  }
  return { target, anchorRef: ref, anchorKind: 'heading', self: !target }
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
export function resolveLinkTarget({ fromRel = '', to = '', spaceId = '', docIds = null, self = false } = {}) {
  // 同文档锚点（`[[#标题]]` / `[[#^块ID]]`，2026-09-14 批次 2）：目标是**来源文档自身**。
  // 这类引用在旧实现里因为 `to === ''` 被直接丢弃，于是文档内部的目录式跳转整批消失。
  // 仍需 docIds 校验：文件可能刚被删（索引还是旧的），此时"指向自己"也该算断链。
  if (self === true) {
    const own = toDocId(spaceId, normalizeRelPath(fromRel))
    return !own ? null : ((!docIds || docIds.has(own)) ? own : null)
  }
  const src = String(to ?? '').trim()
  if (!src || /^[a-z]+:\/\//i.test(src) || src.startsWith('#')) return null
  // `to` 自批次 2 起已由 extractLinks 剥好锚点；这里的 replace 只作防御（老索引 / 手写调用）
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
export function serializeIndex({ docs = [], inverted = [], links = [], tags = {}, related = [] } = {}) {
  const jsonl = (arr) => (arr.length ? arr.map((x) => JSON.stringify(x)).join('\n') + '\n' : '')
  return {
    docs: jsonl(docs),
    inverted: jsonl(inverted),
    links: jsonl(links),
    tags: JSON.stringify(tags),
    // S5 Task 4：`related.jsonl`（隐式派生的关联锚点）与 links（显式 md 链接）**分文件**，
    // 但共用这里的 JSONL 序列化规则（空集产出空串、末行也带 \n）——两处各写一份必然漂移。
    related: jsonl(related),
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

// ── 关联锚点（S5 Task 1，spec §5/§7.1）─────────────────────────────────────
// 为什么这些函数在 shared：关联计算要与检索共用同一套切块/向量/IDF/指纹口径
// （**例外**：关联层的 idf 口径由调用方独立传入，见 spec §13.5——检索按块、关联按文档），
// 且必须能在无 IO 的纯函数层单测（阈值行为是"回归易碎区"，见下方校准注释）。
// 本节阈值经过**两轮**真实经验库实测校准（首轮 76 条 spec §13、二次修正 69 条参与条目 §13.5），
// 不是设计偏好：改任何一个数字前请先重跑校准，否则覆盖层会静默失效（见 SIM_THRESHOLD 注释）。

// 覆盖层相似度门槛。**二次校准**（spec §13.5；改数字前务必先重跑校准）：
// 首轮校准的 idf 口径与线上不同源（用了 `blockIndexText` 的 gram，而 Task 2 落地后线上按
// `relationContent`；且线上是**按块**统计）→ 阈值不可搬。修正为「关联层独立用按文档 idf」
// 后重测 **69 条真实参与条目、跨 tag 对**（同 tag 走骨架层不计）：
//   跨 tag 对最高 cos = **0.312**（知识库S1实施 ↔ 知识库全四期实施）；
//   阈值命中：0.32 → **0 对（覆盖层空转 = 功能失效）**；0.18 → 3 对；**0.15 → 16 对**，
//   覆盖 18/69 条（其中**无 tag 的 5/9 条**——无 tag 条目**只能**靠覆盖层，骨架层对它恒空）。
//   人工核对：Top 7 为真相关（0.212 驾驶舱原型↔驾驶舱页面、0.192 工作流删除交互↔工作流
//   端到端排查 …），**第 8 起**出现通用工程词噪声（0.167 应用智控 ↔ 知识库S1实施）。
// 取 0.15：再往上（0.18/0.20）覆盖层只剩个位数边、无 tag 条目重新变成孤岛；再往下噪声成片。
// 噪声由三重约束兜住，不靠阈值单打：`MAX_CONTENT_RELATED=5` 上限（每条最多 5 个内容锚点）、
// content 边 `shared` 非空必填（无解释的边直接丢弃，见 relatedCandidates 末段）、GUI 默认折叠。
// ⚠️ **该阈值与语料规模相关**（69 条时最高 0.312）；语料显著增长/换库后必须重新校准。
export const SIM_THRESHOLD = 0.15
// 精确重复判据：实测正库存在 cos=1.000 的重复对（spec §9.2）。重复项**没有阅读价值**，
// 若混进 related 会挤占锚点预算，故单独归类为 duplicate（GUI 独立提示，不计入 MAX_RELATED）。
export const DUP_COS = 0.95
// 参与集最小内容长度。实测 7 条垃圾条目（`kernel/memory.mjs` 模板化写入，形如
// `流程要点：用户回答：`、`业务要点（请注意）：`）两两内容全同 → cos=1.000，会灌入
// "完美相似但零信息"的边。20 字以下的内容里 bigram 噪声占主导（判别力≈0），故设 20 作为
// 参与集门槛（Task 3 在源头也不再产生这类条目，两头都防）。
export const MIN_LEN = 20
// 单块锚点总预算（骨架 + 覆盖去重后截断）与两层各自的上限：防 GUI/agent 上下文膨胀
// （related.jsonl 行数上限 = 参与条目数 × 8）。骨架层必然非空且零噪声，**先占预算**。
export const MAX_RELATED = 8
export const MAX_TAG_RELATED = 5
export const MAX_CONTENT_RELATED = 5

// ref 层（S5.1）：一条**手写引用**最多连到被引文档的几条条目。
// 为什么必须设上限：真实库 `workflow.md` 有 57 条条目，若"引用整篇文档"就全连，
// 一次引用会产出 57 条边（物化膨胀 + 挤占锚点预算）。按**内容相似度**取前 3，
// 即"引用一篇文档时，最值得接着读的 3 条经验"。取 3 而非 5：ref 是
// 结构性信号（层级/主题归属）的补充，不是替代，且用户手写引用通常指向"那篇文档"
// 而非"其中某几条"，给太多会把自动派生层（content）挤没。
export const MAX_REF_RELATED = 3

// 覆盖层的 tagBoost **必须为 1**（校准结论，不是随手选；spec §5.3）：
//  ① `vectorizeText` 的 boost 在**归一化之后**乘（`shared/knowledge-core.mjs:257-259`），
//     即返回值 = 归一化向量 × boost ⇒ `cosine` 不是真余弦（两侧各乘一次 boost → 分数被放大
//     boost² 倍）。二次校准（按文档 idf）实测：=1 时跨 tag 对最高 cos=0.312（值域正常），
//     =3 时同一批对最高 cos=**0.950**（= 9×真实余弦），会直接撞上 `DUP_COS=0.95`
//     被误判成 duplicate —— 阈值彻底失去意义。
//  ② 更要紧的是 boost>1 会**放大同 tag 对**，覆盖层退化成骨架层的重复，把"跨主题同问题"
//     淹没；tag 关系本就由**骨架层**负责，覆盖层只按内容算。
export const RELATION_TAG_BOOST = 1

// 剥掉"类型前缀"——但**只认已知的类型标签**，不按"首个冒号"一刀切。
//
// 前缀由 kernel/memory.mjs:183-187 生成（`流程要点：` / `用户偏好（x）：` / `业务要点（x）：` /
// `用户纠正（x）：`），它只标条目类型、**同类型条目共有**，属纯噪声：
// 实测不去前缀时，高分对的 `shared` 全是"流程/程要/要点"这类前缀自身的字（spec §13.1 轮②）。
//
// ⚠️ **为什么不能用 `indexOf('：')` 一刀切**（S5.1 实测修正，原实现即如此）：
// memory 条目的正文常含**中文冒号**，一刀切会把正文前段当"前缀"一起剥掉。
// 真实库 78 条 entry 实测：**70 条（90%）被剥**，其中 **20 条剥掉 >12 字**（误剥正文），
// **1 条被剥到 < MIN_LEN(20) 而彻底排除在关联之外**。例：
//   "在开发/调试企业微信相关自动化（发消息、通知、机器人）时，用户明确要求：测试目标只能…"
//   一刀切后只剩"测试目标只能…"——**前半段语义全丢**（content 相似度就建在残段上）。
// 故收窄为白名单：**零误伤**，代价是将来 memory.mjs 若新增类型需在此登记（宁可漏剥，
// 不可错剥——漏剥只是多点噪声，错剥是丢掉真实语义）。
const TYPE_PREFIX_RE = new RegExp(
  '^(?:流程要点|用户偏好|业务要点|用户纠正|用户画像|会话主题)'
  + '(?:[（(][^：\\n，。、；！？]{0,12}[）)])?：',
)

export function stripTypePrefix(s) {
  const t = String(s ?? '')
  return t.replace(TYPE_PREFIX_RE, '')
}

// 关联/索引的统一正文口径：`stripTypePrefix(full || text)`。
// **必须优先 full**：kernel/memory.mjs:184-186 生成条目时 `text = 类型前缀 + t.slice(0,60)`、
// `full = t.slice(0,500)`，实测同一条目 text=45 字 vs full=471 字（**10 倍信息差**）——
// 在截断摘要上算相似度必然测不出语义关系（spec §13.4）。
export function relationContent(block) {
  const b = block || {}
  return stripTypePrefix(b.full || b.text || '')
}

// **检索**索引的文本口径（与 `relationContent` 故意不同，别把两者合并）。
//
// 为什么不用 `relationContent` 直接做检索索引：实测真实库 76 条条目里 **59 条（78%）**
// 的摘要是"人工/agent 另写的抽象摘要"，其用词**不落在 full 里**（如 `摘要：…不回显表达式返回值`
// / `正文：解决：js 内把结果写入 document.title…`）。若索引只取 full，这些**摘要独有词**
// 会整体退出倒排 —— 实测 10 个 query 中有 3 个换块、其中 `不回显` **明显退化**
// （0.667 命中正确条目 → 0.084 命中无关块）。这与"索引口径修正本该改善检索"的目的相反。
//
// 取并集而非替换，理由有三：
//  ① 保住全部收益：`expression` / `keep-alive` 这类**只在长正文里**的词仍能被检索到
//     （旧口径 0 命中）——这正是当初改口径的动机；
//  ② 找回被丢掉的召回：摘要独有词重新可检索（`不回显` 恢复命中正确条目）；
//  ③ 沿用本仓库既有先例：legacy 记忆检索 `kernel/graph.mjs:36` 的索引文本就是
//     `` `${theme} ${tagText} ${summary} ${full}` ``（摘要与全文**都在**）。
// 摘要已被 full 包含时不重复拼接（memory.mjs 那类"摘要=正文前 60 字"的条目即如此），
// 避免给倒排灌入重复 gram、也让 df 统计不被自己抬高。
export function retrievalText(block) {
  const b = block || {}
  const content = relationContent(b)
  const summary = stripTypePrefix(b.text || '')
  if (!summary || content.includes(summary)) return content
  return `${summary} ${content}`
}

// 内容指纹：sha1 前 12 位（spec §6.2）。读时校验靠它判断"边两端的内容还是不是物化时那份"，
// 内容被改 → 该边剔除（保守：宁可少连也不错连）。48 bit 在单库规模下碰撞可忽略。
export function blockContentSig(block) {
  return createHash('sha1').update(relationContent(block), 'utf8').digest('hex').slice(0, 12)
}

function toTfMap(tf) {
  if (tf instanceof Map) return tf
  if (tf && typeof tf === 'object') return new Map(Object.entries(tf))
  return new Map()
}

// 共有特征词：按 `idf × min(tf_a, tf_b)` 取 top-N（spec §5.4）。
// 为什么用 min：两边都得"说得出"这个词才算共同证据（用 a 的 tf 会把只在 a 里高频的词拉进来）。
// 为什么乘 idf：满库皆有的高频 gram（"流程/要点"这类）idf 低，会被压下去，留下的才可读、可解释。
// 同权重按 gram 字典序 —— 关联物化要求可复现（同一库两次全量重建必须产出同一份 related.jsonl）。
export function sharedFeatures(tfA, tfB, { idf = null, topN = 5 } = {}) {
  const a = toTfMap(tfA)
  const b = toTfMap(tfB)
  const out = []
  for (const [gram, countA] of a) {
    const countB = b.get(gram)
    if (!countB) continue
    out.push([gram, (idf?.get?.(gram) ?? 1) * Math.min(countA, countB)])
  }
  out.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
  return out.slice(0, Math.max(0, topN)).map(([gram]) => gram)
}

// 块 id 取用顺序：索引里的块用 `blockId`（kernel/knowledge.mjs:570），raw splitBlocks 块用 `id`
function blockIdOf(block) {
  const id = block?.blockId ?? block?.id
  return id ? String(id) : ''
}

// 条目标签字段：索引块是 `tag`（kernel/knowledge.mjs:122/237），raw 块是 `entryTag`
function blockTagOf(block) {
  return block?.tag ?? block?.entryTag ?? null
}

// 关联正文：优先用调用方预计算的 `relContent`（Task 4 全量物化时避免对同一块重复切词），
// 否则现算。两者语义完全相同（都是 relationContent）。
function blockContentOf(block) {
  const pre = block?.relContent
  return typeof pre === 'string' ? pre : relationContent(block)
}

function gramCountsOf(block, content) {
  const pre = block?.gramCounts
  return pre instanceof Map ? pre : countGrams(content)
}

// 块在文档中的位置：优先取显式字段，否则从 "<docId>#<n>" 反解（两种块形态都能用）
function posOf(block) {
  const id = blockIdOf(block)
  const i = id.lastIndexOf('#')
  const doc = block?.docId ? String(block.docId) : (i < 0 ? id : id.slice(0, i))
  let n = Number(block?.n)
  if (!Number.isFinite(n)) n = i < 0 ? Number.MAX_SAFE_INTEGER : Number(id.slice(i + 1))
  if (!Number.isFinite(n)) n = Number.MAX_SAFE_INTEGER
  return { doc, n }
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// 骨架层排序键（spec §5.2，定死以免实现者猜）：
//   ① 同文档：按 |n_a - n_b| 升序（经验文件的同主题条目多集中在一处、位置相邻即最相关）
//   ② 跨文档：排在所有同文档条目之后，之间按 (docId, n) 字典序（跨文档缺乏可靠顺序信号，
//      用稳定字典序而非随机序 → 结果可复现）
function cmpSkeleton(a, b, base) {
  const sameA = a.doc === base.doc
  const sameB = b.doc === base.doc
  if (sameA && sameB) return Math.abs(a.n - base.n) - Math.abs(b.n - base.n)
  if (sameA !== sameB) return sameA ? -1 : 1
  return cmpStr(a.doc, b.doc) || a.n - b.n
}

/**
 * 一条条目的关联候选（spec §5/§7.1）：骨架层（同 tag）+ 覆盖层（内容相似）+ 重复标记。
 * @param block 条目块 `{blockId|id, tag, text, full}`；可带预计算 `relContent`/`gramCounts`
 * @param pool  同空间的全部条目块（**调用方先按空间过滤**——spec 非目标：不做跨空间隐式关联）
 * @param idf   `buildIdf` 的产物（为 null 时权重退化为 1，仍可用）
 * @returns `[{ to, why }]`，why 形态：`{kind:'tag',tag}` / `{kind:'content',score,shared}` /
 *          `{kind:'duplicate',score}`。duplicate **不计入** MAX_RELATED，附在末尾。
 */
export function relatedCandidates(block, pool = [], { idf = null, topN = 5, minScore = SIM_THRESHOLD, dropped = null } = {}) {
  // `dropped`（可选，S5 Task 6）：调用方传普通对象，本函数**原地累加**计算期丢弃计数
  // —— `stats().related.dropped` 要的是"算出来但没留下的候选数"，而截断（三层上限）与
  // `shared` 为空的丢弃都发生在**本函数内部**，内核无法从返回值反推（返回值只有留下的那些）。
  // 只接受对象、缺省 null ⇒ 既有调用方与返回值**逐字不变**（纯增量，无行为漂移）。
  const bump = (k, n = 1) => { if (dropped && typeof dropped === 'object' && n > 0) dropped[k] = (dropped[k] || 0) + n }
  const from = blockIdOf(block)
  const content = blockContentOf(block)
  // 参与集门槛（spec §5.1）：非 entry 由调用方保证，这里管长度——垃圾条目（去前缀后很短）不参与
  if (!from || content.length < MIN_LEN) return []
  const tfA = gramCountsOf(block, content)
  // tagBoost=RELATION_TAG_BOOST(=1)：理由见该常量上方注释（校准结论，勿改）
  const vecA = vectorizeText(content, { tagBoost: RELATION_TAG_BOOST, idf })
  const tagA = blockTagOf(block)
  const posA = posOf(block)

  const tagHits = []
  const contentHits = []
  const dups = []
  for (const p of pool) {
    const to = blockIdOf(p)
    if (!to || to === from) continue
    // 每条边各自判参与集：**存量垃圾条目靠这里防御**（源头修复只防"新产生"，spec §9.1 两步都要）
    const pc = blockContentOf(p)
    if (pc.length < MIN_LEN) continue
    const cos = cosine(vecA, vectorizeText(pc, { tagBoost: RELATION_TAG_BOOST, idf }))
    // duplicate 先判：它对"这两个是同一份东西"最有断言力，且必须独立于 related 预算（spec §5.5）
    if (cos >= DUP_COS) { dups.push({ to, why: { kind: 'duplicate', score: round4(cos) } }); continue }
    const tagB = blockTagOf(p)
    if (tagA && tagB === tagA) { tagHits.push({ to, why: { kind: 'tag', tag: tagA }, pos: posOf(p) }); continue }
    if (cos < minScore) continue
    const shared = sharedFeatures(tfA, gramCountsOf(p, pc), { idf, topN })
    // 硬约束：content 边必须带非空 shared（只有分数、无法解释 = 宁缺勿滥，spec §5.4）
    // （cos>0 时理论上必有共有 gram，此分支是给 topN=0 / idf 异常兜底的保险）
    if (!shared.length) { bump('noShared'); continue }
    contentHits.push({ to, why: { kind: 'content', score: round4(cos), shared }, score: cos })
  }

  tagHits.sort((x, y) => cmpSkeleton(x.pos, y.pos, posA) || cmpStr(x.to, y.to))
  contentHits.sort((x, y) => y.score - x.score || cmpStr(x.to, y.to))
  dups.sort((x, y) => y.why.score - x.why.score || cmpStr(x.to, y.to))
  const pub = ({ to, why }) => ({ to, why })
  // 骨架层先占预算（必然非空、零噪声），覆盖层按分数降序补位，总预算 MAX_RELATED 截断
  const tagKept = tagHits.slice(0, MAX_TAG_RELATED)
  const contentKept = contentHits.slice(0, MAX_CONTENT_RELATED)
  // "超上限被截断"要三层都计：两层各自的上限 + 合并后的总预算（都是"算出来但没留下"）。
  // duplicate **不计**：它本就不占预算、全部返回（spec §5.5），算进去会虚增 dropped。
  bump('capped', (tagHits.length - tagKept.length) + (contentHits.length - contentKept.length))
  const budgeted = [...tagKept, ...contentKept]
  bump('capped', Math.max(0, budgeted.length - MAX_RELATED))
  const kept = budgeted.slice(0, MAX_RELATED).map(pub)
  // duplicate 不计入 MAX_RELATED：它们不是"关联"（无阅读价值），必须独立呈现（spec §5.5/§3）
  return [...kept, ...dups.map(pub)]
}

function round4(x) {
  return Number(Number(x).toFixed(4))
}

/**
 * 读时校验（spec §6.2）：三条检查全过才 true。校验是**只读语义**——只返回视图，不改文件。
 * @param edge   `{from,to,why:{kind},sigFrom,sigTo}`（related.jsonl 的一行）
 * @param lookup 块查询：函数 `(blockId)=>block` | Map | 普通对象（kernel 侧给 Map/函数均可）
 */
export function validateRelation(edge, lookup) {
  const get = typeof lookup === 'function'
    ? lookup
    : lookup instanceof Map
      ? (id) => lookup.get(id)
      : (id) => (lookup ? lookup[id] : null)
  const a = get(edge?.from)
  const b = get(edge?.to)
  if (!a || !b) return false // ① 端点仍存在（文档/块被删 → 剔除）
  const kind = edge?.why?.kind
  if (kind === 'tag') {
    const ta = blockTagOf(a)
    // ② 同 tag 关系当前仍成立（字段比较，O(1)）
    return !!ta && ta === blockTagOf(b)
  }
  if (kind === 'content' || kind === 'duplicate') {
    // ③ 两端内容指纹仍等于物化时那份（内容被改 → 剔除；保守：宁可少连也不错连）
    return blockContentSig(a) === edge.sigFrom && blockContentSig(b) === edge.sigTo
  }
  if (kind === 'ref') {
    // ref（S5.1）：**只要求两端存在**（① 已在上面校验），**不比对内容指纹**。
    // 理由：引用是**用户手写的意图**——"这条经验引用了那篇文档"不因文档内容被编辑而失效。
    // 若按指纹校验，改一个字就会让引用锚点凭空消失，与用户预期相反
    // （手写引用的语义是"我指向那篇文档"，与目标内容无关）。
    return true
  }
  return false // 未知 kind 一律不认（保守）
}

