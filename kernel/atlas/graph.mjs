// kernel/atlas/graph.mjs —— 卡片 → 关系图（确定性、可重建）
// ---------------------------------------------------------------------------
// 边只来自**可验证的事实**：
//   imports / references     代码里的 import、require、路径字面量（resolve 成功才连边）
//   tests                    测试文件 import 到的被测文件 + 同目录命名启发式
//   doc_mentions             文档正文中逐字出现的仓内路径
//   code_mentions_doc        代码路径字面量指向文档
//   contains                 域/层 → 文件（供 L1/related 直接使用）
// 连不上的一律进 unresolved 统计，不猜。importance 的 reverseDeps 只数**非测试代码**
// 的入边（测试依赖不计入“有多少生产代码依赖它”）。
import path from 'node:path'
import {
  resolveImport, resolveInclude, resolvePathRef,
} from './extract.mjs'
import { domainName, domainOf, layerInfo, detectDesign } from './config.mjs'
import { discoverWorkspaces } from './workspace.mjs'

// 与 config.mjs 的测试判定同口径，外加 graph 自己的 JS/TS 命名。
// `_unittest.cc` 以前不识别 ⇒ 测试→被测文件的启发式对 C++ 完全失明。
const TEST_SUFFIX_RE = /(?:\.(?:test|spec|e2e)|_(?:unittest|browsertest|perftest|regtest|test|spec))\.[a-z0-9]+$/i

function byBaseMap(cards) {
  const map = new Map()
  for (const c of cards) {
    if (!c.path || c.kind === 'domain' || c.kind === 'layer') continue
    const b = path.posix.basename(c.path)
    if (!map.has(b)) map.set(b, [])
    map.get(b).push(c.path)
  }
  return map
}

function testCandidates(rel) {
  const dir = path.posix.dirname(rel)
  const base = path.posix.basename(rel)
  const out = []
  const m = TEST_SUFFIX_RE.exec(base)
  if (m) {
    const stem = base.slice(0, m.index) + path.posix.extname(base)
    out.push(path.posix.join(dir, stem))
  }
  if (/^test-/i.test(base)) out.push(path.posix.join(dir, base.replace(/^test-/i, '')))
  return [...new Set(out)]
}

function addEdge(edges, seen, edge) {
  if (edge.from === edge.to) return false
  const key = `${edge.type}\u0000${edge.from}\u0000${edge.to}`
  if (seen.has(key)) return false
  seen.add(key)
  edges.push(edge)
  return true
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * @param {{cards: Array<object>, root: string, config: object, meta?: object}} input
 * @returns {{
 *   nodes: Array<object>, edges: Array<object>, summary: object, coverage: object,
 *   domains: Array<object>, layers: Array<object>, design: 'present'|'none',
 * }}
 */
export function buildGraph({ cards, root, config, meta = {} }) {
  const nodes = cards.map((c) => ({ ...c }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const byPath = new Map()
  for (const n of nodes) if (n.path && n.kind !== 'domain' && n.kind !== 'layer') byPath.set(n.path, n)
  const fileSet = new Set(byPath.keys())
  const byBase = byBaseMap(nodes)
  const workspace = discoverWorkspaces(root)

  // 扫描阶段不知道 workspace 边界；在连边前统一重投影域/层，保证
  // `packages/session-backends/sqlite-node` 这类嵌套包不会被压成上层目录。
  for (const n of nodes) {
    if (n.kind === 'domain' || n.kind === 'layer' || !n.path) continue
    n.domain = domainOf(n.path, config, workspace)
    n.layer = layerInfo(n.path, config)
    const pkg = workspace.packageOfPath(n.path)
    if (pkg) n.package = pkg.name
  }

  const edges = []
  const edgeSeen = new Set()
  const importPairs = new Set()
  const unresolved = { relative: 0, external: 0, include: 0, samples: [] }
  const referencesUnresolved = { count: 0, samples: [] }
  let workspaceResolvedImports = 0

  const resolveRef = (fromRel, spec) => {
    const hit = resolvePathRef(fromRel, spec, fileSet, byBase)
    if (hit) return byPath.get(hit) || null
    return null
  }

  for (const n of nodes) {
    if (n.kind !== 'code' && n.kind !== 'test') continue
    n.stats = { importsResolved: 0, importsExternal: 0, importsUnresolved: 0, refsResolved: 0 }

    for (const imp of n.imports || []) {
      const spec = imp.spec
      if (imp.include) {
        const included = resolveInclude(n.path, spec, fileSet, byBase)
        const to = included ? byPath.get(included) : null
        if (to && (to.kind === 'code' || to.kind === 'test')) {
          addEdge(edges, edgeSeen, { type: 'imports', from: n.id, to: to.id, via: 'include' })
          n.stats.importsResolved++
          continue
        }
        unresolved.include++
        n.stats.importsUnresolved++
        if (unresolved.samples.length < 20) unresolved.samples.push(`${n.path} → #include "${spec}"`)
        continue
      }
      const isRelative = spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/')
      const viaWorkspace = !isRelative && workspace.matches(spec)
      const target = resolveImport(n.path, spec, fileSet, workspace)
      if (target) {
        const to = byPath.get(target)
        if (to && (to.kind === 'code' || to.kind === 'test')) {
          addEdge(edges, edgeSeen, { type: 'imports', from: n.id, to: to.id })
          importPairs.add(`${n.id}\u0000${to.id}`)
          n.stats.importsResolved++
          if (viaWorkspace) workspaceResolvedImports++
          continue
        }
      }
      if (isRelative) {
        unresolved.relative++
        n.stats.importsUnresolved++
        if (unresolved.samples.length < 20) unresolved.samples.push(`${n.path} → ${spec}`)
      } else {
        unresolved.external++
        n.stats.importsExternal++
      }
    }

    for (const ref of n.references || []) {
      const target = resolveRef(n.path, ref.spec)
      if (!target) {
        referencesUnresolved.count++
        if (referencesUnresolved.samples.length < 20) referencesUnresolved.samples.push(`${n.path} → ${ref.spec}`)
        continue
      }
      if (target.kind === 'doc') {
        addEdge(edges, edgeSeen, { type: 'code_mentions_doc', from: n.id, to: target.id })
      } else if (target.kind === 'code' || target.kind === 'test') {
        // import 已经连过的目标不再重复记 references（否则反向依赖会被同一依赖数两次）
        if (importPairs.has(`${n.id}\u0000${target.id}`)) continue
        addEdge(edges, edgeSeen, { type: 'references', from: n.id, to: target.id })
      } else {
        continue
      }
      n.stats.refsResolved++
    }
  }

  // 测试 → 被测文件：import 已经连过的直接复用；再补同目录/唯一 basename 启发式。
  // 先按来源建索引：否则每个测试节点都遍历全部边（774 × 1.4 万 = 千万级）。
  const depsByFrom = new Map()
  for (const e of edges) {
    if (e.type !== 'imports' && e.type !== 'references') continue
    if (!depsByFrom.has(e.from)) depsByFrom.set(e.from, [])
    depsByFrom.get(e.from).push(e)
  }
  const testSubjects = new Map()
  for (const n of nodes) {
    if (n.kind !== 'test') continue
    const subjects = new Set()
    for (const e of depsByFrom.get(n.id) || []) {
      const to = byId.get(e.to)
      if (to && to.kind === 'code') subjects.add(to.path)
    }
    for (const cand of testCandidates(n.path)) {
      if (fileSet.has(cand)) {
        const to = byPath.get(cand)
        if (to && to.kind === 'code') subjects.add(to.path)
      }
    }
    if (!subjects.size) {
      const stem = path.posix.basename(n.path)
        .replace(TEST_SUFFIX_RE, (m) => path.posix.extname(n.path))
        .replace(/^test-/i, '')
      const hits = byBase.get(stem) || []
      if (hits.length === 1) {
        const to = byPath.get(hits[0])
        if (to && to.kind === 'code') subjects.add(to.path)
      }
    }
    testSubjects.set(n.path, [...subjects].slice(0, 20))
    for (const p of subjects) {
      const to = byPath.get(p)
      if (to) addEdge(edges, edgeSeen, { type: 'tests', from: n.id, to: to.id })
    }
  }

  // 文档 → 文件：正文逐字路径
  for (const n of nodes) {
    if (n.kind !== 'doc') continue
    for (const ref of n.references || []) {
      const target = resolveRef(n.path, ref.spec)
      if (!target) continue
      if (target.kind === 'doc' || target.kind === 'code' || target.kind === 'test' || target.kind === 'file') {
        addEdge(edges, edgeSeen, { type: 'doc_mentions', from: n.id, to: target.id })
      }
    }
  }

  // 反向计数与 tested 标记（只数非测试代码的入边，见文件头说明）
  const reverseDeps = new Map()
  const incomingTests = new Map()
  for (const e of edges) {
    if (e.type === 'imports' || e.type === 'references') {
      const from = byId.get(e.from)
      if (from && from.kind === 'code') reverseDeps.set(e.to, (reverseDeps.get(e.to) || 0) + 1)
    } else if (e.type === 'tests') {
      incomingTests.set(e.to, (incomingTests.get(e.to) || 0) + 1)
    }
  }

  for (const n of nodes) {
    if (n.kind === 'test') {
      n.importance = 1
      n.subjects = testSubjects.get(n.path) || []
      continue
    }
    if (n.kind !== 'code') { n.importance = 1; continue }
    const rev = reverseDeps.get(n.id) || 0
    const tested = (incomingTests.get(n.id) || 0) > 0
    n.tested = tested
    n.reverseDeps = rev
    const flags = new Set(n.flags || [])
    if (tested) flags.add('tested')
    n.flags = [...flags]
    const loc = n.loc || 0
    const imp = 1
      + Math.round(Math.log2(1 + rev) * 2)
      + (flags.has('entry') ? 1 : 0)
      + (tested ? 1 : 0)
      + (loc >= 1000 ? 1 : 0)
    n.importance = clamp(imp, 1, 9)
  }

  // 域/层聚合节点 + contains 边
  const domainAgg = new Map()
  const layerAgg = new Map()
  for (const n of nodes) {
    if (n.kind === 'domain' || n.kind === 'layer') continue
    const d = n.domain || 'root'
    if (!domainAgg.has(d)) domainAgg.set(d, { files: 0, loc: 0, layers: new Set(), code: 0, test: 0, doc: 0, file: 0 })
    const da = domainAgg.get(d)
    da.files++
    da.loc += n.loc || 0
    da[n.kind] = (da[n.kind] || 0) + 1
    if (n.layer) da.layers.add(n.layer)
    const l = n.layer || 'root'
    if (!layerAgg.has(l)) layerAgg.set(l, { files: 0, loc: 0 })
    const la = layerAgg.get(l)
    la.files++
    la.loc += n.loc || 0
  }

  const domains = [...domainAgg.entries()]
    .map(([id, a]) => ({
      id,
      name: domainName(id, config, workspace),
      files: a.files,
      loc: a.loc,
      code: a.code || 0,
      test: a.test || 0,
      doc: a.doc || 0,
      file: a.file || 0,
      layers: [...a.layers].sort(),
    }))
    .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id))

  const layers = [...layerAgg.entries()]
    .map(([id, a]) => ({ id, files: a.files, loc: a.loc }))
    .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id))

  for (const d of domains) {
    const node = {
      v: 1,
      id: `domain:${d.id}`,
      kind: 'domain',
      path: d.id,
      name: d.name,
      purpose: `${d.name}：${d.files} 个文件`,
      purposeSrc: 'structure',
      confidence: 'high',
      importance: 5,
      content: false,
      files: d.files,
      loc: d.loc,
    }
    nodes.push(node)
    byId.set(node.id, node)
  }
  for (const l of layers) {
    const node = {
      v: 1,
      id: `layer:${l.id}`,
      kind: 'layer',
      path: l.id,
      name: l.id,
      purpose: `层 ${l.id}：${l.files} 个文件`,
      purposeSrc: 'structure',
      confidence: 'high',
      importance: 4,
      content: false,
      files: l.files,
      loc: l.loc,
    }
    nodes.push(node)
    byId.set(node.id, node)
  }
  for (const n of nodes) {
    if (n.kind === 'domain' || n.kind === 'layer') continue
    addEdge(edges, edgeSeen, { type: 'contains', from: `domain:${n.domain || 'root'}`, to: n.id })
    addEdge(edges, edgeSeen, { type: 'contains', from: `layer:${n.layer || 'root'}`, to: n.id })
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id))
  edges.sort((a, b) => a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  const contentNodes = nodes.filter((n) => n.kind !== 'domain' && n.kind !== 'layer')
  const codeNodes = contentNodes.filter((n) => n.kind === 'code')
  const testNodes = contentNodes.filter((n) => n.kind === 'test')
  const docNodes = contentNodes.filter((n) => n.kind === 'doc')
  const fileNodes = contentNodes.filter((n) => n.kind === 'file')
  const confidence = { high: 0, medium: 0, low: 0, none: 0 }
  for (const n of contentNodes) confidence[n.confidence] = (confidence[n.confidence] || 0) + 1
  const purposeCovered = contentNodes.filter((n) => n.purpose).length
  // “有据职责”只数 T1/T2/T3/T4；T5（未识别职责）不算覆盖，避免 99% 的虚荣指标。
  // 但结构兜底（T3）不是语义职责：单独计数，别让 94% 掩盖“只有 33% 代码有头注释”。
  const purposeIdentified = contentNodes.filter((n) => n.purposeSrc && n.purposeSrc !== 'none').length
  const purposeBySrc = { header: 0, metadata: 0, structure: 0, doc: 0, none: 0 }
  const purposeByKind = {}
  for (const n of contentNodes) {
    const src = n.purposeSrc || 'none'
    purposeBySrc[src] = (purposeBySrc[src] || 0) + 1
    if (!purposeByKind[n.kind]) {
      purposeByKind[n.kind] = { semantic: 0, structural: 0, none: 0, header: 0, total: 0 }
    }
    const bucket = purposeByKind[n.kind]
    bucket.total++
    if (src === 'header' || src === 'metadata' || src === 'doc') bucket.semantic++
    else if (src === 'structure') bucket.structural++
    else bucket.none++
    if (src === 'header') bucket.header++
  }
  const emptyKind = { semantic: 0, structural: 0, none: 0, header: 0, total: 0 }
  const codePurpose = purposeByKind.code || emptyKind
  const headerCovered = codeNodes.filter((n) => n.purposeSrc === 'header').length
  const edgesByType = {}
  for (const e of edges) edgesByType[e.type] = (edgesByType[e.type] || 0) + 1
  const docTextBySource = { text: 0, ooxml: 0, pdf: 0 }
  const docTextSkipped = {}
  for (const n of docNodes) {
    if (n.content && !n.noText) {
      const src = n.textSource || 'text'
      docTextBySource[src] = (docTextBySource[src] || 0) + 1
    } else if (n.docTextReason) {
      docTextSkipped[n.docTextReason] = (docTextSkipped[n.docTextReason] || 0) + 1
    }
  }

  const coverage = {
    total: contentNodes.length,
    code: codeNodes.length,
    test: testNodes.length,
    doc: docNodes.length,
    file: fileNodes.length,
    domains: domains.length,
    layers: layers.length,
    purpose: {
      covered: purposeCovered,
      identified: purposeIdentified,
      fallback: contentNodes.length - purposeIdentified,
      total: contentNodes.length,
      semantic: purposeBySrc.header + purposeBySrc.metadata + purposeBySrc.doc,
      structural: purposeBySrc.structure,
      none: purposeBySrc.none,
      bySrc: purposeBySrc,
      byKind: purposeByKind,
      code: codePurpose,
    },
    confidence,
    header: { covered: headerCovered, total: codeNodes.length },
    docText: {
      covered: docNodes.filter((n) => n.content && !n.noText).length,
      total: docNodes.length,
      bySource: docTextBySource,
      skipped: docTextSkipped,
    },
  }

  /** @type {'present'|'none'} */
  const design = detectDesign(root)
  const summary = {
    nodes: nodes.length,
    contentNodes: contentNodes.length,
    edges: edges.length,
    edgesByType,
    ...coverage,
    unresolved,
    referencesUnresolved,
    workspace: {
      packages: workspace.packages.filter((pkg) => pkg.dir).length,
      resolvedImports: workspaceResolvedImports,
    },
    design,
    truncated: meta.truncated === true,
    maxFiles: meta.maxFiles || config.maxFiles,
  }

  return { nodes, edges, summary, coverage, domains, layers, design: summary.design }
}

/** 反向依赖明细（impact 查询用）：入边按类型分组。 */
export function incomingEdges(edges, id) {
  const out = []
  for (const e of edges) if (e.to === id) out.push(e)
  return out
}

export function outgoingEdges(edges, id) {
  const out = []
  for (const e of edges) if (e.from === id) out.push(e)
  return out
}
