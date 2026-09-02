import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './main.cjs'

// 注入 fake spawn：buildApp 内 bridge.start() 不真实拉起 node kernel 子进程
function fakeChild() {
  const c = {
    stdin: { write: () => {}, end: () => {} },
    stdout: {},
    kill: () => { c.killed = true },
    killed: false,
    on: () => {},
    pid: 42,
  }
  return c
}

test('buildApp 注册主进程方法集并可用', async () => {
  const handlers = new Map()
  const WC = {} // webContents 哨兵对象：orchestrator 反查模块 id 的比对对象
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  const ctx = buildApp({
    ipcMain,
    createWindow: () => ({ isDestroyed: () => false, on() {}, destroy() {}, close() {}, webContents: WC }),
    kernelArgs: { spawnImpl: () => fakeChild(), readlineImpl: () => ({ on() {} }) },
  })
  // 打开 launcher 窗口触发装配的 onWindowCreated 钩子 → attach launcher（capabilities:
  // ['system.modules','system.window'] 不覆盖 agent.*，权限拒绝路径经 transport + 权限门验证）
  ctx.orchestrator.open('launcher')

  // 窗口壳 RPC 可达（context 按 key 反查模块信息）
  const ctxR = await ctx.router.invoke({ method: 'system.window.context', x_sender: 'launcher', params: { key: 'launcher' } })
  assert.equal(ctxR.ok, true)
  assert.equal(ctxR.result.name, '启动台')

  // 正向断言走 router：system.modules.list 的 handler capabilities 前缀匹配方法名即放行
  const list = await ctx.router.invoke({ method: 'system.modules.list', x_sender: 'launcher' })
  assert.equal(list.ok, true)
  assert.ok(Array.isArray(list.result))
  assert.ok(list.result.some(m => m.id === 'chat'))

  // 权限拒绝经 transport 验证：instanceOf(webContents) → gate.check('launcher', 'agent.send') → deny
  // （chat 的 capabilities 含 agent，属放行路径；launcher 无 agent.* → PERMISSION_DENIED）
  const callFn = handlers.get('ponos:call')
  const deny = await callFn({ sender: WC }, { method: 'agent.send', params: { text: 'hi' } })
  assert.equal(deny.error, 'PERMISSION_DENIED')
})

test('chat 模块 agent.send 经权限门放行（ALLOWED 冒烟，验收标准入库）', async () => {
  const handlers = new Map()
  const WC = {} // webContents 哨兵对象
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  const ctx = buildApp({
    ipcMain,
    createWindow: () => ({ isDestroyed: () => false, on() {}, destroy() {}, close() {}, webContents: WC }),
    kernelArgs: { spawnImpl: () => fakeChild(), readlineImpl: () => ({ on() {} }) },
  })
  // 打开 chat 窗口 → attach chat（capabilities ['system.window','agent'] 覆盖 agent.send → 放行路径）
  ctx.orchestrator.open('chat')

  const callFn = handlers.get('ponos:call')
  const res = await callFn({ sender: WC }, { method: 'agent.send', params: { text: '你好' } })
  assert.equal(res.ok, true)
  assert.equal(res.result.ok, true, 'bridge.send 应被调用并返回 ok')
})

test('settings 窗口 state.get 经 router → worker，changed 通知广播到 attach 模块', async () => {
  const handlers = new Map()
  const WC = {}
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  // fake worker：捕获 postMessage 请求；测试手动注入响应
  const listeners = {}
  const worker = {
    sent: [],
    postMessage(m) { this.sent.push(m) },
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
    terminate() { this.terminated = true },
  }
  const ctx = buildApp({
    ipcMain,
    createWindow: () => ({ isDestroyed: () => false, on() {}, destroy() {}, close() {}, webContents: WC }),
    createWorker: () => worker,
    kernelArgs: { spawnImpl: () => fakeChild(), readlineImpl: () => ({ on() {} }) },
  })
  ctx.orchestrator.open('settings')  // attach settings（caps ['state']）
  const callFn = handlers.get('ponos:call')

  // settings → state.get：router 代理 → client 请求 → fake worker 收到
  const p = callFn({ sender: WC }, { method: 'state.get', params: { key: 'settings' } })
  const req = worker.sent.find(m => m.id !== undefined && m.method === 'state.get')
  assert.ok(req, 'client 请求应到达 worker')
  worker.emit('message', { id: req.id, result: { ok: true, value: { theme: 'dark' }, version: 1 } })
  const res = await p
  assert.equal(res.ok, true)
  assert.equal(res.result.value.theme, 'dark')

  // worker 通知 → broadcast → attach 模块收到 rpc:event:state
  worker.emit('message', { method: 'state.changed', params: { key: 'settings', value: { theme: 'dark' }, version: 1, from: 'settings' } })
  // 等待广播异步送达（broadcast 同步执行，client 通知同步分发 → 立即断言）
  await new Promise(r => setTimeout(r, 0))
  // 通过再次 call 验证链路完好（通知不破坏状态）
  const p2 = callFn({ sender: WC }, { method: 'state.get', params: { key: 'settings' } })
  worker.emit('message', { id: p2 && worker.sent.at(-1).id, result: { ok: true, value: { theme: 'dark' }, version: 1 } })
  const res2 = await p2
  assert.equal(res2.ok, true)
})
