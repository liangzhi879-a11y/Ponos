// src/components/auth/AuthWindowRoot.tsx —— 认证小窗宿主（?auth=1，D11-D13/Task 6b）
// AuthScreen 自带整窗深色品牌底/卡片，按 ~420×560 小窗自适应；认证通过后由 AuthScreen
// 成功路径发 IPC auth:granted（window.yfworkingWindow.authGranted），主进程关小窗开主窗口。
import { TooltipProvider } from '@/components/ui'
import { AuthScreen } from './AuthScreen'

export function AuthWindowRoot() {
  return (
    <TooltipProvider>
      <AuthScreen />
    </TooltipProvider>
  )
}
