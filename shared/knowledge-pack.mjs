// shared/knowledge-pack.mjs —— 知识包清单/元数据校验与版本判定（纯函数，无 IO）
// ---------------------------------------------------------------------------
// 为什么放 shared 而不是 server：这里是**判定规则**（净化/上限/兼容性），不碰文件系统，
// 既给 server 侧安装器用，也是 S1 内核 `discoverSpaces` 读取 `pack.json` 的同族逻辑——
// 放中性层可以双端共用同一份规则，避免"server 校验一套、kernel 发现一套"的漂移。
//
// 三个不变量（本模块的职责）：
//   ① **什么都不信输入**：包内条目名、`pack.json` 的每个字段都当不可信数据；
//   ② **白名单 + 黑名单双保险**：扩展名先过显式白名单，命中可执行/脚本黑名单时给更具体的错；
//   ③ **校验失败返回结构化结果，不抛**：错误文案要能原样展示给用户（安装是用户点出来的操作）。
import { resolve, sep, extname, basename } from 'node:path'
import { createHash } from 'node:crypto'

/** 包 id：小写字母/数字/连字符，首字符必须字母或数字（对齐 spec §2.1，也是目录名的净化规则） */
export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 空间 id 前缀（S1 契约：`kernel/knowledge.mjs` 的 `id: 'pack-' + 目录名`） */
export const packSpaceId = (id) => `pack-${id}`

/**
 * 体积/条目上限（spec §6，可被调用方覆盖）。
 * `maxEntries` 是**含目录条目**的总数：只限"文件数"挡不住十万个空目录条目。
 */
export const PACK_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFiles: 2000,
  maxEntries: 4000,
}

/** 允许的扩展名白名单：文档 + 纯数据资产（spec §10 D4 = 允许非 md 附件） */
export const ALLOWED_EXTS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',          // 图片（含 svg 见下方说明）
  '.pdf', '.svg',
])

/**
 * 明确拒绝的可执行/脚本类扩展名。
 * 这条是"内容包无代码执行面"这一安全模型（spec §1）的**前提**：一旦允许 .js/.exe 落进
 * 用户目录，用户或模型后续都可能去执行它，模型即失效。故这里逐一列出**具体原因**，
 * 而不是靠"不在白名单里"泛泛拒绝——用户收到的应是"包内含可执行文件 X"。
 */
export const DENIED_CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.coffee',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.com', '.msi', '.scr', '.app', '.apk',
  '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.wsf', '.wsh', '.hta', '.jar', '.class', '.war',
  '.sh', '.bash', '.zsh', '.fish', '.py', '.pyc', '.rb', '.pl', '.php', '.lua',
  '.lnk', '.url', '.reg', '.deb', '.rpm', '.dmg', '.iso',
  '.html', '.htm', '.xhtml',       // 可内联脚本；渲染走 react-markdown，故无正当用途
])

/** 文本类扩展名：内容哈希前先做行尾归一（跨平台重装不把 CRLF/LF 差异误判成"用户改过"） */
export const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.svg'])

// Windows 保留设备名：写到用户目录上会失败或被系统"吃掉"，属跨平台陷阱，直接拒
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 条目名净化（穿越防护的第 ①② 道；③ resolve 断言在 `isInsideRoot`，④ realpath 在调用方）。
 * 只做**纯字符串**判定，不碰磁盘——调用方在解压每个条目**之前**调它。
 * 返回 `{ ok: true, path }`（已归一为 `/` 分隔）或 `{ ok: false, error }`。
 */
export function sanitizePackEntryPath(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/')
  if (!s) return { ok: false, error: '空条目名' }
  if (s.startsWith('/') || s.startsWith('//')) return { ok: false, error: `条目名是绝对路径：${s}` }
  if (/^[a-zA-Z]:/.test(s)) return { ok: false, error: `条目名含盘符：${s}` }
  if (s.includes('\0')) return { ok: false, error: '条目名含 NUL 字符' }
  if (s.length > 255) return { ok: false, error: `条目名过长（${s.length} 字符）：${s.slice(0, 60)}…` }
  const parts = s.split('/')
  for (const part of parts) {
    if (!part) return { ok: false, error: `条目名含空路径段：${s}` }
    if (part === '.' || part === '..') return { ok: false, error: `条目名含上跳路径段：${s}` }
    if (part.length > 120) return { ok: false, error: `路径段过长：${part.slice(0, 40)}…` }
    // 末尾空格/点在 Windows 上会被静默剥离 → 两个不同名字可能落到同一文件，属歧义输入
    if (/[ .]$/.test(part)) return { ok: false, error: `路径段以空格或点结尾：${part}` }
    if (WIN_RESERVED_RE.test(part)) return { ok: false, error: `路径段是 Windows 保留设备名：${part}` }
  }
  return { ok: true, path: parts.join('/') }
}

/**
 * 条目分类：文档 / 资产（允许）或拒绝（带具体原因）。
 * 目录条目（以 `/` 结尾）由调用方先行跳过，不进这里。
 */
export function classifyPackEntry(rel) {
  const ext = extname(rel).toLowerCase()
  if (DENIED_CODE_EXTS.has(ext)) {
    return { ok: false, error: `知识包不得含可执行/脚本文件：${rel}` }
  }
  if (!ext) return { ok: false, error: `条目缺少扩展名（无法判定类型）：${rel}` }
  if (!ALLOWED_EXTS.has(ext)) {
    return { ok: false, error: `不支持的条目类型 ${ext}：${rel}（仅允许 md 与图片/PDF/CSV 等纯数据资产）` }
  }
  return { ok: true, kind: ext === '.md' || ext === '.markdown' ? 'doc' : 'asset' }
}

/** 第 ③ 道防护（字符串层）：`resolve` 之后的绝对路径是否仍在根内。 */
export function isInsideRoot(root, abs) {
  const r = resolve(String(root || ''))
  const a = resolve(String(abs || ''))
  return a === r || a.startsWith(r + sep)
}

/** 内容指纹（sha256 前 16 位，非密码用途，只判漂移）。文本类先归一 CRLF——与 `skill-install.mjs` 同基准。 */
export function hashContent(buf, { name = '' } = {}) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')
  const isText = TEXT_EXTS.has(extname(String(name)).toLowerCase())
  const h = createHash('sha256')
  h.update(isText ? Buffer.from(raw.toString('utf-8').replace(/\r\n/g, '\n'), 'utf-8') : raw)
  return h.digest('hex').slice(0, 16)
}

/** semver 解析：`1.2` / `1.2.3` / `1.2.3-beta.1` 都可；不合规返回 null（不做容错猜测） */
export function parseSemver(v) {
  // 严格三段：`1.2` 不是 semver。容错解析会让"包作者写错版本号"变成静默的半兼容判定，
  // 而在"版本决定装不装"这条路径上，宁可拒（错误文案明确）也不要猜。
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' }
}

/** 比较：a < b 返 -1，相等 0，a > b 返 1；任一不可解析返回 null（调用方据此判"未知版本"）。 */
export function compareSemver(a, b) {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) return null
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  // 预发布版 < 正式版（1.2.3-beta < 1.2.3），与 semver 规范一致
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/**
 * 从任意版本串里抽出 semver 数字部分：仓库的 `version.mjs` 里 `APP_VERSION = 'dev 3.0.0'`，
 * 直接拿去做兼容判定会解析失败 → 全部包被误判成"需要更高版本应用"。故在此收敛一次。
 */
export function normalizeAppVersion(v) {
  const m = /(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/.exec(String(v ?? ''))
  return m ? m[1] : ''
}

/** 当前 App 是否满足包要求的最低版本。`minAppVersion` 缺失 = 不限制。 */
export function satisfiesMinApp(minAppVersion, appVersion) {
  if (!minAppVersion) return true
  const min = parseSemver(minAppVersion)
  const cur = parseSemver(normalizeAppVersion(appVersion))
  if (!min) return false          // 包自己写了非法版本号 → 由 manifest 校验拦，此处保守判 false
  if (!cur) return true           // 应用版本不可解析时不拦（宁可不装错，也不要因版本串形态挡住全部安装）
  // 注意传**字符串**：compareSemver 内部自己解析，传已解析对象会拿到 null（曾因此恒判不兼容）
  return (compareSemver(normalizeAppVersion(appVersion), minAppVersion) ?? -1) >= 0
}

/**
 * 版本决策（对齐 spec §2.3 的 Obsidian 同构规则）：
 *   自身 `minAppVersion` 满足      → 用 `pack.json` 的 version
 *   不满足但 `versions.json` 有可用的 → 取"满足当前 App 的最高包版本"回退
 *   都没有                          → `needs-higher-app`（明确提示，**不安装**）
 */
export function resolvePackVersion({ manifestVersion, minAppVersion = '', appVersion = '', versions = null } = {}) {
  if (satisfiesMinApp(minAppVersion, appVersion)) {
    return { ok: true, version: String(manifestVersion || ''), reason: 'current' }
  }
  const map = versions && typeof versions === 'object' ? versions : {}
  const usable = Object.entries(map)
    .filter(([pv, reqApp]) => parseSemver(pv) && satisfiesMinApp(String(reqApp), appVersion))
    .map(([pv]) => pv)
    .sort((a, b) => (compareSemver(b, a) ?? 0))
  if (usable.length) return { ok: true, version: usable[0], reason: 'fallback' }
  return {
    ok: false,
    reason: 'needs-higher-app',
    requiredMin: String(minAppVersion),
    appVersion: String(appVersion),
    error: `该知识包需要应用版本 ≥ ${minAppVersion}（当前 ${appVersion || '未知'}），且没有可回退的兼容版本`,
  }
}

/**
 * `pack.json` 校验。返回 `{ ok, errors, warnings, pack }`（**不抛**）。
 * 与 S1 内核读 `pack.json` 的字段严格对齐：`kernel/knowledge.mjs:80` 只认
 * `{ name, description, version, source }`，多空间包（`spaces[]`）内核不支持 → 只作警告忽略。
 */
export function validatePackManifest(json, { expectId = null, appVersion = '', versions = null } = {}) {
  const errors = []
  const warnings = []
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, errors: ['pack.json 不是 JSON 对象'], warnings, pack: null }
  }
  const str = (v) => (typeof v === 'string' ? v.trim() : '')

  const id = str(json.id)
  if (!id) errors.push('pack.json 缺少 id')
  else if (!PACK_ID_RE.test(id)) errors.push(`id「${id}」不合法（仅小写字母/数字/连字符，首字符非连字符，≤64）`)
  if (expectId && id && id !== expectId) errors.push(`pack.json 的 id「${id}」与安装目标「${expectId}」不一致`)

  const name = str(json.name)
  if (!name) errors.push('pack.json 缺少 name')
  else if (name.length > 80) errors.push('name 过长（>80 字符）')

  const version = str(json.version)
  if (!version) errors.push('pack.json 缺少 version')
  else if (!parseSemver(version)) errors.push(`version「${version}」不是合法 semver`)

  // license 是**硬失败**（spec §6：无 license 的包拒绝安装；装完再展示等于已经落盘了）
  const license = str(json.license)
  if (!license) errors.push('pack.json 缺少 license（许可证是安装前的必展示项，无 license 一律拒绝安装）')

  const minAppVersion = str(json.minAppVersion)
  if (minAppVersion && !parseSemver(minAppVersion)) {
    errors.push(`minAppVersion「${minAppVersion}」不是合法 semver`)
  }

  const source = str(json.source)
  if (!source) {
    errors.push('pack.json 缺少 source（包内空间根目录，形如 "content"）')
  } else if (source === '.' || source === './') {
    // 先于净化判定：净化会把 '.' 报成"上跳路径段"，而这里的真实问题是"空间根 = 包根"
    errors.push('source 不得为 "."（会把 pack.json/README.md 收进空间文档）')
  } else {
    const sp = sanitizePackEntryPath(source)
    if (!sp.ok) errors.push(`source 不合法：${sp.error}`)
    else if (sp.path === '.') {
      // 内核以 `join(包目录, source)` 为空间根；`. ` 会让 pack.json / README.md 被 walkMd
      // 当成文档收进空间（实测 walkMd 收包根下所有 .md）→ 文档数与检索结果都被污染
      errors.push('source 不得为 "."（会把 pack.json/README.md 收进空间文档）')
    } else if (sp.path !== source) {
      errors.push(`source 形态不规范：应写成包内相对路径如「content」，实得「${source}」`)
    }
  }

  if (json.spaces !== undefined) {
    warnings.push('spaces[] 字段被忽略：内核只支持单空间包（一个包 = 一个只读空间）')
  }
  const tags = Array.isArray(json.tags) ? json.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 12) : []
  if (Array.isArray(json.tags) && json.tags.length > 12) warnings.push('tags 超过 12 个，已截断')

  const pack = {
    id, name, version, license, source,
    minAppVersion,
    description: str(json.description),
    author: str(json.author),
    homepage: str(json.homepage),
    tags,
  }
  if (errors.length) return { ok: false, errors, warnings, pack: null }

  // 版本兼容性一并给出（调用方据此决定装哪个版本，或直接提示"需要更高版本应用"）
  const resolved = resolvePackVersion({ manifestVersion: version, minAppVersion, appVersion, versions })
  if (!resolved.ok) {
    return { ok: false, errors: [resolved.error], warnings, pack: null, version: resolved }
  }
  return { ok: true, errors, warnings, pack, version: resolved }
}

/** 清单条目片段（spec §5 第 3 步：可直接粘进中央清单的 JSON 对象） */
export function buildManifestEntry({
  id, name, description = '', author = '', repo = '', tags = [], docCount = 0, sizeBytes = 0,
} = {}) {
  const out = {
    id: String(id || ''),
    name: String(name || ''),
    description: String(description || ''),
    author: String(author || ''),
    repo: String(repo || ''),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    docCount: Number(docCount) || 0,
    sizeBytes: Number(sizeBytes) || 0,
  }
  return out
}

/** 包内 README 模板（导出时生成；也是"包自述"的唯一位置） */
export function buildPackReadme({ name = '', description = '', version = '', license = '', author = '', docCount = 0 } = {}) {
  return [
    `# ${name || '知识包'}`,
    '',
    description || '（请补充知识包简介：覆盖的政策/文档范围与适用场景）',
    '',
    '## 元信息',
    '',
    `- 版本：${version || '（待填）'}`,
    `- 许可证：${license || '（待填，必填）'}`,
    `- 作者：${author || '（待填）'}`,
    `- 文档数：${docCount}`,
    '',
    '## 内容说明',
    '',
    '本包内容为 Markdown 文档（可含图片/PDF 等纯数据附件），**不含任何可执行文件**。',
    '安装后以只读空间挂载，卸载即删除目录，不会写入你的个人空间。',
    '',
  ].join('\n')
}

/** 安装台账条目（与 `server/skill-install.mjs` 的 `manifest.files` 同构，便于复用同一套判据） */
export function buildLedgerEntry({ id, version, files = {}, installedAt = '', updatedAt = '', backupPath = null, source = 'offline' } = {}) {
  return {
    id: String(id || ''),
    version: String(version || ''),
    spaceId: packSpaceId(String(id || '')),
    files: { ...files },
    installedAt: installedAt || new Date().toISOString(),
    updatedAt: updatedAt || new Date().toISOString(),
    backupPath: backupPath || null,
    source: String(source || 'offline'),
  }
}

/** 台账/磁盘路径拼装（纯字符串；调用方保证 base 是绝对路径） */
export function packFileKey(packId, relPath) {
  return `${packId}/${sanitizePackEntryPath(relPath).path || String(relPath)}`
}

/** 空间名回退：pack.json 缺 name 时用目录名（内核 discoverSpaces 同款回退） */
export function packDisplayName(pack, fallbackId = '') {
  return (pack && pack.name) || basename(String(fallbackId)) || '知识包'
}
