// src/components/knowledge/KnowledgeNewMenu.tsx —— 左栏「新建笔记」入口 + 就地命名浮层
//
// 交互选择：**不用 `window.prompt`**（Electron 渲染进程里它会阻塞整个窗口、且无法走主题/切角样式），
// 改为"切角钮 → 就地浮层"两步：浮层用 absolute 挂在按钮下方（本仓库手写浮层的既有做法，
// 见 FileBrowser.tsx:180-225 的 fixed 右键菜单；`ui/` 没有 Popover 组件——spec §11.1）。
//
// 失败路径**一律不抛**：`saveDoc` 返回结构化 `{ok,error}`，重名/非法路径/只读后端给 400/403/404，
// 这里就地显示文案（用户能看到"为什么没建成"），而不是让面板白屏或抛进控制台。
// 前端先用 `normalizeNoteName` 拦一遍常见误输入，只是为了给出更清楚的中文提示——后端仍是兜底。
import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Button, Tooltip } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import type { KnowledgeSpace } from '@/lib/knowledgeApi'
import { saveDoc } from '@/hooks/useKnowledge'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { normalizeNoteName, resolveDocId } from '@/lib/knowledgeTree'

export interface KnowledgeNewMenuProps {
  /** 当前空间（null = 未选，按钮禁用） */
  space: KnowledgeSpace | null
}

export function KnowledgeNewMenu({ space }: KnowledgeNewMenuProps) {
  const { t } = useTranslation()
  const setDocId = useKnowledgeStore(s => s.setDocId)
  const setView = useKnowledgeStore(s => s.setView)
  const view = useKnowledgeStore(s => s.view)

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 只读空间（writable === false）禁用新建：UI 先拦（spec §8「UI 禁用 + 后端 403 双保险」）
  const disabled = !space || space.writable === false

  const submit = async () => {
    if (!space || busy) return
    const parsed = normalizeNoteName(name)
    if (!parsed.ok) {
      setError(parsed.reason === 'empty' ? t('knowledge.newNoteEmpty') : t('knowledge.newNoteInvalid'))
      return
    }
    setBusy(true)
    setError(null)
    // 内容带标题行：阅读视图首屏不是空白（标题也进内核索引，搜标题即可命中）
    const res = await saveDoc({ space: space.id, path: parsed.path, content: `# ${parsed.title}\n` })
    setBusy(false)
    if (!res.ok) {
      setError(t('knowledge.newNoteFailed', { msg: res.error }))
      return
    }
    setDocId(res.data.docId || resolveDocId(space.id, parsed.path))
    // 图谱/搜索是非文档型视图：建完就该看到新文档，否则像"点创建没反应"（同 Tree 的点击规则）
    if (view !== 'read' && view !== 'edit') setView('read')
    setName('')
    setOpen(false)
  }

  return (
    <div className="relative shrink-0">
      <Tooltip content={t('knowledge.actionNewNote')} side="bottom">
        {/* 设计语言：新建钮 = 6px 单对角切角细线框（与 PanelToolbar 的新建钮同规格） */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('knowledge.actionNewNote')}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen(o => !o); setError(null) }}
          className="cut-xs !h-[22px] !w-[22px] hover:text-primary"
        >
          <span className="ci !bg-transparent flex items-center justify-center w-full h-full">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          </span>
        </Button>
      </Tooltip>

      {open && !disabled && (
        <form
          onSubmit={(e) => { e.preventDefault(); void submit() }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setError(null) } }}
          className="absolute right-0 top-[24px] z-30 w-[212px] cut-sm"
        >
          <div className="ci p-2 space-y-1.5">
            <p className="micro">{t('knowledge.newNoteTitle')}</p>
            <div className="cut-xs focusable">
              <input
                autoFocus
                value={name}
                onChange={(e) => { setName(e.target.value); setError(null) }}
                placeholder={t('knowledge.newNoteName')}
                aria-label={t('knowledge.newNoteName')}
                className="ci w-full !bg-transparent px-2 py-1 text-[11px] text-primary placeholder:text-tertiary outline-none"
              />
            </div>
            <p className="text-[10px] text-tertiary">{t('knowledge.newNoteHint')}</p>
            {error && <p className="text-[10px] text-error break-all">{error}</p>}
            <div className="flex items-center gap-1 justify-end">
              <Button type="button" variant="ghost" size="xs" onClick={() => { setOpen(false); setError(null) }}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="primary" size="xs" disabled={busy}>
                {t('knowledge.actionCreate')}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}
