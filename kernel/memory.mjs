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

const DEFAULT_MARKERS = {
  correction: ['以后不要', '不要再', '以后别', '别用', '记住不要'],
  preference: ['我喜欢', '我希望', '我习惯', '以后都', '记得以后'],
}

// 确定性捕获（启发式）：轮末对 user 文本做模式匹配，产出结构化记忆候选。
export function captureMemoryCandidates({ userText = '', tag = null, markers = null } = {}) {
  const t = String(userText || '')
  const m = { ...DEFAULT_MARKERS, ...(markers || {}) }
  const out = []
  const correction = (m.correction || []).find((x) => t.includes(x))
  if (correction) out.push({ theme: 'workflow', tag, summary: `用户纠正（${correction}）：${t.slice(0, 60)}`, full: t.slice(0, 500) })
  const preference = (m.preference || []).find((x) => t.includes(x))
  if (preference) out.push({ theme: 'communication', tag, summary: `用户偏好（${preference}）：${t.slice(0, 60)}`, full: t.slice(0, 500) })
  return out
}
