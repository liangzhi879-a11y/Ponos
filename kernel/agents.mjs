// Ponos-turbo agent 注册（内置 + 用户级扫描）——subagent 体系的路由依据
// ---------------------------------------------------------------------------
// 两个来源：
//   1. BUILTIN_AGENTS：内核内置系统级 agent（GUI 业务 agent 不内置，由
//      agents:sync 写入 $PONOS_HOME/agents/*.md 走扫描）
//   2. discoverUserAgents：扫描 $PONOS_HOME/agents/*.md（frontmatter 格式与
//      GUI agents:sync 写入一致，见 multi-agent-collab 设计 §4.1）：
//        ---
//        name: <id>
//        description: <whenToUse 路由文案（换行已压单行，YAML 双引号转义）>
//        tools: Bash, Read, ...
//        model: deepseek-v4-flash
//        skills: ...
//        workflows: id1, id2   （可选：绑定的工作流 id，过滤 bound 工作流可见性）
//        ---
//        <system prompt body>
// 解析失败/字段缺失的文件静默跳过（容错，不影响启动）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDisabled, excludeDisabled } from './disabled.mjs'

// 内置系统级 agent。业务专业 agent（material-writer/table-expert 等）由 GUI
// 同步进 $PONOS_HOME/agents/，不在此重复定义。
export const BUILTIN_AGENTS = [
  {
    id: 'general-purpose',
    name: 'general-purpose',
    description: '通用子任务执行：当任务可独立委派、需多步研究、或需与主任务并行处理时使用；具备全部基础工具',
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'Skill'],
    model: '',
    systemPrompt: [
      '你是 Ponos 的子 Agent（general-purpose），由主 Agent 委派执行独立子任务。',
      '请遵循与主 Agent 相同的工作规范：先 Read 确认现状再 Write/Edit；工具结果如实反映；',
      '最终以简体中文给出任务结论（摘要 + 关键依据），不要复述过程细节。',
    ].join('\n'),
  },
  {
    id: 'researcher',
    name: 'researcher',
    description: '调查与研究类任务：当任务需要检索文件、阅读资料、汇总多方信息时使用',
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'WebFetch', 'Skill'],
    model: '',
    systemPrompt: [
      '你是 Ponos 的子 Agent（researcher），负责调查与资料汇总。',
      '优先用 Glob/Grep 定位资料、Read 精读，需要外部信息时用 WebFetch。',
      '最终以简体中文给出结构化调研结论（要点列表 + 信息来源）。',
    ].join('\n'),
  },
  // —— spec 工作流与 subagent-driven 模式的配套 agent（2026-09-11 系统化升级）——
  {
    id: 'implementer',
    name: 'implementer',
    description: '实现者：按任务说明实现代码/文件改动（可写文件，禁止嵌套派发子 Agent）',
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'Skill'],
    disallowedTools: ['Agent', 'Task'],
    model: '',
    systemPrompt: [
      '你是 Ponos 的实现者子 Agent（implementer）。',
      '你会收到一条明确的任务说明（来自 tasks.md 的任务项）：先 Read 相关现状，再按最小改动实现；',
      '完成后必须自验证（运行项目验证命令/测试），并在结尾输出：改动文件清单 + 验证结果 + 遗留问题。',
      '禁止嵌套派发子 Agent；只做该任务范围内的改动，不顺手重构。',
    ].join('\n'),
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    description: '审查者：只读审查刚完成的实现是否符合 spec 与质量标准，输出问题清单（不改文件）',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Skill'],
    disallowedTools: ['Write', 'Edit', 'Agent', 'Task', 'TodoWrite'],
    model: '',
    systemPrompt: [
      '你是 Ponos 的审查者子 Agent（reviewer）。只读审查，禁止修改任何文件。',
      '对照任务说明与 spec 摘录检查：① 是否完整实现任务要求；② 与 spec 验收场景是否一致；',
      '③ 代码质量与最小改动原则；④ 验证证据是否充分。',
      '结尾输出：逐条问题清单（含文件与行号）+ 总体判定（通过 / 需返工，返工时列出必须修复项）。',
    ].join('\n'),
  },
  {
    id: 'explorer',
    name: 'explorer',
    description: '探索者：只读研究/信息收集，产结构化的调查结论，不改任何文件',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Skill'],
    disallowedTools: ['Write', 'Edit', 'Agent', 'Task', 'TodoWrite'],
    model: '',
    systemPrompt: [
      '你是 Ponos 的探索者子 Agent（explorer）。只读调查，禁止修改任何文件。',
      '用 Glob/Grep 定位、Read 精读、WebFetch 补外部信息。',
      '结尾输出结构化结论：发现要点 + 关键文件（带路径与行号）+ 建议的下一步。',
    ].join('\n'),
  },
  {
    id: 'planner',
    name: 'planner',
    description: '规划者：只读分析需求并产实现计划（bite-sized 步骤 + 每步验证方式），不改文件',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Skill'],
    disallowedTools: ['Write', 'Edit', 'Agent', 'Task', 'TodoWrite'],
    model: '',
    systemPrompt: [
      '你是 Ponos 的规划者子 Agent（planner）。只读规划，禁止修改任何文件。',
      '输入：需求/目标说明。输出：实现计划——按独立可测切分的步骤清单（每步：做什么 + 涉及文件 + 验证方式），',
      '标注步骤间依赖与可并行项；有歧义时列出需用户澄清的问题。',
    ].join('\n'),
  },
]

// frontmatter 值解析：GUI 写入用 YAML 双引号包裹（toYamlString：\\ \" \n 转义）
function parseYamlValue(raw) {
  let v = String(raw ?? '').trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1)
    v = v.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
  }
  return v.trim()
}

// 解析单个 agent .md（frontmatter + 正文）。返回 { id, name, description,
// tools, model, skills, systemPrompt }；不合法返回 null（容错跳过）。
/**
 * 解析 agent 的 `tools` 声明（2026-09-15，P1「agent和skill页面及功能需要大改」A 条款）。
 *
 * ## 为什么需要这一步（修的是一个**静默且危险**的既存缺陷）
 *
 * `tools` 一直是**自然语言句式**（GUI `src/lib/agents.ts` 里写的是
 * `'All tools except Agent, Edit, Write'`），而下游（`engine.mjs` 的 laneOptions）把它当
 * **具体工具名数组**用。原先这里直接按逗号 split，于是那句声明被切成
 * `['All tools except Agent', 'Edit', 'Write']`，再经过 engine 的"白名单里只要有一个认识的名字
 * 就不重置"守卫（`Edit`/`Write` 恰是真实工具名 ⇒ 守卫不生效），该 agent 最终只剩
 * **Edit + Write 两个工具**——一个"不会读文件、只会改文件"的 agent，且**没有任何报错**。
 * 对只读型专业 agent 而言，这既是能力缺失也是安全性倒退。
 *
 * ## 语义
 *
 *   · `'All tools'` / 空 / 缺省     → 不限制（`{ tools: [], disallowed: [] }`，
 *     与 engine "allowedTools 为空 = 全量放行"的既有约定一致）
 *   · `'All tools except A, B'`      → 不限制白名单 + 禁用 A、B（大小写不敏感、忽略空白）
 *   · `'Read, Glob, Grep'`           → 显式白名单
 *
 * 参数既接受字符串也接受**数组**（历史上有两种写法），数组会先拼回逗号串再解析，
 * 保证 `['All tools except Agent, Edit, Write']` 与 `'All tools except Agent, Edit, Write'`
 * 行为一致——GUI 侧两种都写过。
 *
 * 无法识别的自由文本**不静默丢弃**：作为白名单项返回，交由 engine 的 `knownToolNames` 守卫
 * 与 `warnUnknownAgentRefs` 报出（保底行为与改动前一致，不会更坏）。
 *
 * @returns {{ tools: string[], disallowed: string[], allTools: boolean }}
 */
export function parseToolsSpec(raw) {
  const text = (Array.isArray(raw) ? raw.map((x) => String(x ?? '')).join(', ') : String(raw ?? '')).trim()
  if (!text) return { tools: [], disallowed: [], allTools: true }
  // 逗号切分后再 trim 并丢空项：`'Read, , Glob'` 这类手写失误不该产生幽灵工具名。
  const m = text.match(/^all\s+tools\b/i)
  if (m) {
    const rest = text.slice(m[0].length).trim()
    const em = rest.match(/^except\b/i)
    if (!em) return { tools: [], disallowed: [], allTools: true }
    const except = rest.slice(em[0].length).split(',').map((s) => s.trim()).filter(Boolean)
    return { tools: [], disallowed: except, allTools: true }
  }
  return { tools: text.split(',').map((s) => s.trim()).filter(Boolean), disallowed: [], allTools: false }
}

/**
 * 解析 agent 的 `skills` 声明（与 tools 同款问题）：自然语言 `'All skills'` 与显式列表并存。
 * 语义：`'All skills'`/空 → `[]`（不限制）；否则显式白名单。
 */
export function parseSkillsSpec(raw) {
  const text = (Array.isArray(raw) ? raw.map((x) => String(x ?? '')).join(', ') : String(raw ?? '')).trim()
  if (!text || /^all\s+skills\b/i.test(text)) return []
  return text.split(',').map((s) => s.trim()).filter(Boolean)
}

/** 发现内置与用户 agent 之外的解析入口（导出供测试与 GUI 一致性守卫使用）。 */
export function parseAgentTools(raw) {
  return parseToolsSpec(raw)
}

/**
 * 由 agent 的工具声明算出**子 Agent 车道**的工具范围（2026-09-15，A 条款）。
 *
 * 从 `engine.mjs` 的 Task 工具里抽出来，动机是**可测**：这段逻辑（"空白名单 = 全量"、
 * "名字全不认识 = 退回全量"、"只禁不白 = 全量减禁用集"）原先内联在 2900 行的 engine 里，
 * 只能靠"跑一个真子 Agent 看它能不能调 Read"来间接验证——而那正是本缺陷（agent 只剩
 * Edit/Write）长期无人发现的原因。抽成纯函数后可直接断言每个分支。
 *
 * 三个分支与既有行为**逐条对齐**（零回归，engine 侧不再自行判断）：
 *   ① 白名单一项都不认识 → `undefined`（= 不收窄）：防"名单写错导致 lane 无任何工具可用"；
 *   ② 只给了禁用集     → 全量 − 禁用集（reviewer/planner 这类只读 agent 靠这条）；
 *   ③ 都没给           → `undefined`（全量）。
 *
 * @param {{tools?: string[], disallowedTools?: string[], allToolNames: string[]}} p
 * @returns {string[]|undefined} 收窄后的白名单；`undefined` = 不收窄
 */
export function resolveLaneTools({ tools, disallowedTools, allToolNames = [] } = {}) {
  const known = new Set(allToolNames)
  let allowed = Array.isArray(tools) && tools.length ? [...tools] : undefined
  // ① 空 schema 守卫：名单无一命中已注册工具名时视为"未收窄"。空集（非 undefined）会让
  //    lane 收到 tools:[]（子 Agent 无任何工具可用）——那是最难排查的一种"静默失效"。
  if (allowed && !allowed.some((t) => known.has(t))) allowed = undefined
  // ② 只禁不白：自动补齐白名单 = 全量 − 禁用集
  const dis = Array.isArray(disallowedTools) ? disallowedTools.filter(Boolean) : []
  if (dis.length) {
    const disSet = new Set(dis)
    allowed = (allowed || allToolNames).filter((t) => !disSet.has(t))
  }
  return allowed
}

export function parseAgentMarkdown(text) {
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ''))
    if (!m) return null
    const fields = {}
    for (const line of m[1].split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const idx = t.indexOf(':')
      if (idx <= 0) continue
      fields[t.slice(0, idx).trim()] = parseYamlValue(t.slice(idx + 1))
    }
    const id = fields.name || ''
    const description = fields.description || ''
    if (!id || !description) return null // 内核解析要求 name/description 非空
    // tools / disallowedTools 走 `parseToolsSpec`（2026-09-15，A 条款）：
    // 自然语言句式（`All tools except Agent, Edit, Write`）必须在这里就变成**可执行**的
    // 白名单/禁名单，否则下游只会按逗号切出一堆伪工具名（详见 parseToolsSpec 的注释）。
    // frontmatter 里若同时写了 `disallowedTools`，与 tools 句式里的 except 项**合并**
    // （两者都是"禁用"意图，合并比"后者覆盖前者"更符合用户预期，且不会静默丢掉任一处声明）。
    const spec = parseToolsSpec(fields.tools)
    const explicitDisallowed = String(fields.disallowedTools || '').split(',').map((s) => s.trim()).filter(Boolean)
    return {
      id,
      name: id,
      description,
      tools: spec.tools,
      allTools: spec.allTools,
      // 2026-09-11：disallowedTools/effort/background frontmatter（agent 定义字段）
      disallowedTools: [...new Set([...spec.disallowed, ...explicitDisallowed])],
      model: fields.model || '',
      // skills 同理（`All skills` 是自然语言写法，不能当技能名）
      skills: parseSkillsSpec(fields.skills),
      // Task 7：workflows 绑定——逗号分隔的工作流 id 列表（空/缺失 → []）。该字段由
      // electron/main.cjs（agents:sync）写入 .md frontmatter；内核在给定 agentId 时
      // 按该 agent 过滤 expose.mode=bound 工作流的工具可见性（调用方以 agent.name 作
      // agentId，见 dyntools.visibilityOf / buildWorkflowTools）。
      workflows: String(fields.workflows || '').split(',').map((s) => s.trim()).filter(Boolean),
      effort: fields.effort || '',
      background: String(fields.background || '').toLowerCase() === 'true',
      systemPrompt: (m[2] || '').trim(),
    }
  } catch {
    return null
  }
}

// 扫描用户级 agent 目录：$PONOS_HOME/agents/*.md（跳过隐藏文件与 registry）
// root 可直接指定 agent 目录（与 discoverSkills({ root }) 同语义）；configDir 则
// 按 $PONOS_HOME 语义拼 <configDir>/agents。
export function discoverUserAgents({ configDir, root } = {}) {
  const dir = root ? String(root) : join(configDir || '', 'agents')
  if (!existsSync(dir)) return []
  const out = []
  let entries = []
  try { entries = readdirSync(dir) } catch { return [] }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    if (name.startsWith('.')) continue
    let text = ''
    try { text = readFileSync(join(dir, name), 'utf-8') } catch { continue }
    const agent = parseAgentMarkdown(text)
    if (agent) out.push(agent)
  }
  return out
}

// 全量 agent 表：内置 ∪ 用户级（用户级同名覆盖内置，GUI 可定制）
export function resolveAgents({ configDir, disabled } = {}) {
  const builtinIds = new Set(BUILTIN_AGENTS.map((a) => a.id))
  const byId = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
  for (const a of discoverUserAgents({ configDir })) byId.set(a.id, a)
  // 全局停用过滤（2026-09-15，D 条款）。**在这里读注册表而不是让调用方传**：
  // resolveAgents 有多个调用点（engine 的 Task 工具、readonly 的只读面），若改成"调用方传
  // disabled"，漏传的调用点会静默把停用 agent 放回来——而漏传不会报错。函数内自读只有一处
  // 真相，任何调用点都不可能忘。显式传 `disabled`（数组）时以传入为准（供测试与未来复用）。
  const off = disabled !== undefined ? disabled : readDisabled({ configDir }).agents
  // `builtin` 标记（2026-09-15，批次二 H）：区分"内核硬编码内置 agent"与"用户/GUI 同步的 .md agent"。
  // 界面需要它来把**只在核心里存在**的 agent（researcher/implementer/reviewer/explorer/planner）
  // 单独列出——这 5 个不在 GUI 自己的 agent 列表里，若不列出，用户在界面上根本看不到、也就停不掉。
  // 加字段是**纯增量**：既有消费者只读 id/tools/skills 等，多一个布尔字段不影响任何行为。
  return excludeDisabled([...byId.values()], off).map((a) => ({ ...a, builtin: builtinIds.has(a.id) }))
}

export function resolveAgent(agents, type) {
  return (agents || []).find((a) => a.id === type || a.name === type) || null
}
