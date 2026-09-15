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

test('绑定链路：agent.md 的 workflows 字段（写入侧格式）→ 该 agent 名下 bound 工作流工具可见', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-chain-'))
  const wfRoot = join(root, 'workflows')
  const agentsRoot = join(root, 'agents')
  try {
    // 两个 bound 工作流，分别绑到不同 agent
    for (const [id, owner] of [['weekly-report', 'weekly-writer'], ['other-wf', 'other-agent']]) {
      mkdirSync(join(wfRoot, id), { recursive: true })
      writeFileSync(join(wfRoot, id, 'workflow.yml'), `name: ${id}
description: 绑定演示
nodes:
  - { id: s, type: start }
  - { id: t, type: template, template: hi }
  - { id: e, type: end }
edges:
  - { id: e1, source: s, target: t }
  - { id: e2, source: t, target: e }
expose: { mode: bound, bind_agents: [${owner}] }
`, 'utf-8')
    }
    mkdirSync(agentsRoot, { recursive: true })
    // 写入侧格式（electron/main.cjs agents:sync）：`workflows: id1, id2`（逗号 + 空格）
    writeFileSync(join(agentsRoot, 'weekly-writer.md'), `---
name: weekly-writer
description: 周报撰写
tools: Read, Write
workflows: weekly-report
---
你是周报撰写者。`, 'utf-8')
    writeFileSync(join(agentsRoot, 'other-agent.md'), `---
name: other-agent
description: 其他 agent
workflows: other-wf
---
其他 agent。`, 'utf-8')

    const agents = discoverUserAgents({ root: agentsRoot })
    const writer = agents.find((x) => x.name === 'weekly-writer')
    const other = agents.find((x) => x.name === 'other-agent')
    assert.deepEqual(writer?.workflows, ['weekly-report'])
    assert.deepEqual(other?.workflows, ['other-wf'])

    const engine = { run: async () => ({ ok: true, finalOutput: { result: 'hi' }, status: 'completed', steps: 2 }) }
    // 可见性随 agent 名变化：各自只看见自己绑定的那个工作流工具
    const tWriter = buildWorkflowTools({ roots: [wfRoot], engine, agentId: writer.name })
    assert.ok(tWriter.run_weekly_report, 'weekly-writer 应看见 run_weekly_report')
    assert.equal(tWriter.run_other_wf, undefined)
    const tOther = buildWorkflowTools({ roots: [wfRoot], engine, agentId: other.name })
    assert.ok(tOther.run_other_wf, 'other-agent 应看见 run_other_wf')
    assert.equal(tOther.run_weekly_report, undefined)
    assert.equal(buildWorkflowTools({ roots: [wfRoot], engine, agentId: null }).run_weekly_report, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
