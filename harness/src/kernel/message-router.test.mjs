import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../rpc/router.cjs'
import { createStateBus } from '../../../electron/state-bus.cjs'
import { createMessageRouter } from './message-router.cjs'
import { makeEnvelope } from '../rpc/envelope.cjs'

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
  // sendTo 要求合法 envelope（修复前：非法 envelope 反而被转发；修复后：校验不过即丢弃）
  mr.sendTo('chat', makeEnvelope({ method: 'chat.event', x_sender: 'agent' }))
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

test('sendTo 非法 envelope 一律丢弃，target 不收到任何消息', () => {
  const mr = createMessageRouter({ router: createRouter(), bus: createStateBus() })
  const t = fakeTarget()
  mr.attach('chat', t, ['chat'])
  // 缺 jsonrpc/x_sender → validateEnvelope 不过 → 丢弃
  assert.equal(mr.sendTo('chat', { method: 'x' }), false)
  assert.equal(mr.sendTo('chat', { method: 'x', x_sender: 'agent' }), false)
  assert.equal(mr.sendTo('chat', makeEnvelope({ method: 'x', x_sender: 'agent' })), true)
  assert.equal(t.sent.length, 1, '仅合法 envelope 被转发一次')
})

test('sendTo TTL 逐跳衰减回写，耗尽后不再转发', () => {
  const mr = createMessageRouter({ router: createRouter(), bus: createStateBus() })
  const t = fakeTarget()
  mr.attach('chat', t, ['chat'])
  const env = makeEnvelope({ method: 'chat.event', x_sender: 'agent' })
  env.x_ttl = 2
  // 第一跳：转发且回写 1
  assert.equal(mr.sendTo('chat', env), true)
  assert.equal(env.x_ttl, 1, 'TTL 应回写衰减')
  assert.equal(t.sent.length, 1)
  // 第二跳：转发且回写 0
  assert.equal(mr.sendTo('chat', env), true)
  assert.equal(env.x_ttl, 0, 'TTL 应回写衰减至 0')
  assert.equal(t.sent.length, 2)
  // 第三跳：TTL 已耗尽 → 丢弃，target 总数不变
  assert.equal(mr.sendTo('chat', env), false)
  assert.equal(t.sent.length, 2, '耗尽后不得再转发')
})

test('sendTo x_ttl=1 首跳即转发并回写 0，第二跳丢弃', () => {
  const mr = createMessageRouter({ router: createRouter(), bus: createStateBus() })
  const t = fakeTarget()
  mr.attach('chat', t, ['chat'])
  const env = makeEnvelope({ method: 'chat.event', x_sender: 'agent' })
  env.x_ttl = 1
  assert.equal(mr.sendTo('chat', env), true)
  assert.equal(env.x_ttl, 0, '首跳后回写 0')
  assert.equal(t.sent.length, 1)
  assert.equal(mr.sendTo('chat', env), false, '第二跳（x_ttl=0）丢弃')
  assert.equal(t.sent.length, 1)
})
