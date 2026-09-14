// 应用探测（Task 1.7 + 1.8）
//
// 职责：
//   detectDriver   纯判定目标该用哪个驱动（browser / process / script / uia）
//   probeWeb       用内置浏览器执行器打开目标页面并取快照（供 LLM 生成 Spec 与人工认领）
//   probeDesktop   desktop 三级降级链探测（process → script → uia），**命中即停**
//   checkApp       进入控制台前的可达性自检（只判"结构 + 目标是否存在"，不做 Spec 结构校验
//                  —— 结构校验的唯一真源是内核侧 kernel/app-spec.mjs 的 validateSpec，
//                  此处若再写一套必然漂移）
//
// ★ 为什么 desktop 的 driver 判定是"探测结果"而非 Spec 里写死的字段：
//   exePath 是否支持 CLI / 脚本接口取决于**用户机器上的实际安装**，同一 Spec 换台机器
//   可能就该降级。故判定放运行时，Spec 只记录目标是什么。
'use strict'
const { existsSync, statSync, readdirSync } = require('node:fs')
const { dirname, isAbsolute, join, basename } = require('node:path')

/** 稳定性优先的降级链：越靠前越稳定（CLI 有结构化输出 > 脚本接口 > UI 自动化） */
const SURFACE_ORDER = ['process', 'script', 'uia']

const CLI_PROBE_TIMEOUT_MS = 5000
const CLI_OUTPUT_CAP = 4000

/**
 * CLI 探测的候选参数（**依次尝试、命中即停**）。
 * ★ 为什么不止 `--help`：不同程序把帮助/版本打到不同开关上，尤其 Windows GUI 程序。
 *   真机（2026-09-14，Aseprite）：只试 `--help` 时，用户填入**安装目录**或指向 `.bat` 包装器
 *   都会失败，而界面只回一句"未发现 CLI/脚本接口"，把"路径写错/包装器没跑起来"误导成
 *   "这程序没有命令行" —— 用户据此以为系统的"获取配置"是坏的（实际 Aseprite 自带完整 CLI）。
 *   多试几个开关 + 如实上报每个开关的输出，才能让用户自我纠正。
 */
const HELP_ARGS_LIST = [['--help'], ['-h'], ['--version'], ['/?']]

/** Windows 批处理：execFile 拉不起来（需 shell），单独走一条路径 */
const isBatchFile = (p) => /\.(bat|cmd)$/i.test(String(p || ''))

/**
 * 判定 driver。
 * @param {{ target?: {type?:string,url?:string,exePath?:string}, probe?: Function }} p
 * @returns {Promise<{driver:string, evidence:object}>}
 */
async function detectDriver({ target, probe } = {}) {
  const type = target?.type
  if (type === 'web') return { driver: 'browser', evidence: { url: target.url } }
  if (type === 'desktop') {
    const probed = probe ? await probe({ exePath: target.exePath }) : { level: 'uia' }
    const level = SURFACE_ORDER.includes(probed?.level) ? probed.level : 'uia'
    // 扁平化证据：probeDesktop 返回 { level, evidence }，若原样塞进 evidence 会变成
    // evidence.evidence.help 这种双层嵌套（渲染层与日志读起来都要猜两层）
    return { driver: level, evidence: { level, ...(probed?.evidence || {}) } }
  }
  throw new Error(`不支持的 target.type: ${String(type)}`)
}

/** web 探测：打开页面并取快照（步骤复用浏览器执行器，不另造导航逻辑） */
async function probeWeb({ url, executor, sessionId }) {
  if (!executor) throw new Error('缺少 browserExecutor')
  const nav = await executor.exec(sessionId, 'goto', { url })
  if (!nav?.ok) throw new Error(`导航失败：${nav?.error || '未知'}`)
  const snap = await executor.exec(sessionId, 'snapshot', {})
  const snapshot = snap?.snapshot ?? null
  // 真实快照把页级字段放在 page 下（browser-common.cjs 的 buildSnapshot）；
  // 早期写成 snapshot.title 会恒为 null（真机验收发现探测结果标题为空）。
  return { url, snapshot, title: snapshot?.page?.title ?? snapshot?.title ?? null }
}

/**
 * desktop 三级探测：命中即停；探测抛错只降级、不冒泡（探测失败不该阻断进入控制台）。
 *
 * ★ **每层的真实失败原因必须带回去**（evidence.attempts）：过去只返回一句
 *   "未发现 CLI/脚本接口"，上层据此写出的用户提示把"路径不是文件""批处理没跑起来"
 *   统统说成"该程序没有命令行"，用户无法自我纠正（真机 2026-09-14 Aseprite 反馈）。
 * @returns {Promise<{level:'process'|'script'|'uia', evidence:object}>}
 */
async function probeDesktop({ exePath, deps = {} } = {}) {
  const processProbe = deps.processProbe || defaultProcessProbe
  const scriptProbe = deps.scriptProbe || defaultScriptProbe
  if (!exePath) return { level: 'uia', evidence: { level: 'uia', note: '缺少 exePath' } }
  const attempts = []
  try {
    const p = await processProbe({ exePath })
    if (p?.ok) return { level: 'process', evidence: p }      // ★ 命中即停
    attempts.push({ level: 'process', reason: p?.reason || '未发现 CLI 接口' })
  } catch (e) {
    // 降级：CLI 探测失败（无 CLI / 超时 / 拒绝访问）不是错误，是"该层不可用"
    attempts.push({ level: 'process', reason: `探测异常：${String(e?.message || e)}` })
  }
  try {
    const s = await scriptProbe({ exePath })
    if (s?.ok) return { level: 'script', evidence: s }       // ★ 命中即停
    attempts.push({ level: 'script', reason: s?.reason || '未发现脚本/扩展目录' })
  } catch (e) {
    attempts.push({ level: 'script', reason: `探测异常：${String(e?.message || e)}` })
  }
  return { level: 'uia', evidence: { level: 'uia', note: '未发现 CLI / 脚本接口，降级到 UI 自动化', attempts } }
}

/** 系统目录黑名单：探测绝不执行这些目录下的可执行文件（探测会真的跑进程，必须挡在最前） */
function isSystemPath(p) {
  const lower = p.toLowerCase()
  const winDir = (process.env.SystemRoot || process.env.windir || 'C:\\Windows').toLowerCase()
  const unixDeny = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/etc/', '/dev/', '/boot/']
  if (process.platform !== 'win32') return unixDeny.some((d) => lower.startsWith(d))
  return lower.startsWith(winDir + '\\') || lower.startsWith('c:\\windows\\') || lower.startsWith('c:\\program files\\windows')
}

/**
 * 用户在界面里填了**安装目录**而不是具体程序时，替他在目录里找出主程序。
 * ★ 真机（2026-09-14）：用户对 `D:\Program Files (x86)\Aseprite` 整个目录发起封装 → 旧实现
 *   `statSync().isFile()` 为假 → 直接判"未发现 CLI"，而该目录下的 `aseprite.exe --help`
 *   **有 5.8KB 完整帮助输出**（CLI 明明可用）。填目录是很自然的操作，探测层应当容错而不是误导。
 * 选法：① 与目录同名的 exe（Aseprite/aseprite.exe）；② 目录里唯一的 exe。
 * 多候选且无同名 → 返回 null（宁可不猜，也不拿 gen.exe 这种辅助程序去当主程序）。
 */
function findMainExeInDir(dir) {
  let names = []
  try { names = readdirSync(dir).filter((n) => /\.exe$/i.test(n)) } catch { return null }
  const cand = names.filter((n) => !/^(unins|setup|install|vc_?redist|dxsetup|update)/i.test(n))
  const base = String(basename(dir)).toLowerCase()
  const same = cand.find((n) => n.toLowerCase().replace(/\.exe$/, '') === base)
  if (same) return join(dir, same)
  return cand.length === 1 ? join(dir, cand[0]) : null
}

/**
 * CLI 探测真实实现（带安全守卫）。
 * 守卫顺序：绝对路径 → 存在 → 是**文件**（是目录则先解析主程序）→ 非系统目录 → 才执行探测。
 * 注意探测命令常以非零码退出（usage 打到 stderr/stdout），故**不把退出码当失败**，
 * 判定标准是"有非空输出"；`--help/-h/--version//?` 依次尝试，命中即停。
 *
 * @returns {Promise<object>} 失败时必带 `reason`（供上层如实展示）与 `tried`（各开关的输出情况）
 */
async function defaultProcessProbe({ exePath }) {
  if (!exePath || typeof exePath !== 'string') return { ok: false, reason: '缺少 exePath' }
  if (!isAbsolute(exePath)) return { ok: false, reason: 'exePath 必须是绝对路径' }
  if (!existsSync(exePath)) return { ok: false, reason: '可执行文件不存在' }
  let resolved = exePath
  try {
    if (statSync(exePath).isDirectory()) {
      const found = findMainExeInDir(exePath)
      if (!found) return { ok: false, reason: `${exePath} 是目录，且其中没有可确定的主程序（含多个 .exe），请直接指向具体程序文件` }
      resolved = found
    } else if (!statSync(exePath).isFile()) {
      return { ok: false, reason: 'exePath 不是文件' }
    }
  } catch { return { ok: false, reason: '无法读取文件信息' } }
  if (isSystemPath(resolved)) return { ok: false, reason: '拒绝探测系统目录下的可执行文件' }
  if (!/\.(exe|cmd|bat|com)$/i.test(resolved) && process.platform === 'win32') {
    return { ok: false, reason: '非可执行后缀' }
  }
  const tried = []
  for (const args of HELP_ARGS_LIST) {
    const out = await runHelp(resolved, args)
    const text = String(out.stdout || '').trim()
    tried.push({ args: args.join(' '), exitCode: out.exitCode, outLen: text.length, err: text ? '' : String(out.stderr || '').trim().slice(0, 160) })
    if (text) {
      return {
        ok: true,
        help: text.slice(0, CLI_OUTPUT_CAP),
        args,
        exePath: resolved,
        // 目录输入被解析出真实程序时要回传，调用方据此把 spec 的 exePath 修正掉
        ...(resolved === exePath ? {} : { resolvedFrom: exePath }),
        tried,
      }
    }
  }
  return {
    ok: false,
    // 把"实际跑的是哪个程序"写进原因：用户填目录时，这条是他核对路径的唯一线索
    reason: `${resolved === exePath ? '' : `已在目录中识别主程序 ${resolved}；`}试过 --help / -h / --version / /? 都没有输出（视为无 CLI 接口）`,
    tried,
    exePath: resolved,
  }
}

/**
 * 跑一次探测命令：任何失败都转成结构化结果，不抛（探测层不该把 EPERM 变成崩溃）。
 * ★ Windows 的 `.bat/.cmd` **不能**被 execFile 直接拉起（Node 对批处理要求 shell：
 *   否则 EINVAL/ENOENT）——真机反例：用户已有的 `C:\Users\T203-15\ase-cli\ase-cli.bat`
 *   包装器明明能打印帮助（内部调 bash），却因这条恒失败被判成"该程序没有 CLI"。
 *   故批处理走 shell，并把路径加引号（安装路径常含空格）。
 */
function runHelp(exePath, args = ['--help']) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const { execFile, exec } = require('node:child_process')
      const opts = { timeout: CLI_PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }
      const cb = (err, stdout, stderr) => done({ exitCode: err?.code ?? 0, stdout, stderr })
      const child = isBatchFile(exePath)
        ? exec(`"${exePath}" ${args.join(' ')}`, opts, cb)
        : execFile(exePath, args, opts, cb)
      child.on?.('error', (e) => done({ exitCode: -1, stdout: '', stderr: String(e?.message || e) }))
    } catch (e) {
      done({ exitCode: -1, stdout: '', stderr: String(e?.message || e) })
    }
  })
}

/** 脚本接口探测：同级目录是否具备常见脚本/扩展目录（只读文件系统，不执行任何东西） */
async function defaultScriptProbe({ exePath }) {
  if (!exePath || !isAbsolute(exePath)) return { ok: false, reason: '需要绝对路径' }
  const dir = dirname(exePath)
  if (!existsSync(dir)) return { ok: false, reason: '目录不存在' }
  const SCRIPT_DIRS = ['scripts', 'Scripts', 'extensions', 'Extensions', 'plugins', 'Plugins', 'lua', 'python']
  const found = SCRIPT_DIRS.filter((d) => existsSync(join(dir, d)))
  return found.length > 0
    ? { ok: true, dir, scriptDirs: found }
    : { ok: false, reason: '未发现脚本/扩展目录' }
}

/**
 * 进入控制台前的自检（只做"本地可判定"的事实检查，不重复 Spec 结构校验）。
 * @returns {Promise<{status:'healthy'|'drifted'|'broken', issues:string[]}>}
 */
async function checkApp({ spec } = {}) {
  const issues = []
  if (!spec || typeof spec !== 'object') return { status: 'broken', issues: ['Spec 缺失或损坏'] }
  if (!Array.isArray(spec.commands) || spec.commands.length === 0) issues.push('Spec 未定义任何命令')

  const type = spec.target?.type
  let status = 'healthy'
  if (type === 'web') {
    const url = spec.target?.url
    let ok = false
    try { const u = new URL(url); ok = u.protocol === 'http:' || u.protocol === 'https:' } catch { ok = false }
    if (!ok) { issues.push(`web 目标 URL 不合法：${String(url)}`); status = 'broken' }
  } else if (type === 'desktop') {
    const exePath = spec.target?.exePath
    if (!exePath) { issues.push('desktop 目标缺少 exePath'); status = 'broken' }
    else if (!isAbsolute(exePath)) { issues.push('exePath 必须是绝对路径'); status = 'broken' }
    else if (!existsSync(exePath)) { issues.push(`可执行文件不存在：${exePath}`); status = 'broken' }
    else if (spec.driver === 'browser') { issues.push('driver 与 target.type 不一致'); status = 'drifted' }
  } else {
    issues.push(`target.type 不合法：${String(type)}`)
    status = 'broken'
  }
  // 有 issue 但状态还是 healthy ⇒ 必然是"非致命结构问题"（如未定义命令）——一律按 broken 处理。
  // 不能出现"issues 非空却显示健康"的自相矛盾状态（UI 会据此让用户进入一个空壳控制台）。
  if (issues.length > 0 && status === 'healthy') status = 'broken'
  return { status, issues }
}

module.exports = {
  detectDriver, probeWeb, probeDesktop, checkApp,
  defaultProcessProbe, defaultScriptProbe, isSystemPath,
  SURFACE_ORDER, CLI_PROBE_TIMEOUT_MS, CLI_OUTPUT_CAP,
}
