// kernel/graph.mjs —— 内核神经图谱（无模型特征向量 + 图谱存储 + 检索）
//
// ========== IGraphBackend 接口预留（设计文档 §7）==========
// 预留外部知识库替换点 —— 接口契约 IGraphBackend {
//   search(query, { topK }) → Promise<[{ theme, tag, summary, full, score }]>
//   write(entry) → Promise<{ ok, deduped }>
//   health() → Promise<{ ok, detail }>
// }
// 配置位 env PONOS_GRAPH_BACKEND=local|external / settings memory.graphBackend（env 优先）。
// 本次仅实现 local（markdown + graph.jsonl 派生索引），external 未实现
// （未来实现同一接口注册到 createGraphBackend() 工厂即可整体替换，检索与沉淀全部依托外挂）。
import { hashLine, keywordScore, readMemoryEntries } from './memory.mjs'
export { hashLine }
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, appendFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const CJK = /[\u4e00-\u9fff]/
const WORD = /[A-Za-z0-9]/

// 切分：中文段字符 bigram + 英文/数字段单词小写。
// 段边界语义（对齐 test 断言 ['ps','表与','与r','rd','rd表']）：
//   - word 段 -> 整体小写；cjk 段 -> 内部滑动 bigram
//   - cjk->word 边界 -> 末 cjk 字 + 首词字（小写）组成的跨界 bigram
//   - word->末段 cjk 边界 -> 整体小写词 + 首 cjk 字（避免孤立尾字丢失）
export function* gramTokens(text) {
  const s = String(text ?? '').trim()
  const runs = [] // { type: 'word' | 'cjk', text }
  let cur = ''
  let curType = null
  const flush = (type) => {
    if (cur) runs.push({ type: curType, text: cur })
    cur = ''
    curType = type
  }
  for (const ch of s) {
    const t = CJK.test(ch) ? 'cjk' : WORD.test(ch) ? 'word' : null
    if (t === null) { flush(null); continue } // 空白/标点分词，不参与 n-gram
    if (t !== curType) flush(t)
    cur += ch
  }
  flush(null)
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const next = runs[i + 1]
    if (r.type === 'word') {
      yield r.text.toLowerCase()
      if (next && next.type === 'cjk' && i + 1 === runs.length - 1) {
        yield r.text.toLowerCase() + [...next.text][0] // word->末段 cjk 边界
      }
    } else {
      const chars = [...r.text]
      for (let j = 0; j + 1 < chars.length; j++) yield chars[j] + chars[j + 1]
      if (next && next.type === 'word') {
        yield chars[chars.length - 1] + next.text[0].toLowerCase() // cjk->word 边界
      }
    }
  }
}

export function vectorizeText(text, { tagBoost = 1, idf = null } = {}) {
  const tf = new Map()
  for (const g of gramTokens(text)) tf.set(g, (tf.get(g) || 0) + 1)
  const raw = []
  for (const [gram, count] of tf) {
    const w = (1 + Math.sqrt(count)) * (idf?.get(gram) ?? 1)
    raw.push([hashLine(gram), w])
  }
  const norm = Math.sqrt(raw.reduce((s, [, w]) => s + w * w, 0))
  // tagBoost 在归一化之后乘（test 断言 w2[知识] > w1[知识] 需要 boost 不被归一化抹平）
  const boost = tagBoost || 1
  return norm > 0 ? raw.map(([id, w]) => [id, (w / norm) * boost]) : []
}

export function cosine(a, b) {
  const bm = new Map(b)
  let dot = 0
  for (const [id, wa] of a) { const wb = bm.get(id); if (wb) dot += wa * wb }
  return dot
}

export function buildIdf(docs) {
  const df = new Map()
  const N = docs.length
  for (const d of docs) for (const gram of d.gramCounts.keys()) df.set(gram, (df.get(gram) || 0) + 1)
  const idf = new Map()
  // 标准 IDF（brief 接口）：ln((N+1)/(df+1)) + 1，df 高者 idf 低
  for (const [gram, count] of df) idf.set(gram, Math.log((N + 1) / (count + 1)) + 1)
  return idf
}

// ---------- Task 2: 图谱存储 GraphStore ----------

const GRAPH_FILE = 'graph.jsonl'
const GRAPH_VERSION = 1

function nodeLine(n) {
  return `- [会话${n.tag ? '|' + n.tag : ''}] ${n.summary} -- ${n.full}`
}

function entryToNode({ theme, tag, summary, full }, idf) {
  const tagText = tag ? tag : ''
  const vec = vectorizeText(`${theme} ${tagText} ${summary} ${full}`, { tagBoost: tag ? 3 : 1, idf })
  return { id: hashLine(nodeLine({ tag, summary, full })), theme, tag: tag || null, summary, full, ts: new Date().toISOString(), vec, v: GRAPH_VERSION }
}

export function createGraphStore({ root = null } = {}) {
  const dir = root || join(process.env.PONOS_TEST_HOME || '', 'memory', 'graph')
  const file = join(dir, GRAPH_FILE)
  let nodes = []
  let idf = new Map()
  const recomputeIdf = () => {
    // 从节点原文取 gram（文本键），与重建路径的 memIdf 一致；不要用 n.vec 的哈希 id 键
    // （vectorizeText 用原始 gram 文本查 idf，哈希键永远查不到 → IDF 失效）
    idf = buildIdf(nodes.map((n) => ({ gramCounts: new Map([...gramTokens(`${n.theme} ${n.tag || ''} ${n.summary} ${n.full}`)].map((g) => [g, 1])) })))
  }
  // 闭包重建：扫描 memoryRoot 全部主题 md → 两遍（先收集算 IDF，再向量化）→ 原子替换
  const rebuildFromMemory = (memoryRoot) => {
    const collected = []
    let entries = []
    try { entries = readdirSync(memoryRoot).filter((f) => f.endsWith('.md') && !f.startsWith('.')) } catch { return }
    for (const f of entries) {
      const theme = f.slice(0, -3)
      for (const it of readMemoryEntries({ root: memoryRoot, theme })) {
        collected.push({ theme, tag: it.tag, summary: it.summary, full: it.full })
      }
    }
    const gramDocs = collected.map((c) => ({ gramCounts: new Map([...gramTokens(`${c.theme} ${c.tag || ''} ${c.summary} ${c.full}`)].map((g) => [g, 1])) }))
    const memIdf = buildIdf(gramDocs)
    const next = collected.map((c) => entryToNode(c, memIdf))
    nodes = next
    recomputeIdf()
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, nodes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf-8')
      renameSync(tmp, file)
    } catch { /* 磁盘不可写不致命 */ }
  }
  return {
    getNodes: () => nodes,
    getIdf: () => idf,
    async load({ memoryRoot = null, force = false } = {}) {
      if (force && memoryRoot) {
        rebuildFromMemory(memoryRoot)
        return
      }
      if (existsSync(file)) {
        try { mkdirSync(dir, { recursive: true }) } catch {}
        const raw = readFileSync(file, 'utf-8')
        nodes = []
        for (const line of raw.split(/\r?\n/)) {
          const t = line.trim()
          if (!t) continue
          try { nodes.push(JSON.parse(t)) } catch { /* 半截行跳过 */ }
        }
        // §3.2 启动重建校验（memoryRoot 存在时）：版本旧 → 重建；markdown mtime 新于图谱 → 重建
        if (memoryRoot) {
          // 版本校验：任一节点版本 != GRAPH_VERSION 即重建。旧节点无 v 字段视为当前版本
          // （append 时代产物，避免对既有图谱误重建）。
          if (nodes.some((n) => (n.v ?? GRAPH_VERSION) !== GRAPH_VERSION)) {
            rebuildFromMemory(memoryRoot)
            return
          }
          // mtime 校验：扫描 memoryRoot 全部主题 md（排除隐藏文件），最新 md mtime 晚于
          // 图谱文件 → markdown 有新增/变更，重建派生索引。
          const graphMtime = statSync(file).mtimeMs
          let newestMd = -1
          try {
            for (const f of readdirSync(memoryRoot).filter((x) => x.endsWith('.md') && !x.startsWith('.'))) {
              const m = statSync(join(memoryRoot, f)).mtimeMs
              if (m > newestMd) newestMd = m
            }
          } catch { /* memoryRoot 不可读不校验 */ }
          if (newestMd > graphMtime) {
            rebuildFromMemory(memoryRoot)
            return
          }
        }
        recomputeIdf()
        return
      }
      if (memoryRoot) rebuildFromMemory(memoryRoot)
    },
    append({ theme = '', tag = null, summary = '', full = '' }) {
      const node = entryToNode({ theme, tag, summary, full })
      if (nodes.some((n) => n.id === node.id)) return { ok: true, deduped: true }
      nodes.push(node)
      recomputeIdf()
      try {
        mkdirSync(dir, { recursive: true })
        if (existsSync(file)) {
          const fd = openSync(file, 'r')
          try {
            const { size } = fstatSync(fd)
            if (size > 0) {
              const buf = Buffer.alloc(1)
              readSync(fd, buf, 0, 1, size - 1)
              if (buf[0] !== 0x0a) appendFileSync(file, '\n', 'utf-8')
            }
          } finally { closeSync(fd) }
        }
        appendFileSync(file, JSON.stringify(node) + '\n', 'utf-8')
      } catch { /* 磁盘不可写不致命：内存图谱可用 */ }
      return { ok: true, deduped: false }
    },
    replaceAll(next) {
      nodes = next
      recomputeIdf()
      try {
        mkdirSync(dir, { recursive: true })
        const tmp = file + '.tmp'
        writeFileSync(tmp, nodes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf-8')
        renameSync(tmp, file)
      } catch { /* 磁盘不可写不致命 */ }
    },
    search({ query = '', keywords = [], topK = 5, maxBytes = 2048 } = {}) {
      const q = String(query || '').trim()
      if (!q && !keywords.length) return ''
      const qvec = vectorizeText(q || keywords.join(' '), { idf })
      const scored = nodes.map((n) => {
        const cos = cosine(n.vec, qvec)
        const kw = keywordScore(n, keywords) / 8 // 关键词分最大值约 3+2+2+1=8，归一化到 0-1
        return { ...n, score: 0.7 * cos + 0.3 * Math.min(kw, 1) }
      }).filter((n) => n.score > 0.001)
      scored.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts))
      const header = '\n\n【相关经验抽调】根据当前任务关键词，以下过往经验与任务直接相关，可直接参考（格式：-[主题|标签] 摘要 -- 全文）：\n'
      let out = header
      const seen = new Set()
      for (const it of scored.slice(0, topK)) {
        const line = `- [${it.theme}${it.tag ? '|' + it.tag : ''}] ${it.summary} -- ${it.full}`
        if (seen.has(it.id)) continue
        const lb = line.length + 1
        if (out.length + lb > maxBytes) break
        seen.add(it.id)
        out += line + '\n'
      }
      return out === header ? '' : out
    },
  }
}

// §3.2 命令式重建入口（DI 偏离说明：设计文档 §11 写 memory.mjs 导出，但 memory.mjs 不得
// import graph.mjs（单向依赖避免循环）；rebuildGraph 依赖 createGraphStore，故导出在本模块）
export async function rebuildGraph({ graphRoot, memoryRoot }) {
  const g = createGraphStore({ root: graphRoot })
  await g.load({ memoryRoot, force: true })
  return g.getNodes().length
}
