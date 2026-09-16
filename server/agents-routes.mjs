// server/agents-routes.mjs —— Agent 列表的 HTTP 面（2026-09-15，待处理清单 P1 批次二 H）。
//
// ## 为什么需要它（补的是 D 条款的覆盖缺口）
//
// GUI 自己的 agent 列表（`src/lib/agents.ts`，16 个）与内核 `resolveAgents`（6 个硬编码内置
// ∪ 已同步的 .md）**不是同一个集合**。差集是内核的 5 个内置 agent：
// `researcher` / `implementer` / `reviewer` / `explorer` / `planner` —— 它们不在 GUI 列表里，
// 于是用户在界面上**看不到、也就停不掉**（`resolveAgents` 的过滤机制其实早就支持，缺的只是入口）。
//
// ## 为什么由内核侧产出而不是在 GUI 里再抄一份名单
//
// 抄一份 = 第二个真相源：内核增删内置 agent 时界面不会跟着变，且"界面上能停"与"内核真的过滤"
// 会逐渐分叉（本仓库刚修完的 `Agent.tools` 缺陷正是这类分叉：界面写的与内核读的不是一套规则）。
// 故这里直接调用 **`resolveAgents` 本身**（与 Task 工具、只读面同一个函数、同一份停用注册表），
// 界面拿到的就是内核此刻真实的可用集合。加 `builtin` 标记让界面能分组，不靠猜。
//
// 纯 handler（本仓库纪律：测试不起 bridge、不起内核子进程），可直调测试。
import { resolveAgents } from '../kernel/agents.mjs'
import { readDisabled } from '../kernel/disabled.mjs'

/**
 * 处理 `/agents` 的 GET。
 * @param {{method: string, pathname: string, configDir: string}} ctx
 * @returns {Promise<{status: number, body: object} | null>} 未匹配返回 `null`（交给后续路由）
 */
export async function handleAgentsRoute(ctx) {
  const { method, pathname, configDir } = ctx || {}
  if (pathname !== '/agents') return null
  if (method !== 'GET') return null
  let list
  let disabledIds
  try {
    // **刻意传 `disabled: []` 绕过过滤**：本接口返回的是**完整目录**（每位 agent 带 `disabled` 标记），
    // 而不是"当前可用集合"。理由是不可逆性——若停用项从这里消失，用户停掉某个内置 agent 后
    // 它就再也回不到列表里，**永远无法重新启用**（开关成了单向操作）。界面需要的是
    // "全量目录 + 谁被停用"，据此渲染成"已停用"状态并允许点回启用。
    list = resolveAgents({ configDir, disabled: [] })
    // disabled 状态来自同一份注册表（内核执行时用的就是它），故界面显示的停用态与引擎口径一致。
    disabledIds = readDisabled({ configDir }).agents
  } catch (e) {
    return { status: 500, body: { ok: false, error: `读取 agent 列表失败：${e?.message || e}` } }
  }
  const off = new Set(disabledIds)
  return {
    status: 200,
    body: {
      ok: true,
      agents: list.map((a) => ({
        id: a.id,
        name: a.name || a.id,
        description: a.description || '',
        // 工具声明按**原始字面量**返回（不在这里解析）：GUI 用 `parseAgentTools` 做三态展示，
        // 与用户保存时写回的格式同源；此处再解析一次等于多一套可能漂移的规则。
        tools: Array.isArray(a.tools) ? a.tools.join(', ') : String(a.tools ?? ''),
        disallowedTools: Array.isArray(a.disallowedTools) ? a.disallowedTools : [],
        builtin: a.builtin === true,
        disabled: off.has(a.id),
      })),
    },
  }
}
