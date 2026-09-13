// src/hooks/useKnowledge.ts —— 知识库数据层 hook（手写缓存 + 失效 + 加载/错误态）
//
// 仓库**没有**数据请求库（无 react-query / SWR，spec §11.3），故手写：
//   · 模块级 `Map<key, entry>` 缓存：面板内切视图 / 切文档 / 组件重挂不重复拉取；
//   · 同 key 的并发请求去重在 **knowledgeApi**（inflight）里做，这一层只管缓存与订阅，
//     避免两处都做去重导致"谁先到谁写"的二次竞态；
//   · 订阅式重渲染：每个 key 一个 listener 集合，数据落定只唤醒订阅该 key 的组件
//     （照仓库纪律：不整店订阅，别让一次搜索把整个知识面板重建）；
//   · **卸载即退订**：effect cleanup 摘掉 listener，在途响应落定时不会再 setState
//     （相当于 mounted 标记；API 层另有 AbortController 超时兜底）。
//
// 写路径：`saveDoc()` 成功**必须**失效 doc / tree / 全部 search ——
// 后端保存即增量索引，不失效就会出现"刚保存却搜不到"（S2 验收第 6 项）。
import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  getDoc, getGraph, getLinks, getStats, listEntries, listSpaces, listTree, search, writeDoc,
  type ApiResult, type KnowledgeCallOpts, type KnowledgeDoc, type KnowledgeEntry,
  type KnowledgeGraph, type KnowledgeLinks, type KnowledgeSearchParams, type KnowledgeSearchResult,
  type KnowledgeSpace, type KnowledgeStats, type KnowledgeTreeEntry, type KnowledgeWriteInput,
} from '@/lib/knowledgeApi'

/** 缓存键（跨组件共享的稳定标识；失效用前缀匹配，见 invalidateKnowledge） */
const csv = (xs?: string[]) => (xs || []).map(x => String(x).trim()).filter(Boolean).join(',')

export const knowledgeKeys = {
  spaces: 'spaces',
  /** 注意分隔符 `|`：失效前缀用 `tree:<space>|`，避免 `notes` 误伤 `notes-archive` */
  tree: (space: string, path = '') => `tree:${space}|${path}`,
  doc: (id: string) => `doc:${id}`,
  entries: (id: string) => `entries:${id}`,
  search: (p: KnowledgeSearchParams) => `search:${[p.q, csv(p.keywords), p.topK ?? '', p.mode ?? '', csv(p.spaces)].join('|')}`,
  graph: (space: string | null, limit?: number) => `graph:${space ?? '*'}|${limit ?? ''}`,
  /** 出边 + 反链（右栏 Inspector，Task 9）；键按文档 id，故前缀失效用 `links:` */
  links: (id: string) => `links:${id}`,
  stats: 'stats',
}

interface Resource { data?: unknown; loading: boolean; error?: string }
interface Entry {
  res: Resource
  listeners: Set<() => void>
  /** 已发起过拉取（含在途）；refresh / 失效时置回 false */
  started: boolean
  /** 最近一次订阅者提供的 loader（失效后需要用它重取） */
  load?: () => Promise<ApiResult<unknown>>
}

const cache = new Map<string, Entry>()

function ensure(key: string): Entry {
  let e = cache.get(key)
  if (!e) { e = { res: { loading: false }, listeners: new Set(), started: false }; cache.set(key, e) }
  return e
}

function commit(key: string, res: Resource): void {
  const e = ensure(key)
  e.res = res
  for (const fn of e.listeners) fn()
}

async function fetchEntry(key: string, load: () => Promise<ApiResult<unknown>>, force = false): Promise<void> {
  const e = ensure(key)
  e.load = load
  if (e.res.loading) return                       // 在途（含 API 层去重复用）→ 不叠加第二次请求
  if (e.started && !force) return                 // 已有缓存 → 重挂/切回直接用
  e.started = true
  // 重取时保留旧 data（刷新不该把内容清空成骨架屏）
  commit(key, { ...e.res, loading: true, error: undefined })
  const r = await load()
  commit(key, r.ok ? { data: r.data, loading: false } : { data: undefined, loading: false, error: r.error })
}

/**
 * 失效：命中前缀的键在下一次订阅/refresh 时重取。
 * · 有订阅者（面板正显示）→ 立刻重取并推送新数据（写后立即可见）；
 * · 无订阅者 → 直接丢弃缓存（下次进入是新数据，不占内存）。
 */
export function invalidateKnowledge(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (!key.startsWith(prefix)) continue
    const e = cache.get(key)!
    if (!e.listeners.size || !e.load) { cache.delete(key); continue }
    e.started = false
    void fetchEntry(key, e.load, true)
  }
}

/** 仅供测试/登出清场：整表丢弃（不影响 API 层在途去重表） */
export function clearKnowledgeCache(): void { cache.clear() }

export interface KnowledgeResource<T> {
  data: T | undefined
  loading: boolean
  error: string | undefined
  /** 手动重取（保留旧数据直到新数据到达） */
  refresh: () => void
}

function useResource<T>(key: string | null, load: () => Promise<ApiResult<T>>): KnowledgeResource<T> {
  const [, force] = useReducer((n: number) => n + 1, 0)
  const loadRef = useRef(load)
  loadRef.current = load                            // 每次渲染刷新：refresh 永远用最新参数

  useEffect(() => {
    if (!key) return
    const e = ensure(key)
    const listener = () => force()
    e.listeners.add(listener)
    void fetchEntry(key, () => loadRef.current())   // 未拉过才真发请求（缓存命中则同步返回）
    return () => { e.listeners.delete(listener) }   // 卸载即退订：在途响应不再 setState
  }, [key])

  const refresh = useCallback(() => {
    if (!key) return
    void fetchEntry(key, () => loadRef.current(), true)
  }, [key])

  const res = key ? cache.get(key)?.res : undefined
  return {
    data: res?.data as T | undefined,
    loading: res?.loading ?? false,
    error: res?.error,
    refresh,
  }
}

// —— 读端点 ——

export function useSpaces(): KnowledgeResource<KnowledgeSpace[]> {
  return useResource<KnowledgeSpace[]>(knowledgeKeys.spaces, async () => {
    const r = await listSpaces()
    return r.ok ? { ok: true, data: r.data.spaces ?? [] } : r
  })
}

/** 单层懒加载：`space` 为空（未选空间）时不发请求 */
export function useTree(space: string | null, path = ''): KnowledgeResource<KnowledgeTreeEntry[]> {
  const key = space ? knowledgeKeys.tree(space, path) : null
  return useResource<KnowledgeTreeEntry[]>(key, async () => {
    if (!space) return { ok: false, error: 'no space' }
    return listTree(space, path || undefined)
  })
}

export function useDoc(id: string | null): KnowledgeResource<KnowledgeDoc> {
  const key = id ? knowledgeKeys.doc(id) : null
  return useResource<KnowledgeDoc>(key, async () => {
    if (!id) return { ok: false, error: 'no doc' }
    return getDoc(id)
  })
}

export function useListEntries(id: string | null): KnowledgeResource<KnowledgeEntry[]> {
  const key = id ? knowledgeKeys.entries(id) : null
  return useResource<KnowledgeEntry[]>(key, async () => {
    if (!id) return { ok: false, error: 'no doc' }
    return listEntries(id)
  })
}

/** `q` 为空 → 不发请求（空查询在后端等于"无匹配"，前端不该打这一枪） */
export function useSearch(params: KnowledgeSearchParams): KnowledgeResource<KnowledgeSearchResult> {
  const key = params.q.trim() ? knowledgeKeys.search(params) : null
  return useResource<KnowledgeSearchResult>(key, () => search(params))
}

export function useGraph(space: string | null = null, limit?: number): KnowledgeResource<KnowledgeGraph> {
  const key = knowledgeKeys.graph(space, limit)
  return useResource<KnowledgeGraph>(key, () => getGraph(space ?? undefined, limit))
}

/** 出边 + 反链（右栏 Inspector 用 `in`：谁引用了我）；未选中文档时不发请求 */
export function useLinks(id: string | null): KnowledgeResource<KnowledgeLinks> {
  const key = id ? knowledgeKeys.links(id) : null
  return useResource<KnowledgeLinks>(key, async () => {
    if (!id) return { ok: false, error: 'no doc' }
    return getLinks(id)
  })
}

export function useStats(): KnowledgeResource<KnowledgeStats> {
  const key = knowledgeKeys.stats
  return useResource<KnowledgeStats>(key, () => getStats())
}

// —— 写端点 ——

/**
 * 保存/新建文档 + **缓存失效**（唯一写入口，调用方不要直接调 api.writeDoc，
 * 否则"刚保存搜不到"会在编辑视图里复现）。
 * 失效范围：该 doc（内容变了）、所在 tree 前缀（新建会多节点）、全部 search（增量索引已生效）、
 * 全部 links（正文里的相对链接变了 → 出边/反链两边都要重取，Task 9 右栏消费）、
 * stats（indexAge/indexBytes 变了）。
 */
export async function saveDoc(
  input: KnowledgeWriteInput,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<{ docId: string; updated: boolean }>> {
  const r = await writeDoc(input, opts)
  if (!r.ok) return r
  const docId = r.data.docId || `${input.space}/${input.path}`
  invalidateKnowledge(knowledgeKeys.doc(docId))
  invalidateKnowledge(knowledgeKeys.doc(`${input.space}/${input.path}`))
  invalidateKnowledge(`tree:${input.space}|`)
  invalidateKnowledge('search:')
  invalidateKnowledge('links:')
  invalidateKnowledge(knowledgeKeys.stats)
  return r
}
