import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from './main.cjs'

// 窗口壳 fake：orchestrator 反查模块 id 的 webContents 哨兵对象
function fakeWindow(WC) {
  return { isDestroyed: () => false, on() {}, destroy() {}, close() {}, webContents: WC }
}

// fake cli 子进程（agent-core 的 cli-bridge child duck）：
// 捕获 stdin 写（RPC 请求行）；stdout.on('data') 供 stdio-transport 注册，测试手动注入响应。
function fakeCli() {
  const cli = {
    written: [],
    stdin: { write(s) { cli.written.push(JSON.parse(s)) } },
    stdout: { on() {} },
    kill() { this.killed = true },
    on() {},
  }
  const dataCbs = []
  cli.stdout.on = (ev, cb) => { if (ev === 'data') dataCbs.push(cb) }
  cli.emitData = chunk => dataCbs.forEach(cb => cb(chunk))
  return cli
}

test('buildApp 注册主进程方法集并可用', async () => {
  const handlers = new Map()
  const WC = {} // webContents 哨兵对象：orchestrator 反查模块 id 的比对对象
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  const ctx = buildApp({
    ipcMain,
    createWindow: () => fakeWindow(WC),
  })
  // 打开 launcher 窗口触发装配的 onWindowCreated 钩子 → attach launcher（capabilities:
  // ['system.modules','system.window'] 不覆盖 session.*，权限拒绝路径经 transport + 权限门验证）
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

  // 权限拒绝经 transport 验证：instanceOf(webContents) → gate.check('launcher', 'session.send') → deny
  // （chat 的 capabilities 含 session，属放行路径；launcher 无 session.* → PERMISSION_DENIED）
  const callFn = handlers.get('ponos:call')
  const deny = await callFn({ sender: WC }, { method: 'session.send', params: { text: 'hi' } })
  assert.equal(deny.error, 'PERMISSION_DENIED')
})

test('chat 模块 session.send 经权限门放行，请求直达 agent-core 子进程', async () => {
  const handlers = new Map()
  const WC = {} // webContents 哨兵对象
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  const cli = fakeCli()
  const ctx = buildApp({
    ipcMain,
    createWindow: () => fakeWindow(WC),
    createCli: () => cli,
  })
  ctx.orchestrator.open('chat')  // attach chat（caps ['system.window','session']）

  const callFn = handlers.get('ponos:call')
  const p = callFn({ sender: WC }, { method: 'session.send', params: { text: '你好' } })
  await new Promise(r => setTimeout(r, 0))  // 等待 RPC 请求经 transport 写入
  const req = cli.written.find(m => m.method === 'session.send')
  assert.ok(req, 'session.send 请求应写入 agent-core stdin')
  assert.equal(req.params.text, '你好')
  // 子进程响应回传（stdio data 行 → rpc client 配对 → invoke result）
  cli.emitData(JSON.stringify({ id: req.id, result: { ok: true, sessionId: 's-1' } }) + '\n')
  const res = await p
  assert.equal(res.ok, true)
  assert.equal(res.result.ok, true)
  assert.equal(res.result.sessionId, 's-1')
})

test('chat 模块 session.status ok 帧经宿主回传解析为结果（plan-fix：不落 error 分支丢结果）', async () => {
  const handlers = new Map()
  const WC = {} // webContents 哨兵对象
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  const cli = fakeCli()
  const ctx = buildApp({
    ipcMain,
    createWindow: () => fakeWindow(WC),
    createCli: () => cli,
  })
  ctx.orchestrator.open('chat')

  const callFn = handlers.get('ponos:call')
  const p = callFn({ sender: WC }, { method: 'session.status' })
  await new Promise(r => setTimeout(r, 0))
  const req = cli.written.find(m => m.method === 'session.status')
  assert.ok(req, 'session.status 请求应写入 agent-core stdin')
  // agent-core 子进程按 res.ok 分帧（main.cjs if (res.ok)）：core.cjs handleRequest('session.status')
  // 返回 { ok:true, ...status() } → ok 分支写 { id, result: res }；无 ok 标记会落入 error 分支 → 宿主侧 result 缺失
  cli.emitData(JSON.stringify({ id: req.id, result: { ok: true, busy: false, firstTokenAt: null, sessionId: '' } }) + '\n')
  const res = await p
  assert.equal(res.ok, true)
  assert.equal(res.result.ok, true)
  assert.equal(res.result.busy, false)
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
    createWindow: () => fakeWindow(WC),
    createWorker: () => worker,
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
