// 上下文失真检测（2026-09-12 spec：docs/superpowers/specs/2026-09-12-context-fidelity-health-design.md §1-§5）
// ---------------------------------------------------------------------------
// 被测量 = 失真（上下文还准不准），而非压力（还能装多少）。两者统计上近乎不相关，
// 故本模块与 health.mjs 的压力计分完全独立：压力继续当血条仪表，失真是弹窗触发器。
//
// 三轴（彼此独立计分，不跨轴求和稀释）：
//   memory    记忆保真——压缩后摘要是否丢/改了关键事实（真值：被压缩原文）
//   coherence 自洽性——内部矛盾 + 与工具记录冲突/陈旧引用（真值：上下文自身 + 工具结果）
//   goal      目标保真——是否偏离最初任务（真值：会话首条真实 user 消息）
//
// 判定铁律：
//   ① 强证据直通、中证据只到 amber：把"用户纠错一次"与"某处取值不一致"相加再除以项数，
//      等于用噪声稀释强证据。故 red 只能由 strong 触发；medium 无论多少条最多 amber（65 分封顶）。
//   ② 真值优先级：用户纠错 > 工具记录/文件系统/实体覆盖 > 模型自评。
//      模型自评（llm 保真审计）最高只计 medium——模型判断"我是否失真"本身就可能是失真的那层。
//   ③ 误报是对用户的"指控"，必须宁漏勿误：无信号恒 green；amber 不弹窗；
//      用户显式改需求 = 合法转向（锚点跟随用户）；显式演进语（"已改为"）不计矛盾。
//   ④ 有半衰期且可回绿：证据按轮龄指数衰减，出窗即退出计分；markResolved 立即回绿，
//      同源复发则复活并打 recurred 标记（前端据此把动作升级为"新建会话"）。
//      压力红档没有回绿路径，失真语义下必须有。
//
// 全程 try/catch 静默降级：检测器异常绝不影响主流程。

// 显式演进语：出现即视为"合法更新"，不计入矛盾（本检测器最大误报源）
const EVOLVE_MARKERS = /改为|更新为|已修正|已改|换成|弃用|调整为|修订为|替换为/
const CORRECTION_PATTERNS = [
  /我(?:前面|之前|刚才|早就)?说过/, /不是这样/, /我明明/, /又(?:错|来)了/,
  /\bagain\b/i, /\bno,?\s*i\s*said\b/i, /我说的是/, /你怎么又/, /搞错了/,
]
const REQUIREMENT_CHANGE_PATTERNS = [
  /先放一放/, /改做|改成|换个任务|换一个|改一下需求/, /需求变更/, /重新开始做/, /不做了|算了/,
]
const CONSTRAINT_MARKERS = /必须|不得|只能|默认|上限|下限|禁止|仅|务必|一定/

// 句子切分：**刻意不含 ASCII '.'**——它会把 src/a.ts、0.8、v1.2.3 切碎（实测踩过）
const SENTENCE_SPLIT = /[。！？\n；;!?]/
const PATH_WIN_RE = /[A-Za-z]:[\\/][^\s"'`，。；：、,;:]+/g
const PATH_UNIX_RE = /(?:^|[\s(["'`])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+)/g
const FILE_EXT_RE = /\b[\w-]+\.(?:md|ts|tsx|js|mjs|cjs|json|py|yml|yaml|xlsx|docx|pdf|txt|csv|toml|ini)\b/g
const BACKTICK_RE = /`([^`\n]{1,120})`/g
const NUMBER_RE = /\b\d+(?:\.\d+)?\b/g
const MODEL_NAME_RE = /\b[a-z][a-z0-9]*(?:-[a-z0-9.]+){1,3}\b/g
const UPPER_TOKEN_RE = /\b[A-Z][A-Z0-9_-]{3,}\b/g
const CJK_RUN_RE = /[\u4e00-\u9fa5]{2,}/g
const LATIN_WORD_RE = /\b[a-zA-Z][a-zA-Z0-9_-]{2,}\b/g
// 功能字/停用词：拆开长中文串，避免把整句当实体（否则覆盖比对永远命中不了）
const CJK_FUNCTION_CHARS = /[的了和与是在把为对就都也很又而其之给从到等并但却则因所以及一二三]/
const CJK_STOP = new Set(['这个', '那个', '我们', '你们', '他们', '可以', '应该', '必须', '需要', '然后', '因为', '所以', '已经', '如果', '但是', '以及', '或者', '就是', '不是', '一个', '进行', '使用', '通过', '目前', '当前', '问题', '情况', '方式', '内容', '部分', '结果', '时候', '地方', '东西', '什么', '怎么', '为了', '对于', '关于', '根据', '按照', '由于', '并且', '而且', '不过', '虽然', '可能', '一定', '要求', '继续', '开始', '完成', '好的', '可以了'])
const EN_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'not', 'but', 'you', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'can', 'should', 'must', 'its', 'all', 'any', 'our', 'out', 'use', 'via', 'one', 'two', 'new', 'old', 'get', 'set', 'add', 'fix'])

export const DEFAULT_FIDELITY_CONFIG = {
  enabled: true,
  windowTurns: 12,
  decay: 0.85,
  red: 70,
  amber: 40,
  summaryMissingStrong: 0.4,
  summaryMissingMedium: 0.2,
  minEntities: 3,
  goalCoverageMin: 0.15,
  goalWindow: 6,
  goalMinEntities: 2,
  observeTurns: 3,
  maxText: 200_000,
  maxIssues: 40,
}

const MEDIUM_ONLY_CAP = 65 // 中证据封顶 < red(70)：red 必须由强证据触发
const STRONG_WEIGHT = 1
const MEDIUM_WEIGHT = 0.6
const MEDIUM_PER_POINT = 30 // 单条 medium = 30 分（< amber 40）；两条 = 60（amber）
const MEDIUM_FOR_AMBER = 2

const GREEN = Object.freeze({
  score: 0, tier: 'green', axes: { memory: 0, coherence: 0, goal: 0 },
  issues: [], trigger: null, observeUntilTurn: null, anchorAvailable: false,
})

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

export function fidelityConfigFromEnv(env = process.env) {
  const e = env || {}
  const cfg = { ...DEFAULT_FIDELITY_CONFIG }
  if (String(e.PONOS_FIDELITY) === '0') cfg.enabled = false
  cfg.windowTurns = Math.max(1, Math.floor(num(e.PONOS_FIDELITY_WINDOW, cfg.windowTurns)))
  cfg.decay = Math.min(0.999, Math.max(0.1, num(e.PONOS_FIDELITY_DECAY, cfg.decay)))
  cfg.red = num(e.PONOS_FIDELITY_RED, cfg.red)
  cfg.amber = num(e.PONOS_FIDELITY_AMBER, cfg.amber)
  cfg.summaryMissingStrong = num(e.PONOS_FIDELITY_SUMMARY_MISSING_STRONG, cfg.summaryMissingStrong)
  cfg.summaryMissingMedium = num(e.PONOS_FIDELITY_SUMMARY_MISSING_MEDIUM, cfg.summaryMissingMedium)
  cfg.goalCoverageMin = num(e.PONOS_FIDELITY_GOAL_COVERAGE_MIN, cfg.goalCoverageMin)
  cfg.observeTurns = Math.max(0, Math.floor(num(e.PONOS_FIDELITY_OBSERVE_TURNS, cfg.observeTurns)))
  cfg.maxText = Math.max(1000, Math.floor(num(e.PONOS_FIDELITY_MAX_TEXT, cfg.maxText)))
  return cfg
}

// 归一化只用于"比对"，展示保留原形（raw 由 detail 携带）
export function normalizeEntity(s) {
  let t = String(s ?? '')
  if (!t) return ''
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角→半角
  t = t.replace(/[`*_~]/g, '')            // markdown 装饰
  t = t.replace(/\s+/g, ' ').trim()
  t = t.replace(/\\/g, '/')
  return t.toLowerCase()
}

function uniqRaw(list, max) {
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const s = String(raw ?? '').trim().replace(/[，。；：、]+$/, '')
    if (!s) continue
    const key = normalizeEntity(s)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/**
 * 实体抽取。kinds='key' 只取高信号实体（路径/数字/反引号/常量/模型名），用于
 * **摘要覆盖比对与纠错定位**（这两处对噪声极敏感，通用词会把缺失率稀释掉）；
 * kinds='all' 另含中文/英文关键词，用于**目标漂移的覆盖率**（需要泛化词）。
 */
export function extractEntities(text, { max = 200, kinds = 'all' } = {}) {
  try {
    const raw = String(text ?? '').slice(0, 200_000)
    if (!raw) return []
    const found = []
    const cut = (s) => String(s).replace(/[，。；：、,;:]+$/, '')
    for (const m of raw.matchAll(PATH_WIN_RE)) found.push(cut(m[0]))
    for (const m of raw.matchAll(PATH_UNIX_RE)) found.push(cut(m[1]))
    for (const m of raw.matchAll(FILE_EXT_RE)) found.push(cut(m[0]))
    for (const m of raw.matchAll(BACKTICK_RE)) found.push(m[1].trim())
    for (const m of raw.matchAll(NUMBER_RE)) {
      const s = m[0]
      if (s.length >= 2) found.push(s) // 裸数字（阈值/行号/轮数）；单字符数字噪声太大
    }
    for (const m of raw.matchAll(MODEL_NAME_RE)) {
      const s = m[0]
      if (s.length >= 6 && !/\.(com|cn|org|net)$/.test(s)) found.push(s)
    }
    for (const m of raw.matchAll(UPPER_TOKEN_RE)) found.push(m[0])
    const keyOnly = uniqRaw(found, max)
    if (kinds === 'key') return keyOnly
    const words = []
    for (const m of raw.matchAll(CJK_RUN_RE)) {
      for (const piece of m[0].split(CJK_FUNCTION_CHARS)) {
        const w = stripStopWords(piece.trim())
        if (w.length >= 2) words.push(w.slice(0, 12))
      }
    }
    for (const m of raw.matchAll(LATIN_WORD_RE)) {
      const w = m[0]
      if (w.length >= 3 && !EN_STOP.has(w.toLowerCase())) words.push(w)
    }
    return uniqRaw([...keyOnly, ...uniqRaw(words, 60)], max)
  } catch { return [] }
}

// 剥掉首尾停用词："必须保留"→"保留"（否则覆盖比对永远命中不了"仍需保留"这类同义表述）
function stripStopWords(w) {
  let s = w
  for (let i = 0; i < 4 && s.length > 1; i++) {
    let changed = false
    for (const sw of CJK_STOP) {
      if (s.length > sw.length && s.startsWith(sw)) { s = s.slice(sw.length); changed = true }
      if (s.length > sw.length && s.endsWith(sw)) { s = s.slice(0, -sw.length); changed = true }
    }
    if (!changed) break
  }
  return CJK_STOP.has(s) ? '' : s
}

export function missingEntities(entities, summary) {
  try {
    const list = Array.isArray(entities) ? entities.filter(Boolean) : []
    const total = list.length
    if (!total) return { missing: [], total: 0, ratio: 0 }
    const hay = normalizeEntity(String(summary ?? '').slice(0, 200_000))
    const missing = []
    for (const e of list) {
      const key = normalizeEntity(e)
      if (!key) continue
      if (!hay.includes(key)) missing.push(String(e))
    }
    return { missing, total, ratio: missing.length / total }
  } catch { return { missing: [], total: 0, ratio: 0 } }
}

export function extractConstraints(text) {
  try {
    const raw = String(text ?? '').slice(0, 200_000)
    if (!raw) return []
    const out = []
    const seen = new Set()
    for (const s of raw.split(SENTENCE_SPLIT)) {
      const t = s.trim()
      if (t.length < 4 || t.length > 120) continue
      if (!CONSTRAINT_MARKERS.test(t)) continue
      const k = normalizeEntity(t)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(t)
      if (out.length >= 12) break
    }
    return out
  } catch { return [] }
}

// 抽 (key, value) 事实对：用于矛盾检测。key 为"被讨论的属性"，value 为其取值。
const FACT_RULES = [
  { key: 'model', re: /(?:模型|model)[^\w]{0,4}([a-z][a-z0-9]*(?:-[a-z0-9.]+){1,3})/i },
  { key: 'port', re: /(?:端口|port)[^\d]{0,4}(\d{2,5})/i },
  { key: 'threshold', re: /(?:阈值|上限|下限|水位|比例)[^\d]{0,6}(\d+(?:\.\d+)?%?)/i },
  { key: 'version', re: /(?:版本|version|v)[^\d]{0,3}(\d+(?:\.\d+){1,3})/i },
  { key: 'window', re: /(?:窗口|window|context)[^\d]{0,6}(\d+(?:\.\d+)?\s*(?:k|K|KB|MB|万)?)/ },
]

export function extractFacts(text) {
  try {
    const raw = String(text ?? '').slice(0, 200_000)
    if (!raw) return []
    const out = []
    for (const s of raw.split(SENTENCE_SPLIT)) {
      const t = s.trim()
      if (!t || t.length > 300) continue
      for (const rule of FACT_RULES) {
        const m = rule.re.exec(t)
        if (!m) continue
        out.push({ key: rule.key, value: normalizeEntity(m[1]), sentence: t })
      }
    }
    return out
  } catch { return [] }
}

// 矛盾 = 同 key 互斥取值，且**都不是显式演进**（"已改为 0.5" 是合法更新，不是矛盾）
export function detectContradictions(factsByTurn) {
  try {
    const turns = Array.isArray(factsByTurn) ? factsByTurn : []
    const byKey = new Map()
    turns.forEach((facts, i) => {
      for (const f of Array.isArray(facts) ? facts : []) {
        if (!f || !f.key || !f.value) continue
        if (EVOLVE_MARKERS.test(String(f.sentence || ''))) continue
        if (!byKey.has(f.key)) byKey.set(f.key, [])
        byKey.get(f.key).push({ value: f.value, turn: i })
      }
    })
    const out = []
    for (const [key, list] of byKey) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].value === list[j].value) continue
          if (list[i].turn === list[j].turn) continue // 同轮内不同表述不算（多为列举/否定）
          out.push({ key, a: list[i].value, b: list[j].value, turnA: list[i].turn, turnB: list[j].turn })
        }
      }
    }
    return out.slice(0, 20)
  } catch { return [] }
}

export function detectUserCorrection(userText) {
  try {
    const t = String(userText ?? '')
    if (!t) return { corrected: false, phrases: [] }
    const phrases = CORRECTION_PATTERNS.filter((re) => re.test(t)).map((re) => String(re))
    return { corrected: phrases.length > 0, phrases }
  } catch { return { corrected: false, phrases: [] } }
}

export function detectRequirementChange(userText) {
  try {
    const t = String(userText ?? '')
    if (!t) return false
    return REQUIREMENT_CHANGE_PATTERNS.some((re) => re.test(t))
  } catch { return false }
}

export function taskCoverage(anchorEntities, texts) {
  try {
    const anchors = Array.isArray(anchorEntities) ? anchorEntities.filter(Boolean) : []
    if (!anchors.length) return 1
    const hay = normalizeEntity((Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '')).join('\n'))
    if (!hay) return 0
    let hit = 0
    for (const a of anchors) {
      const k = normalizeEntity(a)
      if (!k) continue
      if (hay.includes(k)) { hit++; continue }
      // 中文长词放宽到前缀 2 字命中（"删除交互" ⊂ "删除交互已完成，新增确认框" 本应命中；
      // 但"画布的删除交互"被功能字拆开后仍可能差一个字，放宽可避免目标漂移误报）
      if (/^[\u4e00-\u9fa5]/.test(k) && k.length >= 3 && hay.includes(k.slice(0, 2))) hit++
    }
    return hit / anchors.length
  } catch { return 1 }
}

const ANCHOR_HEAD = '【上下文锚定 · 权威事实】'
const ANCHOR_TAIL = '若上述事实与你记忆中的内容冲突，以上述为准；请先复述关键事实确认，再继续任务。'

export function buildAnchorText({ task, memoryText, missing, constraints, maxBytes = 4096 } = {}) {
  try {
    const segs = []
    if (task) segs.push(`■ 原始任务\n${String(task).trim()}`)
    const miss = Array.isArray(missing) ? missing.filter(Boolean).slice(0, 30) : []
    if (miss.length) segs.push(`■ 此前摘要遗漏、现已补回的关键事实\n${miss.map((m) => `- ${String(m).trim()}`).join('\n')}`)
    if (memoryText) segs.push(`■ 会话记忆（任务清单 / 文件变更 / 最近决策）\n${String(memoryText).trim()}`)
    const cons = Array.isArray(constraints) ? constraints.filter(Boolean).slice(0, 12) : []
    if (cons.length) segs.push(`■ 硬约束\n${cons.map((c) => `- ${String(c).trim()}`).join('\n')}`)
    if (!segs.length) return ''
    const head = `${ANCHOR_HEAD}\n`
    const tail = `\n${ANCHOR_TAIL}\n`
    const budget = Math.max(0, Math.floor(Number(maxBytes) || 4096) - Buffer.byteLength(head, 'utf-8') - Buffer.byteLength(tail, 'utf-8'))
    let used = 0
    const kept = []
    for (const seg of segs) {
      const b = Buffer.byteLength(seg, 'utf-8') + 2
      if (used + b <= budget) { kept.push(seg); used += b; continue }
      const left = budget - used - 2
      if (left > 40) { kept.push(cutUtf8(seg, left)); used = budget }
      break
    }
    const out = `${head}${kept.join('\n\n')}${tail}`
    return Buffer.byteLength(out, 'utf-8') <= Number(maxBytes) ? out : cutUtf8(out, Number(maxBytes))
  } catch { return '' }
}

function cutUtf8(s, maxBytes) {
  const str = String(s ?? '')
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str
  let lo = 0
  let hi = str.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(str.slice(0, mid), 'utf-8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return str.slice(0, lo)
}

// ---------------------------------------------------------------------------
// 聚合器：证据 → 档位
// ---------------------------------------------------------------------------

export function createFidelity({ config, getAnchorSource, now } = {}) {
  const cfg = { ...DEFAULT_FIDELITY_CONFIG, ...(config || {}) }
  const clock = typeof now === 'function' ? now : () => new Date()

  let turn = 0
  const issues = new Map()        // id → issue（含 resolved/hits/recurred）
  let factsByTurn = []
  let task = ''
  let anchorEntities = []
  let compressedTurnCeiling = 0   // 最近一次压缩发生时的轮次（0 = 尚未压缩）
  let lastAuditMissing = []
  let lastAuditEntities = []
  let observeUntilTurn = null
  let goalMissStreak = 0
  const toolErrorTurns = new Map() // 归一化路径 → 出现报错的轮次集合（陈旧引用的真值）

  const enabled = () => cfg.enabled !== false

  function push(issue) {
    const id = String(issue.id)
    const prev = issues.get(id)
    if (prev) {
      prev.hits = (prev.hits || 1) + 1
      prev.at = issue.at || prev.at
      // 升级单调：medium 可升 strong（工具记录第 2 次报同路径不存在 = 确凿），但 never 降级。
      // 刻意不刷新 turn：保持"首次出现"的轮龄，半衰期才不会被反复续命（去抖不刷分）。
      if (issue.strength === 'strong' && prev.strength !== 'strong') {
        prev.strength = 'strong'
        prev.escalated = true
        prev.evidence = issue.evidence
        prev.detail = issue.detail
      }
      if (prev.resolved) {           // 复发：复活 + 打标记（前端据此升级动作为"新建会话"）
        prev.resolved = false
        prev.recurred = true
        prev.strength = issue.strength
        prev.turn = issue.turn
        prev.evidence = issue.evidence
        prev.detail = issue.detail
        observeUntilTurn = null
      }
      return prev
    }
    const it = { hits: 1, ...issue, id }
    if (issues.size < cfg.maxIssues) issues.set(id, it)
    return it
  }

  function mkIssue({ id, axis, kind, strength, turn: t, evidence, detail }) {
    return {
      id, axis, kind, strength, turn: t,
      evidence: String(evidence || '').slice(0, 120),
      detail: detail || undefined, at: clock().toISOString(),
    }
  }

  function applyAnchor(text) {
    task = cleanTaskText(String(text)).trim().slice(0, 1000)
    anchorEntities = extractEntities(task, { max: 24 })
    goalMissStreak = 0
    for (const [id, it] of issues) if (it.axis === 'goal' && !it.resolved) issues.delete(id)
  }

  function recordTurn(input = {}) {
    try {
      if (!enabled()) return []
      turn += 1
      const user = String(input.user ?? '').slice(0, cfg.maxText)
      const assistant = String(input.assistant ?? '').slice(0, cfg.maxText)
      const digest = Array.isArray(input.toolDigest) ? input.toolDigest : []

      // 锚点：首条真实 user 任务；用户显式改需求 = 合法转向（锚点跟随用户，清目标轴证据）
      if (user.trim()) {
        if (!task) applyAnchor(user)
        else if (detectRequirementChange(user)) applyAnchor(user)
      }

      const produced = []

      // S1 强证据：用户纠错 + 指向"已被压缩遮蔽"的区间
      const corr = detectUserCorrection(user)
      if (corr.corrected && user.trim()) {
        const hitEntities = extractEntities(user, { max: 12, kinds: 'key' })
        // 有审计实体记录时要求命中（保守）；无记录（压缩成立但未留实体）时不苛求
        const refersToAudited = !lastAuditEntities.length || hitEntities.length === 0 ||
          hitEntities.some((e) => lastAuditEntities.concat(lastAuditMissing, anchorEntities)
            .some((a) => normalizeEntity(a) === normalizeEntity(e)))
        if (compressedTurnCeiling > 0 && refersToAudited) {
          const targets = hitEntities.length ? hitEntities.slice(0, 2) : ['__general__']
          for (const e of targets) {
            const label = e === '__general__' ? '已压缩区间的结论' : e
            produced.push(push(mkIssue({
              id: `u:correction:${normalizeEntity(e)}`, axis: 'coherence', kind: 'user-correction',
              strength: 'strong', turn,
              evidence: `第 ${turn} 轮用户指出此前说法有误（涉及 ${label}）`,
              detail: { phrase: corr.phrases[0], entity: e === '__general__' ? null : e },
            })))
          }
        }
      }

      // 陈旧引用：真值取自工具记录（零成本、最可信）。第 1 次 medium，跨轮第 2 次升 strong
      for (const d of digest) {
        const p = String(d?.path || '')
        const name = String(d?.name || '')
        if (!p || !d?.isError) continue
        const key = normalizeEntity(p)
        if (!toolErrorTurns.has(key)) toolErrorTurns.set(key, new Set())
        toolErrorTurns.get(key).add(turn)
        const base = p.split(/[\\/]/).filter(Boolean).pop() || p
        const quotedNow = new RegExp(escapeRe(base), 'i').test(assistant + '\n' + user)
        if (!quotedNow) continue
        const strength = toolErrorTurns.get(key).size >= 2 ? 'strong' : 'medium'
        produced.push(push(mkIssue({
          id: `c:stale:${key}`, axis: 'coherence', kind: 'stale-reference', strength, turn,
          evidence: `第 ${turn} 轮仍在引用工具已报不存在的 ${p}（${name || '工具'}）`,
          detail: { path: p, tool: name, error: String(d?.errorText || '').slice(0, 200) },
        })))
      }

      // 内部矛盾（同 key 互斥取值，排除显式演进）
      const facts = extractFacts(user + '\n' + assistant)
      factsByTurn.push(facts)
      if (factsByTurn.length > cfg.windowTurns * 2) factsByTurn.shift()
      for (const c of detectContradictions(factsByTurn.slice(-cfg.windowTurns)).slice(0, 3)) {
        produced.push(push(mkIssue({
          id: `c:contradiction:${normalizeEntity(c.key)}`, axis: 'coherence', kind: 'contradiction',
          strength: 'medium', turn,
          evidence: `同一项「${c.key}」出现两种取值：${c.a} 与 ${c.b}`,
          detail: { key: c.key, a: c.a, b: c.b, turnA: c.turnA, turnB: c.turnB },
        })))
      }

      // 目标覆盖连续偏低（锚点实体足够时才启用：太短的锚点做覆盖率没有意义）
      const goalTrackable = anchorEntities.length >= cfg.goalMinEntities && task.length >= 6
      if (goalTrackable) {
        const cov = taskCoverage(anchorEntities, [user, assistant])
        if (cov < cfg.goalCoverageMin) {
          goalMissStreak += 1
          if (goalMissStreak >= cfg.goalWindow) {
            produced.push(push(mkIssue({
              id: 'g:coverage', axis: 'goal', kind: 'goal-drift', strength: 'medium', turn,
              evidence: `已连续 ${goalMissStreak} 轮与最初任务（${task.slice(0, 40)}…）无明显关联`,
              detail: { coverage: cov, streak: goalMissStreak },
            })))
          }
        } else {
          goalMissStreak = 0
        }
      } else {
        goalMissStreak = 0
      }

      // 压缩点 LLM 保真审计结论（模型自评：最高只到 medium）
      const llm = input.llmAudit
      if (llm && typeof llm === 'object') {
        produced.push(...applyLlmAudit(llm))
      }
      return produced
    } catch { return [] }
  }

  function applyLlmAudit(llm) {
    const out = []
    const rw = Array.isArray(llm.rewritten) ? llm.rewritten.filter(Boolean) : []
    const lm = Array.isArray(llm.missing) ? llm.missing.filter(Boolean) : []
    rw.slice(0, 2).forEach((r, i) => {
      out.push(push(mkIssue({
        id: `m:rewritten:${i}:${normalizeEntity(r)}`, axis: 'memory', kind: 'summary-rewritten',
        strength: 'medium', turn: turn,
        evidence: `摘要疑似改写事实：${r}`,
        detail: { rewritten: rw.slice(0, 5) },
      })))
    })
    lm.slice(0, 1).forEach((m) => {
      out.push(push(mkIssue({
        id: `m:llm-missing:${normalizeEntity(m)}`, axis: 'memory', kind: 'summary-missing-entity',
        strength: 'medium', turn: turn,
        evidence: `保真审计发现摘要可能遗漏：${m}`,
        detail: { entity: m, source: 'llm' },
      })))
    })
    return out
  }

  function recordCompactionAudit(audit = {}) {
    try {
      if (!enabled()) return []
      const entities = Array.isArray(audit.entities) ? audit.entities.filter(Boolean) : []
      const missing = Array.isArray(audit.missing) ? audit.missing.filter(Boolean) : []
      const ratio = Number.isFinite(Number(audit.ratio))
        ? Number(audit.ratio)
        : (entities.length ? missing.length / entities.length : 0)
      compressedTurnCeiling = turn || 1 // 压缩影响到的轮次上界
      if (missing.length) lastAuditMissing = missing.slice(0, 30)
      if (entities.length) lastAuditEntities = entities.slice(0, 60)

      const out = []
      const enough = entities.length >= cfg.minEntities
      if (enough && missing.length && ratio >= cfg.summaryMissingStrong) {
        // S2 强证据：关键实体成片丢失
        for (const m of missing.slice(0, 3)) {
          out.push(push(mkIssue({
            id: `m:summary:${normalizeEntity(m)}`, axis: 'memory', kind: 'summary-missing-entity',
            strength: 'strong', turn,
            evidence: `压缩摘要丢失关键事实 ${m}（关键实体缺失率 ${Math.round(ratio * 100)}%）`,
            detail: { entity: m, ratio, total: entities.length },
          })))
        }
      } else if (enough && missing.length && ratio >= cfg.summaryMissingMedium) {
        for (const m of missing.slice(0, 2)) {
          out.push(push(mkIssue({
            id: `m:summary:${normalizeEntity(m)}`, axis: 'memory', kind: 'summary-missing-entity',
            strength: 'medium', turn,
            evidence: `压缩摘要可能遗漏 ${m}（关键实体缺失率 ${Math.round(ratio * 100)}%）`,
            detail: { entity: m, ratio, total: entities.length },
          })))
        }
      }

      const llm = audit.llm
      if (llm && typeof llm === 'object') {
        const extra = (Array.isArray(llm.missing) ? llm.missing.filter(Boolean) : [])
          .filter((m) => !missing.some((x) => normalizeEntity(x) === normalizeEntity(m)))
        out.push(...applyLlmAudit({ ...llm, missing: extra }))
      }
      return out
    } catch { return [] }
  }

  function buildAnchor() {
    // 锚点源（会话工作记忆/首条任务）读取失败时必须回退到内部已知事实，
    // 而不是整体返回空串——空锚点等于"重新锚定"按钮点了没反应。
    let src = {}
    try { src = (typeof getAnchorSource === 'function' ? getAnchorSource() : null) || {} } catch { src = {} }
    try {
      return buildAnchorText({
        task: src.task || task,
        memoryText: src.memoryText || '',
        missing: lastAuditMissing,
        constraints: (Array.isArray(src.constraints) && src.constraints.length)
          ? src.constraints
          : extractConstraints(String(src.task || task || '')),
      })
    } catch { return '' }
  }

  function copyIssue(it) {
    return {
      id: it.id, axis: it.axis, kind: it.kind, strength: it.strength, turn: it.turn,
      evidence: it.evidence, detail: it.detail, at: it.at,
      ...(it.recurred ? { recurred: true } : {}),
    }
  }

  function snapshot() {
    try {
      if (!enabled()) return { ...GREEN, axes: { ...GREEN.axes } }
      const floor = turn - cfg.windowTurns
      const active = []
      const axes = { memory: 0, coherence: 0, goal: 0 }
      const hasStrongByAxis = { memory: false, coherence: false, goal: false }
      for (const it of issues.values()) {
        if (it.resolved) continue
        if (it.turn <= floor) continue // 窗口外：半衰期到期，退出计分
        const w = it.strength === 'strong' ? STRONG_WEIGHT : MEDIUM_WEIGHT
        axes[it.axis] = (axes[it.axis] || 0) + w * Math.pow(cfg.decay, Math.max(0, turn - it.turn))
        if (it.strength === 'strong') hasStrongByAxis[it.axis] = true
        active.push(it)
      }
      // 每轴独立归一，score 取三轴最大（不跨轴求和：避免把不同性质的证据互相稀释）
      const norm = { memory: 0, coherence: 0, goal: 0 }
      for (const ax of ['memory', 'coherence', 'goal']) {
        const sum = axes[ax] || 0
        if (!sum) continue
        const medScore = Math.round((sum / MEDIUM_WEIGHT) * MEDIUM_PER_POINT)
        norm[ax] = hasStrongByAxis[ax] ? 100 : Math.min(MEDIUM_ONLY_CAP, medScore)
      }
      const score = Math.max(norm.memory, norm.coherence, norm.goal)
      const hasStrong = active.some((i) => i.strength === 'strong')
      const mediumCount = active.filter((i) => i.strength !== 'strong').length
      let tier = 'green'
      if (hasStrong) tier = 'red'
      else if (score >= cfg.amber || mediumCount >= MEDIUM_FOR_AMBER) tier = 'amber'

      active.sort((a, b) => (a.strength === b.strength ? b.turn - a.turn : a.strength === 'strong' ? -1 : 1))
      const strongest = active.find((i) => i.strength === 'strong') || active[0] || null
      const snap = {
        score,
        tier,
        axes: norm,
        issues: active.slice(0, 10).map(copyIssue),
        trigger: tier === 'red' && strongest ? strongest.id : null,
        observeUntilTurn: observeUntilTurn ?? null,
        anchorAvailable: tier === 'red',
      }
      if (snap.anchorAvailable) snap.anchorText = buildAnchor()
      return snap
    } catch { return { ...GREEN, axes: { ...GREEN.axes } } }
  }

  function markResolved(ids) {
    try {
      const list = Array.isArray(ids) ? ids : []
      let n = 0
      for (const id of list) {
        const it = issues.get(String(id))
        if (it && !it.resolved) { it.resolved = true; n += 1 }
      }
      if (n > 0) observeUntilTurn = turn + cfg.observeTurns
      return n
    } catch { return 0 }
  }

  function evidenceLog() {
    try {
      const active = []
      const resolved = []
      for (const it of issues.values()) (it.resolved ? resolved : active).push(copyIssue(it))
      return { active, resolved }
    } catch { return { active: [], resolved: [] } }
  }

  function reset() {
    turn = 0
    issues.clear()
    factsByTurn = []
    task = ''
    anchorEntities = []
    compressedTurnCeiling = 0
    lastAuditMissing = []
    lastAuditEntities = []
    observeUntilTurn = null
    goalMissStreak = 0
    toolErrorTurns.clear()
  }

  return { recordTurn, recordCompactionAudit, markResolved, snapshot, evidenceLog, reset, getTurn: () => turn }
}

// 正则转义：刻意不用含反斜杠字面量的实现——编辑工具对替换文本做 sed 式展开
// （美元符加与号 = 匹配文本），曾因此损坏本文件。此处全用字符码构造，安全无歧义。
const BACKSLASH = String.fromCharCode(92)
const DOLLAR = String.fromCharCode(36)
const RE_SPECIALS = ['.', '*', '+', '?', '^', DOLLAR, '{', '}', '(', ')', '[', ']', '|', BACKSLASH]
function escapeRe(s) {
  return String(s).split('').map((c) => (RE_SPECIALS.indexOf(c) >= 0 ? BACKSLASH + c : c)).join('')
}

// 改需求时的锚点清洗：去掉转向措辞，只留新任务本身
// （否则锚点实体是"先放一放/改做XXX"，后续正常干活反而会被判成目标漂移）
function cleanTaskText(text) {
  const t = String(text ?? '')
  if (!t) return ''
  const m = /(?:先放一放[，,]?\s*)?(?:改做|改成|换个任务|换一个|改一下需求|需求变更[是为]?)\s*([\s\S]+)/.exec(t)
  return (m && m[1] ? m[1] : t).replace(/^[，,：:\s]+/, '')
}

