import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickLaunchable } from './launchable.ts'

test('pickLaunchable 过滤掉 launcher 自身并保留可启动模块', () => {
  const mods = [
    { id: 'launcher', name: '启动台' },
    { id: 'chat', name: '聊天' },
  ]
  const list = pickLaunchable(mods)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'chat')
})
