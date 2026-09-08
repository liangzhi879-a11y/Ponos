// src/lib/assets.ts —— 静态品牌资源常量（BASE_URL 相对路径，Electron file:// 与 dev server 均可用）
// Task 1 已产出透明 boost 字标：light 版为白色/glossy 字标（仅深色表面可读），dark 版为深色字标（浅色表面用）。
// BootScreen 全屏深色品牌底直接用 light 版，无需 logo.png 兜底（见 task-5-brief Step 1）。
export const BOOST_LOGO_LIGHT = `${import.meta.env.BASE_URL}logo/boost-logo-light.png`
export const BOOST_LOGO_DARK = `${import.meta.env.BASE_URL}logo/boost-logo-dark.png`
