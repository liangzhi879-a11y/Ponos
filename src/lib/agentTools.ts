// src/lib/agentTools.ts —— Agent 工具的**结构化模型**（2026-09-15，待处理清单 P1
// 「agent和skill页面及功能需要大改」A 条款：每张 agent 卡片可"配置关联工具控制"）。
//
// ## 为什么需要它（原来为什么不行）
//
// `Agent.tools` 一直是**自然语言句式**（`'All tools except Agent, Edit, Write'`），GUI 只给了
// 一个自由文本输入框。后果有两层：
//   ① 用户改它只能靠猜句式，写错**不报错**；
//   ② 更严重的是内核侧把它当"具体工具名数组"用 —— 那句声明被逗号切成
//      `['All tools except Agent','Edit','Write']`，最终该 agent 只剩 **Edit + Write**
//      （见 `kernel/agents.mjs` 的 `parseToolsSpec` 注释）。即"配置界面"当初配置出的
//      是一个不会读文件的 agent。
//
// 本模块把该字段变成**结构化三态模型**（全部/自定义/排除），并提供与内核**同语义**的
// 解析与格式化，使 GUI 写出的值一定是内核能正确理解的形式。
//
// ## 与内核的关系（镜像 + 守卫）
//
// 内核是权威（`kernel/agents.mjs` 的 `parseToolsSpec` / `resolveLaneTools`）。前端不能 import
// 内核模块（内核是子进程 + `.mjs`，不该进 bundle），故这里镜像一份，并用
// `agentTools.test.ts` 的漂移守卫对齐"工具名全集"（对照内核注册表枚举）。
// 漂移的代价是"界面列出内核不认识的名字" ⇒ 用户在界面上配了一个不存在的工具（静默无效）。

/** Agent 工具字段的三态：`all` 全部工具 / `allExcept` 全部（除） / `custom` 仅指定。 */
export type AgentToolsMode = 'all' | 'allExcept' | 'custom'

export type AgentToolsSpec = {
  mode: AgentToolsMode
  /** mode='custom' 时的白名单；mode='allExcept' 时的排除项 */
  names: string[]
}

/**
 * 工具目录（分组 + 中文标签）。
 *
 * **group 的作用**：21 个工具平铺在一个多选框里，用户无法快速判断"我该给这个 agent 什么"。
 * 按用途分组后，常见配置（只读分析 / 允许改文件 / 联网检索）可以一眼圈定。
 * 分组只影响展示顺序与提示，**不参与任何判定**（权限永远只看具体工具名）。
 */
export const TOOL_CATALOG: Array<{ name: string; group: string; label: string }> = [
  { name: 'Read', group: '文件', label: '读取文件' },
  { name: 'Write', group: '文件', label: '写入文件' },
  { name: 'Edit', group: '文件', label: '编辑文件' },
  { name: 'Glob', group: '文件', label: '按路径查找文件' },
  { name: 'Grep', group: '文件', label: '按内容搜索文件' },
  { name: 'Bash', group: '系统', label: '执行系统命令' },
  { name: 'Agent', group: '协作', label: '派发子 Agent' },
  { name: 'Task', group: '协作', label: '管理后台任务' },
  { name: 'TodoWrite', group: '协作', label: '维护任务清单' },
  { name: 'WebFetch', group: '联网', label: '抓取网页内容' },
  { name: 'WebSearch', group: '联网', label: '联网搜索' },
  { name: 'Browser', group: '联网', label: '浏览器操作' },
  { name: 'OCR', group: '文档与识别', label: 'OCR 识别' },
  { name: 'Vision', group: '文档与识别', label: '图片理解' },
  { name: 'Skill', group: '技能与知识', label: '加载技能' },
  { name: 'SkillSearch', group: '技能与知识', label: '搜索技能市场' },
  { name: 'MemorySearch', group: '技能与知识', label: '检索经验库' },
  { name: 'KnowledgeSearch', group: '技能与知识', label: '检索知识库' },
  { name: 'KnowledgeImport', group: '技能与知识', label: '导入知识库' },
  { name: 'KnowledgeDelete', group: '技能与知识', label: '删除知识（含回收站）' },
  { name: 'Workflow', group: '流程', label: '执行工作流' },
]

/** 工具名全集（展示与校验用）。 */
export const ALL_TOOL_NAMES: string[] = TOOL_CATALOG.map((t) => t.name)

/** 分组顺序（保持 TOOL_CATALOG 里首次出现的次序，避免每次渲染顺序漂移）。 */
export const TOOL_GROUPS: string[] = [...new Set(TOOL_CATALOG.map((t) => t.group))]

/** 已知工具名判定（大小写敏感，与内核一致：内核用 Set 精确匹配）。 */
export function isKnownTool(name: string): boolean {
  return ALL_TOOL_NAMES.includes(name)
}

/**
 * 解析 `Agent.tools` → 结构化模型（与内核 `parseToolsSpec` 同语义，见文件头）。
 *
 * 缺省/空/`All tools` → `{mode:'all'}`（= 不收窄），这是**最重要的兼容点**：
 * 老数据里 `'All tools'` 与 `[]` 都表示"不限制"，不能因为界面升级就把它们变成"零工具"。
 */
export function parseAgentTools(tools: unknown): AgentToolsSpec {
  const text = (Array.isArray(tools) ? tools.map((x) => String(x ?? '')).join(', ') : String(tools ?? '')).trim()
  if (!text) return { mode: 'all', names: [] }
  const m = text.match(/^all\s+tools\b/i)
  if (m) {
    const rest = text.slice(m[0].length).trim()
    const em = rest.match(/^except\b/i)
    if (!em) return { mode: 'all', names: [] }
    return { mode: 'allExcept', names: dedupe(rest.slice(em[0].length).split(',').map((s) => s.trim()).filter(Boolean)) }
  }
  return { mode: 'custom', names: dedupe(text.split(',').map((s) => s.trim()).filter(Boolean)) }
}

/**
 * 结构化模型 → 内核认识的字面量（写回 `Agent.tools`）。
 *
 * 输出**稳定形式**（`All tools except A, B` / `A, B` / `All tools`），不做大小写或顺序上的花样：
 * 内核与 `agents:sync` 都按这个格式解析，稳定形式让"界面点一下"与"手写文件"产出同一份数据，
 * 避免 diff 噪声与"看起来变了其实没变"。
 */
export function formatAgentTools(spec: AgentToolsSpec): string {
  const names = dedupe((spec?.names ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))
  if (spec?.mode === 'allExcept') return names.length ? `All tools except ${names.join(', ')}` : 'All tools'
  if (spec?.mode === 'custom') return names.join(', ')
  return 'All tools'
}

/** 去重保序（用户勾选顺序即语义顺序，排序会让"我改了什么"难以对账）。 */
function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}

/**
 * 该 spec 下**实际可用**的工具名集合（用于卡片摘要与"是否只读"判断）。
 * 与内核 `resolveLaneTools` 的分支保持一致：`custom` 里若无已知工具名，内核会退回"不限制"，
 * 界面必须如实显示这个**反直觉但真实**的行为——否则用户以为限制生效了。
 */
export function effectiveTools(spec: AgentToolsSpec): { names: string[]; unrestricted: boolean; unknownNames: string[] } {
  const known = (spec.names ?? []).filter(isKnownTool)
  const unknownNames = (spec.names ?? []).filter((n) => !isKnownTool(n))
  if (spec.mode === 'all') return { names: ALL_TOOL_NAMES, unrestricted: true, unknownNames: [] }
  if (spec.mode === 'allExcept') return { names: ALL_TOOL_NAMES.filter((n) => !spec.names.includes(n)), unrestricted: true, unknownNames }
  if (!known.length) return { names: ALL_TOOL_NAMES, unrestricted: true, unknownNames }
  return { names: known, unrestricted: false, unknownNames }
}

/** 卡片摘要：一行字说清"这个 agent 能用什么"，避免用户必须展开才知道。 */
export function summarizeAgentTools(spec: AgentToolsSpec): string {
  const eff = effectiveTools(spec)
  if (eff.unrestricted && spec.mode === 'all') return '全部工具'
  if (spec.mode === 'allExcept') return spec.names.length ? `全部（除 ${spec.names.join('、')}）` : '全部工具'
  if (eff.unrestricted) return '全部工具（所填名字内核不认识，已按不限制处理）'
  if (eff.names.length <= 4) return eff.names.join('、')
  return `${eff.names.slice(0, 4).join('、')} 等 ${eff.names.length} 个`
}

/** 只读判定（供卡片徽标用）：没有写/执行类工具 = 只读。 */
const WRITE_TOOLS = ['Write', 'Edit', 'Bash', 'KnowledgeImport', 'KnowledgeDelete']
export function isReadOnlyTools(spec: AgentToolsSpec): boolean {
  const eff = effectiveTools(spec)
  return eff.names.length > 0 && !eff.names.some((n) => WRITE_TOOLS.includes(n))
}
