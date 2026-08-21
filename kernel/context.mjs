// YFW-turbo 上下文管理（docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md §5/§6.3）
// ---------------------------------------------------------------------------
// 零依赖纯函数：token 启发式计价（块级密度系数）、模型窗口表、pre-step 压力
// 判定、tokenLedger 四区记账、usage 锚点优化（KV 前缀缓存近似）。全部确定性，
// 无模型调用；engine/compact/health 消费。
export const DEFAULT_WINDOW = 200_000

// 模型窗口表（可扩展）：deepseek-v4-flash=200K / deepseek-v4-pro=1M
export const MODEL_CONTEXT_WINDOWS = {
  'deepseek-v4-flash': 200_000,
  'deepseek-v4-pro': 1_000_000,
}

// contextWindow 来源优先级：CLAUDE_CODE_AUTO_COMPACT_WINDOW（bridge 注入）→ 模型表 → 默认
export function contextWindowFor(model, env = process.env) {
  const injected = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (Number.isFinite(injected) && injected > 0) return injected
  const byModel = MODEL_CONTEXT_WINDOWS[String(model || '')]
  if (byModel) return byModel
  return DEFAULT_WINDOW
}

// 密度系数（默认 text=4 / code=3，可经 env 校准）
function densityOf(env = process.env) {
  const d = { code: 3, text: 4 }
  const code = Number(env.CLAUDE_CODE_TOKEN_DENSITY_CODE)
  const text = Number(env.CLAUDE_CODE_TOKEN_DENSITY_TEXT)
  if (Number.isFinite(code) && code > 0) d.code = code
  if (Number.isFinite(text) && text > 0) d.text = text
  return d
}

// 代码特征检测：行首缩进 + 关键字（高 token 密度内容）；行首=字符串开头或换行后
export function isCodeLike(text) {
  return /(?:^|\n)[\t ]*(?:const|let|var|function|class|import|export|def|func|echo|SELECT|INSERT|UPDATE|DELETE|require|if\s*\()/i.test(String(text))
}

// 块级计价：text/thinking 按 text 密度，代码特征或 tool_result 按 code 密度，
// image/二进制固定 4800 当量；每块 +4。
export function estimateTokens(block = {}, opts = {}) {
  const { env = process.env } = opts
  const density = densityOf(env)
  if (block.type === 'image' || block.type === 'binary') return 4800 + 4
  const raw =
    block.type === 'tool_result'
      ? String(block.content ?? '')
      : String(block.text ?? block.thinking ?? block.content ?? '')
  const per = block.type === 'tool_result' || isCodeLike(raw) ? density.code : density.text
  return Math.ceil(raw.length / per) + 4
}

// 消息级：role +4 + 各块合计（string content 视为单 text 块）
export function estimateMessage(m = {}, opts) {
  const content = m.content
  if (typeof content === 'string') return 4 + estimateTokens({ type: 'text', text: content }, opts)
  if (Array.isArray(content)) return 4 + content.reduce((s, b) => s + estimateTokens(b, opts), 0)
  return 4
}

// 全量启发式
export function estimateHistory(msgs = [], opts) {
  return msgs.reduce((s, m) => s + estimateMessage(m, opts), 0)
}

// 四区记账：system（顶层提示）/ task（本轮 user 输入）/ tool_result / history（其余历史）
// 返回 { total, sections }，供 pre-step 测压与 tokenLedger 入账。
export function estimateRequest({ system = '', messages = [], opts }) {
  let task = 0
  let toolResult = 0
  let history = 0
  const arr = Array.isArray(messages) ? messages : []
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i]
    if (i === arr.length - 1 && m.role === 'user') {
      task += estimateMessage(m, opts)
      continue
    }
    if (Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')) {
      toolResult += estimateMessage(m, opts)
      continue
    }
    history += estimateMessage(m, opts)
  }
  const sections = {
    system: Math.ceil(String(system).length / 4) + 4,
    task,
    tool_result: toolResult,
    history,
  }
  return { total: sections.system + task + toolResult + history, sections }
}

// tokenLedger：四区累计 + tool_result 占比（喂给 health 分区失衡因子）
export function createTokenLedger() {
  const sections = { system: 0, task: 0, tool_result: 0, history: 0 }
  return {
    record(section, tokens) {
      if (Object.prototype.hasOwnProperty.call(sections, section)) sections[section] += tokens
    },
    get(section) { return sections[section] ?? 0 },
    total() { return sections.system + sections.task + sections.tool_result + sections.history },
    toolResultShare() {
      const t = this.total()
      return t === 0 ? 0 : sections.tool_result / t
    },
    sections,
  }
}

// usage 锚点：最近一次成功调用且请求头（system+工具+模型指纹）相同 → 基线 + 尾部增量
export function makeUsageAnchor() {
  let lastHeadKey = null
  let lastInputTokens = 0
  return {
    estimate({ headKey, history }) {
      if (headKey && headKey === lastHeadKey) {
        const tail = Array.isArray(history) ? history.slice(-1) : []
        return { input: lastInputTokens + estimateHistory(tail), anchored: true }
      }
      return { input: estimateHistory(history), anchored: false }
    },
    record({ headKey, inputTokens }) {
      lastHeadKey = headKey ?? null
      lastInputTokens = inputTokens
    },
  }
}

// —— L4-1 上下文预测：token 增长速率 → 预测到达阈值轮数 ——
// recent 形状与 health 一致：[{ usage: { input_tokens } }]；k = 参与均值计算的最近轮数。
export function predictTurns({ recent = [], window = 200_000, thresholdRatio = 0.8, k = 5 } = {}) {
  const usages = (Array.isArray(recent) ? recent : []).map((t) => Number(t?.usage?.input_tokens ?? 0))
  const lastInput = usages.length ? usages[usages.length - 1] : 0
  const threshold = Math.floor(window * thresholdRatio)
  const deltas = []
  for (let i = usages.length - 1; i > 0 && deltas.length < k; i--) deltas.push(usages[i] - usages[i - 1])
  const growthPerTurn = deltas.length ? Math.max(1, Math.round(deltas.reduce((s, d) => s + d, 0) / deltas.length)) : 1000
  const predictedTurns = Math.max(0, Math.floor((threshold - lastInput) / growthPerTurn))
  return { growthPerTurn, predictedTurns, threshold, lastInput }
}
