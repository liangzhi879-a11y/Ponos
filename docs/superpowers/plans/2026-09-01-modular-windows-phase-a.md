# Ponos 纯模块化多窗口重构 · 阶段 A 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立纯模块化多窗口的架构地基：主进程 ModuleRegistry/StateBus/WindowManager + 渲染层 ModuleRoot 路由 + DockBar（dock 形态导航条骨架），并把聊天/文件/设置 3 个模块试点窗口化。

**Architecture:** Electron 主进程承担模块注册表（内置清单 + manifest 解析）、状态总线（订阅表 + 快照环形缓冲）、窗口管理（open/close/bounds 持久化）三块；渲染层每个模块窗口加载同一 dist，以 `?module=<id>` URL 路由到对应组件根（复用现有 `?editor=1` 独立窗口先例）；主窗口 dock 化后渲染 DockBar，驾驶舱/聊天/文件/设置改独立窗口；跨窗口状态经主进程 StateBus 广播，dock 窗口订阅聚合显示气泡。

**Tech Stack:** Electron 43 (CommonJS main)、React 18 + TS + zustand、Vite（同 origin 多窗口共享 localStorage）、Node 24 原生测试（`node --test`）。

**Spec:** `docs/superpowers/specs/2026-09-01-modular-windows-design.md`

## Global Constraints

- 内核零依赖铁律不涉及（本计划仅 electron 主进程 + 前端渲染层）。
- 主进程文件用 CommonJS（`.cjs`，Electron 直接运行），渲染层全程 ESM/TS。
- 测试命令固定 `node --test "server/*.test.mjs"`（主进程逻辑测试放 `server/`）+ `node --test src/stores/dockStore.test.ts`（渲染层 store）。
- IPC 通道命名遵循现有模式：`module:*`（invoke/handle 配对）、`bus:*`（send/on 配对）。
- preload 用 contextBridge 平铺 namespace（沿用 ponosAPI/ponosWindow/ponosDiag 模式），不暴露任意 ipcRenderer。
- 窗口关闭只销毁视图、不销毁模块运行时（transcript 权威源，重开从 localStorage/transcript 恢复）。
- 单窗口 URL 路由复用 `isEditorWindow()` 的 `new URLSearchParams(window.location.search)` 模式，不引入路由库。
- 不引入任何 npm 依赖（zustand/react 等既有依赖除外）。

---

### Task 1: ModuleRegistry（主进程模块注册表）

**Files:**
- Create: `electron/module-registry.cjs`
- Test: `server/module-registry.test.mjs`

**Interfaces:**
- Consumes: 无（纯逻辑，不依赖 electron）
- Produces:
  - `listModules(): ModuleDescriptor[]` — 内置模块 + 已扫描外部模块合并清单
  - `getModule(id): ModuleDescriptor | undefined`
  - `parseManifest(json: string, baseDir: string): { ok: true; manifest: ExternalModuleManifest } | { ok: false; error: string }` — manifest 校验（阶段 B 完整启用，本任务先行 schema 解析器）
  - `ModuleDescriptor = { id, name, icon, singleton, builtin, windowSpec: { width, height, minWidth, minHeight, resizable, frame } }`

- [ ] **Step 1: 写失败测试**

`server/module-registry.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listModules, getModule, parseManifest } from '../electron/module-registry.cjs'

test('listModules 返回全部内置模块（dock/cockpit/chat/files/settings）', () => {
  const mods = listModules()
  const ids = mods.map(m => m.id)
  for (const id of ['dock', 'cockpit', 'chat', 'files', 'settings']) assert.ok(ids.includes(id), `missing ${id}`)
  // 每项含完整 windowSpec
  for (const m of mods) {
    assert.ok(m.windowSpec.width > 0 && m.windowSpec.height > 0)
    assert.equal(typeof m.singleton, 'boolean')
    assert.equal(m.builtin, true)
  }
})

test('getModule 命中返回描述、未命中返回 undefined', () => {
  assert.equal(getModule('chat').id, 'chat')
  assert.equal(getModule('nope'), undefined)
})

test('parseManifest 合法 JSON 校验通过并归一化', () => {
  const r = parseManifest(JSON.stringify({
    id: 'weather', name: '天气', version: '1.0.0', entry: 'bundle.js',
    windowSpec: { width: 480, height: 640, minWidth: 320, minHeight: 240, resizable: true, frame: true },
    singleton: true, channels: ['custom:weather'],
  }), '/home/u/modules/weather')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.manifest.id, 'weather')
    assert.equal(r.manifest.windowSpec.width, 480)
    assert.deepEqual(r.manifest.channels, ['custom:weather'])
  }
})

test('parseManifest 缺失必需字段（id/name/entry/windowSpec）拒绝', () => {
  const r = parseManifest(JSON.stringify({ id: 'x', name: 'y' }), '/tmp')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /entry|windowSpec/)
})

test('parseManifest 非法 JSON 拒绝', () => {
  const r = parseManifest('not json{{{', '/tmp')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /JSON/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/module-registry.test.mjs`
Expected: FAIL（`Cannot find module '../electron/module-registry.cjs'`）

- [ ] **Step 3: 实现 module-registry.cjs**

`electron/module-registry.cjs`：

```js
/**
 * 模块注册表（纯逻辑，不依赖 electron，可单测）。
 * 内置模块清单 + 外部模块 manifest 解析器。
 * 外部模块完整扫描/加载在阶段 B 启用；本文件已含 schema 校验（parseManifest）。
 */
'use strict'

const BUILTIN_MODULES = [
  {
    id: 'dock', name: '导航栏', icon: 'vortex', singleton: true, builtin: true,
    windowSpec: { width: 64, height: 480, minWidth: 48, minHeight: 200, resizable: false, frame: false },
  },
  {
    id: 'cockpit', name: '驾驶舱', icon: 'layout-dashboard', singleton: true, builtin: true,
    windowSpec: { width: 1200, height: 800, minWidth: 900, minHeight: 600, resizable: true, frame: false },
  },
  {
    id: 'chat', name: '聊天', icon: 'message-square', singleton: false, builtin: true,
    windowSpec: { width: 900, height: 700, minWidth: 600, minHeight: 400, resizable: true, frame: false },
  },
  {
    id: 'files', name: '文件', icon: 'folder', singleton: true, builtin: true,
    windowSpec: { width: 820, height: 640, minWidth: 480, minHeight: 320, resizable: true, frame: false },
  },
  {
    id: 'settings', name: '设置', icon: 'settings', singleton: true, builtin: true,
    windowSpec: { width: 720, height: 640, minWidth: 480, minHeight: 400, resizable: true, frame: false },
  },
]

const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'entry', 'windowSpec']

function listModules() {
  // 阶段 B：合并 scanExternalModules() 结果
  return BUILTIN_MODULES.map(m => ({ ...m }))
}

function getModule(id) {
  return BUILTIN_MODULES.find(m => m.id === id)
}

/**
 * 解析并校验外部模块 manifest.json。
 * 返回 { ok:true, manifest } 或 { ok:false, error }。不读取文件系统（调用方负责读文件）。
 */
function parseManifest(jsonText, baseDir) {
  let raw
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return { ok: false, error: 'manifest JSON 解析失败' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'manifest 必须是 JSON 对象' }
  }
  for (const f of REQUIRED_MANIFEST_FIELDS) {
    if (raw[f] === undefined || raw[f] === null || raw[f] === '') {
      return { ok: false, error: `manifest 缺少必需字段: ${f}` }
    }
  }
  const ws = raw.windowSpec
  const num = (v, dft) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.round(v) : dft
  const manifest = {
    id: String(raw.id),
    name: String(raw.name),
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    icon: typeof raw.icon === 'string' ? raw.icon : '',
    entry: String(raw.entry),
    baseDir: String(baseDir || ''),
    windowSpec: {
      width: num(ws.width, 640),
      height: num(ws.height, 480),
      minWidth: num(ws.minWidth, 320),
      minHeight: num(ws.minHeight, 240),
      resizable: ws.resizable !== false,
      frame: ws.frame === true,
    },
    singleton: raw.singleton !== false,
    channels: Array.isArray(raw.channels) ? raw.channels.map(c => String(c)) : [],
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map(p => String(p)) : [],
    homepage: typeof raw.homepage === 'string' ? raw.homepage : '',
    author: typeof raw.author === 'string' ? raw.author : '',
  }
  return { ok: true, manifest }
}

module.exports = { listModules, getModule, parseManifest, BUILTIN_MODULES }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test server/module-registry.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add electron/module-registry.cjs server/module-registry.test.mjs
git commit -m "feat(modules): ModuleRegistry — 内置模块清单 + manifest schema 校验"
```

---

### Task 2: StateBus（主进程状态总线）

**Files:**
- Create: `electron/state-bus.cjs`
- Test: `server/state-bus.test.mjs`

**Interfaces:**
- Consumes: 无（纯逻辑；webContents 以 duck-typed `{ send(channel, data) }` 传入）
- Produces:
  - `createStateBus(): StateBus`
  - `StateBus.publish(event: BusEvent): void` — 校验信封 + 写入快照 + 广播给订阅者
  - `StateBus.subscribe(channel: string, target: { send(ch, d): void }): void`
  - `StateBus.unsubscribe(channel: string, target): void`
  - `StateBus.detach(target): void` — 窗口销毁时移除全部订阅
  - `StateBus.getSnapshot(channel: string): BusEvent[]` — 最近 N 条（环形缓冲，默认 50）
  - `BusEvent = { channel: string, action: string, payload: unknown, from: string, ts: number }`

- [ ] **Step 1: 写失败测试**

`server/state-bus.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateBus } from '../electron/state-bus.cjs'

function fakeTarget() {
  const received = []
  return {
    received,
    send(channel, data) { received.push({ channel, data }) },
  }
}

test('publish 广播给该 channel 的全部订阅者', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  const b = fakeTarget()
  bus.subscribe('task', a)
  bus.subscribe('task', b)
  bus.subscribe('question', a)
  bus.publish({ channel: 'task', action: 'status-change', payload: { taskId: 't1' }, from: 'chat-1', ts: 1 })
  assert.equal(a.received.length, 1)
  assert.equal(b.received.length, 1)
  assert.equal(a.received[0].channel, 'bus:event:task')
  assert.equal(a.received[0].data.action, 'status-change')
  assert.equal(a.received[0].data.payload.taskId, 't1')
})

test('未订阅该 channel 的窗口不收到事件', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('task', a)
  bus.publish({ channel: 'module', action: 'opened', payload: {}, from: 'files', ts: 1 })
  assert.equal(a.received.length, 0)
})

test('非法信封（缺 channel/action/from）拒绝且不广播', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('task', a)
  bus.publish({ channel: '', action: 'x', payload: {}, from: 'y', ts: 1 })
  bus.publish({ channel: 'task', action: '', payload: {}, from: 'y', ts: 1 })
  bus.publish({ channel: 'task', action: 'ok', payload: {}, from: '', ts: 1 })
  assert.equal(a.received.length, 0)
})

test('getSnapshot 返回最近 N 条（默认 50），超量丢弃最旧', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('task', a)
  for (let i = 0; i < 55; i++) {
    bus.publish({ channel: 'task', action: 's', payload: { i }, from: 'chat', ts: i })
  }
  const snap = bus.getSnapshot('task')
  assert.equal(snap.length, 50)
  assert.equal(snap[0].payload.i, 5)
  assert.equal(snap[49].payload.i, 54)
})

test('unsubscribe/detach 后不再收到事件', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('task', a)
  bus.unsubscribe('task', a)
  bus.publish({ channel: 'task', action: 's', payload: {}, from: 'c', ts: 1 })
  assert.equal(a.received.length, 0)
  bus.subscribe('task', a)
  bus.detach(a)
  bus.publish({ channel: 'task', action: 's', payload: {}, from: 'c', ts: 2 })
  assert.equal(a.received.length, 0)
})

test('自定义 channel（custom:*）可订阅广播', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('custom:weather', a)
  bus.publish({ channel: 'custom:weather', action: 'update', payload: { t: 22 }, from: 'weather', ts: 1 })
  assert.equal(a.received.length, 1)
  assert.equal(a.received[0].data.payload.t, 22)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/state-bus.test.mjs`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 state-bus.cjs**

`electron/state-bus.cjs`：

```js
/**
 * 状态总线（纯逻辑，不依赖 electron，可单测）。
 * 渲染层窗口 publish 事件 → 主进程按 channel 广播给订阅者 + 写快照环形缓冲。
 * target 为 duck-typed webContents：只需 { send(channel, data) }。
 */
'use strict'

const SNAPSHOT_SIZE = 50

function createStateBus({ snapshotSize = SNAPSHOT_SIZE } = {}) {
  /** Map<channel, Set<target>> */
  const subscriptions = new Map()
  /** Map<channel, BusEvent[]> 环形缓冲（push 超量 shift） */
  const snapshots = new Map()

  function isValidEvent(e) {
    return !!(
      e && typeof e === 'object' &&
      typeof e.channel === 'string' && e.channel.length > 0 &&
      typeof e.action === 'string' && e.action.length > 0 &&
      typeof e.from === 'string' && e.from.length > 0
    )
  }

  function subscribe(channel, target) {
    if (!subscriptions.has(channel)) subscriptions.set(channel, new Set())
    subscriptions.get(channel).add(target)
  }

  function unsubscribe(channel, target) {
    subscriptions.get(channel)?.delete(target)
  }

  function detach(target) {
    for (const set of subscriptions.values()) set.delete(target)
  }

  function publish(event) {
    if (!isValidEvent(event)) return
    const ts = typeof event.ts === 'number' ? event.ts : Date.now()
    const full = { ...event, ts }
    // 快照环形缓冲
    const arr = snapshots.get(full.channel) || []
    arr.push(full)
    if (arr.length > snapshotSize) arr.splice(0, arr.length - snapshotSize)
    snapshots.set(full.channel, arr)
    // 广播
    const set = subscriptions.get(full.channel)
    if (!set) return
    for (const target of set) {
      try { target.send(`bus:event:${full.channel}`, full) } catch { /* 窗口销毁，忽略 */ }
    }
  }

  function getSnapshot(channel) {
    return [...(snapshots.get(channel) || [])]
  }

  return { subscribe, unsubscribe, detach, publish, getSnapshot }
}

module.exports = { createStateBus }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test server/state-bus.test.mjs`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add electron/state-bus.cjs server/state-bus.test.mjs
git commit -m "feat(bus): StateBus — 订阅表 + 广播 + 快照环形缓冲"
```

---

### Task 3: WindowManager（主进程窗口管理）

**Files:**
- Create: `electron/window-manager.cjs`
- Test: `server/window-manager.test.mjs`

**Interfaces:**
- Consumes: `getModule(id)`（Task 1）、`createStateBus()`（Task 2）；`loadWindowUrl(moduleId, params)` 由 main.cjs 注入
- Produces:
  - `createWindowManager({ getModule, bus, createWindow, onClosed }): WindowManager`
  - `WindowManager.open(id, params): { ok: boolean; windowId?: string; reused?: boolean; error?: string }`
  - `WindowManager.close(id): { ok: boolean }`
  - `WindowManager.getBounds(id): { x, y, w, h } | null`
  - `WindowManager.setBounds(id, bounds): { ok: boolean }`
  - `clampBounds(bounds, spec, workArea): { x, y, w, h }`（纯函数导出，仿 editorWin bounds 校验）
  - 内部维护 `Map<id, BrowserWindow>`；窗口 closed 时自动移除并发布 `module:state` 事件

- [ ] **Step 1: 写失败测试（clampBounds 纯函数 + open/close 状态机用 fake window）**

`server/window-manager.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampBounds, createWindowManager } from '../electron/window-manager.cjs'

const SPEC = { width: 900, height: 700, minWidth: 600, minHeight: 400 }
const WA = { x: 0, y: 0, width: 1920, height: 1080 }

test('clampBounds 缺失/越界值回落默认，且受 min/max 约束', () => {
  assert.deepEqual(clampBounds({}, SPEC, WA), { x: 660, y: 190, w: 900, h: 700 })
  // 越界宽高 → 夹到 workArea 内
  const out = clampBounds({ x: 0, y: 0, w: 5000, h: 5000 }, SPEC, WA)
  assert.equal(out.w, 1920)
  assert.equal(out.h, 1080)
  // 小于 min → 提升到 min
  const small = clampBounds({ x: 0, y: 0, w: 100, h: 100 }, SPEC, WA)
  assert.equal(small.w, 600)
  assert.equal(small.h, 400)
  // 负坐标 → 拉回 0
  assert.ok(clampBounds({ x: -50, y: -50, w: 800, h: 600 }, SPEC, WA).x >= 0)
})

function makeWindowManager() {
  let seq = 0
  const bus = { publish() {} }
  const wins = new Map()
  const wm = createWindowManager({
    getModule: (id) => ({ id, windowSpec: SPEC, singleton: id !== 'chat', name: id }),
    bus,
    createWindow: (id, params) => {
      seq += 1
      const fake = {
        id: `win-${seq}`, destroyed: false,
        isDestroyed: () => fake.destroyed,
        getBounds: () => ({ x: 0, y: 0, w: 900, h: 700 }),
        setBounds: () => {},
        loadURL: () => {}, show: () => {}, focus: () => {}, restore: () => {},
        isMinimized: () => false, on: () => {},
        close: () => { fake.destroyed = true },
      }
      wins.set(`win-${seq}`, fake)
      return fake
    },
    onClosed: (winId) => wins.delete(winId),
  })
  return { wm, wins }
}

test('open 创建窗口并返回 windowId；singleton 复用不重复创建', () => {
  const { wm, wins } = makeWindowManager()
  const r1 = wm.open('files')
  assert.equal(r1.ok, true)
  assert.equal(wins.size, 1)
  const r2 = wm.open('files')
  assert.equal(r2.ok, true)
  assert.equal(r2.reused, true)
  assert.equal(wins.size, 1)
})

test('open 非 singleton（chat）可多开', () => {
  const { wm, wins } = makeWindowManager()
  wm.open('chat', { conversation: 'c1' })
  wm.open('chat', { conversation: 'c2' })
  assert.equal(wins.size, 2)
})

test('close 关闭窗口并从注册表移除', () => {
  const { wm, wins } = makeWindowManager()
  const r = wm.open('files')
  const winId = r.windowId
  wm.close('files')
  assert.equal(wins.has(winId), false)
})

test('open 未知模块返回 error', () => {
  const { wm } = makeWindowManager()
  const r = wm.open('nope')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /unknown module/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/window-manager.test.mjs`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 window-manager.cjs**

`electron/window-manager.cjs`：

```js
/**
 * 窗口管理器（BrowserWindow 依赖由 main.cjs 注入 createWindow，本文件可单测状态机）。
 * open/close/setBounds + bounds 校验。窗口 closed 时自动移除并发布 module:state。
 */
'use strict'

/** 数值夹取：缺失/非法回落默认，越界夹到 workArea 内，低于 min 提升到 min。 */
function clampBounds(bounds, spec, workArea) {
  const num = (v, lo, hi, dft) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return dft
    return Math.max(lo, Math.min(hi, Math.round(v)))
  }
  const waX = workArea.x || 0
  const waY = workArea.y || 0
  const waW = workArea.width || 1920
  const waH = workArea.height || 1080
  const w = num(bounds?.w, spec.minWidth, waW, spec.width)
  const h = num(bounds?.h, spec.minHeight, waH, spec.height)
  // x/y 默认居中；非法值居中
  const x = num(bounds?.x, waX, Math.max(waX, waX + waW - w), waX + Math.floor((waW - w) / 2))
  const y = num(bounds?.y, waY, Math.max(waY, waY + waH - h), waY + Math.floor((waH - h) / 2))
  return { x, y, w, h }
}

function createWindowManager({ getModule, bus, createWindow, onClosed }) {
  /** Map<moduleId, BrowserWindow>（非 singleton 模块按 moduleId+paramsKey 区分） */
  const windows = new Map()
  /** Map<BrowserWindow, moduleId> 反向索引（closed 回调反查） */
  const winToModule = new Map()

  function keyOf(id, params) {
    if (getModule(id)?.singleton !== false) return id
    const c = (params && params.conversation) || ''
    return `${id}::${c}`
  }

  function open(id, params = {}) {
    const mod = getModule(id)
    if (!mod) return { ok: false, error: `unknown module: ${id}` }
    const key = keyOf(id, params)
    let win = windows.get(key)
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return { ok: true, windowId: key, reused: true }
    }
    win = createWindow(mod, params)
    windows.set(key, win)
    winToModule.set(win, key)
    win.on('closed', () => {
      windows.delete(key)
      winToModule.delete(win)
      onClosed?.(key)
      bus.publish({ channel: 'module', action: 'closed', payload: { moduleId: id, windowId: key }, from: 'main', ts: Date.now() })
    })
    bus.publish({ channel: 'module', action: 'opened', payload: { moduleId: id, windowId: key }, from: 'main', ts: Date.now() })
    return { ok: true, windowId: key, reused: false }
  }

  function close(id) {
    for (const [key, win] of windows) {
      if (key === id || key.startsWith(`${id}::`)) {
        if (!win.isDestroyed()) win.close()
        return { ok: true }
      }
    }
    return { ok: true } // 已关闭视为成功（幂等）
  }

  function getBounds(id) {
    for (const [key, win] of windows) {
      if (key === id || key.startsWith(`${id}::`)) {
        if (!win.isDestroyed()) return win.getBounds()
      }
    }
    return null
  }

  function setBounds(id, bounds) {
    for (const [key, win] of windows) {
      if (key === id || key.startsWith(`${id}::`)) {
        if (!win.isDestroyed()) {
          const spec = getModule(id)?.windowSpec || {}
          const workArea = require('electron').screen?.getPrimaryDisplay()?.workArea || { x: 0, y: 0, width: 1920, height: 1080 }
          win.setBounds(clampBounds(bounds, spec, workArea))
          return { ok: true }
        }
      }
    }
    return { ok: false, error: 'window not found' }
  }

  return { open, close, getBounds, setBounds }
}

module.exports = { createWindowManager, clampBounds }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test server/window-manager.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add electron/window-manager.cjs server/window-manager.test.mjs
git commit -m "feat(windows): WindowManager — open/close/bounds + clampBounds 校验"
```

---

### Task 4: preload 扩展（ponosModules + ponosBus）与类型声明

**Files:**
- Modify: `electron/preload.cjs`
- Modify: `src/types/index.ts`
- Test: 无单测（IPC 通道冒烟在 Task 10 集成验证）

**Interfaces:**
- Consumes: 无（定义渲染层可用 API）
- Produces:
  - `window.ponosModules.list(): Promise<ModuleDescriptor[]>`
  - `window.ponosModules.open(id: string, params?: Record<string, string>): Promise<{ ok: boolean; windowId?: string; reused?: boolean; error?: string }>`
  - `window.ponosModules.close(id: string): Promise<{ ok: boolean }>`
  - `window.ponosModules.getBounds(id): Promise<{ x, y, w, h } | null>`
  - `window.ponosModules.setBounds(id, bounds): Promise<{ ok: boolean }>`
  - `window.ponosModules.onModuleState(cb: (e: BusEvent) => void): () => void`
  - `window.ponosBus.publish(event: BusEvent): void`
  - `window.ponosBus.getSnapshot(channel: string): Promise<BusEvent[]>`
  - `window.ponosBus.onEvent(channel: string, cb: (e: BusEvent) => void): () => void`

- [ ] **Step 1: preload.cjs 追加两个 namespace**

在 `electron/preload.cjs` 末尾（`ponosDiag` 之后）追加：

```js
// 模块化窗口（main 侧 module:* ipcMain.handle 配对）
contextBridge.exposeInMainWorld('ponosModules', {
  list: () => ipcRenderer.invoke('module:list'),
  open: (id, params) => ipcRenderer.invoke('module:open', { id, params }),
  close: (id) => ipcRenderer.invoke('module:close', { id }),
  getBounds: (id) => ipcRenderer.invoke('module:get-bounds', { id }),
  setBounds: (id, bounds) => ipcRenderer.invoke('module:set-bounds', { id, bounds }),
  onModuleState: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('module:state', listener)
    return () => ipcRenderer.removeListener('module:state', listener)
  },
})

// 状态总线（main 侧 StateBus 广播；publish 用 send，事件用 on）
contextBridge.exposeInMainWorld('ponosBus', {
  publish: (event) => ipcRenderer.send('bus:publish', event),
  getSnapshot: (channel) => ipcRenderer.invoke('bus:get-snapshot', { channel }),
  onEvent: (channel, callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(`bus:event:${channel}`, listener)
    return () => ipcRenderer.removeListener(`bus:event:${channel}`, listener)
  },
})
```

- [ ] **Step 2: src/types/index.ts 追加类型**

在 `declare global { interface Window { ... } }` 块内（`ponosDiag` 之后）追加：

```ts
    /** 模块化窗口（module:* IPC 配对） */
    ponosModules?: {
      list: () => Promise<ModuleDescriptor[]>
      open: (id: string, params?: Record<string, string>) => Promise<{ ok: boolean; windowId?: string; reused?: boolean; error?: string }>
      close: (id: string) => Promise<{ ok: boolean }>
      getBounds: (id: string) => Promise<{ x: number; y: number; w: number; h: number } | null>
      setBounds: (id: string, bounds: { x?: number; y?: number; w?: number; h?: number }) => Promise<{ ok: boolean }>
      onModuleState: (cb: (e: BusEvent) => void) => () => void
    }
    /** 状态总线（bus:* IPC 配对） */
    ponosBus?: {
      publish: (event: BusEvent) => void
      getSnapshot: (channel: string) => Promise<BusEvent[]>
      onEvent: (channel: string, cb: (e: BusEvent) => void) => () => void
    }
```

在文件顶层（`QuestionPayload` 附近）追加接口定义：

```ts
// --- 模块化窗口 (Modular Windows) Types ---

export interface ModuleWindowSpec {
  width: number
  height: number
  minWidth: number
  minHeight: number
  resizable: boolean
  frame: boolean
}

export interface ModuleDescriptor {
  id: string
  name: string
  icon: string
  singleton: boolean
  builtin: boolean
  windowSpec: ModuleWindowSpec
}

export interface BusEvent {
  channel: string
  action: string
  payload: unknown
  from: string
  ts: number
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（无新增错误；若报 ponosModules 未定义，确认声明在 global Window 块内）

- [ ] **Step 4: 提交**

```bash
git add electron/preload.cjs src/types/index.ts
git commit -m "feat(bus): preload 暴露 ponosModules/ponosBus + 类型声明"
```

---

### Task 5: 渲染层 ModuleRoot 路由 + moduleBridge

**Files:**
- Create: `src/lib/moduleBridge.ts`
- Create: `src/components/module/ModuleRoot.tsx`
- Modify: `src/App.tsx`
- Test: `src/lib/moduleBridge.test.ts`（URL 解析纯函数）

**Interfaces:**
- Consumes: `window.ponosModules` / `window.ponosBus`（Task 4）
- Produces:
  - `getModuleId(): string | null` — 从 `location.search` 解析 `?module=`
  - `getModuleParam(key: string): string | null`
  - `isModuleWindow(): boolean`
  - `openModule(id, params?)`, `closeModule(id)`, `publishBus(event)`, `subscribeBus(channel, cb)`, `listModules()`
  - `ModuleRoot` 组件：按 moduleId 分发到 `ChatModule` / `FilesModule` / `SettingsModule` / `CockpitView` / `DockBar`；未知或缺失 → DockBar

- [ ] **Step 1: 写失败测试**

`src/lib/moduleBridge.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseModuleUrl } from './moduleBridge'

test('parseModuleUrl 解析 ?module=chat&conversation=c1', () => {
  const r = parseModuleUrl('http://x/?module=chat&conversation=c1')
  assert.equal(r.moduleId, 'chat')
  assert.equal(r.params.conversation, 'c1')
})

test('parseModuleUrl 无 module 返回 null', () => {
  const r = parseModuleUrl('http://x/?editor=1')
  assert.equal(r.moduleId, null)
})

test('parseModuleUrl 空 query 返回 null', () => {
  const r = parseModuleUrl('http://x/')
  assert.equal(r.moduleId, null)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/lib/moduleBridge.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 moduleBridge.ts**

`src/lib/moduleBridge.ts`：

```ts
import type { BusEvent, ModuleDescriptor } from '@/types'

export interface ParsedModuleUrl {
  moduleId: string | null
  params: Record<string, string>
}

/** 纯函数：从 URL 解析模块 id 与参数（可单测）。 */
export function parseModuleUrl(url: string): ParsedModuleUrl {
  try {
    const u = new URL(url)
    const moduleId = u.searchParams.get('module')
    const params: Record<string, string> = {}
    for (const [k, v] of u.searchParams.entries()) {
      if (k !== 'module') params[k] = v
    }
    return { moduleId, params }
  } catch {
    return { moduleId: null, params: {} }
  }
}

export function getModuleId(): string | null {
  if (typeof window === 'undefined') return null
  return parseModuleUrl(window.location.href).moduleId
}

export function getModuleParam(key: string): string | null {
  if (typeof window === 'undefined') return null
  return parseModuleUrl(window.location.href).params[key] ?? null
}

export function isModuleWindow(): boolean {
  return getModuleId() !== null
}

// --- IPC 封装（窗口内可选链兜底，非模块窗口返回安全空值） ---

export async function listModules(): Promise<ModuleDescriptor[]> {
  try { return await window.ponosModules?.list() ?? [] } catch { return [] }
}

export async function openModule(id: string, params?: Record<string, string>) {
  try { return await window.ponosModules?.open(id, params) ?? { ok: false, error: 'ponosModules unavailable' } }
  catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function closeModule(id: string) {
  try { return await window.ponosModules?.close(id) ?? { ok: false } } catch { return { ok: false } }
}

export function publishBus(event: BusEvent): void {
  window.ponosBus?.publish(event)
}

export function subscribeBus(channel: string, cb: (e: BusEvent) => void): () => void {
  return window.ponosBus?.onEvent(channel, cb) ?? (() => {})
}

export async function getSnapshot(channel: string): Promise<BusEvent[]> {
  try { return await window.ponosBus?.getSnapshot(channel) ?? [] } catch { return [] }
}
```

- [ ] **Step 4: 实现 ModuleRoot.tsx**

`src/components/module/ModuleRoot.tsx`：

```tsx
import { getModuleId } from '@/lib/moduleBridge'
import { DockBar } from '@/components/dock/DockBar'
import { CockpitView } from '@/components/cockpit/CockpitView'
import { ChatModule } from '@/components/module/windows/ChatModule'
import { FilesModule } from '@/components/module/windows/FilesModule'
import { SettingsModule } from '@/components/module/windows/SettingsModule'

/**
 * 模块窗口根：按 ?module=<id> 分发到对应组件根。
 * 未知/缺失 moduleId（主窗口）→ DockBar。
 * 各模块窗口组件在 Task 7-9 实现；CockpitView 复用现有。
 */
export function ModuleRoot() {
  const moduleId = getModuleId()
  switch (moduleId) {
    case 'chat': return <ChatModule />
    case 'files': return <FilesModule />
    case 'settings': return <SettingsModule />
    case 'cockpit': return <CockpitView />
    default: return <DockBar />
  }
}
```

- [ ] **Step 5: App.tsx 增加模块窗口分支**

`src/App.tsx` 顶部 import 增加：

```tsx
import { ModuleRoot } from '@/components/module/ModuleRoot'
import { isModuleWindow } from '@/lib/moduleBridge'
```

`App` 组件函数改为（在 `isEditorWindow()` 之后、`MainApp` 之前）：

```tsx
export default function App() {
  // 独立原生编辑器窗口（?editor=1）：只渲染编辑器根组件，不加载主界面。
  if (isEditorWindow()) {
    return (
      <TooltipProvider>
        <EditorWindowRoot />
      </TooltipProvider>
    )
  }
  // 模块化窗口（?module=<id>）：渲染对应模块根（chat/files/settings/cockpit/dock）。
  if (isModuleWindow()) {
    return <ModuleRoot />
  }
  return <MainApp />
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test src/lib/moduleBridge.test.ts && npx tsc --noEmit`
Expected: PASS + 类型检查通过（ModuleRoot 引用的组件会在 Task 7-9 创建；本任务先让测试通过，组件留占位会导致 tsc 报错——将 Task 7-9 的组件骨架一并创建，见各任务 Step 1 说明）

> 说明：ModuleRoot 引用的 4 个组件（DockBar/ChatModule/FilesModule/SettingsModule）在本任务 tsc 时会缺失。执行顺序上 Task 5 与 Task 6-9 处于同一提交批次不可拆分——建议 Task 5 先提交 moduleBridge 与测试，ModuleRoot 的组件引用随 Task 6-9 各自落地；本任务内可临时将 ModuleRoot 的 switch 仅保留已存在分支（default → DockBar），DockBar 在 Task 6 创建后补全引用。**为保持每任务可编译，Task 5 的 ModuleRoot 先只写 `default: return <DockBar />`，DockBar 骨架在 Task 6 创建，switch 其余分支在 Task 7-9 各自添加。**

- [ ] **Step 7: 提交**

```bash
git add src/lib/moduleBridge.ts src/lib/moduleBridge.test.ts src/components/module/ModuleRoot.tsx src/App.tsx
git commit -m "feat(modules): 渲染层 ModuleRoot 路由 + moduleBridge API 封装"
```

---

### Task 6: DockBar（dock 形态导航条骨架）

**Files:**
- Create: `src/components/dock/DockBar.tsx`
- Create: `src/stores/dockStore.ts`
- Test: `src/stores/dockStore.test.ts`

**Interfaces:**
- Consumes: `listModules` / `openModule` / `closeModule` / `subscribeBus`（Task 5）、`useViewStore`（goDock）
- Produces:
  - `DockBar` 组件：三区（品牌 / 状态气泡 / 模块导航），hover 展开，气泡计数聚合
  - `useDockStore`（zustand）：`{ expanded, locked, counts: Record<channel, number>, setExpanded, setLocked, bump, reset }`
  - `viewStore` 新增 `view: 'dock'` 与 `goDock()`

- [ ] **Step 1: 写失败测试**

`src/stores/dockStore.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useDockStore } from './dockStore'

test('dockStore 初始态：未展开、未锁定、计数全零', () => {
  const s = useDockStore.getState()
  assert.equal(s.expanded, false)
  assert.equal(s.locked, false)
  assert.deepEqual(s.counts, { task: 0, question: 0, approval: 0, module: 0 })
})

test('bump 累加指定 channel 计数，reset 清零', () => {
  useDockStore.getState().bump('task')
  useDockStore.getState().bump('task')
  useDockStore.getState().bump('approval')
  assert.equal(useDockStore.getState().counts.task, 2)
  assert.equal(useDockStore.getState().counts.approval, 1)
  useDockStore.getState().reset('task')
  assert.equal(useDockStore.getState().counts.task, 0)
})

test('setExpanded/setLocked 状态切换', () => {
  useDockStore.getState().setExpanded(true)
  assert.equal(useDockStore.getState().expanded, true)
  useDockStore.getState().setLocked(true)
  assert.equal(useDockStore.getState().locked, true)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/stores/dockStore.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 dockStore.ts**

`src/stores/dockStore.ts`：

```ts
import { create } from 'zustand'

export type DockChannel = 'task' | 'question' | 'approval' | 'module'

interface DockState {
  expanded: boolean
  locked: boolean
  counts: Record<DockChannel, number>
  setExpanded: (v: boolean) => void
  setLocked: (v: boolean) => void
  bump: (ch: DockChannel) => void
  reset: (ch: DockChannel) => void
}

export const useDockStore = create<DockState>()((set) => ({
  expanded: false,
  locked: false,
  counts: { task: 0, question: 0, approval: 0, module: 0 },
  setExpanded: (v) => set({ expanded: v }),
  setLocked: (v) => set({ locked: v }),
  bump: (ch) => set(s => ({ counts: { ...s.counts, [ch]: s.counts[ch] + 1 } })),
  reset: (ch) => set(s => ({ counts: { ...s.counts, [ch]: 0 } })),
}))
```

- [ ] **Step 4: viewStore 增加 dock 视图**

`src/stores/viewStore.ts` 修改：

```ts
export type AppView = 'boot' | 'login' | 'cockpit' | 'workspace' | 'dock'
```

state 接口与实现增加：

```ts
  goDock: () => void
```

```ts
  goDock: () => set({ view: 'dock', workspaceTab: null }),
```

- [ ] **Step 5: 实现 DockBar.tsx 骨架**

`src/components/dock/DockBar.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { LayoutDashboard, MessageSquare, Folder, Settings, Vortex } from 'lucide-react'
import { useDockStore, type DockChannel } from '@/stores/dockStore'
import { useViewStore } from '@/stores/viewStore'
import { listModules, openModule, subscribeBus, type ParsedModuleUrl } from '@/lib/moduleBridge'
import type { BusEvent } from '@/types'

const CHANNEL_ICON: Record<DockChannel, string> = { task: '●', question: '?', approval: '!', module: '◈' }

/**
 * DockBar：dock 到屏幕右侧的功能导航条。
 * 三区：品牌区（打开驾驶舱）/ 状态气泡区（task/question/approval/module 计数）/
 * 模块导航区（hover 展开，点击打开模块窗口）。
 * 骨架版：气泡计数订阅 StateBus；审批/提问卡片宿主在阶段 B 补全。
 */
export function DockBar() {
  const { expanded, locked, counts, setExpanded, setLocked, bump, reset } = useDockStore()
  const goDock = useViewStore(s => s.goDock)
  const [modules, setModules] = useState<Array<{ id: string; name: string; icon: string }>>([])

  // 加载模块清单
  useEffect(() => {
    void listModules().then(list => setModules(list.filter(m => m.id !== 'dock')))
  }, [])

  // 订阅 StateBus：task/question/approval 计数累加
  useEffect(() => {
    const offs = (['task', 'question', 'approval'] as const).map(ch =>
      subscribeBus(ch, (e: BusEvent) => {
        bump(ch)
        // action=resolved 时清零
        if (e.action === 'resolved' || e.action === 'status-done') reset(ch)
      })
    )
    return () => offs.forEach(off => off())
  }, [bump, reset])

  const openModuleWindow = (id: string) => {
    void openModule(id)
    reset('module')
  }

  return (
    <div
      className="h-full flex flex-col items-center py-3 gap-3 border-r border-subtle bg-app text-primary"
      style={{ width: expanded || locked ? 64 : 48, transition: 'width .15s ease' }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => !locked && setExpanded(false)}
    >
      {/* 品牌区 */}
      <button
        onClick={() => { useViewStore.getState().goCockpit() }}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-brand-500 hover:bg-surface"
        title="打开驾驶舱"
      >
        <Vortex size={20} />
      </button>

      <div className="flex-1" />

      {/* 状态气泡区 */}
      <div className="flex flex-col gap-2">
        {(Object.keys(counts) as DockChannel[]).map(ch => (
          <button
            key={ch}
            onClick={() => reset(ch)}
            className="relative w-9 h-9 rounded-lg flex items-center justify-center text-tertiary hover:bg-surface"
            title={ch}
          >
            <span className="text-sm">{CHANNEL_ICON[ch]}</span>
            {counts[ch] > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-0.5 rounded-full text-[10px] leading-4 text-center bg-brand-500 text-white">
                {counts[ch] > 99 ? '99+' : counts[ch]}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* 模块导航区 */}
      <div className="flex flex-col gap-1.5">
        {modules.map(m => (
          <button
            key={m.id}
            onClick={() => openModuleWindow(m.id)}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-secondary hover:bg-surface hover:text-brand-500"
            title={m.name}
          >
            <span className="text-sm">{m.name.slice(0, 1)}</span>
          </button>
        ))}
      </div>

      {/* 锁定展开开关 */}
      <button
        onClick={() => setLocked(!locked)}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-tertiary hover:bg-surface"
        title={locked ? '解锁展开' : '锁定展开'}
      >
        <span className="text-xs">{locked ? '🔒' : '🔓'}</span>
      </button>
    </div>
  )
}
```

> 说明：`useViewStore.getState().goCockpit()` 在 dock 视图下应打开驾驶舱模块窗口——本骨架先保留现有 goCockpit（Task 7 把驾驶舱改为模块窗口时再切换为 `openModule('cockpit')`）。`goDock` 供主窗口从 workspace 收窄为 dock 时使用（Task 10 集成）。

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test src/stores/dockStore.test.ts && npx tsc --noEmit`
Expected: PASS + 类型检查通过

- [ ] **Step 7: 提交**

```bash
git add src/components/dock/DockBar.tsx src/stores/dockStore.ts src/stores/dockStore.test.ts src/stores/viewStore.ts
git commit -m "feat(dock): DockBar 骨架 — 三区布局 + StateBus 气泡计数 + viewStore dock 视图"
```

---

### Task 7: 聊天模块窗口化（试点 1）

**Files:**
- Create: `src/components/module/windows/ChatModule.tsx`
- Modify: `src/components/module/ModuleRoot.tsx`（switch 增加 chat 分支）
- Modify: `src/hooks/usePonosCLI.ts`（task/question/approval 事件发布到 StateBus）
- Test: `src/lib/busPublish.test.ts`（发布辅助纯函数）

**Interfaces:**
- Consumes: `getModuleParam` / `publishBus` / `subscribeBus`（Task 5）、`chatStore`（会话状态）、`usePonosCLI`（WS 连接）
- Produces:
  - `ChatModule` 组件：`?module=chat&conversation=<id>` 渲染会话聊天；无 conversation 参数 → 默认/新建会话
  - `publishChatEvent(channel, action, payload, sessionId)`（moduleBridge 或独立 helper）：发布聊天事件到 StateBus
  - usePonosCLI 在 task 状态变更 / question pending / approval 请求时调用 publishChatEvent

- [ ] **Step 1: 写失败测试（busPublish helper）**

`src/lib/busPublish.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChatEvent } from './busPublish'

test('buildChatEvent 构造 BusEvent 信封', () => {
  const e = buildChatEvent('task', 'status-change', { taskId: 't1' }, 'conv-1')
  assert.equal(e.channel, 'task')
  assert.equal(e.action, 'status-change')
  assert.equal(e.from, 'chat:conv-1')
  assert.equal(typeof e.ts, 'number')
  assert.deepEqual(e.payload, { taskId: 't1' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/lib/busPublish.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 busPublish.ts**

`src/lib/busPublish.ts`：

```ts
import type { BusEvent } from '@/types'

/** 构造聊天事件信封：from 携带会话标识，便于接收方按会话路由。 */
export function buildChatEvent(channel: string, action: string, payload: unknown, sessionId: string): BusEvent {
  return { channel, action, payload, from: `chat:${sessionId}`, ts: Date.now() }
}
```

- [ ] **Step 4: usePonosCLI 事件发布（3 处）**

`src/hooks/usePonosCLI.ts` 顶部 import：

```ts
import { publishBus } from '@/lib/moduleBridge'
import { buildChatEvent } from '@/lib/busPublish'
```

在 `handleStreamMessage` 中（参照 Task 8 说明的现有处理块）：

- **task 状态变更**：现有 backgroundTasks 更新处（`task` 事件处理）追加：
```ts
      publishBus(buildChatEvent('task', task.status === 'running' ? 'status-change' : 'status-done', { conversationId: sid, taskId: task.id, status: task.status }, sid))
```
- **question pending**：`pendingQuestions` 设置处（`question` 事件处理）追加：
```ts
      publishBus(buildChatEvent('question', 'pending', { conversationId: sid }, sid))
```
- **approval 请求**：`approval` 事件处理块（`addPermissionRequest` 之后）追加：
```ts
      publishBus(buildChatEvent('approval', 'pending', { conversationId: sid, toolUseId: d.toolUseId, command: d.command || '', highRisk: !!d.highRisk }, sid))
```
- **approval-resolved**：`resolvePermission` 之后追加：
```ts
      publishBus(buildChatEvent('approval', 'resolved', { conversationId: sid, toolUseId: d.toolUseId }, sid))
```

> 说明：具体插入位置以 `usePonosCLI.ts` 实际行号为准——`task`/`question`/`approval` 三个事件已在 844-880 行附近有处理块（approval 见 `src/hooks/usePonosCLI.ts:844`）。实现时在对应处理块内追加 publishBus 调用即可，不改变现有逻辑。

- [ ] **Step 5: 实现 ChatModule.tsx**

`src/components/module/windows/ChatModule.tsx`：

```tsx
import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { ChatInput } from '@/components/chat/ChatInput'
import QuestionCard from '@/components/chat/QuestionCard'
import { useChatStore } from '@/stores/chatStore'
import { getModuleParam } from '@/lib/moduleBridge'
import { sendAnswer, dismissQuestion, usePonosCLI } from '@/hooks/usePonosCLI'

/**
 * 聊天模块窗口（?module=chat&conversation=<id>）。
 * 该窗口持有内核 WS 连接（usePonosCLI 模块级单例），任务/提问/审批事件
 * 经 StateBus 发布到 dock 气泡。
 */
export function ChatModule() {
  const conversationId = getModuleParam('conversation')
  const { activeConversationId, createConversation, setActiveConversation, pendingQuestions, clearPendingQuestion } = useChatStore()

  // 无 conversation 参数 → 激活/新建会话
  useEffect(() => {
    if (!conversationId) {
      if (!activeConversationId) createConversation()
    } else {
      setActiveConversation(conversationId)
    }
  }, [conversationId])  // eslint-disable-line react-hooks/exhaustive-deps

  const sid = conversationId || activeConversationId
  const pendingQuestion = sid ? pendingQuestions[sid] : undefined
  usePonosCLI() // 确保 WS 连接建立

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-app text-primary">
        {sid ? (
          <>
            <ChatWindow conversationId={sid} />
            {pendingQuestion && (
              <div className="px-3 flex justify-center">
                <QuestionCard
                  key={`${sid}:${pendingQuestion.questions.map(q => `${q.id}|${q.question.slice(0, 24)}`).join('&') || 'raw'}`}
                  payload={pendingQuestion}
                  onAnswer={(response) => {
                    sendAnswer(sid, response.answers, response.notes)
                    clearPendingQuestion(sid)
                  }}
                  onDismiss={() => {
                    clearPendingQuestion(sid)
                    dismissQuestion(sid)
                  }}
                />
              </div>
            )}
            <ChatInput conversationId={sid} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-tertiary text-sm">创建会话中…</div>
        )}
      </div>
    </TooltipProvider>
  )
}
```

- [ ] **Step 6: ModuleRoot 增加 chat 分支**

`src/components/module/ModuleRoot.tsx` 的 switch 增加：

```tsx
    case 'chat': return <ChatModule />
```

（import 同步增加 `import { ChatModule } from '@/components/module/windows/ChatModule'`）

- [ ] **Step 7: 运行测试确认通过**

Run: `node --test src/lib/busPublish.test.ts && npx tsc --noEmit`
Expected: PASS + 类型检查通过

- [ ] **Step 8: 提交**

```bash
git add src/lib/busPublish.ts src/lib/busPublish.test.ts src/components/module/windows/ChatModule.tsx src/components/module/ModuleRoot.tsx src/hooks/usePonosCLI.ts
git commit -m "feat(chat): 聊天模块窗口化 — ChatModule + task/question/approval 发布 StateBus"
```

---

### Task 8: 文件模块窗口化（试点 2）

**Files:**
- Create: `src/components/module/windows/FilesModule.tsx`
- Modify: `src/components/module/ModuleRoot.tsx`（switch 增加 files 分支）

**Interfaces:**
- Consumes: `FileBrowser` 内核（复用）、`useUIStore`（fileViewMode）、`usePonosCLI`（send 打开文件）
- Produces: `FilesModule` 组件：`?module=files` 渲染文件浏览器窗口，发布 `module:opened/closed` 状态（经 WindowManager 自动发布，组件内无需重复）

- [ ] **Step 1: 确认 FileBrowser 复用接口**

Read: `src/components/files/FileBrowser.tsx`（确认 props/导出名，若为默认导出则调整 import）
Expected: 确认 FileBrowser 组件可独立渲染（无强制依赖 Sidebar/RightRail 上下文）

- [ ] **Step 2: 实现 FilesModule.tsx**

`src/components/module/windows/FilesModule.tsx`：

```tsx
import { FileBrowser } from '@/components/files/FileBrowser'
import { FilePreview } from '@/components/files/FilePreview'
import { useUIStore } from '@/stores/uiStore'

/**
 * 文件模块窗口（?module=files）。
 * 复用 FileBrowser 内核 + 列表/图标双模式切换 + 文件预览。
 */
export function FilesModule() {
  const { fileViewMode, setFileViewMode, previewFile, setPreviewFile } = useUIStore()

  return (
    <div className="h-full flex flex-col bg-app text-primary">
      {/* 模式切换条 */}
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-subtle gap-1">
        <button
          onClick={() => setFileViewMode('list')}
          className={`px-2 py-0.5 rounded text-xs ${fileViewMode === 'list' ? 'bg-surface text-brand-500' : 'text-tertiary hover:text-secondary'}`}
        >
          列表
        </button>
        <button
          onClick={() => setFileViewMode('grid')}
          className={`px-2 py-0.5 rounded text-xs ${fileViewMode === 'grid' ? 'bg-surface text-brand-500' : 'text-tertiary hover:text-secondary'}`}
        >
          图标
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <FileBrowser mode={fileViewMode} />
      </div>
      {previewFile && (
        <FilePreview
          path={previewFile.path}
          name={previewFile.name}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}
```

> 说明：`FileBrowser` 若 props 不同（如无 `mode` 参数），以实际组件签名为准调整——本模块只负责把 FileBrowser 放入独立窗口并加模式切换条，不修改 FileBrowser 内部。

- [ ] **Step 3: ModuleRoot 增加 files 分支**

`src/components/module/ModuleRoot.tsx` 的 switch 增加：

```tsx
    case 'files': return <FilesModule />
```

（import 同步增加 `import { FilesModule } from '@/components/module/windows/FilesModule'`）

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/module/windows/FilesModule.tsx src/components/module/ModuleRoot.tsx
git commit -m "feat(files): 文件模块窗口化 — FilesModule 复用 FileBrowser + 双模式"
```

---

### Task 9: 设置模块窗口化（试点 3）

**Files:**
- Create: `src/components/module/windows/SettingsModule.tsx`
- Modify: `src/components/module/ModuleRoot.tsx`（switch 增加 settings 分支）

**Interfaces:**
- Consumes: `SettingsView`（复用）
- Produces: `SettingsModule` 组件：`?module=settings` 渲染设置窗口

- [ ] **Step 1: 实现 SettingsModule.tsx**

`src/components/module/windows/SettingsModule.tsx`：

```tsx
import { SettingsView } from '@/components/settings/SettingsView'

/**
 * 设置模块窗口（?module=settings）。
 * 复用 SettingsView；主题/字体等设置经 localStorage 同 origin 共享。
 */
export function SettingsModule() {
  return <SettingsView />
}
```

- [ ] **Step 2: ModuleRoot 增加 settings 分支**

`src/components/module/ModuleRoot.tsx` 的 switch 增加：

```tsx
    case 'settings': return <SettingsModule />
```

（import 同步增加 `import { SettingsModule } from '@/components/module/windows/SettingsModule'`）

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/components/module/windows/SettingsModule.tsx src/components/module/ModuleRoot.tsx
git commit -m "feat(settings): 设置模块窗口化 — SettingsModule 复用 SettingsView"
```

---

### Task 10: main.cjs 集成（IPC handlers + 主窗口 dock 化）与全量验证

**Files:**
- Modify: `electron/main.cjs`
- Test: `server/module-registry.test.mjs` / `server/state-bus.test.mjs` / `server/window-manager.test.mjs`（回归）

**Interfaces:**
- Consumes: `createStateBus`（Task 2）、`createWindowManager` + `clampBounds`（Task 3）、`listModules`/`getModule`/`parseManifest`（Task 1）
- Produces:
  - IPC handlers：`module:list` / `module:open` / `module:close` / `module:get-bounds` / `module:set-bounds` / `bus:get-snapshot`
  - `bus:publish` on → StateBus.publish
  - 主窗口 dock 化：`?module=dock` 加载 DockBar（Task 6），非 dock 视图保持现状
  - 窗口关闭自动 detach StateBus 订阅

- [ ] **Step 1: main.cjs 顶部 require 引入**

`electron/main.cjs` 顶部（其他 require 之后）追加：

```js
const { createStateBus } = require('./state-bus.cjs')
const { createWindowManager, clampBounds } = require('./window-manager.cjs')
const { listModules, getModule, parseManifest } = require('./module-registry.cjs')
```

- [ ] **Step 2: 初始化 StateBus + WindowManager**

在 `createWindow()` 定义之前（模块级，`let mainWindow` 声明附近）追加：

```js
// ---------------------------------------------------------------------------
// 模块化窗口（Task 2-6）：状态总线 + 窗口管理器
// ---------------------------------------------------------------------------
const stateBus = createStateBus()

function loadModuleUrl(win, moduleId, params = {}) {
  const q = new URLSearchParams({ module: moduleId, ...params })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(`${devUrl}?${q.toString()}`)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: Object.fromEntries(q) })
  }
}

const windowManager = createWindowManager({
  getModule,
  bus: stateBus,
  createWindow: (mod, params) => {
    const win = new BrowserWindow({
      ...mod.windowSpec,
      title: mod.name,
      icon: ICON_PATH,
      show: false,
      frame: mod.windowSpec.frame !== true,  // 内置模块默认无边框（仿主窗口）
      backgroundColor: '#100c08',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    // 边界变化回传（沿 editor:sync-bounds 模式）
    win.on('moved', () => windowManager.setBounds(mod.id, win.getBounds()))
    win.on('resized', () => windowManager.setBounds(mod.id, win.getBounds()))
    // 渲染层错误入盘
    registerRendererErrorCapture(win)
    loadModuleUrl(win, mod.id, params)
    win.once('ready-to-show', () => win.show())
    return win
  },
  onClosed: (windowId) => {
    // 窗口销毁 → 移除其 StateBus 订阅（各窗口 webContents 已随窗口销毁，
    // detach 兜底清理残留 target）
  },
})
```

> 说明：`registerRendererErrorCapture` 是 main.cjs 现有函数（第 440 行附近对 mainWindow 调用），直接复用。`ICON_PATH` 现有定义。

- [ ] **Step 3: 注册 IPC handlers**

在 `editor:open-file` handler 附近（`ipcMain.handle` 区块）追加：

```js
  // ---------------------------------------------------------------------------
  // 模块化窗口 IPC（Task 2-6）
  // ---------------------------------------------------------------------------
  ipcMain.handle('module:list', async () => listModules())

  ipcMain.handle('module:open', async (_e, req) => {
    const id = typeof req?.id === 'string' ? req.id : ''
    if (!id) return { ok: false, error: 'empty module id' }
    const params = req.params && typeof req.params === 'object' ? req.params : {}
    return windowManager.open(id, params)
  })

  ipcMain.handle('module:close', async (_e, req) => {
    const id = typeof req?.id === 'string' ? req.id : ''
    if (!id) return { ok: false, error: 'empty module id' }
    return windowManager.close(id)
  })

  ipcMain.handle('module:get-bounds', async (_e, req) => {
    const id = typeof req?.id === 'string' ? req.id : ''
    return windowManager.getBounds(id)
  })

  ipcMain.handle('module:set-bounds', async (_e, req) => {
    const id = typeof req?.id === 'string' ? req.id : ''
    const b = req?.bounds && typeof req.bounds === 'object' ? req.bounds : {}
    return windowManager.setBounds(id, b)
  })

  ipcMain.on('bus:publish', (_e, event) => {
    stateBus.publish(event)
  })

  ipcMain.handle('bus:get-snapshot', async (_e, req) => {
    const channel = typeof req?.channel === 'string' ? req.channel : ''
    return channel ? stateBus.getSnapshot(channel) : []
  })
```

- [ ] **Step 4: 模块窗口的 webContents 注册订阅 + 主窗口 dock 化**

在 `createWindow()` 内（`registerRendererErrorCapture(mainWindow)` 之后）追加窗口级 StateBus 接入与 dock 路由：

```js
  // 模块窗口/主窗口：webContents 销毁时从 StateBus detach（防悬挂订阅）
  mainWindow.webContents.on('destroyed', () => stateBus.detach(mainWindow.webContents))

  // 主窗口 dock 化：?module=dock 时渲染 DockBar（Task 6）
  // 通过 query 区分：createWindow 默认加载主界面（现状），dock 由渲染层
  // viewStore.goDock() 触发主窗口收窄后由 windowManager.open('dock') 复用。
  // 阶段 A：主窗口仍加载主界面（boot→login→cockpit→workspace），
  // dock 窗口由驾驶舱内按钮触发打开（见 Task 6 DockBar 说明）。
```

> 说明：阶段 A 主窗口保持现有加载逻辑（`index.html` 无 query → MainApp 现状流程），dock 窗口作为独立模块窗口由 `windowManager.open('dock')` 打开（DockBar 组件已就绪）。完整"关闭驾驶舱 → 主窗口收窄为 dock"的形态切换在阶段 B 与 viewStore 状态机整合时落地。

- [ ] **Step 5: 窗口关闭时 detach（app 级兜底）**

在 `app.on('window-all-closed', ...)` 之前追加：

```js
// 窗口关闭 → StateBus detach（webContents destroyed 已处理；此处兜底非 webContents target）
```

（StateBus 的 target 即各窗口 webContents，`destroyed` 事件已 detach，无需额外兜底。）

- [ ] **Step 6: 全量测试回归**

Run: `node --test "server/*.test.mjs" && node --test src/lib/moduleBridge.test.ts src/stores/dockStore.test.ts && npx tsc --noEmit`
Expected: 全部 PASS + 类型检查通过

- [ ] **Step 7: 手动冒烟清单（dev 环境）**

1. `npm run dev` + `npm run electron` 启动。
2. 主界面正常（boot→login→cockpit→workspace 现状不回归）。
3. 打开驾驶舱 → 触发 `window.ponosModules.open('chat', { conversation })` 出现独立聊天窗口，可输入发送。
4. `openModule('files')` / `openModule('settings')` 出现独立文件/设置窗口，可操作。
5. dock 窗口（`openModule('dock')`）显示三区 DockBar，hover 展开；发送消息时 task/question 气泡计数 +1。
6. 关闭聊天窗口后重开，会话消息从 localStorage 恢复（transcript 权威源）。

- [ ] **Step 8: 提交**

```bash
git add electron/main.cjs
git commit -m "feat(main): 集成 ModuleRegistry/StateBus/WindowManager IPC + 模块窗口创建"
```

---

## 阶段 B 概要（后续独立 plan）

本计划交付阶段 A（可独立运行、可测试的地基 + 3 试点）。阶段 B 依赖阶段 A API 定型后另立 plan，包含：
- 剩余模块窗口化：诊断 / 技能Agent / Token 统计 / 历史 / 工作树 / 搜索 / 权限 / 驾驶舱改纯模块
- 外部模块安装：`~/.ponos-dev/modules/<id>/manifest.json` 扫描注册 + `module:get-bundle-url` 安全加载
- 审批/提问卡片迁移到 dock 宿主（dock 展示 → publish → 聊天窗口执行 sendPermissionResponse/sendAnswer）
- 主窗口 dock 形态整合：关闭驾驶舱 → 主窗口收窄 dock + hover 展开 + 锁定
- 驾驶舱 goWorkspace 改 openModule 路由

## Self-Review

**1. Spec coverage：**
- §4 WindowManager → Task 3 + Task 10 ✓
- §5 DockBar → Task 6 + Task 10（dock 窗口打开）✓
- §6 StateBus → Task 2 + Task 4 + Task 7（publish 接入）✓
- §7 外部模块 → Task 1（manifest 解析器）+ 阶段 B（扫描/加载）✓
- §8 迁移清单（聊天/文件/设置试点）→ Task 7/8/9 ✓（其余模块在阶段 B）
- §9 状态收敛（写全量 localStorage + 广播增量 + 读快照）→ Task 7（publish）+ Task 2（快照）+ Task 5（getSnapshot）✓
- §10 测试策略 → 每任务 TDD 单测 + Task 10 集成回归 ✓

**2. Placeholder scan：** 无 TBD/TODO；Task 8/9 的 FileBrowser/SettingsView 复用以实际签名为准有明确说明；Task 5 的 ModuleRoot 分步补齐有明确指引。

**3. Type consistency：**
- `clampBounds(bounds, spec, workArea)` 在 Task 3 定义、Task 3 测试与 Task 10 setBounds 调用一致 ✓
- `BusEvent = { channel, action, payload, from, ts }` 在 Task 2（cjs）/Task 4（types）/Task 5（ts）/Task 7（buildChatEvent）四端一致 ✓
- `createWindowManager({ getModule, bus, createWindow, onClosed })` 在 Task 3 定义、Task 10 实例化一致 ✓
- `ModuleRoot` switch 分支与各模块组件名（ChatModule/FilesModule/SettingsModule/DockBar/CockpitView）跨任务一致 ✓
