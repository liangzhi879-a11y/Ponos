// src/components/knowledge/graph/KnowledgeEdge.tsx —— 图谱边（S2 Task 8）
//
// 范式照 `workflows/canvas/edges/WorkflowEdge.tsx`：`BaseEdge` + `EdgeLabelRenderer`，
// 自定义只为补一件内置边做不到的事。
//
// 本组件存在的**唯一**理由：给边一个**方向指示**。知识图谱的边有语义（from 引用 to），
// 内置边只是一条线，"谁指向谁"完全看不出来。两条实现路径：
//   ① xyflow 的 `markerEnd`（SVG `<marker>`）：颜色得写进 `fill`——而 SVG 呈现属性里的
//      `var(--…)` 在部分 Chromium 版本上不生效，会退化成黑色箭头（既丑又违反"只用 token"）；
//   ② CSS 三角形（border 拼出来的箭头）：`borderLeftColor: var(--border-default)` 是**普通 CSS**，
//      token 一定生效。—— 故选 ②。
// 方向恒定"从左往右"：节点布局是左→右（source 在右 Handle、target 在左 Handle，见 KnowledgeNode），
// 贝塞尔曲线无论怎么绕，都是从左向右进入 target 的左侧 Handle，所以箭头画在 target 端朝右永远成立。
//
// S5 Task 9：边分两层（显式链接 / 隐式关联），**视觉必须可区分**（spec §7.5）。线的样式（实线/虚线 +
// 颜色）由视图层通过 `style` 下发，箭头颜色按 `data.layer` 跟随（否则虚线边配实线色箭头，两层糊成一层）。
// 仍然只用 token（`var(--border-default)` / `var(--border-strong)`）——SVG 呈现属性里的 var() 在已知
// 的 Chromium 漏洞上不可靠（见下），而这里是**普通 CSS 属性 borderLeft**，token 一定生效。
//
// 边上不常驻文字标签：200 条边各挂一个标签会让画布糊成一片。选中时才显示链接目标末段名
// （用户点一条边就是在问"这条线通到哪"）。线的颜色/粗细由视图层通过 `style` 下发，本组件不重算。
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { shortRef } from '@/lib/knowledgeGraph'

export interface KnowledgeEdgeData extends Record<string, unknown> {
  /** 链接目标 docId（内核 getGraph 的 `target` 字段） */
  target: string
  /**
   * 边所属图层（S5 Task 9）：'link' 显式链接 / 'related' 隐式关联。
   * 箭头颜色必须随层变 —— 线是虚线、箭头却和实线边同色时，视觉上会把两层读成一层。
   */
  layer?: 'link' | 'related'
}

export function KnowledgeEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, selected, data,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const edgeData = data as KnowledgeEdgeData | undefined
  const target = String(edgeData?.target ?? '')
  // 关联层用 --border-strong（不新造颜色，也不写裸 hex）：线的虚线样式由视图层下发 strokeDasharray
  const arrowColor = edgeData?.layer === 'related' ? 'var(--border-strong)' : 'var(--border-default)'

  return (
    <>
      <BaseEdge id={id} path={path} style={style} />
      {/* 箭头：贴在 target 端 Handle 入口（向里缩 3px，避免压住节点细线） */}
      <EdgeLabelRenderer>
        <span
          aria-hidden
          className="absolute w-0 h-0"
          style={{
            transform: `translate(-50%, -50%) translate(${targetX - 3}px, ${targetY}px)`,
            borderTop: '3.5px solid transparent',
            borderBottom: '3.5px solid transparent',
            borderLeft: `6px solid ${arrowColor}`,
            opacity: selected ? 1 : 0.75,
            pointerEvents: 'none',
          }}
        />
        {selected && target && (
          <span
            className="absolute clip-sm bg-elevated px-1 py-0.5 text-[9px] text-secondary border border-default whitespace-nowrap"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
              zIndex: 10,
            }}
          >
            {shortRef(target)}
          </span>
        )}
      </EdgeLabelRenderer>
    </>
  )
}
