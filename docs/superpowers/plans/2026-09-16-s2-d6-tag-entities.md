# Plan：S2-D6 标签实体化（2026-09-16）

> 对应 spec：`docs/superpowers/specs/2026-09-14-team-collaboration-design.md` §6.2 D6（`:551`）、表后批注（`:554`）、§5.1 共享边界（`:214`）、§5.9 作用域（`:338`）、§10 S2 验收第 5 条、§13 决策闸门（`:785`）、§14-4（`:805`）。
> 前置：D1（收窄监听）、D2（token 鉴权）、D3（出网闸）、D4/D5（归属落盘 + byAuthor）均已完成并提交（`b254dfd`/`6275652`/`6df26ca`/`d6640b9`）。
> 本轮范围：**只做 D6**。

## 0. 闸门记录（开工前置，已满足）

- §13 表：`| **S2 的 D3–D6** | 📌 **#4**（D6 标签别名合并是否需人工审核） | — |`（`:785`）
- §6.2 表后批注：`> 倾向 5–20 人规模先自动合并 + 可撤销（§14-4）。**D6 落码前必须先定**`（`:554`）
- §14-4：`| 4 | 标签别名合并是否需人工审核 | … | **S2 的 D6 开工前必答** |`（`:805`）
- **用户裁定**：**#4 = 自动合并 + 可撤销**（5–20 人规模），已留痕于 `docs/待处理清单.md:527`（"该裁定**同时解锁 D6**"）⇒ **闸门解除，可落码**。

## 1. 契约（spec 原文拆解）

| 来源 | 原文要点 | 落为本轮的可验证命题 |
|---|---|---|
| §6.2 D6 现状 | 「三处**裸字符串**：`Conversation.tags`、知识 `collectTags`、经验标签」 | 三处盘点清楚 + 归一/解析有单一来源 |
| §6.2 D6 目标 | 「标签**独立实体** + **别名合并表** + **作用域（个人/团队）**。**不做强制受控词表**（太重，没人用）」 | ① 标签有稳定 id 的实体记录；② 别名表可合并、可解析；③ scope 隔离；④ **未注册标签必须原样通过**（不拒） |
| §6.2 批注 + §14-4 | 「5–20 人规模先**自动合并 + 可撤销**」 | 合并**无审核即生效**，且**可撤销**（撤销要能**逐字还原**被吸收的实体） |
| §5.1 | 「冷·内容：知识、经验、工作流定义、文件版本、**标签** → ✅ 双向」 | 标签属**会过团队源**的冷内容 ⇒ 实体 id 需**跨机可一致**（为 S3 双向同步的去重打底） |
| §5.9 | 一级形态 = 「个人 / 团队」模式开关；L1 恒 `personal` | scope 取值 `personal`/`team`，L1 默认 `personal` |
| §10 S2-5 | 「标签为独立实体，支持别名合并与个人/团队作用域」 | 即本轮验收口径；S2 验证方式 = **单测 + 安全回归** |

## 2. 现状盘点：三处裸字符串（含 file:line，均已实读）

| # | 落点 | 现状 | 消费面 |
|---|---|---|---|
| ① | **`Conversation.tags`** | `src/types/index.ts` 的 `Conversation.tags?: string[]`；由 `src/stores/chatStore.ts` 经 **zustand persist 写入 localStorage** | **无内核存储、无 UI 消费面**（无 `addTag/setTags/removeTag` 之类 action，组件层仅有知识文档标签），即"只存不用" |
| ② | **知识 `collectTags`** | `kernel/knowledge.mjs:385` 四路来源（frontmatter 数组/字符串、正文内联 `#tag`、经验/记忆空间的 basename、entry 块 tag），出口统一 `trim + 去前导 # + 去重`；结果落在 `doc.tags` | `listIndexTags`（`kernel/knowledge.mjs:2438`，经 CLI `--knowledge index-tags`）、关系边 `byTag`（`:1474`）、检索 `structBoost` |
| ③ | **经验标签** | `kernel/memory.mjs:71` `appendMemoryEntry` 把 tag 写进条目标题 `- [会话\|tag] …`；`validateAppendEntry`（`:311`）限制长度与字符 | `listMemoryTags`（`:355`，经 CLI `--knowledge tags`）、`listMemoryEntries`、`searchMemoryEntries`、知识索引的 `entryTag` |

**既有归一规则的"两处来源"（本轮必须处理，否则必然漂移）**：
- 渲染层 `src/lib/knowledgeTags.ts:21` `normalizeTag`：`trim → 去前导 # → 合并 // → 去首尾 / → trim`，空串→`null`（**展示层**纯逻辑）。
- 内核 `collectTags` 出口：只做 `trim + 去前导 # + 去重`（**不合并 `//`、不去首尾 `/`**）。

⇒ 若再加第三套规则，同一标签在"内核存的 / 展示的 / 合并表认的"三者间会各认一份，出现"合并了却仍显示两个标签"的鬼现象。故本轮把归一规则收敛为**一处**（`shared/tag-registry.mjs` 的 `normalizeTagName`），并以 **parity 测试**钉住它与渲染层规则一致（`src/lib/*.test.ts` **已有 import `shared/*.mjs` 的先例**：`knowledgeBlocks.test.ts`/`knowledgeQuery.test.ts`）。

## 3. 设计

### 3.1 唯一实现：`shared/tag-registry.mjs`（纯函数，无 IO）

- `TAG_SCOPES = ['personal','team']`、`DEFAULT_TAG_SCOPE = 'personal'`（§5.9）。
- `normalizeTagName(raw)` → `string|null`：与渲染层 `normalizeTag` **逐字同规则**（见 §2 末）；空 → `null`。
- **实体**：`{ id, name, scope, aliases: string[], createdAt, updatedAt }`
  - `id` = `tag-` + `hash(scope + '\0' + name)` 前 12 位 ⇒ **同名同 scope 跨机同 id**（§5.7「离线可生成、跨机稳定」的精神，且为 §5.1「标签双向」的去重打底）；**合并改名后 id 不变**（别名只是改名，不是换实体）。
- **注册**：`ensureTag(reg, raw, {scope, now})` 幂等；`raw` 先归一，命中**已有实体名或其别名** ⇒ 返回该实体，不新建（撞别名 = 同一实体，这正是别名表的意义）。
- **解析**：`resolveTagName(reg, raw, {scope})` → 规范名 | 原归一值（**未注册不拒**，§"不做强制受控词表"）；跟随别名链，**环安全**（visited 集合）。
- **合并（别名合并表）**：`mergeTag(reg, fromRaw, intoRaw, {scope, now})`
  - **自动**（无审核，per #4）：立即生效，返回 `mergeId`。
  - 拒绝并有明确 `reason`（**不静默**）：`same-tag`（自身合并）、`would-cycle`（会造成别名环）。
  - 不做受控词表 ⇒ 两侧标签**不存在则自动注册**再合并。
  - 实现要点：把 `from.name` **连同它自己的 aliases 一并**并入 `into.aliases`（否则 A→B 之后 B 的别名解析会断链），并从 `tags[]` 移除 `from` 实体；**快照**存进合并记录供撤销。
- **撤销**：`undoMerge(reg, mergeId)` → 用快照**逐字还原**被吸收实体（含其自身 aliases 与 `createdAt`），从目标实体剥回对应别名，记 `undoneAt`；重复撤销/未知 id 明确报错。
- `listTags(reg, {scope})`、`tagRegistryView(reg, {scope})`（供可观测面）。

### 3.2 持久化：`kernel/tag-store.mjs`

- 路径：`<configDir>/tags/registry.json`（沿用本项目"store 接 configDir 注入、模块不自解析 home"的既有约定）。
- `loadTagRegistry`（缺文件 → 空注册表，**不报错**）、`saveTagRegistry`（mkdir -p + **原子写**：tmp + rename，避免半截文件）、`syncTagNames({names})`（批量注册，**有变化才写盘**）、`makeTagResolver({configDir, scope})`（构造注入用解析函数）。

### 3.3 接入（**opt-in，默认路径零改动**）

| 落点 | 改法 |
|---|---|
| ② 知识 | `listIndexTags({ spaces, tagResolver })`：计数前把每个 `doc.tags[i]` 过解析器（合并后的别名折叠到规范名）。**不传 = 今日行为逐字不变** |
| ③ 经验 | `listMemoryTags(configDir, { tagResolver })`：分组键取解析结果。**不传 = 不变** |
| ① 会话 | `Conversation.tags` 属**渲染层 localStorage**（无内核存储、无消费面）⇒ 本轮提供**解析入口**（`GET /tags` 让渲染层/agent 可规范化），**渲染层接线属 UI，归 S3**（§0：S1/S2 不含 UI） |
| 生产接线 | `kernel/knowledge-cli.mjs` 的 `tags`（`:299`）与 `index-tags`（`:300`）两个 op 内构造解析器并注入 —— **不新增 CLI flag**，绕开 `kernel/cli.mjs` 那个"转发层漏登记即**静默失效**"的反复踩过的坑（`--spaces`/`--tag`/`doc`/`related` 均栽过，已由 `knowledge-cli-flags.test.mjs` 真进程钉住） |

### 3.4 可观测/可操作面：`server/bridge.mjs`

紧跟 D3 的 `/egress/policy` 路由之后（**同在 D2 闸门之后 ⇒ 自动受 token 保护**，无需改豁免清单、不削弱 D2）：

| 路由 | 语义 |
|---|---|
| `GET /tags` | 注册表视图（实体 + 别名 + 合并历史），即"标签体系当前长什么样" |
| `POST /tags/merge` | **自动合并**（返回 `mergeId`） |
| `POST /tags/undo` | **撤销** |

理由：D6 的"自动合并 + 可撤销"必须有**可调用的运行入口**，否则能力只存在于库里等人调；且桥是本项目内核能力的既有出口（工作流/知识/agent/mcp 皆如此）。

## 4. 关键决策（含取舍理由）

1. **不新增 CLI flag**：`kernel/cli.mjs` 的转发层有"漏一个键即静默失效"的**反复**踩坑史（注释里明确记录了 5 次），新增 flag 就要同时改 parseArgs + 转发层 + 真进程回归。桥路由 + 既有 op 接线已足够，**少一个高危面**。
2. **解析放在"读取聚合面"而非"建索引时改写 `doc.tags`"**：后者会改索引内容 ⇒ 必须 bump `INDEX_VERSION`（现为 `shared/knowledge-core.mjs:44` 的 **4**）⇒ 强迫全库重建、且把用户既有文件里的标签**悄悄改写**（不可逆）。读取面解析**零重建、零改写**。
3. **不改 D3 的 egress-policy**：§5.1 说标签是"冷·内容 ✅ 双向"，但 L1 无同步链路 ⇒ 给 `egress-policy` 加 `tag` 实体不是 D6 的验收内容，且改的是**已提交的 D3 产物**。⇒ **留给 S3**（同步落地时一并加），本轮如实记录。
4. **归一规则收敛到一处 + parity 测试**：见 §2 末。
5. **id 用"scope+name 的确定性哈希"而非自增序号**：自增序号在多机各自注册时必然撞号（都从 1 开始），而标签是要双向同步的冷内容（§5.1）⇒ 确定性 id 让"同名 = 同实体"跨机成立。

## 5. 任务

- **T1** `shared/tag-registry.mjs`（唯一实现：归一/实体/别名链/自动合并/可撤销/作用域）。
- **T2** `kernel/tag-store.mjs`（持久化 + 原子写 + 解析器工厂）。
- **T3** `kernel/knowledge.mjs`：`listIndexTags` 增 opt-in `tagResolver`。
- **T4** `kernel/memory.mjs`：`listMemoryTags` 增 opt-in `tagResolver`。
- **T5** `kernel/knowledge-cli.mjs`：`tags` / `index-tags` 两 op 注入解析器（生产接线）。
- **T6** `server/bridge.mjs`：`GET /tags` + `POST /tags/merge` + `POST /tags/undo`。
- **T7** 回归网：`kernel-tests/tag-registry.test.mjs`（纯逻辑 + 落盘 + 接入 + 端到端路由）与 `src/lib/tagRegistryParity.test.ts`（内核规则 ≡ 渲染层规则）。
- **T8** 门禁 + release 同步 + 提交。

## 6. 验证

1. **落盘实据**：断言**磁盘文件**里真的写了实体/别名/合并记录（不是断言函数返回值——沿用 D4 教训）。
2. **可撤销逐字还原**：合并 → 撤销 → 实体名/aliases/createdAt 与合并前**完全一致**。
3. **环安全**：A→B 后再 B→A 必须被拒（不是死循环、不是静默）。
4. **作用域隔离**：`personal` 与 `team` 同名标签是**两个实体**；personal 的合并不影响 team。
5. **不做受控词表**：任意未注册标签解析后**原样通过**（不被拒、不被丢弃）。
6. **默认路径零回归**：不传 resolver 时 `listIndexTags`/`listMemoryTags` 输出与今日逐字一致。
7. **端到端真机**：起桥 → 无 token 401 / 带 token 合并成功 → 查询可见 → 撤销成功（沿用 D2/D3 的真机取证法）。
8. **守门演练**：分别（a）让解析忽略别名、（b）去掉 scope 过滤、（c）让撤销不还原快照 ⇒ 新回归网必须**精准变红**。

## 7. 边界（诚实说明）

1. **S2 不含 UI**（§0）：`Conversation.tags` 的渲染层接线、标签树 UI 归 **S3**；本轮交付"实体 + 改名表 + 作用域 + 解析入口"。
2. **不做强制受控词表**（spec 明示）：注册表是**追加式**的，未注册标签一律放行。
3. **不改既有数据**：`doc.tags` 与经验行格式（`- [主题|tag]`）**一个字节都不动**；旧数据的"裸字符串"通过**解析**获得实体语义（无需迁移）。若将来要回填/改写既有文件，属破坏性操作，须单独批准。
4. **`team` scope 只有数据模型与隔离语义**：L1 无团队工作区实体（那是 S3），故实际只有 `personal` 在用；`team` 路径由单测覆盖。
5. **不做跨机同步**：`merges` 的冲突合并口径属 S3（本轮只保证"同 id 同实体"这一前提）。
6. **关系边/检索的别名化未纳入**：`byTag` 边与 `structBoost` 仍按原串（改它们会动索引内容 ⇒ 触发 `INDEX_VERSION` bump，见 §4-2），如实记录为后续项。

## 8. 实施记录与验证（2026-09-16）

**新增**：`shared/tag-registry.mjs`（规则唯一实现）、`kernel/tag-store.mjs`（持久化 + 解析器工厂）、`kernel-tests/tag-registry.test.mjs`（10 用例）、`kernel-tests/tag-registry-parity.test.mjs`（3 用例）、`server/tag-routes.test.mjs`（3 用例，真机）。
**修改**：`kernel/knowledge.mjs`（`listIndexTags` opt-in 解析器）、`kernel/memory.mjs`（`listMemoryTags` opt-in 解析器）、`kernel/knowledge-cli.mjs`（两 op 生产接线）、`server/bridge.mjs`（三路由）。

### 8.1 实施中的三个关键发现（原 plan 未预见）

1. **`kernel/tag-store.mjs` 的错误处理必须分"读侧降级 / 写侧拒绝"两态**：知识索引与记忆枚举是主链路，一个可选的便利功能（别名）坏掉不该把它们拖死 ⇒ 读侧遇损坏文件降级为空表继续跑；但写侧（合并/撤销）若也降级，一次自动合并就会把损坏内容**覆盖成空注册表**，抹掉本可人工恢复的数据 ⇒ 写侧严格抛错。回归网专门钉住"损坏文件必须原样保留"。
2. **`kernel/cli.mjs:382` 的注释指向了一个不存在的文件**：注释称 CLI 转发层由 `kernel-tests/knowledge-cli-flags.test.mjs` 以真进程钉住，但该文件**不存在**；实际真进程覆盖在同目录 `cli-subcommands.test.mjs`（我据实修正了自己的错误引用，并改跑真实存在的测试）。**注释与实现不一致本身是个隐患**（会误导后来者以为有防护），已记录。
3. **TS 侧无法直接 import `shared/*.mjs`**：全仓此前**没有**任何 `src/**/*.ts` 运行时 import `shared/*.mjs`（`knowledgeTags.test.ts` 里出现的 `shared/` 只是**文档注释里的路径提及**）。首次引入会触发 `tsc` 的 TS7016（JS 文件无类型声明），而本仓既无 `@ts-ignore` 先例、也不宜为此加 shim ⇒ parity 测试改放 `kernel-tests/*.mjs`（不过 tsc，且该目录 import `../src/lib/knowledgeTags.ts` 经实测可行——Node 类型剥离）。

### 8.2 守门演练（4 轮，含一次"演练本身无效"的发现）

| 轮次 | 注入 | 结果 |
|---|---|---|
| A（**无效**） | 令 `resolveTagName` 停止跟随别名链（`break`） | **10/10 仍绿**！—— 因为本实现把别名**扁平化**（合并时把源实体的 aliases 一并并入目标），解析恒为**单跳**，`while` 链循环只是防御性兜底。该注入改不动任何被断言的性质 ⇒ **换更有效的注入**（这正是演练的价值：暴露"我以为在测 A，其实没测到"） |
| **A′** | 让 `findTag` 不再查别名 | **8/10 红**，命中面正是所有依赖别名解析的用例（注册撞别名、链式跟随、合并后解析、撤销还原、落盘解析、知识/经验折叠） |
| B | 去掉 `findTag` 的作用域过滤 | **恰好 1 处红**（作用域隔离：`team 内不得受影响`）⇒ 定位精确、不误报 |
| C | 令 `undoMerge` 不还原实体 | **恰好 2 处红**（撤销逐字还原、落盘实据）⇒ 精准 |

四轮注入均已复原，终检 `演练` 关键字残留 **0**。

### 8.3 验证

| 项 | 结果 |
|---|---|
| **独立实体 / 确定性 id** | ✅ 同 scope 同名 → 同 id；异 scope → 异 id（`tag-<12hex>`）⇒ "同名=同实体"跨机成立（为 §5.1"标签双向"打底） |
| **别名合并表** | ✅ 合并后实体归并、别名落盘、`resolve` 折叠；批量 `resolveTagNames` 保序去重 |
| **作用域（个人/团队）** | ✅ 同名异 scope 是两个实体；personal 合并不影响 team；未知 scope 明确抛错（不静默当 personal） |
| **不做强制受控词表** | ✅ 未注册标签解析**原样通过**；合并两侧可**自动入册**（否则"库里有、未入册"的常态标签会被莫名挡住，D6 形同虚设） |
| **自动合并（无审核）** | ✅ 立即生效并返回 `mergeId`；失败**不静默**（`same-tag`/`empty-tag`/`already-merged`/`source-is-alias` 各带 reason 与可读 message） |
| **可撤销（逐字还原）** | ✅ 还原 name/id/aliases/createdAt，并从目标剥回别名；重复撤销 `already-undone`、未知 id `not-found`；记录保留 `undoneAt`（可追溯，不抹历史） |
| **环安全** | ✅ A→B 后 B→A 被拒为 `already-merged`（不死循环、不静默） |
| **落盘实据** | ✅ 真读 `<configDir>/tags/registry.json` 断言实体名/别名/merges；缺文件 → 空表（非错误）；**损坏文件 → 读侧降级 / 写侧拒绝覆盖且原样保留** |
| **零回归** | ✅ 不传 `tagResolver` 时 `listIndexTags`/`listMemoryTags` 输出与今日**逐字一致**；用户文件（知识 `.md` / 经验 `- [主题\|tag]`）**一个字节未改** |
| **真机端到端** | ✅ 起桥：`/tags` 无 token **401**、带 token 200；`POST /tags/merge` **无 token 401 且文件未创建**（不只是状态码——钉住"未授权不发生写入"）；合并后落盘可见、`GET` 可查、`POST /tags/undo` 撤销后两实体都在；错误路径均 400 且 reason 明确 |
| **门禁** | ✅ `npm run typecheck` 零错误 ｜ `server/*.test.mjs` **570/570**（含新增 3） ｜ `src/**/*.test.ts` **635/635** ｜ `electron/*`+`shared/**/*` **210/210** ｜ 内核分段：1–55 **747/747**、56–120 **535/535**、`knowledge-*` **325/325**、`memory-*` **25/25**、lane/loop **43/43**、mcp（除慢项）**32/32**、159–190 **214 项（1 skipped，0 fail）**、CLI 层 **39/39** |
| **未跑（如实）** | `loop-e2e`、`mcp-http`、`mcp.test`、`perf-baseline` 四个慢项（单次超 Bash 时限），与本轮改动无关 |
| **既有 flake（非本轮回归）** | `engine-perf-log`「行数=步数」并行满载时 `EPERM: Permission denied: …\Temp\perf-log-xxxx`（`rmSync` 清理竞态）；**同段复跑 535/535 全绿**、本轮未触碰该模块 ⇒ 既有 flake |
| 发布同步 | ✅ 7 文件与 `release/YFWorking/` **md5 逐一一致**（6 运行期 + 1 测试，保持 `server/` 镜像一致） |

### 8.4 边界（实现后重申）

1. **S2 不含 UI**：`Conversation.tags` 在渲染层 localStorage、**无 UI 消费面**（无 add/remove action）⇒ 本轮提供解析入口（`GET /tags`），渲染层接线属 UI（S3）。
2. **`team` scope 只有模型与隔离语义**：L1 无团队工作区实体（S3），实际只有 `personal` 在用。
3. **不改既有数据、不 bump `INDEX_VERSION`**：解析在读取聚合面完成，`doc.tags` 与经验行格式零改动（无需迁移、不触发全库重建）。
4. **未含跨机同步**：`merges` 的冲突合并口径属 S3；本轮只保证"同 id 同实体"这一前提。
5. **关系边与检索未别名化**（`byTag`/`structBoost` 仍按原串）——改动它们会动索引内容，需 `INDEX_VERSION` bump，属后续项。
6. **未给 `egress-policy` 加 `tag` 实体**：§5.1 说标签是"冷·内容 ✅ 双向"，但 L1 无同步链路 ⇒ 留 S3（避免改已提交的 D3 产物）。
