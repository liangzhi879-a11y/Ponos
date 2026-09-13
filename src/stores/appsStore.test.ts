// src/stores/appsStore.test.ts
// node --test src/stores/appsStore.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 说明：组件（AppsPanel/AppCard/AppConsole）不做单测——node --test 无 DOM 环境；
// 组件正确性靠 npm run typecheck + 人工走查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAppsStore } from './appsStore.ts'

const noop = { appUpsert: async (a: never) => a, appRemove: async () => ({ ok: true }) }

test('appsStore 初始为空且非加载中', () => {
  const s = createAppsStore({ api: { appList: async () => [], ...noop } as never })
  assert.deepEqual(s.getState().apps, [])
  assert.equal(s.getState().loading, false)
  assert.equal(s.getState().error, null)
})

test('load() 把远端列表写入 state', async () => {
  const s = createAppsStore({ api: { appList: async () => [{ id: 'app-a', name: '甲', targetType: 'web' }], ...noop } as never })
  await s.getState().load()
  assert.equal(s.getState().apps.length, 1)
  assert.equal(s.getState().apps[0].name, '甲')
  assert.equal(s.getState().loading, false)
})

test('load() 失败：落 error 且不残留旧 loading', async () => {
  const s = createAppsStore({ api: { appList: async () => { throw new Error('IPC 挂了') }, ...noop } as never })
  await s.getState().load()
  assert.equal(s.getState().error, 'IPC 挂了')
  assert.equal(s.getState().loading, false)
  assert.deepEqual(s.getState().apps, [])
})

test('远端返回非数组：收敛为空列表（不把脏数据灌进 UI）', async () => {
  const s = createAppsStore({ api: { appList: async () => null as never, ...noop } as never })
  await s.getState().load()
  assert.deepEqual(s.getState().apps, [])
  assert.equal(s.getState().error, null)
})

test('upsert 后自动重载（界面与磁盘同源）', async () => {
  let stored: { id: string; name: string; targetType: string }[] = []
  const api = {
    appList: async () => stored,
    appUpsert: async (a: { id: string; name: string; targetType: string }) => { stored = [a]; return a },
    appRemove: async () => ({ ok: true }),
  }
  const s = createAppsStore({ api: api as never })
  await s.getState().upsert({ id: 'x', name: 'X', targetType: 'web' })
  assert.equal(s.getState().apps.length, 1)
  assert.equal(s.getState().apps[0].id, 'x')
})

test('remove 后自动重载', async () => {
  let stored: { id: string; name: string; targetType: string }[] = [{ id: 'x', name: 'X', targetType: 'web' }]
  const api = {
    appList: async () => stored,
    appUpsert: async (a: never) => a,
    appRemove: async (id: string) => { stored = stored.filter((a) => a.id !== id); return { ok: true } },
  }
  const s = createAppsStore({ api: api as never })
  await s.getState().load()
  assert.equal(s.getState().apps.length, 1)
  await s.getState().remove('x')
  assert.deepEqual(s.getState().apps, [])
})
