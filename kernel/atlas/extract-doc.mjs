// kernel/atlas/extract-doc.mjs —— 文档卡片抽取（Markdown / HTML / 文本 / 业务文档）
// ---------------------------------------------------------------------------
// 文档卡不假设“有头注释”。目的来源按 T4 阶梯：
//   frontmatter.title / 首个标题 / 首段 → medium
//   只有文件名、没有标题也没有正文   → low（明确标记未识别）
// office/pdf 优先用 doc-text.mjs 抽正文（docx/xlsx/pptx 纯 JS，PDF 只取文本层）；
// 抽不到时只建元数据卡（noText:true）并记录原因，不臆造职责；图片同理。
import path from 'node:path'
import { parseFrontmatter } from '../../shared/knowledge-core.mjs'
import { domainOf, layerInfo } from './config.mjs'
import { normalizeText, hashText } from './extract.mjs'
import { extractOoxmlText, isLegacyOfficeExt, isOoxmlExt } from './doc-text.mjs'

const MAX_HEADINGS = 40
const MAX_REFS = 200
const HEAD_BYTES = 4096
// 纯页码/页眉噪声：`1`、`- 1 -`、`1/10`、`第 1 页 共 10 页`。
const PAGE_NOISE_RE = /^(?:[-–—]\s*)?(?:第\s*)?\d{1,4}\s*(?:页)?(?:\s*(?:\/|共)\s*(?:共\s*)?\d{1,4}\s*页?)?\s*[-–—]?$/

function firstLineOf(text, index) {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++
  return n
}

function cap(s, n = 200) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function stripMdInline(s) {
  return String(s ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function isNoiseLine(line) {
  const t = line.trim()
  if (!t) return null
  if (/^<!--/.test(t) || /^-->/.test(t)) return null
  if (/^```/.test(t) || /^~~~/.test(t)) return 'fence'
  if (/^#{1,6}\s+/.test(t)) return 'heading'
  if (/^(?:[-*_]\s*){3,}$/.test(t)) return 'hr'
  if (/^\|?\s*:?-{3,}/.test(t) && t.includes('|')) return 'table-sep'
  return ''
}

function cleanParagraphLine(line) {
  return stripMdInline(
    String(line)
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .replace(/\|/g, ' / '),
  )
}

function markdownInfo(raw) {
  const text = normalizeText(raw)
  let front = {}
  let body = text
  let bodyStartLine = 1
  try {
    const parsed = parseFrontmatter(text)
    front = parsed.front || {}
    body = parsed.body || text
    bodyStartLine = parsed.bodyStartLine || 1
  } catch { /* frontmatter 坏了按无 frontmatter 处理 */ }

  const frontTitle = typeof front.title === 'string' ? cap(front.title, 120) : ''
  const lines = body.split('\n')
  const headings = []
  let firstHeading = ''
  let summary = ''
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const hm = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (hm) {
      const title = stripMdInline(hm[2])
      if (!title) continue
      if (!firstHeading) firstHeading = cap(title, 120)
      if (headings.length < MAX_HEADINGS) {
        headings.push({ level: hm[1].length, text: cap(title, 120), line: bodyStartLine + i })
      }
      continue
    }
    if (summary) continue
    const noise = isNoiseLine(line)
    if (noise === 'fence' || noise === 'heading' || noise === 'hr' || noise === 'table-sep' || noise === null) continue
    const cleaned = cleanParagraphLine(line)
    if (cleaned.length >= 4) summary = cap(cleaned, 240)
  }

  return {
    frontTitle,
    firstHeading,
    summary,
    headings,
    explicitTitle: frontTitle || firstHeading,
    loc: text ? text.split('\n').length : 0,
  }
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
}

function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, k) => {
      const key = String(k).toLowerCase()
      if (HTML_ENTITIES[key] != null) return HTML_ENTITIES[key]
      if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16) || 32)
      if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10) || 32)
      return m
    })
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function htmlInfo(raw) {
  const text = normalizeText(raw)
  const mask = text
    .replace(/<script\b[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, ' '))
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(mask)
  const h1M = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(mask)
  const metaM = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i.exec(mask)
  const headings = []
  for (const m of mask.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = stripHtml(m[2])
    if (!t) continue
    if (headings.length >= MAX_HEADINGS) break
    headings.push({ level: Number(m[1]), text: cap(t, 120), line: firstLineOf(mask, m.index) })
  }
  let summary = ''
  for (const m of mask.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = stripHtml(m[1])
    if (t.length >= 10) { summary = cap(t, 240); break }
  }
  if (!summary && metaM) summary = cap(stripHtml(metaM[1]), 240)
  const frontTitle = titleM ? cap(stripHtml(titleM[1]), 120) : ''
  const firstHeading = h1M ? cap(stripHtml(h1M[1]), 120) : ''
  return {
    frontTitle,
    firstHeading,
    summary,
    headings,
    explicitTitle: frontTitle || firstHeading,
    loc: text ? text.split('\n').length : 0,
  }
}

/**
 * PDF/Office 抽出的纯文本：跳过页码/分隔线等短噪声。
 * docx 的标题样式与 pptx 的标题占位符在 doc-text.mjs 里已转成 `#` 标记；
 * PDF 没有标题结构，不硬加标记，仍按“第一行有意义文字”兜底。
 */
function officeInfo(raw, { headingMarks = false } = {}) {
  const text = normalizeText(raw).slice(0, HEAD_BYTES)
  const entries = []
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (PAGE_NOISE_RE.test(line)) continue
    // 只有 docx/pptx 的抽取器会加 `#`；PDF 正文里真出现 `#` 行也不当标题。
    const hm = headingMarks ? /^(#{1,6})\s+(.+)$/.exec(line) : null
    if (hm) {
      const heading = hm[2].trim()
      if (heading) entries.push({ text: heading, level: hm[1].length, line: i + 1, heading: true })
    } else {
      entries.push({ text: line, level: 0, line: i + 1, heading: false })
    }
  }
  const headings = entries.filter((e) => e.heading).slice(0, MAX_HEADINGS)
    .map((e) => ({ level: e.level, text: cap(e.text, 120), line: e.line }))
  const titleEntry = entries.find((e) => e.heading) || entries.find((e) => e.text.length >= 4)
  const after = titleEntry ? entries.slice(entries.indexOf(titleEntry) + 1) : entries
  const summaryEntry = after.find((e) => !e.heading && e.text.length >= 6) || after.find((e) => e.text.length >= 6)
  return {
    frontTitle: '',
    firstHeading: titleEntry ? cap(titleEntry.text, 120) : '',
    summary: summaryEntry ? cap(summaryEntry.text, 240) : '',
    headings,
    explicitTitle: titleEntry ? cap(titleEntry.text, 120) : '',
    loc: text.split('\n').length,
  }
}

function textInfo(raw, ext) {
  const text = normalizeText(raw).slice(0, HEAD_BYTES)
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim())
  if (!lines.length) return { frontTitle: '', firstHeading: '', summary: '', headings: [], explicitTitle: '', loc: 0 }

  if (ext === '.csv') {
    const cols = (lines[0].match(/"(?:[^"]|"")*"|[^,]+/g) || [])
      .map((c) => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'))
      .filter(Boolean)
      .slice(0, 8)
    return {
      frontTitle: '',
      firstHeading: '',
      summary: cols.length ? `CSV 列：${cols.join(' / ')}` : cap(lines[0], 240),
      headings: [],
      explicitTitle: '',
      loc: text.split('\n').length,
    }
  }

  const first = lines[0].trim()
  const hasTitle = first.length >= 4 && first.length <= 120
  const summaryLine = hasTitle ? (lines[1] || '').trim() : ''
  return {
    frontTitle: '',
    firstHeading: hasTitle ? first : '',
    summary: cap(summaryLine || (hasTitle ? '' : first), 240),
    headings: [],
    explicitTitle: hasTitle ? cap(first, 120) : '',
    loc: text.split('\n').length,
  }
}

// 文档正文中逐字出现的仓内路径（用于 doc_mentions 边）。不做语义猜测。
const DOC_PATH_RE = /(?<![\w/.-])((?:[\w@.-]+\/)+[\w@.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|py|go|rs|java|kt|rb|php|swift|scala|sh|bash|zsh|ps1|sql|vue|svelte|md|mdx|html|json|ya?ml|toml))(?=$|[^\w/.-])/gm

export function extractDocPathRefs(text, ext = '') {
  const src = normalizeText(text)
  const out = []
  const seen = new Set()
  for (const m of src.matchAll(DOC_PATH_RE)) {
    const start = m.index + m[0].indexOf(m[1])
    if (start >= 3 && src.slice(start - 3, start) === '://') continue
    let spec = m[1].replace(/[#:].*$/, '')
    if (!spec || spec.includes('*') || spec.startsWith('..')) continue
    const key = spec + '\u0000' + start
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ spec, line: firstLineOf(src, start) })
    if (out.length >= MAX_REFS) break
  }
  return out
}

function sizeTier(loc) {
  if (loc < 100) return 's'
  if (loc < 300) return 'm'
  if (loc < 1000) return 'l'
  return 'x'
}

function baseCard(entry, config) {
  return {
    v: 1,
    id: `doc:${entry.rel}`,
    kind: 'doc',
    path: entry.rel,
    lang: entry.ext.replace(/^\./, '') || 'md',
    layer: layerInfo(entry.rel, config),
    domain: domainOf(entry.rel, config),
    loc: 0,
    bytes: entry.size,
    sizeTier: 's',
    purpose: null,
    purposeSrc: 'none',
    confidence: 'none',
    title: null,
    headings: [],
    references: [],
    noText: false,
    textTruncated: entry.textTruncated === true,
    textSource: null,
    docTextReason: null,
    tooLarge: entry.tooLarge === true,
    content: entry.content === true,
    sourceHash: entry.text ? hashText(entry.text) : null,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
  }
}

/**
 * 文档卡片。`entry` 来自 scanWorkspace；`docText` 是 `preparePdfText` 的结果。
 * `kind` 一律 doc；具体格式由 lang 区分（md/html/txt/csv/pdf/docx/…）。
 * `onText(rel, text)` 是构建期词项索引的旁路：只喂给索引器，不改变卡片内容，
 * 也不把正文留在任何持久结构里。回调抛错不能影响卡片抽取。
 * @param {{entry:any, config:any, docText?:any, onText?:(rel:string, text:string)=>void}} opts
 */
export function extractDocCard({ entry, config, docText = null, onText = null }) {
  const card = baseCard(entry, config)
  const ext = entry.ext.toLowerCase()
  const base = path.posix.basename(entry.rel)
  const office = ext === '.pdf' || isOoxmlExt(ext) || isLegacyOfficeExt(ext)

  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg', '.ico'].includes(ext)) {
    card.purpose = `图片：${base}`
    card.purposeSrc = 'none'
    card.confidence = 'low'
    card.noText = true
    card.content = false
    return card
  }

  let raw = entry.text || ''
  let textSource = String(raw).trim() ? 'text' : null
  let textTruncated = entry.textTruncated === true
  let reason = null

  if (!String(raw).trim() && office) {
    const maxExtractBytes = Number(config.maxDocExtractBytes) || 20 * 1024 * 1024
    if (entry.size > maxExtractBytes) {
      reason = 'too-large'
    } else if (docText && docText.enabled === false) {
      reason = 'disabled'
    } else if (ext === '.pdf') {
      const got = docText?.pdfText?.get(entry.rel)
      if (got) {
        raw = got
        textSource = 'pdf'
        textTruncated = entry.textTruncated === true || docText.pdfTruncated?.get(entry.rel) === true
      } else {
        reason = docText?.reasons?.get(entry.rel) || 'not-prepared'
      }
    } else if (isOoxmlExt(ext)) {
      const parsed = extractOoxmlText(entry.abs, ext, {
        maxChars: Number(config.maxDocTextChars) || 20000,
        maxUncompressedBytes: Math.min(maxExtractBytes, 16 * 1024 * 1024),
      })
      if ('text' in parsed) {
        raw = parsed.text
        textSource = 'ooxml'
        textTruncated = textTruncated || parsed.truncated
      } else {
        reason = parsed.reason
      }
    } else {
      reason = entry.tooLarge ? 'too-large' : 'legacy'
    }
  }

  if (!String(raw).trim()) {
    // 大文本文档同样降级为元数据卡；不能因为超过 maxFileBytes 就“查无此文件”。
    if (entry.tooLarge && !office) {
      card.purpose = `未导入正文：${base}`
      card.purposeSrc = 'none'
      card.confidence = 'low'
      card.noText = true
      card.content = false
      card.docTextReason = 'too-large'
      return card
    }
    if (office) {
      card.purpose = `未导入正文：${base}`
      card.purposeSrc = 'none'
      card.confidence = 'low'
      card.noText = true
      card.content = false
      card.docTextReason = reason || 'no-text-layer'
      return card
    }
    card.purpose = `未识别职责：${base}`
    card.confidence = 'low'
    card.loc = 0
    return card
  }

  if (typeof onText === 'function') {
    try { onText(entry.rel, raw) } catch { /* 索引旁路失败只影响检索速度，不影响卡片 */ }
  }

  let info
  if (ext === '.html' || ext === '.htm') info = htmlInfo(raw)
  else if (ext === '.txt' || ext === '.csv') info = textInfo(raw, ext)
  else if (office) info = officeInfo(raw, { headingMarks: ext === '.docx' || ext === '.pptx' })
  else info = markdownInfo(raw)

  card.loc = info.loc
  card.sizeTier = sizeTier(info.loc)
  card.title = info.explicitTitle || null
  card.headings = info.headings
  card.content = true
  card.noText = false
  card.textSource = textSource
  card.textTruncated = textTruncated
  card.sourceHash = hashText(raw)

  // .txt/.csv/.xlsx 只有“首行/表头/单元格”可依据，证据弱于 md/html 的标题层级 → low
  const weakText = ext === '.txt' || ext === '.csv' || ext === '.xls' || ext === '.xlsx'
  const conf = weakText ? 'low' : 'medium'
  if (info.explicitTitle && info.summary) {
    card.purpose = `${info.explicitTitle} — ${info.summary}`
    card.purposeSrc = 'doc'
    card.confidence = conf
  } else if (info.explicitTitle) {
    card.purpose = info.explicitTitle
    card.purposeSrc = 'doc'
    card.confidence = conf
  } else if (info.summary) {
    card.purpose = info.summary
    card.purposeSrc = 'doc'
    card.confidence = conf
  } else {
    card.purpose = `未识别职责：${base}`
    card.purposeSrc = 'none'
    card.confidence = 'low'
  }

  card.references = extractDocPathRefs(raw, ext)
  return card
}

export { markdownInfo, htmlInfo, textInfo }
