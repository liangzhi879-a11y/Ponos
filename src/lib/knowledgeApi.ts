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
//   GET  /knowledge/index-tags?spaces=           全库文档标签枚举（2026-09-14 批次 1）
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
/**
 * 文件知识库导入（2026-09-14）：解析 + 落盘全在内核，扫描件 PDF 走 OCR 按分钟计。
 * 刻意比服务端的 15 分钟窗口**再宽一点**：这样超时一定由服务端先给出（带"内核超时"这类
 * 有意义的 message），而不是前端先 abort（用户只看到一句"请求超时"，无从判断卡在哪一步）。
 */
const IMPORT_TIMEOUT_MS = 16 * 60 * 1000

export type ApiResult<T> =
  | { ok: true; data: T }
  /* status 保留 HTTP 状态码：UI 要区分 403（空间只读）与 413（文档超限）——两者文案都是后端英文短语，
   *  只靠字符串匹配太脆。 */
  /* `message` 可选：后端给的人类可读解释（删除管理用）。为什么单列而不是塞进 `error`：
   * `error` 是**机器可判的码**（`confirm-mismatch` / `protected-space`），UI 要用它选文案；
   * `message` 是码之外的具体说明（"需要 --confirm 且须精确等于「研发资料」"）。
   * 拼进 error 会让码不可判，丢掉则用户只看到 `confirm-mismatch` 这种没法照做的提示。
   * 声明为**同一个成员上的可选字段**（不是第二个联合成员）—— 拆成两个成员会让
   * "老端点不返回 message"这件事从"字段缺省"升级成"类型分支"，调用方每次读
   * `r.message` 都得先窄化类型，把可选字段的成本转嫁给所有调用点。 */
  /* `conflict` / `body`（2026-09-14 批次 4）。两者都是可选成员，理由同上：
   *   · `conflict`：409 冲突时磁盘上的真实状态（mtime/size），只有 writeDoc 会填；
   *   · `body`：**仅在调用方显式开启 `includeErrorBody` 时**才带（见 CallArgs），
   *     用来透出错误响应体（409 的 mtime/size 就在里面）。 */
  | { ok: false; error: string; message?: string; status?: number; conflict?: ConflictInfo; body?: unknown }

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
  /**
   * 标签直连命中（2026-09-14 批次 1）：本条结果的证据是"文档带了这个标签"（值 = 命中的标签名），
   * 而不是"正文里出现过查询词"。缺省 undefined = 正文命中。
   * **可选**：老内核不返回它，UI 必须能按正文命中降级渲染（不显示标签标记）。
   */
  tagHit?: string
}

export interface KnowledgeSearchResult {
  items: KnowledgeSearchItem[]
  /** **实际返回**条数（受 topK/maxBytes 截断），不等于命中总数 */
  count: number
  /**
   * **截断前**的命中总数（2026-09-14 批次 1 新增）。
   * 可选：老服务端不返回它，UI 必须能降级（`total ?? count`）——否则连不上新版内核时
   * 整个检索视图会因 undefined 渲染出"命中 undefined 条"。
   */
  total?: number
  /** 索引构建时间距现在多久（null = 无 builtAt） */
  indexAge: number | null
  /** true = 查询 gram 全部落空，向量路被跳过（只剩关键词路） */
  degraded: boolean
  /**
   * 查询解析失败原因（2026-09-14 批次 3）。**只有解析失败时才有值**（无效正则 / 查询串过长）。
   *
   * 为什么必须在 UI 显式呈现而不是当成"0 条结果"：用户写 `/[/` 时，静默当文本搜会给出
   * "看起来能搜到、语义完全不同"的结果；而当成 0 条则会被理解成"库里没有"。
   * 两种都会让用户对着错误的前提做判断。可选：老内核不返回它 → UI 视为无错。
   */
  queryError?: string | null
  /**
   * 已生效的算子信息（批次 3）。UI 据此回显"哪些算子真的起作用了" ——
   * 否则用户看到结果变少却不知道是哪个算子造成的（尤其 `-tag:x` 这类否定，结果变少是唯一的信号）。
   */
  query?: {
    /** 出现过的算子字段（规范化后的名字：tag/path/file/section/content/block，去重保序） */
    fields?: string[]
    filters?: Array<{ field: string; value: string; negate: boolean }>
    terms?: string[]
    phrases?: string[]
    regexes?: Array<{ value: string; negate: boolean }>
    /** 查询里含 `OR` 分组 */
    or?: boolean
    /** 用户显式写了布尔逻辑（OR 或否定）→ 结果严格满足布尔语义 */
    strict?: boolean
    /** 只有过滤条件、没有任何检索词（走枚举而非打分） */
    filterOnly?: boolean
  }
  /** 仅过滤查询的排序依据（`'path'`）；打分查询不返回该字段 */
  orderedBy?: string
}

/**
 * 引用体系（2026-09-14 对标 Obsidian 批次 2）。
 *
 * `anchorRef`/`anchorKind`：`[[note#小节]]` 的锚点，`'heading' | 'block'`。
 * 阅读视图据此把链接跳到**那一节**而不是文档开头（旧实现在解析时把 `#` 后整段剥掉，
 * 锚点信息在落盘时就没了，只能到文档）。
 * `embed`：`![[note]]` 是**嵌入**（把内容显示在这里），不是引用——两者在 Obsidian 里是
 * 完全不同的阅读体验，数据层必须能区分。
 * `self`：`[[#小节]]` 同文档锚点（目标 = 本文档自身）。旧实现因为 `to` 为空把这类引用
 * **整条丢弃**，文档内部的目录式跳转因此全丢。
 */
export interface KnowledgeLinkOut {
  to: string
  target?: string | null
  /** 链接在原始文件里的行号（跳转定位用） */
  line?: number | null
  /** 链接所在**条目块**的块号（只有 entry 块才非 null：条目级 ref 关联的源） */
  block?: number | null
  /** `[[目标|别名]]` 的别名（展示用，与锚点无关） */
  anchor?: string
  anchorRef?: string
  anchorKind?: 'heading' | 'block' | ''
  embed?: boolean
  self?: boolean
}

/** 反链条目（2026-09-14 批次 2 增强）：除了"谁引用了"，还要给出"在哪、说了什么" */
export interface KnowledgeLinkIn {
  from: string
  line?: number | null
  block?: number | null
  anchor?: string
  anchorRef?: string
  anchorKind?: 'heading' | 'block' | ''
  embed?: boolean
  self?: boolean
  /** 引用位置所在块的短文本（反链面板的上下文预览；老内核不返回 → 空串） */
  snippet?: string
}

export interface KnowledgeLinks { out: KnowledgeLinkOut[]; in: KnowledgeLinkIn[] }

/**
 * 未链接提及（Unlinked mentions，2026-09-14 批次 2）：全库里"提到这篇文档、但没打链接"的位置。
 * Obsidian 的核心发现机制——"你在别处写过它，只是没连起来"。没有它，引用体系只能反映
 * 已经建立的连接，提示不了本该建立的连接。
 */
export interface KnowledgeMention {
  docId: string
  spaceId?: string
  title?: string
  /** 该提及所在块的块 ID（`docId#n`），可直接用于按块跳转 */
  blockId: string
  block: number
  line: number
  kind?: string
  /** 命中的关键词（标题或文件名 stem）——告诉用户"是哪个词命中的" */
  matched: string
  snippet: string
}

export interface KnowledgeMentions {
  items: KnowledgeMention[]
  count: number
  /** 达到 limit 提前停止（库很大时"还有更多"要能提示出来，否则用户以为这就是全部） */
  truncated?: boolean
}

/** 断链（2026-09-14 批次 2）：`target` 为 null 的引用，按**目标名**聚合（同一拼错常重复出现） */
export interface KnowledgeBrokenLink {
  to: string
  count: number
  refs: Array<{ from: string; line?: number | null; block?: number | null; anchorRef?: string }>
}

// —— 索引标签枚举（2026-09-14 对标 Obsidian 批次 1）——

/** 单个标签的统计。`single` = 只被一篇文档用到（标签体系腐烂的第一信号，内核显式标记） */
export interface KnowledgeIndexTag {
  tag: string
  /** 引用该标签的**文档数**（不是块数——同一文档内出现多次只算一次） */
  count: number
  /** 所属空间；跨空间同名标签 → null（表示"不止一个空间在用"） */
  spaceId?: string | null
  single: boolean
}

export interface KnowledgeIndexTags {
  tags: KnowledgeIndexTag[]
  total: number
  singleCount: number
  /** 生效的空间白名单；null = 全部空间。用于把"该空间确实没有标签"与"空间名拼错"区分开 */
  spaces: string[] | null
}

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

export interface KnowledgeGraphNode {
  id: string; label: string; spaceId: string; kind: string
  // S5.1：条目级图谱的节点字段（文档级节点不带）。`docId`+`line` 用于**点节点后定位到块**——
  // 没有 line 就只能在文档里从头找，条目级图的可导航性就废了一半。
  docId?: string; line?: number | null; tag?: string | null
}
export interface KnowledgeGraphEdge {
  from: string; to: string; target: string
  /** S5.1：条目级边的类型（tag / content / ref）。文档级的显式链接边没有 kind。 */
  kind?: 'tag' | 'content' | 'ref'
  score?: number | null
}
export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]
  /** S5.1：'doc'（缺省）| 'entry'。内核据此返回不同形状的图。 */
  level?: 'doc' | 'entry'
  /** 条目级图被 `limit` 截断时为 true（提示用户"还有更多条目未画出"） */
  truncated?: boolean
}

export interface KnowledgeStats {
  version: number
  docs: number
  blocks: number
  grams: number
  spaces: number
  builtAt: string | null
  indexAgeMs: number | null
  indexBytes: number
  /**
   * 文件数上限留痕（2026-09-14 批次 4）。`truncated: true` = 有文档**没进索引**：
   * 该空间的文件数超过 `limit`（缺省 5000），被静默跳过的那些搜不到、图谱里没有、
   * 统计数字也不含。旧内核不返回该字段 → UI 视为"未截断"（不误报）。
   * `staleSweepSkipped`：截断导致"磁盘已删"清扫被跳过（见内核 indexStale 注释）。
   */
  filesTruncated?: {
    truncated: boolean
    limit: number
    spaces: Array<{ spaceId: string; count: number; limit: number }>
    staleSweepSkipped?: boolean
  }
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
  /**
   * 客户端**加载该文档时**看到的 mtime（2026-09-14 批次 4）。
   *
   * 为什么必须有：知识空间目录是共享的（Obsidian/VSCode 会直接改同一批 md）。带上它，
   * 服务端就能发现"我加载之后这文件被别人改过"，从而**拒绝**这次覆盖（409）而不是
   * 让外部那笔改动无声消失。不带（老调用方）→ 服务端跳过校验，行为与旧版一致。
   */
  mtime?: number
  /** 冲突时是否强制覆盖（服务端会先把磁盘上那份备份进回收站）。只有用户在冲突提示里明确选择才传 */
  force?: boolean
}

// —— 请求 ——

interface CallArgs {
  method?: string
  body?: unknown
  opts?: KnowledgeCallOpts
  /**
   * 失败时把响应体一并带出（2026-09-14 批次 4）。**必须显式开**：
   * 既有失败分支刻意不带 `body`（理由见上方 `message` 处注释 —— 恒塞空值会让既有调用方的
   * deepEqual 断言全部失配）。只有需要读错误细节的调用方（写文档的 409 冲突要拿磁盘
   * mtime/size 给用户判断）才打开它，其它路径的返回形状逐字不变。
   */
  includeErrorBody?: boolean
}

async function call<T>(path: string, { method = 'GET', body, opts = {}, includeErrorBody = false }: CallArgs = {}): Promise<ApiResult<T>> {
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
      const detail = (data && typeof data === 'object' && 'message' in data)
        ? String((data as { message: unknown }).message ?? '')
        : ''
      // 只在后端真的给了 message 时才带上该键：老端点（如 write/import）不返回它，
      // 恒塞一个 `message: ''` 会让既有调用方的 deepEqual 断言全部失配。
      return {
        ok: false,
        error: raw ? String(raw) : `HTTP ${res.status}`,
        ...(detail ? { message: detail } : {}),
        status: res.status,
        // 只在调用方明确要求时带出响应体（批次 4：409 冲突要读磁盘 mtime/size），
        // 其余路径的返回形状逐字不变（理由同上，见 includeErrorBody 的注释）
        ...(includeErrorBody ? { body: data ?? null } : {}),
      }
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

/**
 * 索引标签枚举（2026-09-14 批次 1）：**全库文档标签**（含用户空间与只读 packs），
 * 与 `listMemoryTags`（S6 的 `/knowledge/tags`，只认经验库、条目级）不是一回事——两者都留着，
 * 因为消费方不同（标签视图要全库；写前查重只关心经验库）。
 * `spaces` 传空数组与不传等价（都不过滤），口径由内核的 parseSpacesArg 统一。
 */
export function listIndexTags(spaces?: string[], opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeIndexTags>> {
  const query = qs({ spaces: spaces && spaces.length ? spaces.join(',') : undefined })
  return dedupe(`index-tags:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/index-tags${query}`, { opts })
    if (!r.ok) return r
    // 内核一定返回对象；但"返回了非对象"（代理改包/路由串）时要归一成 error 而不是让
    // UI 拿到 undefined 去 .tags.length（白屏）。这是本模块既有的 unwrap 纪律。
    const v = r.data as KnowledgeIndexTags | null
    if (!v || typeof v !== 'object' || !Array.isArray(v.tags)) {
      return { ok: false as const, error: 'bad-index-tags-payload' }
    }
    return { ok: true as const, data: v }
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
 * 未链接提及（2026-09-14 批次 2）。`id` 必填——服务端对缺失返回 400（不是"空集"）：
 * 没有目标就无所谓"提及"，静默返回一批无关数据会被误读成"这篇被提及了很多次"。
 */
export function getMentions(id: string, limit?: number, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeMentions>> {
  const query = qs({ id, limit })
  return dedupe(`mentions:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/mentions${query}`, { opts })
    if (!r.ok) return r
    const v = r.data as KnowledgeMentions | null
    // 与 listIndexTags 同样的拆包纪律：返回非对象时给明确错误，
    // 否则 UI 会拿到 undefined 去 .items.map（白屏），而错误信息归零。
    if (!v || typeof v !== 'object' || !Array.isArray(v.items)) {
      return { ok: false as const, error: 'bad-mentions-payload' }
    }
    return { ok: true as const, data: { ...v, count: v.count ?? v.items.length } }
  })
}

/** 断链清单（2026-09-14 批次 2）。`space` 缺省 = 全部空间 */
export function getBrokenLinks(space?: string | null, limit?: number, opts?: KnowledgeCallOpts): Promise<ApiResult<{ items: KnowledgeBrokenLink[]; total: number; broken: number }>> {
  const query = qs({ space: space || undefined, limit })
  return dedupe(`broken-links:${query}`, async () => {
    const r = await call<unknown>(`/knowledge/broken-links${query}`, { opts })
    if (!r.ok) return r
    const v = r.data as { items?: KnowledgeBrokenLink[] } | null
    if (!v || typeof v !== 'object' || !Array.isArray(v.items)) {
      return { ok: false as const, error: 'bad-broken-links-payload' }
    }
    return { ok: true as const, data: { items: v.items, total: v.items.length, broken: v.items.reduce((n, x) => n + (x.count || 0), 0) } }
  })
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

/** `limit` 省略 = 后端默认 200（kernel/knowledge.mjs:596），前端不要硬编码更小的值。
 *  `around` + `hops`（2026-09-14 批次 2）= **局部图**：只画以某文档为心的 N 跳双向邻域。
 *  全局图在文档多起来后是毛线球（看不出结构），局部图才是能读的视图。
 *  `hops` 只在 `around` 存在时有意义 —— 服务端也是这么处理的（单给 hops 什么都不做）。 */
export function getGraph(space?: string, limit?: number, opts?: KnowledgeCallOpts & { around?: string; hops?: number }): Promise<ApiResult<KnowledgeGraph>> {
  const { around, hops, ...rest } = opts ?? {}
  const query = qs({ space, limit, around, hops: around ? hops : undefined })
  return dedupe(`graph:${query}`, () => call<KnowledgeGraph>(`/knowledge/graph${query}`, { opts: rest }))
}

/**
 * 条目级图谱（S5.1）：`?level=entry`。**单独一个函数**，理由同 `getGraphRelated`——
 * 形状根本不同（节点是**条目**而非文档、边是 tag/content/ref 三类关联而非文档间链接），
 * 共用一个签名会让调用方把条目级数据按文档级解读（节点 id 是 `docId#n` 不是 `docId`）。
 *
 * 为什么需要它：真实库 **74/76 条条目挤在同一文件内**，文档级图把这些条目间的关联
 * 全部塌成自环并过滤 ⇒ 文档级只有 1 条跨文档边，用户看到的等于是"没有图谱"。
 */
export function getEntryGraph(space?: string, limit?: number, opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeGraph>> {
  const query = qs({ space, limit, level: 'entry' })
  return dedupe(`graphEntry:${query}`, () => call<KnowledgeGraph>(`/knowledge/graph${query}`, { opts }))
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
 * 错误码：400（非法路径/非 md）/ 403（空间只读或越界）/ 404（空间不存在）/ 413（>2MB）
 *        / **409（冲突：文件已被外部修改，见下）**。
 *
 * 409 冲突（2026-09-14 批次 4）：带上 `mtime` 后，服务端会比对磁盘实际 mtime；不一致说明
 * 用户加载之后有别的程序（Obsidian/VSCode）改过这个文件 → **拒绝写入**，不再让外部改动无声消失。
 * 调用方拿到 409 要提示用户选择：重新载入外部版本，或以自己这份覆盖（覆盖前服务端自动备份）。
 * `updated:false` + `unchanged:true` = 内容与磁盘一致，服务端短路了写入（不是失败）。
 */
export async function writeDoc(
  input: KnowledgeWriteInput,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<{ docId: string; updated: boolean; unchanged?: boolean; mtime?: number | null; conflict?: ConflictInfo }>> {
  const r = await call<{ docId?: unknown; updated?: unknown; unchanged?: unknown; mtime?: unknown }>('/knowledge/doc', {
    method: 'POST',
    body: {
      space: input.space, path: input.path, content: input.content,
      // 只在有值时带上：老调用方（不带 mtime）会走"跳过校验"的旧路径，不去制造误报冲突
      ...(Number.isFinite(input.mtime) ? { mtime: Number(input.mtime) } : {}),
      ...(input.force === true ? { force: true } : {}),
    },
    opts: { timeoutMs: WRITE_TIMEOUT_MS, ...opts },
    // 409 冲突要看响应体里的 mtime/size（见 CallArgs.includeErrorBody：默认不带，避免影响
    // 其它调用方的返回形状与既有断言）
    includeErrorBody: true,
  })
  if (!r.ok) {
    // 409 不是"失败"，是"需要用户决策"：把磁盘真实状态一起带出去，UI 才能显示
    // "外部版本多大/多新"让用户判断（只给一句"冲突了"等于把问题丢回给用户）
    if (r.status === 409) {
      const d = r.body as { mtime?: number; size?: number } | null
      return { ok: false, error: r.error, status: 409, conflict: { mtime: d?.mtime ?? null, size: d?.size ?? null } }
    }
    // 非冲突错误（403/413/…）：把 `body` 摘掉再返回。`includeErrorBody` 只为 409 而开，
    // 但它是**整次调用的开关** —— 不摘的话 403/413 的返回形状会多出一个 `body` 字段，
    // 破坏"错误结果不含多余字段"这条被测试钉着的契约（本仓库有专门用例）。
    const { body: _drop, ...plain } = r
    return plain
  }
  return {
    ok: true,
    data: {
      docId: String(r.data?.docId ?? ''),
      updated: r.data?.updated === true,
      // `unchanged`/`mtime` **只在有值时出现**（2026-09-14 批次 4）。与失败分支的 `message`/
      // `body` 同一取舍：恒塞 `undefined`/`null` 会让既有调用方的 deepEqual 断言全部失配
      // （本仓库有测试专门钉"请求/响应不含多余字段"）。老服务端不返回 mtime → 形状与旧版逐字一致。
      ...(r.data?.unchanged === true ? { unchanged: true } : {}),
      ...(typeof r.data?.mtime === 'number' ? { mtime: r.data.mtime } : {}),
    },
  }
}

/** 409 冲突时磁盘上的真实状态（供 UI 展示"外部版本"信息） */
export interface ConflictInfo {
  /** 磁盘上文件的 mtime（毫秒）；拿不到为 null */
  mtime: number | null
  /** 磁盘上文件的字节数；拿不到为 null */
  size: number | null
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

/** 导入报告里的一条结果（三档共用的形状；`error`/`reason` 至少有一个） */
export interface KnowledgeImportEntry {
  source: string
  out?: string | null
  /**
   * 转换器：`pdf-text`(文本层 PDF，表格由本地 PyMuPDF 读) / `pdf-ocr`(扫描件，表格只能靠视觉模型) /
   * `ocr`(图片) / `docx` / `xlsx` / `pptx` / `text` / `csv` …
   * 前端据此判断"这份文件依赖视觉模型吗"（见 KnowledgeImportDialog 的 isScannedResult）。
   */
  converter?: string
  /** 该文件的视觉表格提取结果（仅扫描件/图片且走了视觉时才有） */
  vision?: { attempted: number; pages: number; tables: number; truncated?: boolean }
  bytes?: number
  truncated?: boolean
  warnings?: string[]
  /** dryRun 预览时出现：`convert` 表示此次会转换 */
  action?: string
  /** 跳过原因（`unchanged`）——目前只有"内容未变"一种，保留字段以便未来扩展 */
  reason?: string
  /** 失败时的机器可读码 */
  error?: string
  message?: string
}

export interface KnowledgeImportReport {
  ok: boolean
  spaceId: string
  spaceName: string
  spaceCreated: boolean
  dryRun: boolean
  spaceRoot?: string
  /** 单源是字符串，多源是数组（GUI 多选文件 = 多源） */
  source: string | string[]
  sources?: string[]
  counts: { total: number; converted: number; skipped: number; failed: number }
  converted: KnowledgeImportEntry[]
  skipped: KnowledgeImportEntry[]
  failed: KnowledgeImportEntry[]
  /** `reloaded` = 已同步索引（导入完立刻可搜）；`none`/`failed` 时提示会自动重建 */
  indexSync: string
  warnings: string[]
  /**
   * 视觉表格提取的整批口径（2026-09-14）：扫描件/图片里的表格**只能**靠视觉模型读出来
   * （OCR 不保留列坐标，实测引擎的文本启发式表格数恒为 0）。
   * `configured=false` + `skipped='not-configured'` 时前端要明确提示用户去配置 ——
   * 否则用户只看到"扫描件里没有表格"，会误以为文档本身没表格。
   */
  vision?: {
    /** 是否配置了视觉模型（内核与 Vision 工具同一份判定，兼容 PONOS_VISION_x 与 YFW_VISION_x 两种前缀） */
    configured: boolean
    /** `not-configured` | `disabled` | `no-page-images` | null（null = 本轮用上了视觉） */
    skipped: string | null
    used: boolean
    pages: number
    tables: number
  }
}

export interface KnowledgeImportPayload {
  /** 文件或目录的绝对路径；数组 = 一次导入多个源 */
  from: string | string[]
  /** 目标空间 id（不存在则新建）。与 `name` 至少给一个 */
  spaceId?: string
  /** 空间显示名（新建时写入 .space.json） */
  name?: string
  /** 只预览不落盘 */
  dryRun?: boolean
  maxOcrPages?: number
  /**
   * 扫描件/图片的表格识别（2026-09-14）：`true`/`false` 显式开关，`'auto'`（缺省）= 配了视觉模型就用。
   * 关掉可省时间与调用费用；**文本层 PDF 的表格不受影响**（那是本地 PyMuPDF 直接读的）。
   */
  visionTables?: boolean | 'auto'
  /** 交给视觉模型的页数上限（缺省 20；0 = 一页都不给，即"只要正文不要表格"）。视觉调用按页慢且可能计费 */
  maxVisionPages?: number
  /**
   * 异步导入（2026-09-14，批量场景）：`true` 时服务端**立即**回 `202 {jobId}`，
   * 导入在后台跑，进度经 `getImportJob` 轮询。缺省（或不传）走原来的同步一次性返回
   * —— 那条路径的行为逐字节不变，小批量/既有调用方不受影响。
   */
  async?: boolean
  /** 单次导入的文件数上限覆盖（缺省用服务端配置档；非法值服务端回 400 而非静默回落） */
  maxFiles?: number
  /** 单次导入的总 MB 上限覆盖（缺省用服务端配置档） */
  maxTotalMb?: number
}

/** 异步导入任务的状态（与服务端 `GET /knowledge/import/jobs/:id` 一一对应） */
export interface KnowledgeImportJob {
  status: 'running' | 'done' | 'error'
  /** 已完成数（`running` 时 = 内核上报的循环下标） */
  done: number
  /** 计划文件数；`plan` 事件到达前**为 0**（= 还在统计，调用方应显示不确定态） */
  total: number
  /** 0-100 整数（服务端与前端同一口径：total=0 时 0，上限 100） */
  percent: number
  /** 当前处理的相对路径（仅 running 且已进入处理阶段时有） */
  current?: string
  startedAt?: number
  endedAt?: number
  /** 仅 `done`：与同步路径**完全相同**的报告形状 */
  report?: KnowledgeImportReport
  /** 仅 `error`：错误消息（闸门错误形如 `too-many-files: …`） */
  error?: string
  /** 仅 `error`：机器可读错误码（有则便于前端按码给建议） */
  code?: string
}

/**
 * 文件知识库导入（2026-09-14）：把一批文件（PDF/Word/Excel/PPT/图片/文本）转成 Markdown
 * 落进一个知识空间，随后检索即可命中。
 *
 * 为什么**不**走 dedupe：导入本身是幂等操作（内核按 sourceHash 跳过未变文件），但它是有副作用的
 * 写操作，被 dedupe 合并会掩盖"用户改了目标空间后重试"这类真实意图变化；而且它的耗时可到分钟级，
 * 被并发去重表长期占位没有收益。同 writeDoc 的取舍。
 * `dryRun` 也一样不过 dedupe（它便宜、且必须反映当下文件状态）。
 */
export function importKnowledge(
  payload: KnowledgeImportPayload,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeImportReport>> {
  return call<KnowledgeImportReport>('/knowledge/import', {
    method: 'POST',
    body: payload,
    opts: { timeoutMs: IMPORT_TIMEOUT_MS, ...(opts || {}) },
  })
}

/**
 * 提交**异步**导入（2026-09-14，批量场景）：服务端立即回 `202 {jobId}`，随后用
 * `getImportJob` 轮询进度与结果。
 *
 * 为什么批量必须异步：同步路径要等整批转完才回一个响应，几千个文件时前端只有转圈
 * （既不知道总数、也不知道到哪了），而且一旦超过 `IMPORT_TIMEOUT_MS` 就整体失败——
 * 前面已经转换完的文件白等。异步化让"先查文件数、再按已处理数算进度"成为可能。
 *
 * 超时用短超时（不是 IMPORT_TIMEOUT_MS）：这个请求**只做提交**，服务端立刻返回；
 * 若它自己挂住，说明桥/内核启动有问题，不该让用户干等 16 分钟。
 */
export function startImportJob(
  payload: KnowledgeImportPayload,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<{ jobId: string }>> {
  return call<{ jobId: string }>('/knowledge/import', {
    method: 'POST',
    body: { ...payload, async: true },
    opts: { timeoutMs: 30 * 1000, ...(opts || {}) },
  })
}

/**
 * 查异步导入任务的状态（轮询用）。
 *
 * 为什么用短超时：轮询是高频动作（~500ms 一次），单次请求挂住时应该**尽快失败并重试**，
 * 而不是把轮询循环卡在一次请求上——那会让进度条看起来"停止更新"而实际任务仍在跑。
 */
export function getImportJob(
  jobId: string,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeImportJob>> {
  return call<KnowledgeImportJob>(`/knowledge/import/jobs/${encodeURIComponent(jobId)}`, {
    opts: { timeoutMs: 10 * 1000, ...(opts || {}) },
  })
}

// —— 删除管理 / 回收站（2026-09-14）——
// 设计见 .yfw-spec/knowledge-trash/spec.md。删除一律是**软删除**（移到回收站），
// 只有 purge 是真删；权限判定（内置空间不许删整库、知识包只读）**全在内核**，
// 前端只做"要不要显示按钮"的预判，绝不复刻判据（复刻必漂移，而漂移意味着绕过权限）。

/** 回收站里的一项（内核 `listTrash` 的条目形状，字段名照抄） */
export interface KnowledgeTrashItem {
  trashId: string
  kind: 'doc' | 'space'
  spaceId: string | null
  spaceName: string | null
  /** 仅 kind='doc'：原空间内的相对路径（还原就放回这里） */
  relPath: string | null
  name: string | null
  deletedAt: string | null
  bytes: number
  fileCount: number
  /** 内容是否还在磁盘上：false 时只能「彻底删除」记录，不能还原（内核会报 payload-missing） */
  available: boolean
}

export interface KnowledgeTrashList {
  dir: string
  count: number
  bytes: number
  /** 无台账的散落目录数（内核只报数不列出：列出来也删不掉，比不列更糟） */
  stray: number
  items: KnowledgeTrashItem[]
}

/** 删除/还原/清空的结果（内核各 op 的公共字段） */
export interface KnowledgeDeleteResult {
  ok: true
  trashId?: string
  kind?: 'doc' | 'space'
  spaceId?: string
  path?: string
  /** 还原时：原名被占用而改名让位（`a.md` → `a-2.md`）时为 true */
  renamed?: boolean
  bytes?: number
  files?: number
  purged?: number
  indexSync?: 'reloaded' | 'unchanged'
}

/** 回收站清单（纯读，可缓存） */
export function listTrash(opts?: KnowledgeCallOpts): Promise<ApiResult<KnowledgeTrashList>> {
  return call<KnowledgeTrashList>('/knowledge/trash', { opts: { timeoutMs: 15 * 1000, ...(opts || {}) } })
}

/**
 * 软删除单篇文档。**不走 dedupe**：删除有副作用且用户会重复点（第一次删完再删一次
 * 应当得到"文件不存在"，而不是复用上一次的成功响应）。
 */
export function deleteDoc(
  spaceId: string,
  path: string,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeDeleteResult>> {
  return call<KnowledgeDeleteResult>('/knowledge/delete', {
    method: 'DELETE',
    body: { spaceId, path },
    opts: { timeoutMs: 15 * 1000, ...(opts || {}) },
  })
}

/**
 * 软删除整个知识库。`confirm` 必须**精确等于空间 id**（内核校验，防手滑删库）——
 * 这里不做前端预校验：只在 UI 上把确认框做对，判据留内核一份。
 */
export function deleteSpace(
  spaceId: string,
  confirm: string,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeDeleteResult>> {
  return call<KnowledgeDeleteResult>('/knowledge/delete-space', {
    method: 'DELETE',
    body: { spaceId, confirm },
    opts: { timeoutMs: 30 * 1000, ...(opts || {}) },
  })
}

/** 从回收站还原（遇同名由内核改名让位，绝不覆盖） */
export function restoreTrash(
  trashId: string,
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeDeleteResult>> {
  return call<KnowledgeDeleteResult>('/knowledge/restore', {
    method: 'DELETE',
    body: { trashId },
    opts: { timeoutMs: 30 * 1000, ...(opts || {}) },
  })
}

/**
 * 彻底删除（**真正销毁、不可恢复**）：给 `trashId` 删一项，或 `all=true` 清空回收站。
 * `all` 只认**严格 true**（服务端也只认 `=== true`）——"清空"必须是一次显式意图，
 * 不能因为传了 `"false"` 这种字符串就把整个回收站清掉。
 */
export function purgeTrash(
  arg: { trashId: string } | { all: true },
  opts?: KnowledgeCallOpts,
): Promise<ApiResult<KnowledgeDeleteResult>> {
  return call<KnowledgeDeleteResult>('/knowledge/purge', {
    method: 'DELETE',
    body: arg,
    opts: { timeoutMs: 60 * 1000, ...(opts || {}) },
  })
}
