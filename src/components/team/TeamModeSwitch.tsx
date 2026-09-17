// src/components/team/TeamModeSwitch.tsx —— header 一级「个人 / 团队」模式开关（S3，spec §5.9）
//
// spec §5.9 的两级形态：① header 一级「个人 / 团队」；② 团队态下二级选择具体团队工作区。
// 未加入任何团队时显示**空态引导**（创建 / 加入二选一）。
//
// 三条纪律：
//   ① **模式 ≠ 隔离**（§5.9「为什么必须明说」）：下拉底部**必须**常驻一行小字。若 UI 让用户以为
//      "切到个人模式 ⇒ 团队数据不可见 ⇒ 安全"，而数据其实就在本地磁盘上，那是在制造虚假安全感
//      —— 比不提供该功能更危险。故这行字不是装饰，是 §10 S3-12 的验收项。
//   ② **团队能力默认关闭**（plan §2.2）：没有任何团队时不会改变列表的任何一行（生效模式恒为
//      personal，见 teamModeUi.effectiveMode）；此处只多一个可展开的开关，不做任何写操作。
//   ③ 探测**惰性且失败静默**：挂载时读一次 `GET /team/status`（只读、无副作用）；桥没起时
//      界面保持"个人"、不报错 —— 团队是可选的附加能力，它出问题不该影响任何人。
import { useEffect, useState } from 'react'
import { Check, Users, User, Settings2, ChevronDown } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'
import { useTeamStore, useEffectiveMode, ensureTeamsLoaded } from '@/stores/teamStore'
import { INVITE_DISCLOSURE_KEYS } from '@/lib/teamOnboardingUi'
import { SETTINGS_TEAM_SECTION, SETTINGS_SECTION_STORAGE_KEY, SETTINGS_TEAM_INTENT_KEY } from '@/lib/teamModeUi'

/** 打开设置窗的团队分区，并指定**落点子视图**（创建 / 加入 / 仅管理）。
 *  两个键各自一次性：设置窗读走"分区"，团队页读走"子视图"。 */
function openTeamSettings(intent: 'manage' | 'create' | 'join') {
  try {
    localStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, SETTINGS_TEAM_SECTION)
    localStorage.setItem(SETTINGS_TEAM_INTENT_KEY, intent)
  } catch { /* 无 storage：仅影响落点分区/子视图，功能不受影响 */ }
  window.yfworkingWindow?.openUtility?.('settings')
}

export function TeamModeSwitch() {
  const { t } = useTranslation()
  const mode = useEffectiveMode()
  const teams = useTeamStore((s) => s.teams)
  const activeTeamId = useTeamStore((s) => s.activeTeamId)
  const setMode = useTeamStore((s) => s.setMode)
  const setActiveTeam = useTeamStore((s) => s.setActiveTeam)
  const [open, setOpen] = useState(false)

  // 惰性只读探测：ensureTeamsLoaded 幂等（已加载过就不发请求）
  useEffect(() => { void ensureTeamsLoaded() }, [])

  const active = teams.find((x) => x.teamId === activeTeamId) ?? null
  const label = mode === 'team' ? (active?.name || t('team.modeTeam')) : t('team.modePersonal')
  const Icon = mode === 'team' ? Users : User

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('team.modeSwitchAria')}
          title={t('team.modeSwitchTitle')}
          className={cn(
            'flex items-center gap-1 h-6 px-2 text-[11px] clip-sm transition-colors',
            mode === 'team' ? 'bg-brand-500/15 text-brand-500' : 'text-secondary hover:text-primary hover:bg-elevated',
          )}
        >
          <Icon className="w-3.5 h-3.5" />
          <span className="max-w-[110px] truncate">{label}</span>
          <ChevronDown className="w-3 h-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[300px]">
        <DropdownMenuLabel className="micro">{t('team.modeSwitchTitle')}</DropdownMenuLabel>

        {teams.length === 0 ? (
          // 空态引导（§10 S3-1）：没有团队时"团队模式"无处可去 ⇒ 明确给出创建/加入两条路，
          // 而不是画一个点了没反应的开关。
          <div className="px-2 pb-2 space-y-1.5">
            <div className="text-[11px] text-primary font-medium">{t('team.modeEmptyTitle')}</div>
            <p className="text-[10px] text-tertiary leading-relaxed">{t('team.modeEmptyHint')}</p>
            <div className="flex items-center gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => { setOpen(false); openTeamSettings('create') }}
                className="flex-1 h-6 text-[11px] clip-sm bg-brand-500 text-inverse hover:opacity-90 transition-opacity"
              >
                {t('team.modeActionCreate')}
              </button>
              <button
                type="button"
                onClick={() => { setOpen(false); openTeamSettings('join') }}
                className="flex-1 h-6 text-[11px] clip-sm bg-elevated text-secondary hover:text-primary transition-colors"
              >
                {t('team.modeActionJoin')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* 一级：模式（两个条目，当前项打勾） */}
            <DropdownMenuItem className="text-[11px]" onSelect={() => setMode('personal')}>
              <User className="w-3.5 h-3.5" />
              <span className="flex-1">{t('team.modePersonal')}</span>
              {mode === 'personal' && <Check className="w-3.5 h-3.5 text-brand-500" />}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[11px]" onSelect={() => setMode('team')}>
              <Users className="w-3.5 h-3.5" />
              <span className="flex-1">{t('team.modeTeam')}</span>
              {mode === 'team' && <Check className="w-3.5 h-3.5 text-brand-500" />}
            </DropdownMenuItem>

            {/* 二级：当前团队（多团队切换）。选中即切到团队模式（否则列表立刻把它筛掉） */}
            <DropdownMenuLabel className="micro pt-1">{t('team.modeCurrentTeam')}</DropdownMenuLabel>
            {teams.map((x) => (
              <DropdownMenuItem key={x.teamId} className="text-[11px]" onSelect={() => setActiveTeam(x.teamId)}>
                <span className="flex-1 min-w-0 truncate">{x.name || x.teamId}</span>
                {x.teamId === activeTeamId && <Check className="w-3.5 h-3.5 text-brand-500" />}
                {x.ok === false && <span className="micro shrink-0">{t('team.loadFailed')}</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem className="text-[11px]" onSelect={() => { setOpen(false); openTeamSettings('manage') }}>
              <Settings2 className="w-3.5 h-3.5" />
              <span className="flex-1">{t('team.modeManage')}</span>
            </DropdownMenuItem>
          </>
        )}

        {/* 🔴 措辞红线（§5.9）：模式不是隔离。这行字常驻（两种空/非空态都画），
            且**不**只放在文档里 —— 用户看不到文档，只看到这个下拉。 */}
        <div className="px-2 py-1.5 mt-1 border-t border text-[10px] text-tertiary leading-snug">
          {t(INVITE_DISCLOSURE_KEYS.modeNotIsolation)}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
