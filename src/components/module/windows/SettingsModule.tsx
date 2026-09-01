// src/components/module/windows/SettingsModule.tsx
// 设置模块窗口（?module=settings）：独立原生设置界面。
// 复用 SettingsContent（无 Dialog 壳，铺满窗口），而非主窗口的 SettingsView 弹窗。
// 顶部标题栏由 ModuleFrame 提供（拖动 + 最小化/最大化/关闭）；关闭按钮走 closeModule。
import { TooltipProvider } from '@/components/ui'
import { SettingsContent } from '@/components/settings/SettingsContent'
import { closeModule } from '@/lib/moduleBridge'

export function SettingsModule() {
  return (
    <TooltipProvider>
      <SettingsContent onClose={() => void closeModule('settings')} />
    </TooltipProvider>
  )
}
