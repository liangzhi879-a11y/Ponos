// 认证小窗窗口判定（?auth=1，D11-D13/Task 6b）：认证在独立 BrowserWindow 完成，
// 与主应用同 partition/localStorage，只渲染 AuthScreen 完成首设/登录，成功后经
// IPC auth:granted 交主进程开主窗口。纯函数模块：不引 zustand/UI（仿 editorBridge.ts）。
export function isAuthWindow(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('auth') === '1'
}
