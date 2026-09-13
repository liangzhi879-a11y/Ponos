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
import { useMemo, useState } from 'react'
import { ReactFlow, Background, Controls, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useGraph } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useTranslation } from '@/i18n/useTranslation'
import { layoutGraph, nodeDegrees, resolvedEdges, shortRef } from '@/lib/knowledgeGraph'
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

  // `limit` 不传 = 后端默认 200（kernel/knowledge.mjs:596）；前端**不许**再压小，
  // 压小会让"图谱缺了一大块"看起来像索引坏了。
  const { data, loading, error } = useGraph(allSpaces ? null : spaceId)

  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []

  const { flowNodes, flowEdges, links } = useMemo(() => {
    const live = resolvedEdges(nodes, edges)
    const pos = new Map(layoutGraph(nodes, edges).map(p => [p.id, p]))
    const deg = nodeDegrees(live)
    const seen = new Set<string>()
    const fs: Edge[] = []
    for (const e of live) {
      const id = `${e.from}->${e.to}`
      if (seen.has(id)) continue      // 同一对文档的多条链接合成一条边（否则 xyflow 里 id 重复）
      seen.add(id)
      fs.push({
        id, source: e.from, target: e.to, type: 'kb',
        data: { target: e.target || e.to } as KnowledgeEdgeData,
        style: { stroke: 'var(--border-default)', strokeWidth: 1 },
      })
    }
    return {
      flowNodes: nodes.map<Node<KnowledgeNodeData>>(n => ({
        id: n.id,
        type: 'kb',
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        data: { label: labelOf(n), spaceId: n.spaceId, degree: deg.get(n.id) ?? 0 },
        draggable: false,
      })),
      flowEdges: fs,
      links: fs.length,
    }
  }, [nodes, edges])

  const openDoc = (docId: string) => {
    const st = useKnowledgeStore.getState()
    st.setDocId(docId)      // 顺带清 targetLine（行号只对上一篇有意义）
    st.setView('read')
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 h-8 flex items-center gap-2 px-3 border-b border-default">
        <span className="micro shrink-0">{t('knowledge.graphDocCount', { n: nodes.length })}</span>
        <span className="micro shrink-0">{t('knowledge.graphLinkCount', { n: links })}</span>
        <span className="flex-1 min-w-0" />
        <KnowledgeScopeToggle all={allSpaces} onChange={setAllSpaces} />
      </div>

      {/* min-h-0 + relative：xyflow 的根元素按父容器 100% 撑开，父级没有确定高度时画布高度为 0 */}
      <div className="flex-1 min-h-0 relative">
        {error ? (
          <KnowledgeEmpty title={t('knowledge.loadFailed')} hint={error} className="m-auto" />
        ) : loading && !nodes.length ? (
          <KnowledgeSkeleton lines={8} />
        ) : !nodes.length ? (
          <KnowledgeEmpty title={t('knowledge.graphEmpty')} hint={t('knowledge.graphHint')} className="m-auto" />
        ) : nodes.length === 1 ? (
          // 单节点图：画出来只有一个孤岛，毫无信息量，给文案比给画布更有用
          <KnowledgeEmpty title={t('knowledge.graphSingle')} hint={t('knowledge.graphHint')} className="m-auto" />
        ) : (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, n) => openDoc(n.id)}
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
