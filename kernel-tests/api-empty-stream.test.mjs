// api.mjs 空流归一（P1-11）——真实 HTTP 层测试（不经 mock）
// ---------------------------------------------------------------------------
// 场景：上游对 /v1/messages 返回 HTTP 200 但响应体一个 SSE 事件都不下发（vLLM 引擎
// 加载中/崩溃的典型形态）：① 响应体立即干净结束（0 事件 EOF）；② 200 后连接被对端
// 销毁（undici "terminated"）。两者都应归一为 DeadStreamError（engine 据此快速失败
// 提示检查 provider），而正常流（有 message_start + 文本增量）不受影响。
// 本文件不设 PONOS_MOCK_API：直连本地 http server 走真实 anthropicStream 路径。
// 2026-09-10：上游空流无感愈合（UPSTREAM_DEAD_HEAL_MAX 默认 2×30s 退避）由
// engine-guard-heal.test.mjs 覆盖；本文件验证"快速失败"机制本身，显式关闭愈合层。
// 需在 engine.mjs 求值前设 env（engine 常量模块期冻结）→ 用动态 import。
process.env.PONOS_UPSTREAM_DEAD_HEAL_MAX = '0'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { classifyApiError, deadStreamError, streamMessages } from '../kernel/api.mjs'
const { createEngine } = await import('../kernel/engine.mjs')
import { createSessionStore } from '../kernel/session.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MSG = [{ role: 'user', content: 'hi' }]

async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = server.address().port
    process.env.PONOS_BASE_URL = `http://127.0.0.1:${port}`
    process.env.PONOS_AUTH_TOKEN = 'test-token'
    process.env.PONOS_MODEL = 'test-model'
    await fn()
  } finally {
    delete process.env.PONOS_BASE_URL
    delete process.env.PONOS_AUTH_TOKEN
    delete process.env.PONOS_MODEL
    await new Promise((r) => server.close(r))
  }
}

const drain = async () => { for await (const _ of streamMessages({ model: 'test-model', messages: MSG, maxTokens: 16 })) {} }

test('HTTP 200 + 0 事件干净 EOF → DeadStreamError', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end()
  }, async () => {
    await assert.rejects(drain, (e) => e?.name === 'DeadStreamError' && classifyApiError(e).kind === 'dead-stream')
  })
})

test('HTTP 200 已送达 + 连接被对端销毁（0 事件 terminated）→ DeadStreamError（上游空流）', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders() // 确保客户端先收到 200，再被对端销毁 → "已受理但 0 事件即断"
    res.socket.destroy()
  }, async () => {
    await assert.rejects(drain, (e) => e?.name === 'DeadStreamError' && classifyApiError(e).kind === 'dead-stream')
  })
})

test('连接在响应前即被销毁（fetch 层 reject）→ 保持瞬态网络错误，不误判空流', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.socket.destroy() // 无 flushHeaders：200 未送达即断 → undici 在 fetch 层 reject
  }, async () => {
    // 尚未建立响应 = 网络层失败（等价 ECONNREFUSED 一类），按瞬态处理：不标 zeroEvents、
    // 不归一空流，留给既有重发语义自动恢复——避免把单次握手失败误报成"上游空流"。
    await assert.rejects(drain, (e) => {
      assert.equal(e?.zeroEvents, undefined, '未收到过 HTTP 响应的事件，不应标 zeroEvents')
      assert.equal(e?.name, 'TypeError', 'fetch 层 reject 保持原始形态（transient）')
      return classifyApiError(e).kind === 'transient'
    })
  })
})

test('HTTP 200 + 正常流（message_start + 文本增量）→ 正常产出，不误判空流', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 2, output_tokens: 0 } } })
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好，世界。\n\n' } })
    sse({ type: 'content_block_stop', index: 0 })
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
    sse({ type: 'message_stop' })
    res.end()
  }, async () => {
    const chunks = []
    for await (const c of streamMessages({ model: 'test-model', messages: MSG, maxTokens: 16 })) chunks.push(c)
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('你好')), '应产出文本增量')
    assert.ok(chunks.some((c) => c.type === 'stop_reason'), '应产出 stop_reason')
  })
})

test('classifyApiError：DeadStreamError 与普通 transient 区分', () => {
  assert.equal(classifyApiError(deadStreamError(new Error('x'))).kind, 'dead-stream')
  const netErr = Object.assign(new Error('fetch failed'), { name: 'TypeError' })
  assert.equal(classifyApiError(netErr).kind, 'transient', 'fetch failed 仍按瞬态网络错误处理（重发语义不变）')
})

test('engine 层：每次 200 已送达即被销毁（0 事件）→ dead-stream 限次重试后快速收尾（愈合层已显式关闭）', async () => {
  // 持久 200+即断 = 典型死上游形态（vLLM 引擎加载/崩溃窗口）：每次都受理但 0 事件。
  // engine retryStream 对 dead-stream 只放行 1 次重试（deadCap），连续 2 次即抛
  // DeadStreamError → 主循环 dead-stream 分支快速落"上游空流 + 检查 provider"提示。
  // （默认的无感愈合层 2×30s 退避已由本文件头部 PONOS_UPSTREAM_DEAD_HEAL_MAX=0 关闭）
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    res.socket.destroy()
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-empty-stream-'))
    try {
      const wire = {
        assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
        summary: () => {}, health: () => {}, warning: () => {},
      }
      const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-0000000000aa' })
      const engine = createEngine({ opts: { model: 'test-model', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
      const t0 = Date.now()
      const result = await engine.runTurn({ content: 'hi' })
      const elapsed = Date.now() - t0
      assert.ok(result.text.includes('上游服务空流'), `应收空流提示，实际: ${result.text.slice(0, 200)}`)
      assert.ok(result.text.includes('provider'), '应引导检查 provider')
      assert.ok(elapsed < 6000, `应快速失败（连续 2 次即收尾，无 120s 空等），实际耗时 ${elapsed}ms`)
      // 会话保留可续聊（优雅收尾不丢任务）
      const again = await engine.runTurn({ content: '继续' })
      assert.ok(typeof again.text === 'string' && again.text.length > 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
