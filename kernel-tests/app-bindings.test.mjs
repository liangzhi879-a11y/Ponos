// 应用绑定（严格单开）——含跨模块契约与竞态防护
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const bind = require('../electron/app-bindings.cjs')

const mk = () => mkdtempSync(join(tmpdir(), 'appbind-'))
const withRoot = (fn) => { const r = mk(); try { return fn(r) } finally { rmSync(r, { recursive: true, force: true }) } }

test('bind 后可读回', () => {
  withRoot((root) => {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-a')
  })
})

test('★ 严格单开：再绑一个会覆盖（不是叠加）', () => {
  withRoot((root) => {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-b' })
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-b')
    // 落盘结构里值是字符串，物理上不可能多开
    const raw = JSON.parse(readFileSync(join(root, 'binding.json'), 'utf-8'))
    assert.equal(typeof raw.s1.appId, 'string')
    assert.equal(Object.keys(raw).length, 1)
  })
})

test('会话隔离：互不影响', () => {
  withRoot((root) => {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    bind.bindApp({ roots: [root], sessionId: 's2', appId: 'app-b' })
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-a')
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's2' }), 'app-b')
  })
})

test('★ unbind 仅当绑定的是同一应用才清除（防误清后绑的）', () => {
  withRoot((root) => {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    assert.equal(bind.unbindApp({ roots: [root], sessionId: 's1', appId: 'app-x' }), false)
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-a', '不匹配不应清除')
    assert.equal(bind.unbindApp({ roots: [root], sessionId: 's1', appId: 'app-a' }), true)
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), null)
  })
})

test('★ 竞态：A 的离开事件晚于 B 的进入，不应清掉 B', () => {
  withRoot((root) => {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })   // 用户先进 A
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-b' })   // 快速切到 B
    bind.unbindApp({ roots: [root], sessionId: 's1', appId: 'app-a' }) // A 的卸载事件迟到
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-b', 'B 不应被误清')
  })
})

test('边界：无 sessionId / 未绑定 / 无 binding.json 均返回 null 不抛', () => {
  withRoot((root) => {
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), null)
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: null }), null)
    assert.equal(bind.getBoundApp({ roots: [root] }), null)
    assert.equal(bind.unbindApp({ roots: [root], sessionId: null, appId: 'x' }), false)
  })
})

test('损坏的 binding.json 视为空（不抛）', () => {
  withRoot((root) => {
    writeFileSync(join(root, 'binding.json'), '{ 坏 JSON', 'utf-8')
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), null)
    assert.deepEqual(bind.listBindings({ roots: [root] }), {})
  })
})

test('bindApp 缺参抛错（不静默写坏数据）', () => {
  withRoot((root) => {
    assert.throws(() => bind.bindApp({ roots: [root], sessionId: 's1' }))
    assert.throws(() => bind.bindApp({ roots: [root], appId: 'app-a' }))
  })
})

test('★ 跨模块契约：与内核侧 kernel/app-spec.mjs 的 getBoundApp 读同一文件', async () => {
  const { getBoundApp } = await import('../kernel/app-spec.mjs')
  withRoot((root) => {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    assert.equal(getBoundApp({ roots: [root], sessionId: 's1' }), 'app-a', '内核必须能读到主进程写的绑定')
    bind.unbindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    assert.equal(getBoundApp({ roots: [root], sessionId: 's1' }), null, '解绑后内核也必须立即读到')
  })
})

test('★ 端到端：绑定 → 内核可见性放行 → 解绑 → 不可见', async () => {
  const { isAppVisible, loadSpec } = await import('../kernel/app-spec.mjs')
  withRoot((root) => {
    const { createRequire: cr } = require('node:module')
    const reg = require('../electron/app-registry.cjs')
    reg.upsertApp({ roots: [root], app: { id: 'app-a', name: '甲', targetType: 'web' } })
    reg.writeSpec({ roots: [root], appId: 'app-a', spec: {
      specVersion: 1, name: '甲', target: { type: 'web' }, expose: { mode: 'console' },
      commands: [{ action: 'q', kind: 'read', steps: [{ act: 'goto', url: '/' }] }],
    } })
    const spec = loadSpec({ roots: [root], appId: 'app-a' })

    assert.equal(isAppVisible(spec, { boundApp: null }), false, '未进控制台：不可见')
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    assert.equal(isAppVisible(spec, { boundApp: bind.getBoundApp({ roots: [root], sessionId: 's1' }) }), true, '进控制台：可见')
    bind.unbindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    assert.equal(isAppVisible(spec, { boundApp: bind.getBoundApp({ roots: [root], sessionId: 's1' }) }), false, '离开：不可见')
  })
})
