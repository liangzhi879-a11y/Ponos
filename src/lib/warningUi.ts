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
