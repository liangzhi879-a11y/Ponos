process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugToToolName, shortHash, deriveInputSchema, visibilityOf, buildWorkflowTools, listVisibleWorkflows } from '../kernel/dyntools.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { createWorkflowEngine } from '../kernel/workflow-engine.mjs'
import { composeSystemPrompt } from '../kernel/prompt.mjs'

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

test('CJK id 去重（I-1）：两个中文目录 → 两个不同工具名且都能调用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-cjk-'))
  const wfRoot = join(root, 'workflows')
  const mk = (id, expose) => { mkdirSync(join(wfRoot, id), { recursive: true }); writeFileSync(join(wfRoot, id, 'workflow.yml'), wfYml(id, expose), 'utf-8') }
  try {
    mk('周报', '  mode: public')
    mk('月报', '  mode: public')
    assert.match(slugToToolName('周报'), /^run_workflow_[0-9a-f]{6}$/)
    assert.notEqual(slugToToolName('周报'), slugToToolName('月报'))
    const calls = []
    const engine = { run: async ({ id, inputs }) => { calls.push(id); return { ok: true, finalOutput: { id, topic: inputs.topic } } } }
    const tools = buildWorkflowTools({ roots: [wfRoot], engine, agentId: null })
    const names = Object.keys(tools)
    assert.equal(names.length, 2, `两个中文工作流应各自成工具：${names}`)
    assert.notEqual(names[0], names[1])
    for (const n of names) {
      const r = await tools[n].run({ topic: 't' })
      assert.equal(r.isError, false, `${n} 应可调用：${r.content}`)
    }
    assert.deepEqual(calls.sort(), ['月报', '周报'].sort(), `run 应命中各自工作流：${calls}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('同名工具不覆盖（I-1）：显式 tool_name 冲突 → 追加哈希后缀 + 告警，二者都在', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-dup-'))
  const wfRoot = join(root, 'workflows')
  const mk = (id, expose) => { mkdirSync(join(wfRoot, id), { recursive: true }); writeFileSync(join(wfRoot, id, 'workflow.yml'), wfYml(id, expose), 'utf-8') }
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  try {
    mk('dup-a', '  mode: public\n  tool_name: run_same')
    mk('dup-b', '  mode: public\n  tool_name: run_same')
    const engine = { run: async ({ id }) => ({ ok: true, finalOutput: { id } }) }
    const tools = buildWorkflowTools({ roots: [wfRoot], engine, agentId: null })
    assert.ok(tools.run_same, '先注册者保留原名')
    const alt = Object.keys(tools).filter((n) => n.startsWith('run_same_') && n !== 'run_same')
    assert.equal(alt.length, 1, `冲突者应追加后缀：${Object.keys(tools)}`)
    assert.equal(tools.nameConflicts.length, 1)
    assert.equal(tools.nameConflicts[0].resolved, alt[0])
    assert.ok(warns.some((w) => w.includes('工具名冲突')), `应有告警：${warns}`)
    assert.deepEqual(Object.keys(tools).sort(), ['run_same', alt[0]].sort())
    assert.equal(Object.keys(tools).includes('nameConflicts'), false, '冲突明细不得进工具表视图')
  } finally { console.warn = origWarn; rmSync(root, { recursive: true, force: true }) }
})

test('public 截断稳定顺序（I-2）：按 id 字节序取前 N（不受 locale 影响）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-limit-'))
  const wfRoot = join(root, 'workflows')
  try {
    for (const id of ['zzz-3', '周报', 'aaa-1', 'mmm-2']) {
      mkdirSync(join(wfRoot, id), { recursive: true })
      writeFileSync(join(wfRoot, id, 'workflow.yml'), wfYml(id, '  mode: public'), 'utf-8')
    }
    const engine = { run: async () => ({ ok: true, finalOutput: {} }) }
    const tools = buildWorkflowTools({ roots: [wfRoot], engine, publicLimit: 2 })
    const ids = listVisibleWorkflows({ roots: [wfRoot], publicLimit: 2 }).map((w) => w.id)
    // 字节序：'aaa-1'(0x61) < 'mmm-2'(0x6d) < 'zzz-3'(0x7a) < '周报'(0x5468)；localeCompare 会把中文排最前
    assert.deepEqual(ids, ['aaa-1', 'mmm-2'], `截断应按字节序稳定：${ids}`)
    assert.equal(Object.keys(tools).length, 2)
    const toolsAll = buildWorkflowTools({ roots: [wfRoot], engine })
    assert.equal(Object.keys(toolsAll).length, 4, '缺省上限 20 不截断')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// 【2026-09-18 P0-4】工具池输出顺序与 updatedAt 解耦。
// 病灶：orderPublics 的"最近编辑优先"是**截断优先级**（谁进池，产品语义），但先前它同时
// 决定了工具数组的输出次序 ⇒ 任一工作流被编辑（updatedAt/保存时间变）就翻转 tools 次序，
// 前缀缓存逐字节匹配 ⇒ tools 整段失效（实测代价见 docs/2026-09-18-前缀缓存命中率优化方案.md）。
test('工具池输出顺序（P0-4）：按 id 稳定，编辑工作流不翻转次序；截断仍按最近优先', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-order-'))
  const wfRoot = join(root, 'workflows')
  // updateAt 顺序与 id 顺序**故意相反**：id 最小的最旧、id 最大的最新
  const mk = (id, updatedAt) => {
    mkdirSync(join(wfRoot, id), { recursive: true })
    writeFileSync(join(wfRoot, id, 'workflow.yml'), `${wfYml(id, '  mode: public')}updatedAt: ${updatedAt}\n`, 'utf-8')
  }
  const engine = { run: async () => ({ ok: true, finalOutput: {} }) }
  try {
    mk('aaa-1', '2026-01-01T00:00:00Z')
    mk('bbb-2', '2026-06-01T00:00:00Z')
    mk('ccc-3', '2026-12-01T00:00:00Z')

    // ① 输出顺序 = id 字节序（与 updatedAt 无关）
    const t1 = buildWorkflowTools({ roots: [wfRoot], engine })
    assert.deepEqual(Object.keys(t1), ['run_aaa_1', 'run_bbb_2', 'run_ccc_3'], `输出应按 id 稳定：${Object.keys(t1)}`)
    // ② 钉死"不再按 updatedAt 降序输出"（旧实现会得到 ccc/bbb/aaa）
    assert.notDeepEqual(Object.keys(t1), ['run_ccc_3', 'run_bbb_2', 'run_aaa_1'])

    // ③ 编辑最旧的那个（updatedAt 变最新）⇒ 顺序必须不变，否则工具前缀整段失效
    mk('aaa-1', '2027-01-01T00:00:00Z')
    const t2 = buildWorkflowTools({ roots: [wfRoot], engine })
    assert.deepEqual(Object.keys(t2), Object.keys(t1), '编辑任一工作流不得翻转工具顺序')

    // ④ 截断优先级是产品语义，必须保留：最近编辑者优先入池
    const t3 = buildWorkflowTools({ roots: [wfRoot], engine, publicLimit: 1 })
    assert.deepEqual(Object.keys(t3), ['run_aaa_1'], 'publicLimit 截断仍按"最近编辑优先"')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('提示词清单可见性口径（I-3）：private / 未命中 bound / 超限 public 不出现在清单', () => {
  const { wfRoot, cleanup } = setup()
  const engine = { run: async () => ({ ok: true, finalOutput: {} }) }
  try {
    const pub = listVisibleWorkflows({ roots: [wfRoot], agentId: null })
    const ids = pub.map((w) => w.id)
    assert.deepEqual(ids, ['weekly-report'], `主会话只见 public：${ids}`)
    assert.ok(pub[0].description && pub[0].name, '清单条目需带 name/description 供提示词渲染')

    const bound = listVisibleWorkflows({ roots: [wfRoot], agentId: 'material-writer' }).map((w) => w.id)
    assert.ok(bound.includes('bound-one') && !bound.includes('private-one'), `bound 命中应入清单：${bound}`)
    assert.equal(listVisibleWorkflows({ roots: [wfRoot], agentId: null, publicLimit: 0 }).length, 0, '超限 public 不入清单')
    assert.deepEqual(listVisibleWorkflows({ roots: [wfRoot], agentId: null }), listVisibleWorkflows({ roots: [wfRoot], agentId: null }), '清单稳定可重复')
    assert.deepEqual(Object.keys(buildWorkflowTools({ roots: [wfRoot], engine, agentId: null })).length, listVisibleWorkflows({ roots: [wfRoot], agentId: null }).length, '清单与工具池同一口径')
    // 端到端注入面：用可见清单渲染系统提示词，private 的名称/描述不得出现
    const prompt = composeSystemPrompt({ toolNames: [], agents: [], subagents: [], skills: [], workflows: pub })
    assert.match(prompt, /weekly-report/)
    assert.equal(prompt.includes('private-one'), false, 'private 不得进提示词')
    assert.equal(prompt.includes('bound-one'), false, '未命中 bound 不得进提示词')
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

// 终审修复 M3：通用 Workflow 工具是「可见性后门」——隐藏具名工具后仍能靠 id 直接执行。
// 闸门口径与工具池同源（engine.canRun → dyntools.visibilityOf + legacy 拒绝）。
test('M3：通用 Workflow 工具不得绕过可见性（private/legacy 拒绝且不执行）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-gate-'))
  try {
    const wfRoot = join(root, 'workflows')
    const mk = (id, expose) => { mkdirSync(join(wfRoot, id), { recursive: true }); writeFileSync(join(wfRoot, id, 'workflow.yml'), wfYml(id, expose), 'utf-8') }
    mk('weekly-report', '  mode: public\n  tool_name: run_weekly_report')
    mk('private-one', '  mode: private')
    mk('bound-one', '  mode: bound\n  bind_agents: [material-writer]')
    mkdirSync(join(wfRoot, 'legacy-one'), { recursive: true })
    writeFileSync(join(wfRoot, 'legacy-one', 'workflow.yml'), 'name: legacy-one\nnodes:\n  - { id: start, type: start, next: done }\n  - { id: done, type: end }\n', 'utf-8')
    const engine = createWorkflowEngine({ configDir: root, registry: createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true }), getModel: () => 'mock-model' })
    engine.addRoot(wfRoot)
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true, workflow: engine })

    const priv = await registry.run({ name: 'Workflow', input: { workflow: 'private-one', inputs: { topic: 'x' } } })
    assert.equal(priv.isError, true, `private 必须拒绝：${priv.content}`)
    assert.match(priv.content, /不可执行/, priv.content)
    assert.equal(existsSync(join(root, 'workflow-runs')), false, '被拒调用不得执行（无审计落盘）')

    const leg = await registry.run({ name: 'Workflow', input: { workflow: 'legacy-one' } })
    assert.equal(leg.isError, true, `legacy 必须拒绝：${leg.content}`)
    const missing = await registry.run({ name: 'Workflow', input: { workflow: 'no-such-wf' } })
    assert.equal(missing.isError, true, missing.content)

    const pub = await registry.run({ name: 'Workflow', input: { workflow: 'weekly-report', inputs: { topic: '周报' } } })
    assert.equal(pub.isError, false, `public 应可执行：${pub.content}`)
    assert.ok(existsSync(join(root, 'workflow-runs')), 'public 工作流应真实执行并落审计')

    engine.setDeps({ agentId: 'material-writer' })
    const bound = await registry.run({ name: 'Workflow', input: { workflow: 'bound-one', inputs: { topic: 'x' } } })
    assert.equal(bound.isError, false, `bound 命中当前 agent 应可执行：${bound.content}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
