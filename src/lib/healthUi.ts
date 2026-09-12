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

// 注：压力档不再有"弹窗触发器"职责（2026-09-12 spec）——原 shouldShowRedAlert 已删除，
// 血条只读压力档当仪表，一切提醒都由失真档驱动（见下方 shouldShowDistortionAlert）。

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
  /** 同源复发（用户处理过 → 内核标记 resolved → 同样证据再现）：需重新提醒并升级动作 */
  recurred?: boolean
  /** 复发次数（内核递增）。抑制键含次数，故每次复发都能各提醒一次 */
  recurredCount?: number
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
    issues: Array.isArray(d.issues)
      ? d.issues
        .filter(x => x && typeof x.id === 'string')
        .map(x => (x.recurred === true
          ? { ...x, recurred: true, recurredCount: x.recurredCount && x.recurredCount > 0 ? x.recurredCount : 1 }
          : x))
      : [],
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

/** 取 trigger 指向的那条证据（弹窗对象即"最强证据"） */
function triggerIssue(d: DistortionInfo): DistortionIssue | undefined {
  return d.trigger ? d.issues.find(x => x.id === d.trigger) : undefined
}

/**
 * 复发态判定：去抖键指向的那条证据被内核标记 recurred（用户处理过又再现）。
 * 卡片据此升级主行动（重新锚定 → 新建会话），见 spec §8 验收项 6。
 */
export function isRecurred(d: DistortionInfo): boolean {
  return triggerIssue(d)?.recurred === true
}

/**
 * 展示抑制键：与"已展示过"清单比对用。
 * - 首次：`<id>`
 * - 复发：`<id>#recurred<次数>`（次数由内核递增）——每次复发都能各提醒一次；
 *   同一复发态被登记后不再重复弹，避免"处理→内核仍报 red→再弹"的死循环。
 *   （若键里不含次数，第一次复发登记后，第二次起就永远静默了。）
 */
export function distortionSuppressKey(d: DistortionInfo): string | null {
  if (!d.trigger) return null
  const hit = triggerIssue(d)
  if (hit?.recurred !== true) return d.trigger
  return `${d.trigger}#recurred${hit.recurredCount || 1}`
}

/**
 * 是否弹失真建议卡：要求 distortion.tier=red（amber 只显示角标）+ 有去抖键
 * （观察期 trigger=null 时不弹）+ 未在冷却期内（冷却只由显式"关闭"设置）+
 * 该展示抑制键未展示过（复发态用独立键，允许再提醒一次）。
 */
export function shouldShowDistortionAlert(
  health: HealthInfo | null,
  dismissedUntil: number,
  shownIds: readonly string[],
): boolean {
  const d = distortionOf(health)
  if (d.tier !== 'red') return false
  const key = distortionSuppressKey(d)
  if (!key) return false
  if (Date.now() < dismissedUntil) return false
  if (Array.isArray(shownIds) && shownIds.includes(key)) return false
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
