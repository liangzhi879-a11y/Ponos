import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import { Button } from '@/components/ui'
import { sendLoopCommand } from '@/hooks/useYFWCLI'
import { REASON_KEY } from './LoopStatusBar'

interface Props {
  conversationId: string
}

/**
 * loop 状态面板（2026-09-14 loop 运行时 Task6）：目标 / 轮次 / 步数 / 成本 / 无进展 /
 * 验证结果 + 控制按钮（暂停·恢复·批准·停止·刷新）。
 *
 * 数据源 = chatStore.loopStates[conversationId]（useYFWCLI 的 loop 帧归约：内核
 * kernel/loop.mjs emit 的 start/iter/end/status 帧）；操作经 sendLoopCommand →
 * bridge `loop-command` 入站 → 内核 cli.mjs 的 loop_command 路由 → 回来一条
 * `system/loop_result` 可见回执（无轮次产出，不置流式态）。
 *
 * 空态策略：无记录、或已收尾（active=false 且无 end reason）时返回 null —— 面板只在
 * "循环在跑"或"刚收尾待用户看结果"这两段存在，不常驻占位。
 * 挂载于 ChatWindow 底部状态族（LoopStatusBar 之后一格，位于消息区与输入区之间），
 * 且**在流式布局中**（占位、收窄消息区）：因此它与悬浮态的 LoopStatusBar（absolute
 * bottom-0 pb-[52px] 胶囊，z-20）在同一底带重叠——这里用 `relative z-30` 让信息更全的
 * 面板压在胶囊之上（否则胶囊会盖住面板按钮行，且 pill 的 pointer-events-auto 会截点击）。
 * 样式沿用状态族 tokens（bg-elevated/border-subtle/text-primary 等，同 LoopStatusBar）。
 */
export function LoopPanel({ conversationId }: Props) {
  const loop = useChatStore(s => s.loopStates[conversationId])
  const { t } = useTranslation()

  if (!loop || (!loop.active && !loop.reason)) return null

  const st = loop.status
  const cost = loop.costUsd ?? 0
  // 目标展示：内核 start/end 帧的 goal 来自 `--goal`（未给则为空串）；没有 goal 时
  // 回落到 until（`--until <目标>`，两者在语义上都是"这次循环要达成什么"）。
  // 注意：`/loop --every 5m <任务>` 这类间隔式指令内核**不在帧里回传 prompt**，
  // 故 goal/until 都为空 → 面板不显示目标行（见汇报的遗留问题）。
  const goal = loop.goal || loop.until
  // 暂停按钮：内核 pause() 先置 'pausing'（当前轮跑完转 'paused'）——两态都已在跑，
  // 只有 'paused' 才该换成"恢复"（重复点暂停是空操作，但按钮语义要跟着状态走）。
  const canPause = loop.active && st !== 'paused'
  // 恢复/批准：挂起待批（awaiting_approval）与已暂停（paused）都靠内核 resume() 唤醒
  // （内核侧停止发生在轮次边界，不会自行推进，resume 分支会补投递下一轮）。
  const canResume = st === 'paused' || st === 'awaiting_approval'

  return (
    <div className="relative z-30 mx-4 mb-2 rounded-lg border border-subtle bg-elevated/70 px-3 py-2 text-xs animate-slide-up">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" />
        <span className="font-semibold text-[11px] text-primary whitespace-nowrap">
          {t('loopPanel.title')}
        </span>
        {/* 右上角状态文案：在跑 = 内核 state.status 原码（running/pausing/paused/
            awaiting_approval/verifying）；收尾后 status 已清空 → 回落 end reason 的
            本地化文案（与 LoopStatusBar 共用 REASON_KEY，不各写一份映射）。 */}
        <span className="ml-auto text-[10px] text-tertiary whitespace-nowrap tabular-nums">
          {st ?? (loop.active ? 'running' : loop.reason ? t(REASON_KEY[loop.reason]) : '')}
        </span>
      </div>

      {/* 目标（start/end 帧 goal；缺省回落到 until） */}
      {goal && (
        <div className="mt-1.5 text-[11px] text-secondary break-all">
          {t('loopPanel.goal', { goal })}
        </div>
      )}

      {/* 计量行：轮次 · 工具步数 · 累计成本 */}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-tertiary tabular-nums">
        <span>
          {t('loopPanel.progress', {
            current: loop.index,
            // total 归约：内核 count=null（`--every` 持续循环）→ 0 → 显示 ∞
            total: loop.total > 0 ? loop.total : '∞',
          })}
        </span>
        <span>·</span>
        <span>{t('loopPanel.steps', { n: loop.steps ?? 0 })}</span>
        {cost > 0 && (
          <>
            <span>·</span>
            <span>{t('loopPanel.cost', { usd: cost.toFixed(4) })}</span>
          </>
        )}
      </div>

      {/* 无进展连续轮次（达内核阈值会注入预警 / 挂起待批） */}
      {!!loop.noProgressStreak && (
        <div className="mt-1 text-[10px] text-warning">
          {t('loopPanel.noProgress', { n: loop.noProgressStreak })}
        </div>
      )}

      {/* 最近一次 doneWhen 验证结果（iter 帧 verify；run/type:✓/✗ 逐条列出） */}
      {loop.verify && (
        <div
          className={loop.verify.passed ? 'mt-1 text-[10px] text-success' : 'mt-1 text-[10px] text-error'}
        >
          {t('loopPanel.verify')}
          {loop.verify.passed ? t('loopPanel.verifyPass') : t('loopPanel.verifyFail')}
          {loop.verify.results?.length
            ? ` · ${loop.verify.results.map(v => `${v.run ?? v.type}:${v.ok ? '✓' : '✗'}`).join(' ')}`
            : ''}
        </div>
      )}

      {/* 挂起待批详情（内核 pendingApproval：rollback / no_progress 等） */}
      {loop.pendingApproval && (
        <div className="mt-1 text-[10px] text-warning break-all">
          {loop.pendingApproval.kind}
          {loop.pendingApproval.detail ? ` · ${loop.pendingApproval.detail}` : ''}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {canPause && (
          <Button size="xs" variant="outline" onClick={() => sendLoopCommand(conversationId, 'pause')}>
            {t('loopPanel.pause')}
          </Button>
        )}
        {canResume && (
          <Button size="xs" variant="primary" onClick={() => sendLoopCommand(conversationId, 'resume')}>
            {t('loopPanel.resume')}
          </Button>
        )}
        {loop.pendingApproval && (
          <Button size="xs" variant="outline" onClick={() => sendLoopCommand(conversationId, 'approve')}>
            {t('loopPanel.approve')}
          </Button>
        )}
        {loop.active && (
          <Button size="xs" variant="outline" onClick={() => sendLoopCommand(conversationId, 'stop')}>
            {t('loopPanel.stop')}
          </Button>
        )}
        {/* 刷新 = 内核 status 指令：全量快照回填 loopStore + loop_result 文本回执 */}
        <Button size="xs" variant="ghost" onClick={() => sendLoopCommand(conversationId, 'status')}>
          {t('loopPanel.refresh')}
        </Button>
      </div>
    </div>
  )
}
