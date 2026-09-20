// Ponos 版本管理——单一数据源
// ---------------------------------------------------------------------------
// 四条版本线（详见 docs/architecture.md「版本实体」与 kit/manifest/versions.json）：
//   1. APP_VERSION     — YFWorking 应用（ponos 内核版）
//   2. KERNEL_VERSION  — ponos 内核，独立可运行
//   3. package.json version — Ponos GUI 发布线（旧内核稳定版，Vite 注入 __APP_VERSION__）
//   4. SCHEMA_VERSION  — settings 文件 schema 版本（下方导出）
// 升级版本号禁止手改，一律走 scripts/bump-version.mjs（自动同步测试期望值/package.json/版本台账）。
export const APP_VERSION = 'dev 3.0.0'

// ponos 内核版本线（与 kernel/package.json 的 semver 同步，映射规则见 bump 脚本）
export const KERNEL_VERSION = 'dev 0.2'

// settings 文件 schema 版本（D2-1）：无 schemaVersion 的旧文件视为 v0，读取时沿迁移链升级。
export const SCHEMA_VERSION = 1

// buildId（D4-1）：构建/发布时经环境注入（如 PONOS_BUILD_ID=release-2026-08-21-a1b2），
// dev 默认 'dev'。与 /diag 交叉比对：kernelVersion + schemaVersion + buildId 三源合一。
export function buildId() {
  return process.env.PONOS_BUILD_ID || 'dev'
}
