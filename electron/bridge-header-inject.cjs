'use strict'
/**
 * 渲染层请求的桥令牌注入（2026-09-17 兼容性修复）
 *
 * 背景：S2-D2 的令牌闸（`server/bridge-token.cjs` 的 `authorizeBridgeRequest`）对"带 Origin"
 * 的请求走后一道来源白名单，对**无 Origin 又无令牌**的请求一律 401。实测（Electron 43.2.0 /
 * Chromium 150）：`file://` 页面发往 `http://127.0.0.1:<BRIDGE_PORT>` 的跨源 fetch **不再携带
 * Origin 头**——同一 URL 在系统 Chrome 上是 `Origin: null`（200 放行），在打包版 Electron 里
 * 完全没有 Origin（401，body `{"error":"Unauthorized"}`）。
 * 实测复现（`scratch/origin-probe/`）：系统 Chrome headless → `FETCH_STATUS=200`；
 * `electron.exe electron-probe.cjs`（Electron 43.2.0）→ `FETCH_STATUS=401`。
 * 后果是打包版渲染层的 HTTP 请求整体被拒：文件面板/知识库面板直接回显后端 error
 * （`[FileBrowser] error: Unauthorized`，见 `src/components/files/FileBrowser.tsx`）。
 * 渲染层有 58 处 fetch 散在 27 个文件，逐处改不现实 ⇒ 在 main 侧统一注入，
 * 与 `/boot-status`、WS 事件通道、诊断模块、桌宠用**同一枚**令牌。
 *
 * 安全边界：只对 host 精确等于 `127.0.0.1:<port>` 的 http(s)/ws(s) 请求注入，
 * 令牌绝不外泄给其它源；原先"无 Origin 无令牌即 401"的堵口性质（`<img>`/`<script>`/表单
 * 型 CSRF 面、本机其它进程）保持不变，D2 的收益不被削弱。
 *
 * 本模块保持**零 electron 依赖**：`createBridgeHeaderInjector` 是纯函数（便于单测），
 * `installBridgeTokenHeaderInjector` 只需一个鸭子类型的 session 对象。
 */

/** 与 `server/bridge-token.cjs` 的 BRIDGE_TOKEN_HEADER 保持一致（Node 侧 req.headers 已归一为小写）。 */
const DEFAULT_BRIDGE_TOKEN_HEADER = 'x-yfw-bridge-token'

const BRIDGE_PROTOCOLS = ['http:', 'https:', 'ws:', 'wss:']

/**
 * **不得注入令牌的 session 分区前缀**（2026-09-17 补）。
 *
 * 「应用智控」的内置浏览器用 `persist:automation-*` 分区（见 electron/app-session-key.cjs 与
 * electron/browser-executor.cjs），它加载的是**任意外部网站**。若把桥令牌也注入这些 session，
 * 那么用户在自动化浏览器里只要打开一个恶意页面，该页面请求 `http://127.0.0.1:<桥端口>/config`
 * 就会被**自动附带令牌** ⇒ 直接读到 provider 的 `authToken` 明文。
 * 这等于用"修 401"的方式新开一条窃密通道（外部站点原本因 `Origin: https://…` 不在白名单而
 * 拿 403），故必须排除。
 *
 * 判据用前缀而非全等：分区键随站点变化（`persist:automation-<key>`），且将来可能有多实例。
 */
const UNTRUSTED_SESSION_PARTITION_PREFIXES = ['persist:automation-']

/** 该 session 是否属于"会加载外部站点"的不受信分区。 */
function isUntrustedBridgeSession(session) {
  const partition = session && typeof session.partition === 'string' ? session.partition : ''
  return UNTRUSTED_SESSION_PARTITION_PREFIXES.some((prefix) => partition.startsWith(prefix))
}

/** 缺省"已装"集合：同一 session 被重复装时静默跳过（Electron 会以后注册的处理器覆盖先注册的）。 */
const defaultInstalledSessions = new WeakSet()

/**
 * 生成"按请求头注入令牌"的纯函数。
 * @param {{port: number|string, token: string, headerName?: string}} opts
 * @returns {(details: {url?: string, requestHeaders?: Record<string,string>}) => Record<string,string>}
 *          返回**新的**头对象（绝不原地改传入对象），非桥请求原样返回副本。
 */
function createBridgeHeaderInjector(opts = {}) {
  const { port, token } = opts
  const headerName = opts.headerName || DEFAULT_BRIDGE_TOKEN_HEADER
  const bridgeHost = `127.0.0.1:${port}`
  return function injectBridgeTokenHeader(details) {
    const headers = { ...((details && details.requestHeaders) || {}) }
    let hit = false
    try {
      const u = new URL((details && details.url) || '')
      hit = u.host === bridgeHost && BRIDGE_PROTOCOLS.includes(u.protocol)
    } catch { hit = false }
    if (!hit || !token) return headers
    // 调用方若已自带同名头（大小写不敏感），不覆盖
    const existing = Object.keys(headers).find((k) => k.toLowerCase() === headerName)
    if (!existing) headers[headerName] = token
    return headers
  }
}

/**
 * 给一个 Electron session 装上注入器；已装过的 session 不重复注册
 * （`onBeforeSendHeaders` 后注册会**覆盖**先注册的处理器，重复装等于白装前一次）。
 *
 * **不受信分区（加载外部站点的内置浏览器）一律拒绝安装**——理由见
 * `UNTRUSTED_SESSION_PARTITION_PREFIXES`，那是"修 401"必须避开的新增窃密面。
 *
 * @param {object} targetSession Electron Session（鸭子类型：需要 webRequest.onBeforeSendHeaders）
 * @param {{port: number|string, token: string, headerName?: string}} opts
 * @param {WeakSet<object>} [seen] 已装集合；缺省用模块级共享集合（调用方可自持一份以跨调用点共用）
 * @returns {boolean} 本次是否真的装上了
 */
function installBridgeTokenHeaderInjector(targetSession, opts = {}, seen = defaultInstalledSessions) {
  if (!targetSession || !targetSession.webRequest) return false
  if (typeof targetSession.webRequest.onBeforeSendHeaders !== 'function') return false
  if (isUntrustedBridgeSession(targetSession)) return false
  if (seen.has(targetSession)) return false
  seen.add(targetSession)
  const inject = createBridgeHeaderInjector(opts)
  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: inject(details) })
  })
  return true
}

module.exports = {
  DEFAULT_BRIDGE_TOKEN_HEADER,
  UNTRUSTED_SESSION_PARTITION_PREFIXES,
  isUntrustedBridgeSession,
  createBridgeHeaderInjector,
  installBridgeTokenHeaderInjector,
}
