// src/components/workflows/canvas/edges/WorkflowEdge.tsx —— 画布自定义边（删除入口之一）
//
// 为什么需要自定义边：默认边没有任何可点的 UI，用户无法删除连线（2026-09-12 人工测试反馈
// 「节点和连线好像没有删除选项」）。这里在连线中点常驻一个淡色 ×，hover/选中时变醒目：
// 既能看见（可发现性），又不至于让画布过分吵闹。
//
// 与状态着色的关系：运行态样式（active 实线加亮 / skipped 虚线淡化）由 WorkflowCanvas 通过
// `style` 传入，直接交给 BaseEdge，本组件不重算颜色。
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'

export function WorkflowEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  markerEnd, style, selected, data,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const onDelete = (data as { onDelete?: (id: string) => void } | undefined)?.onDelete

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <button
          type="button"
          title="删除连线"
          aria-label="删除连线"
          onClick={(e) => { e.stopPropagation(); onDelete?.(id) }}
          // nodrag/nopan：避免点按钮时触发画布拖动或平移；pointerEvents 必须放开（label 层默认不可点）
          className={cn(
            'nodrag nopan absolute w-4 h-4 rounded-full text-[11px] leading-none',
            'flex items-center justify-center border transition-opacity',
            'bg-elevated border-default text-tertiary hover:text-error hover:border-error',
            selected ? 'opacity-100' : 'opacity-40 hover:opacity-100',
          )}
          style={{
            // translate(-50%,-50%) 让按钮以连线中点为中心（className 的 translate 类会被 style 覆盖）
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            zIndex: 10,
          }}
        >
          ×
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
