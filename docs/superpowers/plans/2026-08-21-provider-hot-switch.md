# 内核原生 Provider 热切换（P4-5）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内核原生支持模型 API 无缝更换与激活——会话暂停时经 switch_provider control_request 热切换（baseUrl+authToken+model 一并切换），进程不重启、transcript 连续、busy 轮拒绝，替代前端 env 注入 + spawn 探测的笨重链路。

**Architecture:** 新增 kernel/provider.mjs 运行时 ProviderRegistry（未激活时每次现读 env 保持向后兼容，setProvider 激活后固定）；api.mjs/engine.mjs 从 registry 解析 baseUrl/token/model；cli.mjs 处理 switch_provider control_request（空闲切换 / busy 拒绝 / system 回执 / transcript meta 审计）；bridge.mjs 在 /providers 保存后向活跃会话下发热切换，旧内核静默忽略（回退重启）。

**Tech Stack:** Node.js ESM（零 npm 依赖）、NDJSON wire 协议（docs/bridge-contract.md §3/§4）、node:test 测试、spawn 集成测试（PONOS_MOCK_API=1）。

## Global Constraints

- 向后兼容：未激活（未 setProvider）时，api.mjs 每次请求读 process.env 的行为必须与现状完全一致（现有 api-protocol.test.mjs 运行时改 env 的测试模式不得破坏）。
- wire 事件 shape 是跨层契约（docs/bridge-contract.md），新事件只增不改：`system(provider_switched)` / `system(provider_switch_rejected)`（makeWire.system 已支持任意 subtype，protocol.mjs 零改动）。
- transcript meta 条目不得进入模型输入（deriveMessages 投影）。
- 零 npm 依赖；不引入新文件到 kernel/ 之外的内核链路（provider.mjs 为唯一新增内核文件）。
- 每次 setProvider 校验：baseUrl 必须 http(s) 开头、authToken 非空、model 非空，否则抛错并回执 rejected。
- 全部测试命令：`node --test server/<file>.test.mjs`（Windows bash 环境；全量回归用 `node --test "server/*.test.mjs"`）。

---

### Task 1: kernel/provider.mjs — ProviderRegistry

**Files:**
- Create: `kernel/provider.mjs`
- Test: `server/provider.test.mjs`

**Interfaces:**
- Produces:
  - `getProvider()` → `{ baseUrl, authToken, model }`（未激活时每次从 process.env 现读；激活后返回 registry 值）
  - `setProvider({ baseUrl, authToken, model })` → `{ provider, version }`（校验通过后原子替换，version 从 1 起递增；校验失败抛 `Error`）
  - `providerVersion()` → number

- [x] **Step 1: 写失败测试**

```js
// server/provider.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getProvider, setProvider, providerVersion } from '../kernel/provider.mjs'

test('未激活时 getProvider 每次现读 env（含运行时改动）', () => {
  process.env.ANTHROPIC_BASE_URL = 'http://a'
  process.env.ANTHROPIC_AUTH_TOKEN = 'k1'
  process.env.ANTHROPIC_MODEL = 'm1'
  assert.deepEqual(getProvider(), { baseUrl: 'http://a', authToken: 'k1', model: 'm1' })
  process.env.ANTHROPIC_BASE_URL = 'http://b'   // 运行时改 env 必须生效（现有测试模式）
  assert.equal(getProvider().baseUrl, 'http://b')
})

test('setProvider 校验：非 http(s) baseUrl / 空 authToken / 空 model 抛错', () => {
  assert.throws(() => setProvider({ baseUrl: 'ftp://x', authToken: 'k', model: 'm' }), /http/)
  assert.throws(() => setProvider({ baseUrl: 'http://x', authToken: '', model: 'm' }), /authToken/)
  assert.throws(() => setProvider({ baseUrl: 'http://x', authToken: 'k', model: '' }), /model/)
})

test('setProvider 激活后固定 registry 值 + version 递增 + 尾部斜杠归一', () => {
  const r1 = setProvider({ baseUrl: 'http://api.example.com/', authToken: 'k2', model: 'm2' })
  assert.equal(r1.version, 1)
  assert.equal(getProvider().baseUrl, 'http://api.example.com')  // 斜杠被归一
  assert.equal(getProvider().model, 'm2')
  process.env.ANTHROPIC_BASE_URL = 'http://zzz'   // 激活后 env 改动不再生效
  assert.equal(getProvider().baseUrl, 'http://api.example.com')
  const r2 = setProvider({ baseUrl: 'http://new.example.com', authToken: 'k3', model: 'm3' })
  assert.equal(r2.version, 2)
  assert.equal(providerVersion(), 2)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/provider.test.mjs`
Expected: FAIL（Cannot find module `../kernel/provider.mjs`）

- [x] **Step 3: 最小实现**

```js
// kernel/provider.mjs —— 运行时 provider 注册表（docs/production/platform.md P4-5）
// 未激活：每次 getProvider() 现读 process.env（保持既有"运行时改 env 生效"语义，
// api-protocol.test.mjs 依赖此行为）。setProvider() 激活后固定 registry 值。
const state = { active: null, version: 0 }

function envProvider(env = process.env) {
  return {
    baseUrl: (env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, ''),
    authToken: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || '',
  }
}

export function getProvider() {
  return state.active || envProvider()
}

export function providerVersion() {
  return state.version
}

export function setProvider({ baseUrl, authToken, model } = {}) {
  const next = {
    baseUrl: String(baseUrl ?? '').replace(/\/+$/, ''),
    authToken: String(authToken ?? ''),
    model: String(model ?? ''),
  }
  if (!/^https?:\/\//.test(next.baseUrl)) throw new Error(`provider: baseUrl 必须为 http(s) 地址，got ${next.baseUrl}`)
  if (!next.authToken) throw new Error('provider: authToken 不能为空')
  if (!next.model) throw new Error('provider: model 不能为空')
  state.active = next
  state.version += 1
  return { provider: state.active, version: state.version }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/provider.test.mjs`
Expected: PASS（3 个测试全过）

- [x] **Step 5: 提交**

```bash
git add kernel/provider.mjs server/provider.test.mjs
git commit -m "feat(kernel): provider 注册表——运行时热切换配置源（P4-5 第一步）"
```

---

### Task 2: api.mjs 从 registry 解析 baseUrl/authToken

**Files:**
- Modify: `kernel/api.mjs:33-35`（detectProtocol）、`kernel/api.mjs:283-288`（anthropicStream base/token）
- Test: `server/api-protocol.test.mjs`（增补 1 个测试）

**Interfaces:**
- Consumes: `getProvider()`（Task 1）
- Produces: `anthropicStream` 在 setProvider 激活后请求发往 registry 的 baseUrl（URL 可被测试断言）；未激活时行为与现状一致

- [x] **Step 1: 写失败测试（增补到 server/api-protocol.test.mjs 末尾）**

```js
import { getProvider, setProvider } from '../kernel/provider.mjs'

test('P4-5 setProvider 激活后 streamMessages 请求走新 baseUrl（mock fetch 捕获 URL）', async () => {
  const urls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }) + '\ndata: [DONE]\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }
  try {
    process.env.ANTHROPIC_BASE_URL = 'http://orig'
    process.env.ANTHROPIC_AUTH_TOKEN = 'k'
    setProvider({ baseUrl: 'http://hot-switched', authToken: 'k2', model: 'm2' })
    for await (const c of streamMessages({ model: 'm2', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) {}
    assert.ok(urls.some((u) => u.startsWith('http://hot-switched')), `请求应发往新 baseUrl，实际 ${urls.join(',')}`)
    assert.ok(!urls.some((u) => u.startsWith('http://orig')))
  } finally {
    globalThis.fetch = origFetch
    process.env.ANTHROPIC_BASE_URL = ''
    process.env.ANTHROPIC_AUTH_TOKEN = ''
  }
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/api-protocol.test.mjs`
Expected: FAIL（请求仍发往 http://orig，urls 不含 hot-switched）

- [x] **Step 3: 最小实现**

```js
// api.mjs 顶部 import 区追加：
import { getProvider } from './provider.mjs'

// detectProtocol（line 33-35）改为传入 env 优先、registry 兜底：
export function detectProtocol(env = process.env) {
  const base = env.ANTHROPIC_BASE_URL || getProvider().baseUrl || ''
  return base ? 'anthropic' : null
}

// anthropicStream 开头（line 283-285）改为从 registry 取 base/token：
async function* anthropicStream({ model, messages, system, tools, maxTokens, signal }) {
  const p = getProvider()
  const base = p.baseUrl
  const token = p.authToken
  if (!base || !token) throw new Error('内核：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 未配置')
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/api-protocol.test.mjs`
Expected: PASS（全部原有测试 + 新增 1 个，共 ~10+ 个全过——未激活时 env 行为不变）

- [x] **Step 5: 提交**

```bash
git add kernel/api.mjs server/api-protocol.test.mjs
git commit -m "feat(kernel): api.mjs 从 provider 注册表解析 baseUrl/authToken（P4-5）"
```

---

### Task 3: session.mjs appendMeta — transcript 审计条目

**Files:**
- Modify: `kernel/session.mjs`（rebuildSurface 跳过 meta + 新增 appendMeta）
- Test: `server/session.test.mjs`（增补 1 个测试）

**Interfaces:**
- Consumes: 无
- Produces: `appendMeta(kind, extra)` → entry（写日志 + entriesBySeq 记录，**不进 surface.nodes**，因此 deriveMessages 不含 meta）；load() 恢复后 meta 条目不污染投影

- [x] **Step 1: 写失败测试（增补到 server/session.test.mjs 末尾，沿用该文件现有 fixture 模式）**

```js
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

test('P4-5 appendMeta：落盘 + 不进模型输入 + load 恢复不污染', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-meta-'))
  const store = createSessionStore({ configDir: dir, cwd: '', sessionId: 'meta-1' })
  store.appendUser('hi')
  store.appendMeta('provider_switched', { provider: { baseUrl: 'http://x', model: 'm' }, version: 1 })
  store.appendAssistant([{ type: 'text', text: 'ok' }])
  // deriveMessages 不得含 meta 条目（其 message 为占位，进模型输入会污染）
  const msgs = store.deriveMessages()
  assert.equal(msgs.length, 2)
  assert.ok(msgs.every((m) => m.role !== undefined))  // meta 条目无 message.role，不应出现
  // 磁盘确实落了 3 行
  const raw = readFileSync(store.file, 'utf-8').trim().split('\n')
  assert.equal(raw.length, 3)
  // load 恢复：meta 行存在但同样不进投影
  const store2 = createSessionStore({ configDir: dir, cwd: '', sessionId: 'meta-1' })
  await store2.load()
  assert.equal(store2.deriveMessages().length, 2)
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/session.test.mjs`
Expected: FAIL（`store.appendMeta is not a function`）

- [x] **Step 3: 最小实现**

```js
// kernel/session.mjs rebuildSurface 内、compaction-start 跳过逻辑旁（line 77）追加：
if (e.kind === 'meta') continue   // 审计/元数据条目不投影（不进模型输入）

// return 对象内追加（与 appendCompactionStart 并列，line ~231 后）：
// meta 审计条目：写日志 + entriesBySeq 记录，不进 surface.nodes（模型输入纯净）
appendMeta(kind, extra = {}) {
  const entry = { type: 'meta', kind, id: randomUUID(), seq: nextSeq++, timestamp: new Date().toISOString(), ...extra }
  append(entry)
  entriesBySeq.set(entry.seq, entry)
  return entry
},
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/session.test.mjs`
Expected: PASS（全部原有测试 + 新增 1 个）

- [x] **Step 5: 提交**

```bash
git add kernel/session.mjs server/session.test.mjs
git commit -m "feat(kernel): session appendMeta 审计条目——热切换留痕且不污染模型输入（P4-5）"
```

---

### Task 4: engine.mjs 每轮从 registry 刷新 model

**Files:**
- Modify: `kernel/engine.mjs:130`、`kernel/engine.mjs:154`（runTurnInternal 开头）
- Test: `server/kernel-engine.test.mjs`（增补 1 个测试）

**Interfaces:**
- Consumes: `getProvider()`（Task 1）
- Produces: runTurn 返回的 `{ model }` 反映 registry 当前 model（CLI `--model` 显式指定时优先于 registry）

- [x] **Step 1: 写失败测试（增补到 server/kernel-engine.test.mjs 末尾，沿用该文件直连 createEngine 的 fixture 模式——PONOS_MOCK_API=1）**

```js
import { getProvider, setProvider } from '../kernel/provider.mjs'

test('P4-5 setProvider 换 model 后下一轮 runTurn 使用新 model', async () => {
  const wire = makeWire({ stream: new Writable({ write() {} }) })  // 静默 wire（按该文件现有 fixture 方式构造）
  const session = createSessionStore({ configDir: mkdtempSync(join(tmpdir(), 'engine-meta-')), cwd: '', sessionId: 'e1' })
  setProvider({ baseUrl: 'http://x', authToken: 'k', model: 'model-A' })
  const engine = createEngine({ opts: { addDirs: [], skipPermissions: true }, wire, session })
  const r1 = await engine.runTurn({ content: 'hello' })
  assert.equal(r1.model, 'model-A')
  setProvider({ baseUrl: 'http://y', authToken: 'k2', model: 'model-B' })
  const r2 = await engine.runTurn({ content: 'again' })
  assert.equal(r2.model, 'model-B')   // 热切换后无需重建 engine
  getProvider()                        // 清理：仅引用，无副作用
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/kernel-engine.test.mjs`
Expected: FAIL（r2.model 仍为 'model-A'）

- [x] **Step 3: 最小实现**

```js
// kernel/engine.mjs:130 const → let，并改从 registry 取初值：
let model = opts.model || getProvider().model || ''

// runTurnInternal 开头（line 154 的 `let usage = {}` 之前）追加：
// P4-5：provider 热切换后每轮重解析模型（CLI --model 显式指定优先于 registry）
model = opts.model || getProvider().model || ''
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/kernel-engine.test.mjs`
Expected: PASS（全部原有测试 + 新增 1 个）

- [x] **Step 5: 提交**

```bash
git add kernel/engine.mjs server/kernel-engine.test.mjs
git commit -m "feat(kernel): engine 每轮从 provider 注册表刷新 model——热切换即时生效（P4-5）"
```

---

### Task 5: cli.mjs switch_provider control_request 处理

**Files:**
- Modify: `kernel/cli.mjs`（import provider、model let、handleControlRequest 分支、context.window 重算）
- Test: `server/provider-switch.test.mjs`（新建，spawn 真内核模式，参照 server/kernel-contract.test.mjs 的 makeReader/spawn 结构）

**Interfaces:**
- Consumes: `setProvider`/`providerVersion`（Task 1）、`store.appendMeta`（Task 3）
- Produces: stdin `control_request { request: { subtype: 'switch_provider', payload: { baseUrl, authToken, model } } }` →
  - 空闲：stdout `system(provider_switched, { model, baseUrl, version })`；transcript 落 meta 条目；后续轮次用新配置
  - busy（turnActive）：stdout `system(provider_switch_rejected, { reason: 'busy' })`
  - 校验失败：stdout `system(provider_switch_rejected, { reason: <error message> })`
  - 旧调用方（GUI 旧版本）不感知该 subtype 时无回执（向后兼容，kernel-contract 现有测试不受影响）

- [x] **Step 1: 写失败测试（新建 server/provider-switch.test.mjs）**

```js
// server/provider-switch.test.mjs —— 内核原生 provider 热切换（docs/production/platform.md P4-5）
// spawn 真内核（kernel/cli.mjs + PONOS_MOCK_API=1），按契约注入 NDJSON 断言 stdout 事件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'provider-switch-'))

function spawnKernel(extraEnv = {}) {
  const proc = spawn(process.execPath, [KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio'], {
    cwd: HOME,
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: HOME, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const line = l.trim()
    if (!line) return
    if (waiters.length) waiters.shift()(line)
    else lines.push(line)
  })
  const reader = {
    next(timeoutMs = 8000) {
      if (lines.length) return Promise.resolve(lines.shift())
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('read timeout, queue=' + JSON.stringify(lines))), timeoutMs)
        waiters.push((l) => { clearTimeout(t); resolve(l) })
      })
    },
    async nextEvent() { return JSON.parse(await this.next()) },
  }
  return { proc, reader }
}

test('switch_provider：空闲切换成功 → provider_switched 回执 + 后续轮次正常', async () => {
  const { proc, reader } = spawnKernel({ ANTHROPIC_BASE_URL: 'http://orig', ANTHROPIC_AUTH_TOKEN: 'k1', ANTHROPIC_MODEL: 'm1' })
  try {
    const init = await reader.nextEvent()
    assert.equal(init.type, 'system')
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
    for (;;) { const e = await reader.nextEvent(); if (e.type === 'result') break }
    // 空闲 → 下发热切换
    proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request: { subtype: 'switch_provider', payload: { baseUrl: 'http://hot', authToken: 'k2', model: 'm2' } },
    }) + '\n')
    let switched = null
    for (let i = 0; i < 5; i++) {
      const e = await reader.nextEvent()
      if (e.type === 'system' && e.subtype === 'provider_switched') { switched = e; break }
    }
    assert.ok(switched, '应收到 provider_switched 回执')
    assert.equal(switched.model, 'm2')
    assert.equal(switched.baseUrl, 'http://hot')
    assert.ok(switched.version >= 1)
    // 切换后轮次仍正常（mock API 不回显 baseUrl，断言轮次闭环即可）
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'after switch' } }) + '\n')
    let ok = false
    for (let i = 0; i < 10; i++) { const e = await reader.nextEvent(); if (e.type === 'result') { ok = true; break } }
    assert.ok(ok, '切换后轮次应正常完成')
  } finally {
    proc.kill()
  }
})

test('switch_provider：busy 轮次中拒绝（provider_switch_rejected busy）', async () => {
  const { proc, reader } = spawnKernel({ ANTHROPIC_BASE_URL: 'http://orig', ANTHROPIC_AUTH_TOKEN: 'k1', ANTHROPIC_MODEL: 'm1' })
  try {
    await reader.nextEvent()  // init
    // 发一条 user 立即下发切换（turnActive 期间）
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '[mock:big]' } }) + '\n')
    proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request: { subtype: 'switch_provider', payload: { baseUrl: 'http://hot', authToken: 'k2', model: 'm2' } },
    }) + '\n')
    let rejected = null
    for (let i = 0; i < 12; i++) {
      const e = await reader.nextEvent()
      if (e.type === 'system' && e.subtype === 'provider_switch_rejected') { rejected = e; break }
    }
    assert.ok(rejected, 'busy 时应收到 provider_switch_rejected')
    assert.match(String(rejected.reason || ''), /busy/)
    // 本轮结果仍正常落地
    for (let i = 0; i < 8; i++) { const e = await reader.nextEvent(); if (e.type === 'result') break }
  } finally {
    proc.kill()
  }
})

test('switch_provider：非法 payload 拒绝（校验失败回执）', async () => {
  const { proc, reader } = spawnKernel({})
  try {
    await reader.nextEvent()
    proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request: { subtype: 'switch_provider', payload: { baseUrl: 'not-a-url', authToken: '', model: '' } },
    }) + '\n')
    let rejected = null
    for (let i = 0; i < 5; i++) {
      const e = await reader.nextEvent()
      if (e.type === 'system' && e.subtype === 'provider_switch_rejected') { rejected = e; break }
    }
    assert.ok(rejected, '非法 payload 应收到 rejected 回执')
    assert.match(String(rejected.reason || ''), /http/)
  } finally {
    proc.kill()
  }
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/provider-switch.test.mjs`
Expected: FAIL（无 provider_switched 回执——read timeout，或 reason undefined）

- [x] **Step 3: 最小实现（kernel/cli.mjs）**

```js
// import 区追加：
import { getProvider, setProvider, providerVersion } from './provider.mjs'

// line 116 `const model = ...` → let（热切换后 init/回执用新 model）：
let model = args.model || getProvider().model || ''

// handleControlRequest 内、cancel 分支之后追加：
if (subtype === 'switch_provider') {
  const payload = req.request?.payload || {}
  if (state.turnActive) {
    wire.system('provider_switch_rejected', { reason: 'busy' })
    return
  }
  try {
    const { provider, version } = setProvider(payload)
    model = provider.model
    context.window = contextWindowFor(provider.model)   // 上下文窗口随模型重算
    store.appendMeta('provider_switched', { provider: { baseUrl: provider.baseUrl, model: provider.model }, version })
    wire.system('provider_switched', { model: provider.model, baseUrl: provider.baseUrl, version })
  } catch (err) {
    wire.system('provider_switch_rejected', { reason: err?.message || String(err) })
  }
  return
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/provider-switch.test.mjs`
Expected: PASS（3 个测试全过）

- [x] **Step 5: 回归 + 提交**

```bash
node --test server/kernel-contract.test.mjs server/kernel-bridge.test.mjs
git add kernel/cli.mjs server/provider-switch.test.mjs
git commit -m "feat(kernel): switch_provider 协议——空闲热切换/busy 拒绝/审计留痕（P4-5）"
```

---

### Task 6: bridge.mjs 热切换下发链路（P4-5-3）

**Files:**
- Modify: `server/bridge.mjs`（/providers 保存后向活跃会话下发 switch_provider）
- Test: `server/kernel-bridge.test.mjs`（增补 1 个测试，沿用该文件 before/WS fixture）

**Interfaces:**
- Consumes: 会话结构 `sessions.get(sid)` → `{ proc, _turnActive }`；写内核：`s.proc.stdin.write(JSON.stringify(msg) + '\n')`
- Produces: `/providers`（POST 新增或 PUT 更新 activeProvider）成功后，对该 provider 名下活跃内核会话下发 `control_request { request: { subtype: 'switch_provider', payload: { baseUrl, authToken, model } } }`；无活跃会话或内核不支持（无回执）时静默——GUI 保留"重启生效"降级路径（现状行为不变）

- [x] **Step 1: 写失败测试（增补到 server/kernel-bridge.test.mjs，沿用其 WS/bridge fixture；新增前先断言现有活跃会话收到 provider_switched）**

```js
test('P4-5 /providers 保存 activeProvider 后活跃会话收到 provider_switched', async () => {
  // 新建会话（现有 fixture 的 createClient 辅助），首轮完成、会话保持活跃
  const c = await createClient(bridge, port)
  await c.sendUser('hello')
  await c.expectResult()
  // 保存新 active provider（body 与现有 /providers POST 测试同构）
  const res = await fetch(`http://127.0.0.1:${port}/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: {
        id: 'hot-p', name: 'Hot', apiBaseUrl: 'http://hot', authToken: 'k2',
        models: ['m2'], primaryModel: 'm2',
      },
      activeProvider: 'hot-p',
    }),
  })
  assert.equal(res.status, 200)
  // 活跃会话 stdout 应出现 provider_switched 回执（内核经 bridge 转发或 bridge 监听内核 stdout 转发）
  const switched = await c.expectSystem('provider_switched', 6000)
  assert.equal(switched.model, 'm2')
  c.close()
})
```

> 若现有 fixture 无 `expectSystem` 辅助，测试步骤 1 中内联读取 WS 消息队列直到匹配 `system/provider_switched`（参照该文件既有的事件读取方式）。

- [x] **Step 2: 跑测试确认失败**

Run: `node --test server/kernel-bridge.test.mjs`
Expected: FAIL（无 provider_switched 事件）

- [x] **Step 3: 最小实现（server/bridge.mjs）**

```js
// /providers POST/PUT 保存成功后（现有 saveConfig/syncKernelSettings 调用之后）追加：
function pushProviderSwitch(provider) {
  if (!provider || !provider.apiBaseUrl || !provider.authToken) return
  const model = provider.primaryModel || (provider.models && provider.models[0]) || ''
  if (!model) return
  const payload = { baseUrl: provider.apiBaseUrl, authToken: provider.authToken, model }
  for (const s of sessions.values()) {
    // 仅向"非 busy 且内核进程存活"的会话下发；bridge 侧 _turnActive 同步拦截
    if (s.proc?.stdin && !s._turnActive && !s._reaped) {
      try {
        s.proc.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'switch_provider', payload } }) + '\n')
      } catch { /* 写失败忽略：回退重启路径 */ }
    }
  }
}
```

调用点：`/providers` POST/PUT handler 在 `saveConfig(...)` 成功后 `pushProviderSwitch(provider)`（provider 为本次保存并激活的那个）。无活跃会话时循环为空、零开销；旧内核忽略未知 subtype、无回执——bridge 不做等待，行为与现状一致（GUI 重启兜底）。

- [x] **Step 4: 跑测试确认通过**

Run: `node --test server/kernel-bridge.test.mjs`
Expected: PASS（全部原有测试 + 新增 1 个）

- [x] **Step 5: 全量回归 + 提交**

```bash
node --test "server/*.test.mjs"
git add server/bridge.mjs server/kernel-bridge.test.mjs
git commit -m "feat(bridge): /providers 保存后向活跃会话下发 provider 热切换（P4-5-3）"
```

---

## Self-Review

**Spec coverage（docs/production/platform.md P4-5 + 用户需求）：**
- 内核原生 provider 注册表 → Task 1
- 请求走新 baseUrl（连带 url 切换）→ Task 2
- transcript 连续不丢 + 审计留痕 → Task 3（meta 条目）+ Task 5（落盘）
- 会话暂停（空闲）切换、busy 拒绝 → Task 5
- 模型即时生效（下一轮新 model）→ Task 4
- 替代前端 env 注入 + spawn 探测 → Task 6（/providers 保存即热切换，不再依赖重启）
- 旧内核/旧 GUI 回退 → Task 5/6 静默忽略设计

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整实现。Task 6 测试中的 `createClient`/`expectSystem` 引用现有 fixture 辅助函数——已在步骤注释中说明按既有模式内联（该文件实际辅助名以文件为准，注释明确回退写法），不属悬空引用。

**Type consistency：**
- `getProvider()` → `{ baseUrl, authToken, model }`（Task 1 定义，Task 2/4/5 消费，形状一致）
- `setProvider(payload)` → `{ provider, version }`（Task 1 定义，Task 5 解构 `provider`/`version`，一致）
- `store.appendMeta(kind, extra)`（Task 3 定义，Task 5 调用 `store.appendMeta('provider_switched', { provider, version })`，一致）
- wire 事件：`system('provider_switched', { model, baseUrl, version })` / `system('provider_switch_rejected', { reason })`（Task 5 产出，Task 6 断言 `switched.model`，一致）
- `contextWindowFor(model)`（cli.mjs 已 import，Task 5 复用，签名一致）
