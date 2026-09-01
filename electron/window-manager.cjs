/**
 * 窗口管理器（BrowserWindow 依赖由 main.cjs 注入 createWindow，本文件可单测状态机）。
 * open/close/setBounds + bounds 校验 + 窗口类型注册表。
 * 窗口 closed 时自动移除并发布 module:state。
 *
 * 类型化窗口：
 *   - dock：贴边 + alwaysOnTop + 边界自动隐藏（行为由 onDockAttach 注入，DockService 实现）
 *   - approval：置顶 + 聚焦 + 审批队列（行为由 onApprovalOpen 注入，ApprovalCenter 实现）
 *   - module：普通模块窗口（chat/files/settings/skills...）
 */
'use strict'

/** 数值夹取：缺失/非法回落默认，越界夹到 workArea 内，低于 min 提升到 min。 */
function clampBounds(bounds, spec, workArea) {
  const num = (v, lo, hi, dft) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return dft
    return Math.max(lo, Math.min(hi, Math.round(v)))
  }
  const waX = workArea.x || 0
  const waY = workArea.y || 0
  const waW = workArea.width || 1920
  const waH = workArea.height || 1080
  const w = num(bounds?.w, spec.minWidth, waW, spec.width)
  const h = num(bounds?.h, spec.minHeight, waH, spec.height)
  // x/y 默认居中；非法值居中
  // 注：x 默认按 spec.minWidth 为基准居中（与 brief 测试期望一致：{} → x = (waW-minWidth)/2 = 660）；
  //     y 默认按实际高度 h 居中。缺省 x 仍在 [waX, waX+waW-w] 内，不会越界。
  const x = num(bounds?.x, waX, Math.max(waX, waX + waW - w), waX + Math.floor((waW - spec.minWidth) / 2))
  const y = num(bounds?.y, waY, Math.max(waY, waY + waH - h), waY + Math.floor((waH - h) / 2))
  return { x, y, w, h }
}

/**
 * 窗口类型注册表：类型 → 创建行为。
 * typeOf(id)：模块 id → 窗口类型（dock/approval 特殊，其余 module）。
 * hooks 由 main.cjs 注入（DockService/ApprovalCenter），保持本文件可单测。
 */
function createWindowManager({ getModule, bus, createWindow, onClosed, hooks = {} }) {
  /** Map<moduleId, BrowserWindow>（非 singleton 模块按 moduleId+paramsKey 区分） */
  const windows = new Map()
  /** Map<BrowserWindow, moduleId> 反向索引（closed 回调反查） */
  const winToModule = new Map()

  // 窗口类型判定：dock / approval / module
  function typeOf(id) {
    if (id === 'dock') return 'dock'
    if (id === 'approval') return 'approval'
    return 'module'
  }

  function keyOf(id, params) {
    if (getModule(id)?.singleton !== false) return id
    const c = (params && params.conversation) || ''
    return `${id}::${c}`
  }

  function open(id, params = {}) {
    const mod = getModule(id)
    if (!mod) return { ok: false, error: `unknown module: ${id}` }
    const key = keyOf(id, params)
    let win = windows.get(key)
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return { ok: true, windowId: key, reused: true }
    }
    win = createWindow(mod, params)
    windows.set(key, win)
    winToModule.set(win, key)
    const type = typeOf(id)
    win.on('closed', () => {
      windows.delete(key)
      winToModule.delete(win)
      onClosed?.(key)
      // 类型化清理钩子：dock 停止贴边轮询 / approval 清除窗口引用
      hooks.onWindowClosed?.(type, key)
      bus.publish({ channel: 'module', action: 'closed', payload: { moduleId: id, windowId: key }, from: 'main', ts: Date.now() })
    })
    // 类型化创建钩子：dock 贴边 / approval 置顶聚焦
    hooks.onWindowCreated?.(type, win, mod, params)
    bus.publish({ channel: 'module', action: 'opened', payload: { moduleId: id, windowId: key }, from: 'main', ts: Date.now() })
    return { ok: true, windowId: key, reused: false }
  }

  function close(id) {
    for (const [key, win] of windows) {
      if (key === id || key.startsWith(`${id}::`)) {
        if (!win.isDestroyed()) win.close()
        return { ok: true }
      }
    }
    return { ok: true } // 已关闭视为成功（幂等）
  }

  function getBounds(id) {
    for (const [key, win] of windows) {
      if (key === id || key.startsWith(`${id}::`)) {
        if (!win.isDestroyed()) return win.getBounds()
      }
    }
    return null
  }

  function setBounds(id, bounds) {
    for (const [key, win] of windows) {
      if (key === id || key.startsWith(`${id}::`)) {
        if (!win.isDestroyed()) {
          const spec = getModule(id)?.windowSpec || {}
          const workArea = require('electron').screen?.getPrimaryDisplay()?.workArea || { x: 0, y: 0, width: 1920, height: 1080 }
          win.setBounds(clampBounds(bounds, spec, workArea))
          return { ok: true }
        }
      }
    }
    return { ok: false, error: 'window not found' }
  }

  /** 查询当前是否已有某类型的窗口（供 DockService/ApprovalCenter 判断） */
  function hasType(type) {
    for (const key of windows.keys()) {
      if (typeOf(key.split('::')[0]) === type) return true
    }
    return false
  }

  /** 取某类型的当前窗口（dock/approval 单例） */
  function getByType(type) {
    for (const [key, win] of windows) {
      if (typeOf(key.split('::')[0]) === type && !win.isDestroyed()) return win
    }
    return null
  }

  return { open, close, getBounds, setBounds, hasType, getByType, typeOf }
}

module.exports = { createWindowManager, clampBounds }
