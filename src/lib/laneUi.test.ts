// src/lib/laneUi.test.ts
// node --test src/lib/laneUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLaneNote, pushLaneNote, dismissLaneNote } from './laneUi.ts'

function note(key: string, count = 1) {
  return makeLaneNote(key, `摘要 ${key}`, count)
}

test('makeLaneNote：key=taskId、ts 落当前时间', () => {
  const n = makeLaneNote('task-1', 'hello', 2)
  assert.equal(n.key, 'task-1')
  assert.equal(n.taskId, 'task-1')
  assert.equal(n.text, 'hello')
  assert.equal(n.compactCount, 2)
  assert.ok(typeof n.ts === 'number')
})

test('pushLaneNote：追加 + 同 taskId 覆盖且移到最后', () => {
  let list = pushLaneNote([], note('a'))
  list = pushLaneNote(list, note('b'))
  assert.deepEqual(list.map(n => n.key), ['a', 'b'])
  list = pushLaneNote(list, note('a', 2))
  assert.deepEqual(list.map(n => n.key), ['b', 'a'])
  assert.equal(list[1].compactCount, 2)
})

test('pushLaneNote：cap 3，超限丢最旧', () => {
  let list: ReturnType<typeof makeLaneNote>[] = []
  for (const k of ['a', 'b', 'c', 'd']) list = pushLaneNote(list, note(k))
  assert.deepEqual(list.map(n => n.key), ['b', 'c', 'd'])
})

test('dismissLaneNote：去头部；空表幂等', () => {
  assert.deepEqual(dismissLaneNote([]), [])
  const one = dismissLaneNote([note('a')])
  assert.deepEqual(one, [])
  const two = dismissLaneNote([note('a'), note('b')])
  assert.deepEqual(two.map(n => n.key), ['b'])
})
