const { contextBridge, ipcRenderer } = require('electron')
const os = require('os')

// Resolve user home directory once in the preload context (full Node.js access).
// Used by the renderer as a default for file browsing — works on any machine.
const userHome = os.homedir()

const yfworkingAPI = {
  setTrayBehavior: (enabled) => ipcRenderer.send('app:set-tray-behavior', enabled),
  notifyTaskComplete: (payload) => ipcRenderer.invoke('app:notify-task', payload),
  setPetConfig: (config) => ipcRenderer.invoke('pet:config', config),
  openInExplorer: (filePath) => ipcRenderer.invoke('shell:open-path', filePath),
  agentsSync: (agents) => ipcRenderer.invoke('agents:sync', agents),
  // 原生文件编辑器独立窗口（invoke ↔ main 侧 ipcMain.handle 配对）
  editorOpenFile: (payload) => ipcRenderer.invoke('editor:open-file', payload),
  getPendingEditorFile: () => ipcRenderer.invoke('editor:get-pending'),
  closeEditorWindow: () => ipcRenderer.send('editor:close-window'),

  // 个人经验库与导出/导入（experience.mjs / packager.mjs）
  experienceList: () => ipcRenderer.invoke('experience:list'),
  setExperienceActive: (theme, active) => ipcRenderer.invoke('experience:set-active', { theme, active }),
  deleteExperienceEntry: (theme, hash) => ipcRenderer.invoke('experience:delete-entry', { theme, hash }),
  exportExperience: (opts) => ipcRenderer.invoke('experience:export', opts),
  importExperience: (opts) => ipcRenderer.invoke('experience:import', opts),

  userHome,
}

contextBridge.exposeInMainWorld('yfworkingAPI', yfworkingAPI)

// Frameless window controls
contextBridge.exposeInMainWorld('yfworkingWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  // 技能经验消费提醒（主进程启动时推送 pending 积压）
  onExperienceAlert: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('experience:pending-alert', listener)
    return () => ipcRenderer.removeListener('experience:pending-alert', listener)
  },
  // 编辑器独立窗口：接收打开文件请求 + 同步窗口边界
  onEditorOpenFile: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('editor:open-file', listener)
    return () => ipcRenderer.removeListener('editor:open-file', listener)
  },
  onEditorSyncBounds: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('editor:sync-bounds', listener)
    return () => ipcRenderer.removeListener('editor:sync-bounds', listener)
  },
  // 主题落盘：main 创建窗口前读取 theme.json 决定 transparent 窗口与否
  // （仅 glass 主题需要真透明；非 glass 主题透明合成是纯性能放大器）
  saveTheme: (theme, mode) => ipcRenderer.send('app:save-theme', { theme, mode }),
  // GPU 进程异常退出（驱动重置/崩溃）→ 渲染层自动开启极速形态
  onGpuCrash: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('gpu:crash', listener)
    return () => ipcRenderer.removeListener('gpu:crash', listener)
  },
})

// File dialogs (skill install)
contextBridge.exposeInMainWorld('yfworkingFile', {
  openSkillPackage: () => ipcRenderer.invoke('dialog:open-skill-package'),
})

// 豆包图片生成（main 侧 doubao:* ipcMain.handle 配对；生成请求需经主进程页面上下文）
contextBridge.exposeInMainWorld('doubao', {
  openLogin: () => ipcRenderer.invoke('doubao:open-login'),
  getStatus: () => ipcRenderer.invoke('doubao:get-status'),
  logout: () => ipcRenderer.invoke('doubao:logout'),
  generate: (payload) => ipcRenderer.invoke('doubao:generate', payload),
  instant: (payload) => ipcRenderer.invoke('doubao:instant', payload),
  capture: () => ipcRenderer.invoke('doubao:capture'),
})

// 内置浏览器自动化（main 侧 browser:* ipcMain.handle 配对；供状态条打开窗口/暂停/继续/清空会话）
contextBridge.exposeInMainWorld('browser', {
  openWindow: (sessionId) => ipcRenderer.invoke('browser:open', sessionId),
  pause: (sessionId) => ipcRenderer.invoke('browser:pause', sessionId),
  resume: (sessionId) => ipcRenderer.invoke('browser:resume', sessionId),
  clearSession: (sessionId) => ipcRenderer.invoke('browser:clear-session', sessionId),
  getStatus: () => ipcRenderer.invoke('browser:status'),
})

// 应用内诊断工具（main 侧 diag:* ipcMain.handle 配对）
contextBridge.exposeInMainWorld('yfwDiag', {
  getStatus: () => ipcRenderer.invoke('diag:get-status'),
  rerun: (id) => ipcRenderer.invoke('diag:rerun', { id }),
  rerunAll: () => ipcRenderer.invoke('diag:rerun-all'),
  runKernelCheck: () => ipcRenderer.invoke('diag:run-kernel-check'),
  exportReport: () => ipcRenderer.invoke('diag:export'),
  getBootSummary: () => ipcRenderer.invoke('diag:get-boot-summary'),
  openLogDir: () => ipcRenderer.invoke('diag:open-log-dir'),
  onStatusChanged: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('diag:status-changed', listener)
    return () => ipcRenderer.removeListener('diag:status-changed', listener)
  },
})
