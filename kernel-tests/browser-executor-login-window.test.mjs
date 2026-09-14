// 应用智控·登录窗口保活 + 登录态指纹（executor 侧）——2026-09-14 真机故障的修复契约。
//
// 真机现象：「手动登录了但是好像读取不到登录状态」——站点 www.yfljsj.com 是 Vue SPA，登录 token
// 只写 sessionStorage（`vea:auth:access_token`），不落盘、随渲染进程一起消失。于是：
//   ① 窗口被销毁/被别的键挤掉 → 刚登录的会话直接丢（用户重开同一站点又是登录页）；
//   ② "是否已登录"只看 cookie（该分区一行 cookie 都没有）→ 永远判成未登录。
//
// 本文件**不加载 Electron**：用 Module._load 钩子注入假 electron（只需覆盖 ensureWindow 用到的那几个 API）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import { createRequire } from 'node:module'

// --- 假 electron（必须在 require browser-executor 之前挂好钩子）---
const created = []
const fakeSession = () => ({
  cleared: 0,
  on() {},
  async clearStorageData() { this.cleared += 1 },
})
class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts
    this.handlers = {}
    this.destroyed = false
    this.shown = 0
    this.hidden = 0
    this.focused = 0
    this.url = 'about:blank'
    this.execScripts = []
    this.session = fakeSession()
    this.webContents = {
      session: this.session,
      on() {},
      setWindowOpenHandler() {},
      debugger: { attach() {}, on() {} },
      getURL: () => this.url,
      executeJavaScript: async (script) => {
        this.execScripts.push(script)
        if (typeof this.onExec === 'function') return this.onExec(script)
        return { ok: true, keys: 0, hash: 'h0' }
      },
      downloadURL() {},
      loadURL: async () => {},
    }
    created.push(this)
  }
  on(evt, fn) { (this.handlers[evt] ||= []).push(fn) }
  emit(evt, arg) { for (const fn of this.handlers[evt] || []) fn(arg) }
  isDestroyed() { return this.destroyed }
  show() { this.shown += 1 }
  hide() { this.hidden += 1 }
  focus() { this.focused += 1 }
  destroy() { this.destroyed = true; this.emit('closed') }
  /** 模拟用户点右上角 X：返回是否被拦下（preventDefault） */
  clickClose() {
    let prevented = false
    this.emit('close', { preventDefault: () => { prevented = true } })
    if (!prevented) { this.destroyed = true; this.emit('closed') }
    return prevented
  }
}
const origLoad = Module._load
Module._load = function (request, ...rest) {
  // app.getPath：ensureWindow 注册下载处理器时要拿 downloads 目录（假实现给个临时路径即可）
  if (request === 'electron') return {
    BrowserWindow: FakeBrowserWindow,
    app: { getPath: () => process.env.TEMP || process.env.TMP || '/tmp' },
  }
  return origLoad.call(this, request, ...rest)
}
const require = createRequire(import.meta.url)
const { BrowserExecutor } = require('../electron/browser-executor.cjs')
// ★ 钩子**不还原**：ensureWindow 是在调用时 require('electron') 的，还原了就没假窗口可用
//   （node --test 每个文件独立进程，不会污染别的测试文件）。

const KEY_A = 'app-site-yfljsj.com'
const KEY_B = 'app-site-other.com'

// ---------------------------------------------------------------------------
// ① keepAlive（用户主动登录的窗口）：点 X 只隐藏，不销毁
// ---------------------------------------------------------------------------

test('★ 用户登录窗口点 X 只隐藏不销毁（销毁 = sessionStorage 登录态一起丢）', async () => {
  const ex = new BrowserExecutor()
  await ex.openWindow(KEY_A, { keepAlive: true })
  const win = ex.win
  assert.equal(win.clickClose(), true, 'keepAlive 窗口的 close 必须被拦下')
  assert.equal(win.isDestroyed(), false, '★ 绝不能销毁：站点登录 token 可能在 sessionStorage 里')
  assert.equal(win.hidden, 1, '拦下后隐藏窗口（等价于界面上的"关闭"）')
  assert.equal(ex.win, win, '窗口仍归该键所有，可继续复用')
})

test('非 keepAlive 窗口（AI 后台自动化建的）行为不变：点 X 正常关闭', async () => {
  const ex = new BrowserExecutor()
  await ex.ensureWindow(KEY_A)
  const win = ex.win
  assert.equal(win.clickClose(), false)
  assert.equal(win.isDestroyed(), true)
  assert.equal(ex.win, null, 'closed 事件要把当前窗口置空（否则后续拿到已销毁窗口）')
})

test('程序化销毁（清空会话/退出清理）不被 close 拦截挡住', async () => {
  const ex = new BrowserExecutor()
  await ex.openWindow(KEY_A, { keepAlive: true })
  const win = ex.win
  ex.destroyWindow()
  assert.equal(win.isDestroyed(), true, 'destroyWindow 必须真的销毁 keepAlive 窗口')
  assert.equal(ex.parked.size, 0)
})

// ---------------------------------------------------------------------------
// ② 单窗口换键：keepAlive 窗口被**挂起保活**而不是销毁
// ---------------------------------------------------------------------------

test('★ 换键时用户登录窗口被挂起而非销毁；再用原键时复用同一实例（登录态/页面都还在）', async () => {
  const ex = new BrowserExecutor()
  await ex.openWindow(KEY_A, { keepAlive: true })
  const winA = ex.win

  const winB = await ex.ensureWindow(KEY_B)   // 别的键要用窗口（真机：探测/生成/状态条）
  assert.notEqual(winB, winA)
  assert.equal(winA.isDestroyed(), false, '★ 登录窗口不得被别的键挤掉销毁')
  assert.equal(winA.hidden, 1, '挂起时隐藏（用户视角：窗口收起了，登录态还在）')
  assert.equal(ex.parked.get(KEY_A), winA, '挂起表按站点级键登记')
  assert.equal(ex.win, winB)

  const back = await ex.ensureWindow(KEY_A)   // 回到该站点
  assert.equal(back, winA, '★ 必须复用原窗口实例：sessionStorage 登录态绑在渲染进程上')
  assert.equal(ex.win, winA)
  assert.equal(ex.parked.has(KEY_A), false, '复用后要从挂起表摘除（否则下次 park 会误销毁）')
})

test('挂起后再换键：窗口依旧只被挂起一次、不会被销毁（复用→再挂起的往返）', async () => {
  const ex = new BrowserExecutor()
  await ex.openWindow(KEY_A, { keepAlive: true })
  const winA = ex.win
  await ex.ensureWindow(KEY_B)
  await ex.ensureWindow(KEY_A)
  await ex.ensureWindow(KEY_B)
  assert.equal(winA.isDestroyed(), false, '往返多次也必须活着')
  assert.equal(winA.hidden, 2)
  assert.equal(ex.parked.get(KEY_A), winA)
})

test('挂起窗口被外部销毁（强杀/系统回收）时把挂起表清干净，不残留已销毁窗口', async () => {
  const ex = new BrowserExecutor()
  await ex.openWindow(KEY_A, { keepAlive: true })
  const winA = ex.win
  await ex.ensureWindow(KEY_B)
  winA.destroy()   // 外部销毁 → closed 事件
  assert.equal(ex.parked.has(KEY_A), false, '挂起表不得留下已销毁窗口的引用')
})

test('非 keepAlive 的旧窗口换键时照旧销毁（避免窗口越积越多）', async () => {
  const ex = new BrowserExecutor()
  await ex.ensureWindow(KEY_A)
  const winA = ex.win
  await ex.ensureWindow(KEY_B)
  assert.equal(winA.isDestroyed(), true, 'AI 后台自动化窗口不需要保活')
  assert.equal(ex.parked.size, 0)
})

test('destroyAllWindows：连挂起保活的登录窗口一起清（退出/crash 清理用）', async () => {
  const ex = new BrowserExecutor()
  await ex.openWindow(KEY_A, { keepAlive: true })
  const winA = ex.win
  ex.destroyAllWindows()
  assert.equal(winA.isDestroyed(), true)
  assert.equal(ex.parked.size, 0)
})

// ---------------------------------------------------------------------------
// ③ 登录态指纹：cookie + storage；读不到 ≠ 没有
// ---------------------------------------------------------------------------

const withCookies = (ex, cookies) => { ex.cookieSession = () => ({ cookies: { get: async () => cookies } }); return ex }

test('★ getStorageFingerprint：无窗口 → ?（读不到，绝不冒充"没有登录态"）', async () => {
  const ex = withCookies(new BrowserExecutor(), [])
  assert.equal(await ex.getStorageFingerprint(KEY_A, 'http://www.yfljsj.com/'), '?')
})

test('★ getStorageFingerprint：窗口不在同站点（空白页/别的站）→ ?（storage 按 origin 隔离，读了也不是该站的）', async () => {
  const ex = withCookies(new BrowserExecutor(), [])
  const win = await ex.ensureWindow(KEY_A)
  win.url = 'about:blank'
  assert.equal(await ex.getStorageFingerprint(KEY_A, 'http://www.yfljsj.com/'), '?')
  win.url = 'http://other.com/'
  assert.equal(await ex.getStorageFingerprint(KEY_A, 'http://www.yfljsj.com/'), '?')
})

test('getStorageFingerprint：同站点 → none（确实没有会话痕迹）/ yes:hash（有，如 sessionStorage token）', async () => {
  const ex = withCookies(new BrowserExecutor(), [])
  const win = await ex.ensureWindow(KEY_A)
  win.url = 'http://www.yfljsj.com/login'   // apex 跳 www 也算同站点
  win.onExec = async () => ({ ok: true, keys: 0, hash: 'h0' })
  assert.equal(await ex.getStorageFingerprint(KEY_A, 'http://www.yfljsj.com/'), 'none')
  win.onExec = async () => ({ ok: true, keys: 1, hash: 'ab12' })
  assert.equal(await ex.getStorageFingerprint(KEY_A, 'http://www.yfljsj.com/'), 'yes:ab12')
})

test('getStorageFingerprint：探测脚本读不了 storage（ok:false）或抛错 → ?，绝不抛给调用方', async () => {
  const ex = withCookies(new BrowserExecutor(), [])
  const win = await ex.ensureWindow(KEY_A)
  win.url = 'http://www.yfljsj.com/'
  win.onExec = async () => ({ ok: false, keys: 0, hash: '' })
  assert.equal(await ex.getStorageFingerprint(KEY_A, 'http://www.yfljsj.com/'), '?')
  win.onExec = async () => { throw new Error('页面导航中') }
  assert.equal(await ex.getStorageFingerprint(KEY_A, 'http://www.yfljsj.com/'), '?')
})

test('getLoginFingerprint：合成 `c:…|s:…`；cookie 空 + sessionStorage 有 token ⇒ 上层能判成"已登录"', async () => {
  const ex = withCookies(new BrowserExecutor(), [])
  const win = await ex.ensureWindow(KEY_A)
  win.url = 'http://www.yfljsj.com/'
  win.onExec = async () => ({ ok: true, keys: 1, hash: 'ab12' })
  const fp = await ex.getLoginFingerprint(KEY_A, 'http://www.yfljsj.com/')
  assert.match(fp, /^c:empty\|s:yes:ab12$/, `该站点没有 cookie，登录态只能从 storage 看到：${fp}`)
})

// ---------------------------------------------------------------------------
// ④ 「清空会话」必须连挂起窗口一起清（否则用户以为登出了、其实登录态还在）
// ---------------------------------------------------------------------------

test('★ clear-session 覆盖挂起保活窗口：清存储 + 销毁（登录态的唯一清除入口）', async () => {
  const ex = withCookies(new BrowserExecutor(), [])
  await ex.openWindow(KEY_A, { keepAlive: true })
  const winA = ex.win
  await ex.ensureWindow(KEY_B)               // 登录窗口被挂起
  assert.equal(ex.parked.get(KEY_A), winA)

  await ex.closeSession(KEY_A)
  assert.equal(winA.session.cleared, 1, '★ 挂起窗口的存储也要清（旧实现只看当前窗口 → 假清成功）')
  assert.equal(winA.isDestroyed(), true, '清完销毁')
  assert.equal(ex.parked.has(KEY_A), false, '挂起表清空')
  assert.equal(ex.win.isDestroyed(), false, '别的键的当前窗口不受影响')
})

test('clear-session 对不存在的键：静默成功（幂等，不误伤当前窗口）', async () => {
  const ex = withCookies(new BrowserExecutor(), [])
  await ex.ensureWindow(KEY_A)
  const r = await ex.closeSession('app-site-nope.com')
  assert.deepEqual(r, { ok: true })
  assert.equal(ex.win.isDestroyed(), false, '别把别人的窗口清掉')
  assert.equal(ex.win.session.cleared, 0)
})
