// kernel/attribution-sources.mjs —— 三源事件抽取（P1 Task 2；设计 §4.1）
//
// 职责边界（**只抽取，不聚合**）：把三处异构证据变成同一种事件
//   { src: 'journal'|'log'|'transcript', at: ISO, fp: string|null, ref: string, snippet: string }
// 聚合（按 fp 分组、复发判定）在 `kernel/error-attribution.mjs`。
//
// 三条纪律：
//   · **读不到如实说**：目录/文件缺失或损坏 ⇒ 记一条 `skipped`，**不抛、不按 0 计**
//     （"没测到"≠"没问题"，同 OPP-11 的"没有实测不参与"纪律）；
//   · **只认固定形态**：日志只取固定前缀的错误行（console 噪音进了汇总就没有信噪比）；
//     转录只取 `tool_result.is_error === true`；
//   · **snippet 有上限**：它是给人核对用的**片段**，不进索引、不参与判定（≤ 200 字符）。
//
// 纯读：本模块不写任何文件、不起会话内核。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fingerprintOf } from './error-fingerprint.mjs'

const DAY_MS = 86400_000

/** snippet 上限（给人看的片段，不是原文存储） */
const SNIPPET_MAX = 200
/** 单次读取的行数上限（防超大文件把内存吃穿；超出按"最近 N 行"截断） */
const MAX_LINES_PER_FILE = 20000

/** journal 里算"事件"的 kind（其余是决策/预算/配方等旁路留痕，不参与归因） */
const JOURNAL_EVENT_KINDS = new Set(['detect', 'act', 'rollback'])

/** 渲染层日志的错误行固定前缀（@see electron/main.cjs 的 registerRendererErrorCapture） */
// 只认**固定前缀 / 固定标签**的错误行：`[render:…]` 带错误词、崩溃与加载失败、kernel 侧 stderr 的 Error 行。
// 反面教材：`auth-audit.log` 里全是 "fail" 字样，但它不是错误源（是审计），必须按**文件名白名单**排除。
// 硬命中：崩溃/加载失败这类关键字，行内不需要再有别的错误词
const LOG_HARD_RE = /(did-fail-load|render-process-gone|preload-error|unresponsive)/i
// 软命中：`[render:*]` 前缀或行首 Error/Uncaught/FATAL —— **还必须带错误词**，否则正常渲染日志会涌进来
const LOG_SOFT_RE = /(\[render[^\]]*\]|^\s*\[?\d{4}-\d{2}-\d{2}T[\d:.]+Z?\]?\s*(Error|Uncaught|FATAL)\b|^\s*(Error|Uncaught|FATAL)\b)/i
const LOG_ERROR_WORD_RE = /(失败|错误|error|failed|exception|ENOENT|EACCES|ETIMEDOUT|timeout|不再响应)/i
/** 允许的日志文件（白名单；不含 auth-audit.log 这类审计流） */
const LOG_FILE_ALLOW = /^(app|kernel-stderr|kernel-stdout|renderer-console|doctor|bridge)\.log(\.\d+)?$/i

/** 时间戳归一：统一输出 ISO；无法解析 ⇒ null（由调用方决定是否丢弃） */
function toIso(v) {
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  return null
}

const clip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX)

/** 目录存在且是目录 */
const isDir = (p) => { try { return existsSync(p) && statSync(p).isDirectory() } catch { return false } }

/** 逐行读文件（坏行跳过并计数）：返回 { lines: [{no, text}], bad: number } */
function readLinesSafe(file) {
  const out = []
  let bad = 0
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return { lines: out, bad: 1, unreadable: true } }
  const all = raw.split('\n')
  const start = Math.max(0, all.length - MAX_LINES_PER_FILE)
  for (let i = start; i < all.length; i++) {
    const text = all[i]
    if (!text || !text.trim()) continue
    try { JSON.parse(text) } catch { /* 解析在后面对具体源做；这里只记 raw 行 */ }
    out.push({ no: i + 1, text })
  }
  return { lines: out, bad, unreadable: false }
}

/** 事件构造器：统一五字段（snippet 截断、fp 由指纹模块算） */
function makeEvent({ src, at, text, ref }) {
  const iso = toIso(at)
  if (!iso) return null
  return { src, at: iso, fp: fingerprintOf(text), ref, snippet: clip(text) }
}

/**
 * journal 源：`<home>/journal/*.ndjson`（按天分文件，`at` 由写入侧落盘）。
 * @param {{ homeDir?: string, windowDays?: number, now?: number }} [opts]
 * @returns {{ events: Array<object>, skipped: Array<{src: string, reason: string}> }}
 */
export function collectJournalEvents({ homeDir, windowDays = 30, now = Date.now() } = {}) {
  const src = 'journal'
  const skipped = []
  const events = []
  const dir = join(String(homeDir || ''), 'journal')
  if (!isDir(dir)) return { events, skipped: [{ src, reason: 'dir-missing' }] }
  const cutoff = now - windowDays * DAY_MS

  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.ndjson')) } catch { return { events, skipped: [{ src, reason: 'dir-unreadable' }] } }
  if (files.length === 0) return { events, skipped: [{ src, reason: 'empty' }] }

  let badLines = 0
  for (const f of files) {
    const { lines, unreadable } = readLinesSafe(join(dir, f))
    if (unreadable) { skipped.push({ src, reason: `unreadable:${f}` }); continue }
    for (const { no, text } of lines) {
      let row
      try { row = JSON.parse(text) } catch { badLines++; continue }
      if (!row || typeof row !== 'object') { badLines++; continue }
      if (!JOURNAL_EVENT_KINDS.has(String(row.kind || ''))) continue
      // 【重要】`act` / `rollback` 行的 `detail` 是**探针描述**（如"数据目录可写"），不是错误文本
      // ⇒ 绝不能拿它现算 fp（会造出一堆假指纹组）。修复类事件只认写入侧显式落的 `fp`。
      const isFixRow = row.kind === 'act' || row.kind === 'rollback'
      const fp = isFixRow ? (typeof row.fp === 'string' && row.fp ? row.fp : null) : fingerprintOf(row.detail ?? '')
      const ev = makeEvent({ src, at: row.at, text: row.detail, ref: `${src}/${f}#${no}` })
      if (!ev) continue
      // 探针 id：归因侧靠它把"修复（act）"和"触发它的那次报错（detect）"对上
      // （doctor 必须自包含、不许 import kernel，所以指纹只能在读取侧现算）
      ev.probeId = typeof row.probeId === 'string' ? row.probeId : (typeof row.actionId === 'string' ? row.actionId : null)
      if (isFixRow) {
        ev.fp = fp
        ev.kind = String(row.kind)
        ev.actionId = typeof row.actionId === 'string' ? row.actionId : (typeof row.probeId === 'string' ? row.probeId : null)
        ev.ok = row.ok === true
        ev.verified = row?.extra?.verified === true || row?.verified === true
      }
      if (Date.parse(ev.at) < cutoff) continue
      events.push(ev)
    }
  }
  if (badLines > 0) skipped.push({ src, reason: `bad-lines:${badLines}` })
  return { events, skipped }
}

/**
 * 渲染层日志源：`<home>/logs/*.log`，只取固定前缀的错误行。
 * `at` 取**文件 mtime**（行内无时间戳）⇒ 同文件的错误共享同一时刻，精度到"天级窗口"足够。
 * @param {{ homeDir?: string, windowDays?: number, now?: number }} [opts]
 * @returns {{ events: Array<object>, skipped: Array<{src: string, reason: string}> }}
 */
export function collectLogEvents({ homeDir, windowDays = 30, now = Date.now() } = {}) {
  const src = 'log'
  const skipped = []
  const events = []
  const dir = join(String(homeDir || ''), 'logs')
  if (!isDir(dir)) return { events, skipped: [{ src, reason: 'dir-missing' }] }
  const cutoff = now - windowDays * DAY_MS

  let files = []
  try { files = readdirSync(dir).filter((f) => LOG_FILE_ALLOW.test(f)) } catch { return { events, skipped: [{ src, reason: 'dir-unreadable' }] } }
  if (files.length === 0) return { events, skipped: [{ src, reason: 'empty' }] }

  for (const f of files) {
    const abs = join(dir, f)
    let mtime = null
    try { mtime = statSync(abs).mtimeMs } catch { skipped.push({ src, reason: `stat-failed:${f}` }); continue }
    if (mtime < cutoff) continue                     // 整文件早于窗口 ⇒ 跳过（便宜且正确）
    let raw = ''
    try { raw = readFileSync(abs, 'utf8') } catch { skipped.push({ src, reason: `unreadable:${f}` }); continue }
    const lines = raw.split('\n')
    const start = Math.max(0, lines.length - MAX_LINES_PER_FILE)
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]
      // 判定：硬命中直接收；软命中（`[render:*]` / Error 行）必须再带错误词
      if (!LOG_HARD_RE.test(line)) {
        if (!LOG_SOFT_RE.test(line) || !LOG_ERROR_WORD_RE.test(line)) continue
      }
      // 行首有 ISO 时间戳就取它（比文件 mtime 准），没有才退回 mtime
      const m = /^\[?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]?/.exec(line)
      const at = m ? Date.parse(m[1]) : mtime
      const ev = makeEvent({ src, at: Number.isFinite(at) ? at : mtime, text: line, ref: `${src}/${f}#${i + 1}` })
      if (ev) events.push(ev)
    }
  }
  return { events, skipped }
}

/**
 * 转录源：`<configDir>/projects/<cwd-san>/<sessionId>.jsonl`，只取 `tool_result.is_error === true`。
 * `ref = <sessionId>#<行号>`（与候选 evidence 的 `seq` 同族，便于人工回跳）。
 * @param {{ configDir?: string, windowDays?: number, now?: number }} [opts]
 * @returns {{ events: Array<object>, skipped: Array<{src: string, reason: string}> }}
 */
export function collectTranscriptEvents({ configDir, windowDays = 30, now = Date.now() } = {}) {
  const src = 'transcript'
  const skipped = []
  const events = []
  const root = join(String(configDir || ''), 'projects')
  if (!isDir(root)) return { events, skipped: [{ src, reason: 'dir-missing' }] }
  const cutoff = now - windowDays * DAY_MS

  let projects = []
  try { projects = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {
    return { events, skipped: [{ src, reason: 'dir-unreadable' }] }
  }
  if (projects.length === 0) return { events, skipped: [{ src, reason: 'empty' }] }

  let badLines = 0
  for (const proj of projects) {
    const dir = join(root, proj)
    let files = []
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { skipped.push({ src, reason: `unreadable:${proj}` }); continue }
    for (const f of files) {
      const sessionId = f.replace(/\.jsonl$/, '')
      const { lines, unreadable } = readLinesSafe(join(dir, f))
      if (unreadable) { skipped.push({ src, reason: `unreadable:${proj}/${f}` }); continue }
      for (const { no, text } of lines) {
        let rec
        try { rec = JSON.parse(text) } catch { badLines++; continue }
        const at = rec?.timestamp ?? rec?.ts ?? rec?.at
        // 兼容两种载体：message.content / 顶层 content
        const content = rec?.message?.content ?? rec?.content
        if (!Array.isArray(content)) continue
        for (const part of content) {
          if (!part || part.type !== 'tool_result' || part.is_error !== true) continue
          const body = Array.isArray(part.content)
            ? part.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ')
            : String(part.content ?? '')
          const ev = makeEvent({ src, at, text: body, ref: `${sessionId}#${no}` })
          if (!ev) continue
          if (Date.parse(ev.at) < cutoff) continue
          events.push(ev)
        }
      }
    }
  }
  if (badLines > 0) skipped.push({ src, reason: `bad-lines:${badLines}` })
  return { events, skipped }
}

/**
 * 三源合并（**逐源 skipped 全部带出**：UI 必须能说"哪部分没读到"）。
 * @param {{ homeDir?: string, configDir?: string, windowDays?: number, now?: number }} [opts]
 * @returns {{ events: Array<object>, skipped: Array<{src: string, reason: string}> }}
 */
export function collectAllEvents({ homeDir, configDir, windowDays = 30, now = Date.now() } = {}) {
  const parts = [
    collectJournalEvents({ homeDir, windowDays, now }),
    collectLogEvents({ homeDir, windowDays, now }),
    collectTranscriptEvents({ configDir: configDir ?? homeDir, windowDays, now }),
  ]
  return {
    events: parts.flatMap((p) => p.events),
    skipped: parts.flatMap((p) => p.skipped),
  }
}
