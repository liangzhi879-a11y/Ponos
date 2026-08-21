// YFW-turbo LLM API 客户端（docs/bridge-contract.md §2 buildChildEnv 注入的 provider env）
// ---------------------------------------------------------------------------
// 以 Anthropic Messages API 兼容协议调上游（ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN + ANTHROPIC_MODEL）。OpenAI 兼容端点已删除（2026-08-20 实测
// deepseek OpenAI 端点带 tools 时高概率 thinking-only 空回复，见 zz-smoke 冒烟记录），
// SSE 流式解析后产出结构化 chunk：
//   { type: 'text',     text }      已累积的文本段（按段落/阈值切分）
//   { type: 'thinking', text }      推理模型的思考块（deepseek 等）
//   { type: 'usage',    usage }     最终 token 用量（input_tokens/output_tokens）
// engine.mjs 消费该流并转发 wire.assistant，不感知具体 provider 流式格式。
// YFW_MOCK_API=1：内置幂等 mock 流（引擎测试用，无网络）。
import { abortError } from './protocol.mjs'

const MOCK_SLEEP_MS = 30

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// 将 SSE 文本增量累积并按段落边界切分：产出 1..n 个 {type:'text'} chunk
function* segmentText(buffer) {
  let rest = buffer
  while (true) {
    const idx = rest.indexOf('\n\n')
    if (idx < 0) return rest
    const seg = rest.slice(0, idx + 2)
    rest = rest.slice(idx + 2)
    if (seg.trim()) yield { type: 'text', text: seg }
  }
}

// 协议检测：仅 Anthropic 兼容协议（deepseek 等 provider 的 /anthropic 端点）
export function detectProtocol(env = process.env) {
  return env.ANTHROPIC_BASE_URL ? 'anthropic' : null
}

// usage 归一化：扩展 cache_read/cache_creation（deepseek 系）
function normalizeUsage(u = {}) {
  const cacheRead = u.cache_read_input_tokens ?? 0
  return {
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read_input_tokens: cacheRead ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

// Anthropic Messages 事件流纯解析器（闭包状态：tool 累积/textBuf/usage）
export function createAnthropicParser() {
  let tool = null // { id, name, inputJson }
  let textBuf = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  let stopReason = null
  return {
    feed(payload) {
      const out = []
      const dt = payload.delta
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        tool = { id: payload.content_block.id, name: payload.content_block.name, inputJson: '' }
      } else if (payload.type === 'content_block_delta' && dt) {
        if (dt.type === 'text_delta' && dt.text) {
          textBuf += dt.text
          for (const seg of segmentText(textBuf)) { textBuf = ''; out.push(seg) }
        } else if (dt.type === 'thinking_delta' && dt.thinking) {
          out.push({ type: 'thinking', text: dt.thinking })
        } else if (dt.type === 'input_json_delta' && tool && dt.partial_json) {
          tool.inputJson += dt.partial_json
        }
      } else if (payload.type === 'content_block_stop' && tool) {
        let input = {}
        try { input = tool.inputJson ? JSON.parse(tool.inputJson) : {} } catch {}
        out.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
        tool = null
      } else if (payload.type === 'message_start' && payload.message?.usage) {
        usage = normalizeUsage(payload.message.usage)
      } else if (payload.type === 'message_delta') {
        // stop_reason 在 message_delta 才可靠（content_block_stop 时恒为 null）
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
        if (payload.usage) {
          usage = normalizeUsage(payload.usage)
          out.push({ type: 'usage', usage })
        }
      }
      return out
    },
    finish() {
      const out = []
      if (textBuf.trim()) out.push({ type: 'text', text: textBuf })
      textBuf = ''
      return out
    },
    usage() { return usage },
    stopReason() { return stopReason },
  }
}

const MOCK_USAGE = { input_tokens: 10, output_tokens: 20 }

// 模拟流式文本：切 3 段，段间短暂停顿使 cancel 可中断
async function* streamText(text, signal) {
  const step = Math.max(1, Math.ceil(text.length / 3))
  let rest = text
  while (rest) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    if (signal?.aborted) throw abortError()
    yield { type: 'text', text: rest.slice(0, step) }
    rest = rest.slice(step)
  }
}

async function* mockStream({ messages, signal }) {
  // 瞬时错误模拟（P0-1 retry 测试）：YFW_MOCK_TRANSIENT=once 首次调用抛网络层错误
  if (process.env.YFW_MOCK_TRANSIENT === 'once' && process.env.YFW_MOCK_TRANSIENT_CONSUMED !== '1') {
    process.env.YFW_MOCK_TRANSIENT_CONSUMED = '1'
    const err = new Error('内核：API 请求失败 503 fetch failed')
    err.status = 503
    throw err
  }
  // tool_result user 消息不是"新轮次"：计数与 lastText 提取都要跳过（工具循环
  // 中间条目落盘后，tool_result 以 user 角色进入模型输入，不得算作用户新轮次）
  const realUser = (messages || []).filter(
    (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
  )
  const lastUser = realUser[realUser.length - 1]
  const lastContent = lastUser?.content
  const lastText = typeof lastContent === 'string'
    ? lastContent
    : (Array.isArray(lastContent) ? lastContent.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
  // 工具结果回合：仅当"最后一条消息"为 tool_result 轮才报告执行结果（引擎工具
  // 循环第二轮）。不得用"历史中任意 tool_result"判定——跨轮连续调用 [mock:tool]
  // 时，上一轮被拒绝的 tool_result 残留在历史里，会让 mock 误走结果回显分支而
  // 永远不再产出 tool_use（denial 降级测试复现，2026-08-21 修复）。
  const lastMessage = (messages || [])[messages.length - 1]
  const lastIsToolResult = lastMessage?.role === 'user' &&
    Array.isArray(lastMessage.content) && lastMessage.content.some((b) => b?.type === 'tool_result')
  if (lastIsToolResult) {
    const firstBlock = lastMessage.content.find((b) => b?.type === 'tool_result')
    const body = `工具执行完成：${String(firstBlock?.content ?? '').slice(0, 120)}`
    yield* streamText(body, signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 压缩摘要调用：检测 COMPACTION_INSTRUCTION → 返回 mock 摘要（收敛用）。
  // YFW_MOCK_COMPACT_BAD=1 → 返回无标签文本（extractSummary 失败，熔断测试用）
  if (lastText && lastText.includes('系统压缩指令')) {
    if (process.env.YFW_MOCK_COMPACT_BAD === '1') {
      yield* streamText('（压缩失败：模型未输出结构化摘要）', signal)
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    const body = process.env.YFW_MOCK_COMPACT_RESPONSE === '1'
      ? '<compacted-summary>摘要输出</compacted-summary>'
      : '<compacted-summary>mock 摘要</compacted-summary>'
    yield* streamText(body, signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 溢出模拟：YFW_MOCK_OVERFLOW=once → 非 summarizer 调用抛一次 context_window_exceeded
  if (process.env.YFW_MOCK_OVERFLOW === 'once' && !String(lastText || '').includes('系统压缩指令')) {
    if (process.env.YFW_MOCK_OVERFLOW_CONSUMED === '1') { /* 已抛过 */ } else {
      process.env.YFW_MOCK_OVERFLOW_CONSUMED = '1'
      throw new Error('context_window_exceeded: 请求超出模型上下文窗口')
    }
  }
  // 安全工具请求回合：[mock:tool-safe] 触发非高危 Bash tool_use（echo）。
  // 子 lane 测试用——高危命令会经 can_use_tool 审批挂起（无 CLI 无法解除）
  if (lastText.includes('[mock:tool-safe]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_safe', name: 'Bash', input: { command: 'echo mock-safe' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 工具请求回合：[mock:tool] 触发 Bash tool_use（rm -rf 高危 → 审批挂起）。
  // YFW_MOCK_TOOLS=N 时一次返回 N 个 tool_use（多工具轮合并回归用）
  if (lastText.includes('[mock:tool]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    const n = Math.max(1, Number(process.env.YFW_MOCK_TOOLS || 1))
    for (let i = 1; i <= n; i++) {
      // 第 1 个工具保留 rm -rf 高危命令（审批测试依赖 can_use_tool 触发）；多工具模式后续用安全 echo
      const command = i === 1 ? 'rm -rf /tmp/yfw-mock-target' : `echo mock-tool-${i}`
      yield { type: 'tool_use', id: `tool_use_mock_${i}`, name: 'Bash', input: { command } }
    }
    // P0-2 length 截断模拟：YFW_MOCK_STOP_REASON=length → 工具轮后置 stop_reason
    if (process.env.YFW_MOCK_STOP_REASON === 'length') yield { type: 'stop_reason', reason: 'length' }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 大结果工具轮（P0-3 磁盘持久化测试）：Bash 输出 30000 字符触发落盘 + 预览替换
  if (lastText.includes('[mock:big]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_big', name: 'Bash', input: { command: 'node -e "process.stdout.write(\'x\'.repeat(30000))"' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 Agent 分发冒烟：[mock:agent] 触发 Agent tool_use（subagent 链路测试用）
  if (lastText.includes('[mock:agent]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent', name: 'Agent', input: { subagent_type: 'general-purpose', prompt: '测试子任务：请输出一句确认' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 普通回合：回显（带 turn 计数，历史恢复可断言）
  const text = `mock: ${String(lastText).slice(0, 120)} (turn=${realUser.length})`
  yield* streamText(text, signal)
  yield { type: 'usage', usage: MOCK_USAGE }
}

// undici fetch 要求 signal 为 AbortSignal 实例。engine 的轮次级 signal 是自定义
// 对象（rawSignal getter 暴露真 AbortSignal）；其余调用方（mock/测试）无 rawSignal
// 时兜底：AbortSignal 直传，普通对象则不给 fetch（由调用方 chunk 循环检查中止）。
export function toAbortSignal(s) {
  if (s?.rawSignal) return s.rawSignal
  return s instanceof AbortSignal ? s : undefined
}

// Anthropic SSE 流：统一产出归一化 chunk。
export async function* protocolStream({ url, body, headers, signal }) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: toAbortSignal(signal) })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    // P0-1：错误携带 HTTP status，供 classifyApiError 结构化分类（5xx 可退避重试）
    const err = new Error(`内核：API 请求失败 ${res.status} ${detail.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usagePushed = false
  const parser = createAnthropicParser()
  // P1-6：单次流读空闲看门狗（默认 300s，同 deepseek-harness）
  const idleTimeoutMs = Number(process.env.CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS || 300_000)
  try {
    while (true) {
      const { done, value } = await withIdleTimeout(reader.read(), idleTimeoutMs)
      if (done) break
      if (signal?.aborted) throw abortError()
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let ev
        try { ev = JSON.parse(payload) } catch { continue }
        for (const c of parser.feed(ev)) {
          if (c.type === 'usage') usagePushed = true
          yield c
        }
      }
    }
    for (const c of parser.finish()) {
      if (c.type === 'usage') usagePushed = true
      yield c
    }
    // 流末尾：stop_reason（engine 判 length 截断用；无则 null）
    yield { type: 'stop_reason', reason: parser.stopReason() }
    // 每流一个终态 usage：解析器已 push（message_delta / OpenAI 末尾 usage）则不再兜底
    if (!usagePushed) yield { type: 'usage', usage: parser.usage() }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

// Anthropic 协议流：tools 中立形状 → tools[]；system 抽顶层
async function* anthropicStream({ model, messages, system, tools, maxTokens, signal }) {
  const base = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '')
  const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || ''
  if (!base || !token) throw new Error('内核：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 未配置')
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    stream: true,
    ...(tools.length
      ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) }
      : {}),
  }
  yield* protocolStream({
    url: base + '/v1/messages',
    body,
    headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    signal,
  })
}

// 错误分类（P0-1）：结构化错误码 + 是否可重试。engine 据此决定退避重试或快速失败。
//   abort          —— 用户取消，永不重试
//   context-window —— 上下文溢出，engine 有独立压缩兜底路径
//   auth           —— 401/403 凭证问题，重试无意义
//   quota          —— 配额/计费耗尽（insufficient_quota 类），快速失败
//   rate-limit     —— 429 / rate limit，可退避重试
//   transient      —— 5xx / 网络 / 流空闲超时，可退避重试（连接层瞬时错误）
//   unknown        —— 其余，保守不重试
export function classifyApiError(err) {
  if (err?.name === 'AbortError') return { kind: 'abort', retryable: false }
  const msg = String(err?.message || '')
  const status = err?.status || 0
  // context_window_exceeded 以 message 关键词判定（provider 不一定带 status，如 mock）
  if (/context_window_exceeded/.test(msg)) return { kind: 'context-window', retryable: false }
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false }
  if (status === 429 || /rate.?limit|too many requests/i.test(msg)) return { kind: 'rate-limit', retryable: true }
  if (/quota|billing|insufficient/i.test(msg)) return { kind: 'quota', retryable: false }
  if (/stream idle timeout/i.test(msg)) return { kind: 'transient', retryable: true }
  if (status >= 500 || /ECONN|ENOTFOUND|EPIPE|ETIMEDOUT|fetch failed|network|socket/i.test(msg)) return { kind: 'transient', retryable: true }
  return { kind: 'unknown', retryable: false }
}

// 单次读操作空闲看门狗（P1-6）：reader.read() 长时间无数据判超时。
// 参考 deepseek-harness 的流式空闲看门狗（300s），防 fetch 永不 settle。
function withIdleTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(Object.assign(new Error('stream idle timeout'), { code: 'STREAM_TIMEOUT' }))
    }, ms)
    if (t.unref) t.unref()
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

// 消息流入口：mock / 真实 Anthropic 协议分流。tools = 中立 [{name, description, input_schema}]
export async function* streamMessages({ model, messages, maxTokens, signal, tools = [] }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = messages.filter((m) => m.role !== 'system')
  if (process.env.YFW_MOCK_API === '1') {
    yield* mockStream({ messages, signal })
    return
  }
  if (!detectProtocol()) throw new Error('内核：未检测到可用协议（需 ANTHROPIC_BASE_URL）')
  yield* anthropicStream({ model, messages: rest, system, tools, maxTokens, signal })
}
