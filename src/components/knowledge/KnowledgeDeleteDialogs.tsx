// src/components/knowledge/KnowledgeDeleteDialogs.tsx —— 删除确认（条目 / 整库）（2026-09-14）
//
// 设计见 .yfw-spec/knowledge-trash/spec.md。两条纪律：
//
// 1) **两级确认强度**，与不可逆程度对齐：
//    - 删条目：一次「删除」按钮（有回收站兜底，误删可还原）→ 只做说明，不要用户打字。
//    - 删整库：必须**手打库名**。库是"一次操作影响成百篇文档"的单位，且用户自建的库
//      往往就是他的全部资料 —— 普通二次确认在这个量级上太廉价（连点两次就没了）。
//      校验逻辑在 `knowledgeDeleteUi.isSpaceConfirmOk`（纯函数、有单测），
//      真正的裁决仍在内核（`--confirm` 精确比对）。
//
// 2) 组件**受控**（open/onOpenChange 由宿主给）：条目删除的入口在文档视图的工具条上、
//    整库删除的入口在侧栏空间信息栏，两处宿主不同。让本组件自带触发器会导致
//    "同一份确认框被复制两遍"；受控后宿主各自摆按钮、共用一份确认。
//
// 数据路径：只调 `useKnowledge` 的 deleteDoc/deleteSpace（带缓存失效），不直接碰 knowledgeApi。
import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { deleteDoc, deleteSpace } from '@/hooks/useKnowledge'
import { isSpaceConfirmOk } from '@/lib/knowledgeDeleteUi'
import type { KnowledgeDeleteResult, KnowledgeSpace } from '@/lib/knowledgeApi'

export interface DeleteDocDialogProps {
  spaceId: string
  spaceName?: string | null
  /** 空间内相对 .md 路径 */
  path: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 删除成功（宿主据此清空选中文档/刷新视图） */
  onDeleted?: (r: KnowledgeDeleteResult) => void
}

/** 删除单篇文档的确认框（软删除：进回收站，可还原） */
export function DeleteDocDialog({ spaceId, spaceName, path, open, onOpenChange, onDeleted }: DeleteDocDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 每次重新打开都清掉上一次的错误/忙碌态：否则"删失败 → 关掉 → 再打开"会带着旧报错，
  // 用户会以为这次也失败了。
  useEffect(() => {
    if (open) { setBusy(false); setErr(null) }
  }, [open])

  const submit = async () => {
    setBusy(true)
    setErr(null)
    const r = await deleteDoc({ space: spaceId, path })
    setBusy(false)
    if (!r.ok) {
      // 内核的 message 比错误码更有用（会说清"路径必须是相对 .md"之类），优先显示它；
      // 拿不到 message 时退回 i18n 的码译文本（`t('knowledge.deleteErr.' + key)` 宿主侧已兜底）。
      setErr(r.message || r.error)
      return
    }
    onOpenChange(false)
    onDeleted?.(r.data)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-warning" />
            {t('knowledge.deleteDocTitle')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <p className="text-[11px] text-secondary">{t('knowledge.deleteDocHint')}</p>
          <p className="text-[10px] text-tertiary truncate" title={path}>
            {spaceName ? `${spaceName} · ` : ''}{path}
          </p>
          {err && <p className="text-[10px] text-error">{t('knowledge.deleteFailed')}: {err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="sm" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            {t('knowledge.deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface DeleteSpaceDialogProps {
  /** 目标空间（null = 未打开）。用整个对象是因为确认文案要显示库名与文档数 */
  space: KnowledgeSpace | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: (r: KnowledgeDeleteResult) => void
}

/**
 * 删除**整个知识库**的确认框：要求手打库名。
 *
 * 为什么确认框里要复述"含 N 篇文档"：用户对"库"的规模常常没概念，
 * 而数字是让他停下来想一秒的最有效信息。
 */
export function DeleteSpaceDialog({ space, open, onOpenChange, onDeleted }: DeleteSpaceDialogProps) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (open) { setTyped(''); setBusy(false); setErr(null) }
  }, [open])

  const spaceId = space?.id ?? ''
  const ok = isSpaceConfirmOk(typed, spaceId)

  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setErr(null)
    const r = await deleteSpace({ spaceId, confirm: typed.trim() })
    setBusy(false)
    if (!r.ok) { setErr(r.message || r.error); return }
    onOpenChange(false)
    onDeleted?.(r.data)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-error" />
            {t('knowledge.deleteSpaceTitle')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-[11px] text-secondary">
            {t('knowledge.deleteSpaceHint', { name: space?.name ?? spaceId, count: space?.docCount ?? 0 })}
          </p>
          <p className="text-[10px] text-tertiary">{t('knowledge.deleteSpaceRecycleHint')}</p>
          <input
            // 手打库名是防手滑的最后一道：`autoFocus` 让键盘流用户不必再点一次输入框
            autoFocus
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && ok && !busy) void submit() }}
            placeholder={spaceId}
            aria-label={t('knowledge.deleteSpaceInputLabel')}
            className="w-full h-7 px-2 text-[11px] bg-app border border-default rounded-none outline-none focus:border-accent"
          />
          {typed && !ok && (
            <p className="text-[10px] text-warning">{t('knowledge.deleteSpaceMismatch', { name: spaceId })}</p>
          )}
          {err && <p className="text-[10px] text-error">{t('knowledge.deleteFailed')}: {err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="sm" onClick={submit} disabled={!ok || busy}>
            {busy && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            {t('knowledge.deleteSpaceConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
