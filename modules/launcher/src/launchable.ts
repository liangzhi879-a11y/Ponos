// Launcher 模块的纯逻辑（与 React 解耦，便于 node --test 直接加载）。
// node 的 type-stripping 只覆盖 .ts（不覆盖 .tsx），故抽成独立 .ts 文件。

export interface ModuleItem { id: string; name: string; icon?: string; runtime?: string; entry?: { ui?: string; main?: string } }

export function pickLaunchable(mods: ModuleItem[]): ModuleItem[] {
  // 仅 ui-renderer（有 ui 入口）模块可开窗；runtime 缺省视为 ui-renderer（registry 内置窗口模块语义）；
  // node-worker/cli-bridge 后台模块不进启动台
  return mods.filter(m => m.id !== 'launcher' && !(m.runtime && m.runtime !== 'ui-renderer') && !!m.entry?.ui)
}
