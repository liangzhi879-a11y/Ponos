// bridge 的 app 路由封装（Task 4.x「应用即工具」）：内核 bridge_request(route=app)
// → 主进程执行器；executor 响应 → 回写内核 stdin（control_request/app_response）。
//
// 与 server/browser-routing.mjs **完全同构**（同一 executor WS 连接、同一挂起/配对
// 语义），分成两个模块的理由：browser 路由的行为已被既有测试钉死，应用路由不该
// 去动它（路由只差一个字符串，但 pending 台账与回执形状不同）。
export function makeAppRouter({ writeKernel }) {
  let executor = null
  const pending = new Map() // requestId → sessionId

  const fail = (sessionId, requestId, error) => {
    writeKernel(sessionId, {
      type: 'control_request',
      request: { subtype: 'app_response', requestId, ok: false, data: null, error, kind: 'unknown', durationMs: 0 },
    })
  }

  return {
    // 与 browserRouter 共用同一个 executor WS（bridge 在 executor:hello 处一并注册）
    registerExecutor(ws) { executor = ws },
    unregisterExecutor(ws) { if (executor === ws) executor = null },

    onKernelBridgeRequest(sessionId, { requestId, route, payload }) {
      if (route !== 'app') return
      if (!executor) {
        fail(sessionId, requestId, 'executor 未连接（应用主进程未注册）')
        return
      }
      pending.set(requestId, sessionId)
      try {
        executor.send(JSON.stringify({ type: 'app:exec', requestId, sessionId, payload }))
      } catch (e) {
        // 发送失败不得留下"永不结清"的挂起（内核侧会一直等到超时）
        pending.delete(requestId)
        fail(sessionId, requestId, `执行器投递失败：${e?.message || String(e)}`)
      }
    },

    onExecutorResponse(requestId, { ok, data, error, kind, durationMs } = {}) {
      const sessionId = pending.get(requestId)
      if (!sessionId) return
      pending.delete(requestId)
      // 回执形状 = electron/app-ipc.cjs 的 app:run 回执（内核 app-tools 直接渲染）
      writeKernel(sessionId, {
        type: 'control_request',
        request: {
          subtype: 'app_response',
          requestId,
          ok: ok === true,
          data: data ?? null,
          error: error || null,
          kind: kind || 'unknown',
          durationMs: Number(durationMs) || 0,
        },
      })
    },
  }
}
