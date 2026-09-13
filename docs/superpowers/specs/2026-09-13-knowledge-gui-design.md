# Spec：知识 GUI（S2）—— 第 7 个 rail「知识」（2026-09-13）

## 0. 定位

依赖 S1 的 `/knowledge/*` 端点与 `searchKnowledge()`；**本子项目不改内核、不新增存储格式**。
原型：`scratch/knowledge-module-mockup.html`（信息架构 + 视觉语言示意）。

## 1. 现状锚点（源码核对）

| 项 | 现状 | 依据 |
|---|---|---|
| rail 宽 | 48px（`w-12`），图标 18px，激活态左侧 2.5px 品牌渐变条 | `src/components/layout/RailNav.tsx:31-56` |
| rail 常量表 | `RAIL: readonly RailMeta[]`，6 项；图标唯一性有审计表 | `src/components/layout/railMeta.ts:27-34` |
| rail 合法值 | `RAIL_IDS = ['chat','task','agents','skills','workflows','apps']` | `src/stores/viewStore.ts:18` |
| 设计语言 | Boost 橙 `#FF7429`、单对角切角 `.cut`（12/10/8/6）、4 主题、语义 token、禁裸 hex、lucide 唯一、禁 emoji | `2026-09-10-gui-design-unification-design.md` §1.2-1.3 |
| 面板先例 | `SkillsPanel.tsx` 693 行（单文件偏大，本设计**明确避免重蹈**） | — |
| 编辑器 | `src/components/editor/CodeEditor.tsx`（CodeMirror，含 markdown 模式 `@codemirror/lang-markdown`） | `package.json` |
| 图谱库 | `@xyflow/react` 已装 | `package.json` |
| 文档渲染 | `react-markdown` + `remark-gfm` 已装 | `package.json` |
| 经验面板 | 设置 → `ExperiencePanel.tsx`（338 行，列表/搜索/删除/导入导出/注入开关） | — |
| 文件抽屉 | 任务面板头部次级图标 → `FilesHistoryOverlay`（任意目录文件浏览器） | `viewStore.ts:20` |

## 2. 关键结论

1. **知识模块不是"另一个文件浏览器"**：文件抽屉面向任意磁盘目录（运维视角），知识模块面向
   **受管文档库**（内容视角，带索引/检索/反链）。两者并存，不合并 —— 合并会让两边都别扭。
2. **面板必须拆分**：`SkillsPanel.tsx` 已 693 行。知识模块功能更多，若写成单文件必超 1500 行。
   本设计按"一个视图一个文件"拆分，宿主 `KnowledgePanel.tsx` 控制在 200 行内。
3. **复用而非重造**：编辑器用 `CodeEditor`（markdown 模式）、渲染用 `react-markdown`、
   图谱用 `@xyflow/react`、抽屉/浮层用既有 `ui/` 组件。**零新增依赖**。
4. **rail 图标需过唯一性审计**：候选 lucide `BookOpen` / `Library` / `NotebookPen`；
   `SkillsPanel.tsx` 曾用过 `BookOpen`，需按 `docs/superpowers/audits/2026-09-08-gui-icon-uniqueness.md`
   的规则确认（类别入口图标唯一即可，域内同实体复用允许）。

## 3. 信息架构

```
rail「知识」
└─ 三栏 WorkShell 内宿主
   左栏 236px   空间列表 + 目录树 + 全局搜索框
   中栏 flex    文档头（文件名/路径/视图 tab）+ 内容区
   右栏 212px   大纲 / 反向链接 / 元信息 / 主题负载
```

**中栏四视图**（对应 S1 端点）：

| 视图 | 数据源 | 实现 |
|---|---|---|
| 阅读 | `GET /knowledge/doc?id=` | `react-markdown` 渲染；`entry` 块渲染为卡片（原型 §1 样式） |
| 编辑 | 同上 + `POST /knowledge/doc` | `CodeEditor` markdown 模式；只读空间禁用 |
| 图谱 | `GET /knowledge/graph` | `@xyflow/react`；节点=文档，边=链接/同标签 |
| 搜索 | `GET /knowledge/search` | 块级结果列表（分数 + 来源路径 + 命中类型 + 跳转） |

## 4. 组件划分

```
src/components/knowledge/
  KnowledgePanel.tsx      宿主：布局 + 视图切换（目标 <200 行）
  KnowledgeSidebar.tsx    空间列表 + 目录树 + 搜索框
  KnowledgeTree.tsx       递归目录树（懒加载，对齐 FileBrowser 的 tree 模式）
  KnowledgeDocView.tsx    阅读视图（markdown + entry 卡片）
  KnowledgeEditor.tsx     编辑视图（CodeEditor 封装 + 保存/脏标记）
  KnowledgeGraphView.tsx  图谱视图（@xyflow/react）
  KnowledgeSearchView.tsx 块级检索结果
  KnowledgeInspector.tsx  右栏（大纲 / 反链 / 元信息）
  useKnowledge.ts         数据获取 hook（fetch + 缓存 + 失效）
src/stores/knowledgeStore.ts  状态（persist）
```

**状态划分**：`knowledgeStore` 只管"用户在知识模块里的位置"（当前 space / doc / 视图 / 树展开态 /
搜索词），**不缓存文档内容**（内容由 `useKnowledge` 拉取，避免双份真源）。

```ts
interface KnowledgeState {
  spaceId: string | null
  docId: string | null
  view: 'read' | 'edit' | 'graph' | 'search'
  expanded: Record<string, boolean>
  query: string
}
```
persist key `yfworking-knowledge`；`merge` 时清洗非法 `view`/`spaceId`（对齐 `viewStore.sanitizeRail` 的纪律）。

## 5. 设计语言遵从（硬约束）

| 约束 | 落地 |
|---|---|
| 语义 token | 全部颜色走 `var(--brand-500)`/`--bg-elevated`/`--border-default` 等，**零裸 hex** |
| 签名形状 | 卡片/按钮用 `.cut`（12/10/8/6 刻度）；圆形元素（chip 除外）保持圆角 |
| 品牌渐变 | 主按钮/激活 tab/进度条用 `--grad-brand` |
| 微标 | 8-9px + `letter-spacing:.22em` + 大写（`--micro-track`） |
| 图标 | lucide only，禁 emoji；需过唯一性审计 |
| 光效 | 只用白名单 5 项（`--glow-soft`/`--glow-hot`/`--halo`）；大面积扁平 |
| 四主题 | 深/浅 × 实色/玻璃 全部回归（玻璃主题下 `backdrop-filter` 由 `globals.css` 提供） |

## 6. 交互细节

- **搜索**：聚焦快捷键见 §10 D5（默认 `Ctrl/Cmd+F`，无冲突）；
  `↑/↓` 选择，`Enter` 跳转，`Esc` 清空。
- **跳转与定位**：检索结果 → 切到阅读视图 → 滚动到 `line` 并高亮 1.5s。
- **右键菜单**：新建文档 / 重命名 / 删除 / 复制路径 / 在文件管理器中显示（后两项复用既有权能）。
- **只读空间**：树节点带锁标识，编辑 tab 禁用并提示"知识包为只读"。
- **空态**：无空间时给"创建第一个空间"引导卡（切角卡片 + 品牌渐变按钮）。
- **加载态**：骨架屏用 `--shimmer` 动效（原型已有 `.shimmer`），不阻塞输入。

## 7. 与现有模块的关系

| 模块 | 处置 |
|---|---|
| 文件抽屉 `FilesHistoryOverlay` | **不动**。两者职责不同（任意目录 vs 受管库） |
| 设置 → 经验面板 `ExperiencePanel.tsx` | 按 §10 D4 决策处置：默认方案为简化为"知识库设置"——保留注入开关/上限、导入导出、重建索引，**移除重复的条目列表 UI**（改由知识模块承载），并加"在知识模块中打开"入口 |
| 编辑器 `CodeEditor.tsx` | 复用（markdown 模式），不改其接口 |
| `SearchDialog`（全局搜索） | S2 不动；S3 再考虑是否把知识检索接入全局搜索 |

## 8. 验收标准

- [ ] rail 第 7 项「知识」可用，激活指示条与既有 6 项视觉一致
- [ ] 四视图切换正常；阅读视图能正确渲染 heading/列表/代码块/**经验条目卡片**
- [ ] 检索结果点击可跳转并高亮源行
- [ ] 只读空间无法编辑（UI 禁用 + 后端 403 双保险）
- [ ] 4 主题（深/浅 × 实色/玻璃）× 四视图无视觉回归；无裸 hex（grep 校验）
- [ ] `npm run typecheck` / `npm run build` / `npm test` 全绿
- [ ] `KnowledgePanel.tsx` < 200 行；单文件不超过 400 行（防止巨石面板）
- [ ] lucide 图标唯一性审计通过

## 9. 非目标（YAGNI）

协同编辑与冲突合并、块拖拽重排、导出 PDF/HTML、双链自动补全（`[[` 触发）、
标签管理面板、全文高亮跳转、移动端适配、知识包市场 UI（S4）。

## 10. 决策记录（2026-09-13 已确认）

| # | 决策 | 确认结果 |
|---|---|---|
| D1 | 布局 | **三栏**（空间树 + 文档 + 右栏大纲/反链/元信息），与原型 §1 一致 |
| D2 | 图谱视图是否进 S2 首版 | **进**：四视图全上（阅读 + 编辑 + 图谱 + 搜索） |
| D3 | 编辑能力 | **内置编辑**（`CodeEditor` markdown 模式；只读空间禁用） |
| D4 | 经验面板处置 | **简化为"知识库设置"**：保留注入开关/上限/导入导出/重建索引，移除重复条目列表，加"在知识模块中打开"入口 |
| D5 | 搜索快捷键 | **`Ctrl/Cmd+F`**（知识模块内，无冲突；不动 `SearchDialog` 的 `Ctrl/Cmd+K`） |
