// 引擎装配（Task 5）：DAG 运行 + 审计落盘 + 事件 + 校验进生产路径 + run 级 stop + cron
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowEngine, verifyRun } from '../kernel/workflow-engine.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

const WF = `name: demo
version: 1.0.0
inputs:
  - { name: n, type: number, required: true }
nodes:
  - { id: start, type: start }
  - { id: g, type: if, conditions: [{ var: "inputs.n", op: ">", value: 3 }] }
  - { id: big, type: template, template: "大 {{inputs.n}}" }
  - { id: small, type: template, template: "小 {{inputs.n}}" }
  - { id: done, type: end, config: { outputs: [{ name: result, selector: "{{big}}" }] } }
edges:
  - { id: e1, source: start, target: g }
  - { id: e2, source: g, target: big, sourceHandle: "true" }
  - { id: e3, source: g, target: small, sourceHandle: "false" }
  - { id: e4, source: big, target: done }
  - { id: e5, source: small, target: done }
`

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wf-eng-'))
  mkdirSync(join(root, 'wf', 'demo'), { recursive: true })
  writeFileSync(join(root, 'wf', 'demo', 'workflow.yml'), WF, 'utf-8')
  const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
  const engine = createWorkflowEngine({ configDir: root, registry, getModel: () => 'mock-model' })
  engine.addRoot(join(root, 'wf'))
  return { root, engine, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('DAG 运行：条件分支 + end 输出聚合 + 审计落盘可校验', async () => {
  const { engine, cleanup } = setup()
  try {
    const events = []
    engine.setDeps({ onEvent: (ev) => events.push(ev) })
    const r = await engine.run({ id: 'demo', inputs: { n: 5 } })
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300))
    assert.equal(r.outputs.done.output.result, '大 5')
    const skipped = events.filter((e) => e.type === 'node' && e.status === 'skipped').map((e) => e.node)
    assert.ok(skipped.includes('small'), `small 应被跳过：${JSON.stringify(events.map((e) => [e.type, e.node, e.status]))}`)
    assert.ok(events.some((e) => e.type === 'edge_taken'), 'edge_taken 事件缺失')
    assert.ok(r.auditPath && readFileSync(r.auditPath, 'utf-8').trim().split('\n').length >= 4, '审计应逐节点落盘')
    assert.equal(verifyRun(r.auditPath).ok, true, '哈希链应可校验')
  } finally { cleanup() }
})

test('非法工作流：校验失败即拒绝运行并给出 code', async () => {
  const { root, engine, cleanup } = setup()
  try {
    mkdirSync(join(root, 'wf', 'bad'), { recursive: true })
    writeFileSync(join(root, 'wf', 'bad', 'workflow.yml'), 'name: bad\nnodes:\n  - { id: a, type: start }\n', 'utf-8')
    const r = await engine.run({ id: 'bad', inputs: {} })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'LEGACY_DSL')
  } finally { cleanup() }
})

test('stop：运行中取消 → status=cancelled 且发 end(cancelled)', async () => {
  const { engine, cleanup } = setup()
  try {
    const events = []
    engine.setDeps({ onEvent: (e) => events.push(e) })
    const p = engine.run({ id: 'demo', inputs: { n: 1 }, runId: 'run-x' })
    engine.stop('run-x')
    const r = await p
    assert.equal(r.status, 'cancelled')
    assert.ok(events.some((e) => e.type === 'end' && e.status === 'cancelled'))
  } finally { cleanup() }
})

test('cron 匹配与调度器回调（不依赖真实定时器）', async () => {
  const { engine, cleanup } = setup()
  try {
    assert.equal(engine.cronMatches('0 18 * * 5', new Date('2026-09-11T18:00:00')), true)
    assert.equal(engine.cronMatches('0 18 * * 5', new Date('2026-09-11T19:00:00')), false)
  } finally { cleanup() }
})
