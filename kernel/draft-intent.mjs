// kernel/draft-intent.mjs —— 起草意图拼装（纯函数；B1）
//
// 定位：把**候选证据**变成一条可交给受控会话的意图消息，并定义起草会话的工具白名单。
// 纪律：
//  · 纯函数、零 IO、无时钟、无随机（同输入逐字同输出 ⇒ 可单测、可复现）；
//  · **只出"要做什么"，不出"怎么做"**（正文由会话里的 agent 写，本模块不写内容）；
//  · **隐私口径**：消息里只有统计与引用（ruleId/subject/count/会话 id），**不含对话正文**。
//
// ★ 为什么起草白名单与 bench 的不同（勿"统一"）：
//   bench 要**排除** SkillDraft（它是被测对象）；起草**必须包含** SkillDraft（它是技能通道的产出工具）。
//   两处语义不同 ⇒ 各自独立，**不从 bench 派生**（派生必然漂移）。
//
// ★ 本模块**不 import 任何东西**（刻意的）：route 合法性判定用本地 `routeOfDraft` 的白名单穷举，
//   不从 `opportunity-mine.mjs#ADVICE_ROUTES` 引入——本模块只关心"能不能起草"，
//   与"前端能渲染哪些方向"是两件事；耦合只会让内核纯模块之间多一条无谓边。

// 事实行的唯一实现在 `kernel/candidate-facts.mjs`（评审侧共用同一份）。
// 为什么本模块不再是"零 import"：那条纪律的目的是**不要耦合前端渲染枚举**（ADVICE_ROUTES），
// 而不是拒绝一切依赖；事实行必须与评审侧同源（两边各算一遍 = 漂移，实测已踩）。
import { renderFacts } from './candidate-facts.mjs'

/** 起草会话的工具白名单：只读/写草案所需，**不含**任何执行、网络、递归派发面。 */
export const DRAFT_TOOL_ALLOWLIST = Object.freeze([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'SkillDraft', 'TodoWrite',
])

/** route → 通道（非 draft:* ⇒ null；调用方按 null 不动作——不猜）。 */
export function routeOfDraft(route) {
  if (route === 'draft:skill') return 'skill'
  if (route === 'draft:workflow') return 'workflow'
  if (route === 'draft:app') return 'app'
  return null
}

/**
 * 候选的**默认起草通道** = 首条 `draft:*` action 的通道（无 ⇒ null）。
 *
 * ★★ 为什么不是 `actions[0].route`（2026-10-14，随"成本升序"一起改的**必要联动**）：
 *   `actions[0]` 此前同时承担两个语义 —— "生成方案按钮走哪条通道" 与 "端点做不做事"。
 *   而用户担忧（"判定几乎都是新建 skill"）要求 actions 按**成本升序**排（`check-usage` 在最前，
 *   它 route 是 `advice` 不是 draft）⇒ 若仍取 `[0]`，按钮会**整排消失**、端点回 `no-draft-route`。
 *   ⇒ 判据改为"**有没有可起草的方向**"（找首条 draft:*），而不是"第一条是不是 draft"。
 *   这同时修好了旧实现的一个真实不一致：OPP-1 的 actions 是 `[advice, draft:skill, settings]`，
 *   旧判据（`[0]`=advice）让按钮不出现、端点也不做事 —— 但她**其实有**可起草方向。
 *
 * ★ 唯一实现：前端（按钮/端点判据）与后端（组装意图）都调它，避免两套判据漂移
 *   （本仓踩过：一边说能、一边说不能 = 假按钮）。
 *
 * @param {{advice?: {actions?: {route?: string}[]}}|null|undefined} candidate
 * @returns {'skill'|'workflow'|'app'|null}
 */
export function draftChannelOf(candidate) {
  const acts = Array.isArray(candidate?.advice?.actions) ? candidate.advice.actions : []
  for (const a of acts) {
    const ch = routeOfDraft(a && typeof a.route === 'string' ? a.route : '')
    if (ch) return ch
  }
  return null
}

/** 通道 → 产物落点说明（意图消息里的硬约束；纯字符串，不含路径拼接逻辑）。
 *  ★ **auto 模式专用**（无人看管的自动起草）——"自动化止于暂存区"，故这里写明不许写生产目录。
 *  手动模式用下面的 `MANUAL_TARGET_HINT`（用户就在会话里 ⇒ 允许建生产工件）。 */
const TARGET_HINT = Object.freeze({
  skill: '用 SkillDraft 写入技能草稿区（不要直接改 skills/ 下的既有技能）',
  workflow: '把工作流 yml 写到 {{draftsDir}} 下（不要写 workflows/ 生产目录）',
  app: '把应用智控 spec 写到 {{draftsDir}} 下（不要写生产 spec）',
})

/** 方向名（列表前缀）与落点说明：**manual 模式专用** —— 用户就在自己的会话里看着 agent。 */
const DIRECTION_LABEL = Object.freeze({ skill: '技能', workflow: '流程', app: '应用' })

/** 通道 → 方向说明（manual）：**允许直接建生产工件**，落点是生产路径；草稿区只作显式可选项。
 *  ★ 与 TARGET_HINT 的差别只有一处（也正是本任务修的那处）：此处**没有**"不要写生产目录"这类禁令。
 *  ★ 为什么草稿区仍提一句：用户可能想先只审草案；它是**次选**（生产落点写在前面），不是劝阻。
 *    （端点仍传 draftsDir —— 不把它变成死参数。） */
const MANUAL_TARGET_HINT = Object.freeze({
  skill: '用 SkillDraft 写入技能草稿区',
  workflow: '把工作流写进 {workflowsDir}/<id>/workflow.yml（我会在工作流面板里跑一次验收）',
  app: '把应用智控 spec 写进 {appsDir}/<appId>/spec.json（我会在应用控制台里试跑）',
})

/**
 * 可选的"先只出草案"补充说明。
 *
 * ★ 2026-10-14 修（实测：消息里出现字面量 `(未指定)`）：此前把草稿目录写进模板并用
 *   `draftsDir || '(未指定)'` 兜底 —— 而前端从不传 draftsDir ⇒ **每次**都泄漏成 `(未指定)`，
 *   模型看到的是一个无意义的占位符。占位符泄漏比"不提这件事"更糟（模型会照抄它）。
 *   ⇒ 有真实路径才提这一句；没有就**整句省略**（不占位、不臆造）。
 */
const draftFallbackClause = (draftsDir) => (draftsDir ? `；只想先出草案的话，写到 ${draftsDir} 暂存也行` : '')

/** 无可起草对象时的目标行（两种模式共用同一个字符串：不许因 manual 就自由发挥）。 */
const NO_DRAFT_TARGET = '（该候选没有可起草的对象——请只做分析，不要建件）'

/** 相对路径归一：Windows 反斜杠不可控 ⇒ 统一正斜杠（消息是要给人/模型读的文本）。 */
const normPath = (p) => String(p || '').replace(/\\/g, '/')

/**
 * 组装起草意图消息（确定性：同输入 ⇒ 逐字同输出）。
 *
 * ★ 隐私口径：只有统计与引用（ruleId / subject / count / 会话 id），**不含对话正文**。
 *   证据以 `sessionId#seq` 引用形式出现（用户可回跳原会话核对）。
 *
 * ★ **按模式分派约束**（Task 17，2026-10-14）——两种模式的差别只在"能不能建生产工件"与
 *   "列几个方向"，**两条安全底线两种模式都在**：
 *   · `mode:'auto'`（无人看管的自动起草）：只准暂存区（**现状逐字不改**：目标行只讲首条通道，
 *     落点是 `<draftsDir>`，且含"不要写 workflows/ 生产目录"的禁令）；
 *   · `mode:'manual'`（手动起草，用户就在会话里看着 agent、可随时打断）：**允许直接建生产工件**，
 *     目标行**列出全部真实 draft 方向**（不只首条 —— 否则 agent 与用户都不知道"还可以做成流程"），
 *     并在末尾给一句可执行的收尾指引（工作流写 id ⇒ 用户去面板跑一次 = 试用）。
 *   ★ 这不放宽安全边界：手动路径跑在用户**自己的会话**里（他本来就能让 agent 写任何文件），
 *   本模块只是**不再用提示词人为禁止**这件事；auto 侧的禁令一字不动。
 *
 * @param {object} candidate 候选行（至少含 id/ruleId/subject/count/evidence/advice）
 * @param {{mode?: 'auto'|'manual', existingArtifacts?: {id: string, kind: string}[], draftsDir?: string,
 *          skillsDir?: string, workflowsDir?: string, appsDir?: string}} [opts]
 *        `mode` 缺省 `'auto'`（向后兼容：旧调用方不传 ⇒ 行为逐字不变）；非 `'manual'` 的值一律按 auto
 *        （判据只放行一个白名单值，未知值落到更严的那一侧）。
 *        ★ 那几个 `*Dir` 是**给模型看的具体路径**（2026-10-14 加）：缺值时相应片段**整段省略/如实标注**，
 *          绝不泄漏 `{xxx}` 或 `(未指定)` 这类占位符（实测踩过）。
 * @returns {string} 意图消息（可直接作为对话输入）
 */
export function buildDraftIntent(candidate, opts = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {}
  const existing = Array.isArray(opts.existingArtifacts) ? opts.existingArtifacts : []
  const draftsDir = normPath(opts.draftsDir)
  const skillsDir = normPath(opts.skillsDir)
  const workflowsDir = normPath(opts.workflowsDir)
  const appsDir = normPath(opts.appsDir)
  const acts = Array.isArray(c?.advice?.actions) ? c.advice.actions : []
  // ★ 默认通道 = **首条 draft:\*** 方向（不是 actions[0]）：actions 按成本升序排后，首条往往是
  //   `check-usage`（route:advice）—— 旧写法会让 channel 为 null ⇒ 起草消息写不出目标。
  const channel = draftChannelOf(c)
  // 手动模式的**全部**方向（按既有顺序、去重、只认真实存在的 draft 通道；非法/非 draft 一律不列）
  const directions = [...new Set(acts.map((a) => routeOfDraft(a?.route)).filter(Boolean))]
  const manual = opts.mode === 'manual'
  const ev = (Array.isArray(c.evidence) ? c.evidence : [])
    .map((e) => {
      const sid = typeof e?.sessionId === 'string' ? e.sessionId : ''
      if (!sid) return ''
      return Number.isInteger(e?.seq) ? `${sid}#${e.seq}` : sid
    })
    .filter(Boolean)
    .join('、')

  // 路径填空：**有真实值才填**；没有就把该片段整段去掉（不泄漏 `{xxx}` 占位符 —— 实测踩过 `(未指定)`）。
  const fill = (t) => t
    .replace('{workflowsDir}', workflowsDir || '（未提供工作流目录）')
    .replace('{appsDir}', appsDir || '（未提供应用目录）')
  const hint = channel ? fill(TARGET_HINT[channel]).replace('{{draftsDir}}', draftsDir || '（未提供草稿目录）') : ''
  const target = manual
    ? (directions.length
      ? ['目标（可任选其一，或按我的指示）：',
        ...directions.map((d) => `  · ${DIRECTION_LABEL[d]}：${fill(MANUAL_TARGET_HINT[d])}${d === 'workflow' || d === 'app' ? draftFallbackClause(draftsDir) : ''}`)].join('\n')
      : `目标：${NO_DRAFT_TARGET}`)
    : `目标：${hint || NO_DRAFT_TARGET}`

  // ★★ 2026-10-14 修（实测：消息里断言"（目录中无高度相关的既有件）"，而 agent 一查就找到 4 个相关技能）：
  //   端点从不传 existingArtifacts ⇒ 这句**永远是假的**。而"目录里没有相关件"是个**事实断言**，
  //   不知道就不能说（本仓"不臆造"纪律）。⇒ 没有清单时**如实说"未提供"**，并把该去核对的两个目录
  //   直接给出来（省掉 agent 自己猜路径的步数）。
  const artifactDirs = [skillsDir, workflowsDir].filter(Boolean).join(' 与 ')
  const existingLine = existing.length
    ? `现状（已有相关件）：${existing.map((a) => `${String(a?.kind || '?')}:${String(a?.id || '?')}`).join('、')}`
    : `现状：未提供既有件清单 —— 请先核对 ${artifactDirs || '技能目录与工作流目录'}，再判断「新建」还是「修订既有」（不要假定目录里没有）`

  const constraints = manual
    ? [
      '硬约束：',
      '  · 我就在这个会话里：可直接创建/更新生产工件（创建前把要点讲清，创建后我要过一遍；发布仍需我确认）',
      '  · 不得修改 kernel/ 、server/ 、契约与门禁',
      '  · 与既有件高度相关时优先「修订既有」而非新建 —— 若既有技能/工作流的表述已覆盖该模式，优先改它而不是新建',
      '  · 不得执行外部副作用（登录/填表/发送）',
    ]
    : [
      '硬约束：',
      '  · 发布需我确认，你只产出草案',
      '  · 不得修改 kernel/ 、server/ 、契约与门禁',
      '  · 与既有件高度相关时优先「修订既有」而非新建',
      '  · 不得执行外部副作用（登录/填表/发送）',
    ]

  // 收尾指引（仅 manual，且**仅当有 workflow 方向**）：试用面 = 工作流 rail 的运行抽屉（既有），
  // 缺的只是"用户知道去哪" ⇒ 只补提示词，不新增任何机制（设计稿 D47）。没有 workflow 方向时
  // 不提它（指错地方比不说更糟）。
  const closing = manual && directions.includes('workflow')
    ? ['收尾：若你创建/更新了工作流，请在回复里写明它的 id；我会在工作流面板里跑一次（那才是「试用」）。']
    : []

  return [
    `【演进起草】候选 ${String(c.id || '')}（${String(c.ruleId || '')} · ${String(c.subject || '')}）`,
    // ★★ 2026-10-14 修（实测：起草任务跑了 82 步、agent 自己扫 30 天 jsonl 重算失败次数）：
    //   原消息只给「命中 N 次」，没有任何实测数字 ⇒ agent 只能**自己去翻转录重算**。
    //   现在把内核已经算好的事实一并给它（与评审侧同一实现 `candidate-facts.mjs`）：
    //   少走几十步、且数字与面板完全一致（不会出现"消息说 51 次、它扫出 816 次"那种口径困惑）。
    `事实（系统实测到的，可直接引用，不必自己去扫转录重算）：${renderFacts(c)}`,
    `命中：${Number(c.count) || 0} 次`,
    `证据（可回跳的会话引用）：${ev || '（无）'}`,
    existingLine,
    target,
    ...constraints,
    ...closing,
  ].join('\n')
}
