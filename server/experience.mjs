import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs'

// 测试注入 HOME：process.env.YFW_TEST_HOME 存在时重定向（测试隔离，不碰真实 ~/.yfworking）
const HOME = process.env.YFW_TEST_HOME || homedir()
export const PERSONAL_DIR = join(HOME, '.yfworking', 'memory', 'personal')
export const INDEX_FILE = join(PERSONAL_DIR, '_index.json')
export const DEFAULT_THEMES = ['communication', 'code-style', 'workflow', 'finance', 'policy', 'project-application', 'office-docs']

const THEME_META = {
  communication: '沟通偏好：回复风格、语气、汇报粒度',
  'code-style': '编码偏好：语言、风格、测试习惯、工具用法',
  workflow: '工作流心得：处理任务的通用方法、分步试探、验证习惯',
  finance: '财务业务经验：报销、账务、财务表格处理、财税政策要点',
  policy: '政策业务经验：政策解读、申报条件、时效节点、口径变化',
  'project-application': '项目申报经验：申报材料组织、系统填报、材料要点',
  'office-docs': '办公文档经验：Word/PPT/PDF/Excel 处理心得、模板使用',
}

export function hashLine(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

function themeFilePath(theme) {
  return join(PERSONAL_DIR, `${theme}.md`)
}

export function ensurePersonalDir() {
  mkdirSync(PERSONAL_DIR, { recursive: true })
  for (const t of DEFAULT_THEMES) {
    const fp = themeFilePath(t)
    if (existsSync(fp)) continue
    const desc = THEME_META[t] || ''
    writeFileSync(fp, `---\nname: ${t}\ndescription: ${desc}\nactive: true\n---\n`, 'utf-8')
  }
}

function parseFrontmatter(raw) {
  // 极简 frontmatter：文件头 --- 包裹的 key: value 行
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { front: {}, body: raw }
  const front = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) front[kv[1]] = kv[2]
  }
  return { front, body: raw.slice(m[0].length) }
}

function serializeFrontmatter(front) {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n`
}

// 条目格式：- [会话|任务标签] 摘要 -- 全文
//  - 标签/摘要均可省略（旧格式 - [会话] 全文 完全兼容：tag=null，summary=full=内容）
//  - " -- " 分隔摘要与全文；无分隔符时整行为摘要即全文
export function parseEntryLine(line) {
  const text = line.trim()
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

export function readThemeFile(theme) {
  const fp = themeFilePath(theme)
  if (!existsSync(fp)) return null
  const raw = readFileSync(fp, 'utf-8')
  const { front, body } = parseFrontmatter(raw)
  const entries = body.split(/\r?\n/).filter(l => l.trim().startsWith('- ')).map(l => {
    const t = l.trim()
    return { text: t, hash: hashLine(t), ...parseEntryLine(t) }
  })
  return { front, entries, file: fp }
}

export function listExperiences() {
  ensurePersonalDir()
  const out = []
  const files = readdirSync(PERSONAL_DIR).filter(f => f.endsWith('.md'))
  for (const f of files) {
    const theme = f.replace(/\.md$/, '')
    const data = readThemeFile(theme)
    if (!data) continue
    out.push({
      theme,
      file: data.file,
      entryCount: data.entries.length,
      updatedAt: statSync(data.file).mtimeMs,
      active: data.front.active !== 'false',
      entries: data.entries,
    })
  }
  return out
}

function writeTheme(theme, front, body) {
  writeFileSync(themeFilePath(theme), serializeFrontmatter(front) + (body ? body + '\n' : ''), 'utf-8')
}

export function setThemeActive(theme, active) {
  const data = readThemeFile(theme)
  if (!data) return { ok: false, error: 'theme not found' }
  data.front.active = active ? 'true' : 'false'
  writeTheme(theme, data.front, data.entries.map(e => e.text).join('\n'))
  return { ok: true }
}

export function deleteThemeEntry(theme, entryHash) {
  const data = readThemeFile(theme)
  if (!data) return { ok: false, error: 'theme not found' }
  const before = data.entries.length
  const after = data.entries.filter(e => e.hash !== entryHash)
  writeTheme(theme, data.front, after.map(e => e.text).join('\n'))
  return { ok: true, deleted: before - after.length }
}

export function buildExperienceSection(maxBytes = 4096, only = null) {
  const list = listExperiences()
    .filter(x => x.active && x.entryCount > 0 && (!only || x.theme === only))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (!list.length) return ''
  const header = '\n\n【个人经验参考】以下为过往会话自动沉淀的个人经验（来源主题标注在前），供本次任务参考，按相关性自行取舍：\n'
  let out = header
  // 单主题配额（整段 1/3）：防某一主题条目过多挤占全部注入段落（≥3 个激活主题
  // 时每主题至多占 1/3）。主题的首条经验不受配额限制（单条超长仍可注入，只要
  // 整体未超 maxBytes），避免配额把主题唯一的长条目挡在外面。
  const themeQuota = Math.max(Math.floor(maxBytes / 3), 256)
  // 全局去重：不同主题/多次捕获落盘的相同内容只注入一次，防上下文重复污染。
  const seen = new Set()
  for (const item of list) {
    let themeBytes = 0
    for (const e of item.entries) {
      if (seen.has(e.hash)) continue
      const line = `- [${item.theme}] ${e.text.slice(2)}`
      const lineBytes = line.length + 1
      if (themeBytes > 0 && themeBytes + lineBytes > themeQuota) break
      if (out.length + lineBytes > maxBytes) return out
      seen.add(e.hash)
      out += line + '\n'
      themeBytes += lineBytes
    }
  }
  return out
}

// 摘要索引注入（替代全文注入）：启动时只给"主题|任务标签"分组的目录，
// agent 需要某任务细节时用 Read 读取对应文件定位条目——全局视野不丢、
// 细节按需取、总量天然受控（不做生硬截断，只按最近更新控制索引行数）。
export function buildExperienceIndex(maxBytes = 4096, only = null) {
  const list = listExperiences()
    .filter(x => x.active && x.entryCount > 0 && (!only || x.theme === only))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (!list.length) return ''
  const header = '\n\n【个人经验索引】过往会话沉淀的个人经验（按 主题|任务标签 分组，含未标注条目）。需要某任务的具体经验时，用 Read 读取该行末尾标注的文件（每行条目格式：- [会话|标签] 摘要 -- 全文），摘要判断相关性，全文含完整要点；与当前任务无关的标签无需读取。\n'
  let out = header
  const lines = []
  const fmt = ts => new Date(ts).toISOString().slice(0, 10)
  for (const item of list) {
    const groups = new Map()
    let untagged = 0
    for (const e of item.entries) {
      if (!e.tag) { untagged++; continue }
      const g = groups.get(e.tag) || { tag: e.tag, count: 0 }
      g.count++
      groups.set(e.tag, g)
    }
    for (const g of groups.values()) {
      lines.push(`- [${item.theme}|${g.tag}] ${g.count} 条 · 最近 ${fmt(item.updatedAt)} · ${item.file}`)
    }
    if (untagged > 0) {
      lines.push(`- [${item.theme}] ${untagged} 条未标注经验 · 最近 ${fmt(item.updatedAt)} · ${item.file}`)
    }
  }
  // 超限时丢弃最旧的索引行（按已排序的最近更新顺序），不截断任何条目本身
  for (const line of lines) {
    const lb = line.length + 1
    if (out.length + lb > maxBytes) break
    out += line + '\n'
  }
  return out
}

export function buildSedimentPrompt() {
  return [
    '',
    '【经验沉淀（静默，不询问用户）】当本次会话中出现以下情况时，用 Write/Edit 工具把经验写入 ~/.yfworking/memory/personal/{主题}.md（文件不存在则按现有 frontmatter 模板创建；主题从 communication/code-style/workflow/finance/policy/project-application/office-docs 中选最贴合的）：',
    '① 用户明确表达偏好（回复风格、汇报粒度、代码风格、工具选择）',
    '② 业务事实（财务处理、政策解读、申报口径、项目要求等确定信息）',
    '③ 问题-解决模式（本次解决的关键问题及其方案、预防建议）',
    '④ 工作流心得（被验证有效的处理流程与验证习惯）',
    '每条经验写为一行，格式：- [会话|任务标签] 摘要 -- 全文',
    '任务标签 = 本次会话正在做的具体工作内容（如"成果转化材料"、"PS材料"、"RD立项报告"、"印章扫描化"），同一类任务复用同一标签便于按任务检索；无明确任务时可省略标签写 - [会话] 摘要 -- 全文',
    '摘要 = 一句话要点（首次阅读即判断相关性）；全文 = 完整经验（背景/关键步骤/坑与预防/验证方式）。摘要与全文都必须写，严禁只写摘要不写全文',
    '写入前先读文件：相同摘要不重复追加；严禁写入密钥、密码、API token、身份证号、银行账号等敏感信息。',
    '',
  ].join('\n')
}

export function refreshIndex() {
  const themes = {}
  for (const item of listExperiences()) {
    themes[item.theme] = {
      entry_count: item.entryCount,
      updated_at: new Date(item.updatedAt).toISOString(),
      active: item.active,
      // 单主题索引段贡献字节数（仅该主题激活时），供面板/维护观察各主题负载
      inject_bytes: buildExperienceIndex(4096, item.theme).length,
    }
  }
  // 整段真实注入尺寸（默认上限 4096 下）——真正的上下文成本指标
  const totalInjectBytes = buildExperienceIndex(4096).length
  writeFileSync(INDEX_FILE, JSON.stringify({ total_inject_bytes: totalInjectBytes, themes }, null, 2), 'utf-8')
}
