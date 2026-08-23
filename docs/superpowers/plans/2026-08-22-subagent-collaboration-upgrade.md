# Subagent 协同升级方案（平行 → 可承接/可协同）

> 目的：把当前"扁平星型、一次性执行"的 subagent 体系升级为**有血缘、可继续、可承接**的协作体系——子 agent 之间能接力推进任务（流水线式协同），而不只限于主 agent 手动中转。机制对照参考 deepseek-harness 的 subagent 子系统（`vendors/deepseek-src/.../docs/subsystems/subagent.zh.md`：可继续子 agent / Activation 驻留 / 所有权图 / 冷恢复）。
> 权威来源：`kernel/engine.mjs`（spawnSubAgent/runSubAgentLoop/taskSystem）、`kernel/tools.mjs`（Agent/Task 工具）、`kernel/session.mjs`（createSessionStore，子 lane 复用基础）、`docs/superpowers/specs/2026-08-20-subagent-tool-system-design.md`（现状 spec，§8 非目标含"嵌套 subagent、后台任务持久化"——本方案**部分推翻**，需同步更新该 spec）。
> 更新日期：2026-08-22

---

## 1. 现状与差距（源码实证）

### 1.1 当前能力（均已实现）

| 能力 | 位置 | 说明 |
|---|---|---|
| 前台/后台派发 | `engine.mjs:468` spawnSubAgent | `run_in_background` 控制；后台经 `pendingSubAgents` Map 登记 |
| 子 lane 独立 store | `engine.mjs:491` | `createSessionStore(sessionId=taskId)` → 独立 transcript 文件，主会话零污染 |
| 子 agent 并行 | `engine.mjs:507` | 多个后台子 agent 同时运行（各自独立 signal/store） |
| 任务管理 | `engine.mjs:600` taskSystem | Task 工具 list/status/output/stop（stop 只中止单个子任务） |
| 事件 | `protocol.mjs` | task_started / task_progress / task_notification |
| 工具面 | `tools.mjs:626` Agent | 子 lane ctx 注入 `{ lane: true, store }` → **嵌套分发硬禁止**（tools.mjs:632）；Task 工具同样不可用（tools.mjs:643） |

### 1.2 能力边界（本方案要突破的）

1. **无血缘**：子 agent 不知道自己的 parent/兄弟；Task list 是扁平列表，无层级。
2. **不可继续**：子任务执行完即回收（`exec()` 结束，仅 pendingSubAgents 保留结果快照）；**不可 resume**——即使 laneStore 的 transcript 已落盘（`createSessionStore` 本就落盘、`load()` 可恢复），也没有"基于上次会话继续"的入口。
3. **无承接**：子 A 结果只能经主 agent 中转给子 B（主 agent 当邮差）；无"子 B 直接续跑子 A"或"子 B 读取子 A 会话"的机制。
4. **无协同状态**：子 agent 之间无共享上下文（todo 清单因共用 registry 意外共享，见 §3.4，未显式设计）。
5. **进程退出即失**：后台任务不跨进程持久化（spec §8 明确非目标，本方案保持）。

### 1.3 与 deepseek-harness 的差距（目标形态）

| 能力 | Ponos 现状 | deepseek-harness | 本方案 |
|---|---|---|---|
| 拓扑 | 扁平星型（主→从，1 层） | 血缘树（多代） | **血缘树（受控深度）** |
| 子 agent 生命周期 | 一次性执行 | 可继续子 agent（Activation 驻留、多轮 FIFO） | **可继续（resume）** |
| 后代管理 | 无 | 所有权图 + 父级鉴权 + 子级优先释放 | **血缘图 + 级联取消** |
| 承接 | 主 agent 手动中转 | 子 agent 间经会话/结果传递 | **结果承接（artifact 传递）** |
| 冷恢复 | 无 | 持久化会话重建 | 保持非目标（进程内） |

---

## 2. 升级目标（分档，可独立落地）

按成本/收益分三档，**每档独立可验收、可回滚**，避免一次大改：

| 档 | 主题 | 核心能力 | 成本 | 收益 |
|---|---|---|---|---|
| **S1** | 血缘登记 | parent/lineage/depth 记录 + 级联取消 + Task list 层级化 | 低 | 取消语义正确、任务可视 |
| **S2** | 可继续子 agent | `Task resume` 命令 + lane store 状态机 + task_resumed 事件 | 中 | **承接的基础**——子任务可断点续跑 |
| **S3** | 结果承接 | Agent 输入 `resume_task_id` + task_notification 增强 outputs | 中 | 流水线接力（A 产物 → B 基于 A 继续） |
| **S4** | 受控嵌套 | 子 lane 注入受限派发能力（深度上限 + 血缘校验） | 高 | 子 agent 自组织（树形分解） |
| **S5** | 协同状态 | todo/里程碑归属化 + GUI 任务树 | 中 | 可视化 + 协同清单 |

**推荐路径**：S1 → S2 → S3（形成"可承接"闭环，主 agent 可把任务链挂到子 agent 上），S4/S5 视需求再定（S4 是深度协同，S5 是体验层）。

---

## 3. 设计要点

### 3.1 S1 血缘登记（engine.mjs 改动最小）

**数据结构**（engine 内新增，随 engine 生命周期）：

```js
// lane 登记：taskId → 血缘信息
const laneTree = new Map() // taskId -> { parentTaskId: string|null, depth: number, lineage: string[] }
// 主 agent 派发的子任务 parentTaskId = null（depth 0）；子 agent 再派发 parent=该子任务
```

- `spawnSubAgent` 增加 ctx 透传：主循环 ctx `{ spawnSubAgent, taskSystem }` 已注入；子 lane 增加 `{ spawnSubAgent, taskSystem, lane: { taskId, depth } }`（S4 前 depth 恒 0，嵌套仍禁）。
- `taskStarted` 事件扩展 `parentTaskId`/`depth` 字段（GUI 可画树）。
- **级联取消**：`Task stop` 中止该任务时，递归中止其全部后代（深度优先，子级先释放——对齐 deepseek"子级优先释放"）。
- Task `list` 输出层级缩进（`depth` 前缀），便于模型理解任务树。

### 3.2 S2 可继续子 agent（承接核心）

**关键洞察**：子 lane 的 transcript 已独立落盘（`createSessionStore` 天然支持 `load()` + `deriveMessages()` 恢复），**resume 的持久化基础已存在**——缺的只是"状态机 + 入口"。

**状态机**（pendingSubAgents 条目扩展）：

```
running ──正常结束──▶ completed ──resume──▶ running（新轮次）
   │                    stopped
   └──失败──▶ failed ──resume──▶ running
```

- 条目不再在 `exec()` 结束时清除，保留 `{ laneStore, lineage, status, summary, outputFile }`，供 resume 复用（内存驻留，进程退出即失——保持非目标不变）。
- **`Task resume` 命令**：`{ command: 'resume', task_id }` → 重建子循环 `runSubAgentLoop({ store: laneStore, ... })`（`deriveMessages()` 已含历史 + 追加新 user 消息）。
  - 续跑语义：resume 时**不重放原 prompt**，追加一条 `user` 消息 `'（任务继续）'` 或由调用方带 `prompt`（`Task resume` 支持可选 `prompt` 参数 = 续跑指令）。
- **新事件** `task_resumed`（`wire.system` 构造器，shape 对齐 task_started）。
- **并发约束**：同一 taskId 同时只有一个活跃循环（resume 前 status 必须是 completed/stopped/failed；running 时 resume 返回错误）。

### 3.3 S3 结果承接（流水线接力）

**两种承接形态**：

1. **显式续跑（taskId 传递）**：Agent 工具输入新增可选 `resume_task_id: string`——派发新子任务前先 resume 既有子任务（等价"子 B = 子 A 的续篇"）。
   ```js
   // Agent.run 增加分支：resume_task_id 存在 → 对该 lane 执行续跑（忽略 subagent_type 或校验一致）
   ```
2. **产物传递（共享工作区 + outputs 清单）**：子 agent 本就共享同一 addDirs 工作区（`createSessionStore({ cwd: addDirs[0] })`），产物天然可达。缺的是"告知"：
   - `task_notification` 增加 `outputs: string[]`（子 agent 会话内全部 Write 的文件路径——`onTool` 已跟踪 lastWritePath，扩展为收集全部）。
   - 主 agent 中转时把 `outputs` 传给下家子 agent 的 prompt（"子 A 的产物在 X，请基于它继续"）——这是**经主中转的显式承接**，不引入子 agent 直接通信（保持低复杂度）。

**不做**（S3 边界）：子 agent 间直接消息总线/共享 session store 读取——复杂度高、收益低，保持"共享工作区 + 主 agent 编排"。

### 3.4 S4 受控嵌套（深度协同，可选）

- 子 lane ctx 改为注入完整派发能力：`{ spawnSubAgent, taskSystem, lane: { taskId, depth } }`。
- 约束：
  - 深度上限 `MAX_SUBAGENT_DEPTH = 3`（tools.mjs Agent.run 检查 `ctx.lane?.depth >= MAX` 时拒绝）。
  - 血缘校验：后代只能由祖先派发（`laneTree` 校验 parent 合法，防伪造）。
  - 级联取消已由 S1 覆盖。
- **提示词联动**：`prompt.mjs` 的【可用子 Agent】区块在子 lane 中同样注入（子 agent 知道可再派发），但注明"仅复杂任务可再分解"。
- **风险**：嵌套放大 token 成本与失控面——需要深度上限 + 单子任务工具迭代上限（`MAX_TOOL_ITERATIONS` 对子 lane 复用 50 已够，不额外放开）。

### 3.5 S5 协同状态与可视化（体验层，可选）

- **todo 归属化**：现状 `createToolRegistry` 的 `todoItems` 是 registry 级（子 lane 共用同一 registry → **todo 实际已跨 lane 共享**，属意外行为）。升级为显式设计：todo 条目带 `owner`（taskId，null=主），Task list 可看子 agent 的 todo；或保持共享（作为"协同清单"）并在文档写明语义。
- **GUI 任务树**：`RunningAgentsBar`/`SubAgentPanel` 按 `parentTaskId` 渲染树形；task_resumed 事件驱动"继续"徽标。

### 3.6 边界保持（不随本方案扩大）

- 零运行时依赖、单进程隔离契约（spec §3.7）不变。
- 子 lane 仍不压缩、不做溢出恢复/健康（会话短，S2 resume 后可复用历史，暂不引入）。
- 后台任务**不跨进程持久化**（进程退出即失）——resume 仅在进程存活期内有效；跨进程冷恢复仍是非目标。
- transcript 权威源不变：resume 的对话历史 = 子 lane transcript 派生，不额外维护状态数组。

---

## 4. 涉及文件

| 文件 | 动作 | 职责 |
|---|---|---|
| `kernel/engine.mjs` | 改 | laneTree 血缘登记；pendingSubAgents 状态机扩展（resume 支持）；spawnSubAgent 透传 lane ctx；级联取消；task_resumed 事件 |
| `kernel/tools.mjs` | 改 | Agent 输入 schema 增加 `resume_task_id`；Task schema 增加 `resume` 命令；嵌套深度检查（S4） |
| `kernel/protocol.mjs` | 改 | `task_resumed` 构造器；taskStarted 增 parentTaskId/depth；taskNotification 增 outputs |
| `kernel/prompt.mjs` | 改 | （S4）子 lane 注入 agents 区块；Task 工具描述更新（resume 语义） |
| `server/subagent.test.mjs` | 改 | 血缘/级联取消/resume/承接测试 |
| `server/tools-schema.test.mjs` | 改 | Agent/Task schema 断言更新 |
| `zz-smoke/subagent-smoke.mjs` | 改 | resume 冒烟链路 |
| `docs/superpowers/specs/2026-08-20-subagent-tool-system-design.md` | 改 | §8 非目标更新（嵌套/resume 从"不做"改为"受控支持"） |
| `docs/manual/Ponos产品使用说明书.md` | 改 | 子 agent 协作能力描述 |

---

## 5. 测试计划（server/*.test.mjs，mock API）

1. **S1 血缘**：派发 2 层（S4 后）/同级多任务 → laneTree 记录 parent/depth 正确；Task list 层级缩进；**级联取消**——stop 父任务 → 子任务信号中止（子优先）。
2. **S2 resume**：mock 流——前台子任务完成 → `Task resume` → task_resumed 事件 → 新轮次基于原 laneStore 续跑（deriveMessages 含历史）；running 中 resume 报错；stopped/failed 可 resume。
3. **S3 承接**：子 agent Write 2 个文件 → task_notification.outputs 含 2 路径；`resume_task_id` 派发续跑成功。
4. **S4 嵌套**：深度 3 内可嵌套；达上限拒绝并报错；血缘校验拒绝伪造 parent。
5. **回归**：既有 subagent 测试（前台/后台/隔离/嵌套禁止）保持通过；kernel-engine/kernel-contract 全量绿。

## 6. 验收标准（量化）

- S1-S3 落地后：`server/subagent.test.mjs` 新增用例 ≥10 条，全量单测 ≥330 且全绿。
- **端到端场景**（mock API 冒烟）：A 调研 → B 基于 A 产物续写 → C 汇总，全链路 3 个子任务完成且任务树正确（2 层）、产物清单可见。
- 评测回归：`benchmark/run.mjs --agents ponos --tasks T001,T002` 无退化（subagent 不参与评测任务，仅确认不回归）。
- 取消语义：stop 后台子任务及其后代全部中止，主循环不受影响（既有断言保持）。

## 7. 执行顺序与依赖

```
S1（血缘+级联取消）──▶ S2（resume 状态机）──▶ S3（承接传递）──▶ S4（受控嵌套）──▶ S5（GUI/协同状态）
        │                     │                     │                  │
        └── 每档完成后跑全量单测 + subagent 冒烟，绿了再进下一档
```

- S1 独立可落地（低风险，先做）。
- S2 依赖 S1 的血缘字段（resume 需知道 lineage 与 parent）。
- S3 依赖 S2（resume_task_id 本质是"创建时即 resume"）。
- S4 依赖 S1（级联取消必须先于嵌套，否则取消语义残缺）。
- S5 依赖 S1-S3 的事件扩展（parentTaskId/outputs 渲染需要）。

## 8. 风险与取舍

| 风险 | 缓解 |
|---|---|
| resume 后子 lane 会话变长（多次续跑累积） | 子 lane 引入轻量压缩（复用 compact.mjs，阈值可调）——S2 后续迭代项，不阻塞首版 |
| 嵌套导致工具迭代/成本失控 | 深度上限 3 + 复用 MAX_TOOL_ITERATIONS + 级联取消 |
| pendingSubAgents 内存驻留（completed 任务不回收） | 数量上限（如 50）+ 进程退出即失（既有边界）；GUI 层可加"清除已完成" |
| resume 语义与"重放副作用"冲突（工具重执行） | resume 只追加新 user 消息，历史 tool_use/result 不重放（deriveMessages 原样派生），无副作用重放 |
| spec §8 非目标被推翻 | 同步更新 spec，注明"08-22 升级方案部分推翻（嵌套/resume 受控支持）" |
