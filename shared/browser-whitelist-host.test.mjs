// 浏览器白名单主机名归一化（2026-09-17）——写入端（bridge.addBrowserWhitelist）与读取端
// （electron/browser-common.isWhitelisted）**共用**此函数，故本文件钉死它的口径：两侧一旦
// 分叉就会出现"用户批准了、读取端认不出"的静默失效（真实事故：内核把 file:// 的空 hostname
// 顶替成中文占位符「该域名」弹审批，用户同意、写入端对中文静默拒绝、内核仍回"已批准"
// ⇒ agent 反复重试死循环）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWhitelistHost, MAX_HOST_LEN } from '../shared/browser-whitelist-host.cjs'

test('合法域名：归一为小写并去空白', () => {
  assert.equal(normalizeWhitelistHost('Example.COM'), 'example.com')
  assert.equal(normalizeWhitelistHost('  www.gsxt.gov.cn  '), 'www.gsxt.gov.cn')
  assert.equal(normalizeWhitelistHost('sub-1.example_2.org'), 'sub-1.example_2.org')
})

test('IPv6 字面量：带方括号形式通过（new URL().hostname 即此形）', () => {
  assert.equal(normalizeWhitelistHost('[::1]'), '[::1]')
  assert.equal(normalizeWhitelistHost('[2001:db8::1]'), '[2001:db8::1]')
})

test('中文占位符「该域名」被拒 —— 真实事故的关键一环（旧实现让它进了审批但写不进去）', () => {
  assert.equal(normalizeWhitelistHost('该域名'), null)
  assert.equal(normalizeWhitelistHost('示例.com'), null, '中文域名（punycode 未转换）也拒')
})

test('空值/非字符串被拒', () => {
  for (const v of ['', '   ', null, undefined, 0, 123, {}, [], true]) {
    assert.equal(normalizeWhitelistHost(v), null, `${JSON.stringify(v)} 应被拒`)
  }
})

test('含端口/路径/协议/其它符号的整串被拒（入参必须是 hostname，不是 URL）', () => {
  for (const v of [
    'example.com:8080', '../evil', 'a/b', 'a\\b', 'http://example.com',
    'example.com/path', 'bad host!', 'a b.com', '<script>', 'exa*mple.com',
  ]) {
    assert.equal(normalizeWhitelistHost(v), null, `${JSON.stringify(v)} 应被拒`)
  }
})

test('点结构异常被拒（防 .. 与首尾点、连续点混入）', () => {
  for (const v of ['.', '..', '...', '.example.com', 'example.com.', 'a..b']) {
    assert.equal(normalizeWhitelistHost(v), null, `${JSON.stringify(v)} 应被拒`)
  }
})

test('超长串被拒（长度上限）', () => {
  const long = 'a'.repeat(MAX_HOST_LEN) + '.com'
  assert.equal(normalizeWhitelistHost(long), null)
  assert.equal(normalizeWhitelistHost('a'.repeat(MAX_HOST_LEN)), 'a'.repeat(MAX_HOST_LEN), '刚好等于上限仍通过')
})

test('不判断"是否可信/是否本机"——只回答"能否作为白名单项"（那是 DEFAULT_WHITELIST 的职责）', () => {
  // 任意合法域名都通过（哪怕它明显是恶意的）；是否放行由 isWhitelisted 的默认表与白名单文件决定
  assert.equal(normalizeWhitelistHost('evil.com'), 'evil.com')
  assert.equal(normalizeWhitelistHost('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeWhitelistHost('localhost'), 'localhost')
})
