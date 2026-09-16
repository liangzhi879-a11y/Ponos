// src/components/mcp/mcpStatus.ts —— MCP 状态判定的纯逻辑（零依赖，可被 node --test 直接相对导入）。
//
// 为什么单独成文件：src 侧测试走 Node 原生 TS，**不认 `@/` alias**，故纯逻辑必须放在
// 能被 `./mcpStatus.ts` 这种相对路径导入的文件里（与既有 `mcpFormat.ts` 的拆法一致）。
//
// 这里只回答两个问题：
//   ① 面板顶部的状态条该说哪句话（内核从未上报 / 已生效 / 配置比内核新）；
//   ② 快照里的数字（服务器数、工具数、失败与关闭清单）。
// 两者都是"会骗人的地方"——判错会把"没生效"说成"生效了但空"，故抽出来逐一钉住。
export type McpKernelSnapshot = {
  servers: Record<string, { tools: string[]; expose: string }>
  failed: Record<string, string>
  disabled: string[]
  configSig: string
}

export type McpStatusCache = {
  ok: boolean
  error?: string
  config: { path: string; sig: string | null }
  kernel: McpKernelSnapshot | null
  stale: boolean
}

/**
 * 'unknown' = 内核本次运行还没上报过 —— **必须与"已生效但 0 个工具"区分开**，
 * 否则界面会在内核根本没起来的时候谎称"已接入 0 个"，把"没生效"包装成"生效了但空"。
 * 这正是本批要修的那类误导："添加成功却用不上"的第一步就是界面分不清这两种状态。
 */
export function stalenessOf(cache: McpStatusCache | null): 'unknown' | 'fresh' | 'stale' {
  if (!cache || !cache.kernel) return 'unknown'
  return cache.stale ? 'stale' : 'fresh'
}

/**
 * 汇总内核快照。
 * `totalServers` **含失败的**：面板要能报出"哪台挂了"，把它们从总数里扣掉会让
 * "共 3 台、显示 2 台"对不上账；`totalTools` 只数成功接入的服务器（失败的那些本就没有工具）。
 */
export function kernelSummary(snap: McpKernelSnapshot) {
  const names = Object.keys(snap.servers || {})
  const failedNames = Object.keys(snap.failed || {})
  return {
    totalServers: names.length + failedNames.length,
    totalTools: names.reduce((a, n) => a + (snap.servers[n].tools?.length || 0), 0),
    failedNames,
    disabledNames: [...(snap.disabled || [])],
  }
}
