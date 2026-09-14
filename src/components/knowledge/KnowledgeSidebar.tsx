// src/components/knowledge/KnowledgeSidebar.tsx —— 左栏容器（空间切换 + 新建入口 + 文件树）
//
// 为什么把"空间下拉"放在这里而不是顶部工具栏：顶部工具栏回答"我在哪个空间"（只读展示），
// 左栏回答"换成哪个空间"（操作入口）——与仓库其它面板"头部只读、面板内操作"的分工一致。
//
// 只读空间（`writable === false`）：新建钮禁用（由 KnowledgeNewMenu 内部判定）+ 一行显式说明。
// 只提示不解释会让用户以为面板坏了；后端 403 是最后一道兜底（spec §8 双保险）。
import { useMemo } from 'react'
import { ChevronDown, Library, PackageSearch } from 'lucide-react'
import { KnowledgeImportDialog } from './KnowledgeImportDialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import type { KnowledgeSpace } from '@/lib/knowledgeApi'
import { KnowledgeTree } from './KnowledgeTree'
import { KnowledgeNewMenu } from './KnowledgeNewMenu'
import { KnowledgeEmpty } from './KnowledgeEmpty'
import { KnowledgeSkeleton } from './KnowledgeSkeleton'

export interface KnowledgeSidebarProps {
  /** 空间列表（宿主用 useSpaces 拉到后下发；不在这里再拉一次，避免重复请求） */
  spaces: KnowledgeSpace[] | undefined
  spacesLoading: boolean
  /** 文件知识库导入成功后通知宿主刷新（空间列表/统计要跟着变） */
  onImported?: (spaceId: string) => void
}

export function KnowledgeSidebar({ spaces, spacesLoading, onImported }: KnowledgeSidebarProps) {
  const { t } = useTranslation()
  const spaceId = useKnowledgeStore(s => s.spaceId)
  const setSpace = useKnowledgeStore(s => s.setSpace)
  const setView = useKnowledgeStore(s => s.setView)

  const space = useMemo(() => spaces?.find(s => s.id === spaceId) ?? null, [spaces, spaceId])
  const readonly = space?.writable === false

  return (
    <div className="w-[236px] shrink-0 border-r border-default flex flex-col min-w-0">
      <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-default">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('knowledge.spaceChoose')}
              className="flex-1 min-w-0 flex items-center gap-1 text-[11px] text-secondary hover:text-primary transition-colors"
            >
              <Library className="w-3 h-3 shrink-0 text-tertiary" />
              <span className="truncate">{space?.name ?? t('knowledge.spaceNone')}</span>
              <ChevronDown className="w-3 h-3 shrink-0 text-tertiary" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[212px]">
            <DropdownMenuLabel className="micro">{t('knowledge.spaceChoose')}</DropdownMenuLabel>
            {(spaces ?? []).map(s => (
              <DropdownMenuItem key={s.id} onSelect={() => setSpace(s.id)} className="text-[11px]">
                <span className="flex-1 min-w-0 truncate">{s.name}</span>
                {/* 只读标记必须在下拉里就能看见：否则用户会"选中 → 发现不能建 → 再换一个"来回试 */}
                {s.writable === false && <span className="micro shrink-0">{t('knowledge.readonly')}</span>}
                <span className="shrink-0 text-[10px] text-tertiary tabular-nums">{s.docCount}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <KnowledgeNewMenu space={space} />
      </div>

      {readonly && (
        <p className="px-2 py-1 shrink-0 text-[10px] text-tertiary border-b border-default">{t('knowledge.readonlyHint')}</p>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {space
          ? <KnowledgeTree space={space.id} />
          : spacesLoading || !spaces
            ? <KnowledgeSkeleton lines={5} className="!px-2" />
            : <KnowledgeEmpty title={t('knowledge.spaceEmpty')} className="!py-6" />}
      </div>

      {/* 市场入口放在**固定底栏**（原型 §1 的"空间列表底部"）：它不属于任何空间，
          更不能只在"选中了空间"时才出现——没空间的人最需要装一个知识包。 */}
      <div className="shrink-0 px-2 py-1 border-t border-default space-y-0.5">
        {/* 文件知识库导入（2026-09-14）：与市场入口同级（都是"往知识库放东西"的全局操作）。
            刻意**不**依赖"已选中空间"：没空间的人也能用（导入时会新建），
            而这正是用户第一次用这个功能时的状态。 */}
        <KnowledgeImportDialog spaces={spaces} onImported={onImported} />
        <button
          type="button"
          onClick={() => setView('market')}
          className="w-full flex items-center gap-1.5 py-0.5 text-[11px] text-tertiary hover:text-primary transition-colors"
        >
          <PackageSearch className="w-3 h-3 shrink-0" />
          <span className="truncate">{t('knowledge.marketDiscover')}</span>
        </button>
      </div>

      {space && (
        <div className="shrink-0 px-2 py-1 border-t border-default">
          {/* 空间根路径：只读展示，方便用户拿它去资源管理器里对照（长路径 truncate + title 兜住） */}
          <p className="text-[10px] text-tertiary truncate" title={space.root}>
            {space.source} · {space.root} · {space.docCount} {t('knowledge.statDocs')}
          </p>
        </div>
      )}
    </div>
  )
}
