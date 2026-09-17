// src/components/team/ModeFlipButton.tsx —— 空态里的「一键翻转模式」按钮（S3 可辨识性）
//
// 为什么需要它：模式只筛侧边栏列表（spec §5.9），但列表被筛空时用户看到的画面与"真的没有内容"
// 一模一样 —— 现有 `team.listFilteredEmpty` 小字只是**说明**，用户还得自己去 header / 状态栏的
// 模式开关里点两下才能切回去。空态给出**动作**才算把话说完整。
//
// 两条纪律：
//   ① 无团队可进时**返回 null（不渲染）**：没加入任何团队时"团队模式"无处可去，画一个点了没反应的
//      按钮就是界面谎言（与 `TeamModeSwitch` 的空态引导同一条纪律）。
//   ② 判定收口在 `modeFlip()`（纯函数、可 node --test 直测）：进入团队模式走 `setActiveTeam`
//      （它本身也会把模式切到 team），回个人模式走 `setMode('personal')` —— 不自己拼 store 状态。
import { ArrowLeftRight } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { useEffectiveMode, useTeamStore } from '@/stores/teamStore'
import { modeFlip } from '@/lib/teamModeUi'

/** 列表被模式筛空时给出的"一键翻转模式"按钮；无团队可进时返回 null（不渲染）。 */
export function ModeFlipButton({ className }: { className?: string }) {
  const { t } = useTranslation()
  const mode = useEffectiveMode()
  const teams = useTeamStore((s) => s.teams)
  const activeTeamId = useTeamStore((s) => s.activeTeamId)
  const setMode = useTeamStore((s) => s.setMode)
  const setActiveTeam = useTeamStore((s) => s.setActiveTeam)

  // `modeFlip` 的入参只认 `{ id }`：团队缓存的字段名是 `teamId`（桥的口径），此处显式映射，
  // 而不是让纯逻辑去猜 store 的形状。
  const next = modeFlip(mode, teams.map((x) => ({ id: x.teamId })), activeTeamId)
  if (!next) return null

  const label = next.mode === 'team' ? t('team.modeFlipToTeam') : t('team.modeFlipToPersonal')

  return (
    <button
      type="button"
      onClick={() => {
        if (next.mode === 'team') { if (next.teamId) setActiveTeam(next.teamId) } else setMode('personal')
      }}
      className={cn(
        // 小号 + 下划线（次级按钮风格）：与空态小字同级，不与空态主按钮（如「开始对话」）抢视觉
        'inline-flex items-center gap-1 text-[10px] text-brand-500 underline underline-offset-2 hover:text-brand-400 transition-colors',
        className,
      )}
    >
      <ArrowLeftRight className="w-3 h-3" />
      {label}
    </button>
  )
}
