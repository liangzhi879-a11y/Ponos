// LLM API 客户端（docs/bridge-contract.md §2 buildChildEnv 注入的 provider env）
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

async function* mockStream({ lastUserContent, signal }) {
  const text = 'mock: ' + String(lastUserContent || '').slice(0, 120)
  // 模拟流式：切 3 段，段间短暂停顿使 cancel 可中断
  const step = Math.max(1, Math.ceil(text.length / 3))
  let rest = text
  while (rest) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    if (signal?.aborted) throw abortError()
    yield { type: 'text', text: rest.slice(0, step) }
    rest = rest.slice(step)
  }
  yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 20 } }
}

// 真实 API 流：fetch SSE 解析（Anthropic Messages 事件形状）
async function* remoteStream({ model, body, signal }) {
  const base = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '')
  const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || ''
  if (!base || !token) throw new Error('内核：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 未配置')
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`内核：API 请求失败 ${res.status} ${detail.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let textBuf = ''
  let usage = {}
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
        const dt = ev.delta
        if (ev.type === 'content_block_delta' && dt) {
          if (dt.type === 'text_delta' && dt.text) {
            textBuf += dt.text
            for (const seg of segmentText(textBuf)) { textBuf = ''; yield seg }
          } else if (dt.type === 'thinking_delta' && dt.thinking) {
            yield { type: 'thinking', text: dt.thinking }
          }
        } else if (ev.type === 'message_start' && ev.message?.usage) {
          usage = { input_tokens: ev.message.usage.input_tokens ?? 0, output_tokens: ev.message.usage.output_tokens ?? 0 }
        } else if (ev.type === 'message_delta' && ev.usage) {
          usage = { input_tokens: usage.input_tokens ?? 0, output_tokens: ev.usage.output_tokens ?? 0 }
        }
      }
    }
    if (textBuf.trim()) yield { type: 'text', text: textBuf }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  yield { type: 'usage', usage }
}

// 消息流入口：拼接 body（system 抽顶层），按 mock/真实 API 分流
export async function* streamMessages({ model, messages, maxTokens, signal }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = messages.filter((m) => m.role !== 'system')
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')

  if (process.env.YFW_MOCK_API === '1') {
    yield* mockStream({ lastUserContent: lastUser?.content ?? '', signal })
    return
  }
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: rest,
    stream: true,
  }
  yield* remoteStream({ model, body, signal })
}
