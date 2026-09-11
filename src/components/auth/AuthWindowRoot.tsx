// src/components/auth/AuthWindowRoot.tsx —— 认证小窗宿主（?auth=1，D11-D13/Task 6b）
// AuthScreen 自带整窗深色品牌底/卡片，按 ~420×560 小窗自适应；认证通过后由 AuthScreen
// 成功路径发 IPC auth:granted（window.yfworkingWindow.authGranted），主进程关小窗开主窗口。
// 2026-09-10 无边框登录窗：窗口 frame:false 后，本组件提供顶部拖拽条（app-region:drag）
// 与关闭钮（no-drag；authClose → 主进程关小窗，未放行即退出应用）。
import { X } from 'lucide-react'
import { TooltipProvider } from '@/components/ui'
import { AuthScreen } from './AuthScreen'

export function AuthWindowRoot() {
  return (
    <TooltipProvider>
      <div className="relative h-screen w-screen">
        {/* 顶部拖拽条：整条可拖动窗口；关闭钮区域 no-drag 可点击 */}
        <div
          className="absolute top-0 left-0 right-0 h-9 z-20 flex items-center justify-end pr-1.5"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <button
            onClick={() => window.yfworkingWindow?.authClose?.()}
            aria-label="关闭"
            className="w-7 h-7 flex items-center justify-center rounded-full text-tertiary hover:text-primary hover:bg-white/10 transition-colors"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <AuthScreen />
      </div>
    </TooltipProvider>
  )
}
