// kernel/workflow-dsl.mjs —— 工作流 DSL v2：解析 / 变量 / 条件 / 发现 / 加载 / 校验
//
// DSL v2「edges 即真相」：节点执行顺序由 edges 决定，nodes 数组顺序不再具备语义
// （旧格式的迁移见 migrateLegacy，Task 2 落地）。
//
// DSL 结构（YAML 子集，零依赖解析）：
//   name/description/version/triggers   —— 元数据（triggers 与 skill 同 schema）
//   inputs: [{name, type, required}]    —— 入口参数（agentic 触发时注入）
//   nodes: [{id, type, label, position, config{...}, retry{...}}]
//   edges: [{id, source, target}]       —— 执行顺序唯一真相（无 edges = 旧格式）
// 节点专属配置写在 node.config（画布友好）；执行器读扁平字段 → 加载期摊平（normalizeNode）。
//
// 零外部运行时依赖：只 import node:* 与仓库内相对路径。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from './skills.mjs'

export const DSL_VERSION = 2

// ===================== 轻量 YAML 子集解析 =====================
// 支持：map、list（- item）、标量、多行块（key: |）、# 注释、引号、数字/bool。
// 仅覆盖 workflow DSL 结构（缩进层级树），零依赖。

export function splitKV(text) {
  const m = text.match(/^([^:]+):(?:\s+(.*))?$/)
  if (!m) return [text, undefined]
  return [m[1].trim(), m[2] !== undefined ? m[2].trim() : undefined]
}

// 内联流式集合（`[a, b]` / `{k: v, ...}`）的顶层逗号切分：跳过引号内与嵌套括号内的逗号
// （嵌套感知——`{ outputs: [{ name: text }] }` 才算一项）。
function splitFlow(inner) {
  const parts = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (const ch of inner) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

export function unquote(v) {
  const s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitFlow(inner).map((x) => unquote(x))
  }
  // 内联映射（画布友好：`config: { prompt: xxx }` / `retry: { max: 2 }` / 列表项 `- {id: a, ...}`）。
  // 任一部分不含 `k: v`（如代码串 `{ return 1 }`）→ 原样返回字符串，保持旧行为。
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return {}
    const obj = {}
    for (const part of splitFlow(inner)) {
      const [k, val] = splitKV(part)
      if (k === undefined) return s
      obj[k] = val === undefined ? {} : unquote(val)
    }
    return obj
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  return s
}

export function parseYaml(text) {
  const clean = []
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    clean.push({ indent: raw.match(/^\s*/)[0].length, text: raw.trim() })
  }
  const root = { indent: -1, text: '', children: [] }
  const stack = [root]
  for (const ln of clean) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= ln.indent) stack.pop()
    const node = { ...ln, children: [] }
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return treeToValue(root).value ?? {}
}

export function treeToValue(node) {
  const t = node.text
  // 根节点（text 空）：直接合并 children
  if (!t) {
    const obj = {}
    for (const child of node.children) Object.assign(obj, treeToValue(child).value)
    return { value: obj }
  }
  if (t.startsWith('- ')) {
    const rest = t.slice(2)
    if (node.children.length === 0) return { value: unquote(rest) }
    const [k, v] = splitKV(rest)
    if (k === undefined) return { value: node.children.map((c) => treeToValue(c).value) }
    const obj = {}
    if (v !== undefined) obj[k] = unquote(v)
    for (const child of node.children) {
      const cv = treeToValue(child)
      if (cv.value && typeof cv.value === 'object' && !Array.isArray(cv.value) && Object.keys(cv.value).length === 1) {
        const [ck, cvv] = Object.entries(cv.value)[0]
        obj[ck] = cvv
      } else if (cv.value && typeof cv.value === 'object') {
        Object.assign(obj, cv.value)
      } else {
        obj[k] = cv.value
      }
    }
    return { value: obj }
  }
  const [k, v] = splitKV(t)
  if (v === '|') {
    // 多行块：递归收集所有后代行（块内代码可能有更深缩进，如
    // `function main(inputs) {` 6 空格 + `const raw` 8 空格是父子关系）
    const lines = []
    const collect = (n) => {
      for (const c of n.children) { lines.push(c.text); collect(c) }
    }
    collect(node)
    return { value: { [k]: lines.join('\n') } }
  }
  if (v !== undefined) return { value: { [k]: unquote(v) } }
  if (node.children.length === 0) return { value: { [k]: {} } }
  if (node.children[0].text.startsWith('- ')) {
    return { value: { [k]: node.children.map((c) => treeToValue(c).value) } }
  }
  const obj = {}
  for (const child of node.children) Object.assign(obj, treeToValue(child).value)
  return { value: { [k]: obj } }
}

// ===================== 变量系统 =====================
// 变量环境：{ inputs: {...}, var: {...}, <nodeId>: {...} }
// 路径寻址："{{a.b.c}}" 或 "a.b.c"（去掉 {{}} 花括号后按 . 深路径访问）

export function resolvePath(vars, selector) {
  let path = String(selector ?? '').trim()
  const m = path.match(/^\{\{([\s\S]+)\}\}$/)
  if (m) path = m[1].trim()
  if (!path) return undefined
  // 支持 root.xxx 形式（if/list 局部求值时）
  const parts = path.split('.')
  let cur = vars
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

export function renderTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{([^}]+)\}\}/g, (m, expr) => {
    const v = resolvePath(vars, expr.trim())
    if (v === undefined) return ''
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
}

// ===================== 条件求值（对标 Dify if-else 比较符） =====================
export const OPS = {
  contains: (a, b) => String(a).includes(String(b)),
  'not contains': (a, b) => !String(a).includes(String(b)),
  is: (a, b) => String(a) === String(b),
  'is not': (a, b) => String(a) !== String(b),
  empty: (a) => a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0),
  'not empty': (a) => !(a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0)),
  'start with': (a, b) => String(a).startsWith(String(b)),
  'end with': (a, b) => String(a).endsWith(String(b)),
  '=': (a, b) => String(a) === String(b),
  '≠': (a, b) => String(a) !== String(b),
  '>': (a, b) => Number(a) > Number(b),
  '<': (a, b) => Number(a) < Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
}

export function evalCondition(cond, vars) {
  const actual = resolvePath(vars, cond.var || cond.variable_selector || '')
  const op = cond.op || cond.comparison_operator || 'is'
  const fn = OPS[op]
  if (!fn) throw new Error(`未知比较符: ${op}`)
  return fn(actual, cond.value)
}

// ===================== 发现与加载（与 skills.mjs 同构） =====================
// 目录形态：<root>/<id>/workflow.yml（与 SKILL.md 平级可同名配对）
// 平铺形态：<root>/<id>.yml（仅独立工作流，不与 skill 配对）

export function discoverWorkflows({ root } = {}) {
  if (!root || !existsSync(root)) return []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const wfs = []
  for (const it of entries) {
    let content = ''
    let id = ''
    if (it.isDirectory()) {
      const ymlPath = join(root, it.name, 'workflow.yml')
      if (!existsSync(ymlPath)) continue
      id = it.name
      try { content = readFileSync(ymlPath, 'utf-8') } catch { continue }
    } else if (it.isFile() && /\.(yml|yaml)$/.test(it.name)) {
      id = it.name.replace(/\.(yml|yaml)$/, '')
      try { content = readFileSync(join(root, it.name), 'utf-8') } catch { continue }
    } else continue
    const meta = parseFrontmatter(content)
    const parsed = parseYaml(content)
    const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
    wfs.push({
      id,
      name: meta.name || parsed.name || id,
      description: (meta.description || parsed.description || firstLine || id).slice(0, 300),
      version: meta.version || parsed.version || '',
      schedule: parsed.schedule || meta.schedule || '',
      triggers: Array.isArray(parsed.triggers)
        ? parsed.triggers.map(String)
        : meta.triggers ? String(meta.triggers).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : [],
      autoTrigger: parsed.auto_trigger === true || meta.auto_trigger === true,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
      lines: content.split('\n').length,
      // DSL v2：GUI 列表/工具池需要的能力声明 + 版本/旧格式标记
      expose: parsed.expose || {},
      permissions: parsed.permissions || {},
      dslVersion: DSL_VERSION,
      legacy: !Array.isArray(parsed.edges),
    })
  }
  return wfs.sort((a, b) => a.id.localeCompare(b.id))
}

export function discoverWorkflowsAll({ roots = [] } = {}) {
  const out = []
  const seen = new Set()
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    for (const w of discoverWorkflows({ root })) {
      if (!seen.has(w.id)) { seen.add(w.id); out.push(w) }
    }
  }
  return out
}

// 自动触发匹配：用户消息文本命中 auto_trigger 工作流的任一触发词（子串匹配）。
// 触发词长度 >= 2 防单字误触；按 workflows 顺序返回第一个命中的工作流。
export function matchAutoTrigger(workflows, text) {
  if (!text || !Array.isArray(workflows)) return null
  for (const w of workflows) {
    if (w.autoTrigger !== true) continue
    const trigs = (w.triggers || []).map((t) => String(t).trim()).filter((t) => t.length >= 2)
    if (trigs.some((t) => text.includes(t))) return w
  }
  return null
}

export function loadWorkflow({ roots = [], id } = {}) {
  if (!id) return null
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const dirYml = join(root, id, 'workflow.yml')
    if (existsSync(dirYml)) {
      try { return parseWorkflowFile(dirYml) } catch { continue }
    }
    for (const ext of ['.yml', '.yaml']) {
      const flatYml = join(root, `${id}${ext}`)
      if (existsSync(flatYml)) {
        try { return parseWorkflowFile(flatYml) } catch { continue }
      }
    }
  }
  return null
}

export function parseWorkflowFile(path) {
  const content = readFileSync(path, 'utf-8')
  const parsed = parseYaml(content)
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error(`workflow 缺少 nodes 列表: ${path}`)
  }
  return { ...normalizeWorkflow(parsed), path, dslVersion: DSL_VERSION }
}

// ===================== DSL v2：归一化 + 校验 =====================

// 节点专属配置写在 node.config（画布友好）；执行器读扁平字段 → 加载期摊平。
export function normalizeNode(n) {
  const { config = {}, ...rest } = n || {}
  return { ...rest, ...config }
}

export function normalizeWorkflow(wf) {
  return { ...(wf || {}), nodes: ((wf && wf.nodes) || []).map(normalizeNode), edges: Array.isArray(wf?.edges) ? wf.edges : null }
}

// 无向可达性（用于环检测与祖先判定）：edges 视为有向。
function buildGraph(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map(nodes.map((n) => [n.id, []]))
  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges || []) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    outgoing.get(e.source).push(e)
    incoming.get(e.target).push(e)
  }
  return { byId, incoming, outgoing }
}

export function detectCycle(nodes, edges) {
  const { byId, incoming, outgoing } = buildGraph(nodes, edges)
  const indeg = new Map([...byId.keys()].map((id) => [id, incoming.get(id).length]))
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const seen = new Set()
  while (q.length) {
    const id = q.shift()
    seen.add(id)
    for (const e of outgoing.get(id)) {
      const d = indeg.get(e.target) - 1
      indeg.set(e.target, d)
      if (d === 0) q.push(e.target)
    }
  }
  return seen.size === byId.size ? null : [...byId.keys()].filter((id) => !seen.has(id))
}

// 所有字符串字段里的 {{selector}} 引用（递归遍历节点值）
function collectRefs(node) {
  const out = []
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{([^}]+)\}\}/g)) out.push(m[1].trim())
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(node)
  return out
}

const LOCAL_SCOPES = new Set(['inputs', 'var', 'item', 'index', 'iter', 'root'])

export function validateWorkflow(wf) {
  const errors = []
  const warnings = []
  const nodes = Array.isArray(wf?.nodes) ? wf.nodes : []
  if (!nodes.length) errors.push({ code: 'NO_NODES', message: 'nodes 为空' })
  if (!Array.isArray(wf?.edges)) {
    errors.push({ code: 'LEGACY_DSL', message: '缺少 edges：旧格式（数组顺序执行）不再支持，请用 migrateLegacy 迁移' })
    return { ok: false, errors, warnings }
  }
  const ids = new Set()
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
  const edges = wf.edges
  for (const e of edges) {
    if (!e?.id) errors.push({ code: 'BAD_EDGE', message: '边缺少 id' })
    if (e && !ids.has(e.source)) errors.push({ code: 'DANGLING_EDGE', edge: e.id, message: `边 ${e.id} source 不存在: ${e.source}` })
    if (e && !ids.has(e.target)) errors.push({ code: 'DANGLING_EDGE', edge: e.id, message: `边 ${e.id} target 不存在: ${e.target}` })
  }
  // 子图边界：body 成员必须存在；边不得跨主图/子图
  const bodyOf = new Map()
  for (const n of nodes) {
    if ((n.type === 'loop' || n.type === 'iterate') && Array.isArray(n.body)) {
      for (const b of n.body) {
        if (!ids.has(b)) errors.push({ code: 'BODY_MEMBER_MISSING', node: n.id, message: `节点 ${n.id} 的 body 成员不存在: ${b}` })
        bodyOf.set(b, n.id)
      }
    }
  }
  for (const e of edges) {
    if (!e || !ids.has(e.source) || !ids.has(e.target)) continue
    const sb = bodyOf.get(e.source)
    const tb = bodyOf.get(e.target)
    if (sb !== tb) errors.push({ code: 'BODY_ESCAPE', edge: e.id, message: `边 ${e.id} 跨越子图边界（${e.source} → ${e.target}）` })
  }
  // 环检测：主图 + 每个 body 子图
  const main = nodes.filter((n) => !bodyOf.has(n.id))
  const mainCycle = detectCycle(main, edges.filter((e) => !bodyOf.has(e.source) && !bodyOf.has(e.target)))
  if (mainCycle) errors.push({ code: 'CYCLE', message: `主图存在环: ${mainCycle.join(' → ')}` })
  for (const owner of new Set(bodyOf.values())) {
    const members = nodes.filter((n) => bodyOf.get(n.id) === owner)
    const subEdges = edges.filter((e) => bodyOf.get(e.source) === owner && bodyOf.get(e.target) === owner)
    const c = detectCycle(members, subEdges)
    if (c) errors.push({ code: 'CYCLE', node: owner, message: `子图 ${owner} 存在环: ${c.join(' → ')}` })
  }
  // 变量可达性：{{nodeId.field}} 的 nodeId 必须是同作用域内的祖先节点
  const { incoming } = buildGraph(nodes, edges)
  const ancestorsOf = (id) => {
    const seen = new Set()
    const stack = [...(incoming.get(id) || []).map((e) => e.source)]
    while (stack.length) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const e of incoming.get(cur) || []) stack.push(e.source)
    }
    return seen
  }
  for (const n of nodes) {
    const anc = ancestorsOf(n.id)
    for (const ref of collectRefs(n)) {
      const root = ref.split('.')[0]
      if (LOCAL_SCOPES.has(root) || root === n.id) continue
      if (!ids.has(root)) errors.push({ code: 'VAR_UNKNOWN', node: n.id, message: `节点 ${n.id} 引用未知变量 {{${ref}}}` })
      else if (!anc.has(root) && bodyOf.get(root) === bodyOf.get(n.id)) {
        errors.push({ code: 'VAR_UNREACHABLE', node: n.id, message: `节点 ${n.id} 引用非上游节点 {{${ref}}}` })
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}
