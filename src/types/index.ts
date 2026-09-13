/// <reference types="vite/client" />

// EffortLevel 定义在零依赖纯函数模块 src/lib/effortUi.ts；types → lib 单向依赖，
// effortUi 不 import 本文件，故无循环。
import type { EffortLevel } from '@/lib/effortUi'
// 同上：ApprovalMode 在 src/lib/approvalModeUi.ts，LogPolicy/LogLevel 在 src/lib/logUi.ts（均零依赖）。
import type { ApprovalMode } from '@/lib/approvalModeUi'
import type { LogPolicy } from '@/lib/logUi'

export type { ApprovalMode, LogPolicy }

// ============================================================
// Core TypeScript types for YFWorking GUI
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

/** 多轮 loop 终止原因（内核 loop end 帧 reason 字段值域） */
export type LoopEndReason = 'completed' | 'until_hit' | 'cancelled' | 'judge_error'

/** 多轮 loop 进度（运行时瞬态，不持久化；由内核 loop 帧 state start/iter/end 驱动，
 *  语义对照 kernel/cli.mjs wire.loop 发射点与 S5 ②-05 pd 参照 LoopState 形状） */
export interface LoopState {
  /** loop 是否仍在推进（iter 间恒 true；end/取消/异常清除后 false） */
  active: boolean
  /** 已完成轮次数（start=0，每完成一轮 iter 递增；展示型字段，值域以内核为准） */
  index: number
  /** loop 总轮数（loop.count 归一化，至少 1） */
  total: number
  /** loop 目标描述（until 字段，模型判定达成即提前结束；无目标循环为空/缺省） */
  until?: string
  /** 首轮完成后设 fresh 窗口：第 2 轮请求面只含本轮之后内容 */
  fresh?: boolean
  /** 终止原因（仅 end 帧携带：次数耗尽/达成目标/已取消/判定失败） */
  reason?: LoopEndReason
  /** 最近一次 until 模型判定文本（judged iter 帧的 reason 字段，LoopStatusBar 判定文案） */
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
  /** 会话模式：chat = 纯聊受限（不执行本地，bridge spawn cwd=YFW_HOME + --disallowedTools），
   *  task = 全工具（默认）。undefined 视为 task（旧数据/导入，migrate 归一）。 */
  mode?: 'chat' | 'task'
  /** chat 模式自动标题标记：true=标题由系统自动管理（首条消息截断/模型概括），
   *  用户手动重命名后置 false，此后不再自动覆盖。仅 chat 模式使用。 */
  titleAuto?: boolean
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

export type ThemeMode = 'dark' | 'light' | 'dark-glass' | 'light-glass'
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
  /** 主题分组（2 实色 + 2 玻璃）—— ThemePicker 按此分组渲染 */
  category: 'solid' | 'glass'
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: 'dark',
    name: '远方',
    variant: '深色',
    tagline: '深空墨 · Boost 橙',
    glyph: '远',
    primary: '#ff7429',
    deep: '#f05a0a',
    surface: '#0b0e14',
    isDefault: true,
    category: 'solid',
    mode: 'dark',
  },
  {
    id: 'light',
    name: '远方',
    variant: '浅色',
    tagline: '暖白 · Boost 橙',
    glyph: '远',
    primary: '#ff7429',
    deep: '#e8590c',
    surface: '#fdf9f5',
    category: 'solid',
    mode: 'light',
  },
  {
    id: 'dark-glass',
    name: '远方',
    variant: '深色玻璃',
    tagline: '墨玻璃 · 暖橙极光',
    glyph: '璃',
    primary: '#ff7429',
    deep: '#f05a0a',
    surface: '#0b0e14',
    category: 'glass',
    mode: 'dark',
  },
  {
    id: 'light-glass',
    name: '远方',
    variant: '浅色玻璃',
    tagline: '暖金微光 · 白磨砂',
    glyph: '璃',
    primary: '#ff7429',
    deep: '#e8590c',
    surface: '#fdf9f5',
    category: 'glass',
    mode: 'light',
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

  // Glass 磨砂玻璃主题（仅 dark-glass / light-glass 生效）
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
  /** @deprecated 从未被任何代码写入、也从不发给桥/内核（状态栏那个假徽标读的就是它）。
   *  权限行为自 2026-09-12 起由 approvalMode 四档统一表达——保留字段只为不炸旧快照。 */
  autoApproveFileRead: boolean
  /** @deprecated 见 autoApproveFileRead（权限行为已由 approvalMode 接管） */
  autoApproveFileWrite: boolean
  /** @deprecated 见 autoApproveFileRead（权限行为已由 approvalMode 接管） */
  autoApproveBash: boolean
  /** @deprecated 见 autoApproveFileRead（权限行为已由 approvalMode 接管） */
  autoApproveWebSearch: boolean
  restrictedDirectories: string[]

  /** 审批放行档位（全局持久化，2026-09-12）：设置页改这里；
   *  状态栏改的是**本会话临时覆盖**（仅内存，不进持久化）。'loose' = 等价旧行为。
   *  必填——defaultSettings 恒提供；旧快照缺失时消费点一律 normalizeApprovalMode。 */
  approvalMode: ApprovalMode

  /** 运行日志本地持久化策略（2026-09-12）：写入端读桥 config.json，
   *  设置页写这里 + saveBridgeConfig 落盘；旧快照缺失时 normalizeLogPolicyUi 兜底。 */
  logPolicy: LogPolicy

  // YFWorking multi-provider config
  activeProvider: string
  providers: ModelProvider[]
  skillRoot: string
  autoCapture: boolean
  /** 自动图片桥接：对话粘贴图片时若主模型不支持视觉，自动调用视觉模型转文字描述（默认开启） */
  autoImageBridge: boolean
  /** 视觉模型来源 provider id（空=跟随 activeProvider）；视觉模型取自该 provider 的 visionModel 字段 */
  visionProviderId: string
  /** 思考深度（全局，Task 12）：新会话 spawn 经 CLAUDE_CODE_EFFORT_LEVEL env 注入，
   *  运行中会话经 WS reasoning_effort 热切换；'auto' = 内核默认（不注入）。
   *  必填——defaultSettings 恒提供；旧 persist 快照可能缺失，消费点一律 normalizeEffortUi。 */
  effortLevel: EffortLevel

  // UI state
  sidebarOpen: boolean
  sidebarWidth: number

  // Desktop integration — tray / notifications / desktop pet
  minimizeToTray: boolean
  notifyMode: 'background' | 'always'
  petEnabled: boolean
  petSize: number
  petRandomChat: boolean
}

export interface YFWorkingConfig {
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
  /** 行为画像（2026-09-09 本地模型适配）：auto=启发式判定；见 server/provider-profile.mjs */
  profile?: 'auto' | 'cloud' | 'local'
  /** 采样温度 [0,2]；未设=本地默认 0.6 / 云端 0 */
  temperature?: number
  /** 单次输出预算（tokens）；未设=本地 16384 / 云端 16384（2026-09-12 起，见 provider-profile） */
  maxOutputTokens?: number
  /** 单条工具结果字节上限（2026-09-12 四家方案对标：CC 50K 聚合 / pi 50KB / Codex 10K tok）；
   *  未设=内核默认 20000 字符（落盘+预览替换）。值注入 CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES */
  toolResultBudgetBytes?: number
  /** 首个内容块前的空闲宽限（ms）；未设=内核默认 300000 */
  firstByteMs?: number
  /** 内容块间空闲判挂起窗口（ms）；未设=内核默认 120000 */
  idleMs?: number
  /** 思考模式（2026-09-10）：true → 请求注入 thinking:enabled+budget——
   *  MiniMax 等不认 reasoning_effort 的云端经此才有 thinking_delta 流。 */
  thinkingEnabled?: boolean
  /** 思考 token 预算（thinkingEnabled 时生效；默认 4096） */
  thinkingBudget?: number
}

export interface YFWorkingConfigV2 {
  activeProvider: string
  skillRoot: string
  autoCapture: boolean
  providers: ModelProvider[]
  /** 自动图片桥接：对话粘贴图片时若主模型不支持视觉，自动调用视觉模型转文字描述（默认开启） */
  autoImageBridge?: boolean
  /** 视觉模型来源 provider id（空=跟随 activeProvider） */
  visionProviderId?: string
  /** 思考深度（全局顶层，Task 12）：handleSave 恒带上；旧代码路径缺省不报错。 */
  effortLevel?: string
  /** 新会话注入个人经验的开关（bridge read/save 按透传处理） */
  experienceInjectEnabled?: boolean
  /** 新会话注入个人经验的上限（字符数） */
  experienceInjectMaxBytes?: number
  /** 审批放行档位（全局，2026-09-12）：bridge 持久化并按此 spawn 内核
   *  （manual/auto 不传 --dangerously-skip-permissions）；缺省/非法 → bridge 归一为 loose。 */
  approvalMode?: string
  /** 运行日志持久化策略（2026-09-12）：bridge 钳制后落盘，写入端（桥/主进程）读同一份。 */
  logPolicy?: LogPolicy
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
  /** 绑定的工作流 id 列表（写入 agent .md frontmatter 的 workflows 字段） */
  workflows?: string[]
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

export type PermissionAction = 'file_read' | 'file_write' | 'file_edit' | 'bash' | 'web_fetch' | 'web_search' | 'notebook_edit' | 'skill' | 'mcp' | 'browser_whitelist_add'

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
  /** 命中灾难级硬黑名单（rm -rf / 等）：四档都问，弹窗须显示灾难级警示条。
   *  注意：**不是**"拒绝"——用户仍可本次放行（一次性，不记入"总是允许"）。 */
  hard?: boolean
  /** 发起本次询问时生效的审批档位（桥上报；用于弹窗显示"当前 X 档"）。 */
  mode?: ApprovalMode
  /** 内核给出的询问原因（decision_reason，如 "命中硬黑名单：..."）。 */
  reason?: string
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

// ===== 应用智控（第六 rail）类型：与 electron/app-registry.cjs / app-profiler.cjs 的
// JSON 口径一一对应（spec.json 的字段名不可随意改——内核侧 kernel/app-spec.mjs 也读它）=====

/** 目标类型：网站 / 桌面应用 */
export type AppTargetType = 'web' | 'desktop'

/** 驱动：浏览器自动化 / 目标自带 CLI / 目标脚本接口 / UI 自动化兜底 */
export type AppDriver = 'browser' | 'process' | 'script' | 'uia'

/** 注册表条目（$YFW_HOME/apps/registry.json 的一项） */
export interface AppItem {
  id: string
  name: string
  desc?: string
  logo?: string
  targetType: AppTargetType
  enabled?: boolean
}

export interface AppTarget {
  type: AppTargetType
  url?: string
  exePath?: string
}

/** 命令参数声明 */
export interface AppSpecParam {
  name: string
  type?: string
  required?: boolean
  desc?: string
}

/** 执行步骤：act 与浏览器执行器动作同名（goto/click/type/select/scroll/js/wait/snapshot） */
export interface AppSpecStep {
  act: string
  url?: string
  selector?: string
  ref?: string
  value?: string
  text?: string
  key?: string
  expression?: string
  direction?: string
  ms?: number
  mode?: string
  /** 桌面驱动专用 */
  argv?: string[]
  lang?: string
  file?: string
  code?: string
  timeout?: number
  /** 命中该步时把结果作为命令返回值 */
  save?: string
}

export interface AppSpecCommand {
  action: string
  title?: string
  /** read 只读；write 有副作用（内核侧受审批约束，控制台侧二次确认） */
  kind: 'read' | 'write'
  params?: AppSpecParam[]
  steps: AppSpecStep[]
  returns?: { type?: string; from?: string }
}

/** 应用规格（$YFW_HOME/apps/<appId>/spec.json） */
export interface AppSpec {
  specVersion: number
  appId: string
  name: string
  /** 可选描述（生成提示词会产出；内核校验对额外字段宽松） */
  desc?: string
  driver?: AppDriver
  target: AppTarget
  expose?: { mode: 'private' | 'console' | 'public' }
  commands: AppSpecCommand[]
}

/** 进入控制台前的自检结果 */
export interface AppCheckResult {
  status: 'healthy' | 'drifted' | 'broken'
  issues: string[]
}

/** 探测结果 */
export interface AppProbeResult {
  ok: boolean
  driver: AppDriver | null
  evidence: unknown
  reachable: boolean
  title?: string | null
  snapshot?: { url?: string | null; title?: string | null; text?: string; interactiveCount?: number } | null
  error?: string
}

/** Spec 备份条目 */
export interface AppBackupInfo {
  /** 备份文件名（白名单格式 spec.bak.<时间戳>.json） */
  name: string
  /** 时间戳（毫秒） */
  ts: number
}

/** 修复明细：必须能看出"改了什么"（不得静默改） */
export interface AppRepairItem {
  action: string
  from: { title: string; kind: string; steps: number; params: number }
  to: { title: string; kind: string; steps: number; params: number }
  /** 触发修复的真实执行报错 */
  reason: string
}

/** 修复结果 */
export interface AppRepairResult {
  ok: boolean
  reason: string | null
  repaired: AppRepairItem[]
  /** 未能修复的命令及原因 */
  failed: { action: string; reason: string }[]
  /** 写盘前产生的备份名（无写盘时为 null） */
  backup: string | null
  /** 修复前的应用状态（broken 时直接拒绝修复） */
  status?: string
}

/**
 * 生成进度事件。阶段由主进程真实代码路径触发：
 * probe 探测 → round 请求模型 → stream 流式接收 → parse 解析 → invalid 回喂 →
 * parsed 结构通过 → verify 试跑 → done 结束 / error 失败。
 * chars 是真实累计字符数（不是估算百分比）。
 */
export interface AppGenerateProgress {
  appId?: string | null
  at?: number
  /**
   * fetch：后台抓取页面素材（无需浏览器）；probe：浏览器探测（仅白名单站点增强用）；
   * explore：模型自主探索（抓页面/试跑命令）——如实展示"模型正在做什么"，不做假进度；
   * quality：封装质量校验未达标被打回；error：失败（必须带原因）
   */
  phase: 'fetch' | 'probe' | 'round' | 'explore' | 'stream' | 'parse' | 'invalid' | 'quality' | 'parsed' | 'verify' | 'done' | 'error'
  round?: number
  maxRounds?: number
  /** 当前是第几次工具调用（explore 阶段） */
  toolCalls?: number
  chars?: number
  /** 真实流式增量文本（已节流，用于界面展示实时输出） */
  delta?: string
  detail?: string
  issues?: string[]
  done?: boolean
}

/** 试跑验证结果（只跑 read；write 绝不试跑） */
export interface AppVerifyResult {
  ok: boolean
  tried: string[]
  failures: { action: string; error: string }[]
  /** 未试跑的 write 命令 */
  notRun: string[]
  /** 因需要参数而无法自动试跑的 read 命令 */
  skipped: string[]
}

/** 生成时拿到的素材来源（如实回传，界面据此提示是否需人工核对） */
export interface AppProbeInfo {
  /** browser=真实 DOM 快照；http=后台抓取的静态 HTML；http-thin=页面疑似 JS 空壳；none=没拿到素材 */
  mode: 'browser' | 'http' | 'http-thin' | 'none'
  title?: string | null
  url?: string | null
  note?: string | null
}

/** 生成结果 */
export interface AppGenerateResult {
  ok: boolean
  spec?: AppSpec
  driver?: AppDriver
  probe?: AppProbeInfo
  rounds?: number
  issues?: string[]
  /** 封装质量提示（不拦交付，但要在界面上让用户看到"哪里还不够"） */
  warnings?: string[]
  verify?: AppVerifyResult
  /** 自主探索概况：模型自己调了哪些工具、几轮收敛（用于让用户看懂"生成过程做了什么"） */
  agent?: { turns: number; toolCalls: number; verified: boolean; stoppedBy?: string; trace?: unknown[] }
  error?: string
  elapsedMs?: number
}

/** 命令执行结果 */
export interface AppRunResult {
  ok: boolean
  data: unknown
  error: string | null
  kind: string
  durationMs: number
}

export interface YFWAPI {
  setTrayBehavior: (enabled: boolean) => void
  notifyTaskComplete: (payload: { title: string; body: string; onlyBackground: boolean }) => Promise<{ shown: boolean }>
  openInExplorer: (filePath: string) => Promise<{ ok: boolean }>
  setPetConfig: (config: { enabled: boolean; size: number; randomChat: boolean }) => Promise<{ ok: boolean }>
  /** 将 GUI 注册的专业/自定义 agent 同步为内核 agent 文件（写/删 $YFW_HOME/agents/*.md） */
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

  // ---- 应用智控（electron/app-ipc.cjs，11 条 app:* 通道）----
  /** 应用清单（读 $YFW_HOME/apps/registry.json） */
  appList: () => Promise<AppItem[]>
  /** 新增或更新一个应用条目（按 id 覆盖） */
  appUpsert: (app: AppItem) => Promise<AppItem>
  /** 删除应用（连同其目录；主进程不做恢复） */
  appRemove: (appId: string) => Promise<{ ok: boolean }>
  /** 读取 App Spec（不存在返回 null） */
  appReadSpec: (appId: string) => Promise<AppSpec | null>
  /** 写入 App Spec（写前自动备份旧版到 versions/） */
  appWriteSpec: (payload: { appId: string; spec: AppSpec }) => Promise<{ ok: boolean; path?: string }>
  /** 进入应用控制台：把该应用绑定到当前内核会话（严格单开） */
  appEnterConsole: (payload: { sessionId: string; appId: string }) => Promise<{ ok: boolean }>
  /** 离开应用控制台：仅当当前绑定正是该 appId 时才解绑（防迟到事件误清） */
  appLeaveConsole: (payload: { sessionId: string; appId: string }) => Promise<{ ok: boolean }>
  /** 查询当前会话绑定的 appId（未绑定返回 null） */
  appBound: (sessionId: string) => Promise<string | null>
  /** 探测目标：判定 driver（browser/process/script/uia）并真实试连 */
  appProbe: (payload: { target: AppTarget; sessionId?: string }) => Promise<AppProbeResult>
  /** 进入控制台前的自检（Spec 结构 + 目标可达性） */
  appCheck: (appId: string) => Promise<AppCheckResult>
  /** 执行一条应用命令（read 直接跑；控制台的 write 由 UI 二次确认） */
  appRun: (payload: { appId: string; action: string; args?: Record<string, unknown>; sessionId?: string }) => Promise<AppRunResult>
  /**
   * 打开**可见**的登录窗口（与应用命令、模型探索共用同一浏览器会话）。
   * 登录一次后命令执行与模型探索都会带上该登录态（这是"带登录态探索"的入口）。
   */
  appLogin: (payload: { url: string; sessionId?: string }) => Promise<{ ok: boolean; sessionId?: string; url?: string; error?: string }>
  /**
   * 生成 App Spec（探测 → LLM → 结构校验 → read 试跑）。**不落盘**：
   * 必须由用户确认后另行调用 appWriteSpec 保存。
   */
  appGenerate: (payload: { target: AppTarget; appId?: string; sessionId?: string; maxRounds?: number }) => Promise<AppGenerateResult>
  /** 订阅生成进度（如实阶段事件）；返回取消订阅函数（组件卸载必须调用） */
  onAppGenerateProgress: (callback: (p: AppGenerateProgress) => void) => () => void
  /** Spec 备份列表（新→旧） */
  appListBackups: (appId: string) => Promise<AppBackupInfo[]>
  /** 回滚到某个备份（恢复前会自动再备份当前版本，故可再回滚） */
  appRestoreSpec: (payload: { appId: string; backupName: string }) => Promise<{ ok: boolean; spec?: AppSpec; error?: string }>
  /** 保存前校验 spec 结构（非法不保存） */
  appCheckSpec: (payload: { spec: AppSpec; allowPublic?: boolean }) => Promise<{ ok: boolean; errors: string[] }>
  /** 漂移修复：只修执行失败的命令，写盘前自动备份，返回 repaired 明细 */
  appRepair: (payload: { appId: string; maxRepair?: number }) => Promise<AppRepairResult>
}

/** File dialogs (skill install) — exposed by preload as `yfworkingFile` */
export interface YFWFileAPI {
  openSkillPackage: () => Promise<string | null>
}

export interface YFWorkingWindowControls {
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
  /** 认证小窗（?auth=1）：认证通过 → 主进程关小窗、创建主窗口（spec §2.0 / Task 6b） */
  authGranted?: () => void
  /** 认证小窗关闭钮（2026-09-10 无边框登录窗） */
  authClose?: () => void
  /** 独立工具窗口（2026-09-10 设置/个人外置）：打开 settings/profile 小窗 / 关闭本窗 */
  openUtility?: (kind: 'settings' | 'profile') => void
  closeUtility?: () => void
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
    yfworkingAPI?: YFWAPI
    yfworkingWindow?: YFWorkingWindowControls
    yfworkingFile?: YFWFileAPI
    /** 内置浏览器自动化（Task 3 preload IPC：打开窗口/暂停/继续/清空会话/状态） */
    browser?: {
      openWindow: (sessionId: string) => Promise<{ ok: boolean }>
      pause: (sessionId: string) => Promise<{ ok: boolean }>
      resume: (sessionId: string) => Promise<{ ok: boolean }>
      clearSession: (sessionId: string) => Promise<{ ok: boolean }>
      getStatus: () => Promise<{ ok: boolean; running?: boolean }>
    }
    /** 应用内诊断工具（Task 5 preload 平铺 namespace：getStatus/rerun/rerunAll/runKernelCheck/exportReport/getBootSummary/openLogDir/onStatusChanged） */
    yfwDiag?: {
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
  // Injected by Vite define — bridge port (from YFW_BRIDGE_PORT env or default)
  const __BRIDGE_PORT__: string
}

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
