import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRpcClient } from './rpc-client.cjs'

function fakeTransport() {
  const listeners = []
  return {
    sent: [],
    send(env) { this.sent.push(env) },
    onMessage(cb) { listeners.push(cb) },
    emit(m) { listeners.forEach(cb => cb(m)) },
  }
}

test('call 请求带递增 id，响应经 id 配对 resolve', async () => {
  const t = fakeTransport()
  const c = createRpcClient({ transport: t })
  const p = c.call('state.get', { key: 'a' })
  assert.equal(t.sent[0].id, 1)
  assert.equal(t.sent[0].method, 'state.get')
  t.emit({ id: 1, result: { ok: true, value: 1, version: 0 } })
  assert.deepEqual(await p, { ok: true, value: 1, version: 0 })
})

test('error 响应 reject；无 id 消息走 onNotification', async () => {
  const t = fakeTransport()
  const c = createRpcClient({ transport: t })
  const got = []
  c.onNotification(m => got.push(m))
  const p = c.call('state.set', { key: 'a', value: 1, from: 'x' })
  t.emit({ id: 1, error: 'boom' })
  await assert.rejects(p, /boom/)
  t.emit({ method: 'state.changed', params: { key: 'a' } })
  assert.equal(got.length, 1)
  assert.equal(got[0].params.key, 'a')
})
