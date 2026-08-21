// YFW-turbo 提示词组装（LLM 行为逻辑层）
// ---------------------------------------------------------------------------
// 三层叠加（顺序 = 优先级从低到高，后者覆盖前者）：
//   1. buildBaseSystemPrompt —— 内核基础行为规范（身份：YFWorking + 工具纪律/
//      回复规范）。身份内置于基础层，使 TUI/CLI 直跑时模型即自称 YFWorking。
//   2. discoverAgentsMd —— 项目指令 AGENTS.md（cwd 及祖先链至 git root，
//      加 --add-dir 根目录），成熟方案（Claude Code 等）的标配。
//   3. append 文件（cli 注入的 GUI 提示词：身份/技能/格式规范）——最高优先级，
//      GUI 层仍可覆盖/强化身份声明。
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// 从 cwd 向上到 git root（含），以及 addDirs 根目录，发现 AGENTS.md。
// 返回 [{ path, content }]，近者优先、去重。
export function discoverAgentsMd({ cwd, addDirs = [] }) {
  const found = []
  const seen = new Set()
  const candidates = []
  let dir = cwd
  while (dir) {
    candidates.push(dir)
    const parent = dirname(dir)
    const isGitRoot = existsSync(join(dir, '.git'))
    if (parent === dir) break
    dir = parent
    if (isGitRoot) break // 已到项目根，不再向上（避免注入无关家目录内容）
  }
  for (const d of [...candidates, ...(addDirs || [])]) {
    if (!d) continue
    const p = join(d, 'AGENTS.md')
    if (existsSync(p) && !seen.has(p)) {
      seen.add(p)
      let content = ''
      try { content = readFileSync(p, 'utf-8') } catch { continue }
      found.push({ path: p, content })
    }
  }
  return found
}

// 内核基础行为规范（LLM 行为逻辑）：YFWorking 身份 + 工作规范。
// cwd 注入当前工作目录（对照 claude 的 "Primary working directory:" 注入），
// 让模型基于确定路径规划工具调用，减少试错式路径猜测。
export function buildBaseSystemPrompt({ toolNames = [], cwd = '' } = {}) {
  return [
    '你是 YFWorking 的 AI 助手，运行在 YFW-turbo 内核上，通过工具完成任务。请遵循以下工作规范：',
    ...(cwd ? [`当前工作目录：${cwd}（工具的相对路径均相对于此目录解析）`] : []),
    '',
    '【工具纪律】',
    '- 修改文件前先 Read 读取确认现状，再决定 Write/Edit。',
    '- 编辑用 Edit，old_string 需精确且唯一；不唯一时补充上下文或使用 replace_all。',
    '- 查找文件路径用 Glob，搜索文件内容用 Grep（可配合 glob 过滤与 context 上下文行）。',
    '- Bash 输出可能被截断；超大输出按需用 Read offset/limit 补读，不要臆测内容。',
    '- 工具结果如实反映，失败时报告错误信息，不编造结果。',
    '',
    '【探索纪律】',
    '- 动手前先完整理解任务：一次读清任务要求/契约/验收标准，再规划探索路径，不做无目标试探。',
    '- 搜索精准：Grep 用精确 pattern（可带行号与 context），先用 Glob 定位候选文件再 Read；避免无目标的 ls 与重复试探性搜索。',
    '- 信息一次取足：同一文件一次 Read 读完（必要时用 offset/limit 定向补读），相关文件合并读取；已读内容不重复读。',
    '- 命令合并：多步验证/检查用单条 Bash（&& 串联）一次完成，减少往返；同类批量改动用一次 Edit/replace_all 覆盖。',
    '- 探索与动手分离：先集中收集信息形成方案，再批量执行改动；不在信息不足时反复试错。',
    '',
    '【回复规范】',
    '- 回答直接、简洁、专业，只给出与任务相关的信息。',
    '- 引用代码时标注 file_path:line 便于定位。',
    '- 需要用户决策时列出选项，不要擅自执行高风险操作。',
    `可用工具：${(toolNames || []).join(', ')}。`,
  ].join('\n')
}

// 三层组装：base + 可用子 Agent 区块 + AGENTS.md（带来源标注）+ append 文件
// （最后，最高优先级）。subagents 为内置 ∪ 用户级的子 Agent 表（Agent 工具路由依据）。
export function composeSystemPrompt({ toolNames, agents, subagents = [], append = '', cwd = '' }) {
  const parts = [buildBaseSystemPrompt({ toolNames, cwd })]
  if (subagents && subagents.length > 0) {
    const lines = ['【可用子 Agent】可将独立子任务委派给以下子 Agent（Agent 工具的 subagent_type）：']
    for (const a of subagents) {
      lines.push(`- ${a.id}：${a.description}${a.tools && a.tools.length ? `（tools: ${a.tools.join(', ')}）` : ''}`)
    }
    parts.push(lines.join('\n'))
  }
  for (const a of agents || []) {
    parts.push(`# 项目指令（${a.path}）\n\n${a.content.trim()}`)
  }
  if (append && append.trim()) parts.push(append.trim())
  return parts.join('\n\n')
}
