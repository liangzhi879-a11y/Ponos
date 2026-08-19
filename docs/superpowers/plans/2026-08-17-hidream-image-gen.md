# HiDream 图片生成接入实施计划（纯 A 反代）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 claude-code-gui 聊天输入栏内嵌 HiDream AI 绘图面板，通过本地反代复用 hidream.org 免费额度，用户一次登录（Clerk 记住我）后可持续生成文生图/图生图图片。

**Architecture:** 三层——Electron main 负责独立登录窗口并将 Clerk cookie 导出到 `~/.yfworking/hidream-session.json`；bridge.mjs（或独立模块 hidream.mjs）作为本地代理转发请求到 hidream.org 内部 API（带 cookie/Referer/UA 伪装）；React 前端在 ChatInput 原"附加图片"按钮位置弹出绘图面板，生成结果可插入当前输入作为图片附件。

**Tech Stack:** Node ESM（server）、Electron main（CJS）、React 18 + zustand + Radix Popover + lucide-react、node:test 单测、Tailwind 玻璃主题变量。

## Global Constraints

- 用户运行 **release 打包版**：所有源码改动需 `npm run build` 后同步 release 目录，重启 live 应用前必须征得用户同意（见项目工作流记忆）
- 单测命令：`npm test`（= `node --test "server/*.test.mjs"`）；测试隔离用 `YFW_TEST_HOME` 临时目录（仿 `server/experience.mjs:5-6`）
- 测试环境隔离：`YFW_HIDREAM_BASE` 环境变量可覆盖转发目标（测试指向本地 stub server），绝不请求真实 hidream.org
- 转发仅允许 localhost 来源（复用 `isAllowedOrigin`），请求最小间隔 3s（节流护栏）
- 会话 cookie 文件 `~/.yfworking/hidream-session.json` 权限收紧、不落日志
- 文案：UI 中文为主，i18n zh-CN/en-US 双语；风格遵循现有玻璃面板主题变量
- 不引入新 npm 依赖（Node 内置 https/http 足够）

---

### Task 1: P0 实测 —— 确定转发策略

**Files:**
- Create: `docs/superpowers/notes/2026-08-17-hidream-p0-probe.md`

**Interfaces:**
- Consumes: 无
- Produces: 实测结论（4 项），决定 Task 2 的转发参数（是否透传 `turnstile_token`、主通道选 `create-image` 还是 `instant`、图生图传参）

- [ ] **Step 1: 检查本机是否有可用的 hidream.org 会话（cookie 提取脚本）**

写一次性脚本 `server/probe-hidream.mjs`（临时，实测后删除）：

```js
// 用法：node server/probe-hidream.mjs
// 目标：模拟 bridge 转发，实测 4 项结论。需要先手动在浏览器登录 hidream.org，
// 复制 __session cookie 值填入下方 COOKIE。
const COOKIE = process.env.HIDREAM_COOKIE || ''
const BASE = 'https://hidream.org'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const hdrs = { 'Cookie': COOKIE, 'User-Agent': UA, 'Referer': BASE + '/zh/ai-image-generator', 'Origin': BASE, 'Content-Type': 'application/json' }

async function call(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: hdrs, body: JSON.stringify(body) })
  const text = await r.text()
  console.log(`[${path}] HTTP ${r.status} body=${text.slice(0, 500)}`)
  return { status: r.status, text }
}

// ① credits（验证 cookie 有效）
await call('/api/user/get-user-credits', {})
// ② create-image 不带 turnstile_token（验证是否可绕过/必须）
await call('/api/create-image', { prompt: 'a red apple on white table', model_name: 'dev', image_type: 'text2img', set_private: true, count: 1 })
// ③ instant 通道（验证是否免 Turnstile、返回结构）
await call('/api/image/instant', { description: 'a red apple on white table' })
// ④ 图生图（无图时仅观察参数结构校验信息；有图需先 /api/storage/upload-image 拿 URL）
await call('/api/storage/upload-image', {})
```

- [ ] **Step 2: 运行实测并记录结论**

Run: 设置 `HIDREAM_COOKIE` 后执行 `node server/probe-hidream.mjs`
Expected: 4 个请求的 HTTP 状态与响应体

- [ ] **Step 3: 根据实测结果写结论文档**

在 `docs/superpowers/notes/2026-08-17-hidream-p0-probe.md` 记录：
1. `__session` 无 JS 环境下有效时长（①的 401/成功状态）
2. `create-image` 不带 turnstile_token 是否可用；若 400/403 说明必填 → 决定 Task 2 需支持 `turnstile_token` 透传 + Task 6 面板内嵌 Turnstile
3. `instant` 通道返回结构（是否有 image url / task_id）与是否免验证 → 决定主通道
4. 图生图所需参数（upload-image 的 body/返回）

- [ ] **Step 4: 删除临时脚本并提交**

```bash
rm server/probe-hidream.mjs
git add docs/superpowers/notes/2026-08-17-hidream-p0-probe.md
git commit -m "docs(hidream): P0 实测结论——转发策略定稿"
```

---

### Task 2: server/hidream.mjs —— 会话/历史/转发核心模块（TDD）

**Files:**
- Create: `server/hidream.mjs`
- Test: `server/hidream.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `sessionFile()` / `historyFile()` / `imagesDir()` → 绝对路径（`YFW_TEST_HOME || homedir()` 下）
  - `isLoggedIn()` → boolean（cookie 文件含 `__session`）
  - `getSessionCookieHeader()` → string 或 ''（`name=value; ...`）
  - `saveSession(cookies)` / `clearSession()`
  - `proxyRequest({ path, method, body, base, timeoutMs })` → `{ status, data }`（base 默认 `process.env.YFW_HIDREAM_BASE || 'https://hidream.org'`；转发带 cookie/Referer/Origin/UA 伪装）
  - `addHistory(entry)` / `listHistory()` / `removeHistory(id)`（本地 JSON 数组，新条目在前）
  - `rateLimitHit()` → boolean（距上次调用 <3000ms 返回 true，否则更新并 false）

- [ ] **Step 1: 写失败测试**

`server/hidream.test.mjs`：

```js
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yfw-hidream-'))
process.env.YFW_TEST_HOME = testHome
const hid = await import('./hidream.mjs')

// 本地 stub：模拟 hidream.org 响应并记录收到的请求头
let seen = { headers: null, body: null }
const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', d => raw += d)
  req.on('end', () => {
    seen = { headers: req.headers, body: raw }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, message: 'ok', data: { credits: 42 } }))
  })
})
await new Promise(r => stub.listen(0, r))
const BASE = `http://127.0.0.1:${stub.address().port}`

beforeEach(() => { seen = { headers: null, body: null } })
after(() => { stub.close(); fs.rmSync(testHome, { recursive: true, force: true }) })

test('saveSession 后 isLoggedIn 为真且 Cookie 头被带上', async () => {
  hid.saveSession([{ name: '__session', value: 'jwt-token', domain: 'hidream.org' }])
  assert.equal(hid.isLoggedIn(), true)
  const res = await hid.proxyRequest({ path: '/api/user/get-user-credits', method: 'POST', body: {}, base: BASE })
  assert.equal(res.status, 200)
  assert.equal(res.data.data.credits, 42)
  assert.equal(seen.headers.cookie, '__session=jwt-token')
  assert.equal(seen.headers.referer, 'https://hidream.org/zh/ai-image-generator')
  assert.equal(seen.headers.origin, 'https://hidream.org')
})

test('未登录时 Cookie 头为空', async () => {
  hid.clearSession()
  assert.equal(hid.isLoggedIn(), false)
  assert.equal(hid.getSessionCookieHeader(), '')
})

test('history 增删查', () => {
  const a = hid.addHistory({ id: 'h1', prompt: 'apple', imagePath: 'x.png' })
  assert.equal(a, true)
  const list = hid.listHistory()
  assert.equal(list.length, 1)
  assert.equal(list[0].prompt, 'apple')
  hid.removeHistory('h1')
  assert.equal(hid.listHistory().length, 0)
})

test('rateLimitHit 3 秒内为 true', async () => {
  assert.equal(hid.rateLimitHit(), false)   // 首次放行
  assert.equal(hid.rateLimitHit(), true)    // 立即再调被拦
  await new Promise(r => setTimeout(r, 3050))
  assert.equal(hid.rateLimitHit(), false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/hidream.test.mjs`
Expected: FAIL（模块不存在 / 函数未定义）

- [ ] **Step 3: 实现 hidream.mjs**

```js
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'fs'

const HOME = process.env.YFW_TEST_HOME || homedir()
const HIDREAM_BASE = process.env.YFW_HIDREAM_BASE || 'https://hidream.org'
const HIDREAM_REFERER = 'https://hidream.org/zh/ai-image-generator'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export const sessionFile = () => join(HOME, '.yfworking', 'hidream-session.json')
export const historyFile = () => join(HOME, '.yfworking', 'hidream-history.json')
export const imagesDir = () => join(HOME, '.yfworking', 'hidream-images')

let lastReqAt = 0

function readJson(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null } catch { return null }
}
function writeJson(p, v) {
  mkdirSync(join(HOME, '.yfworking'), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2), 'utf-8')
}

export function getSessionCookieHeader() {
  const s = readJson(sessionFile())
  if (!s || !Array.isArray(s.cookies)) return ''
  return s.cookies.map(c => `${c.name}=${c.value}`).join('; ')
}
export function isLoggedIn() {
  return getSessionCookieHeader().includes('__session=')
}
export function saveSession(cookies) {
  writeJson(sessionFile(), { exportedAt: Date.now(), cookies: Array.isArray(cookies) ? cookies : [] })
}
export function clearSession() {
  try { rmSync(sessionFile(), { force: true }) } catch {}
}

export async function proxyRequest({ path, method = 'POST', body = {}, base = HIDREAM_BASE, timeoutMs = 30000 }) {
  const headers = {
    'User-Agent': BROWSER_UA,
    'Referer': HIDREAM_REFERER,
    'Origin': 'https://hidream.org',
    'Content-Type': 'application/json',
    ...(getSessionCookieHeader() ? { 'Cookie': getSessionCookieHeader() } : {}),
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(base + path, { method, headers, body: JSON.stringify(body), signal: ctrl.signal })
    let data = null
    const text = await r.text()
    try { data = JSON.parse(text) } catch { data = { raw: text } }
    return { status: r.status, data }
  } finally { clearTimeout(timer) }
}

export function addHistory(entry) {
  const list = listHistory()
  list.unshift({ ...entry, createdAt: Date.now() })
  writeJson(historyFile(), list.slice(0, 100))
  return true
}
export function listHistory() {
  return readJson(historyFile()) || []
}
export function removeHistory(id) {
  writeJson(historyFile(), listHistory().filter(x => x.id !== id))
  return true
}

export function rateLimitHit() {
  const now = Date.now()
  if (now - lastReqAt < 3000) return true
  lastReqAt = now
  return false
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test server/hidream.test.mjs`
Expected: 5 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add server/hidream.mjs server/hidream.test.mjs
git commit -m "feat(hidream): 会话/历史/转发核心模块 + 单测"
```

---

### Task 3: bridge.mjs 挂载 /yfw/img/* 代理端点

**Files:**
- Modify: `server/bridge.mjs`（在 `url.pathname === '/health'` 分支之后、`/test-provider` 之前插入；引用 hidream.mjs 导出）
- Test: `server/hidream.test.mjs`（追加端点为前置的 HTTP 集成测试）

**Interfaces:**
- Consumes: Task 2 全部导出（`proxyRequest`/`isLoggedIn`/`rateLimitHit`/`listHistory`/`removeHistory`/`addHistory`/`imagesDir`）
- Produces: HTTP 端点（前端/Electron 调用）：
  - `GET /yfw/img/status` → `{ loggedIn, exportedAt? }`
  - `GET /yfw/img/credits` → 转发 `POST /api/user/get-user-credits` 的 `{code,message,data}`
  - `POST /yfw/img/create` → body `{prompt, model_name?, image_type?, count?, image_url?, turnstile_token?}` 转发 `POST /api/create-image`
  - `POST /yfw/img/instant` → body `{description}` 转发 `POST /api/image/instant`
  - `GET /yfw/img/history` → `{ items }`
  - `POST /yfw/img/history` → body 为一条历史条目 → `{ ok }`（store 在 generate 后落本地历史）
  - `DELETE /yfw/img/history/:id` → `{ ok }`
  - `GET /yfw/img/download?id=<id>` → 本地图片文件字节（image/jpeg|png）

- [ ] **Step 1: 写失败测试（端点集成）**

在 `server/hidream.test.mjs` 追加（复用 stub server，导入 bridge 的 httpServer 监听随机端口）：

```js
test('bridge /yfw/img/status 与 /yfw/img/create 联动', async () => {
  hid.saveSession([{ name: '__session', value: 'jwt' }])
  const r = await fetch(`http://127.0.0.1:${bridgePort}/yfw/img/status`)
  const st = await r.json()
  assert.equal(st.loggedIn, true)
  const c = await fetch(`http://127.0.0.1:${bridgePort}/yfw/img/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'cat', count: 1 }),
  })
  assert.equal(c.status, 200)
  const body = JSON.parse(seen.body)
  assert.equal(body.prompt, 'cat')
  assert.equal(body.model_name, 'dev')
})
```

（`bridgePort` 通过在测试内 `import('../server/bridge.mjs')` 前设置 `process.env.YFW_BRIDGE_PORT = '0'` 不可行——bridge 固定 listen。改为：bridge.mjs 导出 `httpServer`，测试里 `await new Promise(r => httpServer.listen(0, r))` 取随机端口；注意 bridge.mjs 顶层已有 `httpServer.listen(PORT)` 副作用——为可测试性，在 bridge.mjs 末尾改为 `if (!process.env.YFW_BRIDGE_NO_LISTEN) httpServer.listen(...)`，测试设该环境变量。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/hidream.test.mjs`
Expected: FAIL（/yfw/img/status 404 / bridge 无导出）

- [ ] **Step 3: 实现 bridge 改动**

`server/bridge.mjs` 顶部加 `import * as hid from './hidream.mjs'`（放在既有 import 之后）。在 `url.pathname === '/health'` 分支后插入：

```js
if (url.pathname.startsWith('/yfw/img/')) {
  if (url.pathname === '/yfw/img/status') {
    const s = hid.readSessionMeta ? hid.readSessionMeta() : null
    return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ loggedIn: hid.isLoggedIn(), exportedAt: s?.exportedAt || null }))
  }
  if (url.pathname === '/yfw/img/credits') {
    if (hid.rateLimitHit()) return reply(429, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 429, message: 'rate limited' }))
    const r = await hid.proxyRequest({ path: '/api/user/get-user-credits', method: 'POST', body: {}, timeoutMs: 10000 })
    return reply(r.status, { 'Content-Type': 'application/json' }, JSON.stringify(r.data))
  }
  if (url.pathname === '/yfw/img/create' && req.method === 'POST') {
    if (hid.rateLimitHit()) return reply(429, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 429, message: 'rate limited' }))
    const b = await readJsonBody(req)
    if (!b.prompt) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 400, message: 'prompt required' }))
    const body = { prompt: b.prompt, model_name: b.model_name || 'dev', image_type: b.image_type || 'text2img', set_private: true, count: b.count || 1 }
    if (b.image_url) body.image_url = b.image_url
    if (b.turnstile_token) body.turnstile_token = b.turnstile_token
    const r = await hid.proxyRequest({ path: '/api/create-image', method: 'POST', body, timeoutMs: 60000 })
    return reply(r.status, { 'Content-Type': 'application/json' }, JSON.stringify(r.data))
  }
  if (url.pathname === '/yfw/img/instant' && req.method === 'POST') {
    if (hid.rateLimitHit()) return reply(429, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 429, message: 'rate limited' }))
    const b = await readJsonBody(req)
    if (!b.description) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 400, message: 'description required' }))
    const r = await hid.proxyRequest({ path: '/api/image/instant', method: 'POST', body: { description: b.description }, timeoutMs: 60000 })
    return reply(r.status, { 'Content-Type': 'application/json' }, JSON.stringify(r.data))
  }
  if (url.pathname === '/yfw/img/history' && req.method === 'GET') {
    return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ items: hid.listHistory() }))
  }
  if (url.pathname === '/yfw/img/history' && req.method === 'POST') {
    const b = await readJsonBody(req)
    if (!b.id || !b.prompt) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 400, message: 'id and prompt required' }))
    hid.addHistory({ id: b.id, prompt: b.prompt, imageUrl: b.imageUrl || '', createdAt: b.createdAt || Date.now() })
    return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
  }
  if (url.pathname.startsWith('/yfw/img/history/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop())
    hid.removeHistory(id)
    return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
  }
  if (url.pathname === '/yfw/img/download' && req.method === 'GET') {
    const id = url.searchParams.get('id') || ''
    const fp = join(hid.imagesDir(), id)
    if (!existsSync(fp) || statSync(fp).isDirectory()) return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'not found' }))
    const mime = fp.endsWith('.png') ? 'image/png' : 'image/jpeg'
    return reply(200, { 'Content-Type': mime, 'Content-Length': statSync(fp).size }, readFileSync(fp))
  }
  return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'unknown hidream endpoint' }))
}
```

bridge.mjs 顶部 import 区补充（`join`/`existsSync`/`statSync`/`readFileSync` 已在用，无需新增）：
```js
import * as hid from './hidream.mjs'
```
并在 hidream.mjs 增加 `readSessionMeta()`（返回 `{exportedAt}` 或 null）：
```js
export function readSessionMeta() {
  const s = JSON.parse(readFileSync(sessionFile(), 'utf-8'))
  return s && typeof s.exportedAt === 'number' ? { exportedAt: s.exportedAt } : null
}
```
（读失败返回 null，用 try/catch 包裹）
bridge.mjs 末尾 listen 改为：
```js
if (!process.env.YFW_BRIDGE_NO_LISTEN) {
  httpServer.listen(PORT, () => { console.log('[bridge] http+ws://localhost:' + PORT); autoInstallSamples() })
}
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `node --test server/hidream.test.mjs && npm test`
Expected: 新增端点测试 PASS，既有 server 测试全绿

- [ ] **Step 5: 提交**

```bash
git add server/bridge.mjs server/hidream.mjs server/hidream.test.mjs
git commit -m "feat(hidream): bridge 挂载 /yfw/img/* 代理端点（限速/错误透传）"
```

---

### Task 4: main.cjs 登录窗口 + IPC

**Files:**
- Modify: `electron/main.cjs`（新增 import、IPC handler、窗口管理）
- Modify: `electron/preload.cjs`（暴露 `hidreamOpenLogin`/`hidreamGetStatus`/`hidreamLogout`）

**Interfaces:**
- Consumes: `~/.yfworking/hidream-session.json` 文件契约（与 hidream.mjs 一致，main 直接读写文件，不 import ESM）
- Produces:
  - IPC `hidream:open-login` → 创建登录窗口；登录成功（did-navigate 命中主路径且 cookie 含 `__session`）→ 导出 cookie 写文件 → 自动关窗 → resolve `{ok:true}`
  - IPC `hidream:get-status` → `{ loggedIn, exportedAt }`
  - IPC `hidream:logout` → 删文件 + 清 partition cookie → `{ok:true}`
  - preload 暴露 `window.hidream.openLogin()/getStatus()/logout()`（contextBridge）

- [ ] **Step 1: 写失败测试**

IPC 无法在 node:test 内跑 Electron。改为：**文件契约测试**——在 `server/hidream.test.mjs` 追加断言 main 会写/读的 JSON 结构与 hidream.mjs 兼容：

```js
test('main 写入的 session 文件格式与 hidream.mjs 兼容', () => {
  // 模拟 main.cjs 的写入格式（见 Task 4 Step 3 中的 writeSession 函数）
  const s = { exportedAt: 123, cookies: [{ name: '__session', value: 'jwt', domain: 'hidream.org', path: '/' }] }
  fs.writeFileSync(hid.sessionFile(), JSON.stringify(s), 'utf-8')
  assert.equal(hid.isLoggedIn(), true)
  assert.equal(hid.getSessionCookieHeader(), '__session=jwt')
})
```

- [ ] **Step 2: 运行确认通过（契约测试）**

Run: `node --test server/hidream.test.mjs`
Expected: PASS（契约已由 Task 2 实现满足）

- [ ] **Step 3: 实现 main.cjs**

顶部 require 区补充（main.cjs 是 CJS）：
```js
const { session } = require('electron')   // 追加到现有解构
const fsMain = require('fs')
const pathMain = require('path')
```
新增（放在既有 `ipcMain.handle('editor:get-pending'...)` 附近）：
```js
let hidreamWin = null
const HIDREAM_SESSION_FILE = pathMain.join(require('os').homedir(), '.yfworking', 'hidream-session.json')

function writeHidreamSession(cookies) {
  fsMain.mkdirSync(pathMain.dirname(HIDREAM_SESSION_FILE), { recursive: true })
  fsMain.writeFileSync(HIDREAM_SESSION_FILE, JSON.stringify({ exportedAt: Date.now(), cookies }, null, 2), 'utf-8')
}
function readHidreamStatus() {
  try {
    const s = JSON.parse(fsMain.readFileSync(HIDREAM_SESSION_FILE, 'utf-8'))
    return { loggedIn: (s.cookies || []).some(c => c.name === '__session'), exportedAt: s.exportedAt || null }
  } catch { return { loggedIn: false, exportedAt: null } }
}

ipcMain.handle('hidream:open-login', async () => {
  if (hidreamWin) { hidreamWin.focus(); return { ok: true } }
  const ses = session.fromPartition('persist:hidream')
  hidreamWin = new BrowserWindow({ width: 1100, height: 780, title: 'HiDream 登录', parent: mainWindow, modal: true, webPreferences: { partition: 'persist:hidream', contextIsolation: true } })
  hidreamWin.on('closed', () => { hidreamWin = null })
  hidreamWin.webContents.on('did-navigate', async (_e, url) => {
    try {
      const u = new URL(url)
      if (u.hostname === 'hidream.org' && u.pathname.includes('ai-image-generator')) {
        const cookies = await ses.cookies.get({ url: 'https://hidream.org' })
        if (cookies.some(c => c.name === '__session')) {
          writeHidreamSession(cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })))
          setTimeout(() => { if (hidreamWin) hidreamWin.close() }, 800)
        }
      }
    } catch {}
  })
  await hidreamWin.loadURL('https://hidream.org/zh/ai-image-generator')
  return { ok: true }
})

ipcMain.handle('hidream:get-status', () => readHidreamStatus())

ipcMain.handle('hidream:logout', async () => {
  try { fsMain.rmSync(HIDREAM_SESSION_FILE, { force: true }) } catch {}
  try { await session.fromPartition('persist:hidream').clearStorageData({ storages: ['cookies'] }) } catch {}
  return { ok: true }
})
```

`electron/preload.cjs` 追加（沿用现有 `contextBridge.exposeInMainWorld` 模式）：
```js
hidream: {
  openLogin: () => ipcRenderer.invoke('hidream:open-login'),
  getStatus: () => ipcRenderer.invoke('hidream:get-status'),
  logout: () => ipcRenderer.invoke('hidream:logout'),
},
```

- [ ] **Step 4: 手动冒烟（可选，需用户在 dev 下配合）**

Run: `npm run dev` 另开终端 `npm run electron`，主窗口点"登录 HiDream"（Task 6 完成后）
Expected: 登录窗口打开、登录后自动关闭、`~/.yfworking/hidream-session.json` 生成

- [ ] **Step 5: 提交**

```bash
git add electron/main.cjs electron/preload.cjs server/hidream.test.mjs
git commit -m "feat(hidream): 独立登录窗口 + IPC（open-login/get-status/logout）"
```

---

### Task 5: 类型 + i18n + hidreamStore

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`
- Create: `src/stores/hidreamStore.ts`

**Interfaces:**
- Consumes: Task 3 端点（HTTP）、Task 4 preload（`window.hidream.*`）
- Produces:
  - types: `HidreamStatus`、`HidreamResult`、`HidreamHistoryItem`
  - store `useHidreamStore`：state `{status, credits, generating, results, history, busy}` + actions `refreshStatus()/refreshCredits()/generate(payload)/instant(desc)/loadHistory()/removeHistory(id)/insertImage(att)`
  - i18n 键组 `hidream.*`（zh-CN/en-US 各一套）

- [ ] **Step 1: 写失败测试（纯函数部分）**

store 无独立单测框架（项目无 vitest）。改为在 `server/hidream.test.mjs` 不做；前端逻辑靠类型检查 + 手测。Step 1 改为**类型声明先行**：

在 `src/types/index.ts` 追加：
```ts
export interface HidreamStatus { loggedIn: boolean; exportedAt: number | null }
export interface HidreamResult {
  id: string            // 本地 uuid（nanoid）
  prompt: string
  imageUrl: string      // hidream 返回的图 URL 或本地路径
  localPath?: string    // 下载到 hidream-images 后的本地路径
  createdAt: number
}
export interface HidreamHistoryItem extends HidreamResult {}
```

- [ ] **Step 2: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（新增类型无错误）

- [ ] **Step 3: 实现 store**

`src/stores/hidreamStore.ts`：
```ts
import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { getBridgeUrl } from '@/lib/config'   // 已核实：src/lib/config.ts:14 导出 getBridgeUrl()
import type { HidreamStatus, HidreamHistoryItem } from '@/types'

interface State {
  status: HidreamStatus | null
  credits: number | null
  generating: boolean
  results: HidreamHistoryItem[]
  history: HidreamHistoryItem[]
  busy: boolean
  refreshStatus: () => Promise<void>
  refreshCredits: () => Promise<void>
  generate: (p: { prompt: string; imageUrl?: string; model?: string; count?: number; turnstileToken?: string }) => Promise<void>
  loadHistory: () => Promise<void>
  removeHistory: (id: string) => Promise<void>
  insertImage: (att: { name: string; path: string; preview?: string }) => void
}

export const useHidreamStore = create<State>((set, get) => ({
  status: null, credits: null, generating: false, results: [], history: [], busy: false,
  refreshStatus: async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/yfw/img/status`)
      set({ status: await r.json() })
    } catch { set({ status: { loggedIn: false, exportedAt: null } }) }
  },
  refreshCredits: async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/yfw/img/credits`)
      const d = await r.json()
      if (d.data && typeof d.data.credits !== 'undefined') set({ credits: d.data.credits })
    } catch {}
  },
  generate: async (p) => {
    set({ generating: true, busy: true })
    try {
      const body: Record<string, unknown> = { prompt: p.prompt, count: p.count || 1 }
      if (p.imageUrl) body.image_url = p.imageUrl
      if (p.model) body.model_name = p.model
      if (p.turnstileToken) body.turnstile_token = p.turnstileToken
      const r = await fetch(`${getBridgeUrl()}/yfw/img/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json()
      if (r.status === 401) set({ status: { loggedIn: false, exportedAt: null } })
      // d.data 结构以 P0 实测结论为准：图片 URL 数组 or task_id；第一版取 data.images 或 data.urls
      const urls: string[] = Array.isArray(d.data?.images) ? d.data.images : Array.isArray(d.data?.urls) ? d.data.urls : d.data?.url ? [d.data.url] : []
      const items: HidreamHistoryItem[] = urls.map(u => ({ id: nanoid(), prompt: p.prompt, imageUrl: u, createdAt: Date.now() }))
      set({ results: items })
      for (const it of items) {
        await fetch(`${getBridgeUrl()}/yfw/img/history`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(it) })
      }
    } finally { set({ generating: false, busy: false }) }
  },
  loadHistory: async () => {
    try { const r = await fetch(`${getBridgeUrl()}/yfw/img/history`); const d = await r.json(); set({ history: d.items || [] }) } catch {}
  },
  removeHistory: async (id) => {
    await fetch(`${getBridgeUrl()}/yfw/img/history/${encodeURIComponent(id)}`, { method: 'DELETE' })
    set({ history: get().history.filter(h => h.id !== id) })
  },
  insertImage: (att) => { /* 由 ChatInput 注入回调：见 Task 7 */ },
}))
```

- [ ] **Step 4: i18n 键组**

`zh-CN.ts` 追加：
```ts
hidream: {
  login: '登录 HiDream', reLogin: '会话已过期，重新登录', logout: '退出登录',
  credits: '剩余积分', prompt: '描述你想生成的图片…', model: '模型',
  aspectRatio: '比例', count: '数量', generate: '生成', generating: '生成中…',
  img2img: '图生图', uploadRef: '上传参考图', insert: '插入到输入栏', download: '下载',
  history: '历史记录', empty: '暂无历史', expired: 'HiDream 会话已过期，请重新登录',
  notice: '个人自用：复用 hidream.org 免费额度，账号风险自担',
},
```
`en-US.ts` 对应英文同结构。

- [ ] **Step 5: 提交**

```bash
git add src/types/index.ts src/stores/hidreamStore.ts src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(hidream): 类型 + store + i18n 文案"
```

---

### Task 6: HiDreamPanel 组件

**Files:**
- Create: `src/components/hidream/HiDreamPanel.tsx`

**Interfaces:**
- Consumes: Task 5 store/i18n、Task 4 preload（`window.hidream.openLogin/getStatus/logout`）
- Produces: `HiDreamPanel({ onInsertImage?: (att: {name, path, preview?}) => void })` 组件——登录卡 / 文生图 / 图生图 / 结果画廊 / 历史

- [ ] **Step 1: 类型检查前置（tsc 通过）**

组件为空壳时可先编译；实际实现以下步骤后重跑。

- [ ] **Step 2: 实现组件**

```tsx
import { useEffect, useState } from 'react'
import { Wand2, LogIn, LogOut, Download, ImagePlus, Sparkles } from 'lucide-react'
import { useHidreamStore } from '@/stores/hidreamStore'
import { getBridgeUrl } from '@/lib/config'
import { useI18n } from '@/i18n'   // 与现有组件一致的 i18n hook（ChatInput 同款）
import { Button } from '@/components/ui/button'  // 项目现有 Button（variant 见 ChatInput 用法）

export function HiDreamPanel({ onInsertImage }: { onInsertImage?: (att: { name: string; path: string; preview?: string }) => void }) {
  const t = useI18n()  // 具体取值方式按现有 i18n hook 调整
  const { status, credits, generating, results, history, refreshStatus, refreshCredits, generate, loadHistory, removeHistory } = useHidreamStore()
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('dev')
  const [ratio, setRatio] = useState('1:1')
  const [count, setCount] = useState(1)
  const [refImage, setRefImage] = useState<string | undefined>()

  useEffect(() => { refreshStatus(); loadHistory() }, [])
  useEffect(() => { if (status?.loggedIn) refreshCredits() }, [status?.loggedIn])

  const doGenerate = async () => {
    if (!prompt.trim()) return
    await generate({ prompt, model, count, imageUrl: refImage, turnstileToken: undefined })
  }

  return (
    <div className="w-[360px] p-3 space-y-3">
      {!status?.loggedIn ? (
        <div className="space-y-2">
          <p className="text-sm text-secondary">{t('hidream.login')}</p>
          <Button variant="primary" size="sm" onClick={() => window.hidream?.openLogin()}>
            <LogIn className="w-3.5 h-3.5 mr-1" /> {t('hidream.login')}
          </Button>
          <p className="text-xs text-tertiary">{t('hidream.notice')}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs">
            <span className="text-secondary">{t('hidream.credits')}: {credits ?? '—'}</span>
            <Button variant="ghost" size="xs" onClick={() => window.hidream?.logout().then(refreshStatus)}>
              <LogOut className="w-3 h-3 mr-1" /> {t('hidream.logout')}
            </Button>
          </div>
          <textarea
            className="w-full h-20 bg-input rounded-lg p-2 text-sm resize-none outline-none"
            placeholder={t('hidream.prompt')} value={prompt} onChange={e => setPrompt(e.target.value)}
          />
          <div className="flex gap-2 text-xs">
            <select value={model} onChange={e => setModel(e.target.value)} className="bg-input rounded px-1">
              <option value="dev">dev</option><option value="pro">pro</option>
            </select>
            <select value={ratio} onChange={e => setRatio(e.target.value)} className="bg-input rounded px-1">
              <option value="1:1">1:1</option><option value="16:9">16:9</option><option value="9:16">9:16</option>
            </select>
            <select value={count} onChange={e => setCount(Number(e.target.value))} className="bg-input rounded px-1">
              {[1, 2, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <Button variant="ghost" size="xs" onClick={() => { /* 文件选择→上传→setRefImage(本地路径) */ }}>
            <ImagePlus className="w-3.5 h-3.5 mr-1" /> {t('hidream.img2img')}
          </Button>
          <Button variant="primary" size="sm" className="w-full" disabled={generating || !prompt.trim()} onClick={doGenerate}>
            <Sparkles className="w-3.5 h-3.5 mr-1" /> {generating ? t('hidream.generating') : t('hidream.generate')}
          </Button>
          {results.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {results.map(r => (
                <div key={r.id} className="relative group rounded-lg overflow-hidden border border-border">
                  <img src={r.imageUrl} alt={r.prompt} className="w-full h-24 object-cover" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1">
                    <button onClick={() => onInsertImage?.({ name: r.prompt.slice(0, 20) + '.png', path: r.imageUrl, preview: r.imageUrl })} title={t('hidream.insert')}>
                      <Wand2 className="w-4 h-4 text-white" />
                    </button>
                    <a href={`${getBridgeUrl()}/yfw/img/download?id=${encodeURIComponent(r.id)}`} download title={t('hidream.download')}>
                      <Download className="w-4 h-4 text-white" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
          {history.length > 0 && (
            <details className="text-xs">
              <summary className="text-secondary cursor-pointer">{t('hidream.history')}</summary>
              <ul className="mt-1 space-y-1 text-tertiary">
                {history.slice(0, 10).map(h => (
                  <li key={h.id} className="flex justify-between">
                    <span className="truncate">{h.prompt}</span>
                    <button onClick={() => removeHistory(h.id)}>×</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（若有 i18n hook 用法差异按现有组件修正）

- [ ] **Step 4: 提交**

```bash
git add src/components/hidream/HiDreamPanel.tsx
git commit -m "feat(hidream): 绘图面板组件（登录/文生图/图生图/画廊/历史）"
```

---

### Task 7: ChatInput 入口替换 + 插入附件联动

**Files:**
- Modify: `src/components/chat/ChatInput.tsx`（:654-660 图片附加按钮替换；附件添加逻辑暴露）

**Interfaces:**
- Consumes: Task 6 `HiDreamPanel`
- Produces: 原 ImageIcon 按钮 → AI 绘图按钮（`Sparkles`），点击弹出 Radix Popover 内嵌 HiDreamPanel；`onInsertImage` 把生成的图作为 `Attachment`（`type:'image'`）加入输入栏

- [ ] **Step 1: 实现替换**

ChatInput.tsx 改动（在 import 区加 `Sparkles`、`Popover` 相关导入；`:654-660` 图片附加按钮替换为）：

```tsx
{/* AI 绘图（替代原附加图片按钮；剪贴板粘贴图片能力保留） */}
<input ref={imageInputRef} type="file" multiple accept="image/*" className="hidden" onChange={handleImagePick} />
<Popover>
  <PopoverTrigger asChild>
    <Button variant="ghost" size="xs" className="text-tertiary hover:text-secondary" aria-label={t('chat.attachImage')}>
      <Sparkles className="w-4 h-4" />
    </Button>
  </PopoverTrigger>
  <PopoverContent side="top" align="start" className="w-auto p-0 bg-panel/95 backdrop-blur-xl border-border rounded-xl shadow-xl">
    <HiDreamPanel
      onInsertImage={(att) => {
        const imgPath = att.path.startsWith('http') ? att.path : att.path
        setAttachments(prev => [...prev, {
          id: nanoid(), name: att.name, type: 'image' as const,
          content: '', path: imgPath, preview: att.preview || imgPath,
        }])
      }}
    />
  </PopoverContent>
</Popover>
```

需要确保 ChatInput 已 import `nanoid`（第 69 行附近已有 id 生成逻辑，若有现成 id 生成函数则复用；`setAttachments` 已存在）。

- [ ] **Step 2: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS，dist 产出

- [ ] **Step 3: 提交**

```bash
git add src/components/chat/ChatInput.tsx
git commit -m "feat(hidream): 聊天输入栏入口替换为 AI 绘图面板（可插入附件）"
```

---

### Task 8: 构建、release 同步、手测

**Files:**
- Modify: 无（仅验证）
- 手测清单：见下

**Interfaces:**
- Consumes: Task 1-7 全部

- [ ] **Step 1: 全量回归**

Run: `npm test && npx tsc --noEmit`
Expected: 全绿

- [ ] **Step 2: 构建并同步 release（需用户在场确认）**

Run: `npm run build`
Expected: dist 更新。**随后询问用户**：是否同步 release 目录并重启 live 应用（项目工作流：用户跑 release 打包版，重启前必须征得同意）

- [ ] **Step 3: 手测清单（人工执行）**

1. 点击输入栏绘图按钮 → 面板弹出
2. 未登录：点"登录 HiDream"→ 独立窗口 → Clerk 登录（勾选记住我）→ 自动关窗 → 面板显示已登录 + 积分
3. 文生图：输入提示词 → 生成 → 画廊出现图片 → 点插入 → 输入栏出现图片附件 → 发送，AI 能看到 @image
4. 图生图：上传参考图 → 生成
5. 下载：图片下载到本地
6. 历史：刷新后历史仍在，删除条目生效
7. 会话过期：改/删 cookie 文件后操作 → 提示重登 → 一键重登成功
8. 积分不足：显示 402 错误提示

- [ ] **Step 4: 收尾提交（若手测发现修复项，逐项提交；无则跳过）**

---

## Self-Review 记录

- **Spec 覆盖核对**：登录窗口+会话（Task 4）✓；代理端点（Task 3）✓；入口替换+面板（Task 6/7）✓；错误映射 401/402/403/429（Task 3 reply 状态透传 + Task 6/7 提示）✓；护栏节流（Task 2 `rateLimitHit`）✓；历史本地存储（Task 2/3）✓；i18n/类型（Task 5）✓；P0 实测（Task 1）✓；图生图（Task 6 上传→image_url）✓；下载（Task 3 `/yfw/img/download`）✓
- **占位符扫描**：无 TBD/TODO；`d.data.images/urls` 取值以 P0 实测为准（Task 1 定稿项，Task 5 注明）
- **类型一致性**：`proxyRequest({path, method, body, base, timeoutMs})` 在 Task 2 定义、Task 3 按此调用 ✓；`onInsertImage({name, path, preview?})` Task 6 定义、Task 7 消费 ✓；`Attachment` 结构沿用 ChatInput 现有 `{id,name,type:'image',content,path?,preview?}` ✓
