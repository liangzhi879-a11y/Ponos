process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugToToolName, deriveInputSchema, visibilityOf, buildWorkflowTools } from '../kernel/dyntools.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

const wfYml = (id, expose) => `name: ${id}
version: 1.0.0
description: 演示工作流 ${id}
inputs:
  - { name: topic, type: string, required: true, description: 主题 }
  - { name: count, type: number, required: false }
nodes:
  - { id: start, type: start }
  - { id: t, type: template, template: "生成 {{inputs.topic}}" }
  - { id: e, type: end, config: { outputs: [{ name: result, selector: "{{t}}" }] } }
edges:
  - { id: e1, source: start, target: t }
  - { id: e2, source: t, target: e }
expose:
${expose}
`

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wf-tools-'))
  const wfRoot = join(root, 'workflows')
  const mk = (id, expose) => { mkdirSync(join(wfRoot, id), { recursive: true }); writeFileSync(join(wfRoot, id, 'workflow.yml'), wfYml(id, expose), 'utf-8') }
  mk('weekly-report', '  mode: public\n  tool_name: run_weekly_report')
  mk('private-one', '  mode: private')
  mk('bound-one', '  mode: bound\n  bind_agents: [material-writer]')
  return { root, wfRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('工具名与 schema 派生', () => {
  assert.equal(slugToToolName('weekly-report'), 'run_weekly_report')
  assert.equal(slugToToolName('My Flow.v2'), 'run_My_Flow_v2')
  const s = deriveInputSchema([{ name: 'topic', type: 'string', required: true, description: '主题' }, { name: 'count', type: 'number' }])
  assert.deepEqual(s.required, ['topic'])
  assert.equal(s.properties.topic.type, 'string')
  assert.equal(s.properties.count.type, 'number')
  assert.equal(s.additionalProperties, false)
})

test('可见性三态：private 不入池；bound 只对该 agent；public 全局', () => {
  const wfPub = { id: 'p', expose: { mode: 'public' } }
  const wfPri = { id: 'v', expose: { mode: 'private' } }
  const wfBound = { id: 'b', expose: { mode: 'bound', bind_agents: ['material-writer'] } }
  assert.equal(visibilityOf(wfPub, null), 'public')
  assert.equal(visibilityOf(wfPri, null), null)
  assert.equal(visibilityOf(wfBound, null), null)
  assert.equal(visibilityOf(wfBound, 'material-writer'), 'bound')
  assert.equal(visibilityOf(wfBound, 'table-expert'), null)
  assert.equal(visibilityOf({ id: 'x' }, null), null, '缺 expose 默认 private')
})

test('buildWorkflowTools：只输出当前会话可见的工具，且 run 走引擎', async () => {
  const { wfRoot, cleanup } = setup()
  try {
    const calls = []
    const engine = { run: async ({ id, inputs }) => { calls.push({ id, inputs }); return { ok: true, finalOutput: { result: `生成 ${inputs.topic}` } } } }
    const tools = buildWorkflowTools({ roots: [wfRoot], engine, agentId: null })
    assert.ok(tools.run_weekly_report, `public 工具应存在：${Object.keys(tools)}`)
    assert.equal(tools.run_private_one, undefined)
    assert.equal(tools.run_bound_one, undefined)
    const r = await tools.run_weekly_report.run({ topic: '周报' })
    assert.equal(r.isError, false)
    assert.match(String(r.content), /生成 周报/)
    assert.equal(calls[0].id, 'weekly-report')

    const t2 = buildWorkflowTools({ roots: [wfRoot], engine, agentId: 'material-writer' })
    assert.ok(t2.run_bound_one, '绑定 agent 应看到 bound 工具')
    assert.equal(t2.run_private_one, undefined, 'private 永远不入池')
  } finally { cleanup() }
})

test('tools.mjs 接线：动态工具进 toolSchemas 且可执行；未初始化时零影响', async () => {
  const registry = createToolRegistry({ cwd: process.cwd(), addDirs: [process.cwd()], skipPermissions: true })
  assert.ok(registry.toolNames.includes('Workflow'), '既有 Workflow 工具仍在')
  const dyn = { run_demo: { description: 'd', input_schema: { type: 'object' }, run: async () => ({ content: 'ok' }) } }
  const r2 = createToolRegistry({ cwd: process.cwd(), addDirs: [process.cwd()], skipPermissions: true, dynamicTools: () => dyn })
  assert.ok(r2.toolNames.includes('run_demo'), `动态工具应进 toolNames：${r2.toolNames.slice(-5)}`)
  const res = await r2.run({ name: 'run_demo', input: {} })
  assert.equal(res.content, 'ok')
})
