// kernel/atlas/store.mjs —— Atlas 构建/加载/增量/校验
// ---------------------------------------------------------------------------
// 落盘四件套（spec §5.5）：nodes.json / edges.json / index.json / meta.json。
// 每个文件带同一个 buildId；加载时四者不一致就判定“跨代混合”，拒绝使用并重建
// （单文件原子写不能保证四个文件同时换代，buildId 是免费的提交标记）。
//
// 增量口径：
//   - 配置变化 / package.json|README 等元数据变化 / 强制 → 全量重抽
//   - 单文件 mtime+size 未变 → 复用旧卡（stat 命中）
//   - 图每次都从卡片重建（毫秒级，且保证边不会残留已删文件）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileAtomicSync } from '../../shared/atomic-write.mjs'
import {
  ATLAS_VERSION, loadAtlasConfig, normalizeAtlasScope, resolveAtlasDir, resolveAtlasScopeDir, workspaceId,
} from './config.mjs'
import { scanWorkspace, readEntryText } from './scan.mjs'
import { buildMetaHints, extractCodeCard, extractFileCard } from './extract.mjs'
import { extractDocCard } from './extract-doc.mjs'
import { preparePdfText } from './doc-text.mjs'
import { buildGraph } from './graph.mjs'
import { renderL1 } from './render.mjs'
import {
  compactSegments, createSegmentWriter, newSegmentId, pruneSegments,
  segmentsIntact, TERM_INDEX_VERSION,
} from './term-index.mjs'
import { includeShardPath, markEdgesInline, writeIncludeShard } from './edge-shard.mjs'
import { recordAtlas } from '../inject-ledger.mjs'

export function atlasPaths(dir) {
  return {
    dir,
    nodes: path.join(dir, 'nodes.json'),
    edges: path.join(dir, 'edges.json'),
    index: path.join(dir, 'index.json'),
    meta: path.join(dir, 'meta.json'),
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// ── 进程内加载缓存 ───────────────────────────────────────────────────────
// 每次 ProjectAtlas 调用都重新解析几十到几百 MB 的 nodes/edges/index 是
// “查询秒级”的主因；同一次会话里索引通常不变，按 buildId 复用解析结果。
//
// 预算按**磁盘体积**估算，默认 **128MB 是进程内所有 Atlas 的总预算**（不是单份）：
//   - 单个索引超过总预算 → 不缓存（大仓不硬塞进 Electron 进程）；
//   - 多份索引合计超过预算 → 按 LRU 淘汰最久未用的，最多保留 8 份。
// 实测 Chromium `chrome/browser` 53k 范围约 115MB：64MB 旧上限下一次查询要重新
// 解析 ~1.1s；128MB 下热加载 0.69ms（RSS ~501MB）。总预算避免旧“8 份 × 64MB”
// 的极端驻留。`atlas.config.json#cacheMB` / `PONOS_ATLAS_CACHE_MB` 可调（0 = 关闭）。
const loadCache = new Map()
const metaCache = new Map()
const LOAD_CACHE_ENTRIES = 8
const DEFAULT_LOAD_CACHE_MB = 128

/**
 * 进程内加载缓存预算（字节）。空字符串/非法值按默认值处理，`0` 明确关闭。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadCacheLimitBytes(env = process.env) {
  const raw = env?.PONOS_ATLAS_CACHE_MB
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_LOAD_CACHE_MB * 1024 * 1024
  }
  const mb = Number(raw)
  return Number.isFinite(mb) && mb >= 0 ? mb * 1024 * 1024 : DEFAULT_LOAD_CACHE_MB * 1024 * 1024
}

/** 配置项优先（loadAtlasConfig 已把 env 覆盖写进 cacheMB），缺省回落到环境/默认。 */
function cacheLimitBytesFor(config) {
  const mb = Number(config?.cacheMB)
  if (config?.cacheMB !== undefined && config?.cacheMB !== null && Number.isFinite(mb) && mb >= 0) {
    return mb * 1024 * 1024
  }
  return loadCacheLimitBytes()
}

function loadCacheBytes() {
  let total = 0
  for (const entry of loadCache.values()) total += entry.bytes || 0
  return total
}

/**
 * 写入一份已解析索引；按总预算 + 条数上限淘汰最久未用的条目。
 * 单份超过总预算时不缓存，返回 false（不影响正确性）。
 */
function rememberLoadedAtlas(dir, entry, limitBytes) {
  loadCache.delete(dir)
  if (!(limitBytes > 0) || !(entry.bytes <= limitBytes)) return false
  while (loadCache.size > 0 &&
    (loadCache.size >= LOAD_CACHE_ENTRIES || loadCacheBytes() + entry.bytes > limitBytes)) {
    loadCache.delete(loadCache.keys().next().value)
  }
  loadCache.set(dir, entry)
  return true
}

function atlasFileBytes(dir) {
  const p = atlasPaths(dir)
  let total = 0
  for (const f of [p.meta, p.nodes, p.edges, p.index]) {
    try { total += fs.statSync(f).size } catch { return Infinity }
  }
  // include 分片也是这份索引的体积：漏算会让进程缓存把大仓硬塞进内存。
  try { total += fs.statSync(includeShardPath(dir)).size } catch { /* 旧代/试算没有分片 */ }
  return total
}

function statKey(file) {
  try {
    const st = fs.statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch { return null }
}

/** 缓存命中前复核三个大文件的 stat：外部进程换过代/写坏过就重新读。 */
function dataFilesUnchanged(files, p) {
  return Boolean(files) &&
    files.nodes === statKey(p.nodes) &&
    files.edges === statKey(p.edges) &&
    files.index === statKey(p.index)
}

function invalidateAtlasCache(dir) {
  loadCache.delete(dir)
  metaCache.delete(dir)
}

/** 测试/诊断用：清空进程内缓存。 */
export function clearAtlasLoadCache() {
  loadCache.clear()
  metaCache.clear()
}

/**
 * 只读 meta（注入面用）。命中进程内 meta 缓存时连 1MB 的 meta 也不重复解析；
 * 不校验 nodes/edges/index 的 buildId（那需要读大文件）——注入只是地图，
 * 真正查询会走 loadAtlas 的完整跨代校验。
 */
export function loadAtlasMeta(dir) {
  const p = atlasPaths(dir)
  let st
  try { st = fs.statSync(p.meta) } catch { return { ok: false, reason: 'missing', dir } }
  const key = `${st.mtimeMs}:${st.size}`
  const cached = metaCache.get(dir)
  if (cached?.key === key) return cached.result

  const meta = readJson(p.meta)
  let result
  if (!meta) result = { ok: false, reason: 'corrupt-meta', dir }
  else if (meta.version !== ATLAS_VERSION) result = { ok: false, reason: 'version-mismatch', dir, meta }
  else result = { ok: true, dir, meta }
  metaCache.set(dir, { key, result })
  while (metaCache.size > 8) metaCache.delete(metaCache.keys().next().value)
  return result
}

/**
 * 加载已有 Atlas（只读，不构建）。命中进程缓存时只复核三个大文件的 stat。
 * @param {string} dir
 * @param {{cacheMB?:number}} [opts] cacheMB 覆盖进程缓存总预算（MB，0 = 不缓存）
 */
export function loadAtlas(dir, { cacheMB } = {}) {
  const m = loadAtlasMeta(dir)
  if (!m.ok) return m
  const meta = m.meta
  const p = atlasPaths(dir)
  const cached = loadCache.get(dir)
  if (cached && cached.buildId === meta.buildId && dataFilesUnchanged(cached.files, p)) {
    // 命中后重新入队：既刷新 LRU 位置，也在预算被调低时立即收缩（返回 false 则重读）。
    if (rememberLoadedAtlas(dir, cached, cacheLimitBytesFor({ cacheMB }))) return cached.loaded
  }

  const nodesDoc = readJson(p.nodes)
  const edgesDoc = readJson(p.edges)
  const index = readJson(p.index)
  if (!nodesDoc || !edgesDoc || !index) return { ok: false, reason: 'corrupt-data', dir, meta }
  if (meta.buildId !== nodesDoc.buildId || meta.buildId !== edgesDoc.buildId || meta.buildId !== index.buildId) {
    return { ok: false, reason: 'generation-mismatch', dir, meta }
  }
  if (!Array.isArray(nodesDoc.nodes) || !Array.isArray(edgesDoc.edges)) {
    return { ok: false, reason: 'corrupt-data', dir, meta }
  }
  const loaded = { ok: true, dir, meta, nodes: nodesDoc.nodes, edges: edgesDoc.edges, index }
  const bytes = atlasFileBytes(dir)
  if (Number.isFinite(bytes)) {
    const files = { nodes: statKey(p.nodes), edges: statKey(p.edges), index: statKey(p.index) }
    rememberLoadedAtlas(dir, { buildId: meta.buildId, files, loaded, bytes },
      cacheLimitBytesFor({ cacheMB }))
  }
  return loaded
}

/**
 * 注入面专用的**只读快照**：只读 meta.json，绝不扫描、绝不构建。
 *
 * 为什么必须与 ensureAtlasMeta 分开：ensure 系列在 TTL 过期后会 verify/rebuild，
 * 而注入发生在 composeSystemPrompt 的同步路径里 —— 大目录一次全量构建会把模型
 * 初始化卡住数分钟。地图是增强面，错过快照的代价远小于会话起不来。
 *
 * 返回 `ok:false` 时调用方应注入空块（不是报错）：missing / version-mismatch /
 * root-mismatch / no-l1 都是正常的“还没有可用快照”。
 *
 * @param {{root:string, dir:string, now?:number}} opts
 */
export function readAtlasSnapshot({ root, dir, now = Date.now() }) {
  const absRoot = path.resolve(root)
  const m = loadAtlasMeta(dir)
  if (!m.ok) return { ok: false, reason: m.reason, dir, meta: m.meta || null, built: false }
  if (path.resolve(m.meta.root) !== absRoot) {
    return { ok: false, reason: 'root-mismatch', dir, meta: m.meta, built: false }
  }
  // 范围快照只服务查询；即使误放进全量目录也不允许注入。
  if (m.meta.scope) return { ok: false, reason: 'scoped-snapshot', dir, meta: m.meta, built: false }
  if (typeof m.meta.l1 !== 'string' || !m.meta.l1) {
    return { ok: false, reason: 'no-l1', dir, meta: m.meta, built: false }
  }
  const createdMs = Date.parse(m.meta.createdAt)
  return {
    ok: true,
    dir,
    meta: m.meta,
    l1: m.meta.l1,
    metaOnly: true,
    built: false,
    freshness: {
      checked: false,
      stale: null,
      ageMs: Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : null,
      ttlMs: null,
    },
  }
}

/**
 * 查询面按路径找范围快照：返回命中 scope 的缓存（最长前缀优先）。
 * 只读目录列表 + meta，不扫描工作区；查不到返回 null。
 *
 * @param {{root:string, pathHint?:string, env?:NodeJS.ProcessEnv, configDir?:string|null}} opts
 */
export function findScopedAtlas({ root, pathHint = '', env = process.env, configDir = null }) {
  const absRoot = path.resolve(root)
  const hint = normalizeAtlasScope(pathHint)
  if (!hint) return null
  const base = resolveAtlasDir(absRoot, { env, configDir })
  const scopesDir = path.join(base.dir, 'scopes')
  let names
  try { names = fs.readdirSync(scopesDir) } catch { return null }
  let best = null
  for (const name of names) {
    const dir = path.join(scopesDir, name)
    const m = loadAtlasMeta(dir)
    if (!m.ok || !m.meta.scope) continue
    if (path.resolve(m.meta.root) !== absRoot) continue
    const scope = String(m.meta.scope)
    if (hint !== scope && !hint.startsWith(scope + '/')) continue
    if (!best || scope.length > best.scope.length) best = { dir, meta: m.meta, scope }
  }
  return best
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function configFingerprint(config) {
  return sha(JSON.stringify({
    v: ATLAS_VERSION,
    exclude: config.exclude,
    docs: config.docs,
    domains: config.domains,
    layers: config.layers,
    includeTests: config.includeTests,
    testPatterns: config.testPatterns,
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    docText: config.docText,
    maxDocTextFiles: config.maxDocTextFiles,
    maxDocTextPages: config.maxDocTextPages,
    maxDocTextChars: config.maxDocTextChars,
    maxDocExtractBytes: config.maxDocExtractBytes,
    docTextBudgetMs: config.docTextBudgetMs,
  }))
}

// 正文抽取失败的“可重试”原因：缺提取器/超预算可能是环境暂时问题。
// 解析错误/无文本层/旧格式是文件本身的稳定属性，不每轮重跑。
const RETRY_DOC_REASONS = new Set(['no-extractor', 'no-pypdf', 'extractor-error', 'budget', 'disabled', 'not-prepared'])

/**
 * @param {any} prev
 * @param {any} f
 * @param {boolean} docTextEnabled
 */
function canReuseCard(prev, f, docTextEnabled) {
  if (!prev || prev.v !== 1 || prev.kind !== f.kind ||
      prev.mtimeMs !== f.mtimeMs || prev.size !== f.size) return false
  if (f.kind !== 'doc' || !docTextEnabled) return true
  return !RETRY_DOC_REASONS.has(String(prev.docTextReason || ''))
}

// 只认工作区根部的元数据文件：它们的文字会被 T2 提示复用，变了就得全量重抽。
const META_FILE_RE = /^(?:package\.json|pyproject\.toml|readme(?:\.[a-z0-9]+)?)$/i

function metaFingerprint(scan) {
  const parts = scan.files
    .filter((f) => !f.rel.includes('/') && META_FILE_RE.test(f.rel))
    .map((f) => `${f.rel}:${f.size}:${f.mtimeMs}`)
    .sort()
  return sha(parts.join('|'))
}

/** 与 metaFingerprint(scan) 同口径，但只 stat 根部元数据 —— 用于“先决定能否跳过正文”。 */
function metaFingerprintRoot(root) {
  const parts = []
  let names = []
  try { names = fs.readdirSync(root) } catch { return sha('') }
  for (const name of names) {
    if (!META_FILE_RE.test(name)) continue
    try {
      const st = fs.statSync(path.join(root, name))
      if (st.isFile()) parts.push(`${name}:${st.size}:${st.mtimeMs}`)
    } catch { /* 读不到就当不存在；scan 会如实报告 */ }
  }
  return sha(parts.sort().join('|'))
}

function gitInfo(root) {
  const run = (args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  }).trim()
  try {
    const head = run(['rev-parse', 'HEAD'])
    let dirty = false
    try { dirty = run(['status', '--porcelain', '--untracked-files=normal']).length > 0 } catch { /* 保守：未知按脏处理 */ dirty = true }
    return { head: head || null, dirty }
  } catch {
    return { head: null, dirty: null }
  }
}

function fullReason({ force, loaded, cfgFp, metaFp }) {
  if (force) return 'forced'
  if (!loaded || !loaded.ok) return loaded ? loaded.reason : 'missing'
  if (loaded.meta.configFingerprint !== cfgFp) return 'config-changed'
  if (loaded.meta.metaFingerprint !== metaFp) return 'metadata-changed'
  return null
}

/**
 * 构建 Atlas。返回的 `meta` 在 write=false 时也包含本次构建信息。
 * `docText` 可注入 `preparePdfText` 的结果（测试用）；不传时按配置自动抽取。
 * @param {{root:string, config?:object, dir?:string, dirMode?:string, force?:boolean, write?:boolean, now?:number, docText?:any, scope?:string, maxBuildFiles?:number|null}} opts
 */
export function buildAtlas({ root, config, dir, dirMode, force = false, write = true, now = Date.now(), docText = null, scope = '', maxBuildFiles = null }) {
  const absRoot = path.resolve(root)
  const cfg = config || loadAtlasConfig(absRoot)
  const scopeNorm = normalizeAtlasScope(scope)
  if (scopeNorm === null) return { ok: false, reason: 'invalid-scope', scope: String(scope), dir: null }
  const resolved = dir
    ? { dir, mode: dirMode || (scopeNorm ? 'scope' : 'explicit'), workspaceId: workspaceId(absRoot) }
    : (scopeNorm ? resolveAtlasScopeDir(absRoot, scopeNorm) : resolveAtlasDir(absRoot))
  if (!resolved) return { ok: false, reason: 'invalid-scope', scope: String(scope), dir: null }
  const cacheDir = resolved.dir
  const cap = Number.isFinite(Number(maxBuildFiles)) && Number(maxBuildFiles) > 0
    ? Math.floor(Number(maxBuildFiles))
    : cfg.maxBuildFiles

  const t0 = Date.now()
  const loaded = force ? null : loadAtlas(cacheDir, { cacheMB: cfg.cacheMB })
  const cfgFp = configFingerprint(cfg)
  const metaFpRoot = metaFingerprintRoot(absRoot)
  // 只有“配置未变 + 根部元数据未变”时才敢让 scan 跳过正文：否则 T2 提示可能变，
  // 复用旧卡会漏掉 package.json/README 的影响。
  const preReuse = !force && loaded?.ok &&
    loaded.meta.configFingerprint === cfgFp &&
    loaded.meta.metaFingerprint === metaFpRoot
  const prevByPath = new Map()
  if (preReuse) {
    for (const n of loaded.nodes) {
      if (n.kind !== 'domain' && n.kind !== 'layer' && n.path) prevByPath.set(n.path, n)
    }
  }

  // ★ lazy：只 stat，不把全部正文驻留内存（十万级文件会 OOM）；抽取阶段逐个读取。
  // 索引代差：本功能上线前的缓存没有词项段；若继续复用旧卡，未变文件永远不会
  // 进入索引 ⇒ 无作用域检索会静默漏检。只在“要写盘”的构建里强制全量重建；
  // write=false 的试算/单测不产生索引，查询会自动回退到逐文件扫描。
  const indexMissing = write && Boolean(loaded?.ok) && (
    loaded.meta.searchIndexVersion !== TERM_INDEX_VERSION ||
    !segmentsIntact(cacheDir, loaded.meta.searchSegments)
  )
  const reasonOf = (fp) => fullReason({ force, loaded, cfgFp, metaFp: fp }) || (indexMissing ? 'index-missing' : null)
  let scan = scanWorkspace({ root: absRoot, config: cfg, reuse: preReuse ? prevByPath : null, textMode: 'lazy', scope: scopeNorm })
  let metaFp = metaFingerprint(scan)
  let reason = reasonOf(metaFp)
  let canReuse = !reason && Boolean(loaded?.ok)
  // 关键：不能只把 canReuse 置 false 而留着 prevByPath——抽取循环仍会复用旧卡，
  // 结果“全量重建”却没有重抽，索引依旧缺文件。清空后才是真正的全量。
  if (reason === 'index-missing') prevByPath.clear()
  // 极端竞态：预检后根部元数据变化，但 scan 已跳过正文 ⇒ 必须重扫，不能拿空文本抽取。
  if (preReuse && !canReuse && scan.files.some((f) => f.reused)) {
    scan = scanWorkspace({ root: absRoot, config: cfg, textMode: 'lazy', scope: scopeNorm })
    metaFp = metaFingerprint(scan)
    reason = reasonOf(metaFp)
    canReuse = !reason && Boolean(loaded?.ok)
  }
  // 显式构建的保护闸：超过上限时**在抽取前**返回，不读正文、不写缓存。
  // 大仓（尤其非 git 目录）应先用 path 缩小范围；这样 agent 能为“这次任务”
  // 选择成本，而不是让一次查询/注入隐式触发全量解析。
  if (scopeNorm && scan.files.length === 0) {
    return { ok: false, reason: 'scope-empty', dir: cacheDir, scope: scopeNorm }
  }
  if (cap > 0 && scan.files.length > cap) {
    return {
      ok: false,
      reason: 'build-too-large',
      dir: cacheDir,
      scope: scopeNorm || null,
      files: scan.files.length,
      maxBuildFiles: cap,
    }
  }
  // buildMetaHints 需要根 README 的正文做 T2 提示；只补这一个文件，其余仍按需读。
  const readme = scan.files.find((f) => /^readme(?:\.(?:md|mdx|txt|rst))?$/i.test(f.rel))
  if (readme) {
    const read = readEntryText(readme.abs, readme, cfg)
    readme.text = read.text
    readme.content = read.content
    readme.binary = read.binary
    readme.textTruncated = read.textTruncated
  }
  const scanMs = Date.now() - t0
  if (canReuse && !preReuse) {
    for (const n of loaded.nodes) {
      if (n.kind !== 'domain' && n.kind !== 'layer' && n.path) prevByPath.set(n.path, n)
    }
  }
  let metaHints = null
  const getMetaHints = () => metaHints || (metaHints = buildMetaHints(absRoot, scan.files))
  // lazy 模式下 README 正文会在它自己抽完后释放；T2 提示必须先用它建好，不能等抽取中途再读。
  getMetaHints()

  const docTextEnabled = !(docText?.enabled === false || cfg.docText === false)
  // PDF 文本层是唯一需要外部进程的部分：先批量预备，再逐卡抽取。
  // 只处理“确实要重抽”的 PDF，复用卡不重复解析。
  const tDocText = Date.now()
  const docTextCtx = preparePdfText({
    files: scan.files,
    needs: (f) => !canReuseCard(prevByPath.get(f.rel), f, docTextEnabled),
    config: cfg,
    injected: docText,
  })
  const docTextMs = Date.now() - tDocText

  const tExtract = Date.now()
  const tIndex = Date.now()
  /** @type {null | { addText: (rel: string, text: string) => void, finish: () => any }} */
  let termWriter = null
  // 只为“本次重抽的正文”建 postings；未变文件的旧段继续有效。
  const addTermText = (rel, text) => {
    if (!write || !text) return
    if (!termWriter) termWriter = createSegmentWriter({ cacheDir, buildId: newSegmentId() })
    termWriter.addText(rel, text)
  }
  const cards = []
  let reused = 0
  let extracted = 0
  for (const f of scan.files) {
    const prev = prevByPath.get(f.rel)
    if (prev && canReuseCard(prev, f, docTextEnabled)) {
      cards.push(prev)
      reused++
      continue
    }
    // ★ lazy 扫描只 stat：这里逐个读正文，抽完立即释放，峰值内存只与单文件大小相关。
    const read = readEntryText(f.abs, f, cfg)
    f.text = read.text
    f.content = read.content
    f.binary = read.binary
    f.textTruncated = read.textTruncated
    let card
    if (f.kind === 'doc') {
      card = extractDocCard({ entry: f, config: cfg, docText: docTextCtx, onText: addTermText })
    } else {
      // 代码/测试/普通文件的正文已在手：先喂索引，再释放。
      addTermText(f.rel, f.text)
      if (f.kind === 'code' || f.kind === 'test') card = extractCodeCard({ entry: f, config: cfg, metaHints: getMetaHints() })
      else card = extractFileCard({ entry: f, config: cfg, metaHints: getMetaHints() })
    }
    cards.push(card)
    f.text = undefined
    extracted++
  }
  const extractMs = Date.now() - tExtract

  let termSegment = null
  try { termSegment = termWriter ? termWriter.finish() : null } catch { termSegment = null }
  let searchSegments
  if (!write) searchSegments = []
  else if (canReuse && Array.isArray(loaded?.meta?.searchSegments)) {
    searchSegments = [...loaded.meta.searchSegments, ...(termSegment ? [termSegment] : [])]
  } else {
    // 全量重建：旧段对应的文件已全部重抽，旧段可以被新段完全替代。
    searchSegments = termSegment ? [termSegment] : []
  }
  // 段数上限：合并是并集，陈旧 postings 保留（只会多候选，不会漏）。
  if (write && searchSegments.length > 8) {
    try {
      const compacted = compactSegments({ cacheDir, segments: searchSegments, buildId: newSegmentId() })
      if (compacted) searchSegments = [compacted]
    } catch { /* 合并失败保留多段：查询仍正确，只是多读几个文件 */ }
  }
  const indexMs = Date.now() - tIndex

  const tGraph = Date.now()
  const graph = buildGraph({ cards, root: absRoot, config: cfg, meta: scan })
  const graphMs = Date.now() - tGraph

  const currentPaths = new Set(scan.files.map((f) => f.rel))
  const removed = canReuse
    ? [...prevByPath.keys()].filter((p) => !currentPaths.has(p)).length
    : 0

  const buildId = crypto.randomUUID()
  const paths = {}
  const baseMap = new Map()
  for (const n of graph.nodes) {
    if (!n.path || n.kind === 'domain' || n.kind === 'layer') continue
    paths[n.path] = n.id
    const b = path.posix.basename(n.path)
    if (!baseMap.has(b)) baseMap.set(b, [])
    baseMap.get(b).push(n.path)
  }
  const byBase = {}
  for (const [b, list] of [...baseMap.entries()].sort((a, c) => a[0].localeCompare(c[0]))) {
    byBase[b] = list.sort()
  }
  const index = {
    buildId,
    paths,
    byBase,
    domains: graph.domains,
    layers: graph.layers,
  }

  const meta = {
    version: ATLAS_VERSION,
    buildId,
    createdAt: new Date(now).toISOString(),
    root: absRoot,
    workspaceId: resolved.workspaceId,
    cacheDir,
    cacheMode: resolved.mode,
    // null = 全工作区快照（可注入）；字符串 = 子范围快照（只服务查询，不注入）。
    scope: scopeNorm || null,
    configFingerprint: cfgFp,
    metaFingerprint: metaFp,
    scanMode: scan.mode,
    scanWarnings: scan.warnings,
    excluded: scan.excluded,
    truncated: scan.truncated,
    maxFiles: scan.maxFiles,
    filesScanned: scan.files.length,
    counts: {
      nodes: graph.nodes.length,
      content: graph.coverage.total,
      edges: graph.edges.length,
    },
    summary: graph.summary,
    coverage: graph.coverage,
    domains: graph.domains,
    layers: graph.layers,
    design: graph.design,
    git: gitInfo(absRoot),
    incremental: {
      full: Boolean(reason),
      reason: reason || null,
      reused,
      extracted,
      removed,
    },
    docText: docTextCtx.stats,
    // 词项索引段：查询只读 meta 就知道该去哪些 segment 查；段文件在 <cache>/terms/。
    searchIndexVersion: TERM_INDEX_VERSION,
    searchSegments,
    freshnessTtlMs: cfg.freshnessTtlMs,
    timings: { scanMs, docTextMs, extractMs, indexMs, graphMs, totalMs: Date.now() - t0 },
  }

  const result = {
    ok: true,
    dir: cacheDir,
    meta,
    nodes: graph.nodes,
    edges: graph.edges,
    index,
    summary: graph.summary,
    coverage: graph.coverage,
    domains: graph.domains,
    layers: graph.layers,
  }

  // L1 预计算：注入面只需 meta.json，不必为了 3KB 地图去解析几百 MB 的
  // nodes/edges/index。存**未截断**全文（各段Top N本来就有界），注入时按预算截断，
  // 这样不同 injectMaxBytes 得到与现场 renderL1 逐字一致的结果。
  meta.l1 = renderL1(result, { budget: Infinity })
  meta.l1Bytes = Buffer.byteLength(meta.l1, 'utf8')

  // 构建结果已含全部边（含 include）：标记后 allEdges/_renderCard 不再读分片。
  markEdgesInline(result)

  if (write) {
    const tWrite = Date.now()
    const p = atlasPaths(cacheDir)
    writeFileAtomicSync(p.nodes, JSON.stringify({ buildId, nodes: graph.nodes }))
    // include 边单列：find/overview/search 永远不用，impact/related 才读。
    meta.includes = writeIncludeShard({ dir: cacheDir, buildId, nodes: graph.nodes, edges: graph.edges })
    const coreEdges = graph.edges.filter((e) => e.via !== 'include')
    writeFileAtomicSync(p.edges, JSON.stringify({ buildId, edges: coreEdges }))
    writeFileAtomicSync(p.index, JSON.stringify(index))
    meta.timings.writeMs = Date.now() - tWrite
    meta.timings.totalMs = Date.now() - t0
    writeFileAtomicSync(p.meta, JSON.stringify(meta))
    // meta 是提交点：它落盘后才删旧段；中途崩溃时旧 meta 仍指向旧段，检索不会坏。
    try { pruneSegments(cacheDir, searchSegments) } catch { /* 清理失败只是占盘 */ }

    // 刚写下的四件套就是“成功加载”的最好证据：直接种进进程缓存，
    // 后续查询/注入不必立刻把几百 MB 重新解析一遍。
    invalidateAtlasCache(cacheDir)
    try {
      const st = fs.statSync(p.meta)
      metaCache.set(cacheDir, { key: `${st.mtimeMs}:${st.size}`, result: { ok: true, dir: cacheDir, meta } })
      rememberLoadedAtlas(cacheDir, {
        buildId,
        files: { nodes: statKey(p.nodes), edges: statKey(p.edges), index: statKey(p.index) },
        loaded: result,
        bytes: atlasFileBytes(cacheDir),
      }, cacheLimitBytesFor(cfg))
    } catch { /* 种缓存失败只影响性能，不影响正确性 */ }
  }

  // P1.1 仪表：每次实际构建记一次；复用旧卡做增量 = incrementalHits。
  recordAtlas({ build: true, incremental: meta.incremental.full === false })
  return result
}

// 同一进程内的校验节流：CLI 一次查询和 agent 连续查询都走这里。
// 只存内存，不写盘 —— 跨进程仍以 createdAt + TTL 为准。
const verifiedAt = new Map()

/**
 * 加载已有 Atlas；缺失/跨代/版本不符/超过 TTL 且校验发现变化时才构建。
 * `maxAgeMs=0` 时每次调用都校验；不传则用配置 `freshnessTtlMs`（默认 30s）。
 *
 * ★ **会同步构建**：只允许 CLI/基准/显式工具调用使用；注入路径请用
 * `readAtlasSnapshot`（只读 meta），查询路径请用 `loadAtlas`。
 * @param {{root:string, config?:object, force?:boolean, now?:number, maxAgeMs?:number, dir?:string}} opts
 */
export function ensureAtlas({ root, config, force = false, now = Date.now(), maxAgeMs, dir }) {
  const absRoot = path.resolve(root)
  const cfg = config || loadAtlasConfig(absRoot)
  const resolved = dir
    ? { dir, mode: 'explicit', workspaceId: workspaceId(absRoot) }
    : resolveAtlasDir(absRoot)
  const ttl = maxAgeMs != null ? Math.max(0, Number(maxAgeMs) || 0) : Math.max(0, Number(cfg.freshnessTtlMs) || 0)

  if (!force) {
    const loaded = loadAtlas(resolved.dir, { cacheMB: cfg.cacheMB })
    if (loaded.ok && path.resolve(loaded.meta.root) === absRoot) {
      const createdMs = Date.parse(loaded.meta.createdAt)
      const lastCheck = verifiedAt.get(resolved.dir) || createdMs
      const ageMs = Number.isFinite(lastCheck) ? Math.max(0, now - lastCheck) : Infinity
      if (ageMs <= ttl) {
        return { ...loaded, built: false, freshness: { checked: false, stale: false, ageMs, ttlMs: ttl } }
      }
      let check = null
      try {
        check = verifyAtlas({ root: absRoot, config: cfg, dir: resolved.dir })
      } catch { /* 校验失败按“可能变化”处理，宁可重建 */ }
      if (check?.ok) {
        verifiedAt.set(resolved.dir, now)
        return { ...loaded, built: false, freshness: { checked: true, stale: false, ageMs, ttlMs: ttl } }
      }
    }
  }

  const built = buildAtlas({ root: absRoot, config: cfg, dir: resolved.dir, dirMode: resolved.mode, force, now })
  verifiedAt.set(resolved.dir, now)
  return { ...built, built: true, freshness: { checked: true, stale: false, built: true, ttlMs: ttl } }
}

/**
 * 读 meta 快路径：能只读 meta.json 就不加载 nodes/edges/index。
 *
 * ★ **仍是 ensure 家族，会构建**（命中失败会回落 `ensureAtlas`）——不得用在
 * `composeSystemPrompt` 等同步注入路径上；注入用 `readAtlasSnapshot`。
 *
 * 新鲜度判定与 ensureAtlas 完全同款（TTL + verifiedAt 节流）；差异只在“命中”时
 * 返回 `{ metaOnly:true, l1 }` —— 地图所需的全部统计/域/高重要度条目已在构建时
 * 写进 `meta.l1`。没有 l1 的旧缓存（同版本但构建于预计算之前）自动回退到
 * ensureAtlas，绝不因缺字段而注入空地图。
 *
 * @param {{root:string, config?:object, force?:boolean, now?:number, maxAgeMs?:number, dir?:string}} opts
 */
export function ensureAtlasMeta({ root, config, force = false, now = Date.now(), maxAgeMs, dir }) {
  const absRoot = path.resolve(root)
  const cfg = config || loadAtlasConfig(absRoot)
  const resolved = dir
    ? { dir, mode: 'explicit', workspaceId: workspaceId(absRoot) }
    : resolveAtlasDir(absRoot)
  const ttl = maxAgeMs != null ? Math.max(0, Number(maxAgeMs) || 0) : Math.max(0, Number(cfg.freshnessTtlMs) || 0)

  if (!force) {
    const m = loadAtlasMeta(resolved.dir)
    if (m.ok && typeof m.meta.l1 === 'string' && path.resolve(m.meta.root) === absRoot) {
      const createdMs = Date.parse(m.meta.createdAt)
      const lastCheck = verifiedAt.get(resolved.dir) || createdMs
      const ageMs = Number.isFinite(lastCheck) ? Math.max(0, now - lastCheck) : Infinity
      if (ageMs <= ttl) {
        return {
          ok: true,
          dir: resolved.dir,
          meta: m.meta,
          l1: m.meta.l1,
          metaOnly: true,
          built: false,
          freshness: { checked: false, stale: false, ageMs, ttlMs: ttl },
        }
      }
    }
  }

  const loaded = ensureAtlas({ root: absRoot, config: cfg, force, now, maxAgeMs, dir: resolved.dir })
  const l1 = typeof loaded?.meta?.l1 === 'string' ? loaded.meta.l1 : renderL1(loaded, { budget: Infinity })
  return { ...loaded, metaOnly: false, l1 }
}

/**
 * 只校验、不重建：重新扫描工作区，报告 added/removed/changed。
 * 用于 CI/调试（P0）以及 P1 的懒刷新判据。
 * @param {{root:string, config?:object, dir?:string}} opts
 */
export function verifyAtlas({ root, config, dir }) {
  const absRoot = path.resolve(root)
  const cfg = config || loadAtlasConfig(absRoot)
  const resolved = dir ? { dir } : resolveAtlasDir(absRoot)
  const loaded = loadAtlas(resolved.dir, { cacheMB: cfg.cacheMB })
  if (!loaded.ok) return { ok: false, reason: loaded.reason, dir: resolved.dir }

  const indexed = new Map()
  for (const n of loaded.nodes) {
    if (n.kind === 'domain' || n.kind === 'layer') continue
    if (n.path) indexed.set(n.path, n)
  }
  // 校验只需要 stat；复用旧卡可避免把几千个未变文件重新读一遍
  // （大仓从“全量读正文”降到“全量 stat”）。
  // 校验只比 mtime/size，不读正文（大仓校验从“全量读正文”降为“全量 stat”）。
  const scan = scanWorkspace({ root: absRoot, config: cfg, reuse: indexed, textMode: 'lazy' })
  const cfgChanged = loaded.meta.configFingerprint !== configFingerprint(cfg)
  const metaChanged = loaded.meta.metaFingerprint !== metaFingerprint(scan)
  const current = new Set(scan.files.map((f) => f.rel))
  const added = []
  const changed = []
  for (const f of scan.files) {
    const card = indexed.get(f.rel)
    if (!card) { added.push(f.rel); continue }
    if (card.mtimeMs !== f.mtimeMs || card.size !== f.size) changed.push(f.rel)
  }
  const removed = [...indexed.keys()].filter((p) => !current.has(p))
  return {
    ok: !cfgChanged && !metaChanged && added.length === 0 && changed.length === 0 && removed.length === 0,
    dir: resolved.dir,
    buildId: loaded.meta.buildId,
    configChanged: cfgChanged,
    metaChanged,
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    scanned: scan.files.length,
  }
}
