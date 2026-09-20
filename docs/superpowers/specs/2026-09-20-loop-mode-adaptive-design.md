# Loop 模式自适应 · 设计

> 状态：设计定稿（用户已确认全部决策点），待评审 → 转 plan
> 日期：2026-09-20
> 基线：`kernel/engine.mjs`(2436 行) / `kernel/loop.mjs` / `kernel/cli.mjs` / `kernel/agents.mjs` / `kernel/compact.mjs` / `kernel/health.mjs` / `server/bridge.mjs` / `src/components/chat/*`
> 前序：`docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`（指南第 13 章底稿 G7）、`docs/superpowers/specs/2026-09-17-loop-redesign-phase1-reliability-design.md`（loop 四期总纲）、`docs/superpowers/audits/2026-09-19-reviewer-cross-model.md`（评审模型对照实测）

---

## 0. 一句话

把"一个循环干所有事"改为"**可选的执行模式 + 轮边界切换 + 全程留痕**"，模式不是新理论而是既有构件的重新组合；**切换权在用户，LLM 只提建议**；阈值**先观测再定**。

---

## 1. 需求与已确认决策

用户提出的原始需求（三条）：

1. 任务开始时由 LLM 评估内容 → 选择进入不同 loop 模式（ReAct / Plan-and-Execute / Reflection），且**执行过程中可自主切换**以适配任务要求
2. 子 Agent 提供**人工开关**
3. 审查提供 **MAGI 模式**（三评审不同视角并行 → 集中评审；费用大但发现更多），并基于用户更多自定义选择

**已确认决策（7 项，全部经用户逐项拍板）**：

| # | 决策点 | 用户选择 | 对设计的约束 |
|---|---|---|---|
| D1 | 模式由谁选 | **LLM 前置评估 + 用户可覆盖** | 必须有"建议→用户确认"通道；用户显式指定优先级最高 |
| D2 | 切换程度 | **轮边界自动切 + 全程留痕** | 不打断进行中的一轮；每次切换落 wire 事件 + transcript meta |
| D3 | MAGI 触发 | **显式开启 + 高风险自动建议** | 默认单 reviewer；命中高风险特征只**建议**不自动跑 |
| D4 | 落地路径 | **B1 纯重构 → B2 加模式** | B1 零行为变更且独立可交付；B2 才引入模式 |
| D5 | 模式表达力 | **允许改控制流** | 必须有策略契约抽象，不能只做提示词预设 |
| D6 | t=0（任务开始） | **高置信时才建议，用户一键确认** | 不做 t=0 的 LLM 分类器；零额外固定成本 |
| D7 | t=1 阈值口径 | **阈值可配 + 先观测再定默认值** | 先补采集与事件、不切换；用真实数据定默认阈值 |

**D6/D7 的由来（用户原话）**：

> "如果默认 react，如何定义和检测到复杂任务？仅根据用户对话不现实，有些任务指令简短，但是实现复杂"

这条质疑是本设计的起点，第 2 章给出直接回答。

---

## 2. 为什么 t=0 判不准、而 t=1 可以（本设计的核心论证）

### 2.1 t=0 从对话文本判复杂度：证据不支持

| 证据 | 内容 | 来源 |
|---|---|---|
| 无先例 | 成熟项目**没有**"LLM 分类器选整体 loop 模式"的实现；只有更窄的三种：选**模型档**（GPT-5 router）、选**是否先规划**（Cursor Plan Mode）、选**专家 agent**（LangChain Router） | Anthropic《Building effective agents》；LangChain multi-agent docs |
| 自动路由的真实代价 | GPT-5 全自动 router + 无过渡期下架旧模型 → 用户反弹核心是"**响应变得不可预测、失去显式选择权**"，OpenAI 当日承诺回滚、4 天后恢复模型选择器 | simonwillison.net 2025-08-07 / 2025-08-08 |
| 计划本身已降级为 opt-in | LangChain 把 planning 从独立架构降为 **`TodoListMiddleware` 默认关闭**；Claude Code 的 todo 工具是 **no-op**（"just context engineering strategy"） | LangChain Deep Agents docs；blog.langchain.com/deep-agents |
| 固定成本可量化 | Router 模式**每次请求**多 1 次 LLM 调用，且**无状态、重复请求不省钱** | LangChain multi-agent docs（含调用次数表） |
| 误判代价不对称 | Anthropic 早期失败模式：简单查询 spawn 50 个 subagent → 需把 scaling rules 写进 prompt 才收敛 | Anthropic multi-agent research system |

→ **结论**：t=0 做 LLM 分类器，成本是固定支出、收益不确定、失败模式是"用户失去控制感"。**不做。**

### 2.2 t=1（首轮探索后）复杂度是客观事实，但当前采集不到

**代码事实（逐行核实）**：

```js
// kernel/engine.mjs:1026 —— 原始结果手边可用
const toolResults = blocks.map((b, i) => ({
  type: 'tool_result', tool_use_id: b.id,
  content: executed[i]?.content ?? '',          // ← 结果正文在这里
  is_error: executed[i]?.isError === true,
}))
// kernel/engine.mjs:1031-1036 —— 但观测面只取了 4 个字段
turnToolDigest.push({
  name: String(blocks[i]?.name || ''),
  path: String(inp.file_path ?? inp.path ?? inp.pattern ?? ...).slice(0, 300),
  isError: toolResults[i]?.is_error === true,
  errorText: String(...).slice(0, 200),
})
if (turnToolDigest.length > 40) turnToolDigest.splice(0, turnToolDigest.length - 40)
```

**没有结果规模字段**。`Glob` 命中 3 个文件与命中 300 个文件，在观测面上**完全一样**——而"命中面多大、要改几个文件"正是复杂度的客观代理量。

**且这不是疏漏，是既定设计**（必须正面处理）：

```js
// kernel/engine.mjs:1024-1025 原文注释
// 失真观测（2026-09-12 spec §4.2）：工具结果摘要 = 陈旧引用检测的可信真值源。
// 只保留"路径 + 是否失败 + 错误文本（截断）"，不复制结果正文（体积与隐私）。
```

→ 4 字段限制**出于体积与隐私考虑**，是对既有决策的遵守。

**关键点**：`toolResults[i].content` 就在同一函数、5 行之前**手边可用**（`engine.mjs:1026-1034` 内已在读它的 `.slice(0,200)` 作 `errorText`），而本设计只需要补一个**整数长度**：

```js
size: typeof toolResults[i]?.content === 'string' ? toolResults[i].content.length : 0,
```

→ **`size` 只存长度、不复制正文，不违反"不复制结果正文（体积与隐私）"约束**——这是 3 行改动且与既有决策相容。

> **这回答了用户的质疑**：检测不出"简短指令背后的复杂实现"，不是缺分类器，是**首轮探索的真实结果规模没被采集**；而补齐它的代价是一个整数字段。

### 2.3 系统"已经在检测任务比预期复杂"，只是没把检测用于模式

| 已有守卫 | 语义 | 现反应（engine.mjs） | 本设计给它的新用途 |
|---|---|---|---|
| 守卫④ `errorStreak ≥ MAX_ERROR_ITERATIONS`(6) | 连续全部失败 | 注入"排查失败原因"续跑（:1066-1105） | → **升级 Reflection** |
| 守卫⑤ `repeatStreak` @ `REPEAT_REMIND_AT` | 同工具连续重复 | 注入提醒不 veto（:1083） | → 升级 Reflection |
| 守卫③/③b 生成重复 / 句级近重复 | 生成打转 | 内部自愈注入（:630/:643） | → 升级 Reflection |
| 守卫⑥ `LOOP_STALL_MS`(600s) 无进展 | 方向错了 | 注入推进指令，耗尽 `STALL_HEAL_MAX`(2) 收尾（:497-532） | → **升级 Plan 重规划** |

这正是既有审计 **13.1-1（G1）** 指出的缺口：

> "turnStats 无守卫 reason/失败分类字段 → 守卫类型无聚合统计 …… 即'失败模式'未进测量面"
> 建议："把守卫收尾 reason 计入 turnStats（如 `guard:{type}`）…… 届时再评估 13.1-2 式路由是否有价值"

→ **本设计把 13.1-1 的建议作为 D7 的第一交付物**（先采集，不切换）。

---

## 3. 既有审计反证的适用性分析（必须正面回应）

本仓库 `2026-09-08-agentloop-guide-gap.md` 对本需求方向有**反对结论**，不能绕过：

| 审计条目 | 评级 | 原文结论 |
|---|---|---|
| 13.1-2 策略统一实现 ExecutionStrategy | **G2 缺失** | "**不建议为当前体量抽象 ExecutionStrategy 接口**" |
| 13.1-6 未引入超收益的自适应复杂度 | **G0 覆盖** | "维持现状（单策略引擎），不引入 13.5 融合形态"；"用数据再决定要不要路由——**而非现在上框架**" |
| 2.1-4 策略接口 | — | "指南 1.6 易错点 1 恰好警告「**80% 一种模式时勿为 20% 引入整套编排复杂度**」" |
| 2.2.4 策略接口 | 缺口 | "engine 与子 lane 两套循环复制 600+ 行镜像逻辑…… 是本章最值得借鉴的抽象" |
| 12.1-5 子 Agent 边界 | G1 | "可配粒度不足…… **无 per-agent 步数/token/成本硬预算上限**；独立超时**非独立配置**" |

### 3.1 逐条判定：反对的是 A，本设计是 B

| 审计反对的对象 | 本设计是否涉及 |
|---|---|
| **自动路由框架**（`TaskProfile` + `can_handle` 评分路由 + 历史成功率回填） | ❌ 不涉及。本设计**无评分路由、无历史回填**；LLM 只出建议，用户确认（D1/D6） |
| **13.5 融合投票**（同请求多策略并跑） | ❌ 不涉及 |
| 三模式同接口**为 20% 场景引入 80% 复杂度** | ⚠️ **部分涉及，已收窄**：不引入新运行时，模式 = 既有构件重组合（见 §5.2）；且分 B1/B2，B1 零行为变更 |
| 策略接口造成的抽象成本 | ⚠️ **必须正视**——见 §3.2 对审计 600 行的修正 |

### 3.2 修正审计一处乐观估计（影响方案选型）

审计称策略接口可消化 `runSubAgentLoop`（engine.mjs:1505-1855）的 **600 行**镜像。逐行核对后修正：

| 分类 | 规模 | 内容 |
|---|---|---|
| **可共享（真重复）** | **约 300-350 行** | 守卫检查组（①②③③b④⑤⑥同族）、自愈注入、流式聚合（text/thinking/tool_use/usage/stop_reason）、停流判定、usage 累加、`canonicalToolCallKey` 链 |
| **刻意不同（不该收敛）** | **约 250 行** | lane 无 health / 无锚点注入 / 无完整 `preStep`（engine.mjs:1502-1504 注释明说"无健康（短会话）；无压缩器"）、`inbox`(B2) vs `pendingNext`(P8)、`guardStop`(return) vs `loopStop`+`break`、无 `asksUser` 挂起 |

→ **修正后的收益预期**：策略接口的真实价值是「**模式逻辑一处实现、主循环与 lane 两处生效**」，而非"消掉 600 行"。这**同时降低了收益预期与风险预期**——不必强行统一那 250 行刻意差异。

### 3.3 本设计吃下的三条审计前置条件

| 前置条件 | 审计条目 | 本设计落实处 |
|---|---|---|
| 失败模式进测量面 | 13.1-1 | §7 观测层（`turnToolDigest.size` + 守卫 reason 入 turnStats + 模式事件） |
| 切换带理由与遥测 | 13.1-3 | §8 切换协议（`loop_mode_switched{from,to,reason,source}` + wire 事件） |
| 切换四步协议、不裸切 | 13.1-4 | §8.2（切换边界=轮末，天然满足"不裸切"） |

---

## 4. 外部对标：模式各自的成熟骨架（用于定实现形态）

### 4.1 Plan-and-Execute

| 做法 | 骨架 | 来源 |
|---|---|---|
| LangChain 原版 | **planner**（生成多步清单）→ **executor**（接收 query + 单步，调工具）→ **re-planning prompt**（决定"给最终回答"还是"生成后续计划"） | blog.langchain.com/planning-agents |
| ReWOO | 计划内允许**变量赋值**（`E1: Search[...]`、`E4: Search[#E2]`），顺序执行 + 变量替换 | 同上 |
| LLMCompiler | Planner **流式输出任务 DAG**；依赖满足即调度；**Joiner 依整图历史决定 replan 或收尾** | 同上 |
| **计划的最佳落地形态** | Claude Code 的 todo = **no-op**，纯上下文工程；Manus 的 `todo.md` = "**把目标背诵到上下文末尾**"以抗 lost-in-the-middle 与目标漂移（复杂任务平均 ~50 次工具调用） | blog.langchain.com/deep-agents；manus.im blog |
| **重规划三判据** | ①每步执行后询问（LangChain）②依赖图状态变化后判定（LLMCompiler）③**保留失败轨迹**让模型自行更新（Manus："keep the wrong stuff in"） | planning-agents；manus.im blog |
| 趋势 | LangChain 把 planning 降为 **opt-in 中间件、默认关** | LangChain Deep Agents docs |

→ **对本设计的直接影响**：Plan 模式**不新增 plan 数据结构**，用 `TodoWrite` 作为计划表示（**已存在**，见 §5.2），复述动作本身即抗漂移手段。

### 4.2 Reflection

| 做法 | 触发/退出/产物 | 证据 |
|---|---|---|
| Reflexion | draft → execute_tools → revise；**最多 5 次迭代**；反思**强制接地**：须引用来源、显式枚举缺失与多余 | arXiv 2303.11366 |
| LangChain Basic Reflection | generator + reflector；**固定轮数**退出（`if len(state) > 6: END`）；产物=消息列表追加 | blog.langchain.com/reflection-agents |
| LATS | 反思作 value function：Expand(5) → Reflect+Evaluate 打分 → Backpropagate；退出 `is_solved` 或树高 > 5 | 同上 |
| **收益不稳定的强实证** | TACL 2024 综述：**除极适合自纠的任务外，没有任何工作证明"prompted LLM 的自反馈"能成功自纠**；有**可靠外部反馈**时自纠才有效 | arXiv 2406.01297 |
| 自纠可能变差 | ICLR 2024：无外部反馈时难以自纠推理错误，**有时性能反而下降** | arXiv 2310.01798 |
| 机制质疑 | 图着色任务：批评内容正确与否**与最终表现基本无关**，提升主要来自 top-k 采样 | arXiv 2310.12397 |
| 成本 | 一轮反思 ≈ **+2 次生成调用**（约 3x）；多 agent 叠加 4x→15x | reflection blog；Anthropic |

→ **对本设计的直接影响**（硬约束）：
1. **Reflection 只在有外部可验证信号时开**——接 `loop-verify.mjs` 的 `doneWhen`（cmd 验真 / judge 判词）、工具结果、测试输出；**无信号默认关闭**。
2. **固定轮数退出**（不靠模型自评"我满意了"）+ 预算上限。
3. **产物写回上下文并改写下一步动作**，不只出报告（Reflexion 的价值在"反思进入后续 trial 的记忆"）。

### 4.3 多评审（MAGI）

| 做法 | 视角切分 / 汇总 | 来源 |
|---|---|---|
| Claude Code 并行 review | **按审查维度切分而非人格**：security / performance / test coverage 各一名，要求"distinct lens so they don't overlap"，**lead 汇总** | docs.claude.com agent-teams |
| Claude Code 竞争假设 | 5 个 teammate 各持假设**互相证伪**（对抗性，非 persona 表演）；动机：顺序调查有 anchoring | 同上 |
| **汇总：单判官优于多判官** | Anthropic 实测：试过"多 judge 各评一维"，发现 **"a single LLM call with a single prompt outputting scores 0.0–1.0 + pass/fail 最一致、最贴合人类判断"** | Anthropic multi-agent research system |
| 汇总：异构小模型陪审团（PoLL） | 多个小模型 panel 优于单一大 judge，**成本低 7 倍以上**，跨模型家族降 intra-model bias | arXiv 2404.18796 |
| **"多评审≈浪费"的反面证据** | MAD benchmark："multi-agent debating systems, in their current form, **do not reliably outperform** self-consistency and ensembling"；但对超参极敏感 | arXiv 2311.17371 |
| 辩论何时有效 | 有**明确正确答案的裁决任务**：弱模型/人类判题准确率 48%→76%、60%→88% | arXiv 2402.06782 |
| 成本 | Claude Code：每个 teammate 独立 context，token **线性增长** + 协调开销 + 收益递减，建议 **3–5 个**，"三个专注的常常胜过五个分散的" | docs.claude.com agent-teams |
| **本地实测** | n=3 样本 / 13 注入缺陷：异族模型（MiniMax-M3）命中 10.5/13（≈81%）vs 现状 deepseek 族 13/13（100%），**且漏掉唯一"必然崩溃"级缺陷** → 结论"不改变默认值" | `docs/superpowers/audits/2026-09-19-reviewer-cross-model.md` |

→ **对本设计的直接影响**（硬约束）：
1. 三视角 = **正交审查维度**（如：事实/来源正确性、方案/风险、覆盖/完整性），**不是三种人格**。
2. 汇总 = **1 次主席裁决**合并问题清单，**不做"三份评分取平均"**。
3. MAGI **默认关、显式开启、写死预算**（3 评审 + 主席 = 4 次调用）。本地实测已证"换更强模型不必然更好"，不能用"多一个评审"当默认保险。

### 4.4 子 Agent 开关

| 产品 | 机制 | 关键语义 |
|---|---|---|
| Claude Code | `tools: Agent(worker, researcher)` 白名单；`permissions.deny: Agent` = 完全禁止委派；`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`(默认 20，超限**报错并告知模型不要重试**)；`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`(默认 **3**，`1`=关嵌套，**到上限收回 Agent 工具**) | 三闸：白名单 + 并发 + 深度 |
| Cursor | frontmatter `readonly` / `is_background` / `model`；嵌套**硬两层**（二层不能再派） | 深度是有限资源 |
| OpenAI Agents SDK | `Agent.as_tool(needs_approval=..., is_enabled=..., max_turns=...)`；`needs_approval` → run 暂停 → `result.interruptions` → `state.approve()/reject()` | **暂停-恢复式人工闸门**（最干净的语义） |
| GitHub Copilot | `.github/agents/*.agent.md` frontmatter `tools`（省略=全部） | 仅白名单，无并发/嵌套控制 |
| **Ponos 现状** | `agents.mjs`（注册即路由依据）、`disabled.mjs`（**全局**停用，语义=不进提示词/不在 Task 表）、`shared/subagent-concurrency.mjs`（`MAX_SUBAGENTS_CAP=32`）、**无深度闸**（`engine.mjs:2013` 的 `depth` 只透传，注释标"S4 预留"） | 缺：任务级软开关、深度闸、人工闸门 |

---

## 5. 设计总览

### 5.1 分块与分期（决策 D4）

| 块 | 内容 | 期 | 交付判据 |
|---|---|---|---|
| **块 1** | **B1 循环体契约**（纯重构） | 一期 | 零行为变更 + 现有 kernel-tests 全绿 + 可共享逻辑一处实现 |
| **块 2** | **B2 模式 = LoopProfile 预设 + 阶段钩子** | 一期 | 三模式可选/可切/可留痕；t=1 观测数据产出 |
| **块 3** | 子 Agent 三闸 + 深度闸 + 人工闸门 | 二期 | 用户可关/可限/可批 |
| **块 4** | MAGI 三评审 | 二期 | 显式开启 + 4 次调用预算 + 主席裁决 |

**块 1 与块 2 的关系**：块 1 是**纯重构**（等价变换），必须能**单独合并、单独回滚**。块 2 在其上注册模式。

### 5.2 关键设计决策：模式 = 既有构件重组合（不新增运行时）

| 模式 | 本质 | **既有构件**（已存在，非新建） | 需补的控制流 |
|---|---|---|---|
| **ReAct**（默认） | 现状不变 | `runTurnInternal` | 无 |
| **Plan** | 把 `TodoWrite` 从"**提示词建议**"升级为"**控制流约束**" | `prompt.mjs:91` 已在要求"复杂任务先规划"（**仅非 lean 分支**，见 §13 风险）；`compact.mjs:308` **已把 TodoWrite 当权威清单提取**（`extractKeyInfo`）——计划表示**已经存在** | ①首轮后产出计划 ②每轮末对照计划项 ③每步后一次廉价重规划判定 |
| **Reflection** | 守卫升格为"结构化自省" | 守卫家族 + `guardHeal` wire + `loop-verify.mjs:verifyDoneWhen` + `engine.mjs:2255 judgeUntil` | ①**挂外部信号**（硬约束）②结构化问题清单（非单条 done/reason）③固定轮数退出 |

**为什么这是最小设计**：三模式的构件**全部已在仓库里**，本设计做的是"把它们按模式重新编排 + 补控制流约束"，而非引入新框架。这直接回应审计 13.1-6 的"勿引入超收益复杂度"。

### 5.3 架构图（一期）

```
[用户/建议卡]──确认──┐
                     ↓
              loop-mode.mjs (纯函数)
              ├ 模式定义 REACT|PLAN|REFLECT
              ├ resolveMode({explicit, prev, signals})  ← 决策纯函数
              ├ 模式提示词片段 modeDirective(mode)
              └ 切换校验 canSwitch(from,to,phase)
                     ↓ profile = PROFILE[mode]
[cli.mjs:1322 loop.onTurnEnd] ← 轮边界切换落点（已存在）
                     ↓
[engine.mjs]  LoopProfile 驱动
   ├ iterHead  守卫序 ①②⑥（可配）
   ├ inStream  守卫序 ①b③③b + watchdog（可配）
   ├ afterStream 守卫序 R3-2④⑥⑤（可配）
   ├ phaseHooks beforeIter / afterToolBatch / afterTurn（模式挂载点）
   └ stopFn    main=loopStop+break ／ lane=guardStop(return)
                     ↓
[观测] turnToolDigest.size + guardReason + turnStats
                     ↓
[留痕] appendMeta('loop_mode_switched',{from,to,reason,source})
       wire.system('loop_mode_updated'|'loop_mode_suggested')
                     ↓
[GUI] SessionModeBar（模式徽标，照 sessionMode 范式）
```

---

## 6. 块 1：B1 循环体契约（纯重构）

### 6.1 契约

```js
// kernel/loop-core.mjs —— 循环体契约（新建）
/**
 * 一轮迭代的执行体。纯参数化——不持有闭包状态。
 * @param {LoopState} state  迭代可变状态（含守卫计数、usage、textBuf、flags）
 * @param {LoopCtx}   ctx    依赖注入（stream/store/wire/守卫阈值/钩子）
 * @returns {Promise<LoopState>} 更新后的 state（return 而非 mutate 语义便于测试）
 */
export async function runOnce(state, ctx)

/** 循环终止判定（收尾方式因宿主而异） */
export function shouldStop(state, ctx)   // → null | { reason, message }
```

`LoopProfile`（参数化面）：

```js
{
  guards: {
    iterHead:    ['wallClock', 'iterCap', 'stall'],          // 主：①②⑥
    inStream:    ['streamWallClock', 'genRepeat', 'nearRepeat', 'idleWatchdog'],
    afterStream: ['failureHeal', 'meltdown', 'progressRefresh', 'repeatReminder'],
  },
  thresholds: { ... },            // 阈值来源（默认 engine-config.mjs）
  compactor:  { preStep: true, laneCompact: false },  // 主 true / lane 看 LANE_COMPACT_ENABLED
  health:     { fidelityAnchor: true, recordTurnContent: true }, // lane false
  inject:     { pendingNext: true, inbox: false },    // 主 P8 / lane B2
  stop:       'loopStop' | 'guardStop',               // 收尾方式
  phaseHooks: {},                 // B2 由模式填充
}
```

### 6.2 迁移范围（严守"可共享 300 / 刻意差异 250"）

**纳入契约**（约 300-350 行）：
- 守卫检查组（`iterHead` / `inStream` / `afterStream` 三段序）
- 自愈注入（`guard_heal` wire + 注入文案 + 计数清零规则）
- 流式聚合（text / thinking / tool_use / usage / stop_reason）
- 停流判定（`detectGenerationRepeat` / `createNearRepeatDetector` / `makeIdleWatchdog`）
- usage 累加（`addUsage`）与 `canonicalToolCallKey` 链

**不纳入契约**（约 250 行，保留在各自宿主）：
- 主循环独有：`preStep` 完整压缩、`health` 锚点注入（`requestFaceWithAnchor`）、`asksUser`/`waitForAnswer` 挂起、`pendingNext`(P8)
- lane 独有：`inbox`(B2) 吸收、`guardStop` 收尾语义、`laneCompactor`（`LANE_COMPACT_ENABLED` 门控）

### 6.3 回归锁（B1 必须有）

| 锁 | 内容 | 判据 |
|---|---|---|
| L1 | 现有 kernel-tests 全绿 | 测试数量与通过数不变 |
| L2 | 守卫序等价 | 为每个守卫构造命中用例，断言**注入文案、wire 事件、计数变化、收尾时机**逐一不变 |
| L3 | 行为字节级等价 | 同一 mock 会话回放，`turnToolDigest`/`turnStats`/wire 事件序列比对一致 |

### 6.4 风险

| 风险 | 缓解 |
|---|---|
| `runTurnInternal` 是 2436 行文件里的核心函数，重入风险高 | 契约抽取**只做等价搬移**，不做顺手的逻辑修正（发现的 bug 另开 issue）；分 3-4 次提交，每次一个守卫组 |
| 闭包变量捕获（`model`/`systemPrompt`/`session`）跨函数边界 | `LoopCtx` 显式注入，**禁止在 loop-core 里引用 engine 闭包**（用 lint/评审把关） |
| 回归锁覆盖不到的路径 | 保留 `PONOS_LOOP_GUARD=0` 全关路径的等价性测试（现有 kernel-tests 已覆盖部分） |

---

## 7. 观测层（D7：先观测再定阈值）

### 7.1 采集补齐（3 处，均为纯增量）

| # | 位置 | 改动 | 目的 |
|---|---|---|---|
| O1 | `engine.mjs:1031-1036` | `turnToolDigest.push` 增 `size: content.length`（`content` 在同函数 `:1026` 已读取，用作 `errorText`） | **复杂度客观代理量**：命中面/结果规模 |
| O2 | 守卫命中点（①②③③b④⑤⑥） | `turnStats.push` 增 `guard: { type, attempt, heal }`（现仅 `{usage,lastUsage,durationMs,model,ts,compactCount}`，`engine.mjs:2386`） | 落实审计 13.1-1"守卫 reason 进 turnStats" |
| O3 | 模式切换点 | `appendMeta('loop_mode_switched', {from,to,reason,source,at})` | 落实审计 13.1-3/13.1-5"切换带理由 + 时间线" |

**O1 与既有 `2026-09-12 spec §4.2` 约束相容性**（必须遵守）：该处注释明确"**不复制结果正文（体积与隐私）**"。`size` 只存**整数长度**、不落正文，因此**不违反**该约束；`errorText`（截断 200）已是"内容派生字段"的先例，`size` 比它更保守。

**O2 的既有缺口证据**：`engine.mjs:2386` 的 `turnStats.push` 字段清单里**没有** guard 字段；`health.mjs` 的 `failures` 已接线（`recordFailure()`，:199），但**守卫类型仍无聚合统计**——审计 13.1-1 的缺口未修。

### 7.2 复杂度信号（t=1 判定输入）

混合信号，**全部来自客观事实、非文本猜测**：

| 信号 | 来源 | 语义 |
|---|---|---|
| `writeFiles.size` | O1 + `toolDigest` 中 `Write`/`Edit` 的 `path` 去重计数 | 要动几个文件 |
| `exploreHits` | O1 + `Glob`/`Grep` 结果规模 | 命中面多大 |
| `todoCount` | 已有：`compact.mjs:308` 已提取 TodoWrite | 模型自己认为有几步 |
| `guardReason` | O2 | 是否已命中守卫（=比预期难） |
| `turnIndex` / `iterCount` | 已有 | 已跑多远 |

### 7.3 阈值口径（D7：可配 + 先观测）

```js
// engine-config.mjs 新增（env 可配）
export const MODE_SWITCH_OBSERVE_ONLY = envFlag('PONOS_MODE_OBSERVE_ONLY', true)  // 默认 true：只观测不切换
// 阈值默认值由 §7.3 步骤 3 的观测期分布确定，本 spec 不预设数值（D7）
export const MODE_PLAN_WRITE_FILES_MIN = envNonNeg('PONOS_MODE_PLAN_WRITE_FILES', PLAN_FILES_MIN_DEFAULT)
export const MODE_PLAN_EXPLORE_HITS_MIN = envNonNeg('PONOS_MODE_PLAN_EXPLORE_HITS', PLAN_HITS_MIN_DEFAULT)
// 上述两个 *_DEFAULT 常量在 S8 步骤由观测数据填入；在此之前保持 OBSERVE_ONLY=true
```

**默认值定法**（D7 明确）：
1. 阶段一：`MODE_SWITCH_OBSERVE_ONLY=true`，只发 `wire.system('loop_mode_suggested')` 与落 meta，**不切换**
2. 收集真实会话的分布数据（`writeFiles.size` / `exploreHits` 直方图）
3. 依据分布定默认阈值（如取"明显高于单轮中位数"的分位点），阈值语义写进 spec 附录
4. 阶段二：默认阈值生效，但仍受 D6"建议制"约束（见 §8.3）

> **不接受"拍一个 N"**：用户明确要求"不要拍脑壳"，审计 13.1-6 也要求"用数据再决定"。

---

## 8. 块 2：模式与切换协议

### 8.1 三种模式的 Profile 预设

| 项 | REACT（默认） | PLAN | REFLECT |
|---|---|---|---|
| 触发 | 一切任务的起点 | 建议确认 / 用户显式 / 信号命中 | **守卫命中**（④/⑤/③）+ 有外部信号 / 用户显式 |
| 提示词 | 现状 `prompt.mjs` | `modeDirective('plan')`：首轮只读探索 + 产出 TodoWrite 计划；每轮末复述当前项 | `modeDirective('reflect')`：结构化自省清单（问题/证据/下一步） |
| 控制流约束 | 无 | ①首轮后强制计划 ②`afterTurn` 对照计划项 ③`afterToolBatch` 一次廉价 replan 判定 | ①强制收尾前一轮反思 ②`attempts ≤ N` 固定轮数退出 |
| 退出 | 自然收尾 | 计划项全完 / 用户接管 | attempts 耗尽 → 升级人工（不无限自省） |
| 外部信号要求 | — | — | **硬约束**：无 `doneWhen`/工具失败证据时不进入（见 §4.2） |
| 预算 | 现状 | 现状 + 1 次 replan 判定/轮 | 现状 + 2 次/轮（反思 + 改写），`attempts ≤ 2` 默认 |

**Plan 的计划表示**：直接用 `TodoWrite`（不复用不新建数据结构）。依据：Claude Code 的 todo 是 no-op 但有效（上下文工程）、Manus 的 `todo.md` 是注意力机制、LangChain 已把 planning 降为 opt-in。**复述即抗漂移**。

### 8.2 切换协议（吃下审计 13.1-4"不裸切"）

审计四步 = 摘要 → 共享记忆 → 计量保留 → warm-up。本设计的落点：

| 步 | 本设计落实 | 依据 |
|---|---|---|
| ①摘要 | 轮末切换时**已有压缩器状态**（`compactor.lastSummary()`，`spawnSubAgent` 已在用，`engine.mjs:2032`），模式切换时把当前计划/反思摘要注入请求面尾部 | 复用 `withAnchorTail` 式注入（`engine-config.mjs`），不改前缀缓存 |
| ②共享记忆 | 计划/反思**落 `store`（TodoWrite 或 meta）**，不放在临时变量里 | `TodoWrite` 已在 transcript；meta 用 `appendMeta` |
| ③计量保留 | **天然满足**：`usage`/`turnStats` 跨轮累计（`engine.mjs:2386`） | 审计已确认此点成立 |
| ④warm-up | 切换后**不立即执行**——插入一个显式的"模式生效"注入（说明新模式要求），让模型下一轮按新约定产出 | 避免"切了但模型不知道" |

**切换边界**：**仅轮末**（`cli.mjs:1322 loop.onTurnEnd`）+ 迭代头。**不打断进行中的一轮**（D2）。

**不裸切的硬要求**：禁止在无摘要/无注入说明的情况下改 `profile`——否则模式切换等价于"守卫静默失效"，是最难排查的 bug 类型（见 §9.2）。

### 8.3 切换权与建议流程（D1/D2/D6）

```
t=0（任务开始）
 ├ 用户显式指定模式 → 直接生效（最高优先级）
 ├ 高置信特征命中（触发 skill/workflow 自动匹配 / 消息含明确分步多文件特征 / 前序残留 todo）
 │   → 发 wire.system('loop_mode_suggested', {mode, reason, confidence}) + GUI 建议卡
 │   → 用户一键确认才切（Cursor 形态，零额外 LLM 成本）
 └ 其他 → REACT，不打扰

t=1（首轮探索后）
 └ 观测信号命中阈值（§7.3，且已过阶段一观测期）
     → 同样走"建议 → 确认"（不在 t=1 静默自动切）

轮末（进行中）
 └ LLM 自主切换请求：仅当**守卫命中**（④/⑤/③/⑥）→ 允许自动切（D2"轮边界自动切"）
     → 但必须落 meta + wire（全程留痕）
```

**用户显式优先级**：`explicit > 自动切换`。用户手动指定后，**LLM 不得自动切走**（否则违反 GPT-5 事件的教训：失去显式选择权）。

### 8.4 留痕与事件面

| 事件 | 时机 | 字段 |
|---|---|---|
| `wire.system('loop_mode_suggested')` | 建议产生 | `{mode, reason, confidence, signals}` |
| `wire.system('loop_mode_updated')` | 切换生效 | `{from, to, reason, source: 'user'\|'llm-signal'\|'guard', at}` |
| `wire.system('loop_mode_rejected')` | 用户拒绝建议 / 非法值 | `{reason, value, fallback}` |
| `appendMeta('loop_mode_switched')` | 同上（可审计时间线） | 同 `loop_mode_updated` + `seq` |

**照抄既有范式**：`reasoning_effort`（`cli.mjs:1538-1559`）与 `approval_mode`（`cli.mjs:1565-1571`）的"热切 + 校验 + meta + wire"四件套已验证可用，**不新造链路**。并**补上审计 13.1-3 指出的 reason 缺失**。

---

## 9. 一期实现顺序（B1 → B2）

### 9.1 步骤

| 步 | 内容 | 判据 |
|---|---|---|
| S1 | 观测层 O1/O2/O3（**先做**，纯增量、零风险） | 新字段出现在 turnStats / meta；测试覆盖 |
| S2 | B1 契约抽取：守卫序参数化 | L1/L2/L3 回归锁全绿，**零行为变更** |
| S3 | B1 契约应用到 lane（复用同一 `runOnce`） | lane 测试全绿；可共享逻辑确实只有一份 |
| S4 | `kernel/loop-mode.mjs`（纯函数 + 单测） | 模式定义/切换校验/提示词片段单测覆盖 |
| S5 | Plan 模式（控制流约束 + TodoWrite 计划表示） | 端到端：复杂任务进入 Plan 后产出计划且逐项推进 |
| S6 | Reflect 模式（挂 `doneWhen` 外部信号 + 固定轮数） | 端到端：验证失败时反思并改写下一步；无信号时不进入 |
| S7 | 切换协议 + GUI 建议卡 + 模式徽标 | 留痕完整；用户拒绝后不自动切 |
| S8 | 观测期收数据 → 定默认阈值 | 阈值有数据依据，附录记录 |

### 9.2 必须显式定义的语义（否则出隐蔽 bug）

| 语义 | 决策 | 理由 |
|---|---|---|
| 切换时守卫计数器保留还是清零？ | **保留**（`errorStreak`/`repeatStreak`/`stallHeals` 不清零） | 清零 = 模式切换变成"守卫预算重置"，可被模型反复利用来规避熔断（`REPEAT_HEAL_MAX=-1` 持久自愈下尤其危险） |
| `attemptMaxTokens` 是否重置？ | **保留** | 它是溢出自愈的产物，与模式无关 |
| 计划项未完成时切走怎么办？ | **保留计划 + 注入说明**（不静默丢弃） | 计划在 transcript（TodoWrite），天然保留；须注入"计划仍在，请继续" |
| 自动切换的频率上限？ | **每轮至多一次**（照 `guardInjections` 上限范式） | 防"模式抖动"（切来切去每轮都在切） |
| 用户显式指定后 LLM 能否切走？ | **不能** | D1 + GPT-5 事件教训 |

---

## 10. 块 3/4（二期，设计级）

### 10.1 块 3：子 Agent 三闸 + 人工闸门

**现状缺口**（已核实）：
- `disabled.mjs` 只有**全局**停用（跨所有会话），无任务级/会话级软开关
- **无深度闸**：`engine.mjs:2013` 的 `depth` 只透传进血缘，注释标"S4 预留"，无上限检查
- 无"派发前人工批准"闸门（`approval-mode.mjs` 的 `agent: 'loose'` 是**工具级**放行，非"每次派发问一次"）
- 审计 12.1-5：**无 per-agent 步数/token/成本硬预算上限**；独立超时**非独立配置**

**设计骨架（照成熟产品字段语义）**：

| 闸 | 语义 | 对标 | 落点 |
|---|---|---|---|
| ①工具级白名单 | 不给 `Agent`/`Task` 工具 = 彻底关 | Claude Code `permissions.deny: Agent`；Cursor `readonly` | 已有 `CHAT_MODE_DISALLOWED` 同构（`tools.mjs:722`） |
| ②并发上限 | 前台+后台**共用**预算 | Claude Code `MAX_CONCURRENT_SUBAGENTS`(20) | 已有 `LANE_MAX_CONCURRENT` + `shared/subagent-concurrency.mjs` |
| ③**深度闸（新增）** | 到上限**收回 Agent 工具**（非运行时报错） | Claude Code 默认 3；Cursor 硬 2 | 新增，读 `ctx.lane.depth`（已存在） |
| ④人工闸门 | 暂停-恢复式：派发前挂起 → 主会话批/拒 | OpenAI SDK `needs_approval` | 接 `loop.mjs` 已有 `awaiting_approval` 短路位 |
| ⑤per-agent 预算（可选） | `maxSteps`/`maxTokens`/`maxCostUsd` | 审计 12.1-5 建议 | `agents.mjs` frontmatter + `laneOptions` |

**关键取舍**：③用"收回工具"而非"运行时报错"——依据 Claude Code 语义（"到上限就收回 Agent 工具"），报错会让模型反复重试（已有前车之鉴：并发超限文案明确写"不要重试"）。

### 10.2 块 4：MAGI

**设计**（严守 §4.3 硬约束）：

```
用户显式开启 MAGI（默认关）
  ├ 评审 A：事实/来源正确性（数据是否有出处、断言是否被证据支持）
  ├ 评审 B：方案/风险（是否有更简方案、副作用、边界）
  └ 评审 C：覆盖/完整性（需求是否全覆盖、验收是否可验）  ← 三维度正交，非人格
       ↓ 各自只读（复用 reviewer 的 disallowedTools 只读语义，agents.mjs:69）
  主席裁决（1 次调用）：输入三份问题清单 → 输出合并清单 + 严重度 + 去重
  → 拒绝"三份评分取平均"（Anthropic 实测单判官更一致）
```

| 项 | 决策 | 依据 |
|---|---|---|
| 视角 | 正交维度，非 persona | Claude Code agent-teams"distinct lens so they don't overlap" |
| 汇总 | 1 次主席裁决 | Anthropic 实测"single LLM call 最一致" |
| 调用数 | 3 + 1 = **4 次**（写死上限） | Claude Code"3–5 个 teammate，收益递减" |
| 触发 | 显式开启；高风险**建议**不自动 | D3；本地实测已证"换更强模型不必然更好" |
| 高风险特征 | 改动面大 / 涉金 / 不可逆 | 复用 `kernel/highrisk.mjs:12` 导出的 `matchesHighRisk`（源头 `shared/high-risk.mjs` 的 `matchesApprovalTrigger`，已核实） |
| 模型选择 | 三评审**同模型**（不追求异族） | `2026-09-19-reviewer-cross-model.md` n=3 实测：异族 81% < 现状 100%，且漏必崩缺陷 |

### 10.3 块 3/4 的接缝（一期须预留）

| 接缝 | 一期要做的预备 |
|---|---|
| 深度闸 | `LoopCtx` 暴露 `lane.depth`（已有，接线即可） |
| 人工闸门 | 复用 `loop.mjs` 的 `awaiting_approval` 短路位（**不新增审批链路**） |
| 模式 × 子 Agent | Plan 模式下子 Agent 仍可用；MAGI 可作 Plan 模式的一个阶段钩子 |

---

## 11. 明确不做（含依据）

| 不做 | 依据 |
|---|---|
| ❌ t=0 的 LLM 复杂度分类器 | 无成熟先例；GPT-5 事件（失去可预测性/显式控制权）；LangChain Router 每次请求 +1 调用且无状态 |
| ❌ 自动路由框架（`TaskProfile`/`can_handle` 评分/历史成功率回填） | 审计 13.1-2 明确"不建议"；13.1-6 判"维持现状" |
| ❌ 13.5 融合投票（同请求多策略并跑） | 审计 13.1-6 判"不引入" |
| ❌ 无外部信号时开 Reflection | TACL 2024（无外部反馈时自纠不成立）+ ICLR 2024（可能变差）+ arXiv 2310.12397（批评正确性与表现无关） |
| ❌ MAGI 三份评分取平均 | Anthropic 实测：单次调用单 prompt 更一致 |
| ❌ Plan 设为默认模式 | LangChain 已把 planning 降为 opt-in 默认关；Claude Code todo 是 no-op |
| ❌ 为 MAGI 追求异族模型 | 本地 n=3 实测：异族 81% vs 现状 100%，漏必崩缺陷 |
| ❌ 强行统一主循环与 lane 的 250 行刻意差异 | §3.2：那是设计意图（lane 无 health/锚点/完整压缩），统一会引入不该有的依赖 |
| ❌ 模式切换清零守卫计数器 | §9.2：会变成"守卫预算重置"，可被反复利用规避熔断 |

---

## 12. 验收标准

### 12.1 一期（块 1+2）

| # | 标准 | 判据 |
|---|---|---|
| A1 | B1 零行为变更 | kernel-tests 全绿且数量不变；守卫命中用例的文案/事件/计数逐一不变 |
| A2 | 可共享逻辑一处实现 | 守卫检查组只有一份源码（`loop-core.mjs`），主循环与 lane 各传 profile |
| A3 | 三模式可选可切 | `REACT`/`PLAN`/`REFLECT` 可经参数/UI 指定并生效 |
| A4 | 切换留痕完整 | 每次切换有 wire 事件 + meta 条目，含 `from/to/reason/source` |
| A5 | 用户显式优先 | 用户指定后 LLM 不得自动切走（有测试） |
| A6 | Reflection 不无信号启动 | 无 `doneWhen`/无工具失败证据时，不进入 REFLECT（有测试） |
| A7 | 观测数据产出 | `turnToolDigest.size`、`turnStats.guard`、模式 meta 三者可读 |
| A8 | 阈值有数据依据 | 默认阈值来自观测期分布，附录记录取法 |

### 12.2 二期（块 3+4）

| # | 标准 | 判据 |
|---|---|---|
| E1 | 三闸可配 | 白名单/并发/深度各自可关可限，语义写进文档 |
| E2 | 深度到限**收回工具** | 不到上限时 `Agent` 工具存在，到上限时不在 schema 中（非报错） |
| E3 | 人工闸门可暂停恢复 | 派发前挂起 → 批准/拒绝均生效；复用 `awaiting_approval` |
| E4 | MAGI 默认关、4 次调用 | 未显式开启时零额外调用；开启后调用数 = 4（有测试） |
| E5 | MAGI 汇总为单次裁决 | 输出一份合并清单，非三份并列 |

> 注：验收项编号用 `A*`（一期）/`E*`（二期），与 §5.1 的"块 1=B1 重构 / 块 2=B2 模式"区分，避免与 `B*` 撞车。

---

## 13. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| B1 重构触碰 engine 核心函数（2436 行文件） | **高** | 只做等价搬移、分守卫组提交、三重回归锁（§6.3）、可单独回滚 |
| 模式切换引入隐蔽 bug（守卫静默失效） | **中高** | §9.2 显式定义五条语义；"不裸切"硬要求（§8.2） |
| Reflection 收益为负（文献已证） | **中** | 硬约束：只在有外部信号时开；固定轮数；默认关 |
| **lean 会话缺 Plan 模式的提示词基础** | **中高（已核实为真）** | `prompt.mjs:91`「复杂任务先规划：…先用 TodoWrite 建立任务清单」**只在非 lean 分支**（`changeFocus` 的 `: [ ... ]` 侧）；**lean 分支无此行**（lean 版 `changeFocus` 只有最小改动/收敛范围/禁止 Bash 三条，见 `prompt.mjs:86-88`）。→ Plan 模式在 lean 会话下**必须自行注入规划指令**（`modeDirective('plan')` 不能依赖既有提示词），且需在 lean 档做端到端验证 |
| 每次 replan 判定增加成本 | **中** | Plan 模式 +1 次/轮，需在观测期测出收益/成本比再定默认 |
| GUI 改动面（建议卡 + 徽标 + 事件归约） | **低中** | 照 `SessionModeBar`/`EffortPicker` 范式（已存在），事件挂 `useYFWCLI.ts` 的 system 归约（`:1020+`） |
| 阈值拍脑袋 | **低**（已规避） | D7：先观测后定，附录留数据依据 |

---

## 14. 附录：证据与来源

### 14.1 代码事实（逐行核实，2026-09-20）

| 事实 | 位置 |
|---|---|
| 主循环 = 单策略 ReAct | `engine.mjs:248` `runTurnInternal`；迭代循环 `:476` |
| `turnToolDigest` 缺结果规模字段（**且 4 字段限制是既定设计**：`2026-09-12 spec §4.2` 要求"不复制结果正文（体积与隐私）"） | `engine.mjs:1031-1036`；注释 `:1024-1025`；原始 `content` 在同函数 `:1026` 已读 |
| `turnStats` 缺守卫字段 | `engine.mjs:2386` |
| lane 循环 = 整段镜像 | `engine.mjs:1505` `runSubAgentLoop`（约 350 行）；`:1502-1504` 注释"无健康（短会话）；无压缩器" |
| 守卫序（主） | 迭代头 ①②⑥（`:486/:495/:497`）→ 流内 ①b③③b+watchdog（`:620/:630/:643`）→ 流后 R3-2④⑥⑤（`:932/:1066/:1076/:1083`） |
| 轮边界切换落点 | `cli.mjs:1322` `loop.onTurnEnd` |
| 守卫 reason 未入 turnStats | `engine.mjs:2386` 字段清单；`health.mjs:199` `recordFailure` 已接线但无守卫分类 |
| TodoWrite 已是事实上的计划表示 | `compact.mjs:308` `extractKeyInfo` 把它当权威清单；`prompt.mjs:91` 已要求先规划 |
| 无深度闸 | `engine.mjs:2013` `depth` 只入血缘，注释标"S4 预留"，无上限检查 |
| 子 Agent 仅全局停用 | `disabled.mjs`（语义=不进提示词/不在 Task 表） |
| 并发闸已有 | `engine-config.mjs` `LANE_MAX_CONCURRENT`；`shared/subagent-concurrency.mjs`（`MAX_SUBAGENTS_CAP=32`） |
| 热切四件套范式 | `cli.mjs:1538-1559`（effort）、`:1565-1571`（approval_mode） |
| 完成条件双层验证器 | `loop-verify.mjs` `verifyDoneWhen`（cmd 验真 + judge 判词，fail-closed） |
| LLM 判词 | `engine.mjs:2255` `judgeUntil` |

### 14.2 既有审计（本仓库）

- `docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`：13.1-1(G1) / 13.1-2(G2) / 13.1-3(G1) / 13.1-4(G2) / 13.1-5(G1) / 13.1-6(**G0**) / 12.1-5(G1) / 2.1-4 / 2.2.4 / 2.1-5(Reflection G1)
- `docs/superpowers/audits/2026-09-19-reviewer-cross-model.md`：异族评审 n=3 实测（10.5/13 vs 13/13）
- `docs/superpowers/specs/2026-09-17-loop-redesign-phase1-reliability-design.md`：loop 四期总纲（Phase 2 = 语义能力升级，与本设计方向一致）

### 14.3 外部来源

**官方工程博客 / 文档**
- Anthropic《Building effective agents》 https://www.anthropic.com/engineering/building-effective-agents
- Anthropic《How we built our multi-agent research system》 https://www.anthropic.com/engineering/built-multi-agent-research-system
- LangChain《Plan-and-Execute Agents》 https://blog.langchain.com/planning-agents/
- LangChain《Reflection Agents》 https://blog.langchain.com/reflection-agents/
- LangChain《Deep Agents》 https://blog.langchain.com/deep-agents/
- LangChain Deep Agents 文档 https://docs.langchain.com/oss/python/deepagents/overview
- LangChain Multi-agent 文档（含调用成本表） https://docs.langchain.com/oss/python/langchain/multi-agent
- Manus《Context Engineering for AI Agents》 https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Claude Code《Create custom subagents》 https://docs.claude.com/en/docs/claude-code/sub-agents
- Claude Code《Orchestrate teams》 https://docs.claude.com/en/docs/claude-code/agent-teams
- OpenAI Agents SDK《Agent orchestration》/《Tools》 https://openai.github.io/openai-agents-python/multi_agent/ ／ https://openai.github.io/openai-agents-python/tools/
- Cursor《Subagents》/《Plan Mode》 https://cursor.com/docs/agent/subagents ／ https://cursor.com/docs/agent/planning
- GPT-5 router 引文与回滚事件 https://simonwillison.net/2025/Aug/7/gpt-5/ ／ https://simonwillison.net/2025/Aug/8/surprise-deprecation-of-gpt-4o/

**论文**
- Reflexion 2303.11366 ／ Self-Refine 2303.17651
- LLMs Cannot Self-Correct Reasoning Yet 2310.01798 ／ GPT-4 Doesn't Know It's Wrong 2310.12397 ／ When Can LLMs Actually Correct Their Own Mistakes (TACL 2024) 2406.01297
- Multiagent Debate 2305.14325 ／ Should we be going MAD? 2311.17371 ／ Debating with More Persuasive LLMs 2402.06782 ／ Replacing Judges with Juries (PoLL) 2404.18796 ／ ChatEval 2308.07201
- RouteLLM 2406.18665

**证据强度标注**：
- **实证**（论文/受控实验）：Reflection 收益不稳定（强）、多评审收益条件性（强）、MAGI 汇总方式（Anthropic 内部实测 + PoLL）
- **生产实践**：Manus todo.md、Claude Code todo no-op、GPT-5 事件、Anthropic scaling rules
- **文档宣称**（无效果数据）：各家 subagent 字段语义、Cursor Plan Mode 触发条件
