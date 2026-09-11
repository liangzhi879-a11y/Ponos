// spec-dev 内置工作流（2026-09-11 系统化升级 Phase 1）：发现/解析 + 全 DAG 冒烟
// ---------------------------------------------------------------------------
// ① discoverWorkflows 发现 workflow.yml；② 节点链（specify→plan→tasks→impl_loop
//   [implement→converge]×3→end）解析正确；③ mock 全流程跑通（agent 节点 mock 回显
//   不会输出「已收敛」→ loop 走满 3 轮后 end，验证 DAG 结构 + loop 断点语义）。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverWorkflows, loadWorkflow, createWorkflowEngine } from '../kernel/workflow.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

const SRC = join(process.cwd().replace(/\\/g, '/'), 'workflows', 'spec-dev', 'workflow.yml')

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

test('spec-dev 全 DAG 冒烟（mock）：loop 走满 3 轮后正常结束（不收敛不崩溃）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-specdev-run-'))
  try {
    mkdirSync(join(root, 'spec-dev'), { recursive: true })
    copyFileSync(SRC, join(root, 'spec-dev', 'workflow.yml'))
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const engine = createWorkflowEngine({ configDir: root })
    engine.setDeps({ registry, getModel: () => 'mock-model' })
    engine.addRoot(root)
    const r = await engine.run({ id: 'spec-dev', inputs: { requirement: '测试需求', slug: 'demo' } })
    assert.equal(r.ok, true, `DAG 应完整执行：${JSON.stringify(r).slice(0, 300)}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
