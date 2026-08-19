# 会话集拖拽排序 + 会话列表排序 设计

日期：2026-08-15
状态：已批准（方案 A）

## 1. 背景与目标

会话集功能（2026-08-15 上线）的补充体验。现状：

- 会话集固定按名称排序（`Sidebar.tsx:105 filteredSets` 名称排序），不可拖拽调整。
- 会话列表仅支持全局手动拖拽顺序（`reorderConversations`），无排序模式。
- 会话可置顶；置顶区为独立手动顺序列表。

目标：

1. 会话集支持**拖拽排序**（手动顺序，随 `conversationSets` 数组持久化）。
2. 会话列表支持**排序模式**：最近更新 / 创建时间 / 标题 / 手动（拖拽自定义顺序），跨重启记住。
3. 非手动模式下拖拽会话 → 切回手动模式并应用新顺序（拖拽仍可用）。
4. 置顶区**不参与**排序模式，保持手动顺序。

## 2. 架构约束

- `yfw-kernel/` 零修改；`server/`、`electron/` 零修改（纯前端功能）。
- 前端无单测基建（现有测试仅覆盖 server）→ 验证门槛为 `npm run typecheck` 0 错误 + 手测清单。
- `uiStore` 已有 zustand persist（key `yfworking-ui`）→ 新增排序模式字段自动持久化，无需改 storage。
- `chatStore` 的 `partialize` 已原样持久化 `conversationSets` → 数组顺序即手动顺序，无需改 partialize。
- 导出顺序（`conversations` 数组序）、`autoOrganize` 语义不变。

## 3. 数据模型

**chatStore** 新增 action（仿现有 `reorderConversations`，chatStore.ts:301）：

```ts
reorderConversationSets: (fromIndex: number, toIndex: number) => void
```

实现：交换 `conversationSets` 中两个元素位置（与 reorderConversations 相同模式）。

**uiStore** 新增：

```ts
chatSortMode: 'manual' | 'updated' | 'created' | 'title'   // 默认 'manual'
setChatSortMode: (mode: ChatSortMode) => void
```

类型别名 `ChatSortMode` 建议定义在 uiStore 内导出。

## 4. 排序逻辑（Sidebar）

排序仅作用于 **unpinned** 列表；**pinned 区保持手动顺序不参与**（用户已确认）。

- `manual`：保持 store 顺序（当前行为）。
- `updated`：`(a.updatedAt || 0)` 降序。
- `created`：`(a.createdAt || 0)` 降序。
- `title`：`(a.title || '').localeCompare(b.title || '')` 升序（`|| ''` 防御导入包缺 title 的会话）。

流程（替换 `filtered`/`pinned`/`unpinned` 派生逻辑）：

1. `filtered` = 搜索过滤（现有逻辑不变）。
2. `pinned` = filtered 中 pinned（现有不变，不排序）。
3. `unpinned` = filtered 中非 pinned；按 `chatSortMode` 排序得到 `sortedUnpinned`。
4. 分组渲染使用 `sortedUnpinned`（各会话集组内有序、未分组区有序）。
5. `filteredSets` 改为 **store 顺序**（`conversationSets` 原样，去掉名称排序）——会话集仅手动顺序。

搜索与排序组合：先过滤后排序（顺序天然正确）。

**排序不改变 `conversations` 数组顺序**（仅展示层排序）；`manual` 模式下展示即 store 顺序。

## 5. UI（Sidebar）

**排序下拉**：搜索行「一键整理」按钮旁新增图标按钮（lucide `ArrowUpDown`），点击打开 DropdownMenu，4 个模式选项，当前模式打勾；选中调 `setChatSortMode`。i18n keys（`sidebar` 命名空间）：`sortBy`（aria-label）、`sortManual`、`sortUpdated`、`sortCreated`、`sortTitle`。

**会话集拖拽排序**：会话集头部行支持拖拽（复用会话拖拽模式：`draggable` + dragStart/dragOver/dragLeave/drop/dragEnd）。新增本地 state `dragSetId` / `dragSetOverId`；drop 时按 `conversationSets` 索引调 `reorderConversationSets(from, to)`。注意会话集头部已有 click（折叠）与 contextmenu（右键菜单）——与现有会话项相同的共存模式（已验证可行）。

**会话拖拽与排序模式交互**（用户确认"仍可拖拽"）：

- **切换时机改为 dragStart**：非手动模式下开始拖拽会话 → 立即 `setChatSortMode('manual')`。原因：排序模式下展示顺序 ≠ store 顺序，drop 的 from/to 索引基于 store 顺序（`getConvIndex`），若拖拽期间保持排序展示会产生错位。dragStart 切回 manual 后列表重渲染为 store 顺序，拖拽项仍在（`dragId` 不丢），随后 drop 走现有 `reorderConversations` 语义正确。此行为满足"拖拽后自动切换为手动模式并应用新顺序"。
- 手动模式拖拽行为不变。

## 6. 边界与错误处理

- 拖拽取消/越界：复用现有 `dragEnd` 清理（置空 dragId/dragOverId）。
- 非手动模式切换回 manual 时机：仅拖拽触发；点击排序下拉直接切模式不影响 conversations。
- `collapsed` 折叠状态不受排序/拖拽影响（按 setId 键控）。
- 空会话集（无成员）仍不渲染组头（现有 `members.length === 0` 跳过，不变）。
- 排序模式下右键菜单 / 移动子菜单 / 导出均不受影响（操作基于会话 id，与展示顺序无关）。

## 7. 文件清单

| 文件 | 改动 |
|---|---|
| `src/stores/chatStore.ts` | 新增 `reorderConversationSets` action + ChatState 签名 |
| `src/stores/uiStore.ts` | 新增 `chatSortMode` + `setChatSortMode`（persist 自动生效） |
| `src/components/layout/Sidebar.tsx` | 排序下拉；排序派生逻辑；会话集拖拽；dragStart 切 manual |
| `src/i18n/translations/zh-CN.ts` | `sidebar` 命名空间新增 sortBy/sortManual/sortUpdated/sortCreated/sortTitle |
| `src/i18n/translations/en-US.ts` | 同上英文 |

无 server / electron / 内核改动。

## 8. 测试与验证

- `npm run typecheck` 0 错误。
- 手测清单：
  1. 4 种排序模式展示正确（置顶区不随排序变化）。
  2. 会话拖拽：手动模式下拖拽生效；非手动模式下开始拖拽即切回手动并正确落位。
  3. 会话集拖拽排序生效，重启后顺序保持（localStorage `yfworking-chat` 的 conversationSets 顺序）。
  4. 排序模式跨重启记住（localStorage `yfworking-ui`）。
  5. 搜索 + 排序组合正确；搜索时各组自动展开不受影响。
  6. 右键移动/导出/会话集菜单在排序模式下正常。
