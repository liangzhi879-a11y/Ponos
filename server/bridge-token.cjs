'use strict'
// server/bridge-token.cjs —— S2-D2 bridge 鉴权令牌的唯一实现（CJS：ESM 与 CJS 双用）。
//
// 为什么是 .cjs 而不是 .mjs：本模块必须被**两侧**共用——`server/bridge.mjs`（ESM）与
// `electron/main.cjs`（CJS）。若两侧各写一份，令牌解析规则会漂移，直接后果是"接管旧桥"
// 场景下 main 与桥的令牌不一致 → 桥对 main 的每个调用回 401（应用半死）。先例：
// `electron/kernel-paths.cjs`、`server/yfw-home.cjs` 同为 CJS 双用模块，桥已 `import` 它们。
//
// 为什么需要它（spec §6.2 D2）：桥原先只靠 `isAllowedOrigin()` 一道闸，而它的首行是
// `if (!origin) return true` —— **不带 Origin 头的请求一律放行**。于是 curl / node / python
// 可直接调 `/read-file` `/write-file` `/config`（含明文 provider token）；更隐蔽的是浏览器
// 的 `<img>` / `<script>` / 表单 GET **本身不发 Origin 头**，等于给任意网页留了 CSRF 触发面。
//
// 四条设计要点：
//   ① **fail-closed**：`expected` 为空一律判失败，绝不出现"没配 token 就不校验"的分支。
//   ② **timing-safe**：令牌是定长 hex，用 `timingSafeEqual` 比较，零成本地不留时序侧信道。
//   ③ **豁免面窄到必须**：只有登录屏端点与就绪探针免 token（逐条理由见 isTokenExemptPath）。
//   ④ **令牌跨重启稳定**：优先 env（Electron main 注入），否则复用已有落盘文件，最后才新生成——
//      这样 main 重启后可继续与"上一实例遗留/手工启动的桥"用同一令牌（接管逻辑不被 401 打断）。

const { randomBytes, timingSafeEqual } = require('crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } = require('fs')
const { join, dirname } = require('path')

/** 由启动方（Electron main）注入的令牌环境变量；缺省时桥自生成并落盘。 */
const BRIDGE_TOKEN_ENV = 'YFW_BRIDGE_TOKEN'
/** HTTP/WS 客户端携带令牌的头名（小写：Node 的 req.headers 已归一为小写）。 */
const BRIDGE_TOKEN_HEADER = 'x-yfw-bridge-token'
/** 令牌落盘文件名（位于 `<home>/runtime/`，与内核 bootstrap 的 runtime 目录同源）。 */
const BRIDGE_TOKEN_FILE = 'bridge-token'

function bridgeTokenPath(home) {
  return join(home, 'runtime', BRIDGE_TOKEN_FILE)
}

/**
 * 解析本次进程使用的令牌。
 *
 * 优先级：env（Electron main 注入，产品路径）→ 已有落盘文件（跨重启/跨进程稳定，让
 * "接管遗留桥"仍可工作）→ 新生成并落盘。
 * **无论走哪条路径，调用方都必须把闸门开在"校验"档**——本函数只回答"令牌是什么"，
 * 不表达"是否启用鉴权"，以免出现条件式放行的分支（见文件头 ①）。
 *
 * 落盘失败（只读介质/权限）不影响鉴权：进程内令牌仍有效，只是外部客户端拿不到。
 */
function resolveBridgeToken({ home, env = process.env, onGenerated = null } = {}) {
  const fromEnv = env[BRIDGE_TOKEN_ENV]
  if (fromEnv && String(fromEnv).trim()) {
    return { token: String(fromEnv).trim(), source: 'env', path: null }
  }
  const file = bridgeTokenPath(home)
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing) return { token: existing, source: 'file', path: file }
    }
  } catch { /* 读不出就当没有：继续走生成分支 */ }
  const token = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, token + '\n', { mode: 0o600 })
    // Windows 对 mode 支持有限；POSIX 上确保不是 644（同机其它账号可读）
    try { chmodSync(file, 0o600) } catch { /* 平台不支持则忽略 */ }
    if (onGenerated) onGenerated(file)
  } catch { /* 落盘失败：进程内鉴权照常（fail-closed） */ }
  return { token, source: 'generated', path: file }
}

/** 定长令牌的常量时间比较；`expected` 缺省一律失败（fail-closed）。 */
function isTokenValid(given, expected) {
  if (!expected || typeof given !== 'string' || given.length === 0) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(String(expected), 'utf8')
  if (a.length !== b.length) return false
  try { return timingSafeEqual(a, b) } catch { return false }
}

/**
 * 免 token 的路径（豁免面**只允许**这两类，新增前先问"它是否在登录/就绪之前就必须可用"）：
 *   - `/api/auth/*`：登录屏端点在"用户还没登录"时就要能用（spec 明令 auth 小窗语义不破）；
 *     且它们是本地 scrypt 口令 + 锁定策略的既有面，不因 D2 改变。
 *   - `/health`：就绪探针，响应体仅 `{status:'ok',pid}`，无任何敏感数据。若把它也上锁，
 *     "桥没起来"与"token 没配上"会退化成同一种现象（探针失败），启动故障无法归因。
 */
function isTokenExemptPath(pathname) {
  if (!pathname) return false
  if (pathname === '/health') return true
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/')
}

/** 从请求取令牌：先头（Node/ws/py 客户端），再 URL query（浏览器 WS 无法自定义 header 时的退路）。 */
function extractToken(req) {
  const h = req && req.headers ? req.headers[BRIDGE_TOKEN_HEADER] : null
  if (typeof h === 'string' && h) return h
  try {
    const u = new URL((req && req.url) || '/', 'http://127.0.0.1')
    const q = u.searchParams.get('token')
    if (q) return q
  } catch { /* URL 异常按未携带处理 */ }
  return null
}

/**
 * 不透明来源判定（2026-09-17 安全修复）。
 *
 * `Origin: null` 是规范对**不透明来源（opaque origin）**的序列化：`<iframe sandbox>`（不含
 * `allow-same-origin`）、`data:` / `blob:` 文档、跨源重定向后的来源都会得到它。它**不是可信
 * 凭据**——任意网页都能自造一个，而且只要响应带上 `ACAO: null`，攻击者连响应都能读回。
 *
 * 实测（2026-09-17，重启后的真实实例；请求仅带 `Origin: null`、不带任何令牌）：
 * `/config` → **200**（响应含 4 个 provider 的 `authToken` 明文，长度 35/125/43/35）、
 * `/list-dir` → 200、`OPTIONS` 预检 → **204** 且回显 `ACAO: null` +
 * `Allow-Methods: GET, POST, PUT, PATCH, DELETE` ⇒ 读写皆可。这正是"任意网页窃取 API 密钥"
 * 的完整利用链，故本函数把不透明来源与"无 Origin"同等对待：**一律必须持令牌**。
 *
 * 另需澄清一个历史误解：D2 落地时把 `Origin: null` 当作"打包版渲染层的形态"而放行，实测证明
 * **打包版渲染层从不发 `Origin: null`**——`file://` 页面的 `fetch` **不带 Origin**（这正是同日
 * 401 故障的成因），其 `WebSocket` 握手带 `Origin: file://`；
 * 而 `Origin: null` 恰恰是**攻击者**（沙箱 iframe）的形态。原断言见
 * `server/bridge-auth-token.test.mjs`（已随之更正）。
 */
function isOpaqueOrigin(origin) {
  return typeof origin === 'string' && origin.trim().toLowerCase() === 'null'
}

/**
 * D2 闸门（HTTP 与 WS 共用一条判定，避免两处语义漂移）。
 *
 * 语义严格照 spec §6.2 D2：**无 Origin 头 / 非浏览器客户端必须持 token**；带 Origin 的请求
 * 继续交给 `isAllowedOrigin()`（白名单降级为"第二道"——它不再是唯一一道）。
 *
 * 为什么"带 Origin 就不查 token"是**契约要求**而非妥协：dev 形态的 GUI 跑在普通浏览器里
 * （`bin/cli.mjs` 打开 `http://localhost:5197`），它**无法**接受 main 侧注入的 token；而渲染层
 * 有 58 处 fetch 散在 27 个文件。若改成"带 Origin 也查 token"，就必须改渲染层全量 fetch 并让
 * dev 形态失去可用性——超出 D2 文档要求（残留风险见 docs/superpowers/plans/2026-09-16-s2-d2-bridge-token.md §6）。
 *
 * **该免检的前提是"来源本身不可伪造"**（浏览器只会填文档自己的来源）。不透明来源
 * （`Origin: null`）天然不满足这个前提，故走下面的 token 闸——见 `isOpaqueOrigin`。
 *
 * 注意 `origin` 为空串时同样按"无 Origin"处理：原始的 `Origin: ` 空值若不进 token 闸，就是一
 * 个可被构造的旁路（`isAllowedOrigin('')` 因 `!origin` 返回 true）。
 */
function authorizeBridgeRequest(req, token) {
  const origin = req && req.headers ? req.headers.origin : undefined
  // 不可伪造的来源才免检；不透明来源（null）与缺头/空串一样，必须持令牌
  if (origin && !isOpaqueOrigin(origin)) return { ok: true, via: 'origin' }
  let pathname = ''
  try { pathname = new URL((req && req.url) || '/', 'http://127.0.0.1').pathname } catch { pathname = '' }
  if (isTokenExemptPath(pathname)) return { ok: true, via: 'exempt' }
  if (isTokenValid(extractToken(req), token)) return { ok: true, via: 'token' }
  // 401 一律同一结果（不区分"缺失/错误"、不回显期望值），避免给探测者信息
  return { ok: false, via: 'denied' }
}

module.exports = {
  BRIDGE_TOKEN_ENV,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_TOKEN_FILE,
  bridgeTokenPath,
  resolveBridgeToken,
  isTokenValid,
  isTokenExemptPath,
  extractToken,
  isOpaqueOrigin,
  authorizeBridgeRequest,
}
