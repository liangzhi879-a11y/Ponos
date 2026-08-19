import { Shield, AlertTriangle, Info } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogBody, DialogFooter, Button, Badge,
} from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { sendPermissionResponse } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

const RISK_COLORS = {
  low: 'text-success bg-success/15 border-success/30',
  medium: 'text-warning bg-warning/15 border-warning/30',
  high: 'text-error bg-error/15 border-error/30',
}

// PermissionAction → i18n key；未覆盖的类型回退显示原始 action 名
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

const RISK_KEYS = {
  low: 'permissions.riskLow',
  medium: 'permissions.riskMedium',
  high: 'permissions.riskHigh',
}

export function PermissionDialog() {
  const { pendingPermissions, resolvePermission } = useChatStore()
  const { t } = useTranslation()
  const active = pendingPermissions[0]

  if (!active) return null

  // risk 字段兜底归一化：bridge 各版本/事件形态可能缺失，缺省按 medium 渲染，
  // 避免 RISK_KEYS[undefined] → t(undefined) 渲染崩溃导致权限弹窗不可用
  const risk: 'low' | 'medium' | 'high' =
    active.risk === 'low' || active.risk === 'high' ? active.risk : 'medium'
  const riskColor = RISK_COLORS[risk]
  const actionLabel = t(ACTION_KEYS[active.action] || 'permissions.bash')

  return (
    <Dialog open={!!active} onOpenChange={() => {}}>
      <DialogContent size="sm">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-5 h-5 text-brand-500" />
            <DialogTitle>{t('permissions.title')}</DialogTitle>
          </div>
          <DialogDescription>
            {t('permissions.description')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="space-y-3">
            {/* Action */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-tertiary">{t('permissions.action')}:</span>
              <Badge variant={
                risk === 'high' ? 'danger' :
                risk === 'medium' ? 'warning' : 'info'
              }>
                {actionLabel}
              </Badge>
              <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border', riskColor)}>
                {t(RISK_KEYS[risk])}
              </span>
            </div>

            {/* Target：固定高度，命令过长时内部滚动 */}
            <div>
              <span className="text-xs text-tertiary">{t('permissions.target')}:</span>
              <div className="text-sm text-primary font-mono mt-0.5 bg-elevated rounded-md p-2 h-40 overflow-y-auto whitespace-pre-wrap break-all">
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
                <div className="text-xs text-error">
                  {t('permissions.highRiskWarning')}
                </div>
              </div>
            )}
            {risk === 'medium' && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/15 border border-warning/30">
                <Info className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <div className="text-xs text-warning">
                  {t('permissions.mediumWarning')}
                </div>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (active.sessionId && active.toolUseId) {
                sendPermissionResponse(active.sessionId, active.toolUseId, false)
              }
              resolvePermission(active.id, false)
            }}
          >
            {t('permissions.deny')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (active.sessionId && active.toolUseId) {
                sendPermissionResponse(active.sessionId, active.toolUseId, true)
              }
              resolvePermission(active.id, true)
            }}
          >
            {t('permissions.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
