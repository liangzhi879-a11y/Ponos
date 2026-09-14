/**
 * YFWorking Desktop — Electron main process.
 *
 * Architecture:
 *   Renderer (React) ──WebSocket──► bridge server (node server/bridge.mjs) ──stdio──► ponos 内核（本库 kernel/cli.mjs 源码或 kernel-dist bundle，node 直跑）
 *
 * Electron auto-starts the bridge, then loads the frontend.
 * CommonJS so Electron runs it directly without transpilation.
 */
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Tray, Notification, nativeImage, screen, clipboard } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const WebSocket = require('ws')
const { resolveYfwHome } = require('../server/yfw-home.cjs')

// 入口兜底数据根隔离（2026-09-09 串配置事故修复）：桌面快捷方式直启 electron.exe /
// YFWorking.vbs / debug bat 均不携带 env，此前双版全部回落 ~/.yfworking 与在售旧版
// 互串（config/settings/会话/认证/主题）。兜底默认净室专属根 ~/.yfw；显式设
// YFWORKING_HOME 仍可覆盖（如临时切回 C:\Users\<you>\.yfworking 读旧会话）。
// bridge 由本进程 spawn 继承该 env（server/bridge.mjs 的 resolveYfwHome 同源）。
//
// ⚠️ 位置约束（2026-09-12 修复）：必须早于下方 initLogTee()。initLogTee 的 logDir
// 默认值 `join(resolveYfwHome(), 'logs')` 在**调用期**求值，早于本注入就会落到旧根
// `${os.homedir()}/.yfworking/logs/app.log`（实测存量 4.78MB）；而 renderer-console.log
// 是在 /logs 路由请求期才解析 home（本文件 :1424）故一直写在新根 ⇒ 只有 app.log 错位，
// 按新根找日志的内置查看器看不到它。
if (!process.env.YFWORKING_HOME) {
  process.env.YFWORKING_HOME = path.join(os.homedir(), '.yfw')
}

// D6：双版 userData 隔离——YFWORKING_HOME 恒设（上方兜底），Electron userData
// 重定向到 <数据根>/userData，避免与在售旧版（default_app.asar 无 app 名 → 两版
// 曾共用 %APPDATA%\Electron，theme.json 互踩）同机并行冲突。安装版产物身份（S6
// 定案，正式替换身份）：appId com.yfworking.desktop / productName YFWorking 与在售
// 一致——安装形态经 installer.nsh 版本比较（2.8.0）覆盖升级保留数据；
// 双版并存由便携/dev 目录隔离 + 本 userData 重定向兜底，无需独立 appId。
if (process.env.YFWORKING_HOME) {
  try { app.setPath('userData', path.join(resolveYfwHome(), 'userData')) } catch {}
}

// 个人经验库（experience.mjs）+ 导出/导入（packager.mjs）。server/ 为 ESM，
// Node 22+ 支持 require() ESM（无顶层 await 的模块可被同步加载）。
const { listExperiences, setThemeActive, deleteThemeEntry, refreshIndex } = require('../server/experience.mjs')
const { exportPackage, importPackage } = require('../server/packager.mjs')
// 内置浏览器自动化执行器（窗口/CDP/快照/人工接管/下载）
const { BrowserExecutor } = require('./browser-executor.cjs')
// 应用智控（第六 rail「应用智控」）：app:* IPC 通道集中注册在 app-ipc.cjs，
// 本文件只留这一行接线（12 条通道 + 目标分发逻辑集中一处才好审计）。
const { registerAppHandlers, handleAppExecMessage } = require('./app-ipc.cjs')

// ---------------------------------------------------------------------------
// 应用内诊断（Task 2）：日志 tee 最早期接入——启动序列第一行日志即入盘。
// 崩溃清扫挂点：崩溃（uncaughtException/unhandledRejection）时优雅清扫残留运行。
// killBridge/killPet 为函数声明（提升），回调在崩溃时才执行，此时全部已定义；
// browserExecutor 同理（connectBrowserExecutor 前为 null，可选链兜底）。
// ---------------------------------------------------------------------------
const { initLogTee } = require('./log-tee.cjs')
// R1 后主进程只剩这一个 log-policy 入口（渲染器落盘整条路径收进 sink；app.log 由 log-tee 自理）
const { createRendererConsoleSink } = require('../server/log-policy.cjs')
// 本地持久化策略在此落地（2026-09-12）：initLogTee 内部 ①按策略清理历史（存量超大的
// app.log 首次启动即裁剪，不再无上限增长）②每行写入都经 writeLogLine，超限当场轮转——
// 原先 rotateIfNeeded 被返回却从无调用者（死代码），app.log 曾涨到 76MB。
const logTee = initLogTee()
// R1（2026-09-13）：渲染器 console 落盘的单一咽喉——高频行（[WS] recv:）按前缀采样、
// 异常全量、写盘走缓冲（1s / 100 行 / 溢出 setImmediate）。此前每帧一行、**两次**
// statSync+appendFileSync（app.log + renderer-console.log），22 小时 17MB。
// 全量还原：PONOS_RENDER_LOG_FULL=1（或 PONOS_RENDER_LOG_WINDOW_MS=0）。
const renderConsoleSink = createRendererConsoleSink()
logTee.onCrash(() => {
  try { renderConsoleSink.flush() } catch {} // 崩溃路径也要把缓冲里的行落盘
  try { killBridge() } catch {}
  try { killPet() } catch {}
  if (browserExecutor) {
    try { browserExecutor.stopFingerprintPoll?.() } catch {}
    try { browserExecutor.destroyAllWindows?.() } catch {}
  }
})

function findPythonExe() {
  const bundled = path.join(__dirname, '..', '..', 'runtime', 'python', 'python.exe')
  if (fs.existsSync(bundled)) return bundled
  const dev = path.join(__dirname, '..', 'runtime', 'python', 'python.exe')
  if (fs.existsSync(dev)) return dev
  return 'python'
}
const PYTHON_EXE = findPythonExe()

// 应用内诊断：kernel/runtime(node)/python 路径探测。内核与 bridge.mjs 共用
// electron/kernel-paths.cjs 统一解析（install 候选命中优先、home 缓存兜底），
// 杜绝两套逻辑漂移——生产事故：诊断探针曾直接 spawn 安装目录（Program Files）
// → EPERM → kernel-launch 误报 exit=1，而实际会话走 bootstrap 缓存始终正常。
// 运行时 = node（D1）：runtime 经 resolveNode() 定位（打包 <app>/node.exe，
// dev 回退 PATH 'node'）。python 复用 findPythonExe()，但裸命令名 'python' 会
// 令 monitor 的 existsSync 相对 cwd 误报（I4 语义）——map 成 null，monitor 对
// null 返回 unknown。
function resolveDiagPaths() {
  const { resolveKernelPaths } = require('./kernel-paths.cjs')
  const rp = resolveKernelPaths() // 本模块与 kernel-paths.cjs 同处 electron/，缺省推导一致
  const python = findPythonExe()
  return {
    kernel: rp.kernel, // install 候选命中优先，home 缓存兜底（与 findYFWorking 同序）
    runtime: resolveNode(), // node 运行时：bundled node.exe 或 PATH 'node'
    install: rp.install,
    python: python === 'python' ? null : python,
  }
}

function findPythonForPet() {
  try {
    require('child_process').execSync('python -c "import tkinter"', { stdio: 'ignore', timeout: 5000 })
    return 'python'
  } catch (e) { /* system python may not have tkinter */ }
  try {
    require('child_process').execSync('py -c "import tkinter"', { stdio: 'ignore', timeout: 5000 })
    return 'py'
  } catch (e) { /* py launcher may not exist */ }
  return PYTHON_EXE
}

// Windows: register AppUserModelId so system notifications show correctly
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.yfworking.desktop') } catch {}
}

// 数据根兜底注入 + userData 重定向已上移至文件顶部 require 之后（2026-09-12）：
// initLogTee 的 logDir 默认值在调用期求值，必须让 YFWORKING_HOME 先就位，否则
// app.log 落旧根 ~/.yfworking/logs。理由与实测数据见顶部同段注释。


// 旧显卡/驱动不稳的机器上 GPU 进程可能因 TDR 等被系统重置。
// 默认 Chromium 崩溃重试 3 次后放弃 GPU 进程（整窗黑屏/合成失效），
// 去掉该上限让 GPU 进程自动拉起；崩溃时由 child-process-gone 兜底转极速模式。
app.commandLine.appendSwitch('disable-gpu-process-crash-limit')

// 关磁盘缓存：本应用资源基本走 file://（不走 HTTP 磁盘缓存），仅 Google
// 字体/本地桥接口偶尔走网络。Chromium 磁盘缓存（blockfile 后端）在异常退出
// 后易报 "Critical error found -8" / "Failed to save user data"（启动终端刷错），
// 置 0 改用内存缓存彻底消除该报错，代价仅是字体每次启动重新下载。
app.commandLine.appendSwitch('disk-cache-size', '0')

// GPU 进程异常退出 → 通知渲染层自动开启极速形态（关动画/特效，降低图形负载），
// 防止崩溃后的恢复阶段再次把驱动压垮；渲染层负责落盘设置并提示用户。
app.on('child-process-gone', (_event, details) => {
  if (!details || details.type !== 'GPU') return
  const reason = details.reason || 'unknown'
  console.log('[main] GPU process gone, reason:', reason)
  gpuCrashCount += 1                    // 诊断：GPU 崩溃计数（render/gpu-health 检测）
  monitor?.onEvent('gpu-crash')         // 诊断：事件驱动触发 render 组重测
  try {
    mainWindow?.webContents.send('gpu:crash', { reason })
  } catch { /* window not ready */ }
})

// When launched from a terminal (Start-Process, CLI redirect, etc.) stdout may
// be a pipe owned by that terminal. If the pipe closes while we log, console.log
// throws EPIPE which crashes the app with a dialog. Swallow EPIPE only.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', (err) => {
      if (!err || err.code !== 'EPIPE') throw err
    })
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mainWindow = null
// 认证小窗（spec §2.0/D13；Task 6b）：冷启动先建，主窗口在 auth:granted 后才创建；
// authGranted 记录本次运行是否已放行（防"未放行关窗退出应用"误杀已授权场景）。
let authWin = null
let authGranted = false
let editorWin = null            // 原生文件编辑器独立窗口（可超出主应用界面）
let utilityWins = new Map()     // 独立工具窗口（settings/profile），kind → BrowserWindow（2026-09-10）
let pendingEditorFile = null    // 待编辑器窗口拉取的文件（渲染层挂载后 invoke 拉取，规避 IPC 竞态）
let bridgeProcess = null
let bridgeAdopted = false           // 端口上跑的是"接入"的外部 bridge（非本进程 spawn）
let bridgeHealthTimer = null        // 接入外部 bridge 后的健康轮询定时器
let bridgeHealthFails = 0           // 连续健康检查失败次数
let bridgeRestartTimer = null        // bridge 意外退出的重启防抖定时器
let bridgeRestartAttempts = 0        // 连续重启计数（指数退避，防崩溃循环）
const BRIDGE_RESTART_BASE_MS = 2000
const BRIDGE_RESTART_MAX_MS = 10000
// 退出兜底期限：before-quit 之后超过这个时间仍未退出，即认定退出被窗口否决（见 armQuitWatchdog）。
const QUIT_WATCHDOG_MS = 2500
const BRIDGE_HEALTH_INTERVAL_MS = 5000  // 接管的外部 bridge 健康探活间隔
const BRIDGE_HEALTH_MAX_FAILS = 3       // 连续失败 N 次（约 15s）判定接管 bridge 死亡
let tray = null
let trayEnabled = true
let isQuitting = false
// 退出兜底计时器（armQuitWatchdog）：app.quit() 被窗口否决而中止时兜底硬退出。
let quitWatchdog = null
let browserExecutor = null        // 内置浏览器自动化执行器（connectBrowserExecutor 创建，IPC 共用）
let petProcess = null
let gpuCrashCount = 0            // 诊断：GPU 进程崩溃累计（child-process-gone 处 ++）
let renderCrashCount = 0         // 诊断：渲染进程崩溃累计（render-process-gone 处 ++）
let monitor = null               // 应用内诊断 monitor（registerIpc 内创建；模块级事件 handler 经可选链引用）
let petConfig = { enabled: false, size: 50, randomChat: true }
let petIntentKill = null     // 主动 kill 的宠物进程（区分“用户右键退出”导致的意外退出）
let petRestartTimer = null   // 宠物配置变更重启的防抖定时器
const ICON_PATH = path.join(__dirname, '..', 'public', 'icon.png')
const BRIDGE_PORT = parseInt(process.env.YFW_BRIDGE_PORT || '51517', 10)
const BRIDGE_READY_URL = `http://localhost:${BRIDGE_PORT}/health`

// ---------------------------------------------------------------------------
// Bridge lifecycle
// ---------------------------------------------------------------------------
/**
 * 严格 bridge 健康检查：/health 必须返回 200 且 body 含 "status":"ok"。
 * 与诊断 checkBridgePort 判据一致。2026-08-22 缺陷修复：原 isPortInUse 只判
 * "端口有 HTTP 响应即活"（忽略状态码/响应体），端口被半死 bridge 或无关进程
 * 占用（响应但不提供 /health 200）时，主进程会永久"接管"一个不可用桥——
 * 表现为诊断 bridge-port error 但重启计数 0、会话功能全挂。统一判据后，
 * 健康轮询/重启决策/启动接管三处均以本检查为准。
 */
function isBridgeHealthy(port = BRIDGE_PORT) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d.toString() })
      res.on('end', () => {
        resolve(res.statusCode === 200 && /"status"\s*:\s*"ok"/.test(body))
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/** Prefer the bundled node.exe next to the app; fall back to PATH. */
function resolveNode() {
  const bundled = path.join(__dirname, '..', 'node.exe')
  return fs.existsSync(bundled) ? bundled : 'node'
}

// 真实 boot 进度（2026-09-11）：桥接/内核自举/技能安装/供应商探测的就绪状态经
// bridge /boot-status 轮询 → 渲染层 BootScreen 渲染真实步骤；全部就绪发 boot:ready。
// 主窗口就绪前事件暂存，did-finish-load 时冲刷（BootScreen 挂载即可见完整进度）。
let bootProgressEvents = []
let bootProgressPollTimer = null
const bootProgressSent = { bridge: false, kernel: false, skills: false, provider: false }
function emitBootProgress(msg) {
  bootProgressEvents.push(msg)
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
      for (const m of bootProgressEvents) mainWindow.webContents.send('boot:progress', m)
      bootProgressEvents = []
    }
  } catch { /* 窗口未就绪：留待冲刷 */ }
}
function flushBootProgress() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  for (const m of bootProgressEvents) { try { mainWindow.webContents.send('boot:progress', m) } catch { /* 单条失败不阻断 */ } }
  bootProgressEvents = []
}
function startBootProgressPoll() {
  if (bootProgressPollTimer) return
  bootProgressPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/boot-status`)
      if (!res.ok) return
      const st = await res.json()
      if (!bootProgressSent.bridge) { bootProgressSent.bridge = true; emitBootProgress({ step: 'bridge', done: true }) }
      if (st.kernelBootstrapped && !bootProgressSent.kernel) { bootProgressSent.kernel = true; emitBootProgress({ step: 'kernel', done: true }) }
      if (st.samplesInstalled && st.workflowsInstalled && !bootProgressSent.skills) { bootProgressSent.skills = true; emitBootProgress({ step: 'skills', done: true }) }
      if (st.probeDone && !bootProgressSent.provider) { bootProgressSent.provider = true; emitBootProgress({ step: 'provider', done: true }) }
      if (bootProgressSent.bridge && bootProgressSent.kernel && bootProgressSent.skills && bootProgressSent.provider) {
        emitBootProgress({ step: 'ready', done: true })
        clearInterval(bootProgressPollTimer)
        bootProgressPollTimer = null
      }
    } catch { /* 桥未就绪/瞬断：静默，下轮再试 */ }
  }, 300)
}

function startBridge() {
  const serverPath = path.join(__dirname, '..', 'server', 'bridge.mjs')
  console.log('[main] starting bridge:', serverPath)

  bridgeProcess = spawn(resolveNode(), [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // 父进程监控（2026-09-09 孤儿桥自愈）：electron 被强杀（taskkill/任务管理器，
    // 不触发 before-quit）时，桥靠本 PID 探活检测父进程消失 → 杀内核会话并退出，
    // 不再遗留孤儿占用 51517 导致"重启后无法唤醒"。
    env: { ...process.env, YFW_BRIDGE_PARENT_PID: String(process.pid) },
    windowsHide: true,   // no console window on Windows
  })

  bridgeProcess.stdout.on('data', (data) => {
    console.log('[bridge]', data.toString().trim())
  })
  bridgeProcess.stderr.on('data', (data) => {
    console.log('[bridge:err]', data.toString().trim())
  })
  const onBridgeExit = () => {
    bridgeProcess = null
    if (!isQuitting) scheduleBridgeRestart()
  }
  bridgeProcess.on('error', (err) => {
    console.error('[bridge] spawn error:', err.message)
    onBridgeExit()
  })
  bridgeProcess.on('close', (code) => {
    console.log('[bridge] exited, code:', code)
    onBridgeExit()
  })

  return bridgeProcess
}

/** bridge 意外退出后自动重启（指数退避，防止崩溃死循环）。 */
function scheduleBridgeRestart() {
  if (bridgeRestartTimer || isQuitting) return
  const delay = Math.min(BRIDGE_RESTART_BASE_MS * Math.pow(2, bridgeRestartAttempts), BRIDGE_RESTART_MAX_MS)
  bridgeRestartAttempts += 1
  monitor?.onEvent('bridge-exit')   // 诊断：bridge 意外退出事件（触发 bridge 组重测；覆盖 spawn 退出与接管 bridge 回收两条路径）
  console.log(`[main] bridge exited — restart in ${delay}ms (attempt ${bridgeRestartAttempts})`)
  bridgeRestartTimer = setTimeout(async () => {
    bridgeRestartTimer = null
    if (isQuitting) return
    // 2026-09-09 孤儿桥修复：端口上的"健康桥"也可能是旧构建/旧会话态的孤儿——
    // 收养它会让应用全程与旧内核通信（"重启后无法唤醒"）。单实例语义下统一回收
    // 外部桥后自起当前构建（父进程探活已保证孤儿自灭，此处回收兜底竞态窗口）。
    const stalePid = await findPortPid(BRIDGE_PORT)
    if (stalePid && await isBridgeProcess(stalePid)) {
      console.warn('[main] recycling external bridge pid ' + stalePid + ' — restarting fresh')
      taskkillPid(stalePid)
      await new Promise((r) => setTimeout(r, 500))
    }
    startBridge()
  }, delay)
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 退出兜底（2026-09-14 实况：半死实例）
// app.quit() 只要被任一窗口的 close 处理器 preventDefault 否决，就会被**中止**：
// keepAlive 登录窗（browser-executor 的「点 X 只隐藏」）正是这种窗口。中止之后
// isQuitting 已在 before-quit 置真、且全仓没有复位点；桥已被 killBridge 杀掉，
// 自愈又被 scheduleBridgeRestart 的 `|| isQuitting` 挡死；will-quit 的清理需要
// 窗口先关完，而中止的退出永远等不到它 ⇒ 进程活着、窗口在、却永远连不上桥
// （渲染层无限 1006 重连）。半死比直接退出更糟——用户看到窗口以为能用。
// 故给退出一个硬期限：到点补做 will-quit 的收尾（它不会触发）再硬退出。
function armQuitWatchdog() {
  if (quitWatchdog) return
  quitWatchdog = setTimeout(() => {
    console.warn('[main] 退出被窗口否决 —— 兜底强制退出')
    try { writeBootSummary() } catch { /* 静默：退出路径不因日志设施失败而改变 */ }
    try { renderConsoleSink.flush() } catch {}
    try { killBridge() } catch {}
    try { killPet() } catch {}
    if (browserExecutor) { try { browserExecutor.destroyAllWindows?.() } catch {} }
    app.exit(0)
  }, QUIT_WATCHDOG_MS)
  if (quitWatchdog.unref) quitWatchdog.unref()
}

// Adopted-bridge supervision
// 缺陷背景：应用启动时若发现端口上已有 bridge（上个实例遗留的孤儿），
// 之前只是打日志"reusing"，不接管所有权、不挂任何监听——旧 bridge 死后
// 无人触发 scheduleBridgeRestart()，端口永远空着，前端无限重连失败。
// 修复：复用即接管——收编为 bridgeAdopted，用健康轮询监控；连续失败达
// 阈值则回收占用进程（先验证是 bridge.mjs 再杀，防误杀）并走退避重启。
// ---------------------------------------------------------------------------

/** 找到监听指定端口的进程 PID（netstat 解析），无则 null。 */
function findPortPid(port) {
  return new Promise((resolve) => {
    const child = spawn('netstat', ['-ano'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('close', () => {
      for (const line of out.split(/\r?\n/)) {
        // \S+:(\d+) 只吃本地地址段（避免贪婪匹配吞到远端 0.0.0.0:0 的端口）
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+.*LISTENING\s+(\d+)$/i)
        if (m && parseInt(m[1], 10) === port) {
          resolve(parseInt(m[2], 10))
          return
        }
      }
      resolve(null)
    })
    child.on('error', () => resolve(null))
  })
}

/** 判断 PID 对应的进程命令行是否包含 bridge.mjs（防止误杀其他程序）。 */
function isBridgeProcess(pid) {
  return new Promise((resolve) => {
    const child = spawn('wmic', ['process', 'where', `processid=${pid}`, 'get', 'CommandLine'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('close', () => resolve(out.toLowerCase().includes('bridge.mjs')))
    child.on('error', () => resolve(false))
  })
}

/** 按进程树强杀指定 PID（与 killBridge 相同的级联语义，含其 spawn 的 CLI 会话）。 */
function taskkillPid(pid) {
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  } catch (e) { console.error('[bridge] taskkill error:', e.message) }
}

/** 停止健康轮询（退出或回收时调用，避免定时器阻塞进程退出）。 */
function stopHealthMonitor() {
  if (bridgeHealthTimer) {
    clearInterval(bridgeHealthTimer)
    bridgeHealthTimer = null
  }
  bridgeHealthFails = 0
}

/** 接管端口上已存在的外部 bridge：标记状态并启动健康轮询。 */
function adoptBridge() {
  bridgeAdopted = true
  bridgeHealthFails = 0
  startHealthMonitor()
}

/** 对接管的外部 bridge 周期性探活；连续失败达阈值则回收并走退避重启。 */
function startHealthMonitor() {
  if (bridgeHealthTimer || isQuitting) return
  console.log('[main] adopted external bridge — monitoring health every ' + BRIDGE_HEALTH_INTERVAL_MS + 'ms')
  bridgeHealthTimer = setInterval(async () => {
    if (isQuitting) return
    // 严格判据：/health 必须 200 + status:ok（与诊断一致），防止"有响应即活"误判
    const ok = await isBridgeHealthy()
    if (ok) {
      bridgeHealthFails = 0
      return
    }
    bridgeHealthFails += 1
    if (bridgeHealthFails < BRIDGE_HEALTH_MAX_FAILS) return
    console.error(`[main] adopted bridge unreachable ${BRIDGE_HEALTH_MAX_FAILS}x — recycling`)
    stopHealthMonitor()
    bridgeAdopted = false
    // 端口若仍被占用（bridge 假死但进程没退），先回收占用进程；端口已空则跳过
    const pid = await findPortPid(BRIDGE_PORT)
    if (pid && await isBridgeProcess(pid)) {
      console.error('[main] killing stale bridge pid ' + pid)
      taskkillPid(pid)
      // 给进程树一点退出时间，避免立即 startBridge 撞 EADDRINUSE
      await new Promise((r) => setTimeout(r, 500))
    }
    scheduleBridgeRestart()
  }, BRIDGE_HEALTH_INTERVAL_MS)
}

function killBridge() {
  stopHealthMonitor()
  if (bridgeAdopted) {
    // 退出时也要回收接入的外部 bridge，否则会留下孤儿进程（同"复用不接管"缺陷的连锁后果）
    bridgeAdopted = false
    findPortPid(BRIDGE_PORT).then((pid) => {
      if (pid && isBridgeProcess(pid)) taskkillPid(pid)
    })
  }
  if (bridgeProcess && !bridgeProcess.killed) {
    if (process.platform === 'win32') {
      // Windows 下 SIGTERM 不可靠且不会级联子进程：bridge 退出了它 spawn 的
      // 内核 CLI 会话进程仍会残留成孤儿。用 taskkill /T 按进程树终止，
      // 保证"前端退出 → 内核（含所有 CLI 会话）同步停止"的强绑定。
      taskkillPid(bridgeProcess.pid)
    } else {
      bridgeProcess.kill('SIGTERM')
    }
    bridgeProcess = null
  }
}

/** Poll the bridge health endpoint until it responds. */
function waitForBridge(maxRetries = 30, interval = 500) {
  return new Promise((resolve, reject) => {
    let tries = 0
    const poll = () => {
      tries++
      http.get(BRIDGE_READY_URL, (res) => {
        if (res.statusCode === 200) resolve()
        else if (tries < maxRetries) setTimeout(poll, interval)
        else reject(new Error(`Bridge not ready after ${maxRetries} retries`))
      }).on('error', () => {
        if (tries < maxRetries) setTimeout(poll, interval)
        else reject(new Error(`Bridge not reachable after ${maxRetries} retries`))
      })
    }
    poll()
  })
}

// 启动失败兜底对话框（附日志路径：打开/复制）。
// 必须声明在**顶层**：调用方 startBridgeAndWait() 是顶层函数。
// 曾把它放在 `} else {`（单实例锁）块内 —— Annex B 的块级函数提升**只覆盖
// FunctionDeclaration，不覆盖 AsyncFunctionDeclaration**，于是 493 行调用抛
// ReferenceError，紧随其后的 app.quit() 永不执行：启动失败后进程不退、桥也没起
// 来，正是「实例还活着但什么都不能做」的形态（2026-09-14 实测）。
// 依赖均为顶层：logTee(66)、dialog/shell/clipboard(10)。
async function showBootFailureDialog() {
  try {
    const logPath = logTee.getLogPath()
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'YFWorking 启动异常',
      message: '应用界面启动失败。完整错误日志已保存到：',
      detail: logPath,
      buttons: ['打开日志目录', '复制路径', '确定'],
      defaultId: 0, cancelId: 2,
    })
    if (response === 0) shell.openPath(path.dirname(logPath))
    if (response === 1) clipboard.writeText(logPath)
  } catch (_) {}
}

/**
 * 启动 bridge 并等待就绪；失败时弹错误框并退出（启动阶段唯一退出点，
 * 供判据统一后的接管/空闲两条路径复用，避免错误处理逻辑重复）。
 */
async function startBridgeAndWait() {
  startBridge()
  console.log('[main] waiting for bridge...')
  try {
    await waitForBridge()
    bootPhase('bridgeReady')
    console.log('[main] bridge ready, creating window')
  } catch (e) {
    console.error('[main] bridge startup failed:', e.message)
    bootPhase('bridgeReady', false, e)
    dialog.showErrorBox(
      'Bridge Server 启动失败',
      `桥接服务器无法在端口 ${BRIDGE_PORT} 上启动。\n\n` +
      `错误: ${e.message}\n\n` +
      `可能的原因:\n` +
      `  • 端口被 Windows WinNAT 或其他程序占用\n` +
      `  • 防火墙/安全软件阻止了网络访问\n\n` +
      `解决方法:\n` +
      `  1. 设置环境变量 YFW_BRIDGE_PORT 为其他端口 (如 51517)\n` +
      `  2. 以管理员身份运行: netsh int ipv4 add excludedportrange protocol=tcp startport=${BRIDGE_PORT} numberofports=1\n` +
      `  3. 重启 Windows 后 WinNAT 端口排除范围通常会重新分配`,
    )
    await showBootFailureDialog()   // 兜底：原生对话框附日志路径（打开/复制）
    app.quit()
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
// 主题 → 磁盘同步：渲染层在启动/切主题时经 IPC 写入 theme.json；
// 创建窗口前读取，决定是否用真透明窗口（仅 glass 主题需要）。
// 实测：非 glass 主题下页面不透明背景本就把透明合成完全盖住（视觉无差异），
// 但透明窗口让每个 CSS 动画都走每帧全窗合成路径（旧 GPU 上 ~13% GPU + 放大
// 渲染进程动画成本）——非 glass 主题改为不透明窗口是纯性能优化、零视觉回归。
const THEME_FILE = () => path.join(app.getPath('userData'), 'theme.json')
const GLASS_THEMES = ['dark-glass', 'light-glass']
function readPersistedTheme() {
  try {
    const raw = fs.readFileSync(THEME_FILE(), 'utf-8')
    const data = JSON.parse(raw)
    if (data && typeof data.theme === 'string') {
      return { theme: data.theme, mode: data.mode === 'light' ? 'light' : 'dark' }
    }
  } catch { /* 文件缺失/损坏 → null */ }
  return null
}
ipcMain.on('app:save-theme', (_event, data) => {
  try {
    if (!data || typeof data.theme !== 'string') return
    fs.writeFileSync(THEME_FILE(), JSON.stringify({
      theme: data.theme,
      mode: data.mode === 'light' ? 'light' : 'dark',
    }, null, 2), 'utf-8')
  } catch (e) {
    console.warn('[main] failed to persist theme:', e.message)
  }
})

function createWindow() {
  // 无主题记录时默认透明（保持历史行为，防止升级后玻璃用户视觉回归）
  const themeMeta = readPersistedTheme()
  const isGlass = !themeMeta || GLASS_THEMES.includes(themeMeta.theme)
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'YFWorking',
    // Windows 透明窗口必须 frame:false（titleBarStyle:'hidden' 保留系统 frame，
    // 会挡住 DWM 透明合成，实测 Win10 无法透出桌面）。
    // 取舍：放弃系统 1px 边框/阴影/系统边缘拖拽，换来玻璃主题真透桌面；
    // 非 glass 主题页面不透明背景照常盖住透明合成，仅失去边框阴影。
    // 阴影/层次感由页面内玻璃面板的 box-shadow 与内高光补足。
    frame: false,
    transparent: isGlass,
    backgroundColor: isGlass ? '#00000000' : (themeMeta.mode === 'light' ? '#fdf9f5' : '#0b0e14'),
    icon: ICON_PATH,
    show: false,  // wait until ready to prevent white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 关闭后台节流：最小化到托盘后渲染层仍保持全速，
      // 保证 WS 心跳/消息处理与任务完成通知在后台可靠及时。
      backgroundThrottling: false,
    },
  })

  // 渲染层错误全链路入盘：did-fail-load / render-process-gone / console /
  // preload-error / unresponsive → console.* → logTee 双写入盘
  registerRendererErrorCapture(mainWindow)

  // Windows 透明窗口已知 bug：失焦时系统可能重新绘制出蓝色标题栏条。
  // 聚焦/失焦都重置背景为全透明，保持透明合成（渲染层页面自身不透明背景不受影响）。
  // 仅透明窗口需要（不透明窗口设置透明背景会露出黑底）。
  const keepTransparent = () => mainWindow.setBackgroundColor('#00000000')
  if (isGlass) {
    mainWindow.on('blur', keepTransparent)
    mainWindow.on('focus', keepTransparent)
  }

  // 快捷键（⌘N / ⌘, / ⌘B / ⌘⇧P / ⌘K 等）统一由渲染层 AppShell 的
  // window keydown 处理器接管。菜单不再注册 accelerator/click——
  // 否则 accelerator 会吞掉按键，且菜单事件无人监听，快捷键会失效。
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Show window once content is ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Load Vite dev server or built files
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    const distPath = path.join(__dirname, '..', 'dist', 'index.html')
    mainWindow.loadFile(distPath)
  }

  // 技能经验消费提醒：页面加载完成后检查 pending 积压并推送（延迟等 UI 就绪）
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      const r = checkPendingExperiences()
      if (r.shouldAlert && r.total > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('experience:pending-alert', { total: r.total, bySkill: r.bySkill })
        recordExperienceAlert()
      }
    }, 4000)
  })

  // Close → hide to tray instead of quitting (unless quitting or tray disabled)
  mainWindow.on('close', (e) => {
    if (trayEnabled && !isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // 托盘行为关闭时，主窗口消失即退出应用。不能指望 window-all-closed 兜底：
    // 浏览器执行器的自动化窗口也是顶层窗口，它开着时 window-all-closed 永不触发
    // （2026-09-14 实况：主窗口渲染进程已退出、自动化窗口仍存活，实例长期占着
    // 单实例锁且没有主窗口，用户再点图标毫无反应）。
    // before-quit 会补 killBridge/killPet，此处不必重复。
    if (!trayEnabled && !isQuitting) app.quit()
  })
}

// ---------------------------------------------------------------------------
// 认证小窗（spec §2.0/D13；Task 6b）
// 冷启动先建独立登录/首设小窗（?auth=1，原生 frame、非透明、固定 ~420×560、主屏居中），
// 主窗口此刻不创建——认证经 IPC auth:granted 放行后才由主进程接管创建（见下方注册）。
// 非认证主体结构不动：只新增本窗能力，createWindow()/kernel 原样。
// ---------------------------------------------------------------------------
function createAuthWindow() {
  // 防闪白底色跟随主题明暗（与 AuthScreen 的 bg-app 同族），渲染层随后应用完整主题
  const authThemeMeta = readPersistedTheme()
  const authBg = authThemeMeta?.mode === 'light' ? '#fdf9f5' : '#0b0e14'
  authWin = new BrowserWindow({
    width: 420, height: 560, resizable: false, title: 'YFWorking',
    icon: ICON_PATH, show: false, backgroundColor: authBg,  // 与 AuthScreen 主题底一致防闪白
    frame: false,            // 2026-09-10：全界面无边框（含登录小窗）——拖动/关闭由
                             // 渲染层 AuthWindowRoot 的 app-region 拖拽条 + 关闭钮承担
    autoHideMenuBar: true,   // 弹窗级小窗不显示默认菜单栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  authWin.once('ready-to-show', () => { authWin?.center(); authWin?.show() })
  authWin.on('closed', () => {
    authWin = null
    // 冷启动小窗未放行即被关（主窗口从未创建）→ 退出应用，不经 tray 保留分支
    if (!authGranted && (!mainWindow || mainWindow.isDestroyed()) && !isQuitting) app.quit()
  })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) authWin.loadURL(devUrl + '?auth=1')
  else authWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { auth: '1' } })
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  let icon = nativeImage.createFromPath(ICON_PATH)
  if (icon.isEmpty()) icon = nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('YFWorking')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)
}

/**
 * 撤销「已中止的退出」（半死实例的另一半保险）。
 * before-quit 置 isQuitting=true 后若 app.quit() 被窗口否决中止，该闩永不复位 ⇒
 * 进程活着但桥起不来。用户再次索要窗口（点桌面图标 → second-instance、托盘
 * 「打开主窗口」、activate）就是「还要用」的明确信号：复位闩并把桥拉回来。
 * 同时取消退出兜底——用户刚表达了还要用，不能让兜底把应用杀掉。
 */
function reviveIfQuitAborted() {
  if (!isQuitting) return
  isQuitting = false
  bridgeRestartAttempts = 0        // 复位退避：复活要立刻，不能等指数退避到 10s
  if (quitWatchdog) { clearTimeout(quitWatchdog); quitWatchdog = null }
  console.warn('[main] 退出曾被中止 —— 复位 isQuitting 并重拉桥')
  scheduleBridgeRestart()
}

function showMainWindow() {
  reviveIfQuitAborted()
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 最小化时先还原：show() 对已最小化的窗口不会取消最小化状态。
    // （托盘菜单与 second-instance 共用此函数，两条路径都需要这步。）
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else if (authGranted) {
    // 认证已放行 → 主窗口缺失时重建
    createWindow()
  } else {
    // 认证未放行（spec §2.0/D13）：不得预创建主窗口——聚焦已有认证小窗，缺省重建。
    // 未放行关小窗仍能命中 closed 守卫走 app.quit()（不被预建主窗挡道）。
    if (authWin && !authWin.isDestroyed()) {
      authWin.show()
      authWin.focus()
    } else {
      createAuthWindow()
    }
  }
}

// ---------------------------------------------------------------------------
// 泛化 bridge WS 客户端：connectPetBridgeListener 与 connectBrowserExecutor 共用。
// 自动重连 3s（与旧 pet 监听行为一致）；onMessage(msg, ws) 收解析后的消息，
// onOpen(ws) 每次（含重连后）连接建立时回调，onClose(ws) 断开时回调。
// ---------------------------------------------------------------------------
function connectBridgeClient(onMessage, { tag = 'bridge', onOpen, onClose } = {}) {
  try {
    const ws = new WebSocket('ws://localhost:' + BRIDGE_PORT)
    ws.on('open', () => {
      console.log('[main] ' + tag + ' bridge client connected')
      if (typeof onOpen === 'function') { try { onOpen(ws) } catch (e) { console.error('[main] ' + tag + ' onOpen error:', e.message) } }
    })
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (typeof onMessage === 'function') onMessage(msg, ws)
      } catch (e) { /* ignore */ }
    })
    ws.on('close', () => {
      if (typeof onClose === 'function') { try { onClose(ws) } catch (e) { /* ignore */ } }
      setTimeout(() => { if (!isQuitting) connectBridgeClient(onMessage, { tag, onOpen, onClose }) }, 3000)
    })
    ws.on('error', () => {})
    return ws
  } catch (e) {
    console.error('[main] ' + tag + ' bridge client error:', e.message)
    return null
  }
}

// 桌面宠物双击「pet:show-main」→ 打开/聚焦主窗口（作为 bridge 的 WS 客户端监听）
function connectPetBridgeListener() {
  connectBridgeClient((msg) => {
    if (msg.type === 'pet:show-main') {
      console.log('[main] pet double-click → show main window')
      showMainWindow()
    } else if (msg.type === 'pet:quit-app') {
      console.log('[main] pet menu → quit whole app')
      app.quit()
    }
  }, { tag: 'pet' })
}

// ---------------------------------------------------------------------------
// 内置浏览器自动化执行器：同一 bridge WS 上注册 executor:hello，处理
// browser:exec（→ executor.exec → browser:exec:response 回发）与
// browser:control（pause/resume）；executor 的 onEvent → browser:event 广播。
// executor 实例为模块级 browserExecutor，供下方 IPC 处理器共用。
// ---------------------------------------------------------------------------
let browserExecutorWs = null     // 当前执行器 WS 连接（重连后经 onOpen 刷新）
function connectBrowserExecutor() {
  const executor = new BrowserExecutor({
    onEvent: (sessionId, event) => {
      try {
        if (browserExecutorWs && browserExecutorWs.readyState === WebSocket.OPEN) {
          browserExecutorWs.send(JSON.stringify({ type: 'browser:event', sessionId, event }))
        }
      } catch (e) { /* ignore */ }
    },
  })
  browserExecutor = executor
  connectBridgeClient((msg) => {
    if (msg.type === 'browser:exec') {
      const payload = msg.payload || {}
      Promise.resolve(executor.exec(msg.sessionId, payload.action, payload.params || {}))
        .then((res) => {
          try { browserExecutorWs.send(JSON.stringify({ type: 'browser:exec:response', requestId: msg.requestId, ...res })) } catch (e) { /* ignore */ }
        })
        .catch((err) => {
          try { browserExecutorWs.send(JSON.stringify({ type: 'browser:exec:response', requestId: msg.requestId, ok: false, snapshot: null, error: String(err && err.message || err) })) } catch (e) { /* ignore */ }
        })
    } else if (msg.type === 'app:exec') {
      // 应用即工具（Task 4.x）：内核 bridge_request(route=app) → bridge 转本执行器 →
      // 处理体在 electron/app-ipc.cjs 的 handleAppExecMessage（复用 runAppCommand：与
      // app:run IPC 通道同一份执行逻辑与留痕），回写 app:exec:response 由 bridge 转成
      // 内核 stdin 的 app_response。本文件只负责 WS 接线（与 browser:exec 同款）。
      handleAppExecMessage(msg, {
        getExecutor: () => browserExecutor,
        send: (o) => { try { browserExecutorWs.send(JSON.stringify(o)) } catch (e) { /* ignore */ } },
      })
    } else if (msg.type === 'browser:control') {
      executor.onControl(msg.command)
    }
  }, {
    tag: 'browser',
    onOpen: (ws) => {
      browserExecutorWs = ws
      // 执行器首条消息必须是 executor:hello（bridge 据此从 GUI 集合摘除并注册为执行器）
      try { ws.send(JSON.stringify({ type: 'executor:hello' })) } catch (e) { /* ignore */ }
    },
    onClose: (ws) => {
      if (browserExecutorWs === ws) {
        browserExecutorWs = null
        monitor?.onEvent('executor-disconnect')   // 诊断：executor WS 断连事件（触发 browser 组重测）
      }
    },
  })
  console.log('[main] browser executor connected')
  return executor
}

// ---------------------------------------------------------------------------
// 技能经验消费提醒：启动时检查全局技能经验库的 pending 经验，
// 有积压且距上次提醒超过 24h 时推送提醒（自动捕获是闭环的一半，
// 另一半"消费升级"依赖人工触发——本提醒让积压不至于悄悄烂尾）。
// ---------------------------------------------------------------------------
function experienceDir() {
  const yfw = path.join(resolveYfwHome(), 'memory', 'skill_experiences')
  if (fs.existsSync(yfw)) return yfw
  return path.join(os.homedir(), '.trae-cn', 'memory', 'skill_experiences')
}
function experienceAlertStateFile() {
  return path.join(resolveYfwHome(), 'experience-alert.json')
}
const EXPERIENCE_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000

function checkPendingExperiences() {
  const result = { total: 0, bySkill: [], shouldAlert: false }
  const dir = experienceDir()
  let files = []
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_') && !f.includes('.bak'))
  } catch (e) { return result }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
      const pending = (data.experiences || []).filter(e => e && e.status === 'pending')
      if (pending.length > 0) {
        result.bySkill.push({ skill: data.skill_name || f.replace(/\.json$/, ''), count: pending.length })
        result.total += pending.length
      }
    } catch (e) { /* 跳过无法解析的文件 */ }
  }
  if (result.total === 0) return result
  // 24h 去重：同一时间窗内不重复打扰
  let lastAlert = 0
  try { lastAlert = JSON.parse(fs.readFileSync(experienceAlertStateFile(), 'utf-8')).lastAlertAt || 0 } catch (e) {}
  result.shouldAlert = Date.now() - lastAlert > EXPERIENCE_ALERT_INTERVAL_MS
  return result
}

function recordExperienceAlert() {
  try {
    fs.writeFileSync(experienceAlertStateFile(), JSON.stringify({ lastAlertAt: Date.now() }, null, 2))
  } catch (e) {}
}

// Agent 描述写入 YAML frontmatter：压成单行 + 双引号转义（内核解析时会把 \n 还原）
function toYamlString(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"'
}

async function registerIpc() {
  // ---------------------------------------------------------------------------
  // 应用内诊断（Task 5）：monitor 接入主进程 + diag:* IPC。
  // ctx 注入：appPaths（kernel/runtime/python 探测）/executorStatus/petAlive/
  // 崩溃计数/bridge 重启计数。事件驱动接线（bridge-exit/gpu-crash/
  // executor-disconnect）在模块级 handler 处经 monitor?.onEvent 调用；
  // kernel-session-fail 无推送源（bridge 只有 /diag/info 轮询），由 30s 巡检覆盖。
  // ---------------------------------------------------------------------------
  const { createDiagMonitor } = require('./diag-monitor.cjs')
  monitor = createDiagMonitor({
    ctx: {
      appPaths: resolveDiagPaths(),
      executorStatus: async () => {
        if (!browserExecutor) return { connected: false, windows: 0 }
        try {
          // BrowserExecutor 无 sessionCount 方法（v1 单窗口，this.win）：
          // 用 getStatus().windowOpen 等价推导窗口数（有窗口=1，无=0）
          const s = browserExecutor.getStatus()
          return { connected: true, windows: s.windowOpen ? 1 : 0 }
        } catch (_) { return { connected: false, windows: 0 } }
      },
      petAlive: () => !!petProcess && !petProcess.killed,
      gpuCrashCount: () => gpuCrashCount,
      renderCrashCount: () => renderCrashCount,
      bridgeRestartCount: () => bridgeRestartAttempts,
    },
  })
  monitor.setOnChange((snap) => {
    try { mainWindow?.webContents.send('diag:status-changed', snap) } catch (_) {}
  })
  monitor.start()
  app.on('will-quit', () => monitor.stop())

  ipcMain.handle('diag:get-status', () => monitor.getSnapshot() || monitor.runAll())
  ipcMain.handle('diag:rerun', (_e, { id }) => monitor.rerun(id))
  ipcMain.handle('diag:rerun-all', () => monitor.runAll())
  ipcMain.handle('diag:run-kernel-check', () => monitor.runKernelCheck())
  ipcMain.handle('diag:export', () => monitor.exportReport())
  ipcMain.handle('diag:get-boot-summary', () => {
    try { return JSON.parse(fs.readFileSync(path.join(logTee.getLogPath(), '..', 'last-boot.json'), 'utf-8')) } catch (_) { return null }
  })
  ipcMain.handle('diag:open-log-dir', async () => {
    const dir = path.join(logTee.getLogPath(), '..')
    await shell.openPath(dir)
    return dir
  })

  // 知识包离线安装：只收 .zip（S4 D2：下载/分发形态固定为 zip，目录安装走 GUI 之外的路径）
  ipcMain.handle('dialog:open-knowledge-pack', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Knowledge Pack', extensions: ['zip'] }],
      title: 'Select Knowledge Pack (.zip)',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:open-skill-package', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Skill Package (directory with SKILL.md)',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Frameless window controls
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  // 独立工具窗口（2026-09-10 设置/个人外置）：渲染层（rail 齿轮/用户钮）请求
  // 打开；已开则聚焦。kind ∈ { settings, profile }。
  ipcMain.on('utility:open', (_e, kind) => {
    const k = kind === 'profile' ? 'profile' : 'settings'
    const existing = utilityWins.get(k)
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return }
    const utilThemeMeta = readPersistedTheme()
    const win = new BrowserWindow({
      width: 860, height: 620, minWidth: 560, minHeight: 400,
      title: k === 'profile' ? '个人信息' : '设置',
      icon: ICON_PATH, show: false, frame: false,
      backgroundColor: utilThemeMeta?.mode === 'light' ? '#fdf9f5' : '#0b0e14',  // 防闪白底色跟随主题；完整主题由渲染层 main.tsx 应用
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    utilityWins.set(k, win)
    win.on('closed', () => { if (utilityWins.get(k) === win) utilityWins.delete(k) })
    const devUrl = process.env.VITE_DEV_SERVER_URL
    if (devUrl) {
      win.loadURL(devUrl + `?${k}=1`)
    } else {
      win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { [k]: '1' } })
    }
    win.once('ready-to-show', () => { win.show() })
  })
  // 工具窗口关闭钮：按 sender 关对应窗口（不碰主窗口）
  ipcMain.on('utility:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed()) w.close()
  })
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)

  // Task-complete system notification
  ipcMain.handle('app:notify-task', async (_e, payload) => {
    const p = payload || {}
    const win = mainWindow
    if (p.onlyBackground && win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
      return { shown: false }
    }
    new Notification({ title: p.title || 'YFWorking', body: p.body || '', icon: ICON_PATH }).show()
    return { shown: true }
  })

  // Tray behavior
  ipcMain.on('app:set-tray-behavior', (_e, enabled) => { trayEnabled = !!enabled })

  // Desktop pet
  ipcMain.handle('pet:config', async (_e, cfg) => {
    applyPetConfig(cfg || {})
    return { ok: true }
  })

  // Open file/folder in system explorer
  // shell.openPath 返回 Promise<string>（非空字符串即失败原因），必须 await 并透传
  // ——旧实现不检查返回值，explorer 打开失败时静默吞错（2026-08-22 修复）。
  ipcMain.handle('shell:open-path', async (_e, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string') return { ok: false, error: 'empty path' }
    try {
      const resolved = path.resolve(targetPath)
      const err = await shell.openPath(resolved)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  // ---------------------------------------------------------------------------
  // 原生文件编辑器独立窗口（可超出主应用界面）
  // ---------------------------------------------------------------------------
  // 打开/聚焦编辑器窗口并下发文件。bounds 来自主窗口 uiStore.editorRect（持久化缓存），
  // 仅做数值合法性校验；窗口 moved/resized 时回传新边界到主窗口同步缓存。
  ipcMain.handle('editor:open-file', async (_e, payload) => {
    const req = payload && typeof payload === 'object' ? payload : {}
    const filePath = typeof req.path === 'string' ? req.path : ''
    const name = typeof req.name === 'string' ? req.name : ''
    if (!filePath) return { ok: false, error: 'empty path' }

    const b = req.bounds && typeof req.bounds === 'object' ? req.bounds : {}
    const num = (v, lo, hi, dft) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, Math.round(v))) : dft
    const wa = screen.getPrimaryDisplay().workArea
    const bounds = {
      x: num(b.x, 0, Math.max(0, wa.x + wa.width - 320), Math.max(0, wa.x + wa.width - 760 - 32)),
      y: num(b.y, 0, Math.max(0, wa.y + wa.height - 200), Math.max(0, wa.y + (wa.height - 520) / 2)),
      width: num(b.w, 320, wa.width, 760),
      height: num(b.h, 200, wa.height, 520),
    }

    if (!editorWin || editorWin.isDestroyed()) {
      editorWin = new BrowserWindow({
        ...bounds,
        minWidth: 320,
        minHeight: 200,
        title: '文件编辑器',
        icon: ICON_PATH,
        show: false,
        frame: false,
        resizable: true,
        backgroundColor: readPersistedTheme()?.mode === 'light' ? '#fdf9f5' : '#0b0e14',  // 防闪白底色跟随主题
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })

      // 边界变化（拖动/缩放/系统捕捉）回传主窗口，同步 uiStore.editorRect 缓存
      const syncBounds = () => {
        if (!editorWin || editorWin.isDestroyed()) return
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('editor:sync-bounds', editorWin.getBounds())
        }
      }
      editorWin.on('moved', syncBounds)
      editorWin.on('resized', syncBounds)
      editorWin.on('closed', () => { editorWin = null })

      const devUrl = process.env.VITE_DEV_SERVER_URL
      if (devUrl) {
        editorWin.loadURL(devUrl + '?editor=1')
      } else {
        const distPath = path.join(__dirname, '..', 'dist', 'index.html')
        editorWin.loadFile(distPath, { query: { editor: '1' } })
      }
      editorWin.once('ready-to-show', () => { editorWin?.show() })
    }

    // 文件登记为 pending，供渲染层挂载后 invoke 拉取（规避 IPC 竞态）；
    // 窗口已就绪时直接推送。
    pendingEditorFile = { path: filePath, name }
    if (!editorWin.webContents.isLoading()) {
      editorWin.webContents.send('editor:open-file', pendingEditorFile)
    }
    editorWin.setBounds(bounds)
    if (editorWin.isMinimized()) editorWin.restore()
    editorWin.show()
    editorWin.focus()
    return { ok: true }
  })

  // 编辑器窗口渲染层挂载后拉取待打开文件（取走即清空，避免窗口重载后拿到陈旧文件）
  ipcMain.handle('editor:get-pending', async () => {
    const f = pendingEditorFile
    pendingEditorFile = null
    return f
  })

  // ---------------------------------------------------------------------------
  // 内置浏览器自动化：窗口/清空会话/状态/暂停/继续（IPC 直连主进程，不经内核）。
  // executor 实例为模块级 browserExecutor（connectBrowserExecutor 创建）。
  // ---------------------------------------------------------------------------
  ipcMain.handle('browser:open', async (_e, sessionId) => {
    if (!browserExecutor) return { ok: false, error: 'executor 未初始化' }
    // keepAlive：用户主动打开/登录过的窗口点 X 只隐藏不销毁。
    // 站点把登录态存 sessionStorage 时（yfljsj.com 这类 SPA），销毁渲染进程 = 丢掉刚登录的会话，
    // 用户重开同一站点又回到登录页（＝"登录状态没有保存"）。要真正清除请用「清空会话」。
    return browserExecutor.openWindow(sessionId, { keepAlive: true })
  })
  ipcMain.handle('browser:clear-session', async (_e, sessionId) => {
    if (!browserExecutor) return { ok: false, error: 'executor 未初始化' }
    return browserExecutor.closeSession(sessionId)
  })
  ipcMain.handle('browser:status', () => {
    return browserExecutor
      ? browserExecutor.getStatus()
      : { windowOpen: false, url: null, mode: 'normal', humanMode: false }
  })
  ipcMain.handle('browser:pause', async (_e, _sessionId) => {
    if (browserExecutor) browserExecutor.onControl('pause')
    return { ok: true }
  })
  ipcMain.handle('browser:resume', async (_e, _sessionId) => {
    if (browserExecutor) browserExecutor.onControl('resume')
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // 应用智控：列表/CRUD/Spec/控制台绑定/探测/执行/生成（实现见 electron/app-ipc.cjs）。
  // getExecutor 传**取值函数**而非实例：browserExecutor 在 connectBrowserExecutor
  // 之后才存在，注册时可能还是 null（与上方 browser:* 通道同款处理）。
  // ---------------------------------------------------------------------------
  // getWebContents：生成进度事件（app:generate-progress）用于"如实展示生成到哪一步"
  registerAppHandlers({
    ipcMain,
    getExecutor: () => browserExecutor,
    getWebContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
  })

  // 编辑器窗口内关闭按钮 / 标签全关闭后的自动收起
  ipcMain.on('editor:close-window', () => {
    if (editorWin && !editorWin.isDestroyed()) editorWin.close()
  })

  // Agent 注册表同步：写入/删除 $YFW_HOME/agents/<id>.md，供内核识别 GUI 注册的
  // 专业/自定义 agent 作为子 agent（方案 A，零内核改动）。
  // 只处理 professional/custom 且 enabled 的 agent；builtin 内核原生已有不注入。
  // 用 .yfw-managed.json 记录 GUI 管理的 id，删除时只删这些，不触碰用户手写文件。
  ipcMain.handle('agents:sync', async (_e, agents) => {
    try {
      const yfwHome = ensureYfwHome()
      const agentsDir = path.join(yfwHome, 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      const registryFile = path.join(agentsDir, '.yfw-managed.json')
      let registry = []
      try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')) } catch {}
      if (!Array.isArray(registry)) registry = []
      const managed = Array.isArray(agents)
        ? agents.filter(a => a && (a.type === 'professional' || a.type === 'custom'))
        : []
      const written = []
      const removed = []
      const keep = new Set()
      for (const a of managed) {
        const whenToUse = String(a.whenToUse || a.description || '').trim()
        if (!a.enabled || !whenToUse) continue
        const prompt = String(a.systemPrompt || '').trim()
        const body = prompt || `你是 YFWorking 的 Agent「${a.name}」：${a.description}。使用简体中文，严禁自称 Claude、Anthropic 或其他 AI 品牌。`
        const lines = ['---', `name: ${a.id}`, `description: ${toYamlString(whenToUse)}`]
        if (Array.isArray(a.tools) && a.tools.length > 0) lines.push(`tools: ${a.tools.join(', ')}`)
        if (a.model) lines.push(`model: ${a.model}`)
        if (Array.isArray(a.skills) && a.skills.length > 0) lines.push(`skills: ${a.skills.join(', ')}`)
        // 绑定的工作流 id（内核按 agentId 过滤 expose.mode=bound 工作流的工具可见性）；
        // 空数组/缺失不写该行，与 skills/tools 同策略（parseAgentMarkdown 缺字段 → []）。
        if (Array.isArray(a.workflows) && a.workflows.length > 0) lines.push(`workflows: ${a.workflows.join(', ')}`)
        lines.push('---', '', body)
        fs.writeFileSync(path.join(agentsDir, `${a.id}.md`), lines.join('\n'), 'utf8')
        written.push(a.id)
        keep.add(a.id)
      }
      for (const id of registry) {
        if (keep.has(id)) continue
        const f = path.join(agentsDir, `${id}.md`)
        if (fs.existsSync(f)) { try { fs.unlinkSync(f); removed.push(id) } catch {} }
      }
      fs.writeFileSync(registryFile, JSON.stringify([...keep]))
      console.log('[main] agents:sync → written:', written.join(','), 'removed:', removed.join(','))
      return { ok: true, written, removed }
    } catch (e) {
      console.warn('[main] agents:sync error:', e.message)
      return { ok: false, error: e.message }
    }
  })

  // ---------------------------------------------------------------
  // 个人经验库（experience.mjs）+ 导出/导入（packager.mjs）
  // ---------------------------------------------------------------
  ipcMain.handle('experience:list', async () => {
    try {
      refreshIndex()
      const list = listExperiences()
      return { ok: true, themes: list }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('experience:set-active', async (_e, payload) => {
    try {
      const theme = String(payload?.theme || '')
      const active = !!payload?.active
      const res = setThemeActive(theme, active)
      refreshIndex()
      return { ...res }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('experience:delete-entry', async (_e, payload) => {
    try {
      const res = deleteThemeEntry(String(payload?.theme || ''), String(payload?.hash || ''))
      refreshIndex()
      return { ...res }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('experience:export', async (_e, payload) => {
    try {
      const included = Array.isArray(payload?.included) ? payload.included : []
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出 YFWorking 经验/数据',
        defaultPath: path.join(app.getPath('downloads'), `yfworking-export-${new Date().toISOString().slice(0, 10)}.zip`),
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      const res = await exportPackage({
        outPath: result.filePath,
        included,
        sensitiveWords: Array.isArray(payload?.sensitiveWords) ? payload.sensitiveWords : [],
        chatsJson: typeof payload?.chatsJson === 'string' ? payload.chatsJson : null,
        projectCwd: typeof payload?.projectCwd === 'string' ? payload.projectCwd : null,
        configRedact: payload?.configRedact !== false,
        chatsFilter: payload?.chatsFilter && typeof payload.chatsFilter === 'object' ? payload.chatsFilter : null,
      })
      return res
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('experience:import', async (_e, payload) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入 YFWorking 经验/数据包',
        properties: ['openFile'],
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true }
      const res = await importPackage(result.filePaths[0], {
        conflict: payload?.conflict || 'skip',
        projectCwd: typeof payload?.projectCwd === 'string' ? payload.projectCwd : null,
      })
      return res
    } catch (e) { return { ok: false, error: e.message } }
  })
}

// ---------------------------------------------------------------------------
// Desktop pet
// ---------------------------------------------------------------------------
function resolvePetScript() {
  const bundled = path.join(__dirname, '..', '..', 'pet', 'jiajia-pet.py')
  if (fs.existsSync(bundled)) return bundled
  const appPet = path.join(__dirname, '..', 'pet', 'jiajia-pet.py')
  if (fs.existsSync(appPet)) return appPet
  return null
}

function spawnPet() {
  const script = resolvePetScript()
  if (!script || petProcess) return

  const petPython = findPythonForPet()
  const env = { ...process.env }
  const pythonDir = path.dirname(petPython)
  const tclDir = path.join(pythonDir, 'tcl')
  if (fs.existsSync(tclDir)) {
    env.TCL_LIBRARY = path.join(tclDir, 'tcl8.6')
    env.TK_LIBRARY = path.join(tclDir, 'tk8.6')
  }
  console.log('[pet] spawning:', petPython, script)
  const proc = spawn(petPython, [script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  })
  petProcess = proc
  petIntentKill = null
  proc.stdout.on('data', (data) => console.log('[pet]', data.toString().trim()))
  proc.stderr.on('data', (data) => console.log('[pet:err]', data.toString().trim()))
  proc.on('error', (err) => {
    console.error('[pet] spawn error:', err.message)
    if (petProcess === proc) petProcess = null
  })
  proc.on('exit', (code) => {
    if (petProcess === proc) petProcess = null
    if (petIntentKill === proc) {
      // 主进程主动终止（配置变更重启 / 应用退出）——无需额外处理
      petIntentKill = null
      return
    }
    // 宠物自身退出（如用户右键「退出」）：本次会话内不再自动拉起
    console.log('[pet] exited unexpectedly (code=' + code + ') — pet disabled until re-enabled in settings')
    petConfig.enabled = false
  })
}

function killPet() {
  const proc = petProcess
  petProcess = null
  if (!proc || proc.killed) return
  petIntentKill = proc
  if (process.platform === 'win32') {
    // Windows 下 SIGTERM 不可靠，用 taskkill 强制结束进程树，避免旧宠物窗口残留
    taskkillPid(proc.pid)
  } else {
    try { proc.kill('SIGTERM') } catch (e) { console.error('[pet] kill error:', e.message) }
  }
}

function applyPetConfig(cfg) {
  cfg = cfg || {}
  const prev = { ...petConfig }
  Object.assign(petConfig, cfg)

  const cfgPath = path.join(resolveYfwHome(), 'pet.json')
  try {
    if (!fs.existsSync(path.dirname(cfgPath))) fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify({
      enabled: petConfig.enabled,
      size: petConfig.size,
      randomChat: petConfig.randomChat,
    }, null, 2))
  } catch (e) {
    console.warn('[pet] failed to persist config:', e.message)
  }

  const script = resolvePetScript()
  const running = petProcess && !petProcess.killed
  if (petRestartTimer) { clearTimeout(petRestartTimer); petRestartTimer = null }
  if (petConfig.enabled && script) {
    if (!running) {
      spawnPet()
    } else if (
      (typeof cfg.size !== 'undefined' && cfg.size !== prev.size) ||
      (typeof cfg.randomChat !== 'undefined' && cfg.randomChat !== prev.randomChat)
    ) {
      // 防抖：滑块拖动等连续变更只重启一次
      petRestartTimer = setTimeout(() => { petRestartTimer = null; killPet(); spawnPet() }, 400)
    }
  } else if (!petConfig.enabled) {
    killPet()
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// First-run setup — create ~/.yfworking/ and seed skills/config
// ---------------------------------------------------------------------------
function ensureYfwHome() {
  const yfwHome = resolveYfwHome()
  const yfwSkills = path.join(yfwHome, 'skills')

  if (!fs.existsSync(yfwHome)) fs.mkdirSync(yfwHome, { recursive: true })
  if (!fs.existsSync(yfwSkills)) fs.mkdirSync(yfwSkills, { recursive: true })

  // Seed sample skills on first run only (skip if any skill already present)
  const existing = fs.existsSync(yfwSkills) ? fs.readdirSync(yfwSkills) : []
  const hasSkill = existing.some(n => n.endsWith('.md') || n === '_skill_index.json')
  if (!hasSkill) {
    const candidates = [
      path.join(__dirname, '..', 'public', 'sample-skills'),
      path.join(__dirname, '..', 'sample-skills'),
      path.join(__dirname, '..', 'dist', 'sample-skills'), // vite build output
      path.join(process.resourcesPath || '', 'public', 'sample-skills'),
      path.join(process.resourcesPath || '', 'sample-skills'),
      path.join(process.resourcesPath || '', 'dist', 'sample-skills'),
    ]
    let src = null
    for (const c of candidates) {
      if (c && fs.existsSync(c)) { src = c; break }
    }
    if (src) {
      try {
        const entries = fs.readdirSync(src, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const from = path.join(src, entry.name)
          const to = path.join(yfwSkills, entry.name)
          if (fs.existsSync(to)) continue
          fs.cpSync(from, to, { recursive: true })
        }
        console.log('[main] seeded sample skills →', yfwSkills)
      } catch (e) {
        console.warn('[main] failed to seed sample skills:', e.message)
      }
    } else {
      console.warn('[main] no sample-skills dir found in candidates:', candidates)
    }
  }
  return yfwHome
}

// ---------------------------------------------------------------------------
// Single-instance lock — prevents zombie processes when user clicks the
// shortcut multiple times.  Only the first instance is allowed to run;
// subsequent ones focus the existing window instead.
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 复用 showMainWindow()（与托盘「打开主窗口」同源）。此前内联的 `if (mainWindow)`
    // 在主窗口已被销毁时静默无操作 —— 而该实例仍占着单实例锁，用户再点图标完全
    // 没有反馈（2026-09-14 实况：主窗口渲染进程已退出、mainWindow=null）。
    // showMainWindow() 在认证已放行时会重建主窗口，未放行时聚焦/重建认证小窗。
    showMainWindow()
  })

  // ---------------------------------------------------------------------------
  // 启动打点 + 渲染层错误捕获 + 启动失败原生对话框（Task 2）
  // bootPhase：每阶段调用一次（mainReady/bridgeSpawn/bridgeReady/windowLoad），
  // 任一失败置 bootPhaseFailed，will-quit 时 writeBootSummary 汇总写 last-boot.json。
  // ---------------------------------------------------------------------------
  const bootNodes = []
  let bootPhaseFailed = false
  let bootDialogShown = false       // did-fail-load 兜底弹窗防抖（仅一次）
  let bootStartAt = Date.now()      // 启动基线（whenReady 首行刷新，用于 60s 兜底窗口）
  function bootPhase(name, ok = true, err = null) {
    bootNodes.push({ name, at: new Date().toISOString(), ok: !!ok, error: err ? String(err).slice(0, 500) : undefined })
    if (!ok) bootPhaseFailed = true
    if (err) console.error(`[boot] ${name} failed:`, err)
  }
  function writeBootSummary() {
    try {
      const p = path.join(ensureYfwHome(), 'logs', 'last-boot.json')
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify({ ok: !bootPhaseFailed, nodes: bootNodes, failedAt: bootPhaseFailed ? new Date().toISOString() : null }, null, 2), 'utf-8')
    } catch (_) {}
  }
  // showBootFailureDialog 已上移到顶层（见 startBridgeAndWait 上方注释）。
  function registerRendererErrorCapture(win) {
    if (!win || !win.webContents) return
    // did-fail-load：单行摘要入盘（崩溃跨多行由 tee 处理，此处仅 console.error 摘要）。
    // 启动兜底：主框架加载失败 + 启动 60s 内 → 原生异常对话框（防抖仅一次）。
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[render] did-fail-load code=${code} desc=${desc} url=${url}`)
      if (!bootDialogShown && win === mainWindow && !mainWindow.isDestroyed() &&
          !mainWindow.webContents.isLoadingMainFrame() && Date.now() - bootStartAt < 60000) {
        bootDialogShown = true
        // 弹窗已代表用户可见的启动失败，同步标记 windowLoad 失败，last-boot.json 不再误报 ok
        bootPhase('windowLoad', false, new Error(`did-fail-load code=${code} desc=${desc} url=${url}`))
        showBootFailureDialog()
      }
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      renderCrashCount += 1   // 诊断：渲染进程崩溃计数（render-health 检测；无专用事件，由 30s 巡检覆盖）
      console.error(`[render] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
    })
    // console-message：Electron ≥32 新签名 (event, {level,message,lineNumber,sourceId})，
    // 旧版 (event, level, message, line, sourceId)——兼容两者。
    // 2026-09-10 排障：渲染层 console 落盘——应用经快捷方式启动无终端，渲染层日志
    // 此前完全不可见；流式/渲染故障排查靠这份文件。2026-09-12 起统一走 log-policy
    // （原先的 512KB 私有截断删除：与其余三处口径不一致、且无年龄清理）。
    // 2026-09-13（R1）：门控 + 缓冲收进 createRendererConsoleSink（server/log-policy.cjs）
    // ——采样判据与落盘策略同为可测的纯逻辑；此处只做签名归一。
    win.webContents.on('console-message', (...args) => {
      const d = args[1]
      if (d && typeof d === 'object' && typeof d.message === 'string') {
        renderConsoleSink.handle(d.message, d.sourceId, d.lineNumber)
      } else {
        const [, , message, line, sourceId] = args
        renderConsoleSink.handle(message, sourceId, line)
      }
    })
    win.webContents.on('preload-error', (_e, p, err) =>
      console.error(`[render] preload-error ${p}: ${err.message}`))
    win.webContents.on('unresponsive', () => console.error('[render] unresponsive'))
  }

  // 认证放行（spec §2.0/D13；Task 6b）：认证小窗登录/首设成功 → 渲染层发 auth:granted →
  // 关小窗、创建主窗口（bootStartAt 重置刷新 60s 启动兜底窗口基线，did-finish-load 接 bootPhase）。
  // 注册在此（而非 registerIpc）：处理器需触及 else 块作用域内 let bootStartAt/bootPhase。
  // 认证小窗关闭钮（2026-09-10 无边框登录窗）：关小窗即走 authWin 'closed' 的
  // 既有语义——未放行且主窗口未创建时退出应用。
  ipcMain.on('auth:close', () => {
    const w = authWin
    if (w && !w.isDestroyed()) w.close()
  })

  ipcMain.on('auth:granted', () => {
    authGranted = true
    const w = authWin
    authWin = null
    if (w && !w.isDestroyed()) w.close()
    if (!mainWindow || mainWindow.isDestroyed()) {
      bootStartAt = Date.now()   // 刷新 60s 启动兜底弹窗窗口基线
      createWindow()
      mainWindow?.webContents.once('did-finish-load', () => { bootPhase('windowLoad'); flushBootProgress() })
    }
  })

  app.whenReady().then(async () => {
    bootPhase('mainReady')
    bootStartAt = Date.now()   // 刷新启动基线（60s 兜底弹窗窗口）
    await registerIpc()

    // First-run: make sure ~/.yfworking/ exists and has skills
    const yfwHome = ensureYfwHome()
    console.log('[main] YFWorking home:', yfwHome)

    // Reuse an already-running bridge if present (adopt + supervise it),
    // else start our own. 复用不等于放手不管：接管后由健康轮询兜底，
    // 外部 bridge 一旦死亡立即回收重启，杜绝"端口空转、前端无限重连"。
    bootPhase('bridgeSpawn')
    // 2026-08-22 判据统一：先 netstat 看端口真实监听者，再严格 /health 校验。
    // 端口被健康桥占用 → 接管；被半死/残留 bridge 占用 → 回收后自起；空闲 → 自起。
    // 旧逻辑 isPortInUse（有响应即活）会让"假桥"永久卡住（见 isBridgeHealthy 注释）。
    // 2026-09-09 孤儿桥修复：不再收养端口上的外部健康桥（旧构建孤儿被收养 =
    // 应用与旧内核通信，"重启后无法唤醒"）。单实例语义：任何本应用残留桥一律
    // 回收后自起当前构建；外来进程占位则交给 startBridgeAndWait 的失败路径报错。
    const portPid = await findPortPid(BRIDGE_PORT)
    if (portPid && await isBridgeProcess(portPid)) {
      console.warn('[main] recycling external bridge pid ' + portPid + ' — starting fresh')
      taskkillPid(portPid)
      await new Promise((r) => setTimeout(r, 500))
    }
    await startBridgeAndWait()
    startBootProgressPoll() // 真实预热进度：桥已就绪，轮询其模块级就绪状态转发渲染层
    // D11-D13：冷启动先建认证小窗（?auth=1），主窗口在 auth:granted 后才创建（资源认证后才加载）
    createAuthWindow()
    createTray()
    connectPetBridgeListener()
    connectBrowserExecutor()

  // Restore last session's pet state (~/.yfworking/pet.json); skip if absent
  const petCfgPath = path.join(resolveYfwHome(), 'pet.json')
  if (fs.existsSync(petCfgPath)) {
    try {
      applyPetConfig(JSON.parse(fs.readFileSync(petCfgPath, 'utf8')))
    } catch (e) {
      console.warn('[pet] failed to load saved config:', e.message)
    }
  }
})

app.on('window-all-closed', () => {
  if (isQuitting || !trayEnabled) {
    killBridge()
    killPet()
    app.quit()
  }
  // 托盘模式下窗口全部关闭时应用转入后台运行，不做任何事
})

app.on('before-quit', () => {
  isQuitting = true
  killBridge()
  killPet()
  // 退出前先销毁浏览器执行器的全部窗口（含**挂起保活**的登录窗）：
  // keepAlive 登录窗的 close 处理器会 preventDefault「点 X 只隐藏」，而 app.quit()
  // 只要有一个窗口否决就被**中止**，应用随即停在半死态（见 armQuitWatchdog）。
  // 本行是 will-quit 里那句 destroyAllWindows 的前移：will-quit 需要窗口先关完
  // 才触发，而被否决的退出永远等不到它。
  if (browserExecutor) { try { browserExecutor.destroyAllWindows?.() } catch {} }
  armQuitWatchdog()
})

app.on('will-quit', () => {
  // 启动打点汇总落盘（成功/失败都写；writeBootSummary 内部 try/catch 兜底）
  writeBootSummary()
  // R1：渲染器 console 缓冲强制落盘（最多丢一个 1s/100 行窗口，但正常退出不该丢）
  try { renderConsoleSink.flush() } catch { /* 静默：退出路径不因日志设施失败而改变 */ }
  // 残留清扫兜底（幂等，防御性）：before-quit 已清扫，此处再清一次，
  // 覆盖 before-quit 之后新增的残留（bridge/宠物/浏览器执行器窗口）
  try { killBridge() } catch {}
  try { killPet() } catch {}
  if (browserExecutor) {
    try { browserExecutor.stopFingerprintPoll?.() } catch {}
    // destroyAllWindows：连**挂起保活**的登录窗口一起清（keepAlive 窗口不受 X 关闭影响，
    // 退出时必须显式销毁，否则分区/渲染进程残留到进程结束）
    try { browserExecutor.destroyAllWindows?.() } catch {}
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // D11-D13：本次运行已认证放行 → 直接建主窗口；未放行（冷启动小窗被关后 activate）→ 回到认证小窗
    if (authGranted) createWindow()
    else createAuthWindow()
  }
})
} // end single-instance lock else block
