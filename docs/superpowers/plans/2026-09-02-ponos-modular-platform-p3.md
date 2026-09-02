# Ponos 模块化平台 · P3 CLI 桥接 Implementation Plan（细化版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行。Steps use checkbox（`- [ ]`）语法。
>
> **Goal:** 建立 cli-bridge 运行时，agent-core 以 cli-bridge 子进程接入（kernel 直连 wrapper），会话方法集（session.*）经宿主 RPC 固化，chat 全链路 JSON-RPC 化，Python 外部程序可注册为标准模块。

**Architecture:** stdio-transport 适配器（child_process NDJSON ↔ envelope，与 ipc/worker-transport 同构）；orchestrator 新增 cli-bridge 运行时（沿用 node-worker 的 start/respawn/exit 模式）；`modules/agent-core/` 子进程把宿主 envelope（session.send/cancel/status）翻译为 `kernel/cli.mjs` 的 NDJSON 契约（零改造，P1 Agent Bridge 参数同款）；宿主侧 rpc-client（state-manager-client 泛化改名）统一 worker/cli 接入；chat 模块 UI 由 `agent.*` 切到 `session.*`。

**Spec:** `docs/superpowers/specs/2026-09-02-ponos-modular-platform-design.md` §4.4（bridge 语义映射）、§5（cli-bridge 运行时）、§10 Phase 3

## Global Constraints

- 测试命令（harness 包内）：`pnpm --filter @ponos/harness test`（即 `cd harness && node --test "src/**/*.test.mjs"`）；root `npm test` 覆盖 modules/* 的 App.test.mjs。
- 仓库协议：模块目录结构参照 `modules/state-manager/`（module.json + 独立逻辑文件 + main.cjs 入口 + package.json + *.test.mjs）。
- 不触碰主线文件（electron/、src/、server/、pet/ 等旧 GUI 基线及其测试）；P3 只改 `harness/`、`modules/{agent-core,echo-demo,chat,launcher}`、`docs/` 与 root package.json（如需）。
- 权限：capabilities 前缀匹配（permission-gate + router.canCall 双层）；模块 UI 无新能力不放行。
- 删除文件（agent-bridge.cjs / agent-bridge.test.mjs / state-manager-client.cjs / state-manager-client.test.mjs）是重命名/迁移的一部分，plan 审阅批准即视为批准删除。
- 注释与提交信息用中文，风格沿用 P1/P2（`feat(p3): ...` / `fix(p3): ...`）；伪对象注入测试模式（fakeChild/fakeSpawn）沿用 P2。
- 每条 kernel NDJSON 事件**原样透传**（除 wrapper 内部记录状态）；chat 侧过滤逻辑不动（事件 shape 见下条）。
- **kernel NDJSON shape 以 `kernel/protocol.mjs` + `docs/bridge-contract.md` §3/§4 为权威**：stdin user 行 `{ type:'user', message:{role:'user',content} }`、control_request `{ type:'control_request', request:{subtype:'cancel'} }`（与 P1 agent-bridge.cjs 同款）；stdout 事件 `system{ subtype:'init', session_id,… }` / `assistant{ message:{role:'assistant',content:[text|thinking|tool_use 块]},… }`（**流式逐块**）/ `result{ usage,… }`。**不存在 `data.text` 形态**——chat 渲染契约按块流式聚合（见范围调整 7、Task 6）。

## 范围调整（相对大纲的裁决，实施时以本计划为准）

1. **server/bridge.mjs 不在 P3 迁移/下线**。勘察结论：旧渲染层（src/，冻结基线）仍有 15+ 组件内联 fetch bridge HTTP 端点、usePonosCLI.ts 独占 WS——bridge.mjs 是旧 GUI 的运行时支撑，其成熟会话逻辑（多会话/--resume/空闲回收/里程碑提取，getOrCreateSession L943-1224）体量远超 P3 目标。P3 兑现「Chat ↔ agent-core 全链路 JSON-RPC」于**新模块体系**（modules/chat ↔ harness ↔ agent-core，全程 ponosRpc）；bridge.mjs 端点原样保留，作为 Phase 5（旧 GUI 退役期）迁移源。大纲任务 6（bridge 收敛）与验收 4（旧端点下线）判定为**超出 P3，改 P5**。
2. **会话模型 = 单默认会话**。agent-core 子进程内维护单一 kernel 子进程（P1/P2 同款）；sessionId 参数可选但仅记录，多会话并行/`--resume` 无缝恢复属 bridge 迁移期（P5）语义。session.status 返回当前会话 busy/firstTokenAt/sessionId。
3. **chat 方法切换**：`agent.send/cancel/event` 退役 → `session.send/cancel/event`；chat capabilities 由 `['agent']` 改 `['session']`。P1 main.test 的 `agent.send ALLOWED` 断言随之更新（方法演进，非回归）。
4. **渲染层收敛（大纲 item4）不做旧 src/**：src/ 零 ponosRpc 引用，全量改写是独立工程；P3 只切 modules/chat 这一真实 agent 消费者。
5. **P2 产物泛化改名**：`state-manager-client.cjs` 更名为通用 `rpc-client.cjs`（createStateManagerClient → createRpcClient），state-manager 与 agent-core 宿主接入共用；测试随迁（见 Task 2 删除清单）。
6. **崩溃恢复语义**：agent-core 子进程崩溃 → orchestrator 500ms respawn（沿用 node-worker 守卫）；wrapper 内 kernel 崩溃 → wrapper 500ms respawn kernel 并重置会话状态。「状态恢复」= 重启后可继续对话（新 session_id 由 kernel init 事件产生），历史 `--resume` 恢复不在 P3。
7. **chat 渲染契约修正（勘察新增）**：`modules/chat/src/events.ts` 的 `reduceEvents` 原按 `ev.data.text` 假设设计（P1 agent-bridge 仅 fake kernel 测过，真实内核未端到端验证）。权威源 `kernel/protocol.mjs` 证实真实事件为 **assistant 流式逐块 `message.content[]`**（text/thinking/tool_use，无 `data.text`），user 消息不出 stdout 事件。Task 6 同步重写 events.ts：text 块在 busy 窗口内**聚合进当前 assistant 气泡**，result 闭轮清 busy；user 消息由 UI 发送时乐观追加。冒烟（Task 8）要求能看到逐块聚合的回复文本。

## 接口契约（固化，跨任务依赖此签名）

cli-bridge 宿主协议（子进程 = envelope RPC 服务，与 node-worker 同构，仅通道为 NDJSON 行）：
- stdin 每行 JSON：`{ id, method, params }`
- stdout 每行 JSON：响应 `{ id, result }` / `{ id, error }`；通知（无 id）`{ method, params }`

agent-core 子进程方法集（stdin 请求 → stdout 响应）：
- `session.send({ text, sessionId? })` → `{ ok: true, sessionId }`（同步受理，不等待轮次）
- `session.cancel({ sessionId? })` → `{ ok: true }`
- `session.status({ sessionId? })` → `{ busy, firstTokenAt, sessionId }`
- 通知：`session.event` → `{ sessionId, event }`（event = kernel NDJSON 事件原样，含 system(init)/assistant/result/tool…）

宿主 RPC（router 注册，capabilities `['session']`，供 chat 模块调用）：
- `session.send(params)` / `session.cancel(params)` / `session.status(params)` → 透传 agent-core 响应；agent-core 未连接时 `{ ok:false, error:'NOT_RUNNING' }`

kernel spawn 参数（wrapper 内，与 P1 agent-bridge 一致）：
`['--print','--output-format','stream-json','--input-format','stream-json','--dangerously-skip-permissions']`

stdlib/stdio-transport：`{ send(env), onMessage(cb) → off, close() }`；send 写入 `JSON.stringify(env)+'\n'`。
orchestrator cli-bridge：`startCli(id)` → `{ ok, cliId }`；`stopCli(id)`；`getCli(id)`；崩溃（`error`）→ 500ms respawn（映射守卫同 startWorker）；`exit` → 清理 + `onWorkerExit?.(id)`；发布频道沿用 `worker`（started/restarted/closed，payload.moduleId）。

---

### Task 1: stdio-transport 适配器（宿主侧）

**Files:**
- Create: `harness/src/rpc/transports/stdio-transport.cjs`
- Test: `harness/src/rpc/transports/stdio-transport.test.mjs`

**Interfaces:**
- Consumes: 无（独立纯逻辑）
- Produces: `createStdioTransport({ child })` → `{ send(env), onMessage(cb) → off, close() }`。child duck：`{ stdin: { write(s) }, stdout: { on('data', cb), removeListener? }, kill() }`。onMessage 回调收到**已 JSON.parse 的对象**（stdio 行协议）；非 JSON 行丢弃。Task 5 用 node spawn 的真实 ChildProcess 或 fake。

- [ ] **Step 1: 写失败测试**

Create `harness/src/rpc/transports/stdio-transport.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStdioTransport } from './stdio-transport.cjs'

/** fake child：手动触发 stdout data 分片，模拟行到达与半行合并。 */
function fakeChild() {
  const c = { stdin: { write() {} }, stdout: null, killed: false, kill() { this.killed = true } }
  const dataListeners = []
  c.stdout = { on(ev, cb) { if (ev === 'data') dataListeners.push(cb) } }
  c.emit = chunk => dataListeners.forEach(cb => cb(chunk))
  return c
}

test('send 写 JSON 行；onMessage 收到解析后的对象（半行合并 + 非 JSON 丢弃）', () => {
  const c = fakeChild()
  const written = []
  c.stdin.write = s => written.push(s)
  const t = createStdioTransport({ child: c })
  const got = []
  t.onMessage(m => got.push(m))
  t.send({ id: 1, method: 'session.status' })
  assert.equal(written.length, 1)
  assert.equal(written[0], JSON.stringify({ id: 1, method: 'session.status' }) + '\n')
  // 分片到达：第一片只含半行 + 第二片补全 → 应合并为一行
  c.emit('{"id": 2, "res')
  assert.equal(got.length, 0, '半行不应触发')
  c.emit('ult": {"ok": true}}\n')
  assert.equal(got.length, 1)
  assert.deepEqual(got[0], { id: 2, result: { ok: true } })
  // 非 JSON 行丢弃
  c.emit('not json\n')
  assert.equal(got.length, 1)
})

test('onMessage 返回退订；close 调 child.kill', () => {
  const c = fakeChild()
  const t = createStdioTransport({ child: c })
  let n = 0
  const off = t.onMessage(() => n++)
  c.emit('{"method":"session.event","params":{}}\n')
  off()
  c.emit('{"method":"x"}\n')
  assert.equal(n, 1)
  t.close()
  assert.equal(c.killed, true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd harness && node --test "src/**/*.test.mjs"`
Expected: FAIL — `Cannot find module './stdio-transport.cjs'`

- [ ] **Step 3: 实现**

Create `harness/src/rpc/transports/stdio-transport.cjs`:

```js
'use strict'

/**
 * 宿主侧 stdio-transport 适配器：child_process stdout 的 NDJSON 行协议 ↔ envelope。
 * 与 ipc/worker-transport 同构的 { send, onMessage, close }。
 * child duck：{ stdin: { write(s) }, stdout: { on('data', cb) }, kill() }。
 */
function createStdioTransport({ child }) {
  const listeners = new Set()
  let buf = ''
  child.stdout.on('data', chunk => {
    buf += chunk.toString()
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }  // 非 JSON 行丢弃（kernel 侧 raw 由 wrapper 处理，宿主侧不适用）
      for (const cb of listeners) { try { cb(parsed) } catch {} }
    }
  })
  return {
    send(env) { child.stdin.write(JSON.stringify(env) + '\n') },
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    close() { child.kill() },
  }
}

module.exports = { createStdioTransport }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd harness && node --test "src/**/*.test.mjs"`
Expected: PASS（stdio-transport 2 个新测试；既有 41 个不受影响）

- [ ] **Step 5: Commit**

```bash
git add harness/src/rpc/transports/stdio-transport.cjs harness/src/rpc/transports/stdio-transport.test.mjs
git commit -m "feat(p3): stdio-transport 宿主侧适配器 — child stdout NDJSON 行 ↔ send/onMessage/close"
```

---

### Task 2: rpc-client 泛化（state-manager-client → rpc-client）

**Files:**
- Rename: `harness/src/kernel/state-manager-client.cjs` → `harness/src/kernel/rpc-client.cjs`
- Rename: `harness/src/kernel/state-manager-client.test.mjs` → `harness/src/kernel/rpc-client.test.mjs`
- Modify: `harness/src/main.cjs`（`createStateManagerClient` import → `createRpcClient`，调点 2 处）
- Test: `harness/src/kernel/rpc-client.test.mjs`

**Interfaces:**
- Consumes: P2 `createStateManagerClient`（实现通用，仅命名暗示 state 语义）
- Produces: `createRpcClient({ transport })` → `{ call(method, params) → Promise<result>, onNotification(cb) → off }`（id 递增配对；无 id 消息分发通知）。Task 5 宿主对 agent-core 复用同款。
- Deletes: 原两个文件名（P2 产物更名迁移，不重复保留）

- [ ] **Step 1: 改名为 rpc-client 并更新内容**

Rename `harness/src/kernel/state-manager-client.cjs` → `harness/src/kernel/rpc-client.cjs`、`state-manager-client.test.mjs` → `rpc-client.test.mjs`（git mv 保留历史）。实现文件头部注释改为通用语义，导出名改为 `createRpcClient`：

```bash
git mv harness/src/kernel/state-manager-client.cjs harness/src/kernel/rpc-client.cjs
git mv harness/src/kernel/state-manager-client.test.mjs harness/src/kernel/rpc-client.test.mjs
```

Edit `harness/src/kernel/rpc-client.cjs`（顶部注释 + 函数名 + 导出）：

```js
'use strict'

/** 宿主侧通用 rpc client：请求/响应经递增 id 配对，无 id 消息分发通知。
 *  由 P2 state-manager-client 泛化更名（P3）：state-manager 与 agent-core 宿主接入共用。 */
function createRpcClient({ transport }) {
  // ...（函数体不变：seq/pending/notifications/call/onNotification）
}

module.exports = { createRpcClient }
```

（保留原 `createStateManagerClient` 名不设别名——P3 内一次性迁移干净。）

Edit `harness/src/kernel/rpc-client.test.mjs`：import 与断言中的 `createStateManagerClient` → `createRpcClient`（文件其余不变）。

Edit `harness/src/main.cjs`：
- `const { createStateManagerClient } = require('./kernel/state-manager-client.cjs')` → `const { createRpcClient } = require('./kernel/rpc-client.cjs')`
- `smClient = createStateManagerClient({ transport: smTransport })` → `smClient = createRpcClient({ transport: smTransport })`

- [ ] **Step 2: 运行测试确认改名后仍通过**

Run: `cd harness && node --test "src/**/*.test.mjs"`
Expected: PASS（rpc-client 既有用例随迁；更名不增减用例——比 Task 1 结束时多出的只有 Task 1 自身新增 2 个）

- [ ] **Step 3: Commit**

```bash
git add -A harness/src/kernel/state-manager-client.cjs harness/src/kernel/state-manager-client.test.mjs harness/src/kernel/rpc-client.cjs harness/src/kernel/rpc-client.test.mjs harness/src/main.cjs
git commit -m "refactor(p3): state-manager-client 泛化更名 rpc-client — createRpcClient 通用接入（Task 5 复用）"
```

---

### Task 3: orchestrator cli-bridge 运行时 + registry 扩展

**Files:**
- Modify: `harness/src/kernel/process-orchestrator.cjs`（新增 startCli/stopCli/getCli；onWorkerExit 复用）
- Modify: `harness/src/kernel/module-registry.cjs`（BUILTIN_MODULES 加 agent-core、echo-demo）
- Test: `harness/src/kernel/process-orchestrator.test.mjs`、`harness/src/kernel/module-registry.test.mjs`

**Interfaces:**
- Consumes: P2 `createProcessOrchestrator({ getModule, bus, createWindow, createWorker, onClosed, onWorkerExit, hooks })`；本 Task 增注入 `createCli(mod)`（返回 child duck：`{ stdin:{write}, stdout:{on('data')}, on(ev,cb), kill() }`）
- Produces:
  - `startCli(id)` → `{ ok, cliId }`（仅 runtime==='cli-bridge'；重复启动 `{ ok:false, error:'ALREADY_RUNNING' }`）
  - 崩溃 → 500ms respawn：`error`（spawn 失败）与 `exit` 非零码（真实 child_process 崩溃形态）都触发，映射守卫（已替换/已删才跳过）同 startWorker
  - `exit` code 0（优雅退出）→ 清理 + `onWorkerExit?.(id)`；stopCli 先删映射再 kill → exit 回调被守卫短路
  - `stopCli(id)` / `getCli(id)`；发布频道沿用 `worker`（started/restarted）
  - registry：agent-core `{ id:'agent-core', name:'Agent 内核', icon:'brain', singleton:true, builtin:true, runtime:'cli-bridge', capabilities:[], entry:{ main:'modules/agent-core/main.cjs' } }`；echo-demo `{ id:'echo-demo', name:'外部程序示例', icon:'terminal', singleton:true, builtin:true, runtime:'cli-bridge', capabilities:[], entry:{ main:'modules/echo-demo/main.py' } }`（Task 4/7 才建实体文件——本 Task 先注册条目，orchestrator 测试用 fake getModule）

- [ ] **Step 1: 写失败测试（registry 条目 + orchestrator cli 生命周期）**

追加到 `harness/src/kernel/process-orchestrator.test.mjs`。先在文件顶部 `MODS` 增加两条（cli-bridge 运行时模块，与既有 state/settings 平级）：

```js
  'agent-core': { id: 'agent-core', runtime: 'cli-bridge', singleton: true },
  'echo-demo': { id: 'echo-demo', runtime: 'cli-bridge', singleton: true },
```

再在文件底部（`fakeWorker` 定义附近）追加 fakeCli 与三个测试：

```js
function fakeCli() {
  const listeners = {}
  return {
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
    stdin: { write() {} },
    stdout: { on() {} },
    kill() { this.killed = true },
  }
}

test('startCli 创建 cli 子进程、发布 started、重复启动报 ALREADY_RUNNING', () => {
  const bus = createStateBus()
  const created = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createCli: mod => { const c = fakeCli(); created.push(c); return c },
    onClosed: () => {}, hooks: {},
  })
  const r = orch.startCli('agent-core')
  assert.equal(r.ok, true)
  assert.equal(created.length, 1)
  assert.equal(orch.startCli('agent-core').error, 'ALREADY_RUNNING')
  const started = bus.getSnapshot('worker').filter(e => e.action === 'started' && e.payload.moduleId === 'agent-core')
  assert.equal(started.length, 1)
})

test('cli 崩溃 → 500ms 延迟 respawn 并发布 restarted', async () => {
  const bus = createStateBus()
  let n = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createCli: () => { n++; return fakeCli() },
    onClosed: () => {}, hooks: {},
  })
  orch.startCli('agent-core')
  const first = orch.getCli('agent-core')
  first.emit('error', new Error('boom'))
  await new Promise(r => setTimeout(r, 700))
  assert.equal(n, 2)
  assert.ok(orch.getCli('agent-core'))
  assert.notEqual(orch.getCli('agent-core'), first)
  assert.equal(bus.getSnapshot('worker').filter(e => e.action === 'restarted').length, 1)
})

test('cli 正常退出（code 0）→ 清理映射并触发 onWorkerExit；ui-renderer 模块不可 startCli', () => {
  const bus = createStateBus()
  const exited = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createCli: () => fakeCli(),
    onClosed: () => {}, onWorkerExit: id => exited.push(id), hooks: {},
  })
  orch.startCli('agent-core')
  const c = orch.getCli('agent-core')
  c.emit('exit', 0)   // 优雅退出（stdin EOF 等）→ 清理；真实崩溃（code≠0）见下一用例
  assert.equal(orch.getCli('agent-core'), null)
  assert.deepEqual(exited, ['agent-core'])
  assert.equal(orch.startCli('chat').error, 'not a cli-bridge module')
})

test('cli 非零退出（真实 child_process 崩溃形态）→ 500ms respawn 并发布 restarted', async () => {
  const bus = createStateBus()
  let n = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createCli: () => { n++; return fakeCli() },
    onClosed: () => {}, hooks: {},
  })
  orch.startCli('agent-core')
  const first = orch.getCli('agent-core')
  first.emit('exit', 1)
  await new Promise(r => setTimeout(r, 700))
  assert.equal(n, 2, '非零退出应触发 respawn')
  assert.ok(orch.getCli('agent-core'))
  assert.notEqual(orch.getCli('agent-core'), first)
  assert.equal(bus.getSnapshot('worker').filter(e => e.action === 'restarted').length, 1)
})
```

追加到 `harness/src/kernel/module-registry.test.mjs`（该文件目前只 import `parseManifest`，需先补 `getModule`）：

Step 1a：Edit 导入行
```js
// old: import { parseManifest } from './module-registry.cjs'
import { parseManifest, getModule } from './module-registry.cjs'
```

Step 1b：文件底部追加用例
```js
test('BUILTIN 含 cli-bridge 模块（agent-core/echo-demo，无 windowSpec 必需）', () => {
  const ac = getModule('agent-core')
  assert.equal(ac.runtime, 'cli-bridge')
  assert.equal(ac.entry.main, 'modules/agent-core/main.cjs')
  const ed = getModule('echo-demo')
  assert.equal(ed.runtime, 'cli-bridge')
  assert.equal(ed.entry.main, 'modules/echo-demo/main.py')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd harness && node --test "src/**/*.test.mjs"`
Expected: FAIL（registry 用例：getModule('agent-core') 返回 undefined；orchestrator 用例：startCli 未定义）

- [ ] **Step 3: 实现 orchestrator startCli/stopCli/getCli**

Edit `harness/src/kernel/process-orchestrator.cjs`：文件头注释补 cli-bridge 段落；`createProcessOrchestrator` 解构增加 `createCli`；新增 `const clis = new Map()` 与三函数（对称 startWorker，见下）。注意 child duck 的 `on('error'/'exit')` 注册与 `kill()`。

```js
  /** Map<moduleId, ChildProcess>（cli-bridge 运行时子进程；崩溃 respawn 沿用 500ms 守卫） */
  const clis = new Map()

  /**
   * cli-bridge 生命周期：仅 runtime === 'cli-bridge' 的模块可启动；
   * 崩溃 → 500ms 延迟 respawn（映射守卫同 startWorker）；正常退出 → 清理并触发 onWorkerExit。
   * 注意：child_process 与 node-worker 崩溃信号不同——worker_threads 用 'error' 表达脚本崩溃，
   * child_process 真实崩溃是 exit(code≠0)（'error' 仅 spawn 失败），两者都做 respawn。
   * 退出判定：code===0 或映射已被替换（stopCli 先删映射）→ 不 respawn。
   */
  function crashRespawn(id, child) {
    setTimeout(() => {
      if (clis.get(id) && clis.get(id) !== child) return
      clis.delete(id)
      try { child.kill?.() } catch {}
      startCli(id)
      publishState('worker', 'restarted', { moduleId: id })
    }, 500)
  }

  function startCli(id) {
    const mod = getModule(id)
    if (!mod || mod.runtime !== 'cli-bridge') return { ok: false, error: 'not a cli-bridge module' }
    if (clis.has(id)) return { ok: false, error: 'ALREADY_RUNNING' }
    const child = createCli(mod)
    clis.set(id, child)
    child.on('error', () => crashRespawn(id, child))          // spawn 失败
    child.on('exit', (code) => {
      if (clis.get(id) !== child) return                      // stopCli 已先删映射 → 不处理
      if (code === 0) { clis.delete(id); onWorkerExit?.(id) } // 优雅退出
      else crashRespawn(id, child)                            // 崩溃（非零退出）
    })
    publishState('worker', 'started', { moduleId: id })
    return { ok: true, cliId: id }
  }

  function stopCli(id) {
    const c = clis.get(id)
    if (!c) return { ok: false, error: 'NOT_RUNNING' }
    clis.delete(id)
    try { c.kill?.() } catch {}
    return { ok: true }
  }

  function getCli(id) { return clis.get(id) || null }
```

Edit `harness/src/kernel/module-registry.cjs`：BUILTIN_MODULES 数组追加两项（agent-core、echo-demo，见 Interfaces.Produces 的精确对象）。**本 Task 不改 chat 的 capabilities**——保持 `['system.window','agent']`，否则 `main.test.mjs` 测试 2（chat `agent.send` ALLOWED，Task 5 才改写）在 Task 3 提交点即红；chat capabilities 翻转为 `['system.window','session']` 随 Task 5 的 main.test.mjs 重写一并提交。

Edit `harness/src/kernel/process-orchestrator.cjs` return 语句补 `startCli, stopCli, getCli`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd harness && node --test "src/**/*.test.mjs"`
Expected: PASS（新增用例通过；既有全部不受影响）

- [ ] **Step 5: Commit**

```bash
git add harness/src/kernel/process-orchestrator.cjs harness/src/kernel/process-orchestrator.test.mjs harness/src/kernel/module-registry.cjs harness/src/kernel/module-registry.test.mjs
git commit -m "feat(p3): orchestrator cli-bridge 运行时 + registry 注册 agent-core/echo-demo"
```

---

### Task 4: agent-core 模块（envelope 协议 ↔ kernel NDJSON 转换进程）

**Files:**
- Create: `modules/agent-core/module.json`
- Create: `modules/agent-core/package.json`
- Create: `modules/agent-core/core.cjs`
- Create: `modules/agent-core/core.test.mjs`
- Create: `modules/agent-core/main.cjs`

**Interfaces:**
- Consumes: Task 3 registry 条目（entry.main）；P1 kernel spawn 参数；bridge-contract §3/§4（kernel stdin/stdout NDJSON 语义）
- Produces:
  - `createSessionHost({ spawnImpl, kernelPath, nodePath, args, stdin })` → `{ spawnKernel(), handleRequest(method, params), onEvent(cb) → off, status() }`，内部维护 kernel 子进程生命周期与会话状态
  - kernel 事件判定：`system/init` → 记录 `session_id`；`assistant` → busy=true + firstTokenAt 埋点；`result` → busy=false；其余全部透传（含 init 本身）
  - `handleRequest` switch：`session.send`（写 user 行 → `{ok:true, sessionId}`）、`session.cancel`（写 control_request → `{ok:true}`）、`session.status`（读内部态）
  - `main.cjs`：readline stdin → 逐行 `handleRequest` → stdout 响应；`onEvent` 转发为无 id 通知 `{ method:'session.event', params:{ sessionId, event } }`；kernel `error` → 500ms respawn（守卫：当前 proc 仍是自己）

- [ ] **Step 1: 写失败测试（core.cjs 纯逻辑）**

Create `modules/agent-core/core.test.mjs`（fake spawn 捕获 kernel spawn 参数与 stdin 写入；fake readline 触发 kernel 行）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionHost } from './core.cjs'

/** fake kernel 子进程：捕获 stdin 写入、触发 stdout 行与 error 事件（core 在 spawn 后 proc.on 注册）。 */
function fakeKernel() {
  const k = { stdin: { write() {} }, stdout: null, killed: false, kill() { this.killed = true } }
  const evCbs = {}
  k.on = (ev, cb) => { (evCbs[ev] ||= []).push(cb) }
  k.stdin.write = s => { k.writes = k.writes || []; k.writes.push(JSON.parse(s)) }
  // readline 注入器返回对象：{ on(ev, cb) }，'line' 事件由测试手动触发
  const rlCbs = {}
  k.rl = { on(ev, cb) { rlCbs[ev] = cb } }
  k.emitLine = line => rlCbs['line']?.(line)
  k.emitError = () => (evCbs['error'] || []).forEach(cb => cb(new Error('boom')))
  k.emitExit = (code) => (evCbs['exit'] || []).forEach(cb => cb(code))
  return k
}

function makeHost(over = {}) {
  const spawned = []
  const readlineImpl = k => k.rl
  const host = createSessionHost({
    spawnImpl: (node, args, opts) => { const k = fakeKernel(); k.spawnArgs = { node, args }; spawned.push(k); return k },
    readlineImpl, kernelPath: '/k/cli.mjs', nodePath: 'node',
    args: ['--print', '--output-format', 'stream-json'],
    ...over,
  })
  return { host, spawned }
}

test('spawnKernel 用 node kernelPath+args；send 写 user 行', () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].spawnArgs.args[0], '/k/cli.mjs')
  const res = host.handleRequest('session.send', { text: '你好' })
  assert.equal(res.ok, true)
  assert.equal(res.sessionId, '', 'init 事件前 sessionId 为空串（由 init 回填）')
  assert.equal(spawned[0].writes[0].type, 'user')
  // user 行契约（bridge-contract §3 / bridge.mjs:2295）：{ type:'user', message:{role:'user',content} }
  assert.equal(spawned[0].writes[0].message.content, '你好')
})

test('kernel init/assistant/result 行更新会话状态并透传事件', () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  const k = spawned[0]
  const events = []
  host.onEvent(ev => events.push(ev))
  k.emitLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-9', model: 'm' }))
  assert.equal(host.status().sessionId, 's-9')
  k.emitLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }))
  const st = host.status()
  assert.equal(st.busy, true)
  assert.ok(st.firstTokenAt)
  k.emitLine(JSON.stringify({ type: 'result', usage: {} }))
  assert.equal(host.status().busy, false)
  // init 事件本身也透传（chat 侧按 type 过滤）
  assert.equal(events.length, 3)
  assert.equal(events[0].type, 'system')
})

test('cancel 写 control_request；kernel 崩溃（error）500ms 后 respawn 并重置状态', async () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  const k1 = spawned[0]
  k1.emitLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'old' }))
  assert.equal(host.status().sessionId, 'old')
  const res = host.handleRequest('session.cancel', {})
  assert.equal(res.ok, true)
  assert.equal(k1.writes[0].type, 'control_request')
  // kernel spawn 失败（'error' 事件）→ 500ms respawn（core 在 spawn 后经 proc.on 注册，fake.emitError 触发）
  k1.emitError()
  await new Promise(r => setTimeout(r, 650))
  assert.equal(spawned.length, 2, '500ms 后应 respawn 新 kernel')
  // 新 kernel 就绪后状态已重置（sessionId 待新 init 事件回填）
  assert.equal(host.status().sessionId, '', 'respawn 后 sessionId 重置')
  assert.equal(host.status().busy, false)
})

test('kernel 非零退出（真实崩溃形态：exit code≠0）→ 500ms respawn', async () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  const k1 = spawned[0]
  k1.emitLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }))
  assert.equal(host.status().busy, true)
  k1.emitExit(1)   // 真实 node 子进程崩溃 = exit(code≠0)，不是 'error'
  await new Promise(r => setTimeout(r, 650))
  assert.equal(spawned.length, 2, '非零退出应触发 respawn')
  assert.equal(host.status().busy, false, 'respawn 后会话状态重置（busy/firstTokenAt 清空）')
})

test('kernel 优雅退出（exit 0）→ 不 respawn（会话自然收尾）', async () => {
  const { host, spawned } = makeHost()
  host.spawnKernel()
  spawned[0].emitExit(0)
  await new Promise(r => setTimeout(r, 650))
  assert.equal(spawned.length, 1, 'exit 0 不应触发 respawn')
})
```

> 注：core 在 spawn 返回后立即 `proc.on('error'/'exit')`，fake 的 on 已收集回调——`emitError`（spawn 失败）与 `emitExit(非0)`（真实崩溃）都进入 500ms respawn 排程（守卫 `proc && !proc.killed`）；`emitExit(0)`（优雅收尾）置 proc=null 不重建。若断言与实际实现时序冲突，以实现后跑出的事件序为准微调，测试意图不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd modules/agent-core && node --test core.test.mjs`（目录不存在则先建）
Expected: FAIL — `Cannot find module './core.cjs'`

- [ ] **Step 3: 实现 core.cjs（会话状态机 + kernel 转换）**

Create `modules/agent-core/core.cjs`:

```js
'use strict'

const readline = require('node:readline')

/**
 * agent-core 会话宿主（纯逻辑，可单测）：
 * 宿主 envelope（session.send/cancel/status）↔ kernel/cli.mjs NDJSON 契约（零改造）。
 * 内部维护单一 kernel 子进程：spawn/崩溃 respawn/会话状态（sessionId/busy/firstTokenAt）。
 * kernel 事件全部透传 onEvent；session_id 取自 system(init) 事件。
 * P3 单默认会话：sessionId 参数仅记录不分支（多会话/--resume 属 P5 bridge 迁移语义）。
 */
function createSessionHost({ spawnImpl, readlineImpl, kernelPath, nodePath, args }) {
  let proc = null
  let rl = null
  let sessionId = ''
  let busy = false
  let firstTokenAt = null
  let respawnTimer = null
  const listeners = new Set()

  function onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb) }
  function emitEvent(event) { for (const cb of listeners) { try { cb(event) } catch {} } }

  function spawnKernel() {
    proc = (spawnImpl)(nodePath, [kernelPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    sessionId = ''  // 新 kernel 的 session_id 待 init 事件
    busy = false
    firstTokenAt = null
    rl = (readlineImpl || readline.createInterface)({ input: proc.stdout })
    rl.on('line', line => {
      let parsed
      try { parsed = JSON.parse(line) } catch { return }  // kernel raw 行忽略（P3 无 raw 消费者）
      if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) sessionId = parsed.session_id
      if (parsed.type === 'assistant') { busy = true; if (firstTokenAt === null) firstTokenAt = Date.now() }
      if (parsed.type === 'result') busy = false
      emitEvent(parsed)
    })
    // 崩溃 respawn（500ms）：'error'（spawn 失败）与 exit 非零码（真实 node 子进程崩溃形态）
    // 都重建；exit 0（优雅收尾）→ 清理引用不重建。守卫：proc 仍指向本进程（未被 stop/替换）。
    function scheduleRespawn() {
      clearTimeout(respawnTimer)
      respawnTimer = setTimeout(() => { if (proc && !proc.killed) spawnKernel() }, 500)
    }
    proc.on('error', () => scheduleRespawn())
    proc.on('exit', (code) => {
      if (code === 0) { proc = null; rl = null; return }
      scheduleRespawn()
    })
    return proc
  }

  function sendText(text) {
    if (!proc) return { ok: false, error: 'NOT_RUNNING' }
    // user 行契约（bridge-contract §3）：{ type:'user', message:{role:'user',content} }——与 bridge.mjs:2295 同款
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    return { ok: true }
  }

  function cancel() {
    if (!proc) return { ok: false, error: 'NOT_RUNNING' }
    // cancel 与 P1 agent-bridge.cjs 同款（契约 §3 control_request；request_id 可选，不加）
    proc.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
    return { ok: true }
  }

  function status() { return { busy, firstTokenAt, sessionId } }

  function handleRequest(method, params = {}) {
    switch (method) {
      case 'session.send': {
        const r = sendText(String(params.text || ''))
        if (!r.ok) return r
        return { ok: true, sessionId }
      }
      case 'session.cancel': return cancel()
      case 'session.status': return status()
      default: return { ok: false, error: 'METHOD_NOT_FOUND' }
    }
  }

  return { spawnKernel, sendText, cancel, status, handleRequest, onEvent }
}

module.exports = { createSessionHost }
```

Create `modules/agent-core/main.cjs`（子进程入口：stdin 行 → handleRequest → stdout 响应；事件 → 无 id 通知）：

```js
'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const { createSessionHost } = require('./core.cjs')

/**
 * agent-core cli-bridge 子进程入口。
 * 宿主 stdin NDJSON：{ id, method, params } → stdout 响应 { id, result|error }；
 * kernel 事件 → stdout 通知 { method:'session.event', params:{ sessionId, event } }。
 * kernelPath 默认 repo-root kernel/cli.mjs（本文件位于 modules/agent-core/）。
 */
function runAgentCore({ stdin = process.stdin, stdout = process.stdout, kernelPath, spawnImpl, readlineImpl } = {}) {
  const host = createSessionHost({
    spawnImpl: spawnImpl || spawn,
    readlineImpl,
    kernelPath: kernelPath || path.join(__dirname, '..', '..', 'kernel', 'cli.mjs'),
    nodePath: process.execPath,  // 本进程即 node 运行，execPath 可直接复用
    args: ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions'],
  })
  host.spawnKernel()
  host.onEvent(event => {
    stdout.write(JSON.stringify({ method: 'session.event', params: { sessionId: host.status().sessionId, event } }) + '\n')
  })
  const rl = readline.createInterface({ input: stdin })
  rl.on('line', line => {
    let req
    try { req = JSON.parse(line) } catch { return }
    if (!req || req.id === undefined) return
    const res = host.handleRequest(req.method, req.params)
    if (res.ok) stdout.write(JSON.stringify({ id: req.id, result: res }) + '\n')
    else stdout.write(JSON.stringify({ id: req.id, error: res.error }) + '\n')
  })
  return host
}

if (require.main === module) runAgentCore()
module.exports = { runAgentCore }
```

Create `modules/agent-core/module.json`:

```json
{
  "id": "agent-core",
  "name": "Agent 内核",
  "version": "0.1.0",
  "icon": "brain",
  "runtime": "cli-bridge",
  "singleton": true,
  "capabilities": [],
  "entry": { "main": "modules/agent-core/main.cjs" }
}
```

Create `modules/agent-core/package.json`:

```json
{
  "name": "@ponos/agent-core",
  "version": "0.1.0",
  "private": true,
  "main": "main.cjs",
  "scripts": { "test": "node --test core.test.mjs" }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd modules/agent-core && node --test core.test.mjs`
Expected: PASS（5 用例：spawn+user 行 / init-assistant-result 状态机 / error 崩溃 respawn / exit(1) 真实崩溃形态 respawn / exit(0) 优雅退出不 respawn）

- [ ] **Step 5: Commit**

```bash
git add modules/agent-core/
git commit -m "feat(p3): agent-core cli-bridge 模块 — envelope↔kernel NDJSON 转换进程（session.send/cancel/status + 事件透传 + 崩溃 respawn）"
```

---

### Task 5: 宿主装配（main.cjs 接入 agent-core + session.* RPC + 退役 agent.*）

**Files:**
- Modify: `harness/src/main.cjs`（buildApp：createCli 注入 + startCli('agent-core') + connectAgentCore + router session.*；删除 P1 agent 段；kernelArgs 退役）
- Modify: `harness/src/kernel/module-registry.cjs`（chat capabilities → session，与 main.test 重写同提交保绿）
- Delete: `harness/src/kernel/agent-bridge.cjs`、`harness/src/kernel/agent-bridge.test.mjs`
- Test: `harness/src/main.test.mjs`（agent.send 断言 → session.send/session.status；kernelArgs/fakeChild 移除）

**Interfaces:**
- Consumes: Task 2 `createRpcClient`、Task 3 `startCli/getCli`、Task 4 agent-core 子进程（entry.main）、stdio-transport（Task 1）
- Produces:
  - bus 订阅 `worker` 频道：`started` 且 `moduleId==='state-manager'` → `connectStateManager()`（既有）；`moduleId==='agent-core'` → `connectAgentCore()`
  - `connectAgentCore()`：残留 detach → `getCli('agent-core')` → `createStdioTransport({ child })` → `createRpcClient({ transport })` → `onNotification(ev => ev?.method==='session.event' && mr.sendTo('chat', makeEnvelope({ method:'session.event', params:ev.params, x_sender:'agent-core', x_target:'chat' })))` → `mr.attach('agent-core', { send: (ch, env) => transport.send(env) }, [])`
  - router：`session.send`/`session.cancel`/`session.status`（capabilities `['session']`；handler 经 `agentCoreClient.call`；未连接返回 NOT_RUNNING）
  - registry chat capabilities `['system.window','agent']` → `['system.window','session']`（本 Task 提交，配合 main.test.mjs 断言；chat 的模块 UI 切 session.* 在 Task 6）
  - 移除 `agent.send`/`agent.cancel` 注册与 P1 bridge 全部代码；装配末尾 `if (createCli) orchestrator.startCli('agent-core')`；return 去 `agent` 字段
  - main.test.mjs：chat `session.send` ALLOWED（经 gate）；launcher `session.send` PERMISSION_DENIED；agent.send 断言移除

- [ ] **Step 1: 读 main.test.mjs 现有 agent 断言**

Run: `grep -n "agent" harness/src/main.test.mjs`
Expected: 找到 P1 验收断言（chat agent.send ALLOWED、launcher 拒）。记录行号，Step 3 更新。

- [ ] **Step 2: 改 main.cjs（先改后测，随后更新测试）**

Edit `harness/src/main.cjs`：

```js
// 顶部 import 区：
// 删：const { createAgentBridge } = require('./kernel/agent-bridge.cjs')   // P1 桥退役
// 留：const { makeEnvelope } = require('./rpc/envelope.cjs')                // session.event / state 广播仍用
// 增：const { createRpcClient } = require('./kernel/rpc-client.cjs')        // （Task 2 已更名）
// 增：const { createStdioTransport } = require('./rpc/transports/stdio-transport.cjs')
```

（1）buildApp 入参解构：`kernelArgs` 随 P1 bridge 一并退役（P3 无消费者），`createCli` 紧跟 createWorker：
```js
function buildApp({ ipcMain, createWindow, createWorker, createCli, workArea }) {
```
（2）删除 P1 Agent 桥段（`createAgentBridge` import、bridge 实例化、`bridge.onEvent`、`router.register('agent.send'/'agent.cancel')`、`bridge.start()`、return 对象里的 `agent: bridge`——return 变 `{ app, router, mr, orchestrator, bus }`），替换为：

```js
  // —— agent-core（cli-bridge 模块）：会话方法集 + 事件转发 chat ——
  let agentCoreClient = null
  function connectAgentCore() {
    mr.detach('agent-core')  // 重连前清残留（respawn 崩溃路径同 state-manager）
    const child = orchestrator.getCli('agent-core')
    if (!child) return
    const transport = createStdioTransport({ child })
    const client = createRpcClient({ transport })
    client.onNotification(ev => {
      if (ev?.method === 'session.event') {
        const env = makeEnvelope({ method: 'session.event', params: ev.params, x_sender: 'agent-core', x_target: 'chat' })
        mr.sendTo('chat', env)
      }
    })
    mr.attach('agent-core', { send: (ch, env) => transport.send(env) }, [])
    agentCoreClient = client
  }
  const sessionCall = method => (params) => agentCoreClient
    ? agentCoreClient.call(method, params || {})
    : { ok: false, error: 'NOT_RUNNING' }
  router.register('session.send', sessionCall('session.send'), { capabilities: ['session'] })
  router.register('session.cancel', sessionCall('session.cancel'), { capabilities: ['session'] })
  router.register('session.status', sessionCall('session.status'), { capabilities: ['session'] })
```

（3）worker 频道订阅扩为两个分支（在既有 `bus.subscribe('worker', ...)` 回调内）：
```js
  bus.subscribe('worker', { send: (ch, full) => {
    if (full?.action === 'started' && full.payload?.moduleId === 'state-manager') connectStateManager()
    if (full?.action === 'started' && full.payload?.moduleId === 'agent-core') connectAgentCore()
  } })
```
（4）装配底部（state-manager 启动旁）：
```js
  if (createCli) orchestrator.startCli('agent-core')  // 触发 worker:started → connectAgentCore
```
（5）装配 createWorker 处（真实启动分支，ctx 闭包）增加 createCli 注入——node 走 PATH（dev 经 npm/pnpm 启动，node 在 PATH；agent-core 内部 spawn kernel 用自身 execPath，host 侧只需拉起 agent-core）：
```js
      createCli: (mod) => {
        const file = path.join(__dirname, '..', '..', mod.entry.main)  // entry.main 为 repo-root 相对
        return require('node:child_process').spawn('node', [file], {
          env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
        })
      },
```
（6）Edit `harness/src/kernel/module-registry.cjs`：chat 条目 capabilities `['system.window', 'agent']` → `['system.window', 'session']`（与 main.test.mjs 重写同提交，保证该点 suite 绿；modules/chat/module.json 的同步翻转在 Task 6）：
```js
    capabilities: ['system.window', 'session'],  // P3：agent.* 退役，会话方法集 session.*
```
（7）删除 `harness/src/kernel/agent-bridge.cjs` 与 `agent-bridge.test.mjs`（git rm）。

- [ ] **Step 3: 更新 main.test.mjs 会话断言**

Edit `harness/src/main.test.mjs`（buildApp 返回对象不再含 `agent` 字段——P3 删除 bridge 后 `return { app, router, mr, orchestrator, bus }`，既有测试未引用 `ctx.agent` 不受影响）：

测试 1（deny 路径）：`{ method: 'agent.send' }` → `{ method: 'session.send' }`，注释同步（launcher capabilities 无 `session` → 仍 PERMISSION_DENIED；断言体不变）。同步清理：删除文件顶部 `fakeChild`（P1 agent-bridge fake，P3 无消费者）与全部测试构造中的 `kernelArgs` 注入（`buildApp` 签名已去 kernelArgs，P3 无 spawnImpl/readlineImpl 消费者）。

测试 2（chat ALLOWED 链路）整体改写为：注入 `createCli`（fake cli 子进程，stdout 可触发 data），验证 `session.send` 经 gate 放行后 RPC 请求写入 agent-core 子进程 stdin，且子进程响应回传：

```js
test('chat 模块 session.send 经权限门放行，请求直达 agent-core 子进程', async () => {
  const handlers = new Map()
  const WC = {}
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  // fake cli 子进程：捕获 stdin 写（请求行）；stdout.on('data') 供 stdio-transport 注册，测试手动注入响应
  const cli = {
    written: [],
    stdin: { write(s) { this.written.push(JSON.parse(s)) } },
    stdout: { on() {} },
    kill() { this.killed = true },
    on() {},
  }
  const cliDataCbs = []
  cli.stdout.on = (ev, cb) => { if (ev === 'data') cliDataCbs.push(cb) }
  cli.emitData = chunk => cliDataCbs.forEach(cb => cb(chunk))
  const ctx = buildApp({
    ipcMain,
    createWindow: () => ({ isDestroyed: () => false, on() {}, destroy() {}, close() {}, webContents: WC }),
    createCli: () => cli,
  })
  ctx.orchestrator.open('chat')  // attach chat（caps ['system.window','session']）

  const callFn = handlers.get('ponos:call')
  const p = callFn({ sender: WC }, { method: 'session.send', params: { text: '你好' } })
  await new Promise(r => setTimeout(r, 0))  // 等待 RPC 请求经 transport 写入
  const req = cli.written.find(m => m.method === 'session.send')
  assert.ok(req, 'session.send 请求应写入 agent-core stdin')
  assert.equal(req.params.text, '你好')
  // 子进程响应回传（stdio data 行 → rpc client 配对 → invoke result）
  cli.emitData(JSON.stringify({ id: req.id, result: { ok: true, sessionId: 's-1' } }) + '\n')
  const res = await p
  assert.equal(res.ok, true)
  assert.equal(res.result.ok, true)
  assert.equal(res.result.sessionId, 's-1')
})
```

> 注：`startCli('agent-core')` 在 buildApp 装配内 `if (createCli)` 分支自动执行（publishState started → connectAgentCore 同步建立 transport）。launcher 窗口（capabilities 无 `session`）对 `session.send` 的拒绝路径由测试 1 覆盖。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd harness && node --test "src/**/*.test.mjs"`
Expected: PASS（main.test 更新后全绿；agent-bridge 用例删除后总数相应减 1）

- [ ] **Step 5: Commit**

```bash
git rm harness/src/kernel/agent-bridge.cjs harness/src/kernel/agent-bridge.test.mjs
git add harness/src/main.cjs harness/src/main.test.mjs harness/src/kernel/module-registry.cjs
git commit -m "feat(p3): 宿主装配 agent-core — session.* RPC 注册 + chat capabilities 翻转 + 退役 P1 agent-bridge"
```

---

### Task 6: chat 模块切换 session.* + 渲染契约对齐真实 kernel NDJSON（events.ts 重写）

**Files:**
- Modify: `modules/chat/src/events.ts`（**整体重写**：reduceEvents 按真实契约聚合流式 assistant 块——范围调整 7）
- Modify: `modules/chat/src/App.tsx`（on('agent.event') → on('session.event') + 解包 env.params?.event；call('agent.send') → call('session.send')，去掉 `.then(busy:false)`）
- Modify: `modules/chat/module.json`（capabilities `['system.window','agent']` → `['system.window','session']`）
- Test: `modules/chat/src/App.test.mjs`（fixtures 从 `data.text` 改为真实 kernel 事件 shape）

**Interfaces:**
- Consumes: Task 5 宿主 `session.*` RPC 与 `session.event` 推送（`params: { sessionId, event }`，event = 原样 kernel NDJSON 事件）
- Produces: chat UI 全链路 JSON-RPC（session.send → agent-core → kernel），流式 assistant 文本逐块聚合显示
- 权威 shape：kernel/protocol.mjs —— assistant `{ type:'assistant', message:{role:'assistant', content:[{type:'text',text}|{type:'thinking',thinking}|{type:'tool_use',…}]} }`（流式逐块，无 uuid 无 data.text）；result `{ type:'result', usage }`；user 消息不出 stdout 事件（UI 发送时乐观追加）

- [ ] **Step 1: 读现状**

Run: `cat modules/chat/module.json && cat modules/chat/src/events.ts && cat modules/chat/src/App.tsx`
Expected: module.json capabilities 含 `"agent"`；events.ts `reduceEvents` 读 `ev?.data`；App.tsx `on('agent.event')`/`call('agent.send')`。

- [ ] **Step 2: 写失败测试（重写 App.test.mjs 为真实契约 fixtures）**

Replace `modules/chat/src/App.test.mjs` 全文：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceEvents } from './events.ts'

const S = { msgs: [], busy: false }
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

test('reduceEvents 把流式 assistant 文本块聚合为单条消息（busy 窗口内合并）', () => {
  let s = reduceEvents(S, assistant('收'))
  s = reduceEvents(s, assistant('到'))
  assert.equal(s.msgs.length, 1)
  assert.equal(s.msgs[0].role, 'assistant')
  assert.equal(s.msgs[0].text, '收到')
  assert.equal(s.busy, true, 'assistant 事件应置 busy')
})

test('thinking/tool_use 纯块不渲染；result 闭轮清 busy', () => {
  let s = reduceEvents(S, assistant('你好'))
  const th = reduceEvents(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想一下' }] } })
  assert.deepEqual(th.msgs, s.msgs, 'thinking 块不应新增消息')
  const tool = reduceEvents(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] } })
  assert.deepEqual(tool.msgs, s.msgs, 'tool_use 块不应新增消息（v1 不渲染）')
  const done = reduceEvents(s, { type: 'result', usage: {} })
  assert.equal(done.busy, false)
  assert.equal(done.msgs.length, 1)
})

test('result 后新一轮首个文本块另起新消息（不并入上轮）', () => {
  let s = reduceEvents(S, assistant('第一轮'))
  s = reduceEvents(s, { type: 'result', usage: {} })
  s = reduceEvents(s, assistant('第二轮'))
  assert.equal(s.msgs.length, 2)
  assert.equal(s.msgs[1].text, '第二轮')
  assert.equal(s.msgs[0].text, '第一轮')
})
```

Run: `cd modules/chat && node --test src/App.test.mjs`
Expected: FAIL — 旧 events.ts 读 `ev.data.text`，新 fixtures 无 data → assistant 不产出消息（msgs.length 断言不满足）。

- [ ] **Step 3: 实现 events.ts 重写 + App.tsx + module.json**

Replace `modules/chat/src/events.ts` 全文：

```ts
// Chat 模块的纯逻辑（与 React 解耦，便于 node --test 直接加载）。
// 渲染契约（权威：kernel/protocol.mjs makeWire + docs/bridge-contract.md §4）：
//   assistant 事件为流式逐块：{ type:'assistant', message:{ role:'assistant',
//     content:[{type:'text',text}|{type:'thinking',thinking}|{type:'tool_use',…}] } }
//   result 事件闭轮：{ type:'result', usage }
// 策略：text 块累积进当前 assistant 气泡（busy 窗口内合并 → 单条消息呈现整段流式文本），
//   result 清 busy 闭轮；thinking/tool_use 纯块不渲染（v1）；user 消息由 UI 发送时乐观追加，
//   内核不在 stdout 回显 user 事件。

export interface Msg { role: 'user' | 'assistant' | 'tool'; text: string; ts: number }

export interface ChatState { msgs: Msg[]; busy: boolean }

const textOf = (ev: any): string =>
  (ev?.message?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('')

export function reduceEvents(state: ChatState, ev: any): ChatState {
  const t = ev?.type
  if (t === 'assistant') {
    const text = textOf(ev)
    if (!text) return state // thinking/tool_use 纯块：v1 不渲染
    const last = state.msgs[state.msgs.length - 1]
    if (state.busy && last?.role === 'assistant') {
      return { ...state, msgs: [...state.msgs.slice(0, -1), { ...last, text: last.text + text }] }
    }
    return { ...state, msgs: [...state.msgs, { role: 'assistant', text, ts: Date.now() }], busy: true }
  }
  if (t === 'result') return { ...state, busy: false }
  return state
}
```

Edit `modules/chat/src/App.tsx`（2 处精确替换）：

Edit 1（事件订阅：通道换 session.event，env.params 解包出 event）：
```tsx
// old:    const off = window.ponosRpc?.on('agent.event', (env) => setState(s => reduceEvents(s, env.params)))
// new:
    const off = window.ponosRpc?.on('session.event', (env) => setState(s => reduceEvents(s, env.params?.event)))
```

Edit 2（发送：agent.send → session.send；busy 由 result 事件闭环，不再立即复位）：
```tsx
// old:    window.ponosRpc?.call('agent.send', { text: input }).then(() => setState(s => ({ ...s, busy: false })))
// new:
    window.ponosRpc?.call('session.send', { text: input }).catch(() => { /* NOT_RUNNING 等拒绝：busy 由 result 事件兜底 */ })
```

Edit `modules/chat/module.json`：capabilities 数组替换为 `["system.window", "session"]`（与 Task 5 已翻的 registry 条目对齐）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd modules/chat && node --test src/App.test.mjs`
Expected: PASS（3 用例：聚合/纯块跳过/轮次隔离）。

- [ ] **Step 5: Commit**

```bash
git add modules/chat/src/events.ts modules/chat/src/App.tsx modules/chat/module.json modules/chat/src/App.test.mjs
git commit -m "feat(p3): chat 渲染契约对齐真实 kernel NDJSON（流式块聚合）+ 切 session.* 通道"
```

---

### Task 7: launcher 过滤无 UI 模块 + echo-demo 外部程序示例

**Files:**
- Modify: `modules/launcher/src/launchable.ts`（ModuleItem 扩展 runtime/entry；pickLaunchable 过滤 runtime 非 ui-renderer / 无 entry.ui）
- Modify: `modules/launcher/src/App.test.mjs`（**launcher 无独立 launchable.test.mjs——测试在 App.test.mjs**；既有单测 fixture 无 entry.ui，新过滤下会滤掉 chat，必须同 Step 重写）
- Create: `modules/echo-demo/module.json`、`modules/echo-demo/main.py`、`modules/echo-demo/package.json`
- Test: `modules/echo-demo/demo.test.mjs`（node spawn python e2e）

**Interfaces:**
- Consumes: Task 3 registry（echo-demo 条目）；listModules 返回的模块条目（runtime 字段：ui-renderer 缺省即无 runtime；node-worker/cli-bridge 有 runtime；entry.ui 仅窗口模块有）
- Produces: launcher 只列出可开窗模块（state-manager/agent-core/echo-demo 不出现）；echo-demo 子进程可被宿主 startCli 启动并响应 RPC

- [ ] **Step 1: 写失败测试（重写 App.test.mjs）**

Replace `modules/launcher/src/App.test.mjs` 全文（既有 fixture 无 entry.ui → 新过滤下 chat 也会被滤掉，旧断言必红；顺带新增后台模块过滤用例）：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickLaunchable } from './launchable.ts'

test('pickLaunchable 过滤掉 launcher 自身并保留可开窗模块', () => {
  const mods = [
    { id: 'launcher', name: '启动台', runtime: 'ui-renderer', entry: { ui: 'a.html' } },
    { id: 'chat', name: '聊天', entry: { ui: 'b.html' } }, // ui-renderer 缺省 runtime（registry 语义）
  ]
  const list = pickLaunchable(mods as any)
  assert.deepEqual(list.map(m => m.id), ['chat'])
})

test('pickLaunchable 过滤非 ui-renderer 模块（cli-bridge/node-worker 不进启动台）', () => {
  const mods = [
    { id: 'launcher', name: '启动台', runtime: 'ui-renderer', entry: { ui: 'a.html' } },
    { id: 'chat', name: '聊天', entry: { ui: 'b.html' } },
    { id: 'state-manager', name: '状态服务', runtime: 'node-worker', entry: { main: 'c.cjs' } },
    { id: 'agent-core', name: 'Agent 内核', runtime: 'cli-bridge', entry: { main: 'd.cjs' } },
    { id: 'echo-demo', name: '外部程序示例', runtime: 'cli-bridge', entry: { main: 'e.py' } },
  ]
  const picked = pickLaunchable(mods as any)
  assert.deepEqual(picked.map(m => m.id), ['chat'])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd modules/launcher && node --test src/App.test.mjs`
Expected: FAIL — 旧 pickLaunchable 只滤 launcher：用例 1 返回 chat（旧 fixture 无 entry.ui 的断言已被替换，不影响失败判定）；用例 2 返回 launcher/chat/state-manager/agent-core/echo-demo 共 5 项 ≠ ['chat']。

- [ ] **Step 3: 实现过滤**

Edit `modules/launcher/src/launchable.ts`:

```ts
export interface ModuleItem { id: string; name: string; icon?: string; runtime?: string; entry?: { ui?: string; main?: string } }

export function pickLaunchable(mods: ModuleItem[]): ModuleItem[] {
  // 仅 ui-renderer（有 ui 入口）模块可开窗；runtime 缺省视为 ui-renderer（registry 内置窗口模块语义）；
  // node-worker/cli-bridge 后台模块不进启动台
  return mods.filter(m => m.id !== 'launcher' && !(m.runtime && m.runtime !== 'ui-renderer') && !!m.entry?.ui)
}
```

- [ ] **Step 4: 实现 echo-demo Python 外部程序**

Create `modules/echo-demo/module.json`:

```json
{
  "id": "echo-demo",
  "name": "外部程序示例",
  "version": "0.1.0",
  "icon": "terminal",
  "runtime": "cli-bridge",
  "singleton": true,
  "capabilities": [],
  "entry": { "main": "modules/echo-demo/main.py" }
}
```

Create `modules/echo-demo/main.py`（stdio NDJSON RPC 服务：echo 文本 + time 时间戳 + add 求和。响应统一为 `{ id, result }`（result 含 ok 字段）——与 agent-core 子进程一致，宿主 createRpcClient 零特判）：

```python
# 外部程序注册为标准模块的最小示例（cli-bridge 运行时）：
# stdin 每行 JSON {id, method, params} → stdout 响应 {id, result:{ok,...}}；无 id 消息忽略。
# 纯标准库，无第三方依赖。
import json
import sys
import time


def handle(method, params):
    if method == "echo.echo":
        return {"ok": True, "text": params.get("text", "")}
    if method == "echo.time":
        return {"ok": True, "time": int(time.time())}
    if method == "echo.add":
        return {"ok": True, "sum": int(params.get("a", 0)) + int(params.get("b", 0))}
    return {"ok": False, "error": "METHOD_NOT_FOUND"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        if req.get("id") is None:
            continue
        res = handle(req.get("method"), req.get("params") or {})
        out = {"ok": True, "result": res} if res.get("ok") else {"ok": False, "error": res.get("error")}
        sys.stdout.write(json.dumps({"id": req["id"], "result": out}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
```

Create `modules/echo-demo/package.json`:

```json
{
  "name": "@ponos/echo-demo",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "node --test demo.test.mjs" }
}
```

- [ ] **Step 5: e2e 冒烟测试（node spawn python）**

Create `modules/echo-demo/demo.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('echo-demo 可 spawn 并响应 RPC（e2e，环境无 python 则跳过）', async () => {
  const child = spawn('python', [path.join(__dirname, 'main.py')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => { out += d.toString() })
  await new Promise((resolve, reject) => {
    child.stderr.on('data', d => reject(new Error('stderr: ' + d)))
    child.on('error', () => { resolve('SKIP') })  // python 不存在 → 标记跳过
    const timer = setTimeout(() => resolve('READY'), 1500)
    child.on('spawn', () => { clearTimeout(timer); resolve('READY') })
  }).then(async status => {
    if (status !== 'READY') { console.log('SKIP: python 不可用'); child.kill(); return }
    const got = new Promise(res => { const probe = setInterval(() => { const i = out.indexOf('\n'); if (i !== -1) { clearInterval(probe); res(JSON.parse(out.slice(0, i))) } }, 50) })
    child.stdin.write(JSON.stringify({ id: 1, method: 'echo.echo', params: { text: '你好' } }) + '\n')
    const msg = await got
    assert.equal(msg.result.ok, true)
    assert.equal(msg.result.result.text, '你好')
    child.kill()
  })
})
```

> 若 python 命令在目标机为 python3 或缺失，测试将输出 SKIP 而 pass（环境探测属测试基建，非产品断言）。

- [ ] **Step 6: 运行全部模块测试**

Run: `cd modules/launcher && node --test src/App.test.mjs && cd ../echo-demo && node --test demo.test.mjs`
Expected: PASS（launcher 过滤 2 用例；echo-demo e2e 通过或 SKIP）

- [ ] **Step 7: Commit**

```bash
git add modules/launcher/src/launchable.ts modules/launcher/src/App.test.mjs modules/echo-demo/
git commit -m "feat(p3): launcher 过滤后台模块 + echo-demo Python 外部程序示例（cli-bridge RPC 服务）"
```

---

### Task 8: 收尾 — 回归、退役注记、dev build 同步、冒烟

**Files:**
- Modify: `server/bridge.mjs`（仅文件头注释加退役注记——不加代码改动）
- Modify: `docs/bridge-contract.md`（补 P3 变化说明节）
- Modify: `docs/superpowers/plans/2026-09-02-ponos-modular-platform-p3.md`（勾选完成的 checkbox）
- 同步：`release/Ponos-dev-3.0.0/harness/src/`（main.cjs、rpc/transports/stdio-transport.cjs、kernel/rpc-client.cjs、process-orchestrator.cjs、module-registry.cjs）、`release/Ponos-dev-3.0.0/harness/src/kernel/`（agent-bridge.cjs 删除）、`release/Ponos-dev-3.0.0/modules/`（agent-core、echo-demo 全量新建）、`release/Ponos-dev-3.0.0/modules/chat/`（src/events.ts、src/App.tsx、module.json）、`release/Ponos-dev-3.0.0/modules/launcher/src/launchable.ts`；`diff` 校验一致（不含测试文件——dev build 只带运行产物）

**Interfaces:**
- Consumes: Task 1-7 全部产物

- [x] **Step 1: 全量回归**

Run:
```bash
cd harness && node --test "src/**/*.test.mjs" && cd ../modules/agent-core && node --test core.test.mjs && cd ../echo-demo && node --test demo.test.mjs && cd ../chat && node --test src/App.test.mjs && cd ../launcher && node --test src/App.test.mjs
```
Expected: 全 PASS（harness 全套 + agent-core 5 + echo-demo e2e 通过/SKIP + chat 3 + launcher 2）

- [x] **Step 2: bridge.mjs 退役注记**

Edit `server/bridge.mjs` 文件头注释顶部追加：

```js
// P3 注记：会话语义已按 cli-bridge 协议在 modules/agent-core 落地（session.send/cancel/status，
// harness/src/main.cjs 装配）；本文件 HTTP/WS 端点保留运行，支撑旧 GUI 冻结基线，
// 会话逻辑迁移源（getOrCreateSession/findPonos/cancel/回收）在 Phase 5 旧 GUI 退役期整体下线。
```

- [x] **Step 3: bridge-contract 补 P3 说明**

Edit `docs/bridge-contract.md`：新增小节「P3 模块化（2026-09-02）：agent-core cli-bridge 会话契约」——引用本文档 §2 spawn 参数/§3-4 NDJSON 语义作为 agent-core wrapper 的权威契约来源；记录宿主 `session.*` RPC 与 `session.event` 推送 shape；注明 bridge.mjs 端点退役排期（Phase 5）。

- [x] **Step 4: 同步 dev build**

Run: 复制 Task 1-7 变更文件到 `release/Ponos-dev-3.0.0/` 对应路径（harness/src/、modules/agent-core/、modules/echo-demo/、modules/chat/src/App.tsx、modules/chat/module.json、modules/launcher/src/launchable.ts）；`rm release/Ponos-dev-3.0.0/harness/src/kernel/agent-bridge.cjs`（如存在）；`diff` 校验一致性。

- [x] **Step 5: dev build 冒烟（需重启实例）**

按 P2 已验证流程：dev build 启动 → launcher 不含 agent-core/echo-demo/state-manager → 打开 chat → 发送消息 → 收到 assistant 回复（agent-core 经 orchestrator startCli 自动连接；可 CDP 9334 检查 `session.status` 返回 busy 状态）。冒烟清单：
1. launcher 列表仅 chat/settings（无后台模块按钮）
2. chat 发「你好」→ 回复文本**逐块聚合为一条 assistant 气泡**出现（流式期间 busy 置位、result 后复位；发送按钮在轮次中禁用）
3. `system.discover` 含 session.send/session.cancel/session.status
4. 关闭重启后无 NOT_RUNNING 报错（startCli 在装配自动执行）
5. agent-core 子进程退出（kill）→ orchestrator respawn 后 chat 再次发消息仍可达（新 session_id，无断流）

- [x] **Step 6: Commit**

```bash
git add server/bridge.mjs docs/bridge-contract.md docs/superpowers/plans/2026-09-02-ponos-modular-platform-p3.md
git commit -m "docs(p3): bridge.mjs 会话逻辑退役注记 + bridge-contract 补 agent-core cli-bridge 契约 + plan 勾选"
```

---

## Self-Review 记录

细化过程中对照 spec §10 Phase 3 与权威契约自查并就地修复（20+ 处），要点：

1. **真实 NDJSON 契约核验**：读 `kernel/protocol.mjs` / `kernel/cli.mjs` / `kernel/engine.mjs` / `server/bridge.mjs:2295` / `docs/bridge-contract.md`，确认 stdin user 行 `{type:'user', message:{role:'user',content}}`、assistant 为流式逐块 `message.content[]`（无 `data.text`/无 uuid）、result 闭轮 → 新增范围调整 7，Task 6 events.ts 整体重写为块聚合（textOf + busy 窗口合并 + 轮次隔离），App.test.mjs fixtures 换真实 shape。
2. **child_process 崩溃语义**：worker_threads 崩溃发 'error'，child_process 真实崩溃是 exit(code≠0)（'error' 仅 spawn 失败）→ Task 3 orchestrator 与 Task 4 core.cjs 均改为 error + exit(≠0) 触发 500ms respawn、exit(0) 优雅清理，测试补齐 error/exit(1)/exit(0) 三态用例。
3. **TDD 提交点保绿冲突消除**：chat capabilities 翻转从 Task 3 移到 Task 5（与 main.test.mjs 重写同提交，避免 Task 3 点 main.test 测试 2 红）；registry 测试 import 补 `getModule`；launcher 无独立 launchable.test.mjs、既有 App.test.mjs fixture 无 entry.ui → Task 7 改为重写 App.test.mjs。
4. **签名/引用一致性**：`createStateManagerClient → createRpcClient` 全 plan 统一；Task 5 从 buildApp 签名移除 kernelArgs（真实装配无注入）、真实 createCli 直接 spawn('node', ...)；session.status 返回字段 busy/firstTokenAt/sessionId 跨 Task 3/4/5/6 一致；Task 8 同步清单含 chat/src/events.ts（Task 6 产物）。
5. **数字引用更新**：Task 4 测试扩至 5 个后，Task 4 Step 4 Expected 与 Task 8 回归计数同步（5 用例）。
6. **执行边界裁决**：范围调整 1-7 已写入计划头部——bridge.mjs 收敛推迟 P5、单默认会话、session.* 切换、src/ 渲染收敛不做、rpc-client 更名、崩溃 respawn 语义、chat 渲染契约修正。执行期间如与大纲冲突，以本文件为准。
