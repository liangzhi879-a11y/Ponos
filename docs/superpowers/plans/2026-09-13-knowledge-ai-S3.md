# S3 知识库 AI 集成实施计划（7 任务）

> 规格：`docs/superpowers/specs/2026-09-13-knowledge-ai-integration-design.md`（**必读 §11 修订记录**）
> 依赖：S1 已交付 `kernel/knowledge.mjs`（store：`load/search/updateDoc/listEntries/stats`）、
> `kernel/knowledge-search.mjs`（`searchKnowledge`）、`kernel/knowledge-cli.mjs`（10 op）、
> `shared/knowledge-core.mjs`；S2 已交付 GUI（本期**不动** `src/`，除类型定义一处）
> 分支：`knowledge-s1`（worktree `.worktrees/knowledge-s1`）
> 日期：2026-09-13

## 目标

把 S1 造出来的知识库**接到 AI 侧**，三个主题：

1. **注入灰度切换**：`knowledgeInjectMode: 'legacy' | 'unified'`，缺省 `legacy`（= 现状逐字节行为），
   `unified` 用块级抽调替换图谱抽调（`graph.search`），两类注入共用同一 store 实例与一次 `load()`
2. **会话模式放行 `KnowledgeSearch`**（D2）：两份 `CHAT_(MODE_)DISALLOWED` 同步删该项，
   属**有意的语义变更**（见 §全局约束 2）
3. **抽调层粒度自适应**（D3）：默认摘要，预算有余量时对高分块升级为全文

## 全局约束（违反即返工）

1. **kernel ⊥ server 双向禁止 import**：全部注入逻辑落 `kernel/`；server 侧仅新增"读 config.json
   键 → 透传 env"（同 `buildChildEnv` 范式）
2. **两份禁用表必须同步改**：`kernel/tools.mjs:1053` `CHAT_MODE_DISALLOWED` 与 `server/bridge.mjs:1017`
   `CHAT_DISALLOWED`；`kernel-tests/chat-mode.test.mjs:148` 做逐项比对，只改一处即红。
   **语义变更声明**：S1 的 chat 语义是"纯联网、禁一切本地能力"；D2 放行 `KnowledgeSearch`（只读、
   不写盘、不执行、不出网）**收窄**了该语义。理由：chat 的隔离目的是"不让本地执行/写盘能力泄漏"，
   只读检索不构成该风险，且"问一句知识库里有没有 X"是纯聊场景的自然需求。实施后在 S3 报告与
   提交信息里显式记录；`MemorySearch` 不动（O(N) 全量扫描，chat 无收益）
3. **测试纪律：禁止启动 bridge**（本仓库有"测试起桥误杀运行中应用"的前车之鉴）——server 侧测试
   直调 handler / 注入假 `callKernel`
4. **配置项向后兼容**：`knowledgeInjectMode` 缺省 = `legacy`（= 既有行为），env
   `PONOS_KNOWLEDGE_INJECT_MODE` 优先于 `settings.memory.injectMode`；**缺省路径的输出必须与
   改动前逐字节一致**（legacy 基线由"改动前实跑抓取"确定，不凭想象）
5. **纯增量**：不删除 S1/S2 的导出与行为。`buildRelevantMemory` / `searchLocalMemory` /
   `graph.mjs` 一律保留；新增走开关
6. **测试隔离**：`mkdtempSync` + 显式 `configDir`（`PONOS_HOME`），**绝不碰真实 `~/.yfworking` / `~/.yfw`**
7. **中文注释解释 why**（仓库风格）
8. **不改 `server/bridge.mjs` 的注入行为**（`:1111` / `:1149` 的 `buildExperienceIndex` 两处照旧），
   只加 env 透传

## 完成定义（S3 验收标准 → 对应规格 §8）

| # | 验收项 | 方式 |
|---|---|---|
| 1 | 同一 query，`KnowledgeSearch` 与 `unified` 注入抽调层的 top-3 `blockId` **一致** | 单测（同 store 两路调用） |
| 2 | `MemorySearch` 老签名三档 `scope` 均可用，`all`/`personal` 结果等价于新实现 | 单测 |
| 3 | 写入后走**增量**路径即可检索到（`builtAt` 不变 / `updateDoc` 被调用），无需重启 | 单测 |
| 4 | 注入总字节 ≤ `experienceInjectMaxBytes`（内核侧 `settings.memory.injectMaxBytes`，默认 4096） | 单测断言（两层合计） |
| 5 | 索引损坏/检索异常 → 注入降级为纯索引层，会话继续；工具仍可用 | 单测（写坏 `.index`） |
| 6 | `stats`（`--knowledge stats` op + `GET /knowledge/stats`）含 `inject.*` 与 `search.elapsedP50/P95` | 单测 + 命令 |
| 7 | 注入内容无重复块（`blockId` 去重）+ 同文档 ≤ 2 块 | 单测 |
| 8 | `unified` 下 chat 模式**不注入**知识（保持 S1 的 chat 不注入记忆） | 单测（源码+行为双查） |
| 9 | 全量 `npm test` / `npm run typecheck` / `npm run build` 通过，基线不降 | 命令 |
| 10 | `knowledgeInjectMode` 缺省时，注入输出与改动前一致 | 单测（legacy 基线锁） |

## 节奏与已知取舍

- **TDD**：每个任务先写测试（`node:test` + `node:assert/strict`），再实现；纯函数先行。
- 每完成一个任务：**定向测试 → `npm run typecheck` → 立刻提交**（子 Agent 有 300s 工具超时，
  未提交的代码丢了代价远大于"提交粒度粗"）。
- 批次：① 复核+计划（文档）② Task 1+2 ③ Task 3+4 ④ Task 5+6+7。每任务一个提交。
- **不做 GUI 控件**：`knowledgeInjectMode` 只经 config.json / settings.json 生效（规格 §3.3 明示
  "不新增用户可见配置"）；`src/types/index.ts` 只加类型，设置页不加控件。

---

### Task 1: 会话模式放行 `KnowledgeSearch`（D2）

**交付物**
- `kernel/tools.mjs:1053` `CHAT_MODE_DISALLOWED` 删 `'KnowledgeSearch'`（权威表）
- `server/bridge.mjs:1017` `CHAT_DISALLOWED` 同步删（拷贝表，**必须逐项一致**）
- 两处注释补记"为什么放行"（只读/无写盘/无执行；D2 决策）+ 标注"这是有意的语义收窄"
- `server/knowledge-packaging.test.mjs`：断言方向反转（从"两份都含"→"两份都不得含"），
  测试名同步改；新增一条"两份表逐项一致"的独立断言？——**不必**，`kernel-tests/chat-mode.test.mjs:148`
  已做逐项比对，重复断言只增维护成本
- `kernel-tests/knowledge-search.test.mjs`：补一条"chat 模式下 `KnowledgeSearch` 在工具表中"的断言
  （现有测试已 `import { CHAT_MODE_DISALLOWED }`，同文件加最省）

**实现要点**
- 只删两项，不动 `MemorySearch`（见 §全局约束 2）
- `kernel/cli.mjs:477` 把 `CHAT_MODE_DISALLOWED` 传给 `createToolRegistry(disallowedTools)`；
  `:483` 的注释"chat 模式传 null ⇒ 该工具根本不在注册表里"要顺带核对——`KnowledgeSearch` 的
  `memoryRoot` 在 chat 下是否传？（若不传，工具会在运行期降级为"知识库检索不可用"提示，
  这会让"放行"变成**假放行**）

**验证**
- `node --test kernel-tests/chat-mode.test.mjs kernel-tests/knowledge-search.test.mjs server/knowledge-packaging.test.mjs`
- `npm run typecheck`
- **实测点**：chat 会话 `init` 帧的 `tools` 是否真含 `KnowledgeSearch` 且 `run` 不报"未配置 memoryRoot"

---

### Task 2: `kernel/knowledge-inject.mjs` —— 统一注入入口 + 粒度自适应

**交付物**
- 新建 `kernel/knowledge-inject.mjs`：
  ```js
  buildKnowledgeInjection({
    configDir, memoryRootDir, query, keywords, spaces = null,
    indexBudget = 4096, recallBudget = 2048, totalBudget = 4096, mode = 'legacy',
  }) → { indexSection, recallSection, stats }
  ```
  - `mode: 'legacy'` → `indexSection = buildMemoryIndex(...)`，`recallSection = ''`，
    `stats.strategy = 'legacy'`（**调用方**仍走 `graph.search`；本模块不引 graph，保持职责单一）
  - `mode: 'unified'` → 一次 `createKnowledgeStore() + load({})`；
    `indexSection` 复用 `buildMemoryIndex`（格式零变化，见 §11.3 N1）；
    `recallSection` 由 `store.search({ query, keywords, spaces, topK: 8, mode: 'snippet' })` 产块级行
- 模块级统计累加器：`getInjectStats()` / `resetInjectStats()`（`{ indexLines, recallBlocks, elapsedMs,
  degraded, strategy, lastIndexAgeMs }`，供 Task 6 输出）
- 新建 `kernel-tests/knowledge-inject.test.mjs`（TDD：先写）

**实现要点**
- **粒度自适应（D3）**：先按 `snippet` 打分排序，再**贪心装预算**——装到某块时若剩余预算
  足以容纳该块的 `full`（`it.full || it.text`）且该块 `score` 高于已装入块的均值，则升级为
  `full`；否则保留摘要。实现上先取 `mode:'snippet'` 的结果（score/顺序权威在 `store.search`），
  升级只改渲染文本，**不重新检索**（避免"两套排序"漂移）
- **去重**：`blockId` 级去重（一次检索内天然唯一）；**同文档 ≤ 2 块**（按 `docId` 计数，超限跳过）
- **预算**：`indexBudget : recallBudget = 2 : 1`，任一层未用满**让渡**给另一层
  （先算索引层实际占用，再 `recallBudget = max(minRecall, totalBudget - indexUsed)`；反之亦然）
- **降级**：`store.load()` / `store.search()` 抛错 → 捕获后只返回索引层 + `stats.degraded='error'`；
  耗时 > 500ms → 只保留索引层 + `stats.degraded='slow'`（**同步契约不能真中断**，见 §11.3 N5）
- 输出串头：`【相关知识抽调】…（格式：-[空间|标签] 摘要 -- 全文）`；每行含 `docId › heading · 第 N 行`
  与 score（与 `searchKnowledge` 的 where 串同构，模型不必学两套）
- `keywords` 为空的防御：`store.search` 的 `keywordScore` 对 `null` 走防御分支（S1 裁定），
  **一律传 `undefined`/省略**，不传 `null`（S2 §11.4 的同款教训）

**验证**
- `node --test kernel-tests/knowledge-inject.test.mjs`
- 断言：语法注入（含 `- [ ]` 复选框行）不被渲染为经验块；预算总额 ≤ totalBudget；
  同文档 ≤ 2 块；`degraded` 三态；`unified` 与 `KnowledgeSearch` 的 top-3 blockId 一致

---

### Task 3: 接线 `kernel/cli.mjs` + 灰度配置贯通

**交付物**
- `kernel/cli.mjs`：`:609-632` 的注入段改为经 `buildKnowledgeInjection`；`mode` 取值
  `settings.merged.memory?.injectMode || env PONOS_KNOWLEDGE_INJECT_MODE || 'legacy'`；
  `legacy` 分支**输出与改动前逐字节一致**（含 `graph.search` 那一段与 `buildMemoryIndex` 的顺序）
- `kernel/settings.mjs`：`SETTINGS_DEFAULTS.memory` 加 `injectMode: 'legacy'`、`injectMaxBytes: 4096`
- `server/bridge.mjs`：`experienceInjectConfig()` 读 `knowledgeInjectMode`（默认 `'legacy'`），
  spawn env 透传 `PONOS_KNOWLEDGE_INJECT_MODE`（缺省不传）；**不改注入行为**
- `src/types/index.ts:363` 附近加 `knowledgeInjectMode?: 'legacy' | 'unified'`
- 新建 `kernel-tests/knowledge-inject-legacy.test.mjs`（legacy 基线锁：先用**当前代码实跑**取值，
  再改造）

**实现要点**
- legacy 基线必须先抓：改造前用临时脚本/临时测试打印 `memoryBlock`（fixture 固定、mtime 固定），
  把该字符串固化进测试；**不要**凭 spec 想象内容（S1 计划手写期望值错了 6 处）
- chat 模式仍**不注入**知识（`if (!chatMode)` 守卫保留；虽然 Tool 放行了，注入面不变）
- `settings.memory.inject === false` 逃生阀保留（`:617`）

**验证**
- `node --test kernel-tests/knowledge-inject-legacy.test.mjs kernel-tests/knowledge-inject.test.mjs`
- `npm run typecheck && npm run build`

---

### Task 4: `MemorySearch` 转发为 `KnowledgeSearch` 适配器（§4.2）

**交付物**
- `kernel/tools.mjs:1355` `MemorySearch` 的 `run` 改为转发 `searchKnowledge`，映射：
  `personal → spaces=['experience']`、`project → spaces=['project-*']`（恒 0 命中，见 §11.3 N2）、
  `all → spaces=null`
- 输出格式保留（`【经验库命中 N 条，取前 M】` + `- [theme|tag] summary -- full（score · file）`），
  让老提示词/老会话零改动
- `kernel/memory-search.mjs` 的 `searchLocalMemory` **保留**（`@deprecated` 注释 + 说明退场纪律），
  新增可选薄封装 `searchLocalMemoryViaKnowledge()`？——**不做**：适配放 `tools.mjs` 的 run 内即可，
  多一层间接层只会让"哪个是权威实现"更难判
- `kernel-tests/memory-search.test.mjs`：补三档 scope 的等价性断言（`all`/`personal` 与
  新实现 top-1 blockId 同源）

**实现要点**
- `MemorySearch` 缺 `configDir` 时的降级路径与 `KnowledgeSearch` 一致（不猜路径，给提示）
- 无命中时的文案保持既有语义（"经验库无「X」相关命中"），**不要**换成知识库措辞，否则老提示词的
  "看到这句话就换关键词"策略会失配

**验证**
- `node --test kernel-tests/memory-search.test.mjs kernel-tests/knowledge-search.test.mjs`

---

### Task 5: 写入闭环 —— 增量更新索引（§5）

**交付物**
- `kernel/memory.mjs:50` `appendMemoryEntry` 增可选参 `knowledgeIndex = null`；写盘成功后
  `knowledgeIndex.updateDoc(toDocId('experience', `${theme}.md`))`（**失败不影响写入结果**）
- `kernel/cli.mjs:803` 传入 `knowledgeIndex`（复用同一个 store 实例：注入段已 load 过，
  此处若为 `null` 再按需创建）
- `kernel/cli.mjs:813` 会话工作记忆写完后，对 `session-memory/<sessionId>.md` 调 `updateDoc`
- `kernel/workflow-nodes.mjs:173` 的 `store` 节点：保持不传（该路径无 configDir，不猜路径），
  但在注释里记明"workflow 路径不更新索引，下次 staleness 全量重建兜底"
- `kernel-tests/knowledge-inject.test.mjs` 追加"写入后增量可见"用例

**实现要点**
- **`updateDoc` 前置条件**：文档必须**已在索引中**（`docs.findIndex` 未命中返回 `{updated:false}`）。
  新主题文件（第一次写入）→ `not-found` → **必须**回落 `store.load({ force: true })` 或
  `store.load({})`（staleness 会自己发现新文件）。这条是功能性关键，别漏
- 不改 `persist()`（增量与全量共用，S1 已写好的契约）

**验证**
- `node --test kernel-tests/knowledge-inject.test.mjs kernel-tests/knowledge.test.mjs kernel-tests/memory-search.test.mjs`
- 断言：既有主题追加 → `builtAt` 不变（走增量）；新主题首写 → 能检索到（走 staleness 重建）

---

### Task 6: 观测 —— `inject.*` 与 `search.elapsedP50/P95` 并入 `stats`

**交付物**
- `kernel/knowledge.mjs`：`search()` 记耗时入**内存环形缓冲**（100 条），`stats()` 增
  `search: { count, elapsedP50, elapsedP95 }`
- `kernel/knowledge-cli.mjs` `stats` op：合并 `getInjectStats()`（注入侧计数，模块级）
- `GET /knowledge/stats`（`server/knowledge-routes.mjs:120`）**自动**获得新字段（纯转发，零改动）
- `src/lib/knowledgeApi.ts` 的 `KnowledgeStats` 类型补新字段（GUI 暂不展示，避免 S2 面板改动；
  `src/components/knowledge/**` 本期不动）
- 测试：`kernel-tests/knowledge.test.mjs` 补 stats 字段断言；`server/knowledge-routes.test.mjs`
  补转发断言

**实现要点**
- P50/P95 用**排序取分位**（`arr[floor(n*0.5)]` 风格），不引第三方库
- 不落盘（进程内）：跨进程观测无意义，`--knowledge stats` 是新进程 → 该字段恒为 `count: 0`。
  **这条要写进注释**，否则用户会以为"指标坏了"。注入计数同理（跨进程不可见），
  故 `stats` op 输出的 `inject` 为该进程内的值（CLI 单次调用时恒为初值），
  真实用途在**长驻会话的日志/调试**与 `GET /knowledge/stats`（server 进程持有）
- 若 `inject` 在 CLI 单次调用下恒为空，是否还要输出？——**输出**（字段存在即契约，GUI 可渐进展示），
  在注释与报告里说明"跨进程不累计"的边界

**验证**
- `node --test kernel-tests/knowledge.test.mjs server/knowledge-routes.test.mjs`
- 命令：`node kernel/cli.mjs --knowledge stats`（临时 `PONOS_HOME`）打印一次，人工看字段

---

### Task 7: 全量验收 + 报告

**交付物**
- 更新 S3 spec：§11 增"实施期偏差补记"（照 S2 §11.6 格式，逐条列 3 处返工级前提 + 实施期新发现）
- `.superpowers/sdd/2026-09-13-knowledge-core-S1/s3-report.md`：spec 复核结论、计划摘要、实现清单、
  TDD 证据、**期望值修正清单**、全量测试结果、自审发现、疑虑、人工走查清单

**验证（全量）**
- `node --test "kernel-tests/*.test.mjs"` / `"server/*.test.mjs"` / `"shared/**/*.test.mjs"` / `"src/**/*.test.ts"`
- `npm run typecheck && npm run build`
- 人工走查：chat 模式 `init` 帧 tools 含 `KnowledgeSearch`；改 config.json `knowledgeInjectMode:
  'unified'` 后重启应用，注入块出现 `【相关知识抽调】`；改回 `legacy` 后消失

---

## 附：任务依赖与派发顺序

```
Task 1 (放行, 独立) ─────────────────────────────┐
Task 2 (注入模块) ── Task 3 (接线+灰度) ─┬─ Task 5 (写入增量)
                                        └─ Task 6 (观测)
Task 4 (MemorySearch 转发, 依赖 Task 2 的口径)
Task 7 (验收) 依赖全部
```

**可合并派发**：`1` 独立；`2+3`（强耦合）；`4`；`5+6`（都在接 store 写/观测，但改的文件不同，可合）；
`7` 最后。

**提交批次**：① 本文档 + spec §11 ② Task 1 ③ Task 2 ④ Task 3 ⑤ Task 4 ⑥ Task 5 ⑦ Task 6 ⑧ Task 7 报告。
