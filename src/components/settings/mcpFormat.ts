// src/components/settings/mcpFormat.ts
// MCP 面板的状态归并纯函数（与 React / i18n 解耦，便于 node --test 直接断言）。
//
// 为什么单独抽出来：面板的核心判断是「哪几台能连上、各有哪些工具、失败原因是什么」。
// 这段逻辑若埋在 JSX 里就只能靠人眼看，无法回归；抽成纯函数后可精确断言
// （尤其「一台失败不影响另一台」这条——它是多服务器支持的关键契约）。
//
// 零依赖：不 import '@/...'，因为 node --test 走 Node 原生 TS，不认 vite alias。

export type McpToolInfo = { name: string; description?: string }

/** 传输类型：`stdio` = 本地子进程，`http` = 远程 Streamable HTTP */
export type McpTransport = 'stdio' | 'http'

/**
 * 面板用到的配置形状（与 `mcpApi.ts` 的 `McpServerConfig` 结构一致，但**不 import**——
 * 本模块零依赖：node --test 走 Node 原生 TS，不认 `@/` alias）。
 * 列全字段（而非只写 `url`）是刻意的：否则传字面量时 TS 会以"存在多余属性"报错，
 * 而调用点（测试、面板）本来就会连着 `command`/`args` 一起写。
 */
export type McpConfigLike = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string | null
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/**
 * 判定配置走哪种传输（面板据此决定渲染哪一组字段、"测试"按钮何时可用、
 * 以及切传输时清哪一侧的字段）。
 *
 * 口径只有一条：**有 `url` 就是 HTTP**。与内核 `classifyMcpEntry` 同源，
 * 但此处**不做校验**（`command` 与 `url` 并存时仍返回 `'http'`）——
 * 前端再实现一遍校验规则就会长出第二份会漂移的真源；
 * 非法组合由后端 `normalizeMcpServers` 返回 400 兜底，界面如实显示其原文即可。
 */
export function transportOf(config?: McpConfigLike | null): McpTransport {
  return String(config?.url ?? '').trim() ? 'http' : 'stdio'
}

/** 单台服务器最近一次连接测试的结果（未测试 = undefined） */
export type McpTestState = {
  running?: boolean
  ok?: boolean
  tools?: McpToolInfo[]
  error?: string
}

export type McpBadge = 'untested' | 'running' | 'ok' | 'failed'

/** 徽章状态：running 优先于 ok/failed（测试进行中不应显示上一次的结论） */
export function badgeOf(state?: McpTestState): McpBadge {
  if (!state) return 'untested'
  if (state.running) return 'running'
  return state.ok ? 'ok' : 'failed'
}

/** 仅当「已测且成功」才返回工具清单；否则一律空数组（防把上一次的清单当成本次结论） */
export function toolsOf(state?: McpTestState): McpToolInfo[] {
  if (!state || state.running || !state.ok) return []
  return Array.isArray(state.tools) ? state.tools : []
}

/** 仅当「已测且失败」才返回错误文案，供红字展示 */
export function errorOf(state?: McpTestState): string {
  if (!state || state.running || state.ok) return ''
  return String(state.error || '')
}

export type TestSummary = {
  total: number
  ok: number
  failed: number
  testing: number
  untested: number
  /** 全部有结论（无 running、无 untested）——用于「全部测试」按钮的忙碌态判定 */
  settled: boolean
}

/**
 * 汇总各台结果。
 * 注意 keys 传入的是「当前配置里的服务器」而非「测试记录里的」——
 * 用户删掉一台后，其残留记录不应再计入统计。
 */
export function summarize(keys: string[], tests: Record<string, McpTestState>): TestSummary {
  let ok = 0, failed = 0, testing = 0, untested = 0
  for (const k of keys) {
    switch (badgeOf(tests[k])) {
      case 'ok': ok++; break
      case 'failed': failed++; break
      case 'running': testing++; break
      default: untested++
    }
  }
  return { total: keys.length, ok, failed, testing, untested, settled: testing === 0 && untested === 0 }
}

/**
 * 汇总文案：如「2 通 · 1 失败」。全通时只显示「2 通」，不列 0 项以免噪声。
 * labels 由调用方从 i18n 取，本函数保持无 i18n 依赖。
 */
export function summaryText(
  s: TestSummary,
  labels: { ok: string; failed: string; testing: string; untested: string },
): string {
  const parts: string[] = []
  if (s.ok) parts.push(`${s.ok} ${labels.ok}`)
  if (s.failed) parts.push(`${s.failed} ${labels.failed}`)
  if (s.testing) parts.push(`${s.testing} ${labels.testing}`)
  if (s.untested) parts.push(`${s.untested} ${labels.untested}`)
  return parts.join(' · ')
}
