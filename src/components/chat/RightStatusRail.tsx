// src/components/chat/RightStatusRail.tsx —— 任务模式右侧折叠状态栏（2026-09-10 UX 重构）
// 仅任务模式挂载（对话模式纯净无栏，WorkShell 按 rail 分支）。收纳此前悬浮在
// 聊天界面上的一族元素，不再遮挡阅读：
//   · 工作目录卡片（固定置顶、不可关闭；折叠态以文件夹图标提示目录是否可用，2026-09-11）
//   · 子 Agent 运行卡片（RunningAgentsBar）
//   · 上下文压缩指示（CompactingBar / CompressedToast / LaneCompactionToast）
//   · 提醒卡片（技能经验待消费 / 极速形态引导 / GPU 兜底）
// 默认折叠收起（2026-09-10：任务工作台以对话为主，状态按需手动展开）：收起为
// 36px 细条（带状态图标：有运行子 agent 或压缩中时亮起），展开 256px 竖栏。
import { useEffect, useState } from 'react'
import { ChevronsRight, ChevronsLeft, Zap, Loader2, AlertTriangle, Info, XCircle, CheckCircle2, Globe, FolderOpen, FolderX, PencilLine } from 'lucide-react'
import { DirectoryPicker } from '@/components/chat/DirectoryPicker'
import { RunningAgentsBar } from './RunningAgentsBar'
import { CompactingBar } from './CompactingBar'
import { CompressedToast } from './CompressedToast'
import { LaneCompactionToast } from './LaneCompactionToast'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWarningStore } from '@/stores/warningStore'
import { useBrowserStore } from '@/stores/browserStore'
import { useDiagStore } from '@/stores/diagStore'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { Tooltip } from '@/components/ui'
import { cn } from '@/lib/utils'

// 一键消费的预设指令：让 agent 按 gxtz-experience-sync 的 Code 流程
// 逐条消费全局经验库的 pending 经验并升级技能（自 WorkShell 迁移，2026-09-10）
const EXPERIENCE_CONSUME_PROMPT = `请执行 gxtz-experience-sync 技能（Code 模式）：
1. 运行 python C:/Users/T203-15/.yfworking/skills/_common/project_context_manager.py skill-loop 查看全局经验库待消费清单；
2. 逐条消费 pending 经验：升级对应技能的 SKILL.md 与 CHANGELOG（逐条回应如何解决、在哪个版本解决）、沉淀技能包 experience.json、标记 status=consumed；
3. 全部完成后按归档流程将已消费经验备份到 _archive 并从全局库移除。
完成后汇报每条的消费结果。`

interface Props { conversationId: string }

export function RightStatusRail({ conversationId }: Props) {
  const { t } = useTranslation()
  // 默认折叠收起（2026-09-10）：状态栏按需手动展开，不常驻占阅读宽度
  const [open, setOpen] = useState(false)
  // 工作目录卡片（2026-09-11）：自聊天面板上方 TaskCwdBar 迁入，固定不可关闭；
  // 更换目录 = 切换工作根：更新会话 cwd 并使会话失效（下次发送以新目录重 spawn）
  const [showDirPicker, setShowDirPicker] = useState(false)
  const cwd = useChatStore(s => s.conversations.find(c => c.id === conversationId)?.cwd || '')
  const changeCwd = (path: string) => {
    const st = useChatStore.getState()
    st.setConversationCwd(conversationId, path)
    st.invalidateSession(conversationId)
    setShowDirPicker(false)
  }
  const { createConversation } = useChatStore()
  const { send, stop, browserControl } = useYFWCLI()

  // —— 提醒卡片状态（自 WorkShell 迁移，2026-09-10） ——
  const [experienceAlert, setExperienceAlert] = useState<{ total: number; bySkill: { skill: string; count: number }[] } | null>(null)
  const [showSpeedModePrompt, setShowSpeedModePrompt] = useState(false)
  const [gpuCrashNotice, setGpuCrashNotice] = useState(false)

  // 低配设备检测 → 极速形态引导（一次性）
  useEffect(() => {
    const s = useSettingsStore.getState().settings
    if (s.speedMode || s.speedModePromptDismissed) return
    const cores = navigator.hardwareConcurrency ?? 8
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8
    if (cores <= 4 || mem <= 4) setShowSpeedModePrompt(true)
  }, [])

  // GPU 进程异常兜底：主进程 child-process-gone → 自动开极速形态 + 12s 提示
  useEffect(() => {
    const win = window.yfworkingWindow
    if (!win?.onGpuCrash) return
    const off = win.onGpuCrash(() => {
      useSettingsStore.getState().updateSettings({ speedMode: true, speedModePromptDismissed: true })
      setGpuCrashNotice(true)
      setTimeout(() => setGpuCrashNotice(false), 12000)
    })
    return () => { off?.() }
  }, [])

  // 主进程推送的技能经验消费提醒
  useEffect(() => {
    const win = window.yfworkingWindow
    if (!win?.onExperienceAlert) return
    const off = win.onExperienceAlert((data) => {
      if (data && data.total > 0) setExperienceAlert(data)
    })
    return () => { off?.() }
  }, [])

  const startExperienceConsume = () => {
    const id = createConversation()
    send(id, EXPERIENCE_CONSUME_PROMPT)
    setExperienceAlert(null)
  }

  const hasReminders = !!(experienceAlert || showSpeedModePrompt || gpuCrashNotice)
  const runningAgents = useChatStore(s =>
    (s.subAgentTasks[conversationId] || []).some(x => x.status === 'running'))
  const compacting = useChatStore(s => s.compactingBySession[conversationId] === true)
  // 提示胶囊收栏（2026-09-10）：等待首字节 + 上下文阈值等系统告警不再悬浮聊天区
  const firstByteWait = useUIStore(s => s.firstByteWait[conversationId] ?? 0)
  const warning = useWarningStore(s => s.warningBySession[conversationId])
  const hasPills = firstByteWait > 0 || !!warning
  // 浏览器自动化状态 + 内核失速 + 诊断错误（2026-09-10 系统化收栏）
  const browserCurrent = useBrowserStore(s => s.current)
  const stallMs = useUIStore(s => s.kernelStalls[conversationId] ?? 0)
  const diagOverall = useDiagStore(s => s.overall)
  const diagErrorCount = useDiagStore(s => s.errorCount)


  // 折叠态状态图标列表（2026-09-10）：每个活跃状态一枚图标 + 悬浮简要内容；
  // 全绿时仅绿色对勾。图标自上而下：严重（红）→ 报警（黄）→ 正常（绿）。
  const statusIcons: { key: string; icon: React.ReactNode; tip: string }[] = []
  if (stallMs > 0) statusIcons.push({ key: 'stall', icon: <XCircle className="w-4 h-4 text-error animate-pulse" />, tip: t('kernelStall.title', { secs: Math.max(1, Math.round(stallMs / 1000)) }) })
  if (diagOverall === 'error' && diagErrorCount > 0) statusIcons.push({ key: 'diag', icon: <XCircle className="w-4 h-4 text-error" />, tip: t('diagnostic.overallError', { n: diagErrorCount }) })
  if (warning?.level === 'budget') statusIcons.push({ key: 'warn-budget', icon: <AlertTriangle className="w-4 h-4 text-error" />, tip: t('warnings.budget', { usd: Number(warning.usd ?? 0).toFixed(4), budgetUsd: Number(warning.budgetUsd ?? 0).toFixed(4) }) })
  if (warning && warning.level !== 'budget') statusIcons.push({ key: 'warn', icon: <AlertTriangle className="w-4 h-4 text-warning" />, tip: warning.message || t('warnings.unknown', { level: warning.level }) })
  if (compacting) statusIcons.push({ key: 'compact', icon: <Zap className="w-4 h-4 text-warning animate-pulse" />, tip: t('compacting.title') })
  if (firstByteWait > 0) statusIcons.push({ key: 'wait', icon: <Loader2 className="w-4 h-4 text-warning animate-spin" />, tip: t('firstByteWait.title', { secs: Math.max(1, Math.round(firstByteWait / 1000)) }) })
  if (browserCurrent) statusIcons.push({ key: 'browser', icon: <Globe className="w-4 h-4 text-brand-500" />, tip: `${t('browser.currentOperation')}${browserCurrent.text ? '：' + browserCurrent.text.slice(0, 60) : ''}` })
  if (runningAgents) statusIcons.push({ key: 'agents', icon: <ChevronsRight className="w-4 h-4 text-warning" />, tip: t('chat.rightRailTitle') + '：子任务运行中' })
  if (hasReminders) statusIcons.push({ key: 'remind', icon: <Zap className="w-4 h-4 text-warning" />, tip: '有待处理提醒' })
  if (statusIcons.length === 0) statusIcons.push({ key: 'ok', icon: <CheckCircle2 className="w-4 h-4 text-success" />, tip: t('chat.rightRailTitle') + '：一切正常' })

  if (!open) {
    return (
      // 折叠态 = 状态图标列（2026-09-10）：绿色正常 / 黄色报警 / 红色严重，
      // 逐级向下排列、各自悬浮简要内容；展开把手统一在顶部。
      <div className="w-9 shrink-0 border-l flex flex-col items-center pt-1.5 gap-1 bg-app">
        <button
          onClick={() => setOpen(true)}
          aria-label={t('chat.rightRailExpand')}
          title={t('chat.rightRailExpand')}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-tertiary hover:text-secondary hover:bg-surface transition-colors"
        >
          <ChevronsLeft className="w-3.5 h-3.5" />
        </button>
        <div className="w-6 h-px bg-border" aria-hidden />
        {/* 固定：工作目录可用图标（2026-09-11，与展开态固定目录卡片对应）——
            品牌色 = 已设置 / 警告色 = 未设置；点击展开状态栏 */}
        <Tooltip
          content={cwd ? `${t('chat.workingDirectory')}：${cwd}` : t('chat.workingDirNotSet')}
          side="left"
        >
          <button
            onClick={() => setOpen(true)}
            aria-label={cwd ? `${t('chat.workingDirectory')}：${cwd}` : t('chat.workingDirNotSet')}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface transition-colors shrink-0"
          >
            {cwd
              ? <FolderOpen className="w-4 h-4 text-brand-500" />
              : <FolderX className="w-4 h-4 text-warning" />}
          </button>
        </Tooltip>
        <div className="w-6 h-px bg-border" aria-hidden />
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-1 pb-2">
          {statusIcons.map(s => (
            <Tooltip key={s.key} content={s.tip} side="left">
              <button
                onClick={() => setOpen(true)}
                aria-label={s.tip}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface transition-colors shrink-0"
              >
                {s.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="w-64 shrink-0 border-l bg-app flex flex-col min-h-0">
      {/* 折叠头 */}
      <div className="h-8 flex items-center justify-between px-2.5 border-b shrink-0">
        <span className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">
          {t('chat.rightRailTitle')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('chat.rightRailCollapse')}
          title={t('chat.rightRailCollapse')}
          className="w-6 h-6 flex items-center justify-center rounded-md text-tertiary hover:text-secondary hover:bg-surface transition-colors"
        >
          <ChevronsRight className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {/* 固定工作目录卡片（2026-09-11：自聊天面板上方 TaskCwdBar 迁入；
            固定置顶、不可关闭——目录是任务工作台的根基，任何时刻可见可换） */}
        <div className="cut-xs brand">
          <div className="ci p-2">
          <div className="flex items-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5 text-brand-500 shrink-0" />
            <span className="text-[11px] font-semibold text-brand-500">{t('chat.workingDirectory')}</span>
          </div>
          <div
            className={cn('text-[11px] font-mono mt-1 truncate', cwd ? 'text-primary' : 'text-warning')}
            title={cwd || t('chat.workingDirNotSet')}
          >
            {cwd || t('chat.workingDirNotSet')}
          </div>
          <button
            onClick={() => setShowDirPicker(true)}
            aria-label={t('chat.changeDirectory')}
            className="mt-1.5 w-full flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-brand-500 bg-brand-500/10 hover:bg-brand-500/20 transition-colors"
          >
            <PencilLine className="w-3 h-3" />
            {t('chat.changeDirectory')}
          </button>
          </div>
        </div>

        {/* 提示胶囊收栏（2026-09-10）：等待首字节 / 上下文阈值等系统告警 */}
        {firstByteWait > 0 && (
          <div className="cut-xs info">
            <div className="ci flex items-center gap-2 p-2 !bg-info/10">
              <Loader2 className="w-3.5 h-3.5 text-info animate-spin shrink-0" />
              <span className="text-[11px] font-medium text-info">
                {t('firstByteWait.title', { secs: Math.max(1, Math.round(firstByteWait / 1000)) })}
              </span>
            </div>
          </div>
        )}
        {warning && (
          <div
            className={cn(
              'cut-xs',
              warning.level === 'budget' ? 'danger' : warning.level === 'context' ? 'warn' : ''
            )}
          >
            <div className={cn(
              'ci flex items-start gap-2 p-2',
              warning.level === 'budget' ? '!bg-error/5' : warning.level === 'context' ? '!bg-warning/5' : '!bg-popover'
            )}>
            {warning.level === 'budget' ? (
              <AlertTriangle className="w-3.5 h-3.5 text-error shrink-0 mt-px" />
            ) : warning.level === 'context' ? (
              <Info className="w-3.5 h-3.5 text-warning shrink-0 mt-px" />
            ) : (
              <Info className="w-3.5 h-3.5 text-tertiary shrink-0 mt-px" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-medium text-primary leading-snug break-words">
                {warning.level === 'budget' && typeof warning.usd === 'number' && typeof warning.budgetUsd === 'number'
                  ? t('warnings.budget', { usd: warning.usd.toFixed(4), budgetUsd: warning.budgetUsd.toFixed(4) })
                  : warning.message || t('warnings.unknown', { level: warning.level })}
              </div>
              {warning.level === 'skill_version' && warning.outdated && warning.outdated.length > 0 && (
                <div className="text-[10px] text-tertiary mt-0.5 break-words">
                  {warning.outdated.map(o => `${o.id}: ${o.lock} → ${o.disk}`).join('；')}
                </div>
              )}
            </div>
            <button
              onClick={() => useWarningStore.getState().dismiss(conversationId)}
              className="text-tertiary hover:text-secondary text-sm leading-none shrink-0"
              aria-label="关闭"
            >
              ×
            </button>
            </div>
          </div>
        )}

        {/* 浏览器自动化状态（2026-09-10 收栏） */}
        {browserCurrent && (
          <div className="cut-xs brand">
            <div className="ci p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0 animate-pulse" />
              <Globe className="w-3.5 h-3.5 text-brand-500 shrink-0" />
              <span className="text-[11px] font-semibold text-brand-500">{t('browser.currentOperation')}</span>
            </div>
            {browserCurrent.text && (
              <div className="text-[11px] text-primary mt-1 break-words">{browserCurrent.text}</div>
            )}
            <div className="flex flex-wrap gap-1 mt-1">
              {browserCurrent.humanMode && (
                <span className="px-1.5 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-[10px] font-semibold text-amber-500">{t('browser.humanMode')}</span>
              )}
              {browserCurrent.imitation && (
                <span className="px-1.5 py-0.5 rounded-full border border-brand-500/30 bg-brand-500/10 text-[10px] font-semibold text-brand-500">{t('browser.imitationMode')}</span>
              )}
            </div>
            <div className="flex gap-1.5 mt-1.5">
              <button
                onClick={() => window.browser?.openWindow(conversationId)}
                className="flex-1 px-1.5 py-1 rounded-md text-[10px] font-medium text-brand-500 bg-brand-500/10 hover:bg-brand-500/20 transition-colors"
              >
                {t('browser.openWindow')}
              </button>
              <button
                onClick={() => browserControl(conversationId, browserCurrent.humanMode ? 'resume' : 'pause')}
                className="flex-1 px-1.5 py-1 rounded-md text-[10px] font-medium text-secondary hover:bg-input transition-colors"
              >
                {browserCurrent.humanMode ? t('browser.resume') : t('browser.pause')}
              </button>
              <button
                onClick={() => useBrowserStore.getState().clear()}
                title={t('browser.dismiss')}
                aria-label={t('browser.dismiss')}
                className="px-1.5 py-1 rounded-md text-[10px] text-tertiary hover:text-secondary hover:bg-input transition-colors"
              >
                ×
              </button>
            </div>
            </div>
          </div>
        )}

        {/* 内核失速守卫（2026-09-10 收栏；红色严重级，带取消/关闭动作） */}
        {stallMs > 0 && (
          <div className="cut-xs danger">
            <div className="ci p-2 !bg-error/5">
            <div className="flex items-start gap-1.5">
              <XCircle className="w-3.5 h-3.5 text-error shrink-0 mt-px" />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium text-error leading-snug">
                  {t('kernelStall.title', { secs: Math.max(1, Math.round(stallMs / 1000)) })}
                </div>
                <div className="flex gap-1.5 mt-1.5">
                  <button
                    onClick={() => {
                      useChatStore.getState().stopStreaming(conversationId)
                      stop(conversationId)
                    }}
                    className="flex-1 px-1.5 py-1 rounded-md text-[10px] font-medium text-error bg-error/10 hover:bg-error/20 transition-colors"
                  >
                    {t('kernelStall.cancel')}
                  </button>
                  <button
                    onClick={() => useUIStore.getState().clearKernelStall(conversationId)}
                    className="flex-1 px-1.5 py-1 rounded-md text-[10px] text-tertiary hover:bg-input transition-colors"
                  >
                    {t('kernelStall.dismiss')}
                  </button>
                </div>
              </div>
            </div>
            </div>
          </div>
        )}

        {/* 诊断错误横幅收栏（2026-09-10）：overall=error 时显示，5s 自动隐去 */}
        {diagOverall === 'error' && diagErrorCount > 0 && (
          <button
            onClick={() => useDiagStore.getState().openDiagnostics()}
            className="cut-xs err w-full text-left transition-colors"
          >
            <span className="ci flex items-center gap-1.5 p-2 !bg-error/5 hover:!bg-error/10">
              <AlertTriangle className="w-3.5 h-3.5 text-error shrink-0" />
              <span className="text-[11px] font-medium text-error">{t('diagnostic.overallError', { n: diagErrorCount })}</span>
            </span>
          </button>
        )}

        {/* 提醒卡片（经验待消费 / 极速引导 / GPU 兜底） */}
        {experienceAlert && (
          <div className="cut-sm warn animate-scale-in">
            <div className="ci p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="text-xs font-semibold text-primary">技能经验待消费</div>
              <button onClick={() => setExperienceAlert(null)} className="text-tertiary hover:text-secondary text-sm leading-none" aria-label="关闭">×</button>
            </div>
            <p className="text-[11px] text-secondary mt-1.5 leading-relaxed">
              全局经验库有 <span className="text-warning font-medium">{experienceAlert.total}</span> 条经验等待消费升级：
              {experienceAlert.bySkill.map(s => ` ${s.skill}（${s.count}条）`).join('、')}。
            </p>
            <button
              onClick={startExperienceConsume}
              className="mt-2 w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium text-brand-500 bg-brand-500/10 hover:bg-brand-500/20 transition-colors"
            >
              <Zap className="w-3 h-3" />
              一键消费
            </button>
            </div>
          </div>
        )}

        {showSpeedModePrompt && (
          <div className="cut-sm animate-scale-in">
            <div className="ci p-3">
            <div className="text-xs font-semibold text-primary">{t('settings.speedModePromptTitle')}</div>
            <p className="text-[11px] text-secondary mt-1 leading-relaxed">{t('settings.speedModePromptBody')}</p>
            <div className="mt-2 flex gap-1.5">
              <button
                onClick={() => { useSettingsStore.getState().updateSettings({ speedMode: true, speedModePromptDismissed: true }); setShowSpeedModePrompt(false) }}
                className="flex-1 px-2 py-1 rounded-md text-[11px] font-medium text-brand-500 bg-brand-500/10 hover:bg-brand-500/20 transition-colors"
              >
                {t('settings.speedModePromptEnable')}
              </button>
              <button
                onClick={() => { useSettingsStore.getState().updateSettings({ speedModePromptDismissed: true }); setShowSpeedModePrompt(false) }}
                className="flex-1 px-2 py-1 rounded-md text-[11px] text-tertiary hover:bg-input transition-colors"
              >
                {t('settings.speedModePromptDismiss')}
              </button>
            </div>
            </div>
          </div>
        )}

        {gpuCrashNotice && (
          <div className="cut-sm warn animate-scale-in">
            <div className="ci p-3">
            <div className="text-xs font-semibold text-primary">{t('settings.gpuCrashNoticeTitle')}</div>
            <p className="text-[11px] text-secondary mt-1 leading-relaxed">{t('settings.gpuCrashNoticeBody')}</p>
            <button
              onClick={() => setGpuCrashNotice(false)}
              className="mt-2 w-full px-2 py-1 rounded-md text-[11px] font-medium text-warning hover:bg-warning/10 transition-colors"
            >
              {t('settings.gpuCrashNoticeOk')}
            </button>
            </div>
          </div>
        )}

        {/* 子 Agent 运行卡片 */}
        <RunningAgentsBar conversationId={conversationId} />

        {/* 上下文压缩指示族 */}
        <CompactingBar conversationId={conversationId} />
        <CompressedToast conversationId={conversationId} />
        <LaneCompactionToast conversationId={conversationId} />
      </div>

      {/* 目录选择器（固定目录卡片入口；DirectoryPicker 自身为 fixed 全屏弹层） */}
      {showDirPicker && (
        <DirectoryPicker value={cwd} onChange={changeCwd} onClose={() => setShowDirPicker(false)} />
      )}
    </div>
  )
}
