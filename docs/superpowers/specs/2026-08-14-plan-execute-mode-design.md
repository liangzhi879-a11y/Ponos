# Plan&Execute 执行模式协议化 + 内核 plan 模式清理 + 高风险命令审批 — 设计文档

日期：2026-08-14
状态：已定稿（用户确认：纯协议两态 + 源码删除 + 保留 MILESTONE-START + 扩展 destructiveCommandWarning.ts + 前端原生审批弹窗 + 工具本体与直接引用删除）
参考源码：deepseek-harness-master（2026-08-13 开源，MIT，Cordis 插件元框架）
前置：docs/superpowers/specs/2026-08-10-milestone-progress-design.md（里程碑展示层，已实现）

## 1. 背景与目标

结合 DeepSeek Harness（DSH）源码参考，对 Ponos 做**参考性优化**：将执行模式（react / plan&execute）**协议化**——以对话流标记 + 前端两态视觉表达模式，删除与协议冲突的内核 plan mode / accept mode 实现，并新增**高风险命令强制审批**（内核硬约束）。前端不做复杂交互——**活动条（摆动）= react，进度条（填充）= plan/todo**，两种视觉形态即模式表达。

### 1.1 DSH 参考结论（源码探查）

**模式 = preset = 插件组合，共享同一 ReAct 循环**

- `packages/core/agent-loop/src/agent.ts:64`：`ReactLoopAgent implements Agent` —— 所有模式共享默认循环
- 模式差异全部来自：tools 集 + prompt sections + capabilities + tool presentation（`agent.cordis.yml` 声明式组合，非独立循环实现）
- preset 选择：`agent-preset/selected` 事件 → durable session log，**会话级**模式选择

**plan-mode**（`packages/plan/plan-mode/src/index.ts`，477 行）

- 会话级 `plan/mode` 状态，激活时注入 `plan:policy` prompt section——**提示随模式状态注入**是 DSH 的核心机制
- `exit_plan_mode` 是唯一结束 planning 的最终 tool call，用户批准后退出

**todo**（`packages/todo/tool-todo/src/index.ts`）

- 状态机 pending / in_progress / completed；约束：**计划未完成时至少一个 in_progress**

### 1.2 Ponos 现状与差距

| 能力 | Ponos 现状 | 差距 |
|---|---|---|
| ReAct 循环 | ✅ 内核原生 query.ts queryLoop | — |
| Plan mode | ⚠️ 内核 EnterPlanModeTool → setMode:'plan' → ExitPlanModeV2Tool 用户批准 | **与协议化目标冲突且无实际用途（GUI 不渲染其 UI），删除** |
| accept mode | ⚠️ PermissionMode 'acceptEdits' 常量 | 无实际用途（Ponos 用 --dangerously-skip-permissions），**删除其入口，常量保留** |
| 里程碑展示 | ✅ MILESTONES/MILESTONE-OK 协议（bridge 解析剥离 → chatStore → Sidebar） | 无"当前正在执行哪个里程碑"信号 → 补 **MILESTONE-START** |
| 模式显式化 | ❌ 无显式状态 | 纯协议两态：有里程碑计划=进度条，无=活动条 |
| 高风险命令约束 | ❌ --dangerously-skip-permissions 全放行 | **补内核硬约束：命中高风险清单 → 强制 ask → 前端原生审批弹窗** |

### 1.3 关键约束

- **删除**内核 plan mode 实现（EnterPlanModeTool / ExitPlanModeV2Tool / planModeV2 / 相关审批组件），并**重建内核 bundle**（用户明确决策：源码删除，推翻"不改内核 bundle"的旧约束）
- 闭环在 **bridge layer** 实现，与提问卡片（`<!--ASK_USER-->`）/里程碑（`<!--MILESTONES-->`）机制同构
- 对话流剥离：模式切换与里程碑推进的标记不污染用户可见对话
- 权限模型：**常规命令无限制（automode 现状）**；**高风险命令（删除/移动/kill 进程等，有清单）必须请求批准后执行，内核硬约束**
- bridge 是 CLI 的 host/解析层，不强制驱动内核——模式推进依赖 agent 遵循系统提示协议（模型遵循非强制），bridge 负责感知与呈现

## 2. 方案选型

### 2.1 纯协议两态（前端视觉，用户确认）

不做三态 exec-mode 事件，不新增 execmode.mjs。模式由**数据**表达：

| 前端形态 | 触发条件 | 语义 |
|---|---|---|
| 活动条（摆动，现有 `conv-progress-flow`） | 无里程碑进度（MILESTONES 未声明） | react：自由 ReAct 执行 |
| 进度条（填充，现有 `conv-progress-fill`） | 有里程碑进度（MILESTONES 已声明） | plan/todo：有计划的执行 |

- 现有 Sidebar 渲染逻辑已天然实现两态映射（有 progress → 填充条，无 → 活动条），**不改**
- 删除旧设计中的 exec-mode 三态事件 / execmode.mjs / `mode` 字段（简化，减少 bridge 与前端状态面）

### 2.2 里程碑状态机（DSH todo 三态映射）

DSH todo 三态（pending/in_progress/completed）映射到 Ponos 里程碑（failed/skipped 不引入——无失败重试交互）：

```
planned ──(MILESTONE-START)──▶ in_progress ──(MILESTONE-OK)──▶ done
```

| 里程碑状态 | 含义 | 到达信号 |
|---|---|---|
| planned | 已声明未开始 | MILESTONES 声明 |
| in_progress | 当前正在执行（DSH 至少一个 in_progress） | **新增** `<!--MILESTONE-START i/N 名称-->` |
| done | 完成 | MILESTONE-OK（现有） |

- 进度计算：`current = max(done index)`；前端 `inProgress = 最近 START 的 index`（tooltip 使用，优先于 `current + 1` 推断）

### 2.3 执行阶段系统提示（DSH plan:policy 同构）

DSH 在 plan 激活时注入 `plan:policy`。Ponos bridge 在 spawn 时一次性注入 `PONOS_MILESTONE_PROTOCOL`（bridge.mjs L55-67，resume / 新会话均注入），无法会话中途动态切换——因此将 **MILESTONE-START 规则 + 执行阶段行为指导**追加进该协议段（启动即注入，模型任何时候遵循）：

```
- 开始执行某个里程碑时，先输出开始标记：<!--MILESTONE-START i/N 名称-->
- 实施阶段（已批准计划后）按里程碑逐项推进：输出 <!--MILESTONE-START i/N 名称--> 表示开始，
  完成后输出 <!--MILESTONE-OK i/N 名称-->；同一时刻只执行一个里程碑（至少一个处于进行中）。
```

### 2.4 内核清理（用户确认：工具本体 + 直接引用）

删除与协议冲突、无实际用途的内核实现：

**删除目录/文件：**
- `tools/EnterPlanModeTool/`（constants.ts / EnterPlanModeTool.ts / prompt.ts / UI.tsx）
- `tools/ExitPlanModeTool/`（constants.ts / ExitPlanModeV2Tool.ts / prompt.ts / UI.tsx）
- `utils/planModeV2.ts`（interview phase gate + pewter ledger 实验，无用）
- `components/permissions/ExitPlanModePermissionRequest/`
- `components/permissions/EnterPlanModePermissionRequest/`

**引用修复（约 20 处，见 §8 清单）：** 工具注册表 `tools.ts`、`constants/tools.ts`、`utils/messages.ts`（plan 阶段提示段 Phase 5）、`utils/api.ts`、`utils/plans.ts`、`utils/ultraplan/ccrSession.ts`、`utils/permissions/classifierDecision.ts`、`skills/bundled/batch.ts`、`tools/AskUserQuestionTool/prompt.ts`、`tools/AgentTool/`（agentToolUtils / exploreAgent / verificationAgent / planAgent）、`components/permissions/PermissionRequest.tsx`、`components/agents/ToolSelector.tsx`、`components/tasks/RemoteSessionDetailDialog.tsx`、`state/AppStateStore.ts`（AllowedPrompt type）、`schemas/hooks.ts`（注释）

**保留（不连锁）：** `PermissionMode` 类型 'plan'/'acceptEdits' 与 `PERMISSION_MODE_CONFIG` 条目（无副作用，避免连锁改动）；swarm/teammate 内部对权限模式的引用不动

**重建内核 bundle：** `bun scripts/build-bundle.ts`（Ponos 运行用 bundle，非 src）

### 2.5 高风险命令强制审批（用户确认：扩展 destructiveCommandWarning.ts + 前端原生审批弹窗）

**需求**：常规命令无限制（现状 automode）；删除/移动/kill 进程等高风险命令必须请求批准，**内核硬约束模型遵照执行**。

**清单（内核侧，扩展 `destructiveCommandWarning.ts`）：**
- 现有 `DESTRUCTIVE_PATTERNS`（git reset --hard / push --force / clean -f / checkout . / restore . / stash drop|clear / branch -D / --no-verify / --amend / rm -rf / DROP|TRUNCATE / DELETE FROM / kubectl delete / terraform destroy）
- 补充 Windows 命令：`del|rmdir|rd /s`、`move`、`taskkill|kill`、`format`、`reg delete`、`diskpart`、`takeown /f`、`icacls /grant` 等
- 补 `rm -f`（非递归单文件删除）与 `mv`（移动）

**强制 ask（复用 bypass-immune 机制，permissions.ts L1252-1260 先例）：**
- BashTool 权限检查命中高风险清单 → 返回 `{ behavior: 'ask', decisionReason: { type: 'safetyCheck', reason: 'ponos-highrisk' } }`
- `decisionReason.type === 'safetyCheck'` → 即使 `--dangerously-skip-permissions` 也强制 ask（bypass-immune）
- 内核挂起 tool_use（不执行），流中输出 assistant 消息含 tool_use（BashTool）

**审批链路（bridge + 前端原生弹窗）：**
```
内核强制 ask → 流输出 BashTool tool_use（挂起）
  → bridge 检测命中高风险清单的 BashTool tool_use → 转发 {type:'approval', toolUseId, command}
  → 前端原生审批弹窗（激活现存 PermissionDialog 死代码）展示命令
  → 用户批准/拒绝 → 前端回传 → bridge 向 stdin 注入恢复消息
  → 批准：内核执行命令；拒绝：tool_result is_error（toolExecution.ts L1030-1037 拒绝产物）
```

- 现有前端基础（已确认死代码可复用）：`src/components/permissions/PermissionDialog.tsx` + chatStore `addPermissionRequest` / `resolvePermission` / `pendingPermissions`（当前无调用点）
- bridge 侧需同源维护高风险清单副本（内核模块不可跨进程导入）——`server/highrisk.mjs` 导出与内核 destructiveCommandWarning 同构的模式数组，供 bridge 判断 BashTool tool_use 是否命中
- **未决（实施时实证）**：批准恢复消息的精确流格式——ask 挂起后内核接受哪种 stdin 输入（tool_result 块 vs 文本）；以真实链路跑一次高风险命令确认后固化

### 2.6 模式选择：agent 如何选择执行模式

模式选择发生在**单次任务内**（无 preset 概念）：

1. **agent 自主**：多步骤/多阶段任务 → agent 依协议先输出 `<!--MILESTONES-->` 声明（=plan 视觉）；简单任务不声明（=react 视觉）
2. **用户主导**：用户要求"先写方案再执行" → agent 声明里程碑并逐项推进；用户要求"直接做" → 无里程碑，活动条回退
3. bridge 只感知与呈现，**不替 agent 选择**模式

即：plan/todo 是 agent 与用户共同决策的结果；todo 语义 = 里程碑协议激活且 agent 处于实施阶段。

## 3. 协议

### 3.1 标记集（bridge 解析剥离，对话流无残留）

| 标记 | 事件（bridge → 前端） | 语义 |
|---|---|---|
| `<!--MILESTONES N 名1\|名2-->` | `milestones`（现有） | 计划声明 |
| `<!--MILESTONE-START i/N 名-->` | `milestone-start`（**新增**） | 里程碑 i 开始执行 |
| `<!--MILESTONE-OK i/N 名-->` | `milestone-ok`（现有） | 里程碑 i 完成 |

### 3.2 审批事件（bridge ↔ 前端）

| 事件 | 方向 | 载荷 |
|---|---|---|
| `{type:'approval', sessionId, data:{toolUseId, command, cwd}}` | bridge → 前端 | 高风险命令审批请求 |
| `{type:'approval-response', sessionId, data:{toolUseId, approved}}` | 前端 → bridge | 用户批准/拒绝 |

## 4. bridge 闭环设计（server/bridge.mjs）

### 4.1 里程碑（扩展现有 L727-793 消费处）

```
assistant 块遍历（text 块）：
  mk = extractMilestoneMarks(block.text)   // 现有
  mk.milestones → send milestones（现有）
  mk.starts    → send milestone-start（新增：for 循环转发）
  mk.oks       → send milestone-ok（现有）
```

### 4.2 审批（新增分支）

**前置条件（实证发现，2026-08-14）**：spawn 参数**必须追加 `--permission-prompt-tool stdio`**。否则非交互 print 模式下内核的 safetyCheck ask 决策会直接退化为 deny（`toolExecution.ts` L995 `behavior !== 'allow'` → is_error tool_result），没有任何批准途径。加了该参数后，ask 才会走 can_use_tool control_request/control_response 协议。

```
assistant 块遍历（tool_use 块，新增分支）：
  block.type === 'tool_use' && block.name === 'BashTool'：
    cmd = block.input?.command
    matchesHighRisk(cmd) → send {type:'approval', data:{toolUseId: block.id, command: cmd}}
                              （命中即转发；内核强制 ask 是否发生由内核判定，bridge 弹窗先于挂起——不阻塞普通命令）

WebSocket 消息（L1499 ws.on('message') 扩展）：
  msg.type === 'approval-response' → 向 session.proc.stdin 注入 control_response（格式见下）
```

**恢复消息格式（实证固化，spec §11.1 未决项已解）**——内核挂起信号在 stdout：

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool",
 "tool_name":"Bash","input":{"command":"rm -f ..."},"permission_suggestions":[],
 "decision_reason":"ponos-highrisk-command","tool_use_id":"<id>","agent_id":"<id>"}}
```

bridge 检测 `parsed.type==='control_request' && parsed.request?.subtype==='can_use_tool'` 即知内核挂起等待审批。解除挂起靠向 stdin 注入 control_response（`request_id` 必须回填，`toolUseID` 回填 `tool_use_id`）：

- 批准：`{"type":"control_response","response":{"request_id":"<uuid>","subtype":"success","response":{"behavior":"allow","updatedInput":{},"toolUseID":"<id>","decisionClassification":"user_temporary"}}}`
- 拒绝：`{"type":"control_response","response":{"request_id":"<uuid>","subtype":"success","response":{"behavior":"deny","message":"User denied the high-risk operation","toolUseID":"<id>"}}}`

批准后 Bash 正常执行（tool_result 非错误，`permission_denials` 为空）；拒绝后 tool_result 为 is_error，agent 收到 `message` 文本并可继续对话。两条路径均已实证通过（`scripts/verify-permission-flow.mjs allow|deny`，exit 0）。

- 复用现有 `send()`（L806，WebSocket 广播）与 `session.proc.stdin` 写入通道（L1507/L1540 先例）
- 命中清单即弹窗，普通命令不受影响；内核已强制 ask 时弹窗正好覆盖等待窗口

### 4.3 系统提示追加

`PONOS_MILESTONE_PROTOCOL`（L55-67）追加 §2.3 的 START 规则 + 执行阶段指导文本；注入点（resume L680 / 新会话 L693）不变。

## 5. 前端

### 5.1 状态（src/types/index.ts + src/stores/chatStore.ts）

`conversationProgress` 扩展：

```ts
{
  total: number
  names: string[]
  current: number
  inProgress?: number   // 新增：最近 MILESTONE-START 的 index
}
```

新增 action：`setMilestoneStart(id, index)`（钳制到 total）。其余不变。**无 mode 字段**（纯协议两态由数据驱动）。

### 5.2 事件（src/hooks/usePonosCLI.ts）

新增 `milestone-start` handler（照 milestone-ok 骨架）；`approval` handler → `addPermissionRequest`（激活现存 store action）。

### 5.3 审批弹窗（src/components/permissions/PermissionDialog.tsx）

- **激活现存死代码**：addPermissionRequest 调用点补上后，PermissionDialog 自动生效
- 展示命令 + 工作目录；批准/拒绝 → `resolvePermission(id, approved)` → 经 ws 发送 `approval-response`（需在 resolvePermission 实现处接 bridge 回传）
- 现有 PermissionDialog 文案（"Ponos wants to perform an action that requires your approval."）可复用，按需加命令展示

### 5.4 进度条 tooltip（src/components/layout/Sidebar.tsx）

- **形态**：不改（现有两态逻辑）
- **tooltip 增强**（有进度时）：`执行中 ${inProgress 优先的里程碑名} ${i}/${total}`；无 inProgress → `计划中`；无 total → `执行中`（与现状一致）

## 6. 持久化

- `conversationProgress`（含 inProgress）维持 **runtime-only**，会话删除或应用重启后不恢复（与前身 spec 一致：MILESTONES 标记已在对话流剥离，无法跨会话重建）

## 7. 边界处理

- 旧会话/无里程碑 → 活动条 + `执行中`，不崩溃
- START 乱序/超界 → 钳制到 total，不崩溃
- START 后无 OK（任务中断）→ inProgress 保持，会话结束即清理
- 畸形标记（total 非数字等）→ 忽略，不崩溃
- 删除会话 → clearConversationProgress 清理（含 inProgress）
- 审批弹窗超时/会话关闭 → 不注入恢复消息，内核保持挂起（会话清理时进程关闭）
- 普通 BashTool 命中清单但非挂起（理论上内核必 ask）→ 弹窗后批准注入恢复，仍正确

## 8. 影响范围

### 内核（ponos-kernel/claude-code/src/，需重建 bundle）

| 文件 | 改动 |
|---|---|
| `tools/EnterPlanModeTool/`、`tools/ExitPlanModeTool/`、`utils/planModeV2.ts` | **删除** |
| `components/permissions/ExitPlanModePermissionRequest/`、`EnterPlanModePermissionRequest/` | **删除** |
| `tools.ts` | 移除两个工具注册（L209/L221）与 import（L58/L85） |
| `constants/tools.ts` | 移除 import（L4-5）与引用 |
| `utils/messages.ts` | 移除 planModeV2 import（L85/L161）、ExitPlanModeV2Tool import（L112）、plan 阶段提示段（L3286-3290） |
| `utils/api.ts` | 移除 EXIT_PLAN_MODE_V2_TOOL_NAME 引用（L35） |
| `utils/plans.ts` | 移除引用（L14） |
| `utils/ultraplan/ccrSession.ts` | 移除 import（L12）与注释 |
| `utils/permissions/classifierDecision.ts` | 移除 import（L3-4） |
| `skills/bundled/batch.ts` | 移除 import（L3-4） |
| `tools/AskUserQuestionTool/prompt.ts` | 移除 import（L1） |
| `tools/AgentTool/agentToolUtils.ts`、`built-in/exploreAgent.ts`、`verificationAgent.ts`、`planAgent.ts` | 移除 import / 工具名引用 |
| `components/permissions/PermissionRequest.tsx` | 移除 Enter/Exit 两个 case（L63-65/L130-133）与 import（L4-5） |
| `components/agents/ToolSelector.tsx` | toolNames Set 移除 ExitPlanModeV2Tool（L53） |
| `components/tasks/RemoteSessionDetailDialog.tsx` | 移除 import（L16） |
| `state/AppStateStore.ts` | AllowedPrompt type 改为本地定义或移除（L20） |
| `schemas/hooks.ts` | 注释清理（L135） |
| `tools/BashTool/destructiveCommandWarning.ts` | **扩展** DESTRUCTIVE_PATTERNS（Windows 命令 + rm -f/mv） |
| BashTool 权限检查（canUseTool） | **新增**：命中清单 → `{behavior:'ask', decisionReason:{type:'safetyCheck'}}` |
| **保留** | PermissionMode 类型、PERMISSION_MODE_CONFIG、swarm/teammate 引用 |

### bridge 与 server

| 文件 | 改动 |
|---|---|
| `server/milestones.mjs` | extract 增补 START 解析与剥离 |
| `server/highrisk.mjs` | **新增**：高风险命令清单（与内核同构）+ `matchesHighRisk(cmd)` |
| `server/bridge.mjs` | 系统提示追加协议段（L55-67）+ tool_use 审批分支 + START 转发 + approval-response 注入（L1499 扩展） |

### 前端

| 文件 | 改动 |
|---|---|
| `src/types/index.ts` | ConversationProgress 加 inProgress |
| `src/stores/chatStore.ts` | setMilestoneStart + resolvePermission 接 bridge 回传 |
| `src/hooks/usePonosCLI.ts` | milestone-start / approval handler |
| `src/components/permissions/PermissionDialog.tsx` | 激活（命令展示细化，可选） |
| `src/components/layout/Sidebar.tsx` | tooltip 当前里程碑 + 计划中/执行中 |
| **不改** | 进度条渲染逻辑、globals.css、i18n、对话流内容 |

## 9. 测试

1. **milestones 单元**：含 START 的文本 → 解析剥离正确；乱序/超界/畸形不崩溃
2. **highrisk 单元**：Windows/git/rm 模式命中；普通命令不命中
3. **内核**：`bun scripts/build-bundle.ts` 构建通过；BashTool 权限检查命中清单返回 ask
4. **前端状态**：mock 事件流 → inProgress 推进 + 覆盖/钳制
5. **端到端**：真实任务走 多步骤计划（START 后 tooltip 显示当前里程碑）→ 全部 done；简单任务活动条；高风险命令触发弹窗 → 批准执行 / 拒绝回传 is_error
6. **回归**：`npx tsc --noEmit` + `npx vite build`；同步 release 副本（内核 bundle + milestones.mjs + highrisk.mjs + bridge.mjs + dist）并重启进程（需用户同意）

## 10. 实施计划

**Phase 1（协议与纯函数）**
- P1.1 milestones.mjs 增补 START 解析剥离（TDD）
- P1.2 highrisk.mjs 清单与匹配（TDD）
- P1.3 系统提示协议段追加（START 规则 + 执行阶段指导）

**Phase 2（内核清理）**
- P2.1 删除工具目录 / planModeV2 / 审批组件目录
- P2.2 修复约 20 处引用（§8 清单）
- P2.3 重建 bundle

**Phase 3（内核高风险审批）**
- P3.1 destructiveCommandWarning.ts 扩展 Windows 命令
- P3.2 BashTool 权限检查命中 → safetyCheck ask
- P3.3 重建 bundle + 实证恢复消息格式

**Phase 4（bridge + 前端）**
- P4.1 bridge tool_use 审批分支 + approval-response 注入
- P4.2 前端 inProgress + milestone-start/approval handler
- P4.3 审批弹窗激活 + tooltip 增强

**Phase 5（验证）**
- P5.1 单元验证脚本
- P5.2 端到端手工验证
- P5.3 回归 + release 同步（需用户同意重启）

## 11. 未决项（实施时确认）

1. **审批恢复消息格式**：~~内核强制 ask 挂起后，bridge 注入何种 stdin 消息可解除挂起（tool_result 块 vs 批准文本）——以真实链路跑一次高风险命令实证后固化~~ **已解决（2026-08-14 实证）**：需 `--permission-prompt-tool stdio`；恢复消息为 control_response（格式见 §4.2），两条路径实证通过
2. **planAgent.ts 处置**：内置 plan agent 引用 EXIT_PLAN_MODE_TOOL_NAME，删除工具后需改引用或废弃该 agent——实施时看其实际用途决定
3. **PermissionDialog 复用度**：现有组件展示结构是否满足命令展示需求，不满足则小幅改造
