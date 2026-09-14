// 应用智控：**登录编排**（把"需要登录 → 用户手动登录 → LLM 拿到登录态"接成闭环）。
//
// ★ 用户决策（勿偏离）：
//   · 检测到就直接弹出登录窗口，检测到成功**自动继续**（不需要用户再点"生成"）；
//   · 等待上限 5 分钟，超时**仍继续生成**但明确警示"未在登录态下验证"；
//   · 只有高置信度登录墙才自动弹窗（判定在 app-login-wall.cjs）。
//
// ★ 三路成功信号（任一成立即算成功，理由：不同站点的登录写法差别很大）：
//   a) 登录态指纹出现新证据 —— cookie 变化（登录必然写 cookie 的最通用信号），
//      或 **localStorage/sessionStorage 里会话痕迹从无到有**（SPA 站点把 token 只写 storage 的兜底，
//      真实故障 2026-09-14：yfljsj.com 的 token 只在 sessionStorage，只读 cookie 永远等不到成功）；
//   b) 快照已登录        —— logged_in=true，或已离开登录页且密码框消失；
//   c) 用户点「我已完成登录」—— 给"只写 localStorage、cookie 不变"的站点兜底。
//
// ★ 可注入：executor 与 deps.{now,sleep,getCookieFingerprint} 都可注入，
//   于是"自动成功/超时/取消/执行器缺失"全部能用假执行器单测（不启 Electron、不联网）。
//   ★ 顶层**不得** require Electron：executor 由调用方注入，本文件必须能被 node --test 直接加载。
'use strict'
// LOGIN_PATH_RE / loginSucceeded 的唯一出处是 app-login-page.cjs（零 Electron 依赖的纯函数），
// 这里只做编排与 re-export（测试从 app-login.cjs 导入 loginSucceeded，避免接口漂移）。
const { loginSucceeded, snapshotHasPassword, LOGIN_PATH_RE } = require('./app-login-page.cjs')
// 登录态指纹的唯一真源（cookie + localStorage/sessionStorage）：登录成功信号与"已登录"预判都读它
const { loginStateChangeKind, hasStrongLoginEvidence } = require('./app-login-state.cjs')

const DEFAULT_WAIT_MS = 5 * 60 * 1000
const POLL_MS = 1500
/** 超时文案的"秒/分钟"分界：短于 1 分钟仍按分钟取整会得到误导性的"0 分钟" */
const MINUTE_MS = 60 * 1000

/** 等待注册表：key → { resolve, external, waiters, settled }；供 app:login-done / app:login-cancel 通道命中 */
const pending = new Map()

/**
 * 结算一条登记：唤醒等待者，并**立即把该 key 的登记从表里摘除**。
 * ★ F8：摘除是必需的。已 resolve 的登记若留在表里，后启动的调用者会"复用"同一 promise，
 *   于是**没有任何用户操作**就拿到 `user-confirmed` / `cancelled`（用户视角是"我没点，它却说我登录好了"，
 *   或"我没取消，它却说取消了"）——两者都违反本功能的"如实"原则。
 *   摘除后新调用自然新建登记、走正常等待/超时路径；而**已在等待的旧等待者**已持有 external 引用，
 *   照样收到 `user-confirmed`/`cancelled` —— F2 的"一次点击唤醒所有同 key 等待者"语义不受影响。
 * @returns {boolean} false = 没有可结算的登记（含"已经结算过"），调用方据此提示用户重试
 */
function settleWait(key, how) {
  const k = String(key)
  const reg = pending.get(k)
  if (!reg || reg.settled) return false
  reg.settled = true
  pending.delete(k)
  reg.resolve(how)
  return true
}
function resolveLoginWait(key) { return settleWait(key, 'user-confirmed') }
function cancelLoginWait(key) { return settleWait(key, 'cancelled') }
/** 登记条数（按 key 计；同一 key 的多个等待者共享同一条登记，见 acquireWait） */
function pendingCount() { return pending.size }

/**
 * 取（或复用）等待登记。
 * ★ 同 key 重复进入必须**复用**同一登记，不能覆盖：直接 `set` 会让先进入者的 resolve 被顶掉
 *   （用户明明点了完成，先进入者照样干等到超时），并且先退出者的清理会一并删掉后进入者的登记。
 *   这里用等待者计数：登记的生命周期 = 最后一个使用者退出。
 * ★ F8：**已结算（settled）的登记绝不复用**。正常路径下 settleWait 已把登记摘除，这里再判一次
 *   `settled` 只是兜底（不复用已 resolve 的 promise 是硬约束，不能只依赖调用顺序）。
 *   新调用必须**另起一条新 promise**，否则"无用户操作却报成功/取消"。
 */
function acquireWait(key) {
  let reg = pending.get(key)
  if (!reg || reg.settled) {
    reg = { waiters: 0, settled: false, resolve: () => {} }
    reg.external = new Promise((res) => { reg.resolve = res })
    pending.set(key, reg)
  }
  reg.waiters += 1
  return reg
}
/** 释放登记；计数归零才删除（"先退出的等待者"不得掐断仍在等待的登记；已被结算摘除的登记为 no-op） */
function releaseWait(key, reg) {
  if (pending.get(key) !== reg) return
  reg.waiters -= 1
  if (reg.waiters <= 0) pending.delete(key)
}

function done(ok, reason, t0, now, extra = {}) {
  return { ok, reason, elapsedMs: Math.max(0, now() - t0), ...extra }
}

/** 传入的 url 本身是不是登录页 */
function isLoginUrl(url) {
  try { return LOGIN_PATH_RE.test(new URL(String(url || '')).pathname) } catch { return false }
}

/** 快照自身给的 page.url 是否已"离开登录路径"；地址不可解析时不算证据（保守 false，与 loginSucceeded 同一原则） */
function leftLoginPath(url) {
  try { return !LOGIN_PATH_RE.test(new URL(String(url || '')).pathname) } catch { return false }
}

/** 超时文案：不到 1 分钟用"秒"，避免 `Math.round(waitMs/60000)` 输出误导性的"0 分钟" */
function timeoutError(waitMs) {
  const unit = waitMs < MINUTE_MS
    ? `${Math.max(1, Math.ceil(waitMs / 1000))} 秒`
    : `${Math.round(waitMs / MINUTE_MS)} 分钟`
  return `等待登录超时（${unit}）：本次未在登录态下验证`
}

/**
 * 开窗前的"已登录"预判（brief 自带测试 1 与测试 3 的唯一差异就在传进来的 url）。
 *   · url **不是**登录页：整段预判都可用（含 `logged_in === true` 这条强信号）——
 *     用户本来就在站点里操作，快照说已登录就无需打扰；
 *   · url **是**登录页：只否决 `logged_in === true` 这条捷径（不少站点在登录页也照样输出该字段，
 *     采信它会导致"明明要登录却直接跳过登录"），但**不跳过整段预判**：
 *     仍认"快照自身这一路证据"——page.url 已离开登录路径 且 页面上没有密码框。
 *   ★ 为什么必须留这条：Task 6 主路径传 `wall.loginUrl || webUrl`，只要 loginUrl 非空就永远是登录页 url，
 *     若整段跳过预判，真已登录的用户也会被无谓开窗；对这种"不输出 logged_in 且 cookie 不轮换"的站点，
 *     会白等 5 分钟并给出"未在登录态下验证"的假超时。
 */
function preLoginShortcut(snapshot, url) {
  const page = snapshot?.page
  if (!page) return false
  if (!isLoginUrl(url)) return loginSucceeded(snapshot, url)
  if (page.logged_in === true) return false
  if (snapshotHasPassword(page)) return false
  return leftLoginPath(page.url)
}

/**
 * 打开可见窗口等用户登录（同一分区 = 与命令执行/模型探索共用登录态）。
 *
 * ★ "先探一次快照"的边界（brief 自带测试 1 与测试 3 的唯一差异就在传进来的 url）：
 *   预判逻辑集中在 preLoginShortcut（Fix round 1 / F4 之后：url 是登录页时**只**否决
 *   `logged_in === true` 这条捷径，不再整段跳过预判）。这条路径不会漏判：即使预判为假，
 *   进了等待流程后第一轮快照判定立刻就会给出 logged_in=true → logged-in。
 * ★ 登记的**时机**（Fix round 2 / F9 之后）：等待登记早于"预判快照"（不只是早于开窗）——
 *   预判是一次真实往返，用户在往返期间点击同样不能丢信号；见下方注释与 try/finally。
 */
async function ensureLoggedIn({ key, url, executor, deps = {}, emit, waitMs = DEFAULT_WAIT_MS, pollMs = POLL_MS } = {}) {
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const t0 = now()
  const emitLogin = (p) => { try { emit?.(p) } catch { /* 进度只用于展示，渲染层异常不得影响编排 */ } }

  // 等待期间才需要收尾事件：没打扰过用户（already-logged-in / no-executor 等）就不发
  let announced = false
  const finish = (ok, reason, extra = {}) => {
    const res = done(ok, reason, t0, now, extra)
    if (announced) emitLogin({ phase: 'login', waiting: false, key, url, detail: loginResultDetail(res) })
    return res
  }

  if (!executor) return finish(false, 'no-executor', { error: '浏览器执行器未就绪' })

  // 先看一眼是不是本来就登录着（已登录就别弹窗打扰）；取舍见 preLoginShortcut 注释
  const snapOnce = async () => {
    try { const r = await executor.exec(key, 'snapshot', {}); return r?.snapshot || null } catch { return null }
  }

  // ★ F1：登记必须早于 openWindow。上游（Task 6/7）在调用本函数**之前**就会 emit waiting:true，
  //   渲染层此时已显示「我已完成登录」；而开窗 + goto 要花几百毫秒~数秒（goto 上限 30s）。
  //   若等到导航完成才登记，用户在开窗期间点击会拿不到登记（resolveLoginWait 返 false），
  //   信号被永久丢弃 → 用户视角是"点了没反应，干等 5 分钟"。
  //   副作用（已知并接受）：开窗前就点击 → 以 user-confirmed 提前返回（语义合理：用户说他已完成登录）。
  // ★ F9：登记还要早于**预判那次 snapshot**。预判本身是一次真实往返（百毫秒级），用户在往返期间点击
  //   同样会丢信号 → 最终假超时。所以登记点提到 `if (!executor)` 早退之后的第一件事，
  //   并让 try/finally 从那里起覆盖整段流程（预判 + 开窗 + goto + 等待循环，含 already-logged-in /
  //   open-failed / nav-failed 三条早退——早退也必须释放，登记绝不泄漏）。
  // ★ F2：同 key 并发进入复用同一登记（见 acquireWait），先退出者不得删掉后进入者的登记。
  // ★ F8：已结算的登记会被 settleWait 摘除，后来者不受"已 resolve 的 promise"影响（见 settleWait）。
  const waitKey = String(key)
  const reg = acquireWait(waitKey)
  const external = reg.external
  try {
    // ★ 开窗前的预判多看一路硬证据：storage 里已有会话痕迹（token/auth/session 类键）就说明
    //   本来就在登录态——SPA 站点常不输出 logged_in，只靠快照会把真已登录的用户反复开窗并假超时。
    //   ### 只在执行器提供**合成指纹**（getLoginFingerprint = cookie+storage）时才读 ###：
    //   裸 cookie 指纹判不了 storage，而且这一读会多消耗一次指纹调用，破坏既有假执行器
    //   "按调用次序给指纹"的契约（kernel-tests/app-login.test.mjs）。
    const fpReader = deps.getLoginFingerprint || executor.getLoginFingerprint
    if (typeof fpReader === 'function') {
      let fpBefore = null
      try {
        const v = await fpReader.call(executor, key, url)
        fpBefore = typeof v === 'string' ? v : null
      } catch { fpBefore = null }
      if (hasStrongLoginEvidence(fpBefore)) return finish(true, 'already-logged-in')
    }
    if (preLoginShortcut(await snapOnce(), url)) return finish(true, 'already-logged-in')

    let opened
    try {
      // keepAlive：用户要在这个窗口里手动登录 → 点 X 只隐藏不销毁。
      // 站点把登录态存 sessionStorage 时，销毁渲染进程等于丢掉刚登录的会话（本次故障的成因之一）。
      opened = await executor.openWindow(key, { keepAlive: true })
    } catch (e) {
      return finish(false, 'open-failed', { error: `打开登录窗口失败：${String(e?.message || e)}` })
    }
    // F5：执行器用 {ok:false} 报错（没抛异常）时同样算开窗失败，不能当成成功继续往下走
    if (opened?.ok === false) return finish(false, 'open-failed', { error: `打开登录窗口失败：${opened?.error || '未知错误'}` })

    // F3：goto 抛错必须归一为 {ok:false, reason:'nav-failed'}。否则 Promise 直接 reject，
    //     而契约要求所有出口都是 {ok,reason}（9 个 reason 是唯一取值域），调用方按返回值分支会拿到未捕获 rejection。
    let nav
    try { nav = await executor.exec(key, 'goto', { url }) } catch (e) {
      return finish(false, 'nav-failed', { error: `打开页面失败：${String(e?.message || e)}` })
    }
    if (!nav?.ok) return finish(false, 'nav-failed', { error: `打开页面失败：${nav?.error || '未知错误'}` })

    emitLogin({ phase: 'login', waiting: true, key, url, detail: '需要登录：已在可见窗口中打开该站点，请在其中完成登录（检测到登录成功后会自动继续）…' })
    announced = true

    const baseline = await readFingerprint(deps, executor, key, url)
    const deadline = t0 + waitMs
    while (now() < deadline) {
      // 先看登录态指纹（cookie 或 storage 里出现新的会话证据），再看快照；两者都无变化才继续等
      const fp = await readFingerprint(deps, executor, key, url)
      const kind = loginStateChangeKind(baseline, fp)
      if (kind === 'cookie') return finish(true, 'cookie-changed')
      // storage 路单独给 reason：文案/日志里"cookie 变了"与"storage 出现了 token"是两件事，别混称
      if (kind === 'storage') return finish(true, 'storage-changed')
      const snap = await snapOnce()
      if (loginSucceeded(snap, url)) return finish(true, 'logged-in')

      // 外部信号串行排在轮询之后：轮询本身很轻，无需把它塞进 Promise.race 抢同一 tick
      const raced = await Promise.race([
        external.then((how) => ({ how })),
        sleep(pollMs).then(() => null),
      ])
      if (raced?.how === 'cancelled') return finish(false, 'cancelled', { error: '用户取消等待登录' })
      if (raced?.how === 'user-confirmed') return finish(true, 'user-confirmed')
    }
    return finish(false, 'timeout', { error: timeoutError(waitMs) })
  } finally {
    // 覆盖"登记之后的整段流程"（含 already-logged-in / open-failed / nav-failed 早退）：登记绝不泄漏
    releaseWait(waitKey, reg)
  }
}

/**
 * 读指纹；任何异常都返回 null（读不到 cookie 绝不等于未登录）。
 * ★ 优先用 getLoginFingerprint（cookie + storage 的合成指纹）；执行器没实现时回退 getCookieFingerprint
 *   ——后者是旧契约（既有假执行器/单测传的就是裸 cookie 指纹），必须继续被兼容。
 */
async function readFingerprint(deps, executor, key, url) {
  try {
    const f = deps.getCookieFingerprint || executor.getLoginFingerprint || executor.getCookieFingerprint
    if (typeof f !== 'function') return null
    const v = await f.call(executor, key, url)
    return typeof v === 'string' ? v : null
  } catch { return null }
}

/** 收尾文案（调用方在 waiting:false 事件里用；集中一处便于文案一致） */
function loginResultDetail(res) {
  if (res.ok) {
    if (res.reason === 'user-confirmed') return '已收到「我已完成登录」，正在带登录态重新获取页面…'
    // cookie 路与 storage 路（SPA 只写 localStorage/sessionStorage token）都是"已检测到登录成功"
    return '已检测到登录成功，正在带登录态重新获取页面…'
  }
  return res.reason === 'timeout'
    ? '等待登录超时：本次未在登录态下验证，命令可能缺少登录后才能看到的入口'
    : (res.error || '登录未完成：本次未在登录态下验证')
}

module.exports = {
  ensureLoggedIn, resolveLoginWait, cancelLoginWait, pendingCount, loginResultDetail,
  loginSucceeded, DEFAULT_WAIT_MS, POLL_MS,
}
