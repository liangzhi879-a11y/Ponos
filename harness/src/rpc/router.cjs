'use strict'

/** 方法注册表 + 调用分发。权限规则：调用方 capabilities 中任一等于 method 前缀即放行。 */
function createRouter() {
  /** Map<method, { handler, capabilities }> */
  const table = new Map()

  function register(method, handler, { capabilities = [] } = {}) {
    table.set(method, { handler, capabilities })
  }

  function unregister(method) { table.delete(method) }

  function canCall(entry, env) {
    const m = entry.capabilities || []
    if (m.length === 0) return true // 未声明权限的方法默认放行（P1 最小策略）
    return m.some(cap => env.method === cap || env.method.startsWith(cap + '.'))
  }

  async function invoke(env) {
    const entry = table.get(env.method)
    if (!entry) return { ok: false, error: 'METHOD_NOT_FOUND' }
    if (!canCall(entry, env)) return { ok: false, error: 'PERMISSION_DENIED' }
    try {
      const result = await entry.handler(env.params, { sender: env.x_sender, target: env.x_target })
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) }
    }
  }

  async function notify(env) {
    await invoke(env) // 错误静默
  }

  function discover() {
    return [...table.entries()].map(([method, e]) => ({ method, capabilities: [...e.capabilities] }))
  }

  function listMethods() { return [...table.keys()] }

  return { register, unregister, invoke, notify, discover, listMethods }
}

module.exports = { createRouter }
