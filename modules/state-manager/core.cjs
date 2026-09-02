'use strict'

/**
 * state-manager 核心（纯逻辑，worker 线程内运行，无 electron/无宿主依赖）。
 * 状态数据权威在本进程内存；set 时发布 bus 事件（快照环形缓冲）+ 回调通知 + 持久化。
 * storage duck：{ load() → data|null, save(data) }（测试注入内存实现，生产用 createFileStorage）。
 */
function createStateManager({ bus, storage }) {
  /** Map<key, { value, version }> */
  const state = new Map()
  const listeners = new Set()

  function load() {
    const data = storage?.load?.()
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'value' in v) state.set(k, v)
      }
    }
  }
  load()

  function save() {
    storage?.save?.(Object.fromEntries(state))
  }

  function get(key) {
    const s = state.get(key)
    return s ? { ok: true, value: s.value, version: s.version } : { ok: true, value: undefined, version: 0 }
  }

  function set(key, value, from) {
    const cur = state.get(key)
    const version = (cur?.version || 0) + 1
    state.set(key, { value, version })
    const ev = { key, value, version, from: from || 'unknown' }
    bus?.publish({ channel: 'state', action: 'changed', payload: ev, from: from || 'state-manager' })
    for (const cb of listeners) { try { cb(ev) } catch {} }
    save()
    return { ok: true, version }
  }

  function list() {
    return [...state.entries()].map(([key, s]) => ({ key, value: s.value, version: s.version }))
  }

  function onChanged(cb) { listeners.add(cb); return () => listeners.delete(cb) }

  return { get, set, list, onChanged }
}

/** worker 入口请求分发（薄壳，可单测）。返回统一 { ok, ... } 或 { ok:false, error }。 */
function handleRequest(sm, method, params = {}) {
  try {
    if (method === 'state.get') return sm.get(params.key)
    if (method === 'state.set') return sm.set(params.key, params.value, params.from)
    if (method === 'state.list') return { ok: true, result: sm.list() }
    return { ok: false, error: `METHOD_NOT_FOUND: ${method}` }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

module.exports = { createStateManager, handleRequest }
