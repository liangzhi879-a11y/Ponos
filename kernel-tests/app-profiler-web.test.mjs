// web 侧能力清单：001（yfljsj.com）这类 SPA 的真实痛点是——
// 首页只暴露少数模块入口，而它的**接口**（前端 chunk 里的 API 路径）才是真正可封装的东西。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildWebCapabilities } = require('../electron/app-profiler.cjs')
const { extractPageMaterial } = require('../electron/app-http-probe.cjs')

const MATERIAL = {
  url: 'https://www.yfljsj.com/',
  title: '订单系统',
  links: [{ text: '订单管理', href: '/order' }, { text: '库存', href: '/stock' }],
  forms: [{ action: '/api/order/list', method: 'post', fields: [], buttons: [] }],
  scripts: ['/js/index.BZMYiOb-.js', '/js/vendor.js'],
  apiHints: ['/api/order/list', '/api/stock/query'],
}

test('★ 页面可交互 → web-ui 通道为 verified（这条永远成立，作为兜底路径）', () => {
  const { capabilities, surface } = buildWebCapabilities({ url: MATERIAL.url, material: MATERIAL })
  const ui = capabilities.find((c) => c.channel === 'web-ui')
  assert.equal(ui.confidence, 'verified')
  assert.equal(ui.driver, 'browser')
  assert.equal(surface.verdict, 'connectable')
})

test('★ 发现接口线索 → http 为 probable，且证据里带具体路径', () => {
  const { capabilities } = buildWebCapabilities({ url: MATERIAL.url, material: MATERIAL })
  const http = capabilities.find((c) => c.channel === 'http')
  assert.equal(http.confidence, 'probable', '线索未实测，不许标 verified')
  assert.equal(http.driver, 'http')
  assert.ok(http.evidence.includes('/api/order/list'), `证据要含具体路径：${http.evidence}`)
})

test('★ 发现脚本 → chunk 通道用 browser 执行（自带登录态，SPA 的真实能力面在这里）', () => {
  const { capabilities } = buildWebCapabilities({ url: MATERIAL.url, material: MATERIAL })
  const chunk = capabilities.find((c) => c.channel === 'chunk')
  assert.equal(chunk.driver, 'browser')
  assert.ok(chunk.evidence.includes('index.BZMYiOb-'), `要指出是哪个 chunk：${chunk.evidence}`)
})

test('没有接口/脚本线索时不得凭空造通道（宁缺勿假）', () => {
  const { capabilities } = buildWebCapabilities({ url: 'https://example.com/', material: { url: 'https://example.com/', links: [{ text: 'A', href: '/' }] } })
  assert.equal(capabilities.some((c) => c.channel === 'http'), false)
  assert.equal(capabilities.some((c) => c.channel === 'chunk'), false)
})

test('extractPageMaterial：新增 scripts 与 apiHints（去重、限量、取绝对路径）', () => {
  const html = `<html><head>
    <script src="/js/index.BZMYiOb-.js"></script>
    <script src="https://cdn.example.com/js/vendor.js"></script>
    </head><body>
    <form action="/api/order/list" method="post"><input name="page"></form>
    <script>fetch('/api/order/list');fetch('/api/stock/query')</script>
    </body></html>`
  const m = extractPageMaterial(html, 'https://www.yfljsj.com/')
  assert.ok(m.scripts.includes('/js/index.BZMYiOb-.js'), `要收脚本路径：${JSON.stringify(m.scripts)}`)
  assert.ok(m.scripts.includes('https://cdn.example.com/js/vendor.js'), '跨域脚本也要收')
  assert.ok(m.apiHints.includes('/api/order/list'), `要收接口线索：${JSON.stringify(m.apiHints)}`)
  assert.ok(m.apiHints.includes('/api/stock/query'), '内联脚本里的接口路径也要挖出来')
  assert.equal(new Set(m.apiHints).size, m.apiHints.length, '要去重')
})
