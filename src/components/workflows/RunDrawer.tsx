// src/components/workflows/RunDrawer.tsx —— 运行抽屉（UI Task 14，brief Step 2）
//
// 两个 Tab：
//   A 实时运行：节点状态着色（nodeStatus）、当前/选中节点输出预览、confirm 审批卡
//     （POST /workflows/confirm {runId,node,action,comment}）、停止（POST /workflows/stop {runId}）。
//   B 历史记录：GET /workflows/runs?id=<id> 列表 → 单次步骤瀑布（审计 jsonl 每行 = 一个 settled
//     节点，经 bridge /read-file 只读加载）→ 「校验完整性」（GET /workflows/verify?path=…，
//     内核 verifyRun 逐行复算哈希链）。
//
// 事件 → UI 严格按契约（不自创字段）：
//   start            清空状态（nodeStatus 置空 = 全部 idle）、phase=running
//   node done        该节点 done + 输出预览
//   node failed      该节点 failed + 错误文本
//   node / node_skipped skipped  该节点 skipped（灰）
//   edge_taken       active=实线加亮 / skipped=虚线淡化；active 边的目标节点标 running
//   end              phase=completed|failed|cancelled + 步数；历史列表刷新
//   另有 confirm 节点的 confirm_request / confirm_resolved（kernel/workflow-nodes.execConfirm）
//   → 审批卡显隐（表里未列，但审批卡必须有真实触发源，字段照内核）。
//
// 归约是纯函数（`reduceRunEvents`），面板与抽屉共用同一份，**不重复实现**着色语义。
import { useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, History, RefreshCw, ShieldCheck, Square, X } from 'lucide-react'
import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui'
import { cn } from '@/lib/utils'
import { listRuns, loadRunSteps, verifyRun, type RunRecord, type RunStepRecord } from '@/lib/workflowApi'
import type { NodeRunStatus } from '@/lib/workflowModel'

// ===================== 事件模型 + 纯归约 =====================

/** 桥接广播的 workflow_event.event（字段照内核发出口径，勿自创） */
export interface WorkflowRunEvent {
  type: string
  runId?: string
  node?: string
  node_type?: string
  status?: string
  dur_ms?: number
  output?: unknown
  error?: string
  route?: string
  edge?: string
  state?: string
  steps?: number
  message?: string
  timeout_ms?: number
  action?: string
  comment?: string
  [k: string]: unknown
}

export type RunPhase = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunStep {
  node: string
  nodeType?: string
  status: 'done' | 'failed' | 'skipped'
  durMs?: number
  output?: unknown
  error?: string
  route?: string
}

export interface RunView {
  phase: RunPhase
  /** 按到达顺序（子图迭代会多次出现同一节点） */
  steps: RunStep[]
  /** end 事件回报的步数（权威计数；steps 为本地累计） */
  stepCount: number
  nodeStatus: Record<string, NodeRunStatus>
  edgeState: Record<string, 'active' | 'skipped'>
  pending: { node: string; message: string; timeoutMs?: number } | null
  error: string
  started: boolean
}

export function emptyRunView(): RunView {
  return { phase: 'idle', steps: [], stepCount: 0, nodeStatus: {}, edgeState: {}, pending: null, error: '', started: false }
}

/**
 * 单事件归约（纯函数）。`edgeTargets`: 边 id → 目标节点，用于把 active 边的下游标 running
 * （内核不单独发 running 事件；目标节点在 settle 前由"入边被激活"确定）。
 */
export function applyRunEvent(s: RunView, ev: WorkflowRunEvent, edgeTargets: Record<string, string> = {}): RunView {
  const type = String(ev?.type || '')
  if (type === 'start') {
    // 清空状态：nodeStatus 空表 = 画布全部 idle（withRunState 对缺失键回退 'idle'）
    return { ...emptyRunView(), started: true, phase: 'running' }
  }
  if (type === 'node' || type === 'node_skipped') {
    const node = String(ev.node || '')
    if (!node) return s
    const raw = type === 'node_skipped' ? 'skipped' : String(ev.status || (ev.error ? 'failed' : 'done'))
    const status: RunStep['status'] = raw === 'failed' ? 'failed' : raw === 'skipped' ? 'skipped' : 'done'
    const nodeStatus = { ...s.nodeStatus, [node]: status as NodeRunStatus }
    // node(status:'skipped') 与 node_skipped 是同一笔账（内核双发）→ 去重
    const dup = status === 'skipped' && s.steps.some((x) => x.node === node && x.status === 'skipped')
    const step: RunStep = {
      node, status,
      ...(ev.node_type ? { nodeType: String(ev.node_type) } : {}),
      ...(typeof ev.dur_ms === 'number' ? { durMs: ev.dur_ms } : {}),
      ...(status === 'done' ? { output: ev.output } : {}),
      ...(status === 'failed' ? { error: String(ev.error ?? '') } : {}),
      ...(ev.route ? { route: String(ev.route) } : {}),
    }
    return {
      ...s,
      nodeStatus,
      steps: dup ? s.steps : [...s.steps, step],
      phase: s.phase === 'idle' ? 'running' : s.phase,
      ...(status === 'failed' ? { error: String(ev.error ?? s.error) } : {}),
    }
  }
  if (type === 'edge_taken') {
    const edge = String(ev.edge || '')
    if (!edge) return s
    const st: 'active' | 'skipped' = ev.state === 'active' ? 'active' : 'skipped'
    const next: RunView = { ...s, edgeState: { ...s.edgeState, [edge]: st } }
    const target = edgeTargets[edge]
    if (st === 'active' && target) {
      const cur = next.nodeStatus[target]
      if (!cur || cur === 'idle') next.nodeStatus = { ...next.nodeStatus, [target]: 'running' }
    }
    return next
  }
  if (type === 'confirm_request') {
    return { ...s, pending: { node: String(ev.node || ''), message: String(ev.message || '请确认'), ...(typeof ev.timeout_ms === 'number' ? { timeoutMs: ev.timeout_ms } : {}) } }
  }
  if (type === 'confirm_resolved') {
    if (s.pending && ev.node && String(ev.node) !== s.pending.node) return s
    return { ...s, pending: null }
  }
  if (type === 'end') {
    const st = String(ev.status || 'completed')
    const phase: RunPhase = st === 'failed' ? 'failed' : st === 'cancelled' || st === 'canceled' ? 'cancelled' : 'completed'
    return {
      ...s, phase, pending: null,
      stepCount: typeof ev.steps === 'number' ? ev.steps : s.steps.length,
      ...(ev.error ? { error: String(ev.error) } : {}),
    }
  }
  return s
}

/** 批量归约（面板与抽屉共用：`useMemo(() => reduceRunEvents(events, edgeTargets), …)`） */
export function reduceRunEvents(events: readonly WorkflowRunEvent[], edgeTargets: Record<string, string> = {}): RunView {
  let s = emptyRunView()
  for (const ev of events) s = applyRunEvent(s, ev, edgeTargets)
  return s
}

/** 相态中文名（面板顶部徽标与抽屉共用，避免两处文案漂移） */
export const RUN_PHASE_TEXT: Record<RunPhase, string> = { idle: '未开始', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已停止' }
const PHASE_TONE: Record<RunPhase, string> = {
  idle: 'text-tertiary', running: 'text-brand-500', completed: 'text-success', failed: 'text-error', cancelled: 'text-warning',
}
const STEP_TONE: Record<RunStep['status'], string> = { done: 'text-success', failed: 'text-error', skipped: 'text-tertiary' }
const STEP_DOT: Record<RunStep['status'], string> = { done: 'bg-success', failed: 'bg-error', skipped: 'bg-tertiary/50' }

function preview(v: unknown): string {
  if (v === undefined) return '（无输出）'
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

// ===================== 抽屉 =====================

export interface RunDrawerProps {
  open: boolean
  runId: string | null
  /** 历史记录 Tab 的查询键（GET /workflows/runs?id=） */
  workflowId: string
  workflowName?: string
  /** 原始事件流（省略 `view` 时抽屉自行归约；面板已增量归约，直接传 view 免重复计算） */
  events?: readonly WorkflowRunEvent[]
  /** 面板维护的归约结果（唯一着色真相；与画布 nodeStatus/edgeState 同源） */
  view?: RunView
  /** 边 id → 目标节点（画布 model 提供；仅在抽屉自行归约时用到） */
  edgeTargets?: Record<string, string>
  onStop: (runId: string) => void
  onConfirm: (p: { runId: string; node: string; action: 'approved' | 'rejected'; comment?: string }) => void
  onClose: () => void
}

export function RunDrawer({ open, runId, workflowId, workflowName, events = [], view: viewProp, edgeTargets = {}, onStop, onConfirm, onClose }: RunDrawerProps) {
  const [tab, setTab] = useState('run')
  const derived = useMemo(() => (viewProp ? viewProp : reduceRunEvents(events, edgeTargets)), [viewProp, events, edgeTargets])
  const view = derived
  const [selected, setSelected] = useState<string | null>(null)

  const runs = useRuns(open && !!runId, workflowId, view.phase)
  const hist = useHistorySteps(open && !!runId && tab === 'history')

  const shown = view.steps.find((x) => x.node === selected && x.status !== 'skipped') || [...view.steps].reverse().find((x) => x.status === 'done') || null
  const steps = view.stepCount || view.steps.length

  if (!open || !runId) return null

  return (
    <div className="fixed right-0 top-0 bottom-0 z-40 w-[420px] max-w-[94vw] bg-app border-l flex flex-col">
      <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0">
        <Activity className={cn('w-4 h-4', PHASE_TONE[view.phase])} />
        <span className="text-sm font-medium text-primary truncate flex-1">运行 · {workflowName || workflowId}</span>
        <span className={cn('text-[11px]', PHASE_TONE[view.phase])}>{RUN_PHASE_TEXT[view.phase]}</span>
        <span className="text-[10px] text-tertiary font-mono">{steps} 步</span>
        <button onClick={onClose} className="text-tertiary hover:text-primary" title="关闭抽屉（运行不受影响）"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="px-3 py-1 border-b text-[10px] text-tertiary font-mono truncate">{runId}</div>

      <Tabs value={tab} onValueChange={setTab} className="flex-1 min-h-0 flex flex-col px-3 py-2">
        <TabsList className="self-start">
          <TabsTrigger value="run" className="text-xs">实时运行</TabsTrigger>
          <TabsTrigger value="history" className="text-xs">历史记录</TabsTrigger>
        </TabsList>

        <TabsContent value="run" className="flex-1 min-h-0 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {/* 终态才禁用：start 事件到达前（phase=idle）也应允许停止——刚启动就想停是最常见的操作 */}
            <Button size="xs" variant="danger" disabled={view.phase === 'completed' || view.phase === 'failed' || view.phase === 'cancelled'} onClick={() => onStop(runId)}>
              <Square className="w-3 h-3" />停止
            </Button>
            <span className="text-[10px] text-tertiary">停止 = POST /workflows/stop，等待内核在下一检查点结束并回 end(cancelled)</span>
          </div>

          {view.error && <div className="text-[11px] text-error break-all">{view.error}</div>}

          {view.pending && (
            <ConfirmCard
              node={view.pending.node}
              message={view.pending.message}
              timeoutMs={view.pending.timeoutMs}
              onDecide={(action, comment) => onConfirm({ runId, node: view.pending!.node, action, comment })}
            />
          )}

          <div className="min-h-0 flex flex-col">
            <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider mb-1">
              步骤（{view.steps.length}{view.stepCount ? ` / ${view.stepCount}` : ''}）
            </div>
            <div className="overflow-auto max-h-[30vh] flex flex-col gap-0.5">
              {view.steps.length === 0 && <span className="text-[10px] text-tertiary">等待事件（start → node → end）…</span>}
              {view.steps.map((s, i) => (
                <button
                  key={`${s.node}:${i}`}
                  onClick={() => setSelected(s.node)}
                  className={cn('flex items-center gap-2 text-[11px] text-left px-1 py-0.5 rounded hover:bg-hover', selected === s.node && 'bg-active')}
                >
                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STEP_DOT[s.status])} />
                  <span className={cn('font-mono truncate flex-1', STEP_TONE[s.status], s.status === 'skipped' && 'opacity-60')}>{s.node}</span>
                  <span className="text-[10px] text-tertiary">{s.nodeType || ''}</span>
                  <span className="text-[10px] text-tertiary font-mono">{s.durMs !== undefined ? `${s.durMs}ms` : ''}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider mb-1">
              输出预览 {shown ? `· ${shown.node}` : ''}
            </div>
            <pre className="flex-1 min-h-[80px] overflow-auto text-[10px] font-mono whitespace-pre-wrap break-all bg-elevated rounded p-2">
              {shown ? (shown.status === 'failed' ? shown.error : preview(shown.output)) : '（尚未有节点完成）'}
            </pre>
          </div>
        </TabsContent>

        <TabsContent value="history" className="flex-1 min-h-0 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button size="xs" variant="secondary" onClick={() => void runs.reload()}><RefreshCw className="w-3 h-3" />刷新</Button>
            {runs.error && <span className="text-[10px] text-error truncate">{runs.error}</span>}
          </div>
          <div className="overflow-auto max-h-[26vh] flex flex-col gap-0.5">
            {runs.records.length === 0 && <span className="text-[10px] text-tertiary">暂无运行记录</span>}
            {runs.records.map((r) => (
              <div key={String(r.path || r.file || '')} className={cn('flex items-center gap-2 text-[11px] px-1 py-0.5 rounded', hist.selected === r.path && 'bg-active')}>
                <span className="font-mono text-secondary truncate flex-1">{String(r.ts || r.file || '')}</span>
                <span className={cn('text-[10px]', r.status === 'completed' ? 'text-success' : r.status === 'failed' ? 'text-error' : 'text-tertiary')}>{String(r.status || '')}</span>
                <span className="text-[10px] text-tertiary">{String(r.steps ?? '')} 步</span>
                <Button size="xs" variant="ghost" onClick={() => void hist.pick(r)}><History className="w-3 h-3" />瀑布</Button>
              </div>
            ))}
          </div>

          {hist.selected && (
            <div className="flex-1 min-h-0 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-tertiary uppercase tracking-wider flex-1">步骤瀑布</span>
                <Button size="xs" variant="secondary" onClick={() => void hist.verify()} disabled={hist.verifying}>
                  <ShieldCheck className="w-3 h-3" />校验完整性
                </Button>
              </div>
              {hist.verifyMsg && (
                <div className={cn('text-[10px]', hist.verifyOk === true ? 'text-success' : hist.verifyOk === false ? 'text-error' : 'text-tertiary')}>{hist.verifyMsg}</div>
              )}
              {hist.error && <div className="text-[10px] text-error">{hist.error}</div>}
              <Waterfall steps={hist.steps} />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** 审批卡（confirm 节点的 confirm_request 触发；回执 POST /workflows/confirm） */
function ConfirmCard({ node, message, timeoutMs, onDecide }: {
  node: string
  message: string
  timeoutMs?: number
  onDecide: (action: 'approved' | 'rejected', comment: string) => void
}) {
  const [comment, setComment] = useState('')
  return (
    <div className="border border-warning/40 bg-warning/10 rounded p-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-warning">
        <CheckCircle2 className="w-3.5 h-3.5" />等待人工审批 · <span className="font-mono">{node}</span>
        {timeoutMs ? <span className="text-[10px] text-tertiary">超时 {Math.round(timeoutMs / 1000)}s 后走 timeout 分支</span> : null}
      </div>
      <div className="text-[11px] text-secondary whitespace-pre-wrap break-words">{message}</div>
      <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="审批意见（可空）" className="h-7 text-xs" />
      <div className="flex items-center gap-2">
        <Button size="xs" variant="success" onClick={() => onDecide('approved', comment)}>通过</Button>
        <Button size="xs" variant="danger" onClick={() => onDecide('rejected', comment)}>拒绝</Button>
      </div>
    </div>
  )
}

/** 步骤瀑布：审计行 dur_ms 占比（子图迭代的重复节点各占一行） */
function Waterfall({ steps }: { steps: RunStepRecord[] }) {
  if (!steps.length) return <span className="text-[10px] text-tertiary">（审计文件为空或未加载）</span>
  const max = Math.max(...steps.map((s) => Number(s.dur_ms) || 0), 1)
  return (
    <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-0.5">
      {steps.map((s, i) => {
        const dur = Number(s.dur_ms) || 0
        const st = String(s.status || 'done')
        return (
          <div key={`${s.node}:${i}`} className="flex items-center gap-1.5 text-[10px]">
            <span className="font-mono text-secondary w-[92px] shrink-0 truncate" title={`${s.node} (${s.type || ''})`}>{s.node}</span>
            <span className="flex-1 h-2 bg-elevated rounded overflow-hidden">
              <span className={cn('block h-full rounded', st === 'failed' ? 'bg-error/60' : st === 'skipped' ? 'bg-tertiary/40' : 'bg-brand-500/60')}
                style={{ width: `${Math.max(2, Math.round((dur / max) * 100))}%` }} />
            </span>
            <span className="text-tertiary font-mono w-[52px] text-right shrink-0">{dur}ms</span>
            <span className={cn('w-[46px] shrink-0', st === 'failed' ? 'text-error' : st === 'skipped' ? 'text-tertiary' : 'text-success')}>{st}</span>
          </div>
        )
      })}
    </div>
  )
}

// ===================== 数据钩子 =====================

/** 历史列表：抽屉打开/工作流切换/运行结束时拉取 */
function useRuns(active: boolean, workflowId: string, phase: RunPhase) {
  const [records, setRecords] = useState<RunRecord[]>([])
  const [error, setError] = useState('')
  const reload = async () => {
    if (!workflowId) { setRecords([]); return }
    const r = await listRuns(workflowId)
    if (r.ok) { setRecords(r.runs || []); setError('') } else setError(r.error)
  }
  useEffect(() => {
    if (!active) return
    void reload()
    // phase 变化（含 run 结束 → completed/failed/cancelled）时刷新，对应 brief「end → 刷新历史列表」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workflowId, phase])
  return { records, error, reload }
}

/** 选中运行的审计步骤 + 完整性校验（§ Step B） */
function useHistorySteps(active: boolean) {
  const [selected, setSelected] = useState<string | null>(null)
  const [steps, setSteps] = useState<RunStepRecord[]>([])
  const [error, setError] = useState('')
  const [verifyMsg, setVerifyMsg] = useState('')
  const [verifyOk, setVerifyOk] = useState<boolean | null>(null)
  const [verifying, setVerifying] = useState(false)

  useEffect(() => { if (!active) { setSelected(null); setSteps([]); setError(''); setVerifyMsg(''); setVerifyOk(null) } }, [active])

  const pick = async (r: RunRecord) => {
    const path = String(r.path || '')
    setSelected(path)
    setSteps([])
    setError('')
    setVerifyMsg('')
    setVerifyOk(null)
    if (!path) { setError('该运行记录缺少审计文件路径'); return }
    const res = await loadRunSteps(path)
    if (res.ok) setSteps(res.steps || [])
    else setError(`审计文件读取失败：${res.error}`)
  }

  const verify = async () => {
    if (!selected) return
    setVerifying(true)
    const r = await verifyRun(selected)
    setVerifying(false)
    setVerifyOk(!!r.ok)
    setVerifyMsg(r.ok ? `完整性 ok：哈希链连续，${r.lines ?? 0} 行` : `校验失败：${r.error}`)
  }

  return { selected, steps, error, verifyMsg, verifyOk, verifying, pick, verify }
}
