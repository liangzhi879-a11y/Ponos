// kernel/wire/openai.mjs —— OpenAI Chat Completions 协议适配器
// ---------------------------------------------------------------------------
// 内部规范形状 = **Anthropic 形状**（`[{role, content: blocks}]`，块类型
// `text|thinking|tool_use|tool_result`）：本模块负责"内部形状 ⇄ OpenAI 线形状"的双向转换，
// 使 engine / compact / lane / workflow / judgeUntil **零改动**。
//
// ★ 本文件按 2026-09-23 真机实测规格实现（探针 `.yfworking/process/openai-wire-探针/`），
//   其中前两条正是 2026-08-20「带 tools 时 thinking-only 空回复」的真根因——当年那份
//   实现（提交 ace8e6c，1926-08-20 后被 65edb6e 删除）有两处致命缺陷：
//     ・`if (payload.usage) { ...; return out }` 置于 feed() **最前并早退**；
//     ・`tool_use` 的**唯一**产出口是 `choice.finish_reason === 'tool_calls'`。
//   而 DeepSeek OpenAI 端点的**末帧同时携带 `usage` 与 `finish_reason`**（实测同帧携带帧数=1）
//   ⇒ finish_reason 被整帧吞掉 ⇒ tool_use 永不产出。纯文本任务正文在中间帧已输出故不受影响，
//   因此现象恰是「**只在带 tools 时**空回复」。修正后同一端点正常工作（B2/B3 对照实证）。
//
// 必守要点（每条对应一个实测事实或历史事故，勿"优化"掉）：
//   ① usage 与 choices 可同帧共存 ⇒ 先记录 usage，**不得 return**
//   ② finish_reason 一到（不论同帧有无 usage）就吐全部工具槽
//   ③ finish() 兜底：末帧缺 finish_reason 时仍吐未收尾的工具槽
//   ④ 按 `tool_calls[].index` **分槽**累积（并发多工具时防后块覆盖前块）
//   ⑤ 类型判断而非真值判断：delta 的键**恒存在但值可为 null**（思考阶段 `content:null`），
//      直接 `content += d.content` 会写入字符串 "null" 污染正文
//   ⑥ 文本/思考切帧复用 `segment.mjs`（含 `<!--` 未闭合押后），否则 ASK_USER / MILESTONE
//      标记会被切碎（该事故的记录见 segment.mjs 头注）
import { segmentText } from './segment.mjs'
import { normalizeUsage } from './usage.mjs'

/** 鉴权头：OpenAI 生态一律 `Authorization: Bearer`（与 provider.authScheme 无关）。 */
export function openaiHeaders(provider = {}) {
  const token = String(provider.authToken ?? '')
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}` } : {}),
  }
}

/** 中立工具 schema → OpenAI function 形状。 */
export function toOpenAITools(tools = []) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

/**
 * 内部消息 → OpenAI messages（纯函数，可单测）。
 * 关键映射：
 *   ・顶层 system 字符串 → `messages[0]` 的 system 消息
 *   ・assistant `[{text},{tool_use}]` → `{role:'assistant', content, tool_calls:[...]}`
 *   ・user `[{tool_result}]` → **展开为多条** `{role:'tool', tool_call_id, content}`
 *     （一条内部消息含 N 个结果 ⇒ N 条 tool 消息，保序）
 *   ・`{type:'thinking'}` → **丢弃**（多数端点不接受回传 reasoning，且省 prefill）
 *   ・`tool_result.is_error` → 文本前缀 `[工具错误] `（OpenAI 无该字段）
 */
export function toOpenAIMessages(messages = [], system = '') {
  const out = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (!m || m.role === 'system') continue
    const blocks = Array.isArray(m.content) ? m.content : null
    // 纯字符串内容：直接透传
    if (!blocks) { out.push({ role: m.role, content: m.content == null ? '' : String(m.content) }); continue }

    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
      const calls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }))
      const msg = { role: 'assistant', content: text || null }
      if (calls.length) msg.tool_calls = calls
      // 空 assistant 消息（既无文本又无调用）不入请求：OpenAI 侧 content:null 且无 tool_calls
      // 属非法形状，部分端点直接 400。
      if (msg.content !== null || msg.tool_calls) out.push(msg)
      continue
    }

    // user：结果块必须先出（Anthropic 语义「tool_result 紧邻 tool_use」），文本块随后
    const results = blocks.filter((b) => b?.type === 'tool_result')
    for (const r of results) {
      const body = typeof r.content === 'string'
        ? r.content
        : Array.isArray(r.content)
          ? r.content.map((c) => (typeof c === 'string' ? c : String(c?.text ?? ''))).join('')
          : String(r.content ?? '')
      out.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        content: r.is_error ? `[工具错误] ${body}` : body,
      })
    }
    const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
    if (text) out.push({ role: 'user', content: text })
    if (!results.length && !text) out.push({ role: 'user', content: '' })
  }
  return out
}

/**
 * 组装请求体（纯函数）。`tool_choice` **默认不下发**——与内核真实请求同形，也是
 * `server/provider-probe.mjs#probeToolSupport` 已验证的做法（带 tool_choice 会掩盖
 * "服务端默认不支持自动工具选择"这类失败）。个别端点需要时用 env 显式覆盖。
 */
export function encodeOpenAIRequest({
  model, messages = [], system = '', tools = [], maxTokens,
  reasoningEffort = null, thinkingMode = null, temperature = null, seed = null,
}) {
  const body = {
    model,
    messages: toOpenAIMessages(messages, system),
    stream: true,
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens
  if (Number.isFinite(temperature)) body.temperature = temperature
  if (seed != null && Number.isFinite(Number(seed))) body.seed = Number(seed)
  if (tools.length) {
    body.tools = toOpenAITools(tools)
    const forced = String(process.env.PONOS_OPENAI_TOOL_CHOICE || '').trim()
    if (forced) body.tool_choice = forced
  }
  // 思考深度：off 档用 `reasoning_effort:'none'`（**实测有效**：reasoning 归 0、正文正常）；
  // low/high/max 直传同名（与 Anthropic 侧 effortParam 同语义）。端点不认该字段时由
  // api.mjs 的 isEffortRejection 兜底去字段重发一次。
  if (thinkingMode === 'off' || reasoningEffort === 'off') body.reasoning_effort = 'none'
  else if (reasoningEffort === 'low' || reasoningEffort === 'high' || reasoningEffort === 'max') body.reasoning_effort = reasoningEffort
  return body
}

/** OpenAI `finish_reason` → 内核 stop_reason 语义（engine 判 length 截断用）。 */
export function normalizeStopReason(reason) {
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  if (reason === 'content_filter') return 'refusal'
  return reason == null ? null : String(reason)
}

/**
 * 流式解析器（协议无关接口：`feed` / `finish` / `usage` / `stopReason`），
 * 与 `api.mjs#createAnthropicParser` 同形，供 `protocolStream` 注入。
 */
export function createOpenAIParser() {
  const slots = new Map()   // index → { id, name, inputJson }（要点④：按 index 分槽）
  let textBuf = ''
  let thinkBuf = ''
  let usage = normalizeUsage({})
  let finishReason = null
  let lastUsageKey = null

  const flushText = (out) => {
    if (!textBuf) return
    const it = segmentText(textBuf)
    let n = it.next()
    while (!n.done) { out.push(n.value); n = it.next() }
    textBuf = typeof n.value === 'string' ? n.value : ''
  }
  const flushThink = (out) => {
    if (!thinkBuf) return
    const it = segmentText(thinkBuf, 'thinking')
    let n = it.next()
    while (!n.done) { out.push(n.value); n = it.next() }
    thinkBuf = typeof n.value === 'string' ? n.value : ''
  }
  // ★ 与 flush* 的分工（2026-09-23 实测修正）：
  //   flush* = 流**进行中**的切帧（不够一个段落/未达阈值就把尾巴留在缓冲，保住"流式"观感）；
  //   drain* = **内容已结束**（finish_reason 到 / 流末）时**强制吐净**剩余缓冲。
  //   二者不能混用：若结束路径也调 flush*，短回答（实测 '正在处理。' 5 字、'正文' 2 字，
  //   均未达 TEXT_FLUSH_CHARS=16 且无段界）会**永远留在缓冲里**——表现为"有工具调用、
  //   有 usage，就是没有正文"，正是本文件头注要消灭的那类静默丢内容。
  const drainText = (out) => { if (textBuf) { out.push({ type: 'text', text: textBuf }); textBuf = '' } }
  const drainThink = (out) => { if (thinkBuf) { out.push({ type: 'thinking', text: thinkBuf }); thinkBuf = '' } }
  const emitTools = (out) => {
    for (const [key, slot] of slots) {
      let input = {}
      if (slot.inputJson) { try { input = JSON.parse(slot.inputJson) } catch { input = {} } }
      out.push({ type: 'tool_use', id: slot.id, name: slot.name, input })
      slots.delete(key)
    }
  }
  const pushUsage = (raw, out) => {
    usage = normalizeUsage(raw)
    const key = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].join(':')
    if (key !== lastUsageKey) { lastUsageKey = key; out.push({ type: 'usage', usage }) }
  }

  return {
    feed(payload) {
      const out = []
      // 要点①：usage 与 choices 同帧共存 ⇒ 先记录再继续，**绝不 return**
      if (payload?.usage) pushUsage(payload.usage, out)
      const choice = payload?.choices?.[0]
      if (!choice) return out
      const d = choice.delta
      if (d) {
        // 要点⑤：typeof 判断（键恒存在、值可为 null）
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) { thinkBuf += d.reasoning_content; flushThink(out) }
        else if (typeof d.reasoning === 'string' && d.reasoning) { thinkBuf += d.reasoning; flushThink(out) }
        if (typeof d.content === 'string' && d.content) { textBuf += d.content; flushText(out) }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const key = Number.isInteger(tc?.index) ? tc.index : 0
            let slot = slots.get(key)
            if (!slot) { slot = { id: '', name: '', inputJson: '' }; slots.set(key, slot) }
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.name = tc.function.name
            // 参数是**分片**下发的 JSON 字符串，必须累积（实测 19 片）
            if (typeof tc.function?.arguments === 'string') slot.inputJson += tc.function.arguments
          }
        }
      }
      if (choice.finish_reason != null) {
        finishReason = normalizeStopReason(choice.finish_reason)
        drainThink(out)   // 内容已结束：强制吐净，保证 思考→正文→工具 顺序
        drainText(out)
        emitTools(out)    // 要点②：finish_reason 一到就吐槽
      }
      return out
    },
    finish() {
      const out = []
      drainThink(out)
      drainText(out)
      emitTools(out)      // 要点③：末帧无 finish_reason 时不丢工具
      return out
    },
    usage() { return usage },
    stopReason() { return finishReason },
  }
}
