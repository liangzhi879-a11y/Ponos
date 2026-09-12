// src/lib/approvalModeUi.ts —— 审批放行档位 UI 归约纯函数
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、不 import 任何运行时依赖
//（照 src/lib/effortUi.ts 先例；src/types/index.ts 仅 `import type` 消费本模块）。
//
// 四档语义（与 kernel/approval-mode.mjs、server/approval-mode.mjs 三方一致）：
//   manual  最严：普通 Bash 也问
//   auto         ：写文件 / 网络 / agent 问
//   loose  默认  ：只问高危 Bash + 灾难命令（= 应用今天的真实行为）
//   bypass 最宽  ：连高危 Bash 也不问——**灾难命令仍问**（hard 底线，四档不放开）
// 权威来源是桥：桥上报什么就渲染什么；仅在首次上报前回落 settings.approvalMode。
// 档位的持久化归属：设置页写全局（config.json），状态栏写本会话临时覆盖（仅内存）。
export type ApprovalMode = 'manual' | 'auto' | 'loose' | 'bypass'

/** 逐级放宽的序号；用于"是否在放宽方向"判断（requiresConfirm）。 */
export const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = {
  manual: 0, auto: 1, loose: 2, bypass: 3,
}

export interface ApprovalModeOption {
  value: ApprovalMode
  labelKey: string
  descKey: string
  /** 视觉语义：default 常规 / warning 已放宽 / danger 近乎全放行 */
  tone: 'default' | 'warning' | 'danger'
}

export const APPROVAL_MODE_OPTIONS: ApprovalModeOption[] = [
  { value: 'manual', labelKey: 'approvalMode.manual', descKey: 'approvalMode.manualDesc', tone: 'default' },
  { value: 'auto', labelKey: 'approvalMode.auto', descKey: 'approvalMode.autoDesc', tone: 'default' },
  { value: 'loose', labelKey: 'approvalMode.loose', descKey: 'approvalMode.looseDesc', tone: 'warning' },
  { value: 'bypass', labelKey: 'approvalMode.bypass', descKey: 'approvalMode.bypassDesc', tone: 'danger' },
]

/** 与桥/kernel 的 DEFAULT_APPROVAL_MODE 一致（等价现状 → 存量用户零行为变化）。 */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'loose'

export const APPROVAL_MODES: ApprovalMode[] = APPROVAL_MODE_OPTIONS.map(o => o.value)

/** 非法/缺失 → DEFAULT（不是最严）：兜底必须与内核 normalizeApprovalMode 同向，
 *  否则旧快照或脏配置会凭空把用户降级成 manual 而到处弹窗。 */
export function normalizeApprovalMode(v: unknown): ApprovalMode {
  return APPROVAL_MODES.includes(v as ApprovalMode) ? (v as ApprovalMode) : DEFAULT_APPROVAL_MODE
}

/** 提级（放宽方向）到 loose/bypass 需要二次确认：越宽松越容易"忘了自己在哪档"。
 *  收紧方向（manual/auto）永远不需要确认——用户是在加审批，不是减。 */
export function requiresConfirm(from: ApprovalMode, to: ApprovalMode): boolean {
  return APPROVAL_MODE_RANK[to] > APPROVAL_MODE_RANK[normalizeApprovalMode(from)]
    && (to === 'loose' || to === 'bypass')
}

/** 桥上报的会话档位（approval-mode-changed 的 data 载荷）。 */
export interface SessionApprovalMode {
  mode: ApprovalMode
  /** true = 本会话临时覆盖（仅内存，会话结束回落全局） */
  override: boolean
}

/** 解析桥上报载荷；无有效档位 → null（调用方保留旧值，不被脏帧清空）。 */
export function parseApprovalModeReport(data: unknown): SessionApprovalMode | null {
  if (!data || typeof data !== 'object') return null
  const d = data as { mode?: unknown; override?: unknown }
  if (!APPROVAL_MODES.includes(d.mode as ApprovalMode)) return null
  return { mode: d.mode as ApprovalMode, override: d.override === true }
}

/** 状态栏/设置页共同渲染依据：会话上报优先，无上报回落全局。
 *  isOverride 决定是否显示「临时」标记（会话结束后会自己消失）。 */
export function effectiveModeForSession(input: {
  session?: SessionApprovalMode | null
  globalMode?: unknown
}): { mode: ApprovalMode; isOverride: boolean; global: ApprovalMode } {
  const global = normalizeApprovalMode(input.globalMode)
  if (input.session && APPROVAL_MODES.includes(input.session.mode)) {
    return { mode: input.session.mode, isOverride: input.session.override === true, global }
  }
  return { mode: global, isOverride: false, global }
}
