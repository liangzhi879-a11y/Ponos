// kernel/memory.mjs —— 跨会话记忆内核化（L3-1/L3-2）
// 与 GUI 层 server/experience.mjs 同一数据源/格式/去重算法：
//   <configDir>/memory/personal/{theme}.md，条目 `- [会话|标签] 摘要 -- 全文`
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function memoryRoot(configDir) {
  return join(configDir || '', 'memory', 'personal')
}

export function hashLine(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

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

export function parseEntryLine(line) {
  const text = String(line).trim()
  const m = /^- \[([^\]]*)\]\s*(.*)$/.exec(text)
  const inner = m ? m[1] : ''
  let src = m ? m[2].trim() : text.replace(/^- /, '')
  let tag = null
  const bar = inner.lastIndexOf('|')
  if (bar >= 0) tag = inner.slice(bar + 1).trim() || null
  const sep = src.indexOf(' -- ')
  let summary, full
  if (sep >= 0) { summary = src.slice(0, sep).trim(); full = src.slice(sep + 4).trim() }
  else { summary = src; full = src }
  return { tag, summary: summary || full, full }
}

export function readMemoryEntries({ root = '', theme = '' } = {}) {
  if (!root || !theme) return []
  return readTheme(root, theme).entries
}

export function appendMemoryEntry({ root = '', theme = '', tag = null, summary = '', full = '' } = {}) {
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
        let score = 0
        const tagL = (e.tag || '').toLowerCase()
        const sumL = (e.summary || '').toLowerCase()
        const fullL = (e.full || '').toLowerCase()
        const themeL = theme.toLowerCase()
        for (const k of kws) {
          if (tagL.includes(k)) score += 3
          if (themeL.includes(k)) score += 2
          if (sumL.includes(k)) score += 2
          if (fullL.includes(k)) score += 1
        }
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
  workflow: ['流程是', '步骤是', '先', '再', '最后', '标准做法', '推荐做法'],
}

// 确定性捕获（启发式）：轮末对 user 文本做模式匹配，产出结构化记忆候选。
// 分级：correction/preference → 高价值（theme 固定 workflow/communication）；
// fact（业务事实）/workflow（流程心得）→ 中价值，theme 由 tag 推断（含申报/
// 政策/财务关键词 → 对应业务主题，否则 workflow）。
export function captureMemoryCandidates({ userText = '', tag = null, markers = null } = {}) {
  const t = String(userText || '')
  const m = { ...DEFAULT_MARKERS, ...(markers || {}) }
  const out = []
  const correction = (m.correction || []).find((x) => t.includes(x))
  if (correction) out.push({ theme: 'workflow', tag, summary: `用户纠正（${correction}）：${t.slice(0, 60)}`, full: t.slice(0, 500) })
  const preference = (m.preference || []).find((x) => t.includes(x))
  if (preference) out.push({ theme: 'communication', tag, summary: `用户偏好（${preference}）：${t.slice(0, 60)}`, full: t.slice(0, 500) })
  const fact = (m.fact || []).find((x) => t.includes(x))
  if (fact) out.push({ theme: inferTheme(tag, t), tag, summary: `业务要点（${fact}）：${t.slice(0, 60)}`, full: t.slice(0, 500) })
  // 流程要点：强信号词（流程是/标准做法/推荐做法）直接捕获；弱信号词（先/再/最后）
  // 要求文本足够长（≥30 字符）才捕获，防泛化词误伤。
  const workflow = (m.workflow || []).find((x) => t.includes(x))
  const strongFlow = /流程是|标准做法|推荐做法|步骤是/.test(t)
  if (workflow && !fact && (strongFlow || t.length > 30)) out.push({ theme: 'workflow', tag, summary: `流程要点：${t.slice(0, 60)}`, full: t.slice(0, 500) })
  return out
}

// 从任务标签/文本推断主题：申报/政策/财务关键词 → 业务主题；否则 workflow
function inferTheme(tag, text) {
  const s = `${tag || ''} ${text}`.toLowerCase()
  if (/申报|认定|材料|知识产权|研发|高企|专精特新|小巨人|资质/.test(s)) return 'project-application'
  if (/政策|通知|公告|公示|补贴|资金/.test(s)) return 'policy'
  if (/财务|报销|发票|账|税务|成本/.test(s)) return 'finance'
  return 'workflow'
}
