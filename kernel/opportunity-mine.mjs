// kernel/opportunity-mine.mjs —— 演化环 P1 机会挖掘（纯函数）
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md
//   §4.3 规则 v1（OPP-1..4）/ §4.4 候选 schema / §4.5 端点口径。
// 施工 brief：docs/superpowers/plans/2026-10-09-p1-opportunity-layer.md（D2/D3/D4/D8 为已决偏离）。
//
// 纪律：
//  · 纯函数、零 IO、无时钟（now 由调用方注入）——同一输入必得同一输出（可复现、可单测）。
//  · 阈值集中一处（THRESHOLDS，冻结）；规则判定只看 TaskRecord 的**统计与引用**，
//    不读对话正文（隐私口径：报告/候选 = 统计 + 引用，不复制文本）。
//  · 空输入 = 空输出（精确 0 条，不造数据）——自举期"空窗口 = 0 条"是特性不是故障（spec §6）。
//  · id 稳定：sha256(ruleId|subject) 截断 12 位 ⇒ 跨扫描同题候选归并到同一 id（状态可继承）。
//  · adviceOf 只出 code（稳定标识符）、不出自然语言：文案在前端 i18n；纯函数、零 IO。
//  · score = clamp01(min(1, freqRatio/1.5) × sev(rule) × fresh)；
//    tier：≥.75 pin / ≥.60 list / 其余 collapsed（与 governance-router 的 .60/.75 词汇对齐）。
//
// 规则 v1 口径（brief D2/D3/D4；OPP-1 于 2026-10-10 降噪重定，见 THRESHOLDS 注释）：
//  · OPP-1 工具失败热点：同工具窗口内失败 ≥ K₁=5 次**且错误率 ≥ 15%**
//    （分母 = TaskRecord.tools.callsByTool 的调用数；判据依据见 THRESHOLDS 注释）。
//    subject=工具名；聚类粒度=工具名（TaskRecord 不存错误正文 ⇒"摘要前 N 字符聚类"推迟，见 brief D2）。
//  · OPP-2 技能加载后接着纠错：技能加载后 ≤ K₂=3 **轮内**出现用户纠正，同技能 ≥ K₃=2 次。
//    subject=技能 id；轮距换算用 record.turnSeq（inject_snapshot 条目 seq = 轮界）。
//  · OPP-3 同题重试：相邻用户消息字符 4-gram Jaccard ≥ 0.8（投影期算好，落 nearRepeatPairs），
//    同会话 ≥ K₃'=2 对。subject=会话 id；间隔重试不入 v1（只认相邻对）。
//  · OPP-4 守卫自愈热点：stallHeals ≥ 3 **或** errorStreakMax ≥ 5（满足其一即候选）。
//    subject=会话 id；count=stallHeals+errorStreakMax（综合强度，非单一频次——metrics 带拆分）。
//  · OPP-7 能力缺口（A2，2026-10-14）：同会话同题（指纹=失败工具名集合）失败 ≥2 次且**全程零技能加载**
//    ⇒ 建议**新建**技能（设计稿 §3.2 两半判据的①；②"用户显式求做 X 而目录无匹配"待注入面就绪后补）。
//    subject=会话id:任务指纹（**不是**裸会话 id——同一会话可能有多个互不相关的能力缺口）。
//    ★ 与既有四条**不同向**：那四条全是负面信号（失败/被纠正/重试/自愈），本条是**机会信号**（该补能力）。
//    ★ 零加载**必须可判定**（`skills.loaded` 是数组）才产：老投影无技能面 ⇒ 跳过不猜
//      （同 OPP-1 缺 callsByTool 的"旧投影保护"；缺省当零会让常态失败全变成"建议新建"＝造创建噪声）。
//  · OPP-8 熟练模式结晶（A2，2026-10-14）：**同一套工具组合**（指纹 = 投影期 tools.sequence，
//    工具名升序去重 join('>')）跨 ≥3 个会话重复出现，且**未被既有技能/工作流覆盖** ⇒ 建议固化。
//    subject=指纹本身（`Read>Edit>Grep`）；"已固化"判据 = 指纹在 `opts.existingPatterns`（调用方注入）。
//    ★ 一条候选**两个方向**（Task 11 裁决）：做成**技能**（能力复用）或做成**工作流**（流程编排）。
//      `actions` 是数组，用它表达"可做成 A 或 B"；**不新增独立规则**——原计划的 OPP-9（规格预留的流程优化项）其判据
//      与 OPP-8 完全不可区分（同为"同一 tools.sequence 跨 ≥3 会话且未被 existingPatterns 覆盖"）
//      ⇒ 加成独立规则会给同一事实产两条一模一样的候选。技能优先（actions[0] = draft:skill）：
//      前端「生成方案」按钮与端点取的都是首条 route，故顺序 = 默认通道。
//    ★ 为什么"已固化"不按计划原文的 4-gram 相似度：模式指纹是**工具名集合**、技能描述是**自然语言**
//      ⇒ 两者无共同度量空间（算出来的相似度无意义）；且 kGramsOf/nrJaccard 在 trace-project.mjs 里
//      是私有函数（复用要新开出口）。改为"调用方读盘 → 注入已覆盖指纹集合"：确定、可测、可解释。
//    ★ 老投影无 tools.sequence ⇒ 跳过不猜（同 OPP-1 缺 callsByTool / OPP-7 缺 skills 面的纪律）。
import { createHash } from 'node:crypto'

/**
 * 候选行的 **schema 版本**（写好进每一行；`planScanAppends` 据此决定是否**重新物化**）。
 *
 * ★ 为什么必须升它（2026-10-14，两次踩坑后确立的纪律）：
 *   `candidates.jsonl` 是 **append-only**，`planScanAppends` 只在"计数/评分变化"或"缺字段"时补落新行。
 *   于是**改变 metrics/advice 的形状**后，**存量行永远拿不到新字段** —— 表现为界面缺内容且毫无线索：
 *   · 加 OPP-1 的 `multiple` 后：老行没有它 ⇒ 事实行里的倍数只能显示占位；
 *   · 加 OPP-7 的 `sessionId`/`tools` 后：老行没有它 ⇒ 事实行渲染成
 *     「会话 <机器码>：— 反复失败 N 次」（用户实测报的正是这个）。
 *   升 `MINE_V` ⇒ 老行会被**重新物化**（保留 state，见 planScanAppends），内容立刻变完整。
 *
 * ★ 变更规矩：**任何改动候选行字段形状的提交都必须同时 +1**，并补一条"老版本行会被重物化"的测试。
 *   v1 → v2（2026-10-14）：OPP-1 加 `metrics.multiple`；OPP-7 加 `metrics.sessionId` / `metrics.tools`。
 *   v2 → v3（2026-10-18，EVO-09）：新增 `rv`（判据语义版本）字段 —— 字段形状变了，按规矩 +1。
 *     老行（无 rv）会被重物化一次，补上 rv；此后由 rv 判断是否退休。
 */
export const MINE_V = 3

/** 候选状态机（§4.4）：new 新出 / seen 已看 / dismissed 忽略 / actioned 已处置 */
export const CANDIDATE_STATES = Object.freeze(['new', 'seen', 'dismissed', 'actioned'])

/** 证据引用上限（候选行体积受控；聚合计数不受限） */
export const EVIDENCE_CAP = 5

/** 频次项缩放：freqRatio=1（恰在阈值）⇒ freq=1/1.5；freqRatio≥1.5（1.5 倍阈值）⇒ freq=1 */
export const FREQ_SCALE = 1.5

/** 新鲜度下限（lastAt 过老/不可解析时不再往 0 掉，避免"大热点因旧被埋"） */
export const FRESH_FLOOR = 0.3

/** 分档阈值（可治理的三档词汇；与 governance-router DEFAULT_THRESHOLDS 的 low/med 对齐） */
export const TIER_PIN_MIN = 0.75
export const TIER_LIST_MIN = 0.6

/** 规则 → 领域词汇（kind）单一映射；THRESHOLDS 的键即规则清单 */
export const RULE_KINDS = Object.freeze({
  'OPP-1': 'tool-failure',
  'OPP-2': 'skill-correction',
  'OPP-3': 'same-task-retry',
  'OPP-4': 'guard-heal',
  'OPP-7': 'capability-gap',
  'OPP-8': 'skill-crystallize',
  // ★ 2026-10-19：第一条**非建件**规则（上下文预算压力 —— 处置在配置面，不是加技能）
  'OPP-11': 'context-budget',
  // 第二条非建件规则：模型维度（换模型是设置项，不是建件）
  'OPP-12': 'model-mismatch',
  // ★ P3（2026-10-27）：修复**没治好**（修完又复发）—— 处置是"重新诊断根因"，同样不建件
  'OPP-13': 'fault-recurrence',
})

/**
 * 阈值集中一处（冻结）。K₃'=2 为 v1 自定（spec 未给，取与"≥2 次"同保守度；brief D3）。
 * sev = 严重度权重（score 的乘积因子；>1 表示该类机会更值得看）。
 *
 * ★ 2026-10-10 OPP-1 降噪重定（判据从"绝对失败次数"改为"**错误率显著高于基线**"）：
 *   实测依据（142 会话 / 9103 次工具调用 / 30d 窗口，报告见 .ponos/process/演化诊断/）：
 *     Bash 216/5005=4.32% · Edit 36/1678=2.15% · Read 22/1100=2.00%
 *     Grep 15/481=3.12% · Write 13/315=4.13%  —— 全部**≈全局基线 4.01%**；
 *     WebFetch 54/143=37.76%（基线的 9.4 倍）。
 *   旧口径 `count ≥ 5` 对上面 6 条一视同仁 ⇒ 6 条常态错误全部顶到 pin 档（score 0.996），
 *   与 spec §6「自举期候选应近零」正好相反（首日满屏）——这就是"噪声"的量化定义。
 *   新判据：**最小样本门 + 绝对错误率门**（failures ≥ 5 且 errRate ≥ 15%）。
 *     · minFailures  保最小样本（样本太小不算热点，如 OCR 1 次错）；
 *     · minErrorRate 绝对地板 15%：可直接讲给人听的量级（"每 7 次调用就错 1 次"）。
 *   ★ 为什么**不用"相对基线"**（设计过程中的两次实测负结果，留痕防回退）：
 *     ① 若基线取"全局错误率"（含被测工具自身）⇒ 该工具主导调用量时，自己的错误率≈基线，
 *        `3×基线` 永远达不到 ⇒ **真热点永远不出**（单工具项目必现的自指陷阱）；
 *     ② 改用 leave-one-out（排除自身）后，自指消失，但**多个高错误率工具会互相抬高门槛**：
 *        实测构造 Flaky 40% + Grep 20% ⇒ Flaky 的 others=20% ⇒ need=60% ⇒ 40% 反而不出；
 *        Grep 的 others=40% ⇒ need=120% ⇒ 也不出 ⇒ **整体劣化时一个都看不见**（与本判据
 *        "找异常工具"的定位相反：环境整体劣化属于 E3/守卫信号的面，不是 OPP-1 的面）。
 *     ⇒ 判定用**绝对门**（简单、可解释、无自指、不互相抬高）；基线仍算出来放 metrics
 *       （`baselineRate`/`rates`），供界面显示"是基线的 9.4 倍"——**信息给用户，判定保持简单**。
 *   实测校验（15% 门）：WebFetch 37.76% ≥ 15% ⇒ 命中（真热点留下）；
 *             Bash 4.32% / Edit 2.15% / Read 2.00% / Grep 3.12% / Write 4.13% ⇒ 全部不命中
 *             （噪声去掉）；OCR 11.11% 因 minFailures 门被挡（1 次错，样本不足）。
 */
export const THRESHOLDS = Object.freeze({
  'OPP-1': Object.freeze({ minFailures: 5, minErrorRate: 0.15, sev: 1.0 }),
  'OPP-2': Object.freeze({ withinTurns: 3, minHits: 2, sev: 1.2 }),
  'OPP-3': Object.freeze({ similarity: 0.8, minPairs: 2, sev: 0.9 }),
  'OPP-4': Object.freeze({ minStallHeals: 3, minErrorStreak: 5, sev: 1.1 }),
  // A2：单工具失败 ≥2 次 + 同会话同题累计 ≥2（后者在 v1 里恒被前者蕴含——保键以备将来单工具多次
  // 与多工具各一次的区分；sev 略高于 OPP-4：创建类机会比自愈更值得看，但对"目录增生"保持克制）
  // 2026-10-14（重做）：按"反复失败的工具集合"聚合 + **跨会话复现门**（minSessions）。
  //   原实现按 `会话id:工具指纹` 聚合 ⇒ subject 是机器码、且单会话内凑几次失败即命中
  //   （用户质疑：一次事故不该叫能力缺失）。minSessions ≥2 表示"**不止一次**遇到同一个坑"。
  'OPP-7': Object.freeze({ minPerToolFailure: 2, minHits: 5, minSessions: 2, sev: 1.15 }),
  // A2/Task 7：OPP-8 熟练模式结晶（同一套工具组合跨 ≥3 个会话且**未被既有件覆盖**）。
  // sev 1.1 = OPP-4 同档（"值得看但不紧急"）；判定只需要跨会话计数，阈值只有一个维度。
  // ★ 2026-10-14 加强（用户实测反馈："一个工具调用链三次会话重复使用了，就要提议做工作流"）：
  //   原判据只有"跨 ≥3 会话同指纹"，配上当时的**集合型**指纹（{Read,Edit,Grep} 人皆有之）
  //   ⇒ 几乎任何编码任务都命中，且候选个个雷同。三道门补齐"辨识度"与"体量"：
  //   · crossSessions 3→5：指纹既然更精确，就用更多次数确认它**反复**出现（不是偶合）；
  //   · minDistinctTools ≥4：排除"随手用了两三个工具"（那种没有可固化的编排）；
  //   · minCalls ≥15：会话要够"厚"——轻量会话的工具序列不构成值得固化的流程；
  //   · maxUbiquity：★ 关键的一条——命中会话占活跃会话 > 50% 时，这不是"特殊模式"而是
  //     **你的日常**（"每天都是 Read>Edit>Grep"）⇒ 提"固化成技能"没有信息量，只是噪声。
  //     这条直接治"太松"：值得固化的模式必须是**少数会话里反复出现**的那种。
  //   ★ 阈值校准说明：以上取值来自"弱指纹会大量误报"的推演，**尚未**用真实数据校准
  //   （本机候选库在会话目录外，读不到）。上线后应按 `metrics` 里落盘的
  //   `ubiquity / distinctTools / avgCalls` 分布复核——若仍偏松，先提 crossSessions，再收 maxUbiquity。
  'OPP-8': Object.freeze({
    crossSessions: 5, minDistinctTools: 4, minCalls: 15, maxUbiquity: 0.5, sev: 1.1,
  }),
  // ★ 2026-10-19（用户反馈第三、四条）："演进机会全是新建/更新技能" —— 缺的是**不建件**的那一类。
  //   OPP-11「上下文预算压力」判的是"每轮注入的提示词过大"（技能清单/知识库/经验都在里面），
  //   它的正确处置几乎全是**配置面**（精简技能清单、关掉没用到的注入源、收窄知识库），
  //   而不是再建一个技能 —— 加技能只会让这个数字更大（本仓 skill-catalog-budget 探针量过）。
  //   判据只用 TaskRecord 既有字段（`inject.totalBytes` / `bySource` / `turns`），不新增数据面：
  //   · minTotalBytes 60000 = 单轮提示词 60 KB 量级的实测量（14.5KB 技能清单 + 工具 schema + 协议…）；
  //   · minTurns 6 = 会话要够长（只聊两句的大提示词不算"持续压力"）；
  //   · minSessions 2 = **跨会话复现**（同 OPP-7 的纪律：一次异常不叫能力/配置问题）；
  //   · sev 0.95：比"能力缺口"轻一档 —— 它不阻塞任何事，但会持续拉高每次调用的成本。
  'OPP-11': Object.freeze({ minTotalBytes: 60000, minTurns: 6, minSessions: 2, sev: 0.95 }),
  // ★ 2026-10-19：第二条**非建件**规则 —— 模型维度（用户选择"先补模型分段统计再出规则"）。
  //   判据：某模型跨 ≥2 会话、工具调用 ≥40 次后，**绝对错误率 ≥12%**。
  //   ★ 为什么用**绝对门**而不是"比别的模型高 N 倍"（与 OPP-1 的裁决同一理由，勿回退）：
  //     相对门在"两个模型都不行"时互相抬高门槛 ⇒ 整体劣化时一个都不出（OPP-1 的实测负结果）；
  //     而"整体劣化"在本规则里恰恰**值得报**（可能是环境/任务变难，换模型也许不是解法 ——
  //     那由建议区第二条"先查用法与环境"去说）。倍数只放进 metrics 供界面展示，不参与判定。
  //   ★ sev 1.0：与 OPP-1（工具错误率热点）同档 —— 都是"持续在出错"的强信号。
  'OPP-12': Object.freeze({ minCalls: 40, minSessions: 2, minErrorRate: 0.12, sev: 1.0 }),
  // ★ P3（2026-10-27）：**复发升级**。判据来自归因视图（`kernel/error-attribution.mjs`）：
  //   同一错误指纹在"修完之后 7 天内又出现"⇒ recurring；其中 **48h 内再现 = 立刻复发**（immediate）。
  //   ★ 为什么复用归因而不是另算：复发判定的唯一真源是"修→再现"的时间关系，
  //     归因层已经按 fp 聚合过三源，这里再算一遍必然对不上。
  //   ★ sev 1.0：与"持续出错"同档 —— 复发意味着**上一次修复无效**，比首次失败更值得处理。
  'OPP-13': Object.freeze({ minRecurrences: 1, immediateHours: 48, sev: 1.0 }),
})

/**
 * 建议路线枚举（冻结，顺序即优先级）：前端按 route 分派动作入口；少一项 = 该方向落到"无按钮"，
 * 故枚举与 i18n 文案键成对维护。
 */
export const ADVICE_ROUTES = Object.freeze(['advice', 'draft:skill', 'draft:workflow', 'draft:app', 'settings', 'dev'])

/** 空结构（不臆造建议：metrics 不可解析 / 未知 ruleId / 未达门 ⇒ 精确空） */
const emptyAdvice = () => ({ hypoth: [], actions: [] })

/**
 * 候选 → 建议（纯函数：零 IO、无时钟、无随机；同输入必得同输出）。
 * 只出 **code 稳定标识符**（'site-unstable' / 'draft:skill' …）；自然语言文案在前端 i18n。
 * 门槛口径（**不要误读为"与候选同一门槛"**）：
 *  · 只有 **OPP-1** 复用 THRESHOLDS['OPP-1'].minErrorRate 作为门槛（常态率不出建议，防噪声）；
 *  · **其余规则的门在上游 mineCandidates**（OPP-2 ≥2 次 / OPP-3 ≥0.8 相似度 ≥2 对 / OPP-4 ≥3 或 ≥5），
 *    本函数只做**可解析性校验**（非正/非有限/双零 ⇒ 空），不重复判定阈值。
 *
 * metrics 字段名逐字对齐内核产出的 **metrics 块**（写错不报错，只会静默返空）：
 *  · OPP-1 分支的 `metrics: { sessions, calls, errRate, baselineRate, needRate, … }`
 *    —— 是 errRate（**不是** errorRate）、倍数的分母是 baselineRate
 *  · OPP-2 —— ★ `metrics: { count }`（曾为 `{}`，`count` 只在候选行顶层）；
 *    A1「候选行携带 advice」任务已把 `count` 补进 metrics —— 在此之前本函数对它恒静默返空
 *    （即：唯一带「起草修订」按钮的规则反而没有建议说明；勿以注释为准，以源码为准）
 *  · OPP-3 分支的 `metrics: { maxSimilarity }`（内核**无** pairs 键）
 *  · OPP-4 分支的 `metrics: { stallHeals, errorStreakMax, worstLevel }`
 *  · OPP-7 分支的 `metrics: { failures, skillLoaded }`
 *    —— 门在 metrics.failures（**不是**顶层 count：本函数只读 metrics）
 *  · OPP-8 分支的 `metrics: { sessions }`（跨会话数 = 该模式结晶的强度）
 *    —— 同 OPP-7 只读 metrics；跨会话数**只挂在 hypoth 那条带占位符的假设上**（actions 不带 args）：
 *      前端组件对 actions 调用 `t(key)` **不传 args** ⇒ 方向文案不得含占位符（含了就原样显示）
 *      ⇒ 给 action 挂 args 是死数据。两条方向（技能优先）见该分支注释。
 *  （行号是易失引用，故此处一律用键名锚点。）
 *
 * @param {string|null} ruleId 'OPP-1'..'OPP-8'（未知/缺失 ⇒ 空结构）
 * @param {object} metrics 候选行 metrics
 * @returns {{hypoth: {code: string, args?: object}[], actions: {code: string, route: string, args?: object}[]}}
 */
export function adviceOf(ruleId, metrics) {
  const m = metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : null
  if (!m) return emptyAdvice()

  if (ruleId === 'OPP-1') {
    const errRate = Number(m.errRate)
    if (!Number.isFinite(errRate)) return emptyAdvice()
    if (errRate < THRESHOLDS['OPP-1'].minErrorRate) return emptyAdvice()
    const baselineRate = Number(m.baselineRate)
    // 倍数只在分母可用时给（<=0 / 不可解析 ⇒ 不除零、不臆造倍数）
    const args = Number.isFinite(baselineRate) && baselineRate > 0 ? { multiple: (errRate / baselineRate).toFixed(1) } : {}
    return {
      hypoth: [{ code: 'site-unstable', args }, { code: 'tool-abuse' }, { code: 'env-issue' }],
      actions: [
        { code: 'switch-to-bash', route: 'advice' },
        { code: 'write-discipline', route: 'draft:skill' },
        { code: 'check-env', route: 'settings' },
      ],
    }
  }

  if (ruleId === 'OPP-2') {
    const count = Number(m.count)
    if (!Number.isFinite(count) || count <= 0) return emptyAdvice()
    return {
      hypoth: [{ code: 'skill-text-unclear' }, { code: 'skill-should-split' }],
      actions: [{ code: 'revise-skill', route: 'draft:skill', args: { count } }],
    }
  }

  if (ruleId === 'OPP-3') {
    // 只认真正的数字：Number(null)/Number('') 都 = 0（有限）⇒ 强转会**反而产建议**，与"不可解析 ⇒ 空"相悖
    if (typeof m.maxSimilarity !== 'number' || !Number.isFinite(m.maxSimilarity)) return emptyAdvice()
    return {
      hypoth: [{ code: 'task-stuck' }, { code: 'missing-tool' }],
      actions: [{ code: 'diagnose-failure', route: 'advice' }],
    }
  }

  if (ruleId === 'OPP-7') {
    // 只做可解析性校验（门槛在上游 mineCandidates：失败 ≥2 次且零技能加载）
    const failures = num(m.failures)
    if (!failures) return emptyAdvice()
    // ★ code 一律 kebab-case（class-tool-usage / create-skill / revise-existing）。
    //   理由：`src/lib/evolution.test.ts` 有**机械抽取守卫**——它按"code 冒号 + 引号 + 非引号串"
    //   的形态扫本函数体，断言前端映射表全覆盖。写驼峰会静默漏抽 ⇒ 映射断言失效 ⇒ 该建议永不显示。
    //   （反例留痕：本注释若写出引号形态的 code 字面量，会被那守卫当成真 code 抽走并判红。）
    // ★ missing-tool 复用 OPP-3 的既有 code（语义相同：缺"一次做完"的工具），故无新文案。
    // ★★ 2026-10-14 重做（用户实测两条批评，都成立）：
    //   ① "为什么所有的建议都是做技能" —— 原 actions 只有两个 code，**同属技能面**；而"反复用同一批
    //      工具失败"完全可能是别的原因：工具不好用（该换做法/参数）、环境/配置问题、或者不是缺知识
    //      而是缺**编排**（该固化成流程）。故补齐四个方向、分属四个面。
    //   ② "技能那么多会不会拖系统上下文" —— **真问题**（技能目录进 system 提示词，本仓
    //      `skill-catalog-budget` 探针就是量它的）。故凡"建议新建技能"的场景，都把成本明说出来，
    //      让用户带着代价判断值不值；且**只在确有多会话复现时**才提（单条候选不构成目录压力，写了是噪声）。
    // ★★ 2026-10-14 第二轮（用户担忧："所有演化的判定几乎都是新建 skill，这样会不会污染上下文"）：
    //   上一版把 `create-skill` 排在**第一位** = 默认通道 ⇒ agent 永远先走"新建技能"。这是**成本倒挂**：
    //   四个方向对 system 提示词的开销差一个量级 ——
    //     · check-usage       **0**（不建任何件：先查用法/环境/权限）
    //     · revise-existing   **0 新增**（改既有正文；清单里的 id/触发词不变）
    //     · create-workflow   +~150 B（工作流清单同样进提示词，见 kernel/prompt.mjs 第 375 行）
    //     · create-skill      **+~163 B/个**（技能清单按"触发词档"注入，本机实测 89 技能 ≈ 14.5 KB）
    //   ⇒ 改为**成本升序**：先让他做最便宜、且最可能真的解决问题的那件事。
    //   ★ 这不只是排序洁癖：技能清单是**模型选哪个技能**的目录，条目越多、触发词重叠越重，
    //     选错的概率越高（"收尾"二字误触发 gxtz-project-closure 就是实例）。加技能有**两重**代价：
    //     清单字节 + 选择噪声；而"反复失败"未必是缺技能（可能是用法/环境/任务本身难）。
    const sessions = num(m.sessions)
    const toolList = Array.isArray(m.tools) && m.tools.length ? m.tools.map(String).join('、') : ''
    return {
      hypoth: [
        // ★★ 2026-10-14 第三轮（用户：*"给建议加「先判断属于哪一类」"*）：
        //   本条规则的判据是"零技能加载 + 反复失败" —— 它**天然**指向"缺能力"，这是自证：
        //   只因为"没加载技能"就说"该加技能"。但反复失败至少有**三类成因**，处置完全不同，
        //   且其中两类**不该新建任何件**。故把三类的**判别判据**直接写进假设，让 agent 先分类：
        { code: 'class-tool-usage', args: toolList ? { tools: toolList } : {} }, // ① 用法/环境：同一处反复踩坑
        { code: 'class-task-nature' },                                          // ② 任务本身：归因不可归到"缺知识"
        { code: 'class-missing-knowledge' },                                    // ③ 真缺知识/编排：跨多个不同任务
        // 代价提示（只在确有多会话复现时提；单条候选不构成目录压力，写了是噪声）
        ...(sessions >= 2 ? [{ code: 'skill-catalog-cost', args: { sessions } }] : []),
      ],
      actions: [
        // ★ 成本升序（勿随意调序：首条是默认通道，会决定 agent 先做什么）
        { code: 'check-usage', route: 'advice' },            // 0 成本，不建件
        { code: 'revise-existing', route: 'draft:skill' },   // 0 新增（改既有）
        { code: 'create-workflow', route: 'draft:workflow' }, // 进工作流清单
        { code: 'create-skill', route: 'draft:skill' },      // 最贵（进技能清单）⇒ 放最后
      ],
    }
  }

  if (ruleId === 'OPP-8') {
    // 只做可解析性校验（门槛在上游 mineCandidates：跨会话 / 体量 / 显著性三道门）
    const sessions = num(m.sessions)
    if (!sessions) return emptyAdvice()
    // ★ 证据全带进 args（2026-10-14，治"表述同质化"）：把该候选**自己的**体量数字给到文案，
    //   于是每条建议长得都不一样（`4 个工具 / 平均 18 次调用 / 5 个会话`），而不是逐字雷同的套话。
    // ★ 一条候选**两个方向**（Task 11 裁决，理由见文件头 OPP-8 注释）：`actions` 是数组，本来就该用它
    //   表达"可做成 A 或 B"——原计划的独立规则 OPP-9 判据与 OPP-8 完全一致 ⇒ 只会产两条重复候选。
    //   技能优先（首条是 draft:skill）：前端「生成方案」按钮的判据与端点 `POST /evolution/draft`
    //   取的都是**首条** action 的 route ⇒ 首条 = 默认通道（换成 workflow 会让默认通道变成流程）。
    // ★ code 一律 kebab-case——同 OPP-7 的纪律：src/lib/evolution.test.ts 的机械抽取守卫扫本函数体里
    //   "code 冒号 + 引号字面量"的形态，断言前端映射表全覆盖；写驼峰会静默漏抽 ⇒ 映射断言失效 ⇒
    //   该建议永不显示。（同上：本注释**不得**写出引号形态的 code 字面量，否则会被那守卫当成真 code 抽走并判红。）
    // ★ 插值参数只挂 hypoth：组件对 actions 调 t(key) **不传 args**（给 action 挂 args 是死数据，
    //   给方向文案写占位符会原样显示）⇒ 证据只挂在含占位符的那条假设上。
    // ★★ 2026-10-19（用户反馈："演进生成方案默认新建 skill，不符合使用要求" + "要流程编排方向"）：
    //   **默认通道改为流程**（`create-workflow` 首条）。理由不是口味，而是这条规则**判的东西**：
    //   它识别的是一套**跨 5 个会话反复出现的工具组合**——那本质是一段**编排**（先读什么、再改什么、
    //   最后怎么验），把它固化成"技能"其实是让它以**文字说明**的形式重新进提示词（还要模型自己
    //   照着做）；固化成工作流则是把它变成**可执行的结构**（画布可见、可运行、可验收）。
    //   ⇒ 流程优先是语义上更贴切的那一侧；技能方向仍然保留（有些组合的知识面比流程面更值得沉淀）。
    //   ★ 与 OPP-7 的区别（勿混淆）：那条判"反复**失败**"（缺能力/缺编排/环境问题，成本升序先查用法），
    //     这条判"反复**成功**且稳定"（已经会的动作，值得沉淀）—— 所以这里不需要先"检查用法"。
    return {
      hypoth: [{
        code: 'repeatable-pattern',
        args: { sessions, tools: num(m.distinctTools), calls: Number(m.avgCalls) || 0 },
      }, { code: 'repeatable-flow' }],
      actions: [
        { code: 'create-workflow', route: 'draft:workflow' }, // 首条 = 默认通道（流程优先，见上）
        { code: 'crystallize-skill', route: 'draft:skill' },
      ],
    }
  }

  if (ruleId === 'OPP-11') {
    // ★ 2026-10-19：非建件规则的第一个成员。只做可解析性校验（门槛在上游 mineCandidates）。
    //   三个方向**全都不建任何件**：配置面（精简/关闭注入源）、用法面（先看谁在吃字节）、诊断面（dev）。
    //   ★ 刻意**不提供** draft:skill ——"上下文太大"的解法不可能是"再加一个技能"（自相矛盾）。
    const avgBytes = Number(m.avgBytes)
    const topSource = typeof m.topSource === 'string' && m.topSource ? m.topSource : ''
    if (!(avgBytes > 0)) return emptyAdvice()
    return {
      hypoth: [
        { code: 'context-bloat', args: { kb: Math.round(avgBytes / 1024), source: topSource || '—' } },
        { code: 'context-config', args: { kb: Math.round(avgBytes / 1024) } },
      ],
      actions: [
        { code: 'trim-context', route: 'settings' }, // 配置面：关掉/收窄注入源（最直接）
        { code: 'check-usage', route: 'advice' },    // 用法面：先看这些字节都花在哪
      ],
    }
  }

  if (ruleId === 'OPP-12') {
    // ★ 2026-10-19（用户选择"先补模型分段统计再出规则"）：第二条**非建件**规则。
    //   只做可解析性校验（门槛在上游 mineCandidates：调用量 / 跨会话 / 绝对错误率三道门）。
    //   ★ 三个方向全都不建件：换模型（配置面，最直接）、查用法（可能是参数/权限）、查环境（网络/代理）。
    //   ★ 刻意**不给** draft:* —— "这个模型老是出错"的解法不可能是"再建一个技能"。
    //     这与 OPP-11 同一条纪律：**建议必须与判据同面**，否则用户按建议做完发现数字更糟。
    const errRate = Number(m.errRate)
    const calls = num(m.calls)
    if (!(errRate > 0) || !calls) return emptyAdvice()
    const multiple = Number(m.multiple)
    return {
      hypoth: [
        {
          code: 'model-mismatch',
          // 证据（错误率 + 调用量 + 倍数）只挂在这条带占位符的假设上；
          // actions 的文案一律不带占位符（组件对 actions 调 t(key) 不传 args）
          args: { rate: Math.round(errRate * 100), calls, ...(Number.isFinite(multiple) && multiple > 0 ? { multiple: multiple.toFixed(1) } : {}) },
        },
        { code: 'prompt-ambiguity' },
        { code: 'env-flaky' },
      ],
      actions: [
        { code: 'switch-model', route: 'settings' }, // 配置面：换一个模型试（最直接的低成本验证）
        { code: 'check-usage', route: 'advice' },    // 用法面：参数/路径/权限也可能造成同样形状的失败
      ],
    }
  }

  if (ruleId === 'OPP-4') {
    const stallHeals = Number(m.stallHeals)
    const errorStreakMax = Number(m.errorStreakMax)
    const stall = Number.isFinite(stallHeals) && stallHeals > 0 ? stallHeals : 0
    const streak = Number.isFinite(errorStreakMax) && errorStreakMax > 0 ? errorStreakMax : 0
    if (stall <= 0 && streak <= 0) return emptyAdvice()
    return {
      hypoth: [{ code: 'prompt-ambiguity' }, { code: 'env-flaky' }],
      actions: [{ code: 'review-turn', route: 'advice' }],
    }
  }

  if (ruleId === 'OPP-13') {
    // ★ P3（2026-10-27）：复发 ⇒ 只说"重新诊断根因"与"查环境"，**不建任何件**。
    //   理由：复发恰恰说明"上一次修的方向可能就不对"，此时再建技能/工作流只会叠加噪音。
    //   全部复用既有 code（不新增前端映射键）：diagnose-failure（advice）、check-env（settings）。
    const count = num(m.recurrences)
    const origins = num(m.originCount)
    if (!count || !origins) return emptyAdvice()
    return {
      hypoth: [
        // 立刻复发（48h 内）优先用 env-flaky：时间太短，更像是环境/外部状态在反复；
        // 7 天内复发用 prompt-ambiguity：更可能是"改的位置不对/没改到根因"。
        { code: m.immediate ? 'env-flaky' : 'prompt-ambiguity', args: { count, origins } },
        { code: 'env-issue' },
      ],
      actions: [
        { code: 'diagnose-failure', route: 'advice' },  // 重新定位根因（不是再修一遍同一个地方）
        { code: 'check-env', route: 'settings' },       // 外部状态（代理/权限/磁盘）也会造成同样形状
      ],
    }
  }

  return emptyAdvice()
}

const DAY_MS = 86400000
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const seqOf = (v) => (Number.isInteger(v) && v >= 0 ? v : null)
const clamp01 = (n) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}
const earlierOf = (a, b) => {
  if (typeof b !== 'string' || !b) return a || null
  if (!a) return b
  return b < a ? b : a
}
const laterOf = (a, b) => {
  if (typeof b !== 'string' || !b) return a || null
  if (!a) return b
  return b > a ? b : a
}

// ★ 2026-10-14：`taskFingerprintOf`（把失败工具名哈希成 8 位指纹）已删 —— 它唯一的用途是给
//   OPP-7 老判据（`会话id:指纹`）造机器码 subject。判据重做后 subject 直接用**工具集合本身**
//   （可读：`Grep、Read`），那个哈希再没有调用者。本仓禁孤儿：没人用的函数留着只会误导后人。

/** 候选 id：sha256(ruleId|subject) 截断 12 位（稳定、与扫描时间无关） */
export function candidateIdOf(ruleId, subject) {
  return createHash('sha256').update(`${ruleId}|${subject}`).digest('hex').slice(0, 12)
}

/**
 * 新鲜度 ∈ [FRESH_FLOOR, 1]：1 − ageDays/windowDays；lastAt 不可解析/now 缺失 ⇒ 落下限
 * （保守，不虚高——brief D4）。
 */
export function freshnessOf(lastAt, { nowMs, windowDays }) {
  const t = Date.parse(String(lastAt ?? ''))
  if (!Number.isFinite(t) || !Number.isFinite(nowMs) || !(Number(windowDays) > 0)) return FRESH_FLOOR
  const ageDays = Math.max(0, (nowMs - t) / DAY_MS)
  return Math.max(FRESH_FLOOR, clamp01(1 - ageDays / Number(windowDays)))
}

/** score = clamp01(min(1, freqRatio/1.5) × sev × fresh)（4 位小数，稳定序列化） */
export function scoreOf({ freqRatio, sev, fresh }) {
  const fr = Number.isFinite(freqRatio) && freqRatio > 0 ? freqRatio : 0
  return Number((clamp01(Math.min(1, fr / FREQ_SCALE) * Number(sev) * clamp01(fresh))).toFixed(4))
}

/** 分档：≥.75 pin / ≥.60 list / 其余 collapsed */
export function tierOf(score) {
  const s = Number(score) || 0
  if (s >= TIER_PIN_MIN) return 'pin'
  if (s >= TIER_LIST_MIN) return 'list'
  return 'collapsed'
}

/** seq → 轮序（turnSeq=每轮 inject_snapshot 的条目 seq，升序；轮序=≤seq 的轮界条数） */
function turnIndexOf(seq, turnSeq) {
  let n = 0
  for (const t of turnSeq) if (t <= seq) n++
  return n
}

/**
 * **判据语义版本**（EVO-09，2026-10-18）。
 *
 * 与 `MINE_V`（管**行字段形状**）是**两个不同维度**，不可混用：
 *   · `MINE_V`   —— 字段增删改时 +1 ⇒ 决定存量行是否要**重新物化**（补新字段）。
 *   · `RULE_V`   —— 判据**语义**变化时 +1（例如 OPP-7 从"会话指纹"改成"工具集合"）
 *                  ⇒ 决定存量行是否**退休**（按旧判据产出的候选，不该继续留在待办里）。
 *
 * ★ 为什么必须有它（本台账 EVO-09 实测）：判据重做后，按旧判据产出的候选**永久滞留**为 new：
 *   扫描只处理"本轮 mined 出的"候选，对"已存在但本轮不再产出"的行**没有任何分支**。
 *   2026-10-17 处置前 85 个待处置候选里 **64 个**是 OPP-7 旧判据遗留（subject 还是
 *   `sessionId:hash` 机器码）—— 需人工逐条 dismiss 81 条才把待处理降到 0。
 *
 * ★ 为什么不用"时间窗"当退休判据（实测无效）：旧孤儿候选的 lastAt 集中在 10-06~10-16，
 *   即便把窗口放宽到 30 天它们也不会"自然到期"。判据变更与窗口波动是两件事，不能混。
 *
 * ★ 升级纪律：**改动任何规则的判定语义（不只改字段）都必须 +1**，否则旧候选不会退休。
 * ★ 2026-10-19 判例（**不**升版）：新增规则 OPP-11 与"调整某条规则的 actions 排序"**不等于**
 *   既有候选失效 —— 旧候选的判据仍然成立，退休它们只会把用户手上真实的待办清空。
 *   升版的唯一理由应是"按旧判据产出的候选**如今是错的**"（如 OPP-7 换 subject 口径那次）。
 */
export const RULE_V = 1

/** 当前所有规则的语义版本（写进候选行，供扫描侧比对退休） */
function currentRuleVersion() { return RULE_V }
function buildCandidate(ruleId, subject, ctx, { count, freqRatio, refs, firstAt, lastAt, metrics }) {
  const th = THRESHOLDS[ruleId]
  const fresh = freshnessOf(lastAt, { nowMs: ctx.nowMs, windowDays: ctx.windowDays })
  return {
    v: MINE_V,
    // ★ EVO-09：写入**判据语义版本**（与 MINE_V 不同维度：它管语义、MINE_V 管字段形状）
    rv: currentRuleVersion(),
    id: candidateIdOf(ruleId, subject),
    ruleId,
    kind: RULE_KINDS[ruleId],
    subject,
    score: scoreOf({ freqRatio, sev: th.sev, fresh }),
    count: num(count),
    metrics: metrics && typeof metrics === 'object' ? metrics : {},
    // A1：建议（内核出 code / 前端出文案）——用**与判定同源的 metrics** 派生
    advice: adviceOf(ruleId, metrics && typeof metrics === 'object' ? metrics : {}),
    window: { from: ctx.window.from, to: ctx.window.to, days: ctx.windowDays },
    evidence: (Array.isArray(refs) ? refs : []).slice(0, EVIDENCE_CAP)
      .map((r) => ({ sessionId: typeof r?.sessionId === 'string' ? r.sessionId : null, seq: seqOf(r?.seq), ts: typeof r?.ts === 'string' && r.ts ? r.ts : null })),
    firstAt: firstAt || null,
    lastAt: lastAt || null,
    state: 'new',
  }
}

/**
 * 规则 v1 挖掘。窗口裁剪责任在上游（--window 已裁 entry 流；mine 只做规则判定）——
 * opts.window 只随行记录口径，不再二次裁窗。
 *
 * @param {object[]} records TaskRecord[]（trace-project.mjs 产物）
 * @param {{window?: {from?: string, to?: string, days?: number}, now?: string, existingPatterns?: string[], attribution?: {items?: object[]}|null}} [opts]
 *   now = ISO 时刻（新鲜度基准；缺省/不可解析 ⇒ 新鲜度落下限）
 *   existingPatterns = **调用方注入**的"已被既有技能/工作流覆盖的工具模式"指纹集合（OPP-8 用）。
 *   为什么是注入面：内核是纯函数、不读盘——"目录里有什么"只有调用方知道（store 读盘后注入，
 *   见 server/evolution-store.mjs#inferExistingPatterns）；缺省空集合 ⇒ "全都未覆盖"⇒ 多产候选
 *   （**保守方向**：多给候选让用户判断 ≠ 漏给真机会）。
 * @returns {object[]} 候选行（确定性排序：score 降序 → id 升序；空输入=[]）
 */
export function mineCandidates(records, { window: win = {}, now = '', existingPatterns = [], attribution = null } = {}) {
  const list = Array.isArray(records) ? records : []
  const windowDays = num(win?.days) || 30
  const nowMs = Date.parse(String(now || ''))
  const ctx = {
    window: { from: win?.from || null, to: win?.to || null, days: windowDays },
    windowDays,
    nowMs,
  }
  const out = []

  // ── OPP-1 工具失败热点（subject=工具名；**错误率显著高于基线**，见 THRESHOLDS 注释）──────
  // 分子（errors）与分母（callsByTool）必须来自**同一批记录**：只计两侧都有的会话，
  // 否则旧版投影（无 callsByTool）会只贡献分子 ⇒ 基线被低估、错误率被抬高 ⇒ 造假热点。
  const failAgg = new Map()
  const callAgg = new Map()
  let callsKnown = 0
  for (const r of list) {
    const cbt = Array.isArray(r?.tools?.callsByTool) ? r.tools.callsByTool : null
    if (!cbt) continue
    callsKnown++
    for (const c of cbt) {
      const tool = String(c?.tool || '')
      if (!tool) continue
      callAgg.set(tool, (callAgg.get(tool) || 0) + num(c.count))
    }
    for (const f of r?.tools?.errors || []) {
      const tool = String(f?.tool || '')
      if (!tool) continue
      // ★ EVO-08（2026-10-17）：分子要**工具故障**，不是"全部 is_error"。
      //   `is_error` 是面向模型的语义（Bash = 退出码非零），其中含大量**正常答案**
      //   （grep 无匹配 / diff 有差异 / 故意跑失败的测试）⇒ 直接当分子会系统性抬高错误率。
      //   投影期已按 tool_result 内容分流为 `toolFault` / `commandNonZero`（trace-project.mjs
      //   classifyToolFailure）。旧投影没有细分子段 ⇒ **退回 count**（保守：宁可暂时沿用旧口径，
      //   也不把有失败的会话静默当成零失败）。
      const cur = failAgg.get(tool) || { tool, count: 0, sessions: 0, refs: [], firstAt: null, lastAt: null }
      cur.count += num(f.toolFault ?? f.count)
      cur.sessions += 1
      if (f.firstRef && cur.refs.length < EVIDENCE_CAP) cur.refs.push(f.firstRef)
      cur.firstAt = earlierOf(cur.firstAt, f?.firstRef?.ts)
      cur.lastAt = laterOf(cur.lastAt, f?.firstRef?.ts)
      failAgg.set(tool, cur)
    }
  }
  {
    const th = THRESHOLDS['OPP-1']
    let totalCalls = 0
    for (const v of callAgg.values()) totalCalls += v
    let totalErrs = 0
    for (const a of failAgg.values()) totalErrs += a.count
    const globalRate = totalCalls > 0 ? totalErrs / totalCalls : 0
    for (const a of failAgg.values()) {
      if (a.count < th.minFailures) continue
      const n = callAgg.get(a.tool) || 0
      if (n <= 0) continue // 无分母 ⇒ 算不出率：不猜（宁可漏，不可造假热点）
      const errRate = a.count / n
      // 绝对门（不做相对基线判定，理由见 THRESHOLDS 注释的两次实测负结果）
      const needRate = th.minErrorRate
      if (errRate < needRate) continue
      out.push(buildCandidate('OPP-1', a.tool, ctx, {
        count: a.count,
        // 强度 = 错误率相对**命中阈值**的倍数（恰在阈值 = 1 ⇒ list 档；越显著才顶到 pin，
        // 与既有 freqRatio 语义一致——阈值处不 pin）
        freqRatio: errRate / needRate,
        refs: a.refs,
        firstAt: a.firstAt,
        lastAt: a.lastAt,
        metrics: {
          sessions: a.sessions,
          calls: n,
          errRate: Number(errRate.toFixed(4)),
          // 基线只作**展示**（"是基线的 N 倍"），不参与判定
          baselineRate: Number(globalRate.toFixed(4)),
          needRate: Number(needRate.toFixed(4)),
          callsKnownSessions: callsKnown,
          totalSessions: list.length,
          // ★ 2026-10-14：倍数在**内核**算好（此前只算给 advice 插值用）—— 前端"事实行"要用它，
          //   而前端自己再算一遍必然与内核漂移（同一件事两处实现 = 漂移源）。分母不可用 ⇒ null
          //   （前端据此省略该句，而不是显示 "Infinity 倍"）。
          multiple: globalRate > 0 ? Number((errRate / globalRate).toFixed(1)) : null,
        },
      }))
    }
  }

  // ── OPP-2 技能加载后接着纠错（subject=技能 id；≤3 轮内、≥2 次）─────────────
  // 命中口径 = **不同纠正次数**：同一纠正若落在同技能多次加载的窗口内只算 1 次
  // （先按 (会话 × 技能) 归集纠正 seq，去重后再并入全局计数）。
  const skillAgg = new Map()
  for (const r of list) {
    const loads = Array.isArray(r?.skills?.loads) ? r.skills.loads : []
    if (!loads.length) continue
    const turnSeq = (Array.isArray(r?.turnSeq) ? r.turnSeq : []).map(seqOf).filter((v) => v !== null)
    if (!turnSeq.length) continue // 无轮界 ⇒ 轮距不可算，跳过（不猜）
    const corrections = Array.isArray(r?.corrections) ? r.corrections : []
    const hits = new Map() // skillId → Map(cSeq → turnRef)
    for (const load of loads) {
      const loadSeq = seqOf(load?.seq)
      const skillId = String(load?.id || '')
      if (loadSeq === null || !skillId) continue
      const loadTurn = turnIndexOf(loadSeq, turnSeq)
      for (const c of corrections) {
        const cSeq = seqOf(c?.turnRef?.seq)
        if (cSeq === null || cSeq <= loadSeq) continue // 纠正必须发生在加载之后
        if (turnIndexOf(cSeq, turnSeq) - loadTurn > THRESHOLDS['OPP-2'].withinTurns) continue
        if (!hits.has(skillId)) hits.set(skillId, new Map())
        const m = hits.get(skillId)
        if (!m.has(cSeq)) m.set(cSeq, c.turnRef)
      }
    }
    for (const [skillId, m] of hits) {
      const cur = skillAgg.get(skillId) || { id: skillId, count: 0, refs: [], firstAt: null, lastAt: null }
      for (const ref of m.values()) {
        cur.count++
        if (ref && cur.refs.length < EVIDENCE_CAP) cur.refs.push(ref)
        cur.firstAt = earlierOf(cur.firstAt, ref?.ts)
        cur.lastAt = laterOf(cur.lastAt, ref?.ts)
      }
      skillAgg.set(skillId, cur)
    }
  }
  for (const a of skillAgg.values()) {
    if (a.count < THRESHOLDS['OPP-2'].minHits) continue
    out.push(buildCandidate('OPP-2', a.id, ctx, {
      count: a.count,
      freqRatio: a.count / THRESHOLDS['OPP-2'].minHits,
      refs: a.refs,
      firstAt: a.firstAt,
      lastAt: a.lastAt,
      metrics: { count: a.count },
    }))
  }

  // ── OPP-3 同题重试（subject=会话 id；Jaccard ≥0.8 的相邻对 ≥2）─────────────
  for (const r of list) {
    const pairs = Array.isArray(r?.nearRepeatPairs) ? r.nearRepeatPairs : []
    const qual = pairs.filter((p) => Number.isFinite(p?.similarity) && p.similarity >= THRESHOLDS['OPP-3'].similarity)
    if (qual.length < THRESHOLDS['OPP-3'].minPairs) continue
    const sid = String(r?.sessionId || '')
    if (!sid) continue
    const refs = qual.slice(0, EVIDENCE_CAP).map((p) => ({ sessionId: sid, seq: seqOf(p.secondSeq) ?? seqOf(p.firstSeq), ts: null }))
    out.push(buildCandidate('OPP-3', sid, ctx, {
      count: qual.length,
      freqRatio: qual.length / THRESHOLDS['OPP-3'].minPairs,
      refs,
      firstAt: typeof r.startedAt === 'string' && r.startedAt ? r.startedAt : null,
      lastAt: typeof r.endedAt === 'string' && r.endedAt ? r.endedAt : null,
      metrics: { maxSimilarity: Number(Math.max(...qual.map((p) => p.similarity)).toFixed(4)) },
    }))
  }

  // ── OPP-4 守卫自愈热点（subject=会话 id；stallHeals≥3 或 errorStreak≥5）────
  for (const r of list) {
    const g = r?.guard
    if (!g) continue
    const stallHeals = num(g.stallHeals)
    const errorStreakMax = num(g.errorStreakMax)
    const triggered = stallHeals >= THRESHOLDS['OPP-4'].minStallHeals || errorStreakMax >= THRESHOLDS['OPP-4'].minErrorStreak
    if (!triggered) continue
    const sid = String(r?.sessionId || '')
    if (!sid) continue
    // 强度 = 两信号按各自阈值归一后取大（满足其一即 ≥1）
    const freqRatio = Math.max(stallHeals / THRESHOLDS['OPP-4'].minStallHeals, errorStreakMax / THRESHOLDS['OPP-4'].minErrorStreak)
    const refs = g.firstRef ? [g.firstRef] : []
    out.push(buildCandidate('OPP-4', sid, ctx, {
      count: stallHeals + errorStreakMax,
      freqRatio,
      refs,
      firstAt: earlierOf(g?.firstRef?.ts, r.startedAt),
      lastAt: laterOf(g?.firstRef?.ts, r.endedAt),
      metrics: { stallHeals, errorStreakMax, worstLevel: num(g.worstLevel) },
    }))
  }

  // ── OPP-7 能力缺口（**跨会话复现**的工作组合 + 零技能加载）──────────────────
  // ★ 与既有四条反向：本条是**机会信号**（该补能力），故判据要"零加载**可判定**"才产——
  //   老投影/手工记录无 skills 面 ⇒ 跳过不猜（否则常态失败会全变成"建议新建技能"＝创建噪声）。
  //
  // ★★ 2026-10-14 **判据重做**（用户实测反馈，两条都成立）：
  //   ① 原 key 是 `${会话id}:${工具指纹}` ⇒ subject 是 `会话id:哈希` 这样的**机器码**，
  //      用户在面板上看到的候选"完全无法了解具体的能力缺口是什么、哪里失败了"；
  //   ② 原判据只在**单个会话内**累加失败次数 ⇒ 一次偶发事故就能凑够 5 次被当成"能力缺失"。
  //      用户的质疑（原话）："5次7次复现的问题到底能否判断为能力缺失，是否需要多会话的评判机制"。
  //   ⇒ 改为：**按"反复失败的工具集合"聚合**（= 缺的那个能力），并要求 **≥2 个不同会话**。
  //   这样 subject 天然可读（`Grep、Read`），且"跨会话复现"才配叫能力缺失（单会话重复失败可能只是
  //   那一次任务踩了坑）。判据门槛见 THRESHOLDS['OPP-7']（minHits / minSessions / minPerToolFailure）。
  {
    const th = THRESHOLDS['OPP-7']
    const byTools = new Map()
    for (const r of list) {
      const sid = typeof r.sessionId === 'string' ? r.sessionId : ''
      if (!sid) continue
      const loaded = r?.skills?.loaded
      if (!Array.isArray(loaded)) continue               // 技能面缺失 ⇒ "零加载"不可判定 ⇒ 不猜
      if (loaded.length) continue                        // 有技能加载 ⇒ 不是"能力缺口"
      const errs = Array.isArray(r?.tools?.errors) ? r.tools.errors : []
      const hits = errs.filter((e) => num(e?.count) >= th.minPerToolFailure)
      if (!hits.length) continue
      const tools = [...new Set(hits.map((e) => String(e?.tool || '')).filter(Boolean))].sort()
      if (!tools.length) continue
      // key = **可读的能力标识**（反复失败的工具集合）；同一集合跨会话复现 ⇒ 同一条候选
      const key = tools.join('、')
      const prev = byTools.get(key)
      const total = hits.reduce((n, e) => n + num(e.count), 0)
      const tss = hits.map((e) => e.firstRef?.ts).filter(Boolean).sort()
      const sessions = prev?.sessions ? new Set(prev.sessions) : new Set()
      sessions.add(sid)
      const refs = [...(prev?.refs || []), ...hits.map((e) => e.firstRef).filter(Boolean)].slice(0, EVIDENCE_CAP)
      byTools.set(key, {
        key, tools, sessions, refs,
        count: (prev?.count || 0) + total,
        firstAt: earlierOf(prev?.firstAt, tss[0]),
        lastAt: laterOf(prev?.lastAt, tss.slice(-1)[0]),
        // 最近一次出现在哪个会话（事实行里给"最近一次"的落点，比给一堆会话 id 有用）
        lastSession: laterOf(prev?.lastAt, tss.slice(-1)[0]) === (prev?.lastAt ?? null) ? prev?.lastSession : sid,
      })
    }
    for (const a of byTools.values()) {
      if (a.count < th.minHits) continue
      if (a.sessions.size < th.minSessions) continue     // ★ 跨会话复现门（治"一次事故被当成能力缺失"）
      out.push(buildCandidate('OPP-7', a.key, ctx, {
        count: a.count, freqRatio: a.count / th.minHits, refs: a.refs,
        firstAt: a.firstAt, lastAt: a.lastAt,
        metrics: {
          failures: a.count, skillLoaded: 0,
          sessions: a.sessions.size,                       // 跨了几个会话（事实行要用它证"复现"）
          tools: a.tools,
          sessionId: a.lastSession ?? null,
        },
      }))
    }
  }

  // ── OPP-8 熟练模式结晶（跨会话同工具组合 ≥3 且未被既有件覆盖）──────────────
  // ★ 不再增设独立的"流程固化"规则（规格预留的 OPP-9）：其判据与本分支**完全不可区分**
  //   （同为指纹跨会话 + 未被既有件覆盖）⇒ 同一模式会产两条一模一样的候选。两个方向改由
  //   `adviceOf` 的 actions 数组表达（技能优先），候选仍**只有这一条**。
  //   TaskRecord 只有 tools.sequence 这一个指纹（单一实现，不引入第二套指纹算法）。
  const patternAgg = new Map()
  for (const r of list) {
    const key = typeof r?.tools?.sequence === 'string' ? r.tools.sequence : ''
    if (!key) continue                                   // 老投影无 sequence ⇒ 跳过（不猜）
    const sid = String(r?.sessionId || '')
    const cur = patternAgg.get(key) || {
      key, sessions: new Set(), refs: [], firstAt: null, lastAt: null,
      callsTotal: 0, sessionsCounted: 0,
    }
    if (sid) cur.sessions.add(sid)
    if (cur.refs.length < EVIDENCE_CAP && sid) cur.refs.push({ sessionId: sid, seq: null, ts: typeof r?.startedAt === 'string' ? r.startedAt : null })
    cur.firstAt = earlierOf(cur.firstAt, r?.startedAt)
    cur.lastAt = laterOf(cur.lastAt, r?.endedAt)
    cur.callsTotal += num(r?.tools?.calls)
    cur.sessionsCounted += 1
    patternAgg.set(key, cur)
  }
  const known = new Set(Array.isArray(existingPatterns) ? existingPatterns : [])
  // 显著性门的分母 = 本窗口内**有会话 id** 的记录数（= 活跃会话数）
  const activeSessions = list.filter((r) => typeof r?.sessionId === 'string' && r.sessionId).length
  const th8 = THRESHOLDS['OPP-8']
  for (const a of patternAgg.values()) {
    if (a.sessions.size < th8.crossSessions) continue
    if (known.has(a.key)) continue                       // 已被既有技能/工作流覆盖 ⇒ 不产候选
    // 体量门（2026-10-14）：模式要够"厚"，否则是随手用的工具、不是可固化的编排
    const distinctTools = new Set(a.key.split('>')).size
    if (distinctTools < th8.minDistinctTools) continue
    const avgCalls = a.sessionsCounted ? a.callsTotal / a.sessionsCounted : 0
    if (avgCalls < th8.minCalls) continue
    // ★ 显著性门：命中会话占活跃会话 > maxUbiquity ⇒ 这是"你的日常"，不是值得固化的特殊模式
    const ubiquity = activeSessions > 0 ? a.sessions.size / activeSessions : 0
    if (ubiquity > th8.maxUbiquity) continue
    out.push(buildCandidate('OPP-8', a.key, ctx, {
      count: a.sessions.size,
      freqRatio: a.sessions.size / th8.crossSessions,
      refs: a.refs, firstAt: a.firstAt, lastAt: a.lastAt,
      // 证据齐全（2026-10-14）：建议文案据此插值 ⇒ 不再"每条候选表述雷同"（用户实测反馈第二点）
      metrics: {
        sessions: a.sessions.size, distinctTools,
        avgCalls: Number(avgCalls.toFixed(1)),
        ubiquity: Number(ubiquity.toFixed(3)), activeSessions,
      },
    }))
  }

  // ── OPP-11 上下文预算压力（2026-10-19，**非建件**规则）────────────────────────
  // 判"每轮注入的提示词过大"——技能清单/知识库/经验/工具 schema 都在里面。它的正确处置是
  // **配置面**（精简/关闭注入源），不是再建一个技能；加技能只会让这个数字更大。
  // ★ 只读 TaskRecord 既有字段：`inject.totalBytes`（末条 inject_snapshot 的当前态）与 `bySource`。
  //   `inject` 为 null（老投影 / 无台账会话）⇒ **跳过**，绝不按 0 处理（0 会让"没测到"变成"很健康"）。
  // ★ 按**主导注入源**聚合（subject = 源名）：这样建议能指向"是技能清单在吃字节"还是"知识库在吃"，
  //   而不是给一条"上下文太大"的空话。
  const ctxAgg = new Map()
  for (const r of list) {
    const total = num(r?.inject?.totalBytes)
    if (!total) continue                                   // 没有实测 = 不参与（不臆造）
    if (num(r?.turns) < THRESHOLDS['OPP-11'].minTurns) continue
    if (total < THRESHOLDS['OPP-11'].minTotalBytes) continue
    const by = r?.inject?.bySource && typeof r.inject.bySource === 'object' ? r.inject.bySource : {}
    // 主导源 = 字节最大者（并列时按名字定序 ⇒ 同输入必然同输出，候选 id 才稳定）
    let topSource = ''
    let topBytes = -1
    for (const [k, v] of Object.entries(by).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const n = num(v)
      if (n > topBytes) { topBytes = n; topSource = String(k) }
    }
    const subject = topSource || 'prompt'
    const sid = String(r?.sessionId || '')
    const cur = ctxAgg.get(subject) || { subject, sessions: new Set(), refs: [], bytesSum: 0, n: 0, firstAt: null, lastAt: null }
    if (sid) cur.sessions.add(sid)
    if (cur.refs.length < EVIDENCE_CAP && sid) cur.refs.push({ sessionId: sid, seq: null, ts: typeof r?.startedAt === 'string' ? r.startedAt : null })
    cur.bytesSum += total
    cur.n += 1
    cur.firstAt = earlierOf(cur.firstAt, r?.startedAt)
    cur.lastAt = laterOf(cur.lastAt, r?.endedAt)
    ctxAgg.set(subject, cur)
  }
  const th11 = THRESHOLDS['OPP-11']
  for (const a of ctxAgg.values()) {
    if (a.sessions.size < th11.minSessions) continue        // 跨会话复现（同 OPP-7 纪律）
    const avgBytes = a.n ? Math.round(a.bytesSum / a.n) : 0
    out.push(buildCandidate('OPP-11', a.subject, ctx, {
      count: a.sessions.size,
      // 强度 = 平均注入字节相对门槛的倍数（恰在门槛 = 1 ⇒ list 档，与 OPP-1 的 freqRatio 语义一致）
      freqRatio: avgBytes / th11.minTotalBytes,
      refs: a.refs, firstAt: a.firstAt, lastAt: a.lastAt,
      metrics: {
        sessions: a.sessions.size,
        avgBytes,
        // kb 由**内核**算好（前端只读不派生 —— 同一算法在两边各写一遍必然漂移，
        // 而四舍五入方式一旦不同，界面显示的数字就会与 metrics 对不上）
        kb: Math.round(avgBytes / 1024),
        topSource: a.subject,
        sourceCount: a.n,
      },
    }))
  }

  // ── OPP-12 模型维度（2026-10-19，第二条非建件规则）──────────────────────────
  // 判"某个模型下的工具调用是不是持续出错"—— 处置是**换模型/查用法/查环境**，不是建件。
  // ★ 数据面来自 TaskRecord.models（本轮新加的分段事实）：tool_use 按条目自己的 model 归桶、
  //   tool_result 按 tool_use_id 回指 ⇒ 分子分母同源，不会各自漂移。
  // ★ 排除 'unknown'：那是"条目缺 model 字段"的占位，不是可选模型；对它出"换一个模型"的建议
  //   毫无意义（真正的缺口是采集面，属于另一类问题，不该混进这条规则）。
  // ★ 绝对门 + 跨会话门（不加相对倍数门 —— 理由见 THRESHOLDS['OPP-12'] 的注释）。
  const modelAgg = new Map()
  for (const r of list) {
    const rows = Array.isArray(r?.models) ? r.models : []
    const sid = String(r?.sessionId || '')
    for (const row of rows) {
      const model = typeof row?.model === 'string' ? row.model : ''
      if (!model || model === 'unknown') continue
      const c = num(row.calls)
      const e = num(row.errors)
      if (!c) continue                                    // 没有调用就没有可比的分母
      const cur = modelAgg.get(model) || { model, calls: 0, errors: 0, sessions: new Set(), refs: [], firstAt: null, lastAt: null }
      cur.calls += c
      cur.errors += e
      if (sid) cur.sessions.add(sid)
      if (cur.refs.length < EVIDENCE_CAP && sid) cur.refs.push({ sessionId: sid, seq: null, ts: typeof r?.startedAt === 'string' ? r.startedAt : null })
      cur.firstAt = earlierOf(cur.firstAt, r?.startedAt)
      cur.lastAt = laterOf(cur.lastAt, r?.endedAt)
      modelAgg.set(model, cur)
    }
  }
  // 全局合计（含全部模型）—— 只用于给建议区算"是该模型的几倍"，**不参与判定**
  let allCalls = 0
  let allErrors = 0
  for (const a of modelAgg.values()) { allCalls += a.calls; allErrors += a.errors }
  const th12 = THRESHOLDS['OPP-12']
  for (const a of modelAgg.values()) {
    if (a.sessions.size < th12.minSessions) continue      // 跨会话复现（同 OPP-7/OPP-11 纪律）
    if (a.calls < th12.minCalls) continue                 // 最小样本（40 次调用以下不判错误率）
    const errRate = a.errors / a.calls
    if (!(errRate >= th12.minErrorRate)) continue         // 绝对门（fail-closed：算不出就不出）
    // leave-one-out 基线：其余模型的错误率（分母为 0 ⇒ 不给倍数，除零会造 Infinity）
    const restCalls = allCalls - a.calls
    const restErrors = allErrors - a.errors
    const baselineRate = restCalls > 0 ? restErrors / restCalls : null
    out.push(buildCandidate('OPP-12', a.model, ctx, {
      count: a.sessions.size,
      // 强度 = 错误率相对门槛的倍数（恰在门槛 = 1 ⇒ list 档，与 OPP-1 同语义）
      freqRatio: errRate / th12.minErrorRate,
      refs: a.refs, firstAt: a.firstAt, lastAt: a.lastAt,
      metrics: {
        calls: a.calls,
        errors: a.errors,
        errRate: Number(errRate.toFixed(4)),
        sessions: a.sessions.size,
        // 基线只在**分母可用**时给（restCalls=0 或 restErrors 全为 0 ⇒ 不给倍数：
        // 除零会造 Infinity，而"其余模型零错误"时倍数无意义 —— 事实行会换模板，见 factKeyOf）
        ...(baselineRate !== null && baselineRate > 0
          ? { baselineRate: Number(baselineRate.toFixed(4)), multiple: Number((errRate / baselineRate).toFixed(1)) }
          : {}),
      },
    }))
  }

  // ── OPP-13 修复后复发（P3，2026-10-27）──────────────────────────────────────
  // 口径：归因视图里 `recurring === true` 的指纹（修完之后 7 天内又出现），
  //       `immediate === true`（48h 内再现）单列进 metrics，供界面与 healer 决定"是否停自动修"。
  // 为什么走**注入面**（attribution 参数）：内核是纯函数、不读盘；归因要扫 journal/日志/转录，
  //   只有调用方（server/evolution-store 那一层）能给它。缺省 null ⇒ 该规则不出候选（不是"没问题"）。
  {
    const th13 = THRESHOLDS['OPP-13']
    const items = Array.isArray(attribution?.items) ? attribution.items : []
    for (const it of items) {
      if (!it || it.recurring !== true) continue
      const origins = Array.isArray(it.origin) ? it.origin : []
      if (origins.length < th13.minRecurrences) continue   // fail-closed：没有可指认的再现事件就不出
      const fp = String(it.fp || '')
      if (!fp) continue
      // 复发强度 = 再现次数 / 门槛（恰在门槛 = 1 ⇒ list 档，与其它规则同语义）
      const freqRatio = (origins.length) / th13.minRecurrences
      out.push(buildCandidate('OPP-13', fp, ctx, {
        count: origins.length,
        freqRatio,
        // 证据：取**再现**事件的会话（那才是"没治好"的现场），ref 形如 `<sessionId>#<seq>`
        refs: origins.slice(0, EVIDENCE_CAP).map((o) => {
          const ref = typeof o?.ref === 'string' ? o.ref : ''
          const hash = ref.indexOf('#')
          return {
            sessionId: hash > 0 ? ref.slice(0, hash) : (ref || null),
            seq: hash > 0 ? Number(ref.slice(hash + 1)) : null,
            ts: Number.isFinite(Number(o?.at)) ? new Date(Number(o.at)).toISOString() : null,
          }
        }),
        firstAt: it.firstAt || null,
        lastAt: it.lastAt || null,
        metrics: {
          recurrences: origins.length,
          originCount: num(it.originCount),
          fixes: Array.isArray(it.fixes) ? it.fixes.length : 0,
          immediate: it.immediate === true,
          sources: Array.isArray(it.sources) ? it.sources : [],
        },
      }))
    }
  }

  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return out
}

/**
 * 候选行归并（唯一真源；读侧与 store 的 compact 同用此口径）：
 * append-only JSONL 行 → 按 id **字段级**合并（后行覆盖先行；state 行只动 state/ts），
 * 坏行跳过并计数（空白行=格式噪声，不计坏行）。排序确定：score 降序 → id 升序。
 *
 * @param {(string|object)[]} lines
 * @returns {{candidates: object[], bad: number}}
 */
export function mergeCandidateLines(lines) {
  const merged = new Map()
  let bad = 0
  for (const raw of Array.isArray(lines) ? lines : []) {
    let row = raw
    if (typeof raw === 'string') {
      const t = raw.trim()
      if (!t) continue
      try { row = JSON.parse(t) } catch { row = null }
    }
    if (!isValidCandidateRow(row)) { bad++; continue }
    merged.set(row.id, { ...(merged.get(row.id) || {}), ...row })
  }
  const candidates = [...merged.values()]
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || String(a.id).localeCompare(String(b.id)))
  return { candidates, bad }
}

function isValidCandidateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.id !== 'string' || !row.id) return false
  if (row.state !== undefined && !CANDIDATE_STATES.includes(row.state)) return false
  return true
}

/**
 * 扫描落盘计划（brief D8）：新 id ⇒ 整行落（state='new'）；已知 id ⇒ **继承最新 state**
 * （dismissed/actioned 不复活）、仅当 count/score 有变**或旧行缺 advice**才落（防 JSONL 膨胀；
 * advice 补齐见下方 adviceMissing 注释）。
 *
 * @param {object[]} mined mineCandidates 结果
 * @param {Map<string,object>|Record<string,object>} latestById mergeCandidateLines 结果按 id 索引
 * @returns {object[]} 待 append 的整行
 */
export function planScanAppends(mined, latestById) {
  const get = latestById instanceof Map ? (id) => latestById.get(id) : (id) => (latestById || {})[id]
  const rows = []
  const minedIds = new Set((Array.isArray(mined) ? mined : []).map((c) => c.id))

  // ★★ 2026-10-18 EVO-09 修复：**退休"按旧判据产出、本轮不再产出"的存量候选**。
  //
  // 原状：本函数只遍历 `mined`（本轮产出的），对"已存在但本轮不再命中"的行**没有任何分支**
  //   ⇒ 判据重做后（如 OPP-7 从"会话指纹"改成"工具集合"），旧候选**永久滞留**为 new，
  //   既不会被清理也不会再产出，纯粹是噪声。
  //   实测代价：2026-10-17 处置前 85 个待处置候选里 **64 个**属此类，需人工逐条 dismiss。
  //
  // 判据为什么用 `rv`（判据语义版本）而不是"时间窗"：
  //   旧孤儿候选的 lastAt 集中在 10-06~10-16，窗口放宽到 30 天也**不会自然到期** ——
  //   "判据变了"与"窗口波动暂时不命中"是两件事，只有前者该退休。
  //   `rv` 正是用来区分它们的：rv === 当前版本 ⇒ 是同类判据下的正常波动，**不动**；
  //   rv < 当前版本 ⇒ 判据已变，退休。
  //
  // ★ 安全性：只动 state 仍为 'new' 的行。用户已 dismissed/actioned 的不碰（尊重既有裁决）；
  //   老行没有 rv 字段（v2 及以前）⇒ 视为"旧判据产出"⇒ 一并退休（它们本就是历史遗留）。
  const allPrev = latestById instanceof Map
    ? [...latestById.values()]
    : Object.values(latestById || {})
  let retired = 0
  for (const prev of allPrev) {
    if (!prev || !prev.id) continue
    if (minedIds.has(prev.id)) continue                 // 本轮仍命中 ⇒ 交给正常流程
    const state = CANDIDATE_STATES.includes(prev.state) ? prev.state : 'new'
    if (state !== 'new') continue                       // 已裁决过 ⇒ 不碰
    const rv = prev.rv === undefined ? 0 : num(prev.rv) // 无 rv = v2 及以前的历史行
    if (rv >= currentRuleVersion()) continue            // 同版本内"暂时不命中"= 正常波动
    rows.push({
      v: MINE_V,
      rv: currentRuleVersion(),
      id: prev.id,
      ruleId: prev.ruleId,
      kind: prev.kind,
      subject: prev.subject,
      count: prev.count,
      score: prev.score,
      state: 'dismissed',
      // 理由写清"为什么退休"，便于事后审计"这条是被判据升级清掉的，不是用户否掉的"
      retireReason: `superseded-rule: rv ${rv} → ${currentRuleVersion()}`,
    })
    retired += 1
  }

  for (const c of Array.isArray(mined) ? mined : []) {
    const prev = get(c.id)
    if (!prev) { rows.push({ ...c, rv: c.rv ?? currentRuleVersion() }); continue }
    // ★ A1：旧行缺 advice（A1 之前的存量行）⇒ 补落一次，否则界面永远不显示建议区。
    //   只补一次（补后 prev.advice 存在，不再满足本条件），不引起 JSONL 膨胀。
    const adviceMissing = !prev.advice && c.advice
    // ★★ 2026-10-14 schema 版本门（通用修复，取代"缺什么补什么"的逐个打补丁）：
    //   `prev.v` 是**落盘行**的版本、`c.v` 是**当前代码**的版本 ⇒ 不等即重物化。
    //   为什么需要：JSONL 是 append-only，老行不会自己长出新字段。此前只补 advice 一处，
    //   于是之后两次给 metrics 加字段（OPP-1 的 multiple、OPP-7 的 sessionId/tools）都**沉默地**
    //   对存量行无效 —— 界面缺内容且无任何线索（用户实测报的"会话 <机器码>：— 反复失败 N 次"）。
    //   有了版本门，"改变行形状 ⇒ 升 MINE_V" 就成了唯一需要记得的事（见 MINE_V 的注释）。
    const staleSchema = num(prev.v) !== MINE_V
    if (!adviceMissing && !staleSchema && prev.count === c.count && prev.score === c.score) continue
    const state = CANDIDATE_STATES.includes(prev.state) ? prev.state : 'new'
    rows.push({ ...c, state, rv: c.rv ?? currentRuleVersion() })
  }
  return rows
}
