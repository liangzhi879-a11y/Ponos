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
import { NodePalette, NODE_DND_MIME } from './NodePalette'
import { ConfigPanel } from './ConfigPanel'
import {
  defaultConfig, fromFlow, nextEdgeId, nextNodeId, toFlow, withRunState,
  type FlowEdge, type FlowNode, type NodeRunStatus, type WorkflowModel,
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

/** ReactFlow 要求 nodeTypes 表稳定引用（每次 render 新建对象会导致整图重挂载） */
const nodeTypes = { yfw: WorkflowNode }
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
  const initial = useMemo(() => toFlow(model), [])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(initial.edges)
  const [selected, setSelected] = useState<string | null>(null)
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
  const baselineRef = useRef(signature(initial.nodes, initial.edges))

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

  const view = useMemo(() => withRunState(nodes, edges, nodeStatus, edgeState), [nodes, edges, nodeStatus, edgeState])
  // 运行态高亮的边：active 实线加亮 / skipped 虚线淡化
  const styledEdges = useMemo(() => view.edges.map((e) => {
    const state = e.data?.state
    if (state === 'active') return { ...e, style: { stroke: 'var(--brand-500)', strokeWidth: 2 } }
    if (state === 'skipped') return { ...e, style: { stroke: 'var(--text-tertiary)', strokeDasharray: '4 4' } }
    return e
  }), [view.edges])

  const nodeSel = model.nodes.find((n) => n.id === selected) || null

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      <NodePalette onAdd={(t) => addNode(t)} />

      <div className="flex-1 min-w-0 relative bg-app/40" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}>
        <ReactFlow
          nodes={view.nodes}
          edges={styledEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange as (c: NodeChange<FlowNode>[]) => void}
          onEdgesChange={onEdgesChange as (c: EdgeChange<FlowEdge>[]) => void}
          onConnect={onConnect}
          onNodeClick={(_, n) => { setSelected(n.id); onSelectNode?.(n.id) }}
          onPaneClick={() => { setSelected(null); onSelectNode?.(null) }}
          fitView
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls />
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
        </ReactFlow>

        {/* 条件边图例（分色语义与 WorkflowNode handle 同源） */}
        <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[10px] text-tertiary bg-elevated/80 rounded px-2 py-1 pointer-events-none">
          {[['var(--brand-500)', 'true'], ['var(--text-tertiary)', 'false'], ['linear-gradient(90deg, var(--brand-500), var(--info))', 'route:i'], ['var(--error)', 'fail']].map(([bg, label]) => (
            <span key={label} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: bg }} />{label}
            </span>
          ))}
        </div>
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
