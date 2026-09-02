import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceEvents } from './events.ts'

const S = { msgs: [], busy: false }
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

test('reduceEvents 把流式 assistant 文本块聚合为单条消息（busy 窗口内合并）', () => {
  let s = reduceEvents(S, assistant('收'))
  s = reduceEvents(s, assistant('到'))
  assert.equal(s.msgs.length, 1)
  assert.equal(s.msgs[0].role, 'assistant')
  assert.equal(s.msgs[0].text, '收到')
  assert.equal(s.busy, true, 'assistant 事件应置 busy')
})

test('thinking/tool_use 纯块不渲染；result 闭轮清 busy', () => {
  let s = reduceEvents(S, assistant('你好'))
  const th = reduceEvents(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想一下' }] } })
  assert.deepEqual(th.msgs, s.msgs, 'thinking 块不应新增消息')
  const tool = reduceEvents(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] } })
  assert.deepEqual(tool.msgs, s.msgs, 'tool_use 块不应新增消息（v1 不渲染）')
  const done = reduceEvents(s, { type: 'result', usage: {} })
  assert.equal(done.busy, false)
  assert.equal(done.msgs.length, 1)
})

test('result 后新一轮首个文本块另起新消息（不并入上轮）', () => {
  let s = reduceEvents(S, assistant('第一轮'))
  s = reduceEvents(s, { type: 'result', usage: {} })
  s = reduceEvents(s, assistant('第二轮'))
  assert.equal(s.msgs.length, 2)
  assert.equal(s.msgs[1].text, '第二轮')
  assert.equal(s.msgs[0].text, '第一轮')
})
