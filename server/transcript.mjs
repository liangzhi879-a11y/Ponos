// transcript.mjs — GUI 从内核 transcript 按需读取（+ 删除）会话消息的 handler（供 bridge.mjs 路由接入）。
//
// 内核（本库 kernel/ 源码或 kernel-dist bundle——ponos，node 直跑）每次会话都在磁盘写 append-only JSONL
// transcript：<CLAUDE_CONFIG_DIR ?? ~/.yfworking>/projects/<sanitize(cwd)>/<sessionId>.jsonl，
// 每行一个原始 entry（type: user/assistant/system/attachment/queue-operation…）。
//
// 读路径只负责读文件 + 原样返回 entry，不做任何转换（parentUuid 链重建在 renderer/chatStore 侧）。
// 目录下还有 <sessionId>/ 子目录（subagent 产物），一律忽略，只处理 *.jsonl 且 UUID 命名的文件。
//
// 删除路径（2026-09-16 新增，deleteTranscript）：GUI 删除会话时同步清掉该会话的磁盘转录。
// 此前该模块只读、chatStore 的注释写着"transcript 随内核保留"——结果是用户删了会话，转录
// 永远留在 <YFW_HOME>/projects 下（实测本机 2.3G / 72 个项目目录）。删除同样只认 *.jsonl 且
// UUID 命名的文件，且必须由调用方（chatStore）用**内核 sessionId**（≠ GUI conversation.id）驱动。
import { readdirSync, statSync, existsSync, readFileSync, unlinkSync, rmdirSync } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'
import { createHash } from 'crypto'
import { resolveYfwHome } from './yfw-home.cjs'

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
  // 数据根经共享模块解析（YFWORKING_HOME || CLAUDE_CONFIG_DIR || ~/.yfworking）：
  // 与 bridge spawn 内核时注入的 CLAUDE_CONFIG_DIR 指向同一 home，隔离模式下
  // 转录读写一致落在隔离根目录。
  return join(resolveYfwHome(), 'projects')
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

// 自愈注入过滤（2026-09-11）：内核自愈指令（【系统】/【提示】开头的 user 消息）留在
// agent loop 内——transcript 原文不动（内核 resume 时模型仍可见，loop 语义完整），
// 但 GUI 会话展示过滤掉，用户可见历史不出现系统自愈噪声。
const HIDDEN_INJECT_PREFIX = /^(【系统】|【提示】)/
export function isHiddenLoopInjection(entry) {
  const m = entry?.message
  return entry?.type === 'user' && typeof m?.content === 'string' && HIDDEN_INJECT_PREFIX.test(String(m.content).trim())
}

/**
 * 兜底查找：cwd 映射不到 transcript 时（典型=chat 模式会话——GUI 侧会话不存 cwd，
 * 请求带空 cwd 落到 projects 根目录；而内核 chat 模式 spawn cwd=YFW_HOME 或历史
 * 版本写入过其它目录），扫描 projects 根目录 + 全部项目子目录寻找 <sessionId>.jsonl。
 * 多处命中时取 mtime 最新者。只在该目录未命中的低频路径调用。
 * @returns {string|null} 命中的文件绝对路径；未命中返回 null。
 */
export function findTranscriptAnywhere(projectsDir, sessionId) {
  const target = `${sessionId}.jsonl`
  let best = null
  const consider = (fp) => {
    try {
      const st = statSync(fp)
      if (!st.isFile()) return
      if (!best || st.mtimeMs > best.mtime) best = { fp, mtime: st.mtimeMs }
    } catch { /* 文件可能并发消失，忽略 */ }
  }
  consider(join(projectsDir, target))
  if (existsSync(projectsDir)) {
    for (const name of readdirSync(projectsDir)) {
      const d = join(projectsDir, name)
      let st
      try { st = statSync(d) } catch { continue }
      if (!st.isDirectory()) continue
      consider(join(d, target))
    }
  }
  return best ? best.fp : null
}

/**
 * 逐行读取单个 transcript。
 * @param {boolean} tailFirst 默认 true：>5MB 只读尾部最近 5MB（GUI 激活会话展示）；
 *   false 全量读取（导出/搜索用——含自愈注入原文，导出保留完整数据）。
 *   展示路径（tailFirst!==false）过滤内核自愈注入（见 isHiddenLoopInjection），
 *   返回 hidden 计数；截断时返回 truncated: true。
 * @returns {object} { ok, entries, truncated, skipped, hidden }；文件不存在返回 { ok: false, error: 'not found' }。
 */
export function loadTranscript(projectsDir, cwd, sessionId, tailFirst = true) {
  if (!isUuidFile(`${sessionId}.jsonl`)) {
    return { ok: false, error: 'invalid sessionId' }
  }
  let fp = join(projectsDir, sanitizePathSegment(cwd), `${sessionId}.jsonl`)
  if (!existsSync(fp)) {
    // cwd 映射未命中（chat 模式会话 cwd 为空等）：全盘兜底找一次。
    fp = findTranscriptAnywhere(projectsDir, sessionId)
    if (!fp) {
      return { ok: false, error: 'not found' }
    }
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
  let hidden = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const entry = JSON.parse(t)
      // 展示路径过滤自愈注入（导出/搜索 tailFirst===false 保留全量原文）
      if (tailFirst !== false && isHiddenLoopInjection(entry)) {
        hidden += 1
        continue
      }
      entries.push(entry)
    } catch {
      skipped += 1
    }
  }
  return { ok: true, entries, truncated, skipped, hidden }
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
 * 删除单个会话的磁盘转录（GUI 删会话 → bridge /transcript/delete → 这里）。
 *
 * 安全约束（逐条对应门禁测试）：
 *   · sessionId 必须通过 isUuidFile 严格校验——非 UUID 一律不动任何文件（拦 `../x`、空串等）；
 *   · 目标路径由 cwd 经 sanitizePathSegment 计算，且必须仍在 projectsDir 之内（resolve + relative
 *     复核，防路径穿越；sanitize 已把分隔符换成 '-'，这里是第二道闸，将来 sanitize 行为变化也不会删到外面）；
 *   · 只删 `<sessionId>.jsonl` 文件本身，不递归、不删子目录（<sessionId>/ 是 subagent 产物，不属于本次范围）；
 *   · **任何情况都不抛异常**——调用方是 fire-and-forget 的 UI 动作，失败只作为返回值上报。
 *
 * @returns {{deleted: boolean, reason: 'deleted'|'invalid-id'|'outside-base'|'not-found'|'io-error'}}
 */
export function deleteTranscript(projectsDir, cwd, sessionId) {
  if (!isUuidFile(`${sessionId}.jsonl`)) {
    return { deleted: false, reason: 'invalid-id' }
  }
  const base = resolve(projectsDir)
  const projectDir = join(base, sanitizePathSegment(cwd ?? ''))
  const fp = join(projectDir, `${sessionId}.jsonl`)
  const rel = relative(base, fp)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { deleted: false, reason: 'outside-base' }
  }
  try {
    // 不存在（或同名的是目录）→ not-found：接口按幂等处理，不算失败
    if (!existsSync(fp) || !statSync(fp).isFile()) {
      return { deleted: false, reason: 'not-found' }
    }
    unlinkSync(fp)
  } catch {
    return { deleted: false, reason: 'io-error' } // 文件被占用/权限不足：如实上报，不抛
  }
  // 删完往往只剩空壳项目目录（实测 72 个项目目录里大量如此），空目录同样算垃圾 → 顺手收掉。
  // 失败（非空 / 被占用 / 仍有 subagent 子目录）忽略；base 自身永不删。
  try {
    if (projectDir !== base && readdirSync(projectDir).length === 0) rmdirSync(projectDir)
  } catch { /* 目录非空或被占用：保留，不影响删除结果 */ }
  return { deleted: true, reason: 'deleted' }
}

/**
 * 工厂：绑定默认 projectsDir（可由调用方注入 base 以便测试）。
 * bridge.mjs 只 import 本工厂 + 四个顶层函数即可。
 */
export function createTranscriptHandlers(base) {
  const projectsDir = base || transcriptBaseDir()
  return {
    listSessions: (cwd) => listSessions(projectsDir, cwd),
    loadTranscript: (cwd, sessionId, tailFirst) => loadTranscript(projectsDir, cwd, sessionId, tailFirst),
    searchTranscripts: (query, limit) => searchTranscripts(projectsDir, query, { limit }),
    // 参数顺序与 loadTranscript 的 handler 保持一致（sessionId 在前，cwd 在后）：
    // 两者都由 chatStore 以 conversation.sessionId 驱动。
    deleteTranscript: (sessionId, cwd) => deleteTranscript(projectsDir, cwd, sessionId),
  }
}
