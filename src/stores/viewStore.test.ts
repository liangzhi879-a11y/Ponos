import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useViewStore } from './viewStore.ts'

test('初始 view=boot', () => {
  assert.equal(useViewStore.getState().view, 'boot')
})
test('bootDone → login → enter → cockpit', () => {
  const s = useViewStore.getState()
  s.bootDone()
  assert.equal(useViewStore.getState().view, 'login')
  useViewStore.getState().enter()
  assert.equal(useViewStore.getState().view, 'cockpit')
})
test('goWorkspace 带 tab，goCockpit 清 tab', () => {
  useViewStore.getState().goWorkspace('agents')
  const s = useViewStore.getState()
  assert.equal(s.view, 'workspace')
  assert.equal(s.workspaceTab, 'agents')
  useViewStore.getState().goCockpit()
  assert.equal(useViewStore.getState().view, 'cockpit')
  assert.equal(useViewStore.getState().workspaceTab, null)
})
test('goDock 切到 dock 视图并清 tab', () => {
  useViewStore.getState().goWorkspace('agents')
  useViewStore.getState().goDock()
  assert.equal(useViewStore.getState().view, 'dock')
  assert.equal(useViewStore.getState().workspaceTab, null)
})
test('setAuthToken 预留认证扩展点', () => {
  useViewStore.getState().setAuthToken('demo-token')
  assert.equal(useViewStore.getState().authToken, 'demo-token')
})
