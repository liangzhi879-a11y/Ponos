// kernel/atlas/search.mjs —— 基于 Atlas 节点表的内容检索（v1）
// ---------------------------------------------------------------------------
// `find` 只匹配路径/职责；agent 真正高频的问题是“这个符号/这句话在哪个文件”。
// 本模块从**已索引的节点**出发按行做大小写不敏感的字面量检索：
//   · 绝不走文件系统全树遍历：作用域（path/domain/layer/kind）直接裁节点表，
//     因此 .gitignore/exclude/二进制规则与 Atlas 完全同源。
//   · 纯文本直接读；docx/xlsx/pptx 复用 OOXML 阅读器；PDF 复用文本层抽取
//     （与 card 的“正文是否导入”同一口径，抽不到就如实跳过，不假装搜过）。
//   · 有硬上限（文件数/总字节/行数）：到上限就标记 truncated，不静默假装搜全。
//     ★ 十万级仓的**无作用域**完整检索靠后续词项索引；v1 对大范围搜索明确拒绝，
//       要求先缩到目录/域，避免“跑了 20 秒只扫了 3% 却报告未命中”。
import fs from 'node:fs'
import path from 'node:path'
import { isImagePath } from './config.mjs'
import {
  extractOoxmlText, isLegacyOfficeExt, isOoxmlExt, preparePdfText,
} from './doc-text.mjs'
import {
  findCandidates, pathHash, queryTokens, segmentsIntact, TERM_INDEX_VERSION,
} from './term-index.mjs'

// v1 的边界：不是性能调优旋钮，而是“还能诚实报告结果”的上限。
const MAX_SEARCH_FILES = 5_000
const MAX_SCAN_BYTES = 64 * 1024 * 1024
// 索引只负责“把候选缩小”；核对仍要读源文件。候选过多时按重要度核对前 N 个，
// 并明确标记截断——绝不把“核对了 600 个”说成“全仓只有这些”。
const MAX_VERIFY_FILES = 5_000
const VERIFY_OVERSAMPLE = 20
const MAX_LINE_CHARS = 200
const DEFAULT_MATCH_LIMIT = 30
const DEFAULT_FILE_LIMIT = 20
const MAX_LIMIT = 100

function listNodes(atlas) {
  return (atlas?.nodes || []).filter((n) => n.kind !== 'domain' && n.kind !== 'layer')
}

// 同一 Atlas 代内的 PDF 文本缓存：键是 atlas 对象，重新加载/重建后自然失效。
// 只缓存“可识别的 PDF 文本”，用 mtime/size + 抽取上限校验；上限防大仓撑爆内存。
const pdfTextCaches = new WeakMap()
const PDF_CACHE_MAX_FILES = 1000

function cachedPdfCtx(atlas, files, config) {
  const start = Date.now()
  const maxChars = Math.max(1000, Number(config.maxDocTextChars) || 20000)
  const maxPages = Math.max(1, Number(config.maxDocTextPages) || 5)
  if (!files.length) {
    return { enabled: config.docText !== false, pdfText: new Map(), pdfTruncated: new Map(), reasons: new Map(), stats: { mode: 'none', candidates: 0, extracted: 0, empty: 0, truncated: 0, skipped: 0, elapsedMs: 0 } }
  }
  if (config.docText === false) return preparePdfText({ files, needs: () => true, config, injected: null })
  let cache = pdfTextCaches.get(atlas)
  if (!cache) { cache = new Map(); pdfTextCaches.set(atlas, cache) }
  const pdfText = new Map()
  const pdfTruncated = new Map()
  const reasons = new Map()
  const missing = []
  for (const f of files) {
    const hit = cache.get(f.rel)
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size && hit.maxChars === maxChars && hit.maxPages === maxPages) {
      if (hit.text != null) {
        pdfText.set(f.rel, hit.text)
        if (hit.truncated) pdfTruncated.set(f.rel, true)
      } else {
        reasons.set(f.rel, hit.reason || 'pdf-no-text')
      }
    } else {
      missing.push(f)
    }
  }
  let fresh = null
  if (missing.length) {
    fresh = preparePdfText({ files: missing, needs: () => true, config, injected: null })
    for (const f of missing) {
      const text = fresh.pdfText.get(f.rel)
      const truncated = Boolean(fresh.pdfTruncated.get(f.rel))
      const reason = text == null ? (fresh.reasons.get(f.rel) || 'pdf-no-text') : null
      cache.set(f.rel, { mtimeMs: f.mtimeMs, size: f.size, maxChars, maxPages, text: text ?? null, truncated, reason })
      if (text != null) {
        pdfText.set(f.rel, text)
        if (truncated) pdfTruncated.set(f.rel, true)
      } else {
        reasons.set(f.rel, reason)
      }
    }
    while (cache.size > PDF_CACHE_MAX_FILES) cache.delete(cache.keys().next().value)
  }
  return {
    enabled: true,
    pdfText,
    pdfTruncated,
    reasons,
    stats: {
      mode: fresh ? fresh.stats.mode : 'cache',
      candidates: files.length,
      extracted: pdfText.size,
      empty: reasons.size,
      truncated: pdfTruncated.size,
      skipped: fresh ? fresh.stats.skipped : 0,
      elapsedMs: Date.now() - start,
    },
  }
}

function normPrefix(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function inScope(n, { kind, domain, layer, pathPrefix }) {
  if (kind) {
    const kinds = new Set(String(kind).split(/[,|]/).map((s) => s.trim()).filter(Boolean))
    if (kinds.size && !kinds.has(n.kind)) return false
  }
  if (domain) {
    const d = String(n.domain || '')
    if (d !== domain && !d.startsWith(domain + '/')) return false
  }
  if (layer && String(n.layer || '') !== layer) return false
  if (pathPrefix) {
    const p = String(n.path || '')
    if (p !== pathPrefix && !p.startsWith(pathPrefix + '/')) return false
  }
  return true
}

function nodeExt(n) {
  const lang = String(n?.lang || '').toLowerCase()
  if (lang) return '.' + lang
  return path.posix.extname(String(n?.path || '')).toLowerCase()
}

function nodeEntry(n, root) {
  return {
    rel: String(n.path || ''),
    abs: path.join(root, String(n.path || '')),
    kind: n.kind,
    ext: nodeExt(n),
    size: Number(n.size) || 0,
    mtimeMs: Number(n.mtimeMs) || 0,
    tooLarge: n.tooLarge === true,
  }
}

// pathHash → 节点。以 nodes 数组为键缓存：同一代加载结果只建一次表
// （187k 节点约 40ms），换缓存代/重新加载时自动失效。
const nodeHashMaps = new WeakMap()

function nodeHashMap(atlas) {
  if (!Array.isArray(atlas?.nodes)) return new Map()
  const hit = nodeHashMaps.get(atlas.nodes)
  if (hit) return hit
  const map = new Map()
  for (const n of atlas.nodes) {
    if (!n.path || n.kind === 'domain' || n.kind === 'layer') continue
    const h = pathHash(n.path)
    let list = map.get(h)
    if (!list) { list = []; map.set(h, list) }
    list.push(n)
  }
  nodeHashMaps.set(atlas.nodes, map)
  return map
}

function oneLine(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > MAX_LINE_CHARS ? t.slice(0, MAX_LINE_CHARS - 1) + '…' : t
}

/**
 * 读一个节点的可检索正文。返回 {text} 或 {skip:reason}。
 * @param {any} n
 * @param {{root:string, config:any, pdfCtx:any}} ctx
 */
function readText(n, ctx) {
  const { root, config, pdfCtx } = ctx
  const rel = String(n.path || '')
  const ext = nodeExt(n)
  if (n.tooLarge) return { skip: 'too-large' }
  if (isImagePath(rel)) return { skip: 'binary' }
  if (isLegacyOfficeExt(ext)) return { skip: 'legacy-office' }
  if (isOoxmlExt(ext)) {
    // 构建时 docText 关闭会让卡片 noText，但正文本身可读：检索按当前配置重新抽，
    // 不把“上一次构建没抽”当成“永远没有正文”。
    if (config.docText === false) return { skip: 'doc-text-disabled' }
    const r = extractOoxmlText(path.join(root, rel), ext, {
      maxChars: Math.max(1000, Number(config.maxDocTextChars) || 20_000),
    })
    if ('reason' in r) return { skip: r.reason || 'extract-failed' }
    return { text: r.text, truncated: Boolean(r.truncated) }
  }
  if (ext === '.pdf') {
    if (!pdfCtx?.enabled) return { skip: 'doc-text-disabled' }
    const text = pdfCtx.pdfText.get(rel)
    if (text == null) return { skip: pdfCtx.reasons.get(rel) || 'pdf-no-text' }
    return { text, truncated: Boolean(pdfCtx.pdfTruncated.get(rel)) }
  }
  let buf
  try {
    buf = fs.readFileSync(path.join(root, rel))
  } catch {
    return { skip: 'unreadable' }
  }
  if (buf.includes(0)) return { skip: 'binary' }
  return { text: buf.toString('utf8') }
}

/**
 * 内容检索（字面量、大小写不敏感、按行命中）。
 *
 * @param {any} atlas 已加载的 Atlas（nodes 必须有）
 * @param {string} query 检索词（非空；不做正则解释）
 * @param {{
 *   kind?:string, domain?:string, layer?:string, path?:string,
 *   filesOnly?:boolean, limit?:number, config?:any,
 * }} [opts]
 * @returns {{ok:boolean, reason?:string, [key:string]:any}}
 */
export function searchContent(atlas, query, {
  kind, domain, layer, path: pathScope, filesOnly = false, limit, config = null,
} = {}) {
  const raw = String(query ?? '')
  const needle = raw.trim().toLowerCase()
  if (!needle) return { ok: false, reason: 'empty-query' }
  const root = atlas?.meta?.root
  if (!root) return { ok: false, reason: 'no-root' }
  const cfg = config || {}
  const pathPrefix = normPrefix(pathScope)
  const domainNeedle = String(domain ?? '').trim()
  const layerNeedle = String(layer ?? '').trim()
  const cap = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || (filesOnly ? DEFAULT_FILE_LIMIT : DEFAULT_MATCH_LIMIT)))

  const scope = { kind, domain: domainNeedle, layer: layerNeedle, pathPrefix }
  const scoped = Boolean(pathPrefix || domainNeedle || layerNeedle || kind)
  const byImportance = (a, b) => (b.importance || 0) - (a.importance || 0) || String(a.path).localeCompare(String(b.path))
  let candidates = listNodes(atlas)
    .filter((n) => n.path && inScope(n, scope))
    .sort(byImportance)

  // 有词项索引时：先由 postings 把候选缩到“可能含该字面量”的文件，再回源核对。
  // 索引只存哈希、不存正文；候选是超集，命中事实永远来自逐行核对。
  let via = 'scan'
  let indexOpen = false
  let indexTokenCount = 0
  if (atlas?.dir && atlas?.meta?.searchIndexVersion === TERM_INDEX_VERSION &&
      segmentsIntact(atlas.dir, atlas.meta.searchSegments)) {
    const tokens = queryTokens(raw)
    if (tokens.length) {
      const hashes = findCandidates({
        cacheDir: atlas.dir,
        segments: atlas.meta.searchSegments,
        tokens,
      })
      if (hashes != null) {
        const map = nodeHashMap(atlas)
        const seen = new Set()
        const resolved = []
        for (const h of hashes) {
          for (const n of map.get(h) || []) {
            if (!n.path || seen.has(n.path)) continue
            seen.add(n.path)
            if (!inScope(n, scope)) continue
            resolved.push(n)
          }
        }
        candidates = resolved.sort(byImportance)
        via = 'index'
        indexOpen = true
        indexTokenCount = tokens.length
      }
    }
  }
  const candidateTotal = candidates.length

  // 无索引且无作用域、候选过多：明确拒绝并给出可执行的作用域，
  // 不跑一次“看起来搜了”的半截扫描。有索引时不拒绝——索引回答是完整的。
  if (!scoped && !indexOpen && candidates.length > MAX_SEARCH_FILES) {
    return {
      ok: false,
      reason: 'scope-required',
      candidates: candidates.length,
      maxFiles: MAX_SEARCH_FILES,
      hint: '工作区过大，未加作用域的正文检索会静默漏检。请先用 find/overview 定位，再用 path/domain/layer/kind 缩小范围。',
    }
  }

  // 核对有成本：候选过多时只核对重要度前 N 个，并如实标记截断。
  // filesOnly 是“要完整文件清单”的场景，允许核更多；逐行模式默认 200 个候选
  // 足以填满 30–100 行输出，再往后读文件只会拖慢“找符号”的主路径。
  const verifyCap = via === 'index'
    ? (filesOnly
        ? Math.min(MAX_VERIFY_FILES, Math.max(200, cap * VERIFY_OVERSAMPLE))
        : Math.min(MAX_VERIFY_FILES, Math.max(200, cap * 4)))
    : MAX_SEARCH_FILES
  let candidateTruncated = false
  if (via === 'index' && candidates.length > verifyCap) {
    candidates = candidates.slice(0, verifyCap)
    candidateTruncated = true
  }

  // PDF 文本层：只对**真正要核对**的 PDF 预备一次；抽不到的原因原样带回。
  // 无作用域的大文档仓（数百 PDF）以前每次搜索都全量重抽，这是 8s 延迟的主因。
  // 同一 Atlas 代内按 (path, mtime, size, 抽取上限) 复用文本：热查询不再重复开 PDF。
  const pdfEntries = candidates
    .filter((n) => nodeExt(n) === '.pdf' && n.kind === 'doc' && !n.tooLarge)
    .map((n) => nodeEntry(n, root))
  const pdfCtx = cachedPdfCtx(atlas, pdfEntries, cfg)

  const maxFileBytes = Math.max(1024, Number(cfg.maxFileBytes) || 2 * 1024 * 1024)
  const ctx = { root, config: cfg, pdfCtx }
  const matches = []
  /** @type {Map<string, {path:string, kind:string, hits:number, firstLine:number, firstText:string}>} */
  const files = new Map()
  const skipped = new Map()
  let searched = 0
  let scannedBytes = 0
  let truncated = candidateTruncated
  let stopReason = candidateTruncated ? 'candidate-cap' : null

  for (const n of candidates) {
    if (searched >= MAX_SEARCH_FILES) { truncated = true; stopReason = 'file-cap'; break }
    if (scannedBytes >= MAX_SCAN_BYTES) { truncated = true; stopReason = 'byte-budget'; break }
    if (files.size >= cap && filesOnly) { truncated = true; stopReason = 'limit'; break }

    const got = readText(n, ctx)
    if (got.skip) {
      skipped.set(got.skip, (skipped.get(got.skip) || 0) + 1)
      continue
    }
    searched++
    const text = got.text || ''
    scannedBytes += Buffer.byteLength(text, 'utf8')
    if (!text || !text.toLowerCase().includes(needle)) continue
    let hits = 0
    let firstLine = 0
    let firstText = ''
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.toLowerCase().includes(needle)) continue
      hits++
      if (!firstLine) { firstLine = i + 1; firstText = oneLine(line) }
      if (!filesOnly && matches.length < cap) {
        matches.push({
          path: n.path,
          kind: n.kind,
          line: i + 1,
          text: oneLine(line),
        })
      }
    }
    if (!hits) continue
    const prev = files.get(n.path)
    if (prev) { prev.hits += hits }
    else {
      files.set(n.path, {
        path: n.path,
        kind: n.kind,
        hits,
        firstLine,
        firstText: firstText || '(正文在抽取时被截断)',
      })
    }
    // 行数到顶后**继续核对剩余候选**：agent 问“在哪些文件”时，文件清单比前 30 行
    // 更重要；不能因为第一个大文件塞满 matches 就把后面的文件藏起来。
    // candidate-cap 优先：未核对的候选比“行数到顶”更值得警告，不能被后者覆盖。
    if (!filesOnly && matches.length >= cap) { truncated = true; if (!candidateTruncated) stopReason = 'limit' }
    if (filesOnly && files.size >= cap) {
      truncated = true
      if (!candidateTruncated) stopReason = 'limit'
      break
    }
  }

  const fileList = [...files.values()].sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
  return {
    ok: true,
    query: raw.trim(),
    scope: {
      path: pathPrefix || null,
      domain: domainNeedle || null,
      layer: layerNeedle || null,
      kind: kind || null,
    },
    filesOnly: Boolean(filesOnly),
    via,
    indexTokens: indexTokenCount,
    indexSegments: via === 'index' ? atlas.meta.searchSegments.length : 0,
    candidates: candidateTotal,
    verified: candidates.length,
    searched,
    truncated,
    stopReason,
    files: fileList,
    matches: filesOnly ? [] : matches,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    pdf: pdfCtx?.stats || null,
  }
}

/** 把结构化结果压成给模型看的文本（工具层用；CLI/测试可直接用结构化结果）。 */
export function renderSearch(res, { maxMatches = 30 } = {}) {
  if (!res.ok) return ''
  const lines = []
  const scopeBits = [
    res.scope.path ? `path ${res.scope.path}` : '',
    res.scope.domain ? `domain ${res.scope.domain}` : '',
    res.scope.layer ? `layer ${res.scope.layer}` : '',
    res.scope.kind ? `kind ${res.scope.kind}` : '',
  ].filter(Boolean)
  const scope = scopeBits.length ? ` · 作用域 ${scopeBits.join(' / ')}` : ''
  const how = res.via === 'index'
    ? `索引候选 ${res.candidates}，核对 ${res.searched}`
    : `扫描 ${res.searched}/${res.candidates}`
  if (res.filesOnly) {
    lines.push(`Atlas 内容检索 · ${res.query}${scope} · ${res.files.length} 文件（${how}）`)
    for (const f of res.files) lines.push(`- ${f.path}（${f.hits} 处，首处 L${f.firstLine}）`)
  } else {
    lines.push(`Atlas 内容检索 · ${res.query}${scope} · ${res.matches.length} 行 / ${res.files.length} 文件（${how}）`)
    for (const m of res.matches.slice(0, maxMatches)) lines.push(`- ${m.path}:${m.line}: ${m.text}`)
    const more = res.matches.length - Math.min(res.matches.length, maxMatches)
    if (more > 0) lines.push(`  … 另有 ${more} 行未展开（可加 path/domain/kind 缩小范围）`)
  }
  if (res.truncated) {
    const why = res.stopReason === 'candidate-cap'
      ? `索引候选 ${res.candidates} 个，只核对了重要度前 ${res.verified} 个`
      : `达到${res.stopReason === 'byte-budget' ? '扫描字节' : res.stopReason === 'file-cap' ? '文件数' : '结果数'}上限`
    lines.push(`⚠ ${why}，结果可能不完整；请缩小作用域或改用 filesOnly。`)
  }
  if (res.skipped.length) {
    const parts = res.skipped.map((s) => `${s.reason} ${s.count}`).join(' / ')
    lines.push(`不可检索（已跳过）：${parts}`)
  }
  const s = res.pdf
  if (s && (s.candidates || s.error)) {
    lines.push(`PDF 文本层：候选 ${s.candidates} / 抽出 ${s.extracted} / 空 ${s.empty} / 跳过 ${s.skipped}${s.error ? `（${s.error}）` : ''}`)
  }
  return lines.join('\n')
}
