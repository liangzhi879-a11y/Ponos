// kernel/dyntools.mjs —— 工作流即工具：把每个工作流注册为具名工具（run_<slug>）。
// 可见性三态（wf.expose.mode）：private（仅面板手动运行，不入工具池）/ bound（仅
// bind_agents 列出的 agent 可见）/ public（全局注册）。schema 由 inputs 派生。
import { discoverWorkflowsAll, loadWorkflow } from './workflow-dsl.mjs'

// 短哈希（FNV-1a 32bit → 6 位 hex）：跨进程/平台稳定、零依赖，仅作重名消歧后缀。
export function shortHash(s) {
  let h = 0x811c9dc5
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

// id → 工具名。非 ASCII id（如中文目录「周报」）清洗后为空（或仅剩 `run_`），
// 若统一回退成 `run_workflow`，多个 CJK 工作流会坍缩同名并被静默覆盖（丢工作流）；
// 故此类 id 追加 id 短哈希保证唯一。ASCII id 的名称保持原样（零变化）。
export function slugToToolName(id) {
  const raw = String(id ?? '')
  const s = raw.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!s || s === 'run') return `run_${s || 'workflow'}_${shortHash(raw)}`
  return `run_${s}`
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

// public 截断的稳定顺序：全部带 updatedAt 时按更新时间降序（最近优先），否则按 id
// 字节序（不用 localeCompare——其顺序随 locale 变化，实测中文会排在英文前）。
function orderPublics(list) {
  const allDated = list.length > 1 && list.every((x) => x.wf.updatedAt)
  const byId = (a, b) => { const x = a.wf.id || '', y = b.wf.id || ''; return x < y ? -1 : x > y ? 1 : 0 }
  return [...list].sort((a, b) => {
    if (allDated) {
      const ta = String(a.wf.updatedAt), tb = String(b.wf.updatedAt)
      if (ta !== tb) return ta < tb ? 1 : -1
    }
    return byId(a, b)
  })
}

// 发现 → 装载 → 可见性过滤 → public 稳定截断（工具池与提示词清单共用同一口径）。
function collectVisible({ roots = [], agentId = null, publicLimit = LIMIT_DEFAULT } = {}) {
  const visible = []
  for (const m of discoverWorkflowsAll({ roots })) {
    if (m.legacy) continue                       // 旧格式：不可运行，不入池（GUI 提示升级）
    let loaded = null
    try { loaded = loadWorkflow({ roots, id: m.id }) } catch { loaded = null }
    if (!loaded) continue
    // loadWorkflow 返回的是文件内容（不含 id，id 由发现根/目录名决定）——补回 id
    // 作工具目标，否则引擎 run({id}) 拿不到工作流。
    const wf = loaded.id ? loaded : { ...loaded, id: m.id }
    const vis = visibilityOf(wf, agentId)
    if (!vis) continue
    visible.push({ wf, meta: m, vis })
  }
  const publics = orderPublics(visible.filter((x) => x.vis === 'public'))
  const others = visible.filter((x) => x.vis !== 'public')
  const n = Number(publicLimit)
  const limit = Number.isFinite(n) && n >= 0 ? Math.floor(n) : LIMIT_DEFAULT
  return { picked: publics.slice(0, limit), others }
}

// 提示词/清单侧可见集合（I-3）：与工具池同一可见性口径（private / bound 未命中 /
// 超限 public / legacy 一律不出现），只返回发现元数据供 composeSystemPrompt 渲染。
export function listVisibleWorkflows({ roots = [], agentId = null, publicLimit = LIMIT_DEFAULT } = {}) {
  const { picked, others } = collectVisible({ roots, agentId, publicLimit })
  return [...picked, ...others].map((x) => x.meta).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// 构建动态工具表：可见集合 → 具名工具（名字冲突不覆盖，追加哈希后缀并告警）。
export function buildWorkflowTools({ roots = [], engine, agentId = null, publicLimit = LIMIT_DEFAULT } = {}) {
  const tools = {}
  const conflicts = []
  const { picked, others } = collectVisible({ roots, agentId, publicLimit })
  for (const { wf } of [...picked, ...others]) {
    const preferred = (wf.expose && wf.expose.tool_name) || slugToToolName(wf.id || wf.name)
    let name = preferred
    if (Object.hasOwn(tools, name)) {
      // I-1：同名不再静默覆盖（否则后者吃掉前者 = 丢工作流）——追加哈希后缀保两者可用。
      const alt = `${preferred}_${shortHash(wf.id || wf.name || name)}`
      name = alt
      for (let i = 2; Object.hasOwn(tools, name); i++) name = `${alt}${i}`
      conflicts.push({ id: wf.id, preferred, resolved: name })
      console.warn(`[dyntools] 工具名冲突：${preferred} 已被占用，工作流「${wf.id}」注册为 ${name}`)
    }
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
  // 冲突明细挂非枚举属性：不进工具表视图（Object.keys / 展开不可见），供诊断与测试读取。
  Object.defineProperty(tools, 'nameConflicts', { value: conflicts, enumerable: false })
  return tools
}
