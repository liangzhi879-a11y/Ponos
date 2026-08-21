// YFW-turbo（yfwturbo）dev 版本管理——单一数据源
// ---------------------------------------------------------------------------
// 所有消费方（TUI banner、/version 命令、kernel init 事件）统一从这里读取，
// 升级版本号只需改这一个常量。注意：package.json 的 version（2.7.0）是
// YFWorking GUI 的发布版本线，与此处的 yfwturbo dev 版本线相互独立。
// 版本规范：dev <major>.<minor>（发布稳定后去掉 dev 前缀）
export const YFW_VERSION = 'dev 0.1'

// settings 文件 schema 版本（D2-1）：无 schemaVersion 的旧文件视为 v0，读取时沿迁移链升级。
export const SCHEMA_VERSION = 1

// buildId（D4-1）：构建/发布时经环境注入（如 YFW_BUILD_ID=release-2026-08-21-a1b2），
// dev 默认 'dev'。与 /diag 交叉比对：kernelVersion + schemaVersion + buildId 三源合一。
export function buildId() {
  return process.env.YFW_BUILD_ID || 'dev'
}
