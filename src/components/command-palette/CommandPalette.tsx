import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Search, MessageSquarePlus, PanelLeftClose, Settings, Sun,
  Zap, HelpCircle, History, FolderOpen, Stethoscope
} from 'lucide-react'
import {
  Dialog, DialogContent,
} from '@/components/ui'
import { ScrollArea } from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useDiagStore } from '@/stores/diagStore'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

interface Command {
  id: string
  label: string
  description?: string
  category: string
  icon: React.ComponentType<{ className?: string }>
  action: () => void
}

const COMMAND_DEFS = [
  { id: 'new-conv', icon: MessageSquarePlus, cat: 'chat', labelKey: 'commandPalette.cmd.newConv', descKey: 'commandPalette.cmd.newConvDesc' },
  { id: 'toggle-sidebar', icon: PanelLeftClose, cat: 'view', labelKey: 'commandPalette.cmd.toggleSidebar', descKey: 'commandPalette.cmd.toggleSidebarDesc' },
  { id: 'open-settings', icon: Settings, cat: 'nav', labelKey: 'commandPalette.cmd.openSettings', descKey: 'commandPalette.cmd.openSettingsDesc' },
  { id: 'toggle-theme', icon: Sun, cat: 'theme', labelKey: 'commandPalette.cmd.toggleTheme', descKey: 'commandPalette.cmd.toggleThemeDesc' },
  { id: 'shortcuts', icon: HelpCircle, cat: 'help', labelKey: 'commandPalette.cmd.shortcuts', descKey: 'commandPalette.cmd.shortcutsDesc' },
  { id: 'diagnostics', icon: Stethoscope, cat: 'help', labelKey: 'commandPalette.cmd.diagnostics', descKey: 'commandPalette.cmd.diagnosticsDesc' },
  { id: 'cmd-focus', icon: Zap, cat: 'chat', labelKey: 'commandPalette.cmd.focusInput', descKey: 'commandPalette.cmd.focusInputDesc' },
  { id: 'history', icon: History, cat: 'nav', labelKey: 'commandPalette.cmd.history', descKey: 'commandPalette.cmd.historyDesc' },
  { id: 'files', icon: FolderOpen, cat: 'file', labelKey: 'commandPalette.cmd.files', descKey: 'commandPalette.cmd.filesDesc' },
]

export function CommandPalette() {
  const { commandPaletteOpen, closeCommandPalette, toggleSidebar, openSettings, openShortcutsHelp, setSidebarTab } = useUIStore()
  const openDiagnostics = useDiagStore(s => s.openDiagnostics)
  const { createConversation } = useChatStore()
  const { settings, updateSettings } = useSettingsStore()
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)

  const commands: Command[] = useMemo(() => COMMAND_DEFS.map(def => {
    const action = () => {
      switch (def.id) {
        case 'new-conv': createConversation(); break
        case 'toggle-sidebar': toggleSidebar(); break
        case 'open-settings': openSettings(); break
        case 'toggle-theme': {
          // 单主题（shadow）：无需切换
          break
        }
        case 'shortcuts': openShortcutsHelp(); break
        case 'diagnostics': openDiagnostics(); break
        case 'cmd-focus': setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 50); break
        case 'history': setSidebarTab('history'); break
        case 'files': useUIStore.setState({ rightRailOpen: true }); break
        default: break
      }
      closeCommandPalette()
    }
    return {
      id: def.id,
      label: t(def.labelKey as any),
      description: t(def.descKey as any),
      category: t(`commandPalette.categories.${def.cat}` as any),
      icon: def.icon,
      action,
    }
  }), [t, settings.theme, openDiagnostics])

  const filtered = query
    ? commands.filter(c =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.description?.toLowerCase().includes(query.toLowerCase()) ||
        c.category.toLowerCase().includes(query.toLowerCase())
      )
    : commands

  // Reset on open
  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('')
      setSelectedIdx(0)
    }
  }, [commandPaletteOpen])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      filtered[selectedIdx]?.action()
    } else if (e.key === 'Escape') {
      closeCommandPalette()
    }
  }, [filtered, selectedIdx, closeCommandPalette])

  // Group by category
  const grouped = filtered.reduce((acc, cmd) => {
    if (!acc[cmd.category]) acc[cmd.category] = []
    acc[cmd.category].push(cmd)
    return acc
  }, {} as Record<string, Command[]>)

  let flatIdx = 0

  return (
    <Dialog open={commandPaletteOpen} onOpenChange={v => !v && closeCommandPalette()}>
      <DialogContent size="md" className="p-0 gap-0">
        {/* Search */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-subtle">
          <Search className="w-5 h-5 text-tertiary shrink-0" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }}
            onKeyDown={handleKeyDown}
            placeholder={t('commandPalette.placeholder')}
            className="flex-1 bg-transparent border-0 text-sm text-primary placeholder:text-tertiary focus:outline-none"
          />
        </div>

        {/* Results */}
        {/* 固定高度（h-[min(...)]）而非 max-h：Radix ScrollArea 的 Viewport 是 h-full，
            父级仅有 max-height 时百分比高度解析失败 → 内容被撑开不溢出 → 无法滚动 */}
        <ScrollArea className="h-[min(400px,65vh)]">
          <div className="py-2">
            {Object.entries(grouped).map(([category, cmds]) => (
              <div key={category}>
                <div className="px-4 py-1.5 text-[10px] font-semibold text-tertiary uppercase tracking-wider">
                  {category}
                </div>
                {cmds.map(cmd => {
                  const idx = flatIdx++
                  const Icon = cmd.icon
                  return (
                    <button
                      key={cmd.id}
                      onClick={cmd.action}
                      className={cn(
                        'w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors',
                        idx === selectedIdx
                          ? 'bg-brand-500/15 text-primary'
                          : 'text-secondary hover:bg-elevated'
                      )}
                    >
                      <Icon className="w-4 h-4 text-tertiary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{cmd.label}</div>
                        {cmd.description && (
                          <div className="text-xs text-tertiary truncate">{cmd.description}</div>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-4 py-8 text-center text-tertiary text-sm">
                {t('commandPalette.noResults')}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-2 border-t border-subtle text-[10px] text-tertiary">
          <kbd>↑↓</kbd> {t('commandPalette.navigate')}
          <kbd>Enter</kbd> {t('commandPalette.select')}
          <kbd>Esc</kbd> {t('commandPalette.close')}
        </div>
      </DialogContent>
    </Dialog>
  )
}
