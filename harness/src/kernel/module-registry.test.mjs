import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest } from './module-registry.cjs'

test('parseManifest 接受旧版字符串 entry', () => {
  const r = parseManifest(JSON.stringify({ id: 'x', name: 'X', entry: './index.html', windowSpec: { width: 100, height: 100 } }), '/base')
  assert.equal(r.ok, true)
  assert.equal(r.manifest.entry, './index.html')
})

test('parseManifest 拒绝缺失必填字段', () => {
  const r = parseManifest(JSON.stringify({ id: 'x', name: 'X' }), '/base')
  assert.equal(r.ok, false)
})
