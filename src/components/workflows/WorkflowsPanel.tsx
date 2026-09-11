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
  confirmNode, createWorkflow, deleteWorkflow, duplicateWorkflow, exportWorkflow, importWorkflow,
  listRuns, listVersions, listWorkflows, loadWorkflow, rollbackWorkflow,
  runWorkflow, saveWorkflow, saveWorkflowYaml, stopRun, subscribeWorkflowEvents, validateWorkflow,
  type RunRecord, type WorkflowMeta,
} from '@/lib/workflowApi'
import {
  deriveCapabilities, emptyModel, summarizeLocal, validateLocal,
  type Capabilities, type ValidationIssue, type WorkflowModel,
} from '@/lib/workflowModel'
import { WorkflowCanvas, type WorkflowCanvasHandle } from './canvas/WorkflowCanvas'
import { WorkflowList } from './WorkflowList'
import { AuthzDialog } from './AuthzDialog'
import { RUN_PHASE_TEXT, RunDrawer, applyRunEvent, emptyRunView, type RunView, type WorkflowRunEvent } from './RunDrawer'

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
    const r = await duplicateWorkflow(id, `${id}-copy`)
    if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
    await refreshList()
  }, [refreshList])

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

  /** 授权卡确认 → 真正运行（清单即用户在 AuthzDialog 里勾除后的能力，宿主按此 fail-closed 放行） */
  const startRun = useCallback(async (confirmed: Capabilities) => {
    if (!runSetup) return
    setCaps(confirmed)
    setRunView(emptyRunView())   // 清空上一轮着色（start 事件到达时同样会清空，此处先清避免残留）
    const r = await runWorkflow(runSetup.id, inputs, confirmed)
    if (!r.ok) { setNotice({ tone: 'error', text: `运行失败：${r.error}` }); return }
    const rid = String(r.runId || '')
    if (!rid) { setNotice({ tone: 'error', text: '运行失败：宿主未返回 runId' }); return }
    runIdRef.current = rid
    setRunId(rid)
    setRunWfId(runSetup.id)
    setRunSetup(null)
    setDrawerOpen(true)
    setNotice({ tone: 'ok', text: `已启动：${rid}` })
  }, [inputs, runSetup])

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
      onConfirm={(confirmed) => void startRun(confirmed)}
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
