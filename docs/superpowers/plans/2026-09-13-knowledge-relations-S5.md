# S5 关联锚点 实施计划（11 任务）

> 规格：`docs/superpowers/specs/2026-09-13-knowledge-relations-design.md`（**含 §13 校准证据，必读**）
> 前序：S1-S4 已交付并合并（main `7e58a55`）；本计划在其上做**纯增量**
> 分支：`knowledge-s1`（worktree `.worktrees/knowledge-s1`）
> 日期：2026-09-13

## 目标

让经验/知识条目互相**可达**：条目入库时算出**关联锚点**（带 `why` 可解释），
agent 检索命中后能按需**一跳**继续阅读 → 经验体系化。

**实测问题**：真实库 76 条 entry，`links.jsonl` **仅 1 条边** → 反链恒空、图谱全孤立、agent 无路可走。

## 全局约束（违反即返工）

1. **不改用户 `.md`**：关联是**派生数据**，只落 `related.jsonl`（沿袭 S1"文件为真源"）
2. **`related.jsonl` 与 `links.jsonl` 分文件、GUI 分栏** —— 前者隐式派生、后者显式（源自 md），
   混在一起会让用户误以为关联是手工建立的
3. **kernel ⊥ server 双向禁止 import**；server 侧只经 `server/kernel-readonly.mjs` 的 `kernelReadonly()`
4. **测试禁止启动 bridge、禁止真联网、禁止碰真实用户目录**（`mkdtempSync` + `PONOS_HOME`）
5. **`INDEX_VERSION` 1→2** → 旧索引必须能自动重建（不得因版本不符而报错或空结果）
6. **manifest 增 `relLines`**：S1 踩过 `inverted.jsonl` 截断后**静默空集且永不重建**
7. **纯增量**：`knowledgeRelateMode: 'off'` 必须等价 S4 行为（可回滚）
8. 中文注释解释 **why**；关键阈值处必须写明**为何是该值**（引用校准结论，防后人随手改）

## 完成定义（S5 验收）

见 spec §11 的 15 项。本计划末尾给出与任务的映射。

## 节奏

- 合并派发（同文件相邻任务）：`1+3`、`4+5`、`7+8`
- **每批 typecheck + 相关测试 → 立即提交**（子 Agent 有 300s 上限，已有 18 次前车之鉴）
- 无 DOM 测试环境 → 纯逻辑抽 `shared/` 或 `src/lib/` 并配 `node:test`；UI 靠 typecheck + 人工走查

---

### Task 1: 纯函数层（`shared/knowledge-core.mjs`）

**交付物**
- `stripTypePrefix(s)`：剥掉开头到首个 `：` 的类型前缀
- `relationContent(block)` → `stripTypePrefix(block.full || block.text)`
- `blockContentSig(block)` → `crypto` sha1 前 12 位（对 `relationContent`）
- `sharedFeatures(tfA, tfB, { idf, topN })` → 按 `idf × min(tf)` 取 top-N 共有 gram
- `relatedCandidates(block, pool, { idf, topN, minScore })` → `[{ to, why }]`
- `validateRelation(edge, lookup)` → `boolean`（三条检查：端点存在 / tag 相等 / 内容指纹一致）
- 常量：`SIM_THRESHOLD=0.15`（二次校准，spec §13.5：按文档 idf 下跨 tag 最高 0.312，
  0.32→0 对 = 功能失效）、`DUP_COS=0.95`、`MIN_LEN=20`、
  `MAX_RELATED=8`、`MAX_TAG_RELATED=5`、`MAX_CONTENT_RELATED=5`、`INDEX_VERSION=2`

**实现要点**
- `relatedCandidates` 用 `vectorizeText(content, { tagBoost: 1, idf })` + `cosine`。
  **`tagBoost` 必须为 1** —— 校准发现 boost 在归一化**之后**乘，带 boost 的值范数=boost、
  点积可达 9（非度量余弦），且 `tagBoost=3` 会让同 tag 对压过跨 tag 对、使覆盖层退化成骨架层重复。
  在常量旁写明这条理由
- `shared` 为空 → **丢弃该候选**（只有分数无法解释，宁缺勿滥）
- `cos >= DUP_COS` → `why.kind='duplicate'`，且**不计入** `MAX_RELATED`

**验证**
- `node --test shared/knowledge-core.test.mjs`（新增用例）
- **必测**：`stripTypePrefix` 对 `流程要点：xxx` / 无前缀 / 含中文冒号 / 空串；
  `shared` 为空时候选被丢弃；`tagBoost=1` 的 cosine ∈ [0,1]；
  duplicate 边界（0.95）；`MIN_LEN` 过滤（10 字空模板被排除）

---

### Task 2: 索引口径统一（`kernel/knowledge.mjs`）

**交付物**
- 向量/gram 路径的索引文本：`b.text` → **`relationContent(b)`**
- 关键词路径的 `summary` 参数同步改为 `relationContent(b)`；`full: b.full` 保持；
  `snippet` 仍取 `b.text`（**行为不变**）
- `INDEX_VERSION` 1→2 + 旧索引**自动重建**路径
- 记录若干真实 query 的**前后命中对比**（写入报告）

**实现要点**
- 实测检索两条路径信息量不一致：向量用 `text`（60 字截断摘要，实测 45 字 vs full 471 字），
  关键词用 `full` → 统一后**同时改善检索与关联**（共用同一索引）
- 重建必须**幂等且可重入**；版本不符时的行为写测试钉住

**验证**
- **S1 检索既有用例必须全过**（`kernel-tests/knowledge*.test.mjs`）
- 新增：版本不符触发重建；重建后命中不劣于重建前（前后对比写入报告）

---

### Task 3: 源头修数据卫生（`kernel/memory.mjs`）

**交付物**
- 生成条目时**跳过内容为空的模板**（实测 7 条：`流程要点：用户回答：`、`业务要点（请注意）：`）

**实现要点**
- 判断标准用 `relationContent` 长度（复用 Task 1，保持一致）
- **不动既有条目的解析兼容性**（存量垃圾条目仍能被读出，只是在关联/索引侧被过滤）
- 修源头只防"新产生"，存量靠 Task 1 的 `MIN_LEN` 防御 —— 两者**都要**（用户选定"修源头+防御"）

**验证**
- `node --test kernel-tests/*memory*.test.mjs`
- 新增：空模板输入不产生条目；正常内容仍产生条目

---

### Task 4: 物化（全量）+ manifest 指纹

**交付物**
- `related.jsonl` 写盘（`persist()` 内，与 `docs/inverted/links` 同生命周期）
- manifest 增 `relLines`
- 行形态 `{from, to, why, sigFrom, sigTo}`

**实现要点**
- 全量计算：`reindex` / 首次建索引
- **`relLines` 必须参与一致性检查**：`related.jsonl` 行数与 manifest 不符 → 视为损坏 → 重建
  （照 `docLines`/`invLines` 的既有做法）
- 参与集过滤：`kind==='entry'` 且 `relationContent.length >= MIN_LEN`
- **关联层用独立的一份「按文档 idf」**（`buildRelIdf()`：每篇文档聚合全部块的
  `countGrams(relationContent(b))` 成一个样本，一次 O(块数)），**不复用检索那份按块 idf**：
  按块统计会把常见词权重抬高、压低区分度，实测跨 tag 对最高 cos 0.238（按块，≥0.15 仅 2 对）
  vs 0.312（按文档，≥0.15 有 16 对）；检索 idf 不动 ⇒ 零检索回归（spec §13.5）。

**验证**
- 新增：物化后 `relLines` 正确；**人为截断 `related.jsonl` → 检测到并重建**（S1 教训的回归测试）
- 新增：垃圾条目 / duplicate 不出现在 `related.jsonl`

---

### Task 5: 增量（`updateDoc`）

**交付物**
- 重算该文档所有条目的**出边**
- **只对同 tag 的其它条目补入边**
- tag→blocks 查找：复用既有 tag 索引；否则**一次遍历**建 `Map<tag, blockId[]>` 内存缓存

**实现要点**
- **禁止 O(tags × blocks)**：不得对每个 tag 各扫一遍全库
- content 类**入边不即时重算**（已知取舍，spec §6.1 已明示并由用户确认）
- 增量后 manifest 的 `relLines` 必须同步更新（否则下次加载误判损坏）

**验证**
- 新增：改文档后同 tag 入边**即时可见**；出边已更新
- 新增：增量后 `relLines` 与文件行数一致

---

### Task 6: 读时校验 + `search()` 附锚点 + stats

**交付物**
- `getRelated(blockId, { validate = true, limit })`
- `search()` 每个 item 增 `related`：**只给摘要** `{blockId, docId, title, why, score}`，**不含正文**
- `stats().related = { edges, tagEdges, contentEdges, dupEdges, dropped }`

**实现要点**
- 校验三条：端点存在 / `tag` 相等 / 内容指纹一致；**只读语义**（不改文件）
- `dropped` 只统计**计算期**丢弃，**不含**读时校验剔除 —— 否则 stats 会随查询历史漂移、不可复现
- `search()` 附摘要时必须**控制体积**（不含正文），防上下文膨胀

**验证**
- 新增：块删除 / tag 变更 / 内容变更 → 边被剔除
- 新增：`validate: false` 返回未校验视图（用于调试）
- 新增：`search()` 的 `related` 不含正文字段（断言字段集合）
- 新增：stats 不随查询次数变化

---

### Task 7+8: CLI + 路由

**交付物**
- `kernel/knowledge-cli.mjs` 增 `--knowledge related --id <blockId> [--no-validate] [--limit N]`
- `server/knowledge-routes.mjs` 增 `GET /knowledge/related?id=&limit=`

**实现要点**
- CLI `--knowledge` 短路块在 `cli.mjs` 格式校验之后 → **必须带
  `--output-format stream-json --input-format stream-json`**（S1 踩过）
- 路由照 `/knowledge/links` 的写法与防护；非法 id → 400，不存在 → 404

**验证**
- 新增：CLI op 可用（含 `--no-validate`）；路由 handler 直调（**不起 bridge**）

---

### Task 9: GUI（S2 增量）

**交付物**
- `KnowledgeEntryCard` 底部「关联锚点」行：按 `why.kind` 分组（同主题 N / 相似 N），点击打开并定位
- `KnowledgeInspector` 在**反链之外**新增「关联」段
- `KnowledgeGraphView` 图层开关：**默认只显式链接**，隐式关联需手动开
- 疑似重复：在条目卡片**独立提示**（不在关联区）

**实现要点**
- 关联与反链**分栏**（语义不同：隐式派生 vs 显式引用）
- 图谱默认关隐式图层：实测当前只有 1 条显式链接，若默认全显，图谱会从 1 条边骤增、第一印象被噪声淹没
- 禁裸 hex / 禁 emoji / 光效白名单 / 单文件 ≤ 400 行 / `KnowledgePanel.tsx` < 200 行
- 纯逻辑（分组、排序、计数）抽 `src/lib/knowledgeRelations.ts` + `node:test`

**验证**
- `npm run typecheck && npm run build`
- `node scripts/verify-knowledge-gui.mjs`（若覆盖新组件，须保持通过）
- 人工走查清单（无 DOM 测试）

---

### Task 10: agent（S3 增量）

**交付物**
- `kernel/knowledge-inject.mjs`：注入语料中命中项附**锚点摘要**
- `KnowledgeSearch` 工具增 `related` 参数：给定 blockId 展开**一跳**

**实现要点**
- **不自动多跳**（防上下文膨胀）；锚点只给摘要
- 与 `knowledgeInjectMode`（legacy|unified）兼容：新增行为在两条路径下都可开关

**验证**
- 新增：命中附锚点；一跳展开受上限约束；`off` 时不附

---

### Task 11: 全量验收

**交付物**
- `scripts/verify-knowledge-relations.mjs`（可选但推荐）：
  对**合成库**断言阈值行为（0.32 边界、duplicate 归类、垃圾过滤、`shared` 必填）
- 报告：spec §11 的 15 项逐条结论（✅ 自动化 / 🔍 人工 / ❌ 未达标）
- 真实库前后对比（索引口径修正对检索的影响）

**验证**
```bash
node --test "kernel-tests/*.test.mjs"
node --test "server/*.test.mjs"
node --test "shared/**/*.test.mjs"
node --test "src/**/*.test.ts"
node --test "electron/*.test.mjs"
npm run typecheck && npm run build
node scripts/verify-knowledge-gui.mjs
```
基线：kernel 975 / server 373 / src 305 / shared 69 / electron 50（**注意**：其中 2 个
`server/reap-guard`+`stall-watchdog` 为**既有 flaky 集成测试**，会 spawn 真实 bridge，
在负载下可能失败——已用 BASE `12e8b1c` 对拍确认**与本项目改动无关**，
报告需如实标注，不得归因于本次改动）

---

## 任务 → 完成定义映射

| 任务 | 覆盖的验收项（spec §11） |
|---|---|
| 1 | 3, 4, 5, 6 |
| 2 | 11 |
| 3 | 3 |
| 4 | 8 |
| 5 | 7 |
| 6 | 1, 9, 13 |
| 7+8 | 10 |
| 9 | 13 |
| 10 | 14 |
| 11 | 2, 12, 15 |

## 附：批派顺序

```
1+3 (纯函数+源头) ──→ 2 (索引口径) ──→ 4+5 (物化+增量) ──→ 6 (读时+search)
                                                        └→ 7+8 (CLI+路由)
                                                        └→ 9 (GUI)
                                                        └→ 10 (agent)
                                                        └→ 11 (验收)
```
