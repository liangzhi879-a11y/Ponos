// src/components/layout/railMeta.ts —— rail 列常量表（Task 9，三段式 WorkShell 的常驻导航）
// RailId 合法值见 viewStore（persist merge 经 sanitizeRail 清洗落盘，非法/缺省 → 'task'）。
// 图标唯一性（Task 15 终裁，全量表见 docs/superpowers/audits/2026-09-08-gui-icon-uniqueness.md）：
// 本表四图标=类别入口，域内「同实体」复用允许（见下注释各条目）；异义复用已全部换图标——
// FolderOpen 会话集行 → Folder；AgentsPanel 重置齿轮 → RotateCcw；ChatInput 插话 → MessageCirclePlus。
// 设置项不在本表：设置入口常驻 Header 齿轮，rail 底部不放图标避免与 Header 同图标重复
// （决策见 task-9 brief Step 2）。
// 各条目的域内允许复用点：
//  - chat=MessageSquare：ChatListPanel 空态/搜索结果行/History 标题行均指「会话」实体（同语义，允许）。
//  - task=SquareKanban：TaskListPanel 空态装饰（同「任务」语义，允许）。
//  - agents=Bot：AgentsPanel 标题/助手与系统角色头像/History 预览行/warning agent_spec 均指「AI 实体」身份（允许）。
//  - skills=Puzzle：Settings 技能子页/技能设置头（同「技能」语义，允许）。
//  - workflows=Workflow（Task 13 第五 rail）：图标选 lucide 的 Workflow（节点图语义），
//    与既有四图标不重复；WorkflowsPanel/画布节点卡片不重复用图标（只用文字徽标）。
//  - apps=LayoutGrid（Task 1.1 第六 rail「应用智控」）：图标选 lucide 的 LayoutGrid
//    （应用清单/网格语义），与既有五图标不重复；后续 AppsPanel 卡片网格不重复用图标。
//  - knowledge=Library（S2 Task 1 第七 rail「知识」）：图标选 lucide 的 Library（知识库/藏书语义）。
//    **不用 BookOpen**：它已被 SkillsPanel 占用两处（SkillsPanel.tsx:382,412，语义=读文档），
//    复用会违反图标唯一性审计（docs/superpowers/audits/2026-09-08-gui-icon-uniqueness.md）。
//    Library 全库零占用；备选 NotebookPen。
import { MessageSquare, SquareKanban, Bot, Puzzle, Workflow, LayoutGrid, Library, type LucideIcon } from 'lucide-react'
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
  { id: 'workflows', icon: Workflow, labelKey: 'rail.workflows' },
  { id: 'apps', icon: LayoutGrid, labelKey: 'rail.apps' },
  { id: 'knowledge', icon: Library, labelKey: 'rail.knowledge' },
]

/** 非法/未知 rail id 兜底 → 'task'（与 viewStore.sanitizeRail 同策略，供宿主路由防护） */
export const railId = (id: string): RailId =>
  RAIL.some(r => r.id === id) ? (id as RailId) : 'task'
