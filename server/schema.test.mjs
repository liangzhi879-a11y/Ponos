// server/schema.test.mjs —— P6 D2-1 settings schema 版本化（迁移链 + 高于版本拒绝）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '../version.mjs'
import { loadSettings, migrateSettings, validateSettings, diffFromDefault, SETTINGS_DEFAULTS } from '../kernel/settings.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ponos-schema-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('SCHEMA_VERSION 单一数据源：version.mjs 导出且当前为 1', () => {
  assert.equal(SCHEMA_VERSION, 1)
})

test('migrateSettings：无版本字段 → v0 → v1 迁移链', () => {
  const r = migrateSettings({ model: 'm1' })
  assert.equal(r.from, 0)
  assert.equal(r.to, 1)
  assert.equal(r.migrated, true)
  assert.equal(r.data.schemaVersion, 1)
  assert.equal(r.data.model, 'm1')
})

test('migrateSettings：已是当前版本 → 原样返回不迁移', () => {
  const r = migrateSettings({ schemaVersion: 1, model: 'm1' })
  assert.equal(r.migrated, false)
  assert.equal(r.to, 1)
})

test('validateSettings：高于当前版本 → 拒绝并提示升级', () => {
  const r = validateSettings({ schemaVersion: 99 })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('高于内核支持'))
})

test('loadSettings：无版本 settings 文件 → 自动迁移 + schema 信息', () => {
  const configDir = join(tmp, 'cfg')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ model: 'old-model' }), 'utf-8')
  const r = loadSettings({ configDir, cwd: join(tmp, 'nope'), local: {} })
  assert.equal(r.schema.version, 1)
  assert.equal(r.schema.migrated, true)
  assert.equal(r.schema.error, null)
  assert.equal(r.merged.model, 'old-model')
})

test('loadSettings：高于当前版本 → error 标注（merged 仍可用，拒绝硬失败）', () => {
  const configDir = join(tmp, 'cfg2')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ schemaVersion: 99 }), 'utf-8')
  const r = loadSettings({ configDir, cwd: join(tmp, 'nope'), local: {} })
  assert.ok(r.schema.error.includes('高于内核支持'))
})

test('diffFromDefault：默认值 → 空；非默认 → 标注漂移项', () => {
  assert.deepEqual(diffFromDefault({ ...SETTINGS_DEFAULTS }), [])
  const r = diffFromDefault({ ...SETTINGS_DEFAULTS, model: 'custom-model' })
  assert.equal(r.length, 1)
  assert.equal(r[0].key, 'model')
  assert.equal(r[0].value, 'custom-model')
  const hooks = diffFromDefault({ ...SETTINGS_DEFAULTS, hooks: [{ event: 'sessionStart' }] })
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].key, 'hooks')
})
