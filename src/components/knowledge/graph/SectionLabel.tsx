// src/components/knowledge/graph/SectionLabel.tsx —— 图谱分区标签（S5.1）
//
// 用途：条目级图里，"未关联"（度数为 0）的节点被 `layoutSections` 排到下方**独立区块**。
// 光有空行不够——用户看到的仍是"下面一堆没连线的方块"（这正是原始反馈：
// "只有上部的条目连接了，下边的全都没有连"）。故在孤立区首行上方插一个纯展示节点：
// 一句说明 + 一条虚线，把这一块明确标成"未关联"这个**类别**。
//
// 三重"不可交互"是刻意的：它不是一个数据节点，只是画布上的一句话。
//   · `pointer-events-none` + `selectable:false`（视图侧设）→ 点它不会打开任何文档
//   · 不注册 Handle → 不会被连线吸附（本视图本就关闭连线，但保持节点自身不自作主张）
// 视觉只用 token（`--text-secondary` / `--border-default`），与其他节点同一套色彩体系。
import type { NodeProps } from '@xyflow/react'

export interface SectionLabelData extends Record<string, unknown> {
  /** 分区标题（如"未关联 8 · 主题唯一或内容独特"），由视图侧按 i18n 组装 */
  label: string
}

export function SectionLabel({ data }: NodeProps) {
  const label = String((data as SectionLabelData).label ?? '')
  if (!label) return null
  return (
    <div className="flex items-center gap-2 pointer-events-none select-none w-[560px]">
      <span className="micro shrink-0">{label}</span>
      {/* 虚线向右延伸：视觉上把下方整块"括"起来，比只放一句文字更像分区标题 */}
      <span className="flex-1 min-w-0 border-t border-dashed border-default" />
    </div>
  )
}
