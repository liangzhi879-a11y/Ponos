import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** zustand persist 的会话数据 localStorage 键（Sidebar/ExperiencePanel 共用） */
export const CHAT_STORAGE_KEY = 'yfworking-chat'

export function formatDate(timestamp: number, compact = false): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')

  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${hours}:${minutes}`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`

  if (compact) {
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear().toString().slice(-2)}`
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength - 3) + '...'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length)
  const size = (bytes / Math.pow(1024, exp)).toFixed(1)
  return `${size} ${units[exp - 1]}`
}

export function getFileLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    css: 'css', html: 'html', json: 'json', md: 'markdown',
    yaml: 'yaml', yml: 'yaml', xml: 'xml', sql: 'sql',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
    dockerfile: 'dockerfile', toml: 'toml', ini: 'ini',
    cfg: 'ini', conf: 'ini',
  }
  return map[ext || ''] || 'plaintext'
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// 文件是否可在内置编辑器中直接编辑（文本/代码/Markdown/HTML）；
// 图片/PDF/Office 等二进制类型在编辑器窗口内只读预览
export function isEditableFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return !/^(png|jpg|jpeg|gif|svg|webp|bmp|ico|pdf|docx|xlsx|xls|doc|ppt|pptx)$/i.test(ext)
}

const BOX_DRAWING_RE = /[\u2500-\u257F]/

const INLINE_FENCE_RE = /(^|[^\n`])(```\w*)/g

export function preprocessBoxDrawingTables(text: string): string {
  let result = text
  result = result.replace(INLINE_FENCE_RE, (_, prefix, fence) => prefix + '\n' + fence)
  const tailFence = /^((?:.+\s+)?```)$/gm
  result = result.replace(tailFence, '\n$1')
  if (!BOX_DRAWING_RE.test(result)) return result
  const lines = result.split('\n')
  const out: string[] = []
  let inBlock = false
  let inFencedCode = false // Track if we're inside any fenced code block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()
    // Track fenced code blocks (any language)
    if (/^```(\w*)$/.test(trimmed)) {
      if (!inFencedCode) {
        inFencedCode = true
        out.push(line)
        continue
      } else {
        inFencedCode = false
        out.push(line)
        continue
      }
    }
    // Skip processing if inside a fenced code block
    if (inFencedCode) {
      out.push(line)
      continue
    }
    const hasBox = BOX_DRAWING_RE.test(line)
    const nextIsFence = i + 1 < lines.length && /^\s*```/.test(lines[i + 1])
    const nextHasBox = !nextIsFence && i + 1 < lines.length && BOX_DRAWING_RE.test(lines[i + 1])
    if (hasBox && !inBlock) {
      out.push('```boxdraw')
      inBlock = true
    }
    out.push(line)
    if (inBlock && !nextHasBox) {
      out.push('```')
      inBlock = false
    }
  }
  if (inBlock) out.push('```')
  return out.join('\n')
}

export interface ParsedBoxTable {
  caption?: string
  header?: string[]
  rows: string[][]
  footer?: string[]
}

// Box-drawing character classes
// Light: ┌┐└┘├┤┬┴┼─│  (U+2500-257F basic)
// Heavy: ┏┓┗┛┣┫┳┻╋━┃  (U+2500-257F extended)
// Round: ╭╮╰╯
// Double: ╔╗╚╝╠╣╦╩╬═║
// All separators + corners we accept.
const LIGHT_CORNERS = '┌┐└┘├┤┬┴┼─'
const HEAVY_CORNERS = '┏┓┗┛┣┫┳┻╋━'
const ROUND_CORNERS = '╭╮╰╯'
const DOUBLE_CORNERS = '╔╗╚╝╠╣╦╩╬═'
// All "vertical pipe" characters that can appear at the start/end of a row
const ANY_V = '│┃║'
// All "horizontal bar" characters used in separators
const ANY_H = '─━═'
// All box-drawing chars combined (for sep detection)
const ALL_BOX = LIGHT_CORNERS + HEAVY_CORNERS + ROUND_CORNERS + DOUBLE_CORNERS + ANY_V + ANY_H

// Matches a data row: starts with a vertical bar, has a vertical bar somewhere in the middle, ends with a vertical bar (or corner char)
const BOX_ROW_RE = new RegExp(`^[${ANY_V}].*[${ANY_V}${LIGHT_CORNERS.slice(1, 5)}${HEAVY_CORNERS.slice(1, 5)}${DOUBLE_CORNERS.slice(1, 5)}]$`)
// Matches a separator line: any combination of box-drawing characters
const BOX_SEP_RE = new RegExp(`^[${ALL_BOX}]+$`)

interface RawItem {
  kind: 'row' | 'sep'
  cells?: string[]
  line: string
}

// A vertical pipe char (any of the variants)
const V_PIPE_RE = new RegExp(`[${ANY_V}]`)
// A corner char that can appear at line end
const CORNER_END_RE = new RegExp(`[${LIGHT_CORNERS.slice(1, 5)}${HEAVY_CORNERS.slice(1, 5)}${DOUBLE_CORNERS.slice(1, 5)}${ROUND_CORNERS.slice(2)}]$`)

function splitRow(line: string): string[] {
  // Strip leading vertical bar (any variant) and trailing corner character, then split on the SAME vertical bar char that was at the start
  let s = line
  if (V_PIPE_RE.test(s[0] || '')) s = s.slice(1)
  // Strip trailing corner if present, else strip trailing vertical bar
  if (CORNER_END_RE.test(s.slice(-1))) s = s.slice(0, -1)
  else if (V_PIPE_RE.test(s.slice(-1))) s = s.slice(0, -1)
  // Split on the dominant vertical pipe character
  // Find which v-char appears in this line, prefer │ then ┃ then ║
  const splitChar = ANY_V.split('').find(c => s.includes(c)) || '│'
  return s.split(splitChar).map(c => c.trim())
}

export function parseBoxDrawingTable(codeStr: string): ParsedBoxTable | null {
  const rawLines = codeStr.split('\n').map(l => l.replace(/\r$/, ''))

  // 1) Pre-merge: a row that ends without │/┐/┤/┘ is a "broken" row whose
  //    trailing newline shouldn't have split it. Stitch it back together with
  //    subsequent non-sep lines until we see a proper row terminator.
  const lines: string[] = []
  let buffer = ''
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    const trimmed = line.trim()
    if (buffer) {
      buffer += line  // keep original spacing
    } else {
      buffer = trimmed
    }
    // Check if current buffer is a complete row (ends with │/┐/┤/┘) OR a sep
    // (sep must be PURELY made of box-drawing characters)
    const endsAsRow = /[│┐┤┘]$/.test(buffer)
    const isSep = BOX_SEP_RE.test(buffer) || (buffer.includes('─') && BOX_SEP_RE.test(buffer))
    if (endsAsRow || isSep || buffer.trim() === '') {
      // No merge needed OR we've just completed a sep
      // if buffer is empty (was already empty), skip
      if (buffer.trim() === '') {
        buffer = ''
        continue
      }
      lines.push(buffer)
      buffer = ''
    }
  }
  if (buffer.trim()) lines.push(buffer)

  // 2) Classify every non-empty line
  const items: RawItem[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (BOX_ROW_RE.test(trimmed)) {
      items.push({ kind: 'row', cells: splitRow(trimmed), line: trimmed })
    } else if (BOX_SEP_RE.test(trimmed) || (trimmed.includes('─') && BOX_SEP_RE.test(trimmed))) {
      items.push({ kind: 'sep', line: trimmed })
    }
  }
  if (items.length < 2) return null

  // 3) Find sep lines that act as column separators.
  //    We look for any sep containing ┌/┬/┴/├/┼. For the "table bounds" (firstSep/lastSep),
  //    we prefer ┌ at the top and ┴/└ at the bottom; for inner separators any ├/┬/┴/┼ works.
  const allSepIdxs: number[] = []
  items.forEach((it, i) => {
    if (it.kind !== 'sep') return
    if (/[┌┬┴├┼]/.test(it.line)) allSepIdxs.push(i)
  })
  if (allSepIdxs.length < 2) return null

  // Identify the "top" and "bottom" of the table:
  // - top sep: the first sep that has ┌ or ┬ or ├ (any of these is OK as table top)
  // - bottom sep: the last sep that has └ or ┴ or ┤
  // If we can't find ┌/┬ at top, treat the first ├ as the header separator
  // and look for the first row after it.
  let firstSep = allSepIdxs[0]
  let lastSep = allSepIdxs[allSepIdxs.length - 1]

  // Refine firstSep: pick the first sep that is followed by a row.
  // (This handles tables missing a top ┌──┐ border.)
  for (const idx of allSepIdxs) {
    if (idx + 1 < items.length && items[idx + 1].kind === 'row') {
      firstSep = idx
      break
    }
  }

  // Determine where header lives:
  // - If items[firstSep - 1] is a row, it's the header (table-without-top-border case)
  // - Otherwise, header is items[firstSep + 1] (standard table)
  let headerIdx = -1
  if (firstSep > 0 && items[firstSep - 1].kind === 'row') {
    headerIdx = firstSep - 1
  } else {
    for (let i = firstSep + 1; i < lastSep; i++) {
      if (items[i].kind === 'row') { headerIdx = i; break }
    }
  }
  if (headerIdx === -1) return null
  const header = items[headerIdx].cells || []

  // 4) Body rows: rows between headerIdx and lastSep
  const rows: string[][] = []
  for (let i = headerIdx + 1; i < lastSep; i++) {
    if (items[i].kind === 'row') rows.push(items[i].cells || [])
  }

  // 6) Footer: last row before lastSep if it spans fewer columns than header
  let footer: string[] | undefined
  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1]
    if (lastRow.length < header.length && lastRow.length > 0) {
      footer = lastRow
      rows.pop()
    } else if (lastRow.length === 1 && header.length > 1) {
      footer = lastRow
      rows.pop()
    }
  }

  // 7) Normalize: pad all rows to header length
  const colCount = header.length
  const normRows = rows
    .filter(r => r.length > 0)
    .map(r => {
      if (r.length === colCount) return r
      if (r.length === 1) return r  // caller may colSpan
      const out = [...r]
      while (out.length < colCount) out.push('')
      return out.slice(0, colCount)
    })

  return {
    header,
    rows: normRows,
    footer,
  }
}

const FILE_EXT_RE = /\.(docx|xlsx|xls|pptx|pdf|txt|md|markdown|json|yaml|yml|xml|toml|csv|html|css|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|hpp|sh|bat|ps1|sql|png|jpe?g|gif|svg|webp|ico|bmp|zip|rar|7z|gz|tar|log|lock)$/i

export interface FilePathMatch {
  text: string
  path: string
  start: number
  end: number
  isFile: boolean
}

// ── 线性路径扫描 ──────────────────────────────────────────────
// 旧实现用三个嵌套量词正则（WIN_ABS_RE/UNC_RE/REL_PATH_RE）对每段文本做 matchAll，
// 其中 WIN_ABS_RE 的 (?:[^\s…]+[/\\])* 结构对"长且无空格、含多个分隔符、结尾无 .ext"
// 的类路径串（如 C:\a\a\a\…\b）会发生灾难性回溯，把渲染主线程永久挂死：
// 所有会话同时无响应、应用无法关闭、托盘僵尸、系统无法关机。
// 这里全部改为单遍线性扫描，匹配语义与原正则保持一致：
//   win-abs：C:[/\]…[/\]名称.ext（.ext = 2-6 个 \w，可被截断到 6）
//   UNC：    \\主机\共享[…\任意段]
//   rel：    行首或 [\s("'`（【] 之后，含至少一个 / 或 \，以 .ext(2-6 个 \w) 结尾

const WS_RE = /\s/
const SLASHES = '/\\'
const WIN_ABS_EXCLUDED = '<>:"|?*'

function isPathChar(ch: string | undefined): boolean {
  if (!ch) return false
  return !WS_RE.test(ch) && WIN_ABS_EXCLUDED.indexOf(ch) === -1
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false
  const c = ch.charCodeAt(0)
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}

/** 相对路径结尾 lookahead：[\s.,;:!?)\"'`】] 或行尾 */
const REL_END_BOUNDARY = '.,;:!?)\'"`】'
function isRelEndBoundary(ch: string | undefined): boolean {
  if (!ch) return true
  return WS_RE.test(ch) || REL_END_BOUNDARY.indexOf(ch) !== -1
}

/** 相对路径起始边界：[\s("'`（【] */
const REL_START_BOUNDARY = '("\'`（【'
function isRelStartBoundary(ch: string | undefined): boolean {
  if (!ch) return false
  return WS_RE.test(ch) || REL_START_BOUNDARY.indexOf(ch) !== -1
}

/** 自 start 起连续路径字符的终点（不含） */
function runEndOf(text: string, start: number): number {
  let i = start
  while (i < text.length && isPathChar(text[i])) i++
  return i
}

export function detectFilePaths(text: string, cwd?: string): FilePathMatch[] {
  const results: FilePathMatch[] = []
  const seen = new Set<number>()
  const n = text.length

  const tryAdd = (raw: string, abs: string, start: number, end: number) => {
    if (seen.has(start)) return
    const isFile = FILE_EXT_RE.test(abs) || FILE_EXT_RE.test(raw)
    results.push({ text: raw, path: abs, start, end, isFile })
    seen.add(start)
  }

  // 1) Windows 绝对路径：C:[/\]…[/\]名称.ext（.ext = 2-6 个 \w）
  for (let i = 0; i < n; i++) {
    const c0 = text.charCodeAt(i)
    const isLetter = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)
    if (!isLetter || text[i + 1] !== ':' || SLASHES.indexOf(text[i + 2] || '') === -1) continue
    const runEnd = runEndOf(text, i + 3)
    // 从后往前找最后一个点，其后连续 ≥2 个 \w
    let d = -1
    let wc = 0
    for (let j = runEnd - 1; j >= i + 4; j--) {
      if (text[j] !== '.') continue
      let c = 0
      while (j + 1 + c < runEnd && isWordChar(text[j + 1 + c])) c++
      if (c >= 2) { d = j; wc = c; break }
    }
    if (d === -1) continue
    const end = d + 1 + Math.min(wc, 6)
    tryAdd(text.slice(i, end), text.slice(i, end), i, end)
    i = end - 1
  }

  // 2) UNC 路径：\\主机\共享[…\任意段]
  for (let i = 0; i < n - 1; i++) {
    if (text[i] !== '\\' || text[i + 1] !== '\\') continue
    const runEnd = runEndOf(text, i + 2)
    const run = text.slice(i + 2, runEnd)
    // 需存在一个 \，其前后各至少 1 个路径字符
    let hasSep = false
    for (let k = 1; k < run.length - 1; k++) {
      if (run[k] === '\\') { hasSep = true; break }
    }
    if (!hasSep) continue
    const end = runEnd
    tryAdd(text.slice(i, end), text.slice(i, end), i, end)
    i = end - 1
  }

  // 3) 相对路径：行首或 [\s("'`（【] 之后，含至少一个 / 或 \，以 .ext(2-6 个 \w) 结尾
  let p = 0
  while (p < n) {
    let s = -1
    const lineStart = p === 0 || text[p - 1] === '\n'
    // 行首候选（^ 在交替中优先），失败后再试边界字符候选 [\s("'`（【]
    if (lineStart && isPathChar(text[p])) s = p
    if (s === -1 && isRelStartBoundary(text[p])) s = p + 1
    if (s === -1 || s >= n || !isPathChar(text[s])) { p++; continue }
    const runEnd = runEndOf(text, s)
    // 从后往前找最后一个合法点：\w 数 ∈ [2,6] 且后随边界字符，且点前至少一个 / 或 \
    let d = -1
    let wc = 0
    for (let j = runEnd - 1; j >= s + 2; j--) {
      if (text[j] !== '.') continue
      let c = 0
      while (j + 1 + c < runEnd && isWordChar(text[j + 1 + c])) c++
      if (c < 2 || c > 6) continue
      if (!isRelEndBoundary(text[j + 1 + c])) continue
      let hasSlash = false
      for (let q = s; q <= j - 2; q++) {
        if (SLASHES.indexOf(text[q]) !== -1) { hasSlash = true; break }
      }
      if (!hasSlash) continue
      d = j; wc = c; break
    }
    // 该 run 内无合法匹配：同 run 内的其它候选必然也失败（候选条件单调），直接跳过
    if (d === -1) { p = runEnd; continue }
    const end = d + 1 + wc
    const raw = text.slice(s, end)
    const norm = raw.replace(/\\/g, '/')
    const abs = cwd ? cwd.replace(/[/\\]$/, '') + '/' + norm.replace(/^\.?\//, '') : norm
    tryAdd(raw, abs, s, end)
    p = end
  }

  return results.sort((a, b) => a.start - b.start)
}

/**
 * 剥离文本中的脏控制字符（C0 区 U+0000–U+001F 与 DEL U+007F），
 * 但保留常见空白控制符 \t \n \r —— 消息正文里到处都是换行，不能误删。
 * 用于消息内容入库/落盘前的清洗，防止历史编码事故（原始控制字节混入
 * 持久化数据导致 JSON.parse 失败、会话"丢失"且重启无法恢复）再次发生。
 */
export function sanitizeText(s: string): string {
  if (!s) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) continue
    if (code === 0x7f) continue
    out += s[i]
  }
  return out
}

/**
 * 严格版清洗：剥离全部 C0 控制字符与 DEL，一个不留。
 * 仅用于修复"已序列化的 JSON 原始串"——序列化形式里换行必须是 \\n 转义，
 * 出现原生控制字节即损坏，可全部剥除以尽量恢复可解析性。
 */
export function stripControlChars(s: string): string {
  if (!s) return s
  // 用正则替换而非逐字符拼接：40M 字符的大值，拼接法实测 7s+，正则 ~70ms
  return s.replace(/[\u0000-\u001f\u007f]/g, '')
}

// ---------------------------------------------------------------------------
// 持久化损坏值抢救（2026-08-15 会话历史"重启丢失"根因修复）
// ---------------------------------------------------------------------------
// 事故复盘：持久化的 chat 值在字节层面完好（合法 UTF-16LE），但消息正文里
// 混入了历史编码事故留下的脏内容——原始控制字符、游离反斜杠、以及两种双编码
// 乱码（ASCII 字节被扩成 U+XX00 码位；UTF-8 字节被 0xFD 污染）。JSON.parse
// 因此失败 → rehydrate 回退空态 → 重启后历史"消失"。
// 抢救策略（逐级递进，任一级解析成功即用）：
//   1. 剥离控制字符（原有 stripControlChars）
//   2. 修复游离反斜杠（合法的 JSON 转义只允许 " \ / b f n r t u）
//   3. 把 U+XX00 双编码 ASCII 还原回 ASCII（例如 U+7400 → 't'）
//   4. 以上全部失败时，用容错提取重建会话状态（结构保留、脏内容原样保留）
// 该策略保证：无论主值坏到什么程度，rehydrate 都不会静默清空历史。

/** 把 U+XX00 码位（UTF-16LE 字节被当码位读的双编码产物）还原为 ASCII 字符。 */
export function decodeDoubleEncodedAscii(s: string): string {
  if (!s) return s
  // 仅当命中处于"连续 XX00 连串"中时才解码：ASCII 乱码必然成串
  // （"toolName" → 琀漀漀氀一愀洀攀）；而真实中文里同样低位为 0 的字
  // （一/开/最/怀/刃）在幸存中文区是孤立的，直接解码会破坏它们
  // （一 U+4E00 → 'N'，实测数据中有 19K+ 个孤立"一"是真实中文）。
  // 正则+回调比逐字符拼接快（40M 大值约 2.6s vs 5s+）
  return s.replace(/[\u2000-\u7eff]/g, (ch, offset) => {
    const code = ch.charCodeAt(0)
    if (!isDoubleEncodedAscii(code)) return ch
    const hi = code >> 8
    if (hi < 0x20 || hi >= 0x7f) return ch
    const prevOK = offset > 0 && isDoubleEncodedAscii(s.charCodeAt(offset - 1))
    const nextOK = offset < s.length - 1 && isDoubleEncodedAscii(s.charCodeAt(offset + 1))
    return prevOK || nextOK ? String.fromCharCode(hi) : ch
  })
}

/** 是否 U+XX00 型双编码码位（0x2000-0x7EFF 且低位为 0，即 0x2000、0x2400…0x7E00）。 */
function isDoubleEncodedAscii(code: number): boolean {
  return code >= 0x2000 && code < 0x7f00 && (code & 0xff) === 0
}

/** 修复游离反斜杠：后随字符不是合法转义目标时，把该反斜杠转义为 \\。 */
export function repairStrayBackslashes(s: string): string {
  if (!s) return s
  const BS = '\\'
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== BS) { out += ch; continue }
    const nxt = s[i + 1]
    const simple = nxt === '"' || nxt === BS || nxt === '/' || nxt === 'b' || nxt === 'f' || nxt === 'n' || nxt === 'r' || nxt === 't'
    if (simple) { out += ch + nxt; i++; continue }
    if (nxt === 'u') {
      const hex = s.slice(i + 2, i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += ch + nxt + hex; i += 5; continue }
      out += BS + BS
      continue
    }
    out += BS + BS
  }
  return out
}

/**
 * 逐级修复损坏的持久化 JSON 原始串，返回可解析的修复串；全部失败返回 null。
 * 注意：即便修复后能解析，正文里的游离引号/脏字符仍可能导致解析失败——
 * 那类情况交由 recoverCorruptedChatState 做容错重建兜底。
 * 超大值直接返回 null（不做全量 JSON.parse）：一次解析就能建出数 GB 对象树，
 * 有 OOM 风险；这类值统一走 recoverCorruptedChatState 的内存友好容错重建。
 */
const REPAIR_PARSE_SIZE_LIMIT = 4_000_000
export function repairCorruptedJson(raw: string): string | null {
  if (!raw) return null
  if (raw.length > REPAIR_PARSE_SIZE_LIMIT) return null
  // 候选按"改动最小者优先"排序：仅剥离控制字符能解析就不再动正文——decode 双编码
  // 还原的连串感知只保护孤立中文（一 U+4E00 等），相邻两个低位为 0 的真实汉字
  // （如"一开"）仍会被误判成双编码连串解码成 ASCII（"N_"），修复后再写回持久化
  // 会把正文静默破坏。只有当最小修复解析失败时才升级到 decode。
  const candidates: string[] = [
    stripControlChars(raw),
    repairStrayBackslashes(stripControlChars(raw)),
    repairStrayBackslashes(decodeDoubleEncodedAscii(stripControlChars(raw))),
  ]
  for (const c of candidates) {
    try { JSON.parse(c); return c } catch { /* next */ }
  }
  return null
}

/** 容错解析字符串字面量：异常开销大（脏内容会让 JSON.parse 抛大量异常），改为手动扫描转义。 */
function unescapeJsonLiteral(inner: string): string {
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== '\\') { out += ch; continue }
    const nxt = inner[i + 1]
    if (nxt === 'n') { out += '\n'; i++; continue }
    if (nxt === 't') { out += '\t'; i++; continue }
    if (nxt === 'r') { out += '\r'; i++; continue }
    if (nxt === '"') { out += '"'; i++; continue }
    if (nxt === '\\') { out += '\\'; i++; continue }
    if (nxt === 'u' && /^[0-9a-fA-F]{4}$/.test(inner.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(inner.slice(i + 2, i + 6), 16))
      i += 5
      continue
    }
    out += ch
    if (nxt) { out += nxt; i++ }
  }
  return out
}

/**
 * 容错重建会话持久化状态：结构按 id/title/role/type 锚点提取，
 * 正文内容尽力保留（含乱码），不再依赖整体 JSON.parse。
 * 返回与 partialize 一致的 state 对象（conversations/conversationSets/
 * activeConversationId/lastCwd）；提取不到任何会话时返回 null。
 */
export function recoverCorruptedChatState(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  const s = decodeDoubleEncodedAscii(stripControlChars(raw))

  // 会话锚点：{"id":"<digits>-<alnum>","title":   —— 消息用 "role"、内容块用 "type"，不会误判
  const convRe = /\{"id":"(\d+-[a-z0-9]+)","title":/g
  const anchors: { id: string; pos: number }[] = []
  let m: RegExpExecArray | null
  while ((m = convRe.exec(s))) anchors.push({ id: m[1], pos: m.index })
  if (anchors.length === 0) return null

  // 会话集
  const setsRe = /\{"id":"(\d+-[a-z0-9]+)","name":"((?:[^"\\]|\\.)*?)","cwd":"((?:[^"\\]|\\.)*?)","createdAt":(\d+)/g
  const sets: Record<string, unknown>[] = []
  while ((m = setsRe.exec(s))) {
    sets.push({ id: m[1], name: unescapeJsonLiteral(m[2]), cwd: unescapeJsonLiteral(m[3]), createdAt: Number(m[4]) })
  }

  const msgArrRe = /\{"id":"(\d+-[a-z0-9]+)","role":"([^"]+)","content":\[([\s\S]*?)\],"timestamp":(\d+)/g
  const msgStrRe = /\{"id":"(\d+-[a-z0-9]+)","role":"([^"]+)","content":"((?:[^"\\]|\\.)*?)","timestamp":(\d+)/g
  const blkRe = /\{"id":"(\d+-[a-z0-9]+)","type":"([^"]+)"(?:,"content":"((?:[^"\\]|\\.)*?)")?/g

  const conversations: Record<string, unknown>[] = []
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]
    const segEnd = i + 1 < anchors.length ? anchors[i + 1].pos : Math.min(s.length, a.pos + 4_000_000)
    const seg = s.slice(a.pos, segEnd)
    const conv: Record<string, unknown> = { id: a.id, title: '', model: '', messages: [] }
    const titleM = /"title":"((?:[^"\\]|\\.)*?)"/.exec(seg)
    if (titleM) conv.title = unescapeJsonLiteral(titleM[1])
    const cwdM = /"cwd":"((?:[^"\\]|\\.)*?)"/.exec(seg)
    if (cwdM) conv.cwd = unescapeJsonLiteral(cwdM[1])
    const createdM = /"createdAt":(\d+)/.exec(seg)
    if (createdM) conv.createdAt = Number(createdM[1])
    const updatedM = /"updatedAt":(\d+)/.exec(seg)
    if (updatedM) conv.updatedAt = Number(updatedM[1])

    const msgs: Record<string, unknown>[] = []
    msgArrRe.lastIndex = 0
    let am: RegExpExecArray | null
    while ((am = msgArrRe.exec(seg))) {
      const blocks: Record<string, unknown>[] = []
      blkRe.lastIndex = 0
      let bm: RegExpExecArray | null
      while ((bm = blkRe.exec(am[3]))) {
        // content 组缺失（损坏序列化）的块直接丢弃：无内容可恢复，且无 content 的
        // text 块会炸渲染层（extractAskUserCards(undefined) → TypeError），
        // 而恢复结果会被写回 localStorage——宁可丢块也不产出可持久化的崩溃状态。
        if (bm[3] === undefined) continue
        blocks.push({ id: bm[1], type: bm[2], content: unescapeJsonLiteral(bm[3]) })
      }
      msgs.push({ id: am[1], role: am[2], content: blocks, timestamp: Number(am[4]) })
    }
    if (msgs.length === 0) {
      msgStrRe.lastIndex = 0
      let sm: RegExpExecArray | null
      while ((sm = msgStrRe.exec(seg))) {
        // 字符串型 content 归一为单 text 块：渲染层（msg.content.map）与流式处理
        // 都按块数组消费，字符串会在 .filter/.map 处崩溃。
        msgs.push({
          id: sm[1], role: sm[2], timestamp: Number(sm[4]),
          content: [{ id: sm[1] + '-t0', type: 'text', content: unescapeJsonLiteral(sm[3]) }],
        })
      }
    }
    conv.messages = msgs
    if (conv.createdAt === undefined && msgs.length > 0) {
      conv.createdAt = (msgs[0] as { timestamp?: number }).timestamp
    }
    conversations.push(conv)
  }

  const actMatch = /"activeConversationId"\s*:\s*"([^"]+)"/.exec(s)
  const cwdMatch = /"lastCwd"\s*:\s*"([^"]+)"/.exec(s)
  return {
    conversations,
    conversationSets: sets,
    activeConversationId: actMatch ? actMatch[1] : null,
    lastCwd: cwdMatch ? cwdMatch[1] : null,
  }
}

// ---------------------------------------------------------------------------
// 打断插话快捷键（interject shortcut）
// 规范格式：修饰键按 ctrl/alt/shift 顺序（'ctrl' 表示 Ctrl 或 Cmd 任一），
// 加主键小写，如 'ctrl+enter'、'alt+shift+f2'。
// ---------------------------------------------------------------------------

export interface ParsedShortcut {
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = String(shortcut || '').toLowerCase().split('+').map(s => s.trim()).filter(Boolean)
  const key = parts.pop() || ''
  return {
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    key,
  }
}

/** 'ctrl+enter' → 'Ctrl+Enter'；非法/空回退默认 'Ctrl+Enter' */
export function formatShortcut(shortcut: string): string {
  const { ctrl, alt, shift, key } = parseShortcut(shortcut)
  if (!key) return 'Ctrl+Enter'
  const parts = [ctrl ? 'Ctrl' : null, alt ? 'Alt' : null, shift ? 'Shift' : null, key.toUpperCase()].filter(Boolean)
  return parts.join('+')
}

/** 判断键盘事件是否命中该快捷键。修饰键精确匹配：快捷键未含的修饰键按下即不命中。 */
export function matchShortcut(
  e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; key: string },
  shortcut: string
): boolean {
  const { ctrl, alt, shift, key } = parseShortcut(shortcut)
  if (!key) return false
  if (ctrl !== (e.ctrlKey || e.metaKey)) return false
  if (alt !== e.altKey) return false
  if (shift !== e.shiftKey) return false
  return e.key.toLowerCase() === key
}

/** 从键盘事件生成规范快捷键串；纯修饰键/无修饰键按键返回 null（不绑定）。 */
export function shortcutFromEvent(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; key: string }): string | null {
  const ctrl = e.ctrlKey || e.metaKey
  const alt = e.altKey
  const shift = e.shiftKey
  const key = e.key.toLowerCase()
  if (!ctrl && !alt && !shift) return null
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return null
  const parts = [ctrl ? 'ctrl' : null, alt ? 'alt' : null, shift ? 'shift' : null, key].filter(Boolean)
  return parts.join('+')
}

