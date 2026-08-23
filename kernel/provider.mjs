// kernel/provider.mjs —— 运行时 provider 注册表（docs/production/platform.md P4-5/P4-1）
// 未激活：每次 getProvider() 现读 process.env（保持既有"运行时改 env 生效"语义，
// api-protocol.test.mjs 依赖此行为）。setProvider() 激活后固定 registry 值。
import { existsSync, readFileSync } from 'node:fs'
const state = { active: null, version: 0 }

function envProvider(env = process.env) {
  return {
    baseUrl: (env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, ''),
    authToken: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || '',
  }
}

export function getProvider() {
  return state.active || envProvider()
}

export function providerVersion() {
  return state.version
}

export function setProvider({ baseUrl, authToken, model, contextWindow } = {}) {
  const next = {
    baseUrl: String(baseUrl ?? '').replace(/\/+$/, ''),
    authToken: String(authToken ?? ''),
    model: String(model ?? ''),
    contextWindow: Math.max(0, Number(contextWindow || 0)),
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
  setProvider({
    baseUrl: active.apiBaseUrl,
    authToken: active.authToken,
    model: active.primaryModel || (active.models && active.models[0]) || '',
    contextWindow: active.contextWindow || 0,
  })
  return true
}

// 视觉模型透传：独立 provider（PONOS_VISION_*，bridge buildChildEnv 已注入）→ 上报用对象。
export function visionFromEnv(env = process.env) {
  const baseUrl = env.PONOS_VISION_BASE_URL || ''
  const model = env.PONOS_VISION_MODEL || ''
  if (!baseUrl || !model) return null
  return { baseUrl, model, configured: !!env.PONOS_VISION_AUTH_TOKEN }
}
