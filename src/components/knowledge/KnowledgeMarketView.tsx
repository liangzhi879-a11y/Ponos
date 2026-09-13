// src/components/knowledge/KnowledgeMarketView.tsx —— 知识包市场（S4 Task 6 宿主）
//
// 三块：顶部（来源 + 检查更新 + 从本地文件安装 + 导出）／左栏清单（KnowledgePackList）／
// 右栏详情（KnowledgePackDetail）。浮层在 KnowledgePackDialogs（宿主守 ≤400 行）。
//
// **数据只在宿主取**：组件内不裸 fetch（scripts/verify-knowledge-gui.mjs 会拦），
// 一律走 src/lib/knowledgePacksApi.ts。**不做全局缓存**：市场是"用户主动打开才看"的页面，
// 而清单可能来自网络（D3 仅手动检查、不落盘缓存）——每次进入视图拉一次，避免展示陈旧的"可更新"状态。
//
// 安全相关的两条硬约束在本文件落地：
//   ① **安装必须显式确认**：`askInstall` 只把"待确认"放进 state，写盘调用只有 `doInstall` 一处，
//      且它只由确认浮层的按钮触发（没有"一键静默安装"的代码路径）。
//   ② **403 冲突不是失败**：`kept-user-modified` 时后端一个字节都没写，这里改弹三选浮层；
//      选"保留现状"即零副作用退出，`attempt`（上次尝试）留着以便选"覆盖/另存"时重放同一来源。
import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Upload } from 'lucide-react'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { useSpaces } from '@/hooks/useKnowledge'
import {
  installPack, installPackFromFile, listPacks, packDetail, uninstallPack,
  type KnowledgePackDetailData, type KnowledgePacksIndexData,
} from '@/lib/knowledgePacksApi'
import { localInstallSupported, sourceLabel, type PackConflictOption } from '@/lib/knowledgeMarket'
import { KnowledgePackList } from './KnowledgePackList'
import { KnowledgePackDetail } from './KnowledgePackDetail'
import { PackConflictDialog, PackConfirmDialog, PackExportDialog } from './KnowledgePackDialogs'

/** 一次安装尝试（重放用：冲突三选后必须用**同一来源**重试，不能把离线包当成在线 id） */
type Attempt =
  | { kind: 'online'; id: string; version: string }
  | { kind: 'file'; path: string }

/** 待确认的动作（安装/卸载共用一张浮层；文案由调用点拼好，宿主不查表拼串） */
interface Pending { title: string; body: string; confirmLabel: string; danger?: boolean; run: () => void }
/** 提示行（成功/失败都用一行，不吞错） */
interface Note { kind: 'ok' | 'err'; text: string }

export function KnowledgeMarketView() {
  const { t } = useTranslation()
  const { data: spaces } = useSpaces()
  const [index, setIndex] = useState<KnowledgePacksIndexData | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selId, setSelId] = useState<string | null>(null)
  const [detail, setDetail] = useState<KnowledgePackDetailData | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [conflict, setConflict] = useState<{ packId: string; conflicts: string[]; options: unknown } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  const loadList = useCallback(async () => {
    setLoading(true)
    const r = await listPacks()
    setLoading(false)
    if (!r.ok) { setListError(r.error); return }
    setListError(null)
    setIndex(r.data)
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true)
    const r = await packDetail(id)
    setDetailLoading(false)
    if (!r.ok) { setDetailError(r.error); setDetail(null); return }
    setDetailError(null)
    setDetail(r.data)
  }, [])

  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { if (selId) void loadDetail(selId) }, [selId, loadDetail])

  const failures = (r: { error: string; errors?: string[] }) => (r.errors?.length ? r.errors : [r.error]).join('；')

  /**
   * **唯一的写盘调用点（安装）**。`mode` 只在冲突三选时才传：
   *   overwrite  → 后端先备份再覆盖
   *   to-my-space→ 复制进可写空间（不装成只读包空间）
   * 不传 = safe：冲突时一个字节都不写。
   */
  const doInstall = async (a: Attempt, mode?: PackConflictOption) => {
    setBusy(true); setNote(null)
    const apiMode = mode === 'overwrite' ? 'overwrite' : mode === 'to-my-space' ? 'to-my-space' : undefined
    const r = a.kind === 'online'
      ? await installPack({ id: a.id, version: a.version || undefined, mode: apiMode })
      : await installPackFromFile(a.path, apiMode)
    setBusy(false)
    if (r.ok) {
      setConflict(null); setAttempt(null)
      const s = r.data.status
      const msg = s === 'updated' ? t('knowledge.marketStatusUpdated', { version: r.data.version })
        : s === 'unchanged' ? t('knowledge.marketStatusUnchanged')
          : s === 'to-my-space' ? t('knowledge.marketStatusToSpace', { id: r.data.spaceId })
            : t('knowledge.marketStatusInstalled', { version: r.data.version })
      setNote({ kind: 'ok', text: r.data.backupPath ? `${msg} · ${t('knowledge.marketBackup', { path: r.data.backupPath })}` : msg })
      await loadList()
      if (a.kind === 'online') await loadDetail(a.id)
      return
    }
    // 403 冲突：不是失败（后端未写盘）→ 弹三选，attempt 留给重试
    if (r.status === 403 && r.conflict) {
      setAttempt(a)
      // `PackConflict`（API 层）只带 conflicts/options——标题里的 id 用**本次尝试**的来源表达
      setConflict({ packId: a.kind === 'online' ? a.id : a.path, conflicts: r.conflict.conflicts, options: r.conflict.options })
      return
    }
    setNote({ kind: 'err', text: t('knowledge.marketFailed', { msg: failures(r) }) })
  }

  const askOnlineInstall = (d: KnowledgePackDetailData) => {
    const version = d.version.version || d.pack.version
    setPending({
      title: t('knowledge.marketConfirmInstall'),
      body: t('knowledge.marketConfirmBody', {
        name: d.pack.name, version, license: d.pack.license || '—',
        source: sourceLabel(d.source) === 'local' ? t('knowledge.marketSourceLocal') : t('knowledge.marketSourceRemote'),
      }),
      confirmLabel: d.installed ? t('knowledge.marketUpdate', { version }) : t('knowledge.marketInstall'),
      run: () => { void doInstall({ kind: 'online', id: d.pack.id, version }) },
    })
  }

  /** 离线安装：先经系统对话框选 zip（无 Electron preload 时给显式提示，不抛） */
  const askLocalInstall = async () => {
    const fileApi = (window as unknown as { yfworkingFile?: { openKnowledgePack?: () => Promise<string | null> } }).yfworkingFile
    if (!localInstallSupported(fileApi)) { setNote({ kind: 'err', text: t('knowledge.marketDesktopOnly') }); return }
    const path = await fileApi!.openKnowledgePack!()
    if (!path) return       // 用户取消：不是错误
    setPending({
      title: t('knowledge.marketConfirmInstall'),
      body: t('knowledge.marketLocalConfirmBody', { path }),
      confirmLabel: t('knowledge.marketInstall'),
      run: () => { void doInstall({ kind: 'file', path }) },
    })
  }

  const askUninstall = (d: KnowledgePackDetailData) => setPending({
    title: t('knowledge.marketConfirmUninstall'),
    body: t('knowledge.marketConfirmUninstallBody', { id: d.pack.id }),
    confirmLabel: t('knowledge.marketUninstall'),
    danger: true,
    run: () => { void (async () => {
      setBusy(true); setNote(null)
      const r = await uninstallPack(d.pack.id)
      setBusy(false)
      if (!r.ok) { setNote({ kind: 'err', text: t('knowledge.marketUninstallFailed', { msg: r.error }) }); return }
      setDetail(null); setSelId(null)
      setNote({ kind: 'ok', text: t('knowledge.marketUninstalled', { id: d.pack.id }) })
      await loadList()
    })() },
  })

  const packs = index?.packs ?? []
  const source = sourceLabel(index?.source ?? 'none')

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* 顶部：来源状态 + 三个动作。清单拉不到时**不是错误页**——已装列表与离线安装仍可用 */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-default">
        <span className="text-[11px] text-secondary">{t('knowledge.marketTitle')}</span>
        <span className="micro">{source === 'local' ? t('knowledge.marketSourceLocal') : source === 'remote' ? t('knowledge.marketSourceRemote') : t('knowledge.marketSourceNone')}</span>
        {index?.appVersion && <span className="micro">{t('knowledge.marketAppVersion')} {index.appVersion}</span>}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" disabled={loading} onClick={() => { setNote(null); void loadList() }}>
          <RefreshCw className="w-3 h-3" />{t('knowledge.marketCheck')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void askLocalInstall()}>
          <FolderOpen className="w-3 h-3" />{t('knowledge.marketInstallLocal')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setExportOpen(true)}>
          <Upload className="w-3 h-3" />{t('knowledge.marketExport')}
        </Button>
      </div>

      {/* 提示行：一行搞定，不吞错（后端 errors[] 逐条合并，避免只看到第一条） */}
      {(listError || index?.indexError || note) && (
        <div className="shrink-0 px-3 py-1 border-b border-default space-y-0.5">
          {listError && <p className="text-[11px] text-error break-words">{t('knowledge.marketFailed', { msg: listError })}</p>}
          {index?.indexError && <p className="text-[11px] text-warning break-words">{t('knowledge.marketIndexError', { msg: index.indexError })}</p>}
          {note && <p className={note.kind === 'err' ? 'text-[11px] text-error break-words' : 'text-[11px] text-success break-words'}>{note.text}</p>}
        </div>
      )}

      <div className="flex-1 flex min-h-0 min-w-0">
        <KnowledgePackList packs={packs} selectedId={selId} onSelect={setSelId} />
        <KnowledgePackDetail
          data={detail}
          loading={detailLoading}
          error={detailError}
          busy={busy}
          onInstall={() => detail && askOnlineInstall(detail)}
          onUninstall={() => detail && askUninstall(detail)}
        />
      </div>

      {pending && (
        <PackConfirmDialog
          open
          danger={pending.danger}
          title={pending.title}
          body={pending.body}
          confirmLabel={pending.confirmLabel}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => { const p = pending; setPending(null); p.run() }}
        />
      )}

      {conflict && (
        <PackConflictDialog
          packId={conflict.packId}
          conflicts={conflict.conflicts}
          options={conflict.options}
          busy={busy}
          onCancel={() => { setConflict(null); setAttempt(null); setNote({ kind: 'ok', text: t('knowledge.marketConflictKept') }) }}
          onChoose={(mode) => { const a = attempt; setConflict(null); if (a) void doInstall(a, mode) }}
        />
      )}

      {exportOpen && (
        <PackExportDialog
          spaces={(spaces ?? []).filter(s => s.writable)}
          onDone={(msg) => setNote({ kind: 'ok', text: msg })}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  )
}
