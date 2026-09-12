// server/workflow-host.mjs —— 常驻工作流宿主（专用内核会话 _wfhost）
// 职责：懒启动宿主会话；把 GUI 请求转为内核 stdin 的 workflow_command / workflow_confirm；
// 按 requestId 配对回执；发放/回收运行级 grantToken；把内核 workflow 事件转给 GUI 广播。
// 说明：宿主 = 普通内核会话（mode=task，cwd=<YFW_HOME>/workflow-runtime，工具全开）。
// 授权闸门 = 运行前授权清单（grant）：宿主把 grant 随 workflow_command.run 注入，
// 内核把它放进节点 ctx 的 checkToolPermission（未授权调用在节点执行器内 fail-closed）；
// 本模块只负责记账（issueGrant/revokeGrant/isGranted，键为 runId，一次运行有效）。
//
// 约束：本文件只 import `node:*`；**不得** import `kernel/*.mjs`（生产包只带
// kernel-dist/cli.mjs，dev 下不显现、安装版才崩）。
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export const HOST_SID = '_wfhost'
const DEFAULT_TIMEOUT = 120_000
const RUN_TIMEOUT = 30 * 60_000        // 工作流可能跑很久（多步 agent 节点）
const STOP_TIMEOUT = 15_000

// 能力清单保守合并：取并集（前端勾选项 ∪ 声明项），不得放大权限。
// network 采用或运算——任一侧要求即为 true；write_dirs/tools 去重。
// M-1：非数组入参不得按字符展开（'Read' → ['R','e','a','d']）。
const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])

/** 可安全自动重试的**幂等**子命令。run 刻意不在列：重试＝把工作流重跑一遍，
 *  必须由用户显式决定（读取/保存/校验/查询类重试无副作用）。 */
const RETRIABLE_SUBTYPES = new Set(['load', 'validate', 'save-raw', 'list', 'verify', 'migrate'])

/** 会话条目是否已死（进程退出/被杀/stdin 已销毁）：写进死进程只会得到 EPIPE。
 *  注意 `exitCode/signalCode` 在 Node 的 ChildProcess 上默认是 null，但测试替身可能
 *  干脆没有这两个属性——必须区分"属性为 null（活）"与"undefined（未知，不判死）"，
 *  否则会把活会话误判成死的。 */
function isSessionDead(s) {
  const p = s?.proc
  if (!p) return true
  if (p.killed) return true
  if (p.exitCode !== null && p.exitCode !== undefined) return true
  if (p.signalCode) return true
  return !p.stdin || p.stdin.destroyed === true
}

/** 错误是否属于"宿主进程没了"（供幂等命令自动重试判定）。 */
function isHostGoneError(e) {
  if (e?.hostGone === true) return true
  return /EPIPE|ERR_STREAM_DESTROYED|write after end|socket hang up|宿主会话/i.test(String(e?.message || e || ''))
}
export function mergeCapabilities(declared = {}, requested = {}) {
  const tools = [...new Set([...asList(declared.tools), ...asList(requested.tools)])]
  const write_dirs = [...new Set([...asList(declared.write_dirs), ...asList(requested.write_dirs)])]
  return { tools, write_dirs, network: declared.network === true || requested.network === true }
}

export function createWorkflowHost({ sessions, getOrCreateSession, yfwHome = '', model = '', onEvent = () => {} }) {
  const pending = new Map()   // requestId → { resolve, reject, timer }
  const _grants = new Map()   // runId → capabilities（一次运行有效）
  const cwd = join(yfwHome || '', 'workflow-runtime')

  // 只转发 GUI 关心的 workflow 类事件/无人认领的回执（其余 system 消息归 bridge 通用广播）
  const FORWARD_SUBTYPES = new Set(['workflow', 'auto_triggered', 'scheduled_run', 'webhook', 'error'])
  function emit(msg) {
    if (!FORWARD_SUBTYPES.has(msg?.subtype)) return
    try { onEvent(msg) } catch { /* 广播失败不阻断命令配对 */ }
  }

  // 懒启动：没有宿主会话就起一个（mode=task，工作目录 workflow-runtime）
  // ⚠️ cwd 必须先落盘：Windows 下以**不存在的目录** spawn 会立刻 ENOENT 退出
  // （实测退出码 -4058、存活约 250ms），宿主反复重启且命令写进死进程 → 前端永久挂起
  // （POST /workflows 无响应；GET /workflows 是纯 fs 故看着"正常"，极难自查）。
  //
  // 会话条目"还在但进程已死"（被回收杀 / 崩溃 / ENOENT 秒退）时先清掉再重建：
  // 否则 ensure() 以为宿主健在，命令写进死进程只会得到 EPIPE（用户侧仍是一次失败）。
  function ensure() {
    const cur = sessions.get(HOST_SID)
    if (cur && isSessionDead(cur)) {
      try { sessions.delete(HOST_SID) } catch { /* 并发删除：忽略，下方按"无会话"重建 */ }
    }
    if (!sessions.has(HOST_SID)) {
      try { mkdirSync(cwd, { recursive: true }) } catch { /* 已存在/无权限：让 spawn 自己报错 */ }
      getOrCreateSession(HOST_SID, cwd, null, '', model, 0, 'task')
    }
    return HOST_SID
  }

  function settle(requestId, result) {
    const p = pending.get(requestId)
    if (!p) return false
    clearTimeout(p.timer)
    pending.delete(requestId)
    p.resolve(result)
    return true
  }

  // 无 requestId 的错误回执无法配对（内核 `wire.system('workflow_result', {subtype:'error'})`
  // 不带 requestId）。**只结清最近发出的那一条**（LIFO），不得 reject 全部：
  // ① 内核的 workflow_command 处理是**并发**的（cli.mjs 未 await），长跑的 run 与后续短命令
  //    会同时在途——reject 全部会把仍在执行的 run 判失败并连带回收其 grant（Task 11 审查 I-1）；
  // ② 取"最近发出"而非"最早发出"：无名错误只可能来自刚发出的那条命令（长跑的 run 通常是最早
  //    发出的，若按 FIFO 会在 save-raw 失败时被误杀）。
  /** 内核回执配对失败后的兜底（见 rejectNewestPending 注释）。 */
  function rejectNewestPending(error) {
    let lastKey = null
    for (const k of pending.keys()) lastKey = k
    if (lastKey === null) return false
    const p = pending.get(lastKey)
    clearTimeout(p.timer)
    pending.delete(lastKey)
    p.reject(new Error(error || '宿主命令失败'))
    return true
  }

  // 回执入参归一化：load/validate/stop 把结果放 `result`；list/run/verify/migrate 直接平铺在消息上。
  function normalizeResult(msg) {
    if (msg.result !== undefined && msg.result !== null) return msg.result
    const { type: _t, subtype, requestId: _r, ...rest } = msg
    return rest
  }

  function send(cmd = {}, { timeoutMs = DEFAULT_TIMEOUT, retried = false } = {}) {
    const subtype = cmd.subtype || ''
    const requestId = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const attempt = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`宿主命令超时（${subtype}）`))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      try {
        ensure()
        const s = sessions.get(HOST_SID)
        s.proc.stdin.write(JSON.stringify({ type: 'workflow_command', requestId, subtype, payload: cmd.payload ?? {} }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(e)
      }
    })
    // 宿主进程消失（被回收/崩溃/冷启动竞态）→ 重建宿主后**重试一次**：
    // 旧行为是第一次请求直接失败（用户侧"运行/保存失败：工作流宿主会话已退出"，
    // 必须手动再点一次），而这类失败与请求本身无关，重试即可自愈。
    // 只对幂等子命令生效；run 重试＝重跑工作流，交回用户决定。
    return attempt.catch((e) => {
      if (retried || !RETRIABLE_SUBTYPES.has(subtype) || !isHostGoneError(e)) throw e
      return send(cmd, { timeoutMs, retried: true })
    })
  }

  // 内核回执入口。真实回执形态：wire.system(subtype, extra) → `{type:'system', subtype: <子命令名>, requestId, ...}`；
  // brief 里的 `subtype:'workflow_result'` 只是同一 shape 的早期写法 —— 一律按 requestId 配对，两者都能收敛。
  function onKernelMessage(msg) {
    if (!msg || msg.type !== 'system') return false
    const rid = msg.requestId
    if (rid && pending.has(rid)) {
      settle(rid, normalizeResult(msg))
      return true
    }
    if (msg.subtype === 'error' && pending.size) {
      rejectNewestPending(msg.error)
      emit(msg)
      return true
    }
    emit(msg)
    return false
  }

  // —— grant 生命周期：issueGrant 只授予本次运行（runId 为键），运行结束 revokeGrant ——
  function issueGrant(runId, capabilities) {
    _grants.set(runId, capabilities)
    return `grant-${runId}`
  }
  function revokeGrant(runId) { _grants.delete(runId) }
  function isGranted(runId, tool) {
    const g = _grants.get(runId)
    return !!g && Array.isArray(g.tools) && g.tools.includes(tool)
  }

  function newRunId() {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  /** 客户端预生成的 runId 只在格式合法时采用（非法即丢弃改用随机 id，避免注入到审计文件名/
   *  stop/confirm 匹配键上）。前端必须在**提交前**认领 runId：异步后宿主回执到达前内核就已
   *  开始发事件（start/confirm_request），回执后才认领会丢掉最早的事件。 */
  const RUN_ID_OK = /^[A-Za-z0-9_-]{1,64}$/
  function adoptRunIdFromClient(runId) {
    const s = String(runId || '')
    return RUN_ID_OK.test(s) ? s : ''
  }

  /** 运行命令的载荷（run 与 startRun 共用，避免两处漂移）。
   *  payload.cwd = 宿主会话 cwd：内核侧 grant 相对路径以此为准（Task 9 遗留：内核进程
   *  cwd 与宿主会话 cwd 未必一致，宿主显式告知，避免"相对路径判定基"歧义）。 */
  function runPayload({ id, inputs = {}, grant, rid }) {
    return { subtype: 'run', payload: { workflow: id, inputs, runId: rid, grant, cwd } }
  }

  /** I-2：内核（cli.mjs）已转发 payload.runId，故真实运行 id 就是 rid；仍以回执为准并
   *  回迁 grant 键，防止内核版本差异导致 id 分叉（分叉会让 stop/confirm 打空）。 */
  function adoptRunId(rid, realId) {
    if (realId === rid || !_grants.has(rid)) return realId
    _grants.set(realId, _grants.get(rid))
    _grants.delete(rid)
    return realId
  }

  /** 后台运行结束后的结果缓存：容量有限（FIFO 淘汰）。
   *  异步化后 POST /workflows/run 立即返回，结果的三条出口是
   *  ① WS workflow_event（start/node/edge_taken/end，主通道）
   *  ② 运行审计 jsonl（历史记录）
   *  ③ 本缓存（GET /workflows/run-status 兜底：丢事件/重连后仍能拿到终态与最终输出）。 */
  const RUN_RESULT_KEEP = 50
  const runResults = new Map()   // runId → 终态结果（含 finished:true）
  /** 在途运行（缓存未命中时用于区分"还在跑"与"未知 runId"，避免前端轮询永不收敛） */
  const inflight = new Set()

  function rememberRun(runId, res) {
    inflight.delete(runId)
    runResults.set(runId, { ...res, finished: true })
    while (runResults.size > RUN_RESULT_KEEP) {
      const oldest = runResults.keys().next().value
      if (oldest === runId) break
      runResults.delete(oldest)
    }
  }

  /**
   * 异步启动（GUI 主通道）：**立即**返回 runId，工作流在后台跑完。
   * 原同步版 run() 让 POST /workflows/run 阻塞整个运行时长（spec-dev 实测 80–110 秒），
   * 界面在等待期零反馈 → 用户重复点击 → 同一工作流并行多份重跑（2026-09-12 实测：
   * 20 秒内 3 份 spec-dev 同时在跑）。异步化后 UI 立即拿到 runId 并开抽屉，
   * 过程由事件流驱动，终态可经 runResult 查询兜底。
   */
  function startRun({ id, inputs = {}, capabilities = null, grant: grantArg = null, runId = '' } = {}) {
    const rid = adoptRunIdFromClient(runId) || newRunId()
    const grant = mergeCapabilities({}, capabilities ?? grantArg ?? {})
    issueGrant(rid, grant)
    runResults.delete(rid)   // 同 id 重跑：旧结果作废，避免轮询读到上一轮终态
    inflight.add(rid)
    let finalId = rid
    send(runPayload({ id, inputs, grant, rid }), { timeoutMs: RUN_TIMEOUT })
      .then((r) => {
        finalId = adoptRunId(rid, r?.runId || rid)
        const { runId: _ignored, ...rest } = r || {}
        rememberRun(rid, rest)
        if (finalId !== rid) rememberRun(finalId, rest)   // 分叉时两个键都能查到
      })
      .catch((e) => {
        // 宿主退出/超时/内核报错：必须落一条失败结果——否则前端只能等 run-status 报"未知"，
        // 观感仍是"点了没反应"。error 文案与 onKernelExit 的判失败口径一致。
        rememberRun(rid, { ok: false, status: 'failed', error: e?.message || String(e) })
      })
      .finally(() => {
        // 一次运行有效：结束即失效。必须按**回迁后的键**回收（复审 N-1）。
        revokeGrant(rid)
        if (finalId !== rid) revokeGrant(finalId)
      })
    return { ok: true, runId: rid, status: 'running', started: true }
  }

  /** 运行状态查询（兜底通道）：in-flight → 运行中；有终态结果 → 原样返回；
   *  两者都没有 → ok:false + unknown（宿主重启/超出缓存/非法 runId），调用方据此停止轮询。 */
  function runResult(runId) {
    const id = String(runId || '')
    if (!id) return { ok: false, error: 'runId 必填' }
    if (inflight.has(id)) return { ok: true, runId: id, status: 'running', finished: false }
    const r = runResults.get(id)
    if (r) return { ok: true, runId: id, ...r }
    return { ok: false, runId: id, unknown: true, error: '未知 runId（可能已结束且超出缓存，或宿主已重启）' }
  }

  /** 同步运行（保留给内核工具 / 既有调用方）：等待跑完再返回完整结果。 */
  async function run(opts = {}) {
    // M-2：`capabilities` 与 `grant` 两个名字都接受（GUI/宿主两侧叫法不同），
    // 否则 GUI 传 grant 时会静默得到空工具集（fail-closed 但无任何报错）。
    const rid = adoptRunIdFromClient(opts.runId) || newRunId()
    const grant = mergeCapabilities({}, opts.capabilities ?? opts.grant ?? {})
    issueGrant(rid, grant)
    let realId = rid
    try {
      const r = await send(runPayload({ id: opts.id, inputs: opts.inputs || {}, grant, rid }), { timeoutMs: RUN_TIMEOUT })
      realId = adoptRunId(rid, r?.runId || rid)
      return { ...r, runId: realId }
    } finally {
      revokeGrant(realId)
      if (realId !== rid) revokeGrant(rid)
    }
  }

  /**
   * 宿主内核退出（bridge 在进程 exit 时调用）：把在途命令**立即**判失败。
   * 缺这一步，内核一死，GUI 的创建/保存/运行会静默挂到超时（默认 120s、run 更长达 30min）——
   * 用户侧表现为"点了没有任何反应"，且界面无任何错误可查（实测就是这个症状）。
   */
  function onKernelExit(sid) {
    if (sid && sid !== HOST_SID) return false
    if (!pending.size) return true
    const err = new Error('工作流宿主会话已退出，命令未完成（详见应用日志 kernel-stderr）')
    // 标记"宿主没了"：send 据此对幂等子命令自动重建宿主并重试一次（见 send 尾部）。
    err.hostGone = true
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err) }
    pending.clear()
    return true
  }

  return {
    ensure,
    send,
    onKernelMessage,
    onKernelExit,
    _pendingSize: () => pending.size,
    _inflightSize: () => inflight.size,
    _runResults: runResults,
    onEvent: emit,
    load: (id) => send({ subtype: 'load', payload: { id } }),
    validate: (id) => send({ subtype: 'validate', payload: { id } }),
    // save：内核 save/save-raw 子命令尚未落地（serializeWorkflow 的宿主侧调用属 Task 12），
    // 这里只发命令、不落盘（单一写者：落盘归 store / Task 12）。
    save: ({ id, yaml = '', model: mdl } = {}) => send({ subtype: 'save-raw', payload: mdl ? { id, model: mdl } : { id, yaml } }),
    run,
    startRun,
    runResult,
    stop: (runId) => send({ subtype: 'stop', payload: { runId } }, { timeoutMs: STOP_TIMEOUT }),
    // 用户确认直接写宿主 stdin（不配对回执：内核经 workflow 事件回播三态）。
    // M-3：stdin 已 EPIPE / 会话条目残留时 write 会同步抛错，这里兜住并返回失败，
    // 避免把异常抛给 bridge 的 HTTP 处理器（那会变成 500 而非可读错误）。
    confirm: ({ runId, node, action = 'approved', comment = '' } = {}) => {
      try {
        ensure()
        const s = sessions.get(HOST_SID)
        if (!s?.proc?.stdin || s.proc.killed || s.proc.stdin.destroyed) {
          return { ok: false, error: '宿主会话不可用，确认发送失败' }
        }
        s.proc.stdin.write(JSON.stringify({ type: 'workflow_confirm', payload: { runId, node, action, comment } }) + '\n')
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e?.message || String(e) }
      }
    },
    issueGrant, revokeGrant, isGranted,
    _grants,
  }
}
