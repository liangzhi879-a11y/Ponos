// desktop 目标的三级执行：process / script / uia（Task 2.2）
//
// driver 语义（与 Spec 的步骤 act 一一对应）：
//   process → {act:'cli',    argv:[...]}                  execFile 一个 CLI 子命令
//   script  → {act:'script', lang, file|code}             交给对应脚本宿主执行
//   uia     → {act:'focus'|'click'|'type'|'key'|'wait'}   UI 自动化兜底
//
// 所有外呼能力都走 deps 注入（生产用默认实现，测试注入假实现）——因为真实执行会拉起
// 用户机器上的进程，必须能在单测里完全隔离。
'use strict'
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { interpolate, checkRequired } = require('./app-util.cjs')

const execFileAsync = promisify(execFile)

const CLI_TIMEOUT = 30000
const CLI_MAX_BUFFER = 4 * 1024 * 1024

/** argv 插值（导出于 plan 契约，测试直接断言） */
function buildArgv(argv = [], args = {}) {
  return (Array.isArray(argv) ? argv : []).map((a) => interpolate(a, args))
}

async function runCli({ exePath, argv = [], timeout = CLI_TIMEOUT }) {
  try {
    const { stdout, stderr } = await execFileAsync(exePath, argv, {
      timeout, encoding: 'utf-8', windowsHide: true, maxBuffer: CLI_MAX_BUFFER,
    })
    return { ok: true, stdout, stderr }
  } catch (e) {
    // CLI 非零退出/超时不是异常，是"这条命令失败了"——把 stdout/stderr 一并回传供诊断
    return { ok: false, error: String(e?.message || e), stdout: e?.stdout || '', stderr: e?.stderr || '', exitCode: e?.code ?? null }
  }
}

/** 脚本宿主映射：file 优先，其次 -e 内联代码 */
const SCRIPT_HOSTS = { lua: (exePath) => exePath, python: () => 'python', node: () => process.execPath }

async function runScript({ lang, file, code, exePath, timeout = CLI_TIMEOUT }) {
  const hostOf = SCRIPT_HOSTS[lang]
  if (!hostOf) return { ok: false, error: `不支持的脚本语言：${String(lang)}` }
  const host = hostOf(exePath)
  if (!host) return { ok: false, error: `脚本宿主不可用：${String(lang)}` }
  const argv = file ? [file] : ['-e', String(code ?? '')]
  try {
    const { stdout, stderr } = await execFileAsync(host, argv, {
      timeout, encoding: 'utf-8', windowsHide: true, maxBuffer: CLI_MAX_BUFFER,
    })
    return { ok: true, stdout, stderr }
  } catch (e) {
    return { ok: false, error: String(e?.message || e), stdout: e?.stdout || '', stderr: e?.stderr || '' }
  }
}

/**
 * UI 自动化兜底。**当前未接入后端**（Windows UIA / SendKeys 需要原生依赖，
 * 本机净室产物不含）——故明确返回"未接入"，绝不假装成功：
 * 假装成功会让 Spec 的 write 命令静默空转，比直接报错危险得多。
 */
async function runUia({ act } = {}) {
  return { ok: false, error: `UI 自动化后端尚未接入（uia 兜底路径，act=${String(act)}）` }
}

/**
 * 执行一条 desktop 命令。
 * @returns {Promise<{ok:boolean, data:any, error:string|null, kind:string, durationMs:number}>}
 */
async function desktopRunner({ appId, action, args = {}, spec, deps = {} }) {
  const runCliFn = deps.runCli || runCli
  const runScriptFn = deps.runScript || runScript
  const runUiaFn = deps.runUia || runUia
  const startedAt = Date.now()

  const driver = spec?.driver
  if (!['process', 'script', 'uia'].includes(driver)) {
    return { ok: false, data: null, error: `不支持的 driver：${String(driver)}`, kind: 'unknown', durationMs: 0 }
  }
  const cmd = spec?.commands?.find((c) => c.action === action)
  if (!cmd) return { ok: false, data: null, error: `未找到命令：${action}`, kind: 'unknown', durationMs: 0 }

  const req = checkRequired(cmd.params, args)
  if (!req.ok) {
    return { ok: false, data: null, error: req.errors.join('；'), kind: cmd.kind ?? 'unknown', durationMs: Date.now() - startedAt }
  }

  try {
    let saved = null
    for (const step of cmd.steps || []) {
      if (driver === 'process' && step.act === 'cli') {
        const res = await runCliFn({ exePath: spec.target?.exePath, argv: buildArgv(step.argv, args), timeout: step.timeout })
        if (!res.ok) throw new Error(res.error || 'CLI 执行失败')
        if (step.save) saved = res.stdout
      } else if (driver === 'script' && step.act === 'script') {
        const res = await runScriptFn({
          lang: step.lang, file: step.file,
          code: interpolate(step.code, args),
          exePath: spec.target?.exePath, timeout: step.timeout,
        })
        if (!res.ok) throw new Error(res.error || '脚本执行失败')
        if (step.save) saved = res.stdout
      } else if (driver === 'uia') {
        const res = await runUiaFn({ ...step, value: interpolate(step.value, args) })
        if (!res.ok) throw new Error(res.error || 'UI 自动化失败')
        if (step.save) saved = res
      } else {
        throw new Error(`driver=${driver} 不支持步骤 ${String(step.act)}`)
      }
    }
    return { ok: true, data: saved, error: null, kind: cmd.kind ?? 'unknown', durationMs: Date.now() - startedAt }
  } catch (e) {
    return { ok: false, data: null, error: String(e?.message || e), kind: cmd.kind ?? 'unknown', durationMs: Date.now() - startedAt }
  }
}

module.exports = { desktopRunner, buildArgv, runCli, runScript, runUia, SCRIPT_HOSTS, CLI_TIMEOUT }
