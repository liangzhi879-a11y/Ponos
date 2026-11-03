// OpenAI 协议适配层测试（2026-09-23 协议兼容）
// 重点：把 2026-08-20「带 tools 时 thinking-only 空回复」的真根因钉成回归夹具——
//   当年解析器 `if (payload.usage) return out` 早退，吞掉末帧 finish_reason:'tool_calls'，
//   而那是 tool_use 的唯一产出口；本套用例 ① 直接构造"末帧同时带 usage 与 finish_reason"
//   的形状（真机实测该端点正是如此）。若有人再写出早退式解析，本文件立刻变红。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createOpenAIParser, toOpenAIMessages, encodeOpenAIRequest, normalizeStopReason } from '../kernel/wire/openai.mjs'
import { rootOf, openaiStreamUrl, anthropicStreamUrl, resolveApiFormat, isProtocolRejection, normalizeApiFormat } from '../kernel/wire/url.mjs'
import { normalizeUsage } from '../kernel/wire/usage.mjs'
import { streamMessages, resetAutoFormatCacheForTest } from '../kernel/api.mjs'

const collect = (parser, events) => {
  const out = []
  for (const ev of events) for (const c of parser.feed(ev)) out.push(c)
  for (const c of parser.finish()) out.push(c)
  return out
}

// ── URL 归一与协议判定 ─────────────────────────────────────────────────────
test('URL 归一：剥尾缀得根，openai 端点一律从 root 拼（防 /v1/v1 双段 404）', () => {
  assert.equal(rootOf('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com')
  assert.equal(rootOf('https://api.deepseek.com/anthropic/v1'), 'https://api.deepseek.com')
  assert.equal(rootOf('https://api.moonshot.cn/v1'), 'https://api.moonshot.cn')
  assert.equal(rootOf('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
  assert.equal(rootOf('https://api.deepseek.com/'), 'https://api.deepseek.com')
  assert.equal(openaiStreamUrl('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(openaiStreamUrl('https://api.moonshot.cn/v1'), 'https://api.moonshot.cn/v1/chat/completions')
  // Anthropic 端点**刻意不做 rootOf**：既有行为就是 base + '/v1/messages'（零回归）
  assert.equal(anthropicStreamUrl('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(anthropicStreamUrl('https://api.deepseek.com/anthropic/'), 'https://api.deepseek.com/anthropic/v1/messages')
})

test('协议判定：显式 > env > /anthropic 尾缀 > auto（**不从地址猜能力**）', () => {
  assert.equal(resolveApiFormat({ format: 'openai', baseUrl: 'https://api.deepseek.com/anthropic' }), 'openai')
  assert.equal(resolveApiFormat({ format: 'anthropic', baseUrl: 'http://127.0.0.1:8000' }), 'anthropic')
  assert.equal(resolveApiFormat({ baseUrl: 'https://api.deepseek.com/anthropic', env: {} }), 'anthropic')
  assert.equal(resolveApiFormat({ baseUrl: 'https://x.com', env: { PONOS_API_FORMAT: 'openai' } }), 'openai')
  assert.equal(resolveApiFormat({ baseUrl: '', env: {} }), 'anthropic')
  // ★ 关键回归：本地/云的非 /anthropic 基址一律 'auto'，**不预判 openai**
  //   （曾按"私有网段→openai"推导，把本机 Anthropic 兼容端点误判，实测打红 api-empty-stream）
  assert.equal(resolveApiFormat({ baseUrl: 'http://127.0.0.1:8000', env: {} }), 'auto')
  assert.equal(resolveApiFormat({ baseUrl: 'http://localhost:11434/v1', env: {} }), 'auto')
  assert.equal(resolveApiFormat({ baseUrl: 'https://api.moonshot.cn/v1', env: {} }), 'auto')
  // 非法值一律回落 auto（bridge/GUI 兜底同源）
  assert.equal(normalizeApiFormat('OPENAI'), 'openai')
  assert.equal(normalizeApiFormat('garbage'), 'auto')
  assert.equal(normalizeApiFormat(undefined), 'auto')
  // 协议级拒绝判据只认 404/405
  assert.equal(isProtocolRejection({ status: 404 }), true)
  assert.equal(isProtocolRejection({ status: 405 }), true)
  assert.equal(isProtocolRejection({ status: 400 }), false)
  assert.equal(isProtocolRejection({ status: 500 }), false)
  assert.equal(isProtocolRejection(new Error('no status')), false)
})

// ── 请求编码 ───────────────────────────────────────────────────────────────
test('消息映射：tool_result 展开为多条 role:tool、tool_use → tool_calls、thinking 丢弃', () => {
  const msgs = toOpenAIMessages([
    { role: 'user', content: [{ type: 'text', text: '做点什么' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'thinking', thinking: '内部推理' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a.txt' } }, { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { cmd: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '内容A' }, { type: 'tool_result', tool_use_id: 'tu_2', content: 'boom', is_error: true }] },
  ], '你是助手')

  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[0].content, '你是助手')
  assert.deepEqual(msgs[1], { role: 'user', content: '做点什么' })
  const a = msgs[2]
  assert.equal(a.role, 'assistant')
  assert.equal(a.content, '好的')
  assert.equal(a.tool_calls.length, 2)
  assert.deepEqual(a.tool_calls[0], { id: 'tu_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } })
  // 一条内部消息含 2 个结果 ⇒ 展开为 2 条 tool 消息（保序）
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'tu_1', content: '内容A' })
  assert.deepEqual(msgs[4], { role: 'tool', tool_call_id: 'tu_2', content: '[工具错误] boom' })
  // thinking 不得出现在任何输出消息里（不回传 reasoning）
  assert.ok(!JSON.stringify(msgs).includes('内部推理'))
})

test('请求编码：tools 映射为 function 形状，tool_choice **默认不下发**，off 档关思考', () => {
  const body = encodeOpenAIRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Read', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    maxTokens: 4096,
  })
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 4096)
  assert.equal(body.tool_choice, undefined)
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'Read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }])
  const off = encodeOpenAIRequest({ model: 'm', messages: [], maxTokens: 512, thinkingMode: 'off' })
  assert.equal(off.reasoning_effort, 'none')
  const high = encodeOpenAIRequest({ model: 'm', messages: [], maxTokens: 512, reasoningEffort: 'high' })
  assert.equal(high.reasoning_effort, 'high')
  const none = encodeOpenAIRequest({ model: 'm', messages: [], maxTokens: 512 })
  assert.equal(none.reasoning_effort, undefined)
})

test('stop_reason 归一：length → max_tokens（engine 判截断）、tool_calls → tool_use', () => {
  assert.equal(normalizeStopReason('stop'), 'end_turn')
  assert.equal(normalizeStopReason('length'), 'max_tokens')
  assert.equal(normalizeStopReason('tool_calls'), 'tool_use')
  assert.equal(normalizeStopReason(null), null)
})

// ── 解析器：真机形状回归 ────────────────────────────────────────────────────
test('★B2 回归夹具：末帧**同时**带 usage 与 finish_reason → 工具调用不得丢失（2026-08-20 根因）', () => {
  const p = createOpenAIParser()
  const chunks = collect(p, [
    { choices: [{ index: 0, delta: { reasoning_content: '我需要写文件' } }] },
    { choices: [{ index: 0, delta: { content: '正在处理。' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"note' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '.txt","content":"hello"}' } }] } }] },
    // ★ 末帧：usage 与 finish_reason 同帧（真机实测就是这个形状）
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
  ])
  const tools = chunks.filter((c) => c.type === 'tool_use')
  assert.equal(tools.length, 1, '工具调用必须产出（当年解析器正是在此返回空）')
  assert.equal(tools[0].id, 'call_1')
  assert.equal(tools[0].name, 'write_file')
  assert.deepEqual(tools[0].input, { path: 'note.txt', content: 'hello' })
  assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('正在处理')))
  assert.ok(chunks.some((c) => c.type === 'thinking' && c.text.includes('写文件')))
  const usages = chunks.filter((c) => c.type === 'usage')
  assert.equal(usages.length, 1)
  assert.equal(usages[0].usage.output_tokens, 30)
  // OpenAI 形态：prompt_tokens 含命中部分 ⇒ input 须扣掉（100 → 20）
  assert.equal(usages[0].usage.input_tokens, 20)
  assert.equal(usages[0].usage.cache_read_input_tokens, 100)
  assert.equal(p.stopReason(), 'tool_use')
})

test('并发多工具：按 index 分槽累积，参数互不串、无覆盖', () => {
  const p = createOpenAIParser()
  const chunks = collect(p, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'Read', arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'Bash', arguments: '{"cmd":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"ls"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const tools = chunks.filter((c) => c.type === 'tool_use')
  assert.equal(tools.length, 2)
  const byId = Object.fromEntries(tools.map((t) => [t.id, t]))
  assert.deepEqual(byId.c0.input, { path: 'a' })
  assert.deepEqual(byId.c1.input, { cmd: 'ls' })
})

test('null 字段防污染：delta 键恒存在但值可为 null（思考阶段 content:null）', () => {
  const p = createOpenAIParser()
  const chunks = collect(p, [
    { choices: [{ index: 0, delta: { content: null, reasoning_content: '想' } }] },
    { choices: [{ index: 0, delta: { content: '正文', reasoning_content: null } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
  const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')
  assert.equal(text, '正文')
  assert.ok(!text.includes('null'), '不得把 null 拼成字符串 "null" 混进正文')
})

test('finish() 兜底：末帧无 finish_reason 时仍吐未收尾的工具槽', () => {
  const p = createOpenAIParser()
  const chunks = collect(p, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'Glob', arguments: '{}' } }] } }] },
    // 无 finish_reason 直接 EOF（部分端点如此）
  ])
  const tools = chunks.filter((c) => c.type === 'tool_use')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].id, 'c9')
})

test('空流形状：仅 usage 无 choices / 空 choices 不得产出，且不抛', () => {
  const p = createOpenAIParser()
  const chunks = collect(p, [
    { usage: { prompt_tokens: 5, completion_tokens: 0 }, choices: [] },
    { choices: [] },
    {},
  ])
  assert.deepEqual(chunks.filter((c) => c.type === 'text' || c.type === 'tool_use'), [])
})

// ── streamMessages 层：auto 有界回退 ────────────────────────────────────────
test('auto 回退：/v1/messages 404 → 改用 /v1/chat/completions 重发一次并产出（且不回退第二次）', async () => {
  resetAutoFormatCacheForTest()
  const calls = []
  const prevFetch = global.fetch
  const prevEnv = { ...process.env }
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
    if (String(url).endsWith('/v1/messages')) {
      return { ok: false, status: 404, text: async () => '{"error":{"message":"Not Found"}}' }
    }
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"你好。"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }) }
  }
  Object.assign(process.env, { PONOS_BASE_URL: 'http://127.0.0.1:59999', PONOS_AUTH_TOKEN: 'k', PONOS_MODEL: 'm', PONOS_API_FORMAT: 'auto', PONOS_STREAM_RECONNECTS: '0' })
  try {
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(calls.length, 2, '应先试 anthropic 再回退 openai 各一次')
    assert.ok(calls[0].url.endsWith('/v1/messages'))
    assert.ok(calls[1].url.endsWith('/v1/chat/completions'))
    // OpenAI 请求体形状：system 走 messages、无 anthropic-version 头语义
    assert.ok(Array.isArray(calls[1].body.messages))
    const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')
    assert.ok(text.includes('你好'), '回退后必须真的产出内容')
    assert.ok(chunks.some((c) => c.type === 'usage'))

    // 第二次调用：已记忆 openai ⇒ 不再先试 anthropic
    calls.length = 0
    for await (const _ of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) { /* drain */ }
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.endsWith('/v1/chat/completions'))
  } finally {
    global.fetch = prevFetch
    process.env = prevEnv
    resetAutoFormatCacheForTest()
  }
})

test('auto 回退有界：已真实产出内容后遇错**绝不**回退重发（防半截文本重复）', async () => {
  resetAutoFormatCacheForTest()
  let calls = 0
  const prevFetch = global.fetch
  const prevEnv = { ...process.env }
  global.fetch = async () => {
    calls++
    if (calls === 1) {
      // 文本需 > TEXT_FLUSH_CHARS(16) 才会在流中途真实产出 chunk（否则留在缓冲，属"未产出"）
      const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"这是一段足够长的文本内容用来确保已经产出至少一个chunk"}}\n\n'
      const body = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(sse)) },
        pull(c) { c.error(Object.assign(new Error('boom'), { status: 404 })) },
      })
      return { ok: true, body }
    }
    return { ok: false, status: 404, text: async () => 'nope' }
  }
  Object.assign(process.env, { PONOS_BASE_URL: 'http://127.0.0.1:59998', PONOS_AUTH_TOKEN: 'k', PONOS_MODEL: 'm', PONOS_API_FORMAT: 'auto', PONOS_STREAM_RECONNECTS: '0' })
  try {
    const seen = []
    let threw = false
    try {
      for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) seen.push(c)
    } catch { threw = true }
    assert.ok(seen.some((c) => c.type === 'text' && c.text.length > 0), '前置条件：必须已真实产出文本')
    assert.ok(threw, '已产出后失败必须上抛，不得静默重发')
    assert.equal(calls, 1, '不得发起第二次请求')
  } finally {
    global.fetch = prevFetch
    process.env = prevEnv
    resetAutoFormatCacheForTest()
  }
})

test('显式 PONOS_API_FORMAT=openai 时不试 anthropic（直接走 openai 端点）', async () => {
  resetAutoFormatCacheForTest()
  const calls = []
  const prevFetch = global.fetch
  const prevEnv = { ...process.env }
  global.fetch = async (url) => {
    calls.push(String(url))
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }) }
  }
  Object.assign(process.env, { PONOS_BASE_URL: 'https://api.deepseek.com/anthropic', PONOS_AUTH_TOKEN: 'k', PONOS_MODEL: 'm', PONOS_API_FORMAT: 'openai', PONOS_STREAM_RECONNECTS: '0' })
  try {
    for await (const _ of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) { /* drain */ }
    assert.equal(calls.length, 1)
    assert.equal(calls[0], 'https://api.deepseek.com/v1/chat/completions')
  } finally {
    global.fetch = prevFetch
    process.env = prevEnv
    resetAutoFormatCacheForTest()
  }
})

test('usage 归一单一真源：wire/usage.mjs 与内核口径一致（Anthropic/DeepSeek/OpenAI 三形态）', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3 }), { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 0, cache_fields_reported: true })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 }), { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, cache_fields_reported: true })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }), { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, cache_fields_reported: true })
  // 未上报缓存字段 → 存在性信号为 false（与"上报了但为 0"不同）
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 }).cache_fields_reported, false)
})

// ── 协议相关模型名 env 接线（Task 2 Step 2-5）────────────────────────────────
// 为什么落在本文件：wire-model.test.mjs 已钉住"provider.modelByFormat 被 api.mjs 消费"，
// 本文件补的是**更前段**一环——provider 侧到底有没有把 PONOS_MODEL_OPENAI/ANTHROPIC
// 读成 modelByFormat。缺了这一环，用户在设置里填的协议专用模型名根本到不了内核
// （OpenAI 侧仍会拿带变体后缀的默认名去请求 ⇒ 400 unknown model）。
test('内核从 env 读协议相关模型名（PONOS_MODEL_OPENAI/ANTHROPIC → provider.modelByFormat）', async () => {
  const prevEnv = { ...process.env }
  const prevFetch = global.fetch
  const seen = []
  const openaiSse = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  const anthropicSse = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), model: JSON.parse(String(init.body)).model })
    const isOpenAI = String(url).endsWith('/v1/chat/completions')
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(isOpenAI ? openaiSse : anthropicSse)); c.close() } }) }
  }
  Object.assign(process.env, {
    PONOS_BASE_URL: 'https://api.minimaxi.com/anthropic',
    PONOS_AUTH_TOKEN: 'k',
    PONOS_MODEL: 'MiniMax-M3[1m]',
    PONOS_MODEL_OPENAI: 'MiniMax-M3',
    PONOS_API_FORMAT: 'openai',
    PONOS_STREAM_RECONNECTS: '0',
  })
  const drain = async () => {
    seen.length = 0
    resetAutoFormatCacheForTest()
    for await (const _ of streamMessages({ model: 'MiniMax-M3[1m]', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) { /* drain */ }
  }
  try {
    await drain()
    assert.equal(seen.length, 1)
    assert.ok(seen[0].url.endsWith('/v1/chat/completions'))
    assert.equal(seen[0].model, 'MiniMax-M3', 'OpenAI 协议下应下发 modelByFormat.openai')

    // 对称断言：用例标题点名的**两个** env 名都得真有鉴别力——只断言 openai 侧时，
    // envProvider 漏读 PONOS_MODEL_ANTHROPIC 也照样全绿（复核教训：无鉴别力的用例是假保险）。
    process.env.PONOS_MODEL_ANTHROPIC = 'MiniMax-M3-anthropic'
    process.env.PONOS_API_FORMAT = 'anthropic'
    await drain()
    assert.equal(seen.length, 1)
    assert.ok(seen[0].url.endsWith('/anthropic/v1/messages'), seen[0].url)
    assert.equal(seen[0].model, 'MiniMax-M3-anthropic', 'Anthropic 协议下应下发 modelByFormat.anthropic')
  } finally {
    global.fetch = prevFetch
    process.env = prevEnv
    resetAutoFormatCacheForTest()
  }
})
