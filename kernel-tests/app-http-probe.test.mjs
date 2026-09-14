// 后台页面素材获取（electron/app-http-probe.cjs）单元测试
//
// 存在意义（真实反馈 2026-09-13）：生成命令原先必须先经内置浏览器探测，而浏览器导航受
// **自动化白名单**保护（默认 *.gov.cn/localhost），给 kimi.com 这类站点生成命令直接失败：
//   「导航失败：目标域名不在白名单…已拒绝导航」。
// 现在改为主进程后台普通 HTTP 取素材（用户无感、不经白名单），浏览器探测降级为白名单站点的增强。
// 本文件守住三点：解析要真、失败不抛、rich/thin 判定要准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { extractPageMaterial, isMaterialRich, looksLikeSpaShell, fetchPageMaterial, harvestSite, pickFollowLinks, MAX_HTML_BYTES, MAX_REDIRECTS } = require('../electron/app-http-probe.cjs')
const { normalizeUrl } = require('../electron/app-util.cjs')

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>示例订单管理系统</title>
<meta name="description" content="订单查询与导出">
</head><body>
<h1>订单列表</h1>
<form id="searchForm" action="/orders" method="get">
  <input type="hidden" name="csrf" value="xxx">
  <input id="orderId" name="orderId" placeholder="请输入订单号" required>
  <select name="status"><option>全部</option></select>
  <button type="submit">查询订单</button>
</form>
<button id="exportBtn">导出</button>
<a href="/customers">客户管理</a>
<a href="javascript:void(0)">无效链接</a>
<script>var secret = "不该出现在正文里";</script>
</body></html>`

const htmlResp = (body, { status = 200, url = 'https://x.com/', ctype = 'text/html; charset=utf-8' } = {}) =>
  ({ ok: status < 400, status, url, headers: { get: () => ctype }, text: async () => body })

test('extractPageMaterial：抽标题/描述/表单字段/按钮/链接，跳过 hidden 与 javascript:', () => {
  const m = extractPageMaterial(PAGE, 'https://x.com/orders')
  assert.equal(m.title, '示例订单管理系统')
  assert.equal(m.description, '订单查询与导出')
  assert.ok(m.headings.includes('订单列表'))
  const form = m.forms[0]
  assert.equal(form.action, '/orders')
  assert.equal(form.method, 'get')
  assert.deepEqual(form.fields.map((f) => f.name), ['orderId', 'status'], 'hidden 字段不该出现')
  assert.equal(form.fields[0].placeholder, '请输入订单号')
  assert.equal(form.fields[0].required, true)
  assert.ok(form.buttons.some((b) => b.text === '查询订单'))
  assert.ok(m.buttons.some((b) => b.text === '导出' && b.selector === '#exportBtn'))
  assert.deepEqual(m.links.map((l) => l.href), ['/customers'], 'javascript: 链接要剔除')
  assert.ok(!m.text.includes('不该出现在正文里'), 'script 内容不得混进正文')
})

test('isMaterialRich：有表单字段/按钮算富，空壳算薄', () => {
  assert.equal(isMaterialRich(extractPageMaterial(PAGE)), true)
  assert.equal(isMaterialRich(extractPageMaterial('<html><body><div id="root"></div></body></html>')), false)
  assert.equal(isMaterialRich(null), false)
})

test('looksLikeSpaShell：识别前端渲染空壳（这类页面静态抓取拿不到素材）', () => {
  assert.equal(looksLikeSpaShell('<html><body><div id="root"></div><script src="a.js"></script></body></html>'), true)
  assert.equal(looksLikeSpaShell('<html><body><h1>完整静态页</h1></body></html>'), false)
})

test('fetchPageMaterial：成功返回素材并带上最终 URL', async () => {
  const r = await fetchPageMaterial({ url: 'https://x.com/orders', fetchImpl: async () => htmlResp(PAGE) })
  assert.equal(r.ok, true)
  assert.equal(r.status, 200)
  assert.equal(r.material.title, '示例订单管理系统')
})

test('fetchPageMaterial：非 2xx / 非网页 / 网络异常一律**不抛错**，返回结构化 error', async () => {
  const notFound = await fetchPageMaterial({ url: 'https://x.com/a', fetchImpl: async () => htmlResp('nope', { status: 404 }) })
  assert.equal(notFound.ok, false)
  assert.ok(notFound.error.includes('404'))

  const pdf = await fetchPageMaterial({ url: 'https://x.com/a.pdf', fetchImpl: async () => htmlResp('%PDF', { ctype: 'application/pdf' }) })
  assert.equal(pdf.ok, false)
  assert.ok(pdf.error.includes('不是网页'))

  const boom = await fetchPageMaterial({ url: 'https://x.com/a', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(boom.ok, false)
  assert.ok(boom.error.includes('ECONNREFUSED'))
})

test('fetchPageMaterial：只认 http/https（避免 file:// 之类被塞进来）', async () => {
  const r = await fetchPageMaterial({ url: 'file:///C:/secret.txt', fetchImpl: async () => htmlResp('x') })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('只支持 http/https'))
  const bad = await fetchPageMaterial({ url: '不是网址', fetchImpl: async () => htmlResp('x') })
  assert.equal(bad.ok, false)
  assert.ok(bad.error.includes('网址不合法'))
})

test('fetchPageMaterial：超时中止 → 人话超时提示（不抛 AbortError 出去）', async () => {
  const hang = async (_u, opt) => new Promise((_res, rej) => {
    opt.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) })
  })
  const r = await fetchPageMaterial({ url: 'https://x.com/slow', fetchImpl: hang, timeoutMs: 30 })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('超时'), `实际：${r.error}`)
})

test('fetchPageMaterial：超大页面截断（不给模型灌整份 HTML）', async () => {
  const huge = `<html><head><title>大</title></head><body>${'x'.repeat(MAX_HTML_BYTES + 50000)}</body></html>`
  const r = await fetchPageMaterial({ url: 'https://x.com/big', fetchImpl: async () => htmlResp(huge) })
  assert.equal(r.ok, true)
  assert.ok(r.bytes > MAX_HTML_BYTES, '原始体积要被记录')
  assert.ok(r.material.text.length <= 3000, '正文摘要必须有上限')
})

// ---------- 网址归一（真实故障：不带协议头 → 抓取与授权双双静默失败） ----------
//
// 用户从地址栏复制的网址常常不带协议头（kimi.com / www.kimi.com）。此前取素材走 new URL() 直接
// 抛错 → 素材为空（probeMode=none）→ 模型只能靠猜写命令；授权同样抛错 → 域名未授权 → 执行被
// 白名单拦下。两处都静默降级，用户看到的就是"生成了但完全没有效果"。

test('normalizeUrl：不带协议头也能归一（这是本轮真实故障的核心）', () => {
  assert.equal(normalizeUrl('kimi.com'), 'https://kimi.com/')
  assert.equal(normalizeUrl('www.kimi.com'), 'https://www.kimi.com/')
  assert.equal(normalizeUrl('  kimi.com/chat?x=1  '), 'https://kimi.com/chat?x=1')
  assert.equal(normalizeUrl('example.com/a/b'), 'https://example.com/a/b')
})

test('normalizeUrl：已有协议的原样保留（含 http、端口、路径与查询）', () => {
  assert.equal(normalizeUrl('https://www.kimi.com/'), 'https://www.kimi.com/')
  assert.equal(normalizeUrl('http://example.com:8080/x?y=1'), 'http://example.com:8080/x?y=1')
})

test('normalizeUrl：localhost/127.0.0.1 补 http（本地服务几乎都不是 https）', () => {
  assert.equal(normalizeUrl('localhost:5173'), 'http://localhost:5173/')
  assert.equal(normalizeUrl('127.0.0.1:3000/api'), 'http://127.0.0.1:3000/api')
})

test('normalizeUrl：不支持的协议与垃圾输入返回 null（不硬编造成 https）', () => {
  for (const bad of ['file:///C:/secret.txt', 'mailto:a@b.com', 'javascript:alert(1)', 'data:text/html,x', '', '   ', 'ht!tp://x']) {
    assert.equal(normalizeUrl(bad), null, `${JSON.stringify(bad)} 应返回 null`)
  }
  assert.equal(normalizeUrl(null), null)
  assert.equal(normalizeUrl(undefined), null)
})

test('fetchPageMaterial + normalizeUrl 联动：不带协议头也能取到素材（旧行为是"网址不合法"）', async () => {
  const seen = []
  const r = await fetchPageMaterial({
    url: 'kimi.com/chat',
    fetchImpl: async (u) => { seen.push(u); return htmlResp(PAGE, { url: u }) },
  })
  assert.equal(r.ok, true, `应能抓取，实际：${r.error}`)
  assert.equal(seen[0], 'https://kimi.com/chat', 'fetch 要收到补全后的绝对地址')
  assert.equal(r.material.title, '示例订单管理系统')
  assert.equal(r.finalUrl, 'https://kimi.com/chat')
})

// ---------- 多页采集（用户要求"尽可能充分获取所有能控制的接口信息"） ----------
//
// 只抓首页时模型看得到的可控接口很有限、写出的命令自然单薄。多抓几页同源主要页面
//（列表/搜索/设置…）能让模型把整个站点的入口摸出来。下面的用例守住"抓得全"与"抓得稳"。

const HOME_PAGE = `<!doctype html><html><head><title>站点首页</title></head><body>
<nav>
  <a href="/orders/list">订单列表</a>
  <a href="/search?q=">搜索</a>
  <a href="/settings/config">设置</a>
  <a href="/logout">退出登录</a>
  <a href="https://other.example/orders">外部站点</a>
  <a href="#anchor">锚点</a>
</nav>
<form action="/search"><input name="kw"><button type="submit">查询</button></form>
</body></html>`

const PAGE_WITH = (title, extra = '') => `<!doctype html><html><head><title>${title}</title></head><body>
<h1>${title}</h1><form action="/x"><input name="p"><button>提交</button></form>${extra}</body></html>`

test('pickFollowLinks：只跟同源、跳过 logout/删除类路径、剔除锚点与跨域', () => {
  const m = extractPageMaterial(HOME_PAGE, 'https://site.example/')
  const picked = pickFollowLinks(m, 'https://site.example/', 5)
  assert.ok(picked.some((u) => u.includes('/orders/list')), `应跟上订单列表：${picked}`)
  assert.ok(picked.some((u) => u.includes('/settings/config')), '应跟上设置页')
  assert.ok(!picked.some((u) => u.includes('/logout')), '退出登录绝不自动访问')
  assert.ok(!picked.some((u) => u.includes('other.example')), '跨域不跟（属别的应用）')
  assert.ok(!picked.some((u) => u.endsWith('#anchor')), '锚点不该被当成新页面')
})

test('harvestSite：抓首页 + 同源主要页面，汇总素材与统计', async () => {
  const asked = []
  const r = await harvestSite({
    url: 'site.example',
    maxPages: 3,
    fetchImpl: async (u) => {
      asked.push(u)
      const path = new URL(u).pathname
      if (path === '/') return htmlResp(HOME_PAGE, { url: u })
      return htmlResp(PAGE_WITH(`页面${path}`), { url: u })
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.pagesFetched, 3, `应抓满 3 个页面，实际 ${r.pagesFetched}`)
  assert.equal(asked.length, 3)
  assert.ok(r.material.site.pagesFetched === 3)
  assert.ok(r.material.site.interactiveTotal > 0, '要给出可交互线索总数')
  assert.equal(r.material.pages.length, 2, '除首页外还应有 2 页素材')
  assert.ok(r.material.pages.every((p) => p.forms?.length >= 1), '每页素材要带表单')
})

test('harvestSite：单页失败不影响整体（只记录，不抛）', async () => {
  const r = await harvestSite({
    url: 'https://site.example/',
    maxPages: 3,
    fetchImpl: async (u) => {
      if (u.includes('/orders')) throw new Error('ECONNRESET')
      if (new URL(u).pathname === '/') return htmlResp(HOME_PAGE, { url: u })
      return htmlResp(PAGE_WITH('ok'), { url: u })
    },
  })
  assert.equal(r.ok, true, '整体仍成功')
  assert.equal(r.pagesFetched, 2)
  assert.equal(r.failed.length, 1)
  assert.ok(r.failed[0].error.includes('ECONNRESET'), '失败原因要如实保留')
})

test('harvestSite：首页就取不到 → 如实返回失败（不编造素材）', async () => {
  const r = await harvestSite({ url: 'https://site.example/', fetchImpl: async () => { throw new Error('ENOTFOUND') } })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('ENOTFOUND'))
})

test('harvestSite：maxPages=1 时只抓首页（不跟进）', async () => {
  const asked = []
  const r = await harvestSite({ url: 'https://site.example/', maxPages: 1, fetchImpl: async (u) => { asked.push(u); return htmlResp(HOME_PAGE, { url: u }) } })
  assert.equal(r.ok, true)
  assert.equal(asked.length, 1)
  assert.equal(r.pagesFetched, 1)
})

// ---------- 不弹窗（用户明确要求"能不弹出就不要弹出"） ----------
//
// 这是窗口创建选项，单元测试里起不了真窗口，所以用**源码契约**做回归守卫：
// 如果有人把自动化窗口改回 show:true，应用智控/AI 执行命令时会弹出浏览器窗口打扰用户——
// 这条用例就是为了在那一刻拦住他（并在注释里写清为什么）。
test('BrowserExecutor：自动化窗口默认隐藏（用户主动打开才显示）', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'electron', 'browser-executor.cjs'), 'utf-8')
  const createWin = src.slice(src.indexOf('new BrowserWindow('), src.indexOf('new BrowserWindow(') + 800)
  assert.match(createWin, /show:\s*false/, '自动化窗口必须 show:false（否则应用智控执行命令会弹窗）')
  assert.doesNotMatch(createWin, /show:\s*true/, '不得改回 show:true')
  // 用户主动打开浏览器面板时必须仍能看到窗口：openWindow 要显式 show
  assert.match(src, /openWindow[\s\S]{0,400}?\.show\(\)/, 'openWindow 必须显式 show()，保证用户点开浏览器仍可见')
})

// ---------- 登录态：Cookie 注入 + 跨站隔离（应用智控·登录态支持） ----------
//
// 为什么：命令生成只能看到"未登录"的页面时，模型据以写出的选择器全是登录墙上的东西，
// 用户拿到的命令必然失败。所以抓取要能带用户自己的登录态。
// 但**带 Cookie 的请求等于以用户身份访问**——绝不允许跟着重定向把登录态漏给第三方域名，
// 因此重定向改为逐跳判断：授权内照常跟随、跨站立即停止且不带 Cookie。安全核心就在下面第 2 条。

test('fetchPageMaterial：注入 cookieProvider → 请求带 Cookie 头', async () => {
  const seen = []
  const r = await fetchPageMaterial({
    url: 'https://x.com/a',
    cookieProvider: (u) => (u.startsWith('https://x.com/') ? 'sid=1' : null),
    fetchImpl: async (u, opt) => { seen.push({ u, cookie: opt.headers.cookie }); return htmlResp(PAGE, { url: u }) },
  })
  assert.equal(r.ok, true)
  assert.equal(seen[0].cookie, 'sid=1')
})

test('fetchPageMaterial：授权外 host **绝不**带 Cookie（跨站隔离）', async () => {
  const seen = []
  const r = await fetchPageMaterial({
    url: 'https://x.com/a',
    cookieProvider: (u) => (u.startsWith('https://x.com/') ? 'sid=1' : null),
    fetchImpl: async (u, opt) => {
      seen.push({ u, cookie: opt.headers.cookie })
      if (u === 'https://x.com/a') return { ok: true, status: 302, url: u, headers: new Headers({ location: 'https://evil.com/b' }), text: async () => '' }
      return htmlResp(PAGE, { url: u })
    },
  })
  assert.equal(r.ok, false)                     // 跨站跳转：停止跟随，如实报错
  assert.equal(seen.length, 1)                  // 没有向 evil.com 发第二次请求
  assert.ok(r.error.includes('跨站'))
})

test('fetchPageMaterial：同站点内重定向照常跟随，且每跳重新取 Cookie', async () => {
  const seen = []
  const r = await fetchPageMaterial({
    url: 'https://x.com/a',
    cookieProvider: (u) => (u.includes('/b') ? 'sid=after' : 'sid=before'),
    fetchImpl: async (u, opt) => {
      seen.push({ u, cookie: opt.headers.cookie })
      if (u === 'https://x.com/a') return { ok: true, status: 302, url: u, headers: new Headers({ location: '/b' }), text: async () => '' }
      return htmlResp(PAGE, { url: u })
    },
  })
  assert.equal(r.ok, true)
  assert.equal(seen.length, 2)
  assert.equal(seen[1].cookie, 'sid=after')
})

test('fetchPageMaterial：重定向上限（防环）', async () => {
  let n = 0
  const r = await fetchPageMaterial({
    url: 'https://x.com/a',
    fetchImpl: async (u) => { n++; return { ok: true, status: 302, url: u, headers: new Headers({ location: `/r${n}` }), text: async () => '' } },
  })
  assert.equal(r.ok, false)
  assert.equal(n, MAX_REDIRECTS + 1)
  assert.ok(r.error.includes('重定向'))
})

test('extractPageMaterial：检出密码框（登录墙硬信号）', () => {
  const m = extractPageMaterial('<html><body><input type="password" name="pw"></body></html>', 'https://x.com/login')
  assert.equal(m.hasPassword, true)
  assert.equal(extractPageMaterial('<html><body><input type="text"></body></html>', 'https://x.com/').hasPassword, false)
})

// ---------- 密码框误报加固：必须在**源头**（应用智控·登录态 Task 4 fix round 1） ----------
//
// 真实故障（Task 3 审查发现、Task 6 的调用路径会踩到）：旧 hasPassword 用
//   /<input[^>]+type\s*=\s*["']?password/i
// 会把 `data-type="password"`、`type="passwordx"` 判成密码框；attr() 的正则 `${name}\s*=` 又没有
// 左边界，`attr('<input data-type="password">', 'type')` 同样会抽到 "password"，
// 于是 forms[].fields[].type 也被污染 → detectLoginWall 判 high → **自动弹出登录窗口**
//（用户明确要求"能不弹就不弹"）。调用侧 detectLoginWall 曾用"素材带原文则严格复核"兜底，
// 但真实生产者（fetchPageMaterial / harvestSite）从不返回 rawHtml/html/raw → 加固形同虚设。
// 因此判定必须在源头收紧；下面两条守住源头正则，app-login-wall.test.mjs 守住端到端调用路径。

test('extractPageMaterial：hasPassword 只认真正的 password 输入框（data-type / passwordx 都不算）', () => {
  const pw = (html) => extractPageMaterial(html, 'https://x.com/a').hasPassword
  // 真密码框：引号/大小写/无引号/自闭合/属性换行分隔 各种合法写法都要认
  for (const html of [
    '<input type="password">', "<input type='password'>", '<input type=password>', '<input type="PASSWORD">',
    '<input name="pw" type="password" />', '<input\n  class="x"\n  type = "password"\n>',
    '<form action="/s"><input type="password" name="pw"></form>',
  ]) assert.equal(pw(html), true, `应判为密码框：${html}`)
  // 误报：属性名只是后缀相同（data-type / x-type）、或值只是以 password 开头
  for (const html of [
    '<input data-type="password">', '<input data-type="password" name="q">', '<input x-type=password>',
    '<input type="passwordx">', '<input type="passwordx" name="q">', '<input type="text" data-type="password">',
    '<input type="text">', '<input name="password">',
  ]) assert.equal(pw(html), false, `不该判为密码框：${html}`)
})

test('extractPageMaterial：attr 带左边界——data-* 属性不再冒充同名属性（type/id/name/placeholder/value）', () => {
  const m = extractPageMaterial('<html><body><form action="/s"><input data-type="password" name="q"></form></body></html>', 'https://x.com/a')
  assert.equal(m.forms[0].fields[0].type, 'text', 'data-type 不是 type，字段应保留 input 默认 text')
  const m2 = extractPageMaterial('<html><body><form action="/s"><input data-id="xid" data-name="xname" data-placeholder="xph" data-value="xv"></form></body></html>', 'https://x.com/a')
  const f = m2.forms[0].fields[0]
  assert.deepEqual({ id: f.id, name: f.name, placeholder: f.placeholder, value: f.value }, { id: '', name: '', placeholder: '', value: '' })
  // 无回归：真实属性（含 form/button/a/meta）仍要照常抽到
  const m3 = extractPageMaterial('<html><head><meta name="description" content="说明"></head><body><form action="/s" method="post" id="F" name="fm"><input type="password" id="pwd" name="pw" placeholder="密码" value="v"><button id="B" type="submit">提交</button></form><a href="/x" id="L">链接</a></body></html>', 'https://x.com/a')
  const g = m3.forms[0]
  assert.equal(m3.description, '说明')
  assert.deepEqual([g.action, g.method, g.id, g.name], ['/s', 'post', 'F', 'fm'])
  assert.deepEqual([g.fields[0].type, g.fields[0].id, g.fields[0].name, g.fields[0].placeholder, g.fields[0].value], ['password', 'pwd', 'pw', '密码', 'v'])
  assert.deepEqual([g.buttons[0].text, g.buttons[0].id, g.buttons[0].type], ['提交', 'B', 'submit'])
  assert.deepEqual([m3.links[0].href, m3.links[0].id], ['/x', 'L'])
  assert.deepEqual([m3.buttons[0].selector, m3.buttons[0].type], ['#B', 'submit'])
})

// 显式传 isAllowedHost 时以调用方为准（Task 6 会传站点授权集合）：允许的跨站可以跟，
// 但 Cookie 仍由 cookieProvider 按 URL 自己把关——不授权就不带（两件事各管一摊）。
test('fetchPageMaterial：显式 isAllowedHost 可放行跨站跳转，但 Cookie 仍按 url 把关', async () => {
  const seen = []
  const r = await fetchPageMaterial({
    url: 'https://x.com/a',
    isAllowedHost: (u) => /(^|\.)x\.com$|(^|\.)cdn\.x\.com$/.test(new URL(u).hostname),
    cookieProvider: (u) => (new URL(u).hostname === 'x.com' ? 'sid=1' : null),
    fetchImpl: async (u, opt) => {
      seen.push({ u, cookie: opt.headers.cookie })
      if (u === 'https://x.com/a') return { ok: true, status: 302, url: u, headers: new Headers({ location: 'https://cdn.x.com/b' }), text: async () => '' }
      return htmlResp(PAGE, { url: u })
    },
  })
  assert.equal(r.ok, true)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].cookie, 'sid=1')
  assert.equal(seen[1].cookie, undefined, '未授权 host 不得带 Cookie')
})
