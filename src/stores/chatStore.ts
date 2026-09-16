import { create } from 'zustand'
import { persist, createJSONStorage, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type { Conversation, Message, ContentBlock, PermissionRequest, BackgroundTask, QuestionPayload, ConversationProgress, SubAgentTask, ConversationSet, LoopState } from '@/types'
import { generateId, sanitizeText, repairCorruptedJson, recoverCorruptedChatState } from '@/lib/utils'
import { appendStreamingBlock } from '@/lib/chatParts'
import { sanitizeConversations, sanitizeKnowledgeSpaces, migrateChatV3 } from '@/lib/chatScopeMigration'
import { getDefaultHome } from '@/lib/config'
import { useHealthStore } from '@/stores/healthStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { loadConversationMessages as loadTranscriptMessages, deleteTranscriptRemote } from '@/lib/transcriptLoader'
import { mergeResyncedMessages } from '@/lib/conversationResync'
import { generateChatTitle, truncateTitle } from '@/lib/titleGen'
import { pushLaneNote as pushLane, dismissLaneNote as dismissLane } from '@/lib/laneUi'
import type { LaneNote } from '@/lib/laneUi'
import type { SessionApprovalMode } from '@/lib/approvalModeUi'

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

// chat 模式自动标题（模型概括）已尝试过的会话——内存级一次性去重，
// 不落盘（标题动作只做一次；titleAuto 标记负责"手动重命名后不再自动覆盖"）。
const autoTitledConversations = new Set<string>()

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
// 每次写入全量序列化（372ms+），是整机卡死根因。参考 deepseek-harness
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

// 会话消毒与 v3→v4 迁移抽到 `@/lib/chatScopeMigration`（2026-09-15）：那是**纯函数**，
// 而本文件有 12 处运行期别名导入 ⇒ 留在 store 里的迁移逻辑永远进不了 `node --test`
// （别名在 Node 原生测试下不可解析）。迁移恰好属于"写错了会静默损坏数据"的一类，
// 必须可单测；本文件只负责调用，接线由 kernel-tests/knowledge-scope-plumbing 静态守卫钉住。
// 历史沿革（消毒中心化的两条修复）记在 chatScopeMigration.ts 的注释里，避免两处各写一半。

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

/** resyncConversation 的结果（纯数据，调用方据此记日志；不抛错） */
export interface ResyncOutcome {
  ok: boolean
  /** ok=false 时的原因：no-conversation | streaming | no-local-messages | empty-transcript | error */
  reason?: 'no-conversation' | 'streaming' | 'no-local-messages' | 'empty-transcript' | 'error'
  /** 屏幕净增行数（可负：本地副本被去重），见 lib/conversationResync */
  netGain?: number
  /** 末尾保留的本地新增条数 */
  keptLocal?: number
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

  // 多轮 loop 进度（S5 ②-05）—— per-conversation, runtime-only (not persisted)
  loopStates: Record<string, LoopState>

  // 压缩进行中标志（S5 ②-02）—— per-conversation, runtime-only (not persisted)
  compactingBySession: Record<string, boolean>

  // 压缩开始时刻（毫秒；缺省 = 未在压缩）——只服务墙钟兜底判定
  //（src/lib/compactIndicator.ts），与 compactingBySession 由 setCompacting 一处同步维护。
  // 组件只读布尔，不读本表：两表并存是刻意的（改布尔语义会静默打断三个 `=== true` 消费者）。
  compactingSinceBySession: Record<string, number>

  // 审批放行档位（2026-09-12）——per-conversation，**权威来源是桥**（approval-mode-changed
  // 上报什么就存什么）。运行时瞬态不持久化：临时覆盖仅内存，应用重启即回落全局档，
  // 这正是用户要的语义（状态栏改的是本会话，设置页改的才是全局）。
  sessionApprovalModes: Record<string, SessionApprovalMode>

  // 子 agent 任务（二级面板数据源，运行时瞬态不持久化）
  subAgentTasks: Record<string, SubAgentTask[]>

  // 子任务压缩提示队列（agentloop lane_compaction）—— per-conversation, runtime-only (not persisted)
  laneNotesBySession: Record<string, LaneNote[]>

  // Actions
  /** 写入桥上报的会话档位；report=null → 删除该会话记录（回落全局档）。
   *  只由 bridge 事件驱动（approval-mode-changed），**不做本地乐观写**：
   *  单权威来源，避免"界面显示 bypass、内核其实还在 loose"的错位。 */
  setSessionApprovalMode: (id: string, report: SessionApprovalMode | null) => void
  // mode 缺省 'task'（全工具现状）；'chat' = 纯聊受限会话（禁本地工具，不绑业务 cwd）
  createConversation: (cwd?: string, agentId?: string, mode?: 'chat' | 'task') => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string) => void
  /** 按需加载会话消息体（内核 transcript + ext 兜底），加载完成注入 messages */
  ensureConversationLoaded: (id: string) => Promise<void>
  /**
   * 断线重连后的会话重同步（2026-09-13「应用自己处理任务断掉了」事故的正面修复）：
   * 以磁盘 transcript 为准重拉一次消息体并合并，补回断线期间丢掉的尾部帧。
   * 与 ensureConversationLoaded 的分工：那个是「内存为空 → 从磁盘装」（evicted/首次打开），
   * 本动作面向「内存里已有、但内容停在断线那一刻」——磁盘比本地多出的尾部只有这里能补。
   */
  resyncConversation: (id: string) => Promise<ResyncOutcome>
  renameConversation: (id: string, title: string) => void
  setConversationCwd: (id: string, cwd: string) => void
  setConversationAgent: (id: string, agentId: string | null) => void
  /** 设置会话知识范围（2026-09-15，P1）：本会话关联的知识库 id 列表（undefined=未关联）。
   *  只写本地状态——透传与"变更后重启内核"由 useYFWCLI 的 spawn 字段 + bridge 的签名比对负责。 */
  setConversationKnowledgeSpaces: (id: string, spaces: string[] | undefined) => void
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
  /** 自动标题（chat/task 通用）：系统自动改写标题（首条消息截断/模型概括），不动 updatedAt（列表不重排） */
  _applyAutoTitle: (conversationId: string, title: string) => void
  _insertMessageBefore: (conversationId: string, beforeMessageId: string, message: Message) => void
  _moveMessageToEnd: (conversationId: string, messageId: string) => void
  setMessagePending: (conversationId: string, messageId: string, pending: boolean) => void
  _addStreamingMessage: (conversationId: string) => string
  _appendStreamingBlock: (messageId: string, block: ContentBlock) => void
  _updateStreamingBlock: (messageId: string, blockId: string, updates: Partial<ContentBlock>) => void
  /** 流式 text/thinking 追加（2026-09-09：替换旧 upsert 整块覆盖语义） */
  _appendStreamingContent: (messageId: string, kind: 'text' | 'thinking', delta: string) => void
  /** 工具结果 live 回填（2026-09-09）：按 toolUseId 找到 tool_use 块挂 result/isError */
  _updateToolResult: (messageId: string, toolUseId: string, result: string, isError: boolean) => void
  _resumeStreaming: (conversationId: string, messageId: string) => void
  _updateMessageMeta: (messageId: string, meta: { model?: string; tokensUsed?: number }) => void
  _finishStreaming: (messageId: string, usage: { inputTokens: number; outputTokens: number }) => void
  _updateSessionMeta: (meta: { conversationId?: string; sessionId?: string; model?: string; tools?: string[]; totalCost?: number; duration?: number }) => void

  addPermissionRequest: (request: PermissionRequest) => void
  /** opts.stale：bridge 回执标明内核已放弃等待（本条未生效）；opts.expired：内核已收口该工具 */
  resolvePermission: (id: string, approved: boolean, opts?: { stale?: boolean; expired?: boolean }) => void
  clearPermissions: () => void
  clearPermissionsForSession: (sessionId: string) => void

  addBackgroundTask: (task: BackgroundTask) => void
  updateBackgroundTask: (id: string, updates: Partial<BackgroundTask>) => void
  removeBackgroundTask: (id: string) => void

  setPendingQuestion: (conversationId: string, payload: QuestionPayload) => void
  clearPendingQuestion: (conversationId?: string) => void

  setConversationMilestones: (conversationId: string, total: number, names: string[]) => void
  setMilestoneDone: (conversationId: string, index: number) => void
  setMilestoneStart: (conversationId: string, index: number) => void
  /** 多轮 loop 进度归约（useYFWCLI event type==='loop' 分支消费；merge 进既有状态） */
  setLoopState: (conversationId: string, patch: Partial<LoopState>) => void
  /** 清除该会话 loop 进度（无键幂等；会话 closed/删除/新 loop 取代前清理） */
  clearLoopState: (conversationId: string) => void
  /** 压缩进行中标志归约（useYFWCLI system/compaction 分支消费）；同值幂等不动作 */
  setCompacting: (conversationId: string, value: boolean) => void

  upsertSubAgentTask: (conversationId: string, patch: Partial<SubAgentTask> & { taskId: string }) => void
  clearSubAgentTasks: (conversationId: string) => void
  pushLaneNote: (conversationId: string, note: LaneNote) => void
  dismissLaneNote: (conversationId: string) => void
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
      loopStates: {},
      compactingBySession: {},
      compactingSinceBySession: {},
      sessionApprovalModes: {},
      subAgentTasks: {},
      laneNotesBySession: {},

      createConversation: (cwd?: string, agentId?: string, mode: 'chat' | 'task' = 'task') => {
        // 新建会话即视为开启全新健康周期：健康状态已按会话隔离存储，
        // 新会话 id 天然无数据（100% 绿），旧会话快照保留供切换回看；
        // 无需全局清空，避免误伤并行会话的健康跟踪。
        const id = generateId()
        const { lastCwd } = get()
        const isChat = mode === 'chat'
        // chat 模式：不显式传 cwd → 会话不绑定业务工作目录（cwd 字段不设，
        // bridge spawn cwd=YFW_HOME 且不 --add-dir），标题先走「新对话」占位文案
        // （首条用户消息到达后由系统改写为内容概括标题，见 titleGen）。
        // task 模式维持现状（lastCwd/home 兜底 + 目录名标题）。
        const dir = isChat
          ? (cwd || '').replace(/\\/g, '/')
          : (cwd || lastCwd || getDefaultHome() || 'C:/').replace(/\\/g, '/')
        const title = isChat && !dir
          ? (useSettingsStore.getState().settings.language === 'zh-CN' ? '新对话' : 'New chat')
          : (dir.split('/').filter(Boolean).pop() || dir)
        const conversation: Conversation = {
          id,
          title,
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          model: 'deepseek-v4-flash',
          mode,
          // 标题由系统自动管理（chat: 占位→内容概括；task: 目录名→内容概括）；
          // 用户手动重命名后置 false（renameConversation），此后不再自动覆盖。
          // 注意：一键整理（autoOrganize）按 cwd 归集，不依赖 title，不受影响
          titleAuto: true,
          ...(dir ? { cwd: dir } : {}),
          agentId: agentId || undefined,
        }
        set(state => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }))
        return id
      },

      deleteConversation: (id) => {
        // v2：删除该会话的 ext 兜底键
        // 2026-09-16：**同时删除磁盘转录**（此前注释写着"transcript 随内核保留，不在此清理"
        // → 用户删了会话，<YFW_HOME>/projects 下的 jsonl 永远留着，本机实测积到 2.3G）。
        const target = get().conversations.find(c => c.id === id)
        try { window.localStorage.removeItem(EXT_KEY_PREFIX + id) } catch { /* ignore */ }
        // 同步清理该会话的健康快照（避免 localStorage 残留陈旧会话数据）
        useHealthStore.getState().reset(id)
        // 磁盘转录文件名 = **内核 sessionId**（conversation.sessionId），不是 GUI 的 conversation.id
        // （两套 id 不同，传 id 只会 not-found）。历史会话可能没有 sessionId → 直接跳过，绝不猜测路径。
        // fire-and-forget：删失败（桥未启动 / 会话仍在运行被桥拒绝 409 / 文件本就不在）都不影响
        // 本地删除，也不打扰用户——所以既不 await 也不上报。
        if (target?.sessionId) {
          void deleteTranscriptRemote(target.sessionId, target.cwd || '').catch(() => {})
        }
        set(state => {
          const filtered = state.conversations.filter(c => c.id !== id)
          const nextActive = state.activeConversationId === id
            ? (filtered[0]?.id || null)
            : state.activeConversationId
          const conversationProgress = { ...state.conversationProgress }
          delete conversationProgress[id]
          const loopStates = { ...state.loopStates }
          delete loopStates[id]
          const compactingBySession = { ...state.compactingBySession }
          delete compactingBySession[id]
          const compactingSinceBySession = { ...state.compactingSinceBySession }
          delete compactingSinceBySession[id]
          const subAgentTasks = { ...state.subAgentTasks }
          delete subAgentTasks[id]
          // 会话级审批覆盖随会话一起消失（内核进程也随会话关闭，桥侧同步清理）
          const sessionApprovalModes = { ...state.sessionApprovalModes }
          delete sessionApprovalModes[id]
          return { conversations: filtered, activeConversationId: nextActive, conversationProgress, loopStates, compactingBySession, compactingSinceBySession, subAgentTasks, sessionApprovalModes }
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
          // 历史回填（chat/task 通用）：标题仍是占位（chat「新对话」/ task「目录名」）
          // 的旧会话，加载成功后用模型把标题升级为内容概括（≤12 字）。每会话仅尝试一次。
          const cNow = get().conversations.find(c => c.id === id)
          const dirBase = (cNow?.cwd || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
          const isPlaceholderTitle = cNow
            ? (cNow.title === '新对话' || cNow.title === 'New chat' || (dirBase !== '' && cNow.title === dirBase))
            : false
          if (
            loaded.length > 0 && cNow
            && cNow.titleAuto !== false
            && !autoTitledConversations.has(id)
            && isPlaceholderTitle
          ) {
            const blockText = (m?: Message) =>
              (m?.content || []).filter((b) => b.type === 'text').map((b) => b.content).join('\n')
            const userText = blockText(loaded.find((m) => m.role === 'user'))
            const asstText = blockText(loaded.find((m) => m.role === 'assistant'))
            void generateChatTitle(userText, asstText).then((title) => {
              autoTitledConversations.add(id)
              if (title) get()._applyAutoTitle(id, title)
            }).catch(() => { /* 静默：保持原标题 */ })
          }
          // 卸载超出驻留上限的会话（保留激活 + 流式），控制内存
          evictLoadedConversations()
        } catch {
          set(state => ({ conversationLoading: { ...state.conversationLoading, [id]: false } }))
        }
      },

      resyncConversation: async (id) => {
        const st = get()
        const conv = st.conversations.find(c => c.id === id)
        if (!conv) return { ok: false, reason: 'no-conversation' }
        // 正在流式的会话由本轮的帧自己收口：此刻合并会与新轮的 _addStreamingMessage /
        // _appendStreamingContent 抢同一个 messages 数组（同刻两条 assistant）
        if (st.streamingConversations[id]) return { ok: false, reason: 'streaming' }
        // 内存里没有消息的会话（已卸载/从未加载）不在这里复活：那是 ensureConversationLoaded
        // 的职责，本动作只补「已有但停在断线那一刻」的视图，避免把卸载策略一脚踢翻
        if ((conv.messages?.length ?? 0) === 0) return { ok: false, reason: 'no-local-messages' }
        // extMessages 传 null（不做 ext 兜底）：拉取失败时 loadTranscriptMessages 返回 []，
        // 合并侧据此原样保留本地视图 —— 绝不允许一次网络失败清屏
        let fromDisk: Message[]
        try {
          fromDisk = await loadTranscriptMessages({ sessionIds: conv.sessionIds, cwd: conv.cwd, extMessages: null })
        } catch {
          // loadTranscriptMessages 自身不抛（fetch 已被它吞成 ok:false），这里只兜编程错误：
          // 重同步是"补救"路径，任何失败都不能反过来伤到已有的本地视图
          return { ok: false, reason: 'error' }
        }
        if (fromDisk.length === 0) return { ok: false, reason: 'empty-transcript' }
        // 拉取期间可能已有新轮开始流式（await 让出了执行权）→ 再判一次；
        // 此后到 set() 之间不允许再有 await，保证「读本地 → 合并 → 写回」是原子的
        if (get().streamingConversations[id]) return { ok: false, reason: 'streaming' }
        const local = get().conversations.find(c => c.id === id)?.messages ?? []
        const { messages, netGain, keptLocal } = mergeResyncedMessages(local, fromDisk)
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id ? { ...c, messages, messageCount: messages.length } : c
          ),
        }))
        return { ok: true, netGain, keptLocal }
      },

      renameConversation: (id, title) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id
              ? { ...c, title, updatedAt: Date.now(), titleAuto: false }
              : c
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

      // 会话知识范围（2026-09-15，P1）：**只动 knowledgeSpaces**（不碰 updatedAt/title ——
      // 关联一次知识库不该把会话顶到列表最前、也不该改标题，那是 cwd/agent 之类"切换语境"
      // 的语义，而关联是"给当前会话加一副眼镜"）。空数组归一为 undefined（见 sanitizeKnowledgeSpaces）。
      setConversationKnowledgeSpaces: (id, spaces) => {
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id ? { ...c, knowledgeSpaces: sanitizeKnowledgeSpaces(spaces) } : c
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

      _applyAutoTitle: (conversationId, title) => {
        if (!title) return
        set(state => ({
          conversations: state.conversations.map(c =>
            // 标题仍为系统托管（titleAuto!==false）时改写；手动重命名后不覆盖
            c.id === conversationId && c.titleAuto !== false
              ? { ...c, title }
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

      // 流式内容追加（2026-09-09 会话 UI 标准化）：内核 wire 是分段增量发射，
      // 旧 upsert 整块替换语义会让屏幕只剩最新片段（"看不到过往输出"根因）。
      // text/thinking 走本 action 追加到同类型最后一块（appendStreamingBlock）。
      _appendStreamingContent: (messageId, kind: 'text' | 'thinking', delta: string) => {
        set(state => ({
          conversations: state.conversations.map(c => ({
            ...c,
            messages: asMessages(c.messages).map(m =>
              m.id === messageId
                ? { ...m, content: appendStreamingBlock(m.content, kind, delta) }
                : m
            ),
          })),
        }))
      },

      _updateToolResult: (messageId, toolUseId, result, isError) => {
        set(state => ({
          conversations: state.conversations.map(c => ({
            ...c,
            messages: asMessages(c.messages).map(m =>
              m.id === messageId
                ? {
                    ...m,
                    content: m.content.map(b =>
                      b.type === 'tool_use' && b.metadata?.toolUseId === toolUseId
                        ? { ...b, result: { content: result, isError } }
                        : b
                    ),
                  }
                : m
            ),
          })),
        }))
      },

      _updateStreamingBlock: (messageId, blockId, updates) => {
        set(state => ({
          conversations: state.conversations.map(c => ({
            ...c,
            messages: asMessages(c.messages).map(m =>
              m.id === messageId
                ? {
                    ...m,
                    content: m.content.map(b =>
                      b.id === blockId ? { ...b, ...updates } as ContentBlock : b
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
        // 首轮回复完成（chat/task 通用）→ 异步升级标题为模型概括（≤12 字）。
        // 非阻塞、失败静默（保留首条消息截断标题）；每会话仅尝试一次。
        {
          const st0 = get()
          const entry0 = Object.entries(st0.streamingConversations).find(([, mid]) => mid === messageId)
          const convId0 = entry0?.[0]
          const conv0 = convId0 ? st0.conversations.find(c => c.id === convId0) : undefined
          if (
            convId0 && conv0 && conv0.titleAuto !== false
            && !autoTitledConversations.has(convId0)
            // 首轮判定：消息体 = 1 user + 1 assistant（resume 旧会话必然 >2，不会误触发）
            && (conv0.messages?.length ?? 0) <= 2
          ) {
            const msgs = asMessages(conv0.messages)
            const blockText = (m?: Message) =>
              (m?.content || []).filter((b) => b.type === 'text').map((b) => b.content).join('\n')
            const userText = blockText(msgs.find((m) => m.role === 'user'))
            const asstText = blockText(msgs.find((m) => m.id === messageId))
            void generateChatTitle(userText, asstText).then((title) => {
              autoTitledConversations.add(convId0)
              if (title) get()._applyAutoTitle(convId0, title)
            }).catch(() => { /* 静默：标题保持首条消息截断值 */ })
          }
        }
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
      resolvePermission: (id, approved, opts) => {
        const byId = get().pendingPermissions.find(p => p.id === id)
        // 日志必须能当证据用（2026-09-12）：此前两处误导——① id 不在待批表时打出
        // "undefined undefined"，看着像身份丢失，实为"已本地收起"或"内核早已放弃"；
        // ② approved 由调用方硬编码 true（approval-resolved 帧此前不带该字段），
        // 使这一行无法区分"真批准"与"过期 no-op"。
        if (!byId) {
          console.log(`[permission] noop: id 不在待批表（${opts?.expired ? '内核已收口' : '已处理过'}）approved=${approved}`)
        } else {
          console.log(
            '[permission] resolved:', byId.action, byId.target, approved ? 'approved' : 'denied',
            opts?.stale ? '(stale：内核已放弃等待，未生效)' : '',
          )
        }
        set(state => ({
          pendingPermissions: state.pendingPermissions.filter(p => p.id !== id),
        }))
      },
      clearPermissions: () => set({ pendingPermissions: [] }),
      // 内核进程终止/取消时的定向清理（T8，2026-09-12）：pendingPermissions 是不
      // 分会话的扁平数组，整表清空会误伤其它仍在跑的会话——那条会话的审批弹窗会
      // 凭空消失、其内核随后等满审批超时才回填，用户以为"点了没反应"。
      clearPermissionsForSession: (sessionId) => set(state => ({
        pendingPermissions: state.pendingPermissions.filter(p => p.sessionId !== sessionId),
      })),

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

      setLoopState: (id, patch) => set(state => {
        const prev = state.loopStates[id]
        // merge 进既有进度；无记录时以默认 inactive 态打底
        const base = prev || { active: false, index: 0, total: 1 }
        return { loopStates: { ...state.loopStates, [id]: { ...base, ...patch } } }
      }),
      clearLoopState: (id) => set(state => {
        if (!state.loopStates[id]) return {} // delete 幂等：无键不动作
        const next = { ...state.loopStates }
        delete next[id]
        return { loopStates: next }
      }),
      setSessionApprovalMode: (id, report) => set(state => {
        const cur = state.sessionApprovalModes[id]
        if (report === null) {
          if (!cur) return {}
          const next = { ...state.sessionApprovalModes }
          delete next[id]
          return { sessionApprovalModes: next }
        }
        // 幂等：同值短路（避免每帧上报产生新引用 → 状态栏无谓重渲染）
        if (cur && cur.mode === report.mode && cur.override === report.override) return {}
        return { sessionApprovalModes: { ...state.sessionApprovalModes, [id]: report } }
      }),

      setCompacting: (id, value) => set(state => {
        // 幂等：同值短路不动作（start 已 true 不重置、done 非 true 不写），
        // 也避免同值重写产生新引用触发无关重渲染
        if ((state.compactingBySession[id] ?? false) === value) return {}
        // 时刻表同步维护（唯一写者）：true 记锚点、false 删键。start 的幂等短路意味着
        // 重复 start **不刷新锚点**——丢 done 后残留的指示只会更早被兜底清掉，不会续命。
        const compactingSinceBySession = { ...state.compactingSinceBySession }
        if (value) compactingSinceBySession[id] = Date.now()
        else delete compactingSinceBySession[id]
        return { compactingBySession: { ...state.compactingBySession, [id]: value }, compactingSinceBySession }
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

      pushLaneNote: (conversationId, note) => set(state => ({
        laneNotesBySession: {
          ...state.laneNotesBySession,
          [conversationId]: pushLane(state.laneNotesBySession[conversationId] || [], note),
        },
      })),

      dismissLaneNote: (conversationId) => set(state => {
        const list = state.laneNotesBySession[conversationId]
        if (!list || list.length === 0) return {}
        const next = dismissLane(list)
        if (next.length === 0) {
          const rest = { ...state.laneNotesBySession }
          delete rest[conversationId]
          return { laneNotesBySession: rest }
        }
        return { laneNotesBySession: { ...state.laneNotesBySession, [conversationId]: next } }
      }),
    }),
    {
      name: 'yfworking-chat',
      storage: resilientChatStorage(),
      version: 4,
      // v1 → v2 迁移（2026-08-17）：消息体剥离（权威源 = 内核 transcript），收集 sessionIds，
      // 旧 41MB 大键备份为 yfworking-chat-v1 供用户确认导出后清理，绝不静默删除。
      // v2 → v3（2026-09-09）：Conversation.mode 字段——旧行 mode undefined → 'task'。
      //   · version===2 分支走 sanitizeConversations（mode 归一在消毒中心化处理）；
      //   · version<2（v1/0/损坏恢复）分支在重建行内补 mode:'task'；
      //   · 已 v3 的行（未来部分回滚写入）经 rehydrate/getItem 消毒同样归一。
      // v3 → v4（2026-09-15）：Conversation.knowledgeSpaces（会话知识范围）——由消毒中心化归一
      //   （v3 分支同样只走 sanitizeConversations）。**刻意不复用下面的 <2 重建分支**：
      //   那个分支按"已剥离的 messages"重算 messageCount/tokensTotal，而 v3 行里这两个值
      //   恰恰是当初算好存下来的，跑一遍就把会话列表的统计清零（迁移只该补新字段，
      //   不该顺手重建）。
      migrate: (persisted, version) => {
        if (version === 3) {
          return migrateChatV3(persisted)
        }
        if (version === 2) {
          // v2 数据可能因 partialize 不存 messages 而缺字段（旧版写入/损坏），
          // 消毒保证 messages 是数组，避免下游访问崩；mode undefined → 'task'（v3）
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
          // v3：旧行无 mode（v1/v0 数据）→ 补 'task'（既有全工具语义）；残留保留
          return { ...rest, mode: (c && c.mode !== undefined) ? c.mode : 'task', messages: [], sessionIds, messageCount: msgs.length, tokensTotal: tokens }
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
          cwd: c.cwd, mode: c.mode, titleAuto: c.titleAuto, sessionId: c.sessionId, agentId: c.agentId, setId: c.setId,
          // 会话知识范围必须进白名单：partialize 是**显式取字段**（非全量展开），漏掉它 =
          // 关联关系永远不落盘，重启应用后静默丢失（表现为"关联过一次，下次打开又没了"）。
          knowledgeSpaces: c.knowledgeSpaces,
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
