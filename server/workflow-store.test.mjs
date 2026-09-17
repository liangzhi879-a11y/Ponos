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

// 删除语义（2026-09-17 修复）：本体两种形态都要删得掉 + 引用要跟着清。
// 病灶 ①：内核 discoverWorkflows 认「平铺形态 <root>/<id>.yml(.yaml)」，而删除只删目录形态
//        ⇒ 平铺工作流删不掉、返回「工作流不存在」、文件原地不动，agent 照旧能调用它
//        （面板永不可见 → 用户既删不掉也看不见，只能手动去磁盘删）。
// 病灶 ②：`_bindings.json` 的 trusted / agents 引用不清理 ⇒ 删掉后**重建同名**工作流会继承
//        旧的信任凭据（信任是运行前授权凭据，属安全面，不该被继承）。
test('删除：平铺形态 <id>.yml/.yaml 同样删得掉（内核认它，删除也必须认）', () => {
  const { root, cleanup } = mk()
  try {
    writeWorkflowYml({ root, id: 'dir-one', yml: YML })
    writeFileSync(join(root, 'flat-yml.yml'), YML, 'utf-8')
    writeFileSync(join(root, 'flat-yaml.yaml'), YML, 'utf-8')
    // 平铺形态不在列表里（listWorkflowMetas 只扫目录）——这正是它变"幽灵"的原因
    assert.deepEqual(listWorkflowMetas({ root }).map((m) => m.id).sort(), ['dir-one'])
    const r1 = deleteWorkflow({ root, id: 'flat-yml' })
    assert.equal(r1.ok, true, '平铺 .yml 应删得掉（修复前返回「工作流不存在」）')
    assert.equal(r1.kind, 'flat')
    assert.equal(existsSync(join(root, 'flat-yml.yml')), false)
    const r2 = deleteWorkflow({ root, id: 'flat-yaml' })
    assert.equal(r2.ok, true, '平铺 .yaml 应删得掉（与内核扩展名判定同口径）')
    assert.equal(r2.kind, 'flat')
    assert.equal(existsSync(join(root, 'flat-yaml.yaml')), false)
    // 目录形态仍走原路径，kind 明确回报
    const r3 = deleteWorkflow({ root, id: 'dir-one' })
    assert.equal(r3.kind, 'dir')
    assert.equal(existsSync(join(root, 'dir-one')), false)
    // 不存在 → 仍回失败（不误报成功）
    assert.equal(deleteWorkflow({ root, id: 'nope' }).ok, false)
  } finally { cleanup() }
})

test('删除：同步清理 _bindings.json 的 trusted 与 agent 绑定（重建同名不继承信任）', () => {
  const { root, cleanup } = mk()
  try {
    writeWorkflowYml({ root, id: 'wf-a', yml: YML })
    writeWorkflowYml({ root, id: 'wf-b', yml: YML })
    writeBindings({ root, bindings: { agents: { 'table-expert': ['wf-a', 'wf-b'], 'x-agent': ['wf-a'] }, trusted: ['wf-a', 'wf-b'] } })
    const r = deleteWorkflow({ root, id: 'wf-a' })
    assert.equal(r.ok, true)
    assert.equal(r.bindingsPruned, true, '有引用时应回报已清理')
    const b = readBindings({ root })
    assert.deepEqual(b.trusted, ['wf-b'], '信任清单里的 wf-a 必须摘掉')
    assert.deepEqual(b.agents['table-expert'], ['wf-b'], 'agent 绑定的 wf-a 必须摘掉')
    assert.deepEqual(b.agents['x-agent'], [], '绑定被清空后保留空数组（结构不变，UI 无需特判）')
    // 无引用时不动盘（不新建/不改写 _bindings.json）
    const r2 = deleteWorkflow({ root, id: 'wf-b' })
    assert.equal(r2.bindingsPruned, true)
    assert.deepEqual(readBindings({ root }).trusted, [])
  } finally { cleanup() }
})

test('删除：无 _bindings.json 时不新建文件（不产生无谓副作用）', () => {
  const { root, cleanup } = mk()
  try {
    writeWorkflowYml({ root, id: 'solo', yml: YML })
    assert.equal(existsSync(join(root, '_bindings.json')), false)
    const r = deleteWorkflow({ root, id: 'solo' })
    assert.equal(r.ok, true)
    assert.equal(r.bindingsPruned, false, '无引用 → 未改盘')
    assert.equal(existsSync(join(root, '_bindings.json')), false, '不得凭空新建绑定文件')
    // 损坏的 _bindings.json 不阻断本体删除（尽力而为）
    writeWorkflowYml({ root, id: 'solo2', yml: YML })
    writeFileSync(join(root, '_bindings.json'), '{ 这不是 JSON', 'utf-8')
    const r2 = deleteWorkflow({ root, id: 'solo2' })
    assert.equal(r2.ok, true, '绑定文件损坏也必须删掉本体')
    assert.equal(existsSync(join(root, 'solo2')), false)
  } finally { cleanup() }
})
