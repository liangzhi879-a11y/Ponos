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
    baseUrl: (env.PONOS_BASE_URL || '').replace(/\/+$/, ''),
    authToken: env.PONOS_AUTH_TOKEN || env.PONOS_API_KEY || '',
    model: env.PONOS_MODEL || '',
    authScheme: env.PONOS_AUTH_SCHEME === 'bearer' ? 'bearer' : 'x-api-key',
    // 协议相关模型名（Task 1/2）：无配置时为 {}，pickModelName 回落 provider.model
    modelByFormat: {
      ...(env.PONOS_MODEL_OPENAI ? { openai: env.PONOS_MODEL_OPENAI } : {}),
      ...(env.PONOS_MODEL_ANTHROPIC ? { anthropic: env.PONOS_MODEL_ANTHROPIC } : {}),
    },
  }
}

export function getProvider() {
  return state.active || envProvider()
}

export function providerVersion() {
  return state.version
}

/**
 * 设置当前 active provider（热切换；env 不再参与）。
 * @param {{ baseUrl?: any, authToken?: any, model?: any, contextWindow?: any, authScheme?: any }} [opts]
 */
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
//
// ★ 2026-10-02（真机实测事故）播种前加**陈旧比对**（返回值随之改状态对象，旧布尔语义读 `ok`）：
//   本文件的**写入端已随凭据迁移移除**（凭据只经 spawn env / 密码库），磁盘上的最后一份会**永久冻结**
//   —— 若照播，一份数周前的快照会在**每次内核启动时覆盖用户当下的选择**（`setProvider` 一经调用，
//   registry 永久优先于 env）：实测事故 = 用户已切到本地模型（1106），内核仍把全部对话请求发往文件里
//   冻结的旧供应商（旧供应商账户欠费 ⇒ 连本地会话也返回 402）。
//   ⇒ 以「当前选择」（`config.json#activeProvider`，由调用方 `kernel/cli.mjs` 读出传入）与文件声明的
//   `activeProvider` 比对，不一致视为化石、**不播种**（reason:'stale'，供调用方出声）。
//   任一侧缺值 ⇒ 无从比对 ⇒ 照旧（裸跑内核 / 文件或配置缺键的存量形态，语义零变化）。
//   返回值：`{ ok, reason }`（reason ∈ `seeded|missing|unparsable|stale|unusable`；`stale` 时另带
//   `fileActiveProvider` / `currentActiveProvider` 供出声）。
export function seedFromFile(filePath, { env = process.env, expectActiveProvider = null } = {}) {
  if (!filePath || !existsSync(filePath)) return { ok: false, reason: 'missing' }
  let data = null
  try { data = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { return { ok: false, reason: 'unparsable' } }
  const fileActiveProvider = typeof data.activeProvider === 'string' ? data.activeProvider : ''
  if (expectActiveProvider && fileActiveProvider && fileActiveProvider !== expectActiveProvider) {
    return { ok: false, reason: 'stale', fileActiveProvider, currentActiveProvider: expectActiveProvider }
  }
  const active = (data.providers || []).find((p) => p.id === data.activeProvider)
  if (!active || !active.apiBaseUrl || !active.authToken) return { ok: false, reason: 'unusable' }
  // authScheme 先归一再入 setProvider：providers.json 出现未知值时（旧数据/外部写入）
  // 归默认 x-api-key，避免 cli.mjs 启动播种处未 try/catch 直接抛错
  setProvider({
    baseUrl: active.apiBaseUrl,
    authToken: active.authToken,
    model: active.primaryModel || (active.models && active.models[0]) || '',
    contextWindow: active.contextWindow || 0,
    authScheme: normalizeAuthScheme(active.authScheme),
  })
  return { ok: true, reason: 'seeded' }
}

/**
 * 测试专用：清空注册表，回到"每次现读 env"的未激活态。
 *
 * 为什么需要它：`setProvider()` 会**永久**替换进程内的 active provider（设计如此：热切换
 * 后 env 不再参与），而单测里各用例各起一个本机 server（端口不同）⇒ 前一个用例 setProvider
 * 留下的 baseUrl 会让后一个用例的请求打到已关闭的端口（本仓实测：表现为 `fetch failed`
 * 与 16s 级别的假超时，极难归因）。与 `kernel/api.mjs#resetAutoFormatCacheForTest` 同一先例：
 * 生产代码勿调用。
 */
export function resetProviderForTest() {
  state.active = null
  state.version += 1
}

/**
 * 视觉模型 env 解析（**唯一权威**：provider 上报与 Vision 工具/知识库导入都经它）。
 *
 * 为什么同时认 `PONOS_VISION_*` 与 `YFW_VISION_*`（实测缺陷，2026-09-14）：
 * bridge 的 `buildChildEnv` 写进 settings.json 的是 **YFW_VISION_***（server/bridge.mjs:548），
 * 而内核原先只读 `PONOS_VISION_*` ⇒ 用户在设置里明明填了视觉模型（实测 `~/.ponos/settings.json`
 * 里 YFW_VISION_MODEL 已配好），内核却判定"未配置"，Vision 工具只能降级到本地 OCR 并提示用户去配置
 * —— 用户对着已经填好的设置页反复确认。这正是 kernel/health.mjs:79 记录过的同一类坑
 * （bridge 注入 `YFW_HEALTH_COMPACT_COUNT` 与内核读取名不一致），当时的处置也是**内核兼容 YFW_ 前缀**，
 * 这里沿用同一先例：以 PONOS_ 为主（内核原生名）、YFW_ 为兼容回退。
 *
 * 返回 null 表示"未配置"（缺 baseUrl 或 model）；`configured` 另看 token（有些本地网关不需要 token）。
 *
 * `apiFormat`（`PONOS_VISION_API_FORMAT` / `YFW_VISION_API_FORMAT`，2026-09-23 新增）：
 *   视觉端点用哪套协议（`'anthropic' | 'openai'`，缺省/非法空值由 `resolveApiFormat` 归一到
 *   `auto`）。**必须独立于主 provider 的 `PONOS_API_FORMAT`**：Vision 走的是自己的端点，
 *   两者协议可以不同（例：主链路 OpenAI、视觉端点仍 Anthropic）。沿用本函数既有 `pick` 先例，
 *   不另写一套读取。
 * @param {any} [env]
 * @returns {any} 配置对象（含 baseUrl/model/token/configured/apiFormat）或 null = 未配置。
 *   标注 `any` 而非精确形状：调用方普遍写 `visionEnv() || {}`，而 `||` 的联合类型会做
 *   子类型收敛（`{...} | {}` ⇒ `{}`），属性访问随即全报 TS2339（本处 3 条 T1 欠账）。
 */
export function visionEnv(env = process.env) {
  const pick = (name) => (env[`PONOS_${name}`] || env[`YFW_${name}`] || '')
  const baseUrl = pick('VISION_BASE_URL')
  const model = pick('VISION_MODEL')
  if (!baseUrl || !model) return null
  const token = pick('VISION_AUTH_TOKEN')
  // `configured` 沿用原先语义（**有 token** 才算"配置好"），不改动 GUI 的既有判定；
  // 而"能不能调用"看的是 baseUrl+model（见 visionAvailable）—— 本地网关常无 token。
  return { baseUrl, model, token, configured: !!token, apiFormat: pick('VISION_API_FORMAT') }
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
