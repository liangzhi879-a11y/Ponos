// 日志 tee：console.log/error 双写（原输出 + app.log，时间戳前缀）。
// 独立模块、不依赖 electron，保证 main.cjs 最早期即可引入。
//
// 日志目录默认随 PONOS_HOME（dev 调试版 PONOS_HOME=~/.ponos-dev 时日志写
// ~/.ponos-dev/logs/app.log，与正式版 ~/.ponos/logs 严格隔离；
// 未设 PONOS_HOME 时回退 ~/.ponos/logs）。
//
// 注意（相对 brief 的偏差）：brief 原实现用 createWriteStream，但其打开文件是异步的，
// 测试"双写"用例在 console.log 返回后同步 readFileSync 会读到 ENOENT（文件尚未创建）。
// 故改用 appendFileSync 同步写：每行 open/write/close，保证 console.log 返回即落盘，
// 同时因为没有常驻写句柄，轮转 rename 在 Windows 上也不会撞 EBUSY/EPERM。
//
// 崩溃语义（Fix round 1）：uncaughtException / unhandledRejection 处理器必须"不吞异常"。
// 先落盘（tee.error 同步写）、再逐个跑 onCrash 注册的清理回调（best-effort，互不阻塞），
// 最后 re-throw——handler 内 throw 会让进程立即以非零码终止并把错误打到 stderr，
// 避免"崩溃后 stderr 零可见 + exit 0 带病存活"（Node 注册 handler 后默认打印/退出行为全部失效）。
// onCrash(fn)：注册崩溃清理回调（如 main.cjs 用它 kill 残留的 bridge/executor/宠物进程），
// 在日志落盘之后、re-throw 之前同步执行。
'use strict'
const { existsSync, statSync, mkdirSync, renameSync, readFileSync, appendFileSync } = require('fs')
const { join } = require('path')
const os = require('os')

const ts = () => new Date().toISOString()

function createTee(writeFn) {
  return {
    log(msg) { try { writeFn(`[${ts()}] ${msg}`) } catch (_) {} },
    error(msg) { try { writeFn(`[${ts()}] ${msg}`) } catch (_) {} },
  }
}

function initLogTee({ logDir = join(process.env.PONOS_HOME || join(os.homedir(), '.ponos'), 'logs') } = {}) {
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'app.log')

  // 宿主（wscript Exec 启动 / 无头重定向）退出后 stdout/stderr 管道读端关闭，
  // 后续 console 写管道会触发 EPIPE；日志已双写文件，管道侧错误一律忽略，
  // 避免主进程因 EPIPE 崩溃（"双击无响应"场景下 electron 秒退的防御之一）。
  for (const s of [process.stdout, process.stderr]) {
    s?.on?.('error', () => {})
  }

  const tee = createTee((line) => appendFileSync(logPath, line + '\n'))

  for (const level of ['log', 'error', 'warn', 'info']) {
    const orig = console[level]?.bind(console)
    if (!orig) continue
    console[level] = (...args) => {
      tee[level === 'log' ? 'log' : 'error'](args.map(String).join(' '))
      orig(...args) // 原输出行为不变（终端/管道）
    }
  }

  const crashCleanups = []
  function runCrashCleanups() {
    for (const fn of crashCleanups.splice(0)) {
      try { fn() } catch (_) {} // best-effort：单个清理失败不阻塞其余
    }
  }
  // onCrash(fn)：注册崩溃清理回调，返回原接口结构（后续任务依赖，勿动既有三个接口）。
  function onCrash(fn) {
    if (typeof fn === 'function') crashCleanups.push(fn)
  }

  // 不吞异常：落盘 + 清理后 re-throw → 进程立即非零退出、错误打到 stderr。
  // 注意（相对裁决用例的偏差）：Node v24 顶层 throw 的 err.stack 带 V8 源码上下文块
  // （首行是 `[eval]:N`/源文件行号而非消息），按 `(err?.stack || err)` 直写会让
  // [uncaughtException] 与消息永远不在同一行。故首行补 message 摘要，后续保留完整 stack。
  process.on('uncaughtException', (err) => {
    tee.error('[uncaughtException] ' + (err?.message ?? err) + '\n' + String(err?.stack || ''))
    runCrashCleanups()
    throw err
  })
  process.on('unhandledRejection', (reason) => {
    tee.error('[unhandledRejection] ' + (reason instanceof Error ? reason.message : reason) + '\n' + (reason instanceof Error ? String(reason.stack) : ''))
    runCrashCleanups()
    throw reason instanceof Error ? reason : new Error(String(reason))
  })

  function rotateIfNeeded() {
    try {
      if (!existsSync(logPath)) return
      if (statSync(logPath).size <= 5 * 1024 * 1024) return
      const bak = join(logDir, 'app.log.1')
      try { renameSync(logPath, bak) } catch (_) { /* 目标被占用则跳过 */ }
    } catch (_) {}
  }

  function getLogTail(n = 100) {
    try {
      const lines = readFileSync(logPath, 'utf-8').split(/\r?\n/).filter(Boolean)
      return lines.slice(-n)
    } catch (_) { return [] }
  }

  return { getLogPath: () => logPath, getLogTail, rotateIfNeeded, onCrash }
}

module.exports = { createTee, initLogTee }
