// server/workflow-store.mjs —— 工作流磁盘权威存储（CRUD / 版本 / 导入导出 / 绑定）
// 约束：本模块不得 import kernel/*（生产包只带 kernel-dist/cli.mjs 单文件 bundle）。
// 因此只做轻量正则元数据解析（列表展示用）；权威解析/校验/序列化一律经宿主会话。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const SCHEMA_VERSION = 2
export const BUNDLE_FORMAT = 'yfworking-workflow'
const VERSION_KEEP = 20

export const wfRootOf = (home) => join(home, 'workflows')
export const runsRootOf = (home) => join(home, 'workflow-runs')
const wfDir = (root, id) => join(root, id)
const wfFile = (root, id) => join(wfDir(root, id), 'workflow.yml')
const versionsDir = (root, id) => join(wfDir(root, id), 'versions')

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// 保留字：这些 id 与 /workflows/<sub> 的动作子路由冲突（如 /workflows/run、/workflows/verify），
// 必须禁止创建工作流时使用，否则该工作流永远打不开。
export const RESERVED_IDS = new Set(['run', 'stop', 'confirm', 'runs', 'import', 'export', 'bindings', 'verify', 'validate'])
export function assertSafeId(id) {
  const s = String(id || '')
  if (!SAFE_ID.test(s) || s.includes('..')) throw new Error(`非法工作流 id: ${id}`)
  if (RESERVED_IDS.has(s)) throw new Error(`工作流 id 不能使用保留字: ${id}（保留：${[...RESERVED_IDS].join('、')}）`)
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
  const exposeMode = (text.match(/^expose:\s*\{\s*mode:\s*([a-z]+)/m) || text.match(/^expose:\s*\n(?:.*\n)*?\s+mode:\s*([a-z]+)/m) || [])[1]
  const toolName = (text.match(/tool_name:\s*(\S+)/) || [])[1] || ''
  return {
    name: grab(text, 'name'),
    description: grab(text, 'description'),
    version: grab(text, 'version'),
    triggers: inlineList('triggers').length ? inlineList('triggers') : nlList('triggers'),
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
  writeFileSync(f, String(yml), 'utf-8')
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
    manifest: { kernelMinVersion: '0.2', requiredTools: [], nodeTypes: [...new Set((yml.match(/type:\s*([a-z_]+)/g) || []).map((s) => s.split(':')[1].trim()))] },
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
  const dir = join(runsRoot, name || id)
  try {
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
