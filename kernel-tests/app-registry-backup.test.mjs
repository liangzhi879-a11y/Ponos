// Task 3.3：Spec 备份列举与回滚（含路径穿越防护、恢复也留备份）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const registry = require('../electron/app-registry.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'appbak-'))
  return { roots: [root], root }
}
const specOf = (name) => ({
  specVersion: 1, appId: 'demo', name, driver: 'browser',
  target: { type: 'web', url: 'https://a.com' }, expose: { mode: 'console' },
  commands: [{ action: 'listRecent', title: '列表', kind: 'read', params: [], steps: [{ act: 'goto', url: '/r' }] }],
})

test('listBackups：没有备份 → 空数组（目录不存在也不抛）', () => {
  const { roots } = mk()
  assert.deepEqual(registry.listBackups({ roots, appId: 'demo' }), [])
})

test('listBackups：按备份号倒序（最新在前），且只认白名单命名', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v1') })
  await sleep(5)
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v2') })
  await sleep(5)
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v3') })
  const b = registry.listBackups({ roots, appId: 'demo' })
  assert.equal(b.length, 2, '两次覆盖 → 两个备份')
  assert.ok(b[0].ts > b[1].ts, '倒序：最新备份在前')
  assert.ok(b.every((x) => /^spec\.bak\.\d+\.json$/.test(x.name)))
})

test('listBackups：忽略非白名单文件（不把 spec.json / 杂物当备份）', async () => {
  const { roots, root } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v1') })
  const { writeFileSync } = require('node:fs')
  writeFileSync(join(root, 'demo', 'spec.bak.abc.json'), '{}', 'utf-8')
  writeFileSync(join(root, 'demo', 'notes.txt'), 'x', 'utf-8')
  assert.deepEqual(registry.listBackups({ roots, appId: 'demo' }), [])
})

test('restoreSpec：内容真的回滚到旧版', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v1') })
  await sleep(5)
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v2') })
  const backups = registry.listBackups({ roots, appId: 'demo' })
  assert.equal(backups.length, 1)
  const restored = registry.restoreSpec({ roots, appId: 'demo', backupName: backups[0].name })
  assert.equal(restored.name, 'v1')
  assert.equal(registry.readSpec({ roots, appId: 'demo' }).name, 'v1')
})

test('restoreSpec：恢复前也备份当前版本（回滚可再回滚）', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v1') })
  await sleep(5)
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v2') })
  const before = registry.listBackups({ roots, appId: 'demo' }).length
  registry.restoreSpec({ roots, appId: 'demo', backupName: registry.listBackups({ roots, appId: 'demo' })[0].name })
  await sleep(5)
  const after = registry.listBackups({ roots, appId: 'demo' })
  assert.equal(after.length, before + 1, '恢复动作本身也留了一个备份')
  // 且最新那个备份里存的是"恢复前"的 v2 → 可再切回去
  const reverted = registry.restoreSpec({ roots, appId: 'demo', backupName: after[0].name })
  assert.equal(reverted.name, 'v2')
})

test('restoreSpec：备份名不在白名单 → 抛错且不写盘（路径穿越防护）', () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v1') })
  const before = JSON.stringify(registry.readSpec({ roots, appId: 'demo' }))
  for (const bad of ['../evil.json', 'spec.json', 'spec.bak.abc.json', 'spec.bak.1.json', '', null, undefined]) {
    assert.throws(() => registry.restoreSpec({ roots, appId: 'demo', backupName: bad }), /备份名不合法/, `应拒绝：${String(bad)}`)
  }
  assert.equal(JSON.stringify(registry.readSpec({ roots, appId: 'demo' })), before, 'Spec 未被改动')
})

test('restoreSpec：合法命名但文件不存在 → 明确报错', () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v1') })
  assert.throws(() => registry.restoreSpec({ roots, appId: 'demo', backupName: 'spec.bak.1700000000000.json' }), /不存在或已损坏/)
})

test('restoreSpec：备份内容损坏（非 JSON 对象）→ 报错且不写盘', async () => {
  const { roots, root } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: specOf('v1') })
  const { writeFileSync } = require('node:fs')
  writeFileSync(join(root, 'demo', 'spec.bak.1700000000000.json'), 'not json', 'utf-8')
  assert.throws(() => registry.restoreSpec({ roots, appId: 'demo', backupName: 'spec.bak.1700000000000.json' }), /不存在或已损坏/)
  assert.equal(registry.readSpec({ roots, appId: 'demo' }).name, 'v1')
})

test('writeSpec：强制 appId 以目录名为准（回滚也不会把 appId 改错）', async () => {
  const { roots, root } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: { ...specOf('v1'), appId: '冒牌' } })
  assert.equal(registry.readSpec({ roots, appId: 'demo' }).appId, 'demo')
  assert.ok(existsSync(join(root, 'demo', 'spec.json')))
})

test.after(() => { /* 临时目录由系统回收；此处不主动删以便失败时排查 */ })
