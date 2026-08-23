// transcriptLoader.ts — GUI 侧按需加载会话的桥接层：调 bridge /transcript/load，
// 取回原始 entry 数组后交给 transcriptAdapter 转成 GUI Message。
//
// bridge 端口封装在 src/lib/config.ts 的 getBridgeUrl()（Vite define __BRIDGE_PORT__，
// 默认 51311），这里直接复用，不硬编码端口。baseUrl 可注入以便单元测试/联调。

import { getBridgeUrl } from './config.ts'
import { entriesToMessages, cropMessages } from './transcriptAdapter.ts'
import type { Message } from '../types/index.ts'

export interface FetchTranscriptOptions {
  /** 默认 true：大文件只读尾部最近 5MB（对应 server transcript.mjs TAIL_LIMIT_BYTES） */
  tailFirst?: boolean
  /** 测试注入用；缺省走 getBridgeUrl() */
  baseUrl?: string
  /** 默认 true：展示级裁剪（text/tool_result 截断，控制内存）；false = 完整消息（导出用） */
  crop?: boolean
}

export interface FetchTranscriptResult {
  ok: boolean
  messages: Message[]
  /** tailFirst 模式下是否发生过文件截断（尾部 5MB 之外的历史未载入） */
  truncated: boolean
  /** 跳过数 = 内核 JSON 解析跳过 + 转换层无法转换的 entry 数 */
  skipped: number
  error?: string
}

/**
 * 加载单个内核会话 transcript 并转换为 GUI Message 数组。
 * 失败（bridge 不可达 / 文件不存在 / 返回异常）时 ok:false 并带 error，不抛异常。
 */
export async function fetchTranscript(
  sessionId: string,
  cwd: string,
  opts: FetchTranscriptOptions = {}
): Promise<FetchTranscriptResult> {
  const base = opts.baseUrl || getBridgeUrl()
  const tailFirst = opts.tailFirst !== false // 默认 tailFirst
  const crop = opts.crop !== false // 默认裁剪
  const url =
    `${base}/transcript/load` +
    `?cwd=${encodeURIComponent(cwd)}` +
    `&sessionId=${encodeURIComponent(sessionId)}` +
    `&tailFirst=${tailFirst ? 1 : 0}`
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, messages: [], truncated: false, skipped: 0, error: `HTTP ${res.status}` }
    const data = await res.json()
    if (!data || data.ok !== true) {
      return { ok: false, messages: [], truncated: false, skipped: 0, error: data?.error || 'load failed' }
    }
    const rawEntries: any[] = Array.isArray(data.entries) ? data.entries : []
    const { messages, skipped } = entriesToMessages(rawEntries)
    // 裁剪在转换层内部已对 assistant/user 块执行；cropMessages 兜底保证所有路径一致
    return {
      ok: true,
      messages: crop ? cropMessages(messages) : messages,
      truncated: data.truncated === true,
      skipped: skipped + (typeof data.skipped === 'number' ? data.skipped : 0),
    }
  } catch (e: any) {
    return { ok: false, messages: [], truncated: false, skipped: 0, error: e?.message || 'fetch failed' }
  }
}

/** loadConversationMessages 的参数（与 GUI Conversation 相关字段兼容，避免强依赖）。 */
export interface LoadConversationInput {
  sessionIds?: string[]
  cwd?: string
  /** 迁移兜底：会话原本存的 GUI 消息（本地历史数据），转录加载失败时回退用之 */
  extMessages?: Message[] | null
}

/**
 * 聚合加载主入口（chatStore 按需加载会话时调用）。
 * - 对 sessionIds 逐个 fetchTranscript，并发限制 2（大 transcript 逐行 JSON.parse 较费内存）。
 * - 结果按 timestamp 合并排序，并按 message id 去重（多 session 拼接 / 重复加载时保稳）。
 * - sessionIds 为空或全部失败时：回退返回 extMessages（迁移兜底）或 []。
 */
export async function loadConversationMessages(
  conversation: LoadConversationInput,
  opts: FetchTranscriptOptions = {}
): Promise<Message[]> {
  const ids = conversation?.sessionIds?.filter((s) => typeof s === 'string' && s) ?? []
  if (ids.length === 0) return conversation?.extMessages ?? []

  const cwd = conversation?.cwd || ''
  const results = await mapWithConcurrency(ids, 2, (sessionId) => fetchTranscript(sessionId, cwd, opts))

  const okResults = results.filter((r) => r.ok)
  if (okResults.length === 0) {
    // 全部失败：迁移兜底用 GUI 本地历史，避免会话内容凭空消失
    return conversation?.extMessages ?? []
  }

  const merged = okResults.flatMap((r) => r.messages)
  // 按 timestamp 升序 + message id 去重（保留先出现的）
  merged.sort((a, b) => a.timestamp - b.timestamp)
  const seen = new Set<string>()
  const out: Message[] = []
  for (const m of merged) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

/** 简单并发池：把 tasks 以 limit 为界分批执行（不改动结果顺序）。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
