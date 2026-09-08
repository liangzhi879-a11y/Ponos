# GUI agentloop 契约适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agentloop 后端已交付契约接到 GUI：① 三类新 warning（budget/skill_version/agent_spec，顺带 context）→ 统一系统提示条；② lane_compaction → 子任务压缩 toast；③ /api/usage + /api/audit → 侧栏「用量」视图。

**Architecture:** 纯 `src/` 改动（bridge 已无条件透传内核事件）。新增 warningStore + chatStore 两个 lane-note 字段承载事件态；归约/格式化逻辑抽 `src/lib/*.ts` 纯函数（type-only 引 store，Node 24 原生 TS 直测）；组件按既有会话状态胶囊/面板 tokens 实现。

**Tech Stack:** React 18 + zustand + Tailwind（无新依赖、无 vitest）；测试 = `node --test`（Node 24 原生 TS）。

## Global Constraints

（每 Task 隐含包含本节的全部要求，从 spec 2026-09-08-gui-agentloop-adapt-design.md verbatim 摘取）

- **改动边界**：只允许改 `src/` 与 `docs/`；kernel/server/electron 一律不改。commit message 前缀 `feat(gui-agentloop):`。
- **GUI 测试纪律（S4/S5 沿续）**：不引入 vitest/任何新依赖。纯函数单测 = `node --test src/lib/<name>.test.ts`（Node 24 原生 TS 剥离，相对导入必须带 `.ts` 扩展）；被测模块对 zustand store 只能 `import type`、禁止 `@` alias 运行时 import（node 解析不了）。GUI 接线/组件验证 = `npm run typecheck`；最终验收含 `npm run build`。
- **事件按会话隔离**：全部新状态以 `Record<conversationId, …>` 为键；`sid` 即 handleMessage 的 `(msg.sessionId as string) || 'default'`。
- **transient 不 persist**：warning / lane notes 均为进程生命周期态，不进任何 zustand `partialize`/persist。
- **i18n**：新增键必须同时落 zh-CN.ts 与 en-US.ts（键平级结构保持一致；t() 未类型化，缺键回退显示 key 本身）。
- **文案**（zh/en，spec 附录原文）：
  - `warnings.budget`: zh「预算超支：累计 {usd} USD，超过限额 {budgetUsd} USD」 / en「Budget exceeded: {usd} USD used, limit {budgetUsd} USD」
  - `warnings.skillVersion`: zh「{n} 个技能与 skills.lock.json 版本不一致」 / en「{n} skills differ from skills.lock.json」
  - `warnings.stopTask`: zh「停止任务」 / en「Stop task」
  - `warnings.dismiss`: zh「关闭」 / en「Dismiss」
  - `warnings.unknown`: zh「{level} 系统告警」 / en「{level} warning」
  - `laneCompact.title`: zh「子任务压缩 · 第 {n} 次」 / en「Subtask compacted · round {n}」
  - `sidebar.usage`: zh「用量」 / en「Usage」
  - `usage.segmentUsage`: zh「用量摘要」 / en「Usage」；`usage.segmentAudit`: zh「审计明细」 / en「Audit」
  - `usage.inputTokens`: zh「输入」 / en「Input」；`outputTokens` 输出/Output；`cacheRead` 缓存读/Cache read；`cacheRate` 缓存率/Cache rate；`turns` 轮数/Turns；`cost` 成本/Cost；`budget` 预算/Budget
  - `usage.byModel`: zh「按模型」 / en「By model」；`usage.byProject` 按项目/By project；`usage.byTool` 按工具/By tool；`usage.allProjects` 全部项目/All projects
  - `usage.noData`: zh「暂无用量数据」 / en「No usage data」；`usage.emptyAudit` 暂无审计明细/No audit rows；`usage.error` 加载失败/Load failed
  - `usage.refresh`: zh「刷新」 / en「Refresh」（若组件用 common.refresh 则跳过本键）

---

### Task 1: warning 归约纯函数 + warningStore + 单测

**Files:**
- Create: `src/lib/warningUi.ts`
- Create: `src/stores/warningStore.ts`
- Test: `src/lib/warningUi.test.ts`

**Interfaces:**
- Consumes: 内核 `ponos_warning` 事件帧（spec 附录 A，字段 `level`/`message`/`usd`/`budgetUsd`/`outdated`/`agent`，帧值类型为 `unknown`）。
- Produces: `normalizeWarning(frame) → KernelWarning`、`KernelWarning`/`KernelWarningFrame` 类型、`useWarningStore`（Task 2 消费）。

- [ ] **Step 1: Write the failing test**

Create `src/lib/warningUi.test.ts`（node 原生 TS；被测模块零依赖，无需 mock）：

```ts
// src/lib/warningUi.test.ts
// node --test src/lib/warningUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWarning } from './warningUi.ts'
import type { KernelWarningFrame } from './warningUi.ts'

test('budget 帧归约：usd/budgetUsd 数值透传', () => {
  const w = normalizeWarning({ type: 'ponos_warning', level: 'budget', usd: 1.2345, budgetUsd: 1 })
  assert.equal(w.level, 'budget')
  assert.equal(w.usd, 1.2345)
  assert.equal(w.budgetUsd, 1)
  assert.equal(w.message, undefined)
})

test('skill_version 帧归约：outdated 数组白名单映射', () => {
  const w = normalizeWarning({ level: 'skill_version', outdated: [{ id: 'gxtz-x', lock: '2.0.0', disk: '1.0.0' }, { id: '', lock: '1', disk: '1' }, null] })
  assert.deepEqual(w.outdated, [{ id: 'gxtz-x', lock: '2.0.0', disk: '1.0.0' }])
})

test('agent_spec / context 帧归约：message 与 agent 透传', () => {
  const a = normalizeWarning({ level: 'agent_spec', agent: 'researcher', message: '引用未知工具 x（已忽略）' })
  assert.equal(a.agent, 'researcher')
  assert.equal(a.message, '引用未知工具 x（已忽略）')
  const c = normalizeWarning({ level: 'context', message: '接近压缩阈值' })
  assert.equal(c.level, 'context')
  assert.equal(c.message, '接近压缩阈值')
})

test('未知 level 与缺失字段兜底：level=unknown、其余字段缺省', () => {
  const w = normalizeWarning({})
  assert.equal(w.level, 'unknown')
  assert.equal(w.usd, undefined)
  assert.equal(w.budgetUsd, undefined)
  assert.equal(w.outdated, undefined)
  assert.equal(w.agent, undefined)
  assert.equal(w.message, undefined)
  assert.ok(typeof w.ts === 'number')
})

test('非数值/非数组负载免疫：usd 字符串不取、outdated 非数组跳过', () => {
  const w = normalizeWarning({ level: 'budget', usd: '1.2', outdated: 'nope' })
  assert.equal(w.usd, undefined)
  assert.equal(w.outdated, undefined)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/warningUi.test.ts`
Expected: FAIL（`normalizeWarning` 未定义 / ERR_MODULE_NOT_FOUND）。

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/warningUi.ts`：

```ts
// src/lib/warningUi.ts —— ponos_warning 帧归约纯函数
// 规则：被测模块零依赖——不 import zustand store、不使用 '@' alias、只 import type。
// 归约只做字段白名单；文案/图标在渲染层（SystemWarningStrip）做。
export interface KernelWarningFrame {
  type?: unknown
  level?: unknown
  message?: unknown
  usd?: unknown
  budgetUsd?: unknown
  outdated?: unknown
  agent?: unknown
}

export interface OutdatedSkill { id: string; lock: string; disk: string }

export interface KernelWarning {
  level: string
  ts: number
  message?: string
  usd?: number
  budgetUsd?: number
  outdated?: OutdatedSkill[]
  agent?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

export function normalizeWarning(frame: KernelWarningFrame | Record<string, unknown>): KernelWarning {
  const f = (frame ?? {}) as Record<string, unknown>
  const w: KernelWarning = { level: typeof f.level === 'string' && f.level ? f.level : 'unknown', ts: Date.now() }
  const message = str(f.message)
  if (message) w.message = message
  if (typeof f.usd === 'number' && Number.isFinite(f.usd)) w.usd = f.usd
  if (typeof f.budgetUsd === 'number' && Number.isFinite(f.budgetUsd)) w.budgetUsd = f.budgetUsd
  const agent = str(f.agent)
  if (agent) w.agent = agent
  if (Array.isArray(f.outdated)) {
    const arr = (f.outdated as unknown[])
      .map((o) => {
        const x = (o ?? {}) as Record<string, unknown>
        return { id: str(x.id) ?? '', lock: str(x.lock) ?? '', disk: str(x.disk) ?? '' }
      })
      .filter((o) => o.id)
    if (arr.length) w.outdated = arr
  }
  return w
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/lib/warningUi.test.ts`
Expected: PASS（4+ tests 全绿）。

- [ ] **Step 5: Create warningStore**

Create `src/stores/warningStore.ts`：

```ts
// src/stores/warningStore.ts —— 统一系统提示条状态
// warning 是内核进程生命周期事件（budget 每会话单次 crossing / skill_version 仅启动 /
// agent_spec 每 lane 至多一次），故不 persist；同 level 后到事件覆盖先到（set）。
// 新会话内核（system/init 且无旧 sessionId）reset（useYFWCLI init 分支消费）。
import { create } from 'zustand'
import type { KernelWarning } from '../lib/warningUi.ts'

interface WarningState {
  warningBySession: Record<string, KernelWarning>
  set: (sid: string, w: KernelWarning) => void
  dismiss: (sid: string) => void
  /** 新内核进程启动（会话重置）时清除该会话告警，防旧进程残留 */
  reset: (sid: string) => void
}

function withoutKey(rec: Record<string, KernelWarning>, sid: string): Record<string, KernelWarning> {
  if (!(sid in rec)) return rec
  const next = { ...rec }
  delete next[sid]
  return next
}

export const useWarningStore = create<WarningState>()((set) => ({
  warningBySession: {},
  set: (sid, w) => set((s) => ({ warningBySession: { ...s.warningBySession, [sid]: w } })),
  dismiss: (sid) => set((s) => ({ warningBySession: withoutKey(s.warningBySession, sid) })),
  reset: (sid) => set((s) => ({ warningBySession: withoutKey(s.warningBySession, sid) })),
}))
```

- [ ] **Step 6: Typecheck + Commit**

Run: `npm run typecheck`
Expected: 无 TS 错误。

```bash
git add src/lib/warningUi.ts src/lib/warningUi.test.ts src/stores/warningStore.ts
git commit -m "feat(gui-agentloop): warning 归约纯函数 + warningStore（budget/skill_version/agent_spec/context）——node 原生 TS 单测"
```

---

### Task 2: 统一系统提示条（wiring + SystemWarningStrip + ChatWindow 挂载 + i18n）

**Files:**
- Modify: `src/hooks/useYFWCLI.ts`（imports + event 分支 + init reset）
- Create: `src/components/chat/SystemWarningStrip.tsx`
- Modify: `src/components/chat/ChatWindow.tsx`（挂载）
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: Task 1 `normalizeWarning` + `useWarningStore`。
- Produces: `SystemWarningStrip({ conversationId })` 组件（Task 3-5 不依赖）。

- [ ] **Step 1: useYFWCLI wiring —— imports**

在 `src/hooks/useYFWCLI.ts` 顶部 import 区（第 16 行 `import { useHealthStore, type HealthInfo } from '@/stores/healthStore'` 之后）插入：

```ts
import { useWarningStore } from '@/stores/warningStore'
import { normalizeWarning } from '@/lib/warningUi'
```

- [ ] **Step 2: useYFWCLI wiring —— event 分支**

在 handleMessage 的 `msg.type === 'event'` 分发链中，紧随既有 `yfw_summary` 分支（`useHealthStore.getState().setSummary(...); return` 的闭合 `}` 之后、`command_lifecycle` 分支之前）插入：

```ts
    if (type === 'ponos_warning') {
      // agentloop P3 告警统一系统条：budget/skill_version/agent_spec（context 顺带覆盖）。
      // 按会话隔离；同 level 后到覆盖（内核侧各 level 已单次/低频，无刷屏路径）。
      useWarningStore.getState().set(sid, normalizeWarning(event as Record<string, unknown>))
      return
    }
```

- [ ] **Step 3: useYFWCLI wiring —— init 分支 reset**

在既有 `type === 'system' && event.subtype === 'init'` 分支内（现文本：

```ts
      const conv = store.conversations.find(c => c.id === sid)
      if (!conv?.sessionId) {
        useHealthStore.getState().reset(sid)
      }
```

改为在 `useHealthStore.getState().reset(sid)` 之后追加一行 `useWarningStore.getState().reset(sid)`（同一 `if` 体内；resume 同 transcript 不清，避免清掉先于 init 到达的 skill_version 启动告警）：

```ts
      const conv = store.conversations.find(c => c.id === sid)
      if (!conv?.sessionId) {
        useHealthStore.getState().reset(sid)
        useWarningStore.getState().reset(sid)
      }
```

- [ ] **Step 4: Create SystemWarningStrip**

Create `src/components/chat/SystemWarningStrip.tsx`：

```tsx
import { AlertTriangle, RefreshCcw, Bot, Info, X, type LucideIcon } from 'lucide-react'
import { useWarningStore } from '@/stores/warningStore'
import { useChatStore } from '@/stores/chatStore'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'

interface Props { conversationId: string }

// level → 样式/图标。Tailwind 类须全字面量（不可运行时拼 class 名），
// 未知 level 走 FALLBACK（context 级含 message，同样覆盖显示）。
const LEVEL_STYLE: Record<string, { text: string; border: string; icon: LucideIcon }> = {
  budget: { text: 'text-red-500', border: 'border-red-500/40', icon: AlertTriangle },
  skill_version: { text: 'text-amber-500', border: 'border-amber-500/40', icon: RefreshCcw },
  agent_spec: { text: 'text-amber-500', border: 'border-amber-500/40', icon: Bot },
}
const FALLBACK_STYLE = { text: 'text-amber-500', border: 'border-amber-500/40', icon: Info }

/**
 * 统一系统提示条（agentloop P3）：ponos_warning 事件（budget/skill_version/agent_spec，
 * 顺带 context）→ 会话级提示。挂载于 ChatWindow 顶部（KernelStallBar 之下、消息区之上），
 * 文档流元素：无告警不占位，有告警才占高度。
 * - budget：带「停止任务」按钮（双调 cancel 语义，同 KernelStallBar onCancel）；
 * - 其余 level：仅提示 + 关闭；未知 level 显示 message 原文或 level 名。
 * - 关闭 = dismiss（纯收 UI）；同 level 后到事件仍可再置。
 */
export function SystemWarningStrip({ conversationId }: Props) {
  const warning = useWarningStore(s => s.warningBySession[conversationId])
  const { stop } = useYFWCLI()
  const { t } = useTranslation()

  if (!warning) return null
  const meta = LEVEL_STYLE[warning.level] || FALLBACK_STYLE
  const Icon = meta.icon
  const showStop = warning.level === 'budget'

  let title: string
  if (warning.level === 'budget' && typeof warning.usd === 'number' && typeof warning.budgetUsd === 'number') {
    title = t('warnings.budget', { usd: warning.usd.toFixed(4), budgetUsd: warning.budgetUsd.toFixed(4) })
  } else if (warning.level === 'skill_version') {
    title = t('warnings.skillVersion', { n: warning.outdated?.length ?? 0 })
  } else if (warning.message) {
    title = warning.message
  } else {
    title = t('warnings.unknown', { level: warning.level })
  }

  const onStop = () => {
    useChatStore.getState().stopStreaming(conversationId)
    stop(conversationId)
  }
  const onClose = () => useWarningStore.getState().dismiss(conversationId)

  // skill_version 明细（id: lock → disk）合入 title 悬停；agent_spec message 本身可能是长句
  const detail = warning.level === 'skill_version' && warning.outdated
    ? warning.outdated.map(o => `${o.id}: ${o.lock} → ${o.disk}`).join('；')
    : undefined

  return (
    <div className="flex justify-center px-4 pt-3" role="status" aria-live="polite">
      <div className={`pointer-events-auto flex items-center gap-2 max-w-[900px] rounded-full border bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur ${meta.border}`}>
        <Icon className={`w-3.5 h-3.5 shrink-0 ${meta.text}`} />
        <span
          className={`text-[11px] font-semibold whitespace-nowrap ${meta.text}`}
          title={detail || title}
        >
          {title}
        </span>
        {showStop && (
          <>
            <span className="mx-0.5 w-px h-3.5 bg-border" aria-hidden />
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-red-500 hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition-colors whitespace-nowrap"
            >
              {t('warnings.stopTask')}
            </button>
          </>
        )}
        <button
          onClick={onClose}
          title={t('warnings.dismiss')}
          aria-label={t('warnings.dismiss')}
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-tertiary hover:text-secondary hover:bg-elevated border border-transparent hover:border-subtle transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: ChatWindow 挂载**

在 `src/components/chat/ChatWindow.tsx` 中：

- import 区新增：`import { SystemWarningStrip } from './SystemWarningStrip'`
- 顶部现文本 `<KernelStallBar conversationId={conversationId} />`（其后为 `<ScrollArea`）之间插入 `<SystemWarningStrip conversationId={conversationId} />`。

- [ ] **Step 6: i18n —— warnings 键组**

zh-CN.ts：在 `health:` 组之后、`kernelStall:` 组之前插入：

```ts
  // --- 统一系统提示条（agentloop P3 ponos_warning） ---
  warnings: {
    budget: '预算超支：累计 {usd} USD，超过限额 {budgetUsd} USD',
    skillVersion: '{n} 个技能与 skills.lock.json 版本不一致',
    stopTask: '停止任务',
    dismiss: '关闭',
    unknown: '{level} 系统告警',
  },
```

en-US.ts：同位置插入：

```ts
  warnings: {
    budget: 'Budget exceeded: {usd} USD used, limit {budgetUsd} USD',
    skillVersion: '{n} skills differ from skills.lock.json',
    stopTask: 'Stop task',
    dismiss: 'Dismiss',
    unknown: '{level} warning',
  },
```

- [ ] **Step 7: Typecheck + Commit**

Run: `npm run typecheck`
Expected: 无 TS 错误。

```bash
git add src/hooks/useYFWCLI.ts src/components/chat/SystemWarningStrip.tsx src/components/chat/ChatWindow.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(gui-agentloop): ponos_warning → 统一系统提示条（budget 带停止按钮/skill_version/agent_spec/context 兜底）——ChatWindow 顶部挂载 + init reset"
```

---

### Task 3: lane 压缩提示（laneUi 纯函数 + chatStore + wiring + Toast + i18n）

**Files:**
- Create: `src/lib/laneUi.ts`
- Test: `src/lib/laneUi.test.ts`
- Modify: `src/stores/chatStore.ts`（interface + defaults + actions）
- Modify: `src/hooks/useYFWCLI.ts`（imports + system/lane_compaction 分支）
- Create: `src/components/chat/LaneCompactionToast.tsx`
- Modify: `src/components/chat/ChatWindow.tsx`（挂载）
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: 内核 `system/lane_compaction` 帧 `{ taskId, text, compactCount }`（spec 附录 B）。
- Produces: `LaneNote`/`makeLaneNote`/`pushLaneNote`/`dismissLaneNote`；chatStore `laneNotesBySession` + `pushLaneNote(sid, note)` + `dismissLaneNote(sid)`。

- [ ] **Step 1: Write the failing test**

Create `src/lib/laneUi.test.ts`：

```ts
// src/lib/laneUi.test.ts
// node --test src/lib/laneUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLaneNote, pushLaneNote, dismissLaneNote } from './laneUi.ts'

function note(key: string, count = 1) {
  return makeLaneNote(key, `摘要 ${key}`, count)
}

test('makeLaneNote：key=taskId、ts 落当前时间', () => {
  const n = makeLaneNote('task-1', 'hello', 2)
  assert.equal(n.key, 'task-1')
  assert.equal(n.taskId, 'task-1')
  assert.equal(n.text, 'hello')
  assert.equal(n.compactCount, 2)
  assert.ok(typeof n.ts === 'number')
})

test('pushLaneNote：追加 + 同 taskId 覆盖且移到最后', () => {
  let list = pushLaneNote([], note('a'))
  list = pushLaneNote(list, note('b'))
  assert.deepEqual(list.map(n => n.key), ['a', 'b'])
  list = pushLaneNote(list, note('a', 2))
  assert.deepEqual(list.map(n => n.key), ['b', 'a'])
  assert.equal(list[1].compactCount, 2)
})

test('pushLaneNote：cap 3，超限丢最旧', () => {
  let list: ReturnType<typeof makeLaneNote>[] = []
  for (const k of ['a', 'b', 'c', 'd']) list = pushLaneNote(list, note(k))
  assert.deepEqual(list.map(n => n.key), ['b', 'c', 'd'])
})

test('dismissLaneNote：去头部；空表幂等', () => {
  assert.deepEqual(dismissLaneNote([]), [])
  const one = dismissLaneNote([note('a')])
  assert.deepEqual(one, [])
  const two = dismissLaneNote([note('a'), note('b')])
  assert.deepEqual(two.map(n => n.key), ['b'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/laneUi.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/laneUi.ts`：

```ts
// src/lib/laneUi.ts —— lane 压缩 toast 队列归约纯函数
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、只 import type。
export interface LaneNote {
  /** = taskId：同任务重复压缩覆盖计次而非追加行 */
  key: string
  taskId: string
  text: string
  compactCount: number
  ts: number
}

const CAP = 3

export function makeLaneNote(taskId: string, text: string, compactCount: number): LaneNote {
  return { key: taskId, taskId, text, compactCount, ts: Date.now() }
}

export function pushLaneNote(list: LaneNote[], note: LaneNote): LaneNote[] {
  const rest = list.filter((n) => n.key !== note.key)
  const next = [...rest, note]
  return next.length > CAP ? next.slice(next.length - CAP) : next
}

export function dismissLaneNote(list: LaneNote[]): LaneNote[] {
  return list.length ? list.slice(1) : list
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/lib/laneUi.test.ts`
Expected: PASS。

- [ ] **Step 5: chatStore 扩展**

在 `src/stores/chatStore.ts` 中：

5a. 顶部 import（在既有 `import type { Conversation, ... } from '@/types'` 行之后）新增：

```ts
import { pushLaneNote as pushLane, dismissLaneNote as dismissLane } from '@/lib/laneUi'
import type { LaneNote } from '@/lib/laneUi'
```

5b. `ChatState` interface（现文本 `subAgentTasks: Record<string, SubAgentTask[]>` 之后、`// Actions` 之前）新增字段：

```ts
  // 子任务压缩提示队列（agentloop lane_compaction）—— per-conversation, runtime-only (not persisted)
  laneNotesBySession: Record<string, LaneNote[]>
```

5c. `ChatState` interface Actions（现文本 `clearSubAgentTasks: (conversationId: string) => void` 之后、interface 闭合 `}` 之前）新增：

```ts
  pushLaneNote: (conversationId: string, note: LaneNote) => void
  dismissLaneNote: (conversationId: string) => void
```

5d. 默认值（现文本 `subAgentTasks: {},` 之后）新增：

```ts
      laneNotesBySession: {},
```

5e. 实现（现文本 `clearSubAgentTasks: (conversationId) => set(state => { ... }),` 之后、`}),`（create 回调闭合）之前）新增：

```ts
      pushLaneNote: (conversationId, note) => set(state => ({
        laneNotesBySession: {
          ...state.laneNotesBySession,
          [conversationId]: pushLane(state.laneNotesBySession[conversationId] || [], note),
        },
      })),

      dismissLaneNote: (conversationId) => set(state => {
        const list = state.laneNotesBySession[conversationId]
        if (!list || list.length === 0) return {}
        const next = dismissLane(list)
        if (next.length === 0) {
          const rest = { ...state.laneNotesBySession }
          delete rest[conversationId]
          return { laneNotesBySession: rest }
        }
        return { laneNotesBySession: { ...state.laneNotesBySession, [conversationId]: next } }
      }),
```

注意：不要改动 `clearSubAgentTasks`（lane 压缩 ≠ 任务结束）。检查该文件 persist `partialize` 白名单——laneNotesBySession 是 runtime-only，**不得**加入 partialize（默认不在其中，勿新增）。

- [ ] **Step 6: useYFWCLI wiring**

6a. import（Task 2 加的 `normalizeWarning` import 之后）新增：

```ts
import { makeLaneNote } from '@/lib/laneUi'
```

6b. handleMessage 的 `type === 'system'` subtype 分发链中，紧随既有 `compaction` subtype 分支闭合 `}` 之后（仍在 `if (type === 'system')` 体内、该 if 闭合前）插入：

```ts
      if (subtype === 'lane_compaction') {
        // agentloop lane 压缩可见化：子 Agent 会话达阈值完成摘要 → 队列尾部 push toast。
        // 帧 { taskId, text, compactCount }；同 taskId 覆盖（pushLaneNote cap 3）。
        const n = event as { taskId?: unknown; text?: unknown; compactCount?: unknown }
        useChatStore.getState().pushLaneNote(sid, makeLaneNote(String(n.taskId ?? ''), String(n.text ?? ''), Number(n.compactCount) || 0))
        return
      }
```

- [ ] **Step 7: Create LaneCompactionToast**

Create `src/components/chat/LaneCompactionToast.tsx`：

```tsx
import { useCallback, useEffect } from 'react'
import { Layers } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'

const VISIBLE_MS = 5000

interface Props { conversationId: string }

/**
 * 子任务压缩提示（agentloop lane_compaction）：右下角轻量胶囊，5s 自消。
 * 队列 laneNotesBySession[conversationId] 头部即当前展示；头部被 dismiss（超时/新 note
 * 顶替）即换下一条。与 CompressedToast（主压缩）错位：本条 bottom-14 在 CompressedToast
 * bottom-4 之上。非压缩期/无 note 不占位。
 */
export function LaneCompactionToast({ conversationId }: Props) {
  const note = useChatStore(s => s.laneNotesBySession[conversationId]?.[0])
  const { t } = useTranslation()
  const dismiss = useCallback(() => {
    useChatStore.getState().dismissLaneNote(conversationId)
  }, [conversationId])

  useEffect(() => {
    if (!note) return
    const timer = window.setTimeout(dismiss, VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [note?.key, dismiss, note])

  if (!note) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-14 right-4 z-50 pointer-events-none animate-slide-up"
    >
      <div
        className="flex items-center gap-2 max-w-[380px] rounded-xl border bg-popover/95 px-3 py-2 shadow-2xl backdrop-blur-xl"
        style={{ borderColor: 'color-mix(in srgb, var(--brand-500) 28%, transparent)' }}
      >
        <Layers className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--brand-500)' }} />
        <span className="text-[11px] font-semibold text-primary whitespace-nowrap">
          {t('laneCompact.title', { n: note.compactCount })}
        </span>
        <span className="text-[11px] text-tertiary truncate min-w-0" title={note.text}>
          {note.text}
        </span>
      </div>
    </div>
  )
}
```

- [ ] **Step 8: ChatWindow 挂载**

在 `src/components/chat/ChatWindow.tsx`：import 区新增 `import { LaneCompactionToast } from './LaneCompactionToast'`；在既有 `<CompressedToast conversationId={conversationId} />` 行之后插入 `<LaneCompactionToast conversationId={conversationId} />`（同在末尾 `</div>` 之前）。

- [ ] **Step 9: i18n —— laneCompact 键组**

zh-CN.ts：在 `compacting:` 组之后插入：

```ts
  // --- 子任务压缩提示（agentloop lane_compaction） ---
  laneCompact: {
    title: '子任务压缩 · 第 {n} 次',
  },
```

en-US.ts：同位置插入：

```ts
  laneCompact: {
    title: 'Subtask compacted · round {n}',
  },
```

- [ ] **Step 10: Typecheck + Commit**

Run: `npm run typecheck`
Expected: 无 TS 错误（注意 chatStore 已有用例集合——若本机可跑 `npm run typecheck` 通过即可）。

```bash
git add src/lib/laneUi.ts src/lib/laneUi.test.ts src/stores/chatStore.ts src/hooks/useYFWCLI.ts src/components/chat/LaneCompactionToast.tsx src/components/chat/ChatWindow.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(gui-agentloop): lane_compaction → 子任务压缩 toast——laneUi 纯函数 + chatStore 队列 + system 分支 + Toast（cap 3 / 5s 自消）"
```

---

### Task 4: usage/audit 展示纯函数 + 单测

**Files:**
- Create: `src/lib/usageUi.ts`
- Test: `src/lib/usageUi.test.ts`

**Interfaces:**
- Consumes: spec 附录 C/D 的 `/api/usage` 响应对象与 `/api/audit` 行数组（字段全 unknown/可能缺键）。
- Produces: `UsageReport`/`AuditRow`/`TotalsView` 类型、`fmtTokens`/`fmtUsd`/`fmtSession`/`projectOptions`/`auditView`/`usageTotalsView`/`buildUsageQuery`（Task 5 消费）。

- [ ] **Step 1: Write the failing test**

Create `src/lib/usageUi.test.ts`：

```ts
// src/lib/usageUi.test.ts
// node --test src/lib/usageUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtTokens, fmtUsd, fmtSession, projectOptions, auditView, usageTotalsView, buildUsageQuery } from './usageUi.ts'

test('fmtTokens：千分位/k/M 阈值', () => {
  assert.equal(fmtTokens(12345), '12.3k')
  assert.equal(fmtTokens(1500000), '1.5M')
  assert.equal(fmtTokens(2000000), '2M')
  assert.equal(fmtTokens(1234), '1.2k')
  assert.equal(fmtTokens(999), '999')
  assert.equal(fmtTokens(10000), '10k')
})

test('fmtUsd：四位小数', () => {
  assert.equal(fmtUsd(1.23456789), '1.2346')
  assert.equal(fmtUsd(0), '0.0000')
})

test('fmtSession：>10 位取前 8 + …', () => {
  assert.equal(fmtSession('0123456789abcdef'), '01234567…')
  assert.equal(fmtSession('short'), 'short')
})

test('projectOptions：按名称排序', () => {
  assert.deepEqual(projectOptions({ byProject: { b: { input_tokens: 1 }, a: { input_tokens: 2 } } as any }), ['a', 'b'])
  assert.deepEqual(projectOptions(null), [])
})

test('auditView：ts desc、同 ts seq desc、cap 截断', () => {
  const rows = [
    { ts: '2026-09-08T01:00:00.000Z', seq: 1, session: 's', type: 'tool_use' as const, tool: 'Read' },
    { ts: '2026-09-08T01:00:00.000Z', seq: 2, session: 's', type: 'tool_result' as const },
    { ts: '2026-09-07T01:00:00.000Z', seq: 1, session: 's', type: 'tool_use' as const, tool: 'Grep' },
  ]
  const out = auditView(rows, 10)
  assert.deepEqual(out.map(r => r.seq), [2, 1, 1])
  assert.equal(auditView(rows, 2).length, 2)
})

test('usageTotalsView：缺键兜底 0/[] + 排序', () => {
  const v = usageTotalsView(null)
  assert.equal(v.input, 0)
  assert.equal(v.costUsd, 0)
  assert.deepEqual(v.models, [])
  assert.deepEqual(v.tools, [])
  const full = usageTotalsView({
    totals: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, turns: 3 },
    cacheRate: 0.1234, costUsd: 1.5, budgetUsd: 1, overBudget: true,
    byModel: { m2: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 1 }, m1: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 2 } },
    byModelCostUsd: { m2: 0.9, m1: 0.6 },
    byTool: { Grep: 3, Read: 5 },
    byProject: { p1: { input_tokens: 1 } },
    byDate: {}, byProjectDummy: 0,
  } as any)
  assert.equal(full.input, 100)
  assert.equal(full.cacheRatePct, 12.3)
  assert.equal(full.overBudget, true)
  assert.deepEqual(full.models.map(m => m.name), ['m2', 'm1']) // costUsd desc
  assert.deepEqual(full.tools.map(x => x.name), ['Read', 'Grep']) // count desc
  assert.deepEqual(full.projects, ['p1'])
})

test('buildUsageQuery：非空参数 URL 编码、空参返回空串', () => {
  assert.equal(buildUsageQuery({}), '')
  assert.equal(buildUsageQuery({ project: 'a b' }), '?project=a%20b')
  assert.equal(buildUsageQuery({ project: 'p', scope: 'session' }), '?project=p&scope=session')
})
```

注意：`usageTotalsView(null)` 的 TS 参数类型是 `Partial<UsageReport> | null`——null 需断言或放宽；若 TS 报 `null` 不可赋给（泛型为 `Partial<UsageReport> | null` 时可赋），照上述签名写即可。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/usageUi.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/usageUi.ts`：

```ts
// src/lib/usageUi.ts —— 用量/审计展示纯函数
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、只 import type。
// fetch 包装在 usageApi.ts（引 getBridgeUrl，Vite alias 域，node 不直测）。
export interface UsageTotals {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  turns: number
}

export interface UsageReport {
  totals: UsageTotals
  byModel: Record<string, UsageTotals>
  byProject: Record<string, UsageTotals>
  byDate: Record<string, UsageTotals>
  byTool: Record<string, number>
  cacheRate: number
  costUsd: number
  byModelCostUsd: Record<string, number>
  budgetUsd: number
  overBudget: boolean
}

export interface AuditRow {
  ts: string
  seq: number
  session: string
  type: 'tool_use' | 'tool_result'
  tool?: string
  params?: string
  toolUseId?: string
  summary?: string
}

export interface ModelCostRow { name: string; costUsd: number; turns: number }
export interface ToolCountRow { name: string; count: number }

export interface TotalsView {
  input: number
  output: number
  cacheRead: number
  /** 缓存率百分数（0-100，1 位小数） */
  cacheRatePct: number
  turns: number
  costUsd: number
  budgetUsd: number
  overBudget: boolean
  models: ModelCostRow[]
  projects: string[]
  tools: ToolCountRow[]
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function bucket(b: unknown): UsageTotals {
  const x = (b ?? {}) as Record<string, unknown>
  return {
    input_tokens: num(x.input_tokens),
    output_tokens: num(x.output_tokens),
    cache_read_input_tokens: num(x.cache_read_input_tokens),
    cache_creation_input_tokens: num(x.cache_creation_input_tokens),
    turns: num(x.turns),
  }
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

export function fmtTokens(n: number): string {
  const v = num(n)
  if (v >= 1e6) return `${trimZero((v / 1e6).toFixed(1))}M`
  if (v >= 1e3) return `${trimZero((v / 1e3).toFixed(1))}k`
  return v.toLocaleString('en-US')
}

export function fmtUsd(n: number): string {
  return num(n).toFixed(4)
}

export function fmtSession(sid: string): string {
  const s = String(sid ?? '')
  return s.length > 10 ? `${s.slice(0, 8)}…` : s
}

export function projectOptions(report: Partial<UsageReport> | null): string[] {
  const by = report?.byProject
  if (!by || typeof by !== 'object') return []
  return Object.keys(by).sort((a, b) => a.localeCompare(b))
}

export function auditView(rows: AuditRow[], cap = 200): AuditRow[] {
  return [...rows]
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.seq - a.seq)
    .slice(0, Math.max(1, cap))
}

export function usageTotalsView(report: Partial<UsageReport> | null): TotalsView {
  const t = bucket(report?.totals)
  const models: ModelCostRow[] = Object.entries(report?.byModel ?? {}).map(([name, b]) => {
    const bb = bucket(b)
    return { name, costUsd: num(report?.byModelCostUsd?.[name]), turns: bb.turns }
  }).sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns)
  const tools: ToolCountRow[] = Object.entries(report?.byTool ?? {})
    .map(([name, count]) => ({ name, count: num(count) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return {
    input: t.input_tokens,
    output: t.output_tokens,
    cacheRead: t.cache_read_input_tokens,
    cacheRatePct: Math.round(num(report?.cacheRate) * 1000) / 10,
    turns: t.turns,
    costUsd: num(report?.costUsd),
    budgetUsd: num(report?.budgetUsd),
    overBudget: report?.overBudget === true,
    models,
    projects: projectOptions(report),
    tools,
  }
}

export function buildUsageQuery(q: { project?: string; sessionId?: string; scope?: string }): string {
  const parts: string[] = []
  for (const k of ['project', 'sessionId', 'scope'] as const) {
    const v = q[k]
    if (v) parts.push(`${k}=${encodeURIComponent(v)}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/lib/usageUi.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/usageUi.ts src/lib/usageUi.test.ts
git commit -m "feat(gui-agentloop): usage/audit 展示纯函数——fmtTokens/auditView/usageTotalsView/buildUsageQuery + node 单测"
```

---

### Task 5: 用量 HTTP 拉取 + 侧栏「用量」视图（UsagePanel/Sidebar/uiStore/i18n）

**Files:**
- Create: `src/lib/usageApi.ts`
- Create: `src/components/usage/UsagePanel.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/stores/uiStore.ts`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: Task 4 `usageUi` 全部导出（fetch 层在此用）；bridge `GET /api/usage`、`GET /api/audit`（`getBridgeUrl()`，query: project/sessionId/scope）。
- Produces: `UsagePanel`（Sidebar 挂载）；无对外接口。

- [ ] **Step 1: Create usageApi.ts**

Create `src/lib/usageApi.ts`：

```ts
// src/lib/usageApi.ts —— bridge 用量/审计 HTTP 拉取（沿 fetchSkills 先例：5s 短超时）
// 引 '@' alias + DOM fetch，node 不直测（纯逻辑在 usageUi.ts 已测）。
import { getBridgeUrl } from '@/lib/config'
import { buildUsageQuery } from '@/lib/usageUi'
import type { UsageReport, AuditRow } from '@/lib/usageUi'

const FETCH_TIMEOUT_MS = 5000

export interface UsageQuery {
  project?: string
  sessionId?: string
  scope?: string
}

async function getJson<T>(path: 'usage' | 'audit', q: UsageQuery): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(`${getBridgeUrl()}/api/${path}${buildUsageQuery(q)}`, { signal: controller.signal })
    if (!r.ok) {
      let msg = `HTTP ${r.status}`
      try {
        const j = await r.json() as { error?: unknown }
        if (typeof j?.error === 'string' && j.error) msg = j.error
      } catch { /* body 非 JSON，保留 HTTP 状态文案 */ }
      throw new Error(msg)
    }
    return (await r.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export function fetchUsage(q: UsageQuery = {}): Promise<UsageReport> {
  return getJson<UsageReport>('usage', q)
}

export function fetchAudit(q: UsageQuery = {}): Promise<AuditRow[]> {
  return getJson<AuditRow[]>('audit', q)
}
```

- [ ] **Step 2: Create UsagePanel.tsx**

Create `src/components/usage/UsagePanel.tsx`（新目录；侧栏 340px 窄栏适配，数值右对齐、标签截断；整页纵向分区，审计列表区自滚）：

```tsx
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Gauge, RefreshCw, ArrowUp, Check, Search, Loader2, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { fetchUsage, fetchAudit } from '@/lib/usageApi'
import { usageTotalsView, auditView, fmtTokens, fmtUsd, fmtSession } from '@/lib/usageUi'
import type { UsageReport, AuditRow } from '@/lib/usageUi'

type Seg = 'usage' | 'audit'

/** 侧栏「用量」视图：用量摘要 + 审计明细（spec D3）。项目过滤 = 点按摘要段按项目表行 / 审计段下拉。 */
export function UsagePanel() {
  const { t } = useTranslation()
  const [seg, setSeg] = useState<Seg>('usage')
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  const loadUsage = useCallback(() => {
    let on = true
    setLoading(true)
    setError('')
    fetchUsage(project ? { project } : {})
      .then((u) => { if (on) setUsage(u) })
      .catch((e: Error) => { if (on) setError(e?.message || t('usage.error')) })
      .finally(() => { if (on) setLoading(false) })
    return () => { on = false }
  }, [project])

  const loadAudit = useCallback(() => {
    let on = true
    setLoading(true)
    setError('')
    fetchAudit(project ? { project } : {})
      .then((a) => { if (on) setRows(a) })
      .catch((e: Error) => { if (on) setError(e?.message || t('usage.error')) })
      .finally(() => { if (on) setLoading(false) })
    return () => { on = false }
  }, [project])

  // 用量：挂载 / project 变化 / 手动刷新
  useEffect(() => loadUsage(), [loadUsage, tick])
  // 审计：切到审计段时按需拉取（同样跟随 project / 刷新）
  useEffect(() => {
    if (seg !== 'audit') return
    return loadAudit()
  }, [seg, loadAudit, tick])

  const refresh = () => setTick((x) => x + 1)
  const view = usageTotalsView(usage)
  const emptyUsage = !!usage && view.turns === 0 && view.models.length === 0 && view.tools.length === 0 && view.projects.length === 0
  const shownRows = seg === 'audit' && rows
    ? auditView(rows).filter((r) => {
        if (!query.trim()) return true
        const q = query.trim().toLowerCase()
        return [r.tool, r.params, r.summary, r.session, r.type].some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
      })
    : []

  const segBtn = (id: Seg, label: string) => (
    <button
      onClick={() => setSeg(id)}
      className={cn(
        'flex-1 h-7 rounded-md text-[11px] font-medium transition-colors',
        seg === id ? 'bg-elevated text-primary' : 'text-tertiary hover:text-secondary'
      )}
    >
      {label}
    </button>
  )

  const StatRow = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-[11px] text-tertiary truncate">{label}</span>
      <span className={cn('text-[11px] font-medium tabular-nums shrink-0', strong ? 'text-red-500' : 'text-secondary')}>{value}</span>
    </div>
  )

  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="border-t border-border/60 pt-2 mt-2 first:border-t-0 first:pt-0 first:mt-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-tertiary mb-1">{title}</p>
      <div className="space-y-px">{children}</div>
    </div>
  )

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Gauge className="w-3.5 h-3.5 text-brand-500/80 shrink-0" />
        <div className="flex-1 flex rounded-md bg-elevated/60 p-0.5">
          {segBtn('usage', t('usage.segmentUsage'))}
          {segBtn('audit', t('usage.segmentAudit'))}
        </div>
        <button
          onClick={refresh}
          title={t('usage.refresh')}
          aria-label={t('usage.refresh')}
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-tertiary hover:text-secondary hover:bg-elevated transition-colors"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
          <AlertCircle className="w-5 h-5 text-red-500/80" />
          <p className="text-[11px] text-tertiary break-all">{error}</p>
          <button onClick={refresh} className="text-[11px] text-primary underline">{t('common.retry')}</button>
        </div>
      ) : seg === 'usage' ? (
        <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2">
          {!usage ? (
            <div className="h-full flex items-center justify-center"><Loader2 className="w-4 h-4 text-tertiary animate-spin" /></div>
          ) : emptyUsage ? (
            <p className="text-center text-[11px] text-tertiary py-6">{t('usage.noData')}</p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-1.5">
                <div className="rounded-lg border border-subtle bg-elevated/40 px-2.5 py-2">
                  <StatRow label={t('usage.cost')} value={`$${fmtUsd(view.costUsd)}`} strong={view.overBudget} />
                  {view.budgetUsd > 0 && <StatRow label={t('usage.budget')} value={`$${fmtUsd(view.budgetUsd)}`} />}
                </div>
                <div className="rounded-lg border border-subtle bg-elevated/40 px-2.5 py-2">
                  <StatRow label={t('usage.inputTokens')} value={fmtTokens(view.input)} />
                  <StatRow label={t('usage.outputTokens')} value={fmtTokens(view.output)} />
                </div>
                <div className="rounded-lg border border-subtle bg-elevated/40 px-2.5 py-2">
                  <StatRow label={t('usage.cacheRead')} value={fmtTokens(view.cacheRead)} />
                  <StatRow label={t('usage.cacheRate')} value={`${view.cacheRatePct.toFixed(1)}%`} />
                </div>
                <div className="rounded-lg border border-subtle bg-elevated/40 px-2.5 py-2">
                  <StatRow label={t('usage.turns')} value={String(view.turns)} />
                </div>
              </div>

              {view.models.length > 0 && (
                <Section title={t('usage.byModel')}>
                  {view.models.map((m) => (
                    <StatRow key={m.name} label={m.name} value={`$${fmtUsd(m.costUsd)} · ${m.turns} ${t('usage.turns')}`} />
                  ))}
                </Section>
              )}

              {view.projects.length > 0 && (
                <Section title={t('usage.byProject')}>
                  {view.projects.map((p) => (
                    <button
                      key={p}
                      onClick={() => setProject(project === p ? '' : p)}
                      className={cn(
                        'w-full flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left transition-colors',
                        project === p ? 'bg-elevated' : 'hover:bg-elevated/60'
                      )}
                    >
                      <span className="text-[11px] text-secondary truncate">{p}</span>
                      <span className="text-[11px] text-tertiary shrink-0 tabular-nums">
                        {fmtTokens(usage!.byProject[p]?.input_tokens ?? 0)}
                      </span>
                    </button>
                  ))}
                </Section>
              )}

              {view.tools.length > 0 && (
                <Section title={t('usage.byTool')}>
                  {view.tools.map((x) => (
                    <StatRow key={x.name} label={x.name} value={String(x.count)} />
                  ))}
                </Section>
              )}

            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Audit filters */}
          <div className="px-3 pt-2 flex items-center gap-1.5">
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="h-6 flex-1 min-w-0 bg-elevated border border rounded-md px-1.5 text-[11px] text-primary outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">{t('usage.allProjects')}</option>
              {view.projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-tertiary" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="…"
                className="w-full h-6 bg-elevated border border rounded-md pl-6 pr-1.5 text-[11px] text-primary placeholder:text-tertiary outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2">
            {!rows ? (
              <div className="h-full flex items-center justify-center"><Loader2 className="w-4 h-4 text-tertiary animate-spin" /></div>
            ) : shownRows.length === 0 ? (
              <p className="text-center text-[11px] text-tertiary py-6">{t('usage.emptyAudit')}</p>
            ) : (
              <ul className="space-y-1">
                {shownRows.map((r, i) => (
                  <li key={`${r.ts}-${r.seq}-${i}`} className="rounded-md border border-subtle bg-elevated/30 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {r.type === 'tool_use'
                        ? <ArrowUp className="w-3 h-3 text-brand-500/80 shrink-0" />
                        : <Check className="w-3 h-3 text-emerald-500/80 shrink-0" />}
                      <span className="text-[11px] font-medium text-secondary truncate">
                        {r.type === 'tool_use' ? r.tool : 'tool_result'}
                      </span>
                      <span className="ml-auto text-[10px] text-tertiary shrink-0 tabular-nums">
                        {fmtSession(r.session)} · {fmtTime(r.ts)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-tertiary truncate leading-relaxed" title={r.type === 'tool_use' ? r.params : r.summary}>
                      {r.type === 'tool_use' ? r.params : r.summary}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function fmtTime(ts: string): string {
  const s = String(ts ?? '')
  // 'YYYY-MM-DDTHH:mm:ss…' → 'MM-DD HH:mm'
  return s.length >= 16 ? `${s.slice(5, 10)} ${s.slice(11, 16)}` : s
}
```

注：`usage.refresh` 键按 i18n 表补入（作刷新按钮 title）；重试文案用既有 `common.retry`。`emptyUsage` = 有响应但全部计数为 0（无 usage 条目）→ 显示 `usage.noData` 空态。

- [ ] **Step 3: uiStore —— sidebarTab 联合加 'usage'**

`src/stores/uiStore.ts` 两处：
- `sidebarTab: 'chats' | 'history' | 'files' | 'agents' | 'worktrees' | 'skills'` → 末尾加 `| 'usage'`
- `setSidebarTab: (tab: 'chats' | 'history' | 'files' | 'agents' | 'worktrees' | 'skills') => void` → 签名同步加 `| 'usage'`

- [ ] **Step 4: Sidebar —— TABS + panel 挂载**

`src/components/layout/Sidebar.tsx`：
- lucide import（`MessageSquare, History, FolderTree, Bot, ...` 行）加 `Gauge`。
- `TABS` 数组（现含 chats/files/worktrees/history/agents/skills 六项，`as const`）末尾加：

```ts
  { id: 'usage' as const, icon: Gauge, labelKey: 'sidebar.usage' },
```

- panels 区（现文本 `{sidebarTab === 'skills' && <SkillsPanel />}` 之后）追加：

```tsx
        {sidebarTab === 'usage' && <UsagePanel />}
```

- import 区加：`import { UsagePanel } from '@/components/usage/UsagePanel'`

- [ ] **Step 5: i18n —— usage 键组 + sidebar.usage**

zh-CN.ts `sidebar` 组内（`skills: '技能',` 行后）加 `usage: '用量',`；在 `laneCompact` 组后插入：

```ts
  // --- 用量 / 审计（侧栏视图） ---
  usage: {
    segmentUsage: '用量摘要',
    segmentAudit: '审计明细',
    inputTokens: '输入',
    outputTokens: '输出',
    cacheRead: '缓存读',
    cacheRate: '缓存率',
    turns: '轮数',
    cost: '成本',
    budget: '预算',
    byModel: '按模型',
    byProject: '按项目',
    byTool: '按工具',
    allProjects: '全部项目',
    noData: '暂无用量数据',
    emptyAudit: '暂无审计明细',
    error: '加载失败',
    refresh: '刷新',
  },
```

en-US.ts `sidebar` 组内（`skills: 'Skills',` 行后）加 `usage: 'Usage',`；同位置插入：

```ts
  usage: {
    segmentUsage: 'Usage',
    segmentAudit: 'Audit',
    inputTokens: 'Input',
    outputTokens: 'Output',
    cacheRead: 'Cache read',
    cacheRate: 'Cache rate',
    turns: 'Turns',
    cost: 'Cost',
    budget: 'Budget',
    byModel: 'By model',
    byProject: 'By project',
    byTool: 'By tool',
    allProjects: 'All projects',
    noData: 'No usage data',
    emptyAudit: 'No audit rows',
    error: 'Load failed',
    refresh: 'Refresh',
  },
```

- [ ] **Step 6: Typecheck + Commit**

Run: `npm run typecheck`
Expected: 无 TS 错误。

```bash
git add src/lib/usageApi.ts src/components/usage/UsagePanel.tsx src/components/layout/Sidebar.tsx src/stores/uiStore.ts src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(gui-agentloop): 侧栏「用量」视图——usageApi 拉取 + UsagePanel（用量摘要/审计明细、项目过滤、本地搜索）"
```

---

## 验收门槛（全部 Task 完成后，控制器执行）

- 三个纯函数测试全绿：`node --test src/lib/warningUi.test.ts src/lib/laneUi.test.ts src/lib/usageUi.test.ts`
- `npm run typecheck` 无错；`npm run build` 通过；`npm test`（server/electron 150 项）保持全绿（本适配未改后端，须零回归）。
- 前端 lib 测试不引入 vitest/新依赖（package.json 无变化）。
- **manual（设备上，用户/控制器授权后执行）**：
  - budget 条：GUI 打开会话所在内核以 `PONOS_BUDGET_USD` 小预算运行 → 累计跨阈后输入框上方出现红色胶囊「预算超支…」，带「停止任务」按钮，点按即停止当前轮。
  - skill_version：会话内核 configDir 放 version 不一致的 `skills.lock.json` → 启动后 amber 胶囊提示 N 个技能不一致。
  - lane 压缩：resume 长子任务（lane）达压缩阈值 → 右下角出现「子任务压缩 · 第 N 次」toast，5s 自消。
  - 用量视图：侧栏末端「用量」tab 可开；用量摘要/审计明细渲染后端聚合 JSON；项目过滤与本地搜索生效；无数据态显示空态文案。
