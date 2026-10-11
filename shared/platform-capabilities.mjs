// shared/platform-capabilities.mjs —— ESM 转发层（**不含实现**）。
//
// 唯一实现在 `platform-capabilities.cjs`：同一份能力判据要被 `kernel/*.mjs`、`server/*.mjs`（ESM 侧）
// 与 `electron/main.cjs`（CJS）共用 —— 两侧各写一份必然漂移，而漂移的后果是
// "能力层说可用、实际不可用"的静默半死（这正是本模块要消灭的形态）。
// CJS 双用先例见 `shared/egress-capability.cjs`/`.mjs`、`shared/proxy-config.cjs`/`.mjs`、
// `shared/vault-credential.cjs`/`.mjs`、`server/bridge-token.cjs`。
export { platformCapabilities, supports, describeDisabled, FAMILY_OF } from './platform-capabilities.cjs'
