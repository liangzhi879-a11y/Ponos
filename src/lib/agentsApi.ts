// src/lib/agentsApi.ts —— 内核 Agent 目录的客户端（2026-09-15，待处理清单 P1 批次二 H）。
//
// 用途：把**只在核心里存在**的 agent（`researcher`/`implementer`/`reviewer`/`explorer`/`planner`
// 这 5 个内置定义不在 GUI 的 `src/lib/agents.ts` 里）暴露到界面上，让用户能看到并停用它们。
// 内核侧机制早就支持停用（`resolveAgents` 过滤注册表），此前缺的只是这个入口。
//
// 口径：`GET /agents` 返回的是**完整目录 + `disabled` 标记**（不是"当前可用集合"）——
// 这是刻意的，否则停用后该行消失，用户永远无法把它点回来（开关变单向）。

export type KernelAgent = {
  id: string
  name: string
  description: string
  /** 原始工具声明字面量（交给 `parseAgentTools` 做三态展示，与保存时写回的格式同源） */
  tools: string
  disallowedTools: string[]
  /** true = 内核硬编码内置（定义在 kernel/agents.mjs，不在 GUI 列表里） */
  builtin: boolean
  /** true = 当前在停用注册表里（内核不会把它列入可派发列表） */
  disabled: boolean
}

const BASE = 'http://127.0.0.1:3939'

/**
 * 拉取内核 Agent 目录。
 * 网络异常/桥未就绪时返回 `[]`（面板降级为"不显示该分区"），绝不抛给渲染层——
 * 与 `disabledApi.fetchDisabled` 同款策略：启动早期桥还没起来不该让面板崩。
 */
export async function fetchKernelAgents(): Promise<KernelAgent[]> {
  try {
    const r = await fetch(`${BASE}/agents`)
    if (!r.ok) return []
    const j = await r.json() as { agents?: unknown }
    if (!Array.isArray(j.agents)) return []
    return (j.agents as Array<Partial<KernelAgent>>)
      .filter((a) => a && typeof a.id === 'string' && a.id)
      .map((a) => ({
        id: String(a.id),
        name: String(a.name || a.id),
        description: String(a.description || ''),
        tools: String(a.tools ?? ''),
        disallowedTools: Array.isArray(a.disallowedTools) ? a.disallowedTools.map(String) : [],
        builtin: a.builtin === true,
        disabled: a.disabled === true,
      }))
  } catch {
    return []
  }
}

/**
 * 挑出"只在内核里、GUI 自己的 agent 列表没有"的项 —— 也就是需要新开分区展示的那些。
 *
 * 为什么要按 GUI 已有 id 过滤：GUI 列表里的 agent 已经有自己的卡片与开关（走 `agentStore`），
 * 若这里再列一遍，同一个 agent 会出现两个开关（一个走 agentStore.enabled、一个走停用注册表），
 * 用户点哪个都可能与另一个不一致 —— 界面自相矛盾比"少显示一个"更糟。
 *
 * @param kernelList 内核目录
 * @param localIds   GUI `useAgentStore` 里已有的 id 集合
 */
export function selectKernelOnlyAgents(kernelList: KernelAgent[], localIds: Iterable<string>): KernelAgent[] {
  const owned = new Set(localIds)
  return kernelList.filter((a) => !owned.has(a.id))
}

/**
 * 停用注册表里"不属于 GUI agent 列表"的 id（即内核独有 agent 的停用项）。
 * 供 `agentStore` 同步时**保留**这些项——详见该处注释（覆盖它们会造成"停用被静默撤销"）。
 */
export function foreignDisabledAgents(registryIds: string[], localIds: Iterable<string>): string[] {
  const owned = new Set(localIds)
  return registryIds.filter((id) => !owned.has(id))
}
