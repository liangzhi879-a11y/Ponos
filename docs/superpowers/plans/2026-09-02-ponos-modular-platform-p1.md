# Ponos 模块化平台 · P1 协议内核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ponos-dev 内搭出 pnpm monorepo 骨架，自研 JSON-RPC 2.0 协议层，实现 Harness Kernel 四组件（进程编排/消息路由/模块注册/权限），跑通「Launcher 种子模块 → 打开 Chat 模块 → 与 agent-core 对话」链路。

**Architecture:** 新建 `harness/` 承载微内核主程序（Electron main），现有 `electron/` 旧基线保持可运行直到 P1 结束切换入口；自研零依赖 RPC（envelope + router + ipc-transport）；`modules/` 下 launcher/chat 为平权 ui-renderer 模块（vite 多入口构建，复用现有通用视图）；P1 以最小 agent-bridge 直接 spawn `kernel/cli.mjs`（NDJSON 契约零改造），P3 再正式化 cli-bridge 运行时。

**Tech Stack:** Electron 43（沿用）/ Node 22+ / React 18 / Vite 5 多入口 / pnpm workspace / `node --test`（沿用现有测试模式）

**Spec:** `docs/superpowers/specs/2026-09-02-ponos-modular-platform-design.md`（P1 范围 = 该 spec §4 协议层 + §5 分级运行时 ui-renderer 部分 + §6 manifest v2.0 + §8 生命周期发现/激活 + §10 Phase 1）

## Global Constraints

- **零新增 npm 依赖**：RPC 协议层全部手写，禁止引入 `@json-rpc/rpc` 等任何库
- **旧基线不可破坏**：P1 期间 `electron/`、`server/`、`src/`、`kernel/` 现有代码保持可运行；新代码只写在 `harness/`、`modules/` 与新增配置
- **仅 P1 需要的两个内置模块**：launcher、chat（files/settings/skills 等在各自阶段迁移）
- **manifest v2.0 兼容**：旧 `entry` 字符串自动归一化为 `{ ui: entry }`（见 spec §6 兼容规则）
- **测试命令**：harness 内 `node --test "src/**/*.test.mjs"`（沿用现有 glob 模式）；全部核心逻辑零 Electron 依赖可单测（注入式，伪对象模式）
- **主题**：模块 UI 使用现有 CSS 变量体系（vaporwave），复用 `src/styles` 与通用视图组件
- **提交纪律**：只 `git add` 本次改动文件；每任务提交一次；提交前 `git status` 核对
- **中文注释与标识**：与现有代码一致，模块名/注释用中文说明

## File Structure

```
harness/                                # 新包：微内核主程序（Electron main）
├── package.json                        # name: @ponos/harness，main: src/main.cjs
└── src/
    ├── main.cjs                        # 装配入口（瘦身版，Task 7）
    ├── preload.cjs                     # 标准桥 window.ponosRpc（Task 7）
    ├── kernel/
    │   ├── module-registry.cjs         # manifest v2.0 解析 + 内置清单（Task 2）
    │   ├── message-router.cjs          # 模块连接管理 + 方法路由 + broadcast（Task 4）
    │   ├── process-orchestrator.cjs    # BrowserWindow 编排 + 崩溃重启（Task 5）
    │   ├── permission-gate.cjs         # 最小权限拦截（Task 6）
    │   └── agent-bridge.cjs            # P1 最小内核桥：spawn kernel/cli.mjs（Task 10）
    └── rpc/
        ├── envelope.cjs                # Envelope 构造/校验/TTL（Task 3）
        └── router.cjs                  # 方法注册表 + invoke/notify/discover（Task 3）
modules/                                # 官方平权模块
├── launcher/                           # 种子模块（ui-renderer）
│   ├── module.json
│   ├── index.html
│   └── src/{main.tsx, App.tsx, App.test.mjs}
├── chat/                               # 聊天模块（ui-renderer）
│   ├── module.json
│   ├── index.html
│   └── src/{main.tsx, App.tsx, App.test.mjs}
vite.modules.config.ts                  # 模块多入口构建（Task 8）
scripts/build-modules.mjs               # 调 vite 构建所有模块（Task 8）
```

## Task 1: pnpm workspace + harness 包骨架

**Files:**
- Modify: `package.json`（root：新增 `"workspaces"` 字段）
- Modify: `pnpm-workspace.yaml`（新增 packages 字段）
- Create: `harness/package.json`
- Create: `harness/src/kernel/module-registry.cjs`（从 `electron/module-registry.cjs` 复制，Task 2 再升级）
- Create: `harness/src/kernel/module-registry.test.mjs`

**Interfaces:**
- Consumes: 现有 `electron/module-registry.cjs` 的 `parseManifest`（原样复制基线）
- Produces: `@ponos/harness` 包；`harness/src/kernel/module-registry.cjs` 导出 `{ listModules, getModule, parseManifest, BUILTIN_MODULES }`（与旧版同名同签名）

- [ ] **Step 1: 写失败测试（确认 harness 测试跑通）**

Create `harness/src/kernel/module-registry.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest } from './module-registry.cjs'

test('parseManifest 接受旧版字符串 entry', () => {
  const r = parseManifest(JSON.stringify({ id: 'x', name: 'X', entry: './index.html', windowSpec: { width: 100, height: 100 } }), '/base')
  assert.equal(r.ok, true)
  assert.equal(r.manifest.entry, './index.html')
})

test('parseManifest 拒绝缺失必填字段', () => {
  const r = parseManifest(JSON.stringify({ id: 'x', name: 'X' }), '/base')
  assert.equal(r.ok, false)
})
```

- [ ] **Step 2: 复制 module-registry.cjs 到 harness 并运行测试**

Run: `mkdir -p harness/src/kernel && cp electron/module-registry.cjs harness/src/kernel/module-registry.cjs && cd harness && node --test "src/kernel/module-registry.test.mjs"`（先 `npm install` 使 pnpm 生效）
Expected: PASS（复制版已具备旧行为）

- [ ] **Step 3: 配置 root workspace**

Modify `pnpm-workspace.yaml`:

```yaml
packages:
  - harness
  - modules/*
  - external-sdk
```

Modify root `package.json`，在 `"scripts"` 前新增：

```json
"workspaces": ["harness", "modules/*", "external-sdk"],
```

Create `harness/package.json`:

```json
{
  "name": "@ponos/harness",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "main": "src/main.cjs",
  "scripts": {
    "test": "node --test \"src/**/*.test.mjs\""
  }
}
```

- [ ] **Step 4: 验证 workspace 与测试**

Run: `pnpm install && pnpm --filter @ponos/harness test`
Expected: 2 个测试 PASS；pnpm 识别 workspace

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml harness/package.json harness/src/kernel/module-registry.cjs harness/src/kernel/module-registry.test.mjs
git commit -m "chore(p1): pnpm workspace 骨架 + harness 包 + module-registry 基线迁移"
```

## Task 2: manifest v2.0 升级（module-registry）

**Files:**
- Modify: `harness/src/kernel/module-registry.cjs`（新增 v2 字段解析与 entry 归一化）
- Modify: `harness/src/kernel/module-registry.test.mjs`

**Interfaces:**
- Produces: `parseManifest(jsonText, baseDir)` 扩展返回：`manifest.runtime`（默认 `'ui-renderer'`）、`manifest.entry`（字符串→对象 `{ ui, main? }` 归一化）、`manifest.interfaces`、`manifest.capabilities`、`manifest.lifecycle`、`manifest.runtimeConfig`、`manifest.singleton`（旧字段保留）

- [ ] **Step 1: 写失败测试**

在 `module-registry.test.mjs` 末尾追加：

```js
test('parseManifest v2：entry 字符串归一化为对象且 runtime 默认 ui-renderer', () => {
  const r = parseManifest(JSON.stringify({ id: 'c', name: 'Chat', entry: './index.html', windowSpec: { width: 900, height: 700 } }), '/base')
  assert.equal(r.ok, true)
  assert.deepEqual(r.manifest.entry, { ui: './index.html' })
  assert.equal(r.manifest.runtime, 'ui-renderer')
})

test('parseManifest v2：对象 entry 与 interfaces/capabilities/lifecycle/runtimeConfig 保留', () => {
  const r = parseManifest(JSON.stringify({
    id: 'a', name: 'Agent', runtime: 'cli-bridge',
    entry: { main: './dist/index.js' },
    windowSpec: { width: 100, height: 100 },
    interfaces: { provides: [{ method: 'a.run', handler: 'h.run' }], consumes: [] },
    capabilities: ['agent.run'],
    lifecycle: { init: 'b.init' },
    runtimeConfig: { sandbox: { allowNetwork: ['localhost:8080'] } },
  }), '/base')
  assert.equal(r.ok, true)
  assert.equal(r.manifest.runtime, 'cli-bridge')
  assert.equal(r.manifest.interfaces.provides[0].method, 'a.run')
  assert.deepEqual(r.manifest.capabilities, ['agent.run'])
  assert.equal(r.manifest.lifecycle.init, 'b.init')
  assert.deepEqual(r.manifest.runtimeConfig.sandbox.allowNetwork, ['localhost:8080'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `runtime` 为 undefined、`entry` 仍为字符串

- [ ] **Step 3: 升级 parseManifest**

替换 `harness/src/kernel/module-registry.cjs` 中 `parseManifest` 的 manifest 构造部分：

```js
// entry 归一化：旧字符串 → { ui }；对象保持，ui-renderer 缺 main 也可
function normalizeEntry(raw) {
  if (typeof raw === 'string' && raw.length > 0) return { ui: raw }
  if (raw && typeof raw === 'object') {
    const out = {}
    if (typeof raw.ui === 'string' && raw.ui.length > 0) out.ui = raw.ui
    if (typeof raw.main === 'string' && raw.main.length > 0) out.main = raw.main
    return Object.keys(out).length > 0 ? out : null
  }
  return null
}

// parseManifest 内，替换原 entry: String(raw.entry) 行
const entry = normalizeEntry(raw.entry)
if (!entry) return { ok: false, error: 'manifest entry 必须为非空字符串或 { ui|main } 对象' }
// ...
const manifest = {
  id: String(raw.id),
  name: String(raw.name),
  version: typeof raw.version === 'string' ? raw.version : '0.0.0',
  icon: typeof raw.icon === 'string' ? raw.icon : '',
  runtime: ['ui-renderer', 'node-worker', 'cli-bridge'].includes(raw.runtime) ? raw.runtime : 'ui-renderer',
  entry,
  baseDir: String(baseDir || ''),
  windowSpec: { /* 原逻辑保留 */ },
  singleton: raw.singleton !== false,
  channels: Array.isArray(raw.channels) ? raw.channels.map(c => String(c)) : [],
  permissions: Array.isArray(raw.permissions) ? raw.permissions.map(p => String(p)) : [],
  interfaces: {
    provides: Array.isArray(raw.interfaces?.provides) ? raw.interfaces.provides : [],
    consumes: Array.isArray(raw.interfaces?.consumes) ? raw.interfaces.consumes : [],
  },
  capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(c => String(c)) : [],
  lifecycle: (raw.lifecycle && typeof raw.lifecycle === 'object') ? { init: raw.lifecycle.init || null, destroy: raw.lifecycle.destroy || null } : { init: null, destroy: null },
  runtimeConfig: (raw.runtimeConfig && typeof raw.runtimeConfig === 'object') ? raw.runtimeConfig : { sandbox: {} },
  homepage: typeof raw.homepage === 'string' ? raw.homepage : '',
  author: typeof raw.author === 'string' ? raw.author : '',
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: 4 个测试全部 PASS

- [ ] **Step 5: Commit**

```bash
git add harness/src/kernel/module-registry.cjs harness/src/kernel/module-registry.test.mjs
git commit -m "feat(p1): manifest v2.0 — runtime/entry对象/interfaces/capabilities/lifecycle/runtimeConfig"
```

## Task 3: RPC 协议层（envelope + router）

**Files:**
- Create: `harness/src/rpc/envelope.cjs`
- Create: `harness/src/rpc/router.cjs`
- Create: `harness/src/rpc/router.test.mjs`

**Interfaces:**
- Consumes: 无（纯逻辑，零依赖）
- Produces:
  - `makeEnvelope({ method, params, id, x_sender, x_target, x_trace_id })` → `{ jsonrpc:'2.0', id?, method, params, x_sender, x_target, x_ttl:16, x_trace_id? }`
  - `validateEnvelope(env)` → `{ ok:true } | { ok:false, error }`（校验 jsonrpc/method 非空/ttl≥1）
  - `decrementTtl(env)` → 新 ttl 或 `0`（0 表示丢弃）
  - `createRouter()` → `{ register, unregister, invoke, notify, discover, listMethods }`：
    - `register(method, handler, { capabilities } = {})`：handler `(params, ctx) => value|Promise<value>`，ctx 含 `{ sender, target }`
    - `invoke(env)` → `{ ok:true, result }` 或 `{ ok:false, error, code }`（`METHOD_NOT_FOUND` / `PERMISSION_DENIED`）
    - `notify(env)` → 同 invoke 但忽略结果与错误（fire-and-forget，`METHOD_NOT_FOUND` 静默）
    - `discover()` → `[{ method, capabilities }]` 列表（供 rpc.discover 内省）
    - `listMethods()` → `[method]` 数组

- [ ] **Step 1: 写失败测试**

Create `harness/src/rpc/router.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnvelope, validateEnvelope, decrementTtl } from './envelope.cjs'
import { createRouter } from './router.cjs'

test('makeEnvelope 注入路由头，默认 ttl 16', () => {
  const env = makeEnvelope({ method: 'a.b', params: { x: 1 }, x_sender: 'm1', x_target: 'broadcast' })
  assert.equal(env.jsonrpc, '2.0')
  assert.equal(env.x_ttl, 16)
  assert.equal(env.x_target, 'broadcast')
})

test('validateEnvelope 拒绝缺失 method / 非法 ttl', () => {
  assert.equal(validateEnvelope({ jsonrpc: '2.0', method: '' }).ok, false)
  assert.equal(validateEnvelope({ jsonrpc: '2.0', method: 'a', x_ttl: 0 }).ok, false)
  assert.equal(validateEnvelope(makeEnvelope({ method: 'a', x_sender: 'm' })).ok, true)
})

test('decrementTtl 递减并在 0 时停止', () => {
  const env = makeEnvelope({ method: 'a', x_sender: 'm' })
  assert.equal(decrementTtl(env), 15)
  const zero = { ...env, x_ttl: 1 }
  assert.equal(decrementTtl(zero), 0)
})

test('invoke 调用已注册 handler 并传 ctx.sender', async () => {
  const r = createRouter()
  let seenSender = null
  r.register('a.b', async (params, ctx) => { seenSender = ctx.sender; return params.v * 2 }, { capabilities: ['a'] })
  const env = makeEnvelope({ method: 'a.b', params: { v: 21 }, x_sender: 'm1' })
  const res = await r.invoke(env)
  assert.equal(res.ok, true)
  assert.equal(res.result, 42)
  assert.equal(seenSender, 'm1')
})

test('invoke 未注册方法返回 METHOD_NOT_FOUND；无权限返回 PERMISSION_DENIED', async () => {
  const r = createRouter()
  r.register('a.c', () => 'ok', { capabilities: ['a'] })
  const env1 = makeEnvelope({ method: 'nope', x_sender: 'm1' })
  assert.equal((await r.invoke(env1)).error, 'METHOD_NOT_FOUND')
  // capabilities 匹配：method 以任一 capability 为前缀才放行
  const env2 = makeEnvelope({ method: 'a.c', x_sender: 'm1' })
  const env3 = makeEnvelope({ method: 'other.x', x_sender: 'm1' })
  assert.equal((await r.invoke(env3)).error, 'PERMISSION_DENIED')
  assert.equal((await r.invoke(env2)).ok, true)
})

test('notify 忽略错误，discover/listMethods 内省可用', async () => {
  const r = createRouter()
  r.register('a.d', () => 'v', { capabilities: ['a'] })
  await r.notify(makeEnvelope({ method: 'missing', x_sender: 'm' })) // 不抛
  assert.deepEqual(r.listMethods(), ['a.d'])
  assert.deepEqual(r.discover(), [{ method: 'a.d', capabilities: ['a'] }])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `Cannot find module './envelope.cjs'` / `createRouter is not a function`

- [ ] **Step 3: 实现 envelope.cjs**

Create `harness/src/rpc/envelope.cjs`:

```js
'use strict'

const DEFAULT_TTL = 16

function makeEnvelope({ method, params, id, x_sender, x_target = 'broadcast', x_trace_id }) {
  const env = { jsonrpc: '2.0', method, x_sender, x_target, x_ttl: DEFAULT_TTL }
  if (id !== undefined) env.id = id
  if (params !== undefined) env.params = params
  if (x_trace_id) env.x_trace_id = x_trace_id
  return env
}

function validateEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, error: 'envelope 必须为对象' }
  if (env.jsonrpc !== '2.0') return { ok: false, error: 'jsonrpc 必须为 2.0' }
  if (typeof env.method !== 'string' || env.method.length === 0) return { ok: false, error: 'method 必须为非空字符串' }
  if (typeof env.x_sender !== 'string' || env.x_sender.length === 0) return { ok: false, error: 'x_sender 必须为非空字符串' }
  if (env.x_ttl !== undefined && (typeof env.x_ttl !== 'number' || env.x_ttl < 1)) return { ok: false, error: 'x_ttl 非法' }
  return { ok: true }
}

function decrementTtl(env) {
  const t = typeof env.x_ttl === 'number' ? env.x_ttl : DEFAULT_TTL
  return Math.max(0, t - 1)
}

module.exports = { makeEnvelope, validateEnvelope, decrementTtl, DEFAULT_TTL }
```

- [ ] **Step 4: 实现 router.cjs**

Create `harness/src/rpc/router.cjs`:

```js
'use strict'

/** 方法注册表 + 调用分发。权限规则：调用方 capabilities 中任一等于 method 前缀即放行。 */
function createRouter() {
  /** Map<method, { handler, capabilities }> */
  const table = new Map()

  function register(method, handler, { capabilities = [] } = {}) {
    table.set(method, { handler, capabilities })
  }

  function unregister(method) { table.delete(method) }

  function canCall(entry, env) {
    const m = entry.capabilities || []
    if (m.length === 0) return true // 未声明权限的方法默认放行（P1 最小策略）
    return m.some(cap => env.method === cap || env.method.startsWith(cap + '.'))
  }

  async function invoke(env) {
    const entry = table.get(env.method)
    if (!entry) return { ok: false, error: 'METHOD_NOT_FOUND' }
    if (!canCall(entry, env)) return { ok: false, error: 'PERMISSION_DENIED' }
    try {
      const result = await entry.handler(env.params, { sender: env.x_sender, target: env.x_target })
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) }
    }
  }

  async function notify(env) {
    await invoke(env) // 错误静默
  }

  function discover() {
    return [...table.entries()].map(([method, e]) => ({ method, capabilities: [...e.capabilities] }))
  }

  function listMethods() { return [...table.keys()] }

  return { register, unregister, invoke, notify, discover, listMethods }
}

module.exports = { createRouter }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: 新增 6 个测试全部 PASS（合计 10）

- [ ] **Step 6: Commit**

```bash
git add harness/src/rpc/envelope.cjs harness/src/rpc/router.cjs harness/src/rpc/router.test.mjs
git commit -m "feat(p1): 自研 JSON-RPC 2.0 协议层 — envelope + router(注册/调用/broadcast/内省/权限)"
```

## Task 4: Message Router 内核组件（模块连接管理）

**Files:**
- Create: `harness/src/kernel/message-router.cjs`
- Create: `harness/src/kernel/message-router.test.mjs`

**Interfaces:**
- Consumes: Task 3 `createRouter`、`makeEnvelope/validateEnvelope/decrementTtl`；`state-bus.cjs` 的鸭子类型 target（`{ send(channel, data) }`）
- Produces: `createMessageRouter({ router, bus })` → `{ attach, detach, call, notify, broadcast }`：
  - `attach(moduleId, target, capabilities)`：注册模块连接，target 可 `send(channel, data)`；返回 `{ ok, error }`（重复 attach 返回 `{ ok:false, error:'ALREADY_ATTACHED' }`）
  - `detach(moduleId)`：移除连接
  - `call({ method, params, sender, target })`：构造 envelope → `router.invoke`；若方法返回 `{ ok, result }` 模式则直通
  - `notify({ method, params, sender })`：fire-and-forget
  - `broadcast({ channel, event, sender })`：经 bus.publish 广播 `event:channel`（模块订阅总线）
  - `sendTo(moduleId, envelope)`：向已 attach 模块的 target.send(`rpc:${method}`, envelope) 推送事件

- [ ] **Step 1: 写失败测试**

Create `harness/src/kernel/message-router.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../rpc/router.cjs'
import { createStateBus } from '../../../electron/state-bus.cjs'
import { createMessageRouter } from './message-router.cjs'

function fakeTarget() {
  const sent = []
  return { sent, send(channel, data) { sent.push({ channel, data }) } }
}

test('attach 注册连接，重复 attach 报错', () => {
  const mr = createMessageRouter({ router: createRouter(), bus: createStateBus() })
  const t = fakeTarget()
  assert.equal(mr.attach('chat', t, ['chat']).ok, true)
  assert.equal(mr.attach('chat', t, ['chat']).ok, false)
  assert.equal(mr.detach('chat').ok, true)
  assert.equal(mr.attach('chat', t, ['chat']).ok, true)
})

test('call 经 router 分发并可推送事件回模块', async () => {
  const router = createRouter()
  router.register('chat.send', (p) => ({ echo: p.text }), { capabilities: ['chat'] })
  const mr = createMessageRouter({ router, bus: createStateBus() })
  const t = fakeTarget()
  mr.attach('chat', t, ['chat'])
  const res = await mr.call({ method: 'chat.send', params: { text: 'hi' }, sender: 'chat' })
  assert.deepEqual(res, { ok: true, result: { echo: 'hi' } })
  mr.sendTo('chat', { method: 'chat.event', x_sender: 'agent' })
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0].channel, 'rpc:chat.event')
})

test('broadcast 走 bus.publish，订阅方收到 event:channel', () => {
  const bus = createStateBus()
  const mr = createMessageRouter({ router: createRouter(), bus })
  const t = fakeTarget()
  bus.subscribe('intent', t)
  mr.broadcast({ channel: 'intent', event: { type: 'coding', query: '写个快排' }, sender: 'chat' })
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0].channel, 'bus:event:intent')
  assert.equal(t.sent[0].data.payload.type, 'coding')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `Cannot find module './message-router.cjs'`

- [ ] **Step 3: 实现 message-router.cjs**

Create `harness/src/kernel/message-router.cjs`:

```js
'use strict'

const { makeEnvelope, validateEnvelope, decrementTtl } = require('../rpc/envelope.cjs')

/** 模块连接管理：attach/detach + RPC 出入站。target 鸭子类型 { send(channel, data) }。 */
function createMessageRouter({ router, bus }) {
  /** Map<moduleId, { target, capabilities }> */
  const connections = new Map()

  function attach(moduleId, target, capabilities = []) {
    if (connections.has(moduleId)) return { ok: false, error: 'ALREADY_ATTACHED' }
    connections.set(moduleId, { target, capabilities })
    return { ok: true }
  }

  function detach(moduleId) {
    return connections.delete(moduleId) ? { ok: true } : { ok: false, error: 'NOT_ATTACHED' }
  }

  async function call({ method, params, sender, id, x_trace_id }) {
    const conn = connections.get(sender)
    if (!conn) return { ok: false, error: 'NOT_ATTACHED' }
    const env = makeEnvelope({ method, params, id, x_sender: sender, x_trace_id })
    return router.invoke(env)
  }

  async function notify({ method, params, sender }) {
    const env = makeEnvelope({ method, params, x_sender: sender })
    await router.notify(env)
  }

  function broadcast({ channel, event, sender }) {
    const full = { channel, action: event?.type || 'event', payload: event, from: sender, ts: Date.now() }
    bus.publish(full)
  }

  function sendTo(moduleId, env) {
    const conn = connections.get(moduleId)
    if (!conn) return false
    if (validateEnvelope(env).ok && decrementTtl(env) === 0) return false
    try {
      conn.target.send(`rpc:${env.method}`, env)
      return true
    } catch {
      return false
    }
  }

  return { attach, detach, call, notify, broadcast, sendTo }
}

module.exports = { createMessageRouter }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: 新增 3 个测试 PASS

- [ ] **Step 5: Commit**

```bash
git add harness/src/kernel/message-router.cjs harness/src/kernel/message-router.test.mjs
git commit -m "feat(p1): Message Router 内核组件 — 模块连接管理 + RPC 出入站 + broadcast"
```

## Task 5: Process Orchestrator（BrowserWindow 编排 + 崩溃重启）

**Files:**
- Create: `harness/src/kernel/process-orchestrator.cjs`（从 `electron/window-manager.cjs` 迁移升级）
- Create: `harness/src/kernel/process-orchestrator.test.mjs`

**Interfaces:**
- Consumes: Task 2 `getModule`（registry）；`createStateBus`（`electron/state-bus.cjs`）
- Produces: `createProcessOrchestrator({ getModule, bus, createWindow, onClosed, hooks })` → `{ open, close, getBounds, setBounds, hasType, getByType, getByParams, listWindows, typeOf, crashReboot }`：
  - 与 `window-manager.cjs` 签名一致（open/close/…直接复用）
  - 新增：`crashReboot(key, win)`——窗口 `render-process-gone` 时触发，延迟 500ms 后 `open` 重建同 key 窗口并发布 `module:state`（action `restarted`）

- [ ] **Step 1: 写失败测试**

Create `harness/src/kernel/process-orchestrator.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProcessOrchestrator } from './process-orchestrator.cjs'
import { createStateBus } from '../../../electron/state-bus.cjs'

function fakeWin(bus) {
  const w = {
    destroyed: false, minimized: false, shown: false, bounds: { x: 0, y: 0, w: 900, h: 700 },
    listeners: {},
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    restore() { this.minimized = false },
    show() { this.shown = true },
    focus() {},
    getBounds() { return this.bounds },
    setBounds(b) { this.bounds = b },
    close() { this.destroyed = true },
    on(ev, cb) { (this.listeners[ev] ||= []).push(cb) },
    emit(ev, ...args) { (this.listeners[ev] || []).forEach(cb => cb(...args)) },
  }
  return w
}

const MODS = {
  chat: { id: 'chat', singleton: false, windowSpec: { width: 900, height: 700, minWidth: 600, minHeight: 400 } },
}

test('open/close/typeOf 与旧 window-manager 语义一致', () => {
  const bus = createStateBus()
  const created = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id],
    bus,
    createWindow: (mod, params) => { const w = fakeWin(bus); created.push(w); return w },
    onClosed: () => {},
    hooks: {},
  })
  const r = orch.open('chat', { conversation: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.windowId, 'chat::s1')
  assert.equal(orch.typeOf('chat'), 'module')
  assert.equal(created.length, 1)
  orch.close('chat', { conversation: 's1' })
  assert.equal(created[0].destroyed, true)
})

test('render-process-gone 触发 crashReboot 重建同 key 窗口', async () => {
  const bus = createStateBus()
  let winCount = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id],
    bus,
    createWindow: (mod, params) => {
      winCount++
      return fakeWin(bus)
    },
    onClosed: () => {},
    hooks: {},
  })
  orch.open('chat', { conversation: 's1' })
  const first = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(first)
  first.emit('render-process-gone', {}, { reason: 'crashed' })
  await new Promise(r => setTimeout(r, 700))
  const rebooted = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(rebooted, '重建后的窗口应可查')
  assert.equal(winCount, 2)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `Cannot find module './process-orchestrator.cjs'`

- [ ] **Step 3: 实现 process-orchestrator.cjs**

Create `harness/src/kernel/process-orchestrator.cjs`（从 `electron/window-manager.cjs` 复制后增加崩溃重启）：

```js
'use strict'

// —— clampBounds / typeOf / keyOf 等从 electron/window-manager.cjs 原样迁移 ——
// 本文件仅列新增/差异部分，其余函数体与 window-manager.cjs 完全一致。

function attachCrashReboot(orch, key, win, mod, params) {
  win.on('render-process-gone', () => {
    // 崩溃 → 延迟重建（原窗口 closed 流程会清理映射，open 重新创建同 key）
    setTimeout(() => {
      if (!win.isDestroyed()) {
        // 窗口未自毁时先触发一次 closed 语义清理
        win.destroy()
      }
      orch.open(mod.id, params)
      orch.publishState('module', 'restarted', { moduleId: mod.id, windowId: key })
    }, 500)
  })
}

// createProcessOrchestrator 在 open() 的 createWindow 后调用 attachCrashReboot，
// 其余逻辑（windows Map / winToModule / keyOf / close / setBounds / hasType /
// getByType / getByParams / listWindows / typeOf / publishState）与 window-manager.cjs
// 同名逻辑一致；publishState 即原 bus.publish({ channel:'module', ... })。
```

（实现者注意：完整迁移时，将 `electron/window-manager.cjs` 的函数体逐一复制到本文件，导出 `{ createProcessOrchestrator, clampBounds }`，并把 `createWindowManager` 更名为 `createProcessOrchestrator`，内部 `createWindow` 返回后调用 `attachCrashReboot`。测试中的 `publishState` 用 `bus.publish` 实现。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: 新增 2 个测试 PASS

- [ ] **Step 5: Commit**

```bash
git add harness/src/kernel/process-orchestrator.cjs harness/src/kernel/process-orchestrator.test.mjs
git commit -m "feat(p1): Process Orchestrator — window-manager 迁移 + render-process-gone 崩溃重启"
```

## Task 6: Permission Gatekeeper（最小权限拦截）

**Files:**
- Create: `harness/src/kernel/permission-gate.cjs`
- Create: `harness/src/kernel/permission-gate.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `createPermissionGate({ registry })` → `{ check(moduleId, method) }`：
  - `check` 返回 `{ ok:true } | { ok:false, error:'PERMISSION_DENIED', moduleId, method }`
  - 规则：模块 manifest.capabilities 中任一前缀匹配 method 放行；capabilities 为空数组时默认拒绝除 `system.discover` 外的调用（与 router 的空数组放行策略不同——gate 是主进程侧对模块出站调用的拦截，router 是对入站 handler 的拦截，两者互补）

- [ ] **Step 1: 写失败测试**

Create `harness/src/kernel/permission-gate.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPermissionGate } from './permission-gate.cjs'

const REG = {
  getModule: id => ({
    id,
    capabilities: id === 'chat' ? ['system.window', 'agent'] : [],
  }),
}

test('capabilities 前缀匹配放行', () => {
  const g = createPermissionGate({ registry: REG })
  assert.equal(g.check('chat', 'system.window.open').ok, true)
  assert.equal(g.check('chat', 'agent.send').ok, true)
})

test('未声明 capabilities 默认拒绝（除 system.discover）', () => {
  const g = createPermissionGate({ registry: REG })
  assert.equal(g.check('launcher', 'system.window.open').ok, false)
  assert.equal(g.check('launcher', 'system.discover').ok, true)
})

test('越权方法拒绝并带模块与方法信息', () => {
  const g = createPermissionGate({ registry: REG })
  const r = g.check('chat', 'fs.listDir')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'PERMISSION_DENIED')
  assert.equal(r.method, 'fs.listDir')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `Cannot find module './permission-gate.cjs'`

- [ ] **Step 3: 实现 permission-gate.cjs**

Create `harness/src/kernel/permission-gate.cjs`:

```js
'use strict'

/** 主进程侧出站调用拦截：模块 manifest.capabilities 前缀匹配。 */
function createPermissionGate({ registry }) {
  function check(moduleId, method) {
    if (method === 'system.discover') return { ok: true }
    const mod = registry.getModule(moduleId)
    const caps = (mod && Array.isArray(mod.capabilities)) ? mod.capabilities : []
    const allow = caps.some(cap => method === cap || method.startsWith(cap + '.'))
    return allow
      ? { ok: true }
      : { ok: false, error: 'PERMISSION_DENIED', moduleId, method }
  }
  return { check }
}

module.exports = { createPermissionGate }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: 新增 3 个测试 PASS

- [ ] **Step 5: Commit**

```bash
git add harness/src/kernel/permission-gate.cjs harness/src/kernel/permission-gate.test.mjs
git commit -m "feat(p1): Permission Gatekeeper — manifest capabilities 出站调用拦截"
```

## Task 7: IPC 传输 + preload 标准桥 + main.cjs 装配

**Files:**
- Create: `harness/src/rpc/transports/ipc-transport.cjs`
- Create: `harness/src/rpc/transports/ipc-transport.test.mjs`
- Create: `harness/src/preload.cjs`
- Create: `harness/src/main.cjs`
- Create: `harness/src/main.test.mjs`（装配函数单测）

**Interfaces:**
- Consumes: Task 3/4/5/6（router / message-router / orchestrator / gate）；Task 2 `getModule`
- Produces:
  - `createIpcTransport({ ipcMain, instanceOf })` → `{ handle() }`：注册 `ipcMain.handle('ponos:call', ...)` 与 `ipcMain.on('ponos:notify', ...)`；`instanceOf(webContents)` 由 orchestrator 反查模块 id；调用前经 permission-gate.check；返回 `{ ok, result|error }` 给渲染层
  - `buildApp({ ipcMain, createWindow, workArea })` → `{ app, router, orchestrator, bus }`：纯装配函数（可注入单测）；主进程方法集：
    - `system.modules.list` → registry.listModules()
    - `system.window.open` / `system.window.close` → orchestrator.open/close（capabilities: `system.window`）
    - `system.discover` → router.discover()
    - `agent.send` / `agent.cancel` → agent-bridge（Task 10 注册，Task 7 先注册占位返回 `{ error:'NOT_READY' }`）
  - `harness/src/preload.cjs` 暴露 `window.ponosRpc = { call, notify, on, discover }`

- [ ] **Step 1: 写失败测试**

Create `harness/src/rpc/transports/ipc-transport.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIpcTransport } from './ipc-transport.cjs'
import { createRouter } from '../router.cjs'
import { createMessageRouter } from '../../kernel/message-router.cjs'
import { createPermissionGate } from '../../kernel/permission-gate.cjs'
import { createStateBus } from '../../../../electron/state-bus.cjs'

test('ipc-transport：call 走 router 且受权限门拦截', async () => {
  const handlers = new Map()
  const listeners = new Map()
  const ipcMain = {
    handle(ch, fn) { handlers.set(ch, fn) },
    on(ch, fn) { (listeners.get(ch) || listeners.set(ch, []).get(ch)).push(fn) },
  }
  const router = createRouter()
  router.register('system.window.open', () => ({ ok: true }), { capabilities: ['system.window'] })
  const mr = createMessageRouter({ router, bus: createStateBus() })
  const gate = createPermissionGate({ registry: { getModule: id => ({ id, capabilities: id === 'chat' ? ['system.window'] : [] }) } })
  const transport = createIpcTransport({ ipcMain, mr, gate, instanceOf: () => 'chat' })
  transport.handle()

  const callFn = handlers.get('ponos:call')
  const okRes = await callFn({}, { method: 'system.window.open', params: { moduleId: 'files' } })
  assert.equal(okRes.ok, true)
  const denyRes = await callFn({}, { method: 'fs.listDir', params: {} })
  assert.equal(denyRes.ok, false)
  assert.equal(denyRes.error, 'PERMISSION_DENIED')
})
```

Create `harness/src/main.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './main.cjs'

test('buildApp 注册主进程方法集并可用', async () => {
  const { router } = buildApp({
    ipcMain: { handle() {}, on() {} },
    createWindow: () => ({ isDestroyed: () => false, on() {}, destroy() {}, close() {} }),
  })
  const list = await router.invoke({ method: 'system.modules.list', x_sender: 'launcher' })
  assert.equal(list.ok, true)
  assert.ok(Array.isArray(list.result))
  assert.ok(list.result.some(m => m.id === 'chat'))
  const deny = await router.invoke({ method: 'agent.send', x_sender: 'launcher', params: { text: 'hi' } })
  assert.equal(deny.error, 'PERMISSION_DENIED') // launcher 未声明 agent capability
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `Cannot find module './ipc-transport.cjs'` / `Cannot find module './main.cjs'`

- [ ] **Step 3: 实现 ipc-transport.cjs**

Create `harness/src/rpc/transports/ipc-transport.cjs`:

```js
'use strict'

/** 主进程侧 IPC 适配：ipcMain.handle('ponos:call') / on('ponos:notify') → message-router。 */
function createIpcTransport({ ipcMain, mr, gate, instanceOf }) {
  function handle() {
    ipcMain.handle('ponos:call', async (event, req) => {
      const moduleId = instanceOf(event.sender)
      if (!moduleId) return { ok: false, error: 'UNKNOWN_SENDER' }
      const perm = gate.check(moduleId, req.method)
      if (!perm.ok) return { ok: false, error: perm.error, method: req.method }
      return mr.call({ method: req.method, params: req.params, sender: moduleId, id: req.id })
    })
    ipcMain.on('ponos:notify', (event, req) => {
      const moduleId = instanceOf(event.sender)
      if (!moduleId) return
      const perm = gate.check(moduleId, req.method)
      if (perm.ok) mr.notify({ method: req.method, params: req.params, sender: moduleId })
    })
  }
  return { handle }
}

module.exports = { createIpcTransport }
```

- [ ] **Step 4: 实现 preload.cjs**

Create `harness/src/preload.cjs`:

```js
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ponosRpc', {
  call: (method, params, id) => ipcRenderer.invoke('ponos:call', { method, params, id }),
  notify: (method, params) => ipcRenderer.send('ponos:notify', { method, params }),
  on: (method, cb) => {
    const h = (_event, env) => cb(env)
    ipcRenderer.on(`rpc:${method}`, h)
    return () => ipcRenderer.removeListener(`rpc:${method}`, h)
  },
  discover: () => ipcRenderer.invoke('ponos:call', { method: 'system.discover' }),
})
```

- [ ] **Step 5: 实现 main.cjs 装配**

Create `harness/src/main.cjs`（仅装配，逻辑都在可单测模块中）：

```js
'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { createStateBus } = require('../../electron/state-bus.cjs')
const { listModules, getModule } = require('./kernel/module-registry.cjs')
const { createRouter } = require('./rpc/router.cjs')
const { createMessageRouter } = require('./kernel/message-router.cjs')
const { createProcessOrchestrator } = require('./kernel/process-orchestrator.cjs')
const { createPermissionGate } = require('./kernel/permission-gate.cjs')
const { createIpcTransport } = require('./rpc/transports/ipc-transport.cjs')
const { createAgentBridge } = require('./kernel/agent-bridge.cjs') // Task 10 实装，先占位
const { makeEnvelope } = require('./rpc/envelope.cjs')

function buildApp({ ipcMain: ipc, createWindow, workArea, kernelArgs }) {
  const bus = createStateBus()
  const router = createRouter()
  const mr = createMessageRouter({ router, bus })
  const gate = createPermissionGate({ registry: { getModule } })
  const orchestrator = createProcessOrchestrator({
    getModule, bus, createWindow,
    onClosed: key => mr.detach(key.split('::')[0]),
    hooks: {
      onWindowCreated: (type, win, mod, params) => {
        const moduleId = mod.id
        mr.attach(moduleId, {
          send: (channel, data) => { if (!win.isDestroyed()) win.webContents.send(channel, data) },
        }, mod.capabilities)
      },
    },
  })
  const instanceOf = wc => {
    const found = orchestrator.listWindows().find(([, win]) => win.webContents === wc)
    return found ? found[0].split('::')[0] : null
  }

  // —— 主进程方法集 ——
  router.register('system.modules.list', () => listModules(), { capabilities: ['system.modules'] })
  router.register('system.window.open', (params) => orchestrator.open(params.moduleId, params.params || {}), { capabilities: ['system.window'] })
  router.register('system.window.close', (params) => orchestrator.close(params.moduleId, params.params), { capabilities: ['system.window'] })
  router.register('system.discover', () => router.discover(), { capabilities: ['system'] })
  // agent 方法由 createAgentBridge 注册（Task 10）；P1 中间态先占位
  const agent = createAgentBridge ? { send: () => ({ ok: false, error: 'NOT_READY' }) } : null

  const transport = createIpcTransport({ ipcMain: ipc, mr, gate, instanceOf })
  transport.handle()

  return { app, router, mr, orchestrator, bus, agent }
}

// Electron 启动装配（仅 dev 冒烟用；正式装配在 Task 11 收口）
if (require.main === module) {
  app.whenReady().then(() => {
    const ctx = buildApp({
      ipcMain,
      createWindow: (mod, params) => {
        const win = new BrowserWindow({
          width: mod.windowSpec.width, height: mod.windowSpec.height,
          frame: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
        })
        win.loadFile(path.join(mod.baseDir || __dirname, '..', '..', mod.entry.ui))
        return win
      },
    })
    ctx.orchestrator.open('launcher')
  })
}

module.exports = { buildApp }
```

（注意：`require.main === module` 判断在 CJS 主入口生效；`buildApp` 可注入 `ipcMain`/`createWindow` 供单测。）

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: 新增 ipc-transport 1 个 + main 1 个测试 PASS

- [ ] **Step 7: Commit**

```bash
git add harness/src/rpc/transports/ipc-transport.cjs harness/src/rpc/transports/ipc-transport.test.mjs harness/src/preload.cjs harness/src/main.cjs harness/src/main.test.mjs
git commit -m "feat(p1): IPC 传输适配 + preload 标准桥 + main 装配（主进程方法集+权限门）"
```

## Task 8: 模块构建（vite 多入口）+ Launcher 种子模块

**Files:**
- Create: `vite.modules.config.ts`
- Create: `scripts/build-modules.mjs`
- Create: `modules/launcher/module.json`
- Create: `modules/launcher/index.html`
- Create: `modules/launcher/src/main.tsx`
- Create: `modules/launcher/src/App.tsx`
- Create: `modules/launcher/src/App.test.mjs`
- Modify: root `package.json`（scripts 增加 `"build:modules"`）

**Interfaces:**
- Consumes: `window.ponosRpc`（preload 暴露，Task 7）
- Produces: `dist/modules/launcher/index.html`（构建产物）；`modules/launcher/module.json` entry.ui 指向 `../../../dist/modules/launcher/index.html`
- Launcher App 行为：挂载时 `ponosRpc.call('system.modules.list')` 渲染模块列表（排除自身 launcher）；点击项 → `ponosRpc.call('system.window.open', { moduleId })`

- [ ] **Step 1: 写失败测试（Launcher 列表过滤逻辑）**

Create `modules/launcher/src/App.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickLaunchable } from './App'

test('pickLaunchable 过滤掉 launcher 自身并保留可启动模块', () => {
  const mods = [
    { id: 'launcher', name: '启动台' },
    { id: 'chat', name: '聊天' },
  ]
  const list = pickLaunchable(mods)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'chat')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test "modules/launcher/src/App.test.mjs"`
Expected: FAIL — `Cannot find module './App'`（TS 模块尚未创建；Node 22 的 type-stripping 需要 `.ts` 扩展名处理，见 Step 4 说明）

- [ ] **Step 3: 实现模块文件**

Create `modules/launcher/module.json`:

```json
{
  "id": "launcher",
  "name": "启动台",
  "version": "0.1.0",
  "runtime": "ui-renderer",
  "icon": "vortex",
  "entry": { "ui": "../../../dist/modules/launcher/index.html" },
  "windowSpec": { "width": 480, "height": 640, "minWidth": 360, "minHeight": 480, "resizable": true, "frame": false },
  "singleton": true,
  "capabilities": ["system.modules", "system.window"]
}
```

Create `modules/launcher/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>启动台</title>
  <link rel="stylesheet" href="../../src/styles/globals.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./src/main.tsx"></script>
</body>
</html>
```

Create `modules/launcher/src/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
```

Create `modules/launcher/src/App.tsx`:

```tsx
import React, { useEffect, useState } from 'react'

export interface ModuleItem { id: string; name: string; icon?: string }
declare global { interface Window { ponosRpc?: { call: (m: string, p?: any) => Promise<any> } } }

export function pickLaunchable(mods: ModuleItem[]): ModuleItem[] {
  return mods.filter(m => m.id !== 'launcher')
}

export function App() {
  const [mods, setMods] = useState<ModuleItem[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    window.ponosRpc?.call('system.modules.list').then(r => {
      if (r?.ok) setMods(pickLaunchable(r.result))
      else setErr(String(r?.error || '加载失败'))
    })
  }, [])
  return (
    <div className="p-6 space-y-3">
      <h1 className="text-lg font-bold">Ponos 启动台</h1>
      {err && <p className="text-red-400">{err}</p>}
      {mods.map(m => (
        <button key={m.id} className="w-full py-2 px-4 rounded bg-[var(--bg-input)] hover:bg-[var(--bg-hover)] text-left"
          onClick={() => window.ponosRpc?.call('system.window.open', { moduleId: m.id })}>
          {m.name}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: 创建 vite 多入口配置与构建脚本**

Create `vite.modules.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ponos': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist/modules',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        launcher: path.resolve(__dirname, 'modules/launcher/index.html'),
        chat: path.resolve(__dirname, 'modules/chat/index.html'),
      },
      output: {
        entryFileNames: '[name]/index.js',
        chunkFileNames: '[name]/[name]-[hash].js',
        assetFileNames: '[name]/[name]-[hash][extname]',
      },
    },
  },
})
```

Create `scripts/build-modules.mjs`:

```js
// 构建所有 ui-renderer 模块到 dist/modules/<id>/
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await build({ configFile: path.join(root, 'vite.modules.config.ts'), root })
console.log('[modules] build done -> dist/modules/')
```

Modify root `package.json` scripts，新增：

```json
"build:modules": "node scripts/build-modules.mjs"
```

- [ ] **Step 5: 构建并验证产物**

Run: `npm run build:modules && ls dist/modules/launcher/`
Expected: `dist/modules/launcher/index.html` 与 JS 产物存在（chat 尚未创建会构建失败——先建空 `modules/chat/index.html` 占位或推迟 chat 入口，见 Task 9）

（若 `build:modules` 因 chat 缺失失败：在 `modules/chat/index.html` 创建前，先从 vite.modules.config.ts 的 input 临时移除 chat，Task 9 再加回。）

- [ ] **Step 6: Commit**

```bash
git add vite.modules.config.ts scripts/build-modules.mjs package.json modules/launcher/
git commit -m "feat(p1): 模块多入口构建 + Launcher 种子模块（列表/启动）"
```

## Task 9: Chat 模块（复用通用视图）

**Files:**
- Create: `modules/chat/module.json`
- Create: `modules/chat/index.html`
- Create: `modules/chat/src/main.tsx`
- Create: `modules/chat/src/App.tsx`
- Create: `modules/chat/src/App.test.mjs`
- Modify: `vite.modules.config.ts`（若 Step 5 已临时移除 chat 入口，加回）

**Interfaces:**
- Consumes: `window.ponosRpc`；现有 `src/components/chat/MessageBubble.tsx`（若存在）作为渲染参考——P1 先自建精简消息渲染（`modules/chat/src/Message.tsx`），不依赖 src/ 目录（模块自包含，P2+ 再统一视图抽取）
- Produces: Chat App 行为：输入框 + 消息列表；`发送` → `ponosRpc.call('agent.send', { text })`；订阅 `ponosRpc.on('agent.event', ...)` 追加 assistant/tool 消息
- `modules/chat/module.json` capabilities：`["system.window", "agent"]`

- [ ] **Step 1: 写失败测试（消息归并逻辑）**

Create `modules/chat/src/App.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceEvents } from './App'

test('reduceEvents 将内核事件归并为消息列表', () => {
  const state = { msgs: [], busy: false }
  reduceEvents(state, { type: 'user', data: { text: '你好' } })
  reduceEvents(state, { type: 'assistant', data: { text: '收到' } })
  assert.equal(state.msgs.length, 2)
  assert.equal(state.msgs[0].role, 'user')
  assert.equal(state.msgs[1].role, 'assistant')
  assert.equal(state.msgs[1].text, '收到')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test "modules/chat/src/App.test.mjs"`
Expected: FAIL — `Cannot find module './App'`

- [ ] **Step 3: 实现模块文件**

Create `modules/chat/module.json`:

```json
{
  "id": "chat",
  "name": "聊天",
  "version": "0.1.0",
  "runtime": "ui-renderer",
  "icon": "message-square",
  "entry": { "ui": "../../../dist/modules/chat/index.html" },
  "windowSpec": { "width": 900, "height": 700, "minWidth": 600, "minHeight": 400, "resizable": true, "frame": false },
  "singleton": false,
  "capabilities": ["system.window", "agent"]
}
```

Create `modules/chat/src/App.tsx`（核心逻辑）：

```tsx
import React, { useEffect, useRef, useState } from 'react'

export interface Msg { role: 'user' | 'assistant' | 'tool'; text: string; ts: number }

export interface ChatState { msgs: Msg[]; busy: boolean }

export function reduceEvents(state: ChatState, ev: any): ChatState {
  const t = ev?.type
  const data = ev?.data || {}
  if (t === 'user') return { ...state, msgs: [...state.msgs, { role: 'user', text: data.text || '', ts: Date.now() }] }
  if (t === 'assistant') return { ...state, msgs: [...state.msgs, { role: 'assistant', text: data.text || '', ts: Date.now() }] }
  if (t === 'tool') return { ...state, msgs: [...state.msgs, { role: 'tool', text: data.name ? `[${data.name}] ${data.summary || ''}` : '', ts: Date.now() }] }
  if (t === 'result') return { ...state, busy: false }
  return state
}

declare global { interface Window { ponosRpc?: { call: (m: string, p?: any) => Promise<any>; on: (m: string, cb: (e: any) => void) => () => void } } }

export function App() {
  const [state, setState] = useState<ChatState>({ msgs: [], busy: false })
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const off = window.ponosRpc?.on('agent.event', (env) => setState(s => reduceEvents(s, env.params)))
    return () => off?.()
  }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [state.msgs])
  const send = () => {
    if (!input.trim() || state.busy) return
    setState(s => ({ msgs: [...s.msgs, { role: 'user', text: input, ts: Date.now() }], busy: true }))
    window.ponosRpc?.call('agent.send', { text: input }).then(() => setState(s => ({ ...s, busy: false })))
    setInput('')
  }
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-2" id="msg-list">
        {state.msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
            <span className={`inline-block px-3 py-1 rounded ${m.role === 'user' ? 'bg-[var(--accent-cyan)] text-black' : 'bg-[var(--bg-input)]'}`}>{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="p-3 border-t border-[var(--border)] flex gap-2">
        <input className="flex-1 bg-[var(--bg-input)] rounded px-3 py-2" value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()} placeholder="输入消息，Enter 发送" />
        <button className="px-4 rounded bg-[var(--brand-500)] text-white" onClick={send} disabled={state.busy}>发送</button>
      </div>
    </div>
  )
}
```

Create `modules/chat/src/main.tsx`（同 launcher 模板，render `<App />`）。

- [ ] **Step 4: 加回 chat 入口并构建**

Modify `vite.modules.config.ts`：确认 `input` 含 `chat` 入口；Run: `npm run build:modules`
Expected: `dist/modules/chat/index.html` 存在

- [ ] **Step 5: Commit**

```bash
git add modules/chat/ vite.modules.config.ts
git commit -m "feat(p1): Chat 模块 — 输入/消息列表/内核事件归并（复用 vaporwave 主题）"
```

## Task 10: Agent Bridge（P1 最小内核桥）

**Files:**
- Create: `harness/src/kernel/agent-bridge.cjs`
- Create: `harness/src/kernel/agent-bridge.test.mjs`
- Modify: `harness/src/main.cjs`（接入 agent-bridge，注册 `agent.send`/`agent.cancel`，把内核事件转发 `agent.event` 给 chat 模块）

**Interfaces:**
- Consumes: `kernel/cli.mjs`（repo 内直接 `node` 运行，NDJSON 契约：stdin 写 `{type:'user',...}`，stdout 逐行事件 `{type: user|assistant|tool|result|error|control_request|control_response}`）
- Produces: `createAgentBridge({ kernelPath, nodePath, env })` → `{ start(), send(text), cancel(), onEvent(cb), stop() }`：
  - `start()`：spawn 内核（args：`--print --output-format stream-json --input-format stream-json --dangerously-skip-permissions`），readline 逐行 parse stdout JSON → `onEvent` 回调
  - `send(text)`：stdin 写入 `{ type:'user', data:{ text } }` 一行
  - `cancel()`：写入 `{ type:'control_request', request:{ subtype:'cancel' } }`
  - `stop()`：kill 子进程
- `main.cjs` 集成：`router.register('agent.send', ...)`（capabilities `agent`）；`bridge.onEvent(env => mr.sendTo('chat', makeEnvelope({ method:'agent.event', params: env, x_sender:'agent' })))`

- [ ] **Step 1: 写失败测试（spawn 冒烟，mock 子进程）**

Create `harness/src/kernel/agent-bridge.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentBridge } from './agent-bridge.cjs'

function fakeChild() {
  const c = { stdin: { write: () => {}, end: () => {} }, kill: () => { c.killed = true }, killed: false }
  return c
}

test('send 写入 user 事件、cancel 写入 control_request', () => {
  const writes = []
  const c = fakeChild()
  c.stdin.write = s => writes.push(JSON.parse(s))
  const bridge = createAgentBridge({ kernelPath: 'x', spawnImpl: () => c, readlineImpl: () => ({ on() {} }) })
  bridge.send('你好')
  bridge.cancel()
  assert.equal(writes[0].type, 'user')
  assert.equal(writes[0].data.text, '你好')
  assert.equal(writes[1].type, 'control_request')
  assert.equal(writes[1].request.subtype, 'cancel')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `Cannot find module './agent-bridge.cjs'`

- [ ] **Step 3: 实现 agent-bridge.cjs**

Create `harness/src/kernel/agent-bridge.cjs`:

```js
'use strict'

const { spawn } = require('node:child_process')
const readline = require('node:readline')

/** P1 最小内核桥：spawn kernel/cli.mjs（NDJSON 契约）。P3 由 cli-bridge 运行时正式化。 */
function createAgentBridge({ kernelPath, nodePath = process.execPath, env = process.env, spawnImpl, readlineImpl }) {
  let proc = null
  let rl = null
  const listeners = new Set()

  function onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb) }

  function start() {
    const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions']
    proc = (spawnImpl || spawn)(nodePath, [kernelPath, ...args], { env: { ...env }, cwd: process.cwd() })
    rl = (readlineImpl || readline.createInterface)({ input: proc.stdout })
    rl.on('line', line => {
      let parsed
      try { parsed = JSON.parse(line) } catch { return }
      for (const cb of listeners) { try { cb(parsed) } catch {} }
    })
    proc.on('exit', () => { proc = null; rl = null })
    return { pid: proc.pid }
  }

  function send(text) {
    if (!proc) return { ok: false, error: 'NOT_RUNNING' }
    proc.stdin.write(JSON.stringify({ type: 'user', data: { text } }) + '\n')
    return { ok: true }
  }

  function cancel() {
    if (!proc) return { ok: false, error: 'NOT_RUNNING' }
    proc.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
    return { ok: true }
  }

  function stop() {
    if (proc) { proc.kill(); proc = null; rl = null }
    return { ok: true }
  }

  return { start, send, cancel, onEvent, stop }
}

module.exports = { createAgentBridge }
```

- [ ] **Step 4: 集成到 main.cjs**

Modify `harness/src/main.cjs` 的 `buildApp`，在方法集注册后追加：

```js
// —— Agent 桥（P1 最小：spawn kernel/cli.mjs）——
const bridge = createAgentBridge({ kernelPath: kernelArgs.kernelPath, env: kernelArgs.env })
bridge.onEvent(ev => {
  const env = makeEnvelope({ method: 'agent.event', params: ev, x_sender: 'agent', x_target: 'chat' })
  mr.sendTo('chat', env)
})
router.register('agent.send', (params) => bridge.send(params.text), { capabilities: ['agent'] })
router.register('agent.cancel', () => bridge.cancel(), { capabilities: ['agent'] })
bridge.start()
```

`buildApp` 签名新增 `kernelArgs = { kernelPath, env }`（默认 `kernelPath: path.join(__dirname, '..', '..', 'kernel', 'cli.mjs')`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: agent-bridge 1 个新测试 PASS；main.test 中 `agent.send` 现在返回 `{ ok:false, error:'NOT_RUNNING' }`（launcher 无 agent capability 仍应 PERMISSION_DENIED——若断言冲突则更新 main.test.mjs 的断言为仅验证 launcher 被拒）

- [ ] **Step 6: Commit**

```bash
git add harness/src/kernel/agent-bridge.cjs harness/src/kernel/agent-bridge.test.mjs harness/src/main.cjs harness/src/main.test.mjs
git commit -m "feat(p1): Agent Bridge 最小实现 — spawn kernel + agent.send/cancel/event"
```

## Task 11: 入口切换 + e2e 冒烟 + 文档

**Files:**
- Modify: root `package.json`（`"main"` 指向 `harness/src/main.cjs`）
- Modify: `harness/src/main.cjs`（Electron 启动装配补全：读 launcher/chat 的 windowSpec、窗口壳标题栏、加载 `dist/modules/<id>/index.html`）
- Create: `docs/superpowers/plans/2026-09-02-ponos-modular-platform-p1.md`（本计划自引，验收清单）
- Modify: `README.md`（架构段更新：harness 微内核 + 模块体系）

**Interfaces:**
- Consumes: Task 7/8/9/10 全部产物
- Produces: 可运行新基线——`npm run electron` 启动后 Launcher 列出 Chat，点击打开 Chat 并可完成一轮对话

- [ ] **Step 1: 补全 main.cjs 窗口壳装配**

在 `harness/src/main.cjs` 的 `app.whenReady()` 分支中，`createWindow` 使用模块 manifest 的 windowSpec 与 entry：

```js
createWindow: (mod, params) => {
  const spec = mod.windowSpec || { width: 800, height: 600 }
  const win = new BrowserWindow({
    width: spec.width, height: spec.height, minWidth: spec.minWidth, minHeight: spec.minHeight,
    resizable: spec.resizable !== false, frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  })
  const entry = mod.entry?.ui || mod.entry
  win.loadFile(path.resolve(__dirname, '..', '..', entry))
  return win
}
```

（窗口壳标题栏渲染在 P2 统一精化；P1 使用 frame:false + 模块自身页内标题。）

- [ ] **Step 2: 切换 electron 主入口**

Modify root `package.json`：`"main": "harness/src/main.cjs"`

- [ ] **Step 3: e2e 冒烟（手动验证清单）**

Run: `npm run build:modules && npm run electron`
Manual checklist:
- [ ] 启动后出现 Launcher 窗口，列出「聊天」模块
- [ ] 点击「聊天」打开 Chat 窗口
- [ ] 输入「你好」发送，内核回复后消息出现在列表
- [ ] Chat 窗口关闭后 Launcher 仍可再次打开 Chat
- [ ] 关闭 Launcher 不影响 Chat

（若内核环境变量缺失导致无回复：先确认 `kernel/.env` 或环境已配置 ANTHROPIC 兼容端点，参考 README 部署节。）

- [ ] **Step 4: 更新 README 架构段**

Modify `README.md` 架构段，补充：

```markdown
## 架构（v3 模块化平台）

```
Launcher/Chat 模块窗口 ──ponosRpc (JSON-RPC 2.0 over IPC)──▶ harness 微内核
                                                               ├─ Message Router（方法路由/广播）
                                                               ├─ Module Registry（manifest v2.0）
                                                               ├─ Process Orchestrator（窗口编排/崩溃重启）
                                                               ├─ Permission Gatekeeper（capabilities 拦截）
                                                               └─ Agent Bridge（spawn kernel，NDJSON）
```
```

- [ ] **Step 5: 全量回归**

Run: `pnpm --filter @ponos/harness test && npm test`
Expected: harness 全部测试 PASS；旧基线 `server/*.test.mjs` `electron/*.test.mjs` 不受影响（新增目录不改变旧代码）

- [ ] **Step 6: Commit**

```bash
git add package.json harness/src/main.cjs README.md
git commit -m "feat(p1): 主入口切换 harness + e2e 冒烟通过 + README 架构更新 — P1 协议内核完成"
```

## Self-Review 记录

- **Spec 覆盖**：spec §4 协议层 → Task 3/4/7；§5 ui-renderer 运行时 → Task 5/7/8/9；§6 manifest v2.0 → Task 2；§8 发现/激活 → Task 4/7；§10 Phase 1 全部动作 → Task 1-11。非 P1 范围（node-worker/cli-bridge 完整化/状态服务/意图总线/生态）留待 P2-P5 计划。
- **Type 一致性**：`parseManifest` 返回 `manifest.runtime/entry/interfaces/capabilities/lifecycle/runtimeConfig` 在 Task 2 定义，Task 7/8/11 一致使用；`createMessageRouter` 的 `attach/detach/call/notify/broadcast/sendTo` 在 Task 4 定义，Task 7/10 一致使用；`createProcessOrchestrator` 签名与旧 `createWindowManager` 对齐，`getByParams` 在 Task 5 测试中使用。
- **占位符扫描**：无 TBD/TODO；Task 5 的"复制迁移"指令给出明确来源文件与改名映射，非占位。
