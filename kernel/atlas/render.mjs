// kernel/atlas/render.mjs —— L0/L1/单卡渲染（按字节预算截断）
// ---------------------------------------------------------------------------
// 注入面不输出 JSON：L0 是 2–3 行“我在哪”，L1 是域/高重要度文件/关键文档，
// L2 是单文件卡（query card 才展开）。所有输出按 UTF-8 字节预算截断，优先在
// 行边界收尾，避免把一个多字节字符或半行塞给模型。
import path from 'node:path'
import { edgeCoverage, coverageLabel } from './coverage.mjs'
import { allEdges, includeShardState } from './edge-shard.mjs'

export const L0_BUDGET = 300
export const L1_BUDGET = 4096
export const CARD_BUDGET = 2048

const CPP_LANGS = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'inl', 'ipp'])
function isCppNode(n) {
  return CPP_LANGS.has(String(n?.lang || '').toLowerCase())
}

/** 按 UTF-8 字节截断；lineSafe 时尽量在最后一个换行处收尾。 */
export function truncateBytes(text, maxBytes, { lineSafe = true } = {}) {
  const s = String(text ?? '')
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  const suffix = '…'
  const limit = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (bytes + b > limit) break
    out += ch
    bytes += b
  }
  if (lineSafe) {
    const nl = out.lastIndexOf('\n')
    if (nl > 0 && nl >= out.length * 0.55) out = out.slice(0, nl)
  }
  return out.trimEnd() + suffix
}

function oneLine(s, max = 100) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function pct(a, b) {
  if (!b) return '0%'
  return Math.round((a / b) * 100) + '%'
}

function gitTag(meta) {
  const head = meta?.git?.head
  if (!head) return ''
  return `git ${head.slice(0, 8)}${meta.git.dirty ? '*' : ''}`
}

function dateTag(meta) {
  const s = meta?.createdAt
  return s ? s.slice(0, 16).replace('T', ' ') : ''
}

function countsFrom(atlas) {
  const s = atlas?.meta?.summary || atlas?.summary || {}
  return {
    content: s.contentNodes ?? s.total ?? 0,
    code: s.code ?? 0,
    test: s.test ?? 0,
    doc: s.doc ?? 0,
    file: s.file ?? 0,
    domains: s.domains ?? 0,
    layers: s.layers ?? 0,
    purpose: s.purpose || { covered: 0, total: 0 },
    confidence: s.confidence || { high: 0, medium: 0, low: 0, none: 0 },
    header: s.header || { covered: 0, total: 0 },
    docText: s.docText || { covered: 0, total: 0 },
    root: atlas?.meta?.root ? path.basename(atlas.meta.root) : 'workspace',
  }
}

/** L0：唯一允许直接拼进系统提示的段落（≤300B）。 */
export function renderOverview(atlas, { budget = L0_BUDGET } = {}) {
  const c = countsFrom(atlas)
  const meta = atlas?.meta || {}
  const conf = c.confidence
  const identified = c.purpose.identified ?? c.purpose.covered
  const codePurpose = c.purpose.code || { semantic: c.header.covered, total: c.code }
  const lines = [
    `Atlas · ${c.root} · ${c.content} 文件 · code ${c.code}/test ${c.test}/doc ${c.doc} · ${c.domains} 域`,
    `有据职责 ${identified}/${c.purpose.total}（${pct(identified, c.purpose.total)}）· 代码语义 ${codePurpose.semantic}/${codePurpose.total} · 置信 ${conf.high}/${conf.medium}/${conf.low}/${conf.none}`,
  ]
  const stamp = [dateTag(meta), gitTag(meta)].filter(Boolean).join(' · ')
  if (stamp) lines.push(stamp)
  return truncateBytes(lines.join('\n'), budget, { lineSafe: true })
}

// 测试目录/静态资产目录不参与“功能域”排名：它们文件多但职责单一，
// 放进 L1 会把真正的产品模块挤掉。规则是通用的，不依赖本仓目录名。
const SUPPORT_DOMAIN_RE = /(?:^|\/)(?:tests?|__tests__|specs?)$|-tests$/i
const ASSET_DOMAIN_RE = /^(?:public|assets|static|resources)(?:\/|$)/i

function isSupportDomainId(id) {
  return SUPPORT_DOMAIN_RE.test(String(id || '')) || ASSET_DOMAIN_RE.test(String(id || ''))
}

function topDomains(atlas, n) {
  const list = atlas?.meta?.domains || atlas?.domains || atlas?.index?.domains || []
  const sorted = [...list].sort((a, b) =>
    (b.code || 0) - (a.code || 0) || (b.doc || 0) - (a.doc || 0) || b.files - a.files || a.id.localeCompare(b.id))
  const product = sorted.filter((d) => !isSupportDomainId(d.id))
  const support = sorted.filter((d) => isSupportDomainId(d.id))
  return { product: product.slice(0, n), support, total: sorted.length }
}

function topLayers(atlas, n) {
  const list = atlas?.meta?.layers || atlas?.layers || atlas?.index?.layers || []
  return [...list]
    .sort((a, b) => (b.files || 0) - (a.files || 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, n)
}

function contentNodes(atlas) {
  return (atlas?.nodes || []).filter((n) => n.kind !== 'domain' && n.kind !== 'layer')
}

function productOnly(list) {
  const product = list.filter((n) => !isSupportDomainId(n.domain))
  return product.length ? product : list
}

function topCode(atlas, n) {
  return productOnly(contentNodes(atlas).filter((n) => n.kind === 'code'))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.reverseDeps || 0) - (a.reverseDeps || 0) || a.path.localeCompare(b.path))
    .slice(0, n)
}

function topDocs(atlas, n) {
  return productOnly(contentNodes(atlas).filter((n) => n.kind === 'doc'))
    .sort((a, b) => (b.loc || 0) - (a.loc || 0) || a.path.localeCompare(b.path))
    .slice(0, n)
}

/** L1：域 + 高重要度代码 + 关键文档 + 覆盖/排除摘要（≤4096B）。 */
export function renderL1(atlas, { budget = L1_BUDGET } = {}) {
  const c = countsFrom(atlas)
  const s = atlas?.meta?.summary || atlas?.summary || {}
  const meta = atlas?.meta || {}
  const lines = []
  const identified = c.purpose.identified ?? c.purpose.covered
  const codePurpose = c.purpose.code || { semantic: c.header.covered, total: c.code }
  lines.push(`# Atlas · ${c.root} · ${c.content} 文件（code ${c.code} / test ${c.test} / doc ${c.doc} / file ${c.file}）· ${c.domains} 域`)
  lines.push(`有据职责 ${identified}/${c.purpose.total}（${pct(identified, c.purpose.total)}）；代码语义 ${codePurpose.semantic}/${codePurpose.total}（头注释 ${c.header.covered}）；置信 high ${c.confidence.high} / med ${c.confidence.medium} / low ${c.confidence.low} / none ${c.confidence.none}`)

  const { product: ds, support, total: domainTotal } = topDomains(atlas, 12)
  if (ds.length) {
    lines.push('域（按代码/文档数）：')
    for (const d of ds) {
      const name = d.name && d.name !== d.id ? `${d.name} ` : ''
      const mix = `code ${d.code || 0} / doc ${d.doc || 0} / 共 ${d.files}`
      lines.push(`  ${d.id} ${name}· ${mix}`)
    }
    const rest = domainTotal - ds.length - support.length
    if (rest > 0) lines.push(`  … 其余 ${rest} 个域`)
    if (support.length) {
      const shown = support.slice(0, 3).map((d) => `${d.id} ${d.files}`).join(' · ')
      lines.push(`测试/资产目录（不计入域排名）：${shown}${support.length > 3 ? ` 等 ${support.length}` : ''}`)
    }
  }

  const layers = topLayers(atlas, 6)
  if (layers.length) lines.push(`层：${layers.map((l) => `${l.id} ${l.files}`).join(' · ')}`)

  const code = topCode(atlas, 8)
  if (code.length) {
    lines.push('高重要度代码：')
    for (const n of code) {
      const rev = n.reverseDeps ? ` ←${n.reverseDeps}` : ''
      const test = n.flags?.includes('tested') ? ' ✓测试' : ''
      lines.push(`  ${n.path}（imp ${n.importance || 1}${rev}${test}）${n.purpose ? ' — ' + oneLine(n.purpose, 56) : ''}`)
    }
  }

  const docs = topDocs(atlas, 5)
  if (docs.length) {
    lines.push(`文档（${c.doc}，正文 ${c.docText.covered}/${c.docText.total}）：`)
    for (const d of docs) {
      lines.push(`  ${d.path}${d.purpose ? ' — ' + oneLine(d.purpose, 56) : ''}`)
    }
  }

  const unresolved = s.unresolved || {}
  const relUnresolved = unresolved.relative || 0
  const external = unresolved.external || 0
  const exc = (meta.excluded || []).slice(0, 3).map((e) => `${e.rule} ${e.count}`).join(' / ')
  const excTotal = (meta.excluded || []).reduce((a, e) => a + e.count, 0)
  lines.push(`关系：未解析相对 import ${relUnresolved} · 外部依赖 ${external}${excTotal ? ` · 排除 ${excTotal}（${exc}）` : ''}`)
  if (meta.truncated) lines.push(`⚠ 文件数达到上限 ${meta.maxFiles}，索引被截断`)
  if ((meta.design || s.design) === 'none') lines.push('设计投影：未检测到 design/tokens（跳过）')

  return truncateBytes(lines.join('\n'), budget, { lineSafe: true })
}

/**
 * @param {any} atlas
 * @param {string} nodeId
 * @param {string} type
 * @param {'in'|'out'} direction
 * @param {number} [limit]
 * @param {{includeKinds?:string[], excludeKinds?:string[]}} [opts]
 * @returns {{total:number, list:any[]}}
 */
function relationTargets(atlas, nodeId, type, direction, limit = 8, { includeKinds, excludeKinds } = {}) {
  const edges = atlas?.edges || []
  const byId = new Map((atlas?.nodes || []).map((n) => [n.id, n]))
  const out = []
  const seen = new Set()
  for (const e of edges) {
    if (e.type !== type) continue
    const otherId = direction === 'in' ? (e.to === nodeId ? e.from : null) : (e.from === nodeId ? e.to : null)
    if (!otherId || seen.has(otherId)) continue
    const other = byId.get(otherId)
    if (!other) continue
    if (includeKinds && !includeKinds.includes(other.kind)) continue
    if (excludeKinds && excludeKinds.includes(other.kind)) continue
    seen.add(otherId)
    out.push(other)
  }
  out.sort((a, b) => (b.importance || 0) - (a.importance || 0) || String(a.path || a.id).localeCompare(String(b.path || b.id)))
  return { total: out.length, list: out.slice(0, limit) }
}

function fmtTargets(rel) {
  if (!rel.total) return ''
  const names = rel.list.map((n) => n.path || n.id)
  return names.join('、') + (rel.total > names.length ? ` 等 ${rel.total}` : '')
}

/**
 * L2 单卡。`id` 可以是节点 id（`code:path`）或仓内相对路径。
 * 返回 null 表示找不到（查询层负责回退建议）。
 */
export function renderCard(atlas, id, { budget = CARD_BUDGET } = {}) {
  const nodes = atlas?.nodes || []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let node = byId.get(id)
  if (!node && atlas?.index?.paths?.[id]) node = byId.get(atlas.index.paths[id])
  if (!node && atlas?.index?.paths) {
    for (const [p, nid] of Object.entries(atlas.index.paths)) {
      if (p.endsWith('/' + id) || path.posix.basename(p) === id) { node = byId.get(nid); break }
    }
  }
  if (!node) return null
  // C/C++ 的依赖边在独立分片：只有这张卡需要时才读，find/overview 不受影响。
  const view = isCppNode(node) ? { ...atlas, edges: allEdges(atlas) } : atlas

  const lines = []
  const kind = node.kind
  const head = `[${kind}] ${node.path || node.id}`
  const purpose = node.purpose ? oneLine(node.purpose, 140) : '（无职责描述）'
  lines.push(`${head} — ${purpose}`)
  lines.push(`置信 ${node.confidence || 'none'}（${node.purposeSrc || 'none'}）${node.tested ? ' · 有测试' : ''}`)

  if (kind === 'domain' || kind === 'layer') {
    const members = relationTargets(atlas, node.id, 'contains', 'out', 12)
    lines.push(`${kind === 'domain' ? '域' : '层'} ${node.path} · ${node.files || members.total} 文件 · ${node.loc || 0} 行`)
    if (members.total) lines.push(`成员：${fmtTargets(members)}`)
    return truncateBytes(lines.join('\n'), budget, { lineSafe: true })
  }

  const bits = []
  if (node.layer) bits.push(`层 ${node.layer}`)
  if (node.domain) bits.push(`域 ${node.domain}`)
  if (node.package) bits.push(`包 ${node.package}`)
  if (node.loc) bits.push(`${node.loc} 行`)
  bits.push(`imp ${node.importance || 1}`)
  if (node.kind === 'code') {
    bits.push(`入向 ${node.reverseDeps || 0}`)
    if (node.stats) bits.push(`import 解析 ${node.stats.importsResolved}/外部 ${node.stats.importsExternal}/未解析 ${node.stats.importsUnresolved}`)
  }
  lines.push(bits.join(' · '))

  const cov = edgeCoverage(node)
  if (!cov.supported || cov.partial) lines.push(`结构关系：${coverageLabel(cov)}`)
  if (isCppNode(node)) {
    const shard = includeShardState(atlas)
    if (!shard.ok) lines.push(`⚠ #include 分片不可用（${shard.reason}），依赖/被依赖可能不完整`)
  }

  if (node.exports?.length) lines.push(`导出：${node.exports.join('、')}`)
  if (node.kind === 'test' && node.subjects?.length) lines.push(`被测：${node.subjects.join('、')}`)
  if (node.kind === 'doc') {
    if (node.noText) {
      const why = node.docTextReason ? `（${node.docTextReason}）` : ''
      lines.push(`正文：未导入（仅元数据卡）${why}`)
    } else {
      const src = node.textSource === 'pdf' ? 'PDF 文本层'
        : node.textSource === 'ooxml' ? 'OOXML 正文'
          : ''
      if (src) lines.push(`正文：${src}${node.textTruncated ? '（已截断）' : ''}`)
      if (node.title) lines.push(`标题：${oneLine(node.title, 100)}`)
    }
    const hs = (node.headings || []).slice(0, 8).map((h) => h.text)
    if (hs.length) lines.push(`小节：${hs.join(' / ')}`)
  }

  /** @type {Array<[string, {total:number, list:any[]}]>} */
  const groups = [
    ['依赖', relationTargets(view, node.id, 'imports', 'out', 8, { excludeKinds: ['test'] })],
    ['被依赖', relationTargets(view, node.id, 'imports', 'in', 10, { excludeKinds: ['test'] })],
    ['测试', relationTargets(view, node.id, 'tests', 'in', 8, { includeKinds: ['test'] })],
    ['被测', relationTargets(view, node.id, 'tests', 'out', 8, { includeKinds: ['code'] })],
    ['引用', relationTargets(view, node.id, 'references', 'out', 8, { excludeKinds: ['test'] })],
    ['被引用', relationTargets(view, node.id, 'references', 'in', 10, { excludeKinds: ['test'] })],
    ['引用文档', relationTargets(view, node.id, 'code_mentions_doc', 'out', 5, { includeKinds: ['doc'] })],
    ['被文档提及', relationTargets(view, node.id, 'doc_mentions', 'in', 5, { includeKinds: ['doc'] })],
  ]
  for (const [label, rel] of groups) {
    if (!rel.total) continue
    lines.push(`${label}（${rel.total}）：${fmtTargets(rel)}`)
  }

  return truncateBytes(lines.join('\n'), budget, { lineSafe: true })
}
