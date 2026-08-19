# 会话集整理 + 会话级导出分享（chat 体积重构）设计

日期：2026-08-15
状态：已批准（方案 A）

## 1. 背景与目标

YFWorking 的会话历史全部持久化在 localStorage `yfworking-chat`（单个 JSON 文档，每条会话只保留最近 100 条消息）。三个问题：

1. **体积**：导出 chats 类型把整个 JSON 打包成一个 `chat-store.json`；导入时整体写回 localStorage。会话多时包体积大，且 Chromium localStorage 配额（约 10MB，实际可用约 5-8MB）下整体写入可能抛 `QuotaExceededError`，跨设备迁移失败。
2. **无组织**：会话列表（Sidebar → Chats）只有 pinned/unpinned 两组，没有项目/分组概念；会话模型有 `cwd` 字段但 UI 未按项目组织。
3. **无法分享单会话**：导出只能全量 chats，不能只导出某个会话或一组会话。

目标（用户已确认）：
- chat 数据导出按会话拆分文件、导入受控合并写回，避免超配额。
- 会话集 = 独立命名容器（不与目录绑定，改名/移动无目录副作用）；一键自动整理按 `cwd` 归类生成会话集，之后可手动调整。
- 会话 / 会话集右键菜单提供"导出分享"，复用 zip 打包机制（只含所选会话/会话集，可附带 personal 经验等）。

**技术事实（设计前提）**：agent 恢复会话不受 chat 数据体积影响——GUI 发送消息携带 `resumeId`（CLI 自身会话 id），内核经 CLI 会话历史恢复，从不读取 localStorage。本设计不改此机制。

## 2. 架构与约束

- 改动范围：GUI 前端（chatStore / Sidebar / 设置经验面板）+ `server/packager.mjs`（导出/导入 chat 结构）+ `server/bridge.mjs` 零改动 + Electron IPC 透传。
- 约束：`yfw-kernel/` 零修改；`yfworking-chat` persist key 不变；消息 100 条上限截断语义不变；导入必须兼容旧格式包（单 `chat-store.json`）。
- localStorage 技术约束（如实说明）：`setItem` 单次写入是整串，不存在真正"分批写"。降低超配额风险的手段是：合并时逐会话应用 100 条截断 + 写前估算序列化体积 + 超配时按最旧会话裁剪并计入报告 + 失败不损坏本地数据。写前估算上限固定为 4MB（保守预留，低于 Chromium 实际可用额度）。

## 3. 数据模型（chatStore）

```ts
// Conversation 增加字段
setId?: string   // 所属会话集 id；缺省 = 未分组

// chatStore 新增
conversationSets: {
  id: string
  name: string
  cwd?: string     // 自动整理来源目录（仅记录，不绑定——改名/移动无目录副作用）
  createdAt: number
}[]
```

- persist：`yfworking-chat` 的 partialize 增加 `conversationSets` 与会话 `setId`。
- 会话集删除：仅解除会话归属（`setId` 置 undefined），不删除会话。
- 新建会话集：`createConversationSet(name, cwd?)`；移动会话：`setConversationSet(conversationId, setId | null)`；改名：`renameConversationSet(id, name)`；删除：`deleteConversationSet(id)`（解除归属）。

## 4. 自动整理（autoOrganize）

`autoOrganize()` action：
- 遍历全部会话，按 `cwd` 分组（`cwd` 规范化：反斜杠转正斜杠、去尾部斜杠）。
- 每个有 cwd 的目录：生成会话集名为目录 basename（同名已存在则复用该会话集，且合并其 cwd 记录）；组内会话赋 `setId`。
- 无 cwd 的会话不动（保持未分组）。
- 幂等：已归属的会话重复整理仍落在同目录会话集（不产生重复）。
- UI：chats 搜索行旁"一键自动整理"按钮触发。

## 5. UI（Sidebar chats 列表）

- 列表按会话集分组渲染：会话集头（名称 + 会话数 + 折叠箭头），默认展开；未分组会话置底"未分组"区。
- 置顶（pinned）语义不变：现有全局置顶区保留在分组视图之上，pinned 会话不参与分组归属展示（解除/设置分组不影响置顶状态）。
- 会话集头右键菜单：重命名 / 导出会话集 / 删除（解除归属）。
- 会话右键菜单新增：
  - 移动到会话集 → 子菜单（会话集列表 + 未分组项）
  - 导出分享 → 调导出流程（默认只含 chats 且已过滤到该会话）
- 折叠状态存组件局部 state（搜索时自动展开）。
- 会话集为空时允许删除；重命名沿用现有 inline 编辑模式。

## 6. 导出（packager + IPC）

**包内 chats 结构（新格式）**：

```
chats/
  sets.json            // { sets: ConversationSet[], byConversation: { [convId]: setId } }
  sessions/<convId>.json   // 每会话一个文件：{ id, title, createdAt, updatedAt, model, pinned, cwd, agentId, setId, messages }
```

- 每条会话消息仍 `slice(-100)`。
- 不再写旧 `chat-store.json`（新格式包）。
- manifest `stats.chats` 更新为按新结构统计；manifest 增加 `chat_format: 2`（旧包无此字段 → 视为 1）。

**exportPackage(opts) 增加 `chatsFilter?: { conversationIds?: string[]; setId?: string }`**：
- 无 filter → 全部会话。
- 有 filter → 仅所选会话（会话集过滤 = 该集内全部会话；conversationIds 与 setId 可叠加取并集）。
- chatsJson（localStorage `yfworking-chat` 字符串）在导出端解析并过滤、拆分写文件。

**IPC**：`experience:export` handler 透传 `payload.chatsFilter`；preload `exportExperience(opts)` 类型同步更新。

**触发入口**：
- 会话/会话集右键"导出分享"：直接调导出流程（`included: ['chats']` + chatsFilter，复用系统保存对话框；不弹类型勾选对话框，保持轻量）。
- 设置页"经验"面板导出对话框：chats 勾选时新增"范围"控件（全部会话 / 选择会话集 / 勾选会话）。

## 7. 导入（受控合并写回）

**importPackage**：
- 探测 `chats/` 目录：存在 `sessions/`（新格式）→ 聚合为 `{ sets, conversations }` 返回（不再整串回传）；仅存在旧 `chat-store.json` → 保持现状返回 `chatStoreJson` 字符串。
- 返回结构：`{ ok, manifest, restored, conflicts, chats?, chatStoreJson? }`。

**renderer（ExperiencePanel 导入回调）**：
- 新格式：调新增 store action `mergeImportedChats({ sets, conversations })`：
  - 会话按 id 去重：本地已存在 → 保留本地（导入的跳过并计入报告）；本地不存在 → 追加（消息应用 `slice(-100)`）。
  - 会话集按 id 去重合并：本地已存在 → 名称以本地为准；否则追加。
  - 写回前估算序列化体积（`JSON.stringify(partialize(state)).length`），超过 4MB 上限 → 按 updatedAt 升序裁剪最旧会话，直到合规；裁剪数计入导入报告。
  - persist 自动整体写 localStorage；仍抛 QuotaExceededError 时捕获，返回明确错误提示，本地数据不变。
- 旧格式：保持现状整体写回（兼容旧包）。

## 8. 错误处理与测试

- 导出：filter 指定的 setId 不存在 → `{ ok:false, error }`；chatsJson 解析失败 → 跳过 chats 并计入 skipped。
- 导入：sessions/ 内单文件损坏 → 该会话跳过 + conflicts++（不拖垮整体，沿用现有 per-file 语义）。
- 测试（server/packager.test.mjs 追加）：
  1. 新格式导出：chats 目录含 sets.json + 每会话一文件，无 chat-store.json，manifest.chat_format === 2。
  2. chatsFilter：setId 过滤只导出该会话集会话；conversationIds 过滤。
  3. 新格式导入：聚合返回 sets + conversations（不写盘，renderer 侧合并）。
  4. 兼容：旧单文件 chat-store.json 包导入仍返回 chatStoreJson。
  5. 损坏会话文件 → conflicts++ 且整体 ok。
- 前端：`npm run typecheck` 0 错误（chatStore 新 action、Sidebar 分组渲染、IPC 类型）。

## 9. 文件清单

- Modify: `src/stores/chatStore.ts`（conversationSets + setId + 5 个 action + mergeImportedChats + partialize）
- Modify: `src/types/index.ts`（ConversationSet、Conversation.setId、YFWAPI export/import 类型、chatsFilter）
- Modify: `src/components/layout/Sidebar.tsx`（分组渲染、会话集右键、会话右键新项、自动整理按钮）
- Modify: `src/components/settings/ExperiencePanel.tsx`（导入回调 merge、导出对话框 chats 范围）
- Modify: `server/packager.mjs`（chats 拆分导出/聚合导入/chatsFilter/兼容旧格式）
- Modify: `server/packager.test.mjs`（上述 5 用例）
- Modify: `electron/main.cjs`（experience:export 透传 chatsFilter）
- Modify: `electron/preload.cjs`（exportExperience 参数透传）
- i18n：`src/i18n/translations/zh-CN.ts`、`en-US.ts`（会话集相关文案）
