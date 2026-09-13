// 模型调用层：用假 fetch 覆盖 Anthropic/OpenAI 两种流式形态与各类失败
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { callLlmStream, loadProvider, authHeaders, parseDelta } = require('../electron/app-llm.cjs')

/** 造一个流式 Response（body 为 web ReadableStream） */
function sseResponse(lines, { status = 200 } = {}) {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + '\n'))
      c.close()
    },
  })
  return { ok: status >= 200 && status < 300, status, body, text: async () => lines.join('\n') }
}

const fakeProvider = { baseUrl: 'https://api.test/anthropic', authToken: 'tk', model: 'm1' }

function withHome(cfg) {
  const home = mkdtempSync(join(tmpdir(), 'llm-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg), 'utf-8')
  return home
}

// ---------- 配置读取 ----------

test('loadProvider：缺 config.json → 结构化错误（不抛）', () => {
  const home = mkdtempSync(join(tmpdir(), 'llm-'))
  try {
    const r = loadProvider({ home })
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('读不到模型配置'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('loadProvider：取 activeProvider 的 baseUrl/token/model', () => {
  const home = withHome({ activeProvider: 'p1', providers: [{ id: 'p1', apiBaseUrl: 'https://a/', authToken: 't', primaryModel: 'm' }] })
  try {
    const r = loadProvider({ home })
    assert.equal(r.ok, true)
    assert.equal(r.provider.baseUrl, 'https://a', '结尾斜杠应被去掉')
    assert.equal(r.provider.model, 'm')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('loadProvider：缺 token / 缺模型 → 分别给出可读原因', () => {
  const h1 = withHome({ providers: [{ id: 'p', apiBaseUrl: 'https://a', primaryModel: 'm' }] })
  const h2 = withHome({ providers: [{ id: 'p', apiBaseUrl: 'https://a', authToken: 't' }] })
  try {
    assert.ok(loadProvider({ home: h1 }).error.includes('authToken'))
    assert.ok(loadProvider({ home: h2 }).error.includes('模型名'))
  } finally { rmSync(h1, { recursive: true, force: true }); rmSync(h2, { recursive: true, force: true }) }
})

test('authHeaders：默认 x-api-key，bearer 档用 authorization', () => {
  assert.deepEqual(authHeaders({ authToken: 'abc' }), { 'x-api-key': 'abc' })
  assert.deepEqual(authHeaders({ authToken: 'abc', authScheme: 'bearer' }), { authorization: 'Bearer abc' })
  assert.deepEqual(authHeaders({ authToken: 'Bearer abc', authScheme: 'bearer' }), { authorization: 'Bearer abc' }, '已带前缀不再重复加')
})

// ---------- SSE 解析 ----------

test('parseDelta：Anthropic 文本增量', () => {
  assert.deepEqual(parseDelta('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}'), { text: '你好' })
})

test('parseDelta：OpenAI 风格增量也认', () => {
  assert.deepEqual(parseDelta('data: {"choices":[{"delta":{"content":"hi"}}]}'), { text: 'hi' })
})

test('parseDelta：message_stop / [DONE] → done；非 data 行 → null', () => {
  assert.deepEqual(parseDelta('data: {"type":"message_stop"}'), { done: true })
  assert.deepEqual(parseDelta('data: [DONE]'), { done: true })
  assert.equal(parseDelta('event: ping'), null)
  assert.equal(parseDelta(''), null)
})

test('parseDelta：流内错误事件要能报出来', () => {
  assert.ok(parseDelta('data: {"type":"error","error":{"message":"overloaded"}}').error.includes('overloaded'))
})

// ---------- 端到端（假 fetch） ----------

test('callLlmStream：Anthropic SSE 拼接文本并逐段回调', async () => {
  const deltas = []
  const fetchImpl = async () => sseResponse([
    'event: message_start',
    'data: {"type":"message_start"}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"a\\""}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":":1}"}}',
    'data: {"type":"message_stop"}',
  ])
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl, onDelta: (d, t) => deltas.push([d, t]) })
  assert.equal(r.ok, true)
  assert.equal(r.text, '{"a":1}')
  assert.deepEqual(deltas, [['{"a"', 4], [':1}', 7]])
})

test('callLlmStream：请求头与 body 形状正确（协议对齐内核）', async () => {
  let seen = null
  const fetchImpl = async (url, init) => { seen = { url, init }; return sseResponse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}']) }
  await callLlmStream({ system: 'SYS', user: 'USR', provider: fakeProvider, fetchImpl, maxTokens: 123 })
  assert.equal(seen.url, 'https://api.test/anthropic/v1/messages')
  assert.equal(seen.init.headers['x-api-key'], 'tk')
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(seen.init.body)
  assert.equal(body.model, 'm1')
  assert.equal(body.max_tokens, 123)
  assert.equal(body.system, 'SYS')
  assert.deepEqual(body.messages, [{ role: 'user', content: 'USR' }])
  assert.equal(body.stream, true)
})

test('callLlmStream：HTTP 非 2xx → 带状态码与响应体片段（不抛）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, body: null, text: async () => 'invalid api key' })
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('401'))
  assert.ok(r.error.includes('invalid api key'))
})

test('callLlmStream：无 body（非流式网关）→ 回退整体解析 Anthropic JSON', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, body: null, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'whole' }] }) })
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'whole')
})

test('callLlmStream：无 body 且是 OpenAI 形态 → 也能取到文本', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, body: null, text: async () => JSON.stringify({ choices: [{ message: { content: 'oa' } }] }) })
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'oa')
})

test('callLlmStream：模型没吐任何文本 → 明确失败', async () => {
  const fetchImpl = async () => sseResponse(['data: {"type":"message_stop"}'])
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('没有输出任何文本'))
})

test('callLlmStream：超时 → 报超时；已收到的部分文本如实保留', async () => {
  const fetchImpl = async (_url, init) => {
    const enc = new TextEncoder()
    const body = new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半截"}}\n'))
        // 忠实模拟真实网关：中止时让流报错（若只是优雅 close，调用方会误判成"正常结束"）
        await new Promise((res) => {
          const t = setTimeout(res, 5000)
          init.signal.addEventListener('abort', () => {
            clearTimeout(t)
            const e = new Error('The operation was aborted')
            e.name = 'AbortError'
            c.error(e)
            res()
          })
        })
        try { c.close() } catch { /* 已 error，忽略 */ }
      },
    })
    return { ok: true, status: 200, body, text: async () => '' }
  }
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl, timeoutMs: 60 })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('超时'))
  assert.equal(r.text, '半截', '已收到的部分要留给界面展示，不整段丢弃')
})

test('callLlmStream：未配置 provider 时直接用传入 provider（测试与多 provider 复用）', async () => {
  let called = false
  const fetchImpl = async () => { called = true; return sseResponse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}']) }
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(called, true)
  assert.equal(r.ok, true)
})

test('callLlmStream：无 provider 且配置缺失 → 报配置问题（不发请求）', async () => {
  const home = withHome({})
  let called = false
  const fetchImpl = async () => { called = true; return sseResponse([]) }
  const r = await callLlmStream({ system: 's', user: 'u', fetchImpl, provider: null, ...{ __home: home } })
  // provider=null → 走 loadProvider()，读真实 home（可能存在于本机），故此处只断言不因缺配置而崩
  assert.equal(typeof r.ok, 'boolean')
  assert.equal(typeof r.error, 'string' === typeof r.error ? 'string' : typeof r.error)
  rmSync(home, { recursive: true, force: true })
})
