import { useEffect, useRef } from 'react'
import { FileEditor } from './FileEditor'
import { useUIStore } from '@/stores/uiStore'
import { getFileLanguage, generateId, isEditableFile } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'

// 独立原生编辑器窗口的根组件：挂载后从主进程拉取待打开文件（规避 IPC 竞态），
// 并监听后续推送；最后一个标签关闭后自动关闭本窗口。
export function EditorWindowRoot() {
  const everOpened = useRef(false)
  const openFiles = useUIStore(s => s.openFiles)

  const openFileIntoStore = (payload: { path: string; name: string }) => {
    if (!payload || !payload.path) return
    everOpened.current = true
    const store = useUIStore.getState()
    const name = payload.name || payload.path.split(/[\\/]/).pop() || 'file'
    const editable = isEditableFile(name)
    store.openFile({
      id: generateId(),
      path: payload.path,
      name,
      language: getFileLanguage(name),
      content: editable ? 'Loading...' : '',
      originalContent: '',
      modified: false,
    })
    // 可编辑类型：拉取真实内容（不可编辑类型由编辑器窗口内只读预览承载）
    if (editable) {
      fetch(getBridgeUrl() + '/read-file?path=' + encodeURIComponent(payload.path))
        .then(r => r.json())
        .then(d => {
          const tab = useUIStore.getState().openFiles.find(f => f.path === payload.path)
          if (d.content && tab) useUIStore.getState().updateFileContent(tab.id, d.content)
        })
        .catch(() => {})
    }
  }

  useEffect(() => {
    const win = (window as any).ponosWindow
    const api = (window as any).ponosAPI
    // 挂载后拉取 pending 文件（主进程在 did-finish-load 前登记，可能早于 React 挂载）
    api?.getPendingEditorFile?.().then((p: any) => { if (p) openFileIntoStore(p) }).catch(() => {})
    const off = win?.onEditorOpenFile?.((data: any) => openFileIntoStore(data))
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 最后一个标签关闭 → 自动收起本窗口（首次打开文件前不触发）
  useEffect(() => {
    if (everOpened.current && openFiles.length === 0) {
      ;(window as any).ponosAPI?.closeEditorWindow?.()
    }
  }, [openFiles.length])

  return <FileEditor />
}
