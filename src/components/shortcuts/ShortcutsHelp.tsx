import { Command } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  ScrollArea,
} from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'

const SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: '⌘K / ⌘⇧P', description: 'Open command palette' },
      { keys: '⌘N', description: 'New conversation' },
      { keys: '⌘B', description: 'Toggle sidebar' },
      { keys: '⌘,', description: 'Open settings' },
      { keys: '⌘⇧F', description: 'Search conversations' },
      { keys: '⌘[ / ⌘]', description: 'Previous/Next conversation' },
      { keys: '⌘1-9', description: 'Switch to conversation N' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: 'Enter', description: 'Send message' },
      { keys: 'Shift+Enter', description: 'New line' },
      { keys: '/', description: 'Focus chat input' },
      { keys: 'Esc', description: 'Stop generating' },
      { keys: '↑↓', description: 'Navigate message history' },
    ],
  },
  {
    title: 'View',
    shortcuts: [
      { keys: '⌘D', description: 'Toggle theme (dark/light/system)' },
      { keys: '?', description: 'Show keyboard shortcuts' },
    ],
  },
  {
    title: 'Editor',
    shortcuts: [
      { keys: '⌘S', description: 'Save file' },
      { keys: '⌘W', description: 'Close file tab' },
      { keys: '⌘Z / ⌘⇧Z', description: 'Undo / Redo' },
    ],
  },
]

export function ShortcutsHelp() {
  const { shortcutsHelpOpen, closeShortcutsHelp } = useUIStore()

  return (
    <Dialog open={shortcutsHelpOpen} onOpenChange={v => !v && closeShortcutsHelp()}>
      <DialogContent size="md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Command className="w-5 h-5 text-brand-500" />
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[450px]">
          <div className="px-2">
            {SHORTCUT_GROUPS.map(group => (
              <div key={group.title} className="mb-4">
                <h3 className="text-xs font-semibold text-tertiary uppercase tracking-wider px-2 py-1">
                  {group.title}
                </h3>
                <div className="space-y-0.5">
                  {group.shortcuts.map(shortcut => (
                    <div
                      key={shortcut.keys + shortcut.description}
                      className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-elevated transition-colors"
                    >
                      <span className="text-sm text-secondary">{shortcut.description}</span>
                      <kbd className="px-2 py-0.5 rounded-md bg-input text-xs text-tertiary font-mono border border">
                        {shortcut.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
