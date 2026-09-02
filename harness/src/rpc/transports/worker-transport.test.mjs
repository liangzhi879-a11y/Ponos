import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerTransport } from './worker-transport.cjs'

function fakeWorker() {
  const listeners = {}
  return {
    sent: [],
    postMessage(m) { this.sent.push(m) },
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
    terminate() { this.terminated = true },
  }
}

test('send 经 postMessage 编码；onMessage 转发 message 事件', () => {
  const w = fakeWorker()
  const t = createWorkerTransport({ worker: w })
  const got = []
  t.onMessage(m => got.push(m))
  t.send({ method: 'state.get', params: { key: 'a' } })
  assert.equal(w.sent.length, 1)
  assert.equal(w.sent[0].method, 'state.get')
  w.emit('message', { id: 1, result: { ok: true } })
  assert.deepEqual(got, [{ id: 1, result: { ok: true } }])
})

test('onMessage 返回退订函数；close 调 worker.terminate', () => {
  const w = fakeWorker()
  const t = createWorkerTransport({ worker: w })
  let n = 0
  const off = t.onMessage(() => n++)
  w.emit('message', {})
  off()
  w.emit('message', {})
  assert.equal(n, 1)
  t.close()
  assert.equal(w.terminated, true)
})
