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

export type McpServerConfig = {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string | null
  timeoutMs?: number
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

/** 保存全部 MCP 服务器配置（后端为整体替换语义，故此处直接送全量） */
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

/** 连接测试：临时拉起服务器并列出工具。连不上属正常业务结果（ok:false + error 文案）。 */
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
