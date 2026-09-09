// src/components/rail/FilesHistoryOverlay.tsx —— 任务面板次级浮层（Task 10）
// 420px 抽屉：自 SecondPanel 相对包裹层右缘（rail 列右侧）左滑出，覆盖主聊天列上方，
// 不被 SecondPanel 的 overflow-hidden 裁剪（同层 sibling + left:100% + absolute + z-[40]），
// 但低于全局 overlays（z-[50+] 设置/命令面板/搜索、z-[100] 右键菜单）。
// 内容映射 four views（FileBrowser/HistoryView/UsagePanel/WorktreePanel）——旧 Sidebar 中
// 这些视图各自带完整头部与滚动，抽屉只加一层统一标题条 + 关闭钮；Escape 也关闭（输入聚焦除外）。
import { useEffect, type ComponentType } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui'
import { HistoryView } from '@/components/history/HistoryView'
import { FileBrowser } from '@/components/files/FileBrowser'
import { WorktreePanel } from '@/components/worktree/WorktreePanel'
import { UsagePanel } from '@/components/usage/UsagePanel'
import { useViewStore, type SecondTabId } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'

export const OVERLAY_W = 420

interface OverlayMeta {
  titleKey: string
  Panel: ComponentType
}

const CONTENT: Record<SecondTabId, OverlayMeta> = {
  files: { titleKey: 'sidebar.files', Panel: FileBrowser },
  history: { titleKey: 'sidebar.history', Panel: HistoryView },
  usage: { titleKey: 'sidebar.usage', Panel: UsagePanel },
  worktree: { titleKey: 'sidebar.worktrees', Panel: WorktreePanel },
}

export function FilesHistoryOverlay() {
  const secondTab = useViewStore(s => s.workState.secondTab)
  const { t } = useTranslation()

  const close = () => {
    useViewStore.setState(s => ({ workState: { ...s.workState, secondTab: null } }))
  }

  // Escape 关闭浮层；文件/工作树视图内含输入（路径/分支名），聚焦时不抢关闭
  useEffect(() => {
    if (!secondTab) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [secondTab])

  if (!secondTab) return null
  const meta = CONTENT[secondTab]
  if (!meta) return null
  const Panel = meta.Panel

  return (
    <div
      className="absolute top-0 bottom-0 left-full z-[40] flex flex-col overflow-hidden bg-app border-l animate-slide-left"
      style={{ width: OVERLAY_W }}
      data-overlay={secondTab}
    >
      <div className="flex items-center gap-1.5 px-2 h-9 border-b shrink-0 bg-app">
        <span className="flex-1 min-w-0 truncate text-xs font-semibold text-primary">{t(meta.titleKey)}</span>
        <Button variant="ghost" size="xs" aria-label={t('common.close')} onClick={close} className="text-tertiary hover:text-primary shrink-0">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
      <div className="flex-1 flex flex-col min-h-0">
        <Panel />
      </div>
    </div>
  )
}
