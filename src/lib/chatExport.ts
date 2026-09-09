// src/lib/chatExport.ts —— 导出会话（单个/整个会话集）为 zip（自旧 Sidebar.tsx 迁出，Task 10）
// 逻辑与旧模块级 exportChats 完全一致，仅换宿主，供 TaskListPanel 会话/会话集右键导出沿用。
// 注：本模块依赖 zustand store 与 bridge，不属于 node --test 零依赖被测面（chatModeUi 才是）。
import { useChatStore } from '@/stores/chatStore'
import { fetchTranscript } from '@/lib/transcriptLoader'
import type { Conversation, Message } from '@/types'

export interface ChatsFilter {
  conversationIds?: string[]
  setId?: string
}

// dev 模式无 preload 时 window.yfworkingAPI 缺失 → 直接返回（静默）。
// v2：消息体不再在 localStorage——逐会话从内核 transcript 全量读取（tailFirst=0, crop=false，
// 完整消息，非展示级裁剪）组装 chatsJson，与旧导出格式兼容（{ state: { conversations, ... } }）。
export const exportChats = async (chatsFilter?: ChatsFilter) => {
  if (!window.yfworkingAPI) return
  const st = useChatStore.getState()
  const all = st.conversations
  const picked = chatsFilter?.conversationIds
    ? all.filter(c => chatsFilter.conversationIds!.includes(c.id))
    : chatsFilter?.setId
      ? all.filter(c => c.setId === chatsFilter.setId)
      : all
  const withMessages: Conversation[] = []
  for (const c of picked) {
    let messages: Message[] = []
    const ids = c.sessionIds || []
    const parts: Message[][] = []
    for (const sid of ids) {
      const r = await fetchTranscript(sid, c.cwd || '', { tailFirst: false, crop: false })
      if (r.ok) parts.push(r.messages)
    }
    // ext 兜底（导入的无 transcript 会话）合并
    try {
      const raw = window.localStorage.getItem('yfworking-chat-ext-' + c.id)
      if (raw) parts.push(JSON.parse(raw) as Message[])
    } catch { /* ignore */ }
    const flat = parts.flat().sort((a, b) => a.timestamp - b.timestamp)
    const seen = new Set<string>()
    for (const m of flat) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      messages.push(m)
    }
    withMessages.push({ ...c, messages })
  }
  const chatsJson = JSON.stringify({
    state: {
      conversations: withMessages.map(c => ({ ...c, messages: c.messages.slice(-100) })),
      conversationSets: st.conversationSets,
      activeConversationId: st.activeConversationId,
      lastCwd: st.lastCwd,
    },
  })
  window.yfworkingAPI.exportExperience({
    included: ['chats'],
    chatsJson,
    chatsFilter,
    configRedact: true,
  }).then(res => {
    if (!res.ok) { /* 静默或 console.warn：取消时不打扰 */ console.warn('导出取消或失败', res.error) }
  })
}
