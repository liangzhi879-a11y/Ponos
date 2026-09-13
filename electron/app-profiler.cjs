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
const { existsSync, statSync } = require('node:fs')
const { dirname, isAbsolute, join, parse } = require('node:path')

/** 稳定性优先的降级链：越靠前越稳定（CLI 有结构化输出 > 脚本接口 > UI 自动化） */
const SURFACE_ORDER = ['process', 'script', 'uia']

const CLI_PROBE_TIMEOUT_MS = 5000
const CLI_OUTPUT_CAP = 4000

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
 * @returns {Promise<{level:'process'|'script'|'uia', evidence:object}>}
 */
async function probeDesktop({ exePath, deps = {} } = {}) {
  const processProbe = deps.processProbe || defaultProcessProbe
  const scriptProbe = deps.scriptProbe || defaultScriptProbe
  if (!exePath) return { level: 'uia', evidence: { note: '缺少 exePath' } }
  try {
    const p = await processProbe({ exePath })
    if (p?.ok) return { level: 'process', evidence: p }      // ★ 命中即停
  } catch (e) {
    // 降级：CLI 探测失败（无 CLI / 超时 / 拒绝访问）不是错误，是"该层不可用"
  }
  try {
    const s = await scriptProbe({ exePath })
    if (s?.ok) return { level: 'script', evidence: s }       // ★ 命中即停
  } catch (e) {
    // 同上，继续降级
  }
  return { level: 'uia', evidence: { level: 'uia', note: '未发现 CLI/脚本接口，降级到 UI 自动化' } }
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
 * CLI 探测真实实现（带安全守卫）。
 * 守卫顺序：绝对路径 → 存在且是文件 → 非系统目录 → 才执行 `--help`。
 * 注意 `--help` 常以非零码退出（usage 打到 stderr/stdout），故**不把退出码当失败**，
 * 判定标准是"有非空输出"。
 */
async function defaultProcessProbe({ exePath }) {
  if (!exePath || typeof exePath !== 'string') return { ok: false, reason: '缺少 exePath' }
  if (!isAbsolute(exePath)) return { ok: false, reason: 'exePath 必须是绝对路径' }
  if (!existsSync(exePath)) return { ok: false, reason: '可执行文件不存在' }
  try { if (!statSync(exePath).isFile()) return { ok: false, reason: 'exePath 不是文件' } } catch { return { ok: false, reason: '无法读取文件信息' } }
  if (isSystemPath(exePath)) return { ok: false, reason: '拒绝探测系统目录下的可执行文件' }
  if (!/\.(exe|cmd|bat|com)$/i.test(exePath) && process.platform === 'win32') {
    return { ok: false, reason: '非可执行后缀' }
  }
  const out = await runHelp(exePath)
  const text = String(out.stdout || '').trim()
  return text.length > 0
    ? { ok: true, help: text.slice(0, CLI_OUTPUT_CAP), args: ['--help'] }
    : { ok: false, reason: '--help 无输出（视为无 CLI 接口）', exitCode: out.exitCode }
}

/** 跑一次 `--help`：任何失败都转成结构化结果，不抛（探测层不该把 EPERM 变成崩溃） */
function runHelp(exePath) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const { execFile } = require('node:child_process')
      const child = execFile(exePath, ['--help'], {
        timeout: CLI_PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        done({ exitCode: err?.code ?? 0, stdout, stderr })
      })
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
