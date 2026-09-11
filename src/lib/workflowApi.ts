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
//   POST /workflows/run                 **必带 capabilities**（缺 → 400）
//   POST /workflows/stop                { runId }
//   POST /workflows/confirm             { runId, node, action, comment }
//   GET  /workflows/runs?id=<id>        历史运行
//   GET/POST /workflows/bindings        agent 绑定 + 信任清单
//
// 风格沿 authApi/config.ts 既有写法（@ alias + getBridgeUrl + fetch）：
// 错误统一**结构化返回**（{ ok:false, error }），不 throw 到调用方——路由的 400/500 都要能在
// 面板里显示成一行提示（与 usageApi 的 throw 风格并存：这里调用点都在交互回调里，需就地展示）。
import { getBridgeUrl } from '@/lib/config'
import type { WorkflowModel, LocalValidation } from '@/lib/workflowModel'

const TIMEOUT_MS = 20_000
const SAVE_TIMEOUT_MS = 40_000   // 保存/校验走内核会话，冷启动首帧可能拉起子进程
const RUN_TIMEOUT_MS = 120_000

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
}

export interface RunRecord { file?: string; runId?: string; status?: string; steps?: number; at?: number; [k: string]: unknown }

export interface WorkflowBindings { agents: Record<string, string[]>; trusted: string[] }

/** 统一返回：路由的 4xx/5xx 都归一成 { ok:false, error }，调用方只判 ok */
export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string; errors?: LocalValidation['errors'] }

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
    if (data && data.ok === false) return { ok: false, error: String(data.error || '操作失败'), ...(Array.isArray(data.errors) ? { errors: data.errors } : {}) }
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
 * 运行。capabilities **必传**（路由缺则 400）：由 deriveCapabilities(model) 得出后再经
 * AuthzDialog 由用户逐项确认——本函数不做授权决策，只负责把已确认清单送达宿主。
 */
export function runWorkflow(id: string, inputs: Record<string, unknown>, capabilities: { tools: string[]; write_dirs: string[]; network: boolean }): Promise<ApiResult<{ runId: string }>> {
  return call('/workflows/run', { method: 'POST', body: { id, inputs, capabilities }, timeoutMs: RUN_TIMEOUT_MS })
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

// —— 绑定 / 信任 ——

export function getBindings(): Promise<ApiResult<WorkflowBindings>> {
  return call('/workflows/bindings')
}

export function setBindings(bindings: WorkflowBindings): Promise<ApiResult<Record<string, unknown>>> {
  return call('/workflows/bindings', { method: 'POST', body: bindings })
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
