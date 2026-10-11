// shared/proxy-config.mjs —— ESM 转发层（**不含实现**）。
//
// 唯一实现在 `proxy-config.cjs`：代理参数必须被 `electron/main.cjs`（CJS，同步启动桥时就要算 env）
// 与 `server/bridge.mjs`（ESM）**共用同一份** —— 两侧各写一份会漂移，而漂移的后果是
// "回环白名单漏一处 ⇒ 应用连不上自己的桥"（错误信息指向代理端口，完全不提代理）。
// CJS 双用先例见 `server/bridge-token.cjs`、`shared/browser-whitelist-host.cjs`。
export {
  PROXY_MODES,
  PROXY_PROTOCOLS,
  LOOPBACK_BYPASS,
  REDACTED_PASSWORD,
  normalizeBypassList,
  bypassListWithLoopback,
  normalizeProxyConfig,
  nodeProxyEnv,
  chromiumProxyOptions,
  redactProxyUrl,
  isRedactedProxyUrl,
  restoreRedactedProxyUrl,
  redactProxyConfig,
  mergeProxyPatch,
} from './proxy-config.cjs'
