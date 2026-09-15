// spec-dev 内置工作流（2026-09-11 系统化升级 Phase 1）：发现/解析 + 引擎接线冒烟
// ---------------------------------------------------------------------------
// ① discoverWorkflows 发现 workflow.yml；DSL v2 **edges 显式连线**（Task 8 重写后）：
//   start→specify→plan→tasks→impl_loop[implement→converge]×3→end；
// ② **Task 8 起**：`workflows/spec-dev/workflow.yml` 已是 DAG（有 edges），引擎在生产
//   校验路径（validateWorkflow）下正常执行 → 恢复「r.ok === true」断言（Task 5 期间该测试
//   曾断言 LEGACY_DSL 拒绝：旧格式"数组顺序 + next"语义在 DAG 引擎下不存在，是被拒的正确行为）；
// ③ 引擎接线冒烟（与 spec-dev 同构的最小 DAG 冒烟件）：loop body 子图递归、body 成员不进主
//   调度（scoping）、逐节点审计落盘可校验、事件齐全、end 聚合。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverWorkflows, loadWorkflow, createWorkflowEngine, verifyRun } from '../kernel/workflow.mjs'
import { validateWorkflow } from '../kernel/workflow-dsl.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { buildWorkflowTools, listVisibleWorkflows } from '../kernel/dyntools.mjs'

// 仓库根相对定位（不依赖 cwd）：在 kernel/ 下跑 npm test 也能找到内置工作流
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO_ROOT, 'workflows', 'spec-dev', 'workflow.yml')

// spec-dev 结构的**DAG 等价冒烟件**：主链 start → lp → e（edges 显式），
// body 内 b1 → b2（跨边界边由 BODY_ESCAPE 禁止）。
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

test('spec-dev 发现与解析：edges 显式连线 + loop body + 断点条件齐全', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-specdev-'))
  try {
    mkdirSync(join(root, 'spec-dev'), { recursive: true })
    copyFileSync(SRC, join(root, 'spec-dev', 'workflow.yml'))
    const wfs = discoverWorkflows({ root })
    assert.equal(wfs.length, 1)
    assert.equal(wfs[0].name, 'spec-dev')
    assert.equal(wfs[0].legacy, false, 'DSL v2：有 edges 即非旧格式')
    const wf = loadWorkflow({ roots: [root], id: 'spec-dev' }) // 节点详情经 loadWorkflow（discover 只给计数）
    assert.ok(wf, 'loadWorkflow 应解析成功')
    const ids = wf.nodes.map((n) => n.id)
    for (const id of ['start', 'specify', 'plan', 'tasks', 'impl_loop', 'implement', 'converge', 'end']) {
      assert.ok(ids.includes(id), `应有节点 ${id}`)
    }
    const pairs = wf.edges.map((e) => `${e.source}->${e.target}`)
    for (const p of ['start->specify', 'specify->plan', 'plan->tasks', 'tasks->impl_loop', 'impl_loop->end']) {
      assert.ok(pairs.includes(p), `应有边 ${p}：${pairs.join(',')}`)
    }
    const inner = wf.edges.filter((e) => e.source === 'implement' || e.source === 'converge').map((e) => `${e.source}->${e.target}`)
    assert.ok(inner.includes('implement->converge'), `loop body 内应有 implement->converge：${inner}`)
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
    const v = validateWorkflow(wf)
    assert.equal(v.ok, true, JSON.stringify(v.errors))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('spec-dev 已重写为 DAG：引擎在生产校验路径下正常执行（r.ok === true）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-specdev-run-'))
  try {
    mkdirSync(join(root, 'spec-dev'), { recursive: true })
    copyFileSync(SRC, join(root, 'spec-dev', 'workflow.yml'))
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const engine = createWorkflowEngine({ configDir: root })
    engine.setDeps({ registry, getModel: () => 'mock-model' })
    engine.addRoot(root)
    const r = await engine.run({ id: 'spec-dev', inputs: { requirement: '测试需求', slug: 'demo' } })
    // Task 8 前该断言是 `r.ok === false` + `r.code === 'LEGACY_DSL'`（旧格式被拒）。现 spec-dev
    // 已是显式 DAG → 校验通过、mock 下跑完全链（agent 节点走 mock 回显，"已收敛"未命中 →
    // loop 跑满 3 轮的 count 上限）。
    assert.equal(r.ok, true, `DAG 版应可执行：${JSON.stringify(r).slice(0, 300)}`)
    assert.equal(r.status, 'completed')
    for (const id of ['start', 'specify', 'plan', 'tasks', 'impl_loop', 'end']) {
      assert.ok(r.settled.has(id), `主链节点应 settled：${id}（${[...r.settled.keys()].join(',')}）`)
    }
    // body 成员不进主图 settled（loop 内子图递归执行）
    assert.equal(r.settled.has('implement'), false, 'body 成员不得出现在主 settled')
    assert.equal(r.settled.has('converge'), false, 'body 成员不得出现在主 settled')
    // steps 为调度步数（workflow-dag 计数，非数组）：主链 start/specify/plan/tasks + loop(3 轮×2 body) + end
    assert.ok(r.steps > 0, `应产出调度步数：${r.steps}`)
    // 终审修复：end 节点此前**无 outputs** ⇒ finalOutput 恒为 {}（工作流跑完、状态为 completed，
    // 调用方却拿不到 spec/plan/tasks 与收敛状态——"优化了但看不到效果"的机械成因之一）。
    assert.ok(r.finalOutput && typeof r.finalOutput === 'object', 'finalOutput 应为对象')
    for (const k of ['spec', 'plan', 'tasks']) {
      assert.ok(typeof r.finalOutput[k] === 'string' && r.finalOutput[k].length > 0,
        `finalOutput.${k} 必须非空（实际 ${JSON.stringify(r.finalOutput[k])}）`)
    }
    assert.equal(typeof r.finalOutput.iterations, 'number', `finalOutput.iterations 应为轮数（实际 ${JSON.stringify(r.finalOutput.iterations)}）`)
    assert.equal(typeof r.finalOutput.converged, 'boolean', `finalOutput.converged 应为收敛标记（实际 ${JSON.stringify(r.finalOutput.converged)}）`)
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

// 终审修复 M4：内置 spec-dev 此前缺 expose → 缺省 private → 模型侧完全不可见
// （无具名工具、不在提示词清单）；triggers 逗号标量此前恒解析为 []。
test('spec-dev 可见性与触发词（M4）：expose=public + 具名工具 + 逗号标量 triggers', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-specdev-exp-'))
  try {
    mkdirSync(join(root, 'spec-dev'), { recursive: true })
    copyFileSync(SRC, join(root, 'spec-dev', 'workflow.yml'))
    const [meta] = discoverWorkflows({ root })
    assert.equal(meta.expose?.mode, 'public', `内置工作流必须显式 expose public：${JSON.stringify(meta.expose)}`)
    assert.equal(meta.expose?.tool_name, 'run_spec_dev')
    assert.equal(meta.triggers.length, 5, `triggers 逗号标量须解析为 5 条：${JSON.stringify(meta.triggers)}`)
    assert.ok(meta.triggers.includes('spec 开发'))
    const visible = listVisibleWorkflows({ roots: [root] }).map((w) => w.id)
    assert.deepEqual(visible, ['spec-dev'], `public 工作流应进提示词清单：${visible}`)
    const tools = buildWorkflowTools({ roots: [root], engine: { run: async () => ({ ok: true, finalOutput: {} }) } })
    assert.equal(typeof tools.run_spec_dev?.run, 'function', `应注册具名工具 run_spec_dev：${Object.keys(tools)}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
