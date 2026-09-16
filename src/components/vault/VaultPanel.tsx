// src/components/vault/VaultPanel.tsx —— 密码库面板（挂在个人信息窗口的「密码库」标签页）
//
// spec：docs/superpowers/specs/2026-09-15-password-vault-design.md
//
// 界面侧的三条纪律：
//   ① 明文默认不可见：列表来自 vaultApi（本身不含 password）；只有用户点「显示」才单条
//      reveal，且自动隐藏——避免"打开面板即一览无余"的肩窥面（T3）。
//   ② 复制走 id 不走文本：`copyVaultEntry(id)` 让主进程自己 reveal→写剪贴板，
//      明文压根不进入本组件（少一份渲染进程内存里的明文）。
//   ③ 失败态与空库**必须分开**：list 失败时绝不能渲染"暂无条目"——那会让用户以为
//      密码丢了，进而重新录入甚至覆盖坏文件。unavailable（环境）与 corrupt（文件）
//      给不同的引导文案。
//
// 数据访问全部走 `@/lib/vaultApi`，不直接碰 window.yfworkingVault：这样"浏览器 dev
// 无 bridge"的降级路径由数据层统一处理，组件不必到处判空。
import { useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound, Search, Plus, Eye, EyeOff, Copy, Pencil, Trash2, ShieldAlert, RefreshCw, X, Check } from 'lucide-react'
import { Button, Input, Textarea } from '@/components/ui'
import {
  copyVaultEntry,
  describeVaultError,
  filterEntries,
  isVaultAvailable,
  loadVault,
  removeVaultEntry,
  revealVaultEntry,
  saveVaultEntry,
  sortEntries,
  validateEntryInput,
} from '@/lib/vaultApi'
import type { VaultEntryMeta, VaultErrorCode, VaultStatus } from '@/types'

/** 明文显示自动隐藏时长：够用户抄写/比对，又不至于长期裸露在屏幕上 */
const REVEAL_HIDE_MS = 20_000

interface EditorState {
  id?: string
  name: string
  url: string
  username: string
  password: string
  notes: string
  tags: string
}

const EMPTY_EDITOR: EditorState = { name: '', url: '', username: '', password: '', notes: '', tags: '' }

export function VaultPanel() {
  const [entries, setEntries] = useState<VaultEntryMeta[]>([])
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [listError, setListError] = useState<{ code: VaultErrorCode; message: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [revealed, setRevealed] = useState<{ id: string; password: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hostAvailable = isVaultAvailable()

  const refresh = async () => {
    setLoading(true)
    const { status: st, list } = await loadVault()
    setStatus(st)
    if (list.ok) {
      setEntries(list.entries)
      setListError(null)
    } else {
      // 失败态：清空列表并挂错误，不拿旧数据冒充现状
      setEntries([])
      setListError({ code: (list.error || 'corrupt') as VaultErrorCode, message: describeVaultError(list.error, list.message) })
    }
    setLoading(false)
  }

  useEffect(() => { void refresh() }, [])

  // 明文自动隐藏（组件卸载也要清，避免定时器泄漏）
  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current) }, [])

  const visible = useMemo(() => sortEntries(filterEntries(entries, query)), [entries, query])
  const writable = hostAvailable && !listError && status?.available !== false

  const hideReveal = () => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
    setRevealed(null)
  }

  const toggleReveal = async (id: string) => {
    if (revealed?.id === id) { hideReveal(); return }
    const r = await revealVaultEntry(id)
    if (!r.ok) {
      setNotice(describeVaultError(r.error, r.message))
      return
    }
    setRevealed({ id, password: r.password })
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setRevealed(null), REVEAL_HIDE_MS)
  }

  const copy = async (id: string) => {
    const r = await copyVaultEntry(id)
    if (!r.ok) { setNotice(describeVaultError(r.error, r.message)); return }
    setNotice(`已复制，将在 ${Math.round(r.clearInMs / 1000)} 秒后清空剪贴板`)
  }

  const doDelete = async (id: string) => {
    const r = await removeVaultEntry(id)
    setConfirmDelete(null)
    if (!r.ok) { setNotice(describeVaultError(r.error, r.message)); return }
    if (revealed?.id === id) hideReveal()
    setNotice('已删除')
    void refresh()
  }

  const startEdit = (e: VaultEntryMeta) => {
    setFormError('')
    setEditor({ id: e.id, name: e.name, url: e.url, username: e.username, password: '', notes: e.notes, tags: e.tags.join(', ') })
  }

  const submit = async () => {
    if (!editor) return
    setFormError('')
    const tags = editor.tags.split(',').map(t => t.trim()).filter(Boolean)
    const input = {
      id: editor.id,
      name: editor.name,
      url: editor.url,
      username: editor.username,
      // 编辑态留空 = 保持原密码 ⇒ **必须省略该字段**；传 '' 会被主进程理解为"清空密码"
      ...(editor.password ? { password: editor.password } : (editor.id ? {} : { password: '' })),
      notes: editor.notes,
      tags,
    }
    const invalid = validateEntryInput(input)
    if (invalid) { setFormError(invalid); return }
    const r = await saveVaultEntry(input)
    if (!r.ok) { setFormError(describeVaultError(r.error, r.message)); return }
    setEditor(null)
    setNotice(editor.id ? '已更新' : '已保存')
    void refresh()
  }

  // ---------------- 失败态（与空库严格区分） ----------------
  if (!hostAvailable) {
    return (
      <Shell>
        <div className="px-6 py-4">
          <ErrorState
            title="当前环境不支持密码库"
            detail="密码库依赖桌面端的安全存储（仅桌面窗口可用）。请在本应用的桌面窗口中使用。"
          />
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      {/* 工具条 */}
      <div className="px-6 py-3 border-b flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="w-3.5 h-3.5 text-tertiary absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索名称 / 用户名 / 地址 / 标签"
            className="h-8 text-sm pl-8"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading} title="重新读取">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
        <div className="flex-1" />
        <Button
          variant="primary"
          size="sm"
          disabled={!writable}
          onClick={() => { setFormError(''); setEditor({ ...EMPTY_EDITOR }) }}
        >
          <Plus className="w-3.5 h-3.5 mr-1" />新增
        </Button>
      </div>

      {notice && (
        <div className="px-6 py-2 text-xs text-secondary border-b flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-success shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice('')} className="text-tertiary hover:text-primary" aria-label="关闭提示">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 可用性提示：必须明说"不会退化为明文"，否则用户以为只是功能没做 */}
      {status && !status.available && !listError && (
        <div className="px-6 py-2.5 border-b bg-warning/10 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <span className="text-xs text-warning leading-relaxed">
            系统安全存储当前不可用，密码库无法读写。为保护你的密码，本应用不会退化为明文保存。
          </span>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {listError ? (
          <ErrorState
            title={listError.code === 'unavailable' ? '系统安全存储不可用' : '密码库文件读不出来'}
            detail={listError.message}
            hint={
              listError.code === 'unavailable'
                ? '常见于 Linux 缺少系统钥匙串服务。此时无法读写密码库，但已有数据不会丢失。'
                : '可能文件被外部改动，或换了 Windows 账户/系统。原文件已保留未改动，请勿删除后重建，以免丢失已保存的密码。'
            }
          />
        ) : loading ? (
          <div className="text-sm text-tertiary py-8 text-center">读取中…</div>
        ) : visible.length === 0 ? (
          entries.length === 0 ? (
            <EmptyState onCreate={writable ? () => { setFormError(''); setEditor({ ...EMPTY_EDITOR }) } : undefined} />
          ) : (
            <div className="text-sm text-tertiary py-8 text-center">没有匹配「{query}」的条目</div>
          )
        ) : (
          <div className="space-y-1.5">
            {visible.map(e => (
              <EntryRow
                key={e.id}
                entry={e}
                revealedPassword={revealed?.id === e.id ? revealed.password : null}
                confirming={confirmDelete === e.id}
                disabled={!writable}
                onToggleReveal={() => void toggleReveal(e.id)}
                onCopy={() => void copy(e.id)}
                onEdit={() => startEdit(e)}
                onAskDelete={() => setConfirmDelete(e.id)}
                onCancelDelete={() => setConfirmDelete(null)}
                onConfirmDelete={() => void doDelete(e.id)}
              />
            ))}
          </div>
        )}
      </div>

      {editor && (
        <Editor
          state={editor}
          error={formError}
          onChange={patch => setEditor(s => (s ? { ...s, ...patch } : s))}
          onCancel={() => { setEditor(null); setFormError('') }}
          onSubmit={() => void submit()}
        />
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-4 border-b flex items-center gap-2">
        <KeyRound className="w-5 h-5 text-brand-500" />
        <span className="text-base font-semibold text-primary">密码库</span>
        <span className="text-[11px] text-tertiary ml-1">由系统安全存储加密保存在本机</span>
      </div>
      {children}
    </div>
  )
}

function ErrorState({ title, detail, hint }: { title: string; detail: string; hint?: string }) {
  return (
    <div className="border border-subtle rounded-lg p-4 bg-elevated/40">
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <ShieldAlert className="w-4 h-4 text-warning" />
        {title}
      </div>
      <p className="text-xs text-secondary mt-2 leading-relaxed">{detail}</p>
      {hint && <p className="text-xs text-tertiary mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="text-center py-10">
      <KeyRound className="w-8 h-8 text-tertiary mx-auto" />
      <p className="text-sm text-secondary mt-3">还没有保存任何账号密码</p>
      <p className="text-xs text-tertiary mt-1">添加后可在本机加密保存，需要时一键复制</p>
      {onCreate && (
        <Button variant="primary" size="sm" className="mt-4" onClick={onCreate}>
          <Plus className="w-3.5 h-3.5 mr-1" />添加第一条
        </Button>
      )}
    </div>
  )
}

function EntryRow({
  entry, revealedPassword, confirming, disabled,
  onToggleReveal, onCopy, onEdit, onAskDelete, onCancelDelete, onConfirmDelete,
}: {
  entry: VaultEntryMeta
  revealedPassword: string | null
  confirming: boolean
  disabled: boolean
  onToggleReveal: () => void
  onCopy: () => void
  onEdit: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  return (
    <div className="border border-subtle rounded-lg px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-primary truncate">{entry.name}</span>
            {entry.tags.map(t => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-600 shrink-0">{t}</span>
            ))}
          </div>
          <div className="text-[11px] text-tertiary truncate mt-0.5">
            {entry.username || '—'}{entry.url ? ` · ${entry.url}` : ''}
          </div>
        </div>

        {/* 明文区：只在点开时出现，且会自动隐藏 */}
        <div className="shrink-0 font-mono text-xs text-primary min-w-[7rem] text-right">
          {revealedPassword !== null
            ? (revealedPassword || <span className="text-tertiary">（空）</span>)
            : <span className="text-tertiary tracking-widest">••••••••</span>}
        </div>

        <div className="shrink-0 flex items-center gap-0.5">
          <IconBtn title={revealedPassword !== null ? '隐藏' : '显示'} onClick={onToggleReveal}>
            {revealedPassword !== null ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </IconBtn>
          <IconBtn title="复制密码" onClick={onCopy}><Copy className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title="编辑" onClick={onEdit} disabled={disabled}><Pencil className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title="删除" onClick={onAskDelete} disabled={disabled} danger><Trash2 className="w-3.5 h-3.5" /></IconBtn>
        </div>
      </div>

      {entry.notes && revealedPassword === null && (
        <p className="text-[11px] text-tertiary mt-1.5 truncate">{entry.notes}</p>
      )}

      {confirming && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-error">确定删除「{entry.name}」？此操作不可撤销。</span>
          <Button variant="ghost" size="sm" onClick={onConfirmDelete} className="text-error">删除</Button>
          <Button variant="ghost" size="sm" onClick={onCancelDelete}>取消</Button>
        </div>
      )}
    </div>
  )
}

function IconBtn({ children, title, onClick, disabled, danger }: {
  children: React.ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`w-7 h-7 rounded flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        danger ? 'text-tertiary hover:text-error hover:bg-error/10' : 'text-tertiary hover:text-primary hover:bg-hover'
      }`}
    >
      {children}
    </button>
  )
}

function Editor({ state, error, onChange, onCancel, onSubmit }: {
  state: EditorState
  error: string
  onChange: (patch: Partial<EditorState>) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <div className="border-t px-6 py-4 bg-elevated/30">
      <div className="text-sm font-medium text-primary mb-3">{state.id ? '编辑条目' : '新增条目'}</div>
      <div className="grid grid-cols-2 gap-3 max-w-2xl">
        <Field label="名称（必填）">
          <Input value={state.name} onChange={e => onChange({ name: e.target.value })} placeholder="如：某系统后台" className="h-8 text-sm" />
        </Field>
        <Field label="用户名 / 账号">
          <Input value={state.username} onChange={e => onChange({ username: e.target.value })} className="h-8 text-sm" />
        </Field>
        <Field label="地址（可选）">
          <Input value={state.url} onChange={e => onChange({ url: e.target.value })} placeholder="https://…" className="h-8 text-sm" />
        </Field>
        <Field label={state.id ? '密码（留空则保持原密码）' : '密码（必填）'}>
          <Input
            type="password"
            value={state.password}
            onChange={e => onChange({ password: e.target.value })}
            placeholder={state.id ? '不修改请留空' : ''}
            className="h-8 text-sm"
            autoComplete="new-password"
          />
        </Field>
        <Field label="标签（逗号分隔）">
          <Input value={state.tags} onChange={e => onChange({ tags: e.target.value })} placeholder="工作, 财务" className="h-8 text-sm" />
        </Field>
        <Field label="备注">
          <Textarea value={state.notes} onChange={e => onChange({ notes: e.target.value })} className="min-h-[32px] h-8 text-sm resize-y" />
        </Field>
      </div>
      <div className="flex items-center gap-3 mt-4">
        <Button variant="primary" size="sm" onClick={onSubmit}>{state.id ? '保存修改' : '保存'}</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-secondary mb-1">{label}</label>
      {children}
    </div>
  )
}
