// src/components/cockpit/cockpitNav.ts —— 驾驶舱「主要功能入口」导航载荷解析（纯函数，可单测）
//
// 背景：驾驶舱是 iframe 内自绘 UI（public/cockpit/*），按钮点击要把用户真正带进功能，
// 而不是停在只读详情面板。载荷经 postMessage 上抛，父窗口必须**先解析再导航**——
// iframe 内容可被替换，直接信任 payload 里的字符串会把用户丢进未定义视图。
//
// 纪律（与 viewStore/cockpitNav 的分工）：
//   · 本模块只做**协议层**校验（形状、类型、互斥、不变量），不持有 rail/secondTab 白名单；
//   · 白名单由调用方经 deps 注入（ViewRouter 传 viewStore 的 sanitizeRail/sanitizeSecondTab），
//     ⇒ 合法值只有一处真相源，不会出现"这里加了 rail、那里没加"。纯函数 + 注入 ⇒ 可单测。
//
// 不变量（SecondPanel.tsx:36 只在 rail==='task' 渲染次级浮层）：
//   secondTab 仅在 rail==='task' 时有意义；其余 rail 一律降级为 null，
//   避免写出"配置了却永远不显示"的死状态。

export type CockpitUtilityKind = 'settings' | 'profile'

export const COCKPIT_UTILITY_KINDS: readonly CockpitUtilityKind[] = ['settings', 'profile']

export type CockpitNavSpec =
  | { kind: 'work'; rail: string; secondTab: string | null }
  | { kind: 'utility'; utility: CockpitUtilityKind }

export interface CockpitNavDeps {
  /** rail 合法值判定（调用方传 sanitizeRail 封装） */
  isRail: (v: unknown) => boolean
  /** secondTab 合法值判定（调用方传 sanitizeSecondTab 封装） */
  isSecondTab: (v: unknown) => boolean
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 解析 iframe 上抛的导航消息 → 导航意图；任何非法/不可判定输入返回 null（调用方不动作）。
 * 接受的形状：{ type:'yfw:nav', target:{ rail, secondTab? } } | { type:'yfw:nav', target:{ utility } }
 * rail 与 utility 同时给出时按 rail 处理（功能入口优先于工具窗口），不视为错误。
 */
export function resolveCockpitNav(raw: unknown, deps: CockpitNavDeps): CockpitNavSpec | null {
  if (!isObj(raw)) return null
  if (raw.type !== 'yfw:nav') return null
  const target = raw.target
  if (!isObj(target)) return null

  if (typeof target.rail === 'string' && deps.isRail(target.rail)) {
    const rail = target.rail
    const secondTab =
      rail === 'task' && typeof target.secondTab === 'string' && deps.isSecondTab(target.secondTab)
        ? target.secondTab
        : null
    return { kind: 'work', rail, secondTab }
  }

  if (typeof target.utility === 'string' && COCKPIT_UTILITY_KINDS.includes(target.utility as CockpitUtilityKind)) {
    return { kind: 'utility', utility: target.utility as CockpitUtilityKind }
  }

  return null
}
