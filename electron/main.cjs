/**
 * Ponos Desktop — Electron main process.
 *
 * Architecture:
 *   Renderer (React) ──WebSocket──► bridge server (node server/bridge.mjs) ──stdio──► claude CLI
 *
 * Electron auto-starts the bridge, then loads the frontend.
 * CommonJS so Electron runs it directly without transpilation.
 */
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Tray, Notification, nativeImage, screen, session, clipboard } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const WebSocket = require('ws')

// 个人经验库（experience.mjs）+ 导出/导入（packager.mjs）。server/ 为 ESM，
// Node 22+ 支持 require() ESM（无顶层 await 的模块可被同步加载）。
const { listExperiences, setThemeActive, deleteThemeEntry, refreshIndex } = require('../server/experience.mjs')
const { exportPackage, importPackage } = require('../server/packager.mjs')
// 内置浏览器自动化执行器（窗口/CDP/快照/人工接管/下载）
const { BrowserExecutor } = require('./browser-executor.cjs')
// 模块化窗口（Task 2-6）：模块注册表 / 状态总线 / 窗口管理器
const { createStateBus } = require('./state-bus.cjs')
const { createWindowManager, clampBounds } = require('./window-manager.cjs')
const { listModules, getModule, parseManifest } = require('./module-registry.cjs')
// 服务化：dock 贴边行为 + 审批中心（路线 B 重构收敛）
const { createDockService } = require('./dock-service.cjs')
const { createApprovalCenter } = require('./approval-center.cjs')

// Ponos home 单点解析：dev 调试版经 PONOS_HOME env 指向独立目录
// （~/.ponos-dev），与正式版 ~/.ponos 完全隔离——技能/密钥/会话/
// 内核 bootstrap 互不干扰。缺省回落正式版默认路径。
function ponosHome() {
  return process.env.PONOS_HOME ? path.resolve(process.env.PONOS_HOME) : path.join(os.homedir(), '.ponos')
}

// ---------------------------------------------------------------------------
// 应用内诊断（Task 2）：日志 tee 最早期接入——启动序列第一行日志即入盘。
// 崩溃清扫挂点：崩溃（uncaughtException/unhandledRejection）时优雅清扫残留运行。
// killBridge/killPet 为函数声明（提升），回调在崩溃时才执行，此时全部已定义；
// browserExecutor 同理（connectBrowserExecutor 前为 null，可选链兜底）。
// ---------------------------------------------------------------------------
const { initLogTee } = require('./log-tee.cjs')
const logTee = initLogTee()
logTee.onCrash(() => {
  try { killBridge() } catch {}
  try { killPet() } catch {}
  if (browserExecutor) {
    try { browserExecutor.stopFingerprintPoll?.() } catch {}
    try { browserExecutor.destroyWindow?.() } catch {}
  }
})

function findPythonExe() {
  // 候选顺序：dev 便携版 app 根 runtime → 仓库布局上溯两级 → electron-builder
  // 打包版 <app>/resources/runtime（extraResources 落点）。全部缺失回退 PATH。
  const candidates = [
    path.join(__dirname, '..', 'runtime', 'python', 'python.exe'),
    path.join(__dirname, '..', '..', 'runtime', 'python', 'python.exe'),
    path.join(__dirname, '..', 'resources', 'runtime', 'python', 'python.exe'),
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return 'python'
}
const PYTHON_EXE = findPythonExe()

// 应用内诊断（Task 5）：kernel/bun/python 路径探测。只做 existsSync 探测选第一个
// kernel 存在的候选（spec 约束：detection 不得改变系统状态），不复刻 bridge
// findPonos 的 bootstrap/拷贝副作用。候选相对路径与 bridge.mjs 同款
// （monitor 的 __dirname=server/，本文件 __dirname=electron/，深度一致）：
// 打包版 <app>/kernel + <app>/runtime/bun；dev 版上溯两级。python 复用
// findPythonExe()，但裸命令名 'python' 会令 monitor 的 existsSync 相对 cwd 误报
// （I4 语义）——map 成 null，monitor 对 null 返回 unknown。
function resolveDiagPaths() {
  // 打包版 kernel 在 <app>/resources/app/kernel-dist，bun/python 在
  // <app>/resources/runtime/（electron-builder files vs extraResources 分根），
  // 与 bridge findPonos 的交叉组合候选保持一致。
  const candidates = [
    { kernel: path.join(__dirname, '..', 'kernel', 'cli.mjs'), bun: path.join(__dirname, '..', 'runtime', 'bun', 'bun.exe') },
    { kernel: path.join(__dirname, '..', '..', 'kernel', 'cli.mjs'), bun: path.join(__dirname, '..', '..', 'runtime', 'bun', 'bun.exe') },
    { kernel: path.join(__dirname, '..', 'kernel-dist', 'cli.mjs'), bun: path.join(__dirname, '..', '..', 'runtime', 'bun', 'bun.exe') },
  ]
  let appPaths = { kernel: null, bun: null }
  for (const c of candidates) {
    if (fs.existsSync(c.kernel)) { appPaths = c; break }
  }
  const python = findPythonExe()
  return { ...appPaths, python: python === 'python' ? null : python }
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
  try { app.setAppUserModelId('com.ponos.desktop') } catch {}
}

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
let editorWin = null            // 原生文件编辑器独立窗口（可超出主应用界面）
let pendingEditorFile = null    // 待编辑器窗口拉取的文件（渲染层挂载后 invoke 拉取，规避 IPC 竞态）
// 豆包图片生成：登录窗口隐藏常驻（persist:doubao 分区），生成请求在页面上下文执行
// 失速防护（2026-08-17 卡死调查）：空闲超阈值销毁窗口（doubao.com 重站点持续跑
// SSE/shared worker/动画 = 持续 GPU/网络负载），下次生成时按需静默重建。
let doubaoWin = null            // 豆包隐藏常驻窗口（登录成功后 hide，补登录时 show）
let doubaoLoggedIn = false      // 登录判定防重入守卫
let doubaoLoginWaiters = []     // 等待登录判定完成的 resolver（静默重建后等 cookie 自动登录）
let doubaoBusy = false          // 生成请求在途标记（空闲销毁不得打断在途请求）
let doubaoLastUse = 0           // 最近一次生成/捕获活动时间戳
let doubaoIdleTimer = null      // 空闲销毁轮询定时器
// 豆包会话文件：契约与 server/doubao.mjs 的 sessionFile() 一致
const DOUBAO_SESSION_FILE = path.join(ponosHome(), 'doubao-session.json')
const DOUBAO_URL = 'https://www.doubao.com/chat/create-image'
let bridgeProcess = null
let bridgeAdopted = false           // 端口上跑的是"接入"的外部 bridge（非本进程 spawn）
let bridgeHealthTimer = null        // 接入外部 bridge 后的健康轮询定时器
let bridgeHealthFails = 0           // 连续健康检查失败次数
let bridgeRestartTimer = null        // bridge 意外退出的重启防抖定时器
let bridgeRestartAttempts = 0        // 连续重启计数（指数退避，防崩溃循环）
const BRIDGE_RESTART_BASE_MS = 2000
const BRIDGE_RESTART_MAX_MS = 10000
const BRIDGE_HEALTH_INTERVAL_MS = 5000  // 接管的外部 bridge 健康探活间隔
const BRIDGE_HEALTH_MAX_FAILS = 3       // 连续失败 N 次（约 15s）判定接管 bridge 死亡
let tray = null
let trayEnabled = true
let isQuitting = false
let browserExecutor = null        // 内置浏览器自动化执行器（connectBrowserExecutor 创建，IPC 共用）
let petProcess = null
let gpuCrashCount = 0            // 诊断：GPU 进程崩溃累计（child-process-gone 处 ++）
let renderCrashCount = 0         // 诊断：渲染进程崩溃累计（render-process-gone 处 ++）
let monitor = null               // 应用内诊断 monitor（registerIpc 内创建；模块级事件 handler 经可选链引用）
let petConfig = { enabled: false, size: 50, randomChat: true, pet: 'jiajia' }
let petIntentKill = null     // 主动 kill 的宠物进程（区分“用户右键退出”导致的意外退出）
let petRestartTimer = null   // 宠物配置变更重启的防抖定时器
const ICON_PATH = path.join(__dirname, '..', 'public', 'icon.png')
// dev 版（PONOS_HOME 注入）默认 51310（与 dev dist 编译端口一致、与 YFWorking 的 51309 错开）；
// 正式版默认 51311（与 YFWorking 51309 彻底隔离，避免端口互踩）。
const BRIDGE_PORT = parseInt(process.env.PONOS_BRIDGE_PORT || (process.env.PONOS_HOME ? '51310' : '51311'), 10)
const BRIDGE_READY_URL = `http://localhost:${BRIDGE_PORT}/health`

// ---------------------------------------------------------------------------
// Bridge lifecycle
// ---------------------------------------------------------------------------
/** Check if something already listens on the bridge port. */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => {
      res.resume()
      resolve(true)
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

function startBridge() {
  const serverPath = path.join(__dirname, '..', 'server', 'bridge.mjs')
  console.log('[main] starting bridge:', serverPath)

  bridgeProcess = spawn(resolveNode(), [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
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
    // 若期间已有新的 bridge 监听同端口（例如用户又启动了另一实例），直接接管并清零退避
    if (await isPortInUse(BRIDGE_PORT)) {
      bridgeRestartAttempts = 0
      console.log('[main] bridge already running — adopting, restart counter reset')
      adoptBridge()
      return
    }
    startBridge()
  }, delay)
}

// ---------------------------------------------------------------------------
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
    const ok = await isPortInUse(BRIDGE_PORT)
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

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
// 主题 → 磁盘同步：渲染层在启动/切主题时经 IPC 写入 theme.json；
// 创建窗口前读取，决定是否用真透明窗口（仅 glass 主题需要）。
// 实测：非 glass 主题下页面不透明背景本就把透明合成完全盖住（视觉无差异），
// 但透明窗口让每个 CSS 动画都走每帧全窗合成路径（旧 GPU 上 ~13% GPU + 放大
// 渲染进程动画成本）——非 glass 主题改为不透明窗口是纯性能优化、零视觉回归。
const THEME_FILE = () => path.join(app.getPath('userData'), 'theme.json')
const GLASS_THEMES = ['glass', 'glass-warm']
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

// ---------------------------------------------------------------------------
// 模块化窗口（Task 2-6）：状态总线 + 窗口管理器 + 服务（dock/审批）
// ---------------------------------------------------------------------------
const stateBus = createStateBus()

// DockService：导航栏窗口贴边/自动隐藏/悬浮（光标轮询收敛于此）
const dockService = createDockService({ screen })

// ApprovalCenter：审批队列 + 窗口调度（主进程正规化）
const approvalCenter = createApprovalCenter({ windowManager: null, bus: stateBus })

function loadModuleUrl(win, moduleId, params = {}) {
  const q = new URLSearchParams({ module: moduleId, ...params })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(`${devUrl}?${q.toString()}`)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: Object.fromEntries(q) })
  }
}

const windowManager = createWindowManager({
  getModule,
  bus: stateBus,
  createWindow: (mod, params) => {    const win = new BrowserWindow({
      ...mod.windowSpec,
      title: mod.name,
      icon: ICON_PATH,
      show: false,
      frame: mod.windowSpec.frame === true,  // 内置模块默认无边框（仿主窗口）
      backgroundColor: '#100c08',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    // 边界变化回传（沿 editor:sync-bounds 模式）——dock 窗口除外：
    // dock 的 moved 由 DockService 接管（解除吸附变悬浮），不做 setBounds 回传
    if (mod.id !== 'dock') {
      win.on('moved', () => windowManager.setBounds(mod.id, win.getBounds()))
      win.on('resized', () => windowManager.setBounds(mod.id, win.getBounds()))
    }
    // 渲染层错误入盘
    registerRendererErrorCapture(win)
    // 窗口级 StateBus 接入：webContents 订阅总线（task/question/approval/module 全通道），
    // 销毁时自动 detach（防悬挂订阅残留 target）
    for (const ch of ['task', 'question', 'approval', 'module']) stateBus.subscribe(ch, win.webContents)
    win.webContents.on('destroyed', () => stateBus.detach(win.webContents))
    loadModuleUrl(win, mod.id, params)
    win.once('ready-to-show', () => win.show())
    return win
  },
  onClosed: (windowId) => {
    // 窗口销毁 → 移除其 StateBus 订阅（各窗口 webContents 已随窗口销毁，
    // detach 兜底清理残留 target）
  },
  // 类型化创建钩子：dock → DockService 贴边；approval → 置顶聚焦
  hooks: {
    onWindowCreated: (type, win) => {
      if (type === 'dock') dockService.attach(win)
      else if (type === 'approval') {
        win.setAlwaysOnTop(true)
        win.setResizable(false)
        win.once('ready-to-show', () => { win.show(); win.focus() })
      }
    },
    onWindowClosed: (type) => {
      if (type === 'dock') dockService.detach()
    },
  },
})
// ApprovalCenter 依赖 windowManager（延迟接线，避免循环引用）
approvalCenter.windowManager = windowManager

function createWindow() {
  // 无主题记录时默认透明（保持历史行为，防止升级后玻璃用户视觉回归）
  const themeMeta = readPersistedTheme()
  const isGlass = !themeMeta || GLASS_THEMES.includes(themeMeta.theme)
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Ponos dev',
    // Windows 透明窗口必须 frame:false（titleBarStyle:'hidden' 保留系统 frame，
    // 会挡住 DWM 透明合成，实测 Win10 无法透出桌面）。
    // 取舍：放弃系统 1px 边框/阴影/系统边缘拖拽，换来玻璃主题真透桌面；
    // 非 glass 主题页面不透明背景照常盖住透明合成，仅失去边框阴影。
    // 阴影/层次感由页面内玻璃面板的 box-shadow 与内高光补足。
    frame: false,
    transparent: isGlass,
    backgroundColor: isGlass ? '#00000000' : (themeMeta.mode === 'light' ? '#f7f8fa' : '#100c08'),
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

  // 模块窗口/主窗口：webContents 销毁时从 StateBus detach（防悬挂订阅）
  // 主窗口同时订阅 task/question/approval/module —— dock 化后 DockBar 常驻主窗口，
  // 需收到状态广播才能更新气泡计数。
  for (const ch of ['task', 'question', 'approval', 'module']) stateBus.subscribe(ch, mainWindow.webContents)
  mainWindow.webContents.on('destroyed', () => stateBus.detach(mainWindow.webContents))

  // 主窗口 dock 化：?module=dock 时渲染 DockBar（Task 6）
  // 通过 query 区分：createWindow 默认加载主界面（现状），dock 由渲染层
  // viewStore.goDock() 触发主窗口收窄后由 windowManager.open('dock') 复用。
  // 阶段 A：主窗口仍加载主界面（boot→login→cockpit→workspace），
  // dock 窗口由驾驶舱内按钮触发打开（见 Task 6 DockBar 说明）。

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

  mainWindow.on('closed', () => { mainWindow = null })
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  let icon = nativeImage.createFromPath(ICON_PATH)
  if (icon.isEmpty()) icon = nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('Ponos dev')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
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
  const ponos = path.join(ponosHome(), 'memory', 'skill_experiences')
  if (fs.existsSync(ponos)) return ponos
  return path.join(os.homedir(), '.trae-cn', 'memory', 'skill_experiences')
}
function experienceAlertStateFile() {
  return path.join(ponosHome(), 'experience-alert.json')
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

// ---------------------------------------------------------------------------
// 豆包登录会话：写/读 ~/.ponos/doubao-session.json（契约与 server/doubao.mjs 一致）
// ---------------------------------------------------------------------------
function writeDoubaoSession(cookies) {
  fs.mkdirSync(path.dirname(DOUBAO_SESSION_FILE), { recursive: true })
  fs.writeFileSync(DOUBAO_SESSION_FILE, JSON.stringify({ exportedAt: Date.now(), cookies }, null, 2), 'utf-8')
  // 权限收紧：会话 cookie 属敏感凭据，仅属主可读写（Windows 上权限位效果有限但无害，与 server/doubao.mjs 对齐）
  try { fs.chmodSync(DOUBAO_SESSION_FILE, 0o600) } catch {}
}
function readDoubaoStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(DOUBAO_SESSION_FILE, 'utf-8'))
    const loggedIn = Array.isArray(s?.cookies) && s.cookies.some(c => c.name === 'sessionid' && c.value)
    return { loggedIn, exportedAt: typeof s?.exportedAt === 'number' ? s.exportedAt : null }
  } catch { return { loggedIn: false, exportedAt: null } }
}

async function registerIpc() {
  // ---------------------------------------------------------------------------
  // 应用内诊断（Task 5）：monitor 接入主进程 + diag:* IPC。
  // ctx 注入：appPaths（kernel/bun/python 探测）/executorStatus/petAlive/
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

  ipcMain.handle('dialog:open-skill-package', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Skill Package (directory with SKILL.md)',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Frameless window controls
  // 按发起请求的窗口操作（主窗口与模块窗口通用）：fromWebContents 取 sender 所在窗口，
  // 而非写死 mainWindow——模块窗口（frame:false）同样可拖动/最小化/最大化/关闭。
  const winOf = (event) => BrowserWindow.fromWebContents(event.sender)
  ipcMain.on('window:minimize', (event) => winOf(event)?.minimize())
  ipcMain.on('window:maximize-toggle', (event) => {
    const win = winOf(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (event) => winOf(event)?.close())
  ipcMain.handle('window:is-maximized', (event) => winOf(event)?.isMaximized() ?? false)

  // 独立 dock 导航栏窗口：打开/聚焦 dock 模块窗口（?module=dock 渲染 DockBar）。
  // dock 创建时经 windowManager hooks → DockService.attach 贴边 + 边界自动隐藏。
  // 主窗口不再 dock 化（登录后由渲染层隐藏），dock 是独立 BrowserWindow。
  ipcMain.handle('window:dock-mode', async () => {
    return windowManager.open('dock')
  })

  // 主窗口隐藏（登录后进入 dock 形态：主窗口隐藏，dock 独立窗口常驻）
  ipcMain.on('window:hide', (event) => {
    winOf(event)?.hide()
  })

  // Task-complete system notification
  ipcMain.handle('app:notify-task', async (_e, payload) => {
    const p = payload || {}
    const win = mainWindow
    if (p.onlyBackground && win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
      return { shown: false }
    }
    new Notification({ title: p.title || 'Ponos dev', body: p.body || '', icon: ICON_PATH }).show()
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
  ipcMain.handle('shell:open-path', async (_e, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string') return { ok: false }
    try {
      const resolved = path.resolve(targetPath)
      shell.openPath(resolved)
      return { ok: true }
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
        backgroundColor: '#100c08',
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
  // 模块化窗口 IPC（Task 2-6）
  // ---------------------------------------------------------------------------
  ipcMain.handle('module:list', async () => listModules())

  ipcMain.handle('module:open', async (_e, req) => {
    const id = typeof req?.id === 'string' ? req.id : ''
    if (!id) return { ok: false, error: 'empty module id' }
    const params = req.params && typeof req.params === 'object' ? req.params : {}
    return windowManager.open(id, params)
  })

  ipcMain.handle('module:close', async (_e, req) => {
    const id = typeof req?.id === 'string' ? req.id : ''
    if (!id) return { ok: false, error: 'empty module id' }
    return windowManager.close(id)
  })

  ipcMain.handle('module:get-bounds', async (_e, req) => {
    const id = typeof req?.id === 'string' ? req.id : ''
    return windowManager.getBounds(id)
  })

  ipcMain.handle('module:set-bounds', async (_e, req) => {
    const id = typeof req?.id === 'string' ? req.id : ''
    const b = req?.bounds && typeof req.bounds === 'object' ? req.bounds : {}
    return windowManager.setBounds(id, b)
  })

  ipcMain.on('bus:publish', (_e, event) => {
    stateBus.publish(event)
    // 审批请求到达（渲染层 usePonosCLI 发布 approval/pending）→ ApprovalCenter 调度
    // （队列去重 + 打开独立审批窗口）。审批窗口自持 WS 直接响应，处理完自动关闭。
    approvalCenter.handleEvent(event)
  })

  ipcMain.handle('bus:get-snapshot', async (_e, req) => {
    const channel = typeof req?.channel === 'string' ? req.channel : ''
    return channel ? stateBus.getSnapshot(channel) : []
  })

  // ---------------------------------------------------------------------------
  // 豆包图片生成登录：独立登录窗口（persist:doubao 分区持久化 cookie）
  // 登录成功判定：轮询分区 cookie 含 sessionid + 导航事件即时触发 + 关窗兜底
  // 成功后 hide() 隐藏常驻（不销毁）：页面与字节 fetch 签名劫持器保持存活，
  // 生成请求靠 executeJavaScript 在页面上下文执行（Task 5）
  // ---------------------------------------------------------------------------
  const _doubaoIdleEnv = process.env.PONOS_DOUBAO_IDLE_MS
  const DOUBAO_IDLE_DESTROY_MS = _doubaoIdleEnv === '0' ? 0 : (Number(_doubaoIdleEnv) > 0 ? Number(_doubaoIdleEnv) : 10 * 60 * 1000)

  const createDoubaoWindow = async ({ showOnReady } = {}) => {
    const ses = session.fromPartition('persist:doubao')
    const win = new BrowserWindow({
      width: 1100,
      height: 780,
      title: '豆包登录',
      parent: mainWindow || undefined,
      modal: false,   // 登录窗不得阻塞主窗口：doubao.com 是重站点，加载慢/挂起时主应用必须仍可交互
      show: false,
      webPreferences: { partition: 'persist:doubao', contextIsolation: true, backgroundThrottling: false },
    })
    doubaoWin = win
    let poll = null
    let pollTimer = null
    const stopPoll = () => { if (poll) clearInterval(poll); if (pollTimer) clearTimeout(pollTimer); poll = null; pollTimer = null }
    const trySave = async () => {
      if (doubaoLoggedIn || !doubaoWin || doubaoWin.isDestroyed()) return   // 防重入
      try {
        // cookies.get 的 url 需与 cookie 域名匹配：豆包 sessionid 落在 www.doubao.com
        const cookies = await ses.cookies.get({ url: DOUBAO_URL })
        if (cookies.some(c => c.name === 'sessionid')) {
          writeDoubaoSession(cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })))
          doubaoLoggedIn = true
          stopPoll()
          doubaoLoginWaiters.splice(0).forEach(w => w(true))
          const current = doubaoWin
          setTimeout(() => {
            // 隐藏而非关闭：保持页面与签名劫持器存活
            if (current && !current.isDestroyed() && doubaoWin === current) current.hide()
          }, 800)
        }
      } catch (err) {
        console.warn('[main] doubao session check failed:', err?.message || err)
      }
    }
    win.on('close', () => { trySave() })   // 关窗时最终确认一次
    win.on('closed', () => {
      doubaoLoginWaiters.splice(0).forEach(w => w(false))
      if (doubaoWin === win) { doubaoWin = null; doubaoLoggedIn = false }
      doubaoBusy = false
      stopPoll()
    })
    win.webContents.on('did-navigate', () => { trySave() })
    win.webContents.on('did-navigate-in-page', () => { trySave() })
    poll = setInterval(trySave, 2000)
    pollTimer = setTimeout(stopPoll, 300000)   // 5 分钟轮询窗口
    win.once('ready-to-show', () => { if (showOnReady && doubaoWin === win && !win.isDestroyed()) win.show() })
    try {
      await win.loadURL(DOUBAO_URL)
    } catch (err) {
      console.warn('[main] doubao loadURL failed:', err?.message || err)
      doubaoLoginWaiters.splice(0).forEach(w => w(false))
      throw err
    }
    return win
  }

  const waitDoubaoLogin = (timeoutMs) => new Promise((res) => {
    const t = setTimeout(() => res(false), timeoutMs)
    doubaoLoginWaiters.push((ok) => { clearTimeout(t); res(ok) })
  })

  // 生成/捕获前调用：窗口不存在则静默重建（不弹窗）并等 cookie 自动登录；
  // 超时或未登录返回 false（调用方回 401，前端引导用户点登录）。
  const ensureDoubaoReady = async () => {
    if (doubaoLoggedIn && doubaoWin && !doubaoWin.isDestroyed()) return true
    try {
      if (!doubaoWin || doubaoWin.isDestroyed()) await createDoubaoWindow({ showOnReady: false })
      if (doubaoLoggedIn) return true
      return await waitDoubaoLogin(60000)
    } catch (err) {
      return false
    }
  }

  const openDoubaoLogin = async () => {
    if (doubaoWin && !doubaoWin.isDestroyed()) { doubaoWin.show(); doubaoWin.focus(); return { ok: true } }
    await createDoubaoWindow({ showOnReady: true }).catch(() => null)
    return { ok: true }   // 不等关闭：登录成功后窗口隐藏常驻，函数立即返回
  }

  // 空闲销毁：仅当「非在途 + 已登录 + 空闲超阈值」时销毁隐藏窗口，释放
  // doubao.com 页面的持续 GPU/网络/内存负载；下次生成时 ensureDoubaoReady
  // 静默重建（cookie 在 persist:doubao 分区持久化，登录态不丢）。
  const startDoubaoIdleReaper = () => {
    if (doubaoIdleTimer || DOUBAO_IDLE_DESTROY_MS <= 0) return
    doubaoIdleTimer = setInterval(() => {
      if (!doubaoWin || doubaoWin.isDestroyed()) return
      if (doubaoBusy || !doubaoLoggedIn) return
      if (doubaoLastUse <= 0 || Date.now() - doubaoLastUse < DOUBAO_IDLE_DESTROY_MS) return
      console.log('[main] doubao window idle — destroying (recreated silently on next generate)')
      const win = doubaoWin
      try { win.destroy() } catch {}
    }, 60000)
  }
  startDoubaoIdleReaper()
  ipcMain.handle('doubao:open-login', () => openDoubaoLogin())

  ipcMain.handle('doubao:get-status', () => readDoubaoStatus())

  ipcMain.handle('doubao:logout', async () => {
    doubaoLoggedIn = false   // 重置守卫：登出后重新登录需能再次触发成功判定
    try { fs.rmSync(DOUBAO_SESSION_FILE, { force: true }) } catch {}
    try { await session.fromPartition('persist:doubao').clearStorageData({ storages: ['cookies'] }) } catch {}
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // 豆包图片生成：生成请求只能在页面上下文执行（字节前端 JS 劫持 window.fetch
  // 自动注入 a_bogus/msToken 签名）。页面脚本 doubao-page-script.js 动态加载
  // （ESM：main.cjs 为 CJS，用 await import 引入导出）。
  // generate（文生图）为完整链路；instant（图生图）上传管道待 P0 校准，首版占位。
  // capture 供 P0 校准：CAPTURE_HOOK 记录页面内真实 /api/ 请求。
  // ---------------------------------------------------------------------------
  const { buildGenerateScript, buildCaptureScript, CAPTURE_HOOK } = await import('./doubao-page-script.js')

  const runPageScript = async (script, timeoutMs = 180000) => {
    const win = doubaoWin
    const timer = setTimeout(() => { try { win.webContents.executeJavaScript('null').catch(() => {}) } catch {} }, timeoutMs)
    try {
      // executeJavaScript 支持返回 Promise；超时无法取消注入，用竞速兜底
      return await Promise.race([
        win.webContents.executeJavaScript(script),
        new Promise(res => setTimeout(() => res({ code: -1, message: 'generate timeout' }), timeoutMs)),
      ])
    } finally { clearTimeout(timer) }
  }

  ipcMain.handle('doubao:generate', async (_e, payload) => {
    doubaoLastUse = Date.now()
    if (!(await ensureDoubaoReady())) return { code: 401, message: 'not logged in' }
    doubaoBusy = true
    try {
      // 确保捕获钩子已挂（挂载后页面内所有 /api/ 请求均会被记录，供 P0 校准）
      await doubaoWin.webContents.executeJavaScript(CAPTURE_HOOK).catch(() => null)
      const result = await runPageScript(buildGenerateScript({ prompt: String(payload?.prompt || ''), ratio: payload?.ratio, count: payload?.count, imageFileId: payload?.imageFileId }))
      if (result && result.code === 401) doubaoLoggedIn = false
      return result
    } catch (err) {
      return { code: -1, message: err?.message || String(err) }
    } finally {
      doubaoBusy = false
      doubaoLastUse = Date.now()
    }
  })

  ipcMain.handle('doubao:instant', async (_e, payload) => {
    doubaoLastUse = Date.now()
    if (!(await ensureDoubaoReady())) return { code: 401, message: 'not logged in' }
    doubaoBusy = true
    try {
      // 图生图：imageBase64 → 页面上下文原生 FormData/File 上传（fetch 劫持器同样注入签名）
      const b64 = String(payload?.imageBase64 || '')
      if (!b64) return { code: -1, message: 'imageBase64 required' }
      // 设计决定（范围控制）：上传链路（prepare_upload → TOS multipart → file_id）
      // 的真实字段依赖 P0 实测捕获（CAPTURE_HOOK 会记录页面内真实 upload 请求）。
      // 首版 instant 返回明确错误而非伪造结果，Task 9 校准后补全完整实现；
      // generate（文生图）已是完整链路。
      return { code: -1, message: '图生图上传链路待 P0 校准（CAPTURE_HOOK 捕获真实 upload 请求后补全）' }
    } catch (err) {
      return { code: -1, message: err?.message || String(err) }
    } finally {
      doubaoBusy = false
      doubaoLastUse = Date.now()
    }
  })

  ipcMain.handle('doubao:capture', async () => {
    doubaoLastUse = Date.now()
    if (!(await ensureDoubaoReady())) return { code: 401, message: 'not logged in' }
    doubaoBusy = true
    try {
      return await doubaoWin.webContents.executeJavaScript(buildCaptureScript()).catch(() => ({ code: -1, message: 'capture failed' }))
    } finally {
      doubaoBusy = false
      doubaoLastUse = Date.now()
    }
  })

  // ---------------------------------------------------------------------------
  // 内置浏览器自动化：窗口/清空会话/状态/暂停/继续（IPC 直连主进程，不经内核）。
  // executor 实例为模块级 browserExecutor（connectBrowserExecutor 创建）。
  // ---------------------------------------------------------------------------
  ipcMain.handle('browser:open', async (_e, sessionId) => {
    if (!browserExecutor) return { ok: false, error: 'executor 未初始化' }
    return browserExecutor.openWindow(sessionId)
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

  // 编辑器窗口内关闭按钮 / 标签全关闭后的自动收起
  ipcMain.on('editor:close-window', () => {
    if (editorWin && !editorWin.isDestroyed()) editorWin.close()
  })

  // Agent 注册表同步：写入/删除 $PONOS_HOME/agents/<id>.md，供内核识别 GUI 注册的
  // 专业/自定义 agent 作为子 agent（方案 A，零内核改动）。
  // 只处理 professional/custom 且 enabled 的 agent；builtin 内核原生已有不注入。
  // 用 .ponos-managed.json 记录 GUI 管理的 id，删除时只删这些，不触碰用户手写文件。
  ipcMain.handle('agents:sync', async (_e, agents) => {
    try {
      const home = ensurePonosHome()
      const agentsDir = path.join(home, 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      const registryFile = path.join(agentsDir, '.ponos-managed.json')
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
        const body = prompt || `你是 Ponos 的 Agent「${a.name}」：${a.description}。使用简体中文，严禁自称 Claude、Anthropic 或其他 AI 品牌。`
        const lines = ['---', `name: ${a.id}`, `description: ${toYamlString(whenToUse)}`]
        if (Array.isArray(a.tools) && a.tools.length > 0) lines.push(`tools: ${a.tools.join(', ')}`)
        if (a.model) lines.push(`model: ${a.model}`)
        if (Array.isArray(a.skills) && a.skills.length > 0) lines.push(`skills: ${a.skills.join(', ')}`)
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
        title: '导出 Ponos 经验/数据',
        defaultPath: path.join(app.getPath('downloads'), `ponos-export-${new Date().toISOString().slice(0, 10)}.zip`),
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
        title: '导入 Ponos 经验/数据包',
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
// 宠物形象（嘉嘉 / 大肥鱼换皮）由 pet.json 的 pet 字段决定，统一走
// jiajia-pet.py 引擎（tkinter 精灵图 + bridge 联动），皮肤素材在 pet/assets/。
function resolvePetScript() {
  const bundled = path.join(__dirname, '..', '..', 'pet', 'jiajia-pet.py')
  if (fs.existsSync(bundled)) return bundled
  const appPet = path.join(__dirname, '..', 'pet', 'jiajia-pet.py')
  if (fs.existsSync(appPet)) return appPet
  const dev = path.join(__dirname, '..', 'YF', 'jiajia-pixel-pet', 'jiajia-pet.py')
  if (fs.existsSync(dev)) return dev
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

  const cfgPath = path.join(ponosHome(), 'pet.json')
  try {
    if (!fs.existsSync(path.dirname(cfgPath))) fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify({
      enabled: petConfig.enabled,
      size: petConfig.size,
      randomChat: petConfig.randomChat,
      pet: petConfig.pet,
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
      (typeof cfg.randomChat !== 'undefined' && cfg.randomChat !== prev.randomChat) ||
      (typeof cfg.pet !== 'undefined' && cfg.pet !== prev.pet)
    ) {
      // 防抖：滑块拖动等连续变更只重启一次（换皮切换也走这里：重启后
      // jiajia-pet.py 重新读 pet.json 加载对应皮肤素材与台词）
      petRestartTimer = setTimeout(() => { petRestartTimer = null; killPet(); spawnPet() }, 400)
    }
  } else if (!petConfig.enabled) {
    killPet()
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// First-run setup — create ~/.ponos/ and seed skills/config
// ---------------------------------------------------------------------------
function ensurePonosHome() {
  const home = ponosHome()
  const ponosSkills = path.join(home, 'skills')

  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true })
  if (!fs.existsSync(ponosSkills)) fs.mkdirSync(ponosSkills, { recursive: true })

  // Seed sample skills on first run only (skip if any skill already present)
  const existing = fs.existsSync(ponosSkills) ? fs.readdirSync(ponosSkills) : []
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
          const to = path.join(ponosSkills, entry.name)
          if (fs.existsSync(to)) continue
          fs.cpSync(from, to, { recursive: true })
        }
        console.log('[main] seeded sample skills →', ponosSkills)
      } catch (e) {
        console.warn('[main] failed to seed sample skills:', e.message)
      }
    } else {
      console.warn('[main] no sample-skills dir found in candidates:', candidates)
    }
  }
  return home
}

// ---------------------------------------------------------------------------
// Single-instance lock — prevents zombie processes when user clicks the
// shortcut multiple times.  Only the first instance is allowed to run;
// subsequent ones focus the existing window instead.
// ---------------------------------------------------------------------------
// userData 统一指向 ponosHome()/userData（正式版 ~/.ponos、dev 版 ~/.ponos-dev）：
// 1. 与旧版 YFWorking（AppData/Roaming/yfworking-gui）彻底解耦，互不污染；
// 2. 单实例锁基于 userData 判定，两版各自独立锁，可同时运行；
// 3. 缓存/localStorage 全在各自 home 内，备份迁移只需拷贝一个目录。
// setPath 必须在 requestSingleInstanceLock 之前调用（锁基于 userData 判定），且均在 app ready 前。
app.setPath('userData', path.join(ponosHome(), 'userData'))

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else if (app.isReady()) {
      // 窗口已关闭但进程驻留（托盘模式）或主窗口尚未创建：重建窗口，
      // 保证"实例在跑时再次双击快捷方式"也有可见响应（此前静默无响应）。
      createWindow()
    }
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
      const p = path.join(ensurePonosHome(), 'logs', 'last-boot.json')
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify({ ok: !bootPhaseFailed, nodes: bootNodes, failedAt: bootPhaseFailed ? new Date().toISOString() : null }, null, 2), 'utf-8')
    } catch (_) {}
  }
  async function showBootFailureDialog() {
    try {
      const logPath = logTee.getLogPath()
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Ponos dev 启动异常',
        message: '应用界面启动失败。完整错误日志已保存到：',
        detail: logPath,
        buttons: ['打开日志目录', '复制路径', '确定'],
        defaultId: 0, cancelId: 2,
      })
      if (response === 0) shell.openPath(path.dirname(logPath))
      if (response === 1) clipboard.writeText(logPath)
    } catch (_) {}
  }
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
    // 旧版 (event, level, message, line, sourceId)——兼容两者
    win.webContents.on('console-message', (...args) => {
      const d = args[1]
      if (d && typeof d === 'object' && typeof d.message === 'string') {
        console.log(`[render:console] ${d.message} (${d.sourceId}:${d.lineNumber})`)
      } else {
        const [, , message, line, sourceId] = args
        console.log(`[render:console] ${message} (${sourceId}:${line})`)
      }
    })
    win.webContents.on('preload-error', (_e, p, err) =>
      console.error(`[render] preload-error ${p}: ${err.message}`))
    win.webContents.on('unresponsive', () => console.error('[render] unresponsive'))
  }

  app.whenReady().then(async () => {
    bootPhase('mainReady')
    bootStartAt = Date.now()   // 刷新启动基线（60s 兜底弹窗窗口）
    await registerIpc()

    // First-run: make sure ~/.ponos/ exists and has skills
    // 局部变量命名避开全局函数 ponosHome()，防止遮蔽导致 pet restore 等调用炸掉
    const home = ensurePonosHome()
    console.log('[main] Ponos home:', home)

    // Reuse an already-running bridge if present (adopt + supervise it),
    // else start our own. 复用不等于放手不管：接管后由健康轮询兜底，
    // 外部 bridge 一旦死亡立即回收重启，杜绝"端口空转、前端无限重连"。
    bootPhase('bridgeSpawn')
    const portBusy = await isPortInUse(BRIDGE_PORT)
    if (portBusy) {
      console.log('[main] bridge already running on :' + BRIDGE_PORT + ' — adopting')
      adoptBridge()
      bootPhase('bridgeReady')
    } else {
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
          `  1. 设置环境变量 PONOS_BRIDGE_PORT 为其他端口 (如 51311)\n` +
          `  2. 以管理员身份运行: netsh int ipv4 add excludedportrange protocol=tcp startport=${BRIDGE_PORT} numberofports=1\n` +
          `  3. 重启 Windows 后 WinNAT 端口排除范围通常会重新分配`,
        )
        await showBootFailureDialog()   // 兜底：原生对话框附日志路径（打开/复制）
        app.quit()
        return
      }
    }
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () => bootPhase('windowLoad'))
    createTray()
    connectPetBridgeListener()
    connectBrowserExecutor()

  // Restore last session's pet state (~/.ponos/pet.json); skip if absent
  const petCfgPath = path.join(home, 'pet.json')
  if (fs.existsSync(petCfgPath)) {
    try {
      applyPetConfig(JSON.parse(fs.readFileSync(petCfgPath, 'utf8')))
    } catch (e) {
      console.warn('[pet] failed to load saved config:', e.message)
    }
  }
})

// 窗口关闭 → StateBus detach（webContents destroyed 已处理；此处兜底非 webContents target）
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
})

app.on('will-quit', () => {
  // 启动打点汇总落盘（成功/失败都写；writeBootSummary 内部 try/catch 兜底）
  writeBootSummary()
  // 残留清扫兜底（幂等，防御性）：before-quit 已清扫，此处再清一次，
  // 覆盖 before-quit 之后新增的残留（bridge/宠物/浏览器执行器窗口）
  try { killBridge() } catch {}
  try { killPet() } catch {}
  if (browserExecutor) {
    try { browserExecutor.stopFingerprintPoll?.() } catch {}
    try { browserExecutor.destroyWindow?.() } catch {}
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
} // end single-instance lock else block
