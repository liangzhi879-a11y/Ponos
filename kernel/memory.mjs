// kernel/memory.mjs —— 跨会话记忆内核化（L3-1/L3-2）
// 与 GUI 层 server/experience.mjs 同一数据源/格式/去重算法：
//   <configDir>/memory/personal/{theme}.md，条目 `- [会话|标签] 摘要 -- 全文`
// hashLine / parseEntryLine / keywordScore 的权威实现在 shared/knowledge-core.mjs
// （2026-09-13 S1 Task 4 去重），本模块 re-export 保持既有导入点可用。
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
import { hashLine, parseEntryLine, keywordScore, toDocId, relationContent, MIN_LEN, ENTRY_LINE_RE } from '../shared/knowledge-core.mjs'
import { buildRelevantBlock, normalizeKeywords, resolveBudget } from './memory-rank.mjs'
import { withAttribution } from '../shared/attribution.mjs'

export { hashLine, parseEntryLine, keywordScore }

export function memoryRoot(configDir) {
  return join(configDir || '', 'memory', 'personal')
}

// 本模块保留自己的 parseFrontmatter（返回形状与 shared 版不同——不要 bodyStartLine），
// 语义与 shared 版一致（同一正则），有意不复用：改它会牵动 readTheme 的返回形状。
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { front: {}, body: raw }
  const front = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) front[kv[1]] = kv[2]
  }
  return { front, body: raw.slice(m[0].length) }
}

function themePath(root, theme) {
  return join(root, `${theme}.md`)
}

/**
 * 经验注入的唯一字节口径（S4.5③：字符→字节换算只在此处）。
 * 用 UTF-8 字节而非 String.length —— 后者对中文系统性低估 ~2 倍
 * （实测同一份"中文主题"输出：.length=225 / Buffer.byteLength=475）。
 * 唯一性纪律：S1+（Task 2 buildSegmentMeters）只接收已算好的字节数，
 * 不在此做换算；本函数是经验侧**唯一**的换算入口。
 */
export function memoryBytes(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}

/** 记忆根下的主题文件清单（**唯一**遍历入口：buildMemoryIndex / buildRelevantMemory 共用）。 */
function listThemeFiles(root) {
  return readdirSync(root).filter((x) => x.endsWith('.md'))
}

function readTheme(root, theme) {
  const fp = themePath(root, theme)
  if (!existsSync(fp)) return { front: {}, entries: [] }
  const raw = readFileSync(fp, 'utf-8')
  const { front, body } = parseFrontmatter(raw)
  // 条目判定必须与**读侧真源** `parseEntryLine` 同口径（`ENTRY_LINE_RE` = `^- \[...\]`）。
  // 曾经用 `l.trim().startsWith('- ')`：会把**条目正文里的子项目符号**（续行，例如
  // `- 问题 "…": 选择了 "…"`）也算成独立条目 ⇒ 实测 workflow 索引虚高 18 条（765 vs 真实 747），
  // 且这些无结构片段会被 buildRelevantMemory 当"经验"注入（与其 header 声明的格式不符）。
  const entries = body.split(/\r?\n/).filter((l) => ENTRY_LINE_RE.test(l.trim())).map((l) => {
    const text = l.trim()
    return { text, hash: hashLine(text), ...parseEntryLine(text) }
  })
  return { front, entries }
}

export function readMemoryEntries({ root = '', theme = '' } = {}) {
  if (!root || !theme) return []
  return readTheme(root, theme).entries
}

/**
 * 把一次 markdown 写入同步进知识索引（S3 §5 写入闭环）。
 * 增量优先：`updateDoc` 只重切该文档 + 摘插它的 postings（S1 已实现，成本 ∝ 单文档）；
 * 文档**不在索引里**时（首次沉淀的新主题、会话记忆新文件）回落一次 `load({})`——由
 * staleness 自己发现新文件并重建。缺了这步回落就会出现"刚记下就查不到"（GUI 侧的真实隐患）。
 * 全程吞异常：索引是派生物，它坏了不该让**权威写入**（markdown）看起来失败。
 * @returns {{updated:boolean, reason?:string, reloaded?:boolean}} 诊断用，调用方无需处理
 */
export function syncKnowledgeIndex(knowledgeIndex, docId) {
  if (!knowledgeIndex || !docId) return { updated: false, reason: 'no-index' }
  try {
    const r = knowledgeIndex.updateDoc(docId)
    if (r?.updated) return r
    knowledgeIndex.load({})
    return { updated: false, reason: r?.reason || 'not-found', reloaded: true }
  } catch (e) {
    return { updated: false, reason: e?.message || String(e) }
  }
}

export function appendMemoryEntry({ root = '', theme = '', tag = null, summary = '', full = '', graphStore = null, knowledgeIndex = null } = {}) {
  if (!root || !theme || !summary) return { ok: false, error: 'root/theme/summary required' }
  try { mkdirSync(root, { recursive: true }) } catch {}
  const { front, entries } = readTheme(root, theme)
  const line = `- [会话${tag ? '|' + tag : ''}] ${summary} -- ${full}`
  if (entries.some((e) => e.hash === hashLine(line))) return { ok: true, deduped: true }
  // 【S2-D4 归属字段落盘】归属落在**文件 frontmatter**（本文件已用 frontmatter 承载
  // name/description/active，`parseFrontmatter` 的键名正则天然容纳 camelCase，读取侧零改动）。
  // 为什么不塞进条目行的 `[会话|标签]` 槽位（spec §6.2 D4 称该槽位为"作者位"）：那是模型可见/
  // 人可见的格式，且既有哈希去重（hashLine 按行文本比较）与经验库文档都依赖它；混入机器字段会造成
  // "旧条目旧格式、新条目新格式"的混合态，同一条内容换个写法即被视为两条，并污染注入模型的提示。
  // L1 单作者下主题级与条目级归属等价。用 withAttribution 做**幂等**补充：已有值不被覆盖。
  const baseFront = Object.keys(front).length
    ? front
    : { name: theme, description: theme, active: true }
  const head = Object.entries(withAttribution(baseFront)).map(([k, v]) => `${k}: ${v}`).join('\n')
  const body = entries.map((e) => e.text).concat(line)
  // ★★ 2026-10-18 CONC-01 修复：**原子写**（tmp + fsync + rename）。
  //   原为裸 writeFileSync 就地覆盖：经验库是用户**不可重建**的资产，写到一半被强杀/断电
  //   （或磁盘满）会留下半截 markdown；而读侧（readTheme）对畸形行是**宽容跳过**的，
  //   于是"截断"被读成"少了几条"，下一次 append 再整篇重写 ⇒ 残存内容被永久抹掉。
  //   原子写把"替换内容"变成目录项替换：读者要么看到完整旧内容、要么看到完整新内容。
  writeFileAtomicSync(themePath(root, theme), `---\n${head}\n---\n` + body.join('\n') + '\n')
  // 神经图谱：markdown 权威写入成功后同步派生索引（graphStore 内部去重）
  if (graphStore) graphStore.append({ theme, tag, summary, full })
  // 知识索引增量更新（S3 §5）：同一会话的下一轮即可检索到刚沉淀的内容，不再等下次启动重建。
  // docId 固定为 `experience/<theme>.md`：本函数的 root 恒等于 experience 空间根
  // （kernel/cli.mjs 传 memoryRoot(configDir)），与 kernel/knowledge.mjs 的
  // toDocId(space.id, relPath) 同构。**传了才做**——不传时行为与改动前逐字节一致。
  if (knowledgeIndex) syncKnowledgeIndex(knowledgeIndex, toDocId('experience', `${theme}.md`))
  return { ok: true, deduped: false }
}

/** EL0 目标字节（注入 spec §4.2 :416：7 主题 ≈200 B。纯清单实测 254 B；含串头 368 B） */
export const EL0_TARGET_BYTES = 200
/** EL0 硬上限（A14：**恒在**的 EL0 ≤ 512 B） */
export const EL0_MAX_BYTES = 512

/**
 * EL0 串头。**必须含`【个人经验索引】`** —— kernel-tests/knowledge-inject-e2e.test.mjs 的 NEEDLES
 * 用它判定"经验层确实进了 system"，改文案前先看那个测试。
 *
 * 为何一定要有串头（不是可省的装饰）：改前串头告诉模型"用 Read 读取该行末尾标注的文件"——
 * EL0 把**路径裁掉了**，那条指引不再可行；必须换成"用 KnowledgeSearch 检索该主题"的指引，
 * 否则模型看到一堆裸主题列表不知道如何取详情（S4.5 的分层路由就断在这一句上）。
 */
const EL0_HEADER = '\n\n【个人经验索引】按主题汇总的过往经验（需要具体经验时用 KnowledgeSearch 检索对应主题）：\n'

/**
 * EL0 渲染：主题清单 `- [主题] N 条 · 最近日期`。
 * lean 档 = 去掉"最近日期"，**保留全部主题名与条数**（只裁条目级细节，spec :475）。
 */
export function renderThemeList(themes, { lean = false } = {}) {
  return (themes || [])
    .map((t) => {
      const suffix = !lean && t.latest ? ` · ${t.latest}` : ''
      return `- [${t.theme}] ${t.count} 条${suffix}`
    })
    .join('\n')
}

/**
 * EL0：经验**主题清单**（常驻 ~368 B）。
 *
 * 改前：条目式索引 —— 真实库 42 行 / 5131 B，本质是 L2 内容被当 L0 恒在塞进**每一轮**
 * system（注入 spec :57 的原话诊断）。改后：每主题一行，只留主题名 + 条数 + 最近日期。
 * 逐项核算（spec §4.2 :416）：5131 → 254 = **−4877 B/轮**（含串头 368 ⇒ −4763）。
 * 归通道①②（system 静态）。
 *
 * 有意取舍（**不是漏洞，是 spec :475 的要求**）：
 *   · 保留**全部**主题名 + 条数 —— 不得只留"最近 N 个"（那会让模型不知道还有哪些主题）。
 *   · 因此当主题数很多（~15 个以上）时，lean 之后**不再截断**，输出可能 > EL0_MAX_BYTES。
 *     真实库 7 主题 ⇒ 368 B，A14（≤512）成立；边界已被
 *     kernel-tests/experience-dedup.test.mjs 锁成事实（改截断即红 ⇒ 提醒那是 spec 变更）。
 *   · 0 条的主题**仍然列出**：模型据此区分"该主题存在但还没沉淀"与"库没有这个主题"。
 *   · 空库 / 无 root ⇒ 空串（调用方据此判"无注入"）。
 */
export function buildMemoryIndex({ root = '', maxBytes = EL0_MAX_BYTES } = {}) {
  if (!root || !existsSync(root)) return ''
  const themes = []
  try {
    for (const f of listThemeFiles(root)) {
      const theme = f.slice(0, -3)
      const { front, entries } = readTheme(root, theme)
      // A16：内核注入侧尊重 front.active（服务端 server/experience.mjs:101 早用此口径，
      // String(active)==='false' 才算停用；缺省视为启用）
      if (String(front?.active) === 'false') continue
      // 最近日期取**文件 mtime**：实测条目行无 date 字段（shared/knowledge-core.mjs#parseEntryLine
      // 只返回 tag/summary/full），frontmatter 也只有 name/description/active/归属字段
      // ⇒ mtime 是唯一可得且如实的时间源（不臆造日期）。
      const mtimeMs = statSync(themePath(root, theme)).mtimeMs
      themes.push({ theme, count: entries.length, latest: new Date(mtimeMs).toISOString().slice(0, 10), mtimeMs })
    }
  } catch { return '' }
  if (!themes.length) return ''
  themes.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const full = EL0_HEADER + renderThemeList(themes)
  if (memoryBytes(full) <= maxBytes) return full
  // 二级降级：只去"最近日期"（串头与主题名/条数一个都不丢）
  return EL0_HEADER + renderThemeList(themes, { lean: true })
}

// 关键词触发抽调（M4）：按当前任务上下文关键词，从经验库匹配高相关条目并注入
// 全文（区别于 buildMemoryIndex 的索引指针——模型无需先 Read 即可直接用）。
// 匹配维度：主题名 / 任务标签 / 摘要 / 全文。得分：标签命中 3 > 主题 2 > 摘要 2 > 全文 1。
// 输出格式与【个人经验索引】一致的行内条目（-[主题|标签] 摘要 -- 全文），便于模型
// 直接引用；超限时按相关度丢弃低分条目（同分按最近更新优先）。
export function buildRelevantMemory({ root = '', keywords = [], maxChars = null, maxBytes = null, query = '', topK = 0 } = {}) {
  if (!root || !existsSync(root) || !keywords || !keywords.length) return ''
  const kws = normalizeKeywords(keywords)
  if (!kws.length) return ''
  // ★★ 2026-09-30 统一（本文件头「经验条目级召回」的 A 路）：评分/排序/渲染/预算口径
  //   全部改由 `memory-rank.mjs`（唯一真源）提供，与 `graph.mjs#search`（B 路）**完全同质**。
  //   改动前的本函数：仅关键词打分、预算按 UTF-8 字节、直接吐原始行 `it.text`。
  //   实测缺陷：中文条目 665 字 ≈ 1995 字节，2048 字节预算下**一条都塞不下** ⇒ 经常整体返回空
  //   （`['无限重渲染','回测'] → 0 条`，而单关键词 → 1 条）。
  //   现改为：`0.7×向量 + 0.3×关键词`（无 idf 时自动退化为关键词）、预算按**字符**、
  //   输出**重拼**的标准行（不再依赖历史遗留的行文本）。
  const items = []
  try {
    for (const f of listThemeFiles(root)) {
      const theme = f.slice(0, -3)
      const { front, entries } = readTheme(root, theme)
      // A16：内核注入侧尊重 front.active（服务端 server/experience.mjs:101 早用此口径，
      // String(active)==='false' 才算停用；缺省视为启用）
      if (String(front?.active) === 'false') continue
      for (const e of entries) items.push({ theme, tag: e.tag, summary: e.summary, full: e.full, text: e.text })
    }
  } catch { return '' }
  // 预算单位：字符。`maxChars` 优先；只给旧参数 `maxBytes` 时**按同数值当字符**用
  //   （兼容路径：数值不变但单位从严的字节改为字符 ⇒ 中文场景放宽约 3 倍，正是修掉"一条都塞不下"）。
  // 预算解析走 memory-rank 的**唯一口径**（`Number(null)===0` 陷阱的教训见该函数注释：
  // 我自己写的 `Number.isFinite(Number(maxChars))` 把"未传"当成 0，导致两条路同时返回空）。
  const budget = resolveBudget({ maxChars, maxBytes })
  return buildRelevantBlock(items, {
    query: String(query || '').trim() || kws.join(' '),
    keywords: kws,
    maxChars: budget,
    topK,                       // 0 = 不限（原语义）；>0 时封顶（与 graph 路径同一入口参数）
  })
}

const DEFAULT_MARKERS = {
  correction: ['以后不要', '不要再', '以后别', '别用', '记住不要'],
  preference: ['我喜欢', '我希望', '我习惯', '以后都', '记得以后'],
  fact: ['记住', '请注意', '特别注意', '关键点是', '必须用', '必须走', '只能用', '统一用'],
  // workflow 原为 ['流程是','步骤是','**先**','**再**','**最后**','标准做法','推荐做法']。
  // S5.1 **删掉三个单字弱信号**（先/再/最后）：它们是全库最高频汉字，配合下方的
  // "长度 > 30" 门槛（几乎任何用户消息都满足）⇒ **任何较长消息都被当成"流程经验"入库**。
  //
  // 真实库实测（`.superpowers/.../calib-capture-precision.mjs`，81 条条目）：
  //   · capture 自动产出 18 条，其中 **17 条是垃圾**（16 条「流程要点」+ 1 条「业务要点」）
  //   · 16 条「流程要点」里**含强信号词的 = 0 条** —— 全是弱信号误触发的对话原文
  //     （"不太符合我的要求，我想的是扁平科技风…"）、协议块（"执行技能 using-superpowers…"）、
  //     空模板（"用户回答："）
  //   · 而 agent **主动沉淀**的 63 条全部有 tag、零协议文本 ⇒ 弱信号分支净贡献为零、纯噪声
  // 故只保留**明确声明式**的强信号词：用户写明"流程是…/步骤是…"才算流程经验。
  // 需要放开时仍可在配置 `memory.markers.workflow` 里自定义（本表只是默认值）。
  workflow: ['流程是', '步骤是', '标准做法', '推荐做法'],
}

// 协议／系统文本：harness 注入的块与模板框架，**不是用户表达的经验**。
// 实测形态（真实库）：`【上下文锚定 · 权威事实】`、`【用户插话——补充信息/调整要求】`、
// `执行技能 using-superpowers。首选使用 Read 工具读取 "…"`、`用户回答：`。
// 这类内容入库后必然是**无关联的孤立噪声**（真实库 21% 孤立条目里的主要来源），
// 且对检索毫无价值（谁也不会去回忆"上下文锚定"这几个字）。
//
// 判据是**起始匹配**（不是"包含即拦"），这是个**故意的取舍**：
// 真实库垃圾的 full 都以协议标记**开头**（如 `【用户插话——…】` 本身），起始判据已足够拦住它们；
// 而"含【就拦"会**错杀真经验**（用户完全可能说"先在报告里用【】标出待确认项"）。
// 漏拦一条 → 只是少拦一点噪声；错杀一条 → 用户真经验永久丢失。按不可逆性取小（同 S5 读时校验原则）。
const PROTOCOL_TEXT_RE = /^(?:【|执行技能\s|用户回答：|用户插话)/

// 确定性捕获（启发式）：轮末对 user 文本做模式匹配，产出结构化记忆候选。
// 分级：correction/preference → 高价值（theme 固定 workflow/communication）；
// fact（业务事实）/workflow（流程心得）→ 中价值，theme 由 tag 推断（含申报/
// 政策/财务关键词 → 对应业务主题，否则 workflow）。
export function captureMemoryCandidates({ userText = '', tag = null, markers = null } = {}) {
  const t = String(userText || '')
  const m = { ...DEFAULT_MARKERS, ...(markers || {}) }
  const out = []
  // 统一出口：所有候选都过两道闸（S5 Task 3 空模板闸 + S5.1 协议文本闸）。
  const push = (theme, summary, full, marker) => {
    // ① 协议／系统文本一律不捕获（harness 注入块、技能调用提示、模板框架）。
    //    查 full（正文）为主；summary 带 `流程要点：` 这类前缀，故只对无前缀的正文判起始。
    if (PROTOCOL_TEXT_RE.test(String(full ?? '').trim())) return
    // ② 空模板（S5 Task 3）：模板化条目对检索与关联都无价值，入库只会变成噪声。
    if (isEmptyTemplateContent(relationContent({ full, text: summary }), marker)) return
    out.push({ theme, tag, summary, full })
  }
  const correction = (m.correction || []).find((x) => t.includes(x))
  if (correction) push('workflow', `用户纠正（${correction}）：${t.slice(0, 60)}`, t.slice(0, 500), correction)
  const preference = (m.preference || []).find((x) => t.includes(x))
  if (preference) push('communication', `用户偏好（${preference}）：${t.slice(0, 60)}`, t.slice(0, 500), preference)
  const fact = (m.fact || []).find((x) => t.includes(x))
  if (fact) push(inferTheme(tag, t), `业务要点（${fact}）：${t.slice(0, 60)}`, t.slice(0, 500), fact)
  // 流程要点：只认**明确声明式**的强信号词（默认表已删掉单字 `先/再/最后`，见 DEFAULT_MARKERS）。
  // 原来还有一条"弱信号词 + 长度 > 30"的宽口径，真实库实测其产出 16/16 全是垃圾，已移除。
  const workflow = (m.workflow || []).find((x) => t.includes(x))
  if (workflow && !fact) {
    push('workflow', `流程要点：${t.slice(0, 60)}`, t.slice(0, 500), workflow)
  }
  return out
}

// 内容为空的模板判定（S5 Task 3，spec §9.1）。**why**：真实库实测 7 条垃圾条目
// （full 仅 10 字：`流程要点：用户回答：`、`业务要点（请注意）：`）就是上面模板的产物；
// 它们两两文本全同 → 关联层 cos=1.000，会灌入"完美相似但零信息"的边。
// 判断标准**复用 relationContent**（= stripTypePrefix(full || text)）——与索引/关联侧同一口径，
// 否则源头与下游各判一套（口径分叉正是 S1 的老问题）。
// 三条判据（去前缀后为空 / 只剩空白标点 / 内容恰是触发词本身），而**不是** MIN_LEN 阈值：
// 阈值会把「记住：导出目录必须用绝对路径」这类**真实但简短**的偏好一起丢掉（源头丢数据不可逆）；
// 较长样本的噪声由关联侧 MIN_LEN 负责过滤（spec §9.1「修源头 + 关联侧防御」两步都要）。
function isEmptyTemplateContent(content, marker) {
  const c = String(content ?? '').trim()
  // 去标点/空白后的实义字符（判据②③共用；`\p{P}` 覆盖中英文标点，含全角冒号）
  const bare = c.replace(/[\s\p{P}\p{S}]/gu, '')
  if (!c) return true // ① 去类型前缀后为空（实测形态：`流程要点：用户回答：`）
  if (!bare) return true // ② 只剩空白/标点，无实义字符
  // ④ 整段就是"短标签 + 结尾冒号"（实测形态：`流程是：`、`用户回答：`）。
  // 之前这条是靠 `stripTypePrefix` **剥到首个冒号**的副作用顺带拦住的（剥完变空 → 判据①）；
  // S5.1 把 stripTypePrefix 收窄成白名单前缀后，这个副作用消失，必须显式判。
  // 阈值 8：正常的"标签式残段"都很短；真实但简短的偏好（`记住：导出目录必须用绝对路径`）
  // 远长于此，不受影响（判据 1-3 也拦不住它，那正是设计意图——源头不丢数据）。
  if (bare.length <= 8 && /[：:]$/.test(c)) return true
  const m = String(marker ?? '').trim()
  // ③ 内容恰是触发词本身，允许带标点/空白差异（实测形态：`业务要点（请注意）：`）。
  // 用"去标点后相等"而不是字面相等：`流程是：` vs 触发词 `流程是` 只差一个冒号，
  // 字面比较会漏判（这正是上面 ④ 要补的洞的另一种形态）。
  return !!m && bare === m.replace(/[\s\p{P}\p{S}]/gu, '')
}

// 从任务标签/文本推断主题：申报/政策/财务关键词 → 业务主题；否则 workflow
//
// ⚠️ 判据必须是**词**而不是单字。原写法含裸 `账`，实测把一条讲"数据根合并前必须做去重勘察…
// 合并后要对账"的经验判成了 finance（`对账` 含 `账`）—— 误判率不高的词反而更糟：
// 它悄悄把条目塞进一个语义无关的主题文件，事后只能靠人翻。故 finance 只认
// `财务/报销/发票/税务/财税/成本/会计/记账/账单`，不再收单字。
// 另：`台账` 在多处属申报语境（研发辅助账/辅助账台账），而 project-application 的判断在最前，
// 故含"研发/申报"的台账会先被正确归到 project-application，这里无需再处理。
function inferTheme(tag, text) {
  const s = `${tag || ''} ${text}`.toLowerCase()
  if (/申报|认定|材料|知识产权|研发|高企|专精特新|小巨人|资质/.test(s)) return 'project-application'
  if (/政策|通知|公告|公示|补贴|资金/.test(s)) return 'policy'
  if (/财务|报销|发票|税务|财税|成本|会计|记账|账单/.test(s)) return 'finance'
  return 'workflow'
}

// ─────────────────────────────────────────────────────────────────────────────
// S6：agent 可直接调用的**写入校验**与**枚举**能力
//
// 背景：记忆目录只对只读工具开放（`tools.mjs:189` 给 `readFile` 传了 `allowFiles`，
// 而 `writeFile`/`editFile` 没有）——这是 2026-09-10 的**刻意决定**（不允许整体覆盖经验库）。
// 但该决定承诺的"记忆写入走 memory.mjs 工具链"一直没有 agent 入口，导致 agent 只能靠
// Bash `>>` 兜底（完全绕过边界检查），或干脆放弃（经验静默丢失）。
// 本节提供 append-only 的入口所需的两块积木：**校验** + **枚举**。
// ─────────────────────────────────────────────────────────────────────────────

/** 主题名白名单：映射为文件名 `<theme>.md`，故这条正则同时是**路径穿越防护**
 *（`../x`、`a/b`、`..`、绝对路径都因含 `.` 或 `/` 被拒）。 */
const THEME_RE = /^[a-z][a-z0-9-]{0,31}$/

/** 标签长度上限：超过它多半是把整段话误填进 tag（会破坏行格式的可读性） */
const TAG_MAX_LEN = 40

/** 收集全部已知触发词（默认表 + 用户自定义），供空模板判据③使用 */
function allMarkers(markers) {
  const m = { ...DEFAULT_MARKERS, ...(markers || {}) }
  return [...new Set(Object.values(m).flat().filter(Boolean))]
}

/**
 * 校验一条待 append 的经验（S6）。**纯函数、不落盘**——拒绝的条目一个字节都不写。
 *
 * 闸门与 `captureMemoryCandidates` 的出口闸**同一套判据**（协议文本 / 空模板），
 * 外加两条 append 特有的：
 *   · `MIN_LEN`：太短的内容入库后会被**关联侧参与集**过滤掉（`knowledge.mjs:698`），
 *     即"写进去却搜不到关联"，等于制造孤立条目 —— 在入口就拒，比事后困惑好
 *   · tag/theme 字符合法性：`]` `|` 换行会破坏 `- [主题|tag] 摘要` 的行格式，
 *     theme 则直接映射文件名（穿越防护）
 *
 * 返回 `{ ok:true, theme, tag, warnings }` 或 `{ ok:false, error, message }`。
 */
/**
 * @param {{ text?: any, tag?: any, theme?: any, markers?: any }} [opts]
 */
export function validateAppendEntry({ text, tag = null, theme = null, markers = null } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: 'empty', message: '经验正文为空' }
  if (PROTOCOL_TEXT_RE.test(body)) {
    return {
      ok: false, error: 'protocol',
      message: '协议/系统文本不是经验（harness 注入块、技能调用提示、模板框架），拒绝入库',
    }
  }
  const hit = allMarkers(markers).find((x) => body.includes(x))
  if (isEmptyTemplateContent(body, hit)) {
    return { ok: false, error: 'template', message: '空模板/残段（无实义内容），对检索与关联都无价值' }
  }
  if (body.length < MIN_LEN) {
    return {
      ok: false, error: 'too-short',
      message: `正文仅 ${body.length} 字符（< ${MIN_LEN}）：入库后会被关联侧过滤，等于制造孤立条目`,
    }
  }
  const t = tag == null ? null : String(tag).trim() || null
  if (t) {
    if (t.length > TAG_MAX_LEN) {
      return { ok: false, error: 'tag-too-long', message: `标签过长（${t.length} > ${TAG_MAX_LEN}），疑似把正文误填进 tag` }
    }
    if (/[\]|\r\n]/.test(t)) {
      return { ok: false, error: 'bad-tag', message: '标签不能包含 ] | 或换行（会破坏 "- [主题|tag] 摘要" 行格式）' }
    }
  }
  let th = theme == null ? null : String(theme).trim()
  if (th && !THEME_RE.test(th)) {
    return { ok: false, error: 'bad-theme', message: `主题名非法：${th}（只允许小写字母/数字/连字符，≤32 位；不得含路径分隔符）` }
  }
  if (!th) th = inferTheme(t, body)
  return { ok: true, theme: th, tag: t, length: body.length }
}

/**
 * 枚举全部标签（S6）：`{ tags:[{tag,count,single,theme}], total, singleCount }`。
 *
 * **为什么必需**：写入侧要"优先复用已有标签"，否则每次都造新标签 →
 * 单例标签越积越多（S5.1 实测：20 种 tag 里 16 种只出现 1 次，正是孤立条目的主源）。
 * `single:true` 即"该标签全库只出现 1 次" —— agent 写前看到它，就该考虑换个标签
 * 或接受这条经验会成为孤岛。
 */
export function listMemoryTags(configDir, { tagResolver = null } = {}) {
  const byTag = new Map()
  const themes = listMemoryThemes(memoryRoot(configDir))
  for (const theme of themes) {
    for (const e of readTheme(memoryRoot(configDir), theme).entries || []) {
      if (!e.tag) continue
      // 【S2-D6 标签实体化】同 `listIndexTags`：被合并掉的写法折叠到规范名后再计数，使"合并后
      // 标签变少"真的体现出来。`tagResolver` 缺省 null ⇒ 与今日逐字一致（零回归）；
      // 经验条目行本身（`- [主题|tag] …`）**一个字节都不动**（不改写用户数据）。
      const tag = (tagResolver ? tagResolver(e.tag) : null) || e.tag
      const cur = byTag.get(tag)
      if (cur) cur.count += 1
      else byTag.set(tag, { tag, count: 1, theme })
    }
  }
  const tags = [...byTag.values()]
    .map((x) => ({ ...x, single: x.count === 1 }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  return {
    tags,
    total: tags.length,
    singleCount: tags.filter((x) => x.single).length,
  }
}

/**
 * 列出存在的主题文件（去掉 `.md`）。`dir` = **经验目录本身**（`memoryRoot(configDir)`）。
 * `README` 不算主题（它是索引说明，不是经验载体）。
 */
export function listMemoryThemes(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .filter((t) => THEME_RE.test(t))
      .sort()
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 经验沉淀指引（P2 待办 714：固化到 agentloop，单独跑内核也能保证运行）
//
// 为什么真源必须在内核里：原先这段指引**只存在于宿主**（server/experience.mjs），
// 单独跑 kernel/cli.mjs 时没有任何东西告诉 agent 去沉淀 ⇒ 沉淀量近零（只剩启发式捕获，
// 而它只认显式声明式强信号词）。把文本放内核 + 内核自己会注入，独立运行才真正可用。
//
// 为什么用 `--knowledge append` 而不是 Write/Edit：S6 既定设计
// （docs/superpowers/specs/2026-09-14-knowledge-write-channel-design.md §6「变更 D」）。
// 原文本要求 agent「用 Write/Edit 把经验写入 memory/personal」，但内核的写边界**刻意**不含
// 记忆根（kernel/tools.mjs 的四条理由：知识库只读、防整体覆盖）⇒ 那条指令**必然被拒**，
// 是条死指令（照着做 = 一次注定失败的 Write）。S6 的选择是改指令、不解锁写白名单
// —— append 从结构上就满足「不允许整体覆盖经验库」的原防护意图。
// ─────────────────────────────────────────────────────────────────────────────

/** 沉淀指引的**稳定标记**：内核据此判断「宿主已经注入过」，避免同一段话出现两次。 */
export const SEDIMENT_MARKER = '【经验沉淀（静默，不询问用户）】'

/** 主题词表（与 server/experience.mjs 的既有词表同源；库里取不到主题时的回落清单）。 */
export const SEDIMENT_THEMES = [
  'communication', 'code-style', 'workflow', 'finance', 'policy', 'project-application', 'office-docs',
]

/**
 * 经验写入命令（供指引正文引用）。
 * @param {string} [kernelCliPath] 宿主可传入**它实际启动的那个**内核入口（打包态可能在 kernel-dist/），
 *   不传则用本模块自身所在的内核目录（独立运行时的正确值）。
 */
export function sedimentAppendCommand(kernelCliPath) {
  const cli = kernelCliPath || join(fileURLToPath(new URL('.', import.meta.url)), 'cli.mjs')
  // 正斜杠 + 引号：Bash 工具下 Windows 反斜杠会被当转义（`\U` 之类），路径也可能含空格
  return `node "${String(cli).replace(/\\/g, '/')}" --knowledge append --theme <主题> --tag "<任务标签>" --text "<摘要> -- <全文>"`
}

/**
 * 组装沉淀指引文本（宿主与内核**共用这一份**，杜绝两处漂移）。
 * @param {object} [opts]
 * @param {string[]} [opts.themes] 库里已有的主题名（取不到时回落 SEDIMENT_THEMES）
 * @param {string} [opts.appendCmd] 写入命令（默认 sedimentAppendCommand()）
 */
export function buildSedimentInstruction({ themes = [], appendCmd = '' } = {}) {
  const list = (themes && themes.length ? themes : SEDIMENT_THEMES).join('、')
  const cmd = appendCmd || sedimentAppendCommand()
  return [
    '',
    `${SEDIMENT_MARKER}当本次会话中出现以下情况时，用 Bash 执行下面的命令把经验追加到经验库：`,
    '① 用户明确表达偏好（回复风格、汇报粒度、代码风格、工具选择）',
    '② 业务事实（财务处理、政策解读、申报口径、项目要求等确定信息）',
    '③ 问题-解决模式（本次解决的关键问题及其方案、预防建议）',
    '④ 工作流心得（被验证有效的处理流程与验证习惯）',
    '',
    cmd,
    '',
    `--theme 从这些主题里选最贴合的：${list}（填错会被拒绝；拿不准就省略，由库按标签与内容归类）。`,
    '--tag 填本次会话正在做的具体任务（如"成果转化材料"、"PS材料"、"RD立项报告"）；同一类任务复用同一标签便于按任务检索；无明确任务可省略。',
    '--text 的格式固定为：<摘要> -- <全文>（**两个短横线**分隔，注意 --text 的值要整体用引号包住）。',
    '摘要 = 一句话要点（首次阅读即判断相关性）；全文 = 完整经验（背景/关键步骤/坑与预防/验证方式）。摘要与全文都必须写，严禁只写摘要不写全文。',
    '',
    '追加本身按内容幂等（相同内容不会重复入库），无需先读文件；一条经验一次命令，不要批量拼在一起。',
    '严禁写入密钥、密码、API token、身份证号、银行账号等敏感信息。',
    '',
    '★ 不要用 Write/Edit 去改经验库文件：记忆目录对写入工具是只读的（防整体覆盖），只有上面的 append 命令能写。',
    '',
  ].join('\n')
}

/** 确保经验目录存在（返回目录路径）。
 *  为什么需要：`--knowledge append` 在「根目录原本不存在」时会被入口短路（防呆，避免误建目录）
 *  ⇒ 独立跑内核时若从不创建该目录，指引里的命令会永远失败（又变成一条死指令）。
 *  故内核在决定注入指引时**顺手把目录建好**，让指引自洽可执行。 */
export function ensureMemoryRoot(configDir) {
  const root = memoryRoot(configDir)
  try {
    mkdirSync(root, { recursive: true })
  } catch {
    /* 建不出来（权限/只读盘）不致命：指引仍会给出，只是 append 会失败并如实报错 */
  }
  return root
}
