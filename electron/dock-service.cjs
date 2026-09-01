/**
 * DockService：导航栏窗口的贴边/自动隐藏/悬浮行为。
 * Windows 无原生"边缘自动隐藏"API，用光标轮询实现（平台现实，非 Electron 缺陷）。
 * 收敛为独立服务：main.cjs 只保留 attach 一行调用。
 *
 * 行为：
 *   - attach(win)：贴屏幕右缘 + alwaysOnTop + 启动光标轮询
 *   - moved 事件 → 用户拖动 → 解除贴边变自由悬浮窗（停止轮询、关 alwaysOnTop、可缩放）
 *   - closed → 清理状态
 *   - startWatch/stopWatch：光标轮询（鼠标靠近右缘滑出、离开 dock 区域滑回隐藏）
 */
'use strict'

const DOCK_W = 64          // dock 展开宽度
const DOCK_PEEK = 4        // 隐藏时露出的边缘像素
const DOCK_EDGE = 10       // 右缘探测阈值
const DOCK_POLL_MS = 150   // 光标轮询间隔

function createDockService({ screen }) {
  let dockWindow = null      // 当前 dock 窗口
  let dockDocked = false     // 是否贴边自动隐藏模式
  let watchTimer = null

  function stopWatch() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
  }

  function startWatch() {
    if (watchTimer || !dockWindow || dockWindow.isDestroyed()) return
    watchTimer = setInterval(() => {
      if (!dockDocked || !dockWindow || dockWindow.isDestroyed()) { stopWatch(); return }
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
        if (dockWindow === win) {
          dockDocked = false
          stopWatch()
          win.setAlwaysOnTop(false)
          win.setResizable(true)
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
  }

  function detach() {
    stopWatch()
    dockWindow = null
    dockDocked = false
  }

  function isDocked() { return dockDocked }

  return { attach, detach, startWatch, stopWatch, isDocked }
}

module.exports = { createDockService, DOCK_W, DOCK_PEEK, DOCK_EDGE, DOCK_POLL_MS }
