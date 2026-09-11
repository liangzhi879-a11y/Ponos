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

export const HOST_SID = '_wfhost'
const DEFAULT_TIMEOUT = 120_000
const RUN_TIMEOUT = 30 * 60_000        // 工作流可能跑很久（多步 agent 节点）
const STOP_TIMEOUT = 15_000

// 能力清单保守合并：取并集（前端勾选项 ∪ 声明项），不得放大权限。
// network 采用或运算——任一侧要求即为 true；write_dirs/tools 去重。
// M-1：非数组入参不得按字符展开（'Read' → ['R','e','a','d']）。
const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])
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
  function ensure() {
    if (!sessions.has(HOST_SID)) getOrCreateSession(HOST_SID, cwd, null, '', model, 0, 'task')
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

  function send(cmd = {}, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const subtype = cmd.subtype || ''
    const requestId = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    return new Promise((resolve, reject) => {
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

  async function run({ id, inputs = {}, capabilities = null, grant: grantArg = null, runId = '' } = {}) {
    // M-2：`capabilities` 与 `grant` 两个名字都接受（GUI/宿主两侧叫法不同），
    // 否则 GUI 传 grant 时会静默得到空工具集（fail-closed 但无任何报错）。
    const rid = runId || `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const grant = mergeCapabilities({}, capabilities ?? grantArg ?? {})
    issueGrant(rid, grant)
    let realId = rid
    try {
      // payload.cwd = 宿主会话 cwd：内核侧 grant 相对路径以此为准（Task 9 遗留：内核进程
      // cwd 与宿主会话 cwd 未必一致，宿主显式告知，避免"相对路径判定基"歧义）。
      const r = await send({ subtype: 'run', payload: { workflow: id, inputs, runId: rid, grant, cwd } }, { timeoutMs: RUN_TIMEOUT })
      // I-2：内核（cli.mjs）已转发 payload.runId，故真实运行 id 就是 rid；仍以回执为准并
      // 回迁 grant 键，防止内核版本差异导致 id 分叉（分叉会让 stop/confirm 打空）。
      realId = r?.runId || rid
      if (realId !== rid && _grants.has(rid)) {
        _grants.set(realId, _grants.get(rid))
        _grants.delete(rid)
      }
      return { ...r, runId: realId }
    } finally {
      // 一次运行有效：结束即失效。必须按**回迁后的键**回收，否则分叉路径会遗留
      // realId 键的 grant（复审 N-1：不可达但泄漏）。
      revokeGrant(realId)
    }
  }

  return {
    ensure,
    send,
    onKernelMessage,
    onEvent: emit,
    load: (id) => send({ subtype: 'load', payload: { id } }),
    validate: (id) => send({ subtype: 'validate', payload: { id } }),
    // save：内核 save/save-raw 子命令尚未落地（serializeWorkflow 的宿主侧调用属 Task 12），
    // 这里只发命令、不落盘（单一写者：落盘归 store / Task 12）。
    save: ({ id, yaml = '', model: mdl } = {}) => send({ subtype: 'save-raw', payload: mdl ? { id, model: mdl } : { id, yaml } }),
    run,
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
