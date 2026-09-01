/**
 * DockService：导航栏窗口的贴边/自动隐藏/悬浮行为。
 * Windows 无原生"边缘自动隐藏"API，用光标轮询实现（平台现实，非 Electron 缺陷）。
 * 收敛为独立服务：main.cjs 只保留 attach 一行调用。
 *
 * 行为：
 *   - attach(win)：贴屏幕右缘 + alwaysOnTop + 启动光标轮询
 *   - moved 事件 → 用户拖动 → 解除贴边变自由悬浮窗
 *     （保持不可缩放 → 禁用 Windows Aero Snap，拖到边缘不会半屏/全屏捕捉）
 *   - redock(win)：悬浮状态重新贴回右缘（挂靠）
 *   - setAutoHide(enabled)：锁定联动——false 时停止自动隐藏（常驻展开）
 *   - closed → 清理状态
 */
'use strict'

const DOCK_W = 64          // dock 展开宽度
const DOCK_PEEK = 4        // 隐藏时露出的边缘像素
const DOCK_EDGE = 10       // 右缘探测阈值
const DOCK_POLL_MS = 150   // 光标轮询间隔

function createDockService({ screen, bus } = {}) {
  let dockWindow = null      // 当前 dock 窗口
  let dockDocked = false     // 是否贴边自动隐藏模式
  let autoHide = true        // 是否自动隐藏（锁定联动：false=常驻展开）
  let watchTimer = null

  function publish(action, payload = {}) {
    if (bus && dockWindow && !dockWindow.isDestroyed()) {
      bus.publish({ channel: 'module', action, payload, from: 'dock-service', ts: Date.now() })
    }
  }

  function stopWatch() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
  }

  function startWatch() {
    if (watchTimer || !dockWindow || dockWindow.isDestroyed()) return
    watchTimer = setInterval(() => {
      if (!dockDocked || !dockWindow || dockWindow.isDestroyed()) { stopWatch(); return }
      // 锁定（autoHide=false）→ 常驻展开，不执行隐藏逻辑
      if (!autoHide) return
      const wa = screen.getPrimaryDisplay().workArea
      const cp = screen.getCursorScreenPoint()
      const b = dockWindow.getBounds()
      const expandedX = wa.x + wa.width - DOCK_W
      const hiddenX = wa.x + wa.width - DOCK_PEEK
      const nearEdge = cp.x >= wa.x + wa.width - DOCK_EDGE && cp.x <= wa.x + wa.width &&
                       cp.y >= wa.y && cp.y <= wa.y + wa.height
      const inDock = cp.x >= b.x && cp.x <= b.x + b.width && cp.y >= b.y && cp.y <= b.y + b.height
      if (nearEdge || inDock) {
        if (b.x !== expandedX) dockWindow.setBounds({ ...b, x: expandedX })
      } else {
        if (b.x !== hiddenX) dockWindow.setBounds({ ...b, x: hiddenX })
      }
    }, DOCK_POLL_MS)
  }

  function attach(win) {
    dockWindow = win
    dockDocked = true
    if (!win.__dockServiceBound) {
      win.__dockServiceBound = true
      win.on('moved', () => {
        if (dockWindow === win && dockDocked) {
          // 用户拖动 → 解除贴边变自由悬浮窗。
          // 保持不可缩放（resizable 保持 false）：禁用 Aero Snap，
          // 防止拖到屏幕边缘触发半屏/全屏捕捉。
          dockDocked = false
          stopWatch()
          win.setAlwaysOnTop(false)
          publish('dock-floating')
        }
      })
      win.on('closed', () => {
        if (dockWindow === win) { dockWindow = null; dockDocked = false; stopWatch() }
      })
    }
    const wa = screen.getPrimaryDisplay().workArea
    win.setBounds({ x: wa.x + wa.width - DOCK_W, y: wa.y, width: DOCK_W, height: wa.height })
    win.setAlwaysOnTop(true)
    startWatch()
    publish('dock-docked')
  }

  /** 悬浮 → 重新贴回右缘（挂靠） */
  function redock() {
    if (!dockWindow || dockWindow.isDestroyed()) return { ok: false, error: 'no dock window' }
    const wa = screen.getPrimaryDisplay().workArea
    dockWindow.setBounds({ x: wa.x + wa.width - DOCK_W, y: wa.y, width: DOCK_W, height: wa.height })
    dockWindow.setAlwaysOnTop(true)
    dockDocked = true
    startWatch()
    publish('dock-docked')
    return { ok: true }
  }

  /** 锁定联动：false=停止自动隐藏（常驻展开） */
  function setAutoHide(enabled) {
    autoHide = enabled !== false
    // 从锁定恢复自动隐藏时，若当前贴边则立即按光标状态纠正位置
    if (autoHide && dockDocked && dockWindow && !dockWindow.isDestroyed()) {
      const wa = screen.getPrimaryDisplay().workArea
      const b = dockWindow.getBounds()
      const expandedX = wa.x + wa.width - DOCK_W
      const hiddenX = wa.x + wa.width - DOCK_PEEK
      const cp = screen.getCursorScreenPoint()
      const nearEdge = cp.x >= wa.x + wa.width - DOCK_EDGE && cp.x <= wa.x + wa.width
      if (!nearEdge && b.x !== hiddenX) dockWindow.setBounds({ ...b, x: hiddenX })
    }
  }

  function detach() {
    stopWatch()
    dockWindow = null
    dockDocked = false
  }

  function isDocked() { return dockDocked }
  function isAutoHide() { return autoHide }

  return { attach, redock, setAutoHide, detach, startWatch, stopWatch, isDocked, isAutoHide }
}

module.exports = { createDockService, DOCK_W, DOCK_PEEK, DOCK_EDGE, DOCK_POLL_MS }
