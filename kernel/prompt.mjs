// Ponos-turbo 提示词组装（LLM 行为逻辑层）
// ---------------------------------------------------------------------------
// 三层叠加（顺序 = 优先级从低到高，后者覆盖前者）：
//   1. buildBaseSystemPrompt —— 内核基础行为规范（身份：Ponos + 工具纪律/
//      回复规范）。身份内置于基础层，使 TUI/CLI 直跑时模型即自称 Ponos。
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

// 内核基础行为规范（LLM 行为逻辑）：Ponos 身份 + 工作规范。
// cwd 注入当前工作目录（对照 claude 的 "Primary working directory:" 注入），
// 让模型基于确定路径规划工具调用，减少试错式路径猜测。
export function buildBaseSystemPrompt({ toolNames = [], cwd = '' } = {}) {
  return [
    '你是 Ponos 的 AI 助手，运行在 Ponos-turbo 内核上，通过工具完成任务。请遵循以下工作规范：',
    ...(cwd ? [`当前工作目录：${cwd}（工具的相对路径均相对于此目录解析）`] : []),
    '',
    '【工具纪律】',
    '- 修改文件前先 Read 读取确认现状，再决定 Write/Edit。',
    '- 编辑用 Edit，old_string 需精确且唯一；不唯一时补充上下文或使用 replace_all。',
    '- 查找文件路径用 Glob，搜索文件内容用 Grep（可配合 glob 过滤与 context 上下文行）。',
    '- 并行调用：需要读多个文件/多处搜索时，同一回复一次性并行发起多个独立的只读调用（如同时 Read a.mjs + Read b.mjs + Grep 一个符号），不要逐个串行发起；Bash/Edit/Write/Agent/Task 等写与执行类工具必须串行，等前一个结果返回后再发起下一个。',
    '- Bash 输出可能被截断；超大输出按需用 Read offset/limit 补读，不要臆测内容。',
    '- 工具结果如实反映，失败时报告错误信息，不编造结果。',
    '',
    '【任务轮次纪律】',
    '- 任务型轮次必须以实际工具调用收尾：凡提到"先读…/接下来…/然后…/准备…/开始…/需要先…"等计划性措辞，当轮立即落实为工具调用，禁止只做计划不执行就结束回合（禁止"计划尾巴"）。',
    '- 工具调用报错（参数错误/超时/被取消/未找到）后，必须立即重试或补发正确的调用，不允许认错即停；连续失败多次仍无法推进时，才在文本中说明阻塞原因。',
    '- 长任务每步落地：多步骤任务先用 TodoWrite 建立清单，每完成一步更新状态，禁止在脑中维护任务进度。',
    '- Windows 下命令输出可能为 GBK 乱码（tasklist/dir 等）：需要文本匹配时优先用 PowerShell 或先 chcp 65001；大目录遍历/全树搜索优先限定 git 跟踪文件（git ls-files），避免无目标全量扫描。',
    '',
    '【探索纪律】',
    '- 动手前先完整理解任务：一次读清任务要求/契约/验收标准，再规划探索路径，不做无目标试探。',
    '- 搜索精准：Grep 用精确 pattern（可带行号与 context），先用 Glob 定位候选文件再 Read；避免无目标的 ls 与重复试探性搜索。',
    '- 信息一次取足：同一文件一次 Read 读完（必要时用 offset/limit 定向补读），相关文件合并读取；已读内容不重复读。',
    '【改动聚焦】',
    '- 最小改动：只修改完成任务必需的文件（任务描述明确文件范围时优先遵循），不顺手重构、不修无关代码；必要时补的测试文件是合理改动，与修复同目标。',
    '- 收敛范围：能改一处不碰第二处，能精准 Edit 不整文件 Write，避免把无关文件卷入 diff。',
    '- 复杂任务先规划：多步骤/多文件/含验证环节的任务，先用 TodoWrite 建立任务清单再动手，随进度更新状态。',
    '- 探索只用专用工具：禁止用 Bash 读/搜文件内容——cat/sed/od/head/tail/less 与 python（open/read/heredoc）等任何变体都不行；读文件用 Read、搜内容用 Grep、找路径用 Glob。Bash 仅用于系统命令/测试/构建/git。',
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
export function composeSystemPrompt({ toolNames, agents, subagents = [], append = '', cwd = '', skills = [], workflows = [], memory = '' }) {
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
  if (skills && skills.length > 0) {
    // P8 业务适配：技能块带触发词 + 父子结构（父技能条目内联子技能，子技能不单独成条），
    // 与宿主原清单语义对齐；触发词为空时回退描述（截 120）
    const lines = ['【可用技能】任务与以下技能匹配时，用 Skill 工具调用对应技能（skill 参数填技能名），不得自行模拟或改用其它方式；无匹配则按普通对话处理：']
    const subsOf = new Map()
    for (const s of skills) if (s.parent) subsOf.set(s.parent, [...(subsOf.get(s.parent) || []), s.id])
    for (const s of skills) {
      if (s.parent) continue
      const trig = Array.isArray(s.triggers) && s.triggers.length ? s.triggers.join('、').slice(0, 80) : ''
      const head = trig || (s.description || '').slice(0, 120)
      const subs = subsOf.get(s.id)
      lines.push(`- ${s.id}：${head}${subs && subs.length ? `（子：${subs.join('、')}）` : ''}`)
    }
    parts.push(lines.join('\n'))
  }
  if (workflows && workflows.length > 0) {
    // 工作流独立区块：定位=严格输出（确定性 DAG + 审计留痕）。与技能区分——
    // 技能=灵活处理（模型自由执行），工作流=固定流程（引擎严格执行）。
    const lines = ['【可用工作流】需要严格流程/确定性输出/审计留痕时，用 Workflow 工具调用对应工作流（workflow 参数填 id）；灵活探索/自由编排任务用 Skill 工具，不要误用工作流：']
    const subsOf = new Map()
    for (const w of workflows) if (w.parent) subsOf.set(w.parent, [...(subsOf.get(w.parent) || []), w.id])
    for (const w of workflows) {
      if (w.parent) continue
      const trig = Array.isArray(w.triggers) && w.triggers.length ? w.triggers.join('、').slice(0, 80) : ''
      const head = trig || (w.description || '').slice(0, 120)
      const subs = subsOf.get(w.id)
      lines.push(`- ${w.id}：[工作流] ${head}${subs && subs.length ? `（子：${subs.join('、')}）` : ''}`)
    }
    parts.push(lines.join('\n'))
  }
  if (memory && memory.trim()) parts.push(memory.trim())
  if (append && append.trim()) parts.push(append.trim())
  return parts.join('\n\n')
}
