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
import { countCjk } from './context.mjs'
import { extractEntities, missingEntities } from './fidelity.mjs'
import { patchOrphanToolUses } from './engine.mjs'

// P9-1：工具结果老化清除（microcompact 语义，对照 claude-code microCompact.ts）
// ---------------------------------------------------------------------------
// 零模型成本：上下文超过"老化清除阈值"时，把保留窗口之外的可重放工具
// （Read/Bash/Grep/Glob/WebFetch/OCR——结果可按需重新调用工具读取）结果整条
// 替换为占位标记。与阶段①结构采样的"每条内部保留部分"互补：这里整条丢弃，
// 体积削减更彻底；原文仍在 transcript，模型需要时重新 Read 恢复。
// Edit/Write/Agent/Task 等结果小且不可重放，一律不清。
export const CLEARED_TOOL_RESULT_MARKER = '[旧工具结果已清除——需要时重新调用工具读取]'
const REPLAYABLE_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'OCR'])

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
  // 与 claude-code microCompact 一致：最近 N 条结果不论类型一律保留，只清窗口外
  // 的可重放结果——否则 Edit/Write 的紧凑结果会挤占窗口导致可清条目永远不足）
  const results = [] // { i, j, replayable }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j]
      if (b?.type !== 'tool_result') continue
      const name = nameById.get(b.tool_use_id)
      results.push({ i, j, replayable: Boolean(name && REPLAYABLE_TOOLS.has(name)) })
    }
  }
  // 保留最近 keepRecent 条（floor 1，防全清后零工作上下文）；仅窗口外的可重放结果被清
  const keep = Math.max(1, Number(keepRecent) || 2)
  const cutoff = Math.max(0, results.length - keep)
  let cleared = 0
  for (const { i, j, replayable } of results.slice(0, cutoff)) {
    if (!replayable) continue
    const b = messages[i].content[j]
    if (typeof b.content === 'string' && b.content !== CLEARED_TOOL_RESULT_MARKER) {
      b.content = CLEARED_TOOL_RESULT_MARKER
      cleared++
    }
  }
  return cleared
}

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
// 不再吃掉半个窗口，大窗口（1M）封顶 24K 防过度裁剪。`CLAUDE_CODE_TOOL_RESULT_BUDGET=true`
// 布尔形态（bridge 旧注入）Number 为 NaN → 视为未显式，落入窗口缩放（安全侧）。
export function resolveToolResultBudget(env = process.env, window = 200_000) {
  const explicit = Number(env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES || env.CLAUDE_CODE_TOOL_RESULT_BUDGET)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const w = Number.isFinite(window) && window > 0 ? window : 200_000
  return Math.max(4000, Math.min(24000, Math.floor(w / 8)))
}

// 免费收缩（阶段0 老化清除 + 阶段① 结构裁剪）——零模型成本、确定性。maybeCompact
// （阈值触发）与 forceCompact（溢出兜底）共用：小窗口模型切换后的溢出路径同样先
// 免费收缩再摘要，covered 体量最小化（分块摘要段数随之减少）。age=false 时只裁剪
// 不清除（maybeCompact 老化需 est ≥ clearRatio 门控，见调用方）。
export function freeShrink(messages, { window = 200_000, env = process.env, age = true } = {}) {
  let cleared = 0
  if (age) cleared = ageOutToolResults(messages, { keepRecent: Number(env.CLAUDE_CODE_TOOL_RESULT_KEEP_RECENT || 2) })
  const budget = resolveToolResultBudget(env, window)
  let prunedAny = false
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_result' || typeof b.content !== 'string') continue
      const r = pruneToolResult(b.content, { budget })
      if (r.truncated) {
        b.content = r.text + '\n\n' + r.note
        prunedAny = true
      }
    }
  }
  return { cleared, prunedAny, budget }
}

// —— 切点纪律 ——
// messages = deriveMessages() 结果（不含 system）。切点 start 处必须是真实 user 消息
// （保留尾巴从新 turn 开始，遮蔽 [0, start) 结束于完整 turn 回复之后）。
// user 角色消息含两种：真实轮次起点 / tool_result 续接——只有前者可作为保留起点，
// 否则会拆散 assistant tool_use 与其 tool_result 配对。
function isTurnStart(m) {
  return m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
}

export function findCutPoint({ messages, retainTokens, estimateMessage }) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const last = messages[messages.length - 1]
  // open tail：最后一条 assistant 带 tool_use → 进行中 turn 不可切
  if (last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b?.type === 'tool_use')) return null
  // 从尾部向前累计保留预算（保留 = [idx, end)）
  let acc = 0
  let idx = messages.length
  while (idx > 0 && acc < retainTokens) { idx--; acc += estimateMessage(messages[idx]) }
  // 起点向后（向更早）对齐到最近完整 turn 边界：保留起点必须是真实 user 消息。
  // 估算位置落在工具回合中间时，把整轮收回保留区，遮蔽区间相应前移——保证
  // assistant tool_use 与其 tool_result 配对不因切点拆散。
  let start = idx
  while (start > 0 && !isTurnStart(messages[start])) start--
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
  return { todos, files, decisions }
}

export function keyInfoBlock(key) {
  const lines = []
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
    if (miss.total < minEntities) {
      return { entities, missing: [], total: miss.total, ratio: 0, skipped: true }
    }
    return { entities, missing: miss.missing, total: miss.total, ratio: miss.ratio }
  } catch { return { entities: [], missing: [], total: 0, ratio: 0, skipped: true } }
}

const FIDELITY_AUDIT_INSTRUCTION = [
  '你是事实保真审计器。对比下面的【原文摘录】与【摘要】，只报告"原文里有、摘要丢了或被改写"的关键事实。',
  '只输出 JSON，不要任何其他文字：',
  '{"ok":true,"missing":["原文有而摘要完全丢失的关键事实（路径/数字/约束/决策）"],"rewritten":["被改写的事实，格式 原值→新值"]}',
  '若没有丢失或改写，输出 {"ok":true,"missing":[],"rewritten":[]}。不要报告措辞差异。',
].join('\n')

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

// P9-3：会话工作记忆（session memory，对照 claude-code sessionMemoryCompact.ts）
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
    const reserve = Number(env.CLAUDE_CODE_COMPACT_RESERVE || 4096)
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
  async function callSummaryBody({ body, maxOut }) {
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
    const timer = setTimeout(() => { if (!gotData) ctrl.abort() }, firstByteMs)
    if (timer.unref) timer.unref()
    try {
      for await (const chunk of streamMessages({ model, messages: body, maxTokens: maxOut, signal: signal || ctrl.signal, tools: [] })) {
        gotData = true
        if (chunk.type === 'text') buf += chunk.text
        else if (chunk.type === 'usage') usage = addUsage(usage, chunk.usage)
      }
    } finally {
      clearTimeout(timer)
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
    return callSummaryBody({ body: req, maxOut })
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
      })
      const parsed = parseFidelityAudit(text)
      if (parsed.missing.length || parsed.rewritten.length) {
        try { onCompactionAudit?.({ entities: [], missing: parsed.missing, ratio: 0, llm: parsed }) } catch { /* 静默 */ }
      }
    } catch { /* 审计失败静默：不计熔断、不影响压缩落地 */ } finally { auditInFlight = false }
  }

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
    function landSummary(summary, c, coveredTk) {
      const coveredSeqs = session.seqsForMessages(c.covered)
      if (!Array.isArray(coveredSeqs) || coveredSeqs.length === 0 || coveredSeqs.length !== c.covered.length) {
        throw new Error(
          `内核：压缩遮蔽区间 seq 反查失败（covered ${c.covered.length} 条 → seqs ${coveredSeqs?.length ?? 0} 条）——` +
          'covered 必须来自同一 surface 代的 deriveMessages() 结果'
        )
      }
      session.appendCompactionStart(coveredSeqs)
      session.appendCompactionSummary({ summary, coveredSeqs })
      lastSummary = summary
      compactOk = true
      if (health) health.recordCompaction?.(summary, session.compactCount())
      else wire.summary?.(summary, session.compactCount())
      // 保真审计（spec §4.1）：必须在压缩落地之后。确定性审计同步做（零模型成本），
      // LLM 审计 fire-and-forget（不进 await 链，绝不拖慢压缩落地与轮次时延）。
      try {
        const audit = auditSummaryFidelity({ covered: c.covered, summary })
        if (!audit.skipped) onCompactionAudit?.({ ...audit })
      } catch { /* 审计失败不影响压缩落地 */ }
      void auditFidelityAsync(summary, c.covered)
      return { action: 'summarized', summary, compactCount: session.compactCount(), usage, coveredTokens: coveredTk }
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
      let cut = findCutPoint({ messages, retainTokens, estimateMessage: context.estimateMessage })
      if (!cut) return { action: 'none', reason: 'no-cut-point' }
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
            const { text, usage: callUsage } = await callSummaryBody({ body, maxOut: summarizerMaxOut })
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
      wire?.system?.('compaction', { state: 'start', covered: cut.covered.length, coveredTokens })
      compactEmitted = true
      const retries = Number(env.CLAUDE_CODE_COMPACTION_RETRIES || 3)
      let summary = null
      let converged = false
      for (let attempt = 0; attempt < retries; attempt++) {
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
        if (summaryTokens < coveredTokens) { summary = s; converged = true; break }
        consecutiveFailures++
        // A2 收敛失败自愈：covered 减半重摘（保留预算翻倍）；末次仍不收敛时截断
        // 摘要按头 60% 落地——压缩必须落地（宁可有损，不无限重试烧时间）。
        if (attempt === retries - 1) {
          const cap = Math.floor(s.length * 0.6)
          summary = s.slice(0, cap) + '\n…（摘要过长，已截断落地）'
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
      if (!converged || !summary) {
        consecutiveFailures++
        // 调用已发生（被计费）→ usage 一并返回，engine 侧并入本轮统计
        return { action: 'none', reason: 'no-convergence', failures: consecutiveFailures, usage }
      }
      consecutiveFailures = 0
      return landSummary(summary, cut, coveredTokens)
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
    async maybeCompact({ system, messages, outputBudget }) {
      const window = context.window ?? 200_000
      const threshold = resolveThreshold({ window, outputBudget })
      const est = context.estimate ? context.estimate({ system, messages }) : { total: 0 }
      if (est.total < threshold) return { action: 'none', reason: 'below-threshold' }
      // 阶段0+① 免费收缩（老化清除 + 结构裁剪）：零模型成本先压上下文。
      // 老化清除（P9-1）——上下文超过 clearRatio 时清可重放旧工具结果；清除后回落
      // 到 threshold 之下则本轮免摘要（压缩次数↓）。裁剪预算随窗口缩放（32K 窗口 →
      // 4K 字符/条），小窗口本地模型单条大文件读取不再吃掉半个窗口。
      const clearRatio = Number(env.CLAUDE_CODE_TOOL_RESULT_CLEAR_RATIO || 0.5)
      const shrink = freeShrink(messages, { window, env, age: est.total >= Math.floor(window * clearRatio) })
      if (shrink.cleared > 0) {
        const est1 = context.estimate({ system, messages })
        if (est1.total < threshold) return { action: 'aged', reason: `tool-results-aged-${shrink.cleared}`, cleared: shrink.cleared }
      }
      if (shrink.prunedAny) {
        const est2 = context.estimate({ system, messages })
        if (est2.total < threshold) return { action: 'pruned', reason: 'tool-result-pruned' }
      }
      // A3：熔断后仍可跑免模型 pruner（零成本），模型摘要经冷却门控（见 circuitGate）
      if (!circuitGate(context.estimate ? context.estimate({ system, messages }).total : 0)) {
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

// —— L2-1 预算配置化：settings.compact { thresholdTokens, reserveTokens, maxToolResults } ——
// 默认对齐现状（0.8 / 0.16 / env 预算）；数值配置按 window 换算 ratio。
export function resolveCompactSettings({ window = 200_000, settings = {}, env = process.env } = {}) {
  const c = settings.compact || {}
  const thresholdTokens = Number(c.thresholdTokens)
  const reserveTokens = Number(c.reserveTokens)
  const maxToolResults = Number(c.maxToolResults)
  const thresholdRatio = Number.isFinite(thresholdTokens) && thresholdTokens > 0
    ? Math.min(1, Math.max(0.01, thresholdTokens / window))
    : 0.8
  const retainRatio = Number.isFinite(reserveTokens) && reserveTokens > 0
    ? Math.min(0.5, Math.max(0.001, reserveTokens / window))
    : 0.16
  const toolResultBudget = Number.isFinite(maxToolResults) && maxToolResults > 0
    ? maxToolResults
    : Number(env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES || 20000)
  return { thresholdRatio, retainRatio, toolResultBudget }
}
