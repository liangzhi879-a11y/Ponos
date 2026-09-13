// src/components/knowledge/KnowledgeTree.tsx —— 知识库懒加载文件树（左栏主体）
//
// 数据策略（照 FileBrowser.tsx:24,29-78 的"扁平 map + loaded 短路"范式，但**展开态进 store 持久化**）：
//   · 每层目录由**一个 DirLevel 组件实例**负责：`useTree(space, path)` 是单层接口，
//     hook 不能按需条件调用 → 用"组件即子节点"的递归结构，让 React 的挂载/卸载充当懒加载开关；
//   · 只有展开（= 子组件已挂载）的目录才会发请求，折叠即卸载（在途响应被 hook 的退订拦下）；
//   · 拉取落定后写回 `knowledgeStore.setTreeEntries`：展开态与列表同源，
//     冷启动回读展开态时子组件立刻挂载并按 `expanded && !loaded` 去补拉（不与 store 打架）；
//   · 新建文档后 `saveDoc` 已按 `tree:<space>|` 前缀失效缓存 → 订阅中的各层自动重取，无需手动 refresh。
//
// 缩进用纯函数 `indentFor`（封顶 120px，见 lib/knowledgeTree.ts 注释）；
// 排序同理（目录在前 + 数字感知）。两者都有 node:test 覆盖。
import { useEffect } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useTree } from '@/hooks/useKnowledge'
import type { KnowledgeTreeEntry } from '@/lib/knowledgeApi'
import { indentFor, resolveDocId, sortEntries } from '@/lib/knowledgeTree'
import { cn } from '@/lib/utils'
import { KnowledgeEmpty } from './KnowledgeEmpty'
import { KnowledgeSkeleton } from './KnowledgeSkeleton'

export interface KnowledgeTreeProps {
  /** 空间 id（调用方保证非空；切空间时 knowledgeStore 已清树，这里靠 key 变化重建） */
  space: string
}

export function KnowledgeTree({ space }: KnowledgeTreeProps) {
  // key=space：切空间强制重建整棵子树，避免上一空间已挂载的 DirLevel 用旧 space 继续渲染一帧
  return (
    <div className="py-0.5" role="tree" aria-label={space}>
      <DirLevel key={space} space={space} path="" depth={0} />
    </div>
  )
}

/** 一层目录：拉取并渲染其直接子项（子目录展开时递归挂载下一层） */
function DirLevel({ space, path, depth }: { space: string; path: string; depth: number }) {
  const { t } = useTranslation()
  const { data, loading, error } = useTree(space, path)
  const setTreeEntries = useKnowledgeStore(s => s.setTreeEntries)
  // 缓存命中的层级 data 立刻可见；store 里的那份是"落定后的留档"（展开态同源）
  const stored = useKnowledgeStore(s => s.tree[path]?.entries)

  // 落定即入 store。依赖里不放 stored：写入的是 data 本身（同一引用），不会自触发
  useEffect(() => { if (data) setTreeEntries(path, data) }, [data, path, setTreeEntries])

  const entries = data ?? stored ?? []

  if (error) {
    return <p className="px-3 py-1 text-[10px] text-error break-all">{t('knowledge.loadFailed')}：{error}</p>
  }
  if (loading && !entries.length) {
    return <KnowledgeSkeleton lines={depth === 0 ? 5 : 3} className="!py-1.5 !px-2" />
  }
  if (!entries.length) {
    // 根层空 → 明确提示；子层空 → 不刷文案（嵌套深处再插一句"空目录"只会把树读乱）
    return depth === 0 ? <KnowledgeEmpty title={t('knowledge.treeEmpty')} className="!py-6" /> : null
  }
  return (
    <>
      {sortEntries(entries).map(e => (
        e.type === 'dir'
          ? <DirNode key={e.path} space={space} entry={e} depth={depth} />
          : <FileNode key={e.path} space={space} entry={e} depth={depth} />
      ))}
    </>
  )
}

function DirNode({ space, entry, depth }: { space: string; entry: KnowledgeTreeEntry; depth: number }) {
  // 只订阅**本节点**的展开态：展开别的目录不该重建这一行
  const expanded = useKnowledgeStore(s => s.tree[entry.path]?.expanded ?? false)
  const toggleExpanded = useKnowledgeStore(s => s.toggleExpanded)
  return (
    <div>
      <button
        type="button"
        onClick={() => toggleExpanded(entry.path)}
        aria-expanded={expanded}
        style={{ paddingLeft: indentFor(depth) }}
        className="w-full flex items-center gap-1 py-[3px] pr-2 text-[11px] text-secondary hover:bg-hover transition-colors"
      >
        {expanded ? <ChevronDown className="w-3 h-3 shrink-0 text-tertiary" /> : <ChevronRight className="w-3 h-3 shrink-0 text-tertiary" />}
        {expanded ? <FolderOpen className="w-3 h-3 shrink-0 text-tertiary" /> : <Folder className="w-3 h-3 shrink-0 text-tertiary" />}
        <span className="truncate">{entry.name}</span>
      </button>
      {expanded && <DirLevel space={space} path={entry.path} depth={depth + 1} />}
    </div>
  )
}

function FileNode({ space, entry, depth }: { space: string; entry: KnowledgeTreeEntry; depth: number }) {
  const docId = entry.docId || resolveDocId(space, entry.path)
  const active = useKnowledgeStore(s => s.docId === docId)
  const view = useKnowledgeStore(s => s.view)
  const setDocId = useKnowledgeStore(s => s.setDocId)
  const setView = useKnowledgeStore(s => s.setView)

  return (
    <button
      type="button"
      onClick={() => {
        setDocId(docId)
        // 图谱/搜索是"非文档型"视图：从树点开一篇文档 = 明确的阅读意图，
        // 否则用户点了树却仍停在上一个视图，看起来像"点击没反应"。阅读/编辑视图原地不动（保持编辑态）。
        if (view !== 'read' && view !== 'edit') setView('read')
      }}
      aria-current={active ? 'true' : undefined}
      style={{ paddingLeft: indentFor(depth) }}
      className={cn(
        'w-full flex items-center gap-1.5 py-[3px] pr-2 text-[11px] transition-colors',
        active ? 'bg-active text-primary' : 'text-secondary hover:bg-hover',
      )}
    >
      <FileText className={cn('w-3 h-3 shrink-0', active ? 'text-brand-500' : 'text-tertiary')} />
      <span className="truncate">{entry.name}</span>
    </button>
  )
}
