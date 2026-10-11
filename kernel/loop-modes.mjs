// LoopMode（2026-10-06 三层循环升级·执行层）：REACT / PLAN / REFLECT 的模式化面
// ---------------------------------------------------------------------------
// 设计纪律（与 loop-profile.mjs 同源）：
//   · 纯数据 + 纯函数，零第三方依赖；不引用 engine 闭包（可单测）
//   · v1 所有模式**共享 MAIN_PROFILE.guards**：runPhaseGuards 对空相位**抛错**
//     （loop-core.mjs:555）⇒ 「某模式少要几个守卫」只能靠删名表达，而删名=静默丢守卫，
//     故不表达；模式差异 v1 只在**指令注入**（+ 观测量）。compactor/health/stop 槽位
//     是 D15 的后续扩展点，届时也须逐相位列满。
//   · `react` 与现状**同身份**：profileForMode('react') === MAIN_PROFILE（=== 比较通过）
//     ⇒ 默认轮（auto→react）零行为变更，这是本升级的零回归基线。
//
// 与 loop.mjs（/loop 长任务）无关：那是 lane/循环任务特性（LANE_PROFILE + loop 控制器）；
// 本模块只服务**对话主循环**的模式选择（engine runTurnInternal 轮首）。
import { MAIN_PROFILE, validateProfile } from './loop-profile.mjs'

/** 实际模式（决定 profile 与指令）。顺序 = 展示序（默认在前）。 */
export const LOOP_MODES = ['react', 'plan', 'reflect']

/**
 * 选择器全集 = `auto` + 实际模式。`auto` 不是模式，是"交还引擎路由判定"的选择态
 * （用户钉住 plan/react/reflect 时覆盖路由；auto 时由 mode-router 每用户轮判定）。
 */
export const LOOP_MODE_SELECTORS = ['auto', ...LOOP_MODES]

/** 缺省选择态（用户未指定）：交还路由。 */
export const DEFAULT_LOOP_MODE = 'auto'

/** 缺省实际模式：=== 现状行为（零回归基线）。 */
export const DEFAULT_EFFECTIVE_MODE = 'react'

/**
 * 是否**实际模式**（react|plan|reflect，不含 auto）。
 * 存在理由：路由层返回的 mode 在类型上是 `string|null`（JSON 经运行期白名单校验才可信），
 * 引擎要把它收进 loopMode 闭包/轮 meta（联合字面量类型）——类型谓词让这个收窄由**校验**
 * 完成（编译期与运行期同一判据），而不是靠 JSDoc 的 `@type` 断言把类型静默写成谎话。
 * 行为上与 `LOOP_MODES.includes` 等价：空值/未知值一律 false（调用方保持当前模式）。
 * @param {unknown} v
 * @returns {v is 'react'|'plan'|'reflect'}
 */
export function isEffectiveLoopMode(v) {
  return typeof v === 'string' && LOOP_MODES.includes(v)
}

/**
 * 归一化选择器值。**非法值返回 null**（不静默改档——回落策略由调用方决定并上报，
 * 与 approval_mode 的 rejected 事件同款纪律；静默回落会让"档位没生效"无人可见）。
 * @param {unknown} value
 * @returns {null | 'auto' | 'react' | 'plan' | 'reflect'}
 */
export function normalizeLoopMode(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return LOOP_MODE_SELECTORS.includes(v) ? /** @type {any} */ (v) : null
}

/** 编排选择态前缀（字面量小写；2026-10-07 编排扩展）。 */
export const CUSTOM_LOOP_MODE_PREFIX = 'custom:'

/** workflowId 形态白名单 = server `SAFE_ID` 的**形态**（`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`）。
 *  只做形态：保留字/Windows 设备名/尾点等**存储层规则**不在此判（轮首解析自然承接）。 */
const CUSTOM_LOOP_MODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 解析编排模式选择态 `custom:<workflowId>`（2026-10-07 编排扩展）。
 * 与 `normalizeLoopMode` **并列**（custom 不是第四个枚举值）：接受点统一写
 * `normalizeLoopMode(v) ?? parseCustomLoopMode(v)`。
 * · 只做**形态校验**——workflowId 是否存在**不在此判**（轮首由会话工作流引擎解析，见契约 §2.2 ★）；
 * · **保留大小写**（workflowId 是磁盘目录名）；前缀 `custom:` 为字面量小写（不做大小写不敏感匹配）；
 * · 非法返回 null（不静默改档——回落策略由调用方决定并上报，同 normalizeLoopMode 纪律）。
 * @param {unknown} value
 * @returns {string | null} `custom:<workflowId>`（已定型）
 */
export function parseCustomLoopMode(value) {
  const v = String(value ?? '').trim()
  if (!v.startsWith(CUSTOM_LOOP_MODE_PREFIX)) return null
  const id = v.slice(CUSTOM_LOOP_MODE_PREFIX.length)
  return CUSTOM_LOOP_MODE_ID_RE.test(id) ? CUSTOM_LOOP_MODE_PREFIX + id : null
}

/**
 * 取编排选择态的 workflowId（已定型值）；非编排形态返回 null。
 * 引擎轮首 / CLI 诊断用——避免各调用点各自 slice 前缀（前缀只此一处）。
 * @param {unknown} value
 * @returns {string | null}
 */
export function customLoopModeId(value) {
  const v = parseCustomLoopMode(value)
  return v === null ? null : v.slice(CUSTOM_LOOP_MODE_PREFIX.length)
}

/** 模式指令文本（代码维护，非 LLM 生成——ai-agent-book「状态栏由代码维护」纪律）。
 * 只在**模式语境变化**时注入一次（见 engine 轮首），故 react 文案按"回到常规执行"读。 */
const MODE_DIRECTIVES = {
  react: '【循环模式·REACT】当前为常规执行：直接推进任务——需要工具就调用、拿到结果继续，直到完成或需要用户决策。',
  plan: '【循环模式·PLAN】当前为计划模式：动手前先给出一个简短可读的执行计划（条目化），随进展更新；按计划逐项执行，计划有变化时同步说明。',
  reflect: '【循环模式·REFLECT】当前为反思模式：先复盘先前的失败/停滞链路（发生了什么、为什么、哪种做法证明无效），写成简短结论，再提出并执行一条与已失败做法不同的推进路径；不要重复无效做法。',
}

/**
 * 取模式指令文本。未知模式返回 null（调用方按"无指令可注入"处理，不猜）。
 * @param {string} mode
 * @returns {string | null}
 */
export function modeDirective(mode) {
  return MODE_DIRECTIVES[mode] ?? null
}

/** 非 react 模式的 profile 缓存（同模式同对象：稳定 + 免重复校验）。 */
const PROFILE_CACHE = new Map()

/**
 * 模式 → LoopProfile。
 * · `react` → **MAIN_PROFILE 本体**（同身份，零回归基线的硬保证）。
 * · `plan`/`reflect` → 由 MAIN_PROFILE 派生（守卫集逐项拷贝、其余配置相同 + `mode` 标记），
 *   派生即过 `validateProfile`——坏 profile 在这里早失败，而不是在轮中静默丢守卫。
 * · 未知模式 → 回落 react（调用方上游已归一；此处是防御，不是策略）。
 * ★ 只允许在**轮首**调用（engine 每轮恰好一次）——轮中切换 profile 会让守卫计数与
 *   相位状态失去一致性（守卫计数器是轮级闭包局部量）。
 * @param {string} mode
 * @returns {import('./loop-profile.mjs').LoopProfile}
 */
export function profileForMode(mode) {
  if (!LOOP_MODES.includes(mode) || mode === DEFAULT_EFFECTIVE_MODE) return MAIN_PROFILE
  let p = PROFILE_CACHE.get(mode)
  if (p) return p
  p = {
    ...MAIN_PROFILE,
    guards: {
      iterHead: [...MAIN_PROFILE.guards.iterHead],
      inStream: [...MAIN_PROFILE.guards.inStream],
      afterStream: [...MAIN_PROFILE.guards.afterStream],
    },
    compactor: { ...MAIN_PROFILE.compactor },
    health: { ...MAIN_PROFILE.health },
    inject: { ...MAIN_PROFILE.inject },
    mode,
  }
  const v = validateProfile(p)
  if (!v.ok) throw new Error(`profileForMode(${mode}) 产出非法 profile：${v.errors.join('；')}`)
  PROFILE_CACHE.set(mode, p)
  return p
}
