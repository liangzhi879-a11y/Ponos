// src/lib/workflowModel.ts —— 工作流画布模型（UI Task 13）：DSL ⇄ 画布转换 + 能力推导 + 本地快速校验
//
// 定位（与 spec §2 一致）：
//   · 画布是编辑态，**DSL 是唯一真相**——本文件只做无损双向转换，不新增持久化字段；
//   · 本地校验 `validateLocal` 仅作画布即时反馈（悬空/环/变量不可达），**权威校验在内核**
//     `kernel/workflow-dsl.validateWorkflow`（保存时经 PUT /workflows/:id 由内核复核，
//     两处口径不一致时以后端为准，见 Task 13 brief 风险②）；
//   · 本文件是纯逻辑（无 React / 无 DOM / 无 import.meta），可直接 node 单测。
//
// 与内核字段对齐：节点元数据键 = id/type/label/position/retry/on_error/body（见 kernel
// workflow-dsl NODE_META_KEYS），其余自定义字段一律落 `config`（`toModel` 的收拢规则）。

export interface NodePosition { x: number; y: number }

export interface NodeModel {
  id: string
  type: string
  label?: string
  position?: NodePosition
  /** 重试策略（内核）：{ max?: number; delay_ms?: number; on_error?: 'fail'|'continue'|'branch' } */
  retry?: { max?: number; delay_ms?: number; on_error?: string } & Record<string, unknown>
  /** 节点级错误策略（内核兼容旧写法）；与 retry.on_error 同义，两者可同时存在 */
  on_error?: string
  /** loop / iterate 的子图成员（节点 id 列表） */
  body?: string[]
  /** 节点配置（类型相关字段的统一落点） */
  config?: Record<string, any>
}

export interface EdgeModel {
  id: string
  source: string
  target: string
  /** 条件边：'true' | 'false'（if）、'route:<i>'（classify）、'fail'（错误分支）、
   *  'approved' | 'rejected' | 'timeout'（confirm）、'default'（兜底） */
  sourceHandle?: string
}

export interface WorkflowInput { name: string; type?: string; required?: boolean; description?: string }

export interface WorkflowModel {
  name: string
  description?: string
  version?: string
  triggers?: string[]
  trigger_config?: Record<string, any>
  settings?: { max_parallel?: number } & Record<string, any>
  inputs?: WorkflowInput[]
  nodes: NodeModel[]
  edges: EdgeModel[]
  expose?: { mode?: string; tool_name?: string; bind_agents?: string[] }
  permissions?: { tools?: string[]; write_dirs?: string[]; network?: boolean }
}

/** 节点运行状态（RunDrawer 事件 → 画布着色；Task 14 消费同一份类型） */
export type NodeRunStatus = 'idle' | 'running' | 'done' | 'failed' | 'skipped'

/** 画布节点（@xyflow/react Node 的本地收窄形态：data 里带 DSL 语义）
 *  注：用 type 别名（非 interface）以便直接喂给 xyflow 的 Node 泛型（隐式索引签名）。 */
export type FlowNode = {
  id: string
  type: 'yfw'
  position: NodePosition
  data: { label: string; nodeType: string; config: Record<string, any>; status?: NodeRunStatus }
}

export type FlowEdge = { id: string; source: string; target: string; sourceHandle?: string; data?: { state?: 'active' | 'skipped' } }

export interface Capabilities { tools: string[]; write_dirs: string[]; network: boolean }

export interface ValidationIssue { code: string; message: string; node?: string; edge?: string }
export interface LocalValidation { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

/** 列表项视觉态由 workflowApi.runStatusOf 负责；此处只管画布着色。 */

/**
 * 运行状态注入（Task 14 的 RunDrawer 消费点）：把 nodeStatus/edgeState 叠到画布元素上。
 * 纯函数——画布每次渲染用它包一层，不改变 DSL（data.status 不落盘：fromFlow 只回填白名单字段）。
 */
export function withRunState(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  nodeStatus: Record<string, NodeRunStatus> = {},
  edgeState: Record<string, 'active' | 'skipped'> = {},
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: nodes.map((n) => ({ ...n, data: { ...n.data, status: nodeStatus[n.id] ?? 'idle' } })),
    edges: edges.map((e) => ({ ...e, data: { ...(e.data ?? {}), ...(edgeState[e.id] ? { state: edgeState[e.id] } : {}) } })),
  }
}

// ===================== 节点类型目录（Dify 式分组，spec §6） =====================

export interface NodeTypeItem { type: string; label: string; hint: string }
export interface NodeTypeGroup { group: string; items: NodeTypeItem[] }

export const NODE_TYPES: NodeTypeGroup[] = [
  { group: '输入', items: [{ type: 'start', label: '开始', hint: '工作流入口' }, { type: 'inputs', label: '输入参数', hint: '在右侧面板定义 inputs' }] },
  { group: '模型', items: [{ type: 'llm', label: '大模型', hint: '单次生成' }, { type: 'classify', label: '分类', hint: '按类别路由' }, { type: 'extract', label: '字段提取', hint: 'JSON schema 抽取' }, { type: 'agent', label: '智能体', hint: 'ReAct 循环 + 工具' }] },
  { group: '处理', items: [{ type: 'code', label: '代码', hint: '沙箱 JS' }, { type: 'template', label: '模板', hint: '变量拼接' }, { type: 'http', label: 'HTTP', hint: '请求外部接口' }, { type: 'document', label: '文档读取', hint: 'Read/OCR' }, { type: 'list', label: '列表', hint: '过滤/排序/取值' }, { type: 'iterate', label: '迭代', hint: '并行遍历数组' }, { type: 'loop', label: '循环', hint: '定次/条件循环' }, { type: 'memory', label: '记忆检索', hint: '经验库查询' }, { type: 'store', label: '记忆写入', hint: '沉淀经验' }] },
  { group: '工具', items: [{ type: 'tool', label: '工具调用', hint: '调用内置/自定义工具' }, { type: 'subworkflow', label: '子工作流', hint: '复用另一工作流' }] },
  { group: '流程', items: [{ type: 'if', label: '条件分支', hint: 'true/false 双路' }, { type: 'join', label: '汇聚', hint: '多分支合并' }, { type: 'assign', label: '变量赋值', hint: '写 var' }, { type: 'aggregate', label: '聚合', hint: '拼装输出' }, { type: 'confirm', label: '人工审批', hint: '挂起等待批准' }] },
  { group: '输出', items: [{ type: 'answer', label: '回答', hint: '对话型输出' }, { type: 'end', label: '结束', hint: '定义返回值' }] },
]

/** type → 中文名（节点卡片标题兜底 + 配置面板标题） */
export const NODE_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  NODE_TYPES.flatMap((g) => g.items).map((i) => [i.type, i.label]),
)

export function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABEL[type] || type
}

/** 条件/分支型节点：出边按 handle 分色（if/classify/confirm）；其余节点单出口 */
export const BRANCH_TYPES = ['if', 'classify', 'confirm'] as const

/** handle → 语义色（WorkflowNode 与 ConfigPanel 共用一份映射，避免两处漂移） */
export type HandleTone = 'true' | 'false' | 'route' | 'fail' | 'approve' | 'reject' | 'timeout' | 'plain'
export function handleTone(handle?: string): HandleTone {
  if (!handle) return 'plain'
  if (handle === 'true') return 'true'
  if (handle === 'false') return 'false'
  if (handle === 'fail') return 'fail'
  if (handle === 'approved') return 'approve'
  if (handle === 'rejected') return 'reject'
  if (handle === 'timeout') return 'timeout'
  if (handle.startsWith('route:') || handle === 'default') return 'route'
  return 'plain'
}

/** 节点出边 handle 清单：条件节点按 config 展开（classify 的 routes → route:i；confirm 三态） */
export function outputHandles(node: NodeModel): Array<{ id: string; label: string; tone: HandleTone }> {
  const handles: Array<{ id: string; label: string; tone: HandleTone }> = []
  if (node.type === 'if') {
    handles.push({ id: 'true', label: '是', tone: 'true' }, { id: 'false', label: '否', tone: 'false' })
  } else if (node.type === 'classify') {
    // 内核 execClassify 读 **node.classes: string[]**（下标 i → 出边 handle route:i）；
    // legacy 对象数组（旧 UI 写过的 routes:[{name}]）仍兼容展示，避免老文件画布上空白。
    const cfg = node.config || {}
    const classes: string[] = Array.isArray(cfg.classes)
      ? cfg.classes.map((c: any) => String(c ?? ''))
      : Array.isArray(cfg.routes)
        ? cfg.routes.map((r: any, i: number) => String(r?.name || r?.label || r?.category || `类别${i + 1}`))
        : []
    classes.forEach((c, i) => {
      handles.push({ id: `route:${i}`, label: c || `类别${i + 1}`, tone: 'route' })
    })
    if (!classes.length) handles.push({ id: 'route:0', label: '类别1', tone: 'route' })
    handles.push({ id: 'default', label: '兜底', tone: 'route' })
  } else if (node.type === 'confirm') {
    handles.push({ id: 'approved', label: '通过', tone: 'approve' }, { id: 'rejected', label: '拒绝', tone: 'reject' }, { id: 'timeout', label: '超时', tone: 'timeout' })
  }
  if (retryOnError(node) === 'branch') handles.push({ id: 'fail', label: '失败', tone: 'fail' })
  return handles
}

/** 错误策略：retry.on_error 优先，回退节点级 on_error（内核两种写法都读） */
export function retryOnError(node: NodeModel): string {
  return String(node.retry?.on_error || node.on_error || '')
}

// ===================== 新节点默认配置（节点面板拖入时用） =====================

/**
 * 新节点的默认配置（节点面板拖入时用）。
 *
 * **键名/形状一律以 `kernel/workflow-nodes.mjs` 的执行器读取口径为准**（摊平后即
 * `normalizeNode` 产出的扁平 node 字段）；ConfigPanel 的编辑器与这里同源，
 * `workflowModel.test.ts` 的守卫用例逐类型断言，防止 UI 与内核再次漂移。
 */
export function defaultConfig(type: string): Record<string, any> {
  switch (type) {
    case 'llm': return { prompt: '', system: '', model: '' }
    // execAgent：prompt / system / tools[] / max_iters
    case 'agent': return { prompt: '', system: '', tools: [], max_iters: 8 }
    // execClassify：input（或 query）/ instruction / classes: string[]（缺失即 throw）
    case 'classify': return { input: '', instruction: '', classes: ['类别1', '类别2'] }
    // execExtract：input（或 query）/ instruction / parameters: [{name,type?,required?,description?}]
    case 'extract': return { input: '', instruction: '', parameters: [{ name: 'field1', type: 'string', required: true, description: '' }] }
    case 'code': return { code: '' }
    case 'template': return { template: '' }
    // execHttp：headers 是**多行文本**（parseHeaderLines）；body 只认 {type:'json',data[]} | {type:'raw',raw}
    case 'http': return { url: '', method: 'GET', headers: '', body: { type: 'json', data: [] }, authorization: { type: 'none', token: '', header: '' }, timeout_ms: 60000 }
    // execDocument：input（回退 file）；先 Read 后 OCR，无 mode
    case 'document': return { input: '' }
    // execList：variable / filter_by / order_by / extract_by
    case 'list': return {
      variable: '',
      filter_by: { enabled: false, key: '', op: 'is', value: '' },
      order_by: { enabled: false, key: '', order: 'asc' },
      extract_by: { enabled: false, serial: 'first' },
    }
    // execIterate：iterable（回退 input）/ is_parallel / parallel_nums（body 由画布 BodyPicker 写）
    case 'iterate': return { iterable: '', is_parallel: false, parallel_nums: 1 }
    // execLoop：count / while_conditions / break_conditions / continue_on_error
    case 'loop': return { count: 1, while_conditions: [], break_conditions: [], continue_on_error: false }
    case 'memory': return { query: '', max_bytes: 2048 }
    // execStore：theme + summary 必填（缺失即 throw），tag / full（回退 content）可选
    case 'store': return { theme: '', summary: '', tag: '', full: '' }
    case 'tool': return { tool: '', input: {} }
    case 'subworkflow': return { workflow: '', inputs: {} }
    // execIf / evalCondition：conditions 行形状 {var, op, value}
    case 'if': return { conditions: [{ var: '', op: 'is', value: '' }], logical_operator: 'and' }
    // execJoin：sources[]（选择器）+ mode + separator
    case 'join': return { mode: 'concat', sources: [], separator: '\n' }
    // execAssign：items: [{variable, value, operation}]
    case 'assign': return { items: [{ variable: '', value: '', operation: 'over-write' }] }
    // execAggregate：variables[] + output_type(string|array) + separator
    case 'aggregate': return { variables: [], output_type: 'string', separator: '\n' }
    case 'confirm': return { message: '', inputs: [] }
    case 'answer': return { template: '' }
    // end：**数组**（{name, variable?, selector}）——内核 for...of，对象会抛 TypeError
    case 'end': return { outputs: [] }
    default: return {}
  }
}

// ===================== DSL ⇄ 画布 =====================

const toFlowNode = (n: NodeModel): FlowNode => ({
  id: n.id,
  type: 'yfw',
  position: n.position ?? { x: 0, y: 0 },
  data: { label: n.label || nodeTypeLabel(n.type), nodeType: n.type, config: n.config ?? {} },
})

export function toFlow(model: WorkflowModel): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: (model.nodes || []).map(toFlowNode),
    edges: (model.edges || []).map((e) => ({
      id: e.id, source: e.source, target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    })),
  }
}

/**
 * 画布 → DSL：**画布是位置/config 的真相**，base 提供其余字段（name/inputs/expose/权限）。
 * 仅回填白名单字段，ReactFlow 的临时字段（selected/dragging/measured/width/height…）一律剔除，
 * 保证落盘 YAML 干净、版本 diff 只有真实改动。
 */
export function fromFlow(flowNodes: readonly any[], flowEdges: readonly any[], base: WorkflowModel): WorkflowModel {
  const baseById = new Map((base.nodes || []).map((n) => [n.id, n]))
  const nodes: NodeModel[] = flowNodes.map((fn: any) => {
    const prev = baseById.get(fn?.id)
    const type = String(fn?.data?.nodeType || prev?.type || 'code')
    const config = fn?.data?.config
    const out: NodeModel = { id: String(fn?.id), type }
    const label = fn?.data?.label ?? prev?.label
    if (label) out.label = String(label)
    const pos = fn?.position
    if (pos) out.position = { x: Number(pos.x) || 0, y: Number(pos.y) || 0 }
    // body/retry/on_error 画布不编辑（配置面板只管 config），原样保留
    if (prev?.body) out.body = [...prev.body]
    if (prev?.retry) out.retry = { ...prev.retry }
    if (prev?.on_error) out.on_error = prev.on_error
    if (config && Object.keys(config).length) out.config = config
    return out
  })
  const edges: EdgeModel[] = flowEdges.map((fe: any) => ({
    id: String(fe?.id),
    source: String(fe?.source),
    target: String(fe?.target),
    ...(fe?.sourceHandle ? { sourceHandle: String(fe.sourceHandle) } : {}),
  }))
  return { ...base, nodes, edges }
}

// ===================== 能力推导（运行前授权清单，宿主 mergeCapabilities 的输入） =====================

/** 节点类型 → 隐含工具（与内核节点实现的实际工具落点一致） */
const CAP_TOOLS: Record<string, string[]> = {
  document: ['Read', 'OCR'],
  memory: ['Read'],
  store: ['Write'],
}

/** 写类工具：命中才需要 write_dirs 授权（宿主按 cwd 判定相对路径，见 Task 11） */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * 从声明 + 节点推导运行能力清单。字段名与宿主 mergeCapabilities 一致：
 * `{ tools, write_dirs, network }`。**从宽推导**（宁可多问一次，不可静默放行）：
 * 用到的工具全部列出，用户在授权卡里逐项勾除；勾除项在本次运行内 fail-closed。
 */
export function deriveCapabilities(model: WorkflowModel): Capabilities {
  const tools = new Set<string>(model.permissions?.tools ?? [])
  let network = model.permissions?.network === true
  for (const n of model.nodes || []) {
    if (n.type === 'http') network = true
    for (const t of CAP_TOOLS[n.type] ?? []) tools.add(t)
    if (n.type === 'tool' || n.type === 'agent') {
      const t = n.config?.tool
      if (t) tools.add(String(t))
      const list = n.config?.tools
      if (Array.isArray(list)) for (const x of list) if (x) tools.add(String(x))
    }
  }
  return { tools: [...tools].sort(), write_dirs: model.permissions?.write_dirs ?? [], network }
}

// ===================== 本地快速校验（权威在内核） =====================

/** 模板本地作用域（内核 LOCAL_SCOPES）：不需要上游可达性检查 */
const LOCAL_SCOPES = new Set(['inputs', 'var', 'item', 'index', 'iter', 'root'])

/** 递归收集节点所有字符串字段里的 {{ref}}（与内核 collectRefs 同口径） */
export function collectRefs(node: NodeModel): string[] {
  const out: string[] = []
  const walk = (v: any) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{([^}]+)\}\}/g)) out.push(m[1].trim())
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(node.config ?? {})
  return out
}

/** 节点的祖先集合（含 body 子图的入边；画布不编辑 body，按主线图判可达即可） */
export function ancestorsOf(model: WorkflowModel, id: string): Set<string> {
  const incoming = new Map<string, EdgeModel[]>()
  for (const e of model.edges || []) {
    if (!incoming.has(e.target)) incoming.set(e.target, [])
    incoming.get(e.target)!.push(e)
  }
  const seen = new Set<string>()
  const stack = (incoming.get(id) || []).map((e) => e.source)
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const e of incoming.get(cur) || []) stack.push(e.source)
  }
  return seen
}

/** 变量选择器候选：上游可达节点 + inputs（ConfigPanel 消费）。
 *  每个上游节点固定给一条 `{{<id>}}`（整输出——内核 scalar 输出节点如 llm/template 的正确引用），
 *  再按 suggestFields 给字段级候选。 */
export function reachableVars(model: WorkflowModel, nodeId: string): Array<{ path: string; label: string }> {
  const out: Array<{ path: string; label: string }> = []
  const anc = ancestorsOf(model, nodeId)
  for (const n of model.nodes || []) {
    if (n.id === nodeId || !anc.has(n.id)) continue
    out.push({ path: `{{${n.id}}}`, label: `${n.label || n.id} · 整输出` })
    for (const f of suggestFields(n)) out.push({ path: `{{${n.id}.${f}}}`, label: `${n.label || n.id} · ${f}` })
  }
  for (const inp of model.inputs || []) {
    out.push({ path: `{{inputs.${inp.name}}}`, label: `输入 · ${inp.name}` })
  }
  return out
}

/** 节点输出字段名（按 kernel/workflow-nodes.mjs 各 exec* 的 return 形状；取不到就整体引用） */
export function suggestFields(node: NodeModel): string[] {
  switch (node.type) {
    case 'llm': case 'template': case 'answer': case 'tool': case 'code': case 'join': case 'aggregate': case 'iterate': return []
    case 'memory': return ['text', 'keywords']
    case 'agent': return ['text', 'iters', 'tool_uses']
    case 'http': return ['status_code', 'body', 'headers']
    case 'extract': return ['_raw']
    case 'classify': return ['category', 'class_index', 'raw']
    case 'list': return []
    case 'document': return ['text']
    case 'loop': return ['results', 'iterations', 'broken']
    case 'subworkflow': return []
    case 'assign': return ['var']
    case 'if': return ['pass']
    case 'confirm': return ['action', 'comment']
    case 'store': return ['ok', 'theme', 'tag']
    case 'start': return []
    case 'end': return []
    default: return []
  }
}

/** 环检测（Kahn）：返回环上残留节点 id 列表，无环返回 null */
function detectCycle(nodes: NodeModel[], edges: EdgeModel[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  const outgoing = new Map<string, EdgeModel[]>()
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    outgoing.set(e.source, [...(outgoing.get(e.source) || []), e])
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1)
  }
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const seen = new Set<string>()
  while (q.length) {
    const id = q.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of outgoing.get(id) || []) {
      const d = (indeg.get(e.target) || 0) - 1
      indeg.set(e.target, d)
      if (d === 0) q.push(e.target)
    }
  }
  return seen.size === byId.size ? null : [...byId.keys()].filter((id) => !seen.has(id))
}

/**
 * 本地快速校验：错误码与内核 validateWorkflow 同名同义（NO_NODES / NO_START / MULTI_START /
 * DUP_NODE_ID / DANGLING_EDGE / CYCLE / VAR_UNKNOWN / VAR_UNREACHABLE），另有 NO_END 警告。
 * **仅作画布即时反馈**——保存/运行前仍以后端 `/workflows/:id/validate` 为准。
 */
export function validateLocal(model: WorkflowModel): LocalValidation {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const nodes = model.nodes || []
  const edges = model.edges || []

  if (!nodes.length) errors.push({ code: 'NO_NODES', message: 'nodes 为空' })

  const ids = new Set<string>()
  for (const n of nodes) {
    if (!n?.id) errors.push({ code: 'BAD_NODE', message: '节点缺少 id' })
    else if (ids.has(n.id)) errors.push({ code: 'DUP_NODE_ID', node: n.id, message: `节点 id 重复: ${n.id}` })
    else ids.add(n.id)
  }

  const nStart = nodes.filter((n) => n.type === 'start').length
  if (nStart !== 1) errors.push({ code: nStart ? 'MULTI_START' : 'NO_START', message: `需要且仅需要一个 start 节点（当前 ${nStart}）` })
  if (!nodes.some((n) => n.type === 'end' || n.type === 'answer')) {
    warnings.push({ code: 'NO_END', message: '无 end/answer 节点：作为工具调用时回退最后成功节点的输出' })
  }

  const edgeIds = new Set<string>()
  for (const e of edges) {
    if (!e?.id) errors.push({ code: 'BAD_EDGE', message: '边缺少 id' })
    else if (edgeIds.has(e.id)) errors.push({ code: 'DUP_EDGE', edge: e.id, message: `边 id 重复: ${e.id}` })
    else edgeIds.add(e.id)
    if (e && !ids.has(e.source)) errors.push({ code: 'DANGLING_EDGE', edge: e.id, message: `边 ${e.id} source 不存在: ${e.source}` })
    if (e && !ids.has(e.target)) errors.push({ code: 'DANGLING_EDGE', edge: e.id, message: `边 ${e.id} target 不存在: ${e.target}` })
  }

  const cyc = detectCycle(nodes, edges)
  if (cyc) errors.push({ code: 'CYCLE', message: `存在环: ${cyc.join(' → ')}` })

  // 变量可达性：{{nodeId.field}} 的 nodeId 必须是祖先节点（本地作用域不检查）
  for (const n of nodes) {
    if (!n?.id) continue
    const anc = ancestorsOf(model, n.id)
    for (const ref of collectRefs(n)) {
      const root = ref.split('.')[0]
      if (LOCAL_SCOPES.has(root) || root === n.id) continue
      if (!ids.has(root)) errors.push({ code: 'VAR_UNKNOWN', node: n.id, message: `节点 ${n.id} 引用未知变量 {{${ref}}}` })
      else if (!anc.has(root)) errors.push({ code: 'VAR_UNREACHABLE', node: n.id, message: `节点 ${n.id} 引用非上游节点 {{${ref}}}` })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** 画布即时提示用的一行摘要（悬空/环优先展示；无问题时给保存前提示） */
export function summarizeLocal(v: LocalValidation): { level: 'ok' | 'warn' | 'error'; text: string } {
  if (v.errors.length) {
    const first = v.errors[0]
    return { level: 'error', text: v.errors.length > 1 ? `${first.code}: ${first.message}（共 ${v.errors.length} 项）` : `${first.code}: ${first.message}` }
  }
  if (v.warnings.length) return { level: 'warn', text: `${v.warnings[0].code}: ${v.warnings[0].message}` }
  return { level: 'ok', text: '本地检查通过（保存时仍以后端校验为准）' }
}

/** 新建工作流的最小可用模型（面板「新建」用） */
export function emptyModel(name: string): WorkflowModel {
  return {
    name,
    version: '1.0.0',
    inputs: [],
    nodes: [
      { id: 'start', type: 'start', label: '开始', position: { x: 40, y: 120 } },
      { id: 'end', type: 'end', label: '结束', position: { x: 400, y: 120 } },
    ],
    edges: [{ id: 'e1_start_end', source: 'start', target: 'end' }],
    expose: { mode: 'private' },
  }
}

/** 画布中新节点的 id：扫已有 `n<数字>` 取 **max+1**（不复用低位序号 → 与已有/历史 id 都不撞车）；
 *  preferred 可用时优先用（NodePalette 传空串，走序号路径）。 */
export function nextNodeId(model: WorkflowModel, preferred: string): string {
  const used = new Set((model.nodes || []).map((n) => n.id))
  if (preferred && !used.has(preferred)) return preferred
  let max = 0
  for (const id of used) {
    const m = /^n(\d+)$/.exec(String(id))
    if (m) max = Math.max(max, Number(m[1]))
  }
  let i = max + 1
  while (used.has(`n${i}`)) i++
  return `n${i}`
}

/** 画布中新边的 id（确定性：源→目标→handle，重复连线自动加序号；内核要求边 id 唯一） */
export function nextEdgeId(existing: readonly EdgeModel[], source: string, target: string, handle?: string): string {
  const base = `e_${source}_${target}${handle ? '_' + String(handle).replace(/[^\w]/g, '') : ''}`
  const used = new Set(existing.map((e) => e.id))
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

// ===================== 工作流 id 前端预校验（Task 12 审查 I-1；权威在 server/workflow-store.assertSafeId） =====================

/** id 字符集：首字符字母/数字，其余字母数字与 . _ -，总长 ≤64（与 store 的 SAFE_ID 逐字一致） */
const WF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 保留字：与 /workflows/<sub> 的动作子路由冲突（用它们建流会永远打不开） */
/** 节点不可删除的守卫：start 是内核要求的唯一入口（删了工作流不可运行）。 */
function isProtectedNode(node: NodeModel): boolean {
  return node.type === 'start'
}

const REF_RE = /\{\{\s*([^}]+?)\s*\}\}/g

/** 递归清空"引用了已删节点"的模板片段，返回清理处数（只动字符串，保留其余结构）。 */
function scrubRefsDeep(value: unknown, gone: ReadonlySet<string>): { value: unknown; scrubbed: number } {
  if (typeof value === 'string') {
    let scrubbed = 0
    const next = value.replace(REF_RE, (whole, path) => {
      const root = String(path).trim().split('.')[0]
      if (!gone.has(root)) return whole
      scrubbed++
      return ''
    })
    return { value: next, scrubbed }
  }
  if (Array.isArray(value)) {
    let scrubbed = 0
    const out = value.map((v) => { const r = scrubRefsDeep(v, gone); scrubbed += r.scrubbed; return r.value })
    return { value: out, scrubbed }
  }
  if (value && typeof value === 'object') {
    let scrubbed = 0
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = scrubRefsDeep(v, gone)
      scrubbed += r.scrubbed
      out[k] = r.value
    }
    return { value: out, scrubbed }
  }
  return { value, scrubbed: 0 }
}

export interface RemoveNodesResult {
  model: WorkflowModel
  /** 被拒绝删除的节点 id（start） */
  blocked: string[]
  /** 清理说明（UI 展示给用户；删除是破坏性操作，必须说清动了什么） */
  warnings: string[]
}

/**
 * 删除节点并做**语义清理**：相连边、loop/iterate 的 body 成员、他处悬空变量引用。
 * 悬空引用必须清空——内核校验对 `{{已删节点.x}}` 报 VAR_UNREACHABLE 会**拒绝保存**，
 * 只警告不清会变成"删了却存不了"（2026-09-12 人工测试暴露的体验缺口）。
 * 纯函数：返回新对象，不原地修改入参。
 */
export function removeNodesFromModel(model: WorkflowModel, ids: readonly string[]): RemoveNodesResult {
  const wanted = new Set(ids.filter(Boolean))
  const blocked = model.nodes.filter((n) => wanted.has(n.id) && isProtectedNode(n)).map((n) => n.id)
  const gone = new Set([...wanted].filter((id) => !blocked.includes(id)))
  const blockedNote = blocked.length ? ['开始节点不可删除（工作流必须有唯一入口）'] : []
  if (!gone.size) return { model, blocked, warnings: blockedNote }

  const keptNodes: NodeModel[] = []
  let bodyCleaned = 0
  for (const n of model.nodes) {
    if (gone.has(n.id)) continue
    if (Array.isArray(n.body) && n.body.some((b) => gone.has(b))) {
      const kept = n.body.filter((b) => !gone.has(b))
      bodyCleaned += n.body.length - kept.length
      keptNodes.push({ ...n, body: kept })
      continue
    }
    keptNodes.push(n)
  }
  const keptEdges = model.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target))
  const edgesRemoved = model.edges.length - keptEdges.length

  let scrubbed = 0
  const cleanedNodes = keptNodes.map((n) => {
    const r = scrubRefsDeep(n, gone)
    scrubbed += r.scrubbed
    return r.value as NodeModel
  })

  const names = model.nodes.filter((n) => gone.has(n.id)).map((n) => `「${n.label || n.id}」`)
  const warnings: string[] = [`已删除 ${names.join('、')}`]
  if (edgesRemoved) warnings.push(`移除相连连线 ${edgesRemoved} 条`)
  if (bodyCleaned) warnings.push(`从 ${bodyCleaned} 处子图成员中摘除`)
  if (scrubbed) warnings.push(`清空 ${scrubbed} 处悬空变量引用（否则保存会被内核拒绝）`)
  warnings.push(...blockedNote)

  return { model: { ...model, nodes: cleanedNodes, edges: keptEdges }, blocked, warnings }
}

/** 删除连线（节点不受影响；纯函数）。 */
export function removeEdgesFromModel(model: WorkflowModel, ids: readonly string[]): WorkflowModel {
  const gone = new Set(ids.filter(Boolean))
  if (!gone.size) return model
  return { ...model, edges: model.edges.filter((e) => !gone.has(e.id)) }
}


/** Windows 保留设备名（`nul/workflow.yml` 会写进设备，仓库既往有 nul 事故记录） */
const WF_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/

/**
/** 系统保留字：与 /workflows/<子路由> 冲突（用了会导致该工作流永远打不开） */
export const WF_RESERVED_IDS = ['run', 'stop', 'confirm', 'runs', 'import', 'export', 'bindings', 'verify', 'validate']

/**
 * 新建/复制前的前端预校验：不合法就**就地在 UI 提示**，不发请求（后端 assertSafeId 会抛 400，
 * 让用户看到"HTTP 400 非法工作流 id"是糟糕体验）。口径与 server/workflow-store.mjs 保持一致——
 * 前端放宽就等于把错误推给后端，前端收紧则误伤合法 id。
 */
export function checkWorkflowId(id: string): { ok: true } | { ok: false; error: string } {
  const s = String(id ?? '')
  if (!s) return { ok: false, error: '请输入工作流 id' }
  if (!WF_ID_RE.test(s) || s.includes('..')) {
    return { ok: false, error: 'id 只能含字母/数字/._-（首字符须为字母或数字），长度 1-64' }
  }
  if (/[. ]$/.test(s)) return { ok: false, error: 'id 不得以点或空格结尾' }
  const upper = s.toUpperCase()
  if (WF_DEVICE_RE.test(upper) || WF_DEVICE_RE.test(s.split('.')[0].toUpperCase())) {
    return { ok: false, error: `「${s}」是 Windows 保留设备名，请换一个 id` }
  }
  if (WF_RESERVED_IDS.includes(s)) {
    return { ok: false, error: `「${s}」是系统保留字（保留：${WF_RESERVED_IDS.join('、')}），请换一个 id` }
  }
  return { ok: true }
}

/** 复制工作流的默认新 id：`<id>-copy`；超长则截断到合法长度，撞名/仍非法则追加 `-2`、`-3`… */
export function suggestCopyId(id: string, existing: readonly string[] = []): string {
  const used = new Set(existing.map(String))
  const base = String(id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 59) || 'wf'
  let cand = `${base}-copy`
  if (!checkWorkflowId(cand).ok || used.has(cand)) {
    // 截短到允许 `-N` 后缀（≤64），再逐个试到不撞名且合法
    const stem = String(id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 56) || 'wf'
    let i = 2
    do { cand = `${stem}-copy-${i++}` } while (!checkWorkflowId(cand).ok || used.has(cand))
  }
  return cand
}
