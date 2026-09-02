import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickLaunchable } from './launchable.ts'

test('pickLaunchable 过滤掉 launcher 自身并保留可开窗模块', () => {
  const mods = [
    { id: 'launcher', name: '启动台', runtime: 'ui-renderer', entry: { ui: 'a.html' } },
    { id: 'chat', name: '聊天', entry: { ui: 'b.html' } }, // ui-renderer 缺省 runtime（registry 语义）
  ]
  const list = pickLaunchable(mods)
  assert.deepEqual(list.map(m => m.id), ['chat'])
})

test('pickLaunchable 过滤非 ui-renderer 模块（cli-bridge/node-worker 不进启动台）', () => {
  const mods = [
    { id: 'launcher', name: '启动台', runtime: 'ui-renderer', entry: { ui: 'a.html' } },
    { id: 'chat', name: '聊天', entry: { ui: 'b.html' } },
    { id: 'state-manager', name: '状态服务', runtime: 'node-worker', entry: { main: 'c.cjs' } },
    { id: 'agent-core', name: 'Agent 内核', runtime: 'cli-bridge', entry: { main: 'd.cjs' } },
    { id: 'echo-demo', name: '外部程序示例', runtime: 'cli-bridge', entry: { main: 'e.py' } },
  ]
  const picked = pickLaunchable(mods)
  assert.deepEqual(picked.map(m => m.id), ['chat'])
})
