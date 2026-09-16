# Spec：历史会话一键蒸馏到知识库（2026-09-15）

## 0. 定位与需求

**来源**：`docs/待处理清单.md` P1 条目——

> 增加历史会话一键蒸馏到知识库功能

拆解：① 入口在**历史会话**（会话列表项，非当前对话）；② 一键（不要用户手抄）；③ 落到**知识库**
（可检索、可被知识面板看到、可被后续会话检索到）。

**依赖现状**（均已落地，本 spec 不新增后端通道）：

- 写通道：`server/knowledge-routes.mjs:handleWriteDoc`（四重穿越防护 + 原子写 + mtime 冲突校验 + 2MB 上限），
  前端封装 `src/lib/knowledgeApi.ts:writeDoc()` 与缓存失效包装 `src/hooks/useKnowledge.ts:saveDoc()`；
- 会话正文真源：内核 transcript，前端按需加载 `src/lib/transcriptLoader.ts:loadConversationMessages()`；
- 知识库 GUI：`src/components/knowledge/*`（空间选择、文档树、阅读视图）。

**不在本轮范围（显式非目标）**：

- **不做模型摘要**（见 D1 与 U1）；不做会话集/多选批量蒸馏；不做自动/定时蒸馏；
- 不做"新建知识空间"（写通道对不存在的空间回 404，新建只有导入通道能给，见 D12/U3）；
- 不改内核、不改 server、不改既有会话与知识库逻辑，不引入新依赖。

## 1. 现状锚点（源码核对，2026-09-15 实测）

| 事实 | 坐标 | 结论 |
|---|---|---|
| 会话类型 | `src/types/index.ts:130-163` | `Conversation{ id,title,messages:Message[],createdAt,updatedAt,model,cwd?,sessionIds?,tags?,summary?,messageCount? }` |
| 消息/块类型 | `src/types/index.ts:26-54` | `Message.content: ContentBlock[]`；块 `type ∈ text/tool_use/tool_result/thinking/image/file`，工具有 `metadata.toolName` |
| 会话 store | `src/stores/chatStore.ts`（persist `yfworking-chat-persist` 家族） | `partialize` **不落 messages**；`evictLoadedConversations()` 会卸载非激活会话的 messages ⇒ **列表里的会话可能 messages 为空** |
| 会话正文真源 | `src/lib/transcriptLoader.ts:74 fetchTranscript()` / `:110 loadConversationMessages()` | 按 `sessionIds` + `cwd` 拉内核转录；`crop:false, tailFirst:false` 才是**完整正文** |
| 本地兜底正文 | `src/lib/chatExport.ts:36`、`chatStore.ts:104 EXT_KEY_PREFIX` | `localStorage['yfworking-chat-ext-<convId>']`（迁移/导入会话的正文） |
| 会话列表 UI | `src/components/rail/TaskListPanel.tsx:585-620`（行右键菜单）；`ChatListPanel.tsx`（**无**右键菜单） | 挂点选 TaskListPanel 的行菜单（与既有 5 项同风格） |
| 写文档（HTTP） | `src/lib/knowledgeApi.ts:695 writeDoc()` | 入参 `KnowledgeWriteInput{space,path,content,mtime?,force?}`；错误 400/403/404/413/409；409 带 `conflict{mtime,size}` |
| 写文档（唯一写入口） | `src/hooks/useKnowledge.ts:300 saveDoc()` | 成功后失效 `doc/tree/search/links/relatedDoc/graphRelated/stats/indexTags/mentions/brokenLinks` ⇒ **必须走它**，直接调 api 会"刚蒸馏却看不到" |
| 服务端写校验 | `server/knowledge-routes.mjs:145-200` | 只收空间内相对 `.md` 路径；`mkdirSync(dirname(dest),{recursive:true})` ⇒ **子目录（`会话蒸馏/`）会被自动创建**；空间不存在 404 / 只读 403 / >2MB 413 / mtime 不一致 409 |
| 空间发现 | `kernel/knowledge.mjs:269 discoverSpaces()`、`:785 builtinSpaceSpecs` | 内置 `experience`/`session-memory`/`skill-experience`（`writable:true`）+ 用户空间（`source:'user'`, writable）+ 知识包（`id: pack-*`, `writable:false`） |
| 前端空间读 | `src/hooks/useKnowledge.ts:useSpaces()` / `useTree(space,path)` | 复用（不新造一套空间交互） |
| 模型调用 | `src/lib/titleGen.ts:47 resolveTitleProvider()`（**未导出**）+ `:88 generateChatTitle()` | 唯一前端模型通道，且是**标题专用私有 helper**：签名只回 12 字标题，无法当摘要通道用 |
| 索引块切分 | `shared/knowledge-core.mjs:258 splitBlocks()` | 按 heading/代码围栏/表格/列表/**条目行**切块；`ENTRY_LINE_RE = /^- \[([^\]]*)\]\s*(.*)$/` ⇒ 正文若含 `- [x] …` 行会被当成经验**条目**（见 D13） |
| 前端纪律 | `src/lib/dirPicker.ts:1-7` 注释、`src/lib/knowledgeImportUi.ts:1-3` | 纯逻辑必须落 `.ts`（`.tsx` 无法被 `node --test` import）；被测模块**零运行时依赖**（不用 `@/` alias） |
| 知识组件静态门禁 | `scripts/verify-knowledge-gui.mjs` | `src/components/knowledge/**` 有 400 行上限 / 禁裸 hex / 禁 emoji |

## 2. 关键决策表

| # | 决策 | 理由 |
|---|---|---|
| D1 | 蒸馏 = **机械结构化提取**（零模型）作为唯一实现，不接摘要模型 | ① 「一键」必须**无配置也能用**，模型未配置/超时/挂掉时功能不能整体失效；② 输出**确定**（同输入同字节），才能做幂等与单测；③ 唯一现成模型通道 `titleGen.resolveTitleProvider` 是**未导出的私有 helper**，复用要改动与本功能无关的文件，且摘要幻觉写进知识库比"原始结构化正文"更糟（检索到错误结论）。模型摘要列为 U1 后续**可选**增强（加在机械层之上，失败回落） |
| D2 | 纯逻辑全部落 `src/lib/sessionDistill.ts`（+ `sessionDistill.test.ts`），组件只做 IO 与渲染 | `.tsx` 不能被 `node --test` import（仓库既有纪律）；路径清洗/重名/超长裁剪/块降级都是**有边界条件的逻辑**，写进组件等于零覆盖 |
| D3 | 蒸馏目录 `会话蒸馏/`（空间内相对子目录），路径 = `会话蒸馏/<createdAt 日期>-<清洗标题>-<会话键8>.md` | 服务端 `mkdirSync(recursive:true)` 自动建目录（实测 `knowledge-routes.mjs:174`）；集中在子目录便于用户整目录清理，也不污染空间根 |
| D4 | 日期前缀取 **createdAt** 而不是 updatedAt | updatedAt 会随每次续聊变化 ⇒ 同一会话两次蒸馏得到**两个路径**（重复文件、幂等破裂）；createdAt 终生不变 |
| D5 | 幂等靠 **路径内嵌会话键**（`conv.id` 的 8 位短键）+ 目标目录 listTree **命中即复用既有 path** | 会话标题/日期都可能变（用户改名）：只有"扫目录找 `-<键>.md` 后缀"才能把"同一会话已蒸馏过"认出来。命中 → 覆写同一文件（原地更新），不产生 `-2.md` 副本 |
| D6 | 覆写前**必须带 mtime**；服务端 409 ⇒ UI 显示冲突并让用户选择；`force:true` **只在用户点「覆盖」时**才传 | 知识空间目录是共享的（Obsidian/VSCode 会改同一批 md）。不带 mtime ⇒ 服务端跳过校验 ⇒ 外部改动无声消失（数据损坏级）。`force` 语义上必须是一次显式点击 |
| D7 | 超长会话按**头 70% + 尾 30%** 字节预算裁剪，插入显式省略标记；单条消息 4000 字、工具参数/结果 600 字上限；预算 600KB（< 服务端 2MB） | 头含任务陈述、尾含结论/交付物，中间过程最可丢；截断必须**留痕**（否则用户以为蒸馏完整）。按**字节**而非字符算预算：服务端上限是字节，中文 3 字节/字，按字符预算会在纯中文会话上超限被 413 |
| D8 | `thinking` 块默认丢弃（`includeThinking` 可开）；`image`/`file` 降级成 `〔图片〕`/`〔文件：name〕`；`tool_use` → `工具调用 \`Name\`` + 参数 JSON；`tool_result` → `工具结果（截断）` 块 | thinking 是模型内部推理，体量常占全文一半以上且检索价值最低；工具块必须**降级而不是丢弃**（否则"为什么改了这个文件"的证据链断掉） |
| D9 | 目标空间 = 用户显式选择，候选 = `writable !== false` 的空间；默认序：上次选择 → 首个 `source==='user'` → `session-memory` → 任一可写 | 蒸馏笔记是用户知识 ⇒ 用户空间是自然归宿；`experience`/`session-memory` 是内置可写空间，作为无用户空间时的兜底（`session-memory` 语义最近）。只读 `pack-*` **不进候选**，同时 403 仍给可读文案（双保险，UI 预判不得替代后端判据） |
| D10 | 会话正文取 **`loadConversationMessages(conv,{tailFirst:false,crop:false})`**，返回空时回落 store 内存 messages 与 `yfworking-chat-ext-<id>` | 列表里的会话正文**可能根本不在内存**（persist 剥掉 + 内存淘汰），且默认展示级 `crop:true` 会截断正文 ⇒ 拿它蒸馏等于**静默丢内容**。三条来源与 `chatExport` 的既有顺序一致（导出已验证过这套组合） |
| D11 | 写入只走 `useKnowledge.saveDoc()` | 它负责 tree/search/图谱/stats/标签/提及/断链的缓存失效；绕过去 = "蒸馏成功但树里看不到、搜不到"（用户会以为失败再蒸一遍） |
| D12 | **不新建知识空间**：新建空间只有导入通道能给（`handleWriteDoc` 对未知 space 回 404） | 为不新增后端通道（本轮范围），目标空间限制在既有可写空间 |
| D13 | 正文里的 `- [x] ...` 行**不转义**，但文档标题行不使用条目语法；蒸馏文档放在用户空间而非经验空间时该风险仅在用户主动把目标选为经验空间时出现 | 保真优先（转义会改坏原始正文与代码块）。`ENTRY_LINE_RE` 只在**经验库注入**路径上被消费，且默认目标是用户空间/`session-memory`。风险记入 U4 |
| D14 | 蒸馏内容**不含"当前时间"**（只用会话自身的 createdAt/updatedAt） | 含 now ⇒ 同一会话两次蒸馏内容不同 ⇒ 服务端 `unchanged` 短流失效、每次都是全文覆写，且幂等单测无法钉住 |

## 3. 接口契约

### 3.1 纯逻辑层 `src/lib/sessionDistill.ts`（零运行时依赖，仅 `import type`）

```ts
export const DISTILL_DIR = '会话蒸馏'
export const DISTILL_TAG = '会话蒸馏'
export const DISTILL_BUDGET_BYTES = 600 * 1024        // 正文预算（远低于服务端 2MB 上限）
export const DISTILL_MAX_MESSAGE_BYTES = 4000
export const DISTILL_MAX_TOOL_BYTES = 600
export const DISTILL_HEAD_RATIO = 0.7
export const DISTILL_MAX_QUESTIONS = 20
export const DISTILL_NAME_MAX = 48
export const SERVER_MAX_DOC_BYTES = 2 * 1024 * 1024   // 与 server MAX_DOC_BYTES 同口径（仅用于本地预判）

export interface DistillTarget { id: string; name?: string; writable?: boolean; source?: string }
export interface DistillOptions {
  dir?: string; budgetBytes?: number; maxMessageBytes?: number
  maxToolBytes?: number; includeThinking?: boolean; maxQuestions?: number
}
export interface DistillPlan {
  spaceId: string; path: string; docId: string; content: string
  bytes: number; reused: boolean; truncated: boolean; omitted: number; title: string
}
export interface DistillPlanInput {
  conversation: Conversation; messages: Message[]; spaceId: string
  entries?: Array<{ name?: string; path: string; type?: string }>; options?: DistillOptions
}

export function utf8Bytes(s: string): number
export function clipToBytes(s: string, maxBytes: number): { text: string; truncated: boolean }
export function truncateToBytes(s: string, maxBytes: number): string
export function fenceBlock(text: string, lang?: string): string
export function sanitizeDistillName(title: string, maxLen?: number): string
export function conversationKey(conv: { id?: string }): string
export function formatStamp(ms: number | undefined): string
export function distillRelPath(conv: Conversation, dir?: string): string
export function distillDocId(spaceId: string, rel: string): string
export function findDistilledEntry<T extends { name?: string; path: string; type?: string }>(entries: T[] | undefined, conv: { id?: string }): T | null
export function pickDefaultDistillSpace<T extends DistillTarget>(targets: T[] | undefined, lastUsedId?: string | null): T | null
export function conversationToMarkdown(conv: Conversation, messages: Message[], opts?: DistillOptions): { content: string; truncated: boolean; omitted: number }
export function planDistill(input: DistillPlanInput): DistillPlan
export function describeDistillError(status: number | undefined, error: string, space?: DistillTarget | null): string
```

**幂等契约**：`planDistill` 对同一 `(conversation, messages, spaceId, entries)` 必须返回**逐字节相同**的
`content` 与 `path`；`entries` 命中时 `reused=true` 且 `path` = 既有条目路径。

**字节契约**：`utf8Bytes(plan.content) === plan.bytes`；预算足够（≥ 头部 + 页脚 + 512 预留）时
`plan.bytes <= budgetBytes`；恒有 `plan.bytes < SERVER_MAX_DOC_BYTES`。页脚与省略标记也计入预算
（漏掉任何一项，"600KB 预算"就只是装饰）。

### 3.2 写通道调用（UI 侧）

```ts
// 首次（新文件）：不带 mtime/force
saveDoc({ space: plan.spaceId, path: plan.path, content: plan.content })
// 复用既有文件：带上加载时看到的 mtime（服务端比对，不一致 → 409）
saveDoc({ space: plan.spaceId, path: plan.path, content: plan.content, mtime })
// 409 且用户点「覆盖现有文件」：force:true（服务端先把磁盘那份备份进回收站）
saveDoc({ space: plan.spaceId, path: plan.path, content: plan.content, mtime, force: true })
```

409 判定 = `!r.ok && r.status === 409`（`knowledgeApi.writeDoc` 已在 conflict 字段带出磁盘 mtime/size）。

## 4. 验收标准

| # | 验收 | 判定方式 |
|---|---|---|
| A1 | 纯逻辑单测全绿，覆盖：空会话 / 无正文（仅工具块）/ 含代码块（含内层围栏）/ 含工具调用与工具结果 / 超长（头尾保留 + 省略标记）/ 标题含非法文件名字符 / 同名冲突（reuse）/ 同一会话重复蒸馏（幂等） | `node --test src/lib/sessionDistill.test.ts` |
| A2 | 幂等：同一会话两次 `planDistill` → 同 path、同 docId、content 逐字节相同 | 单测（显式断言两次调用 deepEqual） |
| A3 | 冲突：复用既有文件时带 mtime；服务端 409 时 UI 明示且**不写**；`force:true` 只由用户点「覆盖」触发 | 代码走查 + 单测（`describeDistillError(409)` 文案）；真机手测 409 分支 |
| A4 | 只读空间：`pack-*` 不进候选；若服务端回 403，UI 显示"该空间只读…"，错误**不吞** | 单测（`pickDefaultDistillSpace` 过滤 + `describeDistillError(403)`）+ 代码走查 |
| A5 | UI 在写入前明示**空间名 + 空间内相对路径 + docId + 字节数** | 人工走查截图（代码走查兜底） |
| A6 | 无模型/未配置 provider 也能完成蒸馏（功能不依赖模型） | 机械实现天然满足；`grep` 确认 `sessionDistill.ts` 无 fetch/模型调用 |
| A7 | 超长会话文档 < 服务端 2MB 且含省略标记；字节计算按 UTF-8 | 单测（中文长文本 + 断言 `bytes === utf8Bytes(content)`、`bytes < 2MB`、marker 存在） |
| A8 | `npm run typecheck` 零错误；`npm run build` 成功；`npm test` 全量无新增失败 | 三条命令真实输出 |
| A9 | 不新增依赖；不改与功能无关的文件（本功能触及：新增 3 文件 + i18n 2 文件 + TaskListPanel 1 处挂点） | `git status` 对照 |

## 5. 未决项

| # | 未决项 | 说明 |
|---|---|---|
| U1 | 模型摘要增强 | 机械提取之上加"可选摘要段"（复用 provider，调用失败静默回落）。前置：把 `titleGen.resolveTitleProvider` 提升为可复用的 provider 通道（涉及改动非本功能文件，故本轮不动） |
| U2 | `ChatListPanel`（对话会话）入口 | 该列表**没有**右键菜单基建，加菜单是新交互形态；本轮只覆盖任务会话列表（历史会话的主要形态） |
| U3 | "自动建一个「会话蒸馏」空间" | 需要新的建空间通道（或在导入路由上扩展），否则用户得先手动建空间 |
| U4 | `- [x] …` 行落入经验空间的条目风险 | 目标空间若被用户选为 `experience`/`session-memory`，正文里的 `- [x]` 行会被内核当经验条目行解析（`ENTRY_LINE_RE`）。未做转义（保真优先）；可考虑写入前检出行首条目形态并在文档头加警示 |
| U5 | 已有蒸馏文件的**反向**清理 | 会话被删除后，蒸馏文件仍在知识库（回收站/知识面板可手动删）。本轮不做级联 |
| U6 | 二进制/图片附件 | `image`/`file` 块只降级成占位文本，附件本体不入库 |
