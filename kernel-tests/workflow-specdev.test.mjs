// spec-dev 内置工作流（2026-09-11 系统化升级 Phase 1）：发现/解析 + 引擎接线冒烟
// ---------------------------------------------------------------------------
// ① discoverWorkflows 发现 workflow.yml；节点链（specify→plan→tasks→impl_loop
//   [implement→converge]×3→end）解析正确；
// ② **Task 5 起**：`workflows/spec-dev/workflow.yml` 仍是旧格式（无 edges），引擎按
//   LEGACY_DSL 拒绝执行——这是校验进生产路径后的**正确**行为（旧引擎的"数组顺序 + next"
//   语义在 DAG 引擎下不存在）。spec-dev 重写为显式 edges 由计划 Task 8 完成，届时本
//   测试应恢复「r.ok === true」断言（迁移器产物已由 workflow-migrate.test.mjs 断言自校验通过）；
// ③ 引擎接线冒烟（与 spec-dev 同构的 DAG 冒烟件）：loop body 子图递归、body 成员不进主
//   调度（scoping）、逐节点审计落盘可校验、事件齐全、end 聚合。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverWorkflows, loadWorkflow, createWorkflowEngine, verifyRun } from '../kernel/workflow.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

const SRC = join(process.cwd().replace(/\\/g, '/'), 'workflows', 'spec-dev', 'workflow.yml')

// spec-dev 结构的**DAG 等价冒烟件**（Task 8 落盘前，用它在同一引擎上验证接线）：
// 主链 start → lp → e（edges 显式），body 内 b1 → b2（跨边界边由 BODY_ESCAPE 禁止）。
const SPECDEV_DAG = `name: spec-dev-dag
version: 1.0.0
inputs:
  - { name: requirement, type: string, required: true }
nodes:
  - { id: start, type: start }
  - { id: lp, type: loop, count: 3, body: [b1, b2] }
  - { id: b1, type: template, template: "轮 {{iter}} 实现 {{inputs.requirement}}" }
  - { id: b2, type: template, template: "轮 {{iter}} 未收敛" }
  - { id: e, type: end, config: { outputs: [{ name: result, selector: "{{lp.iterations}}" }] } }
edges:
  - { id: e1, source: start, target: lp }
  - { id: e2, source: lp, target: e }
  - { id: e3, source: b1, target: b2 }
`

test('spec-dev 发现与解析：节点链/loop body/断点条件齐全', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-specdev-'))
  try {
    mkdirSync(join(root, 'spec-dev'), { recursive: true })
    copyFileSync(SRC, join(root, 'spec-dev', 'workflow.yml'))
    const wfs = discoverWorkflows({ root })
    assert.equal(wfs.length, 1)
    assert.equal(wfs[0].name, 'spec-dev')
    const wf = loadWorkflow({ roots: [root], id: 'spec-dev' }) // 节点详情经 loadWorkflow（discover 只给计数）
    assert.ok(wf, 'loadWorkflow 应解析成功')
    const ids = wf.nodes.map((n) => n.id)
    for (const id of ['start', 'specify', 'plan', 'tasks', 'impl_loop', 'implement', 'converge', 'end']) {
      assert.ok(ids.includes(id), `应有节点 ${id}`)
    }
    const loop = wf.nodes.find((n) => n.id === 'impl_loop')
    assert.equal(loop.type, 'loop')
    assert.deepEqual(loop.body, ['implement', 'converge'])
    assert.equal(loop.count, 3)
    assert.ok(Array.isArray(loop.break_conditions) && loop.break_conditions.length === 1, '断点：收敛即停')
    const conv = wf.nodes.find((n) => n.id === 'converge')
    assert.match(String(conv.prompt), /已收敛/, 'converge 输出约定')
    const impl = wf.nodes.find((n) => n.id === 'implement')
    assert.match(String(impl.prompt), /implementer/, '实现节点派 implementer')
    assert.match(String(impl.prompt), /reviewer/, '实现节点派 reviewer')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('spec-dev 仍属旧格式：引擎按 LEGACY_DSL 拒绝执行（Task 8 重写 edges 后恢复 r.ok===true 断言）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-specdev-run-'))
  try {
    mkdirSync(join(root, 'spec-dev'), { recursive: true })
    copyFileSync(SRC, join(root, 'spec-dev', 'workflow.yml'))
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const engine = createWorkflowEngine({ configDir: root })
    engine.setDeps({ registry, getModel: () => 'mock-model' })
    engine.addRoot(root)
    const r = await engine.run({ id: 'spec-dev', inputs: { requirement: '测试需求', slug: 'demo' } })
    // 校验进生产路径（内核计划 Task 5，交接项 I-5）：无 edges 的旧格式不再被静默加载执行。
    // 这不是回归——旧语义（数组顺序 + next）在 DAG 引擎下已不存在，静默执行会产出错误结果。
    assert.equal(r.ok, false, `旧格式必须被拒绝：${JSON.stringify(r).slice(0, 200)}`)
    assert.equal(r.code, 'LEGACY_DSL')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('spec-dev 同构 DAG 冒烟（mock）：loop body 子图递归 + 主图 scoping + 逐节点审计', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-specdev-dag-'))
  try {
    mkdirSync(join(root, 'spec-dev-dag'), { recursive: true })
    writeFileSync(join(root, 'spec-dev-dag', 'workflow.yml'), SPECDEV_DAG, 'utf-8')
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const engine = createWorkflowEngine({ configDir: root })
    const events = []
    engine.setDeps({ registry, getModel: () => 'mock-model', onEvent: (e) => events.push(e) })
    engine.addRoot(root)
    const r = await engine.run({ id: 'spec-dev-dag', inputs: { requirement: '测试需求' } })
    assert.equal(r.ok, true, `DAG 应完整执行：${JSON.stringify(r).slice(0, 300)}`)
    assert.equal(r.status, 'completed')
    // end 聚合（synthesizeOutput 与 end 节点执行器同源）
    assert.equal(r.outputs.e.output.result, 3)
    assert.equal(r.finalOutput.result, 3)
    // 主图 scoping：body 成员不进主 settled（否则它们会作为源节点在 loop 之外多跑一遍）
    assert.equal(r.settled.has('b1'), false, 'body 成员不得出现在主 settled')
    assert.deepEqual([...r.settled.keys()].sort(), ['e', 'lp', 'start'])
    // body 内子图递归：b1/b2 各执行 3 轮（loop count=3），事件带 in_body
    const b1 = events.filter((e) => e.type === 'node' && e.node === 'b1')
    assert.equal(b1.length, 3, `b1 应执行 3 轮：${JSON.stringify(b1.map((e) => e.status))}`)
    assert.ok(b1.every((e) => e.in_body === true), '子图节点事件应带 in_body')
    assert.equal(events.filter((e) => e.type === 'node' && e.node === 'b2').length, 3)
    // 边事件：主图两条 + body 内一条
    const edges = events.filter((e) => e.type === 'edge_taken').map((e) => e.edge)
    for (const id of ['e1', 'e2', 'e3']) assert.ok(edges.includes(id), `应有 edge_taken ${id}：${edges.join(',')}`)
    // 审计：逐节点落盘（含 body 节点），哈希链可校验
    const lines = readFileSync(r.auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.filter((l) => l.node === 'b1').length, 3)
    assert.equal(lines.filter((l) => l.node === 'start').length, 1)
    assert.equal(lines.length, 9, `start + body(2×3) + lp + e = 9 行：${lines.map((l) => l.node).join(',')}`)
    assert.equal(verifyRun(r.auditPath).ok, true, '哈希链应可校验')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
