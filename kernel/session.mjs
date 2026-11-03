// Ponos-turbo 会话持久化 + surface 投影（docs/bridge-contract.md §7/§8 + 内核设计 §4）
// ---------------------------------------------------------------------------
// transcript 文件位置与 server/transcript.mjs 的约定一致（跨层契约，GUI 直接
// 经 bridge /transcript/load 读取）：
//   <PONOS_CONFIG_DIR ?? ~/.ponos>/projects/<sanitize(cwd)>/<sessionId>.jsonl
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
import { existsSync, createReadStream, appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, truncateSync } from 'node:fs'
// ★ 2026-10-18：transcript 整文件重写走带 fsync 的原子写（防断电留半截行）
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { redactEntry } from './redact.mjs'
import { diskWrite, getDiskTelemetry } from './disk-write.mjs'
import { attributionOf } from '../shared/attribution.mjs'

export const MAX_SANITIZED_LENGTH = 200

// transcript 文件 schema 版本（D2-2）：新会话首行写 meta 标记；旧格式（无 meta）视为 v1。
export const TRANSCRIPT_SCHEMA_VERSION = 1

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

// K2.4：setEntryUsage 自尾部起最多反查多少条非空行（超过才回退到全量 findIndex）。
// 取 8 是因为"最后一条 assistant"之后最多再跟几条（meta / compaction 占位），而不是因为
// 8 有什么魔力；瓶颈是**整文件 JSON.parse**，故 8 与 64 的差别可以忽略，取小更省。
const TAIL_SCAN = 8

export function createSessionStore({ configDir, cwd, sessionId, maxEntries = 0 }) {
  const dir = join(configDir, 'projects', sanitizeSegment(cwd))
  const file = join(dir, `${sessionId}.jsonl`)
  // K1.5 落盘目录只建一次（2026-09-13 系统性优化）：`append()` 此前每条都重复
  // `mkdirSync`——实测 0.401ms/条 → 0.221ms/条（省 0.181ms，近半；交替先后取中位），
  // 按 1–3 条/步 = 0.18–0.54ms/步。
  // 但**不能**只图快：旧实现的"每次都 mkdir"在目录被运行期删除时（用户清理 ~/.ponos、
  // 测试夹具 rmSync）是自愈的，故 append 侧必须在 ENOENT 时清标志重来一次（见下）。
  let dirEnsured = false
  // 构造即确保落盘目录存在（旧 transcript 直写 store.file、后续 append 均可用）
  try { mkdirSync(dir, { recursive: true }); dirEnsured = true } catch { /* 目录不可建不致命 */ }
  // D2-2：新会话落盘 meta 首行（版本标记；不占 seq、不投影）。旧文件/恢复会话不写。
  if (!existsSync(file)) {
    try {
      // 【S2-D4 归属字段落盘】meta 首行是"会话级属性"的自然位置（归属属于整个会话，不属某条
      // entry）。之所以必须在**新会话写入时**就落：spec §6.2 D4「L1 阶段作者恒为本人、工作区恒为
      // `personal` 也要写——后补 = 全量数据迁移」——事后无法从 transcript 反推作者，只能迁移全量数据。
      // 兼容性：`authorId`/`workspaceId` 是**可选新增字段**，与既有"在 { type, id, timestamp, message }
      // 之上扩展可选字段、旧文件可加载"的约定一致，故**不动 TRANSCRIPT_SCHEMA_VERSION**（旧文件
      // 仍视为 v1，读侧不得因缺这两个字段而拒绝加载）。
      const attribution = attributionOf()
      appendFileSync(file, JSON.stringify({
        type: 'meta',
        kind: 'transcript',
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        authorId: attribution.authorId,
        workspaceId: attribution.workspaceId,
      }) + '\n', 'utf-8')
    } catch { /* 磁盘不可写不致命 */ }
  }
  // 内存状态：entries（seq → entry）、surface（投影顺序）、derive 缓存、压缩计数
  const entriesBySeq = new Map()
  const nodes = []
  // thinking 条目 seq（升序）：不进 nodes（不单独成一帧），但**要并回下一条带 tool_use 的
  // assistant 消息**（2026-10-22 思考回放；DeepSeek /anthropic 缺块直接 400）。deriveMessages
  // 用二分取「上一节点之后、当前节点之前」的思考条目，故必须保持有序。
  const thinkingSeqs = []
  let replaceGeneration = 0
  let compactCount = 0
  let nextSeq = 1
  let deriveCache = null // { key, messages, seqs }
  // 派生纪元（K1.4 请求面记忆化的失效键，2026-09-13 系统性优化）。语义 = 「deriveMessages()
  // 再调一次会不会给出**同一个数组**」。两处 +1，是为让它与 deriveCache 身份**结构上**不可能
  // 不同步：① invalidate()（写路径显式失效，立即生效——否则"已失效但尚未重建"的窗口里
  // 读到的还是旧值，而键的另一半 getBase() 却已拿到新数组 ⇒ 拿旧数组当新结果缓存）；
  // ② deriveMessages() 真实重建分支（兜住任何**忘记**调 invalidate() 就改了 nodes 的路径
  // ——正是"枚举所有写点"最容易漏的那类）。两边都 +1 时最多多失效一次，只多算、不会错算。
  let deriveRev = 0
  const bumpRev = () => { deriveRev++ }

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
  // foreign：无 turbo transcript meta 标记的旧格式（外部工具历史）transcript。
  // 其 tool_use/tool_result 链不满足 Anthropic API「tool_result 必须紧跟 tool_use」
  // 约束（跨层乱序 → 恢复时 API 400，2026-08-22 实测 1783 orphan tool_use）。
  // 恢复时剥离 tool 块、只保留文本历史（工具无法重放，文本才是可恢复的对话）。
  function rebuildSurface(entries, { foreign = false } = {}) {
    entriesBySeq.clear()
    nodes.length = 0
    thinkingSeqs.length = 0
    replaceGeneration = 0
    compactCount = 0
    nextSeq = 1
    for (const e of entries) {
      if (e.type === 'meta') continue // P4-5/D2-2 审计/元数据条目不投影、不占 seq（不进模型输入）
      // 兼容旧格式 transcript（queue-operation/last-prompt 等无 message 的元行）：
      // 不投影进模型输入——否则 deriveMessages 产出 undefined 条目，后续
      // context.estimateRequest / patchOrphanToolUses 访问 .content/.role 抛
      // "Cannot read properties of undefined (reading 'content')"（用户侧
      // G.content 运行时错误的根因，2026-08-22 修复）。旧格式的 user/assistant
      // 消息行有 message.role，正常投影保留历史。
      if (!e.message || typeof e.message !== 'object' || typeof e.message.role !== 'string') continue
      if (foreign && Array.isArray(e.message.content)) {
        // 旧格式工具链剥离：纯工具消息整条丢弃，混合消息只留文本块
        const blocks = e.message.content.filter((b) => b && b.type !== 'tool_use' && b.type !== 'tool_result')
        if (blocks.length === 0) continue
        if (blocks.length !== e.message.content.length) e.message = { ...e.message, content: blocks }
      }
      const seq = e.seq ?? nextSeq
      nextSeq = Math.max(nextSeq, seq) + 1
      e.seq = seq
      if (e.kind === 'compaction' && e.phase === 'start') continue // 孤儿/占位不投影
      entriesBySeq.set(seq, e)
      // thinking 条目（2026-09-23）：落盘可见但不**单独**投影进模型输入；后续由
      // deriveMessages 并回带 tool_use 的 assistant 消息（2026-10-22 思考回放）。
      // 判定必须在 seq 计算**之后**（与上方 meta 的 continue 位置相反——meta 是"不占
      // seq"，这里"占 seq 但不单独成帧"），确保 nextSeq 单调、旧条目 seq 不被复用。
      if (e.type === 'thinking') { thinkingSeqs.push(seq); continue }
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
    // 文件按 append 顺序即 seq 升序，但 resume 可能遇到外部拼接/损坏文件 ⇒ 显式排序，
    // deriveMessages 的二分查找依赖这一不变量（乱序只会漏并思考块，不会错并别轮的）。
    thinkingSeqs.sort((a, b) => a - b)
    // 窗口化恢复：超限截断到近窗口（保留尾部；compaction 条目始终保留在 nodes 内）
    if (maxEntries > 0 && nodes.length > maxEntries) {
      const cut = nodes.length - maxEntries
      nodes.splice(0, cut)
    }
    // 走 invalidate() 而非直接置空：这是**唯一**能让 deriveCache 变 null 的第二处，
    // 收拢成一处后「置空 deriveCache」与「deriveRev+1」在结构上不可能分家（K1.4）
    invalidate()
  }

  // ── K2.5 撕裂尾部修复（2026-09-13 系统性优化 Task 10）────────────────────────────
  // 病灶**不是"读不了"**（readLines 与 bridge 的 transcript.mjs 都逐行 try/catch 跳过坏行，
  // 且 bridge 会报 skipped），而是**下一次 append 会与残行黏连**：`writeEntry` 用
  // `appendFileSync(line+'\n')`，若文件末尾是崩溃留下的半行（**没有换行**），新条目会被拼在
  // 同一行上 ⇒ 整行 JSON.parse 失败 ⇒ **新条目静默丢失**（连 skipped 计数都只是"一行坏"）。
  // 这正是 append-only 日志最典型的故障形态。
  // 修法：加载时若末尾不是换行 ⇒ 补齐或丢弃那半行，让文件重新以 '\n' 结尾。
  // 只在**有残行**时才付出整读代价（健康文件零成本，见 endsWithNewline）。
  /** 末尾是否为换行（1 字节探针，不整读大文件）。读不到一律当"正常"——绝不因此动用户文件 */
  function endsWithNewline() {
    try {
      const st = statSync(file)
      if (st.size === 0) return true
      const fd = openSync(file, 'r')
      try {
        const b = Buffer.alloc(1)
        return readSync(fd, b, 0, 1, st.size - 1) === 1 && b[0] === 0x0a
      } finally { closeSync(fd) }
    } catch { return true }
  }

  /** 修复撕裂尾部；返回被丢弃的字节数（0 = 未改动，含"末尾残行本身是完整 JSON ⇒ 只补换行"） */
  function repairTornTail() {
    let buf = null
    try { buf = readFileSync(file) } catch { return 0 }
    if (!buf.length || buf[buf.length - 1] === 0x0a) return 0 // 已以换行结尾 ⇒ 无黏连风险，不动
    // cut 是**基于本次读到的字节**算出的绝对偏移，而 truncateSync 是绝对偏移 ⇒ 若这期间有
    // 别的 writer 追加过，那部分**完整**数据会被一起切掉（比不修更糟）。故动盘前复核 size：
    // 变了就整个放弃本次修复（下一次加载再修，绝不拿陈旧偏移去截断）。
    // 说明：这里只能**收窄**竞态窗口，不能消除（两次 stat 之间仍可能有写入），且**没有确定性
    // 单测**——单线程内本修复是全同步块，没有可插入的交汇点，只能靠另一个**进程**才触发。
    // 之所以判定它只是廉价保险而非必须：任何正常 writer 都写 `line+\n` ⇒ 文件末尾始终是换行
    // ⇒ endsWithNewline() 直接短路，修复根本不会启动；能命中这道守卫的，只有"另一个 writer
    // 正卡在半个行的写入中间"，而那种 writer 自己也要被修。真正的保证仍来自设计前提：同一
    // 会话文件同时只有一个内核 writer，且 load() 发生在该会话开工之前（两个内核同写一个
    // transcript 本就是未支持状态——它们会先把 seq/meta 撞坏）。
    try { if (statSync(file).size !== buf.length) return 0 } catch { return 0 }
    const idx = buf.lastIndexOf(0x0a)
    const cut = idx + 1 // 保留到最后一个换行（含）；无换行时 cut = 0
    const tail = buf.subarray(cut)
    // 残行**本身是完整 JSON**（崩溃恰好落在对象结尾）⇒ 只补一个换行，一个字节都不丢
    let complete = false
    try { JSON.parse(tail.toString('utf-8')); complete = true } catch { /* 真·半行 */ }
    try {
      if (complete) appendFileSync(file, '\n', 'utf-8')
      else truncateSync(file, cut)
    } catch { return 0 } // 磁盘不可写：保持原样（绝不因修复失败而让加载失败）
    return complete ? 0 : tail.length
  }

  async function load() {
    const dropped = endsWithNewline() ? 0 : repairTornTail()
    if (dropped > 0) {
      // 诊断不降级：丢了多少字节必须留痕（否则用户只会看到"历史少了一条"）
      try { console.error(`[session] torn tail repaired: dropped=${dropped}B file=${file.split(/[\\/]/).pop()}`) } catch { /* 日志失败不影响加载 */ }
    }
    const entries = await readLines()
    // 旧格式（foreign）判定：turbo 会话首行必写 transcript meta；无则视为
    // 外部工具历史会话，恢复时按旧格式语义投影（剥离工具链，见 rebuildSurface）
    const foreign = !entries.some((e) => e?.type === 'meta' && e?.kind === 'transcript' && e?.schemaVersion != null)
    rebuildSurface(entries, { foreign })
    const metaEntry = entries.find((e) => e?.type === 'meta' && e?.kind === 'transcript' && e?.schemaVersion != null)
    return { entries, surface: { nodes, replaceGeneration }, compactCount, metaVersion: metaEntry ? Number(metaEntry.schemaVersion) : 1, foreign, tornTailDropped: dropped }
  }

  function invalidate() { deriveCache = null; bumpRev() }

  // K1.5：常态不再重复 mkdir（构造期已建 ⇒ `dirEnsured`）。**硬约束：不得改成常驻 fd。**
  // `setEntryUsage` 走 `writeFileSync(tmp) + renameSync(tmp, file)` **整体替换**文件，持有
  // fd 会指向被 unlink 的旧 inode ⇒ 之后所有写入落在一个不可达的 inode 上（静默丢写，
  // 磁盘上永远看不到）。故这里只能省「建目录」，不能省「重新打开文件」。
  function writeEntry(entry) {
    // S2-1 磁盘脱敏：落盘内容打码（内存 entriesBySeq 保留原文，模型输入不受影响）
    // disk-site: transcript-append —— 最高频落盘点（每条 entry 一次）。
    // ★ 硬约束：不得改成常驻 fd（setEntryUsage 用 tmp+rename 整体替换文件，持 fd 会指向被
    //   unlink 的旧 inode ⇒ 静默丢写）。故这里仍用每次 appendFileSync，只外包一层遥测。
    // 失败语义**守恒**：原实现失败上抛，由调用方 append 捕获 ENOENT 后重建目录并重试一次
    //（append 的 `err?.code === 'ENOENT' && dirEnsured` 分支）。故包装后必须重新抛出——
    // 否则等于吃掉异常、目录被运行期删除后的自愈重建失效。
    const w = diskWrite(getDiskTelemetry(), 'transcript-append', () => {
      appendFileSync(file, JSON.stringify(redactEntry(entry)) + '\n', 'utf-8')
    })
    if (!w.ok) throw w.error
  }
  function append(entry) {
    try {
      if (!dirEnsured) { mkdirSync(dir, { recursive: true }); dirEnsured = true }
      writeEntry(entry)
    } catch (err) {
      // 目录被运行期删除（ENOENT）= 唯一需要重建的形态。清标志重建后重试**一次**，
      // 保住旧实现"每次都 mkdir"的自愈语义；其余错误与旧实现一致：吞掉（磁盘不可写不致命）。
      if (err?.code === 'ENOENT' && dirEnsured) {
        dirEnsured = false
        try { mkdirSync(dir, { recursive: true }); dirEnsured = true; writeEntry(entry) } catch { /* 仍失败：内存状态仍可用 */ }
      }
    }
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

  // ── 思考回放（2026-10-22）────────────────────────────────────────────────────
  // 取 (afterSeq, beforeSeq) 区间内的 thinking 块。区间取法而不是"标记归属"：thinking
  // 条目在下一条 assistant 落盘前写入（engine 的 flushThinking），文件序即真实时间序；
  // 本会话内该区间最多只有一条 assistant 的思考，跨轮残留也会被下一条用户消息挡住。
  function thinkingBlocksBetween(afterSeq, beforeSeq) {
    if (!thinkingSeqs.length) return null
    // 第一个 > afterSeq 的位置（thinkingSeqs 升序，见 rebuildSurface / appendThinking）
    let lo = 0
    let hi = thinkingSeqs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (thinkingSeqs[mid] <= afterSeq) lo = mid + 1
      else hi = mid
    }
    let blocks = null
    for (let i = lo; i < thinkingSeqs.length && thinkingSeqs[i] < beforeSeq; i++) {
      const content = entriesBySeq.get(thinkingSeqs[i])?.message?.content
      if (!Array.isArray(content)) continue
      for (const b of content) {
        if (b && b.type === 'thinking') (blocks || (blocks = [])).push(b)
      }
    }
    return blocks
  }

  // 模型输入投影：thinking 只并入**带 tool_use 的 assistant 轮**（放 content 头部）。
  // 为什么不是全部 assistant 轮：DeepSeek 的强制校验落在工具轮回放（助手的 tool_use
  // 必须与它的 thinking 一起回传）；纯文本轮回放思考只会白涨 prompt（本仓长会话的
  // thinking 条目可达数百条），且对签名端点意味着更多无效签名风险。返回**新对象**，
  // 绝不改 entry.message：落盘、transcript 回放、usage 后挂都以原始条目为真源。
  function projectMessage(entry, prevSeq, seq) {
    const msg = entry.message
    if (!msg || msg.role !== 'assistant' || entry.kind === 'compaction') return msg
    if (!Array.isArray(msg.content) || !msg.content.some((b) => b && b.type === 'tool_use')) return msg
    const blocks = thinkingBlocksBetween(prevSeq, seq)
    if (!blocks) return msg
    return { ...msg, content: [...blocks, ...msg.content] }
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
    /**
     * @param {any} blocks
     * @param {{ usage?: any, model?: any }} [opts]
     */
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
      // 增删行数（2026-10-08）：**顶层** diffs 字段 —— 仅供回放侧 UI（GUI 转录适配器把它
      // 并进工具结果的回显，见 src/lib/transcriptAdapter.ts 预扫描）。刻意**不进**
      // entry.message.content：那里是模型输入（deriveMessages 逐条投影 message），
      // UI 专用数据混进去会污染上下文与前缀缓存。无数据时不加键 ⇒ 旧场景条目形状逐字不变。
      const diffs = (toolResults || [])
        .filter((r) => Number.isFinite(r?.additions) || Number.isFinite(r?.deletions))
        .map((r) => ({
          tool_use_id: r.tool_use_id,
          additions: Number.isFinite(r.additions) ? r.additions : 0,
          deletions: Number.isFinite(r.deletions) ? r.deletions : 0,
        }))
      return append(baseEntry('user', entry.message, diffs.length ? { diffs } : {}))
    },
    // P4-5 审计 meta 条目：写日志 + entriesBySeq 记录，不进 surface.nodes（模型输入纯净）
    appendMeta(kind, extra = {}) {
      const entry = { type: 'meta', kind, id: randomUUID(), seq: nextSeq++, timestamp: new Date().toISOString(), ...extra }
      append(entry)
      entriesBySeq.set(entry.seq, entry)
      return entry
    },
    // 思考块落盘（2026-09-23）：推理模型的 thinking 此前只经 wire 实时转发、从不落盘，
    // 回放（切会话/重开/导出/蒸馏）里完全没有思考。本方法补上落盘。
    // 【投影规则，2026-10-22 修订】thinking 仍**不单独成帧**（不进 nodes ⇒ 派生消息条数不变），
    // 但 deriveMessages 会把它并回**下一条带 tool_use 的 assistant 消息**的 content 头部：
    // DeepSeek /anthropic 在思考模式下要求工具轮的 thinking 原样回传，缺块直接 400
    // 「The content[].thinking in the thinking mode must be passed back to the API」。
    // 早期实现**一律不投影**的理由是"缺 signature 会被端点拒"——现在解析器会带上
    // `signature`（真 Anthropic 校验签名；DeepSeek 等兼容端点接受空串，见
    // kernel/api.mjs#prepareMessagesForAnthropicWire），该理由只对**无签名的旧历史**成立，
    // 由该函数按端点能力丢弃，不再牺牲所有端点的工具轮回放。
    // 与 meta 的同构点仅在"不进 nodes"，差别在 seq：meta 不占 seq（在算 seq 前 continue），
    // thinking **占 seq**（保序 + 不复用）。
    // 长度不设上限（用户裁定全量落盘）。脱敏由 writeEntry 单点负责，此处不做例外——
    // 注意该单点原本不认识 thinking 字段（2026-09-23 已补上该分支），若将来新增字段形态，
    // 需同步在 kernel/redact.mjs 的块分支里覆盖，否则会明文落盘。
    appendThinking(text, opts = {}) {
      // blocks = 解析器给的**原始块**（未分段、含 signature），回放必须以它为准；
      // 无 blocks 时退回单段文本（旧调用点 / 流在 content_block_stop 前断掉的兜底）。
      const blocks = Array.isArray(opts.blocks)
        ? opts.blocks
          .filter((b) => b && typeof b.thinking === 'string')
          .map((b) => ({
            type: 'thinking',
            thinking: b.thinking,
            ...(typeof b.signature === 'string' ? { signature: b.signature } : {}),
          }))
        : []
      const entry = {
        type: 'thinking',
        id: randomUUID(),
        seq: nextSeq++,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: blocks.length ? blocks : [{ type: 'thinking', thinking: String(text ?? '') }],
        },
      }
      // model 落在 message 层（既有约定，与 assistantEntry 一致）：消费侧读 msg.model
      // （src/lib/transcriptAdapter.ts 的 typeof msg.model === 'string'，msg = entry.message），
      // 写顶层则所有按约定读的消费方都看不到。
      if (opts.model) entry.message.model = opts.model
      append(entry)
      entriesBySeq.set(entry.seq, entry)
      // 直接 append（低级原语）不会失效派生缓存：thinking 改变了"下一条 tool_use
      // assistant 的投影内容"，必须显式失效，否则同 nodes 键下会命中旧派生数组。
      thinkingSeqs.push(entry.seq)
      invalidate()
      return entry
    },
    // 已落盘条目的 usage 后挂（M1 空文本收尾轮专用：把本轮总 usage 挂到最后一条
    // 已写 assistant 条目）。内存更新 entriesBySeq 引用 + 磁盘单行改写——
    // append-only 日志的罕见例外路径，正常轮次 usage 总在最终条目写入时一次落盘。
    // 原子改写（temp+rename 防崩溃窗口截断）；改写行走 redactEntry，避免"后挂 usage"
    // 让该行脱敏失效（S2-1：append 路径落盘前打码，这里若直接 JSON.stringify 内存
    // 原文会把敏感输入以明文重写回盘）。
    setEntryUsage(entry, usage) {
      if (!entry || !usage) return entry
      entry.message.usage = usage
      const want = JSON.stringify(redactEntry(entry)) // 落盘形态（含脱敏），同时也用于幂等比较
      // disk-site: transcript-usage —— 本点落盘形态是 tmp+rename **整体替换**文件。
      // ★ 硬约束：不得改成常驻 fd（fd 会指向被 rename 掉的旧 inode ⇒ 静默丢写）；
      //   此处只外包一层遥测，读-改-写整段与 tmp+rename 形态逐字不变。
      // 失败语义**守恒**：原实现对整段读-改-写静默 catch（"磁盘不可写不致命：内存已更新"），
      // 且上游调用点 engine.mjs#finalizeUsage 无 try ⇒ 这里同样不抛（抛出去才叫改变行为）。
      diskWrite(getDiskTelemetry(), 'transcript-usage', () => {
        const text = readFileSync(file, 'utf-8')
        const lines = text.split('\n')
        // K2.4 尾部优先反查（2026-09-13 系统性优化 Task 10）：目标**几乎总是**文件末尾那一条
        // ——调用点只有 engine.mjs:1049 的终轮补 usage，补的正是最后写入的 assistant 条目。
        // 原实现是自头 findIndex + **逐行 JSON.parse**，故要付全文件的解析（实测真机最大
        // transcript 5.05MB/1155 行：全量反查 31.4ms，其中整文件重写另计 14.6ms）。
        // 现在从尾部起只扫有限条（见 TAIL_SCAN），命中即跳过整轮解析；未命中**逐字回退**到
        // 原 findIndex，语义不变。
        // 注：尾部起扫命中的是**最后**一条同 seq 行；原实现命中的是**第一条**。健康文件里
        // seq 唯一（加载侧按 max+1 重建、append 侧单调），重复只可能来自磁盘损坏——而撕裂
        // 尾部已由 K2.5 在加载侧收口。
        let idx = -1
        for (let i = lines.length - 1, seen = 0; i >= 0 && seen < TAIL_SCAN; i--) {
          const t = lines[i].trim()
          if (!t) continue
          seen++
          try { if (JSON.parse(t).seq === entry.seq) { idx = i; break } } catch { /* 坏行跳过 */ }
        }
        if (idx < 0) {
          idx = lines.findIndex((l) => {
            const t = l.trim()
            if (!t) return false
            try { return JSON.parse(t).seq === entry.seq } catch { return false }
          })
        }
        if (idx < 0) return entry // 未命中 ⇒ 不改盘（原语义；返回值由外层统一 return entry）
        if (lines[idx] === want) return entry // 幂等：盘上已是目标形态 ⇒ 连整文件重写都省掉
        lines[idx] = want
        // ★★ 2026-10-18：改用 writeFileAtomicSync（**fsync 后 rename** + rename 重试 + 失败清理）。
        //   原来是手写 `writeFileSync(tmp) + renameSync`，**没有 fsync** ⇒ 断电时可能留下
        //   半截 transcript：尾部行不完整 ⇒ 下次 resume 解析失败、或该条 usage 记录变成脏行。
        //   会话历史是**用户不可重建的数据**，值这一次 fsync 的开销（本来就要整文件重写）。
        writeFileAtomicSync(file, lines.join('\n'))
        return entry
      })
      // 落盘失败**不处理**：磁盘不可写不致命——内存已更新（原语义即静默 catch）。本点本就
      // best-effort，故这里**故意**不接返回值、不做任何分支（写成 `if (!w.ok) 重抛` 会破坏该点的
      // 静默语义，写成 `if (!w.ok) { }` 则是"有 if 无分支"的空块、会被读成漏了处理）。
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
      let prevSeq = 0 // 上一投影节点的 seq：思考块只并入"它之后、当前节点之前"的 assistant
      for (const seq of nodes) {
        const entry = entriesBySeq.get(seq)
        if (!entry) continue
        seqs.push(seq)
        messages.push(projectMessage(entry, prevSeq, seq))
        // ★ 2026-10-22（真机 400 根因）：压缩摘要节点的 seq 是"写摘要时追加"的序号，
        //   比它替换掉的整段都大；但它替换的区间末端是**被遮蔽集合的最大 seq**。若把摘要
        //   seq 当下一节点的 prevSeq，紧随摘要的保留消息会拿到「下界 > 上界」的空区间 ⇒
        //   它自己的 thinking 块漏并 ⇒ DeepSeek /anthropic 直接 400「thinking must be
        //   passed back」。thinking 条目不参与遮蔽（它们不投影、不在 sourceEventSeqs 里），
        //   所以边界必须取被遮蔽节点的最大值，而不是摘要自身的 seq。
        let boundary = seq
        if (entry.kind === 'compaction' && entry.phase === 'summary') {
          boundary = 0
          for (const s of entry.sourceEventSeqs || []) if (s > boundary) boundary = s
          if (!boundary) boundary = seq // 无遮蔽集合（异常摘要）⇒ 退回自身 seq，不放大区间
        }
        prevSeq = boundary
      }
      deriveCache = { key, messages, seqs }
      bumpRev() // 真实重建 ⇒ 派生数组身份已变（K1.4 纪元，见 deriveRev 声明处）
      return messages
    },
    // 派生纪元（K1.4）：值本身无意义，**变化**才有意义——单调不减，每次派生结果换身份即变。
    revision() { return deriveRev },
    // 由 deriveMessages() 返回的消息对象反查其 seq（对象引用一致；供压缩遮蔽区间落盘）
    seqsForMessages(covered) {
      if (!deriveCache) this.deriveMessages()
      const byRef = new Map()
      deriveCache.messages.forEach((m, i) => byRef.set(m, deriveCache.seqs[i]))
      return covered.map((m) => byRef.get(m)).filter((s) => s != null)
    },
  }
}
