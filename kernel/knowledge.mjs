// kernel/knowledge.mjs —— 知识内核（S1）：空间发现 / 文档解析 / 索引 / 检索
// ---------------------------------------------------------------------------
// 权威实现（server 侧一律经 --knowledge <op> 子命令转发，不在 server 复制逻辑）。
// 数据模型与设计见 docs/superpowers/specs/2026-09-13-knowledge-core-design.md。
// 纯函数在 shared/knowledge-core.mjs（repo 根 shared/ 经一级 ../ 逃逸共享）。
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync,
} from 'node:fs'
import { join, relative, sep, basename } from 'node:path'
import {
  INDEX_VERSION, builtinSpaceSpecs, parseFrontmatter, splitBlocks, extractLinks,
  toDocId, hashLine,
  countGrams, buildIdf, vectorizeText, blockIndexText, blockTagBoost, relationContent,
  serializeIndex, parseJsonl, resolveLinkTarget,
  cosine, keywordScore, structBoostOf, fuseScore, makeSnippet, toBlockId,
} from '../shared/knowledge-core.mjs'

/** 空间根：<configDir>/knowledge（configDir 由调用方给，本模块不自解析 home） */
export function knowledgeRoot(configDir) {
  return join(configDir || '', 'knowledge')
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.index', '.obsidian'])

/** 递归收集 md。不跟符号链接（穿越防护第一道），跳过依赖/隐藏目录。 */
export function walkMd(root, { maxFiles = 5000 } = {}) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        stack.push(join(dir, e.name))
        continue
      }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue
      const abs = join(dir, e.name)
      out.push({ absPath: abs, relPath: relative(root, abs).split(sep).join('/') })
    }
  }
  return out
}

function readJsonFile(fp) {
  try { return JSON.parse(readFileSync(fp, 'utf-8')) } catch { return {} }
}

/**
 * 空间发现。顺序 = 内置（目录存在才挂）→ 用户空间 → 知识包（只读）。
 * 目录缺失一律静默跳过——"没有"不是错误。
 */
export function discoverSpaces({ configDir, root = null } = {}) {
  const kroot = root || knowledgeRoot(configDir)
  const out = []
  for (const s of builtinSpaceSpecs(configDir)) {
    if (existsSync(s.root)) out.push(s)
  }

  const spacesDir = join(kroot, 'spaces')
  if (existsSync(spacesDir)) {
    for (const name of readdirSync(spacesDir)) {
      const dir = join(spacesDir, name)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const meta = readJsonFile(join(dir, '.space.json'))
      out.push({
        id: name, name: meta.name || name, description: meta.description || '',
        root: dir, writable: true, source: 'user',
      })
    }
  }

  const packsDir = join(kroot, 'packs')
  if (existsSync(packsDir)) {
    for (const name of readdirSync(packsDir)) {
      const dir = join(packsDir, name)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const meta = readJsonFile(join(dir, 'pack.json'))
      const base = meta.source ? join(dir, String(meta.source).split('/').join(sep)) : dir
      if (!existsSync(base)) continue
      out.push({
        id: `pack-${name}`, name: meta.name || name, description: meta.description || '',
        root: base, writable: false, source: 'pack', packVersion: meta.version || null,
      })
    }
  }
  return out
}

function collectTags(front, space, relPath, blocks) {
  const tags = []
  if (front.tags) tags.push(...String(front.tags).split(/[,\s]+/).filter(Boolean))
  if (space.source === 'experience' || space.source === 'memory') {
    tags.push(basename(relPath).replace(/\.md$/i, ''))
  }
  for (const b of blocks) if (b.kind === 'entry' && b.entryTag) tags.push(b.entryTag)
  return [...new Set(tags)]
}

/** 解析单个 md → { doc, links }。抛错由调用方兜住（单文档故障不影响整库）。 */
export function parseDocFile({ absPath, space, relPath }) {
  const raw = readFileSync(absPath, 'utf-8')
  const { front, body, bodyStartLine } = parseFrontmatter(raw)
  const blocks = splitBlocks(body, { startLine: bodyStartLine })
  const docId = toDocId(space.id, relPath)
  const heading = blocks.find((b) => b.kind === 'heading')
  // 标题优先级：frontmatter.title → frontmatter.name → 首个 heading → 文件名。
  // name 必须排在 heading 之前：经验主题文件（如 workflow.md）带 `name: workflow`，
  // 若让首个 `## 小节` 抢先，主题名会被错认成小节名，检索排序与展示都会跟着错。
  const title = front.title || front.name || (heading && heading.text) || basename(relPath).replace(/\.md$/i, '')
  const st = statSync(absPath)
  const doc = {
    id: docId, spaceId: space.id, rel: relPath, title,
    tags: collectTags(front, space, relPath, blocks),
    hash: hashLine(raw), mtime: st.mtimeMs, size: st.size,
    lines: raw.split(/\r?\n/).length,
    blocks: blocks.map((b) => ({
      n: b.n, kind: b.kind, level: b.level, text: b.text, line: b.line,
      tag: b.entryTag || null, full: b.entryFull || null,
    })),
  }
  const links = extractLinks(raw).map((l) => ({ from: docId, to: l.to }))
  return { doc, links }
}

// ── 索引（Task 6）─────────────────────────────────────────────────────────
/** 单文档最多索引的块数（护栏：防单文件把索引撑爆） */
const MAX_BLOCKS_PER_DOC = 200
const PRUNE_MIN_DOCS = 50      // 少于 50 篇不做高频剪枝（小库剪枝会误伤）
const PRUNE_DF_RATIO = 0.5     // 出现在超半数文档里的 gram 近似停用词
/** 检索耗时采样窗口（环形缓冲上限）：100 次足够看 P95，也不会无界增长 */
const SEARCH_SAMPLES = 100

/**
 * 索引文本的**唯一口径**（S5 Task 2 / spec §8）：内容部分取 `relationContent(b)`
 * （= `stripTypePrefix(full || text)`），不再取 `b.text`。
 *
 * **why**：`b.text` 是 `kernel/memory.mjs:186` 生成的 `类型前缀 + t.slice(0,60)` 截断摘要，
 * 实测同一条目 text=45 字 vs full=471 字（10 倍信息差）。而检索的向量/gram 路与关联物化
 * （`shared/knowledge-core.mjs` 的 `relatedCandidates`，同样按 relationContent 算 cos）
 * **共用同一份索引语料**——两边口径不一致时，同一对块在"检索排序"与"关联分数"里会给出
 * 互相矛盾的相关度，用户看到的 `score` 与 `related[].why.score` 对不上。
 * 统一到"去前缀 full"还顺带修掉截断摘要丢失语义细节的问题：落在 60 字之后的内容
 * 以前**根本进不了索引**（查不到），现在能查到。
 *
 * 类型标签前缀与 tagBoost 仍走 `blockIndexText`/`blockTagBoost`（entry 块 tag 加 3 倍权）：
 * 那是 S1 的 tag 命中语义，S5 不动。
 *
 * 反过来说，**不要**在这里改回 `b.text`：改了就会退回"两条路径信息量不一致"的老问题。
 */
function indexTextOf(b) {
  return blockIndexText({ kind: b.kind, text: relationContent(b), entryTag: b.tag })
}

export function createKnowledgeStore({ configDir, root = null } = {}) {
  const kroot = root || knowledgeRoot(configDir)
  const idxDir = join(kroot, '.index')
  let spaces = []
  let docs = []            // = docs.jsonl 行序，即 docIdx 定义
  let idf = new Map()
  let inverted = new Map() // gramHash -> { g, df, p: [[docIdx, w]] }
  let linkOut = new Map()  // docId -> [{ to, target }]
  let builtAt = null
  let indexBytes = 0
  // 索引指纹表（manifest.files）与 links.jsonl 的当前行集：staleness 精确判定与
  // 增量更新的共享状态。**唯一写入口是 persist()**（全量/增量共用），避免两套写盘逻辑漂移。
  let lastFiles = {}
  let lastLinkRows = []

  const file = (name) => join(idxDir, name)

  function scanAll() {
    const acc = { docs: [], links: [] }
    for (const space of spaces) {
      for (const { absPath, relPath } of walkMd(space.root)) {
        try {
          const parsed = parseDocFile({ absPath, space, relPath })
          if (parsed.doc.blocks.length > MAX_BLOCKS_PER_DOC) {
            parsed.doc.blocks = parsed.doc.blocks.slice(0, MAX_BLOCKS_PER_DOC)
          }
          acc.docs.push(parsed.doc)
          acc.links.push(...parsed.links)
        } catch { /* 单文档解析失败：跳过，不拖垮整库 */ }
      }
    }
    return acc
  }

  function buildIndex() {
    const { docs: nextDocs, links } = scanAll()
    // 两遍法：先用全部块语料算 IDF，再向量化（IDF 必须基于全库，否则评分不可比）
    const gramDocs = []
    for (const d of nextDocs) {
      for (const b of d.blocks) {
        gramDocs.push({ gramCounts: countGrams(indexTextOf(b)) })
      }
    }
    const nextIdf = buildIdf(gramDocs)

    const inv = new Map()
    const tagMap = {}
    nextDocs.forEach((d, i) => {
      for (const b of d.blocks) {
        const text = indexTextOf(b)
        const boost = blockTagBoost(b)
        for (const [g, w] of vectorizeText(text, { tagBoost: boost, idf: nextIdf })) {
          const e = inv.get(g) || { g, docs: new Set(), p: [] }
          e.docs.add(i)
          e.p.push([i, Math.round(w * 10000) / 10000])
          inv.set(g, e)
        }
      }
      for (const t of d.tags) (tagMap[t] ||= []).push(d.id)
    })

    // df 事后统计 + 高频剪枝（小库不剪）
    const nextInv = new Map()
    for (const [g, e] of inv) {
      const df = e.docs.size
      if (nextDocs.length >= PRUNE_MIN_DOCS && df > nextDocs.length * PRUNE_DF_RATIO) continue
      nextInv.set(g, { g, df, p: e.p })
    }

    const ids = new Set(nextDocs.map((d) => d.id))
    const nextLinks = []
    const out = new Map()
    for (const l of links) {
      const owner = nextDocs.find((d) => d.id === l.from)
      const target = owner
        ? resolveLinkTarget({ fromRel: owner.rel, to: l.to, spaceId: owner.spaceId, docIds: ids })
        : null
      nextLinks.push({ from: l.from, to: l.to, target })
      const arr = out.get(l.from)
      if (arr) arr.push({ to: l.to, target })
      else out.set(l.from, [{ to: l.to, target }])
    }

    docs = nextDocs
    idf = nextIdf
    inverted = nextInv
    linkOut = out
    persist(nextLinks)
  }

  /**
   * 索引唯一写入口（全量构建与增量更新共用）。
   * linkRows 由调用方传入：全量路径来自 scanAll，增量路径来自 lastLinkRows 的按文档替换
   * ——两条路径共用同一份序列化与原子落盘逻辑，不各写一套。
   */
  function persist(linkRows = lastLinkRows) {
    const rows = docs.map((d, i) => ({
      i, id: d.id, spaceId: d.spaceId, rel: d.rel, title: d.title, tags: d.tags,
      hash: d.hash, mtime: d.mtime, size: d.size, lines: d.lines,
      blocks: d.blocks.map((b) => ({
        n: b.n, kind: b.kind, level: b.level, text: b.text, line: b.line, tag: b.tag, full: b.full,
      })),
    }))
    const inv = [...inverted.values()]
    const files = {}
    for (const d of docs) files[d.id] = { size: d.size, mtime: d.mtime, hash: d.hash }
    const spaceCount = {}
    for (const d of docs) spaceCount[d.spaceId] = (spaceCount[d.spaceId] || 0) + 1
    const built = new Date().toISOString()
    const manifest = {
      version: INDEX_VERSION, builtAt: built, docs: docs.length,
      blocks: docs.reduce((s, d) => s + d.blocks.length, 0),
      spaces: Object.fromEntries(Object.entries(spaceCount).map(([k, v]) => [k, { docs: v }])),
      files,
      // 完整性指纹：加载时用来识别「半写/截断」的索引。没有它，被截断的 inverted.jsonl
      // 会解析成「合法但更少」的 postings——不报错，却让检索静默返回空集（实测 count 0）。
      // 索引是派生物，宁可判定损坏后重建，也不要拿着残缺索引装正常。
      docLines: rows.length,
      invLines: inv.length,
    }
    const tags = {}
    for (const d of docs) for (const t of d.tags) (tags[t] ||= []).push(d.id)
    const ser = serializeIndex({ docs: rows, inverted: inv, links: linkRows, tags })
    try {
      mkdirSync(idxDir, { recursive: true })
      // 原子替换：先写 .tmp 再 rename（同 graph.mjs 手法）。
      // docs.jsonl 与 inverted.jsonl 必须同批落盘——postings 下标依赖 docs 行序。
      writeFileSync(file('docs.jsonl.tmp'), ser.docs, 'utf-8')
      writeFileSync(file('inverted.jsonl.tmp'), ser.inverted, 'utf-8')
      writeFileSync(file('links.jsonl.tmp'), ser.links, 'utf-8')
      writeFileSync(file('tags.json.tmp'), ser.tags, 'utf-8')
      writeFileSync(file('manifest.json.tmp'), JSON.stringify(manifest, null, 2), 'utf-8')
      for (const n of ['docs.jsonl', 'inverted.jsonl', 'links.jsonl', 'tags.json', 'manifest.json']) {
        renameSync(file(`${n}.tmp`), file(n))
      }
      builtAt = built
      lastFiles = files
      lastLinkRows = linkRows
      indexBytes = Buffer.byteLength(ser.docs, 'utf-8') + Buffer.byteLength(ser.inverted, 'utf-8')
        + Buffer.byteLength(ser.links, 'utf-8') + Buffer.byteLength(ser.tags, 'utf-8')
    } catch { /* 磁盘不可写不致命：内存索引仍可用（对齐 graph.mjs 纪律） */ }
  }

  function loadIndexFromDisk() {
    const raw = (n) => { try { return readFileSync(file(n), 'utf-8') } catch { return '' } }
    const manifest = (() => { try { return JSON.parse(raw('manifest.json') || '{}') } catch { return {} } })()
    // 版本不符 → 返回 false 让上层重建（不抛错：旧索引是"过期派生物"，不是故障）
    if ((manifest.version ?? 0) !== INDEX_VERSION) return false
    docs = parseJsonl(raw('docs.jsonl'))
    if (!docs.length && (manifest.docs || 0) > 0) return false
    // 截断检测（见 persist 里 docLines/invLines 的注释）：实际条数少于记录值即为半写，
    // 判定损坏让上层重建。用 `<` 而非 `!==`——多出条目只可能是未来的增量追加，不算损坏。
    if (typeof manifest.docLines === 'number' && docs.length < manifest.docLines) return false
    const invRows = parseJsonl(raw('inverted.jsonl'))
    if (typeof manifest.invLines === 'number' && invRows.length < manifest.invLines) return false
    const inv = new Map()
    for (const e of invRows) inv.set(e.g, { g: e.g, df: e.df, p: e.p })
    inverted = inv
    const linkRows = parseJsonl(raw('links.jsonl'))
    linkOut = new Map()
    for (const l of linkRows) {
      const arr = linkOut.get(l.from)
      if (arr) arr.push({ to: l.to, target: l.target })
      else linkOut.set(l.from, [{ to: l.to, target: l.target }])
    }
    const gramDocs = []
    for (const d of docs) {
      for (const b of d.blocks) {
        gramDocs.push({ gramCounts: countGrams(indexTextOf(b)) })
      }
    }
    idf = buildIdf(gramDocs)
    builtAt = manifest.builtAt || null
    lastFiles = manifest.files || {}
    lastLinkRows = linkRows
    indexBytes = ['docs.jsonl', 'inverted.jsonl', 'links.jsonl', 'tags.json']
      .reduce((s, n) => s + Buffer.byteLength(raw(n), 'utf-8'), 0)
    return true
  }

  /**
   * 精确 staleness：逐文件比 size/mtime，并检测"新增"与"磁盘已删"。
   * 为什么不用全局 builtAt 比较：增量更新（updateDoc → persist）会刷新 builtAt，
   * 若以全局时间戳判定，会漏掉"某文件早于本次更新但尚未进索引"的改动——per-file 指纹表
   * 没有这个盲区，也让"增量更新后 load() 不再全量重建"（Task 8）成立。
   */
  function indexStale() {
    const seen = new Set()
    for (const space of spaces) {
      for (const { absPath, relPath } of walkMd(space.root)) {
        const id = toDocId(space.id, relPath)
        seen.add(id)
        const rec = lastFiles[id]
        if (!rec) return true                       // 新增文件
        try {
          const st = statSync(absPath)
          if (st.size !== rec.size || Math.abs(st.mtimeMs - rec.mtime) > 1) return true
        } catch { return true }                     // 读不到 → 保守重建
      }
    }
    for (const id of Object.keys(lastFiles)) if (!seen.has(id)) return true  // 磁盘已删
    return false
  }

  // ── 检索（Task 7）───────────────────────────────────────────────────────
  const docIndexById = () => { const m = new Map(); docs.forEach((d, i) => m.set(d.id, i)); return m }

  /** 块级评分。degraded=true 时跳过向量路（查询 gram 全部落空，只能靠关键词）。 */
  function scoreBlock(doc, b, qvec, qtext, kws, degraded) {
    const cos = degraded ? 0 : cosine(
      vectorizeText(indexTextOf(b), { tagBoost: blockTagBoost(b), idf }), qvec,
    )
    // 关键词路的 summary 与向量路**同一口径**（S5 §8：relationContent）——两条路径喂给融合
    // 评分的必须同源，否则"向量说近、关键词说远"会在同一查询内互相抵消。
    // `full: b.full` 保持原样：它是 `mode='full'` 的正文来源，也是"内容落在摘要截断之外"的兜底信号。
    const kw = keywordScore({ tag: b.tag || '', summary: relationContent(b), full: b.full || '', theme: doc.title }, kws)
    const struct = structBoostOf({ block: { kind: b.kind }, doc, query: qtext, keywords: kws })
    return { cos, kw, struct }
  }

  /** 块所属 heading（取该行之前的最后一个 heading）——卡片与行内结果都要展示归属小节。 */
  function headingAt(doc, line) {
    let h = null
    for (const b of doc.blocks) { if (b.line > line) break; if (b.kind === 'heading') h = b.text }
    return h
  }

  function toItem(doc, b, sc, mode, graph) {
    const score = fuseScore({ ...sc, graph })
    return {
      docId: doc.id, blockId: toBlockId(doc.id, b.n), spaceId: doc.spaceId,
      title: doc.title, heading: headingAt(doc, b.line),
      snippet: mode === 'full' ? (b.full || b.text) : makeSnippet(b.text),
      score, line: b.line, kind: b.kind,
      // S3 §4.2 增补（纯增量，老消费方不受影响）：tag/text/full 让"条目级"消费方
      // （MemorySearch 转发的适配层）能原样渲染 `- [主题|标签] 摘要 -- 全文`，
      // 而不必为了拿 tag/full 再回调 getDoc 做一次块查询。
      tag: b.tag || null, text: b.text, full: b.full || null,
    }
  }

  /**
   * 4 路融合检索（spec §5.4）：倒排候选 → 块级重排（向量 0.60 + 关键词 0.25 + 结构 0.15）
   * → 出链图扩展（×0.9）→ topK / maxBytes 双层截断。**同步**函数（Task 10 的 run() 是同步契约）。
   * 全程不原地排序 `docs` / `inverted` 内部数组：`getDocs()` 返回的是内部引用，
   * 一旦被 sort，`docs.jsonl` 行序（即 docIdx 定义）就被永久打乱，postings 下标全部失效。
   */
  function searchInner({ query = '', keywords = [], spaces: only = null, topK = 5, maxBytes = 2048, mode = 'snippet' } = {}) {
    const q = String(query || '').trim()
    const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean)
    const qtext = q || kws.join(' ')
    const age = builtAt ? Date.now() - Date.parse(builtAt) : null
    if (!qtext) return { items: [], count: 0, indexAge: age, degraded: false }
    const allow = Array.isArray(only) && only.length ? new Set(only) : null
    const qvec = vectorizeText(qtext, { idf })

    // 1) 倒排候选：只遍历查询 gram 的 postings，成本 ∝ 命中量（不是全库 × 全 gram）
    const acc = new Map()
    for (const [g, wq] of qvec) {
      const e = inverted.get(g)
      if (!e) continue
      for (const [di, wd] of e.p) acc.set(di, (acc.get(di) || 0) + wq * wd)
    }
    let degraded = false
    let cand = [...acc.keys()]
    if (!cand.length) {
      // 查询 gram 全落空（被剪枝/语料太小/纯生僻词）→ 退化为关键词路，绝不返回空而不给机会
      degraded = true
      cand = docs.map((_, i) => i)
    }
    cand = cand
      .filter((i) => docs[i] && (!allow || allow.has(docs[i].spaceId)))
      .map((i) => ({ i, s: acc.get(i) || 0 }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(topK * 4, 20))
      .map((x) => x.i)

    // 降级路额外要求"内容信号"（向量或关键词）：struct 是**放大器**，不能单独造出结果。
    // 否则降级路会把全库的 heading/entry 以纯 struct 底价（0.5/0.4）捞回来——查 'zzzzz'
    // 这种零相关查询也返回一堆条目，用户会以为"搜到了"。
    const isHit = (sc, score) => score > 0.001 && (!degraded || sc.cos > 0 || sc.kw > 0)

    // 2) 块级重排：只在候选文档内逐块打分（块级才是精度的来源）
    const items = []
    for (const i of cand) {
      const doc = docs[i]
      let best = null
      let bestSc = null
      for (const b of doc.blocks) {
        const sc = scoreBlock(doc, b, qvec, qtext, kws, degraded)
        const it = toItem(doc, b, sc, mode, false)
        if (!best || it.score > best.score) { best = it; bestSc = sc }
      }
      if (best && isHit(bestSc, best.score)) items.push(best)
    }

    // 3) 图扩展：已命中文档的出链目标，取 heading/entry 块参与（×0.9 折扣）
    const idxById = docIndexById()
    const seen = new Set(items.map((x) => x.blockId))
    for (const it of items.slice(0, Math.max(topK, 1))) {
      for (const l of linkOut.get(it.docId) || []) {
        if (!l.target) continue
        const ti = idxById.get(l.target)
        if (ti === undefined) continue
        const tdoc = docs[ti]
        if (allow && !allow.has(tdoc.spaceId)) continue
        for (const b of tdoc.blocks) {
          if (b.kind !== 'heading' && b.kind !== 'entry') continue
          const bid = toBlockId(tdoc.id, b.n)
          if (seen.has(bid)) continue
          const sc2 = scoreBlock(tdoc, b, qvec, qtext, kws, degraded)
          const cand2 = toItem(tdoc, b, sc2, mode, true)
          if (isHit(sc2, cand2.score)) { seen.add(bid); items.push(cand2) }
        }
      }
    }

    items.sort((a, b) => b.score - a.score)
    // 4) 双层截断：topK 控条数，maxBytes 控上下文预算。
    //    第一条无条件放入——否则预算极小时前端永远空白，用户看到"搜不到"。
    const out = []
    let used = 0
    for (const it of items) {
      if (out.length >= topK) break
      const bytes = Buffer.byteLength(it.snippet, 'utf-8') + 160
      if (out.length > 0 && used + bytes > maxBytes) break
      used += bytes
      out.push(it)
    }
    return { items: out, count: out.length, indexAge: age, degraded }
  }

  /**
   * 检索耗时采样（S3 §6 观测）：环形缓冲保留最近 SEARCH_SAMPLES 次，`stats()` 出 P50/P95。
   * 为什么包一层而不是在 searchInner 里逐点打表：searchInner 有多处 return，逐点埋点必然
   * 漏一处（漏掉的那条路就永远不进样本，指标悄悄失真）。
   * 进程内不落盘：CLI 每次 `--knowledge stats` 都是新进程，样本自然为空——跨进程可见的那份
   * 由 kernel/knowledge-inject.mjs 落盘成 .index/metrics.json（会话启动时写一次）。
   */
  const searchTimes = []
  function search(opts = {}) {
    const t0 = Date.now()
    const r = searchInner(opts)
    searchTimes.push(Date.now() - t0)
    if (searchTimes.length > SEARCH_SAMPLES) searchTimes.shift()
    return r
  }
  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null)

  // ── 增量更新与条目级读接口（Task 8）─────────────────────────────────────

  /** docId → 磁盘绝对路径（space.root + rel）。空间未挂载（如包被移除）返回 null。 */
  function absPathOf(doc) {
    const space = spaces.find((s) => s.id === doc.spaceId)
    if (!space) return null
    return join(space.root, ...doc.rel.split('/'))
  }

  /**
   * 重算**单个文档**的链接行（增量路径专用）：其余文档的 links 行沿用 lastLinkRows，
   * 不必为了改一个文件把全库重读一遍。同时同步 linkOut 里该文档的出边。
   */
  function relinkDoc(doc, ids) {
    const rows = lastLinkRows.filter((r) => r.from !== doc.id)
    const out = []
    const abs = absPathOf(doc)
    if (abs && existsSync(abs)) {
      let raw = ''
      try { raw = readFileSync(abs, 'utf-8') } catch { raw = '' }
      for (const l of extractLinks(raw)) {
        const target = resolveLinkTarget({ fromRel: doc.rel, to: l.to, spaceId: doc.spaceId, docIds: ids })
        rows.push({ from: doc.id, to: l.to, target })
        out.push({ to: l.to, target })
      }
    }
    linkOut.delete(doc.id)
    if (out.length) linkOut.set(doc.id, out)
    lastLinkRows = rows
  }

  /**
   * 增量更新单个文档（唯一写入口仍是 persist()）。
   * **docIdx 必须保持不变**：原地替换 `docs[i]` + 摘除该 `di` 的 postings 后重插。
   * 若改成"删了重加"，其后所有文档下标位移，`inverted.jsonl` 立即失效。
   *
   * 已知取舍：idf 不重算（单文档更新不重扫全库；idf 漂移量级远小于检索排序噪声，
   * 需要精确时走 load({force:true}) 全量重建）。同步函数——`await` 非 Promise 值合法。
   */
  function updateDoc(docId) {
    const i = docs.findIndex((d) => d.id === docId)
    if (i < 0) return { updated: false, reason: 'not-found' }
    const doc = docs[i]
    const abs = absPathOf(doc)
    if (!abs || !existsSync(abs)) return { updated: false, reason: 'file-missing' }
    const space = spaces.find((s) => s.id === doc.spaceId)
    let parsed
    try { parsed = parseDocFile({ absPath: abs, space, relPath: doc.rel }) } catch { return { updated: false, reason: 'parse-error' } }
    if (parsed.doc.blocks.length > MAX_BLOCKS_PER_DOC) {
      parsed.doc.blocks = parsed.doc.blocks.slice(0, MAX_BLOCKS_PER_DOC)
    }
    docs[i] = parsed.doc

    // 该文档的全部 postings 重算：先从既有倒排中摘除 di === i，再按新块重新插入。
    // df 用"该 gram 覆盖的文档数"（块级 posting 可能同文档多条，故去重后计数）。
    for (const [g, e] of [...inverted]) {
      const p = e.p.filter(([di]) => di !== i)
      if (!p.length) inverted.delete(g)
      else { e.p = p; e.df = new Set(p.map(([di]) => di)).size }
    }
    const touched = new Set()
    for (const b of parsed.doc.blocks) {
      // 增量路必须与全量构建同口径（indexTextOf）：否则同一个库"改过一个文件"后，
      // 被改文档的 postings 与其余文档口径不同，检索排序会随"是否增量过"漂移，
      // 且下次全量重建结果又不一致（幂等性被打破）。
      for (const [g, w] of vectorizeText(indexTextOf(b), { tagBoost: blockTagBoost(b), idf })) {
        const e = inverted.get(g) || { g, df: 0, p: [] }
        if (!e.p.some(([di]) => di === i)) e.df += 1
        e.p.push([i, Math.round(w * 10000) / 10000])
        inverted.set(g, e)
        touched.add(g)
      }
    }
    // postings 保持 docIdx 升序（与全量构建、检索候选累加的顺序假设一致）
    for (const g of touched) inverted.get(g).p.sort((a, b) => a[0] - b[0])

    relinkDoc(parsed.doc, new Set(docs.map((d) => d.id)))
    persist()
    return { updated: true }
  }

  function getDoc(docId) { return docs.find((d) => d.id === docId) || null }

  /** 条目级清单：**只**返回 `kind === 'entry'` 的块（经验文件用），非经验文档返回 []。 */
  function listEntries(docId) {
    const d = getDoc(docId)
    if (!d) return []
    return d.blocks.filter((b) => b.kind === 'entry').map((b) => ({
      blockId: toBlockId(d.id, b.n), tag: b.tag, summary: b.text, full: b.full, line: b.line,
    }))
  }

  /**
   * 单层目录列举（GUI 文件树用）：跳过隐藏项与符号链接，只列 dir 与 .md 文件。
   *
   * 读侧穿越防护（与写侧 safeRelPath 对称）：`path` 来自 HTTP 查询串，若原样 join，
   * `?path=../secret` 能列出空间根**之外**的目录内容（实测可读到兄弟空间的 .md 文件名）。
   * "只是读、不算漏洞"是错的——文件名本身就是信息（空间划分、他人笔记标题）。
   * 故此处拒绝绝对路径与任何 `.`/`..` 段，与写侧保持同一套判定，不做例外。
   */
  function listTree({ space, path = '' } = {}) {
    const sp = spaces.find((s) => s.id === space)
    if (!sp) return []
    const raw = String(path || '').replace(/\\/g, '/')
    // 绝对路径与盘符直接拒（不可能在空间根内）
    if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return []
    // `.` 段是空操作（`./` = 当前目录 = 空间根），剔除而非拒绝——拒它会让 GUI 树
    // 在某条拼接路径上静默空白，是比它防的风险更坏的故障模式。
    const segs = raw.split('/').filter((s) => s && s !== '.')
    // `..` 才能真正逃出空间根，必须拒
    if (segs.some((s) => s === '..')) return []
    const sub = segs.join('/')
    const root = segs.length ? join(sp.root, ...segs) : sp.root
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
    const out = []
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue
      const rel = sub ? `${sub}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) out.push({ name: e.name, path: rel, type: 'dir' })
      } else if (/\.md$/i.test(e.name)) {
        out.push({ name: e.name, path: rel, type: 'file', docId: toDocId(sp.id, rel) })
      }
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  }

  /** 出边 + 反向链接（GUI 面包屑与"谁引用了我"用）。 */
  function getLinks(docId) {
    const out = (linkOut.get(docId) || []).map((l) => ({ to: l.to, target: l.target }))
    const inb = []
    for (const [from, arr] of linkOut) for (const l of arr) if (l.target === docId) inb.push({ from })
    return { out, in: inb }
  }

  /** 文档级图谱（GUI 可视化用）：只保留空间内且**已解析**的边。 */
  function getGraph({ space = null, limit = 200 } = {}) {
    const pool = space ? docs.filter((d) => d.spaceId === space) : docs
    const ids = new Set(pool.map((d) => d.id))
    const nodes = pool.slice(0, limit).map((d) => ({ id: d.id, label: d.title, spaceId: d.spaceId, kind: 'doc' }))
    const edges = []
    for (const [from, arr] of linkOut) {
      if (!ids.has(from)) continue
      for (const l of arr) {
        if (l.target && ids.has(l.target)) edges.push({ from, to: l.target, target: l.target })
      }
    }
    return { nodes, edges }
  }

  return {
    /**
     * 加载或构建索引。**非 async**：内部全同步（无任何 await），因为 KnowledgeSearch
     * 的 run() 是同步契约；同时 `await store.load()` 对非 Promise 值依然合法，
     * 故调用方可自由书写（Task 7-9 的测试即如此）。
     */
    load({ force = false, spaces: injected = null } = {}) {
      spaces = injected || discoverSpaces({ configDir, root: kroot })
      if (force) { buildIndex(); return }
      const ok = loadIndexFromDisk()
      if (!ok || indexStale()) buildIndex()
    },
    getSpaces() {
      const count = {}
      for (const d of docs) count[d.spaceId] = (count[d.spaceId] || 0) + 1
      return spaces.map((s) => ({ ...s, docCount: count[s.id] || 0 }))
    },
    search,
    updateDoc, getDoc, listEntries, listTree, getLinks, getGraph,
    getDocs() { return docs },
    getIdf() { return idf },
    getInverted() { return inverted },
    getLinkOut() { return linkOut },
    stats() {
      const sorted = [...searchTimes].sort((a, b) => a - b)
      return {
        version: INDEX_VERSION, docs: docs.length,
        blocks: docs.reduce((s, d) => s + d.blocks.length, 0),
        grams: inverted.size, spaces: spaces.length,
        builtAt, indexAgeMs: builtAt ? Date.now() - Date.parse(builtAt) : null,
        indexBytes,
        // S3 §6：检索耗时分布（进程内样本；跨进程见 .index/metrics.json）
        search: { count: sorted.length, elapsedP50: pct(sorted, 0.5), elapsedP95: pct(sorted, 0.95) },
      }
    },
  }
}
