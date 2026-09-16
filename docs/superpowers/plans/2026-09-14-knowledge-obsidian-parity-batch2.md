# 知识库对标 Obsidian —— 批次 2 实施计划（引用体系）

> 来源：2026-09-14 对标分析（Obsidian 官方帮助中心 `obsidianmd/obsidian-help` 的 links / embeds / backlinks / unlinked-mentions / graph 页）。
> 批次 1（元数据/标签/内链/检索呈现）已交付：`2026-09-14-knowledge-obsidian-parity-batch1.md`。本文件只含**批次 2**。

## 目标（本批次交付即算完成）

1. **引用带位置**：`[[note#标题]]` 点进去要落到**那一节**，不是文档开头。当前锚点在解析阶段被整段剥掉，落盘时就没了。
2. **嵌入与引用可区分**：`![[note]]` 是嵌入（内容显示在此处），`[[note]]` 是引用（一个入口）。当前正则从 `[[` 起匹配，`!` 被无视 —— 两种语义在数据层完全同形。
3. **同文档锚点可用**：`[[#小节]]` 是文档内目录式跳转的常用写法。当前因 `to` 为空被 `!t` 短路**整条丢弃**。
4. **块锚点语义**：`[[note#^blockId]]` 的 `^` 是语法标记而非 ID 的一部分；当前无任何块 ID 概念。
5. **反链带上下文**：反链要给出"在哪一行、那一段说了什么、引的是哪一节"，而不是只有来源文件名（用户看到文件名却得从文档开头自己翻）。
6. **未链接提及**：全库里"提到这篇文档但没打链接"的位置 —— Obsidian 的核心发现机制，把孤立文档织成网的入口。
7. **断链清单**：`target` 为 null 的引用按目标名聚合，是**待办**而不是统计数字。
8. **图谱局部图**：以某文档为心、N 跳**双向**邻域。全局图在文档多起来后是毛线球，只能当装饰看。
9. **修既有缺陷**：`relinkDoc`（增量更新路径）丢 `line`/`block`/`anchor` —— 任何文件被编辑过之后，它的引用质量就悄悄退化（不报错、不抛异常）。

## 硬约束（违反即为做错）

- **只增字段，不改既有字段语义**：唯一例外是 `links` 的 `to`（`'a#x'` → `'a'`，锚点移入 `anchorRef`），因此 **`INDEX_VERSION` 必须 3 → 4**：老索引里同文档锚点不是"字段缺失"而是"数据从来没落盘"，只加字段无法恢复。
- **单一定义**：链接行的产出只有 `linkRowsOf` 一处（全量建索引与增量更新共用）。批次 1 已因"两份实现字段不一致"吃过亏。
- **不碰无关文件**：工作树可能含其他会话的未提交改动 —— 只改本计划列出的文件，**禁止 `git add -A`**。
- 前端**不 import** `shared/*.mjs`（仓库既有约定：前端 lib 手写同口径实现 + 注释标注来源）。
- **不臆造分值/阈值**：凡涉及分值与上限，依据写进注释（如 `MIN_MENTION_LEN=2`、`SNIPPET_LEN=120`、`EMBED_MAX_BLOCKS=12`）。

## 范围（本批次做）

| 层 | 改动 |
| --- | --- |
| `shared/knowledge-core.mjs` | `extractLinks` 返回 `anchorRef`/`anchorKind`/`embed`/`self`，`to` 剥离锚点；新增 `splitWikiAnchor`；`resolveLinkTarget` 支持 `self`；`INDEX_VERSION` 3→4 |
| `kernel/knowledge.mjs` | 抽出 `linkRowsOf`（单一定义）；`relinkDoc` 改用它；落盘/回读/内存三处**同一组字段**；`getLinks` 出链补位置、**反链补 line/block/锚点/snippet**；新增 `listMentions` / `listBrokenLinks`；`getGraph` 支持 `around`+`hops` 双向局部图、去自环、去重边、端点必在节点集内 |
| `kernel/knowledge-cli.mjs` | 新 op `mentions` / `broken-links`；`graph` 接受 `--around`/`--hops` |
| `kernel/cli.mjs` | 登记并转发 `--around`/`--hops`（三层链路的坑见"复用价值"） |
| `server/knowledge-routes.mjs` | `GET /knowledge/mentions`（缺 id → 400）、`GET /knowledge/broken-links`、`/knowledge/graph?around=&hops=` |
| `src/lib/knowledgeBlocks.ts` | `splitWikiLinks` 支持嵌入/锚点/同文档锚点；新增 `normalizeAnchorText`、`resolveAnchorIndex` |
| `src/lib/knowledgeInspector.ts` | 新增 `groupBacklinks`（按来源分组、组内按行升序、保留上下文） |
| `src/lib/knowledgeApi.ts` | 引用类型补全；新增 `getMentions` / `getBrokenLinks`；`getGraph` 支持局部图参数 |
| `src/hooks/useKnowledge.ts` | `useMentions` / `useBrokenLinks`；`useGraph` 局部图参数进缓存键 |
| `src/stores/knowledgeStore.ts` | `targetAnchor` + `setTargetAnchor` + `openAtAnchor`；换文档/切空间/按块跳转都清锚点 |
| 组件 | `KnowledgeWikiText`（嵌入渲染 + 锚点跳转）、`KnowledgeDocView`（锚点定位 + 未命中提示）、`KnowledgeInspector`（反链上下文 / 未链接提及 / 断链）、`KnowledgeGraphView`（局部图开关 + 跳数） |
| i18n | 中英各 13 键 |

## 明确不做（属批次 3/4）

- 搜索语法层（`file:` / `tag:` / `path:` / `line:` / 布尔 / 正则 / 分页）——批次 3。
- 写入原子化（tmp+rename）、fs watcher、覆盖前自动入回收站、`walkMd` 静默截断出声——批次 4。
- `[[` 自动补全、Bases/Canvas 类视图、跨空间隐式关联。

## 实施记录（2026-09-14 完成）

**验证结果**

- `npm test`：**2482 tests / 2481 pass / 0 fail**（`app-tools-mount`、`engine-ask-user` 两例在并行下偶发 `EPERM` 删临时目录 —— Windows 环境竞态，单跑 5/5 通过，与本次改动无关）。
- `npx tsc --noEmit`：通过。`npx vite build`：exit 0。
- 真进程 CLI 实测（临时 `PONOS_HOME`）：锚点引用解析到目标文档、`![[x]]` 标 `embed`、`[[#小节]]` 保留为 `self`、`mentions` 命中/排除已链接/排除自身、`broken-links` 聚合计数、局部图 1/2/3 跳双向且孤岛不入图 —— 全部符合预期。
- 新增/改动测试：`shared/knowledge-core.test.mjs`、`kernel-tests/knowledge.test.mjs`（+5 个批次 2 用例）、`kernel-tests/knowledge-parity.test.mjs`（+3 个真进程链路用例）、`server/knowledge-routes.test.mjs`（+4 个路由用例）、`src/lib/knowledgeBlocks.test.ts`（+4）、`src/lib/knowledgeInspector.test.ts`（+2）、`src/stores/knowledgeStore.test.ts`（+2）。

**与计划的差异（含原因）**

1. **反链上下文（`snippet`）在 getLinks 里现算**，未做反向索引。理由：真实库边数在几百量级，为它维护一份"需要同步的派生数据"的收益抵不上风险（ref 边消失的教训）。边数上千再谈。
2. **嵌入默认折叠、点击才拉数据**，而非自动内联渲染。理由：本应用内核是子进程，自动内联 = 打开文档时为每个嵌入起一次请求；且嵌入常是"备查"性质。展开后只渲染前 12 块且**不递归** —— 嵌入互嵌会成环，递归渲染直接爆栈。
3. **`listMentions` 的 limit 是"扫到就停"**，不是扫完再截断。大库上这条路径会扫几万个块，扫完再截是白烧 CPU。
4. **图谱过滤掉了自环边**（`[[#x]]` 产生 from===to）。自环在力导向布局里表达不了任何关系，只会让节点自己抖。数据层照常保留（反链/提及面板要显示它）。
5. **`getGraph` 的 `hops` 上限 clamp 到 3**（CLI 层与内核各 clamp 一次）。4 跳后在典型库上已回到"大半张图"，失去收敛意义。
6. **前端 `useGraph` 的位置参数**（`local?: {around, hops}`）而非展开对象。理由：与既有 `(space, limit)` 签名保持兼容，调用点改动最小。

**已知边界（本批次不修）**

- 锚点解析不到时**提示但不跳转**（`anchorMissing`，4 秒自动消失）——不悄悄跳文档开头，那会让人以为锚点生效了。
- 未链接提及只匹配**标题 + 文件名 stem**，不做别名/同义词（保守：宁可漏报，误报会让面板变噪声）。
- 局部图不改变"全部空间"语义：`around` 的文档不属于当前空间过滤范围时会**回落全局图**（不报错、不空图）。
- `relinkDoc` 修复只对新写入生效：**历史被编辑过的文档缺 `line`/`block` 字段需重建索引**（`INDEX_VERSION` 4 已触发一次全量重建，正好覆盖）。

**复用价值高的坑（本批次实际踩到）**

1. **`--around`/`--hops` 与批次 1 的 `--spaces` 同一个坑**：`cli.mjs` 的 `parseArgs` 未登记 → 静默忽略；`knowledgeArgs` 白名单漏转发 → 静默吞掉。两层都"不报错"，单元测试各测一层全绿也发现不了，**必须真进程钉**。
2. **工具陷阱：Edit 的 `new_string` 里出现 `$&`/`$'` 会被当成替换模式**，把旧内容插入新代码（本次在写 `new RegExp` 时踩到，靠逐行核对 + python 按行修复）。写正则相关代码时优先用替换函数或避免 `$` 序列。
3. **python heredoc 里的反斜杠会被 shell 处理**（`\\n` 变成真换行），导致写入的 JS 字符串跨行、语法报错。处理转义时用 `chr(92)` 拼接，写完必须 `sed`/`Read` 回看实际字节。
4. **`resolveAnchorIndex` 的 `^id` 正则别手工转义**：先把 ref 过滤到 `[A-Za-z0-9_-]` 再造正则 —— 比逐个转义元字符更短且不存在漏转义。
