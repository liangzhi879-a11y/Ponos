// kernel/turn-ledger.mjs —— 轮级账本行（T0.3，2026-10-20；净化计划 §T0.3）
// ---------------------------------------------------------------------------
// 为什么有这个模块：C_success（每成功任务费用）的**分母**是"成功任务数"，而成功性此前只活在
// 引擎内存的 `turnStats` 里 —— 进程一退就没了 ⇒ 分母不可从盘上算，"唯一验收指标"根本算不出来。
// 本模块把"内存轮次统计 → 盘上账本行"这一步收成**纯函数**，cli 只负责调用与落盘。
//
// ★ 为什么必须是纯函数（而不是在 cli 里内联拼装）：
//   ① 失败轮的 `ok:false` 分支只能靠它才**可确定地**断言 —— 端到端造一个"引擎内部抛错"的轮
//      需要错误注入开关（仓内 mock 没有），否则测试退化成"只看有没有账"，等于没测；
//   ② 计费口径（按本轮模型取价 + priceSource）要与 `/api/usage`、演化投影一致，
//      集中一处才不会出现第四份累加/计价逻辑（本仓已因"单价三处口径"吃过一次亏）。
//
// ★ 纪律（三条，与演化环同源）：
//   ① **只记统计与引用，不记正文**：字段全是数字 / id / 枚举，绝不复制对话文本；
//   ② **失败轮也落**（`ok:false` + `errorKind`）：只记成功轮会让失败次数永远为 0，
//      而"错误率"正是质量侧车（`qualityGuard`）的输入；
//   ③ **缺证据给 null，不给 0**：`usage` 为 null（内部错误轮）时 `costUsd` 必须是 null ——
//      写成 0 会把"这轮没测到"说成"这轮免费"，进而把 C_success 系统性压低。
import { costOf } from './cost.mjs'
import { resolveModelPrices } from './model-prices.mjs'

/** 工具调用计数上限（一行的体积受控：只记名字+次数，不记内容；超长名字截断） */
const TOOL_NAME_MAX = 64
/** 技能 id 上限（同 `trips`：只记 id，不记正文；一次落太多说明统计口径出了问题） */
const SKILLS_MAX = 32

const r6 = (n) => Number((Number(n) || 0).toFixed(6))

/**
 * 内存轮次统计（engine `turnStats` 的一条）→ 盘上账本行（cli `store.appendMeta('turn', …)` 的载荷）。
 *
 * @param {{usage?: object|null, model?: string, compactCount?: number, cache?: object|null,
 *          isError?: boolean, errorKind?: string, ts?: string}} [stats] engine.turnStats 尾元素
 * @param {{turnIndex?: number, toolDigest?: Array<{name?: string, skill?: string}>,
 *          priceOf?: (model: string) => object, activeStrategies?: string[]|null}} [opts]
 *   `priceOf` 可注入（测试用固定价）；缺省走 `resolveModelPrices` 三级解析（与聚合层同源）。
 *   `activeStrategies` = 本轮生效的治理策略 id（T3.2，A/B 分组键）。
 * @returns {{turnIndex: number, ok: boolean, errorKind: string|null, usage: object|null,
 *            model: string, costUsd: number|null, priceSource: string, compactCount: number,
 *            cache: object|null, skillsUsed: string[], toolCalls: Record<string, number>,
 *            activeStrategies: string[]|null}}
 */
export function buildTurnLedgerRow(stats = {}, { turnIndex = 0, toolDigest = [], priceOf = null, activeStrategies = null } = {}) {
  const s = stats && typeof stats === 'object' ? stats : {}
  const model = String(s.model || '')
  // ① 计费：按**本轮模型**取价（混模型会话不串价）；价格来源一并记，读侧才能分辨估算与价表
  const prices = priceOf ? priceOf(model) : resolveModelPrices(model)
  const costUsd = s.usage ? r6(costOf(s.usage, prices)) : null   // ③ 缺证据 ⇒ null，不为 0
  // ② 工具计数与技能 id（只记名字/次数/id —— 隐私口径）
  /** @type {Record<string, number>} */
  const toolCalls = {}
  const skillsUsed = []
  for (const d of Array.isArray(toolDigest) ? toolDigest : []) {
    const name = String(d?.name || '').slice(0, TOOL_NAME_MAX)
    if (!name) continue
    toolCalls[name] = (toolCalls[name] || 0) + 1
    const sk = String(d?.skill || '')
    if (name === 'Skill' && sk && !skillsUsed.includes(sk) && skillsUsed.length < SKILLS_MAX) skillsUsed.push(sk)
  }
  const isErr = s.isError === true
  return {
    turnIndex: Number(turnIndex) || 0,
    ok: !isErr,
    errorKind: isErr ? String(s.errorKind || 'internal') : null,
    usage: s.usage ?? null,
    model,
    costUsd,
    priceSource: String(prices?.source || 'estimate'),
    compactCount: Number(s.compactCount) || 0,
    cache: s.cache ?? null,
    skillsUsed,
    toolCalls,
    // T3.2（2026-10-20）：本轮**实际生效**的治理策略 id —— A/B 的分组键。
    // 有了它，"C_success 变好是因为开了哪几条"才答得出来（否则只能整体归因）。
    activeStrategies: Array.isArray(activeStrategies) ? activeStrategies : null,
  }
}
