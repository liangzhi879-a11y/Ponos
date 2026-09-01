import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateBus } from '../electron/state-bus.cjs'

function fakeTarget() {
  const received = []
  return {
    received,
    send(channel, data) { received.push({ channel, data }) },
  }
}

test('publish 广播给该 channel 的全部订阅者', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  const b = fakeTarget()
  bus.subscribe('task', a)
  bus.subscribe('task', b)
  bus.subscribe('question', a)
  bus.publish({ channel: 'task', action: 'status-change', payload: { taskId: 't1' }, from: 'chat-1', ts: 1 })
  assert.equal(a.received.length, 1)
  assert.equal(b.received.length, 1)
  assert.equal(a.received[0].channel, 'bus:event:task')
  assert.equal(a.received[0].data.action, 'status-change')
  assert.equal(a.received[0].data.payload.taskId, 't1')
})

test('未订阅该 channel 的窗口不收到事件', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('task', a)
  bus.publish({ channel: 'module', action: 'opened', payload: {}, from: 'files', ts: 1 })
  assert.equal(a.received.length, 0)
})

test('非法信封（缺 channel/action/from）拒绝且不广播', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('task', a)
  bus.publish({ channel: '', action: 'x', payload: {}, from: 'y', ts: 1 })
  bus.publish({ channel: 'task', action: '', payload: {}, from: 'y', ts: 1 })
  bus.publish({ channel: 'task', action: 'ok', payload: {}, from: '', ts: 1 })
  assert.equal(a.received.length, 0)
})

test('getSnapshot 返回最近 N 条（默认 50），超量丢弃最旧', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('task', a)
  for (let i = 0; i < 55; i++) {
    bus.publish({ channel: 'task', action: 's', payload: { i }, from: 'chat', ts: i })
  }
  const snap = bus.getSnapshot('task')
  assert.equal(snap.length, 50)
  assert.equal(snap[0].payload.i, 5)
  assert.equal(snap[49].payload.i, 54)
})

test('unsubscribe/detach 后不再收到事件', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('task', a)
  bus.unsubscribe('task', a)
  bus.publish({ channel: 'task', action: 's', payload: {}, from: 'c', ts: 1 })
  assert.equal(a.received.length, 0)
  bus.subscribe('task', a)
  bus.detach(a)
  bus.publish({ channel: 'task', action: 's', payload: {}, from: 'c', ts: 2 })
  assert.equal(a.received.length, 0)
})

test('自定义 channel（custom:*）可订阅广播', () => {
  const bus = createStateBus()
  const a = fakeTarget()
  bus.subscribe('custom:weather', a)
  bus.publish({ channel: 'custom:weather', action: 'update', payload: { t: 22 }, from: 'weather', ts: 1 })
  assert.equal(a.received.length, 1)
  assert.equal(a.received[0].data.payload.t, 22)
})
