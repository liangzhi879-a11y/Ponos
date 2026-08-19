// 前端容错解析 <!--ASK_USER...--> 提问卡片载荷。
// 与 server/bridge.mjs 的 TolerantParser 语义对齐（跨运行时无法共享代码，这里保留
// 一份轻量实现）：LLM 输出可能是 JS 对象字面量风格（键/中文值不带引号），严格
// JSON.parse 会失败，依次尝试严格 JSON → 容错解析。
import type { QuestionPayload } from '@/types'

function isValidPayload(d: unknown): d is Record<string, unknown> {
  return (
    !!d && typeof d === 'object' && !Array.isArray(d) &&
    Array.isArray((d as any).questions) && (d as any).questions.length > 0
  )
}

// 归一化：字段类型兜底（header/description 缺失、options 为空等都不允许穿透到渲染层）
function normalize(d: unknown): QuestionPayload | null {
  if (!isValidPayload(d)) return null
  const raw = d as Record<string, any>
  const qs: any[] = Array.isArray(raw.questions) ? raw.questions : []
  return {
    context: typeof raw.context === 'string' ? raw.context : '',
    questions: qs.slice(0, 10).map((q: any, i: number) => ({
      id: typeof q?.id === 'string' && q.id ? q.id : 'q' + (i + 1),
      header: typeof q?.header === 'string' ? q.header : '提问',
      question: typeof q?.question === 'string' ? q.question : '',
      options: Array.isArray(q?.options)
        ? q.options
            .map((o: any) => ({
              label: typeof o?.label === 'string' ? o.label : String(o ?? '').trim(),
              description: typeof o?.description === 'string' ? o.description : '',
            }))
            .filter((o: { label: string }) => o.label.length > 0)
        : [],
      multiSelect: !!q?.multiSelect,
    })),
  }
}

class TolerantParser {
  s: string
  i = 0
  constructor(src: string) { this.s = src; this.i = 0 }
  atEnd() { return this.i >= this.s.length }
  skipWs() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++ }
  peek() { this.skipWs(); return this.s[this.i] }
  parseValue(): unknown {
    const c = this.peek()
    if (c === '{') return this.parseObject()
    if (c === '[') return this.parseArray()
    if (c === '"' || c === "'") return this.parseString()
    return this.parseBare()
  }
  parseObject(): Record<string, unknown> {
    this.i++
    const obj: Record<string, unknown> = {}
    for (;;) {
      this.skipWs()
      if (this.s[this.i] === '}') { this.i++; return obj }
      const c = this.s[this.i]
      const key = (c === '"' || c === "'") ? this.parseString() : this.parseBareKey()
      this.skipWs()
      if (this.s[this.i] === ':') this.i++
      this.skipWs()
      obj[key] = this.parseValue()
      this.skipWs()
      if (this.s[this.i] === ',') { this.i++; continue }
      if (this.s[this.i] === '}') { this.i++; return obj }
      throw new Error('object: expected , or } at ' + this.i)
    }
  }
  parseArray(): unknown[] {
    this.i++
    const arr: unknown[] = []
    for (;;) {
      this.skipWs()
      if (this.s[this.i] === ']') { this.i++; return arr }
      arr.push(this.parseValue())
      this.skipWs()
      if (this.s[this.i] === ',') { this.i++; continue }
      if (this.s[this.i] === ']') { this.i++; return arr }
      throw new Error('array: expected , or ] at ' + this.i)
    }
  }
  parseString(): string {
    const q = this.s[this.i++]
    let out = ''
    while (this.i < this.s.length) {
      const ch = this.s[this.i++]
      if (ch === '\\') { out += this.s[this.i++] || ''; continue }
      if (ch === q) return out
      out += ch
    }
    throw new Error('unterminated string')
  }
  parseBareKey(): string {
    let out = ''
    while (this.i < this.s.length) {
      const ch = this.s[this.i]
      if (ch === ':' || /\s/.test(ch)) break
      out += ch; this.i++
    }
    if (!out) throw new Error('empty key')
    return out
  }
  parseBare(): unknown {
    let out = ''
    while (this.i < this.s.length) {
      const ch = this.s[this.i]
      if (ch === ',' || ch === '}' || ch === ']') break
      out += ch; this.i++
    }
    const v = out.trim()
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null' || v === '') return null
    return v
  }
}

export function parseAskUserPayload(src: string): QuestionPayload | null {
  let text = String(src || '').trim()
  // 模型可能把载荷包在 markdown 代码围栏里——先剥掉再解析
  const fence = text.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/)
  if (fence) text = fence[1].trim()
  if (!text) return null
  try {
    const d = JSON.parse(text)
    if (isValidPayload(d)) return normalize(d)
  } catch {}
  try {
    const p = new TolerantParser(text)
    const d = p.parseValue()
    p.skipWs()
    if (!p.atEnd()) throw new Error('trailing chars at ' + p.i)
    if (isValidPayload(d)) return normalize(d)
  } catch {}
  return null
}

export interface AskUserBlock { payloadText: string }

export interface AskUserExtract { blocks: AskUserBlock[]; clean: string }

// 提取文本中所有 <!--ASK_USER...--> 块并剥离（与 bridge 同语义，渲染层兜底用）。
// 未闭合的半截标记（流式分片）保留在 clean 中，渲染层另行截断到标记起点。
export function extractAskUserBlocks(text: string): AskUserExtract {
  const blocks: AskUserBlock[] = []
  let clean = ''
  let pos = 0
  const startRe = /<!--\s*ASK_USER\b/g
  let sm: RegExpExecArray | null
  while ((sm = startRe.exec(text)) !== null) {
    clean += text.slice(pos, sm.index)
    const bodyStart = sm.index + sm[0].length
    const closePositions: number[] = []
    let ci = text.indexOf('-->', bodyStart)
    while (ci !== -1) { closePositions.push(ci); ci = text.indexOf('-->', ci + 3) }
    if (closePositions.length === 0) {
      clean += text.slice(sm.index)
      pos = text.length
      break
    }
    let close = closePositions[0]
    for (const c of closePositions) {
      const cand = text.slice(bodyStart, c).trim()
      if (cand.endsWith('}') || cand.endsWith(']')) { close = c; break }
    }
    blocks.push({ payloadText: text.slice(bodyStart, close).trim() })
    pos = close + 3
    startRe.lastIndex = pos
  }
  clean += text.slice(pos)
  return { blocks, clean }
}

// 渲染用：把文本中残留的 <!--ASK_USER...--> 块解析为卡片列表。
// 解析失败的块也返回（payloadText 非空），由渲染层降级为“原始内容展示卡”。
export function extractAskUserCards(text: string): { cards: (QuestionPayload & { raw?: string })[]; clean: string } {
  const { blocks, clean } = extractAskUserBlocks(text)
  const cards: (QuestionPayload & { raw?: string })[] = []
  for (const b of blocks) {
    const parsed = parseAskUserPayload(b.payloadText)
    if (parsed) {
      cards.push(parsed)
    } else {
      cards.push({ questions: [], context: '', raw: b.payloadText })
    }
  }
  return { cards, clean }
}
