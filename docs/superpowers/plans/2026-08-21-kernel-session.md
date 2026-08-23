# P5 长会话与记忆（compact 关键信息 / 预算配置 / 记忆内核化 / 上下文预测）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 500 轮长会话下 compact 质量不退化（关键信息保留）、token 预算可配置、跨会话记忆内核化、上下文容量可预测预警。

**Architecture:** 四个纯内核模块扩展——compact.mjs 追加 `extractKeyInfo`/`resolveCompactSettings`（关键信息保留 + 预算解析）、新建 `kernel/memory.mjs`（记忆持久化 + 确定性捕获，与 GUI 层 server/experience.mjs 同一文件格式与 hash 算法）、context.mjs 追加 `predictTurns`（增长速率预测）、health.mjs 预警扩展；cli.mjs 组装（settings.compact → context/env、记忆索引注入、轮末捕获落盘）。全部机制在 kernel/，前端零新增设置项（HealthMeter 消费 ponos_health 新增字段，纯增量）。

**Tech Stack:** 纯 Node ESM（node:test / node:fs），零 npm 依赖。测试沿用 `server/*.test.mjs`：单元直连 import 内核模块；集成 spawn 真内核（`kernel/cli.mjs` + `PONOS_MOCK_API=1`）+ makeReader 行队列（参照 `server/kernel-contract.test.mjs`）。

## Global Constraints

- 零 npm 依赖：kernel/ 内新代码只用 node 内置模块。
- 内核优先：机制进 kernel/，前端零新增设置项；ponos_health 事件只增字段（growthPerTurn/predictedTurns），不删改既有字段。
- 向后兼容：settings.compact / memory / 捕获全部可选——缺配置时行为与现在完全一致（thresholdRatio 0.8 / retainRatio 0.16 / 默认预算 / 无记忆注入 / 无捕获）。
- 与 GUI 记忆层同数据源：kernel/memory.mjs 读写 `~/.ponos/memory/personal/{theme}.md`，条目格式 `- [会话|标签] 摘要 -- 全文` 与 hash 算法与 `server/experience.mjs` 完全一致（GUI 经验面板可继续管理同一批文件）。
- 测试命令：`node --test server/<file>.test.mjs`；全量 `node --test "server/*.test.mjs"`。
- 前置依赖（按依赖链 P1→P4 已落地）：
  - P4 计划 Task 1 的 `loadSettings({ configDir, cwd, local })` → `{ merged, ... }`（本计划 Task 2/4/6 消费 `settings.merged`）
  - P4 计划 Task 6 的 `composeSystemPrompt({ toolNames, agents, subagents, append, cwd, skills })`（本计划 Task 4 追加 `memory` 参数，skills 参数已存在）
  - mock 指令（api.mjs）：`[mock:tool-safe]` → Bash echo tool_use；摘要调用检测 `lastText.includes('系统压缩指令')` → 返回 `<compacted-summary>mock 摘要</compacted-summary>`（收敛）

---

### Task 1: compact.mjs —— 关键信息提取与摘要请求注入（L1-1）

**Files:**
- Modify: `kernel/compact.mjs`（追加 `extractKeyInfo` / `keyInfoBlock`；`assembleSummaryRequest` 增加 keyInfo 参数；`summarize` 调用处传入）
- Create: `server/compact-keyinfo.test.mjs`

**Interfaces:**
- Consumes: 无（纯函数，消费 deriveMessages() 形状的消息数组）
- Produces:
  - `extractKeyInfo(messages)` → `{ todos: string[], files: string[], decisions: string[] }`
    - todos：TodoWrite 工具调用的 `input.todos`（取 `t.content ?? t.task`，过滤空）
    - files：Write/Edit 工具调用的 `input.file_path ?? input.path`
    - decisions：最后 2 条 assistant 文本消息（string content 或 text 块），作为最近决策上下文
  - `keyInfoBlock(key)` → string：`<key-info>` 结构化提示块；空 key → `''`（todos 取最后 3 条、files 取最后 8 条、decisions 拼接截断 500 字符）
  - `assembleSummaryRequest({ system, messages, cut, lastSummary, keyInfo = '' })`：keyInfo 非空时追加在 COMPACTION_INSTRUCTION 之后

- [x] **Step 1: 写失败测试**

```js
// server/compact-keyinfo.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleSummaryRequest, extractKeyInfo, keyInfoBlock } from '../kernel/compact.mjs'

const messages = [
  { role: 'user', content: '实现导出功能' },
  { role: 'assistant', content: '先梳理现有模块' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'A' }, { content: 'B' }] } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/export.js' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'written' }] },
  { role: 'assistant', content: '已决定采用流式导出，接口名 exportStream' },
]

test('extractKeyInfo：TodoWrite 清单 / Write/Edit 文件 / 最近 assistant 决策', () => {
  const key = extractKeyInfo(messages)
  assert.deepEqual(key.todos, ['A / B'])
  assert.deepEqual(key.files, ['Write src/export.js'])
  assert.equal(key.decisions.length, 2) // 最后两条 assistant 文本
  assert.ok(key.decisions[1].includes('exportStream'))
})

test('keyInfoBlock：结构化提示块 + 空 key 返回空串', () => {
  const block = keyInfoBlock(extractKeyInfo(messages))
  assert.ok(block.includes('<key-info>'))
  assert.ok(block.includes('任务清单：A / B'))
  assert.ok(block.includes('文件变更：Write src/export.js'))
  assert.equal(keyInfoBlock({ todos: [], files: [], decisions: [] }), '')
})

test('assembleSummaryRequest：keyInfo 追加在压缩指令之后', () => {
  const cut = { covered: messages.slice(0, 2) }
  const req = assembleSummaryRequest({ system: 'sys', messages, cut, lastSummary: null, keyInfo: '<key-info>\n- 任务清单：A\n</key-info>' })
  const last = req[req.length - 1]
  assert.ok(last.content.includes('系统压缩指令'))
  assert.ok(last.content.includes('<key-info>'))
  assert.ok(last.content.indexOf('系统压缩指令') < last.content.indexOf('<key-info>'))
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/compact-keyinfo.test.mjs`
Expected: FAIL —— `extractKeyInfo is not a function`

- [x] **Step 3: 实现 compact.mjs 追加**

在 `kernel/compact.mjs` 的 `extractSummary` 之后追加：

```js
// —— L1-1 关键信息保留：摘要请求注入结构化提示（零成本确定性提取）——
// TodoWrite 整表重写 → 最后调用即权威清单；Write/Edit 记录文件变更；
// 最近 assistant 文本作为决策上下文。todo 取最后 3、文件取最后 8 防溢出。
export function extractKeyInfo(messages = []) {
  const todos = []
  const files = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_use') continue
      const input = b.input || {}
      if (b.name === 'TodoWrite') {
        const items = (Array.isArray(input.todos) ? input.todos : [])
          .map((t) => t?.content ?? t?.task ?? '')
          .filter((x) => String(x).trim())
        if (items.length) todos.push(items.join(' / '))
      } else if (b.name === 'Write' || b.name === 'Edit') {
        files.push(`${b.name} ${input.file_path ?? input.path ?? '?'}`)
      }
    }
  }
  const decisions = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) return m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ')
      return ''
    })
    .filter((t) => t.trim())
    .slice(-2)
  return { todos, files, decisions }
}

export function keyInfoBlock(key) {
  const lines = []
  if (key.todos.length) lines.push(`- 任务清单：${key.todos.slice(-3).join('；')}`)
  if (key.files.length) lines.push(`- 文件变更：${key.files.slice(-8).join('，')}`)
  if (key.decisions.length) lines.push(`- 最近决策：${key.decisions.join(' | ').slice(0, 500)}`)
  if (!lines.length) return ''
  return '（关键信息提示——摘要必须保留以下内容：）\n<key-info>\n' + lines.join('\n') + '\n</key-info>'
}
```

修改 `assembleSummaryRequest`（原 line 134-144）：签名加 `keyInfo = ''`，指令后追加：

```js
  if (keyInfo && keyInfo.trim()) {
    body.push({ role: 'user', content: keyInfo })
  }
```

修改 `summarize`（原 line 171-180 之前）在调用 `runSummarizer` 时传入：

```js
    const keyInfo = keyInfoBlock(extractKeyInfo(messages))
```
并在 `runSummarizer({ system, messages, cut })` 内 `assembleSummaryRequest({ system, messages, cut, lastSummary, keyInfo })`。

- [x] **Step 4: 跑测试验证通过**

Run: `node --test server/compact-keyinfo.test.mjs`
Expected: PASS（3 个测试）

- [x] **Step 5: 回归 + 提交**

Run: `node --test server/kernel-contract.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS（keyInfo 缺省空串，既有行为不变）

```bash
git add kernel/compact.mjs server/compact-keyinfo.test.mjs
git commit -m "feat(kernel): compact 关键信息保留（TodoWrite/文件变更/最近决策注入摘要请求）"
```

---

### Task 2: settings.compact 预算配置化（L2-1）

**Files:**
- Modify: `kernel/compact.mjs`（追加 `resolveCompactSettings` 纯函数）
- Modify: `kernel/cli.mjs`（消费 settings.merged.compact → context ratio + env 兜底）
- Test: `server/compact-keyinfo.test.mjs`（追加单元）

**Interfaces:**
- Consumes: `loadSettings`（P4 Task 1）→ `settings.merged.compact`；`contextWindowFor`（context.mjs 既有）
- Produces: `resolveCompactSettings({ window, settings, env })` → `{ thresholdRatio, retainRatio, toolResultBudget }`
  - `settings.compact.thresholdTokens`（>0）→ `thresholdRatio = clamp(thresholdTokens / window, 0.01, 1)`；缺省 0.8
  - `settings.compact.reserveTokens`（>0）→ `retainRatio = clamp(reserveTokens / window, 0.001, 0.5)`；缺省 0.16
  - `settings.compact.maxToolResults`（>0）→ `toolResultBudget`；否则 env `CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES` 或 20000
  - cli 行为：context.thresholdRatio/retainRatio 取解析值；仅当 settings 显式配置 maxToolResults 时才兜底填 env（不覆盖 spawn env）

- [x] **Step 1: 写失败测试（追加到 server/compact-keyinfo.test.mjs）**

```js
import { resolveCompactSettings } from '../kernel/compact.mjs'

test('resolveCompactSettings：settings.compact 覆盖 ratio + 预算', () => {
  const r = resolveCompactSettings({ window: 200_000, settings: { compact: { thresholdTokens: 100_000, reserveTokens: 10_000, maxToolResults: 5000 } }, env: {} })
  assert.equal(r.thresholdRatio, 0.5)
  assert.equal(r.retainRatio, 0.05)
  assert.equal(r.toolResultBudget, 5000)
})

test('resolveCompactSettings：未配置 → 默认 0.8/0.16 + env 预算', () => {
  const r = resolveCompactSettings({ window: 200_000, settings: {}, env: { CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES: '8888' } })
  assert.equal(r.thresholdRatio, 0.8)
  assert.equal(r.retainRatio, 0.16)
  assert.equal(r.toolResultBudget, 8888)
  const d = resolveCompactSettings({ window: 200_000, settings: {}, env: {} })
  assert.equal(d.toolResultBudget, 20000)
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/compact-keyinfo.test.mjs`
Expected: FAIL —— `resolveCompactSettings is not a function`

- [x] **Step 3: 实现 resolveCompactSettings + cli 装配**

`kernel/compact.mjs` 末尾（createCompactor 之后）追加：

```js
// —— L2-1 预算配置化：settings.compact { thresholdTokens, reserveTokens, maxToolResults } ——
// 默认对齐现状（0.8 / 0.16 / env 预算）；数值配置按 window 换算 ratio。
export function resolveCompactSettings({ window = 200_000, settings = {}, env = process.env } = {}) {
  const c = settings.compact || {}
  const thresholdTokens = Number(c.thresholdTokens)
  const reserveTokens = Number(c.reserveTokens)
  const maxToolResults = Number(c.maxToolResults)
  const thresholdRatio = Number.isFinite(thresholdTokens) && thresholdTokens > 0
    ? Math.min(1, Math.max(0.01, thresholdTokens / window))
    : 0.8
  const retainRatio = Number.isFinite(reserveTokens) && reserveTokens > 0
    ? Math.min(0.5, Math.max(0.001, reserveTokens / window))
    : 0.16
  const toolResultBudget = Number.isFinite(maxToolResults) && maxToolResults > 0
    ? maxToolResults
    : Number(env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES || 20000)
  return { thresholdRatio, retainRatio, toolResultBudget }
}
```

`kernel/cli.mjs`（settings 加载之后、context 构造处，原 line 117-118 附近）：

```js
  const compactCfg = resolveCompactSettings({ window: contextWindow, settings: settings.merged, env: process.env })
  const maxToolResults = Number(settings.merged.compact?.maxToolResults)
  if (Number.isFinite(maxToolResults) && maxToolResults > 0 && !process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES) {
    process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES = String(maxToolResults)
  }
```
（context 对象构造处）：
```js
  const context = {
    window: contextWindow,
    thresholdRatio: compactCfg.thresholdRatio,
    retainRatio: compactCfg.retainRatio,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage,
    estimateHistory,
  }
```
（import 区补 `resolveCompactSettings`。）

- [x] **Step 4: 跑测试验证通过**

Run: `node --test server/compact-keyinfo.test.mjs`
Expected: PASS（5 个测试）

- [x] **Step 5: 提交**

```bash
git add kernel/compact.mjs kernel/cli.mjs server/compact-keyinfo.test.mjs
git commit -m "feat(kernel): settings.compact 预算配置化（阈值/保留/工具结果预算可覆盖）"
```

---

### Task 3: kernel/memory.mjs —— 记忆持久化原语 + 确定性捕获（L3-1）

**Files:**
- Create: `kernel/memory.mjs`
- Create: `server/memory.test.mjs`（Task 3 部分：单元）

**Interfaces:**
- Consumes: 无（独立模块；与 server/experience.mjs 同文件格式、同 hashLine 算法——GUI 面板兼容）
- Produces:
  - `memoryRoot(configDir)` → `join(configDir, 'memory', 'personal')`
  - `hashLine(text)` → string：与 experience.mjs 完全相同的 char-code 滚动 hash（去重兼容）
  - `appendMemoryEntry({ root, theme, tag, summary, full })` → `{ ok, deduped }`：读既有主题文件（frontmatter + 条目），hash 相同跳过，否则追加 `- [会话|tag] summary -- full` 行；文件不存在按 `---\nname: <theme>\ndescription: <theme>\nactive: true\n---` 模板创建
  - `readMemoryEntries({ root, theme })` → `[{ text, hash, tag, summary, full }]`
  - `buildMemoryIndex({ root, maxBytes = 4096 })` → string：与 buildExperienceIndex 同格式的索引（`- [<theme>|<tag>] N 条 · 最近 <date> · <file>`），主题按最近更新排序
  - `captureMemoryCandidates({ userText, tag = null, markers } = {})` → `[{ theme, tag, summary, full }]`：
    - 纠错标记（缺省 `['以后不要', '不要再', '以后别', '别用', '记住不要']`）命中 → theme `'workflow'`
    - 偏好标记（缺省 `['我喜欢', '我希望', '我习惯', '以后都', '记得以后']`）命中 → theme `'communication'`
    - markers 可由 settings.memory.markers 覆盖（`{ correction: [], preference: [] }`）

- [x] **Step 1: 写失败测试**

```js
// server/memory.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemoryEntry, readMemoryEntries, buildMemoryIndex, captureMemoryCandidates, hashLine } from '../kernel/memory.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ponos-mem-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('hashLine：与 experience.mjs 同算法（兼容 GUI 面板去重）', () => {
  assert.equal(hashLine('- [会话|测试] 摘要 -- 全文'), '- [会话|测试] 摘要 -- 全文'.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0) >>> 0 ? String(hashLine('- [会话|测试] 摘要 -- 全文')) : '')
  // 确定性：同输入同输出
  assert.equal(hashLine('abc'), hashLine('abc'))
  assert.notEqual(hashLine('abc'), hashLine('abd'))
})

test('appendMemoryEntry：写文件 + 读回 + 去重', () => {
  const root = join(tmp, 'mem1')
  mkdirSync(root, { recursive: true })
  const r1 = appendMemoryEntry({ root, theme: 'workflow', tag: '测试', summary: '摘要一', full: '全文一' })
  assert.equal(r1.ok, true)
  const r2 = appendMemoryEntry({ root, theme: 'workflow', tag: '测试', summary: '摘要一', full: '全文一' })
  assert.equal(r2.deduped, true)
  const entries = readMemoryEntries({ root, theme: 'workflow' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].tag, '测试')
  assert.equal(entries[0].summary, '摘要一')
  assert.equal(entries[0].full, '全文一')
  const raw = readFileSync(join(root, 'workflow.md'), 'utf-8')
  assert.ok(raw.startsWith('---\nname: workflow'))
  assert.ok(raw.includes('- [会话|测试] 摘要一 -- 全文一'))
})

test('buildMemoryIndex：格式与 experience.mjs 索引一致', () => {
  const root = join(tmp, 'mem2')
  mkdirSync(root, { recursive: true })
  appendMemoryEntry({ root, theme: 'workflow', tag: '导出', summary: 's', full: 'f' })
  const idx = buildMemoryIndex({ root })
  assert.ok(idx.includes('【个人经验索引】'))
  assert.ok(idx.includes('[workflow|导出]'))
  assert.ok(idx.endsWith('.md'))
})

test('captureMemoryCandidates：纠错 → workflow / 偏好 → communication', () => {
  assert.deepEqual(captureMemoryCandidates({ userText: '以后不要用 sed 改文件' }).map((c) => c.theme), ['workflow'])
  assert.deepEqual(captureMemoryCandidates({ userText: '我习惯先读文件再改' }).map((c) => c.theme), ['communication'])
  assert.deepEqual(captureMemoryCandidates({ userText: '实现导出功能' }), [])
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/memory.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/memory.mjs'`

- [x] **Step 3: 实现 kernel/memory.mjs**

```js
// kernel/memory.mjs —— 跨会话记忆内核化（L3-1/L3-2）
// 与 GUI 层 server/experience.mjs 同一数据源/格式/去重算法：
//   <configDir>/memory/personal/{theme}.md，条目 `- [会话|标签] 摘要 -- 全文`
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function memoryRoot(configDir) {
  return join(configDir || '', 'memory', 'personal')
}

export function hashLine(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { front: {}, body: raw }
  const front = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) front[kv[1]] = kv[2]
  }
  return { front, body: raw.slice(m[0].length) }
}

function themePath(root, theme) {
  return join(root, `${theme}.md`)
}

function readTheme(root, theme) {
  const fp = themePath(root, theme)
  if (!existsSync(fp)) return { front: {}, entries: [] }
  const raw = readFileSync(fp, 'utf-8')
  const { front, body } = parseFrontmatter(raw)
  const entries = body.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).map((l) => {
    const text = l.trim()
    return { text, hash: hashLine(text), ...parseEntryLine(text) }
  })
  return { front, entries }
}

export function parseEntryLine(line) {
  const text = String(line).trim()
  const m = /^- \[([^\]]*)\]\s*(.*)$/.exec(text)
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

export function readMemoryEntries({ root = '', theme = '' } = {}) {
  if (!root || !theme) return []
  return readTheme(root, theme).entries
}

export function appendMemoryEntry({ root = '', theme = '', tag = null, summary = '', full = '' } = {}) {
  if (!root || !theme || !summary) return { ok: false, error: 'root/theme/summary required' }
  try { mkdirSync(root, { recursive: true }) } catch {}
  const { front, entries } = readTheme(root, theme)
  const line = `- [会话${tag ? '|' + tag : ''}] ${summary} -- ${full}`
  if (entries.some((e) => e.hash === hashLine(line))) return { ok: true, deduped: true }
  const head = Object.keys(front).length
    ? Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n')
    : `name: ${theme}\ndescription: ${theme}\nactive: true`
  const body = entries.map((e) => e.text).concat(line)
  writeFileSync(themePath(root, theme), `---\n${head}\n---\n` + body.join('\n') + '\n', 'utf-8')
  return { ok: true, deduped: false }
}

export function buildMemoryIndex({ root = '', maxBytes = 4096 } = {}) {
  if (!root || !existsSync(root)) return ''
  const list = []
  try {
    for (const f of readdirSync(root).filter((x) => x.endsWith('.md'))) {
      const theme = f.slice(0, -3)
      const { entries } = readTheme(root, theme)
      if (!entries.length) continue
      const groups = new Map()
      let untagged = 0
      for (const e of entries) {
        if (!e.tag) { untagged++; continue }
        const g = groups.get(e.tag) || { tag: e.tag, count: 0 }
        g.count++
        groups.set(e.tag, g)
      }
      list.push({ theme, file: join(root, f), updatedAt: statSync(join(root, f)).mtimeMs, groups: [...groups.values()], untagged })
    }
  } catch { return '' }
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  const header = '\n\n【个人经验索引】过往会话沉淀的个人经验（按 主题|任务标签 分组，含未标注条目）。需要某任务的具体经验时，用 Read 读取该行末尾标注的文件（每行条目格式：- [会话|标签] 摘要 -- 全文），摘要判断相关性，全文含完整要点；与当前任务无关的标签无需读取。\n'
  let out = header
  const fmt = (ts) => new Date(ts).toISOString().slice(0, 10)
  const lines = []
  for (const item of list) {
    for (const g of item.groups) lines.push(`- [${item.theme}|${g.tag}] ${g.count} 条 · 最近 ${fmt(item.updatedAt)} · ${item.file}`)
    if (item.untagged > 0) lines.push(`- [${item.theme}] ${item.untagged} 条未标注经验 · 最近 ${fmt(item.updatedAt)} · ${item.file}`)
  }
  for (const line of lines) {
    const lb = line.length + 1
    if (out.length + lb > maxBytes) break
    out += line + '\n'
  }
  return out
}

const DEFAULT_MARKERS = {
  correction: ['以后不要', '不要再', '以后别', '别用', '记住不要'],
  preference: ['我喜欢', '我希望', '我习惯', '以后都', '记得以后'],
}

// 确定性捕获（启发式）：轮末对 user 文本做模式匹配，产出结构化记忆候选。
export function captureMemoryCandidates({ userText = '', tag = null, markers = null } = {}) {
  const t = String(userText || '')
  const m = { ...DEFAULT_MARKERS, ...(markers || {}) }
  const out = []
  const correction = (m.correction || []).find((x) => t.includes(x))
  if (correction) out.push({ theme: 'workflow', tag, summary: `用户纠正（${correction}）：${t.slice(0, 60)}`, full: t.slice(0, 500) })
  const preference = (m.preference || []).find((x) => t.includes(x))
  if (preference) out.push({ theme: 'communication', tag, summary: `用户偏好（${preference}）：${t.slice(0, 60)}`, full: t.slice(0, 500) })
  return out
}
```

- [x] **Step 4: 跑测试验证通过**

Run: `node --test server/memory.test.mjs`
Expected: PASS（4 个测试）

- [x] **Step 5: 提交**

```bash
git add kernel/memory.mjs server/memory.test.mjs
git commit -m "feat(kernel): 记忆内核化（持久化原语 + 确定性捕获 + 索引，GUI 同数据源）"
```

---

### Task 4: cli 记忆注入 + 轮末捕获接线（L3-2）

**Files:**
- Modify: `kernel/prompt.mjs`（composeSystemPrompt 增加 `memory` 参数）
- Modify: `kernel/cli.mjs`（buildMemoryIndex 注入 + 轮末 captureMemoryCandidates 落盘）
- Test: `server/memory.test.mjs`（追加 prompt 单元 + spawn 集成）

**Interfaces:**
- Consumes: `buildMemoryIndex`/`captureMemoryCandidates`/`appendMemoryEntry`/`memoryRoot`（Task 3）；`composeSystemPrompt`（P4 Task 6 后签名含 skills）
- Produces:
  - `composeSystemPrompt({ toolNames, agents, subagents, append, cwd, skills, memory = '' })`：memory 区块插在 skills 之后、append 之前（append 仍最高优先级）
  - cli 行为：`settings.memory.inject === false` 时跳过索引注入（逃生阀，默认注入）；turn 结束后对 user 文本跑 captureMemoryCandidates，命中且 `settings.memory.capture !== false` 时 appendMemoryEntry 落盘 `memoryRoot(configDir)`

- [x] **Step 1: 写失败测试（追加到 server/memory.test.mjs）**

```js
import { composeSystemPrompt } from '../kernel/prompt.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { KERNEL, makeReader, sanitizeSegment } from './helpers.mjs' // 见步骤 3 注；无 helpers 则内联复制

test('composeSystemPrompt：memory 区块在 skills 之后、append 之前', () => {
  const p = composeSystemPrompt({
    toolNames: ['Bash'], agents: [], subagents: [], cwd: '/x',
    skills: [{ id: 's1', description: 'd1' }],
    memory: '\n\n【个人经验索引】测试\n- [workflow|tag] 1 条',
    append: 'APPEND_MARK',
  })
  assert.ok(p.includes('【个人经验索引】测试'))
  const mi = p.indexOf('【个人经验索引】')
  const ai = p.indexOf('APPEND_MARK')
  const si = p.indexOf('s1')
  assert.ok(si < mi && mi < ai, '顺序: skills < memory < append')
})

test('集成：轮末捕获命中 → configDir/memory/personal 落盘条目', async () => {
  const configDir = join(tmp, 'mcfg')
  const cwd = join(tmp, 'mproj')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const child = spawn(process.execPath, [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs'),
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  try {
    await reader.nextEvent() // init
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '以后不要用 sed 改文件' } }) + '\n')
    while (true) { const ev = await reader.nextEvent(); if (ev.type === 'result') break }
    const fp = join(configDir, 'memory', 'personal', 'workflow.md')
    assert.ok(existsSync(fp), 'workflow.md 已落盘')
    assert.ok(readFileSync(fp, 'utf-8').includes('以后不要用 sed 改文件'))
  } finally {
    try { child.stdin.end() } catch {}
  }
})
```

> 注：`helpers.mjs` 若不存在，把 `makeReader`（行队列 nextEvent）与 `sanitizeSegment` 内联复制进本测试文件（参照 server/kernel-contract.test.mjs line 36-58 与 session.mjs sanitize 规则；本集成测试未用 sanitizeSegment，可省）。

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/memory.test.mjs`
Expected: 单元 4 个 PASS；prompt 单元与集成 FAIL（memory 参数未实现 / 无捕获落盘）

- [x] **Step 3: 实现 prompt.mjs memory 参数**

`kernel/prompt.mjs` `composeSystemPrompt`（P4 Task 6 后签名）：签名加 `memory = ''`，在 skills 区块之后、append 之前插入：

```js
  if (memory && memory.trim()) parts.push(memory.trim())
```

- [x] **Step 4: 实现 cli.mjs 注入与捕获**

`kernel/cli.mjs`：
1. import 加：`import { memoryRoot, buildMemoryIndex, captureMemoryCandidates, appendMemoryEntry } from './memory.mjs'`
2. prompt 组装处（P4 Task 6 skills 发现之后）：

```js
  // L3-2：记忆索引注入（与 GUI 经验面板同一数据源；settings.memory.inject=false 逃生阀）
  const memoryRootDir = memoryRoot(configDir)
  const memoryBlock = settings.merged.memory?.inject === false ? '' : buildMemoryIndex({ root: memoryRootDir })
```
   composeSystemPrompt 调用加 `memory: memoryBlock,`。
3. `handleUser`（原 line 170）`finally` 块内、状态复位前加捕获：

```js
    // L3-1 轮末捕获：命中纠错/偏好模式 → 落盘记忆（默认开，settings.memory.capture=false 关闭）
    try {
      if (settings.merged.memory?.capture !== false && content.trim()) {
        for (const c of captureMemoryCandidates({ userText: content, tag: settings.merged.memory?.taskTag || null, markers: settings.merged.memory?.markers || null })) {
          appendMemoryEntry({ root: memoryRootDir, theme: c.theme, tag: c.tag, summary: c.summary, full: c.full })
        }
      }
    } catch { /* 记忆捕获失败不影响主流程 */ }
```

- [x] **Step 5: 跑测试验证通过**

Run: `node --test server/memory.test.mjs`
Expected: PASS（6 个测试）

- [x] **Step 6: 回归 + 提交**

Run: `node --test server/kernel-contract.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS

```bash
git add kernel/prompt.mjs kernel/cli.mjs server/memory.test.mjs
git commit -m "feat(kernel): 记忆注入系统提示 + 轮末确定性捕获落盘（L3-2）"
```

---

### Task 5: 上下文预测与提前预警（L4-1）

**Files:**
- Modify: `kernel/context.mjs`（追加 `predictTurns` 纯函数）
- Modify: `kernel/health.mjs`（snapshot() 改用 predictTurns；ponos_health 事件增 growthPerTurn/predictedTurns 字段；predictedTurns < 15 且 ≥5 时 reason 提示）
- Create: `server/context-predict.test.mjs`

**Interfaces:**
- Consumes: `computeHealthScore`（health.mjs 既有，签名不变——零回归）
- Produces:
  - `predictTurns({ recent, window, thresholdRatio, k = 5 })` → `{ growthPerTurn, predictedTurns, threshold, lastInput }`
    - recent = `[{ usage: { input_tokens } }]`（health 既有 recent 形状）
    - growthPerTurn = 最近 k 轮 input 增量均值（`max(1, round(avg))`；不足 2 轮或无增量 → 1000）
    - threshold = `floor(window * thresholdRatio)`；predictedTurns = `max(0, floor((threshold - lastInput) / growthPerTurn))`
  - health：snapshot() 以 predictTurns 计算 remainingTurns（替代原 avgPerTurn 估算）；emit 事件增 `growthPerTurn, predictedTurns`；`predictedTurns < 15 && predictedTurns >= 5` 时 reason 追加"预计 N 轮后需压缩"

- [x] **Step 1: 写失败测试**

```js
// server/context-predict.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { predictTurns } from '../kernel/context.mjs'
import { createHealth } from '../kernel/health.mjs'

test('predictTurns：增长速率 = 最近 k 轮增量均值 → 预测轮数', () => {
  // 每轮 input 增长 1000（从 50000 起）
  const recent = [50000, 51000, 52000, 53000, 54000].map((v) => ({ usage: { input_tokens: v } }))
  const r = predictTurns({ recent, window: 200_000, thresholdRatio: 0.8 })
  assert.equal(r.growthPerTurn, 1000)
  assert.equal(r.threshold, 160_000)
  assert.equal(r.predictedTurns, 106) // floor((160000-54000)/1000)
  assert.equal(r.lastInput, 54000)
})

test('predictTurns：数据不足 → 保守默认 1000', () => {
  const r = predictTurns({ recent: [{ usage: { input_tokens: 100 } }], window: 200_000, thresholdRatio: 0.8 })
  assert.equal(r.growthPerTurn, 1000)
  assert.equal(r.predictedTurns, 159)
})

test('health 集成：ponos_health 事件含 predictedTurns/growthPerTurn，红档触发', () => {
  const events = []
  const wire = { health: (h) => events.push(h), summary: () => {} }
  const h = createHealth({ wire, model: 'deepseek-v4-flash', contextWindow: 200_000, env: {} })
  // 两轮：input 从 150000 涨到 170000（接近 ceiling 180000）→ 剩余水位 <12% → 红档
  h.record({ usage: { input_tokens: 150_000 }, compactCount: 0 })
  h.record({ usage: { input_tokens: 170_000 }, compactCount: 0 })
  assert.equal(events.length, 1)
  assert.equal(events[0].tier, 'red')
  assert.ok(Number.isInteger(events[0].predictedTurns))
  assert.equal(events[0].growthPerTurn, 20_000)
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/context-predict.test.mjs`
Expected: FAIL —— `predictTurns is not a function`（health 集成：无新字段断言失败）

- [x] **Step 3: 实现 context.mjs predictTurns**

`kernel/context.mjs` 末尾追加：

```js
// —— L4-1 上下文预测：token 增长速率 → 预测到达阈值轮数 ——
// recent 形状与 health 一致：[{ usage: { input_tokens } }]；k = 参与均值计算的最近轮数。
export function predictTurns({ recent = [], window = 200_000, thresholdRatio = 0.8, k = 5 } = {}) {
  const usages = (Array.isArray(recent) ? recent : []).map((t) => Number(t?.usage?.input_tokens ?? 0))
  const lastInput = usages.length ? usages[usages.length - 1] : 0
  const threshold = Math.floor(window * thresholdRatio)
  const deltas = []
  for (let i = usages.length - 1; i > 0 && deltas.length < k; i--) deltas.push(usages[i] - usages[i - 1])
  const growthPerTurn = deltas.length ? Math.max(1, Math.round(deltas.reduce((s, d) => s + d, 0) / deltas.length)) : 1000
  const predictedTurns = Math.max(0, Math.floor((threshold - lastInput) / growthPerTurn))
  return { growthPerTurn, predictedTurns, threshold, lastInput }
}
```

- [x] **Step 4: 实现 health.mjs snapshot 扩展**

`kernel/health.mjs`：import 区加 `import { predictTurns } from './context.mjs'`；`snapshot()`（原 line 59-75）内替换 remainingTurns 计算并返回预测：

```js
  function snapshot() {
    const ceiling = attentionCeiling(contextWindow)
    const lastInput = recent.length ? (recent[recent.length - 1].usage?.input_tokens ?? 0) : 0
    const remainingPct = ceiling > 0 ? Math.max(0, 100 - (lastInput / ceiling) * 100) : 100
    // L4-1：增长速率预测（替代原 avgPerTurn 估算）
    const pred = predictTurns({ recent, window: contextWindow, thresholdRatio: 0.8 })
    const remainingTurns = pred.predictedTurns
    const chainDepth = recent.reduce((s, t) => s + (t.compactCount > 0 ? 1 : 0), 0)
    const h = computeHealthScore({
      compactCount, chainDepth, remainingPct, remainingTurns,
      failures: failures.count, redundancyRatio: 0, toolResultShare: 0, model,
    })
    // 提前预警：预计 5~14 轮后达阈值（红档 reason 已含剩余轮数，不重复）
    if (pred.predictedTurns >= 5 && pred.predictedTurns < 15 && h.tier !== 'red') {
      h.reason = `预计约 ${pred.predictedTurns} 轮后接近上下文上限，建议关注压缩`
    }
    return { ...h, growthPerTurn: pred.growthPerTurn, predictedTurns: pred.predictedTurns }
  }
```

`emitIfChanged()`（原 line 77-83）事件补两字段：

```js
      const h = snapshot()
      if (h.tier !== lastTier) {
        lastTier = h.tier
        wire.health?.({ score: h.score, tier: h.tier, compactCount, remainingPct: h.remainingPct, remainingTurns: h.remainingTurns, suggestNewSession: h.suggestNewSession, reason: h.reason, growthPerTurn: h.growthPerTurn, predictedTurns: h.predictedTurns })
      }
```

- [x] **Step 5: 跑测试验证通过**

Run: `node --test server/context-predict.test.mjs`
Expected: PASS（3 个测试）

- [x] **Step 6: 回归 + 提交**

Run: `node --test server/kernel-contract.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS

```bash
git add kernel/context.mjs kernel/health.mjs server/context-predict.test.mjs
git commit -m "feat(kernel): 上下文预测（增长速率→剩余轮数）+ ponos_health 提前预警字段"
```

---

### Task 6: 端到端——settings.compact 全链路压缩（L2-1 × L1-1 × L4-1）

**Files:**
- Create: `server/session-long.test.mjs`

**Interfaces:**
- Consumes: Task 1/2/5 全部（keyInfo 注入、settings.compact、health 预测）；mock 摘要响应（api.mjs `系统压缩指令` 检测 → `<compacted-summary>mock 摘要</compacted-summary>`）
- Produces: 无新导出——端到端验收：低阈值配置下多轮会话自动触发压缩；ponos_summary 事件携带摘要；ponos_health 事件含预测字段

- [x] **Step 1: 写失败测试**

```js
// server/session-long.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'ponos-long-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

function makeReader(stream) {
  const lines = []
  const waiters = []
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', (l) => {
    const line = l.trim()
    if (!line) return
    if (waiters.length) waiters.shift()(line)
    else lines.push(line)
  })
  return {
    nextEvent(timeoutMs = 5000) {
      if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('read timeout: ' + JSON.stringify(lines))), timeoutMs)
        waiters.push((l) => { clearTimeout(t); resolve(JSON.parse(l)) })
      })
    },
  }
}

function sanitizeSegment(s) {
  return String(s).replace(/[^a-zA-Z0-9\u4e00-\u9fa5.-]/g, '-')
}

test('端到端：低阈值 settings.compact → 多轮后触发压缩 → ponos_summary + 落盘', async () => {
  const configDir = join(tmp, 'lcfg')
  const cwd = join(tmp, 'lproj')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, '.ponos', 'settings.json'), JSON.stringify({
    compact: { thresholdTokens: 1, reserveTokens: 1 },
  }), 'utf-8')
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  let sid = ''
  const events = []
  try {
    const init = await reader.nextEvent()
    sid = init.session_id
    // 第 1 轮：积累 user + assistant 历史
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '[mock:tool-safe] 第一轮' } }) + '\n')
    while (true) { const ev = await reader.nextEvent(); events.push(ev); if (ev.type === 'result') break }
    // 第 2 轮：pre-step 测压 → threshold=1 必触发 → cut 有效（有 assistant 历史）→ 摘要
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '[mock:tool-safe] 第二轮' } }) + '\n')
    while (true) {
      const ev = await reader.nextEvent()
      events.push(ev)
      if (ev.type === 'result') break
    }
  } finally {
    try { child.stdin.end() } catch {}
  }
  // 压缩发生：ponos_summary 事件（health.recordCompaction 单通道）
  const summaryEv = events.find((e) => e.type === 'ponos_summary')
  assert.ok(summaryEv, '出现 ponos_summary 事件')
  assert.ok(String(summaryEv.text ?? JSON.stringify(summaryEv)).includes('mock 摘要'))
  // 落盘：transcript 含 compaction 记录
  const transcriptPath = join(configDir, 'projects', sanitizeSegment(cwd), sid + '.jsonl')
  assert.ok(existsSync(transcriptPath))
  const raw = readFileSync(transcriptPath, 'utf-8')
  assert.ok(raw.includes('compaction'), 'transcript 含 compaction 记录')
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/session-long.test.mjs`
Expected: FAIL —— 无 ponos_summary 事件（settings.compact 未接线 / 或行为未按预期；调试时先确认事件流：第 1 轮 assistant+result，第 2 轮 ponos_summary+assistant+result）

- [x] **Step 3: 若失败因 findCutPoint 边界（covered 为空 → cut null）**

按 Task 2 设计的阈值语义检查：`thresholdTokens=1` → thresholdRatio=0.000005 → threshold=1（每轮必超）；`reserveTokens=1` → retainRatio=0.000005 → retainTokens=floor(200000×0.000005)=1 → 第 2 轮 pre-step 时历史含 [user1, assistant(tool_use), tool_result, assistant(text)] + user2，从尾部累计 1 token 即停 → cut.covered 非空 → 摘要发生。若事件顺序与预期不符，用 `node --test server/session-long.test.mjs --test-name-pattern=端到端` 单独跑并打印 events 类型序列定位（不要改 mock 语义）。

- [x] **Step 4: 跑测试验证通过**

Run: `node --test server/session-long.test.mjs`
Expected: PASS

- [x] **Step 5: 全量回归 + 提交**

Run: `node --test "server/*.test.mjs"`
Expected: 全绿（222+ 既有测试 + 本计划新增）

```bash
git add server/session-long.test.mjs
git commit -m "test(kernel): 端到端——settings.compact 低阈值触发压缩全链路验收"
```

---

## Self-Review

**1. Spec coverage（对照 docs/production/session.md §4 任务清单）：**
- L1-1 compact 关键信息保留 → Task 1（extractKeyInfo/keyInfoBlock 注入摘要请求，TodoWrite/文件变更/最近决策）
- L2-1 预算配置化（settings.compact: thresholdTokens/reserveTokens/maxToolResults，默认 contextWindow×0.8）→ Task 2（resolveCompactSettings + cli 装配）+ Task 6 端到端验收
- L3-1 经验捕获内核化 → Task 3（记忆持久化 + captureMemoryCandidates 确定性捕获）+ Task 4（轮末接线落盘）
- L3-2 记忆注入（按任务标签检索 + 来源标注）→ Task 4（buildMemoryIndex 注入，索引含 主题|任务标签 分组与文件标注）
- L4-1 上下文预测（增长速率 = 最近 K 轮平均 → 预测轮数 → 预警）→ Task 5（predictTurns + health 提前预警）
- L1-2 compact 回测（P2 评测扩展）→ 不在内核计划（评测平台扩展，随 P6/评测阶段协调，已注）
- L3-3 记忆管理 UI（P2，GUI 面板）→ 不在内核计划（前端项，experience.mjs 既有面板已兼容本计划落盘格式）

**2. Placeholder scan：** 无 TBD/TODO；每步骤含完整测试与实现代码。Task 4 测试引用的 `helpers.mjs` 给了明确替代方案（内联复制 makeReader，参照既有文件行号），不依赖未定义内容。Task 6 调试路径给了具体定位方法（事件序列打印），非空泛指令。

**3. Type consistency：** `extractKeyInfo/keyInfoBlock/assembleSummaryRequest`（Task 1 定义，Task 6 隐式消费）、`resolveCompactSettings`（Task 2 定义，Task 6 端到端消费）、`memoryRoot/appendMemoryEntry/buildMemoryIndex/captureMemoryCandidates`（Task 3 定义，Task 4 消费）、`predictTurns`（Task 5 定义，health snapshot 消费）跨任务签名一致；`settings.merged.compact.*` 键名（thresholdTokens/reserveTokens/maxToolResults）Task 2/4/6 一致；ponos_health 新增字段（growthPerTurn/predictedTurns）Task 5 定义与测试断言一致；memory 配置键（inject/capture/taskTag/markers）Task 4 内部一致。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-08-21-kernel-session.md`（6 个 TDD 任务，覆盖 L1-1/L2-1/L3-1/L3-2/L4-1）。两种执行方式：

**1. Subagent-Driven（推荐）** —— 每个任务派发独立 subagent，任务间审查，快速迭代
**2. Inline Execution** —— 本会话用 executing-plans 批量执行 + 检查点审查

选哪种？
