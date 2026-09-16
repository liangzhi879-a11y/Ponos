// src/components/rail/SessionDistillDialog.tsx —— 「蒸馏到知识库」对话框（2026-09-15，清单 P1）
//
// spec：docs/superpowers/specs/2026-09-15-session-distill-design.md
//
// 这个组件只做三件事：**取全量正文 → 展示将要写入的空间/路径 → 调唯一写入口**。
// 所有判断（路径生成、既有文件复用、超长裁剪、错误文案）都在 `src/lib/sessionDistill.ts`
// 的纯函数里（`.tsx` 无法被 `node --test` import，判断写在这里就等于零覆盖）。
//
// 三个刻意的设计：
//  1. **正文取转录而不是内存副本**：persist 剥掉 messages、内存还会按上限淘汰，
//     而默认加载的转录是**展示级裁剪**过的（crop:true）。拿它蒸馏 = 静默丢内容。
//  2. **必须走 `saveDoc`**（而不是 api.writeDoc）：写后要失效 tree/search 等缓存，
//     否则用户切到知识面板看不到刚蒸的东西，会以为失败再蒸一遍。
//  3. **409/无法取版本时都不自动覆盖**：`force` 只在用户点了「覆盖」之后才传 ——
//     知识空间目录是共享的（Obsidian/VSCode 会改同一批 md），静默覆盖会毁掉别人的改动。
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Eye, EyeOff, Library, Loader2 } from 'lucide-react'
import {
  Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader,
  DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
  ScrollArea, Switch,
} from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useViewStore } from '@/stores/viewStore'
import { useDoc, useSpaces, useTree, saveDoc } from '@/hooks/useKnowledge'
import { loadConversationMessages } from '@/lib/transcriptLoader'
import {
  DISTILL_DIR, describeDistillError, formatStamp, pickDefaultDistillSpace, planDistill,
  type DistillTarget,
} from '@/lib/sessionDistill'
import type { Conversation, Message } from '@/types'

/** 上次选择的目标空间（用户偏好，不是数据）。放在 localStorage 而不是 store：
 *  它只被本对话框消费，进 global store 会让每个 store 订阅者跟着重建。 */
const LAST_SPACE_KEY = 'yfworking-distill-space'
const EXT_KEY_PREFIX = 'yfworking-chat-ext-'

export interface SessionDistillDialogProps {
  /** 被蒸馏的会话（非空；宿主只在打开时挂载本组件，故空格列表请求不会在启动时白跑） */
  conversation: Conversation
  onClose: () => void
}

function readLastSpace(): string | null {
  try { return window.localStorage.getItem(LAST_SPACE_KEY) } catch { return null }
}

export function SessionDistillDialog({ conversation, onClose }: SessionDistillDialogProps) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<Message[] | null>(null)
  /** 正文来源说明（内存副本/读不到）：必须让用户知道自己在蒸的是不是完整内容 */
  const [sourceNote, setSourceNote] = useState<'transcript' | 'memory' | 'empty'>('transcript')
  const [spaceId, setSpaceId] = useState('')
  const [includeThinking, setIncludeThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  /** 复用既有文件但取不到 mtime（版本不可判）⇒ 必须显式确认才能覆盖 */
  const [needForce, setNeedForce] = useState(false)
  const [result, setResult] = useState<{ spaceName: string; docId: string; path: string; bytes: number; created: boolean } | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const loadToken = useRef(0)

  const spacesRes = useSpaces()
  const spaces = spacesRes.data
  /** 只读空间（pack-*）不进候选：UI 预判 + 后端 403 双保险（判据仍以后端为准） */
  const targets = useMemo(() => (spaces ?? []).filter(s => s.writable !== false), [spaces])

  // 目标目录列举：既用来识别"这篇会话蒸过没"（幂等复用），也决定是否走 mtime 冲突检测
  const tree = useTree(spaceId || null, DISTILL_DIR)
  const entries = useMemo(() => tree.data ?? [], [tree.data])

  const plan = useMemo(
    () => (spaceId && messages ? planDistill({ conversation, messages, spaceId, entries, options: { includeThinking } }) : null),
    [conversation, messages, spaceId, entries, includeThinking],
  )
  // 复用既有文件时读它的 mtime（冲突检测的锚点）；新建时 docId 传 null（不发请求）
  const existingDoc = useDoc(plan?.reused ? plan.docId : null)
  const existingMtime = typeof existingDoc.data?.mtime === 'number' ? existingDoc.data.mtime : undefined

  // —— 打开即加载全量正文（crop:false, tailFirst:false = 完整内容）——
  useEffect(() => {
    const token = ++loadToken.current
    setMessages(null)
    setSourceNote('transcript')
    setResult(null)
    setError(null)
    setConflict(false)
    setNeedForce(false)
    void (async () => {
      let ext: Message[] | null = null
      try {
        const raw = window.localStorage.getItem(EXT_KEY_PREFIX + conversation.id)
        if (raw) ext = JSON.parse(raw) as Message[]
      } catch { /* 脏数据不影响主路径 */ }
      // 顺序与 chatExport 一致：内核转录（完整）→ 本地 ext 兜底（导入/迁移会话）
      let loaded: Message[] = []
      try {
        loaded = await loadConversationMessages(
          { sessionIds: conversation.sessionIds, cwd: conversation.cwd, extMessages: ext },
          { tailFirst: false, crop: false },
        )
      } catch { loaded = [] }
      if (token !== loadToken.current) return   // 期间用户换了会话/关了窗：丢弃这次结果
      const inMemory = conversation.messages ?? []
      const use = loaded.length ? loaded : inMemory
      setMessages(use)
      // 转录读不到而回落到内存副本时**必须出声**：内存副本可能被淘汰/可能是裁剪过的展示级内容
      setSourceNote(use.length === 0 ? 'empty' : loaded.length ? 'transcript' : 'memory')
    })()
  }, [conversation])

  // —— 目标空间默认值（上次选择 → 用户空间 → 会话记忆 → 任一可写）——
  useEffect(() => {
    if (spaceId || !spaces) return
    const pick = pickDefaultDistillSpace(targets, readLastSpace())
    if (pick) setSpaceId(pick.id)
  }, [spaces, targets, spaceId])

  const targetSpace: DistillTarget | null = useMemo(
    () => (spaces ?? []).find(s => s.id === spaceId) ?? null,
    [spaces, spaceId],
  )

  // 派生状态统一放在动作函数**之前**：动作里读它们时不受 TDZ 影响（顺序变了的回归会以运行时报错出现）
  const messagesLoading = messages === null
  /** 既有文件的版本信息还在读 ⇒ 先别让用户点（否则会把"还没读到版本"误当成"版本不可判"而弹确认） */
  const existingPending = !!plan?.reused && existingDoc.loading
  const canWrite = !!plan && !!targetSpace && !busy && !messagesLoading && !existingPending
    && (messages?.length ?? 0) > 0 && !result

  const selectSpace = (id: string) => {
    setSpaceId(id)
    setResult(null)
    setError(null)
    setConflict(false)
    setNeedForce(false)
    try { window.localStorage.setItem(LAST_SPACE_KEY, id) } catch { /* 隐私模式下静默 */ }
  }

  /** 写入。`force` 只由用户的显式「覆盖」动作传进来 —— 默认路径绝不动别人的改动。 */
  const write = async (force: boolean) => {
    if (!plan || !targetSpace) return
    setBusy(true)
    setError(null)
    setConflict(false)
    setNeedForce(false)
    const opts = {
      space: plan.spaceId,
      path: plan.path,
      content: plan.content,
      // 只有复用既有文件、且读到了版本时才带 mtime（新建文件没有"预期版本"可言）
      ...(plan.reused && existingMtime !== undefined ? { mtime: existingMtime } : {}),
      ...(force ? { force: true } : {}),
    }
    const r = await saveDoc(opts)
    setBusy(false)
    if (!r.ok) {
      if (r.status === 409) { setConflict(true); return }   // 交用户决策，绝不自动覆盖
      setError(describeDistillError(r.status, r.error, targetSpace))
      return
    }
    setResult({
      spaceName: targetSpace.name || targetSpace.id,
      docId: r.data.docId || plan.docId,
      path: plan.path,
      bytes: plan.bytes,
      created: !plan.reused,
    })
  }

  /** 点「开始蒸馏」：复用既有文件但版本不可判时先拦一道（见 needForce 注释） */
  const onConfirm = () => {
    if (!plan || !targetSpace || existingPending) return
    if (plan.reused && existingMtime === undefined) { setNeedForce(true); return }
    void write(false)
  }

  /** 结果页的「在知识库中打开」：一次写完 store（分次写会出现"已换空间、docId 还是旧空间"的中间帧） */
  const openInKnowledge = () => {
    if (!result || !plan) return
    useKnowledgeStore.getState().setSpace(plan.spaceId)
    useKnowledgeStore.getState().setDocId(result.docId)
    useKnowledgeStore.getState().setView('read')
    useViewStore.getState().enterWork('knowledge')
    onClose()
  }

  const bytesText = plan ? `${Math.round(plan.bytes / 1024)} KB` : '—'

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('distill.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-[11px] text-tertiary leading-relaxed">{t('distill.subtitle')}</p>

          {/* 目标空间 + 路径：写入前必须看得见"写到哪"，否则用户只能事后去树里找 */}
          <div className="cut-sm">
            <div className="ci p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-secondary shrink-0">{t('distill.targetSpace')}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={!targets.length}
                      aria-label={t('distill.targetSpace')}
                      className="flex-1 min-w-0 flex items-center gap-1 cut-xs border border-default px-2 py-1 text-[11px] text-primary hover:border-brand-500/60 disabled:opacity-50"
                    >
                      <Library className="w-3 h-3 shrink-0 text-tertiary" />
                      <span className="truncate">{targetSpace?.name ?? t('distill.spaceNone')}</span>
                      <ChevronDown className="w-3 h-3 shrink-0 text-tertiary" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[228px]">
                    <DropdownMenuLabel className="micro">{t('distill.targetSpace')}</DropdownMenuLabel>
                    {targets.map(s => (
                      <DropdownMenuItem key={s.id} className="text-[11px]" onSelect={() => selectSpace(s.id)}>
                        <span className="flex-1 min-w-0 truncate">{s.name || s.id}</span>
                        <span className="shrink-0 text-[10px] text-tertiary tabular-nums">{s.docCount ?? ''}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {!spacesRes.loading && !targets.length && (
                <p className="text-[10px] text-warning leading-relaxed">{t('distill.spaceNoneHint')}</p>
              )}

              {plan && (
                <>
                  <div className="flex items-start gap-2">
                    <span className="text-[11px] text-secondary shrink-0">{t('distill.path')}</span>
                    <code className="flex-1 min-w-0 text-[11px] text-primary break-all">{plan.path}</code>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-[11px] text-secondary shrink-0">{t('distill.docId')}</span>
                    <code className="flex-1 min-w-0 text-[10px] text-tertiary break-all">{plan.docId}</code>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-tertiary">
                    <span>{t('distill.size')} {bytesText}</span>
                    <span>{plan.reused ? t('distill.reused') : t('distill.fresh')}</span>
                  </div>
                  {plan.truncated && (
                    <p className="text-[10px] text-warning">{t('distill.truncated', { n: plan.omitted })}</p>
                  )}
                </>
              )}

              {spaceId && tree.error && !plan?.reused && (
                <p className="text-[10px] text-tertiary">{t('distill.dirNew')}</p>
              )}

              <label className="flex items-center gap-2 text-[11px] text-secondary">
                <Switch checked={includeThinking} onCheckedChange={setIncludeThinking} />
                <span>{t('distill.includeThinking')}</span>
                <span className="text-[10px] text-tertiary">{t('distill.includeThinkingHint')}</span>
              </label>
            </div>
          </div>

          {/* 正文来源与体积：蒸的是不是完整内容，用户有权先知道 */}
          {messagesLoading && (
            <p className="flex items-center gap-1.5 text-[11px] text-tertiary">
              <Loader2 className="w-3 h-3 animate-spin" /> {t('distill.loadingMessages')}
            </p>
          )}
          {sourceNote === 'memory' && messages?.length ? (
            <p className="text-[10px] text-warning leading-relaxed">{t('distill.partialMessages')}</p>
          ) : null}
          {sourceNote === 'empty' && !messagesLoading ? (
            <p className="text-[11px] text-warning leading-relaxed">{t('distill.emptyMessages')}</p>
          ) : null}

          {plan && messages?.length ? (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setShowPreview(v => !v)}
                className="flex items-center gap-1 text-[11px] text-secondary hover:text-primary transition-colors"
              >
                {showPreview ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {showPreview ? t('distill.previewHide') : t('distill.preview')}
              </button>
              {showPreview && (
                <ScrollArea className="max-h-52 cut-xs border border-default">
                  <pre className="p-2 text-[10px] text-tertiary whitespace-pre-wrap break-all">{plan.content}</pre>
                </ScrollArea>
              )}
            </div>
          ) : null}

          {conflict && plan && (
            <div className="cut-sm">
              <div className="ci p-2.5 space-y-1.5 border border-warning/50">
                <p className="flex items-center gap-1.5 text-[11px] text-warning">
                  <AlertTriangle className="w-3.5 h-3.5" /> {t('distill.conflictTitle')}
                </p>
                <p className="text-[10px] text-secondary leading-relaxed">{t('distill.conflictBody')}</p>
              </div>
            </div>
          )}
          {needForce && plan && (
            <div className="cut-sm">
              <div className="ci p-2.5 space-y-1.5 border border-warning/50">
                <p className="flex items-center gap-1.5 text-[11px] text-warning">
                  <AlertTriangle className="w-3.5 h-3.5" /> {t('distill.needForceTitle')}
                </p>
                <p className="text-[10px] text-secondary leading-relaxed">{t('distill.needForceBody')}</p>
              </div>
            </div>
          )}

          {error && <p className="text-[11px] text-error leading-relaxed break-all">{error}</p>}

          {result && (
            <div className="cut-sm">
              <div className="ci p-2.5 space-y-1 border border-brand-500/40">
                <p className="text-[11px] text-primary">
                  {result.created ? t('distill.doneCreated') : t('distill.doneUpdated')}
                </p>
                <p className="text-[10px] text-tertiary break-all">
                  {result.spaceName} · {result.path} · {Math.round(result.bytes / 1024)} KB
                </p>
                <p className="text-[10px] text-tertiary">
                  {t('distill.convUpdated')} {formatStamp(conversation.updatedAt)}
                </p>
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {error || conflict || needForce ? (
            <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          ) : null}
          {result ? (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</Button>
              <Button variant="primary" size="sm" onClick={openInKnowledge}>{t('distill.openInKnowledge')}</Button>
            </>
          ) : conflict || needForce ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void write(true)}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {t('distill.overwrite')}
            </Button>
          ) : (
            <Button variant="primary" size="sm" disabled={!canWrite} onClick={onConfirm}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {busy ? t('distill.writing') : t('distill.confirm')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
