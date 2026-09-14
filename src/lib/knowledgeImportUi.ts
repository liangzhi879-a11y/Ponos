// src/lib/knowledgeImportUi.ts —— 知识库文件导入上限的 UI 归约纯函数
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、不 import 任何运行时依赖
//（照 src/lib/logUi.ts 先例）。
//
// **数字必须与 server/knowledge-import-policy.cjs 逐位一致**（那是唯一真源）：两边对不上会出现
// "界面能填 5000、实际被钳到 500"这类幽灵问题，而用户只会看到"设置没生效"。
// 一致性由 server/knowledge-import-policy-parity.test.mjs 直接 import 两侧做深比较钉住。

const MB = 1024 * 1024

export interface KnowledgeImportPolicy {
  /** 单次导入的最大文件数（整批拒绝式护栏：超了就一个都不导） */
  maxFiles: number
  /** 单次导入的最大总字节数（同上，整批拒绝） */
  maxTotalBytes: number
}

export interface KnowledgeImportLimits {
  minFiles: number
  maxFiles: number
  minTotalBytes: number
  maxTotalBytes: number
}

/** 与 server/knowledge-import-policy.cjs 的 IMPORT_POLICY_LIMITS 一致（parity 测试钉住）。 */
export const KNOWLEDGE_IMPORT_LIMITS: KnowledgeImportLimits = {
  minFiles: 1, maxFiles: 20000,
  minTotalBytes: 1 * MB, maxTotalBytes: 20 * 1024 * MB,
}

/** 与 server/knowledge-import-policy.cjs 的 DEFAULT_IMPORT_POLICY 一致（500 文件 / 300MB）。 */
export const DEFAULT_KNOWLEDGE_IMPORT_POLICY: KnowledgeImportPolicy = {
  maxFiles: 500,
  maxTotalBytes: 300 * MB,
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/** 任意输入 → 合法策略。语义与 server/knowledge-import-policy.cjs:normalizeImportPolicy 完全一致。 */
export function normalizeKnowledgeImportPolicyUi(raw: unknown): KnowledgeImportPolicy {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {}
  return {
    maxFiles: clampInt(r.maxFiles, KNOWLEDGE_IMPORT_LIMITS.minFiles, KNOWLEDGE_IMPORT_LIMITS.maxFiles, DEFAULT_KNOWLEDGE_IMPORT_POLICY.maxFiles),
    maxTotalBytes: clampInt(r.maxTotalBytes, KNOWLEDGE_IMPORT_LIMITS.minTotalBytes, KNOWLEDGE_IMPORT_LIMITS.maxTotalBytes, DEFAULT_KNOWLEDGE_IMPORT_POLICY.maxTotalBytes),
  }
}

/** 导入进度的归约（纯函数，供进度条与文案共用；"先查文件数、再按已处理数算百分比"）。 */
export interface ImportProgress {
  phase: 'idle' | 'plan' | 'process' | 'done' | 'error'
  /** 已完成数（process 阶段 = 循环下标；done 阶段 = total） */
  done: number
  /** 计划文件数（先查文件数得到；未查到时为 0） */
  total: number
  /** 当前处理的相对路径（process 阶段才有） */
  current?: string
  /** 终态错误信息 */
  error?: string
}

export const IDLE_IMPORT_PROGRESS: ImportProgress = { phase: 'idle', done: 0, total: 0 }

/**
 * 完成百分比（0-100 的整数）。
 * total 未知（0）时返回 0 而不是 NaN/100 —— 进度条在"还没查到文件数"时应显示 0%
 * 而不是瞬间满格（后者会让用户以为已经导完）。
 */
export function importPercent(p: Pick<ImportProgress, 'done' | 'total'>): number {
  const total = Math.floor(Number(p.total))
  const done = Math.floor(Number(p.done))
  if (!Number.isFinite(total) || total <= 0) return 0
  if (!Number.isFinite(done) || done <= 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
}

/** 进度文案（中文，含 n/N 计数）。供对话框底部一行文字直接渲染。 */
export function importProgressText(p: ImportProgress): string {
  switch (p.phase) {
    case 'idle': return '待开始'
    case 'plan': return `已发现 ${p.total} 个文件，准备导入…`
    case 'process': return `正在处理 ${Math.min(p.done + 1, p.total)}/${p.total}${p.current ? `：${p.current}` : ''}`
    case 'done': return `已完成 ${p.total}/${p.total}`
    case 'error': return `导入失败${p.error ? `：${p.error}` : ''}`
    default: return '待开始'
  }
}

/** 把 CLI 的 NDJSON 进度行归约成 ImportProgress（未知形状 → null，调用方忽略该行）。 */
export function reduceProgressEvent(evt: unknown): ImportProgress | null {
  if (!evt || typeof evt !== 'object') return null
  const e = evt as Record<string, unknown>
  const phase = e.phase
  if (phase !== 'plan' && phase !== 'process' && phase !== 'done') return null
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0)
  return {
    phase,
    done: num(e.done),
    total: num(e.total),
    ...(typeof e.current === 'string' && e.current ? { current: e.current } : {}),
  }
}
