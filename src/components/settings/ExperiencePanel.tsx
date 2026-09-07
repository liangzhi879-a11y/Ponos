import { useEffect, useMemo, useState } from 'react'
import { Brain, Search, Trash2, Download, Upload, RefreshCw, Package, AlertTriangle } from 'lucide-react'
import { Button, Switch, ScrollArea } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { fetchBridgeConfig, saveBridgeConfig } from '@/lib/config'
import { cn, CHAT_STORAGE_KEY } from '@/lib/utils'
import type { ExperienceTheme } from '@/types'

// preload 注入的 window.yfworkingAPI 仅存在于 Electron 渲染进程；
// dev 模式（纯 Vite、无 preload）下为 undefined，所有调用点必须守卫，避免挂载即崩溃。
const api = window.yfworkingAPI

const TYPE_LABELS: Record<string, string> = {
  personal: '个人记忆', skill_exp: '技能经验库', skills: '技能库',
  config: '全局配置', chats: '会话历史', project: '项目数据',
}

export function ExperiencePanel() {
  const [themes, setThemes] = useState<ExperienceTheme[]>([])
  const [query, setQuery] = useState('')
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [injectEnabled, setInjectEnabled] = useState(true)
  const [injectMax, setInjectMax] = useState(4096)
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // 每主题展开状态：set 形式按主题 key 记录是否查看全部
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const lastCwd = useChatStore(s => s.lastCwd)

  const load = () => {
    if (!api) {
      setMsg({ text: '未检测到桌面环境（dev 模式无 preload）', ok: false })
      return
    }
    api.experienceList().then(r => {
      if (r.ok && r.themes) { setThemes(r.themes); return }
      setMsg({ text: r.error || '读取失败', ok: false })
    })
  }

  useEffect(() => {
    load()
    fetchBridgeConfig().then(cfg => {
      setInjectEnabled(cfg.experienceInjectEnabled !== false)
      setInjectMax(Number(cfg.experienceInjectMaxBytes) > 0 ? Number(cfg.experienceInjectMaxBytes) : 4096)
    }).catch(() => {})
  }, [])

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 5000)
  }

  const saveInject = (enabled: boolean, maxBytes: number) => {
    fetchBridgeConfig().then(cfg => {
      saveBridgeConfig({ ...cfg, experienceInjectEnabled: enabled, experienceInjectMaxBytes: maxBytes }).then(() => flash('注入设置已保存'))
    }).catch(() => flash('保存失败', false))
  }

  const totalEntries = useMemo(() => themes.reduce((s, x) => s + x.entryCount, 0), [themes])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return themes.filter(x => !q || x.theme.includes(q) || x.entries.some(e => e.text.toLowerCase().includes(q)))
  }, [themes, query])

  const chatsJson = () => {
    try { return window.localStorage.getItem(CHAT_STORAGE_KEY) } catch { return null }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-primary mb-1 flex items-center gap-2">
          <Brain className="w-4 h-4" />
          个人经验
        </h3>
        <p className="text-xs text-tertiary mb-4">
          全自动静默沉积于 ~/.yfworking/memory/personal/，新会话按相关性注入（上限 {injectMax} 字符）。共 {themes.length} 个主题 / {totalEntries} 条经验。
        </p>

        {/* 注入设置 */}
        <div className="rounded-lg border border bg-surface p-4 mb-4 space-y-3">
          <label className="flex items-center justify-between py-1">
            <div>
              <span className="text-sm text-secondary">新会话注入经验</span>
              <p className="text-[10px] text-tertiary mt-0.5">开启后每次会话自动携带已激活经验（含沉积引导）</p>
            </div>
            <Switch checked={injectEnabled} onCheckedChange={v => { setInjectEnabled(v); saveInject(v, injectMax) }} />
          </label>
          <label className="flex items-center justify-between py-1">
            <div>
              <span className="text-sm text-secondary">注入上限（字符）</span>
              <p className="text-[10px] text-tertiary mt-0.5">超出部分按最近更新截断</p>
            </div>
            <input
              type="number" min={512} max={16384} step={512}
              value={injectMax}
              onChange={e => setInjectMax(Number(e.target.value) || 4096)}
              onBlur={() => saveInject(injectEnabled, injectMax)}
              className="w-28 h-8 rounded-md border border bg-surface px-2 text-xs text-primary text-right font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
        </div>

        {/* 导出/导入 */}
        <div className="flex items-center gap-2 mb-4">
          <Button variant="primary" size="sm" leftIcon={<Download className="w-3.5 h-3.5" />} onClick={() => setExportOpen(true)}>导出</Button>
          <Button variant="outline" size="sm" leftIcon={<Upload className="w-3.5 h-3.5" />} onClick={() => setImportOpen(true)}>导入</Button>
          <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-3.5 h-3.5" />} onClick={load}>刷新</Button>
          {msg && <span className={cn('text-xs', msg.ok ? 'text-success' : 'text-error')}>{msg.text}</span>}
        </div>

        {/* 搜索 */}
        <div className="relative mb-3">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tertiary" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索主题或经验内容…"
            className="w-full h-8 bg-elevated border border rounded-md pl-7 pr-2 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* 主题列表 — 嵌套 ScrollArea 用 max-h-full flex-1 min-h-0 依赖外层 flex 高度，
            修复设置-经验无法滚到底：原 max-h-[46vh] 与外层 Dialog 嵌套冲突导致溢出/被截断。
            每主题"查看全部"按钮控制 expanded Set，点开展示所有 entries 并提供每条删除按钮。 */}
        <ScrollArea className="max-h-full flex-1 min-h-0">
          <div className="space-y-3">
            {filtered.map(x => {
              const isExpanded = expanded.has(x.theme)
              const visibleEntries = isExpanded ? x.entries : x.entries.slice(0, 6)
              return (
                <div key={x.theme} className="rounded-lg border border bg-surface p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-primary">{x.theme}</span>
                    <span className="text-[10px] text-tertiary">{x.entryCount} 条</span>
                    <div className="ml-auto flex items-center gap-2">
                      {x.entries.length > 6 && (
                        <button
                          className="text-[10px] text-brand-500 hover:underline"
                          onClick={() => {
                            setExpanded(prev => {
                              const next = new Set(prev)
                              if (next.has(x.theme)) next.delete(x.theme)
                              else next.add(x.theme)
                              return next
                            })
                          }}
                        >
                          {isExpanded ? '收起' : `查看全部 ${x.entries.length} 条`}
                        </button>
                      )}
                      <label className="flex items-center gap-1 text-[10px] text-tertiary">
                        激活
                        <Switch
                          checked={x.active}
                          onCheckedChange={v => {
                            api?.setExperienceActive(x.theme, v).then(r => { if (r.ok) load() })
                          }}
                        />
                      </label>
                    </div>
                  </div>
                  {visibleEntries.map(e => (
                    <div key={e.hash} className="group flex items-start gap-2 mt-1.5 text-xs text-secondary">
                      <span className="flex-1 min-w-0 leading-relaxed">{e.text}</span>
                      <button
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-tertiary hover:text-error transition-opacity"
                        title="删除该经验"
                        onClick={() => {
                          if (!confirm(`删除这条经验？\n${e.text.slice(0, 60)}…`)) return
                          api?.deleteExperienceEntry(x.theme, e.hash).then(r => {
                            if (r.ok) { load(); flash('已删除') } else flash(r.error || '删除失败', false)
                          })
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {!isExpanded && x.entries.length > 6 && (
                    <div className="mt-1.5 text-[10px] text-tertiary">…另有 {x.entries.length - 6} 条未显示</div>
                  )}
                </div>
              )
            })}
            {filtered.length === 0 && <div className="p-4 text-center text-xs text-tertiary">暂无经验，多用 YFWorking 工作会自动沉淀</div>}
          </div>
        </ScrollArea>
      </div>

      {exportOpen && (
        <ExportDialog
          lastCwd={lastCwd}
          chatsJson={chatsJson}
          onClose={() => setExportOpen(false)}
          onDone={m => { flash(m); load() }}
        />
      )}
      {importOpen && (
        <ImportDialog
          lastCwd={lastCwd}
          onClose={() => setImportOpen(false)}
          onDone={m => { flash(m); load() }}
        />
      )}
    </div>
  )
}

function ExportDialog({ lastCwd, chatsJson, onClose, onDone }: { lastCwd: string | null; chatsJson: () => string | null; onClose: () => void; onDone: (m: string) => void }) {
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
      <div className="w-[420px] bg-surface rounded-xl shadow-modal border border p-5">
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
  )
}

function ImportDialog({ lastCwd, onClose, onDone }: { lastCwd: string | null; onClose: () => void; onDone: (m: string) => void }) {
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
      <div className="w-[400px] bg-surface rounded-xl shadow-modal border border p-5">
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
  )
}
