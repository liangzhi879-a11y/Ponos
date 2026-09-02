import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceEvents } from './events.ts'

test('reduceEvents 将内核事件归并为消息列表', () => {
  let state = { msgs: [], busy: false }
  state = reduceEvents(state, { type: 'user', data: { text: '你好' } })
  state = reduceEvents(state, { type: 'assistant', data: { text: '收到' } })
  assert.equal(state.msgs.length, 2)
  assert.equal(state.msgs[0].role, 'user')
  assert.equal(state.msgs[1].role, 'assistant')
  assert.equal(state.msgs[1].text, '收到')
})
