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
import { createServer } from 'node:http'
import { parseFrontmatter } from './skills.mjs'
import { streamMessages } from './api.mjs'
import { buildRelevantMemory, appendMemoryEntry } from './memory.mjs'

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
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((x) => unquote(x.trim()))
  }
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
      schedule: parsed.schedule || meta.schedule || '',
      triggers: Array.isArray(parsed.triggers)
        ? parsed.triggers.map(String)
        : meta.triggers ? String(meta.triggers).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : [],
      autoTrigger: parsed.auto_trigger === true || meta.auto_trigger === true,
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

// 公共 LLM 文本请求（llm/classify/extract 共用）：模板渲染 prompt → 流式聚合文本 →
// 可选 JSON 解析。返回聚合文本（json_schema 时可能为解析后的对象）
async function callLLMText(model, prompt, node, vars, maxTokens = 4096) {
  const system = node.system ? renderTemplate(node.system, vars) : ''
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
    const m = text.match(/\{[\s\S]*\}/)
    try { text = JSON.parse(m ? m[0] : text) } catch { /* 非 JSON 保留原文 */ }
  }
  return text
}

// agent 节点：工作流内嵌 ReAct 循环（独立对话，不污染主会话 transcript）。
// 工具执行走 registry（权限/边界/高危钩子沿用）；tools 白名单可选，缺省全量。
async function runAgentLoop({ prompt, system = '', tools = [], model, signal, registry, maxIters = 8, timeoutMs = 120_000 }) {
  if (!model) throw new Error('agent 节点缺少 model（未配置 provider）')
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  const allSchemas = registry?.toolSchemas ? registry.toolSchemas() : []
  const schemas = tools && tools.length ? allSchemas.filter((t) => tools.includes(t.name)) : allSchemas
  let text = ''
  for (let i = 0; i < maxIters; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const toolUses = []
    let roundText = ''
    try {
      for await (const chunk of streamMessages({ model, messages, maxTokens: 8192, signal: ctrl.signal, tools: schemas })) {
        if (chunk.type === 'text') roundText += chunk.text
        else if (chunk.type === 'tool_use') toolUses.push(chunk)
      }
    } finally { clearTimeout(timer) }
    if (!toolUses.length) return { text: roundText || text, iters: i + 1, tool_uses: i }
    text = roundText
    messages.push({
      role: 'assistant',
      content: [
        ...(roundText ? [{ type: 'text', text: roundText }] : []),
        ...toolUses.map((tu) => ({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })),
      ],
    })
    const results = []
    for (const tu of toolUses) {
      try {
        const r = await registry.run({ name: tu.name, input: tu.input }, {})
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(r?.content ?? '').slice(0, 20000), is_error: r?.isError === true })
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `执行异常: ${err?.message || String(err)}`, is_error: true })
      }
    }
    messages.push({ role: 'user', content: results })
  }
  return { text: text || '（达到最大迭代次数）', iters: maxIters, tool_uses: maxIters }
}

async function execLLM(node, ctx) {
  const model = node.model || ctx.getModel()
  if (!model) throw new Error('llm 节点缺少 model（未配置 provider）')
  const prompt = renderTemplate(node.prompt || '', ctx.vars)
  const out = await callLLMText(model, prompt, node, ctx.vars, node.max_tokens || 4096)
  return { output: out, next: node.next }
}

// classify：LLM 分类 → 输出 category/class_index，可配 routes 按类别路由分支
async function execClassify(node, ctx) {
  const model = node.model || ctx.getModel()
  if (!model) throw new Error('classify 节点缺少 model')
  const query = renderTemplate(node.query || node.input || '', ctx.vars)
  const classes = node.classes || []
  if (!classes.length) throw new Error('classify 节点缺少 classes')
  const instruction = node.instruction || '将输入分类到最合适的一类'
  const prompt = `${instruction}\n\n输入：\n${query}\n\n可选类别（只输出类别名本身，不要编号和解释）：\n${classes.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
  const raw = await callLLMText(model, prompt, node, ctx.vars, 512)
  let category = String(raw).trim().replace(/^["'\d.\s-]+|["']$/g, '')
  let idx = classes.findIndex((c) => category === c || category.includes(c) || c.includes(category))
  if (idx < 0) {
    const num = parseInt(category, 10)
    if (Number.isFinite(num) && num >= 1 && num <= classes.length) idx = num - 1
  }
  category = idx >= 0 ? classes[idx] : category
  const routes = node.routes || []
  const next = idx >= 0 && routes[idx] ? routes[idx] : node.next
  return { output: { category, class_index: idx, raw }, next }
}

// extract：LLM 按 JSON schema 提取字段（对标 Dify parameter-extractor）
async function execExtract(node, ctx) {
  const model = node.model || ctx.getModel()
  if (!model) throw new Error('extract 节点缺少 model')
  const query = renderTemplate(node.query || node.input || '', ctx.vars)
  const instruction = node.instruction || '从输入中提取指定字段'
  const params = node.parameters || []
  if (!params.length) throw new Error('extract 节点缺少 parameters')
  const schemaDesc = params.map((p) => `- ${p.name}${p.required ? '（必填）' : '（可选）'}: ${p.type || 'string'}${p.description ? ' — ' + p.description : ''}`).join('\n')
  const prompt = `${instruction}\n\n输入：\n${query}\n\n只输出一个 JSON 对象（不要 markdown 代码块、不要解释），字段定义：\n${schemaDesc}`
  const raw = await callLLMText(model, prompt, node, ctx.vars, 1024)
  const m = String(raw).match(/\{[\s\S]*\}/)
  try {
    const parsed = JSON.parse(m ? m[0] : String(raw))
    return { output: { ...parsed, _raw: String(raw).slice(0, 500) }, next: node.next }
  } catch {
    return { output: { _raw: String(raw).slice(0, 2000) }, next: node.next }
  }
}

// memory：语义检索（复用 buildRelevantMemory 关键词匹配）
async function execMemory(node, ctx) {
  const query = renderTemplate(node.query || node.input || '', ctx.vars)
  const keywords = String(query).split(/[\s,，、;；]+/).filter(Boolean)
  const root = ctx.memoryRoot || ''
  const text = root ? buildRelevantMemory({ root, keywords, maxBytes: node.max_bytes || 2048 }) : '（未配置记忆库根目录）'
  return { output: { text, keywords }, next: node.next }
}

// store：记忆写入（复用 appendMemoryEntry）
async function execStore(node, ctx) {
  const root = ctx.memoryRoot || ''
  if (!root) throw new Error('store 节点需要记忆库根目录（未注入 memoryRoot）')
  const theme = renderTemplate(node.theme || node.topic || '', ctx.vars)
  const summary = renderTemplate(node.summary || '', ctx.vars)
  const full = renderTemplate(node.full || node.content || '', ctx.vars)
  const tag = renderTemplate(node.tag || '', ctx.vars)
  if (!theme || !summary) throw new Error('store 节点缺少 theme/summary')
  const ok = appendMemoryEntry({ root, theme, tag: tag || null, summary, full })
  return { output: { ok: !!ok, theme, tag }, next: node.next }
}

// iterate：数组迭代（is_parallel 并行，parallel_nums 并发度）；每项注入 item/index
// 执行 body 子图，聚合各次 body 末节点输出
async function execIterate(node, ctx) {
  const arr = resolvePath(ctx.vars, node.iterable || node.input || '')
  if (!Array.isArray(arr)) throw new Error(`iterate 输入不是数组: ${node.iterable}`)
  const body = node.body || []
  if (!body.length) throw new Error('iterate 节点缺少 body（子节点 id 列表）')
  const out = []
  const parallel = node.is_parallel === true
  const nums = Math.max(1, Number(node.parallel_nums || 1))
  const items = arr.map((item, index) => ({ item, index }))
  const runOne = async ({ item, index }) => {
    const vars = { ...ctx.vars, item, index }
    const sub = { ...ctx, vars }
    return ctx.runBody(sub, body)
  }
  if (parallel) {
    for (let i = 0; i < items.length; i += nums) {
      const batch = items.slice(i, i + nums)
      const rs = await Promise.all(batch.map(runOne))
      out.push(...rs)
    }
  } else {
    for (const it of items) out.push(await runOne(it))
  }
  return { output: out, next: node.next }
}

// loop：循环（count 次数 + while_conditions 轮前检查 + break_conditions 提前终止）；
// 每轮注入 iter/index 执行 body。count 支持模板渲染（{{var}} / {{inputs.n}} 动态次数）。
// continue_on_error=true 时单轮失败记录 {__error} 继续；max_duration_ms 为整循环时间预算。
// 注意：loop 不做并行（轮间共享 var 状态，并行会竞态）——并行迭代用 iterate.is_parallel。
async function execLoop(node, ctx) {
  const body = node.body || []
  if (!body.length) throw new Error('loop 节点缺少 body')
  const rawCount = Number(renderTemplate(String(node.count ?? 3), ctx.vars))
  const count = Number.isFinite(rawCount) ? Math.max(1, rawCount) : 3
  const out = []
  const contOnErr = node.continue_on_error === true
  const maxDur = Number(node.max_duration_ms || 0)
  const t0 = Date.now()
  const whiles = node.while_conditions || []
  const breaks = node.break_conditions || []
  for (let i = 0; i < count && !ctx.signal?.aborted; i++) {
    if (maxDur > 0 && Date.now() - t0 > maxDur) break
    // while 条件（轮前检查）：不满足立即终止（对标 while/until 语义）
    if (whiles.length) {
      const pass = whiles.every((c) => evalCondition(c, { ...ctx.vars, iter: i, index: i }))
      if (!pass) break
    }
    const vars = { ...ctx.vars, iter: i, index: i }
    const sub = { ...ctx, vars }
    let last
    if (contOnErr) {
      try { last = await ctx.runBody(sub, body) }
      catch (err) { last = { __error: err.message || String(err), __iter: i } }
    } else {
      last = await ctx.runBody(sub, body)
    }
    out.push(last)
    // break 条件（对标 Dify loop break_conditions）：本轮执行后检查
    if (breaks.length) {
      const pass = breaks.every((c) => evalCondition(c, sub.vars))
      if (pass) return { output: { results: out, iterations: i + 1, broken: true }, next: node.next }
    }
  }
  return { output: { results: out, iterations: Math.min(count, out.length), broken: false }, next: node.next }
}

// agent：工作流内嵌对话式执行（ReAct 循环，工具白名单可选）
async function execAgent(node, ctx) {
  const prompt = renderTemplate(node.prompt || node.query || '', ctx.vars)
  const system = renderTemplate(node.system || '', ctx.vars)
  const model = node.model || ctx.getModel()
  const r = await runAgentLoop({
    prompt, system, tools: node.tools || [], model,
    signal: ctx.signal, registry: ctx.registry,
    maxIters: node.max_iters || 8, timeoutMs: node.timeout_ms || 120_000,
  })
  return { output: { text: r.text, iters: r.iters, tool_uses: r.tool_uses }, next: node.next }
}

// confirm：人工审批节点（对标 Dify human-input）。发 confirm_request 事件后挂起，
// 等待外部 resolveConfirm（TUI /wf approve|reject / 协议层 workflow_confirm）或超时。
// 超时/拒绝走 next_timeout / next_reject 分支；批准走 next_approve / next。
async function execConfirm(node, ctx) {
  const message = renderTemplate(node.message || node.prompt || '请确认', ctx.vars)
  const runId = ctx.runId || ''
  const nodeId = node.id
  const timeoutMs = node.timeout_ms || 300_000
  const waiter = ctx.confirmWaiters?.create ? ctx.confirmWaiters.create(runId, nodeId, timeoutMs) : null
  ctx.event('confirm_request', { runId, node: nodeId, message, inputs: node.inputs || [], timeout_ms: timeoutMs })
  if (!waiter) return { output: { action: 'approved', comment: '' }, next: node.next_approve || node.next }
  const r = await waiter.promise
  ctx.event('confirm_resolved', { runId, node: nodeId, action: r.action, comment: r.comment, timed_out: r.timed_out })
  if (r.timed_out) return { output: { action: 'timeout', comment: r.comment || '' }, next: node.next_timeout || node.next }
  if (r.action === 'rejected') return { output: { action: 'rejected', comment: r.comment || '' }, next: node.next_reject || node.next }
  return { output: { action: 'approved', comment: r.comment || '' }, next: node.next_approve || node.next }
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
      case 'classify': result = await execClassify(node, ctx); break
      case 'extract': result = await execExtract(node, ctx); break
      case 'memory': result = await execMemory(node, ctx); break
      case 'store': result = await execStore(node, ctx); break
      case 'agent': result = await execAgent(node, ctx); break
      case 'iterate': result = await execIterate(node, ctx); break
      case 'loop': result = await execLoop(node, ctx); break
      case 'confirm': result = await execConfirm(node, ctx); break
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

export function createWorkflowEngine({ configDir = '', registry, onEvent, getModel, signal, memoryRoot = '' } = {}) {
  const roots = []
  let _configDir = configDir
  let _registry = registry
  let _onEvent = onEvent || (() => {})
  let _getModel = getModel || (() => process.env.ANTHROPIC_MODEL || '')
  let _signal = signal || { aborted: false }
  let _memoryRoot = memoryRoot
  // confirm 挂起队列：key = runId:nodeId → { resolve, timer }
  const confirmWaiters = new Map()

  // 创建挂起项（超时自动 resolve 为 timed_out）
  function createConfirmWaiter(runId, nodeId, timeoutMs) {
    const key = `${runId}:${nodeId}`
    if (confirmWaiters.has(key)) return confirmWaiters.get(key)
    let resolveFn
    const promise = new Promise((resolve) => { resolveFn = resolve })
    const timer = setTimeout(() => {
      if (confirmWaiters.has(key)) {
        confirmWaiters.delete(key)
        resolveFn({ action: 'timeout', comment: '', timed_out: true })
      }
    }, timeoutMs)
    // 注意：confirm 超时 timer 不能 unref——审批挂起期间进程必须保持活跃等待
    // （unref 会导致事件循环无活引用时进程退出、超时永不触发）
    const waiter = { key, promise, resolve: (r) => { clearTimeout(timer); if (confirmWaiters.delete(key)) resolveFn({ ...r, timed_out: false }) } }
    confirmWaiters.set(key, waiter)
    return waiter
  }

  // 外部审批回传：TUI /wf approve|reject / 协议层 workflow_confirm
  function resolveConfirm(runId, nodeId, { action = 'approved', comment = '' } = {}) {
    const key = `${runId}:${nodeId}`
    const w = confirmWaiters.get(key)
    if (!w) return { ok: false, error: `无挂起审批（${key}）` }
    w.resolve({ action, comment })
    return { ok: true }
  }

  function setDeps(deps = {}) {
    if (deps.configDir !== undefined) _configDir = deps.configDir
    if (deps.registry !== undefined) _registry = deps.registry
    if (deps.onEvent !== undefined) _onEvent = deps.onEvent || (() => {})
    if (deps.getModel !== undefined) _getModel = deps.getModel
    if (deps.signal !== undefined) _signal = deps.signal
    if (deps.memoryRoot !== undefined) _memoryRoot = deps.memoryRoot
  }

  function event(type, payload) {
    try { _onEvent({ type, ...payload }) } catch { /* 事件失败不阻断 */ }
  }

  // 子图执行（iterate/loop 的 body）：按 body id 顺序执行，支持显式 next 跳转；
  // 输出写入同一 vars（item/index 由外层注入），审计共享 auditState 哈希链。
  // 返回"实际执行的最后一个节点"的输出（body 内 if 路由到分支节点时，
  // 结果取分支节点而非 body 列表末位）；发 node 事件（in_body 标记）供 UI 观察进度。
  async function runBody(ctx, bodyIds) {
    const visited = new Set()
    let curId = bodyIds[0]
    let guard = 0
    let lastId = null
    while (curId && !_signal.aborted && guard++ < 200) {
      if (visited.has(curId)) throw new Error(`子图循环检测: ${curId}`)
      visited.add(curId)
      const node = ctx.nodes.get(curId)
      if (!node) throw new Error(`未知子图节点: ${curId}`)
      const r = await executeNode(node, ctx)
      lastId = curId
      if (!r.ok) throw new Error(`子图节点 ${curId} 失败: ${r.error}`)
      ctx.vars[curId] = r.output
      if (ctx.auditState?.path) ctx.auditState.prev = auditAppend(ctx.auditState.path, node, r, ctx.auditState.prev)
      ctx.event?.('node', {
        runId: ctx.runId, node: node.id, type: 'node', node_type: node.type, status: 'done',
        dur_ms: r.dur_ms, output: r.output, in_body: true,
      })
      const idx = bodyIds.indexOf(curId)
      curId = r.next !== undefined && r.next !== null ? r.next : (idx >= 0 && idx < bodyIds.length - 1 ? bodyIds[idx + 1] : null)
    }
    return lastId ? ctx.vars[lastId] : undefined
  }

  async function run({ id, inputs = {}, mode = 'sync' } = {}) {
    const wf = loadWorkflow({ roots, id })
    if (!wf) return { ok: false, error: `工作流不存在: ${id}` }
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const auditPath = _configDir ? join(_configDir, 'workflow-runs', wf.name || id, `${ts}-${runId}.jsonl`) : ''
    const vars = { inputs: { ...inputs }, var: {}, root: {} }
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]))
    const auditState = { path: auditPath, prev: '-' }
    // 子图专用节点：loop/iterate 的 body 成员 + 经 next 可达的节点（传递闭包）。
    // 它们只经 runBody 执行，主循环按数组顺序推进时必须跳过，否则会被误执行。
    const bodyOnly = new Set()
    for (const n of wf.nodes) {
      if ((n.type === 'loop' || n.type === 'iterate') && Array.isArray(n.body)) {
        for (const id of n.body) {
          if (bodyOnly.has(id)) continue
          bodyOnly.add(id)
          const q = [id]
          while (q.length) {
            const cid = q.shift()
            const cn = nodes.get(cid)
            if (!cn) continue
            for (const nx of [cn.next, cn.next_true, cn.next_false]) {
              if (!nx || bodyOnly.has(nx)) continue
              const nxNode = nodes.get(nx)
              if (nxNode && nxNode.type !== 'start' && nxNode.type !== 'end') { bodyOnly.add(nx); q.push(nx) }
            }
          }
        }
      }
    }
    // start 节点：无则用第一个节点
    let cur = wf.nodes.find((n) => n.type === 'start') || wf.nodes[0]
    const visited = new Set()
    const results = {}
    event('start', { runId, workflow: wf.name || id, nodes: wf.nodes.length, mode })
    let nextId = cur.id
    let steps = 0
    while (nextId && !_signal.aborted) {
      if (steps > 500) return { ok: false, error: '执行步数超限（可能死循环）', runId, auditPath }
      if (visited.has(nextId)) return { ok: false, error: `节点循环检测: ${nextId}`, runId, auditPath }
      visited.add(nextId)
      const node = nodes.get(nextId)
      if (!node) return { ok: false, error: `未知节点: ${nextId}`, runId, auditPath }
      const ctx = { vars, results, inputs, registry: _registry, signal: _signal, getModel: _getModel, nodes, auditState, memoryRoot: _memoryRoot, runBody, runId, event, confirmWaiters: { create: createConfirmWaiter } }
      const r = await executeNode(node, ctx)
      results[node.id] = r
      if (r.ok) {
        vars[node.id] = r.output
        if (typeof r.output === 'object' && r.output !== null) Object.assign(vars.root, r.output)
      }
      auditState.prev = auditPath ? auditAppend(auditPath, node, r, auditState.prev) : auditState.prev
      event('node', { runId, node: node.id, type: 'node', node_type: node.type, status: r.ok ? 'done' : 'failed', dur_ms: r.dur_ms, output: r.ok ? r.output : undefined, error: r.ok ? undefined : r.error })
      if (!r.ok && node.on_error !== 'continue') {
        event('end', { runId, status: 'failed', error: r.error, steps: steps + 1 })
        return { ok: false, error: r.error, node: node.id, runId, auditPath }
      }
      // 确定下一个节点：节点 next 显式 → if 分支已定 → 否则数组顺序
      // （跳过子图专用节点——它们只能由 loop/iterate 的 runBody 执行）
      nextId = r.next !== undefined && r.next !== null ? r.next : null
      if (!nextId) {
        let idx = wf.nodes.findIndex((n) => n.id === cur.id)
        while (idx >= 0 && idx < wf.nodes.length - 1) {
          idx++
          const cand = wf.nodes[idx]
          if (cand && !bodyOnly.has(cand.id)) { nextId = cand.id; break }
        }
      }
      cur = nodes.get(nextId) || cur
      steps++
    }
    const status = _signal.aborted ? 'cancelled' : 'completed'
    event('end', { runId, status, steps })
    return { ok: true, status, outputs: results, runId, auditPath, steps }
  }

  // cron 表达式匹配（5 段：分 时 日 月 周；* / 数字 逗号）
  function cronMatches(expr, date = new Date()) {
    const fields = String(expr).trim().split(/\s+/)
    if (fields.length !== 5) return false
    const vals = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
    for (let i = 0; i < 5; i++) {
      const f = fields[i]
      if (f === '*') continue
      if (f.startsWith('*/')) {
        const step = Number(f.slice(2))
        if (vals[i] % step !== 0) return false
        continue
      }
      if (f.includes(',')) {
        const parts = f.split(',').map(Number)
        if (!parts.includes(vals[i])) return false
        continue
      }
      if (Number(f) !== vals[i]) return false
    }
    return true
  }

  // 调度器：每 60s 扫描 roots 下带 schedule 字段的工作流，cron 匹配即 run。
  // 防重：sameMinute 记录已触发（同分钟内不重复）。返回 stop()。
  function startScheduler({ onRun } = {}) {
    const last = new Map()
    const timer = setInterval(() => {
      for (const root of roots) {
        for (const wf of discoverWorkflows({ root })) {
          const schedule = wf.schedule
          if (!schedule) continue
          const now = new Date()
          const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
          if (!cronMatches(schedule, now)) continue
          if (last.get(wf.id) === minuteKey) continue
          last.set(wf.id, minuteKey)
          const r = run({ id: wf.id, inputs: {} })
          if (onRun) void r.then((res) => onRun(wf.id, res))
        }
      }
    }, 60_000)
    if (timer.unref) timer.unref()
    return () => clearInterval(timer)
  }

  // webhook 触发：node:http 服务，POST /wf/run/<id>（JSON body = inputs）。
  // 返回 server（调用方 listen）；默认端口 51312（PONOS_WF_WEBHOOK_PORT 覆盖）。
  function createWebhookServer() {
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/wf/run/')) {
        const id = decodeURIComponent(req.url.slice('/wf/run/'.length))
        let body = ''
        for await (const chunk of req) body += chunk
        let inputs = {}
        try { inputs = JSON.parse(body || '{}') } catch { /* 非 JSON body 视为空 */ }
        try {
          const r = await run({ id, inputs })
          res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: r.ok, status: r.status, steps: r.steps, runId: r.runId, auditPath: r.auditPath, error: r.error, node: r.node }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }))
        }
        return
      }
      if (req.method === 'GET' && req.url === '/wf/list') {
        const list = []
        for (const root of roots) for (const w of discoverWorkflows({ root })) list.push({ id: w.id, nodes: w.nodes, schedule: w.schedule || null, description: w.description })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ workflows: list }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
    return server
  }

  return {
    run,
    setDeps,
    discover: (root) => discoverWorkflows({ root }),
    load: (id) => loadWorkflow({ roots, id }),
    verify: (auditPath) => verifyRun(auditPath),
    addRoot: (root) => { if (root && !roots.includes(root)) roots.push(root) },
    resolveConfirm,
    startScheduler,
    createWebhookServer,
    cronMatches,
  }
}
