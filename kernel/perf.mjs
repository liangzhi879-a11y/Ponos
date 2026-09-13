// Ponos-turbo 内核性能埋点（2026-09-13 系统性优化 · K0 观测基线）
// ---------------------------------------------------------------------------
// 背景：内核 `kernel/` 此前 `performance.now()` / `[perf]` / `hrtime` **零命中**——
// 「每步 420–680ms 固定开销」只能靠外部探针（合成历史 + 计时脚本）估，无法在真实任务
// 里定位到"这一步到底付在哪"。K1 的每一项改动都要求前后有数据背书，故先落这一层。
//
// 形状（参考 pi-main packages/telemetry 的 NOOP_TELEMETRY_CONTEXT + 开关切换）：
// 关闭时是**零开销实现**——每次调用只付一次布尔判断，不调 `performance.now()`。
//
// 三条硬约束（各踩过一次坑）：
// 1) 开关**必须惰性读**：cli.mjs 的 settings.env 注入发生在所有 ESM 模块求值之后，
//    写成模块级常量必然读不到（同一个坑见 engine-adaptive-firstbyte.test.mjs 头注）。
// 2) **同键重入保护**：只对同一 key 的最外层调用累计，否则一次 88ms 会被记 5 遍。
//    注意**不能**用全局 depth：preStep（key='pre'，异步）内部就调用 est/req/tools，
//    全局 depth 会让这三个真正的头号指标全部漏记。
// 3) **默认必须关**：内核 stderr 经 server/bridge.mjs 会 ① console.error 转发 ② 写
//    <home>/logs/kernel-stderr.log ③ 作为 stderr 事件转发渲染器——每步一行有真实成本。
let on = null
const acc = new Map()          // key → [count, ms]
const active = new Set()       // 正在计时的 key（同键重入时由最外层记账）
let marks = Object.create(null)

export const perfOn = () => (on === null ? (on = process.env.PONOS_PERF === '1') : on)

const now = () => performance.now()
const slot = (key) => {
  let e = acc.get(key)
  if (!e) { e = [0, 0]; acc.set(key, e) }
  return e
}

/** 计数（与耗时无关的量：缓存命中、求值次数等） */
export function perfCount(key, n = 1) {
  if (!perfOn()) return
  slot(key)[0] += n
}

/** 记一次调用与耗时。嵌套调用不重复累计（见头注 2）。 */
export function perfAdd(key, ms) {
  if (!perfOn()) return
  const e = slot(key)
  e[0] += 1
  e[1] += Number.isFinite(ms) ? ms : 0
}

/** 同步段计时：关闭时直接执行（零额外开销） */
export function perfTime(key, fn) {
  if (!perfOn() || active.has(key)) return fn()
  active.add(key)
  const t = now()
  try {
    return fn()
  } finally {
    active.delete(key)
    perfAdd(key, now() - t)
  }
}

/** 异步段计时（preStep 等 await 段）；语义与 perfTime 一致（含同键重入保护） */
export async function perfTimeAsync(key, fn) {
  if (!perfOn() || active.has(key)) return fn()
  active.add(key)
  const t = now()
  try {
    return await fn()
  } finally {
    active.delete(key)
    perfAdd(key, now() - t)
  }
}

/** 打点（流式：首字节/首 chunk/生成结束等异步边界） */
export function perfMark(name) {
  if (!perfOn()) return
  marks[name] = now()
}

/** 从某个打点累计到现在。**取用即消费**（打点被删除）：ttfb/gen/tail 这类段互斥，
 *  若留着旧打点，走 `continue` 出口的迭代会把它当成"本步的结束时刻"算出虚高的段长。 */
export function perfSpan(key, from) {
  if (!perfOn() || !(from in marks)) return
  const ms = now() - marks[from]
  delete marks[from]
  const e = slot(key)
  e[0] = 1
  e[1] = ms
}

/** 每步开头清账（调用方在结算完之后调） */
export function perfReset() {
  if (!perfOn()) return
  acc.clear()
  marks = Object.create(null)
}

const pair = (key) => {
  const e = acc.get(key)
  return e ? `${e[0]}/${e[1].toFixed(1)}` : '0/0'
}
const ms1 = (key) => {
  const e = acc.get(key)
  return e ? e[1].toFixed(0) : '0'
}

/**
 * 单步汇总行（单行、定长字段名，便于 grep/awk）：
 *   [perf] turn=3 step=7 ms=6421 pre=24.1/1 req=6/3.9 est=4/341.2 tools=6/131.4 dynHit=0 ttfb=2840 gen=6120 tail=41.3
 * pre/req/est/tools = 「次数/毫秒」；ttfb/gen/tail = 毫秒；dynHit = 动态工具缓存命中次数。
 */
export function perfLine(turn, step) {
  if (!perfOn()) return ''
  const ms = 'step' in marks ? (now() - marks.step).toFixed(0) : '-'
  return `[perf] turn=${turn} step=${step} ms=${ms}` +
    ` pre=${pair('pre')} req=${pair('req')} est=${pair('est')} tools=${pair('tools')}` +
    ` dynHit=${acc.get('dynHit')?.[0] ?? 0} ttfb=${ms1('ttfb')} gen=${ms1('gen')} tail=${ms1('tail')}`
}

/** 开账不发（首迭代用：上一步还不存在） */
export function perfBegin() {
  if (!perfOn()) return
  perfReset()
  perfMark('step')
}

/** 结算上一步并开新账：发一行、清零、给新步打起点。 */
export function perfStep(turn, step) {
  if (!perfOn()) return
  try {
    const line = perfLine(turn, step)
    if (line) console.error(line)
  } catch { /* 埋点不得影响主流程 */ }
  perfReset()
  perfMark('step')
}
