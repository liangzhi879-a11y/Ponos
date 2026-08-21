# YFW-turbo subagent 体系 + 工具扩展设计

日期：2026-08-20
状态：方案设计（实施中）
依据：`2026-08-20-yfw-turbo-inner-core-design.md` §10（子代理/工具面"下一轮"）、`2026-08-13-multi-agent-collab-design.md`（GUI 侧已落地，内核侧未接）、用户确认（2026-08-20：两者并行 / 进程内 lane / 内置+扫描 / 工具对标旧内核及配套工具）

## 1. 背景与现状缺口

GUI/bridge 管线已为 release 内核（Claude Code）铺好，净室内核（kernel/）未接：

| 环节 | 现状 |
|---|---|
| GUI agent 注册表 / whenToUse / agents:sync / `$YFW_HOME/agents/*.md` | ✅ 已实现 |
| 内核读取 `$YFW_HOME/agents/*.md`（用户级 agent） | ❌ `prompt.mjs::discoverAgentsMd` 只发现项目 `AGENTS.md` |
| Agent 工具（主 agent → 子 agent） | ❌ `tools.mjs` 无 |
| 子 agent 执行模型 | ❌ engine 单循环 |
| task_started / task_progress / task_notification 事件 | ❌ `protocol.mjs` 无构造器 |
| GUI 二级面板（RunningAgentsBar 已接 / SubAgentPanel 未接） | ⚠️ 事件源缺失；SubAgentPanel 组件存在未集成 |
| 工具面 | ✅ 6 工具（Bash/Read/Write/Edit/Glob/Grep，schema 已齐）；缺 Agent/Task/TodoWrite/WebFetch/WebSearch/Browser（对标旧内核）+ OCR（配套） |

**硬约束**（设计铁律）：零运行时依赖（Node ESM 单进程）；**单进程隔离契约**（§3.7 拒绝多进程治理 → subagent 必须进程内 lane）；transcript 权威源；路径边界校验。

## 2. subagent 体系

### 2.1 agent 发现（prompt.mjs + 新 kernel/agents.mjs）

- 新增 `kernel/agents.mjs`：
  - `BUILTIN_AGENTS`：内置 2 个系统级 agent——`general-purpose`（通用多步任务，全工具）、`researcher`（调查类，Bash/Glob/Grep/Read/WebFetch）。业务专业 agent（material-writer/table-expert 等 6 个）由 GUI 经 agents:sync 写入 `$YFW_HOME/agents/`，走扫描，不内置重复。
  - `parseAgentMarkdown(text)`：解析 `.md` frontmatter（name/description/tools/model/skills + 正文 prompt），与 multi-agent-collab 设计的 `.md` 格式一致；非法文件容错跳过。
  - `discoverUserAgents({ configDir })`：扫描 `$YFW_HOME/agents/*.md`（跳过 `.` 开头与 `.yfw-managed.json`），返回 `[{ id, name, description, tools, model, systemPrompt }]`。
  - `resolveAgent(agents, type)`：内置 ∪ 扫描 的查找。
- `prompt.mjs::composeSystemPrompt` 增补 **agents 区块**：`【可用子 Agent】type — whenToUse/description（tools: ...; model: ...）`，供主 agent 按优势场景路由。

### 2.2 Agent 工具（tools.mjs + engine.mjs）

- input_schema：`{ subagent_type: string, prompt: string, run_in_background?: boolean, description?: string }`
- run() → `engine.spawnSubAgent(...)`（经 ctx 注入；tools.mjs 不直接依赖 engine，run 接收 ctx 参数已有预留）。
- 语义：主 agent 委派子 agent 执行独立子任务，结果作为 tool_result 回填主循环。

### 2.3 进程内 lane（engine.mjs + session.mjs 复用）

**子 lane = 独立 session store**（复用 `createSessionStore`，sessionId = `<主sessionId>-<taskId>`，文件独立 `<dir>/<主id>-<taskId>.jsonl`）：
- 主会话 transcript 零污染（只有 Agent tool_use + tool_result 摘要），GUI 时间线不显示子 agent 内部对话；子 lane 文件为独立权威源，可回溯。
- 压缩只作用主 lane（子 lane 会话短，v1 不压缩）。
- session.mjs 零改动（复用工厂）。
- 子 agent 工具共享主 registry（Bash/Read/Write/... 同边界）；**嵌套分发禁止**（子 lane 内 Agent 工具返回错误"子 agent 不支持嵌套分发"）。

### 2.4 子 agent 执行循环（engine.mjs）

`spawnSubAgent({ type, prompt, description, runInBackground })`：
1. `resolveAgent` → systemPrompt（agent body）；未知 type → 错误并列出可用。
2. 创建 laneStore；`taskId = newSessionId()`。
3. `wire.taskStarted({ task_id, tool_use_id, prompt })`。
4. 子循环（复用 runTurnInternal 骨架，参数化：独立 store / 独立 systemPrompt / 共享 tools / 禁 Agent 工具）：
   - 每工具轮发 `task_progress`（last_tool_name / description / usage 近似累计）。
   - 工具执行走既有 `executeToolUse`（权限判定/审批挂起共用；toolUseId 为 UUID 不冲突）。
   - 取消：共享 engine signal——主 cancel 中断进行中的子循环（后台任务检查点抛出）。
5. 结束 → `wire.taskNotification({ task_id, status: 'completed'|'failed'|'stopped', summary: 最终文本, output_file: 子 agent 最后 Write 路径（如有）, usage })`。
6. 前台：返回 `{ content: 子 agent 最终文本 + 统计, isError }` 作 tool_result。
   后台：立即返回 `{ content: '任务已后台启动（task_id=...）' }`，异步继续；完成时 task_notification 交付（GUI 面板承接），结果由 Task 工具查询。

后台任务管理：`engine.pendingSubAgents: Map<taskId, { status, promise, laneStore, summary, outputFile, usage }>`；进程退出即失（非持久化，非目标）。

### 2.5 事件构造器（protocol.mjs）

`makeWire` 新增（均走 `wire.system(subtype, extra)`，shape 对齐 GUI 消费端 useYFWCLI.ts task_* 分支）：
- `taskStarted({ taskId, toolUseId, prompt })` → `system/task_started`
- `taskProgress({ taskId, lastToolName, description, usage })` → `system/task_progress`
- `taskNotification({ taskId, status, summary, outputFile, usage })` → `system/task_notification`

## 3. 工具扩展（对标旧内核 + 配套）

| 工具 | 对齐 | 说明 |
|---|---|---|
| Agent | 旧内核 Agent | 见 §2.2 |
| Task | 旧内核 Task | `{ command: 'list'\|'status'\|'output'\|'stop', task_id? }`；查询/中止后台任务 |
| TodoWrite | 旧内核 TodoWrite | 内存 todo 规划列表，每次更新回显当前列表 |
| WebFetch | 旧内核 WebFetch | Node 内置 https/http，零依赖；url 校验 http/https、30s 超时、2MB 上限、HTML→文本简易提取 |
| OCR | 配套开发工具（OCR 引擎） | spawn python 调 `ocr_engine.py`（RapidOCR/PP-OCRv4，系统已装），零 npm 依赖；引擎探测 `YFW_OCR_ENGINE` env → `~/.claude/skills/_common/ocr_engine.py` → `~/.yfworking/skills/_common/`；PDF 走 CLI（--output 全量 JSON），图片走内联 import `ocr_image()`；`mode: text\|table`、`project` 缓存隔离；边界校验同 Read；5min 超时 |
| WebSearch | 旧内核 WebSearch | 本轮 roadmap（零依赖搜索实现脆弱，需评估），v1 不做 |
| Browser | 配套开发工具（BrowserTool） | roadmap：`bridge_request(browser)` 通道 bridge 侧已就绪（browserRouter），但 executor 依赖 electron 主进程浏览器，端到端验证成本高，本轮不做（protocol 已留位） |
| NotebookEdit | 旧内核 | 非目标（申报/开发场景无 notebook） |

**工具注册模式**：tools.mjs 现有结构（registry + input_schema + run + toolSchemas），新工具同模式加入，`createToolRegistry` 保持零依赖。

**子 agent 可用工具**：除 Agent 外全部（Task/TodoWrite/WebFetch 亦可用）；由 registry 过滤（`subagentSafe` 标志或 Agent 工具在 lane 上下文内检查）。

## 4. 提示词组装

- base system prompt 的"可用工具"行自动含新工具（engine.toolNames 已动态）。
- agents 区块（§2.1）让主 agent 知道可委派对象。
- Agent 工具纪律：任务可委派/需并行时使用；子 agent 结果以摘要回填。

## 5. GUI 集成（收尾）

- `ChatWindow.tsx` 集成 `<SubAgentPanel conversationId />`（状态 B 结果卡，组件已存在未接入；RunningAgentsBar 状态 A 已接）。
- GUI 侧 task_* 消费已就绪，无需改动事件处理。

## 6. 测试计划（server/*.test.mjs，mock API）

1. agents.mjs：frontmatter 解析、内置∪扫描合并、非法文件容错、未知 type 报错。
2. Agent 工具前台：mock 流 → task_started → task_progress → task_notification 顺序 + tool_result 回填内容。
3. 后台任务：立即返回 + task_notification 延迟到达 + Task 工具 list/status/output/stop。
4. 子 lane 隔离：子会话文件独立存在、主会话 transcript 无子条目、子 agent 工具调用落子 lane。
5. 嵌套禁止：子 lane 内 Agent 工具返回错误。
6. WebFetch：本地 node http server 起 mock 页 → 抓取返回文本；非法 url/超时/超限错误。
7. TodoWrite：更新回显、替换语义。
8. OCR：真实引擎冒烟（zz-smoke/ocr-smoke.mjs：图片内联 + PDF CLI + 缓存命中）；schema 断言。
9. 取消：主 cancel 中断前台子循环。
10. 全量回归：kernel-engine / kernel-contract / kernel-bridge 保持通过。

## 7. 涉及文件

| 文件 | 动作 | 职责 |
|---|---|---|
| `kernel/agents.mjs` | 新增 | 内置表 + .md 解析 + 扫描 + resolve |
| `kernel/prompt.mjs` | 改 | agents 区块组装 |
| `kernel/tools.mjs` | 改 | Agent/Task/TodoWrite/WebFetch/OCR 工具 + subagent 上下文过滤 |
| `kernel/engine.mjs` | 改 | spawnSubAgent + 子循环 + 后台任务管理 + task_* 事件 |
| `kernel/protocol.mjs` | 改 | task_* 事件构造器 |
| `server/subagent.test.mjs` | 新增 | subagent 体系测试 |
| `server/tools-ext.test.mjs` | 新增 | 新工具测试 |
| `src/components/chat/ChatWindow.tsx` | 改 | 集成 SubAgentPanel |

## 8. 非目标（本轮）

- Browser 工具 / WebSearch（roadmap，protocol 已留位）
- 子 lane 压缩、嵌套 subagent、后台任务持久化（进程退出即失）
- Excel/PDF 原生解析（场景 A 大文件由技能层承载，内核保持文本工具）
- NotebookEdit
