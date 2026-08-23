import { create } from 'zustand'
import { persist, createJSONStorage, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type { Conversation, Message, ContentBlock, PermissionRequest, BackgroundTask, QuestionPayload, ConversationProgress, SubAgentTask, ConversationSet } from '@/types'
import { generateId, sanitizeText, repairCorruptedJson, recoverCorruptedChatState } from '@/lib/utils'
import { getDefaultHome } from '@/lib/config'
import { useHealthStore } from '@/stores/healthStore'
import { loadConversationMessages as loadTranscriptMessages } from '@/lib/transcriptLoader'

// ---------------------------------------------------------------------------
// 防御性持久化（2026-08-13 事故修复）
// ---------------------------------------------------------------------------
// 事故背景：持久化的 chat 数据曾在字节层面损坏——内容里混入原始控制字符
// （U+0000/U+0002 等）与乱码，导致 JSON.parse 同步抛错；zustand persist 的
// _toThenable 会吞掉该异常 → rehydrate 静默失败 → store 回退为空初始状态，
// 表现就是"会话/宽度格式丢失，重启也恢复不了"（重启只是重读同一份损坏字节）。
// 兜底策略：
//   1. 解析失败 → 先把原始损坏值备份到 CORRUPT_BACKUP_KEY（绝不静默丢弃）；
//   2. 剥离控制字符后重试解析，成功则写回修复后的值；
//   3. 解析成功但内容仍带控制字符 → 深清洗后写回，防止脏字节再次落地。
const CORRUPT_BACKUP_KEY = 'yfworking-chat-corrupt-backup'
// 校验通过后的镜像副本：主值再损坏时回退到这里，保证历史永不静默丢失
const MIRROR_KEY = 'yfworking-chat-mirror'

// 模块级冲刷钩子：resilientChatStorage 闭包内赋值，供 importLegacyChatState 调用。
// 直接暴露 flush 会破坏"持久化只经 store"的封装；外部一律通过 store action 进入。
let chatPersistFlush: (() => void) | null = null

/** 深度清洗：所有字符串剥掉脏控制字符（保留 \t \n \r）。无变化时返回原引用。 */
function deepSanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    const cleaned = sanitizeText(value)
    return cleaned === value ? value : cleaned
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map(v => {
      const c = deepSanitize(v)
      if (c !== v) changed = true
      return c
    })
    return changed ? out : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = deepSanitize(v)
      if (c !== v) changed = true
      out[k] = c
    }
    return changed ? out : value
  }
  return value
}

// ---------------------------------------------------------------------------
// 流式写防抖（2026-08-15 多项目卡死修复）
// ---------------------------------------------------------------------------
// 根因：chatStore 在每次 set()（含每个流式块更新）都会触发持久化——
// zustand persist 的 newImpl 把 {state, version} 对象直接传给 storage.setItem，
// createJSONStorage 在 setItem 内同步 JSON.stringify 全量会话 + localStorage
// 同步写盘。会话积累到数十 MB 后（leveldb 实测 28MB×2），单次序列化需
// 100ms~300ms+；多项目并发流式时每帧多次 set()，主线程被持续占满 → 整窗无响应
// （提问卡片/权限弹窗出现时恰好是用户需要交互的时刻，表现最明显）。
// 修复：setItem 改为尾部防抖——流式风暴期间合并为最后一次写入（静默 600ms 后
// 才 stringify+落盘），主线程只承担廉价 partialize；切后台/关窗前强制 flush，
// 常规退出不丢数据。崩溃丢失窗口 ≤600ms（最后一次写之前的状态），可接受。
const PERSIST_DEBOUNCE_MS = 600

// 流式进行中拉长防抖：持续输出期间（每事件都 set()）不重复做数十 MB 全量序列化，
// 只在静默 5s 后落盘一次；流式结束的 set() 仍走 600ms 快防抖，最终态及时保存。
// 切后台/关窗前依旧强制 flush，崩溃丢失窗口 ≤5s（仅丢流式中途内容，非结构性丢失）。
const PERSIST_STREAMING_DEBOUNCE_MS = 5000

// 镜像/备份写入的字符数上限：超过则跳过。该体积下（主值 + 镜像合计已撞 per-origin
// quota）镜像 setItem 必然抛 QuotaExceededError 白写一次 80MB+ 同步写盘阻塞主线程；
// 跳过镜像只损失一个本就写不进去的冗余副本，主值不受影响。
const MIRROR_MAX_CHARS = 30 * 1024 * 1024

// ---------------------------------------------------------------------------
// v2 架构：消息体归内核 transcript，localStorage 只存索引（2026-08-17 改造）
// ---------------------------------------------------------------------------
// 背景：v1 把全部会话消息（可达 41MB）塞进单一 localStorage 键，启动全量 parse、
// 每次写入全量序列化（372ms+），是整机卡死根因。参考 claude-code / deepseek-harness
// 的会话系统设计（磁盘 append-only JSONL + header 列表 + 摘要压缩），v2 改为：
//   1. 消息全文权威源 = 内核 transcript（~/.yfworking/projects/<cwd>/<sessionId>.jsonl，
//      内核已 append-only 写入），GUI 不再持久化消息体；
//   2. localStorage 只存会话元数据索引（目标 <200KB），启动/切换时按需从 bridge
//      /transcript/load 拉取激活会话消息（展示级裁剪）；
//   3. 导入的无 transcript 会话（mergeImportedChats / importLegacyChatState）消息
//      兜底存 EXT_KEY_PREFIX + conversationId 分键，加载时与 transcript 合并。
const EXT_KEY_PREFIX = 'yfworking-chat-ext-'
// 内存最多驻留的已加载会话数（流式会话与激活会话豁免），超出卸载最旧
const MAX_LOADED_CONVERSATIONS = 3

/**
 * 会话消毒：保证每个 conversation.messages 是数组（undefined/null/非数组 → []），
 * 同时保证 conv 是非 null 对象。rehydrate/migrate 后统一调用，避免持久化数据
 * 缺字段（partialize 不存 messages）或损坏时下游 `c.messages.length`/`[...c.messages]` 崩。
 * 2026-08-18 修复：启动报 `Cannot read properties of undefined (reading 'length')`
 * 与 `r.messages is not iterable` 根因 = rehydrate 后 messages 字段缺失。
 */
function sanitizeConversations(convs: unknown): Conversation[] {
  if (!Array.isArray(convs)) return []
  const out: Conversation[] = []
  let changed = false
  for (const c of convs) {
    if (!c || typeof c !== 'object') { changed = true; continue }
    const obj = c as Record<string, unknown>
    if (Array.isArray(obj.messages)) {
      out.push(c as Conversation)
    } else {
      changed = true
      out.push({ ...obj, messages: [] } as unknown as Conversation)
    }
  }
  // 全部干净时返回原引用：调用方据此跳过无谓的 setState/写回
  return changed ? out : convs as Conversation[]
}

/** 消息数组防御访问：运行时会话可能缺 messages 字段（历史持久化/外部合并/竞态），统一兜底为 []。 */
function asMessages(m: unknown): Message[] {
  return Array.isArray(m) ? m as Message[] : []
}

/**
 * 把消息按 timestamp 稳定插入到正确时序位置（线性扫描，O(n)，会话消息数小足够用）。
 * 同 timestamp 时新消息排在旧消息之后（保持进入顺序）。
 * 用途：插话锚点失效（流式消息已结束/被切走）时，让消息按真实时间落到序列中正确的位置，
 * 而不是堆在末端，用户看不到自己的消息在哪一步被接收。
 */
function insertByTimestamp(msgs: Message[], message: Message): Message[] {
  const ts = message.timestamp ?? Date.now()
  let i = 0
  while (i < msgs.length && (msgs[i].timestamp ?? 0) <= ts) i++
  return [...msgs.slice(0, i), message, ...msgs.slice(i)]
}

/** 带回退修复的 localStorage persist storage：解析失败不再静默丢数据。 */
function resilientChatStorage(): PersistStorage<unknown> | undefined {
  const base = createJSONStorage(() => localStorage)
  if (!base) return base
  const origGetItem = base.getItem.bind(base)

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let pendingName: string | null = null
  let pendingValue: StorageValue<unknown> | null = null

  // 供 importLegacyChatState 等外部路径冲刷挂起写（模块级闭包引用，见下）
  chatPersistFlush = () => { if (debounceTimer !== null || pendingName !== null) flushPendingWrite() }

  const flushPendingWrite = () => {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null }
    if (pendingName !== null && pendingValue !== null) {
      const name = pendingName
      const value = pendingValue
      pendingName = null
      pendingValue = null
      try {
        // 序列化一次；写入前必须能解析回对象且 state 深清洗一致——
        // 防止损坏状态（含控制字符/游离转义的内容）落地污染持久化数据
        const serialized = JSON.stringify(value)
        const parsed = JSON.parse(serialized) as { state?: unknown } | null
        if (parsed && parsed.state !== undefined) {
          const cleaned = deepSanitize(parsed.state)
          const finalStr = cleaned !== parsed.state
            ? JSON.stringify({ ...(parsed as Record<string, unknown>), state: cleaned })
            : serialized
          // 主值先写；镜像副本紧随其后（各自独立 try，镜像失败不影响主值）。
          // 超大值跳过镜像：quota 必然超限且省一次 80MB+ 同步写盘。
          window.localStorage.setItem(name, finalStr)
          if (finalStr.length <= MIRROR_MAX_CHARS) {
            try { window.localStorage.setItem(MIRROR_KEY, finalStr) } catch { /* ignore */ }
          }
        } else {
          // 结构异常（无 state 键）：不写主值，保留上次有效数据
          console.warn('[chatStore] persist 校验失败，跳过写入', name)
        }
      } catch { /* ignore */ }
    }
  }

  // 切后台（最小化/覆盖）或关窗前强制落盘，防抖窗口内的最新状态不丢失
  if (typeof window !== 'undefined') {
    const onUnload = () => flushPendingWrite()
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('pagehide', onUnload)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingWrite()
    })
  }

  return {
    ...base,
    getItem: (name) => {
      try {
        const parsed = origGetItem(name)
        // 解析成功：仍做一次深清洗，过滤历史脏字节（如有变化则修复后写回）
        if (parsed && typeof parsed === 'object' && 'state' in (parsed as Record<string, unknown>)) {
          const state = (parsed as { state?: unknown }).state
          let cleanedState = deepSanitize(state)
          // 会话消毒必须在这里（纯数据层）兜底：partialize 不存 messages，
          // 历史/损坏数据可能缺失该字段；且 onRehydrateStorage 回调在 create()
          // 期间同步执行，模块级 useChatStore 尚处 TDZ（引用即 ReferenceError，
          // 被 toThenable 静默吞掉导致整个 hydrate 链死亡），不可依赖。
          if (cleanedState && typeof cleanedState === 'object') {
            const st = cleanedState as Record<string, unknown>
            if (Array.isArray(st.conversations)) {
              const convs = sanitizeConversations(st.conversations)
              if (convs !== st.conversations) cleanedState = { ...st, conversations: convs }
            }
          }
          if (cleanedState !== state) {
            const fixed = { ...(parsed as Record<string, unknown>), state: cleanedState }
            try { window.localStorage.setItem(name, JSON.stringify(fixed)) } catch { /* ignore */ }
            return fixed
          }
        }
        return parsed
      } catch {
        // 1) 备份原始损坏值，绝不静默覆盖
        try {
          const raw = window.localStorage.getItem(name)
          if (raw !== null) window.localStorage.setItem(CORRUPT_BACKUP_KEY, raw)
        } catch { /* ignore */ }
        // 2) 逐级修复（剥控制字符 → 修复游离反斜杠 → 还原 U+XX00 双编码），
        //    任一级解析成功即写回修复值并同步镜像
        try {
          const raw = window.localStorage.getItem(name)
          if (raw !== null) {
            const repaired = repairCorruptedJson(raw)
            if (repaired !== null) {
              try {
                window.localStorage.setItem(name, repaired)
                window.localStorage.setItem(MIRROR_KEY, repaired)
              } catch { /* ignore */ }
              return JSON.parse(repaired)
            }
          }
        } catch { /* ignore */ }
        // 3) 容错重建：结构锚点提取会话状态，正文原样保留（含乱码）
        try {
          const raw = window.localStorage.getItem(name)
          if (raw !== null) {
            const recovered = recoverCorruptedChatState(raw)
            if (recovered && typeof recovered === 'object') {
              const fixed = { state: recovered, version: 0 }
              const str = JSON.stringify(fixed)
              try {
                window.localStorage.setItem(name, str)
                window.localStorage.setItem(MIRROR_KEY, str)
              } catch { /* ignore */ }
              return fixed
            }
          }
        } catch { /* ignore */ }
        // 4) 回退镜像副本（镜像只含校验通过的写入，不会损坏）
        try {
          const mir = window.localStorage.getItem(MIRROR_KEY)
          if (mir !== null) return JSON.parse(mir)
        } catch { /* ignore */ }
        // 5) 彻底无法修复：返回 null → persist 回退空初始状态
        //    （原始损坏值已备份到 CORRUPT_BACKUP_KEY，不会静默丢失）
        return null
      }
    },
    setItem: (name, value) => {
      // 尾部防抖：写风暴（多会话并发流式）期间合并为最后一次写入；
      // 静默 600ms 后 stringify+落盘一次，主线程不再被每块全量序列化占满。
      pendingName = name
      pendingValue = value
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      // 流式进行中拉长防抖窗口：持续输出期不做全量序列化，只保留最后一次写入
      //（流式结束/切后台/关窗时仍会 flush）。引用经 try 兜底，避免初始化时序问题。
      let streaming = false
      try {
        streaming = Object.keys(useChatStore.getState().streamingConversations ?? {}).length > 0
      } catch { /* ignore */ }
      debounceTimer = setTimeout(
        flushPendingWrite,
        streaming ? PERSIST_STREAMING_DEBOUNCE_MS : PERSIST_DEBOUNCE_MS
      )
    },
  }
}

/**
 * 内存驻留上限控制：卸载超出 MAX_LOADED_CONVERSATIONS 的已加载会话消息
 * （激活会话与流式中的会话豁免——流式会话正被逐 token 写入，不能卸载）。
 * 卸载只清空 messages（保留 messageCount 元数据），再次切换时按需重新加载。
 */
function evictLoadedConversations() {
  const st = useChatStore.getState()
  const loaded = st.conversations.filter(
    c => (c.messages?.length ?? 0) > 0
      && c.id !== st.activeConversationId
      && !st.streamingConversations[c.id]
  )
  const excess = loaded.length - MAX_LOADED_CONVERSATIONS
  if (excess <= 0) return
  const victims = [...loaded].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).slice(0, excess)
  const victimIds = new Set(victims.map(v => v.id))
  useChatStore.setState(state => ({
    conversations: state.conversations.map(c =>
      victimIds.has(c.id)
        ? { ...c, messages: [], messageCount: c.messageCount ?? c.messages.length }
        : c
    ),
  }))
}

interface ChatState {
  // Conversations
  conversations: Conversation[]
  activeConversationId: string | null
  conversationSets: ConversationSet[]
  /** 会话消息按需加载中（不持久化）：conversationId → loading */
  conversationLoading: Record<string, boolean>
  // Per-conversation streaming: conversationId → streaming assistant message id
  // ('__pending__' means a task is queued/running but has no assistant message yet)
  streamingConversations: Record<string, string>

  // Permissions
  pendingPermissions: PermissionRequest[]

  // Session metadata (from CLI)
  sessionId: string | null
  sessionModel: string | null
  sessionTools: string[]
  sessionCost: number | null
  sessionDuration: number | null

  // Last working directory the user specified — used as the default cwd for new conversations
  lastCwd: string

  // Background Tasks
  backgroundTasks: BackgroundTask[]

  // Retry: stores the user text to re-send when retry is clicked
  pendingResend: { conversationId: string; text: string } | null

  // Interactive questions (AskUserQuestion replacement) — per-conversation,
  // keyed by conversationId so the sidebar can show "待回复" and the question
  // card survives switching conversations.
  pendingQuestions: Record<string, QuestionPayload>

  // Milestone progress — per-conversation, runtime-only (not persisted)
  conversationProgress: Record<string, ConversationProgress>

  // 子 agent 任务（二级面板数据源，运行时瞬态不持久化）
  subAgentTasks: Record<string, SubAgentTask[]>

  // Actions
  createConversation: (cwd?: string, agentId?: string) => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string) => void
  /** 按需加载会话消息体（内核 transcript + ext 兜底），加载完成注入 messages */
  ensureConversationLoaded: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => void
  setConversationCwd: (id: string, cwd: string) => void
  setConversationAgent: (id: string, agentId: string | null) => void
  // Invalidate the CLI session bound to a conversation so the next message
  // spawns a fresh CLI process (used when active provider/model changes — the
  // running CLI inherited env vars at spawn time and won't pick up new settings).
  invalidateSession: (id: string) => void
  pinConversation: (id: string) => void
  reorderConversations: (fromIndex: number, toIndex: number) => void
  reorderConversationSets: (fromIndex: number, toIndex: number) => void
  createConversationSet: (name: string, cwd?: string) => string
  setConversationSet: (conversationId: string, setId: string | null) => void
  renameConversationSet: (id: string, name: string) => void
  deleteConversationSet: (id: string) => void
  autoOrganize: () => number
  mergeImportedChats: (data: { sets: ConversationSet[]; conversations: Conversation[] }) => { addedConversations: number; addedSets: number; droppedOldest: number }
  /** 旧格式导入：以持久化白名单字段整体接管内存状态并冲刷挂起的防抖写立即落盘。
   *  直写 localStorage 会被挂起的防抖写（内存旧快照）随后覆盖，必须走 store。 */
  importLegacyChatState: (json: string) => boolean
  stopStreaming: (conversationId?: string) => void
  retryMessage: (conversationId: string, messageId: string) => void
  editMessage: (conversationId: string, messageId: string, newContent: ContentBlock[]) => void
  consumePendingResend: () => { conversationId: string; text: string } | null

  // Internal API methods (used by useChat hook)
  _addMessage: (conversationId: string, message: Message) => void
  _insertMessageBefore: (conversationId: string, beforeMessageId: string, message: Message) => void
  _moveMessageToEnd: (conversationId: string, messageId: string) => void
  setMessagePending: (conversationId: string, messageId: string, pending: boolean) => void
  _addStreamingMessage: (conversationId: string) => string
  _appendStreamingBlock: (messageId: string, block: ContentBlock) => void
  _updateStreamingBlock: (messageId: string, blockId: string, updates: Partial<ContentBlock>, appendText?: boolean) => void
  _resumeStreaming: (conversationId: string, messageId: string) => void
  _updateMessageMeta: (messageId: string, meta: { model?: string; tokensUsed?: number }) => void
  _finishStreaming: (messageId: string, usage: { inputTokens: number; outputTokens: number }) => void
  _updateSessionMeta: (meta: { conversationId?: string; sessionId?: string; model?: string; tools?: string[]; totalCost?: number; duration?: number }) => void

  addPermissionRequest: (request: PermissionRequest) => void
  resolvePermission: (id: string, approved: boolean) => void
  clearPermissions: () => void

  addBackgroundTask: (task: BackgroundTask) => void
  updateBackgroundTask: (id: string, updates: Partial<BackgroundTask>) => void
  removeBackgroundTask: (id: string) => void

  setPendingQuestion: (conversationId: string, payload: QuestionPayload) => void
  clearPendingQuestion: (conversationId?: string) => void

  setConversationMilestones: (conversationId: string, total: number, names: string[]) => void
  setMilestoneDone: (conversationId: string, index: number) => void
  setMilestoneStart: (conversationId: string, index: number) => void

  upsertSubAgentTask: (conversationId: string, patch: Partial<SubAgentTask> & { taskId: string }) => void
  clearSubAgentTasks: (conversationId: string) => void
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      conversationSets: [],
      activeConversationId: null,
      conversationLoading: {},
      streamingConversations: {},
      sessionId: null,
      sessionModel: null,
      sessionTools: [],
      sessionCost: null,
      sessionDuration: null,
      lastCwd: '',
      pendingPermissions: [],
      backgroundTasks: [],
      pendingResend: null,
      pendingQuestions: {},
      conversationProgress: {},
      subAgentTasks: {},

      createConversation: (cwd?: string, agentId?: string) => {
        // 新建会话即视为开启全新健康周期：健康状态已按会话隔离存储，
        // 新会话 id 天然无数据（100% 绿），旧会话快照保留供切换回看；
        // 无需全局清空，避免误伤并行会话的健康跟踪。
        const id = generateId()
        const { lastCwd } = get()
        const fallback = getDefaultHome() || 'C:/'
        const dir = (cwd || lastCwd || fallback).replace(/\\/g, '/')
        const name = dir.split('/').filter(Boolean).pop() || dir
        const conversation: Conversation = {
          id,
          title: name,
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          model: 'deepseek-v4-flash',
          cwd: dir,
          agentId: agentId || undefined,
        }
        set(state => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }))
        return id
      },

      deleteConversation: (id) => {
        // v2：删除该会话的 ext 兜底键（transcript 随内核保留，不在此清理）
        try { window.localStorage.removeItem(EXT_KEY_PREFIX + id) } catch { /* ignore */ }
        // 同步清理该会话的健康快照（避免 localStorage 残留陈旧会话数据）
        useHealthStore.getState().reset(id)
        set(state => {
          const filtered = state.conversations.filter(c => c.id !== id)
          const nextActive = state.activeConversationId === id
            ? (filtered[0]?.id || null)
            : state.activeConversationId
          const conversationProgress = { ...state.conversationProgress }
          delete conversationProgress[id]
          const subAgentTasks = { ...state.subAgentTasks }
          delete subAgentTasks[id]
          return { conversations: filtered, activeConversationId: nextActive, conversationProgress, subAgentTasks }
        })
      },

      setActiveConversation: (id) => {
        set({ activeConversationId: id })
        // 按需加载：目标会话消息未在内存时从内核 transcript 拉取（加载期间 ChatWindow 显示加载态）
        void get().ensureConversationLoaded(id)
      },

      ensureConversationLoaded: async (id) => {
        const st = get()
        const conv = st.conversations.find(c => c.id === id)
        if (!conv || st.conversationLoading[id]) return
        // 已在内存（激活会话/最近加载的）直接跳过
        if ((conv.messages?.length ?? 0) > 0) return
        set(state => ({ conversationLoading: { ...state.conversationLoading, [id]: true } }))
        try {
          // ext 兜底：导入的无 transcript 会话（mergeImportedChats / importLegacyChatState）
          let extMessages: Message[] | null = null
          try {
            const raw = window.localStorage.getItem(EXT_KEY_PREFIX + id)
            if (raw) extMessages = JSON.parse(raw) as Message[]
          } catch { /* ignore */ }
          const loaded = await loadTranscriptMessages({ sessionIds: conv.sessionIds, cwd: conv.cwd, extMessages })
          set(state => ({
            conversations: state.conversations.map(c =>
              c.id === id ? { ...c, messages: loaded, messageCount: loaded.length } : c
            ),
            conversationLoading: { ...state.conversationLoading, [id]: false },
          }))
          // 卸载超出驻留上限的会话（保留激活 + 流式），控制内存
          evictLoadedConversations()
        } catch {
          set(state => ({ conversationLoading: { ...state.conversationLoading, [id]: false } }))
        }
      },

      renameConversation: (id, title) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        }))
      },

      setConversationCwd: (id, cwd) => {
        const dir = cwd.replace(/\\/g, '/')
        const name = dir.split('/').filter(Boolean).pop() || dir
        set(state => ({
          lastCwd: dir,
          conversations: state.conversations.map(c =>
            c.id === id ? { ...c, cwd: dir, title: name, updatedAt: Date.now() } : c
          ),
        }))
      },

      setConversationAgent: (id, agentId) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id ? { ...c, agentId: agentId || undefined } : c
          ),
        }))
      },

      // Drop the CLI session bound to a conversation so the next message spawns
      // a fresh CLI process. Used when the active provider/model changes — the
      // running CLI inherited env vars at spawn time and won't pick up new
      // settings without a restart.
      invalidateSession: (id) => {
        set(state => {
          if (!state.conversations.some(c => c.id === id)) return state
          return {
            conversations: state.conversations.map(c =>
              c.id === id ? { ...c, sessionId: undefined, updatedAt: Date.now() } : c
            ),
            streamingConversations: Object.fromEntries(
              Object.entries(state.streamingConversations).filter(([k]) => k !== id)
            ),
          }
        })
      },

      pinConversation: (id) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id ? { ...c, pinned: !c.pinned } : c
          ),
        }))
      },

      reorderConversations: (fromIndex, toIndex) => {
        set(state => {
          const convs = [...state.conversations]
          const [moved] = convs.splice(fromIndex, 1)
          convs.splice(toIndex, 0, moved)
          return { conversations: convs }
        })
      },

      reorderConversationSets: (fromIndex, toIndex) => {
        set(state => {
          const sets = [...state.conversationSets]
          const [moved] = sets.splice(fromIndex, 1)
          sets.splice(toIndex, 0, moved)
          return { conversationSets: sets }
        })
      },

      createConversationSet: (name, cwd) => {
        const id = generateId()
        set(state => ({
          conversationSets: [...state.conversationSets, { id, name: name.trim() || '未命名会话集', cwd, createdAt: Date.now() }],
        }))
        return id
      },

      setConversationSet: (conversationId, setId) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === conversationId ? { ...c, setId: setId || undefined } : c
          ),
        }))
      },

      renameConversationSet: (id, name) => {
        set(state => ({
          conversationSets: state.conversationSets.map(s =>
            s.id === id ? { ...s, name: name.trim() || s.name } : s
          ),
        }))
      },

      deleteConversationSet: (id) => {
        set(state => ({
          conversationSets: state.conversationSets.filter(s => s.id !== id),
          conversations: state.conversations.map(c =>
            c.setId === id ? { ...c, setId: undefined } : c
          ),
        }))
      },

      autoOrganize: () => {
        const { conversations, conversationSets } = get()
        const norm = (cwd?: string) => (cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
        const basename = (dir: string) => dir.split('/').filter(Boolean).pop() || dir
        const sets = [...conversationSets]
        const byName = new Map(sets.map(s => [s.name, s]))
        const updates: Record<string, Conversation> = {}
        let created = 0
        for (const c of conversations) {
          const dir = norm(c.cwd)
          if (!dir) continue
          let s = byName.get(basename(dir))
          if (!s) {
            s = { id: generateId(), name: basename(dir), cwd: dir, createdAt: Date.now() }
            sets.push(s)
            byName.set(s.name, s)
            created++
          }
          if (c.setId !== s.id) updates[c.id] = { ...c, setId: s.id }
        }
        set(state => ({
          conversationSets: sets,
          conversations: state.conversations.map(c => updates[c.id] || c),
        }))
        return created
      },

      mergeImportedChats: (data) => {
        const { conversations, conversationSets } = get()
        const existConv = new Set(conversations.map(c => c.id))
        const existSet = new Set(conversationSets.map(s => s.id))
        const newSets = (data.sets || []).filter(s => !existSet.has(s.id))
        let newConvs = (data.conversations || []).filter(c => !existConv.has(c.id))
        newConvs = newConvs.map(c => ({ ...c, messages: (c.messages || []).slice(-100) }))
        // v2：导入会话无内核 transcript，消息兜底写 ext 分键（每会话一键，不再整串写入）。
        // 上限估算改为 ext 消息体总量，超出按 updatedAt 升序裁剪最旧新会话。
        const LIMIT = 8 * 1024 * 1024
        const extSize = (convs: Conversation[]) => convs.reduce((s, c) => {
          try {
            return s + (c.messages || []).reduce(
              (x, m) => x + (m.content || []).reduce((y, b) => y + (String(b.content || '').length), 0), 0)
          } catch { return s }
        }, 0)
        let merged = newConvs
        let droppedOldest = 0
        let size = extSize(merged)
        const oldestFirst = [...newConvs].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
        while (size > LIMIT && oldestFirst.length > 0) {
          const victim = oldestFirst.shift()!
          merged = merged.filter(c => c.id !== victim.id)
          droppedOldest++
          size = extSize(merged)
        }
        // 写 ext 兜底键（仅新导入会话；transcript 会话不写——消息权威源在内核磁盘）
        for (const c of merged) {
          if (c.messages.length > 0) {
            try { window.localStorage.setItem(EXT_KEY_PREFIX + c.id, JSON.stringify(c.messages)) } catch { /* ignore */ }
          }
        }
        set({
          conversations: [...conversations, ...merged.map(c => ({
            ...c,
            sessionIds: c.sessionIds || (c.sessionId ? [c.sessionId] : undefined),
            messageCount: c.messages.length,
          }))],
          conversationSets: [...conversationSets, ...newSets],
        })
        return { addedConversations: merged.length, addedSets: newSets.length, droppedOldest }
      },

      importLegacyChatState: (json) => {
        try {
          const parsed = JSON.parse(json) as { state?: Record<string, unknown> } | null
          const st = parsed?.state
          if (!st || typeof st !== 'object') return false
          // 仅接管 partialize 白名单字段（整体替换语义与旧版"直写整份文件"一致），
          // 其余动作/瞬时状态（流式、权限弹窗等）不受影响
          const next: Partial<ChatState> = {}
          const arr = (v: unknown) => (Array.isArray(v) ? v : undefined)
          const convs = arr((st as Record<string, unknown>).conversations) as Conversation[] | undefined
          const sets = arr((st as Record<string, unknown>).conversationSets) as ConversationSet[] | undefined
          if (convs) {
            // v2：导入的无 transcript 会话消息兜底写 ext 分键，索引只留元数据
            const mapped = convs.map(c => ({ ...c, messages: (c.messages || []).slice(-100) }))
            for (const c of mapped) {
              if (c.messages.length > 0) {
                try { window.localStorage.setItem(EXT_KEY_PREFIX + c.id, JSON.stringify(c.messages)) } catch { /* ignore */ }
              }
            }
            next.conversations = mapped.map(c => ({
              ...c,
              sessionIds: c.sessionIds || (c.sessionId ? [c.sessionId] : undefined),
              messageCount: c.messages.length,
              messages: [],
            }))
          }
          if (sets) next.conversationSets = sets
          const aId = (st as Record<string, unknown>).activeConversationId
          if (typeof aId === 'string' || aId === null) next.activeConversationId = aId
          const lc = (st as Record<string, unknown>).lastCwd
          if (typeof lc === 'string') next.lastCwd = lc
          set(next)
          // 冲刷导入前挂起的旧快照防抖写，立即以新状态落盘——
          // 否则旧快照会在 600ms 内覆盖掉这次导入
          chatPersistFlush?.()
          return true
        } catch {
          return false
        }
      },

      stopStreaming: (conversationId?: string) => {
        if (!conversationId) {
          set({ streamingConversations: {} })
          return
        }
        set(state => {
          const next = { ...state.streamingConversations }
          delete next[conversationId]
          return { streamingConversations: next }
        })
      },

      // ---- Internal API methods ----

      _addMessage: (conversationId, message) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === conversationId
              ? { ...c, messages: [...asMessages(c.messages), message], updatedAt: Date.now() }
              : c
          ),
        }))
      },

      // 排队插话插入会话序列的指定位置（流式 assistant 消息之前）——插话是
      // 当前任务进行中的补充信息，应位列于该轮回复之前而非序列末端。
      // beforeMessageId 不存在时退化为按 timestamp 二分插入到正确时序位置，
      // 让用户在被接收时能看到自己消息在哪个时序被"插入"，而非全堆在末端。
      _insertMessageBefore: (conversationId, beforeMessageId, message) => {
        set(state => ({
          conversations: state.conversations.map(c => {
            if (c.id !== conversationId) return c
            const msgs = asMessages(c.messages)
            const idx = msgs.findIndex(m => m.id === beforeMessageId)
            if (idx === -1) {
              // 锚点失效（流式消息已结束/被切走）：退化为按 timestamp 时序定位
              const messages = insertByTimestamp(msgs, message)
              return { ...c, messages, updatedAt: Date.now() }
            }
            return {
              ...c,
              messages: [...msgs.slice(0, idx), message, ...msgs.slice(idx)],
              updatedAt: Date.now(),
            }
          }),
        }))
      },

      // 把指定消息移到会话序列末端（用于排队插话按"新轮"处理时的位置校正：
      // 内核已结束当前轮、插话将作为新轮开始，消息应回到末端让新轮回复排在其后）。
      // 已在末端或找不到时无操作。
      _moveMessageToEnd: (conversationId, messageId) => {
        set(state => ({
          conversations: state.conversations.map(c => {
            if (c.id !== conversationId) return c
            const msgs = asMessages(c.messages)
            const idx = msgs.findIndex(m => m.id === messageId)
            if (idx === -1 || idx === msgs.length - 1) return c
            const msg = msgs[idx]
            return {
              ...c,
              messages: [...msgs.slice(0, idx), ...msgs.slice(idx + 1), msg],
              updatedAt: Date.now(),
            }
          }),
        }))
      },

      // 排队插话悬浮态开关：true=内核尚未接收处理（气泡悬浮），false=已接收/超时兜底（落位）
      setMessagePending: (conversationId, messageId, pending) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === conversationId
              ? { ...c, messages: asMessages(c.messages).map(m => (m.id === messageId ? { ...m, pending } : m)) }
              : c
          ),
        }))
      },

      _addStreamingMessage: (conversationId) => {
        const id = generateId()
        const msg: Message = {
          id,
          role: 'assistant',
          content: [],
          timestamp: Date.now(),
        }
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === conversationId
              ? { ...c, messages: [...asMessages(c.messages), msg], updatedAt: Date.now() }
              : c
          ),
          streamingConversations: { ...state.streamingConversations, [conversationId]: id },
        }))
        return id
      },

      _appendStreamingBlock: (messageId, block) => {
        set(state => ({
          conversations: state.conversations.map(c => ({
            ...c,
            messages: asMessages(c.messages).map(m =>
              m.id === messageId
                ? { ...m, content: [...m.content, block] }
                : m
            ),
          })),
        }))
      },

      _updateStreamingBlock: (messageId, blockId, updates, appendText = false) => {
        set(state => ({
          conversations: state.conversations.map(c => ({
            ...c,
            messages: asMessages(c.messages).map(m =>
              m.id === messageId
                ? {
                    ...m,
                    content: m.content.map(b =>
                      // appendText：流式文本/思考块累加（turbo 内核逐 chunk 事件无 id，
                      // 同块多次到达必须拼接而非覆盖，否则只显示最后一个 chunk）
                      b.id === blockId
                        ? appendText && typeof b.content === 'string' && typeof updates.content === 'string'
                          ? { ...b, content: b.content + updates.content } as ContentBlock
                          : { ...b, ...updates } as ContentBlock
                        : b
                    ),
                  }
                : m
            ),
          })),
        }))
      },

      // Re-mark a conversation as streaming without creating a new assistant
      // message — used after the user answers a question card, so subsequent
      // CLI output appends to the existing message and the status shows
      // "执行中" instead of staying idle.
      _resumeStreaming: (conversationId, messageId) => {
        set(state => ({
          streamingConversations: {
            ...state.streamingConversations,
            [conversationId]: messageId,
          },
        }))
      },

      _updateMessageMeta: (messageId, meta) => {
        set(state => ({
          conversations: state.conversations.map(c => ({
            ...c,
            messages: asMessages(c.messages).map(m =>
              m.id === messageId
                ? {
                    ...m,
                    ...(meta.model ? { model: meta.model } : {}),
                    ...(meta.tokensUsed ? { tokensUsed: meta.tokensUsed } : {}),
                  }
                : m
            ),
          })),
        }))
      },

      _finishStreaming: (messageId, usage) => {
        set(state => {
          // Find which conversation owns this streaming message, then clear only that one
          const entry = Object.entries(state.streamingConversations).find(([, mid]) => mid === messageId)
          const convId = entry?.[0]
          const next = { ...state.streamingConversations }
          if (convId) delete next[convId]
          return {
            conversations: state.conversations.map(c => ({
              ...c,
              messages: asMessages(c.messages).map(m =>
                m.id === messageId
                  ? { ...m, tokensUsed: usage.outputTokens }
                  : m
              ),
              // v2 索引：tokensTotal 累计（StatusBar 用，避免遍历消息体）
              ...(c.id === convId ? { tokensTotal: (c.tokensTotal || 0) + (usage.outputTokens || 0) } : {}),
            })),
            streamingConversations: next,
          }
        })
      },

      _updateSessionMeta: (meta) => {
        set(state => {
          const patch: Partial<ChatState> = {}
          if (meta.sessionId !== undefined) {
            patch.sessionId = meta.sessionId
            // The CLI session id is conversation-scoped — needed for per-conversation resume
            if (meta.conversationId) {
              patch.conversations = state.conversations.map(c =>
                c.id === meta.conversationId
                  ? {
                      ...c,
                      sessionId: meta.sessionId as string,
                      // v2 索引：记录该会话经历过的全部内核 sessionId，重启后按需加载 transcript 用
                      sessionIds: [...new Set([...(c.sessionIds || []), meta.sessionId as string])],
                    }
                  : c
              )
            }
          }
          if (meta.model !== undefined) patch.sessionModel = meta.model
          if (meta.tools !== undefined) patch.sessionTools = meta.tools
          if (meta.totalCost !== undefined) patch.sessionCost = meta.totalCost
          if (meta.duration !== undefined) patch.sessionDuration = meta.duration
          return patch
        })
      },

      retryMessage: (conversationId, messageId) => {
        set(state => {
          const conv = state.conversations.find(c => c.id === conversationId)
          if (!conv) return state
          const msgs = asMessages(conv.messages)
          const idx = msgs.findIndex(m => m.id === messageId)
          if (idx === -1) return state
          // Find the user message that came right before this assistant error
          const prevMsg = msgs[idx - 1]
          const userText = (prevMsg?.role === 'user')
            ? prevMsg.content.filter(b => b.type === 'text').map(b => b.content).join('\n')
            : ''
          // Keep messages up to and including this assistant message (so user sees what was retried)
          return {
            conversations: state.conversations.map(c =>
              c.id === conversationId
                ? { ...c, messages: c.messages.slice(0, idx + 1), updatedAt: Date.now() }
                : c
            ),
            streamingConversations: {
              ...state.streamingConversations,
              [conversationId]: state.streamingConversations[conversationId] || '__pending__',
            },
            pendingResend: userText ? { conversationId, text: userText } : null,
          }
        })
      },

      consumePendingResend: () => {
        const val = get().pendingResend
        if (val) set({ pendingResend: null })
        return val ?? null
      },

      editMessage: (conversationId, messageId, newContent) => {
        set(state => {
          const conv = state.conversations.find(c => c.id === conversationId)
          if (!conv) return state
          const msgs = asMessages(conv.messages)
          const idx = msgs.findIndex(m => m.id === messageId)
          if (idx === -1) return state
          // Remove everything from this message onwards, replace with edited
          const editedMsg = { ...msgs[idx], content: newContent, edited: true }
          return {
            conversations: state.conversations.map(c =>
              c.id === conversationId
                ? {
                    ...c,
                    messages: [...asMessages(c.messages).slice(0, idx), editedMsg],
                    updatedAt: Date.now(),
                  }
                : c
            ),
          }
        })
      },

      addPermissionRequest: (request) => {
        set(state => ({ pendingPermissions: [...state.pendingPermissions, request] }))
      },
      resolvePermission: (id, approved) => {
        const byId = get().pendingPermissions.find(p => p.id === id)
        console.log('[permission] resolved:', byId?.action, byId?.target, approved ? 'approved' : 'denied')
        set(state => ({
          pendingPermissions: state.pendingPermissions.filter(p => p.id !== id),
        }))
      },
      clearPermissions: () => set({ pendingPermissions: [] }),

      addBackgroundTask: (task) => {
        set(state => ({ backgroundTasks: [...state.backgroundTasks, task] }))
      },
      updateBackgroundTask: (id, updates) => {
        set(state => ({
          backgroundTasks: state.backgroundTasks.map(t =>
            t.id === id ? { ...t, ...updates } : t
          ),
        }))
      },
      removeBackgroundTask: (id) => {
        set(state => ({
          backgroundTasks: state.backgroundTasks.filter(t => t.id !== id),
        }))
      },

      setPendingQuestion: (conversationId, payload) => {
        set(state => ({
          pendingQuestions: { ...state.pendingQuestions, [conversationId]: payload },
        }))
      },
      clearPendingQuestion: (conversationId) => {
        set(state => {
          if (!conversationId) return { pendingQuestions: {} }
          const next = { ...state.pendingQuestions }
          delete next[conversationId]
          return { pendingQuestions: next }
        })
      },

      setConversationMilestones: (id, total, names) => set(state => {
        const cur = state.conversationProgress[id]
        // 后到的声明不重置已推进进度：current 取 max，保留进行中的里程碑
        const base = cur && cur.total > 0
          ? { ...cur, total, names: Array.isArray(names) ? names : (cur.names || []) }
          : { total, names: Array.isArray(names) ? names : [], current: 0 }
        return {
          conversationProgress: {
            ...state.conversationProgress,
            [id]: base,
          },
        }
      }),

      setMilestoneDone: (id, index) => set(state => {
        const cur = state.conversationProgress[id]
        // 模型先输出 START/OK、后补 MILESTONES 声明（或从不声明）时，
        // 不能静默丢弃：按 index 建缓存进度（total 至少为 index），再推进。
        const base = cur || { total: Math.max(index, 1), names: [], current: 0 }
        // 容忍乱序 check：current 取最大值；index 越界钳制到 total
        const next = Math.max(base.current, Math.min(index, base.total))
        if (next === base.current) return {}
        return {
          conversationProgress: {
            ...state.conversationProgress,
            [id]: { ...base, current: next },
          },
        }
      }),

      setMilestoneStart: (id, index) => set(state => {
        const cur = state.conversationProgress[id]
        // 无现有进度声明时先建缓存（total 至少为 index），START 才不被忽略
        const base = cur || { total: Math.max(index, 1), names: [], current: 0 }
        // index 越界钳制到 total
        const clamped = Math.min(index, base.total)
        if (base.inProgress === clamped) return {}
        return {
          conversationProgress: {
            ...state.conversationProgress,
            [id]: { ...base, inProgress: clamped },
          },
        }
      }),

      upsertSubAgentTask: (conversationId, patch) => set(state => {
        const list = state.subAgentTasks[conversationId] || []
        const idx = list.findIndex(t => t.taskId === patch.taskId)
        if (idx === -1) {
          const task: SubAgentTask = {
            taskId: patch.taskId,
            toolUseId: patch.toolUseId,
            name: patch.name || String(patch.taskId).slice(0, 8),
            status: patch.status || 'running',
            prompt: patch.prompt,
            toolUseCount: patch.toolUseCount ?? 0,
            tokenCount: patch.tokenCount ?? 0,
            durationMs: patch.durationMs ?? 0,
            lastToolName: patch.lastToolName || '',
            activities: patch.activities || [],
            summary: patch.summary,
            outputFile: patch.outputFile,
            error: patch.error,
          }
          return { subAgentTasks: { ...state.subAgentTasks, [conversationId]: [...list, task] } }
        }
        const prev = list[idx]
        const task: SubAgentTask = { ...prev, ...patch, activities: prev.activities }
        // 复活：被超时清理（staleSwept）的 running 任务又收到进度事件 → 恢复 running（防误判兜底）
        if (prev.staleSwept && patch.lastSeenAt) {
          task.status = 'running'
          task.staleSwept = false
          task.summary = undefined
        }
        // 终态幂等：running 进度不覆盖已终态任务；终态通知不覆盖 summary/outputFile 已置的旧值以外的新值
        if (prev.status !== 'running' && patch.status === 'running' && !prev.staleSwept) task.status = prev.status
        // 真终态通知到达 → 清除 staleSwept 标记（内核已正式收尾，不再允许复活）
        if (task.staleSwept && patch.status && patch.status !== 'running') task.staleSwept = false
        if (patch.activities && patch.activities.length > 0) {
          task.activities = [...prev.activities, ...patch.activities].slice(-200)
        }
        const next = [...list]
        next[idx] = task
        return { subAgentTasks: { ...state.subAgentTasks, [conversationId]: next } }
      }),

      clearSubAgentTasks: (conversationId) => set(state => {
        if (!state.subAgentTasks[conversationId]) return {}
        const next = { ...state.subAgentTasks }
        delete next[conversationId]
        return { subAgentTasks: next }
      }),
    }),
    {
      name: 'yfworking-chat',
      storage: resilientChatStorage(),
      version: 2,
      // v1 → v2 迁移（2026-08-17）：消息体剥离（权威源 = 内核 transcript），收集 sessionIds，
      // 旧 41MB 大键备份为 yfworking-chat-v1 供用户确认导出后清理，绝不静默删除。
      migrate: (persisted, version) => {
        if (version === 2) {
          // v2 数据可能因 partialize 不存 messages 而缺字段（旧版写入/损坏），
          // 消毒保证 messages 是数组，避免下游访问崩
          const st = (persisted as any) || {}
          return { ...st, conversations: sanitizeConversations(st.conversations) }
        }
        try {
          const raw = window.localStorage.getItem('yfworking-chat')
          if (raw) window.localStorage.setItem('yfworking-chat-v1', raw)
        } catch { /* ignore */ }
        const st = (persisted as any) || {}
        const convs = Array.isArray(st.conversations) ? st.conversations : []
        const migrated = convs.map((c: any) => {
          const msgs = Array.isArray(c?.messages) ? c.messages : []
          const tokens = msgs.reduce((s: number, m: any) => s + (m?.tokensUsed || 0), 0)
          const sessionIds = [...new Set([
            ...(Array.isArray(c?.sessionIds) ? c.sessionIds : []),
            ...(typeof c?.sessionId === 'string' && c.sessionId ? [c.sessionId] : []),
          ].filter(Boolean))]
          const { messages: _drop, ...rest } = c || {}
          return { ...rest, messages: [], sessionIds, messageCount: msgs.length, tokensTotal: tokens }
        })
        return { ...st, conversations: migrated }
      },
      // 打开应用默认定位到最新会话（updatedAt 最大）——用户明确期望"回到对话时默认到最新会话"。
      // 仅冷启动 rehydrate 时生效；同一运行实例内切后台/切 tab 不触发，不干扰用户当前选择。
      onRehydrateStorage: () => (state) => {
        if (!state || !Array.isArray(state.conversations) || state.conversations.length === 0) return
        // 整个回调体必须推迟到下一宏任务：hydrate 链在 create() 期间同步执行
        // （同步 storage + toThenable），此刻模块级 useChatStore 尚处 TDZ，
        // 直接引用抛 ReferenceError 会被 toThenable 静默吞掉 → 链死亡、消毒失效、
        // hasHydrated 永不置位。数据层消毒兜底在 resilientChatStorage.getItem。
        setTimeout(() => {
          const st = useChatStore.getState()
          // 消毒：rehydrate 后统一保证 messages 是数组（partialize 不存该字段，
          // 旧版/损坏数据可能缺字段，下游 c.messages.length / [...c.messages] 会崩）
          const cleaned = sanitizeConversations(st.conversations)
          if (cleaned !== st.conversations) {
            useChatStore.setState({ conversations: cleaned })
          }
          const newest = cleaned.reduce((a, b) =>
            ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a)
          )
          // 必须用 setState 而非直接改 state 属性：直接赋值不触发订阅者重渲染，
          // Sidebar/ChatWindow 感知不到 activeConversationId 变化，滚动定位不生效
          if (newest.id !== st.activeConversationId) {
            useChatStore.setState({ activeConversationId: newest.id })
          }
          // v2：冷启动只加载激活会话消息（其余按需）
          const act = useChatStore.getState().activeConversationId
          if (act) void useChatStore.getState().ensureConversationLoaded(act)
        }, 0)
      },
      // v2：消息体不再落 localStorage（权威源 = 内核 transcript），只留元数据索引
      partialize: (state) => ({
        conversations: state.conversations.map(c => ({
          id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
          model: c.model, pinned: c.pinned, tags: c.tags, summary: c.summary,
          cwd: c.cwd, sessionId: c.sessionId, agentId: c.agentId, setId: c.setId,
          sessionIds: c.sessionIds,
          messageCount: c.messageCount ?? ((c.messages?.length ?? 0) > 0 ? c.messages.length : undefined),
          tokensTotal: c.tokensTotal,
        })),
        conversationSets: state.conversationSets,
        activeConversationId: state.activeConversationId,
        lastCwd: state.lastCwd,
      }),
    }
  )
)
