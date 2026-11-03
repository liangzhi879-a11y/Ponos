// kernel/token-strategies.mjs —— token 治理策略注册表（T3.2，2026-10-20）
// ---------------------------------------------------------------------------
// 为什么需要它（问0）：本计划落了一批"每条独立开关"的策略（工具描述预算、技能清单预算、
// 附录详略、结果采样、动态工具预算…）。这些开关分散在各自的模块与环境变量里 ⇒
// **A/B 拿不到分组键**："这次 C_success 变好，是因为开了哪几条？"答不出来。
//
// 本模块的作用（最小实现，不做 RLM 式架构）：
//   ① 一处登记所有治理策略：`id` / 默认值 / 属于哪个面 / 应用到哪个环境变量 / 回退方式；
//   ② 给出**本轮生效的策略 id 列表**（`activeStrategies`），由 T0.3 的 `turn` 行落盘；
//   ③ 按 id 分组聚合 `C_success` ⇒ A/B 可归因（`turn.activeStrategies` × `turn.usage`）。
//
// ★ 为什么不把默认值都翻成"开"：Global Constraint 7 —— 先可配 + 默认关 → 观测 → 再改默认；
//   改默认是独立一步、可单独回退。本表如实记录**当前**默认，翻默认时只改这里一处。
// ★ 与既有 env 的关系：本表**不新增通道**（G2）——每条策略仍用原有的环境变量，
//   这里只是把"它叫什么、默认是什么、怎么回退"集中登记，供观测与归因读取。

/** 策略所属的"面"（决定它的收益体现在哪一维成本上） */
export const STRATEGY_FACE = Object.freeze({
  prefix: 'prefix',   // 每请求固定注入面（缓存端点按 0.1× 计，本地端点 1×）
  history: 'history', // 历史/工具结果面（全额价）
  process: 'process', // 压缩期与流程（次数型成本）
})

/**
 * 治理策略登记表（append-only；删条目要先确认没有消费方在读 `activeStrategies`）。
 *
 * 字段：
 *  · `id`            稳定标识（进 `turn.activeStrategies`，也是 A/B 的分组键）
 *  · `face`          收益落在哪一维（prefix / history / process）
 *  · `env`           控制它的环境变量（**不新增通道**：沿用各模块既有开关）
 *  · `defaultOn`     当前默认是否生效（改默认 = 改这一个布尔 + 一轮观测）
 *  · `saving`        生效时的实测/估算节省（字节或说明），只作展示，不参与判定
 *  · `revert`        一行回退方式（必须具体到"设什么值"）
 */
export const TOKEN_STRATEGIES = Object.freeze([
  {
    id: 'tool-desc-budget',
    face: STRATEGY_FACE.prefix,
    env: 'PONOS_TOOL_DESC',
    defaultOn: true,                 // T1.1：缺省紧凑版；=full 回退
    saving: '−7,849 B/请求（31,116 → 23,267）',
    revert: 'PONOS_TOOL_DESC=full',
  },
  {
    id: 'skill-catalog-budget',
    face: STRATEGY_FACE.prefix,
    env: 'PONOS_SKILL_CATALOG_BUDGET',
    defaultOn: false,                // T1.2：机制就位，默认不设限（GC7：改默认是独立一步）
    saving: '−7,597 B/请求（14,885 → 7,288，设 8192 时）',
    revert: '删除 settings.skill.catalogBudgetBytes（或设为 null）',
  },
  {
    id: 'prompt-appendix-compact',
    face: STRATEGY_FACE.prefix,
    env: 'PONOS_PROMPT_APPENDIX',
    defaultOn: false,                // T1.4：行为规则，默认全文
    saving: '−1,456 B/请求（2,842 → 1,386）',
    revert: '删除 PONOS_PROMPT_APPENDIX（缺省即全文）',
  },
  {
    id: 'dynamic-tool-budget',
    face: STRATEGY_FACE.prefix,
    env: 'PONOS_DYNAMIC_TOOL_BUDGET_BYTES',
    defaultOn: false,                // T1.5：默认不裁剪（能力可见性优先）
    saving: '按配置（动态工具超预算时裁尾部）',
    revert: '删除 PONOS_DYNAMIC_TOOL_BUDGET_BYTES',
  },
  {
    id: 'tool-result-sample',
    face: STRATEGY_FACE.history,
    env: 'PONOS_TOOL_RESULT_BUDGET_BYTES',
    defaultOn: true,                 // T2.1：内联 8,000 字符 + 头尾预览（全文仍落盘，无损）
    saving: '大结果内联 20,000 → ≈6.5 KB（全额价）',
    revert: 'PONOS_TOOL_RESULT_BUDGET_BYTES=20000',
  },
  {
    id: 'cache-obs',
    face: STRATEGY_FACE.process,
    env: 'PONOS_CACHE_OBS',
    defaultOn: true,                 // T0.5：纯观测，默认开；=0 关
    saving: '（观测项，不直接省字节，是"前缀削减值不值"的唯一依据）',
    revert: 'PONOS_CACHE_OBS=0',
  },
])

/**
 * 本轮**实际生效**的策略 id 列表。
 *
 * 判据：`defaultOn` 且未被环境变量显式关掉 / 被显式打开。
 * 只做"是否出现在 activeStrategies 里"这一件事，**不判断策略是否真的省了**——
 * 那是 A/B 的任务（用 `turn.usage` 分组算 C_success），本函数只提供分组键。
 *
 * @param {{env?: object}} [p]
 * @returns {{active: string[], inactive: string[]}}
 */
export function resolveActiveStrategies({ env = process.env } = {}) {
  const active = []
  const inactive = []
  for (const s of TOKEN_STRATEGIES) {
    const raw = env?.[s.env]
    const set = raw !== undefined && raw !== null && String(raw) !== ''
    // 显式关闭的写法：'0' / 'off' / 'false'（各模块口径一致：0 即关）
    const explicitlyOff = set && ['0', 'off', 'false'].includes(String(raw).toLowerCase())
    // 显式打开的写法：非关闭值即视为"用户显式设了值"（各模块按自己的语义解释具体数值）
    const on = s.defaultOn ? !explicitlyOff : (set && !explicitlyOff)
    ;(on ? active : inactive).push(s.id)
  }
  return { active, inactive }
}
