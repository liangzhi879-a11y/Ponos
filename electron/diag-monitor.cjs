'use strict'
const { existsSync, readFileSync, accessSync, mkdirSync, writeFileSync, rmSync } = require('fs')
const { join, resolve } = require('path')
const os = require('os')
const http = require('http')
const { spawn, spawnSync } = require('child_process')

const GROUPS = ['core', 'session', 'browser', 'doc', 'extras', 'config', 'network', 'render']

const CHECKS = [
  { id: 'kernel-files', group: 'core', label: 'diagnostic.check.kernelFiles' },
  { id: 'kernel-bootstrap', group: 'core', label: 'diagnostic.check.kernelBootstrap' },
  { id: 'kernel-launch', group: 'core', label: 'diagnostic.check.kernelLaunch', timeoutMs: 16000 },
  { id: 'bridge-port', group: 'core', label: 'diagnostic.check.bridgePort' },
  { id: 'bridge-alive', group: 'core', label: 'diagnostic.check.bridgeAlive' },
  { id: 'kernel-session', group: 'core', label: 'diagnostic.check.kernelSession' },
  { id: 'kernel-crash', group: 'core', label: 'diagnostic.check.kernelCrash' },
  { id: 'transcript-dir', group: 'session', label: 'diagnostic.check.transcriptDir' },
  { id: 'transcript-index', group: 'session', label: 'diagnostic.check.transcriptIndex' },
  { id: 'executor-connected', group: 'browser', label: 'diagnostic.check.executorConnected' },
  { id: 'executor-window', group: 'browser', label: 'diagnostic.check.executorWindow' },
  { id: 'browser-whitelist', group: 'browser', label: 'diagnostic.check.browserWhitelist' },
  { id: 'python-runtime', group: 'doc', label: 'diagnostic.check.pythonRuntime' },
  { id: 'office-ocr', group: 'doc', label: 'diagnostic.check.officeOcr' },
  { id: 'pet-alive', group: 'extras', label: 'diagnostic.check.petAlive' },
  { id: 'doubao-session', group: 'extras', label: 'diagnostic.check.doubaoSession' },
  { id: 'editor-available', group: 'extras', label: 'diagnostic.check.editorAvailable' },
  { id: 'config-valid', group: 'config', label: 'diagnostic.check.configValid' },
  { id: 'provider-valid', group: 'config', label: 'diagnostic.check.providerValid' },
  { id: 'data-dirs', group: 'config', label: 'diagnostic.check.dataDirs' },
  { id: 'skills-index', group: 'config', label: 'diagnostic.check.skillsIndex' },
  { id: 'last-boot', group: 'config', label: 'diagnostic.check.lastBoot' },
  { id: 'provider-reach', group: 'network', label: 'diagnostic.check.providerReach' },
  { id: 'gpu-health', group: 'render', label: 'diagnostic.check.gpuHealth' },
  { id: 'render-health', group: 'render', label: 'diagnostic.check.renderHealth' },
]

// dev 调试版经 PONOS_HOME env 指向独立目录（与 main.cjs ponosHome() 同口径）
const PONOS_HOME = process.env.PONOS_HOME ? resolve(process.env.PONOS_HOME) : join(os.homedir(), '.ponos')

function timeout(p, ms, tag) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' timeout')), ms))])
}

function httpHealth(url, ms = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.setTimeout(ms)
  })
}

function getJson(url, ms = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let buf = ''
      res.on('data', (d) => buf += d)
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch (_) { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.setTimeout(ms)
  })
}

function runProbe(cmdArgs, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let stdout = '', stderr = ''
    let done = false
    const finish = (ok, exitCode) => { if (!done) { done = true; resolve({ ok, stdout, stderr, exitCode, latencyMs: Date.now() - t0 }) } }
    let proc
    try {
      proc = spawn(cmdArgs.join(' '), { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { return finish(false, -1) }
    const timer = setTimeout(() => {
      // Windows 专用：shell:true 下 proc 是 cmd shell，proc.kill() 只杀 shell 不杀孙进程；
      // 必须先 taskkill /T 杀整棵进程树（含 bun 等孙进程），防超时孤儿——顺序不能反：
      // 若先 kill 掉根 shell，Windows 无"父亡子随灭"语义，taskkill 就无树可枚举了。
      try { spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 }) } catch (_) {}
      try { proc.kill() } catch (_) {}  // taskkill 缺失/失败时的兜底
      finish(false, -2)
    }, ms)
    proc.stdout.on('data', (d) => stdout += d.toString())
    proc.stderr.on('data', (d) => stderr += d.toString())
    proc.on('close', (code) => { clearTimeout(timer); finish(code === 0, code) })
    proc.on('error', () => { clearTimeout(timer); finish(false, -3) })
  })
}

// 注意（协调者决议）：logTee 为可选依赖——Task 5 的 IPC diag:export 会传真身；
// 缺省值时单测（不传 logTee）也能直接跑，exportReport 的日志尾默认空。
function createDiagMonitor({ ctx, logTee = { getLogTail: () => [] }, bridgePort = process.env.PONOS_BRIDGE_PORT || '51311' }) {
  let lastSnapshot = null
  let onChange = null
  let timer = null
  let kernelCheckInflight = false

  const bridgeInfo = () => getJson(`http://127.0.0.1:${bridgePort}/diag/info`)

  async function checkKernelFiles() {
    const { kernel, bun } = ctx.appPaths
    return { status: kernel && bun && existsSync(kernel) && existsSync(bun) ? 'ok' : 'error',
      detail: `kernel=${kernel || '?'} bun=${bun || '?'}` }
  }

  async function checkKernelBootstrap() {
    const k = join(PONOS_HOME, 'runtime', 'kernel', 'cli.mjs')
    const b = join(PONOS_HOME, 'runtime', 'bun', 'bun.exe')
    const ok = existsSync(k) && existsSync(b)
    return { status: ok ? 'ok' : 'warn', detail: ok ? `cached kernel=${k}` : '未生成 bootstrap 缓存（首次启动自动创建）' }
  }

  async function checkKernelLaunch() {
    // runProbe 自带 15s 内部超时已足够；16000 由 CHECKS 的 timeoutMs 在 runAll/rerun 层兜底
    const r = await runProbe([`"${ctx.appPaths.bun}"`, `"${ctx.appPaths.kernel}"`, '--version'], 15000).catch(() => ({ ok: false }))
    return { status: r.ok && /\(Ponos\)/.test(r.stdout) ? 'ok' : 'error', detail: `stdout=${r.stdout?.trim() || ''} exit=${r.exitCode}` }
  }

  async function checkBridgePort() {
    const ok = await httpHealth(`http://127.0.0.1:${bridgePort}/health`)
    return { status: ok ? 'ok' : 'error', detail: `port ${bridgePort} health=${ok}` }
  }

  async function checkBridgeAlive() {
    const restarts = ctx.bridgeRestartCount()
    return { status: restarts <= 3 ? 'ok' : 'warn', detail: `bridge 重启计数=${restarts}` }
  }

  async function checkKernelSession() {
    const info = await bridgeInfo()
    if (!info?.data) return { status: 'unknown', detail: 'bridge 未就绪' }
    const { firstTokenOk, firstTokenTotal } = info.data
    if (firstTokenTotal === 0) return { status: 'ok', detail: '尚无会话' }
    return { status: firstTokenOk >= firstTokenTotal ? 'ok' : 'warn', detail: `首 token ${firstTokenOk}/${firstTokenTotal}` }
  }

  async function checkKernelCrash() {
    const info = await bridgeInfo()
    if (!info?.data) return { status: 'unknown', detail: 'bridge 未就绪' }
    return { status: info.data.kernelCrashCount === 0 ? 'ok' : 'warn', detail: `内核异常退出 ${info.data.kernelCrashCount} 次` }
  }

  async function checkTranscriptDir() {
    const dir = join(PONOS_HOME, 'sessions')
    try { accessSync(dir); return { status: 'ok', detail: dir } } catch (_) { return { status: 'error', detail: `不可读: ${dir}` } }
  }

  async function checkTranscriptIndex() {
    const r = await getJson(`http://127.0.0.1:${bridgePort}/transcript/list?cwd=${encodeURIComponent(process.cwd())}`)
    return { status: r && r.ok ? 'ok' : 'error', detail: r?.ok ? `${r.sessions?.length ?? 0} 会话索引` : 'transcript 端点异常' }
  }

  async function checkExecutorConnected() {
    try { const s = await ctx.executorStatus(); return { status: s.connected ? 'ok' : 'error', detail: `connected=${s.connected}` } } catch (_) { return { status: 'unknown', detail: '查询失败' } }
  }

  async function checkExecutorWindow() {
    try { const s = await ctx.executorStatus(); return { status: s.windows > 0 || s.connected ? 'ok' : 'warn', detail: `windows=${s.windows}` } } catch (_) { return { status: 'unknown', detail: '查询失败' } }
  }

  async function checkBrowserWhitelist() {
    const p = join(PONOS_HOME, 'browser-whitelist.json')
    try { JSON.parse(readFileSync(p, 'utf-8')); return { status: 'ok', detail: p } } catch (_) { return { status: 'warn', detail: '白名单缺失或不可解析（可选文件）' } }
  }

  async function checkPythonRuntime() {
    const p = ctx.appPaths.python
    // 裸命令名（如 'python'）existsSync 会相对 cwd 误报；Task 5 注入绝对路径或 null，monitor 只管 null 分支
    if (p == null) return { status: 'unknown', detail: '无 python 运行时' }
    return { status: existsSync(p) ? 'ok' : 'error', detail: `python=${p}` }
  }

  async function checkOfficeOcr() {
    if (!ctx.appPaths.python) return { status: 'unknown', detail: '无 python 运行时' }
    const r = await timeout(runProbe([`"${ctx.appPaths.python}"`, '--version'], 5000).catch(() => ({ ok: false })), 6000, 'python')
    return { status: r.ok ? 'ok' : 'error', detail: r.stdout?.trim() || `exit=${r.exitCode}` }
  }

  async function checkPetAlive() {
    return { status: ctx.petAlive() ? 'ok' : 'warn', detail: ctx.petAlive() ? '宠物进程存活' : '宠物未启用' }
  }

  async function checkDoubaoSession() {
    const p = join(PONOS_HOME, 'doubao-session.json')
    try { JSON.parse(readFileSync(p, 'utf-8')); return { status: 'ok', detail: p } } catch (_) { return { status: 'warn', detail: '无豆包会话文件（未使用过）' } }
  }

  async function checkEditorAvailable() {
    // 编辑器依赖原生窗口；仅做基础资源存在性检查
    return { status: 'ok', detail: '编辑器窗口能力正常（随主进程）' }
  }

  async function checkConfigValid() {
    const files = [join(PONOS_HOME, 'config.json'), join(PONOS_HOME, 'settings.json')]
    const bad = files.filter(f => { try { JSON.parse(readFileSync(f, 'utf-8')); return false } catch (_) { return true } })
    return { status: bad.length ? 'error' : 'ok', detail: bad.length ? `不可解析: ${bad.join(',')}` : 'config/settings 可解析' }
  }

  async function checkProviderValid() {
    try {
      const cfg = JSON.parse(readFileSync(join(PONOS_HOME, 'config.json'), 'utf-8'))
      const p = cfg.provider || (cfg.providers || [])[0]
      return { status: p?.apiBaseUrl && p?.apiKey ? 'ok' : 'warn', detail: p?.apiBaseUrl || '未配置完整 provider' }
    } catch (_) { return { status: 'error', detail: 'config.json 不可用' } }
  }

  async function checkDataDirs() {
    const dirs = ['sessions', 'skills', 'memory', 'chats'].map(d => join(PONOS_HOME, d))
    const bad = dirs.filter(d => { try { mkdirSync(d, { recursive: true }); const f = join(d, '.diag-probe'); writeFileSync(f, '1'); rmSync(f); return false } catch (_) { return true } })
    return { status: bad.length ? 'error' : 'ok', detail: bad.length ? `不可写: ${bad.join(',')}` : '数据目录可写' }
  }

  async function checkSkillsIndex() {
    const p = join(PONOS_HOME, 'skills', '_skill_index.json')
    try { JSON.parse(readFileSync(p, 'utf-8')); return { status: 'ok', detail: '技能索引可解析' } } catch (_) { return { status: 'warn', detail: '技能索引缺失（首次扫描后生成）' } }
  }

  async function checkLastBoot() {
    try {
      const b = JSON.parse(readFileSync(join(PONOS_HOME, 'logs', 'last-boot.json'), 'utf-8'))
      return { status: b.ok ? 'ok' : 'warn', detail: b.ok ? '上次启动正常' : `上次启动异常（${b.failedAt}）` }
    } catch (_) { return { status: 'unknown', detail: '无启动记录（首启）' } }
  }

  async function checkProviderReach() {
    const info = await bridgeInfo()
    if (!info?.data?.lastApiSuccessAt) return { status: 'unknown', detail: '尚无 API 成功记录' }
    const age = Date.now() - info.data.lastApiSuccessAt
    return { status: age < 7 * 24 * 3600 * 1000 ? 'ok' : 'warn', detail: `最近成功 ${Math.round(age / 3600 / 1000)}h 前` }
  }

  async function checkGpuHealth() {
    const c = ctx.gpuCrashCount()
    return { status: c === 0 ? 'ok' : 'warn', detail: `GPU 崩溃 ${c} 次` }
  }

  async function checkRenderHealth() {
    const c = ctx.renderCrashCount()
    return { status: c === 0 ? 'ok' : 'warn', detail: `渲染崩溃 ${c} 次` }
  }

  const IMPL = {
    'kernel-files': checkKernelFiles, 'kernel-bootstrap': checkKernelBootstrap, 'kernel-launch': checkKernelLaunch,
    'bridge-port': checkBridgePort, 'bridge-alive': checkBridgeAlive, 'kernel-session': checkKernelSession,
    'kernel-crash': checkKernelCrash, 'transcript-dir': checkTranscriptDir, 'transcript-index': checkTranscriptIndex,
    'executor-connected': checkExecutorConnected, 'executor-window': checkExecutorWindow, 'browser-whitelist': checkBrowserWhitelist,
    'python-runtime': checkPythonRuntime, 'office-ocr': checkOfficeOcr, 'pet-alive': checkPetAlive,
    'doubao-session': checkDoubaoSession, 'editor-available': checkEditorAvailable, 'config-valid': checkConfigValid,
    'provider-valid': checkProviderValid, 'data-dirs': checkDataDirs, 'skills-index': checkSkillsIndex,
    'last-boot': checkLastBoot, 'provider-reach': checkProviderReach, 'gpu-health': checkGpuHealth,
    'render-health': checkRenderHealth,
  }

  function aggregate(checks) {
    if (checks.some(c => c.status === 'error')) return 'error'
    if (checks.some(c => c.status === 'warn')) return 'warn'
    return 'ok'
  }

  function itemTimeout(c) { return c.timeoutMs ?? (c.group === 'network' ? 8000 : 3000) }

  async function runAll() {
    const now = Date.now()
    const results = await Promise.all(CHECKS.map(async (c) => {
      const t0 = Date.now()
      try {
        const r = await timeout(Promise.resolve(IMPL[c.id]()), itemTimeout(c), c.id)
        return { ...c, ...r, lastCheckedAt: now, latencyMs: Date.now() - t0 }
      } catch (e) {
        return { ...c, status: 'error', detail: '检测超时或异常: ' + e.message, lastCheckedAt: now, latencyMs: Date.now() - t0 }
      }
    }))
    lastSnapshot = { overall: aggregate(results), checks: results, lastRunAt: now }
    return lastSnapshot
  }

  // 组级重测：并行跑传入 id 的检查项（per-item timeoutMs），结果合并进现有快照（未涉及项保留旧值）
  async function rerunGroups(ids) {
    if (!lastSnapshot) return runAll()  // 尚未全量跑过 → 退化全量
    const now = Date.now()
    const targets = CHECKS.filter(c => ids.includes(c.id))
    const results = await Promise.all(targets.map(async (c) => {
      const t0 = Date.now()
      try {
        const r = await timeout(Promise.resolve(IMPL[c.id]()), itemTimeout(c), c.id)
        return { ...c, ...r, lastCheckedAt: now, latencyMs: Date.now() - t0 }
      } catch (e) {
        return { ...c, status: 'error', detail: '检测超时或异常: ' + e.message, lastCheckedAt: now, latencyMs: Date.now() - t0 }
      }
    }))
    const byId = new Map(results.map(r => [r.id, r]))
    const checks = lastSnapshot.checks.map(x => byId.get(x.id) || x)
    lastSnapshot = { overall: aggregate(checks), checks, lastRunAt: now }
    return lastSnapshot
  }

  function setOnChange(fn) { onChange = fn }

  function pushIfChanged(prev, next) {
    if (!onChange) return
    if (!prev || prev.overall !== next.overall) onChange(next)
  }

  // 统一推送入口：先捕获 prev 再跑，避免 prev/next 同引用导致 overall 恒等、onChange 永不触发
  async function refresh(scopeIds) {
    const prev = lastSnapshot
    const next = scopeIds ? await rerunGroups(scopeIds) : await runAll()
    pushIfChanged(prev, next)
    return next
  }

  function start({ intervalMs = 30000 } = {}) {
    if (timer) return
    timer = setInterval(() => { refresh() }, intervalMs)
    return refresh()  // 初始立即跑；返回 promise 供调用方/测试 await（对接口的无害增强）
  }

  function stop() { if (timer) { clearInterval(timer); timer = null } }

  async function rerun(id) {
    const c = CHECKS.find(x => x.id === id)
    if (!c) return null
    const now = Date.now()
    const t0 = Date.now()
    try {
      const r = await timeout(Promise.resolve(IMPL[id]()), itemTimeout(c), id)
      const res = { ...c, ...r, lastCheckedAt: now, latencyMs: Date.now() - t0 }
      if (lastSnapshot) {
        const checks = lastSnapshot.checks.map(x => x.id === id ? res : x)
        lastSnapshot = { overall: aggregate(checks), checks, lastRunAt: now }
      }
      return res
    } catch (e) {
      return { ...c, status: 'error', detail: '重测失败: ' + e.message, lastCheckedAt: now, latencyMs: Date.now() - t0 }
    }
  }

  async function runKernelCheck() {
    if (kernelCheckInflight) return { ok: false, stdout: '', stderr: 'in-flight', exitCode: -1, latencyMs: 0 }
    kernelCheckInflight = true
    try { return await timeout(runProbe([`"${ctx.appPaths.bun}"`, `"${ctx.appPaths.kernel}"`, '--version'], 15000), 16000, 'kernel-check') }
    finally { kernelCheckInflight = false }
  }

  function onEvent(type) {
    const ids = {
      'bridge-exit': ['bridge-port', 'bridge-alive', 'kernel-session', 'kernel-crash', 'transcript-index'],
      'executor-disconnect': ['executor-connected', 'executor-window'],
      'gpu-crash': ['gpu-health'],
      'kernel-session-fail': ['kernel-session'],
    }[type] || []
    if (!ids.length) return
    return refresh(ids)  // 真·组级重测；返回 promise 供调用方/测试 await
  }

  async function exportReport() {
    const snap = lastSnapshot || await runAll()
    const lines = []
    lines.push(`Ponos diagnostic report`)
    lines.push(`generated: ${new Date().toISOString()}`)
    lines.push(`overall: ${snap.overall}`)
    lines.push('')
    for (const g of GROUPS) {
      const items = snap.checks.filter(c => c.group === g)
      if (!items.length) continue
      lines.push(`[${g}]`)
      for (const c of items) lines.push(`  ${c.status.padEnd(7)} ${c.id} — ${c.detail || ''} (${c.latencyMs ?? 0}ms)`)
      lines.push('')
    }
    lines.push('--- log tail (200 lines) ---')
    lines.push(...logTee.getLogTail(200))
    return { text: lines.join('\n') }
  }

  return {
    start, stop,
    // 返回副本，防外部篡改内部状态
    getSnapshot: () => lastSnapshot ? { ...lastSnapshot, checks: lastSnapshot.checks.map(c => ({ ...c })) } : null,
    runAll, rerun, runKernelCheck, exportReport, onEvent, setOnChange, CHECKS,
  }
}

module.exports = { createDiagMonitor, CHECKS, GROUPS }
