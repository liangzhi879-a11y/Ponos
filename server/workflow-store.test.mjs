import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWorkflowMeta, listWorkflowMetas, writeWorkflowYml, listVersions, rollbackVersion,
  createWorkflow, deleteWorkflow, duplicateWorkflow, exportBundle, importBundle, readBindings, writeBindings,
} from './workflow-store.mjs'

const YML = `name: 周报生成
description: 拉数并生成周报
version: 1.0.0
triggers: [周报, weekly]
trigger_config: { manual: true, webhook: false }
nodes:
  - { id: start, type: start }
  - { id: t, type: template, template: hi }
  - { id: e, type: end }
edges:
  - { id: e1, source: start, target: t }
  - { id: e2, source: t, target: e }
expose: { mode: public, tool_name: run_weekly }
`

function mk() {
  const home = mkdtempSync(join(tmpdir(), 'wf-store-'))
  const root = join(home, 'workflows')
  mkdirSync(root, { recursive: true })
  return { home, root, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('parseWorkflowMeta：列表所需的元数据齐全', () => {
  const m = parseWorkflowMeta(YML)
  assert.equal(m.name, '周报生成')
  assert.equal(m.version, '1.0.0')
  assert.deepEqual(m.triggers, ['周报', 'weekly'])
  assert.equal(m.nodeCount, 3)
  assert.equal(m.edgeCount, 2)
  assert.equal(m.legacy, false)
  assert.equal(m.expose.mode, 'public')
})

test('legacy 识别：无 edges 的旧格式被标记', () => {
  const m = parseWorkflowMeta('name: old\nnodes:\n  - { id: s, type: start, next: null }\n')
  assert.equal(m.legacy, true)
})

test('写入即快照版本；rollback 恢复上一版', () => {
  const { root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'demo', yml: YML })
    const v2 = YML.replace('version: 1.0.0', 'version: 2.0.0')
    writeWorkflowYml({ root, id: 'demo', yml: v2 })
    const vers = listVersions({ root, id: 'demo' })
    assert.ok(vers.length >= 1, `应有版本快照：${JSON.stringify(vers)}`)
    const r = rollbackVersion({ root, id: 'demo', ts: vers[0].ts })
    assert.equal(r.ok, true)
    assert.match(readFileSync(join(root, 'demo', 'workflow.yml'), 'utf-8'), /version: 1\.0\.0/)
  } finally { cleanup() }
})

test('list 元数据含 id 与最近运行（runsRoot 空时 lastRun 为 null）', () => {
  const { home, root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'demo', yml: YML })
    const list = listWorkflowMetas({ root, runsRoot: join(home, 'workflow-runs') })
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'demo')
    assert.equal(list[0].name, '周报生成')
    assert.equal(list[0].lastRun, null)
    assert.equal(list[0].valid, true)
  } finally { cleanup() }
})

test('duplicate / delete / 版本保留上限 20', () => {
  const { root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'a', yml: YML })
    duplicateWorkflow({ root, fromId: 'a', toId: 'b' })
    assert.ok(existsSync(join(root, 'b', 'workflow.yml')))
    for (let i = 2; i <= 25; i++) writeWorkflowYml({ root, id: 'a', yml: YML.replace('1.0.0', `1.0.${i}`) })
    assert.ok(readdirSync(join(root, 'a', 'versions')).length <= 20, '版本快照应保留最近 20')
    deleteWorkflow({ root, id: 'b' })
    assert.equal(existsSync(join(root, 'b')), false)
  } finally { cleanup() }
})

test('导出/导入往返；导入 schemaVersion 不符时拒绝', () => {
  const { root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'demo', yml: YML })
    const { bundle, filename } = exportBundle({ root, id: 'demo' })
    assert.match(filename, /\.yfwflow$/)
    assert.equal(bundle.format, 'yfworking-workflow')
    const r = importBundle({ root, bundle: { ...bundle, workflow: bundle.workflow.replace('demo', 'demo2') }, id: 'demo2' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(existsSync(join(root, 'demo2', 'workflow.yml')))
    const bad = importBundle({ root, bundle: { ...bundle, schemaVersion: 99 }, id: 'demo3' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /schemaVersion/)
  } finally { cleanup() }
})

test('id 校验：非法字符/路径穿越/保留字被拒', () => {
  const { root, cleanup } = mk()
  try {
    assert.throws(() => createWorkflow({ root, id: '../evil', yml: YML }), /非法工作流 id/)
    assert.throws(() => createWorkflow({ root, id: 'run', yml: YML }), /保留字/)
    assert.throws(() => createWorkflow({ root, id: 'verify', yml: YML }), /保留字/)
  } finally { cleanup() }
})

test('绑定与信任态读写', () => {
  const { root, cleanup } = mk()
  try {
    assert.deepEqual(readBindings({ root }), { agents: {}, trusted: [] })
    writeBindings({ root, bindings: { agents: { 'material-writer': ['demo'] }, trusted: ['demo'] } })
    assert.deepEqual(readBindings({ root }).agents['material-writer'], ['demo'])
  } finally { cleanup() }
})
