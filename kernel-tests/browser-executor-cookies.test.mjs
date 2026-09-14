// 说明：本文件**不加载 Electron**——cookie 方法内部 require('electron')，
// 测试通过覆写实例的 cookieSession() 注入假 session（真实方法逻辑照跑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { BrowserExecutor } = require('../electron/browser-executor.cjs')

const withSession = (cookies) => {
  const ex = new BrowserExecutor()
  ex.cookieSession = () => ({ cookies: { get: async () => cookies } })
  return ex
}

test('getCookieHeader：拼成 Cookie 头；无 cookie 返回 null', async () => {
  const ex = withSession([{ name: 'sid', value: '1' }, { name: 't', value: 'a b' }])
  assert.equal(await ex.getCookieHeader('app-site-x.com', 'https://x.com/'), 'sid=1; t=a b')
  assert.equal(await withSession([]).getCookieHeader('k', 'https://x.com/'), null)
})

test('getCookieFingerprint：稳定且对值敏感；无 cookie 为 empty', async () => {
  const a = withSession([{ name: 'sid', value: '1' }])
  const b = withSession([{ name: 'sid', value: '1' }])
  const c = withSession([{ name: 'sid', value: '2' }])
  const fa = await a.getCookieFingerprint('k', 'https://x.com/')
  assert.equal(fa, await b.getCookieFingerprint('k', 'https://x.com/'))  // 同内容 → 同指纹
  assert.notEqual(fa, await c.getCookieFingerprint('k', 'https://x.com/')) // 值变 → 指纹变
  assert.equal(await withSession([]).getCookieFingerprint('k', 'https://x.com/'), 'empty')
})

test('cookie 读取异常一律**不抛**（返回空/empty）——读不到 cookie 不能当"未登录"', async () => {
  const ex = new BrowserExecutor()
  ex.cookieSession = () => { throw new Error('no electron') }
  assert.deepEqual(await ex.getCookies('k', 'https://x.com/'), [])
  assert.equal(await ex.getCookieFingerprint('k', 'https://x.com/'), 'empty')
})
