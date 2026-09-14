// M3：http 执行后端。安全约束必须逐条被测钉死——本批次里只有它会主动向外部发请求。
// 全部用假 fetch（不碰网络）：真网络测试既不稳定，也没法断言"敏感头有没有被送出去"。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  httpRunner, isBlockedHost, allowedHostsFor, assertAllowedUrl, filterRequestHeaders, filterResponseHeaders,
  readCappedBody, HTTP_MAX_BYTES,
} = require('../electron/app-runner-http.cjs')

const enc = (s) => new TextEncoder().encode(s).buffer
const jsonRes = (body, { status = 200, headers = {} } = {}) => ({
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  arrayBuffer: async () => enc(body),
})
const SPEC = (extra = {}) => ({
  specVersion: 1, appId: 'h', name: '接口', driver: 'http',
  target: { type: 'web', url: 'https://api.example.com/' },
  expose: { mode: 'console' }, ...extra,
})
const SPEC_WITH_CMD = (step, extra = {}, params = []) => ({
  ...SPEC(extra),
  commands: [{ action: 'listItems', title: '查询条目', kind: 'read', params, steps: [step] }],
})

test('isBlockedHost：本机 / 私网 / 保留段一律拒（SSRF 防护）', () => {
  for (const h of ['localhost', 'sub.localhost', '127.0.0.1', '0.0.0.0', '10.0.0.5', '172.16.9.1', '172.31.255.255',
    '192.168.1.1', '169.254.1.1', '224.0.0.1', '::1', 'foo.local', 'svc.internal']) {
    assert.equal(isBlockedHost(h), true, h)
  }
  for (const h of ['api.example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1']) assert.equal(isBlockedHost(h), false, h)
})

test('assertAllowedUrl：默认只认同源（含 www/apex 变体）；协议只允许 http(s)；URL 不得带账号密码', () => {
  assert.equal(assertAllowedUrl('https://api.example.com/x', SPEC()).hostname, 'api.example.com')
  assert.equal(assertAllowedUrl('https://www.api.example.com/x', SPEC()).hostname, 'www.api.example.com')
  assert.throws(() => assertAllowedUrl('https://other.com/x', SPEC()), /不在允许范围/)
  assert.throws(() => assertAllowedUrl('file:///C:/x', SPEC()), /只允许 http\/https/)
  assert.throws(() => assertAllowedUrl('http://127.0.0.1:8080/x', SPEC()), /本机\/内网/)
  assert.throws(() => assertAllowedUrl('https://u:p@api.example.com/x', SPEC()), /账号密码/)
})

test('allowedHostsFor：同源站点 + spec.http.allowHosts 显式加白（人工唯一口子）', () => {
  const hosts = [...allowedHostsFor(SPEC({ http: { allowHosts: ['open.api.io'] } }))]
  assert.ok(hosts.includes('api.example.com') && hosts.includes('www.api.example.com'))
  assert.ok(hosts.includes('open.api.io'))
})

test('assertAllowedUrl：白名单也不能放行本机/内网地址', () => {
  const evil = SPEC({ http: { allowHosts: ['127.0.0.1', '192.168.0.10'] } })
  assert.throws(() => assertAllowedUrl('http://127.0.0.1/v1', evil), /本机\/内网/)
  assert.throws(() => assertAllowedUrl('http://192.168.0.10/v1', evil), /本机\/内网/)
})

test('filterRequestHeaders / filterResponseHeaders：敏感头既不发送也不回传', () => {
  assert.deepEqual(
    filterRequestHeaders({ Cookie: 'a=1', Authorization: 'Bearer x', 'X-Api-Key': 'k', Accept: 'application/json' }),
    { accept: 'application/json', 'x-api-key': 'k' },
    'cookie/authorization 丢弃；其它自定义头保留',
  )
  const headers = { get: (k) => ({ 'content-type': 'application/json', 'set-cookie': 'sid=1', 'x-token': 'secret' })[k] ?? null }
  assert.deepEqual(filterResponseHeaders(headers), { 'content-type': 'application/json' })
})

test('readCappedBody：超过上限要截断并如实标注（不许把超大响应灌进上下文）', async () => {
  const big = 'x'.repeat(HTTP_MAX_BYTES + 5000)
  const r = await readCappedBody({ arrayBuffer: async () => enc(big) })
  assert.equal(r.truncated, true)
  assert.equal(Buffer.byteLength(r.text), HTTP_MAX_BYTES)
  const small = await readCappedBody({ arrayBuffer: async () => enc('ok') })
  assert.deepEqual({ text: small.text, truncated: small.truncated }, { text: 'ok', truncated: false })
})

test('★ httpRunner：同源请求成功 → 状态码 + 安全头 + JSON 正文；query 参与插值；不回传敏感头', async () => {
  let seen = null
  const r = await httpRunner({
    appId: 'h', action: 'listItems', args: { page: 2 },
    spec: SPEC_WITH_CMD(
      { act: 'request', url: 'https://api.example.com/items', query: { page: '${page}' }, save: 'items' },
      {}, [{ name: 'page', required: true }],
    ),
    deps: {
      fetchImpl: async (url, init) => {
        seen = { url, init }
        return jsonRes('{"ok":true}', { headers: { 'content-type': 'application/json', 'set-cookie': 'sid=1' } })
      },
    },
  })
  assert.equal(r.ok, true, r.error || '')
  assert.equal(r.data.status, 200)
  assert.deepEqual(r.data.body, { ok: true })
  assert.equal(r.data.headers['set-cookie'], undefined, '敏感/未白名单响应头不得回传')
  assert.ok(seen.url.includes('page=2'), `query 要插值进 URL：${seen.url}`)
  assert.equal(seen.init.redirect, 'manual', '重定向必须自己逐跳校验，不能交给 fetch 自动跟随')
  assert.equal(r.kind, 'read')
})

test('httpRunner：非 JSON 正文按文本回传；非 GET 会带上 body', async () => {
  const inits = []
  const r = await httpRunner({
    appId: 'h', action: 'listItems', args: {},
    spec: SPEC_WITH_CMD({ act: 'request', method: 'POST', url: 'https://api.example.com/items', body: { a: 1 }, save: 'r' }),
    deps: { fetchImpl: async (_url, init) => { inits.push(init); return jsonRes('hello', { headers: { 'content-type': 'text/plain' } }) } },
  })
  assert.equal(r.ok, true, r.error || '')
  assert.equal(r.data.body, 'hello', '非 JSON 正文按文本回传')
  assert.equal(inits[0].method, 'POST')
  assert.deepEqual(JSON.parse(inits[0].body), { a: 1 })
})

test('httpRunner：HTTP >= 400 视为失败（把状态码与正文一起交回去，便于模型改）', async () => {
  const r = await httpRunner({
    appId: 'h', action: 'listItems', args: {},
    spec: SPEC_WITH_CMD({ act: 'request', url: 'https://api.example.com/items' }),
    deps: { fetchImpl: async () => jsonRes('{"error":"bad id"}', { status: 404, headers: { 'content-type': 'application/json' } }) },
  })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('404'), r.error)
  assert.ok(r.error.includes('bad id'), r.error)
})

test('httpRunner：缺少必填参数 → 不执行任何请求；非 request 步骤 → 明确拒绝', async () => {
  let called = 0
  const deps = { fetchImpl: async () => { called++; return jsonRes('{}') } }
  const missing = await httpRunner({
    appId: 'h', action: 'listItems', args: {},
    spec: SPEC_WITH_CMD({ act: 'request', url: 'https://api.example.com/items' }, {}, [{ name: 'page', required: true }]),
    deps,
  })
  assert.equal(missing.ok, false)
  assert.equal(called, 0, '缺参数不得发请求')
  const wrongStep = await httpRunner({
    appId: 'h', action: 'listItems', args: {},
    spec: SPEC_WITH_CMD({ act: 'cli', argv: ['--version'] }),
    deps,
  })
  assert.equal(wrongStep.ok, false)
  assert.ok(wrongStep.error.includes('只允许 request'), wrongStep.error)
  assert.equal(called, 0)
})

test('httpRunner：逐跳重定向都要过守卫——跳到内网/未授权主机一律拒（不得跟随）', async () => {
  const r = await httpRunner({
    appId: 'h', action: 'listItems', args: {},
    spec: SPEC_WITH_CMD({ act: 'request', url: 'https://api.example.com/items' }),
    deps: { fetchImpl: async () => jsonRes('', { status: 302, headers: { location: 'http://127.0.0.1:7000/admin' } }) },
  })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('本机/内网'), r.error)
})

test('httpRunner：同源重定向可跟随（最多 3 跳），且每一跳都重新插值/校验', async () => {
  const seenUrls = []
  const r = await httpRunner({
    appId: 'h', action: 'listItems', args: {},
    spec: SPEC_WITH_CMD({ act: 'request', url: 'https://api.example.com/items' }),
    deps: {
      fetchImpl: async (url) => {
        seenUrls.push(url)
        if (seenUrls.length === 1) return jsonRes('', { status: 302, headers: { location: 'https://www.api.example.com/items' } })
        return jsonRes('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      },
    },
  })
  assert.equal(r.ok, true, r.error || '')
  assert.deepEqual(seenUrls, ['https://api.example.com/items', 'https://www.api.example.com/items'])
  assert.equal(r.data.status, 200)
})

test('httpRunner：超时如实报错（不挂死、不假装成功）', async () => {
  const r = await httpRunner({
    appId: 'h', action: 'listItems', args: {},
    spec: SPEC_WITH_CMD({ act: 'request', url: 'https://api.example.com/slow', timeout: 20 }),
    deps: {
      fetchImpl: (url, init) => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    },
  })
  assert.equal(r.ok, false)
  assert.ok(/超时/.test(r.error), r.error)
})

test('httpRunner：未知 action / 未知步骤 act / 无 fetch 环境 → 结构化失败，不抛', async () => {
  assert.equal((await httpRunner({ appId: 'h', action: 'nope', args: {}, spec: SPEC() })).ok, false)
  assert.equal((await httpRunner({ appId: 'h', action: 'listItems', args: {}, spec: SPEC_WITH_CMD({ act: 'request', url: 'https://api.example.com/x' }), deps: { fetchImpl: null } })).ok, false)
})
