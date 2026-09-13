# 知识内核（S1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 YFWorking 建成文件为真源的多空间知识库内核：可切块、可索引、可按"单条经验"检索，并向 GUI 与 AI 双端提供统一接口。

**Architecture:** Markdown 是唯一权威数据（`~/.yfw/knowledge/spaces/` + 外挂的经验目录 + 只读 `packs/`）；索引全部派生、可随时删了重建（`.index/` 下纯 JSONL，与已验证的 `graph.jsonl` 同构）；纯函数集中在 repo 根 `shared/`，经一级 `../` 逃逸同时满足 bun 单文件内联与 `mirrorKernelParentDeps` 镜像；kernel 持有权威实现，server 只做薄转发与文件落盘。

**Tech Stack:** Node ESM（`node:test` 内置断言，无测试框架）、bun（`--target=node` 单文件打包）、既有 `server/kernel-readonly.mjs` 子进程转发范式。

**上游 spec：** `docs/superpowers/specs/2026-09-13-knowledge-core-design.md`（S1；决策已确认）

## Global Constraints

- **共享层依赖纪律**：`shared/**` 只允许 `node:path`（纯字符串）；**禁止** `node:fs`、`node:child_process`、任何第三方包。理由：内核被 bun 打成单文件且运行于无 `node_modules` 的镜像目录（`server/bridge.mjs:583-648`）。
- **依赖方向**：`shared ← kernel`、`shared ← server`，**`kernel` ⊥ `server` 双向禁止**（`server/approval-mode.mjs:4-5` 明载：打包产物无 `kernel/` 目录）。
- **测试位置**：kernel 测试一律放 `kernel-tests/`（`package.json` 的 test glob 不含 `kernel/*.test.mjs`），import 用 `../kernel/xxx.mjs`。
- **禁止启动 bridge**：所有 server 侧测试直接调 handler（本仓库有"测试起桥误杀运行中应用"的前车之鉴，见 `server/logs-routes.mjs:5-7`）。
- **索引可弃**：删掉 `.index/` 必须毫发无损；索引损坏/缺失一律降级为"无索引"，绝不抛错打断会话。
- **契约纯增量**：不改任何既有函数签名；既有导出保持可用（迁移后原模块 re-export）。
- **路径穿越三重防护**：名白名单 + 基名约束 + `resolve` 后断言在根内（范式见 `server/logs-routes.mjs:19-27`）。
- **测试隔离**：任何碰用户数据的测试必须 `mkdtempSync` 或设 `YFWORKING_HOME` 指向临时目录。

## File Structure

**Create:**

| 文件 | 职责 |
|---|---|
| `shared/knowledge-core.mjs` | 纯函数：frontmatter/条目/块切分、gram 分词、向量、打分融合、索引序列化、内置空间规格 |
| `shared/knowledge-core.test.mjs` | 上述纯函数单测（fixture 驱动，无文件系统） |
| `kernel/knowledge.mjs` | 空间发现、文档解析、索引构建/加载、`searchKnowledge`、增量更新 |
| `kernel/knowledge-cli.mjs` | `--knowledge <op>` 的聚合实现（stdout JSON，短路不进 loop） |
| `kernel-tests/knowledge.test.mjs` | 内核侧测试（临时 `configDir` 隔离） |
| `kernel-tests/knowledge-core-parity.test.mjs` | 纯函数特征测试（钉住迁移自 `graph.mjs` 的行为） |
| `kernel-tests/knowledge-parity.test.mjs` | 双端对拍：kernel 与 server 检索 top-5 的 `blockId` 序列必须一致 |
| `kernel/knowledge-search.mjs` | `KnowledgeSearch` 工具的检索实现 |
| `server/knowledge-routes.mjs` | `/knowledge/*` 路由（转发 + 文档写入），`handleKnowledgeRoute()` 契约 |
| `server/knowledge-routes.test.mjs` | 直调 handler（注入假 kernel 调用，不起桥） |

**Modify:**

| 文件 | 改动 |
|---|---|
| `kernel/graph.mjs:20-88` | 纯函数改为从 `shared/knowledge-core.mjs` 导入并 re-export（去重，行为不变） |
| `kernel/memory.mjs:8-58,110-129` | `hashLine`/`parseEntryLine`/`keywordScore` 改为从 shared 导入并 re-export |
| `kernel/tools.mjs` | 新增 `KnowledgeSearch` 工具（插在 `MemorySearch` 之后） |
| `kernel/cli.mjs:70-141` | `parseArgs` 增 `--knowledge`/`--space`/`--path`/`--id`/`--query`/`--keywords`/`--topK`/`--mode`/`--force` |
| `kernel/cli.mjs:182-192` | 只读子命令短路块增 `--knowledge` 分支 |
| `kernel/memory-search.mjs` | `searchLocalMemory` 保持签名，内部标注由 `KnowledgeSearch` 取代（本期双轨，不清除） |
| `server/bridge.mjs:1826-1834` | 接一行 `/knowledge/*` 路由（紧接 logs 路由之后） |
| `electron-builder.yml:24-36` | `files:` 增 `'shared/**/*'` |
| `package.json` | `scripts.test` 增 `"shared/**/*.test.mjs"` |

---

### Task 1: shared 块切分内核

**Files:**
- Create: `shared/knowledge-core.mjs`
- Test: `shared/knowledge-core.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `hashLine(text: string): string` —— 8 位 hex，与前两处实现逐字相同
  - `parseFrontmatter(raw: string): { front: Record<string,string>, body: string, bodyStartLine: number }`
  - `parseEntryLine(line: string): { tag: string|null, summary: string, full: string }`
  - `ENTRY_LINE_RE: RegExp` = `/^- \[([^\]]*)\]\s*(.*)$/`
  - `splitBlocks(body: string, opts?: { startLine?: number }): Block[]`
  - `Block = { n: number, kind: 'heading'|'para'|'list'|'code'|'table'|'entry', level: number, text: string, line: number, entryTag?: string|null, entryFull?: string }`

- [ ] **Step 1: 写失败测试**

创建 `shared/knowledge-core.test.mjs`：

```js
// shared 纯函数测试：块切分 / frontmatter / 经验条目解析。
// 本文件不碰文件系统（shared 层的依赖纪律：只允许 node:path）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashLine, parseFrontmatter, parseEntryLine, splitBlocks, ENTRY_LINE_RE,
} from './knowledge-core.mjs'

test('hashLine 与既有实现逐字相同（钉住稳定 ID）', () => {
  // 期望值取自 kernel/memory.mjs 现行算法：h=((h<<5)-h+c)|0，无符号 hex 8 位
  assert.equal(hashLine('- [会话|PS材料] 摘要 -- 全文'), hashLine('- [会话|PS材料] 摘要 -- 全文'))
  assert.match(hashLine('任意文本'), /^[0-9a-f]{8}$/)
  assert.notEqual(hashLine('a'), hashLine('b'))
})

test('parseFrontmatter 分离 front 与 body 并给出 body 起始行号', () => {
  const raw = '---\nname: workflow\ndescription: 工作流\n---\n- [会话] 甲 -- 乙\n'
  const r = parseFrontmatter(raw)
  assert.equal(r.front.name, 'workflow')
  assert.equal(r.front.description, '工作流')
  assert.equal(r.body, '- [会话] 甲 -- 乙\n')
  assert.equal(r.bodyStartLine, 5) // body 首行（条目行）是原文第 5 行：4 行 frontmatter+分隔 之后
})

test('parseFrontmatter 无 frontmatter 时 body 原样、起始行为 1', () => {
  const r = parseFrontmatter('普通正文\n第二行\n')
  assert.deepEqual(r.front, {})
  assert.equal(r.body, '普通正文\n第二行\n')
  assert.equal(r.bodyStartLine, 1)
})

test('parseEntryLine 解析标签/摘要/全文，兼容无标签与无分隔符', () => {
  const a = parseEntryLine('- [会话|企微CLI化] 只发文件传输助手 -- 完整背景与做法')
  assert.deepEqual(a, { tag: '企微CLI化', summary: '只发文件传输助手', full: '完整背景与做法' })
  const b = parseEntryLine('- [会话] 无标签条目 -- 全文')
  assert.deepEqual(b, { tag: null, summary: '无标签条目', full: '全文' })
  const c = parseEntryLine('- [会话|X] 只有摘要没有分隔符')
  assert.deepEqual(c, { tag: 'X', summary: '只有摘要没有分隔符', full: '只有摘要没有分隔符' })
})

test('splitBlocks 切出 heading/para/list/code/table/entry 六类，line 可回溯', () => {
  const body = [
    '## 标题一',            // 1 heading
    '',                     // 2
    '一段正文。',            // 3 para
    '',                     // 4
    '- 列表甲',              // 5 list
    '- 列表乙',              // 6 list
    '',                     // 7
    '```js',                // 8 code
    'const a = 1',
    '```',                  // 10
    '',                     // 11
    '| 列 | 值 |',           // 12 table
    '| --- | --- |',
    '| a | 1 |',            // 14
    '',                     // 15
    '- [会话|标签] 摘要 -- 全文',  // 16 entry
  ].join('\n')
  const blocks = splitBlocks(body, { startLine: 1 })
  const kinds = blocks.map(b => b.kind)
  assert.deepEqual(kinds, ['heading', 'para', 'list', 'code', 'table', 'entry'])
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[0].line, 1)
  assert.equal(blocks[1].line, 3)
  assert.equal(blocks[2].text, '- 列表甲\n- 列表乙')
  assert.ok(blocks[3].text.startsWith('```js'))
  assert.ok(blocks[3].text.endsWith('```'))
  assert.equal(blocks[4].kind, 'table')
  assert.equal(blocks[5].entryTag, '标签')
  assert.equal(blocks[5].text, '摘要')
  assert.equal(blocks[5].entryFull, '全文')
  assert.equal(blocks[5].line, 16)
})

test('splitBlocks 起点行号随 startLine 平移（frontmatter 之后仍可回溯原文）', () => {
  const blocks = splitBlocks('## 标题\n', { startLine: 5 })
  assert.equal(blocks[0].line, 5)
})

test('splitBlocks 对空 body 与纯空行返回空数组', () => {
  assert.deepEqual(splitBlocks(''), [])
  assert.deepEqual(splitBlocks('\n\n\n'), [])
})

test('ENTRY_LINE_RE 只认行首条目形状', () => {
  assert.ok(ENTRY_LINE_RE.test('- [会话] 甲 -- 乙'))
  assert.ok(!ENTRY_LINE_RE.test('  - 普通列表项'))
  assert.ok(!ENTRY_LINE_RE.test('文本 - [会话] 甲'))
})

test('列表项紧邻经验条目时，条目单独成块并保留 entryTag（真实经验文件形状）', () => {
  // 真实安装路径（installer.nsh:237 播种 starter + 首次 appendMemoryEntry）产出的文件
  // 就是「bullet 头部 + 条目行相邻」，若条目被并入 list 块则单条经验检索完全失效。
  const body = [
    '**更新记录**：',
    '- 记录一：做了什么',
    '- 记录二：为什么这么做',
    '- [会话|企微CLI化] 只发文件传输助手 -- 真实沟通渠道的测试只发文件传输助手',
    '- [会话|申报材料] 四表联动 -- 口径必须对齐',
  ].join('\n')
  const blocks = splitBlocks(body, { startLine: 1 })
  const kinds = blocks.map((b) => b.kind)
  assert.deepEqual(kinds, ['para', 'list', 'entry', 'entry'])
  const entries = blocks.filter((b) => b.kind === 'entry')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].entryTag, '企微CLI化')
  assert.equal(entries[0].text, '只发文件传输助手')
  assert.equal(entries[0].line, 4, 'line 指向原文第 4 行')
  assert.equal(entries[1].entryTag, '申报材料')
  assert.equal(entries[1].line, 5)
})

test('纯列表文件 / 有序列表 / 缩进列表仍整体成 list 块（修 list 循环不得破坏这些）', () => {
  const plain = splitBlocks('- 甲\n- 乙\n- 丙\n')
  assert.deepEqual(plain.map((b) => b.kind), ['list'])
  assert.equal(plain[0].text, '- 甲\n- 乙\n- 丙')

  const ordered = splitBlocks('1. 甲\n2. 乙\n')
  assert.deepEqual(ordered.map((b) => b.kind), ['list'])

  const indented = splitBlocks('  - 甲\n  - 乙\n')
  assert.deepEqual(indented.map((b) => b.kind), ['list'])

  // 连续多个条目行：必须逐条成块（这是经验文件的主形态，绝不能回归）
  const entries = splitBlocks('- [会话|A] 甲 -- a\n- [会话|B] 乙 -- b\n- [会话|C] 丙 -- c\n')
  assert.deepEqual(entries.map((b) => b.kind), ['entry', 'entry', 'entry'])
  assert.deepEqual(entries.map((b) => b.entryTag), ['A', 'B', 'C'])
})

test('四反引号围栏整体成一个 code 块（仓库 BUILD.md 大量使用）', () => {
  const body = [
    '````md',
    '```js',
    'const a = 1',
    '```',
    '````',
  ].join('\n')
  const blocks = splitBlocks(body, { startLine: 1 })
  assert.deepEqual(blocks.map((b) => b.kind), ['code'])
  assert.ok(blocks[0].text.startsWith('````md'))
  assert.ok(blocks[0].text.endsWith('````'))
})

test('波浪号围栏与未闭合围栏均不崩', () => {
  assert.deepEqual(splitBlocks('~~~\n正文\n~~~\n').map((b) => b.kind), ['code'])
  // 未闭合：吃到文件末尾，不抛错
  const open = splitBlocks('```js\nconst a = 1\n')
  assert.deepEqual(open.map((b) => b.kind), ['code'])
})

test('UTF-8 BOM 开头的文件仍能解析 frontmatter（Windows 记事本场景）', () => {
  const r = parseFrontmatter('\uFEFF---\nname: workflow\n---\n- [会话] 甲 -- 乙\n')
  assert.equal(r.front.name, 'workflow')
  assert.equal(r.body, '- [会话] 甲 -- 乙\n')
  assert.equal(r.bodyStartLine, 4)
})

test('splitBlocks 对 BOM 开头的无 frontmatter 文本正常工作', () => {
  const blocks = splitBlocks('\uFEFF# 标题\n\n正文\n', { startLine: 1 })
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'para'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test shared/knowledge-core.test.mjs`
Expected: FAIL —— `Cannot find module './knowledge-core.mjs'`

- [ ] **Step 3: 创建 `shared/knowledge-core.mjs`**

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test shared/knowledge-core.test.mjs`
Expected: PASS —— `# pass 14`（全部用例）

- [ ] **Step 5: 提交**

```bash
git add shared/knowledge-core.mjs shared/knowledge-core.test.mjs
git commit -m "feat(knowledge): shared 纯函数层地基——frontmatter/经验条目/块切分"
```

> 修订（评审返工）：原实现有三处缺陷，已修复并被测试钉住 ——
> ① **列表续行吞掉相邻经验条目**（真实安装路径 starter 模板产出「bullet 头部 + 条目行相邻」，
> 导致该主题文件 entry 块数恒为 0、单条经验检索整文件失效，P0）；② **四反引号围栏被提前闭合**
> （单块切成三段）；③ **BOM 开头文件 frontmatter 全丢**（Windows 记事本场景）。围栏闭合已按
> CommonMark 全规则实现（同类 / 长度 >= 开围栏 / 仅围栏字符 / 缩进不深于开围栏 +3），并以
> `micromark` 作参考实测对齐；同时修了本文档早先写错的 `bodyStartLine` 期望值（4 → 5）。

---

### Task 2: shared 向量与打分

**Files:**
- Modify: `shared/knowledge-core.mjs`（追加导出）
- Test: `shared/knowledge-core.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `hashLine`、`blockIndexText`、`blockTagBoost`
- Produces:
  - `gramTokens(text: string): Generator<string>` —— 与 `kernel/graph.mjs:20-58` 逐字相同
  - `vectorizeRaw(text, opts?: { tagBoost?: number, idf?: Map<string, number>|null }): { raw: [string, number][], norm: number }`
  - `vectorizeText(text, opts?): [string, number][]` —— 归一化后再乘 tagBoost（保持既有非单位范数语义）
  - `cosine(a: [string,number][], b: [string,number][]): number`
  - `buildIdf(docs: { gramCounts: Map<string, number> }[]): Map<string, number>`
  - `keywordScore(entry: { tag?, summary?, full?, theme? }, keywords: string[]): number`
  - `countGrams(text: string): Map<string, number>`
  - `W_VECTOR = 0.60`、`W_KEYWORD = 0.25`、`W_STRUCT = 0.15`、`GRAPH_DECAY = 0.9`
  - `structBoostOf({ block, doc, query, keywords }): number`
  - `fuseScore({ cos, kw, struct, graph }): number`
  - `makeSnippet(text: string, opts?: { maxLen?: number }): string`

- [ ] **Step 1: 写失败测试**

在 `shared/knowledge-core.test.mjs` 末尾追加：

```js
import {
  gramTokens, vectorizeText, vectorizeRaw, cosine, buildIdf, countGrams,
  keywordScore, structBoostOf, fuseScore, makeSnippet, blockIndexText, blockTagBoost,
  W_VECTOR, W_KEYWORD, W_STRUCT, GRAPH_DECAY,
} from './knowledge-core.mjs'

test('gramTokens 中文 bigram + 英文小写词（钉住既有分词语义）', () => {
  assert.deepEqual([...gramTokens('rd表')], ['rd', '表'])
  // 中文段内部滑动 bigram；空白/标点作分隔不参与
  assert.deepEqual([...gramTokens('知识库')], ['知识', '识库'])
  assert.deepEqual([...gramTokens('PS 表')], ['ps', '表'])
})

test('vectorizeRaw 给出归一化前的范数', () => {
  const { raw, norm } = vectorizeRaw('知识库 知识库')
  assert.ok(raw.length > 0)
  assert.ok(norm > 0)
  const manual = Math.sqrt(raw.reduce((s, [, w]) => s + w * w, 0))
  assert.ok(Math.abs(manual - norm) < 1e-9)
})

test('vectorizeText 归一化后乘 tagBoost（既有语义：结果非单位范数）', () => {
  const a = vectorizeText('知识库', { tagBoost: 1 })
  const b = vectorizeText('知识库', { tagBoost: 3 })
  assert.equal(a.length, b.length)
  for (const [g, wa] of a) {
    const wb = new Map(b).get(g)
    assert.ok(Math.abs(wb - wa * 3) < 1e-9, 'tagBoost 应在归一化之后整体放大')
  }
})

test('vectorizeText 对空串返回空数组（不产生 NaN）', () => {
  assert.deepEqual(vectorizeText(''), [])
  assert.deepEqual(vectorizeText('   '), [])
})

test('cosine 对相同文本为 1、无关文本接近 0', () => {
  const v = vectorizeText('知识库检索')
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9)
  const u = vectorizeText('完全不同的内容 xyz')
  assert.ok(cosine(v, u) < 0.2)
})

test('buildIdf 高频 gram 的 idf 低于低频 gram', () => {
  const docs = [countGrams('知识库'), countGrams('知识库'), countGrams('罕见词条目')]
    .map((gramCounts) => ({ gramCounts }))
  const idf = buildIdf(docs)
  assert.ok(idf.get('知识') < idf.get('罕'))
})

test('keywordScore 标签命中(3) > 主题(2) = 摘要(2) > 全文(1)', () => {
  const e = { tag: 'PS材料', theme: 'workflow', summary: 'PS材料整理', full: 'PS材料整理的做法' }
  assert.equal(keywordScore(e, ['ps材料']), 3 + 2 + 2 + 1)
  assert.equal(keywordScore(e, ['流程']), 0)     // 关键词须 ≥2 字符且需命中
  assert.equal(keywordScore(e, ['x']), 0)        // 单字符关键词被过滤
})

test('structBoostOf：标题全等查询最重，heading 有底价，条目次之', () => {
  const doc = { title: 'workflow.md', tags: ['企微CLI化'] }
  assert.equal(structBoostOf({ block: { kind: 'para' }, doc, query: 'workflow.md' }), 1)
  assert.equal(structBoostOf({ block: { kind: 'para' }, doc, query: '无', keywords: ['企微CLI化'] }), 0.67)
  assert.equal(structBoostOf({ block: { kind: 'heading' }, doc, query: '无' }), 0.5)
  assert.equal(structBoostOf({ block: { kind: 'entry' }, doc, query: '无' }), 0.4)
  assert.equal(structBoostOf({ block: { kind: 'para' }, doc, query: '无' }), 0)
})

test('fuseScore 三路权重正确，图扩展打 0.9 折扣', () => {
  const s = fuseScore({ cos: 1, kw: 8, struct: 1 })
  assert.ok(Math.abs(s - (W_VECTOR * 1 + W_KEYWORD * 1 + W_STRUCT * 1)) < 1e-9)
  assert.ok(Math.abs(fuseScore({ cos: 1, kw: 8, struct: 1, graph: true }) - s * GRAPH_DECAY) < 1e-9)
  // kw 超过 8 分被截到 1（防标签多次命中把分数推爆）
  assert.equal(fuseScore({ kw: 80 }), fuseScore({ kw: 8 }))
})

test('makeSnippet 压平空白并按上限截断加省略号', () => {
  assert.equal(makeSnippet('  a\n\n b  '), 'a b')
  const long = makeSnippet('x'.repeat(200), { maxLen: 10 })
  assert.equal(long.length, 10)
  assert.ok(long.endsWith('…'))
})

test('blockIndexText 只对经验条目加标签前缀；blockTagBoost 只给它 3 倍', () => {
  const entry = { kind: 'entry', text: '摘要', entryTag: '企微CLI化' }
  assert.equal(blockIndexText(entry), '企微CLI化 摘要')
  assert.equal(blockTagBoost(entry), 3)
  const para = { kind: 'para', text: '正文', entryTag: 'x' }
  assert.equal(blockIndexText(para), '正文')
  assert.equal(blockTagBoost(para), 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test shared/knowledge-core.test.mjs`
Expected: FAIL —— `SyntaxError: The requested module './knowledge-core.mjs' does not provide an export named 'gramTokens'`

- [ ] **Step 3: 追加实现到 `shared/knowledge-core.mjs`**

```js
// ── 分词与向量（迁移自 kernel/graph.mjs:20-88，行为逐字保持）────────────────
// 切分：中文段字符 bigram + 英文/数字段单词小写。
// 段边界语义（graph.mjs 的既有测试断言依赖，迁移时不可改）：
//   - word 段 -> 整体小写；cjk 段 -> 内部滑动 bigram
//   - cjk->word 边界 -> 末 cjk 字 + 首词字（小写）组成的跨界 bigram
//   - word->末段 cjk 边界 -> 整体小写词 + 首 cjk 字（避免孤立尾字丢失）
const CJK = /[\u4e00-\u9fff]/
const WORD = /[A-Za-z0-9]/

export function* gramTokens(text) {
  const s = String(text ?? '').trim()
  const runs = []
  let cur = ''
  let curType = null
  const flush = (type) => {
    if (cur) runs.push({ type: curType, text: cur })
    cur = ''
    curType = type
  }
  for (const ch of s) {
    const t = CJK.test(ch) ? 'cjk' : WORD.test(ch) ? 'word' : null
    if (t === null) { flush(null); continue }
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
        yield r.text.toLowerCase() + [...next.text][0]
      }
    } else {
      const chars = [...r.text]
      for (let j = 0; j + 1 < chars.length; j++) yield chars[j] + chars[j + 1]
      if (next && next.type === 'word') {
        yield chars[chars.length - 1] + next.text[0].toLowerCase()
      }
    }
  }
}

export function countGrams(text) {
  const tf = new Map()
  for (const g of gramTokens(text)) tf.set(g, (tf.get(g) || 0) + 1)
  return tf
}

// 归一化前的原始向量 + 范数（索引构建需要把"未归一化权重"落进 postings，
// 查询时 dot 出来才是真余弦）。
export function vectorizeRaw(text, { tagBoost = 1, idf = null } = {}) {
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
  const { raw, norm } = vectorizeRaw(text, { tagBoost, idf })
  const boost = tagBoost || 1
  // tagBoost 在归一化之后乘（graph.mjs 的既有测试断言依赖此顺序，勿改）
  return norm > 0 ? raw.map(([id, w]) => [id, (w / norm) * boost]) : []
}

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
  for (const [gram, count] of df) idf.set(gram, Math.log((N + 1) / (count + 1)) + 1)
  return idf
}

// 关键词精确分（迁移自 kernel/memory.mjs:110，权重不变）
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
export const W_VECTOR = 0.60
export const W_KEYWORD = 0.25
export const W_STRUCT = 0.15
export const GRAPH_DECAY = 0.9

// 结构加权：文档标题被命中是最强信号（1.0），标签次之（0.67），heading 有底价（0.5），
// 条目块 0.4（本就是高信息密度单元），普通段落 0。
export function structBoostOf({ block = null, doc = null, query = '', keywords = [] } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter((k) => k.length >= 2)
  let s = 0
  const title = String(doc?.title || '').toLowerCase()
  if (title && q && title.includes(q)) s = 1
  const tags = (doc?.tags || []).map((t) => String(t).toLowerCase())
  if (tags.length && kws.length && tags.some((t) => kws.some((k) => t.includes(k) || k.includes(t)))) {
    s = Math.max(s, 0.67)
  }
  if (block?.kind === 'heading') s = Math.max(s, 0.5)
  if (block?.kind === 'entry') s = Math.max(s, 0.4)
  return s
}

export function fuseScore({ cos = 0, kw = 0, struct = 0, graph = false } = {}) {
  const base = W_VECTOR * cos + W_KEYWORD * Math.min(kw / 8, 1) + W_STRUCT * struct
  return graph ? base * GRAPH_DECAY : base
}

export function makeSnippet(text, { maxLen = 160 } = {}) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= maxLen) return s
  return s.slice(0, Math.max(1, maxLen - 1)) + '…'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test shared/knowledge-core.test.mjs`
Expected: PASS —— `# pass 19`

- [ ] **Step 5: 提交**

```bash
git add shared/knowledge-core.mjs shared/knowledge-core.test.mjs
git commit -m "feat(knowledge): shared 向量与打分——gram/IDF/余弦/结构加权/融合评分"
```

---

### Task 3: shared 标识 / 链接 / 序列化 / 内置空间

**Files:**
- Modify: `shared/knowledge-core.mjs`（追加导出）
- Test: `shared/knowledge-core.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1-2 的全部导出
- Produces:
  - `toDocId(spaceId: string, relPath: string): string` —— 反斜杠一律归一为正斜杠
  - `docIdToParts(docId: string): { spaceId: string, relPath: string }`
  - `toBlockId(docId: string, n: number): string` —— `` `${docId}#${n}` ``
  - `extractLinks(text: string): { to: string, anchor: string }[]`
  - `resolveLinkTarget(opts: { fromRel?, to?, spaceId?, docIds?: Set<string>|null }): string|null`
  - `serializeIndex(index: { docs?, inverted?, links?, tags? }): { docs: string, inverted: string, links: string, tags: string }`
  - `parseJsonl(text: string): unknown[]` —— 半截行静默跳过
  - `builtinSpaceSpecs(configDir: string): { id, name, description, root, writable, source }[]`

- [ ] **Step 1: 写失败测试**

在 `shared/knowledge-core.test.mjs` 末尾追加：

```js
import {
  toDocId, docIdToParts, toBlockId, extractLinks, resolveLinkTarget,
  serializeIndex, parseJsonl, builtinSpaceSpecs,
} from './knowledge-core.mjs'
import { join } from 'node:path'

test('toDocId 反斜杠归一为正斜杠（跨平台稳定 ID）', () => {
  assert.equal(toDocId('experience', 'workflow.md'), 'experience/workflow.md')
  assert.equal(toDocId('experience', 'a\\b\\c.md'), 'experience/a/b/c.md')
})

test('docIdToParts 与 toDocId 互逆（含空间 id 内无斜杠的约定）', () => {
  assert.deepEqual(docIdToParts('my-notes/a/b.md'), { spaceId: 'my-notes', relPath: 'a/b.md' })
})

test('toBlockId 拼接', () => {
  assert.equal(toBlockId('experience/workflow.md', 3), 'experience/workflow.md#3')
})

test('extractLinks 取 wiki 链接与相对 md 链接，忽略外链与纯锚点', () => {
  const md = [
    '见 [[code-style]] 与 [[workflow|工作流]]。',
    '也见 [说明](./docs/policy.md) 与外链 [站点](https://example.com) 与 [锚](#sec)。',
  ].join('\n')
  const links = extractLinks(md)
  const tos = links.map((l) => l.to)
  assert.ok(tos.includes('code-style'))
  assert.ok(tos.includes('workflow'))
  assert.ok(tos.includes('./docs/policy.md'))
  assert.ok(!tos.some((t) => t.startsWith('http')))
  assert.ok(!tos.some((t) => t.startsWith('#')))
  assert.equal(links.find((l) => l.to === 'workflow').anchor, '工作流')
})

test('extractLinks 去重（同一目标只出现一次）', () => {
  const links = extractLinks('[[a]] 和 [[a]]')
  assert.equal(links.length, 1)
})

test('resolveLinkTarget 相对当前文档目录解析并补 .md 后缀', () => {
  const docIds = new Set(['notes/sub/policy.md', 'notes/root.md'])
  assert.equal(
    resolveLinkTarget({ fromRel: 'sub/note.md', to: './policy.md', spaceId: 'notes', docIds }),
    'notes/sub/policy.md',
  )
  assert.equal(
    resolveLinkTarget({ fromRel: 'sub/note.md', to: 'root', spaceId: 'notes', docIds }),
    'notes/root.md',
  )
})

test('resolveLinkTarget 对断链/外链返回 null', () => {
  const docIds = new Set(['notes/a.md'])
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: '不存在', spaceId: 'notes', docIds }), null)
  assert.equal(resolveLinkTarget({ fromRel: 'a.md', to: 'https://x.com', spaceId: 'notes', docIds }), null)
})

test('serializeIndex 产出 JSONL 行数与 parseJsonl 往返一致', () => {
  const s = serializeIndex({
    docs: [{ i: 0, id: 'a/x.md' }, { i: 1, id: 'a/y.md' }],
    inverted: [{ g: 'deadbeef', df: 2, p: [[0, 0.5], [1, 0.25]] }],
    links: [{ from: 'a/x.md', to: 'a/y.md' }],
    tags: { 标签: ['a/x.md'] },
  })
  assert.equal(parseJsonl(s.docs).length, 2)
  assert.equal(parseJsonl(s.inverted).length, 1)
  assert.equal(parseJsonl(s.links).length, 1)
  assert.deepEqual(JSON.parse(s.tags), { 标签: ['a/x.md'] })
})

test('serializeIndex 空输入产出空串（不产出半截行）', () => {
  const s = serializeIndex({})
  assert.equal(s.docs, '')
  assert.equal(s.inverted, '')
  assert.equal(s.links, '')
  assert.equal(s.tags, '{}')
})

test('parseJsonl 跳过半截行与空行', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n{"bad"\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }])
})

test('builtinSpaceSpecs 给出三个内置空间，root 挂在 configDir 下', () => {
  const specs = builtinSpaceSpecs('/tmp/home')
  assert.deepEqual(specs.map((s) => s.id), ['experience', 'session-memory', 'skill-experience'])
  const exp = specs[0]
  assert.equal(exp.root, join('/tmp/home', 'memory', 'personal'))
  assert.equal(exp.writable, true)
  assert.equal(exp.source, 'experience')
  assert.equal(specs[2].root, join('/tmp/home', 'memory', 'skill_experiences'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test shared/knowledge-core.test.mjs`
Expected: FAIL —— `does not provide an export named 'toDocId'`

- [ ] **Step 3: 追加实现到 `shared/knowledge-core.mjs`**

```js
import { join } from 'node:path' // 本模块唯一的 node 依赖（纯字符串，无副作用）

// ── 标识 ──────────────────────────────────────────────────────────────────
export function toDocId(spaceId, relPath) {
  const rel = String(relPath ?? '').split(/[\\/]+/).filter(Boolean).join('/')
  return `${String(spaceId ?? '')}/${rel}`
}

export function docIdToParts(docId) {
  const s = String(docId ?? '')
  const i = s.indexOf('/')
  return i < 0 ? { spaceId: s, relPath: '' } : { spaceId: s.slice(0, i), relPath: s.slice(i + 1) }
}

export function toBlockId(docId, n) {
  return `${docId}#${n}`
}

// ── 链接 ──────────────────────────────────────────────────────────────────
// 只认两类站内引用：[[wiki]] 与相对路径 md 链接。外链（含协议）与纯锚点不算边。
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

// 把原始链接目标解析成**同空间**的 docId；解析不到（断链）返回 null。
// 候选顺序：原样 → 加 .md → 相对当前文档目录 → 相对目录加 .md。
export function resolveLinkTarget({ fromRel = '', to = '', spaceId = '', docIds = null } = {}) {
  const raw = String(to ?? '').trim().replace(/^\.\//, '')
  if (!raw || /^[a-z]+:\/\//i.test(raw) || raw.startsWith('#')) return null
  const dir = String(fromRel ?? '').split(/[\\/]+/).filter(Boolean).slice(0, -1).join('/')
  const cands = []
  const add = (s) => { const t = s.replace(/\\/g, '/'); if (t && !cands.includes(t)) cands.push(t) }
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

// ── 索引序列化 ────────────────────────────────────────────────────────────
// 三份 JSONL 共用同一批次写入（同一原子替换）：docs.jsonl 的行序**就是** docIdx 的定义，
// 与 inverted.jsonl 的 postings 下标强耦合，二者绝不可分批写。
export function serializeIndex({ docs = [], inverted = [], links = [], tags = {} } = {}) {
  const jsonl = (arr) => (arr.length ? arr.map((x) => JSON.stringify(x)).join('\n') + '\n' : '')
  return {
    docs: jsonl(docs),
    inverted: jsonl(inverted),
    links: jsonl(links),
    tags: JSON.stringify(tags),
  }
}

export function parseJsonl(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 半截行/损坏行跳过：索引是派生物，容错即降级 */ }
  }
  return out
}

// ── 内置空间 ──────────────────────────────────────────────────────────────
// root 一律外挂既有目录（**物理不动**）：经验文件留在 ~/.yfw/memory/personal，
// 知识库只是把它注册成一个空间。迁移（spec §12）是后续独立任务，届时只改这里。
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test shared/knowledge-core.test.mjs`
Expected: PASS —— `# pass 31`

- [ ] **Step 5: 提交**

```bash
git add shared/knowledge-core.mjs shared/knowledge-core.test.mjs
git commit -m "feat(knowledge): shared 标识/链接解析/索引序列化/内置空间规格"
```

---

### Task 4: 消除既有重复实现（graph.mjs / memory.mjs 接 shared）

> **为什么必须先做**：`gramTokens`/`vectorizeText`/`cosine`/`buildIdf`/`hashLine`/`keywordScore`
> 现有两份实现（`kernel/graph.mjs`、`kernel/memory.mjs`，另 `server/experience.mjs` 有第三份
> `hashLine`）。而 `graph.mjs` 的纯函数**当前没有任何测试覆盖**（`grep -rln "gramTokens"
> kernel-tests/` 为空）。故本任务必须先补**特征测试**钉住现状，再迁移。

**Files:**
- Create: `kernel-tests/knowledge-core-parity.test.mjs`
- Modify: `kernel/graph.mjs:1-10`（import 与 re-export）、删除 `:20-88` 的本地定义
- Modify: `kernel/memory.mjs:1-8`（import 与 re-export）、删除 `:13-58` 与 `:110-129` 的本地定义

**Interfaces:**
- Consumes: `shared/knowledge-core.mjs` 全部导出
- Produces:
  - `kernel/graph.mjs` 的既有导出**全部不变**（`hashLine`、`gramTokens`、`vectorizeText`、`cosine`、`buildIdf`、`createGraphStore`、`rebuildGraph`）——改为 re-export 后调用方零改动
  - `kernel/memory.mjs` 的既有导出全部不变（追加 `parseEntryLine`、`keywordScore` 的 re-export）
  - `createGraphStore` 的 `search()` 输出字符串**逐字节不变**

- [ ] **Step 1: 写特征测试（钉住迁移前行为）**

创建 `kernel-tests/knowledge-core-parity.test.mjs`：

```js
// 特征测试（characterization test）：在把 gramTokens/vectorizeText/cosine/buildIdf/
// hashLine/keywordScore 迁移到 shared/ 之前，先把**现状行为**钉死。
// 迁移是纯搬家（实现逐字复制），这些断言在迁移前后必须完全一致——若迁移后变红，
// 说明搬错了，必须修实现而不是改断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gramTokens, vectorizeText, cosine, buildIdf, createGraphStore } from '../kernel/graph.mjs'
import { hashLine, keywordScore, parseEntryLine } from '../kernel/memory.mjs'

test('gramTokens 迁移前语义（graph.mjs 重构路径注释所依赖的断言）', () => {
  // graph.mjs:26 注释记录了该用例：'ps 表与 rd 表' 类的边界 bigram
  assert.deepEqual([...gramTokens('ps 表与 rd 表')], ['ps', '表与', '与r', 'rd', 'rd表'])
})

test('vectorizeText 的 tagBoost 在归一化之后生效', () => {
  // graph.mjs:60 注释断言：w2[知识] > w1[知识]
  const w1 = new Map(vectorizeText('知识 检索'))
  const w2 = new Map(vectorizeText('知识 检索', { tagBoost: 3 }))
  assert.ok(w2.get(hashLine('知识')) > w1.get(hashLine('知识')))
})

test('cosine / buildIdf 基础契约', () => {
  const v = vectorizeText('知识库检索')
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9)
  const idf = buildIdf([
    { gramCounts: new Map([['a', 1], ['b', 1]]) },
    { gramCounts: new Map([['a', 1]]) },
  ])
  assert.ok(idf.get('a') < idf.get('b'), 'df 高的 idf 低')
})

test('hashLine / keywordScore / parseEntryLine 迁移前语义', () => {
  assert.match(hashLine('- [会话|X] 摘要 -- 全文'), /^[0-9a-f]{8}$/)
  assert.equal(keywordScore({ tag: 'PS材料' }, ['ps材料']), 3)
  assert.deepEqual(parseEntryLine('- [会话|标签] 摘要 -- 全文'), {
    tag: '标签', summary: '摘要', full: '全文',
  })
})

test('createGraphStore.search 输出形状与排序（端到端特征）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kc-parity-'))
  const memoryRoot = join(dir, 'memory', 'personal')
  mkdirSync(memoryRoot, { recursive: true })
  writeFileSync(join(memoryRoot, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流', '---',
    '- [会话|PS材料] PS材料整理 -- 先合并再压缩，注意尺寸上限',
    '- [会话|成果转化] 成果转化材料 -- 四表联动核对步骤',
  ].join('\n') + '\n', 'utf-8')

  try {
    const g = createGraphStore({ root: join(dir, 'memory', 'graph') })
    await g.load({ memoryRoot, force: true })
    assert.equal(g.getNodes().length, 2)
    const out = g.search({ query: 'PS材料 压缩', keywords: ['PS材料'], topK: 5 })
    assert.ok(out.includes('【相关经验抽调】'), '表头不变')
    assert.ok(out.includes('PS材料整理'), '命中相关条目')
    assert.ok(out.indexOf('PS材料整理') < out.indexOf('成果转化材料'), '相关度降序')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: 运行测试确认通过（迁移前基线必须绿）**

Run: `node --test kernel-tests/knowledge-core-parity.test.mjs`
Expected: PASS —— `# pass 5`

- [ ] **Step 3: 改 `kernel/graph.mjs`**

把文件头部 `:1-10` 与本地定义 `:20-88` 改为：

```js
// kernel/graph.mjs —— 内核神经图谱（无模型特征向量 + 图谱存储 + 检索）
// ---------------------------------------------------------------------------
// 分词 / 向量 / 余弦 / IDF / 行指纹 的**权威实现已迁到 shared/knowledge-core.mjs**
// （2026-09-13 知识内核 S1 Task 4）。本模块只保留图谱存储与检索编排，
// 纯函数按原签名 re-export，既有调用方（kernel/cli.mjs、kernel/memory-search.mjs、
// kernel/memory.mjs、kernel-tests/*）零改动。
//
// 保留：IGraphBackend 接口预留（设计文档 §7）——search/write/health。
// 配置位 PONOS_GRAPH_BACKEND=local|external（env 优先），本次仅实现 local。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, appendFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { readMemoryEntries } from './memory.mjs'
import {
  hashLine, gramTokens, vectorizeText, cosine, buildIdf, keywordScore,
} from '../shared/knowledge-core.mjs'

// 原签名 re-export：既有导入点不受影响
export { hashLine, gramTokens, vectorizeText, cosine, buildIdf }

const GRAPH_FILE = 'graph.jsonl'
const GRAPH_VERSION = 1
```

随后**删除**原来的 `CJK`/`WORD` 常量、`gramTokens`、`vectorizeText`、`cosine`、`buildIdf` 定义，
以及文件顶部的 `import { hashLine, keywordScore, readMemoryEntries } from './memory.mjs'` 与
`export { hashLine }`（已被上面替代）。文件其余部分（`nodeLine`/`entryToNode`/`createGraphStore`/
`rebuildGraph`）**一字不改**——它们只用已导入的这些函数。

- [ ] **Step 4: 改 `kernel/memory.mjs`**

把头部改为：

```js
// kernel/memory.mjs —— 跨会话记忆内核化（L3-1/L3-2）
// 与 GUI 层 server/experience.mjs 同一数据源/格式/去重算法：
//   <configDir>/memory/personal/{theme}.md，条目 `- [会话|标签] 摘要 -- 全文`
// hashLine / parseEntryLine / keywordScore 的权威实现在 shared/knowledge-core.mjs
// （2026-09-13 S1 Task 4 去重），本模块 re-export 保持既有导入点可用。
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hashLine, parseEntryLine, keywordScore } from '../shared/knowledge-core.mjs'

export { hashLine, parseEntryLine, keywordScore }
```

随后**删除**本地的 `hashLine`、`parseEntryLine`、`keywordScore` 三个函数定义。其余
（`parseFrontmatter`、`themePath`、`readTheme`、`readMemoryEntries`、`appendMemoryEntry`、
`buildMemoryIndex`、`buildRelevantMemory`、`captureMemoryCandidates`、`inferTheme`）不动。

> 注：`kernel/memory.mjs` 保留自己的 `parseFrontmatter`（返回形状与 shared 版不同——它不要
> `bodyStartLine`），这是**有意的**：改它会牵动 `readTheme`，而 shared 版多一个字段对本模块无益。
> 两处的解析语义一致（同一正则），不是重复实现。

- [ ] **Step 5: 运行特征测试 + 全量回归确认通过**

Run: `node --test kernel-tests/knowledge-core-parity.test.mjs`
Expected: PASS —— `# pass 5`（迁移前后完全一致）

Run: `npm test`
Expected: 全绿（基线 `npm test` 应与改动前**用例数与结果一致**）

- [ ] **Step 6: 提交**

```bash
git add kernel/graph.mjs kernel/memory.mjs kernel-tests/knowledge-core-parity.test.mjs
git commit -m "refactor(knowledge): 纯函数收敛到 shared——graph/memory 改 re-export 去重"
```

---

### Task 5: 内核空间发现与文档解析

**Files:**
- Create: `kernel/knowledge.mjs`
- Test: `kernel-tests/knowledge.test.mjs`

**Interfaces:**
- Consumes: `shared/knowledge-core.mjs` 全部导出
- Produces:
  - `knowledgeRoot(configDir: string): string` —— `<configDir>/knowledge`
  - `discoverSpaces({ configDir, root? }): Space[]`，`Space = { id, name, description, root, writable, source, packVersion? }`
  - `walkMd(root: string, opts?: { maxFiles?: number }): { absPath: string, relPath: string }[]`
  - `parseDocFile({ absPath, space, relPath }): { doc: Doc, links: Link[] }`
  - `Doc = { id, spaceId, rel, title, tags: string[], hash, mtime, size, lines, blocks: DocBlock[] }`
  - `DocBlock = { n, kind, level, text, line, tag: string|null, full: string|null }`
  - `Link = { from: string, to: string }`

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/knowledge.test.mjs`：

```js
// kernel/knowledge.mjs 测试：空间发现 / 文档解析 / 索引构建 / 检索 / 增量更新。
// 隔离纪律：全部走 mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeRoot, discoverSpaces, walkMd, parseDocFile } from '../kernel/knowledge.mjs'

/** 造一个隔离的 configDir：含 personal 经验目录 + 一个用户空间 + 一个只读包 */
export function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kn-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流心得', '---',
    '## 企微CLI化',
    '',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
    '- [会话|应用智控] 步骤字段契约 -- js 需 expression、click 类需 ref',
  ].join('\n') + '\n', 'utf-8')

  const notes = join(dir, 'knowledge', 'spaces', 'my-notes')
  mkdirSync(notes, { recursive: true })
  writeFileSync(join(notes, '.space.json'), JSON.stringify({ name: '我的笔记', description: '手写笔记' }), 'utf-8')
  writeFileSync(join(notes, 'a.md'), '# 甲文档\n\n见 [[b]]。\n\n正文内容。\n', 'utf-8')
  writeFileSync(join(notes, 'b.md'), '# 乙文档\n\n乙的正文。\n', 'utf-8')

  const pack = join(dir, 'knowledge', 'packs', 'demo-pack')
  mkdirSync(join(pack, 'docs'), { recursive: true })
  writeFileSync(join(pack, 'pack.json'), JSON.stringify({
    id: 'demo-pack', name: '演示知识包', version: '1.0.0', license: 'CC-BY-4.0', source: 'docs',
  }), 'utf-8')
  writeFileSync(join(pack, 'docs', 'p.md'), '# 包内文档\n\n包内容。\n', 'utf-8')
  return { dir, personal, notes, pack }
}

test('discoverSpaces：内置 + 用户空间 + 只读包，目录不存在则跳过', () => {
  const { dir } = makeFixture()
  try {
    const spaces = discoverSpaces({ configDir: dir })
    const byId = Object.fromEntries(spaces.map((s) => [s.id, s]))
    assert.ok(byId['experience'], '内置经验空间')
    assert.equal(byId['my-notes'].name, '我的笔记')
    assert.equal(byId['my-notes'].writable, true)
    assert.equal(byId['pack-demo-pack'].writable, false, '知识包只读')
    assert.equal(byId['pack-demo-pack'].packVersion, '1.0.0')
    assert.ok(!byId['session-memory'], 'session 目录不存在 → 不挂载')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('walkMd 递归找 md、归一正斜杠 rel、跳过隐藏目录与符号链接', () => {
  const { notes } = makeFixture()
  const files = walkMd(notes)
  assert.deepEqual(files.map((f) => f.relPath).sort(), ['a.md', 'b.md'])
})

test('parseDocFile：title 取 frontmatter.title→name→首个 heading→文件名；tags 含文件名主题与条目标签', () => {
  const { dir, personal } = makeFixture()
  try {
    const space = discoverSpaces({ configDir: dir }).find((s) => s.id === 'experience')
    const { doc, links } = parseDocFile({ absPath: join(personal, 'workflow.md'), space, relPath: 'workflow.md' })
    assert.equal(doc.id, 'experience/workflow.md')
    assert.equal(doc.title, 'workflow')
    assert.ok(doc.tags.includes('workflow'), '含文件名主题')
    assert.ok(doc.tags.includes('企微CLI化'), '含条目标签')
    assert.equal(doc.blocks.filter((b) => b.kind === 'entry').length, 2)
    assert.equal(doc.blocks.find((b) => b.kind === 'entry').tag, '企微CLI化')
    assert.equal(doc.blocks.find((b) => b.kind === 'entry').full, '涉及真实沟通渠道的测试一律只发文件传输助手')
    assert.ok(doc.lineCount ?? doc.lines > 0)
    assert.deepEqual(links, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseDocFile 抽取链接边（from=docId）', () => {
  const { dir, notes } = makeFixture()
  try {
    const space = discoverSpaces({ configDir: dir }).find((s) => s.id === 'my-notes')
    const { links } = parseDocFile({ absPath: join(notes, 'a.md'), space, relPath: 'a.md' })
    assert.deepEqual(links, [{ from: 'my-notes/a.md', to: 'b' }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/knowledge.mjs'`

- [ ] **Step 3: 创建 `kernel/knowledge.mjs`（本任务只写空间发现与解析部分）**

```js
// kernel/knowledge.mjs —— 知识内核（S1）：空间发现 / 文档解析 / 索引 / 检索
// ---------------------------------------------------------------------------
// 权威实现（server 侧一律经 --knowledge <op> 子命令转发，不在 server 复制逻辑）。
// 数据模型与设计见 docs/superpowers/specs/2026-09-13-knowledge-core-design.md。
// 纯函数在 shared/knowledge-core.mjs（repo 根 shared/ 经一级 ../ 逃逸共享）。
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync,
} from 'node:fs'
import { join, relative, sep, basename } from 'node:path'
import {
  INDEX_VERSION, builtinSpaceSpecs, parseFrontmatter, splitBlocks, extractLinks,
  toDocId, hashLine,
} from '../shared/knowledge-core.mjs'

/** 空间根：<configDir>/knowledge（configDir 由调用方给，本模块不自解析 home） */
export function knowledgeRoot(configDir) {
  return join(configDir || '', 'knowledge')
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.index', '.obsidian'])

/** 递归收集 md。不跟符号链接（穿越防护第一道），跳过依赖/隐藏目录。 */
export function walkMd(root, { maxFiles = 5000 } = {}) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        stack.push(join(dir, e.name))
        continue
      }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue
      const abs = join(dir, e.name)
      out.push({ absPath: abs, relPath: relative(root, abs).split(sep).join('/') })
    }
  }
  return out
}

function readJsonFile(fp) {
  try { return JSON.parse(readFileSync(fp, 'utf-8')) } catch { return {} }
}

/**
 * 空间发现。顺序 = 内置（目录存在才挂）→ 用户空间 → 知识包（只读）。
 * 目录缺失一律静默跳过——"没有"不是错误。
 */
export function discoverSpaces({ configDir, root = null } = {}) {
  const kroot = root || knowledgeRoot(configDir)
  const out = []
  for (const s of builtinSpaceSpecs(configDir)) {
    if (existsSync(s.root)) out.push(s)
  }

  const spacesDir = join(kroot, 'spaces')
  if (existsSync(spacesDir)) {
    for (const name of readdirSync(spacesDir)) {
      const dir = join(spacesDir, name)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const meta = readJsonFile(join(dir, '.space.json'))
      out.push({
        id: name, name: meta.name || name, description: meta.description || '',
        root: dir, writable: true, source: 'user',
      })
    }
  }

  const packsDir = join(kroot, 'packs')
  if (existsSync(packsDir)) {
    for (const name of readdirSync(packsDir)) {
      const dir = join(packsDir, name)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const meta = readJsonFile(join(dir, 'pack.json'))
      const base = meta.source ? join(dir, String(meta.source).split('/').join(sep)) : dir
      if (!existsSync(base)) continue
      out.push({
        id: `pack-${name}`, name: meta.name || name, description: meta.description || '',
        root: base, writable: false, source: 'pack', packVersion: meta.version || null,
      })
    }
  }
  return out
}

function collectTags(front, space, relPath, blocks) {
  const tags = []
  if (front.tags) tags.push(...String(front.tags).split(/[,\s]+/).filter(Boolean))
  if (space.source === 'experience' || space.source === 'memory') {
    tags.push(basename(relPath).replace(/\.md$/i, ''))
  }
  for (const b of blocks) if (b.kind === 'entry' && b.entryTag) tags.push(b.entryTag)
  return [...new Set(tags)]
}

/** 解析单个 md → { doc, links }。抛错由调用方兜住（单文档故障不影响整库）。 */
export function parseDocFile({ absPath, space, relPath }) {
  const raw = readFileSync(absPath, 'utf-8')
  const { front, body, bodyStartLine } = parseFrontmatter(raw)
  const blocks = splitBlocks(body, { startLine: bodyStartLine })
  const docId = toDocId(space.id, relPath)
  const heading = blocks.find((b) => b.kind === 'heading')
  // 标题优先级：frontmatter.title → frontmatter.name → 首个 heading → 文件名。
  // name 必须排在 heading 之前：经验主题文件（如 workflow.md）带 `name: workflow`，
  // 若让首个 `## 小节` 抢先，主题名会被错认成小节名，检索排序与展示都会跟着错。
  const title = front.title || front.name || (heading && heading.text) || basename(relPath).replace(/\.md$/i, '')
  const st = statSync(absPath)
  const doc = {
    id: docId, spaceId: space.id, rel: relPath, title,
    tags: collectTags(front, space, relPath, blocks),
    hash: hashLine(raw), mtime: st.mtimeMs, size: st.size,
    lines: raw.split(/\r?\n/).length,
    blocks: blocks.map((b) => ({
      n: b.n, kind: b.kind, level: b.level, text: b.text, line: b.line,
      tag: b.entryTag || null, full: b.entryFull || null,
    })),
  }
  const links = extractLinks(raw).map((l) => ({ from: docId, to: l.to }))
  return { doc, links }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: PASS —— `# pass 4`

- [ ] **Step 5: 提交**

```bash
git add kernel/knowledge.mjs kernel-tests/knowledge.test.mjs
git commit -m "feat(knowledge): 内核空间发现与文档解析（含符号链接穿越防护）"
```

---

### Task 6: 索引构建与加载（全量 + 原子写）

**Files:**
- Modify: `kernel/knowledge.mjs`（追加）
- Test: `kernel-tests/knowledge.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 5 的 `discoverSpaces`/`walkMd`/`parseDocFile`；`shared` 的 `countGrams`/`buildIdf`/`vectorizeText`/`blockIndexText`/`blockTagBoost`/`serializeIndex`/`parseJsonl`/`resolveLinkTarget`
- Produces:
  - `createKnowledgeStore({ configDir, root? }): KnowledgeStore`
  - `KnowledgeStore.load({ force? }): Promise<void>`
  - `KnowledgeStore.getSpaces(): Space[]`（含 `docCount`）
  - `KnowledgeStore.stats(): { docs, blocks, grams, spaces, builtAt, indexAgeMs, indexBytes }`

**索引文件契约**（`.index/`）：

| 文件 | 行形状 |
|---|---|
| `manifest.json` | `{ version, builtAt, docs, blocks, spaces: { [id]: { docs } }, files: { [docId]: { size, mtime, hash } } }` |
| `docs.jsonl` | `{ i, id, spaceId, rel, title, tags, hash, mtime, size, lines, blocks: [{ n, kind, level, text, line, tag, full }] }` |
| `inverted.jsonl` | `{ g, df, p: [[docIdx, w], ...] }`（`w` 四舍五入到 4 位小数） |
| `links.jsonl` | `{ from, to, target }`（`target` = 解析到的同空间 docId，断链为 `null`） |
| `tags.json` | `{ [tag]: docId[] }` |

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/knowledge.test.mjs` 末尾追加：

```js
import { createKnowledgeStore, knowledgeRoot as kroot } from '../kernel/knowledge.mjs'
import { readFileSync as rf, existsSync as ex } from 'node:fs'

test('load(force) 全量构建索引：三份 JSONL + manifest 落盘，字段齐备', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const idx = join(dir, 'knowledge', '.index')
    assert.ok(ex(join(idx, 'manifest.json')), 'manifest 落盘')
    assert.ok(ex(join(idx, 'docs.jsonl')), 'docs 落盘')
    assert.ok(ex(join(idx, 'inverted.jsonl')), 'inverted 落盘')
    assert.ok(ex(join(idx, 'links.jsonl')), 'links 落盘')
    assert.ok(ex(join(idx, 'tags.json')), 'tags 落盘')

    const manifest = JSON.parse(rf(join(idx, 'manifest.json'), 'utf-8'))
    assert.equal(manifest.version, 1)
    // experience(workflow.md) + my-notes(a,b) + pack(p.md) = 4 篇
    assert.equal(manifest.docs, 4)
    assert.ok(manifest.blocks >= 6)
    assert.ok(manifest.files['experience/workflow.md'], '指纹表含每篇文档')
    assert.equal(typeof manifest.files['experience/workflow.md'].mtime, 'number')

    const stats = store.stats()
    assert.equal(stats.docs, 4)
    assert.ok(stats.grams > 0)
    assert.ok(stats.indexBytes > 0)
    assert.equal(stats.indexAgeMs >= 0, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('load 无 force 时直接复用既有索引（builtAt 不变）', async () => {
  const { dir } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    const builtAt1 = s1.stats().builtAt
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().builtAt, builtAt1, '未重建')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('md 变更后 load 自动重建（mtime 新于索引）', async () => {
  const { dir, personal } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    const before = s1.stats().docs
    writeFileSync(join(personal, 'new.md'), '# 新文档\n\n新内容。\n', 'utf-8')
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().docs, before + 1, '新文档进索引')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('索引版本不符时自动重建（防旧格式误用）', async () => {
  const { dir } = makeFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    await s1.load({ force: true })
    const mf = join(dir, 'knowledge', '.index', 'manifest.json')
    const m = JSON.parse(rf(mf, 'utf-8'))
    m.version = 999
    writeFileSync(mf, JSON.stringify(m), 'utf-8')
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().version ?? 1, 1, '重建回当前版本')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('inverted.jsonl 的 postings 下标落在 docs.jsonl 行数范围内', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const idx = join(dir, 'knowledge', '.index')
    const docs = rf(join(idx, 'docs.jsonl'), 'utf-8').split('\n').filter(Boolean)
    const inv = rf(join(idx, 'inverted.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.ok(inv.length > 0)
    for (const e of inv) {
      for (const [di, w] of e.p) {
        assert.ok(di >= 0 && di < docs.length, `docIdx ${di} 越界`)
        assert.ok(typeof w === 'number' && w > 0)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('links.jsonl 的 target 解析到同空间 docId，断链为 null', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const rows = rf(join(dir, 'knowledge', '.index', 'links.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const hit = rows.find((r) => r.from === 'my-notes/a.md')
    assert.equal(hit.target, 'my-notes/b.md', '[[b]] 解析到同目录 b.md')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空空间（无任何 md）不崩，索引文档数为 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kn-empty-'))
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.equal(store.stats().docs, 0)
    assert.deepEqual(store.getSpaces(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: FAIL —— `createKnowledgeStore is not a function`

- [ ] **Step 3: 追加实现到 `kernel/knowledge.mjs`**

```js
// 空间发现与解析所需（Task 5 已导入部分，这里补齐本任务新增依赖）
import {
  countGrams, buildIdf, vectorizeText, blockIndexText, blockTagBoost,
  serializeIndex, parseJsonl, resolveLinkTarget,
} from '../shared/knowledge-core.mjs'

/** 单文档 > 1MB 只索引前 200 块（护栏：防单文件把索引撑爆） */
const MAX_BLOCKS_PER_DOC = 200
const PRUNE_MIN_DOCS = 50      // 少于 50 篇不做高频剪枝（小库剪枝会误伤）
const PRUNE_DF_RATIO = 0.5     // 出现在超半数文档里的 gram 近似停用词

export function createKnowledgeStore({ configDir, root = null } = {}) {
  const kroot = root || knowledgeRoot(configDir)
  const idxDir = join(kroot, '.index')
  let spaces = []
  let docs = []            // = docs.jsonl 行序，即 docIdx 定义
  let idf = new Map()
  let inverted = new Map() // gramHash -> { g, df, p: [[docIdx, w]] }
  let linkOut = new Map()  // docId -> [{ to, target }]
  let builtAt = null
  let indexBytes = 0
  // 索引指纹表（manifest.files）与 links.jsonl 的当前行集：staleness 精确判定与
  // 增量更新的共享状态。**唯一写入口是 persist()**（全量/增量共用），避免两套写盘逻辑漂移。
  let lastFiles = {}
  let lastLinkRows = []

  const file = (name) => join(idxDir, name)
  const docIds = () => new Set(docs.map((d) => d.id))

  function scanAll() {
    const acc = { docs: [], links: [] }
    for (const space of spaces) {
      for (const { absPath, relPath } of walkMd(space.root)) {
        try {
          const parsed = parseDocFile({ absPath, space, relPath })
          if (parsed.doc.blocks.length > MAX_BLOCKS_PER_DOC) {
            parsed.doc.blocks = parsed.doc.blocks.slice(0, MAX_BLOCKS_PER_DOC)
          }
          acc.docs.push(parsed.doc)
          acc.links.push(...parsed.links)
        } catch { /* 单文档解析失败：跳过，不拖垮整库 */ }
      }
    }
    return acc
  }

  function buildIndex() {
    const { docs: nextDocs, links } = scanAll()
    // 两遍法：先用全部块语料算 IDF，再向量化（IDF 必须基于全库，否则评分不可比）
    const gramDocs = []
    for (const d of nextDocs) {
      for (const b of d.blocks) gramDocs.push({ gramCounts: countGrams(blockIndexText({ kind: b.kind, text: b.text, entryTag: b.tag })) })
    }
    const nextIdf = buildIdf(gramDocs)

    const inv = new Map()
    const tagMap = {}
    nextDocs.forEach((d, i) => {
      for (const b of d.blocks) {
        const text = blockIndexText({ kind: b.kind, text: b.text, entryTag: b.tag })
        const boost = blockTagBoost({ kind: b.kind, entryTag: b.tag })
        for (const [g, w] of vectorizeText(text, { tagBoost: boost, idf: nextIdf })) {
          const e = inv.get(g) || { g, docs: new Set(), p: [] }
          e.docs.add(i)
          e.p.push([i, Math.round(w * 10000) / 10000])
          inv.set(g, e)
        }
      }
      for (const t of d.tags) { (tagMap[t] ||= []).push(d.id) }
    })

    // df 事后统计 + 高频剪枝（小库不剪）
    const nextInv = new Map()
    for (const [g, e] of inv) {
      const df = e.docs.size
      if (nextDocs.length >= PRUNE_MIN_DOCS && df > nextDocs.length * PRUNE_DF_RATIO) continue
      nextInv.set(g, { g, df, p: e.p })
    }

    const ids = new Set(nextDocs.map((d) => d.id))
    const nextLinks = []
    const out = new Map()
    for (const l of links) {
      const owner = nextDocs.find((d) => d.id === l.from)
      const target = owner
        ? resolveLinkTarget({ fromRel: owner.rel, to: l.to, spaceId: owner.spaceId, docIds: ids })
        : null
      nextLinks.push({ from: l.from, to: l.to, target })
      ;(out.get(l.from) || out.set(l.from, []).get(l.from)).push({ to: l.to, target })
    }

    docs = nextDocs
    idf = nextIdf
    inverted = nextInv
    linkOut = out
    persist(nextLinks)
  }

  /**
   * 索引唯一写入口（全量构建与增量更新共用）。
   * linkRows 由调用方传入：全量路径来自 scanAll，增量路径来自 lastLinkRows 的按文档替换
   * ——两条路径共用同一份序列化与原子落盘逻辑，不各写一套。
   */
  function persist(linkRows = lastLinkRows) {
    const rows = docs.map((d, i) => ({
      i, id: d.id, spaceId: d.spaceId, rel: d.rel, title: d.title, tags: d.tags,
      hash: d.hash, mtime: d.mtime, size: d.size, lines: d.lines,
      blocks: d.blocks.map((b) => ({ n: b.n, kind: b.kind, level: b.level, text: b.text, line: b.line, tag: b.tag, full: b.full })),
    }))
    const inv = [...inverted.values()]
    const files = {}
    for (const d of docs) files[d.id] = { size: d.size, mtime: d.mtime, hash: d.hash }
    const spaceCount = {}
    for (const d of docs) spaceCount[d.spaceId] = (spaceCount[d.spaceId] || 0) + 1
    const built = new Date().toISOString()
    const manifest = {
      version: INDEX_VERSION, builtAt: built, docs: docs.length,
      blocks: docs.reduce((s, d) => s + d.blocks.length, 0),
      spaces: Object.fromEntries(Object.entries(spaceCount).map(([k, v]) => [k, { docs: v }])),
      files,
    }
    const tags = {}
    for (const d of docs) for (const t of d.tags) (tags[t] ||= []).push(d.id)
    const ser = serializeIndex({ docs: rows, inverted: inv, links: linkRows, tags })
    try {
      mkdirSync(idxDir, { recursive: true })
      // 原子替换：先写 .tmp 再 rename（同 graph.mjs:130-136 手法）。
      // docs.jsonl 与 inverted.jsonl 必须同批落盘——postings 下标依赖 docs 行序。
      writeFileSync(file('docs.jsonl.tmp'), ser.docs, 'utf-8')
      writeFileSync(file('inverted.jsonl.tmp'), ser.inverted, 'utf-8')
      writeFileSync(file('links.jsonl.tmp'), ser.links, 'utf-8')
      writeFileSync(file('tags.json.tmp'), ser.tags, 'utf-8')
      writeFileSync(file('manifest.json.tmp'), JSON.stringify(manifest, null, 2), 'utf-8')
      for (const n of ['docs.jsonl', 'inverted.jsonl', 'links.jsonl', 'tags.json', 'manifest.json']) {
        renameSync(file(n + '.tmp'), file(n))
      }
      builtAt = built
      lastFiles = files
      lastLinkRows = linkRows
      indexBytes = Buffer.byteLength(ser.docs, 'utf-8') + Buffer.byteLength(ser.inverted, 'utf-8')
        + Buffer.byteLength(ser.links, 'utf-8') + Buffer.byteLength(ser.tags, 'utf-8')
    } catch { /* 磁盘不可写不致命：内存索引仍可用（对齐 graph.mjs:172 纪律） */ }
  }

  function loadIndexFromDisk() {
    const raw = (n) => { try { return readFileSync(file(n), 'utf-8') } catch { return '' } }
    const manifest = (() => { try { return JSON.parse(raw('manifest.json') || '{}') } catch { return {} } })()
    if ((manifest.version ?? 0) !== INDEX_VERSION) return false
    docs = parseJsonl(raw('docs.jsonl'))
    if (!docs.length && (manifest.docs || 0) > 0) return false
    const inv = new Map()
    for (const e of parseJsonl(raw('inverted.jsonl'))) inv.set(e.g, { g: e.g, df: e.df, p: e.p })
    inverted = inv
    linkOut = new Map()
    for (const l of parseJsonl(raw('links.jsonl'))) {
      ;(linkOut.get(l.from) || linkOut.set(l.from, []).get(l.from)).push({ to: l.to, target: l.target })
    }
    const gramDocs = []
    for (const d of docs) {
      for (const b of d.blocks) gramDocs.push({ gramCounts: countGrams(blockIndexText({ kind: b.kind, text: b.text, entryTag: b.tag })) })
    }
    idf = buildIdf(gramDocs)
    builtAt = manifest.builtAt || null
    lastFiles = manifest.files || {}
    lastLinkRows = parseJsonl(raw('links.jsonl'))
    indexBytes = raw('docs.jsonl').length + raw('inverted.jsonl').length
    return true
  }

  /**
   * 精确 staleness：逐文件比 size/mtime，并检测"新增"与"磁盘已删"。
   * 为什么不用全局 builtAt 比较：增量更新（updateDoc → persist）会刷新 builtAt，
   * 若以全局时间戳判定，会漏掉"某文件早于本次更新但尚未进索引"的改动——per-file 指纹表
   * 没有这个盲区，也让"增量更新后 load() 不再全量重建"（Task 8）成立。
   */
  function indexStale() {
    const seen = new Set()
    for (const space of spaces) {
      for (const { absPath, relPath } of walkMd(space.root)) {
        const id = toDocId(space.id, relPath)
        seen.add(id)
        const rec = lastFiles[id]
        if (!rec) return true                       // 新增文件
        try {
          const st = statSync(absPath)
          if (st.size !== rec.size || Math.abs(st.mtimeMs - rec.mtime) > 1) return true
        } catch { return true }                     // 读不到 → 保守重建
      }
    }
    for (const id of Object.keys(lastFiles)) if (!seen.has(id)) return true  // 磁盘已删
    return false
  }

  return {
    /**
     * 加载或构建索引。**非 async**：内部全同步（无任何 await），因为 KnowledgeSearch
     * 的 run() 是同步契约；同时 `await store.load()` 对非 Promise 值依然合法，
     * 故调用方可自由书写（Task 7-9 的测试即如此）。
     */
    load({ force = false, spaces: injected = null } = {}) {
      spaces = injected || discoverSpaces({ configDir, root: kroot })
      if (force) { buildIndex(); return }
      const ok = loadIndexFromDisk()
      if (!ok || indexStale()) buildIndex()
    },
    getSpaces() {
      const count = {}
      for (const d of docs) count[d.spaceId] = (count[d.spaceId] || 0) + 1
      return spaces.map((s) => ({ ...s, docCount: count[s.id] || 0 }))
    },
    getDocs() { return docs },
    getIdf() { return idf },
    getInverted() { return inverted },
    getLinkOut() { return linkOut },
    stats() {
      return {
        version: INDEX_VERSION, docs: docs.length,
        blocks: docs.reduce((s, d) => s + d.blocks.length, 0),
        grams: inverted.size, spaces: spaces.length,
        builtAt, indexAgeMs: builtAt ? Date.now() - Date.parse(builtAt) : null,
        indexBytes,
      }
    },
  }
}
```

> **实现提示**：`(map.get(k) || map.set(k, []).get(k)).push(v)` 这个惯用法依赖
> `Map.prototype.set` 返回自身——Node 全版本成立。若觉得晦涩，可换成显式三行的写法，行为等价。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: PASS —— `# pass 11`

- [ ] **Step 5: 提交**

```bash
git add kernel/knowledge.mjs kernel-tests/knowledge.test.mjs
git commit -m "feat(knowledge): 索引构建/加载——两遍 IDF、倒排 postings、原子同批落盘"
```

---

### Task 7: 检索（4 路融合 + 预算截断）

**Files:**
- Modify: `kernel/knowledge.mjs`（追加 `search` 到 store 返回对象）
- Test: `kernel-tests/knowledge.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 6 的 store 内部状态（`docs`/`inverted`/`idf`/`linkOut`）+ shared 的 `vectorizeText`/`cosine`/`keywordScore`/`structBoostOf`/`fuseScore`/`makeSnippet`/`toBlockId`
- Produces: `KnowledgeStore.search(opts): KnowledgeResult`（**同步**，不返回 Promise）

```
opts: { query?, keywords?: string[], spaces?: string[]|null, topK?: number, maxBytes?: number, mode?: 'snippet'|'full' }
KnowledgeResult = {
  items: KnowledgeItem[], count: number, indexAge: number|null, degraded: boolean
}
KnowledgeItem = { docId, blockId, spaceId, title, heading: string|null, snippet, score, line, kind }
```

**算法**（spec §5.4）：倒排候选 → 文档序取前 `max(topK*4, 20)` → 块级重排（向量 0.60 + 关键词 0.25 + 结构 0.15）→ 出链图扩展（×0.9）→ 按 `topK` 与 `maxBytes` 双层截断。

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/knowledge.test.mjs` 末尾追加：

```js
test('search 命中经验条目，粒度为单条（blockId 指向条目块）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '只发文件传输助手', keywords: ['企微CLI化'], topK: 5 })
    assert.ok(r.count > 0, '有命中')
    const top = r.items[0]
    assert.equal(top.spaceId, 'experience')
    assert.equal(top.kind, 'entry')
    assert.equal(top.title, 'workflow')
    assert.match(top.blockId, /^experience\/workflow\.md#\d+$/)
    assert.ok(top.line > 0, 'line 可回溯原文行号')
    assert.match(top.snippet, /文件传输助手/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 结果按分数降序，且不含零分项', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '步骤字段契约', keywords: [], topK: 10 })
    for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].score >= r.items[i].score)
    assert.ok(r.items.every((x) => x.score > 0.001))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 中文查询有效（bigram 命中，非关键词路）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '沟通渠道', topK: 5 })
    assert.ok(r.count > 0)
    assert.equal(r.degraded, false, '走倒排向量路，未降级')
    assert.match(r.items[0].snippet, /沟通渠道/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search spaces 过滤只返回指定空间', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '文档', spaces: ['my-notes'], topK: 10 })
    assert.ok(r.items.every((x) => x.spaceId === 'my-notes'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 出链图扩展：查 a.md 内容时 b.md 的 heading 进入结果并带 0.9 折扣', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '甲文档', keywords: ['甲文档'], topK: 10 })
    assert.ok(r.items.some((x) => x.docId === 'my-notes/a.md'), '命中甲文档自身')
    const b = r.items.find((x) => x.docId === 'my-notes/b.md')
    assert.ok(b, '出链目标 b.md 经图扩展进入结果')
    assert.equal(b.kind, 'heading')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search topK 与 maxBytes 双层截断', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r1 = store.search({ query: '文档', topK: 1 })
    assert.equal(r1.items.length, 1)
    const r2 = store.search({ query: '文档', topK: 100, maxBytes: 1 })
    assert.ok(r2.items.length <= 1, 'maxBytes 极小也至少给 1 条（否则前端永远空白）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search mode=full 返回条目全文，snippet 模式截断', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const short = store.search({ query: '文件传输助手', mode: 'snippet' })
    const full = store.search({ query: '文件传输助手', mode: 'full' })
    assert.ok(full.items[0].snippet.length >= short.items[0].snippet.length)
    assert.match(full.items[0].snippet, /涉及真实沟通渠道/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 空查询返回空结果且不报错', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: '', keywords: [] })
    assert.deepEqual(r.items, [])
    assert.equal(r.count, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 无倒排命中时降级为关键词路（degraded=true，不抛错）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = store.search({ query: 'zzzzz', keywords: ['zzzzz'] })
    assert.equal(r.degraded, true)
    assert.equal(r.count, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: FAIL —— `store.search is not a function`

- [ ] **Step 3: 追加实现到 `kernel/knowledge.mjs`**

补导入：

```js
import {
  cosine, keywordScore, structBoostOf, fuseScore, makeSnippet, toBlockId,
} from '../shared/knowledge-core.mjs'
```

在 `createKnowledgeStore` 内部（`return { ... }` 之前）加：

```js
  const docIndexById = () => { const m = new Map(); docs.forEach((d, i) => m.set(d.id, i)); return m }

  /** 块级评分。degraded=true 时跳过向量路（查询 gram 全部落空，只能靠关键词）。 */
  function scoreBlock(doc, b, qvec, qtext, kws, degraded) {
    const shape = { kind: b.kind, text: b.text, entryTag: b.tag }
    const cos = degraded ? 0 : cosine(
      vectorizeText(blockIndexText(shape), { tagBoost: blockTagBoost(shape), idf }), qvec,
    )
    const kw = keywordScore({ tag: b.tag || '', summary: b.text, full: b.full || '', theme: doc.title }, kws)
    const struct = structBoostOf({ block: { kind: b.kind }, doc, query: qtext, keywords: kws })
    return { cos, kw, struct }
  }

  function headingAt(doc, line) {
    let h = null
    for (const b of doc.blocks) { if (b.line > line) break; if (b.kind === 'heading') h = b.text }
    return h
  }

  function toItem(doc, b, sc, qvec, qtext, kws, degraded, mode, graph) {
    const { cos, kw, struct } = sc
    const score = fuseScore({ cos, kw, struct, graph })
    return {
      docId: doc.id, blockId: toBlockId(doc.id, b.n), spaceId: doc.spaceId,
      title: doc.title, heading: headingAt(doc, b.line),
      snippet: mode === 'full' ? (b.full || b.text) : makeSnippet(b.text),
      score, line: b.line, kind: b.kind,
    }
  }

  function search({ query = '', keywords = [], spaces: only = null, topK = 5, maxBytes = 2048, mode = 'snippet' } = {}) {
    const q = String(query || '').trim()
    const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean)
    const qtext = q || kws.join(' ')
    const age = builtAt ? Date.now() - Date.parse(builtAt) : null
    if (!qtext) return { items: [], count: 0, indexAge: age, degraded: false }
    const allow = Array.isArray(only) && only.length ? new Set(only) : null
    const qvec = vectorizeText(qtext, { idf })

    // 1) 倒排候选：只遍历查询 gram 的 postings，成本 ∝ 命中量（不是全库 × 全 gram）
    const acc = new Map()
    for (const [g, wq] of qvec) {
      const e = inverted.get(g)
      if (!e) continue
      for (const [di, wd] of e.p) acc.set(di, (acc.get(di) || 0) + wq * wd)
    }
    let degraded = false
    let cand = [...acc.keys()]
    if (!cand.length) {
      // 查询 gram 全落空（被剪枝/语料太小/纯生僻词）→ 退化为关键词路，绝不返回空而不给机会
      degraded = true
      cand = docs.map((_, i) => i)
    }
    cand = cand
      .filter((i) => docs[i] && (!allow || allow.has(docs[i].spaceId)))
      .map((i) => ({ i, s: acc.get(i) || 0 }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(topK * 4, 20))
      .map((x) => x.i)

    // 2) 块级重排：只在候选文档内逐块打分（块级才是精度的来源）
    const items = []
    for (const i of cand) {
      const doc = docs[i]
      let best = null
      for (const b of doc.blocks) {
        const it = toItem(doc, b, scoreBlock(doc, b, qvec, qtext, kws, degraded), qvec, qtext, kws, degraded, mode, false)
        if (!best || it.score > best.score) best = it
      }
      if (best && best.score > 0.001) items.push(best)
    }

    // 3) 图扩展：已命中文档的出链目标，取 heading/entry 块参与（×0.9 折扣）
    const idxById = docIndexById()
    const seen = new Set(items.map((x) => x.blockId))
    for (const it of items.slice(0, Math.max(topK, 1))) {
      for (const l of linkOut.get(it.docId) || []) {
        if (!l.target) continue
        const ti = idxById.get(l.target)
        if (ti === undefined) continue
        const tdoc = docs[ti]
        if (allow && !allow.has(tdoc.spaceId)) continue
        for (const b of tdoc.blocks) {
          if (b.kind !== 'heading' && b.kind !== 'entry') continue
          const bid = toBlockId(tdoc.id, b.n)
          if (seen.has(bid)) continue
          const cand2 = toItem(tdoc, b, scoreBlock(tdoc, b, qvec, qtext, kws, degraded), qvec, qtext, kws, degraded, mode, true)
          if (cand2.score > 0.001) { seen.add(bid); items.push(cand2) }
        }
      }
    }

    items.sort((a, b) => b.score - a.score)
    // 4) 双层截断：topK 控条数，maxBytes 控上下文预算。
    //    第一条无条件放入——否则预算极小时前端永远空白，用户看到"搜不到"。
    const out = []
    let used = 0
    for (const it of items) {
      if (out.length >= topK) break
      const bytes = Buffer.byteLength(it.snippet, 'utf-8') + 160
      if (out.length > 0 && used + bytes > maxBytes) break
      used += bytes
      out.push(it)
    }
    return { items: out, count: out.length, indexAge: age, degraded }
  }
```

并在返回对象中加入 `search`（紧接 `getSpaces` 之后）：

```js
    search,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: PASS —— `# pass 20`

- [ ] **Step 5: 提交**

```bash
git add kernel/knowledge.mjs kernel-tests/knowledge.test.mjs
git commit -m "feat(knowledge): 4 路融合检索——倒排候选/块级重排/图扩展/双层预算截断"
```

---

### Task 8: 增量更新与条目级接口

**Files:**
- Modify: `kernel/knowledge.mjs`（追加 `updateDoc`/`listEntries`/`getDoc`/`listTree`/`getLinks`/`getGraph`）
- Test: `kernel-tests/knowledge.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 6-7 的 store 状态
- Produces（全部同步，除 `updateDoc`）：
  - `KnowledgeStore.updateDoc(docId: string): Promise<{ updated: boolean, reason?: string }>`
  - `KnowledgeStore.getDoc(docId: string): Doc|null`
  - `KnowledgeStore.listEntries(docId: string): { blockId, tag, summary, full, line }[]`
  - `KnowledgeStore.listTree({ space: string, path?: string }): { name, path, type: 'dir'|'file', docId? }[]`
  - `KnowledgeStore.getLinks(docId: string): { out: {to,target}[], in: {from}[] }`
  - `KnowledgeStore.getGraph({ space?: string|null, limit?: number }): { nodes: {id,label,spaceId,kind}[], edges: {from,to,target:string|null}[] }`

> **docIdx 稳定性**：更新单个文档时**必须保持它的 docIdx 不变**（原地替换块与 postings）。
> 若改成"删了重加"，其后所有文档的下标都会位移，`inverted.jsonl` 立即失效。

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/knowledge.test.mjs` 末尾追加：

```js
test('listEntries 返回条目级清单（GUI 与 AI 的公共读接口）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const entries = store.listEntries('experience/workflow.md')
    assert.equal(entries.length, 2)
    assert.equal(entries[0].tag, '企微CLI化')
    assert.equal(entries[0].summary, '只发文件传输助手')
    assert.match(entries[0].full, /真实沟通渠道/)
    assert.match(entries[0].blockId, /#\d+$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listEntries 对非经验文档返回空数组（无条目块）', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.deepEqual(store.listEntries('my-notes/b.md'), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('updateDoc 增量更新：新内容可检索，且其他文档 docIdx 不变', async () => {
  const { dir, personal } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const before = store.getDocs().map((d) => d.id)
    writeFileSync(join(personal, 'workflow.md'), [
      '---', 'name: workflow', '---',
      '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
      '- [会话|新增标签] 全新的条目内容 -- 增量更新后立即可检索',
    ].join('\n') + '\n', 'utf-8')
    const r = await store.updateDoc('experience/workflow.md')
    assert.equal(r.updated, true)
    assert.deepEqual(store.getDocs().map((d) => d.id), before, 'docIdx 顺序不变')
    const hit = store.search({ query: '全新的条目内容', topK: 3 })
    assert.ok(hit.count > 0, '同一会话内立即可检索（无需重启）')
    assert.match(hit.items[0].snippet, /全新的条目内容/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('updateDoc 对不存在的 docId 返回 not-found 且不崩', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const r = await store.updateDoc('experience/nope.md')
    assert.equal(r.updated, false)
    assert.equal(r.reason, 'not-found')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('增量更新后 load() 不再触发全量重建（staleness 以 per-file mtime 判定）', async () => {
  const { dir, personal } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    writeFileSync(join(personal, 'workflow.md'), '# 改过了\n\n新正文。\n', 'utf-8')
    await store.updateDoc('experience/workflow.md')
    const s2 = createKnowledgeStore({ configDir: dir })
    await s2.load()
    assert.equal(s2.stats().builtAt, store.stats().builtAt, '复用增量结果，未全量重建')
    assert.equal(s2.search({ query: '新正文', topK: 1 }).count, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('getDoc / listTree / getLinks / getGraph 形状正确', async () => {
  const { dir } = makeFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    assert.equal(store.getDoc('my-notes/a.md').title, '甲文档')
    assert.equal(store.getDoc('不存在'), null)

    const tree = store.listTree({ space: 'my-notes' })
    assert.deepEqual(tree.map((x) => x.name).sort(), ['a.md', 'b.md'])

    const links = store.getLinks('my-notes/a.md')
    assert.equal(links.out[0].target, 'my-notes/b.md')
    assert.equal(links.in.length, 0)
    const bin = store.getLinks('my-notes/b.md')
    assert.equal(bin.in[0].from, 'my-notes/a.md', '反向链接')

    const g = store.getGraph({ space: 'my-notes' })
    assert.equal(g.nodes.length, 2)
    assert.equal(g.edges.filter((e) => e.target).length, 1)
    for (const n of g.nodes) assert.ok(n.id && n.label)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: FAIL —— `store.listEntries is not a function`

- [ ] **Step 3: 追加实现到 `kernel/knowledge.mjs`**

> **本任务不重复定义 `persist` / `indexStale` / `lastFiles`** —— 它们已在 Task 6 落地
> （唯一写入口 + per-file 精确 staleness）。本任务只补增量路径需要的辅助函数与读接口。

```js
  let lastFiles = {}   // manifest.files：docId -> { size, mtime, hash }

  function absPathOf(doc) {
    const space = spaces.find((s) => s.id === doc.spaceId)
    if (!space) return null
    return join(space.root, ...doc.rel.split('/'))
  }

```js
  function absPathOf(doc) {
    const space = spaces.find((s) => s.id === doc.spaceId)
    if (!space) return null
    return join(space.root, ...doc.rel.split('/'))
  }

  /**
   * 重算**单个文档**的链接行（增量路径专用）：其余文档的 links 行沿用 lastLinkRows，
   * 不必为了改一个文件把全库重读一遍。
   */
  function relinkDoc(doc, ids) {
    const rows = lastLinkRows.filter((r) => r.from !== doc.id)
    const out = []
    const abs = absPathOf(doc)
    if (abs && existsSync(abs)) {
      let raw = ''
      try { raw = readFileSync(abs, 'utf-8') } catch { raw = '' }
      for (const l of extractLinks(raw)) {
        const target = resolveLinkTarget({ fromRel: doc.rel, to: l.to, spaceId: doc.spaceId, docIds: ids })
        rows.push({ from: doc.id, to: l.to, target })
        out.push({ to: l.to, target })
      }
    }
    linkOut.delete(doc.id)
    if (out.length) linkOut.set(doc.id, out)
    lastLinkRows = rows
  }

  function updateDoc(docId) {
    const i = docs.findIndex((d) => d.id === docId)
    if (i < 0) return { updated: false, reason: 'not-found' }
    const doc = docs[i]
    const abs = absPathOf(doc)
    if (!abs || !existsSync(abs)) return { updated: false, reason: 'file-missing' }
    const space = spaces.find((s) => s.id === doc.spaceId)
    let parsed
    try { parsed = parseDocFile({ absPath: abs, space, relPath: doc.rel }) } catch { return { updated: false, reason: 'parse-error' } }
    if (parsed.doc.blocks.length > MAX_BLOCKS_PER_DOC) {
      parsed.doc.blocks = parsed.doc.blocks.slice(0, MAX_BLOCKS_PER_DOC)
    }
    // 原地替换：docIdx i 保持不变（否则其后全部文档下标位移，inverted.jsonl 立即失效）
    docs[i] = parsed.doc
    // 该文档的全部 postings 重算：先从既有倒排中摘除 di === i，再按新块重新插入。
    // df 用"该 gram 覆盖的文档数"重算（块级 posting 可能同文档多条，故去重后计数）。
    for (const [g, e] of [...inverted]) {
      const p = e.p.filter(([di]) => di !== i)
      if (!p.length) inverted.delete(g)
      else { e.p = p; e.df = new Set(p.map(([di]) => di)).size }
    }
    for (const b of parsed.doc.blocks) {
      const shape = { kind: b.kind, text: b.text, entryTag: b.tag }
      for (const [g, w] of vectorizeText(blockIndexText(shape), { tagBoost: blockTagBoost(shape), idf })) {
        const e = inverted.get(g) || { g, df: 0, p: [] }
        if (!e.p.some(([di]) => di === i)) e.df += 1
        e.p.push([i, Math.round(w * 10000) / 10000])
        e.p.sort((a, b2) => a[0] - b2[0])
        inverted.set(g, e)
      }
    }
    // 链接行按文档增量替换（不平重读全库）
    relinkDoc(parsed.doc, new Set(docs.map((d) => d.id)))
    persist()
    return { updated: true }
  }

  function getDoc(docId) { return docs.find((d) => d.id === docId) || null }

  function listEntries(docId) {
    const d = getDoc(docId)
    if (!d) return []
    return d.blocks.filter((b) => b.kind === 'entry').map((b) => ({
      blockId: toBlockId(d.id, b.n), tag: b.tag, summary: b.text, full: b.full, line: b.line,
    }))
  }

  function listTree({ space, path = '' } = {}) {
    const sp = spaces.find((s) => s.id === space)
    if (!sp) return []
    const root = join(sp.root, ...String(path || '').split('/').filter(Boolean))
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
    const out = []
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue
      const rel = `${String(path || '').replace(/^\/+|\/+$/g, '')}${path ? '/' : ''}${e.name}`
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push({ name: e.name, path: rel, type: 'dir' }) }
      else if (/\.md$/i.test(e.name)) out.push({ name: e.name, path: rel, type: 'file', docId: toDocId(sp.id, rel) })
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  }

  function getLinks(docId) {
    const out = (linkOut.get(docId) || []).map((l) => ({ to: l.to, target: l.target }))
    const inb = []
    for (const [from, arr] of linkOut) for (const l of arr) if (l.target === docId) inb.push({ from })
    return { out, in: inb }
  }

  function getGraph({ space = null, limit = 200 } = {}) {
    const pool = space ? docs.filter((d) => d.spaceId === space) : docs
    const ids = new Set(pool.map((d) => d.id))
    const nodes = pool.slice(0, limit).map((d) => ({ id: d.id, label: d.title, spaceId: d.spaceId, kind: 'doc' }))
    const edges = []
    for (const [from, arr] of linkOut) {
      if (!ids.has(from)) continue
      for (const l of arr) { if (l.target && ids.has(l.target)) edges.push({ from, to: l.target, target: l.target }) }
    }
    return { nodes, edges }
  }
```

并在 store 的返回对象中追加（`persist`/`indexStale`/`lastFiles` 已在 Task 6 就位，此处不重复）：

```js
    updateDoc, getDoc, listEntries, listTree, getLinks, getGraph,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: PASS —— `# pass 26`

- [ ] **Step 5: 提交**

```bash
git add kernel/knowledge.mjs kernel-tests/knowledge.test.mjs
git commit -m "feat(knowledge): 增量更新（docIdx 稳定）+ 条目/树/反链/图谱读接口"
```

---

### Task 9: 内核 CLI 子命令（`--knowledge <op>`）

> **对 spec 的细化**：spec §5.5 原写三个独立 flag（`--knowledge-search`/`--knowledge-reindex`/
> `--knowledge-stats`）。实施改用**单一 `--knowledge <op>` + 子参数**：parseArgs 只需 8 个新 case
> 而非 3 组 × 参数，且 9 个 op 共用一条分发路径。能力等价。

**Files:**
- Create: `kernel/knowledge-cli.mjs`
- Modify: `kernel/cli.mjs`（`parseArgs` 增 case；`main()` 只读短路块增分支）
- Test: `kernel-tests/knowledge-cli.test.mjs`

**Interfaces:**
- Consumes: `createKnowledgeStore`（Task 5-8）
- Produces:
  - `runKnowledgeCommand({ op: string, args?: object, configDir?: string }): Promise<{ output: unknown, code: number }>`
  - 支持的 op：`spaces` | `tree` | `doc` | `entries` | `search` | `links` | `graph` | `stats` | `reindex` | `update-doc`
  - `kernel-tests/knowledge-cli.test.mjs` 可导入此函数直接测（不必 spawn）

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/knowledge-cli.test.mjs`：

```js
// kernel 知识子命令测试：直接调 runKnowledgeCommand（不起进程）+ parseArgs 契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runKnowledgeCommand } from '../kernel/knowledge-cli.mjs'
import { parseArgs } from '../kernel/cli.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kcli-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', '---',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
  ].join('\n') + '\n', 'utf-8')
  return { dir, personal }
}

test('op=stats 返回索引统计', async () => {
  const { dir } = fixture()
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'stats', configDir: dir })
    assert.equal(code, 0)
    assert.equal(output.docs, 1)
    assert.ok(output.blocks >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=spaces 返回空间清单（含 docCount）', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({ op: 'spaces', configDir: dir })
    assert.equal(output.spaces[0].id, 'experience')
    assert.equal(output.spaces[0].docCount, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=search 返回块级结果', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({
      op: 'search', configDir: dir, args: { query: '文件传输助手', topK: 5 },
    })
    assert.ok(output.count > 0)
    assert.equal(output.items[0].spaceId, 'experience')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=entries 返回条目级清单', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({
      op: 'entries', configDir: dir, args: { id: 'experience/workflow.md' },
    })
    assert.equal(output.entries.length, 1)
    assert.equal(output.entries[0].tag, '企微CLI化')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=update-doc 触发增量更新', async () => {
  const { dir, personal } = fixture()
  try {
    writeFileSync(join(personal, 'workflow.md'), '- [会话|新] 增量条目 -- 内容\n', 'utf-8')
    const { output } = await runKnowledgeCommand({
      op: 'update-doc', configDir: dir, args: { id: 'experience/workflow.md' },
    })
    assert.equal(output.updated, true)
    const { output: s } = await runKnowledgeCommand({
      op: 'search', configDir: dir, args: { query: '增量条目' },
    })
    assert.ok(s.count > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未知 op 返回 code=1 与 error 文案（不抛异常给调用方）', async () => {
  const { dir } = fixture()
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'nope', configDir: dir })
    assert.equal(code, 1)
    assert.match(String(output.error), /unknown knowledge op/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseArgs 认识 --knowledge 与子参数（topK 转数字）', () => {
  const a = parseArgs(['--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--knowledge', 'search', '--query', 'x', '--keywords', 'a,b', '--topK', '3', '--mode', 'full'])
  assert.equal(a.knowledge, 'search')
  assert.equal(a.query, 'x')
  assert.deepEqual(a.keywords, ['a', 'b'])
  assert.equal(a.topK, 3)
  assert.equal(a.mode, 'full')
})

test('parseArgs 缺省时 knowledge 为 null（不影响既有路径）', () => {
  const a = parseArgs(['--print'])
  assert.equal(a.knowledge, null)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kernel-tests/knowledge-cli.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/knowledge-cli.mjs'`

- [ ] **Step 3: 创建 `kernel/knowledge-cli.mjs`**

```js
// kernel/knowledge-cli.mjs —— `--knowledge <op>` 的聚合实现
// ---------------------------------------------------------------------------
// 为什么聚合：9 个 op 的差别只是"调哪个方法、传什么参"，聚合后 cli.mjs 只需一个
// 短路分支 + 8 个 parseArgs case；分散成 9 个 flag 会让 parseArgs 膨胀三倍。
// 与 kernel/readonly.mjs 同款范式：stdout 一个 JSON，code 0/1，不进 loop。
import { createKnowledgeStore } from './knowledge.mjs'

const OPS = new Set([
  'spaces', 'tree', 'doc', 'entries', 'search', 'links', 'graph', 'stats', 'reindex', 'update-doc',
])

export async function runKnowledgeCommand({ op, args = {}, configDir = '' } = {}) {
  const name = String(op || '').trim()
  if (!OPS.has(name)) {
    return { output: { error: `unknown knowledge op: ${name}` }, code: 1 }
  }
  const store = createKnowledgeStore({ configDir })
  try {
    // reindex 必须 force；其余 op 走"按需加载"（索引缺失/过期时自动重建）
    await store.load({ force: name === 'reindex' })

    switch (name) {
      case 'spaces':
        return { output: { spaces: store.getSpaces() }, code: 0 }
      case 'tree':
        return { output: { entries: store.listTree({ space: String(args.space || ''), path: String(args.path || '') }) }, code: 0 }
      case 'doc':
        return { output: { doc: store.getDoc(String(args.id || '')) }, code: 0 }
      case 'entries':
        return { output: { entries: store.listEntries(String(args.id || '')) }, code: 0 }
      case 'search':
        return {
          output: store.search({
            query: String(args.query || ''),
            keywords: Array.isArray(args.keywords) ? args.keywords : [],
            spaces: Array.isArray(args.spaces) && args.spaces.length ? args.spaces : null,
            topK: Number(args.topK) || 5,
            maxBytes: Number(args.maxBytes) || 2048,
            mode: args.mode === 'full' ? 'full' : 'snippet',
          }),
          code: 0,
        }
      case 'links':
        return { output: store.getLinks(String(args.id || '')), code: 0 }
      case 'graph':
        return { output: store.getGraph({ space: args.space ? String(args.space) : null, limit: Number(args.limit) || 200 }), code: 0 }
      case 'stats':
        return { output: store.stats(), code: 0 }
      case 'reindex':
        return { output: { ok: true, ...store.stats() }, code: 0 }
      case 'update-doc':
        return { output: await store.updateDoc(String(args.id || '')), code: 0 }
      default:
        return { output: { error: `unknown knowledge op: ${name}` }, code: 1 }
    }
  } catch (e) {
    return { output: { error: e?.message || String(e) }, code: 1 }
  }
}
```

- [ ] **Step 4: 改 `kernel/cli.mjs`**

(a) `parseArgs` 的 `out` 初始化块（`to: null,` 之后）追加：

```js
    // 知识内核（S1）：单一聚合子命令 + 子参数。仅在 args.knowledge 有值时被读取，
    // 对既有主链路零影响（这些 flag 名与既有 --model/--scope 等无冲突）。
    knowledge: null,
    space: null,
    path: null,
    id: null,
    query: null,
    keywords: [],
    topK: null,
    limit: null,
    mode: null,
    force: false,
```

(b) switch 中 `case '--to': out.to = next() ?? null; break` 之后追加：

```js
      case '--knowledge': out.knowledge = next() ?? null; break
      case '--space': out.space = next() ?? null; break
      case '--path': out.path = next() ?? null; break
      case '--id': out.id = next() ?? null; break
      case '--query': out.query = next() ?? null; break
      case '--keywords': out.keywords = String(next() ?? '').split(',').map((s) => s.trim()).filter(Boolean); break
      case '--topK': out.topK = Number(next()) || null; break
      case '--limit': out.limit = Number(next()) || null; break
      case '--mode': out.mode = next() ?? null; break
      case '--force': out.force = true; break
```

(c) `main()` 的只读短路块（`if (args.agents || args.usage || args.audit) { ... }`）**之后**追加：

```js
  // S1 知识内核子命令：--knowledge <op>（stdout JSON，不进 loop）。
  // 聚合实现 kernel/knowledge-cli.mjs；bridge 通过 kernel-readonly 薄转发。
  if (args.knowledge) {
    const configDir = resolveConfigDir(process.env, homedir)
    const { runKnowledgeCommand } = await import('./knowledge-cli.mjs')
    const { output, code } = await runKnowledgeCommand({
      op: args.knowledge, configDir,
      args: {
        space: args.space, path: args.path, id: args.id, query: args.query,
        keywords: args.keywords, topK: args.topK, limit: args.limit, mode: args.mode,
      },
    })
    console.log(JSON.stringify(output))
    return code
  }
```

> 用动态 `import()` 而非顶层静态导入：知识内核只在 `--knowledge` 路径上加载，
> 普通会话启动不为它付模块解析成本（与既有 `--usage` 的 `runReadonly` 静态导入不同，
> 因为那个更轻且启动即用）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test kernel-tests/knowledge-cli.test.mjs`
Expected: PASS —— `# pass 9`

Run: `node --test kernel-tests/knowledge.test.mjs`
Expected: PASS —— `# pass 26`（未回归）

- [ ] **Step 6: 提交**

```bash
git add kernel/knowledge-cli.mjs kernel/cli.mjs kernel-tests/knowledge-cli.test.mjs
git commit -m "feat(knowledge): 内核 CLI 子命令 --knowledge <op>（10 个 op 聚合分发）"
```

---

### Task 10: `KnowledgeSearch` 工具

**Files:**
- Create: `kernel/knowledge-search.mjs`
- Modify: `kernel/tools.mjs`（注册工具 + `CHAT_MODE_DISALLOWED`）
- Test: `kernel-tests/knowledge-search.test.mjs`

**Interfaces:**
- Consumes: `createKnowledgeStore`
- Produces:
  - `searchKnowledge({ configDir, query, keywords?, spaces?, topK?, mode? }): { content: string, isError: boolean }`
  - 工具名 `KnowledgeSearch`，插在 `MemorySearch` 之后注册
  - `run(input)` 返回 `{ content, isError }`（与其他工具一致）

> **chat 模式**：S1 **保持** `KnowledgeSearch` 在 `CHAT_MODE_DISALLOWED` 中（与 `MemorySearch` 一致
> ——chat 是"纯联网会话，禁一切本地能力"）。S3 决策 D2 要"放行"，那是一次**有意的语义变更**，
> 需同时改 `kernel/tools.mjs` 与 `server/bridge.mjs` 两份表（`kernel-tests/chat-mode.test.mjs`
> 会做源码一致性比对），故不在 S1 顺手改。

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/knowledge-search.test.mjs`：

```js
// KnowledgeSearch 工具测试：只读检索，走临时 configDir 隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchKnowledge } from '../kernel/knowledge-search.mjs'
import { CHAT_MODE_DISALLOWED } from '../kernel/tools.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-ks-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', '---',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 四表的产品名称与收入口径必须对齐',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

test('searchKnowledge 返回可读条目清单（含来源与行号）', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: '四表联动', keywords: ['申报材料'] })
    assert.equal(r.isError, false)
    assert.match(r.content, /四表联动交叉校验/)
    assert.match(r.content, /experience\/workflow\.md/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge 无命中给出明确提示而非报错', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: 'zzzzz', keywords: ['zzzzz'] })
    assert.equal(r.isError, false)
    assert.match(r.content, /无.*命中|未命中/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge 空 query 返回 isError', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: '' })
    assert.equal(r.isError, true)
    assert.match(r.content, /query/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge 索引不可用时不抛异常（降级为无命中）', () => {
  const r = searchKnowledge({ configDir: '/definitely/not/here', query: '任意' })
  assert.equal(r.isError, false)
})

test('S1：KnowledgeSearch 与 MemorySearch 同列 chat 禁用表', () => {
  assert.ok(CHAT_MODE_DISALLOWED.includes('KnowledgeSearch'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kernel-tests/knowledge-search.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/knowledge-search.mjs'`

- [ ] **Step 3: 创建 `kernel/knowledge-search.mjs`**

```js
// kernel/knowledge-search.mjs —— KnowledgeSearch 工具的检索实现
// ---------------------------------------------------------------------------
// 与 MemorySearch 的关系：MemorySearch 是 S1 之前的条目级检索（每次全量读文件 + 全量
// 现算向量，O(N)）；KnowledgeSearch 走已建好的倒排索引，O(命中量)。S1 阶段两者并存
// （S3 才做收敛），但**接口语义对齐**：同样返回条目清单 + 文件路径供 Read 追全文。
import { createKnowledgeStore } from './knowledge.mjs'
import { makeSnippet } from '../shared/knowledge-core.mjs'

export function searchKnowledge({ configDir, query, keywords = [], spaces = null, topK = 5, mode = 'snippet' } = {}) {
  const q = String(query || '').trim()
  const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean)
  if (!q && !kws.length) {
    return { content: 'query 参数缺失：请描述想检索的知识主题', isError: true }
  }
  try {
    const store = createKnowledgeStore({ configDir })
    // 工具调用是同步契约（run 不返回 Promise）→ 用同步构建路径：store 的索引加载
    // 需要 await，这里改走"读盘 + 按需重建"的同步入口。
    store.load({})
    const qtext = q || kws.join(' ')
    const r = store.search({ query: q, keywords: kws, spaces, topK, mode })
    if (!r.count) {
      return {
        content: `知识库无「${qtext}」相关命中。可换关键词，或确认该主题尚未沉淀过内容。`,
        isError: false,
      }
    }
    const lines = r.items.map((it) => {
      const where = `${it.spaceId} › ${it.docId.split('/').slice(1).join('/')}${it.heading ? ` › ${it.heading}` : ''} · 第 ${it.line} 行`
      return `- [${where}] (${it.score.toFixed(2)}) ${makeSnippet(it.snippet, { maxLen: 300 })}`
    })
    return {
      content: `【相关知识检索】${r.count} 条命中（${new Set(r.items.map((i) => i.docId)).size} 篇文档）：\n${lines.join('\n')}`,
      isError: false,
    }
  } catch (e) {
    // 检索失败不能变成会话阻断：降级为"无命中"提示
    return { content: `知识库检索暂不可用（${e?.message || e}）。可直接用 Read 打开记忆文件。`, isError: false }
  }
}
```

> **为何 `load` 是同步的**：`store.load()` 内部无任何 `await`（`discoverSpaces`/`buildIndex`/
> `loadIndexFromDisk`/`indexStale` 全同步），而 `KnowledgeSearch.run()` 是**同步契约**
> ——故 Task 6 把 `load` 定义为非 async。`await store.load()` 对非 Promise 值依然合法，
> Task 7-9 测试里的 `await` 写法无需改动。

- [ ] **Step 4: 注册工具（改 `kernel/tools.mjs`）**

在 `MemorySearch` 条目**之后**（其 `run` 结束的 `},` 之后）插入：

```js
    // S1 知识检索：走已建索引的块级检索（比 MemorySearch 的 O(N) 全量扫描快得多），
    // 支持按空间过滤与 snippet/full 两档。S1 阶段与 MemorySearch 并存，S3 收敛。
    KnowledgeSearch: {
      description: '在知识库中做块级检索（本地索引，无网络）：可跨"个人经验/会话记忆/我的笔记/知识包"等空间，按语义+关键词命中到**单个知识块**（一条经验、一个标题段、一段正文）。返回命中清单（空间/文件/标题/行号/分数/摘要），需全文用 Read 读对应文件行。适合"知识库里有没有关于 X 的内容"类查询。spaces 可选限定空间；mode=full 返回整块原文。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索意图（自然语言，走向量匹配）' },
          keywords: { type: 'array', items: { type: 'string' }, description: '可选：精确关键词（走关键词路，适合专有名词/表名）' },
          spaces: { type: 'array', items: { type: 'string' }, description: '可选：限定空间 id 列表（见 /knowledge/spaces）' },
          topK: { type: 'number', description: '可选：返回条数上限（1-10，默认 5）' },
          mode: { type: 'string', description: "可选：'snippet'（默认，省上下文）| 'full'（整块原文）" },
        },
        required: ['query'],
      },
      run: (input) => {
        const q = String(input?.query ?? '').trim()
        if (!q) return { content: 'query 参数缺失：请描述想检索的知识主题', isError: true }
        return searchKnowledge({
          configDir: memoryRoot ? resolve(memoryRoot, '..') : '',
          query: q,
          keywords: Array.isArray(input?.keywords) ? input.keywords : [],
          spaces: Array.isArray(input?.spaces) && input.spaces.length ? input.spaces : null,
          topK: Math.min(Number(input?.topK) || 5, 10),
          mode: input?.mode === 'full' ? 'full' : 'snippet',
        })
      },
    },
```

以及在文件顶部补齐依赖（`memoryRoot` 是已有参数；`resolve` 需从 `node:path` 导入，若已导入则复用）：

```js
import { searchKnowledge } from './knowledge-search.mjs'
```

> `configDir` 的推导：`createToolRegistry` 已收到 `memoryRoot = <configDir>/memory/personal`
> （见 `kernel/cli.mjs` 的调用处），故 `<configDir>` = `resolve(memoryRoot, '..')`。
> 若实施时发现该推导与现实不符，改为给 `createToolRegistry` 增加 `configDir` 参数并透传
> （更显式，但要多改一处调用点）——**以实际值为准，不要猜**。

(b) `CHAT_MODE_DISALLOWED` 数组末尾追加 `'KnowledgeSearch'`：

```js
export const CHAT_MODE_DISALLOWED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'TodoWrite', 'OCR', 'Vision', 'Skill', 'SkillSearch', 'Workflow', 'Browser', 'MemorySearch', 'KnowledgeSearch']
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test kernel-tests/knowledge-search.test.mjs`
Expected: PASS —— `# pass 5`

- [ ] **Step 6: 提交**

```bash
git add kernel/knowledge-search.mjs kernel/tools.mjs kernel-tests/knowledge-search.test.mjs
git commit -m "feat(knowledge): KnowledgeSearch 工具（块级检索，索引化非 O(N)）"
```

---

### Task 11: server 路由（薄转发 + 文档写入）

**Files:**
- Create: `server/knowledge-routes.mjs`
- Test: `server/knowledge-routes.test.mjs`

**Interfaces:**
- Consumes: `kernelReadonly(argsList, opts): Promise<string>`（`server/kernel-readonly.mjs:59`，单飞去重、60s 超时、16MB 上限）
- Produces:
  - `handleKnowledgeRoute({ method, pathname, searchParams, readJsonBody, callKernel? }): Promise<{status, body}|null>`
    —— 命中返回结果，未命中返回 `null`（契约与 `handleLogsRoute` 一致，便于 bridge 串接）
  - `safeRelPath(rel: string): string|null`
  - `callKernel` **必须可注入**（默认 `kernelReadonly`）——测试用假实现，绝不起桥、不起内核进程

| 方法 | 路径 | 内核调用 |
|---|---|---|
| GET | `/knowledge/spaces` | `['--knowledge','spaces']` |
| GET | `/knowledge/tree` | `['--knowledge','tree','--space',s,'--path',p]` |
| GET | `/knowledge/doc` | `['--knowledge','doc','--id',id]` |
| GET | `/knowledge/entries` | `['--knowledge','entries','--id',id]` |
| GET | `/knowledge/search` | `['--knowledge','search','--query',q,'--keywords',k,'--topK',n,'--mode',m,'--space',sp]` |
| GET | `/knowledge/links` | `['--knowledge','links','--id',id]` |
| GET | `/knowledge/graph` | `['--knowledge','graph','--space',s,'--limit',n]` |
| GET | `/knowledge/stats` | `['--knowledge','stats']` |
| POST | `/knowledge/reindex` | `['--knowledge','reindex','--force']` |
| POST | `/knowledge/doc` | 先取 spaces 校验可写 → server 落盘 → `['--knowledge','update-doc','--id',docId]` |

> **为什么写入在 server 而检索在 kernel**：检索是只读且算法重，必须复用内核权威实现；
> 写入是"用户点了保存"的偶发动作，内容经 HTTP body 传入，走 kernel 子命令还要落临时文件再传参，
> 得不偿失。server 侧只保留**落盘 + 三重路径防护 + 触发增量索引**，不复制任何检索/切块逻辑。

- [ ] **Step 1: 写失败测试**

创建 `server/knowledge-routes.test.mjs`：

```js
// /knowledge/* 路由测试：**直调 handler + 注入假 callKernel**。
// 纪律：不起 bridge、不起内核子进程（本仓库有"测试起桥误杀运行中应用"的前车之鉴）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleKnowledgeRoute, safeRelPath } from './knowledge-routes.mjs'

function ctx({ method = 'GET', url = '/knowledge/spaces', body = null, callKernel } = {}) {
  const u = new URL(`http://x${url}`)
  return {
    method,
    pathname: u.pathname,
    searchParams: u.searchParams,
    readJsonBody: async () => body,
    callKernel: callKernel || (async () => '{}'),
  }
}

/** 假内核：把 argsList 记录在 calls 里，按预设应答 */
function fakeKernel(responses = {}) {
  const calls = []
  const fn = async (argsList) => {
    calls.push(argsList)
    const key = argsList.filter((a) => a.startsWith('--knowledge'))[0] + ':' + argsList[1]
    const val = responses[argsList[1]] ?? responses[key] ?? {}
    return typeof val === 'string' ? val : JSON.stringify(val)
  }
  fn.calls = calls
  return fn
}

test('未匹配路径返回 null（交给后续路由）', async () => {
  const r = await handleKnowledgeRoute(ctx({ url: '/files' }))
  assert.equal(r, null)
})

test('GET /knowledge/spaces 转发到内核并回传 spaces', async () => {
  const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'experience', docCount: 7, writable: true }] } })
  const r = await handleKnowledgeRoute(ctx({ callKernel }))
  assert.equal(r.status, 200)
  assert.equal(r.body.spaces[0].id, 'experience')
  assert.deepEqual(callKernel.calls[0], ['--knowledge', 'spaces'])
})

test('GET /knowledge/search 组装参数字典序（含 keywords 与 topK）', async () => {
  const callKernel = fakeKernel({ search: { items: [], count: 0, degraded: false, indexAge: 1 } })
  const r = await handleKnowledgeRoute(ctx({
    url: '/knowledge/search?q=%E5%9B%9B%E8%A1%A8&keywords=a,b&topK=3&mode=full&spaces=experience',
    callKernel,
  }))
  assert.equal(r.status, 200)
  const args = callKernel.calls[0]
  assert.equal(args[1], 'search')
  assert.equal(args[args.indexOf('--query') + 1], '四表')
  assert.equal(args[args.indexOf('--keywords') + 1], 'a,b')
  assert.equal(args[args.indexOf('--topK') + 1], '3')
  assert.equal(args[args.indexOf('--mode') + 1], 'full')
  assert.equal(args[args.indexOf('--space') + 1], 'experience')
})

test('内核报错时返回 500 且带 error 文案（不抛给调用方）', async () => {
  const callKernel = async () => { throw new Error('kernel boom') }
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/stats', callKernel }))
  assert.equal(r.status, 500)
  assert.match(String(r.body.error), /kernel boom/)
})

test('内核返回非 JSON 时返回 502（不把垃圾塞给前端）', async () => {
  const callKernel = async () => 'not json at all'
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/stats', callKernel }))
  assert.equal(r.status, 502)
})

test('safeRelPath 拒绝穿越/绝对路径/非 md，接受正常相对路径', () => {
  assert.equal(safeRelPath('a/b.md'), 'a/b.md')
  assert.equal(safeRelPath('a\\b.md'), 'a/b.md')
  assert.equal(safeRelPath('../etc/passwd.md'), null)
  assert.equal(safeRelPath('a/../../x.md'), null)
  assert.equal(safeRelPath('/abs/x.md'), null)
  assert.equal(safeRelPath('C:/x.md'), null)
  assert.equal(safeRelPath('a/b.txt'), null)
  assert.equal(safeRelPath(''), null)
})

test('POST /knowledge/doc 落盘到可写空间并触发增量索引', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-'))
  const spaceRoot = join(dir, 'spaces', 'notes')
  mkdirSync(spaceRoot, { recursive: true })
  try {
    const callKernel = fakeKernel({
      spaces: { spaces: [{ id: 'notes', writable: true, root: spaceRoot }] },
      'update-doc': { updated: true },
    })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'notes', path: 'sub/new.md', content: '# 新文档\n\n正文。\n' },
    }))
    assert.equal(r.status, 200)
    assert.equal(r.body.docId, 'notes/sub/new.md')
    assert.equal(readFileSync(join(spaceRoot, 'sub', 'new.md'), 'utf-8'), '# 新文档\n\n正文。\n')
    assert.ok(callKernel.calls.some((a) => a[1] === 'update-doc'), '触发增量更新')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/doc 对只读空间返回 403 且不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-ro-'))
  try {
    const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'pack-x', writable: false, root: dir }] } })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'pack-x', path: 'a.md', content: 'x' },
    }))
    assert.equal(r.status, 403)
    assert.ok(!existsSync(join(dir, 'a.md')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/doc 路径穿越返回 400/403 且不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-trav-'))
  const spaceRoot = join(dir, 'notes')
  mkdirSync(spaceRoot, { recursive: true })
  try {
    const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'notes', writable: true, root: spaceRoot }] } })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'notes', path: '../escaped.md', content: 'x' },
    }))
    assert.ok(r.status === 400 || r.status === 403)
    assert.ok(!existsSync(join(dir, 'escaped.md')), '未逃出空间根')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/doc 超限内容返回 413', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kr-big-'))
  const spaceRoot = join(dir, 'notes')
  mkdirSync(spaceRoot, { recursive: true })
  try {
    const callKernel = fakeKernel({ spaces: { spaces: [{ id: 'notes', writable: true, root: spaceRoot }] } })
    const r = await handleKnowledgeRoute(ctx({
      method: 'POST', url: '/knowledge/doc', callKernel,
      body: { spaceId: 'notes', path: 'a.md', content: 'x'.repeat(3 * 1024 * 1024) },
    }))
    assert.equal(r.status, 413)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /knowledge/reindex 走 force', async () => {
  const callKernel = fakeKernel({ reindex: { ok: true, docs: 4 } })
  const r = await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/reindex', callKernel }))
  assert.equal(r.status, 200)
  assert.deepEqual(callKernel.calls[0], ['--knowledge', 'reindex', '--force'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/knowledge-routes.test.mjs`
Expected: FAIL —— `Cannot find module './knowledge-routes.mjs'`

- [ ] **Step 3: 创建 `server/knowledge-routes.mjs`**

```js
// server/knowledge-routes.mjs —— /knowledge/* 桥路由
// ---------------------------------------------------------------------------
// 设计（spec §5.7）：读操作一律**薄转发**给内核（`--knowledge <op>`，经 kernel-readonly
// 单飞/超时/限流），server 不复制任何切块/检索逻辑——否则双端漂移无解。
// 唯一例外是"写文档"：内容经 HTTP body 传入，落盘在 server 侧完成（见下方 handleWriteDoc）。
//
// 契约与 server/logs-routes.mjs 一致：命中返回 { status, body }，未命中返回 null。
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { kernelReadonly } from './kernel-readonly.mjs'

const MAX_DOC_BYTES = 2 * 1024 * 1024

/** 路径净化：只允许"空间根内的相对 .md 路径"。这是穿越防护的第一、二道。 */
export function safeRelPath(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').trim()
  if (!s) return null
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null          // 绝对路径
  const parts = s.split('/').filter(Boolean)
  if (!parts.length) return null
  if (parts.some((p) => p === '..' || p === '.')) return null          // 上跳
  const last = parts[parts.length - 1]
  if (!/\.md$/i.test(last)) return null                                // 只收 md
  return parts.join('/')
}

const ok = (body) => ({ status: 200, body })

async function callJson(callKernel, argsList) {
  const raw = await callKernel(argsList)
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && v.error && Object.keys(v).length === 1) {
      return { error: v.error }
    }
    return { value: v }
  } catch {
    throw Object.assign(new Error('内核返回非 JSON'), { code: 502 })
  }
}

async function handleWriteDoc({ readJsonBody, callKernel }) {
  const body = (await readJsonBody()) || {}
  const spaceId = String(body.spaceId ?? '')
  const content = String(body.content ?? '')
  const rel = safeRelPath(body.path)
  if (!rel) return { status: 400, body: { error: 'invalid path（须为空间内相对 .md 路径）' } }
  if (Buffer.byteLength(content, 'utf-8') > MAX_DOC_BYTES) {
    return { status: 413, body: { error: 'document too large（上限 2MB）' } }
  }

  // 空间清单以内核为准（权威来源），server 不自己扫盘
  const sres = await callJson(callKernel, ['--knowledge', 'spaces'])
  const space = (sres.value?.spaces || []).find((s) => s.id === spaceId)
  if (!space) return { status: 404, body: { error: 'space not found' } }
  if (!space.writable) return { status: 403, body: { error: 'space is read-only' } }

  const root = resolve(String(space.root))
  const dest = resolve(root, rel)
  // 第三道：解析后仍在根内（覆盖 root 前缀相同但非子目录的边角，如 /a/notes-x）
  if (dest !== root && !dest.startsWith(root + sep)) {
    return { status: 403, body: { error: 'path escapes space root' } }
  }
  mkdirSync(dirname(dest), { recursive: true })
  // 第四道：符号链接防护——目标目录的 realpath 必须仍在 realpath(root) 内
  try {
    const rroot = realpathSync(root)
    const rdir = realpathSync(dirname(dest))
    if (rdir !== rroot && !rdir.startsWith(rroot + sep)) {
      return { status: 403, body: { error: 'path escapes space root (symlink)' } }
    }
  } catch { return { status: 500, body: { error: 'space root unreadable' } } }

  writeFileSync(dest, content, 'utf-8')
  const docId = `${spaceId}/${rel}`
  const upd = await callJson(callKernel, ['--knowledge', 'update-doc', '--id', docId])
  return ok({ ok: true, docId, updated: upd.value?.updated ?? false })
}

/**
 * 路由入口。`callKernel` 可注入（测试用假实现，避免起进程）。
 * 返回 { status, body } 或 null（未命中，交后续路由）。
 */
export async function handleKnowledgeRoute({
  method = 'GET', pathname = '', searchParams = new URLSearchParams(),
  readJsonBody = async () => ({}), callKernel = kernelReadonly,
} = {}) {
  if (!pathname.startsWith('/knowledge')) return null
  const p = pathname.replace(/\/+$/, '') || '/knowledge'
  const q = (name) => String(searchParams.get(name) ?? '')
  const isPost = String(method).toUpperCase() === 'POST'

  try {
    if (!isPost && p === '/knowledge/spaces') return ok((await callJson(callKernel, ['--knowledge', 'spaces'])).value)
    if (!isPost && p === '/knowledge/tree') {
      const args = ['--knowledge', 'tree', '--space', q('space')]
      if (q('path')) args.push('--path', q('path'))
      return ok((await callJson(callKernel, args)).value)
    }
    if (!isPost && p === '/knowledge/doc') return ok((await callJson(callKernel, ['--knowledge', 'doc', '--id', q('id')])).value)
    if (!isPost && p === '/knowledge/entries') return ok((await callJson(callKernel, ['--knowledge', 'entries', '--id', q('id')])).value)
    if (!isPost && p === '/knowledge/links') return ok((await callJson(callKernel, ['--knowledge', 'links', '--id', q('id')])).value)
    if (!isPost && p === '/knowledge/graph') {
      const args = ['--knowledge', 'graph']
      if (q('space')) args.push('--space', q('space'))
      if (q('limit')) args.push('--limit', q('limit'))
      return ok((await callJson(callKernel, args)).value)
    }
    if (!isPost && p === '/knowledge/stats') return ok((await callJson(callKernel, ['--knowledge', 'stats'])).value)
    if (!isPost && p === '/knowledge/search') {
      const args = ['--knowledge', 'search', '--query', q('q')]
      if (q('keywords')) args.push('--keywords', q('keywords'))
      if (q('topK')) args.push('--topK', q('topK'))
      if (q('mode')) args.push('--mode', q('mode'))
      if (q('spaces')) args.push('--space', q('spaces').split(',')[0])
      return ok((await callJson(callKernel, args)).value)
    }
    if (isPost && p === '/knowledge/reindex') return ok((await callJson(callKernel, ['--knowledge', 'reindex', '--force'])).value)
    if (isPost && p === '/knowledge/doc') return await handleWriteDoc({ readJsonBody, callKernel })
    return null
  } catch (e) {
    if (e?.code === 502) return { status: 502, body: { error: e.message } }
    return { status: 500, body: { error: e?.message || String(e) } }
  }
}
```

> **注**：提交前清理未使用的导入（本仓库**没有 lint 脚本**，`.mjs` 也不在 `typecheck` 覆盖内，
> 故只能人工核对）。上面若未用到 `statSync` / `join`，请从 import 行删掉。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/knowledge-routes.test.mjs`
Expected: PASS —— `# pass 12`

- [ ] **Step 5: 提交**

```bash
git add server/knowledge-routes.mjs server/knowledge-routes.test.mjs
git commit -m "feat(knowledge): /knowledge/* 路由——内核薄转发 + 四重路径防护的文档写入"
```

---

### Task 12: 接线（bridge + 打包 + 测试 glob）

**Files:**
- Modify: `server/bridge.mjs`（接路由一行 + `CHAT_MODE_DISALLOWED` 同步）
- Modify: `electron-builder.yml:24-36`
- Modify: `package.json`（`scripts.test`）
- Test: 既有 `server/*.test.mjs` + `kernel-tests/chat-mode.test.mjs`（源码一致性比对）

**Interfaces:**
- Consumes: `handleKnowledgeRoute`（Task 11）
- Produces: 打包产物含 `app/shared/`；`resources/kernel/cli.mjs` 可独立运行 `--knowledge stats`

- [ ] **Step 1: 写失败测试（打包清单断言）**

创建 `server/knowledge-packaging.test.mjs`：

```js
// 打包与接线契约测试：纯读文件断言，不启动任何进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8')

test('electron-builder files 含 shared/**/*（server 侧需要 ../shared）', () => {
  const yml = read('electron-builder.yml')
  assert.match(yml, /shared\/\*\*\/\*/, 'files 必须收录 shared/')
})

test('package.json 的 test glob 含 shared/**/*.test.mjs', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.scripts.test, /shared\/\*\*\/\*\.test\.mjs/)
})

test('bridge.mjs 已接入 handleKnowledgeRoute 且 import 正确', () => {
  const src = read('server/bridge.mjs')
  assert.match(src, /import \{ handleKnowledgeRoute \} from '\.\/knowledge-routes\.mjs'/)
  assert.match(src, /handleKnowledgeRoute\(\{/)
})

test('两份 CHAT_MODE_DISALLOWED 都含 KnowledgeSearch（chat 隔离一致）', () => {
  const bridge = read('server/bridge.mjs')
  const tools = read('kernel/tools.mjs')
  assert.match(tools, /CHAT_MODE_DISALLOWED[\s\S]{0,400}KnowledgeSearch/)
  assert.match(bridge, /KnowledgeSearch/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/knowledge-packaging.test.mjs`
Expected: FAIL —— `files 必须收录 shared/`

- [ ] **Step 3: 改三个接线点**

(a) `electron-builder.yml` 的 `files:` 列表中加入（放在 `- server/**/*` 之后）：

```yaml
    - shared/**/*
```

(b) `package.json` 的 `scripts.test` 加入 shared：

```json
    "test": "node --test \"shared/**/*.test.mjs\" \"server/*.test.mjs\" \"electron/*.test.mjs\" \"kernel-tests/*.test.mjs\" \"src/**/*.test.ts\"",
```

（保留既有各项不变，只在其首插入 `"shared/**/*.test.mjs"`。）

(c) `server/bridge.mjs`：顶部 import 区（紧接 `import { handleLogsRoute } from './logs-routes.mjs'` 之后）加：

```js
import { handleKnowledgeRoute } from './knowledge-routes.mjs'
```

并在 logs 路由接续处（`const logsRes = handleLogsRoute({ ... })` 那个 `if` 之后）加：

```js
  // 知识库路由（S1）：读操作经 kernel-readonly 薄转发，写文档由路由内落盘
  {
    const knowledgeRes = await handleKnowledgeRoute({
      method: req.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      readJsonBody,
    })
    if (knowledgeRes) {
      reply.writeHead(knowledgeRes.status, { 'content-type': 'application/json; charset=utf-8' })
      reply.end(JSON.stringify(knowledgeRes.body))
      return
    }
  }
```

(d) `server/bridge.mjs` 的 `CHAT_DISALLOWED` 数组末尾加 `'KnowledgeSearch'`（与 `kernel/tools.mjs`
保持逐项一致，`kernel-tests/chat-mode.test.mjs` 会做源码比对）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/knowledge-packaging.test.mjs && node --test kernel-tests/chat-mode.test.mjs`
Expected: PASS —— 两个文件全绿

Run: `npm test`
Expected: 全绿（`shared/`、`server/`、`kernel-tests/` 三段都在）

- [ ] **Step 5: 提交**

```bash
git add server/bridge.mjs server/knowledge-packaging.test.mjs electron-builder.yml package.json
git commit -m "feat(knowledge): 接线——bridge 路由/打包收录 shared/测试 glob/chat 禁用表同步"
```

---

### Task 13: 双端对拍与端到端验收

**Files:**
- Create: `kernel-tests/knowledge-parity.test.mjs`
- Test: 全量 `npm test` + 构建产物冒烟

**Interfaces:**
- Consumes: `createKnowledgeStore`（内核直调路径）、`node kernel/cli.mjs --knowledge <op>`（子进程路径，即 server 实际走的通道）
- Produces: 无新导出（纯验证）

> **为什么对拍的是"内核直调 vs 内核 CLI 子进程"**：server 侧**没有**自己的检索实现，
> 它的 `/knowledge/search` 完全等于 `kernelReadonly(['--knowledge','search',...])` 的 stdout。
> 所以真正的漂移风险点是 **CLI 参数组装 + JSON 序列化往返**，而不是两套算法。
> 本测试把这个往返钉死；算法内部的漂移由 Task 1-3 的 shared 单测覆盖。

- [ ] **Step 1: 写对拍测试**

创建 `kernel-tests/knowledge-parity.test.mjs`：

```js
// 对拍：内核直调 vs CLI 子进程（server 实际通道）——top-5 blockId 序列必须逐位相同。
// 隔离：子进程通过 PONOS_HOME 指向临时目录（resolveConfigDir 的 env 优先级：
// CLAUDE_CONFIG_DIR → PONOS_HOME → ~/.ponos），与真实用户数据完全隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

const CLI = new URL('../kernel/cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kpar-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流心得', '---',
    '## 申报材料',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 的产品名称与收入口径必须对齐',
    '- [会话|申报材料] 建表前先冻结口径 -- 收入口径变更导致返工，先冻结再出表',
    '## 企微CLI化',
    '- [会话|企微CLI化] 只发文件传输助手 -- 真实沟通渠道的测试只发文件传输助手',
  ].join('\n') + '\n', 'utf-8')
  writeFileSync(join(personal, 'policy.md'), [
    '---', 'name: policy', '---',
    '- [会话|高企口径] RD表与PS表技术关联 -- 需说明研发项目与产品之间的技术关联',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

function runCli(dir, argsList) {
  // 必须带 stream-json 两个标志：`--knowledge` 短路块在 cli.mjs 的格式校验（L203）**之后**，
  // 缺这两个标志会直接 `kernel: only stream-json I/O format is supported` 退出。
  // 这也正是 server 侧 kernelReadonly 的实际调用形状（server/kernel-readonly.mjs:41）。
  const out = execFileSync(process.execPath, [
    CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', '--knowledge', ...argsList,
  ], {
    env: { ...process.env, PONOS_HOME: dir, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf-8',
    timeout: 60000,
  })
  return JSON.parse(out)
}

const QUERIES = [
  { query: '四表联动交叉校验', keywords: ['申报材料'] },
  { query: '收入口径', keywords: [] },
  { query: '文件传输助手', keywords: ['企微CLI化'] },
]

test('对拍：直调与 CLI 子进程的 top-5 blockId 序列逐位一致', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    for (const q of QUERIES) {
      const direct = store.search({ ...q, topK: 5 })
      const cliOut = runCli(dir, ['search', '--query', q.query, '--keywords', q.keywords.join(','), '--topK', '5'])
      const directIds = direct.items.map((i) => i.blockId)
      const cliIds = cliOut.items.map((i) => i.blockId)
      assert.deepEqual(cliIds, directIds, `查询「${q.query}」双端不一致`)
      assert.equal(cliOut.count, direct.count)
      assert.equal(cliOut.degraded, direct.degraded)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对拍：CLI 的 spaces / stats / entries 与直调一致', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    const cliSpaces = runCli(dir, ['spaces'])
    assert.deepEqual(
      cliSpaces.spaces.map((s) => [s.id, s.docCount]),
      store.getSpaces().map((s) => [s.id, s.docCount]),
    )
    const cliStats = runCli(dir, ['stats'])
    assert.equal(cliStats.docs, store.stats().docs)
    assert.equal(cliStats.blocks, store.stats().blocks)

    const cliEntries = runCli(dir, ['entries', '--id', 'experience/workflow.md'])
    assert.deepEqual(
      cliEntries.entries.map((e) => e.summary),
      store.listEntries('experience/workflow.md').map((e) => e.summary),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对拍：删除 .index 后重建，结果与删除前完全一致（索引可弃）', () => {
  const dir = fixture()
  try {
    const first = (() => {
      const s = createKnowledgeStore({ configDir: dir })
      s.load({ force: true })
      return s.search({ query: '收入口径', topK: 5 }).items.map((i) => i.blockId)
    })()
    rmSync(join(dir, 'knowledge', '.index'), { recursive: true, force: true })
    const second = (() => {
      const s = createKnowledgeStore({ configDir: dir })
      s.load() // 无 force：索引缺失应自动重建
      return s.search({ query: '收入口径', topK: 5 }).items.map((i) => i.blockId)
    })()
    assert.deepEqual(second, first)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行对拍测试**

Run: `node --test kernel-tests/knowledge-parity.test.mjs`
Expected: PASS —— `# pass 3`（若 blockId 序列不一致，先查 CLI 参数组装是否漏了 `--keywords`）

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 全绿，且输出中同时出现 `shared/`、`server/`、`kernel-tests/` 三处用例

- [ ] **Step 4: 类型与前端构建**

Run: `npm run typecheck && npm run build`
Expected: 均无错误（本任务未改 TS，此步是防回归）

- [ ] **Step 5: 内核单文件打包冒烟**

```bash
node scripts/build-kernel.mjs
node -e "const s=require('fs').readFileSync('kernel-dist/cli.mjs','utf8');if(/from ['\"]\/(?!node:)/.test(s)) throw new Error('bundle 出现非 node: 外部依赖');console.log('bundle OK',s.length,'bytes')"
```

Expected: `bundle OK <N> bytes`（若报错，说明 `shared/knowledge-core.mjs` 未被内联——
检查它是否被 `--external` 命中，或路径是否写成了一级 `../shared/`）

Run: `PONOS_HOME=<临时目录> node kernel-dist/cli.mjs --output-format stream-json --input-format stream-json --knowledge stats`
Expected: 输出 `{"version":1,...}` 的 JSON（**这条是 shared/ 进 bundle 的最终证据**）

- [ ] **Step 6: 打包产物验证（可选，需 electron-builder）**

Run: `npm run build:electron:dir`
Expected: 产物 `<release>/win-unpacked/resources/app/shared/knowledge-core.mjs` 存在
Run: `node resources/kernel/cli.mjs --output-format stream-json --input-format stream-json --knowledge stats`（在产物目录内）
Expected: 正常输出 JSON（证明 `mirrorKernelParentDeps` 把 `runtime/shared/` 镜像到位）

- [ ] **Step 7: 提交**

```bash
git add kernel-tests/knowledge-parity.test.mjs
git commit -m "test(knowledge): 双端对拍——CLI 往返 top-5 一致 + 索引可弃可重建"
```

---

## 完成定义（S1）

全部勾选即 S1 交付完成（对应 spec §8 验收标准）：

- [ ] 6 类块切分正确，`line` 可回溯原文（Task 1）
- [ ] 经验空间可按**单条经验**检索（Task 7）
- [ ] 中文 bigram 与英文词查询均有效（Task 7）
- [ ] 删除 `.index/` 后自动重建且结果一致（Task 13）
- [ ] 文档变更后自动/增量可见（Task 6 mtime、Task 8 增量）
- [ ] 只读空间写入被拒（Task 11：403）
- [ ] 路径穿越（`../`/绝对路径/符号链接）全部被拒（Task 11：四道防护）
- [ ] 对拍测试绿（Task 13）
- [ ] `npm test` 全绿（Task 12-13）
- [ ] 打包产物含 `shared/`，内核 CLI 可独立运行（Task 13 Step 5-6）

**S1 之后的独立任务**（不在本计划内）：
1. 经验文件物理迁移（spec §12）；
2. S2 知识 GUI（第 7 个 rail）；
3. S3 AI 集成闭环（注入收敛 + 灰度开关 + 会话记忆纳入）；
4. S4 生态分发（知识包市场）。

## 回退方案

S1 不改变任何既有行为（纯新增 + Task 4 的等价搬运），故回退极为简单：

| 想回退的部分 | 操作 |
|---|---|
| 全部 | `git revert` 本计划的提交区间；`.index/` 可直接删除（派生物） |
| 仅 GUI/AI 侧 | 不接 `bridge.mjs` 的路由即可（Task 12 的一处块） |
| 仅 Task 4 的搬运 | `git revert` 该提交，`shared/` 保留但不再被 kernel 引用 |
| 索引占用磁盘 | `rm -rf <configDir>/knowledge/.index`（下次检索自动重建） |
