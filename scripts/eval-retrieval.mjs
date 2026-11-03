// scripts/eval-retrieval.mjs —— 检索质量量尺（P0，2026-09-18）
// ---------------------------------------------------------------------------
// **为什么需要它**：本仓库的检索测试全是"不变量断言"（形状/边界/降级），**没有一条排序质量
// 断言** —— 于是任何改动打分公式的工作都只能靠体感判断好坏，无法区分"变好了"与"换了个样本"。
// 来源材料（AI Engineer 2026 / SIGIR'26）反复强调"你说的到底是哪个 BM25、参数差十几个点"，
// 那些数字全部来自**各自的评测集**；本库没有评测集，就不该照搬它们的参数结论。
//
// 本脚本提供**可复现、可 diff** 的排序质量基线：
//   ① 金标集**自动构造**：对每个块取"稀有的块级 gram"贪心求交，直到交集只剩它自己 ——
//      正解由**语料自身唯一确定**，无需人工标注，判定是逐字的（不是主观相关度）；
//   ② 两类用例：`precise`（纯稀有词组合，测"能不能找到"）与 `noisy`（额外掺一个全库高频词，
//      测"排序能不能把正确块顶上来"）。**只有 precise 会退化成满分**（稀有词组合几乎必命中），
//      掺噪声才是区分排序质量的那一半；
//   ③ 分空间 × 块类型分层抽样 + 每文档配额，避免全抽到 entry 或某一篇长文档占满；
//   ④ 负例集（必无命中）：由"倒排里不存在的 gram"拼成，盯"降级路捞回一堆无关结果"这类老问题
//      —— 假阳性比漏召回更伤人（用户会以为搜索坏了）；
//   ⑤ 语料指纹（docs/blocks/grams/digest）：**跨语料不可比**，指纹不同时 diff 无意义。
//
// 用法：
//   node scripts/eval-retrieval.mjs                      # 默认配置根，跑 150 例
//   node scripts/eval-retrieval.mjs --limit 300 --topk 10
//   node scripts/eval-retrieval.mjs --baseline <file>    # 与既有基线对比（P1 之后用）
//   node scripts/eval-retrieval.mjs --summary-out <file> # 只写聚合（无 query 原文，可入库）
//
// **隐私**：`--out`（完整 JSON，含 query 原文 = 语料里的词）默认写系统临时目录；
// 想入库请用 `--summary-out`（只有聚合指标与语料指纹）。
//
// **口径纪律**：`indexTextOf` 必须与 kernel/knowledge.mjs 的同名函数逐字同口径
// （见 kernel/knowledge.mjs:561）—— 它决定"哪些 gram 在该块里"。改了 kernel 的口径，
// 这里要跟着改；脚本另有两道自愈：候选 gram 必须在 `store.getInverted()` 里存在
// （剪枝/口径漂移导致的缺失计入 skipped 而非 miss），且 `invertedCoverage` 诊断会显示
// "重建的块级 gram 有多少能在倒排里找到"（口径漂移会让它显著下降）。
import { homedir, tmpdir } from 'node:os'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import { resolveConfigDir } from '../kernel/config.mjs'
import {
  countGrams, retrievalText, blockIndexText, toBlockId, hashLine,
} from '../shared/knowledge-core.mjs'

/** 与 kernel/knowledge.mjs:561 的 indexTextOf **同口径**（改动必须同步，见文件头）。 */
function indexTextOf(b) {
  return blockIndexText({ kind: b.kind, text: retrievalText(b), entryTag: b.tag })
}

/** 确定性 PRNG（mulberry32）：同一 seed 必须给出同一套用例，否则基线不可比。 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates（用给定 rng）：原地打乱数组并返回它。 */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}

/** 小集合求交（按小的那个遍历）：组合收敛的基本操作，调用量在采样期是 O(块数 × 词数)。 */
function intersectSet(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  const out = new Set()
  for (const x of small) if (big.has(x)) out.add(x)
  return out
}

/**
 * 自动构造金标用例（两类）。
 *
 * **为什么不用"df==1 的单个 gram"**：中文语料的 2-gram 区分度太低 —— 实测本机 238 篇 / 6917 块，
 * **块级 df==1 的 gram 数为 0**（"公司""申报"这类 bigram 遍地都是）。单 gram 方案在中文语境下
 * 直接构造不出用例。故改用**组合求交**：从该块最稀有的 gram 开始逐个与候选块集合求交，
 * 交集收敛到 {该块} 时停止 —— 这既天然是多词查询（贴近真实用法），又给出**客观唯一**的正解。
 *
 * 两类用例的分工见文件头 ②：`precise` 是下限（能不能找到），`noisy` 才是区分度所在。
 */
export function buildGoldCases(store, {
  limit = 150, seed = 20260918, spaces = null, maxTerms = 4, rareCap = 200, noisyRatio = 0.4,
  // 金标词的最小 df（**块级**，含该 gram 的块数）。缺省 2 —— 这个阈值不是调参，是**样本可信度**：
  // 诊断（scratch/diag-len.mjs）显示 miss 用例 **19/19 全是 noisy**，且首个词清一色是
  // 跨词边界的假 bigram（`env中`、`团自`、`与法`、`spec确`、`release沉`、`48022010照`…）。
  // 成因：df=1 的 gram 在中文语料里几乎必然是"两个词被切开后拼在一起"的噪音片段
  // （真实的词/编号会在语料里重复出现），而"稀有"判据恰好优先挑中它们 ——
  // 于是量尺把"检索对跨界噪音片段不敏感"误报成"引擎召回不足"。
  // 真实用户不会这样输入，故这类用例不该参与质量判定（它们仍可作为"极端输入不崩"的冒烟）。
  minDf = 2,
} = {}) {
  const allow = Array.isArray(spaces) && spaces.length ? new Set(spaces) : null
  const docs = store.getDocs() || []
  const inverted = store.getInverted()
  // ⚠ 倒排的 key 是 **gram 的 hashLine 值**（见 kernel/knowledge.mjs:685 附近的
  // `vectorizeText` → `vectorizeText` 内部 `hashLine(gram)`），**不是 gram 文本** ——
  // 直接用文本查 `inverted.has(g)` 会恒为 false（实测踩过：构造出 0 个用例，倒排覆盖 0%）。
  const visible = (g) => inverted.has(hashLine(g))
  const blocks = []
  const gramDf = new Map()
  for (const d of docs) {
    if (allow && !allow.has(d.spaceId)) continue
    for (const b of d.blocks || []) {
      const grams = [...countGrams(indexTextOf(b)).keys()]
      const idx = blocks.length
      blocks.push({ idx, docId: d.id, spaceId: d.spaceId, kind: b.kind || 'para', key: toBlockId(d.id, b.n), grams })
      for (const g of grams) gramDf.set(g, (gramDf.get(g) || 0) + 1)
    }
  }
  const stats = {
    blocks: blocks.length, skippedNoGram: 0, skippedNotUnique: 0,
    gramVisible: 0, gramTotal: 0, minDf,
  }
  if (!blocks.length) return { cases: [], ...stats }

  // 只对"稀有 gram"（块数 <= rareCap）建候选块集合：全建会吃掉几百 MB，而稀有 gram 才是收敛动力。
  const gramBlocks = new Map()
  for (const blk of blocks) {
    for (const g of blk.grams) {
      if (gramDf.get(g) > rareCap) continue
      let s = gramBlocks.get(g)
      if (!s) gramBlocks.set(g, s = new Set())
      s.add(blk.idx)
    }
  }

  const rng = mulberry32(seed)
  // 噪声词池：全库高频且在倒排里存在（能真的产生大量候选，而不是"不存在的词=无干扰"）
  const noiseMin = Math.max(4, Math.floor(blocks.length * 0.02))
  const noisePool = [...gramDf.entries()]
    .filter(([g, v]) => v >= noiseMin && visible(g))
    .map(([g]) => g)
    .sort()

  const buckets = new Map()
  for (const blk of blocks) {
    const cands = blk.grams.filter((g) => {
      const d = gramDf.get(g)
      return d >= minDf && d <= rareCap && visible(g)
    })
    stats.gramTotal += blk.grams.length
    stats.gramVisible += cands.length
    if (!cands.length) { stats.skippedNoGram += 1; continue }
    // 稀有优先（df 升序），并列按字典序 → 组合结果与 rng 无关地确定
    cands.sort((a, b) => (gramDf.get(a) - gramDf.get(b)) || (a < b ? -1 : a > b ? 1 : 0))
    const bk = `${blk.spaceId}\u0000${blk.kind}`
    if (!buckets.has(bk)) buckets.set(bk, [])
    buckets.get(bk).push({ blk, cands })
  }

  const lists = [...buckets.values()].map((list) => shuffle(list, rng))
  const perDocCap = Math.max(2, Math.ceil(limit / 10))
  const docUsed = new Map()
  const cases = []
  let progress = true
  while (cases.length < limit && progress) {
    progress = false
    for (const list of lists) {
      if (cases.length >= limit) break
      while (list.length) {
        const item = list.shift()
        const used = docUsed.get(item.blk.docId) || 0
        if (used >= perDocCap) continue
        const terms = composeTerms(item, gramBlocks, maxTerms)
        if (!terms) { stats.skippedNotUnique += 1; continue }
        docUsed.set(item.blk.docId, used + 1)
        const noisy = (cases.length % 10) < Math.round(noisyRatio * 10) && noisePool.length > 0
        let query = terms.join(' ')
        if (noisy) {
          const own = new Set(item.blk.grams)
          for (let t = 0; t < 8; t++) {
            const g = noisePool[Math.floor(rng() * noisePool.length)]
            if (!own.has(g)) { query = `${query} ${g}`; break }   // 噪声词**不在**正确块内：真干扰
          }
        }
        cases.push({
          query, expect: item.blk.key, docId: item.blk.docId, spaceId: item.blk.spaceId,
          kind: item.blk.kind, type: noisy ? 'noisy' : 'precise', terms: terms.length,
        })
        progress = true
        break
      }
    }
  }
  return { cases, ...stats }
}

/** 贪心组合：从该块最稀有 gram 起求交，收敛到"只剩它自己"才算成功（否则该块不适合作金标）。 */
function composeTerms(item, gramBlocks, maxTerms) {
  const { blk, cands } = item
  let cur = null
  const used = []
  for (const g of cands) {
    if (used.length >= maxTerms) break
    const s = gramBlocks.get(g)
    if (!s) continue
    cur = cur ? intersectSet(cur, s) : s
    used.push(g)
    if (cur.size === 1 && cur.has(blk.idx)) break
  }
  if (!used.length) return null
  if (!(cur && cur.size === 1 && cur.has(blk.idx))) return null
  return used
}

/**
 * 字段词查询集（`field`）：从块的**标签 / 小节标题**里取词，正解=该块。
 *
 * **为什么必须单列这一类**（2026-09-18 补）：实测发现 BM25F 的字段加权在
 * "稀有 gram 组合"式用例上**完全测不出来**（fw 从 (1,1,1) 到 (20,8,4)，recall 恒定），
 * 但直接构造"词落在 tag 里"的查询时它明确生效（分数 0.565→0.583、排名 3→2）。
 * 也就是说：不是字段加权无用，而是**原用例集的词从不落在字段上**（稀有 gram 几乎都出自正文）。
 * 一个测不到被改特性的量尺会给出"无收益"的错误结论 —— 故补这一类。
 *
 * 这类查询同时也是**最贴近真实用法**的一类：用户/模型常按主题词提问
 * （"盖章扫描化"、"科技人员核实"），而标签恰恰是作者手工提炼的主题词。
 */
export function buildFieldCases(store, { limit = 40, seed = 20260920, spaces = null, minLen = 3 } = {}) {
  const allow = Array.isArray(spaces) && spaces.length ? new Set(spaces) : null
  const docs = store.getDocs() || []
  const pool = []
  const termBlocks = new Map()
  for (const d of docs) {
    if (allow && !allow.has(d.spaceId)) continue
    for (const b of d.blocks) {
      const tag = String(b.tag || '')
      const head = String(b.heading || '')
      for (const src of [tag, head]) {
        if (!src) continue
        // 取标签/标题里的中文片段（≥3 字）：`会话|盖章扫描化` → `盖章扫描化`。
        // 太短的串（2 字）区分度低，会让"命中"变成巧合。
        for (const m of src.matchAll(/[一-龥]{2,}/g)) {
          if (m[0].length < minLen) continue
          const key = m[0]
          if (!termBlocks.has(key)) termBlocks.set(key, new Set())
          termBlocks.get(key).add(`${d.id}#${b.n}`)
        }
      }
    }
  }
  // 只保留"指向少量块"的词：指向太多块的词（如"管理办法"）没有唯一正解，判不了对错
  for (const [term, blocks] of termBlocks) {
    if (blocks.size >= 1 && blocks.size <= 4) pool.push({ term, blocks: [...blocks] })
  }
  const rng = mulberry32(seed)
  const picked = []
  const used = new Set()
  for (const p of shuffle(pool, rng)) {
    if (picked.length >= limit) break
    if (used.has(p.term)) continue
    used.add(p.term)
    const expect = p.blocks[Math.floor(rng() * p.blocks.length)]
    const [docId, n] = [expect.slice(0, expect.lastIndexOf('#')), expect.slice(expect.lastIndexOf('#') + 1)]
    // **不设 kind**：字段词可能来自任意块类型的 tag/heading，硬标一个类型会让
    // "按块类型"的统计被这批用例污染（踩过：40 条 field 全被记成 entry，
    // 于是 entry 那一行看起来有 48 例，其实多数不是 entry 用例）
    picked.push({ query: p.term, expect, docId, type: 'field', terms: 1 })
  }
  return { cases: picked, pool: pool.length }
}

/**
 * 真实话术查询集（`human`）：**手工写**的短查询，正解是"该找哪篇文档"（文档级判定）。
 *
 * **为什么必须有这一组**：自动集（precise/noisy）的 query 是"从语料里反推出来的词"，
 * 天然与被索引文本同分布 —— 它们测的是**引擎的定位能力**，但测不到"用户真实会怎么问"。
 * 真实查询是短的、口语的、缺词的（"新能源汽车 车船税 优惠"而不是"调整节能汽车、新能源汽车
 * 车船税优惠政策的公告"）。两组数值的**差距本身**就是信号：差距大说明检索对"用户话术"不友好
 * （该靠字段建模与可解释回执去补，而不是靠改 BM25 参数）。
 *
 * **判定的主观性怎么处理**：正解用"文档路径子串"而非块 —— "找对文档"是客观可判的
 * （那篇政策确实讲这事），"找对块"则涉及主观取舍。且这组**只作参考**，不作为 P1 的
 * 通过/不通过门禁（门禁只看自动集，见 diffSummary 的 regression）。
 */
export const HUMAN_QUERIES = [
  { query: '新能源汽车 车船税 优惠', expectDoc: '调整节能汽车、新能源汽车车船税优惠政策的公告' },
  { query: '服务业发展资金 管理办法', expectDoc: '服务业发展资金管理办法' },
  { query: '专项债券 自审自发 试点', expectDoc: '自审自发' },
  { query: '设备更新贷款 贴息', expectDoc: '设备更新贷款财政贴息政策' },
  { query: '中小微企业贷款 贴息', expectDoc: '中小微企业贷款贴息政策' },
  { query: '科技创新 进口 税收优惠', expectDoc: '支持科技创新进口税收优惠政策' },
  { query: '跨境电商 出口退运', expectDoc: '跨境电子商务出口退运商品税收优惠政策' },
  { query: '广交会 进口展品 税收优惠', expectDoc: '十五五”期间广交会展期内销售的进口展品税收优惠政策明确' },
  { query: '农村综合改革 转移支付', expectDoc: '农村综合改革转移支付资金管理办法' },
  { query: '高中 办学条件 补助资金', expectDoc: '改善普通高中学校办学条件补助资金管理办法' },
  { query: '四表联动 交叉校验', expectDoc: 'experience/project-application.md' },
  { query: '发票 PS 匹配', expectDoc: 'experience/project-application.md' },
  { query: '引擎 冒烟 安装包', expectDoc: 'experience/workflow.md' },
  { query: 'PDF 压缩 水印去除', expectDoc: 'experience/office-docs.md' },
]

/** 真实查询用例：期望文档不在语料里就**跳过**（换机器/换库时不该把"库里没有"算成 miss）。 */
export function buildHumanCases(store, list = HUMAN_QUERIES) {
  const docs = store.getDocs() || []
  const cases = []
  const skipped = []
  for (const h of list) {
    const hit = docs.find((d) => String(d.id).includes(h.expectDoc))
    if (!hit) { skipped.push({ query: h.query, expectDoc: h.expectDoc }); continue }
    cases.push({ query: h.query, expectDoc: h.expectDoc, docId: hit.id, type: 'human', terms: 0 })
  }
  return { cases, skipped }
}

/**
 * 负例集：**必须无命中**的查询。
 *
 * 构造方式 = 用不常见汉字随机拼接 / 随机拉丁串，并**逐个校验其 gram 不在倒排里** ——
 * 只有这样才能断言"命中即假阳性"。若随便拿个不存在的词，可能恰好含某个真实 gram 而"合理地"
 * 命中，那就不是假阳性了（本函数把这种候选直接丢掉重抽）。
 */
export function buildNegativeCases(store, { count = 12, seed = 7 } = {}) {
  const inverted = store.getInverted()
  const rng = mulberry32(seed)
  const HAN = '鑫淼焱垚犇骉翀翯龘齉爨纛彧珩琞燚妤姽婳龑'
  const out = []
  let guard = 0
  while (out.length < count && guard++ < 800) {
    const q = out.length % 2 === 0
      ? Array.from({ length: 6 }, () => HAN[Math.floor(rng() * HAN.length)]).join('')
      : `zq${Math.floor(rng() * 1e8).toString(36)}xv`
    if ([...countGrams(q).keys()].some((g) => inverted.has(hashLine(g)))) continue
    out.push(q)
  }
  return out
}

function pct(sorted, p) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0
}

function timeIt(fn) {
  const t0 = Date.now()
  const r = fn()
  return { r, ms: Date.now() - t0 }
}

/** 分组命中率（按 kind / space / type 同款聚合）。 */
function rateOf(map) {
  return Object.fromEntries(Object.entries(map)
    .map(([k, v]) => [k, { n: v.n, hit: v.hit, recall: v.n ? v.hit / v.n : 0 }])
    .sort((a, b) => b[1].n - a[1].n))
}

/**
 * 跑评测并产出指标。`maxBytes` 缺省**不限**（测纯排序质量）；想测真实回执预算就传 2048
 * （内核缺省），那是另一组数字 —— 两者不能混着比。
 */
export function runEval({
  store, cases, negatives = [], topK = 5, maxBytes = Number.MAX_SAFE_INTEGER, warmup = 3,
  // 透传给 store.search 的额外参数（P1 标定用：`{ bm25: { k1, b, sat } }` 在同一进程内
  // 换参数跑多组，避免"一组一个进程"把索引加载时间乘上组数）
  searchOpts = {},
} = {}) {
  // 预热：首次检索要建读视图缓存（块表/标题表），不预热会把冷启动算进 P95
  const warm = cases[0] || negatives[0]
  for (let i = 0; i < warmup && warm; i++) {
    store.search({ ...searchOpts, query: String(warm.query || warm), topK, maxBytes })
  }

  const results = []
  for (const c of cases) {
    const { r, ms } = timeIt(() => store.search({ ...searchOpts, query: c.query, topK, maxBytes }))
    const items = r.items || []
    // 两种判定口径：块级（自动集，`expect` = blockId）与文档级（human 集，`expectDoc` = 路径子串）。
    // 统一折成 `hitAtK`/`rr` 两个字段，后续聚合不再分支 —— 否则每加一种用例就要改一遍统计。
    const rank = c.expect ? items.findIndex((it) => it.blockId === c.expect) + 1 : 0
    const docRank = items.findIndex((it) => it.docId === c.docId
      || (c.expectDoc && String(it.docId).includes(c.expectDoc))) + 1
    const effRank = c.expectDoc ? docRank : rank
    results.push({
      query: c.query, expect: c.expect || null, expectDoc: c.expectDoc || null,
      spaceId: c.spaceId || null, kind: c.kind || null, type: c.type, terms: c.terms,
      rank: rank || null, docRank: docRank || null, ms,
      hitAtK: effRank > 0 && effRank <= topK, rank1: effRank === 1, rr: effRank > 0 ? 1 / effRank : 0,
      scorer: r.scorer ?? null,
      count: r.count ?? null, total: r.total ?? null, degraded: r.degraded === true,
      bytes: items.reduce((s, it) => s + Buffer.byteLength(String(it.snippet || ''), 'utf-8') + 160, 0),
    })
  }

  const negResults = []
  for (const q of negatives) {
    const { r, ms } = timeIt(() => store.search({ ...searchOpts, query: q, topK, maxBytes }))
    negResults.push({
      query: q, count: r.count ?? 0, degraded: r.degraded === true, ms,
      topDocIds: (r.items || []).map((it) => it.docId),
    })
  }

  const msSorted = results.map((x) => x.ms).sort((a, b) => a - b)
  const group = (key) => {
    const m = {}
    for (const x of results) {
      const k = x[key]
      if (k === null || k === undefined) continue     // human 集没有 kind/spaceId，不占分组的位置
      const g = (m[k] ||= { n: 0, hit: 0 })
      g.n += 1
      if (x.hitAtK) g.hit += 1
    }
    return m
  }
  const auto = results.filter((x) => x.type !== 'human')
  const falsePositive = negResults.filter((x) => x.count > 0).length

  return {
    results, negResults,
    // 每个用例都带 scorer（上），这里再汇总一份：调用方不必遍历用例才知道这批是谁给的
    scorer: results.length ? results[0].scorer : null,
    summary: {
      cases: results.length,
      autoCases: auto.length,
      topK,
      recallAtK: results.length ? results.filter((x) => x.hitAtK).length / results.length : 0,
      autoRecallAtK: auto.length ? auto.filter((x) => x.hitAtK).length / auto.length : 0,
      // field 类单列：BM25F 的字段加权只在这一类上能被观测到（见 buildFieldCases 注释）
      fieldRecall: (() => {
        const f = results.filter((x) => x.type === 'field')
        return f.length ? f.filter((x) => x.hitAtK).length / f.length : 0
      })(),
      top1: results.length ? results.filter((x) => x.rank1).length / results.length : 0,
      docRecallAtK: results.length ? results.filter((x) => x.docRank && x.docRank <= topK).length / results.length : 0,
      mrr: mean(results.map((x) => x.rr)),
      miss: results.filter((x) => !x.rank && !(x.expectDoc && x.docRank)).length,
      degradedRate: results.length ? results.filter((x) => x.degraded).length / results.length : 0,
      msP50: pct(msSorted, 0.5), msP95: pct(msSorted, 0.95),
      avgBytes: results.length ? Math.round(mean(results.map((x) => x.bytes))) : 0,
      negatives: { count: negResults.length, falsePositive, rate: negResults.length ? falsePositive / negResults.length : 0 },
      byKind: rateOf(group('kind')), bySpace: rateOf(group('spaceId')), byType: rateOf(group('type')),
    },
  }
}

/** 语料指纹：跨语料不可比，diff 前先看它。 */
export function corpusDigest(store) {
  const docs = store.getDocs() || []
  let h = 0
  for (const d of docs) h = (h * 31 + parseInt(hashLine(`${d.id}\u0000${d.hash || ''}`), 16)) % 2147483647
  const stats = typeof store.stats === 'function' ? store.stats() : {}
  return {
    docs: docs.length,
    blocks: stats.blocks ?? docs.reduce((s, d) => s + (d.blocks?.length || 0), 0),
    grams: stats.grams ?? store.getInverted().size,
    digest: String(h),
  }
}

/** 基线对比：只有**语料指纹相同**时才有意义（否则 diff 的是语料不是代码）。 */
export function diffSummary(base, cur) {
  if (!base || !cur) return null
  // 指纹可能挂在顶层（`{ summary, corpus }`）或 `meta.corpus`（CLI 落盘的完整 payload）——
  // 两种都要认。踩过的坑：只认顶层时，`--baseline <完整 payload>` 会**永远**报"语料不同"，
  // 于是真正需要警惕的"换了语料"被淹没在例行警告里（狼来了 → 警告失效）。
  const corpusOf = (x) => x?.corpus || x?.meta?.corpus || null
  const bc = corpusOf(base)
  const cc = corpusOf(cur)
  const sameCorpus = !!bc && !!cc && bc.digest === cc.digest
  const d = (a, b) => (typeof a === 'number' && typeof b === 'number' ? +(b - a).toFixed(4) : null)
  const b = base.summary || {}
  const c = cur.summary || {}
  const bad = []
  // 门禁只看**自动集**（human 集的正解是"我判断该找哪篇"，掺进门的通过/不通过会把主观判断
  // 变成代码门禁）；human 集数值照样输出，供人看一眼"真实话术"有没有退化。
  if ((c.autoRecallAtK ?? 0) < (b.autoRecallAtK ?? 0) - 1e-9) bad.push('autoRecallAtK')
  // field 类也进门禁：它的正解由语料确定（词→块，人工可判），不属于"主观相关度"
  if ((c.fieldRecall ?? 0) < (b.fieldRecall ?? 0) - 1e-9) bad.push('fieldRecall')
  if ((c.recallAtK ?? 0) < (b.recallAtK ?? 0) - 1e-9) bad.push('recallAtK')
  if ((c.mrr ?? 0) < (b.mrr ?? 0) - 1e-9) bad.push('mrr')
  if ((c.negatives?.rate ?? 0) > (b.negatives?.rate ?? 0) + 1e-9) bad.push('negativeFp')
  return {
    sameCorpus,
    corpusWarning: sameCorpus ? null : '语料指纹不同：以下差值混合了语料变化，不可作为代码效果证据',
    recallAtK: d(b.recallAtK, c.recallAtK),
    autoRecallAtK: d(b.autoRecallAtK, c.autoRecallAtK),
    fieldRecall: d(b.fieldRecall, c.fieldRecall),
    top1: d(b.top1, c.top1),
    docRecallAtK: d(b.docRecallAtK, c.docRecallAtK),
    mrr: d(b.mrr, c.mrr),
    msP95: d(b.msP95, c.msP95),
    avgBytes: d(b.avgBytes, c.avgBytes),
    negativeFp: d(b.negatives?.rate, c.negatives?.rate),
    // 判定口径：召回/排名**不降**为通过；假阳性率**不升**为通过（负例命中比漏召回更伤人）
    regression: { ok: bad.length === 0, worse: bad },
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const ALIAS = {
  'config-dir': 'configDir', limit: 'limit', topk: 'topK', 'max-bytes': 'maxBytes',
  spaces: 'spaces', seed: 'seed', out: 'out', 'summary-out': 'summaryOut', baseline: 'baseline',
  quiet: 'quiet', help: 'help',
}

export function parseArgs(argv = []) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = ALIAS[a.slice(2)]
    if (!key) continue
    if (key === 'quiet' || key === 'help') { out[key] = true; continue }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) { out[key] = true; continue }
    out[key] = v
    i += 1
  }
  return out
}

function configDirTail(dir) {
  // 只留最后两级目录名：绝对路径含用户名，基线 JSON 可能被分享/入库
  const parts = String(dir || '').split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('/')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`用法: node scripts/eval-retrieval.mjs [--config-dir <dir>] [--limit 150] [--topk 5]
  [--max-bytes <n>] [--spaces a,b] [--seed <n>] [--out <file>] [--summary-out <file>]
  [--baseline <file>] [--quiet]`)
    return
  }
  const configDir = String(args.configDir || resolveConfigDir(process.env, homedir))
  const limit = Number(args.limit) || 150
  const topK = Number(args.topK) || 5
  const maxBytes = args.maxBytes ? Number(args.maxBytes) : Number.MAX_SAFE_INTEGER
  const seed = Number(args.seed) || 20260918
  const spaces = args.spaces && typeof args.spaces === 'string'
    ? args.spaces.split(',').map((s) => s.trim()).filter(Boolean) : null

  const store = createKnowledgeStore({ configDir })
  store.load({})
  const corpus = corpusDigest(store)
  if (!corpus.blocks) {
    console.error(`语料为空（configDir=${configDir}）：没有可评测的块。先导入资料或用 --config-dir 指定库根。`)
    process.exitCode = 2
    return
  }
  const gold = buildGoldCases(store, { limit, seed, spaces })
  const human = buildHumanCases(store)
  const field = buildFieldCases(store)
  const negatives = buildNegativeCases(store, { seed: seed + 1 })
  const { summary, results, negResults, scorer: payloadScorer } = runEval({
    store, cases: [...gold.cases, ...field.cases, ...human.cases], negatives, topK, maxBytes,
  })

  const baseline = args.baseline ? JSON.parse(readFileSync(String(args.baseline), 'utf-8')) : null
  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      configDirTail: configDirTail(configDir),
      corpus,
      opts: { limit, topK, maxBytes, seed, spaces },
      gold: {
        blocks: gold.blocks, skippedNoGram: gold.skippedNoGram, skippedNotUnique: gold.skippedNotUnique,
        minDf: gold.minDf,
        invertedCoverage: gold.gramTotal ? +(gold.gramVisible / gold.gramTotal).toFixed(3) : null,
      },
      human: { cases: human.cases.length, skipped: human.skipped },
      field: { cases: field.cases.length, pool: field.pool },
      indexVersion: typeof store.stats === 'function' ? store.stats().version : null,
      // 打分器必须落档（2026-09-18 缺省翻到 bm25 之后尤其重要）：否则两个基线文件数值不同时
      // 无法从文件本身判断"是改了代码"还是"换了打分器"——量尺的第一要求是能证明这批结果
      // 是**谁**给的（`--baseline` 的 diff 同理）。
      scorer: payloadScorer,
    },
    summary,
    diff: baseline ? diffSummary(baseline, { summary, corpus }) : null,
    cases: results,
    negatives: negResults,
  }

  const outPath = String(args.out || join(tmpdir(), `ponos-eval-retrieval-${Date.now()}.json`))
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8')
  if (args.summaryOut) {
    mkdirSync(dirname(String(args.summaryOut)), { recursive: true })
    const { summary: s, meta } = payload
    writeFileSync(String(args.summaryOut), JSON.stringify({ meta, summary: s }, null, 2), 'utf-8')
  }

  if (!args.quiet) {
    console.log(`语料: ${corpus.docs} 篇 / ${corpus.blocks} 块 / ${corpus.grams} gram（digest ${corpus.digest}）　打分器: ${payloadScorer || '(未知)'}`)
    console.log(`用例: ${summary.cases}（自动 ${summary.autoCases} + 字段词 ${field.cases.length} + 真实话术 ${human.cases.length}；跳过 ${gold.skippedNoGram} 块无候选 / ${gold.skippedNotUnique} 块组合不唯一；倒排覆盖 ${(payload.meta.gold.invertedCoverage * 100).toFixed(1)}%）`)
    console.log(`recall@${topK}=${summary.recallAtK.toFixed(3)}（自动集 ${summary.autoRecallAtK.toFixed(3)}）  docRecall@${topK}=${summary.docRecallAtK.toFixed(3)}  top1=${summary.top1.toFixed(3)}  MRR=${summary.mrr.toFixed(3)}  miss=${summary.miss}`)
    console.log(`P50=${summary.msP50}ms  P95=${summary.msP95}ms  降级=${(summary.degradedRate * 100).toFixed(1)}%  平均回执=${summary.avgBytes}B`)
    console.log(`负例假阳性=${summary.negatives.falsePositive}/${summary.negatives.count}（${(summary.negatives.rate * 100).toFixed(1)}%）${negResults.filter((x) => x.count > 0).map((x) => ` ←「${x.query}」命中${x.count}条`).join('')}`)
    console.log('按类型:', Object.entries(summary.byType).map(([k, v]) => `${k} ${v.hit}/${v.n}(${v.recall.toFixed(2)})`).join('  '))
    console.log('按块类型:', Object.entries(summary.byKind).map(([k, v]) => `${k} ${v.hit}/${v.n}`).join('  '))
    console.log('按空间:', Object.entries(summary.bySpace).map(([k, v]) => `${k} ${v.hit}/${v.n}`).join('  '))
    // 真实话术逐条列出（命中给排名，未命中给"最相关的那条落在哪"）—— 这一行是"体感"与"指标"
    // 的对照表：指标说 0.72，人看一眼这行才知道那 0.28 丢在什么地方。
    console.log('真实话术:')
    for (const x of results.filter((r) => r.type === 'human')) {
      console.log(`   ${x.hitAtK ? '✓' : '✗'} ${String(x.query).padEnd(22, ' ')} → 期望「${x.expectDoc}」 docRank=${x.docRank ?? '-'} 命中${x.count}条`)
    }
    if (human.skipped.length) console.log(`   （跳过 ${human.skipped.length} 条：期望文档不在本库）`)
    if (payload.diff) console.log('对比基线:', JSON.stringify(payload.diff))
    console.log(`完整结果: ${outPath}`)
    if (args.summaryOut) console.log(`聚合摘要（可入库）: ${args.summaryOut}`)
  } else {
    console.log(JSON.stringify(payload.summary))
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await main()
