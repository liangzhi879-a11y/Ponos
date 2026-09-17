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

// 分区字符串的唯一出处是 app-session-key.cjs（见该文件的治理注释与 kernel-tests 的
// "分区字符串不得在别处手写" 断言：手写前缀一旦与真实分区不符，会静默落到别的分区、
// 症状是 Cookie 读空 → 误判"未登录"）。这里**不写字面量**，从前缀常量派生。
// 注意别用 `partitionFor('')`：那会带上默认键（`app-probe`），得到的不是前缀。
const { SESSION_PARTITION_PREFIX } = require('./app-session-key.cjs')

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
const UNTRUSTED_SESSION_PARTITION_PREFIXES = [SESSION_PARTITION_PREFIX]

/** 该 session 是否属于"会加载外部站点"的不受信分区。 */
function isUntrustedBridgeSession(session) {
  const partition = session && typeof session.partition === 'string' ? session.partition : ''
  return UNTRUSTED_SESSION_PARTITION_PREFIXES.some((prefix) => partition.startsWith(prefix))
}

/** 缺省"已装"集合：同一 session 被重复装时静默跳过（Electron 会以后注册的处理器覆盖先注册的）。 */
const defaultInstalledSessions = new WeakSet()

/**
 * **只对"可信发起帧"注入令牌**（2026-09-17 FS 加固 · D2-2）。
 *
 * 背景：本模块原先"只看目标 host 是桥，就注入令牌"——不看**谁**发起的请求。而
 * `src/components/editor/FileEditor.tsx` 的 HtmlPreview 用
 * `sandbox="allow-scripts allow-same-origin"` 从 `/raw-file` 载入**用户任意 HTML**，
 * 该文档的 origin 就是桥本身 ⇒ 其中内联脚本发出的请求会被注入令牌，配合文件端点
 * 即可任意读写本机文件。**去掉 `allow-same-origin` 不足以修复**：文档变 opaque（Origin: null）
 * 后仍需令牌，而注入器照样补上；且 `fetch(..., { mode:'no-cors' })` 不读响应，CORS 拦不住副作用。
 *
 * 判据为何用 `details.frame.origin` 而非 `details.initiator`：**实测（Electron 43.2.0）**
 * `onBeforeSendHeaders` 的 details **没有 `initiator` 字段**（值为 undefined），
 * 而 `details.frame.origin` 可用且能干净区分三种情形（脚本见 scratch 的 S7 探针）：
 *   · 打包态主窗口（`file://` 文档）      → `'file://'`      ← 可信
 *   · 桥源文档自身（保留 same-origin 的预览）→ `'http://127.0.0.1:<桥端口>'` ← 不受信
 *   · 去掉 same-origin 的沙箱 iframe        → `'null'`（opaque）        ← 不受信
 *
 * 兼容性：`trustedFrameOrigins` **未提供时不改变行为**（仍按 host 注入），保证现有调用点
 * 与灰度可控；main 侧传入清单后才真正收紧。`frame` 缺失（非帧发起的请求）时按**可信**处理
 * 并告警一次——宁可保留现状也不误伤主窗口（实测 XHR/fetch 均带 frame 信息）。
 *
 * @param {{port: number|string, token: string, headerName?: string, trustedFrameOrigins?: string[]}} opts
 * @returns {(details: object) => Record<string,string>}
 *          返回**新的**头对象（绝不原地改传入对象），非桥请求原样返回副本。
 */
function createBridgeHeaderInjector(opts = {}) {
  const { port, token } = opts
  const headerName = opts.headerName || DEFAULT_BRIDGE_TOKEN_HEADER
  const bridgeHost = `127.0.0.1:${port}`
  const trusted = Array.isArray(opts.trustedFrameOrigins) && opts.trustedFrameOrigins.length
    ? new Set(opts.trustedFrameOrigins.filter((o) => typeof o === 'string' && o !== '').map((o) => normalizeOrigin(o)))
    : null
  let warnedMissingFrame = false
  return function injectBridgeTokenHeader(details) {
    const headers = { ...((details && details.requestHeaders) || {}) }
    let hit = false
    try {
      const u = new URL((details && details.url) || '')
      hit = u.host === bridgeHost && BRIDGE_PROTOCOLS.includes(u.protocol)
    } catch { hit = false }
    if (!hit || !token) return headers

    // D2-2：可信发起帧判定（仅在显式配置时生效）
    if (trusted) {
      const frameOrigin = details && details.frame ? details.frame.origin : undefined
      if (frameOrigin === undefined) {
        if (!warnedMissingFrame) {
          warnedMissingFrame = true
          console.warn('[bridge-inject] 请求缺少 frame 信息，按可信处理（保持既有行为）:', (details && details.url) || '')
        }
      } else if (!isTrustedFrameOrigin(frameOrigin, trusted)) {
        // 不受信发起者（opaque 沙箱 / 桥源上的预览内容）：**不注入令牌** ⇒ 服务端 401
        return headers
      }
    }

    // 调用方若已自带同名头（大小写不敏感），不覆盖
    const existing = Object.keys(headers).find((k) => k.toLowerCase() === headerName)
    if (!existing) headers[headerName] = token
    return headers
  }
}

/**
 * origin 归一。
 * ⚠️ 不能用"剥尾斜杠"实现：`file://` 的尾 `//` 是 scheme 的一部分，剥掉会变成 `file:`，
 * 与 Electron 报出的 `file://` 不匹配 ⇒ **主窗口将拿不到令牌、全盘 401**（本函数曾被此坑咬过，
 * 现由 electron/bridge-frame-trust.test.mjs 钉住）。
 * 故优先走 URL 规范化：`file:` → 固定 `file://`；http(s) → `origin`（自带小写 + 去尾斜杠）。
 * 非法输入（如 `null`）走 fallback 原样小写。
 */
function normalizeOrigin(o) {
  const s = String(o == null ? '' : o).trim()
  if (s === '') return ''
  try {
    const u = new URL(s)
    if (u.protocol === 'file:') return 'file://'
    return u.origin.toLowerCase()
  } catch {
    return s.replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * 该发起帧 origin 是否可信。
 * **`'null'`/空/opaque 一律不可信**——这是本函数的全部意义所在，故显式硬编码拒绝，
 * 即使调用方误把它写进清单也不放行。
 */
function isTrustedFrameOrigin(frameOrigin, trustedSet) {
  const o = normalizeOrigin(frameOrigin)
  if (o === '' || o === 'null') return false
  return trustedSet.has(o)
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
  isTrustedFrameOrigin,
  createBridgeHeaderInjector,
  installBridgeTokenHeaderInjector,
}
