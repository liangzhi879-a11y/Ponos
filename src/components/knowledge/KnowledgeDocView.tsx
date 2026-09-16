// src/components/knowledge/KnowledgeDocView.tsx —— 阅读视图（S2 Task 5）
//
// 正文**不**整篇丢给 react-markdown，而是按 `/doc` 的 blocks 分段渲染（见 lib/knowledgeBlocks.ts
// 文件头：块里才有 kind/tag/line）：经验条目 → 卡片、heading → 自带锚点的标题、其余 → markdown。
// markdown 渲染复用 src/components/chat/MarkdownText.tsx 导出的 MD_PLUGINS/MD_COMPONENTS
// （spec §11.1：已导出，勿重造）。
//
// 注意 components 表**必须是模块级稳定引用**：MarkdownText.tsx 头部注释记着那起事故——
// 每渲染新建 `{...MD_COMPONENTS}` 会让 react-markdown 整棵子树重挂载（输入抖动、滚动跳动）。
// 故 KB_COMPONENTS 在模块顶层建好，只补一个 p（默认表没有 p 规则，段落会吃浏览器 1em 边距）。
//
// 行定位：接收 targetLine（来自 knowledgeStore，检索命中/大纲点击时置入）→ 用 pickTargetIndex
// 找到落点块 → scrollIntoView + 高亮 1.5s（spec §6「滚动到 line 并高亮 1.5s」）。
// 高亮只用 token 底色 bg-accent-subtle + clip-sm 轮廓，**不动光效白名单**（`.breath` 等留给激活态）。
//
// S5 Task 9 增**块级**定位（targetBlockId）：关联锚点只带 blockId（内核 relSummary 的字段集合
// 被 spec §7.2 钉死，不许为跳转方便加 line），故按块匹配渲染项 —— 同样零额外请求，复用下面
// 同一套 scrollIntoView + 高亮。两条通道共用 targetIndex，故高亮/滚动只有一份实现。
// 关联锚点数据在这里**按文档一次**拉取（useRelatedDoc），再按 blockId 分发给条目卡片：
// 卡片自己拉会变成"每张卡一次内核进程"，见内核 getRelatedForDoc 的 why。
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Trash2 } from 'lucide-react'
import type { KnowledgeDoc } from '@/lib/knowledgeApi'
import { useTranslation } from '@/i18n/useTranslation'
import { MD_COMPONENTS, MD_PLUGINS } from '@/components/chat/MarkdownText'
import {
  normalizeTags, pickTargetIndex, pickTargetIndexByBlock, planBlockRender,
  resolveAnchorIndex, wikiTargetCandidates, type BlockLike,
} from '@/lib/knowledgeBlocks'
import { indexByBlock } from '@/lib/knowledgeRelations'
import type { KnowledgeRelatedAnchor } from '@/lib/knowledgeApi'
import { useLinks, useRelatedDoc } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { cn } from '@/lib/utils'
import { KnowledgeEntryCard } from './KnowledgeEntryCard'
import { KnowledgeEmpty } from './KnowledgeEmpty'
import { WikiA, WikiLi, WikiLinkProvider, WikiP } from './KnowledgeWikiText'

/** 高亮持续时间；spec §6 定 1.5s（够看清落点又不会一直亮着干扰阅读） */
const HIGHLIGHT_MS = 1500

/**
 * 阅读视图的 markdown 组件表（**模块级稳定引用**，见文件头）。
 * p / li 补内链与紧凑样式（MD_COMPONENTS 原本没有这两条规则）；a 做站内/站外分流。
 */
const KB_COMPONENTS: Components = { ...MD_COMPONENTS, p: WikiP, li: WikiLi, a: WikiA }

/** 标题级别 → 视觉规格（h1-h3 与 MD_COMPONENTS 的 h1-h3 对齐；h4+ 降为小节样式） */
const HEADING_CLASS: Record<number, string> = {
  1: 'text-lg font-bold text-primary mt-4 mb-2',
  2: 'text-base font-bold text-primary mt-3 mb-1.5',
  3: 'text-sm font-semibold text-primary mt-2 mb-1',
}

export interface KnowledgeDocViewProps {
  doc: KnowledgeDoc
  /** 目标行号（knowledgeStore.targetLine）；null = 不做定位 */
  targetLine?: number | null
  /** 目标块 id（knowledgeStore.targetBlockId，关联锚点跳转）；给了就优先按块定位 */
  targetBlockId?: string | null
  /**
   * 目标**锚点**（knowledgeStore.targetAnchor，2026-09-14 批次 2）：`[[note#小节]]` 点的跳转。
   * 三级定位优先级：块 id（最确定）> 锚点 > 行号。三者互斥由 store 保证（每个写入路径都清另外两个）。
   */
  targetAnchor?: { anchorRef: string; anchorKind: 'heading' | 'block' | '' } | null
  /**
   * 删除此文档（2026-09-14）。**为 null 时不画删除按钮** —— 权限判定（知识包只读）
   * 由宿主按空间 `source` 决定并决定给不给这个回调。本视图刻意**不碰**权限逻辑：
   * 它拿不到空间对象，为了画个按钮去拉一次空间列表等于凭空多一个内核进程。
   */
  onDelete?: (() => void) | null
}

export function KnowledgeDocView({ doc, targetLine = null, targetBlockId = null, targetAnchor = null, onDelete = null }: KnowledgeDocViewProps) {
  const { t } = useTranslation()
  // docId 下传是为了让条目渲染项带上 blockId（锚点定位的键）；不给 docId 时渲染计划与 S2 逐字相同
  const renders = useMemo(() => planBlockRender(doc.blocks, doc.id), [doc.blocks, doc.id])
  const tags = useMemo(() => normalizeTags(doc.tags), [doc.tags])
  const { data: relatedBlocks } = useRelatedDoc(doc.id)
  const anchorsByBlock = useMemo(() => indexByBlock(relatedBlocks), [relatedBlocks])
  // 块级通道优先：store 的 openAtBlock 会同时清掉 targetLine，故正常不会两者都非空
  const targetIndex = useMemo(
    () => (pickTargetIndexByBlock(renders, targetBlockId) ?? pickTargetIndex(renders, targetLine)),
    [renders, targetLine, targetBlockId],
  )

  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeLine, setActiveLine] = useState<number | null>(null)

  // 换文档把阅读位置归零：滚动容器是同一个 DOM 节点，不显式重置会留着上一篇的滚动位置
  // （表现为"点开新文档却停在中段"）。本 effect 声明在定位 effect 之前，故定位总是最后生效。
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [doc.id])

  useEffect(() => {
    // 目标变了（或无目标）先把上一次的高亮清掉：否则连点两条检索结果会同时亮两块
    setActiveLine(null)
    if (targetIndex === null) return
    const el = itemRefs.current[targetIndex]
    if (!el) return
    el.scrollIntoView({ block: 'center' })   // 最近可滚动祖先是本视图的正文容器
    setActiveLine(renders[targetIndex].line)
    const timer = setTimeout(() => setActiveLine(null), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [targetIndex, renders])

  /**
   * 内链锚点定位（2026-09-14 批次 2）：`[[note#安装步骤]]` / `[[#小节]]` 点了之后落到"那一节"。
   *
   * 数据源是**本视图已有的** `doc.blocks`（标题文本、块 ID 都在里面），故这条路径**零额外请求**——
   * 与 targetBlockId 的定位同一思路。锚点原文 → 块下标由 `resolveAnchorIndex` 完成（归一化匹配）。
   *
   * 解析不到时**如实提示**（顶部一行提示），不做"悄悄跳到文档开头"：那会让用户以为锚点生效了，
   * 而每次点都落在同一处、还查不出原因（目标文档里那个标题可能已被改名）。
   * 提示 4 秒后自动消失 —— 它是解释性信息，不需要用户手动关。
   */
  const anchorBlocks = useMemo<BlockLike[]>(
    () => (doc.blocks ?? []).map((b) => ({ kind: b.kind, level: b.level, text: b.text, line: b.line })),
    [doc.blocks],
  )
  const [anchorMiss, setAnchorMiss] = useState<string | null>(null)
  const anchorIndex = useMemo(
    () => (targetAnchor ? resolveAnchorIndex(anchorBlocks, targetAnchor.anchorRef, targetAnchor.anchorKind) : null),
    [targetAnchor, anchorBlocks],
  )

  useEffect(() => {
    if (!targetAnchor) { setAnchorMiss(null); return }
    if (anchorIndex === null) {
      // 写错了 / 标题被改名 / 块 ID 不存在 —— 都在这条分支上。提示是"解释"，不是"报错"。
      setAnchorMiss(targetAnchor.anchorRef)
      return
    }
    setAnchorMiss(null)
    const el = itemRefs.current[anchorIndex]
    if (!el) return
    el.scrollIntoView({ block: 'start' })   // 锚点跳到"那一节"：靠顶（center 会把标题之外的内容也居中，读起来找不到节首）
    setActiveLine(renders[anchorIndex]?.line ?? null)
    const timer = setTimeout(() => setActiveLine(null), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [targetAnchor, anchorIndex, renders])

  // 锚点提示自动消失（4s）：它是解释性信息，不需要用户手动关。
  useEffect(() => {
    if (!anchorMiss) return
    const timer = setTimeout(() => setAnchorMiss(null), 4000)
    return () => clearTimeout(timer)
  }, [anchorMiss])

  // 点锚点 = 打开目标文档 + 切阅读视图 + 按块定位，三件事一次写完（store.openAtBlock）。
  // 本视图**不开第二条跳转通道**：偏移/高亮逻辑只有上面那一个 effect。
  const openAnchor = (a: KnowledgeRelatedAnchor) => useKnowledgeStore.getState().openAtBlock(a.docId, a.blockId)

  // 内链（`[[x]]` / 相对 .md）的解析（2026-09-14 批次 1）：
  // 数据源是**本已存在**的 `/knowledge/links`（阅读视图为了画反链本来就要拉它，见 useLinks），
  // 所以这里加内链**不额外产生任何内核进程**——这一点决定了它能不能做：若为跳转再拉一次
  // 全库链接表，就是每开一篇文档多一个 50–70MB 的子进程。
  // 出边里 `to` 是**原文目标**、`target` 才是解析后的 docId（断链为 null），故用候选比对
  // （候选顺序与内核 resolveLinkTarget 一致，见 lib/knowledgeBlocks.wikiTargetCandidates）。
  const { data: links } = useLinks(doc.id)
  const wikiResolver = useMemo(() => {
    const byTo = new Map<string, string>()
    for (const e of links?.out ?? []) {
      if (e.target) byTo.set(e.to, e.target)
    }
    return {
      // `opts.self` = 同文档锚点 `[[#小节]]`（批次 2）：目标就是本文档自身。
      // 不处理它的话这类链接会被判成断链（它的 target 是空串），文档内部的目录式跳转就全灰了。
      resolve: (target: string, opts?: { self?: boolean }): string | null => {
        if (opts?.self) return doc.id
        for (const cand of wikiTargetCandidates(target, doc.id)) {
          const hit = byTo.get(cand)
          if (hit) return hit
        }
        // 兜底：目标恰好就是本空间里的 docId（`[[a.md]]` 这种与 docId 同形的写法）
        // 也允许跳转。只在候选全落空时试，避免把"同名的另一篇"错认成目标。
        const direct = wikiTargetCandidates(target, doc.id).find((c) => c === target)
        return direct ? (byTo.get(direct) ?? null) : null
      },
      /**
       * 内链跳转（2026-09-14 批次 2 起带锚点）。
       *
       * 带锚点时走 `openAtAnchor`：打开目标文档 + 置锚点定位（由本视图的 effect 解析成块下标）。
       * **同文档锚点也走它** —— store 的 setDocId 对同值是 no-op，但 targetAnchor 会变，
       * 定位 effect 照常触发；且这样"文档内跳转"与"跨文档跳转"只有一条代码路径，
       * 不会出现"跨文档能用、本文档内不能用"这类半通状态。
       * 无锚点时保持旧行为（setTargetLine(null) + setDocId + 切 read）。
       */
      open: (docId: string, anchor?: { anchorRef: string; anchorKind: 'heading' | 'block' | '' }) => {
        const s = useKnowledgeStore.getState()
        if (anchor?.anchorRef) {
          s.openAtAnchor(docId, anchor.anchorRef, anchor.anchorKind)
          return
        }
        // 内链跳转 = 换文档 + 清定位 + 回阅读视图。**按 store 的既有语义分两步**（openAtBlock
        // 是给"带块定位"的跳转用的，内链没有块信息，不该复用）：
        // setDocId 内部已清 targetLine/targetBlockId/targetAnchor（见 store 注释：换文档必须清定位，
        // 否则上一篇的行号会错误地高亮新文档的同一行）。
        s.setTargetLine(null)
        s.setDocId(docId)
        s.setView('read')
      },
    }
  }, [links, doc.id])

  return (
    <WikiLinkProvider resolver={wikiResolver}>
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-4 py-3">
      <header>
        {/* 标题行右侧挂「删除此文档」：放在文档头部是因为用户要点删除时总是**正读着**这篇
            （从检索结果或树里进来），在头部比埋在别处少一次定位。onDelete 为 null
            （= 宿主判定不可删，如只读知识包）时整块不渲染 —— 不做"置灰的按钮"，
            置灰会让人以为要点什么才能解锁。 */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-primary truncate">{doc.title}</h2>
            <p className="mt-0.5 text-[10px] text-tertiary truncate">{doc.rel}</p>
          </div>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title={t('knowledge.deleteBtn')}
              className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-tertiary hover:text-error transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              {t('knowledge.deleteBtn')}
            </button>
          )}
        </div>
        {tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {/* 标签可点（2026-09-14 批次 1）：点了按这个标签去检索——原来只是静态 chip，
                用户在文档里看到标签却"无处可去"（要手抄到搜索框）。与标签视图走同一个入口
                （store.openSearchWithKeywords），保证两条路径的范围/口径一致。 */}
            {tags.map(tag => (
              <button
                key={tag}
                type="button"
                onClick={() => useKnowledgeStore.getState().openSearchWithKeywords([tag.replace(/^#/, '')])}
                title={t('knowledge.tagsHint')}
                className="clip-sm bg-elevated px-1.5 py-0.5 text-[10px] text-secondary hover:text-primary hover:bg-hover transition-colors"
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* 锚点未命中提示（2026-09-14 批次 2）：`[[note#某节]]` 点进来但标题不存在/已改名。
          如实说明**比静默跳到文档开头更好** —— 后者会让人以为锚点生效了，而每次点都落在同一处、
          还查不出原因。提示是解释性信息，4 秒后自动消失（见上面的 effect）。 */}
      {anchorMiss && (
        <div className="mt-2 clip-sm bg-elevated px-2 py-1 text-[10px] text-tertiary">
          {t('knowledge.anchorMissing', { ref: anchorMiss })}
        </div>
      )}

      <div className="mt-3">
        {renders.length === 0 ? (
          <KnowledgeEmpty title={t('knowledge.docEmpty')} className="!py-6" />
        ) : renders.map((r, i) => (
          <div
            key={r.key}
            ref={(el) => { itemRefs.current[i] = el }}
            data-line={r.line}
            className={cn(
              // clip-sm 只裁剪轮廓不改背景：高亮块用 token 底色，避免裸 hex / 光效
              'clip-sm -mx-2 px-2 transition-colors',
              activeLine === r.line && 'bg-accent-subtle',
            )}
          >
            {r.type === 'entryCard' ? (
              <div className="py-1">
                {/* 锚点数据按块分发；没锚点的卡片拿到空数组 → 卡片自己不渲染关联行（不留空壳） */}
                <KnowledgeEntryCard
                  tag={r.tag} summary={r.summary} full={r.full}
                  related={r.blockId ? anchorsByBlock.get(r.blockId) : undefined}
                  onOpenAnchor={openAnchor}
                />
              </div>
            ) : r.type === 'heading' ? (
              // 标题自己渲染（不再回填 `# ` 交给 markdown）：级别已知、锚点可控，
              // 右栏大纲（Task 9）与检索跳转都依赖这里的 data-line
              createHeading(r.level, r.text)
            ) : (
              <ReactMarkdown remarkPlugins={MD_PLUGINS} components={KB_COMPONENTS}>{r.text}</ReactMarkdown>
            )}
          </div>
        ))}
      </div>
    </div>
    </WikiLinkProvider>
  )
}

/** 按级别出标签（h1-h6）；class 用查表，h4+ 回落小节样式 */
function createHeading(level: number, text: string) {
  const L = Math.min(Math.max(level, 1), 6)
  const Tag = `h${L}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  return <Tag className={HEADING_CLASS[L] ?? 'text-xs font-semibold text-secondary mt-2 mb-1'}>{text}</Tag>
}
