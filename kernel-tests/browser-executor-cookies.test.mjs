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

// ★ Task 6 补的覆盖：上面对假 session 忽略了 `cookies.get` 的**入参**，
//   于是"按 URL 过滤"这条分支零覆盖。真机上它是安全边界：不带 url 取的是**整个分区**的 cookie，
//   会被拼进请求头发给别的站点（跨站外发登录态）。故断言 options 必须带 url。
test('cookies.get 必须按 URL 取（按 url 过滤分支；无 url 才退回整个分区）', async () => {
  const seen = []
  const ex = new BrowserExecutor()
  ex.cookieSession = () => ({ cookies: { get: async (opts) => { seen.push(opts); return [{ name: 'sid', value: '1' }] } } })
  assert.equal(await ex.getCookieHeader('app-site-x.com', 'https://x.com/orders'), 'sid=1')
  assert.deepEqual(seen, [{ url: 'https://x.com/orders' }], '取 Cookie 必须带上 URL')
  assert.deepEqual(await ex.getCookies('app-site-x.com', 'https://x.com/'), [{ name: 'sid', value: '1' }])
  assert.deepEqual(seen[1], { url: 'https://x.com/' })
  await ex.getCookies('app-site-x.com')
  assert.deepEqual(seen[2], {}, '没给 URL 时退回"取整个分区"（既有行为，调用点显式传 URL 才走过滤分支）')
})
