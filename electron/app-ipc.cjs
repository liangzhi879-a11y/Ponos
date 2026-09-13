// 应用智控 IPC 注册（Task 1.5 / 1.7 / 2.1 / 2.3）
//
// 为什么单独成文件而不写进 main.cjs：main.cjs 已 1500+ 行，本模块有 16 条通道与
// 目标分发逻辑；集中在一处才能一眼看全"渲染层能做什么"。main.cjs 只留一行调用。
//
// ★ 数据根唯一真源：server/yfw-home.cjs 的 resolveYfwHome()。它与内核侧
//   kernel/cli.mjs 的 resolveConfigDir 同源（YFWORKING_HOME → CLAUDE_CONFIG_DIR →
//   ~/.yfworking），故 UI 写的 Spec/绑定与内核读到的是**同一份文件**。
//   绝不在此另写一套 home 解析（本项目已有"两套逻辑漂移"的事故教训）。
'use strict'
const { join } = require('node:path')
const { resolveYfwHome } = require('../server/yfw-home.cjs')
const appRegistry = require('./app-registry.cjs')
const appBindings = require('./app-bindings.cjs')
const profiler = require('./app-profiler.cjs')
const { runCommand, appendHistory, desktopRunner } = require('./app-runner.cjs')
const { generateSpec, verifySpec, snapshotForPrompt, validateSpecBasic } = require('./app-generate.cjs')
const { callLlmStream } = require('./app-llm.cjs')
const appValidator = require('./app-validator.cjs')
const httpProbe = require('./app-http-probe.cjs')
// 浏览器自动化白名单（*.gov.cn / localhost / 127.0.0.1 + {YFW_HOME}/browser-whitelist.json）。
// 只用来决定"要不要用浏览器增强探测"；生成命令本身**不依赖**它（见 app-http-probe.cjs 头部说明）。
const { isWhitelisted } = require('./browser-common.cjs')

/** 探测专用浏览器会话：与用户会话隔开，避免探测把用户正在看的页面导航走 */
const PROBE_SESSION = 'app-probe'

/** Spec 里没写 driver 时的推定：web → browser，desktop → uia（最保守的兜底） */
function inferDriver(spec) {
  if (spec?.driver) return spec.driver
  return spec?.target?.type === 'web' ? 'browser' : 'uia'
}

/**
 * 注册 app:* 全部通道。
 * @param {{ ipcMain: Electron.IpcMain, getExecutor: () => object|null }} deps
 *   getExecutor 用**取值函数**而非实例：browserExecutor 在 connectBrowserExecutor 之后才
 *   存在，注册时可能还是 null（既有 browser:* 通道同款处理）。
 */
function registerAppHandlers({ ipcMain, getExecutor, getWebContents, deps = {} }) {
  // deps.callLlm：测试注入点（假 LLM）——生成链路要能脱离真实网络被端到端验证
  const callLlm = deps.callLlm || callLlmStream
  // deps.fetchImpl：同上，注入点——后台取页面素材的测试不应真打外网
  const fetchImpl = deps.fetchImpl
  const roots = appRoots

  /**
   * 生成进度事件（如实反映真实阶段）：
   * 阶段全部由真实代码路径触发，字符数来自真实流式累计，耗时来自真实计时——
   * 界面据此渲染"正在做什么"，不做假进度条（没有百分比，只有阶段与真实计数）。
   */
  const emitProgress = (appId, p) => {
    try {
      const wc = typeof getWebContents === 'function' ? getWebContents() : null
      wc?.send?.('app:generate-progress', { appId: appId || null, at: Date.now(), ...p })
    } catch {
      // 窗口已关闭/未就绪：进度只用于展示，绝不能因此中断生成
    }
  }

  // ---- 注册表 CRUD ----
  ipcMain.handle('app:list', () => appRegistry.listApps({ roots: roots() }))
  ipcMain.handle('app:upsert', (_e, app) => appRegistry.upsertApp({ roots: roots(), app }))
  ipcMain.handle('app:remove', (_e, appId) => {
    appRegistry.removeApp({ roots: roots(), appId })
    return { ok: true }
  })
  ipcMain.handle('app:read-spec', (_e, appId) => appRegistry.readSpec({ roots: roots(), appId }))
  ipcMain.handle('app:write-spec', (_e, payload) => {
    const { appId, spec } = payload || {}
    const path = appRegistry.writeSpec({ roots: roots(), appId, spec })
    return { ok: true, path }
  })

  // ---- Spec 备份与回滚（Task 3.3） ----
  ipcMain.handle('app:list-backups', (_e, appId) => appRegistry.listBackups({ roots: roots(), appId }))
  ipcMain.handle('app:restore-spec', (_e, payload) => {
    const { appId, backupName } = payload || {}
    try {
      const spec = appRegistry.restoreSpec({ roots: roots(), appId, backupName })
      return { ok: true, spec }
    } catch (e) {
      // 备份名不合法 / 备份损坏都要给出人话原因，不能静默失败
      return { ok: false, error: String(e?.message || e) }
    }
  })
  /**
   * 对「手里的 spec」做结构校验（保存前拦截非法内容）。
   * 说明：内核 kernel/app-spec.mjs 的 validateSpec 是 Spec 结构的定义真源，但它当前**没有调用点**
   * （cli.mjs 挂载工具时不校验；且打包产物不含 kernel/ 源码，主进程 require 不到），
   * 故「Spec 是否合法」实际由本地实现 validateSpecBasic 把关。
   * allowPublic 只在用户于界面上显式选择「全局可用」时为 true。
   */
  ipcMain.handle('app:check-spec', (_e, payload) => (
    // allowPublic 由界面在用户显式选择「全局可用」时传入；不传即按默认拒绝 public
    validateSpecBasic(payload?.spec, { allowPublic: payload?.allowPublic === true })
  ))

  // ---- 漂移修复（Task 3.4）：只修失败命令、先备份、必回报 ----
  ipcMain.handle('app:repair', async (_e, payload) => {
    const { appId, maxRepair } = payload || {}
    return appValidator.repairApp({ roots: roots(), appId, maxRepair, deps: { callLlm } })
  })

  // ---- 控制台绑定（严格单开） ----
  ipcMain.handle('app:console-enter', (_e, payload) => {
    const { sessionId, appId } = payload || {}
    return appBindings.bindApp({ roots: roots(), sessionId, appId })
  })
  ipcMain.handle('app:console-leave', (_e, payload) => {
    const { sessionId, appId } = payload || {}
    return { ok: appBindings.unbindApp({ roots: roots(), sessionId, appId }) }
  })
  ipcMain.handle('app:console-bound', (_e, sessionId) => appBindings.getBoundApp({ roots: roots(), sessionId }))

  // ---- 探测（Task 1.7/1.8）：判定 driver + 真实可达性 ----
  ipcMain.handle('app:probe', async (_e, payload) => {
    const { target, sessionId } = payload || {}
    let detected
    try {
      detected = await profiler.detectDriver({
        target,
        probe: (p) => profiler.probeDesktop({ exePath: p?.exePath }),
      })
    } catch (e) {
      return { ok: false, driver: null, evidence: null, reachable: false, error: String(e?.message || e) }
    }
    if (detected.driver === 'browser') {
      const executor = getExecutor()
      if (!executor) return { ok: true, ...detected, reachable: false, error: '浏览器执行器未就绪' }
      // 用户点「探测」时填的网址 = 显式授权（原先这里会直接报"目标域名不在白名单"，真实反馈即出于此）
      authorizeAppTarget(target)
      try {
        const probed = await profiler.probeWeb({ url: target?.url, executor, sessionId: sessionId || PROBE_SESSION })
        return { ok: true, ...detected, reachable: true, title: probed.title, snapshot: profiledSnapshot(probed.snapshot) }
      } catch (e) {
        return { ok: true, ...detected, reachable: false, error: String(e?.message || e) }
      }
    }
    return { ok: true, ...detected, reachable: detected.driver !== 'uia' }
  })

  // ---- 自检（Task 2.3 占位语义 → 真实"本地可判定"检查；结构校验仍归内核 validateSpec） ----
  ipcMain.handle('app:check', async (_e, appId) => {
    const spec = appRegistry.readSpec({ roots: roots(), appId })
    return profiler.checkApp({ spec })
  })

  // ---- 生成（Task 3.1/3.2）：取素材 → LLM 生成 → 结构校验 → read 试跑 ----
  // 注意：本通道**只返回结果、不落盘**。必须由用户在界面上确认后才写（计划 Task 3.2 硬要求）。
  ipcMain.handle('app:generate', async (_e, payload = {}) => {
    const { target, appId, sessionId, maxRounds } = payload
    const t0 = Date.now()
    const done = (extra) => ({ elapsedMs: Date.now() - t0, ...extra })
    if (!target || (target.type !== 'web' && target.type !== 'desktop')) {
      return done({ ok: false, error: `目标不合法：${JSON.stringify(target)}` })
    }

    // ① 取素材（**用户无感优先**）：后台 HTTP 抓取，不开窗口、不受浏览器白名单约束。
    //    真实反馈驱动的改动：原先必须先探测成功才生成，而探测走 BrowserExecutor 受自动化白名单
    //    保护（默认 *.gov.cn/localhost），给 kimi.com 这类站点生成命令会直接死在"目标域名不在白名单"。
    //    白名单保护的是 agent 自动操作浏览器；而"把用户自己填的网址取回一份素材给模型看"是用户
    //    已授权的动作，不该被它拦住。浏览器探测退化为白名单站点的增强手段（能拿到 JS 渲染后的 DOM）。
    let driver = null
    let probeMaterial = null
    let probeMode = 'none'
    let probeNote = ''
    let probeTitle = null
    if (target.type === 'web') {
      driver = 'browser'
      // 顺序要紧：**先**判定"是不是白名单站点"（决定要不要浏览器增强），**再**做显式授权。
      // 反过来的话 authorize 会让 isWhitelisted 恒真 → 每个站点都去开浏览器，违背"用户无感"。
      const whitelisted = isWhitelisted(target.url)
      // 用户在界面上填的网址 = 显式授权（供后续试跑/执行通过；agent 自主浏览仍受原白名单约束）
      authorizeAppTarget(target)
      emitProgress(appId, { phase: 'fetch', detail: '正在后台获取页面内容（无需浏览器）…' })
      const fetched = await httpProbe.fetchPageMaterial({ url: target.url, fetchImpl })
      if (fetched.ok && httpProbe.isMaterialRich(fetched.material)) {
        probeMode = 'http'
        probeMaterial = fetched.material
        probeTitle = fetched.material.title || null
        emitProgress(appId, { phase: 'fetch', done: true, detail: `已取得页面素材：${fetched.material.title || fetched.finalUrl}（${fetched.material.interactives} 个可交互线索）` })
      } else if (whitelisted && getExecutor()) {
        // 静态抓取不够用（JS 渲染/素材贫瘠）且该域名在白名单内 → 用浏览器补一次真实 DOM 快照
        const why = fetched.ok ? '静态素材偏少，改用浏览器取真实 DOM' : fetched.error
        emitProgress(appId, { phase: 'probe', detail: `${why}；该域名在白名单内，改用浏览器取真实页面…` })
        try {
          const probed = await profiler.probeWeb({ url: target.url, executor: getExecutor(), sessionId: sessionId || PROBE_SESSION })
          probeMode = 'browser'
          probeMaterial = { url: target.url, title: probed.title, snapshot: snapshotForPrompt(probed.snapshot) }
          probeTitle = probed.title
          emitProgress(appId, { phase: 'probe', done: true, detail: `快照已取得：${probed.snapshot?.page?.title || target.url}` })
        } catch (e) {
          // 浏览器也失败 → 用静态素材/无素材继续，绝不中断生成
          probeNote = String(e?.message || e)
          if (fetched.ok) { probeMode = 'http-thin'; probeMaterial = fetched.material; probeTitle = fetched.material.title || null }
          emitProgress(appId, { phase: 'probe', done: true, detail: `浏览器探测未成功（${probeNote}），继续用静态素材生成` })
        }
      } else if (fetched.ok) {
        probeMode = 'http-thin'
        probeMaterial = fetched.material
        probeTitle = fetched.material.title || null
        emitProgress(appId, { phase: 'fetch', done: true, detail: `${fetched.spa ? '页面疑似前端渲染的空壳' : '页面素材偏少'}，将结合模型常识生成，命令需人工核对` })
      } else {
        probeMode = 'none'
        probeNote = fetched.error || '未取得页面素材'
        emitProgress(appId, { phase: 'fetch', done: true, detail: `${probeNote}；将基于模型对该站点的公开了解生成，命令需人工核对` })
      }
    } else {
      const detected = await profiler.detectDriver({ target, probe: (p) => profiler.probeDesktop({ exePath: p?.exePath }) })
      driver = detected.driver
      probeMode = 'browser'   // desktop 侧的"素材"是探测证据，口径沿用既有 browser 分支
      probeMaterial = { target, driver, evidence: detected.evidence }
      emitProgress(appId, { phase: 'probe', detail: `探测完成：驱动 ${driver}`, done: true })
    }

    // ② 生成（≤3 轮，失败回喂修正）
    const gen = await generateSpec({
      target, probeMaterial, probeMode, maxRounds,
      callLlm,
      onProgress: (p) => emitProgress(appId, p),
    })
    if (!gen.ok) {
      emitProgress(appId, { phase: 'error', detail: (gen.issues || []).join('；') || '生成失败' })
      return done({ ok: false, error: (gen.issues || []).join('；') || '生成失败', issues: gen.issues, rounds: gen.rounds, driver })
    }

    // ③ 试跑验证（只跑 read，最多 2 条；write 绝不试跑）
    let specWithDriver = { ...gen.spec, driver }
    const runForVerify = (spec) => ({ action, args, sessionId: sid }) => (
      driver === 'browser'
        ? runCommand({ roots: roots(), appId, action, args, executor: getExecutor(), sessionId: sid, spec, persist: false })
        : desktopRunner({ appId, action, args, spec })
    )
    const verifyOnce = (spec) => verifySpec({
      spec, sessionId,
      runCommand: runForVerify(spec),
      onProgress: (p) => emitProgress(appId, p),
    })
    let verify = await verifyOnce(specWithDriver)
    let genRounds = gen.rounds
    let corrected = false

    // ③′ 试跑未通过 → **回喂失败原因让模型自我修正一次**，再试跑。
    // 为什么必须有这一步：结构校验只能查"字段写没写对"，而"选择器/ref 在真实页面上点不点得动"
    // 只有试跑才知道（用户实测就是这么卡住的：生成的命令结构合法、一跑就报错）。
    // 只修正一次，且只在"失败数变少或全通过"时才采纳，避免反复烧模型还不一定更好。
    if (!verify.ok) {
      const failed = verify.failures.map((f) => `命令 ${f.action} 试跑失败：${f.error}`)
      emitProgress(appId, {
        phase: 'round',
        detail: `试跑未通过：${verify.failures.map((f) => `${f.action}（${String(f.error).slice(0, 120)}）`).join('；')}；把失败原因回喂模型让它修正…`,
      })
      const retry = await generateSpec({
        target, probeMaterial, probeMode, maxRounds: 1, seedErrors: failed, callLlm,
        onProgress: (p) => emitProgress(appId, p),
      })
      genRounds += retry.rounds || 0
      if (retry.ok) {
        const retrySpec = { ...retry.spec, driver }
        const v2 = await verifyOnce(retrySpec)
        if (v2.ok || v2.failures.length < verify.failures.length) {
          specWithDriver = retrySpec
          verify = v2
          corrected = true
        }
      }
      emitProgress(appId, {
        phase: 'round',
        detail: corrected
          ? (verify.ok ? '修正后试跑全部通过' : `修正后仍有 ${verify.failures.length} 条未通过`)
          : '模型修正未带来改善，保留原结果',
      })
    }

    // probeMode 如实回传：界面据此提示"命令未经验证、需人工核对"（不假装探测过）
    const probeInfo = { mode: probeMode, title: probeTitle, url: target.type === 'web' ? target.url : null, note: probeNote || null }
    emitProgress(appId, {
      phase: 'done',
      detail: verify.ok
        ? `生成完成：${specWithDriver.commands.length} 条命令，试跑 ${verify.tried.length} 条查询命令全部通过${corrected ? '（经一次修正）' : ''}`
        : `生成完成：${specWithDriver.commands.length} 条命令；试跑未通过：${verify.failures.map((f) => f.action).join('、')}`,
      issues: verify.failures.map((f) => `${f.action}：${f.error}`),
    })
    return done({ ok: true, spec: specWithDriver, driver, probe: probeInfo, rounds: genRounds, issues: gen.issues, verify, corrected })
  })

  // ---- 执行（Task 2.1/2.2）：按 driver 分发 ----
  // 实现体在下方 runAppCommand（模块级函数）：同一条执行路径有**两个**消费方——
  //   ① 渲染层 IPC（app:run，本通道）；
  //   ② 内核桥（Task 4.x「应用即工具」）：内核 bridge_request(route=app) →
  //      bridge 转 executor/主进程 → 本文件同一函数 → app:exec:response 回写内核。
  // 抽成模块级函数的唯一目的是让两侧执行语义/留痕**逐字节一致**（两套实现必漂移）。
  ipcMain.handle('app:run', (_e, payload) => runAppCommand({ ...(payload || {}), roots: roots(), getExecutor }))
}

/**
 * 主进程 executor WS 的 app 请求处理（**唯一实现**：main.cjs 的 app:exec 分支只调它）。
 * 抽出来的理由与 runAppCommand 相同：让「内核桥这条执行路径」的回执形状与失败路径
 * 可被单测断言（main.cjs 依赖 Electron，无法在 node --test 里加载）。
 * @param {{requestId:string, payload:object}} msg  executor 收到的 app:exec 消息
 * @param {{getExecutor:Function, send:Function}} deps send(obj) 由主进程负责写回 WS
 * @returns {Promise<void>}
 */
function handleAppExecMessage(msg, { getExecutor, send }) {
  const requestId = msg?.requestId
  return Promise.resolve()
    .then(() => runAppCommand({ ...(msg?.payload || {}), getExecutor }))
    .then((res) => { try { send({ type: 'app:exec:response', requestId, ...res }) } catch { /* WS 已断：回执丢失不影响内核超时兜底 */ } })
    .catch((err) => {
      // 执行体自身抛异常（Spec 读写/留痕异常等）也要有结构化回执，否则内核只能等超时
      try { send({ type: 'app:exec:response', requestId, ok: false, data: null, error: String(err?.message || err), kind: 'unknown', durationMs: 0 }) } catch { /* WS 已断 */ }
    })
}

/** 应用数据根唯一真源（与内核侧 cli.mjs 的 <configDir>/apps 同源） */
function appRoots() { return [join(resolveYfwHome(), 'apps')] }

/**
 * 执行一条应用命令（唯一实现：渲染层 IPC 与内核桥共用）。
 * 行为约定见 electron/app-runner.cjs 头部（read 直执行 / write 由内核侧审批 /
 * 任何执行含失败都写 history）。
 * @returns {Promise<{ok:boolean, data:any, error:string|null, kind:string, durationMs:number}>}
 */
async function runAppCommand({ appId, action, args = {}, sessionId, getExecutor, roots = appRoots() } = {}) {
  const spec = appRegistry.readSpec({ roots, appId })
  if (!spec) return { ok: false, data: null, error: `应用 Spec 不存在：${appId}`, kind: 'unknown', durationMs: 0 }

  const driver = inferDriver(spec)
  if (driver === 'browser') {
    const executor = typeof getExecutor === 'function' ? getExecutor() : null
    if (!executor) return { ok: false, data: null, error: '浏览器执行器未就绪', kind: 'unknown', durationMs: 0 }
    // 用户保存过的应用目标 = 显式授权（否则非白名单站点的命令执行/AI 调用会被直接拦下）
    authorizeAppTarget(spec.target)
    return runCommand({ roots, appId, action, args, executor, sessionId })
  }

  // desktop：与 browser 路径同口径留痕（runCommand 内部负责 browser 的留痕）
  const res = await desktopRunner({ appId, action, args, spec: { ...spec, driver } })
  appendHistory({ roots, appId, entry: { appId, action, args, kind: res.kind, at: new Date().toISOString(), ok: res.ok, error: res.error, durationMs: res.durationMs } })
  return res
}

/**
 * 显式授权应用目标域名（运行时白名单，进程内有效、**不落盘**）。
 *
 * 为什么可以这么做：BrowserExecutor 的导航白名单保护的是「agent 自主浏览」——它能点按钮、
 * 填表单、发请求，必须收紧（默认 *.gov.cn/localhost/搜索引擎/企业查询/邮箱）。
 * 而这里的域名来自**用户自己在界面上输入或保存过的**应用目标，属于用户显式授权，
 * 等价于用户在浏览器里亲手打开该网址。
 *
 * 真机验收（2026-09-13，kimi.com）证明不这么做功能等于不可用：
 *   生成走的是后台 HTTP（已不受白名单约束），但生成后的**试跑**与**执行**（含 AI 工具调用）
 *   都会经 BrowserExecutor → 白名单拦下，全部报「目标域名不在白名单…已拒绝导航」，
 *   于是"生成命令 + AI 可调用"这条价值链在非白名单站点上依旧是断的。
 *
 * 边界：只授权目标 URL 的**精确主机名**（不扩散到子域、不扩散到同站其它域），
 * 不改全局默认白名单、不写任何配置文件；agent 自主浏览仍走原白名单。
 * @returns {string|null} 被授权的主机名（无法解析则为 null）
 */
function authorizeAppTarget(target) {
  if (!target || target.type !== 'web') return null
  try {
    const host = new URL(String(target.url || '')).hostname.toLowerCase()
    if (!host) return null
    isWhitelisted.allow(host)
    return host
  } catch { return null }
}

/** 探测快照裁剪：只留 title/url/文本摘要，避免把整棵可交互树灌进渲染层 */
function profiledSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return null
  // 页级字段在 page 下（browser-common.cjs 的 buildSnapshot）；扁平字段仅作兼容兜底
  const page = snap.page || {}
  return {
    url: page.url ?? snap.url ?? null,
    title: page.title ?? snap.title ?? null,
    text: typeof snap.text === 'string' ? snap.text.slice(0, 4000) : '',
    interactiveCount: Array.isArray(snap.interactives) ? snap.interactives.length : 0,
  }
}

module.exports = { registerAppHandlers, runAppCommand, handleAppExecMessage, inferDriver, appRoots, PROBE_SESSION, profiledSnapshot, authorizeAppTarget }
