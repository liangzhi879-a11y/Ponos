// Launcher 模块的纯逻辑（与 React 解耦，便于 node --test 直接加载）。
// node 的 type-stripping 只覆盖 .ts（不覆盖 .tsx），故抽成独立 .ts 文件。

export interface ModuleItem { id: string; name: string; icon?: string }

export function pickLaunchable(mods: ModuleItem[]): ModuleItem[] {
  return mods.filter(m => m.id !== 'launcher')
}
