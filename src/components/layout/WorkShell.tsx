// src/components/layout/WorkShell.tsx —— 工作屏三段式外壳（Task 9）
// 由 ViewRouter 在 view==='work' 分支挂载（原 AppShell 全量迁入本文件：经验提醒/
// 极速引导/GPU 通知/快捷键/右侧通知卡堆叠/StatusBar/全部 overlays 原样保留）。
// 布局（task-9 brief Step 3）：
//   <Header onGoCockpit>                    —— logo 点击 → morph 回驾驶舱
//   rail 列(48px, RailNav) + 二级面板宿主(240px, SecondPanel) + 中心聊天列(flex-1)
//   <StatusBar/> + 右下提示卡 + Settings/CommandPalette/…overlays
// 变更点 vs AppShell：
//   · Sidebar 渲染与 toggle 移除（rail 常驻替代旧侧栏；Sidebar 文件退役由后续任务处理）；
//   · ⌘B 快捷键取消绑定（原 toggleSidebar），保留注释说明 rail 已常驻；
//   · 主题 effect 已在 Task 6 上移 ViewRouter，此处不再有。
import { useEffect, useCallback, useState } from 'react'
import { Header } from './Header'
import { RailNav } from './RailNav'
import { SecondPanel } from './SecondPanel'
import { AgentsPanel } from '@/components/agents/AgentsPanel'
import { SkillsPanel } from '@/components/skills/SkillsPanel'
import { WorkflowsPanel } from '@/components/workflows/WorkflowsPanel'
import { AppsPanel } from '@/components/apps/AppsPanel'
import { StatusBar } from './StatusBar'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { ChatInput } from '@/components/chat/ChatInput'
import { FloatingQuestionCard } from '@/components/chat/FloatingQuestionCard'
import { RightStatusRail } from '@/components/chat/RightStatusRail'
import { TaskStartCard } from '@/components/rail/TaskStartCard'
import { FilePreview } from '@/components/files/FilePreview'
import { SettingsView } from '@/components/settings/SettingsView'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { DiagnosticPanel } from '@/components/diagnostic/DiagnosticPanel'
import { PermissionDialog } from '@/components/permissions/PermissionDialog'
import { SearchDialog } from '@/components/search/SearchDialog'
import { ShortcutsHelp } from '@/components/shortcuts/ShortcutsHelp'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useViewStore } from '@/stores/viewStore'
import { sendAnswer, dismissQuestion, useYFWCLI } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'

export interface WorkShellProps {
  /** Header 品牌 logo 点击 → 返回驾驶舱（2026-09-10 morph 退役：直切，无需 rect） */
  onGoCockpit?: () => void
}

export function WorkShell({ onGoCockpit }: WorkShellProps) {
  const { t } = useTranslation()
  const rail = useViewStore(s => s.workState.rail)
  const { activeConversationId, createConversation, pendingQuestions, clearPendingQuestion } = useChatStore()
  const conversations = useChatStore(s => s.conversations)

  // 2026-09-10 主标签化：chat/task 是两个独立标签页——切 tab 时若当前活动会话
  // 模式不匹配，自动激活该模式最近会话；该模式无会话则保持不动，中心由
  // displayConvId 判空显示对应空态。
  useEffect(() => {
    const st = useChatStore.getState()
    const key = rail === 'chat' ? 'chat' : 'task'
    const cur = st.conversations.find(c => c.id === st.activeConversationId)
    if (cur && (cur.mode ?? 'task') === key) return
    const target = st.conversations.find(c => (c.mode ?? 'task') === key)
    if (target) st.setActiveConversation(target.id)
  }, [rail])

  // 中心列只显示与当前 rail 模式匹配的活动会话（不匹配 → 该标签空态）
  const displayConvId = (() => {
    const cur = conversations.find(c => c.id === activeConversationId)
    if (!cur) return null
    const key = rail === 'chat' ? 'chat' : 'task'
    return (cur.mode ?? 'task') === key ? activeConversationId : null
  })()
  const pendingQuestion = displayConvId ? pendingQuestions[displayConvId] : undefined
  const { previewFile, setPreviewFile } = useUIStore()

  // 低配引导/GPU 兜底/经验提醒均已迁入 RightStatusRail（2026-09-10 右侧折叠状态栏）

  // 后台/最小化时暂停全部 CSS 动画：webPreferences.backgroundThrottling 已关闭
  // （保证 WS 心跳/任务完成通知后台可靠），但动画在后台仍会全速跑白烧 GPU——
  // 旧显卡上尤其明显。document.hidden 时给 html 挂 anim-paused 类，
  // 由 globals.css 统一 animation-play-state: paused（JS 定时器不受影响）。
  useEffect(() => {
    const root = document.documentElement
    const onVis = () => root.classList.toggle('anim-paused', document.hidden)
    onVis()
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // 原生编辑器窗口拖动/缩放后回传边界 → 同步 uiStore.editorRect 缓存（下次打开沿用）
  useEffect(() => {
    const win = window.yfworkingWindow
    if (!win?.onEditorSyncBounds) return
    const off = win.onEditorSyncBounds((rect) => {
      if (rect && typeof rect.x === 'number') useUIStore.getState().setEditorRect(rect)
    })
    return () => { off?.() }
  }, [])

  // Global keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // 【2026-09-11】预热期守卫：WorkShell 会在驾驶舱可见时被空闲预挂载（hidden），
    // 此时仍挂在 window 上的监听器不得生效——只有 work 视图才响应全局快捷键，
    // 避免在驾驶舱/启动屏按 ⌘K/⌘N 误触发主界面动作。
    if (useViewStore.getState().view !== 'work') return
    const mod = e.metaKey || e.ctrlKey

    // Command palette
    if ((mod && e.key === 'k') || (mod && e.shiftKey && e.key === 'P')) {
      e.preventDefault()
      useUIStore.getState().openCommandPalette()
      return
    }

    // Settings（2026-09-10：独立设置窗口）
    if (mod && e.key === ',') {
      e.preventDefault()
      window.yfworkingWindow?.openUtility?.('settings')
      return
    }

    // New conversation
    if (mod && e.key === 'n') {
      e.preventDefault()
      useChatStore.getState().createConversation()
      return
    }

    // ⌘B（旧 toggleSidebar）已取消绑定（Task 9）：rail 常驻，不再有可切换的侧边栏。

    // Search
    if (mod && e.shiftKey && e.key === 'F') {
      e.preventDefault()
      useUIStore.getState().openSearch()
      return
    }

    // Focus chat
    if (e.key === '/' && !mod && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault()
      document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
      return
    }

    // Shortcuts help
    if (e.key === '?' && !mod && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      useUIStore.getState().openShortcutsHelp()
      return
    }
  }, [])

  // Register keyboard listener
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // 注：主题落盘 / 主题变量 / --chat-font / glass vars / speed-mode / html-body 背景
  // 两个 effect 已上移到 ViewRouter.tsx（Task 6）——login/boot/cockpit 也要吃主题系统，
  // WorkShell 只在 work 分支挂载，原有位置会让登录屏缺主题变量。
  return (
    <div
      className="h-full flex flex-col bg-app text-primary relative window-frame"
      style={{ boxShadow: 'var(--shadow-window, none)' }}
    >
      {/* Header —— logo 点击 → morph 回驾驶舱（ViewRouter onGoCockpit 接线） */}
      <Header onGoCockpit={onGoCockpit} />

      {/* 三段式主体：rail 列(48px 常驻主标签栏) + 右侧内容页。
          rail 即主标签栏：chat/task 渲染「二级面板(240px)+中心聊天列」，
          agents/skills 渲染全主界面卡片浏览（2026-09-10 主标签化）——右侧内容
          页随 rail 切换整片进入对应标签，不再常驻聊天列。 */}
      <div className="flex-1 flex min-h-0">
        <RailNav />
        {rail === 'agents' ? (
          <AgentsPanel />
        ) : rail === 'skills' ? (
          <SkillsPanel />
        ) : rail === 'workflows' ? (
          // Task 13：第五 rail —— 工作流列表 ⇄ 画布编辑器（占满 work 区，不经 SecondPanel）
          <WorkflowsPanel />
        ) : rail === 'apps' ? (
          // 第六 rail：应用智控（Task 1.6 卡片列表 + 新增；控制台在 AppsPanel 内部切换）
          <AppsPanel />
        ) : (
          <>
        <SecondPanel />

        {/* Center content：只渲染与当前 rail 模式匹配的会话（2026-09-10 主标签化） */}
        <div className="flex-1 flex flex-col min-w-0">
          {displayConvId ? (
            <>
              {/* 两种模式分开（2026-09-10）：chat = 纯净对话（无目录条、无右侧状态栏）；
                  task = 工作台（工作目录收敛到右侧状态栏顶部固定卡片，折叠态以
                  文件夹图标提示目录是否已设置；欢迎页 logo 下方亦有目录入口，
                  2026-09-11 自聊天面板上方 TaskCwdBar 迁出） */}
              <div className="flex-1 flex min-h-0">
                <div className="flex-1 min-w-0 flex flex-col">
                  <ChatWindow conversationId={displayConvId} />
                </div>
                {rail === 'task' && <RightStatusRail conversationId={displayConvId} />}
              </div>
              {pendingQuestion && (
                // 2026-09-10 悬浮折叠：默认收成 chip，展开态 max-h 内滚，
                // 不再内联占满消息可视区
                <FloatingQuestionCard
                  conversationId={displayConvId}
                  // 新问题到达（载荷对象替换）时强制重挂载，清空旧卡的选择/备注状态，
                  // 避免自动生成的 q1..qN id 与旧卡重叠导致 allAnswered 被旧选中项满足
                  cardKey={`${displayConvId}:${pendingQuestion.questions.map(q => `${q.id}|${q.question.slice(0, 24)}`).join('&') || 'raw'}`}
                  payload={pendingQuestion}
                  onAnswer={(response) => {
                    sendAnswer(displayConvId, response.answers, response.notes)
                    clearPendingQuestion(displayConvId)
                  }}
                  onDismiss={() => {
                    clearPendingQuestion(displayConvId)
                    // 通知桥接端广播“提问已处理”，嘉嘉等外部监听者撤销提问提示
                    dismissQuestion(displayConvId)
                  }}
                />
              )}
              <ChatInput conversationId={displayConvId} />
            </>
          ) : rail === 'task' ? (
            // 任务标签空态：起始卡片（目录选择必选 + 新建任务，2026-09-10；
            // 会话标签保持无目录选择的现状）
            <TaskStartCard />
          ) : (
            <div className="flex-1 flex items-center justify-center text-tertiary">
              <div className="text-center">
                <p className="text-lg">{t('chat.welcomeTitle')}</p>
                <p className="text-sm mt-1 text-tertiary">{t('chat.emptyHint')}</p>
              </div>
            </div>
          )}
        </div>
          </>
        )}
      </div>

      {/* Status bar */}
      <StatusBar />

      {/* Overlays（2026-09-10：设置面板已外置独立窗口，SettingsView 不再挂主窗口） */}
      <CommandPalette />
      <DiagnosticPanel />
      <PermissionDialog />
      <SearchDialog />
      <ShortcutsHelp />
      {previewFile && (
        <FilePreview
          path={previewFile.path}
          name={previewFile.name}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}
