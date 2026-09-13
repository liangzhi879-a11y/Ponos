// src/components/knowledge/graph/KnowledgeNode.tsx —— 图谱节点（S2 Task 8）
//
// 范式照 `workflows/canvas/nodes/WorkflowNode.tsx`：单对角切角卡（`.cut-sm` + `>.ci`）、
// 外层 1px 即细线、**只用 token 上色**（外层细线 `--border-default`，选中换成 `.hot` 的
// `--line-hot`，卡片底由 `.ci` 的 `--bg-elevated` 提供）。
//
// 与工作流节点的两点差异，都是为了"图谱是导航不是编辑器"：
//   ① 没有删除钮、没有状态色、没有类型徽标——节点只有"文档名 + 所属空间"两条信息；
//   ② 两个 Handle **不可见**（opacity:0）：它们只提供边的锚点几何，画出来就是一堆小圆点，
//      而且本视图显式关闭了连线（`nodesConnectable={false}`），可见的 Handle 会误导用户去拖它。
//      Handle 保留（而不是删掉）是硬要求——xyflow 找不到 source/target handle 时不画边。
//
// 点击打开文档由 **视图层的 `onNodeClick`** 处理（节点 id 就是 docId），不走 data 回调：
// `nodeTypes` 表必须是模块级稳定引用（否则每次 render 整图重挂载），塞回调进 data 会
// 让 data 每次都换引用，同样触发节点重渲染。
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface KnowledgeNodeData extends Record<string, unknown> {
  /** 文档标题（后端 `nodes[].label`） */
  label: string
  /** 所属空间 id（跨空间图谱时靠它区分同名文档） */
  spaceId: string
  /** 引用它的边数（视图侧算好的度数；0 = 孤岛文档，视觉上淡化） */
  degree: number
}

const HIDDEN_HANDLE = { opacity: 0, width: 6, height: 6, border: 'none', background: 'transparent' } as const

export function KnowledgeNode({ data, selected }: NodeProps) {
  const d = data as KnowledgeNodeData
  const label = String(d.label ?? '')
  const degree = Number(d.degree ?? 0)
  return (
    <div
      className={cn('cut-sm min-w-[132px] max-w-[188px] transition-[background] duration-200', selected && 'hot')}
      // 孤岛文档（degree=0）淡化：图上"什么都没连"的节点与 hub 一样醒目只会干扰阅读
      style={degree === 0 ? { opacity: 0.72 } : undefined}
    >
      <div className="ci px-2 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <FileText className="w-3 h-3 shrink-0 text-tertiary" />
          <span className="text-[11px] text-primary truncate" title={label}>{label || 'untitled'}</span>
        </div>
        {/* 空间 id 用 .micro（8.5px 装饰体）：跨空间图谱时"同名文档属于哪个库"必须一眼可辨 */}
        <div className="mt-0.5 micro truncate" title={String(d.spaceId ?? '')}>{String(d.spaceId ?? '')}</div>
        <Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} />
        <Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} />
      </div>
    </div>
  )
}
