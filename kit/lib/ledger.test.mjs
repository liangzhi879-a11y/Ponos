// kit/lib/ledger.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseByLocator, keyOfVersion, discoverVersionConsts, syncVersions, readVersions } from './ledger.mjs'

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

test('parseByLocator(const)：字符串与数字都能解析', () => {
  const root = fixture({
    'a.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const INDEX_VERSION = 4\n",
  })
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'APP_VERSION' } }).value, 'dev 3.0.0')
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'INDEX_VERSION' } }).value, 4)
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'NOPE' } }), null)
})

test('parseByLocator(json)：读 package.json 的 version 字段', () => {
  const root = fixture({ 'p.json': '{ "name": "x", "version": "2.8.0" }' })
  assert.equal(parseByLocator({ root, file: 'p.json', locator: { kind: 'json', path: 'version' } }).value, '2.8.0')
})

test('parseByLocator：行尾注释与分号不干扰取值', () => {
  const root = fixture({ 'a.mjs': "const VAULT_VERSION = 1 // 密码库格式版本\nconst X_VERSION = 'a';\n" })
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'VAULT_VERSION' } }).value, 1)
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'X_VERSION' } }).value, 'a')
})

test('keyOfVersion = id@file（同一常量名出现在两个文件时必须可区分）', () => {
  assert.equal(keyOfVersion({ id: 'SCHEMA_VERSION', file: 'kernel/loop.mjs' }), 'SCHEMA_VERSION@kernel/loop.mjs')
  assert.notEqual(
    keyOfVersion({ id: 'SCHEMA_VERSION', file: 'kernel/loop.mjs' }),
    keyOfVersion({ id: 'SCHEMA_VERSION', file: 'server/workflow-store.mjs' }),
  )
})

test('discoverVersionConsts：只认以 VERSION 结尾的全大写常量，跳过测试文件', () => {
  const root = fixture({
    'k/a.mjs': "export const INDEX_VERSION = 4\nexport const OTHER = 1\n",
    'k/b.test.mjs': 'export const TEST_VERSION = 9\n',
  })
  const found = discoverVersionConsts({ root, files: ['k/a.mjs', 'k/b.test.mjs'] })
  assert.deepEqual(found.map((e) => e.id), ['INDEX_VERSION'])
})

test('syncVersions：首次 sync 建立台账；二次 sync 保留人工字段、只更新 value/line', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'k/c.mjs': 'export const INDEX_VERSION = 4\n',
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json']
  const first = syncVersions({ root, files })
  assert.equal(first.data.version, 1)
  assert.equal(first.data.lines.length, 4)
  assert.equal(first.data.contracts.length, 1)

  // 人工加字段后再 sync，必须保留
  const data = readVersions({ root })
  data.contracts[0].migrationNote = '人工写的迁移说明'
  data.contracts[0].consumers = ['src/mirror.ts']
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  // 改宿主文件的值 + 搬走一行，模拟真实漂移
  writeFileSync(join(root, 'k/c.mjs'), '\n\nexport const INDEX_VERSION = 5\n')
  const second = syncVersions({ root, files })
  const entry = second.data.contracts.find((e) => e.id === 'INDEX_VERSION')
  assert.equal(entry.value, 5)
  assert.equal(entry.line, 3)
  assert.equal(entry.migrationNote, '人工写的迁移说明')
  assert.deepEqual(entry.consumers, ['src/mirror.ts'])
})

test('syncVersions：lines 分区的人工字段（note/consumers/migrationNote）也必须被继承', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'public/skills.json']
  syncVersions({ root, files })

  // 人工在 lines 条目上写说明（契约允许：note / consumers / migrationNote）
  const data = readVersions({ root })
  const app = data.lines.find((e) => e.id === 'APP_VERSION')
  app.note = '人工写的说明'
  app.consumers = ['electron/main.cjs']
  data.lines.find((e) => e.id === 'KB_SCHEMA_VERSION').migrationNote = '人工写的迁移说明'
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  // 宿主文件同时漂移（版本值真的变了），迫使 sync 重建 lines
  writeFileSync(join(root, 'version.mjs'),
    "export const APP_VERSION = 'dev 4.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 2\n")
  const second = syncVersions({ root, files })
  const app2 = second.data.lines.find((e) => e.id === 'APP_VERSION')
  assert.equal(app2.note, '人工写的说明')
  assert.deepEqual(app2.consumers, ['electron/main.cjs'])
  assert.equal(second.data.lines.find((e) => e.id === 'KB_SCHEMA_VERSION').migrationNote, '人工写的迁移说明')
  // 白名单继承的前提是"不把陈旧 value 带回来"：value 必须是本次从源文件解析出来的
  assert.equal(app2.value, 'dev 4.0.0')
  assert.equal(second.data.lines.find((e) => e.id === 'KB_SCHEMA_VERSION').value, 2)
})

test('syncVersions：lines 的 value 是源文件真源，人工改不动（会被纠正回来）', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'public/skills.json']
  syncVersions({ root, files })

  const data = readVersions({ root })
  data.lines.find((e) => e.id === 'APP_VERSION').value = '9.9.9-人工篡改'
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  const { data: corrected } = syncVersions({ root, files })
  const app = corrected.lines.find((e) => e.id === 'APP_VERSION')
  assert.equal(app.value, 'dev 3.0.0')            // 正向：等于源文件真实值
  assert.notEqual(app.value, '9.9.9-人工篡改')     // 反向：人工篡改不留存
})

test('syncVersions：exclude 的人工编辑（新增排除项 + note）同样被保留', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'k/c.mjs': "export const UPSTREAM_VERSION = '2023-06-01'\nexport const INDEX_VERSION = 4\n",
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json']
  const first = syncVersions({ root, files })
  assert.equal(first.data.contracts.some((e) => e.id === 'UPSTREAM_VERSION'), true)

  // 人工把它登记为排除项（附人工理由/说明）
  const data = readVersions({ root })
  data.exclude.push({ id: 'UPSTREAM_VERSION', file: 'k/c.mjs', reason: '上游协议版本', note: '人工加的说明' })
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  const second = syncVersions({ root, files })
  assert.equal(second.data.contracts.some((e) => e.id === 'UPSTREAM_VERSION'), false)
  assert.deepEqual(second.data.exclude.find((e) => e.id === 'UPSTREAM_VERSION'),
    { id: 'UPSTREAM_VERSION', file: 'k/c.mjs', reason: '上游协议版本', note: '人工加的说明' })
})

test('syncVersions：exclude 列表里的常量不进台账', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'k/c.mjs': "export const ANTHROPIC_VERSION = '2023-06-01'\nexport const INDEX_VERSION = 4\n",
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json']
  const { data } = syncVersions({ root, files })
  assert.equal(data.contracts.some((e) => e.id === 'ANTHROPIC_VERSION'), false)
  assert.equal(data.contracts.some((e) => e.id === 'INDEX_VERSION'), true)
})
