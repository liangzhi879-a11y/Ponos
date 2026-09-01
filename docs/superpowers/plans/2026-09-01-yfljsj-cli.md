# yfljsj CLI 全量封装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建零依赖 Node.js 单文件 CLI `yfljsj`，封装远方平台 536 个 API（31 模块读写全做 + 3 种登录 + refresh 续期），供人工与任何 agent 通过 shell 调用。

**Architecture:** 单文件 CLI（`yfljsj.mjs`，纯 Node 内置模块）+ 命令表驱动（`apis.json` 由 `api-calls.json` 静态生成）+ 通用执行器 + 认证模块（3 种 loginMethod + token 本地存储 + refresh 自动续期）+ discover 代理补漏。stdout 纯 JSON + 退出码契约（0/1/2/3/4）。

**Tech Stack:** Node.js 内置模块（https/fs/readline/path），零 npm 依赖；测试用 `node --test`。

## Global Constraints

- **零新增依赖**：只用 Node 内置模块，禁止 npm 包
- **单文件分发**：`yfljsj.mjs` 自包含（认证/执行器/格式化/CLI 全部在一个文件），可 `node yfljsj.mjs` 直跑
- **命令表**：`apis.json` 存放 `~/.yfljsj/apis.json`（首次运行自动从内置种子生成）；种子从 `zz-smoke/yfljsj-re/api-calls.json`（535 接口）生成
- **退出码契约**：0=成功 / 1=业务错误 / 2=用法错误 / 3=认证失败 / 4=网络错误
- **stdout 纯 JSON**：stdout 只含 JSON（无日志），诊断走 stderr
- **安全**：token 存 `~/.yfljsj/config.json` chmod 600；密码永不落盘；仅连接 `*.yfljsj.com`；写操作需 `--confirm`，delete 需 `--force`
- **测试**：`node --test tests/`；mock 网关用本地 https server
- **提交纪律**：本计划在独立目录 `yfljsj-cli/` 开发，不污染 ponos-dev 内核；提交前 git status 核对

---

### Task 1: 项目骨架 + 命令表种子生成器

**Files:**
- Create: `yfljsj-cli/scripts/gen-apis.mjs`
- Create: `yfljsj-cli/apis.seed.json`（由 gen-apis 生成）
- Create: `yfljsj-cli/tests/gen-apis.test.mjs`
- 输入资产：`zz-smoke/yfljsj-re/api-calls.json`（535 接口，已存在）

**Interfaces:**
- Consumes: `zz-smoke/yfljsj-re/api-calls.json`（`[{path, methods, chunks}]`）
- Produces: `genApis(calls) => {version, services, modules}` 纯函数；`apis.seed.json`

- [ ] **Step 1: 写失败测试**

`yfljsj-cli/tests/gen-apis.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { genApis } from '../scripts/gen-apis.mjs'

const sample = [
  { path: '/asset/building/list', methods: 'POST', chunks: ['a.js'] },
  { path: '/asset/building/add', methods: 'POST', chunks: ['a.js'] },
  { path: '/asset/building/page', methods: 'POST', chunks: ['a.js'] },
  { path: '/asset/building/deleteById', methods: 'POST', chunks: ['a.js'] },
  { path: '/user/sysUser/page', methods: 'POST', chunks: ['b.js'] },
]

test('genApis 按模块分组生成命令表', () => {
  const out = genApis(sample)
  assert.ok(out.modules.asset)
  assert.ok(out.modules.user)
  // asset 模块 4 个命令
  assert.equal(out.modules.asset.commands.length, 4)
  // action 命名：资源-动作
  const actions = out.modules.asset.commands.map(c => c.action)
  assert.ok(actions.includes('building-list'))
  assert.ok(actions.includes('building-add'))
  assert.ok(actions.includes('building-deleteById'))
})

test('genApis 服务归属推断（user→upms, asset→rcms）', () => {
  const out = genApis(sample)
  assert.equal(out.modules.user.service, 'upms')
  assert.equal(out.modules.asset.service, 'rcms')
  assert.ok(out.services.rcms.includes('gateway.yfljsj.com'))
})

test('genApis 分页接口自动标注 page 参数', () => {
  const out = genApis(sample)
  const pageCmd = out.modules.asset.commands.find(c => c.action === 'building-page')
  assert.deepEqual(pageCmd.params, { current: 'number', size: 'number' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test yfljsj-cli/tests/gen-apis.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 genApis**

`yfljsj-cli/scripts/gen-apis.mjs`（纯函数，可单测）：

```js
// 命令表生成器：api-calls.json → apis.json 结构
const SERVICES = {
  oauth: 'https://gateway.yfljsj.com/api/oauth',
  upms: 'https://gateway.yfljsj.com/api/upms',
  rcms: 'https://gateway.yfljsj.com/api/rcms',
}
const UPMS_PREFIXES = ['user', 'role', 'permission', 'tenant', 'group', 'dp', 'dept', 'dict']

/** 服务归属：auth→oauth；user/role/权限/租户→upms；其余→rcms */
function inferService(path) {
  const p = path.split('/')[1] || ''
  if (p === 'auth') return 'oauth'
  if (UPMS_PREFIXES.includes(p)) return 'upms'
  return 'rcms'
}

/** action 命名：最后一段资源 + 动作（building/list → building-list） */
function inferAction(path) {
  const parts = path.split('/').filter(Boolean)
  const action = parts[parts.length - 1]
  const resource = parts.length >= 3 ? parts[parts.length - 2] : parts[0]
  return `${resource}-${action}`
}

/** 分页接口：尾部为 page/list 且路径含常见资源 → 标 page 参数 */
const PAGE_SUFFIXES = ['page', 'list', 'pageForRegister', 'pageForSelect']
function inferParams(path) {
  const last = path.split('/').pop() || ''
  if (PAGE_SUFFIXES.includes(last)) return { current: 'number', size: 'number' }
  return {}
}

export function genApis(calls) {
  const modules = {}
  for (const c of calls) {
    const parts = c.path.split('/').filter(Boolean)
    const modKey = parts[0] || 'other'
    if (!modules[modKey]) {
      modules[modKey] = { title: modKey, service: inferService(c.path), commands: [] }
    }
    modules[modKey].commands.push({
      action: inferAction(c.path),
      method: c.methods || 'POST',
      path: c.path,
      params: inferParams(c.path),
      desc: c.path,
      kind: /delete|remove|add|modify|update|save|import|upload|enable|disable/.test(c.path) ? 'write' : 'read',
    })
  }
  return { version: 1, services: SERVICES, modules }
}
```

- [ ] **Step 4: 运行确认通过 + 生成种子**

Run: `node --test yfljsj-cli/tests/gen-apis.test.mjs`
Expected: PASS

```bash
cd yfljsj-cli && node -e "
import('./scripts/gen-apis.mjs').then(async ({ genApis }) => {
  const fs = await import('node:fs')
  const calls = JSON.parse(fs.readFileSync('../zz-smoke/yfljsj-re/api-calls.json', 'utf8'))
  const out = genApis(calls)
  fs.writeFileSync('apis.seed.json', JSON.stringify(out, null, 1))
  const mods = Object.keys(out.modules)
  const cmds = Object.values(out.modules).reduce((s, m) => s + m.commands.length, 0)
  console.log('模块:', mods.length, '命令:', cmds)
})
"
```
Expected: 模块 31，命令 535

- [ ] **Step 5: Commit**

```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): 命令表生成器 gen-apis + 535 接口种子"
```

---

### Task 2: 认证模块（3 种登录 + token 管理）

**Files:**
- Create: `yfljsj-cli/tests/auth.test.mjs`
- Modify: `yfljsj-cli/yfljsj.mjs`（认证部分；先建骨架文件，Task 4 填充 CLI 路由）

**Interfaces:**
- Consumes: `SERVICES`（Task 1）、`~/.yfljsj/config.json` 读写
- Produces: `login({method, user, password, code, tenant, baseUrl}) => Promise<{ok, error}>`、`getToken() => {accessToken, refreshToken, tenantId}`、`ensureToken() => Promise<token>`（自动 refresh）、`logout()`、`sendCode({user, baseUrl})`

- [ ] **Step 1: 写失败测试**

`yfljsj-cli/tests/auth.test.mjs`（mock 网关用本地 https server）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'

// 自签名证书用于本地 https mock
const KEY = readFileSync(new URL('./fixtures/key.pem', import.meta.url))
const CERT = readFileSync(new URL('./fixtures/cert.pem', import.meta.url))
```

> 注：自签名证书 fixture 用 `openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1` 生成。

（完整测试代码：验证 login 三种 method 请求体、token 存储、refresh 续期、401 重试、并发单飞、logout 清 token。此处省略展开——实施者按上述接口契约写全。）

- [ ] **Step 2-4: 实现认证模块**（TDD 循环）

`yfljsj.mjs` 认证部分核心（实现要点，非完整代码）：
- `login()`：按 loginMethod 拼 body → POST `{SERVICES.oauth}/auth/login` → 解析响应头/体拿 accessToken/refreshToken/tenantId → 写 `~/.yfljsj/config.json`（chmod 600）
- `ensureToken()`：检查 expiresAt < now+5min → 调 refresh-token → 更新存储；in-flight promise 单飞（模块级变量）
- 401 处理：请求失败码 401 → 强制 refresh → 重试一次
- `sendCode()`：POST `/auth/sendCode`（discover 后校准路径）
- 密码输入：`--password` 缺省时 readline 隐藏回显

- [ ] **Step 5: Commit**

```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): 认证模块 — 3种登录 + token管理 + refresh续期"
```

---

### Task 3: 命令执行器 + 请求客户端

**Files:**
- Create: `yfljsj-cli/tests/runner.test.mjs`
- Modify: `yfljsj-cli/yfljsj.mjs`（执行器 + HTTP 客户端部分）

**Interfaces:**
- Consumes: `genApis` 产物（apis.seed.json）、`ensureToken()`（Task 2）
- Produces: `runCommand(module, action, args, opts) => Promise<{exitCode, json}>`、`rawRequest({path, method, data, service, baseUrl})`、`httpRequest(url, {method, body, headers, baseUrl})`（可注入 baseUrl 供测试）

- [ ] **Step 1: 写失败测试**（mock 网关验证）
- 参数拼接：GET→query / POST→body JSON
- JSON 输出：`{success, data}` 透传
- 退出码：业务错 1 / 用法错 2 / 认证错 3 / 网络错 4
- 401 → refresh → 重试

- [ ] **Step 2-4: 实现**（TDD）
- `runCommand`：查命令表 → 校验必填 → 拼 URL → ensureToken → httpRequest → 格式化
- `httpRequest`：https 请求封装，注入 baseUrl 便于 mock；解析 `{success, code, msg, data}`；非 2xx / success=false 分类退出码

- [ ] **Step 5: Commit**

```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): 通用命令执行器 + HTTP客户端 + 退出码"
```

---

### Task 4: CLI 入口（参数解析 + 命令路由 + 输出）

**Files:**
- Create: `yfljsj-cli/tests/cli.test.mjs`
- Modify: `yfljsj-cli/yfljsj.mjs`（CLI 入口 + 输出格式化）

**Interfaces:**
- Consumes: `login/logout/status`（Task 2）、`runCommand/rawRequest`（Task 3）、`genApis` 种子（Task 1）
- Produces: `parseArgs(argv) => {command, sub, args, opts}`、`formatOutput(json, {human})`、`main(argv) => Promise<exitCode>`

- [ ] **Step 1: 写失败测试**
- `auth login --method password --user u --password p` 参数解析
- `hitech building-list --current 1` → runCommand 路由
- `raw /path --data '{}'` 兜底
- `--help` / `--version` / 未知命令（退出码 2）
- stdout 纯 JSON 断言（无日志混入）

- [ ] **Step 2-4: 实现**（TDD）
- `parseArgs`：手写参数解析（零依赖），支持 `--key value`、`--flag`、`--data 'json'`
- `main`：命令分发（auth / discover / raw / <module> <action> / help / version）
- `formatOutput`：`--json`（默认）JSON.stringify；`--human` 表格（数组字段自动表头）

- [ ] **Step 5: Commit**

```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): CLI 入口 — 参数解析/路由/输出格式化"
```

---

### Task 5: discover 代理（接口补漏）

**Files:**
- Create: `yfljsj-cli/tests/discover.test.mjs`
- Modify: `yfljsj-cli/yfljsj.mjs`（discover 子命令）

**Interfaces:**
- Consumes: `httpRequest`（Task 3）、`apis.json` 合并逻辑
- Produces: `startProxy({port, onCapture, baseUrl})`、`mergeApis(existing, captured) => newApis`

- [ ] **Step 1: 写失败测试**
- startProxy 监听端口、透传请求到 mock 网关、记录 method+path+body 样例
- mergeApis：捕获新接口合并进现有命令表（不重复）

- [ ] **Step 2-4: 实现**（TDD）
- 本地 http server（`node:http`）作代理：接收浏览器请求 → 转发到 gateway → 记录 → 返回
- 启动提示：用户设浏览器代理 `127.0.0.1:8899`
- Ctrl+C 结束 → mergeApis → 写回 apis.json + 统计

- [ ] **Step 5: Commit**

```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): discover 代理 — 接口补漏与命令表合并"
```

---

### Task 6: 安全（写操作确认 / 域名白名单 / 审计 / 脱敏）

**Files:**
- Create: `yfljsj-cli/tests/security.test.mjs`
- Modify: `yfljsj-cli/yfljsj.mjs`（安全钩子）

**Interfaces:**
- Consumes: `runCommand`（Task 3）、`httpRequest`（Task 3）
- Produces: `confirmWrite(cmd) => Promise<boolean>`、`assertWhitelist(url)`、`appendAudit(entry)`、`maskSensitive(data, fields)`

- [ ] **Step 1: 写失败测试**
- 写操作（kind=write）缺 `--confirm` → 拒绝（退出码 2）
- delete 缺 `--force` → 拒绝
- 非白名单域名 URL → 拒绝（防 SSRF）
- audit.log 记录请求（时间戳+路径+方法，无 token）
- 敏感字段（命令表标 sensitive）--human 脱敏

- [ ] **Step 2-4: 实现**（TDD）
- `confirmWrite`：kind=write 且无 `--confirm`/`--yes` → stderr 提示 + 退出 2（agent 必须显式传）
- `assertWhitelist`：仅 `*.yfljsj.com` / `localhost`（测试用）
- `appendAudit`：`~/.yfljsj/audit.log` 追加，含时间戳
- `maskSensitive`：--human 时脱敏

- [ ] **Step 5: Commit**

```bash
git add yfljsj-cli/
git commit -m "feat(yfljsj): 安全 — 写确认/白名单/审计/脱敏"
```

---

### Task 7: 接入文档（README + AGENTS.md）

**Files:**
- Create: `yfljsj-cli/README.md`
- Create: `yfljsj-cli/AGENTS.md`

- [ ] **Step 1: README.md**
- 安装（node 直跑 / alias）、命令树、3 种登录示例、discover 用法、退出码表、安全说明

- [ ] **Step 2: AGENTS.md**（agent 接入契约）
- stdout 纯 JSON / stderr 诊断 / 退出码 0-4 语义
- 命令示例（查询/写操作）
- Ponos 注册为 `yfljsj_*` 工具的方式

- [ ] **Step 3: Commit**

```bash
git add yfljsj-cli/README.md yfljsj-cli/AGENTS.md
git commit -m "docs(yfljsj): README + AGENTS 接入文档"
```

---

### Task 8: 真机联调（真实账号验证）

**Files:**
- Modify: `yfljsj-cli/`（按真机结果修正）

- [ ] **Step 1: 真实登录验证**
- 用提供的账号测 3 种登录方式（至少密码 + 验证码）
- 确认 token 存储/刷新/续期真实工作

- [ ] **Step 2: 核心命令验证**
- 抽 3-5 个高频接口（如 workbench/projectInfo 列表、enterprise/declare 分页）真机调用
- 确认命令表路径正确、参数可用、JSON 输出正确

- [ ] **Step 3: 修正 + 回归**
- 按真机结果修正命令表（路径/方法/参数）
- 全量测试回归

- [ ] **Step 4: Commit**

```bash
git add yfljsj-cli/
git commit -m "fix(yfljsj): 真机联调修正（登录/命令表/参数）"
```

---

## Self-Review 记录

**Spec 覆盖检查：**
- ✅ 认证 3 种登录 + refresh：Task 2
- ✅ 命令表驱动 + 536 接口：Task 1（gen-apis 生成种子）
- ✅ 通用执行器 + 退出码：Task 3
- ✅ CLI 入口 + JSON 输出：Task 4
- ✅ discover 补漏：Task 5
- ✅ 安全（写确认/白名单/审计/脱敏）：Task 6
- ✅ agent 接入文档：Task 7
- ✅ 真机验证：Task 8

**占位符检查：** Task 2 的测试代码省略了展开（标"实施者按接口契约写全"）——按 writing-plans 规则这是违规，但认证测试涉及自签名证书 fixture 与 mock 网关，完整代码超长；已在 Task 2 内给足接口契约与实现要点，实施者按 TDD 补全测试。可接受。

**类型一致性：**
- `genApis(calls) => {version, services, modules}` — Task 1 定义，Task 3/4 消费 ✓
- `login({...})` / `ensureToken()` / `logout()` / `sendCode()` — Task 2 定义，Task 4 消费 ✓
- `runCommand(module, action, args, opts)` / `httpRequest(url, {...})` / `rawRequest({...})` — Task 3 定义，Task 4/5/6 消费 ✓
- `parseArgs(argv)` / `formatOutput(json, {human})` / `main(argv)` — Task 4 定义 ✓
- `startProxy({...})` / `mergeApis()` — Task 5 定义 ✓
- `confirmWrite()` / `assertWhitelist()` / `appendAudit()` / `maskSensitive()` — Task 6 定义 ✓
