// 桥侧高危命令判定（审批弹窗的"高危"标识）
// ---------------------------------------------------------------------------
// **薄转发**（2026-09-17 · P1-2）：pattern 清单已收敛到 `shared/high-risk.mjs`（单一真源），
// 此处只保留原公开 API，使 server/bridge.mjs 的调用点零改动。
//
// 语义更正（实测）：本判定**不影响是否执行/是否弹窗**，只决定弹窗里的风险等级文案
// （渲染层 src/hooks/useYFWCLI.ts 的 `risk: 'high' | 'medium'`）。是否审批由内核档位与
// kernel/blacklist.mjs 决定。⇒ 此前注释所称"与内核 destructiveCommandWarning.ts 同构"
// 已失效（该文件不存在），且该判定与内核判定实测有 52.7% 分叉——现由
// shared/high-risk.mjs 的规则标签 + shared/high-risk.test.mjs 的漂移锁统一管理。
//
// 归一化：trim + 剥掉首尾引号（与内核侧只 trim 不同，该差异刻意保留）。

import { matchesDangerSign, patternsFor } from '../shared/high-risk.mjs'

/** @deprecated 请改用 shared/high-risk.mjs 的 HIGH_RISK_RULES（带 id/group/tags/note）。
 *  此处仅为兼容既有导出形态而保留。 */
export const HIGH_RISK_PATTERNS = patternsFor('sign')

export { matchesDangerSign as matchesHighRisk } from '../shared/high-risk.mjs'

/** 供诊断：命中的规则 id 列表（替代过去"读两份清单猜"） */
export { matchedRuleIds } from '../shared/high-risk.mjs'
