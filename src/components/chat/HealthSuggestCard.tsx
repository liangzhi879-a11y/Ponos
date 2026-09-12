// src/components/chat/HealthSuggestCard.tsx
import { useState } from 'react'
import { Minimize2 } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useHealthStore } from '@/stores/healthStore'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { distortionOf, shouldShowDistortionAlert, anchorTextFrom, isRecurred, distortionSuppressKey, type DistortionAxis } from '@/lib/healthUi'
import { Button } from '@/components/ui'

/** 轴标签 key 用字面量映射（保证 t() 的 key 是字面量类型，避免动态拼接失去类型检查） */
const AXIS_LABEL_KEY = {
  memory: 'health.distortion.axis.memory',
  coherence: 'health.distortion.axis.coherence',
  goal: 'health.distortion.axis.goal',
} as const

const AXIS_ORDER: DistortionAxis[] = ['memory', 'coherence', 'goal']
/** 卡片最多逐条展示的证据数（更多则折叠为"另有 N 条更早证据"） */
const MAX_EVIDENCE_ROWS = 5

/** 主证据轴：三轴取分最高者（卡片标题据此说明"哪一类失真"） */
function primaryAxis(axes: Record<DistortionAxis, number>): DistortionAxis {
  let best: DistortionAxis = 'memory'
  let bestScore = -1
  for (const a of AXIS_ORDER) {
    const s = axes?.[a] ?? 0
    if (s > bestScore) { bestScore = s; best = a }
  }
  return best
}

/** 上下文失真时的"证据清单 + 两级动作"卡片（非模态）。

 *  **被测量是失真不是压力**：弹卡只由 distortion.tier=red 触发（压力档降级为血条仪表，
 *  不再触发任何弹窗）。amber 只点亮血条角标，不打扰用户。
 *  conversationId=当前查看的会话：失真判断/证据去抖/冷却/摘要均按会话隔离。
 *  onStopSource：仅"新建会话"时调用（停止源会话任务）；重新锚定不停会话。
 *  onAnchorApplied：锚定生效上报（Task 7 上行到内核标记证据 resolved）。
 *  最小化：折叠为右下角警示小胶囊（不动 dismiss 冷却，随时可展开恢复）；
 *  关闭（dismiss）：进入冷却，冷却期内不再显示。 */
export function HealthSuggestCard({ conversationId, onStopSource, onAnchorApplied }: {
  conversationId: string
  onStopSource?: () => void
  onAnchorApplied?: (issueIds: string[]) => void
}) {
  const { t } = useTranslation()
  const health = useHealthStore(s => s.healthBySession[conversationId]) ?? null
  const summary = useHealthStore(s => s.summaryBySession[conversationId]) ?? ''
  const dismissedUntil = useHealthStore(s => s.dismissedDistortionUntilBySession[conversationId]) ?? 0
  const shownIds = useHealthStore(s => s.distortionShownIdsBySession[conversationId])
  const markDistortionShown = useHealthStore(s => s.markDistortionShown)
  const dismissDistortion = useHealthStore(s => s.dismissDistortion)
  const [carrySummary, setCarrySummary] = useState(true)
  // 最小化：折叠为右下角警示小胶囊（仅状态点 + 标题），点击恢复展开卡片。
  // 与 dismiss 不同：不动 dismissedUntil 冷却，随时可展开。
  const [minimized, setMinimized] = useState(false)
  // 重新锚定预览（null=未展开）：锚点内容可编辑后再发送
  const [anchorPreview, setAnchorPreview] = useState<string | null>(null)

  const distortion = distortionOf(health)

  if (!health || !shouldShowDistortionAlert(health, dismissedUntil, shownIds ?? [])) return null

  const issues = distortion.issues
  const anchorText = anchorTextFrom(health)
  const recurred = isRecurred(distortion)
  const title = `${t('health.distortion.redTitle', { n: issues.length })} · ${t(AXIS_LABEL_KEY[primaryAxis(distortion.axes)])}`
  const visible = issues.slice(0, MAX_EVIDENCE_ROWS)
  const moreCount = Math.max(0, issues.length - visible.length)

  /** 该展示抑制键（复发态用独立键）——处理/关闭后登记，避免同一证据反复弹卡。 */
  const suppressKey = distortionSuppressKey(distortion) ?? distortion.trigger

  /**
   * 已处理：只**按证据键抑制**，不设时间冷却。
   * 时间冷却留给显式「关闭」——否则处理后 5 分钟内新出现的、不同的失真会被静默吞掉，
   * 而红档意味着上下文已失真，静默等于让会话带着错误继续跑。
   */
  const markHandled = () => {
    if (suppressKey) markDistortionShown(conversationId, suppressKey)
  }

  /** 显式关闭：按证据键抑制 + 进入冷却（用户明确表示"别再打扰我一会儿"）。 */
  const handleDismiss = () => {
    if (suppressKey) markDistortionShown(conversationId, suppressKey)
    dismissDistortion(conversationId)
  }

  /** 轻动作：把权威事实重新灌回上下文（走可见 user 消息注入，可编辑可回溯） */
  const confirmReanchor = () => {
    const text = (anchorPreview ?? anchorText).trim()
    if (text) useUIStore.getState().setPendingInput(text, true)
    onAnchorApplied?.(issues.map(x => x.id))
    markHandled()
  }

  /** 重动作：新建会话并携带锚点（锚点在前）+ 摘要 */
  const handleNewSession = () => {
    const { conversations, activeConversationId, createConversation } = useChatStore.getState()
    const current = conversations.find(c => c.id === activeConversationId)
    // 先停源会话任务（源会话仍在运行）：停止内核流式并清理前端流式状态，
    // 避免它继续吞上下文；再新建会话携带锚点/摘要，源会话保持只读可回溯。
    onStopSource?.()
    createConversation(undefined, current?.agentId)
    const parts = [anchorText, carrySummary ? summary : ''].filter(Boolean)
    if (parts.length) {
      // autoSend=false：让新会话输入框先显示"将要发送的锚点+摘要"，由用户确认后发送
      useUIStore.getState().setPendingInput(parts.join('\n\n'), false)
    }
    markHandled()
  }

  const detail = t('health.distortion.evidenceCount', { n: issues.length })

  // 最小化：警示小胶囊（2026-09-10 修复：同 bottom-full 锚点，悬浮输入框上方）
  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        title={`${t('health.restore')} · ${detail}`}
        className="absolute bottom-full right-2 mb-2 z-50 flex items-center gap-2 max-w-[300px] rounded-full border bg-popover/95 px-3 py-1.5 shadow-2xl backdrop-blur animate-slide-up"
        style={{ borderColor: 'color-mix(in srgb, var(--health-tier-red) 28%, transparent)' }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 animate-pulse"
          style={{ background: 'var(--health-tier-red)' }}
        />
        <span className="text-[11px] font-medium text-primary truncate">
          {title}
        </span>
      </button>
    )
  }

  return (
    <div
      // 2026-09-10 修复：锚定 ChatInput 根（relative）的 bottom-full——悬浮在
      // 聊天区底部、输入框上方，不占布局高度（聊天窗口高度不受挤压）、不叠输入条
      // （此前 in-flow 版占位导致聊天窗卡在卡片上缘；fixed 版叠住发送键）
      // 2026-09-11 设计语言统一：rounded-xl+语义色 border → cut-sm danger 切角 +
      // 语义色细边（--health-tier-red 与 --error 四主题同值），磨砂底走 ci
      className="absolute bottom-full right-2 mb-2 z-40 w-[360px] max-w-[calc(100vw-2rem)] cut-sm danger animate-slide-up"
      style={{ filter: 'drop-shadow(var(--modal-drop))' }}
    >
      <div className="ci p-3" style={{ backdropFilter: 'blur(var(--popover-blur))', WebkitBackdropFilter: 'blur(var(--popover-blur))' }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium" style={{ color: 'var(--health-tier-red)' }}>
          {title}
        </span>
        <span className="text-xs text-tertiary shrink-0">{detail}</span>
      </div>
      {/* 同源复发：用户此前处理过、证据又再现 → 明示"锚定没根治"，动作升级 */}
      {recurred && (
        <div
          className="mt-2 rounded-lg px-2 py-1 text-[11px]"
          style={{
            background: 'color-mix(in srgb, var(--health-tier-red) 12%, transparent)',
            color: 'color-mix(in srgb, var(--health-tier-red) 85%, var(--text-primary))',
          }}
        >
          {t('health.distortion.recurredNotice')}
        </div>
      )}
      {/* 证据清单（本卡片的核心价值）：逐条可核对，最多 5 条，更多折叠 */}
      <div className="mt-2 max-h-28 overflow-y-auto flex flex-col gap-1">
        {visible.map(it => (
          <div
            key={it.id}
            className="rounded-lg px-2 py-1 text-xs text-secondary"
            style={{
              background: 'color-mix(in srgb, var(--health-tier-red) 5%, transparent)',
              border: '1px solid color-mix(in srgb, var(--health-tier-red) 10%, transparent)',
            }}
          >
            {t('health.distortion.evidenceLine', {
              turn: it.turn,
              axis: t(AXIS_LABEL_KEY[it.axis] ?? AXIS_LABEL_KEY.coherence),
              evidence: it.evidence,
            })}
          </div>
        ))}
        {moreCount > 0 && (
          <div className="px-2 text-[11px] text-tertiary">{t('health.distortion.moreEvidence', { n: moreCount })}</div>
        )}
      </div>
      {/* 重新锚定预览（可编辑）：一期锚点走可见 user 消息注入 → 用户能看清要发什么 */}
      {anchorPreview !== null && (
        <div className="mt-2">
          <div className="text-[11px] text-tertiary mb-1">{t('health.distortion.reanchorPreview')}</div>
          <textarea
            value={anchorPreview}
            onChange={e => setAnchorPreview(e.target.value)}
            rows={6}
            className="w-full rounded-lg px-2.5 py-1.5 text-xs text-secondary resize-y"
            style={{
              background: 'color-mix(in srgb, var(--health-tier-red) 5%, transparent)',
              border: '1px solid color-mix(in srgb, var(--health-tier-red) 18%, transparent)',
            }}
          />
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
          <input type="checkbox" checked={carrySummary} onChange={e => setCarrySummary(e.target.checked)} />
          {t('health.carrySummary')}
        </label>
        <div className="ml-auto flex items-center gap-2">
          {anchorPreview === null ? (
            <Button
              onClick={() => setAnchorPreview(anchorText || t('health.distortion.reanchor'))}
              variant={recurred ? 'secondary' : 'danger'}
              size="sm"
              disabled={!anchorText}
            >
              {t('health.distortion.reanchor')}
            </Button>
          ) : (
            <Button onClick={confirmReanchor} variant={recurred ? 'secondary' : 'danger'} size="sm">
              {t('health.distortion.sendAnchor')}
            </Button>
          )}
          {/* 复发时动作升级：上一轮「重新锚定」没根治 → 把「新建会话」提为主行动 */}
          <Button onClick={handleNewSession} variant={recurred ? 'danger' : 'secondary'} size="sm">
            {t('health.distortion.newSessionWithSummary')}
          </Button>
          <button
            onClick={() => setMinimized(true)}
            title={t('health.minimize')}
            aria-label={t('health.minimize')}
            className="p-1 rounded-md transition-colors"
            style={{ color: 'color-mix(in srgb, var(--health-tier-red) 70%, var(--text-primary))' }}
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDismiss}
            className="text-xs hover:opacity-80"
            style={{ color: 'color-mix(in srgb, var(--health-tier-red) 70%, var(--text-primary))' }}
            aria-label={t('health.dismiss')}
          >
            {t('health.dismiss')}
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}
