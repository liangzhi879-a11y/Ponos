// kernel/cost.mjs —— 成本计费纯函数（docs/production/observability.md O4-1）
// 公式：cache_read 按 input 单价的 cacheReadRatio 计（命中折扣）；cache_creation 按 input
// 单价的 cacheWriteRatio 计（**缓存写入溢价**，1.0 = 不打折按全价）。
// 【2026-09-18 P0-5】写入溢价此前固定按全价（等价 ratio 1.0）⇒ 系统性**低估**真实成本：
// Anthropic 官方写入 1.25x（5 分钟 TTL）/ 2x（1 小时 TTL），只有读取是 0.1x。默认改为 1.25
// （5 分钟档）；用 1 小时 TTL 时显式传 cacheWriteRatio: 2。DeepSeek 系端点不单列
// cache_creation（字段恒 0）⇒ 本改动对其成本口径零影响。
// 注：外部 benchmark/lib/llm-api.mjs 的 costOf 保持"不含写溢价"的保守估算，两边**有意不一致**
// （该文件不在本仓；若将来同步，请把默认值一并对齐，勿只改一侧）。
export function costOf(usage = {}, { pricePerMInput = 0.2, pricePerMOutput = 1.2, cacheReadRatio = 0.1, cacheWriteRatio = 1.25 } = {}) {
  const in_ = (usage.input_tokens || 0) / 1e6 * pricePerMInput
  const out = (usage.output_tokens || 0) / 1e6 * pricePerMOutput
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1e6 * pricePerMInput * cacheReadRatio
  const cacheCreation = (usage.cache_creation_input_tokens || 0) / 1e6 * pricePerMInput * cacheWriteRatio
  return in_ + out + cacheRead + cacheCreation
}

export function withBudget(rows = [], budgetUsd = 0) {
  const totalUsd = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0)
  return { rows, totalUsd: Number(totalUsd.toFixed(4)), overBudget: budgetUsd > 0 && totalUsd > budgetUsd }
}
