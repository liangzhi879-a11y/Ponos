// kernel/workflow.mjs —— 工作流引擎（对标 Dify 功能，自有 DSL 技术路线）
//
// 与 skill 平权协同：同一发现机制（workflow.yml 目录 + 平铺 .yml）、共享 triggers
// 触发词；定位差异：skill=灵活处理（模型自由执行），workflow=严格输出（确定性
// DAG 执行 + 节点级审计哈希链）。可互调：skill 脚本中调用 Workflow 工具；工作流
// tool 节点可调用 Skill 工具加载技能脚本。
//
// DSL 结构（YAML 子集，零依赖解析）：
//   name/description/version/triggers   —— 元数据（triggers 与 skill 同 schema）
//   inputs: [{name, type, required}]    —— 入口参数（agentic 触发时注入）
//   nodes:                              —— 节点列表（默认按数组顺序执行）
//     - id/type/配置...
//   next 字段显式跳转；if 节点 next_true/next_false 分支；end 终止。
//
// 节点类型（P1，对标 Dify 15/26）：
//   start/end/llm/code/template/if/assign/aggregate/http/document/tool/list
//
// 审计：每节点 {ts,node,type,status,dur_ms,out_hash,prev} 哈希链落盘
//   ~/.ponos/workflow-runs/<name>/<ts>-<runId>.jsonl，verifyRun 验完整性。

import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { parseFrontmatter } from './skills.mjs'
import { streamMessages } from './api.mjs'

// ===================== 轻量 YAML 子集解析 =====================
// 支持：map、list（- item）、标量、多行块（key: |）、# 注释、引号、数字/bool。
// 仅覆盖 workflow DSL 结构（缩进层级树），零依赖。

function splitKV(text) {
  const m = text.match(/^([^:]+):(?:\s+(.*))?$/)
  if (!m) return [text, undefined]
  return [m[1].trim(), m[2] !== undefined ? m[2].trim() : undefined]
}

function unquote(v) {
  const s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
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

function treeToValue(node) {
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
    return { value: { [k]: node.children.map((c) => c.text).join('\n') } }
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

function resolvePath(vars, selector) {
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
const OPS = {
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

function evalCondition(cond, vars) {
  const actual = resolvePath(vars, cond.var || cond.variable_selector || '')
  const op = cond.op || cond.comparison_operator || 'is'
  const fn = OPS[op]
  if (!fn) throw new Error(`未知比较符: ${op}`)
  return fn(actual, cond.value)
}

// ===================== 审计（哈希链） =====================
function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex')
}

function auditAppend(auditPath, node, r, prevHash) {
  try { mkdirSync(dirname(auditPath), { recursive: true }) } catch { /* ignore */ }
  const rec = {
    ts: new Date().toISOString(),
    node: node.id,
    type: node.type,
    status: r.ok ? 'done' : 'failed',
    dur_ms: r.dur_ms ?? 0,
    out_hash: sha256(JSON.stringify(r.output ?? r.error ?? '')),
    prev: prevHash,
  }
  const line = JSON.stringify(rec)
  try { appendFileSync(auditPath, line + '\n') } catch { /* 审计失败不阻断执行 */ }
  return sha256(line)
}

export function verifyRun(auditPath) {
  if (!existsSync(auditPath)) return { ok: false, error: '审计文件不存在', lines: 0 }
  let lines
  try { lines = readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean) } catch (e) { return { ok: false, error: e.message, lines: 0 } }
  let prev = '-'
  let tampered = null
  for (let i = 0; i < lines.length; i++) {
    let rec
    try { rec = JSON.parse(lines[i]) } catch { tampered = { line: i + 1, reason: 'parse error' }; break }
    if (rec.prev !== prev) { tampered = { line: i + 1, expected: prev, got: rec.prev }; break }
    prev = sha256(lines[i])
  }
  return { ok: !tampered, lines: lines.length, tampered, lastHash: prev }
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
      triggers: Array.isArray(parsed.triggers)
        ? parsed.triggers.map(String)
        : meta.triggers ? String(meta.triggers).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : [],
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
      lines: content.split('\n').length,
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

function parseWorkflowFile(path) {
  const content = readFileSync(path, 'utf-8')
  const parsed = parseYaml(content)
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error(`workflow 缺少 nodes 列表: ${path}`)
  }
  return { ...parsed, path }
}

// ===================== 节点执行器 =====================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function execLLM(node, ctx) {
  const model = node.model || ctx.getModel()
  if (!model) throw new Error('llm 节点缺少 model（未配置 provider）')
  const prompt = renderTemplate(node.prompt || '', ctx.vars)
  const system = renderTemplate(node.system || '', ctx.vars)
  const maxTokens = node.max_tokens || 4096
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: prompt },
  ]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), node.timeout_ms || 60_000)
  let text = ''
  try {
    for await (const chunk of streamMessages({ model, messages, maxTokens, signal: ctrl.signal })) {
      if (chunk.type === 'text') text += chunk.text
    }
  } finally { clearTimeout(timer) }
  if (node.json_schema) {
    try { text = JSON.parse(text) } catch { /* 非 JSON 保留原文 */ }
  }
  return { output: text, next: node.next }
}

function execCode(node, ctx) {
  const code = node.code || ''
  const inputVars = {}
  for (const v of node.variables || []) {
    inputVars[v.variable || v.name] = resolvePath(ctx.vars, v.selector || v.value || '')
  }
  const sandbox = createContext({ inputs: inputVars, JSON, Math, Date, console })
  const result = runInContext(`(function(){ ${code}\n; return typeof main === 'function' ? main(inputs) : inputs })()`, sandbox, {
    timeout: node.timeout_ms || 10_000,
  })
  return { output: result, next: node.next }
}

function execTemplate(node, ctx) {
  return { output: renderTemplate(node.template || '', ctx.vars), next: node.next }
}

function execIf(node, ctx) {
  const conds = node.conditions || []
  const logic = node.logical_operator || 'and'
  const pass = logic === 'or' ? conds.some((c) => evalCondition(c, ctx.vars)) : conds.every((c) => evalCondition(c, ctx.vars))
  return { output: { pass }, next: pass ? node.next_true || node.next : node.next_false || node.next }
}

function execAssign(node, ctx) {
  const items = node.items || []
  for (const it of items) {
    const name = it.variable || it.name
    if (!name) continue
    const val = resolvePath(ctx.vars, it.value || it.selector || '')
    const cur = ctx.vars.var[name]
    const op = it.operation || 'over-write'
    if (op === 'append') {
      ctx.vars.var[name] = Array.isArray(cur) ? [...cur, val] : (cur !== undefined ? [cur, val] : [val])
    } else if (op === 'clear') {
      ctx.vars.var[name] = null
    } else {
      ctx.vars.var[name] = val
    }
  }
  return { output: ctx.vars.var, next: node.next }
}

function execAggregate(node, ctx) {
  const vars = node.variables || []
  const outType = node.output_type || 'string'
  if (outType === 'array') {
    return { output: vars.map((v) => resolvePath(ctx.vars, v.selector || v)), next: node.next }
  }
  const sep = node.separator ?? '\n'
  return { output: vars.map((v) => String(resolvePath(ctx.vars, v.selector || v) ?? '')).join(sep), next: node.next }
}

async function execHttp(node, ctx) {
  const url = renderTemplate(node.url || '', ctx.vars)
  if (!url) throw new Error('http 节点缺少 url')
  const method = (node.method || 'GET').toUpperCase()
  const headers = {}
  for (const [k, v] of Object.entries(renderTemplate(node.headers || '', ctx.vars) ? parseHeaderLines(node.headers) : {})) headers[k] = v
  let body
  if (node.body) {
    const bt = node.body.type || 'json'
    if (bt === 'json') {
      const data = {}
      for (const d of node.body.data || []) data[d.key] = renderTemplate(String(d.value ?? ''), ctx.vars)
      body = JSON.stringify(data)
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
    } else if (bt === 'raw') {
      body = renderTemplate(String(node.body.raw || ''), ctx.vars)
    }
  }
  const auth = node.authorization || {}
  if (auth.type === 'bearer') headers['Authorization'] = `Bearer ${renderTemplate(String(auth.token || ''), ctx.vars)}`
  if (auth.type === 'api-key') headers[auth.header || 'X-API-Key'] = renderTemplate(String(auth.token || ''), ctx.vars)
  const timeout = (node.timeout || {}).read || node.timeout_ms || 60_000
  const retry = node.retry?.enabled ? Math.max(0, Number(node.retry.max_retries || 1)) : 0
  let attempt = 0
  let lastErr
  while (attempt <= retry) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal })
      const text = await res.text()
      let parsed = text
      try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
      return {
        output: { status_code: res.status, body: parsed, headers: Object.fromEntries(res.headers) },
        next: node.next,
      }
    } catch (err) {
      lastErr = err
      attempt++
      if (attempt <= retry) await sleep(Math.min(500 * Math.pow(2, attempt - 1), 10_000))
    } finally { clearTimeout(timer) }
  }
  throw lastErr || new Error('http 请求失败')
}

function parseHeaderLines(headersStr) {
  const out = {}
  for (const line of String(headersStr || '').split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

async function execDocument(node, ctx) {
  const filePath = renderTemplate(node.input || node.file || '', ctx.vars)
  if (!filePath) throw new Error('document 节点缺少 input')
  const readRes = await ctx.registry.run({ name: 'Read', input: { file_path: filePath } }, {})
  if (!readRes.isError) return { output: { text: readRes.content }, next: node.next }
  const ocrRes = await ctx.registry.run({ name: 'OCR', input: { file_path: filePath } }, {})
  if (!ocrRes.isError) return { output: { text: ocrRes.content }, next: node.next }
  throw new Error(`document 读取失败: ${filePath}（${String(readRes.content).slice(0, 120)}）`)
}

async function execTool(node, ctx) {
  const name = node.tool || node.name
  if (!name) throw new Error('tool 节点缺少 tool 字段')
  const input = {}
  for (const [k, v] of Object.entries(node.input || {})) input[k] = renderTemplate(String(v), ctx.vars)
  const res = await ctx.registry.run({ name, input }, {})
  return { output: res.content, isError: res.isError === true, next: node.next }
}

function execList(node, ctx) {
  const arr = resolvePath(ctx.vars, node.variable || '')
  if (!Array.isArray(arr)) throw new Error(`list 节点输入不是数组: ${node.variable}`)
  let out = [...arr]
  if (node.filter_by?.enabled && node.filter_by.key && node.filter_by.op) {
    out = out.filter((item) => evalCondition({ var: node.filter_by.key, op: node.filter_by.op, value: node.filter_by.value }, { root: item }))
  }
  if (node.order_by?.enabled && node.order_by.key) {
    const key = node.order_by.key
    out.sort((a, b) => {
      const av = a?.[key]; const bv = b?.[key]
      if (node.order_by.order === 'desc') return bv > av ? 1 : bv < av ? -1 : 0
      return av > bv ? 1 : av < bv ? -1 : 0
    })
  }
  if (node.extract_by?.enabled) {
    const serial = node.extract_by.serial || 'first'
    if (serial === 'first') out = out[0]
    else if (serial === 'last') out = out[out.length - 1]
  }
  return { output: out, next: node.next }
}

async function executeNode(node, ctx) {
  const t0 = Date.now()
  try {
    let result
    switch (node.type) {
      case 'start': result = { output: { ...ctx.inputs }, next: node.next }; break
      case 'end': {
        const out = {}
        for (const o of node.outputs || []) out[o.variable || o.name] = resolvePath(ctx.vars, o.selector || o.value || o.variable || '')
        result = { output: out, next: null }
        break
      }
      case 'llm': result = await execLLM(node, ctx); break
      case 'code': result = execCode(node, ctx); break
      case 'template': result = execTemplate(node, ctx); break
      case 'if': result = execIf(node, ctx); break
      case 'assign': result = execAssign(node, ctx); break
      case 'aggregate': result = execAggregate(node, ctx); break
      case 'http': result = await execHttp(node, ctx); break
      case 'document': result = await execDocument(node, ctx); break
      case 'tool': result = await execTool(node, ctx); break
      case 'list': result = execList(node, ctx); break
      default: throw new Error(`未知节点类型: ${node.type}`)
    }
    return { ok: true, ...result, dur_ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, error: err.message || String(err), dur_ms: Date.now() - t0 }
  }
}

// ===================== 引擎（执行循环 + 审计 + 事件） =====================
// createWorkflowEngine({ configDir, registry, onEvent, getModel, signal })
//   configDir: 审计落盘根（<configDir>/workflow-runs/...）
//   registry:  createToolRegistry 返回值（tool/document 节点调用）
//   onEvent:   ({type:'start'|'node'|'end', ...}) 事件回调（wire/TUI/GUI 复用）
//   getModel:  () => 默认模型名（llm 节点未指定时）
//   signal:    { aborted } 工作流级取消标志

export function createWorkflowEngine({ configDir = '', registry, onEvent, getModel, signal } = {}) {
  const roots = []
  let _configDir = configDir
  let _registry = registry
  let _onEvent = onEvent || (() => {})
  let _getModel = getModel || (() => process.env.ANTHROPIC_MODEL || '')
  let _signal = signal || { aborted: false }

  function setDeps(deps = {}) {
    if (deps.configDir !== undefined) _configDir = deps.configDir
    if (deps.registry !== undefined) _registry = deps.registry
    if (deps.onEvent !== undefined) _onEvent = deps.onEvent || (() => {})
    if (deps.getModel !== undefined) _getModel = deps.getModel
    if (deps.signal !== undefined) _signal = deps.signal
  }

  function event(type, payload) {
    try { _onEvent({ type, ...payload }) } catch { /* 事件失败不阻断 */ }
  }

  async function run({ id, inputs = {}, mode = 'sync' } = {}) {
    const wf = loadWorkflow({ roots, id })
    if (!wf) return { ok: false, error: `工作流不存在: ${id}` }
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const auditPath = _configDir ? join(_configDir, 'workflow-runs', wf.name || id, `${ts}-${runId}.jsonl`) : ''
    const vars = { inputs: { ...inputs }, var: {}, root: {} }
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]))
    // start 节点：无则用第一个节点
    let cur = wf.nodes.find((n) => n.type === 'start') || wf.nodes[0]
    const visited = new Set()
    const results = {}
    let prevHash = '-'
    event('start', { runId, workflow: wf.name || id, nodes: wf.nodes.length, mode })
    let nextId = cur.id
    let steps = 0
    while (nextId && !_signal.aborted) {
      if (steps > 500) return { ok: false, error: '执行步数超限（可能死循环）', runId, auditPath }
      if (visited.has(nextId)) return { ok: false, error: `节点循环检测: ${nextId}`, runId, auditPath }
      visited.add(nextId)
      const node = nodes.get(nextId)
      if (!node) return { ok: false, error: `未知节点: ${nextId}`, runId, auditPath }
      const ctx = { vars, results, inputs, registry: _registry, signal: _signal, getModel: _getModel }
      const r = await executeNode(node, ctx)
      results[node.id] = r
      if (r.ok) {
        vars[node.id] = r.output
        if (typeof r.output === 'object' && r.output !== null) Object.assign(vars.root, r.output)
      }
      prevHash = auditPath ? auditAppend(auditPath, node, r, prevHash) : prevHash
      event('node', { runId, node: node.id, type: node.type, status: r.ok ? 'done' : 'failed', dur_ms: r.dur_ms, output: r.ok ? r.output : undefined, error: r.ok ? undefined : r.error })
      if (!r.ok && node.on_error !== 'continue') {
        event('end', { runId, status: 'failed', error: r.error, steps: steps + 1 })
        return { ok: false, error: r.error, node: node.id, runId, auditPath }
      }
      // 确定下一个节点：节点 next 显式 → if 分支已定 → 否则数组顺序
      nextId = r.next !== undefined && r.next !== null ? r.next : null
      if (!nextId) {
        const idx = wf.nodes.findIndex((n) => n.id === cur.id)
        if (idx >= 0 && idx < wf.nodes.length - 1) nextId = wf.nodes[idx + 1].id
      }
      cur = nodes.get(nextId) || cur
      steps++
    }
    const status = _signal.aborted ? 'cancelled' : 'completed'
    event('end', { runId, status, steps })
    return { ok: true, status, outputs: results, runId, auditPath, steps }
  }

  return {
    run,
    setDeps,
    discover: (root) => discoverWorkflows({ root }),
    load: (id) => loadWorkflow({ roots, id }),
    verify: (auditPath) => verifyRun(auditPath),
    addRoot: (root) => { if (root && !roots.includes(root)) roots.push(root) },
  }
}
