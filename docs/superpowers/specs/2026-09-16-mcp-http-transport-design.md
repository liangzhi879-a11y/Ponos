# P1-5 扩展：MCP Streamable HTTP 传输（含 GUI 配置）设计与实施

- 日期：2026-09-16
- 来源：`docs/待处理清单.md` P1-5 条目「不做 HTTP/SSE」的解除；用户选定「HTTP 传输 + resources/prompts 分两批做」
- 本批 = **第一批：Streamable HTTP 传输**；第二批 = resources/prompts（另开 spec）

## 0. 现状（代码级核实）

- `kernel/mcp.mjs`：**仅 stdio**。`startMcpClient` 内 `spawn(command, args, …)`，逐行 JSON-RPC；
  `id` 自增、`pending` Map + 每请求 `timeoutMs` 定时器、`closed` 标记、`closeWith()` 统一 reject。
- `kernel/mcp-tools.mjs`：`createMcpRegistry({configPath, log})`，`boot()` 内 `Promise.allSettled`
  并发 `startMcpClient({name, ...c, onLog})`；`view()/ready()/toolNames()/failedServers()/closeAll()`。
- `normalizeMcpServers`：**强制 `command` 必填**（`typeof cmd !== 'string' || !cmd.trim()` ⇒ 收录 error）。
- `loadMcpServers`：**同样只认带 `command` 的条目**——纯 `url` 配置会被**静默丢弃**
  （设计哲学注释：「宁可少一个工具，不要半个坏服务器」）。⇒ 本批**必须同时改读侧**，否则
  HTTP 服务器即使写进文件也不会被加载。
- `writeMcpServers`：有强约束「写出必须能被 `loadMcpServers` 读回等价」（往返断言）⇒ 改校验时二者必须同步。
- `mcpChildEnv`：**环境变量白名单**（只透传 `PATH/HOME/…`），不透传宿主全部环境
  ⇒ **HTTP 服务器不经子进程**，故与白名单无关；但 `${ENV_VAR}` 插值须读 `process.env`
  （其中已含 `cli.mjs:456` 注入的 `settings.merged.env`）。
- 桥 `server/mcp-routes.mjs`：`POST /mcp/test` 目前**只透传 `command/args/env/cwd/timeoutMs`**。
- GUI `src/components/settings/McpPanel.tsx`：字段仅 名称/命令/参数/环境变量/工作目录/超时。
- 运行时：**Node v24.14.1** ⇒ 原生 `fetch` + `ReadableStream` + `AbortController` 可用，**零新依赖**。
- 既有基线：内核 **1689 / 1688 pass / 0 fail / 1 skipped**、src **585**、server **532**、typecheck ✓。

## 1. 规范选择（重要）

用户表述为「HTTP/SSE」。**旧式 HTTP+SSE（`2024-11-05`）已被废止**：它需两个端点
（GET 建 SSE 流 + POST 发消息）。现行规范 `2025-03-26` 的 **Streamable HTTP** 用**单一端点**：
POST 发消息，响应可协商为 `application/json` 或 `text/event-stream`。

**本批按 Streamable HTTP 实现，不实现已废止的旧式双端点。**

## 2. 范围

**做**：
1. 传输层抽象：抽出 JSON-RPC 会话核心，stdio 与 HTTP 共用同一套 `pending/超时/中断/收尾` 语义。
2. `kernel/mcp-http.mjs`：Streamable HTTP 客户端（**仅 POST**）。
3. 配置：支持 `url` + `headers`（与 `command` 互斥）；读/写/校验三处同步。
4. 注册表：按配置自动选择传输。
5. 桥 `POST /mcp/test`：支持 url 服务器。
6. GUI：传输类型切换、URL、认证头编辑（每行 `KEY=VALUE`）。
7. 测试：本地 HTTP 夹具 + 端到端用例。

**不做**（诚实标注）：
- **不做 GET 通道**（用户已定）：本仓库无 server→client 主动消息消费方，服务器返回 405 表示不支持即可。
- **不做** 旧式双端点 SSE（规范已废止）。
- **不做** OAuth 授权流程（规范允许，但工作量大；先支持静态头）。
- **不做** resources/prompts（第二批）。
- **不做** 自动重连（与 stdio 一致：失败即标记不可用）。

## 3. 设计

### 3.1 会话核心抽取（`kernel/mcp.mjs`）

新增导出 `createJsonRpcSession({ name, timeoutMs, send, onLog })`：

```
→ { request(method, params, {signal}), notify(method, params),
    handleMessage(msg), failAll(err), close(), stats() }
```

- `request`：生成 `id` → 注册 pending + 定时器 → `send(msg, {signal})`（**同步异常立即 reject**）。
- `handleMessage`：按 `id` 命中 pending → resolve/reject → **清定时器**。
- `close()`：置 `closed`、`failAll`（**绝不悬挂**——悬挂会卡死引擎轮次）。
- 传输只需实现 `send` 并负责把入站消息交给 `handleMessage`。
- `startMcpClient`（stdio）改为基于该核心；**保持原签名与导出名不变**（既有 16 个用例不动）。

### 3.2 `kernel/mcp-http.mjs`

`startMcpHttpClient({ name, url, headers, timeoutMs, onLog, env })` → 与 stdio 客户端**同形状**
（`tools()/call()/close()/stats()`），使注册表与接入层无感。

- `env` = 插值取值来源，**默认 `process.env`**（可注入，便于测试不污染真实环境）。

- **请求头**：`content-type: application/json`、`accept: application/json, text/event-stream`、
  认证头（插值后）、握手后带 `mcp-session-id`（若服务器给了）。
- **响应处理**：`content-type` 含 `text/event-stream` ⇒ 按 SSE 逐行解析 `data:` 后
  `handleMessage`；否则 `res.json()` 后 `handleMessage`。
  - SSE 细节：忽略 `event:`/`id:`/注释行（`:` 开头）与空行分隔；`data:` 可能多行需拼接；
    **拿到本请求 `id` 的响应后立即终止读取并释放连接**（服务器常保持流不关闭，
    若等流结束会永久挂住）。
- **通知**（无 `id`）：服务器返回 202 空体 ⇒ 不解析响应体。
- **HTTP 非 2xx**：转成该 `id` 的 reject（含状态码与响应片段），**pending 不泄漏**。
  `404` 单列一条文案：**会话已过期**（服务器要求重新 `initialize`），与"地址写错"区分开。
- **超时**：沿用会话核心定时器；同时用 `AbortController` **中断在途 fetch**（否则请求虽 reject、连接仍挂着）。
- **重定向：`redirect: 'error'`**。理由：`fetch` 默认跟随重定向会把 `Authorization`
  带到**另一个主机**（凭据泄漏向量）。MCP 服务器不应重定向，故直接报错更安全。
- **不记录任何头值**：`onLog` 只上报 URL 与状态码（见 §4）。

### 3.3 `${ENV_VAR}` 插值（安全）

- 语法：`${VAR}`；**插值点仅 `url` 与 `headers` 的值**（`command/args/env` 保持原样，避免面扩大）。
- **求值时机 = 启动时（运行时）**，不是写盘时。配置文件里**永远保留 `${MY_TOKEN}` 字面量**
  ⇒ **密钥不落盘**（`mcp.json` 会被备份/截图/同步 OneDrive）。
- **未定义即报错**（不静默替换为空串）：错误文案**点名变量名**，如
  `环境变量 MY_TOKEN 未定义（配置项 headers.Authorization）`。理由：静默空串会变成
  `Bearer ` 换来一个含义不明的 401，排查成本远高于直接报错。
- 校验（`normalizeMcpServers`）**只校验语法**、不要求变量已定义——因为写配置的环境
  未必是运行环境（如 GUI 在桌面、服务器变量在另一处）。变量是否存在由「连接测试」即时反馈。

### 3.4 配置结构

```json
{ "servers": {
  "local":  { "command": "npx", "args": ["-y", "…"], "env": {}, "timeoutMs": 20000 },
  "remote": { "url": "https://example.com/mcp",
              "headers": { "Authorization": "Bearer ${MY_TOKEN}" }, "timeoutMs": 20000 }
}}
```

校验规则（`normalizeMcpServers` 与 `loadMcpServers` **必须同口径**）：
- `command` 与 `url` **恰好其一**：都没有 ⇒ 错；都有 ⇒ 错（消歧，避免"到底走哪条路"的疑问）。
- `args` / `env` / `cwd` **仅** `command` 允许；`headers` **仅** `url` 允许。
- `url` 必须是 `http:` / `https:` 绝对地址（`new URL()` 可解析）。
- 保留既有宽容：`timeoutMs` 非正数忽略、`env` 非对象忽略、未知顶层键保留。

### 3.5 注册表与桥

- `mcp-tools.mjs` `boot()`：`c.url ? startMcpHttpClient({...}) : startMcpClient({...})`。
  失败仍**只记该服务器**，不影响其它（既有故障隔离语义不变）。
- `server/mcp-routes.mjs` `POST /mcp/test`：透传 `url/headers`，返回形状不变
  （`{ok, tools, serverInfo}` 或 `{ok:false, error}`）⇒ 前端无需分支。

### 3.6 GUI（`McpPanel.tsx`）

- 每卡片加**传输类型**选择：`本地命令` / `远程 HTTP`。
- 本地命令 → 现有字段（命令/参数/环境变量/工作目录）。
- 远程 HTTP → **URL** + **认证头**（每行 `KEY=VALUE`，与 env 编辑器同款交互）。
- 校验提示沿用既有模式（只拦必然无效者）；连接的最终判定交给「连接测试」。
- 头部编辑器下方提示：`支持 ${ENV_VAR}，密钥不写入配置文件`（让"为什么不填明文"可被看见）。
- i18n：zh/en 同步补键（**本仓库无 parity 测试，必须人工对齐**）。

## 4. 安全清单

| 面 | 措施 |
|---|---|
| 密钥落盘 | 只存 `${VAR}` 字面量，运行时求值 |
| 凭据泄漏（重定向） | `redirect: 'error'`，不跨主机带 `Authorization` |
| 日志泄漏 | `onLog` 与失败信息**只含 URL/状态码**，**绝不含头值**；测试断言 token 不出现在日志与错误串中 |
| 错误可见性 | 未定义变量/HTTP 错误/**会话过期(404)** 均给出点名式文案 |
| 零行为变化 | 未配置 HTTP 服务器的用户，视图与既有行为**逐字不变**（回归用例证明） |

## 5. 验收（DoD）

1. **夹具** `kernel-tests/fixtures/mcp-http-stub-server.mjs`（`node:http`，零依赖）：
   `initialize`（回 `Mcp-Session-Id`）、`tools/list`、`tools/call`；
   故障模式：`sse`（SSE 响应）、`json`（普通 JSON）、`http500`、`hang`（不响应）、
   `no-session`（无 session 直接 404）、`echo-auth`（回显收到的认证头，供插值用例断言）。
2. **`kernel-tests/mcp-http.test.mjs`** 端到端：
   - JSON 响应路径 + SSE 响应路径**均能**完成握手、`tools/list`、`tools/call`
   - `Mcp-Session-Id` 被捕获并在后续请求回传
   - **`${ENV_VAR}` 插值生效**（`echo-auth` 断言服务器收到解析后的值）
   - **未定义变量 ⇒ 报错且点名变量、且未发出请求**
   - HTTP 500 ⇒ 可读错误 + `pending === 0`
   - 超时 ⇒ reject + `pending === 0` + 在途 fetch 被 abort
   - **头值不泄漏**：日志与错误串中不含 token
   - `close()` 后调用立即失败（不悬挂）
3. **`kernel-tests/mcp.test.mjs` 增补**：`normalizeMcpServers` 接受纯 `url`、拒绝 `command`+`url` 同时存在、
   拒绝 `headers` 配 `command`、拒绝非 http(s) url、拒绝 `args` 配 `url`；
   **`loadMcpServers` 不再丢弃纯 url 条目**；**往返断言**（`writeMcpServers` 写出可被 `loadMcpServers` 读回等价）。
4. **零回归**：内核 **1689/1688 pass/0 fail/1 skipped** + 新增用例数；src **585**；server **532**；typecheck ✓。
5. **守门演练**：破坏任一处（如插值改成静默空串 / `pending` 超时不清）→ 相应用例**精准变红**
   → 恢复回绿 + grep 无残留。
6. **真机验证**：对运行中的桥（51517）走真实 HTTP 验证 `/mcp/test` 对 url 服务器可用，**用后还原配置**。
7. GUI 构建 → `release/YFWorking/dist` 同步；`kernel-dist` 重建；清单更新。
