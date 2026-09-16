// src/components/knowledge/KnowledgeSidebar.tsx —— 左栏容器（空间切换 + 新建入口 + 文件树）
//
// 为什么把"空间下拉"放在这里而不是顶部工具栏：顶部工具栏回答"我在哪个空间"（只读展示），
// 左栏回答"换成哪个空间"（操作入口）——与仓库其它面板"头部只读、面板内操作"的分工一致。
//
// 只读空间（`writable === false`）：新建钮禁用（由 KnowledgeNewMenu 内部判定）+ 一行显式说明。
// 只提示不解释会让用户以为面板坏了；后端 403 是最后一道兜底（spec §8 双保险）。
import { useMemo, useState } from 'react'
import { ChevronDown, Library, PackageSearch, Trash2 } from 'lucide-react'
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
// 删除管理（2026-09-14）：整库删除的入口在**空间信息栏**（作用域明确 = 当前空间），
// 与回收站入口（全局，在底栏）分开。判据镜像在内核，这里只决定"画不画按钮"。
import { DeleteSpaceDialog } from './KnowledgeDeleteDialogs'
import { KnowledgeTrashDialog } from './KnowledgeTrashDialog'
import { canDeleteSpace } from '@/lib/knowledgeDeleteUi'
// 会话知识范围（2026-09-15，P1）：关联开关的**判据**在 lib 里（纯函数、可单测），
// 本组件只负责把它画出来 + 写会话字段。内核仍是收口方（越界由内核拒绝）。
import { isAssociableSpace, isLargeSpace, toggleKnowledgeSpace, MAX_ASSOC_SPACES } from '@/lib/knowledgeScopeUi'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/stores/chatStore'

export interface KnowledgeSidebarProps {
  /** 空间列表（宿主用 useSpaces 拉到后下发；不在这里再拉一次，避免重复请求） */
  spaces: KnowledgeSpace[] | undefined
  spacesLoading: boolean
  /** 文件知识库导入成功后通知宿主刷新（空间列表/统计要跟着变） */
  onImported?: (spaceId: string) => void
  /** 删除/还原/清空之后通知宿主刷新（空间列表/树/统计都要跟着变） */
  onDeleted?: () => void
}

export function KnowledgeSidebar({ spaces, spacesLoading, onImported, onDeleted }: KnowledgeSidebarProps) {
  const { t } = useTranslation()
  const spaceId = useKnowledgeStore(s => s.spaceId)
  const setSpace = useKnowledgeStore(s => s.setSpace)
  const setView = useKnowledgeStore(s => s.setView)
  // 整库删除的确认框（受控）：触发器在下方空间信息栏，确认框在这里挂一次 —— 避免
  // "每个可能删库的地方各带一份确认框"（那会让两处的文案与校验逻辑迟早分叉）。
  const [delSpaceOpen, setDelSpaceOpen] = useState(false)
  // 关联超上限的即时提示（受控、不落库）：唯一需要"当场告知"的失败态——超限时点击无效果，
  // 不出声用户只会反复点。其余失败态（库不存在等）由内核在会话里出声，界面不重复报。
  const [assocLimitHit, setAssocLimitHit] = useState(false)

  // 会话知识范围（2026-09-15，P1）：关联关系挂在**当前会话**上（不是全局设置）——
  // 需求原文把它归为"会话模式"的能力，且不同会话用不同知识库才是常态
  // （写材料的会话要运营库，写代码的会话不要）。
  const activeConvId = useChatStore(s => s.activeConversationId)
  const activeConv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId))
  const setConvKnowledgeSpaces = useChatStore(s => s.setConversationKnowledgeSpaces)

  const space = useMemo(() => spaces?.find(s => s.id === spaceId) ?? null, [spaces, spaceId])
  const readonly = space?.writable === false
  const associable = isAssociableSpace(space)
  const associated = !!(space && activeConv?.knowledgeSpaces?.includes(space.id))

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
        {/* 回收站：与上面两项同级（都是全局入口 —— 回收站不属于任何空间，
            删掉的库也在里面）。刻意**不**依赖"已选中空间"，与导入同一条理由。 */}
        <KnowledgeTrashDialog onChanged={onDeleted} />
      </div>

      {space && (
        <div className="shrink-0 px-2 py-1 border-t border-default space-y-0.5">
          {/* 空间根路径：只读展示，方便用户拿它去资源管理器里对照（长路径 truncate + title 兜住） */}
          <p className="text-[10px] text-tertiary truncate" title={space.root}>
            {space.source} · {space.root} · {space.docCount} {t('knowledge.statDocs')}
          </p>
          {/* 会话知识范围（2026-09-15，P1）「关联到当前会话」：把当前库纳入**本会话**的 agent
              可用范围（注入层 + 检索工具层）。放在空间信息栏而不是下拉列表里：它的作用域是
              "当前选中的库"，与"删整库"同级；丢进下拉则每次点选都会关掉菜单，无从确认状态。
              三点刻意设计：
                · 只对 user/pack 显示（内置经验库恒在范围内，画开关等于画一个点不动的按钮）；
                · 无活动会话时给一行说明而不是隐藏（否则用户以为功能不存在）；
                · 生效时机写清楚（内核在启动段冻结范围，改关联后**下一句话**生效，
                  桥以 --resume 重启内核、上下文不丢）。 */}
          {associable && (
            activeConvId ? (
              <button
                type="button"
                onClick={() => {
                  const r = toggleKnowledgeSpace(activeConv?.knowledgeSpaces, space.id)
                  if (r.rejected === 'limit') { setAssocLimitHit(true); return }
                  setAssocLimitHit(false)
                  setConvKnowledgeSpaces(activeConvId, r.spaces)
                }}
                aria-pressed={associated}
                className={cn(
                  'w-full flex items-center gap-1.5 py-0.5 text-[11px] transition-colors text-left',
                  associated ? 'text-brand-500 hover:text-brand-600' : 'text-tertiary hover:text-primary',
                )}
              >
                <span className="truncate">{t(associated ? 'knowledge.assocOn' : 'knowledge.assocOff')}</span>
              </button>
            ) : (
              <p className="text-[10px] text-tertiary">{t('knowledge.assocNoConv')}</p>
            )
          )}
          {associable && activeConvId && associated && (
            <p className="text-[10px] text-tertiary">
              {isLargeSpace(space.docCount)
                ? t('knowledge.assocLarge', { count: space.docCount })
                : t('knowledge.assocHint')}
            </p>
          )}
          {assocLimitHit && (
            <p className="text-[10px] text-error">{t('knowledge.assocLimit', { count: MAX_ASSOC_SPACES })}</p>
          )}
          {/* 删整库入口：仅用户自建库显示（canDeleteSpace 只认 source==='user'，与内核
              deleteGate 同源）。内置经验库/会话记忆**不显示**而非"显示但点不动"——
              后者会让用户反复点击并以为界面坏了。知识包同理（连条目都不能删）。 */}
          {canDeleteSpace(space) && (
            <button
              type="button"
              onClick={() => setDelSpaceOpen(true)}
              className="w-full flex items-center gap-1.5 py-0.5 text-[11px] text-tertiary hover:text-error transition-colors"
            >
              <Trash2 className="w-3 h-3 shrink-0" />
              <span className="truncate">{t('knowledge.deleteSpaceBtn')}</span>
            </button>
          )}
          {/* 内置库给出**解释性提示**：入口不显示时必须说明为什么（否则用户会去找、
              或者以为只有自己的库才配删）。只读知识包不提示 —— 它已有 readonly 标记。 */}
          {space.source !== 'user' && space.source !== 'pack' && (
            <p className="text-[10px] text-tertiary">{t('knowledge.deleteSpaceProtected')}</p>
          )}
        </div>
      )}

      {/* 确认框挂载点。删成功时 `onDeleted` 会先关再刷新：顺序很重要 —— 反过来的话
          刷新先把 `space` 清成 null（该库已不在列表里），确认框会在**还开着**的状态下
          变成"空库名确认"（user 看到输入框里的库名被抹掉，像是操作失败）。
          先关后刷，渲染时 open 已是 false，对话框内容不再取值。 */}
      <DeleteSpaceDialog
        space={space}
        open={delSpaceOpen}
        onOpenChange={setDelSpaceOpen}
        onDeleted={() => { setDelSpaceOpen(false); onDeleted?.() }}
      />
    </div>
  )
}
