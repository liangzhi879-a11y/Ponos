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
const { createStateManagerClient } = require('./kernel/state-manager-client.cjs')
const { createAgentBridge } = require('./kernel/agent-bridge.cjs') // Task 10：P1 最小内核桥
const { makeEnvelope } = require('./rpc/envelope.cjs')

function buildApp({ ipcMain: ipc, createWindow, createWorker, workArea, kernelArgs = {} }) {
  const bus = createStateBus()
  const router = createRouter()
  const mr = createMessageRouter({ router, bus })
  const gate = createPermissionGate({ registry: { getModule } })
  const orchestrator = createProcessOrchestrator({
    getModule, bus, createWindow, createWorker, onWorkerExit: () => {},
    onClosed: key => mr.detach(key.split('::')[0]),
    hooks: {
      onWindowCreated: (type, win, mod, params) => {
        const moduleId = mod.id
        mr.attach(moduleId, {
          send: (channel, data) => { if (!win.isDestroyed()) win.webContents.send(channel, data) },
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
  router.register('system.window.close', (params) => orchestrator.close(params.moduleId, params.params), { capabilities: ['system.window'] })
  router.register('system.discover', () => router.discover(), { capabilities: ['system'] })

  // —— Agent 桥（P1 最小：spawn kernel/cli.mjs）——
  const bridge = createAgentBridge({
    kernelPath: kernelArgs.kernelPath || path.join(__dirname, '..', '..', 'kernel', 'cli.mjs'),
    nodePath: kernelArgs.nodePath || 'node',  // Electron 内 process.execPath 是 electron.exe，必须显式 node
    env: kernelArgs.env,
    spawnImpl: kernelArgs.spawnImpl,
    readlineImpl: kernelArgs.readlineImpl,
  })
  bridge.onEvent(ev => {
    const env = makeEnvelope({ method: 'agent.event', params: ev, x_sender: 'agent', x_target: 'chat' })
    mr.sendTo('chat', env)
  })
  router.register('agent.send', (params) => bridge.send(params.text), { capabilities: ['agent'] })
  router.register('agent.cancel', () => bridge.cancel(), { capabilities: ['agent'] })
  bridge.start()

  // —— 状态服务（node-worker：state-manager）——
  // worker started 事件驱动连接重建（崩溃 respawn 后重新绑定 transport/client/attach）
  let smTransport = null
  let smClient = null
  function connectStateManager() {
    const worker = orchestrator.getWorker('state-manager')
    if (!worker) return
    smTransport?.close()
    smTransport = createWorkerTransport({ worker })
    smClient = createStateManagerClient({ transport: smTransport })
    smClient.onNotification(ev => {
      if (ev?.method === 'state.changed') {
        mr.broadcast({ channel: 'state', event: { type: 'changed', ...(ev.params || {}) }, sender: 'state-manager' })
      }
    })
    mr.attach('state-manager', { send: env => smTransport.send(env) }, [])
  }
  bus.subscribe('worker', { send: (ch, full) => { if (full?.action === 'started' && full.payload?.moduleId === 'state-manager') connectStateManager() } })
  router.register('state.get', (p) => smClient ? smClient.call('state.get', { key: p?.key }) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  router.register('state.set', (p) => smClient ? smClient.call('state.set', { key: p?.key, value: p?.value, from: p?.from }) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  router.register('state.list', () => smClient ? smClient.call('state.list', {}) : { ok: false, error: 'NOT_RUNNING' }, { capabilities: ['state'] })
  if (createWorker) orchestrator.startWorker('state-manager')  // 触发 worker:started → connectStateManager（单测无 createWorker 注入时不 spawn）

  const transport = createIpcTransport({ ipcMain: ipc, mr, gate, instanceOf })
  transport.handle()

  return { app, router, mr, orchestrator, bus, agent: bridge }
}

// Electron 启动装配（dev 冒烟/真实启动共用：npm run electron 直接走此入口）
if (require.main === module) {
  app.whenReady().then(() => {
    const ctx = buildApp({
      ipcMain,
      createWindow: (mod, params) => {
        const spec = mod.windowSpec || { width: 800, height: 600 }
        const win = new BrowserWindow({
          width: spec.width, height: spec.height, minWidth: spec.minWidth, minHeight: spec.minHeight,
          resizable: spec.resizable !== false, frame: false,
          webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
        })
        const entry = mod.entry?.ui || mod.entry
        win.loadFile(path.resolve(__dirname, '..', '..', entry))
        return win
      },
      createWorker: (mod) => new (require('node:worker_threads').Worker)(path.join(__dirname, '..', '..', 'modules', 'state-manager', 'main.cjs'), {
        env: { ...process.env, STATE_STORE_PATH: path.join(app.getPath('userData'), 'state-store.json') },
      }),
    })
    // P1 基线：启动即开 Launcher，列出 Chat 模块（窗口壳标题栏渲染在 P2 统一精化）
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
