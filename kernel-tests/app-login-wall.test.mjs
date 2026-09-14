// 应用智控：登录墙检测分级（Task 4）。
// 7 条来自 task-4-brief.md 的测试**逐字保留**；其后的测试是额外补充（误报加固、单源复用、边界）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { detectLoginWall, HIGH_ONLY } = require('../electron/app-login-wall.cjs')
const loginPage = require('../electron/app-login-page.cjs')

test('high：素材有密码框', () => {
  const r = detectLoginWall({ material: { hasPassword: true }, url: 'https://x.com/dashboard' })
  assert.equal(r.confidence, 'high'); assert.equal(r.needed, true)
  assert.ok(r.reasons.join().includes('密码'))
})

test('high：快照明确 logged_in=false', () => {
  const r = detectLoginWall({ page: { logged_in: false }, url: 'https://x.com/a' })
  assert.equal(r.confidence, 'high')
})

test('high：地址是登录页 + 给出 loginUrl', () => {
  const r = detectLoginWall({ material: { url: 'https://x.com/login?redirect_uri=%2Fa' }, url: 'https://x.com/login?redirect_uri=%2Fa' })
  assert.equal(r.confidence, 'high')
  assert.equal(r.loginUrl, 'https://x.com/login?redirect_uri=%2Fa')
})

test('medium：正文提到登录（只提示，不自动弹窗）', () => {
  const r = detectLoginWall({ material: { text: '请登录后查看' }, url: 'https://x.com/a' })
  assert.equal(r.confidence, 'medium')
  assert.equal(HIGH_ONLY.includes(r.confidence), false)
})

test('low：疑似空壳 + 交互线索极少', () => {
  const r = detectLoginWall({ material: { interactives: 1, spa: true }, url: 'https://x.com/a' })
  assert.equal(r.confidence, 'low')
})

test('none：正常页面不误报（不弹窗）', () => {
  const r = detectLoginWall({ material: { interactives: 30, forms: [], text: '订单列表', hasPassword: false }, url: 'https://x.com/orders' })
  assert.equal(r.needed, false); assert.equal(r.confidence, 'none'); assert.deepEqual(r.reasons, [])
})

test('loginUrl：表单 action 同源才采用（跨站 action 忽略）', () => {
  assert.equal(detectLoginWall({ material: { hasPassword: true, forms: [{ action: '/session/new' }] }, url: 'https://x.com/login' }).loginUrl, 'https://x.com/session/new')
  assert.equal(detectLoginWall({ material: { hasPassword: true, forms: [{ action: 'https://evil.com/s' }] }, url: 'https://x.com/a' }).loginUrl, null)
})

// ───────────────────────── 以下为 Task 4 额外补充 ─────────────────────────

test('导出面：detectLoginWall / HIGH_ONLY / LOGIN_PATH_RE / LOGIN_TEXT_RE 齐全，且 HIGH_ONLY 只含 high', () => {
  const m = require('../electron/app-login-wall.cjs')
  assert.equal(typeof m.detectLoginWall, 'function')
  assert.deepEqual(m.HIGH_ONLY, ['high'])
  assert.ok(m.LOGIN_PATH_RE instanceof RegExp)
  assert.ok(m.LOGIN_TEXT_RE instanceof RegExp)
})

test('单源复用：LOGIN_PATH_RE 与 app-login-page.cjs 是同一个正则（禁止两处复制）', () => {
  assert.equal(require('../electron/app-login-wall.cjs').LOGIN_PATH_RE, loginPage.LOGIN_PATH_RE)
})

test('LOGIN_PATH_RE 语义：命中各类登录路径，不误伤普通路径', () => {
  const hit = (p) => loginPage.LOGIN_PATH_RE.test(p)
  for (const p of ['/login', '/zh/login', '/signin', '/sign-in', '/sign_in', '/auth/login', '/user/login', '/account/login', '/passport', '/sso', '/login/']) {
    assert.equal(hit(p), true, `应命中：${p}`)
  }
  for (const p of ['/orders', '/loginx', '/my-login-page', '/', '/api/logins']) {
    assert.equal(hit(p), false, `不应命中：${p}`)
  }
})

// ───────────────── 误报加固：判定必须落在**真实生产路径**上（fix round 1，F1） ─────────────────
//
// 旧实现的加固分支是"素材带 rawHtml/html/raw 时用严格正则复核"，而真实生产者
//（fetchPageMaterial / harvestSite）**从不返回这些字段** → 加固形同虚设：
// `data-type="password"` 依然判 high → 自动弹出登录窗口（用户明确要求"能不弹就不弹"）。
// 现在收紧到源头（app-http-probe.cjs 的 attr 加左边界 + hasPassword 改严格正则），
// 所以断言必须用 **extractPageMaterial 的真实产物**喂 detectLoginWall——这正是 Task 6 的调用形状：
//   detectLoginWall({ material: harvested.material, page: null, url })
const { extractPageMaterial } = require('../electron/app-http-probe.cjs')

const wallOf = (html, url = 'https://x.com/search') =>
  detectLoginWall({ material: extractPageMaterial(html, url), page: null, url })

test('F1 端到端：data-type="password" 的真实素材 → none / 不弹窗（自动开窗的回归防线）', () => {
  const r = wallOf('<html><body><form action="/s"><input data-type="password" name="q"><button>查询</button></form></body></html>')
  assert.equal(r.confidence, 'none')
  assert.equal(r.needed, false)
  assert.deepEqual(r.reasons, [])
})

test('F1 端到端：type="passwordx" 的真实素材 → none（值必须以边界收尾）', () => {
  const r = wallOf('<html><body><form action="/s"><input type="passwordx" name="q"><button>查询</button></form></body></html>')
  assert.equal(r.confidence, 'none')
  assert.equal(r.needed, false)
})

test('F1 端到端：真密码框的真实素材仍是 high（收紧不得连真信号一起挡掉）', () => {
  const r = wallOf('<html><body><form action="/s"><input type="password" name="pwd"><button>登录</button></form></body></html>')
  assert.equal(r.confidence, 'high')
  assert.equal(r.needed, true)
  assert.ok(r.reasons.join().includes('密码'))
})

test('源①「表单字段命中」：forms[].fields[] 里有 tag=input && type=password → high', () => {
  // attr 修好后字段里的 type 已是可信信号，措辞直接说"表单里有密码字段"，不再自称"严格复核"
  const r = detectLoginWall({
    material: { interactives: 30, forms: [{ action: '/session', fields: [{ tag: 'input', type: 'password', name: 'pwd' }] }], text: '订单列表' },
    url: 'https://x.com/a',
  })
  assert.equal(r.confidence, 'high')
  assert.ok(r.reasons.some((s) => s.includes('表单里有密码字段')), `实际：${r.reasons}`)
  assert.equal(r.reasons.join().includes('未复核'), false, '源头已收紧，不该再出现"未复核"措辞')
  // 非 input（如 select/textarea）或非 password 的 type 不算
  assert.equal(wallOf('<html><body><form action="/s"><select name="x" type="password"></select></form></body></html>').confidence, 'none')
  assert.equal(wallOf('<html><body><form action="/s"><input type="text" name="q"><button>查询</button></form></body></html>').confidence, 'none')
})

test('源②「素材 hasPassword」：抽取层严格正则命中 → high，措辞如实说"页面上有密码输入框"', () => {
  const r = detectLoginWall({ material: { hasPassword: true, interactives: 30, text: '订单列表' }, url: 'https://x.com/orders' })
  assert.equal(r.confidence, 'high')
  assert.ok(r.reasons.some((s) => s.includes('页面上有密码输入框')), `实际：${r.reasons}`)
  assert.equal(r.reasons.join().includes('未复核'), false)
})

test('rawHtml/html/raw 分支已删除：这些字段不再参与判定（生产从不返回，属死代码）', () => {
  const base = { hasPassword: false, interactives: 30, text: '订单列表' }
  for (const k of ['html', 'rawHtml', 'raw']) {
    const r = detectLoginWall({ material: { ...base, [k]: '<form><input type="password" name="pwd"></form>' }, url: 'https://x.com/orders' })
    assert.equal(r.confidence, 'none', `material.${k} 不该影响判定`)
  }
})

test('F3：素材带无关 html 字段时，其它 high 信号不得被"复核拒否"短路（真实登录墙不许漏报）', () => {
  const r = detectLoginWall({
    material: { html: '<div>loading…</div>', forms: [{ fields: [{ tag: 'input', type: 'password' }] }], hasPassword: true },
    url: 'https://x.com/a',
  })
  assert.equal(r.confidence, 'high')
  assert.equal(r.needed, true)
})

test('误报加固不吞掉其他 high 信号：logged_in=false 时即使密码框被复核为误报，仍 high', () => {
  const r = detectLoginWall({
    material: { hasPassword: true, html: '<input data-type="password">', interactives: 30 },
    page: { logged_in: false },
    url: 'https://x.com/orders',
  })
  assert.equal(r.confidence, 'high')
  assert.ok(r.reasons.join().includes('logged_in'))
})

test('high：快照交互项里有密码框（label 含密码 + tag textbox）', () => {
  const r = detectLoginWall({ page: { interactives: [{ tag: 'textbox', label: '密码' }] }, url: 'https://x.com/a' })
  assert.equal(r.confidence, 'high')
})

test('medium 窗口边界：正文登录字样在第 1500 字符之后不算信号（只提示前 1500 字符）', () => {
  const r = detectLoginWall({ material: { text: '啊'.repeat(1500) + '请登录后查看' }, url: 'https://x.com/a' })
  assert.equal(r.confidence, 'none')
  assert.equal(r.needed, false)
})

test('medium：标题提到登录 → 只提示，不自动弹窗', () => {
  const r = detectLoginWall({ material: { title: '请先登录 - X系统' }, url: 'https://x.com/a' })
  assert.equal(r.confidence, 'medium')
  assert.equal(HIGH_ONLY.includes(r.confidence), false)
  // 词表边界（如实记录）：LOGIN_TEXT_RE 只认"请登录/立即登录/请先登录/账号登录"等完整提示语，
  // 单纯"用户登录"这类标题不命中——medium 只用于"提示"，宁可少提示也不制造噪音；
  // 这类页面通常地址含 /login，会由地址信号判 high。
  assert.equal(detectLoginWall({ material: { title: '用户登录' }, url: 'https://x.com/a' }).confidence, 'none')
})

test('low：site.pagesFetched === 1 且交互线索 < 3（spa 由外层传入也可）', () => {
  assert.equal(detectLoginWall({ material: { interactives: 2, site: { pagesFetched: 1 } }, url: 'https://x.com/a' }).confidence, 'low')
  assert.equal(detectLoginWall({ material: { interactives: 2, site: { pagesFetched: 3 } }, url: 'https://x.com/a' }).confidence, 'none')
  assert.equal(detectLoginWall({ material: { interactives: 30, site: { pagesFetched: 1 } }, url: 'https://x.com/a' }).confidence, 'none')
})

test('medium/low 不给 loginUrl（只有登录页或同源表单 action 才给）；none 时 loginUrl 为 null', () => {
  assert.equal(detectLoginWall({ material: { text: '请登录' }, url: 'https://x.com/a' }).loginUrl, null)
  assert.equal(detectLoginWall({ material: { interactives: 1, spa: true }, url: 'https://x.com/a' }).loginUrl, null)
  assert.equal(detectLoginWall({ material: { interactives: 30, text: '订单列表' }, url: 'https://x.com/orders' }).loginUrl, null)
})

test('loginUrl 兜底：本页就是登录页且无表单 action 时，返回本页地址（含 query）', () => {
  const r = detectLoginWall({ page: { logged_in: false }, url: 'https://x.com/user/login?next=%2Forders' })
  assert.equal(r.loginUrl, 'https://x.com/user/login?next=%2Forders')
})

test('loginUrl 兜底：非法 action 字符串被忽略且不抛错', () => {
  const r = detectLoginWall({ material: { hasPassword: true, forms: [{ action: 'http://[::1' }] }, url: 'https://x.com/a' })
  assert.equal(r.loginUrl, null)
})

test('健壮性：无参数 / null / 字段类型异常都不抛错，返回 none', () => {
  for (const arg of [undefined, null, {}, { material: null, page: null, url: null }, { material: 'x', page: 42 }]) {
    const r = detectLoginWall(arg)
    assert.equal(r.needed, false)
    assert.equal(r.confidence, 'none')
    assert.deepEqual(r.reasons, [])
    assert.equal(r.loginUrl, null)
  }
})

test('F4：裸 null 不抛错（`= {}` 默认值只对 undefined 生效，曾直接 TypeError）', () => {
  assert.doesNotThrow(() => detectLoginWall(null))
  const r = detectLoginWall(null)
  assert.equal(r.needed, false)
  assert.equal(r.confidence, 'none')
  assert.deepEqual(r.reasons, [])
  assert.equal(r.loginUrl, null)
})

test('F5：HIGH_ONLY 冻结——外部 push 不得改变"只有 high 能自动弹窗"', () => {
  assert.ok(Object.isFrozen(HIGH_ONLY))
  assert.throws(() => HIGH_ONLY.push('none'), '冻结数组被 push 应抛错（ESM 严格模式）')
  assert.deepEqual(HIGH_ONLY, ['high'])
  assert.equal(HIGH_ONLY.includes('high'), true)
})

// ── app-login-page.cjs 的纯函数（Task 5 会直接复用，这里先锁定行为，防后续被改坏） ──
test('snapshotHasPassword：只认「label 含密码 + tag 是输入类控件」', () => {
  assert.equal(loginPage.snapshotHasPassword({ interactives: [{ tag: 'textbox', label: '密码' }] }), true)
  assert.equal(loginPage.snapshotHasPassword({ interactives: [{ tag: 'textbox', label: 'Password' }] }), true)
  assert.equal(loginPage.snapshotHasPassword({ interactives: [{ tag: 'textbox', label: '用户名' }] }), false)
  assert.equal(loginPage.snapshotHasPassword({ interactives: [{ tag: 'button', label: '记住密码' }] }), false)
  assert.equal(loginPage.snapshotHasPassword({ interactives: null }), false)
  assert.equal(loginPage.snapshotHasPassword(null), false)
})

test('loginSucceeded：偏保守——三类成立条件 + 拿不准一律 false', () => {
  // a) logged_in=true 直接成功
  assert.equal(loginPage.loginSucceeded({ page: { logged_in: true } }, 'https://x.com/login'), true)
  // b) 已离开登录页且无密码框（起始页是登录页）→ 成功
  assert.equal(loginPage.loginSucceeded({ page: { url: 'https://x.com/orders', interactives: [{ tag: 'link', label: '订单' }] } }, 'https://x.com/login'), true)
  // c) 还在登录页 / 还有密码框 → 失败
  assert.equal(loginPage.loginSucceeded({ page: { url: 'https://x.com/login', interactives: [{ tag: 'textbox', label: '密码' }] } }, 'https://x.com/login'), false)
  // d) 起始页不是登录页时，"没密码框"不算成功证据
  assert.equal(loginPage.loginSucceeded({ page: { url: 'https://x.com/a', interactives: [] } }, 'https://x.com/orders'), false)
  // e) 没有 url / 没有 page → false
  assert.equal(loginPage.loginSucceeded({ page: { interactives: [] } }, 'https://x.com/login'), false)
  assert.equal(loginPage.loginSucceeded(null, 'https://x.com/login'), false)
  assert.equal(loginPage.loginSucceeded(undefined, undefined), false)
})

// ─────────── 修补：loginUrl 必须认准"登录表单"，别把搜索框当登录页 ───────────
// 真实站点首页常把搜索框排在登录入口之前。原实现"取第一个同源带 action 的表单"，
// 会把登录窗口导航到搜索结果页（用户找不到登录框），spec.auth.loginUrl 也记下假地址。

test('loginUrl：搜索框排在登录表单之前时，取登录表单（不得被第一个同源表单劫持）', () => {
  const material = {
    hasPassword: true,
    forms: [
      { action: '/orders', fields: [{ tag: 'input', type: 'text', name: 'kw' }, { tag: 'button' }] },
      { action: '/login', fields: [{ tag: 'input', type: 'text', name: 'user' }, { tag: 'input', type: 'password', name: 'pw' }] },
    ],
  }
  assert.equal(detectLoginWall({ material, url: 'https://x.com/orders' }).loginUrl, 'https://x.com/login')
})

test('loginUrl：本页是登录页时，仍优先取带密码字段的那个表单（不是第一个表单）', () => {
  const material = {
    hasPassword: true,
    forms: [{ action: '/search' }, { action: '/session/new', fields: [{ tag: 'input', type: 'password' }] }],
  }
  assert.equal(detectLoginWall({ material, url: 'https://x.com/login' }).loginUrl, 'https://x.com/session/new')
})

test('loginUrl：只有搜索/筛选表单（与登录无关）时给 null，让调用方退回目标网址', () => {
  const material = { forms: [{ action: '/search', fields: [{ tag: 'input', type: 'text', name: 'q' }] }] }
  assert.equal(detectLoginWall({ material, url: 'https://x.com/' }).loginUrl, null)
  // 路径本身像登录页的 action 仍算登录证据（/sso、/signin）
  assert.equal(detectLoginWall({ material: { forms: [{ action: '/sso/start' }] }, url: 'https://x.com/' }).loginUrl, 'https://x.com/sso/start')
})

test('loginUrl：action 路径像登录页时优先于"本页是登录页"的兜底（分档生效）', () => {
  const material = { forms: [{ action: '/account/login' }, { action: '/help' }] }
  assert.equal(detectLoginWall({ material, url: 'https://x.com/login' }).loginUrl, 'https://x.com/account/login')
})
