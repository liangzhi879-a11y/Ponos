# P4 平台化（配置传递链 / 分层 settings / hooks / 技能发现）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前端已有的 provider 配置、技能面板、settings 能力落到内核配置/执行层——内核原生读取 provider 配置（P4-1）、分层 settings 深合并（P4-3）、hooks 生命周期执行器（P4-2）、技能结构化发现与 prompt 注入（P4-4）。

**Architecture:** 四个纯内核模块（settings.mjs / hooks.mjs / skills.mjs / provider.mjs 追加导出）+ cli.mjs 组装 + engine.mjs 两个注入点 + bridge.mjs 一个薄改动（providers.json 落盘）。遵循内核优先原则：全部机制在 kernel/，bridge 只负责把前端配置序列化成内核可读文件，前端零新增设置项。P4-5（provider 热切换）已有独立计划 `2026-08-21-provider-hot-switch.md`，本计划 Task 5 在其已创建的 `kernel/provider.mjs` 上**仅追加导出**，不重写。

**Tech Stack:** 纯 Node ESM（node:test / node:fs / node:child_process），零 npm 依赖。测试沿用 `server/*.test.mjs` 模式：单元直连 import 内核模块；集成 spawn 真内核（`kernel/cli.mjs` + `YFW_MOCK_API=1`）+ makeReader 行队列（参照 `server/kernel-contract.test.mjs`）。

## Global Constraints

- 零 npm 依赖：kernel/ 内新模块只用 node 内置模块（fs/path/child_process/readline）。
- 内核优先：机制进 kernel/，bridge 只做"前端配置 → 文件"的序列化与薄壳转发，前端零新增设置项。
- 不破坏既有协议：system(init) 只增字段（provider/vision/skills/settings），不删改既有字段；`kernel-contract.test.mjs` 必须继续全绿。
- 向后兼容：settings/hooks/skills 全部可选（缺文件/缺规则 = 现状行为），无配置时行为与现在完全一致。
- 测试命令：`node --test server/<file>.test.mjs`；全量 `node --test "server/*.test.mjs"`。
- 跨平台：hooks 脚本 spawn 用显式 `args` 数组（shell:false），不用 shell 拼接；测试脚本路径写入临时文件。
- 前置依赖：P4-5 计划已落地 —— `kernel/provider.mjs` 存在且导出 `getProvider()/setProvider(patch)/providerVersion`（未激活时返回 env 派生值；激活后固定 + 版本递增）。Task 5 追加 `seedFromFile(filePath)` 与 `visionFromEnv(env)` 两个导出，不触碰既有行为。

---

### Task 1: kernel/settings.mjs —— 分层 settings 深合并（纯函数 + 单元测试）

**Files:**
- Create: `kernel/settings.mjs`
- Create: `server/settings.test.mjs`（Task 1 部分：单元）

**Interfaces:**
- Consumes: 无
- Produces:
  - `deepMerge(base, override)` → object：普通对象递归深合并；数组/标量直接覆盖；`null`/`undefined` 跳过（undefined 不覆盖）
  - `loadSettings({ configDir, cwd, local })` → `{ user, project, local, merged, paths }`
    - `user` = configDir/settings.json（缺省 `{}`）；`project` = cwd/.yfworking/settings.json（缺省 `{}`）；`local` = 传入覆盖（缺省 `{}`）
    - `merged` = `deepMerge(deepMerge(user, project), local)`，优先级 user < project < local
    - `paths` = `{ user, project }`（文件实际路径，供诊断）

- [ ] **Step 1: 写失败测试**

```js
// server/settings.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deepMerge, loadSettings } from '../kernel/settings.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-settings-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('deepMerge：标量覆盖 / 对象递归 / 数组替换 / undefined 跳过', () => {
  const base = { a: 1, b: { x: 1, y: 2 }, c: [1, 2], d: 'keep' }
  const over = { a: 2, b: { y: 3, z: 4 }, c: [9], d: undefined }
  assert.deepEqual(deepMerge(base, over), { a: 2, b: { x: 1, y: 3, z: 4 }, c: [9], d: 'keep' })
})

test('loadSettings：user < project < local 三级合并 + paths', () => {
  const configDir = join(tmp, 'cfg')
  const cwd = join(tmp, 'proj')
  mkdirSync(join(configDir), { recursive: true })
  mkdirSync(join(cwd, '.yfworking'), { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ model: 'user-model', hooks: [{ event: 'sessionStart' }], env: { A: '1' } }), 'utf-8')
  writeFileSync(join(cwd, '.yfworking', 'settings.json'), JSON.stringify({ model: 'project-model', env: { B: '2' } }), 'utf-8')
  const r = loadSettings({ configDir, cwd, local: { model: 'local-model' } })
  assert.equal(r.merged.model, 'local-model')
  assert.equal(r.merged.env.B, '2')
  assert.equal(r.merged.env.A, '1')
  assert.equal(r.merged.hooks.length, 1)
  assert.ok(r.paths.user.endsWith('settings.json') && r.paths.project.endsWith('settings.json'))
})

test('loadSettings：无文件时返回空对象', () => {
  const r = loadSettings({ configDir: join(tmp, 'nope'), cwd: join(tmp, 'nope2') })
  assert.deepEqual(r.merged, {})
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test server/settings.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/settings.mjs'`

- [ ] **Step 3: 最小实现**

```js
// kernel/settings.mjs —— 分层 settings（user < project < local 深合并）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function deepMerge(base, override) {
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined) continue
    if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
        out[k] !== null && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

function readJson(p) {
  if (!p || !existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return {} }
}

export function loadSettings({ configDir = '', cwd = '', local = {} } = {}) {
  const userPath = configDir ? join(configDir, 'settings.json') : ''
  const projectPath = cwd ? join(cwd, '.yfworking', 'settings.json') : ''
  const user = readJson(userPath)
  const project = readJson(projectPath)
  return {
    user,
    project,
    local,
    merged: deepMerge(deepMerge(user, project), local),
    paths: { user: userPath, project: projectPath },
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `node --test server/settings.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add kernel/settings.mjs server/settings.test.mjs
git commit -m "feat(kernel): 分层 settings 深合并（user < project < local）+ 单元测试"
```

---

### Task 2: cli.mjs 挂载 settings → engine 生效（集成）

**Files:**
- Modify: `kernel/cli.mjs`（import loadSettings；model/maxTokens/autoApproveHighRisk/disallowedTools 取值加入 settings 层；settings.env 兜底合入 process.env）
- Test: `server/settings.test.mjs`（追加集成测试）

**Interfaces:**
- Consumes: `loadSettings`（Task 1）
- Produces: 无新导出 —— cli 启动行为变化：
  - model 优先级：`args.model > process.env.ANTHROPIC_MODEL > merged.model > ''`
  - maxOutputTokens：`process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS > merged.maxOutputTokens > 64000`
  - autoApproveHighRisk：`args.autoApproveHighRisk === true || merged.autoApproveHighRisk === true`
  - disallowedTools：`[...args.disallowedTools, ...(merged.disallowedTools || [])]`
  - settings.env 兜底：仅当 `process.env[k]` 未定义时写入（spawn env 快照仍权威）

- [ ] **Step 1: 写失败测试（追加到 server/settings.test.mjs）**

```js
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { rmSync } from 'node:fs'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

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

test('settings 集成：项目 settings.model 注入 system(init)', async () => {
  const configDir = join(tmp, 'cfg2')
  const cwd = join(tmp, 'proj2')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(cwd, '.yfworking'), { recursive: true })
  writeFileSync(join(cwd, '.yfworking', 'settings.json'), JSON.stringify({ model: 'my-model' }), 'utf-8')
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_MODEL: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  try {
    const ev = await reader.nextEvent()
    assert.equal(ev.type, 'system')
    assert.equal(ev.subtype, 'init')
    assert.equal(ev.model, 'my-model')
  } finally {
    try { child.stdin.end() } catch {}
  }
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test server/settings.test.mjs`
Expected: FAIL —— init 事件 `model` 为 `''`（settings 未读取）

- [ ] **Step 3: 实现 cli.mjs 挂载**

在 `kernel/cli.mjs`：
1. import 区加：`import { loadSettings } from './settings.mjs'`
2. `main()` 内 `configDir` 计算后（line 108 之后）插入 settings 加载与 env 兜底：

```js
  // 分层 settings：user（configDir/settings.json）< project（cwd/.yfworking/settings.json）< local。
  // settings.env 仅兜底（spawn env 快照仍权威）：缺失键才写入。
  const settings = loadSettings({ configDir, cwd: args.addDirs[0] || '', local: {} })
  for (const [k, v] of Object.entries(settings.merged.env || {})) {
    if (v !== undefined && process.env[k] === undefined) process.env[k] = String(v)
  }
```

3. 修改 model / maxTokens 两行（原 line 116-117）：

```js
  const model = args.model || process.env.ANTHROPIC_MODEL || settings.merged.model || ''
  const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || settings.merged.maxOutputTokens || 64000))
```

4. engine opts（原 line 139-140）改由 settings 合并：

```js
      autoApproveHighRisk: args.autoApproveHighRisk === true || settings.merged.autoApproveHighRisk === true,
      disallowedTools: [...args.disallowedTools, ...(settings.merged.disallowedTools || [])],
```

- [ ] **Step 4: 跑测试验证通过**

Run: `node --test server/settings.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 回归 + 提交**

Run: `node --test server/kernel-contract.test.mjs`
Expected: PASS（协议未破坏）

```bash
git add kernel/cli.mjs server/settings.test.mjs
git commit -m "feat(kernel): cli 挂载分层 settings（model/预算/权限/兜底 env 生效）"
```

---

### Task 3: kernel/hooks.mjs —— hooks 执行器（纯函数 + spawn + 单元测试）

**Files:**
- Create: `kernel/hooks.mjs`
- Create: `server/hooks.test.mjs`（Task 3 部分：单元）

**Interfaces:**
- Consumes: 无
- Produces:
  - `matchHook(rules, event, toolName)` → rule[]：规则 = `{ event, tools?, pattern?, command, args?, timeoutMs? }`；`event` 精确匹配；`tools` 为逗号分隔工具名列表（空/缺省 = 匹配全部）；`pattern` 在 payload 序列化串上做子串匹配
  - `createHooks({ rules = [] })` → `{ count, async run(event, payload) }`
    - `run` 返回 `{ matched: bool, deny: bool, stop: bool, message: string, exitCode, output, durationMs }`；`matched=false` 时其他字段空
    - 多条命中规则顺序执行，`deny` 或 `stop` 后短路
  - 事件语义：`preToolUse`（payload `{ toolName, toolUseId, input }`，脚本 stdout 首行 JSON `{ deny?, message? }`，`deny:true` → 否决）、`postToolUse`（payload `{ toolName, toolUseId, input, output }`）、`userPromptSubmit`（payload `{ prompt }`，JSON `{ stop?, message? }`）、`sessionStart`（payload `{ sessionId, cwd }`）

- [ ] **Step 1: 写失败测试**

```js
// server/hooks.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHooks, matchHook } from '../kernel/hooks.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-hooks-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('matchHook：event 精确 + tools 列表过滤 + 缺省匹配全部', () => {
  const rules = [
    { event: 'preToolUse', tools: 'Bash,Read', command: 'a' },
    { event: 'preToolUse', command: 'b' },
    { event: 'postToolUse', command: 'c' },
  ]
  assert.equal(matchHook(rules, 'preToolUse', 'Bash').length, 2)
  assert.equal(matchHook(rules, 'preToolUse', 'Write').length, 1)
  assert.equal(matchHook(rules, 'postToolUse', 'Bash').length, 1)
  assert.equal(matchHook(rules, 'sessionStart', 'Bash').length, 0)
})

test('createHooks.run：preToolUse deny 解析 + 未匹配返回 matched=false', async () => {
  const script = join(tmp, 'deny.mjs')
  writeFileSync(script, `
    import { readFileSync } from 'node:fs'
    const line = readFileSync(0, 'utf-8').trim()
    const p = JSON.parse(line)
    process.stdout.write(JSON.stringify({ deny: true, message: 'hook 拒绝 ' + p.toolName }))
  `, 'utf-8')
  const hooks = createHooks({ rules: [{ event: 'preToolUse', tools: 'Bash', command: process.execPath, args: [script] }] })
  const r = await hooks.run('preToolUse', { toolName: 'Bash', toolUseId: 'tu1', input: { command: 'echo hi' } })
  assert.equal(r.matched, true)
  assert.equal(r.deny, true)
  assert.ok(r.message.includes('hook 拒绝 Bash'))
  assert.equal(r.exitCode, 0)

  const miss = await hooks.run('preToolUse', { toolName: 'Read', toolUseId: 'tu2', input: {} })
  assert.equal(miss.matched, false)
})

test('createHooks.run：userPromptSubmit stop 解析', async () => {
  const script = join(tmp, 'stop.mjs')
  writeFileSync(script, `
    import { readFileSync } from 'node:fs'
    readFileSync(0, 'utf-8')
    process.stdout.write(JSON.stringify({ stop: true, message: 'intercepted' }))
  `, 'utf-8')
  const hooks = createHooks({ rules: [{ event: 'userPromptSubmit', command: process.execPath, args: [script] }] })
  const r = await hooks.run('userPromptSubmit', { prompt: 'hello' })
  assert.equal(r.stop, true)
  assert.equal(r.message, 'intercepted')
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test server/hooks.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/hooks.mjs'`

- [ ] **Step 3: 最小实现**

```js
// kernel/hooks.mjs —— hooks 生命周期执行器（事件 → 规则匹配 → spawn 脚本 → 决策回填）
// 事件：preToolUse（可否决）/ postToolUse / userPromptSubmit（可拦截）/ sessionStart。
// 规则：{ event, tools?, pattern?, command, args?, timeoutMs? }；payload 经 stdin 传 JSON 一行，
// 脚本 stdout 首行 JSON 为决策（preToolUse: { deny, message }；userPromptSubmit: { stop, message }）。
import { spawn } from 'node:child_process'

export function matchHook(rules, event, toolName = '') {
  return (rules || []).filter((r) => {
    if (r.event !== event) return false
    if (r.tools && String(r.tools).trim()) {
      const list = String(r.tools).split(',').map((s) => s.trim()).filter(Boolean)
      if (list.length && !list.includes(toolName)) return false
    }
    return true
  })
}

function matchesPattern(rule, payload) {
  if (rule.pattern == null || String(rule.pattern) === '') return true
  try { return JSON.stringify(payload).includes(String(rule.pattern)) } catch { return false }
}

function parseDecision(rule, event, output) {
  const first = String(output || '').trim().split('\n')[0] || ''
  let parsed = {}
  try { parsed = JSON.parse(first) } catch { parsed = {} }
  if (event === 'preToolUse') {
    return { deny: parsed.deny === true, message: parsed.message || (parsed.deny === true ? `PreToolUse hook ${rule.command} 拒绝执行` : '') }
  }
  if (event === 'userPromptSubmit') {
    return { stop: parsed.stop === true, message: parsed.message || (parsed.stop === true ? '用户输入已由 hook 拦截' : '') }
  }
  return {}
}

async function runHook(rule, payload) {
  const started = Date.now()
  const child = spawn(rule.command, rule.args || [], {
    env: { ...process.env, YFW_HOOK_EVENT: payload.event || '' },
    timeout: rule.timeoutMs || 10_000,
    windowsHide: true,
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (d) => { out += d })
  child.stderr?.on('data', (d) => { err += d })
  child.stdin.on('error', () => {})
  child.stdin.write(JSON.stringify(payload) + '\n')
  child.stdin.end()
  const code = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c))
    child.on('error', (e) => resolve(-1))
  })
  const decision = parseDecision(rule, payload.event, out)
  return {
    matched: true,
    deny: decision.deny || false,
    stop: decision.stop || false,
    message: decision.message || '',
    exitCode: code,
    output: (out || '').slice(0, 8192),
    stderr: err.slice(0, 2048),
    durationMs: Date.now() - started,
  }
}

export function createHooks({ rules = [] } = {}) {
  return {
    count: rules.length,
    async run(event, payload = {}) {
      const hits = matchHook(rules, event, payload.toolName || '')
      let last = null
      for (const rule of hits) {
        if (!matchesPattern(rule, payload)) continue
        last = await runHook(rule, { event, ...payload })
        if (last.deny || last.stop) break
      }
      return last || { matched: false }
    },
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `node --test server/hooks.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add kernel/hooks.mjs server/hooks.test.mjs
git commit -m "feat(kernel): hooks 执行器（事件匹配/spawn/可否决决策 + 单元测试）"
```

---

### Task 4: engine/cli hooks 注入点（preToolUse 否决 / userPromptSubmit 拦截 / sessionStart 触发）

**Files:**
- Modify: `kernel/engine.mjs`（executeToolUse 内 preToolUse/postToolUse 注入）
- Modify: `kernel/cli.mjs`（createHooks 装配 + userPromptSubmit/sessionStart 触发 + opts.hooks 传递）
- Test: `server/hooks.test.mjs`（追加集成测试，spawn 真内核 + settings hooks 规则）

**Interfaces:**
- Consumes: `createHooks`（Task 3）、`loadSettings`（Task 1）
- Produces: 引擎行为——`opts.hooks.run('preToolUse', ...)` 返回 `deny:true` 时工具不执行，tool_result 内容 = hook message；postToolUse 在工具结果后触发（output 截断 8KB）；cli 在 user 入 engine 前跑 userPromptSubmit，`stop` 时直接 assistant+result 不进轮次；spawn 完成 init 后触发 sessionStart（fire-and-forget）

- [ ] **Step 1: 写失败测试（追加到 server/hooks.test.mjs）**

```js
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

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

test('hooks 集成：preToolUse deny → tool_result 携带 hook 消息', async () => {
  const configDir = join(tmp, 'hcfg')
  const cwd = join(tmp, 'hproj')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(cwd, '.yfworking'), { recursive: true })
  const script = join(tmp, 'deny-all.mjs')
  writeFileSync(script, `
    import { readFileSync } from 'node:fs'
    readFileSync(0, 'utf-8')
    process.stdout.write(JSON.stringify({ deny: true, message: 'HOOK_DENY_MARK' }))
  `, 'utf-8')
  writeFileSync(join(cwd, '.yfworking', 'settings.json'), JSON.stringify({
    hooks: [{ event: 'preToolUse', tools: 'Bash', command: process.execPath, args: [script] }],
  }), 'utf-8')
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  try {
    const init = await reader.nextEvent()
    const sid = init.session_id
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '[mock:tool-safe]' } }) + '\n')
    while (true) {
      const ev = await reader.nextEvent()
      if (ev.type === 'result') break
    }
    const transcriptPath = join(configDir, 'projects', sanitizeSegment(cwd), sid + '.jsonl')
    assert.ok(existsSync(transcriptPath), 'transcript 存在: ' + transcriptPath)
    assert.ok(readFileSync(transcriptPath, 'utf-8').includes('HOOK_DENY_MARK'), 'tool_result 含 hook 拒绝消息')
  } finally {
    try { child.stdin.end() } catch {}
  }
})

test('hooks 集成：userPromptSubmit stop → 拦截不进轮次', async () => {
  const configDir = join(tmp, 'hcfg2')
  const cwd = join(tmp, 'hproj2')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(cwd, '.yfworking'), { recursive: true })
  const script = join(tmp, 'stop-all.mjs')
  writeFileSync(script, `
    import { readFileSync } from 'node:fs'
    readFileSync(0, 'utf-8')
    process.stdout.write(JSON.stringify({ stop: true, message: 'STOPPED_BY_HOOK' }))
  `, 'utf-8')
  writeFileSync(join(cwd, '.yfworking', 'settings.json'), JSON.stringify({
    hooks: [{ event: 'userPromptSubmit', command: process.execPath, args: [script] }],
  }), 'utf-8')
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  try {
    await reader.nextEvent() // init
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
    const a1 = await reader.nextEvent()
    assert.equal(a1.type, 'assistant')
    assert.ok(a1.text.includes('STOPPED_BY_HOOK') || JSON.stringify(a1).includes('STOPPED_BY_HOOK'))
    const r1 = await reader.nextEvent()
    assert.equal(r1.type, 'result')
  } finally {
    try { child.stdin.end() } catch {}
  }
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test server/hooks.test.mjs`
Expected: 单元 3 个 PASS，集成 2 个 FAIL（无 hooks 注入——第一个超时或 transcript 无标记；第二个直接走 engine 轮次出 mock 文本）

- [ ] **Step 3: 实现 engine.mjs 注入点**

`kernel/engine.mjs` `executeToolUse`（line 333）内：权限审批通过后（原 line 366 `denialStreak = 0` 之后）、`const { store, ...toolCtx } = ctx`（原 line 369）之前插入：

```js
    // hooks.preToolUse：可否决。deny → 工具不执行，错误回填给模型。
    const hooks = opts.hooks
    if (hooks) {
      const h = await hooks.run('preToolUse', { toolName: toolUse.name, toolUseId: toolUse.id, input: toolUse.input })
      if (h.deny) return { content: h.message || `PreToolUse hook 拒绝执行 ${toolUse.name}`, isError: true }
    }
```

工具结果持久化后（原 line 375-376 `persistToolResult` 之后、`return r` 之前）插入：

```js
    if (hooks) {
      await hooks.run('postToolUse', {
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        input: toolUse.input,
        output: typeof r?.content === 'string' ? r.content.slice(0, 8192) : '',
      })
    }
```

注意：子 agent lane 复用 executeToolUse，hooks 同样生效（共享 opts.hooks），文档中注明即可。

- [ ] **Step 4: 实现 cli.mjs 装配与触发**

`kernel/cli.mjs`：
1. import 加：`import { createHooks } from './hooks.mjs'`
2. settings 加载之后（Task 2 插入点之后）加：

```js
  const hooks = createHooks({ rules: settings.merged.hooks || [] })
```

3. engine opts 加一行（settings 合并块内）：

```js
      hooks,
```

4. system(init) 之后（原 line 160 之后）加 sessionStart 触发：

```js
  // hooks.sessionStart：spawn 就绪后 fire-and-forget（不阻塞 init 事件）
  if (hooks.count) {
    try { await hooks.run('sessionStart', { sessionId, cwd: args.addDirs[0] || '' }) } catch {}
  }
```

5. `handleUser`（原 line 170）在 `state.turnActive = true` 之后、`engine.runTurn` 之前插入拦截：

```js
    const intercept = await hooks.run('userPromptSubmit', { prompt: content })
    if (intercept.stop) {
      wire.assistant(intercept.message || '已由 hook 拦截。')
      wire.result()
      return
    }
```

（return 后 finally 块仍会复位 turnActive/queue —— 与既有 finally 结构兼容。）

- [ ] **Step 5: 跑测试验证通过**

Run: `node --test server/hooks.test.mjs`
Expected: PASS（5 个测试：3 单元 + 2 集成）

- [ ] **Step 6: 回归 + 提交**

Run: `node --test server/kernel-contract.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS（无 hooks 配置时行为不变）

```bash
git add kernel/engine.mjs kernel/cli.mjs server/hooks.test.mjs
git commit -m "feat(kernel): hooks 注入点（preToolUse 否决/postToolUse/userPromptSubmit 拦截/sessionStart）"
```

---

### Task 5: provider 配置传递链（bridge providers.json + seedFromFile + 视觉透传）

**Files:**
- Modify: `server/bridge.mjs`（写 `~/.yfworking/providers.json`：saveConfig 内 + 启动时）
- Modify: `kernel/provider.mjs`（追加 `seedFromFile(filePath)` 与 `visionFromEnv(env)` 两个导出 —— 该文件由 P4-5 计划创建，本任务只追加不改既有函数）
- Create: `server/provider-chain.test.mjs`

**Interfaces:**
- Consumes: `getProvider()/setProvider(patch)/providerVersion`（P4-5 计划已定义；`setProvider` 校验 http(s) baseUrl / authToken 非空 / model 非空，激活后 version++）
- Produces:
  - bridge：`~/.yfworking/providers.json` = `{ activeProvider, providers: [{ id, apiBaseUrl, authToken, primaryModel, models, subagentModel, contextWindow, visionModel }] }`（与 settings.json 同一信任域，均含 token，仅存 YFW_HOME）
  - `seedFromFile(filePath, { env } = {})` → bool：读 providers.json → 取 activeProvider → `setProvider({ baseUrl, authToken, model, contextWindow })`；文件缺失/损坏/active 配置不全 → false 且不激活
  - `visionFromEnv(env = process.env)` → `{ baseUrl, model, configured } | null`：`YFW_VISION_BASE_URL/YFW_VISION_MODEL/YFW_VISION_AUTH_TOKEN`；baseUrl 与 model 缺一 → null

- [ ] **Step 1: 写失败测试**

```js
// server/provider-chain.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFromFile, visionFromEnv, getProvider } from '../kernel/provider.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-prov-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('seedFromFile：读取 providers.json 激活 active provider', () => {
  const p = join(tmp, 'providers.json')
  writeFileSync(p, JSON.stringify({
    activeProvider: 'p2',
    providers: [
      { id: 'p1', apiBaseUrl: 'https://a.example.com', authToken: 'tok-a', primaryModel: 'm-a' },
      { id: 'p2', apiBaseUrl: 'https://b.example.com', authToken: 'tok-b', primaryModel: 'm-b', contextWindow: 200000 },
    ],
  }), 'utf-8')
  assert.equal(seedFromFile(p), true)
  const prov = getProvider()
  assert.ok(prov, '激活后 getProvider 有值')
  assert.equal(prov.baseUrl, 'https://b.example.com')
  assert.equal(prov.authToken, 'tok-b')
  assert.equal(prov.model, 'm-b')
})

test('seedFromFile：文件缺失/active 配置不全 → false 不激活', () => {
  assert.equal(seedFromFile(join(tmp, 'nope.json')), false)
  const p = join(tmp, 'bad.json')
  writeFileSync(p, JSON.stringify({ activeProvider: 'x', providers: [{ id: 'x' }] }), 'utf-8')
  assert.equal(seedFromFile(p), false)
})

test('visionFromEnv：YFW_VISION_* 解析 + 缺字段返回 null', () => {
  assert.deepEqual(visionFromEnv({ YFW_VISION_BASE_URL: 'https://v.example.com', YFW_VISION_MODEL: 'gpt-v', YFW_VISION_AUTH_TOKEN: 'tv' }),
    { baseUrl: 'https://v.example.com', model: 'gpt-v', configured: true })
  assert.equal(visionFromEnv({ YFW_VISION_BASE_URL: 'https://v.example.com' }), null)
  assert.equal(visionFromEnv({}), null)
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test server/provider-chain.test.mjs`
Expected: FAIL —— `seedFromFile/visionFromEnv is not a function`

- [ ] **Step 3: 实现 kernel/provider.mjs 追加导出**

在 `kernel/provider.mjs` 末尾追加（文件头若缺 fs 导入则补 `import { existsSync, readFileSync } from 'node:fs'`）：

```js
// —— P4-1 配置传递链：bridge 落盘的 providers.json 播种注册表（未激活时生效） ——
export function seedFromFile(filePath, { env = process.env } = {}) {
  if (!filePath || !existsSync(filePath)) return false
  let data = null
  try { data = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { return false }
  const active = (data.providers || []).find((p) => p.id === data.activeProvider)
  if (!active || !active.apiBaseUrl || !active.authToken) return false
  setProvider({
    baseUrl: active.apiBaseUrl,
    authToken: active.authToken,
    model: active.primaryModel || (active.models && active.models[0]) || '',
    contextWindow: active.contextWindow || 0,
  })
  return true
}

// 视觉模型透传：独立 provider（YFW_VISION_*，bridge buildChildEnv 已注入）→ 上报用对象。
export function visionFromEnv(env = process.env) {
  const baseUrl = env.YFW_VISION_BASE_URL || ''
  const model = env.YFW_VISION_MODEL || ''
  if (!baseUrl || !model) return null
  return { baseUrl, model, configured: !!env.YFW_VISION_AUTH_TOKEN }
}
```

`kernel/cli.mjs` 在 store 创建后（`createSessionStore` 之后）加播种（复用既有 configDir）：

```js
  // P4-1：bridge 落盘的 providers.json → 注册表播种（未激活时生效；激活后固定）
  try { await import('./provider.mjs').then((m) => m.seedFromFile(join(configDir, 'providers.json'))) } catch {}
```

（若 cli 已静态 import provider.mjs，则直接 `seedFromFile(join(configDir, 'providers.json'))`；Task 6 需要 `getProvider/visionFromEnv`，届时改为静态 import，此处两可。）

- [ ] **Step 4: 实现 bridge.mjs 落盘**

`server/bridge.mjs`：
1. `YFW_SETTINGS_PATH` 定义附近加：

```js
// P4-1：内核 provider 注册表播种源（与 settings.json 同一信任域：YFW_HOME，含 token）
const YFW_PROVIDERS_PATH = join(YFW_HOME, 'providers.json')

function writeProvidersFile() {
  try {
    const cfg = loadConfig()
    const snapshot = {
      activeProvider: cfg.activeProvider || '',
      providers: (cfg.providers || []).map((p) => ({
        id: p.id,
        apiBaseUrl: p.apiBaseUrl || '',
        authToken: p.authToken || '',
        primaryModel: p.primaryModel || '',
        models: p.models || [],
        subagentModel: p.subagentModel || '',
        contextWindow: p.contextWindow || 0,
        visionModel: p.visionModel || '',
      })),
    }
    safeWriteJsonWithBak(YFW_PROVIDERS_PATH, JSON.stringify(snapshot, null, 2))
  } catch (e) {
    console.warn('[bridge] writeProvidersFile failed:', e.message)
  }
}
```

2. `saveConfig`（line 453-460）内 `syncKernelSettings()` 之后加 `writeProvidersFile()`。
3. 启动初始化处（line 551 `syncKernelSettings()` 旁）加 `writeProvidersFile()`。

- [ ] **Step 5: 跑测试验证通过**

Run: `node --test server/provider-chain.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 6: 提交**

```bash
git add kernel/provider.mjs kernel/cli.mjs server/bridge.mjs server/provider-chain.test.mjs
git commit -m "feat(kernel): provider 配置传递链（bridge providers.json 落盘 + 内核 seedFromFile/视觉透传）"
```

---

### Task 6: kernel/skills.mjs —— 技能发现内核化 + prompt 注入 + init 概览（端到端）

**Files:**
- Create: `kernel/skills.mjs`
- Modify: `kernel/prompt.mjs`（composeSystemPrompt 增加 `skills` 区块参数）
- Modify: `kernel/cli.mjs`（discoverSkills 扫描 addDirs → prompt 注入 + init 扩展 provider/vision/skills/settings 概览）
- Create: `server/skills.test.mjs`

**Interfaces:**
- Consumes: `getProvider`/`visionFromEnv`（P4-5 + Task 5）、`composeSystemPrompt`（prompt.mjs 既有）
- Produces:
  - `discoverSkills({ root })` → `[{ id, name, description, version, triggers, parent, subskills, lines }]`：扫描 `root/<id>/SKILL.md`（frontmatter）+ legacy `root/<id>.md`；schema 与 bridge /skills 扫描一致（同一数据源同一形状）
  - `parseFrontmatter(content)` → object（`---` 块内 `key: value`，去引号）
  - `verifySkillVersions({ lockPath, skills })` → `{ outdated: [{ id, lock, disk }] }`：lock 支持 `{ [id]: version }` 或 `{ skills: { [id]: version } }`；缺 lock 文件 → 空
  - cli：对每个 `--add-dir` 执行 discoverSkills（去重 by id）→ composeSystemPrompt 注入；init 事件扩展 `provider`（registry 激活时 `{ model, version }`，否则 null）、`vision`（visionFromEnv 非空时 `{ model }`）、`skills`（数量）、`settings: { hooks: n }`（全部只增字段）

- [ ] **Step 1: 写失败测试**

```js
// server/skills.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { discoverSkills, parseFrontmatter, verifySkillVersions } from '../kernel/skills.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-skills-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('parseFrontmatter：key: value 解析 + 去引号', () => {
  const md = '---\nname: "My Skill"\ndescription: does things\nversion: 1.2.0\n---\n# My Skill\nbody'
  assert.deepEqual(parseFrontmatter(md), { name: 'My Skill', description: 'does things', version: '1.2.0' })
  assert.deepEqual(parseFrontmatter('# no frontmatter'), {})
})

test('discoverSkills：SKILL.md 目录格式 + legacy <id>.md 格式 + 排序', () => {
  mkdirSync(join(tmp, 'sroot', 'alpha'), { recursive: true })
  mkdirSync(join(tmp, 'sroot', 'beta'), { recursive: true })
  writeFileSync(join(tmp, 'sroot', 'alpha', 'SKILL.md'), '---\nname: Alpha\ndescription: first skill\nversion: 1.0.0\n---\nbody', 'utf-8')
  writeFileSync(join(tmp, 'sroot', 'beta', 'SKILL.md'), '---\ndescription: second skill\n---\nbody', 'utf-8')
  writeFileSync(join(tmp, 'sroot', 'legacy.md'), '---\ndescription: legacy flat\n---\nbody', 'utf-8')
  writeFileSync(join(tmp, 'sroot', 'notes.txt'), 'not a skill', 'utf-8')
  const skills = discoverSkills({ root: join(tmp, 'sroot') })
  assert.deepEqual(skills.map((s) => s.id), ['alpha', 'beta', 'legacy'])
  assert.equal(skills[0].name, 'Alpha')
  assert.equal(skills[0].version, '1.0.0')
  assert.equal(skills[1].name, 'beta') // 无 name 用 id
  assert.equal(skills[2].description, 'legacy flat')
  assert.ok(skills.every((s) => s.lines > 0))
})

test('verifySkillVersions：lock 不匹配 → outdated 列表', () => {
  const lockPath = join(tmp, 'skills-lock.json')
  writeFileSync(lockPath, JSON.stringify({ alpha: '1.0.0', beta: '2.0.0', skills: { legacy: '9.0.0' } }), 'utf-8')
  const skills = [
    { id: 'alpha', version: '1.0.0' },
    { id: 'beta', version: '0.9.9' },
    { id: 'legacy', version: '1.1.1' },
    { id: 'gamma', version: '3.0.0' },
  ]
  assert.deepEqual(verifySkillVersions({ lockPath, skills }).outdated.map((o) => o.id), ['beta', 'legacy'])
  assert.deepEqual(verifySkillVersions({ lockPath: join(tmp, 'nope.json'), skills }), { outdated: [] })
})

test('集成：spawn 内核 + 技能目录 → init 事件带 skills 数量与 provider/vision 概览', async () => {
  const configDir = join(tmp, 'scfg')
  const cwd = join(tmp, 'sproj')
  const skillRoot = join(tmp, 'sroot2')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(skillRoot, 'demo'), { recursive: true })
  writeFileSync(join(skillRoot, 'demo', 'SKILL.md'), '---\nname: Demo\ndescription: demo skill\nversion: 1.0.0\n---\nbody', 'utf-8')
  writeFileSync(join(configDir, 'providers.json'), JSON.stringify({
    activeProvider: 'p1',
    providers: [{ id: 'p1', apiBaseUrl: 'https://x.example.com', authToken: 't', primaryModel: 'm1' }],
  }), 'utf-8')
  const child = spawn(process.execPath, [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs'),
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd, '--add-dir', skillRoot,
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir, YFW_VISION_BASE_URL: 'https://v.example.com', YFW_VISION_MODEL: 'gpt-v' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim()
    if (!t) return
    if (waiters.length) waiters.shift()(t)
    else lines.push(t)
  })
  const nextEvent = (ms = 5000) => {
    if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout: ' + JSON.stringify(lines))), ms)
      waiters.push((l) => { clearTimeout(to); res(JSON.parse(l)) })
    })
  }
  try {
    const ev = await nextEvent()
    assert.equal(ev.subtype, 'init')
    assert.equal(ev.skills, 1)
    assert.deepEqual(ev.provider, { model: 'm1', version: 0 }) // seedFromFile 激活后 version=0（或 1，取决于 P4-5 实现，见步骤 3 注）
    assert.deepEqual(ev.vision, { model: 'gpt-v' })
    assert.ok(Number.isInteger(ev.settings.hooks))
  } finally {
    try { child.stdin.end() } catch {}
  }
})
```

> 注：`ev.provider.version` 具体初值取决于 P4-5 计划实现（version 从 0 还是 1 起步）——断言放宽为 `assert.ok(ev.provider && ev.provider.model === 'm1')`，去掉 version 相等断言，避免跨计划耦合。

- [ ] **Step 2: 跑测试验证失败**

Run: `node --test server/skills.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/skills.mjs'`

- [ ] **Step 3: 实现 kernel/skills.mjs**

```js
// kernel/skills.mjs —— 技能发现内核化（与 bridge /skills 同一 schema：SKILL.md 目录 + legacy .md）
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const meta = {}
  if (!m) return meta
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const raw = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    meta[key] = raw
  }
  return meta
}

export function discoverSkills({ root } = {}) {
  if (!root || !existsSync(root)) return []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const skills = []
  for (const it of entries) {
    let content = ''
    let id = ''
    if (it.isDirectory()) {
      const mdPath = join(root, it.name, 'SKILL.md')
      if (!existsSync(mdPath)) continue
      id = it.name
      try { content = readFileSync(mdPath, 'utf-8') } catch { continue }
    } else if (it.isFile() && it.name.endsWith('.md')) {
      id = it.name.slice(0, -3)
      try { content = readFileSync(join(root, it.name), 'utf-8') } catch { continue }
    } else continue
    const meta = parseFrontmatter(content)
    const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
    skills.push({
      id,
      name: meta.name || id,
      description: (meta.description || firstLine || id).slice(0, 300),
      version: meta.version || '',
      triggers: meta.triggers || '',
      parent: meta.parent || '',
      subskills: meta.subskills || '',
      lines: content.split('\n').length,
    })
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}

// 版本一致性校验（P4-4-2 轻量版）：lock 支持 { [id]: ver } 或 { skills: { [id]: ver } }。
export function verifySkillVersions({ lockPath, skills = [] }) {
  if (!lockPath || !existsSync(lockPath)) return { outdated: [] }
  let lock = {}
  try { lock = JSON.parse(readFileSync(lockPath, 'utf-8')) } catch { return { outdated: [] } }
  const table = lock.skills && typeof lock.skills === 'object' ? lock.skills : lock
  const outdated = []
  for (const s of skills) {
    const want = table[s.id]
    if (want && s.version && want !== s.version) outdated.push({ id: s.id, lock: want, disk: s.version })
  }
  return { outdated }
}
```

- [ ] **Step 4: 实现 prompt.mjs 注入**

`kernel/prompt.mjs` `composeSystemPrompt`（line 73）签名加 `skills = []`，在 AGENTS.md 区块之后、append 之前插入：

```js
  if (skills && skills.length > 0) {
    const lines = ['【可用技能】任务匹配技能时按技能工作流执行，无匹配则按普通对话处理：']
    for (const s of skills) lines.push(`- ${s.id}：${(s.description || '').slice(0, 120)}`)
    parts.push(lines.join('\n'))
  }
```

- [ ] **Step 5: 实现 cli.mjs 装配与 init 扩展**

`kernel/cli.mjs`：
1. import 加：`import { discoverSkills } from './skills.mjs'` 与 `import { getProvider, visionFromEnv } from './provider.mjs'`（provider.mjs 静态 import；Task 5 的动态 import 改为静态）
2. prompt 组装处（原 line 149-155）之前加技能发现：

```js
  // P4-4：技能发现内核化——每个 --add-dir 扫描（技能根目录命中 SKILL.md；项目目录为空集）
  const skills = []
  const seenSkillIds = new Set()
  for (const dir of args.addDirs) {
    for (const s of discoverSkills({ root: dir })) {
      if (!seenSkillIds.has(s.id)) { seenSkillIds.add(s.id); skills.push(s) }
    }
  }
```

3. composeSystemPrompt 调用加 `skills,` 参数。
4. init 事件（原 line 160）扩展（只增字段）：

```js
  const prov = getProvider()
  const vision = visionFromEnv()
  wire.system('init', {
    model, tools: engine.toolNames, session_id: sessionId, name: 'YFWorking', version: YFW_VERSION,
    provider: prov ? { model: prov.model, version: prov.version } : null,
    vision: vision ? { model: vision.model } : null,
    skills: skills.length,
    settings: { hooks: hooks.count },
  })
```

（`hooks` 变量来自 Task 4；若 Task 4 尚未落地，此处 `hooks.count` 用 `(settings.merged.hooks || []).length` 等价替换，保持本计划步骤自洽。）

- [ ] **Step 6: 跑测试验证通过**

Run: `node --test server/skills.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 7: 回归 + 提交**

Run: `node --test server/settings.test.mjs server/hooks.test.mjs server/provider-chain.test.mjs server/skills.test.mjs server/kernel-contract.test.mjs server/kernel-bridge.test.mjs`
Expected: 全绿

```bash
git add kernel/skills.mjs kernel/prompt.mjs kernel/cli.mjs server/skills.test.mjs
git commit -m "feat(kernel): 技能发现内核化 + prompt 注入 + init 概览（provider/vision/skills/settings）"
```

---

## Self-Review

**1. Spec coverage（对照 docs/production/platform.md §4 任务清单）：**
- P4-1-1 配置传递链 → Task 5（bridge providers.json + seedFromFile；cli 播种）
- P4-1-2 视觉模型透传 → Task 5（visionFromEnv）+ Task 6（init.vision 上报）
- P4-3-1 分层 settings → Task 1（深合并）+ Task 2（cli 挂载生效）
- P4-2-1 hooks 执行器 → Task 3（执行器）+ Task 4（engine/cli 注入点）
- P4-4-1 技能发现内核化 → Task 6（discoverSkills + prompt 注入 + 与 bridge 同 schema）
- P4-4-2 版本校验（P2 增强）→ 轻量版并入 Task 6（verifySkillVersions）
- P4-2-2 hooks GUI（P2，前端设置项）→ 按内核优先原则不落内核计划，留待前端阶段
- P4-5（provider 热切换）→ 已有独立计划 2026-08-21-provider-hot-switch.md，本计划 Task 5/6 只消费/追加其接口

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整实现与测试代码。两处显式标注的弹性点（init.provider.version 初值、hooks 变量来源）都给了等价替换方案，不依赖未定义内容。

**3. Type consistency：** `deepMerge/loadSettings`（Task 1→2）、`createHooks/matchHook`（Task 3→4）、`seedFromFile/visionFromEnv`（Task 5→6）、`discoverSkills/verifySkillVersions`（Task 6 内部 + cli 消费）跨任务签名一致；`settings.merged.*` 键名（model/maxOutputTokens/autoApproveHighRisk/disallowedTools/env/hooks）在 Task 1/2/4/6 间一致；init 扩展字段（provider/vision/skills/settings）Task 6 定义且测试断言同一形状。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-08-21-kernel-platform.md`（6 个 TDD 任务，覆盖 P4-1/P4-3/P4-2/P4-4，P4-5 复用既有计划）。两种执行方式：

**1. Subagent-Driven（推荐）** —— 每个任务派发独立 subagent，任务间审查，快速迭代
**2. Inline Execution** —— 本会话用 executing-plans 批量执行 + 检查点审查

选哪种？
