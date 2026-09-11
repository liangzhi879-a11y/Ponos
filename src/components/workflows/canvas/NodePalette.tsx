// src/components/workflows/canvas/NodePalette.tsx —— 左侧节点面板（UI Task 13）
//
// Dify 式分组目录（NODE_TYPES 为唯一真相，spec §6）：输入 / 模型 / 处理 / 工具 / 流程 / 输出。
// 两种添加方式：① 拖拽（dataTransfer 'application/yfw-node'，画布 onDrop 落点取指针位置）；
// ② 单击（插到视口已有节点右侧空位）。窄列 200px，条目复用 .cut-xs 切角微卡。
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { NODE_TYPES, type NodeTypeItem } from '@/lib/workflowModel'
import { Input } from '@/components/ui'
import { cn } from '@/lib/utils'

export interface NodePaletteProps {
  /** 单击添加（拖拽路径由画布 onDrop 处理，不经过本回调） */
  onAdd: (type: string) => void
}

/** 拖拽载荷键（画布 onDrop 读同一个键；不放 JSON，避免类型混淆） */
export const NODE_DND_MIME = 'application/yfw-node'

export function NodePalette({ onAdd }: NodePaletteProps) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return NODE_TYPES
    return NODE_TYPES
      .map((g) => ({
        ...g,
        items: g.items.filter((i) => i.type.includes(kw) || i.label.includes(q.trim()) || i.hint.includes(q.trim())),
      }))
      .filter((g) => g.items.length > 0)
  }, [q])

  return (
    <div className="w-[200px] shrink-0 border-r flex flex-col min-h-0 bg-surface/40">
      <div className="px-2 py-2 border-b">
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-[11px] font-semibold text-secondary">节点</span>
          <span className="text-[10px] text-tertiary">拖到画布或单击添加</span>
        </div>
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索节点"
            className="h-7 pl-6 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        {groups.map((g) => (
          <div key={g.group} className="mb-3">
            <div className="text-[10px] font-semibold text-tertiary uppercase tracking-wider mb-1.5">{g.group}</div>
            <div className="flex flex-col gap-1.5">
              {g.items.map((it) => (
                <PaletteItem key={it.type} item={it} onAdd={onAdd} />
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="text-[10px] text-tertiary px-1 py-2">无匹配节点</div>}
      </div>
    </div>
  )
}

function PaletteItem({ item, onAdd }: { item: NodeTypeItem; onAdd: (t: string) => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(NODE_DND_MIME, item.type)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onAdd(item.type)}
      title={item.hint}
      className={cn('cut-xs cursor-grab active:cursor-grabbing select-none', hover && 'hot')}
    >
      <div className="ci px-2 py-1.5">
        <div className="text-xs text-primary leading-tight">{item.label}</div>
        <div className="text-[9px] text-tertiary leading-tight truncate">{item.hint}</div>
      </div>
    </div>
  )
}
