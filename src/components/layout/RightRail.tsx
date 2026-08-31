import { useUIStore } from '@/stores/uiStore'
import { FileBrowser } from '@/components/files/FileBrowser'
import { ScrollArea } from '@/components/ui'
import { LayoutGrid, List } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

export function RightRail() {
  const { rightRailOpen, rightRailWidth, setRightRailWidth, fileViewMode, setFileViewMode } = useUIStore()
  const { t } = useTranslation()
  if (!rightRailOpen) return null
  return (
    <div className="h-full flex-shrink-0 flex flex-col border-l bg-app animate-slide-right relative" style={{ width: rightRailWidth }}>
      {/* 工具栏：模式切换 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b shrink-0">
        <span className="text-[10px] font-semibold text-tertiary uppercase tracking-wider flex-1">Explorer</span>
        <button onClick={() => setFileViewMode('list')} aria-label={t('fileBrowser.listView')}
          className={cn('p-1 rounded hover:bg-elevated', fileViewMode === 'list' ? 'text-brand-500' : 'text-tertiary')}>
          <List className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => setFileViewMode('grid')} aria-label={t('fileBrowser.gridView')}
          className={cn('p-1 rounded hover:bg-elevated', fileViewMode === 'grid' ? 'text-brand-500' : 'text-tertiary')}>
          <LayoutGrid className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <FileBrowser viewMode={fileViewMode} />
        </ScrollArea>
      </div>
      {/* 宽度拖拽把手 */}
      <div
        className="absolute inset-y-0 left-0 w-1 cursor-col-resize hover:bg-brand-500/30 transition-colors"
        onMouseDown={e => {
          e.preventDefault()
          const startX = e.clientX
          const startW = rightRailWidth
          const onMove = (ev: MouseEvent) => setRightRailWidth(startW - (ev.clientX - startX))
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
      />
    </div>
  )
}
