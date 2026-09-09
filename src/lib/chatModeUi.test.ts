// src/lib/chatModeUi.test.ts
// node --test src/lib/chatModeUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// Task 11 落 mode 后，chat/task 面板的过滤语义首次在本文件可断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChatLike, isTaskLike } from './chatModeUi.ts'

test('isChatLike：仅 mode==="chat" 判真', () => {
  assert.equal(isChatLike({ mode: 'chat' }), true)
  assert.equal(isChatLike({ mode: 'task' }), false)
  assert.equal(isChatLike({}), false)
  assert.equal(isChatLike({ mode: undefined }), false)
})

test('isTaskLike：undefined mode 视为 task（旧数据/导入兼容）', () => {
  assert.equal(isTaskLike({ mode: 'task' }), true)
  assert.equal(isTaskLike({}), true)
  assert.equal(isTaskLike({ mode: undefined }), true)
  assert.equal(isTaskLike({ mode: 'chat' }), false)
})

test('mode 过滤把 chat 与 task 会话彼此分开', () => {
  const convs = [
    { id: 'c1', mode: 'chat' as const },
    { id: 't1', mode: 'task' as const },
    { id: 't2' }, // 旧数据：无 mode
  ]
  const chat = convs.filter(isChatLike).map(c => c.id)
  const task = convs.filter(isTaskLike).map(c => c.id)
  assert.deepEqual(chat, ['c1'])
  assert.deepEqual(task, ['t1', 't2'])
  // 并集恰为全集：两过滤器互斥且无遗漏
  assert.deepEqual([...chat, ...task].sort(), convs.map(c => c.id).sort())
})
