// Ponos-turbo 提示词组装（LLM 行为逻辑层）
// ---------------------------------------------------------------------------
// 三层叠加（顺序 = 优先级从低到高，后者覆盖前者）：
//   1. buildBaseSystemPrompt —— 内核基础行为规范（身份：Ponos + 工具纪律/
//      回复规范）。身份内置于基础层，使 TUI/CLI 直跑时模型即自称 Ponos。
//   2. discoverAgentsMd —— 项目指令 AGENTS.md（cwd 及祖先链至 git root，
//      加 --add-dir 根目录），成熟方案的标配。
//   3. append 文件（cli 注入的 GUI 提示词：身份/技能/格式规范）——最高优先级，
//      GUI 层仍可覆盖/强化身份声明。
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// 从 cwd 向上到 git root（含），以及 addDirs 根目录，发现 AGENTS.md。
// 返回 [{ path, content }]，近者优先、去重。
export function discoverAgentsMd({ cwd, addDirs = [] }) {
  const found = []
  const seen = new Set()
  const seenContent = new Set()
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
      // ★ 内容级去重（2026-09-20）：同一份规范出现在**多个候选路径**时只注入一次。
      //   实测场景：调试版（便携版）目录 `release/YFWorking` 就在**仓库内部**，从它上溯会同时命中
      //   「release/YFWorking/AGENTS.md」（同步副本）与「<仓库根>/AGENTS.md」（原版）——
      //   两者内容相同却因 **path 不同**各注入一次（实测返回 7732 字符 ≈ 两份之和）；
      //   若两份因同步时机不同而漂移（本次实测 83 行 vs 81 行），模型还会同时收到**互相矛盾**的两版规范。
      //   内容相同 ⇒ 保留更近的那份（近者优先语义不变）；内容不同 ⇒ 仍各自注入（多项目规则是设计意图）。
      const key = content.trim()
      if (key) {
        if (seenContent.has(key)) continue
        seenContent.add(key)
      }
      found.push({ path: p, content })
    }
  }
  return found
}

// 内核基础行为规范（LLM 行为逻辑）：Ponos 身份 + 工作规范。
// cwd 注入当前工作目录（对照同类的 "Primary working directory:" 注入），
// 让模型基于确定路径规划工具调用，减少试错式路径猜测。
// tier（2026-09-09 本地模型适配）：'full'（缺省，现状）| 'lean'（本地弱模型精简版）。
// lean 剪枝原则：只删有引擎守卫兜底的细则（计划尾/想完即停/报错重试均在
// engine.mjs 注入自愈），功能协议核心（工具纪律/回复规范）一字不动。
//
// 【2026-09-18 P0-3】原来末行还有 `可用工具：…`，现已**下沉**到 composeSystemPrompt 的
// 最后一个 parts（见该函数末尾）。理由：这行内容随 toolNames 变化（MCP 晚到、应用绑定、
// 工作流增删都会改它），原先位于 system 前 1/3，**一变就把 system 中后段（子 Agent / 项目
// 指令 / 技能 / 工作流 / 知识库 / 记忆）全部打穿**——是所有失效源里最贵的一个。下沉到最末
// 后，失效范围收缩到"这一行自身"，前面全部仍可复用（内容一字未删，提示强度不变；工具清单
// 与 tools 数组本就重复冗余）。
export function buildBaseSystemPrompt({ toolNames = [], cwd = '', tier = 'full' } = {}) {
  const lean = tier === 'lean'
  const toolDiscipline = [
    '- 修改文件前先 Read 读取确认现状，再决定 Write/Edit。',
    '- 编辑用 Edit，old_string 需精确且唯一；不唯一时补充上下文或使用 replace_all。',
    '- 查找文件路径用 Glob，搜索文件内容用 Grep（可配合 glob 过滤与 context 上下文行）。',
    '- 并行调用：需要读多个文件/多处搜索时，同一回复一次性并行发起多个独立的只读调用（如同时 Read a.mjs + Read b.mjs + Grep 一个符号），不要逐个串行发起；Bash/Edit/Write/Agent/Task 等写与执行类工具必须串行，等前一个结果返回后再发起下一个。',
    '- Bash 输出可能被截断；超大输出按需用 Read offset/limit 补读，不要臆测内容。',
    '- 工具结果如实反映，失败时报告错误信息，不编造结果。',
  ]
  const turnDiscipline = lean
    ? [
        '- 任务型轮次必须以实际工具调用收尾：凡提到"先读…/接下来…/然后…/准备…/开始…/需要先…"等计划性措辞，当轮立即落实为工具调用，禁止只做计划不执行就结束回合。',
        '- 工具调用报错后，必须立即重试或补发正确的调用，不允许认错即停；连续失败多次仍无法推进时，才在文本中说明阻塞原因。',
      ]
    : [
        '- 任务型轮次必须以实际工具调用收尾：凡提到"先读…/接下来…/然后…/准备…/开始…/需要先…"等计划性措辞，当轮立即落实为工具调用，禁止只做计划不执行就结束回合（禁止"计划尾巴"）。',
        '- 工具调用报错（参数错误/超时/被取消/未找到）后，必须立即重试或补发正确的调用，不允许认错即停；连续失败多次仍无法推进时，才在文本中说明阻塞原因。',
        '- 长任务每步落地：多步骤任务先用 TodoWrite 建立清单，每完成一步更新状态，禁止在脑中维护任务进度。',
        '- Windows 下命令输出可能为 GBK 乱码（tasklist/dir 等）：需要文本匹配时优先用 PowerShell 或先 chcp 65001；大目录遍历/全树搜索优先限定 git 跟踪文件（git ls-files），避免无目标全量扫描。',
      ]
  const exploreDiscipline = lean
    ? ['- 动手前先完整理解任务，不做无目标试探；Grep 精准搜索、Glob 定位候选、同一文件一次读足，已读内容不重复读。']
    : [
        '- 动手前先完整理解任务：一次读清任务要求/契约/验收标准，再规划探索路径，不做无目标试探。',
        '- 搜索精准：Grep 用精确 pattern（可带行号与 context），先用 Glob 定位候选文件再 Read；避免无目标的 ls 与重复试探性搜索。',
        '- 信息一次取足：同一文件一次 Read 读完（必要时用 offset/limit 定向补读），相关文件合并读取；已读内容不重复读。',
      ]
  const changeFocus = lean
    ? [
        '- 最小改动：只修改完成任务必需的文件，不顺手重构、不修无关代码。',
        '- 收敛范围：能改一处不碰第二处，能精准 Edit 不整文件 Write。',
        '- 禁止用 Bash 读/搜文件内容：读文件用 Read、搜内容用 Grep、找路径用 Glob。Bash 仅用于系统命令/测试/构建/git。',
      ]
    : [
        '- 最小改动：只修改完成任务必需的文件（任务描述明确文件范围时优先遵循），不顺手重构、不修无关代码；必要时补的测试文件是合理改动，与修复同目标。',
        '- 收敛范围：能改一处不碰第二处，能精准 Edit 不整文件 Write，避免把无关文件卷入 diff。',
        '- 复杂任务先规划：多步骤/多文件/含验证环节的任务，先用 TodoWrite 建立任务清单再动手，随进度更新状态。',
        '- 探索只用专用工具：禁止用 Bash 读/搜文件内容——cat/sed/od/head/tail/less 与 python（open/read/heredoc）等任何变体都不行；读文件用 Read、搜内容用 Grep、找路径用 Glob。Bash 仅用于系统命令/测试/构建/git。',
        '- 命令合并：多步验证/检查用单条 Bash（&& 串联）一次完成，减少往返；同类批量改动用一次 Edit/replace_all 覆盖。',
        '- 探索与动手分离：先集中收集信息形成方案，再批量执行改动；不在信息不足时反复试错。',
      ]
  return [
    '你是 Ponos 的 AI 助手，运行在 Ponos-turbo 内核上，通过工具完成任务。请遵循以下工作规范：',
    ...(cwd ? [`当前工作目录：${cwd}（工具的相对路径均相对于此目录解析）`] : []),
    '',
    '【工具纪律】',
    ...toolDiscipline,
    '',
    '【任务轮次纪律】',
    ...turnDiscipline,
    '',
    '【探索纪律】',
    ...exploreDiscipline,
    '【改动聚焦】',
    ...changeFocus,
    '',
    // 循环防护（2026-09-10 借鉴业界提示词实践）：实测同款弱模型循环率显著更低，
    // 其提示词含显式反循环纪律（prompts.ts：拒绝后不重试同一调用 / 失败先诊断再换策略）。
    // 与 engine 守卫⑥（无进展自愈注入）分层：提示词层预防，守卫层兜底。
    '【循环防护】',
    '- 方法失败时先诊断原因再换策略：读错误信息、核对假设、做聚焦修复——禁止盲目原样重试同一动作，也不要一次失败就放弃可行方案。',
    '- 测量/观察只是手段不是任务：对同一目标连续只读测量（浏览器测量、快照等）两三次仍无结论时，停止测量，直接执行实质步骤（修改文件/执行命令），或向用户明确汇报卡点与结论。',
    '',
    '【回复规范】',
    '- 回答直接、简洁、专业，只给出与任务相关的信息。',
    '- 引用代码时标注 file_path:line 便于定位。',
    '- 需要用户决策时列出选项，不要擅自执行高风险操作。',
    '- 对话历史超长时系统会自动压缩上下文，勿因此焦虑或反复重读旧内容。',
  ].join('\n')
}

// chat 模式专用系统提示（2026-09-12 隔离）：chat = 联网检索/资料整理助手，
// **只**有 WebSearch/WebFetch 两件工具。任务模式的基础层（Ponos 身份 + 工具纪律/
// 任务轮次纪律/探索纪律/改动聚焦/循环防护）在 chat 是纯噪声甚至误导——它教模型
// "改文件前先 Read""报错必须重试"等本地动作，而 chat 侧这些工具全部被禁，模型
// 只会反复承诺做不到的事（实证：chat 会话里模型回"Skill 工具在此不可用"、
// 掏 run_spec_dev 这类根本不该出现的东西）。故此处给一套自洽的身份 + 能力边界 +
// 检索纪律，与 CHAT_MODE_DISALLOWED（kernel/tools.mjs）同口径。
export function buildChatSystemPrompt({ toolNames = [] } = {}) {
  return [
    '你是 YFWorking（远方工作台）的联网助理，当前处于**聊天模式**：只做网页检索与资料整理——搜索网页、抓取正文，然后基于检索结果回答。除此之外没有本地能力。',
    '',
    '【能力边界（必须如实告知，禁止假装）】',
    `- 可用工具只有：${(toolNames || []).join(', ') || '（无）'}。没有文件读写、没有命令执行、没有子 Agent / 技能 / 工作流。`,
    '- 看不到用户本机的文件、目录、进程、日志、数据库，也不能运行代码、修改代码、安装环境、连接内网系统。',
    '- 用户要求本地操作时（读文件/改代码/跑命令/看日志/装依赖）：直接说明聊天模式不含本地能力，建议切到任务模式再发；禁止"我先看看你的项目"这类承诺，也禁止编造本地内容。',
    '- 工具被拒绝、抓取失败或检索为空时：如实说明发生了什么，不用推测填空。',
    '',
    '【检索纪律】',
    '- 涉及事实、数据、时效的内容（新闻、价格、版本、政策、人物近况、接口用法等）：先 WebSearch 定位来源，再对关键来源 WebFetch 精读；不要直接用可能过期的记忆作答。',
    '- 优先权威来源（官方文档、机构原文、一手报道）；结论尽量有至少两个独立来源相互印证；来源互相矛盾时并列分歧，不要取"平均值"。',
    '- 同一 URL 只抓一次；抓取失败就换来源或改用搜索结果摘要，不反复重试同一地址。',
    '- 检索不到就明说"未检索到可靠来源"，不要把推测写成事实。',
    '',
    '【回答规范】',
    '- 简体中文；结论先行，再给支撑要点；较长内容用小标题、列表或表格组织。',
    '- 引用外部信息时给出可点击的来源链接，并在末尾列「来源」清单。',
    '- 区分三类信息：检索所得（标注来源）／模型自身知识（注明"以下为一般性知识，非本次检索结果"）／推断。不确定就说不确定。',
    '- 回答直接、专业、简洁，不堆寒暄和免责声明。',
  ].join('\n')
}

/**
 * 【本会话知识库】区块（2026-09-15，P1 spec §3.5）。
 *
 * **why 要有这一段**：工具层的范围收窄（`kernel/tools.mjs` 的 knowledgeSpaces）是"防越界"，
 * 但只做防守会让模型陷入猜谜——它不知道本会话能查哪些库、更不知道"查不到"是因为越界还是因为
 * 真没有。把范围**写进提示词**，"可调用性"才从"配了就算"变成"模型知道自己有什么"。
 *
 * 两条边界纪律：
 *   ① 只列**未关联库的名字**（不列 id、不列根路径）：模型要做的是"请用户去点关联"，
 *      不是拼 id；把 id 摆出来反而诱导它硬写 spaces 参数去试探。
 *   ② 未关联库最多列 12 个（`等 N 个` 收尾）：储备库可能有几十个，全列会把这个区块本身
 *      变成上下文膨胀源——与它要解决的膨胀问题自相矛盾。
 */
/**
 * 本次工具集里是否真的给了"按路径读文件"的能力（Read + Grep 缺一不可）。
 *
 * why 不看 mode：chat/task 只是**默认**工具集不同，真正决定"能不能 Read 知识库文件"
 * 的是那份 toolNames（tier、子 agent、禁用工具都会改它）。提示词若与实际能力不一致，
 * 比不提示更糟 —— 模型会照提示去 Grep 然后撞拒绝，白烧一轮并污染上下文。
 */
function canReadFiles(toolNames) {
  const set = new Set(Array.isArray(toolNames) ? toolNames : [])
  return set.has('Read') && set.has('Grep')
}

export function renderKnowledgeScope(scope, { readEnabled = false } = {}) {
  const names = Array.isArray(scope?.names) ? scope.names.filter(Boolean) : []
  if (!names.length) return ''
  const lines = [`【本会话知识库】可检索：${names.join('、')}（KnowledgeSearch 的 spaces 只能取这里列出的库）。`]
  // 能力可见性（2026-09-18，P3）：已授权空间的文件**同时**进了只读白名单（Read/Grep 可用）。
  // why 要写出来：工具层打通了边界、但模型不知道，等于白打通 —— 它会退回"一次次 KnowledgeSearch"
  // 而不会去做"跨文档 grep 核验"（外部消融显示后者恰是收益最大的一环）。
  // **必须由调用方按"本次真的给了 Read/Grep"来开关**：不一致的提示比不提示更糟
  // （模型会照提示去 Grep，然后撞拒绝，白烧一轮）—— 只陈述能力，不列路径（路径在工具回执里给）。
  if (readEnabled) {
    lines.push('这些库的文件可直接用 Read/Grep 打开（只读）：已知编号/原文片段要跨文档比对时，直接 Grep 比反复检索更省事。')
  }
  const un = Array.isArray(scope?.unassociated) ? scope.unassociated.filter(Boolean) : []
  if (un.length) {
    lines.push(`未关联的库（${un.slice(0, 12).join('、')}${un.length > 12 ? ` 等共 ${un.length} 个` : ''}）不在本会话范围内：用户要用时请其先在知识面板把该库「关联到当前会话」，不要反复重试同一检索。`)
  }
  return lines.join('\n')
}

// 三层组装：base + 可用子 Agent 区块 + AGENTS.md（带来源标注）+ append 文件
// （最后，最高优先级）。subagents 为内置 ∪ 用户级的子 Agent 表（Agent 工具路由依据）。
// mode='chat'（2026-09-12 会话模式隔离）：只走 chat 专用提示 + append，任务模式的
// 一切区块（子 Agent / 项目指令 / 技能 / 工作流 / 记忆）**一律不注入**——即便调用方
// 传了也忽略（提示词层与工具层各自独立收口，任一层失效都不至于把任务能力泄进 chat）。
export function composeSystemPrompt({ toolNames, agents, subagents = [], append = '', cwd = '', skills = [], workflows = [], memory = '', tier = 'full', mode = 'task', knowledgeScope = null }) {
  if (mode === 'chat') {
    const chatParts = [buildChatSystemPrompt({ toolNames })]
    // 会话知识范围（2026-09-15，P1 spec §3.5）：chat 也渲染——chat 里 KnowledgeSearch 是放行的
    // （S3 D2 的决定：只读检索不吃"纯聊不做本地执行"的隔离承诺），那么"能用哪些库"就必须同样
    // 对模型可见，否则它只能靠猜（猜错 = 拒绝，用户看到的是"聊天不会用我的知识库"）。
    // chat 下 Read/Grep 本来就不给（隔离承诺）→ readEnabled 由**实际工具集**判定，
    // 不用 mode 猜：只有真给了 Read 与 Grep 才敢说"可直接打开"，否则模型会白撞一次拒绝。
    const kb = renderKnowledgeScope(knowledgeScope, { readEnabled: canReadFiles(toolNames) })
    if (kb) chatParts.push(kb)
    if (append && append.trim()) chatParts.push(append.trim())
    return chatParts.join('\n\n')
  }
  const parts = [buildBaseSystemPrompt({ toolNames, cwd, tier })]
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
  // 【技能与编排】主动性区块（2026-09-12「优化了却看不到效果」的触发侧修复）：
  // 实证病灶 = 判据只存在于 SKILL.md 正文（**调用之后**才加载），提示词里能看到的仅
  // 截断描述 ⇒ 模型自发触发率≈0（125 份 transcript：98.7% 的复杂会话直接 Read/Bash
  // 开场，Skill 自发调用 0 次，唯一跑通的一次是用户手打"执行技能 using-superpowers"）。
  // 故把"何时该用"的判据放到**无需调用即可见**的位置。条件注入：chat 模式 skills/
  // subagents 为空 ⇒ 本块不出现（隔离，见 cli.mjs 的 --session-mode chat）。
  if ((skills && skills.length > 0) || (subagents && subagents.length > 0)) {
    const lines = ['【技能与编排】']
    if (skills && skills.length > 0) {
      lines.push('- 任务与下方【可用技能】清单匹配时，先用 Skill 工具加载该技能、按其步骤执行，不得凭印象替代或自行发挥；判定从宽——只要有适用可能（哪怕 1%）就先加载再决定，加载成本远低于重做成本。')
    }
    if (subagents && subagents.length > 0) {
      lines.push('- 存在独立可并行的子任务（多处探索/多文件实现/独立复核）时，用 Agent 工具委派子 Agent 推进，不要把本该并行的活全部串行手工做。')
    }
    parts.push(lines.join('\n'))
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
  const kbBlock = renderKnowledgeScope(knowledgeScope, { readEnabled: canReadFiles(toolNames) })
  if (kbBlock) parts.push(kbBlock)
  if (memory && memory.trim()) parts.push(memory.trim())
  if (append && append.trim()) parts.push(append.trim())
  // 【2026-09-18 P0-3】工具清单**必须放在 system 最末**：它是整个 system 里唯一随工具集变化的
  // 内容（MCP 晚到 / 应用绑定 / 工作流增删即变）。放在前部会把其后所有段落一起打穿（前缀缓存
  // 逐字节匹配，断裂点之后全部重算 + 重写）；放末尾则失效范围只剩这一行。原先它在
  // buildBaseSystemPrompt 的末行（system 前 1/3 处），故下沉到此处——内容一字未删。
  if (toolNames && toolNames.length) parts.push(`可用工具：${toolNames.join(', ')}。`)
  return parts.join('\n\n')
}

// 子 lane 系统提示词补齐技能目录（2026-09-12 AS2）。
// 病灶：lane 的 system prompt 此前只有 agent 正文（engine 的 spawnSubAgent），**没有技能
// 清单**；而 Skill 工具的 schema 却写着"技能名（与提示词【可用技能】清单中的 id 一致）"
// ⇒ 子 Agent 无从得知合法 id，只能猜，猜错还会被 allowedSkills 白名单拒绝（engine 的
// lane 工具边界）——"清单存在但子代理不可用"的断裂点。
// 口径：agent 自带 skills 白名单时只列白名单（与拒绝闸同源，避免列出必被拒的 id）；
// 否则列主会话技能全表 id。两者皆空 → 原样返回（不引入空标题行）。
export function withLaneSkillCatalog(sysPrompt, { agentSkills = [], skillIds = [] } = {}) {
  const declared = Array.isArray(agentSkills) ? agentSkills.filter(Boolean) : []
  const ids = declared.length ? declared : (Array.isArray(skillIds) ? skillIds.filter(Boolean) : [])
  if (!ids.length) return sysPrompt
  return `${sysPrompt}\n可用技能（Skill 工具，skill 参数填 id）：${ids.join('、')}`
}
