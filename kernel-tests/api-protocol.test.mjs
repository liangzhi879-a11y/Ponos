import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectProtocol, createAnthropicParser, protocolStream, streamMessages, toAbortSignal, classifyApiError, cacheMarkerEnabled, stripAccountingFields } from '../kernel/api.mjs'
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
  // 模型不存在/已下线（2026-09-11 改名适配）：单独分类，engine 落重新探测引导
  const mnf1 = new Error('404 {"error":{"message":"Model deepseek-chat not found"}}')
  mnf1.status = 404
  assert.deepEqual(classifyApiError(mnf1), { kind: 'model-not-found', retryable: false })
  const mnf2 = new Error('400 invalid model: old-name')
  mnf2.status = 400
  assert.equal(classifyApiError(mnf2).kind, 'model-not-found')
  const mnf3 = new Error('unknown model qwen-x')
  mnf3.status = 404
  assert.equal(classifyApiError(mnf3).kind, 'model-not-found')
  // 非模型语义的 404 不误判
  const notFound = new Error('404 page not found')
  notFound.status = 404
  assert.equal(classifyApiError(notFound).kind, 'unknown')
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
  const oldTimeout = process.env.PONOS_STREAM_IDLE_TIMEOUT_MS
  process.env.PONOS_STREAM_IDLE_TIMEOUT_MS = '50'
  try {
    await assert.rejects(
      (async () => {
        for await (const c of protocolStream({ url: 'http://t/v1/messages', body: {}, headers: {} })) {}
      })(),
      /stream idle timeout/,
    )
  } finally {
    global.fetch = prev
    if (oldTimeout === undefined) delete process.env.PONOS_STREAM_IDLE_TIMEOUT_MS
    else process.env.PONOS_STREAM_IDLE_TIMEOUT_MS = oldTimeout
  }
})

test('protocolStream（C1）：慢 chunk 流不被空闲看门狗误杀——脉冲语义按单次 read 计', async () => {
  // C1：idle 看门狗必须是"每次 read 的空闲"而非"整流静默"。chunk 间隔 40ms（< 阈值
  // 80ms）但流总时长 160ms（> 阈值）——脉冲语义下每次 read 都在 40ms 内 resolve，
  // 不应抛 stream idle timeout；若看门狗按整流计时则必然误杀（回归防线）。
  const enc = new TextEncoder()
  const prev = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      async start(c) {
        for (const t of ['a', 'b', 'c', 'd']) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n\n`))
          await new Promise((r) => setTimeout(r, 40))
        }
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    }),
  })
  const old = process.env.PONOS_STREAM_IDLE_TIMEOUT_MS
  process.env.PONOS_STREAM_IDLE_TIMEOUT_MS = '80'
  try {
    const texts = []
    for await (const c of protocolStream({ url: 'http://t/v1/messages', body: {}, headers: {} })) {
      if (c.type === 'text') texts.push(c.text)
    }
    assert.equal(texts.join(''), 'abcd', '慢 chunk 流应完整读完（单次 read 在阈值内，看门狗不触发）')
  } finally {
    global.fetch = prev
    if (old === undefined) delete process.env.PONOS_STREAM_IDLE_TIMEOUT_MS
    else process.env.PONOS_STREAM_IDLE_TIMEOUT_MS = old
  }
})

// 【2026-09-18 P1-9】请求面剔除本地记账字段（usage / model）。
// 病灶：engine 轮末 `setEntryUsage` 会给**已发出过**的 assistant 消息补 usage，使上一轮与
// 本轮请求的公共前缀在最末一条 assistant 处断掉；且这些字段对模型无语义、白付每轮重传。
// ⚠ 关键约束：必须在**序列化层**剔除，不能改 deriveMessages —— context 的估算缓存以消息
// **对象身份**为 WeakMap 键（context.mjs 注释里明确列为"可证不陈旧"依据之一），无差别拷贝
// 会击穿估算缓存。本测试同时锁住"无这两键的对象必须原引用返回"。
test('stripAccountingFields（P1-9）：剔除 usage/model，且不含者保持同一引用（身份契约）', () => {
  const plain = { role: 'user', content: 'hi' }
  const withUsage = { role: 'assistant', content: 'ok', usage: { input_tokens: 5, cache_read_input_tokens: 3 }, model: 'm-1' }
  const out = stripAccountingFields([plain, withUsage])
  // ① 剔除生效，且原有语义字段完整保留
  assert.equal('usage' in out[1], false, 'usage 不得进模型输入')
  assert.equal('model' in out[1], false, 'model 不得进模型输入')
  assert.equal(out[1].role, 'assistant')
  assert.equal(out[1].content, 'ok')
  // ② 身份契约：不含记账字段者必须**原引用**（否则击穿 context 估算 WeakMap 缓存）
  assert.equal(out[0], plain, '无记账字段的消息必须原样返回同一对象引用')
  assert.notEqual(out[1], withUsage, '带记账字段者做浅拷贝')
  // ③ 不得就地修改原对象（transcript/派生缓存仍持有它，且 readonly --usage 依赖其 usage）
  assert.ok(withUsage.usage && withUsage.model, '原对象不得被就地改写（存储侧照旧保留）')
})

test('stripAccountingFields（P1-9）：请求体端到端不含 usage/model（含 system 抽离路径）', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push(JSON.parse(String(init.body)))
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { PONOS_BASE_URL: 'https://api.anthropic.com', PONOS_AUTH_TOKEN: 'k' })
  try {
    const messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1', usage: { input_tokens: 9 }, model: 'm' },
      { role: 'user', content: 'q2' },
    ]
    for await (const _ of streamMessages({ model: 'm', messages, maxTokens: 64 })) { /* drain */ }
    assert.equal(captured.length, 1)
    const sent = captured[0].messages
    assert.equal(sent.length, 3, 'system 仍抽离为顶层参数')
    for (const m of sent) {
      assert.equal('usage' in m, false, `请求体不得含 usage：${JSON.stringify(m).slice(0, 80)}`)
      assert.equal('model' in m, false, '请求体不得含 model')
    }
    // 原数组未被就地改写（transcript 侧数据保留）
    assert.ok(messages[2].usage && messages[2].model)
  } finally {
    global.fetch = prev
    for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k]
    Object.assign(process.env, oldEnv)
  }
})

test('detectProtocol：Anthropic env 存在 → anthropic，否则 null', () => {
  assert.equal(detectProtocol({ PONOS_BASE_URL: 'http://y' }), 'anthropic')
  assert.equal(detectProtocol({}), null)
  assert.equal(detectProtocol({ OPENAI_BASE_URL: 'http://x' }), null)
})

// 【2026-09-18 P0-2】缓存标记按端点能力判定：Anthropic 官方不打标记 = 0 命中（必须自动开），
// DeepSeek 忽略该字段（开了无用、还可能撞 400 触发去标记重发）。显式 env 必须仍能覆盖，
// 否则既有手工契约与排障手段消失。
test('cacheMarkerEnabled（P0-2）：显式 env 覆盖优先，未设时按端点能力判定', () => {
  // ① 显式优先：无论端点是什么，env 说了算（保留既有契约）
  assert.equal(cacheMarkerEnabled('https://api.deepseek.com', { PONOS_PROMPT_CACHE: '1' }), true)
  assert.equal(cacheMarkerEnabled('https://api.anthropic.com', { PONOS_PROMPT_CACHE: '0' }), false)
  // ② 未设：必须显式标记的端点自动开（否则缓存收益归零）
  assert.equal(cacheMarkerEnabled('https://api.anthropic.com', {}), true)
  assert.equal(cacheMarkerEnabled('https://bedrock-runtime.us-east-1.amazonaws.com', {}), true)
  assert.equal(cacheMarkerEnabled('https://us-central1-aiplatform.googleapis.com', {}), true)
  // ③ 未设：DeepSeek / 本地 / 未知网关保持关闭 = 原有默认行为不变（零回归）
  assert.equal(cacheMarkerEnabled('https://api.deepseek.com', {}), false)
  assert.equal(cacheMarkerEnabled('http://127.0.0.1:8000', {}), false)
  assert.equal(cacheMarkerEnabled('https://gw.internal.example.com', {}), false)
})

// 端到端接线：纯函数判定必须真的作用到请求体，防止"判定写了但没接上"（本仓库
// docs/2026-09-15-五引擎架构性能对比分析.md 记录过同类死逻辑 PROMPT_CACHE_BREAK_DETECTION）。
test('cacheMarkerEnabled（P0-2）：Anthropic 端点未设 env 时请求体自动带 cache_control', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ body: JSON.parse(String(init.body)) })
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { PONOS_BASE_URL: 'https://api.anthropic.com', PONOS_AUTH_TOKEN: 'k' })
  delete process.env.PONOS_PROMPT_CACHE
  try {
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(captured.length, 1)
    const sys = captured[0].body.system
    assert.ok(Array.isArray(sys), 'Anthropic 端点应自动转数组形态并打标记')
    assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' })
  } finally {
    global.fetch = prev
    for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k]
    Object.assign(process.env, oldEnv)
  }
})

test('cacheMarkerEnabled（P0-2）：DeepSeek 端点未设 env 时不打标记（system 保持字符串）', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ body: JSON.parse(String(init.body)) })
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { PONOS_BASE_URL: 'https://api.deepseek.com', PONOS_AUTH_TOKEN: 'k' })
  delete process.env.PONOS_PROMPT_CACHE
  try {
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], maxTokens: 100 })) chunks.push(c)
    assert.equal(captured[0].body.system, 'SYS', 'DeepSeek 忽略该字段，不发无谓标记（避免 400 重发）')
  } finally {
    global.fetch = prev
    for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k]
    Object.assign(process.env, oldEnv)
  }
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

// 【2026-09-18 P0-1】缓存字段别名：端点回传 DeepSeek **原生**名字时也必须读到命中数。
// 此前只认 Anthropic 形态，端点若回传原生名字 ⇒ 命中读成 0 且全程静默（观测/成本/预算
// 同时失真）。两家口径不同：Anthropic 的 input 不含命中；DeepSeek 的 prompt_tokens 含命中
// ——必须按来源归一，否则命中部分被按全价重复计一次。
test('usage 归一化（P0-1）：DeepSeek 原生 prompt_cache_hit_tokens → cache_read，input 扣掉命中部分', () => {
  const p = createAnthropicParser()
  const out = p.feed({
    type: 'message_delta',
    usage: { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
  })
  const u = out.find((c) => c.type === 'usage').usage
  assert.equal(u.cache_read_input_tokens, 80, '命中数必须从原生字段读到')
  assert.equal(u.input_tokens, 20, 'prompt_tokens 含命中部分，须扣减以免重叠计费')
  assert.equal(u.output_tokens, 7, 'completion_tokens 别名')
})

test('usage 归一化（P0-1）：Anthropic 形态 input 不含命中 → 不扣减（回归保护）', () => {
  const p = createAnthropicParser()
  const out = p.feed({
    type: 'message_delta',
    usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 80 },
  })
  const u = out.find((c) => c.type === 'usage').usage
  assert.equal(u.input_tokens, 100, 'Anthropic 语义下 input 已不含命中，扣减会少算')
  assert.equal(u.cache_read_input_tokens, 80)
})

test('usage 归一化（P0-1）：无缓存字段时两个口径都退化为原值', () => {
  const p = createAnthropicParser()
  const out = p.feed({ type: 'message_delta', usage: { prompt_tokens: 100, completion_tokens: 7 } })
  const u = out.find((c) => c.type === 'usage').usage
  assert.equal(u.input_tokens, 100)
  assert.equal(u.cache_read_input_tokens, 0)
})

// OpenAI 形态：prompt_tokens + prompt_tokens_details.cached_tokens（Responses API 走
// input_tokens_details.cached_tokens）。命中数同样是 prompt_tokens 的**子集**，须扣减。
test('usage 归一化（P0-1）：OpenAI 形态 cached_tokens → cache_read，input 扣掉命中部分', () => {
  const p = createAnthropicParser()
  const out = p.feed({
    type: 'message_delta',
    usage: { prompt_tokens: 100_000, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 90_000 } },
  })
  const u = out.find((c) => c.type === 'usage').usage
  assert.equal(u.cache_read_input_tokens, 90_000, 'OpenAI 形态别名必须读到（否则观测层判"端点无缓存"而整体静默）')
  assert.equal(u.input_tokens, 10_000, 'cached_tokens 是 prompt_tokens 的子集，须扣减')
  const p2 = createAnthropicParser()
  const out2 = p2.feed({ type: 'message_delta', usage: { prompt_tokens: 100, input_tokens_details: { cached_tokens: 80 } } })
  const u2 = out2.find((c) => c.type === 'usage').usage
  assert.equal(u2.cache_read_input_tokens, 80, 'Responses API 形态别名')
})

// 【2026-09-12 流式观感 + 丢字回归】原实现只在 "\n\n" 处产出文本 chunk（整段被扣到
// 流末 finish() 才一次性吐出 ⇒ 观感"卡住几个字、不是流式输出"），且调用方用
// `for (const seg of segmentText(textBuf)) { textBuf = '' }` 丢弃了生成器的
// `return rest` 尾巴 ⇒ 同一 delta 内段落界之后的文字永久丢失（含引擎落盘消息）。
const TD = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })

test('Anthropic 解析器：无空行长文本不得被扣到流末（非流式观感回归）', () => {
  const p = createAnthropicParser()
  const full = '这是一段没有空行的正文，模型逐字吐出来。'
  const seen = []
  for (const ch of full) seen.push(...p.feed(TD(ch)))
  const before = seen.filter((c) => c.type === 'text')
  assert.ok(before.length >= 1, 'finish() 之前必须已有帧产出，否则整段扣到流末 = 观感"卡住几个字"')
  const joined = [...seen, ...p.finish()].filter((c) => c.type === 'text').map((c) => c.text).join('')
  assert.equal(joined, full, '增量拼接必须与原文逐字一致（既不丢也不重）')
})

test('Anthropic 解析器：同 delta 内"段落界 + 后续文字"的尾巴不得丢失', () => {
  const p = createAnthropicParser()
  const seen = [
    ...p.feed(TD('第一段\n\n第二段开始')), // 旧实现：只吐 '第一段\n\n'，'第二段开始' 永久丢失
    ...p.feed(TD('，继续写。')),
    ...p.finish(),
  ]
  assert.equal(seen.filter((c) => c.type === 'text').map((c) => c.text).join(''), '第一段\n\n第二段开始，继续写。')
})

test('Anthropic 解析器：单块多段 SSE 不得只活下第一段', () => {
  const p = createAnthropicParser()
  const full = '## 标题\n\n正文第一句。\n\n正文第二句。'
  const seen = [...p.feed(TD(full)), ...p.finish()]
  assert.equal(seen.filter((c) => c.type === 'text').map((c) => c.text).join(''), full)
})

test('Anthropic 解析器：PONOS_TEXT_FLUSH_CHARS=1 → 每 delta 一帧（最大流式粒度）', () => {
  const prev = process.env.PONOS_TEXT_FLUSH_CHARS
  process.env.PONOS_TEXT_FLUSH_CHARS = '1'
  try {
    const p = createAnthropicParser()
    const seen = []
    for (const ch of '今天天气不错') seen.push(...p.feed(TD(ch)))
    assert.equal(seen.filter((c) => c.type === 'text').length, 6, '阈值 1 时应逐字成帧')
  } finally {
    if (prev === undefined) delete process.env.PONOS_TEXT_FLUSH_CHARS
    else process.env.PONOS_TEXT_FLUSH_CHARS = prev
  }
})

// 【2026-09-12 标记完整性】按字符数切帧打碎了两个 HTML 注释标记族：
// ASK_USER 提问卡与 MILESTONE 进度标记都是 HTML 注释，而桥**逐帧**正则提取、要求
// 同一帧内闭合（server/bridge.mjs 的 extractAskUserBlocks / extractMilestoneMarks）。
// 探针实证：93 字标记被 16 字阈值切成 7 帧 ⇒ 卡片 0 命中 + 7 帧原始标记全漏进气泡。
const TH = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } })
const MARK = '<!--ASK_USER {"questions":[{"question":"选哪个方案？"}]}-->'

test('Anthropic 解析器：HTML 注释标记不得被切帧（桥逐帧提取的前提）', () => {
  const p = createAnthropicParser()
  const full = `请确认：${MARK} 收到请回复。`
  const frames = []
  for (const ch of full) frames.push(...p.feed(TD(ch))) // 逐字喂 = 最大切分压力
  frames.push(...p.finish())
  const texts = frames.filter((c) => c.type === 'text').map((c) => c.text)
  assert.equal(texts.join(''), full, '拼接必须与原文逐字一致')
  for (const t of texts) {
    if (t.includes('<!--')) assert.ok(t.includes('-->'), `帧内出现未闭合注释（桥无法提取）：${JSON.stringify(t)}`)
  }
  assert.ok(texts.some((t) => t.includes(MARK)), '完整标记必须整帧到达，否则卡片 0 命中')
})

test('Anthropic 解析器：注释载荷内含空行（\\n\\n）同样不得被切开', () => {
  const p = createAnthropicParser()
  const full = '进度：<!--MILESTONE-OK 1/3 读代码\n\n继续跑--> 完'
  const frames = []
  for (const ch of full) frames.push(...p.feed(TD(ch)))
  frames.push(...p.finish())
  const texts = frames.filter((c) => c.type === 'text').map((c) => c.text)
  assert.equal(texts.join(''), full)
  for (const t of texts) {
    if (t.includes('<!--')) assert.ok(t.includes('-->'), `段界落在注释内被切开：${JSON.stringify(t)}`)
  }
})

test('Anthropic 解析器：永不闭合的 <!-- 不得扣住整段（超上限放弃押后）', () => {
  const prev = process.env.PONOS_TEXT_MARKER_HOLD_MAX
  process.env.PONOS_TEXT_MARKER_HOLD_MAX = '32'
  try {
    const p = createAnthropicParser()
    const seen = []
    for (const ch of `开头<!-- 注释永不闭合 ${'x'.repeat(80)}`) seen.push(...p.feed(TD(ch)))
    assert.ok(
      seen.filter((c) => c.type === 'text').length >= 1,
      '超上限必须照常吐帧——否则"坏标记"把整段扣到流末，正是"卡住几个字"的病根',
    )
  } finally {
    if (prev === undefined) delete process.env.PONOS_TEXT_MARKER_HOLD_MAX
    else process.env.PONOS_TEXT_MARKER_HOLD_MAX = prev
  }
})

test('Anthropic 解析器：thinking 块内的标记不得被切帧（旧实现逐 delta 直发 ⇒ 从未解析成功）', () => {
  const p = createAnthropicParser()
  const marker = '<!--MILESTONE-START 1/3 读代码-->'
  const full = `先规划一下。${marker}现在开始。`
  const frames = []
  for (const ch of full) frames.push(...p.feed(TH(ch)))
  frames.push(...p.finish())
  const th = frames.filter((c) => c.type === 'thinking').map((c) => c.text)
  assert.equal(th.join(''), full, '思考内容逐字一致')
  assert.ok(th.some((t) => t.includes(marker)), '标记必须整帧到达（桥也从 thinking 提取里程碑）')
})

test('Anthropic 解析器：思考尾巴由 finish() 收口（新增缓冲不得引入丢字）', () => {
  const p = createAnthropicParser()
  const seen = [...p.feed(TH('短思考')), ...p.finish()] // 3 字 < 阈值 16 ⇒ 留在缓冲里
  assert.equal(seen.filter((c) => c.type === 'thinking').map((c) => c.text).join(''), '短思考')
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
  const env = { PONOS_BASE_URL: 'http://t', PONOS_AUTH_TOKEN: 'k', PONOS_MODEL: 'm' }
  const oldEnv = { ...process.env }
  Object.assign(process.env, env)
  try {
    const tools = createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'] }).toolSchemas()
    const chunks = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools, signal: undefined })) chunks.push(c)
    assert.equal(captured.length, 1)
    assert.ok(captured[0].url.endsWith('/v1/messages'))
    assert.ok(Array.isArray(captured[0].body.tools))
    assert.deepEqual(captured[0].body.tools.map((t) => t.name), ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'OCR', 'Vision', 'Skill', 'MemorySearch', 'KnowledgeSearch', 'KnowledgeImport', 'KnowledgeDelete', 'SkillSearch', 'Workflow', 'Browser'])
    assert.equal(captured[0].body.tools[0].input_schema.type, 'object')
    assert.ok(chunks.some((c) => c.type === 'usage'))
  } finally {
    global.fetch = prev
    process.env = oldEnv
  }
})

test('mock 扩展：检测系统压缩指令 → 返回 <compacted-summary> 摘要（收敛校验用）', async () => {
  const oldEnv = { ...process.env }
  Object.assign(process.env, { PONOS_MOCK_API: '1', PONOS_MOCK_COMPACT_RESPONSE: '1' })
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

test('mock 扩展：PONOS_MOCK_OVERFLOW=once 非压缩调用抛一次溢出，之后恢复', async () => {
  const oldEnv = { ...process.env }
  Object.assign(process.env, { PONOS_MOCK_API: '1', PONOS_MOCK_OVERFLOW: 'once' })
  delete process.env.PONOS_MOCK_OVERFLOW_CONSUMED
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

test('prompt cache：PONOS_PROMPT_CACHE=1 时 system 打 ephemeral 缓存标记（数组形态）', async () => {
  const captured = []
  const prev = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ body: JSON.parse(String(init.body)) })
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":1,"output_tokens":1}}\n\ndata: [DONE]\n\n')); c.close() } }) }
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, { PONOS_BASE_URL: 'http://t', PONOS_AUTH_TOKEN: 'k', PONOS_PROMPT_CACHE: '1' })
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
  Object.assign(process.env, { PONOS_BASE_URL: 'http://t', PONOS_AUTH_TOKEN: 'k', PONOS_PROMPT_CACHE: '1' })
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
  Object.assign(process.env, { PONOS_BASE_URL: 'http://t', PONOS_AUTH_TOKEN: 'k', PONOS_MOCK_API: '' })
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

test('R1-2 fetch 连接超时：首次 fetch 抛 TimeoutError → 经重发链路成功（fetch 调 2 次）', async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, opts) => {
    calls++
    if (calls === 1) {
      // 第一次模拟连接/首字节超时（响应头未到达）——内核 fetchWithConnectTimeout
      // 在超时窗口内 reject TimeoutError；测试直接抛同形状错误验证重发判定
      const e = new Error('连接超时: The operation was aborted due to timeout')
      e.name = 'TimeoutError'
      throw e
    }
    const enc = new TextEncoder()
    const ok = 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
               'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n' +
               'data: [DONE]\n'
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ok)); c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, {
    PONOS_BASE_URL: 'http://t',
    PONOS_AUTH_TOKEN: 'k',
    PONOS_MOCK_API: '',
    PONOS_CONNECT_TIMEOUT_MS: '150',   // 测试缩短
    PONOS_STREAM_RECONNECTS: '2',
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

test('R1-2 连接超时只作用于首字节：fetch 快速 resolve 后长流不被 30s timer 误杀', async () => {
  // 回归：P1 R1-2 把 AbortSignal.timeout(connectTimeoutMs) 并入 fetch signal，
  // 其 timer 在 fetch resolve 后仍存活——长 thinking 流（总时长 > 连接超时）
  // 会被 30s 的 abort 误杀（T003 评测实测 "stream interrupted: ... timeout"）。
  // 修复后：超时仅覆盖"响应头到达前"，流读取只受 idle 看门狗约束。
  const origFetch = globalThis.fetch
  const enc = new TextEncoder()
  globalThis.fetch = async () => {
    // fetch 立即 resolve（响应头到达）；正文分 5 块、每块间隔 40ms（总 200ms > 100ms 连接超时）
    const body = new ReadableStream({
      async start(c) {
        for (const t of ['a', 'b', 'c', 'd', 'e']) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n\n`))
          await new Promise((r) => setTimeout(r, 40))
        }
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const oldEnv = { ...process.env }
  Object.assign(process.env, {
    PONOS_BASE_URL: 'http://t',
    PONOS_AUTH_TOKEN: 'k',
    PONOS_MOCK_API: '',
    PONOS_CONNECT_TIMEOUT_MS: '100',  // 100ms 连接超时，远小于流总时长 200ms
    PONOS_STREAM_IDLE_TIMEOUT_MS: '5000',
  })
  try {
    const texts = []
    for await (const c of streamMessages({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) {
      if (c.type === 'text') texts.push(c.text)
    }
    // parser 合并同块 text_delta，断言拼接全文（是否被误杀看完整性，不看分块粒度）
    assert.equal(texts.join(''), 'abcde', '长流应完整读完，不被连接超时误杀')
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
    // 合法 SSE 事件（data: 前缀）：message_start 后接一个文本块再收尾——保证非空流，
    // 否则会触发 P1-11 空流归一（DeadStreamError）而非测 URL 路由
    const sse = (o) => `data: ${JSON.stringify(o)}\n`
    const body = sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
      + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
      + sse({ type: 'content_block_stop', index: 0 })
      + sse({ type: 'message_stop' })
    return new Response(body, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }
  const oldEnv = { ...process.env }
  try {
    process.env.PONOS_BASE_URL = 'http://orig'
    process.env.PONOS_AUTH_TOKEN = 'k'
    process.env.PONOS_MOCK_API = ''
    process.env.PONOS_CONNECT_TIMEOUT_MS = '150'
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
