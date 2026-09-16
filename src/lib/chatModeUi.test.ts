// src/lib/chatModeUi.test.ts
// node --test src/lib/chatModeUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// Task 11 落 mode 后，chat/task 面板的过滤语义首次在本文件可断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChatLike, isTaskLike, isAppScoped, isPlainTaskLike } from './chatModeUi.ts'

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

test('isAppScoped：只有非空字符串 appId 判真（脏值不算"应用会话"）', () => {
  assert.equal(isAppScoped({ appId: 'app-001' }), true)
  assert.equal(isAppScoped({}), false)
  for (const bad of [undefined, null, '', '   ', 0, 42, {}, []]) {
    assert.equal(isAppScoped({ appId: bad as never }), false, `${JSON.stringify(bad)} 不算应用会话`)
  }
})

test('isPlainTaskLike：应用会话（task 模式 + appId）不得进任务列表', () => {
  const convs = [
    { id: 'c1', mode: 'chat' as const },
    { id: 't1', mode: 'task' as const },
    { id: 'app1', mode: 'task' as const, appId: 'app-001' }, // 应用常驻会话
    { id: 'app2', mode: 'task' as const, appId: '' },        // 脏 appId：仍是普通任务
    { id: 't2' },                                            // 旧数据：无 mode、无 appId
  ]
  assert.deepEqual(convs.filter(isPlainTaskLike).map(c => c.id), ['t1', 'app2', 't2'])
  // 应用会话既不在 chat 面板也不在任务面板（它走应用页自己的入口），各自只出现一次
  assert.deepEqual(convs.filter(isChatLike).map(c => c.id), ['c1'])
  assert.ok(!convs.filter(isPlainTaskLike).some(c => c.id === 'app1'), '应用会话不得作为普通任务重复出现')
})
