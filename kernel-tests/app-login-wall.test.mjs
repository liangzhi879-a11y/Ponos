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

test('误报加固①：material 带原始 HTML 时用严格正则复核，data-type="password" 不算密码框', () => {
  const r = detectLoginWall({
    material: { hasPassword: true, html: '<form><input data-type="password" name="q"></form>', interactives: 30, forms: [{ action: '', fields: [{ tag: 'input', type: 'text', name: 'q' }] }], text: '订单列表' },
    url: 'https://x.com/orders',
  })
  assert.equal(r.confidence, 'none')
  assert.deepEqual(r.reasons, [])
})

test('误报加固②：material 带原始 HTML 时，type="passwordx" 不算密码框', () => {
  const r = detectLoginWall({
    material: { hasPassword: true, rawHtml: '<form><input type="passwordx" name="q"></form>', interactives: 30, forms: [], text: '订单列表' },
    url: 'https://x.com/orders',
  })
  assert.equal(r.confidence, 'none')
})

test('误报加固③：真实的密码框（严格正则复核通过）仍是 high', () => {
  const r = detectLoginWall({
    material: { hasPassword: true, rawHtml: '<form><input type="password" name="pwd"></form>' },
    url: 'https://x.com/orders',
  })
  assert.equal(r.confidence, 'high')
  assert.ok(r.reasons.join().includes('密码'))
})

test('已知误报（记录行为）：无原始 HTML 可复核时，宽松 hasPassword 仍保留为 high，但 reasons 标明未复核', () => {
  const r = detectLoginWall({
    material: { hasPassword: true, interactives: 30, forms: [{ action: '', fields: [{ tag: 'input', type: 'text', name: 'q' }] }], text: '订单列表' },
    url: 'https://x.com/orders',
  })
  assert.equal(r.confidence, 'high')
  assert.ok(r.reasons.join().includes('未复核'), '应明示该 high 未经严格复核')
})

test('已知误报（字段被污染）：抽取层 attr 无词边界，data-type="password" 会被读成字段 type=password；有原文时严格复核仍能挡住', () => {
  // 抽取层 attr('type') 会命中 `data-type=` 里的 type → 字段被判成 password（这条由 app-http-probe.cjs 决定，本任务不改）
  const pollutedFields = [{ tag: 'input', type: 'password', name: 'q' }]
  // a) 原文可用 → 严格正则为准 → 不误报
  assert.equal(detectLoginWall({
    material: { hasPassword: true, html: '<form><input data-type="password" name="q"></form>', interactives: 30, forms: [{ action: '', fields: pollutedFields }], text: '订单列表' },
    url: 'https://x.com/orders',
  }).confidence, 'none')
  // b) 原文拿不到 → 只能沿用字段/宽松信号 → 仍 high（**已知残留误报**，如实记录；宁可多提示也不错判"无需登录"）
  assert.equal(detectLoginWall({
    material: { hasPassword: true, interactives: 30, forms: [{ action: '', fields: pollutedFields }], text: '订单列表' },
    url: 'https://x.com/orders',
  }).confidence, 'high')
})

test('可靠信号优先：表单字段里的 password 判为严格命中', () => {
  const r = detectLoginWall({
    material: { interactives: 30, forms: [{ action: '/session', fields: [{ tag: 'input', type: 'password', name: 'pwd' }] }], text: '登录' },
    url: 'https://x.com/a',
  })
  assert.equal(r.confidence, 'high')
  assert.ok(r.reasons.join().includes('密码'))
  // 表单字段判定为严格命中 → 不该再带"未复核"的措辞
  assert.equal(r.reasons.join().includes('未复核'), false)
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
  for (const arg of [undefined, {}, { material: null, page: null, url: null }, { material: 'x', page: 42 }]) {
    const r = detectLoginWall(arg)
    assert.equal(r.needed, false)
    assert.equal(r.confidence, 'none')
    assert.deepEqual(r.reasons, [])
    assert.equal(r.loginUrl, null)
  }
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
