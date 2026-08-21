// YFW-turbo 两阶段压缩器（docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md §5）
// ---------------------------------------------------------------------------
// 阶段① 免模型结构感知裁剪（ToolResultPruner）：表格采样/代码行边界/JSON 键名+错误行
// 阶段② 主模型摘要：前缀对齐主请求（KV 缓存复用）+ <compacted-summary> 9 节 checkpoint
// 切点纪律：只切 turn 边界；tool-call/result 配对不可拆；open tail 返回 null。
// 日志锁：compaction/start（占位）→ compaction/summary（落地）；孤儿 start 加载回滚。
import { streamMessages } from './api.mjs'

export const COMPACTION_INSTRUCTION =
  '系统压缩指令：请将以下旧对话内容压缩为一份 <compacted-summary> 结构化检查点，' +
  '包含 9 节：Goal / Progress / Blockers / Next Steps / Key Facts / Decisions / Artifacts / Open Questions / Continuation。' +
  '只输出 <compacted-summary> 与 </compacted-summary> 之间的内容，尽可能简短但保留全部关键事实、数字与决策。'

// —— 结构感知裁剪（确定性零成本；按行操作天然不切行中）——
function detectKind(lines) {
  const head = lines.slice(0, 10).join('\n')
  // JSON 优先于逗号表格：多行 JSON / JSONL（每行含逗号且 >20 行）不得被 table 规则抢占（F1-b）。
  // 行首 {/[ 覆盖 pretty JSON 与 JSONL 首行；引号键（"key"/"name"）兜底带前缀包装的 JSON。
  if (/^\s*[{[]/.test(head) || head.includes('"key"') || head.includes('"name"')) return 'json'
  if (/[，,]/.test(head) && lines.length > 20) return 'table'
  if (lines.some((l) => /(ERROR|error|exception|stderr)/.test(l))) return 'log'
  if (/\n[\t ]*(?:const|let|function|class|import|export|def|echo|SELECT)/.test('\n' + head)) return 'code'
  return 'plain'
}

function pruneTable(lines) {
  const kept = [lines[0]]
  const step = Math.max(1, Math.floor((lines.length - 2) / 20))
  for (let i = 1; i < lines.length - 1; i += step) kept.push(lines[i])
  if (lines.length > 1) kept.push(lines[lines.length - 1]) // 合计尾行
  return kept
}
function pruneCode(lines) {
  const headCount = Math.max(5, Math.floor(lines.length * 0.15))
  const tailCount = Math.max(5, Math.floor(lines.length * 0.15))
  return [...lines.slice(0, headCount), '// …（中间省略 ' + (lines.length - headCount - tailCount) + ' 行）…', ...lines.slice(-tailCount)]
}
// 单行 minified JSON → 多行：字符串感知、在顶层结构字符后断行，供行级采样。
// 逐字符跟踪字符串状态（含反斜杠转义），避免把字符串内的逗号/花括号错当结构符。
function reflowSingleLineJson(line) {
  const out = []
  let buf = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      buf += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; buf += c; continue }
    if (c === '{' || c === '[' || c === ',' || c === '}' || c === ']') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      if (c !== ',') out.push(c)
      continue
    }
    buf += c
  }
  if (buf.trim()) out.push(buf.trim())
  return out.length ? out : [line]
}

function pruneJsonOrLog(lines) {
  // 单行超长 JSON：先重排为多行再采样，避免唯一行被 head/tail 去重后整行原样保留——
  // truncated:true 却无尺寸缩减（F1-a）。
  if (lines.length === 1) {
    const trimmed = lines[0].trim()
    if (/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed)) lines = reflowSingleLineJson(trimmed)
  }
  const errLines = lines.filter((l) => /(ERROR|error|exception|stderr)/.test(l))
  const head = lines.slice(0, 30)
  const tail = lines.slice(-10)
  const merged = [...new Set([...head, ...errLines.slice(0, 20), ...tail])]
  return merged.length ? merged : ['…']
}
function prunePlain(lines) {
  return [...lines.slice(0, 50), '…（中间省略 ' + Math.max(0, lines.length - 100) + ' 行）…', ...lines.slice(-50)]
}

export function pruneToolResult(content, { budget = 20000 } = {}) {
  const text = String(content ?? '')
  if (text.length <= budget) return { text, truncated: false, note: '' }
  const lines = text.split('\n')
  const kind = detectKind(lines)
  let keptLines
  if (kind === 'table') keptLines = pruneTable(lines)
  else if (kind === 'code') keptLines = pruneCode(lines)
  else if (kind === 'json' || kind === 'log') keptLines = pruneJsonOrLog(lines)
  else keptLines = prunePlain(lines)
  let out = keptLines.join('\n')
  if (out.length >= text.length) {
    // 兜底：行级采样未带来任何尺寸缩减（如单行 JSON 只有一个超长字符串值，
    // 重排后行数不足以触发头尾采样）→ 字节截断，保证 truncated:true 时尺寸真实下降（F1-a）。
    out = text.slice(0, Math.max(1, Math.floor(text.length * 0.5))) + '\n…（已按字节截断）'
  }
  const note =
    `已截断：原 ${text.length} 字符 / ${lines.length} 行，仅保留结构采样（${out.split('\n').length} 行）。` +
    `可对该片段追问，或我用 Read offset/limit 补读`
  return { text: out, truncated: true, note, kind }
}

// —— 切点纪律 ——
// messages = deriveMessages() 结果（不含 system）。切点 start 处必须是真实 user 消息
// （保留尾巴从新 turn 开始，遮蔽 [0, start) 结束于完整 turn 回复之后）。
// user 角色消息含两种：真实轮次起点 / tool_result 续接——只有前者可作为保留起点，
// 否则会拆散 assistant tool_use 与其 tool_result 配对。
function isTurnStart(m) {
  return m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
}

export function findCutPoint({ messages, retainTokens, estimateMessage }) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const last = messages[messages.length - 1]
  // open tail：最后一条 assistant 带 tool_use → 进行中 turn 不可切
  if (last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b?.type === 'tool_use')) return null
  // 从尾部向前累计保留预算（保留 = [idx, end)）
  let acc = 0
  let idx = messages.length
  while (idx > 0 && acc < retainTokens) { idx--; acc += estimateMessage(messages[idx]) }
  // 起点向后（向更早）对齐到最近完整 turn 边界：保留起点必须是真实 user 消息。
  // 估算位置落在工具回合中间时，把整轮收回保留区，遮蔽区间相应前移——保证
  // assistant tool_use 与其 tool_result 配对不因切点拆散。
  let start = idx
  while (start > 0 && !isTurnStart(messages[start])) start--
  if (start <= 0 || start >= messages.length) return null
  return { start, covered: messages.slice(0, start) }
}

// —— L1-1 关键信息保留：摘要请求注入结构化提示（零成本确定性提取）——
// TodoWrite 整表重写 → 最后调用即权威清单；Write/Edit 记录文件变更；
// 最近 assistant 文本作为决策上下文。todo 取最后 3、文件取最后 8 防溢出。
export function extractKeyInfo(messages = []) {
  const todos = []
  const files = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_use') continue
      const input = b.input || {}
      if (b.name === 'TodoWrite') {
        const items = (Array.isArray(input.todos) ? input.todos : [])
          .map((t) => t?.content ?? t?.task ?? '')
          .filter((x) => String(x).trim())
        if (items.length) todos.push(items.join(' / '))
      } else if (b.name === 'Write' || b.name === 'Edit') {
        files.push(`${b.name} ${input.file_path ?? input.path ?? '?'}`)
      }
    }
  }
  const decisions = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) return m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ')
      return ''
    })
    .filter((t) => t.trim())
    .slice(-2)
  return { todos, files, decisions }
}

export function keyInfoBlock(key) {
  const lines = []
  if (key.todos.length) lines.push(`- 任务清单：${key.todos.slice(-3).join('；')}`)
  if (key.files.length) lines.push(`- 文件变更：${key.files.slice(-8).join('，')}`)
  if (key.decisions.length) lines.push(`- 最近决策：${key.decisions.join(' | ').slice(0, 500)}`)
  if (!lines.length) return ''
  return '（关键信息提示——摘要必须保留以下内容：）\n<key-info>\n' + lines.join('\n') + '\n</key-info>'
}

// —— 摘要请求组装（前缀对齐主请求：system + 旧消息 + 前次摘要 + 指令 + keyInfo）——
export function assembleSummaryRequest({ system, messages, cut, lastSummary, keyInfo = '' }) {
  const covered = cut.covered || []
  const body = []
  if (lastSummary) body.push({ role: 'user', content: `<compacted-summary>${lastSummary}</compacted-summary>` })
  body.push(...covered)
  body.push({
    role: 'user',
    content: COMPACTION_INSTRUCTION + (system ? `\n\n（系统提示开头：${String(system).slice(0, 200)}…）` : '') +
      (keyInfo && keyInfo.trim() ? `\n\n${keyInfo}` : ''),
  })
  return body
}

export function extractSummary(text) {
  const m = String(text ?? '').match(/<compacted-summary>([\s\S]*?)<\/compacted-summary>/)
  return m ? m[1].trim() : null
}

// —— 压缩器编排（pre-step 测压 / forceCompact 溢出兜底）——
export function createCompactor({ session, context, model, maxTokens, wire, health, signal, env = process.env }) {
  let summaryInFlight = false
  let lastSummary = null
  let consecutiveFailures = 0
  // P1-5：压缩熔断——摘要连续失败达到上限即停止（防对不可救药的超限上下文烧 API）。
  // 免模型 pruner 不受熔断影响（零成本）；forceCompact（溢出兜底）熔断后直接拒绝，
  // engine 侧收到 'overflow-compact-failed' 收尾而非无限重试。
  const CIRCUIT_LIMIT = 3

  // usage 逐次累加（input/output/cache），语义与 engine.mjs addUsage 一致
  // （M2：摘要调用是完整 API 请求，其用量并入当前轮统计）
  function addUsage(acc, u = {}) {
    const out = { ...acc }
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      out[k] = (acc[k] ?? 0) + (u[k] ?? 0)
    }
    return out
  }

  async function runSummarizer({ system, messages, cut }) {
    const keyInfo = keyInfoBlock(extractKeyInfo(messages))
    const req = assembleSummaryRequest({ system, messages, cut, lastSummary, keyInfo })
    let buf = ''
    let usage = {}
    for await (const chunk of streamMessages({ model, messages: req, maxTokens, signal, tools: [] })) {
      if (chunk.type === 'text') buf += chunk.text
      else if (chunk.type === 'usage') usage = addUsage(usage, chunk.usage)
    }
    return { text: buf, usage }
  }

  async function summarize({ system, messages }) {
    if (summaryInFlight) return { action: 'none', reason: 'lock' } // 内存锁：拒绝并发压缩
    summaryInFlight = true
    try {
      const window = context.window ?? 200_000
      const retainTokens = Math.floor(window * (context.retainRatio ?? 0.16))
      const cut = findCutPoint({ messages, retainTokens, estimateMessage: context.estimateMessage })
      if (!cut) return { action: 'none', reason: 'no-cut-point' }
      const coveredTokens = context.estimateHistory ? context.estimateHistory(cut.covered) : cut.covered.length * 100
      const retries = Number(env.CLAUDE_CODE_COMPACTION_RETRIES || 3)
      let summary = null
      let converged = false
      let usage = {} // M2：摘要调用用量累计（含收敛重试的多次调用）
      for (let attempt = 0; attempt < retries; attempt++) {
        const { text, usage: callUsage } = await runSummarizer({ system, messages, cut })
        usage = addUsage(usage, callUsage)
        const s = extractSummary(text)
        if (!s) { consecutiveFailures++; continue }
        const summaryTokens = Math.ceil(s.length / 4)
        if (summaryTokens < coveredTokens) { summary = s; converged = true; break }
        consecutiveFailures++
        // 收敛失败：下一次重试靠 COMPACTION_INSTRUCTION 已内嵌"尽可能简短"；此处不再追加
      }
      if (!converged || !summary) {
        consecutiveFailures++
        // 调用已发生（被计费）→ usage 一并返回，engine 侧并入本轮统计
        return { action: 'none', reason: 'no-convergence', failures: consecutiveFailures, usage }
      }
      consecutiveFailures = 0
      // 落地：日志锁（start 占位 → summary 落地 replace）+ 内存锁释放
      // covered 来自 deriveMessages()（对象引用一致），经 session 反查真实 seq。
      // 契约：seqs 必须与 covered 一一对应（数量/顺序）——反查失败必须显式报错，
      // 不得静默提交空/残缺 coveredSeqs（否则压缩"看似成功实则丢消息"）。
      const coveredSeqs = session.seqsForMessages(cut.covered)
      if (!Array.isArray(coveredSeqs) || coveredSeqs.length === 0 || coveredSeqs.length !== cut.covered.length) {
        throw new Error(
          `内核：压缩遮蔽区间 seq 反查失败（covered ${cut.covered.length} 条 → seqs ${coveredSeqs?.length ?? 0} 条）——` +
          'covered 必须来自同一 surface 代的 deriveMessages() 结果'
        )
      }
      session.appendCompactionStart(coveredSeqs)
      session.appendCompactionSummary({ summary, coveredSeqs })
      lastSummary = summary
      // 单通道（FIX R1）：压缩成功后 yfw_summary 只发一次——装配 health 时由
      // health.recordCompaction 代发（并记录 lastSummary），未装配时保留 wire.summary 兜底。
      // 两路互斥，杜绝 yfw_summary 双发（spec §6：compact 成功后 health.recordCompaction 为权威调用点）。
      if (health) health.recordCompaction?.(summary, session.compactCount())
      else wire.summary?.(summary, session.compactCount())
      return { action: 'summarized', summary, compactCount: session.compactCount(), usage }
    } finally {
      summaryInFlight = false
    }
  }

  return {
    // pre-step 测压：先裁剪（阶段①），仍超再摘要（阶段②）
    async maybeCompact({ system, messages }) {
      // P1-5：熔断后仍可跑免模型 pruner（零成本），但跳过主模型摘要
      const circuitOpen = consecutiveFailures >= CIRCUIT_LIMIT
      const window = context.window ?? 200_000
      const threshold = Math.floor(window * (context.thresholdRatio ?? 0.8))
      const est = context.estimate ? context.estimate({ system, messages }) : { total: 0 }
      if (est.total < threshold) return { action: 'none', reason: 'below-threshold' }
      // 阶段① 免模型裁剪（对超大 tool_result 就地替换为结构采样）
      const budget = Number(env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES || env.CLAUDE_CODE_TOOL_RESULT_BUDGET || 20000)
      let prunedAny = false
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (b?.type !== 'tool_result' || typeof b.content !== 'string') continue
          const r = pruneToolResult(b.content, { budget })
          if (r.truncated) {
            b.content = r.text + '\n\n' + r.note
            b.__pruned = true
            prunedAny = true
          }
        }
      }
      if (prunedAny) {
        const est2 = context.estimate({ system, messages })
        if (est2.total < threshold) return { action: 'pruned', reason: 'tool-result-pruned' }
      }
      if (circuitOpen) return { action: 'none', reason: 'circuit-open', failures: consecutiveFailures }
      // 阶段② 主模型摘要
      return summarize({ system, messages })
    },
    // 溢出兜底：跳过阈值判定直接强制压缩；仅当 replaceGeneration 前进（调用方校验）才 retry
    async forceCompact({ system, messages }) {
      if (consecutiveFailures >= CIRCUIT_LIMIT) return { action: 'none', reason: 'circuit-open', failures: consecutiveFailures }
      return summarize({ system, messages })
    },
    lastSummary: () => lastSummary,
  }
}

// —— L2-1 预算配置化：settings.compact { thresholdTokens, reserveTokens, maxToolResults } ——
// 默认对齐现状（0.8 / 0.16 / env 预算）；数值配置按 window 换算 ratio。
export function resolveCompactSettings({ window = 200_000, settings = {}, env = process.env } = {}) {
  const c = settings.compact || {}
  const thresholdTokens = Number(c.thresholdTokens)
  const reserveTokens = Number(c.reserveTokens)
  const maxToolResults = Number(c.maxToolResults)
  const thresholdRatio = Number.isFinite(thresholdTokens) && thresholdTokens > 0
    ? Math.min(1, Math.max(0.01, thresholdTokens / window))
    : 0.8
  const retainRatio = Number.isFinite(reserveTokens) && reserveTokens > 0
    ? Math.min(0.5, Math.max(0.001, reserveTokens / window))
    : 0.16
  const toolResultBudget = Number.isFinite(maxToolResults) && maxToolResults > 0
    ? maxToolResults
    : Number(env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES || 20000)
  return { thresholdRatio, retainRatio, toolResultBudget }
}
