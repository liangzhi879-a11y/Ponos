// kernel/model-prices.mjs —— 模型单价三级解析（spec P1-2）
// ---------------------------------------------------------------------------
// 优先级（用户决策）：① provider 显式配置 > ② 内置价表 > ③ env/硬编码估算兜底。
// 现状缺陷：单价只由 env 硬编码（0.2/1.2 USD/M，kernel/cost.mjs:4），而 providers.json
// 无任何价格字段 ⇒ 循环成本数字与实际不符，预算硬停会误停或不停。
// 本模块是纯函数、零依赖：不读文件、不碰网络，便于单测与复用。
// 键归一化：小写 + 去掉 "provider/" 前缀（"deepseek/deepseek-chat" → "deepseek-chat"）。

// 常见模型价表（USD / 百万 token）。数据仅作兜底默认，用户可在 provider 配置里覆盖。
// cacheReadRatio：缓存命中按 input 单价的该比例计费（与 kernel/cost.mjs 语义一致）。
export const BUILTIN_PRICES = {
  'deepseek-chat': { input: 0.27, output: 1.1, cacheReadRatio: 0.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheReadRatio: 0.1 },
  'gpt-4o': { input: 2.5, output: 10, cacheReadRatio: 0.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheReadRatio: 0.5 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheReadRatio: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheReadRatio: 0.1 },
  'qwen-max': { input: 1.6, output: 6.4, cacheReadRatio: 0.0 },
  'glm-4-plus': { input: 0.7, output: 0.7, cacheReadRatio: 0.0 },
}

// 估算兜底（与 cost.mjs 既有默认一致，保证"无配置时行为不变"）
const FALLBACK = { input: 0.2, output: 1.2, cacheReadRatio: 0.1 }

function normalizeKey(model) {
  const s = String(model || '').trim().toLowerCase()
  if (!s) return ''
  const slash = s.lastIndexOf('/')
  return slash >= 0 ? s.slice(slash + 1) : s
}

// 只有有限正数才被采纳；其余（负数/NaN/字符串数字外的值/0）一律视为未配置。
// 0 视为未配置：免费模型应显式走 provider 配置，避免"0 成本"让预算硬停失效。
function posNum(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

// cacheReadRatio 允许 0（= 命中不计费），故单独判定：只排除负数与非数字。
function ratio(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

function envNum(env, key) {
  return posNum(env?.[key])
}

/**
 * @param {string} model 模型名（可含 provider/ 前缀，大小写不敏感）
 * @param {object|null} providerCfg provider 配置，形如 { models:[{ id, inputPricePerM, outputPricePerM, cacheReadRatio }] }
 * @param {object} env 环境变量表（注入以便测试）
 * @returns {{pricePerMInput:number, pricePerMOutput:number, cacheReadRatio:number, source:'provider'|'builtin'|'estimate'}}
 */
export function resolveModelPrices(model, providerCfg = null, env = process.env) {
  const key = normalizeKey(model)
  const builtin = key ? BUILTIN_PRICES[key] : null

  // ① provider 显式配置（按 id 归一化匹配；缺字段逐项回落）
  let cfgEntry = null
  const models = Array.isArray(providerCfg?.models) ? providerCfg.models : []
  if (key) cfgEntry = models.find((m) => normalizeKey(m?.id ?? m?.name) === key) || null

  const cfgIn = posNum(cfgEntry?.inputPricePerM)
  const cfgOut = posNum(cfgEntry?.outputPricePerM)
  const cfgRatio = ratio(cfgEntry?.cacheReadRatio)
  if (cfgIn !== null || cfgOut !== null || cfgRatio !== null) {
    return {
      pricePerMInput: cfgIn ?? builtin?.input ?? envNum(env, 'PONOS_PRICE_PER_M_INPUT') ?? FALLBACK.input,
      pricePerMOutput: cfgOut ?? builtin?.output ?? envNum(env, 'PONOS_PRICE_PER_M_OUTPUT') ?? FALLBACK.output,
      cacheReadRatio: cfgRatio ?? builtin?.cacheReadRatio ?? ratio(env?.PONOS_CACHE_READ_RATIO) ?? FALLBACK.cacheReadRatio,
      source: 'provider',
    }
  }

  // ② 内置价表
  if (builtin) {
    return {
      pricePerMInput: builtin.input,
      pricePerMOutput: builtin.output,
      cacheReadRatio: builtin.cacheReadRatio,
      source: 'builtin',
    }
  }

  // ③ 估算兜底（env 覆盖 → 硬编码默认；UI 据此标注「估算」）
  return {
    pricePerMInput: envNum(env, 'PONOS_PRICE_PER_M_INPUT') ?? FALLBACK.input,
    pricePerMOutput: envNum(env, 'PONOS_PRICE_PER_M_OUTPUT') ?? FALLBACK.output,
    cacheReadRatio: ratio(env?.PONOS_CACHE_READ_RATIO) ?? FALLBACK.cacheReadRatio,
    source: 'estimate',
  }
}

/**
 * 把内核环境变量 PONOS_MODEL_PRICES（bridge 注入的激活 provider 价格表，形如
 * `{"deepseek-chat":{"input":0.27,"output":1.1}}`）解析成 resolveModelPrices 需要的
 * providerCfg 形状（三级解析的第 ① 层，P1-2 闭环）。
 *
 * 任一环节异常 → null（= 回落内置价表/估算），绝不让"价格配错"影响循环运行
 * （全局约束：静默降级）。字段值的合法性与"逐项回落"由 resolveModelPrices 负责。
 *
 * @param {object} env 环境变量表（注入以便测试）
 * @returns {{models: Array<{id:string,inputPricePerM:unknown,outputPricePerM:unknown,cacheReadRatio:unknown}>}|null}
 */
export function parseModelPricesEnv(env = process.env) {
  try {
    const raw = env?.PONOS_MODEL_PRICES
    if (!raw) return null
    const obj = JSON.parse(String(raw))
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const models = Object.entries(obj).map(([id, p]) => ({
      id,
      inputPricePerM: p?.input,
      outputPricePerM: p?.output,
      cacheReadRatio: p?.cacheReadRatio,
    }))
    return models.length ? { models } : null
  } catch { return null }
}
