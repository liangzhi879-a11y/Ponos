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

// ---------------------------------------------------------------------------
// 失真档（distortion）——与压力档并列的**独立被测量**（2026-09-12 spec §7）
// 压力回答"还能装多少"，失真回答"还准不准"。血条读压力（tier），建议弹窗读失真
// （distortion.tier）；两个 tier 含义不同，**严禁互相赋值**。
// 契约纯增量：distortion 为可选字段，缺省一律按 green（老内核/老快照不显示任何提示）。
// ---------------------------------------------------------------------------

/** 失真轴：记忆（压缩丢/改事实）、自洽（自相矛盾/陈旧引用）、目标（漂移）。 */
export type DistortionAxis = 'memory' | 'coherence' | 'goal'

export interface DistortionIssue {
  /** 稳定去抖键（如 `m:summary:src/a.ts` / `c:stale:plan.md`）：同键不重复弹卡 */
  id: string
  axis: DistortionAxis
  kind: string
  /** 强证据直通红档；中证据只到 amber（内核侧封顶，前端不重算） */
  strength: 'strong' | 'medium'
  turn: number
  evidence: string
  at: string
}

export interface DistortionInfo {
  score: number
  tier: MeterColor
  axes: Record<DistortionAxis, number>
  issues: DistortionIssue[]
  /** 去抖键；观察期/无证据时为 null（此时即使 red 也不弹卡） */
  trigger: string | null
  /** 观察期截止轮次：回绿后压舱 N 轮，期间复发才重新上报 */
  observeUntilTurn: number | null
  anchorAvailable: boolean
  /** 仅红档附带（省流量）：重新锚定的权威事实文本 */
  anchorText?: string
}

/** 缺省失真档（冻结常量：既保证缺省即健康，又保证引用稳定不触发无谓重渲染）。 */
const GREEN_DISTORTION: DistortionInfo = Object.freeze({
  score: 0,
  tier: 'green' as MeterColor,
  axes: { memory: 0, coherence: 0, goal: 0 },
  issues: [] as DistortionIssue[],
  trigger: null,
  observeUntilTurn: null,
  anchorAvailable: false,
})

const METER_COLORS: MeterColor[] = ['green', 'amber', 'red']

function axisScore(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** 容错读取失真档：任何字段残缺/类型不对都逐字段降级，绝不抛异常（渲染路径）。 */
export function distortionOf(health: HealthInfo | null): DistortionInfo {
  const d = health?.distortion
  if (!d || typeof d !== 'object') return GREEN_DISTORTION
  const tier: MeterColor = METER_COLORS.includes(d.tier as MeterColor) ? (d.tier as MeterColor) : 'green'
  return {
    score: axisScore(d.score),
    tier,
    axes: {
      memory: axisScore(d.axes?.memory),
      coherence: axisScore(d.axes?.coherence),
      goal: axisScore(d.axes?.goal),
    },
    issues: Array.isArray(d.issues) ? d.issues.filter(x => x && typeof x.id === 'string') : [],
    trigger: typeof d.trigger === 'string' && d.trigger ? d.trigger : null,
    observeUntilTurn: typeof d.observeUntilTurn === 'number' ? d.observeUntilTurn : null,
    anchorAvailable: d.anchorAvailable === true,
    ...(typeof d.anchorText === 'string' && d.anchorText ? { anchorText: d.anchorText } : {}),
  }
}

/** 血条角标：amber/red 时点亮并带证据条数（green 不显示；压力红不点亮角标）。 */
export function distortionBadge(health: HealthInfo | null): { show: boolean; count: number; tier: MeterColor } {
  const d = distortionOf(health)
  if (d.tier === 'green') return { show: false, count: 0, tier: 'green' }
  return { show: true, count: d.issues.length, tier: d.tier }
}

/**
 * 是否弹失真建议卡：要求 distortion.tier=red（amber 只显示角标）+ 有去抖键
 * （观察期 trigger=null 时不弹）+ 未在冷却期内 + 该去抖键未展示过。
 */
export function shouldShowDistortionAlert(
  health: HealthInfo | null,
  dismissedUntil: number,
  shownIds: readonly string[],
): boolean {
  const d = distortionOf(health)
  if (d.tier !== 'red') return false
  if (!d.trigger) return false
  if (Date.now() < dismissedUntil) return false
  if (Array.isArray(shownIds) && shownIds.includes(d.trigger)) return false
  return true
}

/** 重新锚定的待发送文本；内核未附带（非红档/老内核）时为空串。 */
export function anchorTextFrom(health: HealthInfo | null): string {
  return distortionOf(health).anchorText ?? ''
}

/**
 * 合并证据清单：按 id 去重、新证据覆盖旧、旧顺序保持、新增追加。
 * 用于把"同一去抖键的新证据"并入已展示清单（卡片逐条可见）。
 */
export function mergeIssues(prev: DistortionIssue[], next: DistortionIssue[]): DistortionIssue[] {
  const out: DistortionIssue[] = []
  const idx = new Map<string, number>()
  const push = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const it of list) {
      if (!it || typeof it.id !== 'string') continue
      const at = idx.get(it.id)
      if (at === undefined) {
        idx.set(it.id, out.length)
        out.push(it)
      } else {
        out[at] = it
      }
    }
  }
  push(prev)
  push(next)
  return out
}
