// src/stores/knowledgeStore.ts —— 知识库面板的**持久化 UI 态**（S2 Task 1）
//
// 为什么单独一个 store：知识面板的「当前空间 / 当前文档 / 当前视图 / 树展开态」要在刷新与重启后保留。
// 塞进 viewStore 会让每次展开目录都写一遍全局 workState——语义被污染，且所有 viewStore
// 订阅者（RailNav/WorkShell…）跟着重建。
//
// persist key `yfworking-knowledge`；**落盘只含展开态**（照 FileBrowser.tsx:24 的扁平 map 范式，
// 而不是嵌套树——扁平便于局部更新与落盘裁剪）：
//   · `entries`（目录列表）是易失数据：落盘既膨胀 localStorage，又让过期列表无法自愈
//     （文件在别处被删/新增后，重启回读的是陈旧快照）；
//   · `loaded` 同理，重启后重置 false，展开的分支会重新拉取。
//
// merge **白名单清洗**（照 viewStore.ts:41-73 范式）：非法 view → 'read'，非法 spaceId → null，
// tree 结构损坏 → {}。清洗函数一律**不抛**——persist 的 merge 抛错会让整个 store 崩掉，
// 面板直接白屏，比"丢几个展开态"严重得多。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { KnowledgeTreeEntry } from '@/lib/knowledgeApi'

/**
 * 五视图（阅读/编辑/图谱/搜索/**市场**）；'edit' 在只读空间由视图层拒绝进入，store 不做权限判断。
 * `market`（S4 Task 6 新增）是**有意的功能扩展**：知识包市场与当前空间**无关**
 * （离线安装 / 在线清单都不需要先选空间），故它在 KnowledgePanel 里排在 `!space` 空态之前短路。
 * 它同样可持久化——用户上次停在市场，重启后应回到市场，而不是被踢回阅读视图。
 */
export type KnowledgeView = 'read' | 'edit' | 'graph' | 'search' | 'market' | 'tags'
export const KNOWLEDGE_VIEWS: readonly KnowledgeView[] = ['read', 'edit', 'graph', 'search', 'tags', 'market']

/** 落盘 view 清洗：合法值透传，非法/缺省 → 'read'（最安全的只读入口） */
export function sanitizeView(view: unknown): KnowledgeView {
  return KNOWLEDGE_VIEWS.includes(view as KnowledgeView) ? (view as KnowledgeView) : 'read'
}

/** 落盘 spaceId 清洗：非空字符串透传，其余（null/数字/空串/对象）→ null（= 未选空间） */
export function sanitizeSpaceId(spaceId: unknown): string | null {
  return typeof spaceId === 'string' && spaceId.trim() ? spaceId : null
}

/** 落盘 docId 清洗：与 spaceId 同规则（非空字符串，其余 → null）；单列一个函数让调用点自解释 */
export function sanitizeDocId(docId: unknown): string | null {
  return sanitizeSpaceId(docId)
}

/**
 * 检索关键词意图清洗：非空字符串数组 → 去空/去重后的数组；其余（null/非数组/空数组/全空白）→ null。
 *
 * 为什么要单列：标签视图点的是"标签"，检索视图吃的是"关键词"，中间必然有一次形态转换。
 * 把「空数组」也归一成 null 是关键——空数组会让检索视图发一次 `q=` 的空查询（白跑一次内核
 * 进程，约 50-70MB RSS），而 null 表示"没有意图"，检索视图保持自己上一条查询不动。
 */
export function sanitizeKeywords(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out = [...new Set(raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
  return out.length ? out : null
}

export interface KnowledgeTreeState {
  entries: KnowledgeTreeEntry[]
  /** 是否已拉取过该层（false 且 expanded → 树组件去 fetch） */
  loaded: boolean
  expanded: boolean
}

export type KnowledgeTreeMap = Record<string, KnowledgeTreeState>

/**
 * 落盘 tree 清洗：只保留「展开」标记，entries/loaded 一律重置。
 * 形态损坏（非纯对象/数组/null/值不是对象）的一律丢弃 → 返回 {}。
 * 不抛任何异常（见文件头注释）。
 */
export function sanitizeTree(raw: unknown): KnowledgeTreeMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: KnowledgeTreeMap = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!path) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if ((value as { expanded?: unknown }).expanded !== true) continue   // 折叠节点无可恢复信息，不占位
    out[path] = { entries: [], loaded: false, expanded: true }
  }
  return out
}

/** 落盘裁剪：只留展开的分支（同类型输出，避免为 persist 引入第二套 tree 类型） */
export function toPersistedTree(tree: KnowledgeTreeMap): KnowledgeTreeMap {
  const out: KnowledgeTreeMap = {}
  for (const [path, node] of Object.entries(tree)) {
    if (node.expanded) out[path] = { entries: [], loaded: false, expanded: true }
  }
  return out
}

/** 落盘 targetLine 清洗：正整数透传，其余（null/0/负数/小数/NaN/字符串）→ null */
export function sanitizeTargetLine(line: unknown): number | null {
  return typeof line === 'number' && Number.isFinite(line) && line >= 1 ? Math.floor(line) : null
}

/**
 * 落盘/写入侧的 blockId 清洗（S5 Task 9）：形状必须是 `<docId>#<n>`（含 '#'、两段都非空），
 * 其余（null/空串/无 '#'/只有 '#'）→ null。**不抛**（同上面几个 sanitize：读侧脏数据不能把界面弄崩）。
 */
export function sanitizeTargetBlockId(blockId: unknown): string | null {
  if (typeof blockId !== 'string') return null
  const s = blockId.trim()
  const i = s.lastIndexOf('#')
  return i > 0 && i < s.length - 1 ? s : null
}

export interface KnowledgeState {
  /** 当前空间 id（null = 尚未选择，面板空态） */
  spaceId: string | null
  /**
   * 当前打开的文档 id（= `${spaceId}/${rel}`，null = 未选文档）。
   * 为什么进 store 而不是面板 state：左栏树、中栏阅读/编辑、右栏元信息、搜索命中列表
   * 四个互不相邻的子树都要读它，props 逐层穿透会在 Task 5-9 变成链式传参；
   * store 里它与 view 同属"当前工作位置"，一并持久化后刷新仍停在同一篇文档。
   */
  docId: string | null
  /**
   * 阅读视图的**行定位目标**（S2 Task 5；null = 不定位）。
   * 为什么也要进 store：写入方（Task 7 检索命中列表、Task 9 大纲）与消费方（阅读视图）不相邻，
   * 且它必须与 docId 一起"原子地"落定——先切 doc 再定位，中途不能有半截状态。
   * **不落盘**（见 partialize）：高亮是一次性跳转意图，重启后回到原地高亮一个旧行号只会让人困惑。
   */
  targetLine: number | null
  /**
   * 关联锚点的**块级定位目标**（S5 Task 9；`<docId>#<n>`，null = 不定位）。
   * 为什么不复用 targetLine：锚点摘要只带 blockId（内核 relSummary 的字段集合被 spec §7.2
   * 钉死，不许为图方便加 line），把它换成行号需要在点击时额外取一次目标文档（= 一次内核进程）；
   * 而阅读视图本来就按块渲染，直接按 blockId 找渲染下标是**零额外请求**的做法。
   * **不落盘**（同 targetLine：一次性跳转意图）。
   */
  targetBlockId: string | null
  /**
   * 内链**锚点定位意图**（2026-09-14 批次 2）：`[[note#小节]]` 点了之后要落到"那一节"，
   * 而不是文档开头。字段是锚点原文 + 类型（`heading` / `block`），由阅读视图用
   * `resolveAnchorIndex` 换成渲染下标 —— 与 targetBlockId 同一思路（**零额外内核请求**：
   * 阅读视图按块渲染，块文本里就有标题/块 ID，不需要查库）。
   *
   * 为什么不复用 targetBlockId：锚点原文要**先解析**才知道是哪一块（`## 安装步骤` 可能
   * 存在也可能写错），而 targetBlockId 是已解析好的确定值。硬塞进去就需要在点击时先取一次
   * 目标文档来解析 —— 那正是本字段要避免的一次内核进程。
   *
   * **不落盘**（同 targetLine/targetBlockId）：一次性跳转意图。
   */
  targetAnchor: { anchorRef: string; anchorKind: 'heading' | 'block' | '' } | null
  /**
   * 检索视图的**一次性关键词意图**（2026-09-14 批次 1：标签视图点击标签 → 跳到检索并塞入 `#tag`）。
   *
   * 为什么不能直接写进检索视图自己的 state：写入方（标签视图 / 元信息面板）与消费方（检索视图）
   * 是**兄弟子树**，视图又是条件渲染（切换时旧视图整棵卸载），props 传不进去、state 也活不过切换。
   * **不落盘**（同 targetLine / targetBlockId）：一次性跳转意图，重启后自动发起一次用户没要求的
   * 检索只会让人困惑。
   */
  searchKeywords: string[] | null
  view: KnowledgeView
  /** 扁平 map：路径 → { entries, loaded, expanded } */
  tree: KnowledgeTreeMap
  setSpace: (spaceId: string | null) => void
  setDocId: (docId: string | null) => void
  setTargetLine: (line: number | null) => void
  setTargetBlockId: (blockId: string | null) => void
  setTargetAnchor: (anchor: { anchorRef: string; anchorKind: 'heading' | 'block' | '' } | null) => void
  /** 标签点击的唯一入口：切检索视图 + 塞关键词（一次写完，避免"切了视图还没关键词"的空跑一帧） */
  openSearchWithKeywords: (keywords: string[]) => void
  /** 检索视图消费完一次性意图后必须清空，否则返回检索视图会再次被顶入同一关键词 */
  clearSearchKeywords: () => void
  /** 关联锚点跳转的唯一入口：打开文档 + 切阅读视图 + 置块级定位（一次写完，无中间态） */
  openAtBlock: (docId: string, blockId: string) => void
  /**
   * 内链锚点跳转的唯一入口（2026-09-14 批次 2）：打开目标文档 + 切阅读视图 + 置锚点定位。
   * 与 openAtBlock 同样**一次 set 写完**：分次写会出现"已换文档、定位目标还是上一篇的"中间帧，
   * 那一帧里阅读视图的 effect 会拿着旧锚点去匹配新文档。
   */
  openAtAnchor: (docId: string, anchorRef: string, anchorKind: 'heading' | 'block' | '') => void
  setView: (view: KnowledgeView) => void
  toggleExpanded: (path: string) => void
  setTreeEntries: (path: string, entries: KnowledgeTreeEntry[]) => void
}

export const useKnowledgeStore = create<KnowledgeState>()(
  persist((set, get) => ({
    spaceId: null,
    docId: null,
    targetLine: null,
    targetBlockId: null,
    targetAnchor: null,
    searchKeywords: null,
    view: 'read',
    tree: {},

    // 切空间**必须清树 + 清 docId**：tree 的键是「空间内相对路径」，跨空间复用会把 A 空间的目录列表
    // （含 docId）挂到 B 空间的同路径节点上，点开就是另一个空间的文档。docId 同理——它编码了
    // spaceId 前缀，不清就会出现"当前打开的是 A 空间的文档，左栏却显示 B 空间"的错配。
    // 同值切换 no-op（不换引用）。
    setSpace: (spaceId) => {
      const next = sanitizeSpaceId(spaceId)
      if (next === get().spaceId) return
      set({ spaceId: next, docId: null, targetLine: null, targetBlockId: null, targetAnchor: null, tree: {} })
    },

    // 换文档顺带清 targetLine：行号只在**同一篇文档**内有意义，留着它会让新文档里一行无关内容被点亮。
    // 需要"打开并定位"的调用方请按 setDocId() → setTargetLine() 的顺序调用（Task 7 检索命中）。
    setDocId: (docId) => {
      const next = sanitizeDocId(docId)
      if (next === get().docId) return
      // 块级定位目标（targetBlockId）同理必须一起清：它的 `<docId>#<n>` 里编码了**上一篇**文档，
      // 留着它会让新文档的渲染层去匹配一个不存在的块（最坏是没有任何高亮，看起来像点了没反应）。
      set({ docId: next, targetLine: null, targetBlockId: null, targetAnchor: null })
    },

    setTargetLine: (line) => {
      const next = sanitizeTargetLine(line)
      if (next === get().targetLine) return
      set({ targetLine: next })
    },

    setTargetBlockId: (blockId) => {
      const next = sanitizeTargetBlockId(blockId)
      if (next === get().targetBlockId) return
      set({ targetBlockId: next })
    },

    // 锚点定位（2026-09-14 批次 2）。清洗口径：`anchorRef` 去空白后为空 → null（="无意图"，
    // 而不是"定位到空标题"）；`anchorKind` 非 heading/block 一律回落 ''（由消费侧按 heading 处理）。
    setTargetAnchor: (anchor) => {
      const ref = String(anchor?.anchorRef ?? '').trim()
      const next = ref
        ? { anchorRef: ref, anchorKind: (anchor?.anchorKind === 'block' ? 'block' : anchor?.anchorKind === 'heading' ? 'heading' : '') as 'heading' | 'block' | '' }
        : null
      const cur = get().targetAnchor
      if (cur === next || (cur && next && cur.anchorRef === next.anchorRef && cur.anchorKind === next.anchorKind)) return
      set({ targetAnchor: next })
    },

    openAtAnchor: (docId, anchorRef, anchorKind) => {
      const id = sanitizeDocId(docId)
      const ref = String(anchorRef ?? '').trim()
      if (!id || !ref) return
      set({
        docId: id, view: 'read', targetLine: null, targetBlockId: null,
        targetAnchor: { anchorRef: ref, anchorKind: anchorKind === 'block' ? 'block' : anchorKind === 'heading' ? 'heading' : '' },
      })
    },

    // 关联锚点点击（条目卡片 / Inspector 关联段 / 图谱节点悬停）：
    // ① 必须切到 'read'——在 graph/search 视图下只换 docId，用户看到的还是原视图（"点了没反应"）；
    // ② 必须清 targetLine——上一次检索命中的行号与新锚点无关，留着会点亮无关行；
    // ③ 一次 set 写完（三次写会经过"已换文档、定位目标还是旧的"的中间态，那一帧里阅读视图的
    //    effect 可能拿着旧 targetBlockId 去匹配新文档的块）。
    openAtBlock: (docId, blockId) => {
      const id = sanitizeDocId(docId)
      const bid = sanitizeTargetBlockId(blockId)
      if (!id || !bid) return
      set({ docId: id, view: 'read', targetLine: null, targetBlockId: bid, targetAnchor: null })
    },

    setView: (view) => {
      const next = sanitizeView(view)
      if (next === get().view) return
      set({ view: next })
    },

    // 标签 → 检索的唯一入口。一次 set 写完 view 与关键词：分两次写会让检索视图先挂载一次
    // （空关键词 → 拉一次空结果），用户看到一下闪动。
    // 关键词清洗交给 sanitizeKeywords（空数组 → null = "无意图"，而不是"搜空串"）。
    openSearchWithKeywords: (keywords) => {
      const next = sanitizeKeywords(keywords)
      if (!next) return
      set({ view: 'search', searchKeywords: next })
    },

    clearSearchKeywords: () => {
      if (get().searchKeywords === null) return
      set({ searchKeywords: null })
    },

    // 对不存在的路径**创建**节点（expanded: true）：冷启动时 merge 恢复的展开态正是
    // "有 expanded、无 entries" 的形状，二者语义统一——树组件只需判断 `expanded && !loaded` 去拉取。
    toggleExpanded: (path) => {
      if (!path) return
      set((s) => {
        const node = s.tree[path]
        const next: KnowledgeTreeState = node
          ? { entries: node.entries, loaded: node.loaded, expanded: !node.expanded }
          : { entries: [], loaded: false, expanded: true }
        return { tree: { ...s.tree, [path]: next } }
      })
    },

    // 拉取落定：写入 entries 并置 loaded。已存在节点**保留其展开态**——请求在途时用户可能
    // 已折叠，不该被响应"顶开"。
    setTreeEntries: (path, entries) => {
      if (!path) return
      set((s) => {
        const node = s.tree[path]
        const next: KnowledgeTreeState = {
          entries: Array.isArray(entries) ? entries : [],
          loaded: true,
          expanded: node ? node.expanded : true,
        }
        return { tree: { ...s.tree, [path]: next } }
      })
    },
  }), {
    name: 'yfworking-knowledge',
    partialize: (s) => ({ spaceId: s.spaceId, docId: s.docId, view: s.view, tree: toPersistedTree(s.tree) }),
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as { spaceId?: unknown; docId?: unknown; view?: unknown; tree?: unknown }
      return {
        ...current,
        spaceId: sanitizeSpaceId(p.spaceId),
        docId: sanitizeDocId(p.docId),
        view: sanitizeView(p.view),
        tree: sanitizeTree(p.tree),
      }
    },
  }),
)
