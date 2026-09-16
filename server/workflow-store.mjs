// server/workflow-store.mjs —— 工作流磁盘权威存储（CRUD / 版本 / 导入导出 / 绑定）
// 约束：本模块不得 import kernel/*（生产包只带 kernel-dist/cli.mjs 单文件 bundle）。
// 因此只做轻量正则元数据解析（列表展示用）；权威解析/校验/序列化一律经宿主会话。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
// 【S2-D4】归属解析取 `shared/`（本模块的约束只禁 import kernel/*；`shared/` 是既有跨层位置，
// 生产包也随包分发）。沿用同一实现可保证三处落盘点的默认值/覆盖规则一致。
import { attributionOf } from '../shared/attribution.mjs'

export const SCHEMA_VERSION = 2
export const BUNDLE_FORMAT = 'yfworking-workflow'
const VERSION_KEEP = 20

export const wfRootOf = (home) => join(home, 'workflows')
export const runsRootOf = (home) => join(home, 'workflow-runs')
const wfDir = (root, id) => join(root, id)
const wfFile = (root, id) => join(wfDir(root, id), 'workflow.yml')
const versionsDir = (root, id) => join(wfDir(root, id), 'versions')

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_TS = /^[0-9A-Za-z._-]{1,64}$/
// Windows 保留设备名：`nul\workflow.yml` 会写进 NUL 设备或静默失写（仓库既往有 nul 事故记录）。
// Windows 按「首个点之前」判名，故 `nul` 与 `nul.yml` 同样拒绝。
const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/
// 保留字：这些 id 与 /workflows/<sub> 的动作子路由冲突（如 /workflows/run、/workflows/verify），
// 必须禁止创建工作流时使用，否则该工作流永远打不开。
export const RESERVED_IDS = new Set(['run', 'run-status', 'stop', 'confirm', 'runs', 'import', 'export', 'bindings', 'verify', 'validate'])
export function assertSafeId(id) {
  const s = String(id || '')
  if (!SAFE_ID.test(s) || s.includes('..')) throw new Error(`非法工作流 id: ${id}`)
  if (WINDOWS_DEVICE.test(s.toUpperCase()) || WINDOWS_DEVICE.test(s.split('.')[0].toUpperCase())) {
    throw new Error(`非法工作流 id: ${id}（Windows 保留设备名）`)
  }
  if (/[. ]$/.test(s)) throw new Error(`非法工作流 id: ${id}（不得以点或空格结尾）`)
  if (RESERVED_IDS.has(s)) throw new Error(`工作流 id 不能使用保留字: ${id}（保留：${[...RESERVED_IDS].join('、')}）`)
  return s
}

// 版本快照 ts 白名单：挡 `ts='../../..'` 拼出的穿越路径（Task 11 若把 HTTP 参数直传 ts 即成穿越读取）。
export function assertSafeTs(ts) {
  const s = String(ts || '')
  if (!SAFE_TS.test(s) || s.includes('..')) throw new Error(`非法版本号: ${ts}`)
  return s
}

function grab(yml, key) {
  const m = String(yml).match(new RegExp('^' + key + ':\\s*["\']?(.+?)["\']?\\s*$', 'm'))
  return m ? m[1].trim() : ''
}

// 顶层块（block 风格）内条目计数：切出 `key:` 到下一个顶层键之间的片段，再数 `- { id:` 条目。
// 不能在全文件直接数 `- { id:`——nodes 与 edges 的条目同形，会互相串数。
function sectionCount(text, key) {
  const after = text.split(new RegExp('^' + key + ':\\s*(?:\\n|$)', 'm'))[1]
  if (!after) return 0
  const body = after.split(/^[A-Za-z_]+:\s*(?:\n|$)/m)[0]
  return (body.match(/^\s*-\s*(\{)?\s*id:/gm) || []).length
}

// 按「深度 0 逗号」切分（跳过引号与括号嵌套）；用于内联映射 / 内联列表。
function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let q = ''
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (q) {
      cur += c
      if (c === '\\') { cur += body[++i] || ''; continue }
      if (c === q) q = ''
      continue
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue }
    if ('{[('.includes(c)) depth++
    else if ('}])'.includes(c)) depth--
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += c
  }
  parts.push(cur)
  return parts
}

// 内联映射 `{ id: x, type: y, ... }` 取 type 值；只认深度 0 的键，
// 因此 `config: { inputs: [{name:q, type:string}] }` 里的 type 不会被误认。
function inlineMapType(body) {
  for (const p of splitTopLevel(String(body).replace(/^\s*\{|\}\s*$/g, ''))) {
    const m = p.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/)
    if (m && m[1] === 'type') return m[2].replace(/^["']|["']$/g, '').split(/[\s,]/)[0]
  }
  return ''
}

// 从 nodes: 块提取节点类型。只认「节点条目的直接键」：内联 `- { id: x, type: y }`，
// 或块式条目里与 `id:` 同缩进的 `type: y`（更深缩进的都属节点 config / 子块）。
// 顶层或节点内 inputs: 块、config 里的块标量正文（prompt/system）、字符串字面量里的
// "type:" 一律不认——manifest.nodeTypes 是导入侧兼容性门禁（Task 11/12）的输入，
// 误报会把合法包判成需要不存在类型的节点。
function nodeTypesOf(text) {
  const lines = String(text).split(/\r?\n/)
  const out = []
  const start = lines.findIndex((l) => /^nodes:\s*$/.test(l))
  if (start < 0) {
    const one = lines.find((l) => /^nodes:\s*\[/.test(l))
    if (one) {
      for (const item of splitTopLevel(one.replace(/^nodes:\s*\[/, '').replace(/\]\s*(?:#.*)?$/, ''))) {
        const t = inlineMapType(item)
        if (t) out.push(t)
      }
    }
    return [...new Set(out)]
  }
  let keyIndent = -1
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) break // 回到顶层键 → nodes 块结束
    const ind = line.match(/^\s*/)[0].length
    const dash = line.match(/^(\s*)-\s+/)
    if (dash) {
      const entry = line.slice(dash[0].length)
      keyIndent = dash[0].length
      const inline = entry.match(/^\{(.*)\}\s*$/)
      if (inline) {
        const t = inlineMapType(inline[1])
        if (t) out.push(t)
        keyIndent = -1
        continue
      }
      const key = entry.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
      if (!key || (key[1] !== 'id' && key[1] !== 'name')) keyIndent = -1
      if (key && key[1] === 'type') { const v = key[2].trim().split(/[\s,]/)[0].replace(/^["']|["']$/g, ''); if (v) out.push(v) }
      continue
    }
    if (keyIndent < 0) continue
    if (ind < keyIndent) { keyIndent = -1; continue }
    if (ind !== keyIndent) continue // 更深缩进 = 节点子块（config/inputs/块标量正文）
    const k = line.trim().match(/^type\s*:\s*(.+?)\s*$/)
    if (k) { const v = k[1].split(/[\s,]/)[0].replace(/^["']|["']$/g, ''); if (v) out.push(v) }
  }
  return [...new Set(out)]
}

// 轻量元数据（仅列表展示；valid 由宿主 validate 覆盖，缺省 true）
export function parseWorkflowMeta(yml) {
  const text = String(yml || '')
  const inlineList = (key) => {
    const m = text.match(new RegExp('^' + key + ':\\s*\\[(.*?)\\]\\s*$', 'm'))
    if (!m) return []
    return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
  const nlList = (key) => {
    const m = text.match(new RegExp('^' + key + ':\\s*\\n((?:\\s*-\\s*.+\\n?)+)', 'm'))
    return m ? m[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : []
  }
  // DSL v2 裸标量写法：`triggers: spec 开发, spec-dev`（逗号分隔，中英文逗号均可）
  const csvList = (key) => {
    const m = text.match(new RegExp('^' + key + ':[ \\t]*([^\\[\\n]+)', 'm'))
    if (!m) return []
    return m[1].replace(/\s*$/, '').split(/[,，]/).map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
  const exposeMode = (text.match(/^expose:\s*\{\s*mode:\s*([a-z]+)/m) || text.match(/^expose:\s*\n(?:.*\n)*?\s+mode:\s*([a-z]+)/m) || [])[1]
  const toolName = (text.match(/tool_name:\s*(\S+)/) || [])[1] || ''
  return {
    name: grab(text, 'name'),
    description: grab(text, 'description'),
    version: grab(text, 'version'),
    // 【S2-D4 归属字段】暴露落盘的 authorId/workspaceId（写入侧见 writeWorkflowYml 的收口注入）。
    // 缺失时与其他元数据键同一约定返回**空串**（`grab` 的既有行为，name/description 亦然）——
    // 不伪造默认值，读侧用 falsy 判断即可区分"从未记录"与"已归属"。
    authorId: grab(text, 'authorId'),
    workspaceId: grab(text, 'workspaceId'),
    triggers: inlineList('triggers').length ? inlineList('triggers') : (nlList('triggers').length ? nlList('triggers') : csvList('triggers')),
    expose: { mode: exposeMode || 'private', ...(toolName ? { tool_name: toolName.replace(/["',}]/g, '') } : {}) },
    nodeCount: sectionCount(text, 'nodes'),
    edgeCount: sectionCount(text, 'edges'),
    legacy: !/^edges:\s*$/m.test(text),
    hasEnd: /type:\s*(end|answer)/.test(text),
    settings: { max_parallel: Number((text.match(/max_parallel:\s*(\d+)/) || [])[1] || 4) },
  }
}

export function listWorkflowMetas({ root, runsRoot = '' } = {}) {
  if (!root || !existsSync(root)) return []
  const out = []
  for (const it of readdirSync(root, { withFileTypes: true })) {
    if (!it.isDirectory() || it.name.startsWith('_') || it.name.startsWith('.')) continue
    const f = wfFile(root, it.name)
    if (!existsSync(f)) continue
    let yml = ''
    try { yml = readFileSync(f, 'utf-8') } catch { continue }
    const meta = parseWorkflowMeta(yml)
    let updatedAt = 0
    try { updatedAt = statSync(f).mtimeMs } catch {}
    out.push({ id: it.name, ...meta, valid: true, updatedAt, lastRun: lastRunOf(runsRoot, meta.name || it.name) })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function lastRunOf(runsRoot, name) {
  if (!runsRoot) return null
  const dir = join(runsRoot, name)
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    if (!files.length) return null
    const lines = readFileSync(join(dir, files[files.length - 1]), 'utf-8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1])
    return { at: files[files.length - 1], status: last.status || 'unknown', nodes: lines.length }
  } catch { return null }
}

export function readWorkflowYml({ root, id }) {
  assertSafeId(id)
  const f = wfFile(root, id)
  if (!existsSync(f)) return null
  return readFileSync(f, 'utf-8')
}

/**
 * 【S2-D4 归属字段落盘】把 `authorId`/`workspaceId` 补进工作流 YAML 的元数据。
 *
 * 为什么放在**写入收口**：新建 / 保存 / 复制（还原版本）都经 `writeWorkflowYml` ⇒ 一处生效，
 * 且工作流编辑器（渲染层）无需知道归属概念。
 * 为什么是**文本级注入**而不是"用 DSL 解析后重新序列化"：重新序列化会丢掉用户 YAML 里的
 * 注释与排版（属破坏性改写），而注入只加两行。
 * 幂等：已有该键则不重复写（`grab` 命中即跳过）——还原旧版本、重复保存都不会累积字段。
 *
 * 注意：`kernel/workflow-dsl.mjs` 的 `TOP_KEYS` / `serializeWorkflow` 也已把这两个键纳入 ——
 * 否则编辑器"加载→序列化"一往返就会把归属**静默丢掉**（那比不写更糟）。
 */
function ensureAttribution(yml) {
  const { authorId, workspaceId } = attributionOf()
  const out = String(yml)
  const missing = []
  if (!grab(out, 'authorId')) missing.push(`authorId: ${authorId}`)
  if (!grab(out, 'workspaceId')) missing.push(`workspaceId: ${workspaceId}`)
  if (!missing.length) return out
  const block = missing.join('\n') + '\n'
  // 插在 `name:` 行之后（serializeWorkflow 的规范输出以 name 开头；万一没有则前置）
  const m = out.match(/^name:[^\n]*\n/m)
  return m ? out.replace(m[0], m[0] + block) : block + out
}

export function writeWorkflowYml({ root, id, yml }) {
  assertSafeId(id)
  mkdirSync(wfDir(root, id), { recursive: true })
  const f = wfFile(root, id)
  let backup = ''
  if (existsSync(f)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    mkdirSync(versionsDir(root, id), { recursive: true })
    backup = join(versionsDir(root, id), `${ts}.yml`)
    try { copyFileSync(f, backup) } catch { backup = '' }
    const all = readdirSync(versionsDir(root, id)).filter((x) => x.endsWith('.yml')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - VERSION_KEEP))) {
      try { rmSync(join(versionsDir(root, id), old), { force: true }) } catch {}
    }
  }
  writeFileSync(f, ensureAttribution(yml), 'utf-8')
  return { ok: true, id, backup }
}

export function createWorkflow({ root, id, yml }) {
  assertSafeId(id)
  if (existsSync(wfFile(root, id))) return { ok: false, error: `工作流已存在: ${id}` }
  return writeWorkflowYml({ root, id, yml })
}

export function deleteWorkflow({ root, id }) {
  assertSafeId(id)
  const dir = wfDir(root, id)
  if (!existsSync(dir)) return { ok: false, error: `工作流不存在: ${id}` }
  rmSync(dir, { recursive: true, force: true })
  return { ok: true, id }
}

export function duplicateWorkflow({ root, fromId, toId }) {
  const yml = readWorkflowYml({ root, id: fromId })
  if (!yml) return { ok: false, error: `源工作流不存在: ${fromId}` }
  return createWorkflow({ root, id: toId, yml })
}

export function listVersions({ root, id }) {
  const dir = versionsDir(root, id)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.yml')).sort().reverse().map((f) => ({ ts: f.replace(/\.yml$/, ''), path: join(dir, f) }))
}

export function rollbackVersion({ root, id, ts }) {
  assertSafeId(id)
  assertSafeTs(ts)
  const p = join(versionsDir(root, id), `${ts}.yml`)
  if (!existsSync(p)) return { ok: false, error: `版本不存在: ${ts}` }
  const yml = readFileSync(p, 'utf-8')
  return writeWorkflowYml({ root, id, yml })
}

export function exportBundle({ root, id }) {
  const yml = readWorkflowYml({ root, id })
  if (!yml) return { ok: false, error: `工作流不存在: ${id}` }
  const bundle = {
    format: BUNDLE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workflow: yml,
    manifest: { kernelMinVersion: '0.2', requiredTools: [], nodeTypes: nodeTypesOf(yml) },
  }
  return { bundle, filename: `${id}.yfwflow` }
}

export function importBundle({ root, bundle, id }) {
  const b = bundle || {}
  if (b.format !== BUNDLE_FORMAT) return { ok: false, error: `格式不符（期望 ${BUNDLE_FORMAT}）` }
  if (Number(b.schemaVersion) > SCHEMA_VERSION) return { ok: false, error: `schemaVersion ${b.schemaVersion} 高于本机支持的 ${SCHEMA_VERSION}，请升级应用` }
  if (typeof b.workflow !== 'string' || !b.workflow.trim()) return { ok: false, error: '包内缺少 workflow 定义' }
  const warnings = []
  const meta = parseWorkflowMeta(b.workflow)
  if (meta.legacy) warnings.push('该工作流为旧 DSL 格式（无 edges），导入后需先迁移')
  const targetId = assertSafeId(id || meta.name || `imported-${Date.now()}`)
  if (existsSync(wfFile(root, targetId))) warnings.push(`已存在同名工作流 ${targetId}，本次为覆盖（旧版已快照）`)
  const r = writeWorkflowYml({ root, id: targetId, yml: b.workflow })
  return { ...r, id: targetId, warnings, meta }
}

const bindingsFile = (root) => join(root, '_bindings.json')

export function readBindings({ root }) {
  try { return JSON.parse(readFileSync(bindingsFile(root), 'utf-8')) } catch { return { agents: {}, trusted: [] } }
}

export function writeBindings({ root, bindings }) {
  mkdirSync(root, { recursive: true })
  const next = { agents: bindings?.agents || {}, trusted: bindings?.trusted || [] }
  writeFileSync(bindingsFile(root), JSON.stringify(next, null, 2), 'utf-8')
  return { ok: true }
}

export function recentRuns({ runsRoot, id, name = '', limit = 20 }) {
  if (!runsRoot) return []
  try {
    const dir = join(runsRoot, name || id)
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, limit)
      .map((f) => {
        const p = join(dir, f)
        const lines = readFileSync(p, 'utf-8').trim().split('\n')
        let last = {}
        try { last = JSON.parse(lines[lines.length - 1]) } catch {}
        return { file: f, path: p, ts: f.split('-').slice(0, 3).join('-'), steps: lines.length, status: last.status || 'unknown' }
      })
  } catch { return [] }
}
