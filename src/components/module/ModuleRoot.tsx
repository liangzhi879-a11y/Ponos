// src/components/module/ModuleRoot.tsx
// 模块窗口根：按 ?module=<id> 分发到对应组件根。
// Task 5 阶段为占位实现（仅展示 moduleId），保持 tsc 可编译：
// 不引用尚未创建的 DockBar / ChatModule / FilesModule / SettingsModule / CockpitView。
// Task 6 落地 DockBar 后补全 default 分支；Task 7-9 依次添加 chat/files/settings 分支。
import { getModuleId } from '@/lib/moduleBridge'

export function ModuleRoot() {
  const moduleId = getModuleId()
  return (
    <div data-module-root={moduleId ?? 'unknown'} data-testid="module-root">
      {moduleId ?? 'unknown'}
    </div>
  )
}
