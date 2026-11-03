// Ponos-turbo 两阶段压缩器（docs/superpowers/specs/2026-08-20-ponos-turbo-inner-core-design.md §5）
// ---------------------------------------------------------------------------
// 阶段① 免模型结构感知裁剪（ToolResultPruner）：表格采样/代码行边界/JSON 键名+错误行
// 阶段② 主模型摘要：前缀对齐主请求（KV 缓存复用）+ <compacted-summary> 9 节 checkpoint
//   ②b 分块摘要（2026-09-10 小窗口模型切换适配）：covered 超出摘要请求容量时按 turn
//      边界切成多段滚动合并（map-reduce），单发必 400 的"covered ≫ 窗口"场景也能落地。
// 切点纪律：只切 turn 边界；tool-call/result 配对不可拆；open tail 返回 null。
// 日志锁：compaction/start（占位）→ compaction/summary（落地）；孤儿 start 加载回滚。
// 免费收缩（阶段0 老化 + 阶段① 裁剪）在 maybeCompact（阈值触发）与 forceCompact
// （溢出兜底）共用——小窗口模型切换后的溢出路径同样先零成本收缩再摘要。
import { statSync, readFileSync } from 'node:fs'
import { streamMessages } from './api.mjs'
import { pickStepThinking } from './effort-policy.mjs'
import { countCjk, bumpContentEpoch } from './context.mjs'
import { extractEntities, missingEntities } from './fidelity.mjs'
import { patchOrphanToolUses } from './engine.mjs'

// P9-1：工具结果老化清除
// ---------------------------------------------------------------------------
// 零模型成本：上下文超过"老化清除阈值"时，把保留窗口之外的可重放工具
// （Read/Bash/Grep/Glob/WebFetch/OCR——结果可按需重新调用工具读取）结果整条
// 替换为占位标记。与阶段①结构采样的"每条内部保留部分"互补：这里整条丢弃，
// 体积削减更彻底；原文仍在 transcript，模型需要时重新 Read 恢复。
// Edit/Write/Agent/Task 等结果小且不可重放，一律不清。
export const CLEARED_TOOL_RESULT_MARKER = '[旧工具结果已清除——需要时重新调用工具读取]'
const REPLAYABLE_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'OCR'])
// ── T2.5（2026-10-20）：不可重放工具结果的**体积老化** ────────────────────────
// 问题（问0）：老化只看"工具是否可重放"的白名单 ⇒ Agent/Task 这类**结果可能极大**
//   （子 Agent 的完整汇报）却永远不清，一路驻留到下一次压缩（全额价）。
// 改法：由"白名单"改为「**体积阈值 + 可恢复性**」两条件同时成立才清。
//   ① 体积 > 16 KB（小结果清了只会逼模型重跑，得不偿失）；
//   ② **原文可恢复**：结果文本里必须带得出一个可回读的路径（transcript / tool-results 落盘文件）。
//      拿不到路径 ⇒ **不清**（fail-closed：清了等于把信息永久删除）。
// ★ 清掉时把路径**保留在标记里**（不是笼统的"重调用工具"）——否则子 Agent 的结论真就找不回了。
const BIG_RESULT_CLEARABLE = new Set(['Agent', 'Task'])
export const BIG_RESULT_BYTES = 16 * 1024
/** 从结果文本里抠出可回读路径（transcript 或 tool-results 落盘文件）；抠不到 = 不可恢复。 */
export function recoverableRefOf(content) {
  if (typeof content !== 'string') return null
  // 只认两种明确的落点形态（其余一律不当"可恢复"，避免拿普通文本里的斜杠路径瞎猜）
  const m = content.match(/(?:transcriptPath["'\s:]+|path=")([^"'\s]+\.(?:jsonl|json))/)
  return m ? m[1] : null
}

export function ageOutToolResults(messages, { keepRecent = 2 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  // 建立 tool_use_id → 工具名（assistant 消息的 tool_use block）
  const nameById = new Map()
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') nameById.set(b.id, b.name)
    }
  }
  // 按出现顺序记录所有 tool_result 及其是否可重放（保留窗口按"全部工具结果"计，
  // 老化语义：最近 N 条结果不论类型一律保留，只清窗口外
  // 的可重放结果——否则 Edit/Write 的紧凑结果会挤占窗口导致可清条目永远不足）
  const results = [] // { i, j, replayable }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j]
      if (b?.type !== 'tool_result') continue
      const name = nameById.get(b.tool_use_id)
      // T2.5：可清 = 可重放（既有白名单） 或（大结果 + 能给出可回读路径）
      const bigRef = BIG_RESULT_CLEARABLE.has(name) && typeof b.content === 'string'
        && Buffer.byteLength(b.content, 'utf8') > BIG_RESULT_BYTES
        ? recoverableRefOf(b.content)
        : null
      results.push({ i, j, replayable: Boolean(name && REPLAYABLE_TOOLS.has(name)), bigRef })
    }
  }
  // 保留最近 keepRecent 条（floor 1，防全清后零工作上下文）；仅窗口外的可重放结果被清
  const keep = Math.max(1, Number(keepRecent) || 2)
  const cutoff = Math.max(0, results.length - keep)
  let cleared = 0
  for (const { i, j, replayable, bigRef } of results.slice(0, cutoff)) {
    if (!replayable && !bigRef) continue
    const b = messages[i].content[j]
    // T2.5：大结果清掉时**把路径带进标记**（否则子 Agent 的结论真找不回来）；
    // 可重放工具的标记保持原样（改它会破坏既有测试与读侧判断，且它本来就能重跑）。
    const marker = bigRef ? `[旧工具结果已清除（${Buffer.byteLength(b.content, 'utf8')} B）——原文见 ${bigRef}，可 Read 补读]` : CLEARED_TOOL_RESULT_MARKER
    if (typeof b.content === 'string' && b.content !== CLEARED_TOOL_RESULT_MARKER && !b.content.startsWith('[旧工具结果已清除')) {
      b.content = marker
      bumpContentEpoch() // K1.1：原地改写 → 进程内全部估算记忆立即失效（紧邻改写点，可证无遗漏）
      cleared++
    }
  }
  return cleared
}

// ── 2026-10-19（用户裁决："做，但只清 Write/Edit 的大 payload"）──────────────────
// 背景（用户实测现场，真实 transcript 量化）：待发送上下文里，**可清的 tool_result 只占 33.9%**，
//   而 `tool_use.input` 占 **59.4%** —— 其中 Write 15.4% + Edit 5.6% = **21.5% 是纯冗余**：
//   那些正文/替换串在工具执行成功的那一刻就**已经写到磁盘上了**，对话历史里再留一份，
//   模型每次请求都要为它付 prefill 费用，而它只能回答一个从没被提出过的问题"我当时写的原文是什么"。
//   Bash 的 input（31.5%）**刻意不动**：它是"执行了什么命令"的唯一记录，且 command 本身就是
//   审计与复现的依据（清掉等于抹掉操作痕迹）。
//
// ## 三条防线（"零信息损失"不是口号，是三个必要条件）
//   ① **只清落地成功的**：按 tool_use_id 找它的 tool_result，**只有明确 is_error === false 才清**；
//      找不到 result（孤儿/被截断）或 result 是错误 ⇒ **不清**（写失败时 input 是**唯一**副本）。
//   ② **保留可回读的坐标**：`file_path` 原样保留在标记里 ⇒ 模型随时 `Read` 就能拿回当前内容。
//   ③ **保留最近的调用**（`keepRecent`）：刚写完的文件，模型下一句很可能还要接着改，
//      那时它需要 old_string 对齐语义；窗口外的才算"历史"。
//   ★ 另加一道工程防线：**跳过最后一条 assistant 消息**。`session.setEntryUsage` 会把
//     "最后一条 assistant 条目"整行重写回盘（M1 空文本收尾轮），而那是本仓唯一会把
//     内存里被原地改写过的内容**写回 transcript** 的路径。跳过它就绕开了那个窗口
//     （残留风险如实记录：若将来新增别的"整条目回写"路径，需要重新审视这条防线）。
// ★ 阈值是**量出来的**，不是拍的（真实会话实测分布：46 个 Write/Edit 调用，合计 159.5 KB）：
//     阈值     命中个数   可省字节
//     >0        42        110.1 KB
//     >512 B    39        109.4 KB
//     >1 KB     30        102.7 KB   ← 取这里
//     >2 KB     23         91.3 KB
//     >4 KB      8         49.6 KB
//     >8 KB      2         17.4 KB
//   4 KB 只命中 8 个 ⇒ 省不到 3 成；1 KB 命中 30 个、省 102.7 KB，而"1 KB 的正文"
//   在历史里本来也只够回答"我当时写了什么"——那正是本次要省掉的那类信息。
//   ★ 如实口径（别把"可回读"说过头）：磁盘上的 `Read` 给的是**当前**内容；若该文件后来
//     又被改过，那么"那一次 Write 写了什么"只剩 transcript 里有（原地改写**不落盘**，
//     除最后一条 assistant 条目那条回写路径，已由下方工程防线绕开）⇒ 本优化的准确表述是
//     **"从待发送上下文里省掉，transcript 仍留底"**，而不是"信息彻底消失于系统"。
export const TOOL_INPUT_AGE_MIN_BYTES = 1024
/** 已老化 payload 的标记前缀（幂等判据：再次老化时靠它识别"已经清过"）。 */
export const CLEARED_TOOL_INPUT_PREFIX = '[大 payload 已省略'
/** 只清这两类工具的**正文类**字段，且只清这些字段（file_path 等坐标一律保留）。 */
const INPUT_AGEABLE_FIELDS = Object.freeze({ Write: ['content'], Edit: ['old_string', 'new_string'] })


export const COMPACTION_INSTRUCTION =
  '系统压缩指令：请将以下旧对话内容压缩为一份 <compacted-summary> 结构化检查点，' +
  '包含 9 节：Goal / Progress / Blockers / Next Steps / Key Facts / Decisions / Artifacts / Open Questions / Continuation。' +
  '只输出 <compacted-summary> 与 </compacted-summary> 之间的内容，尽可能简短但保留全部关键事实、数字与决策。'

// 分块摘要中间段指令（阶段②b）：把本段内容合并进已有滚动摘要，输出合并后的完整
// 检查点——与单发指令同构（含"系统压缩指令"关键字，mock 摘要检测依赖），只多一段
// 分段说明与合并要求。末段用完整 COMPACTION_INSTRUCTION（含 keyInfo/会话记忆注入）。
export function chunkMergeInstruction(i, n) {
  return '系统压缩指令：你正在对一段很长的对话历史进行分段压缩（第 ' + i + '/' + n + ' 段）。' +
    '请把本段内容合并进请求开头的 <compacted-summary>（已有摘要），输出合并后的完整 <compacted-summary> 结构化检查点，' +
    '包含 9 节：Goal / Progress / Blockers / Next Steps / Key Facts / Decisions / Artifacts / Open Questions / Continuation。' +
    '只输出 <compacted-summary> 与 </compacted-summary> 之间的内容，尽可能简短但保留全部关键事实、数字与决策。'
}

// —— 结构感知裁剪（确定性零成本；按行操作天然不切行中）——
function detectKind(lines) {
  const head = lines.slice(0, 10).join('\n')
  // JSON 优先于逗号表格：多行 JSON / JSONL（每行含逗号且 >20 行）不得被 table 规则抢占（F1-b）。
  // 行首 {/[ 覆盖 pretty JSON 与 JSONL 首行；引号键（"key"/"name"）兜底带前缀包装的 JSON。
  if (/^\s*[{[]/.test(head) || head.includes('"key"') || head.includes('"name"')) return 'json'
  if (/[，,]/.test(head) && lines.length > 20) return 'table'
  if (lines.some((l) => /(ERROR|error|exception|stderr)/.test(l))) return 'log'
  if (/\n[\t ]*(?:const|let|function|class|import|export|def|echo|SELECT)/.test('\n' + head)) return 'code'
  return 'plain'
}

function pruneTable(lines) {
  const kept = [lines[0]]
  const step = Math.max(1, Math.floor((lines.length - 2) / 20))
  for (let i = 1; i < lines.length - 1; i += step) kept.push(lines[i])
  if (lines.length > 1) kept.push(lines[lines.length - 1]) // 合计尾行
  return kept
}
function pruneCode(lines) {
  const headCount = Math.max(5, Math.floor(lines.length * 0.15))
  const tailCount = Math.max(5, Math.floor(lines.length * 0.15))
  return [...lines.slice(0, headCount), '// …（中间省略 ' + (lines.length - headCount - tailCount) + ' 行）…', ...lines.slice(-tailCount)]
}
// 单行 minified JSON → 多行：字符串感知、在顶层结构字符后断行，供行级采样。
// 逐字符跟踪字符串状态（含反斜杠转义），避免把字符串内的逗号/花括号错当结构符。
function reflowSingleLineJson(line) {
  const out = []
  let buf = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      buf += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; buf += c; continue }
    if (c === '{' || c === '[' || c === ',' || c === '}' || c === ']') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      if (c !== ',') out.push(c)
      continue
    }
    buf += c
  }
  if (buf.trim()) out.push(buf.trim())
  return out.length ? out : [line]
}

function pruneJsonOrLog(lines) {
  // 单行超长 JSON：先重排为多行再采样，避免唯一行被 head/tail 去重后整行原样保留——
  // truncated:true 却无尺寸缩减（F1-a）。
  if (lines.length === 1) {
    const trimmed = lines[0].trim()
    if (/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed)) lines = reflowSingleLineJson(trimmed)
  }
  const errLines = lines.filter((l) => /(ERROR|error|exception|stderr)/.test(l))
  const head = lines.slice(0, 30)
  const tail = lines.slice(-10)
  const merged = [...new Set([...head, ...errLines.slice(0, 20), ...tail])]
  return merged.length ? merged : ['…']
}
function prunePlain(lines) {
  return [...lines.slice(0, 50), '…（中间省略 ' + Math.max(0, lines.length - 100) + ' 行）…', ...lines.slice(-50)]
}

export function pruneToolResult(content, { budget = 20000 } = {}) {
  const text = String(content ?? '')
  if (text.length <= budget) return { text, truncated: false, note: '' }
  const lines = text.split('\n')
  const kind = detectKind(lines)
  let keptLines
  if (kind === 'table') keptLines = pruneTable(lines)
  else if (kind === 'code') keptLines = pruneCode(lines)
  else if (kind === 'json' || kind === 'log') keptLines = pruneJsonOrLog(lines)
  else keptLines = prunePlain(lines)
  let out = keptLines.join('\n')
  if (out.length >= text.length) {
    // 兜底：行级采样未带来任何尺寸缩减（如单行 JSON 只有一个超长字符串值，
    // 重排后行数不足以触发头尾采样）→ 字节截断，保证 truncated:true 时尺寸真实下降（F1-a）。
    out = text.slice(0, Math.max(1, Math.floor(text.length * 0.5))) + '\n…（已按字节截断）'
  }
  const note =
    `已截断：原 ${text.length} 字符 / ${lines.length} 行，仅保留结构采样（${out.split('\n').length} 行）。` +
    `可对该片段追问，或我用 Read offset/limit 补读`
  return { text: out, truncated: true, note, kind }
}

// 工具结果裁剪预算解析（2026-09-10 窗口感知）：env 显式值优先（含 resolveCompactSettings
// 写入的 BYTES）；未显式时按窗口缩放——小窗口本地模型（32K → 4K 字符/条）单条工具结果
// 不再吃掉半个窗口，大窗口（1M）封顶 24K 防过度裁剪。仅显式数值生效；非数值
// 形态（Number 为 NaN）视为未显式，落入窗口缩放（安全侧）。
export function resolveToolResultBudget(env = process.env, window = 200_000) {
  const explicit = Number(env.PONOS_TOOL_RESULT_BUDGET_BYTES)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const w = Number.isFinite(window) && window > 0 ? window : 200_000
  return Math.max(4000, Math.min(24000, Math.floor(w / 8)))
}

/**
 * Write/Edit 的大 payload 老化（2026-10-19，用户裁决）。
 *
 * 把"已经写到磁盘上、且对话历史里只是重复"的正文换成一句带坐标的标记：
 *   · Write 的 `content`            —— 文件正文（落盘后历史里那份是纯冗余）
 *   · Edit 的 `old_string/new_string` —— 替换串（改动已应用，正文以磁盘为准）
 * `file_path` 等坐标字段**一律不动**（它们是回读的唯一线索，也是下游 `extractKeyInfo` /
 * 子 lane 产物登记读的字段）。
 *
 * ## 判据（顺序即优先级；每一条都是"不清"的理由）
 *   ① 工具必须是 Write/Edit（Bash 的 command 是操作痕迹，不清）；
 *   ② 该 tool_use 必须**有配对 tool_result 且 is_error === false**（写失败时 input 是唯一副本）；
 *   ③ 待清字段的合计字节 > `minBytes`（小 payload 清了只损失精度、省不了钱）；
 *   ④ 必须落在**最近 keepRecent 次** Write/Edit 之外（近期还要接着改，需要 old_string 语义）；
 *   ⑤ 不得位于**最后一条 assistant 消息**里（`setEntryUsage` 会把那条整行重写回盘，
 *      见上方三条防线的工程防线注）；
 *   ⑥ 已经带标记的跳过（幂等：重复老化不重复计数、不反复 bump epoch）。
 *
 * @param {Array<{role?: string, content?: any}>} messages 派生消息（**原地改写**）
 * @param {{ keepRecent?: number, minBytes?: number }} [opts]
 * @returns {number} 本次真正清掉的 tool_use 条数
 */
export function ageOutToolUseInputs(messages, { keepRecent = 4, minBytes = TOOL_INPUT_AGE_MIN_BYTES } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  // ④/⑤ 的边界：最后一条 assistant 消息的下标（那条一律不动）
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') { lastAssistantIdx = i; break }
  }
  // ② 配对结果：tool_use_id → 是否成功。**只认明确的 false**（找不到 result ⇒ 不算成功）
  const okById = new Map()
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      if (b.is_error === true) okById.delete(b.tool_use_id)
      else okById.set(b.tool_use_id, true)
    }
  }
  // 收集候选（按出现顺序 ⇒ ④ 的"最近"语义与 tool_result 老化同款）
  const candidates = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue
      const fields = INPUT_AGEABLE_FIELDS[String(b.name || '')]
      if (!fields) continue
      candidates.push({ i, b, fields })
    }
  }
  const keep = Math.max(0, Number.isFinite(Number(keepRecent)) ? Number(keepRecent) : 4)
  const cutoff = Math.max(0, candidates.length - keep)
  let cleared = 0
  for (const { i, b, fields } of candidates.slice(0, cutoff)) {
    if (i === lastAssistantIdx) continue                          // ⑤ 回写窗口
    if (okById.get(b.id) !== true) continue                       // ② 落地成功才清
    const input = b.input
    if (!input || typeof input !== 'object') continue
    const path = String(input.file_path || input.path || '')       // 坐标（保留）
    // ③ 体量门：先算待清字段的合计字节（含标记的字段跳过，幂等）
    let bytes = 0
    const targets = []
    for (const f of fields) {
      const v = input[f]
      if (typeof v !== 'string' || !v) continue
      if (v.startsWith(CLEARED_TOOL_INPUT_PREFIX)) continue        // ⑥ 已清过
      bytes += Buffer.byteLength(v, 'utf8')
      targets.push(f)
    }
    if (!targets.length || bytes <= minBytes) continue
    // 写标记：**保留坐标 + 体量 + 回读办法**，模型据此能自己拿回内容
    const marker = `${CLEARED_TOOL_INPUT_PREFIX}（${bytes} B）—— ${b.name} 的改动已写入 ${
      path || '目标文件'}，需要时用 Read 读取该文件]`
    for (const f of targets) input[f] = marker
    bumpContentEpoch()   // 原地改写 → 估算记忆失效（与两处 tool_result 改写同纪律）
    cleared++
  }
  return cleared
}

// 免费收缩（阶段0 老化清除 + 阶段① 结构裁剪）——零模型成本、确定性。maybeCompact
// （阈值触发）与 forceCompact（溢出兜底）共用：小窗口模型切换后的溢出路径同样先
// 免费收缩再摘要，covered 体量最小化（分块摘要段数随之减少）。age=false 时只裁剪
// 不清除（maybeCompact 老化需 est ≥ clearRatio 门控，见调用方）。
export function freeShrink(messages, { window = 200_000, env = process.env, age = true } = {}) {
  let cleared = 0
  let agedInputs = 0
  if (age) {
    cleared = ageOutToolResults(messages, { keepRecent: Number(env.PONOS_TOOL_RESULT_KEEP_RECENT || 2) })
    // 2026-10-19：Write/Edit 的大 payload（见 ageOutToolUseInputs 的三条防线）。
    // ★ 与上面那一步**同一个 age 门**：两者都是"老历史才清"的同一类动作，
    //   分开设门只会让"何时清什么"变得不可预测。
    agedInputs = ageOutToolUseInputs(messages, {
      keepRecent: Number(env.PONOS_TOOL_INPUT_KEEP_RECENT ?? 4),
      minBytes: Number(env.PONOS_TOOL_INPUT_AGE_MIN_BYTES ?? TOOL_INPUT_AGE_MIN_BYTES),
    })
  }
  const budget = resolveToolResultBudget(env, window)
  let prunedAny = false
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_result' || typeof b.content !== 'string') continue
      const r = pruneToolResult(b.content, { budget })
      if (r.truncated) {
        b.content = r.text + '\n\n' + r.note
        bumpContentEpoch() // K1.1：同 ageOutToolResults——原地改写点之一（详见 context.mjs 的清单）
        prunedAny = true
      }
    }
  }
  // ★ agedInputs 单独回报（不并进 cleared）：两者清的**不是同一种东西**，
  //   日志/判据要能分别看见"清了几条工具结果"与"省略了几个大 payload"
  //   （用户实测时正是靠这个区分才知道到底是哪一半在起作用）。
  return { cleared, agedInputs, prunedAny, budget }
}

// —— 切点纪律 ——
// messages = deriveMessages() 结果（不含 system）。切点 start 处必须是真实 user 消息
// （保留尾巴从新 turn 开始，遮蔽 [0, start) 结束于完整 turn 回复之后）。
// user 角色消息含两种：真实轮次起点 / tool_result 续接——只有前者可作为保留起点，
// 否则会拆散 assistant tool_use 与其 tool_result 配对。
function isTurnStart(m) {
  return m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
}

// 工具批次起点：assistant 消息里带 tool_use（= 一次工具调用的发起端）。
// ★ 只在**条数预算生效且仍超预算**的向前对齐里当作可接受的切点（见 findCutPoint 的
//   2026-10-22 修正）——正常路径仍只认真实 user 起点，短会话行为逐字不变。
//   为什么这样切是安全的：tool_use 在保留侧、它的 tool_result 紧随其后 ⇒ 配对不被拆散；
//   摘要条目插在它前面（assistant + 字符串），与它相邻的 assistant 由 API 合并成一轮。
function isToolBatchStart(m) {
  return m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_use')
}

// 已密封的压缩摘要：落地后被投影成 **assistant + 字符串 content** 的那一条
// （见 kernel/session.mjs#compactionSummaryEntry）。真实 assistant 文本是数组 content。
// 用途：`covered` 若只剩这种东西，摘要只能产出"摘要的摘要"（条数零收益、纯付费空转）。
function isSealedSummary(m) {
  return m?.role === 'assistant' && typeof m?.content === 'string'
}

function hasNovelContent(covered) {
  return Array.isArray(covered) && covered.some((m) => !isSealedSummary(m))
}

// `maxKeptMessages` 必须**可选**：A4 限幅兜底的那两处调用（摘要请求装不下时加大
// retainTokens 重试）刻意不传它——那是"宁可少遮蔽也要能摘"的退让路径，不该再被条数
// 预算二次收紧。声明成必填会让 tsconfig.backend 报 2 个 TS2345（kit T3 红）。
export function findCutPoint({ messages, retainTokens, estimateMessage, maxKeptMessages = undefined }) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const last = messages[messages.length - 1]
  // open tail：最后一条 assistant 带 tool_use → 进行中 turn 不可切
  if (last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b?.type === 'tool_use')) return null
  // 从尾部向前累计保留预算（保留 = [idx, end)）
  let acc = 0
  let idx = messages.length
  while (idx > 0 && acc < retainTokens) { idx--; acc += estimateMessage(messages[idx]) }
  // ★★ 2026-10-19 条数预算（retainTokens 之外的**第二个**保留约束）：
  //   问题是**条数门与摘要保留策略脱耦**。retainTokens 只管 token，保留区条数不受
  //   `maxMessages` 任何约束 ⇒ 摘要后条数 = 1(摘要) + 保留区，实测 217/312 仍远超 120
  //   ⇒ `countSolved` 永远 false ⇒ 每 3 轮重复摘要一次、收益递减，直到 `no-convergence`
  //   （调试版重启后 03:14:04→03:14:46→03:15:07 连摘三次，第三次 ok=false）。
  //   修法：把保留区条数也压到预算内（`idx` 往右推 = 保留更少 = 遮蔽更多）。
  //   ⇒ 一次摘要就能把条数真正落到门下，不是"差 6 条就摘 6 条"（后者摘要在条数上零收益：
  //   摘要自身要占 1 条，且固定开销通常 500–2000 token，比 6 条短消息还长）。
  // ★ 无需额外加 `messages.length > maxKeptMessages` 条件：`minIdx` 为负时
  //   `idx < minIdx` 天然不成立（idx ≥ 0 > 负数）⇒ 小会话逐字不变。
  //   （曾加过该条件，变异测试证明它**测不到效果**、属冗余，已删。）
  if (Number.isFinite(maxKeptMessages) && maxKeptMessages > 0) {
    const minIdx = messages.length - maxKeptMessages
    if (idx < minIdx) idx = Math.max(1, minIdx)
  }
  const countBudgetOn = Number.isFinite(maxKeptMessages) && maxKeptMessages > 0
  // 起点向后（向更早）对齐到最近完整 turn 边界：保留起点优先取真实 user 消息。
  // 估算位置落在工具回合中间时，把整轮收回保留区，遮蔽区间相应前移——保证
  // assistant tool_use 与其 tool_result 配对不因切点拆散。
  let start = idx
  while (start > 0 && !isTurnStart(messages[start])) start--
  // 往前没走到真实 turn 起点（`start` 退到 0）：改从 `idx` 往**后**找最近的起点。
  // 这类会话的真实 user 回合极稀疏（实测某长会话 363 条里只有 5 个：86/138/203/294/306），
  // 一路退到 0 会直接判"无切点" ⇒ 摘要永不落地 ⇒ 条数门永远收不了口。宁可少遮蔽，
  // 也要能切：往后找的起点一定 ≥ 1，且有真实 user 边界 ⇒ tool 配对仍然完整。
  // ★ 只在**条数预算确实生效**（消息数超预算）时启用：小会话必须逐字保持 HEAD 行为。
  //   实测教训：无条件往后找会让「msgs=5」这种本该 no-cut-point 的短会话凭空产生
  //   一个"覆盖极少"的摘要，打乱 engine 的 post-compaction 时序
  //   （engine-cache-obs-sequence 裁定C端到端 因此红）。
  // ★★ 2026-10-22 修正（真机形态）：长工具循环里真实 user 起点只有会话开头一个，
  //   而「只认真实 user 起点」的向前搜索会 **break 在第一个非起点** ⇒ start 停在
  //   紧邻上一条摘要的 index 1 ⇒ covered = [旧摘要]（落盘 n=1）⇒ 摘要零收益、
  //   compactCount 虚高（实测 3431 条会话 / 158 次 compaction，其中 140 次 n=1）。
  //   条数预算生效且仍超预算时，把 **assistant 工具批次起点**也视为可接受的切点：
  //   tool_use 与其 tool_result 同在保留侧（配对不拆），摘要条目插在它前面。
  //   仍**只**在这两条向前对齐里放宽；向后对齐保持真实 user 起点（HEAD 行为不变）。
  const acceptableStart = (m) => isTurnStart(m) || (countBudgetOn && isToolBatchStart(m))
  if (start <= 0 && countBudgetOn && messages.length > maxKeptMessages) {
    let nxt = Math.max(1, idx)
    while (nxt < messages.length && !acceptableStart(messages[nxt])) nxt++
    start = nxt < messages.length ? nxt : -1
  }
  // 条数预算二次对齐：往前对齐可能把保留区撑超预算 ⇒ 改为往后找更近的切点
  // （真实 user 起点，或条数预算下的 assistant 工具批次起点）。
  if (countBudgetOn) {
    while (start > 0 && messages.length - start > maxKeptMessages) {
      let nxt = start + 1
      while (nxt < messages.length && !acceptableStart(messages[nxt])) nxt++
      if (nxt >= messages.length) break
      start = nxt
    }
  }
  // ★★ 兜底（2026-10-19）：**不能返回 null** —— null 意味着摘要永不落地、条数无限涨
  //   （正是用户最初的抱怨）。但注意「兜底」的正确形态只有上面这一步**往后找**：
  //   若 `idx` 之前没有起点（上面已退到 0）、`idx` 之后也没有（往后找落空），那就**真的
  //   无法切**（整个会话没有可用的 turn 边界），此时返回 null 是对的。
  //   ★ 实测教训：我曾在这里再写一段"从 idx 往前找最近起点"，它是**死代码** ——
  //   上面那段已经证明 [1, idx] 无起点，再找必然也找不到（变异测试抓出：把它删掉
  //   判据② 仍全绿）。已删除，不留假兜底。
  if (start <= 0 || start >= messages.length) return null
  return { start, covered: messages.slice(0, start) }
}

// —— 阶段②b：分块摘要（map-reduce；2026-09-10 小窗口模型切换适配）——
// 切换小窗口模型 / 超长会话时 covered 远超摘要请求容量（limit − 输出预算 − 余量）：
// 单发摘要在新窗口下自身必 400（A4 限幅最多翻倍 4 次仍装不下）→ 压缩永不落地，
// 每轮撞 400 被迫 forceCompact（用户侧表现：切换本地模型后任务不可续）。分块把
// covered 按 turn 边界切成每块 ≤ chunkBudget 的段落逐块滚动合并（前块摘要作为
// <compacted-summary> 前缀注入下一块请求），压缩请求恒装得下小窗口。
// 切块纪律：新块永远从真实 user turn 起点开始（与 findCutPoint 同纪律，tool 配对
// 不可拆）；单条消息/单个 turn 超预算时自成一块（不拆消息——该块请求面超限由
// 400 自愈兜底，优于撕裂消息链）。返回的块保序且并集 = covered。
export function splitCoveredIntoChunks({ covered = [], chunkBudget, estimateMessage }) {
  if (!Array.isArray(covered) || covered.length === 0) return []
  const budget = Number.isFinite(chunkBudget) && chunkBudget > 0 ? chunkBudget : 4096
  const chunks = []
  let cur = []
  let curTokens = 0
  for (const m of covered) {
    const t = estimateMessage ? Math.max(1, estimateMessage(m)) : 100
    // 已达预算且下一条是 turn 起点 → 收块（下一块从完整 turn 开始，不拆配对）
    if (cur.length && curTokens + t > budget && isTurnStart(m)) {
      chunks.push(cur)
      cur = []
      curTokens = 0
    }
    cur.push(m)
    curTokens += t
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

// —— L1-1 关键信息保留：摘要请求注入结构化提示（零成本确定性提取）——
// TodoWrite 整表重写 → 最后调用即权威清单；Write/Edit 记录文件变更；
// 最近 assistant 文本作为决策上下文。todo 取最后 3、文件取最后 8 防溢出。

// 行内思考清洗（2026-09-09 记忆污染修复）：弱模型（vLLM Qwen 等）把思考作为
// 行内文本输出，随 assistant 文本进入 decisions → 写入会话工作记忆 → 压缩时读回
// 注入。思考原文（尤其 </think> 标签）会令弱模型模仿"想完即停"，必须清洗。
// 两种形态（实测 Qwen3.8-27B 均有）：
//   a. 成对 <think>...</think>：整块删除（未闭合截断形态删到末尾）
//   b. 孤儿 </think>（无开头标签，思考文字直接起头、以 </think> 收尾）：从头删到
//      该 </think>（含）——此形态的 </think> 前全是思考，正文在其后
// 无标签快路径原样返回；清洗后 trim。
export function stripInlineThink(text) {
  const s = String(text ?? '')
  if (!s.includes('<think') && !s.includes('</think>')) return s
  let out = s
  let idx = out.indexOf('<think')
  while (idx >= 0) {
    const end = out.indexOf('</think>', idx + 6)
    if (end < 0) return out.slice(0, idx).trim() // 未闭合：截断形态，删到末尾
    out = out.slice(0, idx) + out.slice(end + 8)
    idx = out.indexOf('<think')
  }
  // 孤儿 </think>（无开头标签）：以最后一个 </think> 为界，之前视为思考正文
  // 一并删除（实测形态：思考文字直接起头、以 </think> 收尾、正文在其后）。
  // 取舍：若真实正文里引用 </think> 字面量且位于末尾，会一并被删——清洗优先于
  // 保留（记忆污染对弱模型的伤害大于丢一句引用）。
  if (out.includes('</think>')) {
    const last = out.lastIndexOf('</think>')
    out = out.slice(last + 8)
  }
  return out.trim()
}
export function extractKeyInfo(messages = []) {
  const todos = []
  const files = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_use') continue
      const input = b.input || {}
      if (b.name === 'TodoWrite') {
        const items = (Array.isArray(input.todos) ? input.todos : [])
          .map((t) => t?.content ?? t?.task ?? '')
          .filter((x) => String(x).trim())
        if (items.length) todos.push(items.join(' / '))
      } else if (b.name === 'Write' || b.name === 'Edit') {
        files.push(`${b.name} ${input.file_path ?? input.path ?? '?'}`)
      }
    }
  }
  const decisions = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) return m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ')
      return ''
    })
    // 行内思考清洗在过滤前：纯思考条清洗后为空即丢弃，slice(-2) 取"最近 2 条非空决策"
    .map((t) => stripInlineThink(t))
    .filter((t) => t.trim())
    .slice(-2)
  // ★ 2026-10-26 M3 工作记忆保底：`decisions` 记的是**模型自己说了什么**，不是**用户要什么**。
  //   长任务压缩后最常见的失效不是"忘了结论"，而是"忘了当前这一轮到底在完成哪件事"
  //   （工具循环里 assistant 文本全是过程叙述，摘要器很容易把它抽象成"持续调试中"）。
  //   ⇒ 额外保留最近 3 条**真实用户任务**（排除 tool_result 回灌的伪 user 消息），各截 200 字。
  //   只进 `<key-info>`（摘要请求的 must-keep 提示），不进保真审计基准——审计基准取自
  //   covered 消息的 mustKeepFacts()，与本块无耦合（见 auditSummaryFidelity 注释）。
  const userAsks = messages
    .filter((m) => m?.role === 'user')
    .filter((m) => !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')))
    .map((m) => {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) return m.content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ')
      return ''
    })
    .map((t) => String(t).replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0)
    .slice(-3)
    .map((t) => t.slice(0, 200))
  return { todos, files, decisions, userAsks }
}

export function keyInfoBlock(key) {
  const lines = []
  // 任务脉络放最前：摘要器对"块首行"的保留率最高，而"用户到底要什么"是长任务里最该守的。
  if (key.userAsks?.length) lines.push(`- 用户任务脉络（最近 ${key.userAsks.length} 条，原文摘录）：${key.userAsks.join(' ｜ ')}`)
  if (key.todos.length) lines.push(`- 任务清单：${key.todos.slice(-3).join('；')}`)
  if (key.files.length) lines.push(`- 文件变更：${key.files.slice(-8).join('，')}`)
  if (key.decisions.length) lines.push(`- 最近决策：${key.decisions.join(' | ').slice(0, 500)}`)
  if (!lines.length) return ''
  return '（关键信息提示——摘要必须保留以下内容：）\n<key-info>\n' + lines.join('\n') + '\n</key-info>'
}

// 压缩点保真审计（2026-09-12 spec §4.1：docs/superpowers/specs/2026-09-12-context-fidelity-health-design.md）
// ---------------------------------------------------------------------------
// 摘要落地时核对"关键事实有没有丢"——丢事实是失真的最隐蔽形式（摘要读起来通顺，
// 但后续推理建立在错误前提上）。方法 A 确定性（零模型成本，只发现字面丢失），
// 方法 B LLM 审计（发现"被改写"，如 MySQL→PostgreSQL，最高只计 medium）。
// 只读不写：审计结论经 onCompactionAudit 交给 health，落地流程不受其影响。
/**
 * 压缩点保真审计：确定性比对"关键实体是否在摘要里"（零模型成本）。
 * @param {{ covered?: any[], summary?: any, minEntities?: number }} [opts]
 */
export function auditSummaryFidelity({ covered, summary, minEntities = 3 } = {}) {
  try {
    const list = Array.isArray(covered) ? covered : []
    const texts = []
    for (const m of list) {
      if (!m) continue
      if (typeof m.content === 'string') { texts.push(m.content); continue }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (typeof b?.content === 'string') texts.push(b.content)
          else if (typeof b?.text === 'string') texts.push(b.text)
        }
      }
    }
    // 只取"高信号实体"（路径/数字/反引号/常量/模型名）：通用词会把缺失率稀释掉，
    // 而缺失率是本信号的判定依据
    const entities = extractEntities(texts.join('\n'), { max: 120, kinds: 'key' })
    const miss = missingEntities(entities, summary)
    // 判定基准 = 摘要被**明确要求**保留的事实（`<key-info>` 契约：任务清单/文件变更/最近决策），
    // 见 keyInfoBlock()——它随请求一起发给摘要器，原文是"摘要必须保留以下内容"。
    //
    // why 不拿"原文抽到的全部实体"当分母（2026-09-17 修复"压缩一次就报失真"）：
    // 摘要是原文的**抽象**，长度只有其 1/30–1/140。要求它在逐字意义上包含原文的 120 个实体，
    // 在物理上做不到——实测真实会话 8 次压缩，该口径的缺失率恒为 61–98%（均值 80%），
    // 永远 ≥ 强证据阈值 0.4 ⇒ 每次压缩都判红（用户报告"压缩一次就失真"），门禁亦 8/8 拦下
    // （每次压缩都白跑一次重压，是真实成本损耗）。换成"被要求保留的事实"基准后，同一批真实
    // 压缩降到 12–32%（均值 21%）、0/8 判红，而"真把关键事实丢了"仍会被抓到（该口径对
    // 人为丢弃 must-keep 的摘要给出 100%）。
    // 旧口径保留在 raw 字段，供诊断与回归对比，不再参与判定。
    //
    // 第二轮回修（2026-09-17，同夜）：首版换成 must-keep 后仍有 33/154（21%）判红——
    // 因为 must-keep 是从 `<key-info>` **整块文本**抽实体，把三类噪声也当成"必须保留"：
    //   ① 包裹标签自身（`<key-info>` 抽出实体 "key-info"，每次必然缺 1 项）；
    //   ② 一次性工作产物（scratch/ 探针、commit-msg.txt、verify 脚本、日志）——摘要本就不该复述；
    //   ③ 非事实碎片（纯数字与比值 `1/4`、字母串 `M/L/H/…`、CSS 几何值 `26px 24px 14px`、`polygon(...)`）。
    // 现改为 `mustKeepFacts()`：只取**实质事实**（文件路径/标识符），剔除上述噪声。
    const mustKeep = mustKeepFacts(list)
    // 基准不足（无法从 key-info 取到实质事实）时**不做判定**，而不是回落旧口径——
    // 旧口径已知会饱和（分母与摘要容量无关），回落等于把已修的误报重新引入。
    // 宁可不出声：无从判断时误报比漏报更有害（会让用户对整个健康度失去信任）。
    if (mustKeep.length < minEntities) {
      return {
        entities: mustKeep, missing: [], total: mustKeep.length, ratio: 0, skipped: true,
        raw: { entities, missing: miss.missing, total: miss.total, ratio: miss.ratio },
        skipReason: mustKeep.length ? 'basis-too-small' : 'no-basis',
      }
    }
    const judged = missingEntities(mustKeep, summary)
    const raw = { entities, missing: miss.missing, total: miss.total, ratio: miss.ratio }
    const mustMiss = judged
    return {
      entities: mustKeep,
      missing: judged.missing,
      total: judged.total,
      ratio: judged.ratio,
      skipped: false,
      // 失真量（token 估算）：用户可读的"这次压缩丢了多少"，供健康度分级与建议使用
      lostTokens: judged.missing.reduce((n, e) => n + approxTokens(e), 0),
      // 基准的 token 总量：供健康度把"失真量下限"按基准规模缩放——
      // 否则基准本身很小时（如 8 个短路径 ≈ 40 token），"关键事实全丢"也过不了绝对下限，
      // 真信号会被下限挡掉（本文件回归用例 ④ 就是钉这个）。
      basisTokens: mustKeep.reduce((n, e) => n + approxTokens(e), 0),
      mustKeep: { total: mustKeep.length, missing: mustMiss.missing.length, ratio: mustMiss.ratio },
      raw,
    }
  } catch { return { entities: [], missing: [], total: 0, ratio: 0, skipped: true } }
}

/** 一次性工作产物：scratch/探针/提交信息/日志/构建脚本等——按定义可丢弃，不该要求摘要复述。 */
export function isTransientArtifact(e) {
  const s = String(e ?? '')
  return /(^|[\\/])(scratch|tmp|temp|logs?|coverage|tool-results|verify-final|apps-staging)([\\/]|$)/i.test(s)
    || /(^|[\\/])\.trae([\\/]|$)/i.test(s)                       // 一次性构建/导出脚本目录
    || /(^|[\\/])tmp[-_][^\\/]*$/i.test(s)                       // tmp-xxx 临时文件
    || /(^|[\\/])_[a-z]+_append\d*\./i.test(s)                   // 临时追加文件
    || /(^|[\\/])(commit-msg|probe|diag|verify)[-_]?[^\\/]*$/i.test(s)
    || /\.(log|tmp|bak)$/i.test(s)
}

/**
 * 是否"实质事实"（值得要求摘要保留）：文件路径，或不含空白的、足够长的标识符。
 * 剔除实测噪声：纯数字/比值/日期（`1/4`、`19/19`、`2026-09-17`）、字母串（`M/L/H/V`）、
 * CSS 几何值（`26px 24px 14px`）与函数（`polygon(...)`）、过短词、以及 `<key-info>` 这类标记。
 * 为什么必须筛：`kinds:'key'` 的口径会把数字与常量都当实体，粒度过细——把它们计入
 * "必须保留"会让缺失率被噪声推高（实测残余误报里绝大多数是这类碎片）。
 */
export function isSubstantiveFact(e) {
  const s = String(e ?? '')
  if (!s || s.length < 6) return false
  if (/\s/.test(s)) return false                                              // 含空格：非单一事实
  if (/^\d+([/:.\-]\d+)*$/.test(s)) return false                              // 纯数字/比值/日期
  if (/^[A-Z](\/[A-Z])+$/.test(s)) return false                               // 字母串 M/L/H/V
  if (/^\d+(px|em|rem|%)(\s+\d+(px|em|rem|%)?){1,}$/.test(s)) return false    // CSS 尺寸组
  if (/^(polygon|translate|rotate|scale|calc|min|max|matrix)\(/i.test(s)) return false
  if (/^(key-info|session-memory|compacted-summary|summary|MILESTONE|MILESTONES|MILESTONE-OK)$/i.test(s)) return false
  return true
}

/**
 * 判定基准：摘要被**明确要求**保留的**实质事实**（`<key-info>` 契约的内容，剔除噪声）。
 * 取结构化字段（任务清单/文件变更/最近决策）而非 keyInfoBlock 的整块文本——
 * 后者含包裹标签，会稳定产出一个永远缺失的 "key-info" 噪声项。
 */
export function mustKeepFacts(covered) {
  const key = extractKeyInfo(Array.isArray(covered) ? covered : [])
  // 注意：`files` 是**字符串数组**（形如 "Write /a/b.mjs"），不是对象数组——
  // 早期版本按 `f.action/f.path` 取，取到 undefined 导致基准塌陷、误回落旧口径。
  const files = key.files.slice(-8)
  const text = [
    key.todos.length ? `任务清单：${key.todos.slice(-3).join('；')}` : '',
    files.join('，'),
    key.decisions.length ? `最近决策：${key.decisions.join(' | ').slice(0, 500)}` : '',
  ].filter(Boolean).join('\n')
  if (!text) return []
  return extractEntities(text, { max: 60, kinds: 'key' })
    .filter((e) => isSubstantiveFact(e) && !isTransientArtifact(e))
}

/**
 * 近似 token 数：CJK 约 1 token/字，其余约 4 字符/token（与内核其它估算同量级）。
 * 只用于"失真量"的可读量级（"丢了约 N token"），不参与任何精确预算。
 */
export function approxTokens(s) {
  const t = String(s ?? '')
  if (!t) return 0
  const cjk = (t.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length
  return Math.max(1, Math.round(cjk + (t.length - cjk) / 4))
}

// P0-2（2026-09-16）：保真门禁的判据。`auditSummaryFidelity` 只产出**审计**，
// 本函数把审计变成**写入决策的输入**——换切点重压前必须先问它。
//
// 阈值刻意保守，因为两种判错方向的代价极不对称：
//   · 该拦没拦（漏拦）→ 一份低保真摘要落地 = 与改前**相同**，不劣化现状；
//   · 不该拦却拦（滥拦）→ 又要跑一次完整摘要调用（数百秒级 + token 成本），
//     且这段延迟由用户等。
// 故只在"证据确凿的大面积丢失"（≥3 个高信号实体 **且** 缺失率 ≥50%）才付重压代价。
// 两个条件取**与**：单看比例，3 个实体丢 2 个就是 0.67，样本太小不足为凭。
export const FIDELITY_GATE_MIN_MISSING = 3
export const FIDELITY_GATE_RATIO = 0.5

/**
 * 重压闸门：只在"证据确凿的大面积丢失"时才付重压代价（见上方长注释）。
 * @param {{ covered?: any[], summary?: any }} [opts]
 */
export function fidelityGate({ covered, summary } = {}) {
  const audit = auditSummaryFidelity({ covered, summary })
  const pass = audit.skipped
    || audit.missing.length < FIDELITY_GATE_MIN_MISSING
    || audit.ratio < FIDELITY_GATE_RATIO
  return { pass, audit }
}

const FIDELITY_AUDIT_INSTRUCTION = [
  '你是事实保真审计器。对比下面的【原文摘录】与【摘要】，只报告"原文里有、摘要丢了或被改写"的关键事实。',
  '只输出 JSON，不要任何其他文字：',
  '{"ok":true,"missing":["原文有而摘要完全丢失的关键事实（路径/数字/约束/决策）"],"rewritten":["被改写的事实，格式 原值→新值"]}',
  '若没有丢失或改写，输出 {"ok":true,"missing":[],"rewritten":[]}。不要报告措辞差异。',
].join('\n')

/**
 * 构造保真审计请求（LLM 审计，发现"被改写"）。
 * @param {{ excerpt?: any, summary?: any }} [opts]
 */
export function buildFidelityAuditRequest({ excerpt, summary } = {}) {
  const ex = String(excerpt ?? '').slice(0, 12_000)
  const sm = String(summary ?? '').slice(0, 6_000)
  return [{
    role: 'user',
    content: `${FIDELITY_AUDIT_INSTRUCTION}\n\n【原文摘录】\n${ex}\n\n【摘要】\n${sm}`,
  }]
}

export function parseFidelityAudit(text) {
  const empty = { ok: false, missing: [], rewritten: [] }
  try {
    let t = String(text ?? '')
    if (!t.trim()) return empty
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
    if (fence) t = fence[1]
    else {
      const start = t.indexOf('{')
      const end = t.lastIndexOf('}')
      if (start >= 0 && end > start) t = t.slice(start, end + 1)
    }
    const obj = JSON.parse(t)
    if (!obj || typeof obj !== 'object') return empty
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, 10) : [])
    return { ok: obj.ok === true, missing: arr(obj.missing), rewritten: arr(obj.rewritten) }
  } catch { return empty }
}

// P9-3：会话工作记忆（session memory）
// ---------------------------------------------------------------------------
// 轮末把关键状态（todo/文件变更/最近决策）增量写入独立文件；压缩时读文件作为
// 摘要事实来源，注入摘要请求——摘要不再依赖"对话全文的一次性有损概括"，且
// 已压缩区间 sealed 后（P9-2）新摘要只针对增量，连续压缩质量不随次数衰减。
// 文件路径由调用方（cli.mjs）注入：<configDir>/memory/session/<sessionId>.md
export function buildSessionMemoryText(key) {
  const lines = ['# 会话工作记忆（自动维护，压缩时作为摘要事实来源）']
  if (key.todos.length) lines.push('\n## 任务清单', ...key.todos.slice(-5).map((t) => `- ${t}`))
  if (key.files.length) lines.push('\n## 文件变更', ...key.files.slice(-12).map((f) => `- ${f}`))
  if (key.decisions.length) lines.push('\n## 最近决策', ...key.decisions.map((d) => `- ${d.slice(0, 300)}`))
  return lines.join('\n')
}

// —— 摘要请求组装（前缀对齐主请求：system + 旧消息 + 前次摘要 + 指令 + keyInfo）——
// P9-2 sealed：covered 中已压缩的 compaction summary 条目（字符串 content 的
// assistant 消息）一律过滤——其内容已体现在 lastSummary，重塞回请求只会让模型
// "对摘要的摘要再摘要"（层级坍缩，业界 re-compaction penalty 实测 15.9pp 精度
// 损失）。每次摘要只针对"尚未压缩的新消息"，连续压缩质量不随次数衰减。
export function assembleSummaryRequest({ system, messages, cut, lastSummary, keyInfo = '', sessionMemory = '' }) {
  const covered = (cut.covered || []).filter((m) => !(m?.role === 'assistant' && typeof m?.content === 'string'))
  const patched = patchOrphanToolUses(covered) // 审计 #2：摘要请求前补齐孤儿 tool_use（防 400）
  const body = []
  if (lastSummary) body.push({ role: 'user', content: `<compacted-summary>${lastSummary}</compacted-summary>` })
  body.push(...patched)
  const smBlock = sessionMemory && sessionMemory.trim()
    ? `\n\n（会话工作记忆——保留其中所有未过时事实：）\n<session-memory>\n${sessionMemory.trim().slice(0, 5000)}\n</session-memory>`
    : ''
  body.push({
    role: 'user',
    content: COMPACTION_INSTRUCTION + (system ? `\n\n（系统提示开头：${String(system).slice(0, 200)}…）` : '') +
      (keyInfo && keyInfo.trim() ? `\n\n${keyInfo}` : '') + smBlock,
  })
  return body
}

export function extractSummary(text) {
  const m = String(text ?? '').match(/<compacted-summary>([\s\S]*?)<\/compacted-summary>/)
  return m ? m[1].trim() : null
}

// —— 压缩器编排（pre-step 测压 / forceCompact 溢出兜底）——
export function createCompactor({ session, context, model, maxTokens, wire, health, signal, env = process.env, sessionMemoryPath = null, onCompactionAudit = null }) {
  // P9-3：压缩时读取会话工作记忆文件，注入摘要请求作为事实来源（文件不存在/读失败静默降级）
  let sessionMemoryCache = ''
  let sessionMemoryReadAt = 0
  function readSessionMemoryFile() {
    if (!sessionMemoryPath) return ''
    try {
      const st = statSync(sessionMemoryPath)
      if (st.mtimeMs !== sessionMemoryReadAt) {
        sessionMemoryCache = readFileSync(sessionMemoryPath, 'utf-8').slice(0, 6000)
        sessionMemoryReadAt = st.mtimeMs
      }
      return sessionMemoryCache
    } catch { return sessionMemoryCache }
  }
  let summaryInFlight = false
  let lastSummary = null
  let consecutiveFailures = 0
  // ★ 2026-10-18 ENG-08：免费收缩"连续收不动"计数。
  //   条数触发但 token 未过线时，原设计只做免费收缩、不付费摘要。
  //   若免费收缩**压根压不动**（消息由大量不可裁剪的小消息构成），条数会无限增长而无人察觉。
  //   连续 N 次收不动 ⇒ 认定免费路径无解，升级一次付费摘要（见下方 shouldCompact）。
  let consecutiveCountNoShrink = 0
  // P1-5：压缩熔断——摘要连续失败达到上限即停止（防对不可救药的超限上下文烧 API）。
  // 免模型 pruner 不受熔断影响（零成本）；forceCompact（溢出兜底）熔断后直接拒绝，
  // engine 侧收到 'overflow-compact-failed' 收尾而非无限重试。
  const CIRCUIT_LIMIT = 3
  // A3 熔断冷却复位（2026-09-09 事故修复）：熔断原为"永久"——摘要失败 3 次后
  // 模型压缩被禁用到底，上下文从此失控（当天实测 0 条 compaction 落地、请求
  // 膨胀到 17 万 token、每步 5-13 分钟）。冷却制：每 5 次 pre-step 或上下文较
  // 熔断时增长 20% 即复位重试一次；成功摘要照旧清零。
  let circuitOpenedAt = 0
  let preStepCallsSinceOpen = 0
  let contextEstAtOpen = 0
  function circuitGate(currentEst) {
    if (consecutiveFailures < CIRCUIT_LIMIT) return true
    if (!circuitOpenedAt) { circuitOpenedAt = Date.now(); contextEstAtOpen = Number(currentEst) || 0; preStepCallsSinceOpen = 0 }
    preStepCallsSinceOpen++
    const grown = contextEstAtOpen > 0 && Number(currentEst) > 0 && Number(currentEst) >= contextEstAtOpen * 1.2
    if (preStepCallsSinceOpen >= 5 || grown) {
      consecutiveFailures = 0
      circuitOpenedAt = 0
      return true
    }
    return false
  }

  // —— 窗口真实化（频繁压缩根因修复）——
  // 400 溢出（"maximum context length is N"）揭示端点真实 max_model_len 后下调
  // context.window（只下调不上调——server 权威值 ≤ 配置窗口）。配置窗口虚高
  // （GUI 设 256k vs vLLM 实际 131k）时，pre-step 阈值按虚高窗口算 → 主动压缩永不
  // 触发、每轮被迫 400→forceCompact；采纳后阈值/保留/老化全按真实窗口计算。
  function adoptWindow(limit) {
    const n = Number(limit)
    if (!Number.isFinite(n) || n <= 0) return { adopted: false }
    const current = context.window ?? 200_000
    if (n >= current) return { adopted: false, window: current }
    context.window = Math.floor(n)
    // H3：真实窗口同步到 health 水位基准——否则配置窗口虚高被修正后，health 仍按
    // 虚高窗口测水位（压缩已触发、健康度却显示充足，系统性低估压力）
    try { health?.setWindow?.(Math.floor(n)) } catch { /* 静默降级 */ }
    return { adopted: true, from: current, window: context.window }
  }

  // maybeCompact 阈值解析：无输出预算 = window×thresholdRatio（既有行为）；给定本轮
  // 输出预算（attemptMaxTokens）时收窄到 window − 预算 − 余量——端点（vLLM）按
  // input+max_tokens 一起对 max_model_len 校验，纯比例阈值在预算巨大时会让
  // "估算仍低于阈值但请求必 400"（64K 预算 + 0.8 阈值 → 要到 ~1.4 倍窗口才触发，
  // 先撞溢出）。预算近乎占满窗口（异常配置/小窗单测）退化回纯比例，防每轮必压缩。
  function resolveThreshold({ window, outputBudget }) {
    const ratioThreshold = Math.floor(window * (context.thresholdRatio ?? 0.8))
    const budget = Number.isFinite(outputBudget) && outputBudget > 0 ? outputBudget : 0
    if (budget <= 0) return ratioThreshold
    const reserve = Number(env.PONOS_COMPACT_RESERVE || 4096)
    const budgeted = window - budget - reserve
    return budgeted < Math.floor(window * 0.05) ? ratioThreshold : Math.min(ratioThreshold, budgeted)
  }

  // usage 逐次累加（input/output/cache），语义与 engine.mjs addUsage 一致
  // （M2：摘要调用是完整 API 请求，其用量并入当前轮统计）
  function addUsage(acc, u = {}) {
    const out = { ...acc }
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      out[k] = (acc[k] ?? 0) + (u[k] ?? 0)
    }
    return out
  }

  // 摘要模型单次调用（单发与分块共用）。A1 首字节看门狗（2026-09-09 事故修复）：
  // 摘要请求原无任何守卫——上游挂起时压缩整轮消失数分钟，连熔断计数都等不到。
  // 超 firstByteMs 无首块即 abort，快速失败计入 consecutiveFailures，让熔断/冷却
  // 机制接管而不是无限等待。
  // 2026-09-11 窗口对齐：旧固定 300s 在慢 prefill 端点（362KB 上下文实测 >5min）上
  // 令摘要请求必死 → 熔断 → 压缩永不落地 → 溢出自愈链耗尽"放弃执行"。对齐
  // api.mjs 同款校准——跟随 PONOS_STREAM_FIRST_BYTE_MS（provider firstByteMs 注入），
  // 大 body（>200K 字符）放宽 600s 封顶；显式 PONOS_COMPACT_FIRST_BYTE_MS 仍权威。
  // 摘要/压缩步的思考档位（本文件唯一"降思考"的地方）。判据与启用范围见
  // kernel/effort-policy.mjs；此处只取一次，同一次压缩的单发与分块共用同一判据。
  const summaryThinking = () => pickStepThinking({ kind: 'summary' })

  // thinking 由**策略层**给（'off' = 本步关思考；'on' = 不干预，照旧走用户档位与 provider
  // 开关）。摘要/压缩步传 'off'（该步产出是结构化摘要，不需要探索性推理，范式
  // 同类压缩实现）；**保真审计步显式传 'on'**——审计的产出是"摘要漏了什么"
  // 的判断本身，把它的思考关掉等于悄悄削弱"抓坏摘要"的安全网，而它是压缩质量的唯一自动
  // 兜底。见 kernel/effort-policy.mjs 顶部的范围说明。
  async function callSummaryBody({ body, maxOut, thinking = 'on' }) {
    let buf = ''
    let usage = {}
    const firstByteMs = (() => {
      const explicit = Number(env.PONOS_COMPACT_FIRST_BYTE_MS)
      if (Number.isFinite(explicit) && explicit > 0) return Math.min(600_000, explicit)
      const fb = Number(env.PONOS_STREAM_FIRST_BYTE_MS)
      const floor = Math.max(300_000, Number.isFinite(fb) && fb > 0 ? fb : 0)
      const cap = JSON.stringify(body).length > 200_000 ? 600_000 : 480_000
      return Math.min(cap, floor)
    })()
    const ctrl = new AbortController()
    let gotData = false
    // ★ 外部取消信号必须**合并**进来，不能用 `signal || ctrl.signal` 二选一（2026-11-01）：
    //   `||` 时只要调用方给了 signal，`ctrl.signal` 就永远进不了请求 ⇒ 这个首字节看门狗
    //   abort 的是一个无人监听的 controller（子 lane 压缩器传的正是 `signal: subSignal`，
    //   于是守卫在那里**完全失效**，失败时限从 300-480s 拉长到数十分钟，且后台 lane 无可见反馈）。
    //   合并写法与 engine.mjs 的 AbortSignal.any 同思路，但不依赖该 API（老 Node 兼容）。
    const forwardAbort = () => { try { ctrl.abort() } catch { /* 已 abort */ } }
    if (signal) {
      if (signal.aborted) forwardAbort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const timer = setTimeout(() => { if (!gotData) forwardAbort() }, firstByteMs)
    if (timer.unref) timer.unref()
    try {
      for await (const chunk of streamMessages({ model, messages: body, maxTokens: maxOut, signal: ctrl.signal, tools: [], thinkingMode: thinking })) {
        gotData = true
        if (chunk.type === 'text') buf += chunk.text
        else if (chunk.type === 'usage') usage = addUsage(usage, chunk.usage)
      }
    } finally {
      clearTimeout(timer)
      if (signal) { try { signal.removeEventListener('abort', forwardAbort) } catch { /* 无监听 */ } }
    }
    return { text: buf, usage }
  }

  async function runSummarizer({ system, messages, cut, maxOut = maxTokens }) {
    const keyInfo = keyInfoBlock(extractKeyInfo(messages))
    // P9-3：会话工作记忆注入摘要请求（事实来源，辅助收敛与关键信息保留）
    const sm = readSessionMemoryFile()
    const req = assembleSummaryRequest({
      system, messages, cut, lastSummary, keyInfo,
      sessionMemory: sm || undefined,
    })
    return callSummaryBody({ body: req, maxOut, thinking: summaryThinking() })
  }

  // 压缩点保真审计（2026-09-12 spec §4.1 方法 B）——**fire-and-forget**：
  // ①每次压缩最多 1 次调用（auditInFlight 门）；②maxOut 512；③失败绝不触碰
  // consecutiveFailures/熔断计数（审计是附产物，绝不能拖垮压缩或阻塞轮次时延）。
  let auditInFlight = false
  async function auditFidelityAsync(summary, covered) {
    try {
      if (auditInFlight) return
      if (env.PONOS_FIDELITY_LLM_AUDIT === '0') return
      if (!summary || !Array.isArray(covered) || !covered.length) return
      auditInFlight = true
      const texts = []
      for (const m of covered) {
        if (typeof m?.content === 'string') texts.push(m.content)
        else if (Array.isArray(m?.content)) {
          for (const b of m.content) if (typeof b?.content === 'string') texts.push(b.content)
        }
      }
      const first = texts.slice(0, 6).join('\n').slice(0, 6000)
      const last = texts.slice(-4).join('\n').slice(0, 6000)
      const info = keyInfoBlock(extractKeyInfo(covered))
      const excerpt = `${info}\n${first}\n…\n${last}`.slice(0, 12_000)
      const { text } = await callSummaryBody({
        body: buildFidelityAuditRequest({ excerpt, summary }),
        maxOut: 512,
        thinking: pickStepThinking({ kind: 'audit' }), // 显式：审计步**不**降思考（见上）
      })
      const parsed = parseFidelityAudit(text)
      if (parsed.missing.length || parsed.rewritten.length) {
        try { onCompactionAudit?.({ entities: [], missing: parsed.missing, ratio: 0, llm: parsed }) } catch { /* 静默 */ }
      }
    } catch { /* 审计失败静默：不计熔断、不影响压落地 */ } finally { auditInFlight = false }
  }

  /**
   * 摘要模型单次调用（单发与分块共用）。
   * `retainHint` 可选：分块摘要路径会带"必须保留项"，其余调用点不传。
   * @param {{ system?: any, messages?: any, limit?: any, retainHint?: any }} opts
   */
  async function summarize({ system, messages, limit, retainHint }) {
    if (summaryInFlight) return { action: 'none', reason: 'lock' } // 内存锁：拒绝并发压缩
    summaryInFlight = true
    // 压缩状态上行标记（GUI 依 system/compaction 渲染「正在压缩上下文」指示条）：
    // start 只在真正进入模型摘要阶段前发（老化/免模型裁剪已降回阈值之下的路径不发）；
    // done 在 finally 对称补发（含收敛失败/中止/异常——UI 指示条必清除、不悬挂）。
    let compactEmitted = false
    let compactOk = false
    let usage = {} // M2：摘要调用用量累计（含收敛重试多次调用；异常路径也要能带出已发生调用）
    // 摘要落地（单发与分块共用）：日志锁（start 占位 → summary 落地 replace）+ 内存锁释放。
    // covered 来自 deriveMessages()（对象引用一致），经 session 反查真实 seq。
    // 契约：seqs 必须与 covered 一一对应（数量/顺序）——反查失败必须显式报错，
    // 不得静默提交空/残缺 coveredSeqs（否则压缩"看似成功实则丢消息"）。
    // 单通道（FIX R1）：压缩成功后 ponos_summary 只发一次——装配 health 时由
    // health.recordCompaction 代发（并记录 lastSummary），未装配时保留 wire.summary 兜底。
    // 两路互斥，杜绝 ponos_summary 双发（spec §6：compact 成功后 health.recordCompaction 为权威调用点）。
    function landSummary(summary, c, coveredTk, gateAudit, gate) {
      const coveredSeqs = session.seqsForMessages(c.covered)
      if (!Array.isArray(coveredSeqs) || coveredSeqs.length === 0 || coveredSeqs.length !== c.covered.length) {
        throw new Error(
          `内核：压缩遮蔽区间 seq 反查失败（covered ${c.covered.length} 条 → seqs ${coveredSeqs?.length ?? 0} 条）——` +
          'covered 必须来自同一 surface 代的 deriveMessages() 结果'
        )
      }
      // 保真审计（spec §4.1；**P0-2 2026-09-16 改为写入前置**）：确定性审计同步、零模型成本，
      // 故从"落地后观测"提到**写盘之前**——审计结论必须是"是否用这份摘要落地"的输入，而非
      // 事后通报。改前审计晚于落地：就算发现关键事实大面积丢失，那份低保真摘要**已经在会话
      // 里了**（摘要读起来通顺但前提是错的，正是失真最难发现的形式），且没有任何机制能据此
      // 重压。调用方（单发收敛路径）已按 `fidelityGate` 判据尝试过换切点重压，此处做最终
      // 口径上报：上报的是**即将落地的这一份**摘要的审计结果。
      const audit = gateAudit ?? auditSummaryFidelity({ covered: c.covered, summary })
      try {
        if (!audit.skipped) onCompactionAudit?.({ ...audit })
      } catch { /* 审计上报失败不影响压缩落地 */ }
      session.appendCompactionStart(coveredSeqs)
      session.appendCompactionSummary({ summary, coveredSeqs })
      lastSummary = summary
      compactOk = true
      if (health) health.recordCompaction?.(summary, session.compactCount())
      else wire.summary?.(summary, session.compactCount())
      // LLM 审计（方法 B，能发现"被改写"而字面审计发现不了）保持 fire-and-forget：
      // 不进 await 链，绝不拖慢压缩落地与轮次时延。
      void auditFidelityAsync(summary, c.covered)
      return {
        action: 'summarized', summary, compactCount: session.compactCount(), usage, coveredTokens: coveredTk,
        // P0-2：门禁可观测（仅在返回值上增字段，**不动 onCompactionAudit 载荷形状**，
        // 消费方只读已知键 → 零风险）。gateFailures = 门禁触发的换切点重压次数。
        gateFailures: gate?.failures ?? 0,
        gateExhausted: gate?.exhausted ?? false,
      }
    }
    try {
      const window = context.window ?? 200_000
      // 溢出兜底（limit = 端点真实窗口）：摘要请求 = 保留输入 + 输出预算 + 系统/注入
      // 余量，必须 ≤ 真实窗口，否则压缩请求自身也会 400（配置窗口虚高时必现）。输出
      // 预算压到 16K 上限，保留输入按 真实窗口 − 输出预算 − 32K 余量 封顶。
      const hasLimit = Number.isFinite(limit) && limit > 0
      // 小窗口摘要输出预算（2026-09-10 小窗口模型切换适配）：limit < 64K 时按窗口
      // 比例收窄（32K → 8K）——摘要请求 = 输入 + max_tokens 一起对端点 max_model_len
      // 校验（vLLM），大输出预算会令摘要请求自身 400、压缩永不落地。
      const summarizerMaxOut = hasLimit ? Math.min(maxTokens, 16384, Math.max(2048, Math.floor(limit * 0.25))) : maxTokens
      let retainTokens = hasLimit
        ? Math.max(1024, Math.floor(Math.min(window * (context.retainRatio ?? 0.16), limit - summarizerMaxOut - 32768)))
        : Math.floor(window * (context.retainRatio ?? 0.16))
      // retainHint（engine 溢出路径按 真实窗口 − 当前输出预算 反推）：配置窗口虚高时
      // 上面的 min 上限仍可能大于整段对话 → 无切点 → 压缩永不落地。hint 把保留预算
      // 压到主请求能装下的水平，让贴近端点硬限的上下文也能真正裁切（否则只能靠收窄
      // 输出预算，模型回答质量与耗时双损）。
      if (Number.isFinite(retainHint) && retainHint > 0) retainTokens = Math.min(retainTokens, Math.floor(retainHint))
      // ★★ 2026-10-19 结构修正（与上面 age 门的修正同一个病根，但后果更隐蔽）：
      //   `retainTokens = window × retainRatio` 是"**保留窗口的 16%**"。窗口 1M 时它是
      //   **167,772**，而整段对话只有 193,647 ⇒ `findCutPoint` 从尾部往前累计保留预算，
      //   累计到 167,772 就已经吃掉 **86.6%** 的内容 ⇒ 只剩最前面 13%（约 2,174 token，
      //   现场日志 `covered=1 coveredTokens=2174`）可遮蔽 ⇒ 摘要只压得掉那一点点 ⇒
      //   `summaryTokens < coveredTokens` 收敛检查失败 ⇒ `no-convergence` ⇒ **一轮都不落地**。
      //   也就是说：窗口越大，"保留窗口的 16%"越接近"保留全部" ⇒ 压缩在大窗口上**结构性失效**。
      //
      //   修法：保留量同时受**实际内容**约束 —— `retainTokens ≤ 总 est × maxRetainRatio`
      //   （默认 0.5 ⇒ 至少能压掉一半）。窗口 1M / 内容 193K ⇒ min(167772, 96500) = 96,500
      //   ⇒ 可遮蔽约 97K（现场原本只有 2,174）⇒ 摘要请求 97K+16K 远小于 1M ⇒ 能装下、能收敛。
      //   ★ 为什么取 0.5 而不是更小：再小就要拆掉更多近期上下文（模型做事依赖它们），
      //     而"至少压掉一半"已经能让长会话稳定收敛；需要更激进时用 PONOS_COMPACT_MAX_RETAIN_RATIO。
      //   ★ 这道约束**只收紧上限**，不会把保留量放大：`min` 保证既有小窗口行为逐字不变。
      {
        const maxRetainRatio = Number(
          Number.isFinite(Number(context.maxRetainRatio))
            ? context.maxRetainRatio
            : (env.PONOS_COMPACT_MAX_RETAIN_RATIO ?? 0.5),
        )
        const totalEst = context.estimateHistory ? context.estimateHistory(messages) : messages.length * 100
        if (Number.isFinite(maxRetainRatio) && maxRetainRatio > 0 && totalEst > 0) {
          const capped = Math.floor(totalEst * maxRetainRatio)
          // 下限 1024：保留区为 0 时切点会落到"无真实 user 起点"，压缩同样落不了地
          retainTokens = Math.max(1024, Math.min(retainTokens, capped))
        }
      }
      // ★ 条数预算（2026-10-19）：摘要的保留区条数也要受 maxMessages 约束，否则
      //   "摘要后条数仍远超门" ⇒ 每 3 轮重摘一次直到 no-convergence（见 findCutPoint 注释）。
      //   目标取 maxMessages 的 **keepTargetRatio 倍**（默认 0.5），不是刚好等于门：
      //   刚好压到门（如 126→120）意味着每轮都要重摘、且 covered 只有几条（摘要比原文长，
      //   必 no-convergence）。压到一半 ⇒ 一次摘要能撑几十轮，且 covered 足够大能收敛。
      //   可配 PONOS_COMPACT_KEEP_TARGET_RATIO。
      const keepTargetRatioRaw = Number(
        Number.isFinite(Number(context.keepTargetRatio))
          ? context.keepTargetRatio
          : (env.PONOS_COMPACT_KEEP_TARGET_RATIO ?? 0.5),
      )
      // ★ 注意：本函数（summarize）作用域内没有 maybeCompact 的 `maxMessages`，必须从
      //   context 取（口径与 maybeCompact 逐字一致：context 优先 → env → 默认 120）。
      const keepMaxMessages = Number(context.maxMessages ?? env.PONOS_COMPACT_MAX_MESSAGES ?? 120)
      const maxKeptMessages = Number.isFinite(keepMaxMessages) && keepMaxMessages > 0
        ? Math.max(
          1,
          Math.floor(keepMaxMessages * (Number.isFinite(keepTargetRatioRaw) && keepTargetRatioRaw > 0 ? keepTargetRatioRaw : 0.5)),
        )
        : undefined
      let cut = findCutPoint({ messages, retainTokens, estimateMessage: context.estimateMessage, maxKeptMessages })
      if (!cut) return { action: 'none', reason: 'no-cut-point' }
      // ★★ 2026-10-22：covered 里**只有已密封的旧摘要** ⇒ 这次摘要只能是"摘要的摘要"：
      //   条数上零收益、纯付费空转，却会把 compactCount 与"压缩次数"指标顶高
      //   （真机：3431 条会话 158 次 compaction，其中 140 次 covered=1）。
      //   发生在"真实 user 起点极稀疏"的 tool 循环里：切点退到上一条摘要之后，
      //   于是每次只把那条摘要再摘一遍。此时不调模型、不落地，如实返回 none。
      if (!hasNovelContent(cut.covered)) {
        return { action: 'none', reason: 'no-novel-content', covered: cut.covered.length }
      }
      let coveredTokens = context.estimateHistory ? context.estimateHistory(cut.covered) : cut.covered.length * 100
      // —— 阶段②b 分块摘要（A4 限幅之前判定，用原始 cut）——
      // covered 超出单块容量（limit − 输出预算 − 余量）→ 单发摘要请求自身必超窗
      // （A4 限幅最多把保留预算翻倍 4 次，covered ≫ 窗口时仍装不下）→ 按 turn 边界
      // 分块滚动合并。切小窗口模型的会话（1M/200K 历史 → 32K 本地模型）与超长会话
      // 的首次压缩都走此路径——否则压缩永不落地、每轮撞 400。
      const chunkBudget = hasLimit ? Math.max(2048, limit - summarizerMaxOut - 4096) : 0
      if (hasLimit && coveredTokens > chunkBudget && cut.covered.length > 1) {
        const sealed = cut.covered.filter((m) => !(m?.role === 'assistant' && typeof m?.content === 'string'))
        const chunks = splitCoveredIntoChunks({ covered: sealed, chunkBudget, estimateMessage: context.estimateMessage })
        if (chunks.length > 1) {
          wire?.system?.('compaction', { state: 'start', covered: cut.covered.length, coveredTokens, mode: 'chunked', chunks: chunks.length })
          compactEmitted = true
          const keyInfo = keyInfoBlock(extractKeyInfo(messages))
          const sm = readSessionMemoryFile()
          let rolling = ''
          let chunksOk = 0
          for (let ci = 0; ci < chunks.length; ci++) {
            const isLast = ci === chunks.length - 1
            const body = []
            if (rolling) body.push({ role: 'user', content: `<compacted-summary>${rolling}</compacted-summary>` })
            body.push(...patchOrphanToolUses(chunks[ci]))
            body.push({
              role: 'user',
              content: isLast
                ? COMPACTION_INSTRUCTION + (system ? `\n\n（系统提示开头：${String(system).slice(0, 200)}…）` : '') +
                    (keyInfo && keyInfo.trim() ? `\n\n${keyInfo}` : '') +
                    (sm && sm.trim() ? `\n\n（会话工作记忆——保留其中所有未过时事实：）\n<session-memory>\n${sm.trim().slice(0, 5000)}\n</session-memory>` : '')
                : chunkMergeInstruction(ci + 1, chunks.length),
            })
            const { text, usage: callUsage } = await callSummaryBody({ body, maxOut: summarizerMaxOut, thinking: summaryThinking() })
            usage = addUsage(usage, callUsage)
            // A2 标签缺失降级（同单发）：弱模型不吐标签时清洗行内思考后整体作摘要
            let s = extractSummary(text)
            if (!s) s = stripInlineThink(text).trim()
            if (!s) { consecutiveFailures++; break }
            rolling = s
            chunksOk++
          }
          if (chunksOk === chunks.length && rolling) {
            // 收敛口径与 coveredTokens 对齐（CJK 感知，同单发路径）
            const cjkN = countCjk(rolling)
            const summaryTokens = cjkN + Math.ceil((rolling.length - cjkN) / 4)
            if (summaryTokens < coveredTokens) {
              consecutiveFailures = 0
              return { ...landSummary(rolling, cut, coveredTokens), mode: 'chunked', chunks: chunks.length }
            }
            consecutiveFailures++
          }
          return { action: 'none', reason: 'no-convergence', failures: consecutiveFailures, usage }
        }
        // sealed 过滤后仅剩 1 块（covered 估算偏差）→ 落入单发路径（A4 限幅兜底）
      }
      // A4 摘要请求自身限幅：covered 按"真实窗口 − 输出预算 − 32K 余量"封顶。
      // 真实 token 数可能高于启发式估算（CJK/代码密度偏差），摘要请求超限会被
      // 端点 400/挂起——宁可多保留原样内容，也不让压缩请求自身装不下（2026-09-09）。
      if (hasLimit) {
        const overhead = summarizerMaxOut + 32768
        let guard = 0
        while (guard++ < 4 && coveredTokens + overhead > limit) {
          const totalEst = context.estimateHistory ? context.estimateHistory(messages) : messages.length * 100
          const next = Math.min(retainTokens * 2, totalEst)
          if (next <= retainTokens) break
          retainTokens = next
          const nextCut = findCutPoint({ messages, retainTokens, estimateMessage: context.estimateMessage })
          if (!nextCut || nextCut.start <= cut.start) break
          cut = nextCut
          coveredTokens = context.estimateHistory ? context.estimateHistory(cut.covered) : cut.covered.length * 100
        }
      }
      // A4 的"换更晚切点"会把 covered 缩得更小，极端时可能只剩上一条旧摘要——
      // 与上面同一判据：摘要的摘要不付费。放在发 start 事件**之前**（没有实际压缩发生）。
      if (!hasNovelContent(cut.covered)) {
        return { action: 'none', reason: 'no-novel-content', covered: cut.covered.length }
      }
      wire?.system?.('compaction', { state: 'start', covered: cut.covered.length, coveredTokens })
      compactEmitted = true
      const retries = Number(env.PONOS_COMPACTION_RETRIES || 3)
      let summary = null
      let converged = false
      // P0-2（2026-09-16）：门禁开关与计数。gateFailures = 因保真门禁不通过而**放弃当前
      // 切点、换更晚切点重压**的次数；gateExhausted = 重试预算耗尽后仍不达标、只能降级落地。
      // 二者独立于 consecutiveFailures：后者是"落地失败"的熔断信号（返回 no-convergence 的
      // 判据），门禁失败最终**仍会落地**，混入会污染熔断语义（那会让本该重试的压缩被熔断）。
      let gateFailures = 0
      let gateExhausted = false
      let gateAudit = null
      // 被门禁拒绝、但"无更晚切点可取"时仍需降级落地的那一份：连**切点与 token 量一起存**。
      // 只存摘要文本是不够的——自愈循环会把 cut/coveredTokens 推进到更晚切点，若落地时用
      // 更新后的 cut，就会出现"摘要描述的区间"与"被遮蔽区间"错配（摘要覆盖范围与遮蔽标记
      // 不一致），虽不崩但会留下难以解释的状态。
      let gateFallback = null
      for (let attempt = 0; attempt < retries; attempt++) {
        // 自愈循环每轮把 cut 往**后**推（covered 变小）；若退到只剩旧摘要，再重试也
        // 只能产出"摘要的摘要" ⇒ 直接收手，不再发起付费调用（usage 如实带出）。
        if (!hasNovelContent(cut.covered)) {
          return { action: 'none', reason: 'no-novel-content', covered: cut.covered.length, usage }
        }
        const { text, usage: callUsage } = await runSummarizer({ system, messages, cut, maxOut: summarizerMaxOut })
        usage = addUsage(usage, callUsage)
        // A2 标签缺失降级：弱模型不吐 <compacted-summary> 标签时，清洗行内思考
        // 后把整体响应当作摘要（只有空文本才计失败）——防"标签格式问题"让压缩
        // 永不落地（2026-09-09 实测全天 0 条 compaction 条目）。
        let s = extractSummary(text)
        if (!s) s = stripInlineThink(text).trim()
        if (!s) { consecutiveFailures++; continue }
        // 收敛口径与 coveredTokens 对齐（CJK 感知）：中文摘要按字计，避免低估摘要
        // 体量 → 巨大摘要被误判"已收敛"仍照单全收
        const cjkN = countCjk(s)
        const summaryTokens = cjkN + Math.ceil((s.length - cjkN) / 4)
        // 本轮是否被门禁拦下（每次迭代重置）：决定 consecutiveFailures 是否累加
        let gateBlocked = false
        if (summaryTokens < coveredTokens) {
          // P0-2：收敛**还不够**，必须同时过保真门禁。改前只看长度收敛：摘要短了就算成功，
          // 哪怕它把关键技术前提（路径/端口/阈值）全丢了——"读起来通顺但前提是错的"正是
          // 失真最难发现的形式。不通过则不 break，落入循环底部既有的自愈路径
          // （retainTokens 扩大 → 取更晚切点 → 覆盖消息更少 → 摘要负担更轻），
          // 并计数便于观测——**不允许静默重压**。
          const verdict = fidelityGate({ covered: cut.covered, summary: s })
          gateAudit = verdict.audit
          if (verdict.pass) { summary = s; converged = true; break }
          gateFailures++
          gateFallback = { summary: s, cut, coveredTokens }
          gateBlocked = true
        }
        // P0-2：门禁失败**不计** consecutiveFailures——该计数器是"落地失败"的熔断信号
        // （返回 no-convergence 的判据）。门禁失败最终仍会落地，混入会让本该重试的压缩
        // 被熔断成 no-convergence，直接破坏"压缩必须落地"（既有测试已抓到过这一缺陷）。
        if (!gateBlocked) consecutiveFailures++
        // A2 收敛失败自愈：covered 减半重摘（保留预算翻倍）；末次仍不收敛时截断
        // 摘要按头 60% 落地——压缩必须落地（宁可有损，不无限重试烧时间）。
        if (attempt === retries - 1) {
          // P0-2：末次要区分两种情形。①"未收敛"（摘要比 covered 还长）→ 既有截断 60%
          // 逻辑；②"已收敛但门禁不通过"（长度已达标、只是丢了实体）→ **原样落地**，
          // 因为截断只会让保真度更差（截掉的是摘要尾部内容），且"必须落地"是不变量。
          if (summaryTokens < coveredTokens) {
            summary = s
            gateExhausted = true
          } else {
            const cap = Math.floor(s.length * 0.6)
            summary = s.slice(0, cap) + '\n…（摘要过长，已截断落地）'
          }
          converged = true
          break
        }
        const totalEst = context.estimateHistory ? context.estimateHistory(messages) : messages.length * 100
        const next = Math.min(retainTokens * 2, totalEst)
        if (next <= retainTokens) break
        retainTokens = next
        const nextCut = findCutPoint({ messages, retainTokens, estimateMessage: context.estimateMessage })
        if (!nextCut || nextCut.start <= cut.start) break
        cut = nextCut
        coveredTokens = context.estimateHistory ? context.estimateHistory(cut.covered) : cut.covered.length * 100
      }
      // P0-2：门禁曾拒绝、但已无更晚切点可取（自愈走到头，`break` 出循环）→ **降级落地**
      // 被拒的那一份。理由："压缩必须落地"是硬不变量——此处若返回 none，调用方按"未压缩"
      // 处理 → 溢出路径再次触发 → 同一份摘要被反复重摘，比"落地一份低保真摘要"更糟
      // （多烧 API、问题依旧）。gateExhausted 如实带出，不静默。
      if ((!converged || !summary) && gateFallback) {
        consecutiveFailures = 0
        return landSummary(
          gateFallback.summary, gateFallback.cut, gateFallback.coveredTokens, gateAudit,
          { failures: gateFailures, exhausted: true },
        )
      }
      if (!converged || !summary) {
        consecutiveFailures++
        // 调用已发生（被计费）→ usage 一并返回，engine 侧并入本轮统计
        return { action: 'none', reason: 'no-convergence', failures: consecutiveFailures, usage, gateFailures }
      }
      consecutiveFailures = 0
      return landSummary(summary, cut, coveredTokens, gateAudit, { failures: gateFailures, exhausted: gateExhausted })
    } catch (e) {
      // L0-c：摘要模型调用/落地异常 → 计为熔断失败并对称降级返回（不抛穿调用方）。
      // 抛穿后果：preStep 无 catch，异常会穿透成整轮"内部错误"；forceCompact 虽被
      // engine try/catch 包住，但熔断计数缺失会让反复失败的摘要无限烧 API。
      // 返回 none 后调用方按"压缩未落地"处理（engine 溢出路径走预算收窄再试）。
      consecutiveFailures++
      return { action: 'none', reason: 'compact-error', error: String(e?.message || e), usage }
    } finally {
      if (compactEmitted) wire?.system?.('compaction', { state: 'done', ok: compactOk })
      summaryInFlight = false
    }
  }

  return {
    // pre-step 测压：先裁剪（阶段①），仍超再摘要（阶段②）
    // ★ 2026-10-26：`tools` 必传（调用方传**本轮真实要发出去的 schema 数组**）。漏传的后果
    //   不是"估得略低"：固定前缀（system + tools）在 128K 本地模型上已占 79% 窗口，而估算
    //   看不见 tools ⇒ est 恒低于阈值 ⇒ 压缩永不触发（真实会话实测压缩 0 次、同一 411KB
    //   请求体被重发 7 次以上）。见 context.mjs#toolsTokens。
    async maybeCompact({ system, messages, outputBudget, tools = null }) {
      const window = context.window ?? 200_000
      const threshold = resolveThreshold({ window, outputBudget })
      const est = context.estimate ? context.estimate({ system, messages, tools }) : { total: 0 }
      // T1（2026-09-12）：token 估算之外的第二道触发口——消息**条数**。长会话可能由
      // 大量小消息构成（工具结果碎片）：token 估算长期低于比例阈值，而每轮请求的
      // 消息条数单调上涨（实测单会话 767 条 vs 阈值 120，全窗口 0 次压缩）。条数过线
      // 即进入压缩链路，但**只做零模型成本的免费收缩**：摘要是一次 480–600s 级完整
      // 请求，绝不为"条数多"付费（收口见下方 count-only 早退）。0 = 关闭。
      const msgs = Array.isArray(messages) ? messages.length : 0
      const maxMessages = Number(context.maxMessages ?? env.PONOS_COMPACT_MAX_MESSAGES ?? 120)
      const overTokens = est.total >= threshold
      const overCount = Number.isFinite(maxMessages) && maxMessages > 0 && msgs > maxMessages
      if (!overTokens && !overCount) return { action: 'none', reason: 'below-threshold', msgs, est: est.total }
      // 阶段0+① 免费收缩（老化清除 + 结构裁剪）：零模型成本先压上下文。
      // 老化清除（P9-1）——上下文超过 clearRatio 时清可重放旧工具结果；清除后回落
      // 到 threshold 之下则本轮免摘要（压缩次数↓）。
      //
      // ★★ 2026-10-19 结构修正（用户实测："1M 窗口的会话，193K token / 559 条却完全不收缩"）：
      //   原判据只有"**窗口的**比例"这一个视角 ⇒ `age = est ≥ window × 0.5`。
      //   窗口是**端点能力上限**，不是"应该用多少"：1M 窗口下这个门是 524,288，
      //   而实际内容 193,647（一次请求 52 万字节、每轮几秒 prefill）⇒ **门永远不开**
      //   ⇒ 免费收缩一条都不动 ⇒ 只剩条数门在触发 ⇒ 升级摘要 ⇒ 摘要又因保留量过大而
      //   no-convergence ⇒ 条数继续涨。现象与"没有任何优化"完全一样。
      //
      //   修法：`age 门 = min(窗口比例, 绝对量上限)`。
      //     · 大窗口（1M）：被绝对量压住 ⇒ 64K 就开始清可重放结果（它们本来就能重读回来）；
      //     · 小窗口（32K）：min(16K, 64K) = 16K ⇒ **原行为逐字不变**；
      //     · 中窗口（200K）：min(100K, 64K) = 64K ⇒ 更早开始清（省 token 的方向，
      //       且清掉的都是可重放/已落盘的东西，不损失信息）。
      //   为什么敢用 min 而不是 max：这个门后面清的两类东西**都可恢复**
      //   （可重放工具结果 / 已落盘 Write·Edit 正文），所以"早点清"的代价只是
      //   "模型要多调一次工具才能重读"，而"晚点清"的代价是**每轮多付 19 万 token 的 prefill**。
      //   可配：PONOS_TOOL_RESULT_CLEAR_RATIO（比例）/ PONOS_TOOL_RESULT_AGE_ABS_TOKENS（绝对量）。
      const clearRatio = Number(env.PONOS_TOOL_RESULT_CLEAR_RATIO || 0.5)
      const ageByRatio = Math.floor(window * clearRatio)
      const ageAbs = Number(env.PONOS_TOOL_RESULT_AGE_ABS_TOKENS ?? 65536)
      const ageThreshold = Number.isFinite(ageAbs) && ageAbs > 0 ? Math.min(ageByRatio, ageAbs) : ageByRatio
      const shrink = freeShrink(messages, { window, env, age: est.total >= ageThreshold })
      // 免费收缩后的实测估值：判"这轮到底压下去多少"需要它（见下方 ENG-08 补强的 effectiveShrink）。
      // 只在真动过内容时才重算（estimate 是热路径：白算一次就是每轮多一遍全量遍历）。
      let estAfterShrink = est.total
      if (shrink.cleared > 0 || shrink.prunedAny || shrink.agedInputs > 0) {
        estAfterShrink = (context.estimate ? context.estimate({ system, messages, tools }) : est).total
      }
      // ★★ 2026-10-19 根治（用户实测："日志显示 maxMessages=120，会话已到 2500 条，每次请求 1.8MB；
      //   每轮只清 1 条可重放工具结果"）—— **条数维度被 token 维度的"已解决"整个跳过了**。
      //
      // 病灶：原实现只要 `estAfterShrink < threshold` 就直接 return `aged`/`pruned`，
      //   把"条数是否还超门"这件事**根本没检查**。而 `freeShrink` 只改写 tool_result 的
      //   **内容**、**不删消息** ⇒ 它对"条数"这一维**结构上无效**（清理前后 msgs 恒等）。
      //   于是：一条 token 一直低于阈值、但消息条数稳步增长的长会话（大量小消息 / 工具碎片），
      //   每轮都会命中"条数门" → 清掉 1 条 → token 仍在阈值下 → **每轮 return aged**，
      //   日志看起来"一直在正常收缩"，而条数从 120 一路涨到 2500、请求体涨到 1.8 MB。
      //   这与 ENG-08 修的那个缺陷是**同一个病的另一个入口**：都在"看起来在工作"中失控。
      //
      // 判据：两个维度必须**分别**解决才算收口。
      //   · token 维度：estAfterShrink < threshold；
      //   · 条数维度：**清理无法改变**它 ⇒ 只能在清理前就已满足（`!overCount`）。
      //   ⇒ 两个都满足才 return aged/pruned；只有 token 满足时**继续往下**
      //     （条数维度尚未解决 ⇒ 落到下面的计数/升级逻辑）。
      // ★★ 2026-10-26：固定前缀（system + tools）**不可压缩**，必须从"压缩能否收口"里扣除。
      //
      // 为什么必须现在加（把 tools 计入估算之后暴露的新失控形态）：`est` 一旦包含工具面，
      // 一个 128K 本地模型 + 110 个 MCP 工具的现场 est 里就有约 101K 是**永远不会变小**的
      // 前缀 ⇒ `estAfterShrink < threshold` 恒不成立 ⇒ tokenSolved 恒 false ⇒ 每轮都往下走
      // 到付费摘要，而摘要只压 messages、对前缀毫无作用（纯空转烧 API，仍装不下）。
      // 这正是"修一个洞长出另一个洞"的典型：不修它，本文件上半部分的修复等于把
      // "永不压缩"换成了"每轮空转压缩"。
      //
      // 判据：`prefix + 摘要后仍需保留的最小量 ≥ 阈值` ⇒ **摘要也无解** ⇒ 免费收缩即收口。
      //   为什么用"前缀 + 保留下限"而不是"前缀 ≥ 阈值一半"（曾写过的更粗判据）：
      //   后者会把"前缀占一半、但消息仍大得多"的场景也判成无解——那里摘要**确实有效**
      //   （把 40K 消息压到 5K 仍能收口）。真正的无解条件是：即便消息被压到 retain 下限，
      //   total 仍高于阈值（差值全由不可压缩的前缀造成）。
      //   · 128K + 110 个 MCP 工具的现场：前缀 101K + 保留 16.8K = 117.8K > 阈值 104.9K ⇒ 无解 ✓
      //   · 32K 普通会话（前缀 9K + 保留 3.8K = 12.8K < 阈值 23.8K）⇒ 正常摘要 ✓
      //   · 不会死锁：溢出路径（forceCompact）**不受**本判据影响，仍会强制摘要；
      //     且 engine 的固定前缀 preflight 已一次性告警，让用户去处置（减工具/换模型）。
      const prefixEst = (Number(est.sections?.system) || 0) + (Number(est.sections?.tools) || 0)
      const retainFloor = Math.floor(threshold * Number(context.retainRatio ?? 0.16))
      const prefixDominant = prefixEst > 0 && (prefixEst + retainFloor) >= threshold
      const tokenSolved = prefixDominant || estAfterShrink < threshold
      const countSolved = !overCount
      if (tokenSolved && countSolved) {
        // ★ 2026-10-19：补 `est`（清理**后**的实测值）。原先这两条返回不带 est，于是
        //   `[compact] action=aged ... est=-` —— 日志读起来像"不知道体量就清了"，
        //   而"这次 aged 发生在多大的上下文上"恰恰是排查膨胀问题最需要的一个数。
        return shrink.cleared > 0
          ? { action: 'aged', reason: `tool-results-aged-${shrink.cleared}`, cleared: shrink.cleared, est: estAfterShrink }
          : { action: 'pruned', reason: 'tool-result-pruned', est: estAfterShrink }
      }
      // 条数维度未解决而 token 维度已解决：免费收缩即为本次收口，**不做模型摘要**
      // （摘要代价 480–600s，不为"条数多"付费）。token 维度仍超时本行不生效，继续走熔断门与摘要。
      //
      // ★ 2026-10-19：判据从 `!overTokens`（清理**前**的 token 状态）改为 `tokenSolved`
      //   （清理**后**的实测状态）。差别只在"这轮清理刚好把 token 压到阈值下、但条数仍超门"
      //   这一种情形 —— 那时旧判据会直接跳过整块（因为 overTokens 是 true）直奔摘要，
      //   新判据则正确地落进"条数维度未解决"的计数/升级逻辑。
      //
      // ★★ 2026-10-18 ENG-08 修复：**免费收缩连续收不动时，必须升级到付费摘要**。
      //
      // 原状：这里直接 `return { action:'none', reason:'count-over-no-shrink' }`。
      //   若 freeShrink 确实压不动（消息由大量**不可裁剪**的小消息构成 —— 例如每轮
      //   一条用户短问 + 一条短答，既没有可老化的工具结果、也没有可裁剪的大块），
      //   条数会**无限增长**：每轮请求的 body 越来越大 → 延迟/成本上升 → 最终撞上下文上限。
      //   而返回值恒为 'none'，调用方看不出"已经在失控"。
      //
      // 取舍：原设计"不为条数多付费"是合理的，所以不能一撞条数就摘要。
      //   ⇒ 引入**连续收不动计数**：只有连续 N 次（默认 3）免费收缩都收不动，
      //     才认定"免费路径已证明无解"，允许走一次付费摘要。
      //     既尊重原成本约束，又给失控加了闸。
      if (tokenSolved) {
        // ★★ 2026-10-19 ENG-08 补强（用户实测："每轮只清 1 条可重放工具结果，会话已到 2500 条"）：
        //   原判据是 `shrink.cleared > 0 || shrink.prunedAny` —— **只要动过东西就算"有效"**。
        //   但"清掉 1 条 200 字节的结果"与"清掉 1245 条"在上下文规模上不是一回事：
        //   前者每轮把计数清零 ⇒ ENG-08 的升级闸**永远不会到**⇒ 条数照样无限增长，
        //   而返回值看起来一切正常（这正是原缺陷换了个形态复现）。
        //   实测数据（真实 transcript）：一次有效收缩能让 est 降 75%（200351 → 48827），
        //   而"每轮清 1 条"的降幅只有 0.1% 量级。
        //   ⇒ 判据改为**实际降幅**：降幅 < minGainRatio 视为"收不动"，照常累加计数。
        //     阈值默认 1%（足够区分上面两个量级），可用 PONOS_COMPACT_SHRINK_MIN_GAIN 覆盖。
        const minGainRatio = Number(env.PONOS_COMPACT_SHRINK_MIN_GAIN ?? 0.01)
        const gainRatio = est.total > 0 ? (est.total - estAfterShrink) / est.total : 0
        // ★ 2026-10-19：`agedInputs` 也算"动过"——它与 cleared/pruned 一样是原地改写
        //   （Write/Edit 的大 payload），同样会让内容 epoch 变化，因此同样要参与
        //   "这轮到底压下去多少"的判据。漏算它会让"只省 payload"的轮次被误判成收不动。
        const touched = shrink.prunedAny || shrink.cleared > 0 || shrink.agedInputs > 0
        const effectiveShrink = touched && Number.isFinite(minGainRatio) && gainRatio >= minGainRatio
        if (effectiveShrink) {
          // 这次免费收缩**真的把上下文压下去了** ⇒ 计数清零（说明免费路径仍能收敛）
          consecutiveCountNoShrink = 0
          // ★ shrunk 是给 engine 的归因信号（不是给判定的）：cache-observer 要靠它给这次
          //   缓存失效起名（post-aged）。只认 `action==='aged'` 的话，"条数仍超门但内容确实
          //   被原地改写了"这种情形会退化成 history-rewrite（实测：改完本文件后
          //   engine-cache-obs-sequence 的两条端到端用例立刻红）。判据与命名必须分开。
          // ★ 2026-10-19：补 cleared/agedInputs 明细。原先只有 `shrunk: true` 一个布尔，
          //   于是"这轮清了 1 条"和"清了 500 条"在日志里长得一模一样 —— 而排查膨胀时
          //   恰恰需要"到底清掉多少"（这是 `aged` 不带 est 的同类缺口，一并补齐）。
          return {
            action: 'none', reason: 'count-shrink-only', msgs, est: est.total, maxMessages, shrunk: touched,
            ...(shrink.cleared > 0 ? { cleared: shrink.cleared } : {}),
            ...(shrink.agedInputs > 0 ? { agedInputs: shrink.agedInputs } : {}),
          }
        }
        consecutiveCountNoShrink += 1
        const escalationLimit = Number(env.PONOS_COMPACT_NOSHRINK_LIMIT ?? 3)
        // ★★ 2026-10-26 M2 水位闸 + M1 频次护栏（用户实测：1M 窗口下 16 轮对话触发 40 次摘要，
        //   上下文只占窗口 12%——"连续收不动就升级付费摘要"在小窗口是兜底，在大窗口是净亏损）。
        //   两项都**只拦"升级到付费摘要"**，不拦上面的免费收缩（那是零成本的，已跑过）。
        //   默认档把两项都设为 0 = 不拦 ⇒ 存量路径逐字不变；long-task / local 档才启用。
        const escalationFloor = Number(context.escalateTokenFloor ?? 0)
        const windowNow = Number(context.window || 0)
        // 水位闸：上下文够小 ⇒ 条数多只是"消息碎"，不是"装不下"，不值得付费摘要。
        const underTokenPressure = !(escalationFloor > 0 && windowNow > 0)
          || est.total >= windowNow * escalationFloor
        // 频次护栏：两次升级之间至少间隔 N 次 preStep（≈ N 次工具调用），防摘要风暴。
        // 计数放在 context 上（与既有的 context.__escalatedFromNoShrink 同风格，无需新状态机）。
        const callNo = (Number(context.__compactCallNo) || 0) + 1
        context.__compactCallNo = callNo
        const intervalNeed = Number(context.minSummaryIntervalCalls ?? 0)
        const intervalOk = !(intervalNeed > 0)
          || (callNo - (Number(context.__lastEscalateCallNo) || 0)) >= intervalNeed
        // 硬出口：条数严重超门（≥2×）说明确实装不下了，此时无论水位/间隔都给一次机会——
        // 否则"低水位 + 条数爆炸"会永久卡死（没有别的出口，且这正是本次修复要避免的**新**死锁）。
        const hardOver = Number(maxMessages) > 0 && messages.length >= Number(maxMessages) * 2
        const shouldEscalate = Number.isFinite(escalationLimit) && escalationLimit > 0
          && consecutiveCountNoShrink >= escalationLimit
          && (underTokenPressure || hardOver)
          && (intervalOk || hardOver)
        // 记录本次升级（仅在实际放行时记；被拦下的轮次不消耗间隔配额）
        if (shouldEscalate) context.__lastEscalateCallNo = callNo
        if (!shouldEscalate) {
          return {
            action: 'none',
            reason: 'count-over-no-shrink',
            msgs,
            est: est.total,
            maxMessages,
            // ★ 把这个计数**透出去**：否则"条数在涨但一直 no-shrink"从返回上看与正常无差别，
            //   没人能发现它正在失控（这正是原缺陷的隐蔽之处）。
            noShrinkStreak: consecutiveCountNoShrink,
            escalateAt: escalationLimit,
            // 同上：清了东西（哪怕降幅不够）也改变了内容 epoch ⇒ 归因需要知道
            shrunk: touched,
            // ★ 补强后必须把"这轮清了但没压下去"如实透出：只说 streak 看不出
            //   "cleared=1 但 gain≈0"与"cleared=0"是同一类问题（都在收不动）。
            ...(touched ? {
              clearedButTiny: shrink.cleared,
              ...(shrink.agedInputs > 0 ? { agedInputs: shrink.agedInputs } : {}),
              gainRatio: Number(gainRatio.toFixed(4)),
            } : {}),
          }
        }
        // 连续收不动 ⇒ 认定免费路径无解，继续往下走熔断门与模型摘要。
        // 摘要后计数清零（下一轮重新观察）。
        consecutiveCountNoShrink = 0
        context.__escalatedFromNoShrink = true
      }
      // A3：熔断后仍可跑免模型 pruner（零成本），模型摘要经冷却门控（见 circuitGate）
      if (!circuitGate(context.estimate ? context.estimate({ system, messages, tools }).total : 0)) {
        return { action: 'none', reason: 'circuit-open', failures: consecutiveFailures }
      }
      // 阶段② 主模型摘要（A4：传真实窗口 limit——摘要请求自身按窗口限幅，防压缩
      // 请求超端点硬限被 400/挂起，压缩永不落地）
      return summarize({ system, messages, limit: window })
    },
    // 溢出兜底：跳过阈值判定直接强制压缩；仅当 replaceGeneration 前进（调用方校验）才 retry。
    // 摘要前先免费收缩（阶段0+①）：小窗口模型切换后 covered 巨大（1M/200K 历史 → 32K
    // 窗口），先清可重放旧结果/裁剪超大结果把 covered 压到最小，分块摘要段数随之减少。
    async forceCompact({ system, messages, limit, retainHint }) {
      if (!circuitGate(0)) return { action: 'none', reason: 'circuit-open', failures: consecutiveFailures }
      const w = context.window ?? 200_000
      freeShrink(messages, { window: w, env, age: true })
      return summarize({ system, messages, limit, retainHint })
    },
    lastSummary: () => lastSummary,
    // 窗口真实化：engine 在 400 溢出解析出端点真实 max_model_len 后调用
    adoptWindow,
  }
}

// —— 档位（profile）真源：长任务 / 常规 / 本地部署 / 小窗口 ——
// 2026-10-26（用户裁定：要"能支持长任务的配置方案"，不是把 120 调到 240 的单点调参）：
// 把散落在 6 个 env 里的压缩节奏参数收进一张表，用一个档位名整体切换。
// 为什么必须分档而不是调默认值：同一条 `maxMessages=120` 在 1M 窗口（600 条都够用）
// 与 32K 窗口（120 条已近半窗）上的含义完全不同；本地部署模型还要再叠加
// "prefill 慢 ⇒ 摘要请求真实代价高 ⇒ 宁可更少摘要"这一层。
//
// 四档的共同不变量：thresholdRatio / retainRatio 的**默认值**必须与本次改动之前
// 逐字一致（0.8 / 0.16）——保证存量用户在 balanced 档上行为零变化。
export const COMPACT_PROFILE_NAMES = Object.freeze(['small-window', 'balanced', 'local', 'long-task'])

// 条数门：clamp(window / 1700, lo, hi)。
// 除数 1700 的来历（**不是拍的**）：它必须让 **200K 窗口仍得到 120**
// （200000/1700 = 117 < 120，被下限兜住 ⇒ kernel-tests/compact-count-gate.test.mjs:20
// 那条"window=200_000 → maxMessages=120"的断言**零改动保持绿**），同时让 1M 窗口得到
// 600（1048576/1700 = 616 → 上限）。换任何更小的除数都会破那条断言；换更大的则
// 1M 也到不了 300，长任务档失去意义。★ 改这个数之前先读本条。
export const COMPACT_MAX_MESSAGES_DIVISOR = 1700
const countGateFor = (window, lo, hi) => {
  const w = Number(window)
  const n = Number.isFinite(w) && w > 0 ? Math.floor(w / COMPACT_MAX_MESSAGES_DIVISOR) : 0
  return Math.min(hi, Math.max(lo, n))
}

export const COMPACT_PROFILES = Object.freeze({
  'small-window': Object.freeze({
    thresholdRatio: 0.8, retainRatio: 0.16, maxRetainRatio: 0.5, keepTargetRatio: 0.5,
    maxMessages: () => 120, escalateTokenFloor: 0, minSummaryIntervalCalls: 0,
  }),
  // 默认档：与改动前逐字对齐（0.8 / 0.16 / 0.5 / 120@200K），只在窗口变大时放大条数门。
  // ★ M1/M2（水位闸 + 频次护栏）在默认档**关闭**（0 = 不拦）：它们是为长任务与本地部署
  //   新增的护栏，默认路径一律不启用 ⇒ 存量行为零变化（含全部运行时回归用例——
  //   另有多条用例期待"低 token 水位下也能 summarized"，默认开启会直接打破它们）。
  balanced: Object.freeze({
    thresholdRatio: 0.8, retainRatio: 0.16, maxRetainRatio: 0.5, keepTargetRatio: 0.5,
    maxMessages: (w) => countGateFor(w, 120, 300), escalateTokenFloor: 0, minSummaryIntervalCalls: 0,
  }),
  // 本地部署（vLLM / Ollama 等，PONOS_PROVIDER_PROFILE=local；如 128K 的 Qwen3.8-27B）：
  // 窗口常常只有 32K–128K，且 prefill 比云端慢一个量级 ⇒ 一次摘要请求的真实代价高得多。
  // 三处收紧：水位门槛抬高（0.35）、最小摘要间隔拉长（60 次工具调用）、续航加长（keepTarget 0.35）。
  // ★ 为什么 local **优先于**窗口大小判断：本地模型即使标 1M（某些 vLLM 配置会这么填），
  //   实际 prefill 仍慢；按窗口自动进 long-task 会适得其反。
  local: Object.freeze({
    thresholdRatio: 0.8, retainRatio: 0.16, maxRetainRatio: 0.5, keepTargetRatio: 0.35,
    maxMessages: (w) => countGateFor(w, 120, 300), escalateTokenFloor: 0.35, minSummaryIntervalCalls: 60,
  }),
  // 长任务（≥500K 窗口）：条数门放大到 5 倍、续航约 8 倍、付费摘要必须"值得"。
  'long-task': Object.freeze({
    thresholdRatio: 0.75, retainRatio: 0.10, maxRetainRatio: 0.4, keepTargetRatio: 0.20,
    maxMessages: (w) => countGateFor(w, 300, 600), escalateTokenFloor: 0.30, minSummaryIntervalCalls: 40,
  }),
})

/** 自动档位：本地画像优先（见 COMPACT_PROFILES.local 的说明），其次按窗口。 */
export function autoCompactProfile(window = 200_000, env = process.env) {
  if (env?.PONOS_PROVIDER_PROFILE === 'local') return 'local'
  const w = Number(window)
  if (Number.isFinite(w) && w >= 500_000) return 'long-task'
  if (Number.isFinite(w) && w > 0 && w < 100_000) return 'small-window'
  return 'balanced'
}

/**
 * 档位解析：显式（settings/env）→ 自动（按画像与窗口）→ 非法值回落自动并**出声**。
 * 非法值不静默：返回 source='fallback' 且带 requested，调用方据此事发 compact_profile 事件
 * （否则"以为开了 long-task、实际还是 balanced"这类错配无从发现）。
 * @param {{ window?: number, settings?: any, env?: any }} [opts]
 * @returns {{ profile: string, source: 'explicit'|'auto'|'fallback', requested?: string }}
 */
export function resolveCompactProfile({ window = 200_000, settings = {}, env = process.env } = {}) {
  const raw = settings?.compact?.profile ?? env?.PONOS_COMPACT_PROFILE
  const auto = autoCompactProfile(window, env)
  if (raw == null || String(raw).trim() === '') return { profile: auto, source: 'auto' }
  const v = String(raw).trim()
  // hasOwnProperty 而非 includes/property access：防 'constructor' / '__proto__' 命中原型链
  if (Object.prototype.hasOwnProperty.call(COMPACT_PROFILES, v)) return { profile: v, source: 'explicit' }
  return { profile: auto, source: 'fallback', requested: v }
}

// —— L2-1 预算配置化：settings.compact { thresholdTokens, reserveTokens, maxToolResults } ——
// 默认对齐现状（0.8 / 0.16 / env 预算）；数值配置按 window 换算 ratio。
/**
 * L2-1 预算配置化：settings.compact { thresholdTokens, reserveTokens, maxToolResults }。
 * @param {{ window?: number, settings?: any, env?: any }} [opts]
 */
export function resolveCompactSettings({ window = 200_000, settings = {}, env = process.env } = {}) {
  const c = settings.compact || {}
  const resolved = resolveCompactProfile({ window, settings, env })
  const P = COMPACT_PROFILES[resolved.profile] || COMPACT_PROFILES.balanced
  const thresholdTokens = Number(c.thresholdTokens)
  const reserveTokens = Number(c.reserveTokens)
  const maxToolResults = Number(c.maxToolResults)
  const maxMessages = Number(c.maxMessages)
  const thresholdRatio = Number.isFinite(thresholdTokens) && thresholdTokens > 0
    ? Math.min(1, Math.max(0.01, thresholdTokens / window))
    : P.thresholdRatio
  const retainRatio = Number.isFinite(reserveTokens) && reserveTokens > 0
    ? Math.min(0.5, Math.max(0.001, reserveTokens / window))
    : P.retainRatio
  const toolResultBudget = Number.isFinite(maxToolResults) && maxToolResults > 0
    ? maxToolResults
    : Number(env.PONOS_TOOL_RESULT_BUDGET_BYTES || 20000)
  // T1 条数触发口：settings.compact.maxMessages 显式给值优先（含 0=关闭），其次 env，
  // 最后**档位默认**（此前是硬编码 120 —— 1M 窗口与 32K 窗口共用同一把尺，见文件头
  // 档位表的说明）。
  const maxMessagesCfg = Number.isFinite(maxMessages) && maxMessages >= 0
    ? maxMessages
    : Number(env.PONOS_COMPACT_MAX_MESSAGES)
  const maxMessagesOut = Number.isFinite(maxMessagesCfg) && maxMessagesCfg >= 0
    ? maxMessagesCfg
    : P.maxMessages(window)
  // ★ 2026-10-26：以下四项此前**只能走 env**（`summarize` 里读 `context.X ?? env.X`），
  //   而 cli.mjs 送进 context 的只有前四个参数 ⇒ 号称"预算配置化"的真源实际漏了一半参数。
  //   现补齐：settings > env > 档位默认；逐项独立可覆盖（`escalateTokenFloor: 0` = 关闭水位闸）。
  const pick = (explicit, envKey, dft) => {
    const v = explicit ?? env[envKey]
    return Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dft
  }
  const maxRetainRatio = pick(c.maxRetainRatio, 'PONOS_COMPACT_MAX_RETAIN_RATIO', P.maxRetainRatio)
  const keepTargetRatio = pick(c.keepTargetRatio, 'PONOS_COMPACT_KEEP_TARGET_RATIO', P.keepTargetRatio)
  const escalateTokenFloor = pick(c.escalateTokenFloor, 'PONOS_COMPACT_ESCALATE_TOKEN_FLOOR', P.escalateTokenFloor)
  const minSummaryIntervalCalls = pick(c.minSummaryIntervalCalls, 'PONOS_COMPACT_MIN_SUMMARY_INTERVAL_CALLS', P.minSummaryIntervalCalls)
  return {
    // 档位回执（调用方据此发 compact_profile 事件；本函数保持**纯**、不发事件）
    profile: resolved.profile,
    profileSource: resolved.source,
    ...(resolved.requested != null ? { profileRequested: resolved.requested } : {}),
    thresholdRatio, retainRatio, maxRetainRatio, keepTargetRatio,
    toolResultBudget, maxMessages: maxMessagesOut,
    escalateTokenFloor, minSummaryIntervalCalls,
  }
}
