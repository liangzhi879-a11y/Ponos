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

/**
 * 从 `analyzeFrames()` 产出的 **result 帧数组**汇总用量（T4.6，2026-10-20）。
 *
 * 为什么单独抽出来：三处需要同一件事——bench trial（`server/bench-runner.mjs`）、
 * 候选评审（`server/review-engine.mjs`）、自动起草（`server/draft-engine.mjs`）。
 * 三处各抄一遍累加逻辑，就会出现"评审按 A 口径、起草按 B 口径"的分叉（本仓已因单价
 * 分三处口径吃过一次亏，见 `readonly.mjs` 的 T0.4）。
 *
 * ★ 语义（与 `kernel/trace-project.mjs` 的 usage 段、`stats.mjs` 的 aggregateUsage **同口径**）：
 *   · 判据 = `input_tokens` 是有限数（缺字段的 result 帧跳过，不当 0）；
 *   · 一个有效帧都没有 ⇒ 返回 `null`（**不是零对象**）——"没测到"与"免费"是两件事；
 *   · 只汇总用量，**不认价表、不认模型名**（纯函数；计价由调用方用 `costOf`+`resolveModelPrices`）。
 *
 * @param {Array<{usage?: object|null}>} results analyzeFrames 的 `results`
 * @returns {{input_tokens:number, output_tokens:number, cache_read_input_tokens:number,
 *            cache_creation_input_tokens:number, tokens:number}|null}
 */
export function sumResultUsage(results) {
  const list = Array.isArray(results) ? results : []
  const acc = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let hit = false
  for (const r of list) {
    const u = r?.usage
    if (!u || !Number.isFinite(Number(u.input_tokens))) continue
    hit = true
    acc.input_tokens += Number(u.input_tokens) || 0
    acc.output_tokens += Number(u.output_tokens) || 0
    acc.cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0
    acc.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0
  }
  if (!hit) return null
  return { ...acc, tokens: acc.input_tokens + acc.output_tokens + acc.cache_read_input_tokens + acc.cache_creation_input_tokens }
}
