// kernel/atlas/doc-text.mjs —— 文档正文提取（OOXML 纯 JS / PDF 文本层）
// ---------------------------------------------------------------------------
// 目标：让 Atlas 看见“日常文档里写了什么”，而不是只看见文件名。三条纪律：
//   ① **不新增运行时依赖**：docx/xlsx/pptx 是 ZIP + XML，这里用 node:zlib 自带的
//      inflateRawSync 读 central directory；不引 jszip（它只是 devDependency）。
//   ② **PDF 只取文本层，不做 OCR**：优先 pdftotext（几十毫秒/份）；没有就用自带
//      Python 的 pypdf 批量跑一次子进程。扫描件没有文本层 → 明确标 noText，不猜。
//   ③ **有上限、可预算**：单文件字节数、页数、字符数、文件数、总耗时都有上限；
//      超限返回原因而不是抛出，Atlas 构建不会因为一份坏文档整体失败。
//
// 这里产出纯文本，并把 docx 标题样式 / pptx 标题占位符标成 Markdown `#`
// （PDF 没有标题结构，不加标记）；职责/标题/引用仍由 extract-doc.mjs 统一抽取。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { childEnv } from '../exec-base.mjs'

const require = createRequire(import.meta.url)
const { resolvePython } = require('../../shared/python-runtime.cjs')

export const OOXML_EXT = new Set(['.docx', '.xlsx', '.pptx'])
export const LEGACY_OFFICE_EXT = new Set(['.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.rtf'])

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

export function isOoxmlExt(ext) {
  return OOXML_EXT.has(String(ext).toLowerCase())
}

export function isLegacyOfficeExt(ext) {
  return LEGACY_OFFICE_EXT.has(String(ext).toLowerCase())
}

function u16(buf, off) {
  return buf.readUInt16LE(off)
}

function decodeXmlEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, k) => {
    const key = String(k).toLowerCase()
    if (key === 'amp') return '&'
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'quot') return '"'
    if (key === 'apos') return "'"
    if (key === 'nbsp') return ' '
    if (key.startsWith('#x')) {
      const n = parseInt(key.slice(2), 16)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    if (key.startsWith('#')) {
      const n = parseInt(key.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return m
  })
}

function tidy(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 解析 ZIP central directory；不支持 ZIP64 与加密 zip。 */
function readZipDirectory(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found')
  const count = u16(buf, eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('zip: zip64 unsupported')
  if (cdOff + cdSize > buf.length) throw new Error('zip: central directory out of range')

  /** @type {Map<string, {method:number, compSize:number, uncompSize:number, localOff:number}>} */
  const entries = new Map()
  let p = cdOff
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break
    const method = u16(buf, p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = u16(buf, p + 28)
    const extraLen = u16(buf, p + 30)
    const commentLen = u16(buf, p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen > buf.length) break
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, uncompSize, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 读取一个 ZIP 条目；输出超过 maxBytes 时抛 code=too-large（防 zip bomb）。
 * 调用方在多条目格式里应递减 maxBytes，保证的是“整份文档解压总量”而非单条目。
 */
function readZipEntry(buf, entry, maxBytes) {
  if (!entry) throw new Error('zip: entry missing')
  if (maxBytes <= 0 || entry.uncompSize > maxBytes) {
    const err = new Error(`zip: entry too large (${entry.uncompSize} > ${maxBytes})`)
    // @ts-expect-error 自定义错误码
    err.code = 'too-large'
    throw err
  }
  const p = entry.localOff
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) throw new Error('zip: bad local header')
  const nameLen = u16(buf, p + 26)
  const extraLen = u16(buf, p + 28)
  const start = p + 30 + nameLen + extraLen
  const end = start + entry.compSize
  if (start > buf.length || end > buf.length) throw new Error('zip: entry data out of range')
  const data = buf.subarray(start, end)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) })
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ERR_BUFFER_TOO_LARGE') {
        const e = new Error('zip: inflated entry too large')
        // @ts-expect-error 自定义错误码
        e.code = 'too-large'
        throw e
      }
      throw err
    }
  }
  throw new Error(`zip: unsupported compression method ${entry.method}`)
}

function xmlToText(xml) {
  return tidy(decodeXmlEntities(
    String(xml)
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ))
}

/** styleId 命名约定兜底（没有 styles.xml 时）：Heading1 / heading-2 / 标题 3。 */
function headingLevelFromStyleId(styleId) {
  const m = /^(?:heading|标题)[\s_-]*([1-6])$/i.exec(String(styleId || '').trim())
  return m ? Number(m[1]) : 0
}

/**
 * 从 `word/styles.xml` 建立 styleId → 标题级别映射。
 * 中文版 Word 的 styleId 常是 `"1"`，只有 `<w:name w:val="heading 1"/>` 能识别；
 * 有的模板只用 `<w:outlineLvl w:val="0"/>`（0 基）而不叫 heading。两种都认。
 * styles.xml 缺失/损坏/超出预算时返回空映射，正文仍可正常抽出。
 */
function docxStyleLevels(dir, buf, maxBytes) {
  const levels = new Map()
  const entry = dir.get('word/styles.xml')
  const cap = Math.min(maxBytes, 1024 * 1024)
  if (!entry || cap <= 0 || entry.uncompSize > cap) return { levels, bytes: 0 }
  let raw
  try {
    raw = readZipEntry(buf, entry, cap)
  } catch {
    return { levels, bytes: 0 }
  }
  const xml = raw.toString('utf8')
  for (const m of xml.matchAll(/<w:style\b[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const open = /^<w:style\b[^>]*>/.exec(m[0])?.[0] || ''
    if (!/\bw:type="paragraph"/.test(open)) continue
    const id = decodeXmlEntities(/\bw:styleId="([^"]+)"/.exec(open)?.[1] || '')
    if (!id) continue
    const name = decodeXmlEntities(/<w:name\b[^>]*\bw:val="([^"]*)"/.exec(m[1])?.[1] || '').trim()
    const nm = /^heading\s*([1-6])$/i.exec(name)
    const outline = /<w:outlineLvl\b[^>]*\bw:val="(\d+)"/.exec(m[1])?.[1]
    const level = nm ? Number(nm[1])
      : outline != null ? Math.min(6, Number(outline) + 1)
        : headingLevelFromStyleId(id)
    if (level >= 1 && level <= 6) levels.set(id, level)
  }
  return { levels, bytes: raw.length }
}

/** 段落文本：去掉域代码（instrText），保留 tab/换行；其余标签丢弃。 */
function docxParagraphText(inner) {
  return decodeXmlEntities(
    String(inner)
      .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ).trim()
}

/** docx 正文：逐段落抽文本，标题段落前加 Markdown `#` 标记（供上层的推导阶梯识别）。 */
function docxText(buf, maxBytes) {
  const dir = readZipDirectory(buf)
  const { levels, bytes } = docxStyleLevels(dir, buf, maxBytes)
  const xml = readZipEntry(buf, dir.get('word/document.xml'), Math.max(1, maxBytes - bytes)).toString('utf8')
  const parts = []
  for (const m of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const inner = m[1]
    const styleId = decodeXmlEntities(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(inner)?.[1] || '')
    let level = styleId ? (levels.get(styleId) || headingLevelFromStyleId(styleId)) : 0
    if (!level) {
      const outline = /<w:outlineLvl\b[^>]*\bw:val="(\d+)"/.exec(inner)?.[1]
      if (outline != null) level = Math.min(6, Number(outline) + 1)
    }
    const text = docxParagraphText(inner)
    if (!text) continue
    parts.push(level ? `${'#'.repeat(level)} ${text}` : text)
  }
  // 非常规生成器可能把正文放在 <w:p> 之外：退回整体抽文本，不丢内容。
  if (!parts.length) return xmlToText(xml)
  return tidy(parts.join('\n'))
}

/** 幻灯片里的全部文本 run（按出现顺序）。 */
function pptxRuns(xml) {
  return [...String(xml).matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((m) => decodeXmlEntities(m[1]).trim())
    .filter(Boolean)
}

/** 标题占位符 `<p:ph type="title|ctrTitle">` 内的 run；副标题/subTitle 不算。 */
function pptxTitleRuns(xml) {
  for (const m of String(xml).matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
    if (!/<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/.test(m[0])) continue
    const runs = pptxRuns(m[0])
    if (runs.length) return runs
  }
  return []
}

function pptxText(buf, maxBytes) {
  const dir = readZipDirectory(buf)
  const slides = [...dir.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(/(\d+)\.xml$/.exec(a)?.[1] || 0)
      const nb = Number(/(\d+)\.xml$/.exec(b)?.[1] || 0)
      return na - nb
    })
  const parts = []
  let remaining = maxBytes
  for (const name of slides) {
    const raw = readZipEntry(buf, dir.get(name), remaining)
    remaining -= raw.length
    const xml = raw.toString('utf8')
    const titleRuns = pptxTitleRuns(xml)
    const runs = pptxRuns(xml)
    if (titleRuns.length) {
      parts.push(`# ${titleRuns.join(' ')}`)
      // 标题文本从正文 run 里移除，避免“标题—标题”式的重复摘要。
      for (const t of titleRuns) {
        const i = runs.indexOf(t)
        if (i >= 0) runs.splice(i, 1)
      }
    }
    if (runs.length) parts.push(runs.join('\n'))
  }
  return tidy(parts.join('\n\n'))
}

function xlsxText(buf, maxBytes) {
  const dir = readZipDirectory(buf)
  const sheets = []
  let remaining = maxBytes
  const wb = dir.get('xl/workbook.xml')
  if (wb) {
    const raw = readZipEntry(buf, wb, remaining)
    remaining -= raw.length
    const xml = raw.toString('utf8')
    for (const m of xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) {
      const name = decodeXmlEntities(m[1]).trim()
      if (name && !sheets.includes(name)) sheets.push(name)
    }
  }
  const strings = []
  const sst = dir.get('xl/sharedStrings.xml')
  if (sst) {
    const xml = readZipEntry(buf, sst, remaining).toString('utf8')
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const text = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((x) => decodeXmlEntities(x[1]))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) strings.push(text)
    }
  }
  const head = []
  if (sheets.length) head.push(`工作表：${sheets.slice(0, 20).join(' / ')}`)
  if (strings.length) head.push(`内容：${strings.slice(0, 120).join(' / ')}`)
  return tidy(head.join('\n'))
}

/**
 * 抽取 OOXML 正文。同步、无子进程；文件超过 `maxUncompressedBytes` 或 ZIP 太大
 * 时返回原因（不抛），因为单份坏文档不应让整次构建失败。
 * @param {string} absPath
 * @param {string} ext
 * @param {{maxChars?:number, maxUncompressedBytes?:number}} [opts]
 * @returns {{ok:true, text:string, truncated:boolean} | {ok:false, reason:string, error?:string}}
 */
export function extractOoxmlText(absPath, ext, { maxChars = 20000, maxUncompressedBytes = 16 * 1024 * 1024 } = {}) {
  const kind = String(ext).toLowerCase()
  if (!isOoxmlExt(kind)) return { ok: false, reason: 'unsupported' }
  let buf
  try {
    buf = fs.readFileSync(absPath)
  } catch (err) {
    return { ok: false, reason: 'read-error', error: err.message }
  }
  try {
    const text = kind === '.docx' ? docxText(buf, maxUncompressedBytes)
      : kind === '.pptx' ? pptxText(buf, maxUncompressedBytes)
        : xlsxText(buf, maxUncompressedBytes)
    if (!text) return { ok: false, reason: 'empty' }
    if (text.length > maxChars) return { ok: true, text: text.slice(0, maxChars), truncated: true }
    return { ok: true, text, truncated: false }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    return {
      ok: false,
      reason: code === 'too-large' ? 'too-large' : 'parse-error',
      error: err && err.message ? String(err.message) : String(err),
    }
  }
}

// ── PDF 文本层 ────────────────────────────────────────────────────────────

/** @type {string|null|undefined} undefined = 还没探测；null = 不可用 */
let cachedPdfToText

function pdfToTextCommand() {
  if (cachedPdfToText !== undefined) return cachedPdfToText
  const override = String(process.env.PONOS_PDFTOTEXT ?? '').trim()
  if (override === '0' || override.toLowerCase() === 'off' || override.toLowerCase() === 'none') {
    cachedPdfToText = null
    return null
  }
  const cmd = override || 'pdftotext'
  // ★ `pdftotext -v` 在 Poppler 4.00 上退出码是 99（版本信息按“错误”处理），
  //   所以不能用 status===0 判断可用；看输出里有没有版本串，0/99 都接受。
  const r = spawnSync(cmd, ['-v'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: childEnv() })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const ok = !r.error && /pdftotext/i.test(out) && (r.status === 0 || r.status === 99)
  cachedPdfToText = ok ? cmd : null
  return cachedPdfToText
}

/** spawnSync 的 error 在类型上是 Error，但运行时会带 code（ETIMEDOUT/ENOENT）。 */
function errorCode(err) {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
}

function normalizePdfText(raw) {
  return tidy(String(raw ?? '').replace(/\f/g, '\n\n'))
}

function finishPdfText(text, maxChars) {
  const clean = normalizePdfText(text)
  if (!clean) return { text: '', truncated: false }
  if (clean.length > maxChars) return { text: clean.slice(0, maxChars), truncated: true }
  return { text: clean, truncated: false }
}

function runPdfToText(cmd, abs, { maxPages, maxChars, timeoutMs }) {
  const r = spawnSync(cmd, ['-l', String(maxPages), '-enc', 'UTF-8', abs, '-'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: Math.max(16 * 1024 * 1024, maxChars * 4 + 1024 * 1024),
    windowsHide: true,
    env: childEnv(),
  })
  if (r.error) {
    const code = errorCode(r.error)
    const reason = code === 'ETIMEDOUT' ? 'budget' : code === 'ENOBUFS' ? 'too-large' : 'parse-error'
    return { reason, error: r.error.message }
  }
  if (r.status !== 0) {
    return { reason: 'parse-error', error: `pdftotext exit ${r.status}: ${String(r.stderr || '').slice(0, 200)}` }
  }
  const out = finishPdfText(r.stdout, maxChars)
  if (!out.text) return { reason: 'no-text-layer' }
  return { text: out.text, truncated: out.truncated }
}

// pypdf 批量脚本：stdin 读 JSON，stdout 一行一个 JSON（NDJSON）。绝不做 OCR。
const PYPdf_SCRIPT = [
  'import sys, json',
  '# -I 会忽略 PYTHONIOENCODING；在脚本内显式钉 UTF-8，避免 Windows 中文路径按 cp936 解码。',
  'try:',
  '    sys.stdin.reconfigure(encoding="utf-8")',
  '    sys.stdout.reconfigure(encoding="utf-8")',
  'except Exception:',
  '    pass',
  'try:',
  '    from pypdf import PdfReader',
  'except Exception as e:',
  '    print(json.dumps({"fatal": str(e)}), flush=True)',
  '    sys.exit(0)',
  'req = json.load(sys.stdin)',
  'pages = int(req.get("pages", 3))',
  'chars = int(req.get("chars", 20000))',
  'for p in req.get("paths", []):',
  '    try:',
  '        r = PdfReader(p)',
  '        n = min(len(r.pages), pages)',
  '        parts = []',
  '        for i in range(n):',
  '            try: parts.append(r.pages[i].extract_text() or "")',
  '            except Exception: parts.append("")',
  '        text = "\\n".join(parts)[:chars]',
  '        print(json.dumps({"path": p, "text": text}, ensure_ascii=False), flush=True)',
  '    except Exception as e:',
  '        print(json.dumps({"path": p, "error": str(e)[:200]}, ensure_ascii=False), flush=True)',
].join('\n')

function runPypdf(paths, { maxPages, maxChars, timeoutMs }) {
  const python = resolvePython()
  const r = spawnSync(python, ['-I', '-c', PYPdf_SCRIPT], {
    input: JSON.stringify({ paths, pages: maxPages, chars: maxChars }),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...childEnv(), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  /** @type {Map<string, any>} */
  const byPath = new Map()
  let fatal = ''
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row.fatal) { fatal = String(row.fatal); continue }
      if (row.path) byPath.set(String(row.path), row)
    } catch { /* 非 JSON 行（解释器告警）忽略 */ }
  }
  let reason = ''
  if (fatal) reason = /No module named/i.test(fatal) ? 'no-pypdf' : 'extractor-error'
  else if (r.error) reason = errorCode(r.error) === 'ETIMEDOUT' ? 'budget' : 'no-extractor'
  else if (r.status !== 0 && byPath.size === 0) {
    reason = /No module named/i.test(String(r.stderr || '')) ? 'no-pypdf' : 'no-extractor'
  }
  return { byPath, reason, error: fatal || (r.error ? r.error.message : '') }
}

/**
 * 为需要重抽的 PDF 预备正文。结果以 rel 为键，供 extractDocCard 使用。
 *
 * `injected` 是测试/调用方注入口：给定 `pdfText` 时完全不碰外部进程。
 * @param {{
 *   files: Array<any>,
 *   needs?: (f:any)=>boolean,
 *   config: any,
 *   injected?: {enabled?:boolean, pdfText?:Map<string,string>, pdfTruncated?:Map<string,boolean>, reasons?:Map<string,string>}|null,
 * }} opts
 * @returns {{
 *   enabled: boolean,
 *   pdfText: Map<string,string>,
 *   pdfTruncated: Map<string,boolean>,
 *   reasons: Map<string,string>,
 *   stats: {mode:string, candidates:number, extracted:number, empty:number, truncated:number, skipped:number, elapsedMs:number, error?:string},
 * }}
 */
export function preparePdfText({ files, needs, config, injected = null }) {
  const pdfText = new Map(injected?.pdfText || [])
  const pdfTruncated = new Map(injected?.pdfTruncated || [])
  const reasons = new Map(injected?.reasons || [])
  /** @type {{mode:string, candidates:number, extracted:number, empty:number, truncated:number, skipped:number, elapsedMs:number, error?:string}} */
  const stats = {
    mode: 'none', candidates: 0, extracted: pdfText.size, empty: 0, truncated: 0, skipped: 0, elapsedMs: 0,
  }
  if (injected?.enabled === false || config.docText === false) {
    return { enabled: false, pdfText, pdfTruncated, reasons, stats }
  }
  if (injected?.pdfText) {
    stats.mode = 'injected'
    stats.candidates = pdfText.size
    return { enabled: true, pdfText, pdfTruncated, reasons, stats }
  }

  const maxChars = Math.max(1000, Number(config.maxDocTextChars) || 20000)
  const maxPages = Math.max(1, Number(config.maxDocTextPages) || 5)
  const maxFiles = Math.max(1, Number(config.maxDocTextFiles) || 500)
  const maxExtractBytes = Math.max(1024, Number(config.maxDocExtractBytes) || 20 * 1024 * 1024)
  // 显式 0 表示不抽（测试/极端配置）；缺省或非法值退回 20 s，避免自定义 config
  // 忘了带这个字段时所有 PDF 永远记 budget。
  const rawBudget = Number(config.docTextBudgetMs)
  const budgetMs = config.docTextBudgetMs != null && Number.isFinite(rawBudget) && rawBudget >= 0
    ? rawBudget
    : 20_000
  const start = Date.now()

  /** @type {Array<any>} */
  const candidates = []
  for (const f of files) {
    if (f.kind !== 'doc' || String(f.ext).toLowerCase() !== '.pdf') continue
    if (needs && !needs(f)) continue
    if (f.size > maxExtractBytes) { reasons.set(f.rel, 'too-large'); continue }
    if (candidates.length >= maxFiles) { reasons.set(f.rel, 'file-cap'); continue }
    candidates.push(f)
  }
  stats.candidates = candidates.length
  if (!candidates.length) {
    stats.elapsedMs = Date.now() - start
    return { enabled: true, pdfText, pdfTruncated, reasons, stats }
  }
  if (!budgetMs) {
    for (const f of candidates) reasons.set(f.rel, 'budget')
    stats.skipped = candidates.length
    stats.elapsedMs = Date.now() - start
    return { enabled: true, pdfText, pdfTruncated, reasons, stats }
  }

  const cmd = pdfToTextCommand()
  if (cmd) {
    stats.mode = 'pdftotext'
    for (let i = 0; i < candidates.length; i++) {
      const f = candidates[i]
      const remaining = budgetMs - (Date.now() - start)
      if (remaining <= 50) {
        for (const rest of candidates.slice(i)) reasons.set(rest.rel, 'budget')
        break
      }
      const timeoutMs = Math.max(1000, Math.min(6000, remaining))
      const out = runPdfToText(cmd, f.abs, { maxPages, maxChars, timeoutMs })
      if (out.reason) { reasons.set(f.rel, out.reason); stats.skipped++; continue }
      pdfText.set(f.rel, out.text)
      if (out.truncated) { pdfTruncated.set(f.rel, true); stats.truncated++ }
      stats.extracted++
    }
  } else {
    stats.mode = 'pypdf'
    const remaining = budgetMs - (Date.now() - start)
    if (remaining <= 50) {
      for (const f of candidates) reasons.set(f.rel, 'budget')
      stats.skipped = candidates.length
      stats.elapsedMs = Date.now() - start
      return { enabled: true, pdfText, pdfTruncated, reasons, stats }
    }
    // 单进程批量：pypdf 启动贵、逐文件 spawn 会慢一个数量级。
    const timeoutMs = Math.max(1000, Math.min(30_000, remaining))
    const { byPath, reason, error } = runPypdf(candidates.map((f) => f.abs), { maxPages, maxChars, timeoutMs })
    for (const f of candidates) {
      const row = byPath.get(String(f.abs)) || byPath.get(path.resolve(f.abs))
      if (!row) {
        reasons.set(f.rel, reason || 'extractor-error')
        stats.skipped++
        continue
      }
      if (row.error) {
        reasons.set(f.rel, /encrypt|password/i.test(String(row.error)) ? 'encrypted' : 'parse-error')
        stats.skipped++
        continue
      }
      const out = finishPdfText(row.text, maxChars)
      if (!out.text) { reasons.set(f.rel, 'no-text-layer'); stats.skipped++; continue }
      pdfText.set(f.rel, out.text)
      if (out.truncated) { pdfTruncated.set(f.rel, true); stats.truncated++ }
      stats.extracted++
    }
    if (error) stats.error = error
  }

  // 预算耗尽时可能提前 break；用 reasons 反算，避免 skipped/empty 出现负数。
  stats.skipped = candidates.filter((f) => reasons.has(f.rel)).length
  stats.empty = Math.max(0, candidates.length - stats.extracted - stats.skipped)
  stats.elapsedMs = Date.now() - start
  return { enabled: true, pdfText, pdfTruncated, reasons, stats }
}
