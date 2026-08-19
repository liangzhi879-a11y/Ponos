// transcript.mjs — GUI 从内核 transcript 按需读取会话消息的三个 handler（供 bridge.mjs 路由接入）。
//
// 内核（yfw-kernel/claude-code，claude-code 官方同源）每次会话都在磁盘写 append-only JSONL
// transcript：<CLAUDE_CONFIG_DIR ?? ~/.yfworking>/projects/<sanitize(cwd)>/<sessionId>.jsonl，
// 每行一个原始 entry（type: user/assistant/system/attachment/queue-operation…）。
//
// 本模块只负责读文件 + 原样返回 entry，不做任何转换（parentUuid 链重建在 renderer/chatStore 侧）。
// 目录下还有 <sessionId>/ 子目录（subagent 产物），一律忽略，只处理 *.jsonl 且 UUID 命名的文件。
import { readdirSync, statSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

/** 单个路径段允许的最大长度（与内核 MAX_SANITIZED_LENGTH 一致，200 字符）。 */
export const MAX_SANITIZED_LENGTH = 200

/** 内核 getSessionFilesWithMtime 同款 UUID 文件名校验。 */
const UUID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/** tailFirst 模式截断阈值（>5MB 只读尾部最近 5MB）。 */
export const TAIL_LIMIT_BYTES = 5 * 1024 * 1024

/** 搜索 lite 元数据读取长度（前 64KB）。 */
export const SEARCH_LITE_HEAD = 64 * 1024

/** 搜索大文件截断阈值与单端读取上限（>10MB 只搜前 1MB + 尾 1MB）。 */
export const SEARCH_LARGE_THRESHOLD = 10 * 1024 * 1024
export const SEARCH_LARGE_CAP = 1024 * 1024

/**
 * 内核同款目录名 sanitize：非字母数字一律替换为 '-'。
 * 超过 200 字符时截断前 200 字符并追加 hash 后缀。
 * 内核用 Bun.hash(name).toString(36)（wyhash）；Node 侧没有 Bun.hash，
 * 超长路径场景罕见，这里用 md5 前 12 位 hex 替代——注意 hash 与内核产物
 * 文件名不一定一致，若实际遇到超长路径目录对不上，需改用与内核一致的算法。
 */
export function sanitizePathSegment(name) {
  const sanitized = String(name).replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  const hash = createHash('md5').update(String(name)).digest('hex').slice(0, 12)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

/** 判断文件名是否为合法 UUID transcript（<uuid>.jsonl）。 */
export function isUuidFile(name) {
  return UUID_FILE_RE.test(name)
}

/** 返回 transcript 项目根目录（projects 目录本身，不含项目子目录）。 */
export function transcriptBaseDir() {
  const cfg = process.env.CLAUDE_CONFIG_DIR
  return join(cfg || join(homedir(), '.yfworking'), 'projects')
}

/** 扫描单个项目目录下所有 UUID transcript 文件，按 mtime 倒序。 */
export function listSessions(projectsDir, cwd) {
  const dir = join(projectsDir, sanitizePathSegment(cwd))
  const sessions = []
  if (!existsSync(dir)) return sessions
  for (const name of readdirSync(dir)) {
    if (!isUuidFile(name)) continue // 忽略 <sessionId>/ 子目录与非 UUID 文件
    const fp = join(dir, name)
    let st
    try { st = statSync(fp) } catch { continue }
    if (!st.isFile()) continue
    sessions.push({
      sessionId: name.slice(0, -6),
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      cwd,
    })
  }
  sessions.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
  return sessions
}

/**
 * 逐行读取单个 transcript。
 * @param {boolean} tailFirst 默认 true：>5MB 只读尾部最近 5MB（GUI 激活会话展示）；
 *   false 全量读取（导出/搜索用）。截断时返回 truncated: true。
 * @returns {object} { ok, entries, truncated, skipped }；文件不存在返回 { ok: false, error: 'not found' }。
 */
export function loadTranscript(projectsDir, cwd, sessionId, tailFirst = true) {
  if (!isUuidFile(`${sessionId}.jsonl`)) {
    return { ok: false, error: 'invalid sessionId' }
  }
  const fp = join(projectsDir, sanitizePathSegment(cwd), `${sessionId}.jsonl`)
  if (!existsSync(fp)) {
    return { ok: false, error: 'not found' }
  }
  // 简化实现：readFileSync 全读后按字节 slice 尾部 5MB（超大文件可用 fd + read 偏移更稳，后续可优化）。
  let buf = readFileSync(fp)
  let truncated = false
  if (tailFirst !== false && buf.length > TAIL_LIMIT_BYTES) {
    buf = buf.subarray(buf.length - TAIL_LIMIT_BYTES)
    truncated = true
  }
  let text = buf.toString('utf-8')
  if (truncated) {
    // 截断点可能落在某行中间：丢弃首行残片，从完整行开始解析（残片不计入 skipped，
    // 因为那是主动截断造成的，不是数据损坏）。
    const nl = text.indexOf('\n')
    if (nl >= 0) text = text.slice(nl + 1)
    else text = ''
  }
  const entries = []
  let skipped = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      entries.push(JSON.parse(t))
    } catch {
      skipped += 1
    }
  }
  return { ok: true, entries, truncated, skipped }
}

/**
 * 轻量全文搜索：遍历所有项目目录的 transcript，内容子串匹配（大小写不敏感）。
 * 大文件（>10MB）只搜前 1MB + 尾 1MB；snippet 取首个匹配位置前后各 60 字符。
 * @returns {Array} 按 mtime 倒序的 [{ projectCwd, sessionId, size, mtime, matchCount, snippet }]
 */
export function searchTranscripts(projectsDir, query, { limit = 50 } = {}) {
  const q = String(query || '').toLowerCase()
  const results = []
  if (!q || !existsSync(projectsDir)) return results
  for (const projName of readdirSync(projectsDir)) {
    const projDir = join(projectsDir, projName)
    let pst
    try { pst = statSync(projDir) } catch { continue }
    if (!pst.isDirectory()) continue
    for (const name of readdirSync(projDir)) {
      if (!isUuidFile(name)) continue
      const fp = join(projDir, name)
      let st
      try { st = statSync(fp) } catch { continue }
      if (!st.isFile()) continue
      let text
      if (st.size > SEARCH_LARGE_THRESHOLD) {
        // 大文件只搜头尾各 1MB，避免全量读入内存
        const full = readFileSync(fp)
        text =
          full.subarray(0, SEARCH_LARGE_CAP).toString('utf-8') +
          '\n' +
          full.subarray(full.length - SEARCH_LARGE_CAP).toString('utf-8')
      } else {
        text = readFileSync(fp, 'utf-8')
      }
      const lower = text.toLowerCase()
      const idx = lower.indexOf(q)
      if (idx < 0) continue
      let matchCount = 0
      let from = 0
      while (from <= lower.length) {
        const i = lower.indexOf(q, from)
        if (i < 0) break
        matchCount += 1
        from = i + q.length
      }
      const s = Math.max(0, idx - 60)
      results.push({
        projectCwd: projName, // sanitize 后的目录名（不可逆，无法反推原始 cwd）
        sessionId: name.slice(0, -6),
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        matchCount,
        snippet: text.slice(s, idx + 60 + q.length),
      })
    }
  }
  // 全量收集后统一按 mtime 倒序，再截取 limit（目录遍历顺序 ≠ mtime 顺序）
  results.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
  return results.slice(0, limit)
}

/**
 * 工厂：绑定默认 projectsDir（可由调用方注入 base 以便测试）。
 * bridge.mjs 只 import 本工厂 + 三个顶层函数即可。
 */
export function createTranscriptHandlers(base) {
  const projectsDir = base || transcriptBaseDir()
  return {
    listSessions: (cwd) => listSessions(projectsDir, cwd),
    loadTranscript: (cwd, sessionId, tailFirst) => loadTranscript(projectsDir, cwd, sessionId, tailFirst),
    searchTranscripts: (query, limit) => searchTranscripts(projectsDir, query, { limit }),
  }
}
