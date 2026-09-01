// src/components/module/windows/FilesModule.tsx
// 文件模块窗口（?module=files）。
// 复用 FileBrowser 内核（列表/图标双模式）+ 文件预览，模式经 useUIStore.fileViewMode 持久化。
// 注意：FileBrowser 实际 props 为 { viewMode?: 'list' | 'grid' }（命名导出），非 mode。
import { FileBrowser } from '@/components/files/FileBrowser'
import { FilePreview } from '@/components/files/FilePreview'
import { useUIStore } from '@/stores/uiStore'

/**
 * 文件模块窗口（?module=files）。
 * 复用 FileBrowser 内核 + 列表/图标双模式切换 + 文件预览。
 */
export function FilesModule() {
  const { fileViewMode, setFileViewMode, previewFile, setPreviewFile } = useUIStore()

  return (
    <div className="h-full flex flex-col bg-app text-primary">
      {/* 模式切换条 */}
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-subtle gap-1">
        <button
          onClick={() => setFileViewMode('list')}
          className={`px-2 py-0.5 rounded text-xs ${fileViewMode === 'list' ? 'bg-surface text-brand-500' : 'text-tertiary hover:text-secondary'}`}
        >
          列表
        </button>
        <button
          onClick={() => setFileViewMode('grid')}
          className={`px-2 py-0.5 rounded text-xs ${fileViewMode === 'grid' ? 'bg-surface text-brand-500' : 'text-tertiary hover:text-secondary'}`}
        >
          图标
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <FileBrowser viewMode={fileViewMode} />
      </div>
      {previewFile && (
        <FilePreview
          path={previewFile.path}
          name={previewFile.name}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}
