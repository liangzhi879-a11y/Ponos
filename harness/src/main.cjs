'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { createStateBus } = require('../../electron/state-bus.cjs')
const { listModules, getModule } = require('./kernel/module-registry.cjs')
const { createRouter } = require('./rpc/router.cjs')
const { createMessageRouter } = require('./kernel/message-router.cjs')
const { createProcessOrchestrator } = require('./kernel/process-orchestrator.cjs')
const { createPermissionGate } = require('./kernel/permission-gate.cjs')
const { createIpcTransport } = require('./rpc/transports/ipc-transport.cjs')
const { createWorkerTransport } = require('./rpc/transports/worker-transport.cjs')
const { createRpcClient } = require('./kernel/rpc-client.cjs')
const { createStdioTransport } = require('./rpc/transports/stdio-transport.cjs')
const { makeEnvelope } = require('./rpc/envelope.cjs')

function buildApp({ ipcMain: ipc, createWindow, createWorker, createCli, workArea }) {
  const bus = createStateBus()
  const router = createRouter()
  const mr = createMessageRouter({ router, bus })
  const gate = createPermissionGate({ registry: { getModule } })
  const orchestrator = createProcessOrchestrator({
    getModule, bus, createWindow, createWorker, createCli, onWorkerExit: () => {},
    onClosed: key => mr.detach(key.split('::')[0]),
    hooks: {
      onWindowCreated: (type, win, mod, params) => {
        const moduleId = mod.id
        // P2 壳：模块 UI 加载在 shell 子 frame（iframe），wc.send 只达主 frame（shell 标题栏），
        // 模块事件下行须 sendToFrame 定向模块子 frame（冒烟实测 wc.send 不到 iframe）。
        // 子 frame 未加载完成前回退 wc.send（此时模块 UI 尚未订阅，事件必在其后到达）。
        let moduleFrame = null
        const wc = win.webContents
        wc.on('did-frame-finish-load', (_e, isMainFrame, frameProcessId, frameRoutingId) => {
          if (!isMainFrame) moduleFrame = [frameProcessId, frameRoutingId]
        })
        mr.attach(moduleId, {
          send: (channel, data) => {
            if (win.isDestroyed()) return
            if (moduleFrame) wc.sendToFrame(moduleFrame, channel, data)
            else wc.send(channel, data)
          },
        }, mod.capabilities)
      },
    },
  })
  const instanceOf = wc => {
    const found = orchestrator.listWindows().find(([, win]) => win.webContents === wc)
    return found ? found[0].split('::')[0] : null
  }

  // —— 主进程方法集 ——
  router.register('system.modules.list', () => listModules(), { capabilities: ['system.modules'] })
  router.register('system.window.open', (params) => orchestrator.open(params.moduleId, params.params || {}), { capabilities: ['system.window'] })
  router.register('system.window.minimize', (p) => orchestrator.minimize(p?.key), { capabilities: ['system.window'] })
  router.register('system.window.maximize', (p) => orchestrator.maximize(p?.key), { capabilities: ['system.window'] })
  router.register('system.window.context', (p) => {
    const r = orchestrator.context(p?.key)
    if (!r.ok) return r
    const entryUrl = r.result.entry
      ? require('node:url').pathToFileURL(path.resolve(__dirname, '..', '..', r.result.entry)).href
      : ''
    // 扁平负载：router.invoke 外层已包 { ok, result }，壳/测试按 r.result.name 直接取（与 state.get 等约定一致）
    return { ...r.result, entryUrl }
  }, { capabilities: ['system.window'] })
  // system.window.close 扩展：{ key } 精确定位（非 singleton 多实例按实例 key 关闭）
  router.register('system.window.close', (p) => p?.key ? orchestrator.closeByKey(p.key) : orchestrator.close(p?.moduleId, p?.params), { capabilities: ['system.window'] })
  router.register('system.discover', () => router.discover(), { capabilities: ['system'] })

  // —— agent-core（cli-bridge 模块）：会话方法集 + 事件转发 chat ——
  let agentCoreClient = null
  function connectAgentCore() {
    mr.detach('agent-core')  // 重连前清残留（respawn 崩溃路径同 state-manager）
    const child = orchestrator.getCli('agent-core')
    if (!child) return
    const transport = createStdioTransport({ child })
    const client = createRpcClient({ transport })
    client.onNotification(ev => {
      if (ev?.method === 'session.event') {
        const env = makeEnvelope({ method: 'session.event', params: ev.params, x_sender: 'agent-core', x_target: 'chat' })
        mr.sendTo('chat', env)
      }
    })
    mr.attach('agent-core', { send: (ch, env) => transport.send(env) }, [])
    agentCoreClient = client
  }
  const sessionCall = method => (params) => agentCoreClient
    ? agentCoreClient.call(method, params || {})
    : { ok: false, error: 'NOT_RUNNING' }
  router.register('session.send', sessionCall('session.send'), { capabilities: ['session'] })
  router.register('session.cancel', sessionCall('session.cancel'), { capabilities: ['session'] })
  router.register('session.status', sessionCall('session.status'), { capabilities: ['session'] })

  // —— 状态服务（node-worker：state-manager）——
  // worker started 事件驱动连接重建（崩溃 respawn 后重新绑定 transport/client/attach）
  let smTransport = null
  let smClient = null
  function connectStateManager() {
    mr.detach('state-manager')  // 重连前清残留连接（respawn 崩溃路径不 detach → attach 会 ALREADY_ATTACHED）
    const worker = orchestrator.getWorker('state-manager')
    if (!worker) return
    smTransport?.close()
    smTransport = createWorkerTransport({ worker })
    smClient = createRpcClient({ transport: smTransport })
    smClient.onNotification(ev => {
      if (ev?.method === 'state.changed') {
        mr.broadcast({ channel: 'state', event: { type: 'changed', ...(ev.params || {}) }, sender: 'state-manager' })
      }
    })
    mr.attach('state-manager', { send: (ch, env) => smTransport.send(env) }, [])
  }
  bus.subscribe('worker', { send: (ch, full) => {
    if (full?.action === 'started' && full.payload?.moduleId === 'state-manager') connectStateManager()
    if (full?.action === 'started' && full.payload?.moduleId === 'agent-core') connectAgentCore()
  } })
  router.register('state.get', (p) => smClient ? smClient.call('state.get', { key: p?.key }) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  router.register('state.set', (p) => smClient ? smClient.call('state.set', { key: p?.key, value: p?.value, from: p?.from }) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  router.register('state.list', () => smClient ? smClient.call('state.list', {}) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  if (createWorker) orchestrator.startWorker('state-manager')  // 触发 worker:started → connectStateManager（单测无 createWorker 注入时不 spawn）
  if (createCli) orchestrator.startCli('agent-core')  // 触发 worker:started → connectAgentCore

  const transport = createIpcTransport({ ipcMain: ipc, mr, gate, instanceOf })
  transport.handle()

  return { app, router, mr, orchestrator, bus }
}

// Electron 启动装配（dev 冒烟/真实启动共用：npm run electron 直接走此入口）
// 守卫含 process.defaultApp：electron.exe <entry> 经 default_app.asar 用 ESM import() 加载入口时
// require.main 指向 default_app 的 main.js（filename='electron'），require.main === module 恒 false；
// process.defaultApp 为 true 时同样需要执行装配（真实启动），单测 require 本文件时两者皆不成立 → 不触发。
if (require.main === module || process.defaultApp) {
  app.whenReady().then(() => {
    // ctx 声明提前：createWindow 闭包经 ctx.orchestrator.keyOf 计算实例 key
    // （open 在 buildApp 返回后调用，ctx 已赋值，安全）
    let ctx = null
    ctx = buildApp({
      ipcMain,
      createWindow: (mod, params) => {
        const spec = mod.windowSpec || { width: 800, height: 600 }
        const win = new BrowserWindow({
          width: spec.width, height: spec.height, minWidth: spec.minWidth, minHeight: spec.minHeight,
          resizable: spec.resizable !== false, frame: false,
          webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
            nodeIntegrationInSubFrames: true,  // P2 壳：preload 注入 iframe 内模块 UI
          },
        })
        const key = ctx.orchestrator.keyOf(mod.id, params)
        win.loadFile(path.join(__dirname, 'shell.html'), { query: { module: mod.id, key } })
        return win
      },
      createWorker: (mod) => new (require('node:worker_threads').Worker)(path.join(__dirname, '..', '..', 'modules', 'state-manager', 'main.cjs'), {
        env: { ...process.env, STATE_STORE_PATH: path.join(app.getPath('userData'), 'state-store.json') },
      }),
      createCli: (mod) => {
        const file = path.join(__dirname, '..', '..', mod.entry.main)  // entry.main 为 repo-root 相对
        return require('node:child_process').spawn('node', [file], {
          env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
        })
      },
    })
    // P2 壳：统一标题栏（shell.html）承载全部 ui-renderer 窗口
    ctx.orchestrator.open('launcher')
    // Windows 约定：全部窗口关闭即退出（否则进程挂后台）
    app.on('window-all-closed', () => app.quit())
    // 重激活（macOS 惯例）：无窗口时重新打开 Launcher
    app.on('activate', () => {
      if (ctx.orchestrator.listWindows().length === 0) ctx.orchestrator.open('launcher')
    })
  })
}

module.exports = { buildApp }
