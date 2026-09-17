// src/lib/workflowApi.ts —— 工作流 bridge HTTP 客户端（UI Task 13，消费 Task 12 路由）
//
// 路由全表（server/workflow-routes.mjs，bridge 端口见 config.getBridgeUrl()）：
//   GET  /workflows                     列表（含 root）
//   POST /workflows                     新建 { id, model }
//   GET/PUT/DELETE /workflows/:id       读取（含 model/yml/validation）/ 保存 / 删除
//   POST /workflows/:id/duplicate       { toId }
//   GET  /workflows/:id/validate        内核权威校验（本地 validateLocal 只是快速反馈）
//   GET  /workflows/:id/versions        POST /workflows/:id/rollback { ts }
//   GET  /workflows/:id/export          .yfwflow 分享包
//   POST /workflows/import              { bundle, id? }
//   POST /workflows/run                 **必带 capabilities**（缺 → 400）；返回 runId（异步）
//   GET  /workflows/run-status?runId=   运行态/终态查询（丢事件兜底）
//   POST /workflows/stop                { runId }
//   POST /workflows/confirm             { runId, node, action, comment }
//   GET  /workflows/runs?id=<id>        历史运行
//   GET/POST /workflows/bindings        agent 绑定 + 信任清单
//   GET/POST /workflows/bindings        agent 绑定 + 信任清单
//
// 运行是**异步**的（2026-09-12）：POST /workflows/run 只做提交（立即回 { runId, status:'running' }），
// 过程经 WS `workflow_event` 推送，终态用 GET /workflows/run-status?runId= 兜底查询。
//
// 风格沿 authApi/config.ts 既有写法（@ alias + getBridgeUrl + fetch）：
// 错误统一**结构化返回**（{ ok:false, error }），不 throw 到调用方——路由的 400/500 都要能在
// 面板里显示成一行提示（与 usageApi 的 throw 风格并存：这里调用点都在交互回调里，需就地展示）。
import { getBridgeUrl } from '@/lib/config'
import { getOrCreateWS } from '@/hooks/useYFWCLI'
import type { WorkflowModel, LocalValidation } from '@/lib/workflowModel'

const TIMEOUT_MS = 20_000
const SAVE_TIMEOUT_MS = 40_000   // 保存/校验走内核会话，冷启动首帧可能拉起子进程
/** 运行**提交**超时（异步化后只等"已受理"，宿主 startRun 毫秒级；30s 覆盖宿主冷启动）。
 *  注意：这不是运行时长上限——运行在后台继续，终态以事件流/run-status 为准。 */
const RUN_SUBMIT_TIMEOUT_MS = 30_000

/** 列表项（store.listWorkflowMetas 的形态，字段名照抄，勿自创） */
export interface WorkflowMeta {
  id: string
  name?: string
  description?: string
  version?: string
  triggers?: string[]
  expose?: { mode?: string; tool_name?: string; bind_agents?: string[] }
  nodeCount?: number
  edgeCount?: number
  legacy?: boolean
  hasEnd?: boolean
  settings?: { max_parallel?: number }
  valid?: boolean
  updatedAt?: number
  lastRun?: { at: string; status: string; nodes: number } | null
  /**
   * 【S3 团队协同】归属工作区（内核 `server/workflow-store.mjs` 的 `listWorkflowMetas` 早已返回；
   * 缺失时是**空串**——`grab()` 的既有约定，不伪造默认值）。
   *
   * 用途：侧边栏默认列表（工作流卡片网格）的**模式筛选**（spec §5.9「受模式影响」一栏），
   * 判据用 `teamModeUi.filterWorkflowsByMode`（空串/缺字段按'personal'归类）。
   * ⚠️ 当前**尚未接线**（接线点在 `WorkflowsPanel`/`WorkflowList`，那两份文件正被另一条
   * 并行 lane 修改，本任务按约束未触碰）——字段先补齐，接线是"import + 过滤一行"。
   */
  workspaceId?: string
}

export interface RunRecord { file?: string; runId?: string; status?: string; steps?: number; at?: number; [k: string]: unknown }

export interface WorkflowBindings { agents: Record<string, string[]>; trusted: string[] }

/** 统一返回：路由的 4xx/5xx 都归一成 { ok:false, error }，调用方只判 ok。
 *  `unknown` 仅为 run-status 的语义标记：查不到该 runId（宿主重启/超出缓存/非法），
 *  与"网络/服务失败"必须区分——前者要停止轮询，后者要继续重试。 */
export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string; errors?: LocalValidation['errors']; unknown?: boolean }

interface CallOpts { method?: string; body?: unknown; timeoutMs?: number }

async function call<T>(path: string, { method = 'GET', body, timeoutMs = TIMEOUT_MS }: CallOpts = {}): Promise<ApiResult<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${getBridgeUrl()}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    const data = await res.json().catch(() => ({} as any))
    if (!res.ok) {
      // 内核校验失败会带 errors 明细（保存 400），原样透出供画布高亮
      const errs = Array.isArray(data?.errors) ? data.errors : undefined
      return { ok: false, error: String(data?.error || `HTTP ${res.status}`), ...(errs ? { errors: errs } : {}) }
    }
    if (data && data.ok === false) return { ok: false, error: String(data.error || '操作失败'), ...(Array.isArray(data.errors) ? { errors: data.errors } : {}), ...(data.unknown ? { unknown: true as const } : {}) }
    return (data ?? {}) as ApiResult<T>
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : (e?.message || String(e))
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

const enc = (id: string) => encodeURIComponent(id)

// —— 列表 / 读取 / 保存 / 删除 ——

export function listWorkflows(): Promise<ApiResult<{ workflows: WorkflowMeta[]; root: string }>> {
  return call('/workflows')
}

/** 读取工作流：内核 load 回执 = { ok, id, model, yml, validation }，model 可直接落画布 */
export function loadWorkflow(id: string): Promise<ApiResult<{ id: string; model: WorkflowModel; yml: string; validation?: LocalValidation }>> {
  return call(`/workflows/${enc(id)}`, { timeoutMs: SAVE_TIMEOUT_MS })
}

/** 保存（画布 model → 内核序列化 → 存储层落盘 + 版本快照） */
export function saveWorkflow(id: string, model: WorkflowModel): Promise<ApiResult<{ id: string; yml?: string; validation?: LocalValidation }>> {
  return call(`/workflows/${enc(id)}`, { method: 'PUT', body: { model }, timeoutMs: SAVE_TIMEOUT_MS })
}

/** 新建：POST /workflows 需显式 id（路由 400 缺 id） */
export function createWorkflow(id: string, model: WorkflowModel): Promise<ApiResult<{ id: string }>> {
  return call('/workflows', { method: 'POST', body: { id, model }, timeoutMs: SAVE_TIMEOUT_MS })
}

/** 以 YAML 原文保存（工具栏「YAML 切换」用；内核 save-raw 保留用户排版/注释） */
export function saveWorkflowYaml(id: string, yaml: string): Promise<ApiResult<{ id: string; yml?: string; validation?: LocalValidation }>> {
  return call(`/workflows/${enc(id)}`, { method: 'PUT', body: { yaml }, timeoutMs: SAVE_TIMEOUT_MS })
}

export function deleteWorkflow(id: string): Promise<ApiResult<Record<string, unknown>>> {
  return call(`/workflows/${enc(id)}`, { method: 'DELETE' })
}

export function duplicateWorkflow(id: string, toId: string): Promise<ApiResult<Record<string, unknown>>> {
  return call(`/workflows/${enc(id)}/duplicate`, { method: 'POST', body: { toId } })
}

/** 内核权威校验（本地 validateLocal 仅快速反馈，正式判定用这个） */
export function validateWorkflow(id: string): Promise<ApiResult<LocalValidation>> {
  return call(`/workflows/${enc(id)}/validate`, { timeoutMs: SAVE_TIMEOUT_MS })
}

export function listVersions(id: string): Promise<ApiResult<{ versions: Array<{ ts: string; size?: number }> }>> {
  return call(`/workflows/${enc(id)}/versions`)
}

export function rollbackWorkflow(id: string, ts: string): Promise<ApiResult<Record<string, unknown>>> {
  return call(`/workflows/${enc(id)}/rollback`, { method: 'POST', body: { ts }, timeoutMs: SAVE_TIMEOUT_MS })
}

export function exportWorkflow(id: string): Promise<ApiResult<{ bundle: unknown }>> {
  return call(`/workflows/${enc(id)}/export`, { timeoutMs: SAVE_TIMEOUT_MS })
}

export function importWorkflow(bundle: unknown, id?: string): Promise<ApiResult<{ id?: string }>> {
  return call('/workflows/import', { method: 'POST', body: { bundle, ...(id ? { id } : {}) }, timeoutMs: SAVE_TIMEOUT_MS })
}

// —— 运行 / 停止 / 确认 / 历史 ——

/**
 * 运行（**异步提交**）。capabilities **必传**（路由缺则 400）：由 deriveCapabilities(model)
 * 得出后再经 AuthzDialog 由用户逐项确认——本函数不做授权决策，只负责把已确认清单送达宿主。
 *
 * 语义（2026-09-12 改）：**只提交，不等运行结束**——立即回 `{ runId, status:'running' }`。
 * 原实现是同步等待内核跑完才回执（spec-dev 实测 80–110 秒），等待期界面零反馈 →
 * 用户重复点击 → 同一工作流并行多份重跑（实测 20 秒内 3 份）。
 *
 * `runId` **应由调用方预先生成并在调用前认领**（`runIdRef.current = runId`）：
 * 异步提交后宿主回执到达前，内核已经开始发事件（含 start 节点与 confirm_request），
 * 而事件归属是用 runId 判定的——等回执才认领会丢掉最早的事件，表现为抽屉里没有首个节点、
 * 审批卡不弹出。宿主对非法格式会自行改用随机 id（调用方需用回执里的 runId 兜底）。
 *
 * 调用方其余职责：
 *   · 过程靠 `subscribeWorkflowEvents`（start/node/edge_taken/end）；
 *   · 终态靠 `getRunStatus(runId)` 兜底（丢事件/WS 重连不至于永远停在运行中）。
 */
export interface RunSubmit {
  runId: string
  status?: string
  started?: boolean
}

/** 前端生成 runId（格式须与宿主 RUN_ID_OK 一致：^[A-Za-z0-9_-]{1,64}$） */
export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function runWorkflow(id: string, inputs: Record<string, unknown>, capabilities: { tools: string[]; write_dirs: string[]; network: boolean }, runId?: string): Promise<ApiResult<RunSubmit>> {
  return call('/workflows/run', { method: 'POST', body: { id, inputs, capabilities, ...(runId ? { runId } : {}) }, timeoutMs: RUN_SUBMIT_TIMEOUT_MS })
}

/** 运行态查询回执：未结束 `finished:false`；已结束带完整结果；`unknown` = 查不到（宿主重启/超出缓存）。 */
export interface RunStatusResult {
  runId: string
  finished?: boolean
  status?: string
  steps?: number
  /** 节点 id → { ok, output, skipped, error } */
  outputs?: Record<string, { ok?: boolean; output?: unknown; skipped?: boolean; error?: string }>
  finalOutput?: Record<string, unknown>
  /** 取值失败的返回值（selector 解析不到值 → 该键为 null），见内核 synthesizeOutput */
  unresolved?: string[]
  error?: string
  auditPath?: string
  unknown?: boolean
}

/** 运行状态/终态查询（异步运行的兜底通道；与 /workflows/runs 同风格的只读路由） */
export function getRunStatus(runId: string): Promise<ApiResult<RunStatusResult>> {
  return call(`/workflows/run-status?runId=${enc(runId)}`)
}

export function stopRun(runId: string): Promise<ApiResult<Record<string, unknown>>> {
  return call('/workflows/stop', { method: 'POST', body: { runId } })
}

export function confirmNode(payload: { runId: string; node: string; action?: 'approved' | 'rejected' | 'timeout'; comment?: string }): Promise<ApiResult<Record<string, unknown>>> {
  return call('/workflows/confirm', { method: 'POST', body: payload })
}

export function listRuns(id: string): Promise<ApiResult<{ runs: RunRecord[] }>> {
  return call(`/workflows/runs?id=${enc(id)}`)
}

/** 审计完整性校验（内核 verifyRun：逐行复算哈希链）。审计文件不存在/被篡改 → { ok:false, error } */
export function verifyRun(auditPath: string): Promise<ApiResult<{ lines?: number; lastHash?: string }>> {
  return call(`/workflows/verify?path=${enc(auditPath)}`, { timeoutMs: SAVE_TIMEOUT_MS })
}

/** 单次运行的审计步骤（历史瀑布用）：审计 jsonl 每行 = 一个 settled 节点
 *  { ts, node, type, status:'done'|'failed'|'skipped', dur_ms, out_hash, prev }。
 *  复用 bridge 既有 /read-file（≤512KB），只读不写。 */
export interface RunStepRecord { ts?: string; node: string; type?: string; status?: string; dur_ms?: number; out_hash?: string }

export async function loadRunSteps(auditPath: string): Promise<ApiResult<{ steps: RunStepRecord[] }>> {
  if (!auditPath) return { ok: false, error: '缺少审计文件路径' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${getBridgeUrl()}/read-file?path=${enc(auditPath)}`, { signal: controller.signal })
    const data = await res.json().catch(() => ({} as any))
    if (!res.ok) return { ok: false, error: String(data?.error || `HTTP ${res.status}`) }
    const steps: RunStepRecord[] = []
    for (const line of String(data?.content || '').split('\n')) {
      if (!line.trim()) continue
      try { steps.push(JSON.parse(line)) } catch { /** 末行截断等脏行跳过，不让整份瀑布失败 */ }
    }
    return { ok: true, steps }
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? '读取审计文件超时' : (e?.message || String(e)) }
  } finally {
    clearTimeout(timer)
  }
}

// —— WS 事件订阅（运行态着色 / 抽屉的唯一事件源） ——

/**
 * 工作流运行事件订阅。桥接侧统一广播为
 * `{ type:'workflow_event', sessionId:'_wfhost'|会话id, event }`，`event.type ∈
 * start|node|node_skipped|edge_taken|end`（另有 confirm 节点的 `confirm_request` /
 * `confirm_resolved`，见 kernel/workflow-nodes.execConfirm）。
 *
 * **不自建连接**：复用既有桥接 WS（useYFWCLI.getOrCreateWS，自带心跳/指数退避重连），
 * 只在同一 socket 上挂 message 监听——与内核流式事件的 onmessage 分发并存，互不干扰。
 * 断线时 useYFWCLI 会重建新 socket，旧实例上的监听随之失效，故此处轮询重挂（1.5s，
 * 仅在有订阅者时运行）。返回值即取消订阅函数。
 */
const wfEventListeners = new Set<(ev: any) => void>()
let wfSocket: WebSocket | null = null
let wfRebindTimer: ReturnType<typeof setInterval> | null = null

function onWfSocketMessage(raw: MessageEvent) {
  let msg: any
  try { msg = JSON.parse(String((raw as any)?.data ?? '')) } catch { return }
  if (!msg || msg.type !== 'workflow_event') return
  const ev = msg.event
  if (!ev || typeof ev !== 'object') return
  for (const fn of [...wfEventListeners]) {
    // 单个订阅者抛错不拖垮其余订阅者与 WS 分发
    try { fn(ev) } catch (e) { console.error('[workflow] event handler error:', e) }
  }
}

function rebindWfSocket() {
  const sock = getOrCreateWS()
  if (!sock || sock === wfSocket) return
  if (wfSocket) { try { wfSocket.removeEventListener('message', onWfSocketMessage) } catch { /* 旧 socket 可能已销毁 */ } }
  wfSocket = sock
  sock.addEventListener('message', onWfSocketMessage)
}

export function subscribeWorkflowEvents(handler: (ev: any) => void): () => void {
  wfEventListeners.add(handler)
  rebindWfSocket()
  if (!wfRebindTimer) wfRebindTimer = setInterval(rebindWfSocket, 1500)
  return () => {
    wfEventListeners.delete(handler)
    if (wfEventListeners.size === 0) {
      if (wfRebindTimer) { clearInterval(wfRebindTimer); wfRebindTimer = null }
      if (wfSocket) { try { wfSocket.removeEventListener('message', onWfSocketMessage) } catch { /* 同上 */ } }
      wfSocket = null
    }
  }
}

// —— 绑定 / 信任 ——

export function getBindings(): Promise<ApiResult<WorkflowBindings>> {
  return call('/workflows/bindings')
}

export function setBindings(bindings: WorkflowBindings): Promise<ApiResult<Record<string, unknown>>> {
  // 必须是 PUT：路由对 /workflows/bindings 只接受 GET/PUT，其余回 405（2026-09-12 修正——
  // 此前用 POST，一旦被调用就是 405；setWorkflowTrusted 走 PUT 故未暴露）。
  return call('/workflows/bindings', { method: 'PUT', body: bindings })
}

/** 授权卡「信任此工作流」开关：读-改-写绑定文件的 trusted 集合（agents 原样保留）。
 *  信任只免除运行前的交互打断（下次运行仍会弹出授权卡但默认放行），**不豁免审计**。 */
export async function setWorkflowTrusted(id: string, trusted: boolean): Promise<ApiResult<WorkflowBindings>> {
  const cur = await getBindings()
  if (!cur.ok) return { ok: false, error: cur.error }
  const set = new Set(cur.trusted || [])
  if (trusted) set.add(id)
  else set.delete(id)
  const next: WorkflowBindings = { agents: cur.agents || {}, trusted: [...set] }
  const r = await call<Record<string, unknown>>('/workflows/bindings', { method: 'PUT', body: next })
  return r.ok ? { ok: true, ...next } : { ok: false, error: r.error }
}

/** 列表项视觉态（列表行左侧色条/状态字用；空 lastRun 视为未运行） */
export function runStatusOf(meta: WorkflowMeta): 'never' | 'ok' | 'failed' | 'running' | 'cancelled' {
  const s = String(meta.lastRun?.status || '').toLowerCase()
  if (!s) return 'never'
  if (s === 'completed' || s === 'ok' || s === 'success') return 'ok'
  if (s === 'failed' || s === 'error') return 'failed'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'running') return 'running'
  return 'never'
}
