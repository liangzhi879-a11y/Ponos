// 提问卡片（<!--ASK_USER...-->）载荷解析与文本剥离。
// 独立模块以便单元测试；bridge.mjs 与前端渲染层共用同一套语义。
// LLM 输出可能是 JS 对象字面量风格（键/中文值不带引号），严格 JSON.parse 会失败，
// 因此依次尝试严格 JSON → 容错解析。

export function isValidPayload(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.questions) && d.questions.length > 0
}

class TolerantParser {
  constructor(src) { this.s = src; this.i = 0 }
  atEnd() { return this.i >= this.s.length }
  skipWs() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++ }
  peek() { this.skipWs(); return this.s[this.i] }
  parseValue() {
    const c = this.peek()
    if (c === '{') return this.parseObject()
    if (c === '[') return this.parseArray()
    if (c === '"' || c === "'") return this.parseString()
    return this.parseBare()
  }
  parseObject() {
    this.i++
    const obj = {}
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
  parseArray() {
    this.i++
    const arr = []
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
  parseString() {
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
  parseBareKey() {
    let out = ''
    while (this.i < this.s.length) {
      const ch = this.s[this.i]
      if (ch === ':' || /\s/.test(ch)) break
      out += ch; this.i++
    }
    if (!out) throw new Error('empty key')
    return out
  }
  parseBare() {
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

export function parseAskUserPayload(src) {
  let text = String(src || '').trim()
  // 模型可能把载荷包在 markdown 代码围栏里（``` 或 ```json）——先剥掉再解析
  const fence = text.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/)
  if (fence) text = fence[1].trim()
  if (!text) return null
  try {
    const d = JSON.parse(text)
    if (isValidPayload(d)) return d
  } catch {}
  try {
    const p = new TolerantParser(text)
    const d = p.parseValue()
    p.skipWs()
    if (!p.atEnd()) throw new Error('trailing chars at ' + p.i)
    if (isValidPayload(d)) return d
  } catch {}
  return null
}

// 提取文本中所有 <!--ASK_USER...--> 卡片块。宽容匹配（允许 <!-- 与 ASK_USER 间有空白），
// 且总能剥离原始标记——解析失败也不把原始 HTML 转发给前端（由调用方带 raw 载荷兜底）。
// 载荷内若含 -->（如描述里出现箭头），按“首个以 } 或 ] 收尾的 -->”闭合判定，避免提前截断。
// 未闭合的半截标记（流式尚未写完）不提取，返回 clean 截断到标记起点，交由前端渲染层兜底。
// 返回 { blocks: [{ payloadText }], clean }
export function extractAskUserBlocks(text) {
  const blocks = []
  let clean = ''
  let pos = 0
  const startRe = /<!--\s*ASK_USER\b/g
  let sm
  while ((sm = startRe.exec(text)) !== null) {
    clean += text.slice(pos, sm.index)
    const bodyStart = sm.index + sm[0].length
    const closePositions = []
    let ci = text.indexOf('-->', bodyStart)
    while (ci !== -1) { closePositions.push(ci); ci = text.indexOf('-->', ci + 3) }
    if (closePositions.length === 0) {
      // 未闭合：半截标记（流式分片）——保留剩余文本，前端渲染层会截断到标记起点
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
