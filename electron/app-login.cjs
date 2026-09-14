// 应用智控：**登录编排**（把"需要登录 → 用户手动登录 → LLM 拿到登录态"接成闭环）。
//
// ★ 用户决策（勿偏离）：
//   · 检测到就直接弹出登录窗口，检测到成功**自动继续**（不需要用户再点"生成"）；
//   · 等待上限 5 分钟，超时**仍继续生成**但明确警示"未在登录态下验证"；
//   · 只有高置信度登录墙才自动弹窗（判定在 app-login-wall.cjs）。
//
// ★ 三路成功信号（任一成立即算成功，理由：不同站点的登录写法差别很大）：
//   a) cookie 指纹变化   —— 登录必然写 cookie，是最通用的信号；
//   b) 快照已登录        —— logged_in=true，或已离开登录页且密码框消失；
//   c) 用户点「我已完成登录」—— 给"只写 localStorage、cookie 不变"的站点兜底。
//
// ★ 可注入：executor 与 deps.{now,sleep,getCookieFingerprint} 都可注入，
//   于是"自动成功/超时/取消/执行器缺失"全部能用假执行器单测（不启 Electron、不联网）。
//   ★ 顶层**不得** require Electron：executor 由调用方注入，本文件必须能被 node --test 直接加载。
'use strict'
// LOGIN_PATH_RE / loginSucceeded 的唯一出处是 app-login-page.cjs（零 Electron 依赖的纯函数），
// 这里只做编排与 re-export（测试从 app-login.cjs 导入 loginSucceeded，避免接口漂移）。
const { loginSucceeded, LOGIN_PATH_RE } = require('./app-login-page.cjs')

const DEFAULT_WAIT_MS = 5 * 60 * 1000
const POLL_MS = 1500

/** 等待注册表：key → { resolve }；供 app:login-done / app:login-cancel 通道命中 */
const pending = new Map()

function resolveLoginWait(key) {
  const p = pending.get(String(key))
  if (!p) return false
  p.resolve('user-confirmed')
  return true
}
function cancelLoginWait(key) {
  const p = pending.get(String(key))
  if (!p) return false
  p.resolve('cancelled')
  return true
}
function pendingCount() { return pending.size }

function done(ok, reason, t0, now, extra = {}) {
  return { ok, reason, elapsedMs: Math.max(0, now() - t0), ...extra }
}

/** 传入的 url 本身是不是登录页 */
function isLoginUrl(url) {
  try { return LOGIN_PATH_RE.test(new URL(String(url || '')).pathname) } catch { return false }
}

/**
 * 打开可见窗口等用户登录（同一分区 = 与命令执行/模型探索共用登录态）。
 *
 * ★ "先探一次快照"的边界（brief 自带测试 1 与测试 3 的唯一差异就在传进来的 url）：
 *   仅当**传入 url 不是登录页**时才采信"快照已登录 → already-logged-in"。
 *   理由：url 是登录页时上游（登录墙流程）已经判定需要登录，此刻快照上的 logged_in 标记
 *   在登录页上并不可信（不少站点在登录页也照样输出该字段），采信它会导致"明明要登录却直接跳过登录"。
 *   这条路径不会漏判：进了等待流程后第一轮快照判定立刻就会给出 logged_in=true → 返回 logged-in。
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

  // 先看一眼是不是本来就登录着（已登录就别弹窗打扰）
  const snapOnce = async () => {
    try { const r = await executor.exec(key, 'snapshot', {}); return r?.snapshot || null } catch { return null }
  }
  if (!isLoginUrl(url)) {
    const first = await snapOnce()
    if (loginSucceeded(first, url)) return finish(true, 'already-logged-in')
  }

  try { await executor.openWindow(key) } catch (e) {
    return finish(false, 'open-failed', { error: `打开登录窗口失败：${String(e?.message || e)}` })
  }
  const nav = await executor.exec(key, 'goto', { url })
  if (!nav?.ok) return finish(false, 'nav-failed', { error: `打开页面失败：${nav?.error || '未知错误'}` })

  emitLogin({ phase: 'login', waiting: true, key, url, detail: '需要登录：已在可见窗口中打开该站点，请在其中完成登录（检测到登录成功后会自动继续）…' })
  announced = true

  // 外部信号（用户在界面上点「我已完成登录」/「取消等待」）
  let resolveExternal = () => {}
  const external = new Promise((res) => { resolveExternal = res })
  pending.set(String(key), { resolve: resolveExternal })
  const baseline = await readFingerprint(deps, executor, key, url)
  try {
    const deadline = t0 + waitMs
    while (now() < deadline) {
      // 先看 cookie（登录必然写 cookie），再看快照；两者都无变化才继续等
      const fp = await readFingerprint(deps, executor, key, url)
      if (fp && fp !== 'empty' && fp !== baseline) return finish(true, 'cookie-changed')
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
    return finish(false, 'timeout', { error: `等待登录超时（${Math.round(waitMs / 60000)} 分钟）：本次未在登录态下验证` })
  } finally {
    pending.delete(String(key))
  }
}

/** 读指纹；任何异常都返回 null（读不到 cookie 绝不等于未登录） */
async function readFingerprint(deps, executor, key, url) {
  try {
    const f = deps.getCookieFingerprint || executor.getCookieFingerprint
    if (typeof f !== 'function') return null
    const v = await f.call(executor, key, url)
    return typeof v === 'string' ? v : null
  } catch { return null }
}

/** 收尾文案（调用方在 waiting:false 事件里用；集中一处便于文案一致） */
function loginResultDetail(res) {
  if (res.ok) {
    if (res.reason === 'user-confirmed') return '已收到「我已完成登录」，正在带登录态重新获取页面…'
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
