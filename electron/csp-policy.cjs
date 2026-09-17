/**
 * 应用外壳的 CSP（P0-4 · 2026-09-17 桥文件面加固）
 *
 * 背景：`index.html` 原先**没有任何 CSP**，且运行时外链 Google Fonts。
 * 后果：一旦有任何一处注入（转换器转义被绕过、新增未转义路径），脚本即无约束执行；
 * 而验证过的两处 `dangerouslySetInnerHTML`（FileEditor/FilePreview）就依赖转换器转义这一道防线。
 *
 * 为什么用主进程注入而不是 `<meta>`：meta 版的 CSP **不支持 Report-Only**，无法"先观察违规再切强制"。
 * 实测（S8 + S9 探针，Electron 43）：
 *   · `onHeadersReceived` **能拦截 `file://` 的 mainFrame**（S8）；
 *   · 注入后**加载正常**，且功能性验证通过（S9 干净进程）：页面捕获到
 *     `script-src-elem :: inline` 与 `script-src :: eval` 两条违规 ⇒ 策略确实拦下内联脚本与 eval；
 *     同时 **外部 `file:` 脚本仍被放行** ⇒ 不会打断打包态外壳自身的 ES module。
 *   · report-only 模式下页面照常加载（只报告不阻断），这正是默认模式的安全之处。
 *   ⚠️ 探针里"同一会话连续二次导航"会得到 `ERR_FAILED (-2)` 的**伪影**，勿据此判定注入有害
 *     （已在干净进程复验：注入非原因）。
 *
 * 只作用于**外壳文档**（渲染层来源），**不碰桥的 `/raw-file`**：
 * 预览载荷是用户/技能生成的 HTML，会合法引用 CDN（`skills/space-generative-art/.../viewer.html` 的
 * p5.js），套严格 `script-src` 会直接打断它。预览载荷的隔离由**桥响应的**
 * `Content-Security-Policy: sandbox allow-scripts` 负责（见 server/bridge.mjs 的 /raw-file）。
 *
 * 模式（YFW_CSP_MODE）：
 *   - `off`            ：不注入（应急回滚）
 *   - `report`（默认）  ：`Content-Security-Policy-Report-Only`——只报违规，不影响功能。
 *                        **刻意默认 report**：开发态 vite/react-refresh 会注入内联脚本、
 *                        `file://` 下 `'self'` 的匹配语义也与 http 不同，直接 enforce 有把
 *                        外壳整片打死的风险，先收集一天真实违规再收紧。
 *   - `enforce`        ：正式生效。**必须在打包产物上回归验证后再启用**（见文末说明）。
 *
 * 已知待收紧项（如实记录，避免误以为已达最优）：
 *   - `style-src 'unsafe-inline'` 去不掉：CodeMirror 的 style-mod 在 document 上 mount 时
 *     走 `createElement('style')` + `textContent`（node_modules/style-mod/src/style-mod.js:100/135），
 *     CM6 不传 nonce。风险远低于 `script-src 'unsafe-inline'`。
 *   - 为兼容 `file://` 外壳，`script-src`/`style-src` 需含 `file:`（file URL 在 Chromium 下是
 *     opaque origin，`'self'` 不一定匹配）。这削弱了 CSP 的强度——**enforce 前应在打包产物上
 *     确认能否只用 `'self'`**。
 *   - Google Fonts 仍是外链（本地化会改变字体外观，属产品可见变更，待定）；
 *     故策略里放行 fonts.googleapis.com / fonts.gstatic.com，不阻断现有外观。
 */

const DEFAULT_CSP_MODE = 'report'

const SHELL_CSP_DIRECTIVES = {
  // 默认拒绝一切，再按需放开（比"逐条禁止"更难出错）
  'default-src': ["'none'"],
  // 'self' 覆盖打包态与 dev 源的模块脚本；file: 是为 file:// 外壳兜底
  'script-src': ["'self'", 'file:'],
  'style-src': ["'self'", "'unsafe-inline'", 'file:', 'https://fonts.googleapis.com'],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
  'media-src': ["'self'", 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  // 桥（HTTP + WS）与 dev server 的 HMR（ws）
  'connect-src': [
    "'self'",
    'http://127.0.0.1:51517', 'ws://127.0.0.1:51517',
    'http://localhost:51517', 'ws://localhost:51517',
    'http://localhost:5197', 'ws://localhost:5197',
    'http://127.0.0.1:5197', 'ws://127.0.0.1:5197',
  ],
  // 预览 iframe 指向桥；cockpit 等本地资产来自 file:
  'frame-src': ['http://127.0.0.1:51517', 'http://localhost:51517', 'file:'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'none'"],
}

/** 序列化策略为 CSP 头值（导出以便单测/校验） */
function buildShellCsp(directives = SHELL_CSP_DIRECTIVES) {
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ')
}

/** 解析模式；非法值回落到 report（安全默认） */
function resolveCspMode(env = process.env.YFW_CSP_MODE) {
  const v = String(env || '').toLowerCase()
  return v === 'off' || v === 'report' || v === 'enforce' ? v : DEFAULT_CSP_MODE
}

/** 该请求是否"应用外壳文档"（只对外壳注入，不碰桥的预览载荷） */
function isShellDocument(details) {
  if (!details || details.resourceType !== 'mainFrame') return false
  const url = String(details.url || '')
  if (url.startsWith('file:')) return true
  // dev 态：vite 提供的文档
  return /^https?:\/\/(localhost|127\.0\.0\.1):(5197|4197)\//.test(url)
}

/**
 * 给 session 安装外壳 CSP 注入。
 * @param {object} session Electron session
 * @param {{mode?: string}} [opts]
 * @returns {boolean} 是否安装
 */
function installShellCsp(session, opts = {}) {
  const mode = resolveCspMode(opts.mode ?? process.env.YFW_CSP_MODE)
  if (mode === 'off') return false
  const headerName = mode === 'enforce'
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only'
  const value = buildShellCsp(opts.directives)
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!isShellDocument(details)) return callback({})
    callback({ responseHeaders: { ...(details.responseHeaders || {}), [headerName]: [value] } })
  })
  return true
}

module.exports = {
  DEFAULT_CSP_MODE,
  SHELL_CSP_DIRECTIVES,
  buildShellCsp,
  resolveCspMode,
  isShellDocument,
  installShellCsp,
}
