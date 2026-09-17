import { Cpu, Wifi, WifiOff, HeartPulse } from 'lucide-react'
import { useEffect } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useDiagStore } from '@/stores/diagStore'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { Tooltip } from '@/components/ui'
import { ApprovalModePicker } from '@/components/layout/ApprovalModePicker'
import { TeamModeSwitch } from '../team/TeamModeSwitch'
import { cn } from '@/lib/utils'

interface StatusItemProps {
  icon: React.ReactNode
  label: string
  value?: string | number
  color?: string
  onClick?: () => void
}

function StatusItem({ icon, label, value, color, onClick }: StatusItemProps) {
  return (
    <Tooltip content={label}>
      <span
        onClick={onClick}
        className={cn(
          // 设计语言：状态栏微标样式（9.5px / .05em 字距 / 等宽数字），语义色由 color prop 覆盖
          'flex items-center gap-1.5 px-2 py-0.5 text-[9.5px] tracking-[.05em] tabular-nums rounded transition-colors select-none',
          onClick && 'cursor-pointer hover:bg-elevated',
          'text-tertiary',
          color
        )}
      >
        {icon}
        {value !== undefined && <span>{value}</span>}
      </span>
    </Tooltip>
  )
}

export function StatusBar() {
  // 逐个 selector 订阅：tokensUsed 只在消息结束时写入，流式 token 更新期间
  // 总和不变 → selector 返回值不变 → 状态栏不会每 token 重渲染
  const backgroundTasks = useChatStore(s => s.backgroundTasks)
  const sessionModel = useChatStore(s => s.sessionModel)
  // 审批档位选择器的目标会话（无活动会话时其内部禁用临时切档）
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const settings = useSettingsStore(s => s.settings)
  const { connected } = useYFWCLI()
  const { t } = useTranslation()
  // 内置 doctor 报警（2026-09-10）：主进程 diag 监视器经 onStatusChanged 推送
  // 快照（首帧主动拉取兜底），本栏最右侧展示正常/警告/严重计数；点击打开诊断面板。
  const snapshot = useDiagStore(s => s.snapshot)
  useEffect(() => {
    window.yfwDiag?.getStatus?.().then(s => useDiagStore.getState().setSnapshot(s)).catch(() => {})
    const off = window.yfwDiag?.onStatusChanged?.((s) => useDiagStore.getState().setSnapshot(s))
    return () => { off?.() }
  }, [])
  const diagWarn = snapshot?.checks?.filter(c => c.status === 'warn').length ?? 0
  const diagErr = snapshot?.checks?.filter(c => c.status === 'error').length ?? 0

  const runningTasks = backgroundTasks.filter(t => t.status === 'running')

  // Active provider name (e.g. "DeepSeek") for the bottom-left model badge
  const providerName = settings.providers.find(p => p.id === settings.activeProvider)?.name

  // Real model from CLI session — show "—" when not yet known
  const displayModel = sessionModel || '—'

  // Bottom-left badge: "[供应商名称]-[模型名称]" once the provider is known
  const modelLabel = providerName ? `${providerName}-${displayModel}` : displayModel

  return (
    <footer className="h-7 flex items-center justify-between px-2 border-t bg-app text-xs shrink-0">
      <div className="flex items-center gap-1">
        <StatusItem
          icon={connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          label={connected ? t('statusBar.connected') : t('statusBar.disconnected')}
          color={connected ? 'text-success' : 'text-error'}
        />
        <StatusItem
          icon={<Cpu className="w-3 h-3" />}
          label={`${t('settings.modelName')}: ${modelLabel}`}
          value={modelLabel}
        />
        {/* 2026-09-10：原第三个图标（Extended Thinking 指示）删除——推理面板已有展示 */}
        {/* 个人 / 团队模式常驻标识（S3 可辨识性）：此前模式只有 header 上 11px 的小按钮一处标识，
            状态栏完全没有 —— 用户在"看列表为空"时无从判断是模式筛掉了还是真的没有。
            与相邻微标同样式（9.5px / gap-1），点击打开同一个下拉菜单。 */}
        <TeamModeSwitch variant="status" />
      </div>

      <div className="flex items-center gap-1">
        {runningTasks.length > 0 && (
          <StatusItem
            icon={<HeartPulse className="w-3 h-3 animate-pulse text-warning" />}
            label={`${runningTasks.length} background task(s)`}
            value={`${runningTasks.length} tasks`}
            color="text-warning"
          />
        )}
        {/* 2026-09-10：token 记录删除（全面转移到驾驶舱），此位由 doctor 报警接管 */}
        {/* 2026-09-12：此处原是**假徽标**——它读 settings.autoApproveBash，而该字段
            全仓库无人写入、也从不发给桥或内核，所以显示什么与真实行为无关（真实行为
            由桥硬编码的 --dangerously-skip-permissions 决定）。现换成真的档位选择器：
            显示以桥上报为准，点击可切本会话临时档（= 需求里"界面下方的 manual 处"）。 */}
        <ApprovalModePicker conversationId={activeConversationId} />
        {/* 内置 doctor 报警（2026-09-10）：正常/警告/严重计数；点击打开诊断面板。
            doctor 功能后续完善后配套更新。 */}
        <StatusItem
          icon={
            <HeartPulse
              className={cn(
                'w-3 h-3',
                diagErr > 0 ? 'text-error' : diagWarn > 0 ? 'text-warning' : 'text-success'
              )}
            />
          }
          label={diagErr > 0
            ? `${diagErr} 项严重 / ${diagWarn} 项警告`
            : diagWarn > 0
              ? `${diagWarn} 项警告`
              : '全部检查正常'}
          value={(diagErr > 0 || diagWarn > 0) ? `${diagErr + diagWarn}` : undefined}
          color={diagErr > 0 ? 'text-error' : diagWarn > 0 ? 'text-warning' : 'text-success'}
          onClick={() => useDiagStore.getState().openDiagnostics()}
        />
      </div>
    </footer>
  )
}
