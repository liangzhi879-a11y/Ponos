// server/mcp-routes.mjs —— MCP 配置的 HTTP 面（2026-09-15，P1-6「MCP 配置界面」）。
//
// 与 `server/disabled-routes.mjs` 同款：**纯 handler**（`{status, body}` 或 `null`），
// 不写在 bridge 的内联分支里。理由取自本仓库既有纪律（见 `server/knowledge-routes.mjs` 头注）：
// 测试**不得起 bridge、不得起内核子进程**——bridge 在 import 期就会扫真实 home。
//
// 落点 = `<configDir>/mcp.json`，与内核读的**同一个文件**（内核 `configDir` = 桥的 `YFW_HOME`，
// 而 `YFW_HOME` 就是内核子进程的 `CLAUDE_CONFIG_DIR`，bridge.mjs 的 disabled 分支已写明）。
// 故这里是"写"、内核是"读"，中间没有 spawn 透传参数——这也是不用命令行参数做 MCP 配置的理由：
// 少一条会静默失效的链路（本仓库已有 `--spaces`/`--confirm` 两次"漏登记被静默忽略"的前车之鉴）。
//
// 三态区分（关键设计）：**400 = 用户给的数据不合规**（磁盘不动，GUI 应把 error 显示在输入框旁），
// **500 = 磁盘 IO 失败**（数据合规但没写下去），**200 + ok:false = 正常业务结果**
// （如"测试连接失败"——服务器连不上是家常便饭，不该以 5xx 让 GUI 走进错误分支）。
import { join } from 'node:path'
import { startMcpClient, normalizeMcpServers, readMcpServers, writeMcpServers } from '../kernel/mcp.mjs'

// /mcp/test 的超时：探测是**用户在前面等**的交互动作，不能沿用内核默认 20s；
// 上限 15000ms 是防呆——用户填 300000 会让请求挂死、GUI 转圈到用户以为界面卡了。
const PROBE_DEFAULT_TIMEOUT_MS = 8000
const PROBE_MAX_TIMEOUT_MS = 15000

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const errText = (e) => e?.message || String(e)
const json = (status, body) => ({ status, body })

/**
 * 处理 `/mcp` 与 `/mcp/test`。
 * @param {{method:string, pathname:string, readJsonBody:() => Promise<any>, configDir:string}} ctx
 * @returns {Promise<{status:number, body:object} | null>} 未匹配返回 `null`（交给后续路由）
 */
export async function handleMcpRoute(ctx) {
  const { method, pathname, readJsonBody, configDir } = ctx || {}
  // 先判"方法+路径"再判方法内部逻辑：不支持的方法（如 DELETE /mcp）必须返回 null 交给后续路由，
  // 否则一个 500 会把本该走别的路由的请求吞掉。
  const wantGet = pathname === '/mcp' && method === 'GET'
  const wantPut = pathname === '/mcp' && method === 'PUT'
  const wantTest = pathname === '/mcp/test' && method === 'POST'
  if (!wantGet && !wantPut && !wantTest) return null
  if (!configDir) return json(500, { ok: false, error: '路由未配置 configDir（无法定位 mcp.json）' })
  const configPath = join(configDir, 'mcp.json')

  // ---- GET /mcp：给界面回显当前配置 ----
  if (wantGet) {
    const cur = readMcpServers(configPath)
    // 文件坏掉时仍返回 200：界面要能把"这个文件读不出来 + 具体原因"画出来，
    // 而不是撞上 5xx 后只显示一句"加载失败"，让用户完全无法自救。
    if (!cur.ok) return json(200, { ok: false, error: cur.error, configPath, servers: {} })
    return json(200, { ok: true, configPath, servers: cur.servers })
  }

  // ---- PUT /mcp：整表替换 servers ----
  if (wantPut) {
    let body
    try {
      body = await readJsonBody()
    } catch (e) {
      return json(400, { ok: false, error: `请求体不是合法 JSON：${errText(e)}` })
    }
    if (!isPlainObject(body)) return json(400, { ok: false, error: '请求体必须是 JSON 对象' })
    // 必须显式带 servers：若允许"缺字段 = 清空"，界面的一次误发就把用户全部服务器删了
    if (!Object.prototype.hasOwnProperty.call(body, 'servers')) {
      return json(400, { ok: false, error: '请求体缺少 servers 字段' })
    }
    const norm = normalizeMcpServers(body)
    if (!norm.ok) return json(400, { ok: false, error: norm.error })
    // 校验通过才落盘；`writeMcpServers` 内部同样会再校验一次（它自己也是被别的调用方用的公共 API）
    const w = writeMcpServers(configPath, norm.servers)
    if (!w.ok) return json(500, { ok: false, error: w.error })
    return json(200, { ok: true, servers: norm.servers })
  }

  // ---- POST /mcp/test：只"试连"不落盘（用户按了"测试"按钮，还没打算保存）----
  if (wantTest) {
    let body
    try {
      body = await readJsonBody()
    } catch (e) {
      return json(400, { ok: false, error: `请求体不是合法 JSON：${errText(e)}` })
    }
    if (!isPlainObject(body) || !isPlainObject(body.server)) {
      return json(400, { ok: false, error: '请求体需要 { server: { command, ... } }' })
    }
    const norm = normalizeMcpServers({ servers: { probe: body.server } })
    if (!norm.ok) return json(400, { ok: false, error: norm.error })
    const cfg = norm.servers.probe
    const asked = Number(body.server.timeoutMs)
    const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(PROBE_MAX_TIMEOUT_MS, asked) : PROBE_DEFAULT_TIMEOUT_MS

    let client = null
    try {
      // 名字固定为 probe：它只出现在日志/错误文案里，不参与工具命名（这个连接用完即弃）
      client = await startMcpClient({ name: 'probe', ...cfg, timeoutMs })
      const tools = await client.tools()
      return json(200, {
        ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        serverInfo: client.serverInfo,
      })
    } catch (e) {
      // 连不上（命令不存在、握手失败、超时）是**正常业务结果**：200 + ok:false，界面照原样展示原因
      return json(200, { ok: false, error: errText(e) })
    } finally {
      // 无论成败都必须回收：探测失败的服务器常留下**半启动的子进程**，
      // 不 close 就会在用户反复点"测试"时堆出一批孤儿进程（本仓库有过孤儿进程的前车之鉴）。
      try { client?.close() } catch { /* 已退出 */ }
    }
  }

  return null
}
