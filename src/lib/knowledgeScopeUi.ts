// src/lib/knowledgeScopeUi.ts —— 会话知识范围的界面判据（2026-09-15）
//
// 来源需求：待处理清单 P1「会话模式关联经验库之外的知识库」。
//
// **这些常量是内核常量的镜像**（值以 `kernel/knowledge.mjs` 为准，那边写了 why）：
//   · MAX_ASSOC_SPACES  = kernel/knowledge.mjs  MAX_ASSOC_SPACES
//   · LARGE_SPACE_DOCS  = kernel/knowledge.mjs  LARGE_SPACE_DOCS
// 镜像而不是"从内核 import"的原因：内核是独立进程（spawn 的 CLI + .mjs），前端打包不该把
// 内核模块拉进 bundle。代价是两处可能漂移——故让**内核始终是收口方**：这里判错最多是"多画
// 一个提示 / 少拦一次点击"，真正的越界与截断由内核执行，界面不承担权限判定职责。
//
// 只放纯函数：组件的渲染逻辑与这里的判据分离，判据可单测（见 knowledgeScopeUi.test.ts）。

/** 会话可关联的知识库数量上限（镜像 kernel/knowledge.mjs MAX_ASSOC_SPACES）。 */
export const MAX_ASSOC_SPACES = 8

/** 「大库」阈值（镜像 kernel/knowledge.mjs LARGE_SPACE_DOCS）：超过就提示注入受预算限制。 */
export const LARGE_SPACE_DOCS = 1000

/**
 * 该空间能否**关联到会话**。
 *
 * 只有用户自建库（source='user'）与知识包（source='pack'）需要这个开关：内置经验库/会话记忆
 * **恒在会话范围内**（kernel/knowledge.mjs 的 D4：经验库是执行任务的基础设施，不可被移除）。
 * 给它们画一个开关是最坏的一种 UI——点了没反应（内核会忽略），用户会以为功能坏了。
 * 判据与内核 `BUILTIN_SCOPE_SOURCES` 同义：不是 user/pack 的一律不给开关。
 */
export function isAssociableSpace(space: { source?: string } | null | undefined): boolean {
  const src = space?.source
  return src === 'user' || src === 'pack'
}

/**
 * 归一为「数组 或 undefined」（与 bridge `normalizeKnowledgeSpaces`、chatStore
 * `sanitizeKnowledgeSpaces` 同口径：去空、去重、**保序**；空 → undefined = 未关联）。
 */
export function normalizeKnowledgeSpaces(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const list = [...new Set(v.map((s) => String(s ?? '').trim()).filter(Boolean))]
  return list.length ? list : undefined
}

export type ToggleResult = {
  /** 归一后的新值（undefined = 本次操作把最后一个关联取消了） */
  spaces: string[] | undefined
  /** 被拒绝的原因：超上限时**不静默丢弃**，由界面出声（与内核 dropped 出声同一纪律） */
  rejected?: 'limit'
}

/**
 * 切换某个库的关联状态（纯函数，不碰 store —— 组件与单测共用同一套语义）。
 * 已在列表 → 移除；不在列表 → 追加（超上限则原样返回 + rejected:'limit'）。
 */
export function toggleKnowledgeSpace(current: unknown, id: string): ToggleResult {
  const list = normalizeKnowledgeSpaces(current) ?? []
  const target = String(id ?? '').trim()
  if (!target) return { spaces: list.length ? list : undefined }
  if (list.includes(target)) return { spaces: normalizeKnowledgeSpaces(list.filter((x) => x !== target)) }
  if (list.length >= MAX_ASSOC_SPACES) return { spaces: list, rejected: 'limit' }
  return { spaces: [...list, target] }
}

/** 是否该显示「大库」提示（G4）：体量超过阈值时，用户需要知道"别指望它整库进上下文"。 */
export function isLargeSpace(docCount: number | undefined | null): boolean {
  return Number(docCount) > LARGE_SPACE_DOCS
}
