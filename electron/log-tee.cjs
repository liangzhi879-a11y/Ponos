// 日志 tee：console.log/error 双写（原输出 + ~/.yfworking/logs/app.log，时间戳前缀）。
// 独立模块、不依赖 electron，保证 main.cjs 最早期即可引入。
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
const { resolveYfwHome } = require('../server/yfw-home.cjs')
// 本地持久化策略单一真源（server/log-policy.cjs）：轮转/保留份数/保留天数/等级门槛/关闭开关
const { DEFAULT_LOG_POLICY, readLogPolicyCached, writeLogLine, rotateLog, enforceLogPolicy, getLogTail: tailOf } = require('../server/log-policy.cjs')

const ts = () => new Date().toISOString()

function createTee(writeFn) {
  return {
    log(msg) { try { writeFn(`[${ts()}] ${msg}`) } catch (_) {} },
    error(msg) { try { writeFn(`[${ts()}] ${msg}`) } catch (_) {} },
  }
}

// logDir：日志目录；policy：显式策略（缺省按 home 的 config.json 走 TTL 缓存）；
// home：策略来源（测试用）。
function initLogTee({ logDir = join(resolveYfwHome(), 'logs'), policy = null, home = resolveYfwHome() } = {}) {
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'app.log')
  // 策略在每行写入时现取：桥与主进程是两个进程，改策略后靠 TTL（默认 5s）生效，无需重启。
  const currentPolicy = () => policy || readLogPolicyCached({ home })

  const tee = createTee((line) => { writeLogLine(logPath, line, currentPolicy(), 'info') })

  for (const level of ['log', 'error', 'warn', 'info']) {
    const orig = console[level]?.bind(console)
    if (!orig) continue
    console[level] = (...args) => {
      if (level === 'error') tee.error(args.map(String).join(' '))
      else tee.log(args.map(String).join(' '))
      orig(...args) // 原输出行为不变（终端/管道）
    }
  }

  // 启动一次性落地策略：年龄清理 + 存量超大 app.log 裁剪（历史遗留文件曾达 76MB）+ 超限轮转。
  // 这是"轮转是死代码"的修复点之一——原 rotateIfNeeded 只被返回、从未被调用（另一个在 main.cjs）。
  try { enforceLogPolicy(logPath, currentPolicy()) } catch (_) { /* 策略执行失败不阻断启动 */ }

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

  // 委托给策略模块（超限才轮转；保留份数/年龄由策略决定）。保留方法名与语义：
  // main.cjs 与 log-tee.test.mjs 依赖它。
  function rotateIfNeeded() {
    try {
      if (!existsSync(logPath)) return
      const p = currentPolicy()
      if (statSync(logPath).size <= p.maxFileBytes) return
      rotateLog(logPath, p)
    } catch (_) {}
  }

  function getLogTail(n = 100) {
    return tailOf(logPath, n)
  }

  return { getLogPath: () => logPath, getLogTail, rotateIfNeeded, onCrash }
}

module.exports = { createTee, initLogTee }
