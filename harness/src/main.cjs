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
const { createAgentBridge } = require('./kernel/agent-bridge.cjs') // Task 10：P1 最小内核桥
const { makeEnvelope } = require('./rpc/envelope.cjs')

function buildApp({ ipcMain: ipc, createWindow, workArea, kernelArgs = {} }) {
  const bus = createStateBus()
  const router = createRouter()
  const mr = createMessageRouter({ router, bus })
  const gate = createPermissionGate({ registry: { getModule } })
  const orchestrator = createProcessOrchestrator({
    getModule, bus, createWindow,
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
