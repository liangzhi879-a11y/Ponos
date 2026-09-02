'use strict'

const { makeEnvelope, validateEnvelope, decrementTtl } = require('../rpc/envelope.cjs')

/** 模块连接管理：attach/detach + RPC 出入站。target 鸭子类型 { send(channel, data) }。 */
function createMessageRouter({ router, bus }) {
  /** Map<moduleId, { target, capabilities }> */
  const connections = new Map()

  function attach(moduleId, target, capabilities = []) {
    if (connections.has(moduleId)) return { ok: false, error: 'ALREADY_ATTACHED' }
    connections.set(moduleId, { target, capabilities })
    return { ok: true }
  }

  function detach(moduleId) {
    return connections.delete(moduleId) ? { ok: true } : { ok: false, error: 'NOT_ATTACHED' }
  }

  async function call({ method, params, sender, id, x_trace_id }) {
    const conn = connections.get(sender)
    if (!conn) return { ok: false, error: 'NOT_ATTACHED' }
    const env = makeEnvelope({ method, params, id, x_sender: sender, x_trace_id })
    return router.invoke(env)
  }

  async function notify({ method, params, sender }) {
    const env = makeEnvelope({ method, params, x_sender: sender })
    await router.notify(env)
  }

  function broadcast({ channel, event, sender }) {
    const full = { channel, action: event?.type || 'event', payload: event, from: sender, ts: Date.now() }
    bus.publish(full)
  }

  function sendTo(moduleId, env) {
    const conn = connections.get(moduleId)
    if (!conn) return false
    if (validateEnvelope(env).ok && decrementTtl(env) === 0) return false
    try {
      conn.target.send(`rpc:${env.method}`, env)
      return true
    } catch {
      return false
    }
  }

  return { attach, detach, call, notify, broadcast, sendTo }
}

module.exports = { createMessageRouter }
