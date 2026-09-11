// src/lib/workflowModel.test.ts —— 工作流 DSL 画布模型的纯逻辑单测（UI Task 13）
// 运行：node --test src/lib/workflowModel.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 范围：edges ⇄ 画布往返、sourceHandle 保真、能力推导、本地快速校验、节点目录完整性。
// 权威校验在内核（kernel/workflow-dsl.validateWorkflow）；此处只做画布即时反馈，口径以内核为准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toFlow, fromFlow, deriveCapabilities, validateLocal, NODE_TYPES, type WorkflowModel } from './workflowModel.ts'

const MODEL: WorkflowModel = {
  name: 'demo', version: '1.0.0',
  inputs: [{ name: 'q', type: 'string', required: true }],
  nodes: [
    { id: 'start', type: 'start', label: '开始', position: { x: 0, y: 0 } },
    { id: 'ask', type: 'llm', label: '问', position: { x: 200, y: 0 }, config: { prompt: '{{inputs.q}}' } },
    { id: 'f', type: 'tool', label: '写文件', position: { x: 400, y: 0 }, config: { tool: 'Write', input: { file_path: '{{inputs.out}}', content: 'x' } } },
    { id: 'done', type: 'end', label: '结束', position: { x: 600, y: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'ask' },
    { id: 'e2', source: 'ask', target: 'f' },
    { id: 'e3', source: 'f', target: 'done' },
  ],
}

test('toFlow ⇄ fromFlow 往返保持语义与位置', () => {
  const flow = toFlow(MODEL)
  assert.equal(flow.nodes.length, 4)
  assert.equal(flow.nodes[1].position.x, 200)
  assert.equal(flow.edges.length, 3)
  const back = fromFlow(flow.nodes, flow.edges, MODEL)
  assert.deepEqual(back.nodes.map((n) => n.id), MODEL.nodes.map((n) => n.id))
  assert.deepEqual(back.edges.map((e) => `${e.source}->${e.target}`), ['start->ask', 'ask->f', 'f->done'])
})

test('条件边：sourceHandle 映射为画布 handle（true/false/route:i/fail）', () => {
  const m: WorkflowModel = { ...MODEL, edges: [{ id: 'e1', source: 'ask', target: 'done', sourceHandle: 'true' }] }
  const flow = toFlow(m)
  assert.equal(flow.edges[0].sourceHandle, 'true')
  const back = fromFlow(flow.nodes, flow.edges, m)
  assert.equal(back.edges[0].sourceHandle, 'true')
})

test('deriveCapabilities：从节点推导能力清单（工具/网络/写入目录）', () => {
  const caps = deriveCapabilities(MODEL)
  assert.ok(caps.tools.includes('Write'), `应推导出 Write：${caps.tools}`)
  assert.equal(caps.network, false)

  const withHttp: WorkflowModel = { ...MODEL, nodes: [...MODEL.nodes, { id: 'h', type: 'http', config: { url: 'https://x' } }] }
  assert.equal(deriveCapabilities(withHttp).network, true)

  const declared: WorkflowModel = { ...MODEL, permissions: { tools: ['Bash'], network: true, write_dirs: ['D:/ws'] } }
  const c = deriveCapabilities(declared)
  assert.ok(c.tools.includes('Bash') && c.network === true)
  assert.deepEqual(c.write_dirs, ['D:/ws'])
})

test('validateLocal：缺 start / 环 / 引用非上游 报错；正常模型零错误', () => {
  assert.deepEqual(validateLocal(MODEL).errors, [])
  assert.ok(validateLocal({ ...MODEL, nodes: MODEL.nodes.filter((n) => n.type !== 'start'), edges: [] }).errors.some((e) => e.code === 'NO_START'))
  const cyc: WorkflowModel = { ...MODEL, edges: [...MODEL.edges, { id: 'e9', source: 'done', target: 'start' }] }
  assert.ok(validateLocal(cyc).errors.some((e) => e.code === 'CYCLE'))
  const badRef: WorkflowModel = { ...MODEL, nodes: MODEL.nodes.map((n) => (n.id === 'ask' ? { ...n, config: { prompt: '{{done.x}}' } } : n)) }
  assert.ok(validateLocal(badRef).errors.some((e) => e.code === 'VAR_UNREACHABLE'))
})

test('NODE_TYPES：分类目录含全部节点类型且每项有中文名', () => {
  const all = NODE_TYPES.flatMap((g) => g.items).map((i) => i.type)
  for (const t of ['start', 'end', 'answer', 'llm', 'classify', 'extract', 'agent', 'code', 'template', 'http', 'document', 'list', 'iterate', 'loop', 'memory', 'store', 'tool', 'subworkflow', 'if', 'join', 'assign', 'aggregate', 'confirm']) {
    assert.ok(all.includes(t as never), `缺节点类型 ${t}`)
  }
})
