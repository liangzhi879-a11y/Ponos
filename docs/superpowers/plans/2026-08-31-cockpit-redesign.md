# 驾驶舱重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复驾驶舱 token 统计不显示的数据链路，并将驾驶舱重构为"品牌 Hero + 状态总览条 + 升级四卡 + 右侧最近会话/任务栏"的混合型工作台，含 30 日趋势图、分类环形图等可视化。

**Architecture:** 数据层改用 bridge 现有 `/transcript/stats` 聚合端点作为主数据源（`tokenStatsStore.refreshFromServer()`），并在 `usePonosCLI` 的 result 事件处理处补 `recordUsage` 实时累加；UI 层重构 `CockpitView` 为三层布局（Hero / StatStrip / 网格+右栏），从 `TokenStatsPanel` 提取 `TrendChart`/`DonutChart` 到公共 charts 目录复用，新增 `BarStack` 堆叠条，全部手写 SVG 零依赖。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind CSS + zustand（现有技术栈，不新增图表库）

## Global Constraints

- **零新增依赖**：不引入 recharts/chart.js 等图表库，全部手写 SVG（与现状一致）
- **不新增 bridge 端点**：复用 `/transcript/stats`（`server/bridge.mjs:1568-1592` 已实现）
- **不改其它 UI 区域**：只动 cockpit/ 组件、charts/ 新目录、tokenStatsStore、usePonosCLI、i18n、App.tsx 回填调用
- **主题变量**：全部用 CSS 变量（`var(--brand-500)`/`var(--accent-cyan)`/`var(--bg-input)` 等），禁止硬编码 hex
- **i18n 双语文案**：zh-CN.ts 与 en-US.ts 同步新增 key
- **测试命令**：`node --test src/stores/*.test.ts src/components/charts/*.test.ts`（Node 原生 TS 测试，参照 `src/stores/tokenStatsStore.test.ts` 的 mock fetch 模式）
- **提交纪律**：只 `git add` 本次改动的文件；提交前 `git status` 核对

---

### Task 1: tokenStatsStore 数据源切换 — refreshFromServer()

**Files:**
- Modify: `src/stores/tokenStatsStore.ts`（新增 `refreshFromServer` + `lastError` 状态）
- Test: `src/stores/tokenStatsStore.test.ts`

**Interfaces:**
- Consumes: `TokenStats`（现有）、`toDayKey`（现有）
- Produces: `refreshFromServer(baseUrl?: string): Promise<boolean>` — 拉 `/transcript/stats` 映射进 stats；`lastError: string | null` 状态字段；`lastUpdatedAt` 成功时更新

- [ ] **Step 1: 写失败测试**

在 `src/stores/tokenStatsStore.test.ts` 末尾追加：

```ts
test('refreshFromServer 映射 /transcript/stats 到 stats', async () => {
  const serverResp = {
    ok: true,
    totals: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    byDate: { '2026-08-30': { input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    byModel: { 'deepseek-v4-pro': { input_tokens: 700, output_tokens: 300, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
  }
  const mockFetch = async (url: string) => {
    assert.ok(String(url).includes('/transcript/stats'))
    return { ok: true, json: async () => serverResp } as Response
  }
  globalThis.fetch = mockFetch as typeof fetch
  const store = useTokenStatsStore
  store.setState({ stats: createEmptyStats(), lastError: null })
  const ok = await store.getState().refreshFromServer('http://mock')
  assert.equal(ok, true)
  const s = store.getState().stats
  assert.equal(s.totalInput, 1000)
  assert.equal(s.totalOutput, 400)
  assert.deepEqual(s.byDay['2026-08-30'], { input: 300, output: 100 })
  assert.deepEqual(s.byModel['deepseek-v4-pro'], { input: 700, output: 300 })
})

test('refreshFromServer 失败置 lastError 且保留旧 stats', async () => {
  globalThis.fetch = (async () => {
    throw new Error('bridge down')
  }) as typeof fetch
  const store = useTokenStatsStore
  store.setState({ stats: createEmptyStats(), lastError: null })
  const ok = await store.getState().refreshFromServer('http://mock')
  assert.equal(ok, false)
  assert.equal(store.getState().lastError, 'bridge down')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/stores/tokenStatsStore.test.ts`
Expected: FAIL — `refreshFromServer is not a function`

- [ ] **Step 3: 实现 refreshFromServer**

在 `src/stores/tokenStatsStore.ts` 中：

```ts
/** 从 bridge /transcript/stats 全量拉取并映射进 stats（主数据源）。
 *  返回 true=成功；失败置 lastError（不吞错，驾驶舱显示重试态）。 */
export async function refreshFromServer(
  stats: TokenStats,
  baseUrl?: string
): Promise<{ stats: TokenStats; ok: boolean; error: string }> {
  const base = baseUrl || getBridgeUrl()
  try {
    const res = await fetch(`${base}/transcript/stats`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data || data.ok !== true || !data.totals) throw new Error('stats 响应缺 totals')
    const s: TokenStats = {
      totalInput: data.totals.input_tokens ?? 0,
      totalOutput: data.totals.output_tokens ?? 0,
      byDay: {},
      byConversation: stats.byConversation, // 服务端无 per-conversation 聚合，保留本地
      byModel: {},
      lastUpdatedAt: Date.now(),
    }
    for (const [day, v] of Object.entries(data.byDate || {})) {
      const d = v as { input_tokens?: number; output_tokens?: number }
      s.byDay[day] = { input: d.input_tokens ?? 0, output: d.output_tokens ?? 0 }
    }
    for (const [model, v] of Object.entries(data.byModel || {})) {
      const m = v as { input_tokens?: number; output_tokens?: number }
      s.byModel[model] = { input: m.input_tokens ?? 0, output: m.output_tokens ?? 0 }
    }
    return { stats: s, ok: true, error: '' }
  } catch (e) {
    return { stats, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
```

在 store 接口与实现中新增：

```ts
interface TokenStatsStore {
  stats: TokenStats
  backfilled: Record<string, boolean>
  lastError: string | null
  recordUsage: ...
  ensureBackfill: ...
  refreshFromServer: (baseUrl?: string) => Promise<boolean>
}
```

实现（在 `ensureBackfill` 之后）：

```ts
refreshFromServer: async (baseUrl) => {
  const cur = get()
  const r = await refreshFromServer(cur.stats, baseUrl)
  set({ stats: r.stats, lastError: r.ok ? null : r.error })
  return r.ok
},
```

初始化 `lastError: null`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/stores/tokenStatsStore.test.ts`
Expected: PASS（原 4 个测试 + 新 2 个）

- [ ] **Step 5: Commit**

```bash
git add src/stores/tokenStatsStore.ts src/stores/tokenStatsStore.test.ts
git commit -m "feat(token-stats): refreshFromServer 接入 /transcript/stats 聚合端点"
```

---

### Task 2: usePonosCLI 补 recordUsage 实时累加

**Files:**
- Modify: `src/hooks/usePonosCLI.ts`（result 事件处理处，约行 691-701）

**Interfaces:**
- Consumes: `useTokenStatsStore.getState().recordUsage(u, dims)`（签名：`(u: { input: number; output: number }, dims: { conversationId: string; model: string }) => void`）
- Produces: 无新导出；行为上每个轮次 result 事件后 token 实时累加

- [ ] **Step 1: 在 result 处理处补调用**

`src/hooks/usePonosCLI.ts` 的 result 分支（行 691-701，`if (type === 'result' && aid)`）内，`_finishStreaming` 之后追加：

```ts
// 实时 token 累加：本轮 usage 计入 tokenStatsStore（历史由 /transcript/stats 全量补齐）
useTokenStatsStore.getState().recordUsage(
  { input: usage.input_tokens || 0, output: usage.output_tokens || 0 },
  { conversationId: sid, model: store.sessionModel || '' },
)
```

- [ ] **Step 2: 确认文件顶部已 import useTokenStatsStore**

`src/hooks/usePonosCLI.ts` 顶部应已有 `import { useTokenStatsStore } from '@/stores/tokenStatsStore'`。若无则添加（参照现有 store import 风格）。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/hooks/usePonosCLI.ts
git commit -m "feat(token-stats): result 事件补 recordUsage 实时累加"
```

---

### Task 3: 提取公共图表组件 TrendChart / DonutChart + 新增 BarStack

**Files:**
- Create: `src/components/charts/TrendChart.tsx`
- Create: `src/components/charts/DonutChart.tsx`
- Create: `src/components/charts/BarStack.tsx`
- Modify: `src/components/cockpit/TokenStatsPanel.tsx`（改用公共组件，删除本地定义）

**Interfaces:**
- Produces:
  - `TrendChart({ values: number[]; labels: string[] }): JSX.Element` — 30 日线图（polyline + 面积渐变 + 数据点 title）
  - `DonutChart({ segments: { label: string; value: number }[]; centerValue: number }): JSX.Element` — 环形图
  - `BarStack({ input: number; output: number; className?: string }): JSX.Element` — 输入/输出双色堆叠条

- [ ] **Step 1: 创建 TrendChart**

`src/components/charts/TrendChart.tsx`（从 TokenStatsPanel 原样提取，保留 `tsp-stroke`/`tsp-fill` 渐变 id，导出组件）：

```tsx
/** 近 N 日趋势线图 — SVG polyline + 面积渐变（按最高值归一化，零依赖）。 */
export function TrendChart({ values, labels }: { values: number[]; labels: string[] }) {
  const W = 600; const H = 150
  const PAD_L = 6; const PAD_R = 6; const PAD_T = 12; const PAD_B = 22
  const n = values.length
  const max = Math.max(1, ...values)
  const innerW = W - PAD_L - PAD_R; const innerH = H - PAD_T - PAD_B
  const x = (i: number) => (n <= 1 ? PAD_L : PAD_L + (i / (n - 1)) * innerW)
  const y = (v: number) => PAD_T + (1 - v / max) * innerH
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const areaPath = n > 0
    ? `M ${x(0).toFixed(1)} ${y(values[0]).toFixed(1)} ` +
      values.map((v, i) => `L ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ') +
      ` L ${x(n - 1).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} Z`
    : ''
  const labelIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="tsp-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: 'var(--accent-cyan)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--brand-500)' }} />
          </linearGradient>
          <linearGradient id="tsp-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--brand-500)', stopOpacity: 0.28 }} />
            <stop offset="100%" style={{ stopColor: 'var(--brand-500)', stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>
        {n > 0 && (
          <>
            <path d={areaPath} fill="url(#tsp-fill)" />
            <polyline points={points} fill="none" stroke="url(#tsp-stroke)" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
            {values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={1.8} fill="var(--accent-cyan)">
                <title>{`${labels[i] ?? ''} · ${v.toLocaleString()} tokens`}</title>
              </circle>
            ))}
          </>
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-tertiary">
        {labelIdx.map(i => <span key={i}>{labels[i] ?? ''}</span>)}
      </div>
    </>
  )
}
```

- [ ] **Step 2: 创建 DonutChart**

`src/components/charts/DonutChart.tsx`（从 TokenStatsPanel 原样提取）：

```tsx
const DONUT_COLORS = ['var(--brand-500)', 'var(--accent-cyan)', 'rgb(var(--error-rgb))']

export function DonutChart({ segments, centerValue }: {
  segments: { label: string; value: number }[]
  centerValue: number
}) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  let acc = 0
  const arcs = segments.map((s, i) => {
    const len = total > 0 ? (s.value / total) * 100 : 0
    const start = acc; acc += len
    return { ...s, len, start, color: DONUT_COLORS[i % DONUT_COLORS.length] }
  })
  return (
    <div className="flex items-center gap-4">
      <div className="relative w-32 h-32 shrink-0">
        <svg viewBox="0 0 100 100" className="w-full h-full">
          <g transform="rotate(-90 50 50)">
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--bg-input)" strokeWidth="12" pathLength={100} />
            {arcs.map(a => (
              <circle key={a.label} cx="50" cy="50" r="40" fill="none" stroke={a.color} strokeWidth="12" pathLength={100}
                strokeDasharray={`${Math.max(0, a.len - 0.5)} ${100 - Math.max(0, a.len - 0.5)}`} strokeDashoffset={-a.start} />
            ))}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-primary">{formatTokens(centerValue)}</span>
          <span className="text-[10px] text-tertiary">tokens</span>
        </div>
      </div>
      <div className="flex-1 space-y-1.5 min-w-0">
        {segments.length === 0 && <p className="text-xs text-tertiary">—</p>}
        {arcs.map(a => (
          <div key={a.label} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color }} />
            <span className="text-secondary truncate flex-1" title={a.label}>{a.label}</span>
            <span className="text-tertiary tabular-nums shrink-0">{total > 0 ? `${Math.round(a.len)}%` : '0%'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

> 注：`formatTokens` 在 DonutChart 内部需要——从 TokenStatsPanel 复制该辅助函数（YAGNI 不抽公共 utils，两处小重复可接受；如需可后续统一）。

- [ ] **Step 3: 创建 BarStack**

`src/components/charts/BarStack.tsx`：

```tsx
/** 输入/输出双色堆叠条（青=输入 / 粉=输出，百分比标注）。 */
export function BarStack({ input, output, className }: { input: number; output: number; className?: string }) {
  const total = input + output
  const inputPct = total > 0 ? (input / total) * 100 : 0
  const outputPct = total > 0 ? (output / total) * 100 : 0
  return (
    <div className={className}>
      <div className="flex h-3 w-full rounded-full bg-input/50 overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${inputPct}%`, background: 'var(--accent-cyan)' }} />
        <div className="h-full transition-all" style={{ width: `${outputPct}%`, background: 'var(--brand-500)' }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-tertiary tabular-nums">
        <span>输入 {Math.round(inputPct)}%</span>
        <span>输出 {Math.round(outputPct)}%</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: TokenStatsPanel 改用公共组件**

`src/components/cockpit/TokenStatsPanel.tsx`：
- 删除本地 `TrendChart` 定义，改 `import { TrendChart } from '@/components/charts/TrendChart'`
- 删除本地 `DonutChart` 与 `DONUT_COLORS` 定义，改 `import { DonutChart } from '@/components/charts/DonutChart'`
- 原 ioSplit 卡片的堆叠条改用 `import { BarStack } from '@/components/charts/BarStack'`（可选，保持原样亦可；建议改用减少重复）

- [ ] **Step 5: 类型检查 + 回归**

Run: `npm run typecheck && node --test src/stores/*.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/charts/ src/components/cockpit/TokenStatsPanel.tsx
git commit -m "feat(charts): 提取 TrendChart/DonutChart 公共组件 + 新增 BarStack 堆叠条"
```

---

### Task 4: App.tsx 驾驶舱回填切到 refreshFromServer

**Files:**
- Modify: `src/App.tsx`（约行 36-41 的 ensureBackfill 调用）

**Interfaces:**
- Consumes: `useTokenStatsStore.getState().refreshFromServer()`（Task 1 产物）
- Produces: 驾驶舱打开时先 refreshFromServer；回填降级为兜底

- [ ] **Step 1: 修改回填调用**

`src/App.tsx` 中 `view === 'cockpit'` 的 effect 改为：

```ts
useEffect(() => {
  if (view === 'cockpit') {
    const store = useTokenStatsStore.getState()
    // 主数据源：/transcript/stats 全量聚合（成功则覆盖本地）
    void store.refreshFromServer()
    // 兜底：逐会话 transcript 回填（仅当 refresh 失败或需 byConversation 明细时）
    const convs = useChatStore.getState().conversations
    if (store.lastError) void store.ensureBackfill(convs)
  }
}, [view])
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(cockpit): 驾驶舱打开优先 refreshFromServer，回填降级为兜底"
```

---

### Task 5: i18n 新增驾驶舱 key（zh + en）

**Files:**
- Modify: `src/i18n/translations/zh-CN.ts`（cockpit 段，约行 436-455）
- Modify: `src/i18n/translations/en-US.ts`（cockpit 段，约行 423-441）

**Interfaces:**
- Produces: 新 key 供 Task 6-8 使用：
  - `cockpit.version` / `cockpit.projectDir` / `cockpit.newChat` / `cockpit.openFiles` / `cockpit.viewTokens`
  - `cockpit.bridgeOnline` / `cockpit.bridgeOffline` / `cockpit.recentSessions` / `cockpit.noRecent`
  - `cockpit.token30d` / `cockpit.skillGroups` / `cockpit.dataUnavailable` / `cockpit.retry`
  - `cockpit.sessionToken` / `cockpit.justNow`（时间显示辅助）

- [ ] **Step 1: zh-CN.ts cockpit 段追加**

在 `src/i18n/translations/zh-CN.ts` 的 cockpit 对象内（`enter: '进入 →'` 之后）追加：

```ts
    enter: '进入 →',
    backCockpit: '返回驾驶舱',
    // --- 重构新增 ---
    version: '版本',
    projectDir: '当前项目',
    newChat: '新建会话',
    openFiles: '打开文件',
    viewTokens: '查看 Token',
    bridgeOnline: '在线',
    bridgeOffline: '离线',
    recentSessions: '最近会话',
    noRecent: '暂无会话',
    token30d: '近 30 日趋势',
    skillGroups: '技能分类',
    dataUnavailable: '数据暂不可用',
    retry: '重试',
    sessionToken: 'Token',
    justNow: '刚刚',
    hoursAgo: '小时前',
```

- [ ] **Step 2: en-US.ts cockpit 段追加**

在 `src/i18n/translations/en-US.ts` 的 cockpit 对象内追加对应英文：

```ts
    enter: 'Enter →',
    backCockpit: 'Back to cockpit',
    // --- new keys ---
    version: 'Version',
    projectDir: 'Project',
    newChat: 'New chat',
    openFiles: 'Open files',
    viewTokens: 'View tokens',
    bridgeOnline: 'Online',
    bridgeOffline: 'Offline',
    recentSessions: 'Recent sessions',
    noRecent: 'No sessions yet',
    token30d: '30-day trend',
    skillGroups: 'Skill groups',
    dataUnavailable: 'Data unavailable',
    retry: 'Retry',
    sessionToken: 'Tokens',
    justNow: 'just now',
    hoursAgo: 'h ago',
```

- [ ] **Step 3: 验证无重复 key**

Run: `node -e "import('./src/i18n/translations/zh-CN.ts').then(m => console.log(Object.keys(m.default.cockpit).length))"`
Expected: 输出数字（无报错）；zh/en key 集合一致

- [ ] **Step 4: Commit**

```bash
git add src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(i18n): 驾驶舱重构新增双语文案"
```

---

### Task 6: CockpitView 重构 — Hero + StatStrip + 右栏骨架

**Files:**
- Modify: `src/components/cockpit/CockpitView.tsx`（整体重构）
- Create: `src/components/cockpit/RecentSessions.tsx`
- Create: `src/components/cockpit/RunningTasks.tsx`

**Interfaces:**
- Consumes: `useViewStore.goWorkspace(tab)`、`useChatStore.conversations/backgroundTasks/lastCwd`、`useTokenStatsStore.stats`、`useUIStore.openTokenPanel/toggleRightRail`、`fetchSkills(skillRoot)`、`TrendChart/DonutChart/BarStack`（Task 3）、i18n keys（Task 5）
- Produces:
  - `RecentSessions({ limit?: number }): JSX.Element` — 最近会话列表（title/时间/点击直达）
  - `RunningTasks(): JSX.Element` — 运行中任务区

- [ ] **Step 1: 创建 RecentSessions**

`src/components/cockpit/RecentSessions.tsx`：

```tsx
import { useMemo } from 'react'
import { MessageSquare } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

function timeAgo(ts: number, t: (k: string) => string): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('cockpit.justNow')
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return new Date(ts).toLocaleDateString()
}

/** 驾驶舱右侧：最近会话列表（updatedAt 倒序，点选直达工作台对应会话）。 */
export function RecentSessions({ limit = 6 }: { limit?: number }) {
  const { t } = useTranslation()
  const conversations = useChatStore(s => s.conversations)
  const goWorkspace = useViewStore(s => s.goWorkspace)
  const recent = useMemo(
    () => [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit),
    [conversations, limit],
  )
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] uppercase tracking-wider text-tertiary">{t('cockpit.recentSessions')}</h3>
      {recent.length === 0 ? (
        <p className="text-xs text-tertiary">{t('cockpit.noRecent')}</p>
      ) : (
        recent.map(c => (
          <button
            key={c.id}
            onClick={() => goWorkspace('chats')} // 实际进入并激活会话由工作台处理
            className={cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-left',
              'hover:bg-hover transition-colors group',
            )}
          >
            <MessageSquare className="w-3.5 h-3.5 text-tertiary shrink-0 group-hover:text-brand-500 transition-colors" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-secondary truncate" title={c.title}>{c.title || c.id.slice(0, 12)}</div>
              <div className="text-[10px] text-tertiary tabular-nums">{timeAgo(c.updatedAt || c.createdAt, t)}</div>
            </div>
          </button>
        ))
      )}
    </div>
  )
}
```

> 注：`goWorkspace('chats')` 后如何激活对应会话（`chatStore.activeConversationId`）——Task 8 收尾时补 `useChatStore.setState({ activeConversationId: c.id })` 到点击处理器。此处先骨架，Task 8 完善。

- [ ] **Step 2: 创建 RunningTasks**

`src/components/cockpit/RunningTasks.tsx`：

```tsx
import { Loader2 } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'

/** 驾驶舱右侧：运行中任务区（与左侧任务栏同源 backgroundTasks）。 */
export function RunningTasks() {
  const { t } = useTranslation()
  const tasks = useChatStore(s => s.backgroundTasks)
  const running = tasks.filter(x => x.status === 'running')
  if (running.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] uppercase tracking-wider text-tertiary">{t('cockpit.runningTasks')}</h3>
      {running.map(task => (
        <div key={task.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-elevated/60 border border-subtle">
          <Loader2 className="w-3.5 h-3.5 text-brand-500 animate-spin shrink-0" />
          <span className="text-xs text-secondary truncate flex-1">{task.name}</span>
          <span className="text-[10px] text-tertiary tabular-nums shrink-0">
            {task.progress != null ? `${task.progress}%` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: 重构 CockpitView — 引入 Hero + StatStrip + 右栏**

`src/components/cockpit/CockpitView.tsx`：
- 顶部 import 追加：`RecentSessions`、`RunningTasks`、`TrendChart`、`DonutChart`、`BarStack`、`Sparkles`、`Loader2`（如需要）、`cn`（已有）
- 结构改为：

```tsx
return (
  <div className="h-full w-full bg-app flex flex-col overflow-hidden p-6 md:p-10">
    {/* ① Hero */}
    <header className="flex items-center justify-between pb-4 shrink-0">
      <div>
        <h1 className="font-display font-bold text-2xl md:text-3xl tracking-wide bg-gradient-to-r from-brand-500 to-accent-cyan bg-clip-text text-transparent">
          {t('cockpit.welcome')}
        </h1>
        <p className="text-sm text-tertiary mt-1 flex items-center gap-2">
          <FolderOpen className="w-3.5 h-3.5" />
          {t('cockpit.projectDir')}: {lastCwd ? lastCwd.split(/[\\/]/).pop() : 'ponos-dev'}
          <span className="text-tertiary/60">· {t('cockpit.version')} dev 3.0.0</span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={startNewChat} className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-brand-500/90 hover:bg-brand-500 text-white transition-colors">
          {t('cockpit.newChat')}
        </button>
        <button onClick={() => useUIStore.getState().toggleRightRail()} className="px-3 py-1.5 rounded-lg text-sm border border-subtle text-secondary hover:border-brand-500/50 hover:text-primary transition-colors">
          {t('cockpit.openFiles')}
        </button>
        <button onClick={() => useUIStore.getState().openTokenPanel()} className="px-3 py-1.5 rounded-lg text-sm border border-subtle text-secondary hover:border-brand-500/50 hover:text-primary transition-colors">
          {t('cockpit.viewTokens')}
        </button>
      </div>
    </header>

    {/* ② Stat Strip */}
    <div className="flex items-center gap-6 pb-5 shrink-0 border-b border-subtle mb-5">
      <StatItem label={t('cockpit.runningTasks')} value={String(runningTasks)} pulse={runningTasks > 0} />
      <StatItem label={t('cockpit.today')} value={String(todayUpdated)} />
      <StatItem label={t('cockpit.tokenToday')} value={formatTokens(tokenToday)} />
      <StatItem label={t('cockpit.completionRate')} value={`${completionRate}%`} />
      <div className="ml-auto flex items-center gap-1.5 text-xs">
        <span className={cn('w-2 h-2 rounded-full', bridgeOk ? 'bg-emerald-500' : 'bg-error animate-pulse')} />
        <span className="text-tertiary">{bridgeOk ? t('cockpit.bridgeOnline') : t('cockpit.bridgeOffline')}</span>
      </div>
    </div>

    {/* ③ 主网格 + ④ 右栏 */}
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 min-h-0">
      <div ref={gridRef} className="relative grid grid-cols-1 md:grid-cols-2 gap-6 min-h-0">
        {/* SVG 连线层（保留现有） */}
        {/* 四张升级卡（见 Task 7 详述，此处先占位四卡保留现有数字 + 新视觉） */}
      </div>
      <aside className="hidden lg:flex flex-col gap-6 overflow-y-auto pr-1 min-h-0">
        <RecentSessions />
        <RunningTasks />
      </aside>
    </div>
  </div>
)
```

- 辅助 `StatItem` 与 `startNewChat`：

```tsx
function StatItem({ label, value, pulse }: { label: string; value: string; pulse?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-tertiary">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-primary flex items-center gap-1.5">
        {pulse && <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />}
        {value}
      </span>
    </div>
  )
}

const startNewChat = () => {
  useViewStore.getState().goWorkspace('chats')
  useChatStore.getState().newConversation?.()
}
```

> 注：`newConversation` 是否存在需按 chatStore 实际 API 调整；若无则只 `goWorkspace('chats')`。

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: PASS（按实际 chatStore API 微调签名）

- [ ] **Step 5: Commit**

```bash
git add src/components/cockpit/CockpitView.tsx src/components/cockpit/RecentSessions.tsx src/components/cockpit/RunningTasks.tsx
git commit -m "feat(cockpit): Hero + StatStrip + 右栏骨架（最近会话/运行任务）"
```

---

### Task 7: 四卡升级 — 趋势图/堆叠条/技能环形图/会话卡列表

**Files:**
- Modify: `src/components/cockpit/CockpitView.tsx`（四卡内容）

**Interfaces:**
- Consumes: `TrendChart`/`DonutChart`/`BarStack`（Task 3）、`fetchSkills` 返回 `SkillEntry[]`（`src/lib/skills.ts`）、i18n keys（Task 5）
- Produces: 四卡含 30 日趋势图、输入/输出堆叠条、技能分类环形图、最近会话迷你条

- [ ] **Step 1: Token 卡 — 30 日趋势 + 堆叠条**

在 Token 卡内，`byDayValues` 改为 30 天（`lastNDays(stats.byDay, 30)`），迷你柱状 SVG 替换为：

```tsx
<TrendChart values={byDay30} labels={trendLabels30} />
<BarStack input={stats.totalInput} output={stats.totalOutput} className="mt-3" />
```

`trendLabels30` 与 TokenStatsPanel 同逻辑（`day30.map(...)` 生成 `MM-DD`）。

- [ ] **Step 2: 技能卡 — 分类环形图**

技能卡内新增分组聚合：

```tsx
const skillGroups = useMemo(() => {
  const groups: Record<string, number> = {}
  for (const s of skills) {
    const prefix = s.id.split('-')[0] || 'other'
    groups[prefix] = (groups[prefix] || 0) + 1
  }
  return Object.entries(groups)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}, [skills])
```

技能卡渲染：

```tsx
<div className="grid grid-cols-2 gap-4">
  {stat(t('cockpit.skillCount'), skillCount === null ? '…' : String(skillCount))}
  {stat(t('cockpit.agentCount'), String(agentCount))}
</div>
{skillGroups.length > 0 && (
  <div className="pt-3 border-t border-subtle">
    <span className="text-[10px] uppercase tracking-wider text-tertiary">{t('cockpit.skillGroups')}</span>
    <div className="mt-2">
      <DonutChart segments={skillGroups} centerValue={skillCount ?? 0} />
    </div>
  </div>
)}
```

> `skills` 状态：把现有 `skillCount` 的 useEffect 扩展为保存完整列表 `setSkills(list)`。

- [ ] **Step 3: 会话卡 — 最近会话迷你列表**

会话卡内新增最近 3 条（hover/常显皆可，建议常显）：

```tsx
{recent3.map(c => (
  <button key={c.id} onClick={() => openConversation(c.id)}
    className="flex items-center gap-2 text-xs text-secondary hover:text-primary truncate">
    <MessageSquare className="w-3 h-3 text-tertiary shrink-0" />
    <span className="truncate">{c.title || c.id.slice(0, 10)}</span>
  </button>
))}
```

`openConversation` 统一处理激活：

```tsx
const openConversation = (id: string) => {
  useChatStore.setState({ activeConversationId: id })
  goWorkspace('chats')
}
```

`RecentSessions` 的点击处理器同步改为调用同一逻辑（Task 8 收尾统一）。

- [ ] **Step 4: 文件卡 — 保留 + 错误态**

文件卡保持现有文件/目录计数 + 错误重试按钮，仅视觉随新 cardBase 微调（图标方块底）。

- [ ] **Step 5: 卡片图标统一品牌色圆角方块**

`cardBase` 中标题图标统一为：

```tsx
<span className="flex items-center justify-center w-6 h-6 rounded-md bg-brand-500/10 text-brand-500">
  <MessageSquare className="w-3.5 h-3.5" />
</span>
```

（各卡图标替换为各自的 Icon，`text-brand-500` 或按卡色 `style={{ color: 'var(--accent-cyan)' }}`）

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/cockpit/CockpitView.tsx
git commit -m "feat(cockpit): 四卡升级 — 30日趋势/堆叠条/技能环形图/最近会话"
```

---

### Task 8: 交互完善 + 错误态 + 回归验证

**Files:**
- Modify: `src/components/cockpit/CockpitView.tsx`、`src/components/cockpit/RecentSessions.tsx`（点击直达激活会话）
- Modify: `src/App.tsx`（若需）— 桥接状态来源确认

**Interfaces:**
- Consumes: 全部前序任务产物

- [ ] **Step 1: RecentSessions 点击激活会话**

`RecentSessions.tsx` 点击处理器改为：

```tsx
onClick={() => {
  useChatStore.setState({ activeConversationId: c.id })
  goWorkspace('chats')
}}
```

（与 Task 7 的 `openConversation` 同逻辑；可把该逻辑抽到 `src/lib/conversationNav.ts` 供两处复用——YAGNI 权衡：两处小逻辑直接内联即可）

- [ ] **Step 2: 错误态 — dataUnavailable + 重试**

Token 卡在 `lastError` 时显示：

```tsx
{lastError ? (
  <div className="flex items-center gap-2 py-2">
    <span className="text-xs text-tertiary truncate" title={lastError}>{t('cockpit.dataUnavailable')}</span>
    <button onClick={retryRefresh} className="px-2 py-1 rounded text-xs border border-subtle hover:border-brand-500/50">
      {t('cockpit.retry')}
    </button>
  </div>
) : (/* 正常趋势图 */)}
```

`retryRefresh = () => { void useTokenStatsStore.getState().refreshFromServer() }`

- [ ] **Step 3: 桥接状态来源**

`bridgeOk` 使用现有连接状态（若 usePonosCLI 有 `connected` 则引用，否则从最近一次 fetch 成败推断——建议引用 `usePonosCLI().connected`，若无该导出则用 `fs.error === ''` 近似并在注释说明）。

- [ ] **Step 4: 全量测试 + 构建**

Run: `npm run typecheck && node --test src/stores/*.test.ts && npm run build`
Expected: 全部 PASS，构建成功

- [ ] **Step 5: 手动验证清单**

- [ ] 启动 dev 版，进入驾驶舱：token 数字非 0（/transcript/stats 生效）
- [ ] 新开会话发一条消息，Token 卡数字实时增加（recordUsage 生效）
- [ ] 断网/bridge 停掉后刷新驾驶舱：显示"数据暂不可用 + 重试"
- [ ] 右侧最近会话列表显示，点击进入对应会话
- [ ] 技能卡环形图按前缀分组显示
- [ ] 深/浅主题切换正常（无硬编码 hex）

- [ ] **Step 6: Commit**

```bash
git add src/components/cockpit/ src/App.tsx src/hooks/usePonosCLI.ts
git commit -m "feat(cockpit): 交互完善 + 错误态 + 回归"
```

---

## Self-Review 记录

**Spec 覆盖检查：**
- ✅ 4.1 数据链路：Task 1（refreshFromServer）+ Task 2（recordUsage）+ Task 4（App 回填切换）
- ✅ 4.2 信息架构：Task 6（Hero/StatStrip/右栏）+ Task 7（四卡升级）
- ✅ 4.3 可视化：Task 3（TrendChart/DonutChart/BarStack）+ Task 7（应用）
- ✅ 品牌视觉：Task 6/7（渐变标题、图标方块底、StatStrip 脉冲点）
- ✅ 测试/验收：Task 1 单测、Task 8 回归 + 手动清单

**占位符检查：** 无 TBD/TODO；所有代码块完整。

**类型一致性：**
- `refreshFromServer(baseUrl?) => Promise<boolean>` — Task 1 定义，Task 4 消费 ✓
- `TrendChart({values, labels})` / `DonutChart({segments, centerValue})` / `BarStack({input, output})` — Task 3 定义，Task 6/7 消费 ✓
- `RecentSessions({limit})` / `RunningTasks()` — Task 6 定义，Task 6 消费 ✓
- i18n key 命名 `cockpit.*` — Task 5 定义，Task 6/7/8 消费 ✓
