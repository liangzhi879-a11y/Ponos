// src/components/module/windows/ApprovalModule.tsx
// 审批模块窗口（?module=approval）：全局独立审批窗口。
// 审批到达时由主进程自动打开（StateBus approval 监听 → windowManager.open('approval')）。
// 本窗口自持 WS 连接（usePonosCLI），直接监听内核 approval 事件并响应
// sendPermissionResponse，不依赖其他窗口转发——每个窗口独立 JS realm，WS 独立。
// 处理完最后一个审批后自动关闭窗口。
import { useEffect } from 'react'
import { Shield, AlertTriangle, Info } from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { usePonosCLI, sendPermissionResponse } from '@/hooks/usePonosCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { closeModule } from '@/lib/moduleBridge'
import { cn } from '@/lib/utils'

const RISK_COLORS = {
  low: 'text-success bg-success/15 border-success/30',
  medium: 'text-warning bg-warning/15 border-warning/30',
  high: 'text-error bg-error/15 border-error/30',
}

const ACTION_KEYS: Record<string, string> = {
  file_read: 'permissions.fileRead',
  file_write: 'permissions.fileWrite',
  file_edit: 'permissions.fileWrite',
  bash: 'permissions.bash',
  web_search: 'permissions.webSearch',
  web_fetch: 'permissions.webSearch',
  notebook_edit: 'permissions.fileWrite',
  skill: 'permissions.bash',
  mcp: 'permissions.bash',
}

const RISK_KEYS = { low: 'permissions.riskLow', medium: 'permissions.riskMedium', high: 'permissions.riskHigh' }

/** 审批独立窗口：自持 WS 接收审批事件，展示审批卡，处理后自动关窗。 */
export function ApprovalModule() {
  const { pendingPermissions, resolvePermission } = useChatStore()
  const { t } = useTranslation()
  // 建立 WS 连接：本窗口独立收 approval 事件（写 chatStore.pendingPermissions）
  usePonosCLI()
  const active = pendingPermissions[0]

  // 全部审批处理完 → 自动关闭审批窗口
  useEffect(() => {
    if (pendingPermissions.length === 0) {
      void closeModule('approval')
    }
  }, [pendingPermissions.length])

  if (!active) return null

  const risk: 'low' | 'medium' | 'high' =
    active.risk === 'low' || active.risk === 'high' ? active.risk : 'medium'
  const riskColor = RISK_COLORS[risk]
  const actionLabel = t(ACTION_KEYS[active.action] || 'permissions.bash')

  const respond = (approved: boolean) => {
    if (active.sessionId && active.toolUseId) {
      sendPermissionResponse(active.sessionId, active.toolUseId, approved)
    }
    resolvePermission(active.id, approved)
  }

  return (
    <div className="h-full w-full flex flex-col bg-app text-primary overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-subtle shrink-0">
        <Shield className="w-5 h-5 text-brand-500" />
        <span className="text-sm font-semibold text-primary">{t('permissions.title')}</span>
        <span className="text-xs text-tertiary ml-auto">
          {pendingPermissions.length > 1 && `${pendingPermissions.length} ${t('permissions.pending')}`}
        </span>
      </div>

      {/* 审批卡主体 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="space-y-3">
          {/* Action */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-tertiary">{t('permissions.action')}:</span>
            <Badge variant={risk === 'high' ? 'danger' : risk === 'medium' ? 'warning' : 'info'}>
              {actionLabel}
            </Badge>
            <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border', riskColor)}>
              {t(RISK_KEYS[risk])}
            </span>
          </div>

          {/* Target：命令/路径，可滚动 */}
          <div>
            <span className="text-xs text-tertiary">{t('permissions.target')}:</span>
            <div className="text-sm text-primary font-mono mt-0.5 bg-elevated rounded-md p-2 h-32 overflow-y-auto whitespace-pre-wrap break-all">
              {active.target}
            </div>
          </div>

          {/* Details */}
          {active.details && (
            <div>
              <span className="text-xs text-tertiary">{t('permissions.details')}:</span>
              <p className="text-sm text-tertiary mt-0.5">{active.details}</p>
            </div>
          )}

          {/* Risk warning */}
          {risk === 'high' && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-error/15 border border-error/30">
              <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              <div className="text-xs text-error">{t('permissions.highRiskWarning')}</div>
            </div>
          )}
          {risk === 'medium' && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/15 border border-warning/30">
              <Info className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <div className="text-xs text-warning">{t('permissions.mediumWarning')}</div>
            </div>
          )}
        </div>
      </div>

      {/* 操作区 */}
      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-subtle bg-toolbar/50 shrink-0">
        <Button variant="ghost" size="sm" onClick={() => respond(false)}>
          {t('permissions.deny')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => respond(true)}>
          {t('permissions.approve')}
        </Button>
      </div>
    </div>
  )
}
