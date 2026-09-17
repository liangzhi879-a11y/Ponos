// 宿主与诊断路由（P1 · 从 server/bridge.mjs 抽出）
// ---------------------------------------------------------------------------
// 约定同 `server/logs-routes.mjs`：**纯算响应，不碰 res/socket**，
// 返回 `{ status, body }` 表示已算出响应；返回 `null` 表示不是本模块负责的路径。
//
// 为什么这些端点归一个模块：它们都是"读**宿主/应用本机**信息"的端点，共同特征是
// **不涉及会话状态与工具转发**（本桥最核心、最危险的部分），因此可以安全外移：
//   · `/known-folders`、`/drives`  — 宿主文件系统结构（目录选择器左栏）
//   · `/diag/info`、`/diag/render-frame` — 诊断指标（内存态，供 diag-monitor 读）
//   · `/transcript/…`             — 内核落盘的会话转录（列表/载入/搜索/删除）
//   · `/health`、`/boot-status`   — 应用自身的存活与启动进度（2026-09-17 批次 1 并入）
//
// **有状态依赖，必须由调用方按引用传入**（迁移时逐字保留语义）：
//   · `diagInfo`  — 桥内存对象，`/diag/render-frame` 会**就地更新**它（diag-monitor 读同一对象）
//   · `sessions` — 桥的会话 Map，`/transcript/delete` 用它判断"会话是否仍在运行"
//   · `bootState` — 桥启动进度对象，由 boot 流程逐步置位；`/boot-status` 只读它
// 传引用（而非副本）是刻意的：这些都是跨请求共享的活状态。传副本会**静默失效**
// （改动不再反射到另一端），且不会有任何报错——上一轮拆分时踩过这个坑。
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本模块负责的路径（`/transcript/` 走前缀匹配，见 isHostPath） */
const FIXED_PATHS = new Set([
  '/known-folders', '/drives', '/diag/info', '/diag/render-frame',
  '/health', '/boot-status',
])

export function isHostPath(pathname) {
  return FIXED_PATHS.has(pathname) || pathname.startsWith('/transcript/')
}

const json = (status, body) => ({ status, body })

/**
 * 处理宿主/诊断类路径。
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.pathname
 * @param {URLSearchParams} p.searchParams
 * @param {object|null} p.body                     已解析 body（仅 POST 端点；`/diag/render-frame` 允许为 null）
 * @param {string} p.sep                           平台路径分隔符
 * @param {object} p.diagInfo                      桥内存诊断对象（**按引用**，会被就地更新）
 * @param {Map} p.sessions                         桥会话 Map（**按引用**，用于判断会话是否在运行）
 * @param {object} p.bootState                     桥启动进度对象（**按引用**，只读）
 * @param {Function} p.createTranscriptHandlers    来自 server/transcript.mjs
 * @returns {Promise<{status:number,body:any}|null>}
 */
export async function handleHostRoute({ method, pathname, searchParams, body, sep, diagInfo, sessions, bootState, createTranscriptHandlers }) {
  if (!isHostPath(pathname)) return null

  // ── /health：存活探针（含 pid，便于运维确认"是哪个进程"）─────────────────
  if (pathname === '/health') {
    return json(200, { status: 'ok', pid: process.pid })
  }

  // ── /boot-status：启动预热状态（2026-09-11 真实 boot 进度）──────────────
  // main 轮询本端点转发给 BootScreen——各模块真实完成后置位，渲染层按真实步骤渲染、
  // 全部就绪才交棒。`...bootState` 必须读**活对象**（按引用传入），否则进度永远停在初始态。
  if (pathname === '/boot-status') {
    return json(200, { ok: true, ...bootState })
  }

  // ── /known-folders：主目录下存在的常用文件夹（目录选择器左栏）──────────────
  if (pathname === '/known-folders') {
    const home = homedir()
    const candidates = [
      { name: '主目录', kind: 'home', rel: '' },
      { name: '桌面', kind: 'desktop', rel: 'Desktop' },
      { name: '文档', kind: 'documents', rel: 'Documents' },
      { name: '下载', kind: 'downloads', rel: 'Downloads' },
      { name: '图片', kind: 'pictures', rel: 'Pictures' },
      { name: '音乐', kind: 'music', rel: 'Music' },
      { name: '视频', kind: 'videos', rel: 'Videos' },
    ]
    const folders = []
    for (const c of candidates) {
      const abs = c.rel ? join(home, c.rel) : home
      try {
        if (!existsSync(abs) || !statSync(abs).isDirectory()) continue
        folders.push({ name: c.name, kind: c.kind, path: abs.split(sep).join('/') })
      } catch { /* 单项探测失败不影响其余项 */ }
    }
    // 注意：回包由调用方以 `reply(200, headers, body)` 三参形式发出——**漏掉第三参**
    // 会把 headers 当 body（200 + 空响应体），渲染层 res.json() 解析失败 ⇒ 目录选择器
    // 左栏恒显"读取失败"。修复 2026-09-16，勿再退回两参写法。
    return json(200, { folders })
  }

  // ── /drives：存在的盘符（Windows 下 A:-Z:，逐个探测）──────────────────────
  if (pathname === '/drives') {
    const drives = []
    for (let c = 65; c <= 90; c++) {
      const dr = String.fromCharCode(c) + ':' + sep
      if (existsSync(dr)) drives.push({ name: dr.replace(/\\/g, '/'), path: dr.replace(/\\/g, '/'), type: 'drive' })
    }
    return json(200, { drives })
  }

  // ── /diag/info：诊断快照（内存态）────────────────────────────────────────
  if (pathname === '/diag/info') {
    return json(200, { ok: true, data: diagInfo })
  }

  // ── /diag/render-frame：渲染帧指标上报（2026-09-13「任务运行慢」系统性优化）──
  // 渲染进程每 5s 汇总一次（帧数 / 单帧处理 ms p50,p95 / 真实帧间隔 p50,max）。
  // **只存内存、不落盘**，供 diag-monitor 的 render-health 读取。
  // 契约纯增量：老 GUI 不上报 → 字段缺失，读取方按"无数据"降级。
  if (pathname === '/diag/render-frame' && method === 'POST') {
    const b = body || {}
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)
    diagInfo.renderFrames = {
      frames: num(b.frames), msP50: num(b.msP50), msP95: num(b.msP95),
      gapP50: num(b.gapP50), gapMax: num(b.gapMax), heavy: b.heavy === true,
      // R5：降频成因（进/出次数 + 队列压力峰值 + 上一次触发的理由）。只报"当时是否
      // 降频"回答不了"为什么降/为什么没降"，而后者才是排查 R 阶段问题时真正要看的。
      heavyIn: num(b.heavyIn), heavyOut: num(b.heavyOut),
      qMax: num(b.qMax), qAgeMax: num(b.qAgeMax),
      reason: typeof b.reason === 'string' ? b.reason.slice(0, 40) : '',
      at: Date.now(),
    }
    return json(200, { ok: true })
  }

  // ── /transcript/…：内核 transcript 读取（实现见 transcript.mjs）──────────
  if (pathname.startsWith('/transcript/')) {
    const transcriptApi = createTranscriptHandlers()

    if (pathname === '/transcript/list') {
      const cwd = searchParams.get('cwd') || ''
      return json(200, { ok: true, sessions: transcriptApi.listSessions(cwd) })
    }
    if (pathname === '/transcript/load') {
      const cwd = searchParams.get('cwd') || ''
      const sessionId = searchParams.get('sessionId') || ''
      const tailFirst = searchParams.get('tailFirst') !== '0' // 默认 1
      return json(200, transcriptApi.loadTranscript(cwd, sessionId, tailFirst))
    }
    if (pathname === '/transcript/search') {
      const query = searchParams.get('query') || ''
      const limit = parseInt(searchParams.get('limit') || '50', 10) || 50
      return json(200, { ok: true, results: transcriptApi.searchTranscripts(query, limit) })
    }
    // 删除单个会话的磁盘转录（GUI 删会话时调用；安全约束见 transcript.mjs deleteTranscript）。
    // Body: { sessionId, cwd }——sessionId 必须是**内核 sessionId**（conversation.sessionId），
    // GUI 的 conversation.id 是另一套 id，传错只会 not-found。
    if (pathname === '/transcript/delete' && method === 'POST') {
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      // 运行中的会话不得删除：内核进程仍在 append 写同一文件，删了会被立刻重建
      // （且丢掉当前上下文），因此按契约直接拒绝，由 GUI 静默忽略。
      if (sessions.has(sessionId)) {
        return json(409, { ok: false, error: '会话仍在运行，无法删除转录' })
      }
      const r = transcriptApi.deleteTranscript(sessionId, cwd)
      if (r.reason === 'invalid-id' || r.reason === 'outside-base') {
        return json(400, { ok: false, error: r.reason === 'invalid-id' ? '非法 sessionId' : '路径越界，已拒绝' })
      }
      // not-found 视为成功（幂等：文件早已不在，目标状态已达成）
      return json(200, { ok: true, deleted: r.deleted })
    }

    return json(404, { ok: false, error: `未知的 transcript 端点：${pathname}` })
  }

  return null
}
