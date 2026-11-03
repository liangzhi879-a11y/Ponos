// kernel/atlas/query.mjs —— Atlas 查询（overview/find/card/impact/related/path）
// ---------------------------------------------------------------------------
// 查询只读内存中的 nodes/edges，不重新扫盘。排序是确定性的：分数 → 重要度 → 路径。
// 中文检索用“整串 + bigram”（不引入分词依赖）：查“聊天窗口”会同时命中
// “聊天”“天窗”“窗口”，够用且不会把专有名词拆坏。
import fs from 'node:fs'
import path from 'node:path'
import {
  renderOverview, renderL1, renderCard, L1_BUDGET,
} from './render.mjs'
import { edgeCoverage } from './coverage.mjs'
import { allEdges, includeShardState } from './edge-shard.mjs'

const STOP = new Set([
  '的', '了', '和', '与', '在', '是', '有', '个', '文件', '代码', '模块', '功能',
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'file', 'module',
])

const KINDS = new Set(['code', 'test', 'doc', 'file', 'domain', 'layer'])
const IMPACT_TYPES = new Set(['imports', 'references', 'tests', 'code_mentions_doc'])

const CPP_LANGS = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'inl', 'ipp'])
const CPP_HEADER_RE = /\.(?:h|hh|hpp|hxx|inl|ipp)$/i
const MOCK_PATH_RE = /(?:^|[._/-])(?:mock|fake|stub)(?:[._/-]|$)/i

function stemOf(rel) {
  const base = path.posix.basename(String(rel || ''))
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(0, i) : base
}

function isCppNode(n) {
  return CPP_LANGS.has(String(n?.lang || '').toLowerCase())
}

function listNodes(atlas) {
  return (atlas?.nodes || []).filter((n) => n.kind !== 'domain' && n.kind !== 'layer')
}

export function tokenize(q) {
  const raw = String(q ?? '').toLowerCase().trim()
  if (!raw) return []
  const out = new Set()
  for (const part of raw.split(/[\s,，。;；:：/\\|()（）[\]{}"'`]+/)) {
    if (!part) continue
    if (!STOP.has(part)) out.add(part)
    if (/[㐀-鿿]/.test(part)) {
      if (part.length === 1) out.add(part)
      for (let i = 0; i < part.length - 1; i++) {
        const bg = part.slice(i, i + 2)
        if (!STOP.has(bg)) out.add(bg)
      }
    }
  }
  return [...out]
}

function nodeTexts(n) {
  const headings = (n.headings || []).map((h) => h.text || '').join(' ')
  return {
    path: String(n.path || '').toLowerCase(),
    base: path.posix.basename(String(n.path || '')).toLowerCase(),
    purpose: String(n.purpose || '').toLowerCase(),
    title: String(n.title || '').toLowerCase(),
    headings: headings.toLowerCase(),
    exports: (n.exports || []).join(' ').toLowerCase(),
    domain: String(n.domain || '').toLowerCase(),
  }
}

function matchNode(n, tokens, raw) {
  const t = nodeTexts(n)
  let score = 0
  const matched = new Set()
  for (const tok of tokens) {
    if (!tok) continue
    if (t.base === tok) { score += 120; matched.add('path') }
    else if (t.base.includes(tok)) { score += 60; matched.add('path') }
    if (t.path.includes(tok)) { score += 25; matched.add('path') }
    if (t.purpose.includes(tok)) { score += 30; matched.add('purpose') }
    if (t.title.includes(tok)) { score += 20; matched.add('title') }
    if (t.headings.includes(tok)) { score += 8; matched.add('headings') }
    if (t.exports.includes(tok)) { score += 15; matched.add('exports') }
    if (t.domain.includes(tok)) { score += 10; matched.add('domain') }
  }
  if (raw && t.purpose.includes(raw)) { score += 40; matched.add('purpose') }
  if (raw && t.path.includes(raw)) { score += 30; matched.add('path') }
  return { score, matched: [...matched] }
}

/**
 * @param {any} n
 * @param {Record<string, any>} [extra]
 * @returns {{id:any, kind:any, path:any, purpose:any, confidence:any, importance:any, domain:any, layer:any, [key:string]:any}}
 */
function compactNode(n, extra = {}) {
  return {
    id: n.id,
    kind: n.kind,
    path: n.path,
    purpose: n.purpose,
    confidence: n.confidence,
    importance: n.importance ?? 1,
    domain: n.domain || null,
    layer: n.layer || null,
    ...extra,
  }
}

export function resolveNode(atlas, idOrPath) {
  const needle = String(idOrPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!needle) return { node: null, candidates: [] }
  const byId = new Map((atlas?.nodes || []).map((n) => [n.id, n]))
  if (byId.has(needle)) return { node: byId.get(needle), candidates: [] }
  const paths = atlas?.index?.paths || {}
  if (paths[needle]) return { node: byId.get(paths[needle]) || null, candidates: [] }
  const exact = (atlas?.nodes || []).filter((n) => n.path === needle)
  if (exact.length === 1) return { node: exact[0], candidates: [] }
  const suffix = (atlas?.nodes || []).filter((n) => n.path && (n.path.endsWith('/' + needle) || path.posix.basename(n.path) === needle))
  if (suffix.length === 1) return { node: suffix[0], candidates: [] }
  return { node: null, candidates: suffix.slice(0, 8) }
}

/**
 * @param {any} atlas
 * @param {{level?:'l0'|'l1', budget?:number}} [opts]
 */
export function overview(atlas, { level = 'l1', budget } = {}) {
  if (level === 'l0') return { level: 'l0', text: renderOverview(atlas, budget ? { budget } : undefined) }
  return { level: 'l1', text: renderL1(atlas, budget ? { budget } : undefined), budget: budget || L1_BUDGET }
}

/**
 * @param {any} atlas
 * @param {string} query
 * @param {{kind?:string, limit?:number, pathPrefix?:string, domain?:string, layer?:string}} [opts]
 */
export function find(atlas, query, { kind, limit = 10, pathPrefix, domain, layer } = {}) {
  const raw = String(query ?? '').toLowerCase().trim()
  const tokens = tokenize(raw)
  const kinds = kind ? new Set(String(kind).split(/[,|]/).map((s) => s.trim()).filter((s) => KINDS.has(s))) : null
  const domainNeedle = String(domain ?? '').trim()
  const layerNeedle = String(layer ?? '').trim()
  if (!tokens.length && !pathPrefix && !domainNeedle && !layerNeedle) return { query, tokens, results: [] }
  const out = []
  for (const n of listNodes(atlas)) {
    if (kinds && !kinds.has(n.kind)) continue
    if (pathPrefix && !String(n.path || '').startsWith(pathPrefix)) continue
    if (domainNeedle && String(n.domain || '') !== domainNeedle && !String(n.domain || '').startsWith(domainNeedle + '/')) continue
    if (layerNeedle && String(n.layer || '') !== layerNeedle) continue
    const m = tokens.length ? matchNode(n, tokens, raw) : { score: 1, matched: [] }
    if (m.score <= 0) continue
    out.push(compactNode(n, { score: m.score, matched: m.matched }))
  }
  out.sort((a, b) => b.score - a.score || b.importance - a.importance || a.path.localeCompare(b.path))
  const cap = Math.max(1, Math.min(50, Number(limit) || 10))
  return { query, tokens, results: out.slice(0, cap), total: out.length }
}

function edgeIndex(edges) {
  const incoming = new Map()
  const outgoing = new Map()
  for (const e of edges || []) {
    if (!incoming.has(e.to)) incoming.set(e.to, [])
    incoming.get(e.to).push(e)
    if (!outgoing.has(e.from)) outgoing.set(e.from, [])
    outgoing.get(e.from).push(e)
  }
  return { incoming, outgoing }
}

function byIdMap(atlas) {
  return new Map((atlas?.nodes || []).map((n) => [n.id, n]))
}

/**
 * C/C++ impact 分组：只按**真实存在的 #include 边**分类，不靠命名猜调用。
 * 声明 = 该实现包含的同名头文件（只有出边）；实现 = 与头文件同名的 .cc/.cxx；
 * mock 先于调用方判定（mock 文件也常是生产代码命名）；测试按节点 kind。
 */
function includeGroupsFor(source, incoming, outgoing, byId) {
  const groups = { declaration: [], implementation: [], mocks: [], callers: [], tests: [] }
  if (!isCppNode(source)) return null
  const targetIsHeader = CPP_HEADER_RE.test(String(source.path || ''))
  const srcStem = stemOf(source.path)
  const push = (key, n) => {
    if (!n || groups[key].some((x) => x.id === n.id)) return
    groups[key].push(n)
  }
  for (const e of incoming.get(source.id) || []) {
    if (e.via !== 'include') continue
    const from = byId.get(e.from)
    if (!from) continue
    if (from.kind === 'test') push('tests', from)
    else if (MOCK_PATH_RE.test(String(from.path || ''))) push('mocks', from)
    else if (targetIsHeader && stemOf(from.path) === srcStem) push('implementation', from)
    else push('callers', from)
  }
  if (!targetIsHeader) {
    for (const e of outgoing.get(source.id) || []) {
      if (e.via !== 'include') continue
      const to = byId.get(e.to)
      if (to && CPP_HEADER_RE.test(String(to.path || '')) && stemOf(to.path) === srcStem) push('declaration', to)
    }
  }
  const sort = (list) => list
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || String(a.path).localeCompare(String(b.path)))
  const out = {}
  for (const [key, list] of Object.entries(groups)) {
    sort(list)
    out[key] = { count: list.length, sample: list.slice(0, 8) }
  }
  return out
}

/**
 * 查询前按节点复核源文件（spec §5.5）。命中 mtime+size → 零成本。
 *
 * ★ 变化时**只标 stale，不在查询路径重建**（2026-10-21 假死事故）：
 * 旧实现会在这里同步调用 buildAtlas，一次 card/impact 就可能触发全工作区扫描；
 * 大目录（11k 文件）实测 5.5 分钟，模型表现为“工具卡死”。重建改为显式
 * ProjectAtlas(op=build)，由 agent 选择范围与时机。
 */
function refreshForNode(atlas, node) {
  if (!atlas?.meta?.root || !atlas?.dir || !node?.path ||
      node.kind === 'domain' || node.kind === 'layer') {
    return { atlas, stale: false, refreshed: false }
  }
  let st
  try {
    st = fs.statSync(path.join(atlas.meta.root, node.path))
  } catch {
    return { atlas, stale: true, refreshed: false, error: 'source-missing' }
  }
  if (st.mtimeMs === node.mtimeMs && st.size === node.size) {
    return { atlas, stale: false, refreshed: false }
  }
  return { atlas, stale: true, refreshed: false, changed: true, error: 'source-changed' }
}

/**
 * @param {any} atlas
 * @param {string} idOrPath
 * @param {{budget?:number}} [opts]
 * @returns {{ok:boolean, [key:string]:any}} 成功/失败两种形状；调用方先看 `ok`
 *   （写成索引签名而不是逐字段 union：`ok` 推导为 `boolean` 而非字面量，
 *   判别式收窄不成立，写窄了消费方读 `.text` 会 TS2339）
 */
export function card(atlas, idOrPath, { budget } = {}) {
  const { node, candidates } = resolveNode(atlas, idOrPath)
  if (!node) {
    return {
      ok: false,
      reason: 'not-found',
      query: idOrPath,
      candidates: candidates.map((n) => compactNode(n)),
      suggestions: find(atlas, idOrPath, { limit: 5 }).results,
    }
  }
  const fresh = refreshForNode(atlas, node)
  // 源文件消失仍按错误返回；仅“内容变了”允许返回旧卡并标 stale，
  // 由调用方提示 agent 用 op=build 显式刷新。
  if (fresh.stale && fresh.error === 'source-missing') {
    return {
      ok: false,
      reason: 'source-missing',
      query: idOrPath,
      stale: true,
      error: fresh.error,
    }
  }
  const target = node
  return {
    ok: true,
    stale: fresh.stale,
    refreshed: fresh.refreshed,
    refreshNeeded: fresh.changed === true,
    ...(fresh.error ? { refreshError: fresh.error } : {}),
    edgeCoverage: edgeCoverage(target),
    node: compactNode(target, {
      purposeSrc: target.purposeSrc,
      flags: target.flags || [],
      exports: target.exports || [],
      subjects: target.subjects || [],
      title: target.title || null,
      headings: target.headings || [],
      noText: target.noText === true,
      textTruncated: target.textTruncated === true,
      textSource: target.textSource || null,
      docTextReason: target.docTextReason || null,
      tooLarge: target.tooLarge === true,
      stats: target.stats || null,
    }),
    text: renderCard(atlas, target.id, budget ? { budget } : undefined),
  }
}

/**
 * @param {any} atlas
 * @param {string} idOrPath
 * @param {{depth?:number, limit?:number}} [opts]
 * @returns {{ok:boolean, [key:string]:any}} 见 `card`：`ok` 非字面量，故用索引签名
 */
export function impact(atlas, idOrPath, { depth = 3, limit = 40 } = {}) {
  const { node, candidates } = resolveNode(atlas, idOrPath)
  if (!node) {
    return {
      ok: false,
      reason: 'not-found',
      query: idOrPath,
      candidates: candidates.map((n) => compactNode(n)),
      suggestions: find(atlas, idOrPath, { limit: 5 }).results,
    }
  }
  const fresh = refreshForNode(atlas, node)
  // 源文件消失仍按错误返回；仅“内容变了”允许返回旧卡并标 stale，
  // 由调用方提示 agent 用 op=build 显式刷新。
  if (fresh.stale && fresh.error === 'source-missing') {
    return {
      ok: false,
      reason: 'source-missing',
      query: idOrPath,
      stale: true,
      error: fresh.error,
    }
  }
  const view = atlas
  const source = node
  const maxDepth = Math.max(1, Math.min(5, Number(depth) || 3))
  const cap = Math.max(1, Math.min(200, Number(limit) || 40))
  const byId = byIdMap(view)
  const { incoming, outgoing } = edgeIndex(allEdges(view))
  const includeGroups = includeGroupsFor(source, incoming, outgoing, byId)
  const includeShard = includeShardState(view)

  const direct = { imports: [], references: [], tests: [], docs: [] }
  const directIds = new Set()
  for (const e of incoming.get(source.id) || []) {
    const src = byId.get(e.from)
    if (!src) continue
    if (e.type === 'tests') direct.tests.push(src)
    else if (e.type === 'doc_mentions') { if (src.kind === 'doc') direct.docs.push(src) }
    else if (e.type === 'imports' || e.type === 'references' || e.type === 'code_mentions_doc') {
      // 测试文件的 import 归入“测试”，不再混进“依赖方”（否则同一文件被数两次）
      if (src.kind === 'test') direct.tests.push(src)
      else if (e.type === 'imports') direct.imports.push(src)
      else direct.references.push(src)
    } else continue
    directIds.add(e.from)
  }
  for (const k of Object.keys(direct)) {
    const seen = new Set()
    direct[k] = direct[k]
      .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
      .sort((a, b) => (b.importance || 0) - (a.importance || 0) || a.path.localeCompare(b.path))
  }

  const visited = new Set([source.id])
  const transitive = []
  let frontier = [source.id]
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next = []
    for (const id of frontier) {
      for (const e of incoming.get(id) || []) {
        if (!IMPACT_TYPES.has(e.type)) continue
        if (visited.has(e.from)) continue
        visited.add(e.from)
        const n = byId.get(e.from)
        if (!n) continue
        transitive.push({
          id: n.id,
          kind: n.kind,
          path: n.path,
          purpose: n.purpose,
          importance: n.importance ?? 1,
          depth: d,
          via: e.type,
          from: id,
          direct: directIds.has(n.id),
        })
        next.push(n.id)
        if (transitive.length >= cap) break
      }
      if (transitive.length >= cap) break
    }
    if (transitive.length >= cap) break
    frontier = next
  }

  const directCodeDependents = new Set(
    [...direct.imports, ...direct.references].filter((n) => n.kind === 'code').map((n) => n.path),
  )
  return {
    ok: true,
    stale: fresh.stale,
    refreshed: fresh.refreshed,
    refreshNeeded: fresh.changed === true,
    ...(fresh.error ? { refreshError: fresh.error } : {}),
    target: compactNode(source),
    edgeCoverage: edgeCoverage(source),
    direct,
    ...(includeGroups ? { includeGroups } : {}),
    includeShard,
    directCodeDependents: directCodeDependents.size,
    directDependents: directIds.size,
    transitive,
    total: transitive.length,
    truncated: transitive.length >= cap,
  }
}

/**
 * @param {any} atlas
 * @param {string} idOrPath
 * @param {{limit?:number}} [opts]
 * @returns {{ok:boolean, [key:string]:any}} 见 `card`：`ok` 非字面量，故用索引签名
 */
export function related(atlas, idOrPath, { limit = 12 } = {}) {
  const { node, candidates } = resolveNode(atlas, idOrPath)
  if (!node) {
    return {
      ok: false,
      reason: 'not-found',
      query: idOrPath,
      candidates: candidates.map((n) => compactNode(n)),
      suggestions: find(atlas, idOrPath, { limit: 5 }).results,
    }
  }
  const byId = byIdMap(atlas)
  const { incoming, outgoing } = edgeIndex(allEdges(atlas))
  const acc = new Map()
  const add = (e, direction) => {
    if (e.type === 'contains') return
    const otherId = direction === 'out' ? e.to : e.from
    if (!otherId || otherId === node.id) return
    const other = byId.get(otherId)
    if (!other) return
    if (!acc.has(otherId)) acc.set(otherId, { node: other, types: new Set(), direction })
    acc.get(otherId).types.add(e.type)
  }
  for (const e of outgoing.get(node.id) || []) add(e, 'out')
  for (const e of incoming.get(node.id) || []) add(e, 'in')
  const cap = Math.max(1, Math.min(50, Number(limit) || 12))
  const results = [...acc.values()]
    .sort((a, b) => b.types.size - a.types.size || (b.node.importance || 0) - (a.node.importance || 0) || a.node.path.localeCompare(b.node.path))
    .slice(0, cap)
    .map((x) => compactNode(x.node, { types: [...x.types].sort(), direction: x.direction }))
  return {
    ok: true,
    target: compactNode(node),
    edgeCoverage: edgeCoverage(node),
    includeShard: includeShardState(atlas),
    results,
    total: acc.size,
  }
}

/**
 * @param {any} atlas
 * @param {string} fromId
 * @param {string} toId
 * @param {{maxDepth?:number}} [opts]
 * @returns {{ok:boolean, [key:string]:any}} 见 `card`：`ok` 非字面量，故用索引签名
 */
export function pathBetween(atlas, fromId, toId, { maxDepth = 6 } = {}) {
  const a = resolveNode(atlas, fromId)
  const b = resolveNode(atlas, toId)
  if (!a.node || !b.node) {
    return {
      ok: false,
      reason: 'not-found',
      from: fromId,
      to: toId,
      candidates: [...a.candidates, ...b.candidates].map((n) => compactNode(n)),
    }
  }
  const byId = byIdMap(atlas)
  const adj = new Map()
  const add = (x, y, type, direction) => {
    if (!adj.has(x)) adj.set(x, [])
    adj.get(x).push({ to: y, type, direction })
  }
  for (const e of allEdges(atlas)) {
    if (e.type === 'contains') continue
    add(e.from, e.to, e.type, 'out')
    add(e.to, e.from, e.type, 'in')
  }
  const target = b.node.id
  const start = a.node.id
  const prev = new Map([[start, null]])
  const queue = [[start, 0]]
  let found = start === target
  while (queue.length && !found) {
    const [id, d] = queue.shift()
    if (d >= maxDepth) continue
    for (const step of adj.get(id) || []) {
      if (prev.has(step.to)) continue
      prev.set(step.to, { id, type: step.type, direction: step.direction })
      if (step.to === target) { found = true; break }
      queue.push([step.to, d + 1])
    }
  }
  if (!found) return { ok: true, found: false, from: compactNode(a.node), to: compactNode(b.node), steps: [] }
  const chain = []
  let cur = target
  while (cur && cur !== start) {
    const p = prev.get(cur)
    chain.push({ id: cur, path: byId.get(cur)?.path, kind: byId.get(cur)?.kind, via: p?.type, direction: p?.direction })
    cur = p?.id
  }
  chain.push({ id: start, path: a.node.path, kind: a.node.kind, via: null, direction: null })
  chain.reverse()
  return { ok: true, found: true, from: compactNode(a.node), to: compactNode(b.node), steps: chain }
}
