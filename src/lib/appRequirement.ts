// 应用「需求」字段的纯逻辑。
//
// ★ 为什么独立成模块：需求是生成质量的关键输入（模型据此判断覆盖度），
//   归一化口径必须与主进程一致（electron/app-agent.cjs 的 normalizeRequirement），
//   又需要能在 node --test 里直接测（组件不便测）。改口径时**两处同步改**——
//   这里是「文本按行拆成条目」，主进程收的是同一份原文、按条目归一化（去空/去重/截断）。
export const REQUIREMENT_MAX_CHARS = 2000
export const REQUIREMENT_MAX_ITEMS = 40

/** 多行文本 → 需求条目数组（去空行、去重、截断；与主进程同口径） */
export function normalizeRequirement(input: unknown): string[] {
  const items = Array.isArray(input)
    ? input
    : String(input ?? '').split('\n')
  const out: string[] = []
  for (const raw of items) {
    const text = String(raw ?? '').trim().slice(0, REQUIREMENT_MAX_CHARS)
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= REQUIREMENT_MAX_ITEMS) break
  }
  return out
}

/** 列表展示用摘要（空 → "未填写需求"；多条 → "首条 等 N 项"） */
export function summarizeRequirement(input: unknown): string {
  const list = normalizeRequirement(input)
  if (!list.length) return '未填写需求'
  if (list.length === 1) return list[0]
  return `${list[0]} 等 ${list.length} 项`
}
