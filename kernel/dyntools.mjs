// kernel/dyntools.mjs —— 工作流即工具：把每个工作流注册为具名工具（run_<slug>）。
// 可见性三态（wf.expose.mode）：private（仅面板手动运行，不入工具池）/ bound（仅
// bind_agents 列出的 agent 可见）/ public（全局注册）。schema 由 inputs 派生。
import { discoverWorkflowsAll, loadWorkflow } from './workflow-dsl.mjs'

export function slugToToolName(id) {
  const s = String(id || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `run_${s || 'workflow'}`
}

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

export function deriveInputSchema(inputs = []) {
  const properties = {}
  const required = []
  for (const it of inputs || []) {
    const name = it?.name
    if (!name) continue
    const t = JSON_TYPES.has(it.type) ? it.type : 'string'
    properties[name] = { type: t, ...(it.description ? { description: String(it.description) } : {}) }
    if (it.required === true) required.push(name)
  }
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }
}

export function deriveToolDescription(wf) {
  const ins = (wf.inputs || []).map((i) => `${i.name}${i.required ? '(必填)' : ''}`).join('、')
  const base = wf.description || wf.name || wf.id
  const tail = ins ? ` 输入参数：${ins}。` : ''
  return `运行工作流「${wf.name || wf.id}」：${base}${tail}（确定性流程执行，带审计留痕）`
}

export function visibilityOf(wf, agentId) {
  const expose = wf?.expose || {}
  const mode = expose.mode || 'private'
  if (mode === 'public') return 'public'
  if (mode === 'bound') {
    if (!agentId) return null
    const list = Array.isArray(expose.bind_agents) ? expose.bind_agents.map(String) : []
    return list.includes(String(agentId)) ? 'bound' : null
  }
  return null
}

// 工具名视图过滤：静态名单 + 动态工具名合并去重（静态同名优先，保持既有顺序）。
// 供 toolNames / toolSchemas 等视图消费方拼接（本文件 attachDynamicTools 即用）。
export function filterToolNames(names, tools) {
  const out = []
  const seen = new Set()
  for (const n of names || []) {
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  for (const n of Object.keys(tools || {})) {
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

const LIMIT_DEFAULT = 20

// 构建动态工具表：roots 下发现 → 按可见性过滤 → public 超限按发现顺序截断。
export function buildWorkflowTools({ roots = [], engine, agentId = null, publicLimit = LIMIT_DEFAULT } = {}) {
  const tools = {}
  const metas = discoverWorkflowsAll({ roots })
  const visible = []
  for (const m of metas) {
    if (m.legacy) continue                       // 旧格式：不可运行，不入池（GUI 提示升级）
    let loaded = null
    try { loaded = loadWorkflow({ roots, id: m.id }) } catch { loaded = null }
    if (!loaded) continue
    // loadWorkflow 返回的是文件内容（不含 id，id 由发现根/目录名决定）——补回 id
    // 作工具目标，否则引擎 run({id}) 拿不到工作流。
    const wf = loaded.id ? loaded : { ...loaded, id: m.id }
    const vis = visibilityOf(wf, agentId)
    if (!vis) continue
    visible.push({ wf, vis })
  }
  const publics = visible.filter((x) => x.vis === 'public')
  const others = visible.filter((x) => x.vis !== 'public')
  const picked = publics.length > publicLimit ? publics.slice(0, publicLimit) : publics
  for (const { wf } of [...picked, ...others]) {
    const name = (wf.expose && wf.expose.tool_name) || slugToToolName(wf.id || wf.name)
    tools[name] = {
      description: deriveToolDescription(wf),
      input_schema: deriveInputSchema(wf.inputs),
      concurrencySafe: false,
      run: async (input) => {
        if (!engine?.run) return { content: '工作流引擎不可用', isError: true }
        const r = await engine.run({ id: wf.id, inputs: input || {} })
        if (!r.ok) return { content: `工作流「${wf.id}」执行失败: ${r.error}${r.node ? `（节点 ${r.node}）` : ''}`, isError: true }
        const out = r.finalOutput ?? r.outputs ?? {}
        return { content: `工作流「${wf.id}」执行完成（${r.status}，${r.steps} 步）\n审计: ${r.auditPath || '未落盘'}\n输出: ${JSON.stringify(out, null, 2)}`, isError: false }
      },
    }
  }
  return tools
}
