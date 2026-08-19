// src/lib/healthUi.ts
import type { HealthInfo } from '../stores/healthStore.ts'

/** 与内核 HealthTier 一致（统一命名为 amber，避免 yellow/amber 双名混淆）。 */
export type MeterColor = 'green' | 'amber' | 'red'

export interface MeterState {
  widthPct: number
  color: MeterColor
}

export function meterState(health: HealthInfo | null): MeterState {
  if (!health) return { widthPct: 100, color: 'green' }
  const widthPct = Math.max(0, Math.min(100, health.remainingPct))
  const color: MeterColor = health.tier
  return { widthPct, color }
}

export function shouldShowRedAlert(health: HealthInfo | null, dismissedUntil: number): boolean {
  return !!health && health.tier === 'red' && Date.now() >= dismissedUntil
}
