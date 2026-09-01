import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listModules, getModule, parseManifest } from '../electron/module-registry.cjs'

test('listModules 返回全部内置模块（dock/cockpit/chat/files/settings）', () => {
  const mods = listModules()
  const ids = mods.map(m => m.id)
  for (const id of ['dock', 'cockpit', 'chat', 'files', 'settings']) assert.ok(ids.includes(id), `missing ${id}`)
  // 每项含完整 windowSpec
  for (const m of mods) {
    assert.ok(m.windowSpec.width > 0 && m.windowSpec.height > 0)
    assert.equal(typeof m.singleton, 'boolean')
    assert.equal(m.builtin, true)
  }
})

test('getModule 命中返回描述、未命中返回 undefined', () => {
  assert.equal(getModule('chat').id, 'chat')
  assert.equal(getModule('nope'), undefined)
})

test('parseManifest 合法 JSON 校验通过并归一化', () => {
  const r = parseManifest(JSON.stringify({
    id: 'weather', name: '天气', version: '1.0.0', entry: 'bundle.js',
    windowSpec: { width: 480, height: 640, minWidth: 320, minHeight: 240, resizable: true, frame: true },
    singleton: true, channels: ['custom:weather'],
  }), '/home/u/modules/weather')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.manifest.id, 'weather')
    assert.equal(r.manifest.windowSpec.width, 480)
    assert.deepEqual(r.manifest.channels, ['custom:weather'])
  }
})

test('parseManifest 缺失必需字段（id/name/entry/windowSpec）拒绝', () => {
  const r = parseManifest(JSON.stringify({ id: 'x', name: 'y' }), '/tmp')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /entry|windowSpec/)
})

test('parseManifest 非法 JSON 拒绝', () => {
  const r = parseManifest('not json{{{', '/tmp')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /JSON/)
})
