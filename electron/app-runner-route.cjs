// 应用智控：非浏览器驱动的**执行分发**（M3）。
//
// ★ 为什么必须有它（而不是让每个调用点自己 if/else）：同一条执行语义有三个消费方——
//   ① 渲染层 IPC（app:run）；② 内核桥（app:exec → handleAppExecMessage）；③ 生成期的真实试跑。
//   各自判 driver 就必然漂移（本项目已有"两套逻辑漂移"的事故教训），于是集中在这一处：
//   **按 driver 找执行器**，其余（校验参数、逐步执行、留痕）由各执行器与调用方各守其责。
//
// ★ 为什么 desktop 仍是 desktopRunner（不改它）：它内部对 driver 的严格白名单
//   （process/script/uia 之外一律回"不支持的 driver"）是既有测试锁定的行为；
//   新后端并行存在，不往它里面塞分支，避免一次改动同时影响两条老路径。
'use strict'
const { driverOf, normalizeDriver, DRIVERS } = require('./app-generate.cjs')
const { appendHistory } = require('./app-runner.cjs')
const { desktopRunner } = require('./app-runner-desktop.cjs')
const { httpRunner } = require('./app-runner-http.cjs')
const { fileRunner } = require('./app-runner-file.cjs')

/** driver → 执行器（唯一映射表） */
const RUNNERS = {
  process: desktopRunner,
  script: desktopRunner,
  uia: desktopRunner,
  http: httpRunner,
  file: fileRunner,
}

/**
 * 草稿/已交付 Spec 里**声明的** driver 是不是一个已知取值（含 web / desktop 两个历史别名）。
 * 空值不算"声明"（走 driverOf 按目标推定）。
 *
 * ★ 为什么需要它（与 driverOf 的分工）：`driverOf` 对**未知值**会按 target.type 兜底推定
 *   （如 'nope' → 'uia'），这对"校验/交付"是合理的宽容，但分发层不能跟着宽容——
 *   否则一个拼错的 driver 会被悄悄按 uia 跑出"未找到命令"这类**方向反了**的报错，
 *   调用方（与模型）永远看不到真正的原因。故分发层对"声明了却不认识的值"明确点名拒绝。
 */
function driverIsRecognized(spec) {
  const raw = typeof spec?.driver === 'string' ? spec.driver.trim() : ''
  if (!raw) return true
  return DRIVERS.includes(normalizeDriver(raw))
}

/**
 * 执行一条**非浏览器**驱动的命令。
 * @param {{appId:string, action:string, args?:object, spec:object, roots:any, exploreRoots?:Function, deps?:object, persist?:boolean}} p
 *   exploreRoots：`() => string[]`，file 驱动的允许根目录（由调用方从 target 推导，见 app-ipc.exploreRoots）。
 *   persist=false 用于生成期试跑（草稿还没落盘，不该留痕）。
 * @returns {Promise<{ok:boolean, data:any, error:string|null, kind:string, durationMs:number}>}
 */
async function runNonBrowser({ appId, action, args = {}, spec, roots, exploreRoots, deps = {}, persist = true } = {}) {
  const driver = driverOf(spec)
  const runner = driverIsRecognized(spec) ? RUNNERS[driver] : undefined
  if (!runner) {
    return { ok: false, data: null, error: `不支持的 driver：${String(spec?.driver ?? driver)}`, kind: 'unknown', durationMs: 0 }
  }
  // file 驱动只认"目标程序目录 + 其用户数据目录"：roots 由调用方（app-ipc）推导后传进来；
  // 其余驱动不需要它（undefined），避免把文件系统的允许范围误传给别的后端。
  const rootsForFile = driver === 'file' ? (typeof exploreRoots === 'function' ? exploreRoots() : []) : undefined
  const res = await runner({
    appId, action, args,
    spec: { ...spec, driver },
    roots: rootsForFile,
    deps,
  })
  // 留痕口径与既有 desktop 路径完全一致（任何执行，含失败，都留一行）
  if (persist) {
    appendHistory({
      roots, appId,
      entry: { appId, action, args, kind: res.kind, at: new Date().toISOString(), ok: res.ok, error: res.error, durationMs: res.durationMs },
    })
  }
  return res
}

module.exports = { runNonBrowser, RUNNERS }
