// 应用智控：**登录态指纹**的唯一真源（cookie + localStorage + sessionStorage）。
//
// ★ 为什么需要它（真实故障，2026-09-14）：
//   「手动登录了但是好像读取不到登录状态」——站点 www.yfljsj.com 是 Vue SPA，登录 token
//   全部写 **sessionStorage**（`vea:auth:access_token` / `refresh_token` / `tenant_id`…，
//   见其打包产物 `index.*.js` 的 `setTokens → I_.sessionSet`），既没有 cookie、也没进 localStorage。
//   而原实现的"是否已登录"只看 cookie 指纹（browser-executor 的 getCookieFingerprint）：
//   对该站点永远返回 'empty' → 上层把"已登录"如实判断成"未登录"，生成期一路走登录墙/超时。
//   登录编排的三路成功信号同理（第一路就是 cookie 指纹变化）→ 用户明明登录成功也等到超时。
//
// ★ 本模块的职责边界：只做**纯计算**（拼指纹串 / 解指纹串 / 判成功信号 / 判同站点），
//   不 require Electron、不读磁盘，故可被 node --test 直接加载。
//   页面侧的探测脚本以字符串形式由这里给出（唯一真源），由 executor 在目标页面上下文执行。
//
// ★ 隐私边界（硬约束，勿放宽）：探测脚本**只回传键名与值的哈希**，明文（token/密码/用户信息）
//   绝不离开页面上下文，更不进日志、不进模型上下文、不进 IPC 回执。
'use strict'

/**
 * "这个键名像不像会话痕迹"——只匹配**键名**，不匹配值。
 * 覆盖 token / auth / jwt / session / ticket / credential / login / passport / userinfo。
 * ★ 刻意不写 `sid`（会命中 aside 之类的无关键）、也不写裸 `user`（会命中 userTheme 这类界面偏好）：
 *   判宽了会把"界面偏好"当登录痕迹 → 误判已登录（比漏判更糟：会带着未登录态继续生成）。
 */
const SESSION_KEY_RE = /(token|auth|jwt|session|ticket|credential|login|passport|userinfo|user_info)/i

/**
 * 页面上下文探测脚本（字符串模板，唯一真源）。
 * 返回值形状：`{ ok:boolean, keys:number, hash:string }`
 *   · ok=false            → 两个 storage 都枚举不了（沙箱/权限异常），调用方按"不可读"处理；
 *   · keys=0              → 可读但没有任何会话痕迹键；
 *   · keys>0 && hash      → 有会话痕迹（hash 用于检测内容变化，不泄露明文）。
 * ★ 页面内用 FNV-1a（确定性、无依赖）而不是 node crypto：脚本在渲染进程里跑，拿不到 node 模块。
 */
function buildStorageProbeScript() {
  return `(() => {
  const RE = ${SESSION_KEY_RE.toString()};
  const hash = (s) => {
    const t = String(s).slice(0, 512) + '#' + String(s).length;
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return h.toString(16).padStart(8, '0');
  };
  const parts = [];
  let readable = 0;
  const scan = (store, tag) => {
    if (!store) return;
    const names = [];
    try { for (let i = 0; i < store.length; i++) names.push(store.key(i)); readable += 1 } catch { return }
    names.sort();
    for (const n of names) {
      if (!RE.test(String(n))) continue;
      let v = '';
      try { v = store.getItem(n) } catch { v = '' }
      parts.push(tag + ':' + n + '=' + hash(v == null ? '' : v));
    }
  };
  try { scan(window.localStorage, 'L') } catch {}
  try { scan(window.sessionStorage, 'S') } catch {}
  if (!readable) return { ok: false, keys: 0, hash: '' };
  return { ok: true, keys: parts.length, hash: hash(parts.join('|')) };
})()`
}

/** 合成登录态指纹：`c:<cookie 指纹>|s:<storage 指纹>`（cookie 读不到时 `c:` 空 → 视为未知） */
function buildLoginFingerprint(cookieFp, storageFp) {
  const c = cookieFp == null ? '' : String(cookieFp)
  return `c:${c}|s:${storageFp == null ? '?' : String(storageFp)}`
}

/** storage 侧裸值 → 三态（true=有会话痕迹 / false=可读但无 / null=读不到，未知） */
function storageStateOf(raw) {
  if (raw == null) return null
  const s = String(raw)
  if (s === '') return null
  if (s === '?') return null            // 无窗口 / 不同站点 / 执行异常：读不到 ≠ 未登录
  if (s === 'none') return false
  return s.startsWith('yes') ? true : null
}

/**
 * 解指纹串。
 * ★ 兼容**裸 cookie 指纹**（'empty' / 'n3:ab12'）：executor 未实现登录态指纹时，
 *   编排会回退到 getCookieFingerprint，既有假执行器与单测传的就是裸值。不兼容会让既有路径全部失效。
 */
function parseLoginFingerprint(fp) {
  const raw = String(fp == null ? '' : fp)
  let cookieRaw = null
  let storageRaw = null
  const hasSegments = /(^|\|)c:/.test(raw) || /(^|\|)s:/.test(raw)
  if (hasSegments) {
    for (const seg of raw.split('|')) {
      if (seg.startsWith('c:')) cookieRaw = seg.slice(2)
      else if (seg.startsWith('s:')) storageRaw = seg.slice(2)
    }
  } else {
    cookieRaw = raw
  }
  return {
    cookieRaw,
    storageRaw,
    // cookie 侧：'empty'/空 → 无；有值 → 有；整串为空 → 未知
    cookie: cookieRaw ? cookieRaw !== 'empty' : null,
    storage: storageStateOf(storageRaw),
  }
}

/**
 * 是否已有登录痕迹（三态）。`true` = 确实在登录态；`false` = 可见范围内没有任何痕迹；`null` = 读不到（不敢断言）。
 * ★ 调用约定（app:check 的实际用法）：**只有 `true` 才免提醒**，`false`/`null` 都照旧给一句
 *   "未检测到登录态"的软提示（让用户知道可以点「登录此应用」）。
 *   关键区别在于：读不到时我们**不谎报成 `'empty'`**，也不会据此推翻"已登录"的判定。
 */
function loginEvidence(fp) {
  const p = parseLoginFingerprint(fp)
  if (p.cookie === true || p.storage === true) return true
  if (p.cookie === false && p.storage === false) return false
  return null
}

/**
 * 登录编排的成功信号：登录态指纹出现了哪一路新证据。
 * @returns {'cookie'|'storage'|null} cookie = 出现非空 cookie 且与基线不同；storage = 会话痕迹从无到有
 *
 * 两路：
 *   a) cookie 首路——**沿用既有语义**（出现非空 cookie 且与基线不同即算成功），
 *      理由：登录必然写 cookie 的站点占绝大多数，此路已由既有测试与真机验证；
 *   b) storage 次路——### 只认"会话痕迹从无到有"（基线不是 true、现在 true）###。
 *      ★ 为什么不是"storage 指纹变化即成功"：SPA 一进页面就会往 localStorage/sessionStorage
 *        写界面偏好（折叠状态、主题、__tab_id…），"任意变化"会把首屏初始化当成登录成功 →
 *        带着未登录态继续生成（比多等一会儿糟得多）。"会话痕迹键从无到有"才真正是登录事件。
 */
function loginStateChangeKind(prevFp, nowFp) {
  if (nowFp == null || String(nowFp) === '') return null
  const prev = parseLoginFingerprint(prevFp)
  const now = parseLoginFingerprint(nowFp)
  if (now.cookieRaw && now.cookieRaw !== 'empty' && now.cookieRaw !== prev.cookieRaw) return 'cookie'
  if (now.storage === true && prev.storage !== true) return 'storage'
  return null
}

/** 是否出现登录成功信号（见 loginStateChangeKind） */
function loginStateChanged(prevFp, nowFp) {
  return loginStateChangeKind(prevFp, nowFp) !== null
}

/**
 * "强登录证据"——只认 storage 侧会话痕迹。
 * ★ 专供**开窗前的预判**（"本来就已经登录着，别打扰用户"）：
 *   这里绝不能采信"有 cookie"，因为大量站点的 cookie 只是统计/主题之类（真机：kimi 分区里的
 *   HMACCOUNT_BFESS / theme / next-sidebar-publisher-shortcut-region 全与登录无关），
 *   采信它会让真正需要登录的用户**直接跳过登录窗口**（比误开一次窗糟糕得多）。
 *   storage 侧出现 token/auth/session 类键，才是"确实在登录态"的硬证据。
 */
function hasStrongLoginEvidence(fp) {
  return parseLoginFingerprint(fp).storage === true
}

/**
 * 是否**同站点**（协议限 http(s)，host 去 www 后相等）。
 * ★ 为什么用它而不是严格同源：cookie/storage 的读取要在**窗口当前页面**的上下文里做，
 *   而窗口常被站点从 apex 跳到 www（http://x.com → http://www.x.com）。按严格同源判定会一律
 *   读不到 → 回落成"未知"，登录态又变得看不见（用户视角就是"还是读不到登录状态"）。
 *   放宽到同站点是**安全的**：读到的是窗口所在 origin 自己的 storage，不存在跨站外发。
 */
function isSameSite(a, b) {
  const hostOf = (u) => {
    try {
      const x = new URL(String(u))
      if (!/^https?:$/.test(x.protocol)) return null
      return x.hostname.toLowerCase().replace(/^www\./, '')
    } catch { return null }
  }
  const ha = hostOf(a)
  const hb = hostOf(b)
  return !!ha && !!hb && ha === hb
}

module.exports = {
  SESSION_KEY_RE,
  buildStorageProbeScript,
  buildLoginFingerprint,
  parseLoginFingerprint,
  loginEvidence,
  loginStateChanged,
  loginStateChangeKind,
  hasStrongLoginEvidence,
  isSameSite,
}
