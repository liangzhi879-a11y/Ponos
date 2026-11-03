/**
 * L1 参数面（P4，2026-10-27）
 *
 * "L1" = 用户可以自己调、且**改错了也不会毁掉数据**的参数（预算、首选模型）。
 * 本模块是这批参数的**声明单一真源**：默认值、类型、范围、键名都在这里，
 * `kernel/config.mjs` 只负责"把 config.json 读出来"（同其既有分工）。
 *
 * 为什么要有"声明"这一层：演化提案（OPP-11/12 的处置）只允许改**这里登记过的键**。
 * 没有登记表，提案就是一个"能改整个 config.json"的口子 —— 而 config.json 里同时存
 * provider 配置与出网能力开关，整文件覆盖会把用户凭据一起清掉。
 *
 * ★ 纪律：**解析失败/缺键/类型不对 一律回落到默认值**，绝不抛错。
 *   参数面存在的意义是"行为可调"，不是"让应用因为一个键写错就起不来"。
 */

/**
 * @typedef {{ type: 'number', default: number, min: number, max: number, unit?: string, desc: string }
 *   | { type: 'string', default: string | null, pattern?: RegExp, desc: string }} L1ParamSpec
 */

/** @type {Record<string, L1ParamSpec>} */
export const L1_PARAMS = Object.freeze({
  'context.injectBudgetKb': Object.freeze({
    type: 'number',
    default: 96,
    min: 8,
    max: 512,
    unit: 'KB',
    // ★ consumer 是**契约的一部分**：'pending' = 参数已登记但还没有消费方（改了不会改变行为）。
    //   写出来是为了不让界面/文档把"可调"说成"已生效" —— 那是更坏的谎。
    consumer: 'kernel/cli.mjs（**显式设置**时覆盖 ProjectAtlas 注入块预算；未设置=沿用既有预算链，行为不变）',
    desc: '注入上下文预算：每轮最多塞多少 KB 的项目上下文（越大越贵，越小越容易丢上下文）',
  }),
  'model.preferred': Object.freeze({
    type: 'string',
    default: null,
    pattern: /^[A-Za-z0-9._:-]{1,64}$/,
    consumer: 'kernel/cli.mjs（模型四级兜底：--model > preferred > provider.model > settings.model）',
    desc: '首选模型 id；留空 = 跟随当前 provider 的默认模型',
  }),
})

/** 点号键 → 取值（不创建对象，只读）。 */
function readPath(obj, key) {
  let cur = obj
  for (const seg of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/** 点号键 → 写进新对象（沿路补空对象，不改传入对象）。 */
function writePath(obj, key, value) {
  const segs = key.split('.')
  const out = { ...obj }
  let cur = out
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i]
    const next = cur[seg]
    cur[seg] = next && typeof next === 'object' ? { ...next } : {}
    cur = cur[seg]
  }
  cur[segs[segs.length - 1]] = value
  return out
}

/**
 * 单个值是否合法（**不回落到默认**，只判合不合法）：提案面用它拒绝坏值。
 * @returns {{ ok: boolean, code?: string }}
 */
export function checkValue(key, value) {
  const spec = L1_PARAMS[key]
  if (!spec) return { ok: false, code: 'unknown-key' }
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, code: 'bad-type' }
    if (value < spec.min || value > spec.max) return { ok: false, code: 'out-of-range' }
    return { ok: true }
  }
  // string：null 表示"不设"，是合法值（跟随 provider 默认）
  if (value === null) return { ok: true }
  if (typeof value !== 'string') return { ok: false, code: 'bad-type' }
  if (spec.pattern && !spec.pattern.test(value)) return { ok: false, code: 'bad-format' }
  return { ok: true }
}

/**
 * 解析出**生效值**（缺键/坏值一律回落默认，永不抛错）。
 * @param {object|null|undefined} config
 * @param {{ overrides?: Record<string, unknown> }} [opts] 测试与迁移用（不读盘）
 * @returns {Record<string, unknown>}
 */
export function resolveParams(config, { overrides = null } = {}) {
  const src = config && typeof config === 'object' ? config : {}
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(L1_PARAMS)) {
    const raw = overrides && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : readPath(src, key)
    out[key] = checkValue(key, raw).ok ? raw : L1_PARAMS[key].default
  }
  return out
}

/**
 * 校验一份**局部补丁**（`{ 'context.injectBudgetKb': 128 }`）。
 * 提案面在应用前必须过这一关：键必须在册、值必须合法。
 * @param {object} patch
 */
export function validatePatch(patch) {
  /** @type {Array<{ key: string, code: string }>} */
  const errors = []
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: [{ key: '', code: 'not-object' }] }
  }
  const keys = Object.keys(patch)
  if (keys.length === 0) return { ok: false, errors: [{ key: '', code: 'empty' }] }
  for (const key of keys) {
    const r = checkValue(key, patch[key])
    if (!r.ok) errors.push({ key, code: String(r.code) })
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 把补丁合进配置，返回**新对象**（不改入参）。
 *
 * ★ 只写登记过的键：其它字段（providers / activeProvider / network …）原样带过去。
 *   这正是"参数面"与"整文件覆盖"的分界线 —— 后者会顺手清掉凭据。
 * @param {object|null|undefined} config
 * @param {object} patch
 * @returns {{ ok: boolean, config?: object, errors?: Array<{ key: string, code: string }> }}
 */
export function applyPatch(config, patch) {
  const v = validatePatch(patch)
  if (!v.ok) return { ok: false, errors: v.errors }
  let out = config && typeof config === 'object' ? config : {}
  for (const key of Object.keys(patch)) out = writePath(out, key, patch[key])
  return { ok: true, config: out }
}

/**
 * 模型优先级的**唯一实现**（纯函数，便于测试"谁赢"）。
 *
 * 顺序有意如此：`--model`（本次显式指定）> `model.preferred`（用户/演化提议设定的偏好）
 * > `provider.model`（provider 配置自带）> `settings.model`（兼容旧设置）。
 * ★ 关键点：preferred 必须**高于** provider.model，否则"改首选模型"这条提案永远不生效；
 *   又必须**低于** `--model`，否则命令行显式指定会被悄悄盖掉。
 * @param {{ arg?: string|null, preferred?: string|null, providerModel?: string|null, settingsModel?: string|null }} o
 */
export function pickModel({ arg = null, preferred = null, providerModel = null, settingsModel = null } = {}) {
  for (const v of [arg, preferred, providerModel, settingsModel]) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

/** 参数说明（界面/文档用；顺序即声明顺序）。 */
/**
 * 候选 → 参数补丁（P4 闭环的最后一段：让"候选"能自己说出"该改哪个键、改成什么"）。
 *
 * ★ 只对**有消费方**的参数出补丁：
 *   - `model.preferred`：消费方在 `kernel/cli.mjs` 的模型四级兜底里 ⇒ 改了就生效
 *   - `context.injectBudgetKb`：`consumer: 'pending'` ⇒ **拒绝出补丁**，理由是"改了也不改变行为"。
 *     宁可让候选"提不出提案"，也不让用户点一次"应用"却什么也没发生 —— 后者才是真的骗人。
 *
 * @param {{ ruleId?: string, subject?: string|null, metrics?: object }} candidate
 * @param {{ currentPreferred?: string|null }} [ctx]
 * @returns {{ ok: true, patch: Record<string, unknown>, rationale: string } | { ok: false, reason: string }}
 */
/**
 * 只读**用户显式设置**的参数（未设置/非法 ⇒ 该键不出现）。
 *
 * ★ 为什么不能直接用 `resolveParams` 的默认值去接线：默认值代表"我们的建议值"，
 *   一旦拿它去覆盖既有预算链（settings/env 的 injectMaxBytes），**没改配置的人行为也会变** ——
 *   参数面的第一条纪律是"没人改 = 与今天逐字一致"。
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
export function explicitParams(config = {}) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, spec] of Object.entries(L1_PARAMS)) {
    const raw = readPath(config, key)
    if (raw === undefined) continue
    if (!checkValue(key, raw).ok) continue   // 非法 ⇒ 当作没设置（回落默认，而不是报错崩掉）
    out[key] = raw
  }
  return out
}

export function suggestPatchFromCandidate(candidate, { currentPreferred = null } = {}) {
  const ruleId = String(candidate?.ruleId || '')
  const subject = typeof candidate?.subject === 'string' ? candidate.subject : null
  if (ruleId === 'OPP-12') {
    // 模型维度：**只清空我们自己设过的偏好**（回到跟随 provider），不猜"哪个模型更好" ——
    // 猜错会制造新的不匹配，而"回到默认"永远安全。
    if (!currentPreferred) return { ok: false, reason: 'no-preference-set' }
    if (subject && subject !== currentPreferred) return { ok: false, reason: 'subject-is-not-preferred' }
    return {
      ok: true,
      patch: { 'model.preferred': null },
      rationale: `首选模型 ${currentPreferred} 在多个会话里工具调用持续出错 ⇒ 清空偏好，回到跟随 provider 的默认模型`,
    }
  }
  if (ruleId === 'OPP-11') {
    return { ok: false, reason: 'consumer-pending（context.injectBudgetKb 还没有消费方，改了不改变行为）' }
  }
  return { ok: false, reason: 'not-a-param-rule' }
}

/**
 * 注入块预算（字节）的**唯一判定**：显式参数 > 既有预算链；lane（子代理）不超过主预算的 4 倍。
 *
 * @param {{ explicitKb?: number|undefined, fallbackBytes: number, lane?: boolean, laneFallbackBytes?: number }} o
 * @returns {number}
 */
export function atlasBudgetBytes({ explicitKb, fallbackBytes, lane = false, laneFallbackBytes = 0 }) {
  const base = typeof explicitKb === 'number' && Number.isFinite(explicitKb) ? Math.round(explicitKb * 1024) : fallbackBytes
  if (!lane) return base
  // lane（子代理）在显式设置时取"主预算的一半"，但**不低于**原有 lane 后备、**也不超过**主预算：
  // 子代理上下文更小是设计前提，允许它等于或超过主预算等于把这个前提悄悄废掉。
  if (typeof explicitKb !== 'number') return laneFallbackBytes
  return Math.min(base, Math.max(laneFallbackBytes, Math.round(base / 2)))
}

export function paramDescs() {
  return Object.keys(L1_PARAMS).map((key) => ({ key, ...L1_PARAMS[key] }))
}
