// src/components/settings/ExperienceDataDialogs.tsx —— 经验数据包的导出/导入浮层（S2 Task 10 从 ExperiencePanel 拆出）
//
// **为什么拆**：spec §10 D4 要求保留导入/导出（经验数据的唯一 GUI 搬运入口，`src/lib/chatExport.ts`
// 也复用同一 IPC），但面板本体被要求收敛到 200 行内——两个浮层含表单/多选/冲突策略，独占约 120 行。
// 按"浮层归浮层、设置项归设置项"拆文件，而不是砍功能。
// 逻辑与 S2 之前完全一致（含"quota 不足不能变成未捕获 rejection"两处历史修复），仅搬位置。
import { useState } from 'react'
import { AlertTriangle, Package } from 'lucide-react'
import { Button } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'

const api = window.yfworkingAPI

const TYPE_LABELS: Record<string, string> = {
  personal: '个人记忆', skill_exp: '技能经验库', skills: '技能库',
  config: '全局配置', chats: '会话历史', project: '项目数据',
}

export function ExportDialog({ lastCwd, chatsJson, onClose, onDone }: { lastCwd: string | null; chatsJson: () => string | null; onClose: () => void; onDone: (m: string) => void }) {
  const [sel, setSel] = useState<Record<string, boolean>>({ personal: true, skill_exp: true, chats: true })
  const [words, setWords] = useState('密码,password,apiKey,secret')
  const [busy, setBusy] = useState(false)
  const [chatsScope, setChatsScope] = useState('all')
  const conversationSets = useChatStore(s => s.conversationSets)

  const run = async () => {
    if (!api) { onDone('未检测到桌面环境（dev 模式无 preload）'); onClose(); return }
    const included = Object.entries(sel).filter(([, v]) => v).map(([k]) => k)
    if (!included.length) return
    setBusy(true)
    let chatsFilter: { conversationIds?: string[]; setId?: string } | null = null
    if (sel.chats && chatsScope.startsWith('set:')) chatsFilter = { setId: chatsScope.slice(4) }
    const res = await api.exportExperience({
      included,
      sensitiveWords: words.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      chatsJson: sel.chats ? chatsJson() : null,
      projectCwd: sel.project ? (lastCwd || null) : null,
      configRedact: true,
      chatsFilter,
    })
    setBusy(false)
    if (!res.ok) { onDone(res.error || '导出失败（可能已取消）'); onClose(); return }
    onDone(`已导出到 ${res.outPath}${res.skipped?.length ? `，跳过 ${res.skipped.length} 项：${res.skipped.map(s => s.reason).join('；')}` : ''}`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'var(--overlay-bg)' }}>
      <div className="w-[420px] cut cut-modal" style={{ filter: 'drop-shadow(var(--modal-drop))' }}>
        <div className="ci p-5" style={{ background: 'var(--modal-bg)' }}>
        <h4 className="text-sm font-semibold text-primary flex items-center gap-1.5 mb-1"><Package className="w-4 h-4" /> 导出经验/数据</h4>
        <p className="text-[10px] text-tertiary mb-4">选择要打包的类型（zip + manifest.json，可在另一台设备导入）</p>
        <div className="space-y-2 mb-4">
          {Object.entries(TYPE_LABELS).map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-xs text-secondary">
              <input type="checkbox" checked={!!sel[id]} onChange={e => setSel({ ...sel, [id]: e.target.checked })} className="accent-brand-500" />
              {label}
            </label>
          ))}
        </div>
        {sel.chats && (
          <div className="mb-4 space-y-1">
            <label className="block text-[10px] text-tertiary mb-1">chats 范围</label>
            <select
              value={chatsScope}
              onChange={e => setChatsScope(e.target.value)}
              className="w-full h-8 rounded-md border border bg-surface px-2 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="all">全部会话</option>
              {conversationSets.map(s => <option key={s.id} value={`set:${s.id}`}>会话集：{s.name}</option>)}
            </select>
          </div>
        )}
        <label className="block text-[10px] text-tertiary mb-1">敏感词过滤（命中条目不导出，逗号分隔）</label>
        <input
          value={words} onChange={e => setWords(e.target.value)}
          className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent mb-1"
        />
        <p className="text-[10px] text-warning/80 mb-4 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> 全局配置导出自动脱敏（不含 authToken）</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" onClick={run} disabled={busy}>{busy ? '打包中…' : '导出'}</Button>
        </div>
        </div>
      </div>
    </div>
  )
}

export function ImportDialog({ lastCwd, onClose, onDone }: { lastCwd: string | null; onClose: () => void; onDone: (m: string) => void }) {
  const [conflict, setConflict] = useState<'skip' | 'overwrite' | 'merge'>('merge')

  const run = async () => {
    if (!api) { onDone('未检测到桌面环境（dev 模式无 preload）'); onClose(); return }
    const res = await api.importExperience({ conflict, projectCwd: lastCwd })
    if (!res.ok) { onDone(res.error || '导入失败（可能已取消）'); onClose(); return }
    let note = ''
    if (res.chats) {
      // 新格式：逐会话合并写回（按 id 去重 + 100 条截断 + 4MB 估算裁剪）
      // zustand persist 写 localStorage 遇到配额不足会 rethrow；捕获后本地数据未变，
      // 错误不能成为 unhandled rejection
      try {
        const r = useChatStore.getState().mergeImportedChats(res.chats)
        note = `新增会话 ${r.addedConversations}${r.droppedOldest ? `，因体积裁剪最旧 ${r.droppedOldest} 个` : ''}`
      } catch {
        note = '，写回失败（体积过大或配额不足），本地会话未变'
      }
    } else if (res.chatStoreJson) {
      // 旧格式：整体接管。不能直写 localStorage——chatStore 的防抖持久化
      // 会在随后用内存旧快照覆盖掉导入数据；必须经 store action 冲刷落盘。
      try {
        if (!useChatStore.getState().importLegacyChatState(res.chatStoreJson)) throw new Error('invalid state')
      } catch (e) { note = '，写回失败（体积过大或配额不足），本地会话未变' }
    }
    onDone(`导入完成：恢复 ${res.restored?.length ?? 0} 项${res.conflicts ? `，跳过冲突 ${res.conflicts} 项` : ''}${note}`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'var(--overlay-bg)' }}>
      <div className="w-[400px] cut cut-modal" style={{ filter: 'drop-shadow(var(--modal-drop))' }}>
        <div className="ci p-5" style={{ background: 'var(--modal-bg)' }}>
        <h4 className="text-sm font-semibold text-primary flex items-center gap-1.5 mb-1"><Package className="w-4 h-4" /> 导入经验/数据包</h4>
        <p className="text-[10px] text-tertiary mb-4">选择 zip 文件后按 manifest 恢复，冲突处理方式：</p>
        <div className="space-y-2 mb-4">
          {([['merge', '合并（条目级去重）'], ['overwrite', '覆盖已有'], ['skip', '跳过已有']] as const).map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-xs text-secondary">
              <input type="radio" name="conflict" checked={conflict === id} onChange={() => setConflict(id)} className="accent-brand-500" />
              {label}
            </label>
          ))}
        </div>
        <p className="text-[10px] text-warning/80 mb-4 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> 导入的个人经验将自动注入后续会话，请仅从可信来源导入</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" onClick={run}>选择 zip 并导入</Button>
        </div>
        </div>
      </div>
    </div>
  )
}
