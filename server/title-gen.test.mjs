// 会话标题生成（服务端）测试（2026-09-18）
// ---------------------------------------------------------------------------
// 守护三件事（都是"效果一直不好"的真实成因）：
//   ① **基址带 `/v1` 时不得拼成 `/v1/v1/...`**（用户从 OpenAI 兼容文档抄来的基址通常带 /v1，
//      本地 vLLM 更常见）—— 这是双段 404、标题静默降级的主因；
//   ② **候选端点要能自动退**（openai 风格 404 → anthropic 风格），且 `<root>` 版本排在前；
//   ③ 只有**本地画像**才下发非标准字段 `chat_template_kwargs`（云端网关对未知字段有 400 先例）。
// 请求路径用真实 `http.Server` 起在 127.0.0.1 上实测（不是 mock fetch）：
// 候选回退、鉴权头、协议 body 形状、以及"全部失败要带 tried 说明"都在真实 HTTP 上验。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  buildTitleRequest, extractTitleFromResponse, requestTitleText, rootOf, titleUrlCandidates,
} from './title-gen.mjs'

test('rootOf：剥掉用户自带 /v1、/anthropic、/anthropic/v1 尾缀（含尾斜杠与大写）', () => {
  assert.equal(rootOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com')
  assert.equal(rootOf('https://api.deepseek.com/v1/'), 'https://api.deepseek.com')
  assert.equal(rootOf('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com')
  assert.equal(rootOf('https://api.deepseek.com/anthropic/v1'), 'https://api.deepseek.com')
  assert.equal(rootOf('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000')
  assert.equal(rootOf('https://api.deepseek.com'), 'https://api.deepseek.com')
  assert.equal(rootOf('  https://x.example/  '), 'https://x.example')
  assert.equal(rootOf(''), '')
})

test('候选端点：基址带 /v1 也不得出现 /v1/v1（本修复的主因）', () => {
  for (const base of ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com']) {
    const urls = titleUrlCandidates(base).map(c => c.url)
    assert.ok(!urls.some(u => u.includes('/v1/v1')), `不得拼接出双 /v1：${base} → ${urls.join(', ')}`)
    assert.ok(urls.includes('https://api.deepseek.com/v1/chat/completions'), `应含正确的 OpenAI 端点：${base}`)
  }
  // 本地 vLLM 常见写法
  const local = titleUrlCandidates('http://127.0.0.1:8000/v1').map(c => c.url)
  assert.deepEqual(local[0], 'http://127.0.0.1:8000/v1/chat/completions')
})

test('候选端点：去重、顺序（/anthropic 基址优先 anthropic 风格，其余优先 openai 风格）', () => {
  const plain = titleUrlCandidates('https://api.deepseek.com')
  assert.equal(plain[0].kind, 'openai', '普通基址先试 OpenAI 兼容端点（多数情况）')
  assert.equal(new Set(plain.map(c => c.url)).size, plain.length, '候选不得重复')
  assert.ok(plain.some(c => c.url === 'https://api.deepseek.com/anthropic/v1/messages'),
    'DeepSeek/MiniMax 的 anthropic 兼容端点在 /anthropic 下，必须在候选里')

  const anth = titleUrlCandidates('https://api.deepseek.com/anthropic')
  assert.equal(anth[0].kind, 'anthropic', '/anthropic 基址是明确信号 ⇒ 先试 anthropic 风格')
  assert.equal(new Set(anth.map(c => c.url)).size, anth.length, '候选不得重复')

  assert.deepEqual(titleUrlCandidates(''), [], '空基址没有候选（调用方据此返回失败）')
})

test('解析响应：OpenAI / Anthropic / 分片 content / 兜底形状 / 垃圾输入', () => {
  assert.equal(extractTitleFromResponse('openai', { choices: [{ message: { content: '标题' } }] }), '标题')
  assert.equal(extractTitleFromResponse('openai', { choices: [{ text: '补全式' }] }), '补全式')
  assert.equal(extractTitleFromResponse('openai', { choices: [{ message: { content: [{ type: 'text', text: '分片' }] } }] }), '分片')
  assert.equal(extractTitleFromResponse('anthropic', { content: [{ type: 'text', text: '安' }, { type: 'text', text: '题' }] }), '安题')
  // anthropic 解析遇到 OpenAI 形状要能兜住（部分中转会混）
  assert.equal(extractTitleFromResponse('anthropic', { choices: [{ message: { content: '混装' } }] }), '混装')
  assert.equal(extractTitleFromResponse('openai', { output_text: '网关直给' }), '网关直给')
  for (const bad of [null, undefined, {}, { choices: [] }, { content: [] }, 'x', 42]) {
    assert.equal(extractTitleFromResponse('openai', bad), '', `脏输入应返回空串：${JSON.stringify(bad)}`)
    assert.equal(extractTitleFromResponse('anthropic', bad), '')
  }
})

test('请求组装：协议差异只在 header 与 body 形状；非标准字段只给本地画像', () => {
  const oa = buildTitleRequest('openai', { authToken: 'sk-x', model: 'm', prompt: 'p', localProfile: false })
  assert.equal(oa.headers.Authorization, 'Bearer sk-x')
  assert.equal(oa.body.model, 'm')
  assert.equal(oa.body.messages[0].content, 'p')
  assert.ok(!('chat_template_kwargs' in oa.body), '云端不得下发非标准字段（网关可能 400）')

  const anthropic = buildTitleRequest('anthropic', { authToken: 'sk-x', model: 'm', prompt: 'p', localProfile: false })
  assert.equal(anthropic.headers['x-api-key'], 'sk-x')
  assert.equal(anthropic.headers.Authorization, undefined, 'anthropic 风格不得带 Bearer（会撞鉴权）')
  assert.ok(anthropic.headers['anthropic-version'])
  assert.ok(!('temperature' in anthropic.body))

  const local = buildTitleRequest('openai', { authToken: '', model: 'm', prompt: 'p', localProfile: true })
  assert.deepEqual(local.body.chat_template_kwargs, { enable_thinking: false })
  assert.equal(local.headers.Authorization, undefined, '无 token 时不得发空 Bearer')
})

/** 起一个只认特定路径的假 provider，记录收到的请求 */
function fakeProvider(handler) {
  return new Promise((resolve) => {
    const received = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        received.push({ url: req.url, method: req.method, headers: req.headers, body })
        handler(req, res)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ baseUrl: `http://127.0.0.1:${port}`, received, close: () => new Promise(r => server.close(r)) })
    })
  })
}

test('真实 HTTP：openai 端点 404 ⇒ 自动退到 anthropic 端点并拿到文本', async () => {
  const srv = await fakeProvider((req, res) => {
    if (req.url === '/v1/chat/completions') { res.writeHead(404); res.end('{"error":"no such route"}'); return }
    if (req.url === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ content: [{ type: 'text', text: '退回来的标题' }] }))
      return
    }
    res.writeHead(500); res.end('{}')
  })
  try {
    const logs = []
    const r = await requestTitleText({
      baseUrl: `${srv.baseUrl}/v1`, // 用户常见的"带 /v1"写法
      authToken: 'tok', model: 'm', prompt: 'p', log: (m) => logs.push(m),
    })
    assert.equal(r.ok, true)
    assert.equal(r.text, '退回来的标题')
    assert.equal(r.endpoint, `${srv.baseUrl}/v1/messages`)
    // 带 /v1 的基址 ⇒ 第一个候选是 <root>/v1/chat/completions，**不得**出现 /v1/v1
    assert.deepEqual(srv.received.map(x => x.url)[0], '/v1/chat/completions')
    assert.ok(!srv.received.some(x => x.url.includes('/v1/v1')), '实测请求里不得出现双 /v1')
    // 404 也要有留痕（"效果不好"时唯一能排障的信息）
    assert.ok(logs.some(l => l.includes('404')), '失败候选要留痕，否则又是彻底静默')
    assert.ok(!logs.some(l => l.includes('退回来的标题')), '日志不得记录模型输出（会话内容属隐私）')
  } finally { await srv.close() }
})

test('真实 HTTP：鉴权头与 body 按协议下发（openai 用 Bearer、anthropic 用 x-api-key）', async () => {
  const srv = await fakeProvider((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  try {
    const r = await requestTitleText({ baseUrl: srv.baseUrl, authToken: 'secret-tok', model: 'm1', prompt: '请总结' })
    assert.equal(r.ok, true)
    assert.equal(srv.received[0].headers.authorization, 'Bearer secret-tok')
    const sent = JSON.parse(srv.received[0].body)
    assert.equal(sent.model, 'm1')
    assert.equal(sent.messages[0].content, '请总结')
  } finally { await srv.close() }
})

test('真实 HTTP：所有候选都失败 ⇒ ok=false 且带 tried（含状态/错误），不是静默 null', async () => {
  const srv = await fakeProvider((req, res) => { res.writeHead(503); res.end('{}') })
  try {
    const r = await requestTitleText({ baseUrl: srv.baseUrl, authToken: 't', model: 'm', prompt: 'p' })
    assert.equal(r.ok, false)
    assert.ok(r.tried.length >= 1)
    assert.ok(r.tried.every(t => t.status === 503), '每一次尝试都要如实记录状态')
  } finally { await srv.close() }
})

test('缺基址/缺模型：直接失败（不打网络），避免无谓请求', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('不该被调用') }
  assert.equal((await requestTitleText({ baseUrl: '', model: 'm', prompt: 'p', fetchImpl })).ok, false)
  assert.equal((await requestTitleText({ baseUrl: 'http://x.example', model: '', prompt: 'p', fetchImpl })).ok, false)
  assert.equal(calls, 0)
})

test('真实 HTTP：模型返回空文本 ⇒ 视为该候选失败并继续（不能把空标题当成成功）', async () => {
  const srv = await fakeProvider((req, res) => {
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ content: [{ type: 'text', text: '第二条候选给的' }] }))
  })
  try {
    const r = await requestTitleText({ baseUrl: srv.baseUrl, authToken: 't', model: 'm', prompt: 'p' })
    assert.equal(r.ok, true)
    assert.equal(r.text, '第二条候选给的', '空响应不得当成成功')
    assert.equal(r.tried[0].empty, true, '空响应要标记，便于排障')
  } finally { await srv.close() }
})
