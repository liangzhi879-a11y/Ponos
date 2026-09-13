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

  // ---- 生成（Task 3.1/3.2）：探测 → LLM 生成 → 结构校验 → read 试跑 ----
  // 注意：本通道**只返回结果、不落盘**。必须由用户在界面上确认后才写（计划 Task 3.2 硬要求）。
  ipcMain.handle('app:generate', async (_e, payload = {}) => {
    const { target, appId, sessionId, maxRounds } = payload
    const t0 = Date.now()
    const done = (extra) => ({ elapsedMs: Date.now() - t0, ...extra })
    if (!target || (target.type !== 'web' && target.type !== 'desktop')) {
      return done({ ok: false, error: `目标不合法：${JSON.stringify(target)}` })
    }

    // ① 探测（web 取真实页面快照；desktop 走三级降级链）
    emitProgress(appId, { phase: 'probe', detail: target.type === 'web' ? '正在打开目标页面并抓取快照…' : '正在探测目标程序（CLI / 脚本接口 / UI 自动化）…' })
    let driver = null
    let probeMaterial = null
    if (target.type === 'web') {
      const executor = getExecutor()
      if (!executor) return done({ ok: false, error: '浏览器执行器未就绪，无法探测页面' })
      try {
        const probed = await profiler.probeWeb({ url: target.url, executor, sessionId: sessionId || PROBE_SESSION })
        driver = 'browser'
        probeMaterial = { url: target.url, title: probed.title, snapshot: snapshotForPrompt(probed.snapshot) }
        emitProgress(appId, { phase: 'probe', detail: `快照已取得：${probed.snapshot?.page?.title || target.url}`, done: true })
      } catch (e) {
        const msg = String(e?.message || e)
        emitProgress(appId, { phase: 'error', detail: `页面探测失败：${msg}` })
        return done({ ok: false, error: `页面探测失败：${msg}` })
      }
    } else {
      const detected = await profiler.detectDriver({ target, probe: (p) => profiler.probeDesktop({ exePath: p?.exePath }) })
      driver = detected.driver
      probeMaterial = { target, driver, evidence: detected.evidence }
      emitProgress(appId, { phase: 'probe', detail: `探测完成：驱动 ${driver}`, done: true })
    }

    // ② 生成（≤3 轮，失败回喂修正）
    const gen = await generateSpec({
      target, probeMaterial, maxRounds,
      callLlm,
      onProgress: (p) => emitProgress(appId, p),
    })
    if (!gen.ok) {
      emitProgress(appId, { phase: 'error', detail: (gen.issues || []).join('；') || '生成失败' })
      return done({ ok: false, error: (gen.issues || []).join('；') || '生成失败', issues: gen.issues, rounds: gen.rounds, driver })
    }

    // ③ 试跑验证（只跑 read，最多 2 条；write 绝不试跑）
    const specWithDriver = { ...gen.spec, driver }
    const verify = await verifySpec({
      spec: specWithDriver, sessionId,
      runCommand: ({ action, args, sessionId: sid }) => (
        driver === 'browser'
          ? runCommand({ roots: roots(), appId, action, args, executor: getExecutor(), sessionId: sid, spec: specWithDriver, persist: false })
          : desktopRunner({ appId, action, args, spec: specWithDriver })
      ),
      onProgress: (p) => emitProgress(appId, p),
    })
    emitProgress(appId, {
      phase: 'done',
      detail: verify.ok
        ? `生成完成：${gen.spec.commands.length} 条命令，试跑 ${verify.tried.length} 条查询命令全部通过`
        : `生成完成：${gen.spec.commands.length} 条命令；试跑未通过：${verify.failures.map((f) => f.action).join('、')}`,
      issues: verify.failures.map((f) => `${f.action}：${f.error}`),
    })
    return done({ ok: true, spec: specWithDriver, driver, rounds: gen.rounds, issues: gen.issues, verify })
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
    return runCommand({ roots, appId, action, args, executor, sessionId })
  }

  // desktop：与 browser 路径同口径留痕（runCommand 内部负责 browser 的留痕）
  const res = await desktopRunner({ appId, action, args, spec: { ...spec, driver } })
  appendHistory({ roots, appId, entry: { appId, action, args, kind: res.kind, at: new Date().toISOString(), ok: res.ok, error: res.error, durationMs: res.durationMs } })
  return res
}

/** 探测快照裁剪：只留 title/url/文本摘要，避免把整棵可交互树灌进渲染层 */
function profiledSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return null
  return {
    url: snap.url ?? null,
    title: snap.title ?? null,
    text: typeof snap.text === 'string' ? snap.text.slice(0, 4000) : '',
    interactiveCount: Array.isArray(snap.interactives) ? snap.interactives.length : 0,
  }
}

module.exports = { registerAppHandlers, runAppCommand, handleAppExecMessage, inferDriver, appRoots, PROBE_SESSION, profiledSnapshot }
