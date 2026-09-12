// src/components/workflows/WorkflowsPanel.tsx —— 第五 rail 面板（UI Task 13，spec §6 第 1-2 层）
//
// 三段式：列表 ⇄ 画布编辑器；工具栏 = 返回 / 保存 / 校验 / 运行 / YAML / 版本 / 导出。
// 单一真相：`model` 由本组件持有，画布节流回写（300ms）+ 保存前 flush（brief 风险③）。
//
// 运行链路（Task 13 交付到「授权清单确认」为止；**Task 14 已接手** RunDrawer/AuthzDialog）：
//   flush → deriveCapabilities(model) → AuthzDialog（逐项可勾除；勾除项 fail-closed）
//   → runWorkflow(id, inputs, capabilities) → runId 落到顶部徽标 + RunDrawer。
//   **Task 14 接线点**：
//     · 事件订阅 subscribeWorkflowEvents → 只留本次 runId 的事件（其它会话/子工作流丢弃），
//       逐条增量归约到 `runView`（RunDrawer.applyRunEvent，每事件 O(1)）；
//     · `runView.nodeStatus` / `runView.edgeState` 传给画布（withRunState 消费），
//       抽屉拿同一份 runView —— 面板、画布、抽屉共用一套着色语义，不重复实现；
//     · 顶部 runId 徽标 → 打开 <RunDrawer>；停止 / 审批回执（confirm 节点）都在抽屉里发起。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowLeft, Save, ShieldCheck, Play, Download, FileCode2, History, X } from 'lucide-react'
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  confirmNode, createWorkflow, deleteWorkflow, duplicateWorkflow, exportWorkflow, getRunStatus, importWorkflow,
  listRuns, listVersions, listWorkflows, loadWorkflow, newRunId, rollbackWorkflow,
  runWorkflow, saveWorkflow, saveWorkflowYaml, stopRun, subscribeWorkflowEvents, validateWorkflow,
  type RunRecord, type WorkflowMeta,
} from '@/lib/workflowApi'
import {
  checkWorkflowId, deriveCapabilities, describeDataFlow, emptyModel, suggestCopyId, summarizeLocal, validateLocal,
  type Capabilities, type ValidationIssue, type WorkflowModel,
} from '@/lib/workflowModel'
import { WorkflowCanvas, type WorkflowCanvasHandle } from './canvas/WorkflowCanvas'
import { WorkflowList } from './WorkflowList'
import { AuthzDialog } from './AuthzDialog'
import { RUN_PHASE_TEXT, RunDrawer, applyRunEvent, emptyRunView, isTerminalPhase, type RunView, type WorkflowRunEvent } from './RunDrawer'

export function WorkflowsPanel() {
  const [list, setList] = useState<WorkflowMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const [openId, setOpenId] = useState<string | null>(null)
  const [model, setModel] = useState<WorkflowModel | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [yml, setYml] = useState('')
  const [yamlOpen, setYamlOpen] = useState(false)
  const [yamlText, setYamlText] = useState('')
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState<Array<{ ts: string }>>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [backendIssues, setBackendIssues] = useState<ValidationIssue[]>([])
  /** 画布重挂载序号：重新加载同一 id（YAML 保存/版本回滚）时必须让画布丢弃旧 state */
  const [canvasEpoch, setCanvasEpoch] = useState(0)

  // —— 运行态（Task 14）——
  const [runId, setRunId] = useState<string | null>(null)
  /** 本次运行归属的工作流 id（历史 Tab 的查询键；列表态直接运行时 openId 为空） */
  const [runWfId, setRunWfId] = useState('')
  /** 本次运行的归约结果（nodeStatus/edgeState/steps/phase 的唯一真相，画布与抽屉共用） */
  const [runView, setRunView] = useState<RunView>(emptyRunView)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [runSetup, setRunSetup] = useState<{ id: string; model: WorkflowModel } | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [caps, setCaps] = useState<Capabilities>({ tools: [], write_dirs: [], network: false })
  /** 订阅回调里判归属用的当前 runId（回调只挂一次，不能读 state 闭包） */
  const runIdRef = useRef<string | null>(null)
  /** runView 最新值镜像（兜底轮询的定时器同样只挂一次，不能读 state 闭包） */
  const runViewRef = useRef<RunView>(emptyRunView())
  useEffect(() => { runViewRef.current = runView }, [runView])

  const canvasRef = useRef<WorkflowCanvasHandle | null>(null)

  /** 边 id → 目标节点：active 边的下游标 running（内核不发 running 事件） */
  const edgeTargets = useMemo(
    () => Object.fromEntries((model?.edges || []).map((e) => [e.id, e.target])),
    [model],
  )
  /** 事件回调只挂一次 → 用 ref 读最新边表（回调里读 state 会拿到首帧闭包） */
  const edgeTargetsRef = useRef(edgeTargets)
  useEffect(() => { edgeTargetsRef.current = edgeTargets }, [edgeTargets])

  const refreshList = useCallback(async () => {
    setLoading(true)
    const r = await listWorkflows()
    setLoading(false)
    if (r.ok) { setList(r.workflows || []); setError('') } else setError(r.error)
  }, [])

  useEffect(() => { void refreshList() }, [refreshList])

  // 运行事件订阅（复用既有桥接 WS；只认本次 runId 的事件，其它会话/子工作流事件一律丢弃）
  // 归约是**增量**的（每事件 O(1)），长循环工作流不会因事件累积而卡顿。
  useEffect(() => {
    const unsubscribe = subscribeWorkflowEvents((ev: WorkflowRunEvent) => {
      const cur = runIdRef.current
      if (!cur || !ev || ev.runId !== cur) return
      setRunView((v) => applyRunEvent(v, ev, edgeTargetsRef.current))
      if (ev.type === 'end') void refreshList()   // brief：end → 刷新历史列表（列表态 lastRun 同步）
    })
    return unsubscribe
  }, [refreshList])

  const openWorkflow = useCallback(async (id: string) => {
    const r = await loadWorkflow(id)
    if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
    setOpenId(id)
    setCanvasEpoch((e) => e + 1)
    setModel(r.model)
    setYml(r.yml || '')
    setYamlText(r.yml || '')
    setDirty(false)
    setBackendIssues([])
    setNotice(null)
    runIdRef.current = null
    setRunId(null)
    setRunWfId('')
    setRunView(emptyRunView())   // 切工作流丢弃上一轮着色（事件归属由 runIdRef 判定）
    setDrawerOpen(false)
  }, [])

  const create = useCallback(async (id: string) => {
    // 前端预校验（Task 12 审查 I-1）：非法 id 后端会抛 400「非法工作流 id」，此处就地拦下
    const chk = checkWorkflowId(id)
    if (!chk.ok) { setNotice({ tone: 'error', text: chk.error }); return }
    const r = await createWorkflow(id, emptyModel(id))
    if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
    await refreshList()
    await openWorkflow(id)
  }, [openWorkflow, refreshList])

  const remove = useCallback(async (id: string) => {
    const r = await deleteWorkflow(id)
    if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
    if (openId === id) { setOpenId(null); setModel(null) }
    await refreshList()
  }, [openId, refreshList])

  const duplicate = useCallback(async (id: string) => {
    // 新 id 由前端推导（`<id>-copy` 在 id 较长时会超 64 字符、撞名或落保留字 → 预校验拦下）
    const toId = suggestCopyId(id, list.map((m) => m.id))
    const chk = checkWorkflowId(toId)
    if (!chk.ok) { setNotice({ tone: 'error', text: chk.error }); return }
    const r = await duplicateWorkflow(id, toId)
    if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
    setNotice({ tone: 'ok', text: `已复制为 ${toId}` })
    await refreshList()
  }, [list, refreshList])

  const doExport = useCallback(async (id: string) => {
    const r = await exportWorkflow(id)
    if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
    const blob = new Blob([JSON.stringify(r.bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${id}.yfwflow`
    a.click()
    URL.revokeObjectURL(url)
    setNotice({ tone: 'ok', text: `已导出 ${id}.yfwflow` })
  }, [])

  const doImport = useCallback(async (bundle: unknown) => {
    const r = await importWorkflow(bundle)
    if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
    setNotice({ tone: 'ok', text: '导入完成' })
    await refreshList()
  }, [refreshList])

  const local = useMemo(() => (model ? summarizeLocal(validateLocal(model)) : null), [model])

  /** 保存：先 flush 画布（节流窗口内的最后一次编辑），再 PUT */
  const save = useCallback(async (): Promise<WorkflowModel | null> => {
    if (!openId) return null
    const latest = canvasRef.current?.flush() ?? model
    if (!latest) return null
    setSaving(true)
    const r = await saveWorkflow(openId, latest)
    setSaving(false)
    if (!r.ok) {
      setBackendIssues(r.errors || [])
      setNotice({ tone: 'error', text: `保存失败：${r.error}` })
      return null
    }
    setModel(latest)
    setDirty(false)
    setBackendIssues([])
    setNotice({ tone: 'ok', text: '已保存（内核校验通过）' })
    if (r.yml) { setYml(r.yml); setYamlText(r.yml) }
    return latest
  }, [model, openId])

  /** 校验：内核权威校验只认落盘内容 → 先保存再 GET validate */
  const doValidate = useCallback(async () => {
    if (!openId) return
    const saved = await save()
    if (!saved) return
    const r = await validateWorkflow(openId)
    if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
    setBackendIssues(r.errors || [])
    setNotice({
      tone: r.ok && (r.errors || []).length === 0 ? 'ok' : 'error',
      text: (r.errors || []).length === 0
        ? `内核校验通过（警告 ${(r.warnings || []).length} 项）`
        : `内核校验失败：${(r.errors || []).map((e) => e.code).join(', ')}`,
    })
  }, [openId, save])

  /** 运行：**先落盘再弹授权卡**（POST /workflows/run 由内核从磁盘 load，未保存就跑旧版本，
   *  且能力清单会与实跑图不一致）；保存失败 → 中止运行并提示，不静默继续。 */
  const openRunSetup = useCallback(async (id: string) => {
    let target: WorkflowModel | null = openId === id ? model : null   // 列表里跑别的 id：一律从磁盘 load
    if (openId === id) {
      if (dirty) {
        target = await save()   // save() 内部已 flush 画布并带内核校验
        if (!target) {
          setNotice({ tone: 'error', text: '运行已中止：画布改动未能保存（内核校验/写入失败，详情见上）' })
          return
        }
      } else {
        target = canvasRef.current?.flush() ?? model
      }
    }
    if (!target) {
      const r = await loadWorkflow(id)
      if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
      target = r.model
    }
    const derived = deriveCapabilities(target)
    setCaps(derived)
    setInputs(Object.fromEntries((target.inputs || []).map((i) => [i.name, ''])))
    setRunSetup({ id, model: target })
  }, [dirty, model, openId, save])

  /**
   * 授权卡确认 → **提交**运行（清单即用户在 AuthzDialog 里勾除后的能力，宿主按此 fail-closed 放行）。
   *
   * 2026-09-12 改造（「点击运行无反应」根因）：原实现 await runWorkflow 等整个运行结束
   * （spec-dev 实测 80–110 秒），等待期界面零反馈 + 失败只 setNotice（被 Dialog 遮罩挡住看不见）
   * → 用户重复点击 → 同一工作流并行多份重跑（实测 20 秒内 3 份）。
   * 现在：提交毫秒级返回 → 立即开抽屉并置 running；失败**返回给授权卡**就地显示（卡片不关）。
   */
  const startRun = useCallback(async (confirmed: Capabilities): Promise<{ ok: boolean; error?: string }> => {
    if (!runSetup) return { ok: false, error: '运行参数已失效，请重新点击运行' }
    const target = runSetup
    setCaps(confirmed)
    setRunView(emptyRunView())   // 清空上一轮着色（start 事件到达时同样会清空，此处先清避免残留）
    // **提交前认领 runId**：提交返回前内核就在发事件（start 节点/confirm_request），
    // 事件归属靠 runIdRef 判定——等回执才认领会把最早的事件全丢掉（2026-09-12 实测：
    // 抽屉里没有首个节点、审批卡不弹）。故这里预生成并先赋值。
    const want = newRunId()
    runIdRef.current = want
    const r = await runWorkflow(target.id, inputs, confirmed, want)
    if (!r.ok) {
      if (runIdRef.current === want) runIdRef.current = null   // 未启动成功：撤销认领
      return { ok: false, error: r.error }
    }
    const rid = String(r.runId || want)
    runIdRef.current = rid
    setRunId(rid)
    setRunWfId(target.id)
    setRunSetup(null)
    setDrawerOpen(true)
    // 提交即视为运行开始：不依赖首个 WS 事件（丢了就会停在"等待事件…"），终态由兜底轮询收敛。
    // 注意：若事件已先到（started/步骤已累积），保持现状——用 start 清空会把已到的节点抹掉。
    setRunView((v) => (v.started || v.steps.length > 0 || Object.keys(v.nodeStatus).length > 0 ? v : applyRunEvent(v, { type: 'start' })))
    setNotice({ tone: 'ok', text: `已提交运行：${rid}` })
    return { ok: true }
  }, [inputs, runSetup])

  /**
   * 终态兜底轮询：事件流是主通道，但 WS 丢事件/断连会让界面永远停在"运行中"（＝用户眼中
   * "点了没反应"）。运行期间每 3s 查一次 run-status，拿到终态就合成结束事件收敛视图。
   * 查询失败（网络抖动）不终止；unknown（宿主重启/超缓存）才停，并提示改看历史记录。
   */
  useEffect(() => {
    if (!runId || isTerminalPhase(runViewRef.current.phase)) return
    let stopped = false
    let polls = 0
    const MAX_POLLS = 600   // ≈30 分钟，与宿主 RUN_TIMEOUT 同量级
    const tick = async () => {
      if (stopped || ++polls > MAX_POLLS) { stopped = true; return }
      const r = await getRunStatus(runId)
      if (stopped) return
      if (!r.ok) {
        if (r.unknown) {
          stopped = true
          setNotice({ tone: 'error', text: `无法确认运行状态：${r.error}；请到「历史记录」查看该次运行` })
        }
        return   // 其它错误（网络抖动/宿主忙）继续下一轮
      }
      if (!r.finished) return
      stopped = true
      // 合成终态（已有更细的实时事件时不覆盖；未收到事件的节点在此补齐，避免"跑完了画布还是灰的"）
      setRunView((v) => {
        if (isTerminalPhase(v.phase)) return v
        let next = v
        for (const [node, rec] of Object.entries(r.outputs || {})) {
          if (next.nodeStatus[node]) continue
          next = applyRunEvent(next, {
            type: rec.skipped ? 'node_skipped' : 'node',
            node,
            status: rec.ok === false ? 'failed' : rec.skipped ? 'skipped' : 'done',
            output: rec.output,
            ...(rec.error ? { error: rec.error } : {}),
          })
        }
        return applyRunEvent(next, {
          type: 'end',
          status: String(r.status || 'completed'),
          steps: Number(r.steps || 0),
          ...(r.error ? { error: r.error } : {}),
          ...(r.unresolved?.length ? { unresolved: r.unresolved } : {}),
        })
      })
      if (r.unresolved?.length) {
        setNotice({ tone: 'error', text: `运行结束（${runId}）：${r.unresolved.length} 个返回值取不到值——${r.unresolved.join('、')}` })
      } else if (r.status && r.status !== 'completed') {
        setNotice({ tone: 'error', text: `运行结束（${runId}）：${r.status}${r.error ? ` — ${r.error}` : ''}` })
      }
      void refreshList()
    }
    const timer = setInterval(() => void tick(), 3000)
    return () => { stopped = true; clearInterval(timer) }
  }, [runId, runView.phase, refreshList])

  const doStop = useCallback(async (id: string) => {
    const r = await stopRun(id)
    setNotice(r.ok ? { tone: 'ok', text: '已请求停止（等待内核回 end(cancelled)）' } : { tone: 'error', text: r.error })
  }, [])

  /** 抽屉审批卡回执（POST /workflows/confirm {runId,node,action,comment}） */
  const doConfirm = useCallback(async (p: { runId: string; node: string; action: 'approved' | 'rejected'; comment?: string }) => {
    const r = await confirmNode(p)
    if (!r.ok) setNotice({ tone: 'error', text: `审批回执失败：${r.error}` })
  }, [])

  const openVersions = useCallback(async () => {
    if (!openId) return
    setVersionsOpen(true)
    const [v, r] = await Promise.all([listVersions(openId), listRuns(openId)])
    setVersions(v.ok ? (v.versions || []) : [])
    setRuns(r.ok ? (r.runs || []) : [])
  }, [openId])

  const saveYaml = useCallback(async () => {
    if (!openId) return
    const r = await saveWorkflowYaml(openId, yamlText)
    if (!r.ok) { setBackendIssues(r.errors || []); setNotice({ tone: 'error', text: `YAML 保存失败：${r.error}` }); return }
    setNotice({ tone: 'ok', text: 'YAML 已保存' })
    await openWorkflow(openId)
  }, [openId, openWorkflow, yamlText])

  // ===================== 运行抽屉 + 授权卡（两个态共用） =====================
  const runDrawer = (
    <RunDrawer
      open={drawerOpen}
      runId={runId}
      workflowId={runWfId || openId || runSetup?.id || ''}
      workflowName={model?.name}
      view={runView}
      edgeTargets={edgeTargets}
      onStop={(id) => void doStop(id)}
      onConfirm={(p) => void doConfirm(p)}
      onClose={() => setDrawerOpen(false)}
    />
  )

  const authzDialog = runSetup ? (
    <AuthzDialog
      id={runSetup.id}
      name={runSetup.model.name || runSetup.id}
      capabilities={caps}
      inputs={runSetup.model.inputs || []}
      values={inputs}
      onValuesChange={setInputs}
      outputs={describeDataFlow(runSetup.model).outputs}
      onConfirm={startRun}
      onCancel={() => setRunSetup(null)}
    />
  ) : null

  // ===================== 列表态 =====================
  if (!openId || !model) {
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}
        <WorkflowList
          list={list}
          loading={loading}
          error={error}
          onOpen={(id) => void openWorkflow(id)}
          onCreate={(id) => void create(id)}
          onRun={(id) => void openRunSetup(id)}
          onDuplicate={(id) => void duplicate(id)}
          onExport={(id) => void doExport(id)}
          onDelete={(id) => void remove(id)}
          onImport={(b) => void doImport(b)}
        />
        {authzDialog}
        {runDrawer}
      </div>
    )
  }

  // ===================== 编辑态 =====================
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* 工具栏（spec §6：保存 / 校验 / 运行 / 版本历史 / 导入导出 / YAML 双向切换） */}
      <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0">
        <Button size="xs" variant="ghost" onClick={() => { setOpenId(null); setModel(null); setDirty(false) }}>
          <ArrowLeft className="w-3.5 h-3.5" />列表
        </Button>
        <span className="text-sm font-medium text-primary truncate max-w-[220px]">{model.name || openId}</span>
        <span className="text-[10px] text-tertiary font-mono">{openId}</span>
        {dirty && <Badge variant="warning">未保存</Badge>}

        <div className="flex-1" />

        {local && (
          <span className={cn('text-[10px] truncate max-w-[280px]', local.level === 'error' ? 'text-error' : local.level === 'warn' ? 'text-warning' : 'text-tertiary')} title={local.text}>
            {local.text}
          </span>
        )}
        {runId && (
          <button
            onClick={() => setDrawerOpen((v) => !v)}
            className={cn('flex items-center gap-1 text-[10px]', drawerOpen ? 'text-brand-500' : 'text-tertiary hover:text-primary')}
            title="打开/收起运行抽屉（实时着色、输出、审批、停止、历史）"
          >
            <Activity className="w-3.5 h-3.5" />
            <span className={cn(runView.phase === 'running' ? 'text-brand-500' : runView.phase === 'failed' ? 'text-error' : runView.phase === 'cancelled' ? 'text-warning' : 'text-success')}>
              {RUN_PHASE_TEXT[runView.phase]}
            </span>
            <span className="font-mono">{runId.slice(0, 12)}</span>
          </button>
        )}

        <Button size="xs" variant="secondary" onClick={() => setYamlOpen((v) => !v)}><FileCode2 className="w-3.5 h-3.5" />YAML</Button>
        <Button size="xs" variant="secondary" onClick={() => void openVersions()}><History className="w-3.5 h-3.5" />版本</Button>
        <Button size="xs" variant="secondary" onClick={() => void doExport(openId)}><Download className="w-3.5 h-3.5" />导出</Button>
        <Button size="xs" variant="secondary" onClick={() => void doValidate()}><ShieldCheck className="w-3.5 h-3.5" />校验</Button>
        <Button size="xs" onClick={() => void save()} disabled={saving}><Save className="w-3.5 h-3.5" />{saving ? '保存中' : '保存'}</Button>
        <Button size="xs" variant="primary" onClick={() => void openRunSetup(openId)}><Play className="w-3.5 h-3.5" />运行</Button>
      </div>

      {(notice || backendIssues.length > 0) && (
        <div className="shrink-0">
          {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}
          {backendIssues.length > 0 && (
            <div className="px-3 py-1.5 border-b text-[11px] text-error flex flex-col gap-0.5">
              {backendIssues.slice(0, 6).map((e, i) => (
                <div key={i}><span className="font-mono">{e.code}</span> {e.message}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {yamlOpen ? (
        <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
          <div className="text-[11px] text-tertiary">
            YAML 与画布是同一份源：以 YAML 保存会**覆盖**画布改动；保存后画布重新从落盘内容加载。
          </div>
          <Textarea value={yamlText} onChange={(e) => setYamlText(e.target.value)} rows={20} className="flex-1 text-[11px] font-mono" />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void saveYaml()}>以 YAML 保存</Button>
            <Button size="sm" variant="ghost" onClick={() => { setYamlText(yml); setYamlOpen(false) }}>关闭</Button>
          </div>
        </div>
      ) : (
        <WorkflowCanvas
          key={`${openId}:${canvasEpoch}`}
          ref={canvasRef}
          model={model}
          onChange={(next) => { setModel(next); setDirty(true) }}
          nodeStatus={runView.nodeStatus}
          edgeState={runView.edgeState}
        />
      )}

      {authzDialog}
      {runDrawer}

      <Dialog open={versionsOpen} onOpenChange={setVersionsOpen}>
        <DialogContent size="md">
          <DialogHeader><DialogTitle>版本历史与运行记录</DialogTitle></DialogHeader>
          <DialogBody>
            <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider mb-1">版本快照（{versions.length}）</div>
            <div className="flex flex-col gap-1 mb-3">
              {versions.map((v) => (
                <div key={v.ts} className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-secondary flex-1 truncate">{v.ts}</span>
                  <Button size="xs" variant="ghost" onClick={async () => {
                    const r = await rollbackWorkflow(openId, v.ts)
                    setNotice(r.ok ? { tone: 'ok', text: `已回滚到 ${v.ts}` } : { tone: 'error', text: r.error })
                    if (r.ok) { setVersionsOpen(false); await openWorkflow(openId) }
                  }}>回滚</Button>
                </div>
              ))}
              {versions.length === 0 && <span className="text-[10px] text-tertiary">暂无版本快照（首次保存后生成）</span>}
            </div>
            <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider mb-1">最近运行（{runs.length}）</div>
            <div className="flex flex-col gap-0.5">
              {runs.slice(0, 10).map((r, i) => (
                <div key={i} className="text-[11px] text-secondary font-mono truncate">
                  {String(r.at || r.file || r.runId || '')} · {String(r.status || '')} · {String(r.nodes ?? r.steps ?? '')} 步
                </div>
              ))}
              {runs.length === 0 && <span className="text-[10px] text-tertiary">暂无运行记录</span>}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setVersionsOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NoticeBar({ notice, onClose }: { notice: { tone: 'ok' | 'error'; text: string }; onClose: () => void }) {
  return (
    <div className={cn('px-3 py-1.5 border-b text-[11px] flex items-center gap-2 shrink-0', notice.tone === 'error' ? 'text-error' : 'text-success')}>
      <span className="flex-1 truncate">{notice.text}</span>
      <button onClick={onClose} className="text-tertiary hover:text-primary"><X className="w-3 h-3" /></button>
    </div>
  )
}
