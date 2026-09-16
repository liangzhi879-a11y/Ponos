# MCP Streamable HTTP 传输 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MCP 支持 Streamable HTTP（2025-03-26）传输，使内核能连接远程 MCP 服务器，并在 GUI 中配置 URL 与认证头（密钥以 `${ENV_VAR}` 占位、不落盘）。

**Architecture:** 先把 stdio 客户端的 JSON-RPC 会话语义（id 分配 / pending / 超时 / 中断 / 收尾）抽成 `createJsonRpcSession`，stdio 与新增的 HTTP 客户端共用同一核心——两套语义分叉是这类改造的典型事故源。HTTP 客户端按现行规范实现单端点 POST（响应可为 JSON 或 SSE 流），零新依赖（Node v24 原生 `fetch`/`ReadableStream`/`AbortController`）。配置层同时支持 `command`（stdio）与 `url`（HTTP），二者互斥。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test`、原生 `fetch`、React + TypeScript（GUI）、Vite（构建）。

## Global Constraints

- 目标运行环境 **Node v24.14.1**（已核实）；**禁止新增任何 npm 依赖**。
- 既有测试基线必须零回归：内核 **1689 tests / 1688 pass / 0 fail / 1 skipped**；src **585 / 585**；server **532 / 532**；`npm run typecheck` 必须通过。
- 内核与桥为 ESM `.mjs`；前端 TS 中**相对导入必须带 `.ts` 后缀**（`node --test` 走 Node 原生 TS，不认 `@/` alias；`@/` 前缀导入由 Vite 解析，可用于组件）。
- 测试命令统一加 `--test-timeout=60000`。
- **`startMcpClient` 的导出名与签名不得改变**（既有 16 个用例依赖它）。
- **密钥只以 `${VAR}` 字面量落盘**；日志与错误串**不得包含任何头值**。
- 中文注释；提交信息用中文，说明「为什么」。
- 不做：GET 通道、旧式双端点 SSE、OAuth、resources/prompts、自动重连。

---

### Task 1: 配置层支持 `url` / `headers`（含读侧修复）

**Files:**
- Modify: `kernel/mcp.mjs`（`normalizeMcpServers`、`loadMcpServers`）
- Test: `kernel-tests/mcp.test.mjs`（增补用例）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `normalizeMcpServers(raw)` 接受 `{command?...}` **或** `{url?, headers?}`（恰好其一）；
  `loadMcpServers(configPath)` 返回纯 `url` 条目（此前被静默丢弃）。
  两者错误文案字段名统一为 `name` / `error`。

**背景（必须理解否则会漏改）**：`loadMcpServers` 是**读侧**，它此前只认带 `command` 的条目
（设计哲学：宁可少一个工具，不要半个坏服务器）。**只改 `normalizeMcpServers` 而不改读侧，
HTTP 服务器即使写进文件也不会被加载**。且 `writeMcpServers` 有强约束
「写出必须能被 `loadMcpServers` 读回等价」，故往返断言必须扩展。

- [ ] **Step 1: 写失败测试**

在 `kernel-tests/mcp.test.mjs` 末尾追加（沿用该文件既有的 import 与 `test()` 风格）：

```javascript
test('normalizeMcpServers：接受纯 url 服务器（HTTP 传输）', () => {
  const { servers, errors } = normalizeMcpServers({
    remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
  })
  assert.equal(errors.length, 0, '纯 url 配置不应报错')
  assert.equal(servers.remote.url, 'https://example.com/mcp')
  assert.equal(servers.remote.headers.Authorization, 'Bearer ${TOKEN}', '应原样保留占位符（不落盘解析）')
})

test('normalizeMcpServers：command 与 url 恰好其一（互斥）', () => {
  const both = normalizeMcpServers({ x: { command: 'npx', url: 'https://e.com/mcp' } })
  assert.equal(both.errors.length, 1, '同时给 command 与 url 应报错（消歧）')
  assert.match(both.errors[0].error, /command|url/)

  const neither = normalizeMcpServers({ y: { args: ['-y'] } })
  assert.equal(neither.errors.length, 1, '两者都缺应报错')
})

test('normalizeMcpServers：字段与传输类型必须匹配', () => {
  const a = normalizeMcpServers({ x: { url: 'https://e.com/mcp', args: ['--x'] } })
  assert.equal(a.errors.length, 1, 'url 配 args 应报错（args 仅 stdio）')

  const b = normalizeMcpServers({ x: { command: 'npx', headers: { A: '1' } } })
  assert.equal(b.errors.length, 1, 'command 配 headers 应报错（headers 仅 HTTP）')
})

test('normalizeMcpServers：url 必须是 http(s) 绝对地址', () => {
  for (const bad of ['ftp://e.com/mcp', '/relative/path', 'not a url', '']) {
    const r = normalizeMcpServers({ x: { url: bad } })
    assert.equal(r.errors.length, 1, `非法 url 应报错: ${bad}`)
  }
  const ok = normalizeMcpServers({ x: { url: 'http://127.0.0.1:8080/mcp' } })
  assert.equal(ok.errors.length, 0, 'http 应被接受')
})

test('loadMcpServers：不再丢弃纯 url 条目（读侧修复）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-url-'))
  const p = path.join(dir, 'mcp.json')
  fs.writeFileSync(p, JSON.stringify({
    servers: { remote: { url: 'https://example.com/mcp', timeoutMs: 20000 } },
  }))
  try {
    const { servers, errors } = loadMcpServers(p)
    assert.equal(errors.length, 0)
    assert.ok(servers.remote, '纯 url 服务器必须被加载（修复前会被静默丢弃）')
    assert.equal(servers.remote.url, 'https://example.com/mcp')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('往返：writeMcpServers 写出的 url 服务器能被 loadMcpServers 读回等价', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rt-url-'))
  const p = path.join(dir, 'mcp.json')
  const input = { servers: { remote: { url: 'https://example.com/mcp', headers: { A: 'B' }, timeoutMs: 20000 } } }
  try {
    writeMcpServers(p, input.servers)
    const back = loadMcpServers(p)
    assert.equal(back.errors.length, 0)
    assert.deepEqual(back.servers, input.servers, 'url 服务器往返必须等价')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
```

若该文件尚未 import `os`/`fs`/`path`/`loadMcpServers`/`writeMcpServers`，在文件头补齐。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --test-timeout=60000 kernel-tests/mcp.test.mjs`
Expected: 失败（纯 url 被拒 / `loadMcpServers` 丢弃 url 条目）

- [ ] **Step 3: 实现**

改 `kernel/mcp.mjs` 的 `normalizeMcpServers`：对每个条目判定传输类型：

```javascript
// 传输判定：command（stdio）与 url（HTTP）恰好其一。
// 同时存在时消歧报错——否则"到底走哪条路"会成为运行期的猜测。
const hasCommand = typeof raw.command === 'string' && raw.command.trim()
const hasUrl = typeof raw.url === 'string' && raw.url.trim()
if (hasCommand && hasUrl) {
  errors.push({ name, error: '不能同时配置 command 与 url（二选一）' }); continue
}
if (!hasCommand && !hasUrl) {
  errors.push({ name, error: '缺少 command 或 url' }); continue
}
if (hasUrl) {
  let parsed = null
  try { parsed = new URL(raw.url.trim()) } catch { /* 落到下面的报错 */ }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    errors.push({ name, error: `url 必须是 http/https 绝对地址：${raw.url}` }); continue
  }
  if (raw.args !== undefined || raw.cwd !== undefined || raw.env !== undefined) {
    errors.push({ name, error: 'args/env/cwd 仅适用于 command 传输' }); continue
  }
}
if (hasCommand && raw.headers !== undefined) {
  errors.push({ name, error: 'headers 仅适用于 url 传输' }); continue
}
```

并在构造结果对象时：stdio 保留既有键；HTTP 保留 `{ url, headers, timeoutMs }`，
其中 `headers` 仅接受 `Record<string,string>`（非字符串值 `String()` 归一，非对象则忽略）。

改 `loadMcpServers`：把「必须有 command」的过滤放宽为「必须有 command 或 url」，
并对 url 条目做与 `normalizeMcpServers` **同口径**的校验（可复用同一段判定，避免两处漂移）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test --test-timeout=60000 kernel-tests/mcp.test.mjs`
Expected: 全部 PASS（既有 16 + 新增 6）

- [ ] **Step 5: 提交**

```bash
git add kernel/mcp.mjs kernel-tests/mcp.test.mjs
git commit -m "feat(mcp): 配置层支持 url/headers（HTTP 传输），修复读侧丢弃 url 条目"
```

---

### Task 2: 抽取 JSON-RPC 会话核心（零行为变化）

**Files:**
- Modify: `kernel/mcp.mjs`
- Test: `kernel-tests/mcp.test.mjs`（**既有 16 用例全绿即为正确性证明**，不新增）

**Interfaces:**
- Produces: `createJsonRpcSession({ name, timeoutMs, send, onLog })` 返回
  `{ request(method, params, opts), notify(method, params), handleMessage(msg), failAll(err), close(), stats() }`。
  `request` 返回 `Promise<any>`；`opts.signal` 可选（外加中断源）。
- Consumes: Task 1 无依赖关系。

**为什么要抽**：stdio 与 HTTP 必须共用同一套 pending/超时/中断/收尾语义。
若各写一份，超时不回收定时器、close 后悬挂这类 bug 会在两处各自出现。

- [ ] **Step 1: 记录改造前测试结果（基线）**

Run: `node --test --test-timeout=60000 kernel-tests/mcp.test.mjs`
记下通过数（应为 22 = 16 + Task 1 新增 6）。

- [ ] **Step 2: 抽取实现**

在 `kernel/mcp.mjs` 中新增 `createJsonRpcSession`，语义点（逐条不可省）：

```javascript
export function createJsonRpcSession({ name, timeoutMs = 30000, send, onLog = () => {} }) {
  let nextId = 1
  let closed = false
  const pending = new Map()   // id -> { resolve, reject, timer, signal, onAbort }

  function settle(id, fn, arg) {
    const p = pending.get(id); if (!p) return
    pending.delete(id)
    if (p.timer) clearTimeout(p.timer)                    // 必须清：否则定时器持有闭包
    if (p.onAbort && p.signal) p.signal.removeEventListener('abort', p.onAbort)
    fn(arg)
  }

  function failAll(err) {
    for (const [id] of pending) settle(id, (p) => p.reject, err)
  }

  async function request(method, params, opts = {}) {
    if (closed) throw new Error(`MCP 服务器 ${name} 已关闭`)
    const id = nextId++
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(id, (q) => q.reject, new Error(`MCP 请求超时（${method}，${timeoutMs}ms）`))
      }, timeoutMs)
      pEntry = { resolve, reject, timer, signal: opts.signal, onAbort: null }
      if (opts.signal) {
        const onAbort = () => settle(id, (q) => q.reject, new Error(`MCP 请求已中断（${method}）`))
        pEntry.onAbort = onAbort
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      pending.set(id, pEntry)
    })
    try {
      await send({ jsonrpc: '2.0', id, method, params }, opts)   // 同步抛错也要 reject
    } catch (e) {
      settle(id, (q) => q.reject, e)
    }
    return p
  }

  function handleMessage(msg) {
    if (!msg || msg.id === undefined || msg.id === null) return false   // 通知：交给调用方
    const p = pending.get(msg.id); if (!p) return false
    if (msg.error) settle(msg.id, (q) => q.reject, new Error(msg.error.message || 'MCP 错误'))
    else settle(msg.id, (q) => q.resolve, msg.result)
    return true
  }

  return {
    request,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    handleMessage,
    failAll,
    close: () => { closed = true; failAll(new Error(`MCP 服务器 ${name} 已关闭`)) },
    stats: () => ({ pending: pending.size, closed }),
  }
}
```

> 注意：上面片段里 `pEntry` 需在 `new Promise` 内先声明（`let pEntry`）。实施时按变量提升规则整理，确保 `p` 的 Promise 构造器内不引用未初始化变量。

把 `startMcpClient` 改为持有该会话，仅保留 stdio 特化部分（`spawn`、`mcpChildEnv`、
stdout 逐行解析后调 `session.handleMessage`、`onExit` 调 `session.close()`）。
**导出名、参数、返回形状一律不变**。

- [ ] **Step 3: 运行测试确认零行为变化**

Run: `node --test --test-timeout=60000 kernel-tests/mcp.test.mjs`
Expected: 与 Step 1 相同通过数、0 fail。**若有任何差异，说明语义变了，必须修回。**

- [ ] **Step 4: 提交**

```bash
git add kernel/mcp.mjs
git commit -m "refactor(mcp): 抽取 createJsonRpcSession 会话核心供 stdio/HTTP 共用"
```

---

### Task 3: `${ENV_VAR}` 插值（纯函数）

**Files:**
- Modify: `kernel/mcp.mjs`
- Test: `kernel-tests/mcp.test.mjs`

**Interfaces:**
- Produces: `interpolateEnv(value, env, where)` → `string`；**未定义变量抛错**，错误信息包含变量名与位置 `where`。

- [ ] **Step 1: 写失败测试**

```javascript
test('interpolateEnv：替换已定义变量', () => {
  assert.equal(interpolateEnv('Bearer ${TOKEN}', { TOKEN: 'abc' }), 'Bearer abc')
})

test('interpolateEnv：未定义变量必须报错并点名（不得静默空串）', () => {
  assert.throws(
    () => interpolateEnv('Bearer ${MISSING}', {}, 'headers.Authorization'),
    (e) => /MISSING/.test(e.message) && /headers\.Authorization/.test(e.message),
    '静默换成空串会变成 "Bearer " 换来含义不明的 401，排查成本远高于直接报错',
  )
})

test('interpolateEnv：无占位符原样返回；多个占位符都替换', () => {
  assert.equal(interpolateEnv('plain', {}), 'plain')
  assert.equal(interpolateEnv('${A}-${B}', { A: '1', B: '2' }), '1-2')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-timeout=60000 kernel-tests/mcp.test.mjs`
Expected: FAIL（`interpolateEnv is not defined`）

- [ ] **Step 3: 实现**

```javascript
/**
 * 解析 ${ENV_VAR} 占位符。**只在运行时**做（写盘时保留字面量），
 * 使密钥不进入 mcp.json —— 该文件会被备份、截图、同步到 OneDrive。
 * 未定义变量**抛错并点名**：静默换空串会得到含义不明的 401，更难排查。
 */
export function interpolateEnv(value, env = process.env, where = '') {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = env[name]
    if (v === undefined || v === '') {
      throw new Error(`环境变量 ${name} 未定义${where ? `（配置项 ${where}）` : ''}`)
    }
    return v
  })
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test --test-timeout=60000 kernel-tests/mcp.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add kernel/mcp.mjs kernel-tests/mcp.test.mjs
git commit -m "feat(mcp): 新增 interpolateEnv，密钥以 \${ENV_VAR} 占位不落盘"
```

---

### Task 4: HTTP 测试夹具

**Files:**
- Create: `kernel-tests/fixtures/mcp-http-stub-server.mjs`

**Interfaces:**
- Produces: 可执行脚本；启动后向 stdout 打印 `PORT=<n>` 一行（供测试读取），支持故障模式参数。

- [ ] **Step 1: 写夹具**

```javascript
// MCP Streamable HTTP 测试夹具（零依赖，node:http）。
// 用法：node mcp-http-stub-server.mjs [mode]
//   mode: json（默认）| sse | http500 | hang | no-session | echo-auth
// 启动后向 stdout 打印 PORT=<n>，供测试读取后连接。
import http from 'node:http'

const mode = process.argv[2] || 'json'
const SESSION_ID = 'sess-test-1'
let initialized = false

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

const server = http.createServer((req, res) => {
  if (mode === 'http500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return }

  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let msg = null
    try { msg = JSON.parse(body) } catch { res.writeHead(400).end('bad json'); return }

    // echo-auth：把收到的请求头回显进 result，供插值用例断言"服务器收到了解析后的值"
    const echo = () => Object.fromEntries(Object.entries(req.headers))

    if (mode === 'hang') return   // 故意不响应（测超时 + abort）

    const isInit = msg.method === 'initialize'
    if (mode === 'no-session') {
      // 未初始化就 404，模拟会话过期
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'session not found' } }))
      return
    }
    if (!isInit && mode !== 'echo-auth' && req.headers['mcp-session-id'] !== SESSION_ID) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'session not found' } }))
      return
    }

    let payload = null
    if (isInit) {
      initialized = true
      payload = rpcResult(msg.id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'http-stub', version: '1.0.0' },
      })
    } else if (msg.method === 'tools/list') {
      payload = rpcResult(msg.id, {
        tools: [
          { name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'whoami', description: '回显请求头', inputSchema: { type: 'object', properties: {} } },
        ],
      })
    } else if (msg.method === 'tools/call') {
      const text = msg.params?.arguments?.text ?? ''
      payload = rpcResult(msg.id, { content: [{ type: 'text', text: `echo:${text}` }] })
    } else if (msg.method && msg.method.startsWith('notifications/')) {
      res.writeHead(202).end(); return
    } else {
      payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
    }

    if (mode === 'sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        ...(isInit ? { 'mcp-session-id': SESSION_ID } : {}),
      })
      // 单条消息即结束本请求的流（规范允许；客户端应在拿到响应后立即停止读取）
      res.write(`event: message\ndata: ${payload}\n\n`)
      res.end()
      return
    }

    res.writeHead(200, {
      'content-type': 'application/json',
      ...(isInit ? { 'mcp-session-id': SESSION_ID } : {}),
    })
    res.end(payload)
  })
})

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`)
})
```

- [ ] **Step 2: 手工验证夹具可启动并应答**

Run:
```bash
node kernel-tests/fixtures/mcp-http-stub-server.mjs json &
sleep 1
```
Expected: 打印 `PORT=<n>`。用该端口 `curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' http://127.0.0.1:<n>/mcp`
Expected: 返回含 `serverInfo` 的 JSON 与响应头 `mcp-session-id`。验证后结束该进程。

- [ ] **Step 3: 提交**

```bash
git add kernel-tests/fixtures/mcp-http-stub-server.mjs
git commit -m "test(mcp): 新增 Streamable HTTP 夹具（含 SSE/500/hang/会话过期/回显认证头）"
```

---

### Task 5: `startMcpHttpClient` + 端到端测试

**Files:**
- Create: `kernel/mcp-http.mjs`
- Test: `kernel-tests/mcp-http.test.mjs`

**Interfaces:**
- Consumes: `createJsonRpcSession`、`interpolateEnv`（Task 2/3）
- Produces: `startMcpHttpClient({ name, url, headers, timeoutMs, onLog, env })` →
  与 stdio 客户端同形状 `{ tools(), call(name, args), close(), stats() }`。

- [ ] **Step 1: 写失败测试**

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { startMcpHttpClient } from '../kernel/mcp-http.mjs'

const FIXTURE = path.resolve('kernel-tests/fixtures/mcp-http-stub-server.mjs')

/** 启动夹具，返回 { port, kill } */
function startStub(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('夹具启动超时')) }, 10000)
    child.stdout.on('data', (c) => {
      buf += c
      const m = buf.match(/PORT=(\d+)/)
      if (m) { clearTimeout(timer); resolve({ port: Number(m[1]), kill: () => child.kill() }) }
    })
    child.on('error', reject)
  })
}

test('HTTP 客户端：JSON 响应路径完成握手/列工具/调工具', async () => {
  const s = await startStub('json')
  const logs = []
  const c = startMcpHttpClient({
    name: 'httpstub', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000,
    onLog: (m) => logs.push(m),
  })
  try {
    const tools = await c.tools()
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'whoami'])
    const out = await c.call('echo', { text: 'hi' })
    assert.match(JSON.stringify(out), /echo:hi/)
    assert.equal(c.stats().pending, 0, '请求结束后不得有悬挂 pending')
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：SSE 响应路径同样可用', async () => {
  const s = await startStub('sse')
  const c = startMcpHttpClient({ name: 'ssestub', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000 })
  try {
    const tools = await c.tools()
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'whoami'], 'SSE 流里的响应也必须被解析')
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：${ENV_VAR} 插值生效（服务器确实收到解析后的头）', async () => {
  const s = await startStub('echo-auth')
  const c = startMcpHttpClient({
    name: 'auth', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000,
    headers: { Authorization: 'Bearer ${MY_TOKEN}' },
    env: { MY_TOKEN: 'secret-abc' },
  })
  try {
    // whoami 回显收到的请求头；用它证明"服务器收到的是解析后的值"
    const out = await c.call('whoami', {})
    assert.match(JSON.stringify(out), /Bearer secret-abc/)
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：未定义变量报错并点名，且不发出请求', async () => {
  const s = await startStub('json')
  const c = startMcpHttpClient({
    name: 'bad', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000,
    headers: { Authorization: 'Bearer ${NOPE_TOKEN}' }, env: {},
  })
  try {
    await assert.rejects(() => c.tools(), (e) => /NOPE_TOKEN/.test(e.message))
    assert.equal(c.stats().pending, 0, '插值失败不得留下 pending')
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：日志与错误串不得泄漏头值', async () => {
  const s = await startStub('http500')
  const logs = []
  const c = startMcpHttpClient({
    name: 'leak', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000,
    headers: { Authorization: 'Bearer SUPER_SECRET' }, env: {}, onLog: (m) => logs.push(String(m)),
  })
  try {
    await assert.rejects(() => c.tools())
    const joined = logs.join('\n')
    assert.doesNotMatch(joined, /SUPER_SECRET/, '日志不得含头值')
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：超时 reject、pending 清空、且不悬挂', async () => {
  const s = await startStub('hang')
  const c = startMcpHttpClient({ name: 'hang', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 800 })
  try {
    await assert.rejects(() => c.tools(), (e) => /超时/.test(e.message))
    assert.equal(c.stats().pending, 0, '超时必须清 pending')
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：会话过期(404)给出可读错误', async () => {
  const s = await startStub('no-session')
  const c = startMcpHttpClient({ name: 'expired', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000 })
  try {
    await assert.rejects(() => c.tools(), (e) => /会话|404/.test(e.message))
  } finally { await c.close(); s.kill() }
})

test('HTTP 客户端：close() 后调用立即失败（不悬挂）', async () => {
  const s = await startStub('json')
  const c = startMcpHttpClient({ name: 'closing', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000 })
  await c.tools()
  await c.close()
  await assert.rejects(() => c.tools(), (e) => /关闭/.test(e.message))
  s.kill()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-timeout=60000 kernel-tests/mcp-http.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `kernel/mcp-http.mjs`**

要点（每条都有对应测试）：
1. `startMcpHttpClient` 内先**解析头**：对 `headers` 每个值调 `interpolateEnv(v, env, 'headers.'+k)`；
   **解析失败立即返回一个"所有方法都 reject"的客户端**（不在 send 时才炸，且 pending 为 0）。
2. `send(msg, opts)`：
   - 构造 `Headers`：`content-type: application/json`、
     `accept: application/json, text/event-stream`、解析后的认证头、已捕获的 `mcp-session-id`。
   - `fetch(url, { method:'POST', headers, body: JSON.stringify(msg), redirect:'error', signal })`
     —— **`redirect: 'error'` 是安全要求**：默认跟随会把 `Authorization` 带到另一主机。
   - `signal`：把会话传入的 `opts.signal` 与本地 `AbortController` 合并（任一触发即中止）。
     本地 controller 在超时/close 时 abort，确保**在途连接被真正中断**。
   - 通知（`msg.id === undefined`）且响应 202 ⇒ 直接返回，不解析。
   - 非 2xx ⇒ 抛错，文案含状态码；**404 单列「会话已过期，请重新连接」**。
   - 响应头有 `mcp-session-id` ⇒ 记住，后续请求带上。
   - `content-type` 含 `text/event-stream` ⇒ 逐行读 `res.body`（`for await` + 手动切行）：
     忽略 `:` 注释行、`event:`/`id:` 行、空行；`data:` 行拼接后 `JSON.parse` →
     `session.handleMessage(obj)`；**一旦该请求的 id 被 resolve 就 `break` 并 abort 读取**
     （服务器常保持流不关闭，等它结束会永久挂住）。
   - 否则 `await res.json()` → `session.handleMessage(...)`。
3. 启动时立即 `initialize` 握手（`protocolVersion: '2025-03-26'`、`capabilities: {}`、
   `clientInfo: { name:'yfworking', version }`），随后发 `notifications/initialized` 通知。
4. `tools()` = 握手后 `tools/list` 并缓存；`call(name, args)` = `tools/call`。
5. `close()` = `controller.abort()` + `session.close()`。
6. `onLog` **只记 URL 与状态码**，绝不记头值。

- [ ] **Step 4: 运行确认通过**

Run: `node --test --test-timeout=60000 kernel-tests/mcp-http.test.mjs`
Expected: 全部 PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add kernel/mcp-http.mjs kernel-tests/mcp-http.test.mjs
git commit -m "feat(mcp): 新增 Streamable HTTP 客户端（仅 POST），共用会话核心"
```

---

### Task 6: 注册表按传输分派

**Files:**
- Modify: `kernel/mcp-tools.mjs`
- Test: `kernel-tests/mcp.test.mjs`（新增分派用例）

**Interfaces:**
- Consumes: `startMcpHttpClient`（Task 5）、配置的 `url` 字段（Task 1）
- Produces: `createMcpRegistry` 对 `url` 条目走 HTTP、对 `command` 条目走 stdio，其余行为不变。

- [ ] **Step 1: 写失败测试**

```javascript
test('注册表：url 条目走 HTTP 传输并被收集', async () => {
  const { port, kill } = await startHttpStub('json')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reg-http-'))
  const cfg = path.join(dir, 'mcp.json')
  fs.writeFileSync(cfg, JSON.stringify({
    servers: { remote: { url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 } },
  }))
  const reg = createMcpRegistry({ configPath: cfg, log: () => {} })
  try {
    await reg.ready()
    const names = reg.toolNames()
    assert.equal(names.filter((n) => n.startsWith('mcp__remote__')).length, 2, 'HTTP 服务器的工具应进视图')
    assert.deepEqual(reg.failedServers(), [])
  } finally { reg.closeAll(); kill(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('注册表：一台 HTTP 失败不影响同配置里的 stdio 服务器（故障隔离）', async () => {
  const { port, kill } = await startHttpStub('json')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mix-'))
  const cfg = path.join(dir, 'mcp.json')
  fs.writeFileSync(cfg, JSON.stringify({
    servers: {
      good: { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 },
      bad: { url: `http://127.0.0.1:1/mcp`, timeoutMs: 800 },
      remote: { url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 },
    },
  }))
  const reg = createMcpRegistry({ configPath: cfg, log: () => {} })
  try {
    await reg.ready()
    assert.ok(reg.toolNames().some((n) => n.startsWith('mcp__remote__')), '可达服务器仍应可用')
    assert.equal(reg.failedServers().length, 1, '仅失败的服务器被记录')
  } finally { reg.closeAll(); kill(); fs.rmSync(dir, { recursive: true, force: true }) }
})
```

（`startHttpStub` 辅助函数从 Task 5 测试里复制过来；两个测试都需要它。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-timeout=60000 kernel-tests/mcp.test.mjs`
Expected: FAIL（url 条目未被分派到 HTTP）

- [ ] **Step 3: 实现**

改 `boot()` 内启动处：

```javascript
const c = startMcpHttpClient({ name, url: s.url, headers: s.headers, timeoutMs: s.timeoutMs, onLog })
  : startMcpClient({ name, ...s, onLog })
```

写成 `s.url ? startMcpHttpClient({...}) : startMcpClient({...})`，失败仍只 `failedServers.push`，
不影响其它服务器（既有 `Promise.allSettled` 语义保持）。

- [ ] **Step 4: 运行确认通过 + 内核全量零回归**

Run: `node --test --test-timeout=60000 kernel-tests/mcp.test.mjs`
Run: `node --test --test-timeout=60000 kernel-tests/*.test.mjs`
Expected: 前者新增用例 PASS；后者 0 fail（总数为原 1689 + 本批新增）

- [ ] **Step 5: 提交**

```bash
git add kernel/mcp-tools.mjs kernel-tests/mcp.test.mjs
git commit -m "feat(mcp): 注册表按配置自动分派 stdio / HTTP 传输"
```

---

### Task 7: 桥 `POST /mcp/test` 支持 url

**Files:**
- Modify: `server/mcp-routes.mjs`
- Test: `server/mcp-routes.test.mjs`

**Interfaces:**
- Consumes: `startMcpHttpClient`（Task 5）
- Produces: `POST /mcp/test` 对 `{url, headers}` 输入返回与 stdio 相同形状
  `{status:200, body:{ok:true, tools:[{name,...}], serverInfo}}` 或 `{ok:false, error}`。

- [ ] **Step 1: 写失败测试**

```javascript
test('POST /mcp/test：url 服务器可用，返回工具清单', async () => {
  const { port, kill } = await startHttpStub('json')
  try {
    const r = await handleMcpRoute({
      method: 'POST', pathname: '/mcp/test', configDir: CONFIG_DIR,
      readJsonBody: async () => ({ server: { url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 } }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.deepEqual(r.body.tools.map((t) => t.name), ['echo', 'whoami'])
  } finally { kill() }
})

test('POST /mcp/test：连不上时仍返回 200 且 ok:false（业务结果非 500）', async () => {
  const r = await handleMcpRoute({
    method: 'POST', pathname: '/mcp/test', configDir: CONFIG_DIR,
    readJsonBody: async () => ({ server: { url: 'http://127.0.0.1:1/mcp', timeoutMs: 800 } }),
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.ok(r.body.error)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-timeout=60000 server/mcp-routes.test.mjs`
Expected: FAIL（url 未被支持）

- [ ] **Step 3: 实现**

在 `/mcp/test` 处理器内按 `server.url` 是否存在分派到 `startMcpHttpClient` 或既有 stdio 路径；
`finally` 必须回收（HTTP 为 `await client.close()`，stdio 为 `kill`）。
**注意**：路由层已可 import kernel 模块（先例：`agents-routes.mjs` 引 `../kernel/*.mjs`）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test --test-timeout=60000 server/*.test.mjs`
Expected: 532 + 2 PASS，0 fail

- [ ] **Step 5: 提交**

```bash
git add server/mcp-routes.mjs server/mcp-routes.test.mjs
git commit -m "feat(mcp-routes): /mcp/test 支持远程 HTTP 服务器"
```

---

### Task 8: GUI 支持传输类型 / URL / 认证头

**Files:**
- Modify: `src/lib/mcpApi.ts`、`src/components/settings/McpPanel.tsx`、
  `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`
- Test: `src/lib/mcpApi.test.ts`、`src/components/settings/mcpFormat.test.ts`

**Interfaces:**
- Consumes: 桥 `/mcp/test` 对 url 的支持（Task 7）
- Produces: `McpServerConfig` 增加可选 `url?: string` 与 `headers?: Record<string,string>`；
  `mcpFormat.ts` 新增 `transportOf(config)` → `'stdio' | 'http'`。

- [ ] **Step 1: 写失败测试**

在 `src/lib/mcpApi.test.ts`：

```typescript
test('保存时透传 url 与 headers（HTTP 服务器不得被丢字段）', async () => {
  const s = stubFetch(() => ({ body: { ok: true, servers: {} } }))
  try {
    await saveMcpConfig({
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, timeoutMs: 20000 },
    })
    const body = JSON.parse(s.calls[0].init.body as string)
    assert.equal(body.servers.remote.url, 'https://example.com/mcp')
    assert.equal(body.servers.remote.headers.Authorization, 'Bearer ${TOKEN}')
  } finally { s.restore() }
})
```

在 `src/components/settings/mcpFormat.test.ts`：

```typescript
test('transportOf：按 url/command 判定传输类型（恰好其一）', () => {
  assert.equal(transportOf({ command: 'npx', args: [] }), 'stdio')
  assert.equal(transportOf({ url: 'https://e.com/mcp' }), 'http')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-timeout=60000 src/lib/mcpApi.test.ts src/components/settings/mcpFormat.test.ts`
Expected: FAIL（`transportOf` 未定义 / url 未透传）

- [ ] **Step 3: 实现**

1. `mcpApi.ts`：`McpServerConfig` 加 `url?` / `headers?`；`toServers`/`testMcpServer` 透传（不要过滤未知键）。
2. `mcpFormat.ts`：加 `transportOf(config)`。
3. `McpPanel.tsx`：
   - 每卡片顶部加传输类型选择（两个按钮或 select）：`本地命令` / `远程 HTTP`。
   - 切换时清空另一侧的传输专属字段（避免写出 `command`+`url` 并存被后端 400 拒）；
     但**保留 `timeoutMs`**（两种传输都需要）。
   - HTTP 形态渲染：URL 输入框 + 认证头 textarea（每行 `KEY=VALUE`，与 env 编辑器同款）。
   - 认证头下方灰字提示：`支持 ${ENV_VAR}，密钥不写入配置文件`。
   - 校验：URL 形态要求 url 非空；本地形态要求 command 非空（沿用既有"只拦必然无效"策略）。
   - `toRows`/`toServers` 同步支持 url/headers。
4. i18n zh/en 同步补齐新键（**无 parity 测试，须人工对齐**）：
   `mcpTransport`(传输方式)、`mcpTransportStdio`(本地命令)、`mcpTransportHttp`(远程 HTTP)、
   `mcpUrl`(服务器 URL)、`mcpHeaders`(认证头（每行 KEY=VALUE）)、`mcpHeadersHint`(支持 ${ENV_VAR}，密钥不写入配置文件)、
   `mcpErrUrlRequired`(URL 必填)。

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `node --test --test-timeout=60000 src/lib/mcpApi.test.ts src/components/settings/mcpFormat.test.ts`
Run: `npm run typecheck`
Expected: PASS / 无类型错误

- [ ] **Step 5: 提交**

```bash
git add src/lib/mcpApi.ts src/lib/mcpApi.test.ts src/components/settings/McpPanel.tsx \
  src/components/settings/mcpFormat.ts src/components/settings/mcpFormat.test.ts \
  src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(mcp): GUI 支持传输类型切换、URL 与认证头"
```

---

### Task 9: 全量门禁 + 构建同步 + 清单

**Files:**
- Modify: `docs/待处理清单.md`
- 构建产物：`dist/` → `release/YFWorking/dist/`、`kernel-dist/`

- [ ] **Step 1: 全量门禁**

```bash
npm run typecheck
node --test --test-timeout=60000 kernel-tests/*.test.mjs
node --test --test-timeout=60000 server/*.test.mjs
node --test --test-timeout=60000 "src/**/*.test.ts"
```
Expected: typecheck ✓；内核 0 fail（1 skipped）；server 0 fail；src 0 fail。

- [ ] **Step 2: 守门演练（证明新测试真能抓回归）**

任选一处故意破坏并跑对应测试，确认**精准变红**（不是全盘红）：
- 把 `interpolateEnv` 的未定义分支改成返回 `''` → 应有且仅有"未定义变量"用例变红
- 或把 HTTP 超时后的 `settle` 去掉 → 应有且仅有"超时清 pending"用例变红

记录变红用例名 → 恢复 → 确认回绿 → `grep` 确认无演练残留。

- [ ] **Step 3: 构建与同步**

```bash
npm run build
rm -rf release/YFWorking/dist && cp -r dist release/YFWorking/dist && diff -rq dist release/YFWorking/dist
node scripts/build-kernel.mjs
```
并核 `release/YFWorking/{kernel/mcp.mjs,kernel/mcp-http.mjs,kernel/mcp-tools.mjs,server/mcp-routes.mjs}` 的 md5 与源一致
（**新增文件漏拷 = 发布后启动崩**）。

- [ ] **Step 4: 真机验证（用后还原）**

对运行中的桥（默认 51517，若未运行则先启动）走真实 HTTP：
`POST /mcp/test` 传一个本地 HTTP 夹具 URL → 期望 `200 {ok:true, tools:[echo,whoami]}`；
再传坏 URL → `200 {ok:false, error}`。
**验证后必须把 `mcp.json` 还原为原值并 `GET /mcp` 复核**，不得把测试数据留在用户配置里。

- [ ] **Step 5: 更新清单并提交**

在 `docs/待处理清单.md` 的 P1-5 段追加本批完成记录（产物、决策、证据、边界），提交：

```bash
git add docs/待处理清单.md
git commit -m "docs(待处理清单): 记录 MCP Streamable HTTP 传输本批完成情况"
```

---

## Self-Review

**1. Spec coverage（逐条核对设计文档 §2「做」）：**
- 传输层抽象 → Task 2 ✓
- `kernel/mcp-http.mjs` → Task 5 ✓
- 配置 url/headers（读校写三处同步）→ Task 1 ✓
- 注册表按配置选择传输 → Task 6 ✓
- 桥 `/mcp/test` 支持 url → Task 7 ✓
- GUI 传输切换/URL/认证头 → Task 8 ✓
- 测试（本地 HTTP 夹具 + 端到端）→ Task 4/5 ✓
- 安全清单（密钥不落盘 / redirect:error / 日志不泄漏 / 零行为变化）→ Task 3、Task 5 用例 ✓
- DoD 真机验证 + 构建同步 + 清单 → Task 9 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个 code step 均给出实际代码或明确的实现要点清单。Task 5 Step 3 以「要点 + 对应测试」形式给出（该文件较长，逐字抄写会淹没真正需要判断的点），每条要点均有测试钉住。

**3. Type consistency：**
- `createJsonRpcSession({name, timeoutMs, send, onLog})` → Task 2 定义、Task 5 消费 ✓
- `interpolateEnv(value, env, where)` → Task 3 定义、Task 5 消费 ✓
- `startMcpHttpClient({name, url, headers, timeoutMs, onLog, env})` → Task 5 定义、Task 6/7 消费 ✓
- `transportOf(config)` → Task 8 定义并使用 ✓
- `McpServerConfig` 的 `url?/headers?` → Task 8 定义并与 Task 1 的后端字段名一致（`url`/`headers`）✓
