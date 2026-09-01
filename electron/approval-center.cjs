/**
 * ApprovalCenter：审批中心（主进程正规化）。
 * 渲染窗口（usePonosCLI）收到内核 approval → publishBus → 主进程 StateBus →
 * 本服务监听 approval/pending → 打开独立审批窗口展示。
 * 队列去重：同一 (sessionId, toolUseId) 只保留一条，避免重复弹窗。
 *
 * 响应路径：用户批准/拒绝在审批窗口（ApprovalModule）点击 →
 * 原发布窗口（持 WS）经 bus:event 收到 respond → sendPermissionResponse 直发。
 * 本服务只负责队列与窗口调度，不碰 WS。
 */
'use strict'

function createApprovalCenter({ windowManager, bus }) {
  /** Map<`${sessionId}:${toolUseId}`, pending> 审批队列（主进程副本） */
  const queue = new Map()

  function handleEvent(event) {
    if (!event || event.channel !== 'approval') return
    const { action, payload } = event
    if (action === 'pending') {
      const { conversationId, toolUseId } = payload || {}
      if (!conversationId || !toolUseId) return
      const key = `${conversationId}:${toolUseId}`
      if (queue.has(key)) return   // 去重
      queue.set(key, { conversationId, toolUseId, at: Date.now() })
      // 打开/聚焦审批窗口
      windowManager.open('approval')
    } else if (action === 'resolved') {
      const { conversationId, toolUseId } = payload || {}
      if (conversationId && toolUseId) queue.delete(`${conversationId}:${toolUseId}`)
    }
  }

  function pendingCount() { return queue.size }

  function clear() { queue.clear() }

  return { handleEvent, pendingCount, clear }
}

module.exports = { createApprovalCenter }
