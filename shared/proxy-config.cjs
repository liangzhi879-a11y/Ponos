'use strict'
/**
 * 网络代理策略的**唯一实现**（P1「应用内增加网络VPN代理配置功能」，2026-09-17）。
 *
 * 为什么必须"唯一实现"：代理有两个消费者、两条轨道，各算一份必然漂移 ——
 *   · **Node 轨**：桥进程自身出网（provider 探测用的是 `https.get`）+ 它派生的
 *     内核/Bash/MCP 子进程（经 `HTTP_PROXY` 系列 env，由 Node 24 的
 *     `NODE_USE_ENV_PROXY=1` 开关统一生效）
 *   · **Chromium 轨**：Electron 各 session（`defaultSession` 主窗口 + 内置浏览器/自动化分区），
 *     走 `session.setProxy`。实测这两轨**互不影响**（带 env 开关时主进程 fetch 走代理、
 *     但同一次请求不受 `setProxy` 影响），故必须分别下发。
 *
 * 本项最严重的失败模式是"**把自己代理掉**"：回环（桥自身 `127.0.0.1:<port>`）若进了代理，
 * 应用会连不上自己的后端，而报错是"指向代理端口的 `ECONNREFUSED`"、完全不提代理，极难定位。
 * ⇒ **回环由代码强制并入绕过列表，且不可被用户配置覆盖**（有反向断言锁死）。
 *
 * 为什么放 `shared/` 且以 CJS 实现：`electron/main.cjs` 是 CJS，且要在**同步**启动桥时
 * 立即算出 env（`await import()` 用不上）；`server/bridge.mjs` 是 ESM。⇒ CJS 唯一实现 +
 * ESM 转发层（`proxy-config.mjs`），与 `server/bridge-token.cjs`、`shared/browser-whitelist-host.cjs` 同构。
 */

/** 三档代理模式：off（默认，零行为变化）| system（只作用于 Chromium 轨）| manual（两轨都生效）。 */
const PROXY_MODES = ['off', 'system', 'manual']

/**
 * 允许的代理协议。
 * `socks5` 在 Node 侧为**实验性**支持（实测生效并打 `ExperimentalWarning`），UI 需注明；
 * Chromium 轨对 socks5 是正式支持。两个都放行，但**不允许** socks4/pac：前者 Node 侧不支持、
 * 后者是另一套语义（PAC 脚本），不在本项范围。
 */
const PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:']

/**
 * 强制绕过的回环地址（IPv4 / 主机名 / IPv6）。用户**只能追加**，改不掉这三项。
 * 少一项就可能是"应用连不上自己的桥"这类生产事故。
 */
const LOOPBACK_BYPASS = ['127.0.0.1', 'localhost', '::1']

/** 回显给界面的密码占位（保存时按磁盘现值回填，见 restoreRedactedProxyUrl）。 */
const REDACTED_PASSWORD = '***'

/** 逗号分隔（或数组）→ 去空白、去空项、按大小写不敏感去重后的数组。 */
function normalizeBypassList(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(',')
  const out = []
  for (const item of raw) {
    const s = String(item == null ? '' : item).trim()
    if (!s) continue
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) continue
    out.push(s)
  }
  return out
}

/** 用户绕过项 ∪ **强制回环**（用户项在前：界面上看到的顺序与用户输入一致）。 */
function bypassListWithLoopback(bypass) {
  const out = normalizeBypassList(bypass)
  for (const item of LOOPBACK_BYPASS) {
    if (!out.some((x) => x.toLowerCase() === item.toLowerCase())) out.push(item)
  }
  return out
}

/**
 * 解析代理地址；非法返回 null（**绝不"尽力而为"地猜**）。
 * 只接受 `scheme://[user:pass@]host[:port]`：
 *   · 协议必须在 PROXY_PROTOCOLS 内
 *   · 必须有 hostname
 *   · **不得带路径/查询/片段** —— 带路径的值几乎必然是从浏览器地址栏复制错了
 *     （如 `http://127.0.0.1:7890/dashboard`）；它会被原样塞进 `HTTP_PROXY`，
 *     Node 侧解析失败后**静默直连**，症状是"配了代理却没走"，比直接报错难查得多。
 */
function parseProxyUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let u
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (!PROXY_PROTOCOLS.includes(u.protocol.toLowerCase())) return null
  if (!u.hostname) return null
  if (u.pathname && u.pathname !== '/') return null
  if (u.search || u.hash) return null
  return u
}

/**
 * 归一代理配置。
 *
 * 返回值形状：`{ ok, value, error? }`，`value` **恒为**完整形状 `{mode, url, bypass}`：
 *   · `ok:false` 时 `value` 取**安全默认**（`mode:'off'`、不代理）——调用方据此不注入任何代理变量，
 *     但**必须把 `error` 说出来**（打印警告/界面报错）。
 *   · **刻意不"静默降级为 off 且无声"**：那会让用户以为配好了、实际全走直连，
 *     且症状（模型调用超时/失败）与代理无关，排障成本极高。
 *
 * `bypass` 归一为逗号分隔字符串（不是数组）：它要原样落盘回 `config.json` 供用户编辑。
 */
function normalizeProxyConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const bypass = normalizeBypassList(src.bypass).join(',')
  const rawMode = src.mode
  const mode = rawMode == null || rawMode === '' ? 'off' : String(rawMode).trim().toLowerCase()
  if (!PROXY_MODES.includes(mode)) {
    return {
      ok: false,
      error: `未知的代理模式 ${JSON.stringify(rawMode)}（可选 off / system / manual）`,
      value: { mode: 'off', url: '', bypass },
    }
  }
  if (mode !== 'manual') {
    // system / off 都不需要 url：**保留**用户可能已填的 url 会让"切回 manual 时值还在"，
    // 但这里 value 是给 env/Chromium 计算用的，url 不参与 ⇒ 归空，避免调用方误用。
    return { ok: true, value: { mode, url: '', bypass } }
  }
  const url = typeof src.url === 'string' ? src.url.trim() : ''
  if (!url) {
    return {
      ok: false,
      error: 'manual 模式必须填写代理地址（形如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）',
      value: { mode: 'off', url: '', bypass },
    }
  }
  if (!parseProxyUrl(url)) {
    return {
      ok: false,
      error: `代理地址无效：${url}（需 scheme://[用户名:密码@]主机:端口，支持 http / https / socks5）`,
      value: { mode: 'off', url: '', bypass },
    }
  }
  return { ok: true, value: { mode, url, bypass } }
}

/**
 * **Node 轨**：产出要注入进程 env 的代理变量补丁（**只含补丁，不含 baseEnv**）。
 *
 * 三条硬性约定：
 *  ① `off` / `system` / 非法 ⇒ 返回**空对象**（一个变量都不注入）。
 *     尤其 `system`：Node 没有跨平台读取系统代理的标准 API（Windows 读注册表、macOS `scutil`、
 *     Linux gsettings）。v1 **不猜** —— 宁可让用户填 manual，也不做"看起来能跟随、其实只有一半生效"
 *     的半吊子功能（那会让 WebFetch 直连、模型调用走代理，是最难查的组合）。
 *  ② 大小写各注入一份：读 `HTTP_PROXY` 与读 `http_proxy` 的工具链都存在（Node 自身两种都认）。
 *  ③ `NO_PROXY` 恒含回环（用户 bypass 只能追加）。
 *
 * 调用方负责合并顺序：`{ ...process.env, ...nodeProxyEnv(cfg) }` —— 让**应用配置覆盖**外部 env，
 * 行为才可预期（反之"我明明关了代理却还在走"同样无法解释）。
 */
function nodeProxyEnv(raw) {
  const norm = normalizeProxyConfig(raw)
  if (!norm.ok || norm.value.mode !== 'manual') return {}
  const url = norm.value.url
  const noProxy = bypassListWithLoopback(norm.value.bypass).join(',')
  return {
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

/**
 * **Chromium 轨**：产出 `session.setProxy` 的入参。
 *
 *  · `off` / 非法 ⇒ **返回 null = 不要调用 setProxy**。刻意不返回 `{mode:'direct'}`：
 *    Chromium 默认跟随系统代理，主动设 direct 会**改掉**用户系统层面的代理设置，
 *    违反"off 与本方案落地前行为逐字节一致"这条验收基线（不干预 ≠ 强制直连）。
 *  · `system` ⇒ `{ mode: 'system' }`（唯一的"跟随系统"通道，Node 轨明确不支持，见 nodeProxyEnv）。
 *  · `manual` ⇒ `{ proxyRules, proxyBypassRules }`（Electron 见 proxyRules 即按固定服务器代理）。
 */
function chromiumProxyOptions(raw) {
  const norm = normalizeProxyConfig(raw)
  if (!norm.ok) return null
  if (norm.value.mode === 'off') return null
  if (norm.value.mode === 'system') return { mode: 'system' }
  return {
    proxyRules: norm.value.url,
    proxyBypassRules: bypassListWithLoopback(norm.value.bypass).join(','),
  }
}

/** 拆出 `scheme://user:pass@rest` 三段；无凭据返回 null。纯字符串处理，**不重建 URL**
 *  （重建会给无尾斜杠的地址补上 `/`，令"保存后与用户输入看起来不一样"）。 */
function splitCredentials(url) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@]*)@(.+)$/.exec(String(url == null ? '' : url))
  if (!m) return null
  const scheme = m[1]
  const userinfo = m[2]
  const rest = m[3]
  const idx = userinfo.indexOf(':')
  if (idx < 0) return { scheme, user: userinfo, pass: null, rest }
  return { scheme, user: userinfo.slice(0, idx), pass: userinfo.slice(idx + 1), rest }
}

/**
 * 密码脱敏（回显给界面/写日志前调用）。
 * 为什么需要：代理 URL 允许 `user:pass@`，而 `/config` 会被 GUI 全量读出、
 * 也可能出现在日志/截图/备份里。无凭据或拆不出凭据时**原样返回**（不改写用户输入）。
 */
function redactProxyUrl(url) {
  const c = splitCredentials(url)
  if (!c || c.pass === null || c.pass === '') return String(url == null ? '' : url)
  return `${c.scheme}${c.user}:${REDACTED_PASSWORD}@${c.rest}`
}

/** 该值是否为"密码已被打码"的形态（保存回填的判定依据）。 */
function isRedactedProxyUrl(url) {
  const c = splitCredentials(url)
  return !!(c && c.pass === REDACTED_PASSWORD)
}

/**
 * 保存时把打码密码回填为磁盘现值。
 *
 * 不做这步的后果最隐蔽：界面读到的就是 `user:***@host`，用户只改端口再保存 ⇒
 * `***` 被当成**真密码**落盘 ⇒ 代理鉴权失败，而用户认为自己什么都没改。
 * 现值本身没有密码时，还原成"无凭据"形态（不凭空生成 `***`）。
 */
function restoreRedactedProxyUrl(incoming, current) {
  const inc = splitCredentials(incoming)
  if (!inc || inc.pass !== REDACTED_PASSWORD) return String(incoming == null ? '' : incoming)
  const cur = splitCredentials(current)
  if (!cur || !cur.pass) {
    return inc.user ? `${inc.scheme}${inc.user}@${inc.rest}` : `${inc.scheme}${inc.rest}`
  }
  return `${inc.scheme}${inc.user || cur.user}:${cur.pass}@${inc.rest}`
}

/**
 * 组装给 `/config` GET 的返回值：复制一份配置并给代理 URL 打码。
 * 只处理 `network.proxy`，其余键**原样引用**（不深拷贝整份配置，避免影响既有读取路径的性能与语义）。
 */
function redactProxyConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg
  const proxy = cfg.network && typeof cfg.network === 'object' ? cfg.network.proxy : null
  if (!proxy || typeof proxy !== 'object') return cfg
  return {
    ...cfg,
    network: {
      ...cfg.network,
      proxy: { ...proxy, url: redactProxyUrl(proxy.url) },
    },
  }
}

/**
 * 保存路径的归一：局部补丁语义（同 `logPolicy` / `knowledgeImport`）+ 打码回填。
 * @param {unknown} patch 前端传来的 `network.proxy`（可能只含部分键）
 * @param {unknown} current 磁盘现值（用于回填打码密码 / 继承未传的键）
 * @returns {{ok: boolean, value: object, error?: string}} 结构同 normalizeProxyConfig
 */
function mergeProxyPatch(patch, current) {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const c = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  // 未传的键一律继承现值（局部补丁语义：设置页只改 bypass 时不该把 mode/url 打回默认）。
  const mode = 'mode' in p ? p.mode : c.mode
  const bypass = 'bypass' in p ? p.bypass : c.bypass
  const url = 'url' in p ? restoreRedactedProxyUrl(p.url, c.url) : c.url
  const norm = normalizeProxyConfig({ mode, url, bypass })
  if (!norm.ok) return norm
  // **落盘时保留 url（即便当前档位不是 manual）**：否则"manual → off → manual"一个来回，
  // 用户填的地址就没了（normalizeProxyConfig 为计算 env 方便把非 manual 的 url 归空，
  // 那是它的职责；落盘不该跟着丢值）。切档不丢值是设置页的验收项之一。
  return { ok: true, value: { mode: norm.value.mode, url: String(url == null ? '' : url).trim(), bypass: norm.value.bypass } }
}

module.exports = {
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
}
