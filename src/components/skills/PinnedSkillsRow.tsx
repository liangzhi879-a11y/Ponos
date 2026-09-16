// src/components/skills/PinnedSkillsRow.tsx —— 收藏技能的**紧凑卡片行**（2026-09-15，批次二 B）。
//
// ## 改前 vs 改后
//
// 改前：收藏的技能用与主体列表**完全相同的卡片**渲染（`renderSkillItem(s)`），一张卡占一个网格格
// 位，还带 10 个上限 ⇒ 收藏 5 个就把主体列表挤下去大半个屏幕。用户明确要求"仅作卡片式置顶展示，
// 不占用过多版面"。
// 改后：一行**小卡**（横向排列、自动换行），每张只保留"识别所需"的信息：技能名 + 来源目录
// （悬停给完整描述与技能 id）。取消收藏按钮 hover 出现，不占常态空间。
//
// ## 为什么保留"来源目录"而不是只留名字
//
// 技能名在本仓库里高度前缀化（`gxtz-`/`yfwdoc-`/`yfwweb-`/`yfwx-`…），同名不同目录的情况真实存在
// （多个技能根：`~/.yfworking/skills`、项目内技能目录）。只显示名字会让两张卡看起来一模一样。
// 显示目录名是**识别所需的最小信息**，比显示 description（长、且卡片会被撑高）更符合"紧凑"目标。
//
// ## 为什么不复用 renderSkillItem
//
// 那是"主体列表"的卡片（含分组按钮、下载、删除、详情展开等一整套操作）。收藏区若复用，等于把
// 整套操作再塞进一趟——正是"占用过多版面"的来源。紧凑卡片只做两件事：**跳到该技能**（点击）与
// **取消收藏**。其余操作去主体列表做（那里空间充足）。
import { X } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import type { SkillEntry } from '@/lib/skills'
import { cn } from '@/lib/utils'

type Props = {
  skills: SkillEntry[]
  /** 点击卡片：滚动/定位到主体列表里的该技能（由父组件决定具体行为） */
  onOpen: (skill: SkillEntry) => void
  /** 取消收藏 */
  onUnpin: (id: string) => void
  /** 该技能是否已停用（停用徽标要在这里也可见——停用是"还能不能用"的关键信息） */
  isDisabled?: (id: string) => boolean
}

export function PinnedSkillsRow({ skills, onOpen, onUnpin, isDisabled }: Props) {
  const { t } = useTranslation()
  if (!skills.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {skills.map((s) => {
        // 目录名：取技能根路径的最后一段（`.../skills/gxtz-ip-tables` → `skills`，故取倒数第二段兜底时
        // 直接用完整相对信息不合适——这里原样给出 `folder` 字段，缺失则不显示这一行）。
        const folder = (s as SkillEntry & { folder?: string }).folder || ''
        const off = isDisabled?.(s.id) === true
        return (
          <div
            key={s.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(s)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(s) } }}
            title={`${s.name || s.id}\n${s.description || ''}`}
            className={cn(
              'group/pin relative flex items-center gap-1.5 max-w-[190px] rounded-md border px-2 py-1 cursor-pointer transition-colors',
              off
                ? 'border-warning/30 bg-warning/5 hover:border-warning/50'
                : 'border-subtle bg-input/60 hover:border-accent/50 hover:bg-input',
            )}
          >
            <span className={cn('text-[11px] truncate', off ? 'text-tertiary line-through' : 'text-secondary')}>
              {s.name || s.id}
            </span>
            {folder && (
              <span className="shrink-0 text-[9px] text-tertiary/70 max-w-[56px] truncate">{folder}</span>
            )}
            {off && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-warning" />}
            {/* 取消收藏：常驻但极淡（紧凑区里"消失的按钮"会让用户以为不能取消），hover 才显色 */}
            <button
              type="button"
              aria-label={t('skills.unpinSkill')}
              title={t('skills.unpinSkill')}
              onClick={(e) => { e.stopPropagation(); onUnpin(s.id) }}
              className="shrink-0 -mr-0.5 text-tertiary/50 hover:text-warning transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
