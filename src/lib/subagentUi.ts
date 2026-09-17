// 子代理并发上限的 UI 归约纯函数（第 10 项，2026-09-17）。
//
// 与 effortUi 同规则：零依赖（不 import store、不用 '@' alias），便于 node --test 直接跑。
//
// 三值语义必须与桥侧 `normalizeMaxSubAgents`（server/bridge.mjs）**严格一致**，
// 否则会出现"设置页显示 不限、实际注入 4"这类静默错配：
//   'auto' → null（**不注入 env**，内核按系统配置推导 —— 这是推荐默认）
//   '0'    → 0    （不限；与内核 PONOS_LANE_MAX_CONCURRENT 的 0 语义一致）
//   'N'    → N    （1..32；正整数上限）
// 注意"自动"刻意**不用** 0 表示：0 在内核语义里是"不限"，两者混用会直接改变行为。
export const MAX_SUBAGENT_VALUES = ['auto', '1', '2', '3', '4', '6', '8', '12', '16', '0'] as const

export type MaxSubAgentsUi = (typeof MAX_SUBAGENT_VALUES)[number] | string

const clampN = (n: number) => Math.min(32, Math.max(1, Math.floor(n)))

/**
 * 归约任意输入（旧 persist 快照 / 手工改的 config.json / form 值）为 UI 取值。
 * 非法输入一律退回 'auto'（最安全：不注入 env，交内核按系统配置决定）。
 */
export function normalizeMaxSubAgentsUi(v: unknown): MaxSubAgentsUi {
  if (v === null || v === undefined || v === '' || v === 'auto') return 'auto'
  // 只接受数字与数字串：数组/对象/布尔等一律退回 'auto'。
  // 为什么要显式挡：`Number([]) === 0`、`Number(true) === 1`，宽松转换会把非法输入变成
  // '0'（不限）或 '1'（静默串行）——两种都是危险方向。规则与 shared/subagent-concurrency.mjs
  // 的 normalizeMaxSubAgents 保持一致（跨语言，靠两侧用例 + 契约断言锁住）。
  if (typeof v !== 'number' && typeof v !== 'string') return 'auto'
  if (typeof v === 'string' && v.trim() === '') return 'auto'
  const n = Number(v)
  if (!Number.isFinite(n)) return 'auto'
  if (n <= 0) return '0'
  const c = clampN(n)
  // 手工改过 config.json 的值（如 5）保留原样，不静默改写用户配置
  return String(c)
}

/** UI 取值 → 落盘值（null = 自动，0 = 不限，正整数 = 上限）。 */
export function toConfigMaxSubAgents(ui: unknown): number | null {
  const norm = normalizeMaxSubAgentsUi(ui)
  if (norm === 'auto') return null
  const n = Number(norm)
  if (!Number.isFinite(n)) return null
  if (n <= 0) return 0
  return clampN(n)
}

/** 落盘值 → UI 取值（读设置页时用）。与 toConfigMaxSubAgents 互逆（在合法域内）。 */
export function fromConfigMaxSubAgents(cfg: unknown): MaxSubAgentsUi {
  return normalizeMaxSubAgentsUi(cfg)
}

/**
 * 下拉选项（有序）。当前值若不在预设集内（手工改过 config.json），插到 'auto' 之后，
 * 以免设置页把用户的值显示成别的档位。
 */
export function maxSubAgentsOptions(current: unknown): MaxSubAgentsUi[] {
  const norm = normalizeMaxSubAgentsUi(current)
  const base: MaxSubAgentsUi[] = [...MAX_SUBAGENT_VALUES]
  if (base.includes(norm)) return base
  const rest = base.filter((v) => v !== 'auto')
  return ['auto', norm, ...rest]
}

/**
 * 选项文案的 i18n key；数字档返回 null（直接显示数字，无需翻译）。
 */
export function maxSubAgentsLabelKey(v: unknown): string | null {
  const norm = normalizeMaxSubAgentsUi(v)
  if (norm === 'auto') return 'settings.subAgentsAuto'
  if (norm === '0') return 'settings.subAgentsUnlimited'
  return null
}
