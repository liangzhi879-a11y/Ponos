import { Shield, AlertTriangle, Info } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogBody, DialogFooter, Button, Badge,
} from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { sendPermissionResponse } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { APPROVAL_MODE_OPTIONS } from '@/lib/approvalModeUi'
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
  // 浏览器白名单加白申请（2026-09-10）
  browser_whitelist_add: 'permissions.browserWhitelistAdd',
}

const RISK_KEYS = {
  low: 'permissions.riskLow',
  medium: 'permissions.riskMedium',
  high: 'permissions.riskHigh',
}

export function PermissionDialog() {
  const { pendingPermissions, resolvePermission, activeConversationId } = useChatStore()
  const { t } = useTranslation()
  // 当前会话的审批优先（2026-09-12）：pendingPermissions 是不分会话的扁平数组，
  // 直接取 [0] 会让别的会话/后台通道的审批顶到最前——用户看到一条与自己当前进度
  // 无关的弹窗（"审批与会话进度不一致"的成因之一）。**只排序不隐藏**：隐藏会让
  // 那里真正在等待的审批找不到人签，内核只能干等到超时，比显示错序更糟。
  const active = pendingPermissions.find(p => p.sessionId === activeConversationId) ?? pendingPermissions[0]
  // 并发计数：多个审批同时在等时，收起当前这条不能让人以为"批完了"（后到的仍在阻塞）
  const others = active ? pendingPermissions.filter(p => p.id !== active.id).length : 0
  const othersOtherSessions = active
    ? pendingPermissions.filter(p => p.id !== active.id && p.sessionId !== activeConversationId).length
    : 0

  if (!active) return null

  // risk 字段兜底归一化：bridge 各版本/事件形态可能缺失，缺省按 medium 渲染，
  // 避免 RISK_KEYS[undefined] → t(undefined) 渲染崩溃导致权限弹窗不可用
  const risk: 'low' | 'medium' | 'high' =
    active.risk === 'low' || active.risk === 'high' ? active.risk : 'medium'
  const riskColor = RISK_COLORS[risk]
  const actionLabel = t(ACTION_KEYS[active.action] || 'permissions.bash')
  // 灾难级硬黑名单（2026-09-12）：内核在四档下都会问，这里必须让人一眼看懂：
  // ① 这不是普通高危（可能毁盘/毁系统）；② 放行**只对本次执行**有效、绝不记忆
  //   （桥回传 decisionClassification:'user_temporary'，没有"总是允许"）。
  // 因此按钮文案也从「同意」改成「本次放行」——"同意"听起来像记住选择。
  const hard = active.hard === true
  const modeLabel = active.mode
    ? t(APPROVAL_MODE_OPTIONS.find(o => o.value === active.mode)?.labelKey ?? 'approvalMode.loose')
    : ''

  return (
    <Dialog open={!!active} onOpenChange={() => {}}>
      <DialogContent size="sm">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            {hard
              ? <AlertTriangle className="w-5 h-5 text-error" />
              : <Shield className="w-5 h-5 text-brand-500" />}
            <DialogTitle className={cn(hard && 'text-error')}>
              {hard ? t('approvalMode.dialogHardTitle') : t('permissions.title')}
            </DialogTitle>
          </div>
          <DialogDescription>
            {hard ? t('approvalMode.dialogHardBody') : t('permissions.description')}
            {modeLabel && <span className="block mt-0.5 text-[10px] text-tertiary">{t('approvalMode.dialogModeHint', { mode: modeLabel })}</span>}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="space-y-3">
            {/* 灾难级警示条：置于目标区域之**上**（先警告后看内容），红色不可滚动 */}
            {hard && (
              <div className="cut-xs danger">
                <div className="ci flex items-start gap-2 p-3 !bg-error/20">
                  <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                  <div className="text-xs text-error space-y-1">
                    <p className="font-medium">{t('approvalMode.hardTitle')}</p>
                    <p className="text-[11px] leading-snug opacity-90">{t('approvalMode.hardList')}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Action */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-tertiary">{t('permissions.action')}:</span>
              <Badge variant={
                hard || risk === 'high' ? 'danger' :
                risk === 'medium' ? 'warning' : 'info'
              }>
                {actionLabel}
              </Badge>
              <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border', riskColor)}>
                {t(RISK_KEYS[risk])}
              </span>
            </div>

            {/* 并发审批计数：多个审批同时在等时，收起当前这条不等于批完了 */}
            {others > 0 && (
              <p className="text-[11px] text-tertiary" data-testid="permission-pending-others">
                {t('permissions.pendingOthers', { count: others })}
                {othersOtherSessions > 0 && t('permissions.pendingOthersCross', { count: othersOtherSessions })}
              </p>
            )}

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

            {/* Risk warning（灾难级已在上方单独警示，不重复刷屏） */}
            {risk === 'high' && !hard && (
              <div className="cut-xs danger">
                <div className="ci flex items-start gap-2 p-3 !bg-error/15">
                  <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                  <div className="text-xs text-error">
                    {t('permissions.highRiskWarning')}
                  </div>
                </div>
              </div>
            )}
            {risk === 'medium' && (
              <div className="cut-xs warn">
                <div className="ci flex items-start gap-2 p-3 !bg-warning/15">
                  <Info className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                  <div className="text-xs text-warning">
                    {t('permissions.mediumWarning')}
                  </div>
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
            variant={hard ? 'danger' : 'primary'}
            size="sm"
            onClick={() => {
              if (active.sessionId && active.toolUseId) {
                sendPermissionResponse(active.sessionId, active.toolUseId, true)
              }
              resolvePermission(active.id, true)
            }}
          >
            {/* 灾难级：文案必须是「本次放行」——「同意」容易被读成"以后都同意" */}
            {hard ? t('approvalMode.dialogAllowOnce') : t('permissions.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
