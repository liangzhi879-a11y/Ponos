// src/lib/knowledgeGraph.ts —— 图谱视图的**纯逻辑**（S2 Task 8）
//
// 为什么自己算布局而不引 dagre/elk：**零新增依赖**（spec §2 硬约束）。图谱视图的用途是
// "看谁引用谁 + 点进去读"，不是画流程图；网格布局（无重叠、确定性）足够用，且它带来一个
// 关键性质——**同一次数据两次渲染位置完全一致**：若用随机/力导向布局，每次切视图回来
// 画布都在乱动，用户刚记住的空间位置立刻失效。
//
// 排序取「邻居数降序，再按 id 升序」：hub 文档排到前面（第一眼看到最相关的），
// 第二关键字保证确定性（`Array#sort` 在比较函数返回 0 时顺序由实现决定，不能只按度数排）。
//
// 不 import React、不 import '@xyflow/react'：本文件要被 `node --test` 直接加载，
// 布局结果由视图侧翻译成 xyflow 的 node 形状（翻译是纯赋值，没有可测逻辑）。
// 也不 import '@/...' 别名（node 原生 TS 不认，照 lib/knowledgeBlocks.ts 头部约定）。

export interface GraphNodeLike { id: string }
export interface GraphEdgeLike {
  from: string
  to: string
  /** 链接目标 docId（内核 getGraph 原样回；可选是给"只要 from/to"的纯布局调用留余地） */
  target?: string
}

/** 网格单元尺寸：节点卡片最大 188px 宽 / 两行文字 ≈ 46px 高，留出连线走线的余量 */
const COL_W = 216
const ROW_H = 92
/** 列数上限：超宽屏下 12 列会让"邻接关系"横向拉得太散，眼睛来回扫很累 */
const MAX_COLS = 6

export interface NodePosition { id: string; x: number; y: number }

/** 度数表（度 = 入边 + 出边计数，自环算 2 次——它不是错误数据，只是"自我引用"） */
export function nodeDegrees(edges: readonly GraphEdgeLike[]): Map<string, number> {
  const deg = new Map<string, number>()
  const bump = (id: string) => { if (id) deg.set(id, (deg.get(id) ?? 0) + 1) }
  for (const e of edges) { bump(e?.from); bump(e?.to) }
  return deg
}

/**
 * 节点 → 坐标。入参顺序**不影响**结果（内部先排序），视图侧可以放心直接用后端给的顺序。
 * 空入参 → []（调用方据 nodes.length 走空态，不会走到这里）。
 */
export function layoutGraph(nodes: readonly GraphNodeLike[], edges: readonly GraphEdgeLike[]): NodePosition[] {
  const list = nodes.filter(n => n && n.id)
  if (!list.length) return []
  const deg = nodeDegrees(edges)
  const ordered = [...list].sort((a, b) => {
    const d = (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
  // 列数 ≈ sqrt(n)（正方形网格）、下限 1、上限 MAX_COLS
  const cols = Math.min(Math.max(Math.ceil(Math.sqrt(ordered.length)), 1), MAX_COLS)
  return ordered.map((n, i) => ({ id: n.id, x: (i % cols) * COL_W, y: Math.floor(i / cols) * ROW_H }))
}

/**
 * 丢掉两端不全在节点集里的边。内核 `getGraph` 已按 `ids.has` 过滤过（kernel/knowledge.mjs:601-609），
 * 这里是**防御性重做**：xyflow 对"悬空边"会打 console error 并静默丢弃，一旦上游哪天放宽
 * （例如为省流量只回节点子集），画布上会出现莫名其妙的一条条报错而没人知道为什么。
 */
export function resolvedEdges(
  nodes: readonly GraphNodeLike[],
  edges: readonly GraphEdgeLike[],
): GraphEdgeLike[] {
  const ids = new Set(nodes.map(n => n.id))
  return edges.filter(e => e && ids.has(e.from) && ids.has(e.to))
}

/**
 * docId（`space/rel/path.md`）→ 末段短名，用于边上的目标标签与节点副标题。
 * 为什么要截：完整 id 在 200px 宽的节点里只能显示前 20 个字符（全是空间名前缀），
 * 末段才是用户能对上号的文件名。
 */
export function shortRef(docId: string): string {
  const parts = String(docId ?? '').split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(docId ?? '')
}
