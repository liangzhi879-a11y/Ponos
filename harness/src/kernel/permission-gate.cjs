'use strict'

/** 主进程侧出站调用拦截：模块 manifest.capabilities 前缀匹配。 */
function createPermissionGate({ registry }) {
  function check(moduleId, method) {
    if (method === 'system.discover') return { ok: true }
    const mod = registry.getModule(moduleId)
    const caps = (mod && Array.isArray(mod.capabilities)) ? mod.capabilities : []
    const allow = caps.some(cap => method === cap || method.startsWith(cap + '.'))
    return allow
      ? { ok: true }
      : { ok: false, error: 'PERMISSION_DENIED', moduleId, method }
  }
  return { check }
}

module.exports = { createPermissionGate }
