// src/lib/usageApi.ts —— bridge 用量/审计 HTTP 拉取（沿 fetchSkills 先例：5s 短超时）
// 引 '@' alias + DOM fetch，node 不直测（纯逻辑在 usageUi.ts 已测）。
import { getBridgeUrl } from '@/lib/config'
import { buildUsageQuery } from '@/lib/usageUi'
import type { UsageReport, AuditRow } from '@/lib/usageUi'

const FETCH_TIMEOUT_MS = 5000

export interface UsageQuery {
  project?: string
  sessionId?: string
  scope?: string
}

async function getJson<T>(path: 'usage' | 'audit', q: UsageQuery): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(`${getBridgeUrl()}/api/${path}${buildUsageQuery(q)}`, { signal: controller.signal })
    if (!r.ok) {
      let msg = `HTTP ${r.status}`
      try {
        const j = await r.json() as { error?: unknown }
        if (typeof j?.error === 'string' && j.error) msg = j.error
      } catch { /* body 非 JSON，保留 HTTP 状态文案 */ }
      throw new Error(msg)
    }
    return (await r.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export function fetchUsage(q: UsageQuery = {}): Promise<UsageReport> {
  return getJson<UsageReport>('usage', q)
}

export async function fetchAudit(q: UsageQuery = {}): Promise<AuditRow[]> {
  const body = await getJson<unknown>('audit', q)
  // 输入防御（spec L201）：后端聚合异常时 res.ok 的 body 可能非数组（如 { error } / null）——
  // 非数组返回 []，不给 auditView 喂非数组（auditView 内 [...rows] 展开会抛 TypeError）。
  return Array.isArray(body) ? (body as AuditRow[]) : []
}
