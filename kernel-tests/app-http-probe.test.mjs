// 后台页面素材获取（electron/app-http-probe.cjs）单元测试
//
// 存在意义（真实反馈 2026-09-13）：生成命令原先必须先经内置浏览器探测，而浏览器导航受
// **自动化白名单**保护（默认 *.gov.cn/localhost），给 kimi.com 这类站点生成命令直接失败：
//   「导航失败：目标域名不在白名单…已拒绝导航」。
// 现在改为主进程后台普通 HTTP 取素材（用户无感、不经白名单），浏览器探测降级为白名单站点的增强。
// 本文件守住三点：解析要真、失败不抛、rich/thin 判定要准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { extractPageMaterial, isMaterialRich, looksLikeSpaShell, fetchPageMaterial, MAX_HTML_BYTES } = require('../electron/app-http-probe.cjs')

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
