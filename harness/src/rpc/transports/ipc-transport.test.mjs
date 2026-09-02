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
