# 多 Agent 协同任务处理 — 设计文档

日期：2026-08-13
状态：已确认（用户逐节批准）

## 1. 背景与目标

当前 agent 运行基本都依托主 agent（Ponos）处理，用户很少指定其他内置/专业 agent 执行任务；主 agent 分发 subagent（多为 subagent-driven-development 技能触发）时，也不会调用系统中已注册的专业 agent 处理特定优势任务。

目标：让主 agent 能够**原生启动多 agent 协同任务处理**——识别系统中所有已注册 agent，按各自优势场景并发分发任务；前端聊天界面**二级显示多个子 agent 输出行**，实时跟踪每个子 agent 运行进度。

### 明确的产品语义（用户逐项确认）

- **触发方式（混合）**：模型自动分发为主 + 用户自然语言手动指定 + 技能可触发。不新增手动调度 UI
- **输出深度（进度 + 工具活动流）**：每个子 agent 一行，展示名称、状态徽章、tokens/工具数/耗时/当前工具，展开可见实时工具活动流与最终摘要；不做完整文字输出
- **路由精度（新增"优势场景"字段）**：agent 编辑表单新增"优势场景/适用任务"字段（映射内核 `whenToUse`），专业 agent 预填高质量文案；自定义 agent 留空时回退用 description
- **覆盖所有 agent**：包括用户后续手动添加的自定义 agent，全部能被主 agent 识别调用

### 可行性结论（内核调查）

内核原生已具备全部所需能力，**无需修改内核、无需重编译 bundle**：

1. **多 agent 并行分发**：主 agent 通过 Agent 工具在单条消息里并发发起多个子 agent 调用（`run_in_background: true` 可后台运行），每个成为独立 `local_agent` 任务并行执行（`ponos-kernel/claude-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx:466`）
2. **agent 识别**：内核从 `$PONOS_HOME/agents/*.md`（用户级）加载自定义 agent；Agent 工具描述列出每个 agent 的 `type + whenToUse + tools`，模型按名称精确选择（`tools/AgentTool/prompt.ts:43-46`）
3. **进度事件链路已通**：GUI 以 `--print --output-format stream-json --verbose` spawn 内核（`server/bridge.mjs:599`），内核在 stream-json+verbose 模式向 stdout 输出 SDK 事件 `system/task_started` / `system/task_progress` / `system/task_notification`（`cli/print.ts:884-886`），bridge 已原样转发为 `event` 消息——前端目前**忽略**这些事件，新增处理即可

## 2. 方案选型

**采用方案 A：纯前端 + agent 注入（内核零改动）**（用户确认）。

- 备选 B（内核增强透传子 agent 文字增量）：需重编译 21MB release bundle，与"进度+工具活动流"的需求不符，暂不做
- 备选 C（GUI 多进程编排）：重、慢、上下文不共享，放弃

### 注入路径选型：`.md` 文件而非 `--agents` JSON

- `--agents <json>` 经 `spawn(..., { shell: true })` 走 cmd.exe，受 **8191 字符命令行限制**，专业 agent 的 systemPrompt 有超限风险
- `$PONOS_HOME/agents/<id>.md` 是内核标准用户级 agents 目录（CLAUDE_CONFIG_DIR 已指向 PONOS_HOME，`utils/markdownConfigLoader.ts:303`），无长度限制、可手写、随会话进程加载
- 采用 `.md` 文件方案

## 3. 架构与数据流

```
agentStore（启用的 professional + custom agent）
  │  变更后 renderer 调 IPC agents:sync（写/删 .md）
  ▼
$PONOS_HOME/agents/<id>.md   ← 内核用户级 agents 目录，CLI 进程启动时自动加载
  │  → Agent 工具描述列出全部 agent（type + whenToUse + tools）
  ▼
主 agent 并发调用 Agent 工具 → 内核并行跑多个 local_agent 任务
  │  → 输出 system/task_started / task_progress / task_notification（stream-json+verbose）
  ▼
bridge 原样转发 event → usePonosCLI 新增分支 → chatStore.subAgentTasks → 二级面板渲染
```

## 4. Agent 注册表注入

### 4.1 `.md` 文件格式（内核标准）

```md
---
name: material-writer
description: 擅长撰写申报材料正文，当用户需要生成材料文案时优先使用
tools: Read, Write, Edit, Bash
model: deepseek-v4-flash
---
<system prompt body>
```

内核解析：frontmatter `description` → `whenToUse`（路由依据）、`name` → `agentType`、`tools` / `model` / 正文 `prompt`。

### 4.2 注入范围

- **只注入 type 为 professional / custom 的已启用 agent**
- builtin（Explore / general-purpose / Plan / statusline-setup）内核原生已有，注入会重复；`ponos` 是主身份，不作为子 agent 注入
- 用户后续手动添加的自定义 agent 走同一同步路径，自动被识别

### 4.3 同步机制

- **触发点（唯一）**：agentStore 的每个变更 action（addAgent / updateAgent / deleteAgent / toggleAgent / resetAgent / resetAllAgents / setAgentAvatar 无关，不触发）内部统一调用同步 helper，经 `window.ponosAPI.agentsSync()` 调 IPC `agents:sync`——不依赖 UI 层逐处触发，保证任何入口改动都同步
- electron main 写入或删除 `$PONOS_HOME/agents/<id>.md`
- **只删除 GUI 已知 id 的文件**，不触碰用户手写的、GUI 未管理的 `.md`（避免清掉用户的私有 agent）
- 同步失败静默降级，不影响现有会话

### 4.4 `whenToUse` 字段

- `Agent` 接口新增 `whenToUse?: string`（"优势场景/适用任务"）
- 编辑表单新增对应输入框；6 个专业 agent（material-writer / table-expert / audit-verifier / packaging-engineer / info-collector / experience-keeper）预填高质量路由文案
- 自定义 agent 留空时，同步时回退用 `description`（表单已强制要求 description 非空）

### 4.5 生效时机

每会话独立 CLI 进程，spawn 时加载（与 systemPrompt 时机一致）。编辑 agent 后新会话生效；已存在的会话进程不受影响。

## 5. 前端二级子 agent 面板

### 5.1 事件处理（usePonosCLI.ts 新增分支）

在 `msg.type === 'event'` 处理中新增三个 `system` 子类型：

| 事件 | 动作 |
|---|---|
| `task_started` | 按 task_id 创建 SubAgentTask（status: running，记录 name/prompt/description） |
| `task_progress` | 按 task_id 更新 toolUseCount / tokenCount / durationMs / lastToolName；追加活动行 `{toolName, description, ts}` |
| `task_notification` | 按 task_id 置终态 completed/failed/stopped，记录 summary / outputFile / usage |

### 5.2 数据模型（chatStore 新增切片）

```ts
interface SubAgentTask {
  taskId: string
  name: string        // agentType（如 material-writer）
  status: 'running' | 'completed' | 'failed' | 'stopped'
  prompt?: string
  toolUseCount: number
  tokenCount: number
  durationMs: number
  lastToolName?: string
  activities: { toolName: string; description: string; ts: number }[]
  summary?: string
  outputFile?: string
  error?: string
}

// chatStore 新增（独立切片，不污染消息持久化）
subAgentTasks: Record<conversationId, SubAgentTask[]>
// actions: upsertSubAgentTask(conversationId, task), clearSubAgentTasks(conversationId)
```

### 5.3 UI 组件（新组件 SubAgentPanel）

渲染在消息流中、最后一条 assistant 消息下方（按 conversationId 从 store 读取）。每个子 agent 一行可展开：

- **行头**：AgentAvatar（若有对应 agent）+ 名称 + 状态徽章（运行中/完成/失败/停止）+ tokens / 工具数 / 耗时 + 当前工具名
- **展开区**：
  - 工具活动流实时滚动（如"正在读取 xx.xlsx"）
  - 最终摘要（task_notification 的 summary）
  - 结果文件路径可点击预览（复用现有文件预览机制）

### 5.4 生命周期

- 会话进程退出（`closed` 事件）→ 清空该会话 subAgentTasks
- 后台子 agent（run_in_background）：任务结束事件晚于 leader 的 `result`，面板独立持续更新，不依赖 leader 消息

## 6. 边界与错误处理

| 场景 | 处理 |
|---|---|
| cmd.exe 8191 字符限制 | `.md` 文件注入规避 |
| 事件乱序/重复 | 按 task_id upsert |
| 任务终态重复通知 | 幂等，仅首次置终态 |
| `.md` 写入失败 | 静默降级，不影响现有会话 |
| 未知 agentType 的 task_started | 名称回退显示 task_id 短码 |
| 会话退出 | 清空该会话 subAgentTasks |

## 7. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/lib/agents.ts` | `Agent` 接口 + `whenToUse` 字段；专业 agent 预填优势场景文案 |
| `src/components/agents/AgentsPanel.tsx` | 编辑表单新增"优势场景"输入框 |
| `src/stores/agentStore.ts` | 各变更 action 内统一调用同步 helper（经 `ponosAPI.agentsSync`） |
| `electron/main.cjs` | 新增 IPC `agents:sync` 处理器：写/删 `$PONOS_HOME/agents/<id>.md` |
| `src/hooks/usePonosCLI.ts` | 新增 task_started/progress/notification 事件分支 |
| `src/stores/chatStore.ts` | 新增 `subAgentTasks` 切片 + upsert/clear actions |
| `src/components/chat/SubAgentPanel.tsx` | 新建二级面板组件 |

## 8. 测试与验收

- [ ] 编辑 agent 后新建会话，主 agent 能通过 Agent 工具调用该 agent（对话中可见 type+whenToUse+tools）
- [ ] 手动添加自定义 agent 后，主 agent 能识别并调用
- [ ] 主 agent 并行分发多个子 agent 时，前端显示多行二级面板，进度（tokens/工具数/当前工具）实时更新
- [ ] 工具活动流随 task_progress 滚动，展开可见
- [ ] 子 agent 完成/失败/停止时状态徽章正确切换，摘要与结果文件路径展示
- [ ] 禁用/删除 agent 后，主 agent 不再收到该 agent（对应 .md 已删除）
- [ ] 会话退出后子 agent 面板清空；无任务运行时无任何残留 UI
