import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseYaml, loadWorkflow, validateWorkflow, normalizeWorkflow, normalizeNode, unquote, toModel, serializeWorkflow, normalizeTriggers, DSL_VERSION } from '../kernel/workflow-dsl.mjs'

const GOOD = `name: demo
version: 1.0.0
triggers: [演示]
settings: { max_parallel: 4 }
trigger_config: { manual: true, webhook: false }
inputs:
  - { name: q, type: string, required: true, description: 问题 }
nodes:
  - { id: start, type: start, label: 开始, position: {x: 0, y: 0} }
  - id: ask
    type: llm
    label: 生成
    config: { prompt: "回答：{{inputs.q}}" }
    retry: { max: 2, delay_ms: 500, on_error: fail }
  - { id: done, type: end, label: 结束, config: { outputs: [{ name: text, selector: "{{ask}}" }] } }
edges:
  - { id: e1, source: start, target: ask }
  - { id: e2, source: ask, target: done }
`

function withFile(content, fn) {
  const root = mkdtempSync(join(tmpdir(), 'wf-dsl-'))
  try {
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'workflow.yml'), content, 'utf-8')
    return fn(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('DSL v2：加载后 config 摊平、edges 保留、校验通过', () => {
  withFile(GOOD, (root) => {
    const wf = loadWorkflow({ roots: [root], id: 'demo' })
    assert.equal(wf.dslVersion, DSL_VERSION)
    const ask = wf.nodes.find((n) => n.id === 'ask')
    assert.equal(ask.prompt, '回答：{{inputs.q}}', 'config.prompt 应摊平到节点')
    assert.equal(ask.retry.max, 2, 'retry 留在节点顶层')
    assert.equal(ask.config, undefined, 'config 键应被消费掉')
    assert.equal(wf.edges.length, 2)
    const v = validateWorkflow(wf)
    assert.deepEqual(v.errors, [], `不应有错误：${JSON.stringify(v.errors)}`)
  })
})

test('校验器：缺 edges → LEGACY_DSL', () => {
  const legacy = GOOD.replace(/edges:[\s\S]*$/, '')
  const wf = normalizeWorkflow(parseYaml(legacy))
  const v = validateWorkflow(wf)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.code === 'LEGACY_DSL'))
})

test('校验器：环 / 悬空边 / 重复 id / 缺 start', () => {
  const cyc = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'llm' }], edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }] })
  assert.ok(validateWorkflow(cyc).errors.some((e) => e.code === 'CYCLE'))

  const dang = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }], edges: [{ id: 'e1', source: 'a', target: 'nope' }] })
  assert.ok(validateWorkflow(dang).errors.some((e) => e.code === 'DANGLING_EDGE'))

  const dup = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }, { id: 'a', type: 'end' }], edges: [] })
  assert.ok(validateWorkflow(dup).errors.some((e) => e.code === 'DUP_NODE_ID'))

  // 重复边 id（调度器 edgeState 以 edgeId 为键 → 会串台）必须报错，不得静默通过
  const dupEdge = normalizeWorkflow({
    nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'end' }],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e1', source: 'a', target: 'b' },
    ],
  })
  assert.ok(validateWorkflow(dupEdge).errors.some((e) => e.code === 'DUP_EDGE'), '重复边 id 应报 DUP_EDGE')

  const nostart = normalizeWorkflow({ nodes: [{ id: 'a', type: 'llm' }], edges: [] })
  assert.ok(validateWorkflow(nostart).errors.some((e) => e.code === 'NO_START'))
})

test('校验器：body 越界与跨子图边', () => {
  const wf = normalizeWorkflow({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'lp', type: 'loop', body: ['body1', 'ghost'] },
      { id: 'body1', type: 'llm', prompt: 'x' },
      { id: 'done', type: 'end' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'lp' },
      { id: 'e2', source: 'lp', target: 'done' },
      { id: 'e3', source: 'body1', target: 'done' },
    ],
  })
  const codes = validateWorkflow(wf).errors.map((e) => e.code)
  assert.ok(codes.includes('BODY_MEMBER_MISSING'), `应报 body 成员不存在：${codes}`)
  assert.ok(codes.includes('BODY_ESCAPE'), `应报跨子图边：${codes}`)
})

// ---------- 返工轮 1 补充：解析回退 / 变量校验 / 归一化约定 ----------

test('unquote：{…} 内含无冒号部分 → 保留原字符串（不静默改型为对象）', () => {
  assert.equal(unquote('{ return 1 }'), '{ return 1 }')
  assert.equal(unquote('{{ask}}'), '{{ask}}')
  assert.equal(parseYaml('foo: {{bar}}').foo, '{{bar}}')
  // 反向：合法的内联映射仍必须被解析成对象
  assert.deepEqual(unquote('{ max: 2 }'), { max: 2 })
})

test("unquote：词内撇号（don't）不得吞并流式数组项", () => {
  assert.equal(unquote("[don't, x]").length, 2)
  assert.deepEqual(unquote("[don't, x]"), ["don't", "x"])
  assert.equal(unquote("[doesn't, it's, y]").length, 3)
  // 引号内逗号仍受保护
  assert.deepEqual(unquote("[\"it's, ok\", x]"), ["it's, ok", 'x'])
})

test('校验器：VAR_UNKNOWN / VAR_UNREACHABLE', () => {
  // 引用不存在的节点 id → VAR_UNKNOWN
  const unknown = normalizeWorkflow({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'llm', prompt: '{{ghost.x}}' },
      { id: 'done', type: 'end' },
    ],
    edges: [{ id: 'e1', source: 'start', target: 'a' }, { id: 'e2', source: 'a', target: 'done' }],
  })
  const unknownCodes = validateWorkflow(unknown).errors.map((e) => e.code)
  assert.ok(unknownCodes.includes('VAR_UNKNOWN'), `应报未知变量：${unknownCodes}`)

  // 同作用域内引用非祖先节点（b 与 a 并列，a 引用 b）→ VAR_UNREACHABLE
  const unreachable = normalizeWorkflow({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'llm', prompt: '{{b.x}}' },
      { id: 'b', type: 'llm', prompt: 'y' },
      { id: 'done', type: 'end' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'start', target: 'b' },
      { id: 'e3', source: 'a', target: 'done' },
      { id: 'e4', source: 'b', target: 'done' },
    ],
  })
  const unreachableCodes = validateWorkflow(unreachable).errors.map((e) => e.code)
  assert.ok(unreachableCodes.includes('VAR_UNREACHABLE'), `应报非上游引用：${unreachableCodes}`)

  // 正向对照：真祖先引用不得误报 VAR_*
  const reachable = normalizeWorkflow({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'llm', prompt: 'x' },
      { id: 'b', type: 'llm', prompt: '{{a.out}}' },
      { id: 'done', type: 'end' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'done' },
    ],
  })
  const reachableCodes = validateWorkflow(reachable).errors.map((e) => e.code)
  assert.deepEqual(reachableCodes.filter((c) => c.startsWith('VAR_')), [], `祖先引用不应报 VAR_*：${reachableCodes}`)
})

test('normalizeWorkflow：缺 edges 约定为 null（LEGACY_DSL 依据）', () => {
  assert.equal(normalizeWorkflow({ nodes: [] }).edges, null)
  assert.equal(normalizeWorkflow({ nodes: [], edges: null }).edges, null)
  assert.equal(normalizeWorkflow({ nodes: [], edges: 'x' }).edges, null)
  assert.deepEqual(normalizeWorkflow({ nodes: [], edges: [] }).edges, [])
  // legacy 文件加载后 edges === null，且校验器据此报 LEGACY_DSL
  const legacy = GOOD.replace(/edges:[\s\S]*$/, '')
  withFile(legacy, (root) => {
    const wf = loadWorkflow({ roots: [root], id: 'demo' })
    assert.equal(wf.edges, null, '旧格式（无 edges）加载后 edges 应为 null')
    assert.ok(validateWorkflow(wf).errors.some((e) => e.code === 'LEGACY_DSL'))
  })
})

test('normalizeNode：config 摊平只补缺、不覆盖节点顶层字段', () => {
  const n = normalizeNode({
    id: 'a',
    body: ['real'],
    retry: { max: 1 },
    config: { body: ['fake'], retry: { max: 9 }, prompt: 'p' },
  })
  assert.deepEqual(n.body, ['real'], 'config.body 不得覆盖顶层 body')
  assert.deepEqual(n.retry, { max: 1 }, 'config.retry 不得覆盖顶层 retry')
  assert.equal(n.prompt, 'p', 'config 中的新键应摊平到节点')
  assert.equal(n.config, undefined, 'config 键应被消费掉')
})

// —— 2026-09-12 实测崩溃回归：triggers 裸逗号标量在两条路径上形状不一致 ——
// 现场证据：spec-dev 的 workflow.yml 写 `triggers: spec 开发, spec-dev, …`（裸标量），
//   discoverWorkflows（列表）归一成数组、toModel（编辑器模型）原样透传成字符串，
//   GUI 编辑器 `(model.triggers || []).join(', ')` 抛 `join is not a function` → 打开画布整页白屏；
//   保存路径 `model.triggers.map(...)` 同样会抛。修法：normalizeTriggers 单一归一器，三处共用。
test('triggers 形状契约：裸逗号标量在列表与编辑器模型上必须都是 string[]', () => {
  const yml = [
    'name: demo',
    'version: 1.0.0',
    'triggers: 甲, 乙，丙',            // 中英文逗号混合的裸标量
    'trigger_config: { manual: true }',
    'nodes:',
    '  - { id: start, type: start }',
    'edges: []',
  ].join('\n')
  withFile(yml, (root) => {
    const wf = loadWorkflow({ roots: [root], id: 'demo' })
    assert.deepEqual(wf.triggers, ['甲', '乙', '丙'], 'loadWorkflow 应归一出数组')

    const model = toModel(wf)
    assert.ok(Array.isArray(model.triggers), `编辑器模型 triggers 必须是数组（实际 ${typeof model.triggers}）`)
    assert.deepEqual(model.triggers, ['甲', '乙', '丙'], '编辑器模型应与加载结果同形')
    assert.equal(typeof model.triggers.join, 'function', 'GUI 会对它调 .join/.map，字符串形状即白屏')

    // 保存路径：serializeWorkflow 内部先 toModel，不应抛
    const text = serializeWorkflow(model)
    assert.match(text, /^triggers: \[甲, 乙, 丙\]$/m, '序列化应写回数组写法')

    // 已是数组 / 缺失 / 数字等形态都要稳
    assert.deepEqual(normalizeTriggers(['a', ' a ', '']), ['a', 'a'], '数组形态应去空去重空白')
    assert.deepEqual(normalizeTriggers(undefined), [], '缺失 → 空数组而非 undefined（避免下游 ?? [] 失效）')
    assert.deepEqual(toModel({ name: 'x', nodes: [], edges: [] }).triggers, [], '无 triggers 的模型也应为空数组')
  })
})
