# 注入层统一 · Loop v3 增量（经验 / 知识 / 方法论共用一条注入总线）

> **文档角色（2026-09-20 定案后调整）**：本文件 = **设计论证 + 评审留痕（Q1-Q21）**。
> **实施以主 spec 为准** —— 四步已并入 `2026-09-20-loop-mode-adaptive-design.md` §12.1（**S1+ / S3.5 / S4.5 / S9.5**），验收已并入其 §14.1（**A12-A20 + 全局注入护栏 G1-G4**），`ctx.emitInjection` 出口已并入其 §6.1/§6.2。
> **单一权威原则**：若本文件与主 spec 冲突，**以主 spec 为准**；本文件不再单独驱动实施，避免"两份权威"演变成新的混乱源。
>
> 状态：**路线已定 + 已过独立评审 + 已并入主 spec**
>
> **阅读地图（控制上下文消耗 —— 请按需取用，勿通读两份文件）**
>
> | 用途 | 只读这些 | 体量 |
> |---|---|---|
> | **实施 S1+/S3.5/S4.5/S9.5** | 主 spec §12.1（S 序列）+ §14.1（A12-A20、G1-G4）+ §6.1（`emitInjection` 契约）+ 本文件 **§3.2.1**（线索渲染契约 R1-R6）+ **§3.2.3**（采纳率两阶段）+ **§4.3**（净上下文核算） | ≈120 行 |
> | 需要知道"为什么要做" | 本文件 §1（耦合点）+ §1.4（实测数据）+ §2.4（注入点清单） | ≈90 行 |
> | **归档，实施时不必读** | 本文件 §4.1（步边界设计稿）、§9（**Q1-Q21 评审留痕**，过程记录） | ≈180 行 |
>
> 全文 637 行中约 180 行是**一次性的过程留痕**（评审发现与处置），其价值是"可追溯为什么这么定"，不是"实施时必读"。

> 日期：2026-09-20
> 主 spec：`docs/superpowers/specs/2026-09-20-loop-mode-adaptive-design.md`（下称"主 spec"，§x 均指该文件）
> 触发来源：经验系统 / 知识库"注入与调用"现状评估（同批次，实测数据见 §1.4）
> 基线：`kernel/prompt.mjs` / `kernel/cli.mjs` / `kernel/knowledge-inject.mjs` / `kernel/knowledge-search.mjs` / `kernel/memory.mjs` / `kernel/engine.mjs` / `kernel/engine-config.mjs` / `server/bridge.mjs` / `server/experience.mjs` / `shared/knowledge-core.mjs`

---

## 0. 一句话

主 spec 要把"方法论从提示词下沉为引擎约束"；本次评估得出的是同一条原理的另一半——**经验与知识应从"模型自觉检索"升级为"引擎按需供给"**。两者的执行动作是同一个：**往上下文里注入一段文本**。当前这个动作被散在 **5 条互不相干的通道**里（各自的预算口径、留痕方式都不同），而主 spec 还要再加 3 类。因此结论是：**能结合，但结合点不是"顺便改几个文件"，而是先把"注入"抽成一条总线**——它是主 spec §8.2（切换摘要）、§9（方法论门控自愈）落地前的**共用前置**。

**供给形态（D2 已拍板）**：引擎供给的**不是内容，而是线索**——只给"哪条相关、凭什么相关、还能往哪读"的指针，正文由 agent 自主决定去读（§3.2）。这样既把"引擎默认发现"做实（实测消费率 0.06%，靠提示词劝模型检索不成立），又不引入"误供内容污染上下文"的新风险。

---

## 1. 为什么这两件事是同一件事

### 1.1 耦合点 ①：主 spec §8.2 要复用的注入机制，当前只有一个用户

主 spec §8.2 步骤 ① 写：

> 「用**已有压缩器状态**……把当前计划/反思摘要注入请求面尾部 | 复用 `withAnchorTail` 式注入，不改前缀缓存」

该机制确实已存在（`kernel/engine-config.mjs:94` `withAnchorTail`，注释明写"把锚点并入请求面**尾部**（而非 system）：前缀字节不变，prompt cache 命中不受影响"），但当前**唯一调用点**是失真锚点（`kernel/engine.mjs:363`）。

与此同时，经验与知识的注入走的是**完全不同的两条路**：

| 内容 | 实际通道 | 位置 |
|---|---|---|
| 经验索引 + 沉积指令（GUI 侧） | `--append-system-prompt-file` → system 的 `append` 段 | `server/bridge.mjs:1607-1610`（resume）、`:1645-1648`（新会话）；落文件 `:1614`/`:1654` |
| 经验索引 + 抽调层（内核侧） | `composeSystemPrompt` 的 `memory` 段（system 静态） | `kernel/cli.mjs:1001-1011` 传 `memory: memoryBlock` |

→ 若不在主 spec 的 S 序列里先插入"注入总线"，§8.2 的摘要注入与 §9.3/§9.4 的门控自愈会各自再定义一遍"注入格式 + 预算 + 留痕"，**通道从 5 条涨到 8 条**。这是本增量最硬的结合理由。

### 1.2 耦合点 ②：主 spec §9.4 的三层加载，与经验供给是同一问题的两个实例

主 spec §9.4 的洞察是：方法论常态应以 **L1（引擎内声明式 spec，0 token）** 生效，L2（SKILL.md 全文）按需加载，收益 14.5K → 0。

经验索引的现状是**同一个病症**：42 行 / 5131 B 的"完整条目索引"（本质是 L2 内容）被当作 L0 恒在，塞进每一轮的 system。两者应共用同一套"层化 + 预算 + 抽让渡"机制（§3.2）。叠加去重后，单个任务每轮可省约 **8.5 KB**（≈2.5K tokens），与主 spec §9.8 首批下沉的 11–13K 相加，一期合计约 **20K tokens/任务**。

### 1.3 耦合点 ③：主 spec §7 的观测层缺"注入面"，导致 A11 不可归因

主 spec 的 A11 要求「成本可量化下降：同类任务的平均上下文 tokens 可对比」。但 §7 的 O1/O2/O3 只观测 `turnToolDigest.size` / `turnStats.guard` / 模式 meta——**没有任何字段回答"这轮的 system 里，哪一段占了多少字节"**。观测不到通道分布，A11 只能看总量，涨了也不知道是谁涨的。

注入侧其实**已经有半套观测**：`kernel/knowledge-inject.mjs:88` `persistMetrics` 落 `.index/metrics.json`。但有两个缺口：
1. **只覆盖 unified 路径**——实测生产 `strategy=legacy`，故 `recallBlocks=0`、`search=null`（legacy 的 `graph.search` 结果根本没进 metrics）；
2. 与主 spec 的 meta 留痕是**两套账**（一个落 sidecar JSON，一个落 transcript meta）。

→ 把注入观测并成**一张总账**（§3.3），是主 spec A11 与本次评估 P2 的共同解。且总账要新增一项特有指标：**线索采纳率**（§3.2.3）——它是"引擎推荐到底有没有用"的唯一客观答案。

### 1.4 实测数据（本批评估，可复算）

| 维度 | 实测 | 取证方式 |
|---|---|---|
| 经验索引（GUI 与内核两份实现） | 各 **5131 B / 42 行**，内容一致 ⇒ system prompt 中 `【个人经验索引】` 出现**两次** | 直接调用 `server/experience.mjs` 与 `kernel/memory.mjs` 的 build 函数比对字节 |
| 预算口径 | 两处用 `line.length`（**字符**）比 `maxBytes`；`knowledge-inject` 的 unified 路径用 `byteLen`（**字节**） | 中文 UTF-8 3 字节 ⇒ 4096 预算实占 5131 B（+25%） |
| 注入策略 | `strategy=legacy`、`queries=0`、`recallBlocks=0`、`search=null` ⇒ **块级抽调层从未生效** | `PONOS_HOME=… node kernel/cli.mjs --print --output-format stream-json --input-format stream-json --knowledge stats` |
| `active` 开关 | GUI 版过滤 `x.active`；`kernel/memory.mjs` 的 `buildMemoryIndex` **不读 `front.active`** ⇒ 停用主题仍被内核注入（当前 7 主题全 active，尚未显现） | 两处实现对照 |
| 索引规模 | 242 docs / 6999 blocks / 119007 grams / 17.8 MB；4 空间 | 同上 stats |
| 关联边 | 2260：tag 2122（94%）、content 138、ref 0 | 同上 |
| 消费率 | 578 份 transcript / 56044 次 `tool_use`：`KnowledgeSearch` 29、`MemorySearch` 5、`KnowledgeImport` 0；Read 命中 `knowledge/spaces/` **0 次** | `~/.yfw/projects/**/*.jsonl` 全量统计 |

> ⚠️ 取证命令必须带 `--print --output-format stream-json --input-format stream-json`，否则内核直接报 "only stream-json I/O format is supported" 而不执行 op。

---

## 2. 代码事实（逐行核实，2026-09-20）

### 2.1 现存 5 条注入通道

| # | 通道 | 实现 | 落 transcript | 现有用户 |
|---|---|---|---|---|
| ① | **system 静态块** | `kernel/prompt.mjs` `composeSystemPrompt`：base → 子 Agent → AGENTS.md → 技能与编排 → 可用技能 → 可用工作流 → 会话知识库 → `memory` → `append` → `可用工具` | 否 | 经验索引、知识范围、技能/工作流清单 |
| ② | **桥侧 append 文件** | `server/bridge.mjs:1614`/`:1654` `--append-system-prompt-file` → 内核 `readPromptFile` 进 ① 的 `append` | 否 | 沉积指令 + 经验索引（新会话/resume 两分支） |
| ③ | **守卫自愈注入（持久）** | `pushMemory({role:'user',content})` + `session.appendUser(inject)` + `wire.system('guard_heal', …)`，`kernel/engine.mjs:507/690/729/909/1118` | **是** | 守卫①②③③b④⑤⑥ 自愈 |
| ④ | **请求面尾部派生注入** | `kernel/engine-config.mjs:94` `withAnchorTail`（末条 user 并入，前缀字节不变）；调用点 `engine.mjs:363` | 否（纯派生） | 仅失真锚点 |
| ⑤ | **轮载荷注入** | `engine.queueNext(line)`（工具边界/下一轮）；`kernel/cli.mjs` 工作流自动触发回填处 | 视路径 | 工作流自动触发结果 |

### 2.2 关键时序事实

| 事实 | 位置 | 含义 |
|---|---|---|
| `memoryBlock` **启动时算一次**，之后不再重算 | `kernel/cli.mjs:919-985` | 经验注入是**静态化**的，与"当前任务"无关 |
| 每轮入口确实重算 system，但刻意排除 memory | `kernel/cli.mjs:1001-1011`；注释 `:999-1000`："`memoryBlock` 一次图谱检索不便宜，不该每轮重算" | 轮边界**已有钩子**（`refreshSystemPrompt`），只是内容被冻住 ⇒ 缺口是"内容冻结"，不是"没有钩子" |
| 轮末落点 | `kernel/cli.mjs:1322` `loop.onTurnEnd({ outcome })` | 主 spec §5.4 已引用；切换/沉淀都挂这里 |

### 2.3 现成的"线索"能力（**本增量的关键：不需要新建机制**）

`kernel/knowledge-search.mjs` 的 `searchKnowledgeItems` 注释自陈：

> 「结构化检索（S3 §4.2 起为 KnowledgeSearch / MemorySearch 两个工具**共用的唯一入口**）……两个工具的差别只是"怎么渲染"，检索口径必须一字不差」

也就是说，**"检索一次、多种渲染"的架构已经存在**，当前有 2 个渲染方（工具回执 `searchKnowledge`、注入抽调 `renderRecall`）。线索层只是**第 3 个渲染方**——同一份 `items`，不同渲染。可用字段（逐行核实）：

| 字段 | 来源 | 用途 |
|---|---|---|
| `it.blockId` | `renderLine`/`anchorTextOf` | **展开一跳的唯一凭据**（`KnowledgeSearch {related: blockId}`） |
| `it.docId` / `it.heading` / `it.line` | `renderLine` `where` | Read 定位（`docId › heading · 第 N 行`） |
| `it.spaceId` / `it.title` | `renderLine` | 来源标注；`spaceId` 判可读性 |
| `it.snippet` / `it.hits` / `it.score` | `searchKnowledge` | 摘要 / 命中词（≤4 词 ≤12 字）/ 分数 |
| `it.related[]` | `anchorTextOf` → `{blockId,title,why,score}` | **预载的一跳锚点**（0 成本，检索时已算好） |
| `readableSpaces` / `spaces` | `fullTextHint` 三态 | 据实分支"能不能 Read"（`Set`=放行 / `null`=不引导） |
| `RELATED_EXPAND_LIMIT = 5` | `knowledge-search.mjs` | 一跳展开上限；注释明确"**绝不**对返回的锚点再展开"、"5 是抗链式膨胀的底数" |

三条既有纪律直接为线索层背书（**引用原文，不重造**）：
- `expandRelated`："把正文预装进来等于让'展开一跳'变成'再注入一遍全文'" ⇒ **线索不含正文**；
- `anchorTextOf`："**绝不含正文**……注入一次请求的成本要恒定" ⇒ **线索行字节可控**；
- `fullTextHint`："旧文案无条件说'需全文用 Read'，于是模型对未放行的空间照做，只会撞拒绝" ⇒ **线索必须据实给可读路径**。

---

### 2.4 注入点精确清单（逐行核实，2026-09-20）

> 本节修正 §4.1 早先"6 处守卫注入点"的粗估：**实际 12 处指令注入 + 2 处协议回填 + 1 处载荷**，且**留痕方式有三种**（这正是"没有总线"的实证）。

**A. 主循环指令注入（`pushMemory({role:'user'}) + session.appendUser(inject)`）——9 处**

| # | 行 | 语义 | 留痕事件 | 计数上限 |
|---|---|---|---|---|
| 1 | `engine.mjs:505` | 守卫⑥ 无进展（loop-stall） | `guard_heal` :507 | `STALL_HEAL_MAX` |
| 2 | `engine.mjs:688` | 流中断续写（idle-interrupted） | `guard_heal` :690 | `IDLE_HEAL_MAX` |
| 3 | `engine.mjs:907` | 守卫③ 生成重复（repeat） | `guard_heal` :909 | `REPEAT_HEAL_MAX` |
| 4 | `engine.mjs:949` | R3-2 失败自愈（hadToolError） | **无事件** | `guardInjections` |
| 5 | `engine.mjs:965` | 计划尾守卫（isPlanTail） | **无事件** | `guardInjections` |
| 6 | `engine.mjs:973` | 思考早停自愈（isThinkOnly） | **无事件** | `guardInjections` |
| 7 | `engine.mjs:984` | 输出截断续写 | `output_continued`（**非 guard_heal**） | `CONTINUE_HEAL_MAX` |
| 8 | `engine.mjs:1105` | 守卫⑤ 连续同工具提醒 | **无事件** | `remindedAt` |
| 9 | `engine.mjs:1116` | 守卫④ 熔断愈合（error-meltdown） | `guard_heal` :1118 | `MELTDOWN_HEAL_MAX` |

**B. 主循环协议性回填（非指令，属 API 消息链必需）——2 处**：`:927`（截断时的 errorResults）、`:1073`（toolResults）。

**C. 子 lane 指令注入（宿主不同：`store.appendUser(inject)`）——3 处**：`:1731` / `:1763` / `:1776`。

**D. 轮载荷注入——1 处实现**：`engine.mjs:2336` `queueNext`（内部 `:2360` `pushMemory`）；调用方 `cli.mjs:1120`（工作流自动触发回填）/ `:1214` / `:1602`。

**E. 另有 1 处"有事件无注入"**：`:729` `guard_heal{reason:'upstream-dead'}` —— 只发事件 + 退避重试，**无注入文案**（说明事件与注入并非一一对应）。

**三条由此得出的事实（评审基线）**：
1. **"注入"当前既无统一定义也无统一留痕**：9 处里 4 处发 `guard_heal`、1 处发 `output_continued`、**4 处什么都不发**（`:949/965/973/1105`）⇒ §3.1 的 `persist` 布尔**不足以表达现状**（见 §9 Q3）。
2. **主循环与 lane 的注入宿主不同**：主循环 `pushMemory + session.appendUser`，lane `store.appendUser` ⇒ 主 spec §6.2 把"自愈注入"列为**可共享 300-350 行**的前提是**先把宿主抽象出来**（这正是 `LoopCtx.inject` 的用武之地，见 §9 Q1）。
3. **既有测试资产（可直接做 L4 回归锁）**——按 §2.4 的四类逐一对齐（**审查补全，含路径纠正**）：

| 覆盖对象 | 测试文件（均在 `kernel-tests/`，除注明） |
|---|---|
| A 类·守卫注入（8 处中带事件的 5 处） | `engine-guard-heal.test.mjs` / `engine-guard-heal-persistent.test.mjs` / `engine-guard-idle.test.mjs` / `engine-guard-idle-retry.test.mjs` / `engine-guard-stall.test.mjs` / `engine-guard-deadstream.test.mjs` / `plan-tail-guard.test.mjs` / `loop-stall-guard.test.mjs` / `guards.test.mjs` |
| A 类·第 7 行 `output_continued`（`:984`） | `engine-continue-heal.test.mjs` / `engine-continue-heal-off.test.mjs` |
| C 类·lane 注入（`:1731/1763/1776`） | `engine-lane-heal.test.mjs`（断言 lane 续跑注入 ≤3 次） |
| B 类·协议回填（`:927` / `:1073`） | `session-tail-repair.test.mjs` / `orphan-tool-result.test.mjs` / `engine-tool-result.test.mjs` |
| D 类·载荷（`queueNext`） | `loop-controller.test.mjs` / `engine-ask-user.test.mjs`（`queueNext` 调用路径） |
| 通道④（`withAnchorTail`） | `fidelity-anchor-inject.test.mjs` / `fidelity-anchor-loop.test.mjs` |
| 注入输出契约 | `knowledge-inject.test.mjs` / `knowledge-inject-e2e.test.mjs` / `knowledge-recall-quota.test.mjs` / `knowledge-scope-plumbing.test.mjs` / `knowledge-session-spaces.test.mjs` |
| memory 侧 | `memory-search.test.mjs` / `memory-append.test.mjs` / `memory-hygiene.test.mjs` / `read-memory-boundary.test.mjs` |
| GUI 侧契约 | **`kernel-tests/workflow-prompt-refresh.test.mjs`**（system 重算；**修正：早先误记为 server 侧**）/ `server/prompt-skills.test.mjs`（bridge append 契约）/ `server/experience.test.mjs:146-158`（`buildExperienceIndex` 超限丢行） |

> **L4 覆盖矩阵（实现时必须逐格核对，不得只测守卫组）**：`（守卫 / lane / 协议回填 / 载荷）×（注入文案 / wire 事件 / 计数与清零规则）`。§9 Q6 的受影响清单即由本矩阵推出。

---

## 3. 设计：注入总线 + 线索化供给 + 注入总账

### 3.1 注入总线（`kernel/inject-bus.mjs`，新增纯函数模块）

与主 spec 的 `loop-mode.mjs` / `methodology.mjs` 并列，**不新增运行时**：

```js
/** @typedef {object} Injection
 *  id      : 唯一标识（进总账与留痕）
 *  kind    : 'static' | 'turn' | 'derived' | 'payload'   // 决定挂载点与是否落 transcript
 *  source  : 'memory' | 'knowledge' | 'recommend' | 'methodology' | 'mode' | 'guard' | 'bridge'
 *  priority: number        // 冲突时抽让渡顺序；越大越不可让渡（B1 阶段不冻结此字段，见 §9 Q1）
 *  budgetBytes: number     // 字节预算（Buffer.byteLength，唯一口径）
 *  persist : boolean       // true → 通道③（落 transcript，可审计）；false → 通道④（纯派生，不打穿前缀缓存）
 *  event   : string | null // 留痕事件名；**null = 当前无事件**（如实申报，见 §9 Q3）
 *  phase   : 'boot' | 'beforeIter' | 'beforeRequest' | 'afterToolBatch' | 'afterTurn'
 *  render(ctx) → string
 */
export function createInjectBus({ totalBudgetBytes, mode = 'observe' })
// bus.register(inj) / bus.collect(phase, ctx) → { text, snapshot }
```

**B1 冻结面最小化**（回应 §9 Q1 的返工风险）：B1 阶段 `ctx.emitInjection`（命名见下）**只冻结 `text / persist / event` 三项**——这三项足以逐字节复现现状；`priority / budgetBytes / kind / phase` 留到 S3.5 才引入，避免"B1 冻结一套没有消费者的接口、S3.5 再返工改 12 个调用点"。

> **命名纪律（防与主 spec 冲突）**：主 spec §6.1 的 `LoopProfile` 已有字段 `inject: { pendingNext: true, inbox: false }`（配置对象）。本增量的注入出口**不得**叫 `ctx.inject`，统一用 **`ctx.emitInjection(text, { persist, event })`**——同名不同义会让实现者把"配置开关"与"注入函数"混用。

**挂载点与主 spec 的 `phaseHooks` 同源**：`beforeIter`（线索推荐、模式 warm-up、计划复述）/ **`beforeRequest`（请求面派生注入，如锚点）** / `afterToolBatch`（方法论 gate 自愈、工作流结果）/ `afterTurn`（沉淀提示、计划对照）。主 spec §5.4 架构图里把 `[注入总线]` 画在 **`[engine.mjs] phaseHooks` 一侧（`[观测]` 的上游）**，`[观测]` 节点显式纳入 O4——注入发生在 phaseHooks 内，画在 `[观测]` 下游会把错误时序带进实现。

> **`beforeRequest` 为什么必须有（回应 §9 Q10）**：`withAnchorTail` 不是"每轮一次"的注入，而是**每次 API 请求组装时**对末条 `user` 的派生操作（`engine.mjs:363` 的缓存双键 = 失真指纹 + face 对象身份，同一迭代可多次触发）。若只在 `beforeIter` 收集一次，则"前缀字节不变"与 L4 字节等价**两条都不成立**（§9 Q10、A17a/A17b）。

**既有开关 → 总线映射（回应 §9 Q11：不得另拍一套预算/开关）**

| 既有开关 | 单一权威 | 总线语义 |
|---|---|---|
| `settings.memory.inject`（缺省 `true`） | `kernel/settings.mjs:91` | `false` ⇒ 记忆类注入（EL0/EL1/抽调）全停，**总账记 0 而非不记**（否则"没注入"与"没观测"不可分） |
| `memory.injectMode` / `memory.injectMaxBytes`（缺省 `legacy` / `4096`） | **`kernel/knowledge-inject.mjs` 的 `resolveInjectMode` / `resolveInjectBudget`**（`settings.mjs:86-90` 明写单一权威在此） | 总线 `totalBudgetBytes` **派生自 `resolveInjectBudget()`**，不自建默认值 |
| `PONOS_MEMORY_INJECT=index-only` | `kernel/cli.mjs:950` | 语义**保持不变**（只管内层 memory 注入形态）；**EL1 的开关独立为 `PONOS_MEMORY_EL1=0`**（D6：二者不耦合） |
| `PONOS_MEMORY_KEYWORDS` / `settings.memory.taskTag` | `kernel/cli.mjs:918/950` | EL1 匹配关键词的**唯一来源**，不新增参数 |
| `knowledgeRelateMode`（缺省 `'on'`，`kernel/knowledge.mjs:577`） | env `PONOS_KNOWLEDGE_RELATE_MODE` → `config.json` → `'on'` | `off` ⇒ `it.related` 为空且 `search()` 不带该字段 ⇒ **线索层锚点与 A18① 的前置条件** |
| `PONOS_LOOP_GUARD=0` | `kernel/engine-config.mjs:36` | 全关路径：12 处注入**全不发生** ⇒ **L4/A17a/A17b 必须加此对照**（否则等价锁漏掉整条路径） |
| `PONOS_PROMPT_TIER=lean` / `session_mode=chat` | `kernel/prompt.mjs:44/206` | O4 需带 `tier` / `sessionMode` 分类字段，A13 断言限定**同配置**比较 |

**两条渲染路径就是通道③与④的等价搬移**，不新增语义：

| `persist` | 复用实现 | 理由 |
|---|---|---|
| `true` | 现 `guard_heal` 式（`pushMemory` + `session.appendUser` + `wire.system`） | 需要事后审计"这轮引擎往模型嘴里塞了什么"（方法论门控属于这类） |
| `false` | `withAnchorTail` | 高频道、每轮可能变化的注入（线索推荐、计划复述、锚点）——不落 transcript，且**前缀字节不变**，不打断 prompt cache |

### 3.2 经验供给三层化（对齐主 spec §9.4 的 L0/L1/L2）

| 层 | 内容 | 成本 | 落点 |
|---|---|---|---|
| **EL0** | 主题清单：`- [主题] N 条 · 最近日期`（7 主题） | **~200 B**（恒在，替代现 42 行） | 通道①/②（system 静态） |
| **EL1** | **线索**：任务相关条目的**指针**（位置 + 命中理由 + 一跳锚点 + 展开动作），**不含正文** | ≤1.5 KB | 通道④（`beforeIter` 派生注入） |
| **EL2** | 内容：条目正文 / 块全文 | **按需，agent 自主** | `Read` / `KnowledgeSearch {mode:'full'}` / `KnowledgeSearch {related}` |

**⚠️ 与既有「知识抽调层」的关系（**互斥，防双供给**——本增量最易踩的坑）**

`kernel/knowledge-inject.mjs` 的 unified 路径**已经在做"按任务上下文检索知识库并注入"**（`renderRecall` → 【相关知识抽调】块，含摘要、预算内可升级为全文、带 `↵关联` 锚点）。EL1 线索层做的是**同一件事的另一种渲染**。若不做约束，启用 unified 后会出现**同一批知识块被注入两遍**（一遍带正文、一遍只有线索）——**这正是本次评估 P0「双注入」问题的新版本**，属于必须预防的自伤。

| 策略 | 知识供给由谁负责 | EL1 线索层 | 依据 |
|---|---|---|---|
| `legacy`（当前生产） | 无抽调层（legacy 的 `recallSection` 恒空串，见 `knowledge-inject.mjs` 顶部注释） | ✅ **EL1 生效**（补上 legacy 缺失的供给能力） | 本增量 S4.5 |
| `unified`（灰度后） | `renderRecall` 抽调层（已有块级 + 锚点 + 全文升级 + 单库配额） | ❌ **EL1 关闭**，避免双供给 | 同一份 `items`，只换渲染方 |

**硬约束**：`buildRecommendSection` 的调用点必须由 `strategy` 把关（`legacy → 开 / unified → 关`），并在 O4 总账里如实上报 `bySource.recommend` 是否启用。**不允许**"两层都开、靠预算互相挤"——那会让"哪一层注入了什么"变得不可归因（与 §3.3 的可归因要求直接冲突）。

> 反过来（把 unified 的抽调层也改成线索形态）**不在本增量范围内**：unified 的全文升级与配额是既有能力，顺手改造会同时动检索契约与既有测试；两层的**渲染收敛**留待 unified 转正后单独评估。

**归属判定（防止越界成"内容供给"）**：

| 判据 | EL1（线索） | EL2（内容） |
|---|---|---|
| 是否含条目正文 | ❌ 只有 `snippet`（`makeSnippet`，≤160–300 字） | ✅ 有 |
| 是否含块全文（`full`） | ❌ **禁止全文升级**（`upgraded` 恒 false） | ✅ 有 |
| 是否可定位 | ✅ 必有 `docId` + 行号 + `blockId` | ✅ |
| 由谁决定读不读 | **agent**（引擎只推荐） | agent |

### 3.2.1 EL1 线索渲染契约（`kernel/knowledge-recommend.mjs`，新增）

**复用既有检索入口，只加一种渲染**：

```js
import { searchKnowledgeItems } from './knowledge-search.mjs'

/**
 * 线索层渲染（第 3 个渲染方：工具回执 / 注入抽调 / 线索推荐）。
 * 与另两方**共用同一份 items**——检索口径一字不差，渲染差异只在"给多少"。
 * @returns {{ section, count, offered: string[], stats }}
 */
export function buildRecommendSection({
  configDir, query, keywords, spaces,
  readableSpaces = null,     // Set=已授权可 Read 的空间；null=不给 Read 指引（照 fullTextHint 三态）
  budgetBytes = 1536,
} = {})
```

**输出格式（与工具回执同源——agent 已熟悉该格式，无需再学一套）**：

```
【相关知识线索】以下条目与当前任务相关，仅提供线索（未展开正文）——需要时自行读取：
- [经验|迁移核对] 迁移到 .yfworking 的技能脚本核对法… -- memory/personal/workflow.md › 技能迁移 · 第 640 行 (experience/workflow.md#12) · 命中「迁移 核对」 ↵关联：experience/workflow.md#7「…」[同标签:迁移]
（读取：Read 打开上列文件第 N 行；继续展开线索用 KnowledgeSearch {related:"experience/workflow.md#12"}；整块全文用 KnowledgeSearch {query:"…", mode:"full"}）
```

**六条硬约束**（每条都能追到既有实现或既有教训）：

| # | 约束 | 依据 |
|---|---|---|
| R1 | **禁止全文升级**：`upgraded` 恒 false，不注入 `full` | `expandRelated` 原文："把正文预装进来等于让'展开一跳'变成'再注入一遍全文'" |
| R2 | **每行必带 `blockId`**：无线索凭据的行不渲染 | 无 blockId ⇒ 无法 `related` 展开（`isBlockId` 形状校验会拒） |
| R3 | **摘要走 `makeSnippet`**（默认 160，线索层可放宽至 300） | `searchKnowledge` 既有用法；行字节可控 |
| R4 | **预载一跳锚点 ≤ `INJECT_RELATED_TOPN`(3)**，按 `why.kind` 打理由，**剔除 `duplicate`** | `anchorTextOf` 既有口径（duplicate 是去重提示，不是阅读路径，且会诱导重读） |
| R5 | **可读性据实分支**（`readableSpaces` 三态）；未授权空间**只给 `related` / `mode:'full'`** | `fullTextHint` 与 `expandRelated` 的既有 P3 修复（"无权限的指引必须写明替代路径"） |
| R6 | **预算按字节记账**，装不下**丢弃整行**（不截断行内正文），首条无条件放入 | `renderRecall` 既有纪律（"预算必须按实际装入的字节记账" / "首条无条件放入"） |

### 3.2.2 扩展线索阅读（Chain）

| 跳数 | 谁发起 | 实现 | 成本 |
|---|---|---|---|
| **0 跳**（本次推荐） | 引擎 | `searchKnowledgeItems` → 渲染线索行 | 一次检索（引擎已在做） |
| **1 跳** | 引擎**预载** | `it.related`（检索时已算好，`MAX_TAG_RELATED`/`MAX_CONTENT_RELATED` 各 5） | **0**（只渲染 ≤3 条） |
| **≥2 跳** | **agent 主动** | `KnowledgeSearch {related: blockId}`（`RELATED_EXPAND_LIMIT=5`，`expandRelatedItems`） | 一次工具调用 |
| 全文 | agent 主动 | `KnowledgeSearch {mode:'full'}` 或 `Read docId:line` | 一次工具调用 / 一次读 |

**三条防线（全部照既有实现，不新造）**：
1. **引擎绝不自动多跳**——`knowledge-search.mjs` 原文："这里只调一次 `getRelated`，**绝不**对返回的锚点再展开（spec §7.6 明确"不自动多跳"）"；
2. **展开上限 5**——原文理由："模型极易把返回的 blockId 再喂回来继续展开，露出条数就是链式膨胀的底数（连展开 3 跳 = 5³ 条）"；
3. **提示词里写明展开方式**（R5 尾行的 `related:` 指引）——否则 agent 不知道 blockId 可继续喂（现有 `anchorHint` 只说了"需正文用 Read"，缺 `related` 一路 ⇒ 本增量补齐）。

### 3.2.3 线索采纳率（O4 的特有指标）

**目的**：回答"引擎推荐的线索到底有没有用"——这是"引擎默认发现"能否转正的唯一客观依据，也是主 spec A11 在线索层的对应物。

| 指标 | 定义 | 采集点 |
|---|---|---|
| `offered` | 本轮推荐出去的 `blockId` / `docId` 集合 | `beforeIter` 推荐时登记（会话级内存） |
| `adopted` | 后续 `KnowledgeSearch`（`query` 命中 / `related` 命中）或 `Read`（路径命中 `docId`）**落在 `offered` 集合内**的次数 | `afterToolBatch` 比对 |
| `adoptRate` | `adopted / offered` | 落 `inject_snapshot` 与 `wire.system('recommend_adopted')` |
| `chainDepth` | agent 自发展开的跳数（`related` 调用链计数） | 同上 |

**两阶段时序（回应 §9 Q5 的 P0 缺陷：采纳率不能在观察期测）**

观察期不注入 ⇒ 模型无线索可采纳 ⇒ `adopted` **结构性为 0**。若不加区分，会把"尚未转正"误读为"引擎发现不成立"而错误回退，还会让 `recommend-ignored` 自愈**必然误触发**。因此阶段必须分开、字段必须分名：

| 阶段 | 引擎行为 | 可测指标 | **不可测**（禁止用作判据） |
|---|---|---|---|
| **阶段一 观察期**（`OBSERVE_ONLY=true`） | 只计算 + 落账 + 发 wire，**不进上下文** | `offeredDryRun` 的**分布**：每轮条数、空间分布、主题命中率、耗时 | ❌ `adopted` / `adoptRate`（恒 0，**语义为"不适用"而非 0**） |
| **阶段二 转正后** | 真注入 | `offered` / `adopted` / `adoptRate` / `chainDepth` | — |

**硬约束**：
1. `offered` **仅在真实注入时登记**；观察期登记到独立字段 `offeredDryRun`（A19 断言其存在且与上下文字节无关）。
2. `recommend-ignored` 自愈（§4.1 S9.5）与 Q5 的回退判据**必须带前置 `OBSERVE_ONLY === false`**——否则观察期必然误触发/误回退（对齐主 spec §14.1 A10"误伤率 ≤ 观测期阈值"）。
3. 阶段定"是否转正 + 每轮条数上限"的依据 = 阶段一的 `offeredDryRun` 分布（对齐主 spec §7.3 同款流程：不接受拍一个 N）。

### 3.3 注入总账（主 spec §7 观测层的 O4）

新增 `appendMeta('inject_snapshot', {...})`，每轮一条，字段对齐主 spec O3 的留痕范式：

```js
{
  seq, ts,
  promptTier, sessionMode,      // 'full'|'lean' / 'task'|'chat'（prompt.mjs:44/206）——A13 必须同配置比较
  channels: { static: {bytes, blocks}, bridge: {bytes}, guard: {bytes, hits},
              derived: {bytes, hits}, payload: {bytes} },
  bySource: { memory, knowledge, recommend, methodology, loopMode },  // loopMode 原名 mode（防与 chat/task 混淆）
  recommend: { enabled, offered, adopted, adoptRate, chainDepth, offeredDryRun },  // §3.2.3
  skillL2: { loaded: [ids], bytes },      // Skill 工具返回的 SKILL.md 全文体量（主 spec §9.1 的成本源）
  kb: { strategy, recallBlocks, degraded, spacesCapped },  // 复用 knowledge-inject 既有 metrics 字段
  total: { bytes }
}
```

四条硬要求：
1. **单一字节口径**：全部用 `Buffer.byteLength`——吃掉本次评估的 P1（两份 build 用 `line.length` 超支 25%）。**注意：口径变更会改变可装入行数 ⇒ 属行为变更，唯一归属 S4.5，不得落在 S1+**（§9 Q4）。
2. **legacy 也要有账**：把 `graph.search()` 的命中条数/字节写入 `channels.static`/`bySource.memory`，否则主 spec 阶段一的"先观测"没有基线（当前 `search=null` 恒成立）。
3. **不删既有字段**：`metrics.json` 的 `inject`/`search` 段保持，新增字段只增不改（灰度回退前提）。
4. **O4 是"视图"不是"第二本账"**（回应 §9 Q8）：`guard` / `methodology` 相关字节**从主 spec §7.1 的 O2（`turnStats.guard`）与 O3（`appendMeta('loop_mode_switched'|'methodology_applied')`）派生**，O4 只做字节口径的汇总，不独立采集同一事实——否则本增量自己就违反了 §1.3 对"两套账"的批评。A7（主 spec）与 A13（本增量）的对应关系须在实现说明里写清。

### 3.4 顺带修掉的四项实测缺陷（与总线同批落地）

| 缺陷 | 修法 | 归属 |
|---|---|---|
| 经验索引被注入两遍（5131 B × 2） | 保留一处：内核侧 `memory` 段（它在 system 内、位置稳定、chat 隔离已有兜底），**移除 `server/bridge.mjs:1608-1609` 与 `:1646-1647` 的 `buildExperienceIndex`**（`buildSedimentPrompt` 沉积指令保留，它不在内核侧） | S4.5（D3 已定） |
| 内核侧不读 `front.active` | `kernel/memory.mjs` 的 `buildMemoryIndex` 补 active 过滤（**必须先做**，否则去重后"停用主题仍被注入"从隐性变显性） | S4.5 前置 |
| budget 按字符记账 | 两处 `line.length` → `Buffer.byteLength` | **S4.5（唯一归属，不得落 S1+）**——口径变更会改可装入行数 = 行为变更 |
| GUI 面板口径与内核不一致（**审查新增**） | `server/experience.mjs:219/223` 用 `buildExperienceIndex(4096)` 算 `inject_bytes` 显示给用户；若只改内核侧，面板数字将与内核实际不符 —— 即 §1.4"两处实现不一致"的新版本。修法：与内核同口径，或在面板显式标注"按内核口径估算" | S4.5 |

> **去重的既有测试锚点**：`server/experience.test.mjs:146-158` 已断言 `buildExperienceIndex` 超限丢行契约 ⇒ 去重时该文件是"桥侧不再调用"的验证点，断言不要放宽。

---

## 4. 路线（已定：并入一期 → **已并入主 spec §12.1**）

> 下表为设计期记录。**实施以主 spec §12.1 的 S 序列为准**（本文件不再单独驱动实施）。

主 spec 的 S1-S16 不重排，仅插入 4 步、扩展 2 步（**已写入主 spec §12.1**）：

```
S1 → S1+ → S2 → S3 → S3.5 → S4 → S4.5 → S5 → S6 → S7 → S8 → S9 → S9.5 → S10 → S11 → S12
（S1+/S3.5/S4.5/S9.5 = 本增量新增；其余 = 主 spec 原序不变）
```

### 4.1 逐步任务边界（增量步可独立提交；**S3.5/S4.5/S9.5 有前置依赖**，见 §9 Q7）

| 步 | 交付物 | 关键改动 | 验收 | 不做什么 |
|---|---|---|---|---|
| **S1**（主 spec） | O1/O2/O3 采集 | `engine.mjs:1031-1036` 增 `size`；守卫命中点 `turnStats.guard`；模式 meta | 新字段出现；测试覆盖 | 不改注入 |
| **S1+**（新） | **O4 注入总账（含分段计量）** | ① `knowledge-inject.mjs` 的 `record/persistMetrics` 增字段；② `cli.mjs` 每轮 `appendMeta('inject_snapshot')`；③ 补 legacy 侧 `graph.search` 命中记账；④ **新增只读分段计量**：`prompt.mjs` 各段 `Buffer.byteLength`（含 `tier`/`sessionMode`）+ 桥侧 append 文件长度（**只读长度、不重组提示词**，故仍是零行为变更） | `inject_snapshot` 字段齐备；**legacy 也非空**；`A13`（同 tier/mode 配置内比较） | **不改 build 预算口径**（字符→字节属行为变更，归 S4.5）；不改任何注入内容与顺序；不引入 `priority/budgetBytes/kind`（那是 S3.5） |
| **S2/S3**（主 spec） | B1 契约抽取 + 应用到 lane | 等价搬移 | L1/L2/L3 全绿 | **不触碰注入逻辑**（B1 零行为变更） |
| **S3.5**（新） | **注入总线抽取** | 新建 `kernel/inject-bus.mjs`；**注入点精确清单见 §2.4**（主循环 9 + lane 3 + 协议回填 2 + 载荷 1）；`withAnchorTail` 注册为 `beforeRequest` 相位的 `derived` 渲染器；此处才引入 `priority/budgetBytes/kind/phase` | **L4**：注入**文本 + wire 事件序列**双重等价（mock 会话回放）；**并加 `PONOS_LOOP_GUARD=0` 对照**（全关路径等价）；主 spec L1/L2/L3 全绿 | **只做等价搬移**；**不补事件**（4 处 `event:null` 如实保留，补事件是行为变更）；**不统一 lane 与主循环的注入语义**（主 spec §6.2 的"刻意不同 250 行"须保持：lane 不注册锚点、`pendingNext`/`inbox` 仍走 profile 开关）；发现既有 bug 另开 issue。**范围与 B1 重叠 → 见 §9 Q1** |
| **S4**（主 spec） | `loop-mode.mjs` + `methodology.mjs` 纯函数 | — | 单测覆盖 | — |
| **S4.5**（新） | **经验三层化 + 三条缺陷修复 + 线索层** | ① 去重（`bridge.mjs` 两处移除 `buildExperienceIndex`）；② `memory.mjs` 补 `front.active`；③ **字节口径统一（字符→字节，唯一归属本步）**；④ 新建 `kernel/knowledge-recommend.mjs`（`buildRecommendSection`，复用 `searchKnowledgeItems`）；⑤ `cli.mjs` `beforeIter` 接线 + 推荐集合登记（`offered` / 观察期 `offeredDryRun`）；⑥ **按 `strategy` 把关 EL1 与抽调层互斥**（§3.2 ⚠️）；⑦ GUI 面板口径同步（`server/experience.mjs:219/223`） | `A12`/`A14`/`A16`/`A20`；新单测 `kernel-tests/knowledge-recommend.test.mjs`（含 R1–R6 六条约束的对照用例 + 首条无条件放入 + 预算不足丢整行 + `related` 为空时的降级）+ **`A18`（前置：`knowledgeRelateMode==='on'`）** | 不改检索口径（评分/过滤/`topK` 一字不动）；不把 unified 抽调层改成线索形态（§3.2 末注） |
| **S5–S8, S10, S11**（主 spec） | 首批方法论下沉 + 模式 | 注入点走总线（`phaseHooks` → `bus.collect`） | 主 spec A9/A10 | — |
| **S9**（主 spec） | Reflect 模式 | — | 主 spec A6 | — |
| **S9.5**（新） | **下沉第 5 项 `experience-sediment`** | `methodology.mjs` 声明两个具名判据：`reusable-finding-unrecorded`（afterTurn，照主 spec §9.6 的"只允许引用引擎内置具名判据库"）+ **`recommend-ignored`**（线索推荐了却零采纳、且任务将收尾 → 注入一次自愈，提示"引擎已推荐相关经验，你未读"） | 误伤对照：正常任务不触发；**本步先只发 wire/落账**（对齐主 spec §7.3 阶段一、D7"不接受拍一个 N"），阈值 `offered ≥ 2 && adopted === 0` **标为占位值**，随 S12 观测数据转正；**硬门控 `OBSERVE_ONLY === false`**（否则观察期必然误触发，见 §3.2.3） | 不做"推荐了就强制读"（门控只注入自愈，不硬 veto）；不在本步定阈值 |
| **S12**（主 spec，扩展） | 阈值转正 | 阈值来源增 `inject_snapshot` 的通道分布 + `recommend.adoptRate` | 附录记录取法 | — |
| 二期 S13–S16 | 主 spec 原样 | — | — | `knowledgeInjectMode`/`mid=unified` 灰度同样"先观测后定"，**不在一期强切** |

### 4.2 一期完成时的可量化结果

| 项 | 前 | 后 | 依据 |
|---|---|---|---|
| system 中经验相关内容出现次数 | **2** | 1 | 去重（S4.5①） |
| 经验常驻字节 | 5131 × 2 = 10262 B | EL0 ~200 B + EL1 ≤1536 B | 三层化（S4.5③） |
| 每轮注入总量可归因 | ❌（`search=null`） | ✅ `inject_snapshot` | S1+ |
| 引擎默认发现能力 | ❌（等模型自愿检索，实测 0.06%） | ✅ 每轮推荐线索 + 采纳率可测 | S4.5③ + S3.2.3 |
| 每轮省下 | — | **≈8.5 KB（≈2.5K tokens）** | 与主 spec §9.8 的 11–13K 合计 ≈20K/任务 |

---

### 4.3 净上下文影响核算（正面回答"会不会越改越乱"）

**判据不是"有没有新增"，而是"每轮恒在字节是否净下降"。**逐项核算（单位：字节/轮）：

| 项 | 前 | 后 | 净额 | 说明 |
|---|---|---|---|---|
| 经验索引（bridge append 侧） | 5131 | **0** | **−5131** | 去重：移除 `bridge.mjs:1608-1609/1646-1647` |
| 经验索引（内核 `memory` 段） | 5131 | 200（EL0） | **−4931** | 三层化：EL0 只留主题名+条数 |
| EL1 线索段 | 0 | ≤1536 | **+1536** | **新增**，但仅命中时出现；观察期不注入（0） |
| `recommend-ignored` 自愈注入（S9.5） | 0 | ≤300 ×1 | **+300（一次性）** | 条件触发、全会话至多一次，**非恒在** ⇒ 不计入 G3 的常量口径，但须在 G2 下声明为 net-new |
| O4 `inject_snapshot` | 0 | ~250 | **0（进上下文）** | 走 `appendMeta` = **meta 记录，不进上下文**；只增磁盘与可读性（≈250 B/轮落盘，可接受） |
| `beforeRequest` 相位开销 | — | 纯计数 | **0** | O(1) 字节统计，无 IO |
| **每轮恒在合计** | **10262** | **≤1736** | **≈ −8526 B（−83%）** | 对齐 G3 的验收数字（S4.5 目标 ≤1736 B） |

**三条防自伤的硬约束（本方案自己也必须守）**：
1. **不得为新增能力加预算**（G1）：EL1 的 1536 B 是从被删掉的 10262 B 里切出来的，**不是额外申请**。
2. **不得新增"恒在"注入**（G3）：本增量唯一新增的恒在项是 EL1，且有上限 + 命中门槛 + 可关（`PONOS_MEMORY_EL1=0`）。
3. **不得把"治理"本身变成新负担**：O4 走 meta 不进上下文；总账字段固定（增字段需改 A13 断言，是有意摩擦）。

> **反例警示（本增量要避免的形态）**：若"注入统一"的落地方式是"给每条通道各配一套预算与留痕，再新增一个总账"——那就是把 5 条通道的乱账变成 8 条通道的乱账。G2（通道数不增：新通道必须声明替换了哪条旧路径）就是拦这条的。

---

## 5. 验收增补（追加到主 spec §14.1）

| # | 标准 | 判据 |
|---|---|---|
| **A12** | 经验相关内容在 system 中**只出现一次** | 构造任务模式会话，断言 `【个人经验索引】` 出现次数 = 1（当前 = 2），且内容等于内核侧输出 |
| **A13** | 注入总账可读且**可归因** | 每轮 `inject_snapshot` 存在；`channels`/`bySource` 字节和 = 实测 system prompt + 派生注入总量（误差 ≤ 5%），**且只在同 `tier`/`sessionMode` 配置内比较**（lean/chat 与 full/task 的段数与字节本就不同，跨配置比较会把正常差异判为缺陷） |
| **A14** | EL0/EL1 分层生效，且 **EL1 不含正文** | 恒在的 EL0 ≤ 512 B；EL1 仅在命中主题时出现；**断言线索段中不含任何 `full` 正文**（无 ` ·全文` 标记）；`PONOS_MEMORY_EL1=0` 时 EL1 为空（逃生阀不静默失效；D6：与 `PONOS_MEMORY_INJECT` 不耦合） |
| **A15** | 单轮注入总量受预算约束 | 各通道字节和 ≤ 配置总预算（字节口径，**派生自 `resolveInjectBudget()`**，不另拍默认值）；超预算时按 priority 抽让渡，且降级有留痕（对齐 `degraded` 语义）；`settings.memory.inject=false` 时记忆类全停且**总账记 0 而非不记** |
| **A16** | 停用主题不再被注入 | GUI 停用主题 T → 内核 EL0/EL1 均不含 T（当前内核侧漏判 `active`） |
| **A17a** | 轮内注入等价（L4a） | 总线抽取前后，同一 mock 会话的**轮内 phase 注入文本 + wire 事件序列**逐字节等价（覆盖 12 处指令注入 + 4 处 `event:null` 如实保留） |
| **A17b** | 请求面派生注入等价（L4b） | `withAnchorTail` 改注册为 `beforeRequest` 相位的 `derived` 渲染器后，**每次请求**的末条 `user` 派生结果逐字节等价、前缀不变；含 `PONOS_LOOP_GUARD=0` 全关路径对照 |
| **A18** | **线索可展开且可采纳可测** | **前置：`knowledgeRelateMode === 'on'`**（`off` 时 `it.related` 为空，① 不适用但须有降级用例）。① 线索行的 `blockId` 喂给 `KnowledgeSearch {related}` 必返回非空（有锚点时）；② `recommend.offered/adopted/adoptRate` 三者可读且 `adopted` 能追到具体工具调用；③ 未授权空间的线索**不含 Read 指引**（只有 `related`/`mode:'full'`） |
| **A19** | 观察期默认不注入，且**不产生假采纳率** | `OBSERVE_ONLY=true` 时上下文里无线索段（只发 wire/落账），且 `offeredDryRun` 有值而 `offered` 为空、`adopted` 语义为**"不适用"**（**不得记 0**，见 §3.2.3 P0 修正）；置 false 后按配置上限注入 |
| **A20** | EL1 与 unified 抽调层**互斥** | `strategy=legacy` → 线索段存在；`strategy=unified` → **线索段不存在**（有测试）；`inject_snapshot.bySource.recommend` 与之一致（§9 Q9） |

---

## 6. 明确不做（含技术理由）

| 不做 | 技术理由 |
|---|---|
| ❌ 在 B1 里**改变注入行为** | B1 的交付判据是"零行为变更 + kernel-tests 全绿"；混入注入**行为**改动会让 L1/L2/L3 回归锁失去意义（主 spec §6.4 同款理由）。注意区分：B1 里**提供注入出口**（`ctx.emitInjection`，等价搬移手段）与**改变注入行为**（补事件、改文案、改抓取范围）是两件事——前者见 §9 Q1(a)，后者禁止 |
| ❌ EL1 预装正文（含全文升级） | 与"只发线索"的供给形态冲突（D2）；且 `expandRelated` 已给出同款理由——预装正文等于把"展开一跳"变成"再注入一遍全文"，成本不再恒定 |
| ❌ 引擎自动多跳展开 | `knowledge-search.mjs` 既有裁定："绝不自动多跳"；露出条数是链式膨胀的底数（5³） |
| ❌ 引入 embedding / 向量库 | 现倒排 + grams（119007 grams）已支撑块级检索与锚点一跳；引入外部依赖换来的是同样的"块级供给"，成本与运维不划算 |
| ❌ 删除 legacy 注入路径 | 它是"灰度开关可信"的前提（`cli.mjs:911-918` 注释：legacy = 逐字节等于改动前）；一致性问题用"两条路都记账"解决，而非砍掉对照臂 |
| ❌ 历史成功率回填与评分路由 | 主 spec §13 已否同源方案（`TaskProfile`/`can_handle`/历史回填）；线索优先级用**静态 priority + 预算抽让渡**表达即可 |
| ❌ 把 `memoryBlock` 改成"每轮重算全量图谱检索" | `cli.mjs:999-1000` 已有取舍依据（一次图谱检索不便宜）；线索层只做**轻量匹配**，重检索仍由 `graph.search` 或 unified 负责且只在必要时机触发 |
| ❌ 一期强切 `unified` | 实测 `queries=0` 说明它从未在生产跑过；按主 spec D7"先观测再定"同款处理，先补 legacy 观测（S1+）再灰度 |
| ❌ 线索默认无上限、无观察期 | 推荐错了会消耗模型注意力；R6 的"首条无条件放入"意味着至少占一行 ⇒ 按 §3.2.3 的 `OBSERVE_ONLY` 先标定命中率与采纳率 |

---

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 注入总线抽取触碰 **12 处指令注入点**（§2.4：主循环 9 + lane 3），其中 **4 处当前无任何留痕事件** | **高**（原估"6 处"偏低） | ① 按 §9 Q1(a)：B1 搬迁时即以 **`ctx.emitInjection(text, { persist, event })`** 为唯一注入出口（**命名不用 `ctx.inject`**，防与主 spec `LoopProfile.inject` 混淆），且 **B1 只冻结 `text/persist/event` 三项**，S3.5 才引入 `priority/budgetBytes/kind/phase` ⇒ 把"改 12 个点"降为"换实现 + 加注册"；② 只做等价搬移、独立提交；③ L4 检测**注入文本 + wire 事件序列**双重等价（`event:null` 的 4 处须显式保留现状，**不在本步补事件**——那是行为变更）；④ A17a/A17b 分相位断言，并含 `LOOP_GUARD=0` 全关对照 |
| **B1 冻结一套"没有消费者"的注入接口，S3.5 再返工**（审查新增） | **中** | 靠"冻结面最小化"消解：B1 只冻结 `text/persist/event`；`priority/budgetBytes/kind/phase` 与渲染器注册位**全部留到 S3.5**；B1 交付判据补一条"`emitInjection` 默认实现逐字节等价 + 12 处 `event` 如实申报" |
| **把 lane 的注入语义一起"统一"掉，侵蚀主 spec §6.2 的"刻意不同 250 行"**（审查新增） | **中** | 总线只提供宿主侧渲染器注册位；**lane 不注册** `derived`/锚点渲染器，`pendingNext`/`inbox` 仍走 `LoopProfile` 开关（主 spec §6.1）；S3.5 判据补"lane 无锚点注入"等价比对（主 spec §6.2 已列此项） |
| 线索推荐"推了但没人读"（采纳率长期为 0） | **中高** | 这正是观察期的目的：`adoptRate` 可测 ⇒ 若长期为 0，说明"引擎发现"这条路也不成立，**应回退为纯 EL0 索引**（有数据可回退，而非继续硬推）。这也是本设计比"直接注入内容"更稳的地方——错了好撤 |
| 线索误推消耗注意力 | **中** | `OBSERVE_ONLY` 默认；只推标题级线索（≤1.5 KB，含摘要 ≤300 字）；每空间配额（照 `MAX_RECALL_PER_SPACE=4`）；可全局关（`PONOS_MEMORY_EL1=0`） |
| 去重后发现"丢的是那唯一生效的一份" | **中** | 去重前先逐字节对比两份输出（实测已同为 5131 B/42 行）；保留内核侧（system 内、位置稳定、chat 隔离有兜底）；A12 断言"出现次数 = 1 且内容等于内核侧输出" |
| EL0 过薄导致模型"不知道有哪些主题" | **中** | EL0 保留**全部主题名 + 条数**（~200 B），只裁条目级细节；对齐主 spec §9.4"L0 元数据恒在用于路由" |
| 注入总账本身成为开销 | **低** | 纯计数（无 IO，`appendMeta` 已有）；每轮一条，字段固定；线索采纳比对只在 `afterToolBatch` 做集合查（O(1)） |
| `metrics.json` 口径变化影响既有排查习惯 | **低** | 只增字段不删；`strategy/recallBlocks/degraded/spacesCapped` 保持原义 |

---

## 8. 决策点（**D1-D6 全部已拍板**，2026-09-20）

| # | 决策 | 结论 |
|---|---|---|
| **D1** | 落点 | ✅ **并入一期**（S1+ / S3.5 / S4.5 / S9.5） |
| **D2** | EL1 供给形态 | ✅ **只发索引线索**，agent 自主选择阅读，并支持**扩展线索阅读**（§3.2.1 / §3.2.2）；默认 `OBSERVE_ONLY` 观察期 |
| **D3** | 去重时机 | ✅ **随 S4.5 一起改**（前置硬约束：先补 `kernel/memory.mjs` 的 `front.active` 过滤，再移除桥侧 `buildExperienceIndex`） |
| **D4** | 本文件与原 spec 关系 | ✅ **并入主 spec S 序列**：四步写入 §12.1、A12-A20 与 G1-G4 写入 §14.1、`ctx.emitInjection` 写入 §6.1/§6.2；**本文件降级为设计论证 + 评审留痕**，冲突时以主 spec 为准 |
| **D5** | S3.5 与 B1 的关系 | ✅ **前移为 B1 设计约束**：B1 即以 `ctx.emitInjection(text, { persist, event })` 为唯一注入出口，**只冻结这三项**；`priority/budgetBytes/kind/phase` 由 S3.5 引入。已知代价：B1 单独回滚会连带注入出口 |
| **D6** | EL1 逃生阀 | ✅ **只留 `PONOS_MEMORY_EL1=0`**（语义单一，不与既有 `PONOS_MEMORY_INJECT` 耦合）；A14 措辞按此定稿 |

---

## 9. 评审清单（评审用）

> 评审对象：本文件（v3 增量）+ 其与主 spec 的接口。评审基线 = §2 的逐行代码事实（**不必重新考古**）。
> 每条给出：**问题 / 证据 / 选项 / 建议**。标 ⚠️ 的是必须评审拍板、否则实现会走偏的项。

### Q1 ⚠️ S3.5 与 B1 的范围重叠：会不会对同一批代码搬两次？

**问题**：主 spec §6.2 把"自愈注入（`guard_heal` wire + 注入文案 + 计数清零规则）"列为 B1 契约**可共享的 300-350 行**；而本增量 S3.5 又要"把注入抽成总线"。S2/S3（B1）先搬到 `loop-core.mjs`，S3.5 再抽一次 ⇒ **同一批代码二次搬移**，且两次都声称"零行为变更"，回归锁互相掩盖。

**证据**：主 spec §6.2 纳入契约清单第 2 项；§2.4 的 12 处注入点全在 B1 的迁移范围内。

**选项**：
- (a) **前移为 B1 设计约束**：B1 搬迁时即以 **`ctx.emitInjection(text, { persist, event })`** 作为**唯一注入出口**，`LoopCtx`（主 spec §6.1 已定义为"依赖注入：stream/store/wire/阈值/钩子"）增加该项；S3.5 退化为"实现 `inject-bus.mjs` + 替换默认实现 + 引入 `priority/budgetBytes/kind/phase`"——**不动 loop-core 结构**。
- (b) 保持原序（B1 先搬、S3.5 后抽），承担二次搬移与锁互掩风险。
- (c) S3.5 提前到 S2 之前（先有总线再重构 B1）——但 B1 是"纯重构零行为变更"的独立交付物，前置依赖会让它不可单独回滚。

**建议**：**(a)**，但须加三条限定（**独立审查补强**）：
1. **命名**：不用 `ctx.inject`——主 spec §6.1 的 `LoopProfile` 已有字段 `inject: { pendingNext, inbox }`（配置对象），同名不同义会造成实现层混淆；统一 **`ctx.emitInjection`**。
2. **冻结面最小化**：B1 只冻结 `text / persist / event`（足以逐字节复现现状）；`priority / budgetBytes / kind / phase` 与渲染器注册位**留到 S3.5**。理由：这些字段的真正消费者是 S4/S4.5/S9.5，B1 时冻结等于"冻结一套没有消费者的接口"，S3.5 仍要返工改 12 个调用点——**二次搬移风险并未消除，只是转成了接口返工**。
3. **不越主 spec §6.2 的边界**：总线只提供宿主侧渲染器注册位；**lane 不注册** `derived`/锚点渲染器，`pendingNext`/`inbox` 仍走 `LoopProfile` 开关（主 spec §6.3 的"刻意不同 250 行"不得被侵蚀）。B1 交付判据补一条："`emitInjection` 默认实现逐字节等价 + 12 处 `event` 如实申报"。

**技术上是否削弱 B1 的零行为变更判据？** 不削弱（只要默认实现逐字节复现现状，L1/L2/L3 字面判据照旧成立），但**B1 的单独回滚会连带注入出口**——这是采纳 (a) 的代价，评审需确认可接受。

### Q2 通道①②（system 静态块 / 桥侧 append）是否纳入总线？

**问题**：§3.1 的总线若同时管理 `composeSystemPrompt` 的静态段与桥侧 `--append-system-prompt-file`，就要动 `kernel/prompt.mjs` 与 `server/bridge.mjs` 的提示词契约——而 system 前缀的字节稳定性有明确契约（`prompt.mjs` 的 P0-3 注释：工具清单下沉到最末，否则"一变就把 system 中后段全部打穿"）。

**证据**：`kernel/prompt.mjs` 的分段顺序与 P0-3 注释；`server/bridge.mjs:1614/1654` 的 append 文件契约；测试 `workflow-prompt-refresh.test.mjs`。

**选项**：(a) 总线只管**轮内动态注入**（③④⑤），通道①②**只记账不接管**；(b) 全部接管（含 system 段）。

**建议**：**(a)**。理由：①② 的变化频率是"会话级"（去重后 EL0 几乎不变），而 ③④⑤ 是"每轮级"——统一渲染的收益集中在后者，前者接管只会引入前缀缓存与测试契约风险。EL0 落 ①、EL1 落 ④，正好各用其道。

### Q3 ⚠️ `persist` 布尔不足以表达现状（4 处注入无留痕）

**问题**：§3.1 用 `persist: true/false` 二分（落 transcript 与否）。但 §2.4 事实 1 显示现状有**三种**留痕：`guard_heal`（4 处）、`output_continued`（1 处）、**无事件**（4 处：`:949/965/973/1105`）。二分会把"无事件"这一现状抹平。

**证据**：§2.4 表 A 的"留痕事件"列；`:729` 另有"有事件无注入"的反例。

**选项**：(a) `persist: boolean` + **`event: string | null`** 显式字段（`null` = 当前无事件，**如实申报**）；(b) 顺手给那 4 处补 `guard_heal` 事件（**行为变更**，违反 B1 零变更）。

**建议**：**(a)**；并把这 4 处"无事件"记为**独立 issue**（`inject-observability-gap`），在 S1+ 的总账里以 `channels.guard.hits` 与 `bySource` 的差值形式暴露出来，但**不在 B1/S3.5 里修**。理由：B1 的判据是零行为变更，补事件会让 L2/L4 失去对照。

### Q4 ⚠️ 线索采纳率如何可靠归因？

**问题**：§3.2.3 的 `adopted` 判定口径未定。若靠"模型输出文本里是否出现 blockId"则极度脆弱（模型常复述但不调用工具）；若靠工具结果匹配，需明确比什么。

**证据**：`KnowledgeSearch` 回执的 `where` 字段含 `docId`/`heading`/`line`/`blockId`；`Read` 的 `file_path` 是**绝对路径**而 offer 的是 `docId`（`spaceId/relPath`）⇒ 需经 `spaceId → root` 映射（`store.getSpaces()` 已提供，`knowledge-search.mjs` 的 `rootOfSpace` 已在用）。

**选项**：
- (a) **内核侧工具参数/结果匹配**（可靠）：`afterToolBatch` 里检查本轮工具调用——`KnowledgeSearch` 的返回 `items[].blockId ∈ offered`，或 `related` 参数 ∈ `offered ∪ offered.related`；`Read` 的 `file_path` 归一化后匹配 `offered` 的 `docId`（经 root 映射）。计 `adopted`，并记录 `chainDepth`。
- (b) 文本匹配模型输出（不推荐）。
- (c) 不做归因，只看"下一轮是否还推同一条"。

**建议**：**(a)**；并明确三条边界：① **同轮内**的推荐不参与本轮采纳判定（推荐在 `beforeIter`，采纳必在其后）；② `duplicate` 类锚点不计采纳；③ 一次调用可采纳多条（计集合而非计数）。

### Q5 ⚠️ 转正与回退的判据、观察期多长？（**原表述有 P0 缺陷，已修正**）

**问题（原表述）**："观察期 ≥30 轮，若 `adoptRate < 20%` 则回退"——**结构上不可执行**：观察期不注入 ⇒ 无线索可采纳 ⇒ `adopted` 恒 0 ⇒ 会得到"引擎发现不成立"的**假结论**，并让 S9.5 的 `recommend-ignored` 在观察期必然误触发（审查发现的 P0，见 §3.2.3）。

**修正后的两阶段判据**：

| 阶段 | 门 | 判据 | 结论 |
|---|---|---|---|
| 一·观察期（`OBSERVE_ONLY=true`） | 先决 | 看 `offeredDryRun` 的**分布**：每轮条数、空间分布、主题命中率、推荐耗时 | 由主 spec §7.3 的"按分位点定默认"定 **`每轮条数上限`**，然后**转正** |
| 二·转正后 | `OBSERVE_ONLY=false` | 累计 ≥30 个任务轮次、`offered ≥ 100` 条后看 `adoptRate` | `adoptRate ≥ 20%` → 保留；`< 20%` → **回退为纯 EL0** |

**硬前置**：判据二只在 `OBSERVE_ONLY === false` 时评估（**禁止**把观察期的 0 当作结论）。

**证据**：主 spec §7.3 的取值流程（阶段一先观测 → 转正）；§14.1 A10（误伤率 ≤ 观测期阈值）。

**回退的形态**：保留 EL0（主题清单），**移除线索段**（不是回退整个 S4.5——去重与三层化的收益与采纳率无关，应保留）。结论写入主 spec §7.3 附录，作为"引擎发现是否成立"的公开记录。

### Q6 与既有测试契约的冲突面（实现前必须点名）

**问题**：哪些既有测试会因本增量而变？漏点名会导致"改完发现 20 个测试红"。

**证据**：§2.4 事实 3 的测试清单。**逐个预判**：

| 测试 | 受影响步 | 预期变动 |
|---|---|---|
| `knowledge-inject.test.mjs` / `-e2e` / `-recall-quota` | S1+（新增字段）/ S4.5（线索层） | 只增断言，**既有断言不改**（`indexSection` 在 legacy 下逐字节不变） |
| `knowledge-scope-plumbing.test.mjs` / `knowledge-session-spaces.test.mjs` | S4.5 | 范围三态语义不变；线索层复用同一 `spaces` ⇒ 应零改动 |
| `fidelity-anchor-inject.test.mjs` / `fidelity-anchor-loop.test.mjs` | S3.5 | `withAnchorTail` 改注册为 **`beforeRequest` 相位**的 `derived` 渲染器 ⇒ **断言应逐字不变**（A17b 的主要载体） |
| 守卫组 9 个 + **审查新增点名**：`engine-continue-heal*` / `engine-lane-heal` / `session-tail-repair` / `orphan-tool-result` / `engine-tool-result` / `loop-controller` / `engine-ask-user` | S3.5 | 注入文案 + wire 事件序列**必须逐字不变**（A17a）；这是 §2.4 事实 3 覆盖矩阵的全部载体，**不得只测守卫组** |
| `memory-search` / `memory-append` / `memory-hygiene` / `read-memory-boundary` + **`server/experience.test.mjs:146-158`** | S4.5（去重 + active + 字节口径） | `buildMemoryIndex` 输出会变 ⇒ **这几处是本增量里唯一需要更新既有断言的组**，必须在 S4.5 的交付说明里列明 |
| `prompt-skills.test.mjs`（server） | S4.5（去重） | bridge 不再注入经验索引 ⇒ 断言 `【个人经验索引】` 出现次数 = 1 |
| **`kernel-tests/workflow-prompt-refresh.test.mjs`**（路径已纠正） | S1+ / S3.5 | 若每轮重算 system 时携带注入快照，需确认"重算仍只换一个变量"的前提不被破坏 |

**建议**：把上表作为 S4.5/S3.5 的**交付前置检查单**；`memory-*` 四件套的断言更新是**已知且必须**的，其余文件原则上零改动——任何额外红都是信号，不得"顺手放宽断言"。

### Q7 一期工作量与并行度是否可承受？

| 步 | 估量 | 可并行 | 阻塞关系 |
|---|---|---|---|
| S1+ | 小（1 处记账 + 字段扩展 + 单测） | 与 S2/S3 **可并行**（不碰同一文件） | 无 |
| S3.5 | **中**（按 Q1 建议 (a) 则降为"新增模块 + 换实现"） | 必须等 S3（B1 应用到 lane） | 依赖 B1 |
| S4.5 | 中（去重 + active + 字节 + 新模块 + 测试） | 必须等 S3.5 | 依赖 S3.5 |
| S9.5 | 小（2 个具名判据 + 误伤对照） | 必须等 S4.5 | 依赖 S4.5（要读 `offered`） |

**建议**：一期**先只推 S1+ → S2 → S3**（观测 + B1），**在 S3 交付后做一次评审再决定 S3.5/S4.5 是否同期**——因为 Q1 的答案会实质改变 S3.5 的形状。

### Q8 本文件与主 spec 的关系（D4，评审时一并定）

**选项**：(a) 保持独立增量 + 主 spec 顶部指针（现状）；(b) 评审通过后合并回主 spec 成为 §17；(c) 把 S1+/S3.5/S4.5/S9.5 四步**直接写进主 spec §12.1 的 S 序列**，本文件仅留 §1-§3 的设计论证。

**建议**：**(c)**。理由：主 spec 是"待转 plan"的执行文档，S 序列是它的主体；增量步若只存在于另一份文件，转 plan 时极易漏（这正是主 spec 反复强调的"静默失效"类型）。

### Q9 ⚠️ EL1 线索层与 unified 抽调层重叠（自审发现，已给约束）

**问题**：见 §3.2 顶部"⚠️ 与既有知识抽调层的关系"。`renderRecall`（unified）与 `buildRecommendSection`（EL1）做的是**同一件事的两种渲染**（按任务上下文检索 → 注入），若同时启用就是**同一批知识块注入两遍**——即本次评估 P0「双注入」问题的新版本。

**证据**：`kernel/knowledge-inject.mjs` 的 `buildKnowledgeInjection`——legacy 分支 `recallSection` 恒为空串（注释明写"legacy 模式下**恒为空串**"），unified 分支走 `store.search` + `renderRecall`。

**选项**：(a) 按 `strategy` **互斥**（legacy 开 EL1 / unified 关 EL1）；(b) 两层都开、靠预算平衡；(c) 本期只做 EL0，EL1 推迟到 unified 转正后再统一。

**建议**：**(a)**，并写入 §5 验收（`A20`）。理由：(b) 直接破坏可归因性；(c) 放弃能力且会让 legacy 长期缺供给。**评审需确认**：unified 转正后是否要把两层渲染收敛为一层（本增量明确列为范围外，见 §3.2 末注）。

### Q10–Q21（独立审查剩余发现 — 已在正文直接采纳，此表为留痕）

> 审查方式：独立 `reviewer` 子 Agent 只读复核（接口自洽性 + 漏点名两类），2026-09-20。审查结论**已直接改写进正文**，下表仅登记"发现 → 落点"，便于评审时核对是否处置得当。

| # | 审查发现 | 严重度 | 落点 |
|---|---|---|---|
| Q10 | 总线 phase 缺 `beforeRequest`：`withAnchorTail` 是**每次 API 请求组装时**的派生操作（`engine.mjs:363` 缓存双键），只在 `beforeIter` 收集会让"前缀不变"与 L4 字节等价**两条都不成立**；主 spec §8.2 步骤①"注入请求面尾部"也无法表达 | P1 | §3.1 增 `beforeRequest` 相位 + A17b 独立断言 |
| Q11 | 增量自定 `totalBudgetBytes` / 未点名既有开关：`settings.memory.inject`（逃生阀）、`resolveInjectMode/resolveInjectBudget`（**预算单一权威在 `knowledge-inject.mjs`**，`settings.mjs:86-90` 明写）、`PONOS_MEMORY_KEYWORDS`（EL1 关键词来源）、`PONOS_LOOP_GUARD=0`（全关路径须做 L4 对照） | P1 | §3.1 新增「既有开关 → 总线映射」表；A15 明确**派生**而非另拍 |
| Q12 | EL1 逃生阀语义未定：A14 用 `PONOS_MEMORY_INJECT=index-only`，风险表又引入 `PONOS_MEMORY_EL1=0` ⇒ 两个开关语义耦合、优先级未定义 | P2 | ✅ **已拍板（D6）**：只留 `PONOS_MEMORY_EL1=0`，**不与 `PONOS_MEMORY_INJECT` 耦合**；A14 措辞已按此定稿 |
| Q13 | A13 在 S1+ 不可达：`channels.static`/`bridge` 的字节账来自 `prompt.mjs` 分段与 `bridge.mjs` append，两处不在原 S1+ 改动清单里 ⇒ A13 无实现载体 | P1 | S1+ 范围显式纳入**只读分段计量**（§4.1 S1+ 改动④）——只读长度不改输出，故仍是零行为变更 |
| Q14 | O4 与主 spec O2/O3 对同一事实两套账，权威关系未定（本增量自己批评过"两套账"） | P2 | §3.3 硬要求 4：O4 定位为**派生视图**，`guard`/`methodology` 字段从 O2/O3 派生 |
| Q15 | 架构图插入点时序错：注入发生在 `phaseHooks`（`[观测]` 上游），画在 `[观测]` 下游会把错误时序带进实现 | P2 | §3.1 挂载点段：并列 `[engine.mjs] phaseHooks`，`[观测]` 纳入 O4 |
| Q16 | §4.1 标题"每步可独立交付/回滚"与 Q7 依赖链冲突（S3.5→S4.5→S9.5 强依赖） | P2 | §4.1 标题改为"增量步可独立提交，**S3.5/S4.5/S9.5 有前置依赖**" |
| Q17 | 漏点 `server/experience.mjs:219/223`（GUI 面板用 `buildExperienceIndex` 算 `inject_bytes`）⇒ 只改内核侧会造成"面板数字 ≠ 内核实际"的新版不一致 | P2 | §3.4 表新增该行 |
| Q18 | 漏点名测试载体四类（`engine-continue-heal*` / `engine-lane-heal` / `session-tail-repair`+`orphan-tool-result`+`engine-tool-result` / `loop-controller`+`engine-ask-user`）与 `server/experience.test.mjs:146-158` | P1 | §2.4 事实 3 重写为覆盖矩阵表 |
| Q19 | 路径错点名：`workflow-prompt-refresh.test.mjs` 在 **`kernel-tests/`** 而非 server 侧 | P2 | §2.4 事实 3 已纠正 |
| Q20 | `tier`/`sessionMode` 维度未点名 ⇒ A13 的 ±5% 断言会把 lean/chat 的正常差异判为缺陷；`bySource.mode` 与 chat/task、Loop 模式三者同名不同义 | P2 | §3.3 总账增 `promptTier`/`sessionMode`；`bySource.mode` → **`loopMode`**；A13 限定同配置 |
| Q21 | `knowledgeRelateMode`（缺省 `'on'`，可关）会让 `it.related` 为空 ⇒ **A18① 可能结构性不成立** | P2 | A18 加前置条件 + S4.5 增"`related` 为空时的降级用例" |

**审查明确的 observation（无需动作，供知悉）**：O4 与主 spec O1/O2/O3 **互补**（主 spec 确无任何"system 分段字节"字段）；`inject-bus.mjs` 与"不新增运行时"**不冲突**（`loop-mode.mjs` 同为纯函数模块）。

---

## 10. 附录：本增量与主 spec 的对应关系

| 主 spec 条目 | 本增量对应 |
|---|---|
| §5.4 架构图 `[观测]`/`[留痕]` 之间 | §3.1 注入总线插点 |
| §7.1 O1/O2/O3 | §3.3 O4 + §5 A13 |
| §8.2 步骤①（摘要注入请求面尾部） | §3.1 通道④（`persist:false`）——**前置 S3.5** |
| §9.3 `MethodologySpec.guards.heal` | §3.1 通道③（`persist:true`） |
| §9.4 L0/L1/L2 | §3.2 EL0/EL1/EL2（同构；EL1 = 线索层） |
| §9.6 "只允许引用引擎内置具名判据库" | §4.1 S9.5 的两个具名判据（`reusable-finding-unrecorded` / `recommend-ignored`） |
| §9.8 首批下沉 4 项 | §4.1 S9.5 增第 5 项 `experience-sediment` |
| §9.10 引擎约束 vs 提示词约束 | §3.2 + §3.2.3：引擎默认发现 + 采纳率可测（同原理的另一半） |
| §14.1 A11（成本可量化下降） | §5 A13/A15（使 A11 可归因） |
| §6.3 L1/L2/L3 回归锁 | §5 A17a/A17b（L4 注入等价，分相位） |
