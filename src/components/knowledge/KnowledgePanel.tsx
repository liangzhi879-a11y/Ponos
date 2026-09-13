// src/components/knowledge/KnowledgePanel.tsx —— 知识库工作台宿主（S2 第 7 rail 的全屏面板）
//
// 本文件只做**宿主**：三栏骨架 + 视图路由 + 空间归一化。具体内容各归其组件——
//   · 头部      KnowledgeToolbar（标题/空间名/计数/刷新）
//   · 视图 tab  KnowledgeViewTabs（受控，持久化到 knowledgeStore）
//   · 左栏      KnowledgeSidebar（Task 4：空间切换 + 文件树 + 新建）
//   · 中栏      四视图条件渲染（Task 5-8 逐个填充，本任务先占位）
//   · 右栏      大纲/反链/元信息（Task 9 填充，本任务先占位）
// 拆这么碎是为了守住 spec §8「KnowledgePanel < 200 行 / 单文件 ≤ 400 行」：
// 四视图各自带 markdown 渲染、CodeMirror、xyflow，塞进一个文件必然上千行。
//
// 三栏写法照 WorkflowCanvas.tsx:347-516 的 flex 三件套：左右**定宽 shrink-0**、
// 中栏 `flex-1 min-w-0`。`min-w-0` 是关键——没有它，中栏里的长表格/长代码行会把
// flex 项撑到内容宽度，窄窗口下整块面板横向溢出（rail 之外的内容被裁掉且无法滚动）。
import { useEffect, useMemo } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useDoc, useSpaces, useStats } from '@/hooks/useKnowledge'
import { KnowledgeToolbar } from './KnowledgeToolbar'
import { KnowledgeViewTabs } from './KnowledgeViewTabs'
import { KnowledgeEmpty } from './KnowledgeEmpty'
import { KnowledgeSkeleton } from './KnowledgeSkeleton'
import { KnowledgeSidebar } from './KnowledgeSidebar'
import { KnowledgeDocView } from './KnowledgeDocView'
import { KnowledgeEditorView } from './KnowledgeEditorView'
import { KnowledgeSearchView } from './KnowledgeSearchView'
import { KnowledgeGraphView } from './KnowledgeGraphView'
import { KnowledgeInspector } from './KnowledgeInspector'
import { KnowledgeMarketView } from './KnowledgeMarketView'

export function KnowledgePanel() {
  const { t } = useTranslation()
  // 只订阅自己用得到的字段（仓库纪律：不整店订阅，避免无关写入重建整棵面板树）
  const spaceId = useKnowledgeStore(s => s.spaceId)
  const docId = useKnowledgeStore(s => s.docId)
  const targetLine = useKnowledgeStore(s => s.targetLine)
  const view = useKnowledgeStore(s => s.view)
  const setSpace = useKnowledgeStore(s => s.setSpace)
  const setView = useKnowledgeStore(s => s.setView)

  const { data: spaces, loading: spacesLoading, error: spacesError, refresh: refreshSpaces } = useSpaces()
  const { data: stats, loading: statsLoading, refresh: refreshStats } = useStats()
  const { data: doc, loading: docLoading } = useDoc(docId)

  const space = useMemo(() => spaces?.find(s => s.id === spaceId) ?? null, [spaces, spaceId])
  const readonly = space ? !space.writable : false

  // 空间归一化：空间列表到位后，若当前 spaceId 为空**或已失效**（落盘的空间被删/改名），
  // 自动落到第一个空间。否则用户会看到"左栏有空间可选、中栏却永远空态"的僵局。
  useEffect(() => {
    if (!spaces?.length) return
    if (spaceId && spaces.some(s => s.id === spaceId)) return
    setSpace(spaces[0].id)
  }, [spaces, spaceId, setSpace])

  const refreshAll = () => { refreshSpaces(); refreshStats() }
  const loading = spacesLoading || statsLoading

  // 只读空间不可停留编辑视图（spec §11.3）：CodeEditor 无 readOnly，只能靠"不渲染"实现。
  // 两种进入路径都要兜住——① 落盘 view='edit' 冷启动后空间已变只读；
  // ② 用户正在编辑别的空间，切到只读空间。否则会出现"tab 已禁用、人还在编辑器里"的错位。
  useEffect(() => {
    if (readonly && view === 'edit') setView('read')
  }, [readonly, view, setView])

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <KnowledgeToolbar
        spaceName={space?.name ?? null}
        readonly={readonly}
        stats={stats ? { docs: stats.docs, blocks: stats.blocks } : undefined}
        loading={loading}
        onRefresh={refreshAll}
      />
      <KnowledgeViewTabs value={view} onChange={setView} readonly={readonly} />

      {/* 三栏：左 236px（空间+树）/ 中 flex-1（四视图）/ 右 212px（大纲·反链·元信息） */}
      <div className="flex-1 flex min-h-0 min-w-0">
        <KnowledgeSidebar spaces={spaces} spacesLoading={spacesLoading} />

        <div className="flex-1 min-w-0 flex flex-col">
          {spacesError ? (
            <KnowledgeEmpty title={t('knowledge.loadFailed')} hint={spacesError} className="m-auto" />
          ) : view === 'market' ? (
            // 市场视图（S4 Task 6）**不依赖当前空间**（离线安装/在线清单都无需先选空间），
            // 故必须排在 `!space` 空态之前——否则"一个空间都没有"的用户永远进不去市场，
            // 而"没有空间"恰恰是装第一个知识包的最常见时机。
            <KnowledgeMarketView />
          ) : !space ? (
            // !space 覆盖两类：空间列表尚未到位（骨架屏），或列表为空（真空态）
            spacesLoading || !spaces
              ? <KnowledgeSkeleton lines={8} />
              : <KnowledgeEmpty title={t('knowledge.spaceEmpty')} className="m-auto" />
          ) : view === 'read' ? (
            docLoading ? <KnowledgeSkeleton lines={10} />
              : doc ? <KnowledgeDocView doc={doc} targetLine={targetLine} />
                : <KnowledgeEmpty title={t('knowledge.emptyNoDoc')} className="m-auto" />
          ) : view === 'edit' ? (
            // 只读空间不渲染编辑视图（spec §11.3：CodeEditor 无 readOnly，编辑器内容非受控）
            readonly ? <KnowledgeEmpty title={t('knowledge.emptyEditReadonly')} className="m-auto" />
              : docLoading ? <KnowledgeSkeleton lines={12} />
                : doc ? <KnowledgeEditorView doc={doc} spaceId={space.id} spaceRoot={space.root} />
                  : <KnowledgeEmpty title={t('knowledge.emptyNoDoc')} className="m-auto" />
          ) : view === 'search' ? (
            // 搜索视图（Task 7）：自持 q/keywords/范围三态，命中的定位通过 store 三连写回
            <KnowledgeSearchView />
          ) : (
            // 图谱视图（Task 8）：节点=文档、边=已解析的相对链接；点节点打开该文档
            <KnowledgeGraphView />
          )}
        </div>

        {/* 右栏：大纲 / 反链 / 元信息（Task 9）。宽度与空态都归 Inspector 自己管——
            宿主只管"放在三栏的最右"，这样 Task 9 只需替换一个组件（见文件头拆分原则） */}
        <KnowledgeInspector doc={doc} />
      </div>
    </div>
  )
}
