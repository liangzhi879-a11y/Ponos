'use strict'

/**
 * 宿主侧 worker-transport 适配器：把 node:worker_threads Worker 包装为与
 * ipc-transport 同构的 { send, onMessage, close }。消息体为 JSON-RPC envelope。
 * worker duck 类型：{ postMessage(msg), on(ev, cb), terminate() }。
 */
function createWorkerTransport({ worker }) {
  const listeners = new Set()
  worker.on('message', msg => {
    for (const cb of listeners) { try { cb(msg) } catch {} }
  })
  return {
    send(env) { worker.postMessage(env) },
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    close() { worker.terminate() },
  }
}

module.exports = { createWorkerTransport }
