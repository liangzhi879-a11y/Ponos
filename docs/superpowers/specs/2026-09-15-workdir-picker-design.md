# 工作目录选择器：资源管理器形态改造（设计）

- 关联清单条目：`P1` 工作目录的选择，要接近 win 资源管理器形态（含快捷入口），用户上手难度低
- 日期：2026-09-15
- 状态：设计（待实现）

---

## 1. 现状（实测）

| 事实 | 位置 |
|---|---|
| 选择器只有 4 个按钮（Up / Home / This PC / Refresh）+ 一行**纯文本路径** | `src/components/chat/DirectoryPicker.tsx`（210 行） |
| 取数走 bridge HTTP：`/list-dir?path=`、`/drives` | 同上 + `server/bridge.mjs:1802/1810` |
| `/drives` 返回 A–Z 探测出的盘符 | `bridge.mjs:1802-1809` |
| `/list-dir` 返回 `{path,parent,entries,truncated}`，目录在前、过滤 `.`/`$` 前缀，2000 条上限 | `bridge.mjs:1810-1833` |
| **没有**"已知文件夹"（桌面/文档/下载…）端点 | 全仓 grep 无命中 |

**问题（用户视角）**：想进"我的文档"必须从 `C:\` 逐级点进 `Users\<name>\Documents`；路径只是**只读文本**，想跳转只能一级级爬；点错了**只能靠 Up 原路退回**，没有前进/后退。这就是"上手难度高"的来源。

## 2. 目标（对齐 Windows 资源管理器的心智模型）

用户对资源管理器的既有习惯，本改造照搬以下四条（这是"上手难度低"的实质）：

1. **导航窗格（左）**：快捷入口（桌面/文档/下载/图片/音乐/视频/主目录）+ 盘符，单点直达 —— 对应 Explorer 左侧树。
2. **面包屑地址栏**：路径每级可点；点空白处可**切换成可编辑输入框**，支持粘贴/输入路径直接跳转 —— 对应 Explorer 地址栏。
3. **前进 / 后退**：浏览器式历史栈（配合 Up），误入后不必逐级爬回。
4. **单双键位不变**：单击选中、双击进入并确认（沿用现有行为，不改变既有用户肌肉记忆）。

## 3. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 快捷入口由 **bridge 提供**（新增 `/known-folders`），不在渲染层拼 `C:\Users\...` | 主进程/bridge 才知道真实用户目录（`os.homedir()` + 平台差异）；渲染层拼路径必然在非 C 盘系统、非英文用户名、Mac/Linux 上错 |
| D2 | 快捷入口**必须是"存在性过滤后"的列表** | 服务器/精简系统常无"音乐/视频"目录；列出点了报错的项比不列更差 |
| D3 | 纯逻辑（面包屑切分、历史栈、快捷入口归一）落 `src/lib/dirPicker.ts`（`.ts`） | 仓库纪律：`.tsx` 不能被 `node --test` import；把逻辑写进组件=没有单测 |
| D4 | 历史栈**前进/后退**独立于 Up：Up 是"父目录"，后退是"来时路" | 二者语义不同（Explorer 亦然）：从 `D:\a\b` 经快捷入口跳到 `C:\x` 再 Up，后退应回 `D:\a\b` |
| D5 | 支持"直接输入路径"时，**输入非法路径不破坏当前状态**（报错并留在原目录） | 手输路径是出错率最高的入口，必须可恢复 |
| D6 | 面包屑过长时**中间折叠**（首级 + … + 末两级） | 深层路径会把末级挤出可视区，而末级才是用户最需要的 |
| D7 | 左侧导航窗格在窄容器下**可折叠** | 选择器出现在多种容器里（ChatWindow/RightStatusRail/TaskCwdBar/TaskStartCard），宽度不一 |
| D8 | 不新增 IPC，只加 HTTP 端点 | 选择器现走 bridge HTTP；混用两套取数会让"同一份目录数据两个来源"，徒增不一致 |

## 4. 接口

### 4.1 新增 `GET /known-folders`（bridge）

```json
{ "folders": [
  { "name": "主目录", "path": "C:/Users/xx",       "kind": "home" },
  { "name": "桌面",   "path": "C:/Users/xx/Desktop","kind": "desktop" },
  { "name": "文档",   "path": "C:/Users/xx/Documents","kind": "documents" },
  { "name": "下载",   "path": "C:/Users/xx/Downloads","kind": "downloads" },
  { "name": "图片",   "path": "C:/Users/xx/Pictures","kind": "pictures" },
  { "name": "音乐",   "path": "C:/Users/xx/Music",  "kind": "music" },
  { "name": "视频",   "path": "C:/Users/xx/Videos", "kind": "videos" }
] }
```

- 路径统一转 `/`（与该文件既有 `/list-dir`、`/read-file` 一致）。
- **只返回真实存在的目录**（D2）：`existsSync` 过滤。
- 任一目录不存在 ⇒ 该项不出现（**不是**报错）。
- 非 Windows 下 `kind`→相对路径的映射同样适用（`homedir()` 之下）。

### 4.2 前端逻辑层 `src/lib/dirPicker.ts`

```ts
/** 面包屑：从路径切出可点击的层级（含首级根） */
export function breadcrumbSegments(path: string): { label: string; path: string }[]
/** 折叠策略：层级过多时保留"首级 + … + 末两级"（D6） */
export function foldBreadcrumb(segs, maxItems?): { label: string; path: string }[]
/** 历史栈（D4）：push / back / forward 的纯函数表达 */
export function pushHistory(state, path): HistoryState
export function goBack(state): HistoryState
export function goForward(state): HistoryState
/** 快捷入口归一（不信任 bridge 形状，脏数据丢弃） */
export function normalizeFolders(raw: unknown): QuickFolder[]
/** 输入路径的清洗：去引号/空白、统一分隔符、"~" 展开由 bridge 侧处理 */
export function cleanPathInput(input: string): string
```

### 4.3 UI 结构（`DirectoryPicker.tsx`）

```
┌───────────┬────────────────────────────────────────────┐
│ 快捷入口   │  ← → ↑  [面包屑 / 可编辑地址栏]      ⟳     │
│ ·主目录    ├────────────────────────────────────────────┤
│ ·桌面      │  📁 目录…                                  │
│ ·文档      │  📄 文件…                                  │
│ ·下载      │                                            │
│ 盘符       │                                            │
│ ·C: ·D:    ├────────────────────────────────────────────┤
│            │  N 个文件夹 / M 个文件   [取消] [选择此文件夹] │
└───────────┴────────────────────────────────────────────┘
```

## 5. 非目标

1. 不做树形展开（Explorer 左树的完整递归）——快捷入口 + 盘符已覆盖绝大多数起手路径，树形会带来懒加载/展开态管理成本。
2. 不做文件预览/缩略图/多选/右键菜单。
3. 不做书签/最近访问的自定义持久化（可后续）。
4. 不修改选择器对外的 props 契约（`{value,onChange,onClose}`）——4 处调用方不动。

## 6. 验收标准

- A1 `/known-folders` 只回存在的目录；不存在的项不出现、且不报错。
- A2 面包屑层级路径正确：点击第 N 级即跳到该级（`C:/a/b/c` → 4 段）。
- A3 历史栈：进入 `a→b→c`，后退两次到 `a`，前进一次到 `b`；`back/forward` 边界不越界。
- A4 地址栏输入非法路径 ⇒ 显示错误且**当前目录不变**。
- A5 快捷入口点一次即到目标目录（不再逐级爬）。
- A6 折叠：深层路径（>4 级）渲染项数 ≤ maxItems，且**末级始终可见**。
- A7 既有 4 处调用方无需改动（props 不变）。
- A8 `npm run typecheck` + `npm test` 全绿，`npm run build` 通过。

## 7. 未决项

- 快捷键（Alt+↑ 回上级、Backspace 后退）是否需要？**倾向不做**：选择器内 Backspace 与地址栏输入冲突，且属加分项而非"上手难度"要件。
