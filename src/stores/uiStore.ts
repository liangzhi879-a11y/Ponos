import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

  // Right rail / File view / Token panel
  rightRailOpen: boolean          // 默认 true
  rightRailWidth: number          // 默认 280
  fileViewMode: 'list' | 'grid'   // 默认 'list'
  tokenPanelOpen: boolean         // 默认 false
  toggleRightRail: () => void
  setRightRailWidth: (w: number) => void
  setFileViewMode: (m: 'list' | 'grid') => void
  openTokenPanel: () => void
  closeTokenPanel: () => void

  // Floating editor window rect（x/y 为 -1 表示未初始化，首次打开时自动定位）
  editorRect: { x: number; y: number; w: number; h: number }

  // Sidebar tab
  sidebarTab: 'chats' | 'history' | 'agents' | 'worktrees' | 'skills'

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
  setSidebarTab: (tab: 'chats' | 'history' | 'agents' | 'worktrees' | 'skills') => void

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

  // 定时任务引导：新建"定时任务"会话后，目标会话的 ChatInput 自动弹出引导面板
  scheduleGuideFor: string | null
  setScheduleGuideFor: (id: string | null) => void

  // 内核失速告警（bridge kernel-stall 事件；运行时瞬态不持久化）：
  // sessionId → 已静默毫秒数。有输出（assistant/result）时由 hook 自动清除。
  kernelStalls: Record<string, number>
  setKernelStall: (sessionId: string, silentMs: number) => void
  clearKernelStall: (sessionId: string) => void
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

      rightRailOpen: true,
      rightRailWidth: 280,
      fileViewMode: 'list' as const,
      tokenPanelOpen: false,
      toggleRightRail: () => set(s => ({ rightRailOpen: !s.rightRailOpen })),
      setRightRailWidth: (w) => set({ rightRailWidth: Math.max(200, Math.min(480, w)) }),
      setFileViewMode: (m) => set({ fileViewMode: m }),
      openTokenPanel: () => set({ tokenPanelOpen: true }),
      closeTokenPanel: () => set({ tokenPanelOpen: false }),

      openFiles: [],
      activeFileId: null,
      previewFile: null,

      pendingAttachments: [],
      pendingInput: '',
      pendingAutoSend: false,
      scheduleGuideFor: null,
      kernelStalls: {},

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
      setKernelStall: (sessionId, silentMs) => set(s => ({ kernelStalls: { ...s.kernelStalls, [sessionId]: silentMs } })),
      clearKernelStall: (sessionId) => set(s => {
        if (!(sessionId in s.kernelStalls)) return s
        const kernelStalls = { ...s.kernelStalls }
        delete kernelStalls[sessionId]
        return { kernelStalls }
      }),
      pinnedSkills: [],
      togglePinSkill: (id) => {
        const cur = get().pinnedSkills
        if (cur.includes(id)) {
          set({ pinnedSkills: cur.filter(x => x !== id) })
        } else if (cur.length >= 10) {
          // Cap at 10 — notify the user instead of silently replacing
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('ponos:pin-limit', { detail: { limit: 10 } }))
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
      name: 'ponos-ui',
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        rightRailOpen: state.rightRailOpen,
        rightRailWidth: state.rightRailWidth,
        fileViewMode: state.fileViewMode,
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
