// 原生文件编辑器窗口桥接：主应用界面通过 IPC 打开独立 BrowserWindow，
// 该窗口加载同一 dist（?editor=1），与主应用共享 localStorage。
import { useUIStore } from '@/stores/uiStore'

// 当前窗口是否为独立编辑器窗口（URL query 带 editor=1）
export function isEditorWindow(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('editor') === '1'
}

// 主应用界面：请求打开/聚焦原生编辑器窗口并下发文件。
// bounds 携带主窗口持久化的 editorRect 缓存，主进程校验后应用。
export function openFileInEditor(path: string, name: string): void {
  const api = (window as any).ponosAPI
  if (!api?.editorOpenFile) return
  const rect = useUIStore.getState().editorRect
  api.editorOpenFile({ path, name, bounds: rect })
}
