// kernel/dyntools.mjs —— 工作流即工具：把每个工作流注册为具名工具（run_<slug>）。
// 可见性三态（wf.expose.mode）：private（仅面板手动运行，不入工具池）/ bound（仅
// bind_agents 列出的 agent 可见）/ public（全局注册）。schema 由 inputs 派生。
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { discoverWorkflowsAll, loadWorkflow } from './workflow-dsl.mjs'
import { listApps } from './app-spec.mjs'

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

// 动态工具总量上限（buildWorkflowTools 与 kernel/app-tools.mjs 共用同一口径）
export const LIMIT_DEFAULT = 20

// ===================== K1.2 工具视图缓存：盘面签名 =====================
// 动机（实测）：`registry.toolNames` / `isConcurrencySafe` / `toolSchemas` / `run` 每次访问
// 都回调 `dynamicView()`（tools.mjs:1496），即每迭代 ≈6 次求值 × 22.2ms（技能根 64 项
// readdir + 逐文件 loadWorkflow + registry/spec/binding 读取）= **132ms/步**，而结果恒为空。
// 缓存边界画在「工具表构造」上（cli.mjs 的 setDynamicTools 闭包内），失效键 = 本函数。
//
// 签名 = 全部不可变输入的指纹，三部分（**零 per-item stat**：实测大根逐项 stat 4.4ms/64 项、
// 递归 readdir 35.4ms/483 项，都会吃掉全部收益）：
//   ① 每个工作流根的**条目名列表（含类型）**：增/删/改名/改型 100% 正确，只付一次 readdir；
//   ② 上一轮发现**实际读过的**工作流文件 `(mtimeMs,size)`（来自 buildWorkflowTools 的
//      sourcePaths，即 discoverWorkflows 的 meta.path）：**编辑 100% 正确**，含被 legacy /
//      可见性 / 超限过滤掉的文件——它们一样决定工具池；
//   ③ 应用侧：每个 app root 的 registry.json / binding.json，以及**每个注册应用**的
//      `<appId>/spec.json`（用 listApps 取当前 id 集，与 app-tools.mjs 同一读入口，不会漂移）。
//
// **唯一残留（已在方案里登记）**：在**既存目录**内新增 `<dir>/workflow.yml` —— 名字列表
// 看不见（父目录名没变）、又不在 ② 的已知文件集里 ⇒ 要等该根条目增删、某个已知文件被编辑、
// 或重启内核才生效。常见写入路径均不受影响：GUI/面板新建工作流 = 新增目录名（① 覆盖）、
// 编辑已有工作流 = 文件条目（② 覆盖）、绑定/解绑应用 = binding.json（③ 覆盖）。
// 二期由桥侧 `tools_dirty` 显式失效信号收口（见方案 §K1.2）。
//
// 失败语义：**任何 stat 非 ENOENT 异常 ⇒ 返回 null ⇒ 调用方不缓存**（退化为现状"每次求值"）；
// ENOENT 是**合法稳定态**（该目录下没有 workflow.yml），记为 `-` 而不是异常——readdir 失败
// 同样记为 `-`，与 discoverWorkflows「读不到即空」的口径一致（否则"尚未创建工作流目录"这个
// 常见状态会永远不可缓存）。
const SIG_SEP = '\u0002'
const SIG_EQ = '\u0001'

/**
 * 工具视图缓存容器：**容量上限 + LRU**。
 * 范式 claude-code `utils/memoize.ts:227-269`——无上限的会话级 Map 曾涨到 300MB+ 才被迫
 * 换 LRU；本处键是签名串、值是工具表（含 description/schema），同理必须有界。命中即重插
 * 队尾 ⇒ 淘汰的总是最久未用者（Map 的插入序即 LRU 序）。
 * 键为 null（签名不可判定）时 get/set 均为 no-op ⇒ 调用方自然退化为"每次求值"。
 */
export function createToolsViewCache({ max = 8 } = {}) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 8
  const map = new Map()
  return {
    get(key) {
      if (!key) return null
      const hit = map.get(key)
      if (hit === undefined) return null
      map.delete(key)
      map.set(key, hit)
      return hit
    },
    set(key, value) {
      if (!key) return
      map.delete(key)
      map.set(key, value)
      while (map.size > cap) map.delete(map.keys().next().value)
    },
    get size() { return map.size },
    get max() { return cap },
  }
}

/** 文件指纹；`-` = ENOENT（合法稳定态）；null = 不可判定（调用方不得缓存） */
function statToken(path) {
  try {
    const s = statSync(path)
    return `${s.mtimeMs}.${s.size}`
  } catch (err) {
    return err?.code === 'ENOENT' ? '-' : null
  }
}

/** 条目名列表（目录带 `/` 后缀 → 名↔目录互转也算变化） */
function nameListToken(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .map((e) => e.name + (e.isDirectory() ? '/' : ''))
      .sort()
      .join(',')
  } catch { return '-' }
}

/**
 * 盘面签名（可证不陈旧的输入集见头注）。返回 null = 不可判定（不缓存）。
 * @param {{workflowRoots?: string[], workflowFiles?: string[], appRoots?: string[]}} p
 * @returns {string|null}
 */
export function toolSourceSignature({ workflowRoots = [], workflowFiles = [], appRoots = [] } = {}) {
  const parts = []
  for (const root of workflowRoots) {
    if (!root) continue
    parts.push(`w${SIG_EQ}${root}${SIG_EQ}${nameListToken(root)}`)
  }
  for (const f of workflowFiles) {
    if (!f) continue
    const t = statToken(f)
    if (t === null) return null
    parts.push(`f${SIG_EQ}${f}${SIG_EQ}${t}`)
  }
  for (const root of appRoots) {
    if (!root) continue
    for (const name of ['registry.json', 'binding.json']) {
      const t = statToken(join(root, name))
      if (t === null) return null
      parts.push(`a${SIG_EQ}${join(root, name)}${SIG_EQ}${t}`)
    }
  }
  // loadSpec 按 root 顺序「首个命中优先」：这里对每个 root 都取值 = 输入集的**超集**，
  // 多算只会多失效一次，绝不漏（漏才是陈旧）。
  for (const app of listApps({ roots: appRoots })) {
    for (const root of appRoots) {
      if (!root) continue
      const p = join(root, app.id, 'spec.json')
      const t = statToken(p)
      if (t === null) return null
      parts.push(`s${SIG_EQ}${p}${SIG_EQ}${t}`)
    }
  }
  return parts.join(SIG_SEP)
}

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
  // K1.2：本轮发现**实际读过**的文件全集（含 legacy、可见性未命中、超限被截断的——
  // 它们同样决定工具池，故必须进签名）。供 buildWorkflowTools 挂到 sourcePaths。
  const sources = []
  for (const m of discoverWorkflowsAll({ roots })) {
    if (m.path) sources.push(m.path)
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
  return { picked: publics.slice(0, limit), others, sources }
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
  const { picked, others, sources } = collectVisible({ roots, agentId, publicLimit })
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
  // K1.2：本轮发现读过的文件集（同上，非枚举）。调用方用它作下次盘面签名的文件级输入
  // ——必须在 `{...tools}` 展开**之前**取（展开只复制可枚举自有属性）。
  Object.defineProperty(tools, 'sourcePaths', { value: sources, enumerable: false })
  return tools
}
