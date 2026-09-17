// D2-2：令牌注入的"可信发起帧"判定（P0-3）
// ---------------------------------------------------------------------------
// 背景：注入器原先只看"目标是桥 host"就补令牌，不看谁发起的请求。而 FileEditor 的
// HtmlPreview 把用户任意 HTML 经 /raw-file 以**桥源**载入 ⇒ 其中内联脚本的请求同样被注入，
// 配合文件端点即可任意读写本机文件。去掉 iframe 的 allow-same-origin 也不够：
// 文档变 opaque（Origin: null）后仍需令牌，注入器照样补上。
//
// 判据用 details.frame.origin —— **实测**（Electron 43 探针）onBeforeSendHeaders 的 details
// 没有 `initiator` 字段，而 frame.origin 能稳定区分 file:// 主窗口 / 桥源文档 / 沙箱 iframe(null)。
//
// 运行：node --test electron/bridge-frame-trust.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import injectorPkg from './bridge-header-inject.cjs'

const { createBridgeHeaderInjector, isTrustedFrameOrigin } = injectorPkg

const PORT = 51517
const TOKEN = 'test-token-abc'
const HEADER = 'x-yfw-bridge-token'
const BRIDGE_ORIGIN = `http://127.0.0.1:${PORT}`
const TRUSTED = ['file://', 'http://localhost:5197', 'http://127.0.0.1:5197']

const make = (trustedFrameOrigins) => createBridgeHeaderInjector({
  port: PORT, token: TOKEN, headerName: HEADER,
  ...(trustedFrameOrigins ? { trustedFrameOrigins } : {}),
})

const call = (fn, frameOrigin, url = `${BRIDGE_ORIGIN}/write-file`) => fn({
  url,
  requestHeaders: { accept: '*/*' },
  ...(frameOrigin === '__MISSING__' ? {} : { frame: { origin: frameOrigin } }),
})

test('兼容性护栏：未提供可信清单时，行为与改前一致（仍按 host 注入）', () => {
  const fn = make(null)
  const h = call(fn, 'null')
  assert.equal(h[HEADER], TOKEN, '未配置清单不得改变既有行为')
})

test('可信帧：打包态主窗口（file://）→ 注入', () => {
  const h = call(make(TRUSTED), 'file://')
  assert.equal(h[HEADER], TOKEN)
})

test('可信帧：开发态 dev server 源 → 注入', () => {
  for (const o of ['http://localhost:5197', 'http://127.0.0.1:5197']) {
    assert.equal(call(make(TRUSTED), o)[HEADER], TOKEN, `${o} 应被信任`)
  }
})

test('攻击：沙箱 iframe（opaque，frame.origin="null"）→ 不注入 ⇒ 服务端 401', () => {
  const h = call(make(TRUSTED), 'null')
  assert.equal(h[HEADER], undefined, 'opaque 沙箱不得获得令牌')
})

test('攻击：桥源文档自身（即保留 allow-same-origin 的预览）→ 不注入', () => {
  const h = call(make(TRUSTED), BRIDGE_ORIGIN)
  assert.equal(h[HEADER], undefined, '桥 origin 必须**不在**可信集合内')
})

test('空 origin 字符串 → 不注入', () => {
  assert.equal(call(make(TRUSTED), '')[HEADER], undefined)
})

test('frame 信息缺失 → 保持既有行为（注入）并告警一次，不误伤主窗口', () => {
  // 实测 XHR/fetch 都带 frame，此分支是防"平台差异导致主窗口被掐死"的保险
  const h = call(make(TRUSTED), '__MISSING__')
  assert.equal(h[HEADER], TOKEN)
})

test('isTrustedFrameOrigin：即使调用方误把 null 写进清单也不放行', () => {
  const bad = new Set(['null', 'file://'])
  assert.equal(isTrustedFrameOrigin('null', bad), false)
  assert.equal(isTrustedFrameOrigin('', bad), false)
  assert.equal(isTrustedFrameOrigin('file://', bad), true)
  assert.equal(isTrustedFrameOrigin('file:///', bad), true, '尾斜杠应归一')
  assert.equal(isTrustedFrameOrigin('FILE://', bad), true, '大小写应归一')
})

test('非桥 URL：任何来源都不注入', () => {
  const fn = make(TRUSTED)
  assert.equal(call(fn, 'file://', 'http://127.0.0.1:9999/x')[HEADER], undefined)
  assert.equal(call(fn, 'file://', 'https://example.com/')[HEADER], undefined)
})

test('调用方已带同名头（大小写不敏感）→ 不覆盖', () => {
  const fn = make(TRUSTED)
  const out = fn({ url: `${BRIDGE_ORIGIN}/read-file`, requestHeaders: { 'X-YFW-Bridge-Token': 'mine' }, frame: { origin: 'file://' } })
  assert.equal(out['X-YFW-Bridge-Token'], 'mine')
  assert.equal(out[HEADER], undefined)
})

test('返回新对象：不原地修改传入的 requestHeaders', () => {
  const fn = make(TRUSTED)
  const input = { url: `${BRIDGE_ORIGIN}/read-file`, requestHeaders: { accept: '*/*' }, frame: { origin: 'file://' } }
  const out = fn(input)
  assert.notEqual(out, input.requestHeaders)
  assert.equal(input.requestHeaders[HEADER], undefined, '入参不得被修改')
})
