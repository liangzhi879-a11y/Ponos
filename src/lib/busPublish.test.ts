// src/lib/busPublish.test.ts
// node --test src/lib/busPublish.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChatEvent } from './busPublish.ts'

test('buildChatEvent 构造 BusEvent 信封', () => {
  const e = buildChatEvent('task', 'status-change', { taskId: 't1' }, 'conv-1')
  assert.equal(e.channel, 'task')
  assert.equal(e.action, 'status-change')
  assert.equal(e.from, 'chat:conv-1')
  assert.equal(typeof e.ts, 'number')
  assert.deepEqual(e.payload, { taskId: 't1' })
})
