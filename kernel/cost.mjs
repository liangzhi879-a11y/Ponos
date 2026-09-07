// kernel/cost.mjs —— 成本计费纯函数（docs/production/observability.md O4-1）
// 公式与 benchmark/lib/llm-api.mjs costOf 完全一致：cache_read 按 input 单价的
// cacheReadRatio 计费（缓存命中的折扣），cache_creation 按全价 input 计费。
export function costOf(usage = {}, { pricePerMInput = 0.2, pricePerMOutput = 1.2, cacheReadRatio = 0.1 } = {}) {
  const in_ = (usage.input_tokens || 0) / 1e6 * pricePerMInput
  const out = (usage.output_tokens || 0) / 1e6 * pricePerMOutput
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1e6 * pricePerMInput * cacheReadRatio
  const cacheCreation = (usage.cache_creation_input_tokens || 0) / 1e6 * pricePerMInput
  return in_ + out + cacheRead + cacheCreation
}

export function withBudget(rows = [], budgetUsd = 0) {
  const totalUsd = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0)
  return { rows, totalUsd: Number(totalUsd.toFixed(4)), overBudget: budgetUsd > 0 && totalUsd > budgetUsd }
}
