# Ponos 模块化平台 · P2 状态服务 Implementation Plan（细化版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox（`- [ ]`）语法。

**Goal:** 建立 node-worker 运行时，state-manager 服务模块（node-worker）提供全局状态 get/set/subscribe + 事件广播 + JSON 持久化，settings 模块消费状态实现双窗口实时同步，统一窗口壳标题栏。

**Architecture:** worker-transport 适配器（宿主侧包装 Worker 实例）+ orchestrator 新增 node-worker 运行时分支（spawn/崩溃 respawn/exit 清理）；state-manager 是总线上第一个服务模块——状态数据权威在 worker 线程内存（模块自包含 core/storage/main），宿主经 worker-transport + rpc client 代理 state.* 方法，状态变化以通知回流宿主 → `mr.broadcast` 推送所有 attach 模块；窗口壳改为 shell.html（标题栏 + iframe 内容区），preload 经 nodeIntegrationInSubFrames 注入 iframe 内模块 UI。

**Tech Stack:** node:worker_threads、node:test（TDD）、自研 JSON-RPC 信封（envelope）、zustand 保持现状（P2 不新增）、持久化用 JSON 文件（storage 接口注入，零新依赖）。

## Global Constraints

- 沿用 P1 全部约定：`node --test` + 伪对象注入（fakeWin/fakeTarget/fakeWorker 模式）；harness 包 CJS（`harness/src/**`）、模块包 ESM（`modules/*/src/**`）；BUILTIN_MODULES 内 entry 为 repo-root 相对路径，`modules/<id>/module.json` 内 entry 为模块目录相对路径（P5 扫描用）。
- **state 数据权威在 worker 线程**：宿主只做路由代理（state.* 方法 → worker 处理 → 结果回宿主），不在主进程内存缓存状态。
- **持久化零新原生依赖**：JSON 文件 storage（`createFileStorage(path)`，默认 `user-data/state-store.json`）；classic-level 留作状态量增长后的升级路径（storage 接口已抽象）。
- **不触碰旧 `src/` 与 `server/`**（§11 资产迁移清单：YFWorking 业务组件/store 于 P5 以模块回归丢弃）；不修改 P1 已提交的 launcher/chat 模块 UI 与构建产物（窗口壳改造只动 harness 侧加载方式，模块 UI 零改动）。
- worker 崩溃 respawn 沿用 P1 crashReboot 的 500ms 延迟 + 竞态守卫模式。
- `state.set` 返回 per-key 单调递增 `version`；`event:state.changed` 负载 `{ key, value, version, from }`。

---

## 范围调整（相对大纲的裁决，实施时以本计划为准）

1. **大纲任务 5/6「settings/files 模块迁移」→ 改为新建 settings 模块**：`modules/` 下尚无 settings/files 模块（P1 仅 launcher/chat）；files 模块属业务回归（P5），P2 新建 settings 模块（ui-renderer）作为**第一个状态消费模块**，演示 `state.get/set + event:state.changed` 双窗口实时同步。
2. **大纲任务 7「渲染层 Zustand 清理」→ 收敛为范围声明**：模块体系内无全局业务 zustand store（launcher/chat 用 useState，settings 全走 RPC）；旧 `src/stores/*` 属 §11「P5 以模块回归」遗留资产，P2 不动旧代码。验收标准 3 在模块体系内达成。
3. **会话上下文下拉 → P2 骨架**：下拉显示当前会话 + 实例列表 + 「新建会话」（`system.window.open` 新实例）；完整会话生命周期管理在 P3（cli-bridge 会话 spawn/重启）。
4. **orchestrator `keyOf` 需导出**（P1 未导出）：窗口壳按 key 控制窗口（minimize/maximize/close/context）依赖它。

---

## 接口契约（固化，跨任务依赖此签名）

- `createWorkerTransport({ worker })` → `{ send(env), onMessage(cb) → off, close() }`：worker = duck `{ postMessage(msg), on(ev, cb), terminate() }`（宿主侧，Task 1）
- `createProcessOrchestrator` 新增注入 `createWorker(mod)` 与 `onWorkerExit(id)`；新增方法 `startWorker(id)` / `stopWorker(id)` / `getWorker(id)`；导出 `keyOf(id, params)`（Task 2）
- `createStateManager({ bus, storage })` → `{ get(key), set(key, value, from), list(), onChanged(cb) → off }`；`handleRequest(sm, method, params)` → `{ ok, ... }` 统一响应（Task 3）
- `createFileStorage(path)` → `{ load(), save(data) }`（load 容错：文件缺失/JSON 损坏返回 null）（Task 3）
- `createStateManagerClient({ transport })` → `{ call(method, params) → Promise, onNotification(cb) → off }`：call 用递增 id 配对 request/response；无 id 消息走通知（Task 4）
- `mr.broadcast({ channel, event, sender })`：bus.publish 保留 + **推送所有 attach 模块** `target.send('rpc:event:<channel>', makeEnvelope({ method:'event:<channel>', params:event, x_sender:sender }))`（Task 5）
- `orchestrator.minimize(key)/maximize(key)/context(key)`：context 返回 `{ name, icon, entry, conversations, current }`（entry 原值，宿主转 file URL）（Task 8）
- 新 RPC：`system.window.minimize` / `system.window.maximize` / `system.window.context`；`system.window.close` 扩展支持 `{ key }`（Task 8）

---

### Task 1: worker-transport 适配器（宿主侧）

**Files:**
- Create: `harness/src/rpc/transports/worker-transport.cjs`
- Test: `harness/src/rpc/transports/worker-transport.test.mjs`

**Interfaces:**
- Consumes: 无（独立纯逻辑）
- Produces: `createWorkerTransport({ worker })` → `{ send(env), onMessage(cb) → off, close() }`；Task 4/7 宿主侧包装 `node:worker_threads` Worker 实例

- [ ] **Step 1: 写失败测试**

Create `harness/src/rpc/transports/worker-transport.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerTransport } from './worker-transport.cjs'

function fakeWorker() {
  const listeners = {}
  return {
    sent: [],
    postMessage(m) { this.sent.push(m) },
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
    terminate() { this.terminated = true },
  }
}

test('send 经 postMessage 编码；onMessage 转发 message 事件', () => {
  const w = fakeWorker()
  const t = createWorkerTransport({ worker: w })
  const got = []
  t.onMessage(m => got.push(m))
  t.send({ method: 'state.get', params: { key: 'a' } })
  assert.equal(w.sent.length, 1)
  assert.equal(w.sent[0].method, 'state.get')
  w.emit('message', { id: 1, result: { ok: true } })
  assert.deepEqual(got, [{ id: 1, result: { ok: true } }])
})

test('onMessage 返回退订函数；close 调 worker.terminate', () => {
  const w = fakeWorker()
  const t = createWorkerTransport({ worker: w })
  let n = 0
  const off = t.onMessage(() => n++)
  w.emit('message', {})
  off()
  w.emit('message', {})
  assert.equal(n, 1)
  t.close()
  assert.equal(w.terminated, true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `Cannot find module './worker-transport.cjs'`

- [ ] **Step 3: 实现**

Create `harness/src/rpc/transports/worker-transport.cjs`:

```js
'use strict'

/**
 * 宿主侧 worker-transport 适配器：把 node:worker_threads Worker 包装为与
 * ipc-transport 同构的 { send, onMessage, close }。消息体为 JSON-RPC envelope。
 * worker duck 类型：{ postMessage(msg), on(ev, cb), terminate() }。
 */
function createWorkerTransport({ worker }) {
  const listeners = new Set()
  worker.on('message', msg => {
    for (const cb of listeners) { try { cb(msg) } catch {} }
  })
  return {
    send(env) { worker.postMessage(env) },
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    close() { worker.terminate() },
  }
}

module.exports = { createWorkerTransport }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: PASS（worker-transport 2 个新测试；既有 28 个不受影响）

- [ ] **Step 5: Commit**

```bash
git add harness/src/rpc/transports/worker-transport.cjs harness/src/rpc/transports/worker-transport.test.mjs
git commit -m "feat(p2): worker-transport 宿主侧适配器 — Worker 包装为 send/onMessage/close"
```

---

### Task 2: orchestrator node-worker 运行时 + registry 扩展

**Files:**
- Modify: `harness/src/kernel/process-orchestrator.cjs`（startWorker/stopWorker/getWorker/onWorkerExit 注入/导出 keyOf）
- Modify: `harness/src/kernel/module-registry.cjs`（BUILTIN_MODULES 加 state-manager/settings；parseManifest windowSpec 放宽）
- Test: `harness/src/kernel/process-orchestrator.test.mjs`、`harness/src/kernel/module-registry.test.mjs`

**Interfaces:**
- Consumes: P1 `createProcessOrchestrator({ getModule, bus, createWindow, onClosed, hooks })`
- Produces: `startWorker(id)` → `{ ok, workerId }`；worker 崩溃（`error` 事件）→ 500ms 延迟 respawn（沿用 crashReboot 守卫：映射仍指向本 worker 才重建）；worker `exit` → 清理 + `onWorkerExit?.(id)`；`getWorker(id)`；`stopWorker(id)`；导出 `keyOf(id, params)`（Task 8 依赖）

- [ ] **Step 1: 写失败测试（registry + orchestrator worker）**

追加到 `harness/src/kernel/module-registry.test.mjs`：

```js
test('parseManifest 对 node-worker 模块不再强制 windowSpec（ui-renderer 仍给默认）', () => {
  const ok = parseManifest(JSON.stringify({ id: 'sm', name: '状态服务', runtime: 'node-worker', entry: { main: 'main.cjs' } }), '/x')
  assert.equal(ok.ok, true)
  assert.equal(ok.manifest.runtime, 'node-worker')
  assert.equal(ok.manifest.entry.main, 'main.cjs')
  const ok2 = parseManifest(JSON.stringify({ id: 'ui', name: 'UI', entry: 'a.html' }), '/x')
  assert.equal(ok2.ok, true)
  assert.equal(ok2.manifest.windowSpec.width, 640, '缺 windowSpec 时回落默认')
})
```

追加到 `harness/src/kernel/process-orchestrator.test.mjs`（文件顶部 `const MODS` 增加 state-manager 条目）：

```js
// MODS 增加：
//   state: { id: 'state', runtime: 'node-worker', singleton: true },
//   settings: { id: 'settings', runtime: 'ui-renderer', singleton: false, windowSpec: {...} },

function fakeWorker() {
  const listeners = {}
  return {
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
    postMessage() {}, terminate() { this.terminated = true },
  }
}

test('startWorker 创建 worker、发布 started、重复启动报 ALREADY_RUNNING', () => {
  const bus = createStateBus()
  const created = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createWorker: mod => { const w = fakeWorker(); created.push(w); return w },
    onClosed: () => {}, hooks: {},
  })
  const r = orch.startWorker('state')
  assert.equal(r.ok, true)
  assert.equal(created.length, 1)
  assert.equal(orch.startWorker('state').error, 'ALREADY_RUNNING')
  assert.equal(bus.getSnapshot('worker').filter(e => e.action === 'started').length, 1)
})

test('worker 崩溃 → 500ms 延迟 respawn 并发布 restarted', async () => {
  const bus = createStateBus()
  let n = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createWorker: () => { n++; return fakeWorker() },
    onClosed: () => {}, hooks: {},
  })
  orch.startWorker('state')
  const first = orch.getWorker('state')
  first.emit('error', new Error('boom'))
  await new Promise(r => setTimeout(r, 700))
  assert.equal(n, 2)
  assert.ok(orch.getWorker('state'))
  assert.notEqual(orch.getWorker('state'), first)
  assert.equal(bus.getSnapshot('worker').filter(e => e.action === 'restarted').length, 1)
})

test('worker exit → 清理映射并触发 onWorkerExit；ui-renderer 模块不可 startWorker', () => {
  const bus = createStateBus()
  const exited = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createWorker: () => fakeWorker(),
    onClosed: () => {}, onWorkerExit: id => exited.push(id), hooks: {},
  })
  orch.startWorker('state')
  const w = orch.getWorker('state')
  w.emit('exit')
  assert.equal(orch.getWorker('state'), null)
  assert.deepEqual(exited, ['state'])
  assert.equal(orch.startWorker('settings').error, 'not a node-worker module')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — parseManifest 拒绝缺 windowSpec；`startWorker` 不存在

- [ ] **Step 3: 实现**

Modify `harness/src/kernel/module-registry.cjs`:

```js
// REQUIRED_MANIFEST_FIELDS 放宽：windowSpec 仅 ui-renderer 语义必需，node-worker/cli-bridge 无窗口
const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'entry']
```

BUILTIN_MODULES 追加（保持 launcher/chat 不动，尾部新增）：

```js
  {
    id: 'state-manager', name: '状态服务', icon: 'database', singleton: true, builtin: true,
    runtime: 'node-worker',
    capabilities: ['state'],
    entry: { main: 'modules/state-manager/main.cjs' },  // repo-root 相对（node-worker 进程入口）
  },
  {
    id: 'settings', name: '设置', icon: 'settings', singleton: false, builtin: true,
    windowSpec: { width: 720, height: 560, minWidth: 480, minHeight: 400, resizable: true, frame: false },
    capabilities: ['state'],  // 与 modules/settings/module.json 对齐：读/写全局状态
    entry: { ui: 'dist/modules/settings/index.html' },
  },
```

（`normalizeEntry` 已支持 `{ main }`；**注意**：parseManifest 现有 `const ws = raw.windowSpec` 后直接 `ws.width`（module-registry.cjs:72/83）——REQUIRED 放宽后缺 windowSpec 的 manifest 会抛 TypeError，**必须**把该行改为 `const ws = raw.windowSpec || {}` 使 `num(ws.width, 640)` 真正回落默认。）

Modify `harness/src/kernel/process-orchestrator.cjs`：

- 顶部注释补充 node-worker 进程模型说明。
- `createProcessOrchestrator({ ..., createWorker, onWorkerExit })` 参数解构追加。
- 新增 workers 管理与方法：

```js
  /** Map<moduleId, Worker>（node-worker 运行时进程；崩溃 respawn 沿用 crashReboot 500ms 守卫） */
  const workers = new Map()

  function startWorker(id) {
    const mod = getModule(id)
    if (!mod || mod.runtime !== 'node-worker') return { ok: false, error: 'not a node-worker module' }
    if (workers.has(id)) return { ok: false, error: 'ALREADY_RUNNING' }
    const worker = createWorker(mod)
    workers.set(id, worker)
    worker.on('error', () => {
      setTimeout(() => {
        if (workers.get(id) !== worker) return  // 竞态守卫：映射已被替换/清理 → 跳过
        workers.delete(id)
        try { worker.terminate?.() } catch {}
        startWorker(id)
        publishState('worker', 'restarted', { moduleId: id })
      }, 500)
    })
    worker.on('exit', () => {
      if (workers.get(id) === worker) { workers.delete(id); onWorkerExit?.(id) }
    })
    publishState('worker', 'started', { moduleId: id })
    return { ok: true, workerId: id }
  }

  function stopWorker(id) {
    const w = workers.get(id)
    if (!w) return { ok: false, error: 'NOT_RUNNING' }
    workers.delete(id)
    try { w.terminate?.() } catch {}
    return { ok: true }
  }

  function getWorker(id) { return workers.get(id) || null }
```

- return 追加 `startWorker, stopWorker, getWorker, keyOf`（keyOf 已有定义，补进 return 列表）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: PASS（新增 4 个测试；既有 28+ 不受影响——`keyOf` 导出与 hooks 追加均为兼容扩展）

- [ ] **Step 5: Commit**

```bash
git add harness/src/kernel/process-orchestrator.cjs harness/src/kernel/module-registry.cjs harness/src/kernel/process-orchestrator.test.mjs harness/src/kernel/module-registry.test.mjs
git commit -m "feat(p2): node-worker 运行时 — orchestrator startWorker/崩溃respawn/exit清理 + registry 加 state-manager/settings"
```

---

### Task 3: state-manager 核心（状态机 + 持久化）

**Files:**
- Create: `modules/state-manager/core.cjs`
- Create: `modules/state-manager/storage.cjs`
- Create: `modules/state-manager/core.test.mjs`
- Create: `modules/state-manager/package.json`

**Interfaces:**
- Consumes: `createStateBus`（`../../electron/state-bus.cjs`，作为快照环形缓冲 + 订阅基座，§7 总线基座）
- Produces: `createStateManager({ bus, storage })` → `{ get, set, list, onChanged }`；`handleRequest(sm, method, params)` → `{ ok, ... }`；`createFileStorage(path)` → `{ load, save }`

- [ ] **Step 1: 写失败测试**

Create `modules/state-manager/package.json`:

```json
{
  "name": "@ponos/module-state-manager",
  "private": true,
  "version": "0.1.0",
  "type": "commonjs"
}
```

Create `modules/state-manager/core.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateBus } from '../../electron/state-bus.cjs'
import { createStateManager, handleRequest } from './core.cjs'

function memStorage(initial = null) {
  let data = initial
  return { load: () => data, save: d => { data = d } }
}

test('get/set/list 基础语义 + per-key version 递增', () => {
  const sm = createStateManager({ bus: createStateBus(), storage: memStorage() })
  assert.deepEqual(sm.get('a'), { ok: true, value: undefined, version: 0 })
  assert.equal(sm.set('a', { theme: 'dark' }, 'settings').version, 1)
  assert.equal(sm.set('a', { theme: 'light' }, 'settings').version, 2)
  assert.deepEqual(sm.get('a'), { ok: true, value: { theme: 'light' }, version: 2 })
  const list = sm.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].key, 'a')
})

test('set 发布 state:changed 总线事件 + onChanged 回调', () => {
  const bus = createStateBus()
  const sm = createStateManager({ bus, storage: memStorage() })
  const seen = []
  sm.onChanged(ev => seen.push(ev))
  sm.set('settings', { theme: 'vaporwave' }, 'settings')
  const snap = bus.getSnapshot('state')
  assert.equal(snap.length, 1)
  assert.equal(snap[0].action, 'changed')
  assert.equal(snap[0].payload.key, 'settings')
  assert.equal(snap[0].payload.version, 1)
  assert.deepEqual(seen, [{ key: 'settings', value: { theme: 'vaporwave' }, version: 1, from: 'settings' }])
})

test('handleRequest 分发 get/set/list，未知方法报错', () => {
  const sm = createStateManager({ bus: createStateBus(), storage: memStorage() })
  assert.equal(handleRequest(sm, 'state.get', { key: 'x' }).ok, true)
  assert.equal(handleRequest(sm, 'state.set', { key: 'x', value: 1, from: 't' }).version, 1)
  assert.equal(handleRequest(sm, 'state.list', {}).ok, true)
  assert.equal(handleRequest(sm, 'state.bogus', {}).ok, false)
})

test('崩溃恢复：同 storage 重建实例状态不丢（验收标准 4）', () => {
  const storage = memStorage()
  const sm1 = createStateManager({ bus: createStateBus(), storage })
  sm1.set('settings', { theme: 'dark' }, 'settings')
  const sm2 = createStateManager({ bus: createStateBus(), storage })
  assert.deepEqual(sm2.get('settings'), { ok: true, value: { theme: 'dark' }, version: 1 })
})
```

Create `modules/state-manager/storage.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileStorage } from './storage.cjs'

test('createFileStorage 读写往返；缺失文件返回 null；损坏 JSON 返回 null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sms-'))
  try {
    const p = path.join(dir, 'state.json')
    const s = createFileStorage(p)
    assert.equal(s.load(), null)
    s.save({ a: 1 })
    assert.deepEqual(s.load(), { a: 1 })
    writeFileSync(p, '{broken')
    assert.equal(s.load(), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test modules/state-manager/core.test.mjs modules/state-manager/storage.test.mjs`
Expected: FAIL — `Cannot find module './core.cjs'`

- [ ] **Step 3: 实现**

Create `modules/state-manager/core.cjs`:

```js
'use strict'

/**
 * state-manager 核心（纯逻辑，worker 线程内运行，无 electron/无宿主依赖）。
 * 状态数据权威在本进程内存；set 时发布 bus 事件（快照环形缓冲）+ 回调通知 + 持久化。
 * storage duck：{ load() → data|null, save(data) }（测试注入内存实现，生产用 createFileStorage）。
 */
function createStateManager({ bus, storage }) {
  /** Map<key, { value, version }> */
  const state = new Map()
  const listeners = new Set()

  function load() {
    const data = storage?.load?.()
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'value' in v) state.set(k, v)
      }
    }
  }
  load()

  function save() {
    storage?.save?.(Object.fromEntries(state))
  }

  function get(key) {
    const s = state.get(key)
    return s ? { ok: true, value: s.value, version: s.version } : { ok: true, value: undefined, version: 0 }
  }

  function set(key, value, from) {
    const cur = state.get(key)
    const version = (cur?.version || 0) + 1
    state.set(key, { value, version })
    const ev = { key, value, version, from: from || 'unknown' }
    bus?.publish({ channel: 'state', action: 'changed', payload: ev, from: from || 'state-manager' })
    for (const cb of listeners) { try { cb(ev) } catch {} }
    save()
    return { ok: true, version }
  }

  function list() {
    return [...state.entries()].map(([key, s]) => ({ key, value: s.value, version: s.version }))
  }

  function onChanged(cb) { listeners.add(cb); return () => listeners.delete(cb) }

  return { get, set, list, onChanged }
}

/** worker 入口请求分发（薄壳，可单测）。返回统一 { ok, ... } 或 { ok:false, error }。 */
function handleRequest(sm, method, params = {}) {
  try {
    if (method === 'state.get') return sm.get(params.key)
    if (method === 'state.set') return sm.set(params.key, params.value, params.from)
    if (method === 'state.list') return { ok: true, result: sm.list() }
    return { ok: false, error: `METHOD_NOT_FOUND: ${method}` }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

module.exports = { createStateManager, handleRequest }
```

Create `modules/state-manager/storage.cjs`:

```js
'use strict'

const fs = require('node:fs')

/** JSON 文件持久化（零原生依赖）。load 容错：文件缺失/损坏返回 null。 */
function createFileStorage(path) {
  return {
    load() {
      try {
        const raw = fs.readFileSync(path, 'utf8')
        return JSON.parse(raw)
      } catch { return null }
    },
    save(data) {
      fs.mkdirSync(require('node:path').dirname(path), { recursive: true })
      fs.writeFileSync(path, JSON.stringify(data, null, 2))
    },
  }
}

module.exports = { createFileStorage }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test modules/state-manager/core.test.mjs modules/state-manager/storage.test.mjs`
Expected: PASS（3 + 1 测试）

- [ ] **Step 5: Commit**

```bash
git add modules/state-manager/
git commit -m "feat(p2): state-manager 核心 — get/set/onChanged + 快照总线 + JSON 持久化（崩溃恢复可测）"
```

---

### Task 4: state-manager worker 入口 + 宿主 rpc client

**Files:**
- Create: `modules/state-manager/main.cjs`（worker_threads 入口薄壳）
- Create: `modules/state-manager/main.test.mjs`
- Create: `harness/src/kernel/state-manager-client.cjs`
- Test: `harness/src/kernel/state-manager-client.test.mjs`

**Interfaces:**
- Consumes: Task 1 `createWorkerTransport`（宿主侧）、Task 3 `createStateManager/handleRequest/createFileStorage`
- Produces: worker 入口协议——请求 `{ id, method, params }`（宿主→worker），响应 `{ id, result | error }`；通知 `{ method:'state.changed', params }`（worker→宿主，无 id）；`createStateManagerClient({ transport })` → `{ call(method, params) → Promise, onNotification(cb) → off }`

- [ ] **Step 1: 写失败测试（worker 入口分发 + 宿主 client）**

Create `modules/state-manager/main.test.mjs`（测入口暴露的纯逻辑 `runWorker({ port, bus, storage, env })`）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorker } from './main.cjs'

function fakePort() {
  const listeners = {}
  return {
    sent: [],
    postMessage(m) { this.sent.push(m) },
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
  }
}
function memStorage() { let d = null; return { load: () => d, save: v => { d = v } } }

test('runWorker 响应 get/set 请求并把 changed 发为通知', () => {
  const port = fakePort()
  const sm = runWorker({ port, bus: null, storage: memStorage(), createBus: () => null })
  port.emit('message', { id: 1, method: 'state.set', params: { key: 'settings', value: { theme: 'dark' }, from: 't' } })
  port.emit('message', { id: 2, method: 'state.get', params: { key: 'settings' } })
  const setResp = port.sent.find(m => m.id === 1)
  assert.equal(setResp.result.version, 1)
  const getResp = port.sent.find(m => m.id === 2)
  assert.deepEqual(getResp.result, { ok: true, value: { theme: 'dark' }, version: 1 })
  const notif = port.sent.find(m => m.id === undefined && m.method === 'state.changed')
  assert.equal(notif.params.key, 'settings')
})
```

Create `harness/src/kernel/state-manager-client.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateManagerClient } from './state-manager-client.cjs'

function fakeTransport() {
  const listeners = []
  return {
    sent: [],
    send(env) { this.sent.push(env) },
    onMessage(cb) { listeners.push(cb) },
    emit(m) { listeners.forEach(cb => cb(m)) },
  }
}

test('call 请求带递增 id，响应经 id 配对 resolve', async () => {
  const t = fakeTransport()
  const c = createStateManagerClient({ transport: t })
  const p = c.call('state.get', { key: 'a' })
  assert.equal(t.sent[0].id, 1)
  assert.equal(t.sent[0].method, 'state.get')
  t.emit({ id: 1, result: { ok: true, value: 1, version: 0 } })
  assert.deepEqual(await p, { ok: true, value: 1, version: 0 })
})

test('error 响应 reject；无 id 消息走 onNotification', async () => {
  const t = fakeTransport()
  const c = createStateManagerClient({ transport: t })
  const got = []
  c.onNotification(m => got.push(m))
  const p = c.call('state.set', { key: 'a', value: 1, from: 'x' })
  t.emit({ id: 1, error: 'boom' })
  await assert.rejects(p, /boom/)
  t.emit({ method: 'state.changed', params: { key: 'a' } })
  assert.equal(got.length, 1)
  assert.equal(got[0].params.key, 'a')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test && node --test modules/state-manager/main.test.mjs`
Expected: FAIL — `Cannot find module './state-manager-client.cjs'` / `'./main.cjs'`

- [ ] **Step 3: 实现**

Create `modules/state-manager/main.cjs`:

```js
'use strict'

const { parentPort } = require('node:worker_threads')
const { createStateBus } = require('../../electron/state-bus.cjs')
const { createStateManager, handleRequest } = require('./core.cjs')
const { createFileStorage } = require('./storage.cjs')

/**
 * worker 入口装配：parentPort ↔ 状态机。请求 { id, method, params } → 响应 { id, result|error }；
 * set 触发 changed → 通知 { method:'state.changed', params }（无 id）。
 * 抽 runWorker 便于单测（port duck { postMessage, on }）。
 */
function runWorker({ port, storage, bus = createStateBus(), createBus = () => bus }) {
  const sm = createStateManager({ bus: createBus(), storage })
  sm.onChanged(ev => port.postMessage({ method: 'state.changed', params: ev }))
  port.on('message', req => {
    if (!req || req.id === undefined) return
    const res = handleRequest(sm, req.method, req.params)
    port.postMessage({ id: req.id, ...res })
  })
  return sm
}

if (require.main === module) {
  const storagePath = process.env.STATE_STORE_PATH
  runWorker({ port: parentPort, storage: createFileStorage(storagePath) })
}

module.exports = { runWorker }
```

（`{ id, ...res }` 使 `{ ok:true, value, version }` 或 `{ ok:false, error }` 原样回传。）

Create `harness/src/kernel/state-manager-client.cjs`:

```js
'use strict'

/** 宿主侧 state-manager rpc client：请求/响应经递增 id 配对，无 id 消息分发通知。 */
function createStateManagerClient({ transport }) {
  let seq = 0
  const pending = new Map()
  const notifications = new Set()
  transport.onMessage(msg => {
    if (msg && msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      }
    } else {
      for (const cb of notifications) { try { cb(msg) } catch {} }
    }
  })
  return {
    call(method, params) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        transport.send({ id, method, params })
      })
    },
    onNotification(cb) { notifications.add(cb); return () => notifications.delete(cb) },
  }
}

module.exports = { createStateManagerClient }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test && node --test modules/state-manager/main.test.mjs`
Expected: PASS（client 2 个 + worker 入口 1 个新测试）

- [ ] **Step 5: Commit**

```bash
git add modules/state-manager/main.cjs modules/state-manager/main.test.mjs harness/src/kernel/state-manager-client.cjs harness/src/kernel/state-manager-client.test.mjs
git commit -m "feat(p2): state-manager worker 入口 + 宿主 rpc client（id 配对/通知分发）"
```

---

### Task 5: mr.broadcast 增强（推送 attach 模块）

**Files:**
- Modify: `harness/src/kernel/message-router.cjs`
- Test: `harness/src/kernel/message-router.test.mjs`

**Interfaces:**
- Consumes: P1 `broadcast({ channel, event, sender })`（现仅 bus.publish）
- Produces: broadcast 同时推送所有 attach 模块 `target.send('rpc:event:<channel>', makeEnvelope({ method:'event:<channel>', params:event, x_sender:sender }))`；Task 7 把 state.changed 通知转为 `mr.broadcast({ channel:'state', event:{ type:'changed', ...params }, sender:'state-manager' })`，模块 UI `ponosRpc.on('event:state.changed')` 收到 `env.params`

- [ ] **Step 1: 写失败测试**

追加到 `harness/src/kernel/message-router.test.mjs`：

```js
test('broadcast 增强：bus 订阅保留 + 推送所有 attach 模块 rpc:event:<channel>', () => {
  const bus = createStateBus()
  const router = createRouter()
  const mr = createMessageRouter({ router, bus })
  const a = fakeTarget(); const b = fakeTarget()
  mr.attach('chat', a, ['chat']); mr.attach('settings', b, ['state'])
  const busT = fakeTarget()
  bus.subscribe('intent', busT)
  const event = { type: 'changed', key: 'settings', value: { theme: 'dark' }, version: 1, from: 'settings' }
  mr.broadcast({ channel: 'state', event, sender: 'state-manager' })
  assert.equal(busT.sent.length, 1)
  assert.equal(busT.sent[0].channel, 'bus:event:state')
  for (const t of [a, b]) {
    assert.equal(t.sent.length, 1)
    assert.equal(t.sent[0].channel, 'rpc:event:state')
    assert.equal(t.sent[0].data.params.key, 'settings')
    assert.equal(t.sent[0].data.method, 'event:state')
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — attach 模块 target 未收到 `rpc:event:state`

- [ ] **Step 3: 实现**

Modify `harness/src/kernel/message-router.cjs` 的 `broadcast`：

```js
  function broadcast({ channel, event, sender }) {
    const full = { channel, action: event?.type || 'event', payload: event, from: sender, ts: Date.now() }
    bus.publish(full)
    // P2：广播同时推送所有 attach 模块（rpc:event:<channel>），模块 UI ponosRpc.on('event:<channel>') 订阅
    const env = makeEnvelope({ method: `event:${channel}`, params: event, x_sender: sender || 'bus' })
    for (const conn of connections.values()) {
      try { conn.target.send(`rpc:${env.method}`, env) } catch { /* 窗口销毁，忽略 */ }
    }
  }
```

（`makeEnvelope` 已在文件顶部导入；P1 broadcast 测试的 bus 断言保持不变。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: PASS（新增 broadcast 增强断言；P1 既有 broadcast 用例仍绿）

- [ ] **Step 5: Commit**

```bash
git add harness/src/kernel/message-router.cjs harness/src/kernel/message-router.test.mjs
git commit -m "feat(p2): broadcast 增强 — bus 保留 + 推送所有 attach 模块（event:state.changed 通道）"
```

---

### Task 6: settings 模块（第一个状态消费模块）

**Files:**
- Create: `modules/settings/module.json`
- Create: `modules/settings/index.html`
- Create: `modules/settings/package.json`
- Create: `modules/settings/src/main.tsx`
- Create: `modules/settings/src/App.tsx`
- Create: `modules/settings/src/state.ts`
- Create: `modules/settings/src/App.test.mjs`
- Modify: `vite.modules.config.ts`（input 加 settings）
- Modify: root `package.json`（test 脚本聚合 `modules/settings/src/App.test.mjs`——改为通配 `modules/*/src/App.test.mjs` 已含）

**Interfaces:**
- Consumes: `window.ponosRpc`（preload）；Task 3 `state.get/set` 语义、Task 5 `event:state.changed`
- Produces: settings UI：主题下拉（vaporwave/dark/light）+ 模型配置占位；挂载时 `state.get('settings')` 初始化、`ponosRpc.on('event:state.changed')` 实时刷新；变更 `state.set('settings', {...}, 'settings')`；纯逻辑 `reduceSettings(state, ev)` 可单测

- [ ] **Step 1: 写失败测试**

Create `modules/settings/package.json`:

```json
{
  "name": "@ponos/module-settings",
  "private": true,
  "version": "0.1.0",
  "type": "module"
}
```

Create `modules/settings/src/App.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, reduceSettings } from './state.ts'

test('reduceSettings 归并 settings key 的 changed 事件，忽略其他 key', () => {
  let s = DEFAULT_SETTINGS
  s = reduceSettings(s, { key: 'settings', value: { theme: 'dark' }, version: 1 })
  assert.equal(s.theme, 'dark')
  s = reduceSettings(s, { key: 'other', value: 1 })
  assert.equal(s.theme, 'dark', '非 settings key 应忽略')
  assert.equal(reduceSettings(DEFAULT_SETTINGS, { key: 'settings' }).theme, 'vaporwave', '缺 value 时保持默认')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test modules/settings/src/App.test.mjs`
Expected: FAIL — `Cannot find module './state.ts'`

- [ ] **Step 3: 实现**

Create `modules/settings/module.json`:

```json
{
  "id": "settings",
  "name": "设置",
  "version": "0.1.0",
  "runtime": "ui-renderer",
  "icon": "settings",
  "entry": { "ui": "../../dist/modules/settings/index.html" },
  "windowSpec": { "width": 720, "height": 560, "minWidth": 480, "minHeight": 400, "resizable": true, "frame": false },
  "singleton": false,
  "capabilities": ["state"]
}
```

Create `modules/settings/index.html`（同 launcher 模板，title「设置」）：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>设置</title>
  <link rel="stylesheet" href="../../src/styles/globals.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./src/main.tsx"></script>
</body>
</html>
```

Create `modules/settings/src/state.ts`:

```ts
export interface SettingsState { theme: string; provider: string; model: string }

export const DEFAULT_SETTINGS: SettingsState = { theme: 'vaporwave', provider: '', model: '' }

/** event:state.changed → { key, value, version }；仅归并 settings key 且 value 为对象时应用。 */
export function reduceSettings(state: SettingsState, ev: any): SettingsState {
  if (ev?.key !== 'settings') return state
  const v = ev?.value
  if (!v || typeof v !== 'object') return state
  return { ...state, ...v }
}
```

Create `modules/settings/src/App.tsx`:

```tsx
import React, { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, reduceSettings, type SettingsState } from './state'

declare global { interface Window { ponosRpc?: { call: (m: string, p?: any) => Promise<any>; on: (m: string, cb: (e: any) => void) => () => void } } }

const THEMES = [
  { id: 'vaporwave', label: 'Vaporwave' },
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
]

export function App() {
  const [state, setState] = useState<SettingsState>(DEFAULT_SETTINGS)
  useEffect(() => {
    window.ponosRpc?.call('state.get', { key: 'settings' }).then(r => {
      if (r?.ok && r.result?.value) setState(s => ({ ...s, ...r.result.value }))
    })
    const off = window.ponosRpc?.on('event:state.changed', (env) => setState(s => reduceSettings(s, env?.params)))
    return () => off?.()
  }, [])
  const setTheme = (theme: string) => {
    const next = { ...state, theme }
    setState(next)
    window.ponosRpc?.call('state.set', { key: 'settings', value: next, from: 'settings' })
  }
  return (
    <div className="p-6 space-y-4">
      <h2 className="text-base font-bold">设置</h2>
      <label className="block text-sm text-[var(--text-secondary)]">主题</label>
      <select className="w-full bg-[var(--bg-input)] rounded px-3 py-2" value={state.theme} onChange={e => setTheme(e.target.value)}>
        {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <p className="text-xs text-[var(--text-tertiary)]">状态经 state-manager 全局同步：打开两个设置窗口，此处修改会实时同步到所有订阅窗口。</p>
    </div>
  )
}
```

Create `modules/settings/src/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
```

Modify `vite.modules.config.ts` 的 `rollupOptions.input` 增加 settings 入口（launcher/chat 保持不变）：

```ts
      input: {
        launcher: path.resolve(__dirname, 'modules/launcher/index.html'),
        chat: path.resolve(__dirname, 'modules/chat/index.html'),
        settings: path.resolve(__dirname, 'modules/settings/index.html'),
      },
```

- [ ] **Step 4: 构建并验证产物**

Run: `npm run build:modules && ls dist/modules/settings/`
Expected: `dist/modules/settings/index.html` 与 JS 产物存在

Run: `node --test "modules/settings/src/App.test.mjs" && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: settings 测试 PASS；root 套件 550 tests（聚合后 +1）

- [ ] **Step 5: Commit**

```bash
git add modules/settings/ vite.modules.config.ts
git commit -m "feat(p2): settings 模块 — state.get/set + event:state.changed 订阅（双窗口同步载体）"
```

---

### Task 7: main.cjs 装配 + 冒烟 + 崩溃重连

**Files:**
- Modify: `harness/src/main.cjs`（buildApp：createWorker 注入 → orchestrator 传参；state-manager client 装配；router 注册 state.*；通知 → mr.broadcast；worker started 事件 → 重连）
- Modify: `harness/src/main.test.mjs`（ALLOWED 冒烟：settings 窗口 state.get/set 经 router → worker）

**Interfaces:**
- Consumes: Task 1 `createWorkerTransport`、Task 2 `startWorker/getWorker`、Task 4 `createStateManagerClient`、Task 5 `broadcast`
- Produces: 可运行链路——settings 窗口 `state.get/set` → router → client → worker；`event:state.changed` → broadcast → 所有窗口；worker 崩溃 respawn 后宿主重连（bus 'worker:started' 订阅驱动）

- [ ] **Step 1: 写失败测试（main 装配冒烟）**

追加到 `harness/src/main.test.mjs`：

```js
test('settings 窗口 state.get 经 router → worker，changed 通知广播到 attach 模块', async () => {
  const handlers = new Map()
  const WC = {}
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  // fake worker：捕获 postMessage 请求；测试手动注入响应
  const listeners = {}
  const worker = {
    sent: [],
    postMessage(m) { this.sent.push(m) },
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
    terminate() { this.terminated = true },
  }
  const ctx = buildApp({
    ipcMain,
    createWindow: () => ({ isDestroyed: () => false, on() {}, destroy() {}, close() {}, webContents: WC }),
    createWorker: () => worker,
    kernelArgs: { spawnImpl: () => fakeChild(), readlineImpl: () => ({ on() {} }) },
  })
  ctx.orchestrator.open('settings')  // attach settings（caps ['state']）
  const callFn = handlers.get('ponos:call')

  // settings → state.get：router 代理 → client 请求 → fake worker 收到
  const p = callFn({ sender: WC }, { method: 'state.get', params: { key: 'settings' } })
  const req = worker.sent.find(m => m.id !== undefined && m.method === 'state.get')
  assert.ok(req, 'client 请求应到达 worker')
  worker.emit('message', { id: req.id, result: { ok: true, value: { theme: 'dark' }, version: 1 } })
  const res = await p
  assert.equal(res.ok, true)
  assert.equal(res.result.value.theme, 'dark')

  // worker 通知 → broadcast → attach 模块收到 rpc:event:state
  worker.emit('message', { method: 'state.changed', params: { key: 'settings', value: { theme: 'dark' }, version: 1, from: 'settings' } })
  // 等待广播异步送达（broadcast 同步执行，client 通知同步分发 → 立即断言）
  const targets = []
  await new Promise(r => setTimeout(r, 0))
  // 通过再次 call 验证链路完好（通知不破坏状态）
  const p2 = callFn({ sender: WC }, { method: 'state.get', params: { key: 'settings' } })
  worker.emit('message', { id: p2 && worker.sent.at(-1).id, result: { ok: true, value: { theme: 'dark' }, version: 1 } })
  const res2 = await p2
  assert.equal(res2.ok, true)
})
```

（广播送达断言较脆，冒烟以「链路可达 + 状态读回」为主；广播推送本身由 Task 5 单测覆盖。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `state.get` 返回 `METHOD_NOT_FOUND`（未注册）

- [ ] **Step 3: 实现**

Modify `harness/src/main.cjs`：

- 顶部导入追加：

```js
const { createWorkerTransport } = require('./rpc/transports/worker-transport.cjs')
const { createStateManagerClient } = require('./kernel/state-manager-client.cjs')
```

- `buildApp` 签名解构追加 `createWorker`；`createProcessOrchestrator` 调用追加 `createWorker, onWorkerExit`：

```js
  const orchestrator = createProcessOrchestrator({
    getModule, bus, createWindow, createWorker, onWorkerExit: () => {},
    onClosed: key => mr.detach(key.split('::')[0]),
    hooks: { ... },
  })
```

- 方法集注册区（router.register 之后）追加状态服务装配：

```js
  // —— 状态服务（node-worker：state-manager）——
  // worker started 事件驱动连接重建（崩溃 respawn 后重新绑定 transport/client/attach）
  let smTransport = null
  let smClient = null
  function connectStateManager() {
    const worker = orchestrator.getWorker('state-manager')
    if (!worker) return
    smTransport?.close()
    smTransport = createWorkerTransport({ worker })
    smClient = createStateManagerClient({ transport: smTransport })
    smClient.onNotification(ev => {
      if (ev?.method === 'state.changed') {
        mr.broadcast({ channel: 'state', event: { type: 'changed', ...(ev.params || {}) }, sender: 'state-manager' })
      }
    })
    mr.attach('state-manager', { send: env => smTransport.send(env) }, [])
  }
  bus.subscribe('worker', { send: (ch, full) => { if (full?.action === 'started' && full.payload?.moduleId === 'state-manager') connectStateManager() } })
  router.register('state.get', (p) => smClient ? smClient.call('state.get', { key: p?.key }) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  router.register('state.set', (p) => smClient ? smClient.call('state.set', { key: p?.key, value: p?.value, from: p?.from }) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  router.register('state.list', () => smClient ? smClient.call('state.list', {}) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  orchestrator.startWorker('state-manager')  // 触发 worker:started → connectStateManager
```

（`bus.subscribe` 的 target duck 是 `{ send(channel, data) }`——与 state-bus 契约一致；`smClient` 可能为 null（worker 未启动），handler 用 `smClient ? ... : NOT_RUNNING` 防御——**注意**：handler 闭包引用 `smClient` 变量（let），reconnect 后新 client 生效，无需重注册 handler。）

- `require.main` 分支的 `buildApp({ ipcMain, createWindow: ..., createWorker: ... })` 追加 createWorker（真实 Worker 构造）：

```js
      createWorker: (mod) => new (require('node:worker_threads').Worker)(path.join(__dirname, '..', '..', 'modules', 'state-manager', 'main.cjs'), {
        env: { ...process.env, STATE_STORE_PATH: path.join(app.getPath('userData'), 'state-store.json') },
      }),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: PASS（新增装配冒烟；既有 launcher deny / chat ALLOWED 用例不受影响）

Run: `node --test modules/state-manager/main.test.mjs modules/settings/src/App.test.mjs`
Expected: PASS

- [ ] **Step 5: e2e 手测清单（双窗口状态同步，验收标准 1/2）**

Run: `npm run build:modules && npm run electron`
Manual checklist:
- [ ] 启动出现 Launcher；打开「设置」窗口（无壳标题栏阶段，模块页内操作）
- [ ] 再开一个「设置」窗口；在 A 改主题 → B 实时同步（event:state.changed 广播）
- [ ] 关闭 B 再重开 → 主题保持 A 的修改（state.get 恢复 + 持久化）
- [ ] Chat 窗口仍可对话（回归）

- [ ] **Step 6: Commit**

```bash
git add harness/src/main.cjs harness/src/main.test.mjs
git commit -m "feat(p2): main 装配 — state-manager spawn + state.* 代理 + changed 广播 + 崩溃重连"
```

---

### Task 8: 窗口壳统一标题栏

**Files:**
- Create: `harness/src/shell.html`
- Create: `harness/src/shell.js`
- Modify: `harness/src/kernel/process-orchestrator.cjs`（minimize/maximize/contextByKey）
- Modify: `harness/src/kernel/process-orchestrator.test.mjs`
- Modify: `harness/src/main.cjs`（createWindow 加载 shell.html + query module/key + nodeIntegrationInSubFrames + 注册 system.window.minimize/maximize/context；close 支持 key）
- Modify: `harness/src/main.test.mjs`（context 冒烟）

**Interfaces:**
- Consumes: Task 2 `keyOf` 导出；P1 `system.window.open/close`、`instanceOf`
- Produces: 窗口壳——所有 ui-renderer 窗口由 shell.html 渲染标题栏（图标+名称+最小化/最大化/关闭+会话下拉骨架）+ iframe 内容区；`orchestrator.minimize(key)/maximize(key)/context(key)`；RPC `system.window.minimize/maximize/context`；`system.window.close` 扩展 `{ key }`；preload 经 `nodeIntegrationInSubFrames: true` 注入 iframe 内模块 UI 的 `window.ponosRpc`

- [ ] **Step 1: 写失败测试（orchestrator 窗口控制 + context）**

追加到 `harness/src/kernel/process-orchestrator.test.mjs`：

```js
test('minimize/maximize/contextByKey 按 key 定位窗口操作', () => {
  const bus = createStateBus()
  const created = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus,
    createWindow: (mod, params) => { const w = fakeWin(bus); w.key = orch.keyOf(mod.id, params); created.push(w); return w },
    onClosed: () => {}, hooks: {},
  })
  orch.open('chat', { conversation: 's1' })
  const win = created[0]
  assert.equal(orch.minimize('chat::s1').ok, true)
  assert.equal(win.minimized, true)
  assert.equal(orch.maximize('chat::s1').ok, true)
  const ctx = orch.context('chat::s1')
  assert.equal(ctx.ok, true)
  assert.equal(ctx.result.name, '聊天')
  assert.deepEqual(ctx.result.conversations, ['s1'])
  assert.equal(ctx.result.current, 's1')
  assert.equal(orch.minimize('chat::nope').ok, false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ponos/harness test`
Expected: FAIL — `minimize` 不存在

- [ ] **Step 3: 实现 orchestrator + main + 壳**

Modify `harness/src/kernel/process-orchestrator.cjs`（追加方法并导出）：

```js
  /** 按实例 key 最小化窗口（非 singleton 多实例由 key 精确定位）。 */
  function minimize(key) {
    const win = windows.get(key)
    if (!win || win.isDestroyed()) return { ok: false, error: 'window not found' }
    win.minimize()
    return { ok: true }
  }

  /** 按实例 key 最大化/还原切换。 */
  function maximize(key) {
    const win = windows.get(key)
    if (!win || win.isDestroyed()) return { ok: false, error: 'window not found' }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { ok: true }
  }

  /** 窗口壳上下文：名称/图标/会话实例列表/当前会话 + entry（宿主转 file URL）。 */
  function context(key) {
    const win = windows.get(key)
    if (!win || win.isDestroyed()) return { ok: false, error: 'window not found' }
    const id = key.split('::')[0]
    const mod = getModule(id)
    if (!mod) return { ok: false, error: 'unknown module' }
    const conversations = [...windows.keys()]
      .filter(k => k === id || k.startsWith(`${id}::`))
      .map(k => { const p = k.indexOf('::'); return p === -1 ? '' : k.slice(p + 2) })
      .filter(Boolean)
    const p = key.indexOf('::')
    return {
      ok: true,
      result: { name: mod.name, icon: mod.icon || '', entry: mod.entry?.ui || '', conversations, current: p === -1 ? '' : key.slice(p + 2) },
    }
  }

  function closeByKey(key) {
    const win = windows.get(key)
    if (!win || win.isDestroyed()) return { ok: false, error: 'window not found' }
    win.close()
    return { ok: true }
  }
```

return 追加 `minimize, maximize, context, closeByKey`（`keyOf` 已在 Task 2 导出）。

Modify `harness/src/kernel/process-orchestrator.test.mjs` 的 fakeWin：追加 `minimized` 已存在（P1 fakeWin 有 `minimized` 字段与 `restore`）；补 `minimize() { this.minimized = true }`、`isMaximized() { return this.maximized }`、`maximize() { this.maximized = true }`、`unmaximize() { this.maximized = false }` 到共享 fakeWin。

Modify `harness/src/main.cjs`：

- `createWindow`（require.main 分支）改加载壳页：

```js
      createWindow: (mod, params) => {
        const spec = mod.windowSpec || { width: 800, height: 600 }
        const win = new BrowserWindow({
          width: spec.width, height: spec.height, minWidth: spec.minWidth, minHeight: spec.minHeight,
          resizable: spec.resizable !== false, frame: false,
          webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
            nodeIntegrationInSubFrames: true,  // P2 壳：preload 注入 iframe 内模块 UI
          },
        })
        const key = ctx.orchestrator.keyOf(mod.id, params)
        win.loadFile(path.join(__dirname, 'shell.html'), { query: { module: mod.id, key } })
        return win
      },
```

（`ctx` 声明提前到 `buildApp({...})` 返回后、`createWindow` 引用前——重构：`let ctx; const createWindow = ...; ctx = buildApp({ createWindow, ... })` 或把 createWindow 内联进 buildApp 参数对象并用闭包变量。选前者：`let ctx = null` 声明于 `app.whenReady().then(() => {` 内、`const ctx = buildApp(...)` 改 `ctx = buildApp(...)`。）

- router 注册区追加窗口控制方法：

```js
  router.register('system.window.minimize', (p) => orchestrator.minimize(p?.key), { capabilities: ['system.window'] })
  router.register('system.window.maximize', (p) => orchestrator.maximize(p?.key), { capabilities: ['system.window'] })
  router.register('system.window.context', (p) => {
    const r = orchestrator.context(p?.key)
    if (!r.ok) return r
    const entryUrl = r.result.entry
      ? require('node:url').pathToFileURL(path.resolve(__dirname, '..', '..', r.result.entry)).href
      : ''
    return { ok: true, result: { ...r.result, entryUrl } }
  }, { capabilities: ['system.window'] })
  // system.window.close 扩展：{ key } 精确定位
  router.register('system.window.close', (p) => p?.key ? orchestrator.closeByKey(p.key) : orchestrator.close(p?.moduleId, p?.params), { capabilities: ['system.window'] })
```

（原 `system.window.close` 注册替换为新双形态版本。）

Create `harness/src/shell.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Ponos</title>
  <link rel="stylesheet" href="../../src/styles/globals.css" />
  <style>
    html, body { height: 100%; margin: 0; overflow: hidden; background: var(--bg-app); color: var(--text-primary); }
    .shell { display: flex; flex-direction: column; height: 100%; }
    .titlebar { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 8px 0 12px;
      background: var(--bg-toolbar); border-bottom: 1px solid var(--border-subtle); user-select: none; -webkit-app-region: drag; }
    .titlebar button { -webkit-app-region: no-drag; background: none; border: none; color: var(--text-secondary);
      font-size: 14px; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; }
    .titlebar button:hover { background: var(--bg-hover); }
    .shell-icon { font-size: 14px; color: var(--accent-default); }
    .shell-title { font-size: 13px; font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .btn-group { display: flex; gap: 2px; -webkit-app-region: no-drag; }
    .session { font-size: 12px; color: var(--text-tertiary); margin-right: 8px; }
    .content { flex: 1; position: relative; }
    .content iframe { width: 100%; height: 100%; border: none; background: var(--bg-app); }
  </style>
</head>
<body>
  <div class="shell">
    <div class="titlebar">
      <span class="shell-icon" id="icon">◈</span>
      <span class="shell-title" id="title">加载中…</span>
      <span class="session" id="session"></span>
      <div class="btn-group">
        <button id="btn-new" title="新建会话">＋</button>
        <button id="btn-min" title="最小化">─</button>
        <button id="btn-max" title="最大化">□</button>
        <button id="btn-close" title="关闭">✕</button>
      </div>
    </div>
    <div class="content"><iframe id="frame"></iframe></div>
  </div>
  <script src="./shell.js"></script>
</body>
</html>
```

Create `harness/src/shell.js`:

```js
// 窗口壳：标题栏 + iframe 内容区。模块 UI 经 nodeIntegrationInSubFrames 获得 window.ponosRpc。
const q = new URLSearchParams(location.search)
const winKey = q.get('key')
const $ = s => document.querySelector(s)
const ICONS = { vortex: '◈', settings: '⚙', 'message-square': '≡', database: '▤' }

function iconChar(name) { return ICONS[name] || '◇' }

async function boot() {
  const r = await window.ponosRpc?.call('system.window.context', { key: winKey })
  if (r?.ok) {
    $('#icon').textContent = iconChar(r.result.icon)
    $('#title').textContent = r.result.name
    const conv = r.result.current
    $('#session').textContent = conv ? `会话 ${conv.slice(0, 6)}` : '默认会话'
    $('#frame').src = r.result.entryUrl
  } else {
    $('.shell-title').textContent = '加载失败'
  }
}

$('#btn-min').onclick = () => window.ponosRpc?.call('system.window.minimize', { key: winKey })
$('#btn-max').onclick = () => window.ponosRpc?.call('system.window.maximize', { key: winKey })
$('#btn-close').onclick = () => window.ponosRpc?.call('system.window.close', { key: winKey })
// 会话下拉骨架（P3 完整会话管理）：新建会话 = 打开同模块新实例
$('#btn-new').onclick = () => {
  const moduleId = q.get('module')
  const conv = crypto.randomUUID()
  window.ponosRpc?.call('system.window.open', { moduleId, params: { conversation: conv } })
}

boot()
```

Modify `harness/src/main.test.mjs` 追加 context 冒烟（可选，orchestrator 单测已覆盖核心；main 层验证 RPC 注册可达即可——在既有 buildApp 用例中追加一行断言）：

```js
  // 窗口壳 RPC 可达（context 按 key 反查模块信息）
  const ctxR = await ctx.router.invoke({ method: 'system.window.context', x_sender: 'launcher', params: { key: 'launcher' } })
  assert.equal(ctxR.ok, true)
  assert.equal(ctxR.result.name, '启动台')
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ponos/harness test`
Expected: PASS（orchestrator 新 1 测试 + main context 断言；P1/P2 全部既有用例保持）

- [ ] **Step 5: e2e 手测清单（窗口壳验收）**

Run: `npm run build:modules && npm run electron`
Manual checklist:
- [ ] 所有窗口（launcher/chat/settings）出现统一标题栏：图标 + 名称 + 会话 + 三个按钮
- [ ] 最小化/最大化/关闭按钮工作正常
- [ ] iframe 内模块 UI 正常加载并可交互（launcher 点开 chat、settings 改主题双窗口同步仍工作）
- [ ] 「＋」新建会话打开同模块新实例窗口
- [ ] 关掉全部窗口 → 进程退出（window-all-closed）

- [ ] **Step 6: 全量回归**

Run: `pnpm --filter @ponos/harness test && npm test`
Expected: harness 全 PASS；root 套件 550 tests（5 个 pre-existing server 失败除外，与 P1 结论一致）

- [ ] **Step 7: Commit**

```bash
git add harness/src/shell.html harness/src/shell.js harness/src/kernel/process-orchestrator.cjs harness/src/kernel/process-orchestrator.test.mjs harness/src/main.cjs harness/src/main.test.mjs
git commit -m "feat(p2): 窗口壳统一标题栏 — shell.html + iframe 内容区 + min/max/context RPC + 会话骨架"
```

---

## Self-Review 记录

- **Spec 覆盖**：§5 node-worker 运行时 → Task 2；§7 状态即服务（state-manager get/set/subscribe + event:state.changed + 总线基座 + 渲染层状态清理）→ Task 3/4/5/6/7 + 范围裁决 2；§9 窗口壳 → Task 8（会话色钥/连接徽章/命令面板留 P4）；Phase 2 全部动作 → Task 1-8；验收标准 4 条 → Task 3（持久化恢复测试）/Task 7（e2e 冒烟）/Task 6（渲染层 store 范围裁决）。
- **Placeholder 扫描**：无 TBD/TODO；`createWindow` 的 `ctx` 声明提前已给出重构说明；`smClient` 闭包引用 let 变量已说明。
- **Type 一致性**：`createWorkerTransport`（Task 1）→ Task 4 宿主 client / Task 7 装配一致；`startWorker/getWorker`（Task 2）→ Task 7 `connectStateManager` 使用一致；`createStateManager/handleRequest`（Task 3）→ Task 4 `runWorker` 一致；`mr.broadcast` 签名（Task 5）→ Task 7 通知转广播一致；`keyOf`（Task 2 导出）→ Task 8 createWindow/context 一致；`state.set` version 语义（Task 3）→ Task 6 reduceSettings 事件负载一致；模块 entry 双约定（BUILTIN_MODULES repo-root 相对 / module.json 模块目录相对）沿用 P1。
- **依赖顺序**：Task 8 最后（壳改造影响全部窗口加载，放收尾前需全量回归）。
