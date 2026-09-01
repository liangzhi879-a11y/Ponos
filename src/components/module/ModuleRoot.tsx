// src/components/module/ModuleRoot.tsx
// 模块窗口根：按 ?module=<id> 分发到对应组件根。
// Task 6 起：未知/缺失 moduleId（主窗口 dock 化）→ DockBar。
// Task 7 完成 chat（试点 1）、Task 8 完成 files（试点 2）、Task 9 完成 settings（试点 3）。
// 各模块统一包 ModuleFrame（自绘标题栏：拖动 + 最小化/最大化/关闭），
// 因为模块窗口均为无边框（frame:false），必须有拖动区与控制按钮才可操作。
import { getModuleId } from '@/lib/moduleBridge'
import { moduleIcon } from '@/lib/moduleIcons'
import { ModuleFrame } from '@/components/module/ModuleFrame'
import { DockBar } from '@/components/dock/DockBar'
import { ChatModule } from '@/components/module/windows/ChatModule'
import { FilesModule } from '@/components/module/windows/FilesModule'
import { SettingsModule } from '@/components/module/windows/SettingsModule'
import { SkillsModule } from '@/components/module/windows/SkillsModule'
import { ApprovalModule } from '@/components/module/windows/ApprovalModule'
import { PanelModule } from '@/components/module/windows/PanelModule'
import { CockpitView } from '@/components/cockpit/CockpitView'
import { TokenStatsPanel } from '@/components/cockpit/TokenStatsPanel'

/** 模块名映射（与 electron/module-registry.cjs 的 BUILTIN_MODULES 对应）。 */
const MODULE_TITLES: Record<string, string> = {
  chat: '聊天',
  files: '文件',
  settings: '设置',
  skills: '技能',
  approval: '审批',
  panel: '面板',
  cockpit: '驾驶舱',
  dock: '导航栏',
}

export function ModuleRoot() {
  const moduleId = getModuleId()
  // dock 独立窗口：不套 ModuleFrame（dock 是窄条导航，自含关闭按钮）
  if (moduleId === 'dock') return <DockBar />
  const title = MODULE_TITLES[moduleId ?? ''] ?? moduleId ?? 'Ponos'
  const TitleIcon = moduleIcon(moduleId)
  let content: React.ReactNode
  switch (moduleId) {
    // Task 7：聊天模块窗口化（试点 1）
    case 'chat':
      content = <ChatModule />
      break
    // Task 8：文件模块窗口化（试点 2）
    case 'files':
      content = <FilesModule />
      break
    // Task 9：设置模块窗口化（试点 3）
    case 'settings':
      content = <SettingsModule />
      break
    // 技能 · Agent 模块窗口
    case 'skills':
      content = <SkillsModule />
      break
    // 审批：全局独立审批窗口（主进程审批到达时自动打开，处理完自动关）
    case 'approval':
      content = <ApprovalModule />
      break
    // 面板：气泡点击后打开的独立小窗口（task/question/approval 列表）
    case 'panel':
      content = <PanelModule />
      break
    // 驾驶舱：独立模块窗口（导航条常驻时由登录后自动打开 / DockBar 品牌区打开）
    case 'cockpit':
      content = (
        <>
          <CockpitView />
          {/* Token 统计面板：驾驶舱窗口内常驻挂载，Token 卡片点击打开 */}
          <TokenStatsPanel />
        </>
      )
      break
    default:
      content = <DockBar />
  }
  return <ModuleFrame title={title} icon={<TitleIcon size={14} />}>{content}</ModuleFrame>
}
