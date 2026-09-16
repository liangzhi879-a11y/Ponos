import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
// 相对导入 + 显式 .ts（同 `conversationResync.ts:26` 的既有写法）：让本文件能被
// `node --test` 直接加载，使 R2 的成本模型（见 uiStore.test.ts）在真实 store 上可测，
// 而不是只能测替身。
import { createStableStorage } from '../lib/stableStorage.ts'
import type { FileTab } from '@/types'

export interface PendingAttachment {
  id: string
  name: string
  path: string
  type: 'file' | 'image'
  content: string
  preview?: string
}

export type ChatSortMode = 'manual' | 'updated' | 'created' | 'title'

interface UIState {
  // Panels
  sidebarOpen: boolean
  editorOpen: boolean
  settingsOpen: boolean
  commandPaletteOpen: boolean
  searchOpen: boolean
  shortcutsHelpOpen: boolean

  // Panel sizes
  sidebarWidth: number

  // Floating editor window rect（x/y 为 -1 表示未初始化，首次打开时自动定位）
  editorRect: { x: number; y: number; w: number; h: number }

  // Sidebar tab
  sidebarTab: 'chats' | 'history' | 'files' | 'agents' | 'worktrees' | 'skills' | 'usage'

  // 会话列表排序模式（persist 白名单持久化）
  chatSortMode: ChatSortMode
  setChatSortMode: (mode: ChatSortMode) => void

  // File viewer
  openFiles: FileTab[]
  activeFileId: string | null
  previewFile: { path: string; name: string } | null

  // Attachments (bridged from FileBrowser → ChatInput)
  pendingAttachments: PendingAttachment[]

  // Frequently-used skills pinned to the top of the skills panel (max 10)
  pinnedSkills: string[]
  togglePinSkill: (id: string) => void

  // Skill category folders — user-organisable, independent of pinning
  skillFolders: string[]
  skillFolderMap: Record<string, string>  // skillId → folderName
  addSkillFolder: (name: string) => void
  removeSkillFolder: (name: string) => void
  renameSkillFolder: (oldName: string, newName: string) => void
  setSkillFolder: (skillId: string, folderName: string) => void

  // Actions
  toggleSidebar: () => void
  toggleEditor: () => void
  openSettings: () => void
  closeSettings: () => void
  openCommandPalette: () => void
  closeCommandPalette: () => void
  openSearch: () => void
  closeSearch: () => void
  openShortcutsHelp: () => void
  closeShortcutsHelp: () => void

  setSidebarWidth: (w: number) => void
  setEditorRect: (rect: { x: number; y: number; w: number; h: number }) => void
  setSidebarTab: (tab: 'chats' | 'history' | 'files' | 'agents' | 'worktrees' | 'skills' | 'usage') => void

  openFile: (file: FileTab) => void
  closeFile: (id: string) => void
  setActiveFile: (id: string) => void
  updateFileContent: (id: string, content: string) => void
  markFileModified: (id: string) => void
  markFileSaved: (id: string) => void

  setPreviewFile: (file: { path: string; name: string } | null) => void

  addPendingAttachment: (att: PendingAttachment) => void
  removePendingAttachment: (id: string) => void
  clearPendingAttachments: () => void
  pendingInput: string
  pendingAutoSend: boolean
  setPendingInput: (text: string, autoSend?: boolean) => void

  // 循环任务引导：新建"循环任务"会话后，目标会话的 ChatInput 自动弹出引导面板
  scheduleGuideFor: string | null
  setScheduleGuideFor: (id: string | null) => void

  // 内核失速告警（S5 ②-05 守卫接线）：conversationId → 静默毫秒。bridge 看门狗
  // 发顶层 kernel-stall 置位、任何内核输出（event/error/cancelled/closed）到达即清
  //（自愈语义，见 useYFWCLI handleMessage）。瞬时态，不入 partialize。
  kernelStalls: Record<string, number>
  setKernelStall: (id: string, ms: number) => void
  clearKernelStall: (id: string) => void

  // 首字节等待提示（2026-09-09 长任务挂起事故）：轮次活跃但内核静默时，桥发
  // system/first_byte_pending（silentMs）。与 kernelStalls 分级：5s 起等待提示、
  // 90s 升级失速告警（升级时桥侧先发 kernel-stall，此处状态被清除）。瞬时态，不入 partialize。
  firstByteWait: Record<string, number>
  setFirstByteWait: (id: string, ms: number) => void
  clearFirstByteWait: (id: string) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      editorOpen: false,
      settingsOpen: false,
      commandPaletteOpen: false,
      searchOpen: false,
      shortcutsHelpOpen: false,

      sidebarWidth: 340,
      editorRect: { x: -1, y: -1, w: 720, h: 480 },

      sidebarTab: 'chats',
      chatSortMode: 'manual',

      openFiles: [],
      activeFileId: null,
      previewFile: null,

      pendingAttachments: [],
      pendingInput: '',
      pendingAutoSend: false,
      scheduleGuideFor: null,
      kernelStalls: {},
      firstByteWait: {},

      toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),
      toggleEditor: () => set(s => ({ editorOpen: !s.editorOpen })),
      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),
      openCommandPalette: () => set({ commandPaletteOpen: true }),
      closeCommandPalette: () => set({ commandPaletteOpen: false }),
      openSearch: () => set({ searchOpen: true }),
      closeSearch: () => set({ searchOpen: false }),
      openShortcutsHelp: () => set({ shortcutsHelpOpen: true }),
      closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),

      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(240, Math.min(500, w)) }),
      setEditorRect: (rect) => set({
        editorRect: {
          x: rect.x,
          y: rect.y,
          w: Math.max(320, Math.min(window.innerWidth, rect.w)),
          h: Math.max(200, Math.min(window.innerHeight, rect.h)),
        },
      }),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      setChatSortMode: (mode) => set({ chatSortMode: mode }),

      openFile: (file) => {
        const existing = get().openFiles.find(f => f.path === file.path)
        if (existing) {
          set({ activeFileId: existing.id, editorOpen: true })
        } else {
          set(s => ({
            openFiles: [...s.openFiles, file],
            activeFileId: file.id,
            editorOpen: true,
          }))
        }
      },
      closeFile: (id) => {
        set(s => {
          const filtered = s.openFiles.filter(f => f.id !== id)
          const nextActive = s.activeFileId === id
            ? (filtered[filtered.length - 1]?.id || null)
            : s.activeFileId
          return {
            openFiles: filtered,
            activeFileId: nextActive,
            // Auto-collapse the editor panel once the last file tab is closed
            editorOpen: filtered.length > 0 ? s.editorOpen : false,
          }
        })
      },
      setActiveFile: (id) => set({ activeFileId: id }),
      updateFileContent: (id, content) => {
        set(s => ({
          openFiles: s.openFiles.map(f =>
            f.id === id ? { ...f, content, modified: content !== f.originalContent } : f
          ),
        }))
      },
      markFileModified: (id) => {
        set(s => ({
          openFiles: s.openFiles.map(f => (f.id === id ? { ...f, modified: true } : f)),
        }))
      },
      markFileSaved: (id) => {
        set(s => ({
          openFiles: s.openFiles.map(f =>
            f.id === id ? { ...f, originalContent: f.content, modified: false } : f
          ),
        }))
      },

      setPreviewFile: (file) => set({ previewFile: file }),

      addPendingAttachment: (att) => set(s => ({
        pendingAttachments: [...s.pendingAttachments, att],
      })),
      removePendingAttachment: (id) => set(s => ({
        pendingAttachments: s.pendingAttachments.filter(a => a.id !== id),
      })),
      clearPendingAttachments: () => set({ pendingAttachments: [] }),
      setPendingInput: (text, autoSend) => set({ pendingInput: text, pendingAutoSend: !!autoSend }),
      setScheduleGuideFor: (id) => set({ scheduleGuideFor: id }),
      // —— R2（2026-09-13）：四条瞬时态 action 一律**在调用 set 之前**短路 ——
      // 在 store action 里 `set(() => ({}))` **不是短路**：zustand 的 persist 把 set 包成
      // 「无条件 setItem」（middleware.js:500-511），返回 {} 照样 partialize+stringify+
      // localStorage.setItem，并且**照样换掉 state 对象引用** ⇒ 整店订阅者白重建一次。
      // 这一组在流式期是每帧 2 次（useYFWCLI.ts:883-884 对每个 event 帧都清一次），
      // 实测刷屏的正是同一批 `[WS] recv: event … assistant` 帧（13–45 帧/秒）。
      setKernelStall: (id, ms) => {
        if (get().kernelStalls[id] === ms) return // 同值不动作（倒计时重挂/重放帧）
        set(s => ({ kernelStalls: { ...s.kernelStalls, [id]: ms } }))
      },
      clearKernelStall: (id) => {
        if (!(id in get().kernelStalls)) return // delete 幂等：无键**根本不调 set**
        set(s => {
          const next = { ...s.kernelStalls }
          delete next[id]
          return { kernelStalls: next }
        })
      },
      setFirstByteWait: (id, ms) => {
        if (get().firstByteWait[id] === ms) return
        set(s => ({ firstByteWait: { ...s.firstByteWait, [id]: ms } }))
      },
      clearFirstByteWait: (id) => {
        if (!(id in get().firstByteWait)) return
        set(s => {
          const next = { ...s.firstByteWait }
          delete next[id]
          return { firstByteWait: next }
        })
      },
      pinnedSkills: [],
      togglePinSkill: (id) => {
        const cur = get().pinnedSkills
        if (cur.includes(id)) {
          set({ pinnedSkills: cur.filter(x => x !== id) })
        } else if (cur.length >= 10) {
          // Cap at 10 — notify the user instead of silently replacing
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('yfworking:pin-limit', { detail: { limit: 10 } }))
          }
        } else {
          set({ pinnedSkills: [...cur, id] })
        }
      },

      // Skill folder state — Working / Coding + user custom folders
      skillFolders: ['Working', 'Coding'],
      skillFolderMap: {},
      addSkillFolder: (name) => {
        const trimmed = name.trim()
        if (!trimmed) return
        set(s => {
          if (s.skillFolders.includes(trimmed)) return s
          return { skillFolders: [...s.skillFolders, trimmed] }
        })
      },
      removeSkillFolder: (name) => {
        set(s => {
          // Reassign skills in this folder to "Working"
          const newMap = { ...s.skillFolderMap }
          for (const [skillId, folder] of Object.entries(newMap)) {
            if (folder === name) newMap[skillId] = 'Working'
          }
          return {
            skillFolders: s.skillFolders.filter(f => f !== name),
            skillFolderMap: newMap,
          }
        })
      },
      renameSkillFolder: (oldName, newName) => {
        const trimmed = newName.trim()
        if (!trimmed || oldName === trimmed) return
        set(s => {
          if (s.skillFolders.includes(trimmed)) return s  // name already taken
          const newMap = { ...s.skillFolderMap }
          for (const [skillId, folder] of Object.entries(newMap)) {
            if (folder === oldName) newMap[skillId] = trimmed
          }
          return {
            skillFolders: s.skillFolders.map(f => f === oldName ? trimmed : f),
            skillFolderMap: newMap,
          }
        })
      },
      setSkillFolder: (skillId, folderName) => {
        set(s => ({
          skillFolderMap: { ...s.skillFolderMap, [skillId]: folderName },
        }))
      },
    }),
    {
      name: 'yfworking-ui',
      // R2：zustand 对每次 set 都无条件 setItem（连只改白名单外键的也算）。这层把
      // 「序列化结果与上次逐字节相同」的写入挡掉——白名单外键（瞬时态/编辑器内容等）
      // 变化时不再付 stringify + localStorage 同步写。
      storage: createStableStorage(createJSONStorage(() => localStorage)),
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        editorRect: state.editorRect,
        sidebarTab: state.sidebarTab,
        chatSortMode: state.chatSortMode,
        pinnedSkills: state.pinnedSkills,
        skillFolders: state.skillFolders,
        skillFolderMap: state.skillFolderMap,
      }),
    }
  )
)
