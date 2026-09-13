# S5 设计：关联锚点（relation anchors）

> 前序：`2026-09-13-knowledge-{core,gui,ai-integration,distribution}-design.md`（S1-S4，已交付并合并）
> 本文档所有阈值与形态均来自**真实经验库实测校准**，证据见 §13 附录。
> 日期：2026-09-13

## 1. 问题（实测，非推测）

用户的原始诉求：

> 经验及知识词条之间，是否在入库时应该经过关联性分析，并形成关联锚点？
> agent 在获取一件词条后可以继续关联阅读，使得知识或经验体系化。

对真实经验库（`~/.yfw/memory/personal`，7 文档 / 83 块 / **76 条 entry**）实测：

| 指标 | 实测值 | 含义 |
|---|---|---|
| `links.jsonl` 边数 | **1** | 全库只有 **1 条**显式链接 |
| heading 块 | **0** | 经验文件无标题 → GUI 大纲恒空 |
| tag 种类 | 20，其中**仅 4 个**出现 ≥2 次 | 60 条有 tag、9 条无 tag |
| 条目集中度 | 74/76 条在 `workflow.md` 单文件内 | **文件不是主题边界，tag 才是** |

**结论**：现有"关联"能力**只有显式链接**（md 链接 / `[[wiki]]`）。而显式链接实质缺失，
导致 S2 的**反链恒空**、**知识图谱近乎全是孤立节点**，agent 检索到一条词条后**无路可走**。
这正是诉求"体系化"要解决的缺口。

## 2. 目标与非目标

**目标**
1. 在**不改用户 `.md` 文件**的前提下，建立条目间的**双向关联锚点**，且每条关联**可解释**（带 `why`）
2. agent 检索命中时**直接看到锚点**，可按需**一跳展开**继续阅读
3. GUI 在阅读视图与 Inspector 提供关联导航；图谱可切「关联图层」
4. 修补两条使关联"带毒"的数据问题（垃圾条目、截断摘要）

**非目标（YAGNI，明确不做）**
- ❌ **不引入 embedding 模型 / 新依赖**（零新依赖是既有底线；gram+idf 在本规模已够，见 §13）
- ❌ **不把关联写回 `.md`**（S1 定下的"文件为真源"；关联是**派生数据**）
- ❌ 不做隐式关联的**跨空间**连接（避免不同项目经验串味；显式链接的跨空间能力不变）
- ❌ 不做权重学习 / 用户反馈调参（无数据支撑）
- ❌ 不做 GUI 手工编辑关联（先把自动关联做对）
- ❌ 不做多跳自动扩散（只支持**按需一跳**，防上下文膨胀）

## 3. 关联模型：两层 + 一类特殊标记

| 层 | 依据 | 覆盖（实测） | `why` | 默认呈现 |
|---|---|---|---|---|
| **骨架层** | 同 `tag` 的条目互为锚点 | 60/69 条 | `{kind:'tag', tag:'应用智控'}` | 展开 |
| **覆盖层** | 内容相似（§5） | 补上 9 条无 tag 的孤立条目 | `{kind:'content', score:0.37, shared:['提交','实现','目录']}` | 折叠 |
| **重复标记** | 相似度 ≥ `DUP_COS`(0.95) | 实测 2 条 | `{kind:'duplicate', score:1}` | 独立呈现为「疑似重复」 |

三层刻意分开的理由：
- 骨架层**必然非空且零噪声**（直接解决"反链恒空"），但它只量"同一主题"；
- 覆盖层负责**跨主题同问题**（最高价值信号），但有噪声 → **必须带 `shared` 特征词才允许存在**，默认折叠；
- `duplicate` **不是关联**：重复项没有阅读价值，若混进 related 会挤占锚点预算，必须单独归类。

**关联语义无向，物化时双向**（`from→to` 与 `to→from` 各一行）。理由：`related(blockId)`
是"给我这条的**所有**锚点"，有向图会让这个查询退化成全表扫描。

## 4. 存储形态

### 4.1 `related.jsonl`（新索引文件）

每行一条边：

```json
{ "from": "docId#n", "to": "docId#n",
  "why": { "kind": "content", "score": 0.3721, "shared": ["提交","实现","目录","任务","git"] },
  "sigFrom": "a1b2c3d4e5f6", "sigTo": "9f8e7d6c5b4a" }
```

- `why` 是**必填**且必须可解释（§5.4）
- `sigFrom` / `sigTo` = 两端内容指纹，用于**读时校验**（§6.2）
- 文件与 `links.jsonl` **分开**：前者是**显式**链接（源自 md 文件），后者是**隐式**关联（纯派生）。
  GUI 也**不混作一栏**（避免用户误以为关联是手工建立的）

### 4.2 manifest 指纹（必须）

`manifest.json` 增 `relLines`（`related.jsonl` 行数）。

> **S1 教训（必读）**：`inverted.jsonl` 曾因被截断而**静默返回空集且永不重建**。
> 没有行数指纹就发现不了"文件损坏/截断"。`relLines` 必须与 `docLines`/`invLines` 同等对待。

### 4.3 `INDEX_VERSION` 1 → 2

因索引文本口径变更（§8），**旧索引必须整体重建**。

## 5. 算法

### 5.1 参与集（`relatable`）

条目进入关联计算需满足**全部**：

1. `kind === 'entry'`
2. `content = stripTypePrefix(full || text)` 且 `content.length >= MIN_LEN`（**20**）

`stripTypePrefix` = 剥掉开头至首个 `：` 的类型前缀（`流程要点：` / `用户偏好（x）：` /
`业务要点（x）：` / `用户纠正（x）：`）。

**两条修正都来自实测**（§13）：
- **必须用 `full`**：`kernel/memory.mjs:183-187` 生成条目时 `text` 被截断为"类型前缀 + 60 字"
  （实测 `text=45 / full=471`），信息量差一个数量级 → 在摘要上做相似度**必然测不出语义关系**
- **必须去类型前缀**：该前缀是条目类型的粗标签、同类型条目**共有**，属纯噪声
  （实测不去前缀时，高分对的 `shared` 全是"流程/程要/要点"）

### 5.2 骨架层

同 `tag` 且**同空间**的条目互为锚点。单块上限 `MAX_TAG_RELATED`（**5**）。

**排序规则**（定死，避免实现者猜）：按「邻近度」升序取前 N，邻近度定义 =
1. 同文档：键为 `|n_a - n_b|`（块序号差，越小越近）
2. 跨文档：排在所有同文档条目之后，键为 `(docId, n)` 的字典序

理由：经验文件的同主题条目多集中在同一文档且位置相邻，就近即为最相关；
跨文档关系缺乏可靠顺序信号，故用**稳定字典序**而非随机序，保证结果可复现。

### 5.3 覆盖层

- 文本表示：`countGrams(content)` → `vectorizeText(content, { tagBoost: 1, idf })`
  → `cosine(a, b)`
- **`tagBoost` 必须为 1**（校准发现，非随手选）：`vectorizeText` 的 boost 在**归一化之后**乘，
  故带 boost 的返回值范数 = boost、点积可达 9（**不是度量余弦**）；更要紧的是
  `tagBoost=3` 会让**同 tag 对全面压过跨 tag 对**，使覆盖层**退化成骨架层的重复**，
  把"跨主题同问题"这一最想要的信号淹没。**tag 关系由骨架层负责，覆盖层只按内容算。**
- 阈值 `SIM_THRESHOLD = **0.32**`（校准依据见 §13：0.5 仅 1 对 ≈ 功能失效；0.32 兼顾覆盖与精度）
- 排除 `cos >= DUP_COS`(0.95) 的对（归入 `duplicate`，§5.5）
- 单块上限 `MAX_CONTENT_RELATED`（**5**），按 `score` 降序
- 单块锚点总数上限 `MAX_RELATED`（**8**）：骨架 + 覆盖去重后截断

### 5.4 可解释性硬约束

1. 每条边必须有 `why`
2. **content 边必须有非空 `shared`**：`sharedFeatures(a, b, {idf, topN:5})` 按 idf×min(tf) 取 top-5 共有 gram；
   **若 `shared` 为空 → 丢弃该边**（只有分数、无法解释 = 宁缺勿滥）
3. `score` 与 `shared` 都要能展示给用户/agent

### 5.5 duplicate

`cos >= DUP_COS` 的双向边，`why = {kind:'duplicate', score}`。
**不计入 `MAX_RELATED`**（避免重复项挤占预算），在 GUI 与 agent 侧**独立于关联呈现**。

## 6. 计算时机：写侧物化 + 读侧校验（并存）

### 6.1 写侧（物化）

**全量**：`reindex` / 首次建索引 → 计算全部条目 → 写 `related.jsonl` + manifest `relLines`。

**增量**（`updateDoc`，用户已选"折中"）：
1. 重算该文档所有条目的**出边**（因为索引已更新，旧出边可能失效）
2. **只对同 tag 的其它条目补入边**：收集本文档条目的 tag 集合 → 找出索引中同 tag 的其它条目 →
   为它们补充指向新/改动条目的边（这些必然是 **tag 边**，因为同 tag 关系在文档更新后仍成立）

   **同 tag 条目的查找方式**（性能约束，避免每次全库扫块）：
   - 若索引中已有 tag→块 的映射（如 `tags.json`），复用之
   - 否则在文档加载时**一次遍历**建立 `Map<tag, blockId[]>` 内存缓存，供本次 `updateDoc` 使用
   - **禁止**对每个 tag 各扫一遍全库（O(tags × blocks)）
3. content 类**入边**不即时重算

> **已知取舍（明示，不藏）**：content 入边有延迟，最坏到下次全量重建才补齐。
> 换来的是增量路径**不必全局重算**（改一个文档不需扫全库条目）。
> 用户已确认接受此取舍。

### 6.2 读侧（校验剔除）

`getRelated(blockId, { validate: true })` 逐边三条检查：

1. `from` / `to` 块**仍存在**（文档或块被删 → 剔除）
2. `kind === 'tag'`：两端 `tag` **当前仍相等**（字段比较，O(1)）
3. `kind === 'content' | 'duplicate'`：两端**内容指纹仍等于 `sigFrom`/`sigTo`**
   （内容被改 → 剔除；保守：宁可少连也不错连）

校验是**只读语义**（不改文件），返回"校验后的视图"；物化文件里那份等下次 `updateDoc`/`reindex` 重算。
**"快"由物化负责、"对"由校验负责，因而不需要反向失效**（改 A 不必搜别人指向 A 的边）。

指纹：`crypto` sha1 前 12 位（对 `stripTypePrefix(full||text)`）。

## 7. 接口

### 7.1 纯函数 → `shared/knowledge-core.mjs`（可单测层）

- `stripTypePrefix(s)`
- `relationContent(block)` → 参与计算的文本（`full` 去前缀）
- `relatedCandidates(block, pool, { idf, topN, minScore })` → `[{to, why}]`
- `sharedFeatures(tfA, tfB, { idf, topN })`
- `validateRelation(edge, lookup)` → `boolean`
- 常量：`SIM_THRESHOLD(0.32)` / `DUP_COS(0.95)` / `MIN_LEN(20)` / `MAX_RELATED(8)` /
  `MAX_TAG_RELATED(5)` / `MAX_CONTENT_RELATED(5)` / `INDEX_VERSION(2)`
- `blockContentSig(block)`

### 7.2 内核 → `kernel/knowledge.mjs`

- `getRelated(blockId, { validate = true, limit })`
- `search()`：每个 item 增 `related` 字段 —— **只给锚点摘要**
  `{ blockId, docId, title, why, score }`，**不含正文**（防上下文膨胀）
- `stats()` 增 `related: { edges, tagEdges, contentEdges, dupEdges, dropped }`（沿用 S3 观测口径）。

字段定义（避免歧义）：
- `edges` / `tagEdges` / `contentEdges` / `dupEdges`：`related.jsonl` **物化**行数（各按 `why.kind` 分类）
- `dropped`：**计算期**丢弃的候选数（`shared` 为空、末端点已不存在、超上限被截断）
- **不含**读时校验剔除数——读侧 `validate` 返回的是"视图"，属只读行为，
  若计入 stats 会让同一库的 stats 随查询历史漂移（不可复现）

### 7.3 CLI → `kernel/knowledge-cli.mjs`

```
--knowledge related --id <blockId> [--no-validate] [--limit N]
```
（置于既有 `case 'links'` 旁）

### 7.4 路由 → `server/knowledge-routes.mjs`

```
GET /knowledge/related?id=<blockId>&limit=<N>
```
（照 `/knowledge/links` 的写法与防护）

### 7.5 GUI（S2 增量）

- `KnowledgeEntryCard` 底部增「关联锚点」行：按 `why.kind` 分组（同主题 N / 相似 N），
  点锚点 → 打开目标条目并定位
- `KnowledgeInspector` 在**反链之外**新增「**关联**」段（与"反链"分列，不混）
- `KnowledgeGraphView` 增图层开关：**默认只显式链接**；隐式关联需手动开
  （实测当前只有 1 条显式链接，若默认显示关联，图谱会从 1 条边骤增，第一印象被噪声淹没）
- 疑似重复：在条目卡片上以独立提示呈现（非关联区）

### 7.6 agent（S3 增量）

- `kernel/knowledge-inject.mjs`：注入语料中命中项附**锚点摘要**
- `KnowledgeSearch` 工具增 `related` 参数：给定 blockId 展开**一跳**（**不自动多跳**）

## 8. 索引文本口径修正（独立任务，连带影响 S1 检索）

实测发现**检索的两条路径信息量不一致**：

| 路径 | 位置 | 用的字段 |
|---|---|---|
| 向量 / gram | `kernel/knowledge.mjs:177,186,305,348` | `b.text`（**60 字截断摘要**） |
| 关键词 | `kernel/knowledge.mjs:350` | `summary: b.text` + **`full: b.full`** |

**修正（口径必须完全统一，否则两条路径会给出互相矛盾的相关度）**：
索引文本统一取 **`relationContent(b)` = `stripTypePrefix(full || text)`**：

- 向量 / gram 路径：`gramCounts` 的来源从 `b.text` 改为 `relationContent(b)`
- 关键词路径：`summary` 参数同样传 `relationContent(b)`；`full: b.full` **保持**（用于 `mode='full'` 返回正文）
- `snippet` 仍取 `b.text`（**行为不变**，避免改动前端高亮与展示逻辑）

收益：**同时改善检索与关联**（二者共用同一索引）
代价：`INDEX_VERSION` 1→2 → 旧索引整体重建（一次性）
**回归要求**：S1 检索既有用例必须全过；额外记录若干真实 query 的前后命中对比（写入报告）

## 9. 数据卫生

### 9.1 垃圾条目（7 条）

实测存在 7 条 `full` 仅 10 字、内容为**空模板**的条目（`流程要点：用户回答：`、
`业务要点（请注意）：`）。它们两两文本全同 → `cos = 1.000`，会灌入"完美相似但零信息"的边。

**处置（修源头 + 关联侧防御）**：
1. **修源头**：`kernel/memory.mjs` 生成条目时，跳过内容为空的模板（不再产生新的）
2. **关联侧防御**：`MIN_LEN`(20) 过滤（兼容存量），且 `duplicate` 不进入 related

### 9.2 精确重复（2 条）

`cos = 1.000` → 归 `duplicate`，**不作为 related 锚点**（重复项无阅读价值）。

## 10. 配置与回滚

`settings` 增 `knowledgeRelateMode: 'on' | 'off'`，**缺省 `on`**。

- 新能力是**只读新增**（新 op + 检索多一个字段），不改变既有输出语义
- `off` 时：不计算、不写 `related.jsonl`、`search()` 不带 `related` 字段 → 等价于 S4 行为
- 回滚 = 置 `off` + 删除 `related.jsonl`（不影响其它索引文件）

## 11. 验收标准

| # | 验收项 | 方式 |
|---|---|---|
| 1 | `--knowledge related --id <blockId>` 返回带 `why` 的锚点 | 命令 |
| 2 | 无 tag 条目亦能获得 content 锚点（非空） | 测试 |
| 3 | 垃圾条目（`full` 10 字）不出现在 related | 测试 |
| 4 | `cos≥0.95` 的对归 `duplicate`，不占 related 预算 | 测试 |
| 5 | 每条 content 边的 `shared` 非空 | 测试 |
| 6 | 读时校验：块删除 / tag 变更 / 内容变更 → 该边被剔除 | 测试 |
| 7 | 增量：`updateDoc` 后同 tag 入边即时可见 | 测试 |
| 8 | manifest `relLines` 指纹：`related.jsonl` 截断 → 触发重建 | 测试 |
| 9 | `search()` 命中项带 `related` 摘要（不含正文） | 测试 |
| 10 | `related` op 与 `/knowledge/related` 均可用 | 测试 + 命令 |
| 11 | 索引口径修正后，S1 检索既有用例全过 | 全量测试 |
| 12 | `knowledgeRelateMode: 'off'` 等价 S4 行为 | 测试 |
| 13 | GUI：条目卡片关联行、Inspector 关联段、图谱图层默认关 | 人工走查 |
| 14 | agent：命中附锚点 + `KnowledgeSearch` 一跳 | 测试 |
| 15 | 全量测试 0 fail（基线：kernel 975 / server 373 / src 305 / shared 69 / electron 50） | 命令 |

## 12. 风险

| 风险 | 缓解 |
|---|---|
| 覆盖层噪声（实测有 1/5 噪声对，如"该用户偏好↔企微外部群"） | 阈值 0.32 + `shared` 必填 + 默认折叠 + 上限 5 |
| 索引口径变更影响 S1 检索 | `INDEX_VERSION` bump；全量回归 + 真实 query 前后对比 |
| 「索引用 full」可能让长文档命中偏移 | 保留 `mode='full'` 返回 `full`；`snippet` 仍取 `text`（行为不变） |
| 增量入边延迟 | 已明示并由用户确认；读时校验保证"不显示已失效的边" |
| 关联规模增长 | 单块上限 8；`related.jsonl` 行数上限 = 参与条目数 × 8 |

## 13. 附录：校准证据（真实库 76 条）

### 13.1 三轮对照（口径修正的由来）

| 轮次 | 输入文本 | 非重复最高分 | 观察 |
|---|---|---|---|
| ① | `blockIndexText`（tag + 60 字摘要） | >1（3.2） | `tagBoost` 在归一化后乘 → 非度量余弦 |
| ② | 同上，`tagBoost=1` | 0.358 | 高分 `shared` 全是 tag 自身的字（上下/下文/文失/失真/真健） |
| ③ | **`full` 去类型前缀** | **0.437** | 候选质量真实可用（下表） |

### 13.2 阈值扫描（口径③，69 条参与，2345 非重复对）

```
阈值 0.30 → 25 对（跨 tag 8 对）
阈值 0.40 →  3 对（跨 tag 2 对）
阈值 0.50 →  1 对（跨 tag 1 对）
每条 top-1：≥0.4 的 6/69，中位数 ≈0.30
```
→ 若按直觉取 0.5/0.6，**覆盖层仅剩 1 对 ≈ 功能失效**；故选 **0.32**。

### 13.3 Top 候选质量（决定性证据）

| cos | 关系 | 判定 |
|---|---|---|
| **0.437** | `知识库S1实施` ↔ `知识库全四期实施`（**跨 tag**） | ✅ 同项目两阶段，**正是要的跨主题体系化**；shared=提交/实现/目录/任务/git |
| 0.408 | `上下文失真健康` × 2（同 tag） | ✅ 同一工作族 |
| 0.393 | `企微CLI化` 外部群 × 2 | ✅ shared=部群/外部/客户/企业/机器 |
| 0.389 | `应用智控` 工具环境坑 × 2 | ✅ shared=c/目录/bash/users |
| 0.370 | `该用户偏好` ↔ `企业微信外部群` | ❌ **噪声**（shared=官方/企业/外部/支持） |

### 13.4 数据卫生实测

- 参与 69 条 = 76 − 7（垃圾：`full` 10 字空模板）
- 精确重复 2 条（`cos=1.000`）
- `text` vs `full`：实测 45 vs 471 字、31 vs 485 字（**10 倍信息差**）
