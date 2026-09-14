// src/components/knowledge/KnowledgeTrashDialog.tsx —— 回收站（「最近删除」）（2026-09-14）
//
// 设计见 .yfw-spec/knowledge-trash/spec.md。三条交互取舍：
//
// 1) **不做自动清理**（用户明确选定）：回收站只在他亲手点「彻底删除 / 清空」时释放。
//    文案里必须写明这一点 —— 否则用户会猜"是不是过几天就没了"，从而不敢用删除。
//
// 2) 「彻底删除」与「清空」用**行内二次确认**，不弹嵌套对话框：嵌套 Dialog 在
//    焦点管理/ESC 冒泡上很难做对（内层 ESC 常常把外层也一起关掉），而这里需要的是
//    "同一处再确认一次" —— 行内切换成两个按钮即可，且上下文（哪一项）不会丢。
//
// 3) 内容已不在磁盘（`available === false`）的条目：**只给「彻底删除」、不画「还原」**。
//    内核在这种情况下会返回 `payload-missing`（HTTP 410）—— 与其让用户点一个必然
//    失败的按钮，不如一开始就不给（并说明原因）。
//
// 数据路径：只调 `useKnowledge` 的 useTrash/restoreTrash/purgeTrash（带缓存失效）。
import { useState } from 'react'
import { ArchiveRestore, Loader2, Trash2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { purgeTrash, restoreTrash, useTrash } from '@/hooks/useKnowledge'
import { formatBytes } from '@/lib/knowledgeMarket'
import type { KnowledgeTrashItem } from '@/lib/knowledgeApi'

export interface KnowledgeTrashDialogProps {
  /** 还原/彻底删除后通知宿主刷新（空间列表与统计都会变） */
  onChanged?: () => void
  /** 触发器形态：侧栏底栏的整行按钮（默认） */
  triggerClassName?: string
}

export function KnowledgeTrashDialog({ onChanged, triggerClassName }: KnowledgeTrashDialogProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // 「最近删除」只在打开时拉取：关着的时候不该有内核进程开销（每次 HTTP = 一个新内核进程），
  // 打开时按需拉还能保证看到的是最新状态（不会展示一个"12 分钟前的缓存"）。
  const trash = useTrash(open)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const items = trash.data?.items ?? []

  const close = () => {
    setOpen(false)
    setConfirming(null)
    setConfirmAll(false)
    setErr(null)
  }

  const doRestore = async (it: KnowledgeTrashItem) => {
    setBusyId(it.trashId)
    setErr(null)
    const r = await restoreTrash(it.trashId)
    setBusyId(null)
    if (!r.ok) { setErr(r.message || r.error); return }
    // 让位改名的如实告知：用户按原名找不到时不该以为还原失败了
    if (r.data.renamed) setErr(t('knowledge.trashRestoredRenamed', { name: r.data.path || r.data.spaceId || '' }))
    onChanged?.()
    trash.refresh()
  }

  const doPurge = async (trashId: string) => {
    setBusyId(trashId)
    setErr(null)
    const r = await purgeTrash({ trashId })
    setBusyId(null)
    setConfirming(null)
    if (!r.ok) { setErr(r.message || r.error); return }
    trash.refresh()
  }

  const doPurgeAll = async () => {
    setBusyId('__all__')
    setErr(null)
    const r = await purgeTrash({ all: true })
    setBusyId(null)
    setConfirmAll(false)
    if (!r.ok) { setErr(r.message || r.error); return }
    trash.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={v => (v ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={triggerClassName
            ?? 'w-full flex items-center gap-1.5 py-0.5 text-[11px] text-tertiary hover:text-primary transition-colors'}
        >
          <Trash2 className="w-3 h-3 shrink-0" />
          <span className="truncate">{t('knowledge.trashTitle')}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5 text-tertiary" />
            {t('knowledge.trashTitle')}
            {items.length > 0 && <span className="text-[10px] text-tertiary tabular-nums">{items.length}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {/* 说明"不会自动清理"是这一屏最重要的一句话（见文件头注释 1） */}
          <p className="text-[10px] text-tertiary">{t('knowledge.trashKeepHint')}</p>

          {trash.loading && !trash.data && (
            <p className="flex items-center gap-1.5 text-[11px] text-tertiary py-3">
              <Loader2 className="w-3 h-3 animate-spin" />{t('common.loading')}
            </p>
          )}

          {trash.error && <p className="text-[10px] text-error">{trash.error}</p>}
          {err && <p className="text-[10px] text-error">{err}</p>}

          {!trash.loading && !items.length && (
            <p className="text-[11px] text-tertiary py-4 text-center">{t('knowledge.trashEmpty')}</p>
          )}

          {items.length > 0 && (
            <ul className="max-h-[320px] overflow-auto divide-y divide-default border-y border-default">
              {items.map(it => (
                <li key={it.trashId} className="py-1.5 flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-primary truncate" title={it.relPath || it.name || it.trashId}>
                      {/* 图标区分"库 / 文档"：整库被删是一整棵目录，用户扫一眼就能分清 */}
                      <span className="micro mr-1">{it.kind === 'space' ? t('knowledge.trashKindSpace') : t('knowledge.trashKindDoc')}</span>
                      {it.name || it.relPath || it.trashId}
                    </p>
                    <p className="text-[10px] text-tertiary truncate">
                      {[it.spaceName, it.fileCount > 1 ? `${it.fileCount} ${t('knowledge.trashFiles')}` : '',
                        formatBytes(it.bytes), formatTime(it.deletedAt)].filter(Boolean).join(' · ')}
                    </p>
                    {!it.available && (
                      <p className="text-[10px] text-warning">{t('knowledge.trashUnavailable')}</p>
                    )}
                  </div>

                  {confirming === it.trashId ? (
                    // 行内二次确认（见文件头注释 2）：文案里带上"不可恢复"
                    <div className="shrink-0 flex items-center gap-1">
                      <span className="text-[10px] text-error">{t('knowledge.trashPurgeConfirm')}</span>
                      <Button variant="danger" size="sm" onClick={() => doPurge(it.trashId)} disabled={busyId === it.trashId}>
                        {busyId === it.trashId && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                        {t('common.confirm')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
                    </div>
                  ) : (
                    <div className="shrink-0 flex items-center gap-1">
                      {/* available=false 时不给「还原」：内核只会返回 payload-missing（410） */}
                      {it.available && (
                        <Button variant="ghost" size="sm" onClick={() => doRestore(it)} disabled={busyId === it.trashId}>
                          {busyId === it.trashId
                            ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            : <ArchiveRestore className="w-3 h-3 mr-1" />}
                          {t('knowledge.trashRestore')}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => { setConfirming(it.trashId); setErr(null) }}>
                        {t('knowledge.trashPurge')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* 无台账的散落目录只报数：它们是回收站里的"孤儿"，内核不允许按 id 删（白名单不匹配） */}
          {(trash.data?.stray ?? 0) > 0 && (
            <p className="text-[10px] text-warning">{t('knowledge.trashStray', { count: trash.data?.stray ?? 0 })}</p>
          )}

          {trash.data?.dir && (
            <p className="text-[10px] text-tertiary truncate" title={trash.data.dir}>{trash.data.dir}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-[10px] text-tertiary tabular-nums">
            {items.length > 0 ? `${formatBytes(trash.data?.bytes ?? 0)}` : ''}
          </span>
          <div className="flex items-center gap-1">
            {confirmAll ? (
              <>
                <span className="text-[10px] text-error">{t('knowledge.trashPurgeAllConfirm', { count: items.length })}</span>
                <Button variant="danger" size="sm" onClick={doPurgeAll} disabled={busyId === '__all__'}>
                  {busyId === '__all__' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                  {t('common.confirm')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmAll(false)}>{t('common.cancel')}</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={close}>{t('common.close')}</Button>
                <Button
                  variant="ghost" size="sm"
                  // 空回收站不给「清空」：点了也没事，但按钮存在本身会让人以为里面有东西
                  disabled={!items.length}
                  onClick={() => { setConfirmAll(true); setErr(null) }}
                >
                  {t('knowledge.trashPurgeAll')}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** ISO 时间 → `MM-DD HH:mm`（回收站里同一天的条目最多，省掉年份更易扫读；完整值在 title 里） */
function formatTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
