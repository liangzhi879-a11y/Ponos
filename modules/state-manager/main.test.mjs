import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorker } from './main.cjs'

function fakePort() {
  const listeners = {}
  return {
    sent: [],
    postMessage(m) { this.sent.push(m) },
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
  }
}
function memStorage() { let d = null; return { load: () => d, save: v => { d = v } } }

test('runWorker 响应 get/set 请求并把 changed 发为通知', () => {
  const port = fakePort()
  const sm = runWorker({ port, bus: null, storage: memStorage(), createBus: () => null })
  port.emit('message', { id: 1, method: 'state.set', params: { key: 'settings', value: { theme: 'dark' }, from: 't' } })
  port.emit('message', { id: 2, method: 'state.get', params: { key: 'settings' } })
  const setResp = port.sent.find(m => m.id === 1)
  assert.equal(setResp.result.version, 1)
  const getResp = port.sent.find(m => m.id === 2)
  assert.deepEqual(getResp.result, { ok: true, value: { theme: 'dark' }, version: 1 })
  const notif = port.sent.find(m => m.id === undefined && m.method === 'state.changed')
  assert.equal(notif.params.key, 'settings')
})
