// src/components/settings/UtilityWindowShell.tsx —— 独立工具窗口通用壳（2026-09-10）
// 设置/个人信息小窗（frame:false）共用的无边框壳：顶部拖拽条 + 关闭钮
// （utility:close 只关本窗，不碰主窗口）。主题由 main.tsx 按持久化设置全局应用。
import { X } from 'lucide-react'

export function UtilityWindowShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-screen w-screen flex flex-col">
      {/* 顶部拖拽条：整条可拖动窗口；关闭钮区域 no-drag 可点击 */}
      <div
        className="absolute top-0 left-0 right-0 h-9 z-20 flex items-center justify-end pr-1.5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <button
          onClick={() => window.yfworkingWindow?.closeUtility?.()}
          aria-label="关闭"
          className="w-7 h-7 flex items-center justify-center rounded-full text-tertiary hover:text-primary hover:bg-white/10 transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 pt-9">{children}</div>
    </div>
  )
}
