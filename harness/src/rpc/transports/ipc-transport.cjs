'use strict'

/** 主进程侧 IPC 适配：ipcMain.handle('ponos:call') / on('ponos:notify') → message-router。 */
function createIpcTransport({ ipcMain, mr, gate, instanceOf }) {
  // 窗口 shell（shell.html 主 frame）是可信系统 UI：加载 iframe 需调 system.window.context 取 entryUrl，
  // 标题栏控制需调 minimize/maximize/close。这些能力归属窗口系统而非模块（如 settings 仅 capabilities ['state']），
  // 故主 frame 的 system.window.* 豁免 capabilities gate；iframe 内模块 UI（senderFrame.parent 非空）不受影响。
  function isShellFrame(event) {
    const senderFrame = event.senderFrame
    return !!senderFrame && senderFrame.parent === null
  }
  function handle() {
    ipcMain.handle('ponos:call', async (event, req) => {
      const moduleId = instanceOf(event.sender)
      if (!moduleId) return { ok: false, error: 'UNKNOWN_SENDER' }
      const perm = isShellFrame(event) && req.method.startsWith('system.window.')
        ? { ok: true }
        : gate.check(moduleId, req.method)
      if (!perm.ok) return { ok: false, error: perm.error, method: req.method }
      return mr.call({ method: req.method, params: req.params, sender: moduleId, id: req.id })
    })
    ipcMain.on('ponos:notify', (event, req) => {
      const moduleId = instanceOf(event.sender)
      if (!moduleId) return
      const perm = isShellFrame(event) && req.method.startsWith('system.window.')
        ? { ok: true }
        : gate.check(moduleId, req.method)
      if (perm.ok) mr.notify({ method: req.method, params: req.params, sender: moduleId })
    })
  }
  return { handle }
}

module.exports = { createIpcTransport }
