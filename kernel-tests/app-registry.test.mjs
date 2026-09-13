// 应用注册表：CRUD + 落盘 + Spec 备份写入
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const registry = require('../electron/app-registry.cjs')

const mk = () => mkdtempSync(join(tmpdir(), 'appreg-'))
const withRoot = (fn) => { const r = mk(); try { return fn(r) } finally { rmSync(r, { recursive: true, force: true }) } }

test('upsertApp 新增并落盘 registry.json', () => {
  withRoot((root) => {
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲', targetType: 'web', enabled: true } })
    const list = registry.listApps({ roots: [root] })
    assert.equal(list.length, 1)
    assert.equal(list[0].name, '甲')
    assert.ok(existsSync(join(root, 'registry.json')))
    assert.ok(existsSync(join(root, 'app-a')), '应同时创建应用目录')
  })
})

test('upsertApp 同 id 是更新而非追加', () => {
  withRoot((root) => {
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲' } })
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲改' } })
    const list = registry.listApps({ roots: [root] })
    assert.equal(list.length, 1)
    assert.equal(list[0].name, '甲改')
  })
})

test('upsertApp 缺 id 抛错（不静默写坏数据）', () => {
  withRoot((root) => {
    assert.throws(() => registry.upsertApp({ roots: [root], app: { name: '无 id' } }))
  })
})

test('listApps 缺失/损坏的 registry.json 返回空数组', () => {
  withRoot((root) => {
    assert.deepEqual(registry.listApps({ roots: [root] }), [])
    writeFileSync(join(root, 'registry.json'), '{ 坏', 'utf-8')
    assert.deepEqual(registry.listApps({ roots: [root] }), [])
  })
})

test('writeSpec 落盘 + readSpec 读回', () => {
  withRoot((root) => {
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲' } })
    registry.writeSpec({ roots: [root], appId: 'app-a', spec: { specVersion: 1, name: '甲' } })
    const s = registry.readSpec({ roots: [root], appId: 'app-a' })
    assert.equal(s.specVersion, 1)
  })
})

test('★ writeSpec 强制对齐 appId = 目录名（源头消除静默错配）', () => {
  withRoot((root) => {
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲' } })
    // 故意传一个错的 appId，写盘后必须被纠正为目录名
    registry.writeSpec({ roots: [root], appId: 'app-a', spec: { specVersion: 1, appId: 'app-WRONG', name: '甲' } })
    assert.equal(registry.readSpec({ roots: [root], appId: 'app-a' }).appId, 'app-a')
    // 与内核侧 loadSpec 的一致性校验联动：现在必然通过
    assert.ok(registry.readSpec({ roots: [root], appId: 'app-a' }) !== null)
  })
})

test('writeSpec 二次写入会生成 spec.bak.<ts>.json 备份', () => {
  withRoot((root) => {
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲' } })
    registry.writeSpec({ roots: [root], appId: 'app-a', spec: { specVersion: 1, v: 1 } })
    registry.writeSpec({ roots: [root], appId: 'app-a', spec: { specVersion: 1, v: 2 } })
    const files = readdirSync(join(root, 'app-a'))
    assert.ok(files.some((f) => /^spec\.bak\.\d+\.json$/.test(f)), `应有备份，实际：${files}`)
    assert.equal(registry.readSpec({ roots: [root], appId: 'app-a' }).v, 2)
  })
})

test('writeSpec 首次写入不产生备份（没有旧版可备）', () => {
  withRoot((root) => {
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲' } })
    registry.writeSpec({ roots: [root], appId: 'app-a', spec: { specVersion: 1, v: 1 } })
    const files = readdirSync(join(root, 'app-a'))
    assert.equal(files.filter((f) => /^spec\.bak\./.test(f)).length, 0)
  })
})

test('writeSpec 可写不存在的应用目录（自动建目录）', () => {
  withRoot((root) => {
    registry.writeSpec({ roots: [root], appId: 'app-new', spec: { specVersion: 1, name: '新' } })
    assert.equal(registry.readSpec({ roots: [root], appId: 'app-new' }).appId, 'app-new')
  })
})

test('readSpec 不存在返回 null', () => {
  withRoot((root) => {
    assert.equal(registry.readSpec({ roots: [root], appId: 'nope' }), null)
  })
})

test('removeApp 删除清单项与目录', () => {
  withRoot((root) => {
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲' } })
    registry.writeSpec({ roots: [root], appId: 'app-a', spec: { specVersion: 1 } })
    registry.removeApp({ roots: [root], appId: 'app-a' })
    assert.equal(registry.listApps({ roots: [root] }).length, 0)
    assert.equal(existsSync(join(root, 'app-a')), false)
  })
})

test('setAppEnabled 切换启用状态', () => {
  withRoot((root) => {
    registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲', enabled: true } })
    registry.setAppEnabled({ roots: [root], appId: 'app-a', enabled: false })
    assert.equal(registry.listApps({ roots: [root] })[0].enabled, false)
    assert.equal(registry.setAppEnabled({ roots: [root], appId: 'nope', enabled: false }), null)
  })
})

test('★ 与内核侧 app-spec.mjs 的一致性契约：写出的 Spec 能被内核读出', async () => {
  const { loadSpec } = await import('../kernel/app-spec.mjs')
  await new Promise((resolve, reject) => {
    const root = mk()
    try {
      registry.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲系统', targetType: 'web' } })
      registry.writeSpec({ roots: [root], appId: 'app-a', spec: { specVersion: 1, name: '甲系统', target: { type: 'web' }, commands: [] } })
      const spec = loadSpec({ roots: [root], appId: 'app-a' })
      assert.ok(spec, '内核应能读到刚写入的 Spec')
      assert.equal(spec.appId, 'app-a')
      resolve()
    } catch (e) { reject(e) } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
