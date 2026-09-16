'use strict'
// server/bridge-token.mjs —— ESM 转发层（**不含实现**）。
//
// 唯一实现在 `bridge-token.cjs`：令牌解析规则必须被 `server/bridge.mjs`（ESM）与
// `electron/main.cjs`（CJS）**共用同一份**——两侧各写一份会漂移，直接后果是 main 与桥的
// 令牌不一致，"接管遗留桥"时每个调用都回 401（应用半死）。CJS 双用先例见
// `server/yfw-home.cjs`、`electron/kernel-paths.cjs`。
//
// 保留 .mjs 入口是为了给 ESM 侧一个稳定路径（bridge.mjs 与本模块同等价的既有 import 不变）。
export {
  BRIDGE_TOKEN_ENV,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_TOKEN_FILE,
  bridgeTokenPath,
  resolveBridgeToken,
  isTokenValid,
  isTokenExemptPath,
  extractToken,
  authorizeBridgeRequest,
} from './bridge-token.cjs'
