# 知识库对标 Obsidian —— 批次 1 实施计划（元数据 / 标签 / 内链 / 检索呈现）

> 来源：2026-09-14 对标分析（对照 Obsidian 官方帮助中心 + `obsidianmd/obsidian-releases` 分发生态）。
> 本计划只含**批次 1**（低成本高收益、不动架构），批次 2/3/4 见分析结论另列。

## 目标（本批次交付即算完成）

1. **frontmatter 吃得下 Obsidian 写法**：`tags:` 的 block 列表 / flow 数组 / 引号 / 注释 / 多行折叠——当前这三种标准写法里**两种是坏的**（列表 → 解析成空串，`[a, b]` → 得到带方括号的脏 tag）。
2. **正文内联 `#tag` 进索引**：Obsidian 标签的主力形态（正文里敲 `#tag`）当前**完全不提取**。
3. **标签可用**：能从索引枚举"某空间 / 全部空间"的标签与计数，并支持点击过滤到同标签文档。
4. **内链可点**：阅读视图里的 `[[wiki]]` / 相对 `.md` 链接点击**站内跳转**（当前 markdown `a` 一律 `target="_blank"` 跳出应用）。
5. **检索呈现可用**：返回**命中总数**（不是"返回条数"）、客户端排序、`mode=full` 开关。

## 硬约束（违反即为做错）

- **向后兼容**：不改任何既有输出的**既有字段**语义（只增字段）；不 bump 之外的解析行为变化必须由测试钉住。
- **索引版本必须 bump**：标签来源变了（新增内联 tag）而文件 size/mtime 未变 → 旧索引不会被 `indexStale()` 发现，必须靠 `INDEX_VERSION` 2 → 3 触发重建（这正是该机制存在的理由）。
- **不动非目标**：`[[` 自动补全、嵌入 `![[..]]` 语义、块 ID `^id`、别名解析、搜索语法层（`file:/tag:/path:`）、跨空间隐式关联——全部属批次 2/3。
- **不碰无关文件**：工作树含其他会话的未提交改动（`kernel/knowledge.mjs`、`KnowledgeDocView.tsx`、`knowledgeApi.ts`、`useKnowledge.ts`、`KnowledgePanel.tsx`、i18n 均为 M 态）——只改本计划列出的文件，**禁止 `git add -A`**。
- 前端**不 import** `shared/*.mjs`（仓库既有约定：前端 lib 手写同口径实现 + 注释标注来源，见 `src/lib/knowledgeMarket.ts:115-117`）。

## 任务

### T1 — `parseFrontmatter` 支持 YAML 子集（shared/knowledge-core.mjs）

新增导出 `parseYamlSubset(text)`，`parseFrontmatter` 改调它。支持：

| 写法 | 期望 |
|---|---|
| `tags: a, b` | `'a, b'`（**现状如此，不得改变**） |
| `tags: [a, b]` | `['a', 'b']`（flow 数组） |
| `tags:` + 缩进 `- a` 行 | `['a', 'b']`（block 列表） |
| `k: "x y"` / `k: 'x'` | `'x y'` / `'x'`（去引号） |
| `k: v # 注释` | `'v'`（行尾注释剔除，引号内 `#` 保留） |
| `k: >` / `k: \|` + 缩进行 | 折叠为单行（` ` 连接）/ 换行连接 |
| `k:`（空值、无子行） | `''`（现状如此） |
| 缩进子键（嵌套 map） | **丢弃**（现状如此，批次 1 不做） |

验证：`shared/knowledge-core.test.mjs` 新增用例（含"每个现存用例仍绿"）。

### T2 — `extractInlineTags(text)`（shared/knowledge-core.mjs）

新增导出。Obsidian 口径：`#` 前置为**行首或空白**；tag 体 `[\p{L}\p{N}_][\p{L}\p{N}_/-]*`；**至少一个非数字字符**（`#123` 不是 tag）；行内代码 `` `...` `` 内不提取（原地清空后匹配，保索引）；返回去重数组（保持原样大小写）。
验证：同文件新增用例（含 `` `#not-a-tag` ``、`[x](#anchor)`、`#123`、`#a/b` 层级）。

### T3 — 内核接入新标签源（kernel/knowledge.mjs）

- `collectTags(front, space, relPath, blocks)`：
  - `front.tags` **数组/字符串两态**兼容（数组直用，字符串仍 `split(/[,\s]+/)`），并 strip 前导 `#`、去空；
  - 新增 `if (b.kind !== 'code')` 对 `entry ? (entryFull || text) : text` 跑 `extractInlineTags`；
  - 保持既有三源（frontmatter / 文件名仅 experience+memory / entryTag）不变。
- `title` 取值前加标量归一（`front.title` 可能是数组 → 取首个），避免标题变成数组字符串。
- `shared/knowledge-core.mjs` 的 `INDEX_VERSION` 2 → 3。

验证：`kernel-tests/knowledge.test.mjs` 或 `knowledge-index-text.test.mjs` 新增用例——写一个含 `tags:` block 列表 + 正文 `#内联标签` 的 md，断言 `doc.tags` 含三者。

### T4 — `searchInner` 返回命中总数（kernel/knowledge.mjs）

`items.sort(...)` 前记 `const total = items.length`，返回体加 `total`（`count` 语义不变 = 实际返回条数）。
验证：断言 `total >= count`，且 topK=1 时 `total > count`（构造多命中语料）。

### T5 — 索引标签枚举 op（kernel + cli + server）

- `kernel/knowledge.mjs` 新增 `listIndexTags({ spaces } = {})`：遍历 `docs` 聚 `{tag, count, single}`，`spaces` 白名单过滤（同 search 语义），排序 `count` 降序 + tag 字典序；返回 `{tags, total, singleCount, spaces}`。
  - **不读 `tags.json`**（load 路径不回填该文件，会与 build 路径行为分裂）——直接遍历 `docs`。
  - **不改现有 `tags` op**（S6 的"写前查已有标签"消费 `listMemoryTags` 的输出形状，改它=破坏 S6）。
- `kernel/knowledge-cli.mjs`：op 清单 + `case 'index-tags'`（读 op，不进写白名单）。
- `server/knowledge-routes.mjs`：`GET /knowledge/index-tags?spaces=a,b`。

验证：`kernel-tests/knowledge-cli.test.mjs` 或新增用例断言过滤与计数。

### T6 — GUI 标签视图（标签面板）

- `src/lib/knowledgeApi.ts`：`listIndexTags(spaces?: string[])`。
- `src/hooks/useKnowledge.ts`：`useIndexTags(spaces)`（沿现有缓存层范式，不引第三方）。
- `src/components/knowledge/KnowledgeTagsView.tsx`：**层级树**（tag 含 `/` 时按段缩进，父节点聚合子计数）+ 计数 + 单例高亮 + 点击 → 过滤。
- `src/stores/knowledgeStore.ts`：`KnowledgeView` 加 `'tags'`（`KNOWLEDGE_VIEWS` 同步；`sanitizeView` 自动兼容旧落盘值）；新增**一次性意图** `searchKeywords: string[] | null` + `setSearchKeywords`（**不落盘**，同 `targetLine` 范式）。
- `KnowledgeViewTabs.tsx` 加 tab（图标 `Tags`）；`KnowledgePanel.tsx` 加分支；i18n 补 key（`knowledge.viewTags` / `tagsEmpty` / `tagsHint` 等，zh + en 同步）。

### T7 — 内链可点 + 标签可点

- `src/lib/knowledgeBlocks.ts`：新增 `splitWikiLinks(text)`（跳过行内代码，产出 `{type:'text'|'wiki', ...}`），与 `shared/knowledge-core.mjs` 的 `extractLinks` 同口径（注释标注来源与差异：不做别名解析）。
- `KnowledgeDocView.tsx`：
  - markdown `a`：href 为相对 `.md`（同空间）→ 站内 `setDocId` 而非 `target="_blank"`；
  - `[[目标|别名]]`：按行拿 `useLinks` 的解析结果（`to` → `target`）决定目标；解析不到则渲染为**不可点的灰文本**（不假装可点）。
- `KnowledgeInspector.tsx`：元信息里的标签变可点 → `setSearchKeywords([tag])` + `setView('search')`。

### T8 — 检索视图：总数 / 排序 / 全文开关

- `KnowledgeSearchView.tsx`：显示 `total`（"命中 N 条 · 显示 M 条"）、排序切换（相关度 / 文件名 / 行号，纯客户端对已返回集合排序 + 注释说明口径）、`mode=full` 开关（**默认关**：全文进上下文很贵，`knowledge.mjs` 注释已有预算教训）。

### T9 — 验证

- `npm test`（`node --test` 全量）——新增用例全绿、存量用例不改语义；
- `npm run typecheck`（`tsc --noEmit`）；
- CLI 实测三连：block 列表 / flow 数组 / `#内联标签` → `doc.tags` 齐全；
- 索引重建实测：旧索引遇到 `INDEX_VERSION` 3 必须**静默重建**（不得报错、不得返回空集）。

## 交付物

- 代码改动：`shared/knowledge-core.mjs`、`kernel/knowledge.mjs`、`kernel/knowledge-cli.mjs`、`server/knowledge-routes.mjs`、`src/lib/{knowledgeApi,knowledgeBlocks}.ts`、`src/hooks/useKnowledge.ts`、`src/stores/knowledgeStore.ts`、`src/components/knowledge/{KnowledgeTagsView(新),KnowledgeViewTabs,KnowledgePanel,KnowledgeDocView,KnowledgeSearchView,KnowledgeInspector}.tsx`、i18n；
- 测试：`shared/knowledge-core.test.mjs` + `kernel-tests/` 对应用例；
- 本文件作为实施留痕。

---

# 实施记录（2026-09-14 完成）

## 与原计划的差异（实施中发现的真实问题，均已修正）

1. **索引版本 bump 2 → 3**：计划已列，实施确认必要——标签来源变化不会改文件 size/mtime，
   `indexStale()` 的逐文件指纹发现不了，只能靠版本号。实测：把 manifest 改回 2 → 下次 `load()`
   静默全量重建、版本回写 3、标签不丢。
2. **`--spaces` 三层转发链路（发现并修掉一个真 bug）**：`parseArgs`（登记）→
   `cli.mjs` 的 `knowledgeArgs` **显式白名单**（转发）→ `parseSpacesArg`（归一）三处缺一即
   **静默失效**。实施时前两层都改了、漏了中间白名单，真进程实测 `--spaces nope` 仍返回全库
   标签才暴露。已补 `kernel-tests/knowledge-parity.test.mjs` 两个真进程用例钉住。
3. **检索新增「标签直连」路（计划外，必须加）**：实测发现标签写在 frontmatter 里、
   **不在任何块文本中**，倒排/关键词路只索引块文本 → `财务` 这类"只当标签、正文从不提"的词
   **全文检索恒为 0 命中**，于是"标签视图点标签去看同标签文档"会得到一片空白。
   → 在 `searchInner` 加 3.5 步：查询串/关键词与某标签**完全相同**（大小写不敏感、
   容忍前导 `#`）时，把该文档的锚点块（标题 > 条目 > 首块）作为候选并入，带 `tagHit` 标记。
   分值**不臆造**：走既有 struct 通道（标签命中权重 0.67）由 `fuseScore` 算出 ≈0.10，
   天生低于任何带正文证据的命中。最初给的定值 0.30 被实测打回（本系统真实正文命中在短文档上
   只有 0.22–0.27）。
4. **父标签点击带后代**：Obsidian 的 `tag:#税务` 也命中 `#税务/增值税`，故标签树父节点点击时
   把 `[父, ...后代]`（上限 8）一并作为关键词；检索视图用**第一个词当查询串**、
   整串当关键词（否则查询串变成一串标签的 gram，几乎必然 0 命中）。
5. **内链用 Context 而非 props**：`MarkdownText.tsx` 文件头记着"components 表每渲染新建对象会
   整棵重挂载"的事故，故表格保持模块级稳定、数据走 `WikiLinkProvider`。

## 交付物

**内核 / 共享层**
- `shared/knowledge-core.mjs`：`parseYamlSubset`（YAML 子集：block 列表 / flow 数组 / 引号 /
  行尾注释 / 多行折叠 / 空值 / 嵌套 map 丢弃）、`extractInlineTags`（Obsidian 标签口径：
  边界、层级、纯数字排除、行内代码与 md 链接目标遮蔽）、`INDEX_VERSION = 3`
- `kernel/knowledge.mjs`：`collectTags` 吃数组两态 + 正文内联标签；`title/name` 标量归一；
  `search` 返回 `total`；标签直连路 + `TAG_HIT_FLOOR`；`listIndexTags({spaces})`
- `kernel/knowledge-cli.mjs`：`index-tags` op + `parseSpacesArg`（三态归一，search 同步复用）
- `kernel/cli.mjs`：登记 `--spaces` 并**加入转发白名单**
- `server/knowledge-routes.mjs`：`GET /knowledge/index-tags?spaces=`

**前端**
- 新增：`src/lib/knowledgeTags.ts`（标签树纯逻辑）、`KnowledgeTagsView.tsx`（层级标签视图）、
  `KnowledgeWikiText.tsx`（内链 Context + Provider + WikiP/WikiLi/WikiA）
- 改动：`knowledgeStore`（`'tags'` 视图 + 一次性 `searchKeywords` 意图 + `sanitizeKeywords`）、
  `knowledgeApi`（`listIndexTags` + `total`/`tagHit` 字段）、`useKnowledge`（`useIndexTags` +
  四处失效补 `indexTags:`）、`knowledgeBlocks`（`splitWikiLinks`/`wikiTargetCandidates`）、
  `knowledgeSearch`（`sortHits`）、`KnowledgeViewTabs`/`KnowledgePanel`/`KnowledgeDocView`/
  `KnowledgeSearchView`、i18n 双语 16 键

**测试**（全部通过）
- `shared/knowledge-core.test.mjs`：YAML 子集 3 组 + 内联标签 1 组（含行内代码 / 链接目标 /
  纯数字 / 全角括号 / 收尾斜杠）
- `kernel-tests/knowledge.test.mjs`：标签来源端到端、数组标题、`total` 语义、`listIndexTags`
  （计数 / single / 排序 / 空间过滤）、CLI `--spaces`、标签直连检索（含排序口径与白名单）
- `kernel-tests/knowledge-parity.test.mjs`：`--spaces` 转发链路真进程、`total`/`tagHit` 往返
- `server/knowledge-routes.test.mjs`：新路由转发 + 与旧 `/knowledge/tags` 的路由隔离
- `src/lib/knowledgeTags.test.ts` / `knowledgeBlocks.test.ts` / `knowledgeStore.test.ts`：
  标签树、wiki 切分与候选、六视图集合

## 验证方式与结果

| 验证 | 方式 | 结果 |
|---|---|---|
| 存量不回归 | `npm test` 全量 | 2454 pass / 0 fail（另有 2 个计时类用例在并行跑时偶发，单独跑均通过，与本次改动无关） |
| 类型 | `npx tsc --noEmit` | 通过 |
| 前端可构建 | `npx vite build` | 通过（exit 0） |
| frontmatter 三态 | 真进程 `--knowledge doc` | block 列表 / flow 数组 / 内联标签全部进 `doc.tags`；`\`#不是标签\`` 不进 |
| 标签枚举与过滤 | 真进程 `--knowledge index-tags [--spaces x]` | 计数正确；`--spaces no-such` → 空集（证明确实过滤） |
| 索引重建 | manifest 改回 version=2 → `stats` | 静默重建、版本回写 3、标签不丢 |
| 标签直连检索 | 真进程 `search --query 财务` | 打标签的文档命中（`tagHit` + 0.1005），正文命中 0.247/0.222 排在前 |
| 父标签点击流 | `search --query 税务 --keywords 税务,税务/增值税` | 命中带子标签的文档（模拟标签视图父节点点击） |

## 已知边界（未做，属批次 2/3）

- `![[嵌入]]` 语义、`^块ID`、`#标题` 锚点导航、别名解析、未链接提及（Unlinked mentions）
- 搜索语法层（`file:/path:/tag:/line:/block:/section:/task:`、布尔/括号/短语/正则/属性查询）、
  分页、内核级排序（当前排序是客户端重排已返回集合，UI 已注明）
- 数据写入原子化（`POST /knowledge/doc` 仍是裸 `writeFileSync`）、fs watcher、覆盖前备份
- 标签重命名（Obsidian 的全库重命名）、标签拖拽、Bases/Canvas 类视图
