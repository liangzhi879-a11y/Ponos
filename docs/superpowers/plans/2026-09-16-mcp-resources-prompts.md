# Plan：MCP 第二批（resources + prompts）实施计划（2026-09-16）

spec：`docs/superpowers/specs/2026-09-16-mcp-resources-prompts-design.md`
每个 Task 完成后立即跑该 Task 的验证命令；**不得**攒到最后一起跑（本仓库既往教训：一次性大改后
出问题无法二分定位）。

## Task 1 — 共用能力工厂（先抽，后加）

产物：`kernel/mcp-caps.mjs`（新增）

1. 导出 `createCapabilities(session, { name, onLog })`，把**现有** `tools()` / `call()` 的
   实现从 `kernel/mcp.mjs` 原样搬入（含 `toolsCache` 缓存、`calls` 计数、`contentToText` 用法、
   错误文案），签名与返回形状逐字不变。
2. `kernel/mcp.mjs` 的 stdio 客户端改为 `const caps = createCapabilities(session, { name, onLog })`，
   其 `tools()`/`call()` 转发到 `caps`。
3. `kernel/mcp-http.mjs` 同样改造，删掉它自己那份 `tools()`/`call()` 实现。

验证：`node --test kernel-tests/mcp.test.mjs` **16/16 绿**（既有断言不动）。
这是"改动无行为变化"的证据——若此处变红，说明搬迁改变了行为，必须修到全绿再继续。

## Task 2 — resources 能力（会话层）

产物：`kernel/mcp-caps.mjs` 增 `resources()` / `readResource(uri, opts)`

1. `resources()`：`resources/list` + `resources/templates/list`（后者失败**不致命**——
   部分服务器不实现 templates，拿不到就只回 list 结果并记日志）。
   归一化：`{ uri, name, description, mimeType, isTemplate }`；清单条数上限参数化（默认 200）。
2. `readResource(uri)`：`resources/read` ⇒ 文本化，落实 spec D-3：
   - `text` 项：累加，超 `MCP_RESOURCE_MAX_CHARS`（默认 20000）截断 + **显式标注原始长度**；
   - `blob` 项：**只报元信息**（uri/mimeType/字节数），**绝不 base64**；
   - 返回 `{ text, isError, truncated, originalChars }`——`truncated` 让上层与测试可断言。

验证：先补 stub 夹具（Task 4）再测；本步先跑 `node --check kernel/mcp-caps.mjs` + 既有 16 用例不回归。

## Task 3 — prompts 能力 + 接入注册表

产物：`kernel/mcp-caps.mjs` 增 `prompts()` / `getPrompt(name, args)`；`kernel/mcp-tools.mjs` 增 resources 工具

1. `prompts()`：`prompts/list` ⇒ `{ name, description, arguments }`。
2. `getPrompt(name, args)`：`prompts/get` ⇒ 复用 `contentToText` 渲染为文本。
3. `mcp-tools.mjs` 的 `collect()` 里，为每个服务器追加**两个只读工具**
   （`mcp__<s>__list_resources`、`mcp__<s>__read_resource`），`concurrencySafe: false`，
   描述带 `[MCP:<server>]` 前缀（与既有工具一致），`run()` 内 try/catch **不上抛**。
4. **prompts 不入 `entriesByKey`**（spec D-4）；注册表增加 `promptsSnapshot()` 供桥路由取用。
5. `snapshot()` 增 `resources` 计数（面板可显示），**不破坏既有字段**。

验证：`node --test kernel-tests/mcp.test.mjs` 仍绿（既有 16 条不得回归）。

## Task 4 — stub 夹具扩展 + 新用例

产物：`kernel-tests/fixtures/mcp-stub-server.mjs`（扩展）、`kernel-tests/mcp-resources.test.mjs`（新增）

1. 夹具支持 5 个新 method，并内置：一个正常文本资源、一个**超大资源**（> 阈值）、一个 **blob 资源**、
   一个不存在的 uri（验失败路径）、两个 prompt（一个带必填参数）。
2. 用例（spec §5 的 1–6 条）：
   - 共用工厂：stdio 与 HTTP 两条路径产出**同一形状**；**反向断言**：`mcp.mjs`/`mcp-http.mjs`
     源码内不得出现 `resources/` `prompts/` 的 `session.request` 直调（防重复回潮）。
   - 命名与 `expose` 过滤（`private` 时该服务器的 resources 工具不可见）。
   - **截断**：超大资源被截断、标注含原始长度、`truncated===true`；正常资源 `truncated===false`
     （反向断言，防"一律截断"）。
   - **blob**：输出**不含** `data:` 或长 base64 片段，且含 uri/mimeType/字节数。
   - 失败不抛：坏 uri / 服务器关闭 ⇒ `{content, isError:true}`。
   - **prompts 不进 `view()`**（反向断言）。
3. **守门演练**：临时把截断阈值改大（使超大资源不截断）⇒ 截断用例应变红；临时把 prompt 塞进
   `entriesByKey` ⇒ prompts 反向断言应变红。两次均复原并 grep 确认无残留。

验证：`node --test kernel-tests/mcp-resources.test.mjs` 全绿；`node --test kernel-tests/*.test.mjs`
总计 pass/fail 计数（与基线对比，零回归）。

## Task 5 — 桥路由 + GUI

产物：`server/mcp-routes.mjs`（增两端点）、`server/mcp-prompts-routes.test.mjs`（新增）、
`src/components/settings/mcpFormat.ts`（增纯函数 + 用例）、`src/components/settings/McpPanel.tsx`（接线）

1. `GET /mcp/prompts`：连各启用服务器取 prompts 清单（含参数声明）。三态区分同既有约定。
2. `POST /mcp/prompts/get`：`{ server, name, arguments }` ⇒ `{ ok, text }`；
   参数缺失/服务器不存在 ⇒ 400（用户数据不合规）；服务器连不上 ⇒ 200 + `ok:false`。
3. GUI 纯函数：`promptArgsOf`（必填参数校验）、`renderPromptText`（空/超长文本的展示裁剪）等，
   零依赖、可 `node --test` 直测。
4. `McpPanel.tsx`：每服务器卡片增加"查看 prompts"入口；选中一个 ⇒ 参数表单 ⇒
   渲染结果**交给用户**（可复制/插入输入框），**不自动发送**。

验证：`node --test "server/*.test.mjs"`、`node --test "src/**/*.test.ts"` 计数；`npm run typecheck` ✓。

## Task 6 — 门禁、release 核对、文档

1. 分段门禁并记录计数：`npm run typecheck`；`node --test kernel-tests/*.test.mjs`；
   `node --test "src/**/*.test.ts"`；`node --test "server/*.test.mjs"`。
2. release 核对：若新增了需随包发布的文件（`kernel/mcp-caps.mjs` 属内核侧，
   须核对 `release/YFWorking/kernel/` 是否包含）；`md5` 逐一比对 + `diff -rq`。
   **易漏点**：若 `mcp.mjs`/`mcp-http.mjs` 新增 `import './mcp-caps.mjs'`，漏同步该文件
   ⇒ **内核启动即崩**（与 `guards.mjs` 那次同型风险）。
3. 在 `docs/待处理清单.md` 第 273 行条目进度区**追加**本子项完成记录（产物/证据/已知边界），
   **不修改既有文字**、**不自行勾选** `[x]`（勾选由主控判断）。
4. 提交（按依赖序，spec/plan 与实现分开或合并成一个主题明确的提交）。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 搬迁 tools 改变行为 | Task 1 单独成步，先跑既有 16 用例全绿再往下 |
| 重复回潮（第三、四份） | 反向断言读源码禁 `session.request('resources/…')` |
| 照 tools 抄一份 prompts 工具 | 反向断言 prompts 不得出现在 `view()` |
| 截断写成"一律截断" | 正常资源必须 `truncated===false` 的反向断言 |
| blob 泄漏 base64 | 断言输出不含 `data:`/长 base64 |
| release 漏同步新文件 | Task 6 的 md5 + diff -rq + 包内加载实测 |
