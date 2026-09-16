// MCP 客户端（stdio 传输，P1-5）——零依赖、自包含的 JSON-RPC 2.0 客户端。
// ---------------------------------------------------------------------------
// 设计要点（与 spec docs/superpowers/specs/2026-09-16-mcp-client-design.md 对应）：
//   · 只做 stdio（覆盖面最广、无额外依赖）；只做 tools（resources/prompts/sampling 不做）
//   · **不 import 引擎内部模块**：本文件只依赖 node 内置 ⇒ 无循环依赖、可直接单测
//   · 三类"悬挂"必须杜绝（否则工具调用卡死整个引擎轮次）：
//       ① 请求超时   ② 子进程退出/断流   ③ 调用方 abort
//     三种情况都必须把 pending 里的 promise 全部 reject 并清空，绝不留下永不 resolve 的项
//   · stderr 单独按行留存（最近 N 行）作诊断，**不混入 stdout**（那是协议流）
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_MCP_TIMEOUT_MS = 20000
const STDERR_KEEP = 20

// 子进程环境白名单：不把宿主全部环境（可能含密钥）透传给第三方 MCP 服务器。
// 与 tools.mjs 的 childEnv() 同思路，但此处**内联**以保持本模块零依赖。
const ENV_KEEP = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'windir',
  'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'NODE_PATH', 'SHELL', 'TERM',
]

/** 构造受限环境；显式 env 覆盖白名单（用户配置的服务器变量优先） */
export function mcpChildEnv(extra = {}) {
  const out = {}
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) out[k] = process.env[k]
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) out[k] = String(v)
  return out
}

/**
 * 解析 `${ENV_VAR}` 占位符（P1-5 扩展：远程 MCP 的认证头）。
 *
 * 两条不可动摇的规则：
 *  ① **只在运行时求值**，写盘时保留字面量 —— mcp.json 会被备份、截图、同步到网盘，
 *     明文 token 一旦落盘就永久留在那些副本里。
 *  ② **未定义变量抛错并点名**，绝不静默替换为空串 —— 静默会得到 `Bearer ` 这种
 *     语法正确但语义空洞的头，服务器回一个含义不明的 401，排查成本远高于直接报错。
 *
 * 只把变量是否存在交给运行环境判断：写配置的环境未必是运行环境
 * （GUI 在桌面，变量可能来自启动脚本），因此校验侧只查语法、不查变量。
 */
export function interpolateEnv(value, env = process.env, where = '') {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = env?.[name]
    if (v === undefined || v === '') {
      throw new Error(`环境变量 ${name} 未定义${where ? `（配置项 ${where}）` : ''}`)
    }
    return String(v)
  })
}

/**
 * 判定一个配置条目走哪种传输（P1-5 扩展：stdio 或 Streamable HTTP）。
 * **读侧与校验侧共用同一份判定**——本文件顶部已声明强约束「写出的必须能被读回等价」，
 * 若两处各写一套规则，用户会看到"保存成功但服务器消失"这类静默失效。
 *
 * 规则：`command`（stdio）与 `url`（HTTP）**恰好其一**。
 * 同时配置是错误而非"优先其一"：留一个二义会让运行期行为取决于实现顺序。
 * @returns {{kind:'stdio'} | {kind:'http', url:string} | {kind:'invalid', reason:string}}
 */
export function classifyMcpEntry(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { kind: 'invalid', reason: '条目必须是对象' }
  const command = String(cfg.command ?? '').trim()
  const urlRaw = String(cfg.url ?? '').trim()
  if (command && urlRaw) return { kind: 'invalid', reason: '不能同时配置 command 与 url（二选一）' }
  if (!command && !urlRaw) return { kind: 'invalid', reason: '缺少 command 或 url' }
  if (!urlRaw) {
    // stdio：远程专属字段出现在本地条目上，几乎总是用户改到一半的半成品，报错优于默默忽略
    if (cfg.headers !== undefined) return { kind: 'invalid', reason: 'headers 仅适用于 url 传输' }
    return { kind: 'stdio' }
  }
  let u = null
  try { u = new URL(urlRaw) } catch { /* 落到下面的报错 */ }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    return { kind: 'invalid', reason: 'url 必须是 http/https 绝对地址' }
  }
  if (cfg.args !== undefined || cfg.cwd !== undefined || cfg.env !== undefined) {
    return { kind: 'invalid', reason: 'args/env/cwd 仅适用于 command 传输' }
  }
  return { kind: 'http', url: urlRaw }
}

/** 归一化 HTTP 头：只收原始类型（对象/数组作头值无意义，写进文件只会让人以为内核不认） */
function normalizeHeaders(raw) {
  const out = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[String(k)] = String(v)
    }
  }
  return out
}

/** timeoutMs 归一：非法/非正数 → 默认值（两套读写面共用，避免各判一次） */
const normalizeTimeout = (v) => (Number.isFinite(v) && v > 0 ? v : DEFAULT_MCP_TIMEOUT_MS)

/**
 * 读 MCP 服务器配置。两种条目形态：
 *   stdio：{ command, args?, env?, cwd?, timeoutMs? }
 *   HTTP ：{ url, headers?, timeoutMs? }（P1-5 扩展）
 * - 文件不存在 → {}（**默认零行为变化**：没配置 MCP 的用户与从前完全一致）
 * - JSON 损坏 / 结构不对 → **抛出**（由注册表捕获并记日志，不让内核启动失败）
 * - 单条目不合法 → 跳过（宁可少一个工具，不要半个坏服务器）
 */
export function loadMcpServers(configPath) {
  if (!configPath || !existsSync(configPath)) return {}
  const data = JSON.parse(readFileSync(configPath, 'utf-8'))
  const servers = data && typeof data === 'object' ? data.servers : null
  if (!servers || typeof servers !== 'object') return {}
  const out = {}
  for (const [name, cfg] of Object.entries(servers)) {
    const kind = classifyMcpEntry(cfg)
    if (kind.kind === 'invalid') continue // 与 normalizeMcpServers 同判定 ⇒ 不会出现"存得进、读不出"
    if (kind.kind === 'http') {
      out[name] = {
        url: kind.url,
        headers: normalizeHeaders(cfg.headers),
        timeoutMs: normalizeTimeout(cfg.timeoutMs),
      }
      continue
    }
    out[name] = {
      command: String(cfg.command).trim(),
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
      cwd: cfg.cwd ? String(cfg.cwd) : null,
      timeoutMs: normalizeTimeout(cfg.timeoutMs),
    }
  }
  return out
}

/** 名字安全字符化：MCP 工具名进入模型工具表，须限制在可预期字符集内 */
export function sanitizeMcpName(s) {
  return String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_')
}

/** 工具命名：mcp__<server>__<tool>（双下划线分隔，与 app_* 体系不冲突） */
export function mcpToolName(server, tool) {
  return `mcp__${sanitizeMcpName(server)}__${sanitizeMcpName(tool)}`
}

/** MCP tools/call 结果 → 纯文本（content 数组展平；非文本条目 JSON 化） */
export function contentToText(result) {
  if (result === null || result === undefined) return ''
  const parts = Array.isArray(result.content) ? result.content : null
  if (!parts) return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  const out = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') { out.push(String(p)); continue }
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text)
    else if (p.type === 'image') out.push(`[图片 ${p.mimeType || ''} 已省略]`)
    else if (p.type === 'resource' && p.resource?.text) out.push(String(p.resource.text))
    else out.push(JSON.stringify(p))
  }
  return out.join('\n')
}

/**
 * JSON-RPC 会话核心（P1-5 扩展：stdio 与 HTTP **共用**）。
 *
 * 抽出来的理由不是"少写代码"，而是**语义只能有一份**：本模块最需要杜绝的是三类悬挂
 * （① 请求超时 ② 传输断开 ③ 调用方 abort），每种都必须把 pending 清空并 reject。
 * 若 stdio 与 HTTP 各写一套，超时不回收定时器、close 后不 reject 这类 bug 会在两处
 * 各自出现、各自逃过测试 —— 这是这类传输扩展最典型的事故形态。
 *
 * 传输侧只需提供 `send(msg)`，并把入站消息交给 `handleMessage(msg)`。
 * @param {{name:string, timeoutMs?:number, send:(msg:object)=>any, onLog?:Function}} opts
 */
export function createJsonRpcSession({ name, timeoutMs = DEFAULT_MCP_TIMEOUT_MS, send, onLog = null } = {}) {
  const log = (level, msg) => { try { onLog?.(level, msg) } catch { /* 日志失败不影响协议 */ } }
  let closed = false
  let nextId = 0
  let errors = 0
  const pending = new Map()     // id → { resolve, reject }

  const rejectAll = (err) => {
    for (const [, p] of pending) { try { p.reject(err) } catch { /* 已 settle */ } }
    pending.clear()
  }

  const closeWith = (err, why) => {
    if (closed) return
    closed = true
    log('warn', `MCP 服务器 ${name} 已关闭（${why}）`)
    rejectAll(err || new Error(`MCP 服务器 ${name} 已关闭`))
  }

  function request(method, params, { signal, timeoutMs: tmo } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error(`MCP 服务器 ${name} 已关闭`))
      if (signal?.aborted) return reject(new Error('已取消'))
      const ms = tmo || timeoutMs
      const id = ++nextId
      // 单点收尾：无论如何结束都必须清定时器与 abort 监听，否则每个请求都会泄漏一个定时器
      const finish = (fn, arg) => {
        if (!pending.has(id)) return
        pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        fn(arg)
      }
      const timer = setTimeout(() => {
        errors++
        finish(reject, new Error(`MCP ${name} ${method} 超时（${ms}ms）`))
      }, ms)
      timer.unref?.()
      const onAbort = () => finish(reject, new Error('已取消'))
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, { resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e) })
      const msg = { jsonrpc: '2.0', id, method }
      if (params !== undefined) msg.params = params
      try {
        // send 可同步失败（stdio 写管道）也可异步失败（HTTP fetch）：两种情况都必须
        // 落到本请求上，否则 promise 会一直挂到超时、错误还会变成 unhandled rejection。
        // 传输侧若已自行 rejectAll，这里的 finish 是空操作。
        const sent = send(msg)
        if (sent === false) finish(reject, new Error(`MCP 服务器 ${name} 发送失败`))
        else if (sent && typeof sent.then === 'function') {
          sent.then(
            (v) => { if (v === false) finish(reject, new Error(`MCP 服务器 ${name} 发送失败`)) },
            (e) => finish(reject, e),
          )
        }
      } catch (e) { finish(reject, e) }
    })
  }

  /**
   * 处理入站消息。命中本会话的请求 id 才结算，返回是否已处理
   * （无 id 的通知不参与请求应答，由调用方决定如何对待）。
   */
  function handleMessage(msg) {
    if (!msg || msg.id === undefined || msg.id === null) return false
    const p = pending.get(msg.id)
    if (!p) return false
    if (msg.error) {
      errors++
      const e = new Error(`MCP ${name} 返回错误: ${msg.error.message || JSON.stringify(msg.error)}`)
      e.mcpError = msg.error
      p.reject(e)
    } else p.resolve(msg.result)
    return true
  }

  return {
    request,
    handleMessage,
    notify: (method, params) => {
      const msg = { jsonrpc: '2.0', method }
      if (params !== undefined) msg.params = params
      return send(msg)
    },
    closeWith,
    close: (err) => closeWith(err, 'close'),
    stats: () => ({ pending: pending.size, closed, errors }),
  }
}

/**
 * 启动一个 MCP 服务器并完成握手。
 * 返回 { name, tools(), call(), close(), stats() }；失败时 reject（由调用方决定降级）。
 */
export async function startMcpClient({ name, command, args = [], env = {}, cwd = null, timeoutMs = DEFAULT_MCP_TIMEOUT_MS, onLog = null } = {}) {
  const log = (level, msg) => { try { onLog?.(level, msg) } catch { /* 日志失败不影响协议 */ } }
  // Windows 上 npx/node 可能是 .cmd 或位于含空格的目录（如 "C:\Program Files\nodejs"）：
  // shell 模式下必须自行加引号，否则 cmd.exe 会把路径从空格处截断。
  const useShell = process.platform === 'win32'
  const quote = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s))
  const spawnOpts = {
    cwd: cwd || undefined,
    env: mcpChildEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(useShell ? { shell: true } : {}),
  }
  const child = useShell
    ? spawn([command, ...args].map(quote).join(' '), spawnOpts)
    : spawn(command, args, spawnOpts)

  const stderrLines = []
  let calls = 0
  let toolsCache = null

  // —— 传输侧只提供 send；pending/超时/abort/收尾语义全部交给会话核心 ——
  const session = createJsonRpcSession({
    name,
    timeoutMs,
    onLog,
    send: (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n')
        return true
      } catch (e) {
        // 写失败即"传输已断"：closeWith 会 reject 全部 pending（含本次请求）
        session.closeWith(new Error(`MCP 服务器 ${name} 写入失败: ${e.message}`), 'write')
        return false
      }
    },
  })

  // —— stdout：逐行 JSON（协议流）——
  let buf = ''
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { log('warn', `MCP ${name} 收到非法 JSON 行（已忽略）`); continue }
      // 无 id 的通知（如 notifications/message）不参与请求应答，handleMessage 返回 false
      session.handleMessage(msg)
    }
  })

  // —— stderr：诊断留存，不混入协议流 ——
  child.stderr.setEncoding('utf-8')
  let errBuf = ''
  child.stderr.on('data', (chunk) => {
    errBuf += chunk
    let idx
    while ((idx = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, idx).trim()
      errBuf = errBuf.slice(idx + 1)
      if (!line) continue
      stderrLines.push(line)
      if (stderrLines.length > STDERR_KEEP) stderrLines.shift()
      log('debug', `MCP ${name} stderr: ${line}`)
    }
  })

  // —— 进程退出 / 断流：必须 reject 全部 pending（否则引擎轮次永久卡住）——
  child.on('error', (e) => session.closeWith(new Error(`MCP 服务器 ${name} 启动/运行失败: ${e.message}`), 'error'))
  child.on('exit', (code, sig) => session.closeWith(new Error(`MCP 服务器 ${name} 已退出（code=${code}${sig ? `, signal=${sig}` : ''}）`), 'exit'))
  child.stdin.on('error', () => session.closeWith(new Error(`MCP 服务器 ${name} stdin 断流`), 'stdin'))

  const request = session.request
  const notify = session.notify

  // —— 握手：initialize → notifications/initialized ——
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'yfworking', version: '1.0.0' },
  })
  notify('notifications/initialized')

  return {
    name,
    protocolVersion: init?.protocolVersion || null,
    serverInfo: init?.serverInfo || null,
    async tools() {
      if (toolsCache) return toolsCache
      const r = await request('tools/list', {})
      toolsCache = Array.isArray(r?.tools)
        ? r.tools.map((t) => ({
          name: String(t.name),
          description: String(t.description || ''),
          input_schema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        }))
        : []
      return toolsCache
    },
    async call(tool, argsObj = {}, opts = {}) {
      calls++
      const r = await request('tools/call', { name: tool, arguments: argsObj || {} }, opts)
      return { text: contentToText(r), isError: r?.isError === true, raw: r }
    },
    close() {
      try { child.stdin.end() } catch { /* 已关闭 */ }
      try { child.kill() } catch { /* 已退出 */ }
      session.closeWith(new Error(`MCP 服务器 ${name} 已关闭`), 'close')
    },
    stats() {
      const s = session.stats()
      return { pending: s.pending, closed: s.closed, calls, errors: s.errors, lastStderr: stderrLines.slice(-5) }
    },
  }
}

// ---------------------------------------------------------------------------
// 配置文件的**读写面**（P1-6，供 GUI 的 MCP 配置界面使用）——与上面的客户端逻辑分开：
//   · `loadMcpServers` 是内核启动路径，纪律是"坏配置不许拖垮内核"（解析失败就抛出、由调用方跳过）
//   · 这一组是**GUI 路径**，纪律是"坏数据不许落盘、坏文件不许抛崩界面"（全部返回 {ok:false}）
// 两套纪律不能混用：内核可以"跳过坏配置继续跑"，但 GUI 必须把错误**回报给用户**，
// 否则用户点"保存"后界面显示成功、内核其实读不懂 —— 这是本仓库最痛的一类静默失效。
//
// 强约束（有测试断言）：`writeMcpServers` 写出的文件必须能被 `loadMcpServers` 读回等价内容。
// 若两边归一化规则漂移（例如这里过滤了 args、那边没过滤），用户会看到"保存成功但服务器消失"。
// ---------------------------------------------------------------------------

/**
 * 归一化 `{ servers: { <name>: {command,args,env,cwd,timeoutMs} 或 {url,headers,timeoutMs} } }`
 * （**纯函数、无 IO**）。
 * 校验严格是因为它挡在磁盘前面：任何"能通过校验但内核读不懂"的条目都是静默失效。
 * @returns {{ok:true, servers:object} | {ok:false, error:string}}
 */
export function normalizeMcpServers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // 数组也是 typeof 'object'，但它不可能是合法配置；放行会变成"用 [] 把用户配置清空"
    return { ok: false, error: 'MCP 配置必须是 JSON 对象' }
  }
  const src = raw.servers === undefined ? {} : raw.servers
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { ok: false, error: 'servers 必须是对象（{ "<名称>": { command, ... } }）' }
  }
  const out = {}
  for (const [rawName, cfg] of Object.entries(src)) {
    const name = String(rawName || '').trim()
    if (!name) return { ok: false, error: '服务器名称不能为空' }
    // 逐条目报姓名是 GUI 能定位问题的前提（哪台服务器填错了）
    const kind = classifyMcpEntry(cfg)
    if (kind.kind === 'invalid') return { ok: false, error: `服务器 "${name}" ${kind.reason}` }
    if (kind.kind === 'http') {
      // 只存 ${ENV_VAR} 字面量，**运行时**才取环境变量 ⇒ 密钥不进入 mcp.json
      // （该文件会被备份、截图、同步到网盘）。此处不校验变量是否存在：
      // 写配置的环境未必是运行环境，由"连接测试"即时反馈更准确。
      out[name] = {
        url: kind.url,
        headers: normalizeHeaders(cfg.headers),
        timeoutMs: normalizeTimeout(cfg.timeoutMs),
      }
      continue
    }
    const command = String(cfg.command).trim()
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : []
    const env = {}
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      for (const [k, v] of Object.entries(cfg.env)) {
        // 只收原始类型：对象/数组当环境变量值毫无意义，写进文件只会让用户以为是内核不认
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') env[k] = String(v)
      }
    }
    const entry = { command, args, env }
    // cwd 为空则**不设该键**：留空字符串会让 spawn 以空 cwd 启动而报错，
    // 而"缺键"在 `loadMcpServers` 侧本来就是 null（= 沿用当前工作目录）。
    const cwd = cfg.cwd === undefined || cfg.cwd === null ? '' : String(cfg.cwd).trim()
    if (cwd) entry.cwd = cwd
    entry.timeoutMs = normalizeTimeout(cfg.timeoutMs)
    out[name] = entry
  }
  return { ok: true, servers: out }
}

/**
 * 读配置供 GUI 展示。**绝不抛出**（GUI 要能显示"文件坏了"而不是白屏）。
 * @returns {{ok:true, servers:object} | {ok:false, error:string}} 缺文件视为空配置
 */
export function readMcpServers(configPath) {
  try {
    if (!configPath || !existsSync(configPath)) return { ok: true, servers: {} }
    const n = normalizeMcpServers(JSON.parse(readFileSync(configPath, 'utf-8')))
    return n.ok ? n : { ok: false, error: n.error }
  } catch (e) {
    return { ok: false, error: `MCP 配置读取失败：${e?.message || String(e)}` }
  }
}

/**
 * 写配置（`servers` 是**服务器映射**，即 `{servers:{...}}` 里的那层）。
 * - 校验不通过 → **直接返回且不触碰磁盘**（半校验就落盘会把用户既有配置写坏）
 * - 校验通过 → mkdir → 写 `<configPath>.tmp` → rename 原子替换（避免半截文件被内核读到）
 * - **保留现有文件里的未知顶层键**：将来配置里加别的字段（或用户手写注释性字段）不因保存而丢
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function writeMcpServers(configPath, servers) {
  if (!configPath) return { ok: false, error: '缺少配置文件路径' }
  const n = normalizeMcpServers({ servers })
  if (!n.ok) return n
  let base = {}
  if (existsSync(configPath)) {
    try {
      const cur = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (cur && typeof cur === 'object' && !Array.isArray(cur)) base = cur
      // 现有文件坏了：无法保留未知键，只能整体覆盖（GUI 的 GET 已把错误告诉用户）
    } catch { /* 同上 */ }
  }
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    const tmp = `${configPath}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...base, servers: n.servers }, null, 2) + '\n', 'utf-8')
    renameSync(tmp, configPath) // 原子替换：内核随时可能重读此文件，绝不能看到半截 JSON
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `MCP 配置写入失败：${e?.message || String(e)}` }
  }
}
