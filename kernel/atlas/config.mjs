// kernel/atlas/config.mjs —— Project Atlas 的扫描范围、缓存位置与域规则
// ---------------------------------------------------------------------------
// P0 只做**工作区结构索引**：代码/测试/文档卡片 + 真实 import 边。设计 token、
// 契约、组件投影与注入面分别在 P1/P2 接入；本文件不读取 settings、不写任何工作区文件。
//
// 缓存位置的三条顺序（与 spec §5.1 一致）：
//   ① PONOS_ATLAS_DIR 显式覆盖（开发/测试用）
//   ② 工作区是 git 仓，且仓**已经忽略** `.ponos/`（等于用户显式同意）→ <root>/.ponos/atlas
//   ③ 否则 <configDir>/atlas/<workspaceId>
// ② 的判据用 `git check-ignore -q .ponos/`，不靠调用方自证；普通用户仓库没忽略
// `.ponos/` 时不会把缓存写进去（不污染别人的 git status）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolveConfigDir } from '../config.mjs'

// v6：C/C++ `#include` 边（独立 includes 分片）+ impact 分组 + 词项索引。
// 旧缓存没有 include 数据/词项段，必须整体重建（ATLAS_VERSION 是缓存世代号）。
export const ATLAS_VERSION = 6

// ── 文件类型 ─────────────────────────────────────────────────────────────
// 代码扩展名刻意放宽到常见语言：抽不出 import 的语言仍会得到路径/结构卡，
// 不会因为“不是 JS/TS”就从图里消失（spec §5.10 的低结构回退）。
export const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.scala', '.sh', '.bash', '.zsh', '.ps1',
  '.sql', '.vue', '.svelte', '.lua', '.dart', '.ex', '.exs', '.erl', '.hs',
  '.clj', '.cljs', '.r',
])
export const DOC_EXT = new Set(['.md', '.mdx', '.html', '.htm', '.txt', '.csv', '.rst', '.adoc'])
export const OFFICE_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf',
])
export const IMAGE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg', '.ico',
])
export const CONFIG_EXT = new Set([
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.xml', '.properties',
])
export const SECRET_EXT = new Set([
  '.pem', '.key', '.p12', '.pfx', '.cer', '.crt', '.keystore', '.jks', '.asc', '.gpg',
])

const TEST_RE = /\.(test|spec|e2e)\.[a-z0-9]+$/i
const TEST_PREFIX_RE = /^test[_-]/i
// C/C++/Go/Rust 等常见测试命名：`*_unittest.cc`、`*_browsertest.cc`、
// `*_test.go`、`*_spec.rb`。只认带分隔符的后缀，避免把 `attestation.cc` 误判。
const TEST_SUFFIX_RE = /(?:_unittest|_browsertest|_perftest|_regtest|_test|_spec)\.(?:[a-z0-9]+)$/i
// Java/C#/Kotlin：`FooTest.java`、`FooTests.cs`、`FooIT.java`（大写开头后缀）。
const TEST_CLASS_RE = /^(?:.*(?:Test|Tests|IT))\.(?:java|cs|kt|scala)$/
// 目录约定：tests/、test/、__tests__/、spec/、specs/（不匹配 `kernel-tests/` 这类复合名）。
const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)/i
const LOCK_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'cargo.lock', 'poetry.lock', 'uv.lock', 'composer.lock', 'gemfile.lock',
])

// 任意层级都跳过的目录（依赖/版本库/本工具自己的缓存/agent 本地状态）
export const SKIP_ANY_DIR = new Set([
  'node_modules', '.git', '.worktrees', '.superpowers', '.ponos',
  '.pi', '.claude', '.cache', '.turbo', '.next', '.nuxt', '.svelte-kit',
])
// 只跳过工作区顶层的生成物目录（用户文档里可以有 docs/build/ 这类合法目录）
export const SKIP_TOP_DIR = new Set(['dist', 'build', 'coverage', 'release', 'runtime', 'kernel-dist'])

const DOC_ARCHIVE_PREFIXES = [
  'docs/superpowers/plans/',
  'docs/superpowers/audits/',
  'docs/architecture-history/',
]

// 通用层：只登记“跨项目常见且语义明确”的顶层组；其余顶层目录按目录名原样成层
// （`packages/`、`apps/`、`services/`、`examples/` 等），避免把某个仓的架构名写死进内核。
// Ponos 自己的 renderer/host/bridge 映射在仓根 `atlas.config.json`。
export const DEFAULT_LAYERS = [
  { id: 'shared', dirs: ['shared', 'common'] },
  { id: 'docs', dirs: ['docs', 'design', '需求问题体系'] },
  { id: 'tooling', dirs: ['scripts', 'bin', 'tools', 'pet'] },
  { id: 'tests', dirs: ['tests', 'test', '__tests__'] },
  { id: 'config', dirs: ['.github', '.husky', '.gitlab'] },
]

function asArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()) : []
}

function asPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function asNonNegativeInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

/**
 * 读取可选的配置；缺失/损坏时使用默认规则并留下 warning，不阻断构建。
 * 默认读 `<root>/atlas.config.json`；`PONOS_ATLAS_CONFIG`（绝对路径）可指向仓外配置，
 * 用于**只读工作区**（不能让目标仓被写入）或同一份配置服务多个工作区。
 * 相对路径不猜基准目录，直接忽略并留 warning。
 */
export function loadAtlasConfig(root, { env = process.env } = {}) {
  const cfg = {
    exclude: [],
    docs: [],
    domains: [],
    layers: null,
    includeTests: false,
    testPatterns: [],
    maxFiles: 50_000,
    // 显式构建的单次文件数上限（不是扫描上限）：超过就直接拒绝并提示用 path 缩小范围。
    // 与 maxFiles 分开的原因：扫描 50k 仍可能只抽取很小一部分；这个上限保护的是
    // “一次 build 的抽取/解析成本”。默认 10k，覆盖普通仓；大仓由 agent 选子目录。
    maxBuildFiles: 10_000,
    maxFileBytes: 2 * 1024 * 1024,
    // 文档正文适配（P1）：docx/xlsx/pptx 纯 JS 解析；PDF 只取文本层（不 OCR）。
    // 所有上限都是“保护构建”的，不是精确索引承诺 —— 超出时降级为元数据卡。
    docText: true,
    maxDocTextFiles: 500,
    maxDocTextPages: 5,
    maxDocTextChars: 20_000,
    maxDocExtractBytes: 20 * 1024 * 1024,
    docTextBudgetMs: 20_000,
    // 进程内解析缓存的总预算（MB，按磁盘体积估算；0 = 关闭）。
    // 实测 Chromium 53k 范围约 115MB：64MB 旧默认导致每次查询重新解析 ~1.1s；
    // 128MB 可覆盖该范围，热加载 0.69ms。总预算 + LRU 避免多份大索引叠加。
    // 只影响查询延迟，不参与 configFingerprint（改它不触发重建）。
    cacheMB: 128,
    // 缓存新鲜度：0 = 每次 ensure 都校验；30s 是“查询密集的 agent 循环”默认值。
    // 卡片/影响面查询仍会按目标节点的 mtime 单独刷新，不等这个 TTL。
    freshnessTtlMs: 30_000,
    warnings: [],
  }
  // 运维/压力测试覆盖：只在显式 build 时生效；查询与注入永远不会因此自动构建。
  const envMaxBuild = Number(env?.PONOS_ATLAS_MAX_BUILD_FILES)
  if (Number.isFinite(envMaxBuild) && envMaxBuild > 0) cfg.maxBuildFiles = Math.floor(envMaxBuild)
  // 空字符串按“未设置”处理（旧实现会 Number('') === 0，意外关闭缓存）。
  let envCacheMB = null
  const rawEnvCache = env?.PONOS_ATLAS_CACHE_MB
  if (rawEnvCache !== undefined && rawEnvCache !== null && String(rawEnvCache).trim() !== '') {
    const n = Number(rawEnvCache)
    if (Number.isFinite(n) && n >= 0) envCacheMB = n
  }
  if (envCacheMB !== null) cfg.cacheMB = envCacheMB
  let file = path.join(root, 'atlas.config.json')
  let label = 'atlas.config.json'
  const override = env?.PONOS_ATLAS_CONFIG
  if (override) {
    if (!path.isAbsolute(String(override))) {
      cfg.warnings.push('PONOS_ATLAS_CONFIG 必须是绝对路径，已忽略（继续使用工作区配置）')
    } else {
      file = String(override)
      label = 'PONOS_ATLAS_CONFIG'
    }
  }
  if (!fs.existsSync(file)) {
    if (label !== 'atlas.config.json') cfg.warnings.push(`${label} 指向的文件不存在：${file}`)
    return cfg
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    cfg.warnings.push(`${label} 无法解析（${err.message}），已使用默认规则`)
    return cfg
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    cfg.warnings.push(`${label} 顶层必须是对象，已使用默认规则`)
    return cfg
  }
  cfg.exclude = asArray(raw.exclude)
  cfg.docs = asArray(raw.docs)
  cfg.includeTests = raw.includeTests === true
  cfg.testPatterns = asArray(raw.testPatterns)
  cfg.maxFiles = asPositiveInt(raw.maxFiles, cfg.maxFiles)
  cfg.maxBuildFiles = asPositiveInt(raw.maxBuildFiles, cfg.maxBuildFiles)
  cfg.maxFileBytes = asPositiveInt(raw.maxFileBytes, cfg.maxFileBytes)
  // 环境变量优先级高于工作区配置文件（运维需要按机器临时调整内存预算）。
  if (envCacheMB === null) cfg.cacheMB = asNonNegativeInt(raw.cacheMB, cfg.cacheMB)
  cfg.docText = raw.docText !== false
  cfg.maxDocTextFiles = asPositiveInt(raw.maxDocTextFiles, cfg.maxDocTextFiles)
  cfg.maxDocTextPages = asPositiveInt(raw.maxDocTextPages, cfg.maxDocTextPages)
  cfg.maxDocTextChars = asPositiveInt(raw.maxDocTextChars, cfg.maxDocTextChars)
  cfg.maxDocExtractBytes = asPositiveInt(raw.maxDocExtractBytes, cfg.maxDocExtractBytes)
  cfg.docTextBudgetMs = asPositiveInt(raw.docTextBudgetMs, cfg.docTextBudgetMs)
  cfg.freshnessTtlMs = asNonNegativeInt(raw.freshnessTtlMs, cfg.freshnessTtlMs)
  if (Array.isArray(raw.domains)) {
    cfg.domains = raw.domains
      .filter((d) => d && typeof d === 'object' && typeof d.id === 'string' && d.id.trim())
      .map((d) => ({
        id: d.id.trim(),
        name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : d.id.trim(),
        dirs: asArray(d.dirs),
        files: asArray(d.files),
        match: typeof d.match === 'string' && d.match ? d.match : null,
      }))
  }
  if (Array.isArray(raw.layers)) {
    const layers = raw.layers
      .filter((l) => l && typeof l === 'object' && typeof l.id === 'string' && l.id.trim())
      .map((l) => ({ id: l.id.trim(), dirs: asArray(l.dirs) }))
    if (layers.length) cfg.layers = layers
  }
  return cfg
}

/** 稳定、可复现的工作区标识：真实路径的短哈希（避免跨工作区串卡）。 */
export function workspaceId(root) {
  let real = path.resolve(root)
  try { real = fs.realpathSync.native(real) } catch { /* 路径不存在时用 resolve 结果 */ }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 12)
}

export function isGitRepo(root) {
  return fs.existsSync(path.join(root, '.git'))
}

function isGitIgnored(root, rel) {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', rel], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * 缓存目录解析。返回 `{dir, mode, workspaceId}`：
 *   mode=override（PONOS_ATLAS_DIR）/ repo（仓已忽略 .ponos/）/ configDir（安全默认）
 * @param {string} root
 * @param {{env?:NodeJS.ProcessEnv, configDir?:string}} [opts]
 */
export function resolveAtlasDir(root, { env = process.env, configDir } = {}) {
  const absRoot = path.resolve(root)
  const id = workspaceId(absRoot)
  const override = env.PONOS_ATLAS_DIR
  if (override) {
    return { dir: path.resolve(absRoot, override), mode: 'override', workspaceId: id }
  }
  if (isGitRepo(absRoot) && isGitIgnored(absRoot, '.ponos/')) {
    return { dir: path.join(absRoot, '.ponos', 'atlas'), mode: 'repo', workspaceId: id }
  }
  const cd = configDir || resolveConfigDir(env)
  return { dir: path.join(cd, 'atlas', id), mode: 'configDir', workspaceId: id }
}

/**
 * 规范化构建范围（工作区相对路径前缀）。
 * `''` = 全工作区；`null` = 非法（绝对路径 / 盘符 / 含 `..`），调用方必须拒绝。
 * 只做语法归一，不校验路径是否存在（构建时再判空范围）。
 * @param {unknown} scope
 * @returns {string|null}
 */
export function normalizeAtlasScope(scope) {
  let s = String(scope ?? '').trim().replace(/\\/g, '/')
  if (!s || s === '.' || s === './') return ''
  if (/^[A-Za-z]:/.test(s) || s.startsWith('/')) return null
  s = s.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!s || s === '.') return ''
  const parts = s.split('/')
  if (parts.some((p) => !p || p === '..')) return null
  return parts.join('/')
}

/**
 * 范围构建的缓存目录：`<工作区缓存>/scopes/<scope 哈希>`。
 *
 * 为什么必须独立目录：范围索引的节点、边、词项只覆盖子树；写进全量缓存会把
 * “完整地图”替换成“残缺地图”，而注入面会把它当成全量快照。独立目录还能让
 * 多个范围并存（agent 按任务选范围），且不会让全量注入命中残缺索引。
 *
 * @param {string} root
 * @param {string} scope
 * @param {{env?:NodeJS.ProcessEnv, configDir?:string|null}} [opts]
 * @returns {{dir:string, mode:'scope', workspaceId:string, scope:string, baseDir:string}|null}
 */
export function resolveAtlasScopeDir(root, scope, { env = process.env, configDir } = {}) {
  const norm = normalizeAtlasScope(scope)
  if (!norm) return null
  const base = resolveAtlasDir(root, { env, configDir })
  const key = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12)
  return {
    dir: path.join(base.dir, 'scopes', key),
    mode: 'scope',
    workspaceId: base.workspaceId,
    scope: norm,
    baseDir: base.dir,
  }
}

/**
 * 测试文件判定。`cfg.testPatterns` 是用户补充的正则（按工作区相对路径匹配）；
 * 默认规则覆盖 JS/TS、Python、Go、Rust、Ruby 与 C/C++ 的常见后缀，以及 tests/ 目录。
 * @param {string} rel
 * @param {{testPatterns?:string[]}|null} [cfg]
 */
export function isTestPath(rel, cfg = null) {
  const p = String(rel).replace(/\\/g, '/')
  const base = path.posix.basename(p)
  for (const pattern of (cfg?.testPatterns || [])) {
    try { if (new RegExp(pattern).test(p)) return true } catch { /* 用户正则坏了不阻断扫描 */ }
  }
  return TEST_RE.test(base) || TEST_PREFIX_RE.test(base) ||
    TEST_SUFFIX_RE.test(base) || TEST_CLASS_RE.test(base) || TEST_DIR_RE.test(p)
}

/** 文件分类：test 优先于 code；office/image 归 doc（只建元数据卡）。 */
export function fileKind(rel, cfg = null) {
  const ext = path.posix.extname(rel).toLowerCase()
  if (isTestPath(rel, cfg)) return 'test'
  if (CODE_EXT.has(ext)) return 'code'
  if (DOC_EXT.has(ext)) return 'doc'
  if (OFFICE_EXT.has(ext)) return 'doc'
  if (IMAGE_EXT.has(ext)) return 'doc'
  if (CONFIG_EXT.has(ext)) return 'file'
  return 'file'
}

export function isOfficePath(rel) {
  return OFFICE_EXT.has(path.posix.extname(rel).toLowerCase())
}

export function isImagePath(rel) {
  return IMAGE_EXT.has(path.posix.extname(rel).toLowerCase())
}

export function isTextDocPath(rel) {
  return DOC_EXT.has(path.posix.extname(rel).toLowerCase())
}

/** 兼容 `*.min.*`、`**` 与目录前缀的极简匹配；不引入 glob 依赖。 */
function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++ } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

function matchesUserExclude(rel, pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p) return false
  if (p.endsWith('/')) return rel === p.slice(0, -1) || rel.startsWith(p)
  if (p.includes('*') || p.includes('?')) return globToRegExp(p).test(rel)
  return rel === p || rel.startsWith(p + '/')
}

/**
 * 判断一个工作区相对路径是否被排除。返回 null（不排除）或排除规则名。
 * 排除项由 scan 汇总进 meta.excluded，不静默丢弃（spec §5.4）。
 */
export function exclusionReason(rel, cfg) {
  const seg = rel.split('/')
  const base = seg[seg.length - 1]
  const lower = base.toLowerCase()
  const ext = path.posix.extname(base).toLowerCase()

  for (const s of seg.slice(0, -1)) if (SKIP_ANY_DIR.has(s)) return 'skip-dir'
  if (SKIP_TOP_DIR.has(seg[0])) return 'skip-top-dir'
  if (base === '.DS_Store' || lower === 'thumbs.db') return 'system-file'
  // Office 打开文档时生成的锁文件（Word/Excel/PowerPoint `~$*`，LibreOffice `.~*`）。
  // 它们不是业务文档，且 xlsx 锁文件不是合法 ZIP，正文解析必然失败。
  if (base.startsWith('~$') || base.startsWith('.~')) return 'system-file'
  if (base === '.env' || lower.startsWith('.env.')) return 'env'
  if (SECRET_EXT.has(ext)) return 'secret'
  if (LOCK_FILES.has(lower)) return 'lockfile'
  if (/\.min\.[a-z0-9]+$/i.test(base)) return 'minified'
  if (lower.endsWith('.map')) return 'sourcemap'
  if (lower.endsWith('.log')) return 'log'
  if (DOC_ARCHIVE_PREFIXES.some((p) => rel.startsWith(p))) return 'doc-archive'
  for (const p of cfg.exclude) if (matchesUserExclude(rel, p)) return 'user-exclude'
  return null
}

function layerOf(rel, cfg) {
  const seg = rel.split('/')
  const layers = cfg.layers || DEFAULT_LAYERS
  for (const layer of layers) {
    if (layer.dirs.includes(seg[0])) return layer.id
  }
  // 未登记的顶层目录不做“root 大杂烩”：顶层目录名本身就是最粗的结构层，
  // 对 packages/、apps/、examples/ 这类通用布局比 hardcode 名单更诚实。
  return seg.length > 1 ? seg[0] : 'root'
}

/**
 * 域归属：显式 `atlas.config.json#domains` 优先；否则按目录启发式。
 * 规则刻意通用（不依赖 Ponos 的 DOMAINS 表）：优先级形如
 *   src/components/<x> → src/components/<x>
 *   <top>/<sub>/...    → <top>/<sub>
 *   <top>/<file>       → <top>
 *   根级文件            → root
 */
export function domainOf(rel, cfg = {}, workspace = null) {
  for (const d of (cfg.domains || [])) {
    if (d.files && (d.files.includes(rel) || d.files.includes(path.posix.basename(rel)))) return d.id
    if (d.dirs && d.dirs.some((dir) => rel === dir || rel.startsWith(dir.replace(/\/+$/, '') + '/'))) return d.id
    if (d.match) {
      try { if (new RegExp(d.match).test(rel)) return d.id } catch { /* 用户正则坏了不阻断构建 */ }
    }
  }
  // workspace 包边界优先于目录启发式：`packages/session-backends/sqlite-node` 是
  // 一个完整域，不能被压成 `packages/session-backends`。
  const pkg = workspace?.packageOfPath?.(rel)
  if (pkg && pkg.dir) return pkg.dir
  const seg = rel.split('/')
  if (seg.length === 1) return 'root'
  if (seg[0] === 'src' && seg[1] === 'components' && seg.length >= 4) return seg.slice(0, 3).join('/')
  if (seg.length >= 3) return seg.slice(0, 2).join('/')
  return seg[0]
}

export function domainName(id, cfg = {}, workspace = null) {
  const hit = (cfg.domains || []).find((d) => d.id === id)
  if (hit) return hit.name
  const pkg = workspace?.byDir?.get?.(id)
  if (pkg) return pkg.name
  if (id === 'root') return '根级文件'
  return id
}

export function layerInfo(rel, cfg = {}) {
  return layerOf(rel, cfg)
}

export function detectDesign(root) {
  const markers = [
    path.join(root, 'design', 'tokens', 'tokens.json'),
    path.join(root, 'tokens.json'),
  ]
  if (markers.some((p) => fs.existsSync(p))) return 'present'
  return 'none'
}

/** 文档范围：所有文本类文档；office/pdf 也可建元数据卡。图片只作为 noText 清单项。 */
export function isDocCandidate(rel, cfg = {}) {
  if (cfg.docs.some((p) => matchesUserExclude(rel, p))) return true
  const ext = path.posix.extname(rel).toLowerCase()
  if (DOC_EXT.has(ext) || OFFICE_EXT.has(ext)) return true
  if (/^readme(\.[a-z0-9]+)?$/i.test(path.posix.basename(rel))) return true
  if (IMAGE_EXT.has(ext)) {
    // 图片不是代码关系的主角；只在明确的文档目录里进清单，避免 public/ 图标淹没 L1。
    return rel.startsWith('docs/') || rel.startsWith('design/') ||
      rel.startsWith('需求问题体系/') || cfg.docs.some((p) => rel.startsWith(p.replace(/\/+$/, '') + '/'))
  }
  return false
}
