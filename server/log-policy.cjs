'use strict'
// log-policy.cjs — 运行日志本地持久化策略（单一真源，2026-09-12）
// ---------------------------------------------------------------------------
// 背景：`<home>/logs/app.log` 曾无上限增长（实测 76MB），轮转函数 `rotateIfNeeded`
// 是死代码（main.cjs 从不调用），四处手写截断（log-tee / bridge / diag-monitor /
// main.cjs renderer-console）互相不一致，且**没有任何按时间清理**。本模块把
// "写不写 / 写到多大 / 留几份 / 留几天 / 什么等级" 收敛成一处，供主进程（CJS）、
// 桥（ESM）、诊断模块共用。
//
// CJS 模块：可被 ESM（bridge.mjs `import`）与 CommonJS（electron/main.cjs `require`）
// 双用——先例 server/yfw-home.cjs。**不得 require 任何 electron 模块**（桥不带 electron）。
//
// 设计要点：
//   · 全部函数**永不抛**：日志设施自身出错绝不能影响主流程（返回 false/0/默认值）。
//   · `persist:false` = 只停止写入，**绝不删除已有日志**（用户可能正要拿去排障）。
//   · 保留 appendFileSync 的"每行 open/close"语义（log-tee.cjs 头注释已说明：无常驻
//     句柄 → Windows 上 rename 不撞 EBUSY），每次 rename/unlink 各自 try/catch。
//   · 两个进程（主进程/桥）可能同时写同一文件：轮转是 best-effort，冲突时静默让路。
const fs = require('fs')
const path = require('path')
const { resolveYfwHome } = require('./yfw-home.cjs')

const KB = 1024
const MB = 1024 * 1024

// 默认：单文件 5MB / 留 3 份 / 超 14 天删除 / 仅 >info 才过滤（info 保留全部常规行）。
// 上限总占用 ≈ 3 类日志 × 5MB × (1+3) ≈ 60MB，且有界。
const DEFAULT_LOG_POLICY = Object.freeze({
  persist: true,
  level: 'info',
  maxFileBytes: 5 * MB,
  maxFiles: 3,
  maxAgeDays: 14,
})

// 钳制区间（GUI 与本模块共用同一组数字，避免两处各写一套）
const LOG_POLICY_LIMITS = Object.freeze({
  minFileBytes: 64 * KB, maxFileBytes: 100 * MB,
  minFiles: 0, maxFiles: 20,
  minAgeDays: 1, maxAgeDays: 365,
})

const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error'])
// 允许被 /logs/* 端点与查看器读写的基名（白名单，防路径穿越/读到 config.json）
const LOG_BASE_NAMES = Object.freeze(['app.log', 'kernel-stderr.log', 'renderer-console.log'])
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 }
// 存量超大文件的裁剪目标倍数：直接轮转只会得到一个活满 maxAgeDays 的巨型 .1，
// 磁盘不降反升；裁到 cap×4 既保留可追溯的近期上下文，又让单个历史文件有界。
const TRIM_KEEP_FACTOR = 4
// 尾部读取上限（查看器"最近 N 行"）：一次最多读 1MB，绝不把 76MB 全读进内存
const MAX_TAIL_BYTES = 1 * MB

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

// 任意输入 → 合法策略（非法/缺失一律回落默认档，永不抛）
function normalizeLogPolicy(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const lv = String(r.level ?? '').trim().toLowerCase()
  return {
    // 只有**显式 false** 才关闭：字段缺失/拼错/字符串 'false' 一律保持开启。
    // 关掉本地持久化 = 崩溃后无原文可查，必须由用户明确表达，不能被脏数据误触发。
    persist: r.persist !== false,
    level: LOG_LEVELS.includes(lv) ? lv : DEFAULT_LOG_POLICY.level,
    maxFileBytes: clampInt(r.maxFileBytes, LOG_POLICY_LIMITS.minFileBytes, LOG_POLICY_LIMITS.maxFileBytes, DEFAULT_LOG_POLICY.maxFileBytes),
    maxFiles: clampInt(r.maxFiles, LOG_POLICY_LIMITS.minFiles, LOG_POLICY_LIMITS.maxFiles, DEFAULT_LOG_POLICY.maxFiles),
    maxAgeDays: clampInt(r.maxAgeDays, LOG_POLICY_LIMITS.minAgeDays, LOG_POLICY_LIMITS.maxAgeDays, DEFAULT_LOG_POLICY.maxAgeDays),
  }
}

function logDirFor(home) {
  return path.join(home || resolveYfwHome(), 'logs')
}
function logConfigPath(home) {
  return path.join(home || resolveYfwHome(), 'config.json')
}

// 读 config.json 的 logPolicy（缺失/损坏 → 默认；永不抛，也绝不创建文件）
function readLogPolicy({ home = resolveYfwHome() } = {}) {
  try {
    const cfg = JSON.parse(fs.readFileSync(logConfigPath(home), 'utf-8'))
    return normalizeLogPolicy(cfg && cfg.logPolicy)
  } catch (_) {
    return normalizeLogPolicy(null)
  }
}

// 带 TTL 的缓存：桥与主进程是**两个进程**，改策略后没法互相通知——靠 TTL（默认 5s）
// 让新值在不重启的前提下生效，同时避免每行日志都去读一遍 config.json。
const _policyCache = new Map() // home -> { at, policy }
function readLogPolicyCached({ home = resolveYfwHome(), ttlMs = 5000 } = {}) {
  const now = Date.now()
  const hit = _policyCache.get(home)
  if (hit && now - hit.at < ttlMs) return hit.policy
  const policy = readLogPolicy({ home })
  _policyCache.set(home, { at: now, policy })
  return policy
}
function _resetLogPolicyCache() { _policyCache.clear() }

// 尾部读取（fd 定位，不整读大文件）
function readTailBytes(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    return buf.toString('utf-8')
  } finally {
    try { fs.closeSync(fd) } catch (_) { /* ignore */ }
  }
}

// 轮转：`.N` 让位 → 依次后移 → 主文件变 `.1`（与既有 5MB 轮转行为一致）
// maxFiles=0：不留任何历史 → 清空主文件（保留文件本身，tail 读取不会 ENOENT）
function rotateLog(logPath, policy) {
  const p = normalizeLogPolicy(policy)
  try {
    if (!fs.existsSync(logPath)) return false
    if (p.maxFiles <= 0) { fs.writeFileSync(logPath, ''); return true }
    const dir = path.dirname(logPath)
    const base = path.basename(logPath)
    try { fs.unlinkSync(path.join(dir, `${base}.${p.maxFiles}`)) } catch (_) { /* 不存在即跳过 */ }
    for (let k = p.maxFiles - 1; k >= 1; k--) {
      try { fs.renameSync(path.join(dir, `${base}.${k}`), path.join(dir, `${base}.${k + 1}`)) } catch (_) { /* 缺号跳过 */ }
    }
    fs.renameSync(logPath, path.join(dir, `${base}.1`))
    return true
  } catch (_) {
    return false
  }
}

// 按年龄清理轮转份（照 bridge.mjs pruneStampedBackups 的 readdir+前缀+mtime 惯用法）
function pruneByAge(logPath, policy, now = Date.now()) {
  const p = normalizeLogPolicy(policy)
  const cutoff = now - p.maxAgeDays * 86400_000
  const dir = path.dirname(logPath)
  const base = path.basename(logPath)
  let removed = 0
  let names = []
  try { names = fs.readdirSync(dir) } catch (_) { return 0 }
  for (const name of names) {
    const m = /^(.+)\.(\d{1,2})$/.exec(name)
    if (!m || m[1] !== base) continue
    try {
      if (fs.statSync(path.join(dir, name)).mtimeMs < cutoff) { fs.unlinkSync(path.join(dir, name)); removed++ }
    } catch (_) { /* 并发写/删除：忽略 */ }
  }
  return removed
}

// 写一行（核心入口）：persist:false → 空操作；超过上限 → 先轮转再追加
function writeLogLine(logPath, line, policy, level = 'info') {
  const p = normalizeLogPolicy(policy)
  if (!p.persist) return false
  const lv = LEVEL_RANK[String(level)] ?? LEVEL_RANK.info
  if (lv < LEVEL_RANK[p.level]) return false
  try {
    const text = String(line)
    const incoming = Buffer.byteLength(text, 'utf-8') + 1
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    let size = 0
    try { size = fs.statSync(logPath).size } catch (_) { /* 尚不存在 */ }
    if (size > 0 && size + incoming > p.maxFileBytes) rotateLog(logPath, p)
    fs.appendFileSync(logPath, text + '\n')
    return true
  } catch (_) {
    return false
  }
}

// 批量写：语义与逐行 writeLogLine 完全等价（每行一个 '\n'），但只 stat/append **一次**。
// 与 writeLogLine 共用轮转与等级门槛 ⇒ 缓冲不引入第二条写路径（R1，2026-09-13）。
function writeLogLines(logPath, lines, policy, level = 'info') {
  if (!Array.isArray(lines) || !lines.length) return 0
  const p = normalizeLogPolicy(policy)
  if (!p.persist) return 0
  const lv = LEVEL_RANK[String(level)] ?? LEVEL_RANK.info
  if (lv < LEVEL_RANK[p.level]) return 0
  try {
    const text = lines.map((l) => String(l).replace(/\n+$/, '')).join('\n') + '\n'
    const incoming = Buffer.byteLength(text, 'utf-8')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    let size = 0
    try { size = fs.statSync(logPath).size } catch (_) { /* 尚不存在 */ }
    if (size > 0 && size + incoming > p.maxFileBytes) rotateLog(logPath, p)
    fs.appendFileSync(logPath, text)
    return lines.length
  } catch (_) {
    return 0
  }
}

// —— R1（2026-09-13）渲染器高频行闸门 + 缓冲写 ——
// 病根：渲染层 `[WS] recv:` 每个下行帧一行 → 主进程 console-message → **两次**
// statSync+appendFileSync（app.log 经 log-tee 一份 + renderer-console.log 一份）。
// 实测 22 小时写掉 17MB，全是这一行。
// 判据是「按**帧级**特征采样 + 异常全量」而不是整类丢弃：流式排障要的是**帧的分布**
// （有没有在流、什么类型），不是每一帧的逐字复本；被采样掉多少行会记在下一个放行行
// 上（`(+N 条同类被采样)`），所以"什么都没记"这种最坏情况不会出现。
//
// 判据为什么长这样（2026-09-13 用**真实日志回放**定，不是拍脑袋）：
//   · 唯一发射点 `src/hooks/useYFWCLI.ts:174` = `[WS] recv: <msg.type> <sid> <data.type>`；
//   · 全量 4 个日志文件里 `event` 129,694 行（98.5%），其中 `assistant` 127,833 行（98.6%）
//     ——**逐帧正文复本**，就是全部噪声；到达间隔 p50=76ms、p10=22ms（峰值 45 行/秒）；
//   · **不能**写成 `[WS] recv:` 或 `[WS] recv: event `：真实回放显示前者会连带采样掉
//     今天 487 行 kernel-stderr 转发行里的 396 行（81%），后者会吃掉紧邻 assistant 帧到达
//     的 `tool_result`(975)/`result`(24)/`ponos_warning`(10) —— 这些是状态迁移与告警，不是噪声。
//   ⇒ 只认「帧级正文复本」这一种形状，其余一律全量。
const RENDER_CHATTER_PATTERNS = Object.freeze([
  /^\[WS\] recv: event \S+ assistant\b/,
])
// 命中即**永不采样**（帧里的异常才是要留的证据）。刻意宽松：误判只会多留几行，
// 漏判会丢掉仅有的异常证据。`warn` 不设词边界——`ponos_warning` 里的 `warn` 后面
// 接的是词字符，`\bwarn\b` 匹配不到（真实日志里就是这么写的）。
const RENDER_ALERT_RE = /\b(error|failed?|exception|crash|timeout|timed out|unresponsive|parse error)\b|warn/i
const RENDER_GATE_WINDOW_MS = 2000

// 闸门（纯状态机，可注入时钟）。allow(msg) → { allow, suppressed }：allow=false 时调用方
// **不得构造字符串、不得落盘**；suppressed>0 表示"这一段被吃掉了多少同类行"。
// patterns 里**不得带 /g 标志**（lastIndex 会让 .test 有状态）。
function createLineGate({ patterns = RENDER_CHATTER_PATTERNS, windowMs = RENDER_GATE_WINDOW_MS, now = () => Date.now() } = {}) {
  const last = new Map()       // pattern -> 上次放行的时刻
  const suppressed = new Map() // pattern -> 期间被吃掉的条数
  const full = () => process.env.PONOS_RENDER_LOG_FULL === '1'
  const windowMsNow = () => {
    const raw = process.env.PONOS_RENDER_LOG_WINDOW_MS
    if (raw === undefined || raw === '') return windowMs
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : windowMs   // 0 = 全量放行（同 FULL）
  }
  return {
    allow(msg) {
      const text = String(msg)
      if (full()) return { allow: true, suppressed: 0 }
      const hit = patterns.find((re) => re.test(text))
      if (!hit) return { allow: true, suppressed: 0 }        // 非帧级噪声：全量保留
      if (RENDER_ALERT_RE.test(text)) return { allow: true, suppressed: 0 }
      const win = windowMsNow()
      const t = now()
      const prev = last.get(hit)
      if (prev === undefined || win === 0 || t - prev >= win) {
        last.set(hit, t)
        const n = suppressed.get(hit) || 0
        suppressed.set(hit, 0)
        return { allow: true, suppressed: n }
      }
      suppressed.set(hit, (suppressed.get(hit) || 0) + 1)
      return { allow: false, suppressed: 0 }
    },
    pendingSuppressed: () => [...suppressed.values()].reduce((a, b) => a + b, 0),
  }
}

// 缓冲写（固定容量分片缓冲）：到点或到量才落盘，溢出走
// setImmediate 解耦（不阻塞当前 tick）。**必须显式 flush**（退出/崩溃路径），否则最多
// 丢一个窗口的行——诊断可接受，业务日志不走这条路。
function createBufferedWriter({ write, flushIntervalMs = 1000, maxBufferSize = 100, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let buf = []
  let timer = null
  function clearTimer() { if (timer) { clearTimeoutFn(timer); timer = null } }
  function flush() {
    clearTimer()
    if (!buf.length) return 0
    const batch = buf
    buf = []
    try { write(batch) } catch (_) { /* 日志设施自身出错绝不影响主流程 */ }
    return batch.length
  }
  return {
    push(line) {
      buf.push(line)
      if (buf.length >= maxBufferSize) { setImmediate(flush); return }
      if (!timer) {
        timer = setTimeoutFn(flush, flushIntervalMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
    },
    flush,
    size: () => buf.length,
  }
}

// 渲染器 console 落盘的**单一咽喉**：门控 → 组装 → 原输出 + 缓冲落盘。抽到本模块
// （而非留在 main.cjs 内联）是因为 main.cjs 没有测试载体，而这条路径正是 R1 的全部改动。
function createRendererConsoleSink({ home = resolveYfwHome, gate = createLineGate(), buffer = null, log = console.log } = {}) {
  const homeFn = typeof home === 'function' ? home : () => home
  const pathOf = () => path.join(homeFn(), 'logs', 'renderer-console.log')
  const buf = buffer || createBufferedWriter({
    write: (lines) => writeLogLines(pathOf(), lines, readLogPolicyCached({ home: homeFn() }), 'info'),
  })
  return {
    handle(message, sourceId = '', lineNumber = 0) {
      const text = String(message ?? '')
      const verdict = gate.allow(text)
      if (!verdict.allow) return false      // 门控在最前：不构造字符串、不调 console、不落盘
      let line = `[render:console] ${text} (${sourceId}:${lineNumber})`
      if (verdict.suppressed) line += ` (+${verdict.suppressed} 条同类被采样)`
      try { log(line) } catch (_) {}        // 原输出行为不变（终端/管道 + log-tee → app.log）
      try { buf.push(line) } catch (_) {}
      return true
    },
    flush: () => buf.flush(),
    size: () => buf.size(),
  }
}

// 启动一次性落地策略：年龄清理 + 存量超大文件裁剪 + 超限轮转。
// 必须处理"历史遗留的 76MB app.log"：只轮转不裁剪 = 得到一个活满 maxAgeDays 的巨型 .1。
function enforceLogPolicy(logPath, policy, now = Date.now()) {
  const p = normalizeLogPolicy(policy)
  const result = { rotated: false, trimmed: false, pruned: 0, skipped: false }
  if (!p.persist) { result.skipped = true; return result }
  try {
    let size = 0
    try { size = fs.statSync(logPath).size } catch (_) { /* 不存在：只剩年龄清理 */ }
    const trimCap = p.maxFileBytes * TRIM_KEEP_FACTOR
    if (size > trimCap) {
      const text = readTailBytes(logPath, trimCap)
      // 尾部按字节切可能截断首行（半个字符/半条日志）→ 丢掉第一个换行之前的不完整片段
      const nl = text.indexOf('\n')
      fs.writeFileSync(logPath, nl >= 0 ? text.slice(nl + 1) : text)
      result.trimmed = true
      size = fs.statSync(logPath).size
    }
    if (size > p.maxFileBytes) result.rotated = rotateLog(logPath, p)
    result.pruned = pruneByAge(logPath, p, now)
    return result
  } catch (_) {
    return result
  }
}

// 最近 N 行（查看器/诊断用）；n 钳到 1..500
function getLogTail(logPath, n = 200) {
  const count = clampInt(n, 1, 500, 200)
  try {
    if (!fs.existsSync(logPath)) return []
    const text = readTailBytes(logPath, MAX_TAIL_BYTES)
    return text.split(/\r?\n/).filter(Boolean).slice(-count)
  } catch (_) {
    return []
  }
}

// 文件名闸：正则 + 基名白名单 + 轮转序号 ≤ 保留份数（端点还会再做一次 resolve 包含性断言）
// 返回 { ok:true, name, base, index } | { ok:false, error }
const LOG_NAME_RE = /^([a-z0-9-]+\.log)(?:\.(\d{1,2}))?$/
function assertLogFileName(name, policy) {
  const p = normalizeLogPolicy(policy)
  const s = String(name ?? '')
  if (!s || s !== path.basename(s) || s.includes('..') || s.includes('/') || s.includes('\\') || s.includes(':')) {
    return { ok: false, error: `非法日志文件名：${JSON.stringify(s)}` }
  }
  const m = LOG_NAME_RE.exec(s)
  if (!m) return { ok: false, error: `文件名不在日志命名白名单：${s}` }
  if (!LOG_BASE_NAMES.includes(m[1])) return { ok: false, error: `不在日志基名白名单：${m[1]}` }
  const index = m[2] ? Number(m[2]) : 0
  if (index > p.maxFiles) return { ok: false, error: `轮转序号 ${index} 超出保留份数 ${p.maxFiles}` }
  return { ok: true, name: s, base: m[1], index }
}

// 列出日志文件（含轮转份），按最近修改倒序
function listLogFiles({ dir = logDirFor(), policy = null } = {}) {
  const p = normalizeLogPolicy(policy)
  const out = []
  let names = []
  try { names = fs.readdirSync(dir) } catch (_) { return out }
  for (const name of names) {
    const parsed = assertLogFileName(name, p)
    if (!parsed.ok) continue
    try {
      const st = fs.statSync(path.join(dir, name))
      out.push({ name, base: parsed.base, index: parsed.index, size: st.size, mtimeMs: st.mtimeMs })
    } catch (_) { /* 并发删除：忽略 */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

module.exports = {
  DEFAULT_LOG_POLICY,
  LOG_POLICY_LIMITS,
  LOG_LEVELS,
  LOG_BASE_NAMES,
  TRIM_KEEP_FACTOR,
  MAX_TAIL_BYTES,
  normalizeLogPolicy,
  logDirFor,
  logConfigPath,
  readLogPolicy,
  readLogPolicyCached,
  _resetLogPolicyCache,
  readTailBytes,
  rotateLog,
  pruneByAge,
  writeLogLine,
  writeLogLines,
  RENDER_CHATTER_PATTERNS,
  RENDER_GATE_WINDOW_MS,
  createLineGate,
  createBufferedWriter,
  createRendererConsoleSink,
  enforceLogPolicy,
  getLogTail,
  assertLogFileName,
  listLogFiles,
}
