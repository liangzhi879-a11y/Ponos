// src/components/module/windows/PanelModule.tsx
// 面板模块窗口（?module=panel&channel=task|question|approval）：
// 气泡点击后打开的独立小窗口，显示对应通道列表。
// 独立窗口解决 dock 导航条 64px 宽放不下面板的问题（absolute 面板会被裁剪）。
import { TooltipProvider } from '@/components/ui'
import { DockPanel, type PanelChannel } from '@/components/dock/DockPanel'
import { getModuleParam } from '@/lib/moduleBridge'

const CHANNEL_TITLES: Record<PanelChannel, string> = {
  task: '运行任务',
  question: '待提问',
  approval: '待审批',
}

export function PanelModule() {
  const channel = (getModuleParam('channel') as PanelChannel) || 'task'
  return (
    <TooltipProvider>
      <DockPanel channel={channel} />
    </TooltipProvider>
  )
}

export { CHANNEL_TITLES }
