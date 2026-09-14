// src/components/knowledge/KnowledgeGraphView.tsx —— 图谱视图（S2 Task 8）
//
// 集成方式（照 `workflows/canvas/WorkflowCanvas.tsx` 三分文件范式）：
//   KnowledgeGraphView（本文件：数据 + 布局 + 画布）
//     └─ graph/KnowledgeNode.tsx / graph/KnowledgeEdge.tsx（纯渲染）
//   ① **必须** `import '@xyflow/react/dist/style.css'`：xyflow 的定位/拖拽/缩放全靠它，
//      漏了会得到一张"所有节点摞在左上角、拖动时错位"的画布（WorkflowCanvas.tsx:17-18 同理）。
//   ② `nodeTypes` / `edgeTypes` 必须是**模块级常量**——每次 render 新建对象会让 xyflow
//      认为节点类型变了，整图卸载重挂载（缩放位置、选中态全丢）。
//   ③ 不引新依赖（spec §2）：布局自己算（lib/knowledgeGraph.ts，网格 + 度数排序，确定性）。
//
// 为什么节点不可拖（`nodesDraggable={false}`）：xyflow 是受控组件——不接 `onNodesChange`
// 时拖动只是"跟手一瞬"，松手弹回原位，看起来像 bug。要真支持拖动就得把节点搬进 state，
// 代价是**位置不再确定**：每次重进视图布局都会与用户手拖的结果打架。图谱的用途是导航
// （看关系 + 点进去读），画布的平移/缩放（pan/zoom，本视图全部保留）才是必要的。
//
// 点节点即打开文档：节点 id 就是 docId，直接在 `onNodeClick` 里写 store 三连（切文档 → 置视图），
// 不需要把回调塞进节点 data（那会破坏 ② 的稳定引用）。
//
// S5 Task 9 增「关联图层」开关（spec §7.5），**默认只画显式链接**。理由来自实测数据：真实库当前
// 只有 1 条显式链接，而隐式关联有几百条；默认全画会让第一印象从"1 条边"变成一个毛球，用户再也
// 看不到"这库里有引用关系"这件事。图层**开启才发请求**（useGraphRelated 的 enabled），关着时
// 既无进程开销，也不会让人误以为开关在工作。两层边视觉可区分：实线 + `--border-default`（显式）
// vs 虚线 + `--border-strong`（隐式）。合并/去重/计数全在 lib/knowledgeRelations.mergeGraphEdges
// （纯函数，node --test 覆盖），本视图只做渲染。
import { useMemo, useState } from 'react'
import { ReactFlow, Background, Controls, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Layers } from 'lucide-react'
import { useEntryGraph, useGraph, useGraphRelated } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useTranslation } from '@/i18n/useTranslation'
import { layoutGraph, nodeDegrees, resolvedEdges, shortRef } from '@/lib/knowledgeGraph'
import { mergeGraphEdges } from '@/lib/knowledgeRelations'
import { cn } from '@/lib/utils'
import type { KnowledgeGraphNode } from '@/lib/knowledgeApi'
import { KnowledgeEmpty } from './KnowledgeEmpty'
import { KnowledgeSkeleton } from './KnowledgeSkeleton'
import { KnowledgeScopeToggle } from './KnowledgeScopeToggle'
import { KnowledgeNode, type KnowledgeNodeData } from './graph/KnowledgeNode'
import { KnowledgeEdge, type KnowledgeEdgeData } from './graph/KnowledgeEdge'

/** 稳定引用（见文件头 ②） */
const nodeTypes = { kb: KnowledgeNode }
const edgeTypes = { kb: KnowledgeEdge }

export function KnowledgeGraphView() {
  const { t } = useTranslation()
  const spaceId = useKnowledgeStore(s => s.spaceId)
  const [allSpaces, setAllSpaces] = useState(true)
  // 图层开关的**默认 false 是 spec 的明确要求**（见文件头），不是随手选的初值
  const [showRelated, setShowRelated] = useState(false)
  // S5.1：图谱**层级**（文档 / 条目）。默认 'doc' 与 S2/S5 既有行为逐字一致；
  // 切到 'entry' 才发条目级请求（enabled 范式同 showRelated）。
  // 为什么要有这个开关：真实库 **74/76 条经验挤在同一个文件里**，文档级图把这些条目间的
  // 关联全部塌成自环并过滤 ⇒ 文档级几乎无边，用户看到的是"像没做图谱"。
  const [level, setLevel] = useState<'doc' | 'entry'>('doc')
  const isEntry = level === 'entry'

  // `limit` 不传 = 后端默认 200（kernel/knowledge.mjs:596）；前端**不许**再压小，
  // 压小会让"图谱缺了一大块"看起来像索引坏了。
  const { data, loading, error } = useGraph(allSpaces ? null : spaceId)
  // 图层关着时 enabled=false → hook 的 key 为 null，一个请求都不发（默认路径与 S2 完全一致）
  const { data: relatedEdges, loading: relatedLoading } = useGraphRelated(
    allSpaces ? null : spaceId, undefined, showRelated,
  )
  // 条目级图（S5.1）：只在切入时发请求，文档级时 key 为 null → 与既有路径零差异
  const { data: entryData, loading: entryLoading, error: entryError } = useEntryGraph(
    allSpaces ? null : spaceId, undefined, isEntry,
  )

  // **只有这两个变量按层级分叉**：下面的布局、度数、渲染、点击全部复用同一套。
  // 刻意不写"两条渲染路径"——两套渲染必然各自漂移，层级之间的差异应当仅在"数据从哪来"。
  const nodes = isEntry ? (entryData?.nodes ?? []) : (data?.nodes ?? [])
  const edges = isEntry ? (entryData?.edges ?? []) : (data?.edges ?? [])
  const graphLoading = isEntry ? entryLoading : loading
  const graphError = isEntry ? entryError : error

  const { flowNodes, flowEdges, edgeCounts } = useMemo<{
    flowNodes: Node<KnowledgeNodeData>[]
    flowEdges: Edge[]
    edgeCounts: { link: number; related: number; tag: number; content: number; ref: number }
  }>(() => {
    // —— 条目级（S5.1）——
    // 内核已给出**条目级、双向、去重**的三类关联边（tag/content/ref），所以本层：
    //   · 不再合并关联层（关联就是本层的主体，不是可叠加的图层）
    //   · 没有显式链接层（doc→doc 的链接是**文档间**关系，硬映射到条目=造假；spec s51 §5.1）
    //   · 不画 duplicate（去重提示不是阅读路径，S5 §5.5）
    if (isEntry) {
      const ec = edges.filter(e => e && e.from && e.to)
      const epos = new Map(layoutGraph(nodes, ec).map(p => [p.id, p]))
      const edeg = nodeDegrees(ec)
      const counts = { link: 0, related: 0, tag: 0, content: 0, ref: 0 }
      const efs: Edge[] = ec.map(e => {
        const k = e.kind === 'tag' || e.kind === 'ref' ? e.kind : 'content'
        counts[k] += 1
        counts.related += 1
        // 三类边用**线型 + 粗细**区分（禁裸 hex，全走既有 token）：
        //   tag   同主题 → 细实线（结构层）
        //   content 相似 → 虚线（自动派生，读作"轻建议"）
        //   ref   引用   → 点线且更粗（**人写的意图**，最该被注意到）
        return {
          id: `${e.from}|${e.to}`, source: e.from, target: e.to, type: 'kb',
          data: { target: shortRef(e.to), layer: 'related' } as KnowledgeEdgeData,
          style: k === 'tag'
            ? { stroke: 'var(--border-strong)', strokeWidth: 1 }
            : k === 'ref'
              ? { stroke: 'var(--border-strong)', strokeWidth: 2, strokeDasharray: '1 3' }
              : { stroke: 'var(--border-strong)', strokeWidth: 1, strokeDasharray: '4 3' },
        }
      })
      return {
        // label 直接用内核给的摘要（已是"去类型前缀 + 前 40 字"）；spaceId 位放 docId，
        // 供节点组件在需要时显示来源文档——条目 id 是 `docId#n`，label 里不带文档名会认不出归属
        flowNodes: nodes.map<Node<KnowledgeNodeData>>(n => ({
          id: n.id,
          type: 'kb',
          position: epos.get(n.id) ?? { x: 0, y: 0 },
          data: { label: labelOf(n), spaceId: n.docId ?? n.spaceId, degree: edeg.get(n.id) ?? 0 },
          draggable: false,
        })),
        flowEdges: efs,
        edgeCounts: counts,
      }
    }

    const live = resolvedEdges(nodes, edges)
    const pos = new Map(layoutGraph(nodes, edges).map(p => [p.id, p]))
    const deg = nodeDegrees(live)
    // 两层边合并（去重 / 同无序对优先显式 / 自环剔除 / 计数）在纯函数里，见 lib/knowledgeRelations
    const { edges: merged, counts } = mergeGraphEdges(live, relatedEdges, showRelated)
    const fs: Edge[] = merged.map(e => ({
      id: e.id, source: e.from, target: e.to, type: 'kb',
      data: { target: e.target || e.to, layer: e.layer } as KnowledgeEdgeData,
      // 视觉区分（禁裸 hex → 全部走 token）：
      //   显式链接 = 实线 + --border-default（S2 既有视觉，一行不动）
      //   隐式关联 = 虚线 + --border-strong（更强的底色），读作"轻建议"而不是"硬引用"
      style: e.layer === 'link'
        ? { stroke: 'var(--border-default)', strokeWidth: 1 }
        : { stroke: 'var(--border-strong)', strokeWidth: 1, strokeDasharray: '4 3' },
    }))
    return {
      flowNodes: nodes.map<Node<KnowledgeNodeData>>(n => ({
        id: n.id,
        type: 'kb',
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        data: { label: labelOf(n), spaceId: n.spaceId, degree: deg.get(n.id) ?? 0 },
        draggable: false,
      })),
      flowEdges: fs,
      // 文档级没有这三类**条目级**边（tag/content/ref 都是条目间关系）→ 恒 0。
      // 不为"省三个字段"而省略：两个分支的 `edgeCounts` 必须同形，
      // 否则 TS 会把联合类型按第一个分支收窄（这里曾报 `Property 'tag' does not exist`）。
      edgeCounts: { link: counts.link, related: counts.related, tag: 0, content: 0, ref: 0 },
    }
  }, [nodes, edges, relatedEdges, showRelated, isEntry])

  const openDoc = (docId: string, line?: number | null) => {
    const st = useKnowledgeStore.getState()
    st.setDocId(docId)      // 顺带清 targetLine（行号只对上一篇有意义）
    // 条目级图点的是一条**具体条目**，不定位就等于"点进去还得自己找"（S5.1）。
    // 顺序不能反：setDocId 会清 targetLine，必须先设文档再设行号。
    if (typeof line === 'number' && line > 0) st.setTargetLine(line)
    st.setView('read')
  }

  /** 条目节点点击 → 打开所属文档 + 定位到该块。`docId` 缺省时从 `docId#n` 里切（兜底不抛） */
  const openEntry = (entryId: string) => {
    const n = nodes.find(x => x.id === entryId)
    if (!n) return
    openDoc(n.docId ?? entryId.split('#')[0], n.line ?? null)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 h-8 flex items-center gap-2 px-3 border-b border-default">
        {/* 层级分段控件（S5.1 用户实测反馈驱动）：
            · 文档级 = 文件**之间**的显式链接 + 关联（S2/S5 既有）
            · 条目级 = 文件**内部**每条经验之间的关系（真实库 74/76 条挤在一个文件里，
              文档级看不到任何条目间关系，条目级才有信息量） */}
        <div className="shrink-0 flex items-center clip-sm border border-default" role="group" aria-label={t('knowledge.graphLevel')}>
          {(['doc', 'entry'] as const).map(lv => (
            <button
              key={lv}
              type="button"
              onClick={() => setLevel(lv)}
              aria-pressed={level === lv}
              title={lv === 'entry' ? t('knowledge.graphLevelEntryHint') : t('knowledge.graphHint')}
              className={cn(
                'px-1.5 py-0.5 text-[10px] transition-colors',
                level === lv ? 'bg-accent-subtle text-primary' : 'text-secondary hover:text-primary',
              )}
            >
              {lv === 'entry' ? t('knowledge.graphLevelEntry') : t('knowledge.graphLevelDoc')}
            </button>
          ))}
        </div>
        {isEntry ? (
          <>
            <span className="micro shrink-0">{t('knowledge.graphEntryCount', { n: nodes.length })}</span>
            <span className="micro shrink-0">{t('knowledge.graphEdgeTag')} {edgeCounts.tag}</span>
            <span className="micro shrink-0">{t('knowledge.graphEdgeContent')} {edgeCounts.content}</span>
            {/* 引用数只在**真的存在**时才显示：恒显一个 0 会让人以为"引用功能坏了" */}
            {edgeCounts.ref > 0 && (
              <span className="micro shrink-0">{t('knowledge.graphEdgeRef')} {edgeCounts.ref}</span>
            )}
            {entryData?.truncated && (
              <span className="micro shrink-0">{t('knowledge.graphEntryTruncated', { n: nodes.length })}</span>
            )}
          </>
        ) : (
          <>
            <span className="micro shrink-0">{t('knowledge.graphDocCount', { n: nodes.length })}</span>
            <span className="micro shrink-0">{t('knowledge.graphLinkCount', { n: edgeCounts.link })}</span>
            {/* 图层开着时显示隐式边数：加载中显示"…"而不是 0 —— 0 会被读成"没有关联"，与"还没加载"混淆 */}
            {showRelated && (
              <span className="micro shrink-0">
                {relatedLoading ? t('knowledge.graphRelatedLoading') : t('knowledge.graphRelatedCount', { n: edgeCounts.related })}
              </span>
            )}
          </>
        )}
        <span className="flex-1 min-w-0" />
        {/* 关联图层开关只在**文档级**有意义：条目级的边本身就是关联，没有"图层"可叠（spec s51 §5.1） */}
        {!isEntry && (
          <button
            type="button"
            onClick={() => setShowRelated(v => !v)}
            aria-pressed={showRelated}
            title={t('knowledge.graphLayerRelatedHint')}
            className={cn(
              'shrink-0 flex items-center gap-1 clip-sm border px-1.5 py-0.5 text-[10px] transition-colors',
              showRelated
                ? 'border-strong bg-accent-subtle text-primary'
                : 'border-default text-secondary hover:text-primary',
            )}
          >
            <Layers className="w-3 h-3" />
            {t('knowledge.graphLayerRelated')}
          </button>
        )}
        <KnowledgeScopeToggle all={allSpaces} onChange={setAllSpaces} />
      </div>

      {/* min-h-0 + relative：xyflow 的根元素按父容器 100% 撑开，父级没有确定高度时画布高度为 0 */}
      <div className="flex-1 min-h-0 relative">
        {graphError ? (
          <KnowledgeEmpty title={t('knowledge.loadFailed')} hint={graphError} className="m-auto" />
        ) : graphLoading && !nodes.length ? (
          <KnowledgeSkeleton lines={8} />
        ) : !nodes.length ? (
          <KnowledgeEmpty
            title={isEntry ? t('knowledge.graphEntryEmpty') : t('knowledge.graphEmpty')}
            hint={isEntry ? t('knowledge.graphEntryHint') : t('knowledge.graphHint')}
            className="m-auto"
          />
        ) : nodes.length === 1 ? (
          // 单节点图：画出来只有一个孤岛，毫无信息量，给文案比给画布更有用
          <KnowledgeEmpty
            title={t('knowledge.graphSingle')}
            hint={isEntry ? t('knowledge.graphEntryHint') : t('knowledge.graphHint')}
            className="m-auto"
          />
        ) : (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // 条目级点节点要**定位到块**（只用 id 打开文档的话，等于点进去还得自己找）
            onNodeClick={(_, n) => (isEntry ? openEntry(n.id) : openDoc(n.id))}
            nodesDraggable={false}
            nodesConnectable={false}
            // 图谱是**只读视图**：Delete 键在这里不该有任何后果（本视图从不改数据）
            deleteKeyCode={null}
            fitView
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            {/* showInteractive 关掉：那个锁图标控制"是否可交互"，本视图永远可交互，留着只会误导 */}
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}

/** 节点标题：label 为空时退回 docId 末段（空标题在图上是一个无名方块，等于没画） */
function labelOf(n: KnowledgeGraphNode): string {
  const label = String(n.label ?? '').trim()
  return label || shortRef(n.id)
}
