// kernel/loop-commands.mjs —— /loop 指令解析（纯函数，零依赖零 IO）
// ---------------------------------------------------------------------------
// 语法（cli/tui/bridge/GUI 四端统一）：
//   /loop [次数] [--until <目标>] [--every <间隔>] [--fresh]
//         [--max-cost <USD>] [--max-steps <N>] [--max-wall <时长>]
//         [--done <命令>]... [--goal <目标>] [prompt...]
// 指令族：/loop <op> [args...]（LOOP_OPS）。
// GUI 旧语法兼容：首个 token 形如 10m/30s/1h/1d → 识别为间隔（--every 语义），
// 而非次数（当前 GUI ScheduleGuide 发 `/loop 10m <任务>`，旧内核按 Number() 变 NaN
// 静默吞掉，是本轮修复点之一）。
export const LOOP_OPS = ['start', 'status', 'pause', 'resume', 'stop', 'budget', 'approve', 'inject', 'rollback', 'replay', 'memory']

const DURATION_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** '10m'/'30s'/'2h'/'1d' → ms；非法返回 null */
export function parseDuration(s) {
  const m = String(s ?? '').trim().match(/^(\d+(?:\.\d+)?)([smhd])$/)
  if (!m) return null
  return Math.round(Number(m[1]) * DURATION_UNITS[m[2]])
}

/** token 是否为纯整数（次数位） */
const isCount = (t) => /^\d+$/.test(String(t ?? ''))

// 取下一个 token 的值；flags 形式（--key=value）在调用处先归一为 ['--key','value']
function tokenize(text) {
  // 支持双引号包裹的取值：--done "pytest tests/test_login.py"
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * 解析 /loop 文本。
 * @returns null | { kind:'start', opts } | { kind:'op', op, args }
 * null ⇒ 非 /loop 或不可解析（调用方按普通消息处理，绝不吞用户输入）
 */
export function parseLoopDirective(text) {
  const raw = String(text ?? '').trim()
  const m = raw.match(/^\/loop(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const body = (m[1] || '').trim()
  if (!body) return null
  const tokens = tokenize(body)
  // 指令族：首 token 为 op 关键字
  if (LOOP_OPS.includes(tokens[0])) {
    return { kind: 'op', op: tokens[0], args: tokens.slice(1) }
  }

  const opts = {
    count: null, until: '', everyMs: 0, fresh: false,
    maxCostUsd: 0, maxSteps: 0, maxWallMs: 0,
    doneWhen: [], goal: '', prompt: '',
  }
  let i = 0
  // 首个 token：次数 | 时长（GUI 旧语法）| flag | prompt
  if (tokens.length && isCount(tokens[0])) {
    opts.count = parseInt(tokens[0], 10)
    i = 1
  } else if (tokens.length && parseDuration(tokens[0]) !== null) {
    opts.everyMs = parseDuration(tokens[0])
    opts.count = null // 间隔式 = 持续运行（靠 stop/until/预算终止）
    i = 1
  }
  const kv = {
    '--until': (v) => { opts.until = v },
    '--every': (v) => { opts.everyMs = parseDuration(v) ?? 0 },
    '--goal': (v) => { opts.goal = v },
    '--max-cost': (v) => { opts.maxCostUsd = Number(v) || 0 },
    '--max-steps': (v) => { opts.maxSteps = Number(v) || 0 },
    '--max-wall': (v) => { opts.maxWallMs = parseDuration(v) ?? 0 },
    '--done': (v) => { opts.doneWhen.push({ type: 'cmd', run: v }) },
  }
  const promptParts = []
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--fresh') { opts.fresh = true; continue }
    const eq = t.indexOf('=')
    if (t.startsWith('--') && eq > 2) {
      const key = t.slice(0, eq)
      if (kv[key]) { kv[key](t.slice(eq + 1)); continue }
    }
    if (kv[t]) {
      const v = tokens[++i]
      if (v === undefined) break // 缺值：忽略该 flag（容错，不抛）
      kv[t](v)
      continue
    }
    promptParts.push(t)
  }
  opts.prompt = promptParts.join(' ').trim()
  // count 缺省：显式给了间隔 → 持续运行；否则沿用现状默认 3
  if (opts.count === null && opts.everyMs === 0) opts.count = 3
  return { kind: 'start', opts }
}

const fmtUsd = (n) => (Number(n) || 0).toFixed(4)

export function formatLoopStatus(state = {}) {
  const st = state
  const lines = [
    `【loop 状态】${st.status || 'idle'}${st.endReason ? `（${st.endReason}）` : ''}`,
    `目标：${st.goal || st.prompt || '(未设定)'}`,
    `轮次：${st.index ?? 0}/${st.count ?? '∞'}    步数：${st.steps ?? 0}    成本：${fmtUsd(st.costUsd)}${st.budget?.maxCostUsd ? ` / ${st.budget.maxCostUsd}` : ''}`,
    `无进展连续：${st.noProgress?.streak ?? 0}/${st.noProgress?.threshold ?? 3}`,
    `验证条件：${(st.doneWhen || []).map((d) => d.run || d.text).join(' && ') || '(无，走 --until/--goal 判定)'}`,
  ]
  const last = (st.history || []).slice(-1)[0]
  if (last) {
    const v = last.verify ? `验证 ${last.verify.passed ? '通过' : '未通过'}` : (last.judged ? '判定达成' : '未判定')
    lines.push(`最近一轮：#${last.index} ${v}，变更 ${last.filesChanged ?? 0} 个文件，成本 ${fmtUsd(last.costUsd)}`)
  }
  if (st.pendingApproval) lines.push(`待批准：${st.pendingApproval.kind}（/loop approve 继续）`)
  return lines.join('\n')
}

export function formatLoopReplay(history = [], lastN = 10) {
  const rows = history.slice(-Math.max(1, Number(lastN) || 10))
  if (!rows.length) return '【loop 回放】暂无轮次记录'
  const lines = [`【loop 回放】最近 ${rows.length} 轮：`]
  for (const h of rows) {
    const v = h.verify ? (h.verify.passed ? '验证通过' : '验证未通过') : (h.judged ? '判定达成' : '—')
    lines.push(`- #${h.index} ${String(h.ts || '').slice(11, 19)} 成本 ${Number(h.costUsd || 0).toFixed(2)} 步数 ${h.steps ?? 0} 变更 ${h.filesChanged ?? 0} 文件 ${v}${h.note ? ` ${h.note}` : ''}`)
  }
  return lines.join('\n')
}
