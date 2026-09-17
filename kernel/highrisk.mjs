// Ponos-turbo 高危命令匹配（Bash 权限审批触发判定）
// ---------------------------------------------------------------------------
// **薄转发**（2026-09-17 · P1-2）：pattern 清单已收敛到 `shared/high-risk.mjs`（单一真源），
// 此处只保留原公开 API `matchesHighRisk`，使既有调用点（kernel/permissions.mjs、
// kernel/tools.mjs）与测试**零改动**。
//
// 语义：命中 ⇒ 触发 `can_use_tool` 审批（"要不要问用户"）。归一化只做 trim（**不剥引号**，
// 与桥侧不同——该差异是刻意的，见 shared/high-risk.mjs 文件头与 shared/high-risk.test.mjs）。
// 与 `kernel/blacklist.mjs` 的分工不变：highrisk 回答"要不要问"（档位可放宽），
// blacklist 回答"要不要一票否决"（灾难级，档位不能放宽）。

export { matchesApprovalTrigger as matchesHighRisk } from '../shared/high-risk.mjs'
