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
const appAgent = require('./app-agent.cjs')
const { callLlmStream } = require('./app-llm.cjs')
const appValidator = require('./app-validator.cjs')
const httpProbe = require('./app-http-probe.cjs')
const { normalizeUrl, snapshotToText } = require('./app-util.cjs')
// 分区键唯一出处（web 按站点 app-site-<host>、desktop 按 app-<appId>）——绝不在此手写 persist:automation-*
const { appSessionKey } = require('./app-session-key.cjs')
// 登录墙分级（只有 high 才自动弹窗）与登录编排（开窗等待 → 三路成功信号 → 超时如实降级）
const { detectLoginWall, HIGH_ONLY } = require('./app-login-wall.cjs')
const appLogin = require('./app-login.cjs')
// 浏览器自动化白名单（*.gov.cn / localhost / 127.0.0.1 + {YFW_HOME}/browser-whitelist.json）。
// 只用来决定"要不要用浏览器增强探测"；生成命令本身**不依赖**它（见 app-http-probe.cjs 头部说明）。
const { isWhitelisted } = require('./browser-common.cjs')

/**
 * 生成时最多抓取多少页面。用户明确表示可以慢，但要求"尽可能充分获取所有能控制的接口信息"，
 * 所以宁可多抓几页（含列表/搜索/设置等）给模型，也不要只凭一个首页就写命令。
 */
const MAX_HARVEST_PAGES = 6
/**
 * 等待用户登录的上限（5 分钟，与 app-login.cjs 的 DEFAULT_WAIT_MS 同源）。
 * 超时**不中断生成**：照常产出 Spec，但如实标注"未在登录态下验证"（用户的明确取舍）。
 * 单测可用 deps.loginWaitMs / deps.loginPollMs 把它压到毫秒级。
 */
const LOGIN_WAIT_MS = 5 * 60 * 1000
/**
 * ensureLoggedIn 的"早退"原因集合：这些路径下它**没有**向界面宣布过等待，因此不会发收尾事件
 * （open-failed / nav-failed / no-executor 会直接返回；already-logged-in 是对端预判，也没开过等待）。
 * Task 6 在这些路径上要自己补一条 waiting:false，否则界面会停在"等待登录中"；其余路径由它自己发，
 * Task 6 **不得**重复发（同一事件发两遍会让收尾/日志重复计数）。
 */
const LOGIN_EARLY_REASONS = Object.freeze(['no-executor', 'already-logged-in', 'open-failed', 'nav-failed'])
/**
 * 自主探索预算。用户明确"不要期望 llm 分析生成很快完成"，所以给得宽松，但**必须有界**
 * （无上限会烧钱、界面看起来像卡死）。
 */
const AGENT_BUDGET = { maxTurns: 24, maxToolCalls: 20, timeBudgetMs: 10 * 60 * 1000, historyChars: 60000, perToolChars: 5000 }
/** 单次 fetch_page 回给模型的素材字符上限（它自己读 JSON，给小了看不到表单字段） */
const AGENT_TOOL_MATERIAL_CAP = 6000

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

  /**
   * 本次生成/执行的**分区键**（web 按站点、desktop 按 appId）——唯一出处 app-session-key.cjs。
   * ★ 绝不手写 `persist:automation-*` 或拼 `app-` 字样：partitionFor 不清洗键，写错会**静默**落到
   *   另一个分区 → Cookie 读空 → 上层把"已登录"误判成"未登录"（用户视角是"我明明登录了还要我登录"）。
   */
  const keyFor = (appId, target) => appSessionKey({ appId, target })

  /** 主机名（小写）；非法输入返回 null（调用点常在错误路径上，绝不抛） */
  const hostOfUrl = (u) => { try { return new URL(String(u)).hostname.toLowerCase() } catch { return null } }

  /**
   * Cookie 注入器：**只给本次流程已授权的站点**（authorizeAppTarget 授权过的 host）。
   * ★ 它是登录态外发的**唯一闸门**：抓取层（app-http-probe.cjs）只在**重定向**时校验 isAllowedHost，
   *   首跳 URL 不校验——所以"该不该给这个 URL 带 Cookie"必须由这里按 host 自己判定，
   *   未授权 host 一律返回 null（跨站跳转因此既不带 Cookie 也不会被继续跟随）。
   * ★ 读 Cookie 失败（分区不存在/electron 不可用/执行器未就绪）一律返回 null：读不到 ≠ 未登录。
   */
  const cookieProviderFor = (executor, key, authorizedHosts) => async (u) => {
    const host = hostOfUrl(u)
    if (!host || !authorizedHosts.has(host)) return null
    if (typeof executor?.getCookieHeader !== 'function') return null
    try {
      // 必须按 URL 取：分区里的 Cookie 可能属于多个域名，按 URL 过滤才不会把别站 Cookie 拼进请求头
      return await executor.getCookieHeader(key, u)
    } catch { return null }
  }

  // 登录等待上限/轮询间隔：默认取 app-login.cjs 的默认值；deps 注入点供单测把超时压到毫秒级
  const loginWaitMs = Number.isFinite(deps.loginWaitMs) ? deps.loginWaitMs : LOGIN_WAIT_MS
  const loginPollMs = Number.isFinite(deps.loginPollMs) ? deps.loginPollMs : appLogin.POLL_MS

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
    const { target, appId } = payload || {}
    // 会话 = 站点级键（唯一出处 app-session-key.cjs）：探测/生成/登录/执行必须落**同一分区**，
    // 否则用户刚登录过、探测却看不到（渲染层仍会传 chat sessionId，这里一律忽略）
    const key = keyFor(appId, target)
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
        const probed = await profiler.probeWeb({ url: target?.url, executor, sessionId: key })
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
    const res = await profiler.checkApp({ spec })
    // ★ 登录态结论**只在 IPC 层叠加**（app-profiler 保持纯 node：它不该 require Electron/执行器）。
    //   "生成时检测到过登录墙"（spec.auth.needsLogin）+ 当前分区读不到 Cookie = 现在多半没登录态，
    //   如实报 drifted 并给出下一步（而不是让用户进控制台后才在 AI 调用上撞登录墙）。
    if (spec?.target?.type === 'web' && spec?.auth?.needsLogin) {
      const executor = getExecutor()
      const key = keyFor(appId, spec.target)
      let fp = 'empty'
      try {
        // getCookieFingerprint 读不到时返回 'empty'；异常（执行器未就绪/electron 不可用）同样按 'empty' 处理
        fp = (await executor?.getCookieFingerprint?.(key, spec.target?.url)) || 'empty'
      } catch { fp = 'empty' }
      if (fp === 'empty') {
        res.issues = [...(res.issues || []), '该应用需要登录，当前未检测到登录态（AI 调用会被登录墙挡住）；可点「登录此应用」']
        if (res.status === 'healthy') res.status = 'drifted'
      }
    }
    return res
  })

  // ---- 生成（Task 3.1/3.2）：取素材 → LLM 生成 → 结构校验 → read 试跑 ----
  // 注意：本通道**只返回结果、不落盘**。必须由用户在界面上确认后才写（计划 Task 3.2 硬要求）。
  ipcMain.handle('app:generate', async (_e, payload = {}) => {
    // target 用 let：web 目标会先做网址归一（kimi.com → https://kimi.com/）再往下走
    let { target } = payload
    // sessionId（chat 会话）**刻意不解构**：登录态按站点/应用复用，跨会话共享（见 app-session-key.cjs）
    const { appId, maxRounds } = payload
    const t0 = Date.now()
    const done = (extra) => ({ elapsedMs: Date.now() - t0, ...extra })
    if (!target || (target.type !== 'web' && target.type !== 'desktop')) {
      return done({ ok: false, error: `目标不合法：${JSON.stringify(target)}` })
    }
    // 登录墙结论（web 分支填；仅 needed 时写进 Spec 的可选字段 auth）与登录编排结果（如实回传渲染层）
    let loginWall = null
    let loginInfo = null
    // 本次流程的分区键（唯一出处 app-session-key.cjs）：生成、探索、试跑、执行、登录必须**同一个键**，
    // 否则用户登录过也拿不到登录态（键写错会静默落到别的分区）。web 目标须在**网址归一之后**算键。
    let key = null
    // 登录态外发的授权集合（web 分支填）：Cookie 只发给这些 host；模型探索时也不会扩大它
    let authorizedHosts = new Set()
    let cookieProvider = null

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
      // ①′ 网址归一：用户常填不带协议头的写法（kimi.com）。不补全的话，取素材与授权都会
      //    因 new URL() 抛错而**静默降级**（素材空 + 域名未授权）→ 用户看到"生成了但完全没效果"。
      //    归一结果如实告知，用户才知道系统实际访问的是哪个地址。
      const webUrl = normalizeUrl(target.url) || target.url
      if (webUrl !== target.url) {
        target = { ...target, url: webUrl }
        emitProgress(appId, { phase: 'fetch', detail: `网址已补全为 ${webUrl}（原输入 ${String(payload?.target?.url)}）` })
      }
      // 顺序要紧：**先**判定"是不是白名单站点"（决定要不要浏览器增强），**再**做显式授权。
      // 反过来的话 authorize 会让 isWhitelisted 恒真 → 每个站点都去开浏览器，违背"用户无感"。
      const whitelisted = isWhitelisted(webUrl)
      // 本次流程的分区键（唯一出处 app-session-key.cjs）：生成、探索、试跑、执行、登录必须**同一个键**，
      // 否则用户登录过却拿不到登录态（键写错会静默落到别的分区）。
      key = keyFor(appId, target)
      // 用户在界面上填的网址 = 显式授权（供后续试跑/执行通过；agent 自主浏览仍受原白名单约束）。
      // 返回值即本次流程的授权 host 集合：它同时用于"Cookie 只发给授权站点"与"跨站跳转是否跟随"。
      authorizedHosts = new Set(authorizeAppTarget(target, { extraUrls: [webUrl] }))
      const executor = getExecutor()
      cookieProvider = cookieProviderFor(executor, key, authorizedHosts)
      // ★ 抓取层对**跨 host 跳转一律失败**（含 apex→www、http→https 的同站跳转），所以每个调用点都必须
      //   显式给出本次流程的授权集合，否则真实站点的常规跳转会让素材抓取整体失败（比不带 Cookie 更糟）。
      const isAllowedHost = (u) => authorizedHosts.has(hostOfUrl(u))
      const harvest = (provider) => httpProbe.harvestSite({
        url: webUrl, fetchImpl, maxPages: MAX_HARVEST_PAGES,
        cookieProvider: provider,
        isAllowedHost,
      })
      emitProgress(appId, { phase: 'fetch', detail: '正在后台获取页面内容（无需浏览器）…' })
      // **尽可能摸全**：首页 + 若干同源主要页面（列表/搜索/设置/详情…），让模型看到站点
      // 真正可控的入口，而不是只凭一个首页瞎猜（用户要求：宁可慢，也要把接口信息取充分）
      let harvested = await harvest(cookieProvider)
      // 跳转落点也要授权：网站常在 apex↔www 之间跳转（kimi.com → www.kimi.com），
      // 而白名单是精确主机名匹配——不追加授权的话，模型照素材里跳转后的真实地址写出的命令
      // 会在试跑阶段被拦（真机第二轮就是这个现象）。授权集合同步扩大（供后续抓取判定）。
      const authorizeLanding = (h) => {
        if (!h?.finalUrl) return
        for (const host of authorizeAppTarget(target, { extraUrls: [h.finalUrl] })) authorizedHosts.add(host)
        if (h.finalUrl !== webUrl) {
          emitProgress(appId, { phase: 'fetch', detail: `页面跳转到 ${h.finalUrl}，已一并授权其域名` })
        }
      }
      const reportHarvest = (h) => {
        if (!h.ok) return
        const sit = h.material?.site || {}
        emitProgress(appId, {
          phase: 'fetch',
          detail: `已取得 ${sit.pagesFetched || 1} 个页面素材（共 ${sit.interactiveTotal || 0} 个可交互线索${h.failed?.length ? `，${h.failed.length} 个页面抓取失败` : ''}）`,
        })
      }
      authorizeLanding(harvested)
      reportHarvest(harvested)

      // ★ 登录墙（用户诉求"允许在获取的过程中提示用户登录"）：
      //   检测 → **只有 high 才自动开窗**（中/弱信号只提示，用户要求"能不弹就不弹"）→
      //   登录成功 → **带 Cookie 重抓素材**（换掉登录前的空壳页）→ 继续生成。
      //   `material` 里要带上 `spa`：harvestSite 把 spa 放在返回体顶层、不在 material 内，
      //   不带的话 low 档判据（疑似前端空壳且线索极少）在生产路径几乎不可达。
      const wall = detectLoginWall({
        material: harvested.ok ? { ...harvested.material, spa: harvested.spa === true } : null,
        page: null,
        url: webUrl,
      })
      loginWall = wall
      if (wall.needed && !HIGH_ONLY.includes(wall.confidence)) {
        emitProgress(appId, { phase: 'login', waiting: false, key, detail: `${wall.reasons[0] || '该站点可能需要登录'}（未自动打开登录窗口，如需登录请点「登录此应用」）` })
      }
      if (wall.confidence === 'high' && executor) {
        // 开窗 + 导航要几秒（goto 上限 30s）：先把"正在等待登录"告诉界面，用户才知道该去哪儿操作
        emitProgress(appId, { phase: 'login', waiting: true, key, detail: `检测到登录墙：${wall.reasons[0] || ''}，已打开登录窗口，请在其中完成登录…` })
        const res = await appLogin.ensureLoggedIn({
          key,
          // 优先用登录墙给出的登录地址（表单 action / 当前登录页）；若编排预判"本来就登录着"则不会开窗
          url: wall.loginUrl || webUrl,
          executor,
          waitMs: loginWaitMs,
          pollMs: loginPollMs,
          // 编排自己的进度事件原样透传（含 waiting:true/false 与收尾文案），键统一由本层补
          emit: (p) => emitProgress(appId, { ...p, key }),
        })
        loginInfo = { attempted: true, ok: res.ok, reason: res.reason, detail: appLogin.loginResultDetail(res) }
        // 早退路径（没打扰过用户 ⇒ 编排自己不会发收尾事件）由本层补一条，否则界面停在"等待登录中"；
        // 正常路径由编排发出同一文案的收尾事件，这里**不得**再发一遍（重复事件）。
        if (LOGIN_EARLY_REASONS.includes(res.reason)) {
          emitProgress(appId, { phase: 'login', waiting: false, key, detail: loginInfo.detail })
        }
        if (res.ok) {
          // 带 Cookie 重抓：**替换**素材（登录前的空壳页绝不能当有效线索喂给模型）。
          // 已抓页面种子（visited）在本轮之后才依据新素材构建，故天然不含登录前的页面。
          harvested = await harvest(cookieProvider)
          authorizeLanding(harvested)
          reportHarvest(harvested)
          // 登录成功但重抓失败（典型：登录后跳到未授权域名，抓取层"跨站即整体失败"）：
          // 如实告知"已登录但没取到登录后素材"，别让用户以为本次生成用的是登录后的内容。
          if (!harvested.ok) {
            emitProgress(appId, { phase: 'login', waiting: false, key, detail: `已登录，但未取得登录后的页面素材（${harvested.error || '抓取失败'}）：本次生成未使用站点素材` })
          }
        }
      } else if (wall.confidence === 'high' && !executor) {
        // 高置信度登录墙但没有执行器 = 一条信号都发不出去（用户与界面完全不知情）。
        // 如实提示一声，并告知"登录此应用"入口暂不可用。
        loginInfo = { attempted: false, ok: false, reason: 'no-executor', detail: '检测到该站点需要登录，但浏览器执行器未就绪：本次未在登录态下验证' }
        emitProgress(appId, { phase: 'login', waiting: false, key, detail: loginInfo.detail })
      }

      const fetched = harvested.ok
        ? { ok: true, material: harvested.material, finalUrl: harvested.finalUrl, spa: harvested.spa, bytes: harvested.bytes }
        : { ok: false, error: harvested.error, status: harvested.status }
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
          const probed = await profiler.probeWeb({ url: target.url, executor, sessionId: key })
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
      key = keyFor(appId, target)   // desktop：键只影响下载目录与事件标签（无 cookie 语义）
      probeMode = 'browser'   // desktop 侧的"素材"是探测证据，口径沿用既有 browser 分支
      probeMaterial = { target, driver, evidence: detected.evidence }
      emitProgress(appId, { phase: 'probe', detail: `探测完成：驱动 ${driver}`, done: true })
    }

    // ② 生成 = **自主探索式**（app-agent.cjs）：把控制权交给模型
    //
    // ★ 为什么换掉原来的"固定脚本"（用户真实反馈）：
    //   「网站/应用的构造非常多样，如果你是用的固定脚本，LLM 参与度和自主度很低，那么可以肯定
    //     完成不了普遍性任务。给 LLM 框架，让它自己去充分探索和调试测试。并对封装格式质量提出要求。」
    //   原流程按写死的规则抓 6 页 → 一次成型 → 只回喂两次修正；站点结构一变（多级入口、
    //   要先搜索才能到详情页…）就抓不到关键页面，模型只能凭猜 → 命令又少又漏。
    //   现在：模型自己决定抓哪些页面、抓几次、先写什么、怎么调试，我们只提供工具与真实反馈。
    const runForVerify = (spec) => ({ action, args, sessionId: sid }) => (
      driver === 'browser'
        ? runCommand({ roots: roots(), appId, action, args, executor: getExecutor(), sessionId: sid, spec, persist: false })
        // ★ desktop 必须把 driver 注入 spec：草稿里的 driver 由模型写、常常没有，
        //   而 desktopRunner 第一件事就是校验 driver（回 "不支持的 driver：undefined"）。
        //   执行路径早就这么做了（见 runAppCommand 的 desktopRunner 调用），试跑路径漏了 —— 真实故障：
        //   试跑恒失败 → 模型被反复回喂 → 用户最终看到的是最早几轮的陈旧错误。
        : desktopRunner({ appId, action, args, spec: { ...spec, driver } })
    )
    // 试跑一律用站点/应用级键（登录态就存在这个分区里；chat sessionId 与它无关）
    const verifyOnce = (spec) => verifySpec({
      spec, sessionId: key,
      runCommand: runForVerify(spec),
      onProgress: (p) => emitProgress(appId, p),
    })

    // 已经抓过的页面（供 list_pages 与 fetch_page 去重；模型据此规划探索）
    const visited = new Map()
    if (probeMaterial && target.type === 'web') {
      const pages = [{ url: target.url, title: probeMaterial.title, interactives: probeMaterial.interactives, forms: probeMaterial.forms?.length || 0 }, ...(probeMaterial.pages || []).map((p) => ({ url: p.url, title: p.title, interactives: p.interactives, forms: p.forms?.length || 0 }))]
      for (const p of pages) if (p.url) visited.set(p.url, p)
    }
    const seedSummary = target.type === 'web' && visited.size
      ? `已预取 ${visited.size} 个页面：${[...visited.values()].map((p) => `${p.url}（${p.interactives ?? '?'} 个可交互线索）`).join('、')}。你可以直接在此基础上继续抓更多页面，不必重复抓这些。`
      : null

    /**
     * 工具执行器：**真实执行**并把真实结果（含真实报错）回给模型。
     * 安全边界：run_command 只允许 read 命令——write 会在用户的目标应用里产生真实改动，
     * 绝不能因为"模型想试试"就执行（这一点比让模型调试重要）。
     */
    /**
     * 浏览器探索（用户允许"自动点击/翻页探索"与"带登录态探索"）：
     * 用**真实浏览器执行器 + 应用自己的会话**打开页面，因此
     *   ① 能看到 JS 渲染出来的内容（HTTP 抓取看不到）；
     *   ② **带上该应用已有的登录态**（分区键见 app-session-key.cjs：web 按站点、desktop 按 appId，
     *      cookie 落盘持久化；键与命令执行/登录窗口共用，登录一次即全链路复用）；
     *   ③ 能点击展开菜单/翻页/进详情，看到 HTTP 永远看不到的页面。
     * 窗口仍是隐藏的（show:false），不会弹出来打扰用户。
     */
    let lastInteractives = []
    const exploreBrowse = async (act, params) => {
      if (driver !== 'browser') return { ok: false, summary: '这是桌面应用，没有浏览器页面可浏览；请直接用 run_command 试跑或 submit_spec。' }
      const executor = getExecutor()
      if (!executor) return { ok: false, summary: '浏览器执行器未就绪（应用可能尚未完成初始化）' }
      const r = await executor.exec(key, act, params)
      if (!r?.ok) return { ok: false, summary: `${act} 失败：${r?.error || '未知错误'}` }
      const snap = r.snapshot || {}
      lastInteractives = Array.isArray(snap.interactives) ? snap.interactives : []
      const pageUrl = snap?.page?.url
      if (pageUrl) visited.set(pageUrl, { url: pageUrl, title: snap.page.title, interactives: lastInteractives.length, forms: 0 })
      return { ok: true, summary: snapshotToText(snap, { cap: AGENT_TOOL_MATERIAL_CAP }) }
    }

    const runTool = async ({ tool, args, draft } = {}) => {
      if (tool === 'list_pages') {
        if (!visited.size) return { ok: true, summary: '还没有抓过任何页面（可能是桌面应用）。可以直接 submit_spec。' }
        return { ok: true, summary: [...visited.values()].map((p) => `${p.url}｜${p.title || '(无标题)'}｜${p.interactives ?? '?'} 个可交互线索｜表单 ${p.forms} 个`).join('\n') }
      }
      if (tool === 'fetch_page') {
        const url = normalizeUrl(args?.url)
        if (!url) return { ok: false, summary: `网址不合法：${String(args?.url)}（要写完整地址，如 https://example.com/foo）` }
        // 顺手授权该域名（模型探索到的同站/子域页面，后续试跑才不会因白名单被拦）。
        // ★ 注意它**不进** cookieProvider 的授权集合：模型自己挑的第三方页面绝不能收到本站登录态
        //   （授权集合仍是"用户在界面上填的那个站点 + 它的跳转落点"）。
        const exploreHosts = new Set(authorizeAppTarget({ type: 'web', url }, { extraUrls: [url] }))
        emitProgress(appId, { phase: 'explore', detail: `后台抓取 ${url}（不弹窗口）…` })
        const r = await httpProbe.fetchPageMaterial({
          url, fetchImpl,
          // 带登录态抓取：同站点页面能看到登录后的内容（Cookie 闸门仍是 cookieProvider）
          cookieProvider,
          // 跨 host 跳转的授权集合 = 用户授权站点 ∪ 模型这一次显式给的地址（含 apex/www 变体）
          isAllowedHost: (u) => { const h = hostOfUrl(u); return !!h && (authorizedHosts.has(h) || exploreHosts.has(h)) },
        })
        if (!r.ok) return { ok: false, summary: `${url} 抓取失败：${r.error}` }
        const m = r.material
        if (r.finalUrl) authorizeAppTarget({ type: 'web', url }, { extraUrls: [r.finalUrl] })
        // 注意别与上面的分区键 key 重名：这里只是"已抓页面的表键"
        const pageKey = r.finalUrl || url
        visited.set(pageKey, { url: pageKey, title: m.title, interactives: m.interactives, forms: m.forms?.length || 0 })
        return {
          ok: true,
          // 素材原样给模型（JSON 截断），它自己读得懂；摘要用于进度与 list_pages
          summary: `抓取成功：${m.title || '(无标题)'}｜${m.interactives} 个可交互线索｜表单 ${m.forms?.length || 0} 个${r.finalUrl && r.finalUrl !== url ? `｜跳转到 ${r.finalUrl}` : ''}\n素材：${JSON.stringify(m).slice(0, AGENT_TOOL_MATERIAL_CAP)}`,
        }
      }
      if (tool === 'browse') {
        const url = normalizeUrl(args?.url)
        if (!url) return { ok: false, summary: `网址不合法：${String(args?.url)}（要写完整地址，如 https://example.com/foo）` }
        authorizeAppTarget({ type: 'web', url }, { extraUrls: [url] })
        emitProgress(appId, { phase: 'explore', detail: `用浏览器打开（带登录态、不弹窗）${url}…` })
        return exploreBrowse('goto', { url })
      }
      if (tool === 'click') {
        // 先把 ref/text 解析成快照里的具体元素——解析不了要**列出可选目标**，让模型自己纠正
        const resolved = appAgent.resolveClickTarget(lastInteractives, { ref: args?.ref, text: args?.text })
        if (!resolved.ok) return { ok: false, summary: resolved.error }
        const label = String(resolved.target?.label || resolved.target?.tag || '')
        // 安全闸：用户允许的是"探索性点击"，不是"替用户删数据/下单"
        if (appAgent.isDestructiveLabel(label)) {
          return { ok: false, summary: `拒绝点击「${label}」：这看起来是删除/支付/退出这类破坏性操作。探索阶段不会执行它；如果这确实是用户目标里的动作，请把它写成 kind:"write" 的命令让用户自己触发。` }
        }
        emitProgress(appId, { phase: 'explore', detail: `点击「${label}」（探索性，不弹窗）…` })
        return exploreBrowse('click', { ref: resolved.target.ref })
      }
      if (tool === 'back') {
        emitProgress(appId, { phase: 'explore', detail: '返回上一页…' })
        return exploreBrowse('back', {})
      }
      if (tool === 'run_command') {
        const action = String(args?.action || '')
        const cmd = (draft?.commands || []).find((c) => c.action === action)
        if (!cmd) return { ok: false, summary: `草稿里没有名为「${action}」的命令。请先用 submit_spec 提交包含它的草稿，再试跑。` }
        if (cmd.kind !== 'read') {
          return { ok: false, summary: `拒绝试跑：命令「${action}」是 write（会在目标应用里产生真实改动），系统不会自动执行 write 命令。你只能试跑 read 命令。` }
        }
        if ((cmd.params || []).some((p) => p?.required) && !(args?.args && Object.keys(args.args).length)) {
          return { ok: false, summary: `命令「${action}」有必填参数，请在 args 里给出参数值再试跑（例：{"tool":"run_command","args":{"action":"${action}","args":{"id":"SO20250101-001"}}}` }
        }
        const r = await runForVerify(draft)({ action, args: args?.args || {}, sessionId: key })
        return r?.ok
          ? { ok: true, summary: `试跑成功（${r.durationMs || 0}ms）：${String(typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? '')).slice(0, 1200) || '(无输出)'}` }
          : { ok: false, summary: `试跑失败：${String(r?.error || '未知错误')}` }
      }
      if (tool === 'request_login') {
        // 模型自己判断"要看的内容在登录之后"时用它——把"要不要打扰用户"的判断权交给它，
        // 但真正的开窗等待仍然是同一套 ensureLoggedIn（与取素材阶段的自动检测复用同一条链路）。
        if (driver !== 'browser') {
          return { ok: false, summary: '这是桌面应用，没有浏览器登录概念；请直接用 run_command 试跑或 submit_spec。' }
        }
        const reason = String(args?.reason || '').slice(0, 120) || '该站点需要登录'
        // 每次现取执行器（执行器可能被重建）：取不到就如实说"开不了登录窗口"，别假装等过用户
        const loginExecutor = getExecutor()
        if (!loginExecutor) return { ok: false, summary: '浏览器执行器未就绪，无法打开登录窗口' }
        emitProgress(appId, { phase: 'login', waiting: true, key, detail: `模型请求登录：${reason}（已在可见窗口中打开该站点，请在其中完成登录）…` })
        const t0Login = Date.now()
        const res = await appLogin.ensureLoggedIn({
          key, url: target.url, executor: loginExecutor, waitMs: loginWaitMs, pollMs: loginPollMs,
          emit: (p) => emitProgress(appId, { ...p, key }),
        })
        if (LOGIN_EARLY_REASONS.includes(res.reason)) {
          emitProgress(appId, { phase: 'login', waiting: false, key, detail: appLogin.loginResultDetail(res) })
        }
        // 等人工的时长如实上报：runAgentLoop 会把它从探索时间预算里剔除
        const pauseMs = Date.now() - t0Login
        if (!res.ok) {
          return {
            ok: false, pauseMs,
            summary: `${appLogin.loginResultDetail(res)}（原因：${res.reason}）。你可以继续用现有能力探索，或用 browse 看登录后的页面，或直接 submit_spec 并在预览里让用户核对。`,
          }
        }
        // 登录成功：把**登录后重抓到的首页素材**回喂，模型下一轮就看得到登录后的内容。
        // 这里自带一套抓取参数（不依赖上面 web 分支块内的闭包变量）：授权集合按本次目标重新生成，
        // Cookie 仍经同一个闸门（未授权 host 一律 null），因此不会因为"重抓"把登录态发给第三方。
        let materialLine = '（登录后重抓失败，请用 browse 看登录后的真实页面）'
        try {
          const hosts = new Set(authorizeAppTarget(target, { extraUrls: [target.url] }))
          const provider = cookieProviderFor(loginExecutor, key, hosts)
          const re = await httpProbe.harvestSite({
            url: target.url, fetchImpl, maxPages: 2,
            cookieProvider: provider,
            isAllowedHost: (u) => hosts.has(hostOfUrl(u)),
          })
          if (re.ok && re.material) {
            const mk = re.finalUrl || target.url
            visited.set(mk, { url: mk, title: re.material.title, interactives: re.material.interactives, forms: re.material.forms?.length || 0 })
            materialLine = JSON.stringify(re.material).slice(0, AGENT_TOOL_MATERIAL_CAP)
          } else {
            materialLine = `登录后重抓失败：${re.error || '未知错误'}`
          }
        } catch (e) {
          materialLine = `登录后重抓异常：${String(e?.message || e)}`
        }
        return {
          ok: true, pauseMs,
          summary: `用户已完成登录，登录态已生效（后续 browse / 试跑 / AI 调用都会复用）。登录后重新抓取的首页素材：\n${materialLine}`,
        }
      }
      return { ok: false, summary: `未知工具「${tool}」。可用工具：fetch_page / list_pages / browse / click / back / request_login / run_command / submit_spec。` }
    }

    const agent = await appAgent.runAgentLoop({
      target, driver, probeMode, probeMaterial, seedSummary,
      callLlm, runTool,
      // ★ 草稿校验要用**本次探测出来的 driver**当尺子，不能交给 validateSpecBasic 只凭 target.type 去猜：
      //   target.type='desktop' 猜出来的是 uia（最保守兜底），于是 process 应用写出的 cli 步骤被判
      //   "driver=uia 只允许 focus / type / key / wait" —— 真实故障：模型拿着这条**方向反了**的报错
      //   反复重交（叠加试跑恒失败），用户最终只看得到最早几轮的陈旧错误。
      //   driver 是"目标"的属性（探测决定，交付时也是 `{ ...agent.spec, driver }` 覆盖），模型写的只是参考。
      //   唯一例外：草稿自己声明了**另一种 target.type**（模型连目标都写错了），此时按草稿自己的 target
      //   推定驱动，免得"目标写错"被报成"act 不合法"而互相掩盖。
      validate: (s) => {
        const draftType = s?.target?.type
        return draftType && draftType !== target.type ? validateSpecBasic(s) : validateSpecBasic({ ...s, driver })
      },
      verify: verifyOnce,
      onProgress: (p) => emitProgress(appId, p),
      budget: AGENT_BUDGET,
    })
    if (!agent.ok || !agent.spec) {
      const why = (agent.issues || []).slice(0, 3).join('；') || '模型未产出通过校验的 Spec'
      emitProgress(appId, { phase: 'error', detail: why })
      return done({ ok: false, error: why, issues: agent.issues, rounds: agent.turns, turns: agent.turns, toolCalls: agent.toolCalls, driver, stoppedBy: agent.stoppedBy })
    }

    let specWithDriver = { ...agent.spec, driver, target: { ...(agent.spec.target || {}), ...target } }
    // 登录墙结论落进 Spec 的可选字段 auth（仅 needed 时写）：界面据此提示"AI 调用前需先登录"，
    // 而 app:check 的运行时登录结论也只看它。validateSpec 不校验未知字段 → 向后兼容。
    if (loginWall?.needed) {
      specWithDriver = { ...specWithDriver, auth: { needsLogin: true, loginUrl: loginWall.loginUrl || undefined } }
    }
    const verify = agent.verify || { ok: false, tried: [], failures: [], notRun: [], skipped: [] }
    const genRounds = agent.turns

    // probeMode 如实回传：界面据此提示"命令未经验证、需人工核对"（不假装探测过）
    const probeInfo = { mode: probeMode, title: probeTitle, url: target.type === 'web' ? target.url : null, note: probeNote || null }
    emitProgress(appId, {
      phase: 'done',
      detail: verify.ok
        ? `生成完成：${specWithDriver.commands.length} 条命令，试跑 ${verify.tried.length} 条查询命令全部通过（探索 ${agent.turns} 轮 / ${agent.toolCalls} 次工具调用）`
        : `生成完成：${specWithDriver.commands.length} 条命令；试跑仍有 ${(verify.failures || []).length} 条未通过（模型已探索 ${agent.turns} 轮 / ${agent.toolCalls} 次工具调用）：${(verify.failures || []).map((f) => f.action).join('、')}`,
      issues: (verify.failures || []).map((f) => `${f.action}：${f.error}`),
    })
    return done({
      ok: true, spec: specWithDriver, driver, probe: probeInfo, rounds: genRounds,
      issues: agent.issues, warnings: agent.warnings, verify,
      // 登录编排结果如实回传（没走登录编排就是 null，不假装登录过）：
      // {attempted, ok, reason, detail}——界面据此决定"要不要提示未在登录态下验证"
      login: loginInfo,
      agent: { turns: agent.turns, toolCalls: agent.toolCalls, verified: agent.verified, stoppedBy: agent.stoppedBy, trace: agent.trace },
    })
  })

  // ---- 执行（Task 2.1/2.2）：按 driver 分发 ----
  // 实现体在下方 runAppCommand（模块级函数）：同一条执行路径有**两个**消费方——
  //   ① 渲染层 IPC（app:run，本通道）；
  //   ② 内核桥（Task 4.x「应用即工具」）：内核 bridge_request(route=app) →
  //      bridge 转 executor/主进程 → 本文件同一函数 → app:exec:response 回写内核。
  // 抽成模块级函数的唯一目的是让两侧执行语义/留痕**逐字节一致**（两套实现必漂移）。
  ipcMain.handle('app:run', (_e, payload) => runAppCommand({ ...(payload || {}), roots: roots(), getExecutor }))

  // 打开**可见**登录窗口：这是"带登录态探索/执行"的入口。
  //
  // 为什么需要它：浏览器自动化用的是**站点/应用级分区键**（见 app-session-key.cjs 的 partitionFor：
  // web 按站点 `app-site-<host>`、desktop 按 `app-<appId>`），cookie 落盘、可持久复用；
  // 但自动化窗口本身是隐藏的（用户要求"能不弹就不弹"），所以用户没有任何地方可以登录。
  // 这里提供一个**用户主动触发**的可见窗口（与命令/探索/生成共用同一个键），登录一次之后：
  //   · 命令执行（app:run / 内核调用）直接复用该登录态；
  //   · 模型探索时 browse/click 与生成期的带 Cookie 重抓看到的也是登录后的页面。
  // 注意：这不是"弹窗打扰"——它是用户点击后才打开的工具窗口。
  ipcMain.handle('app:login', async (_e, payload = {}) => {
    const url = normalizeUrl(payload.url)
    if (!url) return { ok: false, error: `网址不合法：${String(payload.url)}` }
    const executor = getExecutor()
    if (!executor) return { ok: false, error: '浏览器执行器未就绪' }
    // 键 = 站点级分区键（唯一出处 app-session-key.cjs），**与生成/探索/执行同一个键**：
    // 否则登录了也对命令没用（cookie 是按分区存的）。渲染层仍会用返回的 sessionId 字段，故两个字段都给。
    const key = keyFor(payload.appId, { type: 'web', url })
    // 显式授权该域名（与取素材/探索同源），否则导航会被白名单拦下
    authorizeAppTarget({ type: 'web', url })
    try {
      await executor.openWindow(key)          // 用户主动要登录 → 这里显式显示窗口（内部 show+focus）
      const r = await executor.exec(key, 'goto', { url })
      if (!r?.ok) return { ok: false, error: r?.error || '打开登录页面失败', key, sessionId: key }
      return { ok: true, key, sessionId: key, url: r?.snapshot?.page?.url || url }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---- 登录信号（Task 6）：用户点「我已完成登录」/取消等待 ----
  // 只回传 {ok:boolean}：false = **当前没有等待中的登录**（含"已经结算过"——结算即摘除登记），
  // 不是错误，渲染层不该渲染成"出错/请重试"。
  ipcMain.handle('app:login-done', (_e, payload) => ({ ok: appLogin.resolveLoginWait(payload?.key) }))
  ipcMain.handle('app:login-cancel', (_e, payload) => ({ ok: appLogin.cancelLoginWait(payload?.key) }))
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
    // 会话 = 站点/应用级分区键（唯一出处 app-session-key.cjs）。
    // ★ 传入的 chat sessionId **刻意忽略**：登录态属于应用而不是某次聊天会话，
    //   否则换个会话就要重新登录，且用户刚登录过又"未登录"（本功能的核心诉求）。
    const key = appSessionKey({ appId, target: spec.target })
    // 用户保存过的应用目标 = 显式授权（否则非白名单站点的命令执行/AI 调用会被直接拦下）
    authorizeAppTarget(spec.target)
    return runCommand({ roots, appId, action, args, executor, sessionId: key })
  }

  // desktop：与 browser 路径同口径留痕（runCommand 内部负责 browser 的留痕）
  const res = await desktopRunner({ appId, action, args, spec: { ...spec, driver } })
  appendHistory({ roots, appId, entry: { appId, action, args, kind: res.kind, at: new Date().toISOString(), ok: res.ok, error: res.error, durationMs: res.durationMs } })
  return res
}

/** 同一站点的常见两种写法：apex 与 www（网站几乎都会在两者间跳转） */
function hostVariants(host) {
  const h = String(host || '').toLowerCase()
  if (!h) return []
  return h.startsWith('www.') ? [h, h.slice(4)] : [h, `www.${h}`]
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
 *   都会经 BrowserExecutor → 白名单拦下，全部报「目标域名不在白名单…已拒绝导航」。
 *
 * 真机第二轮暴露的补充（务必保留）：网站常在 apex 与 www 之间**跳转**
 * （kimi.com → www.kimi.com）。白名单是**精确主机名匹配**，只授权 `kimi.com` 时，
 * 模型按素材里跳转后的真实地址写出的 `https://www.kimi.com/...` 依然被拦，
 * 试跑再次全红。所以：① 同时授权 host 与它的 www/apex 变体；
 * ② 额外授权**后台抓取观察到的最终地址（跳转落点）**——那是用户这个网址的真实去向。
 *
 * 边界：不扩散到子域（`sub.X` 不因授权 `X` 而放行）、不改全局默认白名单、不写任何配置文件。
 * @param {{type?:string,url?:string}} target
 * @param {{extraUrls?: Array<string|null|undefined>}} [opts] 追加授权（如跳转落点）
 * @returns {string[]} 实际被授权的主机名
 */
function authorizeAppTarget(target, { extraUrls = [] } = {}) {
  if (!target || target.type !== 'web') return []
  const hosts = new Set()
  for (const raw of [target.url, ...extraUrls]) {
    const normalized = normalizeUrl(raw)
    if (!normalized) continue
    try {
      for (const h of hostVariants(new URL(normalized).hostname)) hosts.add(h)
    } catch { /* 忽略无法解析的输入 */ }
  }
  for (const h of hosts) isWhitelisted.allow(h)
  return [...hosts]
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

module.exports = { registerAppHandlers, runAppCommand, handleAppExecMessage, inferDriver, appRoots, profiledSnapshot, authorizeAppTarget, hostVariants }
