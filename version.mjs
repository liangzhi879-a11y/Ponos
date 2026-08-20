// YFW-turbo（yfwturbo）dev 版本管理——单一数据源
// ---------------------------------------------------------------------------
// 所有消费方（TUI banner、/version 命令、kernel init 事件）统一从这里读取，
// 升级版本号只需改这一个常量。注意：package.json 的 version（2.7.0）是
// YFWorking GUI 的发布版本线，与此处的 yfwturbo dev 版本线相互独立。
// 版本规范：dev <major>.<minor>（发布稳定后去掉 dev 前缀）
export const YFW_VERSION = 'dev 0.1'
