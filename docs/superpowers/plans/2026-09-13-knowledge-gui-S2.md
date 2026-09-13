# S2 知识库 GUI 实施计划（10 任务）

> 规格：`docs/superpowers/specs/2026-09-13-knowledge-gui-design.md`（**必读 §11 修订记录**）
> 依赖：S1 已交付的 `/knowledge/*` 10 个端点（`server/knowledge-routes.mjs`）
> 分支：`knowledge-s1`（worktree `.worktrees/knowledge-s1`，S1/S2/S3/S4 顺序叠加）
> 日期：2026-09-13

## 目标

把 S1 的后端知识库能力接成应用内的第 7 个 rail 面板：

1. **rail 接入**：`知识` 与现有 6 个类别入口平级（四同步点，见 §11.2）
2. **三栏工作台**：左 236px（空间 + 文件树）/ 中 `flex-1`（四视图）/ 右 212px（大纲/反链/元信息）
3. **四视图**：阅读 / 编辑 / 图谱 / 搜索
4. **经验面板简化**：`ExperiencePanel`（338 行）薄化为知识库设置子页

## 全局约束（违反即返工）

1. **不改 `kernel/`、`server/`、`shared/`** —— S2 是纯前端 + 已有 HTTP 契约。需要新端点时**先申报**，不得私自改后端
2. **不改 `CodeEditor` 接口**（§7 约定）：只读靠"不渲染编辑视图"实现
3. **禁裸 hex**：颜色只用 `themes.css` 的 CSS 变量；`src/components/knowledge/**` 内 grep 不得命中 `#rrggbb`
4. **光效只用白名单 5 项**（§11.5），禁止自创阴影/发光
5. **图标**：rail 用 `Library`；面板内可复用 `lucide-react`，但**禁 emoji**、禁同义异形复用（依 `docs/superpowers/audits/2026-09-08-gui-icon-uniqueness.md`）
6. **行数预算**：`KnowledgePanel.tsx` < 200 行；`src/components/knowledge/**` 单文件 ≤ 400 行
7. **前端测试纪律**：`node:test` + `node:assert/strict`，**无 DOM**。只有纯逻辑（store / API 封装 / 纯函数）写测试；**组件靠 typecheck + build + 人工走查**
8. **相对导入写 `.ts` 后缀**（Node 原生 TS 要求，见既有测试文件头注释）
9. 中文注释解释 **why**（仓库风格）

## 完成定义（S2 验收标准）

| # | 验收项 | 方式 |
|---|---|---|
| 1 | rail 出现「知识」，点击进入知识面板；**刷新/重启后仍停在知识 rail** | 人工（后者验 `RAIL_IDS` 已同步） |
| 2 | 三栏布局：左 236 + 中 flex-1 + 右 212，`min-w-0` 不撑破 | 人工 + 截图 |
| 3 | 四视图可切换（阅读/编辑/图谱/搜索） | 人工 |
| 4 | 阅读视图渲染 markdown；**`- [ ]` 行不得渲染为经验卡片** | 人工（S1 裁定） |
| 5 | 经验卡片显示 tag/summary/full，点击定位到 `line` 并高亮 | 人工 |
| 6 | 编辑视图：改动有脏标记、`Ctrl+S` 保存、保存后可立即搜到新内容 | 人工 |
| 7 | 只读知识包：视图 tab 禁用 + 提示，无法进入编辑 | 人工 + 后端 403 双保险 |
| 8 | 搜索视图：块级结果 + snippet；`Ctrl+F` 聚焦搜索框；**编辑视图内不抢 Ctrl+F** | 人工 |
| 9 | 图谱视图：节点/边来自 `/knowledge/graph`，可缩放拖动 | 人工 |
| 10 | 右栏：大纲（heading）/ 反链（links.in）/ 元信息 | 人工 |
| 11 | `ExperiencePanel` 简化，原功能不丢（或明确迁移说明） | 人工 + 测试 |
| 12 | 全量 `npm test` / `npm run typecheck` / `npm run build` 通过 | 命令 |
| 13 | 无裸 hex、无 emoji、无超行数文件 | 命令 + 人工 |

## 节奏与已知取舍

- **无法 TDD**（无 DOM 测试环境）：任务按「实现 → typecheck → build → 人工走查清单」推进，
  纯逻辑部分仍先写测试。
- **`release/YFWorking` 部署**：S2 是前端，产物在 `dist/`（`npm run build`）。
  调试版是否重打包由主控统一决定，**任务内不做部署动作**。

---

### Task 1: rail 接入 + 持久化 store

**交付物**
- 改 `src/stores/viewStore.ts`：`RailId` 加 `'knowledge'`；`RAIL_IDS` 同步加（**必须**，否则 `sanitizeRail` 清洗掉 → 刷新回退 `task`）
- 改 `src/components/layout/railMeta.ts`：加 `{ id: 'knowledge', icon: Library, labelKey: 'rail.knowledge' }`，并在注释补记图标选择理由
- 改 `src/components/layout/WorkShell.tsx:151-176`：三元链加 `rail === 'knowledge' ? <KnowledgePanel/>`
- 改 `src/i18n/translations/zh-CN.ts` / `en-US.ts`：加 `rail.knowledge`（zh「知识」/ en「Knowledge」）
- 新建 `src/stores/knowledgeStore.ts`：持久化 UI 态
  - `spaceId: string | null`、`tree: Record<string, {entries, loaded, expanded}>`、`expanded` 态、`view: 'read'|'edit'|'graph'|'search'`
  - `persist` + `partialize`（只落 `spaceId`/`view`/展开态）+ `merge` 白名单清洗（照 `viewStore.ts:41-73`）
  - 展开态用**扁平 map**（照 `FileBrowser.tsx:24` 范式）而非嵌套树，便于持久化与局部更新
- 新建 `src/stores/knowledgeStore.test.ts`：清洗逻辑（非法 spaceId/view → 兜底）、展开态增删

**实现要点**
- 图标**必须 `Library`**：`BookOpen` 已被 `SkillsPanel.tsx:382,412` 占用且语义冲突
- `KnowledgePanel` 本任务只建占位（Task 3 才做三栏），保证 rail 可点、可持久化即可
- i18n 漏加**不报错**（`t()` 回退 key 字面）→ 必须人工确认两种语言都显示正常

**验证**
- `node --test src/components/layout/railMeta.test.ts src/stores/viewStore.test.ts src/stores/knowledgeStore.test.ts`
- `npm run typecheck`
- 人工：点知识 rail → 刷新 → 仍在知识 rail；中英文标签正确

---

### Task 2: 数据层（HTTP 封装 + hook）

**交付物**
- 新建 `src/lib/knowledgeApi.ts`：10 个端点的薄封装
  - 照 `src/lib/workflowApi.ts` 范式：`getBridgeUrl()`（`src/lib/config.ts:14`）、`AbortController` 超时、**不 throw**、统一返回 `{ ok: true, data } | { ok: false, error }`
  - 端点：`listSpaces` / `listTree(space,path)` / `getDoc(id)` / `listEntries(id)` / `search(params)` / `getLinks(id)` / `getGraph(space,limit)` / `getStats()` / `reindex()` / `writeDoc({space,path,content})`
  - **参数纪律**：`search` 的 `q` 必传；`keywords?.length ? joined : undefined`（**不得传 `null`**，S1 §11.4）；`spaces` 逗号串原样传（后端已支持多空间）
- 新建 `src/lib/knowledgeApi.test.ts`：mock `fetch`，验 URL 组装（含 `q`/`keywords`/`spaces` 编码）、错误整形（非 2xx → `{ok:false}`，不抛）、超时
- 新建 `src/hooks/useKnowledge.ts`：手写缓存 + 失效（仓库无数据层库）
  - `useSpaces()` / `useTree(space,path)` / `useDoc(id)` / `useSearch(params)` / `useGraph(space)`
  - 缓存策略：`Map<key, data>` + `invalidate(prefix)`；写操作（`writeDoc`）后**失效 doc 与 tree 与搜索**
  - 加载/错误态：`{ data, loading, error, refresh }`

**实现要点**
- 后端响应形状（S1 实测）：
  - `/spaces` → `{ spaces: [{ id, name, root, writable, source, docCount }] }`
  - `/tree?space=&path=` → `Array<{ name, path, type: 'dir'|'file', docId? }>`（**单层**，需懒加载）
  - `/doc?id=` → `{ id, spaceId, title, tags, blocks: [{ n, kind, level, text, line, tag, full }] }`
  - `/entries?id=` → `[{ blockId, tag, summary, full, line }]`（非经验文档 → `[]`）
  - `/search` → `{ items: [{ docId, blockId?, snippet, score, line, kind, tag? }], count, indexAge, degraded }`
  - `/graph?space=&limit=` → `{ nodes: [{ id, label, spaceId, kind }], edges: [{ from, to, target }] }`
  - `/links?id=` → `{ out: [...], in: [...] }`
- 缓存要防竞态：同一 key 的并发请求**复用同一 promise**，避免重复 fetch 与乱序覆盖

**验证**
- `node --test src/lib/knowledgeApi.test.ts`
- `npm run typecheck`

---

### Task 3: 面板宿主 + 三栏骨架 + 视图切换

**交付物**
- 新建 `src/components/knowledge/KnowledgePanel.tsx`（**< 200 行**）：三栏骨架 + 视图状态
  - 左 `w-[236px] shrink-0 border-r`（Task 4） / 中 `flex-1 min-w-0`（四视图） / 右 `w-[212px] shrink-0 border-l`（Task 9）
  - 三栏写法照 `WorkflowCanvas.tsx:347-516` 的 flex 三件套（**无 resizable 组件**，spec 定固定宽）
- 新建 `src/components/knowledge/KnowledgeToolbar.tsx`：头部（复用 `src/components/rail/PanelToolbar.tsx` 模式：标题 + 微标 + 计数 + 主操作）
- 新建 `src/components/knowledge/KnowledgeViewTabs.tsx`：四视图切换（复用 `ui/tabs.tsx`）
- 新建 `src/components/knowledge/KnowledgeEmpty.tsx`：空态（既有内联惯例：`py-8 text-center text-tertiary text-xs`）

**实现要点**
- 四视图用**条件渲染**（与仓库既有面板一致，无 lazy/Suspense 先例）
- 本任务四视图可先渲染占位标题，Task 5-8 逐个填充
- 骨架屏组件（`KnowledgeSkeleton.tsx`）自写：切角块 + `animate-pulse`（**无 `--shimmer`**，§11.1）

**验证**
- `npm run typecheck && npm run build`
- 人工：三栏比例正确；窄窗口下中栏收缩而非撑破（`min-w-0` 生效）；四 tab 可切换

---

### Task 4: 左栏（空间 + 文件树 + 新建）

**交付物**
- 新建 `KnowledgeSidebar.tsx`：空间切换（下拉，复用 `ui/dropdown-menu.tsx`）+ 搜索入口
- 新建 `KnowledgeTree.tsx`：懒加载文件树
  - 扁平 map 缓存 + 首展开才 fetch（照 `FileBrowser.tsx:29-78` 范式）
  - 缩进 `paddingLeft: Math.min(8 + depth * 12, 120)`；展开态存 `knowledgeStore`（**持久化**，与 FileBrowser 不同）
  - 隐藏项与符号链接后端已跳过，前端不再过滤
- 新建 `KnowledgeNewMenu.tsx`：新建笔记（`newIcon` 走 `PanelToolbar` 的切角钮 `.cut-xs`）

**实现要点**
- 新建笔记流程：`POST /knowledge/doc`（`{ space, path, content: '# 标题\n' }`）→ 成功后刷新树 + 打开该 doc
- 只读空间（`writable === false`）：**禁用**新建入口并给出提示（后端 403 是兜底）
- 右键菜单（重命名/删除若做）照 `FileBrowser.tsx:180-225` 手写 fixed 定位 —— **本任务只做新建，重命名/删除留 S3**（避免范围膨胀）

**验证**
- `npm run typecheck`
- 人工：展开/折叠、切换空间、新建笔记后树与内容同步；只读空间无新建入口

---

### Task 5: 阅读视图（markdown + 经验卡片 + 行定位）

**交付物**
- 新建 `KnowledgeDocView.tsx`：标题 + tags + markdown 正文
  - markdown 复用 `src/components/chat/MarkdownText.tsx` 已导出的 `MD_PLUGINS` / `MD_COMPONENTS`
    （**注释要求 components 表模块级稳定引用**，勿内联新建对象）
- 新建 `KnowledgeEntryCard.tsx`：经验条目卡片（tag 徽标 + summary + 展开 full）
  - **渲染规则（S1 裁定，硬约束）**：**`tag !== null` 才渲染为经验卡片**；
    `tag === null` 的 `entry` 块（如 `- [ ] Step 1`）按普通段落渲染
- 行定位：接收目标 `line`，滚动到对应块并高亮（`.glow-hover` 或 `rail-ind` 之外的**白名单内**手段；
  建议用 `.topline` 或短暂 `bg-accent-subtle`）

**实现要点**
- 阅读视图的正文应基于 `/doc` 返回的 `blocks`（含 `kind/level/line/tag`）**分段渲染**，
  而非把整篇 md 丢给 react-markdown —— 否则无法做条目卡片与行定位
  - 策略：`blocks` 里 `kind === 'entry' && tag !== null` 渲染卡片；其余块按原文顺序用 markdown 渲染，
    并保留 `line` 锚点（`data-line`）供跳转
- `mode='snippet'|'full'`（`/search` 参数）与 `/entries` 的关系：阅读视图优先用 `/doc`；`/entries` 供经验空间快速列条

**验证**
- `npm run typecheck`
- 人工（**必须**）：
  1. 打开经验主题文件（如 `workflow.md`）→ 条目渲染为卡片
  2. 打开含 `- [ ] Step 1` 的任务清单类 md → **不得**出现卡片（S1 裁定验收）
  3. 从搜索结果点击 → 阅读视图滚动到目标行并高亮

---

### Task 6: 编辑视图（脏标记 + 保存 + 只读禁用）

**交付物**
- 新建 `KnowledgeEditorView.tsx`：宿主 `CodeEditor`
  - **`key={docId}`**（必须，否则切换文档内容不刷新）
  - `file: FileTab`（`src/types/index.ts:373-381`），`language: 'markdown'`
  - 宿主提供确定高度（`flex-1 min-h-0`，`CodeEditor` 根节点无高度）
  - 脏标记：`content !== originalContent` → 头部显示 `.micro` 未保存提示 + 保存钮激活
  - `Ctrl+S`（`CodeEditor` 已绑 `Mod-s → onSave`）→ `writeDoc` → 失效缓存 + 提示
- 只读空间：**不渲染编辑 tab**（tab 禁用 + tooltip「知识包为只读」）；直接访问时降级为阅读视图

**实现要点**
- **不改 `CodeEditor`**：无 `readOnly` 支持，故只读靠"不可进入编辑视图"实现（§11.3）
- 保存成功后**必须**失效 `doc`/`tree`/搜索缓存，使新内容立即可搜（后端已做增量索引）
- 提示用既有 `Badge`/`.micro`，**不新增 Toast 组件**（仓库无 Toast）

**验证**
- `npm run typecheck`
- 人工：编辑 → 脏标记出现 → `Ctrl+S` → 提示已保存 → 切到搜索能搜到新内容；只读空间无编辑 tab

---

### Task 7: 搜索视图（块级结果 + Ctrl+F）

**交付物**
- 新建 `KnowledgeSearchView.tsx`：搜索框（`ui/input.tsx`）+ 关键词输入 + 结果列表
  - 结果行：doc 标题 + `line` + snippet（高亮命中词）+ `score`（不展示数字，用色条/强弱表示）
  - `degraded` 为真时显示「索引降级」微标（`.micro`）
  - 点击结果 → 切阅读视图 + 定位高亮（Task 5 的定位能力）
- 改 `WorkShell.tsx` 的 keydown：加 `Ctrl/Cmd+F`
  - **仅当** `rail === 'knowledge'` 时拦截
  - **让位规则**：`view === 'edit'` 或 `document.activeElement` 在编辑器内时**不拦截**（让 `CodeMirror` 的 `searchKeymap` 处理）

**实现要点**
- 后端 `/search` 参数：`q`（必）、`keywords`（逗号串）、`topK`、`mode`、`spaces`（逗号串）
- 搜索输入做 **debounce**（建议 200ms）+ 请求竞态保护（同 key 复用 promise，Task 2 已提供）
- **不得**用 `Ctrl+K`/`Ctrl+Shift+F`（已被命令面板 / SearchDialog 占用）

**验证**
- `npm run typecheck`
- 人工：搜索命中、点击跳转高亮；在知识 rail 按 `Ctrl+F` 聚焦搜索框；**在编辑视图按 `Ctrl+F` 打开的是编辑器查找而非全局搜索**

---

### Task 8: 图谱视图

**交付物**
- 新建 `KnowledgeGraphView.tsx` + `knowledgeGraph/KnowledgeNode.tsx` + `KnowledgeEdge.tsx`
  - 照 `canvas/WorkflowCanvas.tsx` 三分文件范式；**必须** `import '@xyflow/react/dist/style.css'`
  - 数据：`/knowledge/graph?space=&limit=` → `nodes`/`edges`
  - 交互：缩放拖动（xyflow 内置）、点节点 → 打开该 doc
  - 空图/单节点时给空态（既有内联惯例）

**实现要点**
- 节点样式用 token（`--bg-elevated`/`--border-default`/`--text-primary`），**禁裸 hex**
- `limit` 默认值取后端默认，不要在前端硬编码过小值
- 不引入新依赖（`@xyflow/react` 已在 deps）

**验证**
- `npm run typecheck && npm run build`（xyflow 的 CSS 导入会被 Vite 处理，build 必须过）
- 人工：图谱渲染、拖动缩放、点节点打开文档

---

### Task 9: 右栏（大纲 / 反链 / 元信息）

**交付物**
- 新建 `KnowledgeInspector.tsx`：三段式（大纲 / 反链 / 元信息）
  - **大纲**：从 `/doc` 的 `blocks` 取 `kind === 'heading'`，按 `level` 缩进，点击滚动到该块
  - **反链**：`/links?id=` 的 `in`（谁引用了我）；点击打开来源 doc
  - **元信息**：`spaceId` / `title` / `tags` / 块数 / `indexAge`（来自 `/stats`）
- 无 doc 选中时显示空态

**实现要点**
- 反链为空是常态（多数文档无人引用）→ 空态文案要中性，不要显示成错误
- 三段用小节标题（`.micro`）+ 分隔线，与 `RightStatusRail` 视觉一致

**验证**
- `npm run typecheck`
- 人工：大纲点击定位；反链点击打开来源；元信息数值与 `/stats` 一致

---

### Task 10: 经验面板简化 + S2 验收

**交付物**
- 改 `src/components/settings/ExperiencePanel.tsx`（338 行）：简化为知识库设置子页
  - 保留：经验空间路径展示、索引状态与重建入口（`/stats` + `/reindex`）
  - 迁移/移除：原编辑/浏览类功能改由知识面板承接（**若移除，须在注释与设置页文案里说明去向**）
  - 目标 ≤ 200 行
- 新建 `scripts/verify-knowledge-gui.mjs`（可选但推荐）：
  - 检查 `src/components/knowledge/**` 无裸 hex、无 emoji、单文件 ≤ 400 行、`KnowledgePanel.tsx` < 200 行
  - 照 `scripts/verify-highrisk.mjs` 的 `check(cond, label)` 极简模式
- 更新 `docs/superpowers/specs/2026-09-13-knowledge-gui-design.md` §11：补记实施期发现的偏差

**验证（S2 全量验收）**
- `npm test`（全量，含 `src/**/*.test.ts`）
- `npm run typecheck && npm run build`
- `node scripts/verify-knowledge-gui.mjs`（若建）
- 人工走查：逐条核对本文档「完成定义」13 项

---

## 附：任务依赖与派发顺序

```
Task 1 (rail+store) ─┬─ Task 3 (宿主三栏) ─┬─ Task 4 (左栏)
                     │                     ├─ Task 5 (阅读)  ── Task 6 (编辑) ── Task 7 (搜索)
Task 2 (数据层) ─────┘                     ├─ Task 8 (图谱)
                                           └─ Task 9 (右栏)
Task 10 (验收) 依赖全部
```

**可合并派发**（同一文件/强耦合）：`1+2`、`3+4`、`5+6`、`7+8+9`、`10`。
