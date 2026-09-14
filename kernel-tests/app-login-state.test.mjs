// 应用智控·登录态修复（2026-09-14 真机故障）：
//   「手动登录了但是好像读取不到登录状态」——站点 www.yfljsj.com 是 Vue SPA，登录 token 只写
//   **sessionStorage**（`vea:auth:access_token` / `refresh_token` …，见其打包产物 setTokens→I_.sessionSet），
//   既没有 cookie、也没进 localStorage。旧实现"是否已登录"只看 cookie 指纹 → 永远 'empty' →
//   已登录被如实判成"未登录"，登录编排的三路信号也永远等不到成功（用户明明登录成功却等到超时）。
//
// 本文件锁死修复后的契约（全部纯函数/假执行器：不启 Electron、不联网、不写磁盘）：
//   · 指纹的形状与三态语义（cookie + storage，读不到 ≠ 没有）
//   · 成功信号只认"会话痕迹从无到有"，首屏噪声（主题/折叠态）不得冒充登录成功
//   · 开窗前预判只认 storage 硬证据（有 cookie ≠ 已登录：统计/主题 cookie 遍地都是）
//   · 探测脚本：只回传键名与哈希（明文不出页面）、按键名筛选、同站点判定
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  buildStorageProbeScript, buildLoginFingerprint, parseLoginFingerprint,
  loginEvidence, loginStateChanged, loginStateChangeKind, hasStrongLoginEvidence, isSameSite,
} = require('../electron/app-login-state.cjs')
const { ensureLoggedIn, loginResultDetail } = require('../electron/app-login.cjs')

// ---------------------------------------------------------------------------
// 探测脚本（唯一真源，executor 在目标页面上下文执行它）
// ---------------------------------------------------------------------------

/** 在 vm 里跑探测脚本，模拟一个页面的 localStorage/sessionStorage */
function probe({ local = {}, session = {}, broken = false } = {}) {
  const make = (obj) => (broken ? null : {
    get length() { return Object.keys(obj).length },
    key: (i) => Object.keys(obj)[i],
    getItem: (k) => (k in obj ? obj[k] : null),
  })
  const window = { localStorage: make(local), sessionStorage: make(session) }
  return vm.runInNewContext(buildStorageProbeScript(), { window })
}

test('探测脚本：只认会话痕迹键（token/auth/jwt/session/…），界面偏好键不算', () => {
  const r = probe({
    local: { theme: 'dark', 'sidebar:collapsed': '1', userTheme: 'x', 'vea:auth:access_token': 'T' },
    session: { __tab_id: 'abc', isSidebarOpen: '1' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.keys, 1, `只该命中 access_token 这一个会话痕迹键：${JSON.stringify(r)}`)
})

test('探测脚本：只回传键名与哈希，**明文值绝不出页面**', () => {
  const SECRET = 'eyJhbGciOiJIUzI1NiJ9.SUPERSECRETVALUE.signature'
  const r = probe({ session: { 'vea:auth:access_token': SECRET } })
  assert.equal(r.keys, 1)
  const wire = JSON.stringify(r)
  assert.ok(!wire.includes(SECRET), `明文 token 不得出现在回传里：${wire}`)
  assert.ok(!wire.includes('SUPERSECRET'), `连片段都不该出现：${wire}`)
  assert.match(r.hash, /^[0-9a-f]{8}$/, '哈希形状固定（FNV-1a 8 位十六进制）')
})

test('探测脚本：值变化 → 哈希变化（登录/登出可被指纹察觉）；键名不出现在回传里', () => {
  const a = probe({ session: { 'vea:auth:access_token': 'T1' } })
  const b = probe({ session: { 'vea:auth:access_token': 'T2' } })
  assert.notEqual(a.hash, b.hash, 'token 变了，指纹必须变')
  assert.ok(!JSON.stringify(a).includes('access_token'), '键名也不回传（只回数量与哈希）')
})

test('探测脚本：可读但无会话痕迹 → {ok:true,keys:0}；两个 storage 都枚举不了 → {ok:false}（读不到≠没有）', () => {
  const empty = probe({ local: { theme: 'dark' }, session: { __tab_id: 't' } })
  // vm 里的对象跨 realm，逐个字段比（deepEqual 会因原型不同而失败）
  assert.equal(empty.ok, true)
  assert.equal(empty.keys, 0, '只有界面偏好键 → 无会话痕迹')
  const broken = probe({ broken: true })
  assert.equal(broken.ok, false, '枚举不了必须如实报 ok:false，交给上层当"读不到"处理')
  assert.equal(broken.keys, 0)
})

// ---------------------------------------------------------------------------
// 指纹形状 / 三态语义
// ---------------------------------------------------------------------------

test('指纹形状固定 `c:…|s:…`；cookie 读不到时 c: 为空（未知，不是 empty）', () => {
  assert.equal(buildLoginFingerprint('empty', 'none'), 'c:empty|s:none')
  assert.equal(buildLoginFingerprint(null, 'yes:deadbeef'), 'c:|s:yes:deadbeef')
})

test('parseLoginFingerprint 兼容**裸 cookie 指纹**（旧契约：执行器未实现合成指纹时的回退值）', () => {
  const legacy = parseLoginFingerprint('n1:abc123')
  assert.equal(legacy.cookieRaw, 'n1:abc123')
  assert.equal(legacy.cookie, true)
  assert.equal(legacy.storage, null, '裸值不含 storage 信息 → 未知，不得当成"没有"')
  assert.equal(parseLoginFingerprint('empty').cookie, false)
  assert.equal(parseLoginFingerprint(null).cookie, null)
})

test('三态语义：读不到（?）与确实没有（none）必须区分开', () => {
  const p = parseLoginFingerprint('c:empty|s:?')
  assert.equal(p.storage, null, "'?' = 无窗口/不同站点/执行异常 → 读不到，不敢断言")
  assert.equal(parseLoginFingerprint('c:empty|s:none').storage, false, "'none' = 读了且确实没有")
  assert.equal(parseLoginFingerprint('c:empty|s:yes:ab').storage, true)
})

test('loginEvidence：任一路有痕迹即 true；两路都"确实没有"才 false；读不到为 null', () => {
  assert.equal(loginEvidence('c:n1:abc|s:none'), true, 'cookie 有痕迹 → 已登录')
  assert.equal(loginEvidence('c:empty|s:yes:ab'), true, '★ 只有 sessionStorage token（本次故障站点）→ 已登录')
  assert.equal(loginEvidence('c:empty|s:none'), false, '两路都确实没有 → 没登录')
  assert.equal(loginEvidence('c:empty|s:?'), null, '读不到 → 不敢断言（旧的"只看 cookie"正是在这里误报未登录）')
})

// ---------------------------------------------------------------------------
// 成功信号（登录编排三路信号之 a）
// ---------------------------------------------------------------------------

test('成功信号·cookie 路：出现非空 cookie 且与基线不同（沿用既有语义，真机最常见）', () => {
  assert.equal(loginStateChangeKind('c:empty|s:none', 'c:n1:abc|s:none'), 'cookie')
  assert.equal(loginStateChanged('c:empty|s:?', 'c:n2:xyz|s:?'), true)
  assert.equal(loginStateChangeKind('c:n1:abc|s:none', 'c:n1:abc|s:none'), null, '没变不算成功')
})

test('★ 成功信号·storage 路：会话痕迹从无到有（本次故障站点：token 只进 sessionStorage）', () => {
  assert.equal(loginStateChangeKind('c:empty|s:none', 'c:empty|s:yes:ab12'), 'storage')
  assert.equal(loginStateChangeKind('c:empty|s:?', 'c:empty|s:yes:ab12'), 'storage', '基线读不到也算"从无到有"')
  assert.equal(loginStateChangeKind(null, 'c:empty|s:yes:ab12'), 'storage')
})

test('★ 首屏噪声不得冒充登录成功：storage 哈希变了但没出现会话痕迹键 → 不算成功', () => {
  // SPA 一进页面就写 __tab_id/主题/折叠态 → 指纹变化，但 keys=0（我们的指纹是 'none'）
  assert.equal(loginStateChangeKind('c:empty|s:none', 'c:empty|s:none'), null)
  // 基线已经有会话痕迹（本来就是登录态）→ 再变也不算"登录成功"（避免把页面内刷新当登录）
  assert.equal(loginStateChangeKind('c:empty|s:yes:aaaa', 'c:empty|s:yes:bbbb'), null)
})

test('开窗前预判只认 storage 硬证据：有 cookie ≠ 已登录（统计/主题 cookie 遍地都是）', () => {
  assert.equal(hasStrongLoginEvidence('c:n3:abc|s:none'), false,
    'kimi 那类统计 cookie（HMACCOUNT_BFESS/theme）不能让登录窗口被跳过')
  assert.equal(hasStrongLoginEvidence('c:n1:abc|s:?'), false, '读不到 storage 时不得预判已登录')
  assert.equal(hasStrongLoginEvidence('c:empty|s:yes:ab12'), true, 'storage 里有 token → 确实在登录态')
  assert.equal(hasStrongLoginEvidence('n1:abc'), false, '裸 cookie 指纹（旧契约）没有 storage 信息 → 预判不成立')
})

// ---------------------------------------------------------------------------
// 同站点判定（决定能不能在"窗口当前页面"读 storage）
// ---------------------------------------------------------------------------

test('isSameSite：apex ↔ www 视为同站点（cookie/storage 读取必须容忍站点自己跳转）', () => {
  assert.equal(isSameSite('http://www.yfljsj.com/login', 'http://www.yfljsj.com/'), true)
  assert.equal(isSameSite('http://yfljsj.com/', 'http://www.yfljsj.com/'), true, '站点常把 apex 跳到 www')
  assert.equal(isSameSite('https://www.yfljsj.com/x', 'http://yfljsj.com/'), true, '协议/端口差异不影响同站点判定')
  assert.equal(isSameSite('http://evil.com/', 'http://yfljsj.com/'), false)
  assert.equal(isSameSite('about:blank', 'http://yfljsj.com/'), false, '新窗口空白页不是目标站点 → 返回读不到')
  assert.equal(isSameSite('', 'http://yfljsj.com/'), false)
})

// ---------------------------------------------------------------------------
// 编排集成：storage 路能把"只写 sessionStorage"的登录判成成功
// ---------------------------------------------------------------------------

/** 合成指纹假执行器（提供 getLoginFingerprint = 真实执行器的合成指纹能力） */
function fakeFpExecutor({ fingerprints = [], snapshots = [] } = {}) {
  let fpIdx = 0, snapIdx = 0
  const calls = []
  return {
    calls,
    openWindow: async (key, opts) => { calls.push(['openWindow', key, opts]); return { ok: true } },
    exec: async (key, action) => {
      if (action === 'goto') return { ok: true, snapshot: { page: { url: 'http://www.yfljsj.com/login' } } }
      if (action === 'snapshot') return { ok: true, snapshot: snapshots[Math.min(snapIdx++, snapshots.length - 1)] || { page: { logged_in: null } } }
      return { ok: true }
    },
    getLoginFingerprint: async () => fingerprints[Math.min(fpIdx++, fingerprints.length - 1)] ?? 'c:empty|s:none',
  }
}
const fastDeps = () => ({ sleep: async () => {}, now: (() => { let t = 0; return () => (t += 10) })() })

test('★ 真机场景：登录页始终在（快照读不出已登录），但 sessionStorage 出现了 token → 判成功（不再是假超时）', async () => {
  const ex = fakeFpExecutor({
    // 基线（开窗后）= 无痕迹；轮询中用户登录成功 → token 进 sessionStorage
    fingerprints: ['c:empty|s:none', 'c:empty|s:none', 'c:empty|s:yes:ab12'],
    snapshots: [{ page: { url: 'http://www.yfljsj.com/login', logged_in: null } }],
  })
  const r = await ensureLoggedIn({ appId: 'demo', url: 'http://www.yfljsj.com/', executor: ex, deps: fastDeps(), waitMs: 60000 })
  assert.equal(r.ok, true, `storage 出现 token 就该判成功：${JSON.stringify(r)}`)
  assert.equal(r.reason, 'storage-changed', 'reason 要与 cookie 路区分（文案/日志里这是两件事）')
  assert.match(loginResultDetail(r), /已检测到登录成功/)
  const open = ex.calls.find((c) => c[0] === 'openWindow')
  assert.equal(open?.[2]?.keepAlive, true, '登录窗口必须 keepAlive：点 X 只隐藏，否则 sessionStorage 登录态随渲染进程销毁')
})

test('真机场景②：首屏只写了界面偏好（无会话痕迹键）→ 不得判成功，如实超时', async () => {
  const ex = fakeFpExecutor({
    fingerprints: ['c:empty|s:none', 'c:empty|s:none', 'c:empty|s:none'],
    snapshots: [{ page: { url: 'http://www.yfljsj.com/login', logged_in: null } }],
  })
  const r = await ensureLoggedIn({ appId: 'demo', url: 'http://www.yfljsj.com/', executor: ex, deps: fastDeps(), waitMs: 60000 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'timeout')
})

test('真机场景③：本来就是登录态（storage 已有 token）→ 不开窗、直接 already-logged-in', async () => {
  const ex = fakeFpExecutor({ fingerprints: ['c:empty|s:yes:ab12'] })
  const r = await ensureLoggedIn({ appId: 'demo', url: 'http://www.yfljsj.com/', executor: ex, deps: fastDeps(), waitMs: 60000 })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'already-logged-in')
  assert.equal(ex.calls.some((c) => c[0] === 'openWindow'), false, '已登录就不该再开登录窗口打扰用户')
})

test('只有统计/主题 cookie（无 storage 痕迹）→ 仍要开登录窗口（预判不得采信"有 cookie"）', async () => {
  const ex = fakeFpExecutor({
    fingerprints: ['c:n3:statscookie|s:none', 'c:n3:statscookie|s:none'],
    snapshots: [{ page: { url: 'http://www.yfljsj.com/login', logged_in: null } }],
  })
  const r = await ensureLoggedIn({ appId: 'demo', url: 'http://www.yfljsj.com/', executor: ex, deps: fastDeps(), waitMs: 60000 })
  assert.equal(ex.calls.some((c) => c[0] === 'openWindow'), true, 'cookie 不是登录硬证据，该开窗还是要开')
  assert.equal(r.ok, false)
})
