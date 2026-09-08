# Agent Loop 生产级差距升级设计（Phase1+2 全范围）

> 状态：设计定稿待实现
> 日期：2026-09-08
> 基线：`docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`（差距精评报告，S5 完结 / S6 打包验收期）
> 实现路线：A（分区接线、薄→厚），用户批准
> 界面边界：kernel + server 接线层为界，GUI 只产出契约（bridge HTTP 端点 + wire 事件），不做 React 组件

---

## 1. 背景与动机

差距精评报告（2026-09-08）定位应用 agentloop（净室内核 `kernel/` + `server/bridge.mjs` 接线层）相对《生产级 Agent Loop 引擎构建操作指南》的横切缺口，并给出 Phase 1–3 升级路线。本 spec 落实 **Phase 1（5 项）+ Phase 2（3 项）**，按路线 A 组织：A 区 = 纯新增接线先行；B 区 = lane 参数化等结构改动后置。Phase 3（审计归档/导出、插件化工具、真依赖注入）不在本 spec 范围。

### 探索期对差距报告的修正（本 spec 依此落点）
1. `aggregateUsage` 定义于 `kernel/stats.mjs:20`（报告未列归属文件）；`costOf/withBudget` 于 `kernel/cost.mjs:4/12`；`buildAuditReport` 于 `kernel/audit.mjs:13`。三者均为**完成态纯函数**，头注释明确设计意图为 "bridge 读 transcript 文件后调用"——缺口只在接线，不在实现。
2. `verifySkillVersions` 定义于 `kernel/skills.mjs:109`（非 tools.mjs）。
3. health 侧 Judge 问题精确表述：`shouldRunJudge()`（health.mjs:115）**零调用者**，`createHealth`（health.mjs:51）**无 runJudge 注入位**，`failures` 恒 0。`engine.judgeUntil`（engine.mjs:1533）已被 cli `--until` 消费（cli.mjs:487），**不是死代码**——接线目标是让 health 复用该判定能力。
4. agent spec 字段 inert 确认：`parseAgentMarkdown`（agents.mjs:61）解析 `model/tools`（`skills` 注释提及未解析）；`spawnSubAgent`（engine.mjs:1367-1438）只用 `systemPrompt/name/description/id`，`agent.model/tools` 解析后即丢弃。

---

## 2. 范围与总体架构

### 2.1 范围定界
| 维度 | 定界 |
|---|---|
| 功能 | U1 usage/成本/审计端点；J1 health Judge 接线；AS1 agent spec 三字段 + SubAgent 路由补全；SV1 技能版本守卫；MS1 MemorySearch 工具（以上 Phase1）；P2-1 lane 参数化 + 可选压缩；P2-2 预算护栏；P2-3 值守能力契约（以上 Phase2） |
| 界面 | 仅契约：bridge HTTP 响应 schema + wire 事件字段扩展；GUI 组件由 GUI 侧另排 |
| 配置 | 一律 env 位 + 默认值（沿用 engine guards 的 env 惯例），不触及 settings 持久化层 |
| 非目标 | GUI UI 组件；Phase3 各项；子代理多进程化；lane 镜像循环激进重写（方案 C 明确不取） |

### 2.2 数据双权威源（横切约定）
- **冷数据（跨会话/历史审计）**：transcript JSONL。聚合方 = kernel 自身（读自家会话文件），经 kernel 只读子命令输出，bridge 仅 HTTP 薄转发——不做 bridge→kernel 模块 import，规避跨进程模块路径与版本耦合。
- **热数据（当前会话/进程内护栏）**：engine 每轮尾部 `turnStats`（engine.mjs:1634，`getTurnStats()` :1604）与 P2-2 新增的会话级累计。

### 2.3 进程与调用关系
```
GUI ──HTTP/WS──▶ server/bridge.mjs ──spawn(node kernel)──▶ kernel(cli.mjs)
                      │  /api/usage /api/audit                │ --usage / --audit / --agents
                      └──execSync/spawn 调内核只读子命令──▶    （stdout JSON，kernel 自读 transcript）
```
kernel 只读子命令复用 bridge 既有内核命令构造（server/bridge.mjs:585-601 区 `resolveKernelCommand` 样式）与 spawn 先例（bridge.mjs:854）。

### 2.4 改动布局
| 带 | Feature | 主落点 |
|---|---|---|
| A-接线 | U1 | kernel/cli.mjs（只读子命令）+ server/bridge.mjs（GET 分支）|
| A-接线 | J1 | kernel/health.mjs + kernel/engine.mjs（runTurn 尾部）+ kernel/cli.mjs（装配注入）|
| A-接线 | AS1 | kernel/agents.mjs + kernel/engine.mjs（lane 参数透传，与 P2-1 同一改造面）|
| A-接线 | SV1 | kernel/cli.mjs（启动校验）|
| A-接线 | MS1 | kernel/tools.mjs（注册）+ kernel/memory.mjs/graph.mjs（检索）|
| B-结构 | P2-1 | kernel/engine.mjs（runSubAgentLoop/runLaneExecution 签名扩展 + 可选 lane 压缩）|
| B-结构 | P2-2 | kernel/engine.mjs（会话累计 + 护栏）|
| B-结构 | P2-3 | 契约文档（本 spec 附录 C）+ env 位补齐核对 |

---

## 3. Feature 设计

### U1 — usage/成本/审计端点

**改动**
1. kernel/cli.mjs 新增三个只读子命令（parseArgs 后、进入 loop 前短路；stdout JSON 后 exit 0）：
   - `--usage [--scope session|project|all] [--sessionId X] [--project P] [--from YYYY-MM-DD] [--to YYYY-MM-DD]`
   - `--audit [--sessionId X] [--from] [--to]`
   - `--agents`（见 AS1）
2. 聚合实现位于 kernel（读自家 transcript → 调 `stats.aggregateUsage` / `audit.buildAuditReport`；成本由 `costOf` 逐模型汇总，`withBudget` 依据预算阈值给 overBudget 结论）。

**行为契约**
- usage 输出 schema（附录 A.1）；audit 输出 = `buildAuditReport` rows（tool_use / tool_result，含 seq/session/params 截断/结果前 200 字符）。
- 成本单价默认 0.2/1.2/0.1（in/out，cache_read 按 input×0.1，cache_creation 按全价 input），env 可覆盖（见 P2-2 同款单价 env）。

**server 接线**
- bridge.mjs if-chain（样板 bridge.mjs:1179+）加 `GET /api/usage`、`GET /api/audit`：解析 query → spawn/execSync 内核只读子命令 → 透传 JSON；子命令失败回 502 + 错误文本。

**验收**：两子命令冒烟（构造 fixture transcript 断言聚合与成本数值）；curl 两端点返回 schema 一致。

### J1 — health Judge 接线

**改动**
1. health.mjs：
   - `createHealth({ ..., runJudge })` 增加可选注入位 `runJudge`：`(snapshot) => Promise<{ done, reason }>`。
   - 新增 `recordFailure()`：`failures.count += 1` 并即时重估（档位变化即发 `wire.health`）。
   - `recordJudge({ done, reason })`：将判定结论暂存并入下次 `wire.health` 的可选 `judge` 字段。
   - `shouldRunJudge()` 保留为门（红档 + 冷却 300s）。
2. engine.mjs `runTurn`（:1605-1638）尾部，`health.record(...)` 之后：
   - 非 Abort 内部错误兜底分支（:1620-1631）调 `health.recordFailure()`。
   - `if (health?.shouldRunJudge?.()) { const j = await health.runJudge?.({...health.getState()}); if (j) health.recordJudge(j) }`；runJudge 异常静默吞掉（judge 不得影响主流程）。
3. cli.mjs 装配（:222 `createHealth`）注入 `runJudge` = 包装 `engine.judgeUntil`，判词固定为健康建议判定（目标文本：判定当前会话健康状态，是否建议重置/继续/压缩后继续），maxTokens 512。

**开关**：`PONOS_LLM_JUDGE=1` 或既有 `CLAUDE_CODE_LLM_JUDGE=1`（任一即开）。默认关 → 零行为变化。

**契约**：`wire.health` 增加可选字段 `judge: { done: boolean, reason: string }`（仅判定发生那轮带出；GUI 纯展示，不改既有字段）。

**验收**：单测 health 状态机（recordFailure→档位变化、shouldRunJudge 冷却、注入 runJudge 被调用）；engine 集成（mock runJudge，断言低频触发、异常静默、结果入 health 事件）。

### AS1 — agent spec 三字段生效 + SubAgent 路由补全

**改动**
1. agents.mjs `parseAgentMarkdown`（:61）：补 `skills` 字段解析（与 tools 同款逗号分隔 trim），返回对象增加 `skills: string[]`；解析契约保持容错（缺字段不拦）。
2. engine.mjs lane 参数透传（与 P2-1 共享同一签名扩展）：
   - `runLaneExecution` / `runSubAgentLoop` 增加 options `{ model, allowedTools, allowedSkills }`。
   - `spawnSubAgent`（:1367-1438）取 `agent.model / agent.tools / agent.skills` 透传。
   - `runSubAgentLoop` 内：模型选择用 `options.model || opts.model || getProvider().model`（现状 :1543 同款兜底）；工具表构造按 `allowedTools` 收窄（null/空 = 全量）；`allowedSkills` 过滤技能白名单（以 runSubAgentLoop 既有技能注入/执行点为基准，仅当子循环存在技能注入点时才同步收窄提示词技能清单）。
   - resume 分支（:1373-1392）沿用原 lane 已落定的参数（登记于 pendingSubAgents entry），不改语义。
3. SubAgent 路由补全：
   - 路由全集不变式：BUILTIN（agents.mjs:22）∪ `configDir/agents/*.md` 用户级（用户级同名覆盖内置）。**契约**：GUI 业务 registered agents 必须经 agents:sync 落入该目录方可被 Agent 工具路由；内核不内置业务 agent。
   - 新增 kernel `--agents` 只读子命令：输出可用 agent 表 `[{ id, name, description, model, tools, skills, source: builtin|user }]`，作注册路由一致性诊断与验收点。
   - agent.tools/skills 引用未知工具/技能 → `wire.warning({level:'agent_spec', ...})` 提示，不拦截。

**行为契约（零回归锁）**：agent 字段未定义 / 空数组 → lane 行为与现状完全一致（全量模型、全量工具、不过滤技能）。仅显式声明时收窄。

**验收**：subagent.test.mjs 扩展——白名单收窄（mock 工具执行仅白名单内被调）、model 生效（mock provider 记录收到 model）、skills 解析（frontmatter fixture）、未定义字段零回归（断言行为与基线一致）；`--agents` 冒烟。

### SV1 — 技能版本守卫

**改动**
- cli.mjs 启动、进入 loop 前：若 `<configDir>/skills.lock.json` 存在 → `verifySkillVersions({ lockPath, skills: <当前技能表 id/version> })`（skills.mjs:109，已支持顶层与嵌套两形态 lock）→ `outdated` 非空 → `wire.warning({ level:'skill_version', outdated })`（含 `id: lock→disk`），不阻断启动。
- 当前 lock 无写入者 → 文件不存在即零激活，天然零回归。

**验收**：纯函数 fixtures（两形态 lock、缺文件、匹配、过期各例）。

### MS1 — MemorySearch 工具

**改动**
1. tools.mjs `createToolRegistry`（:935）注册 `MemorySearch`：schema `{ query: string, topK?: number(1-10, 默认 5), scope?: 'personal'|'project'|'all'(默认 all) }`；registry ctx 增加 memoryRoot（沿用 configDir/cwd 注入路径）。
2. 检索实现：扫描 memoryRoot 下 `*.md` → 解析经验条目行（`- [会话|标签] 摘要 -- 全文`，memory.mjs 条目格式）→ 以 `graph.mjs` `gramTokens`（:25）/`vectorizeText`（:60）无模型相似度对 query 取 top-k → 输出条目 `[{ theme, tag, summary, full, file, score }]`。
3. 与 `graph.mjs` IGraphBackend 接口（graph.mjs:3-11）呼应：本实现 = local 直检；external 后端未来经同一工厂替换。

**行为契约**：工具输出 = 条目清单（含 `file` 供 Read 追全文）；无命中返回明确空提示；检索纯本地无网络。

**验收**：memory-search 测试（命中排序、scope 过滤、空结果）；注册后工具表冒烟。

### P2-1 — lane 参数化 + 可选压缩

**依赖序**：本项与 AS1 共享"签名扩展"这一步。实现顺序：① 参数骨架（options 三字段，未定义=全量）→ ② AS1 字段接线 → ③ lane 压缩开关。

**压缩设计**
- 开关 `PONOS_LANE_COMPACT=1`（默认关 → 既有 lane 行为零回归；resume 长任务显式开）。
- 开启后：lane 会话（含 resume 累积）达压缩阈值时对 laneStore 走 compact.mjs 两阶段压缩（复用主 loop 压缩语义）；压缩摘要事件带 `taskId`（wire 事件可辨 lane），并触发 health.recordCompaction 语义一致处理。
- 压缩阈值沿用主 loop 现有阈值体系，不另造；触发仅在 turn 边界。

**验收**：关闭态现有 subagent 测试全绿（回归锁）；开启态 mock 长会话触发压缩，断言 laneStore 出现 compacted 条目且主会话 transcript 不受影响。

### P2-2 — 预算护栏

**改动**
- engine 会话级热累计：runTurn 每轮 usage 累入 `sessionUsageAcc`（四字段：input/output/cache_read/cache_creation）→ 每轮尾部 `costOf(acc)`（单价 env 覆盖默认 0.2/1.2/0.1：`PONOS_PRICE_PER_M_INPUT`、`PONOS_PRICE_PER_M_OUTPUT`、`PONOS_CACHE_READ_RATIO`）→ 超过 `PONOS_BUDGET_USD`（>0 启用）→ `wire.warning({ level:'budget', usd, budgetUsd })`。
- **告警不硬停**：硬停决策交由调用方/GUI。进程重启护栏清零（热护栏）；跨会话/历史预算走 U1 文件聚合（冷护栏），两层互补。

**验收**：累计正确性、单价 env 覆盖、超阈值发事件（mock wire）、阈值未达不发。

### P2-3 — 值守能力契约

**交付**
1. 盘点既有值守能力并标注覆盖：KernelStallBar / LoopStatusBar（S5）、WS 15s ping/60s 判死走既有重连（S5）、workflow cron scheduler（workflow.mjs）、health 事件流 → 已覆盖项归入 G0 契约基线。
2. 参数核对：统一文档化 stall/值守 env 位（server 侧 `YFW_KERNEL_STALL_MS`/`YFW_KERNEL_IDLE_MS` 见 bridge.mjs:1916/1942）；仅补 kernel 侧缺失的对应 stall 判定 env（若核对发现缺口）。
3. 不产 GUI UI；契约 schema 汇入本 spec 附录。

**验收**：附录 C 核对表完成；发现的 env 缺口补齐并有冒烟。

---

## 4. 测试计划

沿用 `kernel-tests/*.test.mjs`（node:test）。新增：
- `usage.test.mjs`：stats/cost/audit 聚合纯函数（fixture transcript 断言数值）+ costOf 单价覆盖。
- `health-judge.test.mjs`：状态机（recordFailure/shouldRunJudge 冷却/recordJudge）+ engine 集成（mock judge）。
- `agent-spec.test.mjs`（或扩展 subagent.test.mjs）：白名单收窄、model 生效、skills 解析、未定义零回归。
- `skill-lock.test.mjs`：verifySkillVersions fixtures。
- `memory-search.test.mjs`：命中排序/scope/空。
- `budget-guard.test.mjs`：累计/单价/阈值事件。
- `lane-options.test.mjs`：参数透传不破坏既有 lane（关闭态回归锁）。
- `cli-subcommands.test.mjs`：--usage / --audit / --agents 输出 schema。

**回归门槛**：全量 kernel-tests 绿；两把零回归锁（lane 参数未定义=全量、lane 压缩默认关）显式断言。

**契约冒烟**：三只读子命令 + `curl /api/usage /api/audit`。

---

## 5. 建议推进顺序（供 writing-plans 细化）

1. P2-1① 参数骨架（签名扩展，零回归锁先行）
2. AS1（字段接线 + `--agents` + 测试）
3. U1（kernel 子命令 + bridge 端点 + schema + 测试）
4. J1（health 改动 + engine 接线 + 测试）
5. SV1（cli 启动校验 + 测试）
6. MS1（工具注册 + 检索 + 测试）
7. P2-1③ lane 压缩（开关 + 测试）
8. P2-2 预算护栏（累计 + 事件 + 测试）
9. P2-3 契约核对 + env 补齐

U1/J1/SV1/MS1/P2-2 互不依赖可并行；AS1 依赖 1；lane 压缩依赖 1。

---

## 6. 风险与回滚

- lane 参数化/压缩为唯一触碰既有运行路径的结构改动 → 用两把零回归锁 + 全量 kernel-tests 门槛对冲；实现以"最小签名扩展"起步。
- Judge/预算/守卫均为新增侧路：异常一律 try/catch 静默，绝不影响主流程（沿用 health.mjs 全模块静默降级风格）。
- U1 只读子命令不改变 loop 语义；bridge 端点失败只影响新查询面。
- 回滚：各 feature 均为独立新增，按提交粒度单点回退。

---

## 附录 A：契约 schema

### A.1 GET /api/usage（= kernel --usage stdout）
```jsonc
{
  "totals": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "turns": 0 },
  "byModel": { "<model>": { /* 同 totals 桶 */ } },
  "byProject": { "<project>": { /* 同 totals 桶 */ } },        // scope=all 时注入
  "byDate": { "<YYYY-MM-DD>": { /* 同 totals 桶 */ } },
  "bySession": { "<sessionId>": { /* 同 totals 桶 */ } },      // scope=session 或 bySession=true
  "byTool": { "<toolName>": 1 },
  "cacheRate": 0.0,
  "costUsd": 0.0,
  "byModelCostUsd": { "<model>": 0.0 },
  "budgetUsd": 0.0,          // PONOS_BUDGET_USD，0 = 未设
  "overBudget": false
}
```
### A.2 GET /api/audit（= kernel --audit stdout）
`[{ "ts": "...", "seq": 1, "session": "...", "type": "tool_use"|"tool_result", "tool": "Bash", "params": "<截断200>", "toolUseId": "...", "summary": "<结果前200>" }]`
### A.3 wire 事件扩展
- `wire.health` 增加可选 `judge: { done: boolean, reason: string }`
- `wire.warning` 新增 level：`'budget'`（附 `usd, budgetUsd`）、`'skill_version'`（附 `outdated`）、`'agent_spec'`（附 message）
### A.4 kernel --agents stdout
`[{ "id": "...", "name": "...", "description": "...", "model": "", "tools": [], "skills": [], "source": "builtin"|"user" }]`
### A.5 MemorySearch 工具
- 输入：`{ query: string, topK?: number(≤10), scope?: 'personal'|'project'|'all' }`
- 输出：条目 markdown 清单 `[{ theme, tag, summary, full, file, score }]`；无命中明确空提示

## 附录 B：现状锚点（file:line，探索期核实）

engine.mjs: runTurn 1605-1638 / 兜底 1620-1631 / turnStats push 1634 / getTurnStats 1604 / judgeUntil 1533 / spawnSubAgent 1367-1438 / runSubAgentLoop 1077 / runLaneExecution 1334 / makeLaneOnTool 1317 / model 兜底 1543。
agents.mjs: BUILTIN_AGENTS 22 / parseAgentMarkdown 61-87 / discoverUserAgents 90 / resolveAgents 108。
health.mjs: createHealth 51 / record 97 / recordCompaction 105 / shouldRunJudge 115 / getState 121 / computeHealthScore 19。
cli.mjs: createHealth 222 / createEngine 240 / judgeUntil 使用 487 / skipPermissions 61,81。
stats.mjs: aggregateUsage 20。cost.mjs: costOf 4 / withBudget 12。audit.mjs: buildAuditReport 13。
skills.mjs: verifySkillVersions 109。graph.mjs: gramTokens 25 / vectorizeText 60 / IGraphBackend 3-11。
tools.mjs: createToolRegistry 935。bridge.mjs: spawn 854 / if-chain 1179+ / /health 1304 / 内核命令构造 585-601 / YFW_KERNEL_IDLE_MS 1916 / YFW_KERNEL_STALL_MS 1942。
memory.mjs: 经验条目格式 `- [会话|标签] 摘要 -- 全文`（readMemoryEntries 供 graph.mjs:12 引用）。

## 附录 C：值守能力契约核对表（P2-3 交付物，实施期填结果）

| 能力 | 现状 | 覆盖 | 缺 env/动作 |
|---|---|---|---|
| 守卫自愈条 KernelStallBar/LoopStatusBar | S5 已交付 | G0 | — |
| WS 心跳 15s ping / 60s 判死走重连 | S5 已交付 | G0 | — |
| workflow cron scheduler | workflow.mjs | G0 | — |
| health 事件流（档位/压缩史） | health.mjs | G0 | — |
| kernel 侧 stall 判定 env | engine.mjs 守卫常量（PONOS_TURN_TIMEOUT_MS/STREAM_IDLE_MS/LOOP_*） | 已覆盖 G0 | — |
| 会话空闲回收 | bridge YFW_KERNEL_IDLE_MS / YFW_KERNEL_STALL_MS | 已覆盖 G0 | — |

> 实施期核对（2026-09-08，Task 10）：六项能力逐项确认存在——KernelStallBar/LoopStatusBar（S5）、WS 15s/60s 心跳（S5）、workflow cron scheduler、health 事件流、bridge 空闲回收 env、kernel 侧守卫 env 全部在列；未发现需新增 env 的缺口。

## 附录 D：关联文档
- 差距报告：`docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`
- 净室切换设计（S5）：`docs/superpowers/specs/2026-09-07-yfworking-ponos-kernel-switch-design.md`
