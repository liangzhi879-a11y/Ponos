// src/components/layout/railMeta.ts —— rail 列常量表（Task 9，三段式 WorkShell 的常驻导航）
// RailId 合法值见 viewStore（persist merge 经 sanitizeRail 清洗落盘，非法/缺省 → 'task'）。
// 图标唯一性（Task 15 查重）：MessageSquare 随旧 Sidebar 的 chats tab 退役腾出、
// SquareKanban 全库首用、Bot/Puzzle 与旧 Sidebar agents/skills tab 单点同义（迁移语义一致）。
// 设置项不在本表：设置入口常驻 Header 齿轮，rail 底部不放图标避免与 Header 同图标重复
// （决策见 task-9 brief Step 2）。
import { MessageSquare, SquareKanban, Bot, Puzzle, type LucideIcon } from 'lucide-react'
import type { RailId } from '@/stores/viewStore'

export interface RailMeta {
  id: RailId
  icon: LucideIcon
  labelKey: string
}

export const RAIL: readonly RailMeta[] = [
  { id: 'chat', icon: MessageSquare, labelKey: 'rail.chat' },
  { id: 'task', icon: SquareKanban, labelKey: 'rail.task' },
  { id: 'agents', icon: Bot, labelKey: 'rail.agents' },
  { id: 'skills', icon: Puzzle, labelKey: 'rail.skills' },
]

/** 非法/未知 rail id 兜底 → 'task'（与 viewStore.sanitizeRail 同策略，供宿主路由防护） */
export const railId = (id: string): RailId =>
  RAIL.some(r => r.id === id) ? (id as RailId) : 'task'
