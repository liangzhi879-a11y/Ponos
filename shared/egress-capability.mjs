// shared/egress-capability.mjs —— ESM 转发层（**不含实现**）。
//
// 唯一实现在 `egress-capability.cjs`：同一份判据要被 `server/bridge.mjs`、`server/knowledge-routes.mjs`
// 等 ESM 侧与（Task 2 起的）`electron/main.cjs`（CJS）共用 —— 两侧各写一份必然漂移，而漂移的后果是
// "闸的判据在两轨上不一致"，属于本仓明令禁止的形态（同一判据两份实现）。
// CJS 双用先例见 `shared/proxy-config.cjs`/`.mjs`、`server/bridge-token.cjs`、`server/egress-policy.cjs`。
export {
  EGRESS_CAPABILITY,
  CAPABILITY_MODES,
  EGRESS_REASONS,
  CAPABILITY_SOURCES,
  EGRESS_BOUNDARY,
  DEFAULT_CAPABILITIES,
  NEW_INSTALL_CAPABILITIES,
  normalizeCapabilities,
  capabilitiesOf,
  capabilitiesSource,
  droppedCapabilities,
  auditOf,
  decideEgress,
} from './egress-capability.cjs'
