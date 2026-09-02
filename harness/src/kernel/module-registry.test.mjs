import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest } from './module-registry.cjs'

test('parseManifest 接受旧版字符串 entry', () => {
  const r = parseManifest(JSON.stringify({ id: 'x', name: 'X', entry: './index.html', windowSpec: { width: 100, height: 100 } }), '/base')
  assert.equal(r.ok, true)
  assert.deepEqual(r.manifest.entry, { ui: './index.html' })
})

test('parseManifest 拒绝缺失必填字段', () => {
  const r = parseManifest(JSON.stringify({ id: 'x', name: 'X' }), '/base')
  assert.equal(r.ok, false)
})

test('parseManifest v2：entry 字符串归一化为对象且 runtime 默认 ui-renderer', () => {
  const r = parseManifest(JSON.stringify({ id: 'c', name: 'Chat', entry: './index.html', windowSpec: { width: 900, height: 700 } }), '/base')
  assert.equal(r.ok, true)
  assert.deepEqual(r.manifest.entry, { ui: './index.html' })
  assert.equal(r.manifest.runtime, 'ui-renderer')
})

test('parseManifest v2：对象 entry 与 interfaces/capabilities/lifecycle/runtimeConfig 保留', () => {
  const r = parseManifest(JSON.stringify({
    id: 'a', name: 'Agent', runtime: 'cli-bridge',
    entry: { main: './dist/index.js' },
    windowSpec: { width: 100, height: 100 },
    interfaces: { provides: [{ method: 'a.run', handler: 'h.run' }], consumes: [] },
    capabilities: ['agent.run'],
    lifecycle: { init: 'b.init' },
    runtimeConfig: { sandbox: { allowNetwork: ['localhost:8080'] } },
  }), '/base')
  assert.equal(r.ok, true)
  assert.equal(r.manifest.runtime, 'cli-bridge')
  assert.equal(r.manifest.interfaces.provides[0].method, 'a.run')
  assert.deepEqual(r.manifest.capabilities, ['agent.run'])
  assert.equal(r.manifest.lifecycle.init, 'b.init')
  assert.deepEqual(r.manifest.runtimeConfig.sandbox.allowNetwork, ['localhost:8080'])
})
