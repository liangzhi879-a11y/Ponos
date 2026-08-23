import { useEffect, useCallback, useState } from 'react'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { ChatInput } from '@/components/chat/ChatInput'
import QuestionCard from '@/components/chat/QuestionCard'
import { FilePreview } from '@/components/files/FilePreview'
import { SettingsView } from '@/components/settings/SettingsView'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { DiagnosticPanel } from '@/components/diagnostic/DiagnosticPanel'
import { DiagnosticBanner } from '@/components/diagnostic/DiagnosticBanner'
import { PermissionDialog } from '@/components/permissions/PermissionDialog'
import { SearchDialog } from '@/components/search/SearchDialog'
import { ShortcutsHelp } from '@/components/shortcuts/ShortcutsHelp'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { sendAnswer, dismissQuestion, usePonosCLI } from '@/hooks/usePonosCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { THEME_CLASS_NAMES, THEMES } from '@/types'

// 一键消费的预设指令：让 agent 按 gxtz-experience-sync 的 Code 流程
// 逐条消费全局经验库的 pending 经验并升级技能
const EXPERIENCE_CONSUME_PROMPT = `请执行 gxtz-experience-sync 技能（Code 模式）：
1. 运行 python C:/Users/T203-15/.ponos/skills/_common/project_context_manager.py skill-loop 查看全局经验库待消费清单；
2. 逐条消费 pending 经验：升级对应技能的 SKILL.md 与 CHANGELOG（逐条回应如何解决、在哪个版本解决）、沉淀技能包 experience.json、标记 status=consumed；
3. 全部完成后按归档流程将已消费经验备份到 _archive 并从全局库移除。
完成后汇报每条的消费结果。`

export function AppShell() {
  const { t } = useTranslation()
  const { activeConversationId, createConversation, pendingQuestions, clearPendingQuestion } = useChatStore()
  const { send } = usePonosCLI()
  // 技能经验消费提醒：主进程启动时检测到 pending 积压会推送
  const [experienceAlert, setExperienceAlert] = useState<{ total: number; bySkill: { skill: string; count: number }[] } | null>(null)
  // 低配设备检测 → 极速形态引导提示（一次性，可关闭/不再提示）
  const [showSpeedModePrompt, setShowSpeedModePrompt] = useState(false)
  // GPU 进程异常（驱动重置/崩溃）→ 自动开启极速形态 + 通知条
  const [gpuCrashNotice, setGpuCrashNotice] = useState(false)
  const pendingQuestion = activeConversationId ? pendingQuestions[activeConversationId] : undefined
  const { sidebarOpen, sidebarWidth, previewFile, setPreviewFile } = useUIStore()
  const { settings } = useSettingsStore()

  // Create initial conversation if needed
  useEffect(() => {
    if (!activeConversationId) {
      createConversation()
    }
  }, [])

  // 启动时低配设备检测：CPU 核心 ≤4 或内存 ≤4GB → 引导开启极速形态。
  // 仅在未开启极速形态且未点过"不再提示"时弹一次；检测结果不写入设置。
  useEffect(() => {
    const s = useSettingsStore.getState().settings
    if (s.speedMode || s.speedModePromptDismissed) return
    const cores = navigator.hardwareConcurrency ?? 8
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8
    if (cores <= 4 || mem <= 4) setShowSpeedModePrompt(true)
  }, [])

  // GPU 进程异常兜底：主进程 child-process-gone 通知 → 自动开启极速形态
  // （关全部动画/特效），防止驱动重置后的恢复阶段再次把图形负载压垮。
  // 通知条 12s 后自动消失；关闭按钮在 UI 底部。
  useEffect(() => {
    const win = window.ponosWindow
    if (!win?.onGpuCrash) return
    const off = win.onGpuCrash(() => {
      useSettingsStore.getState().updateSettings({ speedMode: true, speedModePromptDismissed: true })
      setGpuCrashNotice(true)
      setTimeout(() => setGpuCrashNotice(false), 12000)
      // 通知条生命周期与本次崩溃提示一致，无需在卸载时清理 timer
    })
    return () => { off?.() }
  }, [])

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

  // 监听主进程推送的技能经验消费提醒
  useEffect(() => {
    const win = window.ponosWindow
    if (!win?.onExperienceAlert) return
    const off = win.onExperienceAlert((data) => {
      if (data && data.total > 0) setExperienceAlert(data)
    })
    return () => { off?.() }
  }, [])

  // 原生编辑器窗口拖动/缩放后回传边界 → 同步 uiStore.editorRect 缓存（下次打开沿用）
  useEffect(() => {
    const win = window.ponosWindow
    if (!win?.onEditorSyncBounds) return
    const off = win.onEditorSyncBounds((rect) => {
      if (rect && typeof rect.x === 'number') useUIStore.getState().setEditorRect(rect)
    })
    return () => { off?.() }
  }, [])

  // 一键消费：新建会话并自动发送消费指令
  const startExperienceConsume = useCallback(() => {
    const id = createConversation()
    send(id, EXPERIENCE_CONSUME_PROMPT)
    setExperienceAlert(null)
  }, [createConversation, send])

  // Global keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey

    // Command palette
    if ((mod && e.key === 'k') || (mod && e.shiftKey && e.key === 'P')) {
      e.preventDefault()
      useUIStore.getState().openCommandPalette()
      return
    }

    // Settings
    if (mod && e.key === ',') {
      e.preventDefault()
      useUIStore.getState().openSettings()
      return
    }

    // New conversation
    if (mod && e.key === 'n') {
      e.preventDefault()
      useChatStore.getState().createConversation()
      return
    }

    // Toggle sidebar
    if (mod && (e.key === 'b')) {
      e.preventDefault()
      useUIStore.getState().toggleSidebar()
      return
    }

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

  // 主题落盘给主进程：下次启动据此决定透明窗口与否（仅 glass 需真透明）。
  // 独立 effect（仅依赖 theme）：原来混在下方样式 effect 里，fontSize/玻璃/极速
  // 等任一设置变化都会连带触发主进程同步写盘（滑块拖动会连发）。
  useEffect(() => {
    const themeMode = THEMES.find(t => t.id === settings.theme)?.mode ?? 'dark'
    window.ponosWindow?.saveTheme?.(settings.theme, themeMode)
  }, [settings.theme])

  // Theme + chat font
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove(...THEME_CLASS_NAMES)
    root.classList.add(`theme-${settings.theme}`)
    root.style.setProperty('--chat-font', settings.fontSize + 'px')
    // Glass 主题设置：透光度变量 + 色调偏移 + 光晕动画开关（非 glass 主题无效果，不产生副作用）
    root.style.setProperty('--glass-opacity', String(settings.glassOpacity))
    root.style.setProperty('--glass-hue-shift', settings.glassHueShift + 'deg')
    root.classList.toggle('glass-aurora-off', !settings.glassAurora)
    // 极速形态：关闭全部动效/毛玻璃/光晕/阴影（任意主题下生效）
    root.classList.toggle('speed-mode', settings.speedMode)
    // 必须同时覆盖 html 与 body 背景：index.html 的内联防闪白样式
    // 给 html 设置了不透明背景 #171109，body 透明后它会露出并挡住窗口透明合成，
    // 导致桌面无法透出（glass 主题下两处都应透明，其余主题为各自背景色）。
    document.documentElement.style.background = 'var(--bg-app)'
    document.body.style.background = 'var(--bg-app)'
    document.body.style.color = 'var(--text-primary)'
  }, [settings.theme, settings.fontSize, settings.glassOpacity, settings.glassHueShift, settings.glassAurora, settings.speedMode])

  return (
    <div
      className="h-full flex flex-col bg-app text-primary relative window-frame"
      style={{ boxShadow: 'var(--shadow-window, none)' }}
    >
      {/* Header */}
      <Header />

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        {sidebarOpen && (
          <div
            className="h-full flex-shrink-0 animate-slide-left"
            style={{ width: sidebarWidth }}
          >
            <Sidebar />
          </div>
        )}

        {/* Center content */}
        <div className="flex-1 flex flex-col min-w-0">
          {activeConversationId ? (
            <>
              <ChatWindow conversationId={activeConversationId} />
              {pendingQuestion && (
                <div className="px-3 flex justify-center">
                  <QuestionCard
                    // 新问题到达（载荷对象替换）时强制重挂载，清空旧卡的选择/备注状态，
                    // 避免自动生成的 q1..qN id 与旧卡重叠导致 allAnswered 被旧选中项满足
                    key={`${activeConversationId}:${pendingQuestion.questions.map(q => `${q.id}|${q.question.slice(0, 24)}`).join('&') || 'raw'}`}
                    payload={pendingQuestion}
                    onAnswer={(response) => {
                      sendAnswer(activeConversationId, response.answers, response.notes)
                      clearPendingQuestion(activeConversationId)
                    }}
                    onDismiss={() => {
                      clearPendingQuestion(activeConversationId)
                      // 通知桥接端广播“提问已处理”，嘉嘉等外部监听者撤销提问提示
                      dismissQuestion(activeConversationId)
                    }}
                  />
                </div>
              )}
              <ChatInput conversationId={activeConversationId} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-tertiary">
              <div className="text-center">
                <p className="text-lg">{t('chat.welcomeTitle')}</p>
                <p className="text-sm mt-1 text-tertiary">{t('chat.emptyHint')}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右下角提示卡堆叠容器：经验提醒/极速引导/GPU 兜底三个弹窗统一纵向堆叠，
          避免同时出现时三者同位置重叠遮挡（各自可独立关闭） */}
      <div className="fixed bottom-12 right-4 z-[90] w-80 flex flex-col gap-3">
      {/* 技能经验消费提醒条：pending 积压提示 + 一键消费 */}
      {experienceAlert && (
        <div
          className="border rounded-xl p-4 animate-scale-in"
          style={{
            background: 'var(--popover-bg)',
            borderColor: 'var(--border-subtle)',
            boxShadow: 'var(--shadow-modal)',
            backdropFilter: 'blur(var(--popover-blur))',
            WebkitBackdropFilter: 'blur(var(--popover-blur))',
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-semibold text-primary">技能经验待消费</div>
            <button
              onClick={() => setExperienceAlert(null)}
              className="text-tertiary hover:text-secondary text-lg leading-none"
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <p className="text-xs text-secondary mt-1.5 leading-relaxed">
            全局经验库有 <span className="text-warning font-medium">{experienceAlert.total}</span> 条经验等待消费升级：
            {experienceAlert.bySkill.map(s => ` ${s.skill}（${s.count}条）`).join('、')}。
          </p>
          <button
            onClick={startExperienceConsume}
            className="mt-3 w-full py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
            style={{ background: 'linear-gradient(135deg, #ff6a00, #ff8c33)' }}
          >
            一键发起消费升级
          </button>
        </div>
      )}

      {/* 低配设备检测 → 极速形态引导（一次，可关闭/不再提示） */}
      {showSpeedModePrompt && (
        <div
          className="border rounded-xl p-4 animate-scale-in"
          style={{
            background: 'var(--popover-bg)',
            borderColor: 'var(--border-subtle)',
            boxShadow: 'var(--shadow-modal)',
            backdropFilter: 'blur(var(--popover-blur))',
            WebkitBackdropFilter: 'blur(var(--popover-blur))',
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-semibold text-primary">{t('settings.speedModePromptTitle')}</div>
            <button
              onClick={() => setShowSpeedModePrompt(false)}
              className="text-tertiary hover:text-secondary text-lg leading-none"
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <p className="text-xs text-secondary mt-1.5 leading-relaxed">
            {t('settings.speedModePromptBody')}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => {
                useSettingsStore.getState().updateSettings({ speedMode: true, speedModePromptDismissed: true })
                setShowSpeedModePrompt(false)
              }}
              className="flex-1 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
              style={{ background: 'linear-gradient(135deg, var(--brand-500), var(--brand-600))' }}
            >
              {t('settings.speedModePromptEnable')}
            </button>
            <button
              onClick={() => setShowSpeedModePrompt(false)}
              className="px-3 py-1.5 rounded-lg text-xs text-secondary border border-subtle hover:bg-surface transition-colors"
            >
              {t('settings.speedModePromptLater')}
            </button>
          </div>
          <button
            onClick={() => {
              useSettingsStore.getState().updateSettings({ speedModePromptDismissed: true })
              setShowSpeedModePrompt(false)
            }}
            className="mt-2 text-[10px] text-tertiary hover:text-secondary underline underline-offset-2"
          >
            {t('settings.speedModePromptNever')}
          </button>
        </div>
      )}

      {/* GPU 进程异常自动兜底提示（自动开启极速形态后展示，12s 自动消失） */}
      {gpuCrashNotice && (
        <div
          className="border rounded-xl p-4 animate-scale-in"
          style={{
            background: 'var(--popover-bg)',
            borderColor: 'var(--border-subtle)',
            boxShadow: 'var(--shadow-modal)',
            backdropFilter: 'blur(var(--popover-blur))',
            WebkitBackdropFilter: 'blur(var(--popover-blur))',
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-semibold text-primary">{t('settings.gpuCrashNoticeTitle')}</div>
            <button
              onClick={() => setGpuCrashNotice(false)}
              className="text-tertiary hover:text-secondary text-lg leading-none"
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <p className="text-xs text-secondary mt-1.5 leading-relaxed">
            {t('settings.gpuCrashNoticeBody')}
          </p>
          <button
            onClick={() => setGpuCrashNotice(false)}
            className="mt-3 w-full py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
            style={{ background: 'linear-gradient(135deg, var(--brand-500), var(--brand-600))' }}
          >
            {t('settings.gpuCrashNoticeOk')}
          </button>
        </div>
      )}
      </div>

      {/* Status bar */}
      <StatusBar />

      {/* Overlays */}
      <SettingsView />
      <CommandPalette />
      <DiagnosticPanel />
      <DiagnosticBanner />
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
