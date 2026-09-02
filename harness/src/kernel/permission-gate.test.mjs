import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPermissionGate } from './permission-gate.cjs'

const REG = {
  getModule: id => ({
    id,
    capabilities: id === 'chat' ? ['system.window', 'agent'] : [],
  }),
}

test('capabilities 前缀匹配放行', () => {
  const g = createPermissionGate({ registry: REG })
  assert.equal(g.check('chat', 'system.window.open').ok, true)
  assert.equal(g.check('chat', 'agent.send').ok, true)
})

test('未声明 capabilities 默认拒绝（除 system.discover）', () => {
  const g = createPermissionGate({ registry: REG })
  assert.equal(g.check('launcher', 'system.window.open').ok, false)
  assert.equal(g.check('launcher', 'system.discover').ok, true)
})

test('越权方法拒绝并带模块与方法信息', () => {
  const g = createPermissionGate({ registry: REG })
  const r = g.check('chat', 'fs.listDir')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'PERMISSION_DENIED')
  assert.equal(r.method, 'fs.listDir')
})
