// src/lib/knowledgeRelations.ts —— 关联锚点的纯逻辑（S5 Task 9）
//
// 为什么单独一个文件：本仓库没有 DOM 测试环境（S2 已裁定），组件里写死的分组/排序/裁剪
// 等于**不可测**。故把"锚点怎么分组、怎么排、shared 词怎么裁、图谱两层边怎么合"
// 全部收成纯函数，组件只做 map/render（照 lib/knowledgeBlocks.ts、lib/knowledgeInspector.ts
// 的既有分工）。零 React、零 '@/' 别名、零副作用 —— `node --test` 直接跑。
//
// 口径与内核严格同源（**别在这里发明第二套**）：
//   · 层序：tag（骨架层，同主题，零噪声）→ content（覆盖层，内容相似）→ duplicate（疑似重复）
//     内核 `relatedOf` 用 relRank 排同一顺序（kernel/knowledge.mjs），这里重复它是因为
//     排序键**不能**依赖"内核恰好排好序"：卡片行要按分组分别渲染，分组内顺序必须自己可控。
//   · duplicate **不是关联**（spec §5.5）：它是"去重提示"，故 splitAnchors 把它单独摘出来，
//     绝不与 tag/content 混在一起（混了用户会以为重复项也值得一读）。
//   · 未知 kind 归 `other` 并**从界面剔除**：内核将来若加新层（比如"同目录"），
//     GUI 不该把它当成已解释的关联静默展示 —— 少显示一类比错标一类安全。
import type {
  KnowledgeGraphRelatedEdge, KnowledgeRelatedAnchor, KnowledgeRelatedBlock,
} from './knowledgeApi.ts'

/** 分组键（`other` 只用于兜底识别，界面上不渲染，见文件头） */
export type RelatedGroup = 'themed' | 'similar' | 'duplicate' | 'other'

/** 层序（与内核 relRank 同序）：越小越可信 */
const GROUP_RANK: Record<RelatedGroup, number> = { themed: 0, similar: 1, duplicate: 2, other: 3 }

/** 分组键 → RelatedGroups 的字段名（`duplicate` 复数化：那一栏装的是多条候选） */
const GROUP_KEY: Record<RelatedGroup, keyof RelatedGroups> = {
  themed: 'themed', similar: 'similar', duplicate: 'duplicates', other: 'other',
}

export interface RelatedGroups {
  /** 同主题（why.kind === 'tag'）—— 默认展开 */
  themed: KnowledgeRelatedAnchor[]
  /** 内容相似（why.kind === 'content'）—— 默认折叠 */
  similar: KnowledgeRelatedAnchor[]
  /** 疑似重复（why.kind === 'duplicate'）—— 独立提示，不属于关联区 */
  duplicates: KnowledgeRelatedAnchor[]
  /** 未知 kind（将来新增层）：计数保留，界面不渲 */
  other: KnowledgeRelatedAnchor[]
}

/**
 * `why.kind` → 分组。宽容处理：`why` 可能是 undefined/字符串（上游契约微调、旧索引），
 * 一律归 `other` 而不是抛错 —— 读侧永远不该因为一个解释字段的形状而白屏。
 */
export function relatedGroup(why: unknown): RelatedGroup {
  const kind = (why && typeof why === 'object') ? String((why as { kind?: unknown }).kind ?? '') : ''
  if (kind === 'tag') return 'themed'
  if (kind === 'content') return 'similar'
  if (kind === 'duplicate') return 'duplicate'
  return 'other'
}

/** 锚点排序键：层序 → content 分数降序 → blockId 升序（末项保证同一输入两次渲染顺序一致） */
function compareAnchors(a: KnowledgeRelatedAnchor, b: KnowledgeRelatedAnchor): number {
  const ra = GROUP_RANK[relatedGroup(a?.why)]
  const rb = GROUP_RANK[relatedGroup(b?.why)]
  if (ra !== rb) return ra - rb
  const sa = typeof a?.score === 'number' && Number.isFinite(a.score) ? a.score : -1
  const sb = typeof b?.score === 'number' && Number.isFinite(b.score) ? b.score : -1
  if (sa !== sb) return sb - sa
  return String(a?.blockId ?? '').localeCompare(String(b?.blockId ?? ''))
}

/**
 * 锚点 → 分组（含排序 + 去重）。
 * 去重按 `blockId`：同一目标块只留一条 —— 内核按对去重（relKey），正常不会重复；但"同一块
 * 既是同主题又是内容相似"在**将来**两层都算时会出现，界面上同一目标出现两次会被读成两条不同关系。
 */
export function splitAnchors(anchors?: readonly KnowledgeRelatedAnchor[] | null): RelatedGroups {
  const out: RelatedGroups = { themed: [], similar: [], duplicates: [], other: [] }
  const seen = new Set<string>()
  for (const a of anchors ?? []) {
    const key = String(a?.blockId ?? '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    out[GROUP_KEY[relatedGroup(a?.why)]].push(a)
  }
  out.themed.sort(compareAnchors)
  out.similar.sort(compareAnchors)
  out.duplicates.sort(compareAnchors)
  return out
}

/** 计数（卡片行与 Inspector 段头的"N"） */
export function relatedCounts(anchors?: readonly KnowledgeRelatedAnchor[] | null): { themed: number; similar: number; duplicate: number } {
  const g = splitAnchors(anchors)
  return { themed: g.themed.length, similar: g.similar.length, duplicate: g.duplicates.length }
}

/** 是否有可展示的**关联**（tag/content）。全空 → 卡片不渲染关联行（不留空壳，spec §7.5） */
export function hasRelations(anchors?: readonly KnowledgeRelatedAnchor[] | null): boolean {
  const g = splitAnchors(anchors)
  return g.themed.length > 0 || g.similar.length > 0
}

/**
 * `shared` 词裁剪：界面上最多列 `max` 个，其余折成计数。
 * 为什么裁：`shared` 最多 5 个（内核 sharedFeatures 的 topN），但 212px 的右栏与卡片宽度下
 * 5 个词会折行两三次，把"为什么相似"挤成噪声；超出部分用 "+N" 保留信息量而不占版面。
 * 非字符串/空白项一律剔除（脏数据不该渲染成空 chip）。
 */
export function trimShared(shared: unknown, max = 3): { words: string[]; more: number } {
  const all = (Array.isArray(shared) ? shared : [])
    .map(x => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
  const n = Number.isFinite(max) && (max as number) >= 0 ? Math.floor(max as number) : 3
  return { words: all.slice(0, n), more: Math.max(0, all.length - n) }
}

/**
 * 疑似重复提示（卡片上的**独立**一行，不在关联区）。无重复 → null（调用方据此不渲染）。
 * `score` 取最高分：用户要的是"这两条有多像"，不是"平均有多像"。
 */
export function duplicateNotice(anchors?: readonly KnowledgeRelatedAnchor[] | null): { count: number; score: number | null } | null {
  const { duplicates } = splitAnchors(anchors)
  if (!duplicates.length) return null
  let best: number | null = null
  for (const d of duplicates) {
    if (typeof d.score !== 'number' || !Number.isFinite(d.score)) continue
    if (best === null || d.score > best) best = d.score
  }
  return { count: duplicates.length, score: best }
}

/** 分数显示：2 位小数（`0.21`）。null/NaN/Infinity → null（调用方不渲染分数，而不是显示 "NaN"） */
export function formatScore(score: unknown): string | null {
  return typeof score === 'number' && Number.isFinite(score) ? score.toFixed(2) : null
}

/**
 * `/knowledge/related?doc=` 的返回 → `blockId → 锚点`（卡片按块取用）。
 * 内核已过滤掉"没有锚点"的块，此处只做索引；重复 blockId 时**合并**（不覆盖）：
 * 覆盖会让上游改动静默丢数据，合并最坏只是多显示几条。
 */
export function indexByBlock(blocks?: readonly KnowledgeRelatedBlock[] | null): Map<string, KnowledgeRelatedAnchor[]> {
  const map = new Map<string, KnowledgeRelatedAnchor[]>()
  for (const b of blocks ?? []) {
    const key = String(b?.blockId ?? '')
    if (!key) continue
    const list = Array.isArray(b?.related) ? b.related : []
    const cur = map.get(key)
    map.set(key, cur ? [...cur, ...list] : [...list])
  }
  return map
}

/**
 * 整篇文档的锚点汇总（Inspector「关联」段用）：`/knowledge/related?doc=` 的多块结果拍平成一条列表。
 * 按**目标块**去重（`splitAnchors` 内部做）：同一目标被本文档的两条条目同时关联到时，右栏只该出现
 * 一次——重复出现会被读成"两条不同的关系"。`duplicate` / 未知层不参与（前者不是关联，后者未解释）。
 */
export function collectAnchors(blocks?: readonly KnowledgeRelatedBlock[] | null): KnowledgeRelatedAnchor[] {
  const all: KnowledgeRelatedAnchor[] = []
  for (const b of blocks ?? []) {
    if (Array.isArray(b?.related)) all.push(...b.related)
  }
  const { themed, similar } = splitAnchors(all)
  return [...themed, ...similar]
}

/** 图谱里的一条边（视图层只认这个形状，不关心它来自哪一层） */
export interface GraphEdgeView {
  id: string
  from: string
  to: string
  layer: 'link' | 'related'
  /** 显式链接的目标 docId（悬停标签用）；隐式边即 `to` */
  target: string
  /** 隐式边才有：层类与分值（视觉与悬停解释用） */
  kind?: 'tag' | 'content'
  score?: number | null
  count?: number
}

/**
 * 显式链接边的最小形状：内核 `getGraph` 的 `target` 是"解析后的目标文档"（相对链接可能解析不到），
 * 故是可选的 —— 视图层（lib/knowledgeGraph.resolvedEdges）已过滤，但类型上必须容许缺失。
 */
export interface GraphLinkLike { from: string; to: string; target?: string | null }

/** 无序对键：显式边若已存在，隐式边**不再画**（同一条关系不该出现两条线） */
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

/**
 * 图谱两层边合并（spec §7.5 的"图层开关"）。
 *
 * 规则（每一条都有理由，别随手改）：
 *   · `showRelated=false`（**默认**）→ 只有显式链接，且与 S2 的既有行为**逐字一致**
 *     （按有向对去重、保持输入顺序）——图层默认关时图谱必须零变化。
 *   · `showRelated=true` → 追加隐式边；与显式边**同无序对**时丢弃（显式优先：手写的引用是
 *     用户的明确意图，让它被一条虚线盖住是本末倒置）。
 *   · 自环（from === to）丢弃：xyflow 画不出有意义的自环，只会留个墨点。
 *   · 隐式边按 (层序, 分降序, from, to) 排好再加：层序与卡片一致，用户在两处看到的"更可信的"
 *     是同一批边。
 *   · `counts` 是**实际画出的**边数（不是拿到手的边数）——状头显示的数与画布上的线必须对得上。
 */
export function mergeGraphEdges(
  links?: readonly GraphLinkLike[] | null,
  related?: readonly KnowledgeGraphRelatedEdge[] | null,
  showRelated = false,
): { edges: GraphEdgeView[]; counts: { link: number; related: number } } {
  const edges: GraphEdgeView[] = []
  const seenDirected = new Set<string>()
  const seenPairs = new Set<string>()
  for (const e of links ?? []) {
    const from = String(e?.from ?? '')
    const to = String(e?.to ?? '')
    if (!from || !to || from === to) continue
    const id = `${from}->${to}`
    if (seenDirected.has(id)) continue        // 同一对文档的多条链接合成一条（S2 既有口径）
    seenDirected.add(id)
    seenPairs.add(pairKey(from, to))
    edges.push({ id, from, to, layer: 'link', target: String(e?.target || to) })
  }
  if (!showRelated) return { edges, counts: { link: edges.length, related: 0 } }

  const rel: GraphEdgeView[] = []
  for (const r of related ?? []) {
    const from = String(r?.from ?? '')
    const to = String(r?.to ?? '')
    if (!from || !to || from === to) continue
    if (seenPairs.has(pairKey(from, to))) continue
    const kind = r?.kind === 'tag' ? 'tag' : 'content'   // 内核只给这两类；其余按内容层兜底
    rel.push({
      id: `r:${from}->${to}`, from, to, layer: 'related', target: to,
      kind, score: typeof r?.score === 'number' && Number.isFinite(r.score) ? r.score : null,
      count: typeof r?.count === 'number' ? r.count : 0,
    })
  }
  rel.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tag' ? -1 : 1)
    || (b.score ?? -1) - (a.score ?? -1)
    || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  return { edges: [...edges, ...rel], counts: { link: edges.length, related: rel.length } }
}
