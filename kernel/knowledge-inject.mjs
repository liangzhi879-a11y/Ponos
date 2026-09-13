// kernel/knowledge-inject.mjs —— S3 统一知识注入（索引层 + 抽调层）
// ---------------------------------------------------------------------------
// 解决什么：S1 之前同一会话可能同时注入三份互相重复的内容——图谱抽调（graph.search）+ 经验
// 目录行（buildMemoryIndex）+ 模型自己再调 MemorySearch。三者的排序与预算互不知情。本模块
// 把注入收敛成一次调用、一个 store、两层的显式预算分配，且**必须可灰度回退**（D1 决策）。
//
// 与 S3 spec §2.2 的表述差异（有意，见 spec §11.3 N1）：spec 说"两层由同一次 searchKnowledge()
// 产出"，实际两层的形态不同——索引层是"主题|标签 → 文件"的**目录行**（buildMemoryIndex 渲染，
// 与检索无关），抽调层才是块级检索结果。强行统一会改目录行格式、破坏老会话的视觉契约（收益为负）。
// 故本模块的收敛点是"**同一个 store 实例 + 一次 load()**"：一次全库加载同时喂两层，不重复扫描。
//
// 同步契约：与 kernel/knowledge-search.mjs 同款——store.load()/search() 都是同步函数，
// 故这里**全程同步、不写 await**（调用点 kernel/cli.mjs 的注入段也在同步上下文里）。
import { resolve } from 'node:path'
import { createKnowledgeStore } from './knowledge.mjs'
import { buildMemoryIndex, memoryRoot } from './memory.mjs'

/** 总预算默认值与 server 侧 experienceInjectMaxBytes 的默认一致（4096，见 spec §11.3 N6）。 */
const DEFAULT_TOTAL_BUDGET = 4096
/** 检索耗时上限：超此值本次退回纯索引层（spec §3.3）。 */
const SLOW_MS = 500
/** 抽调层候选条数上限：比工具默认 5 条略宽，让预算（而非条数）决定最终装入量。 */
const RECALL_CANDIDATES = 8
/** 同一文档最多贡献的块数（防单文档刷屏，spec §3.2）。 */
const MAX_BLOCKS_PER_DOC = 2

// ── 灰度开关解析（D1）───────────────────────────────────────────────────────
// 优先级：env > settings > 缺省。**缺省必须是 legacy**——老用户升级后行为不得突变
// （spec §决定记录 D1）。非法值一律回落 legacy（宁可退回既有行为，也不进未验证路径）。
export function resolveInjectMode({ settings = null, env = process.env } = {}) {
  const raw = String(env?.PONOS_KNOWLEDGE_INJECT_MODE ?? settings?.memory?.injectMode ?? '').trim().toLowerCase()
  return raw === 'unified' ? 'unified' : 'legacy'
}

// 预算解析：env > settings.memory.injectMaxBytes > 4096。非正数/非数字一律回落默认
// （预算是防上下文爆炸的护栏，"0" 不能理解为"不注入"——那会让用户以为功能坏了）。
export function resolveInjectBudget({ settings = null, env = process.env } = {}) {
  const raw = env?.PONOS_KNOWLEDGE_INJECT_MAX_BYTES ?? settings?.memory?.injectMaxBytes
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOTAL_BUDGET
}

// ── 统计累加器（S3 观测，spec §6）────────────────────────────────────────────
// 进程内累加，**不落盘**：跨进程无意义（CLI 每次 `--knowledge stats` 都是新进程，读到的
// 只会是初值）。真实消费者是长驻会话的日志/调试与 server 进程内的 `GET /knowledge/stats`。
let acc = freshStats()
function freshStats() {
  return { calls: 0, strategy: 'legacy', indexLines: 0, recallBlocks: 0, elapsedMs: 0, indexAgeMs: null, degraded: null, queries: 0, hitQueries: 0 }
}

export function getInjectStats() {
  return { ...acc, hitRate: acc.queries ? Number((acc.hitQueries / acc.queries).toFixed(3)) : 0 }
}

export function resetInjectStats() { acc = freshStats() }

const byteLen = (s) => Buffer.byteLength(String(s || ''), 'utf-8')
const countLines = (s) => String(s || '').split('\n').filter((l) => l.startsWith('- [')).length

/**
 * 统一注入入口。
 * @returns {{ indexSection: string, recallSection: string, stats: object }}
 *   `recallSection` 在 legacy 模式下**恒为空串**：抽调层由调用方沿用 graph.search（现状行为），
 *   本模块不 import graph——那样会让"注入策略"与"图谱实现"耦死，也让 legacy 回退不再等价于改动前。
 */
export function buildKnowledgeInjection({
  configDir = '', memoryRootDir = null, query = '', keywords = [], spaces = null,
  totalBudget = DEFAULT_TOTAL_BUDGET, mode = 'legacy', recall = true, knowledgeIndex = null,
} = {}) {
  const t0 = Date.now()
  const total = Number(totalBudget) > 0 ? Math.floor(Number(totalBudget)) : DEFAULT_TOTAL_BUDGET
  const strategy = mode === 'unified' ? 'unified' : 'legacy'
  // memoryRootDir 缺省时按 <configDir>/memory/personal 推导（与 kernel/cli.mjs 同一函数，
  // 保证"注入的索引层"与"工具检索的经验空间"是**同一个目录**）。
  const mroot = memoryRootDir || (configDir ? memoryRoot(configDir) : '')

  if (strategy === 'legacy') {
    // legacy：索引层**用满总预算**（不切 2:1——没有抽调层可让渡），且调用参数与改动前
    // kernel/cli.mjs:631 完全一致 ⇒ 输出逐字节一致 = 零回归（这是灰度开关可信的前提）。
    const indexSection = mroot ? buildMemoryIndex({ root: mroot, maxBytes: total }) : ''
    const stats = {
      strategy, indexLines: countLines(indexSection), recallBlocks: 0,
      spaces: [], elapsedMs: Date.now() - t0, indexAgeMs: null, degraded: null,
    }
    record(stats, { queried: false })
    return { indexSection, recallSection: '', stats }
  }

  // unified：索引层先按 2:1 拿份额；实际占用后的余量**自动让渡**给抽调层（spec §3.3）。
  const indexCap = Math.max(1, Math.floor((total * 2) / 3))
  let indexSection = mroot ? buildMemoryIndex({ root: mroot, maxBytes: indexCap }) : ''
  const idxBytes = byteLen(indexSection)

  let recallSection = ''
  let stat = { strategy, indexLines: countLines(indexSection), recallBlocks: 0, spaces: [], elapsedMs: 0, indexAgeMs: null, degraded: null }
  // recall=false：`PONOS_MEMORY_INJECT=index-only` 逃生阀（只要索引指针）。unified 下若不短路，
  // 该开关会静默失效——用户设了"仅索引"却仍在抽调，是比"少个功能"更坏的故障模式。
  if (!recall) {
    stat.elapsedMs = Date.now() - t0
    record(stat, { queried: false })
    return { indexSection, recallSection: '', stats: stat }
  }
  try {
    // configDir 推导：memoryRootDir = <configDir>/memory/personal ⇒ 上溯两级。
    // 与 kernel/tools.mjs 的 KnowledgeSearch 同一套推导（少一级会指向空空间清单）。
    const cfg = configDir || (mroot ? resolve(mroot, '..', '..') : '')
    // 调用方可注入一个已 load 的 store（kernel/cli.mjs 把同一实例复用给轮末沉淀的增量更新）——
    // 一处 load 两处用，免得同一进程里为注入和写入各建一次全库索引。
    const store = knowledgeIndex || createKnowledgeStore({ configDir: cfg })
    store.load({})
    const recallCap = Math.max(0, total - idxBytes)
    const r = store.search({
      query, keywords, spaces, topK: RECALL_CANDIDATES, maxBytes: recallCap || 1,
      // keywords 一律传数组（**不传 null**）：shared/knowledge-core.mjs 的 keywordScore 对
      // null 走防御分支返回 0（S1 裁定保留），传 null 会静默丢掉关键词路得分（S2 §11.4 同款教训）。
      mode: 'snippet',
    })
    stat.indexAgeMs = r.indexAge ?? null
    const built = renderRecall(r.items, { store, cap: recallCap })
    recallSection = built.section
    stat.recallBlocks = built.count
    stat.spaces = [...new Set(r.items.map((i) => i.spaceId))]
    // 让渡的另一半：抽调层没命中时，索引层可以吃满总预算（spec §3.3"任一层未用满可让渡"）。
    // 只在"索引层确实被 cap 截短"时才重算，避免每次白扫一遍目录。
    if (!built.count && total > indexCap && countLines(indexSection) > 0) {
      const fuller = mroot ? buildMemoryIndex({ root: mroot, maxBytes: total }) : ''
      if (byteLen(fuller) > idxBytes && byteLen(fuller) <= total) {
        indexSection = fuller
        stat.indexLines = countLines(fuller)
      }
    }
  } catch (e) {
    // 抽取层故障绝不打断会话（对齐 kernel/health.mjs 静默降级纪律）：退回纯索引层，
    // 模型仍可用 KnowledgeSearch 工具主动检索。
    stat.degraded = 'error'
    stat.error = e?.message || String(e)
    recallSection = ''
    stat.recallBlocks = 0
  }

  stat.elapsedMs = Date.now() - t0
  // 同步契约决定了不能"超时中断"（store.search 无 await 点，JS 单线程也打断不了它），
  // 只能**事后降级**：量到超阈值就丢弃本次抽调结果，只留索引层（spec §11.3 N5）。
  if (stat.degraded === null && stat.elapsedMs > SLOW_MS) {
    stat.degraded = 'slow'
    recallSection = ''
    stat.recallBlocks = 0
  }
  record(stat, { queried: true })
  return { indexSection, recallSection, stats: stat }
}

/**
 * 渲染抽调层：块级行 + **粒度自适应**（D3）。
 * 顺序即 store.search 的分数降序——升级只改渲染文本、**不重新检索**，避免"两套排序"漂移。
 */
function renderRecall(items, { store, cap }) {
  const header = '\n\n【相关知识抽调】根据当前任务上下文，以下知识块与任务直接相关，可直接引用（格式：-[空间|标题] 摘要 -- 文件 › 小节 · 第 N 行 (块id)）：\n'
  if (!Array.isArray(items) || !items.length || cap <= byteLen(header)) return { section: '', count: 0 }

  // 复选框行（`- [ ] Step N`）是无标签的 entry 块：它们是任务清单而非沉淀知识。
  // S1 裁定"经验条目 = 有 tag 的 entry 块"，S2 据此定渲染规则，注入层沿用同一判定
  // （否则清单类文档的每一行都会挤进抽调预算）。
  const docsOf = new Map()
  for (const it of items) if (!docsOf.has(it.docId)) docsOf.set(it.docId, store.getDoc(it.docId))
  const tagOf = (it) => {
    const d = docsOf.get(it.docId)
    // blockId 形态 = `${docId}#${n}`（shared/knowledge-core.mjs:367 toBlockId）——取最后一个
    // `#` 之后的部分做块号，不能用固定前缀切（docId 自身可能含 `#`）。
    const n = Number(String(it.blockId).slice(String(it.blockId).lastIndexOf('#') + 1))
    const b = d?.blocks?.find((x) => x.n === n)
    return b ? { tag: b.tag, full: b.full || b.text } : { tag: null, full: null }
  }

  const rows = []
  const seen = new Set()
  const perDoc = new Map()
  for (const it of items) {
    if (seen.has(it.blockId)) continue                 // blockId 去重（同一块不得出现两次）
    const n = perDoc.get(it.docId) || 0
    if (n >= MAX_BLOCKS_PER_DOC) continue              // 同文档 ≤ 2 块
    const meta = tagOf(it)
    if (it.kind === 'entry' && !meta.tag) continue     // 无标签 entry = 清单行，不是知识
    seen.add(it.blockId)
    perDoc.set(it.docId, n + 1)
    rows.push({ it, text: it.snippet, full: meta.full })
  }

  // 第一遍：全按摘要贪心装入（省预算）。第一条无条件放入——否则预算极小时抽调层恒空，
  // 用户看到"注入失效"（与 store.search 首条无条件放入的既有纪律一致）。
  const included = []
  let used = byteLen(header)
  for (const row of rows) {
    const line = renderLine(row, false)
    const lb = byteLen(line) + 1
    if (included.length && used + lb > cap) break
    included.push(row)
    used += lb
  }

  // 第二遍：预算有余量 → 按分数从高到低（included 已是分数序）把块升级为全文。
  // 升级成本 = 全文比摘要多出的字节；装不下就停（不跳过低分块去升级更低分的，保持单调）。
  let leftover = cap - used
  for (const row of included) {
    if (!row.full || row.full === row.text) continue
    const cost = byteLen(row.full) - byteLen(row.text)
    if (cost <= leftover) { row.upgraded = true; leftover -= cost }
  }

  if (!included.length) return { section: '', count: 0 }
  return { section: header + included.map((r) => renderLine(r, true)).join('\n') + '\n', count: included.length }
}

function renderLine(row, withMarker) {
  const it = row.it
  const text = row.upgraded ? row.full : row.text
  const where = `${it.docId}${it.heading ? ` › ${it.heading}` : ''} · 第 ${it.line} 行 (${it.blockId})`
  // `·全文` 标记让模型知道"这条已给全，不必再 Read"——正是 D3 升级的收益所在。
  return `- [${it.spaceId}|${it.title}] ${text} -- ${where}${row.upgraded && withMarker ? ' ·全文' : ''}`
}

function record(stat, { queried }) {
  acc.calls += 1
  acc.strategy = stat.strategy
  acc.indexLines = stat.indexLines
  acc.recallBlocks = stat.recallBlocks
  acc.elapsedMs = stat.elapsedMs
  acc.indexAgeMs = stat.indexAgeMs
  acc.degraded = stat.degraded
  if (queried) {
    acc.queries += 1
    if (stat.recallBlocks > 0) acc.hitQueries += 1
  }
}
