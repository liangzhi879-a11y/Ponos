// src/components/workflows/WorkflowsPanel.tsx —— 第五 rail 面板（UI Task 13，spec §6 第 1-2 层）
//
// 三段式：列表 ⇄ 画布编辑器；工具栏 = 返回 / 保存 / 校验 / 运行 / YAML / 版本 / 导出。
// 单一真相：`model` 由本组件持有，画布节流回写（300ms）+ 保存前 flush（brief 风险③）。
//
// 运行链路（Task 13 交付到「授权清单确认」为止；**Task 14 接手** RunDrawer/AuthzDialog）：
//   flush → deriveCapabilities(model) → 本文件内的 RunSetup 对话框（逐项可勾除；勾除项 fail-closed）
//   → runWorkflow(id, inputs, capabilities) → runId 落到徽标 → stopRun。
//   **Task 14 注入点**：
//     · 顶部 runId 徽标 → 换成 <RunDrawer runId={runId} events={events} onStop onConfirm />；
//     · 事件订阅回调里 setNodeStatus(map)/setEdgeState(map) —— 画布经 withRunState 着色，
//       字段形状见任务报告「对 Task 14 的接口交接」；
//     · 本文件的 RunSetup 对话框 → 换成 <AuthzDialog capabilities onConfirm onCancel />。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Save, ShieldCheck, Play, Download, FileCode2, History, X } from 'lucide-react'
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Switch, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  createWorkflow, deleteWorkflow, duplicateWorkflow, exportWorkflow, importWorkflow,
  listRuns, listVersions, listWorkflows, loadWorkflow, rollbackWorkflow,
  runWorkflow, saveWorkflow, saveWorkflowYaml, stopRun, validateWorkflow,
  type RunRecord, type WorkflowMeta,
} from '@/lib/workflowApi'
import {
  deriveCapabilities, emptyModel, summarizeLocal, validateLocal,
  type Capabilities, type NodeRunStatus, type ValidationIssue, type WorkflowModel,
} from '@/lib/workflowModel'
import { WorkflowCanvas, type WorkflowCanvasHandle } from './canvas/WorkflowCanvas'
import { WorkflowList } from './WorkflowList'

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

  // —— 运行态（Task 14 注入点，见文件头注释）——
  const [runId, setRunId] = useState<string | null>(null)
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeRunStatus>>({})
  const [edgeState, setEdgeState] = useState<Record<string, 'active' | 'skipped'>>({})
  const [runSetup, setRunSetup] = useState<{ id: string; model: WorkflowModel } | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [caps, setCaps] = useState<Capabilities>({ tools: [], write_dirs: [], network: false })

  const canvasRef = useRef<WorkflowCanvasHandle | null>(null)

  const refreshList = useCallback(async () => {
    setLoading(true)
    const r = await listWorkflows()
    setLoading(false)
    if (r.ok) { setList(r.workflows || []); setError('') } else setError(r.error)
  }, [])

  useEffect(() => { void refreshList() }, [refreshList])

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
    setRunId(null)
    setNodeStatus({})
    setEdgeState({})
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

  /** 运行：flush → 推导能力 → 授权清单确认（Task 14 换成 AuthzDialog） */
  const openRunSetup = useCallback(async (id: string) => {
    let target = model
    if (openId === id) target = canvasRef.current?.flush() ?? model
    if (!target) {
      const r = await loadWorkflow(id)
      if (!r.ok) { setNotice({ tone: 'error', text: r.error }); return }
      target = r.model
    }
    const derived = deriveCapabilities(target)
    setCaps(derived)
    setInputs(Object.fromEntries((target.inputs || []).map((i) => [i.name, ''])))
    setRunSetup({ id, model: target })
  }, [model, openId])

  const startRun = useCallback(async () => {
    if (!runSetup) return
    setNodeStatus({})
    setEdgeState({})
    const r = await runWorkflow(runSetup.id, inputs, caps)
    if (!r.ok) { setNotice({ tone: 'error', text: `运行失败：${r.error}` }); return }
    setRunId(r.runId)
    setRunSetup(null)
    setNotice({ tone: 'ok', text: `已启动：${r.runId}` })
  }, [caps, inputs, runSetup])

  const doStop = useCallback(async () => {
    if (!runId) return
    const r = await stopRun(runId)
    setNotice(r.ok ? { tone: 'ok', text: '已请求停止' } : { tone: 'error', text: r.error })
  }, [runId])

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
        {runSetup && (
          <RunSetup
            model={runSetup.model}
            caps={caps}
            setCaps={setCaps}
            inputs={inputs}
            setInputs={setInputs}
            onConfirm={() => void startRun()}
            onCancel={() => setRunSetup(null)}
          />
        )}
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
          <span className="flex items-center gap-1 text-[10px] text-brand-500">
            运行中 <span className="font-mono">{runId}</span>
            <button className="underline" onClick={() => void doStop()}>停止</button>
          </span>
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
          nodeStatus={nodeStatus}
          edgeState={edgeState}
        />
      )}

      {runSetup && (
        <RunSetup
          model={runSetup.model}
          caps={caps}
          setCaps={setCaps}
          inputs={inputs}
          setInputs={setInputs}
          onConfirm={() => void startRun()}
          onCancel={() => setRunSetup(null)}
        />
      )}

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

/**
 * 运行前授权清单（Task 13 的临时形态；**Task 14 用 AuthzDialog 替换**）：
 * 逐项可勾除，勾除项本次运行内 fail-closed（宿主 mergeCapabilities 后按清单放行）。
 * 审计不受影响——授权只免除交互打断，每次工具调用仍写哈希链。
 */
function RunSetup({ model, caps, setCaps, inputs, setInputs, onConfirm, onCancel }: {
  model: WorkflowModel
  caps: Capabilities
  setCaps: (c: Capabilities) => void
  inputs: Record<string, string>
  setInputs: (v: Record<string, string>) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const inputsDef = model.inputs || []
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>运行前授权：{model.name}</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="text-[11px] text-tertiary mb-3">
            勾除的项在本次运行内一律拒绝（fail-closed），不会中断整轮；每次工具调用仍写审计哈希链。
          </div>

          {inputsDef.length > 0 && (
            <div className="mb-3 flex flex-col gap-2">
              <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">输入参数</div>
              {inputsDef.map((i) => (
                <div key={i.name} className="flex items-center gap-2">
                  <span className="text-[11px] text-secondary w-[120px] shrink-0 truncate font-mono">
                    {i.name}{i.required ? ' *' : ''}
                  </span>
                  <Input value={inputs[i.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} className="h-7 text-xs" />
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">能力清单（deriveCapabilities 推导）</div>
            <label className="flex items-center justify-between text-[11px] text-secondary">
              访问网络
              <Switch checked={caps.network} onCheckedChange={(v) => setCaps({ ...caps, network: v })} />
            </label>
            <div className="text-[11px] text-secondary">调用工具（{caps.tools.length}）</div>
            <div className="flex flex-wrap gap-1.5">
              {caps.tools.length === 0 && <span className="text-[10px] text-tertiary">本工作流未用到工具</span>}
              {caps.tools.map((t) => {
                const on = true
                return (
                  <button
                    key={t}
                    onClick={() => setCaps({ ...caps, tools: caps.tools.filter((x) => x !== t) })}
                    className={cn('text-[10px] px-1.5 py-0.5 rounded border font-mono', on ? 'text-brand-500 border-brand-500/30 bg-brand-500/10' : 'text-tertiary')}
                    title="点击移除（本次运行内拒绝该工具）"
                  >{t} ×</button>
                )
              })}
            </div>
            <div className="text-[11px] text-secondary mt-1">写入目录（{caps.write_dirs.length}）</div>
            <div className="flex flex-wrap gap-1.5">
              {caps.write_dirs.length === 0 && <span className="text-[10px] text-tertiary">无（写类工具将按工作目录相对路径判定）</span>}
              {caps.write_dirs.map((d) => (
                <button
                  key={d}
                  onClick={() => setCaps({ ...caps, write_dirs: caps.write_dirs.filter((x) => x !== d) })}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-brand-500/30 bg-brand-500/10 text-brand-500 font-mono"
                  title="点击移除（写入将被拒绝）"
                >{d} ×</button>
              ))}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
          <Button size="sm" onClick={onConfirm}><Play className="w-3.5 h-3.5" />按此清单运行</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 供 Task 14 复用：事件订阅回调要写的两个 setter 形状（画布着色的唯一入口） */
export interface RunStateSetters {
  setNodeStatus: (m: Record<string, NodeRunStatus>) => void
  setEdgeState: (m: Record<string, 'active' | 'skipped'>) => void
}
