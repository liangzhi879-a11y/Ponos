/// <reference types="vite/client" />

// EffortLevel 定义在零依赖纯函数模块 src/lib/effortUi.ts；types → lib 单向依赖，
// effortUi 不 import 本文件，故无循环。
import type { EffortLevel } from '@/lib/effortUi'
// 同上：ApprovalMode 在 src/lib/approvalModeUi.ts，LogPolicy/LogLevel 在 src/lib/logUi.ts（均零依赖）。
import type { ApprovalMode } from '@/lib/approvalModeUi'
import type { LogPolicy } from '@/lib/logUi'
// 同理：KnowledgeImportPolicy 在 src/lib/knowledgeImportUi.ts（零依赖纯模块），
// 类型只从那里引一次，避免 types 与 lib 各写一份必然漂移。
import type { KnowledgeImportPolicy } from '@/lib/knowledgeImportUi'
// 能力清单的类型定义在 src/lib/appSurface.ts（归一化 + 三分文案的可测唯一出处）：
// 这里只 import 一次给 AppProbeResult 用，末尾再原样再导出，避免与组件各写一份结构定义。
import type { AppSurface } from '@/lib/appSurface'
// 质检标记（指纹/时间/结论/问题数）定义在 src/lib/appQuality.ts（零依赖纯模块，不 import 本文件 ⇒ 无循环）。
import type { AppQualityMark } from '@/lib/appQuality'

export type { ApprovalMode, LogPolicy, KnowledgeImportPolicy, AppQualityMark }

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

/** 多轮 loop 终止原因（内核 loop end 帧 reason 字段值域；2026-09-14 loop 运行时扩为
 *  8 值，对齐 kernel/loop.mjs END_REASONS：次数耗尽/达成目标/取消/判定失败/
 *  验证命中/预算超限/无进展/失败） */
export type LoopEndReason = 'completed' | 'until_hit' | 'cancelled' | 'judge_error'
  | 'verify_hit' | 'budget_exceeded' | 'no_progress' | 'failed'

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
  // ---- 2026-09-14 loop 运行时扩展（内核 loop start/iter/end/status 帧新字段） ----
  /** loop 目标（start/end 帧 goal；LoopPanel 面板首行展示） */
  goal?: string
  /** 控制器状态机当前状态（status 帧 status；值域 = kernel/loop.mjs state.status，
   *  'idle' 为控制器未起跑时的初值）。注意 pause() 先置 'pausing'、轮末才转 'paused' */
  status?: 'idle' | 'running' | 'pausing' | 'paused' | 'awaiting_approval' | 'verifying'
    | 'done' | 'budget_exceeded' | 'cancelled'
  /** 累计成本（美元；iter/end 帧 costUsd，展示型字段，成本 > 0 才显示） */
  costUsd?: number
  /** 累计工具步数（iter 帧 steps） */
  steps?: number
  /** 循环间隔毫秒（start 帧 everyMs；0 = 未设间隔） */
  everyMs?: number
  /** 连续无进展轮次（iter 帧 noProgressStreak；达阈值触发预警/挂起） */
  noProgressStreak?: number
  /** 最近一次 doneWhen 验证结果（iter 帧 verify；run/type 为验证条目标识） */
  verify?: { passed: boolean; results: Array<{ run?: string; type: string; ok: boolean }> }
  /** 待用户批准的挂起项（status 帧 pendingApproval：rollback / no_progress 等） */
  pendingApproval?: { kind: string; detail?: string }
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
  /** 会话知识范围（2026-09-15，P1「会话模式关联经验库之外的知识库」）：本会话显式关联的
   *  知识库（空间）id 列表。经验库（experience/session-memory）恒在范围内、不在此列。
   *  undefined = 未关联（只用经验库）。变更在**下一次发消息**时生效——内核在启动段冻结范围，
   *  桥检测到签名变化会以 --resume 重启内核（上下文不丢）。
   *  上限 8 个（kernel/knowledge.mjs MAX_ASSOC_SPACES），超出的部分被内核忽略。 */
  knowledgeSpaces?: string[]
  /** 应用页作用域（2026-09-16，P2「应用页会话」）：设置后本会话的工具池**除默认工具外只含
   *  这个应用的控制工具**（public 应用也不旁路），便于在一个应用内专注干活。
   *  与 appId 的关系：作用域优先于 binding.json 的绑定（内核 app-spec.isAppVisible）。
   *  undefined = 现有行为（不为本会话收窄，走 binding/console 判定）。
   *  变更在**下一次发消息**时生效——作用域在内核启动段冻结，桥检测到签名变化会以
   *  --resume 重启内核（上下文不丢）。 */
  appPageId?: string
  /**
   * 该会话是某个应用的**专属 agent 会话**（2026-09-16，Task 4「应用生成后自动质检」）。
   * 与 appPageId 的分工：appPageId 是"工具池收窄到该应用"（内核读的冻结作用域），
   * appId 是"这个会话属于哪个应用"（渲染层用来做一个应用一个常驻会话的幂等查找）。
   * 二者在应用会话上**同时**被设置，且值相同。
   * undefined = 普通任务/对话会话（现有行为）。
   */
  appId?: string
  setId?: string
  /**
   * 【S2-D4 / S3】归属工作区：会话属于哪个工作区。个人工作区用固定值 `personal`
   * （与内核 `shared/attribution.mjs` 的 `DEFAULT_WORKSPACE_ID` 同源）；团队工作区形如
   * `team-<teamId>`（与 `kernel/team-sync.mjs` 的知识空间 id 同一约定）。
   *
   * **可选**：D4 之前写入的旧会话没有这个字段 ⇒ 读侧一律按'personal'归类
   * （`src/lib/teamModeUi.workspaceIdOfItem`），不伪造默认值、也不因此丢项。
   * 渲染层只用它做**侧边栏默认列表的模式筛选**（spec §5.9「受模式影响」一栏）；
   * 检索范围与数据可见性**不受**影响（同节的「不受模式影响」一栏）。
   */
  workspaceId?: string
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

export type ThemeMode = 'dark' | 'light' | 'dark-glass'
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
  /** 主题分组（2 实色 + 1 玻璃）—— ThemePicker 按此分组渲染 */
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

  // Glass 磨砂玻璃主题（仅 dark-glass 生效）
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
  /** 知识库文件导入上限（2026-09-14）：单次导入的文件数/总字节。服务端读桥 config.json
   *  并在保存时钳制（server/knowledge-import-policy.cjs），设置页写这里；
   *  两端口径由 server/knowledge-import-policy-parity.test.mjs 钉住。 */
  knowledgeImport: KnowledgeImportPolicy

  // YFWorking multi-provider config
  activeProvider: string
  providers: ModelProvider[]
  skillRoot: string
  autoCapture: boolean
  /** 自动图片桥接：对话粘贴图片时若主模型不支持视觉，自动调用视觉模型转文字描述（默认开启） */
  autoImageBridge: boolean
  /** 视觉模型来源 provider id（空=跟随 activeProvider）；视觉模型取自该 provider 的 visionModel 字段 */
  visionProviderId: string
  /** 思考深度（全局，Task 12）：新会话 spawn 经 PONOS_REASONING_EFFORT env 注入，
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
  /** 单条工具结果字节上限（2026-09-12 对标：50K 聚合 / 50KB / 10K tok）；
   *  未设=内核默认 20000 字符（落盘+预览替换）。值注入 PONOS_TOOL_RESULT_BUDGET_BYTES */
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
  /** S3 D1 知识注入策略灰度：'legacy'（缺省 = 既有行为）| 'unified'（块级抽调）。
   *  bridge 读它并透传 env PONOS_KNOWLEDGE_INJECT_MODE，判定权威在内核
   *  （kernel/knowledge-inject.mjs resolveInjectMode）。本期不加 GUI 控件（手工改 config.json）。 */
  knowledgeInjectMode?: 'legacy' | 'unified'
  /** 审批放行档位（全局，2026-09-12）：bridge 持久化并按此 spawn 内核
   *  （manual/auto 不传 --dangerously-skip-permissions）；缺省/非法 → bridge 归一为 loose。 */
  approvalMode?: string
  /** 运行日志持久化策略（2026-09-12）：bridge 钳制后落盘，写入端（桥/主进程）读同一份。 */
  logPolicy?: LogPolicy
  /** 知识库文件导入上限（2026-09-14）：bridge 钳制后落盘。 */
  knowledgeImport?: KnowledgeImportPolicy
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
  /**
   * 用户需求（M1）：用户在「新增应用」里填的"这个应用要能做什么"，多行原文（一行一条）。
   * ★ 老条目没有这个字段 ⇒ undefined ⇒ 语义等同"未填需求"（不迁移、不补默认值）。
   * 主进程落盘时按 2000 字符截断（electron/app-registry.cjs 与 app-agent.cjs 同口径）。
   */
  requirement?: string
  /**
   * 最后一次质检标记（Task 4「生成后自动跑一轮整体质量检验」）。
   * ★ 落 **registry.json**（electron/app-registry.cjs 的 upsertApp），**不落 spec.json**——
   *   writeSpec 每次写盘前都先备份，质检标记会把备份列表淹没。
   * ★ 指纹与 `specFingerprint(spec)` 同源：相等即"这一版已查过"（不重跑），
   *   不等（AI 修复/用户手改 spec 后）才自动再跑一轮。
   * 老条目没有这个字段 ⇒ undefined ⇒ 语义等同"从未质检"。
   */
  quality?: AppQualityMark | null
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
/**
 * 评审指出的一处缺口。
 * ★ 用对象而不是字符串：让"缺什么 / 为什么算缺 / 建议怎么补"分开可读，
 *   回喂给模型做补全时也能给出可执行的指引（这是 gaps 能真正驱动补全的前提）。
 */
export interface AppReviewGap {
  /** 缺口是什么（缺哪项能力、或哪条需求没被覆盖） */
  what: string
  /** 为什么算缺口（可空） */
  why?: string
  /** 建议怎么补（可空） */
  hint?: string
}

/**
 * 交付前评审结论（M4：生成结束后**同会话追加一次**评审调用产出）。
 * ★ 为什么要有它：用户明确反对"写死命令条数"，质量结论改由 LLM 给出具体 gaps，
 *   界面据此如实展示"到位 / 有几处缺口 / 是否已补全一轮 / 是否因预算跳过"。
 */
export interface AppReview {
  /** 评审结论（ok=到位；其余为模型给出的判定） */
  verdict: string
  /** 具体缺口（每条是"缺什么能力/哪条需求没被覆盖"） */
  gaps: AppReviewGap[]
  /** 评审说明（可为空串） */
  notes?: string
  /** 是否已把 gaps 回喂触发过一次补全轮 */
  applied?: boolean
  /**
   * 结局：no-gaps 无缺口 / refined 已补全 / refine-failed 补全后试跑未过（交付的是上一版通过的）
   * / skipped-budget 预算不足跳过 / review-failed 评审调用或解析失败（已降级，不影响交付）
   */
  outcome?: 'no-gaps' | 'refined' | 'refine-failed' | 'skipped-budget' | 'review-failed'
  at?: string
}

export interface AppSpec {
  specVersion: number
  appId: string
  name: string
  /** 可选描述（生成提示词会产出；内核校验对额外字段宽松） */
  desc?: string
  driver?: AppDriver
  target: AppTarget
  expose?: { mode: 'private' | 'console' | 'public' }
  /**
   * 该应用需要登录（生成期检测到登录墙时写入；老 Spec 没有这个字段，照常工作）。
   * needsLogin 为真但当前分区没有 Cookie 时，app:check 会如实提示"AI 调用会被登录墙挡住"。
   */
  auth?: { needsLogin?: boolean; loginUrl?: string }
  commands: AppSpecCommand[]
  /** 交付前评审结论（M4 产出；老 Spec 读回时为 undefined，界面需容错） */
  review?: AppReview | null
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
  /** 能力清单（三态通道 + 证据 + 下一步）：老版本主进程不返回该字段，故可选；失败路径为 null */
  surface?: AppSurface | null
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
   * login：需要人工登录（waiting=true 时界面要给"我已完成登录/取消等待"按钮）；
   * quality：封装质量校验未达标被打回；error：失败（必须带原因）
   */
  phase: 'fetch' | 'probe' | 'round' | 'explore' | 'stream' | 'parse' | 'invalid' | 'quality' | 'parsed' | 'verify' | 'login' | 'done' | 'error'
  round?: number
  maxRounds?: number
  /** 当前是第几次工具调用（explore 阶段） */
  toolCalls?: number
  /** 是否正在等待用户登录（仅 phase='login'）：true=等待中，false=已结束（detail 说明结果） */
  waiting?: boolean
  /** 站点/应用级分区键（phase='login' 时给"我已完成登录/取消等待"按钮回传用） */
  key?: string
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
  /** 环境级失败原因（执行器未就绪 / Spec 不存在）：此时 tried/failures 均为空，
   *  界面要如实说"是环境问题"而不是"应用有 N 条命令坏了"（Task 4 质检第 1 步） */
  error?: string
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
  /** 交付前评审结论（与 spec.review 同源，便于调用方直接读生成结果） */
  review?: AppReview | null
  /** 自主探索概况：模型自己调了哪些工具、几轮收敛（用于让用户看懂"生成过程做了什么"） */
  agent?: { turns: number; toolCalls: number; verified: boolean; stoppedBy?: string; trace?: unknown[] }
  /**
   * 登录情况（生成期检测到登录墙才有）：
   * attempted=false 且 reason='no-executor' = 需要登录但执行器不可用（本次未在登录态下验证）；
   * ok=false 但 spec 照常产出 = 未登录成功下生成，界面必须如实标注"未在登录态下验证"。
   */
  login?: { attempted: boolean; ok: boolean; reason: string; detail: string } | null
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
  /**
   * 自动分配下一个应用序号（工具识别号，形如 `app-001`）：新增对话框只读展示，用户不再手填。
   * 只在保存/生成时把拿到的 id 当作 appId 传下去（字段名与格式与手填时完全一致）。
   */
  appNextId: () => Promise<{ id: string }>
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
  appLogin: (payload: { url: string; sessionId?: string }) => Promise<{ ok: boolean; key?: string; sessionId?: string; url?: string; error?: string }>
  /**
   * 告知主进程"我已经登录完成了"——正在等登录的生成会立刻继续（不必等 Cookie 轮询）。
   * 返回 ok=false 表示"当前没有等待中的登录"（例如重复点击），**不是错误**，不要弹报错。
   */
  appLoginDone: (payload: { key: string }) => Promise<{ ok: boolean }>
  /** 取消等待登录：生成继续，但本次如实标注"未在登录态下验证" */
  appLoginCancel: (payload: { key: string }) => Promise<{ ok: boolean }>
  /**
   * 生成 App Spec（探测 → LLM → 结构校验 → read 试跑）。**不落盘**：
   * 必须由用户确认后另行调用 appWriteSpec 保存。
   * `requirement`（M1）是用户需求**原文**（多行，一行一条）——主进程 app-agent 负责归一化
   * 并作为覆盖度硬约束写进提示词；不传 ⇒ 提示词与改动前逐字一致。
   */
  appGenerate: (payload: { target: AppTarget; appId?: string; sessionId?: string; maxRounds?: number; requirement?: string }) => Promise<AppGenerateResult>
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
  /**
   * 确定性试跑（质检用，Task 4）：只跑无需必填参数的 read 命令；**不写 history**（试跑不是用户执行）。
   * failures 里每条都带真实 action + error（界面据此展示"哪里坏了、为什么"）。
   */
  appVerify: (appId: string) => Promise<{ ok: boolean; error?: string; tried: string[]; failures: { action: string; error: string }[]; notRun: string[]; skipped: string[] }>
  /** 写入质检标记（落 registry.json，不碰 spec.json）；quality 传 null 表示清掉旧标记 */
  appMarkQuality: (payload: { appId: string; quality: AppQualityMark | null }) => Promise<{ ok: boolean; error?: string }>
}

/** File dialogs (skill install / knowledge pack install) — exposed by preload as `yfworkingFile` */
export interface YFWFileAPI {
  openSkillPackage: () => Promise<string | null>
  /** S4：知识包市场"从本地文件安装"（只收 .zip）。可选——浏览器 dev 下该 API 不存在 */
  openKnowledgePack?: () => Promise<string | null>
  /**
   * 文件知识库导入（2026-09-14）：选文件（可多选）/ 选文件夹，只返回路径。
   * 可选——浏览器 dev 下不存在（调用方按"桌面端可用性"降级处理）。
   * 取消时 pickKnowledgeFiles 返回**空数组**（不是 null），调用方不必再判空。
   */
  pickKnowledgeFiles?: () => Promise<string[]>
  pickKnowledgeFolder?: () => Promise<string | null>
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

// --- 密码库（Password Vault）Types ---
// spec：docs/superpowers/specs/2026-09-15-password-vault-design.md
/** 错误码：不可用（环境）与损坏（文件）必须可区分，且都不能当成"空库" */
export type VaultErrorCode = 'unavailable' | 'corrupt' | 'not_found' | 'invalid' | 'io'
/** 列表条目：**不含 password**（明文只在主进程，需显示时单条 reveal） */
export interface VaultEntryMeta {
  id: string
  name: string
  url: string
  username: string
  notes: string
  tags: string[]
  createdAt: string
  updatedAt: string
}
export interface VaultFailure { ok: false; error: VaultErrorCode; message?: string }
export interface VaultStatus { ok: boolean; available: boolean; count: number; error?: VaultErrorCode; message?: string }
export interface VaultListResult { ok: boolean; entries: VaultEntryMeta[]; error?: VaultErrorCode; message?: string }
export interface VaultUpsertInput {
  id?: string
  name: string
  url?: string
  username?: string
  /** 缺省 = 更新时保持原密码；显式 '' = 清空；新增时必填 */
  password?: string
  notes?: string
  tags?: string[]
}
export interface YFWVaultAPI {
  status: () => Promise<VaultStatus>
  list: () => Promise<VaultListResult>
  upsert: (payload: VaultUpsertInput) => Promise<{ ok: true; entry: VaultEntryMeta } | VaultFailure>
  remove: (id: string) => Promise<{ ok: true } | VaultFailure>
  reveal: (id: string) => Promise<{ ok: true; password: string } | VaultFailure>
  copy: (id: string) => Promise<{ ok: true; clearInMs: number } | VaultFailure>
  // 应用密钥（模型 authToken 等）——与用户密码条目分区，不进密码列表 UI
  secretKeys: () => Promise<{ ok: true; keys: string[] } | VaultFailure>
  secretGetAll: () => Promise<{ ok: true; secrets: Record<string, string> } | VaultFailure>
  secretSet: (key: string, value: string) => Promise<{ ok: true } | VaultFailure>
  secretDelete: (key: string) => Promise<{ ok: true } | VaultFailure>
}

declare global {
  interface Window {
    yfworkingAPI?: YFWAPI
    yfworkingWindow?: YFWorkingWindowControls
    yfworkingFile?: YFWFileAPI
    /** 密码库：桌面端才有；浏览器 dev 下不存在（调用方按可用性降级） */
    yfworkingVault?: YFWVaultAPI
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

/**
 * 能力清单的类型**定义在 src/lib/appSurface.ts**（那里有归一化与三分文案，是可测的唯一出处），
 * 这里只做再导出，供组件与 IPC 契约共用同一份类型。
 */
export type { AppSurface, SurfaceCapability, SurfaceVerdict, CapabilityConfidence } from '@/lib/appSurface'
