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
// 兜底档 = loose = 应用今天的真实行为（桥一直硬编码 --dangerously-skip-permissions）。
// 选它而非 manual：存量用户升级后零行为变化（写文件仍自动执行），徽标从此说真话。
//
// ⚠️ 本常量是**兜底/回落值**（"不知道时怎么兜"），**不是**新装默认档（"新装给什么"）——
// 二者语义不同、刻意分离。想实现"提高新装默认档"（P0-4）请改 NEW_INSTALL_APPROVAL_MODE，
// **不要**改本值，原因有二：
//   ① 本值同时是内核旧 flag 兼容推导（kernel/approval-mode.mjs 的 deriveApprovalMode）的
//      落点，改成 auto 会让裸内核/旧 flag 路径把写文件从 allow 变 ask = **行为回归**
//      （内核文件头明确禁止"未跳权限映射成更严档"）；
//   ② server/approval-mode.test.mjs 断言本值与内核 DEFAULT 逐字一致（打包产物无 kernel/，
//      靠该测试把关一致性）。
export const DEFAULT_APPROVAL_MODE = 'loose'

// P0-4（2026-09-16）**新装默认档** = auto：仅供 bridge 首次生成 config.json 时写入
// （见 bridge.mjs 的 DEFAULT_CONFIG.approvalMode）。auto 下只读与普通 Bash 仍自动，但
// **写文件、出网/浏览器、派子 agent、未识别(MCP) 工具**需用户确认 —— 即"新用户一到手
// 就带审阅闸"，而**存量用户完全不受影响**（config.json 已显式持久化其档位，loadConfig
// 合并时被 cfg 覆盖）。
// 刻意不复用 DEFAULT_APPROVAL_MODE：那是"兜底值"，复用它会把旧 flag 兼容路径一起改严。
export const NEW_INSTALL_APPROVAL_MODE = 'auto'

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

// init 回显判定（2026-09-17）：内核起来后 system/init 回的 approval_mode 该跟谁比？
// ---------------------------------------------------------------------------
// **基准必须是 spawn 时真正传给内核的档位（spawnMode），不是此刻的实时档位。**
// 为什么（2026-09-17 实证假告警）：resume 大 transcript 时 spawn→init 窗口可达数秒
// （实测 7s，期间内核在读历史 + [compact] action=aged）。窗口内用户在状态栏切档，
// bridge 会 push 热切并记下会话覆盖 ⇒ 实时档位与 spawn 档位分叉。若拿实时档位当基准，
// 「内核明明认账了新 flag」会被误判成「跑的是旧缓存内核」：日志出现
// `expected bypass, kernel reports loose`，GUI 同时弹 amber 假警报，且 init 回显被
// 渲染层当"当前档位"写回 store ⇒ 徽标从用户刚选的 bypass 退回 loose（界面说反话）。
// 回显检验的本意只有一个：**内核认不认 --approval-mode 这个 flag**（认 → 回显 = spawn 档）。
// 返回四态（bridge 据此动作，本模块只判定、不做 IO，便于单测）：
//   'degraded' 回显 ≠ spawn 档 → 旧内核（忽略未知 flag，靠旧 skip flag 停在 loose）⇒ 如实告警
//   'realign'  回显 = spawn 档 ≠ 当前档 → 不是旧内核，只是窗口内切过档 ⇒ 补热切 + 补广播
//   'ok'       三者一致 → 无事
//   'unknown'  回显缺失（更老的内核无该字段）→ 无从判断，不动作（不告警）
// spawnMode 缺失时回落兜底档（与 approvalSpawnArgs 缺省同款）——不会凭空放大权限。
export function classifyApprovalEcho({ echoed, spawnMode, liveMode }) {
  if (!echoed) return 'unknown'
  const e = normalizeApprovalMode(echoed)
  const spawn = normalizeApprovalMode(spawnMode)
  const live = normalizeApprovalMode(liveMode)
  if (e !== spawn) return 'degraded'
  if (e !== live) return 'realign'
  return 'ok'
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
