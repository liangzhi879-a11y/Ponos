/**
 * Communicates with YFWorking CLI via WebSocket bridge (port configured via YFW_BRIDGE_PORT env or Vite define).
 *
 *   Browser ──WebSocket──► server/bridge.mjs ──stdio──► yfworking CLI
 */

import { useState, useCallback, useEffect } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { generateId, sanitizeText } from '@/lib/utils'
import { parseAskUserPayload } from '@/lib/askUser'
import { truncateTitle } from '@/lib/titleGen'
import { getWsUrl, getBridgeUrl, fetchBridgeConfig } from '@/lib/config'
import { getAgentById } from '@/lib/agents'
import { useAgentStore } from '@/stores/agentStore'
import { useHealthStore, type HealthInfo } from '@/stores/healthStore'
import { useWarningStore } from '@/stores/warningStore'
import { normalizeWarning } from '@/lib/warningUi'
import { makeLaneNote } from '@/lib/laneUi'
import { staleCompactionSids, COMPACT_INDICATOR_MAX_MS } from '@/lib/compactIndicator'
import { createHeavyModeGate, nextFlushDelay } from '@/lib/streamPressure'
import { useBrowserStore } from '@/stores/browserStore'
import { parseApprovalModeReport, type ApprovalMode } from '@/lib/approvalModeUi'
import type { ContentBlock, Message, QuestionAnswer, BrowserEvent, LoopState } from '@/types'

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
// 桥身份（2026-09-12 桥树杀事故的无感愈合）：lastBridgeId = 上次 hello 的桥实例 id；
// bridgeLostSessions = WS 断开时正在流式的会话（重连后由 hello 判明是否换桥）。
let lastBridgeId: string | null = null
const bridgeLostSessions = new Set<string>()
// 换桥自动续接提示（无感：不建用户气泡，内核 --resume 从 transcript 断点继续；
// 措辞覆盖"任务已完成但 result 丢失"的边界——模型简短收尾而非重复劳动）。
const REVIVE_PROMPT = '【系统自动续接】连接中断后已恢复。若任务尚未完成，请直接从上次断点继续推进剩余工作；若已完成，请给出简短收尾。不要重复已完成的部分。'
let pendingQueue: Array<() => void> = []
// Per-conversation streaming state — supports parallel sessions
const sessionState = new Map<string, { assistantId: string; blockIds: Record<string, string> }>()
// 同会话串行化：正在流式输出的会话集合。
// 排队插话（方案A）不再前端 hold：生成中回车立即以 next 优先级发送，由内核在
// 工具调用边界注入当前轮或等轮结束作为新轮；assistant 事件到达时以
// streamingSessions 是否含该会话区分“当前轮继续输出”与“新轮开始”。
const streamingSessions = new Set<string>()
let lastSessionId: string | null = null

// 应用层心跳（WS 半开自愈，S5 ②-07）：TCP 假死时浏览器 send 静默失败且不触发
// error/close，仅靠传输层 ping 无法感知失联。GUI 每 15s 发一次应用层 ping，
// 60s 内未收到任何消息（含流式事件）即判死强关 ws → 走既有指数退避重连自愈。
// bridge 收 ping 只回 pong、不判超时（判死在 GUI 侧，S5 D3）。
const WS_HEARTBEAT_INTERVAL_MS = 15000
const WS_HEARTBEAT_TIMEOUT_MS = 60000
let lastWsActivity = Date.now()
// 判死标记（S5 ②-07）：置位后立即 s.close() 触发既有指数退避重连；重建路径（onopen）清位。该标记为显式化"为何关闭"，供调试观测，不做二次判定。
let heartbeatDead = false
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

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

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat() {
  stopHeartbeat() // 建连/重连先停旧 interval，杜绝重复心跳
  heartbeatTimer = setInterval(() => {
    const s = ws
    if (!s || s.readyState !== WebSocket.OPEN) return
    const idle = Date.now() - lastWsActivity
    if (idle > WS_HEARTBEAT_TIMEOUT_MS) {
      // 60s 无任何消息 → 判死：强关 ws 触发 onclose → scheduleReconnect 指数退避自愈
      heartbeatDead = true
      try { s.close() } catch {}
    } else {
      // 每 15s 应用层 ping；bridge 收 ping 回 pong（pong 到达刷新 lastWsActivity）
      try { s.send(JSON.stringify({ type: 'ping' })) } catch {}
    }
  }, WS_HEARTBEAT_INTERVAL_MS)
}

export function getOrCreateWS(): WebSocket | null {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws
  }
  try {
    ws = new WebSocket(WS_URL)
    heartbeatDead = false // 重建路径清判死标记，等待 onopen 重启心跳
    ws.onopen = () => {
      console.log('[WS] connected')
      wsReady = true
      reconnectAttempts = 0
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      lastWsActivity = Date.now() // 建连即视为活跃（心跳从此刻起算）
      startHeartbeat()
      const q = pendingQueue
      pendingQueue = []
      q.forEach(fn => fn())
    }
    ws.onmessage = (raw) => {
      try {
        const msg = JSON.parse(raw.data.toString())
        lastWsActivity = Date.now() // 任何下行消息（含流式事件/pong）都算活动
        if (msg.type === 'pong') return // pong 仅心跳应答，不进业务分发
        console.log('[WS] recv:', msg.type, msg.sessionId?.slice(0,8) || '', msg.data?.type || '')
        handleMessage(msg)
      } catch (e) { console.error('[WS] parse error:', e) }
    }
    ws.onclose = (ev) => {
      // 断链归因（2026-09-13）：1006 = 无关闭帧的突断。实测 25/25 次断链前 0.0–1.4s 内都刚
      // 收到过下行帧 ⇒ 不是下面这条 60s 看门狗自杀；而桥侧 20/25 次连 close 事件都没收到
      // ⇒ 连接是在客户端侧半开掉的。故这里必须把判据一起打出来：idleMs（多久没收到任何
      // 下行帧，含未记录的 pong）/ selfKill（是否本端看门狗强关）。
      console.log('[WS] closed:', ev.code, ev.reason || '', `idleMs=${Date.now() - lastWsActivity} selfKill=${heartbeatDead ? 'heartbeat-timeout' : 'no'}`)
      heartbeatDead = false
      wsReady = false
      ws = null
      stopHeartbeat() // 关闭/重连等待期间心跳停转，onopen 时再启
      // 孤儿会话无感收口（2026-09-12 桥树杀事故）：先静默定稿所有流式会话
      // （UI 立即解锁、不留可见告警），并记入 bridgeLostSessions——重连后
      // 由 bridge_hello 判明"同一桥闪断"（无需动作）还是"换新桥"（自动续接）。
      pendingStreamEvents.length = 0
      streamFlushScheduled = false
      heavyGate.reset()
      const store = useChatStore.getState()
      const ui = useUIStore.getState()
      for (const sid of [...streamingSessions]) {
        streamingSessions.delete(sid)
        sessionState.delete(sid)
        store.stopStreaming(sid)
        bridgeLostSessions.add(sid)
        // 断连期间等待条/失速告警只会无限往上数秒，无信息量，先复位。提问卡与审批
        // 弹窗**刻意不动**：WS 闪断时内核通常还活着并在等待回答，bridge_hello 会判明
        // "同一桥闪断（无需动作）/换新桥（自动续接）"；真正要清的是内核已死那三条
        // 路径（error/cancelled/closed），见 clearSessionWaitState（T8，2026-09-12）。
        ui.clearKernelStall(sid)
        ui.clearFirstByteWait(sid)
        // 压缩指示同断线复位（2026-09-13 常驻事故收口②）：内核**不会**重发压缩态（桥握手
        // 不补投 frames），闪断时丢的若正是 done 帧，指示条会常驻到下一次压缩。提问卡/审批
        // 弹窗**仍然刻意保留**（内核通常还活着并在等回答，bridge_hello 会判明同一桥闪断/
        // 换新桥）——压缩没有这层"等用户动作"的语义，丢了就只能清。
        if (store.compactingBySession[sid]) {
          console.warn(`[compact] 断线时压缩指示悬挂 sid=${sid.slice(0, 8)} — 复位（done 帧丢失）`)
          store.setCompacting(sid, false)
        }
      }
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
 * 思考深度热切换（Task 12）：GUI 设置页选定 effort 后上送 bridge，bridge 对运行中
 * 内核会话注入 reasoning_effort control_request。conversationId 为空时回退到
 * 模块级 lastSessionId（最近发送过消息的会话），再无则 'default'——与 stop() 同款
 * 兜底。无活动会话 / WS 未连接时幂等忽略（新会话由 spawn env CLAUDE_CODE_EFFORT_LEVEL
 * 注入兜底）。ws-null-guard 与 stop() 一致：仅当已连接才 send，不排队不建连。
 */
export function sendEffort(conversationId: string | undefined, level: string) {
  const target = conversationId || lastSessionId || 'default'
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'effort', sessionId: target, level }))
  }
}

/**
 * 审批放行档位热切换（2026-09-12）：状态栏徽标选定档位后上送 bridge，bridge 记入
 * **会话级临时覆盖**（仅内存）并向运行中内核注入 approval_mode control_request。
 * mode=null 表示"跟随全局"（清掉本会话覆盖）。
 * 与 effort 的关键差异：**不写 config.json**——状态栏改的是本会话（会话结束回落全局），
 * 全局档位只在设置页改。conversationId 兜底、WS 未连接幂等忽略同 sendEffort。
 */
export function sendApprovalMode(conversationId: string | undefined, mode: ApprovalMode | null) {
  const target = conversationId || lastSessionId || 'default'
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'approval-mode', sessionId: target, mode }))
  }
}

/**
 * 构建 WS send payload；会话不存在返回 null。
 * 发送方：send（空闲/排队插话）、dispatchSend（新建轮）、interject（紧急 now）。
 * uuid：排队插话消息的唯一标识，内核处理该消息时经 command_lifecycle 事件回传
 * （'started'=已接收处理），供前端解除气泡悬浮态。
 */
// 构建 WS send payload；会话不存在返回 null
function buildSendPayload(conversationId: string, prompt: string, priority?: 'now' | 'next' | 'later', uuid?: string): Record<string, unknown> | null {
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
    // 会话模式透传：chat = 受限（bridge chat spawn 禁本地工具 + cwd=YFW_HOME）；
    // undefined 由 bridge 按 task 处理（旧会话/导入数据）
    mode: conversation.mode,
    // Resume this conversation's own CLI session (if any) — never another conversation's
    resumeId: conversation.sessionId || undefined,
    // 绑定专业 Agent 时注入其专属系统提示词（覆盖默认身份提示词）
    ...(agent ? { systemPrompt: agent.systemPrompt } : {}),
    // 携带当前主模型：bridge 以 --model 传入 CLI，resume 时可覆盖会话内
    // 存储的旧模型，实现同一聊天中两段会话之间的无缝模型切换
    ...(activeProv?.primaryModel ? { model: activeProv.primaryModel } : {}),
    // 携带该会话的历史压缩次数：bridge 经 spawn env YFW_HEALTH_COMPACT_COUNT 注入
    // 内核，恢复进程内 compactCount（进程空闲回收后压缩史不丢，血条不回绿）。
    // 双数据源取 max：healthBySession 为最近健康事件快照，summaryCompactCountBySession
    // 为压缩事件计数（yfw_summary 可能先于 yfw_health 到达，二者都可能较新）。
    ...(compactCount > 0 ? { compactCount } : {}),
    ...(priority ? { priority } : {}),
    ...(uuid ? { uuid } : {}),
  }
}

// 换桥自动续接（2026-09-12 桥树杀事故的无感愈合）：直接发 WS send payload——
// 不建用户气泡、不打断界面；内核以 --resume 恢复 transcript 后把 REVIVE_PROMPT
// 当新轮处理，续接内容经"新轮自动建块"以 assistant 消息呈现，用户全程无感。
function reviveSession(sid: string) {
  const conv = useChatStore.getState().conversations.find((c) => c.id === sid)
  if (!conv || !conv.sessionId) return
  const payload = buildSendPayload(sid, REVIVE_PROMPT)
  if (!payload) return
  const socket = getOrCreateWS()
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload))
    console.log('[WS] auto-resume sent for', sid.slice(0, 8))
  }
}

// 闪断后的重同步（2026-09-13「应用自己处理任务断掉了」事故的正面修复）。
// 同桥闪断时内核还活着、丢的只是帧：桥不补投（bridge_hello 只带桥实例 id，bridge.mjs:2595），
// 而 onclose 又把 pendingStreamEvents 清空 + 所有流式态 stopStreaming ⇒ 断线期间那一段
// （实证：整轮最终答复 + result）永久缺席屏幕，磁盘里却是完好的。这里按磁盘 transcript 补回。
// 一律不 reject（补救路径不该反过来打扰用户），返回 Promise 供调用方排序（先补再续接）。
function resyncSession(sid: string): Promise<void> {
  return useChatStore.getState().resyncConversation(sid)
    .then((r) => {
      if (r.ok) console.log('[WS] resync', sid.slice(0, 8), `netGain=${r.netGain} keptLocal=${r.keptLocal}`)
      else console.log('[WS] resync skipped', sid.slice(0, 8), r.reason || '')
    })
    .catch((e: any) => { console.log('[WS] resync failed', sid.slice(0, 8), e?.message || String(e)) })
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
function dispatchSend(conversationId: string, userContent: string, priority?: 'now' | 'next' | 'later') {
  const payload = buildSendPayload(conversationId, userContent, priority)
  if (!payload) return
  setupStreamingState(conversationId)
  sendPayloadWS(conversationId, payload)
}

export function useYFWCLI() {
  const [connected, setConnected] = useState(false)

  // Connect on mount
  useEffect(() => {
    getOrCreateWS()
    const interval = setInterval(() => {
      setConnected(wsReady)
      // K0.3：每 5s 汇总一次渲染帧指标（本 tick 无帧时 reportRenderFrames 直接返回）
      if (Date.now() - frameReportAt >= RENDER_FRAME_REPORT_MS) {
        frameReportAt = Date.now()
        reportRenderFrames()
      }
      // 孤儿子代理任务清理（节流）：taskkill/崩溃的内核发不出终态通知，靠心跳超时兜底
      if (Date.now() - lastTaskSweepAt > STALE_TASK_SWEEP_MS) {
        lastTaskSweepAt = Date.now()
        sweepStaleSubAgentTasks()
        sweepStaleCompaction()
      }
    }, 500)
    // 窗口从托盘/后台恢复可见时，若仍未连上则立即发起重连（不等退避定时器）
    const onVisible = () => {
      if (document.visibilityState === 'visible') getOrCreateWS()
    }
    // 页面隐藏时立即兜底 flush 待批流式事件：隐藏窗口里定时器会被节流到 ≥1s
    //（rAF 则是完全停摆），不兜一下这段状态就要等到窗口重新可见才追上
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

  const send = useCallback((conversationId: string, userContent: string) => {
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
      // 锚点必须是"当前正在流式"的 assistant（2026-09-10 修复）：sessionState 的
      // assistantId 在轮次结束后不清理——新轮仍在内核思考/prefill（首块未到、
      // 流式消息未建）时它指向上一轮旧 assistant，插话会被插到旧回复之前
      // （表现为排在用户最先输入的气泡下）。旧锚点失效 → 追加序列末端，
      // 新轮的回复自然排在其后，时序正确。
      const anchorId = sessionState.get(conversationId)?.assistantId
      const streamingId = useChatStore.getState().streamingConversations[conversationId]
      const effectiveAnchor = anchorId && anchorId === streamingId ? anchorId : undefined
      const interjectMsg: Message = {
        id: messageId,
        role: 'user',
        content: [{ id: generateId(), type: 'text', content: clean }],
        timestamp: Date.now(),
        pending: true,
      }
      if (effectiveAnchor) store._insertMessageBefore(conversationId, effectiveAnchor, interjectMsg)
      else store._addMessage(conversationId, interjectMsg)
      const uuid = generateId()
      registerPendingInterject(uuid, conversationId, messageId)
      const payload = buildSendPayload(conversationId, wrapInterject(userContent), 'next', uuid)
      if (payload) sendPayloadWS(conversationId, payload)
      return
    }

    // 空闲发送：普通用户消息，立即入列并开启流式
    const isFirstUserMessage = (conversation.messages?.length ?? 0) === 0
    store._addMessage(conversationId, {
      id: generateId(),
      role: 'user',
      content: [{ id: generateId(), type: 'text', content: clean }],
      timestamp: Date.now(),
    })
    // 自动标题（chat/task 通用）：首条用户消息 → 立即以内容概括为标题（≤12 字）；
    // 首轮回复完成后由 chatStore 调模型升级为更精炼的概括（见 _finishStreaming）
    if (isFirstUserMessage && conversation.titleAuto !== false) {
      const autoTitle = truncateTitle(clean)
      if (autoTitle) store._applyAutoTitle(conversationId, autoTitle)
    }
    dispatchSend(conversationId, userContent)
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

  // 上下文失真：用户「重新锚定」并已发送锚点后上报内核（bridge HTTP 路由 →
  // 内核 stdin anchor_applied → health.markFidelityResolved → 失真档回绿 + 观察期）。
  // 静默失败：本地已按用户操作回绿/冷却，上报只是让内核侧同步，不阻塞交互。
  const applyAnchor = useCallback((conversationId: string, issueIds: string[]) => {
    void fetch(`${getBridgeUrl()}/session/anchor-applied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: conversationId, issueIds }),
    }).catch(() => { /* 上报失败不影响本地回绿 */ })
  }, [])

  return { send, stop, interject, browserControl, applyAnchor, connected }
}

// ---------------------------------------------------------------------------
// Message handler — processes stream-json events from CLI
// ---------------------------------------------------------------------------

// Agent 工具调用的 tool_use_id → subagent_type（agentType）映射。
// 内核 task_started/task_progress 只带 tool_use_id，需回查 leader 消息里的 Agent 工具调用块取 agent 名。
const toolUseAgentMap = new Map<string, string>()

// 流式事件批处理：同一帧内的多次 assistant 事件合并为一次状态更新。
// 每事件语义不变（完整应用），仅降低重渲染频率。
// st 类型与模块顶部 sessionState 的 value 类型一致：
// { assistantId: string; blockIds: Record<string, string> }
// `t` = 入队时刻（performance.now）。R5 的降频判据要用它算"最老一条等了多久"——
// 单线程下主线程被 React 提交占住时，排定的 flush 定时器会晚点触发，年龄随之变大，
// 这就是本运行时的队列积压信号（见 src/lib/streamPressure.ts 头部注释）。
type StreamEvent = { sid: string; st: { assistantId: string; blockIds: Record<string, string> }; aid: string; event: Record<string, unknown>; t: number }
const pendingStreamEvents: StreamEvent[] = []
let streamFlushScheduled = false
// 自适应降频（2026-09-12 渲染空转事故 → R5 2026-09-13 换判据）：长消息每帧全量重渲染
// ReactMarkdown 会让渲染进程空转 → UI 冻结 → WS/管道反压整链卡死，故压力大时降到
// 120ms 合帧。**旧判据（单帧处理耗时 >50ms）在真实负载下从未置位过**——那个计时只包住
// store 循环、不含 React 提交；现改为测队列压力（深度 + 最老待处理项年龄）+ 不对称滞回，
// 阈值与形状取自 codex `streaming/chunking.rs`。流结束（result/cancelled/closed）时复位。
const heavyGate = createHeavyModeGate()
// 上一次 flush 的开始时刻：满速期的调度补足到 16ms 目标帧间隔用（pi-main 的
// `setTimeout(max(0, 16-elapsed))` 形状），替代原先的 rAF——后台/失焦窗口 rAF 会停摆。
let lastStreamFlushAt = 0

// K0.3 渲染帧指标（2026-09-13「任务运行慢」系统性优化）：流式期渲染进程实测吃满
// 1.35 核 / 1.5GB，但「每帧到底花了多少、真实帧间隔有没有被拉长」此前没有任何数据
// ——帧成本只包住 store 循环、不含 React 提交，故只能当**观测**，不能当降频判据
//（R5 据此换了判据，见 heavyGate）。这里把每帧成本与帧间隔记进内存，每 5s 汇总上报
// 桥侧（/diag/render-frame → 诊断报告），并带上 heavyGate 的进出次数与队列压力峰值。
// **刻意不落 uiStore**：它是 persist store，每帧写它 = 每帧一次全量 JSON.stringify +
// localStorage.setItem（R2 根因）。
const FRAME_SAMPLE_MAX = 400
const RENDER_FRAME_REPORT_MS = 5000
const frameStats = { n: 0, ms: [] as number[], gaps: [] as number[], lastAt: 0 }
let frameReportAt = 0

function flushStreamEvents() {
  streamFlushScheduled = false
  if (pendingStreamEvents.length === 0) return
  const t0 = performance.now()
  const batch = pendingStreamEvents.splice(0)
  // R5 降频判定：取走批次**之前**的队列压力（深度 + 最老一条已等待的墙钟）。
  // 必须在 drain 之前取——drain 之后队列恒为空，量不到任何东西。
  heavyGate.observe(batch.length, t0 - batch[0].t, t0)
  lastStreamFlushAt = t0
  const store = useChatStore.getState()
  for (const { st, aid, event } of batch) {
    const content = (event.message as any)?.content as Array<Record<string, unknown>> | undefined
    const msgId = (event.message as any)?.id as string || '0'
    if (!content) continue
    for (const block of content) {
      const bt = block.type as string
      const suffix = bt === 'tool_use' ? (block.id as string || 'tool') : msgId
      if (bt === 'thinking' && block.thinking) {
        // 内核 wire 分段增量发射：text/thinking 追加累积（旧 upsert 整块替换会让
        // 屏幕只剩最新片段——"看不到过往输出"根因，2026-09-09 会话 UI 标准化修复）
        store._appendStreamingContent(aid, 'thinking', sanitizeText(block.thinking as string))
      } else if (bt === 'text' && block.text) {
        store._appendStreamingContent(aid, 'text', sanitizeText(block.text as string))
      } else if (bt === 'tool_use') {
        const toolInput = (block as any).input || {}
        if (block.name === 'Agent' && block.id) {
          toolUseAgentMap.set(block.id as string, String(toolInput.subagent_type || ''))
        }
        upsertBlock(store, st!, aid, 'tool-' + suffix, {
          id: '', type: 'tool_use', content: sanitizeText(JSON.stringify(block.input || {}, null, 2)),
          metadata: { toolName: block.name, status: 'completed', toolUseId: block.id as string | undefined },
        })
      }
    }
  }
  // 帧成本照旧采样（K0.3 观测），但**不再当降频判据**：它只包住 store 循环、不含
  // React 提交，旧实现据此判定，在真实负载下从未置位过一次。降频判据见 heavyGate。
  const cost = performance.now() - t0
  // K0.3 采样：只进内存环形缓冲（不上报、不落 store、不做字符串拼接）
  frameStats.n++
  if (frameStats.ms.length < FRAME_SAMPLE_MAX) frameStats.ms.push(cost)
  if (frameStats.lastAt && frameStats.gaps.length < FRAME_SAMPLE_MAX) frameStats.gaps.push(t0 - frameStats.lastAt)
  frameStats.lastAt = t0
}

/** K0.3 每 5s 汇总一次帧指标 → 桥侧 /diag/render-frame。静默降级：桥未起/失败一律忽略。 */
function reportRenderFrames() {
  if (frameStats.n === 0) return
  const pct = (arr: number[], q: number) => {
    if (!arr.length) return 0
    const s = arr.slice().sort((a, b) => a - b)
    return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10
  }
  // R5：降频的成因也要能事后解释——只报"当时是降频态"没法回答"为什么降/为什么没降"。
  const gate = heavyGate.takeStats()
  const payload = {
    frames: frameStats.n,
    msP50: pct(frameStats.ms, 0.5),
    msP95: pct(frameStats.ms, 0.95),
    gapP50: pct(frameStats.gaps, 0.5),
    gapMax: Math.round(frameStats.gaps.length ? Math.max(...frameStats.gaps) : 0),
    heavy: heavyGate.heavy,
    heavyIn: gate.enters,
    heavyOut: gate.exits,
    qMax: gate.maxDepth,
    qAgeMax: Math.round(gate.maxAgeMs),
    reason: gate.lastReason,
  }
  frameStats.n = 0
  frameStats.ms.length = 0
  frameStats.gaps.length = 0
  try {
    fetch(`${getBridgeUrl()}/diag/render-frame`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(() => { /* 观测失败不影响 UI */ })
  } catch { /* fetch 本身同步抛（极端环境）同样忽略 */ }
}

function scheduleStreamFlush() {
  if (streamFlushScheduled) return
  streamFlushScheduled = true
  // 一律走定时器，不再用 rAF：后台/失焦窗口 rAF 会**完全停摆**（不是变慢），流式内容
  // 就只能等窗口重新可见才追上来（pi-main `tui/src/tui.ts:343,806-824` 用
  // `setTimeout(max(0,16-elapsed))` 正是为规避此坑）。降频期延迟由 gate 给
  // （120ms 合帧），满速期补足到 16ms。
  const elapsed = lastStreamFlushAt ? performance.now() - lastStreamFlushAt : 0
  setTimeout(flushStreamEvents, nextFlushDelay(heavyGate, elapsed))
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

// 内核侧等待态镜像的复位（T8，2026-09-12「卡在思考界面」事故）
//
// 内核已应答/已死时，firstByteWait（等待条）、待回复提问、未决审批都是幽灵状态：
// 此前 error/cancelled/closed 三条路径只清 kernelStall，于是内核被杀后等待条会
// 一直往上数秒、权限弹窗永不消失（PermissionDialog 取 pendingPermissions[0] 且
// 无 stale 判定）。此处把同一病根的四个镜像一次性收口。
//
// 2026-09-13 补第五个镜像 **压缩指示**：与上面四个同源——只由内核帧复位，done 帧丢一次
// 即常驻（见 src/lib/compactIndicator.ts）。此前 cancelled/closed 两条路径各自内联补了一行
// setCompacting，error 路径漏了（它只调本函数），于是"内核对压缩异常收尾"这一种最可能丢
// done 帧的场景恰好不复位。现统一收口到这里，删掉两处内联重复，避免同一病根再漏第四处。
// WS 闪断另有 onclose 处理（提问/审批刻意保留，压缩不保留），墙钟兜底在 sweepStaleCompaction。
function clearSessionWaitState(sid: string) {
  const ui = useUIStore.getState()
  ui.clearKernelStall(sid)
  ui.clearFirstByteWait(sid)
  const store = useChatStore.getState()
  // 内核已应答/已死 ⇒ 压缩不可能还在跑（kill/异常收尾时 finally 的 done 帧未必发得出来）
  if (store.compactingBySession[sid]) {
    console.warn(`[compact] 终态路径复位压缩指示 sid=${sid.slice(0, 8)} — done 帧未达或内核已终止`)
    store.setCompacting(sid, false)
  }
  store.clearPendingQuestion(sid)
  store.clearPermissionsForSession(sid)
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

// 压缩指示条兜底巡检（2026-09-13「提示/动画常驻不取消」收口③，与上方孤儿任务同节流）。
// 内核硬看门狗（kernel/cli.mjs，默认 900s）内必然出现 result 或 closed（两者都走正常
// 复位路径），所以活过 COMPACT_INDICATOR_MAX_MS 仍是 true 的指示必然是 **done 帧丢了**
// （闪断/写失败被吞/桥侧跳过）。这条 warn 就是"帧丢在哪一段"的现场指纹——比静默复位更
// 重要：今天现场 3/3 付费压缩在渲染器日志里都没有 system 帧，正是缺这条线索。
function sweepStaleCompaction() {
  const store = useChatStore.getState()
  const stale = staleCompactionSids(store.compactingBySession, store.compactingSinceBySession, Date.now())
  for (const sid of stale) {
    store.setCompacting(sid, false)
    console.warn(
      `[compact] 指示条兜底复位 sid=${sid.slice(0, 8)} 挂起超过 ${Math.round(COMPACT_INDICATOR_MAX_MS / 1000)}s — `
      + 'done 帧疑似丢失（内核/桥可能仍在正常压缩，仅指示不可信；下次 start 会重新点亮）',
    )
  }
}

function handleMessage(msg: Record<string, unknown>) {
  const store = useChatStore.getState()
  const sid = (msg.sessionId as string) || 'default'
  // Exact match only — never fallback to another session to prevent cross-project contamination
  let st = sessionState.get(sid)

  // 桥身份握手（2026-09-12 桥树杀事故的无感愈合 + 2026-09-13 闪断丢帧修复）：
  //  · 换桥重连 → 旧会话已随旧桥消亡，静默自动续接（不产生用户可见的告警/消息气泡——
  //    续接内容经新轮自动建块以 assistant 消息呈现）；续接前先把磁盘尾部补回（断线前
  //    那一轮若已完成，旧内核写进 transcript 的最终答复只在那里）。
  //  · 同一桥闪断 → 内核还活着、丢的只是帧，桥握手不补投 ⇒ 必须重同步（见 resyncSession）。
  if (msg.type === 'bridge_hello') {
    const bridgeId = String(msg.id || '')
    const replaced = !!bridgeId && lastBridgeId !== null && lastBridgeId !== bridgeId
    if (bridgeId) lastBridgeId = bridgeId
    const lost = [...bridgeLostSessions]
    bridgeLostSessions.clear()
    if (lost.length > 0) {
      if (replaced) {
        console.log('[WS] bridge replaced — resync + auto-resuming', lost.length, 'session(s)')
        // 先补磁盘尾部再续接：resyncSession 不会 reject，finally 保证续接一定发出
        for (const lostSid of lost) void resyncSession(lostSid).finally(() => reviveSession(lostSid))
      } else {
        console.log('[WS] same-bridge reconnect — resyncing', lost.length, 'session(s)')
        for (const lostSid of lost) void resyncSession(lostSid)
      }
    }
    return
  }

  // S5 ②-05 守卫接线：bridge 失速看门狗告警（顶层 kernel-stall，非内核事件）。
  // data.silentMs = 距上次内核 stdout 的静默毫秒（bridge 只告警不杀进程）。
  // 任何内核输出（event/error/cancelled/closed）到达即视为已自愈 → clearKernelStall。
  if (msg.type === 'kernel-stall') {
    const d = msg.data as { silentMs?: unknown } | undefined
    useUIStore.getState().setKernelStall(sid, Number(d?.silentMs) || 0)
    useUIStore.getState().clearFirstByteWait(sid) // 升级为失速告警，等待提示退场
    return
  }

  // 审批档位变更（2026-09-12，顶层帧非内核事件）：桥是唯一权威——它上报什么就存什么。
  // scope='cleared' = 本会话临时覆盖已消失（内核进程退出/用户选「跟随全局」）→ 删记录，
  // 徽标回落全局档；其余（session/global）= 写入上报值（override 决定是否显示「临时」）。
  if (msg.type === 'approval-mode-changed') {
    const d = msg.data as Record<string, unknown> | undefined
    if (String(d?.scope ?? '') === 'cleared') {
      useChatStore.getState().setSessionApprovalMode(sid, null)
    } else {
      // 脏帧返回 null → 保留旧值（不被畸形帧清空）
      const report = parseApprovalModeReport(d)
      if (report) useChatStore.getState().setSessionApprovalMode(sid, report)
    }
    return
  }

  // 档位未生效告警（旧缓存内核忽略 --approval-mode / 桥拒绝非法覆盖）：
  // 复用统一系统提示条（amber 级，标题本地化、message 是技术细节悬停展开）。
  // 必须让用户看见——否则他会以为 manual 已生效，而实际内核停在 loose 全放行。
  if (msg.type === 'approval-mode-degraded' || msg.type === 'approval-mode-rejected') {
    const d = msg.data as Record<string, unknown> | undefined
    useWarningStore.getState().set(sid, normalizeWarning({
      level: 'approval_mode',
      message: typeof d?.message === 'string' ? d.message
        : typeof d?.reason === 'string' ? d.reason
          : `期望 ${String(d?.expected ?? '?')}，实际 ${String(d?.actual ?? '?')}`,
    }))
    return
  }

  if (msg.type === 'event') {
    const event = msg.data as Record<string, unknown>
    const type = event.type as string
    const aid = st?.assistantId
    // 首字节等待提示（2026-09-09）：桥在轮次活跃且静默时发 system/first_byte_pending，
    // 置位等待状态；此分支先于"任何事件帧即清"的自愈逻辑——该事件自身也是事件帧
    if (type === 'system' && event.subtype === 'first_byte_pending') {
      useUIStore.getState().setFirstByteWait(sid, Number(event.silentMs) || 0)
      return
    }
    // 任何内核事件帧都是 stdout 输出 → 失速自愈，先清看门狗告警 + 等待提示
    useUIStore.getState().clearKernelStall(sid)
    useUIStore.getState().clearFirstByteWait(sid)

    if (type === 'ponos_health' || type === 'yfw_health') {
      // 按会话隔离存储：sid 即发送该事件的内核进程所属会话（conversationId）。
      // 2026-09-10 连通修复：净室内核实际发射 ponos_health（protocol.mjs wire.health），
      // 此前只监听 yfw_health → 上下文余量条从未收到数据；两名字都收兼容旧内核。
      useHealthStore.getState().update(sid, event as unknown as HealthInfo)
      return
    }
    if (type === 'yfw_summary') {
      const s = event as Record<string, any>
      useHealthStore.getState().setSummary(sid, String(s.text ?? ''), Number(s.compactCount ?? 0))
      return
    }
    if (type === 'ponos_warning') {
      // agentloop P3 告警统一系统条：budget/skill_version/agent_spec（context 顺带覆盖）。
      // 按会话隔离；同 level 后到覆盖（内核侧各 level 已单次/低频，无刷屏路径）。
      useWarningStore.getState().set(sid, normalizeWarning(event as Record<string, unknown>))
      return
    }
    if (type === 'tool_result') {
      // 工具结果 live 回传（2026-09-09 会话 UI 标准化）：回填流式消息内对应
      // tool_use 块的 result/isError——内联工具卡片"执行中/完成/失败"状态机来源
      const tr = event as Record<string, any>
      const toolUseId = String(tr.tool_use_id ?? '')
      if (aid && toolUseId) {
        store._updateToolResult(aid, toolUseId, String(tr.content ?? ''), tr.is_error === true)
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
      // 恢复旧会话（resume）时内核经 YFW_HEALTH_COMPACT_COUNT seed 恢复了压缩史，
      // 水位也由首轮 transcript 全量 usage 重新测得——GUI 应保留持久化快照直接显示，
      // 直到内核首轮 yfw_health 刷新，避免"续断点后血条瞬间回满"。
      const conv = store.conversations.find(c => c.id === sid)
      if (!conv?.sessionId) {
        useHealthStore.getState().reset(sid)
        useWarningStore.getState().reset(sid)
      } else {
        // 恢复旧会话：压力快照保留（避免血条瞬间回满），但**失真快照必须丢弃**。
        // 失真证据只存在于内核进程内（不落盘），新进程的失真态是空的（green），而它只在
        // 档位变化时才发 yfw_health（初始 lastDistortionTier='green'）→ 不清理的话，上一个
        // 进程留下的红色卡片/角标/泛光会永久赖着，"关闭"也只冷却 5 分钟、到期又冒出来，
        // 成为清不掉的假警报（与 15811 假红同族），anchorText 亦是过期文本。
        useHealthStore.getState().clearDistortion(sid)
      }
      store._updateSessionMeta({
        // sid is the bridge's session id, which the frontend sends as conversationId
        conversationId: sid,
        sessionId: event.session_id as string,
        model: event.model as string,
        tools: event.tools as string[],
      })
      // 审批档位回显（2026-09-12）：init 带的是**内核进程此刻实际在跑的**档位
      // （旧内核没有该字段 → 不动作，桥另有 approval-mode-degraded 告警）。
      // override 恒 false：进程刚起来时桥侧的会话覆盖已被 close/error 清空，
      // 此刻生效的必是全局档——若标成"临时"，徽标会在重启后错误地显示临时覆盖。
      const echoedMode = (event as Record<string, unknown>).approval_mode
      const echoed = parseApprovalModeReport({ mode: echoedMode, override: false })
      if (echoed) useChatStore.getState().setSessionApprovalMode(sid, echoed)
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
      if (subtype === 'compaction') {
        // S5 ②-02 压缩可见化：净室内核 compact.mjs 进入模型摘要前发 start、
        // finally 对称补发 done（ok 布尔；收敛失败/中止/异常同走 finally，UI 不悬挂），
        // 帧形 { type:'system', subtype:'compaction', state:'start'|'done', covered,
        // coveredTokens }（bridge 原样透传）。归约只消费 state 开关 compactingBySession
        // 驱动指示条；covered/coveredTokens 为计量字段，本态展示不需要，不消费。
        // done/error 对称复位（error 内核当前不发，保留作未来健壮性）。幂等见 setCompacting。
        const compState = String((event as Record<string, any>).state || '')
        if (compState === 'start') {
          useChatStore.getState().setCompacting(sid, true)
        } else if (compState === 'done' || compState === 'error') {
          useChatStore.getState().setCompacting(sid, false)
        }
        return
      }
      if (subtype === 'lane_compaction') {
        // agentloop lane 压缩可见化：子 Agent 会话达阈值完成摘要 → 队列尾部 push toast。
        // 帧 { taskId, text, compactCount }；同 taskId 覆盖（pushLaneNote cap 3）。
        const n = event as { taskId?: unknown; text?: unknown; compactCount?: unknown }
        useChatStore.getState().pushLaneNote(sid, makeLaneNote(String(n.taskId ?? ''), String(n.text ?? ''), Number(n.compactCount) || 0))
        return
      }
    }

    if (type === 'loop') {
      // S5 ②-05 守卫接线：多轮 loop 进度归约。净室内核 loop 帧（kernel/cli.mjs wire.loop）：
      //   start { index:0, total, until, fresh } /
      //   iter { index, total, judged?, reason?, error? }（until 判定的 iter 才带 reason）/
      //   end { reason:'completed'|'until_hit'|'cancelled'|'judge_error', index, total }
      // 帧负载经 bridge 原样透传（{type:'event',data:帧}），归约只映射展示字段。
      const d = event as Record<string, unknown>
      const loopState = String(d.state || '')
      const chat = useChatStore.getState()
      if (loopState === 'start') {
        chat.setLoopState(sid, {
          active: true,
          index: 0,
          total: Number(d.total) || 1,
          until: typeof d.until === 'string' && d.until ? d.until : undefined,
          fresh: d.fresh === true,
          // 新 loop 起跑：清掉上一 loop 残留的终结/判定文案，避免跨轮串扰
          reason: undefined,
          judgeReason: undefined,
        })
      } else if (loopState === 'iter') {
        chat.setLoopState(sid, {
          index: Number(d.index) || 0,
          total: Number(d.total) || 1,
          // until 判定的 iter 帧带模型判定文本（reason）；纯次数 iter 帧无该字段 → 清空
          judgeReason: typeof d.reason === 'string' && d.reason ? d.reason : undefined,
        })
      } else if (loopState === 'end') {
        const rawReason = String(d.reason || '')
        const validEnd = rawReason === 'completed' || rawReason === 'until_hit'
          || rawReason === 'cancelled' || rawReason === 'judge_error'
        chat.setLoopState(sid, {
          active: false,
          index: Number(d.index) || 0,
          total: Number(d.total) || 1,
          reason: validEnd ? rawReason as LoopState['reason'] : undefined,
        })
      }
      return
    }

    if (type === 'assistant' && !streamingSessions.has(sid)) {
      // 新轮自动建块（方案A）：排队插话立即发送 next 后，若上一轮已 result 结束、
      // 内核把消息作为新轮处理，assistant 事件到达时本会话已不在流式集合——
      // 此时 st 仍指向上一轮的块（result 不删 sessionState），必须重建流式占位，
      // 否则新轮输出会错挂到上一轮块上或被静默丢弃。
      setupStreamingState(sid)
      st = sessionState.get(sid)
    }
    if (type === 'assistant' && aid) {
      pendingStreamEvents.push({ sid, st: st!, aid, event, t: performance.now() })
      scheduleStreamFlush()
      return
    }

    if (type === 'result' && aid) {
      const usage = (event.usage || {}) as Record<string, number>
      const interjected = pendingInterject.has(sid)
      // 无条件结束流式状态（2026-09-09 状态残留修复）：原 pendingQuestions 门控
      // 在"提问卡片残留/中止-愈合路径"下会让流式状态永远清不掉——UI 显示
      // 执行中而内核早已收尾。"后端在等回答"的信号由「待回复」徽标
      // （pendingQuestions[conv.id]）承担，不靠流式状态硬撑。
      store._finishStreaming(aid, { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 })
      // 本轮响应结束 → 释放串行锁
      streamingSessions.delete(sid)
      // R5：降频状态不跨轮继承（旧实现靠"单帧 <20ms 即恢复"自愈，但它压根没进过降频态）。
      // 新一轮从满速起步，若开盘就来一大坨事件，压力判据会在第一帧内重新进档。
      heavyGate.reset()
      // 压缩指示随回合收口（2026-09-13 常驻事故的**精确**兜底）：压缩在 preStep 内 await，
      // 不可能跨回合边界 ⇒ result 到达即证明本轮压缩的 done 帧本该早已到达；此刻仍为 true
      // 只可能是 done 丢了（闪断/写失败被吞/桥侧跳过）。正常路径 setCompacting 同值短路，无动作。
      if (store.compactingBySession[sid]) {
        console.warn(`[compact] 回合结束仍挂着压缩指示 sid=${sid.slice(0, 8)} — done 帧丢失，复位`)
        store.setCompacting(sid, false)
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
            const api = (window as any).yfworkingAPI
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
    clearSessionWaitState(sid) // 出错回执 = 内核已应答：失速/等待条/提问卡/审批弹窗一并复位
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
    clearSessionWaitState(sid) // 取消回执 = 内核已应答：失速/等待条/提问卡/审批弹窗/压缩指示一并复位
    dropPendingTaskProgress(sid)
    pendingInterject.delete(sid)
    settlePendingInterjectsBySession(sid)
    // Bridge confirmed the CLI process was killed — clear this conversation's running state
    store.stopStreaming(sid)
    streamingSessions.delete(sid)
    sessionState.delete(sid)
    // 进程已销毁，loop 不可能再推进 → 清守卫状态（内核 cancel 通常已先发 loop end）
    useChatStore.getState().clearLoopState(sid)
    // 压缩指示已在上面 clearSessionWaitState 内复位（kill 打断压缩时内核 finally 未必执行）
  }

  if (msg.type === 'closed') {
    // 先 flush 待批的 assistant 事件，保证关闭路径下块顺序不变
    flushStreamEvents()
    clearSessionWaitState(sid) // 进程已退出：失速/等待条/提问卡/审批弹窗一并清除
    dropPendingTaskProgress(sid)
    pendingInterject.delete(sid)
    settlePendingInterjectsBySession(sid)
    // CLI process has exited — clean up any lingering session state
    streamingSessions.delete(sid)
    sessionState.delete(sid)
    // 流式消息定稿（2026-09-12 卡死事故修复）：此前缺失——内核死亡（EPIPE 等）时
    // bridge 发 closed，但 chatStore.streamingConversations 不清 → UI 恒显示
    // "执行中"、输入条锁排队态、用户以为输入框坏了。result 路径有 _finishStreaming，
    // closed 路径必须对称补齐。
    useChatStore.getState().stopStreaming(sid)
    useChatStore.getState().clearSubAgentTasks(sid)
    useChatStore.getState().clearLoopState(sid) // loop 随内核进程终止，防悬挂 active
    // 压缩指示已在上面 clearSessionWaitState 内复位（同随进程终止）
  }

  if (msg.type === 'question-resolved') {
    // 桥侧提问已解决（回答注入 / 其他路径清除）→ 前端同步清除待回复卡片。
    // 此前从不处理该事件——提问残留会让「待回复」徽标与 pendingQuestions 门控
    // 双双泄漏（2026-09-09 状态残留修复）。
    useChatStore.getState().clearPendingQuestion(sid)
    return
  }

  if (msg.type === 'question' || msg.type === 'approval') {
    // 时序修复（2026-09-12）：assistant 流式帧走定时器批处理（16ms 满速 / 120ms 降频），而审批与提问帧是
    // **同步**应用的 ⇒ 卡片会抢跑到"产出它的那条消息"前面，用户看到"审批内容和会话进度
    // 对不上、消息已过期"。落卡/落弹窗前同步冲一次待处理流事件即恢复正确时序
    // （flushStreamEvents 幂等：已排的定时器回调随后拿到空队列即返回）。
    flushStreamEvents()
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
        console.warn('[yfw] question payload parse failed (frontend), degrading:', qdata.raw.slice(0, 160))
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

  if (msg.type === 'provider_updated') {
    // 供应商配置实时更新（2026-09-11）：bridge 探测回填后广播（models/contextWindow
    // 等实测值）——重拉配置刷新设置页，无需用户手动保存/重启；运行中会话由
    // bridge env 签名收割机制在下次发送时接管。
    const d = msg.data as { providerId?: string; updates?: Record<string, unknown> } | undefined
    fetchBridgeConfig()
      .then(cfg => {
        const st = useSettingsStore.getState()
        st.updateSettings({
          activeProvider: cfg.activeProvider,
          providers: cfg.providers,
          skillRoot: cfg.skillRoot,
          autoCapture: cfg.autoCapture,
          autoImageBridge: cfg.autoImageBridge,
          visionProviderId: cfg.visionProviderId || '',
        })
      })
      .catch(() => { /* 拉取失败静默：下次打开设置页仍会全量刷新 */ })
    void d
    return
  }

  if (msg.type === 'approval') {
    // 内核 can_use_tool 权限请求（高风险命令等）：入队 PermissionDialog。
    // id 用 toolUseId（bridge 已按 toolUseId 记录 request_id 映射，审批结果
    // 回传时以它寻址）；同 toolUseId 重复事件幂等跳过。
    const d = msg.data as {
      toolUseId?: string; command?: string; reason?: string;
      highRisk?: boolean; toolName?: string;
      /** 灾难级硬黑名单（四档都问；弹窗须显示灾难级警示条，放行仅本次有效） */
      hard?: boolean;
      /** 内核发起本次询问时生效的档位（弹窗显示"当前 X 档"） */
      mode?: string;
    } | undefined
    if (d && typeof d.toolUseId === 'string' && d.toolUseId) {
      const store = useChatStore.getState()
      if (store.pendingPermissions.some(p => p.id === d.toolUseId)) return
      // 白名单审批（2026-09-10）：内核 Browser 工具域名拦截时的加白申请
      // （toolName=browser_whitelist_add）——低风险动作，专用文案渲染
      const isWhitelist = d.toolName === 'browser_whitelist_add'
      store.addPermissionRequest({
        id: d.toolUseId,
        action: isWhitelist ? 'browser_whitelist_add' : 'bash',
        target: d.command || '',
        details: d.reason || undefined,
        risk: isWhitelist ? 'low' : (d.highRisk || d.hard ? 'high' : 'medium'),
        timestamp: Date.now(),
        sessionId: sid,
        toolUseId: d.toolUseId,
        // 灾难级标记必须**透传**到弹窗：丢了它就只剩一个普通高风险弹窗，
        // 用户不知道这是"可能毁盘、且不会被记住"的一次性放行（安全关键路径）。
        hard: d.hard === true,
        mode: parseApprovalModeReport({ mode: d.mode })?.mode,
      })
    }
    return
  }

  if (msg.type === 'approval-resolved') {
    // bridge 已把审批结果注入内核——无论批准/拒绝都收起弹窗。
    // approved 必须取自 bridge（2026-09-12 修复）：此前渲染侧硬编码 true，使
    // "[permission] resolved: … approved" 日志既不能当批准证据、也区分不出"过期 no-op"。
    const d = msg.data as { toolUseId?: string; approved?: boolean; stale?: boolean } | undefined
    if (d?.toolUseId) {
      useChatStore.getState().resolvePermission(d.toolUseId, d.approved === true, { stale: d.stale === true })
    }
    return
  }

  if (msg.type === 'approval-expired') {
    // 内核已回吐该工具结果 = 这条审批在内核侧已经结束（放行后执行完，或等待超时放弃）。
    // 必须无条件收起弹窗：留下的就是一个"点了没反应"的死弹窗（内核 resolveApproval
    // 查不到 waiter ⇒ 静默 no-op），这正是"审批时消息已过期"的实证形态。
    const d = msg.data as { toolUseId?: string; reason?: string } | undefined
    if (d?.toolUseId) {
      useChatStore.getState().resolvePermission(d.toolUseId, false, { expired: true })
    }
    return
  }
}

function upsertBlock(
  store: ReturnType<typeof useChatStore.getState>,
  st: { assistantId: string; blockIds: Record<string, string> },
  messageId: string,
  keyId: string,
  block: ContentBlock,
) {
  const key = block.type + '-' + keyId
  if (st.blockIds[key]) {
    store._updateStreamingBlock(messageId, st.blockIds[key], {
      content: block.content,
      ...(block.metadata ? { metadata: block.metadata } : {}),
    })
  } else {
    const newId = generateId()
    st.blockIds[key] = newId
    block.id = newId
    store._appendStreamingBlock(messageId, block)
  }
}
