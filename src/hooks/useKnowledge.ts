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
// 文件导入（T6，`importDocuments()`）同理且**更严重**：它一次往目标空间里新增几十篇文档，
// 不失效 tree 就是"导进去了但树里看不见"，用户会以为失败再导一遍。
import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  getBrokenLinks, getDoc, getEntryGraph, getGraph, getGraphRelated, getImportJob, getLinks, getMentions, getRelatedDoc, getStats, importKnowledge,
  listEntries, listSpaces, listTree, search, startImportJob, writeDoc,
  // 索引标签枚举（2026-09-14 批次 1）：标签视图的数据源。注意它与下面的 `/knowledge/tags`
  // （S6 经验库条目级，本模块未包装）不是一回事。
  listIndexTags,
  // 删除管理（2026-09-14）：API 层函数一律 `api*` 前缀 —— 本模块导出的 `deleteDoc` /
  // `deleteSpace` / `restoreTrash` / `purgeTrash` 是**带缓存失效的包装**，两者同名会
  // 静默地让某一处调用打到"无失效"的裸 API（表现 = 删了但界面还在）。
  listTrash,
  deleteDoc as apiDeleteDoc, deleteSpace as apiDeleteSpace,
  restoreTrash as apiRestoreTrash, purgeTrash as apiPurgeTrash,
  type ApiResult, type KnowledgeCallOpts, type KnowledgeDeleteResult, type KnowledgeDoc, type KnowledgeEntry,
  type KnowledgeGraph, type KnowledgeGraphRelatedEdge, type KnowledgeImportPayload,
  type KnowledgeImportReport, type KnowledgeLinks, type KnowledgeTrashList,
  type KnowledgeIndexTags, type KnowledgeMentions, type KnowledgeBrokenLink,
  type KnowledgeRelatedBlock, type KnowledgeSearchParams, type KnowledgeSearchResult,
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
  /**
   * 文档级图谱。`around`/`hops` 是**局部图**参数（批次 2）：只有它们也进键，
   * "同一空间 + 不同中心/深度"才不会共用同一份缓存。
   * 前缀 `graph:` 与 `graphEntry:` 严格分开（否则两个层级的图互相串缓存，见下一条）。
   */
  graph: (space: string | null, limit?: number, around?: string | null, hops?: number | null) =>
    `graph:${space ?? '*'}|${limit ?? ''}|${around ?? ''}|${hops ?? ''}`,
  /** 条目级图谱（S5.1 层级开关）。键前缀独立，否则与文档级图互相串缓存 */
  graphEntry: (space: string | null, limit?: number) => `graphEntry:${space ?? '*'}|${limit ?? ''}`,
  /** 出边 + 反链（右栏 Inspector，Task 9）；键按文档 id，故前缀失效用 `links:` */
  links: (id: string) => `links:${id}`,
  /** 整篇文档的关联锚点（S5 Task 9：条目卡片关联行 / Inspector 关联段） */
  relatedDoc: (id: string) => `relatedDoc:${id}`,
  /** 图谱的隐式关联层（S5 Task 9：图层开关打开时才请求）；分隔符 `|` 同 graph 键 */
  graphRelated: (space: string | null, limit?: number) => `graphRelated:${space ?? '*'}|${limit ?? ''}`,
  stats: 'stats',
  /**
   * 索引标签枚举（2026-09-14 批次 1）。键里编码空间白名单：`*` = 全部空间。
   * 为什么编码而不是"只用一个 key 再前端过滤"：标签计数**必须**由内核按空间算
   * （前端只有当前空间的数据，跨空间同名标签的计数它算不出来），所以不同白名单是不同查询。
   */
  indexTags: (spaces?: string[]) => `indexTags:${csv(spaces) || '*'}`,
  /** 未链接提及（批次 2）：按文档 + limit（内核是"扫到就停"，limit 参与缓存键） */
  mentions: (docId: string, limit: number) => `mentions:${docId}:${limit}`,
  /** 断链清单（批次 2）：按空间（null = 全部空间） */
  brokenLinks: (space: string | null, limit: number) => `brokenLinks:${space ?? '*'}:${limit}`,
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

export function useGraph(
  space: string | null = null,
  limit?: number,
  local?: { around: string; hops: number } | null,
): KnowledgeResource<KnowledgeGraph> {
  // 局部图（2026-09-14 批次 2）：`around`/`hops` 进缓存键 —— 不同中心/深度是**不同查询**，
  // 不区分会让"切了中心却看到上一个中心的图"（缓存命中返回旧数据，看起来像没生效）。
  const key = knowledgeKeys.graph(space, limit, local?.around ?? null, local?.hops ?? null)
  return useResource<KnowledgeGraph>(
    key,
    () => getGraph(space ?? undefined, limit, local ? { around: local.around, hops: local.hops } : undefined),
  )
}

/**
 * 条目级图谱（S5.1 层级开关）：`enabled=false` → 键为 null → **不发请求**。
 * 照 `useGraphRelated` 的范式：层级是二选一的，两个层级的图同时拉等于白花一半流量。
 */
export function useEntryGraph(
  space: string | null = null, limit?: number, enabled = true,
): KnowledgeResource<KnowledgeGraph> {
  const key = enabled ? knowledgeKeys.graphEntry(space, limit) : null
  return useResource<KnowledgeGraph>(key, () => getEntryGraph(space ?? undefined, limit))
}

/** 出边 + 反链（右栏 Inspector 用 `in`：谁引用了我）；未选中文档时不发请求 */
export function useLinks(id: string | null): KnowledgeResource<KnowledgeLinks> {
  const key = id ? knowledgeKeys.links(id) : null
  return useResource<KnowledgeLinks>(key, async () => {
    if (!id) return { ok: false, error: 'no doc' }
    return getLinks(id)
  })
}

/**
 * 整篇文档的关联锚点（S5 Task 9）。**按文档一次拉完**，绝不按块循环：
 * 每次 HTTP 调用在 bridge 侧 = 一次新内核进程（约 50–70MB RSS），一篇文档几十条条目
 * 就是几十次 spawn —— 卡片关联行是默认可见的，这个代价不能接受（见内核 getRelatedForDoc）。
 */
export function useRelatedDoc(id: string | null): KnowledgeResource<KnowledgeRelatedBlock[]> {
  const key = id ? knowledgeKeys.relatedDoc(id) : null
  return useResource<KnowledgeRelatedBlock[]>(key, async () => {
    if (!id) return { ok: false, error: 'no doc' }
    return getRelatedDoc(id)
  })
}

/**
 * 图谱的隐式关联层。`enabled=false`（**默认**）时 key 为 null ⇒ 一个请求都不发：
 * 图层关着时既不该有网络/进程开销，也不该让"关着的开关"看起来在工作（spec §7.5）。
 */
export function useGraphRelated(space: string | null, limit?: number, enabled = false): KnowledgeResource<KnowledgeGraphRelatedEdge[]> {
  const key = enabled ? knowledgeKeys.graphRelated(space, limit) : null
  return useResource<KnowledgeGraphRelatedEdge[]>(key, () => getGraphRelated(space ?? undefined, limit))
}

/**
 * 未链接提及（2026-09-14 批次 2）：全库里"提到这篇文档但没打链接"的位置。
 * `limit` 进缓存键：内核是**扫到就停**的护栏（不是扫完再截断），故不同 limit 是不同查询。
 */
export function useMentions(docId: string | null, limit = 20): KnowledgeResource<KnowledgeMentions> {
  const key = docId ? knowledgeKeys.mentions(docId, limit) : null
  return useResource<KnowledgeMentions>(key, () => getMentions(docId as string, limit))
}

/**
 * 断链清单（2026-09-14 批次 2）。**全局口**（`space` 为 null = 全部空间）：
 * 断链是"待办"，用户关心的是"我的库里有多少坏链接"，而不是"当前空间里有多少"。
 */
export function useBrokenLinks(space?: string | null, limit = 200): KnowledgeResource<{ items: KnowledgeBrokenLink[]; total: number; broken: number }> {
  return useResource(knowledgeKeys.brokenLinks(space ?? null, limit), () => getBrokenLinks(space ?? null, limit))
}

export function useStats(): KnowledgeResource<KnowledgeStats> {
  const key = knowledgeKeys.stats
  return useResource<KnowledgeStats>(key, () => getStats())
}

/**
 * 标签视图数据源（2026-09-14 批次 1）。`spaces` 省略 = 全库（含只读知识包）。
 *
 * 为什么不用 `useResource` 的 null-key 短路（像 useTree 那样"没选空间就不请求"）：
 * 标签视图的价值恰在**跨空间**的全局标签视角（Obsidian 的 Tag view 也是全 vault），
 * 只统计当前空间会把"这个标签在别的空间里被用了 20 次"藏起来，用户就误判标签是孤立的。
 * 收窄是**可选**能力（传 spaces），不是默认行为。
 */
export function useIndexTags(spaces?: string[]): KnowledgeResource<KnowledgeIndexTags> {
  const list = spaces && spaces.length ? spaces : undefined
  return useResource<KnowledgeIndexTags>(knowledgeKeys.indexTags(list), () => listIndexTags(list))
}

// —— 写端点 ——

/**
 * 保存/新建文档 + **缓存失效**（唯一写入口，调用方不要直接调 api.writeDoc，
 * 否则"刚保存搜不到"会在编辑视图里复现）。
 * 失效范围：该 doc（内容变了）、所在 tree 前缀（新建会多节点）、全部 search（增量索引已生效）、
 * 全部 links（正文里的相对链接变了 → 出边/反链两边都要重取，Task 9 右栏消费）、
 * 全部 relatedDoc/graphRelated（S5 Task 9：保存后内容指纹变了，内容层锚点在**读时**会被
 * 内核校验剔除；前端缓存若不同步失效，界面会抱着已消失的锚点继续显示）、
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
  invalidateKnowledge('relatedDoc:')
  invalidateKnowledge('graphRelated:')
  invalidateKnowledge(knowledgeKeys.stats)
  // 文档内容变了 → 它带的标签可能增删（正文内联 `#tag` 也算，2026-09-14 批次 1），
  // 标签视图的计数必须跟着变。前缀失效（`indexTags:`）是必要的：标签视图可能同时挂着
  // 「全库」与「当前空间」两个白名单的缓存，只失效其中一个会让两个视图的计数对不上。
  invalidateKnowledge('indexTags:')
  // 正文里的 `[[链接]]` 变了 → **引用派生视图**也必须失效（2026-09-14 批次 4 补）。
  // 批次 2 新增了两个派生通道却没回头补失效清单：mentions（未链接提及）与 brokenLinks（断链）。
  // 症状很隐蔽 —— 保存完切到右栏，看到的还是保存前那份"提到但没连"的清单，
  // 用户会以为链接没生效（实际上索引已经更新，只是前端抱着旧缓存）。
  // 教训：**凡是新增派生视图，就必须回头把写路径的失效清单补齐**；否则就是一个只在
  // "新增视图 + 旧的写入口"交叉处才出现的静默不一致。
  invalidateKnowledge('mentions:')
  invalidateKnowledge('brokenLinks:')
  return r
}

// —— 文件导入（T6，2026-09-14）——

/**
 * 把一批文件/目录导入知识空间（PDF/Word/Excel/PPT/图片 → 可检索 Markdown）。
 *
 * **为什么收在这一层**：导入是写路径，"后端已落盘 + 前端必须失效缓存"的纪律与 `saveDoc()`
 * 完全一致，而且后果更外显 —— 导入一次新增几十篇文档，不失效 `tree:<目标空间>|` 就是
 * "明明导入成功，树里却看不到"（用户会以为失败，再导一遍）；不失效 `search:` 就是
 * "刚导入就搜不到"（命中结果的缓存里当然没有新文档）。P1-1 的"立刻能读到、搜到"
 * 靠的不是调用方自觉，而是这里一次写清。组件各记各的失效 = 两处调用必漂移一处。
 *
 * **为什么不在 API 层 dedupe**：导入耗时可到分钟级，且有副作用（写盘）；同 key 合并会掩盖
 * "用户换了目标空间后重试"这类真实意图变化（详见 knowledgeApi.importKnowledge 的 why）。
 *
 * 返回**原样透出** `ApiResult`（含 `status`）：UI 要按 403（只读空间）/ 413（超批上限）
 * 给不同提示 —— 这两类都是"改一下选择就能解决"，压成一个通用错误对用户没有帮助。
 *
 * 预览（dryRun）**不失效任何缓存**：它一个字节都没写，失效只会让预览这个高频动作
 * 白白触发一轮 tree/search 重取。
 */
export async function importDocuments(
  payload: KnowledgeImportPayload,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeImportReport>> {
  const r = await importKnowledge(payload, opts)
  if (!r.ok) return r
  invalidateAfterImport(r.data)
  return r
}

/** 导入落定后的缓存失效（同步与异步两条路径共用，避免各写一份必然漂移） */
function invalidateAfterImport(data: KnowledgeImportReport): void {
  // 全跳过（内容未变）+ 空间非新建 = 库内什么都没变，不必惊动缓存
  const changed = data.spaceCreated || data.counts.converted > 0
  if (data.dryRun || !changed) return
  // 目标空间 id **取后端回执**而不是入参：新建空间时前端只知道 `name`，最终 id 是内核定的
  const space = data.spaceId
  invalidateKnowledge(knowledgeKeys.spaces)   // 新空间 / docCount 变了
  invalidateKnowledge(`tree:${space}|`)       // 新增的一批 .md 必须立刻出现在树里
  invalidateKnowledge('search:')              // 否则"刚导入就搜不到"
  invalidateKnowledge('graph:')               // 图谱多了一批节点
  invalidateKnowledge('graphEntry:')
  invalidateKnowledge('graphRelated:')
  invalidateKnowledge(knowledgeKeys.stats)
  // 导入会一次带进大量标签（尤其从 Obsidian vault 导入，2026-09-14 批次 1）→ 标签视图重取
  invalidateKnowledge('indexTags:')
  // 同理：导入带进的是**整批文档的引用关系**（批次 2 的未链接提及/断链、批次 4 补失效）。
  // 从 vault 导入时这一点尤其明显：几百篇文档之间的链接一次性出现，"提到但没连"的清单会大改。
  invalidateKnowledge('mentions:')
  invalidateKnowledge('brokenLinks:')
}

/** 轮询间隔（毫秒）。500ms 对"几千文件跑几分钟"的任务足够跟手，又不至于把桥刷爆。 */
const IMPORT_POLL_MS = 500
/** 轮询连续失败多少次后放弃（每次失败会先重试，见下）。约 5s 的容错窗口。 */
const IMPORT_POLL_MAX_ERRORS = 10

export interface ImportTrackedOpts extends KnowledgeCallOpts {
  /** 每次轮询拿到新状态时回调（用于驱动进度条）。首个回调通常是 total=0 的统计态。 */
  onProgress?: (job: KnowledgeImportJobSnapshot) => void
  /** 取消信号：组件卸载/关闭对话框时置 aborted，轮询立即停止（**不**中止服务端任务） */
  signal?: { aborted: boolean }
}

/** 进度快照：只暴露 UI 需要的部分，避免组件依赖整份 job（含 report）反复重建 */
export interface KnowledgeImportJobSnapshot {
  status: 'running' | 'done' | 'error'
  done: number
  total: number
  percent: number
  current?: string
}

/**
 * 批量导入（异步 + 进度）—— 2026-09-14。需求："支持大批量文件压力、上传时显示进度条
 * （先查文件数，然后根据实时处理的文件数量算进度）"。
 *
 * 与 `importDocuments` 的分工：那个是"提交并等结果"的同步语义，适合小批量/预览；
 * 这个是"提交 → 轮询 → 收结果"。**两条路径的返回类型完全相同**，缓存失效也共用
 * `invalidateAfterImport`，所以调用方切换过去不改变任何下游行为。
 *
 * 三个刻意的设计：
 * 1. `onProgress` 在**统计阶段**（total=0）也会被调一次 —— 组件据此知道"已经提交、正在统计"，
 *    可以显示不确定态而不是假装 0%。这是需求里"先查文件数"的前半句。
 * 2. 轮询失败**不立即放弃**：网络抖动/桥重启都可能在几分钟的导入里出现；容忍
 *    `IMPORT_POLL_MAX_ERRORS` 次连续失败，期间继续按上一次状态显示（不倒退、不清零）。
 *    超过才报错 —— 绝不让进度条无声地卡在某个百分比上（那是最难排查的形态）。
 * 3. `signal.aborted` 只停**轮询**，不取消服务端任务：导入已经落盘了一部分，
 *    强行中止会留下半批结果且用户无从知晓。组件卸载 ≠ 用户想放弃导入。
 */
export async function importDocumentsTracked(
  payload: KnowledgeImportPayload,
  opts: ImportTrackedOpts = {},
): Promise<ApiResult<KnowledgeImportReport>> {
  const { onProgress, signal, ...callOpts } = opts
  const started = await startImportJob(payload, callOpts)
  if (!started.ok) return started
  const jobId = started.data?.jobId
  if (!jobId) {
    // 服务端契约保证 202 必带 jobId；缺失说明桥版本不匹配（比"静默当成功"好得多）
    return { ok: false, error: 'import: 服务端未返回 jobId（异步导入需要新版本桥）' }
  }
  // 立即上报一次"统计中"，让组件在首个响应回来前就进入进度态
  onProgress?.({ status: 'running', done: 0, total: 0, percent: 0 })

  let errors = 0
  for (;;) {
    if (signal?.aborted) {
      // 调用方不再关心结果；**任务仍在服务端继续**（见设计取舍 3）。
      // 用专门的消息让调用方区分"我不看了"与"失败了"。
      return { ok: false, error: 'import: 已停止跟踪（导入仍在后台继续）' }
    }
    const r = await getImportJob(jobId, callOpts)
    if (!r.ok) {
      errors += 1
      if (errors >= IMPORT_POLL_MAX_ERRORS) {
        return { ok: false, error: `import: 进度查询连续失败 ${errors} 次（最后一次：${r.error}）` }
      }
      await sleep(IMPORT_POLL_MS)
      continue
    }
    errors = 0
    const job = r.data
    onProgress?.({
      status: job.status,
      done: job.done ?? 0,
      total: job.total ?? 0,
      percent: job.percent ?? 0,
      ...(job.current ? { current: job.current } : {}),
    })
    if (job.status === 'error') {
      return { ok: false, error: job.error || 'import: 后台任务失败' }
    }
    if (job.status === 'done') {
      const report = job.report
      if (!report) return { ok: false, error: 'import: 任务完成但未返回报告' }
      invalidateAfterImport(report)
      return { ok: true, data: report }
    }
    await sleep(IMPORT_POLL_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// —— 删除管理 / 回收站（2026-09-14）——

/** 回收站清单（「最近删除」对话框用）。key 固定 —— 全库只有一个回收站。 */
export const TRASH_KEY = 'trash'

export function useTrash(enabled = true): KnowledgeResource<KnowledgeTrashList> {
  // `enabled=false` → key 为 null → **一个请求都不发**：对话框没打开时不该有内核进程开销
  // （每次 HTTP 调用在 bridge 侧 = 一次新内核进程）。照 useGraphRelated 的既有范式。
  return useResource<KnowledgeTrashList>(enabled ? TRASH_KEY : null, () => listTrash())
}

/**
 * 删/还原之后的**统一缓存失效**。为什么必须收在一处：这四种操作都会改变
 * 「空间集合 × 文档树 × 检索结果 × 图谱」四类视图中的至少三类，各调用点自己记
 * 必然漂移一处 —— 而漂移的表现是"删了但树里还在"（用户会以为删除失败再删一次）。
 *
 * 失效范围与 `invalidateAfterImport` 同口径，外加 `doc:`：被删文档的正文缓存若不失效，
 * 用户从检索结果点进去仍能读到"已删掉的内容"（那是缓存，不是文件还在）。
 * 回收站自身的键也在内 —— 删完要能立刻在「最近删除」里看到。
 */
function invalidateAfterDelete(space?: string | null, docId?: string | null): void {
  invalidateKnowledge(knowledgeKeys.spaces)   // docCount / 空间集合变了
  if (space) invalidateKnowledge(`tree:${space}|`)
  if (docId) invalidateKnowledge(knowledgeKeys.doc(docId))
  invalidateKnowledge('search:')              // 删掉的文档不该再出现在命中里
  invalidateKnowledge('links:')               // 别的文档引用它 → 出边/反链两边都变
  invalidateKnowledge('relatedDoc:')
  invalidateKnowledge('graph:')
  invalidateKnowledge('graphEntry:')
  invalidateKnowledge('graphRelated:')
  invalidateKnowledge(knowledgeKeys.stats)
  invalidateKnowledge(TRASH_KEY)
  // 删除会减少标签计数（甚至让某标签消失）→ 标签视图必须重取（2026-09-14 批次 1）
  invalidateKnowledge('indexTags:')
}

/**
 * 软删除一篇文档（管理员操作，需已确认）。`space` 与 `path` 都传是为了精准失效
 * （`tree:<space>|` 只重取受影响的空间，不必把每个空间的树都刷一遍）。
 */
export async function deleteDoc(
  input: { space: string; path: string; docId?: string },
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeDeleteResult>> {
  const r = await apiDeleteDoc(input.space, input.path, opts)
  if (!r.ok) return r
  invalidateAfterDelete(input.space, input.docId ?? `${input.space}/${input.path}`)
  return r
}

/**
 * 软删除整个知识库。**不改 `useKnowledgeStore.spaceId`**：调用方（页面）应当刷新后
 * 让 `KnowledgePanel` 的空间归一化 effect 自己落到剩余空间 —— 在这里直接写 store 会让
 * "删了但还没刷新"的窗口期指向一个不存在的空间。
 */
export async function deleteSpace(
  input: { spaceId: string; confirm: string },
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeDeleteResult>> {
  const r = await apiDeleteSpace(input.spaceId, input.confirm, opts)
  if (!r.ok) return r
  // 整库被删：其下所有 docs 的正文缓存都要清（前缀失效覆盖不到 `doc:<id>` 这种键，
  // 故这里只能全量清 `doc:` —— 空间级的 doc 前缀映射前端并不持有）
  invalidateAfterDelete(input.spaceId, null)
  invalidateKnowledge('doc:')
  return r
}

/** 从回收站还原（条目回原空间原路径 / 整库回 spaces/；同名由内核改名让位） */
export async function restoreTrash(
  trashId: string,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeDeleteResult>> {
  const r = await apiRestoreTrash(trashId, opts)
  if (!r.ok) return r
  // 还原改的是"哪个空间/哪篇文档"都可能：spaceId 要等响应才知道，故这里按最宽范围失效。
  // 宁可多重取一轮树，也不能出现"还原了却看不到"（那会让用户重复点、重复还原出副本）。
  invalidateAfterDelete(null, null)
  invalidateKnowledge('tree:')
  invalidateKnowledge('doc:')
  return r
}

/**
 * 彻底删除（不可恢复）。**缓存失效范围最窄**：回收站本来就不在索引里，
 * 只有回收站清单与 stats（磁盘占用）会变 —— 把 search/tree 也失效是白花一轮请求。
 */
export async function purgeTrash(
  arg: { trashId: string } | { all: true },
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeDeleteResult>> {
  const r = await apiPurgeTrash(arg, opts)
  if (!r.ok) return r
  invalidateKnowledge(TRASH_KEY)
  invalidateKnowledge(knowledgeKeys.stats)
  return r
}
