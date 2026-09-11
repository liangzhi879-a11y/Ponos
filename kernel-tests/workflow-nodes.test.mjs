process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNodeExecutor } from '../kernel/workflow-nodes.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function mkExec(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-nodes-'))
  const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
  const exec = createNodeExecutor({ registry, getModel: () => 'mock-model', ...over })
  return { exec, root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('if 节点返回 route=true/false（不再返回 next）', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const a = await exec({ id: 'g', type: 'if', conditions: [{ var: 'inputs.n', op: '>', value: 3 }] }, { inputs: { n: 5 }, vars: {}, var: {} })
    assert.equal(a.ok, true)
    assert.equal(a.route, 'true')
    const b = await exec({ id: 'g', type: 'if', conditions: [{ var: 'inputs.n', op: '>', value: 3 }] }, { inputs: { n: 1 }, vars: {}, var: {} })
    assert.equal(b.route, 'false')
  } finally { cleanup() }
})

test('template/assign/aggregate/list/join 纯计算节点', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const t = await exec({ id: 't', type: 'template', template: '你好 {{inputs.name}}' }, { inputs: { name: '远方' }, vars: {}, var: {} })
    assert.equal(t.output, '你好 远方')

    const ctx = { inputs: {}, vars: { a: { x: 1 } }, var: {} }
    const asg = await exec({ id: 's', type: 'assign', items: [{ variable: 'k', value: '{{a.x}}' }] }, ctx)
    assert.equal(asg.output.k, 1)
    assert.equal(ctx.var.k, 1)

    const agg = await exec({ id: 'g', type: 'aggregate', variables: [{ selector: '{{a.x}}' }], output_type: 'string' }, ctx)
    assert.equal(agg.output, '1')

    const lst = await exec({ id: 'l', type: 'list', variable: '{{a}}' }, { inputs: {}, vars: { a: [3, 1, 2] }, var: {} , listRef: true })
    assert.deepEqual(lst.output, [3, 1, 2])

    const jn = await exec({ id: 'j', type: 'join', mode: 'concat', separator: ' | ', sources: ['{{p}}', '{{q}}'] }, { inputs: {}, vars: { p: '甲', q: '乙' }, var: {} })
    assert.equal(String(jn.output).includes('甲'), true)
  } finally { cleanup() }
})

test('join 节点按 config.mode 聚合多分支（array/concat/first）', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const ctx = { inputs: {}, vars: {}, var: {} }
    const node = { id: 'j', type: 'join', mode: 'array', sources: ['{{a}}', '{{b}}'] }
    ctx.vars = { a: 'A', b: 'B' }
    const r = await exec(node, ctx)
    assert.deepEqual(r.output, ['A', 'B'])
  } finally { cleanup() }
})

test('subworkflow 深度上限防自递归', async () => {
  let calls = 0
  const { exec, cleanup } = mkExec({
    engine: {
      run: async () => { calls++; return { ok: true, outputs: { done: true } } },
    },
  })
  try {
    const deep = await exec({ id: 's', type: 'subworkflow', workflow: 'other' }, { inputs: {}, vars: {}, var: {}, depth: 5 })
    assert.equal(deep.ok, false)
    assert.match(String(deep.error), /深度/)
    const okRun = await exec({ id: 's', type: 'subworkflow', workflow: 'other' }, { inputs: {}, vars: {}, var: {}, depth: 1 })
    assert.equal(okRun.ok, true)
    assert.equal(calls, 1)
  } finally { cleanup() }
})

test('answer 节点：输出 answer 文本并标记为终端节点', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const r = await exec({ id: 'a', type: 'answer', template: '结论：{{x}}' }, { inputs: {}, vars: { x: 'OK' }, var: {} })
    assert.equal(r.ok, true)
    assert.equal(r.output.answer, '结论：OK')
  } finally { cleanup() }
})

test('loop 子图：runBody 由调度器递归执行，break 条件命中即提前结束', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const ctx = {
      inputs: {}, vars: {}, var: {}, depth: 0,
      childNodes: [{ id: 'b1', type: 'template', template: '第{{iter}}轮' }],
      childEdges: [],
    }
    const r = await exec({ id: 'lp', type: 'loop', count: 3, body: ['b1'], break_conditions: [{ var: 'b1', op: 'contains', value: '第1轮' }] }, ctx)
    assert.equal(r.ok, true)
    assert.equal(r.output.iterations, 2, `第 1 轮后 break 应命中（含 break 检查发生在轮末）：${JSON.stringify(r.output)}`)
  } finally { cleanup() }
})
