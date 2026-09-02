import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../rpc/router.cjs'
import { createStateBus } from '../../../electron/state-bus.cjs'
import { createMessageRouter } from './message-router.cjs'

function fakeTarget() {
  const sent = []
  return { sent, send(channel, data) { sent.push({ channel, data }) } }
}

test('attach 注册连接，重复 attach 报错', () => {
  const mr = createMessageRouter({ router: createRouter(), bus: createStateBus() })
  const t = fakeTarget()
  assert.equal(mr.attach('chat', t, ['chat']).ok, true)
  assert.equal(mr.attach('chat', t, ['chat']).ok, false)
  assert.equal(mr.detach('chat').ok, true)
  assert.equal(mr.attach('chat', t, ['chat']).ok, true)
})

test('call 经 router 分发并可推送事件回模块', async () => {
  const router = createRouter()
  router.register('chat.send', (p) => ({ echo: p.text }), { capabilities: ['chat'] })
  const mr = createMessageRouter({ router, bus: createStateBus() })
  const t = fakeTarget()
  mr.attach('chat', t, ['chat'])
  const res = await mr.call({ method: 'chat.send', params: { text: 'hi' }, sender: 'chat' })
  assert.deepEqual(res, { ok: true, result: { echo: 'hi' } })
  mr.sendTo('chat', { method: 'chat.event', x_sender: 'agent' })
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0].channel, 'rpc:chat.event')
})

test('broadcast 走 bus.publish，订阅方收到 event:channel', () => {
  const bus = createStateBus()
  const mr = createMessageRouter({ router: createRouter(), bus })
  const t = fakeTarget()
  bus.subscribe('intent', t)
  mr.broadcast({ channel: 'intent', event: { type: 'coding', query: '写个快排' }, sender: 'chat' })
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0].channel, 'bus:event:intent')
  assert.equal(t.sent[0].data.payload.type, 'coding')
})
