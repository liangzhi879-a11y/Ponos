/**
 * ApprovalCenter：审批 + 提问中心（主进程正规化）。
 * 渲染窗口（usePonosCLI）收到内核 approval / question → publishBus → 主进程 StateBus →
 * 本服务监听：
 *   - approval/pending → 打开独立审批窗口展示（ApprovalModule）
 *   - question/pending → 打开独立提问窗口展示（QuestionModule）
 * 队列去重：同一 (sessionId, toolUseId) 只保留一条，避免重复弹窗。
 *
 * 响应路径：用户在独立窗口点击 → 原发布窗口（持 WS）经 sendPermissionResponse /
 * sendAnswer 直发。本服务只负责队列与窗口调度，不碰 WS。
 */
'use strict'

function createApprovalCenter({ windowManager, bus }) {
  /** Map<`${sessionId}:${toolUseId}`, pending> 审批队列（主进程副本） */
  const queue = new Map()
  /** Map<sessionId, true> 已打开的提问窗口（避免重复开） */
  const questionWindows = new Map()

  function handleEvent(event) {
    if (!event) return
    const { channel, action, payload } = event
    if (channel === 'approval') {
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
    } else if (channel === 'question') {
      if (action === 'pending') {
        const { conversationId } = payload || {}
        if (!conversationId) return
        if (questionWindows.has(conversationId)) return   // 该会话提问窗口已开
        questionWindows.set(conversationId, true)
        // 打开独立提问窗口（带会话 id）
        windowManager.open('question', { conversation: conversationId })
      } else if (action === 'resolved') {
        const { conversationId } = payload || {}
        if (conversationId) questionWindows.delete(conversationId)
      }
    }
  }

  function pendingCount() { return queue.size }

  function clear() {
    queue.clear()
    questionWindows.clear()
  }

  return { handleEvent, pendingCount, clear }
}

module.exports = { createApprovalCenter }
