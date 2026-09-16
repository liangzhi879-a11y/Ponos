// provider 行为画像（2026-09-09 本地模型系统性适配）——画像判定/env 映射/身份模板
// 的唯一决策点。纯模块：无 fs、无 process.env 副作用，全部参数显式传入，可直测。
//
// 背景：本地 vLLM 弱模型（Qwen3.8-27B）与云端强模型（deepseek/minimax）的默认假设
// 差异巨大（采样温度、提示词长度、输出预算）。云端行为 = 现状（本模块对 cloud 画像
// 产出空映射，一行 env 都不注入）；本地画像由 bridge 经 buildChildEnv/syncKernelSettings
// 注入 env，内核各消费点（api.mjs/engine.mjs/prompt.mjs/cli.mjs）现读 env，无需改内核解析。
//
// config.json provider 可选字段（本轮无 GUI，手工落标）：
//   profile?: 'auto'|'cloud'|'local'   —— 画像（auto/缺省走启发式）
//   temperature?: number[0,2]          —— 显式采样温度（任何画像生效）
//   maxOutputTokens?: number>0         —— 显式输出预算（任何画像生效）
//   firstByteMs?: number>0             —— 显式首内容宽限（任何画像生效）
//   idleMs?: number>0                  —— 显式生成空闲窗口（任何画像生效）

/** 本模块管理的全部 env 键：syncKernelSettings 写入前须先剔除旧值（防切回云端残留）。 */
export const MANAGED_KEYS = [
  'PONOS_TEMPERATURE',
  'PONOS_PROMPT_TIER',
  'PONOS_PROMPT_CACHE',
  'PONOS_MAX_OUTPUT_TOKENS',
  'PONOS_STREAM_FIRST_BYTE_MS',
  'PONOS_STREAM_IDLE_MS',
  // 画像标记（2026-09-10）：内核 contextWindowFor 按 local/cloud 选保守默认窗口
  // （探测/手配/内置表均未命中时），必须随画像同清同写
  'PONOS_PROVIDER_PROFILE',
]

// 本地画像默认值（云端画像不产出任何键 = 现状）。
// 2026-09-10 循环治理标定：温度 1.0（业界默认，思考模式强制 1）——
// 低确定性降低"失败后原样重复"的循环倾向（旧 0.6 为防贪婪早停标定，与循环倾向
// 冲突，实测对比后弃用）；输出预算 8K（默认档，截断才升级）——短单轮产出
// 让弱模型主线清晰，减少长生成漂移打转。两项均为实测测试值，验证后定标。
const LOCAL_DEFAULTS = {
  PONOS_TEMPERATURE: '1.0',       // 业界默认温度（云端维持 0）
  PONOS_PROMPT_TIER: 'lean',      // 内核精简纪律段（功能协议全保留）
  // PONOS_PROMPT_CACHE 不设：vLLM 前缀缓存是服务端自动行为，客户端 cache_control 标记无意义
  PONOS_MAX_OUTPUT_TOKENS: '8192', // 单轮 8K（业界默认档）；缓解 vLLM KV 调度压力
  // 看门狗窗口不设：内核默认 300s/120s 已按本地 27B prefill 实测标定（engine.mjs）
}

// 云端画像默认值（2026-09-12 对标：业界默认 8K+升档重试 / 另一方案默认 16K /
// 主流实践警告"大输出预算按预分配占用上下文、拖慢 TTFT"）。
// 旧行为：云端不产出任何键 → 内核默认 64000。实测 p99 单轮输出远小于 64K，
// 64K 预留在 DeepSeek 端点上是纯拖累；截断后用户可发「继续」接续，无损。
const CLOUD_DEFAULTS = {
  PONOS_MAX_OUTPUT_TOKENS: '16384', // 单轮 16K（另一方案默认档）；显式 maxOutputTokens 优先
}

const PRIVATE_NET_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|localhost$|\[?::1\]?$)/i
const CLOUD_DOMAIN_RE = /(^|\.)(deepseek\.com|minimaxi\.com|anthropic\.com)$/i
const PUBLIC_IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/

function hostOf(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''))
    return (u.hostname || '').replace(/^\[|\]$/g, '')
  } catch {
    return String(baseUrl || '')
  }
}

/** 画像判定：显式字段优先；auto/缺省启发式（私有网段→local，云域名→cloud，
 *  https+公网 IP→cloud，http 明文→local——自建 vLLM 服务几乎都是明文 http）。 */
export function resolveProviderProfile(provider = {}) {
  const explicit = String(provider.profile || 'auto').toLowerCase()
  if (explicit === 'local' || explicit === 'cloud') return explicit
  const host = hostOf(provider.apiBaseUrl)
  if (!host) return 'cloud'
  if (PRIVATE_NET_RE.test(host)) return 'local'
  if (CLOUD_DOMAIN_RE.test(host)) return 'cloud'
  if (PUBLIC_IP_RE.test(host)) {
    const proto = String(provider.apiBaseUrl || '').toLowerCase().startsWith('https:')
    return proto ? 'cloud' : 'local'
  }
  return 'cloud'
}

function numOrNull(v, { min = 0, max = Infinity } = {}) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

/** 画像 → env 映射。用户进程 env 已有同键时不产出该键（对齐 buildChildEnv
 *  "Explicit user env still wins" 与内核 settings.json 缺失键才兜底的语义）。
 *  PONOS_PROVIDER_PROFILE 例外：任何画像都产出（内核窗口默认分辨率需要）。 */
export function providerProfileEnv(provider = {}, { env = {} } = {}) {
  const out = {}
  const profile = resolveProviderProfile(provider)
  if (env.PONOS_PROVIDER_PROFILE === undefined) out.PONOS_PROVIDER_PROFILE = profile
  if (profile === 'local') {
    for (const [k, v] of Object.entries(LOCAL_DEFAULTS)) {
      if (env[k] === undefined) out[k] = v
    }
  } else {
    for (const [k, v] of Object.entries(CLOUD_DEFAULTS)) {
      if (env[k] === undefined) out[k] = v
    }
  }
  // 显式覆盖字段：任何画像生效（数值非法跳过并告警，宁缺勿崩）
  const t = provider.temperature
  if (t !== undefined && t !== null && t !== '') {
    const n = numOrNull(t, { min: 0, max: 2 })
    if (n === null) console.warn('[provider-profile] invalid temperature, skipped:', t)
    else if (env.PONOS_TEMPERATURE === undefined) out.PONOS_TEMPERATURE = String(n)
  }
  const m = provider.maxOutputTokens
  if (m !== undefined && m !== null && m !== '') {
    const n = numOrNull(m, { min: 1 })
    if (n === null) console.warn('[provider-profile] invalid maxOutputTokens, skipped:', m)
    else if (env.PONOS_MAX_OUTPUT_TOKENS === undefined) out.PONOS_MAX_OUTPUT_TOKENS = String(Math.floor(n))
  }
  const tb = provider.toolResultBudgetBytes
  if (tb !== undefined && tb !== null && tb !== '') {
    const n = numOrNull(tb, { min: 1000 })
    if (n === null) console.warn('[provider-profile] invalid toolResultBudgetBytes, skipped:', tb)
    else if (env.PONOS_TOOL_RESULT_BUDGET_BYTES === undefined) out.PONOS_TOOL_RESULT_BUDGET_BYTES = String(Math.floor(n))
  }
  const f = provider.firstByteMs
  if (f !== undefined && f !== null && f !== '') {
    const n = numOrNull(f, { min: 1 })
    if (n === null) console.warn('[provider-profile] invalid firstByteMs, skipped:', f)
    else if (env.PONOS_STREAM_FIRST_BYTE_MS === undefined) out.PONOS_STREAM_FIRST_BYTE_MS = String(Math.floor(n))
  }
  const i = provider.idleMs
  if (i !== undefined && i !== null && i !== '') {
    const n = numOrNull(i, { min: 1 })
    if (n === null) console.warn('[provider-profile] invalid idleMs, skipped:', i)
    else if (env.PONOS_STREAM_IDLE_MS === undefined) out.PONOS_STREAM_IDLE_MS = String(Math.floor(n))
  }
  return out
}

/** active provider 的模型名（身份提示词插值用）。 */
export function activeProviderModel(cfg = {}) {
  const providers = Array.isArray(cfg.providers) ? cfg.providers : []
  const p = providers.find((x) => x?.id === cfg.activeProvider) || providers[0]
  if (!p) return ''
  return p.primaryModel || (Array.isArray(p.models) && p.models[0]) || ''
}

/** YFWorking 身份提示词（2026-09-09 动态化：模型名经参数插值，不再硬编码
 *  deepseek-v4-flash）。askuser/milestone 协议文本由 bridge 传入拼接（保持
 *  与历史 YFW_SYSTEM_PROMPT 结构一致）。 */
export function buildIdentityPrompt(model, { askuserFormat = '', milestoneProtocol = '' } = {}) {
  const modelName = String(model || '').trim()
  const identityModel = modelName || '用户配置的模型'
  const drivenBy = modelName ? `${modelName} 模型驱动` : '用户配置的模型驱动'
  return `你是 YFWorking（远方工作台），一款自主研发的桌面应用内置 AI 助手。你的底层框架基于 YFWorking Agent SDK，模型由用户配置的第三方 API 提供（当前为 ${identityModel}）。

【身份回答模板】当用户询问"你是谁"或类似问题时，严格使用以下回答：
"我是 YFWorking（远方工作台），基于 YFWorking Agent SDK 构建的 AI 助手，当前由 ${drivenBy}。我可以帮你处理编程、企业咨询材料、系统诊断等各类任务。"

【禁止】你的代码框架借鉴了业界成熟的 Agent 架构设计，但这不意味你就是那个产品。禁止声称自己是任何其他 AI 产品（包括但不限于 Claude、ChatGPT、Copilot、Gemini），禁止使用任何其他公司的品牌名称来描述你的身份。

你好！我是 **YFWorking**（远方工作台），是你桌面应用中的内置 AI 助手，专注于企业咨询项目服务和应用开发。

我可以协助你完成以下类型的工作：
- **企业咨询**：核心表格处理、材料整理、报告撰写、审计核对、申报打包等
- **系统诊断**：磁盘分析、性能监控、进程管理、事件日志检查、网络诊断等
- **开发辅助**：代码编写、文件管理、项目规划等


## 文件操作审批铁律（最高优先级）
- 移动（移动/重命名）任何文件：必须先向用户说明源路径与目标路径，获得用户明确同意后方可执行。
- 删除任何文件：必须先向用户确认将被删除的完整路径与用途，获得用户明确同意后方可执行。
- 未经用户明确审批，禁止执行任何移动或删除文件的操作（包括临时文件、缓存与备份文件）。

${askuserFormat}

${milestoneProtocol}

使用简体中文与用户交流，回答直接、专业、简洁。`
}
