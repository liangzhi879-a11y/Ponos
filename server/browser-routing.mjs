// bridge 的 browser 路由封装：内核 bridge_request → executor；executor 响应 → 内核 stdin；
// GUI browser_control → executor；browser:event → GUI 广播。便于单测。
export function makeBrowserRouter({ writeKernel }) {
  let executor = null
  const pending = new Map() // requestId → { sessionId }
  const clients = new Set() // GUI 广播目标（WS 集合）

  return {
    registerExecutor(ws) { executor = ws },
    unregisterExecutor(ws) { if (executor === ws) executor = null },
    addGuiClient(ws) { clients.add(ws) },
    removeGuiClient(ws) { clients.delete(ws) },

    onKernelBridgeRequest(sessionId, { requestId, route, payload }) {
      if (route !== 'browser') return
      if (!executor) {
        writeKernel(sessionId, { type: 'control_request', request: { subtype: 'browser_response', requestId, ok: false, snapshot: null, error: 'executor 未连接（应用主进程未注册）' } })
        return
      }
      pending.set(requestId, sessionId)
      executor.send(JSON.stringify({ type: 'browser:exec', requestId, sessionId, payload }))
    },

    onExecutorResponse(requestId, { ok, snapshot, error, code, data }) {
      const sessionId = pending.get(requestId)
      if (!sessionId) return
      pending.delete(requestId)
      // code/data 透传（paused 人工接管状态 / js 动作结构化结果）：undefined 会被
      // JSON.stringify 丢弃，既有调用方不受影响。
      writeKernel(sessionId, { type: 'control_request', request: { subtype: 'browser_response', requestId, ok, snapshot, error, code, data } })
    },

    onGuiControl(sessionId, command) {
      // GUI 暂停/继续控制的是内核 agent 循环（browser_pause/browser_resume 门控），
      // 不是执行器：若执行器也被暂停，内核探测循环在 resume 后仍持续收到 code:'paused'
      // 直到指纹变化，会死锁。未知命令忽略。
      if (command === 'pause' || command === 'resume') {
        writeKernel(sessionId, {
          type: 'control_request',
          request: { subtype: command === 'pause' ? 'browser_pause' : 'browser_resume' },
        })
      }
    },

    broadcast(sessionId, event) {
      const msg = JSON.stringify({ type: 'browser:event', sessionId, event })
      for (const c of clients) { try { c.send(msg) } catch {} }
    },
  }
}
