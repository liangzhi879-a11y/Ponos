'use strict'

/** 宿主侧 state-manager rpc client：请求/响应经递增 id 配对，无 id 消息分发通知。 */
function createStateManagerClient({ transport }) {
  let seq = 0
  const pending = new Map()
  const notifications = new Set()
  transport.onMessage(msg => {
    if (msg && msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      }
    } else {
      for (const cb of notifications) { try { cb(msg) } catch {} }
    }
  })
  return {
    call(method, params) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        transport.send({ id, method, params })
      })
    },
    onNotification(cb) { notifications.add(cb); return () => notifications.delete(cb) },
  }
}

module.exports = { createStateManagerClient }
