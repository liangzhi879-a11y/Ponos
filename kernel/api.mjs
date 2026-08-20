// YFW-turbo LLM API 客户端（docs/bridge-contract.md §2 buildChildEnv 注入的 provider env）
// ---------------------------------------------------------------------------
// 以 Anthropic Messages API 兼容协议调上游（ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN + ANTHROPIC_MODEL），SSE 流式解析后产出结构化 chunk：
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

// 协议检测：OPENAI env 优先（可并存时走 OpenAI），否则 Anthropic；都没有返回 null
export function detectProtocol(env = process.env) {
  if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY) return 'openai'
  if (env.ANTHROPIC_BASE_URL) return 'anthropic'
  return null
}

// usage 归一化：兼容 anthropic/openai 字段名；扩展 cache_read/cache_creation（deepseek 系）
function normalizeUsage(u = {}) {
  const cacheRead =
    u.cache_read_input_tokens ??
    u.prompt_tokens_details?.cached_tokens ??
    0
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
      } else if (payload.type === 'message_delta' && payload.usage) {
        usage = normalizeUsage(payload.usage)
        out.push({ type: 'usage', usage })
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
  }
}

// OpenAI Chat Completions 事件流纯解析器（choices[].delta；deepseek 系 reasoning_content）
export function createOpenAIParser() {
  let tool = null // { index, id, name, inputJson }
  let textBuf = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  return {
    feed(payload) {
      const out = []
      if (payload.usage) {
        usage = normalizeUsage(payload.usage)
        out.push({ type: 'usage', usage })
        return out
      }
      const choice = payload.choices?.[0] ?? {}
      const delta = choice.delta ?? {}
      if (delta.reasoning_content) out.push({ type: 'thinking', text: delta.reasoning_content })
      if (delta.content) {
        textBuf += delta.content
        for (const seg of segmentText(textBuf)) { textBuf = ''; out.push(seg) }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc.id) tool = { index: tc.index ?? 0, id: tc.id, name: tc.function?.name ?? '', inputJson: '' }
          if (tool && tc.function?.name) tool.name = tc.function.name
          if (tool && tc.function?.arguments) tool.inputJson += tc.function.arguments
        }
      }
      if (choice.finish_reason === 'tool_calls' && tool) {
        let input = {}
        try { input = tool.inputJson ? JSON.parse(tool.inputJson) : {} } catch {}
        out.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
        tool = null
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
  const userMsgs = (messages || []).filter((m) => m.role === 'user')
  const lastUser = userMsgs[userMsgs.length - 1]
  const lastContent = lastUser?.content
  const lastText = typeof lastContent === 'string'
    ? lastContent
    : (Array.isArray(lastContent) ? lastContent.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
  const toolResults = Array.isArray(lastContent) ? lastContent.filter((b) => b?.type === 'tool_result') : []

  // 工具结果回合：tool_result 已注入 → 报告执行结果（引擎工具循环第二轮）
  if (toolResults.length) {
    const body = `工具执行完成：${String(toolResults[0].content ?? '').slice(0, 120)}`
    yield* streamText(body, signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 压缩摘要调用：检测 COMPACTION_INSTRUCTION → 返回 mock 摘要（收敛用）
  if (lastText && lastText.includes('系统压缩指令')) {
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
  // 工具请求回合：[mock:tool] 触发 Bash tool_use（rm -rf 高危 → 审批挂起）
  if (lastText.includes('[mock:tool]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_1', name: 'Bash', input: { command: 'rm -rf /tmp/yfw-mock-target' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 普通回合：回显（带 turn 计数，历史恢复可断言）
  const text = `mock: ${String(lastText).slice(0, 120)} (turn=${userMsgs.length})`
  yield* streamText(text, signal)
  yield { type: 'usage', usage: MOCK_USAGE }
}

// 双协议流：统一产出归一化 chunk。protocol 由 env 检测（engine 无感）。
export async function* protocolStream({ protocol, url, body, headers, signal }) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`内核：API 请求失败 ${res.status} ${detail.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usagePushed = false
  const parser = protocol === 'openai' ? createOpenAIParser() : createAnthropicParser()
  try {
    while (true) {
      const { done, value } = await reader.read()
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
    protocol: 'anthropic',
    url: base + '/v1/messages',
    body,
    headers: { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    signal,
  })
}

// OpenAI 协议流：tools 中立形状 → function 形状；system 并入 messages 首位
async function* openaiStream({ model, messages, system, tools, maxTokens, signal }) {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '')
  const token = process.env.OPENAI_API_KEY || ''
  if (!base || !token) throw new Error('内核：OPENAI_BASE_URL / OPENAI_API_KEY 未配置')
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
    ...(tools.length
      ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
      : {}),
  }
  yield* protocolStream({
    protocol: 'openai',
    url: base + '/v1/chat/completions',
    body,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    signal,
  })
}

// 消息流入口：mock / 真实双协议分流。tools = 中立 [{name, description, input_schema}]
export async function* streamMessages({ model, messages, maxTokens, signal, tools = [] }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = messages.filter((m) => m.role !== 'system')
  if (process.env.YFW_MOCK_API === '1') {
    yield* mockStream({ messages, signal })
    return
  }
  const protocol = detectProtocol()
  if (!protocol) throw new Error('内核：未检测到可用协议（需 ANTHROPIC_BASE_URL 或 OPENAI_BASE_URL+OPENAI_API_KEY）')
  if (protocol === 'openai') yield* openaiStream({ model, messages: rest, system, tools, maxTokens, signal })
  else yield* anthropicStream({ model, messages: rest, system, tools, maxTokens, signal })
}
