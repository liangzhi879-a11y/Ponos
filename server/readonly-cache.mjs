// server/readonly-cache.mjs —— 只读聚合（/api/usage、/api/audit）的桥侧缓存（K2.2）
// ---------------------------------------------------------------------------
// 为什么是桥侧：内核是**每次请求新 spawn 的短命子进程**，它内部的任何缓存都活不过一次
// 请求；而桥是常驻的。故跨请求的复用只能落在桥这一侧。
//
// 形状继承 `server/log-policy.cjs:91-101` 的 TTL 缓存（Map + {at, value}），但多一条
// **stale-while-revalidate**：命中但已过期时**立即返回旧值**，同时在后台刷新。
// 理由：驾驶舱 5s 轮询、GUI 侧超时也正好 5s（src/lib/usageApi.ts），一旦"每次都要等新算"
// 就会持续撞超时 ⇒ 卡片常态无数据。返回一个 TTL 内的旧值远好于"没有值"——用量看板不是
// 计费凭证（用户决策：进取档，允许牺牲少量交互/诊断细节）。
//
// 冷启动（无缓存）不能把请求挂到天荒地老：真机一次全量聚合可达 10.8–19.6s。故只等
// `firstWaitMs`（默认 3000ms，**必须小于 GUI 的 5s 超时**，否则等到了也没人接），
// 超时即回 `computing`（调用方回 503）并把刷新留在后台跑完——下一次轮询就有值了。
// 这是**自愈**的：旧行为是每次都超时失败，新行为是最多多等一轮。
//
// 但**失败不能伪装成 computing**：冷启动失败（如内核路径找不到）必须把真实错误透出去
// （诊断不降级——否则 502 会变成含糊的"计算中"，用户永远查不出原因）。故单列
// `failed` 态并带上原始 message。
//
// 后台刷新 reject 一律不外抛：否则未处理的 rejection 会掀掉整个桥。
const DEFAULT_TTL_MS = 10_000
// 导出给测试锁死跨模块不变量：必须 < GUI 的 FETCH_TIMEOUT_MS（src/lib/usageApi.ts），
// 否则"等到了也没人接"——请求早已被 AbortController 掐断，白等一场。
export const DEFAULT_FIRST_WAIT_MS = 3000

/**
 * @param {object} opts
 * @param {number} opts.ttlMs        命中判定窗口（默认 10s = 轮询间隔的 2 倍 ⇒ 后台刷新频率减半）
 * @param {number} opts.firstWaitMs  冷启动最多等多久（默认 3s，须 < GUI 的 5s 超时）
 * @param {(e:Error|string)=>void} opts.onWarn 后台刷新失败上报（默认吞掉；桥侧注入日志）
 * @param {()=>number} opts.now      时钟（测试注入）
 */
export function createReadonlyCache({ ttlMs = DEFAULT_TTL_MS, firstWaitMs = DEFAULT_FIRST_WAIT_MS, onWarn = () => {}, now = () => Date.now() } = {}) {
  const entries = new Map() // key -> { at, payload }
  const errors = new Map() // key -> { at, error }：最近一次**刷新失败**（成功后清除）
  const refreshing = new Set() // key：正在后台刷新（避免同键重复起刷新）

  function refresh(key, fetchFn) {
    if (refreshing.has(key)) return
    refreshing.add(key)
    Promise.resolve()
      .then(() => fetchFn())
      .then((payload) => { entries.set(key, { at: now(), payload }); errors.delete(key) })
      .catch((e) => { errors.set(key, { at: now(), error: e }); onWarn(e) })
      .finally(() => { refreshing.delete(key) })
  }

  /**
   * @param {string} key     查询键（sub + 全部影响结果的 flags）
   * @param {() => Promise<string>} fetchFn  真正的取数（内部 spawn 内核）
   * @returns {Promise<{ state:'fresh'|'stale'|'computing'|'failed', payload:string|null, error?:Error }>}
   */
  async function get(key, fetchFn) {
    const hit = entries.get(key)
    if (hit && now() - hit.at < ttlMs) return { state: 'fresh', payload: hit.payload }
    if (hit) {
      refresh(key, fetchFn) // 后台更新，本次仍回旧值
      return { state: 'stale', payload: hit.payload }
    }
    // 冷启动：等一次，但不超过 firstWaitMs
    const startedAt = now()
    refresh(key, fetchFn)
    const payload = await waitFor(key, firstWaitMs)
    if (payload != null) return { state: 'fresh', payload }
    // 等不到：若是**本次等待期间**的刷新失败 → 透出真实错误（而不是含糊的"计算中"）
    const bad = errors.get(key)
    if (bad && bad.at >= startedAt) return { state: 'failed', payload: null, error: bad.error }
    return { state: 'computing', payload: null }
  }

  // 等到该键首次落值（或超时）。用轮询而非把 fetch 的 promise 传出来，是为了让
  // "等"与"刷新"彻底解耦：超时后刷新照跑，落值即被下一次 get 看到，且同键并发冷启动
  // 天然共享同一次刷新（无需再维护一张 in-flight Promise 表）。
  function waitFor(key, ms) {
    return new Promise((resolve) => {
      const deadline = now() + ms
      const tick = () => {
        const hit = entries.get(key)
        if (hit) return resolve(hit.payload) // 无缓存才会走到这里 ⇒ 任何命中都是本次新落的
        if (now() >= deadline) return resolve(null)
        setTimeout(tick, 25)
      }
      tick()
    })
  }

  return {
    get,
    /** 测试/诊断用：缓存与在飞集合快照 */
    stats() { return { size: entries.size, refreshing: refreshing.size, errors: errors.size } },
    reset() { entries.clear(); errors.clear(); refreshing.clear() },
  }
}
