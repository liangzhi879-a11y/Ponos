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

/** 四视图（阅读/编辑/图谱/搜索）；'edit' 在只读空间由视图层拒绝进入，store 不做权限判断 */
export type KnowledgeView = 'read' | 'edit' | 'graph' | 'search'
export const KNOWLEDGE_VIEWS: readonly KnowledgeView[] = ['read', 'edit', 'graph', 'search']

/** 落盘 view 清洗：4 合法值透传，非法/缺省 → 'read'（最安全的只读入口） */
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
  view: KnowledgeView
  /** 扁平 map：路径 → { entries, loaded, expanded } */
  tree: KnowledgeTreeMap
  setSpace: (spaceId: string | null) => void
  setDocId: (docId: string | null) => void
  setTargetLine: (line: number | null) => void
  setView: (view: KnowledgeView) => void
  toggleExpanded: (path: string) => void
  setTreeEntries: (path: string, entries: KnowledgeTreeEntry[]) => void
}

export const useKnowledgeStore = create<KnowledgeState>()(
  persist((set, get) => ({
    spaceId: null,
    docId: null,
    targetLine: null,
    view: 'read',
    tree: {},

    // 切空间**必须清树 + 清 docId**：tree 的键是「空间内相对路径」，跨空间复用会把 A 空间的目录列表
    // （含 docId）挂到 B 空间的同路径节点上，点开就是另一个空间的文档。docId 同理——它编码了
    // spaceId 前缀，不清就会出现"当前打开的是 A 空间的文档，左栏却显示 B 空间"的错配。
    // 同值切换 no-op（不换引用）。
    setSpace: (spaceId) => {
      const next = sanitizeSpaceId(spaceId)
      if (next === get().spaceId) return
      set({ spaceId: next, docId: null, targetLine: null, tree: {} })
    },

    // 换文档顺带清 targetLine：行号只在**同一篇文档**内有意义，留着它会让新文档里一行无关内容被点亮。
    // 需要"打开并定位"的调用方请按 setDocId() → setTargetLine() 的顺序调用（Task 7 检索命中）。
    setDocId: (docId) => {
      const next = sanitizeDocId(docId)
      if (next === get().docId) return
      set({ docId: next, targetLine: null })
    },

    setTargetLine: (line) => {
      const next = sanitizeTargetLine(line)
      if (next === get().targetLine) return
      set({ targetLine: next })
    },

    setView: (view) => {
      const next = sanitizeView(view)
      if (next === get().view) return
      set({ view: next })
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
