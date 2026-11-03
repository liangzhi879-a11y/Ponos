// shared/vault-credential.mjs —— ESM 转发层（**不含实现**）。
//
// 唯一实现在 `vault-credential.cjs`：凭据的落盘形态必须被 `electron/main.cjs`（CJS，迁移时写盘）
// 与 `server/bridge.mjs`（ESM，按形态识别/打码/回填）**共用同一份**。转发层的必要性见
// `shared/proxy-config.mjs` 的模块头（同一理由：两侧各写一份 ⇒ 形态漂移 ⇒ 静默失效）。
export {
  ENC_VERSION,
  REDACTED_TOKEN,
  SETTINGS_CREDENTIAL_ENV_KEYS,
  providerTokenVaultKey,
  legacySettingsVaultKey,
  isVaultPointer,
  vaultPointer,
  plainTokenOf,
  isRedactedToken,
  redactProviderToken,
  redactProviderTokens,
  restoreRedactedProviderTokens,
} from './vault-credential.cjs'
