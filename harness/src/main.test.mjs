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
  // 打开 chat 窗口触发装配的 onWindowCreated 钩子 → attach chat（capabilities: ['anchor-host']，
  // 不覆盖 agent.*，权限拒绝路径经 transport + 权限门验证）
  ctx.orchestrator.open('chat')

  // 正向断言走 router：system.modules.list 的 handler capabilities 前缀匹配方法名即放行
  const list = await ctx.router.invoke({ method: 'system.modules.list', x_sender: 'launcher' })
  assert.equal(list.ok, true)
  assert.ok(Array.isArray(list.result))
  assert.ok(list.result.some(m => m.id === 'chat'))

  // 权限拒绝经 transport 验证：instanceOf(webContents) → gate.check('chat', 'agent.send') → deny
  const callFn = handlers.get('ponos:call')
  const deny = await callFn({ sender: WC }, { method: 'agent.send', params: { text: 'hi' } })
  assert.equal(deny.error, 'PERMISSION_DENIED')
})
