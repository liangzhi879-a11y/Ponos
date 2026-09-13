// 应用智控 IPC 注册（Task 1.5 / 1.7 / 2.1 / 2.3）
//
// 为什么单独成文件而不写进 main.cjs：main.cjs 已 1500+ 行，本模块有 11 条通道与
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
function registerAppHandlers({ ipcMain, getExecutor }) {
  const roots = () => [join(resolveYfwHome(), 'apps')]

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

  // ---- 执行（Task 2.1/2.2）：按 driver 分发 ----
  ipcMain.handle('app:run', async (_e, payload) => {
    const { appId, action, args = {}, sessionId } = payload || {}
    const spec = appRegistry.readSpec({ roots: roots(), appId })
    if (!spec) return { ok: false, data: null, error: `应用 Spec 不存在：${appId}`, kind: 'unknown', durationMs: 0 }

    const driver = inferDriver(spec)
    if (driver === 'browser') {
      const executor = getExecutor()
      if (!executor) return { ok: false, data: null, error: '浏览器执行器未就绪', kind: 'unknown', durationMs: 0 }
      return runCommand({ roots: roots(), appId, action, args, executor, sessionId })
    }

    // desktop：与 browser 路径同口径留痕（runCommand 内部负责 browser 的留痕）
    const res = await desktopRunner({ appId, action, args, spec: { ...spec, driver } })
    appendHistory({ roots: roots(), appId, entry: { appId, action, args, kind: res.kind, at: new Date().toISOString(), ok: res.ok, error: res.error, durationMs: res.durationMs } })
    return res
  })
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

module.exports = { registerAppHandlers, inferDriver, PROBE_SESSION }
