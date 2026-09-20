'use strict'
// 启动期「源码 → 便携版」同步（开发用）。
//
// 背景（为什么需要）：
//   本机的应用实际加载 `release/YFWorking/` 这棵**便携调试版**树（electron 主进程 / bridge /
//   kernel 三条进程命令行都指向它，`kernel-paths.cjs` 也优先 `<appRoot>/kernel/cli.mjs`）。
//   而 `scripts/package-portable.cjs` 只在**手工执行时**才把 repo 拷进该树 ⇒ 平时改源码不会
//   自动进树，于是反复出现「改了源码、应用还在跑旧代码」：
//     · `kernel/cli.mjs`（工作流清单每轮重算）漏同步 ⇒ 修复一直没生效；
//     · `electron/{app-ipc,app-registry,preload}.cjs` 落后 ⇒ 渲染层调 `appNextId` 静默失效；
//     · `server/*.py` 落后 ⇒ Word/Excel 编辑返回 `{ok:true}` 却什么都没改（**假成功**）；
//     · `office_common.py` 缺失 ⇒ 新版脚本 `ModuleNotFoundError`。
//
// 为什么不用 bridge 里现成的镜像：`bootstrapKernelToUserDir` 的方向是
//   `appRoot/kernel → ~/.yfw/runtime/ponos-kernel`，那是**兜底缓存**（内核解析只在 appRoot
//   没有 kernel 时才用它），把 server/electron 镜像过去没有任何进程会加载。真正需要同步的是
//   **repo → appRoot** 这一段，此前完全没有自动化。
//
// 门控（刻意保守，避免"悄改运行中的程序"）：
//   ① 便携版根目录须有 `.yfw-dev-source.json` 标记（由 package-portable.cjs 写入，
//      记录 sourceRoot 与 autoSync）——发布出去、别的机器上 sourceRoot 不存在 ⇒ 自动 no-op；
//   ② 标记里 `autoSync` 显式 false 时不生效；③ 环境变量 `YFW_NO_DEV_SYNC=1` 可临时关闭；
//   ④ sourceRoot 必须"看起来是源码根"（含 kernel/cli.mjs + server/bridge.mjs + shared/）；
//   ⑤ sourceRoot 与 appRoot 是同一目录时不动作（dev 直跑源码的情形）。
//
// 行为：
//   · 只覆盖/补齐，**不删除**应用树里的多余文件。这不是"保守"，而是必须：
//     便携版的 `electron/` 目录里躺着 **75 个 repo 根本没有的文件**（electron.exe、*.dll、
//     chrome_*.pak、icudtl.dat 等 Electron 运行时二进制）—— 一旦按"镜像"语义删除多余文件，
//     会直接把应用搞坏。同理 runtime/ 下有下载的运行时。**例外见下面的 MIRROR_DIRS**。
//   · 比尺寸与 mtime（拷贝后把目标 mtime 对齐源文件，故未改动时不会重复拷贝）；
//   · 在 bridge 启动**之前**执行，故本次启动就能用上新代码（无需"重启两次"）。
const { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, utimesSync, unlinkSync, rmdirSync } = require('node:fs')
const { join, dirname, relative } = require('node:path')

/** 便携版根目录里的标记文件名（记录源码根与是否自动同步） */
const MARKER_FILE = '.yfw-dev-source.json'
/** 需要同步的运行时子树：内核、内核共享、服务端（含 *.py）、主进程、渲染产物、运行时静态资源 */
//   末尾的 `AGENTS.md` 是**单文件条目**（`listFiles` 已支持）：它是 **agent 自动注入入口** ——
//   工具开工自动读**仓根**同名文件，Ponos 内核也自动发现它（`kernel/prompt.mjs#discoverAgentsMd`：
//   从 cwd 逐级向上到 `.git` 所在目录 + `--add-dir` 的根）。★ 用户口径（2026-09-20）：
//   **人工测试跑的就是 release 里的便携版（调试版）** ⇒ 入口不进便携版，调试版里的 agent 就**不受规范约束**。
//   它此前不在任何同步清单里 ⇒ 从来没进过便携版（表现为"更新了也一直没有"，而非"更新后掉了"）。
//   ★ 用户口径（2026-09-20，第二次）：**开发就在调试版上跑** ⇒ `kit/`（门禁本体）与它解析的契约文档也必须进来，
//   否则调试版里没有可用 `kit:check`。注意**只带 devkit 登记的那几个 docs 文件**，不搬整个 `docs/`
//   （17MB：plans/architecture-history/eval 与门禁无关）；kit 实际只读 `docs/bridge-contract.md`
//   （`kit/cli.mjs#DOC_FILE`），另三个是发行物禁含的 devkit 件（带上便于查阅、也便于 CT12 登记放行）。
//   ⚠️ 光带代码还不够：便携版**不是 git 仓**，门禁真值是 `git ls-files` + HEAD ⇒ 根目录必须指向源仓，
//   这件事由 `kit/lib/kit-root.mjs` 处理（读 marker 的 `sourceRoot`）。
//   ⚠️ `*.test.*` 仍被 SKIP_RE 排除（测试不是运行时执行体）—— 故这里同步的 kit 是不含测试的那份；
//   `node kit/cli.mjs check` 不 import 测试，照常可用。
const SYNC_DIRS = [
  'kernel', 'shared', 'server', 'electron', 'dist', 'public', 'build/templates',
  'kit', 'docs/bridge-contract.md', 'docs/ci.md', 'docs/_anchors.json', 'docs/_anchors-allow.json',
  'AGENTS.md',
]
// 「镜像目录」：这些目录的内容**完全由构建产生**（`npm run build` 会先清空 outDir），因此源码侧
// 的目录树总是完整自洽的 —— 于是反向操作也安全：以源码为准**删掉应用树里多余的文件**。
//
// 为什么只列 dist（而不是给全树开启删除）：
//   `electron/`（75 个 Electron 运行时二进制）、`runtime/`（下载的运行时）、`public/` 与
//   `build/templates/`（手写资源）都**不是**构建产物，删错一个就是应用起不来；
//   而 `dist/` 下多余的文件**每次构建都会新增**（vite 产物名带内容哈希），不清理就无限累积
//   —— 实测一次积了 9 个文件 / 约 11MB（15M → 3.0M）。这正是本清单存在的唯一理由。
const MIRROR_DIRS = ['dist']
// 镜像前的**完整性护栏**：源码侧这些文件必须在，否则视为"构建产物不完整（构建失败/没构建）"，
// 于是**放弃该目录的镜像（一个都不删）**。宁可多留几个陈旧文件，也绝不能因为一次失败的构建
// 把正常运行所需的产物删掉——"删"比"留"的代价大得多。
const MIRROR_GUARD = { dist: 'dist/index.html' }
// 排除项：
//   · node_modules/.git/.cache —— 依赖与 VCS，不属源码同步
//   · *.log / *.bak —— 日志与备份
//   · __pycache__ —— Python 生成的字节码（同步 .py 后 Python 会按 mtime 自行重编）
//   · *.test.* —— 测试文件不是运行时执行体，同步它们只会让"这次同步了几个文件"的报告失真
const SKIP_RE = /(^|[\\/])(node_modules|\.git|\.cache|__pycache__)([\\/]|$)|\.(log|bak)$|\.test\.[cm]?[jt]s$/i

/** 该目录是否"看起来是源码根"——用三个必需文件判定（kernel/cli.mjs、server/bridge.mjs、shared/） */
function looksLikeSourceRoot(dir) {
  if (!dir || !existsSync(dir)) return false
  return existsSync(join(dir, 'kernel', 'cli.mjs'))
    && existsSync(join(dir, 'server', 'bridge.mjs'))
    && existsSync(join(dir, 'shared'))
}

function readMarker(appRoot) {
  const markerPath = join(appRoot, MARKER_FILE)
  if (!existsSync(markerPath)) return null
  try {
    const j = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (!j || typeof j.sourceRoot !== 'string' || !j.sourceRoot) return null
    return { sourceRoot: j.sourceRoot, autoSync: j.autoSync !== false, packagedAt: j.packagedAt || null, markerPath }
  } catch { return null }
}

/** 写入标记（供 package-portable.cjs 复用，保证标记格式只有一处定义） */
function writeMarker(appRoot, { sourceRoot, autoSync = true } = {}) {
  const markerPath = join(appRoot, MARKER_FILE)
  const payload = { sourceRoot, autoSync, packagedAt: new Date().toISOString() }
  writeFileSync(markerPath, JSON.stringify(payload, null, 2), 'utf8')
  return payload
}

function listFiles(root, dir) {
  const base = join(root, dir)
  const out = []
  if (!existsSync(base)) return out
  // ★ 单文件条目（如 `AGENTS.md`）：`readdirSync` 对文件会抛 ENOTDIR ⇒ 先识别再决定怎么遍历。
  //   没有这一步，"把入口文件放进同步清单"会在启动同步时直接抛错（比不同步更糟）。
  if (statSync(base).isFile()) {
    const rel = relative(root, base).replace(/\\/g, '/')
    return SKIP_RE.test(rel) ? out : [rel]
  }
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name)
      const rel = relative(root, f).replace(/\\/g, '/')
      if (SKIP_RE.test(rel)) continue
      if (e.isDirectory()) walk(f)
      else out.push(rel)
    }
  }
  walk(base)
  return out
}

/**
 * 计算需要从 sourceRoot 同步到 appRoot 的文件清单（不落盘）。
 * 判定：目标缺失 → 拷贝；**尺寸或 mtime 不同** → 拷贝。
 *
 * 为什么用"尺寸 + mtime"而不是逐文件哈希（曾用 sha256）：
 *   · 哈希要读全部内容，实测 971 个文件约 0.9s，**每次启动**都付这个代价太贵；
 *   · 尺寸+mtime 只需 stat（毫秒级）。因为是单向同步、且拷贝后会把目标 mtime **对齐**
 *     源文件（见 applySync），所以"未改动"就是"尺寸与 mtime 双等"，不会出现"每次都重拷"。
 *   · 代价：若某次编辑**同时**保持尺寸与 mtime 不变，会被漏检（极罕见；改文件必改 mtime）。
 *     需要强保证时用 `scratch/verify-probe.mjs`（哈希逐文件比对）做独立复核。
 */
function planSync({ appRoot, sourceRoot, dirs = SYNC_DIRS, mirrorDirs = MIRROR_DIRS }) {
  const toCopy = []
  const missingInApp = []
  const extraInApp = []
  let scanned = 0
  for (const d of dirs) {
    const srcFiles = listFiles(sourceRoot, d)
    const srcSet = new Set(srcFiles)
    for (const rel of srcFiles) {
      scanned++
      const s = join(sourceRoot, rel)
      const a = join(appRoot, rel)
      if (!existsSync(a)) { missingInApp.push(rel); toCopy.push(rel); continue }
      const ss = statSync(s)
      const as = statSync(a)
      if (ss.size !== as.size || Math.round(ss.mtimeMs) !== Math.round(as.mtimeMs)) toCopy.push(rel)
    }
    for (const rel of listFiles(appRoot, d)) if (!srcSet.has(rel)) extraInApp.push(rel)
  }

  // 镜像目录里的多余文件要删（其余多余文件一律保留，理由见 MIRROR_DIRS 注释）。
  // 护栏：源码侧缺 MIRROR_GUARD 声明的文件 ⇒ 判定"产物不完整"，该目录**一个都不删**。
  const toDelete = []
  const pruneSkipped = []
  for (const d of mirrorDirs) {
    const extras = extraInApp.filter((rel) => rel === d || rel.startsWith(d + '/'))
    if (!extras.length) continue
    const guard = MIRROR_GUARD[d]
    if (guard && !existsSync(join(sourceRoot, guard))) {
      pruneSkipped.push({ dir: d, reason: `源侧缺少 ${guard}（构建产物不完整？）`, skipped: extras.length })
      continue
    }
    toDelete.push(...extras)
  }
  return { toCopy, missingInApp, extraInApp, toDelete, pruneSkipped, scanned }
}

/** 删除文件后清理留下的空目录（只在确实为空时；非空一律留着，不影响正确性） */
function pruneEmptyDirs (appRoot, deletedRels) {
  const parents = new Set()
  for (const rel of deletedRels) {
    let d = dirname(rel)
    while (d && d !== '.' && d !== '/' && d !== '\\') { parents.add(d); d = dirname(d) }
  }
  // 由深到浅，先空子目录、再空父目录
  for (const d of [...parents].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(join(appRoot, d)) } catch { /* 非空或不可删（占用）—— 忽略，无碍 */ }
  }
}

function applySync(plan, { appRoot, sourceRoot }) {
  let bytes = 0
  for (const rel of plan.toCopy) {
    const s = join(sourceRoot, rel)
    const st = statSync(s)
    const a = join(appRoot, rel)
    mkdirSync(dirname(a), { recursive: true })
    copyFileSync(s, a)
    // 把目标的 mtime 对齐源文件：这样"未改动"= 尺寸与 mtime 双等，下次启动无需再拷
    // （否则每次拷贝都会把 mtime 变成"现在"，导致下一次必然又判定为已改 → 每次启动全量重写）。
    try { utimesSync(a, st.atime, st.mtime) } catch { /* 某些文件系统不支持，忽略 */ }
    bytes += st.size
  }
  // 镜像目录里的陈旧产物（vite 每次构建换新哈希名 ⇒ 旧文件不会被覆盖，只能删）
  let deleted = 0
  const deletedRels = []
  for (const rel of plan.toDelete || []) {
    try { unlinkSync(join(appRoot, rel)); deleted++; deletedRels.push(rel) } catch { /* 被占用/已删——跳过，下次再试 */ }
  }
  if (deletedRels.length) pruneEmptyDirs(appRoot, deletedRels)
  return { copied: plan.toCopy.length, bytes, deleted }
}

/**
 * 自动同步入口（由 electron/main.cjs 在启动早期调用，也可作 CLI 手动跑）。
 * 永不抛异常：任何失败都退化为 { status:'error' }，不阻断应用启动。
 */
function maybeAutoSync({ appRoot, sourceRoot: sourceOverride, env = process.env, logger = console, dryRun = false, dirs = SYNC_DIRS } = {}) {
  const t0 = Date.now()
  try {
    if (!appRoot) return { status: 'skipped', reason: 'no-app-root' }
    if (env && env.YFW_NO_DEV_SYNC) return { status: 'skipped', reason: 'env-disabled' }
    const marker = readMarker(appRoot)
    // 树的所属者显式声明"不要自动同步"时，即使调用方传了 sourceRoot 也尊重（声明优先于请求）
    if (marker && marker.autoSync === false) return { status: 'skipped', reason: 'marker-disabled' }
    // sourceRoot 有两个来源：调用方显式传入（= 明确授权，如 CLI 一次性修复），
    // 或便携版标记里记录的源码根（= 启动期自动同步）。两者都没有则无事可做。
    // 注意：仅"启动期自动"这一路径依赖 marker —— 发布到别人的机器上没有 marker ⇒ 自动 no-op。
    const sourceRoot = sourceOverride || (marker && marker.sourceRoot)
    if (!sourceRoot) return { status: 'skipped', reason: 'no-marker' }
    if (appRoot && join(sourceRoot) === join(appRoot)) return { status: 'skipped', reason: 'same-root' }
    if (!looksLikeSourceRoot(sourceRoot)) return { status: 'skipped', reason: 'source-unavailable', sourceRoot }
    const plan = planSync({ appRoot, sourceRoot, dirs })
    if (dryRun) return { status: 'dry-run', sourceRoot, ...plan, ms: Date.now() - t0 }
    const res = applySync(plan, { appRoot, sourceRoot })
    return { status: 'synced', sourceRoot, ...plan, ...res, ms: Date.now() - t0 }
  } catch (e) {
    return { status: 'error', reason: String(e && e.message || e), ms: Date.now() - t0 }
  }
}

/** 把结果格式化成一行日志（供主进程与 CLI 复用） */
function describeReport(r) {
  if (!r) return 'dev-sync: 无结果'
  if (r.status === 'skipped') return `dev-sync: 跳过（${r.reason}）`
  if (r.status === 'error') return `dev-sync: 失败（${r.reason}）——已忽略，应用继续启动`
  if (r.status === 'dry-run') {
    const del = r.toDelete && r.toDelete.length ? `，将清理 ${r.toDelete.length} 个陈旧产物` : ''
    return `dev-sync: 预演，需同步 ${r.toCopy.length}/${r.scanned} 个文件${del}`
  }
  const parts = [`dev-sync: 已同步 ${r.copied} 个文件（扫描 ${r.scanned}）`]
  if (r.missingInApp.length) parts.push(`其中补齐缺失 ${r.missingInApp.length} 个`)
  if (r.deleted) parts.push(`清理陈旧产物 ${r.deleted} 个`)
  if (r.pruneSkipped && r.pruneSkipped.length) {
    parts.push(`跳过镜像 ${r.pruneSkipped.map((s) => `${s.dir}(${s.reason})`).join('、')}`)
  }
  parts.push(`${(r.bytes / 1048576).toFixed(2)}MB`, `${r.ms}ms`)
  return parts.join('｜')
}

module.exports = {
  MARKER_FILE, SYNC_DIRS, MIRROR_DIRS, MIRROR_GUARD,
  looksLikeSourceRoot, readMarker, writeMarker, planSync, applySync, maybeAutoSync, describeReport,
}

// ── CLI：node electron/dev-source-sync.cjs [--app-root <dir>] [--source-root <dir>] [--dry-run] [--json]
if (require.main === module) {
  const argv = process.argv.slice(2)
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const appRoot = arg('--app-root') || join(__dirname, '..')
  const r = maybeAutoSync({ appRoot, sourceRoot: arg('--source-root'), dryRun: argv.includes('--dry-run') })
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else {
    console.log(describeReport(r))
    if (r.toCopy && r.toCopy.length) r.toCopy.slice(0, 40).forEach((f) => console.log('   · ' + f))
    if (r.toDelete && r.toDelete.length) r.toDelete.slice(0, 40).forEach((f) => console.log('   ✗ 清理 ' + f))
    const kept = (r.extraInApp || []).filter((f) => !(r.toDelete || []).includes(f))
    if (kept.length) console.log(`   （其余多余文件 ${kept.length} 个按约定保留：多为 Electron 运行时本体）`)
  }
  process.exit(r.status === 'error' ? 1 : 0)
}
