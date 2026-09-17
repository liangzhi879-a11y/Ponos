// server/mcp-routes.mjs —— MCP 配置的 HTTP 面（2026-09-15，P1-6「MCP 配置界面」）。
//
// 与 `server/disabled-routes.mjs` 同款：**纯 handler**（`{status, body}` 或 `null`），
// 不写在 bridge 的内联分支里。理由取自本仓库既有纪律（见 `server/knowledge-routes.mjs` 头注）：
// 测试**不得起 bridge、不得起内核子进程**——bridge 在 import 期就会扫真实 home。
//
// 落点 = `<configDir>/mcp.json`，与内核读的**同一个文件**（内核 `configDir` = 桥的 `YFW_HOME`，
// 而 `YFW_HOME` 就是内核子进程的 `PONOS_CONFIG_DIR`，bridge.mjs 的 disabled 分支已写明）。
// 故这里是"写"、内核是"读"，中间没有 spawn 透传参数——这也是不用命令行参数做 MCP 配置的理由：
// 少一条会静默失效的链路（本仓库已有 `--spaces`/`--confirm` 两次"漏登记被静默忽略"的前车之鉴）。
//
// 三态区分（关键设计）：**400 = 用户给的数据不合规**（磁盘不动，GUI 应把 error 显示在输入框旁），
// **500 = 磁盘 IO 失败**（数据合规但没写下去），**200 + ok:false = 正常业务结果**
// （如"测试连接失败"——服务器连不上是家常便饭，不该以 5xx 让 GUI 走进错误分支）。
//
// 第二批（2026-09-16，resources/prompts）：新增 `GET /mcp/prompts`（列出各**启用中**服务器的
// prompt 模板及参数声明）与 `POST /mcp/prompts/get`（渲染一个模板为文本）。
// 为什么走**本模块自行连接**、而不是读内核的 `promptsSnapshot()`：
//   ① 桥侧只有 `getMcpStatus`（内核 `snapshot()` 的线上形状），它**刻意不含 prompts**
//      ——D-4 要求 prompts 与"工具/状态"这条通道分开，塞进去下一个人就会顺手渲染成工具；
//   ② 该快照在内核未启动时为 null（面板会显示"内核尚未启动"），而"看 prompt 模板"这件事
//      不该依赖"有没有一轮对话已经跑过"；
//   ③ `GET /mcp`、`POST /mcp/test` 本来就是这个形状（纯 handler 自己读 mcp.json 再自行连接），
//      沿用同一范式就不必为 prompts 单造一条会静默失效的链路（本仓库已两次踩过"漏登记被忽略"）。
// 三条纪律与 /mcp/test 完全一致：`enabled:false` 的**绝不连接**、逐台 try/catch（一台失败不影响其它）、
// 无论成败都在 finally 里 `close()` 回收（stdio 半启动会留子进程，HTTP 会留未关闭会话）。
import { join } from 'node:path'
import { startMcpClient, normalizeMcpServers, readMcpServers, writeMcpServers, mcpConfigSig } from '../kernel/mcp.mjs'
import { startMcpHttpClient } from '../kernel/mcp-http.mjs'

// /mcp/test 的超时：探测是**用户在前面等**的交互动作，不能沿用内核默认 20s；
// 上限 15000ms 是防呆——用户填 300000 会让请求挂死、GUI 转圈到用户以为界面卡了。
const PROBE_DEFAULT_TIMEOUT_MS = 8000
const PROBE_MAX_TIMEOUT_MS = 15000

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const errText = (e) => e?.message || String(e)
const json = (status, body) => ({ status, body })

/**
 * 按配置分派传输并完成握手（`/mcp/test`、`/mcp/prompts`、`/mcp/prompts/get` 三处共用一份）。
 *
 * 抽出来的理由：这三处若各写一遍"url ? HTTP : stdio + 超时归一"，就会出现**超时上限只改了一处**
 * 这类偏差——而超时正是本文件最容易伤到用户的地方（面板是**用户在前面等**的交互动作）。
 * `timeoutMs` 一律**夹在上限内**：用户填 300000 会让请求挂死、GUI 转圈到用户以为界面卡了。
 */
async function connectMcpServer(name, cfg) {
  const asked = Number(cfg?.timeoutMs)
  const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(PROBE_MAX_TIMEOUT_MS, asked) : PROBE_DEFAULT_TIMEOUT_MS
  return cfg?.url
    ? await startMcpHttpClient({ name, url: cfg.url, headers: cfg.headers, timeoutMs })
    : await startMcpClient({ name, ...cfg, timeoutMs })
}

/**
 * 处理 `/mcp`、`/mcp/test` 与 `/mcp/status`。
 * @param {{method:string, pathname:string, readJsonBody:() => Promise<any>, configDir:string,
 *          getMcpStatus?:() => object|null}} ctx
 *   `getMcpStatus` 由 bridge 注入，返回**最近一次内核上报**的接入状态快照（可为 null）。
 * @returns {Promise<{status:number, body:object} | null>} 未匹配返回 `null`（交给后续路由）
 */
export async function handleMcpRoute(ctx) {
  const { method, pathname, readJsonBody, configDir, getMcpStatus } = ctx || {}
  // 先判"方法+路径"再判方法内部逻辑：不支持的方法（如 DELETE /mcp）必须返回 null 交给后续路由，
  // 否则一个 500 会把本该走别的路由的请求吞掉。
  const wantGet = pathname === '/mcp' && method === 'GET'
  const wantPut = pathname === '/mcp' && method === 'PUT'
  const wantTest = pathname === '/mcp/test' && method === 'POST'
  const wantStatus = pathname === '/mcp/status' && method === 'GET'
  const wantPrompts = pathname === '/mcp/prompts' && method === 'GET'
  const wantPromptGet = pathname === '/mcp/prompts/get' && method === 'POST'
  if (!wantGet && !wantPut && !wantTest && !wantStatus && !wantPrompts && !wantPromptGet) return null
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

  // ---- GET /mcp/status：内核**真实接入状态**（面板顶部的"全局真值"）----
  // 面板里的连接测试（/mcp/test）只能说明"这台此刻连得上"，本端点回答的是
  // "内核已经把它接进 AI 的工具表了吗"——两者混为一谈就会出现"添加成功却找不到调用入口"。
  if (wantStatus) {
    const cur = readMcpServers(configPath)
    const sig = cur.ok ? mcpConfigSig(cur.servers) : null
    // 内核是**每会话一进程**，而面板是全局的 ⇒ 返回"最近一次上报"即可：
    // snapshot().servers[].tools 是该服务器实际发现的**全部**工具（发现阶段不做可见性过滤），
    // 而所有内核都读同一个 mcp.json、连同一批服务器 ⇒ 各会话的发现结果必然相同。
    // 随 agent 变化的只是"谁看得见"，那是**配置维度**的信息（面板按 expose 展示），
    // 不是需要实时查询的运行时状态。故无须按会话聚合、也不必让用户先选会话。
    let kernel = null
    try { kernel = typeof getMcpStatus === 'function' ? (getMcpStatus() || null) : null }
    catch { kernel = null }   // 诊断接口自身出错不该让面板拿不到配置信息
    const stale = !!(kernel && kernel.configSig && sig && kernel.configSig !== sig)
    return json(200, {
      ok: cur.ok === true,
      ...(cur.ok ? {} : { error: cur.error }),
      config: { path: configPath, sig },
      kernel,
      stale,
    })
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
    // 超时归一（含上限夹取）在 `connectMcpServer` 内，三处共用一份，不在此重复。

    let client = null
    try {
      // 名字固定为 probe：它只出现在日志/错误文案里，不参与工具命名（这个连接用完即弃）
      // 按 cfg.url 分派：远程 HTTP 走 Streamable HTTP 客户端，本地走 stdio 子进程。
      // 两种客户端都在 start 内完成握手且失败即 reject ⇒ 下面的 catch/finally 无需分支。
      client = await connectMcpServer('probe', cfg)
      const tools = await client.tools()
      return json(200, {
        ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        serverInfo: client.serverInfo,
      })
    } catch (e) {
      // 连不上（命令不存在、URL 不可达、握手失败、超时、环境变量未定义）是**正常业务结果**：
      // 200 + ok:false，界面照原样展示原因。探测失败不该让 GUI 走进 5xx 的错误分支。
      return json(200, { ok: false, error: errText(e) })
    } finally {
      // 无论成败都必须回收：探测失败的服务器常留下**半启动的子进程**（stdio）
      // 或**未关闭的会话**（HTTP），不 close 就会在用户反复点"测试"时累积泄漏。
      try { client?.close() } catch { /* 已退出 */ }
    }
  }

  // ---- GET /mcp/prompts：列出各**启用中**服务器的 prompt 模板（含参数声明）----
  //
  // 为什么不复用 /mcp/status 的内核快照：见文件头注（prompts 与"状态/工具"刻意分开，
  // 且本端点不该依赖"内核已启动"）。返回形状与内核 `promptsSnapshot()` 对齐
  // （`servers[name] = { prompts, expose }` + `errors`），使两处可互换。
  if (wantPrompts) {
    const cur = readMcpServers(configPath)
    // 文件读不出来 ⇒ 200 + ok:false（与 GET /mcp 同一口径）：这是"读不出来"的**报告**，
    // 不是请求错误；界面要能把原因画出来，而不是撞 5xx 后只剩一句"加载失败"。
    if (!cur.ok) return json(200, { ok: false, error: cur.error, configPath, servers: {}, errors: {}, disabled: [] })
    const entries = Object.entries(cur.servers)
    // 关闭的服务器**绝不连接**（用户关掉它是为了"别再起进程/发请求"），但要在响应里列名，
    // 否则界面上"这台为什么没有 prompts"会变成一个查不出来的谜。
    const disabled = entries.filter(([, c]) => c.enabled === false).map(([n]) => n)
    const enabled = entries.filter(([, c]) => c.enabled !== false)
    const servers = {}
    const errors = {}
    // 并发（内核侧启动也是并发）：一台慢不会拖住另一台；单台失败只记进 errors，
    // **不影响**其它台的清单，也不影响整体 ok —— "这台没提供 prompts"是常态，不是故障。
    await Promise.all(enabled.map(async ([name, cfg]) => {
      let client = null
      try {
        client = await connectMcpServer(name, cfg)
        servers[name] = {
          prompts: await client.prompts(),
          // 与内核快照同字段：面板据此把"有 prompt"与"谁能用"分成两维展示
          expose: cfg.expose?.mode || 'public',
        }
      } catch (e) {
        errors[name] = errText(e)
      } finally {
        try { client?.close() } catch { /* 已退出 */ }
      }
    }))
    return json(200, { ok: true, configPath, servers, errors, disabled })
  }

  // ---- POST /mcp/prompts/get：把选中模板渲染成文本，**交给用户**（D-4：不自动发送）----
  //
  // 400 的判据全部是**本地可判定**的（不碰服务器）：请求体形状、`server` 是否在配置里。
  // 刻意**不**在这里校验"prompt 声明的必填参数是否齐"：那需要先向服务器取声明（多一次往返，
  // 且服务器不实现 prompts/list 时会误判成"参数缺失"），而"缺参数"本就该由**服务器**判
  //（它会回 -32602）—— 服务器报错属正常业务结果 ⇒ 200 + ok:false，与"连不上"同类。
  // 界面侧另有 `promptArgsOf` 在点"渲染"之前就拦下缺失的必填项（那是 UX，不是契约）。
  if (wantPromptGet) {
    let body
    try {
      body = await readJsonBody()
    } catch (e) {
      return json(400, { ok: false, error: `请求体不是合法 JSON：${errText(e)}` })
    }
    if (!isPlainObject(body)) return json(400, { ok: false, error: '请求体必须是 JSON 对象' })
    const serverName = typeof body.server === 'string' ? body.server.trim() : ''
    if (!serverName) return json(400, { ok: false, error: '请求体需要 { server: "<服务器名>", name: "<prompt 名>", arguments: {...} }' })
    const promptName = typeof body.name === 'string' ? body.name.trim() : ''
    if (!promptName) return json(400, { ok: false, error: '请求体缺少 prompt 名称（name）' })
    if (body.arguments !== undefined && body.arguments !== null && !isPlainObject(body.arguments)) {
      return json(400, { ok: false, error: 'arguments 必须是 { "<参数名>": "<值>" } 对象' })
    }
    // 参数值统一成字符串（MCP 契约里就是字符串）：界面表单里数字/布尔都可能出现，
    // 这里**不做**静默丢弃 —— 空串照发，由服务器决定它算不算"没填"（stub 就把 '' 当缺失）。
    const args = {}
    for (const [k, v] of Object.entries(body.arguments || {})) {
      if (v === undefined || v === null) continue
      args[k] = typeof v === 'string' ? v : String(v)
    }

    const cur = readMcpServers(configPath)
    // 配置读不出来 ⇒ 500：与上面两条 400 的区别是"用户的请求没毛病，是磁盘读不了"，
    // 混成同一个码，用户就不知道自己该改输入还是修文件。
    if (!cur.ok) return json(500, { ok: false, error: cur.error })
    const cfg = cur.servers[serverName]
    if (!cfg) return json(400, { ok: false, error: `没有名为「${serverName}」的服务器（请先保存配置）` })
    // 关闭的服务器不连接 ⇒ 这是**业务结果**（配置合法、用户自己的选择），不是数据不合规
    if (cfg.enabled === false) return json(200, { ok: false, error: `服务器「${serverName}」已关闭，不会连接` })

    let client = null
    try {
      client = await connectMcpServer(serverName, cfg)
      const r = await client.getPrompt(promptName, args)
      return json(200, { ok: true, text: r.text, description: r.description, messageCount: r.messageCount })
    } catch (e) {
      // 连不上 / prompt 不存在 / 服务器嫌参数不齐 —— 全是正常业务结果，界面照原样展示原因
      return json(200, { ok: false, error: errText(e) })
    } finally {
      try { client?.close() } catch { /* 已退出 */ }
    }
  }

  return null
}
