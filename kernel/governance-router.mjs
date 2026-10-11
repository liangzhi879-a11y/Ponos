// LoopMode 治理层（2026-10-06 三层循环升级）：置信度驱动的「自动 / 升级人工 / 保持」
// ---------------------------------------------------------------------------
// 设计（spec docs/superpowers/specs/2026-10-06-loop-3layer-upgrade-design.md §1/§3 D12/D13）：
//   · 纯函数、零依赖、无时钟无随机 ⇒ 同一输入必得同一裁决（可复现、可单测）
//   · 影响级别 × 置信度阈值：LOW .60 / MED .75 / HIGH .88（可注入覆盖，便于测试边界）
//   · 模式切换 = LOW 影响；REFLECT 进入 = MED 影响 **且必须有外部信号**（0920 稿：
//     「无外部信号不开 Reflection」）——无信号而被路由建议 ⇒ escalate（请人确认）
//   · escalate 的落地通道复用 ASK_USER（引擎自撰兼容卡 + waitForAnswer）：拒绝/超时
//     = **保持当前模式继续跑**（升级只削减自主权，绝不改变任务推进——安全默认）
//   · 未知影响级别按**最高门槛**从严（宁可多问，不可自作主张）
export const IMPACTS = ['low', 'med', 'high']

/** 三档阈值缺省（与 0920 稿一致；调用方可注入覆盖，测试边界用）。 */
export const DEFAULT_THRESHOLDS = Object.freeze({ low: 0.6, med: 0.75, high: 0.88 })

export const GOVERNANCE_ACTIONS = ['auto', 'escalate', 'stay']

/** 模式中文名（升级卡文案用；未知模式原样）。 */
const MODE_LABELS = { react: 'REACT（常规执行）', plan: 'PLAN（计划模式）', reflect: 'REFLECT（反思模式）' }
export function modeLabel(mode) { return MODE_LABELS[mode] || String(mode ?? '?') }

function clamp01(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/**
 * 治理裁决（纯函数）。
 *
 * @param {object} p
 * @param {number} [p.confidence]   路由置信度（钳制到 [0,1]；非数按 0——宁可多问）
 * @param {string} [p.impact]       'low'|'med'|'high'（未知按最高门槛从严）
 * @param {boolean}[p.externalSignal] 是否有外部信号（失败/停滞证据等）
 * @param {boolean}[p.requiresExternalSignal] 本决策是否以外部信号为前提（REFLECT 进入）
 * @param {{low:number,med:number,high:number}} [p.thresholds]
 * @returns {{action:'auto'|'escalate'|'stay', confidence:number, impact:string,
 *            threshold:number, externalSignal:boolean, requiresExternalSignal:boolean, reason:string}}
 *   · auto     = 免人工，按路由结果执行（置信度达标）
 *   · escalate = 请人确认（缺外部信号 / 未知影响级别的兜底）
 *   · stay     = 不切换、沿用当前模式（低置信；绝不"猜着切"）
 */
export function decideGovernance({ confidence = 0, impact = 'low', externalSignal = false, requiresExternalSignal = false, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const conf = clamp01(confidence)
  const known = IMPACTS.includes(impact)
  const impactKey = known ? impact : 'high' // 未知影响级别从严：按最高门槛
  const threshold = Number(thresholds?.[impactKey]) || DEFAULT_THRESHOLDS.high
  const base = { confidence: conf, impact: impactKey, threshold, externalSignal: !!externalSignal, requiresExternalSignal: !!requiresExternalSignal }
  // 前提缺失优先于阈值：无外部信号而要求信号 ⇒ 升级（请人补上"是否确实要进入"的判断）
  if (requiresExternalSignal && !externalSignal) {
    return { ...base, action: 'escalate', reason: '缺少外部信号（失败/停滞证据），需人工确认' }
  }
  if (conf >= threshold) return { ...base, action: 'auto', reason: `置信度 ${conf.toFixed(2)} ≥ 门槛 ${threshold}` }
  return { ...base, action: 'stay', reason: `置信度 ${conf.toFixed(2)} < 门槛 ${threshold}（低置信不切）` }
}

/**
 * 把一次路由结果送进治理门（引擎轮首唯一入口）。
 * · 路由未产出（失败/兜底/与当前一致）⇒ stay（D14：沿用当前模式）
 * · 进入 REFLECT ⇒ MED 影响 + 必须有外部信号（D13）
 * · 其余模式切换 ⇒ LOW 影响（≥.60 自动）
 *
 * @param {object} p
 * @param {{ok:boolean, mode:string|null, confidence:number, fallback?:boolean}} [p.router]
 * @param {string} [p.currentMode] 当前有效模式
 * @param {boolean}[p.externalSignal]
 * @param {object} [p.thresholds]
 */
export function evaluateRouteGovernance({ router = null, currentMode = 'react', externalSignal = false, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const conf = clamp01(router?.confidence)
  if (!router || !router.ok || !router.mode) {
    return { action: 'stay', confidence: 0, impact: 'low', threshold: Number(thresholds?.low) || DEFAULT_THRESHOLDS.low, externalSignal: !!externalSignal, requiresExternalSignal: false, reason: '路由未产出（沿用当前模式）' }
  }
  if (router.mode === currentMode) {
    return { action: 'auto', confidence: conf, impact: 'low', threshold: Number(thresholds?.low) || DEFAULT_THRESHOLDS.low, externalSignal: !!externalSignal, requiresExternalSignal: false, reason: '路由与当前模式一致（无需切换）' }
  }
  const enteringReflect = router.mode === 'reflect'
  return decideGovernance({
    confidence: conf,
    impact: enteringReflect ? 'med' : 'low',
    externalSignal,
    requiresExternalSignal: enteringReflect,
    thresholds,
  })
}

/**
 * 升级确认卡（ASK_USER 兼容载荷：桥的 extractAskUserBlocks 直接识别，GUI 零改动）。
 * 选项文案是**稳定词根**（approve/keep），interpretEscalationAnswer 据此判定。
 * @param {{mode?:string, confidence?:number, reason?:string, currentMode?:string}} [p]
 */
export function buildEscalationPayload({ mode, confidence = 0, reason = '', currentMode = 'react' } = {}) {
  const conf = clamp01(confidence)
  const why = reason ? `，理由：${String(reason).slice(0, 160)}` : ''
  return {
    context: `循环模式升级确认（当前 ${modeLabel(currentMode)}）`,
    questions: [{
      id: 'loop_mode',
      header: '循环模式确认',
      question: `路由建议切换到 ${modeLabel(mode)}（置信度 ${(conf * 100).toFixed(0)}%）${why}。是否切换？`,
      options: [
        { label: '切换并继续', description: `本轮起采用 ${modeLabel(mode)}` },
        { label: '保持当前模式', description: `继续用 ${modeLabel(currentMode)}，不做切换` },
      ],
      multiSelect: false,
    }],
  }
}

/**
 * 解析升级卡作答 → 是否批准切换。**批准需显式肯定，且否定词优先**（安全默认 = 不切）。
 * @param {string} text
 * @returns {boolean}
 */
export function interpretEscalationAnswer(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (/保持|不切|不用|不要|取消|拒绝|算了|no\b|reject|keep/i.test(t)) return false
  return /切换|确认|同意|可以|好的?|行\b|approve|switch|yes/i.test(t)
}
