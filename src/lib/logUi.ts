// src/lib/logUi.ts —— 运行日志持久化策略的 UI 归约纯函数
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、不 import 任何运行时依赖
//（照 src/lib/effortUi.ts 先例；src/types/index.ts 仅 `import type` 消费本模块）。
//
// **钳制常量必须与 server/log-policy.cjs 逐位一致**（那是唯一真源）：两边对不上会出现
// "界面显示 5MB、实际按 100MB 轮转"这类幽灵问题。一致性由 server/log-policy-parity.test.mjs
// 直接 import 两侧做深比较钉住（测试跑在源码树，不受打包限制）。
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogPolicy {
  /** false = 完全不写日志文件（已有日志保留，绝不删除） */
  persist: boolean
  level: LogLevel
  maxFileBytes: number
  maxFiles: number
  maxAgeDays: number
}

export interface LogPolicyLimits {
  minFileBytes: number
  maxFileBytes: number
  minFiles: number
  maxFiles: number
  minAgeDays: number
  maxAgeDays: number
}

/** 与 server/log-policy.cjs 的 LOG_POLICY_LIMITS 一致（parity 测试钉住）。 */
export const LOG_POLICY_LIMITS: LogPolicyLimits = {
  minFileBytes: 64 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  minFiles: 0,
  maxFiles: 20,
  minAgeDays: 1,
  maxAgeDays: 365,
}

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/** 与 server/log-policy.cjs 的 DEFAULT_LOG_POLICY 一致（用户决策：5MB × 3 份 + 14 天）。 */
export const DEFAULT_LOG_POLICY: LogPolicy = {
  persist: true,
  level: 'info',
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  maxAgeDays: 14,
}

/** 日志文件表（/logs/list 的 files[]，字段与 listLogFiles 一一对应）。 */
export interface LogFileInfo {
  name: string
  base: string
  index: number
  size: number
  mtimeMs: number
}

export function isLogLevel(v: unknown): v is LogLevel {
  return LOG_LEVELS.includes(v as LogLevel)
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/** 任意输入 → 合法策略。语义与 server/log-policy.cjs:normalizeLogPolicy 完全一致：
 *  只有**显式 false** 才关闭持久化（字段缺失/拼错/字符串 'false' 一律保持开启）。 */
export function normalizeLogPolicyUi(raw: unknown): LogPolicy {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {}
  const lv = String(r.level ?? '').trim().toLowerCase()
  return {
    persist: r.persist !== false,
    level: isLogLevel(lv) ? lv : DEFAULT_LOG_POLICY.level,
    maxFileBytes: clampInt(r.maxFileBytes, LOG_POLICY_LIMITS.minFileBytes, LOG_POLICY_LIMITS.maxFileBytes, DEFAULT_LOG_POLICY.maxFileBytes),
    maxFiles: clampInt(r.maxFiles, LOG_POLICY_LIMITS.minFiles, LOG_POLICY_LIMITS.maxFiles, DEFAULT_LOG_POLICY.maxFiles),
    maxAgeDays: clampInt(r.maxAgeDays, LOG_POLICY_LIMITS.minAgeDays, LOG_POLICY_LIMITS.maxAgeDays, DEFAULT_LOG_POLICY.maxAgeDays),
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** 人类可读字节数（面板表格用）。负数/NaN → '—'（不显示假数字）。 */
export function formatBytes(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '—'
  if (v < 1024) return `${Math.round(v)} B`
  let x = v
  let i = 0
  while (x >= 1024 && i < BYTE_UNITS.length - 1) { x /= 1024; i++ }
  // KB 取整（512 KB 比 512.0 KB 好读），MB/GB 保留一位小数
  return i === 1 ? `${Math.round(x)} KB` : `${x.toFixed(1)} ${BYTE_UNITS[i]}`
}

/** 字节 → MB（设置页表单以 MB 编辑；轮转上限的整数差一点点就会显示 4.999…）。
 *  取 2 位小数：0.06MB(63KB 附近) 也能显示出来，不至于显示成 0。 */
export function bytesToMb(bytes: unknown): number {
  const v = Number(bytes)
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.round((v / (1024 * 1024)) * 100) / 100
}

/** MB → 字节（表单回写；负数/NaN → 0，随后由 normalizeLogPolicyUi 钳到下限）。 */
export function mbToBytes(mb: unknown): number {
  const v = Number(mb)
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.round(v * 1024 * 1024)
}

// mtimeMs 相同（批量轮转常见）时 readdir 顺序不稳定 → 同 mtime 按"主文件优先、
// 序号小的优先"排，面板顺序才稳定（parity：listLogFiles 已按 mtime 倒序给出）。
function fileOrder(a: LogFileInfo, b: LogFileInfo): number {
  if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
  if (a.base !== b.base) return a.base < b.base ? -1 : 1
  return a.index - b.index
}

/** 查看器默认选中哪个文件：优先**有内容**的 app.log，其次任何有内容的文件，
 *  最后 app.log（空也要显示一个确定的名字，而不是空白面板）。
 *  必要性：[立即清理] 会把主文件轮转成 .1，此时 app.log 为空/不存在——
 *  若仍死选 app.log，用户点完清理会以为"日志被删光了"。 */
export function pickDefaultLogFile(files: LogFileInfo[] | null | undefined): string {
  const list = Array.isArray(files) ? files.filter(f => f && typeof f.name === 'string') : []
  const primary = list.find(f => f.name === 'app.log' && f.size > 0)
  if (primary) return primary.name
  const anyContent = [...list].sort(fileOrder).find(f => f.size > 0)
  if (anyContent) return anyContent.name
  return list.find(f => f.name === 'app.log')?.name ?? 'app.log'
}

/** 相对现在的时间描述（表格用，不引入日期库）。 */
export function formatLogAge(mtimeMs: unknown, nowMs: number = Date.now()): string {
  const t = Number(mtimeMs)
  if (!Number.isFinite(t) || t <= 0) return '—'
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h`
  return `${Math.floor(hour / 24)}d`
}
