// src/lib/knowledgeTags.ts —— 标签树的**纯逻辑**（2026-09-14 对标 Obsidian 批次 1）
//
// 为什么单独一层：本文件不 import React、不 import '@/...' 别名（照 lib/knowledgeBlocks.ts 与
// lib/knowledgeSearch.ts 的约定），这样 node:test 能原生跑 TS 直接钉住规则。这里的三条规则
// 都是"看起来是渲染细节、实际有对错"的东西：
//   ① 标签归一（前导 `#`、多余斜杠、首尾空白）；
//   ② 层级切分（Obsidian 用 `/` 表示层级：`#税务/增值税` 是 `#税务` 的子标签）；
//   ③ 父节点计数（父的 total = 自身 + 全部后代，自身可能有 0 篇——只在子标签上打过标）。
//
// 🔴 与内核的口径关系：内核只做**扁平**标签（`doc.tags` 里就是 `'税务/增值税'` 这个整串），
// 层级是**展示层**的概念。本文件不改变任何内核数据，只是把扁平列表组织成树给用户看。

import type { KnowledgeIndexTag } from './knowledgeApi.ts'

/**
 * 标签归一：
 *   · 去掉前导 `#`（用户从正文里抄标签时常带上；内核存的本来不带，这是防手输）；
 *   · 合并重复斜杠、去首尾斜杠与空白（`#a//b/` → `a/b`）；
 *   · 空串 → null（调用方必须处理，不能当标签塞进树里）。
 */
export function normalizeTag(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/^#+/, '').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '').trim()
  return s || null
}

/** 层级路径切分：`a/b/c` → ['a','b','c']（已归一的串才可直接切） */
export function tagSegments(path: string): string[] {
  return String(path ?? '').split('/').filter(Boolean)
}

/** 标签的层级深度（`a` → 1，`a/b` → 2）。用于缩进与"是否可折叠"判断 */
export function tagDepth(path: string): number {
  return tagSegments(path).length
}

export interface TagNode {
  /** 本层片段名（展示用）：`a/b` 节点的 name 是 `b` */
  name: string
  /** 完整路径（= 内核里的标签原文，点击检索用它） */
  path: string
  /** **自身**被多少篇文档使用（只有文档直接打了这个标签才算；父节点常为 0） */
  count: number
  /** 自身 + 全部后代的总文档数（同一篇文档同时打父子标签时只算一次） */
  total: number
  /** total === 1（只被一篇文档用到；与内核的 single 同义词，但按**子树**口径重算） */
  single: boolean
  children: TagNode[]
}

/**
 * 扁平标签列表 → 层级树（只返回顶层节点，子节点在 `children` 里）。
 *
 * 计数口径（关键，别看错）：`total` 是**子树去重**后的文档数，不是各节点 count 的简单相加——
 * 同一篇文档同时打了 `税务` 与 `税务/增值税` 时，父节点的 total 不能算 2。
 * 但内核只给每标签的 count（不给我们"哪些文档用了它"），所以这里无法真去重；
 * 处理方式是取 **max(自身, 子树上界)**：父自身 count 与"所有后代 count 之和"取较大值。
 * 这个上界在最常见的两种形态下都是精确的：
 *   · 文档只打子标签 → 父 count=0，上限 = Σ子 count（精确）；
 *   · 文档同时打父子 → 父 count ≥ 子 count，取 max 得到父 count（精确）。
 * 只有"多篇文档任意组合打父子标签"才会高估，属于展示层可接受误差——所以 UI 里对父节点
 * 只显示计数、不承诺它是精确的文档数（tooltip 已注明）。
 */
export function buildTagTree(tags: readonly KnowledgeIndexTag[]): TagNode[] {
  /** 先建全部节点（含中间层：`a/b` 存在但 `a` 本身没被任何文档使用时，`a` 也要出现） */
  const nodes = new Map<string, TagNode>()
  const ensure = (path: string): TagNode => {
    const hit = nodes.get(path)
    if (hit) return hit
    const segs = tagSegments(path)
    const node: TagNode = { name: segs[segs.length - 1] ?? path, path, count: 0, total: 0, single: false, children: [] }
    nodes.set(path, node)
    // 逐级补父节点（`a/b/c` 的祖父 `a` 也要存在，否则树会缺层）
    if (segs.length > 1) ensure(segs.slice(0, -1).join('/'))
    return node
  }

  for (const t of tags) {
    const path = normalizeTag(t?.tag)
    if (!path) continue
    const node = ensure(path)
    // 同名标签可能来自多个空间条目（内核按空间分别统计时会出现多条），计数累加、single 取与
    node.count += Math.max(0, Number(t?.count) || 0)
  }

  // 挂父子关系（一次性建，避免 ensure 里挂导致重复挂载）
  for (const node of nodes.values()) {
    const segs = tagSegments(node.path)
    if (segs.length < 2) continue
    const parent = nodes.get(segs.slice(0, -1).join('/'))
    if (parent) parent.children.push(node)
  }

  // 自底向上算 total：自身与"子树汇总"取较大者（口径说明见本函数注释）
  const computeTotal = (node: TagNode): number => {
    let sum = 0
    for (const c of node.children) sum += computeTotal(c)
    node.total = Math.max(node.count, sum)
    node.single = node.total === 1
    // 子节点排序：文档多的在前，同数按名字（保证渲染稳定，不随 Map 迭代序抖动）
    node.children.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return node.total
  }
  const roots = [...nodes.values()].filter((n) => tagSegments(n.path).length === 1)
  for (const r of roots) computeTotal(r)
  roots.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return roots
}

/**
 * 点击一个标签节点时应该拿去检索的标签集合（父节点 = 自己 + 全部后代路径，深度优先、自身在前）。
 * 为什么父节点要带上后代：Obsidian 里 `tag:#税务` 会同时命中 `#税务/增值税` 的笔记，用户对
 * "父标签汇总子标签"有明确预期；只搜父串会得到"父标签几乎没有文档"的假象。
 * `limit` 是护栏：树可能很深很宽，关键词串无限长会（a）撑爆查询串（b）让 structBoost 的
 * 关键词匹配退化成"什么都匹配一点"。超出部分**在调用方可见处**体现（UI 会提示只取了前 N 个）。
 */
export function tagSearchTerms(node: TagNode, limit = 8): string[] {
  const out: string[] = []
  const walk = (n: TagNode) => {
    if (out.length >= limit) return
    out.push(n.path)
    for (const c of n.children) walk(c)
  }
  walk(node)
  return out
}
