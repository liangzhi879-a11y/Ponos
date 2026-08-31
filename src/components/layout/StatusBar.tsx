import { Shield, Cpu, Wifi, WifiOff, Activity } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { usePonosCLI } from '@/hooks/usePonosCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { Tooltip } from '@/components/ui'
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
          'flex items-center gap-1.5 px-2 py-0.5 text-xs rounded transition-colors select-none',
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
  // v2：消息体不再常驻内存（按需加载），token 合计改读索引元数据 tokensTotal
  const totalTokens = useChatStore(s => {
    let tokens = 0
    for (const c of s.conversations) tokens += c.tokensTotal || 0
    return tokens
  })
  const settings = useSettingsStore(s => s.settings)
  const { connected } = usePonosCLI()
  const { t } = useTranslation()

  const runningTasks = backgroundTasks.filter(t => t.status === 'running')

  // Active provider name (e.g. "DeepSeek") for the bottom-left model badge
  const providerName = settings.providers.find(p => p.id === settings.activeProvider)?.name

  // Real model from CLI session — show "—" when not yet known
  const displayModel = sessionModel || '—'

  // Bottom-left badge: "[供应商名称]-[模型名称]" once the provider is known
  const modelLabel = providerName ? `${providerName}-${displayModel}` : displayModel

  function formatTokens(n: number): string {
    if (n < 1000) return `${n}`
    if (n < 1000000) return `${(n / 1000).toFixed(0)}K`
    return `${(n / 1000000).toFixed(1)}M`
  }

  // SHADOW 主题：游戏底部操作条（手柄按键风格）
  if (settings.theme === 'shadow') {
    return (
      <footer className="h-9 flex items-center justify-between px-4 border-t bg-app text-xs shrink-0 relative">
        {/* 左：连接/模型/任务 */}
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs select-none',
              connected ? 'text-success bg-success-subtle' : 'text-error bg-error-subtle',
            )}
          >
            {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            <span>{connected ? t('statusBar.connected') : t('statusBar.disconnected')}</span>
          </span>
          <span className="flex items-center gap-1.5 px-2 py-1 rounded-md text-tertiary bg-elevated/50 select-none">
            <Cpu className="w-3 h-3 text-accent-cyan" />
            <span>{modelLabel}</span>
          </span>
          {runningTasks.length > 0 && (
            <span className="flex items-center gap-1.5 px-2 py-1 rounded-md text-warning bg-warning-subtle select-none">
              <Activity className="w-3 h-3 animate-pulse" />
              <span>{runningTasks.length} tasks</span>
            </span>
          )}
        </div>

        {/* 右：数据（TK / Auto-Manual） */}
        <div className="flex items-center gap-4">
          <StatusItem
            icon={<span className="text-[10px] font-mono font-bold text-accent-cyan">TK</span>}
            label={`${t('statusBar.tokens')}: ${totalTokens.toLocaleString()}`}
            value={formatTokens(totalTokens)}
            onClick={useUIStore.getState().openTokenPanel}
          />
          <StatusItem
            icon={<Shield className="w-3 h-3 text-brand-500" />}
            label={`${settings.autoApproveBash ? t('statusBar.autoMode') : t('statusBar.manualMode')}`}
            value={settings.autoApproveBash ? 'Auto' : 'Manual'}
          />
        </div>
      </footer>
    )
  }

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
        {settings.showThinking && (
          <StatusItem
            icon={<Activity className="w-3 h-3 text-brand-500/80" />}
            label="Extended Thinking enabled"
          />
        )}
      </div>

      <div className="flex items-center gap-1">
        {runningTasks.length > 0 && (
          <StatusItem
            icon={<Activity className="w-3 h-3 animate-pulse text-warning" />}
            label={`${runningTasks.length} background task(s)`}
            value={`${runningTasks.length} tasks`}
            color="text-warning"
          />
        )}
        <StatusItem
          icon={<span className="text-[10px] font-mono font-bold text-tertiary">TK</span>}
          label={`${t('statusBar.tokens')}: ${totalTokens.toLocaleString()}`}
          value={formatTokens(totalTokens)}
          onClick={useUIStore.getState().openTokenPanel}
        />
        <StatusItem
          icon={<Shield className="w-3 h-3" />}
          label={`${settings.autoApproveBash ? t('statusBar.autoMode') : t('statusBar.manualMode')}`}
          value={settings.autoApproveBash ? 'Auto' : 'Manual'}
        />
      </div>
    </footer>
  )
}
