// kernel/authoring-intent.mjs —— 「AI 一键新建」的意图拼装（纯函数，零 IO）
// ---------------------------------------------------------------------------
// 定位：技能工坊的「AI 生成正文」与工作流的「AI 生成工作流」共用的一份意图模板。
// 与 `kernel/draft-intent.mjs` 是**两件事**，刻意不合并：
//   · draft-intent 的输入是**演进候选**（ruleId/subject/证据），产出"要不要做、做成什么"；
//   · 本模块的输入是**用户的一句话需求**，产出"按这句话写出一份可校验的正文"。
//     两者共用一个模板只会让两边都写不清（候选场景没有 brief，authoring 场景没有证据）。
//
// ## 三条纪律
// 1. **纯函数**：同输入 ⇒ 逐字同输出（可单测、可复现）；不读盘、不取时钟。
// 2. **落点唯一**：产物必须写到会话唯一可写目录里的**固定文件名**
//    （`<draftsDir>/SKILL.md` 或 `<draftsDir>/workflow.yml`）。服务端只读这一个文件，
//    不扫目录猜"哪个是正文"——猜的代价是把脚本/临时文件当成产物返回给用户。
// 3. **不臆造事实**：模板明确要求"需求里没说的不要编数字/客户名/法规条款"，
//    并允许在内容不足时先写 TODO。宁可留空，也不要生成看着专业的假内容（本仓一贯口径）。
//
// ## 与前端契约
// `AUTHORING_KINDS` / `AUTHORING_OUTPUT_FILE` 是前后端**同时消费**的枚举：前端用它决定按钮文案与
// 提交的 kind，服务端用它决定写哪个文件名、读回哪个文件、以及回执里的 kind 是否合法。
// 新增一种产物（如 app spec）时**只改本文件**，前端映射表由测试盯着（同 OPP code 的机械守卫手法）。

/** 支持的产物流行（顺序即前端展示顺序）。 */
export const AUTHORING_KINDS = Object.freeze(['skill', 'workflow'])

/** kind → 会话里必须写出的文件名（**唯一真源**；服务端读回只认它）。 */
export const AUTHORING_OUTPUT_FILE = Object.freeze({
  skill: 'SKILL.md',
  workflow: 'workflow.yml',
})

/**
 * kind → 本会话可用的工具白名单。
 * ★ 刻意**不含** Skill/SkillDraft/Agent/Workflow/Bash/WebFetch：生成正文只需要"读需求 + 写一个文件"。
 *   不给派发面 ⇒ 它不可能在本会话里递归起子 agent；不给执行面 ⇒ 不可能顺手跑命令。
 *   （与 `draft-intent.mjs#DRAFT_TOOL_ALLOWLIST` 不同，那个要 SkillDraft 因为落点是技能草稿区；
 *   这里落点是暂存区文件，正文由服务端读回、再由用户确认后走既有安装通道。）
 */
export const AUTHORING_TOOL_ALLOWLIST = Object.freeze(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'])

/** kind 合法性（未知/脏值 ⇒ null，调用方据此 400，不猜）。 */
export function authoringOutputFile(kind) {
  const k = String(kind || '').trim()
  return Object.prototype.hasOwnProperty.call(AUTHORING_OUTPUT_FILE, k) ? AUTHORING_OUTPUT_FILE[k] : null
}

/** 需求描述的下限：太短的输入（"做个技能"）不值得花一次模型调用，也生成不出可用内容。 */
export const AUTHORING_BRIEF_MIN = 6
export const AUTHORING_BRIEF_MAX = 4000

/**
 * 技能正文的骨架要求（写给模型看的硬约束，与 `kernel/skill-forge.mjs#validateDraft` 的硬门对齐）。
 * ★ 这里的数字必须与硬门一致，否则模型生成的东西会被硬门拒（用户看到"AI 生成了但存不进去"）。
 *   一致性由 `server/authoring-engine.test.mjs` 逐字比对（不靠自觉）。
 */
export const SKILL_FRONTMATTER_RULES = Object.freeze({
  descMax: 300,       // kernel/skill-forge.mjs#DESC_MAX
  triggersMax: 20,    // TRIGGERS_MAX
  triggerLenMax: 40,  // TRIGGER_LEN_MAX
})

/** 工作流 yml 的最小形状（与 workflows DSL 的既有骨架一致：开始→结束，orchestrate 段可选）。 */
const WORKFLOW_SKELETON = [
  'name: <显示名>',
  'nodes:',
  '  - id: start',
  '    type: start',
  '  - id: end',
  '    type: end',
  'edges:',
  '  - { from: start, to: end }',
].join('\n')

/**
 * 组装意图消息（确定性）。
 *
 * @param {object} p
 * @param {'skill'|'workflow'} p.kind 产物类型
 * @param {string} p.brief 用户的需求描述（一句话或一段）
 * @param {string} [p.draftsDir] 本次会话的唯一可写目录（意图里要给绝对路径，模型才能写对）
 * @param {string[]} [p.existingIds] 已存在的 id/名称（避免撞名；给不出来就如实说"未提供"）
 * @returns {string} 意图消息（可直接作为 user 消息注入内核）
 */
export function buildAuthoringIntent({ kind, brief, draftsDir, existingIds } = /** @type {any} */ ({})) {
  const k = String(kind || '').trim()
  const file = authoringOutputFile(k)
  const dir = String(draftsDir || '').replace(/\\/g, '/')
  const text = String(brief || '').trim()
  const existing = Array.isArray(existingIds) ? existingIds.filter((s) => typeof s === 'string' && s) : []

  const lines = [
    `【AI 新建${k === 'workflow' ? '工作流' : '技能'}】`,
    `需求（用户原话，只按它做，不要扩大范围）：${text || '（未提供）'}`,
    '',
    '产出要求：',
    file ? `  · 把最终产物写到 ${dir ? `${dir}/${file}` : file}（就这一个文件；不要写别的文件）` : '  · （未知产物类型，只做分析，不要写文件）',
    '  · 只写最终成品，不要写说明性报告；完成后用一句话说明你写了什么',
  ]

  if (k === 'skill') {
    lines.push(
      '',
      '技能正文的硬性格式（不满足会被校验拒绝）：',
      '  · 必须以 `---` 开头的 frontmatter，且含 `name`（小写字母/数字/连字符，2-64 字）与 `description`',
      `  · description ≤ ${SKILL_FRONTMATTER_RULES.descMax} 字（超出部分模型看不到）`,
      `  · triggers 最多 ${SKILL_FRONTMATTER_RULES.triggersMax} 条，每条 ≤ ${SKILL_FRONTMATTER_RULES.triggerLenMax} 字`,
      '  · 正文分节建议：角色定位 / 操作步骤 / 坑与预防（有则写，无则不硬凑）',
      '  · 正文里可以放脚本路径与命令示例，但不要真的执行任何命令',
    )
  } else if (k === 'workflow') {
    lines.push(
      '',
      '工作流 yml 的硬性格式：',
      '  · 顶层 `name:` + `nodes:` + `edges:`',
      '  · 必须有一个 `type: start` 与一个 `type: end` 节点，且从 start 到 end 全连通',
      '  · 最小骨架如下，按需求在其上加节点（不要发明 DSL 里没有的字段）：',
      ...WORKFLOW_SKELETON.split('\n').map((l) => `      ${l}`),
    )
  }

  lines.push(
    '',
    '现状：',
    existing.length
      ? `  · 已存在（不要重名）：${existing.slice(0, 40).join('、')}`
      : '  · 未提供已存在清单 —— 若你的产物需要 id/名称，请取一个语义清晰且可读的名字',
    '',
    '硬约束：',
    '  · 不得修改本目录之外的任何文件；不得执行命令、不得联网、不得派子 agent',
    '  · 需求里没说的数字、客户名、法规条款、金额一律不要编；确实需要时写 `TODO:` 占位',
    '  · 不要在正文里输出"以下是我生成的…"这类对话腔；产物就是要被人直接使用的正文',
  )

  return lines.join('\n')
}
