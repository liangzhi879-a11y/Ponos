// src/components/knowledge/KnowledgePackDialogs.tsx —— 知识包三张浮层（S4 Task 6）
//
// 为什么单独一个文件：宿主 KnowledgeMarketView 要守 ≤400 行（`scripts/verify-knowledge-gui.mjs`
// 有断言），而这三张浮层各自带表单 / 三选 / 结果展示，塞进宿主必然超行。
//
// **为什么"安装"必须有确认浮层**：安装是往用户数据目录写盘的高危操作（计划硬约束 5）。
// 一键静默安装一旦点错，用户只能靠"事后卸载 + 自己发现"补救；确认浮层把包名 / 版本 / 许可证 /
// 落点（只读空间 `pack-<id>`）一次性摊开，是"不可静默安装"这条约束的实现载体。
//
// 三张浮层的分工：
//   · PackConfirmDialog —— 通用二次确认（安装 / 卸载共用，danger 控制按钮色）
//   · PackConflictDialog —— 403 `kept-user-modified` 的三选（覆盖 / 保留 / 另存为我的空间）。
//     后端此时**一个字节都没写**，所以"保留现状"是零副作用的合法选择。
//   · PackExportDialog —— 供给侧：空间 → pack.json + zip + 可粘贴的清单条目片段。
//     API 调用放在浮层内（结果要就地展示 zipPath / 片段，宿主只需要一行提示），
//     但**不裸 fetch**：一律走 src/lib/knowledgePacksApi.ts。
import { useState } from 'react'
import { AlertTriangle, Package, ShieldAlert } from 'lucide-react'
import {
  Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
  Input,
} from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import type { KnowledgeSpace } from '@/lib/knowledgeApi'
import { exportPack, type PackExportResult } from '@/lib/knowledgePacksApi'
import {
  formatBytes, normalizeConflictOptions, validateExportForm,
  type ExportField, type PackConflictOption,
} from '@/lib/knowledgeMarket'

/** 字段名 → i18n 键（lib 返回字段名而不是文案：lib 层不该知道 i18n） */
const FIELD_ERR_KEY: Record<ExportField, string> = {
  id: 'knowledge.marketExportErrId',
  version: 'knowledge.marketExportErrVersion',
  license: 'knowledge.marketExportErrLicense',
  name: 'knowledge.marketExportErrName',
}

export interface PackConfirmDialogProps {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 通用二次确认。`busy` 期间禁用两个按钮：安装/卸载都是不可重入的操作 */
export function PackConfirmDialog({ open, title, body, confirmLabel, danger, busy, onConfirm, onCancel }: PackConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-xs text-secondary leading-relaxed">{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? t('knowledge.marketBusy') : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface PackConflictDialogProps {
  packId: string
  /** 与台账记录哈希不一致的文件（相对包目录） */
  conflicts: string[]
  /** 后端给的三选（已白名单归一） */
  options: unknown
  busy?: boolean
  onChoose: (option: PackConflictOption) => void
  onCancel: () => void
}

const OPTION_LABEL_KEY: Record<PackConflictOption, string> = {
  overwrite: 'knowledge.marketConflictOverwrite',
  keep: 'knowledge.marketConflictKeep',
  'to-my-space': 'knowledge.marketConflictToSpace',
}

/**
 * 冲突三选。文案里必须明说"未写入任何内容"——否则用户会以为已经装了一半，
 * 于是去点"覆盖"（唯一会动盘的选项）来"修好它"。
 */
export function PackConflictDialog({ packId, conflicts, options, busy, onChoose, onCancel }: PackConflictDialogProps) {
  const { t } = useTranslation()
  const opts = normalizeConflictOptions(options)
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4" />
            {t('knowledge.marketConflictTitle')}
          </DialogTitle>
          <DialogDescription className="text-xs text-secondary leading-relaxed">
            {t('knowledge.marketConflictBody')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <p className="text-[11px] text-tertiary">{packId}</p>
          <ul className="max-h-40 overflow-auto cut-sm">
            <li className="ci p-2 space-y-0.5">
              {conflicts.map((f) => (
                <p key={f} className="text-[11px] text-secondary truncate" title={f}>{f}</p>
              ))}
            </li>
          </ul>
        </DialogBody>
        <DialogFooter className="!justify-between">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('knowledge.marketConflictKeep')}</Button>
          <span className="flex items-center gap-2">
            {opts.filter(o => o !== 'keep').map((o) => (
              <Button
                key={o}
                variant={o === 'overwrite' ? 'danger' : 'secondary'}
                size="sm"
                onClick={() => onChoose(o)}
                disabled={busy}
              >
                {t(OPTION_LABEL_KEY[o])}
              </Button>
            ))}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface PackExportDialogProps {
  /** 只传**可写空间**（只读包空间导出无意义：它本身就是别人的包） */
  spaces: KnowledgeSpace[]
  onDone: (message: string) => void
  onClose: () => void
}

/**
 * 导出浮层。表单校验先用 lib 的 `validateExportForm` 拦一道（与后端同规则），
 * 提交后把 zipPath 与清单条目片段就地展示——**不内置自动 PR 提交**（spec §5：需要凭据的高风险操作）。
 */
export function PackExportDialog({ spaces, onDone, onClose }: PackExportDialogProps) {
  const { t } = useTranslation()
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? '')
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [license, setLicense] = useState('MIT')
  const [name, setName] = useState('')
  const [author, setAuthor] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [bad, setBad] = useState<ExportField[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PackExportResult | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async () => {
    const invalid = validateExportForm({ id, version, license, name })
    setBad(invalid)
    if (invalid.length) return
    setBusy(true); setError(null)
    const r = await exportPack({ spaceId, id: id.trim(), version: version.trim(), license: license.trim(), name: name.trim() || undefined, author: author.trim() || undefined, repo: repo.trim() || undefined })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setResult(r.data)
    const skipped = r.data.skipped?.length || 0
    onDone(t('knowledge.marketExportDone', { path: r.data.zipPath, size: formatBytes(r.data.zipBytes) })
      + (skipped ? ` · ${t('knowledge.marketExportSkipped', { n: skipped })}` : ''))
  }

  /** 片段文本：后端回的是对象（`manifestEntry`），粘进 index.json 时才需要字符串形态 */
  const entryText = (r: PackExportResult) => typeof r.manifestEntry === 'string'
    ? r.manifestEntry
    : JSON.stringify(r.manifestEntry, null, 2)

  const copy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(entryText(result))
      setCopied(true)
    } catch { setError('clipboard unavailable') }
  }

  const row = (label: string, value: string, onChange: (v: string) => void, placeholder = '') => (
    <label className="flex items-center gap-2">
      <span className="w-[68px] shrink-0 text-[11px] text-tertiary">{label}</span>
      <Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="h-7 text-[11px]" />
    </label>
  )

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Package className="w-4 h-4" />
            {t('knowledge.marketExportTitle')}
          </DialogTitle>
          <DialogDescription className="text-xs text-secondary">
            {t('knowledge.marketExportEntry')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          {!spaces.length ? (
            // 只读包空间不可导出（后端 403）：这里提前说清，避免用户把 403 当 bug
            <p className="text-[11px] text-tertiary flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />{t('knowledge.marketExportNoSpace')}
            </p>
          ) : (
            <>
              <label className="flex items-center gap-2">
                <span className="w-[68px] shrink-0 text-[11px] text-tertiary">{t('knowledge.marketExportSpace')}</span>
                <select
                  value={spaceId}
                  onChange={e => setSpaceId(e.target.value)}
                  className="clip-sm h-7 flex-1 min-w-0 bg-elevated border border-default px-1 text-[11px] text-secondary"
                >
                  {spaces.map(s => <option key={s.id} value={s.id}>{s.name}（{s.docCount} {t('knowledge.statDocs')}）</option>)}
                </select>
              </label>
              {row(t('knowledge.marketExportId'), id, setId, 'gaoqi-2026')}
              {row(t('knowledge.marketExportVersion'), version, setVersion, '1.0.0')}
              {row(t('knowledge.marketExportLicense'), license, setLicense, 'MIT')}
              {row(t('knowledge.marketExportName'), name, setName)}
              {row(t('knowledge.marketExportAuthor'), author, setAuthor)}
              {row(t('knowledge.marketExportRepo'), repo, setRepo, 'https://github.com/<owner>/<repo>')}
              {bad.length > 0 && (
                <ul className="space-y-0.5">
                  {bad.map(f => <li key={f} className="text-[11px] text-error">{t(FIELD_ERR_KEY[f])}</li>)}
                </ul>
              )}
              {error && <p className="text-[11px] text-error break-words">{error}</p>}
              {result && (
                <div className="space-y-1">
                  <p className="text-[11px] text-tertiary break-all">{result.zipPath} · {formatBytes(result.zipBytes)} · {result.files} 文件</p>
                  <div className="cut-sm">
                    <div className="ci p-2">
                      <pre className="max-h-40 overflow-auto text-[10px] text-secondary whitespace-pre-wrap break-all">{entryText(result)}</pre>
                      <div className="mt-1 flex justify-end">
                        <Button variant="ghost" size="xs" onClick={copy}>
                          {copied ? t('knowledge.marketExportCopied') : t('knowledge.marketExportCopy')}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.close')}</Button>
          <Button variant="primary" size="sm" onClick={run} disabled={busy || !spaces.length}>
            {busy ? t('knowledge.marketBusy') : t('knowledge.marketExportRun')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
