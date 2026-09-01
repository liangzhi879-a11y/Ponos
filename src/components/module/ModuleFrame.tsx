// src/components/module/ModuleFrame.tsx
// 模块窗口统一标题栏：无边框（frame:false）窗口需要自绘拖动区 + 窗口控制按钮。
// 复用 Header 的 frameless 模式（drag-region 拖动 + ponosWindow 控制），
// 所有模块窗口（chat/files/settings/cockpit/dock）共用，保证可拖动/最小化/最大化/关闭。
import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { PermissionDialog } from '@/components/permissions/PermissionDialog'

export function ModuleFrame({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  const [hasWindowAPI, setHasWindowAPI] = useState(typeof window !== 'undefined' && !!window.ponosWindow)
  const [isMax, setIsMax] = useState(false)

  // 跟踪最大化状态以切换图标（同 Header）
  useEffect(() => {
    if (!window.ponosWindow) return
    const sync = () => {
      window.ponosWindow?.isMaximized().then(setIsMax).catch(() => {})
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  return (
    <div className="h-full flex flex-col bg-app text-primary">
      {/* 标题栏：drag-region 使整条可拖动；控制按钮区 no-drag 保持可点击 */}
      <div className="h-10 flex items-center justify-between pl-4 pr-0 border-b border-subtle drag-region shrink-0 select-none">
        <span className="flex items-center gap-2 text-xs font-medium text-secondary truncate">
          {icon && <span className="shrink-0">{icon}</span>}
          <span className="truncate">{title}</span>
        </span>
        {hasWindowAPI && (
          <div className="flex items-center no-drag shrink-0">
            <button
              onClick={() => window.ponosWindow?.minimize()}
              className="w-9 h-10 flex items-center justify-center text-tertiary hover:bg-elevated hover:text-primary transition-colors"
              aria-label="Minimize"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => window.ponosWindow?.maximizeToggle()}
              className="w-9 h-10 flex items-center justify-center text-tertiary hover:bg-elevated hover:text-primary transition-colors"
              aria-label="Maximize"
            >
              {isMax ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
            </button>
            <button
              onClick={() => window.ponosWindow?.close()}
              className="window-close-btn w-9 h-10 flex items-center justify-center text-tertiary hover:bg-error hover:text-inverse transition-colors"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
      {/* 内容区：撑满剩余高度；各模块组件自带 h-full 布局 */}
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      {/* 审批弹窗：模块窗口共用宿主（持 WS 的窗口——如聊天模块——审批事件在此显示） */}
      <PermissionDialog />
    </div>
  )
}
