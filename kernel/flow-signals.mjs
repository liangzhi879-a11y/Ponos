import { createHash } from 'node:crypto'

/**
 * P5b（2026-10-27）：OPP-14a / OPP-14b 的**信号层**。
 *
 * 为什么单独一个模块、而不是塞进 `opportunity-mine`：
 * 现有 `records` 是**聚合投影**（只有计数，没有命令原文、没有用户原话），
 * 而 OPP-14 的判据（"同一外部系统的操作序列"、"版式信号词"）**必须看原文**。
 * ⇒ 需要一层"从 transcript 行里抽信号"。本模块就是那层，**纯函数**：
 * 输入已解析的 transcript 事件行，输出信号；不碰磁盘、不碰投影缓存、不改 schema。
 *
 * 输入契约（与 `kernel/tui.mjs#readTranscriptHistory` 认的落盘形态一致）：
 *   `{ message: { role, content } }`，content 为字符串或块数组；
 *   Bash 调用在 assistant 的 `{ type:'tool_use', name:'Bash', input:{ command } }` 块里。
 */

/**
 * 版式信号词（OPP-14b 用）。**宁可少**：宽泛词会把普通对话也算成版式需求。
 * ★ 实测剔除（2026-10-27，真机 400 transcript）：`清单` 以 130 次/130 会话霸榜 ——
 *   但命中的是"收资清单""材料清单"这类**文档名**，不是"把结果做成清单版式"的需求。
 *   一个词只要能被文档名/流程名命中，它就不是版式信号词。
 */
export const LAYOUT_WORDS = Object.freeze(['表格', '报表', '看板', '仪表盘', 'dashboard', '表格化'])

/** 阈值（设计稿 §6.1；`minCommands` 只对 14a 有意义） */
export const FLOW_THRESHOLDS = Object.freeze({
  'OPP-14a': Object.freeze({ minCalls: 6, crossSessions: 2, minCommands: 3 }),
  'OPP-14b': Object.freeze({ minLayoutHits: 2, crossSessions: 2 }),
})

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => String(b.text || '')).join('\n')
  return ''
}

/**
 * 命令的"目标"= **URL 主机**；没有 URL ⇒ 空（不进候选）。
 *
 * ★ 实测教训（2026-10-27，真机 400 个 transcript）：先按"首个非选项 token"兜底时，
 *   榜首变成 `cd`（33279 次、266 会话）——那是 shell 内导航，不是"外部系统"。
 *   OPP-14a 的定义是"反复手搓同一**外部系统**的操作序列"，所以没有主机名就没有这条规则的事；
 *   宁可漏掉本地脚本，也不把 `cd`/`git`/`npm` 这类内置动作包装成"该做成应用"的需求。
 */
/** 回环地址不是"外部系统"：那是我们自己的 bridge/本地服务（照它出 MCP 草稿毫无意义） */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'])

export function targetOf(command) {
  const s = String(command || '')
  const m = /https?:\/\/([^/\s'"?]+)/i.exec(s)
  if (!m) return ''
  const host = m[1].toLowerCase().replace(/:\d+$/, '')
  return LOOPBACK.has(host) ? '' : host
}

/**
 * 从 transcript 事件行抽信号（纯函数）。
 * @param {Array<object>} events 已解析的行
 * @param {{ sessionId?: string }} [o]
 * @returns {{ commands: Array<{sessionId:string,ts:string|null,command:string,target:string}>, layoutHits: Array<{sessionId:string,ts:string|null,word:string}> }}
 */
export function extractFlowSignals(events, { sessionId = '' } = {}) {
  const commands = []
  const layoutHits = []
  const sid = String(sessionId || '')
  for (const e of Array.isArray(events) ? events : []) {
    const m = e?.message
    if (!m || typeof m !== 'object') continue
    const ts = typeof e?.timestamp === 'string' ? e.timestamp : null
    if (m.role === 'user') {
      const text = textOf(m.content)
      if (!text) continue
      for (const w of LAYOUT_WORDS) if (text.includes(w)) layoutHits.push({ sessionId: sid, ts, word: w })
      continue
    }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_use' || b?.name !== 'Bash') continue
      const command = String(b?.input?.command || '').trim()
      if (!command) continue
      commands.push({ sessionId: sid, ts, command, target: targetOf(command) })
    }
  }
  return { commands, layoutHits }
}

/** 同一目标是否跨会话出现（阈值判据共用） */
const sessionsOf = (items) => new Set(items.map((i) => i.sessionId).filter(Boolean))

/**
 * 出候选（纯函数）。未达门 ⇒ 不出（宁可漏，不可造假需求）。
 * @param {{ commands?: Array<object>, layoutHits?: Array<object> }} signals
 * @returns {Array<{ ruleId:string, subject:string, metrics:object, refs:Array<object> }>}
 */
export function mineFlowCandidates(signals = {}) {
  const out = []
  const commands = Array.isArray(signals.commands) ? signals.commands : []
  const layoutHits = Array.isArray(signals.layoutHits) ? signals.layoutHits : []

  // ── OPP-14a：反复手搓同一外部系统的操作序列 ────────────────────────────────
  const byTarget = new Map()
  for (const c of commands) {
    if (!c?.target) continue
    if (!byTarget.has(c.target)) byTarget.set(c.target, [])
    byTarget.get(c.target).push(c)
  }
  const th14a = FLOW_THRESHOLDS['OPP-14a']
  for (const [target, list] of byTarget) {
    const sessions = sessionsOf(list)
    const distinct = new Set(list.map((c) => c.command))
    if (list.length < th14a.minCalls) continue
    if (sessions.size < th14a.crossSessions) continue
    if (distinct.size < th14a.minCommands) continue
    out.push({
      ruleId: 'OPP-14a',
      subject: target,
      metrics: {
        calls: list.length,
        sessions: sessions.size,
        distinctCommands: distinct.size,
        // 强度 = 调用数相对阈值（与 OPP-1 的 freqRatio 语义一致：恰在阈值 = 1）
        freqRatio: Number((list.length / th14a.minCalls).toFixed(2)),
      },
      refs: list.slice(0, 5).map((c) => ({ sessionId: c.sessionId, ts: c.ts, command: c.command })),
    })
  }

  // ── OPP-14b：反复要求同一类**版式**输出 ────────────────────────────────────
  const th14b = FLOW_THRESHOLDS['OPP-14b']
  // 按 (会话 × 词) 去重：同一句里说两遍"表格"不算两次需求
  const perSessionWord = new Set()
  const perWord = new Map()
  for (const h of layoutHits) {
    const key = `${h.sessionId}|${h.word}`
    if (perSessionWord.has(key)) continue
    perSessionWord.add(key)
    if (!perWord.has(h.word)) perWord.set(h.word, [])
    perWord.get(h.word).push(h)
  }
  for (const [word, list] of perWord) {
    const sessions = sessionsOf(list)
    if (sessions.size < th14b.crossSessions) continue
    const hits = list.length
    if (hits < th14b.minLayoutHits) continue
    out.push({
      ruleId: 'OPP-14b',
      subject: word,
      metrics: {
        hits,
        sessions: sessions.size,
        freqRatio: Number((hits / th14b.minLayoutHits).toFixed(2)),
        // 14b 的产物必须带 `ui`（版式从 L3 里选）—— 这是给人看的约束，不是我们可以自动决定的
        requiresUi: true,
      },
      refs: list.slice(0, 5).map((h) => ({ sessionId: h.sessionId, ts: h.ts })),
    })
  }

  // 稳定排序：强度降序 → 规则 → 主题（同一批输入必须出同一顺序，否则台账会漂）
  out.sort((a, b) => (b.metrics.freqRatio - a.metrics.freqRatio)
    || a.ruleId.localeCompare(b.ruleId)
    || a.subject.localeCompare(b.subject))
  return out
}

/** 候选 id（与 opportunity-mine 同规则：稳定、跨扫描可归并） */
export function flowCandidateId(ruleId, subject) {
  return createHash('sha256').update(`${ruleId}|${subject}`).digest('hex').slice(0, 12)
}
