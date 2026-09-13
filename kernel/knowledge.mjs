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
  // S5 关联锚点（Task 1 的纯函数层）：物化 + 读时校验只用这几个，判定逻辑一律留在 shared
  relatedCandidates, blockContentSig, validateRelation, MIN_LEN, SIM_THRESHOLD, MAX_RELATED,
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
 * 检索结果每条附带的锚点上限（S5 Task 6）。取 3 而不是 MAX_RELATED(8) 的理由是**体积**：
 * 检索项本身已是 topK（缺省 5）条，每项 8 条锚点 ⇒ 最多 40 条摘要，而摘要里的 `why.shared`
 * 还会带 5 个特征字 —— 与 `maxBytes`（缺省 2048）同阶甚至超出，S3 的教训就是"顺手多带一点"
 * 把注入预算吃光。3 条在"给出多条路径"与"不膨胀"之间取平衡；要全量锚点用 `getRelated(blockId)`。
 */
const SEARCH_RELATED_TOPN = 3

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

/**
 * `knowledgeRelateMode`（S5 §10）：'on'（缺省）| 'off'。
 * 优先级：显式构造参数（测试/调用方注入）→ env `PONOS_KNOWLEDGE_RELATE_MODE` →
 * `<configDir>/config.json` 的 `knowledgeRelateMode` → 'on'。
 *
 * **why 读 config.json**：与 `knowledgeInjectMode` 同款落点（server/bridge.mjs 的
 * `experienceInjectConfig()` 也读 config.json），配置项集中在用户可见的那一个文件里；
 * 判定权威在内核，server 只透传。
 * **why configDir 为空时不读盘**：服务端测试用 `createKnowledgeStore({ root })` 构造
 * （没有 configDir），此时若去读相对路径的 config.json，会误取启动 cwd 里的文件；
 * 缺省一律 'on' —— 缺省值必须等于"新能力开启"（spec §10）。
 */
function resolveRelateMode(configDir, explicit = null) {
  const norm = (v) => (String(v ?? '').trim().toLowerCase() === 'off' ? 'off' : 'on')
  if (explicit !== null && explicit !== undefined && String(explicit).trim() !== '') return norm(explicit)
  const env = process.env.PONOS_KNOWLEDGE_RELATE_MODE
  if (env !== undefined && String(env).trim() !== '') return norm(env)
  if (configDir) {
    try {
      const cfg = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'))
      if (cfg && cfg.knowledgeRelateMode !== undefined) return norm(cfg.knowledgeRelateMode)
    } catch { /* 无 config.json / 损坏 → 缺省 on（缺省必须等于既有行为之上"开启"） */ }
  }
  return 'on'
}

export function createKnowledgeStore({ configDir, root = null, relateMode = null } = {}) {
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
  // 关联物化行（S5 Task 4）：`related.jsonl` 的内存镜像。**唯一写入口仍是 persist()**
  // ——全量（buildIndex）与增量（updateDoc）共用同一份序列化/原子落盘逻辑，
  // 避免"全量写了 related、增量忘了写"这种静默陈旧（S1 截断事故的同类故障模式）。
  let relEdges = []
  // 计算期丢弃计数（S5 Task 6）：`stats().related.dropped` 的**唯一**来源。只在物化计算
  // （buildRelations / relateIncremental）里被重置并累加 —— 读时校验剔除**绝不**计入，
  // 否则同一库的 stats 会随查询历史漂移（spec §7.2，不可复现 = 指标失效）。
  let relDropped = { noShared: 0, missingEnd: 0, capped: 0 }
  // docs 的"代数"：docs 被整体替换（buildIndex / loadIndexFromDisk）或**原地改写**
  // （updateDoc 的 `docs[i] = 新doc`）时自增。读路径的缓存（块表 / 标题表）以此作键 ——
  // 不能用 `docs` 数组引用：updateDoc 原地改，引用不变，按引用缓存会取到已被替换的旧块，
  // 于是"块是否还存在"答错、读时校验静默失效。
  let docsGen = 0
  const _relateMode = resolveRelateMode(configDir, relateMode)
  const relateOn = () => _relateMode !== 'off'

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
    docsGen += 1 // docs 换了 → 读路径缓存（块表/标题表）失效
    idf = nextIdf
    inverted = nextInv
    linkOut = out
    // 关联物化必须在 `idf` 落定之后（relatedCandidates 用全库 idf 加权 shared 特征）；
    // 与 docs/inverted 同批落盘 → 与 `docs.jsonl`/`inverted.jsonl`/`links.jsonl` 同生命周期。
    buildRelations()
    persist(nextLinks)
  }

  /**
   * 索引唯一写入口（全量构建与增量更新共用）。
   * linkRows 由调用方传入：全量路径来自 scanAll，增量路径来自 lastLinkRows 的按文档替换
   * ——两条路径共用同一份序列化与原子落盘逻辑，不各写一套。
   */
  function persist(linkRows = lastLinkRows) {
    const on = relateOn() // 关联开关（每次读：config 机制单点判定，见 resolveRelateMode）
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
      // S5 §4.2：`related.jsonl` 的行数指纹。**为什么必须有**：S1 实测 inverted.jsonl 被
      // 截断后，解析仍是"合法但更少"的 postings —— 不报错，却让检索静默返回空集且永不重建。
      // 关联同理：少几行边不会报错，只会静默少锚点。off 模式**不写这个键**
      // （spec §10：off 等价 S4 行为，manifest 里不该出现关联痕迹，也不做校验）。
      ...(on ? { relLines: relEdges.length } : {}),
    }
    const tags = {}
    for (const d of docs) for (const t of d.tags) (tags[t] ||= []).push(d.id)
    const ser = serializeIndex({ docs: rows, inverted: inv, links: linkRows, tags, related: relEdges })
    const relNames = ['docs.jsonl', 'inverted.jsonl', 'links.jsonl', 'tags.json', 'manifest.json']
    try {
      mkdirSync(idxDir, { recursive: true })
      // 原子替换：先写 .tmp 再 rename（同 graph.mjs 手法）。
      // docs.jsonl 与 inverted.jsonl 必须同批落盘——postings 下标依赖 docs 行序。
      writeFileSync(file('docs.jsonl.tmp'), ser.docs, 'utf-8')
      writeFileSync(file('inverted.jsonl.tmp'), ser.inverted, 'utf-8')
      writeFileSync(file('links.jsonl.tmp'), ser.links, 'utf-8')
      writeFileSync(file('tags.json.tmp'), ser.tags, 'utf-8')
      writeFileSync(file('manifest.json.tmp'), JSON.stringify(manifest, null, 2), 'utf-8')
      // related.jsonl 只在 on 模式写：off 时**不落盘**（否则"不写文件"这句话就成了假的，
      // 半截文件还会活得像个有效物化）。
      if (on) {
        writeFileSync(file('related.jsonl.tmp'), ser.related, 'utf-8')
        relNames.push('related.jsonl')
      }
      for (const n of relNames) {
        renameSync(file(`${n}.tmp`), file(n))
      }
      builtAt = built
      lastFiles = files
      lastLinkRows = linkRows
      indexBytes = Buffer.byteLength(ser.docs, 'utf-8') + Buffer.byteLength(ser.inverted, 'utf-8')
        + Buffer.byteLength(ser.links, 'utf-8') + Buffer.byteLength(ser.tags, 'utf-8')
        + (on ? Buffer.byteLength(ser.related, 'utf-8') : 0)
    } catch { /* 磁盘不可写不致命：内存索引仍可用（对齐 graph.mjs 纪律） */ }
  }

  function loadIndexFromDisk() {
    const raw = (n) => { try { return readFileSync(file(n), 'utf-8') } catch { return '' } }
    const manifest = (() => { try { return JSON.parse(raw('manifest.json') || '{}') } catch { return {} } })()
    // 版本不符 → 返回 false 让上层重建（不抛错：旧索引是"过期派生物"，不是故障）
    if ((manifest.version ?? 0) !== INDEX_VERSION) return false
    docs = parseJsonl(raw('docs.jsonl'))
    docsGen += 1 // docs 换源（磁盘→内存）→ 读路径缓存失效
    if (!docs.length && (manifest.docs || 0) > 0) return false
    // 截断检测（见 persist 里 docLines/invLines 的注释）：实际条数少于记录值即为半写，
    // 判定损坏让上层重建。用 `<` 而非 `!==`——多出条目只可能是未来的增量追加，不算损坏。
    if (typeof manifest.docLines === 'number' && docs.length < manifest.docLines) return false
    const invRows = parseJsonl(raw('inverted.jsonl'))
    if (typeof manifest.invLines === 'number' && invRows.length < manifest.invLines) return false
    // S5 §4.2：related.jsonl 的行数指纹检查（与 docLines/invLines 同等对待）。
    // 判定条件刻意写成"指纹缺失 或 实际行数 < 记录值 → 重建"：
    //  - 实际行数 < 记录值：半写/截断（S1 的 inverted 截断事故同款）
    //  - 指纹缺失：off→on 切换、上一版索引、文件被误删 —— 无从证明文件完整，宁可重算
    // 用 `<` 而非 `!==` 与 docLines 同理（多出只可能是未来的增量追加，不算损坏）。
    if (relateOn()) {
      const relRows = parseJsonl(raw('related.jsonl'))
      if (typeof manifest.relLines !== 'number' || relRows.length < manifest.relLines) return false
      relEdges = relRows
    }
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
      + (relateOn() ? Buffer.byteLength(raw('related.jsonl'), 'utf-8') : 0)
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
    // 5) 关联锚点（S5 Task 6 / spec §7.2）：每个 item 增 `related` —— **只有摘要**
    //    （blockId/docId/title/why/score，见 relSummary），绝不含正文：S3 的教训是
    //    "顺手多带一点"会把上下文预算吃光（这一层是注入/agent 的直接来源）。
    //    接在 out（已过 topK/maxBytes）之后：不给被截断掉的候选白算，
    //    也保证 `related` 只在**真的会返回**的项上出现（附了也白附 = 白花开销）。
    //    off 模式**不带该字段**（字段形状也回滚到 S4，消费方按 `'related' in it` 判定即可）。
    if (relateOn() && out.length) {
      const table = readView().blocks
      for (const it of out) {
        // validate 缺省 true：物化必然陈旧（增量只补同 tag 入边），读侧不校验等于拿旧边糊人
        it.related = relatedOf(it.blockId, { validate: true, limit: SEARCH_RELATED_TOPN, lookup: table })
      }
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

  // ── 关联物化（S5 Task 4/5；spec §4/§5/§6）──────────────────────────────────
  // 派生数据，只落 `.index/related.jsonl`：**绝不改用户 .md**（全局约束 1）。

  /** 边的主键：`from`/`to` 里可能含任意字符，用 NUL 分隔避免拼接歧义。 */
  const relKey = (from, to) => `${from}\u0000${to}`

  /**
   * blockId → 所属 docId。blockId = `<docId>#<n>`，docId 自身不含 '#'（spaceId/relPath），
   * 故取**最后一个** '#' 之前的部分（与 shared 的 posOf 同款口径，别改成 indexOf）。
   */
  function docIdOfBlockId(bid) {
    const s = String(bid ?? '')
    const i = s.lastIndexOf('#')
    return i < 0 ? s : s.slice(0, i)
  }

  /**
   * 参与集（spec §5.1）：`kind === 'entry'` 且 `relationContent` 长度 ≥ `MIN_LEN`。
   * 顺带预计算 `relContent` / `gramCounts`：`relatedCandidates` 对同一个块会被 pool 里
   * 每个成员各取用一次，不预计算就是 O(N²) 次切词（真实库 76 条 ≈ 5776 次，纯浪费）。
   * 存量垃圾条目（模板化空内容）在这里被挡掉——源头修复（Task 3）只防"新产生"。
   */
  function relatablePool() {
    const out = []
    for (const d of docs) {
      for (const b of d.blocks) {
        if (b.kind !== 'entry') continue
        const content = relationContent(b)
        if (content.length < MIN_LEN) continue
        out.push({
          blockId: toBlockId(d.id, b.n), docId: d.id, n: b.n, tag: b.tag || null,
          text: b.text, full: b.full || null, spaceId: d.spaceId,
          relContent: content, gramCounts: countGrams(content),
        })
      }
    }
    return out
  }

  /**
   * 关联层**专用**的 IDF（S5 二次校准修正，spec §13.5）：按**文档**聚合，不是按块。
   *
   * **为什么不复用检索那份 `idf`（kernel 里 buildIndex 的 `nextIdf`）**：那份是按**块**统计
   * （每块一个 gramCounts）。按块统计时同一篇文档的内容被切成多份，高频词的 df 增长快于
   * 文档数 N → 常见词权重被抬高 → 向量平均化 → 区分度下降。实测同一真实库（69 条参与条目、
   * 跨 tag 对）两种口径下的最高 cos：
   *   | idf 口径            | 跨 tag 最高 cos | ≥0.32 命中 | ≥0.15 命中 | 覆盖条目 |
   *   | 按块（检索口径）    | **0.238**       | 0          | 2          | 4/69     |
   *   | 按文档（本函数）    | **0.312**       | 0          | 16         | 18/69    |
   * 首轮校准用的是 `blockIndexText` 的 gram 建 idf（与 Task 2 落地后的线上口径
   * `relationContent` 不同源），把阈值定在 0.32 —— 两种口径下 0.32 都命中 **0 对**
   * （覆盖层空转 = 功能失效），这就是本函数存在的原因。
   *
   * **检索的 idf 一行都不改**（buildIndex 里那份保持按块）：口径换了会让既有检索排序/
   * `score` 全部漂移，而关联只是派生数据。两边独立 → 零检索回归风险。
   *
   * 性能：一次 O(块数) 扫描（与 `relatablePool` 同阶），无重复扫描。
   */
  function buildRelIdf() {
    const perDoc = []
    for (const d of docs) {
      const m = new Map()
      for (const b of d.blocks) {
        for (const [g, c] of countGrams(relationContent(b))) m.set(g, (m.get(g) || 0) + c)
      }
      perDoc.push({ gramCounts: m }) // 每篇文档一个样本（不是每块一个）
    }
    return buildIdf(perDoc)
  }

  /**
   * 全量物化（spec §6.1 全量）：算参与集里每条条目的锚点，再补镜像，最后落 `relEdges`。
   *
   * **why 双向**：`related(blockId)` 是"给我这条的**所有**锚点"，有向图会让这个查询退化
   * 成全表扫描（spec §3）。镜像单独一轮（而不是边算边加）是为了让**正向算出的 why 优先**
   * ——同一对若两个方向都算出来，保留先到的那行，结果与迭代顺序绑定但完全可复现
   * （物化要求：同一库两次重建产出同一份 related.jsonl）。
   */
  function buildRelations() {
    if (!relateOn()) { relEdges = []; return }
    relDropped = { noShared: 0, missingEnd: 0, capped: 0 } // 本次物化的丢弃计数（见 relDropped 声明）
    const pool = relatablePool()
    const relIdf = buildRelIdf() // 关联层独立口径（按文档，见 buildRelIdf 的 why）
    const sig = new Map(pool.map((b) => [b.blockId, blockContentSig(b)]))
    // 关联只在**同空间**内建立（spec 非目标：不做跨空间隐式关联）
    const bySpace = new Map()
    for (const b of pool) {
      const arr = bySpace.get(b.spaceId)
      if (arr) arr.push(b)
      else bySpace.set(b.spaceId, [b])
    }
    const rows = []
    const seen = new Set()
    const add = (from, to, why) => {
      const k = relKey(from, to)
      if (seen.has(k)) return
      if (!sig.has(from) || !sig.has(to)) { relDropped.missingEnd += 1; return } // 端点必须仍在参与集内
      seen.add(k)
      rows.push({ from, to, why, sigFrom: sig.get(from), sigTo: sig.get(to) })
    }
    for (const b of pool) {
      for (const c of relatedCandidates(b, bySpace.get(b.spaceId) || [], {
        idf: relIdf, topN: 5, minScore: SIM_THRESHOLD, dropped: relDropped,
      })) add(b.blockId, c.to, c.why)
    }
    // 镜像轮：`from→to` 与 `to→from` 各一行（why 对称：tag/content/duplicate 三类都只用
    // 两端共有的信息，故原样复制；sig 互换方向）
    for (const r of rows.slice()) {
      const k = relKey(r.to, r.from)
      if (seen.has(k)) continue
      seen.add(k)
      rows.push({ from: r.to, to: r.from, why: r.why, sigFrom: r.sigTo, sigTo: r.sigFrom })
    }
    relEdges = rows
  }

  /**
   * 增量（S5 Task 5，spec §6.1 折中方案）：只重算**本文档**条目的出边 + 同 tag 的入边。
   *
   * ① 旧行沿用：只丢"本文档的出边"（要重算）与"端点已消失"的边（块被删 → 物化侧不保留
   *    已消失的端点）；**其余原样保留（含物化时的 sigFrom/sigTo）**——绝不能借 add() 把
   *    指纹刷成当前内容，那会让"内容已改但边还在"的陈旧边看起来是新鲜的，
   *    读时校验（Task 6）就再也拦不住它了。
   * ② 出边：`relatedCandidates` 现算（索引已更新，旧出边可能失效）。
   * ③ 入边：只补**同 tag** 的（这些必然是 tag 边，同 tag 关系在文档更新后仍成立）。
   *    content 类入边不即时重算 —— 已知取舍（spec §6.1，用户已确认）：最坏到下次全量重建
   *    才补齐。换来的是"改一个文件不必扫全库内容相似度"。
   * ④ 反向封闭：物化的不变量是"行集对反向封闭"（全量路径的镜像轮保证同一件事），
   *    补完新边后跑一次闭包，两个方向才都查得到。
   *
   * tag→块 的查找：本地一次遍历建 `Map<tag, block[]>`（O(块数)），随后只对**本文档**的
   * tag 做查表（O(本文档条目数 × 同 tag 条目数)）。**禁止**对每个 tag 各扫一遍全库
   * （O(tags × blocks)）。
   */
  function relateIncremental(newDocId) {
    if (!relateOn()) { relEdges = []; return }
    // 丢弃计数按"本次增量重算了多少候选"重置（spec §7.2 的 dropped 是计算期量，
    // 增量不重算的那部分自然不计 —— 不重算就不该编造数字）
    relDropped = { noShared: 0, missingEnd: 0, capped: 0 }
    const pool = relatablePool()
    // 与全量路径**同一份口径**（按文档 idf）：增量若用检索那份按块 idf，同一条目在
    // 改文件前后会算出不同分数，出现"改一个文档 → 锚点分数跳变"的诡异现象（spec §13.5）
    const relIdf = buildRelIdf()
    const sig = new Map(pool.map((b) => [b.blockId, blockContentSig(b)]))
    const byTag = new Map() // tag -> block[]（本次增量共用的一份内存缓存）
    for (const b of pool) {
      if (!b.tag) continue
      const arr = byTag.get(b.tag)
      if (arr) arr.push(b)
      else byTag.set(b.tag, [b])
    }
    const own = pool.filter((b) => b.docId === newDocId)
    const rows = []
    const seen = new Set()
    const add = (from, to, why) => {
      const k = relKey(from, to)
      if (seen.has(k)) return
      if (!sig.has(from) || !sig.has(to)) { relDropped.missingEnd += 1; return }
      seen.add(k)
      rows.push({ from, to, why, sigFrom: sig.get(from), sigTo: sig.get(to) })
    }
    // ① 旧行沿用（含物化时的原始指纹，见本函数 why 的①）
    for (const r of relEdges) {
      if (docIdOfBlockId(r.from) === newDocId) continue
      if (!sig.has(r.from) || !sig.has(r.to)) continue
      const k = relKey(r.from, r.to)
      if (seen.has(k)) continue
      seen.add(k)
      rows.push(r)
    }
    // ② 本文档条目的出边重算（池 = 同空间参与集）
    const ownSpace = (docs.find((d) => d.id === newDocId) || {}).spaceId
    const spaceMates = pool.filter((b) => b.spaceId === ownSpace)
    for (const b of own) {
      for (const c of relatedCandidates(b, spaceMates, { idf: relIdf, topN: 5, minScore: SIM_THRESHOLD, dropped: relDropped })) {
        add(b.blockId, c.to, c.why)
      }
    }
    // ③ 同 tag 入边补充：同 tag 的**其它条目** → 本文档条目（必然 tag 边）
    for (const b of own) {
      if (!b.tag) continue
      for (const other of byTag.get(b.tag) || []) {
        if (other.blockId === b.blockId) continue
        add(other.blockId, b.blockId, { kind: 'tag', tag: b.tag })
      }
    }
    // ④ 反向封闭（沿用各行的原始指纹，别用现算的——见①的 why）
    for (const r of rows.slice()) {
      const k = relKey(r.to, r.from)
      if (seen.has(k)) continue
      seen.add(k)
      rows.push({ from: r.to, to: r.from, why: r.why, sigFrom: r.sigTo, sigTo: r.sigFrom })
    }
    relEdges = rows
  }

  // ── 关联读取（S5 Task 6；spec §6.2 / §7.2）──────────────────────────────────
  // "快"由物化负责（Task 4/5），"对"由**读时校验**负责：增量只补同 tag 入边、content 类入边
  // 要等下次全量重建才补齐（spec §6.1），所以物化行**必然会陈旧**。读侧逐边校验三条
  // （端点存在 / tag 相等 / 内容指纹一致）把失效边从**视图**里剔掉。
  // **只读语义**：不改文件、不改 relEdges、不计入 stats（spec §7.2：否则同一库的 stats 会
  // 随查询历史漂移，不可复现）。

  /**
   * 边按 `from` 分组（读路径用）。缓存键取 `relEdges` 的**引用**：所有写路径
   * （buildIndex / relateIncremental / loadIndexFromDisk）都整体重绑 `relEdges`，
   * 引用一变缓存即失效 —— 比按行数/内容做键更省，也不会漏。
   */
  let relGroupCache = null
  function relGroupedByFrom() {
    if (relGroupCache && relGroupCache.edges === relEdges) return relGroupCache.map
    const map = new Map()
    for (const r of relEdges) {
      const arr = map.get(r.from)
      if (arr) arr.push(r)
      else map.set(r.from, [r])
    }
    relGroupCache = { edges: relEdges, map }
    return map
  }

  /** 读路径的块表与文档标题表（缓存键 = docsGen，理由见其声明）。 */
  let readViewCache = null
  function readView() {
    if (readViewCache && readViewCache.gen === docsGen) return readViewCache
    const blocks = new Map()
    const titles = new Map()
    for (const d of docs) {
      titles.set(d.id, d.title)
      for (const b of d.blocks) blocks.set(toBlockId(d.id, b.n), b)
    }
    readViewCache = { gen: docsGen, blocks, titles }
    return readViewCache
  }

  // 排序键：骨架层（tag，必然非空零噪声）→ 覆盖层（content，分数降序）→ 重复（最后）。
  // 与 `relatedCandidates` 的层序一致；同层内保持物化顺序（sort 稳定 + 物化可复现），
  // 不另造一套排序口径（两套排序必然漂移）。
  const relRank = (r) => (r?.why?.kind === 'tag' ? 0 : r?.why?.kind === 'content' ? 1 : 2)
  const relScore = (r) => (typeof r?.why?.score === 'number' ? r.why.score : 0)

  /** `why` 深一层拷贝：返回值可能被 GUI/agent 改写，不能让它穿到 `relEdges` 内部。 */
  const whyCopy = (why) => (why && typeof why === 'object'
    ? { ...why, ...(Array.isArray(why.shared) ? { shared: [...why.shared] } : {}) }
    : why)

  /**
   * 边 → 锚点摘要。**绝不含正文**：只有 `{blockId, docId, title, why, score}`（spec §7.2）。
   * **why 必带**：锚点的价值在"为什么连上"（tag 值 / shared 共有特征字），无 why 的锚点
   * 与随机跳转无异；`score` 仅 content/duplicate 有，tag 边给 null（不编造分数）。
   */
  function relSummary(row, view) {
    const to = String(row.to || '')
    const docId = docIdOfBlockId(to)
    return {
      blockId: to, docId, title: view.titles.get(docId) || '',
      why: whyCopy(row.why), score: typeof row.why?.score === 'number' ? row.why.score : null,
    }
  }

  /**
   * `getRelated` 的内核。`lookup` 允许调用方（search）复用同一次块表 —— 一次检索要对多个
   * item 各查一次，每查各建一张表是 O(items × 块数) 的纯浪费。
   */
  function relatedOf(blockId, { validate = true, limit = MAX_RELATED, lookup = null } = {}) {
    const id = String(blockId ?? '')
    if (!id) return []
    // 双向物化（buildRelations 的镜像轮）⇒ 直接按 `from === blockId` 取即可，无需全表扫
    const rows = relGroupedByFrom().get(id) || []
    if (!rows.length) return []
    // ① 读时校验（只读）：端点消失 / tag 变了 / 内容变了 ⇒ 从视图剔除，物化文件与 relEdges 不动
    const table = validate ? (lookup || readView().blocks) : null
    const live = table ? rows.filter((r) => validateRelation(r, table)) : rows
    const n = Number(limit)
    const lim = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : MAX_RELATED
    const sorted = [...live].sort((a, b) => relRank(a) - relRank(b) || relScore(b) - relScore(a))
    const nonDup = sorted.filter((r) => r.why?.kind !== 'duplicate')
    const dups = sorted.filter((r) => r.why?.kind === 'duplicate')
    const view = readView()
    // ② `limit` 只约束"关联"（tag/content）；duplicate **不计入**预算、追加在末尾并保持
    //    可区分（`why.kind === 'duplicate'`）—— 与 `relatedCandidates` 的 MAX_RELATED 口径
    //    一致（spec §5.5）：重复项要在 GUI/agent 侧**独立**呈现，不能被关联预算饿死。
    return [...nonDup.slice(0, lim), ...dups].map((r) => relSummary(r, view))
  }

  /**
   * 该块的**全部**锚点（spec §7.1/§7.2）。
   * @param validate 缺省 true：逐边三校验（端点存在 / tag 相等 / 内容指纹一致）。
   *   显式传 false 得到"未校验视图"（调试用：看物化里到底存了什么）。
   * @param limit 关联条数上限（缺省 MAX_RELATED），duplicate 不占该预算（见 relatedOf ②）。
   * off 模式（`knowledgeRelateMode: 'off'`）下 `relEdges` 恒为空 ⇒ 返回 []（等价 S4：无关联概念）。
   */
  function getRelated(blockId, { validate = true, limit = MAX_RELATED } = {}) {
    return relatedOf(blockId, { validate, limit })
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
    docsGen += 1 // 原地替换也算新代数（见 docsGen 声明处的 why）

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
    // 关联增量：必须在 docs[i] 与 inverted 都已更新之后（出边依赖新索引与新块集），
    // 且在 persist() 之前（persist 是唯一写入口，relLines 由它回写）。
    relateIncremental(docId)
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
    /** 该块的关联锚点（读时校验视图；spec §7.1/§7.2）。Task 7/8 的 CLI/路由直接转发本口。 */
    getRelated,
    updateDoc, getDoc, listEntries, listTree, getLinks, getGraph,
    getDocs() { return docs },
    getIdf() { return idf },
    getInverted() { return inverted },
    getLinkOut() { return linkOut },
    /** `knowledgeRelateMode` 的生效值（'on'|'off'）——Task 6/10 的读写口都以此为准 */
    getRelateMode() { return _relateMode },
    stats() {
      const sorted = [...searchTimes].sort((a, b) => a - b)
      // S5 §7.2：关联层观测。四个 `*Edges` 一律数 `related.jsonl` 的**物化行数**（按 why.kind
      // 分类，含镜像行 —— 行数就是文件行数，可比对 `relLines`）；`dropped` 只数**计算期**丢弃
      // （shared 为空 / 端点消失 / 超上限截断）。
      // **不含读时校验剔除数**：读侧 validate 返回的是"视图"、属只读行为，计入会让同一库的
      // stats 随查询历史漂移（不可复现 ⇒ 指标失效）。这条是 spec 定死的，别"顺手补全"。
      const rc = { edges: 0, tagEdges: 0, contentEdges: 0, dupEdges: 0 }
      for (const r of relEdges) {
        rc.edges += 1
        const k = r?.why?.kind
        if (k === 'tag') rc.tagEdges += 1
        else if (k === 'content') rc.contentEdges += 1
        else if (k === 'duplicate') rc.dupEdges += 1
      }
      return {
        version: INDEX_VERSION, docs: docs.length,
        blocks: docs.reduce((s, d) => s + d.blocks.length, 0),
        grams: inverted.size, spaces: spaces.length,
        builtAt, indexAgeMs: builtAt ? Date.now() - Date.parse(builtAt) : null,
        indexBytes,
        // S3 §6：检索耗时分布（进程内样本；跨进程见 .index/metrics.json）
        search: { count: sorted.length, elapsedP50: pct(sorted, 0.5), elapsedP95: pct(sorted, 0.95) },
        // off 模式恒为全 0（relEdges 为空）：字段形状保持稳定，消费方不必分支
        related: { ...rc, dropped: relDropped.noShared + relDropped.missingEnd + relDropped.capped },
      }
    },
  }
}
