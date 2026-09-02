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
const { createAgentBridge } = require('./kernel/agent-bridge.cjs') // Task 10 实装，先占位
const { makeEnvelope } = require('./rpc/envelope.cjs')

function buildApp({ ipcMain: ipc, createWindow, workArea, kernelArgs }) {
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
  // agent 方法由 createAgentBridge 注册（Task 10）；P1 中间态先占位
  const agent = createAgentBridge ? { send: () => ({ ok: false, error: 'NOT_READY' }) } : null

  const transport = createIpcTransport({ ipcMain: ipc, mr, gate, instanceOf })
  transport.handle()

  return { app, router, mr, orchestrator, bus, agent }
}

// Electron 启动装配（仅 dev 冒烟用；正式装配在 Task 11 收口）
if (require.main === module) {
  app.whenReady().then(() => {
    const ctx = buildApp({
      ipcMain,
      createWindow: (mod, params) => {
        const win = new BrowserWindow({
          width: mod.windowSpec.width, height: mod.windowSpec.height,
          frame: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
        })
        win.loadFile(path.join(mod.baseDir || __dirname, '..', '..', mod.entry.ui))
        return win
      },
    })
    ctx.orchestrator.open('launcher')
  })
}

module.exports = { buildApp }
