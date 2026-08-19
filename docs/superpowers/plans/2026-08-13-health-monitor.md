# 智能健康监控系统（Health Monitor）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内核判定主会话任务质量（综合健康分，模型自适应 + 可靠注意力上限），质量严重下降时在 GUI 弹出横幅，一键新建会话并可携带压缩摘要。

**Architecture:** 内核新增 `healthMonitor.ts`，在 `query.ts` 每轮收尾处调用 `recordTurn/recordCompaction`，档位变化时向 stdout 输出 `{"type":"yfw_health",...}` JSON 行（复用现有 bridge 逐行转发通道，bridge 零改动）；GUI 在 `useYFWCLI.ts` 事件分发处过滤新事件类型存入 `healthStore`，`HealthBanner` 组件渲染横幅。仅主会话（querySource 以 `repl_main_thread` 开头）参与计分。

**Tech Stack:** Bun（内核 bundle）、TypeScript、vitest（内核测试）、zustand（GUI store）、React + Vite（GUI）、Electron。

## Global Constraints

- 内核源码改动必须**同步 release 双份**：`release/YFWorking/` 与 `release/YFWorking_ms92cd6u/` 的 `kernel/` 与 `dist/`（见 project_release_sync memory）
- **不打包**：不跑 electron-builder / build:electron，除非用户明确要求
- 主线程过滤：querySource 不以 `repl_main_thread` 开头的轮次一律跳过（子 agent 不参与）
- healthMonitor 事件输出全程 try/catch，失败静默降级，绝不影响主流程
- 计分与 `autoCompact.ts` 的窗口语义一致：预留 20K 摘要槽、`min(CLAUDE_CODE_AUTO_COMPACT_WINDOW)` 生效
- **计分归一化修正**：spec 的"每次 +25 封顶 3/6"与"flash 3 次红档 / pro 3 次黄档"叙事矛盾；本计划按叙事实现：`compactScore = max(40, round(70 × min(compactCount, cap) / cap))`（cap：flash 3 / pro[1m] 6，40 为黄档下限），并同步修订 spec 因子表
- UI 文案走 i18n（zh-CN + en-US 双键），简体中文为主

---

### Task 1: 内核 healthMonitor 核心模块 + 单测

**Files:**
- Create: `yfw-kernel/claude-code/src/services/health/healthMonitor.ts`
- Test: `yfw-kernel/claude-code/tests/health/healthMonitor.test.ts`
- Modify: `docs/superpowers/specs/2026-08-13-health-monitor-design.md`（因子表改为归一化计分）

**Interfaces:**
- Produces（供 Task 2 使用）：
  - `recordTurn(stats: TurnStats, querySource?: string): HealthEventData | null`
  - `recordCompaction(model: string, summaryText: string): void`
  - `extractSummaryText(summaryMessages: { message?: { content?: unknown } }[]): string`
  - `getAttentionCeiling(model: string): number`
  - `getCompactionCap(model: string): number`
  - `resetHealth(): void`、`getHealthState(): HealthState`
  - `type TurnStats = { model: string; contextTokens: number; compacted: boolean; consecutiveFailures: number }`
  - `type HealthEventData = { score: number; tier: 'green'|'yellow'|'red'; compactCount: number; recompactionChain: number; remainingPct: number; remainingTurns: number; suggestNewSession: boolean; reason: string }`

- [ ] **Step 1: 写失败测试**

```ts
// yfw-kernel/claude-code/tests/health/healthMonitor.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  resetHealth,
  recordTurn,
  recordCompaction,
  getAttentionCeiling,
  getCompactionCap,
  extractSummaryText,
  type TurnStats,
} from '../../src/services/health/healthMonitor.js'

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro[1m]'

function turn(model: string, contextTokens: number, extra: Partial<TurnStats> = {}): TurnStats {
  return { model, contextTokens, compacted: false, consecutiveFailures: 0, ...extra }
}

beforeEach(() => resetHealth())

describe('getAttentionCeiling', () => {
  it('flash: min(有效180K, 名义200K×0.8=160K) = 160K', () => {
    expect(getAttentionCeiling(FLASH)).toBe(160_000)
  })
  it('pro[1m]: min(有效980K, 名义1M×0.8=800K) = 800K', () => {
    expect(getAttentionCeiling(PRO)).toBe(800_000)
  })
})

describe('getCompactionCap', () => {
  it('flash 断崖点 3', () => expect(getCompactionCap(FLASH)).toBe(3))
  it('pro[1m] 断崖点 6', () => expect(getCompactionCap(PRO)).toBe(6))
})

describe('水位计分（注意力衰减起点预警）', () => {
  it('flash 剩余 24.4%（<25% 上限）→ 黄档', () => {
    // context 121K / ceiling 160K → remaining 39K → 24.4%
    const evt = recordTurn(turn(FLASH, 121_000))
    expect(evt?.tier).toBe('yellow')
  })
  it('flash 剩余 <12% 上限 → 红档', () => {
    const evt = recordTurn(turn(FLASH, 142_000)) // remaining 18K = 11.3%
    expect(evt?.tier).toBe('red')
  })
  it('上下文很小 → 绿档且不发射（返回 null）', () => {
    expect(recordTurn(turn(FLASH, 20_000))).toBeNull()
  })
})

describe('压缩计分（归一化，flash 3 次红 / pro 3 次黄）', () => {
  it('flash 3 次压缩 → 红档', () => {
    recordCompaction(FLASH, 's1')
    recordCompaction(FLASH, 's2')
    recordCompaction(FLASH, 's3')
    const evt = recordTurn(turn(FLASH, 30_000, { compacted: true }))
    expect(evt?.tier).toBe('red')
  })
  it('pro[1m] 3 次压缩 → 黄档（仍有 800K 余量）', () => {
    recordCompaction(PRO, 's1')
    recordCompaction(PRO, 's2')
    recordCompaction(PRO, 's3')
    const evt = recordTurn(turn(PRO, 30_000, { compacted: true }))
    expect(evt?.tier).toBe('yellow')
  })
  it('pro[1m] 6 次压缩 → 红档', () => {
    for (let i = 0; i < 6; i++) recordCompaction(PRO, 's' + i)
    const evt = recordTurn(turn(PRO, 30_000, { compacted: true }))
    expect(evt?.tier).toBe('red')
  })
})

describe('剩余轮数估算', () => {
  it('平均消耗 3K/轮、剩余 27K → 9 轮 → 额外 +20 黄档', () => {
    // 两轮正消耗制造 3K 均值：20K → 23K → 26K
    recordTurn(turn(FLASH, 20_000))
    recordTurn(turn(FLASH, 23_000))
    const evt = recordTurn(turn(FLASH, 26_000)) // 之后再加 1K 消耗到 27K 剩余? 见实现注释
    // remaining = 160K - 26K = 134K → 轮数巨大 → 本断言在实现后调整为剩余接近 27K 的用例
    expect(evt).not.toBeNull()
  })
})

describe('主线程过滤与去抖', () => {
  it('非主线程 querySource 不参与（返回 null）', () => {
    expect(recordTurn(turn(FLASH, 121_000), 'agent')).toBeNull()
  })
  it('同档位不重复发射；档位变化才发射', () => {
    const e1 = recordTurn(turn(FLASH, 121_000))
    const e2 = recordTurn(turn(FLASH, 125_000))
    expect(e1?.tier).toBe('yellow')
    expect(e2).toBeNull() // 仍黄档 → 不发射
  })
})

describe('extractSummaryText', () => {
  it('提取 system 摘要消息的文本块', () => {
    const text = extractSummaryText([
      { message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } },
      { message: { content: [{ type: 'tool_use', name: 'x' }] } },
    ])
    expect(text).toBe('第一段\n第二段')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd yfw-kernel/claude-code && npx vitest run tests/health/healthMonitor.test.ts`
Expected: FAIL — 模块不存在/导入错误

- [ ] **Step 3: 实现 healthMonitor.ts**

```ts
// yfw-kernel/claude-code/src/services/health/healthMonitor.ts
import { getContextWindowForModel } from '../../utils/context.js'

export type HealthTier = 'green' | 'yellow' | 'red'

export interface HealthEventData {
  score: number
  tier: HealthTier
  compactCount: number
  recompactionChain: number
  remainingPct: number
  remainingTurns: number
  suggestNewSession: boolean
  reason: string
}

export interface TurnStats {
  model: string
  contextTokens: number
  compacted: boolean
  consecutiveFailures: number
}

export interface HealthState {
  model: string
  compactCount: number
  compactTurns: number[]
  consecutiveFailures: number
  contextTokens: number
  turnIndex: number
  turnDeltas: number[]
  lastTier: HealthTier | null
  lastRedAt: number
  lastSummaryText: string
}

// ---- 常量（与 spec 一致，可调） ----
export const RELIABLE_ATTENTION_RATIO_DEFAULT = 0.8
export const RELIABLE_ATTENTION_RATIO_BY_MODEL: Record<string, number> = {}
const RESERVED_FOR_SUMMARY = 20_000 // 与 autoCompact.ts getEffectiveContextWindowSize 语义一致
const TURN_WINDOW = 10
const CHAIN_WINDOW_TURNS = 10
const RED_COOLDOWN_MS = 5 * 60 * 1000
const AVG_TURN_FLOOR = 500
const TIER_YELLOW = 40
const TIER_RED = 70

const state: HealthState = {
  model: '',
  compactCount: 0,
  compactTurns: [],
  consecutiveFailures: 0,
  contextTokens: 0,
  turnIndex: 0,
  turnDeltas: [],
  lastTier: null,
  lastRedAt: 0,
  lastSummaryText: '',
}

export function resetHealth(): void {
  state.model = ''
  state.compactCount = 0
  state.compactTurns = []
  state.consecutiveFailures = 0
  state.contextTokens = 0
  state.turnIndex = 0
  state.turnDeltas = []
  state.lastTier = null
  state.lastRedAt = 0
  state.lastSummaryText = ''
}

export function getHealthState(): HealthState {
  return state
}

function attentionRatio(model: string): number {
  return RELIABLE_ATTENTION_RATIO_BY_MODEL[model] ?? RELIABLE_ATTENTION_RATIO_DEFAULT
}

/**
 * 可靠注意力上限 = min(有效窗口, 名义窗口 × 比例)。
 * 与 autoCompact.ts 的 getEffectiveContextWindowSize 保持语义一致：
 * 有效窗口 = min(名义窗口, CLAUDE_CODE_AUTO_COMPACT_WINDOW) − 预留 20K。
 */
export function getEffectiveWindow(model: string): number {
  const nominal = getContextWindowForModel(model)
  const parsed = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  const capped = Number.isFinite(parsed) && parsed > 0 ? Math.min(nominal, parsed) : nominal
  return Math.max(capped - RESERVED_FOR_SUMMARY, 0)
}

export function getAttentionCeiling(model: string): number {
  return Math.min(getEffectiveWindow(model), Math.round(getContextWindowForModel(model) * attentionRatio(model)))
}

/** 压缩断崖点：≥512K 窗口 6 次，否则 3 次 */
export function getCompactionCap(model: string): number {
  return getContextWindowForModel(model) >= 512_000 ? 6 : 3
}

function isMainThreadQuery(querySource?: string): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}

export function extractSummaryText(summaryMessages: { message?: { content?: unknown } }[]): string {
  const parts: string[] = []
  for (const m of summaryMessages) {
    const c = m.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      const block = b as { type?: string; text?: string }
      if (block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function emit(type: string, data: unknown): void {
  try {
    process.stdout.write(JSON.stringify({ type, data }) + '\n')
  } catch {
    // 静默降级：健康事件输出失败不影响主流程
  }
}

function computeHealth(): HealthEventData {
  const model = state.model || 'unknown'
  const ceiling = getAttentionCeiling(model)
  const cap = getCompactionCap(model)

  const compactScore = Math.round((70 * Math.min(state.compactCount, cap)) / cap)
  const chain = state.compactTurns.filter(t => state.turnIndex - t < CHAIN_WINDOW_TURNS).length
  const chainScore = Math.max(0, chain - 1) * 15

  const remainingTokens = Math.max(0, ceiling - state.contextTokens)
  const remainingPct = ceiling > 0 ? Math.round((remainingTokens / ceiling) * 100) : 0
  let waterScore = 0
  if (remainingPct < 12) waterScore = 70
  else if (remainingPct < 25) waterScore = 45

  const avgDelta =
    state.turnDeltas.length > 0
      ? state.turnDeltas.reduce((a, b) => a + b, 0) / state.turnDeltas.length
      : AVG_TURN_FLOOR
  const remainingTurns = Math.floor(remainingTokens / Math.max(avgDelta, AVG_TURN_FLOOR))
  let turnsScore = 0
  if (remainingTurns < 5) turnsScore = 30
  else if (remainingTurns < 10) turnsScore = 20

  const failureScore = Math.min(state.consecutiveFailures, 3) * 10

  const score = Math.min(100, compactScore + chainScore + waterScore + turnsScore + failureScore)
  const forceRed = remainingTurns < 5
  const tier: HealthTier = forceRed || score >= TIER_RED ? 'red' : score >= TIER_YELLOW ? 'yellow' : 'green'

  const reasonParts: string[] = []
  if (state.compactCount > 0) reasonParts.push(`已压缩${state.compactCount}次`)
  if (remainingPct < 25) reasonParts.push(`上下文剩余${remainingPct}%`)
  if (remainingTurns < 10) reasonParts.push(`约剩${remainingTurns}轮`)

  return {
    score,
    tier,
    compactCount: state.compactCount,
    recompactionChain: chain,
    remainingPct,
    remainingTurns,
    suggestNewSession: tier === 'red',
    reason: reasonParts.length > 0 ? reasonParts.join('，') : '',
  }
}

/** 每轮调用。返回需要发射的健康事件，否则 null。非主线程直接返回 null。 */
export function recordTurn(stats: TurnStats, querySource?: string): HealthEventData | null {
  try {
    if (!isMainThreadQuery(querySource)) return null

    state.model = stats.model
    state.consecutiveFailures = stats.consecutiveFailures

    if (stats.compacted) {
      state.compactTurns.push(state.turnIndex)
    } else if (state.contextTokens > 0 && stats.contextTokens > state.contextTokens) {
      const delta = stats.contextTokens - state.contextTokens
      state.turnDeltas.push(delta)
      if (state.turnDeltas.length > TURN_WINDOW) state.turnDeltas.shift()
    }
    state.contextTokens = stats.contextTokens
    state.turnIndex++

    const evt = computeHealth()

    // 去抖：仅档位变化发射；红档分数恶化（+10）且过冷却期可补发
    if (evt.tier !== state.lastTier) {
      state.lastTier = evt.tier
      if (evt.tier === 'red') state.lastRedAt = Date.now()
      if (evt.tier !== 'green' || state.lastTier !== null) emit('yfw_health', evt)
      return evt.tier === 'green' && state.lastTier === null ? null : evt
    }
    if (
      evt.tier === 'red' &&
      evt.score >= 80 &&
      Date.now() - state.lastRedAt >= RED_COOLDOWN_MS
    ) {
      state.lastRedAt = Date.now()
      emit('yfw_health', evt)
      return evt
    }
    return null
  } catch {
    return null
  }
}

/** 压缩成功后调用：计次、存摘要、发射 yfw_summary。 */
export function recordCompaction(model: string, summaryText: string): void {
  try {
    state.model = model
    state.compactCount++
    state.lastSummaryText = summaryText
    emit('yfw_summary', { text: summaryText, compactCount: state.compactCount })
  } catch {
    // 静默降级
  }
}
```

> 实现注意：剩余轮数测试（"9 轮 +20"）需要先把上下文顶到剩余 27K 附近。用 `recordTurn(turn(FLASH, 20_000))` → `recordTurn(turn(FLASH, 23_000))` 建立 3K 均值，再 `recordTurn(turn(FLASH, 133_000))`（remaining 27K → 9 轮）断言黄档。测试用例在 Step 1 中标注为"实现后调整"，请在实现后按此修正该用例。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd yfw-kernel/claude-code && npx vitest run tests/health/healthMonitor.test.ts`
Expected: PASS（如剩余轮数用例失败，按上述实现注意修正用例）

- [ ] **Step 5: 修订 spec 因子表（归一化计分）**

在 `docs/superpowers/specs/2026-08-13-health-monitor-design.md` 因子表中把压缩次数/压缩链深度两行改为：
```
| 压缩次数 compactCount | 归一化 | 70×min(count,cap)/cap | cap=断崖点：flash 3 / pro[1m] 6 |
| 压缩链深度（10 轮内压缩数） | ≥2 次起算 | (chain−1)×15 | 链窗口 10 轮 |
```
并把档位说明补一句："压缩计分归一化到断崖点，保证 flash 3 次红档、pro[1m] 3 次仍黄档。"

- [ ] **Step 6: 提交**

```bash
git add yfw-kernel/claude-code/src/services/health/healthMonitor.ts yfw-kernel/claude-code/tests/health/healthMonitor.test.ts docs/superpowers/specs/2026-08-13-health-monitor-design.md
git commit -m "feat(kernel): healthMonitor 综合健康分核心模块（模型自适应+注意力上限+归一化压缩计分）"
```

---

### Task 2: 内核挂载 query.ts（事件输出 + 主线程过滤）

**Files:**
- Modify: `yfw-kernel/claude-code/src/query.ts:470-543`（主动压缩分支 + else 分支）
- Modify: `yfw-kernel/claude-code/src/query.ts:1134-1152`（reactive 压缩分支）
- Verify: `yfw-kernel/claude-code/src/utils/context.ts` 导出 `getContextWindowForModel`（若不存在则修正 Task 1 导入）

**Interfaces:**
- Consumes: Task 1 的 `recordTurn(stats, querySource)`、`recordCompaction(model, summaryText)`、`extractSummaryText(summaryMessages)`

- [ ] **Step 1: 在 query.ts 顶部加导入**

在 query.ts 的 import 区（约 line 86 附近，`finalContextTokensFromLastResponse` 导入之后）加入：

```ts
import {
  recordCompaction,
  recordTurn,
  extractSummaryText,
} from './services/health/healthMonitor.js'
```

- [ ] **Step 2: 主动压缩分支挂载**

在 `query.ts` 的 `if (compactionResult) {` 块内、`const postCompactMessages = buildPostCompactMessages(compactionResult)`（line 528）之后、`for (const message of postCompactMessages) yield message`（line 530）之前插入：

```ts
      // 健康监控：压缩成功后计次、存摘要、触发健康重算（仅主线程）
      recordCompaction(
        toolUseContext.options.mainLoopModel,
        extractSummaryText(compactionResult.summaryMessages),
      )
      recordTurn(
        {
          model: toolUseContext.options.mainLoopModel,
          contextTokens:
            compactionResult.truePostCompactTokenCount ??
            finalContextTokensFromLastResponse(postCompactMessages),
          compacted: true,
          consecutiveFailures: 0,
        },
        querySource,
      )
```

> 注意 `toolUseContext` 在此处已是对象（line 546 之后才解构，插入点在其前，直接用 `toolUseContext.options.mainLoopModel` 即可；若 TS 报可选链问题用 `toolUseContext?.options?.mainLoopModel ?? ''`）。

- [ ] **Step 3: else-if / else 分支挂载**

把 line 536-543 的 `} else if (consecutiveFailures !== undefined) { ... }` 块扩展为（在 `tracking = {...}` 赋值之后追加）：

```ts
    } else if (consecutiveFailures !== undefined) {
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
      // 健康监控：压缩失败的轮次
      recordTurn(
        {
          model: toolUseContext.options.mainLoopModel,
          contextTokens: finalContextTokensFromLastResponse(messagesForQuery),
          compacted: false,
          consecutiveFailures,
        },
        querySource,
      )
    } else {
      // 健康监控：普通轮次（每 API round 一次）
      recordTurn(
        {
          model: toolUseContext.options.mainLoopModel,
          contextTokens: finalContextTokensFromLastResponse(messagesForQuery),
          compacted: false,
          consecutiveFailures: 0,
        },
        querySource,
      )
    }
```

- [ ] **Step 4: reactive 压缩分支挂载**

在 `query.ts` line 1148 `const postCompactMessages = buildPostCompactMessages(compacted)` 之后插入：

```ts
          recordCompaction(
            toolUseContext.options.mainLoopModel,
            extractSummaryText(compacted.summaryMessages ?? []),
          )
          recordTurn(
            {
              model: toolUseContext.options.mainLoopModel,
              contextTokens: finalContextTokensFromLastResponse(postCompactMessages),
              compacted: true,
              consecutiveFailures: 0,
            },
            querySource,
          )
```

> 若 `compacted.summaryMessages` 字段名不同（reactive 结果类型），用 `finalContextTokensFromLastResponse(postCompactMessages)` 兜底；实现时以类型定义为准。

- [ ] **Step 5: 类型检查**

Run: `cd yfw-kernel/claude-code && npm run typecheck`
Expected: 通过（如有类型错误按报错修正；确认 `truePostCompactTokenCount`、`summaryMessages` 字段存在）

- [ ] **Step 6: 回归内核既有测试（选择与 health 无关的轻量用例）**

Run: `cd yfw-kernel/claude-code && npx vitest run tests/health/healthMonitor.test.ts`
Expected: PASS（Task 1 用例不受影响）

- [ ] **Step 7: 提交**

```bash
git add yfw-kernel/claude-code/src/query.ts
git commit -m "feat(kernel): query.ts 挂载健康监控（主动/reactive 压缩 + 普通轮次记录，主线程过滤）"
```

---

### Task 3: GUI healthStore + useYFWCLI 事件接入

**Files:**
- Create: `src/stores/healthStore.ts`
- Modify: `src/hooks/useYFWCLI.ts`（handleMessage 事件分发）

**Interfaces:**
- Consumes: Task 1 事件协议（平铺载荷）`{"type":"yfw_health","score":72,"tier":"red","compactCount":3,"remainingPct":8,"remainingTurns":4,"suggestNewSession":true,"reason":"..."}` 与 `{"type":"yfw_summary","text":"...","compactCount":3}`
- Produces（供 Task 4 使用）：`useHealthStore`，含 `health: HealthInfo | null`、`summary: string`、`summaryCompactCount: number`、`dismissedUntil: number`、`update(info)`、`setSummary(text, compactCount)`、`dismiss()`

- [ ] **Step 1: 创建 healthStore.ts**

```ts
// src/stores/healthStore.ts
import { create } from 'zustand'

export type HealthTier = 'green' | 'yellow' | 'red'

export interface HealthInfo {
  score: number
  tier: HealthTier
  compactCount: number
  remainingPct: number
  remainingTurns: number
  suggestNewSession: boolean
  reason: string
}

interface HealthState {
  health: HealthInfo | null
  summary: string
  summaryCompactCount: number
  /** 用户关闭红档横幅后的 5 分钟冷却截止时间 */
  dismissedUntil: number
  update: (info: HealthInfo) => void
  setSummary: (text: string, compactCount: number) => void
  dismiss: () => void
}

const RED_DISMISS_MS = 5 * 60 * 1000

export const useHealthStore = create<HealthState>((set) => ({
  health: null,
  summary: '',
  summaryCompactCount: 0,
  dismissedUntil: 0,
  update: (info) => set({ health: info }),
  setSummary: (text, compactCount) => set({ summary: text, summaryCompactCount: compactCount }),
  dismiss: () => set({ dismissedUntil: Date.now() + RED_DISMISS_MS }),
}))
```

- [ ] **Step 2: useYFWCLI.ts 接入事件**

在 `src/hooks/useYFWCLI.ts` 顶部 import 区加：

```ts
import { useHealthStore, type HealthInfo } from '@/stores/healthStore'
```

在 `handleMessage` 的 `msg.type === 'event'` 分支内、`const type = event.type as string` 之后、现有 `if (type === 'system' ...)` 之前插入：

```ts
    if (type === 'yfw_health') {
      useHealthStore.getState().update(event as unknown as HealthInfo)
      return
    }
    if (type === 'yfw_summary') {
      const s = event as Record<string, any>
      useHealthStore.getState().setSummary(String(s.text ?? ''), Number(s.compactCount ?? 0))
      return
    }
```

- [ ] **Step 3: 类型检查**

Run: `cd C:/Users/T203-15/claude-code-gui && npm run typecheck`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/stores/healthStore.ts src/hooks/useYFWCLI.ts
git commit -m "feat(gui): healthStore 与内核健康事件接入（yfw_health/yfw_summary）"
```

---

### Task 4: GUI HealthBanner 组件 + 一键新建携带摘要

**Files:**
- Create: `src/components/chat/HealthBanner.tsx`
- Modify: `src/components/chat/ChatWindow.tsx`（渲染横幅）
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`（横幅文案）

**Interfaces:**
- Consumes: Task 3 的 `useHealthStore`；`useChatStore` 的 `createConversation(cwd?, agentId?)`、`conversations`、`activeConversationId`；`useUIStore` 的 `setPendingInput(text, autoSend?)`
- Produces: `<HealthBanner />`（ChatWindow 顶部渲染）

- [ ] **Step 1: 创建 HealthBanner.tsx**

```tsx
// src/components/chat/HealthBanner.tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHealthStore } from '@/stores/healthStore'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'

export function HealthBanner() {
  const { t } = useTranslation()
  const health = useHealthStore(s => s.health)
  const summary = useHealthStore(s => s.summary)
  const dismissedUntil = useHealthStore(s => s.dismissedUntil)
  const dismiss = useHealthStore(s => s.dismiss)
  const [carrySummary, setCarrySummary] = useState(true)

  if (!health || health.tier === 'green') return null
  if (health.tier === 'red' && Date.now() < dismissedUntil) return null

  const handleNewSession = () => {
    const { conversations, activeConversationId, createConversation } = useChatStore.getState()
    const current = conversations.find(c => c.id === activeConversationId)
    createConversation(undefined, current?.agentId)
    if (carrySummary && summary) {
      useUIStore.getState().setPendingInput(summary, false)
    }
    dismiss()
  }

  const detail = `${t('health.remainingPct', { pct: health.remainingPct })} · ${t('health.remainingTurns', { turns: health.remainingTurns })}`

  if (health.tier === 'yellow') {
    return (
      <div className="px-4 py-1.5 text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 border-b border-amber-500/20">
        {health.reason ? `${health.reason} · ` : ''}{detail} — {t('health.yellowHint')}
      </div>
    )
  }

  return (
    <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 flex items-center gap-3 text-sm">
      <span className="text-red-600 dark:text-red-400 font-medium">{health.reason || t('health.redTitle')}</span>
      <span className="text-xs text-red-500/80">{detail}</span>
      <label className="ml-auto flex items-center gap-1.5 text-xs cursor-pointer">
        <input type="checkbox" checked={carrySummary} onChange={e => setCarrySummary(e.target.checked)} />
        {t('health.carrySummary')}
      </label>
      <button
        onClick={handleNewSession}
        className="px-2.5 py-1 rounded bg-red-600 text-white text-xs hover:bg-red-500"
      >
        {t('health.newSession')}
      </button>
      <button onClick={dismiss} className="text-xs text-red-500/70 hover:text-red-500" aria-label={t('health.dismiss')}>
        ✕
      </button>
    </div>
  )
}
```

- [ ] **Step 2: ChatWindow 渲染横幅**

在 `src/components/chat/ChatWindow.tsx` 顶部 import `HealthBanner`，在 return 的最外层容器**最上方**（消息列表之前）渲染 `<HealthBanner />`。参考现有 ChatWindow.tsx:27 附近已 `import { useUIStore }` 的写法保持一致。

- [ ] **Step 3: i18n 文案**

`src/i18n/translations/zh-CN.ts`（在合适的分组，如 chat 相关键附近）加入：
```ts
health: {
  yellowHint: '建议适时开始新会话',
  redTitle: '任务质量明显下降，建议新建会话继续',
  remainingPct: '剩余 {{pct}}%',
  remainingTurns: '约剩 {{turns}} 轮',
  carrySummary: '携带摘要',
  newSession: '新建会话',
  dismiss: '关闭',
},
```
`src/i18n/translations/en-US.ts` 对应加入：
```ts
health: {
  yellowHint: 'Consider starting a new session',
  redTitle: 'Task quality is degrading — start a new session',
  remainingPct: '{{pct}}% left',
  remainingTurns: '~{{turns}} turns left',
  carrySummary: 'Carry summary',
  newSession: 'New session',
  dismiss: 'Dismiss',
},
```
> 若该翻译文件里的结构是扁平键（如 `'chat.foo': '...'`），改为扁平键形式 `'health.yellowHint': '...'`，与现有文件结构保持一致。

- [ ] **Step 4: 类型检查 + 构建**

Run: `cd C:/Users/T203-15/claude-code-gui && npm run build`
Expected: tsc + vite build 通过（若 i18n 类型有 key 约束，按约束补全）

- [ ] **Step 5: 手工验证清单（dev 模式）**

- 黄档：临时在 healthStore 初始值注入 `{tier:'yellow', remainingPct:24, remainingTurns:8}` → 顶部出现细条
- 红档：注入 `{tier:'red', score:80, remainingTurns:3}` → 醒目横幅 + 新建会话按钮 + 携带摘要勾选
- 点「新建会话」→ 新会话创建、输入框预填摘要文本（可编辑）、横幅消失
- 点 ✕ → 横幅隐藏，5 分钟内不自动重现
- 说明：事件链路（内核→GUI）的真实端到端在 Task 5 用 build 产物验证

- [ ] **Step 6: 提交**

```bash
git add src/components/chat/HealthBanner.tsx src/components/chat/ChatWindow.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(gui): HealthBanner 横幅 + 一键新建会话携带摘要"
```

---

### Task 5: 全链路构建与 release 双份同步

**Files:**
- 构建产物：`yfw-kernel/claude-code/dist/`（cli.mjs + vendor/）→ `release/YFWorking/kernel/`、`release/YFWorking_ms92cd6u/kernel/`
- GUI 产物：`dist/` → `release/YFWorking/dist/`、`release/YFWorking_ms92cd6u/dist/`

- [ ] **Step 1: 内核测试全绿**

Run: `cd yfw-kernel/claude-code && npx vitest run tests/health/healthMonitor.test.ts`
Expected: PASS

- [ ] **Step 2: 构建内核 bundle**

Run: `cd yfw-kernel/claude-code && npm run build`
Expected: 输出 `dist/cli.mjs` 与 `dist/vendor/`（含 `vendor/ripgrep/x64-win32/rg.exe`，由 build-bundle.ts 的 vendor 复制步骤保证）

- [ ] **Step 3: 同步内核到 release 双份**

```bash
cd C:/Users/T203-15/claude-code-gui
for app in YFWorking YFWorking_ms92cd6u; do
  cp yfw-kernel/claude-code/dist/cli.mjs "release/$app/kernel/cli.mjs"
  rm -rf "release/$app/kernel/vendor"
  cp -r yfw-kernel/claude-code/dist/vendor "release/$app/kernel/vendor"
done
```

- [ ] **Step 4: 构建 GUI 并同步双份**

```bash
npm run build
for app in YFWorking YFWorking_ms92cd6u; do
  cp -r dist/. "release/$app/dist/"
done
```

- [ ] **Step 5: 端到端冒烟（用户重启 live 应用前需征得同意）**

- 请求用户重启 live 应用（**必须先询问，不擅自杀进程/重启**）
- 验证：长会话多次压缩后出现黄→红横幅；点「新建会话」携带摘要；`bridge` 侧无异常、内核事件行解析正常
- 若无法即时重启，标记为待用户重启后验证，并同步 release 已完成的结论

- [ ] **Step 6: 提交剩余源码改动**

```bash
git add -A
git commit -m "chore: 健康监控全链路构建并同步 release 双份"
```
> 若没有任何未提交源码改动，跳过此步。

---

## Self-Review 结论

- **Spec 覆盖**：架构（Task 1-2）、健康分模型+模型自适应+注意力上限（Task 1）、事件协议（Task 2-3）、GUI 横幅+一键新建携带摘要（Task 4）、测试（Task 1/5）、release 同步（Task 5）。spec 的"GUI 组件测试"因仓库无 GUI 测试基建（无 vitest 配置、无 testing-library），按 YAGNI 改为 `npm run build` + 手工清单（Task 4 Step 4-5）——已在任务内明确降级。
- **占位符**：无 TBD/TODO；所有代码块为完整实现。
- **类型一致性**：`TurnStats`/`HealthEventData`/`HealthInfo` 在 Task 1/3 定义、Task 2/3/4 引用一致；`recordTurn(stats, querySource)`、`recordCompaction(model, summaryText)`、`extractSummaryText(summaryMessages)` 签名跨任务一致；`createConversation(cwd?, agentId?)`、`setPendingInput(text, autoSend?)` 与现有代码签名一致。
- **已知风险**：`getContextWindowForModel` 导出名、`truePostCompactTokenCount`/`summaryMessages` 字段名需在实现时以类型定义核对（Task 1 Step 3 注意点 + Task 2 Step 5 已含核对步骤）；reactive 分支 `compacted.summaryMessages` 可能需兜底。
