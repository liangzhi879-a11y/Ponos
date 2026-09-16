'use strict'
// server/egress-policy.mjs —— ESM 转发层（**不含实现**）。
//
// 唯一实现在 `egress-policy.cjs`：出网判定必须被 ESM 侧（`server/bridge.mjs`，以及 S3 的同步链路）
// 与可能的 CJS 侧**共用同一份**——各写一份必然漂移，而漂移的后果是"某条路径绕过了闸门"，
// 属静默的安全退化（与 D2 令牌解析同理，见 `server/bridge-token.{mjs,cjs}`）。
export {
  EGRESS_TIERS,
  EGRESS_ENTITIES,
  SYNC_POLICY,
  EGRESS_MODE,
  EGRESS_REASON,
  authorizeEgress,
  listEgressPolicy,
} from './egress-policy.cjs'
