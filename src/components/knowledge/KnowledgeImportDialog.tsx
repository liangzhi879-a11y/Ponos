// src/components/knowledge/KnowledgeImportDialog.tsx —— 文件知识库导入（2026-09-14）
//
// 交互取舍：
// - 源**只传路径**（用系统对话框取），不上传字节：与 /read-docx、/convert-office 同一条数据通道。
//   渲染进程把 File 对象搬进内存再落临时文件，白白多一次拷贝，而且拿不到"选整个文件夹"——
//   而"把一个资料文件夹整批入库"恰恰是这里最有用的形态。
// - "新建空间"是**默认项**：导一批新资料通常配一个新空间；已有可写空间作为备选。
// - 预览（dryRun）与导入**共用一份结果视图**：三档（成功/跳过/失败）分列。
//   只报"5/6 成功"等于让用户自己去文件树里对账，所以失败项必须带文件名与原因。
// - 导入成功后**切到目标空间**：否则树还停在上一个空间，用户看不到刚导进去的东西，
//   会以为失败又导一遍（幂等会跳过，但他已经困惑了）。
// - 数据路径：组件只调 `useKnowledge.importDocuments`，**不直接碰 `knowledgeApi`** ——
//   导入后的缓存失效（spaces/tree/search/graph/stats）收在 hook 一处，组件各记各的必漂移。
import { useMemo, useRef, useState } from 'react'
import { Upload, FolderOpen, Loader2, FilePlus2, Table2, AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/useTranslation'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
// 视觉能力判定只消费**唯一一份**实现（src/lib/visionUi.ts）：导入提示与设置页必须同口径，
// 否则会出现"设置页显示配好了、这里却提示未配置"这种用户无法自行判断的矛盾。
import { useSettingsStore } from '@/stores/settingsStore'
import { isVisionConfigured, resolveVisionProvider } from '@/lib/visionUi'
import {
  type KnowledgeImportEntry,
  type KnowledgeImportReport,
  type KnowledgeSpace,
} from '@/lib/knowledgeApi'
// 进度归约/百分比/文案都来自纯函数模块（可单测），组件只负责渲染与生命周期。
import {
  IDLE_IMPORT_PROGRESS, importPercent, normalizeKnowledgeImportPolicyUi,
  progressFromJob, type ImportProgress,
} from '@/lib/knowledgeImportUi'
// 写入必须走 hook 的 importDocuments（不是直接调 api）：它负责导入后的缓存失效
// （tree/search/graph/stats）—— 少了这一步，P1-1 的"导入后立刻能读到、搜到"不成立。
import { importDocuments, importDocumentsTracked } from '@/hooks/useKnowledge'
// 组件与 knowledgeApi 的**类型**同名（都叫 KnowledgeImportReport），故给组件起个别名 ——
// 否则 TS 报 Duplicate identifier，而"改类型名"会波及 useKnowledge/其它调用点。
import { KnowledgeImportReport as ImportReportView, MAX_ROWS } from './KnowledgeImportReport'

export interface KnowledgeImportDialogProps {
  spaces: KnowledgeSpace[] | undefined
  /** 导入成功后通知宿主刷新（空间列表/统计）；切空间已由本组件负责 */
  onImported?: (spaceId: string) => void
}


/**
 * 导入结果报告与明细清单已抽到 `KnowledgeImportReport.tsx`（2026-09-14）——
 * 本文件因此保持在 400 行上限内（`scripts/verify-knowledge-gui.mjs` 会检查）。
 * 那时一并修掉了报告里的 `text-warn` / `text-danger`：主题定义的是 `warning` / `error`，
 * 未定义的类名不报错、只是不生效，表现为"告警不醒目"。
 * `MAX_ROWS` 也从那里 import —— 文件列表与结果清单必须同一档上限。
 */

/**
 * 进度文案（走 i18n，不直接用 `importProgressText` 的中文字面量）：
 * 那个纯函数是给非 React 场景（CLI/测试）的降级文案，组件里必须走 t() 才能在英文界面下正确显示。
 * 两段式对应需求："先查文件数"（分母未知 → 不定态）→"按已处理数算进度"（分母已知）。
 */
function progressLabel(
  t: (k: string) => string,
  p: ImportProgress,
): string {
  if (p.phase === 'plan') return t('knowledge.importProgressCounting')
  if (p.phase === 'done') return t('knowledge.importProgressDone').replace('{total}', String(p.total))
  if (p.phase === 'process') {
    // n 用 done+1（"正在处理第几个"，而非"已完成几个"），并钳到 total：
    // 最后一个文件时 done+1 恰好等于 total，不会显示成 "11/10"。
    const n = Math.min(p.done + 1, p.total)
    const key = p.current ? 'knowledge.importProgressProcessing' : 'knowledge.importProgressProcessingNoName'
    return t(key)
      .replace('{n}', String(n))
      .replace('{total}', String(p.total))
      .replace('{current}', p.current ?? '')
  }
  return t('knowledge.importProgressCounting')
}

export function KnowledgeImportDialog({ spaces, onImported }: KnowledgeImportDialogProps) {
  const { t } = useTranslation()
  const setSpace = useKnowledgeStore(s => s.setSpace)
  const [open, setOpen] = useState(false)
  const [sources, setSources] = useState<string[]>([])
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [newName, setNewName] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [busy, setBusy] = useState<'dry' | 'run' | null>(null)
  const [report, setReport] = useState<KnowledgeImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 403 = 目标空间只读（pack-*）。单独留个标记，好在原始错误之外补一句"怎么解决" */
  const [readonlyError, setReadonlyError] = useState(false)
  /**
   * 导入进度（2026-09-14 批量场景）。`phase: 'plan'`（total 未知）= 内核还在枚举文件，
   * 此时渲染不确定态进度条 —— 需求原话"先查文件数，然后根据实时处理的文件数量算进度"，
   * 这一态正是前半句的可见形态。
   */
  const [progress, setProgress] = useState<ImportProgress>(IDLE_IMPORT_PROGRESS)
  /**
   * 轮询取消信号。只在**关闭对话框**时置位，语义是"我不看进度了、导入继续在后台跑"，
   * 不是取消任务（强行中止会留下半批结果，且用户无从知晓）。用 ref 而非 state：
   * 它不需要触发重渲染，且必须在 cleanup 时读到最新值。
   */
  const pollCtl = useRef<{ aborted: boolean } | null>(null)

  const writableSpaces = useMemo(() => (spaces ?? []).filter(s => s.writable !== false), [spaces])
  // 视觉模型是否可用：扫描件/图片里的表格**只能**靠它读出来（OCR 不保留列坐标）。
  // 为什么在**导入前**就提示：视觉调用按页慢且可能计费，用户有权在等待前知道"会不会走视觉"、
  // 以及"没配的话表格会丢"——等导完才说，用户已经白等了几分钟、还得重导一遍。
  const visionSettings = useSettingsStore(s => s.settings)
  const visionOk = isVisionConfigured(visionSettings)
  const visionModelName = resolveVisionProvider(visionSettings)?.visionModel?.trim() || ''
  // 导入上限（设置项）。经归一化再读：手改 config.json 写坏的值不该让组件算出 NaN 上限。
  const importPolicy = useMemo(
    () => normalizeKnowledgeImportPolicyUi(visionSettings.knowledgeImport),
    [visionSettings.knowledgeImport],
  )
  // `window.yfworkingFile` 的类型在 src/types/index.ts 全局声明（preload 的 exposeInMainWorld
  // 名字），这里**不做 as 断言**：断言会把"窗口名/方法名写错 → 静默 undefined"这类坑
  // 从类型检查里藏起来（本项目高发）。浏览器 dev 下该 API 不存在，故仍按可选处理。
  const picker = window.yfworkingFile
  const desktop = !!(picker?.pickKnowledgeFiles || picker?.pickKnowledgeFolder)
  const target = mode === 'new' ? newName.trim() : (spaceId || writableSpaces[0]?.id || '')
  const canRun = sources.length > 0 && !!target && !busy

  async function addFiles() {
    if (!picker?.pickKnowledgeFiles) { setError(t('knowledge.importNoDesktop')); return }
    const picked = await picker.pickKnowledgeFiles()
    if (picked?.length) {
      // 去重：同一个文件被选两次会让内核把它当两个源（多源时各自加前缀 → 产出两份）
      setSources(prev => Array.from(new Set([...prev, ...picked])))
    }
  }
  async function addFolder() {
    if (!picker?.pickKnowledgeFolder) { setError(t('knowledge.importNoDesktop')); return }
    const dir = await picker.pickKnowledgeFolder()
    if (dir) setSources(prev => (prev.includes(dir) ? prev : [...prev, dir]))
  }

  async function run(dryRun: boolean) {
    if (!sources.length) { setError(t('knowledge.importNeedSource')); return }
    if (!target) { setError(t('knowledge.importNeedSpace')); return }
    setBusy(dryRun ? 'dry' : 'run')
    setError(null)
    setReadonlyError(false)
    setProgress(IDLE_IMPORT_PROGRESS)
    // from 单源传字符串（报告里是路径），多源传数组（内核按源加前缀，避免同名互撞）
    // 走 hook 的 importDocuments（不是 api.importKnowledge）：成功后由它失效 tree/search 等缓存
    const payload = {
      from: sources.length === 1 ? sources[0] : sources,
      ...(mode === 'existing' ? { spaceId: target } : { name: target }),
      // 上限跟随设置项（服务端还会按同一份常量钳制；两端口径由 parity 测试钉住）。
      // 取整到 MB：内核的 `--max-total-mb` 是数值 MB，传字节会被当成天文数字的 MB。
      // `Math.max(1, …)` 兜住 0：上限 0 会被内核判非法（bad-max-total-mb），
      // 而钳制区间的最小值本就是 1MB，所以这里不可能凭空造出非法值。
      maxFiles: importPolicy.maxFiles,
      maxTotalMb: Math.max(1, Math.round(importPolicy.maxTotalBytes / (1024 * 1024))),
      dryRun,
    }
    let res
    if (dryRun) {
      // 预览走**同步**路径：它不落盘、通常秒回，异步化只会白加一轮轮询，
      // 还会让"预览"这个高频动作在 UI 上先闪一下不确定态进度条。
      res = await importDocuments(payload)
    } else {
      // 正式导入走异步 + 轮询：这是"大批量 + 进度条"的正路。
      const ctl = { aborted: false }
      pollCtl.current = ctl
      res = await importDocumentsTracked(payload, {
        signal: ctl,
        onProgress: (j) => {
          const p = progressFromJob(j)
          if (p) setProgress(p)   // 形状不认识就保持上一态，不把进度条打回 0
        },
      })
      pollCtl.current = null
    }
    setBusy(null)
    if (!res.ok) {
      setReport(null)
      // 原始 message 一律展示（含内核错误码，便于报障）；403 额外补一句可执行的处置建议
      setError(res.error || t('knowledge.importFailed'))
      setReadonlyError(res.status === 403)
      return
    }
    setReport(res.data)
    if (!dryRun && res.data.counts.converted > 0) {
      // 切到目标空间：否则树还停在上一个空间，用户看不到刚导进去的东西，
      // 会以为失败又导一遍（幂等会跳过，但他已经困惑了）。缓存失效已在 importDocuments 内做完。
      setSpace(res.data.spaceId)
      onImported?.(res.data.spaceId)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => {
      setOpen(v)
      if (!v) {
        setError(null)
        // 关对话框 = 不再跟进度（**不**取消服务端任务，见 pollCtl 注释）
        if (pollCtl.current) pollCtl.current.aborted = true
      }
    }}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center gap-1.5 py-0.5 text-[11px] text-tertiary hover:text-primary transition-colors"
        >
          <Upload className="w-3 h-3 shrink-0" />
          <span className="truncate">{t('knowledge.importTitle')}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('knowledge.importTitle')}</DialogTitle>
        </DialogHeader>

        <p className="text-[11px] text-tertiary">{t('knowledge.importHint')}</p>

        {/* 视觉模型的**事前**提示（2026-09-14）：两态各说清后果，而不是只报一个状态。
            未配置：讲明"扫描件/图片的表格不会被提取"，并给出可执行路径（去设置里配 + 重新导入）；
            已配置：讲明会走视觉、以及有页数上限（用户据此预估耗时，也知道超长扫描件的边界）。 */}
        <div className="mt-1.5 flex items-start gap-1.5">
          {visionOk
            ? <Table2 className="mt-[1px] w-3 h-3 shrink-0 text-tertiary" />
            : <AlertTriangle className="mt-[1px] w-3 h-3 shrink-0 text-warn" />}
          <p className="text-[10px] text-tertiary leading-relaxed">
            {visionOk
              ? t('knowledge.importVisionOn', { model: visionModelName || 'vision' })
              : t('knowledge.importVisionOff')}
          </p>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={addFiles}
            disabled={!desktop || !!busy}
            className="flex items-center gap-1 px-2 py-1 text-[11px] border border-default rounded hover:bg-hover disabled:opacity-50"
          >
            <FilePlus2 className="w-3 h-3" />
            {t('knowledge.importPickFiles')}
          </button>
          <button
            type="button"
            onClick={addFolder}
            disabled={!desktop || !!busy}
            className="flex items-center gap-1 px-2 py-1 text-[11px] border border-default rounded hover:bg-hover disabled:opacity-50"
          >
            <FolderOpen className="w-3 h-3" />
            {t('knowledge.importPickFolder')}
          </button>
          {!desktop && <span className="text-[10px] text-tertiary">{t('knowledge.importNoDesktop')}</span>}
        </div>

        {sources.length > 0 && (
          <div className="mt-2">
            <p className="text-[10px] text-secondary">
              {t('knowledge.importSources')}（{sources.length}）
            </p>
            <ul className="mt-0.5 max-h-[96px] overflow-auto space-y-0.5">
              {sources.slice(0, MAX_ROWS).map(p => (
                <li key={p} className="flex items-center gap-1 text-[10px] text-tertiary">
                  <span className="flex-1 min-w-0 truncate" title={p}>{p}</span>
                  <button
                    type="button"
                    onClick={() => setSources(prev => prev.filter(s => s !== p))}
                    className="shrink-0 hover:text-primary"
                  >
                    ×
                  </button>
                </li>
              ))}
              {sources.length > MAX_ROWS && (
                <li className="text-[10px] text-tertiary">{t('knowledge.importMoreRows', { n: sources.length - MAX_ROWS })}</li>
              )}
            </ul>
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-1 text-[11px] text-secondary">
            <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
            {t('knowledge.importSpaceNew')}
          </label>
          <label className="flex items-center gap-1 text-[11px] text-secondary">
            <input
              type="radio"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
              disabled={!writableSpaces.length}
            />
            {t('knowledge.importSpaceExisting')}
          </label>
        </div>

        {mode === 'new'
          ? (
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder={t('knowledge.importSpaceNamePlaceholder')}
              className="mt-1 w-full px-2 py-1 text-[11px] border border-default rounded bg-transparent"
            />
          )
          : (
            <select
              value={target}
              onChange={e => setSpaceId(e.target.value)}
              className="mt-1 w-full px-2 py-1 text-[11px] border border-default rounded bg-transparent"
            >
              {writableSpaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => run(true)}
            disabled={!canRun}
            className="flex items-center gap-1 px-2 py-1 text-[11px] border border-default rounded hover:bg-hover disabled:opacity-50"
          >
            {busy === 'dry' && <Loader2 className="w-3 h-3 animate-spin" />}
            {t('knowledge.importPreview')}
          </button>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={!canRun}
            className="flex items-center gap-1 px-2 py-1 text-[11px] border border-default rounded hover:bg-hover disabled:opacity-50"
          >
            {busy === 'run' && <Loader2 className="w-3 h-3 animate-spin" />}
            {busy === 'run' ? t('knowledge.importRunning') : t('knowledge.importRun')}
          </button>
          {busy && <span className="text-[10px] text-tertiary">{t('knowledge.importSlow')}</span>}
        </div>

        {/* 进度条（2026-09-14 批量场景）：只在正式导入时出现。
            两态刻意分开渲染：
            · `plan`（total 未知）= **不确定态**（脉冲滑块 + "正在统计文件数…"）。
              此时若画 0% 会让用户以为卡死；若直接画满则是假进度。
            · `process`/`done`（total 已知）= 确定态，按 `done/total` 算百分比。
            这就是需求"先查文件数，然后根据实时处理的文件数量算进度"的两段式。 */}
        {busy === 'run' && (
          <div className="mt-2" data-testid="import-progress">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-secondary truncate" title={progress.current}>
                {progressLabel(t, progress)}
              </span>
              {progress.total > 0 && (
                <span className="shrink-0 text-[10px] text-tertiary tabular-nums">{importPercent(progress)}%</span>
              )}
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-hover">
              {progress.total > 0
                ? (
                  <div
                    className="h-full bg-primary transition-[width] duration-200"
                    style={{ width: `${importPercent(progress)}%` }}
                  />
                )
                : (
                  // 不确定态：脉冲滑块表达"在动但不知多久"（不用旋转图标，免得和按钮上的
                  // Loader2 抢注意力，也不占额外高度）
                  <div className="h-full w-1/3 animate-pulse rounded bg-primary/60" />
                )}
            </div>
          </div>
        )}

        {/* 错误**必须显式渲染**（P3-1：不得静默失败）。原始 message 原样带上——它是内核/
            路由给的英文错误码短语（如 `readonly-space: space 不得以 "pack-" 开头…`），
            比前端猜一个通用文案更有诊断价值；403 再补一句"怎么解决"。 */}
        {error && (
          <div className="mt-2">
            <p className="text-[11px] text-danger">{t('knowledge.importFailed')}：{error}</p>
            {readonlyError && <p className="mt-0.5 text-[10px] text-tertiary">{t('knowledge.importReadonlyHint')}</p>}
          </div>
        )}

        {report && <ImportReportView report={report} />}
      </DialogContent>
    </Dialog>
  )
}
