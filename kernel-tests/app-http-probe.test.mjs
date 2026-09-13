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
const { extractPageMaterial, isMaterialRich, looksLikeSpaShell, fetchPageMaterial, harvestSite, pickFollowLinks, MAX_HTML_BYTES } = require('../electron/app-http-probe.cjs')
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
