/**
 * 检索语法层的**前端镜像实现**（2026-09-14 对标 Obsidian 批次 3）。
 *
 * ⚠️ 仓库约定：前端**不 import** `shared/*.mjs`（内核与浏览器两套运行时，路径/打包方式不同）。
 * 本文件是 `shared/knowledge-query.mjs` 的手写同口径实现，**只承担 UI 职责**：
 *   · 输入提示（用户打到 `tag:` 时提示可用字段）
 *   · 算子回显（哪些算子已生效、是否处于严格布尔模式）
 *   · 高亮分词（把查询串拆成 token 用于着色，见 `tokenizeQueryForHighlight`）
 *
 * **它不参与检索结果的判定**：真正过滤/打分全在内核做，结果里带回的 `query` 元信息
 * （见 `knowledgeApi.ts` 的 `KnowledgeSearchResult.query`）才是权威来源。
 * 这条分界很重要 —— 前端复制一份判定逻辑出来，一旦两份实现漂移，用户会看到
 * "UI 说这个过滤生效了、结果却没按它过滤"这种最难排查的不一致。
 * 因此：**UI 显示"生效的算子"一律用内核回带的 `query.fields`，不用本地解析结果。**
 * 本地解析只用于"输入过程中的提示"（此时还没有结果可依据）。
 *
 * 与内核实现的行为差异（仅一处，且方向是"更保守"）：
 *   `section:` 在内核里会回溯**文档块顺序**找所属标题；前端拿不到完整 doc 结构，
 *   只能看块自身文本里的标题行。所以提示层面可能少报一个 section 命中 ——
 *   只是提示不够乐观，不会误导用户去信任一个假阳性。
 */

/** 支持的算子字段（与内核 `QUERY_FIELDS` 同集） */
export const QUERY_FIELD_HINTS = [
  { field: 'tag', descKey: 'knowledge.qfTag', example: 'tag:财务' },
  { field: 'path', descKey: 'knowledge.qfPath', example: 'path:reports/' },
  { field: 'file', descKey: 'knowledge.qfFile', example: 'file:周报' },
  { field: 'section', descKey: 'knowledge.qfSection', example: 'section:背景' },
  { field: 'content', descKey: 'knowledge.qfContent', example: 'content:营收' },
  { field: 'block', descKey: 'knowledge.qfBlock', example: 'block:^a1b2' },
] as const

/** 字段别名 → 规范名（与内核 `FIELD_ALIAS` 同表） */
const FIELD_ALIAS: Record<string, string> = {
  tag: 'tag', tags: 'tag',
  path: 'path',
  file: 'file', filename: 'file',
  section: 'section', heading: 'section',
  content: 'content', line: 'content',
  block: 'block',
}

export type QueryToken =
  | { kind: 'term' | 'phrase' | 'regex' | 'filter' | 'or'; text: string; negate: boolean; field?: string }

/**
 * 把 `x:y` 拆成算子。返回 null = **不是算子，按普通文本处理**。
 *
 * 这条与内核完全一致，也是本文件最重要的一条：用户搜 `10:30`、`http://a.com` 时
 * 形如 `x:y` 的 token 到处都是，若"任何 `x:y` 都当算子"，UI 会提示"字段 10 已生效"
 * 而结果按文本搜 —— 提示与实际行为不符，比不提示更糟。
 */
export function splitOperator(token: string): { field: string; value: string } | null {
  const i = token.indexOf(':')
  if (i <= 0 || i === token.length - 1) return null
  const field = FIELD_ALIAS[token.slice(0, i).toLowerCase()]
  if (!field) return null
  const value = token.slice(i + 1)
  return value ? { field, value } : null
}

/**
 * 切词（供**高亮**使用）：保留每个 token 的原文与类型，不做语义判定。
 * 与内核 `tokenize` 同一套边界规则（引号内不拆、`/…/` 用最后一个 `/` 收尾），
 * 这样"高亮出来的分段"与"内核理解的算子"在视觉上一致。
 */
export function tokenizeQueryForHighlight(raw: string): QueryToken[] {
  const text = String(raw ?? '')
  const out: QueryToken[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }
    if (ch === '"') {
      const end = text.indexOf('"', i + 1)
      const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end)
      if (body) out.push({ kind: 'phrase', text: `"${body}"`, negate: false })
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === '/') {
      const end = text.lastIndexOf('/')
      if (end > i) {
        const body = text.slice(i + 1, end)
        if (body) out.push({ kind: 'regex', text: `/${body}/`, negate: false })
        i = end + 1
        continue
      }
    }
    let j = i
    while (j < text.length && !' \t\n\r'.includes(text[j])) j += 1
    const rawTok = text.slice(i, j)
    i = j
    if (rawTok === 'OR') { out.push({ kind: 'or', text: rawTok, negate: false }); continue }
    let negate = false
    let body = rawTok
    if (body.startsWith('-') && body.length > 1) { negate = true; body = body.slice(1) }
    const op = splitOperator(body)
    if (op) out.push({ kind: 'filter', text: rawTok, negate, field: op.field })
    else out.push({ kind: 'term', text: rawTok, negate })
  }
  return out
}

/**
 * 输入提示：当前查询里"已经用到的算子字段"与"是否处于严格布尔模式"。
 * 仅用于**输入过程中**的提示（此时还没有内核结果可依据）——结果返回后一律以内核回带的
 * `query.fields` 为准（见文件头）。
 */
export function describeQuery(raw: string): {
  fields: string[]
  negated: boolean
  hasOr: boolean
  hasPhrase: boolean
  hasRegex: boolean
  /** 查询非空但没有任何正向文本检索词（如只写了 `-foo` 或只写了 `tag:x`）→ UI 该解释"为何按标签/路径枚举" */
  noPositiveText: boolean
} {
  const tokens = tokenizeQueryForHighlight(raw)
  const fields: string[] = []
  let negated = false
  let hasOr = false
  let hasPhrase = false
  let hasRegex = false
  let positiveText = false
  for (const t of tokens) {
    if (t.negate) negated = true
    if (t.kind === 'or') hasOr = true
    if (t.kind === 'phrase') { hasPhrase = true; if (!t.negate) positiveText = true }
    if (t.kind === 'regex') { hasRegex = true; if (!t.negate) positiveText = true }
    if (t.kind === 'filter') { if (t.field && !fields.includes(t.field)) fields.push(t.field) }
    if (t.kind === 'term' && !t.negate) positiveText = true
  }
  return {
    fields, negated, hasOr, hasPhrase, hasRegex,
    noPositiveText: tokens.length > 0 && !positiveText,
  }
}
