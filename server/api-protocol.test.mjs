import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectProtocol, createAnthropicParser, createOpenAIParser, protocolStream, streamMessages } from '../kernel/api.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

test('detectProtocol：OPENAI env 优先，否则 Anthropic，都没有返回 null', () => {
  assert.equal(detectProtocol({ OPENAI_BASE_URL: 'http://x', OPENAI_API_KEY: 'k' }), 'openai')
  assert.equal(detectProtocol({ OPENAI_BASE_URL: 'http://x', OPENAI_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://y' }), 'openai')
  assert.equal(detectProtocol({ ANTHROPIC_BASE_URL: 'http://y' }), 'anthropic')
  assert.equal(detectProtocol({}), null)
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

test('OpenAI 解析器：content/reasoning_content/tool_calls/末尾 usage → 相同 chunk 形状', () => {
  const p = createOpenAIParser()
  const out = []
  out.push(...p.feed({ choices: [{ delta: { content: '第一段。\n\n' } }] }))
  out.push(...p.feed({ choices: [{ delta: { reasoning_content: '思考中…' } }] }))
  out.push(...p.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't2', function: { name: 'Read', arguments: '{"file_path":' } }] } }] }))
  out.push(...p.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] }))
  out.push(...p.feed({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }))
  out.push(...p.feed({ choices: [{ delta: { content: '第二段。\n\n' } }] }))
  out.push(...p.feed({ usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } }))
  out.push(...p.finish())
  const tool = out.find((c) => c.type === 'tool_use')
  assert.deepEqual(tool, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.txt' } })
  assert.ok(out.some((c) => c.type === 'thinking'))
  const usage = out.find((c) => c.type === 'usage').usage
  assert.equal(usage.input_tokens, 11)
  assert.equal(usage.output_tokens, 7)
  assert.equal(usage.cache_read_input_tokens, 4)
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
    for await (const c of protocolStream({ protocol: 'anthropic', url: 'http://t/v1/messages', body: {}, headers: {} })) chunks.push(c)
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
    assert.deepEqual(captured[0].body.tools.map((t) => t.name), ['Bash', 'Read', 'Write'])
    assert.equal(captured[0].body.tools[0].input_schema.type, 'object')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    global.fetch = prev
    process.env = oldEnv
  }
})

test('tools 注入：OpenAI 请求 body 为 function 形状且 system 并入 messages', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":""}}]}\n\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { OPENAI_BASE_URL: 'http://o', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' })
  try {
    const tools = createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'] }).toolSchemas()
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools, signal: undefined })) chunks.push(c)
    assert.equal(captured.length, 1)
    assert.ok(captured[0].url.endsWith('/v1/chat/completions'))
    assert.ok(captured[0].body.messages[0].role === 'system' || !captured[0].body.messages.some((m) => m.role === 'system'))
    const tool0 = captured[0].body.tools[0]
    assert.equal(tool0.type, 'function')
    assert.equal(tool0.function.name, 'Bash')
    assert.equal(tool0.function.parameters.type, 'object')
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
