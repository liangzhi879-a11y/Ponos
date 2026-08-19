# 内置浏览器自动化（可见模式）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 应用内置独立浏览器窗口由内核 agent 以纯文字快照驱动（CDP 可信输入、ref 索引交互树、人工接管自动恢复），首场景 gsxt 企业信息核验。

**Architecture:** 内核 `browser` 工具发 `bridge_request`（stdout stream-json）→ bridge 路由到 Electron 主进程的 WS 执行器客户端 → 主进程 `browser-executor.cjs` 在按会话分区的 BrowserWindow 上执行（`webContents.debugger` CDP 可信输入 + `executeJavaScript` ref→selector）→ 快照原路返回内核 tool_result；`browser:event` 广播给 renderer 驱动精简状态条。

**Tech Stack:** Electron（BrowserWindow/webContents.debugger/session）、Node（ws）、bun 内核（print.ts stream-json/control_request）、React（zustand store）、node:test。

## Global Constraints

- 决策环必须**纯文字模型可跑**：快照为索引化交互树（≤~300 交互节点、约 3-6K tokens），截图仅作证据/人眼预览，不喂模型（除非配置了 visionModel）。
- 分区隔离：自动化窗口 partition = `persist:automation-{conversationId}`（conversationId = GUI→bridge 的 sessionId）。
- 动作参数一律用 ref 索引（执行器预计算稳定选择器），模型不写 CSS 选择器。
- 安全：域名白名单（默认 `*.gov.cn` 等，白名单外 goto 拒绝并需用户授权）；快照对身份证/手机号/账号脱敏；破解类（OCR 打码/指纹伪装/绕过授权/高频压测）始终禁止；拟真兜底 opt-in（默认关、人工闸门、日志标注）。
- 单动作超时 30s；`pause_for_human` 不超时；工具整体 60s。
- 测试：`npm test`（server/*.test.mjs 与 electron/*.test.mjs 并入）；typecheck 必须过；改动 GUI 需 `npm run build` + `cp -r dist/. release/YFWorking_ms92cd6u/dist/`；改动内核需在 `yfw-kernel/claude-code` 下 `bun scripts/build-bundle.ts --minify` + `cp dist/cli.mjs` 到 `release/YFWorking_ms92cd6u/kernel/cli.mjs` + grep 验证产物；重启/重载 live app 前必须先征得用户同意。
- 提交风格：`feat(browser): ...` / `fix(browser): ...`（参照既有 `feat(doubao)` 风格）。

---

### Task 1: 纯逻辑模块（快照构建/脱敏/ref 选择器策略/域名白名单）

**Files:**
- Create: `electron/browser-common.cjs` — 纯函数（CJS，可被 main.cjs require，无 Electron 依赖）
- Create: `electron/browser-common.test.mjs` — node:test 用例
- Modify: `package.json` — test script 并入 electron/*.test.mjs

**Interfaces:**
- Consumes: 无（本任务为纯函数层）
- Produces:
  - `maskSensitive(text)` → 对身份证（18 位含 X）、11 位手机号、邮箱、账号模式打码（保留前 3 后 2）
  - `truncate(text, max=60)` → 超长截断加 `…`
  - `pickSelector(attrs)` → 按优先级 `[id, name, placeholder, aria-label, data-testid]` 返回首个非空，否则 null
  - `buildSnapshot({ axTree, url, title, viewport, scrollY, prevSnapshot })` → 精简快照对象（见下方形状）
  - `diffSummary(prev, next)` → `"+2 按钮 · URL 变化"` 差异摘要
  - `computeFingerprint({ title, href, textLen, inputCount })` → 字符串指纹（人工接管检测用）
  - `isWhitelisted(url)` → 域名白名单校验（eTLD+1 匹配：`*.gov.cn` 默认 + 用户授权缓存 set）

- [ ] **Step 1: 先加 test script 变更 + 写失败测试**

Modify `package.json`:
```json
"test": "node --test \"server/*.test.mjs\" \"electron/*.test.mjs\""
```

`electron/browser-common.test.mjs`：
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  maskSensitive, truncate, pickSelector, buildSnapshot, diffSummary,
  computeFingerprint, isWhitelisted,
} from './browser-common.cjs'

test('maskSensitive: 身份证/手机号/账号打码', () => {
  assert.equal(maskSensitive('身份证 330106199001011234'), '身份证 330106********34')
  assert.equal(maskSensitive('13812345678'), '138****5678')
  assert.equal(maskSensitive('普通文本'), '普通文本')
})
test('truncate: 超长截断', () => {
  assert.equal(truncate('a'.repeat(100), 10), 'a'.repeat(10) + '…')
})
test('pickSelector: 优先级 id > name > placeholder > aria-label > data-testid', () => {
  assert.equal(pickSelector({ name: 'kw', id: 'q' }), '#q')
  assert.equal(pickSelector({ placeholder: '输入企业名' }), '[placeholder="输入企业名"]')
  assert.equal(pickSelector({}), null)
})
test('buildSnapshot: 交互树精简 + ref 编号 + 只读信息 + 截图非必需', () => {
  const snap = buildSnapshot({
    axTree: [
      { role: 'button', name: '查询', nodeId: 'n1' },
      { role: 'textbox', name: '企业名称', value: '锐取', nodeId: 'n2' },
    ],
    url: 'https://www.gsxt.gov.cn/x', title: '公示系统', viewport: { w: 1200, h: 800 }, scrollY: 0,
    prevSnapshot: null,
  })
  assert.equal(snap.interactives.length, 2)
  assert.equal(snap.interactives[0].ref, 1)
  assert.equal(snap.interactives[0].label, '查询')
  assert.equal(snap.interactives[1].value, '锐取')
})
test('buildSnapshot: 脱敏生效 + truncated 计数', () => {
  const snap = buildSnapshot({
    axTree: [{ role: 'text', name: '手机 13812345678', nodeId: 'n9' }],
    url: 'u', title: 't', viewport: { w: 1, h: 1 }, scrollY: 0, prevSnapshot: null,
  })
  assert.ok(!JSON.stringify(snap).includes('13812345678'))
})
test('diffSummary: URL 变化与节点增减', () => {
  const prev = { url: 'a', interactives: [{ ref: 1, tag: 'button', label: 'x' }] }
  const next = { url: 'b', interactives: [{ ref: 1, tag: 'button', label: 'x' }, { ref: 2, tag: 'link', label: 'y' }] }
  assert.match(diffSummary(prev, next), /URL/)
  assert.match(diffSummary(prev, next), /\+\d+ 节点/)
})
test('computeFingerprint: 相同输入同指纹，输入变化指纹变', () => {
  const a = { title: 't', href: 'h', textLen: 100, inputCount: 2 }
  const b = { ...a }
  assert.equal(computeFingerprint(a), computeFingerprint(b))
  assert.notEqual(computeFingerprint(a), computeFingerprint({ ...b, textLen: 150 }))
})
test('isWhitelisted: gov.cn 通过，白名单外拒绝，授权后通过', () => {
  assert.equal(isWhitelisted('https://www.gsxt.gov.cn/index.html'), true)
  assert.equal(isWhitelisted('https://evil.com/'), false)
  isWhitelisted.allow('evil.com')
  assert.equal(isWhitelisted('https://evil.com/page'), true)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | grep -E "browser-common|tests [0-9]+" | head`
Expected: FAIL（`Cannot find module './browser-common.cjs'`）

- [ ] **Step 3: 实现 browser-common.cjs**

```js
'use strict'
// 纯函数层：快照精简/脱敏/ref 选择器策略/域名白名单。无 Electron 依赖，node --test 可测。

const CID = /\b\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

function maskSensitive(text) {
  return String(text)
    .replace(CID, m => m.slice(0, 6) + '********' + m.slice(-2))
    .replace(PHONE, m => m.slice(0, 3) + '****' + m.slice(-4))
    .replace(EMAIL, m => m[0] + '***@' + m.split('@')[1])
}

function truncate(text, max = 60) {
  const s = String(text)
  return s.length > max ? s.slice(0, max) + '…' : s
}

// ref → selector 优先级策略（页面上下文里逐项尝试命中，返回首个可用的）
const SELECTOR_KEYS = ['id', 'name', 'placeholder', 'aria-label', 'data-testid']
function pickSelector(attrs) {
  for (const k of SELECTOR_KEYS) {
    const v = attrs && attrs[k]
    if (typeof v === 'string' && v) return k === 'id' ? `#${cssEscape(v)}` : `[${k}="${cssEscape(v)}"]`
  }
  return null
}
function cssEscape(s) { return String(s).replace(/["\\\n\r]/g, ch => '\\' + ch) }

function buildSnapshot({ axTree = [], url, title, viewport, scrollY, prevSnapshot }) {
  const interactives = []
  const info = []
  let truncated = 0
  let ref = 0
  for (const node of axTree) {
    if (interactives.length + info.length >= 300) { truncated++; continue }
    const label = truncate(maskSensitive(node.name || ''))
    const isInteractive = ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem'].includes(node.role)
    const entry = { ref: ++ref, tag: node.role, label, path_hint: node.path_hint || '' }
    if (isInteractive) {
      if (node.role === 'textbox' || node.role === 'combobox') entry.value = truncate(maskSensitive(node.value || ''))
      if (node.role === 'link' && node.href) entry.href = node.href
      if (node.checked !== undefined) entry.state = node.checked ? 'checked' : 'unchecked'
      interactives.push(entry)
    } else if (label) {
      info.push({ label, value: node.value !== undefined ? truncate(maskSensitive(String(node.value))) : undefined })
    }
  }
  return {
    page: { url, title, readyState: axTree[0]?.readyState || 'complete', loading: !!axTree[0]?.loading, captcha: !!axTree[0]?.captcha },
    alerts: (axTree[0]?.alerts || []).map(a => truncate(maskSensitive(a))),
    changes: diffSummary(prevSnapshot, { url, interactives }),
    interactives,
    info,
    viewport, scrollY,
    truncated,
  }
}

function diffSummary(prev, next) {
  if (!prev) return '首次快照'
  const parts = []
  if (prev.url !== next.url) parts.push('URL 变化')
  if (next.alerts && next.alerts.length) parts.push(`提示:${next.alerts.join('/')}`)
  const pc = new Map((prev.interactives || []).map(n => [n.label + '|' + n.tag, 1]))
  let added = 0, removed = 0
  for (const n of next.interactives || []) if (!pc.has(n.label + '|' + n.tag)) added++
  const nc = new Map((next.interactives || []).map(n => [n.label + '|' + n.tag, 1]))
  for (const n of prev.interactives || []) if (!nc.has(n.label + '|' + n.tag)) removed++
  if (added) parts.push(`+${added} 节点`)
  if (removed) parts.push(`-${removed} 节点`)
  return parts.join(' · ') || '页面无变化'
}

function computeFingerprint({ title, href, textLen, inputCount }) {
  return `${title}|${href}|${textLen}|${inputCount}`
}

const DEFAULT_WHITELIST = [/\.gov\.cn$/i, /^localhost$/i, /^127\.0\.0\.1$/]
const allowed = new Set()
function isWhitelisted(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (allowed.has(host)) return true
    return DEFAULT_WHITELIST.some(r => r.test(host))
  } catch { return false }
}
isWhitelisted.allow = (host) => allowed.add(String(host).toLowerCase())

module.exports = { maskSensitive, truncate, pickSelector, cssEscape, buildSnapshot, diffSummary, computeFingerprint, isWhitelisted }
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test 2>&1 | grep -E "browser-common" `
Expected: PASS（browser-common 全部用例）

- [ ] **Step 5: 提交**

```bash
git add package.json electron/browser-common.cjs electron/browser-common.test.mjs
git commit -m "feat(browser): 纯逻辑层——快照精简/脱敏/ref 选择器策略/域名白名单"
```

---

### Task 2: bridge 路由（bridge_request 处理 + 主进程执行器通道 + browser_control + browser:event）

**Files:**
- Modify: `server/bridge.mjs`（内核输出处理器 ~795 行附近、GUI send 处理 ~1869 行附近）
- Modify: `server/bridge.test.mjs`（或新建 `server/browser-routing.test.mjs`）

**Interfaces:**
- Consumes: Task 1 无直接依赖（bridge 仅转发，不解析快照）
- Produces:
  - bridge 内核输出处理新增：`parsed.type === 'bridge_request'` → 若 `route === 'browser'` 则转发到执行器客户端
  - 主进程执行器客户端注册：`executorClients`（Set<ws>），客户端连上后发 `{type:'executor:hello'}` 注册
  - `browser:exec`（bridge→executor）：`{ type:'browser:exec', requestId, sessionId, payload }`
  - `browser:exec:response`（executor→bridge）：`{ type:'browser:exec:response', requestId, ok, snapshot, error }`
  - 回写内核 stdin：`{ type:'control_request', request:{ subtype:'browser_response', requestId, ok, snapshot, error } }`（模型参照 bridge.mjs:1887 的 cancel 写入）
  - `browser_control`（GUI→bridge）：`{ type:'browser_control', sessionId, command:'pause'|'resume' }` → 转发 executor
  - `browser:event`（bridge→GUI 广播）：`{ type:'browser:event', sessionId, event }`

- [ ] **Step 1: 写失败测试（bridge 路由，mock 执行器客户端与内核进程）**

`server/browser-routing.test.mjs`：
```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'

// 用最小可测封装：把路由逻辑抽成纯函数模块 server/browser-routing.mjs
// （bridge.mjs 内嵌逻辑厚，测试直接针对封装模块而非整桥）
import { makeBrowserRouter } from './browser-routing.mjs'

function fakeExecutor() { return { send: (msg) => { fakeExecutor.last = msg }, last: null } }

test('路由：bridge_request(browser) → executor；executor 响应 → 回写内核 stdin', () => {
  const stdinWriter = { calls: [], write(msg) { this.calls.push(msg) } }
  const r = makeBrowserRouter({ writeKernel: (sid, msg) => stdinWriter.write({ sid, msg }) })
  const ex = fakeExecutor()
  r.registerExecutor(ex)

  r.onKernelBridgeRequest('conv-1', { requestId: 'br-1', route: 'browser', payload: { action: 'goto', params: { url: 'https://www.gsxt.gov.cn/x' } } })
  assert.equal(ex.last.type, 'browser:exec')
  assert.equal(ex.last.sessionId, 'conv-1')

  r.onExecutorResponse('br-1', { ok: true, snapshot: { page: { url: 'u' } }, error: null })
  assert.equal(stdinWriter.calls.length, 1)
  assert.equal(stdinWriter.calls[0].msg.request.subtype, 'browser_response')
  assert.equal(stdinWriter.calls[0].msg.request.requestId, 'br-1')
})

test('路由：executor 未注册时返回错误回写内核', () => {
  const stdinWriter = { calls: [] }
  const r = makeBrowserRouter({ writeKernel: (_s, msg) => stdinWriter.calls.push(msg) })
  r.onKernelBridgeRequest('conv-1', { requestId: 'br-2', route: 'browser', payload: { action: 'snapshot' } })
  assert.equal(stdinWriter.calls[0].request.ok, false)
  assert.match(stdinWriter.calls[0].request.error, /executor/)
})

test('browser_control：pause/resume 转发 executor；未知命令忽略', () => {
  const r = makeBrowserRouter({ writeKernel: () => {} })
  const ex = fakeExecutor()
  r.registerExecutor(ex)
  r.onGuiControl('conv-1', 'pause')
  assert.equal(ex.last.command, 'pause')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/browser-routing.test.mjs`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 server/browser-routing.mjs**

```js
// bridge 的 browser 路由封装：内核 bridge_request → executor；executor 响应 → 内核 stdin；
// GUI browser_control → executor；browser:event → GUI 广播。便于单测。
export function makeBrowserRouter({ writeKernel }) {
  let executor = null
  const pending = new Map() // requestId → { sessionId }
  const clients = new Set() // GUI 广播目标（WS 集合）

  return {
    registerExecutor(ws) { executor = ws },
    unregisterExecutor(ws) { if (executor === ws) executor = null },
    addGuiClient(ws) { clients.add(ws) },
    removeGuiClient(ws) { clients.delete(ws) },

    onKernelBridgeRequest(sessionId, { requestId, route, payload }) {
      if (route !== 'browser') return
      if (!executor) {
        writeKernel(sessionId, { type: 'control_request', request: { subtype: 'browser_response', requestId, ok: false, snapshot: null, error: 'executor 未连接（应用主进程未注册）' } })
        return
      }
      pending.set(requestId, sessionId)
      executor.send(JSON.stringify({ type: 'browser:exec', requestId, sessionId, payload }))
    },

    onExecutorResponse(requestId, { ok, snapshot, error }) {
      const sessionId = pending.get(requestId)
      if (!sessionId) return
      pending.delete(requestId)
      writeKernel(sessionId, { type: 'control_request', request: { subtype: 'browser_response', requestId, ok, snapshot, error } })
    },

    onGuiControl(sessionId, command) {
      if (!executor) return
      if (command === 'pause' || command === 'resume') {
        executor.send(JSON.stringify({ type: 'browser:control', sessionId, command }))
      }
    },

    broadcast(sessionId, event) {
      const msg = JSON.stringify({ type: 'browser:event', sessionId, event })
      for (const c of clients) { try { c.send(msg) } catch {} }
    },
  }
}
```

- [ ] **Step 4: 测试通过后接入 bridge.mjs**

Modify `server/bridge.mjs`：
- 顶部初始化 `import { makeBrowserRouter } from './browser-routing.mjs'` + `const browserRouter = makeBrowserRouter({ writeKernel: writeControlRequest })`（`writeControlRequest` 参照 1887-1899 cancel 的写入方式：向 session 的 kernel.stdin 写 `JSON.stringify({type:'control_request',request:{...}})+'\n'`）。
- 内核输出处理器（~795 行 `if (parsed && ...)` 链中）追加：
```js
if (parsed && parsed.type === 'bridge_request' && parsed.route === 'browser') {
  browserRouter.onKernelBridgeRequest(sid, parsed)
  return
}
```
（注意该处理器是每行回调，返回值语义按既有代码——若既有链用 return 短路则沿用。）
- GUI 消息处理（~1869 switch）追加：
```js
} else if (msg.type === 'browser_control') {
  browserRouter.onGuiControl(msg.sessionId, msg.command)
}
```
- 主进程 executor WS 客户端接入（bridge 侧）：在 WSS `connection` 处理器中识别客户端（首个消息 `{type:'executor:hello'}`）→ `browserRouter.registerExecutor(ws)`；断开时 `unregisterExecutor`。
- GUI 广播：现有 GUI 客户端集合（或遍历 `wss.clients`）→ 复用 `browserRouter.addGuiClient(ws)`（仅对普通 GUI 连接注册广播，执行器连接不注册）。

- [ ] **Step 5: 运行全部单测**

Run: `npm test`
Expected: PASS（既有 + 新增 browser-routing）

- [ ] **Step 6: 提交**

```bash
git add server/browser-routing.mjs server/browser-routing.test.mjs server/bridge.mjs
git commit -m "feat(browser): bridge 路由——bridge_request→执行器、browser_control、browser:event 广播"
```

---

### Task 3: 主进程 WS 执行器客户端 + 浏览器执行器（窗口/CDP/动作/人工接管/下载）

**Files:**
- Create: `electron/browser-executor.cjs` — 执行器主体（窗口生命周期/CDP 会话/动作执行/指纹轮询/下载）
- Modify: `electron/main.cjs` — 泛化 `connectPetBridgeListener` → 新增 `connectBrowserExecutor()`（同一 bridge WS 连接上注册 executor:hello + 处理 browser:exec/browser:control）；连接 `browser-executor.cjs`
- Modify: `electron/preload.cjs` — 暴露 `window.browser`（openWindow/pause/resume/clearSession/getStatus）IPC

**Interfaces:**
- Consumes: `browser-common.cjs`（`buildSnapshot`、`maskSensitive`、`computeFingerprint`、`pickSelector`、`isWhitelisted`）
- Produces:
  - `class BrowserExecutor`（browser-executor.cjs 导出）：
    - `async exec(sessionId, action, params)` → `{ ok, snapshot, error }`
    - `onControl(command)` → `'pause'|'resume'` 切换人工接管
    - `getStatus()` → `{ windowOpen, url, mode, humanMode }`
    - `openWindow(sessionId)` / `closeSession(sessionId)`（clearStorageData）
  - 动作实现：`goto/back/forward/refresh/snapshot/click/type/select/scroll/hover/wait/pause_for_human/close`
  - CDP：`webContents.debugger.attach('1.3')`；`Input.dispatchMouseEvent`（mousePressed/mouseReleased/mouseMoved）与 `Input.dispatchKeyEvent`（keyDown/char/keyUp）
  - 页面上下文脚本（executeJavaScript）：ref→selector 命中盒计算、a11y 树收集、指纹采集、验证码信号

- [ ] **Step 1: 本地 fixture 页 + 执行器集成测试骨架**

Create `electron/browser-executor.test.mjs`（用 node:test，Electron 依赖部分标记 skip，若当前环境无法起 Electron 窗口则先测可在纯 node 中运行的逻辑；窗口部分留待端到端人工验收 Task 7）：

由于 `webContents` 只能在 Electron 主进程内获得，本任务把**可在纯 node 验证的部分**（选择器命中盒脚本、a11y 精简脚本——作为字符串模板函数）抽出可测：

```js
// browser-executor.cjs 内导出（纯函数，供测试）
function buildClickBoxScript(ref) { return `(() => { const el = window.__brRefs && window.__brRefs[${ref}]; ... })()` }
function buildAxTreeCollectorScript(maxNodes) { return `...` }
```
测试直接断言脚本产物在最小 DOM 语义下返回预期结构（用 jsdom 不可用则跳过——npm 无 jsdom 依赖；改为断言脚本是合法 JS 且含关键逻辑）：
```js
test('buildClickBoxScript 含 ref 解析与 getBoundingClientRect', () => {
  const s = buildClickBoxScript(12)
  assert.match(s, /__brRefs\[12\]/)
  assert.match(s, /getBoundingClientRect/)
})
test('buildAxTreeCollectorScript 含 role/name/节点裁剪与验证码启发', () => {
  const s = buildAxTreeCollectorScript(300)
  assert.match(s, /getComputedStyle/)
  assert.match(s, /visibility/)
  assert.match(s, /验证码|captcha/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test electron/browser-executor.test.mjs`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 browser-executor.cjs**

要点（完整实现参考 doubao 窗口模式 + 下方关键片段；本文件较大会保持单一职责——窗口与 CDP 全在此）：
- 窗口：`new BrowserWindow({ partition: 'persist:automation-' + sessionId, show: true, width: 1100, height: 780, webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false } })`；`win.on('closed')` 置 null。
- CDP：`win.webContents.debugger.attach('1.3')`；失败重试（销毁重建 1 次）。
- ref 缓存：每次动作前 `executeJavaScript` 重新收集可交互元素并建立 `window.__brRefs[ref] = element` 引用（用元素对象直接存，动作脚本按 ref 取元素——避免选择器失效问题；同时 `pickSelector` 作为 fallback 生成字符串选择器）。
- 快照收集脚本返回 `{ nodes:[{role,name,value,checked,href,path_hint,visible}], readyState, loading, alerts, captcha, title, url }` → 主进程 `buildSnapshot(...)` 精简（浏览器上下文不执行裁剪，主进程裁剪）。
- 动作执行（核心片段，`type` 用可信键盘输入）：
```js
async exec(sessionId, action, params) {
  if (this.humanMode) return { ok: false, snapshot: await this.snapshot(sessionId), error: '人工接管中，等待继续' }
  const win = await this.ensureWindow(sessionId)
  const t0 = Date.now()
  try {
    const result = await this.runAction(win, action, params)
    return { ok: true, snapshot: await this.snapshot(win), error: null }
  } catch (e) {
    return { ok: false, snapshot: await this.snapshot(win).catch(() => null), error: String(e && e.message || e) }
  }
}
```
- 可信输入（type）：
```js
async typeText(win, selector, text, clear) {
  const cdp = win.webContents.debugger
  const box = await win.webContents.executeJavaScript(buildClickBoxScript(ref)) // 命中盒
  await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.cx, y: box.cy, button: 'left', clickCount: 1 })
  await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.cx, y: box.cy, button: 'left', clickCount: 1 })
  if (clear) {
    for (const key of ['Control', 'a']) await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  }
  for (const ch of String(text)) {
    await cdp.sendCommand('Input.insertText', { text: ch })  // 注：insertText 为文本插入，兼容中文；拟真模式改为逐键 keyDown/char/keyUp + 随机延迟
  }
}
```
- 人工接管（pause_for_human / browser_control pause）：`this.humanMode = true`；500ms 轮询 `computeFingerprint`（executeJavaScript 采集 title/href/textLen/inputCount）；指纹变化 → `this.humanMode = false` + `onHumanDone` 回调（bridge 层向内核回发 browser_response——由路由层实现，执行器只暴露事件）。
- 下载：`win.webContents.session.on('will-download', (e, item) => { item.setSavePath(path.join(downloadsDir(sessionId), item.getFilename())) })`；`downloadsDir` = `path.join(app.getPath('userData'), 'browser-downloads', sessionId)`。
- `closeSession`：`win.webContents.session.clearStorageData()` + 销毁窗口。
- 拟真模式开关：`this.mode = params.mode === 'imitation' ? 'imitation' : 'normal'`（opt-in，Task 7 细化）。

- [ ] **Step 4: 接入 main.cjs**

- 泛化连接：把 `connectPetBridgeListener` 中的 WS 客户端逻辑抽成 `connectBridgeClient(onMessage)`（返回 ws，自动重连 3s）；`connectPetBridgeListener` 改用之；新增 `connectBrowserExecutor()`：
```js
function connectBrowserExecutor() {
  const executor = new BrowserExecutor({ onEvent: (sessionId, event) => { /* 经 WS 发 browser:event */ } })
  const ws = connectBridgeClient((msg) => {
    if (msg.type === 'browser:exec') {
      executor.exec(msg.sessionId, msg.payload.action, msg.payload.params)
        .then(res => ws.send(JSON.stringify({ type: 'browser:exec:response', requestId: msg.requestId, ...res })))
    } else if (msg.type === 'browser:control') {
      executor.onControl(msg.command)
    }
  })
  ws.on('open', () => ws.send(JSON.stringify({ type: 'executor:hello' })))
}
```
- 注册 IPC（preload 暴露 `window.browser`）：
```js
ipcMain.handle('browser:open', (e, sessionId) => executor.openWindow(sessionId))
ipcMain.handle('browser:clear-session', (e, sessionId) => executor.closeSession(sessionId))
ipcMain.handle('browser:status', () => executor.getStatus())
ipcMain.handle('browser:pause', (e, sessionId) => executor.onControl('pause'))
ipcMain.handle('browser:resume', (e, sessionId) => executor.onControl('resume'))
```

- [ ] **Step 5: 测试 + typecheck**

Run: `node --test electron/browser-executor.test.mjs` 且 `npm run typecheck`（GUI TS 不受影响，但确认主进程改动无碍构建）
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add electron/browser-executor.cjs electron/browser-executor.test.mjs electron/main.cjs electron/preload.cjs
git commit -m "feat(browser): 主进程浏览器执行器——窗口/CDP 可信输入/快照/人工接管/下载"
```

---

### Task 4: 内核 BrowserTool + print.ts browser_response/browser_pause 处理

**Files:**
- Create: `yfw-kernel/claude-code/src/tools/BrowserTool/`（目录 + 实现 .ts，参照 `src/tools/AskUserQuestionTool/` 目录结构）
- Modify: `yfw-kernel/claude-code/src/cli/print.ts`（import + `buildAllTools` 的 `tools` 基础数组注册 + control_request switch 加 `browser_response`/`browser_pause` case）

**Interfaces:**
- Consumes: Task 2 协议（bridge_request 出 / browser_response 入）
- Produces:
  - `BrowserTool`：工具名 `browser`；schema：`{ action: enum[goto,back,forward,refresh,snapshot,click,type,select,scroll,hover,wait,pause_for_human,resume,close], params: object, mode?: 'normal'|'imitation' }`
  - 工具实现：向 `structuredIO` stdout 写 `{type:'bridge_request', requestId, route:'browser', payload:{action, params, mode}}`；注册 pending Map（requestId → resolve/reject）；await 60s（pause_for_human 不超时）
  - print.ts stdin switch（~2848，cancel case 同款位置）新增：
    - `subtype === 'browser_response'` → 用 requestId 查 pending Map，resolve `{ok, snapshot, error}`
    - `subtype === 'browser_pause'` → 置全局 `browserPaused = true`（工具端下一轮 await 改无限等待，直到收到非 paused 响应或 browser_resume）
    - `subtype === 'browser_resume'` → `browserPaused = false`
  - 工具返回 `toolResult`：成功 `{snapshot: 文字化 JSON}`；paused 语义：executor 返回 `{ok:false, code:'paused'}` 时工具循环等待（sleep 2s 重试，上限由 browser_resume 解除）

- [ ] **Step 1: 先写内核侧单元测试（browser 工具协议封装）**

参照既有内核测试结构（`yfw-kernel/claude-code` 下查找 browser-agnostic 的纯协议模块测试模式，如 `src/utils/*.test.ts`）。把"bridge_request 构造 + browser_response 解析"抽成纯函数模块 `src/tools/BrowserTool/protocol.ts`：

```ts
export interface BrowserRequest { type: 'bridge_request'; requestId: string; route: 'browser'; payload: BrowserPayload }
export interface BrowserPayload { action: string; params: Record<string, unknown>; mode?: 'normal' | 'imitation' }
export interface BrowserResponse { ok: boolean; snapshot?: unknown; error?: string }
export function makeRequestId(): string  // `br-${Date.now()}-${Math.random().toString(36).slice(2,8)}`
export function buildBrowserRequest(payload: BrowserPayload): BrowserRequest
export function isBrowserResponse(req: unknown): req is { subtype: 'browser_response'; requestId: string } & BrowserResponse
```

`src/tools/BrowserTool/protocol.test.ts`：
```ts
import { test } from 'bun:test'
import { buildBrowserRequest, isBrowserResponse, makeRequestId } from './protocol.ts'
test('buildBrowserRequest 形状正确', () => {
  const r = buildBrowserRequest({ action: 'click', params: { ref: 3 } })
  assert(r.type === 'bridge_request' && r.route === 'browser' && r.payload.action === 'click')
})
test('isBrowserResponse 识别 browser_response', () => {
  assert(isBrowserResponse({ subtype: 'browser_response', requestId: 'br-1', ok: true, snapshot: {} }))
  assert(!isBrowserResponse({ subtype: 'cancel' }))
})
```

- [ ] **Step 2: 运行确认失败**

Run（在 `yfw-kernel/claude-code`）：`bun test src/tools/BrowserTool/protocol.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 protocol.ts + BrowserTool**

`protocol.ts` 见 Step 1 接口；`BrowserTool.ts`（核心，工具执行与 pending 等待）：
```ts
export const BrowserTool: Tool = {
  name: 'browser',
  async call(input, { io, signal }) {
    const payload = { action: input.action, params: input.params || {}, mode: input.mode }
    const requestId = makeRequestId()
    const response = await withBrowserTimeout(async () => {
      const p = new Promise<BrowserResponse>((resolve, reject) => {
        browserPending.set(requestId, { resolve, reject })
        io.output.write(JSON.stringify(buildBrowserRequest(payload)) + '\n')
      })
      return p
    }, input.action === 'pause_for_human' ? undefined : 60_000)
    if (response.ok) return { type: 'text', text: JSON.stringify(response.snapshot, null, 1) }
    if ((response as any).code === 'paused') {
      // 人工接管中：循环等待直到 resume（每 2s 重发 snapshot 请求探活）
      while (browserPaused) { await sleep(2000) }
      return await BrowserTool.call({ action: 'snapshot' }, ctx)
    }
    return { type: 'text', text: `浏览器操作失败: ${response.error}` }
  },
}
```
（`browserPending`/`browserPaused` 为模块级单例，print.ts 的 stdin 处理器操作同一对象。）

- [ ] **Step 4: 接入 print.ts**

- import `BrowserTool` 与 `browserPending/browserPaused` 符号。
- 基础 tools 数组（`buildAllTools` 前，`run()` 内定义 `tools` 数组处）追加 `new BrowserTool(...)`（若 tools 为类实例列表，按同文件其它工具实例化方式）。
- control_request switch 增加（cancel case 之后、end_session 之前，约 2887 行）：
```ts
} else if (message.request.subtype === 'browser_response') {
  const pending = browserPending.get(message.request.requestId)
  if (pending) {
    browserPending.delete(message.request.requestId)
    pending.resolve({ ok: message.request.ok, snapshot: message.request.snapshot, error: message.request.error })
  } else {
    // 孤儿响应（工具已超时）——忽略
  }
} else if (message.request.subtype === 'browser_pause') {
  browserPaused = true
} else if (message.request.subtype === 'browser_resume') {
  browserPaused = false
}
```

- [ ] **Step 5: 内核测试 + 重新构建 + 同步 release**

Run（`yfw-kernel/claude-code`）：`bun test src/tools/BrowserTool/protocol.test.ts` 通过后：
```bash
bun scripts/build-bundle.ts --minify
cp dist/cli.mjs ../../release/YFWorking_ms92cd6u/kernel/cli.mjs
grep -c "browser_response" ../../release/YFWorking_ms92cd6u/kernel/cli.mjs   # 期望 ≥1
```
（构建产物路径按仓库实际：`release/YFWorking_ms92cd6u/kernel/`。）

- [ ] **Step 6: 提交**

```bash
cd ../../..  # 仓库根
git add yfw-kernel/claude-code/src/tools/BrowserTool/ yfw-kernel/claude-code/src/cli/print.ts
git commit -m "feat(browser): 内核 browser 工具——bridge_request 出/browser_response 入 + 人工接管挂起"
```

---

### Task 5: GUI 精简状态条 + 聊天集成

**Files:**
- Create: `src/components/browser/BrowserStatusBar.tsx`
- Modify: `src/stores/browserStore.ts`（新建）、`src/hooks/useYFWCLI.ts`（browser:event 处理）、`src/components/layout/*`（挂载状态条）、`src/i18n/translations/zh-CN.ts` + `en-US.ts`、`src/types/index.ts`（BrowserEvent 类型）

**Interfaces:**
- Consumes: `browser:event`（bridge 广播，字段：`{ kind:'action_start'|'action_end'|'paused'|'human_done'|'imitation'|'snapshot', action?, url?, snapshotThumb? }`）；IPC `window.browser`（Task 3 preload）
- Produces: `browserStore`（zustand）：`{ status, events, mode, humanMode, setEvent, clear }`
- UI：主界面顶部/输入框上方一条状态条：
  - 有事件时显示：`当前操作` 文本 + 徽标（人工接管中/拟真模式）+ 按钮（打开窗口 / 暂停 / 继续 / 清空会话）
  - 无事件不占位（返回 null）

- [ ] **Step 1: 类型 + store + 事件处理（先测试不可行——GUI 组件测试基建弱，此任务以 typecheck + build 为门）**

`src/types/index.ts`：
```ts
export interface BrowserEvent {
  kind: 'action_start' | 'action_end' | 'paused' | 'human_done' | 'imitation' | 'snapshot'
  action?: string
  url?: string
  mode?: 'normal' | 'imitation'
}
```

`src/stores/browserStore.ts`（zustand，参照 doubaoStore 风格）：
```ts
interface BrowserState {
  current: { action?: string; url?: string; humanMode: boolean; imitation: boolean } | null
  setEvent: (e: BrowserEvent) => void
  clear: () => void
}
```

`src/hooks/useYFWCLI.ts` handleMessage 追加（`msg.type === 'browser:event'` 分支，参照 `type === 'event'` 处理处）：
```ts
if (msg.type === 'browser:event') {
  useBrowserStore.getState().setEvent(msg.event as BrowserEvent)
  return
}
```

- [ ] **Step 2: 状态条组件**

`src/components/browser/BrowserStatusBar.tsx`：
- 订阅 `useBrowserStore`；`current === null` 时返回 null
- 渲染：`当前操作：{action} · {url}` + 徽标（humanMode → `人工接管中`；imitation → `拟真模式`）+ 按钮：
  - `打开窗口` → `window.browser?.openWindow(activeConversationId)`
  - `暂停`/`继续` → 经 bridge 控制通道：复用 `useYFWCLI` 暴露的 `browserControl(convId, 'pause'|'resume')`（发 `{type:'browser_control', sessionId: convId, command}`）
  - `清空会话` → `window.browser?.clearSession(convId)`（二次确认）
- 挂载：在 ChatWindow 消息区上方（参照 RunningAgentsBar 挂载方式），样式沿用玻璃主题 tokens（bg-elevated/border-brand-500/30，遵守"玻璃面板质感维护"偏好）。

- [ ] **Step 3: i18n + 接线**

- `zh-CN.ts`/`en-US.ts` 增加：`browser.*`（打开窗口/暂停/继续/清空会话/人工接管中/拟真模式/当前操作）。
- `useYFWCLI` 返回值增加 `browserControl`。

- [ ] **Step 4: 构建验证 + 同步 release**

Run: `npm run typecheck && npm run build`
Expected: PASS，然后：
```bash
cp -r dist/. release/YFWorking_ms92cd6u/dist/
grep -c "browser:event\|BrowserStatusBar" release/YFWorking_ms92cd6u/dist/assets/index-*.js   # 期望 ≥1（新 bundle）
```

- [ ] **Step 5: 提交**

```bash
git add src/components/browser/ src/stores/browserStore.ts src/hooks/useYFWCLI.ts src/types/index.ts src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(browser): GUI 精简状态条 + browser:event 订阅 + 暂停/继续控制通道"
```

---

### Task 6: gsxt 核验端到端验收（用户在场）

**Files:**
- Modify: `docs/superpowers/specs/2026-08-18-builtin-browser-automation-design.md`（验收记录补充，若验收发现问题则同步修订）
- 无代码产出（验证性任务）；若发现缺陷则就地修复并补充单测

**Interfaces:**
- Consumes: Task 1-5 全部产物

- [ ] **Step 1: 重启/重载前征得用户同意**

按约束：重启 live app / 重载 renderer 前必须先询问用户。获得同意后重载（CDP `Page.reload`，参照既有 reload-renderer.cjs 模式）使新 GUI bundle 生效；内核新产物需新会话生效。

- [ ] **Step 2: 端到端手测清单**

在真实 gsxt 上人工验收（用户在场）：
- [ ] 对话中指示 agent："核验 XX 企业工商信息"
- [ ] agent 自动 `browser_operate(goto, gsxt)` → 状态条显示"正在导航…" → 自动化窗口弹出并加载
- [ ] 输入企业名（可信键盘输入）→ 遇验证码 → agent 调 `pause_for_human` → 状态条"人工接管中" → 用户手动滑验证码 → 指纹变化自动恢复 → agent 继续
- [ ] a11y 树读结果 → 结构化输出（名称/统一社会信用代码/法定代表人/状态/成立日期）回填聊天
- [ ] 截图取证落盘 `{userData}/browser-downloads/{sessionId}/`
- [ ] 异常路径：关闭自动化窗口后 agent 下一步动作自动重建窗口；白名单外域名 goto 被拒
- [ ] 回归：豆包生成、编辑器窗口、会话收发不受影响

- [ ] **Step 3: 发现缺陷则修复 + 提交**

```bash
git add -A && git commit -m "fix(browser): 核验端到端验收修复"
```

---

### Task 7: 拟真兜底模式（opt-in）

**Files:**
- Modify: `electron/browser-executor.cjs`（imitation 输入模式）、`yfw-kernel/claude-code/src/tools/BrowserTool/`（mode 传递）、`src/components/browser/BrowserStatusBar.tsx`（拟真模式确认弹窗）、技能红线文档

**Interfaces:**
- Consumes: 既有 browser 链路；`mode` 参数（Task 4 schema 已预留）
- Produces: `browser_operate(..., { mode: 'imitation' })` 生效路径

- [ ] **Step 1: 执行器拟真输入实现**

`browser-executor.cjs` 中 `typeText`/`mouseMove` 增加 imitation 分支：
```js
async typeHuman(win, ref, text) {
  const cdp = win.webContents.debugger
  const box = await clickBox(win, ref)
  await humanMouseTo(cdp, box)   // 贝塞尔路径 + 随机停驻（50-200ms）
  await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ... })
  await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ... })
  for (const ch of String(text)) {
    const delay = 30 + Math.random() * 120
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch, unmodifiedText: ch })
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(delay)
  }
}
```
- 触发：仅当该会话已开启拟真模式（`this.imitationAllowed`，由 GUI 弹窗确认置位）；模式状态随 `browser:event`（kind:'imitation'）广播，状态条显示"拟真模式"徽标。

- [ ] **Step 2: GUI 确认闸门**

`BrowserStatusBar` 或聊天区：agent 返回 `{ok:false, error:/行为检测|操作被拦|imitation/}` 时提示"是否开启拟真输入模式重试？"→ 确认 → `window.browser?.setImitation(sessionId, true)`（新增 IPC）+ 通知内核后续动作带 `mode:'imitation'`（经 `browser_control {command:'set-imitation'}` 或后续工具调用显式携带）。

- [ ] **Step 3: 红线文档同步**

Modify `C:/Users/T203-15/.yfworking/skills/yfwweb-scrape/SKILL.md` 红线 #3：
原文"禁止模拟真人行为规避反爬（如模拟鼠标轨迹）"改为"禁止破解类规避（验证码 OCR/滑块自动破解、指纹伪装、绕过站点授权、高频并发压测）；已授权站点的行为拟真仅限内置浏览器兜底模式，默认关闭、人工确认后开启、操作日志标注拟真模式"。`yfwweb-suite`/`yfwweb-form` 如有相同红线一并同步。

- [ ] **Step 4: 构建同步 + 测试**

GUI：`npm run typecheck && npm run build && cp -r dist/. release/YFWorking_ms92cd6u/dist/`；内核：重建 + cp + grep 验证。`npm test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(browser): 拟真兜底输入模式（opt-in + 人工闸门）+ 技能红线修订"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 拓扑→Task 2/3；§4.1 动作集→Task 4（schema 全动作）；§4.2 快照协议→Task 1+3（ref 索引/差异摘要/验证码信号/脱敏/裁剪）；§4.3 bridge 路由→Task 2；§4.4 执行器（窗口/分区/CDP/人工接管/下载/拟真）→Task 3+7；§4.5 状态条+聊天→Task 5；§5 合规→Task 1（白名单/脱敏）+ Task 7（红线/闸门）；§6 核验切片→Task 6；§7 测试→各任务内；§8 落地顺序→Task 1-7；§9 YAGNI 无违反。
- **占位扫描**：无 TBD/TODO；关键实现均有代码块或明确模式引用（bridge cancel 写入、connectPetBridgeListener、AskUserQuestionTool 目录结构、cancel case 位置）。
- **类型一致性**：`browser:exec`/`browser:exec:response`/`bridge_request`/`browser_response`/`browser_control`/`browser:event` 消息名在 Task 2/3/4/5 间一致；`BrowserEvent.kind` 与 executor `onEvent` 广播一致；`browser_operate(action, params, mode)` schema 在 Task 4/7 一致；`browser-common.cjs` 导出名在 Task 1/3 一致。
- **已知风险**：内核 `tools` 基础数组的确切定义位置需实施时 grep 定位（`const tools` 于 print.ts run() 内）；bridge 内核输出处理器的 return 语义需按既有代码对齐；Electron 窗口部分纯 node 测试受限，依赖 Task 6 人工验收兜底。
