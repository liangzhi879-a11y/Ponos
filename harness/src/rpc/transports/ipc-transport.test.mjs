import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIpcTransport } from './ipc-transport.cjs'
import { createRouter } from '../router.cjs'
import { createMessageRouter } from '../../kernel/message-router.cjs'
import { createPermissionGate } from '../../kernel/permission-gate.cjs'
import { createStateBus } from '../../../../electron/state-bus.cjs'

test('ipc-transport：call 走 router 且受权限门拦截', async () => {
  const handlers = new Map()
  const listeners = new Map()
  const ipcMain = {
    handle(ch, fn) { handlers.set(ch, fn) },
    on(ch, fn) { (listeners.get(ch) || listeners.set(ch, []).get(ch)).push(fn) },
  }
  const router = createRouter()
  router.register('system.window.open', () => ({ ok: true }), { capabilities: ['system.window'] })
  const mr = createMessageRouter({ router, bus: createStateBus() })
  // mr.call 要求 sender 已 attach，否则返回 NOT_ATTACHED
  mr.attach('chat', { send: () => {} }, ['system.window'])
  const gate = createPermissionGate({ registry: { getModule: id => ({ id, capabilities: id === 'chat' ? ['system.window'] : [] }) } })
  const transport = createIpcTransport({ ipcMain, mr, gate, instanceOf: () => 'chat' })
  transport.handle()

  const callFn = handlers.get('ponos:call')
  const okRes = await callFn({}, { method: 'system.window.open', params: { moduleId: 'files' } })
  assert.equal(okRes.ok, true)
  const denyRes = await callFn({}, { method: 'fs.listDir', params: {} })
  assert.equal(denyRes.ok, false)
  assert.equal(denyRes.error, 'PERMISSION_DENIED')
})

test('ipc-transport：shell 主 frame 豁免 system.window.*；iframe 模块 UI 仍受权限门拦截', async () => {
  const handlers = new Map()
  const ipcMain = {
    handle(ch, fn) { handlers.set(ch, fn) },
    on() {},
  }
  const router = createRouter()
  router.register('system.window.context', () => ({ ok: true, result: { name: 'settings', entry: 'dist/modules/settings/index.html' } }), { capabilities: ['system.window'] })
  const mr = createMessageRouter({ router, bus: createStateBus() })
  mr.attach('settings', { send: () => {} }, [])
  // settings 模块无 system.window capability —— 仅 shell 主 frame 豁免后其窗口才能加载
  const gate = createPermissionGate({ registry: { getModule: () => ({ id: 'settings', capabilities: [] }) } })
  const transport = createIpcTransport({ ipcMain, mr, gate, instanceOf: () => 'settings' })
  transport.handle()
  const callFn = handlers.get('ponos:call')

  // 主 frame（shell.html）：senderFrame.parent === null → system.window.context 放行
  const shellEvt = { senderFrame: { parent: null } }
  const shellRes = await callFn(shellEvt, { method: 'system.window.context', params: { key: 'settings::' } })
  assert.equal(shellRes.ok, true)

  // iframe（模块 UI）：senderFrame.parent 非 null → 仍被 gate 拦截
  const iframeEvt = { senderFrame: { parent: { url: 'file:///shell.html' } } }
  const iframeRes = await callFn(iframeEvt, { method: 'system.window.context', params: { key: 'settings::' } })
  assert.equal(iframeRes.ok, false)
  assert.equal(iframeRes.error, 'PERMISSION_DENIED')
})
