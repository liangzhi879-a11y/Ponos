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

## 10. 待确认决策点

| # | 决策 | 选项 |
|---|---|---|
| D1 | 注入策略切换方式 | 直接替换（简单）／灰度（配置位 `knowledgeInjectMode: legacy\|unified`，可回退） |
| D2 | 会话模式是否放行 `KnowledgeSearch` | 放行（只读，推荐）／沿用 `CHAT_DISALLOWED` 禁用 |
| D3 | 抽调层粒度 | 块级摘要（省预算，推荐）／块级全文（信息全但费预算）／自适应（按预算动态） |
