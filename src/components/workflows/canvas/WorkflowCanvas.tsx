// src/components/workflows/canvas/WorkflowCanvas.tsx —— xyflow 画布（UI Task 13）
//
// 数据流（brief Step 6 + 风险③）：
//   model（唯一真相，父组件持有）──toFlow──▶ 画布 nodes/edges state
//   画布编辑（拖动/连线/删除/配置）──fromFlow──▶ onChange(model)  ← **300ms 节流**
//   保存前父组件必须调 flush()：节流窗口内的最后一次编辑否则会丢（「改了立刻保存」场景）。
//   flush 用 forwardRef + useImperativeHandle 暴露，返回**最新 model** 并顺带提交 onChange。
//
// 与运行态的关系（Task 14 消费点）：
//   nodeStatus / edgeState 由外部注入（withRunState 叠加到 data.status / data.data.state），
//   **不进入 DSL**（fromFlow 只回填白名单字段），所以运行着色不会污染落盘内容。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type EdgeChange, type NodeChange, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { WorkflowNode } from './nodes/WorkflowNode'
import { WorkflowEdge } from './edges/WorkflowEdge'
import { NodePalette, NODE_DND_MIME } from './NodePalette'
import { ConfigPanel } from './ConfigPanel'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui'
import { Copy, Maximize2, MousePointer2, Trash2, Undo2, Unlink } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  defaultConfig, describeRemoval, fromFlow, nextEdgeId, nextNodeId,
  removeEdgesFromModel, removeNodesFromModel, toFlow, withRunState,
  type FlowEdge, type FlowNode, type NodeRunStatus, type RemovalImpact, type WorkflowModel,
} from '@/lib/workflowModel'

export interface WorkflowCanvasHandle {
  /** 提交并返回最新 model（保存/校验/运行前必须调用；节流窗口内的改动由此落定） */
  flush: () => WorkflowModel
}

export interface WorkflowCanvasProps {
  model: WorkflowModel
  /** 节流后的模型回写（父组件 setModel；不负责标脏语义之外的事） */
  onChange: (next: WorkflowModel) => void
  /** 运行态节点着色（Task 14 RunDrawer 注入；缺省全 idle） */
  nodeStatus?: Record<string, NodeRunStatus>
  /** 运行态边高亮：active=实线加亮，skipped=虚线淡化（Task 14 注入） */
  edgeState?: Record<string, 'active' | 'skipped'>
  /** 选中节点变化（父组件可据此显示面包屑/定位） */
  onSelectNode?: (id: string | null) => void
}

/** ReactFlow 要求 nodeTypes/edgeTypes 表稳定引用（每次 render 新建对象会导致整图重挂载） */
const nodeTypes = { yfw: WorkflowNode }
const edgeTypes = { yfw: WorkflowEdge }
const WRITEBACK_MS = 300

export const WorkflowCanvas = forwardRef<WorkflowCanvasHandle, WorkflowCanvasProps>(function WorkflowCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} canvasRef={ref} />
    </ReactFlowProvider>
  )
})

function CanvasInner({ model, onChange, nodeStatus, edgeState, onSelectNode, canvasRef }: WorkflowCanvasProps & {
  canvasRef: React.Ref<WorkflowCanvasHandle>
}) {
  const initials = useMemo(() => toFlow(model), [])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initials.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(initials.edges)
  const [selected, setSelected] = useState<string | null>(null)
  /** 画布选择集（节点 + 连线）：框选 / Ctrl·Shift 点选 / ReactFlow 原生多选均落在这里。
   *  配置面板仍只看单选节点 `selected`；删除走选择集，支持"选中多个一起删"（2026-09-12 UX）。 */
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([])
  /** 待确认的删除（节点 id 列表）：破坏性且在图上"看不见后果"，故先给影响面再删 */
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null)
  /** 右键菜单（节点/连线/空白三态；坐标用 clientX/Y + fixed 定位，免去容器换算） */
  const [menu, setMenu] = useState<null | { x: number; y: number; kind: 'node' | 'edge' | 'pane'; id?: string }>(null)
  /** 删除撤销栈：破坏性操作前压入快照（上限 50），撤销即回放（2026-09-12 UX"删除后可撤销"）。
   *  用 state 计数驱动按钮显隐（ref 本身不引发渲染）。 */
  const historyRef = useRef<WorkflowModel[]>([])
  const [undoCount, setUndoCount] = useState(0)
  const rf = useReactFlow()

  // 最新 model 引用：节流回调与 flush 都基于它派生（避免闭包读到旧 model 丢字段）
  const modelRef = useRef(model)
  modelRef.current = model
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const nodesRef = useRef(nodes); nodesRef.current = nodes
  const edgesRef = useRef(edges); edgesRef.current = edges

  /** 画布内容指纹：仅位置/handle/边集合参与比较——data.status 等运行态不参与，避免自激 */
  const signature = useCallback((ns: readonly FlowNode[], es: readonly FlowEdge[]) => JSON.stringify({
    n: ns.map((n) => [n.id, n.data.nodeType, n.position.x, n.position.y, n.data.label]),
    e: es.map((e) => [e.id, e.source, e.target, e.sourceHandle ?? '']),
  }), [])
  const baselineRef = useRef(signature(initials.nodes, initials.edges))

  // —— 节流回写：300ms 内多次拖动只提交一次（brief 风险③）——
  useEffect(() => {
    const sig = signature(nodes, edges)
    if (sig === baselineRef.current) return
    const timer = setTimeout(() => {
      baselineRef.current = sig
      onChangeRef.current(fromFlow(nodes, edges, modelRef.current))
    }, WRITEBACK_MS)
    return () => clearTimeout(timer)
  }, [nodes, edges, signature])

  useImperativeHandle(canvasRef, () => ({
    flush: () => {
      const ns = nodesRef.current, es = edgesRef.current
      const sig = signature(ns, es)
      if (sig === baselineRef.current) return modelRef.current
      baselineRef.current = sig
      const next = fromFlow(ns, es, modelRef.current)
      onChangeRef.current(next)
      return next
    },
  }), [signature])

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge({
      ...c,
      id: nextEdgeId(es as FlowEdge[], String(c.source), String(c.target), c.sourceHandle ?? undefined),
    }, es) as FlowEdge[])
  }, [setEdges])

  /** 插入节点：position 取视口中心（拖拽落点则在指针处），id/position 递增避重叠 */
  const addNode = useCallback((type: string, at?: { x: number; y: number }) => {
    // id 去重必须同时看 model 与画布：父组件的 model 落后画布 300ms，连点两次会撞同一个 n1
    const id = nextNodeId(
      { ...modelRef.current, nodes: [...modelRef.current.nodes, ...nodesRef.current.map((n) => ({ id: n.id, type: n.data.nodeType }))] },
      '',
    )
    const pos = at ?? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    setNodes((ns) => [...ns, {
      id, type: 'yfw',
      position: { x: Math.round(pos.x) - 90, y: Math.round(pos.y) - 24 },
      data: { label: '', nodeType: type, config: defaultConfig(type) },
    } as FlowNode])
    setSelected(id)
    onSelectNode?.(id)
  }, [rf, setNodes, onSelectNode])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData(NODE_DND_MIME)
    if (!type) return
    addNode(type, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }, [addNode, rf])

  // 配置面板改动：套到**画布当前内容**上（父组件的 model 可能落后于画布 300ms 内的编辑，
  // 直接整体替换会丢掉刚拖进来/刚连上的节点与边）——存在性/位置/边集合以画布为准，
  // 只有配置面板真正编辑的字段（label/config）取自传入的 next。
  const onConfigChange = useCallback((next: WorkflowModel) => {
    const canvasNodes = nodesRef.current
    const nextById = new Map(next.nodes.map((n) => [n.id, n]))
    const mergedNodes: FlowNode[] = canvasNodes.map((fn) => {
      const n = nextById.get(fn.id)
      if (!n) return fn  // 画布新增且尚未回写 model 的节点：保留原样
      return { ...fn, data: { ...fn.data, label: n.label ?? '', nodeType: n.type, config: n.config ?? {} } }
    })
    const onCanvas = new Set(canvasNodes.map((n) => n.id))
    for (const n of next.nodes) {
      if (onCanvas.has(n.id)) continue
      mergedNodes.push({
        id: n.id, type: 'yfw',
        position: n.position ?? { x: 0, y: 0 },
        data: { label: n.label ?? '', nodeType: n.type, config: n.config ?? {} },
      })
    }
    setNodes(mergedNodes)
    // 边的集合/端点以画布为准（配置面板不编辑边）
    const merged = fromFlow(mergedNodes, edgesRef.current, next)
    baselineRef.current = signature(mergedNodes, edgesRef.current)
    onChangeRef.current(merged)
  }, [setNodes, signature])

  // —— 删除（三个入口：节点 × / 连线 × / Delete·Backspace 键）——
  // 关键：删除必须做**语义清理**（相连边 / loop·iterate 的 body 成员 / 他处悬空变量引用）。
  // 只从画布移除是不够的：删掉被引用的节点后，其他节点 config 里的 {{id.x}} 会悬空，
  // 保存会被内核 VAR_UNREACHABLE 拒绝 → "删了却存不了"（2026-09-12 人工测试暴露的缺口）。
  const [notices, setNotices] = useState<string[]>([])
  useEffect(() => {
    if (!notices.length) return
    const t = setTimeout(() => setNotices([]), 5000)
    return () => clearTimeout(t)
  }, [notices])

  /** 用清理后的模型覆盖画布并**立即**回写（不走 300ms 节流：破坏性操作不留中间态） */
  const applyModel = useCallback((next: WorkflowModel) => {
    const f = toFlow(next)
    setNodes(f.nodes)
    setEdges(f.edges)
    baselineRef.current = signature(f.nodes, f.edges)
    onChangeRef.current(next)
  }, [setNodes, setEdges, signature])

  /** 画布当前内容（确认框与执行都以它为准，而非落后 300ms 的父组件 model） */
  const currentModel = useCallback(() => fromFlow(nodesRef.current, edgesRef.current, modelRef.current), [])

  /** 破坏性操作前留档（撤销用）。只记"删除前"的快照——拖拽/配置编辑有 300ms 节流回写，
   *  把它们也入栈会让 Ctrl+Z 的语义变得不可预期（撤销到底退到哪一步说不清）。 */
  const pushHistory = useCallback(() => {
    historyRef.current = [...historyRef.current, currentModel()].slice(-50)
    setUndoCount(historyRef.current.length)
  }, [currentModel])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (!h.length) return
    const prev = h[h.length - 1]
    historyRef.current = h.slice(0, -1)
    setUndoCount(historyRef.current.length)
    applyModel(prev)
    setNotices(['已撤销上一步删除'])
  }, [applyModel])

  // Ctrl/Cmd+Z 撤销删除。输入控件内不接管（那里应走浏览器原生撤销，否则会吞掉用户的文字撤销）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || String(e.key).toLowerCase() !== 'z') return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
      if (!historyRef.current.length) return
      e.preventDefault()
      undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo])

  const commitDeleteNodes = useCallback((ids: string[]) => {
    if (!ids.length) return
    pushHistory()
    const { model: cleaned, warnings } = removeNodesFromModel(currentModel(), ids)
    // removeNodesFromModel 会保留 start（不可删）→ applyModel 顺带把它"恢复"回画布
    applyModel(cleaned)
    if (warnings.length) setNotices(warnings)
    setSelectedIds([])
    setSelected(null)
    onSelectNode?.(null)
  }, [applyModel, currentModel, onSelectNode, pushHistory])

  const deleteNodes = useCallback((ids: string[]) => {
    if (!ids.length) return
    // 一律二次确认（2026-09-12 UX 明确要求）：删除会改动**别的**节点的配置（清空悬空引用）、
    // 摘除子图成员、连带删边——这些后果在画布上看不见，必须知情后再动手。
    // 有撤销栈兜底，但撤销不该替代"先说清再删"。
    setPendingDelete(ids)
  }, [])

  /** 复制节点（右键菜单）：新 id + 位移，配置深拷（避免两个节点共享同一 config 对象） */
  const duplicateNode = useCallback((id: string) => {
    const src = nodesRef.current.find((n) => String(n.id) === id)
    if (!src) return
    pushHistory()
    const newId = nextNodeId({ ...modelRef.current, nodes: [...modelRef.current.nodes, ...nodesRef.current.map((n) => ({ id: n.id, type: n.data.nodeType }))] }, '')
    setNodes((ns) => [...ns, {
      ...src,
      id: newId,
      selected: false,
      position: { x: src.position.x + 40, y: src.position.y + 40 },
      data: { ...src.data, config: JSON.parse(JSON.stringify(src.data.config ?? {})) },
    } as FlowNode])
    setSelected(newId)
    onSelectNode?.(newId)
  }, [onSelectNode, pushHistory, setNodes])

  /** 断开某节点的全部连线（右键菜单；节点本身保留） */
  const detachNode = useCallback((id: string) => {
    const ids = edgesRef.current.filter((e) => String(e.source) === id || String(e.target) === id).map((e) => String(e.id))
    if (!ids.length) return
    pushHistory()
    applyModel(removeEdgesFromModel(currentModel(), ids))
    setNotices([`已断开 ${ids.length} 条连线`])
  }, [applyModel, currentModel, pushHistory])

  const deleteEdges = useCallback((ids: string[]) => {
    if (!ids.length) return
    applyModel(removeEdgesFromModel(currentModel(), ids))
    setSelectedEdgeIds([])
  }, [applyModel, currentModel])

  /** 批量删除（工具栏）：节点与连线一并处理，节点走确认（若需要） */
  const deleteSelection = useCallback(() => {
    const nodeIds = selectedIds
    const edgeIds = selectedEdgeIds
    if (edgeIds.length) deleteEdges(edgeIds)
    if (nodeIds.length) deleteNodes(nodeIds)
  }, [deleteEdges, deleteNodes, selectedEdgeIds, selectedIds])

  const view = useMemo(() => withRunState(nodes, edges, nodeStatus, edgeState), [nodes, edges, nodeStatus, edgeState])

  // 删除入口注入：nodeTypes/edgeTypes 表必须保持稳定引用，故回调走 data 下发
  const viewNodes = useMemo(() => view.nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      // start 不可删（内核要求唯一入口）；按钮不渲染，Delete 键由 model 层 blocked 兜底
      canDelete: (n.data as { nodeType?: string }).nodeType !== 'start',
      onDelete: deleteNodes,
    },
  })), [view.nodes, deleteNodes])

  // 运行态高亮的边：active 实线加亮 / skipped 虚线淡化（叠加删除回调与自定义边类型）
  const styledEdges = useMemo(() => view.edges.map((e) => {
    const base = { ...e, type: 'yfw' as const, data: { ...(e.data || {}), onDelete: deleteEdges } }
    const state = e.data?.state
    if (state === 'active') return { ...base, style: { stroke: 'var(--brand-500)', strokeWidth: 2 } }
    if (state === 'skipped') return { ...base, style: { stroke: 'var(--text-tertiary)', strokeDasharray: '4 4' } }
    return base
  }), [view.edges, deleteEdges])

  const nodeSel = model.nodes.find((n) => n.id === selected) || null

  /** 删除变更统一由 onNodesDelete / onEdgesDelete → deleteNodes/deleteEdges 处理：
   *  那里会做语义清理（连带边、子图成员、悬空引用）并按需弹确认。若在 onNodesChange 里
   *  直接应用 remove，画布会先出现"节点没了但引用还在"的中间态，还可能绕过确认框。 */
  const handleNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    onNodesChange(changes.filter((c) => c.type !== 'remove') as NodeChange<FlowNode>[])
  }, [onNodesChange])
  const handleEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    onEdgesChange(changes.filter((c) => c.type !== 'remove') as EdgeChange<FlowEdge>[])
  }, [onEdgesChange])

  /** 选择集同步（框选 / Ctrl·Shift 点选 / 原生多选都走这里）：批量删除的依据 */
  const onSelectionChange = useCallback(({ nodes: ns, edges: es }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
    setSelectedIds(ns.map((n) => String(n.id)))
    setSelectedEdgeIds(es.map((e) => String(e.id)))
  }, [])

  /** 待确认删除的影响面（删除会改动别的节点的配置时必须先说清） */
  const pendingImpact = useMemo<RemovalImpact | null>(
    () => (pendingDelete ? describeRemoval(currentModel(), pendingDelete) : null),
    [pendingDelete, currentModel],
  )
  const pendingNames = useMemo(() => {
    if (!pendingDelete) return []
    const byId = new Map(nodesRef.current.map((n) => [String(n.id), String(n.data.label || n.data.nodeType || n.id)]))
    return pendingDelete.map((id) => `${byId.get(id) || id}（${id}）`)
  }, [pendingDelete])

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      <NodePalette onAdd={(t) => addNode(t)} />

      <div className="flex-1 min-w-0 relative bg-app/40" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}>
        <ReactFlow
          nodes={viewNodes}
          edges={styledEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          deleteKeyCode={['Delete', 'Backspace']}
          onNodesDelete={(ds) => deleteNodes((ds as FlowNode[]).map((n) => n.id))}
          onEdgesDelete={(es) => deleteEdges((es as FlowEdge[]).map((e) => e.id))}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onSelectionChange={onSelectionChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => { setSelected(n.id); onSelectNode?.(n.id) }}
          onPaneClick={() => { setSelected(null); onSelectNode?.(null); setMenu(null) }}
          // 右键菜单（2026-09-12 UX 明确要求）：节点/连线/空白三态，动作见菜单渲染处
          onNodeContextMenu={(e, n) => { e.preventDefault(); setSelected(n.id); onSelectNode?.(n.id); setMenu({ x: e.clientX, y: e.clientY, kind: 'node', id: n.id }) }}
          onEdgeContextMenu={(e, ed) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', id: ed.id }) }}
          onPaneContextMenu={(e) => { e.preventDefault(); setMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, kind: 'pane' }) }}
          // 多选删除（2026-09-12 UX："元素删除选择"）：左键拖 = 框选（与白板/Figma 同手感），
          // 平移改由中键/右键或空格+拖承担——否则左键被平移占用，框选无从触发。
          selectionOnDrag
          panOnDrag={[1, 2]}
          panActivationKeyCode="Space"
          fitView
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls />
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
        </ReactFlow>

        {/* 选择工具条：选中即出现，给出"已选什么 / 一起删 / 取消选择"（批量删除的唯一入口） */}
        {(selectedIds.length > 0 || selectedEdgeIds.length > 0 || undoCount > 0) && (
          <div className="absolute top-3 left-3 z-20 flex items-center gap-2 px-2 py-1.5 rounded border border-default bg-elevated/95 text-[11px] text-secondary shadow">
            {(selectedIds.length > 0 || selectedEdgeIds.length > 0) && (
              <>
                <span>
                  已选 {selectedIds.length} 个节点{selectedEdgeIds.length ? ` · ${selectedEdgeIds.length} 条连线` : ''}
                </span>
                <Button size="xs" variant="ghost" className="text-error" onClick={deleteSelection} title="删除已选（删除前会先确认影响面）">
                  <Trash2 className="w-3 h-3" />删除已选
                </Button>
              </>
            )}
            {/* 撤销删除：删除是破坏性且在图上不可见后果，必须给后悔药（Ctrl/Cmd+Z 同效） */}
            {undoCount > 0 && (
              <Button size="xs" variant="ghost" onClick={undo} title={`撤销上一步删除（Ctrl+Z，可撤销 ${undoCount} 步）`}>
                <Undo2 className="w-3 h-3" />撤销
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => { rf.setNodes((ns) => ns.map((n) => ({ ...n, selected: false }))); rf.setEdges((es) => es.map((e) => ({ ...e, selected: false }))); setSelectedIds([]); setSelectedEdgeIds([]); setSelected(null); onSelectNode?.(null) }}>
              取消选择
            </Button>
          </div>
        )}

        {/* 右键菜单（节点 / 连线 / 空白）：删除、复制、断开、全选、适应视图 */}
        {menu && (
          <>
            {/* 点击任意处关闭：透明遮罩放在菜单下层，避免菜单自身点击被吞 */}
            <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
            <div className="fixed z-40 min-w-[168px] py-1 rounded border border-default bg-elevated shadow-lg text-[11px] text-secondary" style={{ left: menu.x, top: menu.y }}>
              {menu.kind === 'node' && menu.id && (
                <>
                  <MenuItem icon={Copy} label="复制节点" onClick={() => { setMenu(null); duplicateNode(menu.id!) }} />
                  <MenuItem icon={Unlink} label="断开全部连线" onClick={() => { setMenu(null); detachNode(menu.id!) }} />
                  <MenuItem icon={Trash2} label="删除节点" danger onClick={() => { setMenu(null); deleteNodes([menu.id!]) }} />
                </>
              )}
              {menu.kind === 'edge' && menu.id && (
                <>
                  <MenuItem icon={Unlink} label="删除连线" onClick={() => { setMenu(null); const id = menu.id!; pushHistory(); applyModel(removeEdgesFromModel(currentModel(), [id])) }} />
                  <MenuItem icon={Trash2} label="删除源节点" danger onClick={() => {
                    const ed = edgesRef.current.find((e) => String(e.id) === menu.id)
                    setMenu(null)
                    if (ed) deleteNodes([String(ed.source)])
                  }} />
                  <MenuItem icon={Trash2} label="删除目标节点" danger onClick={() => {
                    const ed = edgesRef.current.find((e) => String(e.id) === menu.id)
                    setMenu(null)
                    if (ed) deleteNodes([String(ed.target)])
                  }} />
                </>
              )}
              {menu.kind === 'pane' && (
                <>
                  <MenuItem icon={MousePointer2} label="全选" onClick={() => {
                    setMenu(null)
                    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })))
                    setEdges((es) => es.map((e) => ({ ...e, selected: true })))
                    setSelectedIds(nodesRef.current.map((n) => String(n.id)))
                    setSelectedEdgeIds(edgesRef.current.map((e) => String(e.id)))
                  }} />
                  <MenuItem icon={Maximize2} label="适应视图" onClick={() => { setMenu(null); void rf.fitView({ padding: 0.2 }) }} />
                  {undoCount > 0 && <MenuItem icon={Undo2} label="撤销上一步删除" onClick={() => { setMenu(null); undo() }} />}
                </>
              )}
            </div>
          </>
        )}

        {/* 删除结果提示（清了几条边、清空了哪些悬空引用——破坏性操作必须说清动了什么） */}
        {notices.length > 0 && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-[560px] px-3 py-1.5 rounded text-[11px] bg-elevated/95 border border-default text-secondary shadow">
            {notices.join(' · ')}
          </div>
        )}

        {/* 操作提示（删除入口的可发现性：此前完全没有可见入口，用户只能猜） */}
        <div className="absolute bottom-9 left-3 text-[10px] text-tertiary bg-elevated/80 rounded px-2 py-1 pointer-events-none">
          拖动节点连线 · 左键框选 / Ctrl·Shift 点选多选 · 右键菜单（复制 / 断开 / 删除） · Delete 删除（可 Ctrl+Z 撤销）
        </div>

        {/* 条件边图例（分色语义与 WorkflowNode handle 同源） */}
        <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[10px] text-tertiary bg-elevated/80 rounded px-2 py-1 pointer-events-none">
          {[['var(--brand-500)', 'true'], ['var(--text-tertiary)', 'false'], ['linear-gradient(90deg, var(--brand-500), var(--info))', 'route:i'], ['var(--error)', 'fail']].map(([bg, label]) => (
            <span key={label} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: bg }} />{label}
            </span>
          ))}
        </div>

        {/* 批量删除确认：把"会动什么"摊开——多删一个节点往往连带清掉别处的引用，图上不可见 */}
        <Dialog open={!!pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(null) }}>
          <DialogContent size="sm">
            <DialogHeader><DialogTitle>删除 {pendingDelete?.length ?? 0} 个节点？</DialogTitle></DialogHeader>
            <DialogBody>
              <div className="text-[11px] text-secondary flex flex-col gap-2">
                <div className="flex flex-wrap gap-1">
                  {pendingNames.map((n) => <span key={n} className="px-1.5 py-0.5 rounded bg-elevated font-mono text-[10px]">{n}</span>)}
                </div>
                {pendingImpact && (
                  <ul className="flex flex-col gap-0.5 text-[11px] text-tertiary">
                    <li>· 一并移除相连连线 {pendingImpact.edgesRemoved} 条</li>
                    {pendingImpact.bodyCleanups > 0 && <li>· 从循环/迭代子图成员中摘除 {pendingImpact.bodyCleanups} 处</li>}
                    {pendingImpact.refsScrubbed > 0 && (
                      <li className="text-warning">
                        · 清空他处悬空变量引用 {pendingImpact.refsScrubbed} 处（不清则保存会被内核拒绝）
                        <div className="mt-0.5 flex flex-col gap-0.5 text-[10px] font-mono">
                          {pendingImpact.refDetails.slice(0, 8).map((d) => <span key={d}>{d}</span>)}
                          {pendingImpact.refDetails.length > 8 && <span>…另有 {pendingImpact.refDetails.length - 8} 处</span>}
                        </div>
                      </li>
                    )}
                    {pendingImpact.blocked.length > 0 && <li className="text-warning">· 开始节点不可删除，将被保留</li>}
                  </ul>
                )}
              </div>
            </DialogBody>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => setPendingDelete(null)}>取消</Button>
              <Button size="sm" className="text-error" onClick={() => { const ids = pendingDelete || []; setPendingDelete(null); commitDeleteNodes(ids) }}>
                <Trash2 className="w-3.5 h-3.5" />确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <ConfigPanel
        model={model}
        nodeId={nodeSel?.id ?? null}
        onChange={onConfigChange}
      />
    </div>
  )
}

/** 供父组件按需获取视口实例（导出以便扩展；当前未使用） */
export type { ReactFlowInstance }

/** 右键菜单项（图标 + 文案 + 危险态着色）；点击后由调用方负责关闭菜单 */
function MenuItem({ icon: Icon, label, onClick, danger }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover', danger ? 'text-error' : 'text-secondary')}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />{label}
    </button>
  )
}
