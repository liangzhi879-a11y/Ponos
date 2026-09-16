# Spec：会话知识范围 —— 会话模式关联「经验库之外」的知识库（2026-09-15）

## 0. 定位与需求

**来源**：`docs/待处理清单.md` 的 P1 条目 ——

> 会话模式关联经验库之外的知识库（经验库是给执行任务用的，其他的知识库是用户的知识储备），
> 知识库需**验证真实 agent 可调用性**，并考虑**数据膨胀的应对措施**。

**三条款拆解**：

| 条款 | 含义 | 本 spec 的应答 |
|---|---|---|
| 关联 | 会话要能显式指定"本次会话可用哪些知识库" | §3.2 会话知识范围 + §3.7 GUI 入口 |
| 可调用性验证 | 不是"配了就算"，要证明 agent 真能检索到 | §3.4 工具层 + §3.5 提示词 + §6 真进程验收 |
| 膨胀应对 | 用户的储备库体量不可控，不能拖垮上下文/启动 | §3.6 四道护栏 + §3.3 注入面收敛 |

**依赖**：知识内核 S1（store/索引）→ S3（`kernel/knowledge-inject.mjs` 统一注入）→ S5（关联锚点）
均已落地；本 spec **不改索引格式、不改 GUI 面板结构**，只做"范围（scope）"这一条新语义。

**不在本轮范围（显式非目标）**：

- 写通道（`KnowledgeImport` / `KnowledgeDelete`）不做范围收敛 —— `KnowledgeImport` 支持"库不存在则新建"，
  先收敛会把"新建一个库"直接判死，语义冲突；留作后续独立条目。
- 不改 `FILE_LIMIT_PER_SPACE`（5000）/ `MAX_BLOCKS_PER_DOC`（2000）等**索引层**护栏数值。
- 不做"按会话范围重建索引"——`.index` 是**全局共享缓存**，按子集重建会把全局索引截断成部分视图
  （别的消费者随后每次冷启动都判定 stale → 反复重建，是纯性能倒退）。故范围收敛只作用于
  **注入面与检索工具面**，索引始终全量。

## 1. 现状锚点（源码核对，2026-09-15）

| 事实 | 坐标 | 结论 |
|---|---|---|
| 空间发现 | `kernel/knowledge.mjs:269` `discoverSpaces()` | 内置（`experience` / `session-memory` / `skill-experience`，见 `shared/knowledge-core.mjs:785`）+ 用户空间（`source:'user'`）+ 知识包（`source:'pack'`） |
| 检索白名单 | `kernel/knowledge.mjs:957` `searchInner({ spaces: only })` | `only` 为数组且非空 → `Set` 白名单；否则 `allow=null` = **不过滤（全空间）** |
| 注入入口 | `kernel/knowledge-inject.mjs:93` `buildKnowledgeInjection({ spaces = null })` | 形参存在，但 `kernel/cli.mjs:826` 的调用点**没传 spaces** ⇒ unified 注入事实上检索全空间 |
| 注入检索 | `kernel/knowledge-inject.mjs:144` `store.search({ ... spaces ... })` | 传 `null` = 全空间；预算 `DEFAULT_TOTAL_BUDGET=4096`（:20） |
| 注入模式 | `resolveInjectMode`（`knowledge-inject.mjs:38`） | 缺省 `legacy`（只注入经验目录行，**不碰知识库**）；`unified` 才走块级抽调 |
| 工具：结构化检索 | `kernel/tools.mjs:1487` | `spaces: input.spaces?.length ? input.spaces : null` ⇒ 模型可指定任意空间，**无会话边界** |
| 工具：经验检索 | `kernel/tools.mjs:1407` | `scope` 映射 `personal→['experience']` / `project→['project-*']` / `all→null` |
| 工具注册表 | `kernel/tools.mjs:1079` `createToolRegistry(...)`；由 `kernel/engine.mjs:785` 调用 | 会话级参数走 `opts` 逐键显式转发；`dynamicTools` 有先例用 setter 后设（`tools.mjs:1785`） |
| CLI 参数 | `kernel/cli.mjs:133` switch（未知 `--` **静默忽略**，:256 注释） | 新 flag **必须登记**，否则被无声吞掉（本仓库反复踩过：`--spaces` / `--confirm` / `--around`） |
| 提示词组装 | `kernel/prompt.mjs:156` `composeSystemPrompt({ ..., memory })`，memory 块 push 于 `:219` | 新块加在 memory 之前即可（chat 模式整体早退，天然不受影响） |
| 会话初始化回显 | `kernel/cli.mjs:875` `wire.system('init', {...})` | 只增字段即可（GUI 用它校准） |
| 桥 spawn | `server/bridge.mjs:1129` `getOrCreateSession(sid, cwd, resumeId, systemPrompt, model, compactCount, mode)`；args 组装 :1156–1250；env :1259–1278 | 新增会话级透传键**必须两端同改**（前端 `conversationSpawnFields` + 桥签名），否则静默失效 |
| 前端 spawn 字段 | `src/hooks/useYFWCLI.ts:343` `conversationSpawnFields()` | `send` 与 `sendAnswer` **同源**，改一处两条路径都通 |
| 会话模型 | `src/types/index.ts:130-160`（`Conversation`）；`src/stores/chatStore.ts:1441` `version: 3`、`migrate` :1448、`partialize` :1504 | 新字段须带一次版本迁移 |
| 面板挂点 | `src/components/knowledge/KnowledgeSidebar.tsx:66-115`（空间下拉 + 空间信息栏）；`src/components/chat/SessionModeBar.tsx:29-45` | 关联开关放"空间信息栏"（作用于当前空间，与删库同级），会话态指示放会话模式徽标条 |
| 既有膨胀护栏 | `knowledge.mjs:47 FILE_LIMIT_PER_SPACE=5000`、`:413 MAX_BLOCKS_PER_DOC=2000`（截断留痕 `:538`）、`knowledge-inject.mjs:20/22/24/26` | 索引层已有护栏，本轮只补**注入/工具层** |

## 2. 关键结论

1. **当前是"没有边界"，不是"边界错了"**：unified 注入与 `KnowledgeSearch` 都按全空间工作。
   用户的储备库（`source:'user'` / `pack`）目前会被**无条件**索引进索引、并（unified 下）参与
   每次请求的抽调打分——既是上下文成本，也是"Agent 越过会话意图去翻用户私人库"的越界。
2. **收敛必须双层同源**：注入（被动通道）与工具（主动通道）若口径不同，模型会看到
   "注入里没有、检索说没有权限"的矛盾。两者共用**同一个范围对象**，由 cli 一处解析。
3. **缺省必须是"经验/记忆内置空间"**：这正是 S3 spec §3.1 早已写定、但从未实现的默认
   （`spaces` 缺省 = `active 且 source ∈ {experience, memory}`）。本轮把它落地，且**只在
   unified 下改变注入内容**；legacy 用户（当前默认）注入内容逐字节不变 ⇒ 升级零突变。
4. **工具层不在范围内时"出声"，不静默空结果**：越界请求返回可执行的指引（把库关联到本会话 /
   改用范围内空间），而不是一个空命中让模型自己编原因。
5. **范围为"允许集"，不是"唯一集"**：范围 = 内置经验类空间 ∪ 显式关联空间。经验库**永远**在范围内
   （它是给执行任务用的，见需求原文），不能被关联操作关掉。
6. **生效时机 = 内核启动**：范围随 spawn 冻结。变更关联后，桥在**下一次发送消息时**以
   `--resume` 重启内核（复用既有"模型热切换 reap 重启"机制），上下文不丢、范围即时生效。

## 3. 设计

### §3.1 概念

**会话知识范围（session knowledge scope）** = 该会话的 agent 可读/可注入的空间白名单：

```
scope = 内置经验类空间（experience、session-memory + 其中实际存在的）
      ∪ 用户显式关联的空间（0..MAX_ASSOC_SPACES 个，必须真实存在且可读）
```

`scope` 与"当前选中的空间"（GUI 浏览态）、"检索 scopeAll 开关"（面板内二选一）**互不影响**：
前者是 agent 边界，后者是人的浏览行为（`KnowledgeScopeToggle.tsx` 头注同义）。

### §3.2 解析（唯一实现，cli 与 GUI 共用口径）

新函数（落在 `kernel/knowledge.mjs`，与 `discoverSpaces` 同处）：

```js
resolveSessionKnowledgeScope({ configDir, requested = null }) → {
  spaces: string[],        // 白名单（恒非空：至少内置经验类空间）
  builtin: string[],       // 内置经验类空间 id
  associated: string[],    // 生效的关联空间 id（保序去重）
  missing: string[],       // requested 里不存在/不可读的 id（出声，不静默丢）
  dropped: string[],       // 超 MAX_ASSOC_SPACES 被忽略的 id（出声）
  truncated: boolean,
}
```

- `requested` 为空/非数组 → `associated=[]`（= 只用自己的经验库，缺省行为）。
- 内置经验类 = `source ∈ {'experience','memory'}` 的内置空间（`skill-experience` 为预留空库，
  不进缺省白名单；它若存在且被用户显式关联则生效）。
- 上限 `MAX_ASSOC_SPACES = 8`：超出部分进 `dropped`（**不报错**——关联是用户操作，
  多出来的应当被忽略但必须可见）。

### §3.3 注入层

`kernel/cli.mjs` 注入段（:826）改为传 `spaces: scope.spaces`。

- **unified**：块级抽调只在范围内打分（越界库不再进上下文）。
- **legacy**：注入的是 `buildMemoryIndex`（个人经验目录行），与 scope 无关 —— **输出逐字节不变**。
  这是"升级零突变"的保证，也是本轮不触碰默认行为的原因。

### §3.4 工具层（可调用性的正面 + 反面）

`createToolRegistry` 新增可选参数 `knowledgeSpaces = null`（`engine.mjs:785` 显式转发
`opts.knowledgeSpaces`）。**三态语义**（与注入层同一套口径，不得各写一套）：

| 取值 | 语义 |
|---|---|
| `null` / 非数组 | **不限**（嵌入/测试场景的既有行为，零回归锁） |
| 非空数组 | 白名单：请求空间必须在其中 |
| 空数组 | **本会话没有可检索的知识库** → 一切检索被拒（fail-closed） |

> **空数组必须单列**（评审补正）：早先实现写成 `Array.isArray(x) && x.length ? Set : null`，
> 于是当内置经验类空间一个都不存在（`memory/personal` 被删、或首启未经 `ensurePersonalDir`）
> 时，范围会从"空白名单"退化成"不限" —— 注入层与工具层**同时**把用户储备库重新放进来，
> 范围边界在最该收紧的场景里静默失效。范围问题上的默认必须 fail-closed。

| 工具 | 改动 | 越界时 |
|---|---|---|
| `KnowledgeSearch` | 请求 `spaces` 必须在范围内；请求未给则用范围全集 | 明确拒绝（见下），**不返回空命中** |
| `MemorySearch` | `all` → 范围全集（原来是 `null`）；`personal` → `['experience']`（恒在范围内）；`project` → 原样（既有空空间语义） | 同左 |

- **判定粒度：请求中的任一项越界即整体拒绝**（不做"丢掉越界项、只查剩下的"）。交集式放行会让
  模型以为它查过了那个库、并据"查不到"下结论——那是最贵的假阴性。拒绝时点名越界项，
  模型重发一次（只带范围内空间）即可完成原意图，代价小于一次错误结论。
- `related` 展开同样受约束（blockId 形状 `<spaceId>/<path>#<n>`，空间前缀一眼可判）。
  该判定是**双保险**：关联边本身按 `bySpace` 分组、连接目标用 `toDocId(spaceId, …)` 构造
  （`shared/knowledge-core.mjs:742`），结构上跨不了空间；显式判定防的是将来结构被改动。

越界文案（统一 helper，一处措辞）：

```
空间「<id>」不在本会话范围（当前范围：experience、session-memory、<已关联…>）。
请勿重试同一调用：改用范围内的空间检索，或请用户在知识面板把该库「关联到当前会话」。
```

空白名单另有专用文案（此时"范围里能改用的空间"不存在，指引只能落在用户动作上）：
`本会话没有任何可检索的知识库 …… 请用户确认个人经验库存在，或在知识面板关联需要的库`。

`isError: true`（模型会据此停止重试并转告用户）；同时把可用范围列出来，让模型能换策略。

### §3.5 提示词（让"可调用性"对模型可见）

`composeSystemPrompt` 新增 `knowledgeScope` 入参，渲染在 memory 块之前：

```
【本会话知识库】可检索：个人经验、会话记忆、（已关联）<name>②。<未关联：项目知识库>
未关联的库不在本会话范围内；用户要用时请其先在知识面板「关联到当前会话」。
（KnowledgeSearch 的 spaces 参数只能取上述范围内 id）
```

- 只列**未关联但可关联**（`source ∈ {user, pack}`，与 GUI 开关同判据）的库名，最多 12 个 + `等共 N 个`；
  无未关联库时省略该括号。**必须与 GUI 开关同判据**：列出 GUI 给不出开关的空间（如尚未启用的
  `skill-experience`）等于让模型指一条走不通的路，用户找不到开关只会怀疑功能坏了。
- **task 与 chat 两条路都渲染**（评审补正）：chat 模式下 `KnowledgeSearch` 是放行的
  （S3 D2：只读检索不吃"纯聊不做本地执行"的隔离承诺），那么"能用哪些库"就必须同样可见，
  否则模型只能猜——猜错即被拒，用户看到的是"聊天不会用我的知识库"。
- `knowledgeScope` 缺省 `null` → 该块不出现（嵌入场景零影响）。

### §3.6 数据膨胀应对（四道护栏 + 观测）

| # | 护栏 | 落点 | 行为 |
|---|---|---|---|
| G1 | **注入面收敛** | §3.3 | 储备库默认不进上下文（最大一项：省的是每次请求的固定成本） |
| G2 | **关联数量上限** 8 | `resolveSessionKnowledgeScope` | 超出忽略 + 进 `dropped`；提示词与 stats（`spacesDropped`）均可见 |
| G3 | **单库抽调配额** 4 条 + **候选池加宽** | `renderRecall` + `candidatePool` | 一个巨型库无法刷屏整个抽调层；`stats.spacesCapped` 记录被压制的空间 |
| G4 | **关联时的大库提示** | GUI 关联开关旁 | `docCount > LARGE_SPACE_DOCS(1000)` → 提示"该库较大，注入受预算限制，建议按关键词按需检索" |
| 观测 | stats / metrics | `knowledge-inject.mjs` stats + `.index/metrics.json` | 新增 `scope` / `spacesDropped` / `spacesCapped`；`--knowledge stats` 与 `GET /knowledge/stats` 自动透出（既有通道） |

**G3 是"配额 + 候选池"两件套，缺一即失效**（实测缺口，由 `knowledge-recall-quota.test.mjs` 当场抓到）：

- **为什么要配额**：`RECALL_CANDIDATES=8` 限了总量、`MAX_BLOCKS_PER_DOC=2` 限了单文档，但
  **分布**无约束——8 条候选全来自同一个巨型库时，抽调层退化为"某一个大库的摘要"，
  其余已关联的库完全不可见（用户刚关联的第二个库"好像没生效"）。4 = 总量的一半，
  保证至少两个库有机会出现，同时小库（命中 ≤4 条）行为不变。
- **为什么要加宽候选池**：配额是在**候选之后**裁剪的。只取 8 条候选时，一个 8 篇的大库能把候选
  全部占满，小库连候选都不是——配额根本轮不到它，上述现象**依旧发生**。故候选池取
  `MAX_RECALL_PER_SPACE × 范围空间数`（下限 8、上限 64）：保证"每个已关联且真有命中的库，
  至少占得到自己那 4 个候选位"。**单测抓到的问题正是"只有配额、没有加宽"**。
- **配额只在受范围约束时生效**（`spaces` 为数组）：未指定范围的路径（嵌入/测试/不限）保持
  改动前行为——配额是为"多库并存防一库刷屏"设计的，单库场景没有可防的对象。
- `spacesCapped` 只记"**本该渲染、却因配额被砍**"的空间：判定放在 blockId 去重、每文档配额、
  无标签 entry 过滤**之后**，否则会把本来就不会渲染的块记成"被压制"（用户会去找一个并不存在的
  配额问题）。

### §3.7 生效时机与 GUI 入口

- **关联关系存储**：`Conversation.knowledgeSpaces?: string[]`（会话级，随会话持久化）。
- **透传链**：`conversationSpawnFields`（`useYFWCLI.ts:343`）→ WS `send` payload → 桥
  `getOrCreateSession(..., knowledgeSpaces)` → `--knowledge-spaces a,b`。
- **变更即时生效**：桥记录 spawn 时的范围签名 `_spawnKnowledgeSig`；下次 send 时不一致 →
  沿用"模型热切换"的收割路径（`taskkill` + 删除会话条目 + `--resume` 重建）。
  签名一致时**不做任何额外动作**（零回归）。
- **GUI**：
  - `KnowledgeSidebar` 空间信息栏（与"删整库"同级）加「关联到当前会话」开关 + 大库提示（G4）。
  - `SessionModeBar` 在已关联时显示 `📚 N` 徽标（title = 库名清单）；未关联不占版面。
  - 关联后内核范围在**下次发消息**时生效：UI 文案明说（避免"点了没反应"的误判）。

## 4. 契约增量（只增不改）

| 层 | 字段/参数 | 形态 | 缺省语义 |
|---|---|---|---|
| CLI | `--knowledge-spaces <id,id>` | 数组（逗号分隔） | 缺省 = 只用内置经验类空间；空值 = 未关联 |
| 工具注册表 | `createToolRegistry({ knowledgeSpaces })` | `string[] \| null` | `null` = 不限（现状）；`[]` = 无可检索库（fail-closed） |
| engine | `opts.knowledgeSpaces` | 同上 | 未传 = `null` |
| 提示词 | `composeSystemPrompt({ knowledgeScope })` | `{names, unassociated} \| null` | `null` = 不渲染 |
| 注入 | `buildKnowledgeInjection({ spaces, spacesDropped })` | `string[] \| null` | `null` = 不限；`[]` = 不抽调 |
| init 帧 | `knowledge_spaces` | `string[]` | 恒有（便于 GUI/诊断校准） |
| 注入 stats | `scope` / `spacesDropped` / `spacesCapped` | `string[] \| null` / `string[]` / `string[]` | `scope: null` = 本次未使用范围（legacy） |
| 桥 | WS `send.knowledgeSpaces` | `string[] \| undefined` | `undefined` = 缺省范围 |
| 会话模型 | `Conversation.knowledgeSpaces` | `string[] \| undefined` | `undefined` = 未关联 |

## 5. 决策记录

- **D1 缺省收窄（而非"缺省全开 + 关联收窄"）**：需求原文把非经验库定义为"用户的**知识储备**"——
  储备的默认语义是"按需取用"，不是"每次都塞进上下文"。且收窄只影响 unified（非默认）注入，
  legacy 用户零突变。**回退**：把库关联到该会话即恢复（GUI 一次点击）。
- **D2 工具层也收窄**（不只是注入）：只收注入会让"关联"名不副实——agent 仍可 `KnowledgeSearch`
  翻遍用户私人库。收窄后"关联"才是有意义的授权动作。**风险与回应**：老会话/老技能若硬写
  `spaces: ['某用户库']` 会收到越界提示——故提示必须**可执行**（告诉用户点哪里），而不是"没有数据"。
- **D3 越界报错而非空结果**：空结果无法与"该库确实没有这条知识"区分，模型会反复换词重试或编造原因
  （本仓库既有教训：静默降级比报错难排查得多）。
- **D4 范围含"允许集"语义、经验库不可被关联操作移除**：经验库是执行任务的基础设施；
  允许用户"关掉经验库"只会制造"agent 变笨但不知道为什么"的故障。
- **D5 变更靠 reap 重启生效**：复用已验证的模型热切换路径，避免新增跨进程控制通道
  （新通道 = 新的静默失效面）。
- **D6 不按范围重建索引**：见 §0 非目标。索引是全局共享缓存，子集重建 → 反复 stale 重建（性能倒退）。

## 6. 验收标准

1. **范围内可调用**（真进程）：临时 configDir 下建用户空间 `docs` + 一篇含关键词的文档；
   带 `--knowledge-spaces docs` 启动内核、unified 注入 → 提示词出现该库已关联声明，
   `PONOS_MOCK_SYS_PROBE` 探针命中"相关知识抽调"（= 块级抽调真的从该库取到了内容）。
2. **范围外不可调用**（真进程/单测）：不带 `--knowledge-spaces` 时，注入层**不含**该库内容；
   `KnowledgeSearch({spaces:['docs']})` 返回越界提示（含"关联到当前会话"指引），**非**空命中。
3. **提示词可见性**：`knowledgeScope` 渲染出"可检索范围 + 未关联库名"；chat 模式不出现该块。
4. **膨胀护栏**：9 个关联请求 → 生效 8 个、`dropped` 出声；单空间 6 条命中 → 抽调用 4 条；
   stats 三项新字段有值且落 `metrics.json`。
5. **前端**：`Conversation.knowledgeSpaces` 持久化 + v3→v4 迁移不丢旧数据；spawn 字段透传单测；
   `--knowledge-spaces` 参数登记有静态守卫（防静默吞掉）。
6. **质量门禁**：`npm run typecheck` 通过；`kernel-tests/knowledge*.test.mjs`、`server/*.test.mjs`、
   `src/**/*.test.ts` 相关用例全绿（含既有 296 项知识用例零回归）。

## 7. 风险与回退

| 风险 | 影响 | 缓解/回退 |
|---|---|---|
| 缺省收窄让老会话"搜不到用户库" | 体感能力缩水 | 越界提示给出可执行指引 + GUI 一次点击关联；unified 非默认 |
| 桥签名字段漏登记（已知病史） | 关联静默无效 | 两端同改 + 静态守卫测试（验收 5） |
| reap 重启误伤进行中的轮次 | 回答中断 | 仅在 send 入口比对签名（与模型热切换同刻）；`--resume` 保上下文 |
| G3 配额改变既有抽分布 | 既有测试断言漂移 | 先跑 `knowledge-inject.test.mjs`；若断言被打破，评估是"测试过紧"还是"设计越界"再定 |
| 提示词新增块占用预算 | 上下文成本 | 只列未关联库名（一行内），无库可列时不渲染 |

## 8. 独立评审与收口（2026-09-15）

实现完成后经**独立审查者**（不参与实现）按 spec 逐条核对，结论与处置：

| # | 评审发现 | 定级 | 处置 |
|---|---|---|---|
| 1 | G2「超限丢弃」的上报只有模块级证据：`spacesDropped` 在 cli 的接线无人断言，删掉后全部测试仍绿 | 必修（假绿） | 已在 `knowledge-scope-plumbing.test.mjs` 补接线断言 |
| 2 | **范围 fail-open**：内置经验库不存在时空白名单退化为"不限"，注入层与工具层同时放行全空间 | 必修（边界） | 注入层与工具层统一三态语义（§3.4），空白名单 → fail-closed；补 3 条测试 |
| 3 | spec 写"chat 模式不出现该块"，实现是 chat 也渲染（后者正确：chat 下检索放行） | 必修（证据失真） | 已改 spec 并补 chat 双态探针断言 |
| 4 | 重启内核（reap）分支无行为测试——判错的后果是误杀在跑的轮次或改了不生效 | 建议 | 已补 `server/knowledge-spaces-sig.test.mjs`（5 组签名/归一断言） |
| 5 | G3 配额在"不限范围"路径也生效，破坏零回归承诺 | 建议 | 已把配额限定在 `spaces` 为数组时 |
| 6 | `spacesCapped` 记账偏移：判定早于"无标签 entry"过滤，会把不会渲染的块记成被压制 | 建议 | 已把配额判定移到两道过滤之后 |
| 7 | 含逗号的库 id 无法通过 `--knowledge-spaces` 表达，且只留一行 warn | 建议 | 桥侧归一即丢弃并出声（不切碎成不存在的库） |
| 8 | `unassociated` 会列 GUI 给不出开关的空间 ⇒ 模型指路无门 | 建议 | 已按 `source ∈ {user,pack}` 过滤（与 GUI 开关同判据） |
| 9 | 工具描述仍写"见 /knowledge/spaces" | 建议 | 已改为"仅限本会话知识范围内的 id" |
| 10 | GUI 徽标在"库已被删除"时仍计数 | 建议（已知限制） | 本轮不改：计数反映会话的**配置**（与传给内核的一致），库是否存在由知识面板体现；记此备查 |

**评审另发现（本项目自查，非评审意见）**：G3 最初只有"配额"没有"加宽候选池"，
由一个 8 篇大库 + 小库的夹具当场抓出——配额在候选之后裁剪，大库能把候选全部占满、小库连候选都不是。
配额必须与候选池配对（§3.6），单靠任一方都是假护栏。

评审**已确认无问题**（留痕）：知识注入/检索/注册表的调用点穷尽（不存在绕过范围的第三条路）；
关联锚点与 `related` 展开结构上跨不了空间（新增判定为双保险）；参数名 cli↔bridge 逐字一致；
reap 不循环（会话条目单一创建点、前端 send/answer/插话/revive 同源）；迁移不动无关字段；
配额计数器在 `continue` 分支不漏计；真进程探针的否定针脚取库内正文而非 query 词（不假绿）；
legacy 注入逐字节不变；`spaces=null` 路径与改动前一致。

