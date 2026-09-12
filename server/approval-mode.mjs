// server/approval-mode.mjs —— 审批档位（桥侧独立实现）
// ---------------------------------------------------------------------------
// **打包约束（load-bearing）**：electron-builder 只发 dist/ electron/ server/ public/
// bin/ + kernel-dist/cli.mjs，打包产物里**没有 kernel/ 目录**（这正是 server/highrisk.mjs
// 存在的原因）。故本文件**不得** import 任何 kernel/ 模块，枚举在此独立声明。
// 与 kernel/approval-mode.mjs 的一致性由 server/approval-mode.test.mjs 把关：测试跑在
// 源码树（不受打包限制），直接 import 内核模块逐字比对。
//
// 语义速查（完整表见 kernel/approval-mode.mjs）：manual < auto < loose < bypass 逐级放宽；
//   普通 Bash 从 auto 起自动、写文件/出网/agent 从 loose 起自动、高危 Bash 仅 bypass 自动。
//   灾难级硬黑名单（rm -rf / 等）四档都要问，不在本模块表达（内核 blacklist.mjs 负责）。
export const APPROVAL_MODES = ['manual', 'auto', 'loose', 'bypass']
// 默认档 = loose = 应用今天的真实行为（桥一直硬编码 --dangerously-skip-permissions）。
// 选它而非 manual：存量用户升级后零行为变化（写文件仍自动执行），徽标从此说真话。
export const DEFAULT_APPROVAL_MODE = 'loose'

const RANK = { manual: 0, auto: 1, loose: 2, bypass: 3 }

export function isValidApprovalMode(v) {
  return Object.prototype.hasOwnProperty.call(RANK, String(v ?? '').trim().toLowerCase())
}

// 非法输入一律回落默认档（永不抛）：够用且不放大权限也不误收紧
export function normalizeApprovalMode(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return isValidApprovalMode(s) ? s : DEFAULT_APPROVAL_MODE
}

// 会话覆盖 > 全局持久化档位（会话覆盖仅存内存，见 bridge 的 sessionApprovalModes）
export function resolveEffectiveApprovalMode({ sessionOverride = null, configMode = null } = {}) {
  if (sessionOverride !== null && sessionOverride !== undefined && isValidApprovalMode(sessionOverride)) {
    return normalizeApprovalMode(sessionOverride)
  }
  return normalizeApprovalMode(configMode)
}

// 内核 spawn 参数（替换原先硬编码的 --dangerously-skip-permissions）
//   · 新内核：显式 --approval-mode 在 cli 三级优先级里最高（flag > settings.json > 派生）
//   · 旧缓存内核（不认识新 flag，未知参数静默忽略）：loose/bypass 仍带旧 skip flag →
//     停在 loose（= 今天的行为），既不会因缺 flag 掉进"非交互 print 模式 ask 退化 deny"，
//     也不会比用户选的更宽。manual/auto 在旧内核上会退化成 loose（更宽）——由 bridge 比对
//     system/init 回显的 approval_mode 广播降级告警兜底（见 bridge 侧 init 处理）。
export function approvalSpawnArgs(mode) {
  const m = normalizeApprovalMode(mode)
  const args = ['--approval-mode', m]
  if (m === 'loose' || m === 'bypass') args.push('--dangerously-skip-permissions')
  return args
}

// GUI 文案用的一行摘要（弹窗/状态栏 tooltip 复用，避免两处各写一套）
export function approvalModeSummary(mode) {
  switch (normalizeApprovalMode(mode)) {
    case 'manual': return '每个工具调用都需用户批准（写文件、命令、出网、子 agent）'
    case 'auto': return '普通命令自动执行；写文件、出网、子 agent、高危命令需批准'
    case 'bypass': return '全部自动执行；仅灾难级命令（rm -rf / 等）仍需批准'
    default: return '写文件、命令、出网自动执行；高危命令需批准（默认档）'
  }
}
