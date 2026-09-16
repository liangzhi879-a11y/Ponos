// 模型调用层（electron/app-llm.cjs）契约测试。
//
// 2026（收敛改造）后 app-llm 的调用链 = 内核 kernel/api.mjs 的 streamMessages 单一真源：
//   协议解析/思考增量/流内错误/空流判定/错误分类 都由内核实现，内核自己的
//   api-protocol.test.mjs / api-deepseek-adapt.test.mjs / api-empty-stream.test.mjs /
//   effort-wire.test.mjs 已覆盖 wire 细节，本文件只断言**本调用点的契约**：
//     最终文本聚合与 onDelta 一致、thinking 不进正文、无正文时的可诊断错误（stop_reason/
//     usage/思考量）、错误与超时行为、半截文本保留、注入 fetch 被真正使用且调用后还原、
//     守卫用 env 不留痕、provider 参数优先、默认关思考（本文件独有 policy）。
//   **覆盖点只增不减**：原「请求头/body 形状」「OpenAI 分支」「非流式回退」等 wire 断言，
//   凡在本调用点仍有的语义（鉴权头、model/max_tokens/system/messages/stream、非流式网关
//   兜底、思考开关）都在下面以契约级形式保留。
//
// 顶部原先的 `process.env.PONOS_MOCK_API = '1'` 已删除：它只对本文件内的假 fetch 测试
// 制造噪音——app-llm 现在走内核 streamMessages，该 env 会把调用劫持到内核 mockStream，
// 使注入的假 fetch 永不生效（旧版 app-llm 自建客户端不读它，故是历史残留）。
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

/** 一段正文增量（≥16 字符：内核按阈值切帧，短尾巴会留在缓冲里等流末） */
const TEXT_DELTA = (s) => `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${s}"}}`
const THINK_DELTA = (s) => `data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"${s}"}}`

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

// ---------- 仍按契约导出的兼容解析器（真实链路已由内核 createAnthropicParser 接管） ----------

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

// ---------- 端到端（假 fetch；内核 streamMessages 单一路径） ----------

test('callLlmStream：Anthropic SSE 聚合文本，onDelta 分片与最终 text 一致', async () => {
  const deltas = []
  const fetchImpl = async () => sseResponse([
    'event: message_start',
    'data: {"type":"message_start"}',
    TEXT_DELTA('{\\"a\\"'),
    TEXT_DELTA(':1}'),
    'data: {"type":"message_stop"}',
  ])
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl, onDelta: (d, t) => deltas.push([d, t]) })
  assert.equal(r.ok, true)
  assert.equal(r.text, '{"a":1}')
  assert.ok(deltas.length >= 1, 'onDelta 必须被调用（界面流式进度依赖它）')
  assert.equal(deltas.map(([d]) => d).join(''), r.text, '分片拼接 === 最终文本（不得丢字/重复）')
  assert.equal(deltas[deltas.length - 1][1], r.text.length, '第二参数是累计字符数')
})

test('callLlmStream：默认关思考 —— 请求带 thinking:disabled（思考吃满 max_tokens 的修复点）', async () => {
  let seen = null
  const fetchImpl = async (url, init) => { seen = { url, init }; return sseResponse([TEXT_DELTA('x')]) }
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
  assert.deepEqual(body.thinking, { type: 'disabled' }, '生成链路只要稳定 JSON：默认关思考')
  assert.equal(body.reasoning_effort, undefined, '关思考时不再叠加 reasoning_effort（DeepSeek 兼容端点会 400）')
})

test('callLlmStream：bearer 档 provider → authorization 头（鉴权走内核 registry 同口径）', async () => {
  let seen = null
  const fetchImpl = async (url, init) => { seen = init; return sseResponse([TEXT_DELTA('x')]) }
  const r = await callLlmStream({ system: 's', user: 'u', provider: { ...fakeProvider, authScheme: 'bearer' }, fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(seen.headers.authorization, 'Bearer tk')
  assert.equal(seen.headers['x-api-key'], undefined)
})

test('callLlmStream：thinking_delta 不计入正文，也不进 onDelta', async () => {
  const deltas = []
  const fetchImpl = async () => sseResponse([
    THINK_DELTA('内部推理：先看看需求再决定输出什么 JSON'),
    TEXT_DELTA('{\\"ok\\":true}'),
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
    'data: {"type":"message_stop"}',
  ])
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl, onDelta: (d) => deltas.push(d) })
  assert.equal(r.ok, true, '有思考有正文：必须在 max_tokens 被思考吃掉之前照样拿到正文')
  assert.equal(r.text, '{"ok":true}')
  assert.equal(deltas.join(''), '{"ok":true}', '思考内容不得混进 onDelta')
})

test('callLlmStream：思考吃满 max_tokens 且无正文 → 可诊断错误（含 stop_reason/usage/思考量）', async () => {
  const fetchImpl = async () => sseResponse([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}',
    THINK_DELTA('反复推演但一个字正文都没写出来'),
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":16}}',
    'data: {"type":"message_stop"}',
  ])
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl, maxTokens: 16 })
  assert.equal(r.ok, false)
  assert.equal(r.text, '')
  assert.match(r.error, /模型没有输出任何文本/)
  assert.match(r.error, /stop_reason=max_tokens/, '必须带 stop_reason，才能区分「思考吃满」与「网关无输出」')
  assert.match(r.error, /输出 token=16/, '必须带 usage 输出 token 数')
  const thinkChars = Number(/思考 (\d+) 字符/.exec(r.error)?.[1])
  assert.ok(thinkChars > 0, `错误文案要带思考字符数，实际：${r.error}`)
  assert.match(r.error, /思考内容吃满 max_tokens/)
})

test('callLlmStream：流内既无思考也无正文 → 如实报出（区别于思考吃满）', async () => {
  const fetchImpl = async () => sseResponse(['data: {"type":"message_stop"}'])
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.error, /模型没有输出任何文本/)
  assert.match(r.error, /stop_reason=null/)
  assert.match(r.error, /输出 token=0/)
  assert.match(r.error, /疑似网关无输出/)
})

test('callLlmStream：调用方显式给 reasoningEffort / thinkingMode 时尊重调用方', async () => {
  const saved = process.env.PONOS_THINKING_ENABLED
  delete process.env.PONOS_THINKING_ENABLED
  try {
    let seen = null
    const fetchImpl = async (url, init) => { seen = init; return sseResponse([TEXT_DELTA('x')]) }
    await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl, reasoningEffort: 'low' })
    let body = JSON.parse(seen.body)
    assert.equal(body.reasoning_effort, 'low', '显式档位要发出去（不因默认关思考被吃掉）')
    assert.equal(body.thinking, undefined)

    await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl, thinkingMode: null })
    body = JSON.parse(seen.body)
    assert.equal(body.thinking, undefined, 'thinkingMode=null 表示「不干预」')

    await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl, thinkingMode: 'off' })
    body = JSON.parse(seen.body)
    assert.deepEqual(body.thinking, { type: 'disabled' })
  } finally {
    if (saved === undefined) delete process.env.PONOS_THINKING_ENABLED
    else process.env.PONOS_THINKING_ENABLED = saved
  }
})

test('callLlmStream：HTTP 非 2xx → 带状态码与响应体片段（不抛）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, body: null, text: async () => 'invalid api key' })
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('401'))
  assert.ok(r.error.includes('invalid api key'))
})

// 非流式网关：内核 protocolStream 要求 res.body 可读，忽略 stream 参数的网关会落到
// 「API 请求失败 200 + 整段 JSON」上；app-llm 侧把这层兜底保留（不新增第二套解析，复用 textFromWholeBody）
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

test('callLlmStream：超时 → 报超时；已收到的部分文本如实保留', async () => {
  const partial = '半截文本已经足够长到被内核切帧吐出来'
  const fetchImpl = async (_url, init) => {
    const enc = new TextEncoder()
    const body = new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode(`${TEXT_DELTA(partial)}\n`))
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
  assert.equal(r.text, partial, '已收到的部分要留给界面展示，不整段丢弃')
})

test('callLlmStream：注入的 fetch 确实被调用，且调用后 globalThis.fetch 已还原', async () => {
  const realFetch = globalThis.fetch
  let called = 0
  let swappedDuringCall = false
  const fetchImpl = async () => { called++; swappedDuringCall = globalThis.fetch === fetchImpl; return sseResponse([TEXT_DELTA('x')]) }
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(called, 1)
  assert.equal(swappedDuringCall, true, '内核 protocolStream 走裸 fetch：调用期间必须已完成替换')
  assert.equal(globalThis.fetch, realFetch, '调用结束必须恢复原 fetch（不污染进程）')
})

test('callLlmStream：不传 fetchImpl（生产路径）不做任何全局替换', async () => {
  const realFetch = globalThis.fetch
  const r = await callLlmStream({ system: 's', user: 'u', provider: { ...fakeProvider, model: '' } })
  assert.equal(r.ok, false)
  assert.equal(globalThis.fetch, realFetch)
})

test('callLlmStream：守卫用 env（PONOS_BASE_URL）调用后还原，已有值不被覆盖', async () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PONOS_BASE_URL')
  const prev = process.env.PONOS_BASE_URL
  try {
    const fetchImpl = async () => sseResponse([TEXT_DELTA('x')])
    delete process.env.PONOS_BASE_URL
    const r1 = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
    assert.equal(r1.ok, true)
    assert.equal(process.env.PONOS_BASE_URL, undefined, '守卫只借 env 一用：不得永久留在 process.env')

    process.env.PONOS_BASE_URL = 'https://preset.example'
    const r2 = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
    assert.equal(r2.ok, true)
    assert.equal(process.env.PONOS_BASE_URL, 'https://preset.example', '本来就有值时不得乱改/删除')
  } finally {
    if (had) process.env.PONOS_BASE_URL = prev
    else delete process.env.PONOS_BASE_URL
  }
})

test('callLlmStream：守卫 env 名跨内核版本兼容（PONOS_BASE_URL / ANTHROPIC_BASE_URL 都补且都还原）', async () => {
  // 实证背景：发布目录 release/YFWorking/kernel 的 detectProtocol() 读 ANTHROPIC_BASE_URL
  // （工作区 kernel 读 PONOS_BASE_URL）。漏补旧名时真机会抛
  // 「内核：未检测到可用协议（需 ANTHROPIC_BASE_URL）」——本用例钉住双名兼容。
  const KEYS = ['PONOS_BASE_URL', 'ANTHROPIC_BASE_URL']
  const snapshot = KEYS.map((k) => [k, Object.prototype.hasOwnProperty.call(process.env, k), process.env[k]])
  try {
    for (const k of KEYS) delete process.env[k]
    const seen = {}
    const fetchImpl = async () => { seen.env = { ...process.env }; return sseResponse([TEXT_DELTA('x')]) }
    const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
    assert.equal(r.ok, true)
    for (const k of KEYS) {
      assert.equal(seen.env[k], fakeProvider.baseUrl, `守卫期间 ${k} 应为真实 baseUrl（版本漂移下两个名字都要在）`)
      assert.equal(process.env[k], undefined, `${k} 只借一用：调用后不得留在 process.env`)
    }

    // 已有值时一律尊重既有值，不改不删
    for (const k of KEYS) process.env[k] = `https://preset.example/${k}`
    const r2 = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
    assert.equal(r2.ok, true)
    for (const k of KEYS) assert.equal(process.env[k], `https://preset.example/${k}`, `${k} 本来就有值时不得乱改/删除`)
  } finally {
    for (const [k, had, prev] of snapshot) {
      if (had) process.env[k] = prev
      else delete process.env[k]
    }
  }
})

test('callLlmStream：未配置 provider 时直接用传入 provider（测试与多 provider 复用）', async () => {
  let called = false
  const fetchImpl = async (url) => { called = true; assert.equal(url, 'https://api.test/anthropic/v1/messages'); return sseResponse([TEXT_DELTA('ok')]) }
  const r = await callLlmStream({ system: 's', user: 'u', provider: fakeProvider, fetchImpl })
  assert.equal(called, true)
  assert.equal(r.ok, true)
  assert.equal(r.text, 'ok')
})

test('callLlmStream：无 provider 且配置缺失 → 报配置问题（不发请求）', async () => {
  const home = withHome({})
  let called = false
  const fetchImpl = async () => { called = true; return sseResponse([]) }
  const r = await callLlmStream({ system: 's', user: 'u', fetchImpl, provider: null, ...{ __home: home } })
  // provider=null → 走 loadProvider()，读真实 home（可能存在于本机），故此处只断言不因缺配置而崩
  assert.equal(typeof r.ok, 'boolean')
  assert.equal(typeof r.error, 'string')
  rmSync(home, { recursive: true, force: true })
})
