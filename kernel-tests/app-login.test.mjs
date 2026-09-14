// 应用智控·登录态 Task 5：登录编排 app-login.ensureLoggedIn 的行为契约。
// ★ 全部用假执行器 + 假时钟：不启 Electron、不联网、不依赖真实 3 秒/5 分钟等待。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  ensureLoggedIn, resolveLoginWait, cancelLoginWait, pendingCount, loginResultDetail,
  loginSucceeded, DEFAULT_WAIT_MS, POLL_MS,
} = require('../electron/app-login.cjs')

/** 假执行器：cookie 指纹按调用次序返回序列；快照可注入 */
function fakeExecutor({ fingerprints = [], snapshots = [], openFail = false, navFail = false } = {}) {
  let fpIdx = 0, snapIdx = 0
  const calls = []
  return {
    calls,
    openWindow: async (key) => { calls.push(['openWindow', key]); if (openFail) throw new Error('open boom'); return { ok: true } },
    exec: async (key, action) => {
      calls.push(['exec', key, action])
      if (action === 'goto') return navFail ? { ok: false, error: '导航被拒' } : { ok: true, snapshot: { page: { url: 'https://x.com/login' } } }
      if (action === 'snapshot') {
        const s = snapshots[Math.min(snapIdx++, snapshots.length - 1)]
        return { ok: true, snapshot: s || { page: { logged_in: null } } }
      }
      return { ok: true }
    },
    getCookieFingerprint: async () => fingerprints[Math.min(fpIdx++, fingerprints.length - 1)] ?? 'empty',
  }
}

const fastDeps = () => ({ sleep: async () => {}, now: (() => { let t = 0; return () => (t += 10) })() })
/** 真实 setTimeout 但小值 waitMs/pollMs —— 用于测「外部信号打断等待」 */
const realDeps = () => ({ sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() })

test('已在登录态：快照 logged_in=true → 立刻返回，不开窗不等待', async () => {
  const ex = fakeExecutor({ snapshots: [{ page: { logged_in: true } }] })
  const r = await ensureLoggedIn({ key: 'k', url: 'https://x.com/a', executor: ex, deps: fastDeps() })
  assert.equal(r.ok, true); assert.equal(r.reason, 'already-logged-in')
  assert.equal(ex.calls.some((c) => c[0] === 'openWindow'), false)
})

test('自动成功：cookie 指纹变化（用户没点任何按钮）', async () => {
  const ex = fakeExecutor({ fingerprints: ['empty', 'empty', 'n1:abc'], snapshots: [{ page: { logged_in: null } }] })
  const events = []
  const r = await ensureLoggedIn({ key: 'k', url: 'https://x.com/login', executor: ex, deps: fastDeps(), emit: (e) => events.push(e) })
  assert.equal(r.ok, true); assert.equal(r.reason, 'cookie-changed')
  assert.match(events[0].detail, /请在其中完成登录/)
  assert.equal(events[events.length - 1].waiting, false)
})

test('自动成功：快照显示已登录（cookie 没变也能判定）', async () => {
  const ex = fakeExecutor({ fingerprints: ['empty', 'empty'], snapshots: [{ page: { logged_in: true } }] })
  const r = await ensureLoggedIn({ key: 'k', url: 'https://x.com/login', executor: ex, deps: fastDeps() })
  assert.equal(r.ok, true); assert.equal(r.reason, 'logged-in')
})

test('用户点「我已完成登录」→ user-confirmed（无需等到 cookie 变化）', async () => {
  const ex = fakeExecutor({ fingerprints: ['empty'], snapshots: [{ page: { logged_in: null } }] })
  const p = ensureLoggedIn({ key: 'k', url: 'https://x.com/login', executor: ex, deps: realDeps(), waitMs: 3000, pollMs: 20 })
  setTimeout(() => resolveLoginWait('k'), 30)
  const r = await p
  assert.equal(r.ok, true); assert.equal(r.reason, 'user-confirmed')
})

test('取消等待 → cancelled，且不假装成功', async () => {
  const ex = fakeExecutor({ snapshots: [{ page: { logged_in: null } }] })
  const p = ensureLoggedIn({ key: 'k', url: 'https://x.com/login', executor: ex, deps: realDeps(), waitMs: 3000, pollMs: 20 })
  setTimeout(() => cancelLoginWait('k'), 30)
  const r = await p
  assert.equal(r.ok, false); assert.equal(r.reason, 'cancelled')
})

test('超时 → timeout + 人话错误（调用方据此标注"未在登录态下验证"）', async () => {
  const ex = fakeExecutor({ fingerprints: ['empty'], snapshots: [{ page: { logged_in: null } }] })
  const r = await ensureLoggedIn({ key: 'k', url: 'https://x.com/login', executor: ex, deps: fastDeps(), waitMs: 10 })
  assert.equal(r.ok, false); assert.equal(r.reason, 'timeout')
  assert.match(r.error, /超时|未在登录态/)
  assert.equal(DEFAULT_WAIT_MS, 5 * 60 * 1000)
})

test('执行器缺失 / 开窗失败 / 导航失败：各自如实报 reason', async () => {
  assert.equal((await ensureLoggedIn({ key: 'k', url: 'https://x.com/', executor: null })).reason, 'no-executor')
  assert.equal((await ensureLoggedIn({ key: 'k', url: 'https://x.com/', executor: fakeExecutor({ openFail: true }), deps: fastDeps() })).reason, 'open-failed')
  assert.equal((await ensureLoggedIn({ key: 'k', url: 'https://x.com/', executor: fakeExecutor({ navFail: true }), deps: fastDeps() })).reason, 'nav-failed')
})

test('loginSucceeded：logged_in=true 或已离开登录页且无密码框', () => {
  assert.equal(loginSucceeded({ page: { logged_in: true } }, 'https://x.com/login'), true)
  assert.equal(loginSucceeded({ page: { url: 'https://x.com/orders', interactives: [{ tag: 'link', label: '订单' }] } }, 'https://x.com/login'), true)
  assert.equal(loginSucceeded({ page: { url: 'https://x.com/login', interactives: [{ tag: 'textbox', label: '密码' }] } }, 'https://x.com/login'), false)
  assert.equal(loginSucceeded(null, 'https://x.com/login'), false)
})

// —— 以下为本任务补充的契约守卫（失败/超时如实原则、注册表不泄漏、可注入语义）——

test('超时文案必须同时含"超时"与"未在登录态"，且不得伪装成功', async () => {
  const ex = fakeExecutor({ fingerprints: ['empty'], snapshots: [{ page: { logged_in: null } }] })
  const r = await ensureLoggedIn({ key: 'k', url: 'https://x.com/login', executor: ex, deps: fastDeps(), waitMs: 10 })
  assert.equal(r.ok, false)
  assert.match(r.error, /超时/)
  assert.match(r.error, /未在登录态/)
  assert.ok(Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0)
})

test('等待注册表：命中 true / 未命中 false，且结束后清理（不泄漏）', async () => {
  const ex = fakeExecutor({ snapshots: [{ page: { logged_in: null } }] })
  const p = ensureLoggedIn({ key: 'reg', url: 'https://x.com/login', executor: ex, deps: realDeps(), waitMs: 2000, pollMs: 20 })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(pendingCount(), 1, '等待期间登记表里应有 1 条')
  assert.equal(resolveLoginWait('nope'), false)
  assert.equal(cancelLoginWait('nope'), false)
  assert.equal(resolveLoginWait('reg'), true)
  const r = await p
  assert.equal(r.reason, 'user-confirmed')
  assert.equal(pendingCount(), 0, 'finally 必须清理登记表')
  assert.equal(resolveLoginWait('reg'), false, '结束后再点无效（不残留 resolve）')
})

test('超时路径同样清理登记表', async () => {
  const ex = fakeExecutor({ snapshots: [{ page: { logged_in: null } }] })
  const r = await ensureLoggedIn({ key: 'to', url: 'https://x.com/login', executor: ex, deps: fastDeps(), waitMs: 10 })
  assert.equal(r.reason, 'timeout')
  assert.equal(pendingCount(), 0)
})

test('指纹读取抛错 ≠ 未登录：读不到就没有该路信号，仍靠快照判据成功', async () => {
  const ex = {
    calls: [],
    openWindow: async () => ({ ok: true }),
    exec: async (k, action) => ({ ok: true, snapshot: { page: { logged_in: action === 'snapshot' ? true : null } } }),
    getCookieFingerprint: async () => { throw new Error('读不到 cookie') },
  }
  const r = await ensureLoggedIn({ key: 'e', url: 'https://x.com/login', executor: ex, deps: fastDeps() })
  assert.equal(r.ok, true); assert.equal(r.reason, 'logged-in')
})

test('执行器缺 getCookieFingerprint 也不影响编排（该路信号缺失而已）', async () => {
  const ex = {
    openWindow: async () => ({ ok: true }),
    exec: async (k, action) => ({ ok: true, snapshot: { page: { logged_in: action === 'snapshot' ? true : null } } }),
  }
  const r = await ensureLoggedIn({ key: 'e2', url: 'https://x.com/login', executor: ex, deps: fastDeps() })
  assert.equal(r.ok, true); assert.equal(r.reason, 'logged-in')
})

test('已在登录态时不打扰用户：不 emit 登录事件', async () => {
  const ex = fakeExecutor({ snapshots: [{ page: { logged_in: true } }] })
  const events = []
  const r = await ensureLoggedIn({ key: 'k', url: 'https://x.com/a', executor: ex, deps: fastDeps(), emit: (e) => events.push(e) })
  assert.equal(r.reason, 'already-logged-in')
  assert.equal(events.length, 0)
})

test('emit 抛错不得影响编排（进度只用于展示）', async () => {
  const ex = fakeExecutor({ fingerprints: ['empty', 'n1:abc'], snapshots: [{ page: { logged_in: null } }] })
  const r = await ensureLoggedIn({ key: 'k', url: 'https://x.com/login', executor: ex, deps: fastDeps(), emit: () => { throw new Error('renderer gone') } })
  assert.equal(r.ok, true); assert.equal(r.reason, 'cookie-changed')
})

test('loginResultDetail：成功/取消/超时文案如实，集中在模块内', () => {
  assert.match(loginResultDetail({ ok: true, reason: 'cookie-changed' }), /重新获取页面/)
  assert.match(loginResultDetail({ ok: true, reason: 'user-confirmed' }), /我已完成登录/)
  assert.match(loginResultDetail({ ok: false, reason: 'timeout' }), /超时/)
  assert.match(loginResultDetail({ ok: false, reason: 'timeout' }), /未在登录态下验证/)
  assert.match(loginResultDetail({ ok: false, reason: 'cancelled', error: '用户取消等待登录' }), /用户取消等待登录/)
  assert.match(loginResultDetail({ ok: false, reason: 'open-failed', error: '打开登录窗口失败：x' }), /打开登录窗口失败/)
})

test('导出契约：POLL_MS 与 DEFAULT_WAIT_MS 是正整数且满足 default < 10min', () => {
  assert.ok(Number.isInteger(POLL_MS) && POLL_MS > 0)
  assert.ok(Number.isInteger(DEFAULT_WAIT_MS) && DEFAULT_WAIT_MS > 0)
  assert.ok(POLL_MS < DEFAULT_WAIT_MS)
})
