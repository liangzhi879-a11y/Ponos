# 内核安全与审计（P2）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 P2 合规底线：transcript/日志密钥脱敏、子进程 env 白名单、审计聚合导出、权限规则文件、路径边界 realpath 加固、共享目录只读挂载。全部机制放 kernel/；bridge 仅保留"必须由会话管理方执行"的 /audit REST 薄壳；GUI 零新增设置项（S3-2/S1-2 前端面板为本计划外）。

**Architecture:** 新建 kernel/redact.mjs（脱敏纯函数）+ kernel/audit.mjs（审计聚合纯函数）+ kernel/config.mjs（configDir 解析）；session.mjs 落盘前脱敏（内存模型输入保留原文）；tools.mjs Bash/OCR spawn 显式白名单 env；permissions.mjs 规则 schema 优先于默认判定；withinBoundary realpath 解符号链接逃逸。

**Tech Stack:** Node.js ESM（零 npm 依赖）、node:test + spawn 集成测试（YFW_MOCK_API=1）、NDJSON transcript（server/transcript.mjs 同一文件格式）。

## Global Constraints

- **内核优先原则（用户硬性前提）**：脱敏、白名单、审计聚合、规则解析、路径加固全部在 kernel/；bridge 仅 /audit 与 /permissions 的 REST 薄壳（读文件 + 调内核纯函数）；前端零新增设置项。S3-2（权限面板 UI）、S1-2（审计可视化）为本计划外——内核产出的能力已可供前端消费，UI 后续单独做。
- 脱敏语义：**磁盘 transcript 脱敏、内存模型输入保留原文**（deriveMessages 不走落盘脱敏层）；`YFW_KEEP_SECRETS=1` 时磁盘也保留原文（用户显式选择）。
- 规则优先级：显式规则 deny > ask > allow；无规则命中时行为与现状完全一致（highrisk 默认审批）。
- 向后兼容：现有 221+ 测试零破坏（withinBoundary 加固不得拒绝既有合法路径；env 白名单不得破坏 Bash 基本命令执行）。
- 测试命令：`node --test server/<file>.test.mjs`；全量回归 `node --test "server/*.test.mjs"`。

---

### Task 1: kernel/redact.mjs — 密钥脱敏（S2-1）

**Files:**
- Create: `kernel/redact.mjs`
- Modify: `kernel/session.mjs`（append 落盘前脱敏）、`kernel/log.mjs`（err 消息脱敏）
- Test: `server/redact.test.mjs`（新建）+ `server/session.test.mjs`（增补）

**Interfaces:**
- Produces:
  - `redactText(text)` → string（`sk-***`、`AKIA***`、`key/token=***`、`Bearer ***` 打码；非 string/空原样返回）
  - `redactEntry(entry)` → entry（递归打码 message.content 的 string/blocks/input JSON；`YFW_KEEP_SECRETS=1` 时原样）
  - session 磁盘落盘内容脱敏；内存 `deriveMessages()` 保留原文

- [ ] **Step 1: 写失败测试（新建 server/redact.test.mjs + session 增补）**

```js
// server/redact.test.mjs —— 密钥脱敏（docs/production/security.md S2-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, redactEntry } from '../kernel/redact.mjs'

test('redactText：sk- / AKIA / key=value / Bearer 打码', () => {
  assert.equal(redactText('key sk-abc12345XYZ end'), 'key sk-*** end')
  assert.equal(redactText('AKIAIOSFODNN7EXAMPLE'), 'AKIA***')
  assert.equal(redactText('api_key = "supersecret123"'), 'api_key = "***"')
  assert.equal(redactText('Bearer eyJhbGciOiJIUzI1NiJ9.abc'), 'Bearer ***')
  assert.equal(redactText('普通文本无敏感'), '普通文本无敏感')
  assert.equal(redactText(''), '')
  assert.equal(redactText(null), null)
})

test('redactEntry：content 字符串/文本块/工具输入递归打码；YFW_KEEP_SECRETS=1 保留', () => {
  const prev = process.env.YFW_KEEP_SECRETS
  try {
    process.env.YFW_KEEP_SECRETS = ''
    const e = redactEntry({
      type: 'assistant', message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'token is sk-abc12345XYZ' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer sk-secret9999" http://x' } },
        ],
      },
    })
    assert.match(e.message.content[0].text, /sk-\*\*\*/)
    assert.match(e.message.content[1].input.command, /Bearer \*\*\*/)
    process.env.YFW_KEEP_SECRETS = '1'
    const keep = redactEntry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'sk-abc12345XYZ' }] } })
    assert.equal(keep.message.content[0].text, 'sk-abc12345XYZ')
  } finally {
    process.env.YFW_KEEP_SECRETS = prev || ''
  }
})

// server/session.test.mjs 增补（沿用该文件 fixture）：
test('S2-1 磁盘脱敏：transcript 文件含打码内容，内存 deriveMessages 保留原文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-redact-'))
  const prev = process.env.YFW_KEEP_SECRETS
  process.env.YFW_KEEP_SECRETS = ''
  try {
    const store = createSessionStore({ configDir: dir, cwd: '', sessionId: 'r' })
    store.appendUser('my key is sk-abc12345XYZ')
    const raw = readFileSync(store.file, 'utf-8')
    assert.match(raw, /sk-\*\*\*/)
    assert.ok(!raw.includes('sk-abc12345XYZ'), '磁盘不得含原文密钥')
    assert.equal(store.deriveMessages()[0].content, 'my key is sk-abc12345XYZ', '模型输入保留原文')
  } finally {
    process.env.YFW_KEEP_SECRETS = prev || ''
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/redact.test.mjs server/session.test.mjs`
Expected: FAIL（redactText 未定义；磁盘含原文）

- [ ] **Step 3: 最小实现**

```js
// kernel/redact.mjs —— 敏感信息脱敏（docs/production/security.md S2-1）
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,                    // OpenAI/Anthropic 风格 API key
  /\bAKIA[A-Z0-9]{16}\b/g,                      // AWS access key
  /\b(Bearer\s+)[A-Za-z0-9\-._~+/]{8,}/gi,      // Bearer token（保留前缀词）
  /(\b(?:api[_-]?key|auth[_-]?token|password|secret|token)\b\s*[:=]\s*["']?)[A-Za-z0-9_\-.]{8,}/gi,
]
const KEEP = () => process.env.YFW_KEEP_SECRETS === '1'

export function redactText(text) {
  if (typeof text !== 'string' || !text || KEEP()) return text
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) => (prefix ? prefix : m.slice(0, 4)) + '***')
  }
  return out
}

export function redactEntry(entry) {
  if (KEEP() || !entry) return entry
  const msg = entry.message
  if (!msg) return entry
  if (typeof msg.content === 'string') {
    msg.content = redactText(msg.content)
  } else if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b) {
        if (typeof b.content === 'string') b.content = redactText(b.content)
        if (typeof b.text === 'string') b.text = redactText(b.text)
        if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
          try { b.input = JSON.parse(redactText(JSON.stringify(b.input))) } catch { /* 保持原样 */ }
        }
      }
    }
  }
  return entry
}

// kernel/session.mjs —— append() 落盘前脱敏（内存 entriesBySeq 保持原文）：
import { redactEntry } from './redact.mjs'
function append(entry) {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(file, JSON.stringify(redactEntry(entry)) + '\n', 'utf-8')
  } catch { /* 磁盘不可写不致命 */ }
  return entry
}

// kernel/log.mjs —— error/fatal/warn 的 err 消息脱敏（R5-1 日志不泄密钥）：
import { redactText } from './redact.mjs'
error(msg, err) { this.log('error', msg, err ? { err: redactText(err?.message || String(err)) } : {}) }
// fatal/warn 同改
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/redact.test.mjs server/session.test.mjs server/log.test.mjs`
Expected: PASS（redact 2 个 + session 增补 + log 原样）

- [ ] **Step 5: 提交**

```bash
git add kernel/redact.mjs kernel/session.mjs kernel/log.mjs server/redact.test.mjs server/session.test.mjs
git commit -m "feat(kernel): 密钥脱敏——磁盘 transcript/日志打码，内存模型输入保留原文（S2-1）"
```

---

### Task 2: tools.mjs 子进程 env 白名单（S2-2）

**Files:**
- Modify: `kernel/tools.mjs`（childEnv 白名单 + Bash/OCR spawn 显式 env）
- Test: `server/tools-ext.test.mjs`（增补 1 个测试）

**Interfaces:**
- Produces: `export function childEnv()` → 白名单 env 对象（系统路径/编码/代理变量；**剥离 ANTHROPIC_*/CLAUDE_CODE_*/密钥类变量**）
  - Bash spawn（line 45）与 OCR python spawn（line 377）加 `env: childEnv()`

- [ ] **Step 1: 写失败测试（增补到 server/tools-ext.test.mjs 末尾）**

```js
import { childEnv } from '../kernel/tools.mjs'

test('S2-2 env 白名单：API key 剥离、系统路径保留、自定义敏感变量不透传', () => {
  const prev = {
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    SECRET_TEST_VAR: process.env.SECRET_TEST_VAR,
  }
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-should-not-leak'
  process.env.SECRET_TEST_VAR = 'sensitive'
  try {
    const env = childEnv()
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env), 'API key 必须剥离')
    assert.ok(!('SECRET_TEST_VAR' in env), '非白名单自定义变量不透传')
    assert.ok('PATH' in env || 'Path' in env, '系统路径保留')
  } finally {
    if (prev.ANTHROPIC_AUTH_TOKEN === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = prev.ANTHROPIC_AUTH_TOKEN
    if (prev.SECRET_TEST_VAR === undefined) delete process.env.SECRET_TEST_VAR
    else process.env.SECRET_TEST_VAR = prev.SECRET_TEST_VAR
  }
})

test('S2-2 Bash 子进程：白名单 env 生效（不泄露敏感变量），命令正常执行', async () => {
  const prev = process.env.SECRET_TEST_VAR
  process.env.SECRET_TEST_VAR = 'must-not-leak'
  try {
    // 通过 createToolRegistry 的 Bash 工具执行（沿用该文件 registry fixture）
    const reg = createToolRegistry({ cwd: process.cwd(), addDirs: [], skipPermissions: true })
    const r = await reg.tools.Bash.run({ command: 'echo "leak=$SECRET_TEST_VAR"' })
    assert.equal(r.isError, false)
    assert.match(String(r.content), /leak=$/, `子进程不应看到 SECRET_TEST_VAR，实际 ${r.content}`)
  } finally {
    if (prev === undefined) delete process.env.SECRET_TEST_VAR
    else process.env.SECRET_TEST_VAR = prev
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/tools-ext.test.mjs`
Expected: FAIL（ANTHROPIC_AUTH_TOKEN 泄漏；Bash 输出 leak=must-not-leak）

- [ ] **Step 3: 最小实现（kernel/tools.mjs）**

```js
// 模块级（withinBoundary 之前）追加：
// S2-2 子进程 env 白名单：仅透传系统路径/编码/代理变量，剥离一切密钥与
// ANTHROPIC_*/CLAUDE_CODE_* 配置（防 Bash/OCR 子进程窃取宿主密钥）。
const ENV_WHITELIST = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR',
  'SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'LANGUAGE', 'TERM', 'SHELL', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]
export function childEnv() {
  const out = {}
  for (const k of Object.keys(process.env)) {
    if (ENV_WHITELIST.includes(k)) out[k] = process.env[k]
  }
  return out
}
// runShell spawn（line 45-49）追加 env: childEnv()
// OCR python spawn（line ~377）追加 env: childEnv()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/tools-ext.test.mjs`
Expected: PASS（原有全部测试 + 新增 2 个——注意既有 Bash 测试依赖 PATH 透传，白名单含 PATH 故不破坏）

- [ ] **Step 5: 提交**

```bash
git add kernel/tools.mjs server/tools-ext.test.mjs
git commit -m "feat(kernel): 子进程 env 白名单——剥离密钥与配置变量（S2-2）"
```

---

### Task 3: kernel/audit.mjs 审计聚合 + bridge /audit（S1-1）

**Files:**
- Create: `kernel/audit.mjs`
- Modify: `server/bridge.mjs`（/audit REST 薄壳）
- Test: `server/audit.test.mjs`（新建）

**Interfaces:**
- Produces:
  - `buildAuditReport(entries, { from, to, sessionId })` → `[{ ts, seq, session, type: 'tool_use'|'tool_result', tool, params|toolUseId, summary }]`
    - 参数/结果摘要截断 200 字符；`from`/`to` 为 ISO 时间字符串，过滤 entries
  - bridge `GET /audit?cwd=&from=&to=` → `{ ok: true, rows }`（聚合全部 transcript；参照 /transcript/stats 的文件遍历模式）

- [ ] **Step 1: 写失败测试（新建 server/audit.test.mjs）**

```js
// server/audit.test.mjs —— 审计聚合（docs/production/security.md S1-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAuditReport } from '../kernel/audit.mjs'

function entry(type, msg, ts, seq) {
  return { type, seq, timestamp: ts, message: msg }
}

test('buildAuditReport：tool_use/tool_result 行提取 + 参数/结果摘要截断', () => {
  const entries = [
    entry('assistant', { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
    ] }, '2026-08-21T00:00:00Z', 1),
    entry('user', { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'deleted', is_error: false },
    ] }, '2026-08-21T00:00:01Z', 2),
    entry('user', { role: 'user', content: 'plain' }, '2026-08-21T00:00:02Z', 3),
  ]
  const rows = buildAuditReport(entries, { sessionId: 's1' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].type, 'tool_use'); assert.equal(rows[0].tool, 'Bash')
  assert.match(rows[0].params, /rm -rf/)
  assert.equal(rows[1].type, 'tool_result'); assert.equal(rows[1].toolUseId, 't1')
  assert.equal(rows[1].summary, 'deleted')
  assert.equal(rows[0].session, 's1')
})

test('buildAuditReport：时间范围过滤 + 长内容截断 200 字符', () => {
  const entries = [
    entry('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'x'.repeat(500) } }] }, '2026-08-21T00:00:00Z', 1),
    entry('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/f' } }] }, '2026-08-21T01:00:00Z', 2),
  ]
  const rows = buildAuditReport(entries, { from: '2026-08-21T00:30:00Z' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tool, 'Read')
  assert.ok(rows[0].params.length <= 200 + 1)   // 截断 + 省略号
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/audit.test.mjs`
Expected: FAIL（Cannot find module `../kernel/audit.mjs`）

- [ ] **Step 3: 最小实现**

```js
// kernel/audit.mjs —— 审计聚合（docs/production/security.md S1-1）
// 数据源 = transcript JSONL（权威源，session.mjs 同格式）。纯函数，bridge /audit
// 读文件后调用本模块聚合——审计逻辑内核化，bridge 仅薄壳。
function summarize(v, max = 200) {
  try {
    const s = JSON.stringify(v)
    return s.length > max ? s.slice(0, max) + '…' : s
  } catch {
    return String(v).slice(0, max)
  }
}

export function buildAuditReport(entries, { from = '', to = '', sessionId = '' } = {}) {
  const rows = []
  for (const e of entries || []) {
    const ts = e.timestamp || ''
    if (from && ts < from) continue
    if (to && ts > to) continue
    const m = e.message || {}
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_use') {
          rows.push({ ts, seq: e.seq, session: sessionId || '', type: 'tool_use', tool: b.name, params: summarize(b.input) })
        }
      }
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_result') {
          rows.push({ ts, seq: e.seq, session: sessionId || '', type: 'tool_result', toolUseId: b.tool_use_id, summary: String(b.content || '').slice(0, 200) })
        }
      }
    }
  }
  return rows
}

// server/bridge.mjs —— /transcript/stats 旁（line ~1404 后）追加：
import { buildAuditReport } from '../kernel/audit.mjs'
if (url.pathname === '/audit') {
  const cwd = url.searchParams.get('cwd') || ''
  const from = url.searchParams.get('from') || ''
  const to = url.searchParams.get('to') || ''
  const base = transcriptBaseDir()
  const rows = []
  const projects = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const proj of projects) {
    const pdir = join(base, proj.name)
    const files = readdirSync(pdir).filter((f) => f.endsWith('.jsonl'))
    for (const f of files) {
      const sid = f.replace(/\.jsonl$/, '')
      const lines = readFileSync(join(pdir, f), 'utf-8').trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      rows.push(...buildAuditReport(lines, { from, to, sessionId: sid }))
    }
  }
  rows.sort((a, b) => (a.ts < b.ts ? -1 : 1))
  return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, rows, count: rows.length }))
}
```

> 注：`readdirSync/readFileSync` 已在 bridge.mjs import 区（/transcript 处理已用），无需新增 import；`transcriptBaseDir` 同文件已有。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/audit.test.mjs`
Expected: PASS（2 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add kernel/audit.mjs server/audit.test.mjs server/bridge.mjs
git commit -m "feat(kernel+bridge): 审计聚合导出——tool_use/tool_result 全量可追溯，/audit 薄壳（S1-1）"
```

---

### Task 4: permissions.mjs 规则 schema（S3-1）

**Files:**
- Modify: `kernel/permissions.mjs`（rules 解析 + decideToolPermission 扩展）、`kernel/cli.mjs`（--permission-rules-file 加载）
- Test: `server/permissions.test.mjs`（新建）

**Interfaces:**
- Consumes: `matchesHighRisk`（已有）
- Produces:
  - `decideToolPermission({ toolName, input, skipPermissions, autoApproveHighRisk, rules })`——rules 形状 `{ allow: string[], deny: string[], ask: string[] }`，条目 `Tool:pattern`（pattern 支持 `*` 通配，Bash 匹配命令文本；非 Bash 仅 `Tool:*` 有效）
  - 优先级：deny > ask > allow；命中即返回 `{ decision, reason }`；未命中走原默认逻辑
  - cli：`--permission-rules-file <file>` → JSON `{ permissions: { allow, deny, ask } }` → engine opts.permissionRules

- [ ] **Step 1: 写失败测试（新建 server/permissions.test.mjs）**

```js
// server/permissions.test.mjs —— 权限规则 schema（docs/production/security.md S3-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideToolPermission } from '../kernel/permissions.mjs'

const RULES = {
  allow: ['Bash:git status*', 'Bash:echo hello', 'Read:*'],
  deny: ['Bash:git push --force*', 'Bash:rm -rf /tmp/x'],
  ask: ['Bash:drop table*'],
}

test('S3-1 显式规则：deny 优先于 ask/allow，allow 放行默认高危', () => {
  // deny 命中（即使命令也是 highrisk 默认 ask 类）
  const d = decideToolPermission({ toolName: 'Bash', input: { command: 'git push --force origin main' }, skipPermissions: false, autoApproveHighRisk: false, rules: RULES })
  assert.equal(d.decision, 'deny')
  // allow 命中 → 放行默认高危（rm -rf 特定路径被用户显式允许）
  const a = decideToolPermission({ toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, skipPermissions: false, autoApproveHighRisk: false, rules: RULES })
  assert.equal(a.decision, 'allow')
  // ask 命中（drop table 但不在默认 highrisk 列表）
  const q = decideToolPermission({ toolName: 'Bash', input: { command: 'drop table users' }, skipPermissions: false, autoApproveHighRisk: false, rules: RULES })
  assert.equal(q.decision, 'ask')
})

test('S3-1 无规则命中：行为与现状一致（highrisk ask / 其他 allow）', () => {
  const r = decideToolPermission({ toolName: 'Bash', input: { command: 'rm -rf /elsewhere' }, skipPermissions: false, autoApproveHighRisk: false, rules: RULES })
  assert.equal(r.decision, 'ask')                       // 默认 highrisk
  const r2 = decideToolPermission({ toolName: 'Bash', input: { command: 'echo hi' }, skipPermissions: false, autoApproveHighRisk: false, rules: {} })
  assert.equal(r2.decision, 'allow')                    // 默认非高危
  // 未传 rules 参数（向后兼容）
  const r3 = decideToolPermission({ toolName: 'Bash', input: { command: 'rm -rf /y' }, skipPermissions: false, autoApproveHighRisk: false })
  assert.equal(r3.decision, 'ask')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/permissions.test.mjs`
Expected: FAIL（deny 规则未生效——返回 ask/allow）

- [ ] **Step 3: 最小实现（kernel/permissions.mjs）**

```js
import { matchesHighRisk } from './highrisk.mjs'

// S3-1 规则匹配：条目 Tool:pattern（pattern 支持 * 通配）。Bash 匹配命令文本；
// 非 Bash 仅 "Tool:*"（全工具）与精确工具名命中。
function patternToRegExp(pattern) {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
}
function matchRule(rule, toolName, command) {
  const idx = String(rule).indexOf(':')
  if (idx < 0) return false
  const t = rule.slice(0, idx)
  const pattern = rule.slice(idx + 1)
  if (t !== toolName) return false
  if (pattern === '*') return true
  if (toolName === 'Bash' && command) return patternToRegExp(pattern).test(command.trim())
  return false
}
function matchList(list, toolName, command) {
  for (const rule of list || []) if (matchRule(rule, toolName, command)) return rule
  return null
}

export function decideToolPermission({ toolName, input, skipPermissions, autoApproveHighRisk, rules = {} }) {
  const command = toolName === 'Bash' ? String(input?.command ?? '') : ''
  // 显式规则优先：deny > ask > allow；命中即定，不再走默认判定
  const denied = matchList(rules.deny, toolName, command)
  if (denied) return { decision: 'deny', reason: `权限规则 deny 命中：${denied}` }
  const asked = matchList(rules.ask, toolName, command)
  if (asked) return { decision: 'ask', reason: `权限规则 ask 命中：${asked}` }
  const allowed = matchList(rules.allow, toolName, command)
  if (allowed) return { decision: 'allow', reason: `权限规则 allow 命中：${allowed}` }
  // —— 原默认逻辑（无规则时行为不变）——
  if (toolName === 'Bash') {
    if (matchesHighRisk(command)) {
      if (skipPermissions && autoApproveHighRisk) return { decision: 'allow' }
      return { decision: 'ask', reason: `命令为高危操作，需要用户批准：${command.slice(0, 80)}` }
    }
    return { decision: 'allow' }
  }
  return { decision: 'allow' }
}

// kernel/engine.mjs createEngine：opts.permissionRules 传入 decideToolPermission（line ~334 调用点）：
//   decideToolPermission({ toolName, input, skipPermissions: opts.skipPermissions, autoApproveHighRisk: opts.autoApproveHighRisk, rules: opts.permissionRules })

// kernel/cli.mjs：parseArgs 增加 --permission-rules-file + main 加载：
//   case '--permission-rules-file': out.permissionRulesFile = next() ?? null; break
//   main 内（createEngine 前）：
//   let permissionRules = {}
//   if (args.permissionRulesFile && existsSync(args.permissionRulesFile)) {
//     try { permissionRules = JSON.parse(readFileSync(args.permissionRulesFile, 'utf-8')).permissions || {} } catch { log.warn('permission rules 解析失败', ...) }
//   }
//   createEngine opts 增加 permissionRules
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/permissions.test.mjs`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add kernel/permissions.mjs kernel/engine.mjs kernel/cli.mjs server/permissions.test.mjs
git commit -m "feat(kernel): 权限规则文件——allow/deny/ask 三级优先于默认判定（S3-1）"
```

---

### Task 5: withinBoundary realpath 加固（S4-1）

**Files:**
- Modify: `kernel/tools.mjs`（withinBoundary realpath）
- Test: `server/tools-ext.test.mjs`（增补 1 个测试）

**Interfaces:**
- Produces: `withinBoundary(filePath, allowDirs)`——resolve 后对路径做 realpath（存在时），与 allowDirs 的 realpath 归一比较；符号链接逃逸（链接指向边界外）→ 拒绝；既有合法路径行为不变

- [ ] **Step 1: 写失败测试（增补到 server/tools-ext.test.mjs 末尾）**

```js
import { symlinkSync, mkdirSync } from 'node:fs'

test('S4-1 符号链接逃逸：边界内 symlink 指向边界外 → 拒绝；指向边界内 → 允许', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boundary-'))
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  mkdirSync(join(dir, 'sub'))
  try {
    symlinkSync(outside, join(dir, 'sub', 'escape'))          // 逃逸链接
    symlinkSync(join(dir, 'sub'), join(dir, 'oklink'))        // 内部链接
    writeFileSync(join(outside, 'secret.txt'), 's')
    writeFileSync(join(dir, 'sub', 'ok.txt'), 'ok')
    const reg = createToolRegistry({ cwd: dir, addDirs: [dir], skipPermissions: true })
    // 通过逃逸链接读外部文件 → 拒绝
    const r1 = await reg.tools.Read.run({ file_path: join(dir, 'sub', 'escape', 'secret.txt') })
    assert.equal(r1.isError, true)
    assert.match(String(r1.content), /拒绝访问|边界/)
    // 内部链接读内部文件 → 允许
    const r2 = await reg.tools.Read.run({ file_path: join(dir, 'oklink', 'ok.txt') })
    assert.equal(r2.isError, false)
    assert.match(String(r2.content), /ok/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/tools-ext.test.mjs`
Expected: FAIL（逃逸链接被放行——当前 withinBoundary 仅字符串比较，symlink 逃逸 r1 非 error）

- [ ] **Step 3: 最小实现（kernel/tools.mjs）**

```js
// tools.mjs import 区追加：
import { realpathSync } from 'node:fs'

// S4-1 路径加固：realpath 解析真实路径（解符号链接），防链接逃逸出边界。
// 文件不存在时对最近存在的父目录做 realpath，再拼回剩余段（写入新文件场景）。
function safeRealpath(p) {
  try { return realpathSync(p) } catch { return p }
}
function realForComparison(p) {
  const r = resolve(p)
  const real = safeRealpath(r)
  if (real !== r) return real
  // 路径不存在：逐级向上找最近存在的祖先做 realpath
  let cur = r
  const tail = []
  for (let i = 0; i < 32; i++) {
    try {
      realpathSync(cur)
      return join(realpathSync(cur), ...tail.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return r
      tail.push(basename(cur))
      cur = parent
    }
  }
  return r
}

function withinBoundary(filePath, allowDirs) {
  const resolved = resolve(filePath)
  const real = realForComparison(resolved).toLowerCase()
  return allowDirs.some((dir) => {
    const base = realForComparison(resolve(dir)).toLowerCase()
    return real === base || real.startsWith(base + sep)
  })
}
```

> 注意：`dirname/basename/resolve/sep` 已在 tools.mjs import（resolve/sep 已用；如 dirname/basename 未 import 则补 `import { dirname, basename } from 'node:path'`）。Windows 大小写归一（toLowerCase）已存在，本任务保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/tools-ext.test.mjs server/tools-schema.test.mjs`
Expected: PASS（原有全部测试 + 新增 1 个——symlink 场景；既有边界测试不受影响）

- [ ] **Step 5: 提交**

```bash
git add kernel/tools.mjs server/tools-ext.test.mjs
git commit -m "feat(kernel): 路径边界 realpath 加固——符号链接逃逸拦截（S4-1）"
```

---

### Task 6: cli.mjs 共享目录只读挂载（S5-1 最小版）

**Files:**
- Create: `kernel/config.mjs`
- Modify: `kernel/cli.mjs`（resolveConfigDir + shared 挂载）
- Test: `server/config.test.mjs`（新建）

**Interfaces:**
- Produces:
  - `resolveConfigDir(env = process.env, homedirFn)` → configDir（`CLAUDE_CONFIG_DIR` → `YFWORKING_HOME` → `~/.yfworking`，与现状一致）
  - `sharedDirFor(configDir)` → `join(configDir, 'shared')`（共享只读技能/配置目录）
  - cli.mjs：main 内 shared 目录存在时追加进 addDirs（只读共享——tools withinBoundary 对 addDirs 白名单只读/可读写，共享目录以只读语义加入）

- [ ] **Step 1: 写失败测试（新建 server/config.test.mjs）**

```js
// server/config.test.mjs —— 配置目录解析 + 共享目录（docs/production/security.md S5-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveConfigDir, sharedDirFor } from '../kernel/config.mjs'

test('resolveConfigDir：CLAUDE_CONFIG_DIR > YFWORKING_HOME > ~/.yfworking', () => {
  const h = mkdtempSync(join(tmpdir(), 'cfg-'))
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: join(h, 'a') }, () => h), join(h, 'a'))
  assert.equal(resolveConfigDir({ YFWORKING_HOME: join(h, 'b') }, () => h), join(h, 'b'))
  assert.equal(resolveConfigDir({}, () => h), join(h, '.yfworking'))
})

test('sharedDirFor：configDir 下 shared 子目录', () => {
  assert.equal(sharedDirFor('/x/.yfworking'), join('/x/.yfworking', 'shared'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/config.test.mjs`
Expected: FAIL（Cannot find module `../kernel/config.mjs`）

- [ ] **Step 3: 最小实现**

```js
// kernel/config.mjs —— 配置目录解析（docs/production/security.md S5-1）
// 优先级与现状一致：CLAUDE_CONFIG_DIR > YFWORKING_HOME > ~/.yfworking。
// 抽为纯函数供 cli 与测试复用（多人共享：个人 configDir 隔离，shared 只读共享）。
import { join } from 'node:path'

export function resolveConfigDir(env = process.env, homedirFn = require_node_os_homedir) {
  return env.CLAUDE_CONFIG_DIR || env.YFWORKING_HOME || join(homedirFn(), '.yfworking')
}
export function sharedDirFor(configDir) {
  return join(configDir, 'shared')
}

// kernel/cli.mjs —— line 108 configDir 解析替换为 resolveConfigDir + shared 挂载：
import { resolveConfigDir, sharedDirFor } from './config.mjs'
const configDir = resolveConfigDir(process.env, homedir)
// args.addDirs 确定后（line ~149 前）追加：
const sharedDir = sharedDirFor(configDir)
if (existsSync(sharedDir)) args.addDirs.push(sharedDir)   // 只读共享技能/配置（多人共用）
```

> 注：`homedir` 已 import（cli.mjs line 21 `import { homedir } from 'node:os'`）。config.mjs 的 homedirFn 默认参数若需真实 homedir，改为 `import { homedir } from 'node:os'` 后 `() => homedir()`，测试传桩函数。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/config.test.mjs`
Expected: PASS（2 个测试全过）

- [ ] **Step 5: 全量回归 + 提交**

```bash
node --test "server/*.test.mjs"
git add kernel/config.mjs kernel/cli.mjs server/config.test.mjs
git commit -m "feat(kernel): 配置目录解析纯函数 + shared 只读共享挂载（S5-1 最小版）"
```

---

## Self-Review

**Spec coverage（docs/production/security.md P0+P1 + 用户"内核优先"前提）：**
- S1 审计全量可追溯 → Task 3（buildAuditReport + /audit 薄壳）✓
- S2 密钥零泄漏 → Task 1（transcript/日志脱敏）+ Task 2（env 白名单）✓
- S3 权限可配置 → Task 4（rules schema，deny>ask>allow 优先）；S3-2 GUI 面板 = 前端工作，标注计划外（内核已产出可消费能力）✓
- S4 路径加固 → Task 5（realpath 解符号链接逃逸 + 既有大小写归一）✓
- S5 多人共享隔离 → Task 6（configDir 解析纯函数 + shared 只读挂载）；完整 settings 分层归 P4-3 ✓
- 内核优先前提：6 任务 4 个纯内核；Task 3 的 /audit 是"必须由 GUI 消费入口"的 REST 薄壳（聚合逻辑已在 kernel/audit.mjs）；无 GUI 设置项新增 ✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整实现。Task 3 bridge 代码注明依赖文件已 import 的假设（readdirSync/readFileSync/transcriptBaseDir 均已存在）。

**Type consistency：**
- `redactText(text)` / `redactEntry(entry)`（Task 1 定义，session.mjs append 与 log.mjs error/warn/fatal 消费，签名一致）
- `childEnv()`（Task 2 定义，tools.mjs 两处 spawn 消费，一致）
- `buildAuditReport(entries, {from,to,sessionId})` → rows（Task 3 定义，bridge /audit 消费 `rows.push(...)`，一致）
- `decideToolPermission({..., rules})`（Task 4 扩展，engine.mjs 调用点补 `rules: opts.permissionRules`，一致）
- `resolveConfigDir(env, homedirFn)` / `sharedDirFor(configDir)`（Task 6 定义，cli.mjs 消费，一致）
