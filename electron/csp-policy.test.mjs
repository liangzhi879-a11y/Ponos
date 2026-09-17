// P0-4：外壳 CSP 策略单测
// 运行：node --test electron/csp-policy.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import csp from './csp-policy.cjs'

const { buildShellCsp, resolveCspMode, isShellDocument, DEFAULT_CSP_MODE, SHELL_CSP_DIRECTIVES } = csp

test('默认模式是 report（安全默认：先观察违规，不打死外壳）', () => {
  assert.equal(DEFAULT_CSP_MODE, 'report')
  assert.equal(resolveCspMode(undefined), 'report')
  assert.equal(resolveCspMode(''), 'report')
  assert.equal(resolveCspMode('乱写'), 'report', '非法值必须回落到 report 而非 off/enforce')
})

test('模式解析：off / report / enforce 均被接受（大小写不敏感）', () => {
  assert.equal(resolveCspMode('off'), 'off')
  assert.equal(resolveCspMode('REPORT'), 'report')
  assert.equal(resolveCspMode('Enforce'), 'enforce')
})

test('策略内容：script-src 不含 unsafe-inline / unsafe-eval（这是本项的主要收益）', () => {
  const p = buildShellCsp()
  const scriptSrc = p.split('; ').find((d) => d.startsWith('script-src'))
  assert.ok(scriptSrc, '必须显式声明 script-src')
  assert.ok(!scriptSrc.includes('unsafe-inline'), 'script-src 不得含 unsafe-inline')
  assert.ok(!scriptSrc.includes('unsafe-eval'), 'script-src 不得含 unsafe-eval')
  assert.ok(scriptSrc.includes("'self'"))
})

test('策略内容：style-src 保留 unsafe-inline（CodeMirror 的 style-mod 硬约束）', () => {
  const p = buildShellCsp()
  const styleSrc = p.split('; ').find((d) => d.startsWith('style-src'))
  assert.ok(styleSrc.includes("'unsafe-inline'"), '去不掉：style-mod 用 createElement(style)+textContent')
})

test('策略内容：封闭类指令到位（object-src/base-uri/frame-ancestors/form-action）', () => {
  const p = buildShellCsp()
  for (const d of ['object-src', 'base-uri', 'frame-ancestors', 'form-action']) {
    assert.ok(p.includes(`${d} 'none'`), `${d} 应为 'none'`)
  }
})

test('策略内容：connect-src 覆盖桥的 HTTP+WS（含 127.0.0.1 与 localhost 两种写法）', () => {
  const connect = buildShellCsp().split('; ').find((d) => d.startsWith('connect-src'))
  for (const need of ['http://127.0.0.1:51517', 'ws://127.0.0.1:51517', 'http://localhost:51517', 'ws://localhost:51517']) {
    assert.ok(connect.includes(need), `connect-src 需含 ${need}（Windows 上 localhost 可能先解析 ::1）`)
  }
})

test('isShellDocument：只认外壳文档（mainFrame 且 file:// 或 dev 源）', () => {
  assert.equal(isShellDocument({ resourceType: 'mainFrame', url: 'file:///C:/app/dist/index.html' }), true)
  assert.equal(isShellDocument({ resourceType: 'mainFrame', url: 'http://localhost:5197/' }), true)
  assert.equal(isShellDocument({ resourceType: 'mainFrame', url: 'http://127.0.0.1:5197/index.html' }), true)

  // 桥的预览载荷：**绝不能**套外壳策略（会打断依赖 CDN 的互动展示）
  assert.equal(isShellDocument({ resourceType: 'mainFrame', url: 'http://127.0.0.1:51517/raw-file?path=x.html' }), false)
  // 子帧一律不套
  assert.equal(isShellDocument({ resourceType: 'subFrame', url: 'file:///C:/app/dist/index.html' }), false)
  // 外部网站不套
  assert.equal(isShellDocument({ resourceType: 'mainFrame', url: 'https://example.com/' }), false)
  assert.equal(isShellDocument(null), false)
})

test('指令集合本身不含裸通配（防误放行）', () => {
  const flat = Object.values(SHELL_CSP_DIRECTIVES).flat()
  assert.ok(!flat.includes('*'), '策略中不得出现 * 通配')
  assert.ok(!flat.includes('http:'), '不得放开整协议')
  assert.ok(!flat.includes('https:'), '不得放开整协议')
})
