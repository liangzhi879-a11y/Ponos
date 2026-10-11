// kernel/wire/model.mjs —— 协议相关模型名解析（纯函数）
// ---------------------------------------------------------------------------
// 为什么需要它（2026-09-23 MiniMax 实证）：
//   同一 provider 的模型名**可能跨协议不同**。MiniMax 的 Anthropic 兼容端点接受
//   `MiniMax-M3[1m]`；同一域名的 OpenAI 兼容端点对同一名字返回
//   `400 unknown model 'minimax-m3[1m]'`，必须用去掉变体后缀的 `MiniMax-M3`。
//   若不做映射，用户"填了 OpenAI 协议"仍会因模型名被 400 挡住。
//
// 决策（用户 2026-09-23 确认，方案甲）：**显式字段优先，不做任何自动推导**。
//   刻意不实现"自动剥离方括号后缀"——属启发式：若某厂商 API 名本身含方括号会误伤，
//   且失败时 400 报文难以归因。与本仓 `cacheMarkerEnabled` 同一纪律：不猜。
//
// 回落规则保证**老配置零迁移**：未配置 modelByFormat 时行为与今天完全一致。

/**
 * 取当前生效协议应下发的模型名。
 * @param {{ model?: string, format?: 'anthropic'|'openai', modelByFormat?: { openai?: string, anthropic?: string } }} args
 * @returns {string}
 */
export function pickModelName({ model, format, modelByFormat } = {}) {
  const explicit = modelByFormat?.[format]
  // 显式空值/空白不算覆盖：GUI 上"留空即用默认"的心智模型必须与实现一致
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  return typeof model === 'string' ? model : (model ?? '')
}

/** 供 GUI/bridge 归一 modelByFormat（丢弃非法值、trim、只留两个已知协议键）。 */
export function normalizeModelByFormat(v) {
  const out = {}
  if (!v || typeof v !== 'object') return out
  for (const k of ['openai', 'anthropic']) {
    const val = v[k]
    if (typeof val === 'string' && val.trim()) out[k] = val.trim()
  }
  return out
}

/**
 * 按模型名查找单价时的**候选序列**（wire 模型名优先、provider 默认名回退）。
 *
 * 为什么（2026-09-23 勘察所得，属"看不出错的错"）：`provider.modelPrices` 的**键就是模型名**
 *   ——bridge 序列化进 `PONOS_MODEL_PRICES`，内核价目查找按"键名 === 当前模型名"匹配。
 *   引入 `modelByFormat` 后，**真正下发的 wire 名可能不等于 provider 默认名**（MiniMax 场景：
 *   下发的 `MiniMax-M3` vs 默认名 `MiniMax-M3[1m]`）⇒ 用户按默认名填的单价会**匹配不上**，
 *   成本统计静默归零。
 * ⇒ 查找方一律按本序列依次取首个命中：只填一份单价即可覆盖两套协议；若为某协议单填了
 *   协议专属单价，则它排在前面**优先命中**（也不串）。
 *
 * ★ 来源声明：上文那个价目查找实现（`resolveModelPrices` / `PONOS_MODEL_PRICES` 的消费点）
 *   位于 `feature/loop-phase1-reliability`（提交 `777a6ff`），**尚未合入本分支**——本分支此刻
 *   只有本函数（查找语义），没有调用点。别把上面读成"价目闭环已在树内"。
 *
 * 返回去重后的非空字符串序列；wire 名与默认名相同时只返回一项。
 * @param {{ model?: any, format?: any, modelByFormat?: any }} [opts]
 * @returns {string[]}
 */
export function modelNameCandidates({ model, format, modelByFormat } = {}) {
  const fallback = typeof model === 'string' ? model : (model ?? '')
  const out = []
  for (const n of [pickModelName({ model, format, modelByFormat }), fallback]) {
    if (typeof n === 'string' && n && !out.includes(n)) out.push(n)
  }
  return out
}
