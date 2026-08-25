# 内核神经图谱知识经验沉淀系统 设计文档

- 日期：2026-08-25
- 状态：已批准（brainstorming 流程）
- 范围：ponos-turbo 内核（kernel/ 目录），涉及 memory.mjs / cli.mjs，新增 graph.mjs；GUI 层（server/experience.mjs 面板）不受影响

## 1. 背景与目标

现状：内核已有**线性经验库**（`kernel/memory.mjs`，与 GUI `server/experience.mjs` 同源）——按主题分文件的 markdown 条目（`- [会话|标签] 摘要 -- 全文`），L3-1 轮末启发式捕获 + LLM 沉淀提示词写入，L3-2 轮前关键词打分检索（`buildRelevantMemory`）注入提示词。

用户诉求：内核应拥有**自主的神经图谱知识经验沉淀系统**——经验以"图谱"形态组织（节点 + 语义联想），而非线性列表；同时具备**对接外部知识库的能力**，外部知识库可整体替代内核图谱。

### 需求决策记录（已与用户确认）

| 决策 | 选择 |
|------|------|
| 图谱形态 | 向量化（语义向量网络），但**不做本地嵌入模型**（推理代价大） |
| 本地向量化实现 | 无模型特征向量：n-gram 哈希 + 词频 → 稀疏向量 → 余弦相似度（零依赖、纯本地、确定性） |
| 图谱节点范围 | 经验条目 + 任务标签（现有 memory 条目体系，聚焦经验沉淀主线，平滑升级） |
| 检索注入 | 替换 L3-2 关键词打分（`buildRelevantMemory`）为图谱检索，单一数据源；关键词成分保留为评分加权因子 |
| 外部知识库接入 | **本次不实现**，仅预留替换点（配置位 + `IGraphBackend` 接口契约）；"完全替代/依托外挂执行"为预留语义 |
| 经验沉淀去向 | 本次：只写内核图谱（markdown 权威 + 图谱派生索引）；有外部知识库时（未来）全部依托外挂执行 |

## 2. 架构总览（三层）

```
┌─ 捕获层（不变）──────────────────────────────┐
│  L3-1 启发式捕获(cli.mjs finally 块)          │  经验从哪来
│  + LLM 沉淀提示词(buildSedimentPrompt)         │
└──────────────┬───────────────────────────────┘
               ▼ 条目 {theme, tag, summary, full}
┌─ 图谱层（新增 kernel/graph.mjs）─────────────┐
│  Vectorizer：n-gram哈希 → 稀疏向量（无模型）    │  特征向量化
│  GraphStore：append-only graph.jsonl（节点）    │  图谱存储
│  GraphSearch：余弦 top-k + 关键词加权 → 注入    │  检索器
│  IGraphBackend 接口：search/write/health       │  外部替换点（本次 local stub）
└──────────────┬───────────────────────────────┘
               ▼
┌─ 注入层（改造 cli.mjs L3-2）─────────────────┐
│  buildRelevantMemory → 图谱检索（单一数据源）    │
│  buildMemoryIndex 索引指针保留                  │
└──────────────────────────────────────────────┘
```

设计原则：
- **零新增运行时依赖**：不引入 embedding 模型、不联网、不引入向量库；全部用 node:fs / node:crypto / 纯 JS 实现。
- **markdown 为权威源**，图谱为派生索引：人类可读、GUI 面板（server/experience.mjs）与 workflow store 节点零改动。
- **平滑替换**：L3-2 注入格式与逃生阀（`settings.memory.inject` / `PONOS_MEMORY_INJECT=index-only`）完全保留，仅替换检索实现。
- **替换点显式化**：图谱读写走 `IGraphBackend` 接口，未来外部知识库实现同一接口即可"完全替代"（检索与沉淀均委托外部）。

## 3. 数据模型

### 3.1 图谱文件

`<configDir>/memory/graph/graph.jsonl`（append-only，每行一个节点）：

```json
{
  "v": 1,
  "id": "<hashLine>",
  "theme": "workflow",
  "tag": "成果转化材料",
  "summary": "一句话要点",
  "full": "完整经验",
  "ts": "2026-08-25T10:00:00.000Z",
  "vec": [["1a2b3c4d", 2.5], ["5e6f7a8b", 1.0]]
}
```

- `id`：复用 `memory.mjs` 的 `hashLine`（32-bit），与 markdown 条目行哈希一致，天然对齐去重。
- `vec`：稀疏向量，`[[哈希桶, 权重], ...]`，桶 id 为 n-gram 哈希的 16 进制串。
- append-only 与 transcript 同哲学：崩溃安全，半截行加载时跳过。

### 3.2 权威源与一致性

- 权威源 = 现有 markdown 经验库（`<configDir>/memory/personal/{theme}.md`，写入路径不变）。
- 图谱是**派生索引**：`appendMemoryEntry` 成功后同步追加图谱节点（增量）；启动时校验触发**全量重建**（条件：图谱文件缺失 / 版本旧 / markdown mtime 晚于图谱 mtime / `rebuildGraph()` 命令式入口）。
- 重建 = 扫描全部 markdown 主题文件 → 逐条向量化 → 重写 graph.jsonl。

## 4. 特征向量算法（无模型）

输入文本 = `theme + tag + summary + full`（`tag` 为强语义信号，3 倍权重）。

1. **切分**
   - 中文：字符 bigram（"知识图谱" → 知识 / 识图 / 图谱），连续中文段内滑动
   - 英文/数字：按词小写（word token），1 个 token 也保留
   - 空白与标点分词，不参与 n-gram
2. **哈希桶**：复用 `memory.mjs hashLine`（32-bit）作用于每个 n-gram，得到桶 id
3. **权重**：
   - TF：n-gram 出现次数，√ 平滑（`1 + sqrt(count)`）
   - IDF：图谱加载时全局统计（`ln((N+1)/(df+1)) + 1`），抑制"的/是/我"类泛化 n-gram；查询向量用同一 IDF 表
   - tag n-gram 额外 ×3
4. **向量**：`Map<桶id, weight>` → 归一化（余弦等价点积）
5. **查询向量化**：与条目同一算法，输入 = 关键词串（与现状同源：addDirs 目录名 + settings.memory.taskTag + env PONOS_MEMORY_KEYWORDS，逗号分隔）

## 5. 检索与评分

`GraphSearch.search(queryText, { topK })`：

1. 查询文本向量化（用图谱全局 IDF）
2. 全扫内存索引，余弦 top-K 候选
3. 混合评分：`final = 0.7 × 余弦相似 + 0.3 × 关键词命中分`
   - 关键词命中分沿用现 `buildRelevantMemory` 打分：标签命中 +3 / 主题 +2 / 摘要 +2 / 全文 +1
   - 保证与现状平滑衔接、确定性兜底（纯余弦对短查询可能噪声）
4. 排序去重（同 hash 只留一次），截断到注入预算（默认 2048 字节，`maxBytes` 参数）
5. 输出格式**完全沿用**现有：`- [主题|标签] 摘要 -- 全文` 行内条目，头部 `【相关经验抽调】` 引导语

## 6. 注入改造（cli.mjs L3-2）

- 位置：cli.mjs:282-300 记忆注入块（**启动时**组装 system prompt，非轮次级）
- 变更：`buildRelevantMemory({ root, keywords })` → `graphSearch({ root: memoryRootDir, keywords })`
  - 查询输入 = 关键词串（与现状同源）；因注入点在启动时、无当前轮 user 消息可用，**不扩展 user 消息动态检索**（列为未来增强：需将图谱检索挂到轮次级，本次不做）
- 保留：
  - `buildMemoryIndex` 索引指针注入（两级：图谱全文 + 索引兜底）
  - `PONOS_MEMORY_INJECT=index-only`（仅索引，旧行为）
  - `settings.memory.inject=false` 逃生阀
- `buildRelevantMemory` 关键词打分函数保留（作为图谱检索的加权成分复用），不再独立对外注入

## 7. 外部替换点契约（本次不实现）

配置位：
- env `PONOS_GRAPH_BACKEND=local|external`
- settings `memory.graphBackend`（同 env 语义，env 优先）

接口 `IGraphBackend`（graph.mjs 导出）：

```ts
interface IGraphBackend {
  search(query: string, opts: { topK: number }): Promise<{ theme, tag, summary, full, score }[]>
  write(entry: { theme, tag, summary, full }): Promise<{ ok, deduped }>
  health(): Promise<{ ok: boolean, detail: string }>
}
```

- 本次实现 `local`（markdown + graph.jsonl 派生索引）
- `external` 配置时：`search/write/health` 返回明确错误"未配置外部知识库后端"（行为 = 无图谱检索，注入退化为仅索引指针；沉淀照常写 markdown，不阻断）
- 未来外部接入：实现同一接口并注册到 `createGraphBackend()` 工厂，内核零改动切换；此时检索与沉淀**全部依托外挂执行**（对应"完全替代"语义）

## 8. 兼容性与迁移

| 项 | 处理 |
|----|------|
| 现有 markdown 经验库 | 不动，权威源保持 |
| GUI 经验面板（server/experience.mjs） | 不动（读 markdown，不受图谱影响） |
| workflow store 节点（workflow.mjs:420） | 不动（写 markdown，图谱由 appendMemoryEntry 同步） |
| 存量经验 | 首次启动无图谱 → 全量重建自动入图，零迁移成本 |
| 注入格式 | 与现有一致，提示词（prompt.mjs）零改动 |

## 9. 性能

- 目标规模：个人经验库 ≤ 数千条目
- 全扫余弦：毫秒级（内存 Map + 稀疏向量点积）
- 图谱加载：启动时一次流式读入，查询不落盘
- 不做倒排索引 / 联想一跳（YAGNI：当前规模下收益可忽略，留作外部知识库升级通道的能力）

## 10. 测试策略

| 层 | 用例 |
|----|------|
| Vectorizer | 同义文本相似度高 / 无关文本相似度低 / 空输入容错 / tag 权重生效 |
| GraphStore | append → 检索命中 / hashLine 去重 / 半截行跳过（崩溃恢复） |
| GraphSearch | 混合评分排序 / 关键词加权兜底 / 注入格式兼容（引导语 + 行格式） |
| 重建 | markdown → 图谱全量重建后检索结果与增量路径一致 |
| 回归 | 现有 memory/experience 测试全绿；L3-2 注入块在 index-only 模式下输出不变 |

## 11. 文件清单与实施顺序

| 变更 | 说明 |
|------|------|
| 新增 `kernel/graph.mjs` | Vectorizer + GraphStore + GraphSearch + IGraphBackend + 工厂 |
| 修改 `kernel/memory.mjs` | `appendMemoryEntry` 成功后同步图谱写入；导出 `rebuildGraph`；保留 hashLine 复用 |
| 修改 `kernel/cli.mjs` | L3-2 `buildRelevantMemory` → 图谱检索（关键词串，与现状同源） |
| 新增 `server/graph.test.mjs` | 上述测试策略用例 |
| 文档 | 本文档 |

实施顺序：graph.mjs（向量化 → 存储 → 检索）→ memory.mjs 接线 → cli.mjs 注入替换 → 测试 → 回归。

## 12. 风险与权衡

- **纯字符 n-gram 的语义上限**：无模型向量对同义改写（"专审" vs "专项审计报告"）召回弱于 embedding——接受（"初级图谱"定位），由关键词加权兜底；语义升级通道 = 外部知识库（embedding/向量库）。
- **图谱与 markdown 的双写一致性**：崩溃落在"markdown 已写、图谱未写"窗口 → 下次启动 mtime 校验触发重建，自愈。
- **注入预算**：图谱检索同样受 maxBytes 截断，不放大上下文占用。
