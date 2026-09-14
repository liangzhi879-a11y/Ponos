// kernel/memory.mjs —— 跨会话记忆内核化（L3-1/L3-2）
// 与 GUI 层 server/experience.mjs 同一数据源/格式/去重算法：
//   <configDir>/memory/personal/{theme}.md，条目 `- [会话|标签] 摘要 -- 全文`
// hashLine / parseEntryLine / keywordScore 的权威实现在 shared/knowledge-core.mjs
// （2026-09-13 S1 Task 4 去重），本模块 re-export 保持既有导入点可用。
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hashLine, parseEntryLine, keywordScore, toDocId, relationContent } from '../shared/knowledge-core.mjs'

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

function readTheme(root, theme) {
  const fp = themePath(root, theme)
  if (!existsSync(fp)) return { front: {}, entries: [] }
  const raw = readFileSync(fp, 'utf-8')
  const { front, body } = parseFrontmatter(raw)
  const entries = body.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).map((l) => {
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
  const head = Object.keys(front).length
    ? Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n')
    : `name: ${theme}\ndescription: ${theme}\nactive: true`
  const body = entries.map((e) => e.text).concat(line)
  writeFileSync(themePath(root, theme), `---\n${head}\n---\n` + body.join('\n') + '\n', 'utf-8')
  // 神经图谱：markdown 权威写入成功后同步派生索引（graphStore 内部去重）
  if (graphStore) graphStore.append({ theme, tag, summary, full })
  // 知识索引增量更新（S3 §5）：同一会话的下一轮即可检索到刚沉淀的内容，不再等下次启动重建。
  // docId 固定为 `experience/<theme>.md`：本函数的 root 恒等于 experience 空间根
  // （kernel/cli.mjs 传 memoryRoot(configDir)），与 kernel/knowledge.mjs 的
  // toDocId(space.id, relPath) 同构。**传了才做**——不传时行为与改动前逐字节一致。
  if (knowledgeIndex) syncKnowledgeIndex(knowledgeIndex, toDocId('experience', `${theme}.md`))
  return { ok: true, deduped: false }
}

export function buildMemoryIndex({ root = '', maxBytes = 4096 } = {}) {
  if (!root || !existsSync(root)) return ''
  const list = []
  try {
    for (const f of readdirSync(root).filter((x) => x.endsWith('.md'))) {
      const theme = f.slice(0, -3)
      const { entries } = readTheme(root, theme)
      if (!entries.length) continue
      const groups = new Map()
      let untagged = 0
      for (const e of entries) {
        if (!e.tag) { untagged++; continue }
        const g = groups.get(e.tag) || { tag: e.tag, count: 0 }
        g.count++
        groups.set(e.tag, g)
      }
      list.push({ theme, file: join(root, f), updatedAt: statSync(join(root, f)).mtimeMs, groups: [...groups.values()], untagged })
    }
  } catch { return '' }
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  const header = '\n\n【个人经验索引】过往会话沉淀的个人经验（按 主题|任务标签 分组，含未标注条目）。需要某任务的具体经验时，用 Read 读取该行末尾标注的文件（每行条目格式：- [会话|标签] 摘要 -- 全文），摘要判断相关性，全文含完整要点；与当前任务无关的标签无需读取。\n'
  let out = header
  const fmt = (ts) => new Date(ts).toISOString().slice(0, 10)
  const lines = []
  for (const item of list) {
    for (const g of item.groups) lines.push(`- [${item.theme}|${g.tag}] ${g.count} 条 · 最近 ${fmt(item.updatedAt)} · ${item.file}`)
    if (item.untagged > 0) lines.push(`- [${item.theme}] ${item.untagged} 条未标注经验 · 最近 ${fmt(item.updatedAt)} · ${item.file}`)
  }
  for (const line of lines) {
    const lb = line.length + 1
    if (out.length + lb > maxBytes) break
    out += line + '\n'
  }
  return out
}

// 关键词触发抽调（M4）：按当前任务上下文关键词，从经验库匹配高相关条目并注入
// 全文（区别于 buildMemoryIndex 的索引指针——模型无需先 Read 即可直接用）。
// 匹配维度：主题名 / 任务标签 / 摘要 / 全文。得分：标签命中 3 > 主题 2 > 摘要 2 > 全文 1。
// 输出格式与【个人经验索引】一致的行内条目（-[主题|标签] 摘要 -- 全文），便于模型
// 直接引用；超限时按相关度丢弃低分条目（同分按最近更新优先）。
export function buildRelevantMemory({ root = '', keywords = [], maxBytes = 2048 } = {}) {
  if (!root || !existsSync(root) || !keywords || !keywords.length) return ''
  const kws = keywords.map((k) => String(k).toLowerCase()).filter((k) => k.length >= 2)
  if (!kws.length) return ''
  const items = []
  try {
    for (const f of readdirSync(root).filter((x) => x.endsWith('.md'))) {
      const theme = f.slice(0, -3)
      const { entries } = readTheme(root, theme)
      for (const e of entries) {
        const score = keywordScore({ ...e, theme }, kws)
        if (score > 0) items.push({ theme, text: e.text, tag: e.tag, summary: e.summary, full: e.full, score })
      }
    }
  } catch { return '' }
  items.sort((a, b) => b.score - a.score || b.summary.localeCompare(a.summary))
  const header = '\n\n【相关经验抽调】根据当前任务关键词，以下过往经验与任务直接相关，可直接参考（格式：-[主题|标签] 摘要 -- 全文）：\n'
  let out = header
  const seen = new Set()
  for (const it of items) {
    if (seen.has(it.text)) continue
    const line = it.text
    const lb = line.length + 1
    if (out.length + lb > maxBytes) break
    seen.add(it.text)
    out += line + '\n'
  }
  return out === header ? '' : out
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
function inferTheme(tag, text) {
  const s = `${tag || ''} ${text}`.toLowerCase()
  if (/申报|认定|材料|知识产权|研发|高企|专精特新|小巨人|资质/.test(s)) return 'project-application'
  if (/政策|通知|公告|公示|补贴|资金/.test(s)) return 'policy'
  if (/财务|报销|发票|账|税务|成本/.test(s)) return 'finance'
  return 'workflow'
}
