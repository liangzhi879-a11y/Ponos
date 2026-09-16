// MCP 配置前端 API（P1-5 扩展：GUI 配置界面）。
// ---------------------------------------------------------------------------
// 纪律（与 disabledApi.ts 同范式）：
//   · baseUrl 可注入 —— 测试里传假地址，生产用桥默认端口
//   · **失败不静默**：网络异常/HTTP 非 2xx/后端 ok:false 一律转成可展示的中文 error，
//     绝不把异常抛给渲染层（否则 React 渲染期直接白屏，用户看不到任何原因）
//   · 读失败降级但不掩盖：返回空 servers + error，界面既能显示空态也能显示原因
//
// 【端口坑，2026-09-16 实测】桥真实监听 `YFW_BRIDGE_PORT || 51517`
// （server/bridge.mjs:59、electron/main.cjs:206、vite.config.ts:11 三处一致）。
// 解析逻辑统一收敛在 bridgeBase.ts（单一真源），本模块只做 re-export 兼容既有调用方。
import { resolveBridgeBase, BRIDGE_BASE_FALLBACK } from './bridgeBase.ts'

/** 兜底基地址：与桥默认端口一致。仅在 getBridgeUrl() 取不到时使用（如 node --test 无 vite define） */
export const MCP_BASE = BRIDGE_BASE_FALLBACK

/**
 * 单台服务器配置。**两种形态互斥**（`command` 本地 stdio / `url` 远程 HTTP），
 * 后端 `normalizeMcpServers` 会拒掉"两者并存"与"两者都缺"，故此处把字段全部标为可选：
 * 类型上不强制 `command`，是为了让 HTTP 行能只写 `{url, headers, timeoutMs}` ——
 * 若强行补一个 `command: ''`，实际落在文件里的键就多了一个无用字段。
 */
export type McpServerConfig = {
  // ---- stdio 传输 ----
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string | null
  // ---- HTTP 传输（Streamable HTTP）----
  /** 必须是 http/https 绝对地址；值内可写 `${ENV_VAR}` 占位符 */
  url?: string
  /** 认证头。占位符**只在运行时**求值 ⇒ 密钥不落盘（mcp.json 会被备份/截图/同步） */
  headers?: Record<string, string>
  /** 两种传输共用 */
  timeoutMs?: number
  /**
   * 授权模式（2026-09-16 新增，camelCase 与内核契约一致）。
   * `private` = 连上但不给任何 AI（仅测试）/ `public` = 所有 agent / `bound` = 仅 `bindAgents` 列出的 agent。
   * **缺省 = public**（存量配置没有该字段，若缺省 private 则升级后工具全部消失）。
   */
  expose?: { mode?: 'private' | 'public' | 'bound'; bindAgents?: string[] }
  /**
   * 是否启用。**只有显式 `false` 才是关闭**（内核 `normalizeEnabled` 同规则）：
   * 缺省、`'false'` 字符串、0 一律视为开启——解析歧义不该悄悄停用用户的服务器。
   * 关闭 = 内核根本不启动连接（不 spawn 子进程、不发 HTTP 请求）。
   */
  enabled?: boolean
}

export type McpConfigResult = {
  ok: boolean
  configPath?: string
  servers: Record<string, McpServerConfig>
  error?: string
}

export type McpTestResult = {
  ok: boolean
  tools?: { name: string; description: string }[]
  serverInfo?: { name?: string; version?: string } | null
  error?: string
}

/**
 * 内核真实接入状态的一台服务器（`GET /mcp/status` 的 kernel.servers 条目）。
 * `tools` 是该服务器**实际发现的全部工具全名**（`mcp__<server>__<tool>`），
 * 与可见性无关——可见性由 `expose`（授权意图）表达，是另一维信息。
 */
export type McpKernelServerStatus = { tools: string[]; expose: string }

/** 内核上报的快照（`mcpRegistry.snapshot()` 的线上形状） */
export type McpKernelSnapshotPayload = {
  servers: Record<string, McpKernelServerStatus>
  failed: Record<string, string>
  disabled: string[]
  configSig: string
}

/**
 * `GET /mcp/status` 的结果。
 * `kernel === null` 表示**内核本次运行还没上报过**（面板必须显示"内核尚未启动"，
 * 而不是"已接入 0 个工具"）；`stale` 表示磁盘配置比内核用的那份新（下一条消息生效）。
 */
export type McpStatusResult = {
  ok: boolean
  error?: string
  config: { path: string; sig: string | null }
  kernel: McpKernelSnapshotPayload | null
  stale: boolean
}

/**
 * 读取**内核真实接入状态**（面板顶部的"全局真值"）。
 *
 * 与 `testMcpServer` 的区别是本次改动的核心：那个是**面板自己发起的探测**，
 * 只证明"这台服务器此刻连得上"；只有这里返回的 `kernel` 才证明"内核已经把它
 * 接进了 AI 的工具表"。此前只有一个，用户因此认为"添加成功却用不上"。
 *
 * 同样**永不抛**：桥返回 ok:false（配置文件损坏）时降级为 `kernel:null` + error 文案，
 * 让界面既能把原因画出来、又能据此禁用保存。
 */
export async function getMcpStatus(baseUrl?: string): Promise<McpStatusResult> {
  const r = await requestJson('/mcp/status', { method: 'GET' }, baseUrl)
  const data = r.data
  const cfg = (data?.config ?? {}) as { path?: unknown; sig?: unknown }
  const empty: McpStatusResult = {
    ok: false,
    error: r.error || '无法读取 MCP 状态',
    config: { path: typeof cfg.path === 'string' ? cfg.path : '', sig: typeof cfg.sig === 'string' ? cfg.sig : null },
    kernel: null,
    stale: false,
  }
  if (r.error || !data) return empty
  return {
    ok: data.ok === true,
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    config: { path: typeof cfg.path === 'string' ? cfg.path : '', sig: typeof cfg.sig === 'string' ? cfg.sig : null },
    kernel: (data.kernel as McpKernelSnapshotPayload | null) ?? null,
    stale: data.stale === true,
  }
}

/** 统一的请求封装：把一切异常收敛成可展示文案，永不抛出 */
async function requestJson(
  path: string,
  init: { method: string; body?: unknown },
  baseUrlInjected?: string,
): Promise<{ httpOk: boolean; status: number; data: Record<string, unknown> | null; error?: string }> {
  try {
    const res = await fetch(`${resolveBridgeBase(baseUrlInjected)}${path}`, {
      method: init.method,
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    let data: Record<string, unknown> | null = null
    try {
      data = (await res.json()) as Record<string, unknown>
    } catch {
      data = null // 桥异常时可能返回空体/非 JSON
    }
    if (!res.ok) {
      const msg = typeof data?.error === 'string' ? (data.error as string) : `请求失败（HTTP ${res.status}）`
      return { httpOk: false, status: res.status, data, error: msg }
    }
    return { httpOk: true, status: res.status, data }
  } catch (e) {
    // 桥未启动 / 端口不通 / 网络错误
    const msg = e instanceof Error ? e.message : String(e)
    return { httpOk: false, status: 0, data: null, error: `无法连接本地服务：${msg}` }
  }
}

/** 读取 MCP 服务器配置。文件损坏时后端返回 ok:false，此处同样降级为「空列表 + 错误原因」。 */
export async function getMcpConfig(baseUrl?: string): Promise<McpConfigResult> {
  const r = await requestJson('/mcp', { method: 'GET' }, baseUrl)
  const servers = (r.data?.servers as Record<string, McpServerConfig>) || {}
  if (r.error) return { ok: false, servers: {}, error: r.error }
  if (r.data?.ok === false) {
    return {
      ok: false,
      servers,
      configPath: typeof r.data.configPath === 'string' ? (r.data.configPath as string) : undefined,
      error: typeof r.data.error === 'string' ? (r.data.error as string) : '配置文件无法解析',
    }
  }
  return {
    ok: true,
    servers,
    configPath: typeof r.data?.configPath === 'string' ? (r.data!.configPath as string) : undefined,
  }
}

/**
 * 保存全部 MCP 服务器配置（后端为整体替换语义，故此处直接送全量）
 *
 * 【不挑字段，原样透传 url/headers】这里是本批（HTTP 传输）最容易埋雷的一处：
 * 若在此按"已知字段"重建对象（白名单式组装），`url`/`headers` 会被**静默丢弃** ——
 * 界面照样显示"已保存"，磁盘上却没有这两个键，用户重开面板发现配置"消失"，
 * 且单测若只断言 stdio 字段仍会全绿。故只做 JSON 序列化，不做字段筛选。
 */
export async function saveMcpConfig(
  servers: Record<string, McpServerConfig>,
  baseUrl?: string,
): Promise<McpConfigResult> {
  const r = await requestJson('/mcp', { method: 'PUT', body: { servers } }, baseUrl)
  if (r.error) return { ok: false, servers, error: r.error }
  return {
    ok: true,
    servers: (r.data?.servers as Record<string, McpServerConfig>) || servers,
    configPath: typeof r.data?.configPath === 'string' ? (r.data.configPath as string) : undefined,
  }
}

/**
 * 连接测试：临时拉起服务器并列出工具。连不上属正常业务结果（ok:false + error 文案）。
 *
 * 同样**整对象透传**：后端按 `server.url` 是否存在分派到 HTTP 客户端，
 * 且两种传输的返回形状一致（成功 `{ok,tools,serverInfo}` / 连不上 `{ok:false,error}`）
 * ⇒ 调用方无需分支。挑字段会让 HTTP 探测退化成"缺少 url"的 400。
 */
export async function testMcpServer(
  server: McpServerConfig,
  baseUrl?: string,
): Promise<McpTestResult> {
  const r = await requestJson('/mcp/test', { method: 'POST', body: { server } }, baseUrl)
  if (r.error) return { ok: false, error: r.error }
  if (r.data?.ok === false) {
    return { ok: false, error: typeof r.data.error === 'string' ? (r.data.error as string) : '连接失败' }
  }
  return {
    ok: true,
    tools: (r.data?.tools as McpTestResult['tools']) || [],
    serverInfo: (r.data?.serverInfo as McpTestResult['serverInfo']) || null,
  }
}
