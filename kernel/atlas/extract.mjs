// kernel/atlas/extract.mjs —— 代码卡片抽取（确定性、无模型）
// ---------------------------------------------------------------------------
// 目的推导阶梯（spec §5.3）：
//   T1 文件头注释/模块 docstring → high
//   T2 package/README 元数据      → high/medium
//   T3 导出/导入结构（事实句）     → medium
//   T4 文档标题/首段（extract-doc.mjs）
//   T5 仅文件名（明确“未识别”）    → low / 空文件 none
//   T6 LLM 补全：P0 不实现（默认关闭）
// 不允许用文件名硬编一个看似合理的职责；confidence 必须如实反映证据强度。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { domainOf, layerInfo } from './config.mjs'

export function normalizeText(text) {
  return String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

export function hashText(text) {
  return 'sha256:' + crypto.createHash('sha256').update(normalizeText(text)).digest('hex')
}

const NOISE_LINE_RE = /^(?:copyright\b|spdx-license-identifier\b|licensed under\b|all rights reserved\b|@license\b|license:\s|see (?:the )?license\b|eslint[- ]|prettier[- ]|@ts-|jshint\b|global\s)/i
const DECOR_LINE_RE = /^[-=*_—–~]{3,}$/
// 许可证正文的特征句。**按段落判**而不是逐行判：BSD/Apache/GPL 的正文行大多
// 不以 Copyright/Licensed 开头，逐行清洗会把许可证当成职责（Chromium 的实测坑）。
// 只列“出现即说明这是许可证段落”的强特征，避免把正常描述里的 license 一词误杀。
const LICENSE_PARA_RE = new RegExp([
  'redistribution and use in source and binary forms',
  'permission is hereby granted',
  'permission to use, copy, modify',
  'this software is provided by the copyright holders',
  'the software is provided ["\']?as is',
  'use of this source code is governed by',
  'licensed under the',
  'apache license,?\\s*(?:version|v)?\\s*2\\.0',
  'gnu (?:lesser |library )?general public license',
  'mozilla public license',
  'eclipse public license',
  'source code form is subject to',
  'free software[\\s\\S]{0,120}(?:redistribute|license)',
  'redistribute it and/or modify',
  'you may obtain a copy of the license',
  'see the license for the specific language',
  'the above copyright notice and this permission notice',
  'neither the name of',
  'unencumbered software',
  'warranties of merchantability',
  'fitness for a particular purpose',
].join('|'), 'i')
const FILE_PREFIX_RE = /^[\w./\\-]+\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|py|go|rs|java|kt|kts|rb|php|swift|scala|sh|bash|zsh|ps1|sql|vue|svelte|lua|dart|ex|exs|erl|hs|clj|cljs|r)\s*(?:[—–-]{1,2}|:)\s*/i
const DATE_TASK_PREFIX_RE = /^(?:★\s*)?(?:20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|Task\s*\d+)\s*[:：—–-]\s*/i

// 行注释前缀按语言取。`#` 只给确实用 # 注释的语言，否则 C/C++ 的 `#include`
// 会被当成注释抽进职责（实测 Chromium 的 `.cc` 头部返回 `include "x.h"`）。
const HASH_COMMENT_EXT = new Set([
  '.py', '.sh', '.bash', '.zsh', '.ps1', '.rb', '.pl', '.r',
  '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.properties', '.mk',
])
const DASH_COMMENT_EXT = new Set(['.sql', '.lua', '.hs', '.elm'])
const SEMI_COMMENT_EXT = new Set(['.lisp', '.clj', '.cljs', '.asm', '.s'])
const PERCENT_COMMENT_EXT = new Set(['.tex', '.erl', '.hrl'])
const REM_COMMENT_EXT = new Set(['.bat', '.cmd'])

function lineCommentRe(ext) {
  const parts = ['\\/\\/']
  if (HASH_COMMENT_EXT.has(ext)) parts.push('#')
  if (DASH_COMMENT_EXT.has(ext)) parts.push('--')
  if (SEMI_COMMENT_EXT.has(ext)) parts.push(';')
  if (PERCENT_COMMENT_EXT.has(ext)) parts.push('%')
  if (REM_COMMENT_EXT.has(ext)) parts.push('REM\\b')
  return new RegExp(`^\\s*(?:${parts.join('|')})\\s?`, 'i')
}

function cleanParagraph(raw) {
  const kept = []
  for (const line of String(raw ?? '').split('\n')) {
    const t = line.trim()
    if (!t || DECOR_LINE_RE.test(t) || NOISE_LINE_RE.test(t)) continue
    kept.push(t)
  }
  let s = kept.join(' ')
  s = s.replace(FILE_PREFIX_RE, '')
  s = s.replace(DATE_TASK_PREFIX_RE, '')
  s = s.replace(/\s*[（(]\s*(?:Task|spec|docs\/)[^）)]*[）)]\s*/gi, ' ')
  s = s.replace(/^[#*\s]+/, '').replace(/[*\s]+$/, '')
  s = s.replace(/\s{2,}/g, ' ').trim()
  if (!s || /^(?:todo|fixme|note|description|summary)[:：]?$/i.test(s)) return ''
  return s.slice(0, 200)
}

/**
 * 取第一段**非许可证**注释作为职责。许可证块常与真实描述同处一个头部注释，
 * 只清洗首段会把整份 BSD 正文当职责（Chromium 98.5% 的 C++ 文件踩过）。
 * 因此逐段判：整段命中许可证特征就跳过，继续看下一段；全无有效段落返回 ''。
 */
function cleanPurpose(raw) {
  const paras = String(raw ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  for (const para of paras) {
    if (LICENSE_PARA_RE.test(para)) continue
    const s = cleanParagraph(para)
    if (s) return s
  }
  return ''
}

/**
 * 取文件顶部第一段注释。返回清洗后的文本；没有则返回 ''。
 * 行号与内容都不改写源文件；只读取前 3000 字符，避免为一张卡读整文件。
 */
export function extractHeaderPurpose(text, ext = '') {
  const src = normalizeText(text).slice(0, 3000)
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (/^#!/.test(lines[i] || '')) i++
  while (i < lines.length) {
    const l = lines[i].trim()
    if (/^(['"])(?:use strict|use client|use server)\1;?$/.test(l)) { i++; continue }
    if (/^Object\.defineProperty\(exports\b/.test(l)) { i++; continue }
    // TS 三斜线指令是编译器指令，不是职责说明（如 /// <reference types="vite/client" />）
    if (/^\/\/\/\s*<reference\b/.test(l)) { i++; continue }
    break
  }
  if (i >= lines.length) return ''

  const lowerExt = String(ext).toLowerCase()
  // Python 模块 docstring
  if (lowerExt === '.py') {
    const rest = lines.slice(i).join('\n')
    const m = /^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(rest)
    if (m) return cleanPurpose(m[1])
  }

  // /* ... */ 块注释（先判闭合再剥前导星号：` */` 去掉 `*/` 后只剩空格，
  // 否则会留下一个 `/` 甚至把后面的代码吞进职责）。
  if (/^\s*\/\*/.test(lines[i] || '')) {
    const buf = []
    let first = true
    for (; i < lines.length; i++) {
      let l = lines[i]
      const close = /\*\/\s*$/.test(l)
      if (close) l = l.replace(/\*\/\s*$/, '')
      if (first) { l = l.replace(/^\s*\/\*+\s?/, ''); first = false }
      else l = l.replace(/^\s*\*+\s?/, '')
      if (l.trim()) buf.push(l.trim())
      else if (buf.length) buf.push('')
      if (close) break
    }
    return cleanPurpose(buf.join('\n'))
  }

  // 行注释前缀按语言取：C/C++ 的 `#include` 不是注释，不能被 `#` 规则吞掉。
  const lineRe = lineCommentRe(lowerExt)
  if (lineRe && lineRe.test(lines[i] || '')) {
    const buf = []
    for (; i < lines.length; i++) {
      const l = lines[i]
      if (!l.trim()) {
        let j = i + 1
        while (j < lines.length && !lines[j].trim()) j++
        const licenseSoFar = LICENSE_PARA_RE.test(buf.join('\n'))
        if (j < lines.length && lineRe.test(lines[j]) && licenseSoFar) {
          buf.push('')
          i = j - 1
          continue
        }
        break
      }
      const m = l.match(lineRe)
      if (!m) break
      const body = l.replace(lineRe, '').replace(/^\s*\*+\s?/, '').trim()
      if (!body) { buf.push(''); continue }
      buf.push(body)
    }
    return cleanPurpose(buf.join('\n'))
  }
  return ''
}

function firstLineOf(text, index) {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++
  return n
}

// 注释替换成等长空白（保留换行），行号不漂移。
function blankComments(text, ext) {
  if (String(ext).toLowerCase() === '.py') {
    return text
      .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|\n)[ \t]*#[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
}

// ── 导出符号 ─────────────────────────────────────────────────────────────
const JS_EXPORT_PATTERNS = [
  /\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/gm,
  /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bmodule\.exports\s*=\s*\{([^}]*)\}/g,
  /\bexports\.([A-Za-z_$][\w$]*)\s*=/g,
]

function exportNamesFromList(list) {
  const out = []
  for (const part of list.split(',')) {
    const m = /\bas\s+([A-Za-z_$][\w$]*)/.exec(part)
    const name = (m ? m[1] : part.trim().split(/\s+/)[0]).replace(/[^\w$]/g, '')
    if (name && name !== 'default') out.push(name)
  }
  return out
}

export function extractExports(text, ext = '') {
  const lowerExt = String(ext).toLowerCase()
  const found = []
  const seen = new Set()
  const add = (name) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push(name)
  }

  if (lowerExt === '.py') {
    const src = blankComments(normalizeText(text), lowerExt)
    for (const m of src.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) add(m[1])
  } else if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'].includes(lowerExt)) {
    const src = blankComments(normalizeText(text), lowerExt)
    for (const re of JS_EXPORT_PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(src))) {
        if (m[1] && m[1] !== 'default') for (const n of exportNamesFromList(m[1])) add(n)
      }
    }
    for (const m of src.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+['"][^'"]+['"])?/g)) {
      for (const n of exportNamesFromList(m[1])) add(n)
    }
    if (/\bexport\s+(?:type\s+)?\*\s+from\s+['"]/.test(src)) add('*')
  } else {
    const src = blankComments(normalizeText(text), lowerExt)
    for (const m of src.matchAll(/^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|enum|struct|trait|func|function|def)\s+([A-Za-z_]\w*)/gm)) add(m[1])
    for (const m of src.matchAll(/^\s*pub\s+(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/gm)) add(m[1])
  }

  // TSX/JSX 组件名优先（大写开头），其余保持出现顺序
  if (['.tsx', '.jsx'].includes(lowerExt)) {
    found.sort((a, b) => {
      const au = /^[A-Z]/.test(a) ? 0 : 1
      const bu = /^[A-Z]/.test(b) ? 0 : 1
      return au - bu
    })
  }
  return found.slice(0, 8)
}

// ── import / require / #include / 路径引用 ────────────────────────────────
export const CPP_EXTS = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx', '.inl', '.ipp'])

// 只解析引号形式：`#include "…"` 才可能是仓内文件；`<vector>` 等尖括号一律视为
// 系统/第三方头（即使仓内恰好同名，也不猜）。
// `[ \t]` 而不是 `\s`：否则 `\s*` 会跨过被注释抹空的整行，把行号报成第一条注释。
const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]+"([^"\n]+)"/gm

export function extractIncludes(text, ext = '') {
  if (!CPP_EXTS.has(String(ext).toLowerCase())) return []
  // 必须先抹掉注释：`/* #include "old.h" */` 不是依赖。
  const src = blankComments(normalizeText(text), ext)
  const out = []
  const seen = new Set()
  for (const hit of matchesWithLines(src, INCLUDE_RE)) {
    const spec = String(hit.spec || '').trim()
    if (!spec) continue
    const key = spec + '\u0000' + hit.line
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ spec, line: hit.line, include: true })
  }
  return out
}

const IMPORT_RES = [
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bimport\s+(?:type\s+)?[\w*{}$,\s]+?\s+from\s+['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*import\s+([\w.]+)\s*$/gm,
]
const PATH_REF_RE = /['"`]([^'"`\n]*?\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|py|go|rs|java|kt|rb|php|swift|scala|sh|bash|zsh|ps1|sql|vue|svelte|md|mdx|html|json|ya?ml|toml))['"`]/g

function matchesWithLines(src, re) {
  const out = []
  re.lastIndex = 0
  let m
  while ((m = re.exec(src))) out.push({ spec: m[1], line: firstLineOf(src, m.index) })
  return out
}

export function extractImports(text, ext = '') {
  const src = blankComments(normalizeText(text), ext)
  const out = []
  const seen = new Set()
  for (const re of IMPORT_RES) {
    for (const hit of matchesWithLines(src, re)) {
      const key = hit.spec + '\u0000' + hit.line
      if (seen.has(key)) continue
      seen.add(key)
      out.push(hit)
    }
  }
  return out
}

export function extractPathRefs(text, ext = '') {
  const src = blankComments(normalizeText(text), ext)
  const out = []
  const seen = new Set()
  for (const hit of matchesWithLines(src, PATH_REF_RE)) {
    const lit = hit.spec
    if (!lit || /[*?<>]/.test(lit) || /^[a-z]+:\/\//i.test(lit)) continue
    const key = lit + '\u0000' + hit.line
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

const RESOLVE_SUFFIXES = [
  '', '.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.swift', '.scala',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.vue', '.svelte',
  '/index.ts', '/index.tsx', '/index.mts', '/index.mjs', '/index.cjs', '/index.js', '/index.jsx',
]

export function tryExt(base, fileSet) {
  const cands = [...RESOLVE_SUFFIXES.map((s) => base + s)]
  if (/\.js$/.test(base)) {
    cands.unshift(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'))
  }
  for (const c of cands) if (fileSet.has(c)) return c
  return null
}

/**
 * 解析 import specifier。
 * `workspace` 由 workspace.mjs 提供：把 monorepo 的裸包名（含子路径）映射到包内源文件。
 * 不传时保持原有行为（相对路径 / @ / ~ / Python 点号），外部包返回 null。
 */
export function resolveImport(fromRel, spec, fileSet, workspace = null) {
  if (!spec) return null
  if (spec.startsWith('@/')) return tryExt('src/' + spec.slice(2), fileSet)
  if (spec.startsWith('~/')) return tryExt(spec.slice(2), fileSet)
  if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
    return tryExt(base, fileSet)
  }
  if (/^\w[\w.]*$/.test(spec) && fromRel.endsWith('.py')) {
    return tryExt(path.posix.join(path.posix.dirname(fromRel), spec.replace(/\./g, '/')), fileSet)
  }
  if (workspace?.resolve) return workspace.resolve(spec, fileSet)
  return null
}

/**
 * 解析 C/C++ 的 `#include "…"`。顺序固定（与设计一致，不猜）：
 *   1. 工作区相对路径（`components/x/y.h`）
 *   2. 同目录相对路径（`"y.h"`）
 *   3. 索引内**唯一后缀**匹配（源根比工作区深一层时，`base/x.h` ↔ `src/base/x.h`）
 * 多处同名 = 歧义，返回 null 计入 unresolved；不按“看起来最像”硬连边。
 */
export function resolveInclude(fromRel, spec, fileSet, byBase) {
  if (!spec) return null
  const norm = String(spec).replace(/\\/g, '/').replace(/^\.\//, '')
  if (fileSet.has(norm)) return norm
  const sameDir = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), norm))
  if (fileSet.has(sameDir)) return sameDir
  const base = path.posix.basename(norm)
  const hits = (byBase.get(base) || [])
    .filter((p) => p === norm || p.endsWith('/' + norm))
  return hits.length === 1 ? hits[0] : null
}

/** 路径字面量解析：相对路径、仓根路径、唯一 basename 回退（与 arch-graph 同口径）。 */
export function resolvePathRef(fromRel, spec, fileSet, byBase) {
  if (!spec) return null
  if (spec.startsWith('.')) {
    const cand = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
    if (fileSet.has(cand)) return cand
    const ext = tryExt(cand, fileSet)
    if (ext) return ext
  }
  const rootRel = spec.replace(/^\.?\//, '')
  if (fileSet.has(rootRel)) return rootRel
  const ext = tryExt(rootRel, fileSet)
  if (ext) return ext
  const hits = byBase.get(path.posix.basename(spec)) || []
  if (hits.length === 1) return hits[0]
  return null
}

// ── 元数据提示（T2）─────────────────────────────────────────────────────
function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function cleanReadmeLine(line) {
  const s = String(line)
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return s.length >= 4 ? s.slice(0, 200) : ''
}

function collectExportPaths(value, out) {
  if (typeof value === 'string') { out.push(value); return }
  if (Array.isArray(value)) { for (const v of value) collectExportPaths(v, out); return }
  if (value && typeof value === 'object') for (const v of Object.values(value)) collectExportPaths(v, out)
}

/**
 * 从 package.json / pyproject.toml / README 建立 T2 提示。
 * 只做**事实引用**：包描述、入口声明、README 里逐字提到该文件的那一行。
 */
export function buildMetaHints(root, files) {
  const byPath = new Map()
  const entries = new Set()
  const relSet = new Set(files.map((f) => f.rel))

  const addEntry = (value, hint) => {
    if (typeof value !== 'string' || !value) return
    const rel = normalizeRel(value)
    if (!relSet.has(rel)) return
    entries.add(rel)
    if (!byPath.has(rel)) byPath.set(rel, hint)
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const name = typeof pkg.name === 'string' ? pkg.name.trim() : ''
    const desc = typeof pkg.description === 'string' ? pkg.description.trim() : ''
    if (desc) {
      byPath.set('package.json', { text: name ? `${name} — ${desc}` : desc, confidence: 'high' })
      const hint = { text: `${name ? name + ' ' : ''}入口：${desc}`, confidence: 'high' }
      addEntry(pkg.main, hint)
      addEntry(pkg.module, hint)
      addEntry(pkg.types, hint)
      if (typeof pkg.bin === 'string') addEntry(pkg.bin, hint)
      else if (pkg.bin && typeof pkg.bin === 'object') {
        for (const v of Object.values(pkg.bin)) addEntry(v, hint)
      }
      if (pkg.exports) {
        const paths = []
        collectExportPaths(pkg.exports, paths)
        for (const p of paths) addEntry(p, hint)
      }
    }
  } catch { /* 没有/坏了 package.json 不阻断 */ }

  try {
    const pyproject = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8')
    const m = /^\s*description\s*=\s*["']([^"']+)["']/m.exec(pyproject)
    if (m && m[1].trim()) byPath.set('pyproject.toml', { text: m[1].trim(), confidence: 'high' })
  } catch { /* optional */ }

  // README 只映射“唯一 basename”或完整路径，避免 index.ts 这类常见名互相串。
  const readme = files.find((f) => /^readme(?:\.(?:md|mdx|txt|rst))?$/i.test(f.rel) && f.text)
  if (readme) {
    const baseCount = new Map()
    for (const f of files) {
      const b = path.posix.basename(f.rel)
      baseCount.set(b, (baseCount.get(b) || 0) + 1)
    }
    const lines = normalizeText(readme.text).split('\n')
    for (const f of files) {
      if (byPath.has(f.rel)) continue
      const b = path.posix.basename(f.rel)
      if (baseCount.get(b) !== 1) continue
      const hit = lines.find((l) => l.includes(f.rel) || l.includes(b))
      if (!hit) continue
      const text = cleanReadmeLine(hit)
      if (text) byPath.set(f.rel, { text, confidence: 'medium' })
    }
  }

  return { byPath, entries }
}

function sizeTier(loc) {
  if (loc < 100) return 's'
  if (loc < 300) return 'm'
  if (loc < 1000) return 'l'
  return 'x'
}

function structurePurpose(exports, imports) {
  const parts = []
  if (exports.length) {
    const shown = exports.slice(0, 3)
    parts.push(`导出 ${shown.join('/')}${exports.length > shown.length ? ' 等' : ''}`)
  }
  if (imports.length) parts.push(`依赖 ${imports.length} 个模块`)
  return parts.join('；')
}

/**
 * 代码/测试卡片。`entry` 来自 scanWorkspace（含 text/stat）。
 * 返回的 importance 只是初值；graph.buildGraph 会按反向依赖重算。
 */
export function extractCodeCard({ entry, config, metaHints }) {
  const text = normalizeText(entry.text ?? '')
  const header = extractHeaderPurpose(text, entry.ext)
  const exports = text ? extractExports(text, entry.ext) : []
  const imports = text ? extractImports(text, entry.ext) : []
  // C/C++ 的 #include 与 import 同走 `imports` 数组（都产生 imports 边），
  // 用 include:true 标记，持久化时据此拆到独立分片。
  if (text) imports.push(...extractIncludes(text, entry.ext))
  const references = text ? extractPathRefs(text, entry.ext) : []

  let purpose = ''
  let purposeSrc = 'none'
  let confidence = 'none'
  if (header) {
    purpose = header
    purposeSrc = 'header'
    confidence = 'high'
  } else if (metaHints?.byPath?.has(entry.rel)) {
    const hint = metaHints.byPath.get(entry.rel)
    purpose = hint.text
    purposeSrc = 'metadata'
    confidence = hint.confidence
  } else if (exports.length || imports.length) {
    purpose = structurePurpose(exports, imports)
    purposeSrc = 'structure'
    confidence = 'medium'
  } else if (text.trim()) {
    purpose = `未识别职责：${path.posix.basename(entry.rel)}`
    purposeSrc = 'none'
    confidence = 'low'
  } else {
    purpose = null
    purposeSrc = 'none'
    confidence = 'none'
  }

  const loc = text ? text.split('\n').length : 0
  return {
    v: 1,
    id: `${entry.kind}:${entry.rel}`,
    kind: entry.kind,
    path: entry.rel,
    lang: entry.ext.replace(/^\./, ''),
    layer: layerInfo(entry.rel, config),
    domain: domainOf(entry.rel, config),
    loc,
    bytes: entry.size,
    sizeTier: sizeTier(loc),
    purpose,
    purposeSrc,
    confidence,
    exports,
    imports,
    references,
    flags: [
      ...(metaHints?.entries?.has(entry.rel) ? ['entry'] : []),
      ...(header ? ['header'] : []),
    ],
    importance: 1,
    content: true,
    sourceHash: hashText(text),
    mtimeMs: entry.mtimeMs,
    size: entry.size,
  }
}

/** 二进制/未知文件的路径卡：不伪造职责。 */
export function extractFileCard({ entry, config, metaHints }) {
  const hint = metaHints?.byPath?.get(entry.rel)
  const text = normalizeText(entry.text ?? '')
  let purpose = null
  let purposeSrc = 'none'
  let confidence = 'none'
  if (hint) {
    purpose = hint.text
    purposeSrc = 'metadata'
    confidence = hint.confidence
  } else if (text.trim()) {
    purpose = `未识别职责：${path.posix.basename(entry.rel)}`
    purposeSrc = 'none'
    confidence = 'low'
  }
  return {
    v: 1,
    id: `file:${entry.rel}`,
    kind: 'file',
    path: entry.rel,
    lang: entry.ext.replace(/^\./, ''),
    layer: layerInfo(entry.rel, config),
    domain: domainOf(entry.rel, config),
    loc: text ? text.split('\n').length : 0,
    bytes: entry.size,
    sizeTier: 's',
    purpose,
    purposeSrc,
    confidence,
    exports: [],
    imports: [],
    references: [],
    flags: [],
    importance: 1,
    content: entry.content,
    binary: entry.binary === true,
    sourceHash: text ? hashText(text) : null,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
  }
}
