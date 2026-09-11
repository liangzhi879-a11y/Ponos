import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWorkflowMeta, listWorkflowMetas, writeWorkflowYml, listVersions, rollbackVersion,
  createWorkflow, deleteWorkflow, duplicateWorkflow, exportBundle, importBundle, readBindings, writeBindings,
  recentRuns, assertSafeId,
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

// —— 返工轮 1 新增断言 ——

// 含 inputs: 里的 type: string、prompt 正文里的 "type: foo"、subagent_type、以及行内字符串字面量里的 type:
const ANCHOR_YML = `name: 锚定
triggers: 甲, 乙，丙
inputs:
  - {name: q, type: string, required: true}
nodes:
  - { id: n1, type: agent, label: "用 type: end 表示结束", config: { inputs: [{name:q,type:string}], prompt: "正文里的 type: foo 不算" } }
  - id: n2
    type: loop
    label: 循环
    config:
      prompt: |
        这里 type: fake 只是模板正文
        subagent_type: implementer
  - { id: n3, type: end }
edges:
  - { id: e1, source: n1, target: n2 }
  - { id: e2, source: n2, target: n3 }
`

test('C1 nodeTypes 锚定 nodes 块：inputs/模板正文/config 里的 type: 不误报', () => {
  const { root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'anchor', yml: ANCHOR_YML })
    const { bundle } = exportBundle({ root, id: 'anchor' })
    assert.deepEqual(bundle.manifest.nodeTypes, ['agent', 'loop', 'end'])
    for (const bad of ['string', 'foo', 'fake', 'implementer', 'agent_type', 'subagent_type']) {
      assert.ok(!bundle.manifest.nodeTypes.includes(bad), `nodeTypes 不得包含 ${bad}`)
    }
  } finally { cleanup() }
})

test('I1 triggers：逗号标量（CSV）与块列表均可解析', () => {
  assert.deepEqual(parseWorkflowMeta(ANCHOR_YML).triggers, ['甲', '乙', '丙'])
  assert.deepEqual(parseWorkflowMeta('name: x\ntriggers:\n  - a\n  - b\nnodes:\n  - { id: s, type: start }\n').triggers, ['a', 'b'])
  assert.deepEqual(parseWorkflowMeta('name: x\ntriggers: [a, b]\nnodes:\n  - { id: s, type: start }\n').triggers, ['a', 'b'])
  assert.deepEqual(parseWorkflowMeta('name: x\nnodes:\n  - { id: s, type: start }\n').triggers, [])
})

test('I2 recentRuns：缺 runsRoot 不抛，目录不存在返回空', () => {
  assert.deepEqual(recentRuns({ id: 'a' }), [])
  assert.deepEqual(recentRuns({ runsRoot: '', id: 'a' }), [])
  const { home, cleanup } = mk()
  try {
    const runsRoot = join(home, 'workflow-runs')
    assert.deepEqual(recentRuns({ runsRoot, id: 'a' }), [])
    mkdirSync(join(runsRoot, 'a'), { recursive: true })
    writeFileSync(join(runsRoot, 'a', '2026-09-11T10-00-00-000Z-run1.jsonl'), '{"status":"ok"}\n')
    const runs = recentRuns({ runsRoot, id: 'a' })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'ok')
    assert.equal(runs[0].steps, 1)
  } finally { cleanup() }
})

test('I3 rollbackVersion：ts 白名单校验挡住路径穿越', () => {
  const { root, cleanup } = mk()
  try {
    createWorkflow({ root, id: 'demo', yml: YML })
    writeWorkflowYml({ root, id: 'demo', yml: YML.replace('1.0.0', '2.0.0') })
    assert.throws(() => rollbackVersion({ root, id: 'demo', ts: '../../..' }), /非法版本号/)
    assert.throws(() => rollbackVersion({ root, id: 'demo', ts: '..' }), /非法版本号/)
    assert.throws(() => rollbackVersion({ root, id: 'demo', ts: 'a/b' }), /非法版本号/)
    const vers = listVersions({ root, id: 'demo' })
    assert.equal(rollbackVersion({ root, id: 'demo', ts: vers[0].ts }).ok, true)
  } finally { cleanup() }
})

test('I4 assertSafeId：Windows 设备名/尾点/尾空格被拒，非设备名前缀放行', () => {
  for (const bad of ['nul', 'CON', 'aux', 'prn', 'com1', 'LPT9', 'nul.yml', 'a.']) {
    assert.throws(() => assertSafeId(bad), /非法工作流 id/, `应拒绝 ${bad}`)
  }
  assert.throws(() => assertSafeId('a '), /非法工作流 id/)
  assert.equal(assertSafeId('console'), 'console') // 不误伤 con 前缀
  assert.equal(assertSafeId('spec-dev_v2'), 'spec-dev_v2')
  const { root, cleanup } = mk()
  try { assert.throws(() => createWorkflow({ root, id: 'com1', yml: YML }), /非法工作流 id/) } finally { cleanup() }
})
