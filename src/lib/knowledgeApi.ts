// src/lib/knowledgeApi.ts —— 知识库 bridge HTTP 客户端（S2 Task 2，消费 S1 交付的 /knowledge/*）
//
// 路由全表（server/knowledge-routes.mjs；读操作**薄转发**内核 `--knowledge <op>`，
// server 侧不复制任何切块/检索逻辑）：
//   GET  /knowledge/spaces                       空间清单
//   GET  /knowledge/tree?space=&path=            单层目录列举（懒加载：一次只列一层）
//   GET  /knowledge/doc?id=                      文档（块级结构）
//   GET  /knowledge/entries?id=                  条目级清单（经验文件；非经验文档 → []）
//   GET  /knowledge/search?q=&keywords=&topK=&mode=&spaces=
//   GET  /knowledge/links?id=                    出边 + 反链
//   GET  /knowledge/related?id=&doc=&limit=      关联锚点（块级 / 整篇；S5）
//   GET  /knowledge/graph?space=&limit=          文档级图谱
//   GET  /knowledge/stats                        索引统计
//   POST /knowledge/reindex                     强制重建索引
//   POST /knowledge/doc                          写文档（server 落盘 + **立即**增量索引）
//
// 风格沿 src/lib/workflowApi.ts + src/lib/transcriptLoader.ts：**不 throw**，统一
// `{ ok:true, data } | { ok:false, error, status? }`——路由的 4xx/5xx 都要能在面板里显示成一行提示。
// http 客户端不缓存（缓存/失效在 src/hooks/useKnowledge.ts），但**同 key 并发去重**（见 dedupe）。
//
// 相对导入必须带 `.ts` 后缀：`node --test` 走 Node 原生 TS，既不认 `@/` alias，也不做扩展名补全。
// baseUrl 可注入（测试用）；缺省走 config.getBridgeUrl()。注意 getBridgeUrl() 依赖 Vite 的
// `import.meta.env` / `__BRIDGE_PORT__`，纯 node 环境下调用即抛——故解析放在 try 内并允许注入，
// 保证本模块在无 Vite 的测试环境里仍能加载并返回结构化错误（而不是把异常抛给调用方）。
import { getBridgeUrl } from './config.ts'

const TIMEOUT_MS = 15_000
/** 写文档：落盘 + 内核增量更新，冷启动首帧可能拉起子进程，给更宽的窗口 */
const WRITE_TIMEOUT_MS = 30_000

export type ApiResult<T> =
  | { ok: true; data: T }
  /** status 保留 HTTP 状态码：UI 要区分 403（空间只读）与 413（文档超限）——两者文案都是后端英文短语，
   *  只靠字符串匹配太脆。 */
  | { ok: false; error: string; status?: number }

export interface KnowledgeCallOpts {
  /** 测试注入用；缺省 getBridgeUrl() */
  baseUrl?: string
  timeoutMs?: number
}

// —— 响应形状（S1 实测；字段名照抄，勿自创） ——

export interface KnowledgeSpace {
  id: string
  name: string
  root: string
  writable: boolean
  source: string
  docCount: number
}

export interface KnowledgeTreeEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  /** 仅 file 有（= `${spaceId}/${rel}`） */
  docId?: string
}

export interface KnowledgeBlock {
  n: number
  kind: string
  level?: number
  text: string
  line: number
  /** 经验条目标签；非条目标签为 null */
  tag?: string | null
  full?: string | null
}

export interface KnowledgeDoc {
  id: string
  spaceId: string
  rel: string
  title: string
  tags: string[]
  mtime?: number
  size?: number
  lines?: number
  blocks: KnowledgeBlock[]
}

export interface KnowledgeEntry {
  blockId: string
  tag: string | null
  summary: string
  full: string | null
  line: number
}

export interface KnowledgeSearchItem {
  docId: string
  blockId: string
  spaceId?: string
  title?: string
  heading?: string | null
  snippet: string
  score: number
  line: number
  kind: string
  /** 内核 toItem()（kernel/knowledge.mjs:360-368）**当前不含** tag；保留为可选，UI 勿依赖 */
  tag?: string | null
}

export interface KnowledgeSearchResult {
  items: KnowledgeSearchItem[]
  count: number
  /** 索引构建时间距现在多久（null = 无 builtAt） */
  indexAge: number | null
  /** true = 查询 gram 全部落空，向量路被跳过（只剩关键词路） */
  degraded: boolean
}

export interface KnowledgeLinkOut { to: string; target?: string | null }
export interface KnowledgeLinks { out: KnowledgeLinkOut[]; in: Array<{ from: string }> }

// —— 关联锚点（S5 §7.4）——

/**
 * 锚点的 `why`：**解释性字段，不是可选装饰**（spec §4）。
 *   · `tag`      骨架层（同主题）：两端 tag 当前相等 → 零噪声，GUI 默认展开
 *   · `content`  覆盖层（内容相似）：`shared` 必非空（无解释的边内核直接丢弃），GUI 默认折叠
 *   · `duplicate` 疑似重复（cos ≥ 0.95）：**不是关联**（spec §5.5），GUI 独立提示
 */
export type KnowledgeRelatedWhy =
  | { kind: 'tag'; tag: string }
  | { kind: 'content'; score: number; shared: string[] }
  | { kind: 'duplicate'; score: number }

/** 锚点摘要（内核 relSummary）：**绝不含正文**——只有指路所需的最小信息 */
export interface KnowledgeRelatedAnchor {
  /** 目标**块** id（`<docId>#<n>`）：跳转要定位到条目，不是文档开头 */
  blockId: string
  docId: string
  title: string
  why: KnowledgeRelatedWhy
  /** tag 边恒 null（内核不编造分数）；content/duplicate 有 */
  score: number | null
}

/** `/knowledge/related?doc=` 的一项：某条目块的锚点（S5 Task 9 批量口） */
export interface KnowledgeRelatedBlock {
  blockId: string
  related: KnowledgeRelatedAnchor[]
}

/** 图谱的隐式关联边（文档级；duplicate 不在其中——它不是关联） */
export interface KnowledgeGraphRelatedEdge {
  from: string
  to: string
  kind: 'tag' | 'content'
  score: number | null
  /** 该文档对背后的块级边数（关联"有多实"的旁证） */
  count: number
}

export interface KnowledgeGraphNode { id: string; label: string; spaceId: string; kind: string }
export interface KnowledgeGraphEdge { from: string; to: string; target: string }
export interface KnowledgeGraph { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }

export interface KnowledgeStats {
  version: number
  docs: number
  blocks: number
  grams: number
  spaces: number
  builtAt: string | null
  indexAgeMs: number | null
  indexBytes: number
  /** S3：本进程内的检索耗时分布（CLI/HTTP 通道下恒为 0 样本——跨进程看下面的 metrics） */
  search?: { count: number; elapsedP50: number | null; elapsedP95: number | null }
  /** S3：上次会话注入落盘的指标 sidecar（.index/metrics.json）；无记录为 null。
   *  GUI 暂不展示（S3 非目标含"图表/特殊注入格式"），先补类型以便后续面板消费。 */
  metrics?: {
    updatedAt: string
    inject: {
      calls: number; strategy: string; indexLines: number; recallBlocks: number
      elapsedMs: number; indexAgeMs: number | null; degraded: string | null
      queries: number; hitQueries: number; hitRate: number
    }
    search: { count: number; elapsedP50: number | null; elapsedP95: number | null } | null
  } | null
}

export interface KnowledgeSearchParams {
  q: string
  /** 逗号串下发（内核 `--keywords` 约定）；**空/undefined 一律不发该参数** */
  keywords?: string[]
  topK?: number
  mode?: 'snippet' | 'full'
  /** 逗号串下发（内核按逗号拆分多空间）；**空/undefined 一律不发该参数** */
  spaces?: string[]
}

export interface KnowledgeWriteInput {
  /** 空间 id。后端 `spaceId` 与 `space` 都收，但 GET 系列一律 `space=`，统一用 `space` 保持一眼可读 */
  space: string
  /** 空间根内相对 .md 路径（server 侧四重穿越防护：绝对路径/`..`/非 md 一律 400） */
  path: string
  content: string
}

// —— 请求 ——

interface CallArgs { method?: string; body?: unknown; opts?: KnowledgeCallOpts }

async function call<T>(path: string, { method = 'GET', body, opts = {} }: CallArgs = {}): Promise<ApiResult<T>> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const base = opts.baseUrl || getBridgeUrl()
    const res = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const raw = (data && typeof data === 'object' && 'error' in data) ? (data as { error: unknown }).error : ''
      return { ok: false, error: raw ? String(raw) : `HTTP ${res.status}`, status: res.status }
    }
    return { ok: true, data: (data ?? null) as T }
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string } | null
    const msg = err?.name === 'AbortError'
      ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
      : (err?.message || String(e))
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 同 key 并发去重：搜索框键入/切换空间时同一请求常被触发两次（effect 重挂、双击、debounce 边界），
 * 重复 fetch 不只是浪费——两个响应乱序回来会让后发的**旧**响应覆盖新结果。
 * 复用同一 promise 从根上消掉乱序；请求落定即从表中摘除（不是缓存，缓存交给 hook）。
 */
const inflight = new Map<string, Promise<unknown>>()

function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key) as Promise<T> | undefined
  if (hit) return hit
  const box: { p?: Promise<T> } = {}
  const p = run().finally(() => { if (inflight.get(key) === box.p) inflight.delete(key) })
  box.p = p        // finally 回调只可能在本次同步赋值之后执行
  inflight.set(key, p)
  return p
}

/** 仅供测试/登出清场：丢掉在途去重表（不影响 hook 侧缓存） */
export function clearKnowledgeInflight(): void { inflight.clear() }

/** 查询串组装：URLSearchParams 自动百分号编码；undefined/空串一律不出现在 URL */
function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/**
 * 数组参数 → 逗号串。**不得传 `null`**：内核 `keywordScore` 对 `null` 取防御分支返回 0
 * （S1 §11.4 裁定保留该分支），传 null 会让"无关键词"静默变成"关键词不匹配"。
 * 空数组/undefined 的正确表达是"不发这个参数"。
 */
function csv(xs?: string[]): string | undefined {
  const arr = (xs || []).map(x => String(x).trim()).filter(Boolean)
  return arr.length ? arr.join(',') : undefined
}

/**
 * 内核 CLI 的 `--knowledge` 输出是**包装对象**（`{spaces}` / `{entries}` / `{doc}`，
 * 见 kernel/knowledge-cli.mjs），路由 `ok(value)` 原样透传 → HTTP body 即包装对象。
 * 这里统一拆包，顺带容忍上游某天改成裸数组/裸对象（S2 计划原假设即如此）。
 */
function unwrapList<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[]
  const v = (body as Record<string, unknown> | null)?.[key]
  return Array.isArray(v) ? (v as T[]) : []
}

function unwrapItem<T>(body: unknown, key: string): T | null {
  const v = (body as Record<string, unknown> | null)?.[key]
  return (v && typeof v === 'object') ? (v as T) : null
}

// —— 端点 ——

export function listSpaces(opts?: KnowledgeCallOpts): Promise<ApiResult<{ spaces: KnowledgeSpace[] }>> {
  return dedupe(`spaces`, () => call<{ spaces: KnowledgeSpace[] }>('/knowledge/spaces', { opts }))
}

/** 单层目录列举（懒加载：展开一层调一次）；`path` 省略 = 空间根 */
export function listTree(space: string, path?: string, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeTreeEntry[]>> {
  const query = qs({ space, path })
  return dedupe(`tree:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/tree${query}`, { opts })
    return r.ok ? { ok: true as const, data: unwrapList<KnowledgeTreeEntry>(r.data, 'entries') } : r
  })
}

export function getDoc(id: string, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeDoc>> {
  const query = qs({ id })
  return dedupe(`doc:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/doc${query}`, { opts })
    if (!r.ok) return r
    const doc = unwrapItem<KnowledgeDoc>(r.data, 'doc')
    // 内核 getDoc 查不到返回 null（文档被删/索引未含该 id）→ 归一成 error，UI 走空态而非白屏
    return doc ? { ok: true as const, data: doc } : { ok: false as const, error: 'doc not found' }
  })
}

export function listEntries(id: string, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeEntry[]>> {
  const query = qs({ id })
  return dedupe(`entries:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/entries${query}`, { opts })
    return r.ok ? { ok: true as const, data: unwrapList<KnowledgeEntry>(r.data, 'entries') } : r
  })
}

export function search(params: KnowledgeSearchParams, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeSearchResult>> {
  const query = qs({
    q: params.q,
    keywords: csv(params.keywords),
    topK: params.topK,
    mode: params.mode,
    spaces: csv(params.spaces),
  })
  return dedupe(`search:${query}`, () => call<KnowledgeSearchResult>(`/knowledge/search${query}`, { opts }))
}

export function getLinks(id: string, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeLinks>> {
  const query = qs({ id })
  return dedupe(`links:${query}`, () => call<KnowledgeLinks>(`/knowledge/links${query}`, { opts }))
}

/**
 * 单个块的关联锚点（spec §7.4）。响应体是 CLI 包装对象 `{blockId, validate, limit, count, related}`，
 * 故与 listTree/listEntries 一样**拆包**取 `related`（上游改成裸数组也兼容）。
 * 空数组是**常态**（多数条目没有锚点），不是错误——UI 不得把空集渲染成加载失败。
 */
export function getRelated(id: string, params: { limit?: number } = {}, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeRelatedAnchor[]>> {
  const query = qs({ id, limit: params.limit })
  return dedupe(`related:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/related${query}`, { opts })
    return r.ok ? { ok: true as const, data: unwrapList<KnowledgeRelatedAnchor>(r.data, 'related') } : r
  })
}

/**
 * **整篇文档**所有条目块的锚点（S5 Task 9 GUI 批量口，`?doc=<docId>`）。
 * 为什么不循环调 `getRelated`：每次 HTTP 调用在 bridge 侧是一次新内核进程（约 50–70MB RSS），
 * 一篇文档几十条条目 = 几十次 spawn；卡片行是**默认可见**的，这个代价不能接受（详见内核
 * getRelatedForDoc 的 why）。返回只含"有锚点"的块，故前端无需过滤空壳。
 */
export function getRelatedDoc(docId: string, params: { limit?: number } = {}, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeRelatedBlock[]>> {
  const query = qs({ doc: docId, limit: params.limit })
  return dedupe(`relatedDoc:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/related${query}`, { opts })
    return r.ok ? { ok: true as const, data: unwrapList<KnowledgeRelatedBlock>(r.data, 'blocks') } : r
  })
}

/**
 * 图谱的隐式关联层（仅当图层开关打开时调；`?related=1`）。**单独一个函数**而不是给
 * `getGraph` 加参：图层默认关，缺省路径的请求与响应形状必须与 S2 完全一致（纯增量），
 * 不给既有调用方留"多传一个参就变形状"的坑。此处只取 `related` 字段，节点/边由 getGraph 给。
 */
export function getGraphRelated(space?: string, limit?: number, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeGraphRelatedEdge[]>> {
  const query = qs({ space, limit, related: 1 })
  return dedupe(`graphRel:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/graph${query}`, { opts })
    return r.ok ? { ok: true as const, data: unwrapList<KnowledgeGraphRelatedEdge>(r.data, 'related') } : r
  })
}

/** `limit` 省略 = 后端默认 200（kernel/knowledge.mjs:596），前端不要硬编码更小的值 */
export function getGraph(space?: string, limit?: number, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeGraph>> {
  const query = qs({ space, limit })
  return dedupe(`graph:${query}`, () => call<KnowledgeGraph>(`/knowledge/graph${query}`, { opts }))
}

export function getStats(opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeStats>> {
  return dedupe('stats', () => call<KnowledgeStats>('/knowledge/stats', { opts }))
}

/** 重建索引（服务端 `--force`）；响应 = `{ ok:true, ...stats }` */
export function reindex(opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeStats & { ok: boolean }>> {
  return call<KnowledgeStats & { ok: boolean }>('/knowledge/reindex', { method: 'POST', opts: { timeoutMs: WRITE_TIMEOUT_MS, ...opts } })
}

/**
 * 写文档（新建与保存共用）。后端回执 = `{ ok, docId, updated }`——`ok` 由本层归一成
 * `ApiResult.ok`，data 只透出 `docId`/`updated`（两处同名字段会让调用方判错层）。
 * 后端已做落盘 + 增量索引，故调用方**仍需**失效 doc/tree/search 缓存（见 useKnowledge.saveDoc）。
 * 错误码：400（非法路径/非 md）/ 403（空间只读或越界）/ 404（空间不存在）/ 413（>2MB）。
 */
export async function writeDoc(input: KnowledgeWriteInput, opts?: KnowledgeCallOpts): Promise<ApiResult<{ docId: string; updated: boolean }>> {
  const r = await call<{ docId?: unknown; updated?: unknown }>('/knowledge/doc', {
    method: 'POST',
    body: { space: input.space, path: input.path, content: input.content },
    opts: { timeoutMs: WRITE_TIMEOUT_MS, ...opts },
  })
  if (!r.ok) return r
  return { ok: true, data: { docId: String(r.data?.docId ?? ''), updated: r.data?.updated === true } }
}

/**
 * 读**原始 md 正文**（编辑视图专用，S2 Task 6）。
 *
 * 为什么不复用 `/knowledge/doc`：内核 parseDocFile（kernel/knowledge.mjs:104-125）只回块数组，
 * 入参原文已不可得——条目行的 `- [ ]` 标记、勾选状态、缩进都在块层被丢掉。编辑器若拿 blocks
 * 拼回正文再保存，会把用户原文件里的这些标记**永久写坏**（数据损坏级风险，不可接受），
 * 所以编辑视图必须读原始字节。
 *
 * 通道：bridge 既有 `GET /read-file`（server/bridge.mjs:1688-1693，≤512KB；同上位先例
 * workflowApi.ts:221-229）。错误（文件不存在/超 512KB/非 UTF-8 文本）由 bridge 抛错 →
 * 这里归一成 `{ok:false,error}`，不抛。
 * 路径 = 空间根 `spaces[].root`（后端给的绝对路径）+ 文档 `rel`，前端不做别的心思：
 * 拼接只在两段之间补一个 `/`，尾/首多余分隔符去掉（Windows 下 root 可能带反斜杠）。
 */
export function readRawDoc(root: string, rel: string, opts?: KnowledgeCallOpts): Promise<ApiResult<string>> {
  const abs = `${String(root).replace(/[\/]+$/, '')}/${String(rel).replace(/^[\/]+/, '')}`
  return dedupe(`raw:${abs}`, async () => {
    const r = await call<{ content?: unknown }>(`/read-file?path=${encodeURIComponent(abs)}`, { opts })
    if (!r.ok) return r
    return typeof r.data?.content === 'string'
      ? { ok: true as const, data: r.data.content }
      : { ok: false as const, error: 'read-file: 响应缺少 content' }
  })
}
