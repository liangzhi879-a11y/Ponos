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
import { readFileSync, existsSync } from 'node:fs'

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
 * 读 MCP 服务器配置：{ "servers": { "<name>": { command, args?, env?, cwd?, timeoutMs? } } }
 * - 文件不存在 → {}（**默认零行为变化**：没配置 MCP 的用户与从前完全一致）
 * - JSON 损坏 / 结构不对 → **抛出**（由注册表捕获并记日志，不让内核启动失败）
 */
export function loadMcpServers(configPath) {
  if (!configPath || !existsSync(configPath)) return {}
  const data = JSON.parse(readFileSync(configPath, 'utf-8'))
  const servers = data && typeof data === 'object' ? data.servers : null
  if (!servers || typeof servers !== 'object') return {}
  const out = {}
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    const command = String(cfg.command || '').trim()
    if (!command) continue // 无命令的条目直接忽略（宁可少一个工具，不要半个坏服务器）
    out[name] = {
      command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
      cwd: cfg.cwd ? String(cfg.cwd) : null,
      timeoutMs: Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_MCP_TIMEOUT_MS,
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

  let closed = false
  let closerTimer                 // 关闭时清理（声明在前，避免 closeWith 的 TDZ）
  let nextId = 0
  const pending = new Map()     // id → { resolve, reject }
  const stderrLines = []
  let calls = 0
  let errors = 0
  let toolsCache = null

  const rejectAll = (err) => {
    for (const [, p] of pending) { try { p.reject(err) } catch { /* 已 settle */ } }
    pending.clear()
  }

  const closeWith = (err, why) => {
    if (closed) return
    closed = true
    if (closerTimer) { clearTimeout(closerTimer); closerTimer = undefined }
    log('warn', `MCP 服务器 ${name} 已关闭（${why}）`)
    rejectAll(err || new Error(`MCP 服务器 ${name} 已关闭`))
  }

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
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) {
          errors++
          const e = new Error(`MCP ${name} 返回错误: ${msg.error.message || JSON.stringify(msg.error)}`)
          e.mcpError = msg.error
          p.reject(e)
        } else p.resolve(msg.result)
      }
      // 无 id 的通知（如 notifications/message）不参与请求应答，忽略
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
  child.on('error', (e) => closeWith(new Error(`MCP 服务器 ${name} 启动/运行失败: ${e.message}`), 'error'))
  child.on('exit', (code, sig) => closeWith(new Error(`MCP 服务器 ${name} 已退出（code=${code}${sig ? `, signal=${sig}` : ''}）`), 'exit'))
  child.stdin.on('error', () => closeWith(new Error(`MCP 服务器 ${name} stdin 断流`), 'stdin'))

  const writeMsg = (obj) => {
    try {
      child.stdin.write(JSON.stringify(obj) + '\n')
      return true
    } catch (e) {
      closeWith(new Error(`MCP 服务器 ${name} 写入失败: ${e.message}`), 'write')
      return false
    }
  }

  function request(method, params, { signal, timeoutMs: tmo } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error(`MCP 服务器 ${name} 已关闭`))
      if (signal?.aborted) return reject(new Error('已取消'))
      const ms = tmo || timeoutMs
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        errors++
        reject(new Error(`MCP ${name} ${method} 超时（${ms}ms）`))
      }, ms)
      timer.unref?.()
      const onAbort = () => {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error('已取消'))
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v) },
        reject: (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e) },
      })
      const msg = { jsonrpc: '2.0', id, method }
      if (params !== undefined) msg.params = params
      if (!writeMsg(msg)) { pending.delete(id); clearTimeout(timer); /* closeWith 已 rejectAll */ }
    })
  }

  const notify = (method, params) => {
    const msg = { jsonrpc: '2.0', method }
    if (params !== undefined) msg.params = params
    writeMsg(msg)
  }

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
      closeWith(new Error(`MCP 服务器 ${name} 已关闭`), 'close')
    },
    stats() {
      return { pending: pending.size, closed, calls, errors, lastStderr: stderrLines.slice(-5) }
    },
  }
}
