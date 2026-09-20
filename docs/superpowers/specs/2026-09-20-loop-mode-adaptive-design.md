# Loop 模式自适应 · 设计（v2 完整版）

> 状态：设计定稿（用户已确认全部决策点），待评审 → 转 plan
> 日期：2026-09-20
> 基线：`kernel/engine.mjs`(2436 行) / `kernel/loop.mjs` / `kernel/cli.mjs` / `kernel/prompt.mjs` / `kernel/gen-guards.mjs` / `kernel/agents.mjs` / `kernel/compact.mjs` / `kernel/loop-verify.mjs` / `kernel/tools.mjs` / `server/bridge.mjs` / `src/components/chat/*`
> 前序：`docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`（指南第 13 章底稿 G7）、`docs/superpowers/specs/2026-09-17-loop-redesign-phase1-reliability-design.md`（loop 四期总纲）、`docs/superpowers/audits/2026-09-19-reviewer-cross-model.md`（评审模型对照实测）
> v2 变更：① 论证方式回归技术可行性（不以"无先例"作否决依据，见 §2.0）② 块 3/4 展开为详细设计 ③ 新增块 5「方法论编译」（方法论融入 loop，见 §9）
> v3 增量（**已并入本节 §12.1 与 §14.1**）：`docs/superpowers/specs/2026-09-20-injection-layer-unification-design.md` —— 注入层统一（经验/知识/方法论共用一条注入总线）。已拍板：① 并入一期（S1+ 注入总账 / S3.5 总线抽取 / S4.5 经验三层化+线索层 / S9.5 第 5 个下沉项）② 经验供给形态 = **只发索引线索**（不含正文，agent 自主读取，支持 `related` 一跳扩展线索阅读）③ 去重随 S4.5 ④ **S3.5 前移为 B1 设计约束**（B1 即以 `ctx.emitInjection(text,{persist,event})` 为唯一注入出口，只冻结这三项）⑤ EL1 逃生阀 = `PONOS_MEMORY_EL1=0`。**命名与边界**：不得用 `ctx.inject`（与 §6.1 `LoopProfile.inject` 区分）；总线只提供宿主侧渲染器注册位（lane 不注册锚点渲染器，保持 §6.2"刻意不同 250 行"）。新增验收 A12-A20 与**全局注入护栏 G1-G4**（§14.1）。该增量文件的角色 = 设计论证 + 评审留痕（Q1-Q21），**实施以本文件的 S 序列与判据为准**。

---

## 0. 一句话

把"一个循环干所有事、方法论靠提示词自觉"改为"**可选的执行模式 + 轮边界切换 + 方法论由引擎强制**"——模式不是新理论而是既有构件的重新组合；**切换权在用户，LLM 只提建议**；阈值**先观测再定**；**方法论从"读提示词"下沉为"引擎约束"**。

四块交付：
| 块 | 内容 | 期 |
|---|---|---|
| 块 1 | B1 循环体契约（纯重构） | 一期 |
| 块 2 | B2 模式 = LoopProfile 预设 + 阶段钩子 | 一期 |
| 块 5 | **方法论编译（下沉）** | 一期（与块 2 同源，见 §5.2） |
| 块 3 | 子 Agent 三闸 + 深度闸 + 人工闸门 | 二期 |
| 块 4 | MAGI 三评审 | 二期 |

---

## 1. 需求与已确认决策

### 1.1 原始需求

1. 任务开始时由 LLM 评估内容 → 选择进入不同 loop 模式（ReAct / Plan-and-Execute / Reflection），且**执行过程中可自主切换**
2. 子 Agent 提供**人工开关**
3. 审查提供 **MAGI 模式**（三评审不同视角并行 → 集中评审），并基于用户更多自定义选择
4. **（v2 新增）** 把 superpowers 技能等**专业工程师/架构师的方法论融入 loop**——"不仅仅是使用 skill 实现，而是融入到工作 loop，实现更低开支，更高效的 agent 工作流程"

### 1.2 已确认决策

| # | 决策点 | 用户选择 | 对设计的约束 |
|---|---|---|---|
| D1 | 模式由谁选 | **LLM 前置评估 + 用户可覆盖** | 必须有"建议→用户确认"通道；用户显式指定优先级最高 |
| D2 | 切换程度 | **轮边界自动切 + 全程留痕** | 不打断进行中的一轮；每次切换落 wire 事件 + transcript meta |
| D3 | MAGI 触发 | **显式开启 + 高风险自动建议** | 默认单 reviewer；命中高风险特征只**建议**不自动跑 |
| D4 | 落地路径 | **B1 纯重构 → B2 加模式** | B1 零行为变更且独立可交付；B2 才引入模式 |
| D5 | 模式表达力 | **允许改控制流** | 必须有策略契约抽象，不能只做提示词预设 |
| D6 | t=0（任务开始） | **高置信时才建议，用户一键确认** | 不做 t=0 的复杂度分类器 |
| D7 | t=1 阈值口径 | **阈值可配 + 先观测再定默认值** | 先补采集与事件、不切换；用真实数据定默认阈值 |
| D8 | 方法论融入方式 | **融入 loop（下沉），不止于 Skill 调用** | 需方法论→引擎约束的编译机制（§9） |
| D9 | 辩论方式 | **客观可行性与技术实现为准，不以"无先例"否决** | §2 论证不得以"没人做过"作否决理由 |

**D6/D7 的由来（用户原话）**：

> "如果默认 react，如何定义和检测到复杂任务？仅根据用户对话不现实，有些任务指令简短，但是实现复杂"

**D9 的由来（用户原话）**：

> "成熟项目无先例的，可以从客观可行、技术实现上讨论，不要别人没做，我们也不能做。"

**D8 的由来（用户原话）**：

> "我希望融入 superpower 技能等专业工程师、架构师处理问题的逻辑和方法论到 loop 中，不仅仅是使用 skill 实现，而是融入到工作 loop，实现更低开支，更高效的 agent 工作流程"

---

## 2. 判定机制：从技术可行性论证

### 2.0 论证方式声明（回应 D9）

本章不以"成熟项目无先例"作为否决依据。外部对标仅用于**提供实现参考与已知风险**，判定依据是：

| 判据 | 含义 |
|---|---|
| **可观测性** | 引擎能否客观检测到"该切/该约束"的信号？ |
| **误判代价对称性** | 误判（该切没切 / 不该切却切了）两个方向的代价是否可控？ |
| **修复动作明确性** | 检测到之后，能否给出明确的下一步动作（而非只提示"再想想"）？ |
| **成本量级** | 检测本身的 token / 时延开销是多少？是否随会话数线性增长？ |

### 2.1 t=0（任务开始）：可做，但**不该做成复杂度分类器**

**技术可行性分析**：

| 方案 | 可观测性 | 成本量级 | 误判代价 | 结论 |
|---|---|---|---|---|
| ① 用 LLM 从对话文本判"任务复杂度" | **低**——短指令可实现复杂任务，文本不含足够信息（**用户已指出此点**） | +1 次调用/任务，线性增长 | **高**——判浅了：该规划的没规划，返工在后期；判深了：简单任务背上计划开销 | ❌ 不可靠 |
| ② 用规则匹配**任务类型**（bug 修复/新功能/重构/调查/文档/数据） | **高**——关键词与上下文特征明确（"修一下 X"/"实现 Y"/"为什么 Z 失败"） | **0**（纯规则，无 LLM） | **低**——类型判错的后果是"用错方法论"，最坏是多几步流程；且可在 t=1 纠正 | ✅ 可行 |
| ③ 用已有信号（skill/workflow 自动匹配、前序残留 todo、用户显式指定） | **高** | 0 | 低 | ✅ 可行 |

**结论**：t=0 **做**，但做的是 **②③：任务类型/方法论匹配**，**不是**①：复杂度分类。

> **技术上的关键区别**：复杂度是**连续量**且 t=0 信息不足 → 判不准；任务类型是**离散标签**且 t=0 特征明确 → 判得准。方法论匹配依赖类型，不依赖复杂度。

### 2.2 t=1（首轮探索后）：复杂度成为客观事实，但当前采集不到

**代码事实（逐行核实）**：

```js
// kernel/engine.mjs:1026 —— 原始结果手边可用
const toolResults = blocks.map((b, i) => ({
  type: 'tool_result', tool_use_id: b.id,
  content: executed[i]?.content ?? '',          // ← 结果正文在这里
  is_error: executed[i]?.is_error === true,
}))
// kernel/engine.mjs:1031-1036 —— 但观测面只取了 4 个字段
turnToolDigest.push({
  name: String(blocks[i]?.name || ''),
  path: String(inp.file_path ?? inp.path ?? inp.pattern ?? ...).slice(0, 300),
  isError: toolResults[i]?.is_error === true,
  errorText: String(...).slice(0, 200),
})
```

**没有结果规模字段**。`Glob` 命中 3 个文件与命中 300 个文件，在观测面上**完全一样**——而"命中面多大、要改几个文件"正是复杂度的客观代理量。

**且这不是疏漏，是既定设计**（必须正面处理）：

```js
// kernel/engine.mjs:1024-1025 原文注释
// 失真观测（2026-09-12 spec §4.2）：工具结果摘要 = 陈旧引用检测的可信真值源。
// 只保留"路径 + 是否失败 + 错误文本（截断）"，不复制结果正文（体积与隐私）。
```

→ 4 字段限制**出于体积与隐私考虑**，是对既有决策的遵守。

**关键点**：本设计只需要补一个**整数长度**：

```js
size: typeof toolResults[i]?.content === 'string' ? toolResults[i].content.length : 0,
```

→ **`size` 只存长度、不复制正文，不违反"不复制结果正文"约束**；`errorText`（截断 200）已是内容派生字段的先例，`size` 比它更保守。

### 2.3 系统"已经在检测任务比预期复杂"，只是没把检测用于模式

| 已有守卫 | 语义 | 现反应（engine.mjs） | 本设计给它的新用途 |
|---|---|---|---|
| 守卫④ `errorStreak ≥ MAX_ERROR_ITERATIONS`(6) | 连续全部失败 | 注入"排查失败原因"续跑（:1066-1105） | → **升级 Reflection** |
| 守卫⑤ `repeatStreak` @ `REPEAT_REMIND_AT` | 同工具连续重复 | 注入提醒不 veto（:1083） | → 升级 Reflection |
| 守卫③/③b 生成重复 / 句级近重复 | 生成打转 | 内部自愈注入（:630/:643） | → 升级 Reflection |
| 守卫⑥ `LOOP_STALL_MS`(600s) 无进展 | 方向错了 | 注入推进指令，耗尽 `STALL_HEAL_MAX`(2) 收尾（:497-532） | → **升级 Plan 重规划** |

这正是既有审计 **13.1-1（G1）** 指出的缺口：

> "turnStats 无守卫 reason/失败分类字段 → 守卫类型无聚合统计 …… 即'失败模式'未进测量面"

### 2.4 判定链总览

```
t=0  规则匹配任务类型（0 token） → 建议方法论/模式 → 用户一键确认（D6）
t=1  观测真实命中面（=补齐 O1 字段）→ 建议升级/降级 → 用户确认（D7，先观测期）
轮末  守卫命中（④⑤③⑥）→ 允许自动切 + 全程留痕（D2）
任意  用户显式指定 → 优先级最高，LLM 不得切走（D1）
```

**关键设计性质**：方法论/模式**判错可在执行中被观测纠正**——这是它比"复杂度分类器"可靠的根本原因：复杂度猜错的结果是"该做的没做"（不可逆），方法论选错的结果是"流程不适配"（可在下一轮换）。

---

## 3. 既有审计反证的适用性分析（必须正面回应）

本仓库 `2026-09-08-agentloop-guide-gap.md` 对本需求方向有**反对结论**，不能绕过：

| 审计条目 | 评级 | 原文结论 |
|---|---|---|
| 13.1-2 策略统一实现 ExecutionStrategy | **G2 缺失** | "**不建议为当前体量抽象 ExecutionStrategy 接口**" |
| 13.1-6 未引入超收益的自适应复杂度 | **G0 覆盖** | "维持现状（单策略引擎），不引入 13.5 融合形态"；"用数据再决定要不要路由——**而非现在上框架**" |
| 2.1-4 策略接口 | — | "指南 1.6 易错点 1 恰好警告「**80% 一种模式时勿为 20% 引入整套编排复杂度**」" |
| 2.2.4 策略接口 | 缺口 | "engine 与子 lane 两套循环复制 600+ 行镜像逻辑…… 是本章最值得借鉴的抽象" |
| 12.1-5 子 Agent 边界 | G1 | "可配粒度不足…… **无 per-agent 步数/token/成本硬预算上限**" |

### 3.1 逐条判定：反对的是 A，本设计是 B

| 审计反对的对象 | 本设计是否涉及 |
|---|---|
| **自动路由框架**（`TaskProfile` + `can_handle` 评分路由 + 历史成功率回填） | ❌ 不涉及。**无评分路由、无历史回填**；LLM 只出建议，用户确认（D1/D6） |
| **13.5 融合投票**（同请求多策略并跑） | ❌ 不涉及 |
| 三模式同接口**为 20% 场景引入 80% 复杂度** | ⚠️ 部分涉及，**已收窄**：不引入新运行时，模式 = 既有构件重组合（§5.2）；分 B1/B2，B1 零行为变更 |
| 策略接口的抽象成本 | ⚠️ 必须正视——见 §3.2 |

### 3.2 修正审计一处乐观估计（影响方案选型）

审计称策略接口可消化 `runSubAgentLoop`（engine.mjs:1505-1855）的 **600 行**镜像。逐行核对后修正：

| 分类 | 规模 | 内容 |
|---|---|---|
| **可共享（真重复）** | **约 300-350 行** | 守卫检查组、自愈注入、流式聚合（text/thinking/tool_use/usage/stop_reason）、停流判定、usage 累加、`canonicalToolCallKey` 链 |
| **刻意不同（不该收敛）** | **约 250 行** | lane 无 health / 无锚点注入 / 无完整 `preStep`（engine.mjs:1502-1504 注释明说"无健康（短会话）；无压缩器"）、`inbox`(B2) vs `pendingNext`(P8)、`guardStop`(return) vs `loopStop`+`break`、无 `asksUser` 挂起 |

→ **修正后的收益预期**：策略接口的真实价值是「**模式逻辑一处实现、主循环与 lane 两处生效**」，而非"消掉 600 行"。这**同时降低收益预期与风险预期**——不必强行统一那 250 行刻意差异。

### 3.3 本设计吃下的三条审计前置条件

| 前置条件 | 审计条目 | 本设计落实处 |
|---|---|---|
| 失败模式进测量面 | 13.1-1 | §7 观测层 |
| 切换带理由与遥测 | 13.1-3 | §8.4 切换事件（含 reason） |
| 切换四步协议、不裸切 | 13.1-4 | §8.2 |

---

## 4. "下沉"：Ponos 已验证的既有路径（本设计的核心依据）

### 4.1 铁证：引擎已经把"提示词纪律"下沉为守卫，且经 lean 档工程验证

`kernel/prompt.mjs:45-46` 原文注释：

> lean 剪枝原则：**只删有引擎守卫兜底的细则**（计划尾/想完即停/报错重试均在 engine.mjs 注入自愈），功能协议核心（工具纪律/回复规范）一字不动。

**这意味着：凡是引擎能兜底的纪律，提示词就不必写**——lean 档已实证（删掉提示词后引擎守卫仍生效）。

### 4.2 已下沉 vs 未下沉（逐条核实）

| 纪律 | 提示词里有 | 引擎是否强制 | 状态 |
|---|---|---|---|
| 禁止"计划尾巴" | ✅ | ✅ `isPlanTail`（gen-guards.mjs:22）+ 自愈（engine.mjs:970/1773） | **已下沉** |
| 禁止"想完即停" | ✅ | ✅ `isThinkOnly`（gen-guards.mjs:34）+ 续写（engine.mjs:981） | **已下沉** |
| 禁止"报错即停" | ✅ | ✅ `hadToolError` + 自愈（engine.mjs:962/1760） | **已下沉** |
| 禁止生成打转 | 部分 | ✅ `detectGenerationRepeat`（守卫③）/ `createNearRepeatDetector`（守卫③b） | **已下沉** |
| **【里程碑进度协议】输出 MILESTONE 标记** | ✅ 长文详述 | ❌ **纯解析，无校验** | ❌ **未下沉** |
| **【互动问答】用 ASK_USER 卡片** | ✅ 长文详述 | ⚠️ 仅逐帧解析（api.mjs:56/81/197），不校验"该问没问" | ⚠️ **半下沉** |
| **【经验沉淀】写经验** | ✅ | ❌ | ❌ **未下沉** |
| **【改动聚焦】最小改动** | ✅ | ❌ | ❌ **未下沉** |
| **【子 Agent 编排】逐任务派发+审查** | 仅 Skill 内 | ❌ | ❌ **未下沉** |
| **【完成前验证】** | 仅 Skill 内 | 部分（`loop-verify.mjs` 仅在 `doneWhen` 显式配置时生效） | ⚠️ **半下沉** |

**MILESTONE 的核实证据**：`MILESTONE` 在 kernel 下共 5 处命中，**全部是解析/剥离，无一处校验**：
- `api.mjs:56` —— "依据：ASK_USER 提问卡与 MILESTONE 进度标记**都是 HTML 注释**，而桥侧是**逐帧**正则"（解析）
- `api.mjs:81` —— 切点处理（解析）
- `api.mjs:197` —— "推理模型常把 MILESTONE 标记写在 thinking 里"（解析）
- `compact.mjs:441` —— 压缩时剥离（不当正文）

→ **结论：`【任务里程碑进度协议】` 目前是纯提示词约束，引擎只解析不 Enforcement。**

### 4.3 技术路线图

Ponos 的"下沉"路径**已验证 4 条纪律**，尚有 6+ 条未下沉。用户诉求（D8）= **把这条已验证的路径系统化、扩展到方法论族**。这不是新发明，是既有工程实践的推广。

---

## 5. 设计总览

### 5.1 核心架构洞察：**"模式"与"方法论"是同一件事的两个视角**

| 视角 | 表述 |
|---|---|
| 从**控制流**看 | 「Plan 模式」= 先规划再执行的阶段机 |
| 从**方法论**看 | 「Plan 模式」= `writing-plans` + `executing-plans` + `subagent-driven-development` 的编译产物 |

**统一结论**：模式 = 方法论编译产物的运行时实例。因此**块 2（模式）与块 5（方法论编译）共用同一套机制**——不需要为每个模式单独设计，只需要一个编译器 + 一份方法论声明。

```
SKILL.md（方法论源）
    ↓ 编译（§9.3）
MethodologySpec（声明式）
    ├ when:     触发判据（规则，0 token）
    ├ phases:   阶段机
    ├ gates:    门控（审批）
    ├ guards:   守卫（Iron Law → 引擎断言）
    └ budget:   预算/上限
        ↓
LoopProfile + PhaseHooks（运行期）
        ↓
引擎强制执行（0 token）
```

### 5.2 模式 = 既有构件重组合（不新增运行时）

| 模式 | 本质 | **既有构件**（已存在，非新建） | 方法论来源（编译） |
|---|---|---|---|
| **ReAct**（默认） | 现状不变 | `runTurnInternal` | 无 |
| **Plan** | 把 `TodoWrite` 从"**提示词建议**"升级为"**控制流约束**" | `prompt.mjs:91` 已要求先规划（**仅非 lean 分支**，见 §15 风险）；`compact.mjs:308` **已把 TodoWrite 当权威清单提取** | `writing-plans` + `executing-plans` + `subagent-driven-development` |
| **Reflect** | 守卫升格为"结构化自省" | 守卫家族 + `guardHeal` wire + `loop-verify.mjs:verifyDoneWhen` + `engine.mjs:2255 judgeUntil` | `systematic-debugging`（+ `verification-before-completion` 守卫） |

**横切约束**（不属任何模式，全局生效，均由方法论编译而来）：

| 约束 | 来源方法论 | 落点 |
|---|---|---|
| 完成前验证（Iron Law） | `verification-before-completion` | 收尾前守卫（所有模式） |
| 设计未批准不得实现（HARD-GATE） | `brainstorming` | 门控（复用 `awaiting_approval`） |
| 技能路由 | `using-superpowers` | t=0 规则匹配（引擎侧） |
| 测试先行 | `test-driven-development` | 门控（按任务类型启用） |
| 并行派发纪律 | `dispatching-parallel-agents` | 块 3 并发闸 |
| 审查请求/接收 | `requesting/receiving-code-review` | 块 4 审查钩子 |

### 5.3 分块与分期

| 块 | 内容 | 期 | 交付判据 |
|---|---|---|---|
| **块 1** | B1 循环体契约（纯重构） | 一期 | 零行为变更 + kernel-tests 全绿 |
| **块 2** | B2 模式 = LoopProfile + 阶段钩子 | 一期 | 三模式可选/可切/可留痕 |
| **块 5** | 方法论编译（下沉） | 一期 | ≥4 个方法论下沉生效；Skill 加载量可测下降 |
| **块 3** | 子 Agent 三闸 + 深度闸 + 人工闸门 | 二期 | 用户可关/可限/可批 |
| **块 4** | MAGI 三评审 | 二期 | 显式开启 + 4 次调用预算 + 主席裁决 |

**块 1 独立可交付**：纯重构，必须能单独合并、单独回滚。

### 5.4 架构图（一期）

```
[用户 / 建议卡 / 显式参数]
        ↓
  loop-mode.mjs (纯函数)
  ├ 模式定义 REACT|PLAN|REFLECT
  ├ resolveMode({explicit, prev, taskType, signals})   ← 决策纯函数
  ├ modeDirective(mode)                                 ← 提示词片段
  └ canSwitch(from, to, phase)
        ↓ profile = compile(PROFILE[mode] + METHODOLOGY[ids])
[cli.mjs:1322 loop.onTurnEnd] ← 轮边界切换落点（已存在）
        ↓
[engine.mjs]  LoopProfile 驱动
  ├ iterHead    守卫序 ①②⑥（可配）
  ├ inStream    守卫序 ①b③③b + watchdog（可配）
  ├ afterStream 守卫序 R3-2④⑥⑤（可配）
  ├ phaseHooks  beforeIter / afterToolBatch / afterTurn ← 模式与方法论挂载点
  └ stopFn      main=loopStop+break ／ lane=guardStop(return)
        ↓
[方法论执行层 §9] MethodologySpec
  ├ gates  门控（HARD-GATE / TDD / 验证）→ awaiting_approval
  ├ guards 守卫（Iron Law → 断言 + 自愈注入）
  └ budget 预算（fix loop ≤ 5 rounds 等）
        ↓
[观测] turnToolDigest.size + guardReason + turnStats
        ↓
[留痕] appendMeta('loop_mode_switched'|'methodology_applied', {...})
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
 * @param {LoopState} state  迭代可变状态（守卫计数、usage、textBuf、flags）
 * @param {LoopCtx}   ctx    依赖注入（stream/store/wire/阈值/钩子/注入出口）
 * @returns {Promise<LoopState>}
 * 注入出口：ctx.emitInjection(text, { persist, event })
 *   —— B1 的唯一注入出口（S3.5 换实现）；**命名不得用 ctx.inject**（与 LoopProfile.inject 区分）
 *   —— B1 冻结面仅 text/persist/event；priority/budgetBytes/kind/phase 由 S3.5 引入
 */
export async function runOnce(state, ctx)

/** 循环终止判定（收尾方式因宿主而异） */
export function shouldStop(state, ctx)   // → null | { reason, message }
```

`LoopProfile`（参数化面）：

```js
{
  guards: {
    iterHead:    ['wallClock', 'iterCap', 'stall'],                    // 主：①②⑥
    inStream:    ['streamWallClock', 'genRepeat', 'nearRepeat', 'idleWatchdog'],
    afterStream: ['failureHeal', 'meltdown', 'progressRefresh', 'repeatReminder'],
  },
  thresholds: { ... },            // 阈值来源（默认 engine-config.mjs）
  compactor:  { preStep: true, laneCompact: false },
  health:     { fidelityAnchor: true, recordTurnContent: true },      // lane false
  inject:     { pendingNext: true, inbox: false },                    // 主 P8 / lane B2
  stop:       'loopStop' | 'guardStop',
  phaseHooks: {},                 // §9 由方法论填充
}
```

### 6.2 迁移范围（严守"可共享 300 / 刻意差异 250"）

**纳入契约**（约 300-350 行）：
- 守卫检查组（`iterHead` / `inStream` / `afterStream` 三段序）
- 自愈注入（`guard_heal` wire + 注入文案 + 计数清零规则）——**经 `ctx.emitInjection` 出口**（12 处指令注入全部改走该出口；出口本身属 B1，实现替换属 S3.5）
- 流式聚合（text / thinking / tool_use / usage / stop_reason）
- 停流判定（`detectGenerationRepeat` / `createNearRepeatDetector` / `makeIdleWatchdog`）
- usage 累加（`addUsage`）与 `canonicalToolCallKey` 链

**不纳入契约**（约 250 行，保留在各自宿主）：
- 主循环独有：`preStep` 完整压缩、`health` 锚点注入、`asksUser`/`waitForAnswer` 挂起、`pendingNext`(P8)
- lane 独有：`inbox`(B2) 吸收、`guardStop` 收尾语义、`laneCompactor`

### 6.3 回归锁（B1 必须有）

| 锁 | 内容 | 判据 |
|---|---|---|
| L1 | 现有 kernel-tests 全绿 | 测试数量与通过数不变 |
| L2 | 守卫序等价 | 为每个守卫构造命中用例，断言**注入文案、wire 事件、计数变化、收尾时机**逐一不变 |
| L3 | 行为字节级等价 | 同一 mock 会话回放，`turnToolDigest`/`turnStats`/wire 事件序列比对一致 |

### 6.4 风险

| 风险 | 缓解 |
|---|---|
| `runTurnInternal` 是 2436 行文件里的核心函数，重入风险高 | 契约抽取**只做等价搬移**，不做顺手逻辑修正（发现的 bug 另开 issue）；分 3-4 次提交，每次一个守卫组 |
| 闭包变量捕获跨函数边界 | `LoopCtx` 显式注入，**禁止在 loop-core 里引用 engine 闭包**（lint + 评审把关） |
| 回归锁覆盖不到的路径 | 保留 `PONOS_LOOP_GUARD=0` 全关路径的等价性测试 |

---

## 7. 观测层（D7：先观测再定阈值）

### 7.1 采集补齐（3 处，均为纯增量）

| # | 位置 | 改动 | 目的 |
|---|---|---|---|
| O1 | `engine.mjs:1031-1036` | `turnToolDigest.push` 增 `size`（`content` 在同函数 `:1026` 已读取） | 复杂度客观代理量 |
| O2 | 守卫命中点（①②③③b④⑤⑥） | `turnStats.push` 增 `guard: { type, attempt, heal }`（现仅 `{usage,lastUsage,durationMs,model,ts,compactCount}`，`engine.mjs:2386`） | 落实审计 13.1-1 |
| O3 | 模式/方法论应用点 | `appendMeta('loop_mode_switched' \| 'methodology_applied', {...})` | 落实审计 13.1-3/13.1-5 |

**O1 与既有 `2026-09-12 spec §4.2` 约束相容性**：该处注释明确"**不复制结果正文（体积与隐私）**"。`size` 只存**整数长度**、不落正文，因此**不违反**该约束。

### 7.2 复杂度与方法论信号

| 信号 | 来源 | 语义 |
|---|---|---|
| `writeFiles.size` | O1 + `toolDigest` 中 `Write`/`Edit` 的 `path` 去重计数 | 要动几个文件 |
| `exploreHits` | O1 + `Glob`/`Grep` 结果规模 | 命中面多大 |
| `todoCount` | 已有：`compact.mjs:308` 已提取 TodoWrite | 模型自己认为有几步 |
| `guardReason` | O2 | 是否已命中守卫（=比预期难） |
| `taskType` | §9.2 的规则匹配 | 方法论路由输入 |

### 7.3 阈值口径（D7）

```js
// engine-config.mjs 新增（env 可配）
export const MODE_SWITCH_OBSERVE_ONLY = envFlag('PONOS_MODE_OBSERVE_ONLY', true)  // 默认 true
export const MODE_PLAN_WRITE_FILES_MIN = envNonNeg('PONOS_MODE_PLAN_WRITE_FILES', PLAN_FILES_MIN_DEFAULT)
export const MODE_PLAN_EXPLORE_HITS_MIN = envNonNeg('PONOS_MODE_PLAN_EXPLORE_HITS', PLAN_HITS_MIN_DEFAULT)
// 上述 *_DEFAULT 在 S8 由观测数据填入；在此之前保持 OBSERVE_ONLY=true
```

**默认值定法**：
1. 阶段一：`OBSERVE_ONLY=true`，只发 `wire.system('loop_mode_suggested')` 与落 meta，**不切换**
2. 收集真实会话分布（`writeFiles.size` / `exploreHits` 直方图）
3. 依分布定默认阈值（如取"明显高于单轮中位数"的分位点），取法写进本 spec 附录
4. 阶段二：默认阈值生效，但仍受 D6"建议制"约束（§8.3）

> 不接受"拍一个 N"：用户明确要求不以"拍脑壳"方式定参数；审计 13.1-6 也要求"用数据再决定"。

---

## 8. 块 2：模式与切换协议

### 8.1 三种模式的 Profile 预设

| 项 | REACT（默认） | PLAN | REFLECT |
|---|---|---|---|
| 触发 | 一切任务的起点 | 建议确认 / 用户显式 / 信号命中 | **守卫命中**（④/⑤/③）+ 有外部信号 / 用户显式 |
| 提示词 | 现状 `prompt.mjs` | `modeDirective('plan')` | `modeDirective('reflect')` |
| 控制流约束 | 无 | ①首轮后强制计划 ②`afterTurn` 对照计划项 ③`afterToolBatch` 一次廉价 replan | ①强制收尾前一轮反思 ②`attempts ≤ N` 固定轮数 |
| 退出 | 自然收尾 | 计划项全完 / 用户接管 | attempts 耗尽 → 升级人工 |
| 外部信号要求 | — | — | **硬约束**：无 `doneWhen`/工具失败证据时不进入（见 §4 与 §9.4） |
| 预算 | 现状 | 现状 + 1 次 replan 判定/轮 | 现状 + 2 次/轮，`attempts ≤ 2` 默认 |

**Plan 的计划表示**：直接用 `TodoWrite`（不新建数据结构）。依据：`compact.mjs:308` 已把它当权威清单提取；Claude Code 的 todo 是 no-op 但有效（上下文工程）；Manus 的 `todo.md` 是注意力机制。**复述即抗漂移**。

### 8.2 切换协议（吃下审计 13.1-4"不裸切"）

审计四步 = 摘要 → 共享记忆 → 计量保留 → warm-up：

| 步 | 落实 | 依据 |
|---|---|---|
| ①摘要 | 轮末切换时用**已有压缩器状态**（`compactor.lastSummary()`，`spawnSubAgent` 已在用 `engine.mjs:2032`），把当前计划/反思摘要注入请求面尾部 | 复用 `withAnchorTail` 式注入，不改前缀缓存 |
| ②共享记忆 | 计划/反思**落 `store`（TodoWrite 或 meta）**，不放临时变量 | `TodoWrite` 已在 transcript；meta 用 `appendMeta` |
| ③计量保留 | **天然满足**：`usage`/`turnStats` 跨轮累计（`engine.mjs:2386`） | 审计已确认 |
| ④warm-up | 切换后**不立即执行**——插入显式"模式生效"注入（说明新模式要求） | 避免"切了但模型不知道" |

**切换边界**：**仅轮末**（`cli.mjs:1322 loop.onTurnEnd`）+ 迭代头。**不打断进行中的一轮**（D2）。

**不裸切的硬要求**：禁止在无摘要/无注入说明的情况下改 `profile`——否则模式切换等价于"守卫静默失效"，是最难排查的 bug 类型（见 §8.5）。

### 8.3 切换权与建议流程（D1/D2/D6）

```
t=0（任务开始）
 ├ 用户显式指定模式/方法论 → 直接生效（最高优先级）
 ├ 高置信特征命中（任务类型规则匹配 / skill-workflow 自动匹配 / 前序残留 todo）
 │   → wire.system('loop_mode_suggested', {mode, reason, confidence, signals}) + GUI 建议卡
 │   → 用户一键确认才切（Cursor 形态，零额外 LLM 成本）
 └ 其他 → REACT，不打扰

t=1（首轮探索后）
 └ 观测信号命中阈值（§7.3，且已过观测期）
     → 同样走"建议 → 确认"（不在 t=1 静默自动切）

轮末（执行中）
 └ LLM 自主切换请求：仅当**守卫命中**（④/⑤/③/⑥）→ 允许自动切（D2）
     → 必须落 meta + wire（全程留痕）
```

**用户显式优先级**：`explicit > 自动切换`。用户手动指定后，**LLM 不得自动切走**（D1）。

### 8.4 留痕与事件面

| 事件 | 时机 | 字段 |
|---|---|---|
| `wire.system('loop_mode_suggested')` | 建议产生 | `{mode, reason, confidence, signals}` |
| `wire.system('loop_mode_updated')` | 切换生效 | `{from, to, reason, source: 'user'\|'llm-signal'\|'guard', at}` |
| `wire.system('loop_mode_rejected')` | 用户拒绝 / 非法值 | `{reason, value, fallback}` |
| `wire.system('methodology_applied')` | 方法论生效 | `{id, gates, guards, source}` |
| `appendMeta('loop_mode_switched' \| 'methodology_applied')` | 同上（可审计时间线） | 同 + `seq` |

**照抄既有范式**：`reasoning_effort`（`cli.mjs:1538-1559`）与 `approval_mode`（`cli.mjs:1565-1571`）的"热切 + 校验 + meta + wire"四件套已验证可用；并**补上审计 13.1-3 指出的 reason 缺失**。

### 8.5 必须显式定义的语义（否则出隐蔽 bug）

| 语义 | 决策 | 理由 |
|---|---|---|
| 切换时守卫计数器保留还是清零？ | **保留** | 清零 = 切换变成"守卫预算重置"，可被反复利用来规避熔断（`REPEAT_HEAL_MAX` 默认 `-1` 持久自愈下尤其危险） |
| `attemptMaxTokens` 是否重置？ | **保留** | 它是溢出自愈的产物，与模式无关 |
| 计划项未完成时切走怎么办？ | **保留计划 + 注入说明** | 计划在 transcript（TodoWrite）天然保留；须注入"计划仍在，请继续" |
| 自动切换频率上限？ | **每轮至多一次**（照 `guardInjections` 上限范式） | 防"模式抖动" |
| 用户显式指定后 LLM 能否切走？ | **不能** | D1 |

---

## 9. 块 5：方法论编译（下沉）★ 核心新增

### 9.1 问题陈述（用可量化的技术语言）

**现状机制**：`Skill` 工具把 SKILL.md **全文**注入上下文，靠模型读完后自觉执行。

```js
// kernel/tools.mjs:1120-1145（Skill 工具）
const content = loadSkillContent({ roots: skillLoadRoots, id, flatRoots: flatSkillRootsArg })
return { content: `技能「${id}」已加载，严格按以下指引执行：\n\n${content}`, isError: false }
```

**量化成本**（实测文件体量）：

| 方法论 | SKILL.md 体量 | 估算 tokens |
|---|---|---|
| subagent-driven-development | 28170 B | ~7000 |
| brainstorming | 10137 B | ~2500 |
| systematic-debugging | 9561 B | ~2400 |
| test-driven-development | 9067 B | ~2300 |
| writing-plans | 6974 B | ~1750 |
| verification-before-completion | 3646 B | ~900 |
| using-superpowers | 3157 B | ~800 |
| executing-plans | 2364 B | ~600 |
| **合计** | **~83 KB** | **~20.6K tokens** |

**一个典型开发任务**若按现状加载 TDD + verification + subagent-driven + writing-plans + executing-plans ≈ **14.5K tokens**，且这些 tokens 在**每一轮**都要重复计费（在上下文里）。

**更深的问题（非成本）**：这些方法论里的**硬规则靠提示词约束不可靠**——证据是清单本身：

> `verification-before-completion` 列出 **8 条** Rationalization Prevention（"Should work now" → RUN the verification / "I'm confident" → Confidence ≠ evidence / "I'm tired" → Exhaustion ≠ excuse …）
> `using-superpowers` 列出 **12 条** Red Flags（"This is just a simple question" → Questions are tasks …）
> `subagent-driven-development` 有 `## Common Rationalizations` 节

**一个由引擎强制的规则，不需要列举 20 条"你会怎么给自己找借口"。** 这些表格的存在本身就是"靠自觉执行不可靠"的自我承认。

### 9.2 方法论的可编译性证据

superpowers 方法论族的标题骨架（实测提取）呈现**高度一致的四段结构**：

```
## The Iron Law / Core principle      ← 硬规则        → guards（引擎断言）
## The Process / The N Phases         ← 阶段序列      → phases（状态机）
## When to Use / When NOT to Use      ← 适用判据      → when（规则匹配）
## Red Flags / Common Rationalizations ← 劝阻清单     → 若 guards 生效则可删
```

| 方法论 | Iron Law / 核心 | Process / 阶段 | 可编译性 |
|---|---|---|---|
| `verification-before-completion` | "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" | Gate Function 5 步（IDENTIFY→RUN→READ→VERIFY→CLAIM） | **极高**：信号+动作都明确 |
| `test-driven-development` | "Iron Law" | RED → Verify RED → GREEN → Verify GREEN → REFACTOR | **高**：阶段机 + 门控 |
| `systematic-debugging` | "Iron Law" | Four Phases: Root Cause → Pattern Analysis → Hypothesis and Testing → Implementation | **高**：阶段机 |
| `brainstorming` | **HARD-GATE**："Do NOT invoke any implementation skill, write any code… until you have presented a design and the user has approved it" | Checklist 9 步 | **极高**：门控可复用 `awaiting_approval` |
| `subagent-driven-development` | "Fresh subagent per task + task review + broad final review" | The Task Loop 5 步（Dispatch → Handle report → Review → Fix loop → Complete） | **极高**：完整状态机 |
| `writing-plans` | — | Scope Check → File Structure → Task Right-Sizing → Bite-Sized Granularity → No Placeholders | **高**：产出物结构可校验 |
| `executing-plans` | — | Step 1 Load → Step 2 Execute → Step 3 Complete | **高**：阶段机 |
| `using-superpowers` | "IF A SKILL APPLIES, YOU MUST USE IT" | Skill Priority 规则 | **高**：可下沉为引擎路由 |
| `dispatching-parallel-agents` | — | Identify Domains → Focused Tasks → Dispatch Parallel → Review and Integrate | **高**：并发编排 |
| `requesting/receiving-code-review` | — | When to Request / How to Request | **高**：钩子 |

**`subagent-driven-development` 的状态机细节**（可直接编译，实测骨架）：

| 环节 | 内容 | 可程序化表达 |
|---|---|---|
| Dispatch implementer | 显式指定 model（mechanical→cheap / integration→standard / architecture→capable） | ✅ 模型选择规则 |
| Handle report | 状态枚举 `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED` | ✅ **状态机分支** |
| Review the task | 用 `scripts/review-package PLAN_FILE BASE HEAD` 生成审查包 | ✅ 命令固定 |
| Fix loop | Rounds 1-3 resume 原 implementer；Rounds 4-5 换更强模型 | ✅ **升级规则** |
| Breaker | round 5 仍有 open findings → 停 | ✅ **上限** |
| Ledger | 每轮 append 到 ledger | ✅ 记账 |
| Final Review | 收尾前广度审查 | ✅ 阶段 |

→ **这是一台完整的、可编译的状态机**，而不是"提示词建议"。它当前以 **28 KB / ~7000 tokens** 的形式每轮占着上下文。

### 9.3 编译产物：`MethodologySpec`

```js
// kernel/methodology.mjs —— 声明式方法论（可由 SKILL.md 编译，也可手写）
/** @typedef {object} MethodologySpec */
export const VERIFICATION_BEFORE_COMPLETION = {
  id: 'verification-before-completion',
  when: { taskTypes: ['*'] },                       // 全任务适用
  guards: [{
    id: 'verify-before-claim',
    // 违规信号：文本含完成/成功表述，且本任务内无验证类工具调用
    detect: (state) => hasCompletionClaim(state.textBuf) && !state.sawVerificationCall,
    // 修复动作明确（非"再想想"）
    heal: '你声称完成/通过，但本任务内没有运行验证命令。请先实际执行验证命令并查看输出，再下结论。',
    // 误判方向（宁漏勿滥）：仅在"完成表述"命中时触发
    budget: { maxInjections: 2 },
  }],
}

export const TDD = {
  id: 'test-driven-development',
  when: { taskTypes: ['feature', 'bugfix'], excludePatterns: [/改(文档|配置|注释)/, /rename/i] },
  gates: [{ id: 'red-first', before: 'Write:impl', require: 'sawFailingTest', heal: '先写失败测试并运行看它失败（RED），再写实现。' }],
  phases: ['RED', 'VERIFY_RED', 'GREEN', 'VERIFY_GREEN', 'REFACTOR'],
}

export const SUBAGENT_DRIVEN = {
  id: 'subagent-driven-development',
  when: { taskTypes: ['feature', 'refactor'], minPlanItems: 2 },
  phases: ['DISPATCH', 'HANDLE_REPORT', 'REVIEW', 'FIX_LOOP', 'COMPLETE', 'FINAL_REVIEW'],
  budget: { fixLoopMaxRounds: 5, escalateModelAtRound: 4 },
  hooks: {
    afterToolBatch: 'dispatch-progress-check',   // 计划 N 项 vs 已派 M 个
    afterTurn: 'task-loop-advance',
  },
}
```

### 9.4 三层加载策略（省 token 的核心）

| 层 | 内容 | 成本 | 何时用 |
|---|---|---|---|
| **L0** 元数据 | 技能名 + description | ~50 tokens × N（已在提示词） | 恒在，用于路由 |
| **L1** 骨架 | `MethodologySpec`（编译产物） | **0 tokens**（引擎内，不进 LLM 上下文） | 常态——方法论由引擎强制 |
| **L2** 细则 | SKILL.md 全文 | 按需（~0.6K–7K tokens） | **仅在需要语义细节时**（如"如何写好计划的粒度"） |

**收益**：常态下方法论成本从 **14.5K → 0**；只在明确需要细则时加载 L2。

**且这不损失能力**：L1 保证"流程不会走偏"（引擎强制），L2 提供"怎么做得更好"（语义指导）。

### 9.5 可下沉性四维判据（不拿"无先例"当理由）

| 判据 | 问题 | 通过条件 |
|---|---|---|
| **C1 可观测性** | 引擎能否客观检测"违反了"？ | 信号在生成文本/工具调用/状态里可判定，不依赖语义理解 |
| **C2 误判对称性** | 误判与漏检的代价是否都可控？ | 可设"宁漏勿滥"（参照 `isPlanTail` 的既有取舍） |
| **C3 修复明确性** | 检测到后能否给出明确动作？ | 能（如"先运行验证命令"）而非空泛提示（"再检查一下"） |
| **C4 成本量级** | 检测开销？ | 0 token（纯结构判据），不随会话数线性增长 |

**逐项评估结果**：

| 方法论 | C1 | C2 | C3 | C4 | 判定 |
|---|---|---|---|---|---|
| `verification-before-completion` | ✅ 完成表述 + 无验证调用 | ✅ | ✅ "运行验证命令" | ✅ 0 | **下沉** |
| `subagent-driven-development` | ✅ 计划项 vs 派发数；审查缺失 | ✅ | ✅ 状态机分支固定 | ✅ 0 | **下沉** |
| `brainstorming`（HARD-GATE） | ✅ 设计阶段出现 Write 实现 | ✅ | ✅ "先出设计并获批" | ✅ 0 | **下沉**（门控） |
| `test-driven-development` | ✅ 实现先于失败测试 | ⚠️ 需任务类型前置 | ✅ "先写失败测试" | ✅ 0 | **下沉**（带 `when` 条件） |
| `systematic-debugging` | ✅ 改码前无读取/复现 | ✅ | ✅ "先复现并定位根因" | ✅ 0 | **下沉**（Reflect 核心） |
| `using-superpowers`（路由） | ✅ 任务类型特征 | ✅ | ✅ 建议+确认 | ✅ 0 | **下沉**（引擎路由） |
| `writing-plans` / `executing-plans` | ✅ 计划结构可校验 | ✅ | ✅ | ✅ 0 | **下沉**（Plan 模式） |
| `dispatching-parallel-agents` | ✅ 领域独立性 | ⚠️ | ✅ | ✅ 0 | **下沉为并发闸**（块 3） |
| `requesting/receiving-code-review` | ✅ 审查缺失 | ✅ | ✅ | ✅ 0 | **下沉为钩子**（块 4） |
| `## Red Flags` / `Rationalizations` 表 | ❌ 靠语言劝阻 | — | — | — | **不下沉，但 guards 生效后可不再加载** |
| `## Visual Companion` 等操作细节 | ❌ 需人机交互上下文 | — | — | — | **保留 L2**（按需加载） |

### 9.6 编译来源：SKILL.md → MethodologySpec

**两种方式**（建议先手写、后编译）：

| 方式 | 说明 | 何时用 |
|---|---|---|
| **①手写 spec**（阶段一） | 在 `kernel/methodology.mjs` 内声明（如 §9.3） | 首批 4-6 个方法论，可控、可逐步验证 |
| **②编译 frontmatter**（阶段二） | 在 SKILL.md frontmatter 增 `methodology:` 块，启动时/构建时解析 | 方法论文集化后 |

**②的 frontmatter 形态草案**：

```yaml
---
name: verification-before-completion
description: ...
methodology:
  when: { taskTypes: ["*"] }
  guards:
    - id: verify-before-claim
      detect: completion-claim-without-verification   # 具名判据（引擎内置库）
      heal: "你声称完成/通过，但本任务内没有运行验证命令。请先实际执行验证命令并查看输出，再下结论。"
      budget: { maxInjections: 2 }
---
```

**关键约束**：`detect` **不引入任意代码执行**（安全性）——只允许引用**引擎内置的具名判据库**（`completion-claim-without-verification` / `impl-before-failing-test` / `plan-items-unadvanced` 等）。这样 frontmatter 是**纯声明**，无注入风险。

### 9.7 与块 2（模式）的关系

**模式 = 方法论的组合**（§5.1）：

| 模式 | = 方法论组合 |
|---|---|
| REACT | `[]`（仅全局横切：verify-before-claim） |
| PLAN | `[writing-plans, executing-plans, subagent-driven]` |
| REFLECT | `[systematic-debugging]` + 全局 `verify-before-claim` |

→ **块 2 与块 5 共用 `LoopProfile` + `phaseHooks`**，无重复机制。这也是分块上把二者并列在一期的原因。

### 9.8 首批下沉范围（建议 4 个，按性价比）

| 优先 | 方法论 | 理由 | 省 token |
|---|---|---|---|
| 1 | `verification-before-completion` | 判据最明确、动作最硬、全任务适用；且已有 `loop-verify.mjs` 基础 | ~900 |
| 2 | `using-superpowers`（路由部分） | 纯规则，零成本，且是"该用哪个方法论"的入口 | ~800 |
| 3 | `subagent-driven-development` | 体量最大、最能省；状态机最完整（块 3 的基础） | ~7000 |
| 4 | `brainstorming` 的 HARD-GATE | 最硬的约束，复用 `awaiting_approval` 可低成本实现 | ~2500（部分） |
| 5（备选） | `systematic-debugging` | 作为 REFLECT 模式的核心 | ~2400 |

**首批合计节省**：约 **11–13K tokens/任务**（且每轮重复计费的部分一并消失）。

### 9.9 风险与缓解

| 风险 | 缓解 |
|---|---|
| 判据误伤（如把"已完成"的**叙述**当"声称完成"） | 参照 `isPlanTail` 的既有取舍：**宁漏勿滥**；`PLAN_TAIL_DONE_RE` 已有完成语词表可复用；为每个判据补**误伤对照用例** |
| 引擎强制过强，阻断正常流程 | 所有 gate/guard **可配 + 可关**（`PONOS_METHODOLOGY=off`）；门控只**注入自愈**、不硬 veto（与既有守卫家族语义一致） |
| 方法论编译与 SKILL.md 版本漂移 | 阶段一手写 spec 与 SKILL.md 并存，spec 记 `sourceVersion`；漂移检查进 CI（`verifySkillVersions` 已有基础） |
| L1 生效但 L2 未加载导致"知其然不知其所以然" | 保留"需要时可加载 L2"的通道（模型仍可调 `Skill`）；且 L1 的 `heal` 文案本身给出可执行动作 |
| 首批 4 个下沉后效果不达预期 | 观测层（§7）记录 `methodology_applied` 与守卫命中，可量化"注入次数/成功率"；不达预期可回退为纯提示词 |

### 9.10 为什么这比"让模型读更多提示词"更高效（技术论证）

| 维度 | 提示词约束 | 引擎约束（下沉） |
|---|---|---|
| 遵守率 | 依赖模型自觉（清单越长的规则越易失守——见 20 条 Rationalizations） | **强制**（不依赖模型意愿） |
| 成本 | 每轮重复计费（上下文常驻） | **0**（引擎内，不进上下文） |
| 跨模型鲁棒性 | 弱模型易失守（`prompt.mjs` lean 档即为弱模型而设） | 与模型能力无关 |
| 可观测性 | 无法统计"是否遵守" | 可统计（命中/注入/成功率） |
| lean 档收益 | lean 档必须删掉（否则上下文爆） | **lean 档无需删**（本就在引擎里） |

**最后一行是关键**：`prompt.mjs:45-46` 说"只删有引擎守卫兜底的细则"——**下沉得越多，lean 档能删得越多，弱模型的可用性越高**。

---

## 10. 块 3：子 Agent 三闸 + 深度闸 + 人工闸门（详细）

### 10.1 现状缺口（逐项核实）

| 缺口 | 证据 |
|---|---|
| 只有**全局**停用，无任务级/会话级软开关 | `disabled.mjs`（语义 = 不进提示词 / 不在 Task 子 agent 表） |
| **无深度闸** | `engine.mjs:2013` 的 `depth` 只入血缘，注释标"S4 预留"，无上限检查 |
| 无"派发前人工批准"闸门 | `approval-mode.mjs` 的 `agent: 'loose'` 是**工具级**放行，非"每次派发问一次" |
| 无 per-agent 步数/token/成本预算 | 审计 12.1-5 |
| 独立超时非独立配置 | 审计 12.1-5 |
| 已有并发闸 | `engine-config.mjs` `LANE_MAX_CONCURRENT`；`shared/subagent-concurrency.mjs`（`MAX_SUBAGENTS_CAP=32`） |

### 10.2 设计：五个正交闸

| 闸 | 语义 | 取值参考 | 落点 |
|---|---|---|---|
| ①工具级白名单 | 不给 `Agent`/`Task` 工具 = 彻底关 | 列表省略=继承全部；列表=白名单 | 复用 `CHAT_MODE_DISALLOWED` 同构（`tools.mjs:722`） |
| ②并发上限 | 前台+后台共用预算，超限**报错并告知模型不要重试** | 已有 `MAX_SUBAGENTS_CAP=32`；Claude Code 默认 20 | 已有 |
| ③**深度闸（新增）** | 到上限**收回 Agent 工具**（非运行时报错） | 默认 3；`1`=关嵌套 | `LoopCtx.lane.depth`（已存在） |
| ④**人工闸门（新增）** | 暂停-恢复式：派发前挂起 → 主会话批/拒 | — | 接 `loop.mjs` 已有 `awaiting_approval` 短路位 |
| ⑤**per-agent 预算（新增）** | `maxSteps` / `maxTokens` / `maxCostUsd` / `timeoutMs` | 按 agent 分档 | `agents.mjs` frontmatter + laneOptions |

### 10.3 关键取舍

| 取舍 | 决策 | 理由 |
|---|---|---|
| 深度到限：**收回工具** vs 运行时报错 | **收回工具** | 报错会让模型反复重试；已有前车之鉴（并发超限文案明确写"不要重试"） |
| 人工闸门：**暂停-恢复** vs 运行时拒绝 | **暂停-恢复** | 拒绝会让模型换参数重试；暂停把决策权交人 |
| 闸门粒度 | **三闸正交**（白名单/并发/深度各管一事） | 单一闸做多件事会导致语义含混（现有 `disabled.mjs` 的注释已在澄清语义边界） |
| 复用 vs 新建审批链路 | **复用 `awaiting_approval`** | 不新增第二条审批链路（避免语义分叉） |

### 10.4 前端配置面（用户自定义，D3 延伸）

```yaml
# agent frontmatter 扩展（kernel/agents.mjs 解析）
---
name: implementer
description: ...
maxSteps: 40
maxTokens: 200000
timeoutMs: 600000
requiresApproval: false        # ④ 人工闸门（该 agent 每次派发是否需批）
spawnDepthLimit: 1             # ③ 该 agent 能否再派子代理
---
```

**用户可见开关**（会话级/项目级）：
- 全局：允许派子 Agent（关 = 白名单为空）
- 并发：`N`（默认按现有 cap）
- 深度：`1`（关嵌套）/ `2` / `3`（默认）
- 每次派发需批准：开/关

---

## 11. 块 4：MAGI（详细）

### 11.1 设计

```
用户显式开启 MAGI（默认关）
  ├ 评审 A：事实/来源正确性（数据是否有出处、断言是否被证据支持）
  ├ 评审 B：方案/风险（是否有更简方案、副作用、边界）
  └ 评审 C：覆盖/完整性（需求是否全覆盖、验收是否可验）  ← 三维度正交，非人格
       ↓ 各自只读（复用 reviewer 的 disallowedTools 只读语义，agents.mjs:69）
  主席裁决（1 次调用）：输入三份问题清单 → 输出合并清单 + 严重度 + 去重
  → 拒绝"三份评分取平均"
```

### 11.2 关键决策

| 项 | 决策 | 依据 |
|---|---|---|
| 视角 | **正交审查维度，非 persona** | Claude Code agent-teams 要求 "distinct lens so they don't overlap" |
| 汇总 | **1 次主席裁决**（合并问题清单 + 严重度 + 去重） | Anthropic 实测："a single LLM call with a single prompt outputting scores… 最一致、最贴合人类判断" |
| 调用数 | **3 + 1 = 4 次**（写死上限） | Claude Code："3–5 个 teammate，收益递减" |
| 触发 | 显式开启；高风险**建议**不自动 | D3 |
| 高风险特征 | 改动面大 / 涉金 / 不可逆 | 复用 `kernel/highrisk.mjs:12` 导出的 `matchesHighRisk`（源头 `shared/high-risk.mjs` 的 `matchesApprovalTrigger`，已核实） |
| 模型选择 | 三评审**同模型**（不追求异族） | `2026-09-19-reviewer-cross-model.md` 本地 n=3 实测：异族 81% < 现状 100%，且漏必崩缺陷 |
| 汇总输出 | 一份合并清单 | 非三份并列（用户要看结论不是看三份报告） |

### 11.3 与"多评审≈浪费"证据的关系（设计如何规避）

外部实证显示多评审收益**条件性**：

| 证据 | 对本设计的要求 |
|---|---|
| MAD benchmark：多 agent 辩论"**do not reliably outperform** self-consistency and ensembling"，且对超参极敏感 | 不做辩论（不做多轮互相说服）——本设计是**并行独立评审 + 一次裁决**，比辩论便宜且对超参不敏感 |
| Anthropic：单判官比多判官更一致 | **汇总用 1 次调用**，而非多判官平均 |
| 辩论在**有明确正确答案的裁决任务**上有效（48%→76%、60%→88%） | MAGI 定位为**裁决型**（找问题、判对错），不做开放式"好不好"评价 |
| PoLL：异构小模型陪审团成本低 7 倍 | 可选优化方向（若效果达标可换小模型 trio 降本），**但本地实测支持"当前模型族"**，故先不换 |
| Claude Code：token 成本**线性增长** + 收益递减 | 写死 4 次调用；默认关 |

### 11.4 审查产出结构（统一格式，便于主席裁决）

```json
{
  "reviewer": "facts|risk|coverage",
  "findings": [
    { "id": "F1", "severity": "critical|major|minor", "claim": "…", "evidence": "文件:行 或 引用", "suggestedFix": "…" }
  ],
  "confidence": 0.0-1.0
}
```

**要求**：每条 finding 必须带 `evidence`（文件:行 或 明确引用）——**无证据的发现降级为 observation**，这与 `verification-before-completion` 的"evidence before claims"一致，也契合本仓库审计文化。

---

## 12. 实现顺序

### 12.1 一期（块 1 + 块 2 + 块 5；**含注入层统一增量 S1+/S3.5/S4.5/S9.5**）

| 步 | 内容 | 判据 |
|---|---|---|
| S1 | 观测层 O1/O2/O3（**先做**，纯增量、零风险） | 新字段出现在 turnStats / meta；测试覆盖 |
| **S1+** | **O4 注入总账**（`inject_snapshot` + legacy 侧记账 + prompt 分段**只读**计量） | `inject_snapshot` 字段齐备且 legacy 非空；A13 | 
| S2 | B1 契约抽取：守卫序参数化 | L1/L2/L3 回归锁全绿，**零行为变更** |
| S3 | B1 契约应用到 lane（复用同一 `runOnce`） | lane 测试全绿；可共享逻辑只有一份 |
| **S3.5** | **注入总线抽取**（`kernel/inject-bus.mjs`；12 处指令注入改走 `ctx.emitInjection`） | A17a/A17b 双重等价（含 `LOOP_GUARD=0` 对照）+ 主 spec L1 全绿 |
| S4 | `kernel/loop-mode.mjs` + `kernel/methodology.mjs`（纯函数 + 单测） | 模式/方法论定义、判据、切换校验单测覆盖 |
| **S4.5** | **经验三层化 + 线索层**（去重 / `front.active` / 字节口径 / `knowledge-recommend.mjs` / EL1↔unified 互斥） | A12/A14/A16/A18/A20；新增 `knowledge-recommend.test.mjs` |
| S5 | **首批下沉：`verification-before-completion`**（性价比最高） | 有测试：声称完成而无验证调用 → 注入自愈；误伤对照通过 |
| S6 | **下沉：`using-superpowers` 路由**（t=0 规则匹配 + 建议） | 建议准确率可观测；用户拒绝后不自动切 |
| S7 | Plan 模式（= `writing-plans`+`executing-plans`+`subagent-driven` 编译产物） | 端到端：复杂任务进入 Plan 后产出计划且逐项推进 |
| S8 | **下沉：`subagent-driven-development` 状态机** | 端到端：逐任务派发 + 每任务审查 + fix loop 上限 |
| S9 | Reflect 模式（= `systematic-debugging` 编译产物 + 外部信号硬约束） | 端到端：验证失败时反思并改写下一步；**无信号时不进入** |
| **S9.5** | **下沉第 5 项 `experience-sediment`**（判据 `reusable-finding-unrecorded` + `recommend-ignored`） | 本步只发 wire/落账，阈值随 S12 转正（**不得硬编码**，A10） |
| S10 | 切换协议 + GUI 建议卡 + 模式徽标 | 留痕完整；用户拒绝后不自动切 |
| S11 | **下沉：`brainstorming` HARD-GATE**（门控） | 设计阶段出现实现代码 → 门控生效 |
| S12 | 观测期收数据 → 定默认阈值 | 阈值有数据依据，附录记录 |

### 12.2 二期（块 3 + 块 4）

| 步 | 内容 | 判据 |
|---|---|---|
| S13 | 子 Agent 三闸（白名单/并发/深度） | 各自可关可限；深度到限收回工具 |
| S14 | 人工闸门（暂停-恢复，复用 `awaiting_approval`） | 批准/拒绝均生效 |
| S15 | per-agent 预算 | frontmatter 字段生效；超限有明确语义 |
| S16 | MAGI 三评审 + 主席裁决 | 默认关；开启时 4 次调用；输出合并清单 |

---

## 13. 明确不做（含技术理由，不用"无先例"）

| 不做 | 技术理由 |
|---|---|
| ❌ t=0 的**复杂度**分类器 | 复杂度是连续量且 t=0 信息不足（用户已指出）；误判方向代价不对称（判浅→后期返工，不可逆）。**改为任务类型匹配**（离散、特征明确、误判可纠正） |
| ❌ 自动路由框架（`TaskProfile`/`can_handle` 评分/历史成功率回填） | 成本随会话数线性增长；且评分路由的误判同样不可逆。审计 13.1-2/13.1-6 亦判定不建议 |
| ❌ 13.5 融合投票（同请求多策略并跑） | 成本×策略数；无收益证据。审计 13.1-6 |
| ❌ 无外部信号时开 Reflection | TACL 2024：无外部反馈时自纠**不成立**；ICLR 2024：**可能变差**；arXiv 2310.12397：批评正确性与表现无关。**技术理由：无真值信号时"自省"是空转，只增成本** |
| ❌ MAGI 三份评分取平均 | Anthropic 实测：单次调用单 prompt 更一致。**技术理由：平均会稀释强信号，且增加一次聚合的不确定性** |
| ❌ MAGI 多轮辩论 | MAD benchmark：辩论不优于 self-consistency/ensembling，且对超参极敏感。**技术理由：辩论轮数×评审数 = 成本平方增长** |
| ❌ Plan 设为默认模式 | 默认模式的成本应最低（多数任务无需规划）；且 lean 档无规划提示词基础（§15） |
| ❌ 为 MAGI 追求异族模型 | 本地 n=3 实测：异族 81% vs 现状 100%，漏必崩缺陷。**技术理由：当前证据不支持换模型，且换模型引入额外不确定性** |
| ❌ 强行统一主循环与 lane 的 250 行刻意差异 | §3.2：那是设计意图（lane 无 health/锚点/完整压缩），统一会引入不该有的依赖 |
| ❌ 模式切换清零守卫计数器 | §8.5：会变成"守卫预算重置"，可被反复利用规避熔断 |
| ❌ 在 frontmatter 里放可执行代码（`detect` 任意表达式） | §9.6：引入注入风险。**只允许引用引擎内置具名判据库** |
| ❌ 一次性下沉全部方法论 | §9.8：先 4 个验证判据准确率，避免"大面积误伤"同时上线 |

---

## 14. 验收标准

### 14.1 一期

| # | 标准 | 判据 |
|---|---|---|
| A1 | B1 零行为变更 | kernel-tests 全绿且数量不变；每个守卫的文案/事件/计数逐一不变 |
| A2 | 可共享逻辑一处实现 | 守卫检查组只有一份源码（`loop-core.mjs`），主循环与 lane 各传 profile |
| A3 | 三模式可选可切 | `REACT`/`PLAN`/`REFLECT` 可经参数/UI 指定并生效 |
| A4 | 切换留痕完整 | 每次切换有 wire 事件 + meta，含 `from/to/reason/source` |
| A5 | 用户显式优先 | 用户指定后 LLM 不得自动切走（有测试） |
| A6 | Reflection 不无信号启动 | 无 `doneWhen`/无工具失败证据时不进入 REFLECT（有测试） |
| A7 | 观测数据产出 | `turnToolDigest.size`、`turnStats.guard`、模式/方法论 meta 三者可读 |
| A8 | 阈值有数据依据 | 默认阈值来自观测期分布，附录记录取法 |
| A9 | **首批方法论下沉生效** | ≥4 个方法论（§9.8）的守卫/门控在无 SKILL.md 加载时仍生效（**有对照测试**） |
| A10 | **判据误伤受控** | 每个下沉判据有误伤对照用例；误伤率 ≤ 阈值（观测期定） |
| A11 | **成本可量化下降** | 同类任务的平均上下文 tokens 可对比（下沉前/后），且不明显反弹 |
| A12 | 经验索引**只注入一次** | 任务模式会话中 `【个人经验索引】` 出现次数 = 1（当前 = 2，5.1 KB/轮冗余） |
| A13 | 注入总账可归因 | 每轮 `inject_snapshot` 的 `channels`/`bySource` 字节和 = 实测提示词 + 派生注入（≤5% 误差，**同 tier/sessionMode 内比较**） |
| A14 | EL0/EL1 分层且 **EL1 不含正文** | EL0 ≤ 512 B 恒在；EL1 仅命中时出现且无 ` ·全文` 标记；`PONOS_MEMORY_EL1=0` 时 EL1 为空 |
| A15 | 单轮注入受**全局总预算**约束 | 各通道字节和 ≤ 派生自 `resolveInjectBudget()` 的总预算；超限按 priority 抽让渡并留痕 |
| A16 | 停用主题不再被注入 | GUI 停用主题 T → 内核 EL0/EL1 均不含 T（当前内核侧漏判 `front.active`） |
| A17a | 轮内注入等价（L4a） | 总线抽取前后：12 处注入文本 + wire 事件序列逐字节等价（4 处 `event:null` 如实保留） |
| A17b | 请求面派生注入等价（L4b） | `withAnchorTail` 注册为 `beforeRequest` 渲染器后，每次请求末条 user 派生结果等价、前缀不变 |
| A18 | 线索可展开且可采纳可测 | 前置 `knowledgeRelateMode==='on'`；线索 `blockId` 喂 `related` 必返非空；`offered/adopted/adoptRate` 可读；未授权空间不给 Read 指引 |
| A19 | 观察期不注入且**不产生假采纳率** | `OBSERVE_ONLY=true` 时无线索段，`offeredDryRun` 有值而 `adopted` 语义为"不适用"（**不得记 0**） |
| A20 | EL1 与 unified 抽调层**互斥** | `legacy` → 线索段存在；`unified` → 线索段不存在（防同一批知识块注入两遍） |

**全局注入护栏（跨块约束，G 系列 —— 防"越改越乱"）**

| # | 护栏 | 判据 |
|---|---|---|
| G1 | **零和预算** | 任何新增注入通道必须在既有总预算内**抽让渡**，不得为新通道加预算；确需加预算时须先有观测数据证明净收益 |
| G2 | **通道数不增** | 每条新通道必须声明它**替换/合并**了哪条既有路径；通道数净增即视为回归 |
| G3 | **常量注入净下降** | 一期结束时"每轮恒在注入字节"必须低于基线（当前经验侧 10262 B；S4.5 后目标 ≤ 1736 B），有实测数字 |
| G4 | **单账** | 同一事实只有一处采集（O4 为 O2/O3 的派生视图）；禁止同一现象两本账 |

### 14.2 二期

| # | 标准 | 判据 |
|---|---|---|
| E1 | 三闸可配 | 白名单/并发/深度各自可关可限，语义写进文档 |
| E2 | 深度到限**收回工具** | 不到上限时 `Agent` 工具存在，到上限时不在 schema 中（非报错） |
| E3 | 人工闸门可暂停恢复 | 派发前挂起 → 批准/拒绝均生效；复用 `awaiting_approval` |
| E4 | MAGI 默认关、4 次调用 | 未显式开启时零额外调用；开启后调用数 = 4（有测试） |
| E5 | MAGI 汇总为单次裁决 | 输出一份合并清单，非三份并列 |
| E6 | per-agent 预算生效 | `maxSteps`/`maxTokens`/`timeoutMs` 超限有明确语义（非静默） |

---

## 15. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| B1 重构触碰 engine 核心函数（2436 行文件） | **高** | 只做等价搬移、分守卫组提交、三重回归锁（§6.3）、可单独回滚 |
| 模式切换引入隐蔽 bug（守卫静默失效） | **中高** | §8.5 显式定义五条语义；"不裸切"硬要求（§8.2） |
| **方法论判据误伤正常流程** | **中高** | 宁漏勿滥（参照 `isPlanTail` 既有取舍）；每判据配误伤对照；可全局关（`PONOS_METHODOLOGY=off`）；先 4 个再扩 |
| Reflection 收益为负（文献已证） | **中** | 硬约束：只在有外部信号时开；固定轮数；默认关 |
| **lean 会话缺 Plan 模式的提示词基础（已核实为真）** | **中高** | `prompt.mjs:91`「复杂任务先规划：…先用 TodoWrite 建立任务清单」**只在非 lean 分支**（`changeFocus` 的 `: [ ... ]` 侧）；**lean 分支无此行**（lean 版 `changeFocus` 只有最小改动/收敛范围/禁止 Bash 三条，见 `prompt.mjs:86-88`）。→ Plan 模式在 lean 会话下**必须自行注入规划指令**（`modeDirective('plan')` 不能依赖既有提示词），且需在 lean 档做端到端验证 |
| 每次 replan 判定增加成本 | **中** | Plan 模式 +1 次/轮，需在观测期测收益/成本比再定默认 |
| 方法论编译与 SKILL.md 版本漂移 | **中** | spec 记 `sourceVersion`；漂移检查进 CI（`verifySkillVersions` 已有基础） |
| 下沉后 L2 细节缺失导致产出质量下降 | **中** | 保留 Skill 加载通道；L1 的 `heal` 文案给出可执行动作；观测质量指标（返工率） |
| GUI 改动面（建议卡 + 徽标 + 事件归约） | **低中** | 照 `SessionModeBar`/`EffortPicker` 范式（已存在），事件挂 `useYFWCLI.ts` 的 system 归约（`:1020+`） |
| 阈值拍脑袋 | **低**（已规避） | D7：先观测后定，附录留数据依据 |

---

## 16. 附录

### 16.1 代码事实（逐行核实，2026-09-20）

| 事实 | 位置 |
|---|---|
| 主循环 = 单策略 ReAct | `engine.mjs:248` `runTurnInternal`；迭代循环 `:476` |
| `turnToolDigest` 缺结果规模字段（**4 字段限制是既定设计**：`2026-09-12 spec §4.2` 要求"不复制结果正文（体积与隐私）"） | `engine.mjs:1031-1036`；注释 `:1024-1025`；原始 `content` 在同函数 `:1026` 已读 |
| `turnStats` 缺守卫字段 | `engine.mjs:2386` |
| lane 循环 = 整段镜像 | `engine.mjs:1505` `runSubAgentLoop`（约 350 行）；`:1502-1504` 注释"无健康（短会话）；无压缩器" |
| 守卫序（主） | 迭代头 ①②⑥（`:486/:495/:497`）→ 流内 ①b③③b+watchdog（`:620/:630/:643`）→ 流后 R3-2④⑥⑤（`:932/:1066/:1076/:1083`） |
| 轮边界切换落点 | `cli.mjs:1322` `loop.onTurnEnd` |
| **健壮性/方法论已下沉的 4 条** | `gen-guards.mjs`：`isPlanTail`(:22) / `isThinkOnly`(:34) / `detectGenerationRepeat`(:45) / `createNearRepeatDetector`(:82)；接入 `engine.mjs:962/970/981/1760/1773` |
| **lean 剪枝原则（下沉路径的官方表述）** | `prompt.mjs:45-46`："只删有引擎守卫兜底的细则" |
| **MILESTONE 标记 = 纯提示词约束（引擎不校验）** | `MILESTONE` 仅 5 处命中，全为解析/剥离：`api.mjs:56/81/197`（桥侧逐帧正则）、`compact.mjs:441`（压缩剥离） |
| TodoWrite 已是事实上的计划表示 | `compact.mjs:308` `extractKeyInfo`；`prompt.mjs:91`（**仅非 lean**） |
| 无深度闸 | `engine.mjs:2013` `depth` 只入血缘，注释标"S4 预留" |
| 子 Agent 仅全局停用 | `disabled.mjs` |
| 并发闸已有 | `engine-config.mjs` `LANE_MAX_CONCURRENT`；`shared/subagent-concurrency.mjs`（`MAX_SUBAGENTS_CAP=32`） |
| 热切四件套范式 | `cli.mjs:1538-1559`（effort）、`:1565-1571`（approval_mode） |
| 完成条件双层验证器 | `loop-verify.mjs:27` `verifyDoneWhen`（cmd 验真 + judge 判词，fail-closed）；调用点 `loop.mjs:12/31` |
| LLM 判词 | `engine.mjs:2255` `judgeUntil` |
| Skill 全文注入（成本源） | `tools.mjs:1120-1145`（`loadSkillContent` → 全文进上下文） |
| 高风险判据可复用 | `kernel/highrisk.mjs:12` `matchesHighRisk` ← `shared/high-risk.mjs` `matchesApprovalTrigger` |

### 16.2 方法论体量实测（下沉收益依据）

| 方法论 | 字节 | 行 | 估算 tokens |
|---|---|---|---|
| subagent-driven-development | 28170 | 508 | ~7000 |
| brainstorming | 10137 | 156 | ~2500 |
| systematic-debugging | 9561 | 289 | ~2400 |
| test-driven-development | 9067 | 324 | ~2300 |
| writing-plans | 6974 | 172 | ~1750 |
| verification-before-completion | 3646 | 120 | ~900 |
| using-superpowers | 3157 | 66 | ~800 |
| executing-plans | 2364 | 67 | ~600 |
| **合计** | **~83 KB** | ~1700 | **~20.6K** |

### 16.3 方法论骨架（可编译性实测）

```
verification-before-completion: The Iron Law → The Gate Function(5步) → Common Failures → Red Flags → Rationalization Prevention(8条)
test-driven-development:        The Iron Law → Red-Green-Refactor(RED/Verify RED/GREEN/Verify GREEN/REFACTOR/Repeat) → Good Tests
systematic-debugging:           The Iron Law → The Four Phases(Root Cause/Pattern Analysis/Hypothesis and Testing/Implementation) → Red Flags
brainstorming:                  Anti-Pattern → Checklist(9项) → Process Flow → The Process → After the Design（含 HARD-GATE）
subagent-driven-development:    Core principle → When to Use → The Process → Setup → Model Selection → The Task Loop(5步) → Final Review → Common Rationalizations
writing-plans:                  Scope Check → File Structure → Task Right-Sizing → Bite-Sized Granularity → Task Structure → No Placeholders
executing-plans:                Step 1 Load and Review → Step 2 Execute Tasks → Step 3 Complete Development → When to Stop
using-superpowers:              The Rule → Skill Priority → Red Flags(12条) → Platform Adaptation
dispatching-parallel-agents:    When to Use → The Pattern(4步) → Agent Prompt Structure → When NOT to Use
```

**共性**：`Iron Law`（断言）+ `Process/Phases`（状态机）+ `When to Use`（前置条件）+ `Red Flags`（劝阻）。
**前三个都是程序可表达的结构；第四个在 guards 生效后可不加载。**

### 16.4 既有审计（本仓库）

- `docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`：13.1-1(G1) / 13.1-2(G2) / 13.1-3(G1) / 13.1-4(G2) / 13.1-5(G1) / 13.1-6(**G0**) / 12.1-5(G1) / 2.1-4 / 2.2.4 / 2.1-5
- `docs/superpowers/audits/2026-09-19-reviewer-cross-model.md`：异族评审 n=3 实测（10.5/13 vs 13/13）
- `docs/superpowers/specs/2026-09-17-loop-redesign-phase1-reliability-design.md`：loop 四期总纲（Phase 2 = 语义能力升级，与本设计方向一致）
- `docs/superpowers/specs/2026-09-12-*.md`（§4.2 失真观测：turnToolDigest 的 4 字段约束来源）

### 16.5 外部来源（供实现参考；不作为"可行性"判据）

**官方工程博客 / 文档**
- Anthropic《Building effective agents》 https://www.anthropic.com/engineering/building-effective-agents
- Anthropic《How we built our multi-agent research system》 https://www.anthropic.com/engineering/built-multi-agent-research-system
- LangChain《Plan-and-Execute Agents》 https://blog.langchain.com/planning-agents/ ／《Reflection Agents》 https://blog.langchain.com/reflection-agents/ ／《Deep Agents》 https://blog.langchain.com/deep-agents/
- LangChain Deep Agents 文档 https://docs.langchain.com/oss/python/deepagents/overview ／Multi-agent 文档（含调用成本表） https://docs.langchain.com/oss/python/langchain/multi-agent
- Manus《Context Engineering for AI Agents》 https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Claude Code《Create custom subagents》 https://docs.claude.com/en/docs/claude-code/sub-agents ／《Orchestrate teams》 https://docs.claude.com/en/docs/claude-code/agent-teams
- OpenAI Agents SDK《Agent orchestration》 https://openai.github.io/openai-agents-python/multi_agent/ ／《Tools》 https://openai.github.io/openai-agents-python/tools/
- Cursor《Subagents》 https://cursor.com/docs/agent/subagents ／《Plan Mode》 https://cursor.com/docs/agent/planning
- GPT-5 router 引文与回滚事件 https://simonwillison.net/2025/Aug/7/gpt-5/ ／ https://simonwillison.net/2025/Aug/8/surprise-deprecation-of-gpt-4o/

**论文**
- Reflexion 2303.11366 ／ Self-Refine 2303.17651
- LLMs Cannot Self-Correct Reasoning Yet 2310.01798 ／ GPT-4 Doesn't Know It's Wrong 2310.12397 ／ When Can LLMs Actually Correct Their Own Mistakes (TACL 2024) 2406.01297
- Multiagent Debate 2305.14325 ／ Should we be going MAD? 2311.17371 ／ Debating with More Persuasive LLMs 2402.06782 ／ Replacing Judges with Juries (PoLL) 2404.18796 ／ ChatEval 2308.07201
- RouteLLM 2406.18665

**证据强度标注**：外部资料仅用于**实现参考与风险提示**；本设计的可行性判据见 §2.0（可观测性/误判对称性/修复明确性/成本量级）。
