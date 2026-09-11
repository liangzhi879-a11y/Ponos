// 独立工具窗口判定（2026-09-10 设置/个人窗口外置）：与 auth/editor 同模式——
// 主进程按 ?settings=1 / ?profile=1 建无边框小窗，加载同一 dist，只渲染对应根组件。
// 与主应用共享 localStorage（zustand persist 生效），并行使用不锁主窗口。
export function isSettingsWindow(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('settings') === '1'
}

export function isProfileWindow(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('profile') === '1'
}
