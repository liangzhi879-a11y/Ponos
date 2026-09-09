# GUI 交互升级实施计划（认证小窗 → 加载屏 boot → 驾驶舱 → 三段式工作界面）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 GUI 冷启动与一级导航重排为「**认证先行（独立小登录窗）** → **认证后加载屏(boot)** → **驾驶舱(iframe 汇总屏)** → **三段式工作界面（对话/任务两模式、effort 接线、现场持久化）**」（spec 2026-09-08 增补认证前置 D11-D13，见下方变更记录；登录不再作为主窗口视图）。

**Architecture:** 主进程冷启动**先建独立认证小窗**（`?auth=1`，弹窗级尺寸），首设/登录通过后渲染层发 IPC `auth:granted` → 主进程关小窗并创建主窗口（1100×720）；主窗口视图状态机 **`boot → cockpit → work`（无 login）**，zustand persist 中 view 永不跳过 boot（boot 门禁，spec §7）；驾驶舱 = 改造版银河原型（`public/cockpit/index.html`）经 postMessage 注入总览数据/主题并回传 hub-click；工作界面 = rail(lucide) + 二级面板 + 主区；会话加 `mode:'chat'|'task'`，chat 会话在 bridge 侧以受限工具集 spawn 内核；effort 档位由 bridge 注入 env 并支持 WS 热切换。

**Tech Stack:** React 18 + TS + zustand + Tailwind + framer-motion + lucide-react；Node `node:http` bridge；kernel 不改核心。测试：`node --test`（server `*.test.mjs`；GUI 纯函数 `src/lib/*.test.ts`，Node 24 strip-types，相对导入必须带 `.ts` 扩展）。

## Global Constraints

- **不修改** `kernel/` 任何文件；`electron/main.cjs` 只允许加认证相关的 window 能力（如无必要则不动）。
- GUI 纯函数单测：不 import zustand store、不用 `@` alias、只 import type；相对导入显式带 `.ts`。
- 新增 UI 图标一律 lucide-react；**同一语义图标全应用内唯一，禁止 emoji 作图标**（对照 Task 15 图标查重表）。
- 文案进 i18n（`src/i18n/translations/zh-CN.ts` 与 `en-US.ts` 同形）；不硬编码中文到组件。
- 新样式只吃现有 CSS 变量（`--bg-app/--text-primary/--accent-default/--border-default` 族），不新增独立色板。
- `settings.speedMode` 为 true 时：主窗口**跳过 boot 直接 cockpit**（认证小窗不受影响）；驾驶舱 iframe 收 `speedMode` 停动画。
- 测试与构建命令：`npm run typecheck`、`npm run build`、`npm test`（server/electron）；GUI 纯函数手动 `node --test src/lib/<x>.test.ts`。
- 每 Task 独立可测、独立 commit；commit message 遵循仓库风格（`feat|fix|docs(gui-ux): …`）。

---

## 变更记录（2026-09-08 认证前置 D11-D13 —— Task 6b 实施后为 Task 7-15 的新基线）

用户三项决策已落文（spec D1/D11-D13 与 §1/§2/§7/架构总览，spec commit `b900c2c`）：
**登录先行**（冷启动先出现登录页，认证过后应用才加载资源）、**boot=认证后的加载屏**（主窗口认证后才创建并以 boot 开场，不再是冷启动首屏）、**独立小登录窗**（弹窗级尺寸独立 BrowserWindow；非主窗口缩放、非主窗内卡片）。主窗口保留 1100×720。

> **裁决**：凡本计划下文（Task 1-6 已提交代码与原文、Task 7-15 步骤）与下列新目标形态冲突，**一律以本变更记录 + spec 为准**。Task 1-6 已提交的「boot→login→cockpit→work 四段机」形态由 **Task 6b** 统一重构（Task 4-6 原文中对 login 视图的依赖视为已被 6b 取代，不逐行回改历史任务文本）。

Task 6b 交付后立即生效、**Task 7-15 必须消费**的新基线：

1. **窗口编排（electron/main.cjs，仅加认证相关 window 能力，非认证主体结构不动）**
   - 冷启动主进程**先建认证小窗**：独立 BrowserWindow，原生 frame、非透明、固定 ~420×560、主屏居中、`show:false` 等 `ready-to-show`；加载同 dist 的 `?auth=1`（dev `loadURL(devUrl+'?auth=1')` / prod `loadFile(dist,{query:{auth:'1'}})`，仿现有 editorWin `?editor=1` 先例 `main.cjs:876-926`）。**主窗口此时不创建**。
   - 认证通过：渲染层发 IPC `auth:granted` → 主进程关小窗、调现有 `createWindow()` 建主窗口（透明/主题判定原样复用）。小窗在未放行前被关闭 → 主窗口从未创建则**退出应用**（`app.quit()`，不经 window-all-closed 的 tray 保留分支）。
   - `bootStartAt` 重置与 `did-finish-load → bootPhase('windowLoad')` 挂接从"启动即 createWindow"（现 `main.cjs:1504-1539`）移到 auth:granted 放行后 `createWindow()` 前/后，保持 60s 启动兜底弹窗窗口语义。
2. **主窗口视图机收敛（src/lib/viewStore.ts、ViewRouter.tsx）**
   - `AppView = 'boot' | 'cockpit' | 'work'`（**删 'login'**）。ViewRouter：`boot && !speed` → `<BootScreen onDone={() => useViewStore.getState().setView('cockpit')} />`；`boot && speed` → 同帧渲染 cockpit 分支 + effect 把 view 置 'cockpit'（替换现 LoginView 短路）；`cockpit` → CockpitScreen（Task 8 前仍 CockpitPlaceholder）；`work` → AppShell。login 分支删除。
   - **boot 门禁（spec §7）**：persist `partialize` 仍只落 'cockpit'|'work' 与 workState；`merge` **恒定 `view: current.view`（即 'boot'）**——persist 的 view 永不跳过 boot（主窗口每次认证后从加载屏起）；workState.rail 恢复逻辑保留（合法 rail union 校验）。`normalizeStoredView` 的 login 归一语义作废：函数删除，改导出纯函数 `sanitizeRail(rail)`（4 个合法值透传，其余→'task'）供单测与 merge 共用；`viewStore.test.ts` 全部改写（原断言 login 归一用例删除）。T5 parked 的「空存储保留 current 'boot'」merge 修正自然并入新语义。
3. **AuthScreen/SetupWizard 成功路径改 IPC（src/components/auth/）**
   - 两组件**不再 `useViewStore.setView('cockpit')`**（认证小窗渲染它们，主窗口不再渲染）；成功（login ok / setup 即解锁）→ `window.yfworkingWindow?.authGranted?.()`。preload 在 `yfworkingWindow` 增 `authGranted: () => ipcRenderer.send('auth:granted')`。
4. **App.tsx 路由（src/lib/authWindow.ts + src/components/auth/AuthWindowRoot.tsx）**
   - 仿 `isEditorWindow()`（`editorBridge.ts:6-8`）增 `isAuthWindow()`（`?auth=1`），真分支渲染 `<TooltipProvider><AuthWindowRoot/></TooltipProvider>`（内含 AuthScreen，整窗深色品牌底自适应小窗），**不加载 MainApp/ViewRouter**。auth 窗口与主窗同 partition/localStorage，但 auth 窗口不 import viewStore。
5. **bridge CORS 预检补全（auth 窗口 POST 前置依赖，server/bridge.mjs:1151-1152）**
   - OPTIONS 现只回 `Access-Control-Allow-Origin`，缺 `Access-Control-Allow-Methods`/`-Headers` → renderer（file:// 或 vite localhost:5173）对 `/api/auth/setup|login` 的 `application/json` POST 预检失败。Task 6b 在 OPTIONS 分支补 `Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type`（白名单式），并加 `server/*.test.mjs` 用例断言预检 204 响应头（沿用 Task 3 端点冒烟的 bridge 启动 recipe）。
6. **文案/语义微调**：spec §2.1/2.4 已同步——token 仅端点语义预留、GUI 不落盘 token（放行以 IPC 事实为准）、无 remember checkbox（Task 6 已按此实现，勿在后续任务新增自动登录 UI）。

受影响的后续任务步骤（已就地修补）：Task 8 Step 5 冒烟起点（登录）与 Task 15 Step 3 冒烟清单第 1 条已改写为「认证小窗 → 主窗口 boot → cockpit」。Task 14 Step 2 跨重启冒烟的"登录后"表述即指认证小窗放行后，无需改步骤本身。

---

### Task 1: boost logo 透明导出管线

**Files:**
- Create: `scripts/export-boost-logo.mjs`
- Create: `public/logo/boost-logo-light.png`、`public/logo/boost-logo-dark.png`（或由脚本产出；脚本不能产出时，见步骤 4）
- Read: `YF/boost-logo.ai`（PDF 1.6 头）

**Interfaces:**
- Consumes: `YF/boost-logo.ai`
- Produces: `BOOST_LOGO` 资源路径常量约定（后续 Task 统一引用 `public/logo/boost-logo-*.png`）

- [ ] **Step 1: 探测本机可用转换器**

Run: `python -c "import fitz; print('pymupdf ok')" 2>&1 | head -1; which gs mutool 2>/dev/null; echo done`
Expected: 至少一项可用则走自动；全无 → Step 3。

- [ ] **Step 2: 写导出脚本 `scripts/export-boost-logo.mjs`**

优先 pymupdf：渲染 `YF/boost-logo.ai` 首页 → RGBA PNG（透明底）+ 白底深色图、黑底浅色图各一；渲染尺寸 ≥1024。实现要点（脚本骨架）：
```js
// scripts/export-boost-logo.mjs —— 用法: node scripts/export-boost-logo.mjs
// 1) 找 python；2) 内联 python 脚本: import fitz; doc=fitz.open(ai); pg=doc[0];
//    mat=fitz.Matrix(4,4); 逐层渲染成带 alpha 的 PNG（若首页整页不透明，退化处理见下）
// 3) 另存 public/logo/boost-logo-light.png / boost-logo-dark.png（若单一透明版则两版同文件）
// 输出两文件即成功（exit 0），否则 exit 2 并打印原因
```
若整页透明无法得到（渐变/白底铺满）：白底原样输出作 light 版；深色版用后处理把近白像素变透明（阈 ~245）再贴到品牌深色上。脚本内保留两策略并打印用哪条。

- [ ] **Step 3: 运行并校验**

Run: `node scripts/export-boost-logo.mjs && ls -la public/logo/`
Expected: exit 0；两 PNG 存在。用 Read 工具打开 `public/logo/boost-logo-light.png` 人工目检：无白底/无裁切/边缘干净。不合格 → 调整 Step 2 策略重跑一次；仍不合格 → Step 4。

- [ ] **Step 4: 用户导出兜底**

若自动导出质量不可接受：向用户说明并请求用 Illustrator 从 `YF/boost-logo.ai` 导出透明底 PNG（≥1024px、深色/浅色各一），放入 `public/logo/boost-logo-light.png`、`public/logo/boost-logo-dark.png`。未到位前 Task 5/6/8 使用现有 `public/logo.png` 占位（不阻塞）。此步完成后写一行说明到本文件末尾"资产记录"。

- [ ] **Step 5: Commit**

```bash
git add scripts/export-boost-logo.mjs public/logo/
git commit -m "feat(gui-ux): boost logo 透明导出管线 + public/logo 资产（boot/login/cockpit 共用）"
```
> 若 Step 4 走用户导出且文件未到：仍提交脚本与文档位，commit 照常（占位资产不 commit 空目录，改在 .gitkeep）。

---

### Task 2: server/auth.mjs（口令哈希/状态机，纯模块 + TDD）

**Files:**
- Create: `server/auth.mjs`
- Test: `server/auth.test.mjs`

**Interfaces:**
- Consumes: 无（Node `node:crypto` 原生）；`process.env.YFW_AUTH_FILE` 覆盖存储路径（测试用）
- Produces（Task 3 消费）:
  - `getAuthStatus(): Promise<{ phase: 'uninitialized' | 'locked' | 'ok'; lockedForMs?: number }>`
  - `setupPassword(password: string): Promise<void>`（仅 `uninitialized` 可用，否则 throw；口令长度 ≥4；成功后 fail 计数清零）
  - `checkPassword(password: string): Promise<{ ok: true } | { ok: false; reason: 'bad-password'; lockedForMs: number | null }>`
- 存储：`YFW_AUTH_FILE`（默认 `<YFW_HOME>/auth.json`）`{ version:1, salt, hash, failCount, lockedUntil? }`，scrypt（`crypto.scryptSync` 32B、`randomBytes(16)` 盐、`N:16384`），**永不写明文口令**。连续 5 次失败 → `lockedUntil = now+30s`；成功登录清零。

- [ ] **Step 1: 写失败测试** `server/auth.test.mjs`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAuthStatus, setupPassword, checkPassword } from './auth.mjs'

function freshFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-auth-'))
  process.env.YFW_AUTH_FILE = join(dir, 'auth.json')
  t.after(() => { delete process.env.YFW_AUTH_FILE; rmSync(dir, { recursive: true, force: true }) })
}

test('未初始化 phase=uninitialized', async (t) => {
  freshFile(t)
  assert.deepEqual(await getAuthStatus(), { phase: 'uninitialized' })
})

test('setup 后 phase=ok，checkPassword 正确口令通过/错误口令拒绝', async (t) => {
  freshFile(t)
  await setupPassword('hello123')
  assert.equal((await getAuthStatus()).phase, 'ok')
  assert.deepEqual(await checkPassword('hello123'), { ok: true })
  assert.equal((await checkPassword('wrong')).ok, false)
})

test('错误 5 次进入锁定，锁定期内拒绝', async (t) => {
  freshFile(t)
  await setupPassword('hello123')
  for (let i = 0; i < 5; i++) await checkPassword('wrong')
  const st = await getAuthStatus()
  assert.equal(st.phase, 'locked')
  assert.ok(st.lockedForMs > 0)
  assert.equal((await checkPassword('hello123')).ok, false) // 锁定中即使口令对也拒
})

test('auth.json 不存明文口令', async (t) => {
  freshFile(t)
  await setupPassword('hello123')
  const raw = (await import('node:fs')).readFileSync(process.env.YFW_AUTH_FILE, 'utf8')
  assert.ok(!raw.includes('hello123'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/auth.test.mjs`
Expected: FAIL（模块不存在：`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3: 实现 `server/auth.mjs`**

```js
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_FAILS = 5
const LOCK_MS = 30_000

function authPath() {
  if (process.env.YFW_AUTH_FILE) return process.env.YFW_AUTH_FILE
  return join(process.env.YFWORKING_HOME || join(homedir(), '.yfworking'), 'auth.json')
}
function readState() {
  try { return JSON.parse(readFileSync(authPath(), 'utf8')) } catch { return null }
}
function writeState(s) { writeFileSync(authPath(), JSON.stringify(s, null, 2)) }
function hashOf(password, salt) {
  return scryptSync(String(password), salt, 32, { N: 16384 }).toString('hex')
}
function locked(state) {
  const lu = state && state.lockedUntil
  if (!lu) return null
  const left = lu - Date.now()
  return left > 0 ? left : null
}

export async function getAuthStatus() {
  const st = readState()
  if (!st || !st.hash) return { phase: 'uninitialized' }
  const left = locked(st)
  if (left != null) return { phase: 'locked', lockedForMs: left }
  return { phase: 'ok' }
}
export async function setupPassword(password) {
  const cur = await getAuthStatus()
  if (cur.phase !== 'uninitialized') throw new Error('auth: already initialized')
  if (String(password).length < 4) throw new Error('auth: password too short')
  const salt = randomBytes(16).toString('hex')
  writeState({ version: 1, salt, hash: hashOf(password, salt), failCount: 0, lockedUntil: 0 })
}
export async function checkPassword(password) {
  const st = readState()
  if (!st || !st.hash) throw new Error('auth: not initialized')
  const left = locked(st)
  if (left != null) return { ok: false, reason: 'bad-password', lockedForMs: left }
  const ok = st.salt && timingSafeEqual(Buffer.from(hashOf(password, st.salt), 'hex'), Buffer.from(st.hash, 'hex'))
  const failCount = ok ? 0 : (st.failCount || 0) + 1
  writeState({ ...st, failCount, lockedUntil: ok ? 0 : (failCount >= MAX_FAILS ? Date.now() + LOCK_MS : st.lockedUntil || 0) })
  if (!ok && failCount >= MAX_FAILS) return { ok: false, reason: 'bad-password', lockedForMs: LOCK_MS }
  return ok ? { ok: true } : { ok: false, reason: 'bad-password', lockedForMs: null }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/auth.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add server/auth.mjs server/auth.test.mjs
git commit -m "feat(gui-ux): server/auth.mjs——scrypt 口令哈希/状态机/锁定（node:test）"
```

---

### Task 3: bridge HTTP `/api/auth/*` 端点

**Files:**
- Modify: `server/bridge.mjs`
- Test: `server/auth-endpoint.test.mjs`（可选 smoke，见 Step 3）

**Interfaces:**
- Consumes: Task 2 的 `getAuthStatus/setupPassword/checkPassword`
- Produces（Task 4 消费）: HTTP 端点语义与 token 规则；bridge 内存 token 表 `authTokens = new Map<string, number/*expiry*/>()`（TTL 24h；重启即清 → 每次启动都需口令，符合决策）
  - `GET  /api/auth/status` → 200 `{ phase, lockedForMs? }`
  - `POST /api/auth/setup` body `{ password }` → 200 `{ ok:true }` | 400/409 `{ error }`
  - `POST /api/auth/login` body `{ password }` → 200 `{ ok:true, token }` | 401 `{ ok:false, error, lockedForMs? }`
  - `POST /api/auth/logout` body `{ token }` → 200 `{ ok:true }`
- 生产（GUI）只依赖这四个路径；token 由 GUI 持有（localStorage），本机 /status 语义里**不做** token 免密判定（每次启动都要口令），token 仅作为未来服务端换用的占位。

- [ ] **Step 1: 定位 HTTP if-chain 插入点**

确认 `server/bridge.mjs` 的 handler：在 `reply`/`origin` 检查之后、现有 `/health` 分支（约 L1317）前后加分支（if-chain 顺序不影响）。`readJsonBody` 已存在（约 L27-33）。

- [ ] **Step 2: 实现四个分支 + 顶部引入 auth 模块**

顶部 import：`import { getAuthStatus, setupPassword, checkPassword } from './auth.mjs'`。
token 表模块级常量：`const authTokens = new Map()`；小工具 `issueToken()`（`randomBytes(24).toString('hex')`，存 `authTokens.set(t, Date.now()+86_400_000)`）与 `hashTokenHeader` 不需要（token 未启用校验，先占位注释）。

handler 分支（置于 `if (url.pathname === '/health')` 分支之前或之后均可）：
```js
if (url.pathname === '/api/auth/status') {
  const st = await getAuthStatus()
  return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify(st))
}
if (url.pathname === '/api/auth/setup' && req.method === 'POST') {
  const { password } = await readJsonBody(req).catch(() => ({}))
  try { await setupPassword(password); return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true })) }
  catch (e) { return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: e?.message || String(e) })) }
}
if (url.pathname === '/api/auth/login' && req.method === 'POST') {
  const { password } = await readJsonBody(req).catch(() => ({}))
  try {
    const r = await checkPassword(password)
    if (r.ok) return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, token: issueToken() }))
    const code = r.lockedForMs != null ? 423 : 401
    return reply(code, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: r.reason, lockedForMs: r.lockedForMs ?? null }))
  } catch (e) { return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: e?.message || String(e) })) }
}
if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
  const { token } = await readJsonBody(req).catch(() => ({}))
  if (token) authTokens.delete(token)
  return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
}
```
`issueToken` 定义放模块内（near `sessions` Map 区）：
```js
import { randomBytes } from 'node:crypto'
const authTokens = new Map() // token -> expiry（重启清空）
function issueToken() { const t = randomBytes(24).toString('hex'); authTokens.set(t, Date.now() + 86_400_000); return t }
```

- [ ] **Step 3: 端点冒烟**

启动 bridge（`YFW_BRIDGE_PORT` 用高位避免撞正在跑的真实端口，如 55991，`YFW_AUTH_FILE` 指向临时文件）：
Run（后台）: `YFW_BRIDGE_PORT=55991 YFW_AUTH_FILE=$(mktemp -d)/auth.json YFW_BRIDGE_NO_LISTEN= node server/bridge.mjs &` 后依次
Run: `curl -s localhost:55991/api/auth/status` → `{"phase":"uninitialized"}`
Run: `curl -s -X POST localhost:55991/api/auth/setup -H 'content-type: application/json' -d '{"password":"pass1234"}'` → `{"ok":true}`
Run: `curl -s -X POST localhost:55991/api/auth/login -H 'content-type: application/json' -d '{"password":"pass1234"}'` → `{ok:true,token:"…"}`
Run: `curl -s -X POST localhost:55991/api/auth/login -H 'content-type: application/json' -d '{"password":"bad"}'` → 401
之后杀掉该后台进程（记录 pid 精确 kill）。另注意：本机可能已有真实 bridge 在 51517 跑着——测试端口 55991 不冲突。

- [ ] **Step 4: Commit**

```bash
git add server/bridge.mjs
git commit -m "feat(gui-ux): bridge /api/auth/* 端点（status/setup/login/logout，scrypt 本地校验）"
```

---

### Task 4: viewStore 状态机 + authApi + authStore

**Files:**
- Create: `src/stores/viewStore.ts`
- Create: `src/lib/authApi.ts`
- Test: `src/lib/viewStore.test.ts`（归约纯函数可选；见 Step 1 是否拆分）
- Modify: `src/stores/chatStore.ts`（仅 `persist` version bump 触发迁移留待 Task 11；本任务不改会话）

**Interfaces:**
- Consumes: Task 3 端点语义
- Produces:
  - `type AppView = 'boot' | 'login' | 'cockpit' | 'work'`
  - `viewStore`：`{ view: AppView, workState: { rail: RailId; } }` + actions `setView(view)`、`enterWork(rail?)`；persist key `'yfworking-view'`，partialize `{ view, workState }`。**view 落盘值只在 'cockpit' | 'work' 间持久**；'boot'/'login' 不入 persist（rehydrate 若读到 boot/login 归一到 'login'）。
  - `authApi.ts`：`authStatus()/authSetup(pw)/authLogin(pw)/authLogout()`（fetch `getBridgeUrl()/api/auth/*`，错误统一 throw/返回结构化结果）
  - `authStore`：`{ phase: 'unknown'|'uninitialized'|'locked'|'ok'|'setup-done', lockedForMs, error?, pending }` + `init()`（拉 status）、`setup(pw)`、`login(pw)`、`logout()`；persist 不需要（token 本机 bridge 每次启动失效）

- [ ] **Step 1: 类型与归约纯函数**

在 `src/stores/viewStore.ts` 顶部定义：
```ts
export type AppView = 'boot' | 'login' | 'cockpit' | 'work'
export type RailId = 'chat' | 'task' | 'agents' | 'skills'
export interface WorkState { rail: RailId }
export function normalizeStoredView(v: unknown): AppView { return v === 'cockpit' || v === 'work' ? v : 'login' }
```
（`normalizeStoredView` 便于单测：`src/lib` 不引，写在本文件顶部导出即可。）

- [ ] **Step 2: 单测 `src/stores/viewStore.test.ts`（若含纯逻辑）**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStoredView } from './viewStore.ts'
test('持久化 view 归一', () => {
  assert.equal(normalizeStoredView('work'), 'work')
  assert.equal(normalizeStoredView('cockpit'), 'cockpit')
  assert.equal(normalizeStoredView('boot'), 'login')
  assert.equal(normalizeStoredView('login'), 'login')
  assert.equal(normalizeStoredView(undefined), 'login')
})
```
Run: `node --test src/stores/viewStore.test.ts` → PASS
> 注意 import './viewStore.ts' 会连带执行 zustand `create(persist(...))`——为可测性，把 `normalizeStoredView` 与 zustand create 放同文件但测试仅 import 该函数仍会执行整模块副作用；若执行失败，则把该函数移到 `src/lib/viewUi.ts` 并在 store 中 import。以实际 node 运行结果为准（若模块级 zustand 在 node 下可安全 import 则留在同文件）。

- [ ] **Step 3: 实现 viewStore**

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
export type AppView = 'boot' | 'login' | 'cockpit' | 'work'
export type RailId = 'chat' | 'task' | 'agents' | 'skills'
export interface WorkState { rail: RailId }
interface ViewState {
  view: AppView
  workState: WorkState
  setView: (v: AppView) => void
  enterWork: (rail?: RailId) => void
}
export function normalizeStoredView(v: unknown): AppView { return v === 'cockpit' || v === 'work' ? v : 'login' }
export const useViewStore = create<ViewState>()(
  persist((set) => ({
    view: 'boot',
    workState: { rail: 'task' },
    setView: (view) => set({ view }),
    enterWork: (rail) => set({ view: 'work', workState: { rail: rail ?? 'task' } }),
  }), {
    name: 'yfworking-view',
    partialize: (s) => ({ view: s.view, workState: s.workState }),
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as { view?: unknown; workState?: Partial<WorkState> }
      return {
        ...current,
        view: normalizeStoredView(p.view),
        workState: { rail: (p.workState?.rail === 'chat' || p.workState?.rail === 'task' || p.workState?.rail === 'agents' || p.workState?.rail === 'skills') ? p.workState.rail : 'task' },
      }
    },
  }),
)
```

- [ ] **Step 4: authApi + authStore**

`src/lib/authApi.ts`（fetch 域，可引 `@/lib/config`）：
```ts
import { getBridgeUrl } from '@/lib/config'
export interface AuthStatusResp { phase: 'uninitialized' | 'locked' | 'ok'; lockedForMs?: number }
export interface AuthResult { ok: boolean; token?: string; error?: string; lockedForMs?: number | null }
async function post(path: string, body: unknown): Promise<AuthResult> {
  try {
    const res = await fetch(`${getBridgeUrl()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error, lockedForMs: data.lockedForMs }
    return data
  } catch (e) { return { ok: false, error: String(e) } }
}
export function authStatus(): Promise<AuthStatusResp> { return fetch(`${getBridgeUrl()}/api/auth/status`).then(r => r.json()).catch(() => ({ phase: 'ok' })) }
export const authSetup = (password: string) => post('/api/auth/setup', { password })
export const authLogin = (password: string) => post('/api/auth/login', { password })
export const authLogout = (token?: string) => post('/api/auth/logout', { token })
```
`src/stores/authStore.ts`：
```ts
import { create } from 'zustand'
import { authStatus, authLogin, authSetup, type AuthStatusResp } from '@/lib/authApi'
export type AuthPhase = 'unknown' | AuthStatusResp['phase'] | 'setup-done'
interface AuthState {
  phase: AuthPhase; lockedForMs: number | null; pending: boolean; error: string | null
  init: () => Promise<void>
  setup: (pw: string) => Promise<boolean>
  login: (pw: string) => Promise<boolean>
  setPhase: (p: AuthPhase) => void
}
export const useAuthStore = create<AuthState>((set) => ({
  phase: 'unknown', lockedForMs: null, pending: false, error: null,
  async init() { const st = await authStatus(); set({ phase: st.phase, lockedForMs: st.lockedForMs ?? null }) },
  async setup(pw) { set({ pending: true, error: null }); const r = await authSetup(pw); set({ pending: false }); if (!r.ok) { set({ error: r.error ?? 'fail' }); return false } set({ phase: 'setup-done' }); return true },
  async login(pw) { set({ pending: true, error: null }); const r = await authLogin(pw); set({ pending: false }); if (!r.ok) { set({ error: r.error ?? 'fail', lockedForMs: r.lockedForMs ?? null }); return false } set({ phase: 'ok' }); return true },
  setPhase(p) { set({ phase: p }) },
}))
```
**注意**：bridge 尚未（Task 3 后才有端点）；本任务可在端点后按序开发。authStatus 失败 catch 返回 `phase:'ok'`——这是 dev/无 auth 环境的宽容语义（**用户明确要"先做好本地端口和 UI"，端点失效时不卡启动**，见 Task 6 Step 交互）。

- [ ] **Step 5: Commit**

```bash
git add src/stores/viewStore.ts src/lib/authApi.ts src/stores/authStore.ts src/stores/viewStore.test.ts
git commit -m "feat(gui-ux): view 状态机 + authApi/authStore（端点语义对齐 /api/auth/*）"
```

---

### Task 5: BootScreen 启动动画 + AppShell 视图路由 + LogoMorph 过渡原语

**Files:**
- Create: `src/components/boot/BootScreen.tsx`
- Create: `src/components/boot/LogoMorph.tsx`
- Create: `src/styles/boot.css`（或并入 globals.css；新建文件便于引用）
- Modify: `src/App.tsx`（MainApp 内把 `AppShell` 替换为按 `viewStore.view` 渲染的 `ViewRouter`）
- Create: `src/components/layout/ViewRouter.tsx`（路由宿主；Login/Cockpit 组件尚未实现，先用占位壳，Task 6/8 填充）

**Interfaces:**
- Consumes: Task 4 `useViewStore`；Task 1 `public/logo/boost-logo-*.png`（未到位用 `logo.png` 占位）
- Produces:
  - `<BootScreen onDone: () => void>`（动画完成回调，由 ViewRouter 决定下一屏）
  - `<LogoMorph>`：包一层 overlay 过渡；`<LogoMorphTrigger>` 语义通过 props 实现——用 `motion` 复制一份 logo 到 fixed overlay（读取源元素 `getBoundingClientRect`），按 direction 做 tween；`target: DOMRect | 'top-left'`。
  - `ViewRouter`：`switch(view)` → `boot`=`<BootScreen>`；`login`/`cockpit`/`work` 各渲染对应（未实现前占位文本 + 临时按钮可跳转用于冒烟）

- [ ] **Step 1: BootScreen 组件**

视觉要求：全屏深色品牌底（渐变 `#17110b→#0f0b07`，与驾驶舱同族，后续主题兼容可覆盖）；中央 boost logo（`/logo/boost-logo-light.png` 兜底 `logo.png`）宽 ≤180px、呼吸/光晕（CSS keyframes 光晕 `box-shadow`/`filter drop-shadow` 脉冲 2.4s）；logo 下方流光进度条（细条圆角，内部 `linear-gradient(90deg, transparent, #FF8A3D, #FF4200, #FFB27D, transparent)` 背景位移循环 `background-position` 或 transform 扫光；外层容器宽 240px h 3px）。底部阶段小字（三个状态循环：`正在启动桥接… / 校验运行环境… / 准备就绪`，用 400ms 间隔由进度伪推进）。动画总时长按 Task 顺序在 `useEffect` 定时 ~1.6s 后 `onDone()`；组件内部 **不做** network 等待（决策：装饰动画）。`settings.speedMode` 时不挂载此屏（ViewRouter 直接跳 login，见 Step 3）。

代码骨架：
```tsx
export function BootScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 1600)
    return () => window.clearTimeout(t)
  }, [onDone])
  return (
    <div className="h-full w-full flex flex-col items-center justify-center relative overflow-hidden boot-bg">
      <img src={BOOST_LOGO_LIGHT} alt="YFWorking" className="boot-logo" draggable={false} />
      <div className="boot-track"><div className="boot-shine" /></div>
      <div className="mt-3 text-xs boot-phase">启动中…</div>
    </div>
  )
}
```
`BOOST_LOGO_LIGHT` 常量放 `src/lib/assets.ts`：`export const BOOST_LOGO_LIGHT = `${import.meta.env.BASE_URL}logo/boost-logo-light.png``，同文件给 dark 版常量；且做存在性兜底不可行（静态路径）——Task 1 占位未到时两常量临时指向 `/logo.png`（Task 1 完成后改回，见 Task 15 收口检查）。

`boot.css`（三种动画：`.boot-logo` 呼吸 + `.boot-shine` 扫光循环 + 深色底）。变量一律透明主题无关；速度模式由 ViewRouter 层不挂载处理，不写 `.speed-mode .boot-*`。

- [ ] **Step 2: LogoMorph 过渡原语**

```tsx
// LogoMorph.tsx —— 用法：<LogoMorph from: HTMLElement|null toKey:'top-left'|'hub' onDone/> 由调用方在过渡开始前从 DOM 取 rect。
// 实现要点：
// 1. createPortal 到 body；fixed inset-0 z-[120] pointer-events-none。
// 2. 从 srcImg（同屏 logo 元素）拿 rect；渲染 <motion.div> 内含同一 <img src={logo}/>，animate={{ x,y,width,height,opacity }}。
// 3. toKey==='top-left' → 目标 = 48px 角标位(Header logo)；'hub' → 屏幕中心 92px。
// 4. spring/tween ~420ms；结束后调 onDone()，由 ViewRouter 切换 view 并卸载 overlay。
// 5. 反向（work→cockpit）同样调用：source=header logo rect，target='hub'。
// props: { src: string; fromRect: DOMRect; to: 'top-left' | 'hub'; onDone: () => void }
// 组件内部维护 mounted state；anim 完成后 onDone。
```
给出可直接落盘的实现要点（见上注释），具体 tween 数值：放大 `scale` 交叠由 width/height 动画自然达成；附加 `filter: brightness(1.6)` 中段光晕（可用 `animate={{ filter: [...] }}` 简单两点）。

- [ ] **Step 3: ViewRouter + App.tsx 接线 + speedMode 短路**

`src/components/layout/ViewRouter.tsx`：
```tsx
export function ViewRouter() {
  const view = useViewStore(s => s.view)
  const speed = useSettingsStore(s => s.settings.speedMode)
  const ready = view !== 'boot' || speed
  useEffect(() => { if (view === 'boot' && speed) useViewStore.getState().setView('login') }, [view, speed])
  if (view === 'boot' && !speed) return <BootScreen onDone={() => useViewStore.getState().setView('login')} />
  if (view === 'login') return <AuthScreen />   // Task 6 提供；本任务先用占位组件（内部根据 authStore.phase 显示占位按钮组）
  if (view === 'cockpit') return <CockpitScreen />  // Task 8 提供；先占位
  return <AppShell />  // work
}
```
修改 `App.tsx`：`MainApp` 内 `return (<TooltipProvider><ViewRouter/></TooltipProvider>)`（AppShell 原在 ViewRouter 的 work 分支渲染，外层的 settings/pet 同步 useEffect 保持在 MainApp 不动）。
占位（本 Task）：`src/components/boot/PlaceholderScreens.tsx` 导出 `AuthPlaceholder`/`CockpitPlaceholder`——纯文字 + 「下一步」按钮切 view，用于无头联调（Task 6/8 替换）。

- [ ] **Step 4: 冒烟**

Run: `npm run typecheck` 通过。Run: `npm run build` 通过。
手动（起 `npm run dev`，`npm run electron` 连真实后端）：启动出现 Boot 动画（若未 speedMode），~1.6s 后落到 login 占位；占位按钮可切 cockpit/work 占位；speed-mode 时直接跳过 boot。未连 bridge 时（无 auth 端点）authStatus catch→ok，登录占位仍可点穿（后续 Task 6 决定落点）。

- [ ] **Step 5: Commit**

```bash
git add src/components/boot src/components/layout/ViewRouter.tsx src/styles/boot.css src/lib/assets.ts src/App.tsx
git commit -m "feat(gui-ux): BootScreen 启动动画 + ViewRouter 视图路由 + LogoMorph 过渡原语"
```

---

### Task 6: SetupWizard + AuthScreen 登录 UI

**Files:**
- Create: `src/components/auth/AuthScreen.tsx`（依 authStore.phase 分支：uninitialized→向导；locked→锁定提示；ok→密码表单）
- Create: `src/components/auth/SetupWizard.tsx`
- Create: `src/components/auth/PasswordField.tsx`（可见性切换/回车/错误抖动共用）
- Modify: `src/i18n/translations/zh-CN.ts`、`en-US.ts`（auth.* 键组）
- Replace: `src/components/boot/PlaceholderScreens.tsx` 中 AuthPlaceholder（ViewRouter 引 AuthScreen）

**Interfaces:**
- Consumes: Task 4 `useAuthStore`/`authApi`；Task 1 logo；Task 5 ViewRouter（view=login 时渲染本屏）
- Produces: 认证完成动作约定 —— **login/setup 成功后**调用 `useViewStore.getState().setView('cockpit')`（带一次 logo 过渡到 cockpit 中央 hub：可选，见 LogoMorph 用法注释，本屏直接 setView 亦可，过渡在 Task 8 驾驶舱进/出统一实现）。生产语义：每次启动需登录（bridge token 不持久）。

- [ ] **Step 1: i18n 键**

在 zh-CN.ts 加 `auth: { title:'欢迎使用 YFWorking', subtitle:'输入本机口令以继续', passwordLabel:'口令', show:'显示', hide:'隐藏', login:'进入驾驶舱', setupTitle:'设置本机访问口令', setupHint:'此口令用于本机启动解锁，仅存于本地。', confirmLabel:'确认口令', mismatch:'两次输入不一致', tooShort:'口令至少 4 位', error:'口令错误，请重试', locked:'尝试过多，请等待 {seconds} 秒后重试', remember:'登录后进入驾驶舱' }`（en-US 同形英文）。t 调用走 `useTranslation`。

- [ ] **Step 2: PasswordField**

受控组件 `{ label, value, onChange, error?, onEnter, autoFocus? }`；右眼 Button（lucide `Eye`/`EyeOff`，**应用内首次使用该二图标，无重复**）；错误时 `animate-[shake_.3s]`（在 globals 加 keyframes `shake` 或 tailwind arbitrary，选择加 css keyframes 于 boot.css 更普适——新建 `shake` keyframe 于 globals.css，注释用途）与红边框。

- [ ] **Step 3: SetupWizard + AuthScreen**

`AuthScreen`：
```tsx
export function AuthScreen() {
  const phase = useAuthStore(s => s.phase)
  const init = useAuthStore(s => s.init)
  useEffect(() => { void init() }, [])   // mount 时拉 status（含锁定剩余）
  if (phase === 'uninitialized') return <SetupWizard />
  if (phase === 'locked') return <LockedView />   // 显示 lockedForMs 倒计时 + 自动刷新按钮（每 1s 递减本地 state，归零重 init()）
  return <LoginView />
}
```
`SetupWizard`：两枚 PasswordField + 提交按钮；校验（长度 ≥4、两次一致）→ `authStore.setup(pw)` 成功 → `setView('cockpit')`；失败显示 error。完成后在 DOM 上提示"设置成功"并可再进 LoginView？—— 语义统一为 setup 即视作已解锁：成功后直接 `setView('cockpit')`。
`LoginView`：单 PasswordField + 主按钮（pending 禁用转圈）+ enter 提交；`login` 失败按 error/lockedForMs 提示，423 → 切 LockedView。
视觉：居中玻璃卡（复用现有 `--popover-bg/blur` 变量风格）+ logo 上方居中（复用 `.boot-logo` 呼吸）。背景与 Boot 一致的深色底，**但主题应跟随**：外层容器 class 用 `bg-app text-primary`，由 AppShell 现有主题 effect 仍在 MainApp 生效覆盖 html 背景——确认 login 屏在 `ViewRouter` 下仍在 `<TooltipProvider>` 与 MainApp 的 effect 作用域内（App.tsx 原 MainApp 主题 effect 保留在 App.tsx 不随 AppShell 移动？——AppShell 内主题 effect 在 AppShell 组件（现渲染在 work 分支）。**登录屏需要在非 work 也有主题变量生效**：把主题 effect 上移到 ViewRouter（本 Task 改造）：将 AppShell.tsx 中 L184-201 的主题/字体/glass/极速 effect 迁移到 `ViewRouter.tsx` 顶层执行（MainApp 同样可用），保证 boot/login/cockpit/work 全部吃同一主题系统。

- [ ] **Step 4: 冒烟**

`npm run typecheck` 通过；`npm run build` 通过。dev+electron 手测：首启（临时 HOME 无 auth.json，或先 `rm` 测试 auth 文件）→ uninitialized 向导；两次不一致提示；设置成功 → 落到 cockpit 占位。杀掉 bridge 后重开 → status catch → ok → 直接 LoginView，错误口令有抖动/锁定文案。（bridge 崩溃宽容语义按 Step 3 catch 已实现；**若开发期不想每次登录**：把 authStatus 的 catch 宽容与 setup/login 走本地文件即可，无需特判。）

- [ ] **Step 5: Commit**

```bash
git add src/components/auth src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts src/components/layout/ViewRouter.tsx src/components/boot/PlaceholderScreens.tsx src/styles/globals.css
git commit -m "feat(gui-ux): 登录/首设口令屏——SetupWizard + AuthScreen + 主题 effect 上移 ViewRouter"
```

---

### Task 6b: 认证小窗编排 + 主窗口视图机收敛（D11-D13 基线）

> 本任务是 spec 2026-09-08 增补 D11-D13 的落点（见文件顶部「变更记录」）。它**重构 Task 5/6 已提交的 boot→login 交棒与 AuthScreen 落点**，交付后即为 Task 7-15 的窗口/视图/认证基线。改动以「变更记录」1-6 条为验收标准；**不得改动 createWindow() 主体逻辑与 kernel/**。

**Files:**
- Modify: `electron/main.cjs`（认证小窗编排 + 启动顺序 + `auth:granted` IPC；非认证主体结构不动）
- Modify: `electron/preload.cjs`（`yfworkingWindow.authGranted`）
- Modify: `server/bridge.mjs:1151-1152`（OPTIONS 预检响应头补全）
- Create: `server/auth-preflight.test.mjs`（或并入 Task 3 已建的端点冒烟测试族，视其结构复用）
- Create: `src/lib/authWindow.ts`（`isAuthWindow()`）
- Create: `src/components/auth/AuthWindowRoot.tsx`
- Modify: `src/App.tsx`（`?auth=1` 分支，仿 `?editor=1`）
- Modify: `src/components/auth/AuthScreen.tsx`、`SetupWizard.tsx`（成功→ `authGranted()` IPC，去 useViewStore）
- Modify: `src/stores/viewStore.ts` + `src/stores/viewStore.test.ts`（AppView 去 login、boot 门禁 merge、`sanitizeRail`）
- Modify: `src/components/layout/ViewRouter.tsx`（删 login 分支；boot 交棒 cockpit）

**Interfaces:**
- Consumes: Task 1 logo 资产；Task 2/3 auth 端点；Task 4 authStore/authApi + viewStore（将被本任务重构）；Task 5 BootScreen/ViewRouter；Task 6 AuthScreen/SetupWizard/PasswordField；spec §2.0/§7；本文件「变更记录」。Task 3 的端点冒烟 bridge 启动 recipe 见 `.superpowers/sdd/2026-09-08-gui-onboarding-cockpit-redesign/task-3-report.md`
- Produces（Task 7-15 消费）:
  - preload：`yfworkingWindow.authGranted(): void`（send `auth:granted`）
  - main.cjs：`createAuthWindow()`；启动先建认证小窗、收 `auth:granted` 后建主窗口；冷启动小窗未放行被关 → 退出应用
  - viewStore：`AppView = 'boot'|'cockpit'|'work'`；`sanitizeRail(rail): RailId`；merge 恒定 `view:'boot'`（boot 门禁），workState.rail 恢复
  - ViewRouter：无 login 分支；`boot && !speed` → `<BootScreen onDone={() => useViewStore.getState().setView('cockpit')} />`；`boot && speed` → 同帧渲染 cockpit 分支 + effect 置 'cockpit'
  - bridge：OPTIONS 预检回 `Access-Control-Allow-Methods`/`Access-Control-Allow-Headers`

- [ ] **Step 1（TDD）: bridge OPTIONS 预检响应头 + 测试**

先读 Task 3 端点冒烟测试的 bridge 启动/等待/清理 recipe（`server/auth-endpoint.test.mjs` 或 Task 3 实际产物，路径见 `task-3-report.md`）。写失败测试（无对应文件则新建 `server/auth-preflight.test.mjs`；有可复用 helper 则直接 import）：
```js
test('OPTIONS 预检回显 origin + 允许 methods/headers（renderer POST 依赖）', async () => {
  // 起 bridge（随机 YFW_BRIDGE_PORT + 临时 YFW_AUTH_FILE，避免污染真实 auth.json）
  // const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
  //   method: 'OPTIONS', headers: {
  //     origin: 'http://localhost:5173',
  //     'access-control-request-method': 'POST',
  //     'access-control-request-headers': 'content-type',
  //   } })
  // 断言：status 204；Access-Control-Allow-Origin 含 localhost；
  //       Access-Control-Allow-Methods 含 'POST'；Access-Control-Allow-Headers 小写含 'content-type'
  // finally 清理 bridge 子进程
})
```
Run: `node --test server/auth-preflight.test.mjs`
Expected: FAIL（现 OPTIONS 分支 `bridge.mjs:1151-1152` 只回 origin，无 methods/headers）。

实现：`bridge.mjs` OPTIONS 分支补头（白名单式，不引入任意来源）：
```js
if (req.method === 'OPTIONS') {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  reply(204, {}); return
}
```
Run 同测试：PASS。

- [ ] **Step 2（TDD）: viewStore 收敛 + boot 门禁 + `sanitizeRail`**

改写 `src/stores/viewStore.ts`：
```ts
export type AppView = 'boot' | 'cockpit' | 'work'
export type RailId = 'chat' | 'task' | 'agents' | 'skills'
export const RAIL_IDS: readonly RailId[] = ['chat', 'task', 'agents', 'skills']

/** 落盘 rail 清洗：4 合法值透传，非法/缺省 → 'task'（供 merge 与单测）。 */
export function sanitizeRail(rail: unknown): RailId {
  return RAIL_IDS.includes(rail as RailId) ? (rail as RailId) : 'task'
}
```
`create` 内 merge 改为：
```ts
partialize: (s) => {
  const out: Partial<ViewState> = { workState: s.workState }
  if (s.view === 'cockpit' || s.view === 'work') out.view = s.view  // boot 不入 persist（spec §7）
  return out
},
merge: (persisted, current) => {
  const p = (persisted ?? {}) as { workState?: { rail?: unknown } }
  // boot 门禁：persist 的 view 永不恢复——主窗口每次认证后从 'boot' 起（spec §7），
  // 只恢复工作区 rail；persist 的 view 字段（仅 cockpit|work）为信息性记录。
  return { ...current, view: current.view, workState: { rail: sanitizeRail(p.workState?.rail) } }
},
```
删除 `normalizeStoredView`（login 归一语义作废）。改写 `src/stores/viewStore.test.ts`（原断言删净）：
```ts
import { sanitizeRail, RAIL_IDS } from './viewStore.ts'
test('sanitizeRail：4 合法值透传，非法/缺省回退 task', () => {
  for (const ok of RAIL_IDS) assert.equal(sanitizeRail(ok), ok)
  assert.equal(sanitizeRail(undefined), 'task')
  assert.equal(sanitizeRail('nope'), 'task')
  assert.equal(sanitizeRail(42), 'task')
})
```
Run: `node --test src/stores/viewStore.test.ts` → PASS。`npm run typecheck` 无 AppView='login' 残留引用（grep 全仓库）。

- [ ] **Step 3: ViewRouter 去 login 分支**

`src/components/layout/ViewRouter.tsx` 目标形态（保留现有主题两个 effect 原样；删 AuthScreen import 与 login 分支；注释头更新为 D11-D13 语义）：
```tsx
if (view === 'boot' && speed) return <CockpitPlaceholder />  // effect 同步落 'cockpit'（speed 跳加载屏）
if (view === 'boot' && !speed) return <BootScreen onDone={() => useViewStore.getState().setView('cockpit')} />
if (view === 'cockpit') return <CockpitPlaceholder />  // Task 8 替换为 CockpitScreen
return <AppShell /> // work
```
并更新 `useEffect` 里 `view==='boot' && speed` 的 `setView('login')` → `setView('cockpit')`。原注释「boot/login/cockpit 三态」等旧描述一并修正。

- [ ] **Step 4: App.tsx 路由 + authWindow lib + AuthWindowRoot**

`src/lib/authWindow.ts`（仿 `editorBridge.ts`，不引 zustand/UI）：
```ts
// 认证小窗（独立 BrowserWindow ?auth=1）：与主应用同 partition/localStorage，
// 只渲染 AuthScreen 完成首设/登录，成功后经 IPC auth:granted 交主进程开主窗口。
export function isAuthWindow(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('auth') === '1'
}
```
`src/components/auth/AuthWindowRoot.tsx`：
```tsx
// 认证小窗宿主（?auth=1）：AuthScreen 自带整窗深色品牌底/卡片，按 ~420×560 小窗自适应。
import { TooltipProvider } from '@/components/ui'
import { AuthScreen } from './AuthScreen'
export function AuthWindowRoot() {
  return (
    <TooltipProvider>
      <AuthScreen />
    </TooltipProvider>
  )
}
```
`src/App.tsx` 在 `isEditorWindow()` 分支前加：
```tsx
if (isAuthWindow()) return <AuthWindowRoot />  // 认证小窗不加载 MainApp/ViewRouter
```
（是否需要 TooltipProvider 以 AuthWindowRoot 内已包为准，App 层不必重复。）

- [ ] **Step 5: AuthScreen/SetupWizard 成功路径改 IPC**

两文件**删除 `useViewStore` import 与 setView 调用**；新增放行动作（小窗内唯一语义）：
```ts
/** 认证通过（login ok / setup 即解锁）→ 通知主进程关小窗、开主窗口（spec §2.0）。 */
const grant = () => { window.yfworkingWindow?.authGranted?.() }
```
`AuthScreen.tsx` `LoginView.submit` 成功分支 `useViewStore.getState().setView('cockpit')` → `grant()`；`SetupWizard.tsx` `submit` 成功分支同样替换。文件头注释更新为「由 AuthWindowRoot（?auth=1 小窗）渲染；认证通过发 IPC auth:granted，主进程接管窗口切换」。

- [ ] **Step 6: preload 暴露 `authGranted`**

`electron/preload.cjs` `yfworkingWindow` 对象加：
```js
// 认证小窗：认证通过 → 主进程关小窗、创建主窗口（spec §2.0 / Task 6b）
authGranted: () => ipcRenderer.send('auth:granted'),
```

- [ ] **Step 7: main.cjs 认证窗编排**

先通读 `main.cjs` 窗口相关现状：`createWindow()`（~465-568）、`registerRendererErrorCapture`、`registerIpc()`（内部含 editorWin/doubao 等 `ipcMain` 注册）、`whenReady`（~1504-1553）、`activate`（~1583-1585）。改动点：
1. 在 `createWindow` 附近加模块级 `let authWin = null`、`let authGranted = false` 与 `createAuthWindow()`：
```js
// 认证小窗（spec §2.0/D13；Task 6b）：冷启动先建，主窗口在 auth:granted 后才创建。
function createAuthWindow() {
  authWin = new BrowserWindow({
    width: 420, height: 560, resizable: false, title: 'YFWorking',
    icon: ICON_PATH, show: false, backgroundColor: '#171109',  // 与 AuthScreen 深色底一致防闪白
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  authWin.once('ready-to-show', () => { authWin?.center(); authWin?.show() })
  authWin.on('closed', () => {
    authWin = null
    // 冷启动小窗未放行即被关（主窗口从未创建）→ 退出应用，不经 tray 保留分支
    if (!authGranted && (!mainWindow || mainWindow.isDestroyed()) && !isQuitting) app.quit()
  })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) authWin.loadURL(devUrl + '?auth=1')
  else authWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { auth: '1' } })
}
```
2. `registerIpc()` 内注册（与既有 `ipcMain` 同级）：
```js
ipcMain.on('auth:granted', () => {
  authGranted = true
  const w = authWin
  authWin = null
  if (w && !w.isDestroyed()) w.close()
  if (!mainWindow || mainWindow.isDestroyed()) {
    bootStartAt = Date.now()   // 刷新 60s 启动兜底弹窗窗口基线
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () => bootPhase('windowLoad'))
  }
})
```
3. `whenReady` 启动段：`createWindow()` 与其后的 `mainWindow?.webContents.once('did-finish-load', ...)` 两行替换为 `createAuthWindow()`；`createTray()`/pet/browser 接线位置不动。
4. `activate` handler 改：`if (BrowserWindow.getAllWindows().length === 0) { if (authGranted) createWindow(); else createAuthWindow() }`。
5. 检查 `app.quit()` 触发 before-quit 会 `killBridge/killPet`（现状即有），认证小窗场景无需额外清扫。
> 若实际代码结构（如 registerIpc 位置、bootPhase/bootStartAt 可见性）与上述行号有出入，以通读后真实结构为准，保持改动最小。

- [ ] **Step 8: 冒烟 + 提交**

Run: `npm run typecheck`、`npm test`、`node --test src/stores/viewStore.test.ts server/auth-preflight.test.mjs`、`npm run build`。
手动（`npm run dev` + `npm run electron`，连真实后端）：
1. 冷启动**只弹认证小窗**（~420×560 原生边框、主屏居中），主窗口不创建；
2. 首设口令成功 → 小窗关、主窗口开（boot 加载屏 → cockpit 占位）；
3. 再次启动 → 小窗登录页；错口令抖动、连错 5 次 → 锁定倒计时；**锁定期内关小窗 → 应用整体退出**（进程消失）；
4. 未放行直接关小窗 → 应用退出；
5. DevTools：login/setup POST 无 CORS 预检失败；主窗 localStorage `yfworking-view` 无 'boot' 落盘、workState 正常；boot 每次认证后播放（persist 'work' 也不跳过）；
6. speedMode=true → 主窗跳过 boot 直落 cockpit 占位；托盘开关下关主窗 → 隐藏托盘、恢复照旧。

```bash
git add electron/main.cjs electron/preload.cjs server/bridge.mjs server/auth-preflight.test.mjs src/lib/authWindow.ts src/components/auth/AuthWindowRoot.tsx src/App.tsx src/components/auth/AuthScreen.tsx src/components/auth/SetupWizard.tsx src/stores/viewStore.ts src/stores/viewStore.test.ts src/components/layout/ViewRouter.tsx
git commit -m "feat(gui-ux): 认证小窗编排（D11-D13）——?auth=1 独立登录窗 + auth:granted IPC + 主窗口视图机收敛 boot→cockpit→work"
```

---

### Task 7: 驾驶舱原型数据驱动改造（public/cockpit/index.html）

**Files:**
- Create: `public/cockpit/index.html`（由 `YF/驾驶舱原型/驾驶舱原型.html` 复制后改造；**原文件不改**）
- Read: `YF/驾驶舱原型/驾驶舱原型.html`（913 行）

**Interfaces:**
- Consumes: 无运行期依赖（独立 HTML+JS）
- Produces（Task 8 消费的契约，需与 Task 8 同步实现）:
  - **iframe→父**：`parent.postMessage({ type: 'yfw:hub-click' }, '*')`；`parent.postMessage({ type: 'yfw:ready' }, '*')`
  - **父→iframe**：`window.postMessage({ type: 'yfw:theme', mode: 'light' | 'dark', speedMode: boolean }, '*')`；`window.postMessage({ type: 'yfw:overview', data }, '*')`
  - overview data shape（Task 8 汇总）：
    `{ runningTasks: { title, status: 'exec'|'wait'|'idle', progress?: number, meta?: string }[], agents: { id, role, state: 'run'|'idle'|'think'|'review' }[], usage: { token: string, requests: string, costUsd: string }, skills: { count: number, sample: string[] }, health: { engine: string, kernel: string } }`

- [ ] **Step 1: 复制与首帧主题 query**

`cp 'YF/驾驶舱原型/驾驶舱原型.html' public/cockpit/index.html`。head 预置主题脚本（原 L390-393 附近读 localStorage）改为读 URL query：`const _t = new URLSearchParams(location.search).get('theme'); documentElement.classList.add(_t==='dark'?'theme-dark':'theme-light')`（保留 localStorage 兜底）。本文件顶部 `<style>` 内联不动（iframe 自带样式，不与 GUI 冲突）。

- [ ] **Step 2: 消息桥（脚本区顶部）**

新增（放在 `buildStations` 之前）：
```js
let cockpitData = null; let cockpitSpeed = false;
const host = window.parent;
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return
  const d = e.data || {}
  if (d.type === 'yfw:theme') {
    applyTheme(d.mode === 'light' ? 'light' : 'dark')
    setSpeed(d.speedMode === true)
  } else if (d.type === 'yfw:overview') { cockpitData = d.data || null; renderStations(); if (panelOpen && lastModule) renderPanel(lastModule) }
})
function setSpeed(on){ cockpitSpeed = on; document.documentElement.classList.toggle('cockpit-speed', on) }
function notifyHost(type){ try { host.postMessage({ type }, '*') } catch (e) {} }
function ready(){ notifyHost('yfw:ready') }
```
`renderPanel(id)` = 原 `openPanel` 的 body 填充部分（见 Step 4）。

- [ ] **Step 3: 首帧后广播 ready + 默认速度**

原启动脚本尾部（`layout(); requestAnimationFrame(frame);` 之前）加 `window.addEventListener('load', () => setTimeout(ready, 0))`，并 `setSpeed(false)` 初值。若 `document.readyState==='complete'` 立即发。

- [ ] **Step 4: 卡片与详情浮层改注入数据**

- `buildStations`（原 L532-553）保持生成六 station（glyph/name/sub），但 `.mx` 与 sub 文案改为从 `cockpitData` 取：把 `renderStations()` 抽出——若无 cockpitData，用各站静态默认 meta（原字串）。卡片 html 生成处保留（含 click → openPanel）。
- `openPanel` 拆分：标题段（panelName/panelIdx/…）照旧；body 改走 `renderPanel(m.id)`：
  - `sessions`：展示 cockpitData.runningTasks（status exec/wait/idle → `.c-run/.c-wait/.c-idle` chip，参照原 html 配色类）
  - `tasks`：同上加进度 bar（progress）
  - `agents`：cockpitData.agents 列表（类 `.agent` 样式沿用原）
  - `kb`：cockpitData.skills（count + sample 列表行）
  - `usage`：cockpitData.usage 三数值 → `.stats` 结构；chart 条形用 sample 数据降级（无 chart 数据时画 7 日占位柱并加 note「运行期数据由主程序注入」）
  - `settings`：保留原静态开关/下拉演示（只读占位，note 改「偏好请在主程序设置中修改」）
  - 无对应注入键 → 显示 note「等待主程序注入数据」。
- 替换/删除原 `PANEL_HTML` 内硬编码"占位演示数据"文案与假数值（保留结构函数）。

- [ ] **Step 5: hub 语义改造 + 主题联动原样保留**

- 原 L842 `hub.addEventListener('click', closePanel)` → 改为：
```js
document.getElementById('hub').addEventListener('click', () => { if (panelOpen) { closePanel(); return } notifyHost('yfw:hub-click') })
```
（面板开着先关；关闭态点击即上报进入工作界面。）
- `.tseg` 主题按钮原实现（写 localStorage + applyTheme）保留，但同时向父广播：在 `applyTheme` 内末尾加 `notifyHost('yfw:theme-change')`（可选，父可不听）；父驱动走 message 分支。**iframe 内部 localStorage 与 GUI 同源共享**（dev http 同源；electron file:// 下 localStorage 受限——首帧主题以 query 为主，避免对 localStorage 依赖）。
- 面板背景/veil 等不动。

- [ ] **Step 6: 静态冒烟**

在 vite dev server 或 `python -m http.server` 同目录起静态服务打开 `public/cockpit/index.html?theme=dark`：六站渲染、点站开面板、hub 点触发关闭面板。无父注入时不应报错。浏览器控制台无异常。
> 由于 postMessage 冒烟需父页面，完整联调放 Task 8 Step 5。

- [ ] **Step 7: Commit**

```bash
git add public/cockpit/index.html
git commit -m "feat(gui-ux): cockpit 原型数据驱动版——postMessage 注入/主题/speedmode + hub 上报"
```

---

### Task 8: CockpitScreen（iframe 容器 + 数据注入 + 过渡接线）

**Files:**
- Create: `src/components/cockpit/CockpitScreen.tsx`
- Create: `src/components/cockpit/useCockpitOverview.ts`（汇总数据源 hook）
- Replace: `src/components/boot/PlaceholderScreens.tsx` CockpitPlaceholder（ViewRouter 引 CockpitScreen）
- Modify: `src/components/layout/ViewRouter.tsx`（cockpit 分支渲染 + 保活）

**Interfaces:**
- Consumes: Task 4 viewStore；Task 7 iframe 契约；`usageApi.fetchUsage`、`chatStore.streamingConversations/conversationProgress`、`agentStore`、`/skills`（经 `fetchBridgeConfig` 不行——skills 有专门端点？现状 GUI 无直接 fetch /skills 的 lib——可在 hook 内直接 `fetch(getBridgeUrl()+'/skills')`），`diag`（`window.yfwDiag.getBootSummary` 可选，缺省用 '—'）
- Produces: 进/出驾驶舱过渡触发点：Work→Cockpit（Header logo 点击，Task 9 消费）与 Cockpit→Work（本屏 hub-click 触发 `useViewStore.enterWork(savedRail)`）。**Hub logo 与 header logo rect 的采集**：ViewRouter 持有过渡状态 `morphTo: 'work'|'cockpit'|null` + rect 快照，加载 `<LogoMorph>` 完成动画后切 view。

- [ ] **Step 1: useCockpitOverview hook**

每 5s 轮询 + 每次 view==='cockpit' 立即拉一次；聚合为 Task 7 契约 shape；数据源防御（可能 undefined）。
```ts
export function useCockpitOverview(): OverviewData | null {
  const view = useViewStore(s => s.view)
  const [data, setData] = useState<OverviewData | null>(null)
  useEffect(() => {
    if (view !== 'cockpit') return
    let dead = false
    const load = async () => {
      const [usage, running] = await Promise.all([
        fetchUsage({ scope: 'today' }).catch(() => null),
        Promise.resolve(useChatStore.getState().streamingConversations),
      ])
      if (dead) return
      const convs = useChatStore.getState().conversations
      const runningTasks = Object.keys(running).filter(id => useChatStore.getState().conversations.find(c => c.id === id) && running[id] !== '__pending__').map(...) // status 按 streaming 状态映射 exec/idle；progress 取 conversationProgress[id]
      const agents = useAgentStore.getState().agents.slice(0, 6).map(a => ({ id: a.id, role: a.name || a.role || '', state: (a.status as any) || 'idle' }))
      const sk = await fetch(`${getBridgeUrl()}/skills`).then(r => r.json()).catch(() => null)
      const health = (window as any).yfwDiag?.getBootSummary ? await (window as any).yfwDiag.getBootSummary().catch(() => null) : null
      setData({ runningTasks, agents, usage: { token: fmt(usage?.totals?.tokens), requests: ... }, skills: { count: sk?.length ?? 0, sample: [] }, health: { engine: health?.engine ?? '—', kernel: health?.kernel ?? '—' } })
    }
    void load()
    const t = window.setInterval(load, 5000)
    return () => { dead = true; window.clearInterval(t) }
  }, [view])
  return data
}
```
> 字段名以 `usageUi.ts` 的 `UsageReport` 实字段为准（实施时核对：`fetchUsage({scope:'today'})` 返回结构与 `usageTotalsView` 入参），本 Task 只做轻聚合。`agents` 结构以 `agentStore`/AgentsPanel 实际字段为准核对后填。

- [ ] **Step 2: CockpitScreen 容器**

```tsx
export function CockpitScreen() {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const theme = useSettingsStore(s => s.settings.theme)
  const speed = useSettingsStore(s => s.settings.speedMode)
  const overview = useCockpitOverview()
  const themeMode = THEMES.find(t => t.id === theme)?.mode ?? 'dark'   // 'light'|'dark'
  useEffect(() => {
    const el = iframeRef.current
    el?.contentWindow?.postMessage({ type: 'yfw:theme', mode: themeMode === 'light' ? 'light' : 'dark', speedMode: speed }, '*')
  }, [themeMode, speed])
  useEffect(() => { iframeRef.current?.contentWindow?.postMessage({ type: 'yfw:overview', data: overview }, '*') }, [overview])
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data || {}
      if (d.type === 'yfw:hub-click') onHubClick()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  return (
    <div className="h-full w-full relative bg-app">
      <iframe ref={iframeRef} title="cockpit" src={`${import.meta.env.BASE_URL}cockpit/index.html?theme=${themeMode === 'light' ? 'light' : 'dark'}`} className="w-full h-full border-0" />
    </div>
  )
}
```
`onHubClick`（本组件内定义）：采集 hub 目标 rect（固定 `{left: innerWidth/2, top: innerHeight/2, width: 92, height: 92}`——iframe 内 hub 实位已知居中，直接用屏幕中心）→ 通知 ViewRouter 播放 LogoMorph（view 仍 cockpit）→ 动画完成 `useViewStore.getState().enterWork(savedRail)`。

- [ ] **Step 3: ViewRouter 过渡状态 + 保活**

ViewRouter 增加：
```ts
const [morph, setMorph] = useState<{ to: 'work' | 'cockpit'; fromRect: DOMRect } | null>(null)
```
- work 分支渲染 `<AppShell onGoCockpit={(rect) => setMorph({ to: 'cockpit', fromRect: rect })} />`（AppShell props 由 Task 9 加，先可选）
- cockpit 分支渲染 `<CockpitScreen onEnterWork={() => { const r = new DOMRect(innerWidth/2 - 46, innerHeight/2 - 46, 92, 92); setMorph({ to: 'work', fromRect: r }) }} />`
- `morph` 非空时额外渲染 `<LogoMorph ... onDone={...切 view...}>`。
- **iframe 保活**：work 与 cockpit 交替时**不卸载 iframe**——把 CockpitScreen 的 iframe 用 `display:none` 保持挂载（CockpitScreen 接 `active: boolean` prop，`active` 时可见且重发 theme/overview）。实现：ViewRouter 把 CockpitScreen 常驻渲染，视 view 决定 `active` 与是否显示 work 层。

- [ ] **Step 4: 占位替换与 i18n**

移除 CockpitPlaceholder；文案全部走已有 i18n 或组件内零文案（iframe 自带文案）。

- [ ] **Step 5: 联调冒烟**

`npm run typecheck`、`npm run build`。dev+electron 手测：认证小窗放行 → 主窗口 boot 交棒 → cockpit iframe 出现且数据 5s 刷新（开 DevTools console 看 overview 消息与渲染）；切主题 → iframe 同步 light/dark；speedMode → iframe 静止动画（`.cockpit-speed`）；点 hub（先关面板场景与直接场景）→ LogoMorph 过渡 → work 屏；work →（Header logo 尚未接 Task 9 前用临时按钮或 DevTools 调 `useViewStore.setView('cockpit')`）回 cockpit，iframe 无重载闪白（保活生效）。

- [ ] **Step 6: Commit**

```bash
git add src/components/cockpit src/components/layout/ViewRouter.tsx
git commit -m "feat(gui-ux): CockpitScreen——iframe 容器 + overview 注入 + hub 过渡接线 + 保活"
```

---

### Task 9: 三段式 WorkShell：rail + 布局重组 + Header logo 返回

**Files:**
- Create: `src/components/layout/WorkShell.tsx`（原 AppShell 主体逻辑迁入，新增 rail 列与二级面板容器）
- Create: `src/components/layout/RailNav.tsx`
- Create: `src/components/layout/SecondPanel.tsx`（面板宿主：按 rail 渲染对应内容；Task 10 填内容）
- Modify: `src/components/layout/AppShell.tsx`（瘦身为 WorkShell 薄壳或删除后由 ViewRouter 直用 WorkShell——选择：**新建 WorkShell，AppShell 停止被引用并从渲染树移除**（保留文件避免误删 import 链；若 typecheck 无引用则删除文件））
- Modify: `src/components/layout/Header.tsx`（props 增 `onGoCockpit?: (rect: DOMRect) => void`；logo 区改为点击钮触发）
- Modify: `src/stores/uiStore.ts`（`sidebarTab` 语义冻结停用不删；新增 rail 态放 viewStore.workState，**不用** uiStore.sidebarTab 迁移）

**Interfaces:**
- Consumes: Task 4 `useViewStore.workState.rail`/`enterWork`；现有 chat 全链路组件、AgentsPanel/SkillsPanel/FileBrowser/HistoryView/WorktreePanel/UsagePanel；uiStore 旧字段（文件预览等仍用）
- Produces: `WorkShell` 布局与 rail 行为；rail 图标/label 常量表（Task 15 查重引用）：
```ts
// src/components/layout/railMeta.ts
import { MessageSquare, SquareKanban, Bot, Puzzle, Settings } from 'lucide-react'
export const RAIL = [
  { id: 'chat', icon: MessageSquare, labelKey: 'rail.chat' },
  { id: 'task', icon: SquareKanban, labelKey: 'rail.task' },
  { id: 'agents', icon: Bot, labelKey: 'rail.agents' },
  { id: 'skills', icon: Puzzle, labelKey: 'rail.skills' },
] as const   // 设置独立在底部（Settings lucide）
export const railId = (id: string) => RAIL.some(r => r.id === id) ? (id as RailId) : 'task'
```

- [ ] **Step 1: railMeta + i18n 键**

`rail: { chat:'对话', task:'任务', agents:'智能体', skills:'技能' }`（zh/en）。图标如上常量。

- [ ] **Step 2: RailNav 组件**

垂直固定宽 **48px**（`w-12`），居中图标钮（`h-9 w-9 rounded-lg flex items-center justify-center text-secondary hover:bg-surface`，激活 `text-white bg-brand` 渐变品牌橙 `linear-gradient(135deg,#FF8A3D,#FF4200)` 或现有 brand 变量）。四项（chat/task/agents/skills，来自 RAIL）+ 顶部留白 + **底部 Settings**（lucide `Settings`，点击 `openSettings()`）。每个图标 `Tooltip`（labelKey）。点击 chat/task/agents/skills → `useViewStore.setState(s => ({ workState: { ...s.workState, rail: id } }))`。tooltip 方向右侧。
> 图标唯一性检查：`MessageSquare`（不再用于他处 Sidebar 对话 tab——Sidebar 退役）、`SquareKanban` 全库首次、`Bot`（Agents tab 原用，Task 10 面板内不复用 bot 图标表示同义即允许单点）、`Puzzle`（Skills 原用单点）、`Settings` 现 Header 已用（设置按钮）→ **冲突**！rail 设置与 Header 设置按钮同图标同语义（都是"设置"）—— 语义一致所以允许，但若严守"按钮功能不同则换"：Header 设置按钮保留、rail 底部不设设置图标（点击 Settings 由 Header 承担），RAIL 只 4 项 + 底部不放。**决定：rail 不放设置项**（设置入口仍 Header 齿轮），避免与 Header 重复。RailNav 只渲染 chat/task/agents/skills 四项。

- [ ] **Step 3: WorkShell 布局组装**

将 AppShell.tsx 结构（L203-410）重排：
```
<div h-full flex flex-col>
  <Header onGoCockpit />
  <div flex-1 flex min-h-0>
    <RailNav />                       // 常驻 48px
    <SecondPanel rail={rail} />       // 常驻 ~240px（宽度常量 SECOND_PANEL_W=240）
    <div flex-1 min-w-0 flex flex-col> // 原中心内容：ChatWindow/QuestionCard/ChatInput/欢迎
  </div>
  <StatusBar/>  + overlays 原样
</div>
```
工作区显示逻辑维持原 AppShell：`activeConversationId ? ChatWindow+... : 欢迎屏`（欢迎屏保留）。所有现有 hooks（经验提醒/极速/GPU 通知/快捷键/主题 effect 已在 Task 6 上移）——注意 Task 6 已将主题 effect 移到 ViewRouter；AppShell 原有 **sidebar 相关渲染与 toggle 移除**。快捷键 `mod+b`（toggleSidebar）改：不再 toggle（rail 常驻），改为无操作或切换 rail 焦点（**决定：移除 ⌘B 绑定**，保留注释）。
Header 需要去掉「Menu toggle」按钮（sidebar 不存在了）与标题逻辑不变；logo 点击区包按钮：`onClick={() => { const r = imgEl.getBoundingClientRect(); onGoCockpit?.(r) }}`。Header 内 logo img 加 `cursor-pointer`。

- [ ] **Step 4: SecondPanel 宿主**

`SecondPanel` 按 `workState.rail` 渲染占位内容区（Task 10 替换为真面板）：chat → `<ChatListPanel/>`、task → `<TaskListPanel/>`、agents → `<AgentsPanel/>`、skills → `<SkillsPanel/>`。首版可先用四占位（第二步在 Task 10 落）。

- [ ] **Step 5: 收尾与冒烟**

删除对 Sidebar 的 import（AppShell 由 WorkShell 取代）；typecheck 修复所有残留引用（Ctrl+N 等调用不变）。`npm run typecheck`、`npm run build`。dev 冒烟：进 work 屏 rail 四项切换正常、Header 无 Menu 按钮、logo 可点（若已接 Task 8 morph 则触发过渡回 cockpit；未接则先 console.log 调试）。

- [ ] **Step 6: Commit**

```bash
git add src/components/layout src/stores/uiStore.ts
git commit -m "feat(gui-ux): 三段式 WorkShell——rail + 二级面板宿主 + Header logo 返回接线"
```

---

### Task 10: 二级面板内容与旧 Sidebar 退役迁移

**Files:**
- Create: `src/components/rail/ChatListPanel.tsx`
- Create: `src/components/rail/TaskListPanel.tsx`
- Create: `src/components/rail/PanelToolbar.tsx`（面板通用头部：标题/计数/新建钮）
- Create: `src/components/rail/FilesHistoryOverlay.tsx`（次级浮层宿主：文件/历史/用量/工作树）
- Modify: `src/components/layout/SecondPanel.tsx`（替换占位为真面板）
- Delete（确认无引用后）: `src/components/layout/Sidebar.tsx`；迁移 chats 列表渲染与导出函数 `exportChats`（移入 ChatListPanel/TaskListPanel 共享模块 `src/lib/chatExport.ts`）

**Interfaces:**
- Consumes: `useChatStore`（conversations/streaming/progress/mode 等——mode 字段 Task 11 才落地，**本任务先行 UI、mode 过滤用`conv.mode=== 'chat'`运行时容错**（undefined 视为 task））；AgentsPanel/SkillsPanel/HistoryView/FileBrowser/UsagePanel/WorktreePanel 组件原样复用
- Produces: 面板切换语义 `secondTab`：对话/任务面板顶部另有「文件 / 历史 / 用量 / 工作树」次级图标钮 → 打开 FilesHistoryOverlay（浮在 SecondPanel 上方或主区右侧，取决于可用组件尺寸——FileBrowser 与 UsagePanel 较宽，**浮层用宽 420px 侧抽屉从 second panel 右缘滑出**，复用现有组件尺寸自适应）
- chat/task 过滤函数（纯逻辑，放 `src/lib/chatModeUi.ts` 供单测）：
```ts
export function isChatLike(c: { mode?: 'chat' | 'task' }): boolean { return c.mode === 'chat' }
export function isTaskLike(c: { mode?: 'chat' | 'task' }): boolean { return c.mode !== 'chat' }
```

- [ ] **Step 1: chatModeUi 纯函数 + 测试**

`src/lib/chatModeUi.ts` + `.test.ts`（沿用 usageUi 零依赖纪律）。测试覆盖 undefined→task。

- [ ] **Step 2: ChatListPanel**

从 Sidebar chats 分支逻辑改造：过滤 `isChatLike`；头部 `PanelToolbar`（标题 t('rail.chat') + 计数 + 「＋ 新建对话」按钮 lucide `MessageSquarePlus`——唯一）；列表项复用原 Sidebar 结构（标题/摘要/时间/流式光标）。点击会话 → `setActiveConversation(id)`；无会话空态文案（t('rail.chatEmpty')）与一键「开始对话」按钮（同样 `createConversation(undefined, undefined, 'chat')`——第三参 mode 在 Task 11 前传也安全，暂仅第二参 undefined；Task 11 后生效）。右键菜单/会话集功能**沿用任务面板**（聊天无会话集概念，简化：不做聊天右键菜单，删除/重命名仍可用简单内联，见下步的取舍）。

- [ ] **Step 3: TaskListPanel + 次级工具钮**

从 Sidebar chats 分支**完整迁移**（含搜索、整理 Wand2、排序、分组 pinned/sets/其它、右键菜单、拖动排序、运行中分组——运行中= `streamingConversations` 有键的会话置顶高亮并显示 ConversationProgress 条）。头部：PanelToolbar（标题 t('rail.task')、`＋ 新建任务` lucide `SquarePlus`）+ 右侧次级图标行（`FolderOpen`文件 / `History`历史 / `Gauge`用量 / `GitFork`工作树 四个 icon 按钮 → FilesHistoryOverlay，Tooltip 文案 t 化）。
导出函数 `exportChats` 从 Sidebar.tsx 移至 `src/lib/chatExport.ts` 导出（供右键导出沿用），Sidebar.tsx 删除前把引用接回 TaskListPanel。
**空态**：无任务 → 中央提示 + 「新建任务」按钮（触发原流程：现有新建带目录选择逻辑保留——`createConversation` 后若 cwd 缺省走 home，任务列表引导在输入框顶部显示 cwd 徽标，维持现状即可，不做新增目录弹窗）。

- [ ] **Step 4: SecondPanel 接线 + Agents/Skills 直连**

SecondPanel：`rail==='chat'→<ChatListPanel/>`、`'task'→<TaskListPanel/>`、`'agents'→<AgentsPanel/>`、`'skills'→<SkillsPanel/>`。四个 panel 组件自带内部滚动。

- [ ] **Step 5: Sidebar 删除与残留清理**

grep `Sidebar` 引用（AppShell/WorkShell 已不引；若有其它 import 如快捷导出/快捷键绑定引用 `exportChats` 已搬）→ 无引用后 `git rm src/components/layout/Sidebar.tsx`。同步清理 i18n `sidebar.*` 废弃键的**引用点**（保留键定义无碍，Task 15 收口统一清理）。

- [ ] **Step 6: 冒烟 + Commit**

typecheck/build；dev 冒烟：rail 四项面板切换、新建对话（进 chat 空列表点新建出现新对话——Task 11 前先以旧 createConversation 呈现于 chat 列表？**时序依赖**：Task 11 才落 mode。为不出现"chat 面板建出的会话出现在 task 面板"，本任务内 ChatListPanel 新建按钮在 mode 未落前先临时禁用并 tooltip「Task 11 后开放」或直接按序开发（先 Task 11 后 Task 10 更顺）。**执行顺序调整为：Task 11（mode 数据）先于 Task 10 UI 落地**。但文档编号保持，实际执行 writing-plans 时按注释顺序（Task 10 依赖 Task 11 字段）——若走 Task 顺序执行，Task 10 与 Task 11 合并为一个执行单元更稳妥。plan 注记：Task 10+11 可合并执行（subagent-driven 场景分派一次）。
Commit：
```bash
git add src/components/rail src/lib/chatModeUi.ts src/lib/chatModeUi.test.ts src/lib/chatExport.ts src/components/layout
git commit -m "feat(gui-ux): 二级面板内容（对话/任务列表）+ 次级浮层 + Sidebar 退役"
```

---

### Task 11: Conversation.mode 与 chat 受限会话数据通路

**Files:**
- Modify: `src/types/index.ts`（Conversation 增 `mode?: 'chat' | 'task'`）
- Modify: `src/stores/chatStore.ts`（createConversation 加 mode 参数；partialize 含 mode；persist version 2→3 迁移 undefined→task）
- Modify: `src/hooks/useYFWCLI.ts`（buildSendPayload 增 `mode`）
- Modify: `server/bridge.mjs`（getOrCreateSession 支持 mode；chat 模式 spawn 参数改造；WS send 分支透传 mode）
- Modify: `src/components/chat/ChatWindow.tsx`、`ChatInput.tsx`（模式徽标 UI，Task 13 的输入条一并处理——**徽标显示在本 Task 落**）

**Interfaces:**
- Consumes: Task 9 布局（会话在 work 主区渲染）
- Produces:
  - `Conversation.mode?: 'chat'|'task'`
  - `createConversation(cwd?: string, agentId?: string, mode: 'task' | 'chat' = 'task'): string`（向后兼容现调用）
  - send payload `{ ..., mode: 'chat'|'task'|undefined }`（undefined 由 bridge 按 task 处理）
  - **chat 受限 spawn 常量**（bridge 内）：
    `const CHAT_DISALLOWED = ['Bash','Read','Write','Edit','Glob','Grep','Agent','Task','TodoWrite','OCR','Vision','Skill','SkillSearch','Workflow','Browser','MemorySearch']`（保留 `WebFetch`,`WebSearch`）
  - chat 会话 cwd 语义：`conversation.cwd` 不设（undefined）；bridge `getOrCreateSession` chat 模式 spawn `cwd: YFW_HOME`（不 `--add-dir` cwd），并追加一次 `--disallowedTools <CHAT_DISALLOWED.join(',')>`（与既有 AskUserQuestion 分别 push；kernel 支持多段逗号分隔）
  - session 记录 `mode` 字段（复用判定时按已有 session 返回，mode 不会变）

- [ ] **Step 1: 类型 + 迁移 + 单测**

types/index.ts Conversation 增字段。chatStore createConversation 新签名与 set 内容（mode 落 Conversation）；partialize 白名单增 mode。persist migrate（version 3）：`(persisted) => 把 conversations 的 mode 缺省补 'task'`（chatStore 现有 `version:2`，见 L1195 附近；migrate 在 persist 配置中写，旧存储 version 2 → 3）。
mode 归约纯函数 `src/lib/chatModeUi.ts`（Task 10 已建）补测试无需新。
Run: `node --test src/lib/chatModeUi.test.ts`。

- [ ] **Step 2: buildSendPayload + WS send 透传**

useYFWCLI.ts buildSendPayload return 对象加 `mode: conversation.mode`（undefined 也带，bridge 容错）。bridge WS send case（~L2022 附近找到 `msg.type==='send'`）取 `const mode = msg.mode === 'chat' ? 'chat' : 'task'` 传入 getOrCreateSession 新参。

- [ ] **Step 3: bridge chat spawn 改造**

getOrCreateSession 签名：`(sid, cwd, resumeId, systemPrompt, model, compactCount, mode = 'task')`（末尾追加可选参，兼容调用点）。命令构造处：
- L806 之后追加：`if (mode === 'chat') { args.push('--disallowedTools', CHAT_DISALLOWED.join(',')) }`
- L855：`if (cwd && mode !== 'chat') args.push('--add-dir', q(cwd))`
- spawn 处 env 覆盖：`...(mode === 'chat' ? { CLAUDE_CODE_DISALLOWED_TOOLS: '' } : {})`（无意义可省）与 **cwd**：`cwd: (mode === 'chat' ? YFW_HOME : (cwd || process.cwd()))`（YFW_HOME 见 L126）。
- session 记录：`session.mode = mode`。
对话不可执行本地 = 内核注册表过滤（blocked）生效即实现（Tools 侧已确认 filtered 视图 + 执行拒绝）。chat transcript 落在 `projects/<YFW_HOME-sanitized>/…` 下自成一格不污染业务目录。

- [ ] **Step 4: 模式徽标 UI（ChatWindow 顶部条）**

新建 `src/components/chat/SessionModeBar.tsx`：读 `useChatStore` 当前会话 mode；渲染一行（h-7 浅底）：
- chat：lucide `MessagesSquare`（**或直接文字徽标**避免重复图标——决定：文字徽标「对话 · 纯聊 可联网 · 不执行本地」灰底圆角 chip）
- task：文字徽标「任务 · 可执行本地操作」品牌橙浅底
Task 13 会在同条右侧放 effort 选择器。挂在 ChatWindow 滚动区上方（系统条下方，见 L239-245 顺序）。
> 注：图标唯一性——本条全部用纯文字 chip 不引入图标。

- [ ] **Step 5: 冒烟 + Commit**

typecheck/build。dev 手测：新建对话（Task 10 按钮已可点）→ 发送提问 → bridge 日志可见 chat 会话 spawn 参数含 `--disallowedTools Bash,Read,…`；让内核列出 tools（system/init 帧的 tools 数组）确认只剩 WebFetch/WebSearch 等两三项；任务会话仍全工具。给 chat 发"删除本地某个文件/执行命令"验证被工具级拒绝（输出「工具已被禁用」类内容）。发送后 /api/usage 仍计该会话。
```bash
git add src/types src/stores/chatStore.ts src/hooks/useYFWCLI.ts server/bridge.mjs src/components/chat/SessionModeBar.tsx
git commit -m "feat(gui-ux): Conversation.mode(chat/task)——chat 受限 spawn(禁本地工具) + 模式徽标"
```

---

### Task 12: effort 接线（bridge env + WS 热切换）

**Files:**
- Modify: `server/bridge.mjs`（buildChildEnv 注入；WS 新 case）
- Modify: `src/stores/settingsStore.ts` + `src/types/index.ts`（AppSettings 增顶层 `effortLevel`，默认 'auto'；defaultSettings）
- Modify: `src/components/settings/SettingsView.tsx`（effort 下拉从 provider 字段迁到全局字段；标注 deprecated provider 级旧 select 移除）
- Create: `src/lib/effortUi.ts` + `src/lib/effortUi.test.ts`（纯函数：options 常量/名/映射 normalize 对齐内核）
- Modify: `src/hooks/useYFWCLI.ts`（新 `sendEffort(conversationId, level)` 上送 `{type:'effort', sessionId, level}`）

**Interfaces:**
- Consumes: 内核既有 effort 语义（`CLAUDE_CODE_EFFORT_LEVEL` env；`control_request { request: { subtype:'reasoning_effort', payload:{ value } } }`）
- Produces:
  - `effortUi.ts`：
    ```ts
    export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max'
    export const EFFORT_OPTIONS: { value: EffortLevel; labelKey: string }[] = [
      { value: 'auto', labelKey: 'effort.auto' }, { value: 'off', labelKey: 'effort.off' },
      { value: 'low', labelKey: 'effort.low' }, { value: 'medium', labelKey: 'effort.medium' },
      { value: 'high', labelKey: 'effort.high' }, { value: 'max', labelKey: 'effort.max' },
    ]
    export function normalizeEffortUi(v: string | null | undefined): EffortLevel {
      return EFFORT_OPTIONS.some(o => o.value === v) ? (v as EffortLevel) : 'auto'
    }
    ```
  - settings `AppSettings.effortLevel: EffortLevel`（顶层；**保留** per-provider effortLevel 字段不动以避免迁移噪音，只在 SettingsView 中改用全局）
  - WS 新上行：`{ type: 'effort', sessionId, level }`（level ∈ auto/off/low/medium/high/max → bridge 转内核时 medium 无需 pre-normalize，内核 normalize 处理 medium→high）
  - 每个新会话 spawn 时注入 env：`CLAUDE_CODE_EFFORT_LEVEL: <settings.effortLevel>`（值存 config.json 供 bridge 读：DEFAULT_CONFIG + `effortLevel:'auto'`；saveConfig 经 GUI `POST /config` 已整包保存 → GUI 把 effortLevel 并入 cfg 对象即可）

- [ ] **Step 1: effortUi 纯函数 + 测试**

`src/lib/effortUi.ts` + `.test.ts`：normalize 测试（null→auto、'medium'→medium、'bogus'→auto、'max'→max）。

- [ ] **Step 2: settings 顶层字段 + GUI 切换**

types：`AppSettings.effortLevel?: EffortLevel`。defaultSettings 加 `effortLevel: 'auto'`。SettingsView：Advanced 区旧 provider effortLevel select 删除，改「思考深度(新会话生效)」select 绑 `settings.effortLevel` → `updateSettings({ effortLevel: normalizeEffortUi(v) })`；文案 note「影响新会话与当前会话（见输入条热切）」。同步 config：SettingsView handleSave 拼 cfg 增 `effortLevel: settings.effortLevel`（POST /config）。**动态热切**：SettingsView select onChange 里同时调用 `sendEffort(activeConversationId, v)`（若会话在跑）。

- [ ] **Step 3: bridge env + DEFAULT_CONFIG + 新 WS case**

- DEFAULT_CONFIG（L265-272）加 `effortLevel: 'auto'`；loadConfig merge 自动带上（config 文件旧无 → 默认 auto）。
- buildChildEnv（~L674）在 ANTHROPIC 段前加：
  ```js
  const effort = cfg.effortLevel || 'auto'
  if (effort !== 'auto') env.CLAUDE_CODE_EFFORT_LEVEL = effort
  ```
  （`auto` 不注入，内核自身默认即 auto，语义等价且干净。）
- WS case（仿 cancel，约 L2040 附近）：
  ```js
  } else if (msg.type === 'effort') {
    const sid = msg.sessionId || lastSessionId || 'default'
    const s = sessions.get(sid)
    const level = String(msg.level ?? 'auto').trim()
    if (s && s.proc && !s.proc.killed && level) {
      try {
        s.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'effort-' + Date.now(), request: { subtype: 'reasoning_effort', payload: { value: level } } }) + '\n')
      } catch (e) { console.warn('[bridge] effort send failed:', e.message) }
    }
  }
  ```
  注意发送在会话存在与否都幂等（无会话时忽略），新会话由 env 注入兜底。
- sendEffort 前端（useYFWCLI.ts 新增导出）：
  ```ts
  export function sendEffort(conversationId: string | undefined, level: string) {
    const target = conversationId || lastSessionId || 'default'
    ws?.send(JSON.stringify({ type: 'effort', sessionId: target, level }))
  }
  ```

- [ ] **Step 4: 冒烟**

typecheck/build；node 冒烟：bridge 起测试口 55991，`curl` 无（WS 需 ws 客户端——用仓库既有 `ws` 依赖起 3 行脚本连 WS 发 effort 确认无异常）。dev+electron：会话 A 跑一个长任务，把 effort 从 auto 切 max，bridge stdout/内核日志可见 `reasoning_effort_updated` 系统事件回传（console）。新建会话 spawn env 含 `CLAUDE_CODE_EFFORT_LEVEL=max`（在 bridge 加临时 console 观察或查进程 env——观察 kernel `system/init` 前不泄漏 env；用 `--verbose` 输出佐证）。

- [ ] **Step 5: Commit**

```bash
git add server/bridge.mjs src/lib/effortUi.ts src/lib/effortUi.test.ts src/stores/settingsStore.ts src/types/index.ts src/components/settings/SettingsView.tsx src/hooks/useYFWCLI.ts
git commit -m "feat(gui-ux): effort 思考深度 GUI 接线——env 注入 + WS reasoning_effort 热切换 + 设置迁移"
```

---

### Task 13: 输入条快速 effort 选择器（对话/任务共用）

**Files:**
- Create: `src/components/chat/EffortPicker.tsx`（小弹层/下拉，EFFORT_OPTIONS；lucide `Gauge` 避免——决定用无图标文字钮「深度」+ 三角，避免 Gauge 与用量重复）
- Modify: `src/components/chat/SessionModeBar.tsx`（Task 11 建：右侧加 EffortPicker；读 settings.effortLevel + 本地选中态）
- Modify: `src/i18n/translations/zh-CN.ts`、`en-US.ts`（effort.* 键）
- Modify: `src/styles/globals.css`（下拉样式若需要，优先 tailwind 类）

**Interfaces:**
- Consumes: `settingsStore.settings.effortLevel`、`sendEffort`（Task 12）、`conversationId`
- Produces: 会话级 effort 状态显示：选中值持久化在全局 settings（一次设置全应用），显示用 settings.effortLevel；切档即时 `updateSettings` + `sendEffort(conversationId, v)`（热切当前会话）。

- [ ] **Step 1: i18n**

`effort: { auto:'自动', off:'关闭', low:'轻', medium:'标准', high:'深度', max:'最强', label:'思考深度' }`（en 同形）。选中等效映射说明放进 tooltip note：「标准=high（DeepSeek 映射）」。

- [ ] **Step 2: EffortPicker**

trigger：`<button>` 内文本 `t('effort.label')` + 当前档名 + lucide `ChevronDown`（ChevronDown 在 Header ThemeSwitcher 可能已用——确认现有 Header 下拉是否用 ChevronDown：是（Header L 附近 ThemeSwitcher）。语义都是"展开"→ 同图标同语义允许复用？用户要求图标不重复。**规避**：trigger 不带图标，纯「深度 · 自动」按钮文本 + 当前档位高亮点（色点 span）。下拉容器用 Radix DropdownMenu（已在依赖）或原生 popover 简单 listbox。选择 DropdownMenu。
popover 选项 6 项：点击 → `updateSettings({ effortLevel: v })` + `sendEffort(conversationId, v)`。

- [ ] **Step 3: SessionModeBar 组合**

bar 结构：`左: 模式徽标(文字chip)  右: <EffortPicker conversationId/>`，两者都在 h-7 透明条，间距 justify-between。仅当 activeConversation 存在时渲染（模式徽标与 effort 都与会话绑定）。空态欢迎屏不渲染。

- [ ] **Step 4: 冒烟 + Commit**

typecheck/build；dev 手测：任务与会话对话都显示 bar；切档即时生效（配合 Task 12 日志）；极速模式 bar 仍在但无动画。
```bash
git add src/components/chat/EffortPicker.tsx src/components/chat/SessionModeBar.tsx src/i18n
git commit -m "feat(gui-ux): 输入条 EffortPicker——对话/任务共用思考深度热切"
```

---

### Task 14: 持久化收口 + 默认新对话

**Files:**
- Modify: `src/stores/viewStore.ts`（merge 语义已含 rail 保留；补：进入 work 且无历史（无任何 conversation）时自动新建 chat）
- Modify: `src/components/layout/ViewRouter.tsx`（切到 work 分支时兜底逻辑）
- Modify: `src/components/layout/WorkShell.tsx`（若 activeConversation 为空且总会话为空 → 欢迎屏维持，但同时自动建一个 chat 会话满足"默认新对话"）

**Interfaces:**
- Consumes: `createConversation` mode chat（Task 11）
- Produces: 默认行为 —— 首次进入 work（本地 conversations 为空）自动 `createConversation(undefined, undefined, 'chat')`，落一个空白 chat 会话并 focus 输入框。已存在会话 → 恢复 activeConversation（chatStore onRehydrate 现状已恢复最近会话）与 rail（viewStore）。

- [ ] **Step 1: 兜底 effect**

WorkShell 或 ViewRouter 中（选 ViewRouter，因 WorkShell 可能重挂）：
```ts
useEffect(() => {
  if (view !== 'work') return
  const st = useChatStore.getState()
  if (!st.activeConversationId || st.conversations.length === 0) {
    useChatStore.getState().createConversation(undefined, undefined, 'chat')
  }
}, [view])
```
> 注意：createConversation 会置 activeConversationId 并往 chatStore 首部插会话；若持久化现场本来 active 会话存在则不动。
加注释说明语义：无历史 = 自动新对话（默认模式 chat）。

- [ ] **Step 2: 跨重启现场核对冒烟**

手测：在 work 打开 rail=chat + 某对话 → 关 app 重开 → 认证小窗放行 → 主窗口 boot → 驾驶舱 → hub 进 work → rail 仍 chat、该会话仍 active（persist 生效）。清 localStorage（或首启）→ 进 work 自动生成一条空白对话出现在 chat 面板，主区为欢迎/空输入。

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/ViewRouter.tsx
git commit -m "feat(gui-ux): 无历史默认新对话——进 work 空态自动建 chat 会话"
```

---

### Task 15: 图标查重表 + i18n/全局收口 + 回归

**Files:**
- Create: `docs/superpowers/audits/2026-09-08-gui-icon-uniqueness.md`（图标契约表 + 查重清单）
- Modify: `src/i18n/translations/zh-CN.ts`、`en-US.ts`（清理废弃 `sidebar.*` 中已无引用键；确认新增键齐全）
- Modify（如命中）: 涉及重复图标组件（按清单修正）
- Run: typecheck/build/test 全量 + dev 冒烟清单

**Interfaces:**
- Consumes: 全部 Task 产出的 railMeta、EffortPicker、面板等图标使用点
- Produces: 图标唯一性基线文档；全局无重图标断言语义（人工审计，可留注释）

- [ ] **Step 1: 图标盘点**

grep 全 `src/components` lucide import 与使用清单 → 按「语义动作」分组填表到 audit md；重点核对：Header 设置齿轮 vs 其它；`Plus` 系列（MessageSquarePlus/SquarePlus）替代旧泛 Plus 各处；`Settings` 仅 Header；`Gauge` 仅 usage；rail 四图标各自唯一；`ChevronDown`/菜单通用箭头允许（语义=展开指示，非功能图标）；按钮性图标不跨语义复用。发现冲突 → 该组件换 lucide 近义图标并在表中记录新映射。

- [ ] **Step 2: i18n 清理与核对**

删除已无引用 `sidebar.*` 键；保留 rail/auth/effort/cockpit 相关键。`npm run typecheck` 后 t(key) 回退无告警。

- [ ] **Step 3: 全量回归**

Run: `npm run typecheck` → 0 error。
Run: `npm run test` → server/electron 既有全绿（`server/*.test.mjs electron/*.test.mjs`）。
Run: `node --test src/lib/viewStore.test.ts src/lib/chatModeUi.test.ts src/lib/effortUi.test.ts`（如文件路径存在）→ PASS。
Run: `npm run build` → 成功。
dev+electron 冒烟清单（写进 audit md 附注或单独冒烟记录）：
1. 冷启动认证小窗先现（首设/以后登录/锁定、speedMode 不影响小窗）→ 放行后主窗口 boot 加载屏（speedMode 时跳过）→ 驾驶舱数据刷新、主题联动、hub 过渡进 work；
2. work：rail 切换、新建对话/任务、chat 会话禁本地工具但可联网与调 effort、task 会话正常执行本地工具；
3. Header logo 回驾驶舱再回来，现场保留；重启恢复；
4. 六面板（对话/任务/智能体/技能/文件/历史/用量/工作树）入口齐全、无遗留 Sidebar 死链。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-09-08-gui-icon-uniqueness.md src/i18n
git commit -m "docs+chore(gui-ux): 图标唯一性审计表 + i18n 清理 + 全量回归通过"
```

---

## Self-Review 记录（提交前已跑）

- **Spec 覆盖核对**：spec 全部章节已映射——§1→T5；§2→T2/3/4/6；§3→T1/7/8；§4→T9/10；§5→T11；§6→T12/13；§7→T14；§8.1/8.2/8.3→T15/T1/8；测试策略→各 T + T15 回归。图标唯一（D10/D5/D9）、主题上移（§8.1）、speed-mode 语义（G3）均落在对应任务。
- **占位扫描**：无 TBD/TODO；Step 4「临时占位组件」为明确交付物并有替换任务。
- **类型一致性**：`mode:'chat'|'task'`、`AppView/RailId`、`EffortLevel`、auth 四个端点、iframe 消息契约在全部任务中使用同一命名；`createConversation` 三参签名与现调用兼容。
- **已知时序依赖**（执行注意）：Task 10 依赖 Task 11 的 `mode` 字段语义完整落地（两者建议同一执行批次）；Task 8 依赖 Task 7 契约一致；Task 12 的 DEFAULT_CONFIG `effortLevel` 与 GUI 保存 cfg 同键。
- **2026-09-08 增补（认证前置 D11-D13）**：新增 **Task 6b**（认证小窗编排 + 视图机收敛），置于 Task 6 之后、Task 7 之前执行；Task 7-15 一律以文件顶部「变更记录」为窗口/视图/认证基线（Task 4/5/6 原文中 login 视图依赖已被 6b 取代）。Task 15 Step 3 冒烟清单第 1 条与 Task 14 Step 2 已就地改写。
- **资产待办**：boost logo 若自动导出失败，T1 Step 4 用户导出到位前，T5/T6/T8 使用 `logo.png` 占位（Task 1 备注在文件尾，T15 Step 3 复查路径可用）。
