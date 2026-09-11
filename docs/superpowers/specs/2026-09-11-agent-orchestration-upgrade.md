# Spec：系统化 Agent 驱动逻辑 + 子 Agent 协同升级（2026-09-11）

## 背景与输入

目标：① 参考 github/spec-kit 给内核系统化的 agent 驱动逻辑（spec 优先的状态文件驱动，替代
模型自由发挥）；② 参考 Claude Code / pi / Codex 的多 agent 机制升级子 agent 协同，提高任务
效率；③ superpowers 技能系列（本机已装全套）纳入参考，方法论内核化；④ 深度结合应用内置
能力（浏览器自动化/记忆/健康/压缩/审批）。

研究结论要点（源码实证，2026-09-11）：

| 来源 | 关键机制 |
|---|---|
| spec-kit | 纯提示词/模板驱动的 specify→plan→tasks→implement→**converge** 循环；P1/P2/P3 独立可测用户故事 + Given/When/Then 验收场景；checklist 质量门；扩展钩子。零运行时依赖 |
| superpowers | 每任务派**全新实现者子 agent** + 每任务后**审查者子 agent**（spec 符合性+质量）+ 分支收尾全量复审；连续执行不逐任务确认；并行派发按"独立问题域"划分 |
| Claude Code | 子 agent = 进程内同 query 循环 + 独立 sidechain transcript；sync/async 二分（run_in_background + 任务注册表 + `task_notification` 精确一次）；`SendMessage`→pendingMessages 队列延续/自动 resume；fork 实验（全量继承+提示缓存共享）；frontmatter 级 model/tools/effort/maxTurns 覆盖；coordinator 提示词阶段化（Research→Synthesis→Implement→Verify） |
| pi | 会话树 id/parentId + 分支摘要注入；子 agent 示例为外置进程（8 任务/4 并发 worker pool，50KB 输出截断）；无 agent 间通信（不抄） |
| Codex | 多 agent v2 工具面（spawn/send_message/followup_task/interrupt/list/wait 信箱式）；常驻子 agent + LRU 淘汰（4 并发上限）；fork_turns none/all/N；Goal 扩展（线程空闲自续 + 3 连败无进展 Blocked + 后代用量聚合）；Guardian 独立低思考档审查模型 + 熔断 |

## 设计原则

1. **状态文件驱动 > 模型自觉**：spec-kit 的价值在"模型被 spec/plan/tasks 状态文件 + 门禁驱动"。
   我们的 Workflow 引擎（DAG：tool/document/agent 节点、inputs、触发词）比 spec-kit 更进
   一层——门禁与步骤衔接由引擎**确定性执行**，弱模型（Qwen）尤其受益。
2. **方法论内核化 + 提示词保留**：superpowers 技能继续留在 skills 目录（提示词层），但关键
   流程（实现→审查→验证、并行扇出）由工作流 DAG/引擎节点确定性串接，模型不再"自觉"执行。
3. **渐进**：先提示词+配置驱动（Phase 1，零引擎风险），再引擎级强化（Phase 2），评估项
   （Phase 3）按实测需要决定，不预设。
4. **复用本会话已建能力**：持久自愈守卫族、分块摘要、窗口校准、白名单审批、会话记忆、
   健康监控——新机制与它们组合而非重叠。

## 方案

### A. 内核原生 spec 工作流（spec-kit 内核化）

新增内置工作流 `spec-dev`（workflow.yml，装进 <configDir>/workflows 或内置注册表）：

```
specify(agent) → [clarify(agent, 可选)] → checklist 门(tool 节点检查项全过)
  → plan(agent) → tasks(agent) → implement(agent×N, 逐任务) → converge(agent)
  → 未收敛回 implement（引擎判定循环，上限 3 轮）
```

- **状态文件**：项目内 `<project>/.yfw-spec/<slug>/{spec,plan,tasks}.md`，模板内置：
  spec（P1/P2/P3 用户故事 + 独立可测 + Given/When/Then 验收场景）、plan（bite-sized 步骤 +
  每步验证方式）、tasks（- [ ] 项，标注可并行性 + 验证步骤）、checklists（requirements 门）。
- **implement 节点 = superpowers subagent-driven-development 内核化**：引擎逐任务派
  **实现者子 agent**（全新 lane，隔离上下文，prompt = 任务文本 + 相关 spec 摘录）→ 每任务
  后派**审查者子 agent**（内置 `reviewer` agent 定义：只读工具 + spec 符合性 + 质量报告）→
  审查不过回实现者（同一 lane 续跑，上限 2 次）→ 全部任务后**收敛验证节点**。
- **converge**：agent 节点对 spec/plan/tasks 三方一致性 diff 检查（spec-kit 语义）→ 输出
  收敛报告；未收敛 → 引擎回 implement。
- **TodoWrite 对齐**：tasks 生成时同步建 TodoWrite 清单，实现进度双写。
- 触发：技能触发词（"按 spec 开发"/"spec-dev"）+ workflow 触发词。

### B. 子 agent 协同升级（三家取舍，按性价比）

**B1. Agent 工具加 `context` 继承档（CC fork_turns / Codex fork_turns）**
- `context: 'none'(默认,现状) | 'summary' | 'full'`
- summary 档：用 compact.mjs 对主会话 covered 区间做摘要（或取 lastSummary + 最近 N 轮），
  作为子 lane 前缀注入——子任务质量最大单点提升（当前子 agent 零主上下文，prompt 全靠手写）。
- full 档：继承主会话全量历史（长会话警告 + 建议 summary）。

**B2. Task 工具加 `send_message`/`followup` 子命令（CC SendMessage / Codex 消息面）**
- 运行中的后台 lane：投递消息进 lane 队列（工具边界吸收，镜像主循环 P8 pendingNext）；
- followup = 投递 + 唤醒空闲 lane（续跑）；
- 停止/驱逐的 lane：投递时自动 resume（复用既有 resume_task_id 语义）。

**B3. 子 agent 并发槽（Codex residency 语义简化版）**
- `PONOS_LANE_MAX_CONCURRENT`（默认 4）：超限的后台 Agent 派发排队（任务注册表 status=queued），
  槽位释放（任务终态）即启动——"一次派 N 个"单轮并行扇出（superpowers dispatching-parallel-
  agents 的引擎化）。

**B4. 内置 agent 定义补齐（CC builtInAgents 对齐）**
- `implementer`（全工具，禁嵌套 Agent）、`reviewer`（只读+报告）、`explorer`（只读研究）、
  `planner`（只读架构，禁写工具，产 plan）——agents.md frontmatter 注册，spec-dev 工作流
  直接引用；frontmatter 支持 effort/background 字段。

**B5. 通知精确一次审计（CC atomic notified flag）**
- 复核 task_notification 幂等（当前通知在任务终态时发一次；补"notified 原子标记"防
  重复投递）。

**不采纳（评估结论）**
- pi 外置进程子 agent：我们进程内 lane 已覆盖，外置只有隔离收益、无协作收益。
- Codex Goal 扩展：其"3 连败无进展 Blocked"与本会话熔断+停滞守卫重叠；"线程空闲自续"
  与既有 /loop --until 重叠。单独 goal 系统性价比低。
- Guardian 独立审查模型：本地单模型环境无第二模型可用；reviewer 子 agent 用同模型
  低思考档等效覆盖。

### C. 深度结合应用内置能力

- **浏览器**：spec-dev 的 verify 节点与 reviewer 可用 Browser 做 UI 验收（yfwweb 系列技能
  快照/填表/验证码采集），验收场景的 Given/When/Then 直接映射 Browser 操作序列；新域名
  走本会话已建的白名单审批流（agent 被拦截 → 用户批准 → 自动入白名单 → 重试）。
- **记忆**：review 节点产出的问题/决策经既有 memory 工具链写 personal memory；子任务
  摘要并入会话工作记忆（P9-3）——spec 流程跨轮续跑时记忆不丢。
- **健康/压缩**：implement/converge 的 agent 节点 = lane（复用 lane 压缩 PONOS_LANE_COMPACT
  与主上下文规划）；长 spec 流程的收敛循环用 health 信号观测（质量下降提前提示收敛）。
- **审批**：子 lane 高危命令继续过主会话审批门（既有 gateToolUse 注入），spec 流程不旁路
  权限；后台 lane 的审批挂起沿用 PONOS_APPROVAL_TIMEOUT_MS + 持久愈合。
- **持久自愈**：实现者/审查者 lane 全部继承守卫族（lane 侧已镜像停滞/熔断愈合）——子任务
  打转不会烧死 token，收敛循环有界。

## D. 上下文渐进式披露兜底（2026-09-11 补，针对 180K 本地模型压缩不动）

**问题形态**（日志实证）：窗口 180K、历史 563 条/608KB 时，压缩循环空转——retainHint
过大导致 covered 只有 1-2 条消息，摘要"落地但几乎不释放"，主请求反复 400，每 ~70s
重压一遍小摘要（本地模型慢 prefill 放大了循环成本）。

**三层兜底**（已实现，压缩自愈链的最后一环）：

1. **压缩空转熔断**：连续 3 次"落地但释放 < floor(5% 或 20K)"→ 跳过 forceCompact，
   直走裁剪/预算收窄/硬适配（`compaction state=stalled` 事件可观测）——终结 70s/次的
   空转循环。
2. **渐进式披露（索引化替代丢弃）**：硬适配裁掉更早历史时，**优先替换为一条
   `<history-index>` 消息**（每条一行：行号 + 角色 + 内容前 60 字符）——模型保留全局
   地图；索引化仍超窗才真丢弃。
3. **按需展开**：会话 transcript 文件（JSONL 权威源）加入 Read 只读白名单
   （精确文件匹配，不放宽目录）——索引带 transcript 路径与行号，模型需要历史细节时
   `Read offset/limit` 按行展开，不再"盲视野"。

**与系统性方案的关系**：spec-dev 工作流的每个 agent 节点 = lane（上下文小），主会话
长历史由压缩 + 渐进披露双层管理——spec/plan/tasks 状态文件本身就是"最强的披露层"
（模型读任务状态而非全量历史）。converge 循环与索引披露组合：收敛判定只需
spec/plan/tasks 三文件 + 最近轮次，天然适配小窗口本地模型。

## 实施分期

**Phase 0（已完成，2026-09-11）**：D 节渐进式披露三层兜底（空转熔断 + 索引化适配 +
transcript Read 白名单）——已实现、已测试（290 项全过）、已部署。

**Phase 1（提示词+配置驱动，内核小改动）**
1. `spec-dev` 内置工作流（workflow.yml + spec/plan/tasks/checklist 模板 + 门禁节点）
2. B4 内置 agent 定义（implementer/reviewer/explorer/planner）+ frontmatter effort/background
3. B1 Agent 工具 `context` 继承档（none/summary/full；summary 复用 compact.mjs）
4. B2 Task 工具 send_message/followup（lane 队列镜像 P8）
5. 技能侧：spec-dev 触发词接入 skills 索引；superpowers 技能提示词与工作流节点引用打通

**Phase 2（引擎级强化）**
6. B3 并发槽 + 排队（任务注册表 queued 状态 + 槽位释放启动）
7. B5 通知幂等审计
8. converge 循环的 health 信号集成

**Phase 3（评估项，实测再定）**
9. 常驻 lane LRU（Codex residency）——跨消息续跑成本实测后决定
10. Goal 型长任务自续——若 /loop 场景不够用再评估

## 验收标准

- spec-dev 端到端：一段模糊需求 → specify/plan/tasks 三文件 + 门禁全过 → implement 逐任务
  派实现者+审查者 → converge 收敛报告；全流程无模型自由发挥（每步由引擎节点串接）
- 单轮并行扇出：4 个独立任务一次派发，4 lane 并发、结果逐任务回主会话
- context:summary 子任务在长会话下的完成质量显著优于 none（人工抽测）
- 全流程回归：现有 288 项测试全过 + 新增工作流/lane 测试
