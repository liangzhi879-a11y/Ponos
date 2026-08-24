/// <reference types="vite/client" />

// ============================================================
// Core TypeScript types for Ponos GUI
// ============================================================

// --- Message & Chat Types ---

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ContentBlock {
  id: string
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image' | 'file'
  content: string
  metadata?: Record<string, unknown>
  /** tool_use 块挂接的工具结果（历史回放：内核把 tool_result 作为 user 条目回显，
   *  转录加载时按 tool_use_id 匹配挂到对应 tool_use 块，避免丢失输出） */
  result?: { content: string; isError?: boolean }
}

export interface ThinkingBlock extends ContentBlock {
  type: 'thinking'
  collapsed: boolean
}

export interface Message {
  id: string
  role: MessageRole
  content: ContentBlock[]
  timestamp: number
  model?: string
  tokensUsed?: number
  edited?: boolean
  parentId?: string
  /** 排队插话悬浮态：消息已发送但内核尚未接收处理（command_lifecycle started 未到达） */
  pending?: boolean
}

/** 会话里程碑进度（运行时瞬态，不持久化） */
export interface ConversationProgress {
  total: number
  names: string[]
  current: number
  /** 最近 MILESTONE-START 声明的进行中里程碑 index（tooltip 当前里程碑） */
  inProgress?: number
}

/** /loop 连续迭代状态（运行时瞬态，不持久化；由内核 loop 事件驱动） */
export interface LoopState {
  /** 是否进行中（start 置位，end/cancel 清除） */
  active: boolean
  /** 当前轮次（1 起） */
  index: number
  /** 总轮数 */
  total: number
  /** until 目标（空 = 固定次数模式） */
  until?: string
  /** fresh 清上下文标记 */
  fresh?: boolean
  /** 结束原因（end 事件携带：completed/until_hit/cancelled/judge_error） */
  reason?: string
  /** until 判定的理由（iter 事件携带） */
  judgeReason?: string
}

/** 子 agent 任务（运行时瞬态，不持久化；由内核 system/task_* SDK 事件驱动） */
export interface SubAgentTask {
  taskId: string
  /** 触发该任务的 Agent 工具调用块 id（内核 task_started.tool_use_id），用于按消息分组嵌入面板 */
  toolUseId?: string
  name: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  prompt?: string
  toolUseCount: number
  tokenCount: number
  durationMs: number
  lastToolName?: string
  /** 工具活动流：每次 task_progress 的 description（如"正在读取 xx.xlsx"）追加一行 */
  activities: { toolName: string; description: string; ts: number }[]
  summary?: string
  outputFile?: string
  error?: string
  /** 最近一次收到内核事件的时间戳（task_started/task_progress 刷新），超时清理判活依据。运行时字段，不落盘。 */
  lastSeenAt?: number
  /** 被超时清理标记（孤儿任务：内核被外部终止后永远不会有终态通知）。收到新进度时允许复活。 */
  staleSwept?: boolean
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  model: string
  pinned?: boolean
  tags?: string[]
  summary?: string
  cwd?: string   // Working directory for this conversation
  sessionId?: string   // CLI session id bound to this conversation (used for resume)
  agentId?: string   // Professional agent bound to this conversation (see src/lib/agents.ts)
  setId?: string
  /** 该会话经历过的全部内核 transcript sessionId（按需加载消息体用，持久化索引字段） */
  sessionIds?: string[]
  /** 持久化索引：消息计数（messages 剥离/未加载时用于列表统计展示） */
  messageCount?: number
  /** 持久化索引：该会话 token 累计（StatusBar 用，避免遍历消息体） */
  tokensTotal?: number
}

export interface ConversationSet {
  id: string
  name: string
  cwd?: string   // 自动整理来源目录（仅记录，不绑定）
  createdAt: number
}

// --- Settings Types ---

export type ThemeMode = 'shadow'
export type Language = 'zh-CN' | 'en-US'

/** Static metadata for each theme (used by the picker UI). */
export interface ThemeMeta {
  id: ThemeMode
  /** Display name in the user's locale (zh / en) */
  name: string
  /** Optional chinese name suffix (e.g. 深色/浅色) */
  variant?: string
  /** Short tagline / aesthetic description */
  tagline: string
  /** Suggested emoji-free monogram shown on theme preview cards */
  glyph: string
  /** Primary brand hex for preview swatch */
  primary: string
  /** Deep / hover brand hex for preview swatch */
  deep: string
  /** Surface background hex for preview swatch */
  surface: string
  /** Whether this is the default theme */
  isDefault?: boolean
  /** Dark or light variant — used to group in the picker */
  mode: 'dark' | 'light'
  /** 主题分组（1 远方 + 3 实色 + 2 玻璃）—— ThemePicker 按此分组渲染 */
  category: 'brand' | 'solid' | 'glass'
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: 'shadow',
    name: 'Shadow',
    variant: '游戏平台',
    tagline: 'Vaporwave 霓虹 · SHADOW 游戏库界面',
    glyph: '影',
    primary: '#ff2d94',
    deep: '#1fd8f0',
    surface: '#14141a',
    category: 'brand',
    isDefault: true,
    mode: 'dark',
  },
] as const

/** 主题对应的 html class 名（main.tsx 预挂载与 AppShell 运行时共用同一数据源） */
export const THEME_CLASS_NAMES: string[] = THEMES.map(t => `theme-${t.id}`)

export interface AppSettings {
  theme: ThemeMode
  language: Language
  fontSize: number
  fontFamily: string
  sendOnEnter: boolean
  /** 打断插话快捷键（'ctrl+enter' 等，见 lib/utils parseShortcut） */
  interjectShortcut: string
  showTimestamps: boolean
  compactMode: boolean
  showThinking: boolean
  autoScroll: boolean

  // Glass 磨砂玻璃主题（仅 glass / glass-warm 生效）
  /** 玻璃面板透光度 0.3~0.9（越低越透明、越透出背后光晕/桌面） */
  glassOpacity: number
  /** 光晕漂移动画开关 */
  glassAurora: boolean
  /** 玻璃色调偏移（度），仅玻璃主题生效（plan §3 步骤 7） */
  glassHueShift: number

  // 极速形态：低配设备节能模式（独立开关，任意主题下生效）
  /** 关闭全部动画/毛玻璃/光晕/阴影，纯扁平渲染，节约系统资源 */
  speedMode: boolean
  /** 用户已选择"不再提示"低配检测引导（true 后不再弹自动提示） */
  speedModePromptDismissed: boolean

  // Model settings
  model: string
  maxTokens: number
  temperature: number
  systemPrompt: string

  // API settings
  apiUrl: string
  apiKey: string
  streamingEnabled: boolean

  // Permission settings
  autoApproveFileRead: boolean
  autoApproveFileWrite: boolean
  autoApproveBash: boolean
  autoApproveWebSearch: boolean
  restrictedDirectories: string[]
  /** 允许访问会话目录外的文件（Read/Write/Edit/OCR 解锁边界；Glob/Grep 仍限会话目录内） */
  allowOutsideDirs: boolean

  // Ponos multi-provider config
  activeProvider: string
  providers: ModelProvider[]
  skillRoot: string
  autoCapture: boolean
  /** 自动图片桥接：对话粘贴图片时若主模型不支持视觉，自动调用视觉模型转文字描述（默认开启） */
  autoImageBridge: boolean
  /** 视觉模型来源 provider id（空=跟随 activeProvider）；视觉模型取自该 provider 的 visionModel 字段 */
  visionProviderId: string

  // UI state
  sidebarOpen: boolean
  sidebarWidth: number

  // Desktop integration — tray / notifications / desktop pet
  minimizeToTray: boolean
  notifyMode: 'background' | 'always'
  petEnabled: boolean
  petSize: number
  petRandomChat: boolean
  /** 桌面宠物形象：嘉嘉（bridge 联动） / 大肥鱼（独立） */
  petType: 'jiajia' | 'dafeiyu'
}

export interface PonosConfig {
  apiBaseUrl: string
  authToken: string
  primaryModel: string
  subagentModel: string
  effortLevel: string
  skillRoot: string
  autoCapture: boolean
}

export interface ModelProvider {
  id: string
  name: string
  apiBaseUrl: string
  models: string[]
  primaryModel: string
  subagentModel: string
  effortLevel: string
  contextWindow: number
  authToken: string
  /** 该 provider 下支持视觉的模型名（留空=不启用 VisionTool 与自动桥接） */
  visionModel?: string
}

export interface PonosConfigV2 {
  activeProvider: string
  skillRoot: string
  autoCapture: boolean
  providers: ModelProvider[]
  /** 自动图片桥接：对话粘贴图片时若主模型不支持视觉，自动调用视觉模型转文字描述（默认开启） */
  autoImageBridge?: boolean
  /** 视觉模型来源 provider id（空=跟随 activeProvider） */
  visionProviderId?: string
  /** 新会话注入个人经验的开关（bridge read/save 按透传处理） */
  experienceInjectEnabled?: boolean
  /** 新会话注入个人经验的上限（字符数） */
  experienceInjectMaxBytes?: number
  /** 允许访问会话目录外文件（Read/Write/Edit/OCR 解锁边界） */
  allowOutsideDirs?: boolean
}

// --- File System Types ---

export interface FileTab {
  id: string
  path: string
  name: string
  language: string
  content: string
  originalContent: string
  modified: boolean
}

// --- Agent Types ---

/** agents:sync IPC 载荷（与 src/lib/agents.ts 的 Agent 结构化兼容，避免循环依赖） */
export interface AgentSyncPayload {
  id: string
  name: string
  description: string
  whenToUse?: string
  type: string
  model: string
  systemPrompt: string
  skills: string[]
  tools: string[]
  enabled: boolean
}

// --- Task Types ---

export interface BackgroundTask {
  id: string
  name: string
  type: 'shell' | 'agent' | 'remote'
  status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled'
  progress?: number
  startedAt: number
  completedAt?: number
}

// --- Permission Types ---

export type PermissionAction = 'file_read' | 'file_write' | 'file_edit' | 'bash' | 'web_fetch' | 'web_search' | 'notebook_edit' | 'skill' | 'mcp'

export interface PermissionRequest {
  id: string
  action: PermissionAction
  target: string
  details?: string
  risk: 'low' | 'medium' | 'high'
  timestamp: number
  /** bridge approval 事件携带：用于把审批结果回传内核（approval-response） */
  sessionId?: string
  toolUseId?: string
}

// --- Experience (个人经验沉积) Types ---

export interface ExperienceTheme {
  theme: string
  file: string
  entryCount: number
  updatedAt: number
  active: boolean
  entries: { text: string; hash: string }[]
}

// --- Window API (Electron) ---

export interface PonosAPI {
  setTrayBehavior: (enabled: boolean) => void
  notifyTaskComplete: (payload: { title: string; body: string; onlyBackground: boolean }) => Promise<{ shown: boolean }>
  openInExplorer: (filePath: string) => Promise<{ ok: boolean }>
  setPetConfig: (config: { enabled: boolean; size: number; randomChat: boolean; pet?: 'jiajia' | 'dafeiyu' }) => Promise<{ ok: boolean }>
  /** 将 GUI 注册的专业/自定义 agent 同步为内核 agent 文件（写/删 $PONOS_HOME/agents/*.md） */
  agentsSync: (agents: AgentSyncPayload[]) => Promise<{ ok: boolean; written?: string[]; removed?: string[]; error?: string }>
  /** Current user's home directory (resolved in preload context via os.homedir()) */
  userHome: string
  /** 原生文件编辑器独立窗口：打开/聚焦并下发文件 */
  editorOpenFile: (payload: { path: string; name: string; bounds: { x: number; y: number; w: number; h: number } }) => Promise<{ ok: boolean }>
  /** 编辑器窗口渲染层挂载后拉取待打开文件（规避 IPC 竞态） */
  getPendingEditorFile: () => Promise<{ path: string; name: string } | null>
  /** 编辑器窗口关闭按钮 / 标签全关闭后自动收起 */
  closeEditorWindow: () => void
  /** 个人经验：列出全部主题（含条目摘要与激活状态） */
  experienceList: () => Promise<{ ok: boolean; themes?: ExperienceTheme[]; error?: string }>
  /** 个人经验：设置主题激活状态 */
  setExperienceActive: (theme: string, active: boolean) => Promise<{ ok: boolean; error?: string }>
  /** 个人经验：删除某主题下的单条经验 */
  deleteExperienceEntry: (theme: string, hash: string) => Promise<{ ok: boolean; deleted?: number; error?: string }>
  /** 个人经验：导出为 zip（选择保存路径；取消返回 {ok:false, canceled:true}） */
  exportExperience: (opts: { included: string[]; sensitiveWords?: string[]; chatsJson?: string | null; projectCwd?: string | null; configRedact?: boolean; chatsFilter?: { conversationIds?: string[]; setId?: string } | null }) => Promise<{ ok: boolean; outPath?: string; skipped?: { type: string; reason: string }[]; error?: string; canceled?: boolean }>
  /** 个人经验：导入 zip（选择文件；取消返回 {ok:false, canceled:true}） */
  importExperience: (opts: { conflict: 'skip' | 'overwrite' | 'merge'; projectCwd?: string | null }) => Promise<{ ok: boolean; restored?: string[]; chatStoreJson?: string | null; chats?: { sets: ConversationSet[]; conversations: Conversation[] } | null; conflicts?: number; error?: string; canceled?: boolean }>
}

/** File dialogs (skill install) — exposed by preload as `ponosFile` */
export interface PonosFileAPI {
  openSkillPackage: () => Promise<string | null>
}

export interface PonosWindowControls {
  minimize: () => void
  maximizeToggle: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  // 技能经验消费提醒：主进程启动时推送 pending 积压，返回取消订阅函数
  onExperienceAlert?: (callback: (data: { total: number; bySkill: { skill: string; count: number }[] }) => void) => (() => void) | undefined
  /** 编辑器窗口：主进程下发待打开文件（返回取消订阅函数） */
  onEditorOpenFile?: (callback: (data: { path: string; name: string }) => void) => (() => void) | undefined
  /** 编辑器窗口拖动/缩放后回传边界（主应用界面同步 uiStore.editorRect 缓存） */
  onEditorSyncBounds?: (callback: (rect: { x: number; y: number; w: number; h: number }) => void) => (() => void) | undefined
  /** 主题落盘：主进程启动时据此决定 transparent 窗口与否（仅 glass 主题需要真透明） */
  saveTheme?: (theme: string, mode: 'light' | 'dark') => void
  /** GPU 进程异常退出（驱动重置/崩溃）→ 渲染层自动开启极速形态 */
  onGpuCrash?: (callback: (data: { reason: string }) => void) => (() => void) | undefined
}

// --- Interactive Question Card / AskUserQuestion replacement ---

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionItem {
  id: string
  header: string
  question: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface QuestionPayload {
  questions: QuestionItem[]
  context: string
}

export interface QuestionAnswer {
  questionId: string
  question: string
  selected: string
  customText?: string
}

// --- 诊断工具 (Diagnostic Tool) Types ---

export type DiagStatus = 'ok' | 'warn' | 'error' | 'unknown'
export type DiagOverall = 'ok' | 'warn' | 'error'
export interface DiagCheck {
  id: string
  group: string
  label: string
  status: DiagStatus
  detail?: string
  lastCheckedAt?: number
  latencyMs?: number
}
export interface DiagSnapshot { overall: DiagOverall; checks: DiagCheck[]; lastRunAt: number }
export interface DiagBootSummary { ok: boolean; nodes: { name: string; at: string; ok: boolean; error?: string }[]; failedAt: string | null }

declare global {
  interface Window {
    ponosAPI?: PonosAPI
    ponosWindow?: PonosWindowControls
    ponosFile?: PonosFileAPI
    doubao?: {
      openLogin: () => Promise<{ ok: boolean }>
      getStatus: () => Promise<DoubaoStatus>
      logout: () => Promise<{ ok: boolean }>
      generate: (payload: { prompt: string; ratio?: string; count?: number }) => Promise<{ code: number; data?: { images: string[] }; message?: string; sse?: unknown; diag?: unknown }>
      instant: (payload: { prompt: string; imageBase64: string }) => Promise<{ code: number; data?: { images: string[] }; message?: string; sse?: unknown; diag?: unknown }>
      capture?: () => Promise<{ code: number; captured?: unknown; message?: string }>
    }
    /** 内置浏览器自动化（Task 3 preload IPC：打开窗口/暂停/继续/清空会话/状态） */
    browser?: {
      openWindow: (sessionId: string) => Promise<{ ok: boolean }>
      pause: (sessionId: string) => Promise<{ ok: boolean }>
      resume: (sessionId: string) => Promise<{ ok: boolean }>
      clearSession: (sessionId: string) => Promise<{ ok: boolean }>
      getStatus: () => Promise<{ ok: boolean; running?: boolean }>
    }
    /** 应用内诊断工具（Task 5 preload 平铺 namespace：getStatus/rerun/rerunAll/runKernelCheck/exportReport/getBootSummary/openLogDir/onStatusChanged） */
    ponosDiag?: {
      getStatus: () => Promise<DiagSnapshot>
      rerun: (id: string) => Promise<DiagCheck | null>
      rerunAll: () => Promise<DiagSnapshot>
      runKernelCheck: () => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number; latencyMs: number }>
      exportReport: () => Promise<{ text: string }>
      getBootSummary: () => Promise<DiagBootSummary | null>
      openLogDir: () => Promise<string>
      onStatusChanged: (cb: (s: DiagSnapshot) => void) => () => void
    }
  }
  // Injected by Vite define at build time — reads package.json version
  const __APP_VERSION__: string
  // Injected by Vite define — bridge port (from PONOS_BRIDGE_PORT env or default)
  const __BRIDGE_PORT__: string
}

// --- 豆包图片生成 ---

export interface DoubaoStatus {
  loggedIn: boolean
  exportedAt: number | null
}

export interface DoubaoResult {
  id: string
  prompt: string
  imageUrl: string      // 本地去水印图（bridge /ponos/doubao/images/<id>）
  /** 磁盘绝对路径（~/.ponos/doubao-images/<id>.png），插入聊天时经 @image:<path> 发内核必须用本地路径 */
  path?: string
  createdAt: number
}

export interface DoubaoHistoryItem extends DoubaoResult {}

// --- 内置浏览器自动化 ---

/** 浏览器执行器经 bridge 广播的 browser:event 载荷（executor → GUI，见 electron/browser-executor.cjs） */
export interface BrowserEvent {
  /** 'status' 当前操作文本；'paused'/'resumed' 人工接管开关；'mode' 模式切换；'download' 下载落盘；'closed' 浏览器已退出（收起状态胶囊） */
  type: 'status' | 'paused' | 'resumed' | 'mode' | 'download' | 'closed'
  /** status 事件的操作描述（如 "正在点击「查询」"） */
  text?: string
  /** mode 事件的执行器模式 */
  mode?: 'normal' | 'imitation' | 'human'
  /** download 事件的落盘绝对路径 */
  path?: string
}
