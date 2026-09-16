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

/** MCP 配置文件位置：<configDir>/mcp.json（沿用内核既有配置目录约定） */
export function mcpConfigPath(env = process.env) {
  return join(resolveConfigDir(env), 'mcp.json')
}

/**
 * 创建 MCP 注册表（惰性启动 + 缓存视图）。
 * @param {{ configPath?: string, log?: (level:string, msg:string)=>void }} opts
 */
export function createMcpRegistry({ configPath, log = () => {} } = {}) {
  const path = configPath || mcpConfigPath()
  const warn = (m) => { try { log('warn', m) } catch { /* 日志失败不影响工具 */ } }

  let startPromise = null       // 启动 + 首次发现的进行中 promise（供 ready() 等待/测试用）
  let viewCache = null          // 已就绪的对象视图；null 表示尚未就绪
  const clients = []            // [{ name, client }]
  const failures = new Map()    // name → 失败原因（诊断用）

  /** 发现单个客户端的工具并写入视图 */
  async function collect(name, client) {
    const list = await client.tools()
    return list.map((t) => ({
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
  }

  /** 启动全部配置的服务器并发现工具；单个失败只记日志，不影响其它（也不影响内核） */
  async function boot() {
    let cfg = {}
    try {
      cfg = loadMcpServers(path)
    } catch (e) {
      warn(`MCP 配置解析失败，已跳过：${e?.message || String(e)}`)
      return
    }
    const entries = Object.entries(cfg)
    if (!entries.length) return // 未配置 ⇒ 视图保持空对象（既有行为零变化）
    const results = await Promise.allSettled(entries.map(async ([name, c]) => {
      const client = await startMcpClient({ name, ...c, onLog: log })
      return { name, client }
    }))
    const built = {}
    for (let i = 0; i < results.length; i++) {
      const [name] = entries[i]
      const r = results[i]
      if (r.status !== 'fulfilled') {
        failures.set(name, r.reason?.message || String(r.reason))
        warn(`MCP 服务器 ${name} 启动失败：${failures.get(name)}`)
        continue
      }
      clients.push(r.value)
      try {
        // 注意：r.value 是 { name, client } 包装（closeAll 依赖此形状），
        // 而 collect 需要**真客户端**——首版误传包装对象，导致 client.tools 不是函数、
        // 异常被 catch 吞成"工具列表获取失败"，表现为视图恒空。
        for (const { key, entry } of await collect(name, r.value.client)) built[key] = entry
      } catch (e) {
        failures.set(name, e?.message || String(e))
        warn(`MCP 服务器 ${name} 工具列表获取失败：${failures.get(name)}`)
      }
    }
    viewCache = built
    const n = Object.keys(built).length
    if (n) try { log('info', `MCP 已接入 ${clients.length} 个服务器、${n} 个工具`) } catch { /* noop */ }
  }

  const kickoff = () => {
    if (!startPromise) startPromise = boot().catch((e) => warn(`MCP 初始化异常：${e?.message || String(e)}`))
    return startPromise
  }

  return {
    /** 同步视图（绝不阻塞）：首次调用触发后台启动，尚未就绪时返回空对象 */
    view() {
      kickoff()
      return viewCache || {}
    },
    /** 等待就绪（首轮预热完成）；测试与"启动即用"场景使用 */
    ready() { return kickoff() },
    /** 已发现的工具名（诊断用） */
    toolNames() { return Object.keys(viewCache || {}) },
    /** 启动失败的服务器（诊断用） */
    failedServers() { return Object.fromEntries(failures) },
    /** 内核退出时回收所有 MCP 子进程（不回收会留下孤儿进程） */
    closeAll() {
      for (const { client } of clients) { try { client.close() } catch { /* 已退出 */ } }
      clients.length = 0
      viewCache = {}
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
