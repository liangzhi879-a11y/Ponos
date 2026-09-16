'use strict'
// server/test-bridge-auth.mjs —— 既有回归网用的测试令牌（S2-D2 配套，**仅测试**使用）。
//
// 为什么需要它：D2 之后"不带 Origin 头的请求必须持 token"（`server/bridge-token.mjs`），而
// 测试里的 `fetch` / `ws` / `http.get` 客户端都是**无 Origin 的本机客户端**——它们必须像真实
// 客户端（Electron 主进程、桌宠）一样携带令牌，否则一律 401。
//
// 为什么固定值就够：测试桥是独立子进程、随机端口、只绑回环、临时 home；令牌只用于标识
// "本测试就是这个桥的合法客户端"，不存在跨实例复用问题。用固定值也让失败信息可读。
//
// 用法（三种客户端形态）：
//   1) spawn 子进程桥：   env 里加 `YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN`（或套 `bridgeEnv({...})`）
//   2) 进程内 import 桥： **必须在 import 之前** `process.env.YFW_BRIDGE_TOKEN = TEST_BRIDGE_TOKEN`
//      （`bridge.mjs` 在模块求值时解析令牌；顺序错了就会自生成 + 落盘，测试将拿不到令牌）
//   3) 请求侧：           HTTP/WS 用 `withToken(url)` 追加 `?token=`，或用 `authHeaders({...})` 传头
// 新增/修改测试时请沿用同一常量，不要在文件里另写字面量。

export const TEST_BRIDGE_TOKEN = 'yfw-test-bridge-token-0123456789abcdef'

/** 给 spawn 的 env 对象补上测试令牌（保持其它键不变）。 */
export function bridgeEnv(extra = {}) {
  return { ...extra, YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN }
}

/** 请求头：给 fetch/http 客户端用（`x-yfw-bridge-token` 是桥认的正式头名）。 */
export function authHeaders(extra = {}) {
  return { 'x-yfw-bridge-token': TEST_BRIDGE_TOKEN, ...extra }
}

/** URL：追加 `?token=`（已有 query 时用 `&`）。WS 客户端无法自定义 header 时的通用退路。 */
export function withToken(url) {
  const sep = String(url).includes('?') ? '&' : '?'
  return `${url}${sep}token=${TEST_BRIDGE_TOKEN}`
}
