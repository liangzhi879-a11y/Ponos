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
//
// 2026-09-13 知识内核 S1 Task 4：分词/向量/余弦/IDF/行指纹的**权威实现已迁到**
// shared/knowledge-core.mjs，本模块只保留图谱存储与检索编排；纯函数按原签名 re-export。
import { readMemoryEntries } from './memory.mjs'
import { buildRelevantBlock, entryVector, resolveBudget } from './memory-rank.mjs'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, appendFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import {
  hashLine, gramTokens, vectorizeText, cosine, buildIdf, keywordScore,
} from '../shared/knowledge-core.mjs'

// 原签名 re-export：既有导入点（kernel/memory-search.mjs、kernel-tests/*）零改动
export { hashLine, gramTokens, vectorizeText, cosine, buildIdf }

// ---------- Task 2: 图谱存储 GraphStore ----------

const GRAPH_FILE = 'graph.jsonl'
const GRAPH_VERSION = 1

function nodeLine(n) {
  return `- [会话${n.tag ? '|' + n.tag : ''}] ${n.summary} -- ${n.full}`
}

function entryToNode({ theme, tag, summary, full }, idf) {
  const tagText = tag ? tag : ''
  // 向量口径**唯一真源**在 memory-rank.entryVector（tagBoost 3/1）——不在这里重写一遍，
  // 否则"持久化的 vec"与"检索时现算的 vec"会悄悄分叉（实测过一次：对拍只是小样本巧合通过）。
  const vec = entryVector({ theme, tag: tagText, summary, full }, idf)
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
    search({ query = '', keywords = [], topK = 5, maxChars = null, maxBytes = null } = {}) {
      // ★★ 2026-09-30 统一（本模块头「经验条目级召回」的 B 路）：评分/排序/渲染/预算口径
      //   改由 `kernel/memory-rank.mjs` 唯一真源提供，与 `memory.mjs#buildRelevantMemory`（A 路）
      //   **完全同质**（同公式：0.7×向量 + 0.3×关键词；同排序键；同渲染格式；同**字符**预算）。
      //   候选自带 `vec`（本 store 的节点已持久化）⇒ 统一模块直接复用，不重复向量化。
      //   预算单位：`maxChars` 优先；只给旧参数 `maxBytes` 时按同数值当字符（历史调用点兼容）。
      // 预算解析走 memory-rank 的**唯一口径**（`Number(null)===0` 陷阱见该函数注释）
      const budget = resolveBudget({ maxChars, maxBytes })
      return buildRelevantBlock(nodes, {
        query: String(query || '').trim() || keywords.join(' '),
        keywords,
        idf,
        topK,
        maxChars: budget,
      })
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
