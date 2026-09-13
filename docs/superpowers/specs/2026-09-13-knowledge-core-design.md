# Spec：知识内核（S1）—— 文件为真源的多空间知识库底座（2026-09-13）

## 0. 本文档定位

"知识库系统 + 经验系统集成"是**一个功能模块、四个可独立交付的子项目**：

| # | 子项目 | 交付物 | 验收方式 |
|---|---|---|---|
| **S1** | **知识内核**（本文） | 空间/文档模型 + 派生索引 + 检索引擎 + bridge 路由 + 经验适配器 | 单测 + 双端对拍 |
| S2 | 知识 GUI | 第 7 个 rail「知识」：空间树/文件树/编辑器/预览/搜索/图谱 | 人工验收 |
| S3 | AI 集成闭环 | 检索注入升级 + 知识工具 + 沉淀走统一写入 | 端到端测试 |
| S4 | 生态分发 | 中央清单 + manifest 兼容 + 安装/更新/卸载 + 导出发布 | 真实包安装 |

**本文只覆盖 S1**。S2–S4 的接口边界在 §11 约定，各自另开 spec。S1 不含任何新界面。

## 1. 背景与输入

参考 `obsidianmd/obsidian-releases` 获得两层启示：

- **内核形态**（→ S2）：本地 Markdown vault、文件即知识、双向链接、图谱视图、全文搜索；
- **生态分发**（→ S4）：中央清单仓库（`community-plugins.json` 仅存 name/author/description/repo 轻量索引）
  + 扩展自仓库 `manifest.json`（id/version/minAppVersion）负责版本与兼容
  + 安装时按 release tag 拉文件落到本地目录。

**用户五项定案（逐条约束下文设计）：**

1. 参考重点：**内核形态与生态分发两者都要**；
2. 内容定位：**多库空间**（经验库、业务库、笔记库并存）；
3. 集成深度：**统一为同一后端**；
4. 存储选型：**方案 A —— 文件为真源 + 派生索引**；
5. 经验文件：**先原地挂载，S1 完成后立即安排迁移**。

## 2. 现状实证（2026-09-13 源码核对）

| 层 | 现状 | 缺口 |
|---|---|---|
| 经验数据 `~/.yfw/memory/personal/*.md` | 7 主题 md，条目 `- [会话\|标签] 摘要 -- 全文`；`server/experience.mjs:9-10` | 只有"主题文件"粒度，无单条定位 |
| 会话记忆 `~/.yfw/memory/session/*.md` | 每会话一 md（`kernel/cli.mjs:588` 轮末写入） | 未纳入任何检索 |
| 技能经验 `~/.yfw/memory/skill_experiences` | `server/packager.mjs:9` 已定义目录 | 未接入检索/展示 |
| 派生图谱 `kernel/graph.mjs` | `graph.jsonl`（:93）+ n-gram/IDF/余弦/关键词；**已预留 `IGraphBackend` 外部后端替换点**（:2-10） | 只索引经验条目；无文档/块/链接概念 |
| 注入 | `buildExperienceIndex`（索引式）/ `buildRelevantMemory`（关键词全文）/ `graphStore.search`（top-K） | 三套并存的检索路径，评分不一致 |
| MemorySearch 工具 `kernel/memory-search.mjs` | `searchLocalMemory()` 支持 scope personal/project/all | **每次调用全量读文件 + 全量现算向量**，无索引，O(N) |
| GUI | 设置 → 经验面板（列表/搜索/删除/导入导出/注入开关 `src/components/settings/ExperiencePanel.tsx`） | 只读列表，无编辑/无空间/无图谱 |
| 工作区 | rail 六模块 `chat/task/agents/skills/workflows/apps`（`src/stores/viewStore.ts:18`） | 无知识模块 |
| 技能安装 `server/skill-install.mjs` | hash 台账 + 用户改动保护（`upsertSkill` :135） | 仅技能，无"知识包"概念 |
| 内核打包 `scripts/build-kernel.mjs` | `bun build --target=node --external=node:*` 单文件 ESM | **外部依赖只能是 node:\*** |
| 内核缓存 `server/bridge.mjs:583-648` | `syncDirToMirror` + `mirrorKernelParentDeps` 镜像到 `<home>/runtime/` | 已通用支持一级 `../` 逃逸依赖（先例 `../version.mjs`） |
| 打包清单 `electron-builder.yml:24-36` | files 含 dist/electron/server/public/bin，extraResources 含 kernel-dist→kernel | 无 `shared/` |
| 路由先例 `server/logs-routes.mjs:1-30` | `handleLogsRoute({url,req,reply,readJsonBody})` 契约：命中返回 `{status,body}`，未命中返回 `null` | — |

## 3. 关键结论（决定本设计）

1. **LevelDB 在 kernel 侧不可用**：`classic-level` 是原生模块，而内核以 `bun build --target=node
   --external=node:*` 打成单文件且运行于 `<home>/runtime/ponos-kernel/`（无 `node_modules`）。
   → 索引改用**纯 JSONL 派生文件**（与已验证的 `graph.jsonl` 同构）。原"方案 A"中的 LevelDB 部分据此修正。
2. **"统一为同一后端" = 能力统一，不是物理搬迁**：经验文件留在原地，注册为内置空间；检索/写入/注入
   收敛到同一组 API。迁移作为 S1 之后的独立任务（§12）。
3. **块级粒度是价值核心**：经验条目、md 标题段、代码块都应成为可检索的 `Block`；现有检索的最小粒度
   是"主题文件"，这正是精度损失的主因。
4. **`server/` 不得 import `kernel/`**（打包产物无 kernel 目录，`server/approval-mode.mjs:4-5` 明载此约束）；
   反之 `kernel/` 也不 import `server/`。共享只能靠 repo 根 `shared/`，经一级 `../` 逃逸——该通道
   已被 `mirrorKernelParentDeps`（`server/bridge.mjs:619`）与 bun 内联同时支持。
5. **索引全派生、可随时重建** → 无数据丢失风险，也没有迁移包袱；索引损坏一律降级为"无索引"而非报错。
6. **重复实现必须被契约锁住**：本项目已有"同一算法双份实现"的既有事实（`server/experience.mjs` 与
   `kernel/memory.mjs` 同格式同去重，靠注释维系）。S1 起算法收敛到 `shared/`，并以**双端对拍测试**兜底。

## 4. 设计原则

1. **文件即真源，索引可弃**：删掉 `.index/` 必须毫发无损。
2. **纯函数进 shared，IO 留各端**：切分/向量/打分/序列化是纯函数（可测、可共享）；文件读写与
   路径安全属于各端（kernel 直读、server 走路由）。
3. **契约纯增量**：新增字段不破坏既有 GUI；老内核无新端点时前端按"无知识库"降级。
4. **静默降级**：索引缺失/损坏/构建失败，一律不影响会话主流程（对齐 `kernel/health.mjs` 的 try/catch 纪律）。
5. **定位到块、可回溯到行**：每个 Block 记录 `line`，检索结果能直接跳转到源文件位置。
6. **只读包不可写**：`packs/` 挂载的空间 `writable:false`，写入一律拒绝（S4 卸载即删目录）。
7. **路径穿越三重防护**：沿用 `logs-routes.mjs:19-27` 的范式（名白名单 + 基名约束 + `resolve` 后断言在根内）。

## 5. 方案

### §5.1 目录布局

```
~/.yfw/knowledge/
  spaces/<spaceId>/              # 用户空间（可写）
    .space.json                  # { id, name, description, icon?, createdAt }
    **/*.md                      # 知识文档
  packs/<packId>/                # 安装的知识包（只读挂载，S4 落地）
    pack.json                    # { id, name, version, description, spaces:[...] }
    **/*.md
  .index/                        # 全部派生，可删可重建
    manifest.json                # { version, builtAt, docs, spaces:{id:{docs,mtime}}, files:{...} }
    docs.jsonl                   # 每行一个 Doc（含 blocks）
    inverted.jsonl               # 每行 { gram, df, postings: [[docIdx, w]] }
    links.jsonl                  # 每行 { from, to, anchor }（含反链推导）
    tags.json                    # { tag: [docIdx] }
```

**内置空间路径映射**（`root` 外挂既有目录，物理不动）：

| spaceId | root | writable | source | 本期 |
|---|---|---|---|---|
| `experience` | `~/.yfw/memory/personal` | ✔ | `experience` | ✔ |
| `session-memory` | `~/.yfw/memory/session` | ✔ | `memory` | ✔（只读检索） |
| `skill-experience` | `~/.yfw/memory/skill_experiences` | ✔ | `skill_exp` | 预留，未启用 |
| `project-<name>` | 会话工作目录 `docs/knowledge/`（存在才挂） | ✔ | `project` | 预留 |
| `pack-<packId>` | `knowledge/packs/<packId>` | ✘ | `pack` | S4 落地 |

空间发现顺序：用户空间目录扫描 → 内置映射（目录存在才挂）→ `packs/` 扫描。目录缺失即静默跳过。

### §5.2 统一文档模型

```js
Space { id, name, description, root, writable, source, docCount, active, packVersion? }
Doc   { id,          // "spaceId/relPath"（POSIX 分隔符，跨平台稳定）
        spaceId, title, tags: [], links: [{ to, anchor }], frontmatter: {},
        hash,        // 内容指纹（复用 hashLine）
        mtime, size, lineCount,
        blocks: [Block] }
Block { id,          // "<docId>#<n>"
        kind,        // heading | para | list | code | table | entry
        level,       // kind==='heading' 时 1-6
        text, line,  // 原文 + 起始行（用于跳转）
        vec? }       // 仅构建期存在，落盘时剥离（落盘只存 postings）
```

**经验条目的映射**（统一后端的关键）：`- [会话|标签] 摘要 -- 全文` 整行 → **一个 `kind:'entry'` 块**，
其 `text = 摘要`，`full` 保留在同一 Block 的扩展字段 `entryFull`，`line` 指向该行。

块切分规则（确定性、无模型）：

1. 跳过 frontmatter（`---` 包裹，复用 `kernel/memory.mjs:17` 的解析）；
2. `^#{1,6} ` → `heading` 块，级别入 `level`；
3. 围栏代码块 → 单个 `code` 块（整体不切，避免代码被 bigram 噪声污染）；
4. Markdown 表格（连续 `|` 行）→ 单个 `table` 块；
5. 连续 `- `/`* `/`1. ` 行 → 单个 `list` 块；
6. 其余按空行分段的连续文本行 → `para` 块；
7. 经验文件的 `- [..] .. -- ..` 行优先判为 `entry`（覆盖规则 5）。

`title` 取值顺序：frontmatter `title` → 首个 heading → 文件名。

### §5.3 索引格式与构建

**构建（全量）**：扫描空间 → 逐文档切块 → 两遍法（先收集语料算 IDF，再向量化）→ 原子写
（`.tmp` + rename，对齐 `kernel/graph.mjs:130-136`）。

**增量更新**：以 `manifest.json` 的 `files[relPath] = {size, mtime, hash}` 为基线：
新增/变更文件重切，删除文件从索引剔除，未变文件复用既有 postings。触发时机：
① 内核启动 `load()` 时比对 mtime（复用 `graph.mjs:155-166` 的 mtime 校验思路）；
② 显式 `--knowledge-reindex [--force]`；
③ server 侧写文件成功后增量更新该文档（S1 先做"标脏"，下次检索前惰性重建）。

**规模护栏**：单文件 > 1MB 只索引 title + heading + 前 200 块；全库 > 20 万块时
`inverted.jsonl` 只保留 `df ≤ 50% 文档数` 的 gram（去停用词方向的近似）。

`inverted.jsonl` 的 `postings` 用 **docIdx（数组下标）** 而非 docId 字符串，压缩体积；
`docs.jsonl` 行序即 docIdx 定义，二者必须同批写入（同一次原子替换）。

### §5.4 检索引擎（4 路融合）

候选池 = 倒排命中 ∪ 图扩展（命中文档的出链/反链文档的 title/heading 块）。

```
score = 0.60 × cos(块向量)      // gramTokens/vectorizeText/cosine，复用 kernel/graph.mjs
      + 0.25 × min(kwScore/8, 1) // keywordScore，复用 kernel/memory.mjs:110
      + 0.15 × structBoost       // title×1.0 / tag×0.67 / heading×0.5 / para×0（再归一）
      含图扩展命中 → ×0.9 折扣
```

`query` 与 `keywords` 双输入（沿用 `graphStore.search` 签名）：`query` 走向量，`keywords` 走关键词精确，
标签命中额外 `tagBoost=3`（`graph.mjs:120` 已有此参数）。

**输出契约**：

```js
searchKnowledge({ query, keywords, spaces, topK = 5, maxBytes = 2048, mode = 'snippet' | 'full' })
→ { items: [{ docId, blockId, spaceId, title, heading?, snippet, score, line, kind }],
    count, indexAge }
```

`mode='snippet'` 供 GUI / 工具默认使用；`mode='full'` 供注入使用（拼 `【相关知识抽调】` 串，
风格对齐 `kernel/memory.mjs:191` 的 `【相关经验抽调】`），沿用 `maxBytes` 截断与去重。

### §5.5 模块划分与共享层

| 文件 | 职责 | 端 |
|---|---|---|
| `shared/knowledge-core.mjs` | **纯函数**：frontmatter 解析、块切分、gram 分词、向量化、打分融合、索引序列化/反序列化、snippet 生成 | 共享 |
| `shared/knowledge-core.test.mjs` | 上述纯函数的单测（fixture 驱动，无需文件系统） | 共享 |
| `kernel/knowledge.mjs` | 空间发现、文档读写、索引构建/加载、`searchKnowledge()`、经验适配器 | kernel（权威） |
| `kernel/knowledge.test.mjs` | 以 `YFWORKING_HOME` 指向临时目录隔离测试 | kernel |
| `kernel/knowledge-search.mjs` | `KnowledgeSearch` 工具的检索实现 | kernel |
| `kernel/cli.mjs` | 新增 `--knowledge-search` / `--knowledge-reindex` / `--knowledge-stats` | kernel |
| `server/knowledge-routes.mjs` | `/knowledge/*` 路由，`handleKnowledgeRoute()` 契约 | server |
| `server/knowledge-routes.test.mjs` | 直调 handler（**不启动 bridge**） | server |
| `server/bridge.mjs` | 接一行路由（对齐 `bridge.mjs:1652` 的 workflows 接法） | server |

**配套改动仅 2 处**：
- `electron-builder.yml` 的 `files:` 增加 `'shared/**/*'`（server 侧需 `../shared/`）；
- `package.json` 的 `test` 脚本 glob 增加 `shared/**/*.test.mjs`。

**无需改动**：`scripts/build-kernel.mjs`（bun 自动内联 `../shared`，bundle 仍自足）；
`mirrorKernelParentDeps`（一级 `../` 已支持）。

**依赖方向**：`shared ← kernel`、`shared ← server`，`kernel ⊥ server`（双向禁止）。

### §5.6 经验适配器（S1 必做）

`kernel/knowledge.mjs` 暴露：

```js
experienceAdapter = {
  root: PERSONAL_DIR,           // ~/.yfw/memory/personal
  toDoc(themeFile, raw),        // 每个经验条目 → kind:'entry' 块，tag 入 Doc.tags
  toEntryLine(block),           // 反向：块 → `- [会话|标签] 摘要 -- 全文`（写入用）
}
```

约束：
- **只读为主**：S1 不改变经验的写入路径（`appendMemoryEntry` 仍是唯一写入者），适配器只做解析与检索；
- **检索粒度到条目**：一次查询返回"某主题文件的第 N 条经验"，而非整篇；
- **与 `graph.jsonl` 共存**：`graph.jsonl` 继续服务 `MemorySearch` 的 local 后端；
  `KnowledgeSearch` 是新工具，二者并存不互斥（S3 再统一）。

### §5.7 bridge 路由契约

`handleKnowledgeRoute({ method, pathname, searchParams, readJsonBody, home })`，未命中返回 `null`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/knowledge/spaces` | 空间列表 + 文档数 + 索引年龄 |
| GET | `/knowledge/tree?space=&path=` | 目录树（懒加载，对齐 `/list-dir` 形状） |
| GET | `/knowledge/doc?id=` | 文档 + blocks（供预览/编辑器） |
| POST | `/knowledge/doc` | 写入文档（仅 `writable` 空间；成功即标脏） |
| GET | `/knowledge/search?q=&spaces=&topK=` | 检索（snippet 模式） |
| GET | `/knowledge/links?id=` | 出链 + 反链 |
| GET | `/knowledge/graph?space=&limit=` | 图谱数据（nodes/edges，S2 用） |
| GET | `/knowledge/stats` | 诊断：块数/索引体积/构建耗时 |
| POST | `/knowledge/reindex` | 手动全量重建 |

**只读实现优先**：S1 的 server 侧优先走 `kernel-readonly` 薄转发范式（`server/kernel-readonly.mjs`，
对齐 `/api/usage`、`/api/audit` 的 `bridge.mjs:1910` 接法），避免在 server 侧复制索引逻辑；
仅"写文档"这类需要落盘的动作走 server 直写 + 标脏。

### §5.8 错误处理与降级

| 情形 | 行为 |
|---|---|
| `.index/` 缺失 | 首次检索前惰性构建；构建失败 → 返回空结果 + `indexAge: null` |
| `inverted.jsonl` 半截行 | 跳过该行（对齐 `graph.mjs:145` 的容错） |
| 空间 root 不存在 | 静默跳过，`/knowledge/spaces` 不列出 |
| 文档写入越界 / 只读空间 | 403 语义（`{status:403, body:{error}}`），不落盘 |
| 索引文件被占用/不可写 | 内存索引仍可用，仅记录 warning（对齐 `graph.mjs:172`） |
| 单文档解析异常 | 该文档标记 `parseError`，其余文档正常 |

## 6. 数据流

**① 建索引（启动/手动）**：`scanSpaces()` → 逐文档 `parseDoc()`（shared 纯函数）→ 收集语料算 IDF
→ `vectorize()` → 原子写 `.index/`。

**② 检索**：`query` → 倒排候选 → 图扩展 → `scoreFusion()`（shared）→ topK → snippet 或注入串。

**③ 写入（写文档）**：server 校验空间可写 → 落盘 → 标脏 → 下次检索前增量重建该文档。

## 7. 测试策略

| 层 | 文件 | 要点 |
|---|---|---|
| 纯函数 | `shared/knowledge-core.test.mjs` | 块切分边界（围栏代码/表格/列表/经验条目）、frontmatter、snippet 截断、评分单调性 |
| kernel | `kernel/knowledge.test.mjs` | 临时 `YFWORKING_HOME` 隔离；空间发现、增量重建、经验适配器 |
| server | `server/knowledge-routes.test.mjs` | 直调 handler（**严禁起 bridge**——本仓库有"测试起桥误杀运行中应用"的前车之鉴） |
| **对拍** | `kernel-tests/knowledge-parity.test.mjs` | 同一 fixture 目录，kernel 与 server 两侧检索 top-5 的 `docId+blockId` 序列**必须一致** |

对拍测试是把"双端实现"从负债变成资产的手段：任何一侧打分漂移立即红灯。

## 8. 验收标准

- [ ] 给定一批含 frontmatter/标题/代码/表格/列表的 md，块切分正确且 `line` 可回溯原文
- [ ] `experience` 空间可被检索，且**结果为单条经验**（非整篇）
- [ ] 检索对"中文查询"有效（bigram 命中），对英文/数字查询有效（词命中）
- [ ] 删除 `.index/` 后下一次检索自动重建，结果与删除前一致
- [ ] 文档修改后无需手动干预即可被检索到（mtime 或标脏触发）
- [ ] `/knowledge/*` 全部端点在 `writable:false` 空间上写入返回 403
- [ ] 路径穿越尝试（`../../etc/passwd`、绝对路径、符号链接）全部被拒
- [ ] kernel ↔ server 对拍测试绿
- [ ] `npm test` 全绿；`node scripts/build-kernel.mjs` 成功且 bundle 无新增外部依赖
- [ ] 打包产物含 `app/shared/`，`resources/kernel/cli.mjs` 可独立运行

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 索引体积膨胀（中文 bigram 基数大） | docIdx 压缩 + 长文档护栏 + 高频 gram 剪枝；`.index/` 缺失即降级 |
| 全量重建在大库上变慢 | 增量优先；重建在 `--knowledge-reindex` 显式触发，不在启动路径强制 |
| 双端漂移 | 算法集中在 `shared/`；对拍测试守门 |
| `shared/` 被误当作第三方目录 | 在 `docs/architecture.md` 补一行依赖方向说明；`shared/` 只放纯函数、禁止 import node:fs |
| 与既有三套注入路径冲突 | S1 只新增，不替换；S3 做收敛，保持契约纯增量 |

## 10. 非目标（YAGNI）

双向链接自动补全 UI、块引用/嵌入、embedding 语义检索、多人协作与冲突合并、云同步、
加密与权限分级、索引垃圾回收与压缩后台任务、外链抓取、`packs/` 的实际安装实现（S4）、
图谱交互与可视化（S2）、经验文件物理搬迁（§12 独立任务）。

## 11. 后续子项目边界（骨架约定）

| 子项目 | 依赖 S1 的接口 | 明确不做 |
|---|---|---|
| **S2 GUI** | `/knowledge/spaces`、`/tree`、`/doc`、`/search`、`/links`、`/graph`；`viewStore.ts:18` 的 `RAIL_IDS` 新增 `'knowledge'` | 不改内核评分、不新增存储格式 |
| **S3 AI 集成** | `searchKnowledge()`、`experienceAdapter`；`KnowledgeSearch` 工具（新）+ 注入收敛（退役 `buildRelevantMemory` 的关键词路径） | 不改索引格式、不动 GUI 结构 |
| **S4 生态分发** | `packs/` 布局 + `pack.json` schema；借鉴 `skill-install.mjs:135` 的"装/更新/跳过/保留用户改动"四态 | 不碰 `spaces/` 用户数据 |

**S4 与 obsidian-releases 的对应关系**：中央清单 ↔ `community-plugins.json`（轻量索引，仅
name/description/repo）；`pack.json` ↔ `manifest.json`（版本 + `minAppVersion`）；
`versions.json` 兼容回退机制在 S4 spec 中细化。

## 12. 迁移路径（S1 之后的独立任务）

1. `knowledge/spaces/experience/` 建立，`migrate-experience` 一次性脚本：按主题文件搬运 md；
2. 兼容期（双读）：`experience` 空间 root 优先指向新目录，回退旧目录；
3. 迁移完成后切换 `server/experience.mjs:9` 的 `PERSONAL_DIR` 与 `kernel/memory.mjs:6` 的 `memoryRoot()`；
4. 旧目录保留 `.bak` 一个版本后清理。

迁移不在 S1 范围；S1 只保证"root 是个可配置字段"，让迁移成为纯配置变更。
