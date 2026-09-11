// src/components/settings/SettingsWindowRoot.tsx —— 独立设置窗口根（?settings=1，2026-09-10）
// SettingsView 从主窗口移出并页面化（侧栏导航+内容区，非弹窗壳）。设置项经
// zustand persist（共享 localStorage）+ bridge 配置端点落盘；主窗口经 storage
// 事件重灌 store，主题/字号即时同步。
// 错误边界（2026-09-11）：旧持久化数据/渲染异常不再整窗白屏——显示可读错误与
// "重置本地设置"逃生通道，便于定位"界面出不来"类问题。
import { Component, type ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui'
import { SettingsView } from './SettingsView'
import { UtilityWindowShell } from './UtilityWindowShell'

class SettingsErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex items-center justify-center p-6">
          <div className="max-w-md text-center">
            <p className="text-sm font-semibold text-primary mb-2">设置页面渲染异常</p>
            <p className="text-xs text-error font-mono break-all mb-4">{String(this.state.error?.message || this.state.error)}</p>
            <button
              onClick={() => {
                try { window.localStorage.removeItem('yfworking-settings') } catch { /* ignore */ }
                window.location.reload()
              }}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-brand-500 bg-brand-500/10 hover:bg-brand-500/20"
            >
              重置本地设置并重载
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export function SettingsWindowRoot() {
  return (
    <SettingsErrorBoundary>
      <TooltipProvider>
        <UtilityWindowShell>
          <SettingsView />
        </UtilityWindowShell>
      </TooltipProvider>
    </SettingsErrorBoundary>
  )
}
