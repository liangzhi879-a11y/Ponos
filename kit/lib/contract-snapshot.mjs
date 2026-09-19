// kit/lib/contract-snapshot.mjs —— 契约快照（DevKit P1 · T6）
//
// 快照 = **从代码复算出来的契约事实**，落盘在 `versions.json#channels`（P0 已预留该槽位）。
// 三条设计不变量（每条都由 contract-snapshot.test.mjs 的断言钉住）：
//
//   I1 **只存语义键，绝不存 file:line**（plan §6 D2 的"搬家免疫"）。
//      端点的**判定位置**会随"端点拆分 P1（把 handler 从 bridge.mjs 搬到 *-routes.mjs）"漂移，
//      而契约本身不变 ⇒ 位置只进 `finding.hint`（现场重算时给出），不进快照。
//      判据是**逐条键名断言**（见测试的"绝不存 file:line"），不是"看起来像"。
//   I2 **机器字段 vs 人工段**：`MACHINE_FIELDS`（routes/routePrefixes/wsOut/wsIn/ipc/tools/
//      staticToolCount/toolSources/excluded）由 `buildSnapshot` 复算；`scopeCount`/`scopeRedCount`/
//      `history` 是**人工段**（封顶值），`buildSnapshot` **不产出**它们 ⇒ `syncVersions` 的合并写
//      不会把它们冲掉（同一心智先例：deps.json 的 notes/gates/sizes）。
//   I3 **不看快照下结论**：`diffSnapshot` 只做比较；CT1 的比较对象是**现场重算**的结果，
//      快照里存的值永远只是"被比较的一方"（"CT1 读快照当答案"是 plan §7 反例 ⑤）。
//
// ★ 快照的读取刻意不 import ledger.mjs（自带一次 JSON 读）：`readSnapshot` 要能在"台账是坏文件"
//   时返回 null 而不是抛错，也要避免 ledger ↔ snapshot 的循环依赖（ledger 将来若要用 diffSnapshot）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trackedFiles, codeFiles, readTracked } from './scan.mjs'
import { extractRoutes } from './contract-routes.mjs'
import { extractWs } from './contract-ws.mjs'
import { extractIpc } from './contract-ipc.mjs'
import { extractTools } from './contract-tools.mjs'

/** 落点：`versions.json#channels`（P0 起就存在的预留槽位） */
export const CHANNELS_FIELD = 'channels'
export const VERSIONS_REL = 'kit/manifest/versions.json'

/** 由代码复算的字段（CT0 判形状、CT1 判相等都只覆盖这些） */
export const MACHINE_FIELDS = ['routes', 'routePrefixes', 'wsOut', 'wsIn', 'ipc', 'tools',
  'staticToolCount', 'toolSources', 'excluded']
/** 人工段（sync 原样保留；**绝不由 buildSnapshot 产出** —— 否则"封顶值"永远自洽，等于没有封顶） */
export const HUMAN_FIELDS = ['scopeCount', 'scopeRedCount', 'history']

const IPC_KEYS = ['invoke', 'handle', 'send', 'on', 'push']

/** excluded 条目里的分类：reason 的机读前缀（`root-path-check：…` → `root-path-check`） */
function kindOf(reason) { return String(reason).split('：')[0] }

const sorted = (arr) => [...arr].sort()

/**
 * 构造契约快照（**纯读**：不写任何文件）。
 * @param {{root: string, files?: string[], readTracked?: (f: string) => (string|null), now?: string}} p
 *   `files` 省略则走 `trackedFiles`（`git ls-files`，不变量 I2）；`readTracked` 默认绑 root。
 * @returns {Promise<object>} 快照（含 `snapshotAt`；**不含**人工段字段）
 */
export async function buildSnapshot({ root, files = null, readTracked: rt = null, now = undefined } = {}) {
  if (!root) throw new Error('buildSnapshot: 缺少 root')
  const tracked = files || trackedFiles({ root })
  const read = rt || ((f) => readTracked({ root, file: f }))
  // ★ 测试文件必须剔掉（T1 的 I2 教训：raw trackedFiles 直传会多出 test 里的端点；
  //   `.e2e.mjs` 不是 `*.test.mjs`，仍在域内 —— 它由提取器的 client-harness 角色排除，不是这里筛）。
  const code = codeFiles(tracked, { includeTests: false })

  const routes = extractRoutes({ files: tracked, readTracked: read })
  const ws = extractWs({ files: code, readTracked: read })
  const ipc = extractIpc({ files: code, readTracked: read })
  const tools = await extractTools({ root })

  // ── 路由：只存语义键（值恒 null）+ 前缀命名空间（动态段的"能不能枚举"必须可判，见 T1 的 I5）──
  const routesOut = {}
  for (const k of sorted(routes.routes.keys())) routesOut[k] = null
  const prefixesOut = {}
  for (const p of [...routes.prefixes].sort((a, b) => (a.prefix < b.prefix ? -1 : 1))) {
    prefixesOut[p.prefix] = {
      dynamic: p.dynamic ? String(p.dynamic.pattern) : null,
      segments: p.dynamic ? sorted(p.dynamic.segments.map((x) => x.literal)) : [],
      suffixes: p.dynamic ? sorted(p.dynamic.suffixes.map((x) => x.literal)) : [],
      childCount: p.children.length,
    }
  }

  // ── 排除清单：四类提取器的 excluded 合并、去重（快照无 file:line ⇒ 同一字面量多处只留一条）──
  const exMap = new Map()
  for (const e of [...routes.excluded, ...ws.excluded]) {
    const kind = kindOf(e.reason)
    exMap.set(JSON.stringify([kind, e.literal, e.reason]), { kind, literal: e.literal, reason: e.reason })
  }
  const excluded = [...exMap.values()].sort((a, b) => (a.kind === b.kind
    ? (a.literal === b.literal ? (a.reason < b.reason ? -1 : 1) : (a.literal < b.literal ? -1 : 1))
    : (a.kind < b.kind ? -1 : 1)))

  const toolsOut = {}
  for (const n of sorted(tools.names)) toolsOut[n] = tools.shapeOf(n)
  const toolSources = {}
  for (const s of tools.sources) {
    toolSources[s.id] = { file: s.file, role: s.role, present: s.present, ...(s.error ? { error: s.error } : {}) }
  }

  const ipcOut = {}
  for (const k of IPC_KEYS) ipcOut[k] = sorted(ipc[k])

  return {
    snapshotAt: now === undefined ? new Date().toISOString() : now,
    routes: routesOut,
    routePrefixes: prefixesOut,
    wsOut: sorted(ws.out),
    wsIn: sorted(ws.in),
    ipc: ipcOut,
    tools: toolsOut,
    staticToolCount: tools.staticCount,
    toolSources,
    excluded,
  }
}

/** 读 `versions.json`（坏文件/缺失 → null；不抛 —— 由 CT0 报红） */
function readVersionsFile(root) {
  const p = join(root, VERSIONS_REL)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * 读快照（`versions.json#channels`）。
 * @returns {object|null} 缺失 / 非对象（含数组）→ null
 */
export function readSnapshot({ root, versions = null } = {}) {
  const v = versions || readVersionsFile(root)
  const c = v ? v[CHANNELS_FIELD] : null
  return c && typeof c === 'object' && !Array.isArray(c) ? c : null
}

/** 普通对象（排除 null 与数组） */
function isObj(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v) }

/**
 * 快照形状问题清单（**零依赖**：仓里没有 JSON Schema 校验器，`versions.schema.json` 全仓零引用）。
 * 返回字符串数组，空数组 = 形状合法。CT0 直接消费它，测试的 `assertChannelsShape()` 也消费它。
 */
export function channelsProblems(s, label = 'channels') {
  const out = []
  if (!isObj(s)) return [`${label} 缺失或不是对象（versions.json#${label}）`]
  if (!isObj(s.routes)) out.push(`${label}.routes 必须是对象（语义键 → null）`)
  if (!isObj(s.routePrefixes)) out.push(`${label}.routePrefixes 必须是对象（前缀命名空间 → 可枚举性）`)
  if (!Array.isArray(s.wsOut)) out.push(`${label}.wsOut 必须是数组`)
  if (!Array.isArray(s.wsIn)) out.push(`${label}.wsIn 必须是数组`)
  if (!isObj(s.ipc)) out.push(`${label}.ipc 必须是对象`)
  else {
    const missing = IPC_KEYS.filter((k) => !Array.isArray(s.ipc[k]))
    if (missing.length) out.push(`${label}.ipc 缺数组字段：${missing.join('/')}`)
  }
  if (!isObj(s.tools)) out.push(`${label}.tools 必须是对象（工具名 → 8hex 结构指纹）`)
  if (!Number.isInteger(s.staticToolCount)) out.push(`${label}.staticToolCount 必须是整数（抓不到时写 0，不写 null）`)
  if (!isObj(s.toolSources)) out.push(`${label}.toolSources 必须是对象（动态源逐条登记）`)
  if (!Array.isArray(s.excluded)) out.push(`${label}.excluded 必须是数组（逐条 reason）`)
  else {
    const bad = s.excluded.filter((e) => !isObj(e) || typeof e.literal !== 'string' || typeof e.reason !== 'string' || !String(e.reason).trim())
    if (bad.length) out.push(`${label}.excluded 有 ${bad.length} 条缺 literal/reason（禁止无理由的排除）`)
  }
  if (s.snapshotAt !== undefined && typeof s.snapshotAt !== 'string') out.push(`${label}.snapshotAt 必须是字符串`)
  if (s.scopeCount !== undefined && !Number.isInteger(s.scopeCount)) out.push(`${label}.scopeCount 存在时必须是整数（人工封顶值）`)
  if (s.scopeRedCount !== undefined && !Number.isInteger(s.scopeRedCount)) out.push(`${label}.scopeRedCount 存在时必须是整数（人工封顶值）`)
  return out
}

const asText = (v) => (v === undefined ? '(缺)' : (typeof v === 'string' ? v : JSON.stringify(v)))

/** 集合差异（逐个元素一条），`from`/`to` 用"有/缺"表达 */
function setDiffs(diffs, kind, a, b) {
  const A = new Set(a || [])
  const B = new Set(b || [])
  for (const x of [...A].sort()) if (!B.has(x)) diffs.push({ kind, key: String(x), from: '有', to: '缺' })
  for (const x of [...B].sort()) if (!A.has(x)) diffs.push({ kind, key: String(x), from: '缺', to: '有' })
}

/** 映射差异（键集合 + 每键值） */
function mapDiffs(diffs, kind, a, b) {
  const A = isObj(a) ? a : {}
  const B = isObj(b) ? b : {}
  setDiffs(diffs, kind, Object.keys(A), Object.keys(B))
  for (const k of Object.keys(A).sort()) {
    if (!Object.hasOwn(B, k)) continue
    const av = JSON.stringify(A[k])
    const bv = JSON.stringify(B[k])
    if (av !== bv) diffs.push({ kind, key: k, from: asText(av), to: asText(bv) })
  }
}

/**
 * 比较两份快照的**机器字段**（人工段与 `snapshotAt` 不参与 —— 否则每次 sync 都会"有差异"）。
 * @returns {{equal: boolean, diffs: Array<{kind:string, key:string, from:string, to:string}>}}
 */
export function diffSnapshot(a, b) {
  const diffs = []
  const A = isObj(a) ? a : {}
  const B = isObj(b) ? b : {}
  mapDiffs(diffs, 'routes', A.routes, B.routes)
  mapDiffs(diffs, 'routePrefixes', A.routePrefixes, B.routePrefixes)
  setDiffs(diffs, 'wsOut', A.wsOut, B.wsOut)
  setDiffs(diffs, 'wsIn', A.wsIn, B.wsIn)
  for (const k of IPC_KEYS) setDiffs(diffs, `ipc.${k}`, A.ipc ? A.ipc[k] : [], B.ipc ? B.ipc[k] : [])
  mapDiffs(diffs, 'tools', A.tools, B.tools)
  if (A.staticToolCount !== B.staticToolCount) {
    diffs.push({ kind: 'staticToolCount', key: 'staticToolCount', from: asText(A.staticToolCount), to: asText(B.staticToolCount) })
  }
  mapDiffs(diffs, 'toolSources', A.toolSources, B.toolSources)
  // excluded：按 (kind|literal|reason) 三元组做集合比较（快照里没有 file:line，故逐条比即可）
  const exKey = (e) => `${kindOf(e && e.reason)}|${e && e.literal}|${e && e.reason}`
  setDiffs(diffs, 'excluded', (A.excluded || []).map(exKey), (B.excluded || []).map(exKey))
  return { equal: diffs.length === 0, diffs }
}
