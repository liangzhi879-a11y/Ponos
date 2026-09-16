// MCP 客户端（Streamable HTTP 传输，P1-5 扩展）——零依赖，仅用 Node 原生 fetch。
// ---------------------------------------------------------------------------
// 为什么是 Streamable HTTP 而不是"HTTP+SSE"：
//   旧式 HTTP+SSE（协议版本 2024-11-05）需要**两个端点**（先 GET 建 SSE 流、再 POST 发消息），
//   该方案已被规范废止。现行规范（2025-03-26）改为 **Streamable HTTP**：单一端点，POST 发消息，
//   响应可协商为 `application/json` 或 `text/event-stream`。后者天然覆盖了旧式的能力，
//   因此本模块只实现单端点 POST —— 一个端点、一条代码路径，也更容易把错误语义做准。
//
// 与 stdio 客户端的关系：**共用 createJsonRpcSession**（pending/超时/abort/收尾语义只有一份）。
// 本模块只负责"把一条 JSON-RPC 消息送到远端、把回来的消息交给会话核心"。
//
// 安全红线（每条都有对应测试）：
//   · 密钥以 ${ENV_VAR} 占位、**运行时**才求值 ⇒ 明文不进 mcp.json
//   · `redirect: 'error'` ⇒ 不跟随重定向（fetch 默认跟随会把 Authorization 带到另一主机）
//   · 日志与错误串**绝不包含头值**（含"URL 里插值过"的情况，整条 URL 一并脱敏）
import {
  createJsonRpcSession, interpolateEnv, contentToText, DEFAULT_MCP_TIMEOUT_MS,
} from './mcp.mjs'

/** 本客户端实现的 MCP 协议版本（Streamable HTTP 引入于该版本） */
export const MCP_HTTP_PROTOCOL_VERSION = '2025-03-26'
const CLIENT_INFO = { name: 'yfworking', version: '1.0.0' }

/** 兜底短文案：错误里带上响应片段便于诊断，但**截断**（避免把整页 HTML 灌进日志/聊天） */
async function readSnippet(res, max = 200) {
  try {
    const t = await res.text()
    return t.length > max ? `${t.slice(0, max)}…` : t
  } catch { return '' }
}

/**
 * 启动一个远程 MCP 服务器（Streamable HTTP）并完成握手。
 * 返回形状与 `startMcpClient`（stdio）**一致** ⇒ 注册表与工具接入层无感。
 * 失败时 reject（由调用方决定降级：单台失败不影响其它服务器）。
 */
export async function startMcpHttpClient({
  name, url, headers = {}, timeoutMs = DEFAULT_MCP_TIMEOUT_MS, onLog = null, env = process.env,
} = {}) {
  if (!url || !String(url).trim()) throw new Error(`MCP 服务器 ${name} 缺少 url`)
  const log = (level, msg) => { try { onLog?.(level, msg) } catch { /* 日志失败不影响协议 */ } }
  const rawUrl = String(url).trim()

  // —— 脱敏：任何要外流的文本（日志、错误、工具结果）都先过这里 ——
  // 头值天生是密钥；URL 只有"含插值"时才整体视为敏感（否则会把有用的地址信息也抹掉）。
  const secrets = []
  const redact = (text) => {
    let out = String(text ?? '')
    for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[已隐藏]')
    return out
  }

  // 头与 URL 在**启动时**一次性解析：认证信息不对就没必要建立会话，
  // 也让"哪个变量没定义"以一条清晰的错误暴露，而不是每个请求都重复抛一次。
  const resolvedHeaders = {}
  try {
    for (const [k, v] of Object.entries(headers || {})) {
      resolvedHeaders[k] = interpolateEnv(v, env, `headers.${k}`)
    }
  } catch (e) { throw new Error(redact(e?.message || String(e))) }
  const resolvedUrl = interpolateEnv(rawUrl, env, 'url')
  for (const v of Object.values(resolvedHeaders)) secrets.push(v)
  if (resolvedUrl !== rawUrl) secrets.push(resolvedUrl)

  let sessionId = null
  let calls = 0
  const inflight = new Set()   // 在途 AbortController：close 时要能真正断开连接

  const session = createJsonRpcSession({ name, timeoutMs, onLog, send: (msg, opts) => send(msg, opts) })

  /** 单条消息的发送：POST 到唯一端点，响应按 content-type 分派（JSON 或 SSE 流） */
  async function send(msg, opts = {}) {
    const ctrl = new AbortController()
    inflight.add(ctrl)
    const outer = opts?.signal
    const onOuterAbort = () => ctrl.abort()
    if (outer) {
      if (outer.aborted) ctrl.abort()
      else outer.addEventListener('abort', onOuterAbort, { once: true })
    }
    // 会话核心会在 timeoutMs 时 reject 请求，但 reject 并不会断开底层连接，
    // 所以这里额外挂一个略晚的定时器做 abort —— 既保证错误文案是"超时"（确定性），
    // 又保证连接真的被释放（否则会慢慢积压成句柄泄漏）。
    const killer = setTimeout(() => ctrl.abort(), timeoutMs + 50)
    try {
      const hdrs = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...resolvedHeaders,
      }
      if (sessionId) hdrs['mcp-session-id'] = sessionId
      const res = await fetch(resolvedUrl, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify(msg),
        redirect: 'error',    // 见文件头安全红线
        signal: ctrl.signal,
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) sessionId = sid

      // 通知（无 id）：服务器通常回 202 空体；不做 JSON 解析
      if (msg.id === undefined || msg.id === null) {
        if (!res.ok) log('warn', `MCP ${name} 通知 ${msg.method} 返回 HTTP ${res.status}（已忽略）`)
        try { await res.arrayBuffer() } catch { /* 通知的体不重要 */ }
        return
      }
      if (!res.ok) {
        const snippet = redact(await readSnippet(res))
        if (res.status === 404) {
          // 404 在 Streamable HTTP 里特指"会话不存在/已过期"，与"地址写错"是两回事：
          // 分开表述，用户才知道该去改地址还是重新连接。
          throw new Error(`MCP 服务器 ${name} 会话已过期或地址不存在（HTTP 404）${snippet ? `：${snippet}` : ''}`)
        }
        throw new Error(`MCP 服务器 ${name} 返回 HTTP ${res.status}${snippet ? `：${snippet}` : ''}`)
      }
      const ct = String(res.headers.get('content-type') || '')
      if (ct.includes('text/event-stream')) { await readSseStream(res, msg.id) } else {
        let data
        try { data = await res.json() } catch (e) {
          throw new Error(`MCP 服务器 ${name} 的响应不是合法 JSON（${redact(e?.message || String(e))}）`)
        }
        session.handleMessage(data)
      }
    } catch (e) {
      // 传输层错误统一脱敏后再上抛：这条消息可能进入工具结果并显示在对话里
      throw new Error(redact(e?.message || String(e)))
    } finally {
      clearTimeout(killer)
      inflight.delete(ctrl)
      if (outer) outer.removeEventListener('abort', onOuterAbort)
    }
  }

  /**
   * 读取 SSE 响应直到**本次请求**的应答到达。
   * 关键：真实服务器常常不主动关闭这条流，因此绝不能"读到流结束"——
   * 拿到自己的应答就立刻停止并释放连接，否则会永久挂住。
   */
  async function readSseStream(res, wantedId) {
    if (!res.body) throw new Error(`MCP 服务器 ${name} 的 SSE 响应没有可读流`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let dataLines = []
    let done = false
    const flush = () => {
      if (!dataLines.length) return false
      const payload = dataLines.join('\n')
      dataLines = []
      let obj
      try { obj = JSON.parse(payload) } catch {
        log('warn', `MCP ${name} 收到无法解析的 SSE data（已忽略）`)
        return false
      }
      const handled = session.handleMessage(obj)
      return handled && obj.id === wantedId
    }
    try {
      while (!done) {
        const { value, done: end } = await reader.read()
        if (end) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (line === '') { if (flush()) { done = true; break } continue }  // 空行 = 一个事件结束
          if (line.startsWith(':')) continue                                  // 注释/心跳行
          // data: 可多行（用换行拼接为一个事件的负载）；event:/id:/retry: 对本客户端无意义
          if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (!done) flush()   // 流直接结束（没有以空行收尾）时补一次
    } finally {
      try { await reader.cancel() } catch { /* 连接已释放 */ }
    }
  }

  // —— 握手：initialize → notifications/initialized ——
  const init = await session.request('initialize', {
    protocolVersion: MCP_HTTP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  })
  // 通知不产生应答；个别服务器对未知通知回 4xx，不该因此判定整个连接失败 ⇒ 只记日志。
  // 必须 catch：否则会变成 unhandled rejection 打到内核进程上。
  Promise.resolve(session.notify('notifications/initialized')).catch((e) => {
    log('debug', `MCP ${name} initialized 通知发送失败（已忽略）：${redact(e?.message || String(e))}`)
  })

  let toolsCache = null
  return {
    name,
    url: resolvedUrl === rawUrl ? rawUrl : '[已隐藏]',
    protocolVersion: init?.protocolVersion || null,
    serverInfo: init?.serverInfo || null,
    async tools() {
      if (toolsCache) return toolsCache
      const r = await session.request('tools/list', {})
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
      const r = await session.request('tools/call', { name: tool, arguments: argsObj || {} }, opts)
      return { text: contentToText(r), isError: r?.isError === true, raw: r }
    },
    // 同步关闭：注册表的 closeAll() 是同步遍历（内核退出路径），异步 close 会留下
    // 未处理的 rejection。这里的两步（中止在途请求、收尾会话）本身就无需等待。
    close() {
      for (const c of inflight) { try { c.abort() } catch { /* 已断开 */ } }
      inflight.clear()
      session.closeWith(new Error(`MCP 服务器 ${name} 已关闭`), 'close')
    },
    stats() {
      const s = session.stats()
      return { pending: s.pending, closed: s.closed, calls, errors: s.errors, lastStderr: [] }
    },
  }
}
