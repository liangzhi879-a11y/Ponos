# Spec：AI 集成闭环（S3）—— 检索注入收敛与知识工具（2026-09-13）

## 0. 定位

依赖 S1 的 `searchKnowledge()` / `experienceAdapter`；**不改索引格式、不动 GUI 结构**。
本子项目解决的是"知识造出来了，AI 怎么用上、怎么续写"的闭环问题。

## 1. 现状锚点（源码核对）

现有**三套并行**的检索/注入路径，评分逻辑互不相同：

| 路径 | 实现 | 触发 | 粒度 | 问题 |
|---|---|---|---|---|
| 索引式注入 | `buildExperienceIndex(maxBytes=4096)` `server/experience.mjs:160`、`kernel/memory.mjs:74` | 会话启动 | 主题文件 | 只给"目录行"，模型还得自己 Read |
| 关键词抽调 | `buildRelevantMemory(keywords, maxBytes=2048)` `kernel/memory.mjs:151` | 用户消息关键词 | 主题文件 | `keywordScore` 命中即入选，无向量语义 |
| 工具检索 | `searchLocalMemory()` `kernel/memory-search.mjs:34`（`MemorySearch` 工具） | 模型主动调用 | 条目 | **每次全量读文件 + 全量现算向量**，O(N) |
| 图谱检索 | `graphStore.search({query, keywords, topK})` `kernel/graph.mjs:186` | 未接入主链路 | 条目 | 与上面三者结果口径不一致 |

三者的**排序与预算互不知情**，同一会话可能同时注入三份互相重复的内容。
另：`kernel/graph.mjs:2-10` 已预留 `IGraphBackend` 接口（`search`/`write`/`health`），
配置位 `PONOS_GRAPH_BACKEND=local|external`——S3 是把这个预留位**真正用起来**的时机。

## 2. 关键结论

1. **收敛，不是叠加**：S1 的 `searchKnowledge()` 已能覆盖上表后三行的能力（块级 + 4 路融合评分），
   故 S3 让 `graphStore.search` 与 `searchLocalMemory` **退居为 S1 检索引擎的适配器**，口径统一。
2. **注入保持双层，但共用一次检索**：
   - **索引层**（低成本、全局视野）：仍注入"主题|标签 → 文件"的目录行，告诉模型"有什么"；
   - **抽调层**（高成本、高精度）：改用**块级**结果，告诉模型"这条具体是什么"。
   两层由同一次 `searchKnowledge()` 产出，避免重复扫描。
3. **块级抽调是最大质量增益**：现有抽调注入整条经验（含全文），2048 字节预算常只装下 2-3 条；
   块级可按摘要排序后**按预算装更多高相关条目**，且包含块级来源定位便于模型按需 Read 全文。
4. **写入必须经过统一 API**：`appendMemoryEntry`（`kernel/memory.mjs:64`）已是唯一写入点且已带
   `graphStore` 参数——S3 把该参数泛化为 `knowledgeIndex`，写入后**增量更新索引**，
   而不是现在的"下次检索前重建"。
5. **工具是模型的主动通道，注入是被动通道**，两者共用同一评分与 `spaces` 过滤语义，
   否则模型会看到"注入说相关、检索说不相关"的矛盾。
6. **契约纯增量**：`MemorySearch` 工具**保留**（老会话/老提示词仍在引用），内部转发到新实现；
   新增 `KnowledgeSearch` 作为推荐通道。

## 3. 注入管线设计

### §3.1 统一入口

```js
// kernel/knowledge-inject.mjs
buildKnowledgeInjection({
  query,          // 用户消息
  keywords,       // 抽取的关键词（沿用现有抽取逻辑）
  spaces,         // 参与注入的空间（默认：active 且 source ∈ {experience, memory}）
  indexBudget,    // 索引层字节上限（默认 4096，沿用 experienceInjectMaxBytes）
  recallBudget,   // 抽调层字节上限（默认 2048）
}) → { indexSection, recallSection, stats }
```

`stats = { indexLines, recallBlocks, spaces, elapsedMs, indexAge }`（供观测与调试，不进上下文）。

### §3.2 抽取层（抽调）

评分沿用 S1 §5.4；额外约束：

- 同一文档最多贡献 **2 个块**（防单文档刷屏）；
- 已在索引层出现的主题文件，其条目在抽调层**不重复注入**（去重以 `blockId` 为准）；
- 输出串头保持既有风格：`【相关知识抽调】…（格式：-[空间|标签] 摘要 -- 全文）`，
  与 `【个人经验索引】` 视觉一致，模型无需重新学习格式。

### §3.3 预算与降级

- 总预算 = `experienceInjectMaxBytes`（沿用既有配置项，不新增用户可见配置）；
- 索引层与抽调层按 2:1 分配，任一层未用满可让渡给另一层；
- 检索超时（>500ms）或索引不可用 → **退回纯索引层**（模型仍可用工具主动检索），
  绝不阻塞会话主流程（对齐 `kernel/health.mjs` 静默降级纪律）。

## 4. 工具设计

### §4.1 `KnowledgeSearch`（新，推荐）

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 语义查询（走向量） |
| `keywords` | string[] | 精确关键词（走关键词路） |
| `spaces` | string[] | 限定空间；缺省 = 全部可读空间 |
| `topK` | number | 默认 5，上限 10（沿用现有上限） |
| `mode` | `'snippet' \| 'full'` | 默认 `snippet`（省上下文）；需全文时显式 `full` |

返回：结构化 items + 一句话摘要头；**不含**未命中的空间说明（省 token）。

### §4.2 `MemorySearch`（保留，转发）

签名不变（`query`/`topK`/`scope`），内部映射：

| 旧参数 | 新语义 |
|---|---|
| `scope='personal'` | `spaces=['experience']` |
| `scope='project'` | `spaces=['project-*']` |
| `scope='all'`（默认） | `spaces=null`（全部可读） |

老提示词/老会话零改动即可获得块级检索能力；文档注明"推荐改用 `KnowledgeSearch`"。

### §4.3 工具注册

`kernel/tools.mjs` 新增 `KnowledgeSearch`；`server/bridge.mjs:1016` 的 `CHAT_DISALLOWED` 需同步
评估是否放行（当前会话模式禁用一批工具——**知识检索是只读操作，建议放行**，与 `MemorySearch`
的现状保持一致）。

## 5. 沉淀闭环（写入）

```
用户偏好/业务事实 → captureMemoryCandidates()（kernel/memory.mjs:186，启发式捕获）
                  → appendMemoryEntry({ knowledgeIndex })   ← 唯一写入点
                  → markdown 权威写入 → 索引增量更新该文档
```

- **增量更新**：写完后只重切该文档 + 更新 `inverted.jsonl` 中受影响的 gram posting
  （全量重建留给 `--knowledge-reindex`）；
- **写入后可见性**：同一会话的下一轮即可检索到刚沉淀的经验（现有实现依赖下次启动重建，
  有"刚记下就查不到"的隐患）；
- **会话记忆纳入**：`memory/session/<id>.md` 已由 `kernel/cli.mjs:588` 写入，S3 将其注册为
  `session-memory` 空间的写入目标之一（跨会话检索历史工作记忆）。

## 6. 观测

新增 `--knowledge-stats` 输出（S1 已定义端点，S3 补指标）：

| 指标 | 用途 |
|---|---|
| `inject.indexLines` / `inject.recallBlocks` | 验证双层预算是否合理 |
| `inject.hitRate` | 抽调命中率（长期为 0 说明关键词抽取或评分有问题） |
| `index.buildMs` / `index.ageMs` | 索引健康 |
| `search.elapsedP50/P95` | 检索性能（目标：P95 < 100ms，万级块） |

## 7. 兼容与退场路径

| 组件 | S3 处置 | 最终归宿 |
|---|---|---|
| `graph.jsonl` / `createGraphStore` | 保留为 legacy 实现，主链路不再调用 | 保留不动；`PONOS_GRAPH_BACKEND` 语义不变（它管的是 graph.mjs 自身的后端，S1 引擎是独立新链路，不占用该配置位） |
| `buildRelevantMemory` | 保留导出（有单测+可能被外部引用），主链路不再调用 | 标注 `@deprecated`，下一大版本删除 |
| `buildExperienceIndex`（server 版） | 保留（GUI 经验面板仍用） | 面板简化后（S2 §7）改为读 `/knowledge/spaces` |
| `searchLocalMemory` | 保留为薄适配器（转发 `KnowledgeSearch`） | 保留，成本极低 |

**退场纪律**：任一组件删除前必须先确认零引用（`grep` + 单测），且不在同一提交里删除与替换。

## 8. 验收标准

- [ ] 同一 query，`KnowledgeSearch` 与注入抽调返回的 top-3 `blockId` **一致**
- [ ] `MemorySearch` 老签名在三档 `scope` 下均可用且结果等价于新实现
- [ ] 新经验写入后，**同一会话下一轮**即可被检索到（无需重启）
- [ ] 注入总字节数不超 `experienceInjectMaxBytes`（含两层，单测断言）
- [ ] 检索超时/索引损坏时，会话正常继续（注入为空，工具仍可用）
- [ ] `--knowledge-stats` 输出上述指标
- [ ] 注入内容无重复块（`blockId` 去重单测）
- [ ] `npm test` 全绿；会话模式（`CHAT_DISALLOWED`）下 `KnowledgeSearch` 可用性符合决策

## 9. 非目标（YAGNI）

embedding 语义检索、跨库自动摘要、模型自主决定"该记什么"（仍走启发式 + 显式提示词）、
注入内容的多轮衰减策略、知识质量自动评分、图表/代码块的特殊注入格式。

## 10. 决策记录（2026-09-13 已确认）

| # | 决策 | 确认结果 |
|---|---|---|
| D1 | 注入策略切换方式 | **灰度**：配置位 `knowledgeInjectMode: 'legacy' \| 'unified'`，默认 `legacy`，验证后切 `unified`；出问题一键回退 |
| D2 | 会话模式是否放行 `KnowledgeSearch` | **放行**（只读操作；与 `MemorySearch` 现状一致，`CHAT_DISALLOWED` 不含它） |
| D3 | 抽调层粒度 | **自适应**：优先摘要（省预算），预算有余量时对高分块升级为全文 |

---

## 11. 修订记录（S3 实施前源码复核，2026-09-13）

复核依据：worktree `knowledge-s1`（S1+S2 已落地）对 `kernel/` `server/` `shared/` `src/` 逐条 grep + 读码。
S2 的教训是 spec 里的行号/前提会漂移，本次复核发现 **14 处**，其中 **3 处会导致返工**（§11.2 的
R1/R2/R3）。**本节与正文冲突时，以本节为准。**

### 11.1 事实修正（行号与签名，无行为影响）

| 原表述 | 实际情况 |
|---|---|
| `buildExperienceIndex(maxBytes=4096)` `server/experience.mjs:160` | `:161`，签名实为 `(maxBytes = 4096, only = null)`——多一个"按主题过滤注入"的可选参数 |
| `buildMemoryIndex(maxBytes=4096)` `kernel/memory.mjs:74` | `:66` |
| `buildRelevantMemory(keywords, maxBytes=2048)` `kernel/memory.mjs:151` | `:107` |
| `appendMemoryEntry` `kernel/memory.mjs:64` | `:50` |
| `captureMemoryCandidates()` `kernel/memory.mjs:186` | `:131` |
| `server/bridge.mjs:1016` 的 `CHAT_DISALLOWED` | `:1017`；且**权威表在 `kernel/tools.mjs:1053`**，bridge 那份是"旧缓存内核"的兼容拷贝 |
| `searchLocalMemory()` `kernel/memory-search.mjs:34` | ✅ 一致 |
| §6「`--knowledge-stats`（S1 已定义端点）」 | **命名不存在**：S1 实现的是聚合 CLI `--knowledge <op>`（`kernel/knowledge-cli.mjs:14` 的 10 个 op），`stats` 是其中一个 op；HTTP 侧是 `GET /knowledge/stats`（`server/knowledge-routes.mjs:120`）。S3 把新指标**并入现有 `stats`**，不新增 flag |

### 11.2 会导致返工的前提错误（三条，必须按本节实施）

**R1 —— ❌ §1 表「图谱检索：未接入主链路」是错的，它就在主链路上。**
`kernel/cli.mjs:629` 在每个 task 会话启动时调 `graph.search({ query: kw.join(' '), keywords: kw })`
（关键词 = `--add-dir` 目录名 + `settings.memory.taskTag` + `PONOS_MEMORY_KEYWORDS`），紧接
`:631` 再 `buildMemoryIndex`。即"索引式 + 图谱抽调"已是**活的**注入路径，不是死代码。
→ 影响：S3 的 `unified` 模式要替换的是**正在生效的两段注入**，灰度开关必须能整段退回
`graph.search + buildMemoryIndex` 的现状输出；单测的 legacy 基线要从**现状实跑**取值，不能凭 spec 想象。

**R2 —— ❌ §4.3「与 `MemorySearch` 的现状保持一致」前提错：`MemorySearch` 现在是「被禁」的。**
`kernel/tools.mjs:1053` 与 `server/bridge.mjs:1017` 两份 `CHAT_(MODE_)DISALLOWED` 都含
`MemorySearch`，**也都已含 `KnowledgeSearch`**（S1 Task 5 加进去的），且
`server/knowledge-packaging.test.mjs:24` 有断言守着"两份都含 KnowledgeSearch"。
→ 影响：D2 的"放行"不是"对齐现状"，而是一次**有意的语义变更**（chat 从"禁一切本地能力"变成
"放行一个只读本地检索"）。实施必须：① 两份表**同时**删 `KnowledgeSearch`（漏一处即
`kernel-tests/chat-mode.test.mjs:148-151` 的逐项比对变红）；② 把 `knowledge-packaging.test.mjs`
的断言方向从"都必须含"改为"都不得含"；③ 在提交信息与 S3 报告里显式声明该语义变更与理由
（只读、无写盘、无执行；chat 的"纯联网"边界仍在 `Bash/Read/Write/Edit/Glob/Grep/Agent/
Skill/Workflow/Browser` 等项上）。**`MemorySearch` 不动**（它走 O(N) 全量扫描 + 图谱分词，
chat 场景无收益，且本任务只对"知识库只读检索"这一项做决策）。

**R3 —— ⚠️ §8「新经验写入后同一会话下一轮即可检索到（无需重启）」现状**已经**成立，
S3 要做的是性能优化，不是补功能缺口。**
`searchKnowledge()`（`kernel/knowledge-search.mjs:19`）每次都 `createKnowledgeStore() + load({})`，
`load` 末尾 `indexStale()`（`kernel/knowledge.mjs:321`）逐文件比 size/mtime，一有变化就
`buildIndex()` **全量重建**——所以"刚记下就查不到"在 CLI 侧并不存在（该隐患只在 GUI 侧存在：
bridge 的索引缓存另有 TTL）。S1 已把增量写入口 `store.updateDoc(docId)`（`kernel/knowledge.mjs:500`）
做完（原地替换 `docs[i]` + 摘插 postings + `relinkDoc` + `persist`）。
→ 影响：S3 §5 的"增量更新"= **接线**（写入点调 `updateDoc`），**不是**重写索引逻辑；
验收断言要写成"走增量路径（`builtAt` 不变 / `updateDoc` 被调用）"，而不是"能搜到"（后者现状就过）。

### 11.3 设计前提需要收窄（按此实施，勿按正文）

| # | 正文表述 | 实测 | 处置 |
|---|---|---|---|
| N1 | §2.2/§3.1「两层由**同一次 `searchKnowledge()`** 产出」 | 索引层的目录行由 `buildMemoryIndex`（`kernel/memory.mjs:66`）渲染，格式为 `- [主题\|标签] N 条 · 最近 YYYY-MM-DD · <绝对路径>`；`searchKnowledge()` 的返回**不含**这种目录行，且 `store.search()` 也无此输出 | 改为「两层**共用同一个 store 实例与一次 `load()`**」：索引层**直接复用** `buildMemoryIndex`（零格式变化 = 零回归），抽调层走 store.search。强行"统一产出"会改目录行格式、破坏老会话的视觉契约，收益为负 |
| N2 | §4.2 `scope='project'` → `spaces=['project-*']` | **不存在 project 空间**：`shared/knowledge-core.mjs:484` 的内置空间只有 `experience` / `session-memory` / `skill-experience`；用户空间是 `spaces/<裸名>`，知识包是 `pack-<名>`。`kernel/cli.mjs:487` 明确注释"projectMemoryRoot 当前无项目记忆写入方" | 保留映射写法（`spaces=['project-*']` 恒 0 命中），与现状 `scope='project'` 恒 0 命中**语义等价**；在 `tools.mjs` 注释与报告里写明"该档无数据源，非本任务引入" |
| N3 | §3.2 输出串头「【相关知识抽调】…（格式：-\[空间\|标签\] 摘要 -- 全文）」+「保持既有风格」 | 既有串头是 `【相关经验抽调】…（格式：-\[主题\|标签\] 摘要 -- 全文）`（`kernel/memory.mjs:118`） | 新抽调层用正文的 `【相关知识抽调】`（块级结果跨空间，措辞更准）；**legacy 路径的既有串头一字不改**（`buildRelevantMemory` 保持原样），故不存在"模型要重新学格式"之外的回归 |
| N4 | §3.1 `spaces` 默认「active 且 source ∈ {experience, memory}」 | S1 的索引**不解析 `active`**（`parseDocFile` 只取 tags/name/title；`collectTags` 取 front.tags + 文件名 + 条目 tag）。S2 §11.6 第 5 条已记录 CLI/GUI 两侧 `active` 口径不一致 | 注入层**不做** `active` 过滤（与现状 CLI 一致），空间默认按 `source ∈ {experience, memory}`（= `experience` + `session-memory`）；`active` 缺口记为遗留观察，不在 S3 修 |
| N5 | §3.3「检索超时（>500ms）→ 退回纯索引层」 | `store.search` 是**同步**函数（`kernel/knowledge-search.mjs:5` 的同步契约），无法中断 | 改为**事后降级**：先量耗时，超阈值则本次只保留索引层并把 `stats.inject.degraded='slow'` 置位（注释写清"同步契约下不能真超时中断"） |
| N6 | §3.3「总预算 = `experienceInjectMaxBytes`（沿用既有配置项）」 | 该键是 **server 侧 `~/.yfworking/config.json`** 的键（`server/bridge.mjs:1004`），**内核读不到**；内核侧 `buildMemoryIndex` 一直用硬编码 4096（`kernel/cli.mjs:631` 不传 maxBytes） | 内核侧新增 `settings.memory.injectMaxBytes`（缺省 4096）+ env `PONOS_KNOWLEDGE_INJECT_MAX_BYTES`，与既有 `PONOS_MEMORY_*` 同款范式；**不改** server 键语义（GUI 注入那条路径不动） |
| N7 | §5「`appendMemoryEntry` 已是**唯一**写入点」 | 调用点 2 处：`kernel/cli.mjs:803`（带 `graphStore`）、`kernel/workflow-nodes.mjs:173`（**不传** `graphStore`，故 workflow 路径下图谱不更新=既有偏差）。另有**绕过**该函数的一处写入：会话工作记忆 `kernel/cli.mjs:813` 的 `writeFileSync(memory/session/<id>.md)`（整文件覆盖，不是 append 语义，`appendMemoryEntry` 不适用） | 增量接线挂 `appendMemoryEntry({ knowledgeIndex })`（覆盖 cli 与 workflow 两个调用点）；会话记忆文件在 `:813` 写完后**单独**调 `knowledgeIndex.updateDoc('session-memory/<id>.md')`。§5「`kernel/cli.mjs:588`」行号实为 `:813` |
| N8 | §6 指标 `search.elapsedP50/P95`「万级块」 | 无任何检索耗时埋点；`store.stats()` 现返回 `{version, docs, blocks, grams, spaces, builtAt, indexAgeMs, indexBytes}` | 在 store 内加**内存环形缓冲**（最近 100 次 `search()` 的 ms）→ `stats()` 增 `search: { count, elapsedP50, elapsedP95 }`（不落盘，进程内）；注入侧 `inject.*` 计数由 `kernel/knowledge-inject.mjs` 模块级累加器导出。二者都**只读展示**，不进上下文 |
| N9 | §7「`PONOS_GRAPH_BACKEND` 语义不变（真正用起来）」 | 该配置位**从未实现**：全仓只有 `kernel/graph.mjs:9` 一行注释提到它，无 env 读取、无 `createGraphBackend()` 工厂 | S3 **不实现**（YAGNI，S1 引擎是独立新链路）；正文 §1 末段的"真正用起来"一句作废，此处显式记为"配置位仍是文档占位" |

### 11.4 契约与约束确认（复核通过，实施照此）

- `store.search({ query, keywords, spaces, topK, maxBytes, mode })` 已支持 `mode='snippet'|'full'`
  与 `spaces` 过滤（`kernel/knowledge.mjs:376`）✅ —— §4.1 的 `mode`/`spaces` 无需新写检索逻辑。
- `KnowledgeSearch` 工具注册在 `kernel/tools.mjs:1391`，`topK` 已在 run 内 `Math.min(..., 10)` ✅；
  `configDir` 由 `memoryRoot` 上溯两级推导（`:1413-1417`），**不传 memoryRoot 时明确降级**（不猜路径）✅。
- `builtinSpaceSpecs` 的 `source` 值实测为 `experience` / `memory` / `skill_exp`（不是 spec 隐含的
  `{experience, memory}` 全集）——默认空间过滤按此取值，别写成 `source === 'personal'`。
- 会话工作记忆空间 `session-memory`（root `<configDir>/memory/session`）**S1 已注册**，S3 无需新建空间。
- `server/bridge.mjs` 注入链路（`:1111` resume / `:1149` 新会话，均 `mode==='task'` 才注入）
  本期**不改行为**；灰度开关只影响内核侧注入。
- kernel ⊥ server：注入管线全部落在 `kernel/`；server 侧只多一处 env 透传（`buildChildEnv()` 同款范式，
  `server/bridge.mjs:1174`）。
- 测试纪律沿用 S1/S2：`mkdtempSync` + 显式 `configDir` 隔离，**不启动 bridge**（server 侧测试注入假
  `callKernel`，见 `server/knowledge-routes.test.mjs`）。

### 11.5 实施期偏差补记（S3 Task 7 全量验收后，2026-09-13）

复核方式：各段全量 `node --test`（kernel-tests 967 / server 330 / electron 50 / src 281 /
shared 47，0 fail）+ `npm run typecheck` + `npm run build` 全跑通后回填。

| # | §11 原表述 / 隐含前提 | 实施期实际 | 处置 |
|---|---|---|---|
| 1 | §11.2 R1：`graph.search` 在主链路 | ✅ 实测确认；E2E 探针证明 legacy 提示词含 `【相关经验抽调】`、unified 下消失 | 按 R1 执行：`unified` 才替换，legacy 分支逐字节保持 |
| 2 | §11.2 R2：两份禁用表都含 `KnowledgeSearch` | ✅ 实测确认（`kernel/tools.mjs` + `server/bridge.mjs` 各一处，`server/knowledge-packaging.test.mjs` 有断言守着） | 两份同步删；该测试断言方向**反转**（必须含 → 不得含）；语义变更（chat 从"禁一切本地能力"收窄为"禁本地执行/写盘/出网执行类能力"）写进两份表的头注 |
| 3 | §11.2 R3：写入后"立即可检索"现状已成立 | ✅ 确认；但实施中发现更严重的问题：`kernel/cli.mjs` 的沉淀段引用了**块外**的 `const graph`（声明在 `if (!chatMode)` 内）→ 运行时 `graph is not defined`，异常被该段 `catch {}` 静默吞掉 ⇒ **启发式记忆捕获（`captureMemoryCandidates` → `appendMemoryEntry`）从未落盘**。实测证据：spawn mock 内核跑一轮"记住：…"，`memory/personal/*.md` 无任何新增（`kernel-tests/knowledge-inject-e2e.test.mjs`） | 图谱句柄提到注入段外（`let graphStore`）修复；同时补 `!chatMode` 守卫——原先 chat 下这条路径碰巧也抛错，修好作用域后若不守卫，chat 会开始往本地写文件（破 S1 纯聊隔离语义）。**这是行为变更，已在报告"自审发现"里单列** |
| 4 | §11.3 N1：两层"同一次 `searchKnowledge()`" | 仍按 N1 执行：索引层复用 `buildMemoryIndex`（零格式变化），收敛点为**同一 store 实例 + 一次 load**；`cli` 把该实例复用给轮末沉淀，一处 load 两处用 | 已落地 |
| 5 | §3.1 的 `buildKnowledgeInjection` 签名 | 实际多两个可选参数：`recall`（`PONOS_MEMORY_INJECT=index-only` 逃生阀在 unified 下也要生效——不短路就等于开关静默失效）、`knowledgeIndex`（注入方复用已 load 的 store，供沉淀增量更新共用） | 采纳为最终签名 |
| 6 | §8 验收「`KnowledgeSearch` 与注入抽调 top-3 `blockId` 一致」 | 需要限定：注入层有意过滤①无标签 `entry`（`- [ ] Step N` 任务清单，依 S1 裁定"经验条目 = 有 tag 的 entry"）②同文档第 3 块起 | 断言改为"**同序子集 + 首名一致**"（注入只做文档化过滤与预算裁剪，绝不能出现工具检不出的块） |
| 7 | §3.3「总预算 = `experienceInjectMaxBytes`」 | 内核侧读不到该键（它是 server 的 `config.json` 键）；内核新增 `settings.memory.injectMaxBytes` + env `PONOS_KNOWLEDGE_INJECT_MAX_BYTES`（默认 4096），bridge 把既有键透传过来 | 已落地；另注：注入层预算按**字节**计量，而索引层复用的 `buildMemoryIndex` 内部按其既有约定按**字符数**比较 `maxBytes`——极小预算下索引层固定串头（约 400 字节）可能自身超限，此时抽调层置空（单测按 `max(budget, 索引层单层字节)` 断言） |
| 8 | §6 指标 | 实施发现：`--knowledge stats`（含 HTTP 转发）**每次都是新进程**，进程内累加器恒为初值，不落盘则指标在 CLI/HTTP 上等于不存在 | 增补**落盘 sidecar** `.index/metrics.json`（会话启动注入时写一次，内容是上次注入计数 + 检索 P50/P95）；`stats` op 合并为 `metrics` 字段（缺失/损坏 → `null`，不报错）；同时 `store.stats().search` 保留**进程内**样本（测试可断言真实行为）。两者语义在代码注释里写清，避免"指标准确性"误读 |
| 9 | 计划 Task 3「`SETTINGS_DEFAULTS.memory` 加 `injectMode`/`injectMaxBytes`」 | 实施时放弃：`diffFromDefault` 是"整键 JSON 相等"比较，多两键会让"只设了 `memory.inject`"的用户被误报漂移；且默认值放两处必然漂移 | 灰度位默认值**单一权威**= `kernel/knowledge-inject.mjs` 的 `resolveInjectMode`/`resolveInjectBudget`；`settings.mjs` 只留一行注释指引（`validateSettings` 不校验子键，用户写这两个键仍然生效） |
| 10 | §4.2「老签名零改动即获块级能力」 | 输出**格式保留**（`【经验库命中 N 条，取前 M】` + `- [主题\|标签] 摘要 -- 全文（score · 文件）`），但 `N` 的语义从 legacy 的"总命中条目数"变为"返回条数"（块级检索一行 = 一个块）；来源给**绝对路径**（不是 docId）——Read 的白名单只含 memoryRoot 等目录，喂相对 docId 会让模型 Read 直接失败 | 已按此实现并在注释里写明；`searchLocalMemory` 保留为索引不可用时的回落 |
| 11 | §5「`appendMemoryEntry` 是唯一写入点」 | 会话工作记忆（`kernel/cli.mjs` 的 `writeFileSync(memory/session/<id>.md)`）**不走**该函数（整文件覆盖写，非 append 语义） | 该处单独调 `syncKnowledgeIndex(...)`；workflow 节点调用点不传 `knowledgeIndex`（无 configDir，不猜路径），由 staleness 全量重建兜底（注释已记） |
| 12 | 未做（本期明确不做，非遗漏） | ① `active: false` 主题的注入过滤（索引不解析 `active`，N4）；② `PONOS_GRAPH_BACKEND` 预留位（N9，从未实现）；③ GUI 控件（spec §3.3"不新增用户可见配置"）；④ 会话记忆命中的 **Read 可达性**：`session-memory` 空间的文件不在 Read 白名单内，工具给了绝对路径但 `Read` 仍会被边界拒绝（S1 遗留，`readAllowFiles`/`readAllowDirs` 未含 `<configDir>/memory/session`） | 全部记入 S3 报告的"遗留问题 / 需人工走查" |
