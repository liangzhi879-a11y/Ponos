process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverUserAgents } from '../kernel/agents.mjs'
import { buildWorkflowTools } from '../kernel/dyntools.mjs'

test('agent frontmatter workflows 字段被解析', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-agent-'))
  try {
    writeFileSync(join(root, 'material-writer.md'), `---
name: material-writer
description: 材料撰写专家
tools: Read, Write
skills: gxtz-rd-report
workflows: weekly-report, report-review
---
你是材料撰写专家。`, 'utf-8')
    const agents = discoverUserAgents({ root })
    const a = agents.find((x) => x.name === 'material-writer')
    assert.ok(a, `应发现 agent：${JSON.stringify(agents.map((x) => x.name))}`)
    assert.deepEqual(a.workflows, ['weekly-report', 'report-review'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('绑定生效：同一工作流对绑定 agent 可见、对其他 agent 不可见', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-bind-'))
  const wfRoot = join(root, 'workflows')
  try {
    mkdirSync(join(wfRoot, 'bound-one'), { recursive: true })
    writeFileSync(join(wfRoot, 'bound-one', 'workflow.yml'), `name: bound-one
description: 绑定演示
nodes:
  - { id: s, type: start }
  - { id: t, type: template, template: hi }
  - { id: e, type: end }
edges:
  - { id: e1, source: s, target: t }
  - { id: e2, source: t, target: e }
expose: { mode: bound, bind_agents: [material-writer] }
`, 'utf-8')
    const engine = { run: async () => ({ ok: true, finalOutput: { result: 'hi' }, status: 'completed', steps: 2 }) }
    assert.ok(buildWorkflowTools({ roots: [wfRoot], engine, agentId: 'material-writer' }).run_bound_one)
    assert.equal(buildWorkflowTools({ roots: [wfRoot], engine, agentId: 'table-expert' }).run_bound_one, undefined)
    assert.equal(buildWorkflowTools({ roots: [wfRoot], engine, agentId: null }).run_bound_one, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
