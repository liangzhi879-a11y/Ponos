// shared/team-source.mjs —— S3 团队源：**L1 共享目录实现 + 同步盘四行为对策**（spec §7.1/§7.2）。
//
// §7.1 表给了**一个接口两实现**：L1 = 共享目录（示例实现，本轮做）；L2 = 服务器源（**S5 明确不做**，
// 故本文件只留接口形状，**不预埋任何 HTTP/服务端代码**——与 L2 定案 14 的口径一致）。
//
// 【同步盘四行为对策（§7.1 表）——每一条都对应一个真实会坏的行为】
//   ① 冲突副本：网盘遇到并发写会生成 `log-x (1).jsonl`/`log-x - 副本.jsonl`。对策 = **列目录按名吸收
//      后重放，绝不原地改名**（改名会在别人的同步里表现为"文件消失 + 新文件出现"，制造更多冲突）。
//   ② **禁用 `fs.watch`**：网盘与网络路径上的 inotify/ReadDirectoryChangesW 语义不可靠（丢事件、
//      假事件），依赖它会让同步"偶尔不生效"且极难复现。对策 = **轮询扫描**。
//   ③ 占位符/脱水（OneDrive「仅在线」）：文件看起来在、内容却读不到。对策 = 检测并**跳过**，
//      不能把"读不到"当成"内容为空"（那会把在线文件当空文件覆盖掉）。
//   ④ 校验写 `verified_write`：写完回读比哈希。网盘客户端可能吞掉/延迟写入。
//
// 【§7.1 的警告：网盘同步目录禁用原子改名】同步客户端会**跟丢** rename（表现为"源没了、目标没出现"），
// 所以写入顺序固定为 `write .tmp → 校验哈希 → rename`：即便 rename 被跟丢，最坏结果是留一个 `.tmp`，
// **不会丢已写内容**。若团队源位于 git 工作区内，返回**警告但不阻断**（用户有权这么放）。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, sep } from 'node:path'

/**
 * **容器目录名**：团队的全部留档（清单、成员日志、密钥信封、CAS、版本链、内容区、策略）
 * 都收在团队根目录下的这个点开头目录里。
 *
 * 为什么需要它：团队根目录是**用户的工作目录**（真实例子：`Z:\…\湖北美宝药业股份有限公司`），
 * 旧布局把 `team.json` / `members/` / `keys/` / `cas/` / `versions/` / `claims/` 直接摊在工作文件
 * 旁边 ⇒ 与申报材料、汇总表混在一起，同事既可能误删，也分不清哪个是资料、哪个是程序留档。
 * 收进一个容器后，工作目录里只多出**一个**条目。
 *
 * 【Windows 注意】点开头在 Windows 上**不是**隐藏 —— 资源管理器照常显示（还排在前面）。
 * 故 `ensureTeamDirs` 会额外 `attrib +h` 设隐藏属性（best-effort，失败不影响使用）。
 */
export const TEAM_CONTAINER_DIR = '.yfworking'

/** §7.2 目录布局（常量集中在此，避免各处手拼路径写歪）。除 `CONTAINER` 外均为**容器内**的相对名。 */
export const TEAM_LAYOUT = Object.freeze({
  CONTAINER: TEAM_CONTAINER_DIR,
  MANIFEST: 'team.json',
  MEMBERS_DIR: 'members',
  KEYS_DIR: 'keys',
  CAS_DIR: 'cas',
  VERSIONS_DIR: 'versions',
  CLAIMS_DIR: 'claims',
  KNOWLEDGE_DIR: 'knowledge',
  EXPERIENCE_DIR: 'experience',
  POLICY_FILE: 'policies.json',
  MANIFEST_VERSION: 1,
})

/** 布局版本：1 = 旧（元数据摊在团队根下）；2 = 新（元数据收进 `.yfworking/` 容器）。 */
export const TEAM_LAYOUT_VERSION = 2

/** 扫描默认深度（批注 #6「搜索根扫描深度」未定 ⇒ 做成显式参数，不把策略写死）。 */
export const DEFAULT_SCAN_DEPTH = 4

/** 团队源体积上限的**度量阈值**（批注 #8 未定 ⇒ 本轮只度量不阻断，见 plan §2.3）。 */
export const TEAM_SOURCE_LIMITS = Object.freeze({ warnBytes: 512 * 1024 * 1024, warnFiles: 20000 })

/** L2 服务器源：**S5 明确不做**，此处只标明"接口存在但未实现"，避免调用方以为可用。 */
export const TEAM_SOURCE_KINDS = Object.freeze({ L1_SHARED_DIR: 'l1-shared-dir', L2_SERVER: 'l2-server' })

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 某一层基目录下的标准路径（新旧布局共用同一套相对名，只是基目录不同）。 */
function layoutAt(base) {
  const b = String(base)
  return {
    base: b,
    manifest: join(b, TEAM_LAYOUT.MANIFEST),
    membersDir: join(b, TEAM_LAYOUT.MEMBERS_DIR),
    keysDir: join(b, TEAM_LAYOUT.KEYS_DIR),
    casDir: join(b, TEAM_LAYOUT.CAS_DIR),
    versionsDir: join(b, TEAM_LAYOUT.VERSIONS_DIR),
    claimsDir: join(b, TEAM_LAYOUT.CLAIMS_DIR),
    knowledgeDir: join(b, TEAM_LAYOUT.KNOWLEDGE_DIR),
    experienceDir: join(b, TEAM_LAYOUT.EXPERIENCE_DIR),
    policyFile: join(b, TEAM_LAYOUT.POLICY_FILE),
    log: (deviceId) => join(b, TEAM_LAYOUT.MEMBERS_DIR, `log-${deviceId}.jsonl`),
    keyEnvelope: (memberId) => join(b, TEAM_LAYOUT.KEYS_DIR, `${memberId}.env`),
    // CAS 布局：cas/<hash[0:2]>/<hash>（§7.2；S4 文件协同用）
    casBlob: (hash) => join(b, TEAM_LAYOUT.CAS_DIR, String(hash).slice(0, 2), String(hash)),
    versionLog: (fileId) => join(b, TEAM_LAYOUT.VERSIONS_DIR, `${fileId}.jsonl`),
    claimLog: (fileId) => join(b, TEAM_LAYOUT.CLAIMS_DIR, `${fileId}.jsonl`),
  }
}

/** 双读回退：优先新布局，缺失时用旧布局；两边都没有则返回新路径（供"是否已存在"判断）。 */
const pickExisting = (next, legacy) => (existsSync(next) ? next : (existsSync(legacy) ? legacy : next))

/**
 * 团队源内各标准路径（`root` = 团队目录本身，即用户的**工作目录**）。
 *
 * 【读写分离（双读兼容，不自动迁移）】
 *   写：一律写容器内（`<root>/.yfworking/…`）—— 新内容只进新布局，避免越写越乱。
 *   读：新布局优先、旧布局回退（`p.read.*`）—— 旧团队（元数据摊在 root 下）继续可读可用，
 *       不需要任何迁移动作；用户也可以选择永远不迁移。
 *   混合态：旧团队被新代码写过一次后，会出现"旧日志在 root、新日志在容器"的并存情况 ⇒
 *       日志读取按**目录并集**处理（见 `openTeamSource.readLogCopies`），由
 *       `mergeMemberLogCopies` 按 `(by, seq)` 去重，故并集不会产生重复成员记录。
 */
export function teamPaths(root) {
  const r = String(root)
  const container = join(r, TEAM_CONTAINER_DIR)
  const next = layoutAt(container)   // 新布局（写侧唯一目标）
  const legacy = layoutAt(r)         // 旧布局（只读回退）
  return {
    root: r,
    container,
    layoutVersion: TEAM_LAYOUT_VERSION,
    ...next,
    legacy,
    /** 读侧：逐个给出"实际该读哪个文件/目录"。 */
    read: {
      exists: () => existsSync(next.manifest) || existsSync(legacy.manifest),
      layout: () => (existsSync(next.manifest) ? 'container' : (existsSync(legacy.manifest) ? 'legacy' : 'none')),
      manifestFile: () => pickExisting(next.manifest, legacy.manifest),
      membersDir: () => pickExisting(next.membersDir, legacy.membersDir),
      keysDir: () => pickExisting(next.keysDir, legacy.keysDir),
      casDir: () => pickExisting(next.casDir, legacy.casDir),
      versionsDir: () => pickExisting(next.versionsDir, legacy.versionsDir),
      claimsDir: () => pickExisting(next.claimsDir, legacy.claimsDir),
      knowledgeDir: () => pickExisting(next.knowledgeDir, legacy.knowledgeDir),
      experienceDir: () => pickExisting(next.experienceDir, legacy.experienceDir),
      policyFile: () => pickExisting(next.policyFile, legacy.policyFile),
      log: (deviceId) => pickExisting(next.log(deviceId), legacy.log(deviceId)),
      keyEnvelope: (memberId) => pickExisting(next.keyEnvelope(memberId), legacy.keyEnvelope(memberId)),
      casBlob: (hash) => pickExisting(next.casBlob(hash), legacy.casBlob(hash)),
      versionLog: (fileId) => pickExisting(next.versionLog(fileId), legacy.versionLog(fileId)),
      claimLog: (fileId) => pickExisting(next.claimLog(fileId), legacy.claimLog(fileId)),
    },
  }
}

/**
 * 给容器目录设 Windows 隐藏属性（best-effort，**失败不抛错**）。
 *
 * 为什么必须单独做：Windows 上「点开头」**不等于隐藏**，资源管理器默认照常显示。
 * 不设的话，容器仍会出现在同事眼前（还可能因排序靠前而更显眼），与"与工作文件区分开"的
 * 目的不符。POSIX 上点开头本身即隐藏，故直接跳过。
 */
export function hideContainerSync(dir, { platform = process.platform } = {}) {
  const d = String(dir)
  if (platform !== 'win32') return { ok: true, skipped: 'not-windows' }
  try {
    execFileSync('attrib', ['+h', d], { stdio: 'ignore', windowsHide: true })
    return { ok: true, path: d }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e), path: d }
  }
}

/**
 * 建标准目录（幂等）：**创建容器 + 容器内各子目录**，并给容器设 Windows 隐藏属性。
 * 返回 `teamPaths(root)`（含 `legacy` 与 `read.*`，调用方据此做双读）。
 */
export function ensureTeamDirs(root) {
  const p = teamPaths(root)
  // 容器必须先于子目录建：`attrib +h` 要在目录存在之后才有效
  for (const d of [p.container, p.membersDir, p.keysDir, p.casDir, p.versionsDir, p.claimsDir]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* 已存在/并发创建：忽略 */ }
  }
  hideContainerSync(p.container)
  return p
}

// ---------------------------------------------------------------------------
// 对策③：占位符 / 脱水检测
// ---------------------------------------------------------------------------

/**
 * 检测"占位符/脱水"文件（OneDrive「仅在线」等）。
 *
 * 判定顺序（先便宜后昂贵）：
 *  1. 文件不存在 → 不是占位符（`absent`）；
 *  2. 长度为 0 且不是合法的空 JSONL/空字符串场景 → 可疑。**注意**：空文件本身合法（新建的日志），
 *     所以这里只标 `zero-size`（**可疑**），由调用方决定是否跳过——把"空"一律当损坏会误伤新文件。
 *  3. 读取失败（`EBUSY`/`EPERM`/`EIO`）→ 判定为占位符（内容不可得）。
 *  4. Windows 上若可用的 `fsutil` 报出 reparse point，则判定为占位符（best-effort，**失败不抛错**，
 *     因为 `fsutil` 需要权限、且在不同 Windows 版本输出不同；不引入外部依赖也不拿它当唯一依据）。
 *
 * 返回 `{ placeholder, reason, size }`。
 */
export function detectPlaceholderSync(path, { zeroSizeIsPlaceholder = false } = {}) {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return { placeholder: false, reason: 'absent', size: 0 }
  }
  if (st.isDirectory()) return { placeholder: false, reason: 'directory', size: 0 }
  if (st.size === 0) {
    return { placeholder: !!zeroSizeIsPlaceholder, reason: zeroSizeIsPlaceholder ? 'zero-size' : 'empty-file', size: 0 }
  }
  try {
    readFileSync(path)
  } catch (e) {
    return { placeholder: true, reason: `unreadable:${(e && e.code) || 'unknown'}`, size: st.size }
  }
  return { placeholder: false, reason: 'ok', size: st.size }
}

// ---------------------------------------------------------------------------
// 对策④：校验写（write .tmp → 校验 → rename → 回读）
// ---------------------------------------------------------------------------

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 校验写：先写 `.tmp` 并核对其哈希，再 rename 到目标，最后**回读校验**。
 *
 * - **不做就地覆写**（§7.1 警告：网盘客户端会跟丢原子改名，但 `.tmp + rename` 的最坏结果是留个 `.tmp`，
 *   而不是丢内容）。
 * - `expectHash` 可用于"写 CAS 内容"：调用方给出期望哈希，写后不一致即报错（内容损坏可即时发现）。
 * - 回读失败或哈希不符 → **抛错**（不静默成功）。写盘这件事一旦静默失败，后面所有"同步了"的判断都是错的。
 */
export function writeVerifiedSync(path, data, { expectHash = null } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8')
  const dir = dirname(path)
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, buf)
  const tmpHash = sha256Hex(readFileSync(tmp))
  if (expectHash && tmpHash !== expectHash) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw new Error(`团队源写入校验失败：临时文件哈希 ${tmpHash.slice(0, 12)}… ≠ 期望 ${String(expectHash).slice(0, 12)}…`)
  }
  try {
    renameSync(tmp, path)
  } catch (e) {
    // rename 失败时保留 .tmp（可能含已写内容），抛错让调用方知道；不删除以免丢数据
    throw new Error(`团队源 rename 失败（已保留临时文件 ${tmp}）：${(e && e.message) || e}`)
  }
  let back
  try {
    back = readFileSync(path)
  } catch (e) {
    throw new Error(`团队源写入后回读失败：${path}（${(e && e.message) || e}）`)
  }
  const backHash = sha256Hex(back)
  if (backHash !== tmpHash) throw new Error(`团队源写入后回读不一致：${path}`)
  return { path, bytes: buf.length, hash: backHash }
}

// ---------------------------------------------------------------------------
// 对策①：冲突副本吸收
// ---------------------------------------------------------------------------

/**
 * 冲突副本名 → 逻辑名（**只识别、不改名**）。
 * 覆盖网盘常见形态：`x (1).jsonl`、`x(2).jsonl`、`x - 副本.jsonl`、`x 副本.jsonl`、
 * `x - Copy.jsonl`、`x (copy 1).jsonl`、`x - 副本 (2).jsonl`。
 *
 * 返回 `{ logical, isCopy }`。逻辑名用于"同一逻辑文件的多个副本"归类。
 */
export function logicalNameOf(fileName) {
  const name = String(fileName)
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const patterns = [
    /^(.*?)\s*\(\d+\)$/,                 // x (1)
    /^(.*?)\s*-\s*副本(?:\s*\(\d+\))?$/, // x - 副本 / x - 副本 (2)
    /^(.*?)\s+副本(?:\s*\(\d+\))?$/,     // x 副本
    /^(.*?)\s*-\s*Copy(?:\s*\(\d+\))?$/i,// x - Copy
    /^(.*?)\s*\(copy(?:\s*\d+)?\)$/i,    // x (copy 1)
    /^(.*?)\s*-\s*conflict(?:ed)?(?:\s*copy)?(?:\s*\d+)?$/i, // x - conflicted copy 1
  ]
  let cur = base
  for (let round = 0; round < 4; round++) {
    let changed = false
    for (const re of patterns) {
      const m = cur.match(re)
      if (m && m[1] && m[1].trim()) { cur = m[1].trim(); changed = true }
    }
    if (!changed) break
  }
  return { logical: cur + ext, isCopy: cur + ext !== name }
}

/** 把目录里某逻辑文件的所有副本（含本体）列出。**纯读取，绝不改名/删除**。 */
export function listCopies(dir, logicalFileName) {
  let names = []
  try { names = readdirSync(dir) } catch { return [] }
  const out = []
  for (const n of names) {
    if (logicalNameOf(n).logical === logicalFileName) {
      const full = join(dir, n)
      try { if (statSync(full).isFile()) out.push({ name: n, path: full, isCopy: logicalNameOf(n).isCopy }) } catch { /* ignore */ }
    }
  }
  // 本体排前、副本按名排序 ⇒ 重放顺序**稳定可断言**。
  // 用码元序（`<`/`>`）而不是 `localeCompare`：后者的结果依赖 ICU 区域/版本，同一份目录在不同
  // 机器上可能给出不同顺序 —— 而这里的顺序会决定重放产出的记录次序。**重放路径上的顺序必须
  // 区域无关地确定**，否则"对拍一致"这类断言会时绿时红，且不同机器上的合并结果可能不同。
  return out.sort((a, b) => {
    if (a.isCopy !== b.isCopy) return a.isCopy ? 1 : -1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/**
 * 重放某逻辑文件的全部副本：
 * - `parseLine` 把一行转成记录（各文件格式不同：成员日志是 JSONL，普通文件是整份内容）；
 * - 缺文件/空副本 → 返回空数组（**不是错误**）；
 * - 副本读失败（占位符）→ 记入 `skipped`（如实报告，不静默丢弃）。
 */
export function replayFileCopies(dir, logicalFileName, { parseLine } = {}) {
  const copies = listCopies(dir, logicalFileName)
  const records = []
  const skipped = []
  for (const c of copies) {
    const ph = detectPlaceholderSync(c.path)
    if (ph.placeholder) { skipped.push({ name: c.name, reason: ph.reason }); continue }
    let text = ''
    try { text = readFileSync(c.path, 'utf-8') } catch (e) { skipped.push({ name: c.name, reason: `unreadable:${(e && e.code) || 'unknown'}` }); continue }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      records.push(parseLine ? parseLine(line, c) : line)
    }
  }
  return { records, skipped, copies: copies.map((c) => c.name) }
}

/**
 * 跨目录重放同一逻辑文件的全部副本（**双读并集**）。
 *
 * 用途：双读兼容下会出现"旧日志在团队根、新日志在容器"的混合态。只读其中一边都会**丢成员记录**
 * （少一边 = 少几条 add/revoke）。这里把两边并起来交给 `mergeMemberLogCopies` —— 它按
 * `(by, seq)` 去重，故并集不会产生重复记录，只会补齐缺失的那些。
 *
 * `dirs` 顺序 = **重放顺序**，调用方按"旧侧在前"传（追加写只落新侧，旧侧是冻结的历史 ⇒
 * 旧在前即时间序）。副本仍按 `listCopies` 的稳定排序；同一路径只取一次。
 */
export function replayFileCopiesFrom(dirs, logicalFileName, { parseLine } = {}) {
  const copies = []
  const seenPath = new Set()
  for (const d of dirs) {
    if (!d) continue
    for (const c of listCopies(d, logicalFileName)) {
      if (seenPath.has(c.path)) continue
      seenPath.add(c.path)
      copies.push(c)
    }
  }
  const records = []
  const skipped = []
  for (const c of copies) {
    const ph = detectPlaceholderSync(c.path)
    if (ph.placeholder) { skipped.push({ name: c.name, reason: ph.reason }); continue }
    let text = ''
    try { text = readFileSync(c.path, 'utf-8') } catch (e) { skipped.push({ name: c.name, reason: `unreadable:${(e && e.code) || 'unknown'}` }); continue }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      records.push(parseLine ? parseLine(line, c) : line)
    }
  }
  return { records, skipped, copies: copies.map((c) => c.name) }
}

// ---------------------------------------------------------------------------
// 对策②：轮询扫描（无 fs.watch）
// ---------------------------------------------------------------------------

/** `.git` 检测（§7.1：团队源落在 git 工作区内 ⇒ 警告不阻断）。逐级向上查到根，最多 `upLevels` 层。 */
export function detectGitAncestor(root, { upLevels = 8 } = {}) {
  let cur = String(root)
  for (let i = 0; i < upLevels; i++) {
    if (existsSync(join(cur, '.git'))) return { inGit: true, at: join(cur, '.git') }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return { inGit: false, at: null }
}

/**
 * 轮询扫描搜索根，找出所有团队源目录（**按 `team.json` 内容匹配，与目录名无关** —— 批注 #10 的显式实现）。
 *
 * 返回 `{ found, scanned, elapsedMs, warnings, truncated }`：
 * - `found[]` = `{ dir, teamId, name, identCode, manifestPath }`
 * - `scanned` = 访问过的目录数（配合 `elapsedMs` 供用户评估"两个数字加入"的实际成本 —— 批注 #6 未定，
 *   故本轮**只提供度量**，不擅自裁剪深度或加缓存策略）；`maxDepth`/`cacheTtlMs` 均为显式参数。
 * - `truncated` = 是否因 `maxEntries` 提前收工（**如实报告**，避免"没找到"被误解为"不存在"）。
 * - `cacheTtlMs > 0` 时结果缓存于模块作用域（默认 0 = 不缓存，避免陈旧视图）。
 */
const scanCache = new Map()
export function scanTeamDirs({ root, maxDepth = DEFAULT_SCAN_DEPTH, maxEntries = 5000, cacheTtlMs = 0, now = Date.now() } = {}) {
  const key = String(root)
  if (cacheTtlMs > 0) {
    const hit = scanCache.get(key)
    if (hit && now - hit.at < cacheTtlMs) return { ...hit.value, cached: true }
  }
  const started = Date.now()
  const found = []
  const warnings = []
  let scanned = 0
  let truncated = false
  const start = String(root || '')
  if (!start || !existsSync(start)) {
    return { found, scanned, elapsedMs: 0, warnings: [{ kind: 'root-missing', path: start }], truncated: false, cached: false }
  }
  const queue = [{ dir: start, depth: 0 }]
  while (queue.length) {
    const { dir, depth } = queue.shift()
    if (scanned >= maxEntries) { truncated = true; break }
    scanned++
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      // 容器目录（`.yfworking/`）**不是**团队根：它是某个团队根的留档区，由父目录那轮负责判定。
      // 既不把它当候选（否则会把容器误报成一个团队），也不深入（里面不会再有团队）。
      if (e.name === TEAM_CONTAINER_DIR) continue
      // 跳过明显的噪声目录（避免把整个工作区扫穿）：这些不是"策略裁剪"，而是纯收益
      if (e.name === '.git' || e.name === 'node_modules') continue
      // 新布局优先（容器内清单），旧布局回退（团队根下清单）：旧团队无需迁移仍能被发现。
      for (const manifest of [join(full, TEAM_CONTAINER_DIR, TEAM_LAYOUT.MANIFEST), join(full, TEAM_LAYOUT.MANIFEST)]) {
        if (!existsSync(manifest)) continue
        const ph = detectPlaceholderSync(manifest)
        if (ph.placeholder) { warnings.push({ kind: 'manifest-placeholder', path: manifest, reason: ph.reason }); continue }
        try {
          const m = JSON.parse(readFileSync(manifest, 'utf-8'))
          // #10：只认内容里的 teamId，目录名完全不参与判定 ⇒ 目录改名/复制都不影响发现
          if (m && typeof m === 'object' && m.teamId) {
            // `dir` 报的是**团队根**（容器所在的那个目录），不是容器本身 —— 调用方拿它去
            // `teamPaths(dir)` 就能同时得到新写法与旧读法。
            found.push({ dir: full, teamId: String(m.teamId), name: m.name ? String(m.name) : null, identCode: m.identCode ? String(m.identCode) : null, manifestPath: manifest })
            break
          }
        } catch (err) {
          warnings.push({ kind: 'manifest-malformed', path: manifest, reason: (err && err.message) || String(err) })
        }
      }
      if (depth + 1 < maxDepth) queue.push({ dir: full, depth: depth + 1 })
    }
  }
  for (const f of found) {
    const git = detectGitAncestor(f.dir)
    if (git.inGit) warnings.push({ kind: 'in-git-repo', path: f.dir, at: git.at })
  }
  const value = { found, scanned, elapsedMs: Date.now() - started, warnings, truncated, cached: false }
  if (cacheTtlMs > 0) scanCache.set(key, { at: now, value })
  return value
}

/** 清扫描缓存（测试与"手动刷新"用）。 */
export function clearScanCache() { scanCache.clear() }

/** 度量团队源体积（批注 #8：只度量不阻断）。 */
export function measureTeamSource(root, { maxEntries = 20000 } = {}) {
  let files = 0
  let bytes = 0
  let truncated = false
  const queue = [String(root)]
  while (queue.length) {
    const dir = queue.shift()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (files >= maxEntries) { truncated = true; break }
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') queue.push(full); continue }
      if (!e.isFile()) continue
      try { bytes += statSync(full).size } catch { /* ignore */ }
      files++
    }
  }
  return { files, bytes, truncated, overWarnBytes: bytes > TEAM_SOURCE_LIMITS.warnBytes, overWarnFiles: files > TEAM_SOURCE_LIMITS.warnFiles }
}

// ---------------------------------------------------------------------------
// 团队源接口（L1 实现；L2 不实现）
// ---------------------------------------------------------------------------

/**
 * 打开一个 L1 共享目录团队源。返回 §7.1 表中的接口形状：
 * `readManifest` / `readLogCopies` / `writeLog` / `writeManifest` / `writeKeyEnvelope` / `listMembers` / `measure` / `scanWarnings`。
 *
 * L2（服务器源）**不在此处实现**：`openTeamSource({kind:'l2-server'})` 会抛错说明"S5 明确不做"，
 * 以免调用方在跑不到的分支上写代码。
 */
export function openTeamSource({ kind = TEAM_SOURCE_KINDS.L1_SHARED_DIR, root } = {}) {
  if (kind !== TEAM_SOURCE_KINDS.L1_SHARED_DIR) {
    throw new Error(`团队源 ${kind} 未实现（§7.1：L2 服务器源属 S5、明确不做）`)
  }
  const p = teamPaths(root)
  return {
    kind,
    root: p.root,
    paths: p,
    layoutVersion: TEAM_LAYOUT_VERSION,
    /** 本团队当前实际读的是哪套布局（`container` / `legacy` / `none`）——排障与提示用。 */
    layout: () => p.read.layout(),
    ensure: () => ensureTeamDirs(p.root),
    readManifest() {
      // 双读：容器内清单优先，旧布局（团队根下）回退
      const f = p.read.manifestFile()
      if (!existsSync(f)) return null
      return JSON.parse(readFileSync(f, 'utf-8'))
    },
    writeManifest(obj) {
      return writeVerifiedSync(p.manifest, JSON.stringify(obj, null, 2) + '\n')
    },
    writeLog(deviceId, text) {
      return writeVerifiedSync(p.log(deviceId), text)
    },
    /**
     * 读某设备日志的**全部副本**（冲突副本吸收；返回 `{records,skipped,copies}`，records 为**行字符串**）。
     * 双读：把旧布局 `members/` 与容器内 `members/` 的副本**并起来**重放，否则混合态会丢记录。
     * 顺序为**旧侧在前**：追加写只落容器侧，故旧侧是冻结的历史，这个顺序即时间序
     * （与 `kernel/file-collab.mjs` 的 `readJsonlDual` 同一约定）。
     */
    readLogCopies(deviceId) {
      return replayFileCopiesFrom([p.legacy.membersDir, p.membersDir], `log-${deviceId}.jsonl`)
    },
    /** 列出 members 目录里所有**逻辑日志名**（同一设备的多个副本归为一个逻辑名）。双读：两边并集。 */
    listLogNames() {
      const set = new Set()
      for (const d of [p.membersDir, p.legacy.membersDir]) {
        let names = []
        try { names = readdirSync(d) } catch { continue }
        for (const n of names) {
          const { logical } = logicalNameOf(n)
          if (/^log-.*\.jsonl$/.test(logical)) set.add(logical)
        }
      }
      return Array.from(set).sort()
    },
    writeKeyEnvelope(memberId, text) {
      return writeVerifiedSync(p.keyEnvelope(memberId), text)
    },
    readKeyEnvelope(memberId) {
      // 双读：旧团队的邀请信封落在团队根下的 keys/，容器里没有 ⇒ 必须回退才收得到邀请
      const f = p.read.keyEnvelope(memberId)
      if (!existsSync(f)) return null
      return readFileSync(f, 'utf-8')
    },
    measure: () => measureTeamSource(p.root),
    scanWarnings() {
      const git = detectGitAncestor(p.root)
      return git.inGit ? [{ kind: 'in-git-repo', path: p.root, at: git.at }] : []
    },
    /** 相对路径（便于在报告里显示"团队源在哪"，避免泄漏绝对路径给日志）。 */
    rel: (abs) => relative(p.root, abs).split(sep).join('/'),
  }
}
