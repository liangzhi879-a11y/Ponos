// api.mjs 超时收口（T10④，2026-09-12）
// ---------------------------------------------------------------------------
// 旧实现三条"race-reject 不 cancel"，共同后果是**底层请求不死**：
//   ① 连接超时只 reject，不 abort 底层 fetch（fetchWithConnectTimeout）；
//   ② 流读空闲超时只 race-reject，挂起的 reader.read() 永不完成（withIdleTimeout）；
//   ③ finally 只 releaseLock()，全文件没有 reader.cancel()。
// 于是服务器侧照常生成（孤儿占用槽位）、连接不释放，重试再叠一层——正是 api.mjs 注释
// 里记的"越重试越挂"死亡螺旋的请求侧成因，也是 2006s/2911s 纯静默窗口里"请求还挂着、
// 人却什么都看不到"的由来。
// 本文件用真实 HTTP server 观测**对端是否真的收口**（不靠内部状态断言）：超时之后
// 服务端必须观测到连接被断开，否则修复等于没做。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { streamMessages } from '../kernel/api.mjs'

const MSG = [{ role: 'user', content: 'hi' }]

const drain = async () => { for await (const _ of streamMessages({ model: 'test-model', messages: MSG, maxTokens: 16 })) {} }

// 本地服务 + "服务端观测到连接关闭"标记；收尾强制销毁残留 socket——未收口的连接会把
// 测试进程一起挂住，这本身就是被测缺陷的症状，不能让它污染断言之外的收尾。
async function withServer(handler, fn) {
  const sockets = new Set()
  const server = createServer(handler)
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const prev = { url: process.env.ANTHROPIC_BASE_URL, tok: process.env.ANTHROPIC_AUTH_TOKEN }
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
  try {
    await fn()
  } finally {
    if (prev.url === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev.url
    if (prev.tok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prev.tok
    for (const s of sockets) { try { s.destroy() } catch {} }
    await new Promise((r) => server.close(r))
  }
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

test('连接超时（响应头未到）→ 底层 fetch 被真正 abort，服务端观测到断开', async () => {
  let serverSawClose = false
  process.env.PONOS_CONNECT_TIMEOUT_MS = '600'
  process.env.PONOS_STREAM_RECONNECTS = '0'
  try {
    // 服务端收到请求后**永不响应**（排队/静默丢弃形态）
    await withServer((req) => {
      req.on('close', () => { serverSawClose = true })
    }, async () => {
      await assert.rejects(drain, (e) => e?.name === 'TimeoutError', '连接超时应归一为 TimeoutError（transient，可重发）')
      assert.equal(await waitFor(() => serverSawClose, 3000), true,
        '连接超时后必须 abort 底层 fetch——旧实现只 reject，请求留在连接池/服务端继续跑（孤儿占位，重试叠加成越重试越挂）')
    })
  } finally {
    delete process.env.PONOS_CONNECT_TIMEOUT_MS
    delete process.env.PONOS_STREAM_RECONNECTS
  }
})

test('流读空闲超时 → 底层 reader 被 cancel，服务端观测到断开', async () => {
  let serverSawClose = false
  process.env.PONOS_STREAM_IDLE_TIMEOUT_MS = '700'
  process.env.PONOS_STREAM_RECONNECTS = '0'
  try {
    // 已送出 HTTP 200 + 一个事件（不算空流），随后永久静默：正是"上游还在思考"的形态
    await withServer((req, res) => {
      req.on('close', () => { serverSawClose = true })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"test-model","usage":{"input_tokens":1,"output_tokens":0}}}\n\n')
    }, async () => {
      await assert.rejects(drain, (e) => e?.name === 'StreamInterrupted', '空闲超时应归一为 StreamInterrupted（transient，可重发）')
      assert.equal(await waitFor(() => serverSawClose, 3000), true,
        '空闲超时后必须 reader.cancel()——旧实现只 releaseLock()，挂起的 read() 与响应体一起泄漏，服务端连接永不收口')
    })
  } finally {
    delete process.env.PONOS_STREAM_IDLE_TIMEOUT_MS
    delete process.env.PONOS_STREAM_RECONNECTS
  }
})
