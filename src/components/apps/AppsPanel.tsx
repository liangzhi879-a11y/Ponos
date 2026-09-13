// 应用智控面板（Task 1.6）：应用卡片网格 ⇄ 应用控制台（Task 2.3）
//
// 结构对齐 WorkflowsPanel：面板占满 work 区，内部用本地 state 在"列表 ⇄ 控制台"之间切换
// （不新增 rail/子路由——第六 rail 只有两层，没必要进 SecondPanel 体系）。
import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { useAppsStore } from '@/stores/appsStore'
import { useChatStore } from '@/stores/chatStore'
import type { AppItem } from '@/types'
import { AddAppCard, AppCard } from './AppCard'
import { AddAppDialog } from './AddAppDialog'
import { AppConsole } from './AppConsole'

export function AppsPanel() {
  const { t } = useTranslation()
  const apps = useAppsStore((s) => s.apps)
  const loading = useAppsStore((s) => s.loading)
  const error = useAppsStore((s) => s.error)
  const load = useAppsStore((s) => s.load)
  const remove = useAppsStore((s) => s.remove)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // 当前会话的 sessionId = 内核侧 sessionId（bridge 以 --resume 传入，二者同源）。
  // 尚未建立内核会话时为 null——控制台会提示"AI 接入待会话建立"，绑定 effect 会等它出现。
  const sessionId = useChatStore((s) => {
    const id = s.activeConversationId
    if (!id) return null
    return s.conversations.find((c) => c.id === id)?.sessionId ?? null
  })

  useEffect(() => { void load() }, [load])

  async function onRemove(app: AppItem) {
    if (!window.confirm(t('apps.removeConfirm', { name: app.name || app.id }))) return
    await remove(app.id)
  }

  const opened = openId ? apps.find((a) => a.id === openId) ?? null : null

  if (opened) {
    return <AppConsole app={opened} sessionId={sessionId} onBack={() => setOpenId(null)} />
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="flex items-center gap-2 px-4 h-11 shrink-0 border-b border-subtle">
        <h2 className="text-xs font-semibold text-primary">{t('apps.title')}</h2>
        <span className="text-[10px] text-tertiary truncate">{t('apps.subtitle')}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading} title={t('apps.reload')}>
          <RefreshCw className={loading ? 'w-3 h-3 animate-spin' : 'w-3 h-3'} />
        </Button>
        <Button size="sm" onClick={() => setAdding(true)}>{t('apps.add')}</Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {error && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded bg-error/10 text-error text-[11px]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}
        {loading && apps.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-tertiary text-xs">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t('apps.loading')}</span>
          </div>
        ) : (
          <>
            {apps.length === 0 && !error && (
              <p className="text-xs text-tertiary text-center pt-10 pb-4">{t('apps.empty')}</p>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {apps.map((a) => (
                <AppCard key={a.id} app={a} onOpen={() => setOpenId(a.id)} onRemove={() => void onRemove(a)} />
              ))}
              <AddAppCard onClick={() => setAdding(true)} />
            </div>
          </>
        )}
      </div>

      {adding && <AddAppDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load() }} />}
    </div>
  )
}
