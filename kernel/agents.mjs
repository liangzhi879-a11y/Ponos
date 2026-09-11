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
//        ---
//        <system prompt body>
// 解析失败/字段缺失的文件静默跳过（容错，不影响启动）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 内置系统级 agent。业务专业 agent（material-writer/table-expert 等）由 GUI
// 同步进 $PONOS_HOME/agents/，不在此重复定义。
export const BUILTIN_AGENTS = [
  {
    id: 'general-purpose',
    name: 'general-purpose',
    description: '通用子任务执行：当任务可独立委派、需多步研究、或需与主任务并行处理时使用；具备全部基础工具',
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'TodoWrite'],
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
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'WebFetch'],
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
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'WebFetch'],
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
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch'],
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
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch'],
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
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch'],
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
    return {
      id,
      name: id,
      description,
      tools: String(fields.tools || '').split(',').map((s) => s.trim()).filter(Boolean),
      // 2026-09-11：disallowedTools/effort/background frontmatter（对齐 CC agent 定义）
      disallowedTools: String(fields.disallowedTools || '').split(',').map((s) => s.trim()).filter(Boolean),
      model: fields.model || '',
      skills: String(fields.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
      effort: fields.effort || '',
      background: String(fields.background || '').toLowerCase() === 'true',
      systemPrompt: (m[2] || '').trim(),
    }
  } catch {
    return null
  }
}

// 扫描用户级 agent 目录：$PONOS_HOME/agents/*.md（跳过隐藏文件与 registry）
export function discoverUserAgents({ configDir } = {}) {
  const dir = join(configDir || '', 'agents')
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
export function resolveAgents({ configDir } = {}) {
  const byId = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]))
  for (const a of discoverUserAgents({ configDir })) byId.set(a.id, a)
  return [...byId.values()]
}

export function resolveAgent(agents, type) {
  return (agents || []).find((a) => a.id === type || a.name === type) || null
}
