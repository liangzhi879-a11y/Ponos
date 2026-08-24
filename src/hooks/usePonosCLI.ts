/**
 * Communicates with Ponos CLI via WebSocket bridge (port configured via PONOS_BRIDGE_PORT env or Vite define).
 *
 *   Browser ──WebSocket──► server/bridge.mjs ──stdio──► ponos CLI
 */

import { useState, useCallback, useEffect } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { generateId, sanitizeText } from '@/lib/utils'
import { parseAskUserPayload } from '@/lib/askUser'
import { getWsUrl } from '@/lib/config'
import { getAgentById } from '@/lib/agents'
import { useAgentStore } from '@/stores/agentStore'
import { useHealthStore, type HealthInfo } from '@/stores/healthStore'
import { useBrowserStore } from '@/stores/browserStore'
import { useUIStore } from '@/stores/uiStore'
import type { ContentBlock, Message, QuestionAnswer, BrowserEvent } from '@/types'

const WS_URL = getWsUrl()

// Trim leading/trailing whitespace, collapse runs of whitespace/newlines into a
// single space, and truncate to `max` chars with a trailing ellipsis when needed.
function shortenText(text: string, max: number): string {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned
}

// Module-level WebSocket state (persists across hook instances)
let ws: WebSocket | null = null
let wsReady = false
let pendingQueue: Array<() => void> = []
// Per-conversation streaming state — supports parallel sessions
// lastKind/textSeq/thinkSeq：turbo 内核按文本 chunk 逐条发 assistant 事件且不带
// message.id，前端需自维护块序号——同类型连续 chunk 并入同一块（append），中间
// 隔了 tool_use/其它类型则新开一块。否则所有 chunk 共用同一 key，块内容被整块
// 覆盖，最终只显示最后一个 chunk（流式适配，2026-08-22）。
type SessionStreamState = { assistantId: string; blockIds: Record<string, string>; lastKind?: string; textSeq?: number; thinkSeq?: number }
const sessionState = new Map<string, SessionStreamState>()
// 同会话串行化：正在流式输出的会话集合。
// 排队插话（方案A）不再前端 hold：生成中回车立即以 next 优先级发送，由内核在
// 工具调用边界注入当前轮或等轮结束作为新轮；assistant 事件到达时以
// streamingSessions 是否含该会话区分“当前轮继续输出”与“新轮开始”。
const streamingSessions = new Set<string>()
let lastSessionId: string | null = null

// 紧急插话缓冲：interject() 发送 now 优先级消息后置位，
// 被打断轮次的 result 到达时消费（建插话轮流式占位），10s 无响应兜底清除。
const pendingInterject = new Map<string, true>()

// 排队插话悬浮态追踪：uuid（内核消息 id）→ {conversationId, messageId}。
// 发送后消息气泡以 pending=true 悬浮，内核 command_lifecycle 'started'（消息被
// 吸收进当前轮或作为新轮开始）到达时落位；30s 无事件兜底落位，避免永久悬浮。
const PENDING_INTERJECT_TIMEOUT_MS = 30_000
const interjectPending = new Map<string, { conversationId: string; messageId: string; timer: ReturnType<typeof setTimeout> }>()

function registerPendingInterject(uuid: string, conversationId: string, messageId: string) {
  settlePendingInterject(uuid) // 防重：同一 uuid 不重复注册
  const timer = setTimeout(() => settlePendingInterject(uuid), PENDING_INTERJECT_TIMEOUT_MS)
  interjectPending.set(uuid, { conversationId, messageId, timer })
}

function settlePendingInterject(uuid: string, opts?: { reposition?: boolean }) {
  const entry = interjectPending.get(uuid)
  if (!entry) return
  clearTimeout(entry.timer)
  interjectPending.delete(uuid)
  useChatStore.getState().setMessagePending(entry.conversationId, entry.messageId, false)
  // 仅在内核确认已接收（command_lifecycle started）时校正位置：
  // - 当前轮仍在流式（插话被吸收进当前轮）→ 保持插入在流式 assistant 之前的位置；
  // - 已无流式（内核按新轮处理，本消息是其回复轮的前置）→ 移回序列末端，
  //   让随后到来的新轮 assistant 消息排在其后。超时兜底/会话异常路径不校正。
  if (opts?.reposition && !streamingSessions.has(entry.conversationId)) {
    useChatStore.getState()._moveMessageToEnd(entry.conversationId, entry.messageId)
  }
}

// 会话中止/出错/关闭时，该会话所有未落位的插话气泡一并落位（消息保留在会话里，
// 仅解除悬浮态）——内核进程已销毁，不可能再收到 started 事件。
function settlePendingInterjectsBySession(sid: string) {
  for (const [uuid, entry] of interjectPending) {
    if (entry.conversationId !== sid) continue
    clearTimeout(entry.timer)
    interjectPending.delete(uuid)
    useChatStore.getState().setMessagePending(entry.conversationId, entry.messageId, false)
  }
}

// 断线自愈：指数退避自动重连（2s → 4s → 8s → 10s 封顶），
// 修复"长时间后台运行断连后永久失联"问题。任意一次掉线（睡眠唤醒/空闲回收等）
// 都会自动重建 WebSocket，无需用户手动操作。
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 10000

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS)
  reconnectAttempts += 1
  console.log(`[WS] disconnected — reconnect in ${delay}ms (attempt ${reconnectAttempts})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    getOrCreateWS()
  }, delay)
}

export function getOrCreateWS(): WebSocket | null {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws
  }
  try {
    ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      console.log('[WS] connected')
      wsReady = true
      reconnectAttempts = 0
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      const q = pendingQueue
      pendingQueue = []
      q.forEach(fn => fn())
    }
    ws.onmessage = (raw) => {
      try {
        const msg = JSON.parse(raw.data.toString())
        console.log('[WS] recv:', msg.type, msg.sessionId?.slice(0,8) || '', msg.data?.type || '')
        handleMessage(msg)
      } catch (e) { console.error('[WS] parse error:', e) }
    }
    ws.onclose = (ev) => {
      console.log('[WS] closed:', ev.code, ev.reason || '')
      wsReady = false
      ws = null
      scheduleReconnect()
    }
    ws.onerror = () => { wsReady = false }
    return ws
  } catch {
    // new WebSocket() 抛异常（如非法 URL）——同样安排重连兜底
    scheduleReconnect()
    return null
  }
}

// 插话语义包装：插话=补充信息/调整要求（非新任务），引导模型继续当前任务。
function wrapInterject(raw: string): string {
  return `【用户插话——补充信息/调整要求】\n${raw}\n——\n说明：这是用户在当前任务执行中补充的信息或调整的要求，不是新任务。请结合已有的任务进展继续执行。`
}

export function sendAnswer(sessionId: string, answers: QuestionAnswer[], notes: string) {
  const socket = getOrCreateWS()
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({
    type: 'answer',
    sessionId,
    data: { answers, notes },
  }))
  // 用户已回答提问 → 清除待回复标记，并把会话恢复为流式状态
  // （CLI 处理回答期间会继续输出，状态应从“待回复”切回“执行中”，
  // 直到本轮回应的 result 事件到达后再结束）。
  const store = useChatStore.getState()
  store.clearPendingQuestion(sessionId)
  const st = sessionState.get(sessionId)
  if (st?.assistantId) {
    // 回答后新文本新开块：lastKind 置空使 bumpStreamSeq 序号递增（textSeq/thinkSeq
    // 保留最大值保证新键不与卡片前文本块冲突），避免回答输出续接到卡片前文本块。
    st.lastKind = undefined
    store._resumeStreaming(sessionId, st.assistantId)
  }
}

/**
 * 用户跳过/关闭提问卡片：只通知桥接端广播”提问已处理”，
 * 不向 CLI 注入回答（CLI 继续等待，用户可用新消息解除阻塞）。
 */
export function dismissQuestion(sessionId: string) {
  const socket = getOrCreateWS()
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({
    type: 'question-dismiss',
    sessionId,
  }))
}

/**
 * 把权限弹窗的审批结果回传 bridge：bridge 查 _pendingApprovals 后向内核
 * stdin 注入 control_response，解除 can_use_tool 挂起（批准执行/拒绝报错）。
 */
export function sendPermissionResponse(sessionId: string, toolUseId: string, approved: boolean) {
  const socket = getOrCreateWS()
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({
    type: 'approval-response',
    sessionId,
    toolUseId,
    approved,
  }))
}

/**
 * 构建 WS send payload；会话不存在返回 null。
 * 发送方：send（空闲/排队插话）、dispatchSend（新建轮）、interject（紧急 now）。
 * uuid：排队插话消息的唯一标识，内核处理该消息时经 command_lifecycle 事件回传
 * （'started'=已接收处理），供前端解除气泡悬浮态。
 */
// 构建 WS send payload；会话不存在返回 null
function buildSendPayload(conversationId: string, prompt: string, priority?: 'now' | 'next' | 'later', uuid?: string, loop?: { count: number; until?: string; fresh?: boolean }): Record<string, unknown> | null {
  const store = useChatStore.getState()
  const conversation = store.conversations.find(c => c.id === conversationId)
  if (!conversation) return null
  lastSessionId = conversationId
  const agent = getAgentById(useAgentStore.getState().agents, conversation.agentId)
  const sState = useSettingsStore.getState().settings
  const activeProv = sState.providers.find(p => p.id === sState.activeProvider)
  const compactCount = compactCountOf(conversationId)
  return {
    type: 'send',
    prompt,
    requestId: generateId(),
    sessionId: conversationId,
    cwd: conversation.cwd,
    // Resume this conversation's own CLI session (if any) — never another conversation's
    resumeId: conversation.sessionId || undefined,
    // 绑定专业 Agent 时注入其专属系统提示词（覆盖默认身份提示词）
    ...(agent ? { systemPrompt: agent.systemPrompt } : {}),
    // 携带当前主模型：bridge 以 --model 传入 CLI，resume 时可覆盖会话内
    // 存储的旧模型，实现同一聊天中两段会话之间的无缝模型切换
    ...(activeProv?.primaryModel ? { model: activeProv.primaryModel } : {}),
    // 携带该会话的历史压缩次数：bridge 经 spawn env PONOS_HEALTH_COMPACT_COUNT 注入
    // 内核，恢复进程内 compactCount（进程空闲回收后压缩史不丢，血条不回绿）。
    // 双数据源取 max：healthBySession 为最近健康事件快照，summaryCompactCountBySession
    // 为压缩事件计数（ponos_summary 可能先于 ponos_health 到达，二者都可能较新）。
    ...(compactCount > 0 ? { compactCount } : {}),
    ...(priority ? { priority } : {}),
    ...(uuid ? { uuid } : {}),
    // /loop 连续迭代：透传 loop 配置到内核（count/until/fresh）
    ...(loop ? { loop } : {}),
  }
}

/** 该会话的持久压缩次数（GUI persist 快照，双源取 max） */
function compactCountOf(conversationId: string): number {
  const h = useHealthStore.getState()
  return Math.max(h.healthBySession[conversationId]?.compactCount ?? 0, h.summaryCompactCountBySession[conversationId] ?? 0)
}

// 建立流式状态（assistant 占位 + sessionState）；dispatchSend、插话中断后
// 与新轮自动建块（排队插话方案A）复用。返回 assistantId，会话不存在返回 null。
function setupStreamingState(conversationId: string): string | null {
  const store = useChatStore.getState()
  if (!store.conversations.find(c => c.id === conversationId)) return null
  streamingSessions.add(conversationId)
  const assistantId = store._addStreamingMessage(conversationId)
  sessionState.set(conversationId, { assistantId, blockIds: {} })
  return assistantId
}

// 发送 WS send payload；未连接时入 pendingQueue（连接后执行），连接断开时输出错误块并清理
function sendPayloadWS(conversationId: string, payload: Record<string, unknown>) {
  const store = useChatStore.getState()
  const doSend = () => {
    const socket = getOrCreateWS()
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const st = sessionState.get(conversationId)
      if (st?.assistantId) {
        store._appendStreamingBlock(st.assistantId, {
          id: generateId(), type: 'text',
          content: '\n⚠️ **Bridge not connected.**\nRun: `node server/bridge.mjs`\n',
        })
        store.stopStreaming(conversationId)
        sessionState.delete(conversationId)
        streamingSessions.delete(conversationId)
      }
      return
    }
    socket.send(JSON.stringify(payload))
  }
  if (!wsReady) pendingQueue.push(doSend)
  else doSend()
}

// 原 dispatchSend 语义：立即发送（新建流式占位）
function dispatchSend(conversationId: string, userContent: string, priority?: 'now' | 'next' | 'later', loop?: { count: number; until?: string; fresh?: boolean }) {
  const payload = buildSendPayload(conversationId, userContent, priority, undefined, loop)
  if (!payload) return
  setupStreamingState(conversationId)
  sendPayloadWS(conversationId, payload)
}

export function usePonosCLI() {
  const [connected, setConnected] = useState(false)

  // Connect on mount
  useEffect(() => {
    getOrCreateWS()
    const interval = setInterval(() => {
      setConnected(wsReady)
      // 孤儿子代理任务清理（节流）：taskkill/崩溃的内核发不出终态通知，靠心跳超时兜底
      if (Date.now() - lastTaskSweepAt > STALE_TASK_SWEEP_MS) {
        lastTaskSweepAt = Date.now()
        sweepStaleSubAgentTasks()
      }
    }, 500)
    // 窗口从托盘/后台恢复可见时，若仍未连上则立即发起重连（不等退避定时器）
    const onVisible = () => {
      if (document.visibilityState === 'visible') getOrCreateWS()
    }
    // 页面隐藏时立即兜底 flush 待批流式事件，避免 rAF 暂停期间状态滞后
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushStreamEvents()
        flushTaskProgress()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const send = useCallback((conversationId: string, userContent: string, loop?: { count: number; until?: string; fresh?: boolean }) => {
    const store = useChatStore.getState()
    const conversation = store.conversations.find(c => c.id === conversationId)
    if (!conversation) return

    // 内容入库前清洗控制字符，防止脏字节经 persist 落盘损坏整份数据
    const clean = sanitizeText(userContent)

    // 同会话已有未完成的流式响应：生成中回车=排队插话。
    // 方案A（工具边界注入）：立即以 next 优先级发送、不打断当前轮——内核在下一个
    // 工具调用边界把消息作为附件注入当前轮（模型很快看到补充信息，回复融进当前输出块）；
    // 若已进入纯文本生成阶段（不再有工具调用）则退化为等当前轮结束、由内核作为新轮处理，
    // 该新轮的 assistant 事件由 handleMessage 的“新轮自动建块”兜底归属，不会丢。
    // 消息以 pending=true 悬浮入库，内核 command_lifecycle started 到达后落位（见 interjectPending）。
    if (streamingSessions.has(conversationId)) {
      const messageId = generateId()
      // 排队插话插入到会话序列中对应位置（当前流式 assistant 消息之前），
      // 而不是追加到最末端——插话是当前任务进行中的补充信息，应位列于该轮
      // 回复之前；若内核最终按新轮处理（started 时已无流式），
      // settlePendingInterject 会再把它移回末端。
      const anchorId = sessionState.get(conversationId)?.assistantId
      const interjectMsg: Message = {
        id: messageId,
        role: 'user',
        content: [{ id: generateId(), type: 'text', content: clean }],
        timestamp: Date.now(),
        pending: true,
      }
      if (anchorId) store._insertMessageBefore(conversationId, anchorId, interjectMsg)
      else store._addMessage(conversationId, interjectMsg)
      const uuid = generateId()
      registerPendingInterject(uuid, conversationId, messageId)
      const payload = buildSendPayload(conversationId, wrapInterject(userContent), 'next', uuid)
      if (payload) sendPayloadWS(conversationId, payload)
      return
    }

    // 空闲发送：普通用户消息，立即入列并开启流式
    store._addMessage(conversationId, {
      id: generateId(),
      role: 'user',
      content: [{ id: generateId(), type: 'text', content: clean }],
      timestamp: Date.now(),
    })
    dispatchSend(conversationId, userContent, undefined, loop)
  }, [])

  const stop = useCallback((conversationId?: string) => {
    const target = conversationId || lastSessionId || 'default'
    const payload = { type: 'cancel', sessionId: target }
    console.log('[WS] stop:', target.slice(0, 8), 'wsReady:', wsReady, 'wsState:', ws?.readyState)
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload))
    }
    useChatStore.getState().stopStreaming(conversationId)
  }, [])

  const interject = useCallback((conversationId: string, userContent: string) => {
    const store = useChatStore.getState()
    store._addMessage(conversationId, {
      id: generateId(),
      role: 'user',
      content: [{ id: generateId(), type: 'text', content: sanitizeText(userContent) }],
      timestamp: Date.now(),
    })
    const payload = buildSendPayload(conversationId, wrapInterject(userContent), 'now')
    if (!payload) return
    if (pendingInterject.has(conversationId)) return // 重复插话：上次 now 消息的 aborted result 未到前忽略（spec §6）
    if (!wsReady) return // bridge 未连接：消息已入库可见，用户可稍后重发
    pendingInterject.set(conversationId, true)
    getOrCreateWS()?.send(JSON.stringify(payload))
    // 兜底：内核 10s 无响应（被打断轮 result 未到达）则清除标记，避免悬挂
    setTimeout(() => pendingInterject.delete(conversationId), 10_000)
  }, [])

  // 浏览器自动化暂停/继续：经 bridge browser_control → 内核 control_request
  // （browser_pause/browser_resume，Task 4 已在内核 print.ts 实现）。
  const browserControl = useCallback((conversationId: string, command: 'pause' | 'resume') => {
    const payload = JSON.stringify({ type: 'browser_control', sessionId: conversationId, command })
    const doSend = () => getOrCreateWS()?.send(payload)
    if (!wsReady) pendingQueue.push(doSend)
    else doSend()
  }, [])

  // 思考深度切换：经 bridge set_effort → 内核 control_request(reasoning_effort)，下一轮生效
  const setEffort = useCallback((conversationId: string, value: string) => {
    const payload = JSON.stringify({ type: 'set_effort', sessionId: conversationId, value })
    const doSend = () => getOrCreateWS()?.send(payload)
    if (!wsReady) pendingQueue.push(doSend)
    else doSend()
  }, [])

  return { send, stop, interject, browserControl, setEffort, connected }
}

// ---------------------------------------------------------------------------
// Message handler — processes stream-json events from CLI
// ---------------------------------------------------------------------------

// Agent 工具调用的 tool_use_id → subagent_type（agentType）映射。
// 内核 task_started/task_progress 只带 tool_use_id，需回查 leader 消息里的 Agent 工具调用块取 agent 名。
const toolUseAgentMap = new Map<string, string>()

// 流式事件批处理：同一帧内的多次 assistant 事件合并为一次状态更新。
// 每事件语义不变（完整应用），仅降低重渲染频率。
type StreamEvent = { sid: string; st: SessionStreamState; aid: string; event: Record<string, unknown> }
const pendingStreamEvents: StreamEvent[] = []
let streamFlushScheduled = false

// 流式文本/思考块序号：turbo 内核按文本 chunk 逐条发 assistant 事件且不带
// message.id（旧 claude-code 内核每事件是完整消息、自带 id），前端必须自维护
// 块序号——同类型连续 chunk 并入同一块（append），中间隔了 tool_use/其它类型
// 则新开一块。修复前所有 chunk 共用 'text-0' 键，_updateStreamingBlock 整块覆盖，
// 最终只显示最后一个 chunk。
function bumpStreamSeq(st: SessionStreamState, bt: 'text' | 'thinking'): number {
  const field = bt === 'text' ? 'textSeq' : 'thinkSeq'
  if (st.lastKind !== bt) {
    st[field] = (st[field] || 0) + 1
    st.lastKind = bt
  }
  return st[field]!
}

function flushStreamEvents() {
  streamFlushScheduled = false
  if (pendingStreamEvents.length === 0) return
  const batch = pendingStreamEvents.splice(0)
  const store = useChatStore.getState()
  for (const { st, aid, event } of batch) {
    const content = (event.message as any)?.content as Array<Record<string, unknown>> | undefined
    if (!content) continue
    for (const block of content) {
      const bt = block.type as string
      if (bt === 'thinking' && block.thinking) {
        const seq = bumpStreamSeq(st!, 'thinking')
        upsertBlock(store, st!, aid, 'thinking-' + seq, { id: '', type: 'thinking', content: sanitizeText(block.thinking as string) }, true)
      } else if (bt === 'text' && block.text) {
        const seq = bumpStreamSeq(st!, 'text')
        upsertBlock(store, st!, aid, 'text-' + seq, { id: '', type: 'text', content: sanitizeText(block.text as string) }, true)
      } else if (bt === 'tool_use') {
        const toolInput = (block as any).input || {}
        if (block.name === 'Agent' && block.id) {
          toolUseAgentMap.set(block.id as string, String(toolInput.subagent_type || ''))
        }
        st!.lastKind = 'tool_use'
        upsertBlock(store, st!, aid, 'tool-' + (block.id as string || 'tool'), {
          id: '', type: 'tool_use', content: sanitizeText(JSON.stringify(block.input || {}, null, 2)),
          metadata: { toolName: block.name, status: 'completed', toolUseId: block.id as string | undefined },
        })
      }
    }
  }
}

function scheduleStreamFlush() {
  if (streamFlushScheduled) return
  streamFlushScheduled = true
  requestAnimationFrame(flushStreamEvents)
}

// 任务进度合并：task_progress 每工具调用一次，直接逐条更新 store 会造成高频
// 全量重渲染（叠加 glass 透明合成路径 → GPU 负载峰值，与子 agent 启动/运行期
// 卡死相关）。同一任务每帧只保留最后一条，按 requestAnimationFrame 合并应用；
// 最终态由 task_notification 即时送达，不经过合并队列。
const pendingTaskProgress = new Map<string, { sid: string; event: Record<string, unknown> }>()
let taskProgressFlushScheduled = false

function flushTaskProgress() {
  taskProgressFlushScheduled = false
  if (pendingTaskProgress.size === 0) return
  const batch = [...pendingTaskProgress.values()]
  pendingTaskProgress.clear()
  const store = useChatStore.getState()
  for (const { sid, event } of batch) {
    const t = event as Record<string, any>
    const usage = t.usage || {}
    store.upsertSubAgentTask(sid, {
      taskId: t.task_id,
      status: 'running',
      lastSeenAt: Date.now(),
      toolUseCount: usage.tool_uses ?? 0,
      tokenCount: usage.total_tokens ?? 0,
      durationMs: usage.duration_ms ?? 0,
      lastToolName: t.last_tool_name || '',
      activities: t.description
        ? [{ toolName: t.last_tool_name || '', description: String(t.description), ts: Date.now() }]
        : [],
    })
  }
}

function scheduleTaskProgressFlush() {
  if (taskProgressFlushScheduled) return
  taskProgressFlushScheduled = true
  requestAnimationFrame(flushTaskProgress)
}

/** 会话关闭/出错/取消时清掉该会话的待刷新进度，防止 closed 后任务卡复活。 */
function dropPendingTaskProgress(sid: string) {
  for (const key of pendingTaskProgress.keys()) {
    if (key.startsWith(sid + ':')) pendingTaskProgress.delete(key)
  }
}

// ---------------------------------------------------------------------------
// 孤儿子代理任务超时清理
// ---------------------------------------------------------------------------
// 内核被外部终止（taskkill/崩溃）时永远发不出终态 task_notification，任务会
// 卡在 running 直到 GUI 重启。这里以事件心跳（lastSeenAt）判活：超过窗口仍无
// 任何事件的任务标记为 stopped（staleSwept=true，收到新进度可复活，防误判）。
// 阈值从原 10min 缩短到 2min：内核正常运行时 task_progress 高频更新 lastSeenAt
// （合并队列每帧 flush），真正"卡住"的孤儿进程 2min 即可见 UI 标签消失。
const STALE_TASK_MS = 2 * 60 * 1000
const STALE_TASK_SWEEP_MS = 30 * 1000
let lastTaskSweepAt = 0

function sweepStaleSubAgentTasks() {
  const now = Date.now()
  const store = useChatStore.getState()
  for (const [sid, list] of Object.entries(store.subAgentTasks || {})) {
    for (const t of list) {
      if (t.status !== 'running' || !t.lastSeenAt) continue
      if (now - t.lastSeenAt <= STALE_TASK_MS) continue
      store.upsertSubAgentTask(sid, {
        taskId: t.taskId,
        status: 'stopped',
        staleSwept: true,
        summary: '子代理进程已退出，状态超时自动清理',
      })
    }
  }
}

function handleMessage(msg: Record<string, unknown>) {
  const store = useChatStore.getState()
  const sid = (msg.sessionId as string) || 'default'
  // Exact match only — never fallback to another session to prevent cross-project contamination
  let st = sessionState.get(sid)

  // 内核失速告警（bridge 失速看门狗，KERNEL_STALL_WARN_MS 静默阈值）：写入
  // uiStore 驱动 ChatWindow 提示条。任何后续 event（内核 stdout 有输出）自动清除。
  if (msg.type === 'kernel-stall') {
    const d = msg.data as { silentMs?: number } | undefined
    useUIStore.getState().setKernelStall(sid, Number(d?.silentMs) || 0)
    return
  }
  // 内核仍在产出（stdout 有行）→ 失速解除（clearKernelStall 幂等：无状态不触发更新）
  if (msg.type === 'event' || msg.type === 'error' || msg.type === 'cancelled' || msg.type === 'closed') {
    useUIStore.getState().clearKernelStall(sid)
  }

  if (msg.type === 'event') {
    const event = msg.data as Record<string, unknown>
    const type = event.type as string
    const aid = st?.assistantId

    if (type === 'ponos_health') {
      // 按会话隔离存储：sid 即发送该事件的内核进程所属会话（conversationId）
      useHealthStore.getState().update(sid, event as unknown as HealthInfo)
      return
    }
    if (type === 'ponos_summary') {
      const s = event as Record<string, any>
      useHealthStore.getState().setSummary(sid, String(s.text ?? ''), Number(s.compactCount ?? 0))
      return
    }
    if (type === 'loop') {
      // /loop 连续迭代状态：start（置位 active）/ iter（推进轮次）/ end（结束，带 reason）
      const s = event as Record<string, any>
      const st = useChatStore.getState()
      const state = s.state as string
      if (state === 'start') {
        st.setLoopState(sid, { active: true, index: 0, total: Number(s.total) || 1, until: s.until ? String(s.until) : undefined, fresh: !!s.fresh })
      } else if (state === 'iter') {
        st.setLoopState(sid, { index: Number(s.index) || 0, total: Number(s.total) || 0, judgeReason: s.reason ? String(s.reason) : undefined })
      } else if (state === 'end') {
        st.setLoopState(sid, { active: false, index: Number(s.index) || 0, total: Number(s.total) || 0, reason: s.reason ? String(s.reason) : undefined })
      }
      return
    }
    if (type === 'command_lifecycle') {
      // 排队插话接收确认：内核 started = 消息已被吸收进当前轮（工具边界注入）或
      // 作为新轮开始 → 解除气泡悬浮态（落位到会话序列）。
      const d = event.data as { uuid?: string; state?: string } | undefined
      if (d?.uuid && d.state === 'started') settlePendingInterject(String(d.uuid), { reposition: true })
      return
    }
    if (type === 'system' && event.subtype === 'init') {
      // 内核新进程启动。仅"真正的新会话"（从未运行过、无旧 sessionId）才清空健康快照：
      // 恢复旧会话（resume）时内核经 PONOS_HEALTH_COMPACT_COUNT seed 恢复了压缩史，
      // 水位也由首轮 transcript 全量 usage 重新测得——GUI 应保留持久化快照直接显示，
      // 直到内核首轮 ponos_health 刷新，避免"续断点后血条瞬间回满"。
      const conv = store.conversations.find(c => c.id === sid)
      if (!conv?.sessionId) {
        useHealthStore.getState().reset(sid)
      }
      store._updateSessionMeta({
        // sid is the bridge's session id, which the frontend sends as conversationId
        conversationId: sid,
        sessionId: event.session_id as string,
        model: event.model as string,
        tools: event.tools as string[],
      })
      return
    }

    if (type === 'system') {
      const subtype = event.subtype as string
      if (subtype === 'task_started') {
        const t = event as Record<string, any>
        const agentId = t.tool_use_id ? toolUseAgentMap.get(t.tool_use_id as string) : undefined
        useChatStore.getState().upsertSubAgentTask(sid, {
          taskId: t.task_id,
          toolUseId: t.tool_use_id ? String(t.tool_use_id) : undefined,
          name: agentId || String(t.task_id).slice(0, 8),
          status: 'running',
          prompt: typeof t.prompt === 'string' ? t.prompt : undefined,
          lastSeenAt: Date.now(),
        })
        return
      }
      if (subtype === 'task_progress') {
        // 高频进度事件走合并队列（每任务每帧应用最后一条），见 scheduleTaskProgressFlush
        const t = event as Record<string, any>
        pendingTaskProgress.set(`${sid}:${t.task_id}`, { sid, event })
        scheduleTaskProgressFlush()
        return
      }
      if (subtype === 'task_notification') {
        const t = event as Record<string, any>
        useChatStore.getState().upsertSubAgentTask(sid, {
          taskId: t.task_id,
          status: t.status === 'completed' ? 'completed' : t.status === 'failed' ? 'failed' : 'stopped',
          summary: t.summary || '',
          outputFile: t.output_file || '',
          toolUseCount: t.usage?.tool_uses ?? 0,
          tokenCount: t.usage?.total_tokens ?? 0,
          durationMs: t.usage?.duration_ms ?? 0,
        })
        return
      }
    }

    if (type === 'assistant' && !streamingSessions.has(sid)) {
      // 新轮自动建块（方案A）：排队插话立即发送 next 后，若上一轮已 result 结束、
      // 内核把消息作为新轮处理，assistant 事件到达时本会话已不在流式集合——
      // 此时 st 仍指向上一轮的块（result 不删 sessionState），必须重建流式占位，
      // 否则新轮输出会错挂到上一轮块上或被静默丢弃。
      setupStreamingState(sid)
      st = sessionState.get(sid)
    }
    // 新轮建块后 aid 必须取新状态的 assistantId：函数头捕获的 aid 仍指向上一轮
    // 的流式消息（result 不删 sessionState），否则新轮首条 assistant 事件会错挂
    // 到上一轮消息上（新轮消息保持空占位）。result 路径用函数头 aid 是对的
    // （result 恒属当前轮），仅 assistant 事件需要这里校正。
    if (type === 'assistant' && st?.assistantId) {
      pendingStreamEvents.push({ sid, st, aid: st.assistantId, event })
      scheduleStreamFlush()
      return
    }

    if (type === 'result' && aid) {
      const usage = (event.usage || {}) as Record<string, number>
      const interjected = pendingInterject.has(sid)
      // 若该会话仍有待回答的提问卡片，说明 CLI 只是结束当前轮次等待用户回答
      // —— 不能结束流式状态，否则会出现“后端在跑但前端显示空闲/有输出无状态”。
      // 回答注入后由 sendAnswer 恢复流式，直到下一条 result 再结束。
      if (!store.pendingQuestions[sid]) {
        store._finishStreaming(aid, { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 })
        // 本轮响应结束 → 释放串行锁
        streamingSessions.delete(sid)
      }
      // Keep sessionState alive — subagent may still be running and producing output
      store._updateSessionMeta({ totalCost: event.total_cost_usd as number, duration: event.duration_ms as number })

      // 紧急插话：被打断轮次的 result 到达 → 先建插话轮流式占位（now 优先级排在排队消息前，
      // 保证内核输出按 插话轮→排队消息 顺序归属到各自 assistant 消息）。
      if (interjected) {
        pendingInterject.delete(sid)
        setupStreamingState(sid)
      }

      if (!store.pendingQuestions[sid]) {
        // 插话中断的轮次：不弹完成通知（任务仍在继续，插话轮 result 会再触发）
        if (!interjected) {
          // 任务完成 → 系统通知。仅当没有待回答的提问时才提示——
          // CLI 若在等待提问答案，此 result 只是当前轮次结束，不算任务完成。
          try {
            const settings = useSettingsStore.getState().settings
            const api = (window as any).ponosAPI
            if (api?.notifyTaskComplete) {
              const isErr = !!(event as any).is_error
              const raw = String((event as any).result || '')
              const body = shortenText(raw, 120) || (isErr ? '任务执行出错' : '任务已完成')
              api.notifyTaskComplete({ title: isErr ? '任务出错' : '任务完成', body, onlyBackground: settings.notifyMode !== 'always' })
            }
          } catch {}
        }
      }
      return
    }
  }

  if (msg.type === 'browser:event') {
    // 浏览器执行器状态广播（executor → bridge → GUI）：写入 browserStore 驱动状态条
    useBrowserStore.getState().setEvent(msg.event as BrowserEvent)
    return
  }

  if (msg.type === 'error') {
    // 先 flush 待批的 assistant 事件，保证失败路径下块顺序不变
    flushStreamEvents()
    dropPendingTaskProgress(sid)
    pendingInterject.delete(sid)
    settlePendingInterjectsBySession(sid)
    const st = sessionState.get(sid)
    if (st?.assistantId) {
      store._appendStreamingBlock(st.assistantId, {
        id: generateId(), type: 'text',
        content: `\n\n⚠️ **Error**: ${(msg.data as any)?.message || 'Unknown'}\n`,
      })
      store._finishStreaming(st.assistantId, { inputTokens: 0, outputTokens: 0 })
      sessionState.delete(sid)
    }
    streamingSessions.delete(sid)
  }

  if (msg.type === 'cancelled') {
    // 先 flush 待批的 assistant 事件，保证取消路径下块顺序不变
    flushStreamEvents()
    dropPendingTaskProgress(sid)
    pendingInterject.delete(sid)
    settlePendingInterjectsBySession(sid)
    // Bridge confirmed the CLI process was killed — clear this conversation's running state
    store.stopStreaming(sid)
    streamingSessions.delete(sid)
    sessionState.delete(sid)
  }

  if (msg.type === 'closed') {
    // 先 flush 待批的 assistant 事件，保证关闭路径下块顺序不变
    flushStreamEvents()
    dropPendingTaskProgress(sid)
    pendingInterject.delete(sid)
    settlePendingInterjectsBySession(sid)
    // CLI process has exited — clean up any lingering session state
    streamingSessions.delete(sid)
    sessionState.delete(sid)
    useChatStore.getState().clearSubAgentTasks(sid)
  }

  if (msg.type === 'question') {
    // 数据形状：{ questions: [...] }（bridge 已解析成功）或 { raw: string }（bridge
    // 解析失败，前端再尝试一次容错解析；仍失败则降级为“直接回复”卡，避免用户面对
    // 原始 HTML 或卡死等待）。
    const qdata = msg.data as { questions?: unknown[]; context?: string; raw?: string } | undefined
    const store = useChatStore.getState()
    if (qdata?.questions) {
      store.setPendingQuestion(sid, { questions: qdata.questions as any, context: qdata.context || '' })
    } else if (typeof qdata?.raw === 'string') {
      const parsed = parseAskUserPayload(qdata.raw)
      if (parsed) {
        store.setPendingQuestion(sid, parsed)
      } else {
        console.warn('[ponos] question payload parse failed (frontend), degrading:', qdata.raw.slice(0, 160))
        store.setPendingQuestion(sid, {
          context: qdata.raw.slice(0, 400),
          questions: [{
            id: 'degraded',
            header: '提问',
            question: '(卡片内容未能自动解析——请阅读上方消息，直接在输入框输入你的回答)',
            options: [{ label: '继续', description: '无法解析此卡片，请直接输入你的回答' }],
            multiSelect: false,
          }],
        })
      }
    } else {
      return
    }
    // CLI 正在等待用户回答——清掉“执行中”流式标记，
    // 由“待回复”状态接管展示（见 Sidebar 徽标与输入框可用性）。
    store.stopStreaming(sid)
  }

  if (msg.type === 'milestones') {
    const d = msg.data as { total?: number; names?: string[] } | undefined
    if (d && typeof d.total === 'number' && d.total > 0) {
      useChatStore.getState().setConversationMilestones(sid, d.total, d.names || [])
    }
    return
  }

  if (msg.type === 'milestone-ok') {
    const d = msg.data as { index?: number } | undefined
    if (d && typeof d.index === 'number') {
      useChatStore.getState().setMilestoneDone(sid, d.index)
    }
    return
  }

  if (msg.type === 'milestone-start') {
    const d = msg.data as { index?: number } | undefined
    if (d && typeof d.index === 'number') {
      useChatStore.getState().setMilestoneStart(sid, d.index)
    }
    return
  }

  if (msg.type === 'approval') {
    // 内核 can_use_tool 权限请求（高风险命令等）：入队 PermissionDialog。
    // id 用 toolUseId（bridge 已按 toolUseId 记录 request_id 映射，审批结果
    // 回传时以它寻址）；同 toolUseId 重复事件幂等跳过。
    const d = msg.data as {
      toolUseId?: string; command?: string; reason?: string;
      highRisk?: boolean; toolName?: string;
    } | undefined
    if (d && typeof d.toolUseId === 'string' && d.toolUseId) {
      const store = useChatStore.getState()
      if (store.pendingPermissions.some(p => p.id === d.toolUseId)) return
      store.addPermissionRequest({
        id: d.toolUseId,
        action: 'bash',
        target: d.command || '',
        details: d.reason || undefined,
        risk: d.highRisk ? 'high' : 'medium',
        timestamp: Date.now(),
        sessionId: sid,
        toolUseId: d.toolUseId,
      })
    }
    return
  }

  if (msg.type === 'approval-resolved') {
    // bridge 已把审批结果注入内核——无论批准/拒绝都收起弹窗
    const d = msg.data as { toolUseId?: string } | undefined
    if (d?.toolUseId) {
      useChatStore.getState().resolvePermission(d.toolUseId, true)
    }
    return
  }
}

function upsertBlock(
  store: ReturnType<typeof useChatStore.getState>,
  st: SessionStreamState,
  messageId: string,
  keyId: string,
  block: ContentBlock,
  append = false,
) {
  const key = block.type + '-' + keyId
  if (st.blockIds[key]) {
    store._updateStreamingBlock(messageId, st.blockIds[key], {
      content: block.content,
      ...(block.metadata ? { metadata: block.metadata } : {}),
    }, append)
  } else {
    const newId = generateId()
    st.blockIds[key] = newId
    block.id = newId
    store._appendStreamingBlock(messageId, block)
  }
}
