# P1-5 MCP 客户端（stdio）设计与实施

- 日期：2026-09-16
- 来源：`docs/2026-09-15-五引擎架构性能对比分析.md` §5 P1-5
- 文档原文：「cc/codex/dsh 三家均有真实实现；ponos 的 `unknown` 工具类已预留（默认档放行），接入成本主要在协议层（可复用 `protocol.mjs` 的 NDJSON 经验）」

## 0. 现状（代码级核实）

- `kernel/*.mjs` 内 `mcp` **零命中** ⇒ 确无实现，从零开始。
- `kernel/approval-mode.mjs` **已预留** `unknown: 'loose'`（注释写明「MCP、动态工具」）⇒ **审批矩阵无需改动**，MCP 工具天然落在"未识别工具"档（从 `loose` 起）。
- 接入点**已经存在**：`kernel/tools.mjs` 的 `createToolRegistry({ … dynamicTools })` 支持一个**动态工具视图函数**，每次取工具表时求值（含 try/catch 兜底），并提供 `setDynamicTools(fn)` 做热替换。`kernel/cli.mjs:726` 即在视图函数内 `return [...buildWorkflowTools(...), ...buildAppTools(...)]`——**MCP 工具与"应用智控工具"是同一接入范式**。
- 动态条目形状（`tools.mjs:1857/1876`）：`{ name, description, input_schema, run(input, ctx) }`；动态名单会**排除与静态工具同名的项**。
- 可复用经验：`kernel/protocol.mjs` 的 NDJSON 处理（`writeLine` 只在**写成功后**推进时间戳、`beginAwaitingUser/endAwaitingUser` 用计数而非布尔）。

## 1. 范围

**做**：stdio 传输的 MCP 客户端最小可用闭环 —— 配置 → 启动子进程 → `initialize` 握手 → `tools/list` 发现 → 映射为动态工具 → `tools/call` 执行 → 生命周期收尾（含槽位释放与 stdin 断流处理），并接入 `cli.mjs` 的视图函数。

**不做**（诚实标注）：
- **不做** HTTP/SSE 传输（文档只要求"真实可用"，stdio 是覆盖面最广、最省依赖的起点）
- **不做** resources / prompts / sampling（只做 tools —— 这是"能用"的最短路径）
- **不做** GUI 配置界面（配置走文件；GUI 接入另开条目）
- **不做** 断线自动重连（首版：进程退出即标记不可用，工具从视图消失）

## 2. 设计

### 2.1 新模块 `kernel/mcp.mjs`

纯 stdio JSON-RPC 2.0 客户端，**不依赖引擎内部状态**（便于单测）：

```
export function loadMcpServers(configPath)         // 读配置（缺文件→{}，坏 JSON→抛出）
export async function startMcpClient({ name, command, args, env, cwd, timeoutMs, onLog })
      → { name, tools(): [{name, description, input_schema}], call(name, args, {signal}), close(), stats() }
export function mcpToolName(server, tool)          // 命名：mcp__<server>__<tool>（见 §2.3）
```

- **传输**：`child_process.spawn(command, args, { stdio: ['pipe','pipe','pipe'], env: {...childEnv()} })`，逐行 JSON。
- **帧格式**：请求 `{jsonrpc:'2.0', id, method, params}`，响应 `{jsonrpc:'2.0', id, result|error}`；**忽略通知**（无 id）。
- **握手**：`initialize`（`protocolVersion` + `clientInfo` + `capabilities:{}`）→ 收到 result 后发 `notifications/initialized`。
- **超时**：每次请求带 `timeoutMs`（默认 20000）；超时 reject 并**清理 pending**，不让 id 泄漏。
- **stdin 断流 / 进程退出**：置 `closed`，所有 pending 立刻 reject（**不能悬挂**，否则工具调用卡死引擎轮次）。
- **stderr**：按行捕获，最近 N 行留作诊断（`stats().lastStderr`），并通过 `onLog` 上报（不污染 stdout 协议流）。
- **安全**：`env` 白名单（复用 `tools.mjs` 的 `childEnv()` 思路），不透传宿主全部环境；子进程随内核退出而被 kill。

### 2.2 配置

`~/.yfworking/mcp.json`（沿用该目录既有配置风格）：

```json
{ "servers": { "<name>": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-everything"], "env": {}, "cwd": null, "timeoutMs": 20000 } } }
```

- 缺文件 ⇒ 不启用（**默认零行为变化**，这是本轮"不干扰既有用户"的关键）。
- 解析失败 ⇒ 记一条 system 日志并跳过该文件，**不让内核启动失败**。

### 2.3 工具命名与冲突

- 命名：`mcp__<server>__<tool>`（双下划线分隔，与 `app_*` 体系不冲突；对 server/tool 名做安全字符化）。
- **同名冲突**：`tools.mjs` 的动态视图已排除"与静态工具同名"的项；MCP 之间重名由命名前缀天然避免。

### 2.4 审批与安全

- MCP 工具**不加入任何白名单** ⇒ 落到 `approval-mode` 的 `unknown` 档（从 `loose` 起）⇒ **审批矩阵零改动**即获得正确安全语义。
- 工具描述里**标注来源**（`[MCP:<server>] …`），让用户与模型都能看出这是外部工具。

### 2.5 生命周期接入

- `cli.mjs` 视图函数：`return [...buildWorkflowTools(...), ...buildAppTools(...), ...mcpToolsView()]`。
- 启动：内核启动时**懒加载**（首次取工具表时启动；失败则记日志并永久标记不可用，不重试轰炸）。
- 收尾：内核退出/轮次结束不关闭（MCP 是长驻会话）；`process.on('exit')` 与 `killActiveChildren` 路径 kill 子进程。

## 3. 验收（DoD）

1. `kernel-tests/mcp.test.mjs`：用**测试用 stub 服务器脚本**（node 子进程，实现 `initialize`/`tools/list`/`tools/call`）端到端验证：
   - 握手与 `tools/list` 发现
   - `tools/call` 往返（含非字符串结果 → 文本化）
   - 工具错误（JSON-RPC error）→ 返回 `is_error` 而非抛崩
   - **超时**：服务器不回 → reject 且 pending 清理（`stats().pending === 0`）
   - **进程退出/断流**：pending 被 reject、工具从视图消失（不悬挂）
   - 命名与描述前缀
2. `cli.mjs` 视图函数返回中**确实包含** MCP 工具（stub 配置下）。
3. 缺配置 ⇒ 视图与既有行为**逐字不变**（回归证明）。
4. 内核全量 **1647 / 1646 pass / 0 fail / 1 skipped**（与基线一致）+ 新增用例数；src 560；server 522；typecheck ✓。
5. 守门演练：破坏（如把超时 reject 改成忽略）→ 相应用例变红 → 恢复回绿 + grep 无残留。
6. 同步调试版（含新模块）+ 重建 `kernel-dist`。
