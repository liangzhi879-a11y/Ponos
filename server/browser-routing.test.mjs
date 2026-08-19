import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'

// 用最小可测封装：把路由逻辑抽成纯函数模块 server/browser-routing.mjs
// （bridge.mjs 内嵌逻辑厚，测试直接针对封装模块而非整桥）
import { makeBrowserRouter } from './browser-routing.mjs'

function fakeExecutor() { const ex = { last: null }; ex.send = (msg) => { ex.last = JSON.parse(msg) }; return ex }

test('路由：bridge_request(browser) → executor；executor 响应 → 回写内核 stdin', () => {
  const stdinWriter = { calls: [], write(msg) { this.calls.push(msg) } }
  const r = makeBrowserRouter({ writeKernel: (sid, msg) => stdinWriter.write({ sid, msg }) })
  const ex = fakeExecutor()
  r.registerExecutor(ex)

  r.onKernelBridgeRequest('conv-1', { requestId: 'br-1', route: 'browser', payload: { action: 'goto', params: { url: 'https://www.gsxt.gov.cn/x' } } })
  assert.equal(ex.last.type, 'browser:exec')
  assert.equal(ex.last.sessionId, 'conv-1')

  r.onExecutorResponse('br-1', { ok: true, snapshot: { page: { url: 'u' } }, error: null })
  assert.equal(stdinWriter.calls.length, 1)
  assert.equal(stdinWriter.calls[0].msg.request.subtype, 'browser_response')
  assert.equal(stdinWriter.calls[0].msg.request.requestId, 'br-1')
})

test('路由：executor code:paused（人工接管）透传到内核 stdin', () => {
  const stdinWriter = { calls: [], write(msg) { this.calls.push(msg) } }
  const r = makeBrowserRouter({ writeKernel: (sid, msg) => stdinWriter.write({ sid, msg }) })
  const ex = fakeExecutor()
  r.registerExecutor(ex)

  r.onKernelBridgeRequest('conv-1', { requestId: 'br-9', route: 'browser', payload: { action: 'click', params: { ref: 3 } } })
  r.onExecutorResponse('br-9', { ok: false, snapshot: null, error: 'human takeover', code: 'paused' })
  assert.equal(stdinWriter.calls.length, 1)
  assert.equal(stdinWriter.calls[0].msg.request.code, 'paused')
  assert.equal(stdinWriter.calls[0].msg.request.ok, false)
  assert.match(stdinWriter.calls[0].msg.request.error, /human takeover/)
})

test('路由：executor data（js 动作结构化结果）透传到内核 stdin', () => {
  const stdinWriter = { calls: [], write(msg) { this.calls.push(msg) } }
  const r = makeBrowserRouter({ writeKernel: (sid, msg) => stdinWriter.write({ sid, msg }) })
  const ex = fakeExecutor()
  r.registerExecutor(ex)

  r.onKernelBridgeRequest('conv-1', { requestId: 'br-js1', route: 'browser', payload: { action: 'js', params: { expression: '1+1' } } })
  r.onExecutorResponse('br-js1', { ok: true, snapshot: { page: {} }, error: null, data: { value: 2 } })
  assert.equal(stdinWriter.calls.length, 1)
  assert.deepEqual(stdinWriter.calls[0].msg.request.data, { value: 2 })
})

test('路由：executor 未注册时返回错误回写内核', () => {
  const stdinWriter = { calls: [] }
  const r = makeBrowserRouter({ writeKernel: (_s, msg) => stdinWriter.calls.push(msg) })
  r.onKernelBridgeRequest('conv-1', { requestId: 'br-2', route: 'browser', payload: { action: 'snapshot' } })
  assert.equal(stdinWriter.calls[0].request.ok, false)
  assert.match(stdinWriter.calls[0].request.error, /executor/)
})

test('browser_control：pause/resume 写内核 control_request（browser_pause/resume）；未知命令忽略', () => {
  const writes = []
  const r = makeBrowserRouter({ writeKernel: (sid, msg) => writes.push({ sid, msg }) })
  const ex = fakeExecutor()
  r.registerExecutor(ex)

  // pause → 内核 browser_pause，不转发 executor
  r.onGuiControl('conv-1', 'pause')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].sid, 'conv-1')
  assert.equal(writes[0].msg.type, 'control_request')
  assert.equal(writes[0].msg.request.subtype, 'browser_pause')
  assert.equal(ex.last, null)

  // resume → 内核 browser_resume
  r.onGuiControl('conv-1', 'resume')
  assert.equal(writes.length, 2)
  assert.equal(writes[1].msg.request.subtype, 'browser_resume')

  // 未知命令忽略（不写内核、不转发 executor）
  r.onGuiControl('conv-1', 'unknown-command')
  assert.equal(writes.length, 2)
  assert.equal(ex.last, null)
})

test('browser:event：broadcast 广播 {type,browser:event} 给所有注册 GUI 客户端', () => {
  const r = makeBrowserRouter({ writeKernel: () => {} })
  const makeClient = () => ({ received: [], send(msg) { this.received.push(JSON.parse(msg)) } })
  const c1 = makeClient()
  const c2 = makeClient()
  r.addGuiClient(c1)
  r.addGuiClient(c2)

  r.broadcast('conv-1', { status: 'clicking' })
  for (const c of [c1, c2]) {
    assert.equal(c.received.length, 1)
    assert.deepEqual(c.received[0], { type: 'browser:event', sessionId: 'conv-1', event: { status: 'clicking' } })
  }
})
