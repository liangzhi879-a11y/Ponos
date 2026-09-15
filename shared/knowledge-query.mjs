/**
 * 检索语法层（2026-09-14 对标 Obsidian 批次 3）。
 *
 * 纯函数、无 IO：把查询串解析成结构化查询对象，内核据此**先过滤、再打分**。
 * 前端另有一份手写同口径实现（`src/lib/knowledgeQuery.ts` —— 仓库约定前端不 import
 * `shared/*.mjs`），两份实现的行为一致性由同一组用例钉住。
 *
 * ## 语法（与 Obsidian 对齐的子集）
 *
 * ```
 * foo bar            两个词都要命中（AND）
 * "foo bar"          短语整体匹配（内部空格不拆词）
 * foo OR bar         任一词命中（OR 必须大写独立成词）
 * -foo               排除含 foo 的块（也可用于算子：-tag:草稿）
 * tag:财务           文档级：文档标签（容忍 # 前缀；前缀匹配）
 * path:reports/      文档级：空间内相对路径包含
 * file:周报          文档级：文件名（basename）包含
 * section:背景       块级：所在标题包含（heading: 为别名）
 * content:营收       块级：块正文包含（line: 为别名）
 * block:^a1b2        块级：块 id 包含
 * /\d{4}-\d{2}/      正则（/…/ 包裹，大小写不敏感）
 * ```
 *
 * ## 两个最关键的正确性决定
 *
 * ① **未知字段回落成普通文本**（见 `splitFieldToken`）。用户搜 `10:30`、`http://a.com`、
 *    `ratio 1:2` 时形如 `x:y` 的 token 到处都是；若"任何 `x:y` 都当字段"，这些查询会变成
 *    "字段 10 等于 30" → 搜不到任何东西且不报错，用户只会觉得搜索坏了。
 *
 * ② **无效正则必须报错**，不静默降级成子串匹配。用户写了 `/…/` 就是明确要正则，
 *    降级会给出"看起来能搜到、语义完全不同"的结果，比报错更难排查。
 *
 * ## 不做什么
 *
 * 不做 `\` 转义、不做括号分组、不做 `sort:` / `limit:` 之类的指令算子。理由：越靠近正则的
 * 转义规则越容易做出"用户以为自己写了 A、实际是 B"的歧义，而收益有限。括号分组同理 ——
 * 需要复杂逻辑时用户会分几次搜。这些若将来要加，应当先设计转义规则再实现。
 */

/**
 * 支持的字段算子。**只有列在这里的字段才是算子**，其余回落成普通关键词（见文件头 ①）。
 *
 *   tag     文档级：文档标签（容忍带 `#` 前缀，大小写不敏感，前缀匹配）
 *   path    文档级：空间内相对路径包含
 *   file    文档级：文件名（basename）包含
 *   section 块级：所在标题文本包含
 *   heading `section` 的别名（Obsidian 用 heading，习惯迁移）
 *   content 块级：块正文包含
 *   line    `content` 的别名（Obsidian 的 line: 语义就是"正文行"）
 *   block   块级：块 id（`^abc`）包含
 */
export const QUERY_FIELDS = Object.freeze([
  'tag', 'path', 'file', 'section', 'heading', 'content', 'line', 'block',
])

/** 文档级字段（过滤时看 doc）。内核与前端共用同一分界，避免两处口径漂移。 */
export const QUERY_DOC_FIELDS = Object.freeze(['tag', 'path', 'file'])
/** 块级字段（过滤时看 block） */
export const QUERY_BLOCK_FIELDS = Object.freeze(['section', 'heading', 'content', 'line', 'block'])

/** 字段别名 → 规范字段名 */
const FIELD_ALIAS = Object.freeze({
  tag: 'tag', tags: 'tag',
  path: 'path',
  file: 'file', filename: 'file',
  section: 'section', heading: 'section',
  content: 'content', line: 'content',
  block: 'block',
})

/** 单条查询串长度上限：超长串只可能是粘贴事故（几万字），解析它只会白烧 CPU */
const MAX_QUERY_LEN = 2000

/**
 * 把一个 token 拆成 `字段:值`。返回 null = "这不是字段算子，按普通文本处理"（见文件头 ①）。
 *
 * 判"不是算子"的三种情况：无冒号 / 冒号在首位或末位（`:x`、`x:` 都不像字段）/ 字段名不认识。
 */
function splitFieldToken(token) {
  const i = token.indexOf(':')
  if (i <= 0 || i === token.length - 1) return null
  const field = FIELD_ALIAS[token.slice(0, i).toLowerCase()]
  if (!field) return null                               // 未知字段 → 文本（文件头 ①）
  const value = token.slice(i + 1)
  if (!value) return null
  return { field, value }
}

/** 切词：把 `"…"` 与 `/…/` 当作整体取出，其余按空白切。引号/正则里的空格不拆。 */
function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }
    if (ch === '"') {
      const end = text.indexOf('"', i + 1)
      // 未闭合的引号：把余下全部当短语（比丢弃更符合意图 —— 他就是要搜这段）
      const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end)
      if (body) tokens.push({ kind: 'phrase', value: body })
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === '/') {
      // `/…/`：用**最后一个** `/` 收尾，这样 `/a/b/` 这类含斜杠的模式也能写
      const end = text.lastIndexOf('/')
      if (end > i) {
        const body = text.slice(i + 1, end)
        if (body) tokens.push({ kind: 'regex', value: body })
        i = end + 1
        continue
      }
    }
    let j = i
    while (j < text.length && !' \t\n\r'.includes(text[j])) j += 1
    tokens.push({ kind: 'word', value: text.slice(i, j) })
    i = j
  }
  return tokens
}

/**
 * 解析查询串。
 *
 * 返回 `{ ok, terms, phrases, regexes, filters, orGroups, filterOnly, error, hint }`：
 *   · `terms`      普通关键词（子串匹配，交给内核既有打分链）
 *   · `phrases`    短语（整体子串）
 *   · `regexes`    `{ value, re, negate }[]`（`re` 已编译；无效正则写成 `error` 而不是抛）
 *   · `filters`    `{ field, value, negate }[]`（保留出现顺序，便于解释与调试）
 *   · `orGroups`   有 `OR` 时的分组（每组内是"必须同时满足"的项）；无 OR 时为空数组
 *   · `filterOnly` 只有过滤条件、没有任何文本检索词 → 内核走"枚举匹配文档"而非打分
 *   · `error`      解析失败原因（无效正则 / 查询串过长）；`ok=false` 时调用方应提示用户
 *   · `hint`       出现过的算子字段（去重，保序）—— GUI 据此回显"哪些算子生效了"
 */
export function parseSearchQuery(raw) {
  const text = String(raw ?? '')
  const out = {
    ok: true, terms: [], phrases: [], regexes: [], filters: [], orGroups: [],
    filterOnly: false, error: null, hint: [],
  }
  if (text.length > MAX_QUERY_LEN) {
    // 不截断后继续跑：截断会让用户以为"搜的就是我粘的那段"，结果是另一段查询的结果（更难排查）
    out.ok = false
    out.error = `query-too-long: 查询串超过 ${MAX_QUERY_LEN} 字符（${text.length}），请缩小范围`
    return out
  }
  if (!text.trim()) return out

  const andParts = [[]]
  const pushTo = (part) => andParts[andParts.length - 1].push(part)

  for (const t of tokenize(text)) {
    // 独立词 `OR` 才分组。必须**全大写**：正文里的小写 `or` 太常见，
    // 当成算子会毁掉所有英文查询（"arm or leg" 会变成两个 OR 分组）。
    if (t.kind === 'word' && t.value === 'OR') {
      if (andParts[andParts.length - 1].length === 0) continue   // `OR foo` / `foo OR OR bar`：丢掉空组，不打断搜索
      andParts.push([])
      continue
    }
    let negate = false
    let value = t.value
    if (t.kind === 'word' && value.startsWith('-') && value.length > 1) {
      negate = true
      value = value.slice(1)
    }
    if (t.kind === 'phrase') { pushTo({ kind: 'phrase', value, negate }); continue }
    if (t.kind === 'regex') {
      try {
        // 不加 `g`/`y` 标志：带 `g` 的正则在多次 `test()` 之间会保留 `lastIndex`，
        // 同一个正则对象被复用时会**间隔性失配**（一半命中一半不命中，极难排查）。
        const re = new RegExp(value, 'i')
        pushTo({ kind: 'regex', value, re, negate })
        out.regexes.push({ value, re, negate })
      } catch (e) {
        // 无效正则必须报错，不静默降级成文本（文件头 ②）
        out.ok = false
        out.error = `bad-regex: ${String(e?.message ?? e)}（${value}）`
        return out
      }
      continue
    }
    const f = splitFieldToken(value)
    if (f) {
      pushTo({ kind: 'filter', field: f.field, value: f.value, negate })
      out.filters.push({ field: f.field, value: f.value, negate })
      if (!out.hint.includes(f.field)) out.hint.push(f.field)
      continue
    }
    pushTo({ kind: 'term', value, negate })
    if (!negate) out.terms.push(value)
  }

  // 丢掉空组（尾随 `OR`、连续 `OR`）
  const groups = andParts.filter((g) => g.length > 0)
  if (groups.length > 1) out.orGroups = groups
  // `parts`：**扁平的完整项列表**（含否定文本项）。
  // 为什么必须单独存一份：否定文本项（`-foo`）不进 `terms`（否则会被打分链当成"要命中的词"），
  // 而它在没有 `OR` 时**不落在任何 orGroups 里** —— 只看 terms/phrases/filters 就会把它整个丢掉，
  // 于是 `-foo bar` 的"排除 foo"静默失效（结果里照样出现 foo，用户以为否定语法不存在）。
  out.parts = groups.length > 1 ? groups.flat() : (groups[0] ?? [])
  for (const g of (groups.length ? groups : andParts)) {
    for (const p of g) if (p.kind === 'phrase' && !p.negate) out.phrases.push(p.value)
  }
  // `enumerate`：**没有可打分的文本，但有正向的可枚举依据** → 内核走"枚举匹配"而不是打分。
  //
  // 为什么需要它（而不是复用 filterOnly）：`enumerate` 是 `filterOnly` 的**超集**，
  // 还包含"只有正则"的查询（`/\d+%/`）。后者没有过滤条件，于是 `filterOnly=false`，
  // 但同样没有可向量化的文本 —— 实测这一步漏掉后，`/\d+%/` 这类纯正则查询会**静默返回空**
  // （既不报错也不给结果，用户完全无从判断是语法问题还是库里没有）。
  //
  // 为什么要求**正向**依据：纯否定查询（`-foo`、`-tag:x`、`-/\d+/`）没有命名任何集合，
  // 只在做减法。若把它们也当枚举，`-tag:x` 会返回"全库里所有不带该标签的文档"
  // （几千条，看起来像过滤没生效）；而 `-foo` 这种否定**词**在打分链里必然返回空 ——
  // 同一个"排除"意图因写法不同给出两种结果，是最容易被当成 bug 报上来的不一致。
  // 因此统一为：没有正向依据 ⇒ 无结果可给（内核返回空，由 UI 说明原因）。
  const positiveText = out.terms.length > 0 || out.phrases.length > 0
  const positiveFilter = out.filters.some((f) => !f.negate)
  const positiveRegex = out.regexes.some((r) => !r.negate)
  out.enumerate = !positiveText && (positiveFilter || positiveRegex)
  // `filterOnly`：枚举是**由过滤条件**驱动的（GUI 据此说明"没有检索词，按条件筛列文档"）。
  out.filterOnly = out.enumerate && out.filters.length > 0 && !positiveText
  // `strict`：用户**显式写了布尔逻辑**（`OR` 或否定项）→ 结果必须严格满足布尔语义。
  // 没写时**不启用**严格判定，保持既有打分链的"部分命中也能召回"行为不变。
  // 这条分界很重要：老查询 `季度 报告` 在当前实现下"只含季度"的块也能进结果（按相关度排序），
  // 一旦无条件改成 AND 语义，用户会突然发现结果变少而不知道为什么 —— 那是行为回退，不是修 bug。
  const hasNegText = groups.some((g) => g.some((p) => p.negate && p.kind !== 'filter'))
  out.strict = out.orGroups.length > 0 || hasNegText
  // `textQuery`：**剥掉算子后的纯文本**，交给向量化与关键词打分。
  // 必须剥：把 `tag:财务` 原样喂给 vectorizeText 会把 "tag:财务" 整串切 gram，污染倒排命中
  // （用户会看到"搜 tag:财务 却命中了一堆含 'tag' 的文档"）。过滤器只负责过滤，不参与打分。
  out.textQuery = [...out.terms, ...out.phrases].join(' ').trim()
  return out
}

/**
 * 块所属的**最近前置标题**（批次 3 修 `section:` 的关键）。
 *
 * 为什么不能只看块自己的文本：Markdown 里 `## 背景` 是**独立的一块**（kind='heading'），
 * 紧接着的正文块（`营收增长 30%`）文本里**没有**那行标题 —— 于是 `section:背景` 在正文块上
 * 恒不命中，`section:背景 营收` 这类最自然的查询会返回 0 条（用户只会觉得 section 坏了）。
 * 正确做法是沿文档块顺序回溯：取 line ≤ 当前块 line 的最后一个 heading 块。
 * 前端镜像实现（knowledgeQuery.ts）在没有完整 doc 时退化为只看块自身，行为差异已在那边注明。
 */
export function enclosingHeading(doc, block) {
  if (!doc || !block) return ''
  const own = String(block.heading ?? '')
  if (own) return own
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : []
  const line = Number(block.line)
  if (!Number.isFinite(line)) return ''
  let best = ''
  for (const b of blocks) {
    if (b === block) continue
    if (String(b.kind ?? '') !== 'heading') continue
    if (Number(b.line) > line) continue
    // 标题块的文本可能含 `#`/`##` 前缀与换行，用去掉标记后的首行比较，避免 `section:## 背景` 这种怪写法才命中
    const text = String(b.text ?? '').replace(/^#{1,6}\s*/, '').split('\n')[0]
    if (text) best = text
  }
  return best
}

/** 文档级字段命中判定（文档级过滤的唯一实现，"仅过滤查询"与候选预过滤共用） */
export function docFieldHit(doc, field, value) {
  const v = String(value ?? '').toLowerCase()
  if (!v) return false
  if (field === 'tag') {
    // 容忍 `#财务` 与 `财务`（Obsidian 里 tag: 后常带 #）——用户少打一个字符不该搜不到。
    // 前缀匹配：`tag:财` 能匹配 `财务`（与 Obsidian 的 tag 前缀搜索一致）。
    const want = v.startsWith('#') ? v.slice(1) : v
    const tags = Array.isArray(doc?.tags) ? doc.tags : []
    return tags.some((t) => String(t).toLowerCase().replace(/^#/, '').startsWith(want))
  }
  if (field === 'path') return String(doc?.rel ?? '').toLowerCase().includes(v)
  if (field === 'file') return String(doc?.rel ?? '').split('/').pop().toLowerCase().includes(v)
  return false
}

/** 块级字段命中判定（`section` / `content` / `block`，含别名） */
export function blockFieldHit(block, doc, field, value) {
  const v = String(value ?? '').toLowerCase()
  if (!v) return false
  if (field === 'section') {
    // 所属标题（回溯文档块顺序，见 enclosingHeading 的说明）+ 块自身文本里的标题行兜底
    const head = enclosingHeading(doc, block).toLowerCase()
    if (head.includes(v)) return true
    const first = String(block?.text ?? '').split('\n').find((l) => /^#{1,6}\s/.test(l))
    return !!first && first.toLowerCase().includes(v)
  }
  if (field === 'content') return String(block?.text ?? '').toLowerCase().includes(v)
  if (field === 'block') {
    // 块 id 习惯写法 `^a1b2`：容错去掉前导 `^` 后再比（包含而非精确，便于按前缀找）
    const want = v.startsWith('^') ? v.slice(1) : v
    return String(block?.id ?? '').toLowerCase().includes(want)
  }
  return false
}

/**
 * 查询的**分组视图**：把 `A OR B` 拆成"组内必须同时满足、组间任一满足"的结构。
 *
 * 为什么必须有这一层：批次 3 最初把 `parsed.filters` 当成一个扁平 AND 列表，
 * 于是 `tag:财务 OR tag:技术` 会要求**同时**有这两个标签 → 返回 0 条。
 * 用户写了 OR 却什么也搜不到，这是明确的错误行为，故 OR 必须一路贯彻到过滤层。
 *
 * 无 `OR` 时不构造分组（返回 null），调用方走"单个隐式组"的直路 —— 少一层循环，
 * 且避免"没写 OR 却被当成分组"的歧义。
 */
function groupsOf(parsed) {
  if (!parsed) return null
  if (Array.isArray(parsed.orGroups) && parsed.orGroups.length > 1) return parsed.orGroups
  return null
}

/** 单个分组内的项按类型过滤出子集 */
function partsOfGroup(group, kind) {
  return group.filter((p) => p.kind === kind)
}

/** 文档级过滤（无 OR 时用）：`filters` 里的文档级字段全部满足 */
function docFiltersOk(doc, filters) {
  for (const f of filters) {
    if (f.kind && f.kind !== 'filter') continue
    if (!QUERY_DOC_FIELDS.includes(f.field)) continue
    const hit = docFieldHit(doc, f.field, f.value)
    if (f.negate ? hit : !hit) return false
  }
  return true
}

/** 块级过滤（无 OR 时用）：`filters` 里的块级字段全部满足 */
function blockFiltersOk(block, doc, filters) {
  for (const f of filters) {
    if (f.kind && f.kind !== 'filter') continue
    if (!QUERY_BLOCK_FIELDS.includes(f.field)) continue
    const hit = blockFieldHit(block, doc, f.field, f.value)
    if (f.negate ? hit : !hit) return false
  }
  return true
}

/**
 * 文档级过滤 —— 内核在**打分之前**调用（候选集预过滤 / 图扩展准入 / 标签直连准入）。
 *
 * 支持 OR 分组：有 `OR` 时"任一组的分组条件全满足"即通过。这一条是 `tag:A OR tag:B`
 * 能出结果的原因（扁平 AND 会要求两个标签同时存在 → 恒空）。
 *
 * 否定的块级过滤（如 `-section:草稿`）：**只要有一块命中就排除整篇**。这是偏严的选择 ——
 * 块级负向条件无法在文档级精确表达，宁可多排除（用户看得见结果变少），也不要
 * "写着排除却照旧出现"（后者是明确的错误行为，前者只是保守）。
 */
/** 查询里是否含**块级**条件（正向或否定）—— 决定文档级判定要不要下探到块 */
function hasBlockLevelCondition(parsed) {
  const groups = groupsOf(parsed)
  const filters = groups ? groups.flat().filter((p) => p.kind === 'filter') : (parsed?.filters || [])
  return filters.some((f) => QUERY_BLOCK_FIELDS.includes(f.field))
}

/**
 * 文档级过滤 —— 内核在**打分之前**调用（候选集预过滤 / 图扩展准入 / 标签直连准入）。
 *
 * 支持 OR 分组：有 `OR` 时"任一组的分组条件全满足"即通过。这一条是 `tag:A OR tag:B`
 * 能出结果的原因（扁平 AND 会要求两个标签同时存在 → 恒空）。
 *
 * ## 何时下探到块（`needBlock`）
 *
 * 查询里含**块级条件**（`section:` / `content:` / `block:`，正向或否定）或处于**严格模式**时，
 * 文档级判定必须验证到块才算命中；否则只看文档级字段。
 *
 * 这条规则的由来是一个**实测出来的过度排除**：最初实现规定"否定的块级过滤只要有一块命中
 * 就排除整篇"，于是 `内容 -content:未定稿` 返回 0 条 —— 用户明明只是想排掉"未定稿"那一块，
 * 结果同一篇里其它含"内容"的块也搜不到了。既然块级匹配器已经能精确表达"排掉哪一块"，
 * 文档级就该用同一套精确语义，而不是拿一个粗粒度的近似去替代它。
 * 反过来，只含文档级条件（`tag:`）时不下探 —— 那是绝大多数查询的主路径，不该为它付全块扫描。
 */
export function matchDocQuery(doc, parsed) {
  if (!doc || !parsed) return false
  const groups = groupsOf(parsed)
  const needBlock = parsed.strict === true || hasBlockLevelCondition(parsed)
  if (groups) {
    return groups.some((g) => {
      if (!docFiltersOk(doc, partsOfGroup(g, 'filter'))) return false
      if (!needBlock) return true
      return docHasBlockMatchingGroup(doc, g)
    })
  }
  const filters = parsed.filters || []
  if (!docFiltersOk(doc, filters)) return false
  if (!needBlock) return true
  return docHasBlockMatchingGroup(doc, flatParts(parsed))
}

/** 文档里是否存在一块满足"该组的块级过滤 + 文本布尔"（精确的文档级判定，见 matchDocQuery） */
function docHasBlockMatchingGroup(doc, group) {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : []
  for (const b of blocks) {
    if (!blockFiltersOk(b, doc, partsOfGroup(group, 'filter'))) continue
    if (textPartsOk(b?.text, group)) return true
  }
  return false
}

/**
 * 块级匹配 —— **完整**的分组判定（文档级条件 + 块级条件 + 严格模式下的文本布尔）。
 * 内核在逐块选题时调用。
 *
 * 为什么这里也要判文档级条件（而不是"文档级已在 matchDocQuery 判过、这里跳过"）：
 * `A OR B` 的语义是"任一组**整体**满足"。若只判块级，那么 `tag:财务 营收 OR tag:技术` 里
 * 第二组（只看 `tag:技术`）对任何文档都能通过块级判定 —— 一篇只有"财务"标签的文档会被
 * 第二组"顺手放行"，OR 就退化成"随便哪一组能过就行"的恒真条件（实测就是返回了不该返回的结果）。
 * 分组必须**整组一起判**，否则 OR 的语义无处安放。
 */
export function matchBlockQuery(block, doc, parsed) {
  if (!parsed || !doc) return false
  const groups = groupsOf(parsed)
  if (groups) {
    return groups.some((g) => {
      if (!docFiltersOk(doc, partsOfGroup(g, 'filter'))) return false
      if (!blockFiltersOk(block, doc, partsOfGroup(g, 'filter'))) return false
      if (!parsed.strict) return true
      return textPartsOk(block?.text, g)
    })
  }
  if (!docFiltersOk(doc, parsed.filters || [])) return false
  if (!blockFiltersOk(block, doc, parsed.filters || [])) return false
  if (!parsed.strict) return true
  return textPartsOk(block?.text, flatParts(parsed))
}

/** 一组项里除 filter 外的文本项全部满足（含否定）；空组视为满足 */
function textPartsOk(haystack, group) {
  const raw = haystack == null ? '' : String(haystack)
  const s = raw.toLowerCase()
  for (const p of group) {
    if (p.kind === 'filter') continue
    const hit = p.kind === 'regex' ? p.re.test(raw) : s.includes(String(p.value ?? '').toLowerCase())
    if (p.negate ? hit : !hit) return false
  }
  return true
}

/**
 * 文本项匹配：词/短语 = 大小写不敏感子串；正则 = `re.test`。
 *
 * 用于"仅过滤查询"的文本核对与测试，**不参与打分**（打分仍走内核既有 4 路融合）。
 * 无 `OR` 分组时把所有项当作一组 AND；有 `OR` 时"任一组全部满足"即命中。
 */
export function matchTextParts(haystack, parsed) {
  const groups = groupsOf(parsed)
  if (groups) return groups.some((g) => textPartsOk(haystack, g))
  return textPartsOk(haystack, flatParts(parsed))
}

/** 把解析结果摊平成一维项数组（无 OR 分组时的 AND 全集）。优先用解析时存好的 `parts` */
function flatParts(parsed) {
  if (Array.isArray(parsed?.parts) && parsed.parts.length) return parsed.parts
  const out = []
  for (const t of parsed?.terms ?? []) out.push({ kind: 'term', value: t })
  for (const p of parsed?.phrases ?? []) out.push({ kind: 'phrase', value: p })
  for (const r of parsed?.regexes ?? []) out.push({ kind: 'regex', value: r.value, re: r.re, negate: r.negate })
  for (const f of parsed?.filters ?? []) out.push({ kind: 'filter', ...f })
  return out
}
