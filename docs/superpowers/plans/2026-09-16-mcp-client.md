# P1-5 MCP 客户端实施计划

spec：`docs/superpowers/specs/2026-09-16-mcp-client-design.md`

## 步骤

### S1 新建 `kernel/mcp.mjs`（纯 stdio JSON-RPC 客户端，不依赖引擎状态）
- `loadMcpServers(path)`：读 `{ servers: {...} }`；缺文件 → `{}`；坏 JSON → 抛出（由调用方记日志跳过）
- `startMcpClient({ name, command, args, env, cwd, timeoutMs, onLog })`：
  - `spawn` 子进程，stdout 逐行 JSON 解析；忽略无 id 的通知
  - `initialize` 握手 → `notifications/initialized`
  - `tools()`：缓存 `tools/list` 结果（首取一次）
  - `call(tool, args, { signal })`：`tools/call` 往返；JSON-RPC error → 抛带 `isMcpToolError` 标记的错误（由接入层转成 `is_error`）
  - 超时：每请求 `timeoutMs`，超时 reject **并清理 pending**
  - 进程退出 / stdin 断流：置 `closed`，**所有 pending 立即 reject**（不悬挂）
  - `close()`：kill 子进程；`stats()`：`{ pending, closed, lastStderr, calls, errors }`
- `mcpToolName(server, tool)`：`mcp__<server>__<tool>`（安全字符化）
**验证**：`node --check` ✓

### S2 新建 `kernel/mcp-tools.mjs`（接入层：客户端 → 动态工具视图）
- `createMcpRegistry({ configPath, log })`：
  - 懒启动（首次 `view()` 时启动所有配置的 server；单个失败只记日志，不影响其它）
  - `view()` 返回 `[{ name, description: '[MCP:<server>] ' + desc, input_schema, run(input, ctx) }]`
  - `run` 内：`call` → 结果文本化（content 数组 → 文本；非文本 → JSON）；异常 → `{ content:[{type:'text',text:'MCP 工具错误: …'}], is_error:true }`
  - `closeAll()`：内核退出时 kill 全部子进程
**验证**：`node --check` ✓

### S3 接入 `kernel/cli.mjs` 视图函数
在 `return [...buildWorkflowTools(...), ...buildAppTools(...)]` 处追加 `...mcpView()`。
**关键**：缺配置时 `mcpView()` 返回 `[]` ⇒ 既有行为**逐字不变**。
**验证**：内核全量回归与基线一致（1647/1646 pass）。

### S4 测试 `kernel-tests/mcp.test.mjs`
夹具 = 临时 stub 服务器脚本（node 子进程，实现 `initialize`/`tools/list`/`tools/call`），覆盖：
1. 握手 + `tools/list` 发现
2. `tools/call` 往返（含 content 数组 → 文本）
3. JSON-RPC error → `is_error`（不抛崩引擎）
4. **超时**：服务器不回 → reject 且 `stats().pending === 0`
5. **进程退出**：pending 被 reject、`closed === true`
6. 命名 `mcp__<server>__<tool>` 与描述前缀 `[MCP:server]`
7. 缺配置 → `view()` 返回 `[]`
8. 坏 JSON 配置 → 不抛崩（跳过）
**验证**：`node --test kernel-tests/mcp.test.mjs` 全绿

### S5 守门演练
把超时 reject 改成忽略（或 pending 不清理）→ 用例 4/5 应变红 → 恢复回绿 + grep 无残留。

### S6 全量门禁
typecheck、`kernel-tests/*.test.mjs`（应 = 基线 1647 + 新增数）、`src/**/*.test.ts` 560、`server/*.test.mjs` 522。

### S7 同步 + 清单 + 经验
- 同步 `kernel/{mcp,mcp-tools}.mjs` + `kernel/cli.mjs` → `release/YFWorking/kernel/`；md5 核对 + `diff -rq`；重建 `kernel-dist`
- 更新 `docs/待处理清单.md`：P1-5 段标记完成 + 证据 + 既定边界（不做 HTTP/SSE、不做 resources/prompts、不做 GUI、不做重连）
- 经验沉淀到 `workflow.md`
