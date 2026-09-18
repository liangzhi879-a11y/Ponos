// kernel/knowledge-search.mjs —— KnowledgeSearch 工具的检索实现
// ---------------------------------------------------------------------------
// 与 MemorySearch 的关系：MemorySearch 是 S1 之前的条目级检索（每次全量读文件 + 全量
// 现算向量，O(N)）；KnowledgeSearch 走已建好的倒排索引，O(命中量)。S1 阶段两者并存
// （S3 才做收敛），但**接口语义对齐**：同样返回条目清单 + 文件路径供 Read 追全文。
//
// 同步契约：run() 不返回 Promise，故这里全程同步——store.load() 是同步函数（Task 6
// 的契约，内部无任何 await），此处**不写 await**。
import { createKnowledgeStore } from './knowledge.mjs'
import { makeSnippet, isBlockId } from '../shared/knowledge-core.mjs'

/**
 * 结构化检索（S3 §4.2 起为 KnowledgeSearch / MemorySearch 两个工具**共用的唯一入口**）。
 * 为什么要抽这一层：两个工具的差别只是"怎么渲染"，检索口径必须一字不差——若各写一份
 * createKnowledgeStore + search，任何评分/过滤调整都会变成"两处改、漏一处"的隐患。
 * 永不抛异常：失败折成 `{ ok: false, error }`，让调用方各自决定降级文案。
 */
export function searchKnowledgeItems({
  configDir, query, keywords = [], spaces = null, topK = 5, mode = 'snippet', offset = 0,
} = {}) {
  const q = String(query || '').trim()
  const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean)
  if (!q && !kws.length) return { ok: true, items: [], count: 0, total: 0, offset: 0, indexAge: null, spaces: [], missingQuery: true }
  try {
    const store = createKnowledgeStore({ configDir })
    store.load({})
    const r = store.search({ query: q, keywords: kws, spaces, topK, mode, offset })
    // spaces 一并返回：调用方要据 spaceId → root 拼出**可用于 Read 的绝对路径**
    // （工具回执给相对 docId 的话，模型拿它 Read 会直接失败）。
    // total/offset（P2）：调用方据此拼"还有 N 条，续看 offset=M" —— 只回 count 的话，
    // 模型不知道"是只有 5 条"还是"是 300 条里的 5 条"，也就不会去翻页。
    return {
      ok: true, items: r.items, count: r.count, total: r.total ?? r.count,
      offset: r.offset ?? 0, indexAge: r.indexAge, spaces: store.getSpaces(),
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e), items: [], count: 0, indexAge: null, spaces: [] }
  }
}

/**
 * 空间 id → 物理根（`store.getSpaces()` 的产物）。**绝不猜路径**：找不到就返回 null，
 * 回执宁可少给一句，也不给一个可能不存在的路径（模型会照着它 Read 到"路径不存在"）。
 */
function rootOfSpace(spaces, id) {
  const s = (Array.isArray(spaces) ? spaces : []).find((x) => x && String(x.id) === String(id))
  return s?.root ? String(s.root) : null
}

/**
 * 命中后的"全文怎么取"引导（P3，2026-09-20 文案收口）。
 *
 * **why 必须分支**：Read 只对**放行了目录**的空间可用，而放行与否由上层按会话授权算
 * （`kernel/tools.mjs` 的"只读边界"块：只有本会话知识范围内的空间根才进只读白名单）。
 * 旧文案无条件说"需全文用 Read 读对应文件行"，于是模型对未放行的空间照做，只会撞
 * "拒绝访问：路径超出会话目录边界"——白烧一轮，还得不到正确做法（本仓库既有教训：
 * 无权限的指引必须写明替代路径）。
 *
 * `readableSpaces` 三态：`Set` = 该会话确实放行了这些空间（据实分支）；`null` = 调用方没给
 * 可读性信息（嵌入/测试/旧调用方）⇒ **不加任何引导**，回执与改造前逐字一致（零回归）。
 * 长度纪律：这是每次工具调用都要付的固定成本，故只加一行，且空间根最多列 3 个。
 */
function fullTextHint(spaceIds, { readableSpaces, spaces }) {
  if (!(readableSpaces instanceof Set)) return ''
  const ids = [...new Set(spaceIds.filter(Boolean).map(String))]
  if (!ids.length) return ''
  const unread = ids.filter((s) => !readableSpaces.has(s))
  const readable = ids.filter((s) => readableSpaces.has(s))
  const roots = readable.map((s) => { const r = rootOfSpace(spaces, s); return r ? `${s}=${r}` : null }).filter(Boolean)
  const rootTxt = roots.length
    ? `（空间根：${roots.slice(0, 3).join('；')}${roots.length > 3 ? ` 等 ${roots.length} 个` : ''}）`
    : ''
  const readTip = `用 Read 打开上列文件（路径 = 空间根/<docId 去掉「空间id/」前缀>，行号见括号）${rootTxt}`
  const fullTip = `空间「${unread.join('、')}」本会话不可 Read：需全文请用 mode:'full' 重试，或用 related 展开一跳`
  if (!unread.length) return `\n（需全文：${readTip}）`
  // 顺带说明"哪些照常可读"：否则同一份回执里两类空间混排时，模型会以为全都不许 Read。
  return `\n（${readable.length ? `${fullTip}；可读空间照常${readTip}` : fullTip}）`
}

export function searchKnowledge({
  configDir, query, keywords = [], spaces = null, topK = 5, mode = 'snippet', readableSpaces = null,
  offset = 0,
} = {}) {
  const q = String(query || '').trim()
  const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean)
  if (!q && !kws.length) {
    return { content: 'query 参数缺失：请描述想检索的知识主题', isError: true }
  }
  const qtext = q || kws.join(' ')
  const r = searchKnowledgeItems({ configDir, query: q, keywords: kws, spaces, topK, mode, offset })
  if (!r.ok) {
    // 检索失败不能变成会话阻断：降级为"无命中"提示（isError 保持 false——工具自身
    // 故障不该让模型以为整个会话出错了）。
    return { content: `知识库检索暂不可用（${r.error}）。可直接用 Read 打开记忆文件。`, isError: false }
  }
  if (!r.count) {
    return {
      content: `知识库无「${qtext}」相关命中。可换关键词，或确认该主题尚未沉淀过内容。`,
      isError: false,
    }
  }
  const lines = r.items.map((it) => {
    // 来源一律用**完整 docId**（= `spaceId/relPath`），Heading 与行号齐备：
    // 模型据 docId 的 relPath 就能 Read 到原文，不必自己拼空间前缀。
    const where = `${it.docId}${it.heading ? ` › ${it.heading}` : ''} · 第 ${it.line} 行`
    // P2 可解释回执：给出"为什么返回这条"的**命中词**。来源材料三次强调这是词法检索对
    // 模型的独特价值（字面匹配让模型能理解并据此改写查询）——只回一个分数等于把它扔掉。
    // 有硬预算（≤4 个词、每词 ≤12 字）：回执是每次工具调用的固定成本，不能让"命中词"
    // 变成第二个内容字段。legacy 打分器没有 `hits`（为 null）→ 这段为空，回执与改造前一致。
    const hit = Array.isArray(it.hits) && it.hits.length
      ? ` · 命中「${it.hits.slice(0, 4).map((h) => String(h).slice(0, 12)).join(' ')}」`
      : ''
    return `- [${where}] (${it.score.toFixed(2)}${hit}) ${makeSnippet(it.snippet, { maxLen: 300 })}`
  })
  // P2 分页续看：只在"确实还有下一批"或"已在后续页"时说明。模型此前只看到 count，
  // 无法区分"只有 5 条"与"是 300 条里的 5 条"，于是既不会翻页、也想不到换词
  // —— 来源材料的 surfaced/previewed 区分正是这个（瓶颈常在"看到却没读"）。
  const off = r.offset ?? 0
  const total = r.total ?? r.count
  const more = total > off + r.count
    ? `\n（本页 ${off + 1}-${off + r.count} / 共 ${total} 条命中；续看下一页：offset=${off + r.count}）`
    : (off > 0 ? `\n（本页 ${off + 1}-${off + r.count} / 共 ${total} 条命中：已是最后一批）` : '')
  return {
    content: `【相关知识检索】${r.count} 条命中（${new Set(r.items.map((i) => i.docId)).size} 篇文档）：
${lines.join('\n')}${fullTextHint(r.items.map((i) => i.spaceId), { readableSpaces, spaces: r.spaces })}${more}`,
    isError: false,
  }
}

// ── S5 Task 10：`related` 参数（给定 blockId 展开**一跳**锚点）────────────────────
/**
 * 一跳展开的条数上限。
 *
 * **why 5，而不是复用注入侧的 3 或内核的 MAX_RELATED(8)**：
 *   - 注入侧取 3 是因为那是**每次请求**都要付的固定成本；本工具是模型**主动发起的一次**调用，
 *     可以略宽——模型想要"多几条候选路径"时不该被迫连调好几次；
 *   - 但必须**明显小于 8**：模型极易把返回的 blockId 再喂回来继续展开，露出条数就是链式膨胀的
 *     底数（连展开 3 跳 = 5³ 条）。5 在"够选"与"抗链式膨胀"之间取平衡，且与骨架层/覆盖层各自的
 *     上限 `MAX_TAG_RELATED`/`MAX_CONTENT_RELATED`（都是 5）同阶，便于解释；
 *   - `duplicate` 不占该预算（内核 `getRelated` 口径，spec §5.5）：疑似重复要在 agent 侧
 *     **独立**呈现，不能被关联预算饿死。
 */
export const RELATED_EXPAND_LIMIT = 5

/** 锚点的理由文案（tag 给标签值；content/duplicate 给分数）。与注入层的紧凑写法**有意不同**：
 *  这里是"一行一条"，不必像注入层那样把多条挤成一行。只读 `why`/`score`，绝不取正文。 */
function whyLabel(x) {
  const why = x?.why
  if (why?.kind === 'tag') return `同标签:${why.tag}`
  if (why?.kind === 'duplicate') return `疑似重复（同一份内容，不用重复读）`
  if (why?.kind === 'content') return `内容相似${typeof x.score === 'number' ? x.score.toFixed(2) : ''}`
  return String(why?.kind ?? '未知')
}

/**
 * 一跳展开的数据层：`blockId → getRelated(blockId, {validate, limit})`。
 *
 * **只一跳**：这里只调一次 `getRelated`，**绝不**对返回的锚点再展开（spec §7.6 明确"不自动多跳"）。
 * 多跳自动扩散会让一次工具调用变成不可控的上下文成本（而且模型的兴趣点会漂移）。
 *
 * `exists` 与 `related` 分开报：both「blockId 写错」与「条目确实孤立」都表现为空数组，
 * 但给模型的下一步动作完全不同（前者去重新检索拿 id，后者换关键词/换角度）。
 */
export function expandRelatedItems({ configDir, blockId, limit = RELATED_EXPAND_LIMIT } = {}) {
  const id = String(blockId || '').trim()
  if (!id) return { ok: true, blockId: '', related: [], count: 0, exists: false, missingBlockId: true }
  try {
    const store = createKnowledgeStore({ configDir })
    store.load({})
    // 块号取**最后**一个 `#` 之后的部分（docId 自身可能含 `#`，见 shared 的 isBlockId）；
    // 形状校验复用 shared 的 isBlockId，不在这里自造一套切法（少一处口径就少一处漂移）。
    const exists = isBlockId(id) && Boolean(
      store.getDoc(id.slice(0, id.lastIndexOf('#')))
        ?.blocks?.some((b) => b.n === Number(id.slice(id.lastIndexOf('#') + 1))),
    )
    const related = store.getRelated(id, { validate: true, limit })
    // `spaces` 与 searchKnowledgeItems 同一理由（P3）：调用方要据 spaceId → 根判断"该空间
    // 能否 Read"，再把回执里的全文引导分成两条路。多带一个字段、不改既有字段。
    return { ok: true, blockId: id, related, count: related.length, exists, spaces: store.getSpaces() }
  } catch (e) {
    // 与 searchKnowledge 同一纪律：检索侧故障不打断会话，折成 ok:false 让调用方降级
    return { ok: false, error: e?.message || String(e), blockId: id, related: [], count: 0, exists: false, spaces: [] }
  }
}

/**
 * 一跳展开的渲染层（`KnowledgeSearch` 的 `related` 参数）。
 * 回执只给 **blockId + 标题 + 理由**：要正文让模型自己 Read（`docId` 就在 blockId 里）——
 * 把正文预装进来等于让"展开一跳"变成"再注入一遍全文"。
 *
 * 尾句按**该空间能否 Read**分支（P3 文案收口，与 searchKnowledge 的 fullTextHint 同一判据）：
 * 无条件说"需正文用 Read"会把模型推向"拒绝访问：路径超出会话目录边界"。
 * `readableSpaces === null`（调用方未给可读性）⇒ 保留原措辞，零回归。
 */
export function expandRelated({ configDir, blockId, limit = RELATED_EXPAND_LIMIT, readableSpaces = null } = {}) {
  const r = expandRelatedItems({ configDir, blockId, limit })
  if (r.missingBlockId) {
    return { content: 'related 参数缺失：请给出要展开的 blockId（形如 experience/workflow.md#2，取自命中行的括号内）', isError: true }
  }
  if (!r.ok) {
    return { content: `知识库关联暂不可用（${r.error}）。可直接用 Read 打开记忆文件。`, isError: false }
  }
  if (!r.exists) {
    return {
      content: `未找到条目「${r.blockId}」：blockId 需为「文件#块号」形态，且该块仍在索引中。先用 query 检索一次，拿最新回执里的 blockId。`,
      isError: false,
    }
  }
  if (!r.count) {
    return {
      content: `条目「${r.blockId}」暂无关联锚点（关联在入库时派生：孤立条目没有可继续阅读的路径）。可换个关键词用 query 检索。`,
      isError: false,
    }
  }
  const lines = r.related.map((x) => `- [${x.blockId}]${x.title ? `「${x.title}」` : ''} ${whyLabel(x)}`)
  // blockId 形状 `<spaceId>/<relPath>#<n>` ⇒ 首个 `/` 之前即空间 id（越界判定同款切法）。
  const spaceId = String(r.blockId).split('/')[0]
  const canRead = !(readableSpaces instanceof Set) || readableSpaces.has(spaceId)
  const tail = canRead
    ? `需正文用 Read 打开对应文件${readableSpaces instanceof Set ? `（空间根 ${rootOfSpace(r.spaces, spaceId) || '见该空间根目录'}）` : ''}，不再自动多跳`
    : `该空间「${spaceId}」本会话不可 Read：需正文请用 query + mode:'full' 取整块原文，不再自动多跳`
  return {
    content: `【一跳关联】「${r.blockId}」可继续阅读 ${r.count} 条（已按关联强度排序，最多 ${limit} 条；只给位置与理由，${tail}）：
${lines.join('\n')}`,
    isError: false,
  }
}
