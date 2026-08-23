// transcriptAdapter.ts — 内核 transcript entry → GUI Message 转换层（纯逻辑，无 IO）。
//
// 内核（yfw-kernel/claude-code，claude-code 官方同源）在磁盘写 append-only JSONL
// transcript，每行一个原始 entry（形态见下）。GUI 内存不能装 377MB 全量 transcript，
// 因此这里做"展示级裁剪"：text ≤8KB、tool_result ≤16KB、thinking ≤4KB、tool_use ≤8KB，
// 超限截断并在 metadata.originalLength 记录原始长度。裁剪是架构要求，不是可选。
//
// 实测确认的内核 entry 形态（~/.yfworking/projects/<sanitize(cwd)>/<sessionId>.jsonl）：
//   - 通用字段：type / sessionId / timestamp(ISO 字符串!) / cwd / uuid / parentUuid(根为 null)
//   - user entry：   { type:'user', message:{ role:'user', content: string | 块数组 }, ... }
//   - assistant：    { type:'assistant', message:{ role:'assistant', model, content: 块数组,
//                    usage:{ input_tokens, output_tokens }, ... }, ... }
//   - system：       { type:'system', subtype:'compact_boundary', content:'Conversation compacted',
//                    uuid, parentUuid, ... }（content 在 entry 顶层，不在 message 里）
//   - queue-op：     { type:'queue-operation', operation:'enqueue'|'dequeue', ... }
//   - 其它类型：     attachment / mode / last-prompt（展示无关，一律跳过）
//
// assistant content 块：{type:'text', text, citations?} | {type:'tool_use', id, name, input}
//                     | {type:'tool_result', tool_use_id, content, is_error?} | {type:'thinking', thinking}
// user content 数组：claude-code 会把 tool_result 作为 user 消息的 content 块回传（实测出现）。

import { sanitizeText, generateId } from './utils.ts'
import type { Message, ContentBlock } from '../types/index.ts'

/** 各块类型的展示级裁剪上限（字节/字符数）。 */
export const CROP_LIMITS = {
  text: 8192,
  tool_result: 16384,
  thinking: 4096,
  tool_use: 8192,
} as const

/** 裁剪时追加的截断后缀。 */
export const CROP_SUFFIX = '\n…[已截断]'

/** 块 id 前缀分隔符：GUI 既有格式 `${msgId}-t0`（见 utils.recoverCorruptedChatState）。 */
const BLOCK_ID_SEP = '-b'

/**
 * harness 注入型系统管道消息识别：后台任务完成通知等以 XML 信封形式作为 user 条目
 * 注入会话（实测形态：<task-notification>\n<task-id>…</task-id>…</task-notification>，
 * 另有 <system-reminder>…</system-reminder>）。这些不是用户发言，聊天界面不应展示。
 */
const HARNESS_ARTIFACT_RE = /^\s*<(task-notification|system-reminder)>/i

function isHarnessArtifactText(text: string): boolean {
  return typeof text === 'string' && HARNESS_ARTIFACT_RE.test(text)
}

/** tool_result 原始 content（string | 数组 | 对象）→ 展示字符串（拼接规则统一）。 */
function toolResultContentToString(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    // 数组 content：文本项直取，非文本项（如 {type:'image'}）JSON 化占位
    return raw
      .map((item) => (typeof item === 'string' ? item : item?.text ?? JSON.stringify(item ?? '')))
      .join('\n')
  }
  if (raw != null) {
    try { return JSON.stringify(raw, null, 2) } catch { return String(raw) }
  }
  return ''
}

/** 块类型 → 裁剪上限；image/file 无展示上限定义，原样返回。 */
function cropLimitFor(type: string): number | undefined {
  switch (type) {
    case 'text': return CROP_LIMITS.text
    case 'tool_result': return CROP_LIMITS.tool_result
    case 'thinking': return CROP_LIMITS.thinking
    case 'tool_use': return CROP_LIMITS.tool_use
    default: return undefined
  }
}

/**
 * 单块裁剪。幂等：块 metadata 已带 originalLength（说明上次已裁过）则原样返回，
 * 避免重复加载/重复转换时二次截断叠加后缀。裁剪规则：content.slice(0, limit) + CROP_SUFFIX，
 * 原长度记入 metadata.originalLength（合并保留原有 metadata）。
 */
export function cropBlock(block: ContentBlock): ContentBlock {
  if (!block || typeof block.content !== 'string') return block
  if (block.metadata && typeof block.metadata.originalLength === 'number') return block // 已裁过，幂等
  const limit = cropLimitFor(block.type)
  if (limit === undefined || block.content.length <= limit) return block
  const clipped = block.content.slice(0, limit)
  return {
    ...block,
    content: clipped + CROP_SUFFIX,
    metadata: { ...(block.metadata || {}), originalLength: block.content.length },
  }
}

/**
 * 内核 assistant 内容块 → GUI ContentBlock。
 * 返回 null 表示块类型未知/不可转（跳过该块）。
 */
function assistantBlockToGui(block: any, msgId: string, index: number): ContentBlock | null {
  const btype = block?.type
  if (btype === 'text') {
    // 内核 {type:'text', text, citations?} → GUI text 块（citations 展示无关，暂不携带）
    if (typeof block.text !== 'string') return null
    return { id: `${msgId}${BLOCK_ID_SEP}${index}`, type: 'text', content: sanitizeText(block.text) }
  }
  if (btype === 'tool_use') {
    // 内核 {type:'tool_use', id, name, input} → GUI tool_use 块，
    // input 对象 JSON 化展示（缩进 2 格），toolName 记入 metadata
    if (typeof block.name !== 'string') return null
    let inputStr = ''
    try {
      inputStr = JSON.stringify(block.input ?? {}, null, 2)
    } catch {
      inputStr = String(block.input ?? '')
    }
    return {
      id: `${msgId}${BLOCK_ID_SEP}${index}`,
      type: 'tool_use',
      content: sanitizeText(inputStr),
      metadata: { toolName: block.name, toolUseId: block.id ?? undefined },
    }
  }
  if (btype === 'tool_result') {
    // 内核 {type:'tool_result', tool_use_id, content: string|数组, is_error?} → GUI tool_result 块；
    // 数组 content 逐项 join（文本项直取，非文本项 JSON 化）
    return toolResultBlockToGui(block, msgId, index)
  }
  if (btype === 'thinking') {
    // 内核 {type:'thinking', thinking} → GUI thinking 块
    if (typeof block.thinking !== 'string') return null
    return { id: `${msgId}${BLOCK_ID_SEP}${index}`, type: 'thinking', content: sanitizeText(block.thinking) }
  }
  return null // 未知块类型：跳过（不转换）
}

/** tool_result 公共转换（assistant 与 user 内容数组共用）。 */
function toolResultBlockToGui(block: any, msgId: string, index: number): ContentBlock {
  return {
    id: `${msgId}${BLOCK_ID_SEP}${index}`,
    type: 'tool_result',
    content: sanitizeText(toolResultContentToString(block.content)),
    metadata: {
      toolUseId: block.tool_use_id ?? undefined,
      isError: block.is_error === true,
    },
  }
}

/**
 * 单 entry 转换。无法转换（类型不认识 / 内容不合法）返回 null。
 * 各分支注释标明对应的内核 entry 形态。
 */
export function transcriptEntryToMessage(entry: any): Message | null {
  if (!entry || typeof entry !== 'object') return null
  // 压缩条目（kind=compaction）是 surface 投影元数据，GUI 不渲染，折叠跳过
  if (entry.kind === 'compaction') return null
  const type = entry.type

  // —— 内核 {type:'system', subtype:'compact_boundary', content, ...}：压缩边界 → 特殊 system 消息。
  // 其它 system（api_config_changed / permission 等）由 GUI 运行时 SSE 事件驱动，历史不需要，跳过。
  if (type === 'system') {
    if (entry.subtype === 'compact_boundary') {
      const id = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : (typeof entry.id === 'string' && entry.id ? entry.id : generateId())
      return {
        id,
        role: 'system',
        content: [
          {
            id: `${id}${BLOCK_ID_SEP}0`,
            type: 'text',
            content: 'Conversation compacted',
            metadata: { compactBoundary: true },
          },
        ],
        timestamp: toTimestamp(entry.timestamp),
        parentId: undefined,
      }
    }
    return null
  }

  // —— 内核 {type:'queue-operation', operation, ...}（enqueue/dequeue 排队记录）：跳过。
  if (type === 'queue-operation') return null

  // —— 其它非 user/assistant 类型（attachment / mode / last-prompt 等）：展示无关，跳过。
  if (type !== 'user' && type !== 'assistant') return null

  const msg = entry.message
  if (!msg || typeof msg !== 'object' || msg.role !== type) return null

  const id = typeof entry.uuid === 'string' ? entry.uuid : generateId()

  // —— 内核 user entry：message.content 为 string 时转单个 text 块；为数组时逐块转。
  // 两类"非用户发言"的 user 条目在此过滤：
  //   1. harness 注入的系统管道消息（<task-notification> 等 XML 信封）——string 形态；
  //   2. tool_result 回显块——claude-code 把工具结果作为 user 消息的 content 块回传
  //      （实测出现），属内核回显而非用户发言；结果由 entriesToMessages 预扫描后
  //      挂接到对应 assistant tool_use 块，这里不单独成"用户消息"。
  if (type === 'user') {
    const content = msg.content
    const blocks: ContentBlock[] = []
    if (typeof content === 'string') {
      if (isHarnessArtifactText(content)) return null
      blocks.push(cropBlock({ id: `${id}${BLOCK_ID_SEP}0`, type: 'text', content: sanitizeText(content) }))
    } else if (Array.isArray(content)) {
      content.forEach((blk: any, i: number) => {
        if (!blk || typeof blk !== 'object') return
        if (blk.type === 'tool_result') {
          return // 回显块：跳过（见上方注释）
        } else if (blk.type === 'text' && typeof blk.text === 'string') {
          blocks.push(cropBlock({ id: `${id}${BLOCK_ID_SEP}${i}`, type: 'text', content: sanitizeText(blk.text) }))
        }
        // 其它块类型（image 等）在 user 历史里罕见，跳过即可
      })
    }
    if (blocks.length === 0) return null
    return { id, role: 'user', content: blocks, timestamp: toTimestamp(entry.timestamp) }
  }

  // —— 内核 assistant entry：message.content 块数组（text / tool_use / tool_result / thinking）。
  if (!Array.isArray(msg.content)) return null
  const blocks: ContentBlock[] = []
  msg.content.forEach((blk: any, i: number) => {
    const g = assistantBlockToGui(blk, id, i)
    if (g) blocks.push(cropBlock(g))
  })
  if (blocks.length === 0) return null

  const m: Message = {
    id,
    role: 'assistant',
    content: blocks,
    timestamp: toTimestamp(entry.timestamp),
  }
  // model / tokensUsed：内核 message 上的 model 与 usage{input_tokens, output_tokens}（实测出现）
  if (typeof msg.model === 'string' && msg.model) m.model = msg.model
  const usage = msg.usage
  if (usage && typeof usage === 'object') {
    const inTok = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
    const outTok = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
    if (inTok || outTok) m.tokensUsed = inTok + outTok
  }
  return m
}

/** 内核 timestamp 是 ISO 字符串（实测："2026-08-14T06:56:18.227Z"）；异常时回退 0。 */
function toTimestamp(ts: unknown): number {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0
  if (typeof ts === 'string') {
    const n = Date.parse(ts)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/**
 * 批量转换 + 跳过统计 + parentUuid 链恢复。
 * 1) 先按 timestamp 升序排（transcript 按写入顺序，但尾部截断/多 session 合并需时间序稳定）。
 * 2) parentUuid 处理：GUI 不强制 parentId 链，但若 entry 有 parentUuid 且对应消息也在结果里，
 *    则设 message.parentId（孤儿——父被截断/未加载——不设 parentId）。
 * @returns { messages, skipped } skipped = 无法转换的 entry 数。
 */
export function entriesToMessages(entries: any[]): { messages: Message[]; skipped: number } {
  if (!Array.isArray(entries)) return { messages: [], skipped: 0 }
  // 预扫描：user 条目里的 tool_result 回显（内核把工具结果作为 user 消息回传）。
  // 收集 tool_use_id → 结果，转换后挂到对应 assistant tool_use 块——历史展示不丢输出，
  // 又不至于让"结果"以"用户消息"气泡形式出现。结果按展示级上限裁剪（tool_result）。
  const echoes = new Map<string, { content: string; isError: boolean }>()
  for (const e of entries) {
    if (!e || e.type !== 'user' || !Array.isArray(e?.message?.content)) continue
    for (const blk of e.message.content) {
      if (!blk || typeof blk !== 'object' || blk.type !== 'tool_result' || typeof blk.tool_use_id !== 'string') continue
      const raw = toolResultContentToString(blk.content)
      if (!raw) continue
      let content = raw
      if (content.length > CROP_LIMITS.tool_result) {
        content = content.slice(0, CROP_LIMITS.tool_result) + CROP_SUFFIX
      }
      echoes.set(blk.tool_use_id, { content, isError: blk.is_error === true })
    }
  }
  let skipped = 0
  const converted: { message: Message; parentUuid: string | null | undefined }[] = []
  for (const e of entries) {
    const m = transcriptEntryToMessage(e)
    if (!m) {
      skipped += 1
      continue
    }
    converted.push({ message: m, parentUuid: e?.parentUuid })
  }
  // 时间升序；同 timestamp 时保持原顺序（Array.sort 稳定），多 session 合并时再按 id 兜底
  converted.sort((a, b) => a.message.timestamp - b.message.timestamp)
  const ids = new Set(converted.map((c) => c.message.id))
  for (const c of converted) {
    const pu = c.parentUuid
    if (typeof pu === 'string' && ids.has(pu)) c.message.parentId = pu
  }
  // 工具结果回显挂接：echo 的 tool_use_id 匹配 assistant tool_use 块（assistantBlockToGui
  // 已把内核 tool_use.id 存入 metadata.toolUseId）。
  for (const c of converted) {
    for (const b of c.message.content) {
      const tuid = b.type === 'tool_use' ? b.metadata?.toolUseId : undefined
      if (typeof tuid === 'string') {
        const echo = echoes.get(tuid)
        if (echo) b.result = { ...echo }
      }
    }
  }
  // 出口统一裁剪：无论 entry 形态（user string / assistant 块 / system），
  // 批量转换结果都必须满足展示级裁剪约束；cropBlock 幂等保证重复裁剪不二次截断。
  return { messages: cropMessages(converted.map((c) => c.message)), skipped }
}

/**
 * 批量裁剪消息块（会话加载入口用）：对每条消息的每个块做展示级裁剪。
 * 幂等：已有 originalLength 的块（重复加载/已裁过）不重复裁。
 */
export function cropMessages(messages: Message[]): Message[] {
  if (!Array.isArray(messages)) return []
  return messages.map((m) => ({ ...m, content: m.content.map((b) => cropBlock(b)) }))
}
