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
//
// 引号规则（两条保险，防“词内撇号”吞项）：
//   1) `'` 只在 token 起始位置（上一字符非词字符）才被当作引号起始——避免 `don't` / `doesn't` / `it's`
//      这类词内撇号把后续逗号一起吞进同一项（旧实现 `inner.split(',')` 得 2 项，不能被改成 1 项）。
//   2) 若扫描结束时引号仍未闭合（不构成合法流式字符串），回退为“不识别引号”再切一次。
function splitFlow(inner) {
  const split = (text, respectQuotes) => {
    const parts = []
    let depth = 0
    let quote = ''
    let esc = false
    let cur = ''
    for (const ch of text) {
      if (respectQuotes && quote) {
        cur += ch
        // 双引号内的 `\` 转义：`\"` 是内容而非引号收尾（序列化侧产出 JSON 转义串，
        // 不支持转义会把 `a\"b, c` 里的逗号当成流式分隔符 → 值被切碎）。
        if (esc) { esc = false; continue }
        if (quote === '"' && ch === '\\') { esc = true; continue }
        if (ch === quote) quote = ''
        continue
      }
      if (respectQuotes && (ch === '"' || ch === "'")) {
        // `"` 沿用旧行为（任何位置都可起始）；`'` 仅限 token 起始。
        const prev = cur ? cur[cur.length - 1] : ''
        if (ch === '"' || !/[\w\u4e00-\u9fa5]/.test(prev)) { quote = ch; esc = false; cur += ch; continue }
      }
      if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') depth--
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
      cur += ch
    }
    if (cur.trim()) parts.push(cur)
    return { parts: parts.map((p) => p.trim()).filter(Boolean), closed: quote === '' }
  }
  let { parts, closed } = split(inner, true)
  if (!closed) ({ parts } = split(inner, false))
  return parts
}

// YAML 双引号标量的转义还原（C2）：序列化侧用 JSON.stringify 产出 `"a\nb"`，
// 只做首尾切片会把 `\n` 当字面量留下 → 多行 prompt / Windows 路径 `D:\a\b` 往返失真。
// JSON 字符串是 YAML 双引号标量的子集，故优先 JSON.parse（正确处理 \uXXXX 与代理对），
// 非合法 JSON 串（含裸控制字符/未知转义）再退化为手写还原。
function unescapeDouble(s) {
  try { return JSON.parse(s) } catch { /* 回退手写还原 */ }
  return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    const c = e[0]
    if (c === 'u' || c === 'x') return String.fromCharCode(parseInt(e.slice(1), 16))
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0', '"': '"', "'": "'", '\\': '\\', '/': '/' }[c] ?? c
  })
}

export function unquote(v) {
  const s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.startsWith('"') ? unescapeDouble(s) : s.slice(1, -1)
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitFlow(inner).map((x) => unquote(x))
  }
  // 内联映射（画布友好：`config: { prompt: xxx }` / `retry: { max: 2 }` / 列表项 `- {id: a, ...}`）。
  // 任一部分不含顶层 `k: v`（如代码串 `{ return 1 }`、模板串 `{{ask}}`）→ 原样返回**字符串**，
  // 与旧实现（b2982e1:kernel/workflow.mjs，无内联映射能力）一致：绝不静默改型。
  // 注意：splitKV 不匹配时返回 [原文, undefined]（k 恒有值），故不能用 `val === undefined` 判定“非 k: v”，
  // 必须显式检查该部分是否含顶层冒号。
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return {}
    const obj = {}
    for (const part of splitFlow(inner)) {
      if (part.indexOf(':') < 0) return s
      const [k, val] = splitKV(part)
      // 键也可能被引号包裹（`{"a b": 1}`）：同样按标量规则还原，否则键名带引号往返丢键
      const key = /^["']/.test(k) ? unquote(k) : k
      obj[key] = val === undefined ? {} : unquote(val)
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
    // K1.2：记录**本函数实际读过的文件**——工具视图缓存的文件级签名（mtimeMs,size）以
    // 此为准，故被 legacy/可见性/超限过滤掉的文件同样在案（它们一样决定工具池）。
    let filePath = ''
    if (it.isDirectory()) {
      const ymlPath = join(root, it.name, 'workflow.yml')
      if (!existsSync(ymlPath)) continue
      id = it.name
      filePath = ymlPath
      try { content = readFileSync(ymlPath, 'utf-8') } catch { continue }
    } else if (it.isFile() && /\.(yml|yaml)$/.test(it.name)) {
      id = it.name.replace(/\.(yml|yaml)$/, '')
      filePath = join(root, it.name)
      try { content = readFileSync(filePath, 'utf-8') } catch { continue }
    } else continue
    const meta = parseFrontmatter(content)
    const parsed = parseYaml(content)
    const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
    // 触发配置读取（C1）：DSL v2 的权威位置是 **trigger_config**（spec §2.9；迁移产物与
    // 内置 spec-dev 都写这里），顶层平铺 schedule/auto_trigger 是旧格式——保留为回退，
    // 否则 migrateLegacy 删掉顶层字段后 cron/自动触发会静默失效。
    const trigCfg = parsed.trigger_config && typeof parsed.trigger_config === 'object' ? parsed.trigger_config : {}
    wfs.push({
      id,
      path: filePath,
      name: meta.name || parsed.name || id,
      description: (meta.description || parsed.description || firstLine || id).slice(0, 300),
      version: meta.version || parsed.version || '',
      schedule: trigCfg.schedule || parsed.schedule || meta.schedule || '',
      // triggers 三种写法并存：数组（`[a, b]` / `- a` 列表）、逗号标量（`a, b, c`）、
      // frontmatter。逗号标量自旧版起从未被解析（触发词恒为 []），此处补上。
      triggers: Array.isArray(parsed.triggers) || typeof parsed.triggers === 'string' || typeof parsed.triggers === 'number'
        ? normalizeTriggers(parsed.triggers)
        : meta.triggers ? normalizeTriggers(meta.triggers) : [],
      autoTrigger: trigCfg.auto_trigger === true || parsed.auto_trigger === true || meta.auto_trigger === true,
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
// config 摊平只补缺、不覆盖：节点顶层已写的键优先，避免 config 里误写的 body/retry/label
// 静默覆盖顶层语义字段（顶层才是权威位置）。
export function normalizeNode(n) {
  const { config = {}, ...rest } = n || {}
  const out = { ...rest }
  for (const [k, v] of Object.entries(config || {})) {
    if (!Object.hasOwn(out, k)) out[k] = v
  }
  return out
}

export function normalizeWorkflow(wf) {
  return {
    ...(wf || {}),
    // 顶层 triggers 归一（2026-09-12）：loadWorkflow → parseWorkflowFile → 这里，
    // 是**加载路径的统一收口**，GUI 编辑器模型即来自它（不再经过 toModel）。
    triggers: normalizeTriggers(wf?.triggers),
    nodes: ((wf && wf.nodes) || []).map(normalizeNode),
    edges: Array.isArray(wf?.edges) ? wf.edges : null,
  }
}

// ===================== 画布模型 ↔ YAML 序列化（UI Task 9） =====================
// toModel：wf（摊平后）→ 画布模型；serializeWorkflow：模型/摊平 wf 任一形态 → YAML 文本。
// 双向契约：normalizeNode（摊平）与 toModel（收拢）互逆，serialize 只认模型形态。

// 节点顶层「非配置」键：保持顶层，其余（prompt/code/...）收拢回 node.config。
const NODE_META_KEYS = new Set(['id', 'type', 'label', 'position', 'retry', 'on_error', 'body', 'note'])
const TOP_KEYS = ['name', 'description', 'version', 'triggers', 'trigger_config', 'settings', 'inputs', 'nodes', 'edges', 'expose', 'permissions']

// wf（摊平后）→ 画布模型：非元数据字段收拢回 node.config。
// 幂等：若节点已是模型形态（已带 config），则把 config 展开后重新收拢，不会丢配置。
/**
 * triggers 归一（单一真相，2026-09-12 修）。
 *
 * 触发词有三种写法并存：数组（`[a, b]` / `- a` 列表）、逗号标量（`a, b, c`）、frontmatter。
 * 此前只有 `discoverWorkflows`（列表入口）做了归一，`toModel`（编辑器模型）与 `toYaml`
 * 是**原样透传**，于是同一份 YAML 在两条路径上形状不一致：列表拿到数组、编辑器拿到字符串。
 * 后果（实测崩溃）：GUI 编辑器 `(model.triggers || []).join(', ')` → `join is not a function`
 * → 打开画布整页白屏；保存路径 `model.triggers.map(...)` 同样会抛。
 * 归一放在这里，供三处共用（列表 / toModel / serialize），后续新增入口也应走它。
 */
export function normalizeTriggers(v) {
  // null/undefined 元素要先剔除：直接 String() 会得到字面量 "null"/"undefined" 触发词
  if (Array.isArray(v)) return v.filter((t) => t !== null && t !== undefined).map((t) => String(t).trim()).filter(Boolean)
  if (typeof v === 'string' || typeof v === 'number') return String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  return []
}

export function toModel(wf) {
  const nodes = (wf.nodes || []).map((n) => {
    const { config: existing = {}, ...rest } = n || {}
    const out = { id: rest.id, type: rest.type }
    const cfg = { ...existing }
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'id' || k === 'type') continue
      if (NODE_META_KEYS.has(k)) out[k] = v
      else cfg[k] = v
    }
    if (Object.keys(cfg).length) out.config = cfg
    return out
  })
  const model = {}
  for (const k of TOP_KEYS) if (wf[k] !== undefined) model[k] = wf[k]
  // 形状归一：编辑器/序列化都假定 triggers 是 string[]（见 normalizeTriggers 注释）
  model.triggers = normalizeTriggers(model.triggers)
  model.nodes = nodes
  model.edges = wf.edges || []
  return model
}

// —— 极简 YAML 输出（只覆盖 DSL 结构；稳定键序，便于版本 diff）——
// 裸标量安全性：**上下文感知**（C1）。同一份输出去处有两种上下文——块（`k: v` / `- v`）
// 与流式（`[a, b]` / `{k: v}`），取交集判定：凡含 `,[]{}`（流式切分与括号嵌套）、
// `:`/`#`（键值分隔与注释起始）、`'`/`"`/`\`（引号与转义歧义）、换行/制表符、
// 首尾空白，或整体会被解析成数字/布尔的，一律加引号。旧实现只看**首字符**，
// 于是 `Hello, world`、`a, b` 之类进流式容器即被切成多项、值被判成对象/字符串。
const PLAIN_UNSAFE = /[,\[\]{}:#'"\\]|[\n\r\t]|^\s|\s$/
const needsQuote = (s) => s === '' || PLAIN_UNSAFE.test(s) || /^[>|*&!%@`-]/.test(s)
  || /^(true|false|null|~)$/i.test(s) || /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)
function scalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  return needsQuote(s) ? JSON.stringify(s) : s
}
// 键：标识符形态裸写（与旧输出一致，diff 友好），否则加引号（解析侧 unquote 还原键名）
const flowKey = (k) => (/^[A-Za-z_$][\w$.-]*$/.test(String(k)) ? String(k) : JSON.stringify(String(k)))
// 流式值：递归输出嵌套集合——旧实现对嵌套对象直接 JSON.stringify，其引号键
// （`{"max":2}`）会被解析成字面键名 `"max"`，往返即丢键。
function flowValue(v) {
  if (Array.isArray(v)) return `[${v.map(flowValue).join(', ')}]`
  if (v && typeof v === 'object') {
    return `{${Object.entries(v).map(([k, x]) => `${flowKey(k)}: ${flowValue(x)}`).join(', ')}}`
  }
  return scalar(v)
}
const inlineObj = (o) => flowValue(o)
function blockLines(value, indent) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    return value.flatMap((it) => {
      if (it && typeof it === 'object') {
        const ent = Object.entries(it)
        if (!ent.length) return [`${pad}- {}`]
        const [k0, v0] = ent[0]
        const first = `${pad}- ${flowKey(k0)}: ${flowValue(v0)}`
        const rest = ent.slice(1).map(([k, v]) => `${pad}  ${flowKey(k)}: ${flowValue(v)}`)
        return [first, ...rest]
      }
      return [`${pad}- ${scalar(it)}`]
    })
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => {
      if (v && typeof v === 'object') {
        const inner = v
        if (Array.isArray(inner) && inner.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
          if (!inner.length) return `${pad}${flowKey(k)}: []`
          return [`${pad}${flowKey(k)}:`, ...blockLines(inner, indent + 2)].join('\n')
        }
        if (Array.isArray(inner)) return `${pad}${flowKey(k)}: ${flowValue(inner)}`
        if (!Object.keys(inner).length) return `${pad}${flowKey(k)}: {}`
        return `${pad}${flowKey(k)}: ${flowValue(inner)}`
      }
      return `${pad}${flowKey(k)}: ${scalar(v)}`
    })
  }
  return [`${pad}${scalar(value)}`]
}

export function serializeWorkflow(input) {
  // toModel 幂等（见上），因此统一过一遍即可，无需判断输入形态——
  // 早期版本用启发式判断"是否已是模型"，会静默丢掉已有 config。
  const model = toModel(input || {})
  const out = []
  for (const k of ['name', 'description', 'version']) if (model[k] !== undefined) out.push(`${k}: ${scalar(model[k])}`)
  if (model.triggers) out.push(`triggers: [${model.triggers.map(scalar).join(', ')}]`)
  out.push('trigger_config: ' + inlineObj(model.trigger_config || { manual: true }))
  if (model.settings) out.push('settings: ' + inlineObj(model.settings))
  // 空数组显式写成 `k: []`（I2）：裸 `k:` 会被解析成 `{}`，`edges` 就此被误判旧格式
  // （validateWorkflow → LEGACY_DSL），`inputs` 则丢型成对象。
  if (Array.isArray(model.inputs)) {
    if (model.inputs.length) out.push('inputs:', ...blockLines(model.inputs, 2))
    else out.push('inputs: []')
  }
  if (model.nodes.length) out.push('nodes:', ...blockLines(model.nodes, 2))
  else out.push('nodes: []')
  if (model.edges.length) out.push('edges:', ...blockLines(model.edges, 2))
  else out.push('edges: []')
  if (model.expose) out.push('expose: ' + inlineObj(model.expose))
  if (model.permissions) out.push('permissions: ' + inlineObj(model.permissions))
  return out.join('\n') + '\n'
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
  // 边 id 必须唯一：调度器（workflow-dag）以 edgeId 为键记录出边状态，重复 id 会让两条边
  // 串台（同 id 边任一条 settle 即让所有同 id 边"确定"→ 节点提前就绪，或活跃分支被静默跳过）。
  const edgeIds = new Set()
  for (const e of edges) {
    if (!e?.id) errors.push({ code: 'BAD_EDGE', message: '边缺少 id' })
    else if (edgeIds.has(e.id)) errors.push({ code: 'DUP_EDGE', edge: e.id, message: `边 id 重复: ${e.id}` })
    else edgeIds.add(e.id)
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

// ===================== 旧格式迁移（DSL v1 → v2） =====================
// 旧格式 = 数组顺序执行 + next/next_true/next_false + 平铺 schedule/auto_trigger。
// 迁移**确定性**：边按节点遍历顺序生成，id 由 EDGE_ID 规则派生（无时间/随机成分），
// 同输入两次调用产出字节等价产物。规则：
//   ① 显式 next → 无 handle 边；
//   ② if：next_true → sourceHandle 'true'、next_false → 'false'；字段缺省（含显式 null，
//      旧引擎里 null 同样回落到 next / 数组顺序）时依次回落 next → 顺延兜底；
//   ③ classify：routes[i] → sourceHandle 'route:<i>'，next → 'default'（DAG 调度器对
//      true/false 之外的 handle 用 'default' 兜底，见 workflow-dag 出边激活）；
//   ④ loop/iterate：body 成员按 **body 数组顺序**补 body[i] → body[i+1]（不依赖 nodes 相邻性）；
//   ⑤ 其余节点：显式 next 优先；未写/为空则顺延——主图节点顺延到"下一个主图且非条件分支
//      目标"的节点，body 成员顺延到所属 body 的下一个成员（旧引擎的数组顺序兜底语义）；
//   ⑥ 绝不补跨子图（主图 ↔ body）边：子图出入由 body 声明 + loop 节点出边表达，补了会触发
//      BODY_ESCAPE；跳过时在 notes 留下明细；
//   ⑦ 平铺 schedule / auto_trigger → trigger_config（manual 缺省 true）并删原字段。
//   ⑧ confirm：审批三分支 next_approve/next_reject/next_timeout →
//      条件边 handle **approved / rejected / timeout**（与 workflow-nodes.execConfirm 返回的
//      route 同名；activateOutgoing 按 route === sourceHandle 精确激活），字段随 edges 一并
//      删除；有分支字段时 next/顺延兜底改为 handle 'default'（= 旧 `A|R|T || next` 语义）。
// 刻意不动：classify.routes 保留（执行/画布仍读）。
// 已是 v2（存在非空 edges）→ 原样返回（幂等）。

const EDGE_ID = (source, target, handle, n) => `e${n}_${source}_${target}${handle ? '_' + String(handle).replace(/[^\w]/g, '') : ''}`

// confirm 审批三态：字段 → handle 名（唯一真相——execConfirm 的 route 也取这三个值）。
export const CONFIRM_ROUTES = [['next_approve', 'approved'], ['next_reject', 'rejected'], ['next_timeout', 'timeout']]

export function migrateLegacy(input) {
  const wf = normalizeWorkflow(input)
  const nodes = wf.nodes || []
  if (Array.isArray(wf.edges) && wf.edges.length) {
    return { workflow: { ...wf }, notes: ['已是 DSL v2（存在 edges），无需迁移'] }
  }
  const valid = nodes.filter((n) => n?.id)
  const ids = new Set(valid.map((n) => n.id))
  const byId = new Map(valid.map((n) => [n.id, n]))
  const notes = []
  const edges = []
  let seq = 0

  // 子图归属（与 validateWorkflow 同一判定：body 成员 → 所属 loop/iterate）；null = 主图
  const bodyOf = new Map()
  for (const n of nodes) {
    if ((n.type === 'loop' || n.type === 'iterate') && Array.isArray(n.body)) {
      for (const b of n.body) if (ids.has(b)) bodyOf.set(b, n.id)
    }
  }
  const scopeOf = (id) => (bodyOf.has(id) ? bodyOf.get(id) : null)

  // 条件分支目标是"跳转目的地"，不作顺延后继：否则两个分支会被串成假顺序链
  // （big → small → out），既不忠实旧语义，也会让分支节点的下游错位。
  const branchTargets = new Set()
  for (const n of nodes) {
    const extra = [n?.next_true, n?.next_false, ...(Array.isArray(n?.routes) ? n.routes : []),
      ...CONFIRM_ROUTES.map(([f]) => n?.[f])]
    for (const t of extra) {
      if (typeof t === 'string' && t) branchTargets.add(t)
    }
  }

  const push = (source, target, handle) => {
    if (!ids.has(source) || !ids.has(target) || source === target) return false
    if (scopeOf(source) !== scopeOf(target)) return false
    if (edges.some((e) => e.source === source && e.target === target && e.sourceHandle === handle)) return false
    edges.push({ id: EDGE_ID(source, target, handle, ++seq), source, target, ...(handle ? { sourceHandle: String(handle) } : {}) })
    return true
  }
  const link = (source, target, handle, how) => {
    if (typeof target !== 'string' || !target) return false
    if (!ids.has(target)) { notes.push(`节点 ${source}：${how} 指向不存在的节点 ${target}，已跳过`); return false }
    if (source === target) return false
    if (scopeOf(source) !== scopeOf(target)) {
      notes.push(`节点 ${source}：${how} → ${target} 跨越子图边界，已跳过（子图出入由 body 声明与 loop 节点出边表达）`)
      return false
    }
    if (!push(source, target, handle)) return false
    notes.push(`节点 ${source}：${how} → ${target}${handle ? `（handle ${handle}）` : ''}`)
    return true
  }

  // 顺延后继（旧引擎兜底顺序）：body 成员 → 所属 body 的下一个成员；主图节点 → 下一个主图节点
  const fallthroughOf = (id, i) => {
    const owner = scopeOf(id) ? byId.get(scopeOf(id)) : null
    if (owner) {
      const body = Array.isArray(owner.body) ? owner.body : []
      const k = body.indexOf(id)
      return k >= 0 && k < body.length - 1 ? body[k + 1] : null
    }
    for (let j = i + 1; j < nodes.length; j++) {
      const cand = nodes[j]
      if (!cand?.id) continue
      if (scopeOf(cand.id)) continue            // body 成员：只由 body 顺序补边
      if (branchTargets.has(cand.id)) continue  // 条件分支目标：只由条件边进入
      return cand.id
    }
    return null
  }
  // 分支目标：字段缺省（含显式 null/空串——旧引擎里同样再回落）时按 keys 顺序取下一个
  const branchTarget = (n, keys, fb) => {
    for (const k of keys) {
      if (!Object.hasOwn(n, k)) continue
      const v = n[k]
      if (typeof v === 'string' && v) return v
    }
    return fb
  }

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n?.id) continue
    const fb = fallthroughOf(n.id, i) // 显式分支/next 缺失时的兜底后继
    if (n.type === 'if') {
      link(n.id, branchTarget(n, ['next_true', 'next'], fb), 'true', 'next_true → 条件边')
      link(n.id, branchTarget(n, ['next_false', 'next'], fb), 'false', 'next_false → 条件边')
      continue
    }
    if (n.type === 'classify' && Array.isArray(n.routes)) {
      n.routes.forEach((t, idx) => link(n.id, t, `route:${idx}`, `routes[${idx}] → 条件边`))
      if (typeof n.next === 'string' && n.next) link(n.id, n.next, 'default', 'next → 默认分支边')
      continue
    }
    // confirm：审批三分支 → 条件边（handle approved/rejected/timeout，与 execConfirm 的
    // route 同名）；字段缺省/为空则不生成该条边（缺失分支不臆造）。有任一分支字段时，
    // next/顺延兜底改走 handle 'default'（旧语义 = `next_approve|reject|timeout || next`，
    // 即三态都未命中才顺延；若仍用无 handle 边，"成功即走"会让兜底分支与命中分支同时触发）。
    if (n.type === 'confirm') {
      const branches = CONFIRM_ROUTES.filter(([field]) => typeof n[field] === 'string' && n[field])
      for (const [field, handle] of branches) link(n.id, n[field], handle, `${field} → 条件边`)
      if (branches.length) {
        const fallback = typeof n.next === 'string' && n.next ? n.next : fb
        if (fallback) link(n.id, fallback, 'default', 'next → 默认分支边（三态未命中时）')
        else notes.push(`confirm 节点 ${n.id}：三分支之外无 next/顺延后继 → 未命中即链尾`)
        continue
      }
    }
    if (n.type === 'end' || n.type === 'answer') {
      // 输出节点：引擎在 end/answer 处收束（end 恒返回 next=null），不补出边
      if (typeof n.next === 'string' && n.next) notes.push(`节点 ${n.id}：${n.type} 节点的 next（${n.next}）不表达执行顺序，已忽略`)
      else notes.push(`节点 ${n.id}：输出节点（${n.type}）→ 链尾（不补边）`)
      continue
    }
    const explicit = typeof n.next === 'string' && n.next ? n.next : null
    const target = explicit || fb
    if (!target) { notes.push(`节点 ${n.id}：无 next 且无顺延后继 → 链尾（不补边）`); continue }
    const how = explicit ? 'next → 显式边' : (scopeOf(n.id) ? '按 body 顺序补边' : '按数组顺序补边')
    link(n.id, target, undefined, how)
  }

  // 旧 next* 字段（顺序/审批分支语义）删除——edges 是唯一真相；其余字段原样保留
  const cleaned = nodes.map((n) => {
    const { next, next_true, next_false, next_approve, next_reject, next_timeout, ...rest } = n
    return rest
  })
  const trigger_config = {
    manual: true,
    ...(wf.trigger_config || {}),
    ...(wf.schedule ? { schedule: wf.schedule } : {}),
    ...(wf.auto_trigger !== undefined ? { auto_trigger: wf.auto_trigger } : {}),
  }
  const { schedule, auto_trigger, ...restWf } = wf
  if (schedule) notes.push(`schedule → trigger_config.schedule（${schedule}）`)
  if (auto_trigger !== undefined) notes.push('auto_trigger → trigger_config.auto_trigger')
  return { workflow: { ...restWf, trigger_config, nodes: cleaned, edges }, notes }
}

// ===================== 迁移落盘辅助（CLI `/wf migrate`） =====================
// 迁移产物落盘采用**最小追加**：只把迁移生成的 edges 块追加到原文末尾（顶层 `edges:`）。
// 理由：最小追加不触碰原文（serializeWorkflow 虽已交付，但重写会让迁移 diff 淹没全文、
// 并可能改写注释/键序，故迁移路径仍走追加）；
// 执行以 edges 为唯一真相，残留的旧字段无害——schedule/auto_trigger 由 discoverWorkflows
// 的「trigger_config → 顶层」回退读取（C1 修复），next* 字段不再被任何执行路径消费。
// 幂等：原文已有非空 edges 时 migrateLegacy 直接返回护栏，不会追加第二块。
// 全部值加引号：`true`/`false`/数字型标量若无引号会被 YAML 解析成布尔/数字，
// route 与节点 id 的精确匹配（字符串）即失效。
export function renderEdgesYaml(edges = []) {
  const q = (v) => `"${String(v)}"`
  if (!edges || !edges.length) return 'edges: []\n'
  const lines = ['edges:']
  for (const e of edges || []) {
    lines.push(`  - id: ${q(e.id)}`)
    lines.push(`    source: ${q(e.source)}`)
    lines.push(`    target: ${q(e.target)}`)
    if (e.sourceHandle) lines.push(`    sourceHandle: ${q(e.sourceHandle)}`)
  }
  return lines.join('\n') + '\n'
}

// 把 edges 块追加到工作流原文（保证换行分隔）；返回新全文。
export function appendEdges(originalContent, edges = []) {
  const base = String(originalContent ?? '')
  return (base.endsWith('\n') || base === '' ? base : base + '\n') + renderEdgesYaml(edges)
}
