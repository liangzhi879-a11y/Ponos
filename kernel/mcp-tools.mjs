// MCP 工具接入层（P1-5）——把 MCP 服务器发现到的工具，接到内核的动态工具视图上。
// ---------------------------------------------------------------------------
// 契约（实读 kernel/tools.mjs:1836-1890 确认，**与 spec 初稿的"数组"写法不同，以代码为准**）：
//   · 动态视图是**对象**：{ [toolName]: { description, input_schema, run(input, ctx) } }
//   · 视图函数在「每迭代 + 每次工具调用」各求值一次，且 **必须是同步的**（toolSchemas 直接调用）
//   · run() 返回归一化 { content, isError }；抛异常也会被 tools.mjs 兜成错误结果
// 因此本模块的关键设计：**同步视图 + 异步预热**
//   view() 永不阻塞（首次调用只触发后台启动，先返回空对象），启动完成后填充缓存，
//   下一迭代模型即可看到 MCP 工具。这样"没配 MCP 的用户"零影响、"配了的用户"最多晚一轮出现。
import { join } from 'node:path'
import { resolveConfigDir } from './config.mjs'
import { loadMcpServers, startMcpClient, mcpToolName } from './mcp.mjs'
import { startMcpHttpClient } from './mcp-http.mjs'
import { mcpVisibilityOf, mcpConfigSig } from './mcp.mjs'

/** MCP 配置文件位置：<configDir>/mcp.json（沿用内核既有配置目录约定） */
export function mcpConfigPath(env = process.env) {
  return join(resolveConfigDir(env), 'mcp.json')
}

/**
 * 创建 MCP 注册表（惰性启动 + 按 agentId 组装视图）。
 * @param {{ configPath?: string, log?: (level:string, msg:string)=>void }} opts
 */
export function createMcpRegistry({ configPath, log = () => {} } = {}) {
  const path = configPath || mcpConfigPath()
  const warn = (m) => { try { log('warn', m) } catch { /* 日志失败不影响工具 */ } }

  let startPromise = null       // 启动 + 首次发现的进行中 promise（供 ready() 等待/测试用）
  const clients = []            // [{ name, client }]
  const failures = new Map()    // name → 失败原因（诊断用）
  const disabled = []           // 配置里 enabled:false 的服务器名（**不连接**）
  const cfgByName = new Map()   // name → 归一化条目（可见性判定的依据）
  const toolKeysByServer = new Map()  // name → [工具全名]（该服务器**实际发现的全部**工具）
  const entriesByKey = new Map()      // 工具全名 → 视图条目
  // 资源清单：**尽力而为**缓存（能力可选；"不支持"不是故障，故不进 failures）
  const resourcesByServer = new Map() // name → { items, total, truncated, templatesFailed }
  // prompt 清单：**绝不进 entriesByKey / view()**（spec D-4：user-controlled，不是模型可自选的能力）
  const promptsByServer = new Map()   // name → 归一化 prompt 清单
  const promptErrors = new Map()      // name → prompts/list 失败原因（含"该服务器不提供 prompts"）
  let configSig = ''            // 本次加载所用配置的内容签名（桥据此判断内核是否落后）

  /** 资源清单 → 文本（含**截断标注**：模型必须知道"这不是全部"，否则会基于残清单下结论） */
  function renderResourceList(r) {
    const lines = (r?.items || []).map((x) => {
      const parts = [`- ${x.uri}`]
      if (x.name) parts.push(`（${x.name}）`)
      if (x.mimeType) parts.push(` [${x.mimeType}]`)
      if (x.isTemplate) parts.push(' [模板]')
      return parts.join('')
    })
    if (r?.truncated) {
      lines.push(`[清单已截断：共 ${r.total} 条，此处仅列出前 ${r.items.length} 条，还有 ${r.total - r.items.length} 条未列出]`)
    }
    return lines.length ? lines.join('\n') : '（该服务器没有资源）'
  }

  /** 静态描述文案（写成常量便于测试与用户文档引用同一份，不散落） */
  const LIST_RESOURCES_DESC = '列出该 MCP 服务器上的资源清单（只读；模板以 uriTemplate 形式列出）'
  const READ_RESOURCE_DESC = '读取该 MCP 服务器上的一个资源（只读；二进制资源只返回元信息，超长内容会被截断）'

  /** 把发现的工具（+ 固定的两个资源工具）转成视图条目 */
  function toolEntries(name, client, list) {
    const out = list.map((t) => ({
      key: mcpToolName(name, t.name),
      entry: {
        // 来源标注：让用户与模型都能看出这是外部工具（审批走 approval-mode 的 unknown 档）
        description: `[MCP:${name}] ${t.description || t.name}`,
        input_schema: t.input_schema,
        // 外部工具可能有副作用，按"写/执行类"处理（串行，不参与并发批次）
        concurrencySafe: false,
        run: async (input, ctx) => {
          try {
            const r = await client.call(t.name, input || {}, { signal: ctx?.signal })
            return { content: r.text, isError: r.isError === true }
          } catch (e) {
            // 铁律：任何异常都不向上抛（tools.mjs 也会兜，但这里给出更有信息量的文案）
            return { content: `MCP 工具错误（${name}/${t.name}）：${e?.message || String(e)}`, isError: true }
          }
        },
      },
    }))
    // —— 以下两个是**固定存在**的资源工具（spec D-2）——
    // 为什么做成工具而不是"开会话就把资源塞进上下文"：MCP 规范把 resources 定为
    // *application-driven*，由宿主决定何时读。本仓库没有长驻宿主 GUI 替模型决定，
    // 内核就是 agent，工具视图是它唯一的出口 ⇒ 让模型**按需拉取**，避免必然爆上下文的做法。
    // 副作用（也是刻意）：它们与其它 MCP 工具一样 `concurrencySafe:false`（未知风险档）——
    // `read_resource` 能读到服务器端任意已暴露文件，比普通工具更需要把关。
    out.push({
      key: mcpToolName(name, 'list_resources'),
      entry: {
        description: `[MCP:${name}] ${LIST_RESOURCES_DESC}`,
        input_schema: { type: 'object', properties: {} },
        concurrencySafe: false,
        run: async (input, ctx) => {
          try {
            const r = await client.resources({ signal: ctx?.signal })
            return { content: renderResourceList(r), isError: false }
          } catch (e) {
            return { content: `MCP 工具错误（${name}/list_resources）：${e?.message || String(e)}`, isError: true }
          }
        },
      },
    })
    out.push({
      key: mcpToolName(name, 'read_resource'),
      entry: {
        description: `[MCP:${name}] ${READ_RESOURCE_DESC}`,
        input_schema: {
          type: 'object',
          properties: { uri: { type: 'string', description: '资源 URI（来自 list_resources 的清单）' } },
          required: ['uri'],
        },
        concurrencySafe: false,
        run: async (input, ctx) => {
          try {
            const r = await client.readResource(input?.uri, { signal: ctx?.signal })
            return { content: r.text, isError: r.isError === true }
          } catch (e) {
            return { content: `MCP 工具错误（${name}/read_resource）：${e?.message || String(e)}`, isError: true }
          }
        },
      },
    })
    return out
  }

  /** 启动全部启用的服务器并发现工具；单个失败只记日志，不影响其它（也不影响内核） */
  async function boot() {
    let cfg = {}
    try {
      cfg = loadMcpServers(path)
    } catch (e) {
      warn(`MCP 配置解析失败，已跳过：${e?.message || String(e)}`)
      return
    }
    const all = Object.entries(cfg)
    if (!all.length) { configSig = mcpConfigSig(cfg); return } // 未配置 ⇒ 视图保持空对象（既有行为零变化）
    // 签名基于**归一化后的内容**：键序、空白差异不会触发内核重放，只有真变化才触发
    configSig = mcpConfigSig(cfg)

    // 先分流：关闭的服务器**根本不连接**（不 spawn 子进程、不发 HTTP 请求）。
    // 这是"完全由用户控制是否开启"的硬性含义 —— 若只是"连上但不注册"，
    // 用户以为停用了，实际进程照起、凭据照发，那就不叫关闭。
    const active = []
    for (const [name, c] of all) {
      cfgByName.set(name, c)
      if (c.enabled === false) { disabled.push(name); continue }
      active.push([name, c])
    }
    if (!active.length) {
      try { log('info', `MCP 全部服务器已关闭（${disabled.length} 个，均未连接）`) } catch { /* noop */ }
      return
    }

    const results = await Promise.allSettled(active.map(async ([name, c]) => {
      // 按配置自动选传输：有 url 走 Streamable HTTP，否则走 stdio 子进程。
      // 两种客户端返回形状一致（都已在该步内完成握手），故取值处无需再分支；
      // 失败一律 reject ⇒ 由下面的 fulfilled 判定统一记入 failures（故障隔离语义不变）。
      const client = c.url
        ? await startMcpHttpClient({ name, url: c.url, headers: c.headers, timeoutMs: c.timeoutMs, onLog: log })
        : await startMcpClient({ name, ...c, onLog: log })
      return { name, client }
    }))
    for (let i = 0; i < results.length; i++) {
      const [name] = active[i]
      const r = results[i]
      if (r.status !== 'fulfilled') {
        failures.set(name, r.reason?.message || String(r.reason))
        warn(`MCP 服务器 ${name} 启动失败：${failures.get(name)}`)
        continue
      }
      clients.push(r.value)
      try {
        // 注意：r.value 是 { name, client } 包装（closeAll 依赖此形状），
        // 而下面需要**真客户端**——首版误传包装对象，导致 client.tools 不是函数、
        // 异常被 catch 吞成"工具列表获取失败"，表现为视图恒空。
        const client = r.value.client
        // 三类能力**并行**取：JSON-RPC 按 id 多路复用，并行是安全的。
        // 串行会让"某台服务器对未知 method 不回包"的坏情况把启动等待累加三倍
        // （本仓库的 stub 就有 hang 形态，真实服务器也可能这样）。
        const [toolsR, resR, promptsR] = await Promise.allSettled([
          client.tools(), client.resources(), client.prompts(),
        ])
        // 工具列表失败仍按**故障**处理（保持既有语义：记 failures + 警告）
        if (toolsR.status !== 'fulfilled') throw toolsR.reason
        const keys = []
        for (const { key, entry } of toolEntries(name, client, toolsR.value)) { entriesByKey.set(key, entry); keys.push(key) }
        toolKeysByServer.set(name, keys)
        // resources / prompts 是**可选能力**：拿不到只记日志，不算故障
        // （大多数只做 tools 的服务器都会对这两个 method 回 -32601，那不是错误）
        if (resR.status === 'fulfilled') resourcesByServer.set(name, resR.value)
        else try { log('info', `MCP 服务器 ${name} 无资源清单（${resR.reason?.message || String(resR.reason)}）`) } catch { /* noop */ }
        if (promptsR.status === 'fulfilled') promptsByServer.set(name, promptsR.value)
        else {
          promptErrors.set(name, promptsR.reason?.message || String(promptsR.reason))
          try { log('info', `MCP 服务器 ${name} 无 prompts（${promptErrors.get(name)}）`) } catch { /* noop */ }
        }
      } catch (e) {
        failures.set(name, e?.message || String(e))
        warn(`MCP 服务器 ${name} 工具列表获取失败：${failures.get(name)}`)
      }
    }
    const n = entriesByKey.size
    if (n) try { log('info', `MCP 已接入 ${clients.length} 个服务器、${n} 个工具`) } catch { /* noop */ }
  }

  const kickoff = () => {
    if (!startPromise) startPromise = boot().catch((e) => warn(`MCP 初始化异常：${e?.message || String(e)}`))
    return startPromise
  }

  return {
    /**
     * 同步视图（绝不阻塞）：首次调用触发后台启动，尚未就绪时返回空对象。
     *
     * 与改造前的差别：不再返回一次性扁平缓存，而是**按 agentId 实时组装**。
     * 理由：工具表里"哪些可见"随 agent 变（bound 只对列出的 agent 可见），
     * 而一个内核进程只服务一个 agent，故按 agentId 过滤的成本只是少量对象展开，
     * 远低于每迭代调用它的既有开销；换来的是不必为每个 agent 各存一份缓存。
     */
    view({ agentId = null } = {}) {
      kickoff()
      const out = {}
      for (const [name, keys] of toolKeysByServer) {
        // 授权过滤（关闭的服务器压根没进 toolKeysByServer，故这里只需判 private/bound）
        if (mcpVisibilityOf(cfgByName.get(name), agentId) === null) continue
        for (const k of keys) {
          const e = entriesByKey.get(k)
          if (e) out[k] = e
        }
      }
      return out
    },
    /** 等待就绪（首轮预热完成）；测试与"启动即用"场景使用 */
    ready() { return kickoff() },
    /** 已发现的工具名（诊断用） */
    toolNames() { return [...entriesByKey.keys()] },
    /** 启动失败的服务器（诊断用） */
    failedServers() { return Object.fromEntries(failures) },
    /**
     * 面板用的**真实接入状态**快照。
     *
     * `servers[name].tools` 是该服务器**实际发现的全部工具**（不做可见性过滤）——
     * 面板要能展示"台子上有什么"，而"谁看得见"由 `expose` 单独表达，两者是不同的维度。
     * 这也正是它与面板里"连接测试"的区别：测试只说明"这台连得上"，
     * 而这份快照说明"内核已经把它接进 AI 的工具表了"。
     */
    snapshot() {
      const servers = {}
      for (const [name, keys] of toolKeysByServer) {
        servers[name] = {
          tools: [...keys],
          expose: cfgByName.get(name)?.expose?.mode || 'public',
          // 资源条数（面板可显示"这台有多少资源"）；`null` = 该服务器不提供资源清单
          // （能力可选，不区分"不支持"与"取失败"——两者对用户是同一件事：现在没有清单可看）
          resources: resourcesByServer.get(name)?.total ?? null,
        }
      }
      return {
        servers,
        failed: Object.fromEntries(failures),
        disabled: [...disabled],
        configSig,
      }
    },
    /**
     * 供桥/设置面板取用的 **prompt 清单**（**与工具视图完全分离**）。
     *
     * 为什么单独一个方法而不是塞进 `snapshot()`：prompts 是 *user-controlled* 的能力，
     * 它既不能出现在 `view()` 里（模型不得自主调用），也不该被面板当成"工具"展示。
     * 独立的取值口是让这条界线**在类型层面**也看得见——顺手塞进 snapshot 的 servers 里，
     * 下一个人很容易就把它和 tools 一起渲染出去。
     * `errors` 记录取不到清单的服务器（**多数是"该服务器不提供 prompts"**，属正常情况，
     * 不是故障；故不进 `failed`）。
     * @returns {{servers:Object<string,{prompts:Array, expose:string}>, errors:Object<string,string>}}
     */
    promptsSnapshot() {
      const servers = {}
      for (const [name, list] of promptsByServer) {
        servers[name] = {
          // 逐层拷一份：调用方（桥/GUI）不该能改到注册表内部缓存
          prompts: list.map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments.map((a) => ({ name: a.name, description: a.description, required: a.required })),
          })),
          expose: cfgByName.get(name)?.expose?.mode || 'public',
        }
      }
      return { servers, errors: Object.fromEntries(promptErrors) }
    },
    /** 内核退出时回收所有 MCP 子进程（不回收会留下孤儿进程） */
    closeAll() {
      for (const { client } of clients) { try { client.close() } catch { /* 已退出 */ } }
      clients.length = 0
      toolKeysByServer.clear()
      entriesByKey.clear()
      resourcesByServer.clear()
      promptsByServer.clear()
      promptErrors.clear()
    },
  }
}

// 进程级兜底：内核被强制退出时尽量带走 MCP 子进程，避免孤儿。
let exitHooked = false
export function hookMcpExitCleanup(registry) {
  if (exitHooked) return
  exitHooked = true
  try { process.on('exit', () => { try { registry.closeAll() } catch { /* noop */ } }) } catch { /* noop */ }
}
