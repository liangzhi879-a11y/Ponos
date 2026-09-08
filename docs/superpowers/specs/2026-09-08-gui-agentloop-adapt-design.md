# GUI agentloop 契约适配设计（agentloop 前端接线）

> **状态**：已批准（2026-09-08，四项决策全部采纳 Recommended）
> **上游**：`docs/superpowers/specs/2026-09-08-agentloop-prod-upgrade-design.md`（后端契约，已完结 9142af7）
> **范围**：纯 `src/` 前端接线。server/bridge 与 kernel 一律不改——bridge 对内核 NDJSON 无条件透传
> （`server/bridge.mjs`：`{ type:'event', data: 帧, sessionId }`），故新事件到达 GUI 已是既成事实，
> 本 spec 只负责消费。

## Goal

把 agentloop 后端已交付的三类契约接到 GUI：

1. 三类新 warning 电平（budget / skill_version / agent_spec）→ **统一系统提示条**；
2. lane 压缩事件（`lane_compaction`）→ **子任务压缩提示**；
3. U1 用量/审计（`/api/usage` + `/api/audit`）→ **侧栏「用量」视图**。

## 决策记录（用户已确认，verbatim anchors）

| # | 问题 | 决策 |
|---|------|------|
| D1 | 本次适配覆盖哪些接线点 | **全部三项**（lane 压缩提示 + budget/skill_version/agent_spec warning 提示 + 用量/审计入口） |
| D2 | PONOS_BUDGET_USD 超支告警 | **提示 + 停止按钮** |
| D3 | 用量/审计的 GUI 入口形态 | **侧栏新增「用量」视图** |
| D4 | 三类 warning 呈现形式 | **统一系统提示条** |

## 架构

```
kernel 进程 (per conversation)
  │ NDJSON stdout
  ▼
server/bridge.mjs —— 无条件透传 {type:'event', data:帧, sessionId}
  │ ① WS 事件流         ② HTTP /api/usage /api/audit
  ▼                        ▼
src/hooks/useYFWCLI.ts   src/components/usage/UsagePanel.tsx
  handleMessage 按 data.type / subtype 分发    │
  │  ┌─ ponos_warning → warningStore          │ fetch(getBridgeUrl() + ...)
  │  └─ system/lane_compaction → chatStore    ▼
  ▼                                          src/lib/usageUi.ts（纯函数）
SystemWarningStrip / LaneCompactionToast
```

- **事件路径**：全部事件按会话（`sid` = conversationId）隔离。消费方 store 一律以
  `Record<conversationId, …>` 为键（沿 healthStore/compactingBySession 先例）。
- **HTTP 路径**：`getBridgeUrl()`（`src/lib/config.ts`）拼 `/api/usage`、`/api/audit`。
- **状态**：新增 1 个轻量 store（warningStore）+ chatStore 增 2 个字段/动作；
  归约与格式化逻辑抽 `src/lib/*.ts` 纯函数（type-only 引 store）——满足
  node 原生 TS 单测纪律（见测试策略）。

## 事件契约（GUI 侧消费字段，均已在后端 9142af7 交付）

### A. ponos_warning（`data.type === 'ponos_warning'`）

帧字段按 level 有别，共字段仅 `level`：

| level | 触发位 | 负载字段 | 语义 |
|-------|--------|----------|------|
| `budget` | engine runTurn 尾（会话级累计跨 PONOS_BUDGET_USD，每会话单次 crossing） | `usd`、`budgetUsd` | 预算超支 → 提示 + 停止按钮 |
| `skill_version` | cli 启动（skills.lock.json 存在且版本不一致，不阻断） | `outdated: {id, lock, disk}[]` | N 个技能与 lock 不一致 |
| `agent_spec` | engine runSubAgentLoop（子 Agent 引用未知工具/技能，忽略不拦截） | `agent`、`message` | 子 Agent 规格告警 → 原文展示 |
| `context`（既有，非本次新增） | engine preStep 接近压缩阈值 | `message` | 统一条顺带覆盖：generic 分支显示 message |

### B. lane_compaction（`data.type === 'system'`、`subtype === 'lane_compaction'`）

帧：`{ type:'system', subtype:'lane_compaction', taskId, text, compactCount }`
——lane（子 Agent）会话达压缩阈值完成摘要，`text` 为摘要、`compactCount` 为该 lane 累计压缩次数。

### C. /api/usage 响应（GET，可带 scope/sessionId/project/from/to query）

```jsonc
{
  "totals": { "input_tokens": 0, "output_tokens": 0,
              "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "turns": 0 },
  "byModel":   { "<model>": { "input_tokens": 0, "output_tokens": 0,
                              "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "turns": 0 } },
  "byProject": { "<project>": { …同上 } },
  "byDate":    { "YYYY-MM-DD": { …同上 } },
  "byTool":    { "<toolName>": <次数> },
  "cacheRate": 0.1234,
  "costUsd": 1.2345,
  "byModelCostUsd": { "<model>": 0.1234 },
  "budgetUsd": 0, "overBudget": false
}
```

### D. /api/audit 响应（GET，同 query；成功时 body 即裸数组）

```jsonc
[
  { "ts": "…", "seq": 12, "session": "<sessionId>", "type": "tool_use",
    "tool": "Read", "params": "{…截断 200 字}" },
  { "ts": "…", "seq": 13, "session": "<sessionId>", "type": "tool_result",
    "toolUseId": "toolu_…", "summary": "…截断 200 字" }
]
```

失败（502 等）返回 `{ "error": "…" }`——拉取层需先 `res.ok` 判定再 `json()`。

## 能力 1：统一系统提示条（warningStore + SystemWarningStrip）

### 1.1 warningStore（新建 `src/stores/warningStore.ts`）

- 状态：`warningBySession: Record<string, KernelWarning>`；动作 `set(sid, w)` / `dismiss(sid)` / `reset(sid)`。
- **不 persist**（warning 是内核进程生命周期事件；进程重启后新 crossing 会再发，持久化反会误吞）。
- `KernelWarning` 归约（`src/lib/warningUi.ts` 纯函数 `normalizeWarning(frame)` 产出）：
  `{ level, ts, message?, usd?, budgetUsd?, outdated?: {id,lock,disk}[], agent? }`。
  未知字段原样透传；`context`/`agent_spec` 的 `message` 直存（引擎已产中文原文）。
- 同 level 重复事件覆盖更新（budget 内核已单次、skill_version 仅启动、agent_spec 每 lane 至多一次——
  实际无刷屏路径；generic 规则"后到覆盖先到"即足够）。
- 归约仅做白名单取字段，不做文案——文案在渲染层走 i18n。

### 1.2 接线（`src/hooks/useYFWCLI.ts` handleMessage `msg.type==='event'` 分支）

新增分支（与既有 `yfw_health` 等平级，紧随其后）：

```ts
if (type === 'ponos_warning') {
  useWarningStore.getState().set(sid, normalizeWarning(event as KernelWarningFrame))
  return
}
```

会话生命周期复位（沿既有 init 分支语义）：`type==='system' && subtype==='init'` 分支内，
在既有 `if (!conv?.sessionId) { useHealthStore…reset(sid) }` 同处追加
`useWarningStore.getState().reset(sid)`——**新会话内核**（无旧 sessionId）才清 warning，
resume（同 transcript 续跑）保留，避免清掉刚发到的 skill_version 启动告警（该告警先于 init 到达）。

### 1.3 SystemWarningStrip（新建 `src/components/chat/SystemWarningStrip.tsx`）

- Props：`{ conversationId: string }`；读 `useWarningStore(s => s.warningBySession[conversationId])`；无则 `null`。
- 挂载：`src/components/chat/ChatWindow.tsx`，`<KernelStallBar/>` 之后、`<ScrollArea/>` 之前
  （普通文档流元素，非 absolute 悬浮——避免与顶部两枚悬浮胶囊叠位；有告警才占位）。
- 形态（沿用状态胶囊 tokens：`bg-elevated/90 backdrop-blur rounded-* border`，KernelStallBar 同族）：

| level | 图标 (lucide) | 色调 | 文案（i18n 键 `warnings.*`，zh/en） |
|-------|--------------|------|------|
| budget | `AlertTriangle` | red（描边 red-500/40） | `budget`: 「预算超支：累计 {usd} USD，超过限额 {budgetUsd} USD」 |
| skill_version | `RefreshCcw` | amber | `skillVersion`: 「{n} 个技能与 skills.lock.json 版本不一致」 |
| agent_spec | `Bot` | amber | `agentSpec`: 原文 `message`（引擎已产中文） |
| 其他（含 context） | `Info` | amber | generic：`message` 直显；无 message 时显示 level 名 |

- 动作（右端按钮）：
  - **停止任务**（仅 budget 级显示，danger 样式）：`useChatStore.stopStreaming(conversationId)` +
    `useYFWCLI().stop(conversationId)`（双调 cancel 语义，同 KernelStallBar onCancel / ChatInput stop 按钮）；
  - **关闭**：`warningStore.dismiss(sid)`（纯收 UI；同级别后到事件仍可再置）。
- 多行摘要（skill_version 的 outdated 明细、agent_spec message）在 strip 上单行截断，
  `title` 属性悬停展示全文。
- i18n 键组 `warnings`（zh/en 双文件，见附录 copy 表）。

## 能力 2：lane 压缩提示（chatStore 扩展 + LaneCompactionToast）

### 2.1 归约（`src/lib/laneUi.ts` 纯函数，node 直测）

- `pushLaneNote(list, note)`: `note = { key, taskId, text, compactCount, ts }`，`key = taskId`（同 task 重复压缩
  覆盖计次字段而非追加行）；列表 cap 3（超限丢最旧）。
- `dismissLaneNote(list)`: 移除头部（单发 toast 消费语义）。

### 2.2 chatStore 扩展

- 字段 `laneNotesBySession: Record<string, LaneNote[]>`；动作
  `pushLaneNote(sid, note)` / `dismissLaneNote(sid)`（实现调 lib 纯函数，store 只做按会话桶写入）。
- `clearSubAgentTasks` 既有路径**不动**（lane 压缩 ≠ 任务结束，终态仍由 task_notification 驱动）。

### 2.3 接线（useYFWCLI handleMessage）

`data.type === 'system'` 的 subtype 分发链中新增：

```ts
if (subtype === 'lane_compaction') {
  const n = event as { taskId?: unknown; text?: unknown; compactCount?: unknown }
  useChatStore.getState().pushLaneNote(sid, makeLaneNote(String(n.taskId || ''), String(n.text ?? ''), Number(n.compactCount) || 0))
  return
}
```

### 2.4 LaneCompactionToast（新建 `src/components/chat/LaneCompactionToast.tsx`）

- Props `{ conversationId }`；读 `laneNotesBySession[conversationId]` 头部 note；无则 `null`。
- 渲染：fixed 右下角、`CompressedToast` 上方错位（`bottom-14 right-4`），同族胶囊：
  icon `Layers`，标签 `t('laneCompact.title', { n: compactCount })` + 摘要正文（`text` 直显、单行截断、
  全文入 `title` 悬停）；`role="status" aria-live="polite"`。
- 自消：note 出现后 5s 自动 `dismissLaneNote(sid)`（effect 计时，list 头部换 key 即重置）；
  新 note 到达时头部更换 → 直接顶替（cap 3 保证队列天然去重）。
- 挂载：`ChatWindow.tsx`，`<CompressedToast/>` 旁。
- 不写进 SubAgentTask 记录——lane 压缩是过程态，终态仍走既有 task 卡片；toast 即"过程提示"。

## 能力 3：侧栏「用量」视图（UsagePanel）

### 3.1 拉取层（`src/lib/usageUi.ts`）

- `fetchUsage(params)` / `fetchAudit(params)`：`fetch(`${getBridgeUrl()}/api/usage?…`)`，
  5s AbortController 超时（沿 fetchSkills 先例）；非 2xx → 抛/返回 `{ error }`（502 body 为 `{error}`）。
  参数仅透传**非空**的 `project` / `sessionId` / `scope`。
- 纯函数（node 直测）：
  - `fmtTokens(n)`：≥1e6 → `1.2M`；≥1e3 → `12.3k`；否则原数（千分位）。
  - `fmtUsd(n)`：`n.toFixed(4)`。
  - `projectOptions(report)`：`byProject` 键名排序数组（审计下拉复用）。
  - `auditView(rows, cap=200)`：按 `ts desc`、同 ts 按 `seq desc` 排序，截前 200 条。
  - `usageTotalsView(report)`：提取展示字段数值结构（input/output/cacheRead/cacheRate/turns/costUsd/
    budgetUsd/overBudget、byModelCostUsd 条目数组、byTool 计数数组）——数值在组件层配 i18n 标签渲染。
  - 输入防御：usage 响应缺键时按 0/[] 兜底；audit 非数组返回 []（拉取失败显示错误态）。

### 3.2 UsagePanel（新建 `src/components/usage/UsagePanel.tsx`）

- 布局：垂直分割——
  1. 头行：标题「用量」+ 刷新按钮（`common.refresh`）；加载中转圈；错误态显示 `error` + 重试。
  2. 分段控件（`usage.segmentUsage` / `usage.segmentAudit`，本地 state）：**用量摘要** | **审计明细**。
- **用量摘要段**：
  - 总计卡：输入/输出 tokens（fmtTokens）、cache 读、缓存率 `cacheRate`（% 一位小数）、轮数 `turns`、
    成本 `costUsd`（fmtUsd USD）；`budgetUsd>0` 时显示「预算 {budgetUsd} USD」，
    `overBudget` 时该行 red 强调（与系统条互不冲突：条是会话内事件、这里是全量聚合）。
  - 按模型表：`byModelCostUsd` + `byModel.turns` 逐行。
  - 按项目表：`byProject` 键名行（点选 → 置为当前 project 过滤并重拉两接口；再点取消）。
  - 按工具表：`byTool` 计数递减。
- **审计明细段**：
  - 顶部：project 下拉（`projectOptions`，默认全部）+ 本地搜索框（对 tool/params/summary/session 子串过滤）。
  - 行（最高 200，`auditView`）：`type==='tool_use'` → 上箭头+工具名（title=params 全文）；
    `tool_result` → 对勾+截断 summary；行尾 `session` 短 id + ts（`MM-DD HH:mm`）。
  - 无数据/过滤空 → 空态文案。
- 数据生命周期：挂载即拉（默认全量）；切 project 或点刷新重拉；**不自动轮询**
  （后端每次请求冷聚合 transcript，成本高；会话进行中需最新可点刷新）。
- 窄栏适配：全部区块宽度自适应（面板 340px），数值右对齐、标签截断。

### 3.3 侧栏入口（Sidebar / uiStore / i18n）

- `src/stores/uiStore.ts`：`sidebarTab` 联合类型与 `setSidebarTab` 签名加 `'usage'`。
- `src/components/layout/Sidebar.tsx`：`TABS` 数组末位插入
  `{ id:'usage', icon: Gauge, labelKey:'sidebar.usage' }`（lucide `Gauge` 加入 import）；
  panels 区追加 `{sidebarTab === 'usage' && <UsagePanel />}`。
- i18n `sidebar.usage`：zh「用量」/ en「Usage」。
- tab 顺序：chats/files/worktrees/history/agents/skills/**usage**（末端，非高频）。

## 测试策略（沿 S4/S5 GUI 纪律，不引入 vitest/新依赖）

| 层 | 手段 |
|----|------|
| 纯函数单测 | `node --test src/lib/warningUi.test.ts src/lib/laneUi.test.ts src/lib/usageUi.test.ts`（Node24 原生 TS；被测模块对 zustand/store 仅 `import type`） |
| 接线/组件 | `npm run typecheck` + `npm run build` + 授权 manual 冒烟行（沿 S5 GUI manual 先例） |
| 回归 | `npm test`（server/electron 150 项，本适配不改其后端，须保持全绿） |

覆盖点：warning 帧归一化（四 level + 未知兜底）、lane note cap/去重、tokens/usd 格式化、
audit 排序截断与 project 下拉、usage 缺键兜底。

## Non-goals（明确不做）

- 不改 kernel / server/bridge / electron 任何文件。
- 不在 GUI 写预算硬停（内核本就不硬停；GUI 提供"停止任务"按钮，决策 D2 语义即止）。
- 用量视图不做自动轮询、不做日期范围 UI（参数留接口可透传，后续按需）。
- skill_version 提示不提供"打开技能面板/重装"跳转（提示即止）。
- lane 压缩不入 SubAgentTask 记录/终态卡片（见 2.4）。

## 附录：i18n copy（zh/en，键新增到 `src/i18n/translations/*.ts`）

```ts
warnings: {
  budget:  '预算超支：累计 {usd} USD，超过限额 {budgetUsd} USD' / 'Budget exceeded: {usd} USD used, limit {budgetUsd} USD',
  skillVersion: '{n} 个技能与 skills.lock.json 版本不一致' / '{n} skills differ from skills.lock.json',
  stopTask: '停止任务' / 'Stop task',
  dismiss: '关闭' / 'Dismiss',
},
laneCompact: { title: '子任务压缩 · 第 {n} 次' / 'Subtask compacted · round {n}' }
// toast 正文 = '{text}'（摘要）直显单行截断，title 属性悬停全文——无独立 i18n 键
sidebar: { …existing…, usage: '用量' / 'Usage' },
usage: {
  segmentUsage: '用量摘要' / 'Usage', segmentAudit: '审计明细' / 'Audit',
  inputTokens: '输入', outputTokens: '输出', cacheRead: '缓存读',
  cacheRate: '缓存率', turns: '轮数', cost: '成本', budget: '预算',
  byModel: '按模型', byProject: '按项目', byTool: '按工具', allProjects: '全部项目',
  noData: '暂无用量数据', emptyAudit: '暂无审计明细', error: '加载失败',
  rowCapHint: '显示最近 {n} 条' / 'Showing latest {n} rows',
}
```

> 实施期注意：i18n 键文案以本表为准；翻译文件结构（zh-CN.ts/en-US.ts 键平级）保持现状即可。
