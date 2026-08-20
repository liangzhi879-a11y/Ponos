// YFW-turbo 会话持久化 + surface 投影（docs/bridge-contract.md §7/§8 + 内核设计 §4）
// ---------------------------------------------------------------------------
// transcript 文件位置与 server/transcript.mjs 的约定一致（跨层契约，GUI 直接
// 经 bridge /transcript/load 读取）：
//   <CLAUDE_CONFIG_DIR ?? ~/.yfworking>/projects/<sanitize(cwd)>/<sessionId>.jsonl
// 每行一个 NDJSON entry。entry 在既有 { type, id, timestamp, message } 之上扩展
// 可选字段（旧文件可加载）：
//   - seq：日志侧单调追加序号（跨进程稳定标识；旧 transcript 加载时按序补齐）
//   - surfaceOp：'append' | 'replace'（压缩条目为 replace）
//   - sourceEventSeqs：replace 时被遮蔽的 seq 列表
//   - kind：'compaction'（仅压缩条目携带，GUI 展示可折叠/容错）
// 内存模型：surface = { nodes: number[], replaceGeneration }（投影顺序）。模型
// 输入永远由 session.deriveMessages() 从日志派生（缓存，append/replace 后失效）。
// 加载语义：逐行流式读（超大 transcript 不整文件进内存）→ 依序重建 seq +
// surface → 孤儿 compaction/start（无配对 summary）直接回滚忽略 → maxEntries
// 超限时截断到近窗口（保留尾部）。
import { existsSync, createReadStream, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const MAX_SANITIZED_LENGTH = 200

// 与 server/transcript.mjs sanitizePathSegment 同算法：非字母数字 → '-'，
// 超 200 字符截断并追加 md5 前 12 位 hex。
export function sanitizeSegment(name) {
  const s = String(name ?? '').replace(/[^a-zA-Z0-9]/g, '-')
  if (s.length <= MAX_SANITIZED_LENGTH) return s
  const hash = createHash('md5').update(String(name)).digest('hex').slice(0, 12)
  return `${s.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

export function newSessionId() {
  return randomUUID()
}

export function createSessionStore({ configDir, cwd, sessionId, maxEntries = 0 }) {
  const dir = join(configDir, 'projects', sanitizeSegment(cwd))
  const file = join(dir, `${sessionId}.jsonl`)
  // 构造即确保落盘目录存在（旧 transcript 直写 store.file、后续 append 均可用）
  try { mkdirSync(dir, { recursive: true }) } catch { /* 目录不可建不致命 */ }
  // 内存状态：entries（seq → entry）、surface（投影顺序）、derive 缓存、压缩计数
  const entriesBySeq = new Map()
  const nodes = []
  let replaceGeneration = 0
  let compactCount = 0
  let nextSeq = 1
  let deriveCache = null // { key, messages, seqs }

  // 逐行流式读取（分段加载：超大 transcript 不整文件进内存；损坏行跳过）
  function readLines() {
    return new Promise((resolve, reject) => {
      if (!existsSync(file)) return resolve([])
      const out = []
      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
      rl.on('line', (line) => {
        const t = line.trim()
        if (!t) return
        try { out.push(JSON.parse(t)) } catch { /* 跳过损坏行 */ }
      })
      rl.on('close', () => resolve(out))
      rl.on('error', reject)
    })
  }

  // 依序重建 seq + surface；孤儿 compaction/start 直接忽略（replace 从未落地）
  function rebuildSurface(entries) {
    entriesBySeq.clear()
    nodes.length = 0
    replaceGeneration = 0
    compactCount = 0
    nextSeq = 1
    for (const e of entries) {
      const seq = e.seq ?? nextSeq
      nextSeq = Math.max(nextSeq, seq) + 1
      e.seq = seq
      if (e.kind === 'compaction' && e.phase === 'start') continue // 孤儿/占位不投影
      entriesBySeq.set(seq, e)
      if (e.kind === 'compaction' && e.phase === 'summary') {
        // 被遮蔽 seq 区间（投影中连续前缀）→ 替换为 summary seq
        const covered = new Set(e.sourceEventSeqs || [])
        const idxs = nodes.map((s, i) => (covered.has(s) ? i : -1)).filter((i) => i >= 0)
        if (idxs.length) { nodes.splice(idxs[0], idxs.length, seq); replaceGeneration++ }
        compactCount++
      } else {
        nodes.push(seq)
      }
    }
    // 窗口化恢复：超限截断到近窗口（保留尾部；compaction 条目始终保留在 nodes 内）
    if (maxEntries > 0 && nodes.length > maxEntries) {
      const cut = nodes.length - maxEntries
      nodes.splice(0, cut)
    }
    deriveCache = null
  }

  async function load() {
    const entries = await readLines()
    rebuildSurface(entries)
    return { entries, surface: { nodes, replaceGeneration }, compactCount }
  }

  function invalidate() { deriveCache = null }

  function append(entry) {
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')
    } catch { /* 磁盘不可写不致命：内存状态仍可用 */ }
    return entry
  }

  function baseEntry(type, message, extra = {}) {
    const entry = {
      type,
      id: randomUUID(),
      seq: nextSeq++,
      timestamp: new Date().toISOString(),
      message,
      surfaceOp: 'append',
      ...extra,
    }
    entriesBySeq.set(entry.seq, entry)
    nodes.push(entry.seq)
    invalidate()
    return entry
  }

  return {
    file,
    // 加载（async 流式；resume / 测试用）。加载后 entries/surface 为当前权威快照
    async load() { return load() },
    // 仅写日志（低级原语；普通追加请用 appendUser/appendAssistant）
    append(entry) { return append(entry) },

    // —— 投影语义封装（写日志 + 更新 surface）——
    userEntry(content, extra = {}) {
      return { type: 'user', id: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: String(content ?? '') }, ...extra }
    },
    assistantEntry(blocks, { usage, model } = {}) {
      const entry = { type: 'assistant', id: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'assistant', content: blocks } }
      if (usage) entry.message.usage = usage
      if (model) entry.message.model = model
      return entry
    },
    toolResultEntry({ toolUseId, content, isError }) {
      return {
        type: 'user',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: String(content ?? ''), is_error: Boolean(isError) }] },
      }
    },
    // 批量 tool_result：合并进同一条 user 消息（Anthropic API 要求同一 assistant
    // 的多个 tool_use 的 tool_result 紧随其后且在同一条消息内）
    toolResultsEntry(toolResults) {
      return {
        type: 'user',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: (toolResults || []).map((r) => ({
            type: 'tool_result',
            tool_use_id: r.tool_use_id,
            content: String(r.content ?? ''),
            is_error: Boolean(r.is_error),
          })),
        },
      }
    },
    compactionStartEntry(coveredSeqs) {
      return {
        type: 'assistant', id: randomUUID(), timestamp: new Date().toISOString(),
        kind: 'compaction', phase: 'start', surfaceOp: 'replace',
        sourceEventSeqs: coveredSeqs,
        message: { role: 'assistant', content: [] },
      }
    },
    compactionSummaryEntry({ summary, coveredSeqs }) {
      return {
        type: 'assistant', id: randomUUID(), timestamp: new Date().toISOString(),
        kind: 'compaction', phase: 'summary', surfaceOp: 'replace',
        sourceEventSeqs: coveredSeqs,
        // content 为字符串：压缩摘要条目是文本承载（模型消息 content 允许字符串；
        // 测试权威断言 deriveMessages()[0].content === summary 字符串）
        message: { role: 'assistant', content: String(summary ?? '') },
      }
    },

    appendUser(content, extra = {}) { return append(baseEntry('user', { role: 'user', content: String(content ?? '') }, extra)) },
    appendAssistant(blocks, opts = {}) {
      const entry = this.assistantEntry(blocks, opts)
      return append(baseEntry('assistant', entry.message, {}))
    },
    appendToolResult({ toolUseId, content, isError }) {
      const entry = this.toolResultEntry({ toolUseId, content, isError })
      return append(baseEntry('user', entry.message, {}))
    },
    appendToolResults(toolResults) {
      const entry = this.toolResultsEntry(toolResults)
      return append(baseEntry('user', entry.message, {}))
    },
    // 已落盘条目的 usage 后挂（M1 空文本收尾轮专用：把本轮总 usage 挂到最后一条
    // 已写 assistant 条目）。内存更新 entriesBySeq 引用 + 磁盘单行重写——
    // append-only 日志的罕见例外路径，正常轮次 usage 总在最终条目写入时一次落盘。
    setEntryUsage(entry, usage) {
      if (!entry || !usage) return entry
      entry.message.usage = usage
      try {
        const text = readFileSync(file, 'utf-8')
        const lines = text.split('\n')
        const idx = lines.findIndex((l) => {
          const t = l.trim()
          if (!t) return false
          try { return JSON.parse(t).seq === entry.seq } catch { return false }
        })
        if (idx >= 0) {
          lines[idx] = JSON.stringify(entry)
          writeFileSync(file, lines.join('\n'), 'utf-8')
        }
      } catch { /* 磁盘不可写不致命：内存已更新 */ }
      return entry
    },
    // 压缩开始占位：仅写日志（持锁标记），不进 surface.nodes；崩溃留孤儿 → 加载回滚
    appendCompactionStart(coveredSeqs) {
      const entry = { ...this.compactionStartEntry(coveredSeqs), seq: nextSeq++ }
      append(entry)
      return entry
    },
    // 压缩落地：写 summary 条目 → surface 替换被遮蔽区间 → compactCount++
    appendCompactionSummary({ summary, coveredSeqs }) {
      const seq = nextSeq++
      const entry = { ...this.compactionSummaryEntry({ summary, coveredSeqs }), seq }
      append(entry)
      const covered = new Set(coveredSeqs || [])
      const idxs = nodes.map((s, i) => (covered.has(s) ? i : -1)).filter((i) => i >= 0)
      if (idxs.length) { nodes.splice(idxs[0], idxs.length, seq); replaceGeneration++ }
      compactCount++
      entriesBySeq.set(seq, entry)
      invalidate()
      return entry
    },

    // —— surface / 派生 ——
    getSurface() { return { nodes: [...nodes], replaceGeneration } },
    compactCount() { return compactCount },
    // 模型输入永远从日志派生（缓存：append/replace 后 key 变化自动失效）
    deriveMessages() {
      const key = nodes.join(',')
      if (deriveCache && deriveCache.key === key) return deriveCache.messages
      const seqs = []
      const messages = []
      for (const seq of nodes) {
        const entry = entriesBySeq.get(seq)
        if (!entry) continue
        seqs.push(seq)
        messages.push(entry.message)
      }
      deriveCache = { key, messages, seqs }
      return messages
    },
    // 由 deriveMessages() 返回的消息对象反查其 seq（对象引用一致；供压缩遮蔽区间落盘）
    seqsForMessages(covered) {
      if (!deriveCache) this.deriveMessages()
      const byRef = new Map()
      deriveCache.messages.forEach((m, i) => byRef.set(m, deriveCache.seqs[i]))
      return covered.map((m) => byRef.get(m)).filter((s) => s != null)
    },
  }
}
