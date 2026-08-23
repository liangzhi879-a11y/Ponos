// LLM API 统一管理模块 —— 被测 agent 实际调用大模型 API 的单一入口
// ---------------------------------------------------------------------------
// 收敛 4 个 agent（ponos/claude/pi/deepseek）的 API 配置解析，消除 adapter 里
// 各自重复的 "env.X || env.Y || 默认值" 逻辑，并提供：
//   1. .env 加载（benchmark/.env，进程 env 优先，不覆盖已设置变量）
//   2. 密钥解析：按 agent 返回正确的 API key env 变量名 + 值
//   3. 模型解析：统一默认模型，按 agent 映射
//   4. 端点解析：ponos 支持 ANTHROPIC_BASE_URL（DeepSeek 兼容端点）
//   5. 用量→成本换算（与 run.mjs 的 costOf 同源，避免两处漂移）
//   6. 启动前诊断：哪些 agent 缺密钥/缺可执行文件，输出人类可读状态
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const benchmarkRoot = join(__dirname, '..')

// ── 配置项 ────────────────────────────────────────────────────────────────────
// 统一约定（.env 或进程 env）：
//   LLM_API_KEY   主密钥（DeepSeek 官方 key）。缺省回退 ANTHROPIC_AUTH_TOKEN
//   LLM_MODEL     默认模型。缺省 deepseek-v4-flash
//   LLM_BASE_URL  可选，DeepSeek 兼容端点（ponos 内核经 ANTHROPIC_BASE_URL 走它）
// 各 agent 实际使用的 env 变量名由 AGENT_API 表映射，adapter 无需再关心来源。
export const AGENTS = ['ponos', 'claude', 'pi', 'deepseek']

/** 每个 agent 的 API 通道定义 */
export const AGENT_API = {
  // 内核直接调 Anthropic 端点：ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
  ponos: {
    keyEnv: 'ANTHROPIC_AUTH_TOKEN',
    modelEnv: 'ANTHROPIC_MODEL',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    desc: 'kernel/cli.mjs（Anthropic 端点，NDJSON 契约）',
  },
  // claude 官方 CLI：用同一套 Anthropic env
  claude: {
    keyEnv: 'ANTHROPIC_AUTH_TOKEN',
    modelEnv: 'ANTHROPIC_MODEL',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    desc: 'claude CLI（-p 非交互，stream-json）',
  },
  // pi：DeepSeek provider 内置端点，只认 DEEPSEEK_API_KEY
  pi: {
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL', // 适配器显式传 --model，读到哪个用哪个
    desc: 'pi coding-agent（--provider deepseek）',
  },
  // deepseek-harness：同上，DeepSeek key
  deepseek: {
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    desc: 'deepseek-harness（tsx 直跑）',
  },
}

export const DEFAULT_MODEL = 'deepseek-v4-flash'

// ── .env 加载 ──────────────────────────────────────────────────────────────────
// 只填充「进程 env 里不存在」的变量（进程 env 优先）
export function loadDotEnv(file = join(benchmarkRoot, '.env')) {
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf8')
  let loaded = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const k = line.slice(0, eq).trim()
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!k) continue
    if (process.env[k] === undefined) { process.env[k] = v; loaded++ }
  }
  return loaded > 0
}

// ── 统一解析 ──────────────────────────────────────────────────────────────────
/** 主密钥：LLM_API_KEY → ANTHROPIC_AUTH_TOKEN → DEEPSEEK_API_KEY */
export function resolveApiKey() {
  return process.env.LLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY || ''
}

/** 某 agent 运行时注入到子进程 env 的 API key 值（按 AGENT_API.keyEnv 对应） */
export function apiKeyFor(agent) {
  const def = AGENT_API[agent]
  if (!def) return ''
  return def.keyEnv === 'DEEPSEEK_API_KEY'
    ? resolveApiKey()
    : process.env[def.keyEnv] || resolveApiKey()
}

/** 统一默认模型（LLM_MODEL → ANTHROPIC_MODEL → 内置默认） */
export function resolveModel() {
  return process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL
}

/** ponos/claude 的 Anthropic 端点（DeepSeek 兼容端点或官方默认） */
export function resolveBaseUrl() {
  return process.env.LLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || ''
}

/**
 * 为某 agent 构造完整子进程 env（在 baseEnv 之上注入该 agent 需要的 API 变量）。
 * 不污染 baseEnv 本体（返回新对象）。
 */
export function buildAgentEnv(agent, baseEnv = process.env) {
  const env = { ...baseEnv }
  const def = AGENT_API[agent]
  if (def) {
    env[def.keyEnv] = apiKeyFor(agent) || env[def.keyEnv] || ''
    env[def.modelEnv] = resolveModel()
    if (def.baseUrlEnv) {
      const base = resolveBaseUrl()
      if (base) env[def.baseUrlEnv] = base
    }
  }
  env.LLM_MODEL = resolveModel() // 供调试/透传
  return env
}

// ── 用量 → 成本 ───────────────────────────────────────────────────────────────
// 缓存计费：cache_read（命中）按输入价 cacheReadRatio（DeepSeek 约 1/10）计，
// cache_creation（写入缓存）按输入全价计。ponos harness 已累加四类 usage。
export function costOf(usage, pricePerMInput = 0.2, pricePerMOutput = 1.2, cacheReadRatio = 0.1) {
  if (!usage) return null
  return (usage.input_tokens || 0) / 1e6 * pricePerMInput
    + (usage.output_tokens || 0) / 1e6 * pricePerMOutput
    + (usage.cache_read_input_tokens || 0) / 1e6 * pricePerMInput * cacheReadRatio
    + (usage.cache_creation_input_tokens || 0) / 1e6 * pricePerMInput
}

export function usageText(usage) {
  if (!usage) return '—'
  let t = `${(usage.input_tokens || 0).toLocaleString()} in / ${(usage.output_tokens || 0).toLocaleString()} out`
  const cacheRead = usage.cache_read_input_tokens || 0
  if (cacheRead) t += ` / cache ${cacheRead.toLocaleString()}`
  return t
}

// ── 启动前诊断 ────────────────────────────────────────────────────────────────
/**
 * 返回各 agent 的 API 可用性状态：
 *   { agent, ok, key: bool, model, baseUrl, desc, reason }
 * 用于 run.mjs 启动打印 / dashboard /api/meta 展示。
 */
export function diagnoseAgents(agents = AGENTS, { checkBin = false } = {}) {
  return agents.map((a) => {
    const def = AGENT_API[a]
    if (!def) return { agent: a, ok: false, reason: '未知 agent' }
    const key = apiKeyFor(a)
    const model = resolveModel()
    const baseUrl = def.baseUrlEnv ? resolveBaseUrl() : ''
    const issues = []
    if (!key) issues.push('缺 API key')
    // 需要显式端点的 agent（ponos/claude 走 ANTHROPIC_BASE_URL）缺 baseUrl 时
    // 内核会报"未检测到可用协议"直接挂——启动门禁据此拒绝，避免整批无意义结果
    if (def.baseUrlEnv && !baseUrl) issues.push('缺 baseUrl')
    if (checkBin && a === 'pi' && !process.env.PI_CLI_PATH && !existsSync(join(benchmarkRoot, 'vendors', 'pi-src', 'pi-main', 'packages', 'coding-agent', 'dist', 'cli.js'))) {
      issues.push('pi CLI 未构建')
    }
    if (checkBin && a === 'deepseek' && !process.env.DSH_BIN_PATH && !existsSync(join(benchmarkRoot, 'vendors', 'deepseek-src', 'deepseek-harness-master', 'apps', 'cli', 'src', 'bin.ts'))) {
      issues.push('dsh bin 缺失')
    }
    return {
      agent: a, ok: issues.length === 0,
      key: !!key, model, baseUrl: baseUrl || '',
      desc: def.desc,
      reason: issues.join('；') || '',
    }
  })
}

/** 打印诊断表（run.mjs 启动时 / dashboard 启动时） */
export function printDiagnosis(diag) {
  console.log('\n[LLM API] 各 agent 调用通道诊断：')
  for (const d of diag) {
    const mark = d.ok ? '✅' : '⚠️'
    const extra = [d.key ? `key ${d.key ? '已配置' : ''}` : 'key 缺失', `model=${d.model}`]
    if (d.baseUrl) extra.push(`baseUrl=${d.baseUrl}`)
    if (d.reason) extra.push(d.reason)
    console.log(`  ${mark} ${d.agent.padEnd(8)} ${extra.join(' · ')}`)
  }
  console.log('')
}

// 模块加载即加载 .env（后续所有解析都基于它）
loadDotEnv()
