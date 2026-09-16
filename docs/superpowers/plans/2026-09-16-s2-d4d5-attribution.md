# Plan：S2-D4/D5 归属字段落盘 + byAuthor 聚合（2026-09-16）

> 对应 spec：`docs/superpowers/specs/2026-09-14-team-collaboration-design.md` §6.2 D4、D5、§5.9「数据模型影响」、§10「S2 验收」、§13 决策闸门表。
> 前置：D1（收窄监听）、D2（token 鉴权）、D3（出网闸）已完成（见同目录另三份 plan）。
> 本轮范围：**只做 D4 + D5**。D6（标签实体化）不在本轮。

## 0. 闸门记录（开工前置，已满足）

§13 决策闸门表：`| **S2 的 D3–D6** | 📌 **#4**（D6 标签别名合并是否需人工审核） | — |`。
**#4 已由用户于 2026-09-16 裁定**（「自动合并 + 可撤销」）⇒ D3–D6 的闸门前置**已解除**，D4/D5 可开工。
另：#5（模式开关对"新建内容归属"是否有例外）的闸门是 **S3**（§13），**不卡** D4/D5；本轮按 §5.9 字面执行（L1 恒 `personal`）。

## 1. 契约（spec 原文拆解）

| 来源 | 原文要点 | 落为本轮的可验证命题 |
|---|---|---|
| §6.2 D4 改前 | 「transcript / 记忆 / 工作流 均无 author；经验作者位硬编码 `[会话]`（`kernel/memory.mjs:74`）；无工作区概念」 | 三处写入点各补 `authorId` + `workspaceId` |
| §6.2 D4 要求 | 「**三处**补 authorId 与 workspaceId（§5.9）。**L1 阶段作者恒为本人、工作区恒为 `personal` 也要写**——后补 = 全量数据迁移」 | 写入的每条记录都**实际带**这两个字段（不是留空、不是我方内存态） |
| §5.9 | 「会话、知识条目、经验、工作流均需带归属工作区；个人工作区用固定值 `personal`」 | 四类中：**知识条目已由既有 `spaceId` 承载**（`docId = spaceId/relPath` + `.space.json`）⇒ 本轮补其余**三处**，与 D4 的"三处"自洽 |
| §6.2 D5 | 「`kernel/stats.mjs` 有 `byProject`，缺 `byAuthor`。纯函数加 bucket，成本极低；**前提是 D4 已落盘**」 | `aggregateUsage` 增加 `byAuthor` 分桶；数据来自 D4 落盘的 `authorId` |

## 2. 前置盘点：三处写入点（含各自的"为什么这样落"）

| # | 落盘点 | 现状 | 本轮落法 |
|---|---|---|---|
| 1 | **会话 transcript**：`kernel/session.mjs` 新会话写首行 `{type:'meta',kind:'transcript',schemaVersion,timestamp}` | 有 meta 首行、无归属 | meta 首行**追加** `authorId`/`workspaceId`（该文件头已明示"在既有字段之上扩展**可选字段（旧文件可加载）**"⇒ 合规，且**不 bump `TRANSCRIPT_SCHEMA_VERSION`**：旧文件视为 v1、新字段可选） |
| 2 | **经验/记忆**：`kernel/memory.mjs` 写 `<configDir>/memory/personal/<theme>.md`，条目行 `- [会话\|标签] 摘要 -- 全文`，文件 frontmatter 为 `name/description/active` | 无归属 | 写 **frontmatter**（`authorId`/`workspaceId`）。`parseFrontmatter` 的正则 `^([\w-]+):\s*(.*)$` 天然容纳 camelCase 键，读取侧零改动 |
| 3 | **工作流**：`server/workflow-store.mjs` 的 `writeWorkflowYml`（所有写入路径的收口） | YAML 元数据经 `grab(text,key)` 解析 `name/description/version` | 在**收口处**注入 `authorId`/`workspaceId`（缺失才写，幂等），并让 `parseWorkflowMeta` 暴露二者 |

**为什么记忆不写进 `[会话|标签]` 那个"作者位"（与 spec 字面有偏差，如实说明）**：该槽位是**模型可见/人可见**的格式，且被既有解析与哈希去重依赖（`server/*.test.mjs` 与经验库文档均按 `[会话|标签]` 书写）。把机器字段塞进去会：① 破坏跨层格式契约；② 造成"旧条目旧格式、新条目新格式"的混合态，而哈希去重/索引按行文本比较 ⇒ 同一条内容写法一变即视为两条。文件 frontmatter 是本文件**已有的**结构化元数据位（已承载 `name/description/active`），同样满足"落盘"这一实质要求。L1 单作者场景下，主题级与条目级归属等价；S3 若需条目级，应在条目行增加**可选后缀**并与模型可见格式一并评审（本轮不做）。

**为什么 transcript 不逐条注入、而只在 meta 首行**：transcript 的每条 entry 由内核按既有契约追加（`type/id/timestamp/message` + 可选 `seq/surfaceOp/kind`），per-entry 加字段会改每条写入路径与体积；而归属是**会话级**属性，meta 首行是它的自然位置。读取侧由 `kernel/readonly.mjs:87`（已在做 `entries.push({ ...e, sessionId: sid, project: dirName })`）在每个文件解析时**读一次 meta、注入到该文件所有条目** —— 与既有 `project`/`sessionId` 注入**同层同模式**，并让 `aggregateUsage` 保持纯函数。

## 3. 单一实现：`shared/attribution.mjs`

三处写入点分属 `kernel/`（ESM）与 `server/`（ESM），`shared/` 是既有跨层位置（`kernel/memory.mjs` 已 import `../shared/knowledge-core.mjs`）⇒ 归属解析放 `shared/attribution.mjs`，**一处实现、四处引用**（P7 不造平行体系）。

- `DEFAULT_WORKSPACE_ID = 'personal'`（§5.9 字面）。
- `LOCAL_AUTHOR_ID = 'local'`：L1「作者恒为本人」⇒ 值为常量；`YFW_AUTHOR_ID` / `YFW_WORKSPACE_ID` 可覆盖，作用有二：① 让**测试能证明字段真的落进了文件**（用非默认值写、再读回断言），否则"写死常量"与"根本没写"在断言上无法区分；② S3/S4 引入真实成员体系时无需改动任何调用点。
- `attributionOf({ env })` → `{ authorId, workspaceId }`；`withAttribution(record, opts)` → 浅合并（**不覆盖已有非空值**，保证幂等与"不自作主张改写"）。

**不做的**：不生成 per-install 身份（spec 未要求，且"本人"在 L1 就是常量）；不落盘身份文件（无消费方 = 造无效复杂度）。

## 4. D5：`byAuthor` 分桶

- `kernel/stats.mjs` 的 `aggregateUsage` 增 `byAuthor`，键取 `e.authorId`，**缺省归入 `'unknown'` 桶**（旧 transcript 无 meta ⇒ 没有 authorId；显式成桶比静默丢弃可诊断）。
- 与既有 `byProject` 完全同构（同层、同形态、同"父对象带总量"约定），保持 `server/transcript.mjs` 的 `aggregateStats` 键名兼容（该文件头已声明键名兼容契约，**新增键是加法**）。
- 只加 `byAuthor`（spec 只说这一个）；不加 `byWorkspace`——那是另一条，需另行确认口径。

## 5. 任务

- **T1** 新增 `shared/attribution.mjs`（唯一实现）。
- **T2** `kernel/session.mjs`：meta 首行写入 `authorId`/`workspaceId`。
- **T3** `kernel/readonly.mjs`：解析 meta 首行 → 逐条注入 `authorId`/`workspaceId`（与 `project` 同处）。
- **T4** `kernel/memory.mjs`：写 frontmatter 归属（已存在则不覆盖）。
- **T5** `server/workflow-store.mjs`：`writeWorkflowYml` 收口注入 + `parseWorkflowMeta` 暴露。
- **T6** `kernel/stats.mjs`：`byAuthor` 分桶。
- **T7** 回归网 `kernel-tests/attribution-d4d5.test.mjs`：真机写读回环（写 → 落盘文件里能 grep 到字段 → 读回），正反两面（非默认 env 值必须落盘；幂等不覆盖）；`byAuthor` 分桶含 `unknown` 兜底。
- **T8** 门禁 + 发布同步。

## 6. 验证

1. **落盘实据**：三处各写一次 → 在**文件内容**里断言字段存在（不是断言函数返回值，否则无法区分"写了"与"算出来了"）。
2. **兼容**：旧格式文件（无 meta / 无 frontmatter 字段）仍可加载，且 `byAuthor` 不报错（归 `unknown`）。
3. **守门演练**：关掉注入 → 新回归网必须精准变红。
4. 门禁全绿 + release 同步 md5 一致。

## 7. 边界（诚实说明）

1. **L1 值是常量**（`local` / `personal`）：本轮交付"字段落盘 + 贯通读取"，**不含**真实成员/工作区体系（S3/S4）；多机数据合并时的身份映射尚未定义。
2. **记忆归属是主题级**（frontmatter），非条目级 —— 理由与偏差见 §2。
3. **不改 `TRANSCRIPT_SCHEMA_VERSION`**，旧 transcript 视为 v1 且可加载（新增字段为可选）。
4. 既有历史数据**不做回填**（spec 只说"后补 = 全量数据迁移"要避免，未要求迁移既有数据；回填会改写用户既有文件，属破坏性操作，须单独批准）。
5. 只加 `byAuthor`，不加 `byWorkspace`（未在 D5 字面）。

## 8. 实施记录与验证（2026-09-16）

**改动文件（7 个）**：`shared/attribution.mjs`(新)、`kernel/session.mjs`、`kernel/readonly.mjs`、`kernel/memory.mjs`、`kernel/stats.mjs`、`kernel/workflow-dsl.mjs`、`server/workflow-store.mjs`，另新增回归网 `kernel-tests/attribution-d4d5.test.mjs`（6 用例）。

### 8.1 实施中的两处新发现（原 plan 未预见，均为"不做就会静默丢数据"）

1. **工作流 DSL 的白名单会静默丢弃归属**：`kernel/workflow-dsl.mjs` 的 `TOP_KEYS`（`toModel` 投影白名单）与 `serializeWorkflow`（只输出已知键）原本不含 `authorId/workspaceId` ⇒ GUI 编辑器"加载→序列化"一往返就把归属**抹掉**。这比"不写"更糟：数据看起来已归属，实则下次保存即消失。故两个键必须同时进入**投影白名单**与**序列化输出**（T5 因此扩为两处 + store 收口）。
2. **`parseWorkflowMeta` 缺键返回空串而非 null**：`grab()` 的既有行为（`name`/`description` 同此）。我的注释初稿写成 null，已被回归网抓住并改正 —— **对齐既有约定**，用 falsy 判断区分"从未记录"与"已归属"。

### 8.2 既有测试的契约变更（3 处，已最小化改写）

`server/workflow-api.test.mjs` 有 3 处"存盘 yml 与原文本**逐字节相等**"的断言（`:60` 新建落盘、`:245` 复制、`:356` 回滚恢复快照）。由于每次写入都会由收口补两行元数据，这些断言必然失败。处理：**保留收口注入**（最忠实于 D4"写入时必须带归属"，且让旧工作流在下次保存时自然补上，无需回填脚本），测试改为 `contentOf()` **剥离归属行后比较内容** —— 原意（"落盘的就是这份内容"）不变，归属落盘另有专门覆盖。这是一次**有意的契约变更**，不是"改测试迁就实现"。

### 8.3 验证

| 项 | 结果 |
|---|---|
| **落盘实据（核心）** | ✅ 三处均在**磁盘文件**上断言到非默认归属（`alice-d4d5`/`ws-d4d5`）：① 会话 transcript meta 首行；② 经验 frontmatter；③ 工作流 YAML。**故意用非默认值**——若只断言默认值（local/personal），"字段真落盘"与"根本没写、读侧返回默认值"无法区分 |
| **读取注入** | ✅ `kernel/readonly.mjs` 从 meta 解析后注入该文件每条 entry（与既有 `project`/`sessionId` 同层）；`aggregateUsage` 保持纯函数 |
| **旧数据兼容（不伪造）** | ✅ 旧 transcript（无 meta 归属）仍可加载，且 `authorId === undefined` ⇒ `byAuthor` 落 `unknown` 桶（`input_tokens: 7` 可数）；**不得**被算到默认作者头上。旧工作流 `parseWorkflowMeta().authorId === ''`（falsy） |
| **byAuthor 分桶** | ✅ 多作者分桶正确（a=40/2turns、b=20、unknown=40）；桶结构与 `byProject` 同规格（含 `turns`）；既有键 `totals/byModel/byProject/byDate` 均保持 |
| **幂等** | ✅ 经验重复写入不累积 frontmatter 字段（`authorId:` 计数恒为 1），且**已有归属不被后续写入覆盖**（改 env 后仍是原值）；工作流重复保存同理 |
| **往返不丢** | ✅ `toModel` 保留归属、`serializeWorkflow` 回写归属（即 §8.1 第 1 点的守卫） |
| **守门演练 A**（三处落盘点同时失效） | ✅ **4 处精准变红**：`会话归属必须真的写进 meta 首行`、`frontmatter 必须真的落 authorId`、`工作流 YAML 必须真的落 authorId`、`byAuthor 应按 D4 落盘的作者分桶`（`unknown` 桶反而出现） |
| **守门演练 B**（DSL 白名单失效） | ✅ **恰好 1 处变红**（`toModel 投影不得丢弃归属`），其余 5 条仍绿 ⇒ 该守卫定位精确、不误报 |
| 恢复 | ✅ 两轮注入均复原，`演练注入` 残留 0、白名单复原，回归网回绿 6/6 |
| 门禁 | ✅ `npm run typecheck` 零错误 ｜ `server/*.test.mjs` **567/567** ｜ `src/**/*.test.ts` **635/635** ｜ `electron/*` + `shared/**/*` **210/210** ｜ `kernel-tests/*` 分段实跑：1–60 **781/781**、61–120 **501 项 1 fail**、121–140 **167/167**、141–150（排除两个慢项）**65/65**、151–162 **88/88**，另 `session/readonly/memory/stats/transcript/redact` 定向集与 `workflow-*` **89/89** 全绿 |
| **内核那 1 项 fail 的归因（如实记录）** | `engine-perf-log.test.mjs`「PONOS_PERF=1：行数 = 步数…」在**并行满载**时失败，报错为 `EPERM: Permission denied: …\Temp\perf-log-xxxx`（Windows 临时目录清理竞态）；**单跑 3/3 全绿**，且本轮**未触碰** `engine*`/perf-log 任何代码 ⇒ 既有并行 flake，非本轮回归。**未跑**：`loop-e2e`、`mcp-http`（单次超 Bash 时限），两者与本轮改动无关，如实记为未覆盖 |
| 发布同步 | ✅ 7 文件与 `release/YFWorking/` md5 逐一一致（本轮无渲染层改动，`dist/` 无需重建） |

### 8.4 边界（实现后重申）

1. L1 取值是常量（`local`/`personal`），**不含**真实成员/工作区体系（S3/S4）；多机合并的身份映射未定义。
2. 记忆归属为**主题级**（frontmatter），非条目级（理由见 §2；偏差已如实记录）。
3. **不回填既有历史数据**（会改写用户文件，属破坏性操作，须单独批准）；旧工作流走"下次保存自然补上"。
4. 未改 `TRANSCRIPT_SCHEMA_VERSION`（新字段为可选扩展，旧文件视为 v1）。
