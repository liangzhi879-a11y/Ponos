// src/components/module/windows/SettingsModule.tsx
// 设置模块窗口（?module=settings）。
// 复用 SettingsView；主题/字体等设置经 localStorage 同 origin 共享。
// 注意：SettingsView 以 Radix Dialog 呈现（open={settingsOpen}），而模块窗口是
// 独立渲染进程，其 uiStore 的 settingsOpen 默认为 false —— 若直接渲染 Dialog
// 内容不会挂载、窗口将空白。故挂载时先 openSettings() 强制打开，保持复用组件原样。
import { useEffect } from 'react'
import { SettingsView } from '@/components/settings/SettingsView'
import { useUIStore } from '@/stores/uiStore'

export function SettingsModule() {
  const openSettings = useUIStore(s => s.openSettings)

  // 模块窗口独立 JS realm：settingsOpen 不在 persist 白名单，初始化恒为 false。
  // 挂载即打开，Dialog 才可见（SettingsView 内部 Dialog open 受此控制）。
  useEffect(() => {
    openSettings()
  }, [openSettings])

  return <SettingsView />
}
