import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStateBus } from '../../electron/state-bus.cjs'
import { createStateManager, handleRequest } from './core.cjs'

function memStorage(initial = null) {
  let data = initial
  return { load: () => data, save: d => { data = d } }
}

test('get/set/list 基础语义 + per-key version 递增', () => {
  const sm = createStateManager({ bus: createStateBus(), storage: memStorage() })
  assert.deepEqual(sm.get('a'), { ok: true, value: undefined, version: 0 })
  assert.equal(sm.set('a', { theme: 'dark' }, 'settings').version, 1)
  assert.equal(sm.set('a', { theme: 'light' }, 'settings').version, 2)
  assert.deepEqual(sm.get('a'), { ok: true, value: { theme: 'light' }, version: 2 })
  const list = sm.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].key, 'a')
})

test('set 发布 state:changed 总线事件 + onChanged 回调', () => {
  const bus = createStateBus()
  const sm = createStateManager({ bus, storage: memStorage() })
  const seen = []
  sm.onChanged(ev => seen.push(ev))
  sm.set('settings', { theme: 'vaporwave' }, 'settings')
  const snap = bus.getSnapshot('state')
  assert.equal(snap.length, 1)
  assert.equal(snap[0].action, 'changed')
  assert.equal(snap[0].payload.key, 'settings')
  assert.equal(snap[0].payload.version, 1)
  assert.deepEqual(seen, [{ key: 'settings', value: { theme: 'vaporwave' }, version: 1, from: 'settings' }])
})

test('handleRequest 分发 get/set/list，未知方法报错', () => {
  const sm = createStateManager({ bus: createStateBus(), storage: memStorage() })
  assert.equal(handleRequest(sm, 'state.get', { key: 'x' }).ok, true)
  assert.equal(handleRequest(sm, 'state.set', { key: 'x', value: 1, from: 't' }).version, 1)
  assert.equal(handleRequest(sm, 'state.list', {}).ok, true)
  assert.equal(handleRequest(sm, 'state.bogus', {}).ok, false)
})

test('崩溃恢复：同 storage 重建实例状态不丢（验收标准 4）', () => {
  const storage = memStorage()
  const sm1 = createStateManager({ bus: createStateBus(), storage })
  sm1.set('settings', { theme: 'dark' }, 'settings')
  const sm2 = createStateManager({ bus: createStateBus(), storage })
  assert.deepEqual(sm2.get('settings'), { ok: true, value: { theme: 'dark' }, version: 1 })
})
