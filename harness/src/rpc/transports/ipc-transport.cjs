'use strict'

/** 主进程侧 IPC 适配：ipcMain.handle('ponos:call') / on('ponos:notify') → message-router。 */
function createIpcTransport({ ipcMain, mr, gate, instanceOf }) {
  function handle() {
    ipcMain.handle('ponos:call', async (event, req) => {
      const moduleId = instanceOf(event.sender)
      if (!moduleId) return { ok: false, error: 'UNKNOWN_SENDER' }
      const perm = gate.check(moduleId, req.method)
      if (!perm.ok) return { ok: false, error: perm.error, method: req.method }
      return mr.call({ method: req.method, params: req.params, sender: moduleId, id: req.id })
    })
    ipcMain.on('ponos:notify', (event, req) => {
      const moduleId = instanceOf(event.sender)
      if (!moduleId) return
      const perm = gate.check(moduleId, req.method)
      if (perm.ok) mr.notify({ method: req.method, params: req.params, sender: moduleId })
    })
  }
  return { handle }
}

module.exports = { createIpcTransport }
