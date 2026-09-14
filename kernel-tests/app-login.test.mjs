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
/** 假时钟但每步跳 step ms —— 用于"大步长快速跑完长等待"（文案单位用例） */
const stepDeps = (step) => ({ sleep: async () => {}, now: (() => { let t = 0; return () => (t += step) })() })

/** 真实小值等待（毫秒级）——时序用例里等事件发生用（注意：与 ensureLoggedIn 的 waitMs 选项无关） */
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 时序可控的执行器（fix round 1 用）：开窗可延迟、goto 可抛错、openWindow 可返回 {ok:false}。
 * 与上方的 fakeExecutor 分开，保持 brief Step 1 的假执行器逐字不动。
 * fix round 2 增 `snapDelayMs`：让 snapshot 往返变慢，用于复现"预判快照期间点击"（F9）。
 */
function timingExecutor({ openDelayMs = 0, gotoThrows = false, openRes = null, snapshot = { page: { logged_in: null } }, snapDelayMs = 0 } = {}) {
  const calls = []
  return {
    calls,
    openWindow: async (key) => {
      calls.push(['openWindow', key])
      if (openDelayMs) await new Promise((r) => setTimeout(r, openDelayMs))
      return openRes || { ok: true }
    },
    exec: async (key, action) => {
      calls.push(['exec', key, action])
      if (action === 'goto') {
        if (gotoThrows) throw new Error('goto boom')
        return { ok: true }
      }
      if (action === 'snapshot' && snapDelayMs) await new Promise((r) => setTimeout(r, snapDelayMs))
      return { ok: true, snapshot }
    },
    getCookieFingerprint: async () => 'empty',
  }
}

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
  // ★ pendingCount() 是模块全局计数：断言一律用"相对前后差值"，避免前序用例泄漏时连带失败
  const before = pendingCount()
  const ex = fakeExecutor({ snapshots: [{ page: { logged_in: null } }] })
  const p = ensureLoggedIn({ key: 'reg', url: 'https://x.com/login', executor: ex, deps: realDeps(), waitMs: 2000, pollMs: 20 })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(pendingCount() - before, 1, '等待期间登记表里应有 1 条（相对进入前）')
  assert.equal(resolveLoginWait('nope'), false)
  assert.equal(cancelLoginWait('nope'), false)
  assert.equal(resolveLoginWait('reg'), true)
  const r = await p
  assert.equal(r.reason, 'user-confirmed')
  assert.equal(pendingCount(), before, 'finally 必须清理登记表（回到进入前的计数）')
  assert.equal(resolveLoginWait('reg'), false, '结束后再点无效（不残留 resolve）')
})

test('超时路径同样清理登记表', async () => {
  const before = pendingCount()
  const ex = fakeExecutor({ snapshots: [{ page: { logged_in: null } }] })
  const r = await ensureLoggedIn({ key: 'to', url: 'https://x.com/login', executor: ex, deps: fastDeps(), waitMs: 10 })
  assert.equal(r.reason, 'timeout')
  assert.equal(pendingCount(), before)
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

// —— fix round 1（审查 F1–F7）：信号时序、同 key 并发、出口契约、预判取舍、文案单位 ——

test('F1: 开窗期间点「我已完成登录」也要生效（登记必须先于 openWindow）', async () => {
  const before = pendingCount()
  const ex = timingExecutor({ openDelayMs: 80 })
  const p = ensureLoggedIn({ key: 'f1', url: 'https://x.com/login', executor: ex, deps: realDeps(), waitMs: 1500, pollMs: 20 })
  await new Promise((r) => setTimeout(r, 20)) // openWindow（80ms）尚未返回，用户此时点「我已完成登录」
  const clicked = resolveLoginWait('f1')
  const r = await p
  assert.equal(clicked, true, '开窗期间点击必须命中登记（否则信号被永久丢弃）')
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'user-confirmed')
  assert.equal(pendingCount(), before, '开窗期间也必须登记、且收尾必须清理')
})

test('F2①: 同 key 两个等待者共享同一登记——一次点击把两个都唤醒', async () => {
  const before = pendingCount()
  const a = ensureLoggedIn({ key: 'f2c', url: 'https://x.com/login', executor: timingExecutor(), deps: realDeps(), waitMs: 400, pollMs: 20 })
  await new Promise((r) => setTimeout(r, 60))
  const b = ensureLoggedIn({ key: 'f2c', url: 'https://x.com/login', executor: timingExecutor(), deps: realDeps(), waitMs: 2000, pollMs: 20 })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(pendingCount() - before, 1, '同 key 并发只应有一条登记（复用而非覆盖）')
  assert.equal(resolveLoginWait('f2c'), true)
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.reason, 'user-confirmed', '先进入的等待者不能被后来的覆盖而干等到超时')
  assert.equal(rb.reason, 'user-confirmed')
  assert.equal(pendingCount(), before, '最后一个使用者退出后才清理登记')
})

test('F2②: 先进入者超时退出后，后进入者的点击仍有效（登记不被误删）', async () => {
  const before = pendingCount()
  const a = ensureLoggedIn({ key: 'f2d', url: 'https://x.com/login', executor: timingExecutor(), deps: realDeps(), waitMs: 150, pollMs: 20 })
  await new Promise((r) => setTimeout(r, 30))
  const b = ensureLoggedIn({ key: 'f2d', url: 'https://x.com/login', executor: timingExecutor(), deps: realDeps(), waitMs: 1000, pollMs: 20 })
  const ra = await a // 先进入者超时 → 走 finally
  assert.equal(ra.reason, 'timeout')
  assert.equal(pendingCount() - before, 1, '先进入者退出不得删掉仍在等待的登记')
  assert.equal(resolveLoginWait('f2d'), true, '后进入者的点击仍必须命中')
  const rb = await b
  assert.equal(rb.reason, 'user-confirmed')
  assert.equal(pendingCount(), before)
})

test('F3: goto 抛错 → 不 reject，返 {ok:false, reason:"nav-failed"}（出口只有 ok/reason）', async () => {
  const before = pendingCount()
  const ex = timingExecutor({ gotoThrows: true })
  const r = await ensureLoggedIn({ key: 'f3', url: 'https://x.com/login', executor: ex, deps: realDeps(), waitMs: 200, pollMs: 20 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'nav-failed')
  assert.match(r.error, /打开页面失败/)
  assert.equal(pendingCount(), before, '早退路径（goto 抛错）也必须清理登记')
})

test('F4: url 是登录页时，快照自身已离开登录路径且无密码框 → already-logged-in 且不开窗', async () => {
  const ex = fakeExecutor({ snapshots: [{ page: { url: 'https://x.com/orders', interactives: [{ tag: 'link', label: '订单' }] } }] })
  const r = await ensureLoggedIn({ key: 'f4', url: 'https://x.com/login', executor: ex, deps: fastDeps() })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'already-logged-in')
  assert.equal(ex.calls.some((c) => c[0] === 'openWindow'), false, '这条证据成立时不得无谓开窗（否则真已登录的用户会假超时）')
})

test('F4 取舍守卫：url 是登录页时 logged_in=true 不构成"预判已登录"，仍走开窗+等待', async () => {
  const ex = fakeExecutor({ fingerprints: ['empty'], snapshots: [{ page: { logged_in: true } }] })
  const r = await ensureLoggedIn({ key: 'f4b', url: 'https://x.com/login', executor: ex, deps: fastDeps() })
  assert.equal(r.reason, 'logged-in', '登录页上的 logged_in 不可信，必须开窗后靠等待流程判定')
  assert.equal(ex.calls.some((c) => c[0] === 'openWindow'), true)
})

test('F5: openWindow 返回 {ok:false} → open-failed（含原原因），不再被当成成功', async () => {
  const before = pendingCount()
  const ex = timingExecutor({ openRes: { ok: false, error: '窗口打不开' } })
  const r = await ensureLoggedIn({ key: 'f5', url: 'https://x.com/login', executor: ex, deps: realDeps(), waitMs: 200, pollMs: 20 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'open-failed')
  assert.match(r.error, /窗口打不开/)
  assert.equal(pendingCount(), before)
})

test('F6: 超时文案按量级选单位（<60s 用秒，绝不出现"0 分钟"）', async () => {
  const seconds = await ensureLoggedIn({ key: 'f6', url: 'https://x.com/login', executor: timingExecutor(), deps: stepDeps(10), waitMs: 20000, pollMs: 20 })
  assert.equal(seconds.ok, false)
  assert.equal(seconds.reason, 'timeout')
  assert.match(seconds.error, /超时/)
  assert.match(seconds.error, /未在登录态/)
  assert.match(seconds.error, /20 秒/)
  assert.doesNotMatch(seconds.error, /0 分钟/)

  const minutes = await ensureLoggedIn({ key: 'f6m', url: 'https://x.com/login', executor: timingExecutor(), deps: stepDeps(5000), waitMs: DEFAULT_WAIT_MS, pollMs: 20 })
  assert.equal(minutes.reason, 'timeout')
  assert.match(minutes.error, /5 分钟/)
})

// —— fix round 2（审查 F8–F9）：已结算登记不得被复用 / 登记早于预判快照 ——

test('F8①: 结算（点击完成）后新发起的同 key 调用不得复用已 resolve 的登记', async () => {
  const before = pendingCount()
  // 旧调用：开窗延迟期间用户点了「我已完成登录」→ 登记被结算，但旧等待者此刻还没返回
  const a = ensureLoggedIn({ key: 'f8c', url: 'https://x.com/login', executor: timingExecutor({ openDelayMs: 120 }), deps: realDeps(), waitMs: 1500, pollMs: 20 })
  await tick(20)
  assert.equal(resolveLoginWait('f8c'), true)
  assert.equal(pendingCount(), before, '结算即摘除登记：不得把已 resolve 的登记留在表里给后来者复用')
  // 新调用：同 key，且全程无任何用户操作
  const b = ensureLoggedIn({ key: 'f8c', url: 'https://x.com/login', executor: timingExecutor(), deps: realDeps(), waitMs: 300, pollMs: 20 })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.reason, 'user-confirmed', 'F2 语义保住：已持有 promise 的旧等待者照常收到信号')
  assert.equal(rb.ok, false, '没有任何用户操作，绝不能报成功')
  assert.equal(rb.reason, 'timeout', '结算后的新调用必须走正常超时路径（不得凭空 user-confirmed）')
  assert.equal(pendingCount(), before, '两路都收尾后登记表回到进入前水平')
})

test('F8②: 结算（取消）后新发起的同 key 调用不得继承 cancelled（用户并未取消这一次）', async () => {
  const before = pendingCount()
  const a = ensureLoggedIn({ key: 'f8x', url: 'https://x.com/login', executor: timingExecutor({ openDelayMs: 120 }), deps: realDeps(), waitMs: 1500, pollMs: 20 })
  await tick(20)
  assert.equal(cancelLoginWait('f8x'), true)
  assert.equal(pendingCount(), before, '取消结算同样立即摘除登记')
  const b = ensureLoggedIn({ key: 'f8x', url: 'https://x.com/login', executor: timingExecutor(), deps: realDeps(), waitMs: 300, pollMs: 20 })
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.ok, false)
  assert.equal(ra.reason, 'cancelled', '旧等待者照常收到 cancelled')
  assert.equal(rb.ok, false)
  assert.equal(rb.reason, 'timeout', '未取消这一次的新调用不得凭空 cancelled')
  assert.equal(pendingCount(), before)
})

test('F9: 预判快照期间（登记之前）的点击也必须生效——登记要早于预判那次 snapshot', async () => {
  const before = pendingCount()
  const ex = timingExecutor({ snapDelayMs: 80 }) // 预判快照往返 ~80ms
  const p = ensureLoggedIn({ key: 'f9', url: 'https://x.com/login', executor: ex, deps: realDeps(), waitMs: 1200, pollMs: 20 })
  await tick(20) // 预判快照尚未返回，用户此时点「我已完成登录」
  const clicked = resolveLoginWait('f9')
  const r = await p
  assert.equal(clicked, true, '预判期间点击必须命中登记（命中不了 = 信号被永久丢弃 → 假超时）')
  assert.notEqual(r.reason, 'timeout')
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'user-confirmed')
  assert.equal(pendingCount(), before, '提前登记之后整段流程都必须释放干净')
})

test('F9 守卫: 三条早退路径（already-logged-in / open-failed / nav-failed）都必须释放登记（不泄漏）', async () => {
  const before = pendingCount()
  const cases = [
    { key: 'f9a', url: 'https://x.com/a', executor: fakeExecutor({ snapshots: [{ page: { logged_in: true } }] }), reason: 'already-logged-in' },
    { key: 'f9o', url: 'https://x.com/login', executor: timingExecutor({ openRes: { ok: false, error: '窗口打不开' } }), reason: 'open-failed' },
    { key: 'f9n', url: 'https://x.com/login', executor: timingExecutor({ gotoThrows: true }), reason: 'nav-failed' },
  ]
  for (const c of cases) {
    const r = await ensureLoggedIn({ key: c.key, url: c.url, executor: c.executor, deps: realDeps(), waitMs: 300, pollMs: 20 })
    assert.equal(r.reason, c.reason)
    assert.equal(pendingCount(), before, `${c.reason} 早退后登记表必须回到调用前水平（登记提前到预判之前后仍不得泄漏）`)
    assert.equal(resolveLoginWait(c.key), false, `${c.reason} 早退后同 key 不得残留可命中的登记`)
  }
})

// ─────────── 修补：地址解析不了时 loginSucceeded 必须保守返回 false ───────────
// 原实现把"当前地址解析失败"当成"已经离开登录页"（catch 里 onLoginPage=false），
// 于是在登录页上等登录时，一个畸形/相对 URL 的快照就能骗到"登录成功" —— 与它自己的注释
// "拿不准一律返回 false"直接矛盾，后果是带着未登录态继续抓页面、产出残缺命令。

test('loginSucceeded：page.url 解析不了时一律 false（不得因解析失败被判"已离开登录页"）', () => {
  const noPw = { interactives: [{ tag: 'link', label: '订单' }] }
  for (const bad of ['/orders', 'not a url', 'javascript:void(0)', 'http://']) {
    assert.equal(loginSucceeded({ page: { url: bad, ...noPw } }, 'https://x.com/login'), false, `畸形地址被误判成功：${bad}`)
  }
})

test('loginSucceeded：起始地址解析不了时也 false（拿不准不冒充成功）', () => {
  assert.equal(loginSucceeded({ page: { url: 'https://x.com/orders', interactives: [] } }, '/login'), false)
  assert.equal(loginSucceeded({ page: { url: 'https://x.com/orders', interactives: [] } }, ''), false)
})

test('loginSucceeded：正常绝对地址照旧判定（logged_in=true 仍是最强信号，不受本次收紧影响）', () => {
  assert.equal(loginSucceeded({ page: { logged_in: true, url: 'not a url' } }, 'https://x.com/login'), true)
  assert.equal(loginSucceeded({ page: { url: 'https://x.com/orders', interactives: [] } }, 'https://x.com/login'), true)
  assert.equal(loginSucceeded({ page: { url: 'https://x.com/login', interactives: [] } }, 'https://x.com/login'), false)
})
