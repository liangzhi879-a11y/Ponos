// kernel/provider.mjs —— 运行时 provider 注册表（docs/production/platform.md P4-5/P4-1）
// 未激活：每次 getProvider() 现读 process.env（保持既有"运行时改 env 生效"语义，
// api-protocol.test.mjs 依赖此行为）。setProvider() 激活后固定 registry 值。
import { existsSync, readFileSync } from 'node:fs'
const state = { active: null, version: 0 }

// 鉴权方式：多数 Anthropic 兼容端点（anthropic.com/DeepSeek/MiniMax 等）认
// x-api-key 头；vLLM 等本地服务的 Anthropic 端点只认 Authorization: Bearer。
// 默认 x-api-key（保持既有行为），本地 Bearer-only 端点配置为 'bearer'。
export const AUTH_SCHEMES = ['x-api-key', 'bearer']

export function normalizeAuthScheme(v) {
  return v === 'bearer' ? 'bearer' : 'x-api-key'
}

// 由 provider 对象生成鉴权头（单一纯函数，供 api.mjs 主对话流与测试共用）。
// bearer 值时兼容 token 已带 / 未带 "Bearer " 前缀两种写法；null/缺省兜底 x-api-key。
export function authHeaders(provider = {}) {
  provider = provider || {}
  const token = String(provider.authToken ?? '')
  if (normalizeAuthScheme(provider.authScheme) === 'bearer') {
    return { authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}` }
  }
  return { 'x-api-key': token }
}

function envProvider(env = process.env) {
  return {
    baseUrl: (env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, ''),
    authToken: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || '',
    authScheme: env.ANTHROPIC_AUTH_SCHEME === 'bearer' ? 'bearer' : 'x-api-key',
  }
}

export function getProvider() {
  return state.active || envProvider()
}

export function providerVersion() {
  return state.version
}

export function setProvider({ baseUrl, authToken, model, contextWindow, authScheme } = {}) {
  if (authScheme != null && !AUTH_SCHEMES.includes(authScheme)) {
    throw new Error(`provider: authScheme 仅支持 x-api-key|bearer，got ${authScheme}`)
  }
  const next = {
    baseUrl: String(baseUrl ?? '').replace(/\/+$/, ''),
    authToken: String(authToken ?? ''),
    model: String(model ?? ''),
    contextWindow: Math.max(0, Number(contextWindow || 0)),
    authScheme: normalizeAuthScheme(authScheme),
  }
  if (!/^https?:\/\//.test(next.baseUrl)) throw new Error(`provider: baseUrl 必须为 http(s) 地址，got ${next.baseUrl}`)
  if (!next.authToken) throw new Error('provider: authToken 不能为空')
  if (!next.model) throw new Error('provider: model 不能为空')
  state.active = next
  state.version += 1
  return { provider: state.active, version: state.version }
}

// —— P4-1 配置传递链：bridge 落盘的 providers.json 播种注册表（未激活时生效） ——
export function seedFromFile(filePath, { env = process.env } = {}) {
  if (!filePath || !existsSync(filePath)) return false
  let data = null
  try { data = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { return false }
  const active = (data.providers || []).find((p) => p.id === data.activeProvider)
  if (!active || !active.apiBaseUrl || !active.authToken) return false
  // authScheme 先归一再入 setProvider：providers.json 出现未知值时（旧数据/外部写入）
  // 归默认 x-api-key，避免 cli.mjs 启动播种处未 try/catch 直接抛错
  setProvider({
    baseUrl: active.apiBaseUrl,
    authToken: active.authToken,
    model: active.primaryModel || (active.models && active.models[0]) || '',
    contextWindow: active.contextWindow || 0,
    authScheme: normalizeAuthScheme(active.authScheme),
  })
  return true
}

/**
 * 视觉模型 env 解析（**唯一权威**：provider 上报与 Vision 工具/知识库导入都经它）。
 *
 * 为什么同时认 `PONOS_VISION_*` 与 `YFW_VISION_*`（实测缺陷，2026-09-14）：
 * bridge 的 `buildChildEnv` 写进 settings.json 的是 **YFW_VISION_***（server/bridge.mjs:548），
 * 而内核原先只读 `PONOS_VISION_*` ⇒ 用户在设置里明明填了视觉模型（实测 `~/.yfw/settings.json`
 * 里 YFW_VISION_MODEL 已配好），内核却判定"未配置"，Vision 工具只能降级到本地 OCR 并提示用户去配置
 * —— 用户对着已经填好的设置页反复确认。这正是 kernel/health.mjs:79 记录过的同一类坑
 * （bridge 注入 `YFW_HEALTH_COMPACT_COUNT` 与内核读取名不一致），当时的处置也是**内核兼容 YFW_ 前缀**，
 * 这里沿用同一先例：以 PONOS_ 为主（内核原生名）、YFW_ 为兼容回退。
 *
 * 返回 null 表示"未配置"（缺 baseUrl 或 model）；`configured` 另看 token（有些本地网关不需要 token）。
 */
export function visionEnv(env = process.env) {
  const pick = (name) => (env[`PONOS_${name}`] || env[`YFW_${name}`] || '')
  const baseUrl = pick('VISION_BASE_URL')
  const model = pick('VISION_MODEL')
  if (!baseUrl || !model) return null
  const token = pick('VISION_AUTH_TOKEN')
  // `configured` 沿用原先语义（**有 token** 才算"配置好"），不改动 GUI 的既有判定；
  // 而"能不能调用"看的是 baseUrl+model（见 visionAvailable）—— 本地网关常无 token。
  return { baseUrl, model, token, configured: !!token }
}

// 视觉模型透传：独立 provider（PONOS_VISION_*，bridge buildChildEnv 已注入）→ 上报用对象。
export function visionFromEnv(env = process.env) {
  const v = visionEnv(env)
  if (!v) return null
  return { baseUrl: v.baseUrl, model: v.model, configured: v.configured }
}

/** 视觉是否可用（粗判：baseUrl + model 齐备）。调用方据此决定"要不要走视觉"，避免无谓开销。 */
export function visionAvailable(env = process.env) {
  return !!visionEnv(env)
}
