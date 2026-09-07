import { useState, useEffect } from 'react'
import { Search, MessageSquare, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, ScrollArea,
} from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n/useTranslation'
import { getBridgeUrl } from '@/lib/config'

export function SearchDialog() {
  const searchOpen = useUIStore(s => s.searchOpen)
  const closeSearch = useUIStore(s => s.closeSearch)
  const setActiveConversation = useChatStore(s => s.setActiveConversation)
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ conversationId: string; messageId: string; text: string; conversationTitle: string }[]>([])
  const [searching, setSearching] = useState(false)

  // v2：搜索走 bridge /transcript/search（磁盘 transcript 全量内容，比旧的"内存截断 100 条"更全），
  // 结果按 sessionId 映射回 GUI 会话（sessionIds 索引）。异步 + 防抖，不再内存全扫。
  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      setSearching(false)
      return
    }

    let cancelled = false
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(getBridgeUrl() + '/transcript/search?query=' + encodeURIComponent(query.trim()))
        const data = await res.json()
        if (cancelled) return
        if (!data?.ok) {
          setResults([])
          return
        }
        const convs = useChatStore.getState().conversations
        const bySession = new Map<string, { conversationId: string; title: string }>()
        for (const c of convs) {
          for (const sid of c.sessionIds || []) bySession.set(sid, { conversationId: c.id, title: c.title })
        }
        const mapped: typeof results = []
        for (const r of (data.results || [])) {
          const conv = bySession.get(r.sessionId)
          if (!conv) continue
          mapped.push({
            conversationId: conv.conversationId,
            messageId: r.sessionId,
            text: (r.snippet || '').slice(0, 200),
            conversationTitle: conv.title,
          })
        }
        setResults(mapped)
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query])

  const handleSelect = (conversationId: string) => {
    setActiveConversation(conversationId)
    closeSearch()
    setQuery('')
  }

  return (
    <Dialog open={searchOpen} onOpenChange={v => !v && closeSearch()}>
      <DialogContent size="lg" className="p-0 gap-0">
        <DialogHeader className="flex-row items-center gap-3 pb-3">
          <Search className="w-5 h-5 text-tertiary shrink-0" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent border-0 text-base text-primary placeholder:text-tertiary focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-tertiary hover:text-secondary">
              <X className="w-4 h-4" />
            </button>
          )}
        </DialogHeader>

        <ScrollArea className="h-[min(400px,65vh)]">
          {!query ? (
            <div className="py-8 text-center text-tertiary text-sm">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>{t('search.emptyHint')}</p>
              <p className="text-xs mt-1">{t('search.emptyHintSub')}</p>
            </div>
          ) : searching ? (
            <div className="py-8 text-center text-tertiary text-sm">
              <p>搜索中…</p>
            </div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-tertiary text-sm">
              {t('search.noResults')}
            </div>
          ) : (
            <div className="py-2">
              {results.map((result, i) => (
                <button
                  key={`${result.conversationId}-${result.messageId}-${i}`}
                  onClick={() => handleSelect(result.conversationId)}
                  className="w-full text-left px-4 py-3 hover:bg-elevated transition-colors border-b border-subtle last:border-0"
                >
                  <div className="flex items-center gap-2 text-xs text-tertiary mb-1">
                    <MessageSquare className="w-3 h-3" />
                    <span className="font-medium text-secondary">{result.conversationTitle}</span>
                  </div>
                  <p className="text-sm text-secondary line-clamp-2">{result.text}</p>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
