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
export const ROW_H = 92
/** 列数上限：超宽屏下 12 列会让"邻接关系"横向拉得太散，眼睛来回扫很累 */
const MAX_COLS = 6
/**
 * 孤立区与关联区之间留的空行数（S5.1）。靠这条**空白带**把两区在视觉上分开——
 * 没有它，"未关联"就只是网格尾部几行，读起来像"没连线的残渣"而不是一个类别。
 */
const ISOLATED_GAP_ROWS = 1

/** 列数 ≈ sqrt(n)（正方形网格）、下限 1、上限 MAX_COLS */
function colsOf(n: number): number {
  return Math.min(Math.max(Math.ceil(Math.sqrt(n)), 1), MAX_COLS)
}

export interface NodePosition { id: string; x: number; y: number }

/** 度数表（度 = 入边 + 出边计数，自环算 2 次——它不是错误数据，只是"自我引用"） */
export function nodeDegrees(edges: readonly GraphEdgeLike[]): Map<string, number> {
  const deg = new Map<string, number>()
  const bump = (id: string) => { if (id) deg.set(id, (deg.get(id) ?? 0) + 1) }
  for (const e of edges) { bump(e?.from); bump(e?.to) }
  return deg
}

export interface GraphSectionLayout {
  positions: NodePosition[]
  /** 孤立区（度=0）首行的 y 坐标；无孤立节点时 null。视图据此在画布上画分区标签 */
  isolatedTopY: number | null
  /** 孤立节点数（度=0） */
  isolatedCount: number
  /** 关联节点数（度>0） */
  connectedCount: number
}

/**
 * 图谱**分区**布局（S5.1）：在 `layoutGraph` 的基础上额外回报"孤立区从哪开始"。
 *
 * 为什么单独导出而不是改 `layoutGraph` 的返回类型：`layoutGraph` 的数组签名被既有单测
 * 与"只要坐标"的调用点依赖，改签名会连带改一批无关心的地方；
 * 而"孤立区起点"只有画布需要（画分区标签）。分成两个函数，各自职责单一。
 */
export function layoutSections(nodes: readonly GraphNodeLike[], edges: readonly GraphEdgeLike[]): GraphSectionLayout {
  const list = nodes.filter(n => n && n.id)
  if (!list.length) return { positions: [], isolatedTopY: null, isolatedCount: 0, connectedCount: 0 }
  const deg = nodeDegrees(edges)
  // 度数降序；同度按 id 升序兜底（否则结果由 sort 实现决定，不稳定）
  const bySort = (a: { id: string }, b: { id: string }) => {
    const d = (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  }
  // **分两区排布**（S5.1 用户实测反馈："只有上部的条目连接了，下边的全都没有连"）。
  // 原来按度数降序**混排**成一个网格 ⇒ 全部零度节点必然连续沉到最底部若干行：
  // 真实库 72 节点 / 15 个孤立时，视觉上就是"上半有连线、下半全断线"，看着像图谱坏了。
  // 现在把零度节点提出来，单独排成一个**整齐的区块**（中间留空行 + 画布分区标签），
  // 让"未关联"被读成一个明确的类别，而不是网格尾部的残渣。
  //
  // 零度节点**不删不隐藏**："这条经验暂时没有关联"本身有信息量
  // （真实库那 8 条多是主题唯一的真经验，如"编辑工具陷阱"），隐藏反而像数据丢失。
  const connected = list.filter(n => (deg.get(n.id) ?? 0) > 0).sort(bySort)
  const isolated = list.filter(n => (deg.get(n.id) ?? 0) === 0).sort(bySort)
  const grid = (arr: GraphNodeLike[], y0: number) => {
    const cols = colsOf(arr.length)
    return arr.map((n, i) => ({ id: n.id, x: (i % cols) * COL_W, y: y0 + Math.floor(i / cols) * ROW_H }))
  }
  const positions = grid(connected, 0)
  let isolatedTopY: number | null = null
  if (isolated.length) {
    const rowsUsed = connected.length ? Math.ceil(connected.length / colsOf(connected.length)) : 0
    isolatedTopY = rowsUsed * ROW_H + ISOLATED_GAP_ROWS * ROW_H
    positions.push(...grid(isolated, isolatedTopY))
  }
  return { positions, isolatedTopY, isolatedCount: isolated.length, connectedCount: connected.length }
}

/**
 * 节点 → 坐标。入参顺序**不影响**结果（内部先排序），视图侧可以放心直接用后端给的顺序。
 * 空入参 → []（调用方据 nodes.length 走空态，不会走到这里）。
 */
export function layoutGraph(nodes: readonly GraphNodeLike[], edges: readonly GraphEdgeLike[]): NodePosition[] {
  return layoutSections(nodes, edges).positions
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
