'use strict'

const { parentPort } = require('node:worker_threads')
const { createStateBus } = require('../../electron/state-bus.cjs')
const { createStateManager, handleRequest } = require('./core.cjs')
const { createFileStorage } = require('./storage.cjs')

/**
 * worker 入口装配：parentPort ↔ 状态机。请求 { id, method, params } → 响应 { id, result|error }；
 * set 触发 changed → 通知 { method:'state.changed', params }（无 id）。
 * 抽 runWorker 便于单测（port duck { postMessage, on }）。
 */
function runWorker({ port, storage, bus = createStateBus(), createBus = () => bus }) {
  const sm = createStateManager({ bus: createBus(), storage })
  sm.onChanged(ev => port.postMessage({ method: 'state.changed', params: ev }))
  port.on('message', req => {
    if (!req || req.id === undefined) return
    const res = handleRequest(sm, req.method, req.params)
    if (res.ok) port.postMessage({ id: req.id, result: res })
    else port.postMessage({ id: req.id, error: res.error })
  })
  return sm
}

if (require.main === module) {
  const storagePath = process.env.STATE_STORE_PATH
  runWorker({ port: parentPort, storage: createFileStorage(storagePath) })
}

module.exports = { runWorker }
