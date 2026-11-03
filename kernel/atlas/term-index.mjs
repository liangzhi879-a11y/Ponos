// kernel/atlas/term-index.mjs —— 构建期词项索引（分片二进制 + 增量段）
// ---------------------------------------------------------------------------
// 目标：无作用域地回答问题“这个符号/这句话在哪些文件里”，而不是每次把
// 187k 个文件重读一遍。索引只存**哈希**（tokenHash + pathHash），不落正文：
//   · 隐私：文档正文（尤其 PDF）不复制进缓存；
//   · 成本：postings 按 tokenHash 分 16 片，查询只读命中的 1–3 片；
//   · 增量：每次构建只为**本次重抽的文件**追加一个段，旧段继续服务未变文件；
//     变更文件留下的陈旧 postings 不删——候选集只多不少，最终由“读源文件逐行核对”
//     过滤（宁多勿漏）。
//
// 段格式（每个 shard 一个文件）：
//   magic 'PAT1' | version u32 | tokenCount u32 | postingsBytes u32
//   directory: tokenCount × (tokenHash u32, offset u32, length u32) —— 按 tokenHash 升序
//   postings : 每个 token 一段 LEB128：首个 pathHash 绝对值，之后递增差分
//
// 哈希碰撞（token 或 path 的 32 位碰撞）只产生额外候选，不会漏；候选人选最终
// 必须回到源文件核对，因此索引永远不被当作“命中事实”。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const MAGIC = 'PAT1'
const VERSION = 1
// 词项生成规则（分词/词干/内部拼接）的世代号。改了规则必须 +1：
// store 会据此强制全量重建，否则未变文件仍带着旧规则的 postings ⇒ 静默漏检。
export const TERM_INDEX_VERSION = 1
const SHARDS = 16
const HEADER_BYTES = 16
const DIR_ENTRY_BYTES = 12
const FLUSH_BYTES = 1024 * 1024

// 语言关键字与英文高频词：不是“语义停用词”，而是**postings 会大到无信息量**的词。
// 真的需要搜它们时，v1 的逐文件扫描仍可用（索引只是加速层）。
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were', 'has', 'have',
  'not', 'but', 'you', 'your', 'can', 'will', 'all', 'any', 'our', 'its', 'their', 'which',
  'function', 'return', 'const', 'let', 'var', 'class', 'public', 'private', 'protected',
  'static', 'void', 'bool', 'true', 'false', 'null', 'undefined', 'import', 'export',
  'include', 'using', 'namespace', 'string', 'number', 'object', 'type', 'interface',
  'define', 'struct', 'enum', 'typedef', 'sizeof', 'else', 'while', 'switch', 'case',
])

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g
const CJK_RE = /[㐀-鿿]+/g
const CAMEL_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g

/** 32 位 FNV-1a；对路径与 token 都用同一实现，避免两套口径。 */
export function hash32(value) {
  let h = 0x811c9dc5
  const s = String(value)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff
    // 高位字节也参与，避免非 ASCII 只按低 8 位碰撞
    h ^= (s.charCodeAt(i) >>> 8) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function pathHash(rel) {
  return hash32(String(rel).replace(/\\/g, '/'))
}

function camelParts(ident) {
  const out = []
  for (const m of ident.matchAll(CAMEL_RE)) {
    if (m[0].length >= 2) out.push(m[0])
  }
  return out
}

/**
 * 轻量词干：只为“字面量子串”对齐，不做语义归一。
 *
 * v1 检索是**大小写不敏感的子串**匹配，而索引按词项召回；如果不处理
 * `cancel` / `CANCELLED` / `cancellation`、`download` / `downloads` 这类
 * 屈折变化，索引就会静默漏检。规则刻意保守：剥常见后缀，并同时留下
 * “还原 e”（created → create）与“叠尾辅音收敛”（cancelled → cancel）两条路径。
 * 词干只会多召回候选，最终仍由逐行核对过滤。
 */
function stemsOf(t) {
  if (t.length < 4 || !/[a-z]/.test(t)) return []
  const out = []
  let s = null
  if (t.endsWith('ies') && t.length > 4) s = t.slice(0, -3) + 'y'
  else if (t.endsWith('ing') && t.length > 5) s = t.slice(0, -3)
  else if (t.endsWith('ed') && t.length > 4) {
    const base = t.slice(0, -2)
    out.push(base)
    if (!base.endsWith('e')) out.push(base + 'e')
  } else if (t.endsWith('ation') && t.length > 6) s = t.slice(0, -5)
  else if (t.endsWith('able') && t.length > 6) s = t.slice(0, -4)
  else if (t.endsWith('ible') && t.length > 6) s = t.slice(0, -4)
  else if (t.endsWith('ers') && t.length > 5) s = t.slice(0, -1)
  else if (t.endsWith('er') && t.length > 4) s = t.slice(0, -2)
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) s = t.slice(0, -1)
  if (s) out.push(s)
  const collapsed = out.map((v) => (
    v.length > 3 && v[v.length - 1] === v[v.length - 2] && /[b-df-hj-np-tv-z]/.test(v[v.length - 1])
      ? v.slice(0, -1)
      : v
  ))
  return [...new Set([...out, ...collapsed])].filter((v) => v.length >= 2 && v !== t)
}

function addToken(out, lower) {
  if (lower.length < 2 || STOP.has(lower)) return
  out.add(lower)
  for (const stem of stemsOf(lower)) if (!STOP.has(stem)) out.add(stem)
}

function addCjk(out, run) {
  if (run.length === 1) { out.add(run); return }
  for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
}

/** 一个标识符的“基础词项”：全串 + 驼峰段 + 下划线段（不含内部拼接）。查询端用这组。 */
function identifierBase(raw, out) {
  const full = raw.toLowerCase()
  addToken(out, full)
  for (const seg of raw.split(/_+/)) {
    if (seg.length < 2) continue
    const parts = camelParts(seg)
    if (parts.length === 1) addToken(out, seg.toLowerCase())
    for (const part of parts) addToken(out, part.toLowerCase())
  }
}

/**
 * 内部连续拼接（仅索引端）：`MockDownloadItemImpl` 额外产出
 * `MockDownload`、`MockDownloadItem`、`DownloadItem`、`DownloadItemImpl`、`ItemImpl`。
 * 这样查询 `DownloadItem`（词项完整）能命中任何包着它的复合标识符；
 * 查询端**不做**这一步——否则会要求文件也索引任意中段拼接，反而漏检。
 * 段数很少（一般 ≤4），复杂度可忽略。
 */
function addInnerJoins(parts, sep, out) {
  if (parts.length < 2) return
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 2; j <= parts.length; j++) {
      addToken(out, parts.slice(i, j).join(sep).toLowerCase())
    }
  }
}

function identifierWithJoins(raw, out) {
  identifierBase(raw, out)
  for (const seg of raw.split(/_+/)) {
    if (seg.length < 2) continue
    const parts = camelParts(seg)
    if (parts.length >= 2) addInnerJoins(parts, '', out)
  }
  const segs = raw.split(/_+/).filter((s) => s.length >= 2)
  if (segs.length >= 2) addInnerJoins(segs, '_', out)
}

function cjkTokens(text, out) {
  for (const m of String(text ?? '').matchAll(CJK_RE)) addCjk(out, m[0])
}

/** 查询端词项：标识符全串 + 驼峰/下划线段 + CJK bigram；与索引端共享同一套词干。 */
export function queryTokens(text) {
  const out = new Set()
  const s = String(text ?? '')
  for (const m of s.matchAll(IDENT_RE)) {
    if (m[0].length >= 2) identifierBase(m[0], out)
  }
  cjkTokens(s, out)
  return [...out]
}

/**
 * 索引端词项：查询端词项 + 复合标识符的内部连续拼接。
 * @param {string} text
 * @returns {string[]}
 */
export function indexTokens(text) {
  const out = new Set()
  const s = String(text ?? '')
  for (const m of s.matchAll(IDENT_RE)) {
    if (m[0].length >= 2) identifierWithJoins(m[0], out)
  }
  cjkTokens(s, out)
  return [...out]
}

function writeU32(buf, off, v) {
  buf.writeUInt32LE(v >>> 0, off)
}

function readU32(buf, off) {
  return buf.readUInt32LE(off)
}

function varintSize(n) {
  let size = 1
  let v = n >>> 0
  while (v >= 0x80) { v >>>= 7; size++ }
  return size
}

function writeVarint(buf, off, n) {
  let v = n >>> 0
  while (v >= 0x80) {
    buf[off++] = (v & 0x7f) | 0x80
    v >>>= 7
  }
  buf[off++] = v
  return off
}

function readVarint(buf, off) {
  let v = 0
  let shift = 0
  for (;;) {
    const b = buf[off++]
    v |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
    if (shift > 35) break
  }
  return { value: v >>> 0, next: off }
}

/**
 * 段写入器：`addText(rel, text)` 按文件添加；`finish()` 写出 16 个 shard。
 * 临时 part 文件与产物都在 `<cacheDir>/terms/<buildId>/`。
 */
export function createSegmentWriter({ cacheDir, buildId }) {
  const root = path.join(cacheDir, 'terms', buildId)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  const buffers = Array.from({ length: SHARDS }, () => Buffer.allocUnsafe(FLUSH_BYTES))
  const used = new Array(SHARDS).fill(0)
  const partPaths = Array.from({ length: SHARDS }, (_, i) => path.join(root, `part-${i}.tmp`))
  const files = new Set()
  let postings = 0

  const flush = (shard, all = false) => {
    if (!used[shard]) return
    fs.appendFileSync(partPaths[shard], buffers[shard].subarray(0, used[shard]))
    used[shard] = 0
    if (all) buffers[shard] = Buffer.allocUnsafe(FLUSH_BYTES)
  }

  /** 一个文件：只添加本次**重抽**的文件（未变文件由旧段覆盖）。 */
  const addText = (rel, text) => {
    if (!text) return false
    const ph = pathHash(rel)
    const tokens = indexTokens(text)
    if (!tokens.length) return false
    files.add(ph)
    for (const tok of tokens) {
      const th = hash32(tok)
      const shard = th % SHARDS
      if (used[shard] + 8 > FLUSH_BYTES) flush(shard)
      let off = used[shard]
      writeU32(buffers[shard], off, th); off += 4
      writeU32(buffers[shard], off, ph); off += 4
      used[shard] = off
      postings++
    }
    return true
  }

  const finish = () => {
    for (let i = 0; i < SHARDS; i++) flush(i, true)
    let tokenCount = 0
    let bytes = 0
    for (let shard = 0; shard < SHARDS; shard++) {
      const part = partPaths[shard]
      const size = fs.existsSync(part) ? fs.statSync(part).size : 0
      const byToken = new Map()
      if (size) {
        const raw = fs.readFileSync(part)
        for (let off = 0; off + 8 <= raw.length; off += 8) {
          const th = readU32(raw, off)
          const ph = readU32(raw, off + 4)
          let list = byToken.get(th)
          if (!list) { list = []; byToken.set(th, list) }
          list.push(ph)
        }
      }
      const keys = [...byToken.keys()].sort((a, b) => a - b)
      const encoded = keys.map((th) => {
        const list = byToken.get(th)
        list.sort((a, b) => a - b)
        const uniq = []
        let prev = 0
        for (const ph of list) {
          if (!uniq.length || ph !== prev) uniq.push(ph)
          prev = ph
        }
        let len = 0
        for (let i = 0; i < uniq.length; i++) {
          const delta = i === 0 ? uniq[i] : (uniq[i] - uniq[i - 1]) >>> 0
          len += varintSize(delta)
        }
        const buf = Buffer.allocUnsafe(len)
        let off = 0
        for (let i = 0; i < uniq.length; i++) {
          const delta = i === 0 ? uniq[i] : (uniq[i] - uniq[i - 1]) >>> 0
          off = writeVarint(buf, off, delta)
        }
        return { th, buf }
      })
      const postingsBytes = encoded.reduce((a, e) => a + e.buf.length, 0)
      const header = Buffer.allocUnsafe(HEADER_BYTES)
      header.write(MAGIC, 0, 'ascii')
      writeU32(header, 4, VERSION)
      writeU32(header, 8, encoded.length)
      writeU32(header, 12, postingsBytes)
      const dir = Buffer.allocUnsafe(encoded.length * DIR_ENTRY_BYTES)
      let offset = 0
      encoded.forEach((e, i) => {
        writeU32(dir, i * DIR_ENTRY_BYTES, e.th)
        writeU32(dir, i * DIR_ENTRY_BYTES + 4, offset)
        writeU32(dir, i * DIR_ENTRY_BYTES + 8, e.buf.length)
        offset += e.buf.length
      })
      const out = Buffer.concat([header, dir, ...encoded.map((e) => e.buf)])
      fs.writeFileSync(path.join(root, `shard-${shard}.bin`), out)
      fs.rmSync(part, { force: true })
      tokenCount += encoded.length
      bytes += out.length
    }
    return {
      id: buildId,
      shards: SHARDS,
      files: files.size,
      tokens: tokenCount,
      postings,
      bytes,
      createdAt: new Date().toISOString(),
    }
  }

  return { addText, finish, root }
}

const shardCache = new Map()

function loadShard(file) {
  let st
  try { st = fs.statSync(file) } catch { return null }
  const key = `${file}:${st.mtimeMs}:${st.size}`
  const hit = shardCache.get(key)
  if (hit) return hit
  let buf
  try { buf = fs.readFileSync(file) } catch { return null }
  const shard = { buf, file }
  shardCache.set(key, shard)
  while (shardCache.size > 8) shardCache.delete(shardCache.keys().next().value)
  return shard
}

function decodePostings(shard, offset, length) {
  const out = []
  const end = offset + length
  let at = offset
  let prev = 0
  while (at < end) {
    const r = readVarint(shard.buf, at)
    at = r.next
    prev = out.length === 0 ? r.value : (prev + r.value) >>> 0
    out.push(prev)
  }
  return out
}

function lookupToken(shard, tokenHash) {
  const buf = shard.buf
  if (buf.length < HEADER_BYTES || buf.toString('ascii', 0, 4) !== MAGIC) return null
  if (readU32(buf, 4) !== VERSION) return null
  const count = readU32(buf, 8)
  let lo = 0
  let hi = count - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const base = HEADER_BYTES + mid * DIR_ENTRY_BYTES
    const th = readU32(buf, base)
    if (th === tokenHash) {
      const offset = readU32(buf, base + 4)
      const length = readU32(buf, base + 8)
      return decodePostings(shard, HEADER_BYTES + count * DIR_ENTRY_BYTES + offset, length)
    }
    if (th < tokenHash) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

function intersectSorted(a, b) {
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(a[i]); i++; j++ }
    else if (a[i] < b[j]) i++
    else j++
  }
  return out
}

/**
 * 查候选（pathHash 集合）。返回 null 表示没有可用索引（调用方回退到逐文件扫描）；
 * 返回空数组表示索引明确回答“没有”。
 * @param {{cacheDir:string, segments:any[], tokens:string[]}} opts
 */
export function findCandidates({ cacheDir, segments, tokens }) {
  if (!Array.isArray(segments) || !segments.length) return null
  const hashes = [...new Set((tokens || []).map((t) => hash32(t)))]
  if (!hashes.length) return null
  const all = new Set()
  for (const seg of segments) {
    let acc = null
    for (const th of hashes) {
      const shard = loadShard(path.join(cacheDir, 'terms', seg.id, `shard-${th % SHARDS}.bin`))
      if (!shard) continue
      const postings = lookupToken(shard, th)
      if (!postings) { acc = []; break }
      acc = acc == null ? postings : intersectSorted(acc, postings)
      if (!acc.length) break
    }
    for (const ph of acc || []) all.add(ph)
  }
  return [...all]
}

/** 段合并：把多个段的 postings 并成一个新段（候选集是并集，陈旧项自然保留）。 */
export function compactSegments({ cacheDir, segments, buildId }) {
  if (!Array.isArray(segments) || segments.length < 2) return null
  const root = path.join(cacheDir, 'terms', buildId)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  for (let shardIdx = 0; shardIdx < SHARDS; shardIdx++) {
    const byToken = new Map()
    for (const seg of segments) {
      const shard = loadShard(path.join(cacheDir, 'terms', seg.id, `shard-${shardIdx}.bin`))
      if (!shard) continue
      const buf = shard.buf
      const count = readU32(buf, 8)
      for (let i = 0; i < count; i++) {
        const base = HEADER_BYTES + i * DIR_ENTRY_BYTES
        const th = readU32(buf, base)
        const offset = readU32(buf, base + 4)
        const length = readU32(buf, base + 8)
        const list = decodePostings(shard, HEADER_BYTES + count * DIR_ENTRY_BYTES + offset, length)
        let acc = byToken.get(th)
        if (!acc) { acc = new Set(); byToken.set(th, acc) }
        for (const ph of list) acc.add(ph)
      }
    }
    const keys = [...byToken.keys()].sort((a, b) => a - b)
    const encoded = keys.map((th) => {
      const list = [...byToken.get(th)].sort((a, b) => a - b)
      let len = 0
      for (let i = 0; i < list.length; i++) {
        len += varintSize(i === 0 ? list[i] : (list[i] - list[i - 1]) >>> 0)
      }
      const buf = Buffer.allocUnsafe(len)
      let off = 0
      for (let i = 0; i < list.length; i++) {
        off = writeVarint(buf, off, i === 0 ? list[i] : (list[i] - list[i - 1]) >>> 0)
      }
      return { th, buf }
    })
    const postingsBytes = encoded.reduce((a, e) => a + e.buf.length, 0)
    const header = Buffer.allocUnsafe(HEADER_BYTES)
    header.write(MAGIC, 0, 'ascii')
    writeU32(header, 4, VERSION)
    writeU32(header, 8, encoded.length)
    writeU32(header, 12, postingsBytes)
    const dir = Buffer.allocUnsafe(encoded.length * DIR_ENTRY_BYTES)
    let offset = 0
    encoded.forEach((e, i) => {
      writeU32(dir, i * DIR_ENTRY_BYTES, e.th)
      writeU32(dir, i * DIR_ENTRY_BYTES + 4, offset)
      writeU32(dir, i * DIR_ENTRY_BYTES + 8, e.buf.length)
      offset += e.buf.length
    })
    fs.writeFileSync(path.join(root, `shard-${shardIdx}.bin`), Buffer.concat([header, dir, ...encoded.map((e) => e.buf)]))
  }
  return { id: buildId, shards: SHARDS, files: null, tokens: null, postings: null, bytes: null, compactedFrom: segments.map((s) => s.id) }
}

/**
 * 段是否完整可读：每个段至少要有 shard-0。被人为删掉/半写时查询必须回退到
 * 逐文件扫描，而不是拿残缺 postings 回答“没有”。≤8 次 stat，查询前可承受。
 */
export function segmentsIntact(cacheDir, segments) {
  // 空数组是**合法的空索引**（工作区没有任何可索引正文），不能当成“段坏了”；
  // 否则每次构建都会被判成 index-missing，永远全量。
  if (!Array.isArray(segments)) return false
  return segments.every((seg) => {
    try {
      return fs.statSync(path.join(cacheDir, 'terms', String(seg.id), `shard-0.bin`)).isFile()
    } catch { return false }
  })
}

/** 删除不再被 meta 引用的段目录（构建提交后调用）。 */
export function pruneSegments(cacheDir, segments) {
  const keep = new Set((segments || []).map((s) => s.id))
  const termsDir = path.join(cacheDir, 'terms')
  let names = []
  try { names = fs.readdirSync(termsDir) } catch { return }
  for (const name of names) {
    if (!keep.has(name)) fs.rmSync(path.join(termsDir, name), { recursive: true, force: true })
  }
}

/** 测试用：清空进程内 shard 缓存。 */
export function clearTermCache() {
  shardCache.clear()
}

/** 稳定的临时 buildId（构建开始前就知道段目录名）。 */
export function newSegmentId() {
  return crypto.randomUUID()
}
