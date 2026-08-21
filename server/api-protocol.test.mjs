import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectProtocol, createAnthropicParser, protocolStream, streamMessages, toAbortSignal, classifyApiError } from '../kernel/api.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

test('classifyApiError（P0-1）：错误码结构化分类 + 可重试标记', () => {
  const ab = new Error('turn aborted by cancel')
  ab.name = 'AbortError'
  assert.deepEqual(classifyApiError(ab), { kind: 'abort', retryable: false })
  // context_window_exceeded 以 message 判定（无 status 也可识别）
  assert.equal(classifyApiError(new Error('context_window_exceeded: 超出上下文')).kind, 'context-window')
  const ctxErr = new Error('context_window_exceeded')
  ctxErr.status = 400
  assert.equal(classifyApiError(ctxErr).kind, 'context-window')
  // auth / quota 快速失败
  const authErr = new Error('unauthorized')
  authErr.status = 401
  assert.deepEqual(classifyApiError(authErr), { kind: 'auth', retryable: false })
  const quotaErr = new Error('insufficient_quota: 余额不足')
  assert.deepEqual(classifyApiError(quotaErr), { kind: 'quota', retryable: false })
  // rate-limit / transient 可退避重试
  const rateErr = new Error('rate limit exceeded')
  rateErr.status = 429
  assert.deepEqual(classifyApiError(rateErr), { kind: 'rate-limit', retryable: true })
  const fiveErr = new Error('内核：API 请求失败 503 fetch failed')
  fiveErr.status = 503
  assert.deepEqual(classifyApiError(fiveErr), { kind: 'transient', retryable: true })
  const netErr = new Error('fetch failed: ECONNREFUSED')
  assert.equal(classifyApiError(netErr).kind, 'transient')
  // unknown 保守不重试
  assert.equal(classifyApiError(new Error('其他错误')).kind, 'unknown')
})

test('createAnthropicParser（P0-2）：message_delta 的 stop_reason 被捕获', () => {
  const p = createAnthropicParser()
  assert.equal(p.stopReason(), null)
  p.feed({ type: 'message_delta', delta: { stop_reason: 'length' }, usage: { input_tokens: 1, output_tokens: 1 } })
  assert.equal(p.stopReason(), 'length')
  p.feed({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } })
  assert.equal(p.stopReason(), 'end_turn')
})

test('protocolStream（P0-2）：流末尾 yield stop_reason chunk（engine 判 length 截断）', async () => {
  const events = [
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello\n\n' } }),
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'length' }, usage: { input_tokens: 1, output_tokens: 1 } }),
  ]
  const sse = events.map((e) => `data: ${e}`).join('\n\n') + '\n\ndata: [DONE]\n\n'
  const prev = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
  })
  try {
    const chunks = []
    for await (const c of protocolStream({ url: 'http://t/v1/messages', body: {}, headers: {} })) chunks.push(c)
    const sr = chunks.filter((c) => c.type === 'stop_reason')
    assert.equal(sr.length, 1)
    assert.equal(sr[0].reason, 'length')
  } finally {
    global.fetch = prev
  }
})

test('protocolStream（P1-6）：单次流读空闲看门狗——body 永不产数据 → 抛 stream idle timeout', async () => {
  const prev = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({ start(c) { /* 永不 enqueue/close */ } }),
  })
  const oldTimeout = process.env.CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS
  process.env.CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS = '50'
  try {
    await assert.rejects(
      (async () => {
        for await (const c of protocolStream({ url: 'http://t/v1/messages', body: {}, headers: {} })) {}
      })(),
      /stream idle timeout/,
    )
  } finally {
    global.fetch = prev
    if (oldTimeout === undefined) delete process.env.CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS
    else process.env.CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS = oldTimeout
  }
})

test('detectProtocol：Anthropic env 存在 → anthropic，否则 null', () => {
  assert.equal(detectProtocol({ ANTHROPIC_BASE_URL: 'http://y' }), 'anthropic')
  assert.equal(detectProtocol({}), null)
  assert.equal(detectProtocol({ OPENAI_BASE_URL: 'http://x' }), null)
})

test('Anthropic 解析器：text/tool_use/usage 归一化 chunk 形状', () => {
  const p = createAnthropicParser()
  const out = []
  out.push(...p.feed({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }))
  out.push(...p.feed({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好，世界。\n\n' } }))
  out.push(...p.feed({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } }))
  out.push(...p.feed({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":' } }))
  out.push(...p.feed({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"ls"}' } }))
  out.push(...p.feed({ type: 'content_block_stop' }))
  out.push(...p.feed({ type: 'message_delta', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }))
  out.push(...p.finish())
  const kinds = out.map((c) => c.type)
  assert.ok(kinds.includes('text') && kinds.includes('tool_use') && kinds.includes('usage'))
  const tool = out.find((c) => c.type === 'tool_use')
  assert.deepEqual(tool, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
  const usage = out.find((c) => c.type === 'usage').usage
  assert.equal(usage.input_tokens, 5)
  assert.equal(usage.output_tokens, 3)
  assert.equal(usage.cache_read_input_tokens, 2)
  assert.equal(usage.cache_creation_input_tokens, 1)
})

test('protocolStream：Anthropic 完整事件序列（content_block_start→delta→stop→message_delta）仅产出一个 usage chunk', async () => {
  const events = [
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    JSON.stringify({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好，世界。\n\n' } }),
    JSON.stringify({ type: 'content_block_stop' }),
    JSON.stringify({ type: 'message_delta', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }),
  ]
  const sse = events.map((e) => `data: ${e}`).join('\n\n') + '\n\ndata: [DONE]\n\n'
  const prev = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
  })
  try {
    const chunks = []
    for await (const c of protocolStream({ url: 'http://t/v1/messages', body: {}, headers: {} })) chunks.push(c)
    const usages = chunks.filter((c) => c.type === 'usage')
    assert.equal(usages.length, 1)
    assert.equal(usages[0].usage.output_tokens, 3)
    assert.equal(usages[0].usage.cache_read_input_tokens, 2)
    assert.ok(chunks.some((c) => c.type === 'text'))
  } finally {
    global.fetch = prev
  }
})

test('tools 注入：Anthropic 请求 body 含 tools[]（字段名映射，mock HTTP 断言）', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const env = { ANTHROPIC_BASE_URL: 'http://t', ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'm' }
  const oldEnv = { ...process.env }
  Object.assign(process.env, env)
  try {
    const tools = createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'] }).toolSchemas()
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools, signal: undefined })) chunks.push(c)
    assert.equal(captured.length, 1)
    assert.ok(captured[0].url.endsWith('/v1/messages'))
    assert.ok(Array.isArray(captured[0].body.tools))
    assert.deepEqual(captured[0].body.tools.map((t) => t.name), ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'TodoWrite', 'WebFetch', 'OCR'])
    assert.equal(captured[0].body.tools[0].input_schema.type, 'object')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    global.fetch = prev
    process.env = oldEnv
  }
})

test('mock 扩展：检测系统压缩指令 → 返回 <compacted-summary> 摘要（收敛校验用）', async () => {
  const oldEnv = { ...process.env }
  Object.assign(process.env, { YFW_MOCK_API: '1', YFW_MOCK_COMPACT_RESPONSE: '1' })
  try {
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: '请执行系统压缩指令，输出 checkpoint 摘要' }], maxTokens: 100 })) chunks.push(c)
    const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')
    assert.ok(text.includes('<compacted-summary>摘要输出</compacted-summary>'), text)
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    process.env = oldEnv
  }
})

test('mock 扩展：YFW_MOCK_OVERFLOW=once 非压缩调用抛一次溢出，之后恢复', async () => {
  const oldEnv = { ...process.env }
  Object.assign(process.env, { YFW_MOCK_API: '1', YFW_MOCK_OVERFLOW: 'once' })
  delete process.env.YFW_MOCK_OVERFLOW_CONSUMED
  try {
    // 第一次非 summarizer 调用：抛 context_window_exceeded
    await assert.rejects(
      (async () => {
        for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 })) {}
      })(),
      /context_window_exceeded/,
    )
    // 第二次调用：已消费，恢复正常 mock 回显
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 })) chunks.push(c)
    assert.ok(chunks.some((c) => c.type === 'text'))
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    process.env = oldEnv
  }
})

test('toAbortSignal：engine 轮次级 signal（rawSignal getter）→ 真 AbortSignal，普通对象 → undefined（真实 API 集成回归）', () => {
  // engine 的 signal 形状：{ aborted, get rawSignal() }——rawSignal 必须返回真 AbortSignal
  const ac = new AbortController()
  const engineSignal = { aborted: false, get rawSignal() { return ac.signal } }
  const s1 = toAbortSignal(engineSignal)
  assert.ok(s1 instanceof AbortSignal, 'rawSignal 应返回 AbortSignal 实例（undici fetch 要求）')
  ac.abort()
  assert.equal(s1.aborted, true, 'engine abort 应传导到底层 fetch 的 AbortSignal')
  // AbortSignal 实例直传
  const ac2 = new AbortController()
  assert.equal(toAbortSignal(ac2.signal), ac2.signal)
  // 普通对象（mock/测试直传场景）：返回 undefined，不传给 fetch
  assert.equal(toAbortSignal({ aborted: false }), undefined)
})

test('prompt cache：YFW_PROMPT_CACHE=1 时 system 打 ephemeral 缓存标记（数组形态）', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ body: JSON.parse(String(init.body)) })
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { ANTHROPIC_BASE_URL: 'http://t', ANTHROPIC_AUTH_TOKEN: 'k', YFW_PROMPT_CACHE: '1' })
  try {
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(captured.length, 1)
    const sys = captured[0].body.system
    assert.ok(Array.isArray(sys), 'system 应为数组形态')
    assert.equal(sys[0].text, 'SYS')
    assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' })
    assert.equal(captured[0].body.messages[0].role, 'user')
  } finally {
    global.fetch = prev
    process.env = oldEnv
  }
})

test('prompt cache：端点拒绝缓存标记时自动去掉重发（兼容回退）', async () => {
  let calls = 0
  const bodies = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    calls++
    bodies.push(JSON.parse(String(init.body)))
    if (calls === 1) {
      const err = new Error('内核：API 请求失败 400 {"error":{"message":"unknown field cache_control"}}')
      err.status = 400
      throw err
    }
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { ANTHROPIC_BASE_URL: 'http://t', ANTHROPIC_AUTH_TOKEN: 'k', YFW_PROMPT_CACHE: '1' })
  try {
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(calls, 2, '首次被拒后应重发一次')
    assert.ok(Array.isArray(bodies[0].system), '首次请求带缓存标记')
    assert.equal(bodies[1].system, 'SYS', '回退请求 system 恢复纯字符串')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    global.fetch = prev
    process.env = oldEnv
  }
})

test('R1-1 流中断：第一次流中途抛 transient → 自动重发成功（fetch 调 2 次，内容完整）', async () => {
  let calls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    const enc = new TextEncoder()
    if (calls === 1) {
      // 第一次：SSE 流中途中断（读第二块时抛 fetch failed）
      const sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
                 'data: {"type":"content_block_start","content_block":{"type":"text","text_block":{"type":"text","text":""}}}\n\n' +
                 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"part1 "}}\n\n'
      const chunks = enc.encode(sse)
      const outer = new ReadableStream({
        start(c) { c.enqueue(chunks) },
        pull() { throw new TypeError('fetch failed') },
        cancel() {},
      })
      return new Response(outer, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const ok = 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
               'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\n' +
               'data: [DONE]\n'
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ok)); c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { ANTHROPIC_BASE_URL: 'http://t', ANTHROPIC_AUTH_TOKEN: 'k', YFW_MOCK_API: '' })
  try {
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(calls, 2, '应自动重发一次')
    const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')
    assert.match(text, /done/, '重发后内容完整')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    globalThis.fetch = origFetch
    process.env = oldEnv
  }
})

test('R1-2 超时分级：TimeoutError 分类为 transient（可重试），区别于 abort', () => {
  const timeoutErr = new Error('The operation was aborted due to timeout')
  timeoutErr.name = 'TimeoutError'
  assert.deepEqual(classifyApiError(timeoutErr), { kind: 'transient', retryable: true })
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  assert.deepEqual(classifyApiError(abort), { kind: 'abort', retryable: false })
})

test('R1-2 fetch 连接超时：AbortSignal.timeout 触发后经重发链路成功（fetch 调 2 次）', async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, opts) => {
    calls++
    if (calls === 1) {
      // 第一次永不 resolve（模拟连接挂起）；监听组合 signal——超时 abort 时以
      // signal.reason（TimeoutError）reject，模拟真实 fetch 对 signal 的响应
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason || new Error('aborted')))
      })
    }
    const enc = new TextEncoder()
    const ok = 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
               'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n' +
               'data: [DONE]\n'
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ok)); c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: 'http://t',
    ANTHROPIC_AUTH_TOKEN: 'k',
    YFW_MOCK_API: '',
    CLAUDE_CODE_CONNECT_TIMEOUT_MS: '150',   // 测试缩短
    CLAUDE_CODE_STREAM_RECONNECTS: '2',
  })
  try {
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(calls, 2, '连接超时后应重发')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    globalThis.fetch = origFetch
    process.env = oldEnv
  }
})

test('P4-5 setProvider 激活后 streamMessages 请求走新 baseUrl（mock fetch 捕获 URL）', async () => {
  const urls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }) + '\ndata: [DONE]\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }
  const oldEnv = { ...process.env }
  try {
    process.env.ANTHROPIC_BASE_URL = 'http://orig'
    process.env.ANTHROPIC_AUTH_TOKEN = 'k'
    process.env.YFW_MOCK_API = ''
    process.env.CLAUDE_CODE_CONNECT_TIMEOUT_MS = '150'
    const { setProvider } = await import('../kernel/provider.mjs')
    setProvider({ baseUrl: 'http://hot-switched', authToken: 'k2', model: 'm2' })
    for await (const c of streamMessages({ model: 'm2', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) {}
    assert.ok(urls.some((u) => u.startsWith('http://hot-switched')), `请求应发往新 baseUrl，实际 ${urls.join(',')}`)
    assert.ok(!urls.some((u) => u.startsWith('http://orig')))
  } finally {
    globalThis.fetch = origFetch
    process.env = oldEnv
  }
})
