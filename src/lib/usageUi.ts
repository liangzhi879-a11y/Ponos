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
