// src/lib/workflowModel.test.ts —— 工作流 DSL 画布模型的纯逻辑单测（UI Task 13）
// 运行：node --test src/lib/workflowModel.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
// 范围：edges ⇄ 画布往返、sourceHandle 保真、能力推导、本地快速校验、节点目录完整性。
// 权威校验在内核（kernel/workflow-dsl.validateWorkflow）；此处只做画布即时反馈，口径以内核为准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toFlow, fromFlow, deriveCapabilities, validateLocal, defaultConfig, nextNodeId, NODE_TYPES, checkWorkflowId, suggestCopyId, type WorkflowModel } from './workflowModel.ts'

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

// ===================== UI ↔ 内核字段口径守卫（A 项返工） =====================
// 目的：ConfigPanel/defaultConfig 写出的字段名/形状必须与内核执行器读取口径一致——
// 漂移一次就会「运行时抛错」或「配置被静默丢弃」，而这两类都躲过 typecheck。

/** 内核 kernel/workflow-dsl.mjs:352 normalizeNode 的摊平口径（config 展开到顶层，已存在的顶层键优先） */
function flattenNode(node: { id: string; type: string; config?: Record<string, any> }): Record<string, any> {
  const { config = {}, ...rest } = node as any
  const out: Record<string, any> = { ...rest }
  for (const [k, v] of Object.entries(config || {})) if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v
  return out
}

/** 每类型 = 内核读取口径：[config 允许键清单, 形状断言]（逐条对照 kernel/workflow-nodes.mjs） */
const KERNEL_CONTRACT: Record<string, { keys: string[]; check?: (n: any) => void }> = {
  start: { keys: [] },
  inputs: { keys: [] },
  llm: { keys: ['prompt', 'system', 'model', 'max_tokens', 'json_schema', 'timeout_ms'] },
  agent: { keys: ['prompt', 'query', 'system', 'tools', 'max_iters', 'model', 'timeout_ms'] },
  classify: {
    keys: ['input', 'query', 'instruction', 'classes', 'model'],
    check: (n) => {
      assert.ok(Array.isArray(n.classes) && n.classes.length > 0, 'classify.classes 必须是非空数组（内核缺失即 throw）')
      assert.ok(n.classes.every((c: any) => typeof c === 'string'), 'classify.classes 必须是字符串数组（内核 classes.map/findIndex）')
    },
  },
  extract: {
    keys: ['input', 'query', 'instruction', 'parameters', 'model'],
    check: (n) => {
      assert.ok(Array.isArray(n.parameters) && n.parameters.length > 0, 'extract.parameters 必须是非空数组（内核缺失即 throw）')
      assert.ok(n.parameters.every((p: any) => p && typeof p.name === 'string'), 'extract.parameters 每项必须有 name')
    },
  },
  code: { keys: ['code', 'variables', 'timeout_ms'] },
  template: { keys: ['template'] },
  http: {
    keys: ['url', 'method', 'headers', 'body', 'authorization', 'timeout', 'timeout_ms', 'retry'],
    check: (n) => {
      assert.equal(typeof n.headers, 'string', 'http.headers 必须是多行文本（parseHeaderLines 只认字符串）')
      const b = n.body
      assert.ok(b && typeof b === 'object' && !Array.isArray(b), 'http.body 必须是对象 {type,data[]|raw}（字符串会被静默丢弃）')
      if (b.type === 'json') assert.ok(Array.isArray(b.data), "body.type='json' 时 data 必须是数组")
      if (b.type === 'raw') assert.equal(typeof (b.raw ?? ''), 'string', "body.type='raw' 时 raw 必须是字符串")
    },
  },
  document: {
    keys: ['input', 'file'],
    check: (n) => assert.equal(typeof (n.input ?? n.file), 'string', 'document 必须有 input（或 file）——内核缺失即 throw「缺少 input」'),
  },
  list: { keys: ['variable', 'filter_by', 'order_by', 'extract_by'] },
  iterate: { keys: ['iterable', 'input', 'is_parallel', 'parallel_nums', 'body'] },
  loop: { keys: ['count', 'while_conditions', 'break_conditions', 'continue_on_error', 'max_duration_ms', 'body'] },
  memory: { keys: ['query', 'input', 'max_bytes'] },
  store: {
    keys: ['theme', 'topic', 'summary', 'full', 'content', 'tag'],
    check: (n) => {
      assert.equal(typeof (n.theme ?? n.topic), 'string', 'store 必须有 theme（内核缺失即 throw）')
      assert.equal(typeof n.summary, 'string', 'store 必须有 summary（内核缺失即 throw）')
    },
  },
  tool: { keys: ['tool', 'name', 'input'] },
  subworkflow: { keys: ['workflow', 'inputs'] },
  if: {
    keys: ['conditions', 'logical_operator'],
    check: (n) => {
      assert.ok(Array.isArray(n.conditions), 'if.conditions 必须是数组')
      for (const c of n.conditions) {
        assert.ok(c && typeof c === 'object' && 'var' in c && 'op' in c && 'value' in c, 'if 条件行形状必须是 {var,op,value}（evalCondition 读 cond.var/op/value）')
      }
    },
  },
  join: { keys: ['mode', 'sources', 'separator'] },
  assign: {
    keys: ['items'],
    check: (n) => {
      assert.ok(Array.isArray(n.items), 'assign.items 必须是数组（内核 for...of 读 it.variable/it.value）')
      assert.ok(n.items.every((it: any) => it && typeof it === 'object' && ('variable' in it || 'name' in it)), 'assign.items 每项必须有 variable')
    },
  },
  aggregate: {
    keys: ['variables', 'output_type', 'separator'],
    check: (n) => assert.ok(Array.isArray(n.variables), 'aggregate.variables 必须是数组（内核 .map 读 v.selector || v）'),
  },
  confirm: { keys: ['message', 'prompt', 'inputs', 'timeout_ms'] },
  answer: { keys: ['template', 'value', 'variable'] },
  end: {
    keys: ['outputs'],
    check: (n) => {
      assert.ok(Array.isArray(n.outputs), 'end.outputs 必须是数组（内核 for...of node.outputs，对象会抛 TypeError）')
      assert.ok(n.outputs.every((o: any) => o && typeof o === 'object' && (o.name || o.variable)), 'end.outputs 每项必须有 name 或 variable')
    },
  },
}

test('守卫：每种节点类型的默认 config 摊平后与内核读取口径一致（键名 + 形状）', () => {
  const types = NODE_TYPES.flatMap((g) => g.items).map((i) => i.type)
  for (const type of types) {
    const contract = KERNEL_CONTRACT[type]
    assert.ok(contract, `${type} 缺内核口径声明——新增节点类型必须同步 KERNEL_CONTRACT`)
    const flat = flattenNode({ id: 'x', type, config: defaultConfig(type) })
    // 断言对象必须是**摊平后的顶层键**（= config 的键）。Task 13 复审 Minor-1：
    // 原写法 `Object.keys(flat.config ?? {})` 恒为空数组——flattenNode 已把 config 解构掉，
    // 于是键名断言从不执行（守卫是死代码，UI 键名漂移无人拦截）。此处排除节点元数据键
    // （内核 NODE_META_KEYS 口径：id/type/label/position/retry/body/note），只留 config 摊平项。
    const META_KEYS = new Set(['id', 'type', 'label', 'position', 'retry', 'body', 'note'])
    const flatKeys = Object.keys(flat).filter((k) => !META_KEYS.has(k))
    if (contract.keys.length) {
      assert.ok(flatKeys.length > 0, `${type} 的 defaultConfig 摊平后无键——守卫失效（应至少有一个受检键）`)
    }
    for (const k of flatKeys) {
      assert.ok(contract.keys.includes(k), `${type}.${k} 不在内核读取键清单内（会被内核忽略 → 静默失效）`)
    }
    contract.check?.(flat)
  }
})

test('守卫：ConfigPanel 编辑口径回归（end.outputs 数组 / classify.classes / assign.items / http）', () => {
  // end 默认模板：数组（不是 KV 对象）
  assert.deepEqual(defaultConfig('end').outputs, [])
  // classify/extract/assign/aggregate：内核必填数组
  assert.ok(Array.isArray(defaultConfig('classify').classes))
  assert.ok(Array.isArray(defaultConfig('extract').parameters))
  assert.ok(Array.isArray(defaultConfig('assign').items))
  assert.ok(Array.isArray(defaultConfig('aggregate').variables))
  // http：headers 字符串 + body 由 type/data 驱动
  assert.equal(typeof defaultConfig('http').headers, 'string')
  assert.equal(defaultConfig('http').body.type, 'json')
  assert.ok(Array.isArray(defaultConfig('http').body.data))
  // document：内核读 input/file（无 path/mode）
  const doc = flattenNode({ id: 'd', type: 'document', config: defaultConfig('document') })
  assert.equal(typeof doc.input, 'string')
  assert.ok(!('path' in doc) && !('mode' in doc), 'document 不应再写内核不读的 path/mode')
  // if：条件行 {var,op,value}
  const cond = defaultConfig('if').conditions[0]
  assert.deepEqual(Object.keys(cond).sort(), ['op', 'value', 'var'])
})

test('nextNodeId：扫已有 n<数字> 取 max+1（避免与既有 id 撞车）', () => {
  const mk = (ids: string[]): WorkflowModel => ({ ...MODEL, nodes: ids.map((id) => ({ id, type: 'code' })) })
  assert.equal(nextNodeId(mk([]), ''), 'n1')
  assert.equal(nextNodeId(mk(['n1', 'n2']), ''), 'n3')
  // 只存在高位序号时不回填低位（避免与"未回写 model 的旧节点"撞）
  assert.equal(nextNodeId(mk(['n7']), ''), 'n8')
  // start/end 等手工 id 不干扰序号；preferred 可用时优先
  assert.equal(nextNodeId(mk(['start', 'end', 'n2']), ''), 'n3')
  assert.equal(nextNodeId(mk(['a']), 'a2'), 'a2')
  assert.equal(nextNodeId(mk(['a2']), 'a2'), 'n1')
})

test('checkWorkflowId / suggestCopyId：与 server/workflow-store.assertSafeId 同口径（Task 12 审查 I-1）', () => {
  // 合法
  for (const id of ['demo', 'a', 'my.flow', 'a_b-c.1', 'A'.repeat(64)]) assert.ok(checkWorkflowId(id).ok, `应合法: ${id}`)
  // 非法：字符集 / 首字符 / 超长 / 保留字 / Windows 设备名 / 尾点
  for (const id of ['', '-bad', '.bad', 'a b', 'a/b', '../x', 'a..b', 'a'.repeat(65), 'run', 'bindings', 'verify', 'nul', 'NUL.yml', 'com1', 'abc.']) {
    assert.equal(checkWorkflowId(id).ok, false, `应非法: ${id}`)
  }
  assert.match((checkWorkflowId('run') as any).error, /保留字/)
  assert.match((checkWorkflowId('nul.yml') as any).error, /设备名/)
  // 复制：常规加 -copy；超长 id 截断仍合法；撞名递增
  assert.equal(suggestCopyId('demo'), 'demo-copy')
  const long = suggestCopyId('x'.repeat(64))
  assert.ok(checkWorkflowId(long).ok, `超长 id 的复制名必须仍合法: ${long}`)
  assert.equal(suggestCopyId('demo', ['demo-copy']), 'demo-copy-2')
  assert.equal(suggestCopyId('demo', ['demo-copy', 'demo-copy-2']), 'demo-copy-3')
})
