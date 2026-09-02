/**
 * 进程编排器（Process Orchestrator）— 从 electron/window-manager.cjs 迁移更名。
 * open/close/setBounds + bounds 校验 + 窗口类型注册表 + render-process-gone 崩溃重启。
 * BrowserWindow 依赖由宿主注入 createWindow，本文件保持纯逻辑可单测。
 *
 * 与 window-manager.cjs 的差异：
 *   - createWindowManager → createProcessOrchestrator
 *   - 新增 attachCrashReboot / crashReboot：窗口 render-process-gone 时延迟 500ms
 *     重建同 key 窗口，并发布 module:state（action `restarted`）
 *   - 新增 publishState 辅助（即 bus.publish 封装）
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
 * hooks 由宿主注入（DockService/ApprovalCenter），保持本文件可单测。
 */
function createProcessOrchestrator({ getModule, bus, createWindow, onClosed, hooks = {} }) {
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

  /** 发布 module:state（bus.publish 封装），崩溃重启等场景复用。 */
  function publishState(channel, action, payload) {
    bus.publish({ channel, action, payload, from: 'main', ts: Date.now() })
  }

  /**
   * 崩溃重启：窗口 render-process-gone 时触发，延迟 500ms 后：
   *   0) 竞态守卫：仅当该 key 在 windows Map 中仍存在且指向其他窗口时才跳过重建
   *      （延迟窗口期内用户手动重建/替换同 key → 映射指向新窗口，跳过以免误删新窗口映射）；
   *      映射不存在（旧窗口已自毁、closed 清理已删除该 key）→ 正常重建。
   *   1) 窗口未自毁则先 destroy()（触发 closed 清理语义，移除映射）
   *   2) open 重建同 key 窗口
   *   3) 发布 module:state（action `restarted`）
   */
  function attachCrashReboot(orch, key, win, mod, params) {
    win.on('render-process-gone', () => {
      // 崩溃 → 延迟重建（原窗口 closed 流程会清理映射，open 重新创建同 key）
      setTimeout(() => {
        // 竞态修复：仅当映射仍存在且指向其他窗口（延迟期内被手动重建/替换）时才跳过重建；
        // 映射不存在（旧窗口已自毁、closed 清理已删除该 key）→ 正常重建。
        const cur = windows.get(key)
        if (cur && cur !== win) return
        if (!win.isDestroyed()) {
          // 窗口未自毁时先触发一次 closed 语义清理
          win.destroy()
        }
        orch.open(mod.id, params)
        orch.publishState('module', 'restarted', { moduleId: mod.id, windowId: key })
      }, 500)
    })
  }

  /** 公共崩溃重启入口：按实例 key 反查模块并挂接 render-process-gone 重建。 */
  function crashReboot(key, win) {
    const id = key.split('::')[0]
    const mod = getModule(id)
    if (!mod) return
    const hasConv = key.includes('::')
    const params = hasConv ? { conversation: key.slice(id.length + 2) } : {}
    attachCrashReboot({ open, publishState }, key, win, mod, params)
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
      // 实例守卫：迟到 closed（崩溃重启路径 destroy 的 'closed' 异步发射）时，
      // 映射已被 successor 替换 → 仅当映射仍指向本窗口才执行清理，否则清掉 successor。
      if (windows.get(key) !== win) return
      windows.delete(key)
      winToModule.delete(win)
      onClosed?.(key)
      // 类型化清理钩子：dock 停止贴边轮询 / approval 清除窗口引用
      hooks.onWindowClosed?.(type, key)
      bus.publish({ channel: 'module', action: 'closed', payload: { moduleId: id, windowId: key }, from: 'main', ts: Date.now() })
    })
    // 类型化创建钩子：dock 贴边 / approval 置顶聚焦
    hooks.onWindowCreated?.(type, win, mod, params)
    // 崩溃重启挂接：render-process-gone → 延迟重建同 key 窗口
    attachCrashReboot({ open, publishState }, key, win, mod, params)
    bus.publish({ channel: 'module', action: 'opened', payload: { moduleId: id, windowId: key }, from: 'main', ts: Date.now() })
    return { ok: true, windowId: key, reused: false }
  }

  function close(id, params) {
    // 带 params → 按实例 key 精确关闭（非 singleton 多实例：如 question 按会话窗口）；
    // 无 params → 关闭该模块全部窗口（id 本身或 id:: 前缀，兼容既有语义且不留残余实例）。
    const exact = params ? keyOf(id, params) : null
    for (const [key, win] of windows) {
      if (exact ? key === exact : (key === id || key.startsWith(`${id}::`))) {
        if (!win.isDestroyed()) win.close()
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

  /** 按实例 key 精确定位窗口（非 singleton 多实例：如 question::<会话>）。 */
  function getByParams(id, params) {
    const key = keyOf(id, params)
    const win = windows.get(key)
    return win && !win.isDestroyed() ? win : null
  }

  /** 遍历全部窗口（[key, win]），供 AnchorLayout 等按 key 定位实例。 */
  function listWindows() {
    return [...windows.entries()]
  }

  return { open, close, getBounds, setBounds, hasType, getByType, getByParams, listWindows, typeOf, crashReboot }
}

module.exports = { createProcessOrchestrator, clampBounds }
