// src/lib/proxyUi.ts —— 网络代理设置的 UI 归约与校验**纯函数**（P1，2026-09-17）
// 规则：被测模块零依赖 —— 不 import zustand store、不用 '@' alias、不 import 运行时依赖
//（照 src/lib/knowledgeImportUi.ts / logUi.ts 先例）。
//
// **判定口径必须与唯一实现 shared/proxy-config.cjs 一致**：那里是后端（桥）的准入判定，
// 这里是界面即时校验。两边不一致的后果是"界面说合法、保存被 400"或反之（用户无从理解），
// 故 server/proxy-config-routes.test.mjs 用同一组样本对两侧做**等价性**断言。
//
// 三档语义（与后端注释同一套）：
//   off    默认。**一个代理变量都不注入**，Chromium 轨也不调 setProxy ⇒ 与本功能落地前逐字节一致。
//          刻意不做成"强制直连"：那会改掉用户系统层面的代理设置（不干预 ≠ 强制直连）。
//   system 只有 Chromium 轨跟随系统（内置浏览器/自动化分区）。Node 轨**不支持** —— Node 没有
//          跨平台读取系统代理的标准 API，硬做会出现"WebFetch 直连、模型调用走代理"的半吊子组合。
//   manual 两轨都走同一地址：Node 轨（桥自身出网 + 内核/Bash/MCP 子进程）与 Chromium 轨。

export type ProxyMode = 'off' | 'system' | 'manual'

export interface ProxyUiConfig {
  mode: ProxyMode
  /** manual 档必填；形如 scheme://[user:pass@]host:port（可含凭据，回显时由后端打码） */
  url: string
  /** 用户自定义绕过项（逗号分隔）。回环**不由用户负责**，见 effectiveBypass()。 */
  bypass: string
}

export const DEFAULT_PROXY_UI: ProxyUiConfig = { mode: 'off', url: '', bypass: '' }

/** 允许的代理协议。`socks5` 在 Node 侧为**实验性**支持（实测生效并打 ExperimentalWarning），
 *  界面文案需注明；`socks4`/`pac` 不支持：前者 Node 侧无支持，后者是另一套语义（脚本），不在本项范围。 */
export const PROXY_ALLOWED_PROTOCOLS = ['http:', 'https:', 'socks5:'] as const

/**
 * 强制绕过的回环地址。**用户只能追加、改不掉**（后端同样强制并入 NO_PROXY）。
 * 少了它们，桥会被自己的代理劫持 ⇒ "应用连不上自己的桥"，而报错指向的是代理端口、
 * 完全不提代理，属最难定位的一类事故。
 */
export const LOOPBACK_BYPASS = ['127.0.0.1', 'localhost', '::1'] as const

const MODES: ProxyMode[] = ['off', 'system', 'manual']

/** 逗号分隔串 → 去空白、去空项、按大小写不敏感去重后的数组（与后端 normalizeBypassList 同语义）。 */
export function splitBypass(raw: unknown): string[] {
  const s = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : ''
  const out: string[] = []
  for (const item of s.split(',')) {
    const v = item.trim()
    if (!v) continue
    if (out.some((x) => x.toLowerCase() === v.toLowerCase())) continue
    out.push(v)
  }
  return out
}

/** 实际生效的绕过列表 = 用户项 + **强制回环**（界面用它如实展示"你写的 + 系统强制的"）。 */
export function effectiveBypass(bypass: unknown): string[] {
  const out = splitBypass(bypass)
  for (const host of LOOPBACK_BYPASS) {
    if (!out.some((x) => x.toLowerCase() === host.toLowerCase())) out.push(host)
  }
  return out
}

/** 任意输入 → 合法 UI 配置（未知档位回落到 off，与后端一致）。 */
export function normalizeProxyUi(raw: unknown): ProxyUiConfig {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {}
  const rawMode = typeof r.mode === 'string' ? r.mode.trim().toLowerCase() : ''
  const mode = (MODES as string[]).includes(rawMode) ? (rawMode as ProxyMode) : 'off'
  return {
    mode,
    url: typeof r.url === 'string' ? r.url.trim() : '',
    // bypass 保留用户原文（只做 trim 与去重），这样"用户粘一串、看到的就是他粘的"
    bypass: splitBypass(r.bypass).join(','),
  }
}

/** 校验结果的**错误 key**（不是中文句子）：文案由 i18n 出，保证中英同步。 */
export type ProxyErrorKey =
  | 'settings.proxyErrUrlRequired'
  | 'settings.proxyErrScheme'
  | 'settings.proxyErrNoHost'
  | 'settings.proxyErrHasPath'

/**
 * 即时校验（manual 档才校验地址）。返回 null 表示可保存。
 * 与后端判定逐条对齐：协议白名单、必须有主机名、**不得带路径/查询/片段**。
 * 最后一条是本项最易踩的坑：从浏览器地址栏复制来的 `http://10.0.0.1:7890/dashboard`，
 * 后端会拒绝（带路径的值塞进 HTTP_PROXY 后 Node 解析失败 → **静默直连**，
 * 症状是"配了代理却没走"，比直接报错难查得多）。这里提前说清。
 */
export function validateProxyUi(cfg: ProxyUiConfig): ProxyErrorKey | null {
  if (cfg.mode !== 'manual') return null
  const url = cfg.url.trim()
  if (!url) return 'settings.proxyErrUrlRequired'
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'settings.proxyErrScheme'
  }
  if (!(PROXY_ALLOWED_PROTOCOLS as readonly string[]).includes(u.protocol.toLowerCase())) {
    return 'settings.proxyErrScheme'
  }
  if (!u.hostname) return 'settings.proxyErrNoHost'
  const path = u.pathname && u.pathname !== '/' ? u.pathname : ''
  if (path || u.search || u.hash) return 'settings.proxyErrHasPath'
  return null
}

/** 提交给 `POST /config` 的补丁形状（局部补丁语义：只发代理这一段）。 */
export function proxyPatch(cfg: ProxyUiConfig): { proxy: ProxyUiConfig } {
  return { proxy: normalizeProxyUi(cfg) }
}

/**
 * 是否需要提示"重启应用后生效"。
 * 为什么必须提示：Node 轨的 `NODE_USE_ENV_PROXY` 是**进程启动期**读取的开关，
 * 桥进程 env 也只在 spawn 时注入一次；Chromium 轨的 setProxy 也只在 session 建立时下发。
 * 装作"改完立刻全局生效"会让用户按旧进程的行为下结论（"配了没用"）。
 */
export const PROXY_NEEDS_RESTART = true

/** 状态摘要（供界面显示"当前档位 + 实际生效面"），返回 i18n key。 */
export function proxyStatusKey(cfg: ProxyUiConfig): string {
  if (cfg.mode === 'system') return 'settings.proxyStatusSystem'
  if (cfg.mode === 'manual') return 'settings.proxyStatusManual'
  return 'settings.proxyStatusOff'
}
