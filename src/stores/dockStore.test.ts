import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useDockStore } from './dockStore.ts'

test('dockStore 初始态：未展开、未锁定、计数全零', () => {
  const s = useDockStore.getState()
  assert.equal(s.expanded, false)
  assert.equal(s.locked, false)
  assert.deepEqual(s.counts, { task: 0, question: 0, approval: 0, module: 0 })
})

test('bump 累加指定 channel 计数，reset 清零', () => {
  useDockStore.getState().bump('task')
  useDockStore.getState().bump('task')
  useDockStore.getState().bump('approval')
  assert.equal(useDockStore.getState().counts.task, 2)
  assert.equal(useDockStore.getState().counts.approval, 1)
  useDockStore.getState().reset('task')
  assert.equal(useDockStore.getState().counts.task, 0)
})

test('setExpanded/setLocked 状态切换', () => {
  useDockStore.getState().setExpanded(true)
  assert.equal(useDockStore.getState().expanded, true)
  useDockStore.getState().setLocked(true)
  assert.equal(useDockStore.getState().locked, true)
})
