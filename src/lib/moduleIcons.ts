// src/lib/moduleIcons.ts
// 模块与状态气泡的 lucide 图标映射：按模块 id / 通道 id 给出统一图标组件。
// 主进程 module-registry 的 icon 字段是字符串标识（'vortex' 等），渲染层不直接用，
// 这里以模块 id 映射 lucide 组件，DockBar 导航与 ModuleFrame 标题栏共用同一映射。
import {
  LayoutDashboard, MessageSquare, Folder, Settings, PanelRight, Puzzle,
  ListTodo, HelpCircle, ShieldCheck, Lock, LockOpen, Sparkles,
  type LucideIcon,
} from 'lucide-react'
import type { DockChannel } from '@/stores/dockStore'

/** 模块 id → lucide 图标（与 electron/module-registry.cjs BUILTIN_MODULES 对应）。 */
export const MODULE_ICONS: Record<string, LucideIcon> = {
  cockpit: LayoutDashboard,
  chat: MessageSquare,
  files: Folder,
  settings: Settings,
  skills: Sparkles,
  approval: ShieldCheck,
  dock: PanelRight,
}

/** 未知/外部模块兜底图标。 */
export const MODULE_FALLBACK_ICON: LucideIcon = Puzzle

/** 状态气泡通道 → lucide 图标。 */
export const CHANNEL_ICONS: Record<DockChannel, LucideIcon> = {
  task: ListTodo,
  question: HelpCircle,
  approval: ShieldCheck,
  module: Puzzle,
}

/** 按模块 id 取图标组件（未知模块回退兜底图标）。 */
export function moduleIcon(id: string | null | undefined): LucideIcon {
  return (id && MODULE_ICONS[id]) || MODULE_FALLBACK_ICON
}

/** 锁定开关图标。 */
export const LOCK_ICONS = { locked: Lock, unlocked: LockOpen } as const
