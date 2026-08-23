// T005 验收：cache_control 断点——默认关（无 cache_control）/ 开启（system+首条 user 块带断点）
// 用法：node verify.mjs <workspace>
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ws = process.argv[2]
const mod = await import(pathToFileURL(join(ws, 'kernel', 'api.mjs')).href)
const { streamMessages } = mod

// mock SSE（Anthropic 完整事件序列）
const sseEvents = [
  { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: 'content_block_start', content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop' },
  { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 2 } },
]
const sse = sseEvents.map((e) => 'data: ' + JSON.stringify(e)).join('\n\n') + '\n\ndata: [DONE]\n\n'

/** 调 streamMessages，抓取 fetch 收到的 body；返回 { body } */
async function captureBody(envPatch) {
  const prevFetch = global.fetch
  const prevEnv = { ...process.env }
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
    PONOS_MOCK_API: '0',
    OPENAI_BASE_URL: '', OPENAI_API_KEY: '', // 强制走 Anthropic
    ...envPatch,
  })
  let body = null
  global.fetch = async (url, init) => {
    body = JSON.parse(init.body)
    return {
      ok: true,
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
    }
  }
  try {
    for await (const _ of streamMessages({
      model: 'm', maxTokens: 100,
      messages: [
        { role: 'system', content: '你是测试助手。' },
        { role: 'user', content: '你好' },
      ],
    })) { /* 收集完即止 */ }
  } finally {
    global.fetch = prevFetch
    process.env = prevEnv
  }
  return body
}

// ── A. 默认关闭：body 不含 cache_control，system 为字符串 ───────────────────
const bodyA = await captureBody({})
const bodyAStr = JSON.stringify(bodyA)
if (typeof bodyA.system !== 'string' || bodyAStr.includes('cache_control')) {
  console.error('VERIFY_FAIL: 默认关闭时不应有 cache_control（system 应为字符串）')
  console.error('body:', bodyAStr.slice(0, 500))
  process.exit(1)
}

// ── B. 开启：system 为带断点块，首条 user 块带断点 ──────────────────────────
const bodyB = await captureBody({ CLAUDE_CODE_CACHE_CONTROL: '1' })
const sysB = Array.isArray(bodyB.system) ? bodyB.system[0] : bodyB.system
const firstUser = bodyB.messages.find((m) => m.role === 'user')
const firstUserBlocks = Array.isArray(firstUser?.content) ? firstUser.content : [firstUser]
const bOk =
  Array.isArray(bodyB.system) &&
  sysB.cache_control?.type === 'ephemeral' &&
  firstUserBlocks.some((b) => b.cache_control?.type === 'ephemeral')
if (!bOk) {
  console.error('VERIFY_FAIL: 开启时 system / 首条 user 块应含 cache_control')
  console.error('system:', JSON.stringify(bodyB.system))
  console.error('firstUser:', JSON.stringify(firstUser).slice(0, 300))
  process.exit(1)
}

// ── C. 开启 + 无 system / 首条非文本：不抛错 ────────────────────────────────
const prevFetch = global.fetch
global.fetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }) })
const prevEnv = { ...process.env }
Object.assign(process.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 't', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', CLAUDE_CODE_CACHE_CONTROL: '1' })
try {
  for await (const _ of streamMessages({ model: 'm', maxTokens: 100, messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] })) { }
} catch (e) {
  console.error('VERIFY_FAIL: 开启 + 首条非文本应不抛错 ——', e.message)
  process.exit(1)
} finally {
  global.fetch = prevFetch
  process.env = prevEnv
}

console.log('VERIFY_PASS')
process.exit(0)
