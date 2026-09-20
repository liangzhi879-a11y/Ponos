// EL1 线索层（S4.5④）
// ---------------------------------------------------------------------------
// 目的：经验供给从"预装全文"改为"只发索引线索"——agent 自主决定读不读、读哪条。
// 供给形态（D2）：**只发索引线索，不含正文**；支持扩展线索阅读。
//
// 渲染契约 R1–R6（注入 spec §3.2.1，逐条对应下方实现注释）：
//   R1 upgraded 恒 false，不注入 full
//   R2 每行必带 blockId（且形状合法）
//   R3 摘要走 makeSnippet（线索层放宽至 300）
//   R4 一跳锚点 ≤ INJECT_RELATED_TOPN(3)，剔除 duplicate
//   R5 可读性据实分支；未授权空间只给 related / mode:'full'
//   R6 预算按字节记账，装不下丢整行，首条无条件放入
//
// 与 unified 抽调层的关系：两者是**同一件事的两种渲染**，同时启用 ⇒ 同一批块注入两遍
// （评估 P0「双注入」的新版本）⇒ 由 shouldInjectEl1 做互斥（A20，本文件下方）。
import { makeSnippet, isBlockId } from '../shared/knowledge-core.mjs'
import { INJECT_RELATED_TOPN } from './knowledge-inject.mjs'

export const HYDRATE_EL1_MAX_BYTES = 1536   // EL1 硬上限 1.5 KB
export const EL1_SNIPPET_MAX = 300          // 线索层摘要上限（makeSnippet 默认 160 放宽至此）

/** 段头（与 EL0 的`【个人经验索引】`同为"可被 e2e needle 认出的稳定串"） */
const EL1_HEADER = '【经验线索】以下是可继续阅读的线索（只给线索，未含正文）：'

const byteLen = (s) => Buffer.byteLength(String(s), 'utf8')

/**
 * R3：摘要必须复用既有 `makeSnippet`（`shared/knowledge-core.mjs:527`）
 * —— 不要另造第二个摘要实现（单一口径）。EL1 只把 maxLen 放宽到 300。
 * ★ 实测签名是**对象参数** `makeSnippet(text, { maxLen })`，不是位置参数。
 */
function snippetOf(text, max = EL1_SNIPPET_MAX) {
  return makeSnippet(String(text ?? ''), { maxLen: max })
}

/**
 * R4：按 `why.kind` 打理由标签。
 * ★ 措辞**照抄** `kernel/knowledge-inject.mjs#anchorTextOf`（统一路径的既有口径）——
 *   两套渲染说同一件事时必须同一套措辞，否则模型要为同一个概念学两种说法。
 */
function whyLabel(why, score) {
  if (why?.kind === 'tag') return `同标签:${why.tag}`
  if (why?.kind === 'content') return `内容相似${typeof score === 'number' ? score.toFixed(2) : ''}`
  return String(why?.kind ?? '')
}

/**
 * R5：可读性三态（口径同 `kernel/knowledge-search.mjs#fullTextHint`）：
 *   `Set`  = 调用方确实放行了这些空间 ⇒ 据实分支；
 *   数组   = 同 Set（便于调用方直接传列表，此处归一）；
 *   `null`/未给 = 调用方没有可读性信息（嵌入/测试/旧调用方）⇒ **不加任何告警**（零回归口径）。
 *
 * 为何无权限时必须换措辞而不能照抄既有的「不可 Read …用 mode:'full' 重试」：
 * 本层文案里带 "Read" 会**自己**把模型引向一个必然失败的指令（R5 的用例明令禁止），
 * 故这里只给两条真正可用的替代路径（`related` 展开 / `mode:'full'`），一字不提 Read。
 */
function readabilityHint(item, opts, hasRelated) {
  if (!isReadable(item, opts)) {
    return `（本会话读不到该空间：需全文用 KnowledgeSearch {mode:'full'}，或用 {related:'${item.blockId}'} 展开一跳）`
  }
  return hasRelated ? `（展开：KnowledgeSearch {related:'${item.blockId}'}）` : ''
}

/** R5 判据：三态归一（`readable:false` 显式不可读；Set/数组按放行集判；未给 ⇒ 视为可读） */
function isReadable(item, opts) {
  if (item.readable === false) return false
  const rs = opts.readableSpaces
  const set = rs instanceof Set ? rs : (Array.isArray(rs) ? new Set(rs) : null)
  if (set) return set.has(item.space)
  return true   // 调用方未给可读性信息 ⇒ 不加告警（零回归口径，同 fullTextHint）
}

/**
 * 渲染一行线索。R2：无线索凭据（blockId 缺失或形状非法）返回 null（不渲染）。
 *
 * 为什么形状也要校验（不只判真值）：无 blockId 的行走不了 `related`（`isBlockId` 会在
 * 工具侧直接拒），渲染出来等于给模型一个必然失败的指令 —— 假阴性比不渲染更贵。
 */
export function renderRecommendLine(item, opts = {}) {
  if (!item || typeof item !== 'object' || !isBlockId(item.blockId)) return null   // R2
  const snippet = snippetOf(item.snippet ?? item.title)
  const related = (item.related || [])
    .filter((r) => r?.why?.kind !== 'duplicate' && isBlockId(r?.blockId))          // R4：剔除 duplicate
    .slice(0, INJECT_RELATED_TOPN)                                                 // R4：≤3
    .map((r) => ({ blockId: r.blockId, label: whyLabel(r.why, r.score), why: r.why }))
  const hint = readabilityHint(item, opts, related.length > 0)                      // R5
  return {
    blockId: item.blockId,
    space: item.space,
    snippet,
    related,
    hint,
    // R1：只有标题 + 摘要 + 指引，**绝无正文**（输入带 full 也不进来）
    text: `- [${item.space ?? ''}] ${item.title ?? ''} —— ${snippet} ${hint}`.trim(),
  }
}

/**
 * 构建 EL1 线索段。
 * R6：按字节记账；装不下丢**整行**（不截断行内正文）；首条无条件放入。
 *
 * `bytes` 含段头（口径同 `kernel/knowledge-inject.mjs#renderRecall`："预算必须按实际装入的
 * 字节记账，否则'新增一行说明'就是超预算的隐形入口"）。
 */
export function buildRecommendSection(items, opts = {}) {
  const budget = Number.isFinite(opts.budgetBytes) ? opts.budgetBytes : HYDRATE_EL1_MAX_BYTES
  const headerBytes = byteLen(EL1_HEADER) + 1        // +1 = 段头后的换行
  const lines = []
  const offered = []
  let dropped = 0
  let used = headerBytes
  for (const it of items || []) {
    const line = renderRecommendLine(it, opts)
    if (!line) continue                                     // R2：不渲染 ≠ 丢弃（不是预算问题）
    const b = byteLen(line.text)
    if (lines.length > 0 && used + b > budget) { dropped++; continue }   // R6
    used += b
    lines.push(line)
    offered.push(line.blockId)
  }
  if (!lines.length) return { lines, offered, dropped, bytes: 0, upgraded: false, text: '' }
  return {
    lines,
    offered,
    dropped,
    bytes: used,                             // 含段头：预算必须按实际装入的字节记账
    upgraded: false,                         // R1：恒定（本层永不升级全文）
    text: `${EL1_HEADER}\n${lines.map((l) => l.text).join('\n')}`,
  }
}

/**
 * EL1 是否生效（A18 前置 + A20 互斥 + 逃生阀）。纯函数：便于单测，不读全局状态。
 *
 *   A20 互斥：`unified` 抽调层与 EL1 做的是同一件事的两种渲染，同时启用 ⇒ 同一批块注入两遍。
 *     · `legacy`（当前生产）⇒ EL1 **生效**（补上 legacy 缺失的供给：legacy 的 recallSection 恒空）
 *     · `unified`（灰度后）⇒ EL1 **关闭**（避免双供给）
 *   A18 前置：`relateMode === 'on'`（`resolveRelateMode`，kernel/knowledge.mjs:577）。
 *   D6 逃生阀：`PONOS_MEMORY_EL1=0` —— 与 `PONOS_MEMORY_INJECT` **不耦合**
 *     （一个控制"注入总开关"，一个控制"本层是否启用"，耦合起来就没法单独回退本层）。
 */
export function shouldInjectEl1({ strategy, relateMode, enabled } = {}) {
  if (enabled !== true) return false                 // 逃生阀 PONOS_MEMORY_EL1=0
  if (relateMode !== 'on') return false              // A18 前置
  return strategy !== 'unified'                      // A20：unified 关闭 EL1，避免双供给
}
