// 应用控制台「能力清单」的前端纯逻辑。
//
// ★ 为什么独立成模块（与 src/lib/appRequirement.ts 同款做法）：组件不便测，而这里有两件必须被测试锁死的事——
//   ① 三分结论的**文案协议**（可接入 / 证据不足 / 无法接入措辞不得混用，weak 绝不能出现"无法接入"）；
//   ② 后端（可能是老版本主进程）返回的 surface 结构不一定完整，归一化必须容错而不是让界面白屏。
// ★ 三分文案的**唯一出处**：与 electron/app-capability.cjs 的 renderSurfaceReport 一一对应。
//   刻意不进 i18n：它是与后端严格对齐的协议文案（后端同样只有中文），散进两份翻译文件反而容易口径漂移，
//   测试也没法直接钉住"weak 不含无法接入"；将来要英文只改这一处。
export type SurfaceVerdict = 'connectable' | 'weak' | 'unusable'
export type CapabilityConfidence = 'verified' | 'probable' | 'unusable'

export interface SurfaceCapability {
  channel: string
  driver: string | null
  label: string
  confidence: CapabilityConfidence
  evidence: string
  next: string
}

export interface AppSurface {
  capabilities: SurfaceCapability[]
  verdict: SurfaceVerdict
  hasVerified: boolean
  hasProbable: boolean
}

/** 三分结论文案（与后端 renderSurfaceReport 的措辞保持同一口径：weak 不得说成"无法接入"） */
export const VERDICT_COPY: Record<SurfaceVerdict, { label: string; detail: string }> = {
  connectable: {
    label: '可接入',
    detail: '已实测到可用通道：下面的命令就是沿这些通道封装出来的，可直接试跑。',
  },
  weak: {
    label: '证据不足',
    detail: '只探到待确认线索，尚未实测通过；可补上程序路径或官方文档后重新生成，或先在下面逐条试跑验证。',
  },
  unusable: {
    label: '无法接入',
    detail: '未发现任何可控路径（CLI / 脚本接口 / 数据文件 / 接口均不成立）：建议找该应用的官方 CLI 或 API，或改按网页方式接入。',
  },
}

const CONFIDENCES: CapabilityConfidence[] = ['verified', 'probable', 'unusable']

/** 归一化后端给的 surface：结构不全/字段脏时也不抛（返回 null 或最保守的值） */
export function normalizeSurface(raw: unknown): AppSurface | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { capabilities?: unknown; verdict?: unknown }
  if (!Array.isArray(obj.capabilities)) return null
  const capabilities: SurfaceCapability[] = []
  for (const item of obj.capabilities) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const channel = String(c.channel ?? '').trim()
    if (!channel) continue
    const conf = CONFIDENCES.includes(c.confidence as CapabilityConfidence) ? (c.confidence as CapabilityConfidence) : 'unusable'
    capabilities.push({
      channel,
      driver: c.driver == null ? null : String(c.driver),
      label: String(c.label ?? '').trim() || channel, // 缺 label 时退回 channel，界面不出现 undefined
      confidence: conf,
      evidence: String(c.evidence ?? ''),
      next: String(c.next ?? ''),
    })
  }
  const verdictRaw = obj.verdict
  const verdict: SurfaceVerdict = verdictRaw === 'connectable' || verdictRaw === 'weak' || verdictRaw === 'unusable'
    ? verdictRaw
    : (capabilities.some((c) => c.confidence === 'verified') ? 'connectable'
      : capabilities.some((c) => c.confidence === 'probable') ? 'weak' : 'unusable')
  return {
    capabilities,
    verdict,
    hasVerified: capabilities.some((c) => c.confidence === 'verified'),
    hasProbable: capabilities.some((c) => c.confidence === 'probable'),
  }
}

/** 分三组展示（与后端 renderSurfaceReport 的三段一一对应） */
export function groupCapabilities(surface: AppSurface | null): {
  verified: SurfaceCapability[]; probable: SurfaceCapability[]; dead: SurfaceCapability[]
} {
  const caps = surface?.capabilities ?? []
  return {
    verified: caps.filter((c) => c.confidence === 'verified'),
    probable: caps.filter((c) => c.confidence === 'probable'),
    dead: caps.filter((c) => c.confidence === 'unusable'),
  }
}

/** 「这个应用现在怎么接的」一行摘要（清单回答"有哪些路"，它回答"正在走哪条"） */
export function summarizeSpec(spec: { driver?: string; commands?: { kind?: string }[] } | null | undefined): string {
  if (!spec) return ''
  const cmds = Array.isArray(spec.commands) ? spec.commands : []
  const reads = cmds.filter((c) => c?.kind === 'read').length
  const writes = cmds.filter((c) => c?.kind === 'write').length
  return `driver=${spec.driver || '（未记录）'} · ${cmds.length} 条命令（${reads} 只读 / ${writes} 写入）`
}

/** 评审结论摘要（M4 的 spec.review 在界面上要看得见） */
export function reviewSummary(review: unknown): string | null {
  if (!review || typeof review !== 'object') return null
  const r = review as { outcome?: unknown; gaps?: unknown[] }
  const gaps = Array.isArray(r.gaps) ? r.gaps : []
  if (r.outcome === 'skipped-budget') return '本次未做覆盖度评审（预算不足）'
  if (r.outcome === 'review-failed') return '本次评审未完成（已跳过补全）'
  if (!gaps.length) return '评审：覆盖度到位'
  const n = `${gaps.length} 处缺口`
  if (r.outcome === 'refined') return `评审发现 ${n}（已补全一轮）`
  if (r.outcome === 'refine-failed') return `评审发现 ${n}（补全未通过试跑）`
  return `评审发现 ${n}`
}
