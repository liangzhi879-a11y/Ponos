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
  getDoc, getEntryGraph, getGraph, getGraphRelated, getImportJob, getLinks, getRelatedDoc, getStats, importKnowledge,
  listEntries, listSpaces, listTree, search, startImportJob, writeDoc,
  type ApiResult, type KnowledgeCallOpts, type KnowledgeDoc, type KnowledgeEntry,
  type KnowledgeGraph, type KnowledgeGraphRelatedEdge, type KnowledgeImportPayload,
  type KnowledgeImportReport, type KnowledgeLinks,
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
  graph: (space: string | null, limit?: number) => `graph:${space ?? '*'}|${limit ?? ''}`,
  /** 条目级图谱（S5.1 层级开关）。键前缀独立，否则与文档级图互相串缓存 */
  graphEntry: (space: string | null, limit?: number) => `graphEntry:${space ?? '*'}|${limit ?? ''}`,
  /** 出边 + 反链（右栏 Inspector，Task 9）；键按文档 id，故前缀失效用 `links:` */
  links: (id: string) => `links:${id}`,
  /** 整篇文档的关联锚点（S5 Task 9：条目卡片关联行 / Inspector 关联段） */
  relatedDoc: (id: string) => `relatedDoc:${id}`,
  /** 图谱的隐式关联层（S5 Task 9：图层开关打开时才请求）；分隔符 `|` 同 graph 键 */
  graphRelated: (space: string | null, limit?: number) => `graphRelated:${space ?? '*'}|${limit ?? ''}`,
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
