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

// ===================== 返工轮 1（Task 4 审查 I-4）：要害契约入库守卫 =====================

test('classify 未命中任何类目 → route=default（不返回 next，供调度器激活 default 边）', async () => {
  const { exec, cleanup } = mkExec()
  try {
    // mock 只回显 user prompt 的前 120 字符：把 query 拉长到窗口之外，类目名不进回显，
    // 使模型输出无法匹配任何类目（真实 LLM 未命中时同走此分支）。
    const longQuery = 'x'.repeat(300)
    const miss = await exec(
      { id: 'c', type: 'classify', query: longQuery, classes: ['甲类目', '乙类目'] },
      { inputs: {}, vars: {}, var: {} },
    )
    assert.equal(miss.ok, true)
    assert.equal(miss.output.class_index, -1)
    assert.equal(miss.route, 'default')
    assert.deepEqual(Object.keys(miss).filter((k) => k.startsWith('next')), [])
    // 对照组：命中路径仍是 route:<i>（default 不是无条件返回）
    const hit = await exec(
      { id: 'c', type: 'classify', query: '短查询', classes: ['甲类目', '乙类目'] },
      { inputs: {}, vars: {}, var: {} },
    )
    assert.equal(hit.route, 'route:0')
  } finally { cleanup() }
})

test('无 ctx.permissionGate 时 Bash 工具节点 fail-closed（拒绝执行，不上抛）', async () => {
  // registry 用 createToolRegistry({ cwd, addDirs:[cwd], skipPermissions:true })（= mkExec）：
  // 审批门的判定在 checkToolPermission，与 registry 的 skipPermissions 无关，故仍应被拒。
  const { exec, cleanup } = mkExec()
  try {
    const denied = await exec(
      { id: 't', type: 'tool', tool: 'Bash', input: { command: 'echo hi' } },
      { inputs: {}, vars: {}, var: {} },
    )
    // 真实行为（如实记录）：拒绝经 registry 工具结果契约表达为
    // { ok:true, isError:true, output:<拒绝原因> }，而非 { ok:false }；且绝不上抛异常。
    assert.equal(denied.ok, true)
    assert.equal(denied.isError, true)
    assert.match(String(denied.output), /无审批通道/)
    assert.match(String(denied.output), /Bash 工具默认拒绝执行/)
    assert.equal(String(denied.output).includes('hi'), false, '命令不得被实际执行')
    assert.equal(denied.route, undefined)

    // 正向对照：注入审批门并放行 → 真的执行（证明拒绝源于缺门，而非 Bash 不可用）
    let gateCalls = 0
    const allowed = await exec(
      { id: 't', type: 'tool', tool: 'Bash', input: { command: 'echo hi' } },
      { inputs: {}, vars: {}, var: {}, permissionGate: async () => { gateCalls++; return { allowed: true } } },
    )
    assert.equal(gateCalls, 1)
    assert.equal(allowed.isError, false)
    assert.equal(String(allowed.output).includes('hi'), true)

    // 反向对照：门拒绝 → isError:true 且透传拒绝原因
    const rejected = await exec(
      { id: 't', type: 'tool', tool: 'Bash', input: { command: 'echo hi' } },
      { inputs: {}, vars: {}, var: {}, permissionGate: async () => ({ allowed: false, message: 'denied-by-gate' }) },
    )
    assert.equal(rejected.isError, true)
    assert.match(String(rejected.output), /denied-by-gate/)
  } finally { cleanup() }
})

test('join 节点 mode=first 取首值 / mode=concat 用自定义 separator 拼接', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const first = await exec(
      { id: 'j', type: 'join', mode: 'first', sources: ['{{a}}', '{{b}}'] },
      { inputs: {}, vars: { a: 'A', b: 'B' }, var: {} },
    )
    assert.equal(first.ok, true)
    assert.equal(first.output, 'A')

    const concat = await exec(
      { id: 'j', type: 'join', mode: 'concat', separator: ' ｜ ', sources: ['{{a}}', '{{b}}'] },
      { inputs: {}, vars: { a: '甲', b: '乙' }, var: {} },
    )
    assert.equal(concat.ok, true)
    assert.equal(concat.output, '甲 ｜ 乙')

    // 对象值在 concat 下 JSON 化（类型不丢）；array 模式保持原值（见既有 test 3）
    const objConcat = await exec(
      { id: 'j', type: 'join', mode: 'concat', separator: '+', sources: ['{{o}}', '{{a}}'] },
      { inputs: {}, vars: { o: { k: 1 }, a: 'A' }, var: {} },
    )
    assert.equal(objConcat.output, '{"k":1}+A')
  } finally { cleanup() }
})

test('loop 子图：跨边界边被排除（主图节点不被 body 内边带动执行）', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const settled = []
    const ctx = {
      inputs: {}, vars: {}, var: {}, depth: 0,
      childNodes: [
        { id: 'b1', type: 'template', template: 'B1-{{iter}}' },
        { id: 'b2', type: 'template', template: 'B2-sees[{{b1}}]' },
        { id: 'OUT', type: 'template', template: 'OUT-{{iter}}' },
        { id: 'MAIN2', type: 'template', template: 'MAIN2' },
      ],
      // e1 = body 内部边（应生效）；e2/e3/e4 = 跨边界边（必须在子图中被过滤）
      childEdges: [
        { id: 'e1', source: 'b1', target: 'b2' },
        { id: 'e2', source: 'b2', target: 'OUT' },
        { id: 'e3', source: 'OUT', target: 'b1' },
        { id: 'e4', source: 'MAIN2', target: 'b1' },
      ],
      onNodeSettled: (s) => settled.push(s),
    }
    const r = await exec({ id: 'lp', type: 'loop', count: 2, body: ['b1', 'b2'] }, ctx)
    assert.equal(r.ok, true)
    // 每轮：b1 →（内部边）b2；b2 读到 b1 的输出 ⇒ 内部边生效
    assert.deepEqual(r.output.results, ['B2-sees[B1-0]', 'B2-sees[B1-1]'], JSON.stringify(r.output))
    // 跨边界边不生成任何主图节点的执行
    assert.deepEqual(settled.map((s) => s.node), ['b1', 'b2', 'b1', 'b2'])
    assert.equal(settled.some((s) => s.node === 'OUT' || s.node === 'MAIN2'), false)
    assert.equal(settled.every((s) => s.in_body === true), true)
  } finally { cleanup() }
})

test('loop/iterate 无 ctx.runBody 时走自带调度回退（只用 childNodes/childEdges）', async () => {
  const { exec, cleanup } = mkExec()
  try {
    const settled = []
    const ctx = {
      inputs: {}, vars: {}, var: {}, depth: 0,
      childNodes: [
        { id: 'b1', type: 'template', template: '第{{iter}}轮' },
        { id: 'b2', type: 'template', template: 'S[{{b1}}]' },
      ],
      childEdges: [{ id: 'e1', source: 'b1', target: 'b2' }],
      onNodeSettled: (s) => settled.push(s),
    }
    assert.equal('runBody' in ctx, false, '前置：ctx 不提供 runBody')
    const r = await exec({ id: 'lp', type: 'loop', count: 2, body: ['b1', 'b2'] }, ctx)
    assert.equal(r.ok, true)
    // 自带 schedule 递归：内部边生效 + 轮间 vars 隔离（iter 逐轮递增）
    assert.deepEqual(r.output.results, ['S[第0轮]', 'S[第1轮]'], JSON.stringify(r.output))
    assert.equal(r.output.iterations, 2)
    // in_body:true 只由自带 runBody 的 onSettle 补上 ⇒ 证明确实走了回退路径
    assert.deepEqual(settled.map((s) => s.node), ['b1', 'b2', 'b1', 'b2'])
    assert.equal(settled.every((s) => s.in_body === true), true)
    // 回退实现不得改写调用方 ctx（runBody 注入在副本上进行）
    assert.equal('runBody' in ctx, false)

    // iterate 同样回退（每项一项，item 注入）
    const it = await exec(
      { id: 'it', type: 'iterate', iterable: '{{arr}}', body: ['b1'] },
      {
        inputs: {}, vars: { arr: ['x', 'y'] }, var: {},
        childNodes: [{ id: 'b1', type: 'template', template: 'item={{item}}' }],
        childEdges: [],
      },
    )
    assert.equal(it.ok, true)
    assert.deepEqual(it.output, ['item=x', 'item=y'])
  } finally { cleanup() }
})
