// src/lib/logs.ts —— 运行日志端点的 HTTP 客户端（设置页「日志」分区用）
// 契约见 server/logs-routes.mjs 与 docs/bridge-contract.md §7。
// 失败一律返回 { ok: false } 而不是抛：设置页不该因为一次取日志失败就白屏/崩掉
// （日志面板是"锦上添花"的排查工具，不是关键路径）。
import { getBridgeUrl } from '@/lib/config'
import { type LogFileInfo, type LogPolicy, type LogLevel } from '@/lib/logUi'

export interface LogsListResult {
  ok: boolean
  dir?: string
  persist?: boolean
  policy?: LogPolicy
  levels?: LogLevel[]
  files?: LogFileInfo[]
  error?: string
}

export interface LogTailResult {
  ok: boolean
  file?: string
  lines?: string[]
  error?: string
}

export interface LogsPruneResult {
  ok: boolean
  removed?: number
  freedBytes?: number
  files?: LogFileInfo[]
  error?: string
}

/** 日志文件清单 + 策略 + 上限（一次拿全，设置页表格/表单都用它）。 */
export async function fetchLogsList(): Promise<LogsListResult> {
  try {
    const res = await fetch(`${getBridgeUrl()}/logs/list`)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return await res.json()
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/** 日志尾部（内核侧钳 1–500 行、只读尾部字节，不会整读大文件）。 */
export async function fetchLogTail(file: string, lines = 200): Promise<LogTailResult> {
  try {
    const q = new URLSearchParams({ file, lines: String(lines) })
    const res = await fetch(`${getBridgeUrl()}/logs/tail?${q}`)
    const data = await res.json().catch(() => null)
    if (!res.ok || !data) return { ok: false, error: data?.error || `HTTP ${res.status}` }
    return data
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/** [立即清理]：删除全部轮转份 + 把当前文件归档一份（返回释放字节数）。 */
export async function pruneLogs(): Promise<LogsPruneResult> {
  try {
    const res = await fetch(`${getBridgeUrl()}/logs/prune`, { method: 'POST' })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data) return { ok: false, error: data?.error || `HTTP ${res.status}` }
    return data
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}
