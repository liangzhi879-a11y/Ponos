// kernel/knowledge.mjs —— 知识内核（S1）：空间发现 / 文档解析 / 索引 / 检索
// ---------------------------------------------------------------------------
// 权威实现（server 侧一律经 --knowledge <op> 子命令转发，不在 server 复制逻辑）。
// 数据模型与设计见 docs/superpowers/specs/2026-09-13-knowledge-core-design.md。
// 纯函数在 shared/knowledge-core.mjs（repo 根 shared/ 经一级 ../ 逃逸共享）。
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync,
  rmSync, cpSync, realpathSync,
} from 'node:fs'
import { join, relative, sep, basename, dirname, extname } from 'node:path'
// 原子写 / 临时文件判定（2026-09-14 批次 4）：`walkMd` 必须跳过 `.yfw-tmp-*.md`。
// 临时文件的名字**以目标名结尾、同样是 .md**，不跳过就会被当成一篇新文档收进索引 ——
// 于是"保存一次文档"在库里多出一篇同名文档，而它随时会被 rename 走或删除。
import { isAtomicTmpName } from '../shared/atomic-write.mjs'
// 检索语法层（2026-09-14 对标 Obsidian 批次 3）：解析 `tag:` / `path:` / `"短语"` / `A OR B` /
// `-x` / `/正则/`，内核据此"先过滤、后打分"。纯函数无 IO，前端另有一份同口径手写实现。
import { parseSearchQuery, matchDocQuery, matchBlockQuery, matchTextParts } from '../shared/knowledge-query.mjs'
import {
  INDEX_VERSION, builtinSpaceSpecs, parseFrontmatter, splitBlocks, extractLinks,
  toDocId, hashLine,
  // 2026-09-14（对标 Obsidian 批次 1）：正文内联 `#tag` 进索引（Obsidian 标签的主力形态，
  // 旧实现只认 frontmatter / 文件名 / entry 的 `|tag`，导入 Obsidian vault 会"标签凭空消失"）
  extractInlineTags,
  countGrams, buildIdf, vectorizeText, blockIndexText, blockTagBoost, relationContent, retrievalText,
  serializeIndex, parseJsonl, resolveLinkTarget,
  cosine, keywordScore, structBoostOf, fuseScore, makeSnippet, toBlockId,
  // S5 关联锚点（Task 1 的纯函数层）：物化 + 读时校验只用这几个，判定逻辑一律留在 shared
  relatedCandidates, blockContentSig, validateRelation, MIN_LEN, SIM_THRESHOLD, MAX_RELATED,
  // S5.1：ref 层（手写引用 → 条目级关联）需要自己的目标数上限与真余弦口径的 boost
  MAX_REF_RELATED, RELATION_TAG_BOOST,
} from '../shared/knowledge-core.mjs'

/** 空间根：<configDir>/knowledge（configDir 由调用方给，本模块不自解析 home） */
export function knowledgeRoot(configDir) {
  return join(configDir || '', 'knowledge')
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.index', '.obsidian'])

/**
 * 单个空间的**索引文件数上限**（2026-09-14 批次 4 提为常量）。
 *
 * 上限本身是必要的防护（一次误指向家目录就会试图索引上百万个文件），但**静默**截断不行：
 * 用户看到"索引成功"，而超限的文档搜不到、图谱里没有、统计数字也不含 —— 没有任何迹象说明原因。
 * 现在截断会被写进 manifest 并在 `stats()` 里报出来，GUI 据此提示（见 KnowledgePanel 的上限提示）。
 */
const FILE_LIMIT_PER_SPACE = 5000

/**
 * 递归收集 md。不跟符号链接（穿越防护第一道），跳过依赖/隐藏目录。
 *
 * `stats` 出参（2026-09-14 批次 4）：**截断必须出声**。旧实现在 `out.length >= maxFiles` 时
 * 静默停手 —— 用户看着一个"索引成功"的界面，而第 5001 篇之后的文档**根本不存在**：
 * 搜不到、图谱里没有、统计数字也不含。没有任何迹象说明原因，用户只会怀疑"搜索坏了"。
 * 这里把 `truncated`/`limit`/`count` 写回调用方给的 `stats` 对象（不改返回值形状 —— 既有调用方
 * 与测试都按数组用，改形状会把无关代码卷进 diff），再由调用方写进 manifest 与 stats 输出。
 *
 * **必须跳过原子写的临时文件**：`shared/atomic-write.mjs` 的临时名是
 * `.yfw-tmp-<pid>-<rand>-<原名>.md` —— 结尾仍是 `.md`，会被这里的 `/\.md$/i` 收进索引，
 * 于是"保存一次文档"就会在库里多出一篇同名文档（而它随时会被 rename 走或删掉）。
 * 进程被强杀留下的残留也会因此长期污染索引。
 */
export function walkMd(root, { maxFiles = 5000, stats = null } = {}) {
  const out = []
  const stack = [root]
  /**
   * 是否因为**撞上限而丢弃了本该收录的文件**（2026-09-14 批次 4）。
   *
   * 旧实现的循环条件 `out.length < maxFiles` 只在外层判断 —— 内层把一个目录里的条目
   * **全部**收完才回到外层。于是单目录 2 万个文件时会全部收下：`maxFiles` 根本不是硬上限，
   * 只是"最多跑这么多轮目录"。更糟的是它让"截断"无法判定（收完 6 个、上限 3 个，
   * 栈也空了 → 看不出发生过截断）。现在把上限判定挪到**入数组那一刻**：
   * 丢弃即置位，语义精确 = "有文件本可收录但没收"。
   */
  let dropped = false
  scan: while (stack.length) {
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
      if (isAtomicTmpName(e.name)) continue      // 见上：临时文件结尾也是 .md
      if (out.length >= maxFiles) { dropped = true; break scan }
      const abs = join(dir, e.name)
      out.push({ absPath: abs, relPath: relative(root, abs).split(sep).join('/') })
    }
  }
  if (stats && typeof stats === 'object') {
    // `truncated` 的含义：**有文件因为上限被丢弃**（不是"栈里还有目录"——扫完了也不是截断）
    stats.truncated = dropped
    stats.limit = maxFiles
    stats.count = out.length
  }
  return out
}

function readJsonFile(fp) {
  try { return JSON.parse(readFileSync(fp, 'utf-8')) } catch { return {} }
}

// ── 回收站（软删除，2026-09-14）──────────────────────────────────────────────
// 设计见 .yfw-spec/knowledge-trash/spec.md。三条不变量，改本段前先读它们：
//   ① 除 purge 外**不做任何物理删除**（`movePath` 的跨盘兜底 rm 只删"已经复制成功"的源）；
//   ② 回收站放 `<knowledge>/.trash`（不在各空间内）：`walkMd` 跳过 `.` 开头的目录 ⇒
//      回收站天然不进索引（索引层零改动）；且删整库时不会把回收站一起搬走；
//   ③ 删除权限判定**独立于 `writable`**：内置经验空间的 `writable === true`（记忆需要能写），
//      照它放行会直接删掉用户的 `~/.yfw/memory/personal`。
const TRASH_DIR_NAME = '.trash'
/** `YYYYMMDD-HHmm-<4位小写字母数字>`。purge 是唯一物理删除路径，形状校验是它的第一道闸。 */
const TRASH_ID_RE = /^[0-9]{8}-[0-9]{4}-[0-9a-z]{4}$/

/** 回收站根：`<configDir>/knowledge/.trash`。 */
export function trashRoot(configDir) {
  return join(knowledgeRoot(configDir), TRASH_DIR_NAME)
}

/** trashId 形状校验。`../`、绝对路径、盘符一律不匹配 ⇒ purge 拿不到回收站外的路径。 */
export function isTrashId(v) {
  return TRASH_ID_RE.test(String(v ?? '').trim())
}

/** 生成 trashId（时间可读 + 防同秒冲突）。`taken` 由调用方给（查台账 + 查目录）。 */
export function newTrashId(taken = () => false) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  for (let i = 0; i < 200; i++) {
    const rand = Math.random().toString(36).slice(2).padEnd(4, '0').slice(0, 4)
    const id = `${stamp}-${rand}`
    if (isTrashId(id) && !taken(id)) return id
  }
  // 不返回时间戳外的兜底值：宁可报错，也不覆盖已有回收站条目（那才是真的丢数据）
  throw new Error('trash: 无法生成唯一 trashId（同分钟内 200 次随机全部撞车）')
}

/** 目标路径是否真的落在 root 内（软链接解析后判定）。`..` 已在路径规范化阶段拒掉，这是第二道。 */
function realpathInside(root, abs) {
  let rootReal
  let absReal
  try { rootReal = realpathSync(root) } catch { return false }
  try { absReal = realpathSync(abs) } catch { return false }
  return absReal === rootReal || absReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
}

/**
 * 相对 .md 路径规范化（删除/还原专用，与 `listTree` 的读侧防护同口径）：
 * 拒绝对路径/盘符/`..`/空段，且必须以 `.md` 结尾 —— 允许删非 md 文件等于把这里变成通用删文件口。
 */
function normalizeMdRel(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').trim()
  if (!s) return null
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null
  const parts = s.split('/').filter((p) => p && p !== '.')
  if (!parts.length || parts.some((p) => p === '..')) return null
  if (!/\.md$/i.test(parts[parts.length - 1])) return null
  return parts.join('/')
}

/** 路径占用统计（删前算，删后就没有了）。文件返回自身大小；目录递归求和。 */
function pathBytes(abs) {
  let st
  try { st = statSync(abs) } catch { return 0 }
  if (st.isFile()) return st.size
  let bytes = 0
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (!e.isFile()) continue
      try { bytes += statSync(p).size } catch { /* 统计失败不影响删除，只是数字略小 */ }
    }
  }
  return bytes
}

/** 目录下的文件相对路径清单（只用于报告"搬走了什么"，不参与删除决策）。 */
function listRelFiles(abs) {
  const out = []
  let st
  try { st = statSync(abs) } catch { return out }
  if (st.isFile()) return [basename(abs)]
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (e.isFile()) out.push(relative(abs, p).split(sep).join('/'))
    }
  }
  return out
}

/** 先试 rename（同盘原子、最快），EXDEV（跨盘）才退化成"复制成功后再删源"。 */
function movePath(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
    return 'rename'
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e
  }
  cpSync(from, to, { recursive: true })
  rmSync(from, { recursive: true, force: true }) // 源已完整复制，这里删的是副本的源
  return 'copy'
}

/**
 * 复制路径（2026-09-14 批次 4）。与 `movePath` 唯一的区别是**源保留**。
 * 搬走的场景要 30 秒内跨盘也能用（`cpSync` + `rmSync`），复制场景直接用 `cpSync` 即可 ——
 * 但都要先 `mkdirSync` 父目录，否则 `cpSync` 在父目录不存在时抛 ENOENT。
 */
function copyPath(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
  return 'copy'
}

/** 台账读写（原子替换：写 .tmp → rename，避免半截 JSON 让整个回收站不可读）。 */
function readTrashIndex(trashDir) {
  const raw = readJsonFile(join(trashDir, 'index.json'))
  return { version: 1, items: Array.isArray(raw?.items) ? raw.items : [] }
}

function writeTrashIndex(trashDir, index) {
  mkdirSync(trashDir, { recursive: true })
  const fp = join(trashDir, 'index.json')
  const tmp = `${fp}.tmp`
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8')
  renameSync(tmp, fp)
}

/** 还原时的"同名让位"（与导入侧 `outRelFor` 同一约定：`a.md` → `a-2.md`）。 */
function freeRel(root, rel) {
  const parts = rel.split('/')
  const file = parts.pop()
  const dir = parts.join('/')
  const ext = extname(file)
  const stem = basename(file, ext)
  // 让位名必须把**目录前缀带回去**（`sub/b.md` → `sub/b-2.md`）。只返回 `b-2.md` 会把文件
  // 还原到空间根 —— 看起来"还原成功"，实际位置错了，且原目录下仍然缺这个文件。
  const at = (name) => join(root, ...(dir ? `${dir}/${name}` : name).split('/'))
  if (!existsSync(at(file))) return rel
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}-${i}${ext}`
    if (!existsSync(at(cand))) return dir ? `${dir}/${cand}` : cand
  }
  return null
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

/**
 * 会话可关联的知识库数量上限（2026-09-15，待处理清单 P1「会话模式关联经验库之外的知识库」）。
 *
 * **why 是 8**：范围会同时进入「注入白名单」与「提示词清单」——两者都是**每次请求都要付**的成本
 * （提示词里每多一个库名，就多一分与任务无关的噪声）。8 个已远超"人工挑选"的实际粒度（用户
 * 真正常用的储备库是 1–3 个），再多的部分不是"能力"而是"上下文税"。
 * 超限**不报错**（用户操作不该抛异常），但必须进 `dropped` 被看见（见返回结构）。
 */
export const MAX_ASSOC_SPACES = 8

/**
 * GUI「大库提示」阈值（2026-09-15）：关联时若某库文档数超过它，界面提示"注入受预算限制"。
 *
 * **why 是 1000**：注入层的抽调预算是 4096 字节（`knowledge-inject.mjs` DEFAULT_TOTAL_BUDGET），
 * 单条命中按摘要十来行算，实际能装下的条目是**个位数**。1000 篇规模意味着"随手一搜就有几百条
 * 候选"，用户此时需要知道的是"该按关键词按需检索，而不是指望它整库进上下文"。
 * 数值本身不参与检索决策（纯提示），故不需要像关联上限那样严格论证——但也不能不设：
 * 没有阈值就没有提示的触发点。
 */
export const LARGE_SPACE_DOCS = 1000

/** 内置经验类空间的 source 集合：它们是"给执行任务用的"基础设施，恒在会话范围内（spec D4）。 */
const BUILTIN_SCOPE_SOURCES = new Set(['experience', 'memory'])
/**
 * **可被关联**的空间 source 集合（2026-09-15）：与 GUI 的 `isAssociableSpace` 同义。
 *
 * 为什么要在这里也判一次：`unassociated` 会被渲染进提示词，让模型**请用户去关联**。
 * 若把 GUI 根本给不出开关的空间（如尚未启用的 `skill-experience`）列进去，模型就会指一条
 * 走不通的路——用户按提示去找开关，找不到，只能怀疑功能坏了。清单只列"指得到门"的空间。
 */
const ASSOCIABLE_SCOPE_SOURCES = new Set(['user', 'pack'])

/**
 * 解析**会话知识范围**（2026-09-15，spec §3.2）：本会话的 agent 可注入/可检索的空间白名单。
 *
 * 组成 = 内置经验类空间 ∪ 用户显式关联的空间。三条语义要点：
 *   1. **经验库不可被移除**（D4）：它是执行任务的基础设施，"关掉经验库"只会让 agent 变笨而
 *      用户不知道为什么。故 `builtin` 一律前置，`requested` 只能**追加**。
 *   2. **不存在/不可读的 id 进 `missing`，超上限的进 `dropped`**（不报错、不静默）：关联是用户
 *      在界面上点的，操作本身不该抛异常；但"点了没生效"必须可解释——两处出声让 GUI/日志能做
 *      到"忽略了这个库，因为……"。
 *   3. **纯读、无副作用**：只调 `discoverSpaces`（目录发现），不建索引、不写盘；cli 在会话启动
 *      段就能廉价调用，工具层与注入层拿到的是**同一个**对象（双层同源，spec §2.2）。
 *
 * 与 `discoverSpaces` 的差别：那个回答"库里有哪些空间"，本函数回答"**本次会话**能用哪些"。
 * 前者是事实，后者是授权——不要互相替代（GUI 的空间下拉必须看到全部，agent 只能看到授权集）。
 *
 * @returns {{
 *   spaces: string[], builtin: string[], associated: string[], missing: string[],
 *   dropped: string[], truncated: boolean, labels: Record<string,string>, unassociated: string[],
 * }}
 *   `labels` = id→显示名（提示词与 GUI 共用一份，避免两处各取一次名字而名字口径漂移）；
 *   `unassociated` = 存在但**未**关联、**且可关联**（source ∈ {user,pack}，与 GUI 开关同判据）
 *   的空间 id（提示词据此告诉模型"还有什么库可以请用户关联"——只列指得到门的，避免指路无门）。
 */
export function resolveSessionKnowledgeScope({ configDir, requested = null } = {}) {
  const all = discoverSpaces({ configDir })
  const builtin = all.filter((s) => BUILTIN_SCOPE_SOURCES.has(s.source)).map((s) => s.id)
  const byId = new Map(all.map((s) => [s.id, s]))
  // 归一：非数组/含空串一律当"没关联"（GUI 传来的可能是 undefined、旧会话可能是 null）。
  const asked = (Array.isArray(requested) ? requested : [])
    .map((s) => String(s ?? '').trim()).filter(Boolean)
  // 去重保持**用户给定顺序**（顺序即优先级的天然表达：先关联的排在提示词前面），
  // 在去重之后再判 missing/dropped，避免"同一个 id 写两遍"把配额吃掉两份。
  const uniq = [...new Set(asked)]
  const missing = uniq.filter((id) => !byId.has(id))
  // 内置空间即使被显式列出也不算"关联"，否则它会在配额里占位（用户并不需要为经验库买单）。
  const known = uniq.filter((id) => byId.has(id) && !builtin.includes(id))
  const associated = known.slice(0, MAX_ASSOC_SPACES)
  const dropped = known.slice(MAX_ASSOC_SPACES)
  const spaces = [...builtin, ...associated]
  const scopeSet = new Set(spaces)
  return {
    spaces, builtin, associated, missing, dropped, truncated: dropped.length > 0,
    labels: Object.fromEntries(all.map((s) => [s.id, s.name || s.id])),
    unassociated: all.filter((s) => !scopeSet.has(s.id) && ASSOCIABLE_SCOPE_SOURCES.has(s.source)).map((s) => s.id),
  }
}

function collectTags(front, space, relPath, blocks) {
  const tags = []
  // frontmatter：**数组与字符串两态都吃**（2026-09-14 批次 1）。
  // parseYamlSubset 起，`tags:` + 缩进 `- x`（Obsidian 标准写法）与 `tags: [a, b]` 都解析成数组；
  // `tags: a, b` 仍是字符串（旧行为不变，靠这里的 split 兜住）。
  if (Array.isArray(front.tags)) tags.push(...front.tags.map((t) => String(t)))
  else if (front.tags) tags.push(...String(front.tags).split(/[,\s]+/))
  // 正文内联 `#tag`（2026-09-14 批次 1）：Obsidian 用户敲标签的主力形态。
  // code 块跳过（代码里的 `#xxx` 是注释/颜色值，不是标签）；entry 块取**全文**——
  // 条目的摘要常被截断，"标签落在被截掉的后半段"是常态。
  for (const b of blocks) {
    if (b.kind === 'code') continue
    tags.push(...extractInlineTags(b.kind === 'entry' ? (b.entryFull || b.text) : b.text))
  }
  if (space.source === 'experience' || space.source === 'memory') {
    tags.push(basename(relPath).replace(/\.md$/i, ''))
  }
  for (const b of blocks) if (b.kind === 'entry' && b.entryTag) tags.push(b.entryTag)
  // 清洗统一放在最后：strip 前导 `#`（`tags: "#财务"` 这种手写习惯，Obsidian 里属性值不带 #）、
  // trim、去空、去重。放在出口处做的理由——上面四路来源的形态各不相同，逐路清洗必然漏一路。
  return [...new Set(tags.map((t) => String(t).trim().replace(/^#+/, '')).filter(Boolean))]
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
  // 标量归一（2026-09-14 批次 1）：parseYamlSubset 之后 title/name 可能是**数组**
  // （`title:` + 缩进 `- x`，或 `title: [a, b]`）——直接进模板会渲染成 "a,b" 这种脏标题。
  const scalar = (v) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')).trim()
  const title = scalar(front.title) || scalar(front.name) || (heading && heading.text) || basename(relPath).replace(/\.md$/i, '')
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
  // 链接定位（S5.1）：extractLinks 给的字符下标 → 行号 → 所属块。
  // 走到 linkRowsOf 里统一实现（**全量建索引与增量更新共用一份**，见该函数注释）。
  const links = linkRowsOf(raw, docId, doc.blocks)
  return { doc, links }
}

/**
 * 文档原文 → links 行（2026-09-14 批次 2 抽出）——**全量建索引与增量 updateDoc 的唯一实现**。
 *
 * 为什么必须抽成一份：原实现有**两份** —— 这里产 `{from,to,anchor,line,block}`，
 * 而增量路径的 `relinkDoc` 自己重写了一遍、只产 `{from,to,target}`。同一份数据的两个生产者
 * 字段不一致，后果很隐蔽：**任何文件被编辑过之后，它的引用就丢掉行号与块归属**，
 * 条目级 ref 关联（"是哪条经验引用了这篇文档"）随之消失或退化成"整篇条目全连"。
 * 那种 bug 不报错、不抛异常，只是关联质量悄悄变差（实测确认：改过的文档 ref 边全丢）。
 * 现在字段只有这一处定义，谁都改不动它的一致性。
 *
 * 返回行的字段见 shared/knowledge-core.extractLinks 的契约；这里补三样**位置**信息：
 *   · `line`  链接在**原始文件**（含 frontmatter 偏移）里的行号
 *   · `block` **entry 块**的块号（只有条目能当 ref 边的源：段落/标题不是"经验条目"，
 *              挂上去会造出不存在的锚点源）；定位不到 → null（不丢链接，只退化为文档级）
 *   · `target` 由调用方解析后补（全量在 build、增量在 relinkDoc）
 */
function linkRowsOf(raw, docId, blocks) {
  const lineOfIndex = (idx) => raw.slice(0, Math.max(0, idx || 0)).split('\n').length
  const blockAtLine = (line) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const next = blocks[i + 1]
      if (line >= b.line && (!next || line < next.line)) return b
    }
    return null
  }
  return extractLinks(raw).map((l) => {
    const line = lineOfIndex(l.index)
    const b = blockAtLine(line)
    return {
      from: docId, to: l.to, anchor: l.anchor || '', line,
      // 批次 2：锚点 / 同文档锚点 / 嵌入 三类语义（读过 Obsidian 语法的 md 才能正确跳转）
      anchorRef: l.anchorRef || '',
      anchorKind: l.anchorKind || '',
      embed: l.embed === true,
      self: l.self === true,
      block: b && b.kind === 'entry' ? b.n : null,
    }
  })
}

// ── 索引（Task 6）─────────────────────────────────────────────────────────
/**
 * 单文档最多索引的块数（护栏：防单文件把索引撑爆）。
 *
 * ⚠️ 数值来自真实库实测，不是随手取的。S6 合并历史经验库后 `experience/workflow.md`
 * 有 **239** 条条目，而原值 200 让 `slice(0, 200)` 把**尾部 ~48 条静默丢掉** ——
 * 那些条目仍在文件里（Read 看得见），却不在索引中：检索不到、没有关联边、图谱里不存在。
 * 这是最难排查的一类分裂（"文件有、知识库没有"）。实测：文件 302 条 / 索引 254 条。
 *
 * 故提到 2000（对当前单文件最大 239 留 ~8× 余量），并且**截断必须出声**（见 `capBlocks`）——
 * 护栏可以存在，但静默丢数据不行。
 */
const MAX_BLOCKS_PER_DOC = 2000
const PRUNE_MIN_DOCS = 50      // 少于 50 篇不做高频剪枝（小库剪枝会误伤）
const PRUNE_DF_RATIO = 0.5     // 出现在超半数文档里的 gram 近似停用词
/** 检索耗时采样窗口（环形缓冲上限）：100 次足够看 P95，也不会无界增长 */
const SEARCH_SAMPLES = 100

/**
 * 标签直连命中的**兜底底价**（2026-09-14 批次 1，见 searchInner 的 3.5 步）。
 *
 * 标签命中**不臆造分数**：它走既有的 struct 通道由公式算出 ——
 * `fuseScore({cos:0, kw:0, struct: structBoostOf({block, doc, keywords:[标签]})})`
 * ，其中 structBoostOf 的"标签命中"权重已定为 0.67（见 shared/knowledge-core.mjs:501），
 * 于是 score ≈ 0.15 × 0.67 ≈ **0.10**。这个数是**推出来的**，不是拍的，而且天生低于任何
 * 有正文证据的命中（那些还会再加 0.60×cos + 0.25×kw）——这正是我们要的顺序：
 * 正文命中在前、标签命中在后，两者都能出现在结果里。
 *
 * （最初的实现给的是定值 0.30，被实测打回：本系统里**真实**的正文命中在短文档上只有
 * 0.22–0.27（即便一个词在正文里出现 8 次），0.30 会把正文命中整体压到标签命中之后。）
 *
 * 这个常量只兜一种极端情形：单字符标签（`#a`）——structBoostOf 的 keywords 过滤掉长度 <2 的词，
 * 于是 struct 可能为 0、score 为 0。给个极小正数保证它仍在结果里（0 分会被视作"没有证据"）。
 */
const TAG_HIT_FLOOR = 0.05

/**
 * 未链接提及（Unlinked mentions）的**最短关键词长度**（2026-09-14 批次 2）。
 *
 * 取 2 的依据：中文里单字标题（"甲"、"税"）做包含匹配会命中成百上千个块——那些不是"提及"，
 * 而是"这个字恰好出现过"。面板一旦被噪声填满，用户就不会再打开它（比没有这个功能更糟）。
 * 英文单字母同理（"a"）。所以长度 < 2 的关键词**整条**跳过：宁可对短标题漏报，
 * 也不要给出满屏假提及。
 */
const MIN_MENTION_LEN = 2

/** 反链 / 提及面板的上下文片段长度（字符）。依据见 snippetAt 的注释 */
const SNIPPET_LEN = 120
/**
 * 检索结果每条附带的锚点上限（S5 Task 6）。取 3 而不是 MAX_RELATED(8) 的理由是**体积**：
 * 检索项本身已是 topK（缺省 5）条，每项 8 条锚点 ⇒ 最多 40 条摘要，而摘要里的 `why.shared`
 * 还会带 5 个特征字 —— 与 `maxBytes`（缺省 2048）同阶甚至超出，S3 的教训就是"顺手多带一点"
 * 把注入预算吃光。3 条在"给出多条路径"与"不膨胀"之间取平衡；要全量锚点用 `getRelated(blockId)`。
 */
const SEARCH_RELATED_TOPN = 3

/**
 * **检索**索引文本的口径（S5 Task 2 / spec §8）：内容部分取 `retrievalText(b)`
 * （= 摘要与去前缀 full 的**并集**），不再只取 `b.text`。
 *
 * **why**：`b.text` 是 `kernel/memory.mjs:186` 生成的 `类型前缀 + t.slice(0,60)` 截断摘要，
 * 实测同一条目 text=45 字 vs full=471 字（10 倍信息差）——落在 60 字之后的内容以前
 * **根本进不了索引**（查不到），这是当初改口径的动机。
 *
 * ⚠️ **但只取 full 会引入新的召回退化**（S5 终验收实测）：真实库 76 条中 **59 条（78%）**
 * 的摘要是"另写的抽象摘要"，用词**不在 full 里**。只索引 full 会让这些摘要独有词整体退出倒排：
 * 10 个 query 里 3 个换块，`不回显` 从 0.667（正确条目）掉到 0.084（无关块）。
 * 故取**并集**——保住新增收益（`expression`/`keep-alive` 这类只在正文里的词由 0 命中变可检索），
 * 同时找回被丢掉的摘要词召回。详见 `shared/knowledge-core.mjs` 的 `retrievalText` 注释。
 *
 * 注意与**关联层**的区别：关联层（`buildRelIdf` / `relatedCandidates`）仍按
 * `relationContent`（只 full）算相似度——阈值 0.15 是按那个口径校准的，改成并集会让校准失效。
 * 两者共用同一次索引遍历，但**文本口径故意不同**，别合并。
 *
 * 类型标签前缀与 tagBoost 仍走 `blockIndexText`/`blockTagBoost`（entry 块 tag 加 3 倍权）：
 * 那是 S1 的 tag 命中语义，S5 不动。
 *
 * 反过来说，**不要**在这里改回 `b.text`：改了就会退回"两条路径信息量不一致"的老问题。
 */
function indexTextOf(b) {
  return blockIndexText({ kind: b.kind, text: retrievalText(b), entryTag: b.tag })
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
  /**
   * 本轮索引的**截断留痕**（2026-09-14 批次 4）。`truncated: true` 表示"有文档没进索引"——
   * 与 `blocksTruncated` 同一性质：必须被看见的信号，不是内部细节。
   * `staleSweepSkipped` 表示"截断导致'磁盘已删'清扫被跳过"（见 indexStale 的注释）。
   */
  let lastTruncation = null
  let lastLinkRows = []
  // 关联物化行（S5 Task 4）：`related.jsonl` 的内存镜像。**唯一写入口仍是 persist()**
  // ——全量（buildIndex）与增量（updateDoc）共用同一份序列化/原子落盘逻辑，
  // 避免"全量写了 related、增量忘了写"这种静默陈旧（S1 截断事故的同类故障模式）。
  let relEdges = []
  // 计算期丢弃计数（S5 Task 6）：`stats().related.dropped` 的**唯一**来源。只在物化计算
  // （buildRelations / relateIncremental）里被重置并累加 —— 读时校验剔除**绝不**计入，
  // 否则同一库的 stats 会随查询历史漂移（spec §7.2，不可复现 = 指标失效）。
  let relDropped = { noShared: 0, missingEnd: 0, capped: 0 }
  // 块上限截断计数（S6）：护栏触发的**可观测**留痕。原先 `slice(0, MAX_BLOCKS_PER_DOC)`
  // 静默丢尾部 ⇒ "文件里有、知识库没有"无迹可循（实测：合并后文件 302 条 / 索引 254 条）。
  // 只统计**本次建/更新索引**期间的截断，随 scanAll / updateDoc 重置，语义同 relDropped。
  let blockCaps = { docs: 0, droppedBlocks: 0, docIds: [] }
  // 截断块并**出声**：护栏可以存在，静默丢数据不行。
  const capBlocks = (doc) => {
    if (!doc || !Array.isArray(doc.blocks) || doc.blocks.length <= MAX_BLOCKS_PER_DOC) return doc
    const dropped = doc.blocks.length - MAX_BLOCKS_PER_DOC
    blockCaps.docs += 1
    blockCaps.droppedBlocks += dropped
    blockCaps.docIds.push(doc.id)
    console.warn(`[knowledge] ${doc.id}: 块数 ${doc.blocks.length} 超上限 ${MAX_BLOCKS_PER_DOC}，尾部 ${dropped} 块**未索引**（文件里仍在，但检索/关联/图谱都看不到）`)
    doc.blocks = doc.blocks.slice(0, MAX_BLOCKS_PER_DOC)
    return doc
  }
  // docs 的"代数"：docs 被整体替换（buildIndex / loadIndexFromDisk）或**原地改写**
  // （updateDoc 的 `docs[i] = 新doc`）时自增。读路径的缓存（块表 / 标题表）以此作键 ——
  // 不能用 `docs` 数组引用：updateDoc 原地改，引用不变，按引用缓存会取到已被替换的旧块，
  // 于是"块是否还存在"答错、读时校验静默失效。
  let docsGen = 0
  const _relateMode = resolveRelateMode(configDir, relateMode)
  const relateOn = () => _relateMode !== 'off'

  const file = (name) => join(idxDir, name)

  function scanAll() {
    blockCaps = { docs: 0, droppedBlocks: 0, docIds: [] }
    const acc = { docs: [], links: [] }
    // 截断统计（2026-09-14 批次 4）：按空间记录"撞到 maxFiles 上限、还有文档没进索引"。
    // 旧实现静默停手 → 用户看到"索引成功"，而超出上限的文档搜不到、图谱里没有、
    // 统计数字也不含，且没有任何迹象说明原因。
    const trunc = { truncated: false, limit: FILE_LIMIT_PER_SPACE, spaces: [], count: 0 }
    for (const space of spaces) {
      const stats = {}
      for (const { absPath, relPath } of walkMd(space.root, { maxFiles: FILE_LIMIT_PER_SPACE, stats })) {
        try {
          const parsed = parseDocFile({ absPath, space, relPath })
          capBlocks(parsed.doc)
          acc.docs.push(parsed.doc)
          acc.links.push(...parsed.links)
        } catch { /* 单文档解析失败：跳过，不拖垮整库 */ }
      }
      if (stats.truncated) {
        trunc.truncated = true
        trunc.spaces.push({ spaceId: space.id, count: stats.count, limit: stats.limit })
        trunc.count += stats.count
      }
    }
    // 留痕落在模块级变量上（persist 才是写盘处，但那里看不到 scanAll 的局部变量）：
    // 由 persist 写进 manifest —— 只有写盘才跨进程可见，否则"库里少了 300 篇文档"
    // 这件事在下次 CLI 调用时就无从得知。
    lastTruncation = trunc
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
        ? resolveLinkTarget({
          fromRel: owner.rel, to: l.to, spaceId: owner.spaceId, docIds: ids, self: l.self,
        })
        : null
      // `anchor`/`line`/`block` 一并保留（S5.1）：`block` 是链接所在**条目**的块号，
      // 是条目级 ref 关联的源；`line` 供 GUI 跳转定位；`anchor` 是被引块的别名/锚点。
      // 批次 2 再加三类语义：`anchorKind`（'heading'|'block'）+ `anchorRef`（锚点原文）让链接能
      // 落到"那一节/那个块"，`embed` 区分 `![[x]]`（阅读视图要内联渲染），`self` 是 `[[#x]]`
      // 同文档锚点（目标 = 来源文档自身）。落盘与内存（linkOut）必须**同一组字段**，
      // 否则"重建索引后好、编辑一次后字段没了"这类不一致又会回来。
      nextLinks.push({
        from: l.from, to: l.to, anchor: l.anchor || '', line: l.line, block: l.block ?? null, target,
        anchorRef: l.anchorRef || '', anchorKind: l.anchorKind || '',
        embed: l.embed === true, self: l.self === true,
      })
      const edge = {
        to: l.to, target, block: l.block ?? null, line: l.line, anchor: l.anchor || '',
        anchorRef: l.anchorRef || '', anchorKind: l.anchorKind || '',
        embed: l.embed === true, self: l.self === true,
      }
      const arr = out.get(l.from)
      if (arr) arr.push(edge)
      else out.set(l.from, [edge])
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
      // 文件数上限留痕（2026-09-14 批次 4）：只有 `truncated: true` 时才写键 ——
      // 没截断的常态下不该在 manifest 里留痕（与 `relLines` 同一取舍：off/常态不留无用键）。
      ...(lastTruncation?.truncated ? { filesTruncated: lastTruncation } : {}),
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
      // `block`/`line` 必须一并读回（S5.1）：ref 边以"链接所在的**条目**"为源，
      // 只回填 to/target 会让**重载索引后 ref 边整体消失**（物化文件里有、内存里没有），
      // 表现为"重启一次引用关联就没了"。
      const row = {
        to: l.to, target: l.target, block: l.block ?? null, line: l.line ?? null,
        // `anchor`/锚点/`embed`/`self` 同样必须读回：阅读视图要靠 anchorKind+anchorRef 跳到
        // "那一节/那个块"，靠 embed 把 `![[x]]` 渲染成内联内容，靠 self 处理 `[[#x]]`。
        // 只回填 to/target 会让这些能力**在重载索引后整体消失**（磁盘上有、内存里没有），
        // 表现为"重启一次，嵌入变回普通链接、锚点跳不动"——与当年 ref 边消失同一类 bug。
        anchor: l.anchor || '', anchorRef: l.anchorRef || '', anchorKind: l.anchorKind || '',
        embed: l.embed === true, self: l.self === true,
      }
      const arr = linkOut.get(l.from)
      if (arr) arr.push(row)
      else linkOut.set(l.from, [row])
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
    // 读回截断留痕（2026-09-14 批次 4）：**必须从盘上恢复**，否则"库里少了 N 篇文档"
    // 只在触发重建的那一次进程里可见，之后每次 CLI 调用都报"未截断" —— 一个只在重建瞬间
    // 存在的警告等于没有警告（用户重启客户端就再也看不到）。
    lastTruncation = manifest.filesTruncated
      ? { ...manifest.filesTruncated, staleSweepSkipped: false }
      : null
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
    let truncated = false
    for (const space of spaces) {
      const stats = {}
      for (const { absPath, relPath } of walkMd(space.root, { maxFiles: FILE_LIMIT_PER_SPACE, stats })) {
        const id = toDocId(space.id, relPath)
        seen.add(id)
        const rec = lastFiles[id]
        if (!rec) return true                       // 新增文件
        try {
          const st = statSync(absPath)
          if (st.size !== rec.size || Math.abs(st.mtimeMs - rec.mtime) > 1) return true
        } catch { return true }                     // 读不到 → 保守重建
      }
      if (stats.truncated) truncated = true
    }
    // "磁盘已删"的清扫**在截断时必须跳过**（2026-09-14 批次 4）：
    // seen 里没有的文件可能只是排在 5001 名之后、这轮根本没走到 —— 据此判"已删"会让
    // >5000 文件的库**每次 load 都全量重建**（而且重建写回的 lastFiles 依然缺那些文件，
    // 于是下一轮又重建）：索引永远追不上，CPU 白烧，还会和写入互相抢盘。
    // 代价是超限空间里真的删掉文件时这一轮发现不了 —— 诚实的不确定 > 假装知道。
    if (!truncated) {
      for (const id of Object.keys(lastFiles)) if (!seen.has(id)) return true  // 磁盘已删
    } else {
      lastTruncation = { ...(lastTruncation || {}), staleSweepSkipped: true }
    }
    return false
  }

  // ── 检索（Task 7）───────────────────────────────────────────────────────
  const docIndexById = () => { const m = new Map(); docs.forEach((d, i) => m.set(d.id, i)); return m }

  /** 块级评分。degraded=true 时跳过向量路（查询 gram 全部落空，只能靠关键词）。 */
  function scoreBlock(doc, b, qvec, qtext, kws, degraded) {
    const cos = degraded ? 0 : cosine(
      vectorizeText(indexTextOf(b), { tagBoost: blockTagBoost(b), idf }), qvec,
    )
    // 关键词路的 summary 与向量路**同一口径**（S5 §8：retrievalText = 摘要 ∪ 去前缀 full）——
    // 两条路径喂给融合评分的必须同源，否则"向量说近、关键词说远"会在同一查询内互相抵消。
    // 取并集而非只取 full：关键词路恰恰最擅长精确词命中，把摘要独有词从倒排里去掉，
    // 等于把 `不回显` 这类用户真会敲的词判为不相关（实测退化 0.667→0.084，见 indexTextOf 注释）。
    // `full: b.full` 保持原样：它是 `mode='full'` 的正文来源，也是"内容落在摘要截断之外"的兜底信号。
    const kw = keywordScore({ tag: b.tag || '', summary: retrievalText(b), full: b.full || '', theme: doc.title }, kws)
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
  /**
   * 把解析结果压成 **JSON 安全**的元信息回给调用方（批次 3）。
   *
   * 为什么单独抽一层而不直接返回 `parsed`：`parsed.regexes[].re` 是 RegExp 实例，
   * 直接塞进 CLI 的 stream-json 输出会变成 `{}`（JSON 序列化丢字段）—— 调用方拿到一个空对象，
   * 只能猜"正则到底生效没"。这里显式展开成字符串字段，让"生效的算子"可被机器消费。
   */
  function queryMeta(p) {
    return {
      filters: (p.filters || []).map((f) => ({ field: f.field, value: f.value, negate: !!f.negate })),
      fields: [...(p.hint || [])],
      terms: [...(p.terms || [])],
      phrases: [...(p.phrases || [])],
      regexes: (p.regexes || []).map((r) => ({ value: r.value, negate: !!r.negate })),
      or: (p.orGroups || []).length > 0,
      strict: p.strict === true,
      filterOnly: p.filterOnly === true,
      // 枚举路径开关（含只有正则的查询，见 knowledge-query.mjs 的 enumerate 说明）
      enumerate: p.enumerate === true,
    }
  }

  /**
   * 枚举检索（批次 3）：查询里**没有可打分的正向文本**，只有过滤条件或正则
   * （`tag:财务`、`path:reports/`、`/\d+%/`）。
   *
   * 为什么不能复用打分链：`scoreBlock` 的每一路都需要**文本证据**（向量余弦 / 关键词命中 /
   * 结构近似），没有词时全为 0 → `isHit` 恒假 → 命中集恒空。用户写 `tag:财务` 会得到"没搜到"，
   * 而库里明明有那个标签。这类查询的正确语义是**枚举**：把所有满足条件的块找出来。
   *
   * 返回形态与 `searchInner` 完全一致（`items`/`count`/`total`/`query`），调用方无需分支。
   * 排序：按**文档路径**（可预测 —— 枚举结果之间没有相关度可言，给一个稳定顺序即可，
   * 用 mtime 会让"同样的查询两次结果顺序不同"，看起来像 bug）。
   */
  function enumerateSearch(parsed, { allow, topK, maxBytes, mode, age, meta }) {
    const out = []
    const limit = Math.max(1, Number(topK) || 5)
    const hits = []
    for (const doc of docs) {
      if (allow && !allow.has(doc.spaceId)) continue
      if (!matchDocQuery(doc, parsed)) continue
      // 每篇取"最合适的一个块"作为代表：第一个满足全部条件的块；都不满足则跳过整篇。
      // 不给"所有匹配块"是因为调用方（GUI 列表 / agent）按块展示，一篇出十条会淹没结果。
      let chosen = null
      for (const b of doc.blocks) {
        if (!matchBlockQuery(b, doc, parsed)) continue
        // 文本项**无条件**判（不只在 strict 时）：枚举模式没有打分兜底，查询里的文本项
        // （正则、否定词）就是谓词本身。漏掉这一条的话纯正则查询会把每篇的第一个块都算命中。
        if (!matchTextParts(b.text, parsed)) continue
        chosen = b
        break
      }
      if (!chosen) continue
      hits.push({ doc, block: chosen })
    }
    hits.sort((a, b) => (a.doc.rel < b.doc.rel ? -1 : a.doc.rel > b.doc.rel ? 1 : 0))
    for (const { doc, block } of hits) {
      if (out.length >= limit) break
      // 用 `toItem` 走同一条产出路径（snippet 截断、块 id、标签、grep 字段都在里面），
      // 保证"枚举结果"与"打分结果"在字段上完全同形 —— 否则前端要按来源写两套渲染。
      out.push(toItem(doc, block, { cos: 0, kw: 0, struct: 0, raw: 0, contentHits: 0 }, mode, false))
    }
    return {
      items: out, count: out.length, total: hits.length, indexAge: age, degraded: false, ...meta,
      // 说明"为什么这些结果看起来没有相关度排序"：让调用方能如实告诉用户（而非自己猜）
      orderedBy: 'path',
    }
  }

  function searchInner({ query = '', keywords = [], spaces: only = null, topK = 5, maxBytes = 2048, mode = 'snippet' } = {}) {
    const q = String(query || '').trim()
    const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean)
    const rawText = q || kws.join(' ')
    const age = builtAt ? Date.now() - Date.parse(builtAt) : null
    if (!rawText) return { items: [], count: 0, total: 0, indexAge: age, degraded: false }
    const allow = Array.isArray(only) && only.length ? new Set(only) : null

    // 检索语法层（批次 3）：解析成结构化查询，再"先过滤、后打分"。
    // 过滤器放打分**之前**不只是省算力：语义上就是"在这些文档里搜"，而不是"搜完再扔掉一些"。
    const parsed = parseSearchQuery(rawText)
    const meta = { query: queryMeta(parsed) }
    if (!parsed.ok) {
      // 解析失败（无效正则 / 查询串过长）→ **明确报错**，不静默当成文本搜。
      // 静默降级会给出"看起来能搜到、语义完全不同"的结果，比报错难排查得多。
      return { items: [], count: 0, total: 0, indexAge: age, degraded: false, queryError: parsed.error, ...meta }
    }
    // 打分用的文本**必须剥掉算子**：把 `tag:财务` 原样喂给 vectorizeText 会把整串切 gram，
    // 于是"搜 tag:财务"会命中一堆含 "tag" 的文档 —— 过滤器只该过滤，不该参与打分。
    const qtext = parsed.enumerate ? '' : (parsed.textQuery || '')
    if (parsed.enumerate) {
      // 枚举路径（无正向检索文本）：`tag:财务`、`path:reports/`、纯正则 `/\d+%/`。
      // 打分链需要文本证据（cos/kw/struct），没有词时全为 0 → 命中集恒空 →
      // 用户看到"明明有那个标签却搜不出东西"。枚举 + 逐块核对才是这类查询的正确语义。
      return enumerateSearch(parsed, { allow, topK, maxBytes, mode, age, meta })
    }
    if (!qtext) {
      // 只有否定项（`-foo`）而没有任何正向文本：没有可打分的东西。
      // 返回空 + 让 UI 说明原因，好过"随便给一堆结果"（用户会以为否定词失效了）。
      return { items: [], count: 0, total: 0, indexAge: age, degraded: false, ...meta }
    }
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
      // 文档级过滤（批次 3）：`tag:` / `path:` / `file:` 与否定项在这里一次判掉。
      // 放在候选排序**之前**：先缩小候选集再排序，大库上是数量级差别（排序本身是 O(n log n)）。
      .filter((i) => matchDocQuery(docs[i], parsed))
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
        // 块级过滤（批次 3）：`section:` / `content:` / `block:` 与否定项。
        // 过滤掉的块不参与 best 竞争 —— 若整篇的块都被过滤掉，这篇自然进不了结果（符合预期）。
        if (!matchBlockQuery(b, doc, parsed)) continue
        // 严格文本判定（批次 3）：**只在用户显式写了布尔逻辑时**启用（`OR` 或 `-x`）。
        // 没写时保持既有"部分命中也能召回"的打分行为不变 —— 无条件改成 AND 语义会让
        // 老查询的结果突然变少，那是行为回退而不是修 bug（见 knowledge-query.mjs 的 strict 注释）。
        if (parsed.strict && !matchTextParts(b.text, parsed)) continue
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
        // 图扩展也必须遵守过滤条件（批次 3）：否则 `tag:财务` 会把命中文档的**链接目标**
        // 一并带出来 —— 那些文档没有该标签，用户看到的是"过滤没生效"（比漏结果更糟：
        // 它让人不敢信任过滤）。外链是"相关"的弱证据，不该突破用户显式给的约束。
        if (!matchDocQuery(tdoc, parsed)) continue
        for (const b of tdoc.blocks) {
          if (b.kind !== 'heading' && b.kind !== 'entry') continue
          if (!matchBlockQuery(b, tdoc, parsed)) continue
          const bid = toBlockId(tdoc.id, b.n)
          if (seen.has(bid)) continue
          const sc2 = scoreBlock(tdoc, b, qvec, qtext, kws, degraded)
          const cand2 = toItem(tdoc, b, sc2, mode, true)
          if (isHit(sc2, cand2.score)) { seen.add(bid); items.push(cand2) }
        }
      }
    }

    // 3.5) 标签直连（2026-09-14 对标 Obsidian 批次 1）：
    //      查询串 / 关键词与某个标签**完全相同**（大小写不敏感、容忍前导 `#`）时，把带该标签的
    //      文档直接作为候选并入结果。
    //
    //      为什么**必须**有这一路（真进程实测出来的洞）：标签写在 frontmatter 里，**不在任何块
    //      的文本中**，而倒排与关键词路都只索引块文本 → `财务` 这种"只当标签用、正文从不提"的
    //      词，全文检索恒为 0 命中。于是"标签视图点一下去看同标签文档"会得到一片空白
    //      （实测：`index-tags` 里有 `财务`，`search --query 财务` 返回空 items）。
    //      Obsidian 用 `tag:` 算子解决同一问题；本仓库的 `tag:` 算子在批次 3 已实现（走
    //      enumerateSearch 枚举路径），但**拿标签名当查询词**仍是用户最自然的动作，必须能命中。
    //      同时这也让 agent 侧的 KnowledgeSearch 能按标签找料。
    //      注意：`tag:财务` 在这里**不会**被当成标签名（带算子前缀时 tagTerms 里是 "tag:财务"，
    //      匹配不上任何标签）—— 它交给上面的 filterOnly 路径，两条路不会重复出结果。
    const tagTerms = new Set(
      [q, ...kws].map((x) => String(x).trim().replace(/^#+/, '').toLowerCase()).filter(Boolean),
    )
    if (tagTerms.size) {
      const haveDocs = new Set(items.map((x) => x.docId))
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]
        if (allow && !allow.has(doc.spaceId)) continue
        // 标签直连也要遵守过滤条件（批次 3）：`path:reports/ 财务` 里那个 `财务` 命中的标签
        // 只应作用于 reports 内的文档；否则过滤条件被"另一条路径的兜底"绕过，用户看到越界结果。
        if (!matchDocQuery(doc, parsed)) continue
        if (haveDocs.has(doc.id)) continue          // 正文已命中 → 不重复给一条更弱的标签命中
        if (!doc.tags || !doc.tags.length) continue
        const hitTag = doc.tags.find((tg) => tagTerms.has(String(tg).toLowerCase()))
        if (!hitTag) continue
        // 锚点块：标题 > 条目 > 首块。标签命中的文档最该露出来的就是它的"领头内容"。
        const anchor = doc.blocks.find((b) => b.kind === 'heading')
          || doc.blocks.find((b) => b.kind === 'entry')
          || doc.blocks[0]
        if (!anchor) continue
        const bid = toBlockId(doc.id, anchor.n)
        if (seen.has(bid)) continue
        seen.add(bid)
        haveDocs.add(doc.id)
        // 打分：**走既有 struct 通道由公式算**（不臆造分数）——标签命中没有正文证据，
        // 于是 cos / kw 项给 0，只让 structBoostOf 的"标签命中"权重（0.67）参与，
        // 结果 ≈ 0.15×0.67 ≈ 0.10，天生低于任何带正文证据的命中。口径与数值推导见 TAG_HIT_FLOOR。
        const struct = structBoostOf({ block: anchor, doc, query: q, keywords: [String(hitTag)] })
        const it = toItem(doc, anchor, { cos: 0, kw: 0, struct }, mode, false)
        if (!(it.score > 0)) it.score = TAG_HIT_FLOOR
        it.tagHit = String(hitTag)                  // 消费方可据此区分"命中正文"与"命中标签"
        items.push(it)
      }
    }

    items.sort((a, b) => b.score - a.score)
    // 命中总数（2026-09-14 批次 1）：**截断前**的候选条数。
    // 为什么不能拿 `count` 充数：`count` 是"实际返回条数"（受 topK / maxBytes 双重截断），
    // 用户看到的"命中 5 条"其实可能是"命中 300 条里给了 5 条"——这两件事在 UI 上是
    // 完全不同的信息（要不要再加关键词 / 要不要放宽 topK）。`count` 语义保持不变（既有消费方
    // 如注入预算按它算），只**新增** `total`。
    const total = items.length
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
    // `...meta`（批次 3）：回给调用方"哪些算子生效、是否仅过滤、是否严格布尔"，
    // GUI 据此回显（否则用户看到结果变少却不知道是哪个算子起了作用）。
    return { items: out, count: out.length, total, indexAge: age, degraded, ...meta }
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
      // 与全量建索引共用**同一份** linkRowsOf（2026-09-14 批次 2 修正）。
      // 修的是什么：旧实现在这里自己重写了一遍链接抽取，只产 `{from,to,target}` —— 于是
      // **任何一个被编辑过的文档，它的引用都会丢掉 line/block/anchor/锚点/嵌入**，
      // 条目级 ref 关联（"哪条经验引用了这篇文档"）随之消失或退化成"整篇条目全连"。
      // 这类 bug 不报错、不抛异常，只是关联质量悄悄变差，所以必须靠"单一定义"从根上堵住。
      for (const l of linkRowsOf(raw, doc.id, doc.blocks)) {
        const target = resolveLinkTarget({
          fromRel: doc.rel, to: l.to, spaceId: doc.spaceId, docIds: ids, self: l.self,
        })
        rows.push({ ...l, target })
        const { from: _ignored, ...rest } = l
        out.push({ ...rest, target })
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
    // ref 边（S5.1 spec §4.2）：把**手写引用**变成条目级关联。
    //
    // 源 = 链接所在的**条目**（`link.block`，由 parseDocFile 按行号定位）；定位不到块时
    // 退化为"该文档的全部条目"（宁可全连也不丢这条引用，但仍受 MAX_REF_RELATED 约束）。
    // 目标 = 被引文档的条目，按 `cos(源, 目标)` 降序取前 MAX_REF_RELATED。
    // **断链（target 为 null）不产生任何边** —— 这同时是伪链接的**兜底**：
    // 即便 `extractLinks` 的形状校验漏了某种伪链接，它也 resolve 不到真实文档 → 无边。
    // 放在镜像轮**之前**：ref 边也获得反向行，条目级也能回答"谁引用了我"。
    {
      const byDoc = new Map()
      for (const b of pool) {
        const a = byDoc.get(b.docId)
        if (a) a.push(b)
        else byDoc.set(b.docId, [b])
      }
      const byId = new Map(pool.map((b) => [b.blockId, b]))
      const vcache = new Map()
      const vecOf = (b) => {
        let v = vcache.get(b.blockId)
        if (!v) {
          v = vectorizeText(relationContent(b), { tagBoost: RELATION_TAG_BOOST, idf: relIdf })
          vcache.set(b.blockId, v)
        }
        return v
      }
      for (const [fromDoc, links] of linkOut) {
        for (const l of links) {
          if (!l.target) continue
          const targets = byDoc.get(l.target)
          if (!targets || !targets.length) continue
          const one = l.block != null ? byId.get(`${fromDoc}#${l.block}`) : null
          const sources = one ? [one] : (byDoc.get(fromDoc) || [])
          for (const s of sources) {
            const picked = targets
              .map((t) => ({ t, cos: cosine(vecOf(s), vecOf(t)) }))
              .sort((a, b) => b.cos - a.cos || (a.t.blockId < b.t.blockId ? -1 : 1))
              .slice(0, MAX_REF_RELATED)
            for (const { t, cos } of picked) {
              add(s.blockId, t.blockId, { kind: 'ref', to: l.target, score: Number(cos.toFixed(4)) })
            }
          }
        }
      }
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

  // 排序键：tag（骨架层，必然非空零噪声）→ **ref（用户手写的引用意图）** → content（自动派生）
  // → 其他（duplicate，最后）。同层内按 score 降序、再保持物化顺序（sort 稳定 + 物化可复现），
  // 不另造一套排序口径（两套排序必然漂移）。
  // ref 排在 content 之前（S5.1 spec §4.3）：手写引用是**人的明确意图**，
  // 比机器算出的相似度更该占据有限的呈现预算（`limit` 截断时先保 ref）。
  const relRank = (r) => {
    const k = r?.why?.kind
    return k === 'tag' ? 0 : k === 'ref' ? 1 : k === 'content' ? 2 : 3
  }
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
   * 一篇文档内**所有条目块**的锚点（S5 Task 9：GUI 条目卡片关联行 / Inspector 关联段）。
   *
   * 为什么必须批量（而不是让 GUI 按块逐条调 `getRelated`）：`/knowledge/related` 一次只答
   * 一个 blockId，而每次 HTTP 调用在 bridge 侧都是一次**新内核进程**（约 50–70MB RSS）。
   * 一篇经验文档常有几十条条目，逐块问就是几十次进程 spawn —— 打开一篇文档把机器拖住，
   * 这是不可接受的默认代价。故在这里按文档聚合：一次进程答完，前端按 blockId 取用。
   *
   * 排序/上限/校验口径**完全复用 `relatedOf`**（不另写一套）：快由物化负责、对由校验负责，
   * 两边排序若各写一份必然漂移（`related --id` 与卡片上的顺序不一致 = 查不出来的 bug）。
   * 只回锚点摘要（同 `relSummary`，**不含正文**）；空锚点的块不出现在结果里（不产空壳）。
   */
  function getRelatedForDoc(docId, { validate = true, limit = MAX_RELATED } = {}) {
    const id = String(docId ?? '')
    if (!id) return []
    const doc = docs.find((d) => d.id === id)
    if (!doc) return []      // 文档不存在 ⇒ 空数组（与 links 的"空集即空集"惯例一致）
    const table = validate ? readView().blocks : null
    const out = []
    for (const b of doc.blocks) {
      const blockId = toBlockId(id, b.n)
      const related = relatedOf(blockId, { validate, limit, lookup: table })
      if (related.length) out.push({ blockId, related })
    }
    return out
  }

  /**
   * 文档级隐式关联（S5 Task 9：GUI 图谱的「关联图层」）。
   *
   * 为什么需要它：spec §7.5 要求图谱区分"显式链接 / 隐式关联"两层，但 §7.2 只给了**块级**
   * `getRelated`。图谱问的是"这篇文档和谁相关"，逐块问等于 N 篇 × 每篇几十次内核进程
   * （见 `getRelatedForDoc` 的 why）。故在这里把块级边归并成文档对。
   *
   * 归并口径（与块级同源，不另造口径）：
   *   · 来源 = `relEdges`（物化行）+ `validateRelation` 读时校验（快由物化、对由校验）
   *   · 只收 `tag` / `content`：`duplicate` **不是关联**（spec §5.5），图谱上画它只会误导
   *   · 同文档内的块间关联 → 图谱上是自环，丢弃（自环没有导航价值）
   *   · 无序对去重：`tag` 优先于 `content`（骨架层比覆盖层可信），同类取最高分；
   *     `count` = 该对背后的块级边数（"为什么连上"的旁证量，供悬停/报告用）
   *   · 排序：层序 → 分降序 → docId 升序（最后两项保证同一库的两次输出逐字相同）
   */
  function relatedDocEdges({ space = null } = {}) {
    if (!relEdges.length) return []
    const ids = new Set((space ? docs.filter((d) => d.spaceId === space) : docs).map((d) => d.id))
    const table = readView().blocks
    const merged = new Map()
    for (const r of relEdges) {
      const kind = r?.why?.kind
      if (kind !== 'tag' && kind !== 'content') continue
      const a = docIdOfBlockId(r.from)
      const b = docIdOfBlockId(r.to)
      if (!a || !b || a === b) continue
      if (!ids.has(a) || !ids.has(b)) continue
      if (validateRelation(r, table) !== true) continue
      const rank = kind === 'tag' ? 0 : 1
      const score = typeof r.why.score === 'number' ? r.why.score : null
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
      const cur = merged.get(key)
      if (!cur) { merged.set(key, { from: a, to: b, kind, score, rank, count: 1 }); continue }
      cur.count += 1
      if (rank < cur.rank || (rank === cur.rank && (score ?? -1) > (cur.score ?? -1))) {
        cur.kind = kind
        cur.score = score
        cur.rank = rank
      }
    }
    return [...merged.values()]
      .sort((x, y) => x.rank - y.rank || (y.score ?? -1) - (x.score ?? -1)
        || x.from.localeCompare(y.from) || x.to.localeCompare(y.to))
      .map(({ rank, ...e }) => e)   // rank 是内部排序键，不进输出（同 relRank 的处理）
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
    capBlocks(parsed.doc)
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
  /** 某文档某行所属的块（行号在**原始文件**基准上，与 doc.blocks[].line 同基准） */
  function blockAtLineOf(doc, line) {
    if (!doc || typeof line !== 'number') return null
    const bs = doc.blocks || []
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]
      const next = bs[i + 1]
      if (line >= b.line && (!next || line < next.line)) return b
    }
    return null
  }

  /**
   * 某位置所在块的短文本（反链 / 提及面板的"上下文"）。
   * 截断长度取 120 字：面板宽度约 260px，两行内能读完；再长就变成"把整段贴过来"，
   * 反链列表会从"扫一眼"退化成"逐条读"。
   */
  function snippetAt(docId, line) {
    const doc = docs.find((d) => d.id === docId)
    const b = blockAtLineOf(doc, line)
    if (!b) return ''
    const text = String(retrievalText(b) || '').replace(/\s+/g, ' ').trim()
    return text.length > SNIPPET_LEN ? `${text.slice(0, SNIPPET_LEN)}…` : text
  }

  /**
   * 引用关系（2026-09-14 批次 2 增强为"引用体系"）。
   *
   * **out（出链）**：补 `line`/`block`/`anchor`/锚点三件套/`embed`/`self`。
   *   阅读视图要靠它们做跳转（跳到哪一节）、嵌入渲染、以及"断链在第几行"的提示。
   *
   * **in（反链）**：旧实现只回 `{from}` —— 用户看到"某篇文档提到过这里"，却**不知道在哪一段、
   *   说了什么**，点过去只能从文档开头自己找。批次 2 补 `line`/`block`/锚点/`embed`/`self`，
   *   并附 `snippet`（所在块的短文本）。这是 Obsidian 反链面板的核心价值（上下文预览）。
   *
   * 实现仍是**全量扫 linkOut**（O(边数)）：真实库边数在几百量级，为它维护一份反向索引的收益
   * 抵不上"多一份需要同步的派生数据"的风险（ref 边消失的教训还热着）。边数上千再谈。
   */
  function getLinks(docId) {
    const out = (linkOut.get(docId) || []).map((l) => ({
      to: l.to, target: l.target, line: l.line ?? null, block: l.block ?? null,
      anchor: l.anchor || '', anchorRef: l.anchorRef || '', anchorKind: l.anchorKind || '',
      embed: l.embed === true, self: l.self === true,
    }))
    const inb = []
    for (const [from, arr] of linkOut) {
      for (const l of arr) {
        if (l.target !== docId) continue
        inb.push({
          from, line: l.line ?? null, block: l.block ?? null,
          anchor: l.anchor || '', anchorRef: l.anchorRef || '', anchorKind: l.anchorKind || '',
          embed: l.embed === true, self: l.self === true,
          snippet: snippetAt(from, l.line),
        })
      }
    }
    // 反链按**来源文档**聚合排序：同文档的多处提及挨在一起，便于"这篇文档在几处提到我"一眼看完
    inb.sort((a, b) => String(a.from).localeCompare(String(b.from)) || (a.line ?? 0) - (b.line ?? 0))
    return { out, in: inb }
  }

  /**
   * 未链接提及（Unlinked mentions，2026-09-14 批次 2）——Obsidian 的核心发现机制之一：
   * "你在别处写过它，只是没打链接"。用户据此补链，知识网络才从"孤立文档"变成连通图。
   * 没有它，本系统的引用体系只能反映**已经**建立的连接，无法提示**本该建立**的连接。
   *
   * 匹配口径（刻意保守：宁可漏报，不要误报——误报会让面板变噪声，用户就不再看了）：
   *   · 关键词 = 标题 + 文件名 stem（去 `.md`），长度 < `MIN_MENTION_LEN` 的一律不用
   *     （单字标题"甲"会命中成百上千处，全是噪声）；
   *   · 在**块文本**上做包含匹配（大小写不敏感）；
   *   · 该块若已有指向本文档的**显式链接** → 不算"未链接"（那已经在引用体系里了，重复列出
   *     会让"未链接提及"与"反链"两个面板显示同一件事）；
   *   · 排除文档自身（自己提自己的标题不算）。
   *
   * 成本护栏：全库 O(块数 × 关键词数)。故 `limit` 生效方式是**扫到就停**（提前返回），
   * 不是扫完再截断——大库上这条路径会扫几万个块，扫完再截是白烧 CPU。
   */
  function listMentions(docId, { limit = 30 } = {}) {
    const target = docs.find((d) => d.id === docId)
    if (!target) return { items: [], count: 0, truncated: false }
    const keys = [...new Set([
      String(target.title || '').trim(),
      basename(target.rel || '').replace(/\.md$/i, '').trim(),
    ].filter((k) => k.length >= MIN_MENTION_LEN))]
    if (!keys.length) return { items: [], count: 0, truncated: false }
    const lower = keys.map((k) => k.toLowerCase())
    const cap = Math.max(1, Number(limit) || 30)
    const items = []
    let truncated = false
    for (const doc of docs) {
      if (doc.id === docId) continue
      // 该文档已有指向本文档的链接所在块 → 这些块的提及不再算"未链接"
      const linkedBlocks = new Set(
        (linkOut.get(doc.id) || []).filter((l) => l.target === docId && l.block !== null).map((l) => l.block),
      )
      const linkedLines = new Set(
        (linkOut.get(doc.id) || []).filter((l) => l.target === docId).map((l) => l.line),
      )
      for (const b of doc.blocks || []) {
        if (linkedBlocks.has(b.n)) continue
        const text = String(retrievalText(b) || '')
        const hay = text.toLowerCase()
        const hit = lower.find((k) => hay.includes(k))
        if (!hit) continue
        // 同一块里已经有指向本文档的链接（行号命中）→ 视为已链接
        if (linkedLines.has(b.line)) continue
        items.push({
          docId: doc.id, spaceId: doc.spaceId, title: doc.title,
          blockId: toBlockId(doc.id, b.n), block: b.n, line: b.line, kind: b.kind,
          matched: keys[lower.indexOf(hit)],
          snippet: text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN),
        })
        if (items.length >= cap) { truncated = true; break }
      }
      if (truncated) break
    }
    return { items, count: items.length, truncated }
  }

  /**
   * 断链清单（2026-09-14 批次 2）：`target === null` 的引用行（写的时候目标不存在），按目标聚合。
   *
   * 为什么单独成一个 op 而不是塞进 stats：断链是**需要处理**的待办（补文档 / 改链接 / 删引用），
   * 不是统计数字。聚合到"目标名"这一层才有用——同一个拼错的目标名往往被写错好几次，
   * 按行列出来只会看到重复的同一件事。返回 `from` 列表让用户能直接点进去改。
   * `self=true` 的引用（`[[#x]]`）永远指向自身，不算断链（resolveLinkTarget 已保证）。
   */
  function listBrokenLinks({ space = null, limit = 200 } = {}) {
    const inPool = (id) => (!space || (docs.find((d) => d.id === id) || {}).spaceId === space)
    const byTo = new Map()
    for (const row of lastLinkRows) {
      if (row.target) continue
      if (!inPool(row.from)) continue
      const key = row.to || '(同文档锚点)'
      const cur = byTo.get(key)
      const ref = { from: row.from, line: row.line ?? null, block: row.block ?? null, anchorRef: row.anchorRef || '' }
      if (cur) { cur.count += 1; if (cur.refs.length < 20) cur.refs.push(ref) }
      else byTo.set(key, { to: key, count: 1, refs: [ref] })
    }
    const items = [...byTo.values()].sort((a, b) => b.count - a.count || a.to.localeCompare(b.to))
    const cap = Math.max(1, Number(limit) || 200)
    return { items: items.slice(0, cap), total: items.length, broken: items.reduce((n, x) => n + x.count, 0) }
  }

  /**
   * 文档级图谱（GUI 可视化用）：只保留空间内且**已解析**的显式链接边。
   *
   * `related`（S5 Task 9）：**只在显式要求时**附加隐式关联层（`relatedDocEdges`），
   * 缺省不带该字段 ⇒ 既有调用方（`/knowledge/graph` 不带参、既有测试的 deepEqual）零变化。
   * 为什么默认不带：spec §7.5 —— 实测真实库当前只有 1 条显式链接，若默认把关联层也返回并画上，
   * 图谱会从 1 条边骤增到几百条，第一印象被噪声淹没；图层要用户主动开。
   */
  /**
   * 条目级图谱（S5.1 spec §5.1）：节点 = 条目，边 = 三大关联（tag / content / ref）。
   *
   * 这是用户实测反馈的正解：真实库 **74/76 条条目挤在同一个文件里**，
   * 文档级图把这些条目间的 **290 条关联全部塌成自环**并过滤掉 ⇒
   * `graph --related` 只剩 1 条跨文档边，"看起来像没做图谱"。条目级才有信息量。
   *
   * - 节点带 `line`：GUI 点条目节点要能定位到该块（复用 S2 的块定位）。
   * - **不画文档级 `links`（显式链接）边**：它是**文档间**关系、不隶属某一条条目，
   *   硬映射到条目就是造假。条目级的"引用"由 `ref` 边表达（源=链接所在的条目），语义更准。
   * - **不画 `duplicate`**：重复是**去重提示**、不是阅读路径（S5 §5.5），进图只制造噪声。
   * - `related` 开关在条目级被忽略（恒返回关联边）：条目级图除关联外没有别的边，
   *   再让它受开关约束就只剩一堆孤立点，等于没图。
   */
  function getEntryGraph({ space = null, limit = 400 } = {}) {
    const pool = relatablePool().filter((b) => !space || b.spaceId === space)
    const chosen = pool.slice(0, limit) // 顺序即文档序+块序，稳定可复现
    const inGraph = new Set(chosen.map((b) => b.blockId))
    // `line` 不在 pool 元素上（relatablePool 只带关联必需字段），从 docs 取一次映射
    const lineOf = new Map()
    for (const d of docs) for (const b of d.blocks || []) lineOf.set(`${d.id}#${b.n}`, b.line ?? null)
    const nodes = chosen.map((b) => ({
      id: b.blockId, kind: 'entry', docId: b.docId, tag: b.tag ?? null,
      line: lineOf.get(b.blockId) ?? null,
      // label 用**去类型前缀**的内容前 40 字：类型前缀只标类型，占 label 纯属浪费
      label: relationContent(b).slice(0, 40),
    }))
    const seen = new Set()
    const edges = []
    for (const r of relEdges) {
      const k = r?.why?.kind
      if (k !== 'tag' && k !== 'content' && k !== 'ref') continue
      if (!inGraph.has(r.from) || !inGraph.has(r.to)) continue
      const key = `${r.from}\u0000${r.to}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: r.from, to: r.to, kind: k, score: r.why.score ?? null })
    }
    return { nodes, edges, level: 'entry', truncated: pool.length > chosen.length }
  }

  function getGraph({ space = null, limit = null, related = false, level = 'doc', around = null, hops = 1 } = {}) {
    // S5.1：层级开关。`entry` 走条目级图；`doc`（缺省）行为与 S2/S5 完全一致。
    //
    // ⚠️ 两个层级要**各自**的缺省上限（S6 修）：
    // 原先签名是 `limit = 200`，条目级也吃到这个 200 —— 而条目池随经验库增长（S6 合并后 254 条），
    // 于是条目图被截到 200 节点，且 `chosen = pool.slice(0, limit)` 是**从头截**，
    // 恰好吃掉排在后段的文档尾部（= 刚合并进来的那批经验）⇒ "合并了却看不见"。
    // 文档级上限 200 依然合适（spaces 只有几十篇文档），故只在条目级放宽到 1000。
    if (level === 'entry') return getEntryGraph({ space, limit: limit ?? 1000 })
    const pool = space ? docs.filter((d) => d.spaceId === space) : docs
    limit = limit ?? 200
    const ids = new Set(pool.map((d) => d.id))

    // 局部图（Neighborhood / "Local graph"，2026-09-14 批次 2）。
    // 为什么必须有：全局图在文档多起来之后是**毛线球**（几百个节点彼此连线，用户看不出结构），
    // 只能当装饰看。Obsidian 的局部图用"深度"把视野收敛到当前笔记的邻居，这才是能用的视图。
    // 遍历方向 = **双向**（出链 + 入链）：只走出链会漏掉"谁引用了我"，而反链恰是最关心的一侧。
    // 深度上限 3：4 跳后在典型库上已经回到"大半张图"，失去收敛意义。
    let chosen = null
    if (around && ids.has(around)) {
      const depth = Math.max(1, Math.min(3, Number(hops) || 1))
      const keep = new Set([around])
      let frontier = [around]
      // 反向邻接表**建一次**再逐跳用：否则每一跳都要 `for (const [from, arr] of linkOut)`
      // 扫一遍全表的边（深度 3 × 边数 = 白烧），而且那份扫描对每一跳的结果完全相同。
      const inbound = new Map()
      for (const [from, arr] of linkOut) {
        if (!ids.has(from)) continue
        for (const l of arr) {
          if (!l.target || !ids.has(l.target)) continue
          const cur = inbound.get(l.target)
          if (cur) cur.push(from)
          else inbound.set(l.target, [from])
        }
      }
      for (let h = 0; h < depth && frontier.length; h++) {
        const next = []
        for (const cur of frontier) {
          for (const l of linkOut.get(cur) || []) {
            if (l.target && ids.has(l.target) && !keep.has(l.target)) { keep.add(l.target); next.push(l.target) }
          }
          for (const from of inbound.get(cur) || []) {
            if (!keep.has(from)) { keep.add(from); next.push(from) }
          }
        }
        frontier = next
      }
      chosen = keep
    }

    const nodes = (chosen ? pool.filter((d) => chosen.has(d.id)) : pool.slice(0, limit))
      .map((d) => ({ id: d.id, label: d.title, spaceId: d.spaceId, kind: 'doc' }))
    // 边的两个端点都必须在 `nodes` 里：
    //   · 旧实现按 `ids`（**截断前**的池）过滤，于是 limit 截断时会产生"边指向不存在节点"的悬空边，
    //     前端渲染这种边要么报错、要么画到画布外（表现为"图上有几条莫名其妙的线"）；
    //   · 局部图更要把邻居之外的边全部丢掉，否则一眼看去还是全局图。
    // 另外按 `from→target` 去重：`[[a#第一章]]` 与 `[[a#第二章]]` 是两条引用记录（反链要分别显示）
    // 但它们只该画**一条**边（重复边只会让布局算法把两个节点反复推挤，视觉上更乱）。
    const present = new Set(nodes.map((n) => n.id))
    const edges = []
    const seenEdge = new Set()
    for (const [from, arr] of linkOut) {
      if (!present.has(from)) continue
      for (const l of arr) {
        if (!l.target || !present.has(l.target)) continue
        // 丢掉**自环**：`[[#本地小节]]`（同文档锚点，批次 2 新增支持的语法）会产出 from===to 的边。
        // 力导向布局里自环只会让节点自己抖、视觉上多出一根套在自己身上的线，表达不了任何关系。
        // （注意：自环是**数据层**的真实引用，只在这里——图层——过滤；反链/提及面板照常显示它。）
        if (l.target === from) continue
        const key = `${from}\u0000${l.target}`
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({ from, to: l.target, target: l.target })
      }
    }
    const base = { nodes, edges }
    // 显式要求 `related` 时：节点被 `limit` 截断 ⇒ 关联边也必须按**实际在场的节点**过滤，
    // 否则会出现"边指向画布上不存在的节点"（xyflow 直接丢弃，图上看是缺边 = 像索引坏了）
    if (related !== true) return base
    // 复用上面的 `present`（该集合已经按"实际画出来的节点"算好）——
    // 局部图与 limit 截断两条路径都能靠它挡住"边端点不在图上"的隐含边。
    return { ...base, related: relatedDocEdges({ space }).filter((e) => present.has(e.from) && present.has(e.to)) }
  }

  // ── 删除管理（回收站，2026-09-14）─────────────────────────────────────────
  const trashDir = join(kroot, TRASH_DIR_NAME)

  /**
   * 删/还原之后的索引刷新。语义等价于 `load({ force: true })`，但 `load` 是**返回对象的
   * 方法**、不在本闭包作用域内，故这里复刻它的两步行径。
   * 必须**重新发现空间**：删整库/还原整库会改变 `spaces` 集合本身（不是只有文档变了）。
   */
  function refreshAfterMutation() {
    spaces = discoverSpaces({ configDir, root: kroot })
    buildIndex()
  }

  /**
   * 删除权限判定。**刻意不看 `writable`**（见文件顶部不变量 ③），只认 `source`：
   *   user                          → 条目可删、整库可删
   *   experience / memory / skill_exp → 条目可删、**整库不可删**（用户明确要求：内置经验库、
   *                                    会话记录等系统库只允许删条目）
   *   pack                          → 条目与整库都不可删（只读来源）
   * 错误码与导入侧 `validateSpaceId` 对齐（`readonly-space` 是权限语义、不是"名字打错"）。
   */
  function deleteGate(spaceId, { whole = false } = {}) {
    const id = String(spaceId ?? '').trim()
    if (!id) return { ok: false, error: 'missing-space', message: 'delete: 需要 --space <空间id>' }
    const sp = spaces.find((s) => s.id === id)
    if (!sp) return { ok: false, error: 'unknown-space', message: `delete: 空间不存在：${id}` }
    if (sp.source === 'pack') {
      return {
        ok: false, error: 'readonly-space',
        message: `delete: ${id} 是只读知识包（来源不可修改），条目与空间都不允许删除`,
      }
    }
    if (whole && sp.source !== 'user') {
      return {
        ok: false, error: 'protected-space',
        message: `delete-space: ${id} 是内置空间「${sp.name}」，只允许删除其中条目、不允许删除整个空间`,
      }
    }
    return { ok: true, space: sp }
  }

  /**
   * 把 payload 搬进回收站并登记台账。返回 { trashId, bytes, files }。
   *
   * `keepSource`（2026-09-14 批次 4）：**复制**而不是搬走源文件。给"覆盖前自动备份"用 ——
   * 那种场景下源文件必须留在原地（紧接着就要写入新内容）。其余（台账格式、trashId 规则、
   * payload 相对结构、还原路径）与搬走完全一致，所以两处产出的条目在 GUI「最近删除」里
   * 都能正常还原，不需要第二套还原逻辑。
   *
   * `reason`：`'delete'`（用户删除）| `'overwrite'`（覆盖前自动备份）。
   * 必须落进条目里，否则 GUI 会把一条"自动备份"显示成"你删除了它"—— 用户看到自己没删过的东西
   * 出现在回收站里，会怀疑系统乱删文件。备份条目在还原语义上也不同：还原备份**不改变**当前
   * 文件（目标还在），所以 UI 该提示"另存为/比较"，而不是"还原覆盖"。
   */
  function stash({ kind, spaceId, spaceName, relPath, absPath, name, keepSource = false, reason = 'delete' }) {
    mkdirSync(trashDir, { recursive: true })
    const index = readTrashIndex(trashDir)
    const trashId = newTrashId((id) => index.items.some((it) => it.trashId === id) || existsSync(join(trashDir, id)))
    // doc 保留相对结构（`payload/a/b.md`）——还原时原样放回，不必再记"它原来在哪"；
    // space 则是整棵目录树进 `payload/`。
    const payload = kind === 'doc'
      ? join(trashDir, trashId, 'payload', ...relPath.split('/'))
      : join(trashDir, trashId, 'payload')
    const bytes = pathBytes(absPath)
    const files = listRelFiles(absPath)
    // ⚠️ 顺序要紧：**先搬再写台账**。反过来的话，写台账成功而搬失败会留下一条
    // 指向不存在内容的记录（GUI 里看得见、还原时才发现是空的）。
    // 同理 `keepSource` 的复制也必须在写台账之前完成（否则台账指向一个空 payload）。
    const via = keepSource ? copyPath(absPath, payload) : movePath(absPath, payload)
    const item = {
      trashId, kind, spaceId, spaceName: spaceName || spaceId,
      relPath: kind === 'doc' ? relPath : null,
      name: name || basename(absPath),
      deletedAt: new Date().toISOString(),
      bytes, files: files.slice(0, 200), fileCount: files.length, via, reason,
    }
    // 每条另存一份 meta.json：index.json 若被手工改坏，仍能从条目目录恢复出元数据。
    writeFileSync(join(trashDir, trashId, 'meta.json'), JSON.stringify(item, null, 2), 'utf-8')
    index.items.unshift(item)
    writeTrashIndex(trashDir, index)
    // 索引同步：搬走文件后 `indexStale()` 已能因"磁盘已删"判过期；此处主动 force 重建，
    // 让"删完立刻搜不到"在本进程内即成立（删除是低频的用户显式操作，重建成本可接受）。
    refreshAfterMutation()
    // `reason`/`via` 一并返回（2026-09-14 批次 4）：调用方（stashDoc → 服务端）需要
    // 如实知道"这条是怎么进回收站的"，`reason` 尤其重要 —— 回收站条目要区分
    // "用户删除"与"覆盖前自动备份"，否则用户会看到自己没删过的东西出现在回收站里。
    return { trashId, bytes, files: files.length, via, reason }
  }

  /** 软删除单个条目。 */
  function deleteDoc({ space, path }) {
    const gate = deleteGate(space)
    if (!gate.ok) return gate
    const sp = gate.space
    const rel = normalizeMdRel(path)
    if (!rel) {
      return {
        ok: false, error: 'bad-path',
        message: `delete-doc: --path 必须是空间内的相对 .md 路径（收到 ${JSON.stringify(path)}）`,
      }
    }
    const abs = join(sp.root, ...rel.split('/'))
    // ⚠️ 顺序：**先判存在、再判越界**。反过来的话，不存在的文件会让 `realpathSync` 抛错、
    // 被判成 `bad-path`（"路径非法"）—— 而 `zz.md` 明明是合法路径、只是没这个文件。
    // 把"文件不存在"报成"路径非法"，调用方会去查路径写法，方向完全错了。
    if (!existsSync(abs)) {
      return { ok: false, error: 'not-found', message: `delete-doc: 文件不存在：${sp.id}/${rel}` }
    }
    if (!realpathInside(sp.root, abs)) {
      return { ok: false, error: 'bad-path', message: `delete-doc: 路径越出空间根：${rel}` }
    }
    const r = stash({ kind: 'doc', spaceId: sp.id, spaceName: sp.name, relPath: rel, absPath: abs, name: basename(rel) })
    return { ok: true, kind: 'doc', spaceId: sp.id, path: rel, ...r, indexSync: 'reloaded' }
  }

  /**
   * 覆盖前备份（2026-09-14 批次 4）：把当前文件内容**复制**进回收站，原文件保留。
   *
   * 为什么不复用 `deleteDoc`：它是**删除**语义 —— 先把文件搬走（原文件消失），再重载索引。
   * 这个场景要的恰好相反：文件必须留在原地（调用方紧接着要写入新内容），索引也不该重载
   * （内容和路径都没变，重载只是白烧一次全量扫描）。
   *
   * 什么时候会被调用：客户端带着**过期的 mtime** 保存（文件已被 Obsidian/VSCode 改过），
   * 用户明确选择"以我这份为准"。此时磁盘上那份马上要被覆盖掉，备份是它唯一的留存机会。
   * 所以这个函数的失败必须让调用方**放弃写入**（服务端就是这么做的）——
   * 备份失败还继续覆盖，等于"备份功能形同虚设"。
   */
  function stashDoc({ space, path, reason = 'overwrite' }) {
    const sp = spaces.find((s) => s.id === String(space ?? '').trim())
    if (!sp) return { ok: false, error: 'space-not-found', message: `stash-doc: 空间不存在：${space}` }
    const rel = normalizeMdRel(path)
    if (!rel) return { ok: false, error: 'bad-path', message: `stash-doc: --path 必须是空间内的相对 .md 路径（收到 ${JSON.stringify(path)}）` }
    const abs = join(sp.root, ...rel.split('/'))
    // 同 deleteDoc 的顺序纪律：先判存在再判越界（否则"不存在"会被报成"路径非法"，方向全错）
    if (!existsSync(abs)) return { ok: false, error: 'not-found', message: `stash-doc: 文件不存在：${sp.id}/${rel}` }
    if (!realpathInside(sp.root, abs)) return { ok: false, error: 'bad-path', message: `stash-doc: 路径越出空间根：${rel}` }
    const r = stash({
      kind: 'doc', spaceId: sp.id, spaceName: sp.name,
      relPath: rel, absPath: abs, name: basename(rel),
      keepSource: true, reason: reason === 'delete' ? 'delete' : 'overwrite',
    })
    return { ok: true, kind: 'doc', spaceId: sp.id, path: rel, reason: r.reason, ...r }
  }

  /** 软删除整个用户自建空间（需 `confirm` 精确等于空间 id）。 */
  function deleteSpace({ space, confirm }) {
    const gate = deleteGate(space, { whole: true })
    if (!gate.ok) return gate
    const sp = gate.space
    const want = String(confirm ?? '').trim()
    if (want !== sp.id) {
      return {
        ok: false, error: 'confirm-mismatch',
        message: `delete-space: 需要 --confirm <空间id>（须精确等于「${sp.id}」）；收到 ${JSON.stringify(confirm ?? '')}`,
      }
    }
    const spacesDir = join(kroot, 'spaces')
    if (!realpathInside(spacesDir, sp.root)) {
      // 自建空间的 root 由 discoverSpaces 定为 `<kroot>/spaces/<id>`；不在此内的（如知识包
      // 包装到本地、或手工改过配置的）一律拒删 —— 只删自己造的那棵目录。
      return { ok: false, error: 'protected-space', message: `delete-space: ${sp.id} 的目录不在 knowledge/spaces/ 下，拒绝删除` }
    }
    const r = stash({ kind: 'space', spaceId: sp.id, spaceName: sp.name, relPath: null, absPath: sp.root, name: sp.name })
    return { ok: true, kind: 'space', spaceId: sp.id, name: sp.name, ...r, indexSync: 'reloaded' }
  }

  /** 回收站清单（GUI「最近删除」用）。 */
  function listTrash() {
    const index = readTrashIndex(trashDir)
    const items = index.items
      .filter((it) => isTrashId(it.trashId))
      .map((it) => ({
        trashId: it.trashId,
        kind: it.kind === 'space' ? 'space' : 'doc',
        spaceId: it.spaceId ?? null,
        spaceName: it.spaceName || it.spaceId || null,
        relPath: it.relPath ?? null,
        name: it.name || null,
        deletedAt: it.deletedAt ?? null,
        bytes: Number(it.bytes) || 0,
        fileCount: Number(it.fileCount) || (Array.isArray(it.files) ? it.files.length : 0),
        // 内容是否还在（用户可能手工清过磁盘）→ GUI 据此把"还原"置灰、只留"彻底删除"
        available: existsSync(join(trashDir, it.trashId, 'payload')),
        // 进回收站的**原因**（2026-09-14 批次 4）：`'delete'`（用户删除，含旧数据的不填）
        // 与 `'overwrite'`（覆盖前自动备份）。必须透出去 —— 否则用户会看到自己没删过的东西
        // 出现在回收站里，合理地怀疑"系统乱删我的文件"。
        reason: it.reason === 'overwrite' ? 'overwrite' : 'delete',
        // 搬运方式（rename / cp+rm / copy）：排查"备份是否真落盘"时的第一手信息
        via: it.via ?? null,
      }))
    // 无台账的散落子目录只报数、不列出：列出来却删不掉（形状未过白名单）比不列更糟。
    let stray = 0
    try {
      const known = new Set(items.map((it) => it.trashId))
      for (const name of readdirSync(trashDir)) {
        if (name === 'index.json' || name.endsWith('.tmp') || known.has(name)) continue
        try { if (statSync(join(trashDir, name)).isDirectory()) stray += 1 } catch { /* ignore */ }
      }
    } catch { /* 回收站不存在 = 空 */ }
    return {
      dir: trashDir,
      count: items.length,
      bytes: items.reduce((s, it) => s + it.bytes, 0),
      stray,
      items,
    }
  }

  /** 还原（条目回原空间原路径；整库回 `spaces/<id>`）。遇同名**一律让位、绝不覆盖**。 */
  function restore({ trashId }) {
    const id = String(trashId ?? '').trim()
    if (!isTrashId(id)) {
      return { ok: false, error: 'bad-trash-id', message: `restore: 非法 trashId（收到 ${JSON.stringify(trashId)}）` }
    }
    const index = readTrashIndex(trashDir)
    const item = index.items.find((it) => it.trashId === id)
    if (!item) return { ok: false, error: 'unknown-trash-id', message: `restore: 回收站里没有 ${id}` }
    const payload = join(trashDir, id, 'payload')
    if (!existsSync(payload)) {
      return { ok: false, error: 'payload-missing', message: `restore: ${id} 的内容已不在磁盘上（只能彻底删除该记录）` }
    }
    const dropEntry = () => {
      index.items = index.items.filter((it) => it.trashId !== id)
      writeTrashIndex(trashDir, index)
      // 条目目录随台账一起清掉（注意：这里删的是**回收站内已被搬空**的壳目录）
      purgeTrashEntryDir(id)
    }
    if (item.kind === 'space') {
      const wanted = String(item.spaceId ?? '').trim()
      if (!wanted) return { ok: false, error: 'bad-record', message: `restore: ${id} 台账缺少 spaceId` }
      let target = join(kroot, 'spaces', wanted)
      let spaceId = wanted
      if (existsSync(target)) {
        // 同名库已存在 → 改名让位（`x` → `x-2`），不覆盖用户的现库。
        let found = null
        for (let i = 2; i < 1000; i++) {
          const cand = `${wanted}-${i}`
          if (!existsSync(join(kroot, 'spaces', cand))) { found = cand; break }
        }
        if (!found) return { ok: false, error: 'name-exhausted', message: `restore: ${wanted} 同名空间过多，无法让位命名` }
        spaceId = found
        target = join(kroot, 'spaces', spaceId)
      }
      movePath(payload, target)
      dropEntry()
      refreshAfterMutation()
      return { ok: true, kind: 'space', spaceId, renamed: spaceId !== wanted, indexSync: 'reloaded' }
    }
    // 条目：回原空间原路径。空间可能已被删/改名 → 明确拒绝而不是往幽灵目录里还原。
    const rel = normalizeMdRel(item.relPath)
    if (!rel) return { ok: false, error: 'bad-record', message: `restore: ${id} 台账的 relPath 非法` }
    const sp = spaces.find((s) => s.id === item.spaceId)
    if (!sp) {
      return {
        ok: false, error: 'unknown-space',
        message: `restore: 原空间 ${item.spaceId} 已不存在，无法还原（可先新建同名空间，或从回收站目录手工取回）`,
      }
    }
    const src = join(payload, ...rel.split('/'))
    if (!existsSync(src)) {
      return { ok: false, error: 'payload-missing', message: `restore: ${id} 内找不到 ${rel}` }
    }
    const free = freeRel(sp.root, rel)
    if (!free) return { ok: false, error: 'name-exhausted', message: `restore: ${rel} 同名文件过多，无法让位命名` }
    movePath(src, join(sp.root, ...free.split('/')))
    dropEntry()
    refreshAfterMutation()
    return { ok: true, kind: 'doc', spaceId: sp.id, path: free, renamed: free !== rel, indexSync: 'reloaded' }
  }

  /**
   * 彻底删除（**本模块唯一的物理删除路径**）。只认回收站内的合规 trashId 目录，
   * 台账里的 trashId 先用白名单正则筛一遍 —— 即使 `index.json` 被手工塞进 `../xxx`，
   * 也到不了回收站之外的路径。
   */
  function purgeTrashEntryDir(trashId) {
    if (!isTrashId(trashId)) return false
    const abs = join(trashDir, trashId)
    const trashReal = (() => { try { return realpathSync(trashDir) } catch { return trashDir } })()
    const absReal = (() => { try { return realpathSync(abs) } catch { return abs } })()
    if (!(absReal === trashReal || absReal.startsWith(trashReal.endsWith(sep) ? trashReal : trashReal + sep))) return false
    try { rmSync(abs, { recursive: true, force: true }); return true } catch { return false }
  }

  function purge({ trashId = null, all = false } = {}) {
    const index = readTrashIndex(trashDir)
    if (all === true) {
      const items = index.items.filter((it) => isTrashId(it.trashId))
      const bytes = items.reduce((s, it) => s + (Number(it.bytes) || 0), 0)
      let purged = 0
      for (const it of items) if (purgeTrashEntryDir(it.trashId)) purged += 1
      writeTrashIndex(trashDir, { version: 1, items: [] })
      // 清的是回收站，索引视图不受影响（回收站本就不在索引里）⇒ 不重建。
      return { ok: true, purged, bytes, indexSync: 'unchanged' }
    }
    const id = String(trashId ?? '').trim()
    if (!isTrashId(id)) {
      return { ok: false, error: 'bad-trash-id', message: `purge: 非法 trashId（收到 ${JSON.stringify(trashId)}）；清空全部请用 --all` }
    }
    const item = index.items.find((it) => it.trashId === id)
    // `rm` 以台账记录为准；内容缺失（用户手工清过）也允许抹掉记录，否则会留下永远删不掉的死行。
    if (!item && !existsSync(join(trashDir, id))) {
      return { ok: false, error: 'unknown-trash-id', message: `purge: 回收站里没有 ${id}` }
    }
    const bytes = Number(item?.bytes) || 0
    const removed = purgeTrashEntryDir(id)
    index.items = index.items.filter((it) => it.trashId !== id)
    writeTrashIndex(trashDir, index)
    return { ok: true, purged: removed ? 1 : 0, bytes, indexSync: 'unchanged' }
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
    /** 一篇文档内所有条目块的锚点（S5 Task 9 GUI 专用批量口；见 getRelatedForDoc 的 why） */
    getRelatedForDoc,
    updateDoc, getDoc, listEntries, listTree, getLinks, getGraph,
    // 删除管理（回收站，2026-09-14）：CLI/路由/agent 工具的**唯一**入口面。
    // 四个写方法都只做"搬文件 + 记台账"，物理删除仅存在于 purge 一支。
    deleteDoc, deleteSpace, listTrash, restore, purge, stashDoc,
    /** 删除权限查询（GUI 用它决定要不要画删除按钮，避免"点了才报错"）。 */
    canDelete({ space, whole = false } = {}) {
      const g = deleteGate(space, { whole })
      return g.ok ? { ok: true } : { ok: false, error: g.error, message: g.message }
    },
    getDocs() { return docs },
    /**
     * 索引标签枚举（2026-09-14 对标 Obsidian 批次 1）。纯读、无副作用。
     *
     * 为什么不复用 `listMemoryTags`（S6 的 tags op）：那个只认**经验库**（memory/personal），
     * 且条目级；本口要的是**全库文档标签**（含用户空间与只读 packs），是标签视图的数据源。
     *
     * 为什么不读索引里的 `tags.json`：`loadIndexFromDisk` 不回填该文件（只有 buildIndex 路径
     * 会写它），读它会让"冷启动（load）"与"刚建完索引"两条路径给出不同结果——同一库同一问
     * 两个答案是最难查的一类 bug。直接遍历 `docs[i].tags`（内存里恒为当前视图）。
     *
     * 返回形状与 listMemoryTags 保持一致（tags/total/singleCount），GUI 与 agent 侧可用同一套
     * 渲染与判断；`single` 标记"只被一篇文档用到的标签"——它是标签体系腐烂的第一信号
     * （S5.1 实测：单例标签越积越多 → 条目孤立），所以显式给出，别让调用方自己数。
     */
    listIndexTags({ spaces: only = null, tagResolver = null } = {}) {
      const allow = Array.isArray(only) && only.length ? new Set(only) : null
      const byTag = new Map()
      for (const d of docs) {
        if (allow && !allow.has(d.spaceId)) continue
        for (const raw of d.tags || []) {
          // 【S2-D6 标签实体化】先把裸字符串按"标签注册表"解析成规范名再计数：被合并掉的写法
          // （别名）会折叠到同一实体上，于是"财务 / 财务部"合并后**只剩一行计数**，而不是看起来
          // 仍有两个标签。`tagResolver` 缺省 null ⇒ 与今日行为**逐字一致**（零回归）；
          // 未注册标签原样通过（§6.2 D6 明示不做强制受控词表）。
          // 为什么在**读取聚合面**解析而不改写 `doc.tags`：改索引内容就必须 bump INDEX_VERSION
          // ⇒ 强制全库重建 + 把用户文件里的标签悄悄改写（不可逆）。读取面解析零重建、零改写。
          const t = (tagResolver ? tagResolver(raw) : null) || raw
          const cur = byTag.get(t)
          if (cur) { cur.count += 1; if (cur.spaceId !== d.spaceId) cur.spaceId = null }
          else byTag.set(t, { tag: t, count: 1, spaceId: d.spaceId })
        }
      }
      const tags = [...byTag.values()]
        .map((x) => ({ ...x, single: x.count === 1 }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      return {
        tags,
        total: tags.length,
        singleCount: tags.filter((x) => x.single).length,
        // 生效的空间白名单（null = 全部空间）。回给调用方是为了让"过滤后为空"能被区分成
        // "该空间确实没有标签"而不是"空间名拼错了"——后者需要在 UI 上明说。
        spaces: allow ? [...allow] : null,
      }
    },
    // 引用体系（2026-09-14 批次 2）：未链接提及 与 断链清单。
    // 两者实现是同作用域的普通函数声明（闭包内），这里显式挂到返回对象上才对外可见——
    // 与 getLinks/getGraph 一致的口径。**挂漏了不会报错**，只会在 CLI/HTTP 调用时抛
    // "store.listMentions is not a function"，所以新增能力时这一行不能忘。
    listMentions,
    listBrokenLinks,
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
      const rc = { edges: 0, tagEdges: 0, contentEdges: 0, refEdges: 0, dupEdges: 0 }
      for (const r of relEdges) {
        rc.edges += 1
        const k = r?.why?.kind
        if (k === 'tag') rc.tagEdges += 1
        else if (k === 'content') rc.contentEdges += 1
        else if (k === 'ref') rc.refEdges += 1
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
        // S6：块上限护栏的留痕。`docs > 0` 表示**有文档的尾部块没进索引**（文件里仍在，
        // 但检索/关联/图谱都看不到）—— 这是必须被看见的信号，不是内部细节。
        blocksTruncated: { docs: blockCaps.docs, droppedBlocks: blockCaps.droppedBlocks, docIds: [...blockCaps.docIds] },
        // 文件数上限留痕（批次 4）：`truncated: true` = 该空间还有文档**没进索引**
        // （超过 FILE_LIMIT_PER_SPACE）。旧实现静默停手，用户只看到"索引成功"。
        filesTruncated: lastTruncation
          ? {
            truncated: lastTruncation.truncated === true,
            limit: lastTruncation.limit ?? FILE_LIMIT_PER_SPACE,
            spaces: lastTruncation.spaces ?? [],
            staleSweepSkipped: lastTruncation.staleSweepSkipped === true,
          }
          : { truncated: false, limit: FILE_LIMIT_PER_SPACE, spaces: [], staleSweepSkipped: false },
      }
    },
  }
}
