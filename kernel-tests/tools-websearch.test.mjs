// WebSearch 的协议感知降级（2026-09-23，OpenAI 协议兼容 Task 8）
// ---------------------------------------------------------------------------
// 事实：`kernel/tools.mjs#webSearch` 依赖 Anthropic **服务端**工具 `web_search_20250305`
// （检索由 Anthropic 侧执行），OpenAI Chat Completions **没有对等物**（其 web_search 属
// Responses API，不在本期范围）。
//
// ⇒ 正解是"协议感知降级"而不是"假装支持"：OpenAI 协议下必须在**任何 fetch 之前**返回
// 明确说明。否则会发一个必然失败的请求，把"能力不支持"伪装成"请求出错"——那是最难排查的
// 一类失败（用户看到 HTTP 4xx，会去查网络/端点/密钥，而真因是协议不对口）。
//
// 本文件钉死三件事：
//   ① 纯判定：anthropic 可用 / openai 明确降级并给原因 / auto 不阻断（实际协议请求时才定）
//   ② 降级分支在 **fetch 之前**（用 fetch 桩计数为 0 证明，不是靠读代码断言）
//   ③ 不过度降级：anthropic 协议下仍照常发请求并解析来源（零回归）
import test from 'node:test'
import assert from 'node:assert/strict'
import { webSearchAvailability, createToolRegistry } from '../kernel/tools.mjs'

test('联网搜索：Anthropic 协议可用（服务端工具 web_search_20250305）', () => {
  assert.deepEqual(webSearchAvailability('anthropic'), { supported: true })
})

test('联网搜索：OpenAI 协议明确降级并给出原因（不假装支持）', () => {
  const r = webSearchAvailability('openai')
  assert.equal(r.supported, false)
  assert.ok(r.reasonKey)
  assert.ok(r.message.length > 0)
})

test('联网搜索：auto 不阻断（实际协议由内核在请求时决定）', () => {
  assert.equal(webSearchAvailability('auto').supported, true)
})

/** 临时设置 provider env，返回还原函数 */
function withProviderEnv(vars) {
  const keys = ['PONOS_BASE_URL', 'PONOS_AUTH_TOKEN', 'PONOS_API_FORMAT', 'PONOS_MOCK_API']
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  Object.assign(process.env, vars)
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const ANTHROPIC_PAYLOAD = {
  content: [
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', title: '来源一', url: 'https://example.com/a', page_age: '2026-09-01' },
    ] },
    { type: 'text', text: '正文', citations: [{ url: 'https://example.com/a', cited_text: '摘要一' }] },
  ],
}

test('降级在 fetch 之前：OpenAI 协议下不发任何 HTTP 就返回可操作提示', async () => {
  const restore = withProviderEnv({
    PONOS_BASE_URL: 'https://api.minimaxi.com/anthropic',
    PONOS_AUTH_TOKEN: 'tok-not-printed',
    PONOS_API_FORMAT: 'openai',
  })
  const prevFetch = global.fetch
  let calls = 0
  global.fetch = async () => { calls++; throw new Error('不该发起请求') }
  try {
    const reg = createToolRegistry({ cwd: process.cwd() })
    const r = await reg.run({ name: 'WebSearch', input: { query: '最新政策' } }, {})
    assert.equal(calls, 0, '降级必须早于任何 fetch——发必然失败的请求会把"能力不支持"伪装成"请求出错"')
    assert.equal(r.isError, true, '降级要如实标记为错误结果，模型才会改道（WebFetch/换途径）')
    assert.ok(r.content.includes('OpenAI'), '要说清是哪一套协议不可用：' + r.content)
    assert.ok(r.content.length > 0)
  } finally {
    global.fetch = prevFetch
    restore()
  }
})

test('不过度降级：Anthropic 协议下仍照常请求并解析来源（零回归）', async () => {
  const restore = withProviderEnv({
    PONOS_BASE_URL: 'https://api.deepseek.com/anthropic',
    PONOS_AUTH_TOKEN: 'tok-not-printed',
    PONOS_API_FORMAT: 'anthropic',
  })
  const prevFetch = global.fetch
  const seen = []
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return { ok: true, json: async () => ANTHROPIC_PAYLOAD }
  }
  try {
    const reg = createToolRegistry({ cwd: process.cwd() })
    const r = await reg.run({ name: 'WebSearch', input: { query: '最新政策' } }, {})
    assert.equal(seen.length, 1, 'anthropic 协议下必须真的发请求')
    assert.ok(seen[0].url.endsWith('/v1/messages'))
    assert.equal(seen[0].body.tools[0].type, 'web_search_20250305', 'Anthropic 侧仍用服务端工具形状')
    assert.equal(r.isError, false)
    assert.ok(r.content.includes('https://example.com/a'), '来源要如实带回来：' + r.content)
  } finally {
    global.fetch = prevFetch
    restore()
  }
})
