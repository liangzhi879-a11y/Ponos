// server/knowledge-pack-install.mjs —— 知识包安装/卸载/导出引擎 + 清单读取（S4 Task 3）
// ---------------------------------------------------------------------------
// 定位：操作的是**数据目录**（`<home>/knowledge/packs`），与 `server/skill-install.mjs` 同类，
// 不是知识库查询 ⇒ **不 import kernel**（kernel ⊥ server 双向禁止）；判定规则来自中性层
// `shared/knowledge-pack.mjs`（Task 2），zip 编解码来自 `shared/pack-zip.mjs`（Task 1）。
// 所有函数收**注入的 home**（不自己解析 `resolveYfwHome()`）——测试能用 `mkdtempSync` 完全隔离，
// 也保证"绝不碰真实 ~/.yfworking"这条纪律是**结构上**成立的（没有函数内部偷偷解析 home）。
//
// 本模块是 S4 风险最高的一段（安装 = 往用户目录写文件），故安全设计逐条写明：
//   ① **Zip Slip**：zip 条目名内嵌 `../` 是经典漏洞——逐条 `sanitizePackEntryPath`（拒绝对路径/
//      盘符/NUL/`.`/`..`/Windows 保留名），落盘前再 `resolve` + 断言仍在 staging 根内（第三道），
//      符号链接/特殊文件条目**整包拒绝**（软链能把后续写入引到包外；staging 是新建目录，
//      故第四道真源是"拒绝软链条目 + staging 内自建目录"）。
//   ② **zip bomb**：交给 Task 1 的 `readZip` 用**中央目录声明值**在解压前挡（单文件/总量/条目数）。
//   ③ **校验不过一律拒绝安装**，返回结构化 `errors[]`（可读中文），且**不留残留**：
//      所有落盘都在 `<knowledge>/.packs-staging-*`，`finally` 里 `rmSync`（只有成功 rename 走的才留）。
//   ④ **不静默覆盖**：目标已存在且与台账指纹不符 → `kept-user-modified`，**一个字节都不写**；
//      覆盖路径必先整目录 rename 到备份（`.backups` 同 id 只留最新 1 份）。
//   ⑤ **卸载只删自己装的**：只删 `packs/<id>`，绝不碰 `spaces/`（用户笔记）。
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, renameSync,
  statSync, copyFileSync, realpathSync, mkdtempSync,
} from 'node:fs'
import { join, resolve, sep, relative, dirname } from 'node:path'
import { readZip, writeZip } from '../shared/pack-zip.mjs'
import {
  PACK_LIMITS, PACK_ID_RE, sanitizePackEntryPath, classifyPackEntry, isInsideRoot,
  hashContent, validatePackManifest, buildLedgerEntry, buildManifestEntry, buildPackReadme,
  resolvePackVersion, packSpaceId,
} from '../shared/knowledge-pack.mjs'

/**
 * 默认官方清单基址（spec §11.5 D1：并入仓库 `knowledge-packs/` 子目录的 raw 地址）。
 * **owner/repo 是占位值**（待确认）——在线清单在真实环境拉不到不影响离线路径；企业内网可用
 * `config.json:knowledgePackRegistry` 覆盖，或放本地离线清单（本地优先，见 `readIndex`）。
 */
export const DEFAULT_PACK_REGISTRY = 'https://raw.githubusercontent.com/ponos-ai/ponos/main/knowledge-packs'

/** 下载/响应体积上限：与单包总量同值（挡"不读 body 就拒"的 Content-Length 预检） */
const MAX_DOWNLOAD_BYTES = PACK_LIMITS.maxTotalBytes

export const packsRoot = (home) => join(String(home || ''), 'knowledge', 'packs')
export const spacesRoot = (home) => join(String(home || ''), 'knowledge', 'spaces')
export const exportsRoot = (home) => join(String(home || ''), 'knowledge', 'exports')
/** 台账：spec §3.1 定为 `~/.yfw/knowledge/.packs.json`（点文件，落在 `packs/` **之外** ——
 *  放进去会被内核 `discoverSpaces` 当成一个空间候选，且备份目录同理，见下方 `.backups` 说明） */
export const ledgerPath = (home) => join(String(home || ''), 'knowledge', '.packs.json')
export const localIndexPath = (home) => join(String(home || ''), 'knowledge', 'packs-index.local.json')
/**
 * 备份根：计划原文写 `knowledge/packs/.backups/<id>-<ts>`。**实测不可行**：内核
 * `kernel/knowledge.mjs:73-89` 对 `packs/` 下**每个目录**都尝试读 `pack.json` 并
 * `existsSync(base) ? push` —— `.backups` 会被挂成一个 id 为 `pack-.backups` 的幽灵只读空间
 * （backup 内的 `pack.json` 在下一层，故 `meta` 为空对象，`base` 仍存在 ⇒ 一定被 push）。
 * 故备份放 `knowledge/pack-backups/`（与 `packs/`、`spaces/` 平级，内核不扫描）。
 */
export const backupsRoot = (home) => join(String(home || ''), 'knowledge', 'pack-backups')
/** staging：与 packs/ 同盘（rename 原子且不跨设备），`finally` 必清 */
const stagingBase = (home) => join(String(home || ''), 'knowledge')

const nowIso = () => new Date().toISOString()

// —— 台账（对齐 skill-install 的 `manifest.files` 指纹表） ——

export function readLedger(home) {
  const fp = ledgerPath(home)
  const empty = { schemaVersion: 1, packs: {} }
  if (!existsSync(fp)) return empty
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8'))
    if (!raw || typeof raw !== 'object') return empty
    // 形态容错：spec §3.1 写的是 `{ packId: {...} }` 裸映射，本实现用 `{ schemaVersion, packs }`。
    // 两种都认，否则用户从文档手写的台账会被整体丢弃 → 所有包被误判成"未受管"。
    const packs = (raw.packs && typeof raw.packs === 'object') ? raw.packs : Object.fromEntries(
      Object.entries(raw).filter(([k, v]) => k !== 'schemaVersion' && v && typeof v === 'object' && v.files),
    )
    return { schemaVersion: Number(raw.schemaVersion) || 1, packs: { ...packs } }
  } catch {
    // 台账损坏 ⇒ 空台账（下次安装按"未受管"处理 = 更保守，绝不据此覆盖用户文件）
    return empty
  }
}

export function writeLedger(home, led) {
  const fp = ledgerPath(home)
  mkdirSync(dirname(fp), { recursive: true })
  const out = { schemaVersion: 1, packs: (led && led.packs) || {}, updatedAt: nowIso() }
  // 原子写：`.tmp` → rename（对齐 kernel/graph.mjs 的落盘手法）——半截 JSON 会让下次
  // 启动读台账失败，进而把所有已装包判成"未受管"（用户改动记忆丢失）。
  const tmp = `${fp}.tmp`
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8')
  renameSync(tmp, fp)
  return out
}

// —— 内部工具 ——

function absEntryFiles(rootAbs) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isSymbolicLink()) { out.push({ rel: relative(rootAbs, abs).split(sep).join('/'), abs, symlink: true }); continue }
      if (e.isDirectory()) { walk(abs); continue }
      if (!e.isFile()) continue
      out.push({ rel: relative(rootAbs, abs).split(sep).join('/'), abs, symlink: false })
    }
  }
  walk(rootAbs)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** 目录现状指纹表：`相对路径 → hashContent`（文本先 CRLF→LF 归一，与台账同基准） */
function hashDir(rootAbs) {
  const out = {}
  for (const f of absEntryFiles(rootAbs)) {
    if (f.symlink) { out[f.rel] = 'symlink'; continue }
    try { out[f.rel] = hashContent(readFileSync(f.abs), { name: f.rel }) } catch { out[f.rel] = 'unreadable' }
  }
  return out
}

/** 条目集合 + 内容指纹完全一致？（`unchanged` 的判据——内容比"版本号相同"更硬） */
function sameFileSet(live, incoming) {
  const a = Object.keys(live).sort()
  const b = Object.keys(incoming).sort()
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] || live[a[i]] !== incoming[b[i]]) return false
  return true
}

/** 校验在内存里的一批条目（zip 或目录两个来源共用同一套判定，避免"两套标准漂移"）。
 *  `entries = [{ name, data, isDir }]`；返回 `{ errors, files }`，files 含 `sha`/`kind`。 */
function validateEntries(entries) {
  const errors = []
  const files = []
  const seen = new Set()
  let total = 0
  for (const en of entries) {
    const raw = en.isDir ? String(en.name).replace(/\/+$/, '') : String(en.name)
    const sp = sanitizePackEntryPath(raw)
    if (!sp.ok) { errors.push(`非法条目名：${sp.error}`); continue }
    // 条目名里的 CR/LF：解压落盘会把名字劈成两行（部分工具还会当路径分隔符处理），
    // 属歧义输入，宁可拒也不猜
    if (/[\r\n]/.test(sp.path)) { errors.push(`条目名含换行符：${JSON.stringify(sp.path)}`); continue }
    if (en.isDir) { seen.add(`d:${sp.path}`); continue }
    if (seen.has(`f:${sp.path}`)) { errors.push(`包内条目名重复：${sp.path}（同名条目内容取决于工具实现）`); continue }
    seen.add(`f:${sp.path}`)
    const cls = classifyPackEntry(sp.path)
    if (!cls.ok) { errors.push(cls.error); continue }
    total += en.data.length
    if (en.data.length > PACK_LIMITS.maxFileBytes) {
      errors.push(`条目「${sp.path}」大小 ${en.data.length} 字节，超过单文件上限 ${PACK_LIMITS.maxFileBytes}`)
      continue
    }
    files.push({ name: sp.path, data: en.data, size: en.data.length, sha: hashContent(en.data, { name: sp.path }), kind: cls.kind })
  }
  if (files.length > PACK_LIMITS.maxFiles) errors.push(`包内文件数 ${files.length} 超过上限 ${PACK_LIMITS.maxFiles}`)
  if (total > PACK_LIMITS.maxTotalBytes) errors.push(`包内解压总量 ${total} 字节超过上限 ${PACK_LIMITS.maxTotalBytes}`)
  if (seen.size > PACK_LIMITS.maxEntries) errors.push(`包内条目数 ${seen.size} 超过上限 ${PACK_LIMITS.maxEntries}`)
  return { errors, files }
}

/** 校验结果收尾：pack.json 解析 + manifest 校验 + source 必须存在。 */
function finishInspect(files, { expectId, appVersion, versions }) {
  const errors = []
  const warnings = []
  // 外层目录容错：导出物布局是 `<id>/pack.json`（spec §11.3 R1），而"包 = zip 根"也是常见形态。
  // 两种都收——否则自家导出物装不回去（完成定义 #7 的 round-trip 直接破），用户下载的包也常带一层目录。
  let list = files
  if (!files.some((f) => f.name === 'pack.json')) {
    const dirs = new Set(files.filter((f) => /^[^/]+\/pack\.json$/.test(f.name)).map((f) => f.name.split('/')[0]))
    if (dirs.size === 1) {
      const d = [...dirs][0]
      list = files.filter((f) => f.name.startsWith(`${d}/`)).map((f) => ({ ...f, name: f.name.slice(d.length + 1) }))
      warnings.push(`已忽略包外层目录「${d}/」（导出物/手工打包常见形态）`)
    }
  }
  const mf = list.find((f) => f.name === 'pack.json')
  if (!mf) {
    errors.push('包根缺少 pack.json（知识包必须自述 id/name/version/license/source）')
    return { ok: false, errors, warnings, files: [], manifest: null }
  }
  let json = null
  try { json = JSON.parse(mf.data.toString('utf-8')) } catch (e) {
    errors.push(`pack.json 不是合法 JSON：${e?.message || e}`)
    return { ok: false, errors, warnings, files: [], manifest: null }
  }
  const vr = validatePackManifest(json, { expectId, appVersion, versions })
  errors.push(...vr.errors)
  warnings.push(...vr.warnings)
  if (!vr.ok) return { ok: false, errors, warnings, files: [], manifest: null }

  const prefix = `${vr.pack.source}/`
  const payload = list.filter((f) => f.name.startsWith(prefix))
  if (!payload.length) {
    // 空间根为空 = 装完什么都搜不到，属"跳过"而非"成功"（第五态由 installPack 判）
    warnings.push(`pack.json 的 source「${vr.pack.source}」下没有文件`)
  }
  return {
    ok: errors.length === 0,
    errors, warnings,
    manifest: vr.pack,
    /** 版本兼容判定的结果（`current` / `fallback`），路由据此告诉前端"装的是回退版" */
    version: vr.version,
    files: list,
    payload,
    contentBytes: payload.reduce((n, f) => n + f.size, 0),
    docCount: payload.filter((f) => f.kind === 'doc').length,
  }
}

/**
 * 校验 zip 字节流（**不落盘**）：先过 Task 1 的 zip reader（解压前挡体积/条目/zip64/加密/分卷），
 * 再逐条过路径与扩展名白名单，最后校验 `pack.json`。
 * 返回 `{ ok, errors, warnings, manifest, files, payload, ... }`——**不抛**（错误要能直接展示给用户）。
 */
export function inspectArchive(buffer, { expectId = null, appVersion = '', versions = null } = {}) {
  let zres
  try {
    zres = readZip(buffer, {
      maxEntries: PACK_LIMITS.maxEntries,
      maxFileBytes: PACK_LIMITS.maxFileBytes,
      maxTotalBytes: PACK_LIMITS.maxTotalBytes,
    })
  } catch (e) {
    return { ok: false, errors: [`zip 校验失败：${e?.message || e}`], warnings: [], files: [], payload: [], manifest: null, code: e?.code || 'zip' }
  }
  const errors = []
  const entries = []
  for (const en of zres.entries) {
    // 符号链接/特殊文件条目：整包拒绝（软链条目解压后能把后续写入引到包外——Zip Slip 的软链变体）
    if (en.isSymlink) { errors.push(`包内含符号链接条目：${en.name}（软链可把写入引到包外，一律拒绝）`); continue }
    if (en.isSpecial) { errors.push(`包内含特殊文件条目（设备/FIFO 等）：${en.name}`); continue }
    entries.push({ name: en.name, data: en.data, isDir: en.isDir })
  }
  if (errors.length) return { ok: false, errors, warnings: [], files: [], payload: [], manifest: null }
  const v = validateEntries(entries)
  if (v.errors.length) return { ok: false, errors: v.errors, warnings: [], files: [], payload: [], manifest: null }
  return finishInspect(v.files, { expectId, appVersion, versions })
}

/** 目录来源（离线安装的另一形态）：与 zip 同标准校验，软链条目同样拒绝。 */
export function inspectDirectory(srcDir, { expectId = null, appVersion = '', versions = null } = {}) {
  const rootAbs = resolve(String(srcDir || ''))
  if (!rootAbs || !existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    return { ok: false, errors: [`目录不存在或不是目录：${srcDir}`], warnings: [], files: [], payload: [], manifest: null }
  }
  const errors = []
  const entries = []
  for (const f of absEntryFiles(rootAbs)) {
    if (f.symlink) { errors.push(`包内含符号链接：${f.rel}（一律拒绝）`); continue }
    let data
    try { data = readFileSync(f.abs) } catch (e) { errors.push(`条目读取失败：${f.rel}（${e?.message || e}）`); continue }
    if (data.length > PACK_LIMITS.maxFileBytes) { errors.push(`条目「${f.rel}」大小 ${data.length} 字节，超过单文件上限 ${PACK_LIMITS.maxFileBytes}`); continue }
    entries.push({ name: f.rel, data, isDir: false })
  }
  if (errors.length) return { ok: false, errors, warnings: [], files: [], payload: [], manifest: null }
  const v = validateEntries(entries)
  if (v.errors.length) return { ok: false, errors: v.errors, warnings: [], files: [], payload: [], manifest: null }
  return finishInspect(v.files, { expectId, appVersion, versions })
}

/** 把校验通过的条目写进 staging（**第三道防护**：resolve 后断言仍在 staging 根内） */
function materialize(files, stagingAbs) {
  mkdirSync(stagingAbs, { recursive: true })
  for (const f of files) {
    const dest = resolve(stagingAbs, f.name)
    if (!isInsideRoot(stagingAbs, dest)) {
      // 前面已过净化，这里仍断言：净化是字符串层，落盘前的 resolve 断言能兜住任何绕过
      throw Object.assign(new Error(`条目越出目标根：${f.name}`), { code: 'path-escape' })
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, f.data)
  }
}

function withStaging(home, fn) {
  const base = stagingBase(home)
  mkdirSync(base, { recursive: true })
  const staging = mkdtempSync(join(base, '.packs-staging-'))
  try {
    return fn(staging)
  } finally {
    // 任何失败路径都清 staging（验收项 5 的"不留残留"）。成功路径已 rename 走，force 忽略缺失。
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * 安装。5 态决策（spec §11.3 R3，逐字对齐 `upsertSkill`）：
 *   `installed` 目标不存在 → 落盘 + 写台账
 *   `updated`   已装、内容有差异、且**未**被用户改过 → 备份后覆盖
 *   `unchanged` 已装且**逐文件指纹完全一致** → 不写盘
 *   `kept-user-modified` 已装且磁盘现状 ≠ 台账指纹 → **一个字节都不写**，返回冲突清单与三选
 *   `skipped-empty` source 下无可安装文件 → 不落盘
 * `mode`：`safe`（缺省）/`overwrite`（用户明确选了"覆盖"）/`to-my-space`（另存为我的空间）。
 */
export function installPack({
  home, archiveBuffer = null, srcDir = null, source = 'offline', mode = 'safe',
  appVersion = '', versions = null, expectId = null,
} = {}) {
  if (!home) return { status: 'rejected', errors: ['缺少 home（数据目录）'] }
  if (!archiveBuffer && !srcDir) return { status: 'rejected', errors: ['必须提供 archiveBuffer（zip）或 srcDir（目录）'] }
  if (!['safe', 'overwrite', 'to-my-space'].includes(mode)) {
    return { status: 'rejected', errors: [`未知 mode「${mode}」（可选 safe / overwrite / to-my-space）`] }
  }

  const ins = archiveBuffer
    ? inspectArchive(archiveBuffer, { expectId, appVersion, versions })
    : inspectDirectory(srcDir, { expectId, appVersion, versions })
  if (!ins.ok) return { status: 'rejected', errors: ins.errors, warnings: ins.warnings }

  const { manifest, payload } = ins
  const packId = manifest.id
  const spaceId = packSpaceId(packId)
  // 指纹表覆盖**包目录内全部文件**（pack.json/README.md 也记）：只比 source 下的 payload
  // 会漏掉"用户手改了 pack.json 的 version/name"这类改动，kernel 读的就是这个文件。
  const incoming = Object.fromEntries(ins.files.map((f) => [f.name, f.sha]))

  if (!payload.length) {
    // 空包：装进用户目录只会多出一个搜不到东西的空间，属"跳过"（不落盘、无残留）
    return { status: 'skipped-empty', packId, version: ins.version?.version || manifest.version, spaceId, files: 0, errors: [`包内 source「${manifest.source}」下没有可安装的文件`] }
  }

  // 另存为我的空间：不进 packs/、不写台账（它不是知识包，是用户的可写空间）
  if (mode === 'to-my-space') {
    const destRoot = join(spacesRoot(home), packId)
    if (!isInsideRoot(spacesRoot(home), destRoot)) return { status: 'rejected', errors: ['目标空间路径越界'] }
    if (existsSync(destRoot)) {
      return { status: 'rejected', errors: [`我的空间中已存在「${packId}」，未做任何写入（纯增量）`] }
    }
    try {
      withStaging(home, (staging) => {
        // 只落 **payload**（source 下的内容，前缀剥掉）：另存为的是"我的空间"，空间根 = 内容根；
        // 把 pack.json/README.md 一起搬进去会让它们被 walkMd 当成空间文档（正文无关的元数据）
        materialize(payload.map((f) => ({ ...f, name: f.name.slice(manifest.source.length + 1) })), staging)
        mkdirSync(dirname(destRoot), { recursive: true })
        renameSync(staging, destRoot)
      })
    } catch (e) {
      return { status: 'rejected', errors: [`写入我的空间失败：${e?.message || e}`] }
    }
    return { status: 'to-my-space', packId, version: ins.version?.version || manifest.version, spaceId: packId, files: payload.length, contentPath: destRoot }
  }

  const proot = packsRoot(home)
  const target = join(proot, packId)
  if (!isInsideRoot(proot, target)) return { status: 'rejected', errors: ['目标路径越界（id 已净化，此处为兜底断言）'] }
  mkdirSync(proot, { recursive: true })

  const led = readLedger(home)
  const prev = led.packs[packId] || null
  let backupPath = null

  if (existsSync(target)) {
    const live = hashDir(target)
    if (sameFileSet(live, incoming)) {
      // 幂等：内容一致则连台账的时间戳都不动（"装了一次又一次"不该有副作用）
      return { status: 'unchanged', packId, version: prev?.version || manifest.version, spaceId, files: payload.length }
    }
    // 冲突判定：**逐文件比"磁盘现状" vs "台账记录的安装时指纹"**——不是拿新包内容当基准。
    // 台账里没有记录（未受管目录）= 来源不明，保守判"动过"，绝不静默覆盖。
    const modified = []
    for (const [rel, h] of Object.entries(live)) {
      const key = `${packId}/${rel}`
      const rec = prev?.files?.[key]
      if (!rec || rec !== h) modified.push(rel)
    }
    if (modified.length && mode !== 'overwrite') {
      return {
        status: 'kept-user-modified',
        packId, version: prev?.version || manifest.version, spaceId, files: payload.length,
        conflicts: modified.sort(),
        options: ['overwrite', 'keep', 'to-my-space'],
        message: '目标包内文件与安装台账不符（可能被你或其它工具改过），未做任何写入',
      }
    }
    // 备份先于覆盖：整目录 rename 到 pack-backups/<id>-<ts>，同 id 只留最新 1 份（有界增长）
    const broot = backupsRoot(home)
    mkdirSync(broot, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = join(broot, `${packId}-${stamp}`)
    try {
      renameSync(target, backupPath)
      pruneBackups(broot, packId, backupPath)
    } catch (e) {
      return { status: 'rejected', errors: [`备份失败，已中止覆盖（未改动现有文件）：${e?.message || e}`], backupPath }
    }
  }

  try {
    withStaging(home, (staging) => {
      // 落**全部**文件（pack.json/README.md/content/**）——pack.json 少一个字节，内核
      // `discoverSpaces` 就读不到 name/version/source（空间名与只读挂载点都会退化成目录名）
      materialize(ins.files, staging)
      renameSync(staging, target)
    })
  } catch (e) {
    // 覆盖路径下 target 已被移走：把备份移回来，宁可回到"旧版可用"也不要留空目录
    if (backupPath && !existsSync(target)) {
      try { renameSync(backupPath, target) } catch { /* 回滚失败：backupPath 已在返回值里，用户可手工恢复 */ }
    }
    return { status: 'rejected', errors: [`落盘失败：${e?.message || e}`], backupPath }
  }

  const status = prev ? 'updated' : 'installed'
  const files = Object.fromEntries(ins.files.map((f) => [`${packId}/${f.name}`, f.sha]))
  const entry = buildLedgerEntry({
    id: packId,
    version: ins.version?.version || manifest.version,
    files,
    installedAt: prev?.installedAt || nowIso(),
    updatedAt: nowIso(),
    backupPath: backupPath || null,
    source,
  })
  led.packs[packId] = { ...entry, name: manifest.name, license: manifest.license, minAppVersion: manifest.minAppVersion || '' }
  writeLedger(home, led)

  return {
    status, packId, version: ins.version?.version || manifest.version, spaceId,
    files: payload.length, contentBytes: ins.contentBytes, docCount: ins.docCount,
    backupPath, warnings: ins.warnings,
    // 不做"触发索引"：内核 `store.load()` 的 staleness 会逐文件比 size/mtime 并检测磁盘新增/已删，
    // 安装后**下一次检索自动吸收**（spec §11.3 R4：不得为此新增内核 op / 调 reindex）
  }
}

/** 备份保留策略：同 id 只留最新 1 份。`keep` 为刚写入的那份（时间戳命名，字典序即时间序）。 */
function pruneBackups(broot, packId, keep) {
  let names = []
  try { names = readdirSync(broot) } catch { return }
  const mine = names.filter((n) => n.startsWith(`${packId}-`) && join(broot, n) !== keep).sort()
  for (const n of mine) {
    if (join(broot, n) === keep) continue
    try { rmSync(join(broot, n), { recursive: true, force: true }) } catch { /* 清理失败不影响本次安装 */ }
  }
}

/**
 * 卸载：只删 `packs/<id>` 与台账条目。**绝不**碰 `spaces/`（用户笔记）与 `pack-backups/`（回滚副本）。
 * 返回 `{ ok, removed }`；id 非法/目录不存在都返回 `ok:false` 且不动盘。
 */
export function uninstallPack({ home, packId } = {}) {
  const id = String(packId || '')
  if (!PACK_ID_RE.test(id)) return { ok: false, error: `包 id 不合法：${id || '(空)'}`, removed: [] }
  const proot = resolve(packsRoot(home))
  const target = resolve(proot, id)
  if (!isInsideRoot(proot, target) || target === proot) return { ok: false, error: '目标路径越界', removed: [] }
  const removed = existsSync(target) ? absEntryFiles(target).map((f) => f.rel) : []
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  const led = readLedger(home)
  if (led.packs[id]) {
    delete led.packs[id]
    writeLedger(home, led)
  }
  return { ok: true, packId: id, removed, removedCount: removed.length, ledgerCleared: true }
}

/** 已装包 = 台账 ∪ 磁盘（磁盘上有的未必在台账里——手工拷贝/台账丢失都要能列出并卸载） */
export function listInstalledPacks(home) {
  const led = readLedger(home)
  const proot = packsRoot(home)
  const out = new Map()
  for (const [id, e] of Object.entries(led.packs)) {
    out.set(id, {
      id, version: e.version || '', spaceId: packSpaceId(id), name: e.name || id,
      license: e.license || '', installedAt: e.installedAt || '', updatedAt: e.updatedAt || '',
      files: Object.keys(e.files || {}).length, onDisk: existsSync(join(proot, id)), source: e.source || '',
    })
  }
  let names = []
  try { names = readdirSync(proot) } catch { names = [] }
  for (const name of names) {
    const dir = join(proot, name)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    if (out.has(name)) continue
    let meta = {}
    try { meta = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf-8')) } catch { meta = {} }
    out.set(name, {
      id: name, version: String(meta.version || ''), spaceId: packSpaceId(name), name: String(meta.name || name),
      license: String(meta.license || ''), installedAt: '', updatedAt: '',
      files: absEntryFiles(dir).length, onDisk: true, source: 'untracked',
    })
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}

// —— 导出（供给侧：空间 → 知识包） ——

/**
 * 把一个**可写空间**导成知识包。布局固定（spec §11.3 R1）：`<id>/pack.json` + `<id>/README.md`
 * + `<id>/content/**` 且 `"source": "content"`（内核 `join(包目录, source)` 是空间根）。
 * 只收白名单扩展名（导出物必须能被自家安装器装回去），跳过的文件进 `skipped[]`。
 */
export function exportSpaceAsPack({ home, spaceId, spaceRoot, meta = {} } = {}) {
  const id = String(meta.id || '')
  const version = String(meta.version || '')
  const license = String(meta.license || '')
  const mres = validatePackManifest(
    { id, name: meta.name || id, version, license, source: 'content', description: meta.description || '', author: meta.author || '', tags: meta.tags || [] },
    { expectId: id },
  )
  if (!mres.ok) return { ok: false, errors: mres.errors }
  const rootAbs = resolve(String(spaceRoot || ''))
  if (!spaceRoot || !existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    return { ok: false, errors: [`空间目录不可读：${spaceRoot || '(空)'}`] }
  }

  const packFiles = []
  const skipped = []
  let docCount = 0
  let sizeBytes = 0
  for (const f of absEntryFiles(rootAbs)) {
    const cls = f.symlink ? { ok: false, error: '符号链接' } : classifyPackEntry(f.rel)
    if (!cls.ok) { skipped.push({ rel: f.rel, reason: cls.error }); continue }
    const data = f.symlink ? Buffer.alloc(0) : readFileSync(f.abs)
    if (data.length > PACK_LIMITS.maxFileBytes) { skipped.push({ rel: f.rel, reason: `超过单文件上限 ${PACK_LIMITS.maxFileBytes}` }); continue }
    packFiles.push({ name: `${id}/content/${f.rel}`, data })
    sizeBytes += data.length
    if (cls.kind === 'doc') docCount += 1
  }
  if (sizeBytes > PACK_LIMITS.maxTotalBytes) return { ok: false, errors: [`空间内容总大小 ${sizeBytes} 字节超过上限 ${PACK_LIMITS.maxTotalBytes}`] }
  if (!packFiles.length) return { ok: false, errors: ['空间内没有可导出的文件（仅允许 md 与图片/PDF/CSV 等纯数据资产）'] }

  const packJson = {
    id, name: mres.pack.name, version, license, source: 'content',
    description: mres.pack.description, author: mres.pack.author, tags: mres.pack.tags,
  }
  const readme = buildPackReadme({ name: packJson.name, description: packJson.description, version, license, author: packJson.author, docCount })
  const all = [
    { name: `${id}/pack.json`, data: Buffer.from(JSON.stringify(packJson, null, 2), 'utf-8') },
    { name: `${id}/README.md`, data: Buffer.from(readme, 'utf-8') },
    ...packFiles,
  ]
  const zip = writeZip(all)

  const outDir = exportsRoot(home)
  mkdirSync(outDir, { recursive: true })
  const zipPath = join(outDir, `${id}-${version}.zip`)
  // 导出物是**生成产物**（再点一次导出就是要覆盖上一次的产物），不适用"不静默覆盖用户数据"那条
  writeFileSync(zipPath, zip)
  const manifestEntry = buildManifestEntry({
    id, name: packJson.name, description: packJson.description, author: packJson.author,
    repo: meta.repo || '', tags: packJson.tags, docCount, sizeBytes: zip.length,
  })
  return {
    ok: true, packId: id, version, spaceId: String(spaceId || ''), packJson, zipPath,
    zipBytes: zip.length, manifestEntry, readme, docCount, files: packFiles.length + 2, skipped,
  }
}

// —— 清单读取（本地离线清单优先） ——

/** 本地离线清单：`<home>/knowledge/packs-index.local.json`（`{updatedAt,packs[]}` 或裸数组） */
export function readLocalIndex(home) {
  const fp = localIndexPath(home)
  if (!existsSync(fp)) return { exists: false, packs: [], updatedAt: null, path: fp }
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8'))
    const packs = Array.isArray(raw) ? raw : (Array.isArray(raw?.packs) ? raw.packs : [])
    return { exists: true, packs: sanitizeIndexItems(packs).items, updatedAt: raw?.updatedAt || null, path: fp }
  } catch (e) {
    return { exists: true, packs: [], updatedAt: null, path: fp, error: `本地清单解析失败：${e?.message || e}` }
  }
}

/** 清单条目净化：id 必须过正则（**清单不是可信输入**，坏 id 会变成路径片段）。 */
function sanitizeIndexItems(packs) {
  const items = []
  const dropped = []
  for (const p of Array.isArray(packs) ? packs : []) {
    const id = String(p?.id ?? '')
    if (!PACK_ID_RE.test(id)) { dropped.push(`非法 id：${JSON.stringify(id)}`); continue }
    items.push({
      id,
      name: String(p.name || id),
      description: String(p.description || ''),
      author: String(p.author || ''),
      repo: String(p.repo || ''),
      version: String(p.version || ''),
      tags: Array.isArray(p.tags) ? p.tags.map(String).slice(0, 12) : [],
      docCount: Number(p.docCount) || 0,
      sizeBytes: Number(p.sizeBytes) || 0,
      official: p.official === true,
      /** 离线清单可给"本地路径或 file:// URL"（spec §3.3）；远程清单里出现该字段一律忽略 */
      localPath: typeof p.localPath === 'string' ? p.localPath : '',
    })
  }
  return { items, dropped }
}

/**
 * 清单读取优先级（spec §11.5 D1）：**本地离线清单 > 远程**（存在即不联网——企业内网刚需；
 * 也让测试天然不触网）。
 */
export async function readIndex({ home, fetcher = globalThis.fetch, registry = '' } = {}) {
  const local = home ? readLocalIndex(home) : { exists: false, packs: [] }
  if (local.exists && local.packs.length) {
    return { ok: true, source: 'local', packs: local.packs, updatedAt: local.updatedAt, warnings: [] }
  }
  if (!registry) return { ok: false, source: 'none', packs: [], error: '未配置清单地址（可设 config.json:knowledgePackRegistry 或放本地离线清单）' }
  try {
    const data = await fetchJson(fetcher, buildDownloadUrl({ registry, file: 'index.json' }))
    const packs = Array.isArray(data) ? data : (Array.isArray(data?.packs) ? data.packs : [])
    const { items, dropped } = sanitizeIndexItems(packs)
    return { ok: true, source: 'remote', packs: items, updatedAt: data?.updatedAt || null, warnings: dropped }
  } catch (e) {
    return { ok: false, source: 'remote', packs: [], error: `清单拉取失败：${e?.message || e}` }
  }
}

/** 远程 JSON 读取：非 2xx / 非 JSON 一律抛（调用方折成结构化错误，不吞）。 */
async function fetchJson(fetcher, url) {
  const res = await fetcher(url, { method: 'GET', headers: { accept: 'application/json' } })
  if (!res || typeof res !== 'object') throw new Error('fetcher 返回非法响应')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function fetchTextOrNull(fetcher, url) {
  const res = await fetcher(url, { method: 'GET' })
  if (!res || typeof res !== 'object') return null
  if (!res.ok) return null
  return await res.text()
}

/**
 * 包详情：`pack.json` + `README.md` + `versions.json`（后两者缺失不算错）+ 版本兼容判定结果。
 * `localPath` 给离线清单用（直接读本机目录，不走网络）。
 */
export async function fetchPackDetail({ fetcher = globalThis.fetch, registry = '', id = '', appVersion = '', localPath = null } = {}) {
  if (!PACK_ID_RE.test(String(id))) return { ok: false, error: `包 id 不合法：${id}` }
  try {
    let json = null
    let readme = ''
    let versions = null
    if (localPath) {
      const jp = join(String(localPath), 'pack.json')
      json = JSON.parse(readFileSync(jp, 'utf-8'))
      const rp = join(String(localPath), 'README.md')
      readme = existsSync(rp) ? readFileSync(rp, 'utf-8') : ''
      const vp = join(String(localPath), 'versions.json')
      versions = existsSync(vp) ? JSON.parse(readFileSync(vp, 'utf-8')) : null
    } else {
      json = await fetchJson(fetcher, buildDownloadUrl({ registry, file: `packs/${id}/pack.json` }))
      readme = (await fetchTextOrNull(fetcher, buildDownloadUrl({ registry, file: `packs/${id}/README.md` }))) || ''
      try {
        const vt = await fetchTextOrNull(fetcher, buildDownloadUrl({ registry, file: `packs/${id}/versions.json` }))
        versions = vt ? JSON.parse(vt) : null
      } catch { versions = null }
    }
    const vr = validatePackManifest(json, { expectId: id, appVersion, versions })
    if (!vr.ok) {
      // 区分"版本不兼容"与"其余校验失败"：前者路由要回 409（可换版本，不是坏包），
      // 后者是坏包（400）。靠文案匹配太脆，故在这里给结构化 code。
      const needsHigherApp = !!(vr.version && vr.version.reason === 'needs-higher-app')
      return { ok: false, error: vr.errors.join('；'), errors: vr.errors, warnings: vr.warnings, code: needsHigherApp ? 'needs-higher-app' : 'invalid-manifest', version: vr.version || null }
    }
    return { ok: true, pack: vr.pack, versions, readme, version: vr.version, warnings: vr.warnings }
  } catch (e) {
    return { ok: false, error: `包详情读取失败：${e?.message || e}`, code: 'fetch-failed' }
  }
}

/**
 * 下载包 zip。**体积上限挡两次**：先看 `Content-Length`（超限即拒，不读 body），
 * 读完再量实际字节（Content-Length 可缺可伪）。URL 由 registry + id + version 组装（同源断言）。
 */
export async function fetchPackArchive({ fetcher = globalThis.fetch, registry = '', id = '', version = '' } = {}) {
  const url = buildDownloadUrl({ registry, id, version, file: `packs/${id}/${id}-${version}.zip` })
  let res
  try { res = await fetcher(url, { method: 'GET' }) } catch (e) {
    return { ok: false, error: `下载失败：${e?.message || e}` }
  }
  if (!res || typeof res !== 'object') return { ok: false, error: '下载失败：fetcher 返回非法响应' }
  if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}` }
  const declared = Number(res.headers?.get?.('content-length') || 0)
  if (declared && declared > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: `包体积声明 ${declared} 字节，超过上限 ${MAX_DOWNLOAD_BYTES}`, tooLarge: true }
  }
  try {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_DOWNLOAD_BYTES) return { ok: false, error: `包体积 ${buf.length} 字节，超过上限 ${MAX_DOWNLOAD_BYTES}`, tooLarge: true }
    return { ok: true, buffer: buf, url, bytes: buf.length }
  } catch (e) {
    return { ok: false, error: `下载内容读取失败：${e?.message || e}` }
  }
}

/** `versions.json`（版本兼容回退表）：缺失返回 `{ ok:true, versions:null }`（不是错误） */
export async function fetchPackVersions({ fetcher = globalThis.fetch, registry = '', id = '' } = {}) {
  if (!PACK_ID_RE.test(String(id))) return { ok: false, error: `包 id 不合法：${id}` }
  try {
    const txt = await fetchTextOrNull(fetcher, buildDownloadUrl({ registry, file: `packs/${id}/versions.json` }))
    return { ok: true, versions: txt ? JSON.parse(txt) : null }
  } catch (e) {
    return { ok: false, error: `versions.json 读取失败：${e?.message || e}` }
  }
}

/**
 * registry 解析：本地离线清单 > `config.knowledgePackRegistry` > 默认常量。
 * `hasLocalIndex` 单独返回，路由据此在响应里说明"来源=本地清单（未联网）"。
 */
export function resolveRegistry({ home = '', config = {} } = {}) {
  const fp = home ? localIndexPath(home) : ''
  const hasLocalIndex = !!fp && existsSync(fp)
  const configured = String(config?.knowledgePackRegistry || '').trim()
  return {
    registry: configured || DEFAULT_PACK_REGISTRY,
    origin: hasLocalIndex ? 'local' : (configured ? 'config' : 'default'),
    hasLocalIndex,
    localIndexPath: fp,
  }
}

/**
 * 下载 URL 组装（spec §11.3 R2）：基址 + 已校验的 id/version/file，并断言**与基址同源**
 * —— 清单里的 `repo`/任意 URL 一律不参与下载，防 SSRF / 钓鱼指向。不同源即抛。
 */
export function buildDownloadUrl({ registry = '', id = '', version = '', file = '' } = {}) {
  const base = String(registry || '').replace(/[\/]+$/, '')
  if (!base) throw Object.assign(new Error('未配置 registry 基址'), { code: 'registry-missing' })
  let baseUrl
  try { baseUrl = new URL(base) } catch { throw Object.assign(new Error(`registry 不是合法 URL：${base}`), { code: 'registry-invalid' }) }
  if (id && !PACK_ID_RE.test(String(id))) throw Object.assign(new Error(`包 id 不合法：${id}`), { code: 'bad-id' })
  if (version && !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(String(version))) {
    throw Object.assign(new Error(`版本号不合法：${version}`), { code: 'bad-version' })
  }
  const rel = file || `packs/${id}/${id}-${version}.zip`
  const sp = sanitizePackEntryPath(rel)
  if (!sp.ok) throw Object.assign(new Error(`下载路径不合法：${sp.error}`), { code: 'bad-path' })
  // 显式拦"绝对 URL 形态"的 file：`sanitizePackEntryPath` 只看路径段，`https://evil/x` 里的
  // `https:` 是个"看起来合法的路径段"，会被当相对路径拼到基址下——虽拼不出跨源（见下方断言），
  // 但这属于把清单里的任意 URL 当输入，语义上必须直接拒。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(sp.path)) {
    throw Object.assign(new Error(`下载路径不得是绝对 URL：${file}`), { code: 'bad-path' })
  }
  const url = new URL(`${baseUrl.pathname.replace(/[\/]+$/, '')}/${sp.path}`.replace(/\/{2,}/g, '/'), baseUrl.origin)
  if (url.origin !== baseUrl.origin) {
    throw Object.assign(new Error(`下载 URL 与 registry 不同源：${url.origin} ≠ ${baseUrl.origin}`), { code: 'registry-origin' })
  }
  return url.toString()
}
