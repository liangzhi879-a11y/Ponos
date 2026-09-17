// src/lib/teamModeUi.ts —— S3 团队协同的**模式语义**判据（渲染层纯逻辑，2026-09-17）
//
// spec：`docs/superpowers/specs/2026-09-14-team-collaboration-design.md`
//   §5.9「模式切换的数据语义（关键约束）」——原文表：
//     **受模式影响**   → 侧边栏默认列表（会话 / 工作流 / 知识）的**筛选范围**
//     **不受模式影响** → **知识检索范围**（默认**跨全部空间**，结果标注来源）
//   §5.9「为什么必须明说"模式 ≠ 隔离"」——切到个人模式**不等于**团队数据不可见，
//     数据就在本地磁盘上；若 UI 让人以为"切了模式 = 安全"，那是在制造虚假安全感。
//   §10 S3 验收 13 → 切换模式后知识检索仍跨全部空间、不出现"搜不到已存内容"。
//
// 为什么单独成文件（与 `knowledgeScopeUi.ts` 同一纪律）：`.tsx` 进不了 `node --test`，
// 而本文件的每一条判据"判错了都会出丑"：
//   · `matchesMode` 判反 → 团队模式下看到空列表（用户以为数据没了）；
//   · `knowledgeSearchScopeFor` 被判成"按模式收窄检索" → 用户反复遇到"我明明存过怎么搜不到"，
//     这正是 spec 点名要避免的一类**反向**要求；
//   · `effectiveMode` 判错 → 没加入团队却停在"团队"模式，界面全空且无从恢复。
// 故：**零 import、纯函数、无时间/无随机/无 IO**（照 `appQuality.ts` 三条纪律）。

/** 一级模式（header 开关）：我正在做**哪一类**工作。**不是数据隔离开关**（§5.9 原文）。 */
export type WorkspaceMode = 'personal' | 'team'

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ['personal', 'team']

/**
 * 个人工作区固定值 —— 与内核**同源**：`shared/attribution.mjs` 的 `DEFAULT_WORKSPACE_ID`
 * （§5.9 字面："个人工作区用固定值 `personal`"）。
 * 这里镜像而不 import 的原因同 `knowledgeScopeUi.ts` 顶部：内核是独立进程（spawn 的 .mjs），
 * 前端 bundle 不该把内核模块拉进来。代价是两处可能漂移，故**内核始终是收口方**：
 * 这里判错最多是"列表筛错一项"，不影响数据本身。
 */
export const PERSONAL_WORKSPACE_ID = 'personal'

/**
 * 团队工作区/知识空间前缀 —— 与 `kernel/team-sync.mjs:28` 的 `teamSpaceId()` 同源
 * （`team-<teamId>`）。
 */
export const TEAM_WORKSPACE_PREFIX = 'team-'

/** 落盘/外部输入的模式清洗：合法值透传，其余（脏 JSON / 未知值 / 非字符串）→ 'personal'。
 *  兜底方向是刻意的：**没加入任何团队时"个人"是唯一正确的模式**，
 *  误判成 'team' 会让界面进入一个空列表状态（用户以为团队数据丢了）。 */
export function sanitizeWorkspaceMode(raw: unknown): WorkspaceMode {
  return WORKSPACE_MODES.includes(raw as WorkspaceMode) ? (raw as WorkspaceMode) : 'personal'
}

/**
 * 实际生效的模式：**一个团队都没有时恒为 'personal'**。
 * 团队能力默认关闭（plan §2.2 opt-in/零回归）：未加入团队 ⇒ 模式开关对列表**不产生任何筛选**，
 * 既有用户看到的一切与今日逐字相同。
 * `teamCount` 传 null/undefined（还没读到团队列表）时**保持原模式**——宁可显示略旧的模式，
 * 也不要在首帧把用户已选的团队模式闪回个人模式。
 */
export function effectiveMode(mode: unknown, teamCount: number | null | undefined): WorkspaceMode {
  const m = sanitizeWorkspaceMode(mode)
  if (teamCount === null || teamCount === undefined) return m
  return Number(teamCount) > 0 ? m : 'personal'
}

/** 模式开关是否可用（团队能力是否已被激活）：没有任何团队 ⇒ 不可切换（§10 S3-1 空态引导）。 */
export function modeSwitchEnabled(teamCount: number | null | undefined): boolean {
  return Number(teamCount ?? 0) > 0
}

/**
 * 在两种模式之间**翻转**需要做什么（返回 `null` = 无法翻转，调用方**不应**渲染按钮）。
 *
 * 为什么单独抽成纯函数而不是在空态组件里 `mode === 'team' ? ... : ...`：
 *   空态「一键翻转」有四处接线（会话 / 任务 / 工作流 / 知识空间），这类"判错了会出丑"的判据
 *   若散在四处 JSX 里，改一处漏三处 —— 典型表现就是"点了按钮没反应"（界面谎言）。
 *
 * 三条规则：
 *   · 当前是团队模式 → 回个人模式，**不动 `activeTeamId`**（下次再进团队模式仍回到同一个团队）；
 *   · 当前是个人模式 + 有团队 → 进团队模式，沿用已选的 `activeTeamId`，没选过就用第一个团队
 *     （与 `teamStore.setActiveTeam` 的语义一致：选了团队却停在个人模式，列表会立刻把它筛掉）；
 *   · 当前是个人模式 + **没有可用团队** → `null`：没团队时"团队模式"无处可去，按钮该消失而不是
 *     点了没反应（§10 S3-1 空态引导的既有纪律）。
 * 团队 id 取空值（脏数据 / 列表项没有 id）时同样视为"不可用"，避免 `setActiveTeam('')` 这种
 * 只把状态改一半的落点。
 */
export function modeFlip(
  mode: WorkspaceMode,
  teams: { id: string }[] | null,
  activeTeamId: string | null,
): { mode: WorkspaceMode; teamId: string | null } | null {
  const m = sanitizeWorkspaceMode(mode)
  if (m === 'team') return { mode: 'personal', teamId: activeTeamId }
  const first = Array.isArray(teams) && teams.length ? String(teams[0]?.id ?? '').trim() : ''
  const active = typeof activeTeamId === 'string' && activeTeamId.trim() ? activeTeamId : null
  const teamId = active ?? (first || null)
  return teamId ? { mode: 'team', teamId } : null
}

/** `team-<teamId>` → `<teamId>`；非团队工作区 → null（供展示"来自哪个团队"）。 */
export function teamIdOfWorkspace(workspaceId: unknown): string | null {
  const id = String(workspaceId ?? '').trim()
  if (!id || !id.startsWith(TEAM_WORKSPACE_PREFIX)) return null
  const rest = id.slice(TEAM_WORKSPACE_PREFIX.length)
  return rest || null
}

/**
 * 该工作区归属是否属于**团队侧**。
 *
 * 三条判据（任一成立即团队）：
 *   · 显式等于某个已加入团队的 `teamId`（内核在会话/工作流上落的归属可能是 teamId 本身）；
 *   · 形如 `team-<teamId>`（`kernel/team-sync.mjs` 的知识空间前缀，会话/工作流也复用同一约定）；
 *   · 前缀命中但团队列表里没有它 —— **仍判团队**：那说明"曾经加入过、现在团队源不可用"，
 *     把它当个人数据会让人误以为"我存过的东西消失了"（`effectiveMode` 之外的第二道防线）。
 * 空值/`personal` ⇒ 个人（旧数据没有 workspaceId = D4 之前写的，按'personal'口径归类，
 * 与 `server/workflow-store.mjs` 读取侧"缺省即个人"一致）。
 */
export function isTeamWorkspace(workspaceId: unknown, teamIds: readonly string[] = []): boolean {
  const id = String(workspaceId ?? '').trim()
  if (!id || id === PERSONAL_WORKSPACE_ID) return false
  if (id.startsWith(TEAM_WORKSPACE_PREFIX)) return true
  return teamIds.some((t) => String(t ?? '').trim() === id)
}

/** 单项是否应出现在当前模式的默认列表里（纯谓词，`filterByMode` 与单测共用同一套语义）。 */
export function matchesMode(workspaceId: unknown, mode: unknown, teamIds: readonly string[] = []): boolean {
  const m = sanitizeWorkspaceMode(mode)
  const team = isTeamWorkspace(workspaceId, teamIds)
  return m === 'team' ? team : !team
}

/** 取单项的工作区归属：显式字段 + 兜底个人。用 `in` 判定而非真值判定——
 *  空串（脏数据）也应落到个人桶，而不是被真值判定悄悄当成"未分类"漏掉。 */
export function workspaceIdOfItem(item: unknown): string {
  if (!item || typeof item !== 'object') return PERSONAL_WORKSPACE_ID
  const v = (item as { workspaceId?: unknown }).workspaceId
  const s = typeof v === 'string' ? v.trim() : ''
  return s || PERSONAL_WORKSPACE_ID
}

/** 通用筛选：`idOf` 由调用方给（会话/工作流读 `workspaceId`，知识空间读 `id`）。 */
export function filterByMode<T>(
  items: readonly T[] | null | undefined,
  mode: unknown,
  opts: { teamIds?: readonly string[]; idOf?: (item: T) => unknown } = {},
): T[] {
  const list = Array.isArray(items) ? items : []
  const teamIds = opts.teamIds ?? []
  const idOf = opts.idOf ?? ((item: T) => workspaceIdOfItem(item))
  return list.filter((item) => matchesMode(idOf(item), mode, teamIds))
}

/** 侧边栏默认列表（会话）按模式筛选。 */
export function filterConversationsByMode<T>(
  items: readonly T[] | null | undefined, mode: unknown, teamIds: readonly string[] = [],
): T[] {
  return filterByMode(items, mode, { teamIds, idOf: (c) => workspaceIdOfItem(c) })
}

/** 侧边栏默认列表（工作流）按模式筛选。 */
export function filterWorkflowsByMode<T>(
  items: readonly T[] | null | undefined, mode: unknown, teamIds: readonly string[] = [],
): T[] {
  return filterByMode(items, mode, { teamIds, idOf: (w) => workspaceIdOfItem(w) })
}

/**
 * 侧边栏默认列表（知识**空间**）按模式筛选：判据取**空间 id**（不是 workspaceId 字段）——
 * 知识条目的归属在既有模型里已由 `spaceId` 承载（`shared/attribution.mjs` 头部注释说明），
 * 另造一个 workspaceId 就是 P7 的平行体系。
 */
export function filterKnowledgeSpacesByMode<T extends { id?: unknown }>(
  items: readonly T[] | null | undefined, mode: unknown, teamIds: readonly string[] = [],
): T[] {
  return filterByMode(items, mode, { teamIds, idOf: (s) => s?.id })
}

// ---------------------------------------------------------------------------
// 🔴 反向断言①：模式**不得**影响知识检索范围（spec §5.9 原文的"不受模式影响"一栏）
// ---------------------------------------------------------------------------

export interface KnowledgeSearchScope {
  /** 恒为 'all'：检索范围永远是全部空间，结果**标注来源**而不是按模式过滤掉。 */
  scope: 'all'
  /** `undefined` = **不发 `spaces` 参数** = 全部空间（`knowledgeApi.ts` 的 csv 约定：空数组的正确表达是不发）。 */
  spaceIds: undefined
}

/**
 * 模式 → 知识检索范围。
 *
 * **恒返回同一个"全部空间"范围，与 mode 无关** —— 这是 spec §5.9 明文的反向要求：
 *   "**不受**模式影响 = **知识检索范围**——默认跨全部空间，结果标注来源"，
 * 且给出了理由：知识空间本就是并列模型（`shared/knowledge-core.mjs:507`），搜索天然跨空间；
 * 一旦按模式隔离，用户会反复遇到"我明明存过怎么搜不到"（体感 = 数据丢失）。
 *
 * 为什么把它做成**函数**而不是在视图里写死 `undefined`：
 *   ① 让"检索范围"这件事有**唯一收口点**，未来若真要改（例如加"仅团队空间"的**用户可选**筛选项，
 *      那也是用户选的、不是模式决定的），必须显式改这里 ⇒ 单测立刻变红；
 *   ② 参数位保留 `mode` 是**故意的**：调用点写 `knowledgeSearchScopeFor(mode)` 时，
 *      类型与实现都摆明"我看了模式，结论仍然不变"。写成无参函数会让"忘了考虑模式"与
 *      "刻意不考虑模式"在源码上无法区分。
 */
export function knowledgeSearchScopeFor(_mode: unknown): KnowledgeSearchScope {
  return { scope: 'all', spaceIds: undefined }
}

// ---------------------------------------------------------------------------
// 设置窗的「团队」分区：跨窗口跳转的收口（header 的模式开关 → 设置窗的团队页）
// ---------------------------------------------------------------------------

/** 设置窗的分区 id（`SettingsView` 的 Section 联合类型里必须有同名成员）。 */
export const SETTINGS_TEAM_SECTION = 'team'

/**
 * 请求分区用的 localStorage 键。
 *
 * 为什么走 localStorage 而不是 IPC 参数：`window.yfworkingWindow.openUtility(kind)` 只接
 * kind（preload 的既有签名，2026-09-10 外置设置窗时定的），加一个"分区"参数要动 preload +
 * 主进程 + 类型三处；而这是**一次性意图**（不是需要订阅的状态）。仓库既有同款先例：
 * 设置窗通过 localStorage 与主窗口同步视图（`settingsStore.ts` 的跨窗口同步）。
 */
export const SETTINGS_SECTION_STORAGE_KEY = 'yfworking-settings-section'

/** 清洗"请求的分区"：非空字符串透传，其余 → null（脏 JSON/旧版本不改变设置窗的默认分区）。 */
export function sanitizeRequestedSection(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return s ? s : null
}

/** 该请求是否指向团队分区（设置窗挂载时的一次性判定）。 */
export function isTeamSectionRequest(raw: unknown): boolean {
  return sanitizeRequestedSection(raw) === SETTINGS_TEAM_SECTION
}

/**
 * 团队页要**直接落到**哪个子视图（header 的两个按钮语义不同：创建 ≠ 加入）。
 *
 * 为什么需要它：header 空态引导有「创建团队」「加入团队」两个按钮，若都只是跳到团队页，
 * 用户还得再点一次同义按钮 —— 两个按钮同一效果是典型的界面谎言（点了像是没生效）。
 */
export const SETTINGS_TEAM_INTENT_KEY = 'yfworking-team-intent'

export type TeamPanelIntent = 'manage' | 'create' | 'join'

/** 清洗"请求的团队子视图"：三值透传，其余（脏值/缺省）→ 'manage'（= 只显示团队页，不预开表单）。 */
export function sanitizeTeamIntent(raw: unknown): TeamPanelIntent {
  const s = typeof raw === 'string' ? raw.trim() : ''
  return s === 'create' || s === 'join' ? s : 'manage'
}
