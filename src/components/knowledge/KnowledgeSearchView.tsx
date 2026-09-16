// src/components/knowledge/KnowledgeSearchView.tsx —— 检索视图（S2 Task 7）
//
// 数据：`useSearch(params)`（Task 2）自带缓存 + 并发去重 + 卸载退订，这里**只管触发频率**：
//   · 200ms debounce（spec §10 D5 与 Task 7 要点）：中文输入法 composition 期间每敲一个字母都发请求
//     会打满内核检索（每次都是全库倒排 + 向量重排）；200ms 是"手感不迟滞"与"别打爆"的折中。
//   · `q` 为空时 hook 直接不发请求（key=null），所以空框的初始态天然是"提示语"而不是空结果列表。
//
// 行渲染三个约定：
//   ① snippet 的命中词高亮走 lib/knowledgeSearch.splitHighlight（纯逻辑，有 node:test 钉住转义与切分）；
//   ② `score` **不显示数字**，只用三格色条表示"同一次结果内的相对强弱"（原因见 lib 文件头）；
//   ③ `degraded === true`（查询 gram 全落空 → 向量路被跳过）给一个 `.micro` 微标，
//      让"结果比预期少"有个可解释的原因，而不是让用户以为库是空的。
//
// 点击结果 = 「先切文档，再置行号，最后切视图」——顺序是硬约束：store 的 setDocId 会清 targetLine
// （行号只在同一篇文档内有意义），反过来写会让跳转永远落在文档开头。
// 定位与高亮由阅读视图复用 Task 5 的能力（KnowledgeDocView 的 targetLine + data-line 锚点）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Search } from 'lucide-react'
import { useSearch } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useTranslation } from '@/i18n/useTranslation'
import { Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { KnowledgeSearchItem, KnowledgeSearchParams, KnowledgeSearchResult } from '@/lib/knowledgeApi'
import {
  KB_FOCUS_SEARCH_EVENT, maxScore, parseKeywords, searchTerms, sortHits, splitHighlight, strengthLevel,
  type SearchSort,
} from '@/lib/knowledgeSearch'
import { KnowledgeEmpty } from './KnowledgeEmpty'
import { KnowledgeSkeleton } from './KnowledgeSkeleton'
import { KnowledgeScopeToggle } from './KnowledgeScopeToggle'
// 检索语法层的前端镜像（批次 3）：**只用于输入过程中的提示**；结果回显一律以内核回传为准
import { describeQuery } from '@/lib/knowledgeQuery'

/**
 * 把内核回带的 `query` 元信息渲染成"已生效算子"标签（批次 3）。
 *
 * 只用**内核**回带的字段（不用本地 `describeQuery` 的结果）：显示"生效的算子"必须以实际
 * 执行为准。两份实现一旦漂移，用户会看到"UI 说生效了、结果却没按它过滤"—— 那是最难排查的
 * 一类不一致（既不报错，也不稳定复现）。本地解析留给"输入过程中的提示"。
 *
 * 渲染规则：过滤条件带值（`tag:财务`）；纯文本项只报数量（把每个词都列出来会挤满一行，
 * 且用户刚打完那个词，不需要再被告知一遍）。否定项前置 `-`。
 */
function activeQueryChips(q: NonNullable<KnowledgeSearchResult['query']>): string[] {
  const out: string[] = []
  for (const f of q.filters ?? []) out.push(`${f.negate ? '-' : ''}${f.field}:${f.value}`)
  for (const r of q.regexes ?? []) out.push(`${r.negate ? '-' : ''}/${r.value}/`)
  const textCount = (q.terms?.length ?? 0) + (q.phrases?.length ?? 0)
  if (textCount > 0) out.push('⌕×' + String(textCount))
  if (q.or) out.push('OR')
  return out
}

/**
 * 输入过程中的算子提示行（批次 3）。
 *
 * 只在用户**已经用上算子**或查询串看起来"没有可搜索的文本"时显示 —— 空查询、或一句普通
 * 关键词搜索时不出现（那两个状态下提示只是噪音，还会把结果区往下挤）。
 *
 * 特别处理 `noPositiveText`：只写 `tag:x` 或只写 `-foo` 时用户不知道会得到什么结果。
 * 前者走"按标签枚举文档"，后者按语义**必然为空** —— 提前一句话说清，好过让他对着空列表猜。
 */
/** 算子字段 → i18n key。**显式映射**而不是动态拼 key：拼错了 tsc 抓不到，
 *  运行时只会静默回退成把 key 本身显示给用户（ 这种字样出现在界面上）。 */
const FIELD_DESC_KEY: Record<string, string> = {
  tag: 'knowledge.qfTag',
  path: 'knowledge.qfPath',
  file: 'knowledge.qfFile',
  section: 'knowledge.qfSection',
  content: 'knowledge.qfContent',
  block: 'knowledge.qfBlock',
}

function QueryHintRow({ raw }: { raw: string }) {
  const { t } = useTranslation()
  const d = describeQuery(raw)
  if (d.fields.length === 0 && !d.hasOr && !d.noPositiveText) return null
  return (
    <div className="flex items-center gap-1 flex-wrap pt-1 text-[10px] text-tertiary">
      {d.fields.map(f => (
        <span key={f} className="px-1.5 h-4 inline-flex items-center clip-sm bg-elevated text-secondary">
          {f}: {t(FIELD_DESC_KEY[f] ?? 'knowledge.qfTag')}
        </span>
      ))}
      {d.hasOr && <span className="text-secondary">OR</span>}
      {d.negated && <span>{t('knowledge.queryNegatedHint')}</span>}
      {d.noPositiveText && <span>{t('knowledge.queryNoTextHint')}</span>}
    </div>
  )
}

/** 键入到发请求的静默期（Task 7 指定 200ms） */
const DEBOUNCE_MS = 200
/** 后端默认 topK=5（那是给 LLM 上下文预算定的），GUI 列表要更多才够翻 */
const TOP_K = 20

export function KnowledgeSearchView() {
  const { t } = useTranslation()
  const spaceId = useKnowledgeStore(s => s.spaceId)

  const [q, setQ] = useState('')
  const [kw, setKw] = useState('')
  /** 已 debounce 的草稿（发请求只看它） */
  const [settled, setSettled] = useState({ q: '', kw: '' })
  const [allSpaces, setAllSpaces] = useState(true)
  // 排序模式（2026-09-14 批次 1）：内核只有 score 降序，这里只重排**本次返回的**那批
  // （排序语义的边界见 lib/knowledgeSearch.ts 的 sortHits 注释）。默认相关度 = 内核顺序。
  const [sort, setSort] = useState<SearchSort>('relevance')
  // 全文模式：命中项返回整段内容而不是 snippet。默认**关**——整段进上下文很贵
  // （内核 maxBytes 预算的由来），这里做成用户显式要求才付这个代价。
  const [fullText, setFullText] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 标签视图 / 元信息面板的"以标签去检索"意图（store 的一次性字段）：
  // 查询串与关键词都填标签名——两者缺一都会让点击标签的结果不完整：
  //   · `q` 为空时内核直接返回空集（searchInner 的 qtext 短路）；
  //   · 关键词为空时，frontmatter 里的标签**不参与**匹配（它不在块文本里，只通过
  //     structBoost/keywordScore 的 tags 匹配加权），于是"只在 frontmatter 标了标签、
  //     正文没提过这个词"的文档会整批漏掉。
  // 消费后立即清空：否则从阅读视图切回检索视图会被这条陈旧意图再顶一次。
  const pendingKeywords = useKnowledgeStore(s => s.searchKeywords)
  useEffect(() => {
    if (!pendingKeywords || !pendingKeywords.length) return
    // 第一个词当**查询串**，整串当关键词：父标签点击会带上一串后代标签（`a`, `a/b`, `a/c`），
    // 把这一串原样塞进查询串只会变成"整串的 gram 匹配"（几乎必然 0 命中），
    // 所以查询串只取主标签，其余交给关键词路做加权。
    const primary = pendingKeywords[0]
    const kwText = pendingKeywords.join(', ')
    setQ(primary)
    setKw(kwText)
    setSettled({ q: primary, kw: kwText })   // 跳过 debounce：这是明确意图，不该等 200ms
    useKnowledgeStore.getState().clearSearchKeywords()
  }, [pendingKeywords])

  useEffect(() => {
    const timer = setTimeout(() => setSettled({ q, kw }), DEBOUNCE_MS)
    return () => clearTimeout(timer)      // 每次键入都重排：只有停手 200ms 的那一次会落定
  }, [q, kw])

  // Ctrl/Cmd+F 信号（WorkShell 在知识 rail 下发出，见其 keydown 注释）。
  // 视图切过来时本组件还没挂载，故发送方用下一帧派发；这里只负责"收到就聚焦并全选"。
  useEffect(() => {
    const focus = () => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.select()   // 全选：连按两次 Ctrl+F 的人通常是想换词重搜
    }
    window.addEventListener(KB_FOCUS_SEARCH_EVENT, focus)
    return () => window.removeEventListener(KB_FOCUS_SEARCH_EVENT, focus)
  }, [])

  const keywords = useMemo(() => parseKeywords(settled.kw), [settled.kw])
  const params = useMemo<KnowledgeSearchParams>(() => ({
    q: settled.q,
    keywords,
    topK: TOP_K,
    // 「全部空间」= 不发 spaces 参数（空数组的正确表达是"不发"，见 knowledgeApi 的 csv 注释）
    spaces: allSpaces || !spaceId ? undefined : [spaceId],
    // 全文模式（批次 1）：只有用户显式打开才要整段；缺省走 snippet（预算友好）
    mode: fullText ? 'full' : undefined,
  }), [settled.q, keywords, allSpaces, spaceId, fullText])

  const { data, loading, error } = useSearch(params)

  const items = useMemo(() => sortHits(data?.items ?? [], sort), [data, sort])
  const terms = useMemo(() => searchTerms(settled.q, keywords), [settled.q, keywords])
  const top = useMemo(() => maxScore(items), [items])
  // 命中总数 vs 返回条数（批次 1）：老内核不返回 total → 降级成 count（不显示"命中 undefined"）
  const totalHits = data?.total ?? data?.count ?? 0
  const shown = data?.count ?? items.length

  const openHit = (it: KnowledgeSearchItem) => {
    const st = useKnowledgeStore.getState()
    st.setDocId(it.docId)          // ① 切文档（顺带清掉旧行号）
    st.setTargetLine(it.line)      // ② 再置行号——反了会被 setDocId 清掉，跳转失效
    st.setView('read')             // ③ 落到阅读视图（定位/高亮由它执行）
  }

  const searching = settled.q.trim() !== ''

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 检索条件区：查询框 + 关键词框 + 范围开关。三行而非一行——
          两个输入框在 236px 出头的中栏里挤在一行会各自只剩 60px 宽，中文看不出在输入什么 */}
      <div className="shrink-0 px-3 py-2 border-b border-default space-y-1.5">
        <Input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={t('knowledge.searchPlaceholder')}
          aria-label={t('knowledge.searchPlaceholder')}
          leftIcon={<Search className="w-3.5 h-3.5" />}
          // 覆盖 ui/input 的 h-9 与 rounded-md：本面板一律紧凑 + 切角
          className="h-7 clip-sm rounded-none text-[11px] pl-8"
        />
        {/* 输入过程中的算子提示（批次 3）：只在**查询里还没有可用的内核结果**（或结果出错）时显示。
            为什么要有：`tag:` / `path:` / `-` / `OR` 这些算子没有自动补全，用户不知道它们存在
            就等于没做；而打错一个字符（如写成 `tags:` 之外的自造字段）会静默回落成文本搜索。
            结果回来之后一律以内核回带的 `query` 元信息为准（见 activeQueryChips 的注释）。 */}
        {q.trim() !== '' && <QueryHintRow raw={q} />}
        <Input
          value={kw}
          onChange={e => setKw(e.target.value)}
          placeholder={t('knowledge.searchKeywords')}
          aria-label={t('knowledge.searchKeywords')}
          className="h-7 clip-sm rounded-none text-[11px]"
        />
        <div className="flex items-center gap-1.5">
          <KnowledgeScopeToggle all={allSpaces} onChange={setAllSpaces} />
          {/* 排序（批次 1）：单键循环而不是下拉——236px 的中栏里塞三选项下拉会把范围开关挤没。
              键面显示**当前**模式（不是"排序"二字），一眼可知当前按什么排。 */}
          <button
            type="button"
            onClick={() => setSort(prev => (prev === 'relevance' ? 'title' : prev === 'title' ? 'line' : 'relevance'))}
            title={t('knowledge.searchSortTooltip', { n: shown })}
            className="shrink-0 text-[10px] px-1.5 h-5 clip-sm bg-elevated text-secondary hover:text-primary transition-colors"
          >
            {t(sort === 'relevance' ? 'knowledge.searchSortRelevance' : sort === 'title' ? 'knowledge.searchSortTitle' : 'knowledge.searchSortLine')}
          </button>
          {/* 全文开关（批次 1）：默认关，开了才让内核回整段（`mode=full`） */}
          <button
            type="button"
            onClick={() => setFullText(v => !v)}
            aria-pressed={fullText}
            title={t('knowledge.searchFullTooltip')}
            className={cn(
              'shrink-0 text-[10px] px-1.5 h-5 clip-sm transition-colors',
              fullText ? 'bg-brand-500 text-inverse' : 'bg-elevated text-secondary hover:text-primary',
            )}
          >
            {t('knowledge.searchFull')}
          </button>
          <span className="flex-1 min-w-0" />
          {/* 解析失败（批次 3）：必须显眼且**不能**退化成"0 条结果"。
              用户写 `/[/` 时，静默当文本搜会给出语义完全不同的结果，当成 0 条则会被读成
              "库里没有"——两种都让用户对着错误前提做判断。这里直接说出失败原因。 */}
          {data?.queryError && (
            <span className="text-[10px] text-error shrink-0 max-w-[60%] truncate" title={data.queryError}>
              {t('knowledge.queryError')}
            </span>
          )}
          {/* 降级微标：向量路被跳过（查询 gram 全落空），结果只来自关键词路 */}
          {data?.degraded === true && (
            <span className="micro shrink-0" title={t('knowledge.degradedHint')}>{t('knowledge.indexDegraded')}</span>
          )}
          {searching && !loading && data && (
            <span className="micro shrink-0" title={t('knowledge.searchTotalHint')}>
              {/* total > count 时才提"显示 N 条"：两者相等时说两遍同一个数字只是噪音 */}
              {totalHits > shown
                ? t('knowledge.searchTotal', { total: totalHits, n: shown })
                : t('knowledge.searchCount', { n: shown })}
            </span>
          )}
        </div>
        {/* 已生效算子回显（批次 3）：用**内核回带的** `query` 元信息，不用本地解析结果 ——
            本地那份只用于输入提示；显示"生效的算子"必须以实际执行为准，否则两份实现漂移时
            用户会看到"UI 说生效了、结果却没按它过滤"（最难排查的一类不一致）。
            否定/严格模式额外标出来：结果变少时，这是用户唯一能看到的解释。 */}
        {searching && data?.query && (activeQueryChips(data.query).length > 0 || data.query.strict) && (
          <div className="flex items-center gap-1 flex-wrap pt-0.5">
            {activeQueryChips(data.query).map(c => (
              <span key={c} className="text-[10px] px-1.5 h-4 inline-flex items-center clip-sm bg-elevated text-secondary">
                {c}
              </span>
            ))}
            {data.query.strict && (
              <span className="text-[10px] px-1.5 h-4 inline-flex items-center clip-sm bg-elevated text-secondary"
                title={t('knowledge.queryStrictHint')}>
                {t('knowledge.queryStrict')}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <KnowledgeEmpty title={t('knowledge.loadFailed')} hint={error} className="!py-6" />
        ) : !searching ? (
          <KnowledgeEmpty title={t('knowledge.searchHint')} className="!py-6" />
        ) : loading && !items.length ? (
          <KnowledgeSkeleton lines={6} />
        ) : !items.length ? (
          <KnowledgeEmpty title={t('knowledge.searchEmpty')} className="!py-6" />
        ) : (
          <div className="py-1">
            {items.map(it => <HitRow key={it.blockId} item={it} terms={terms} max={top} onOpen={openHit} />)}
          </div>
        )}
      </div>
    </div>
  )
}

/** 一行命中：doc 标题 + 命中位置（line / 小节标题）+ 相关度色条 + 高亮 snippet */
function HitRow({ item, terms, max, onOpen }: {
  item: KnowledgeSearchItem
  terms: string[]
  max: number
  onOpen: (it: KnowledgeSearchItem) => void
}) {
  const { t } = useTranslation()
  const level = strengthLevel(item.score, max)
  const title = item.title || item.docId
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      title={`${item.docId}:${item.line}`}
      className="w-full text-left px-3 py-1.5 hover:bg-hover transition-colors"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <FileText className="w-3 h-3 shrink-0 text-tertiary" />
        <span className="text-[11px] text-primary truncate">{title}</span>
        {item.heading && <span className="text-[10px] text-tertiary truncate shrink-0 max-w-[40%]">{item.heading}</span>}
        {/* 标签命中（2026-09-14 批次 1）：这条结果的证据是"文档带了这个标签"，不是正文里
            出现过这个词（`tagHit` 由内核给出）。必须显式标出来——否则用户看到一段与查询词
            无关的 snippet（标签命中的锚点块往往是标题），会以为检索坏了。 */}
        {item.tagHit && (
          <span className="clip-sm bg-elevated px-1 text-[9px] text-tertiary shrink-0" title={t('knowledge.tagHitTooltip')}>
            #{item.tagHit}
          </span>
        )}
        <span className="flex-1 min-w-0" />
        {/* 强弱：三格色条。列名用 aria-label 说明，色条本身 aria-hidden（装饰性） */}
        <span className="flex items-center gap-[2px] shrink-0" title={t('knowledge.relevance')} aria-label={t('knowledge.relevance')}>
          {[1, 2, 3].map(i => (
            <span key={i} className={cn('w-[3px] h-2', i <= level ? 'bg-brand-500' : 'bg-elevated')} />
          ))}
        </span>
        <span className="text-[10px] text-tertiary tabular-nums shrink-0">L{item.line}</span>
      </div>
      <p className="mt-0.5 text-[11px] text-secondary leading-relaxed line-clamp-2 break-words [overflow-wrap:anywhere]">
        {splitHighlight(item.snippet, terms).map((c, i) => (
          // 片段位置即 key（同一段文本可重复出现，用下标才是稳定标识）
          c.hit
            ? <mark key={i} className="bg-accent-subtle text-primary rounded-[2px]">{c.text}</mark>
            : <span key={i}>{c.text}</span>
        ))}
      </p>
    </button>
  )
}
