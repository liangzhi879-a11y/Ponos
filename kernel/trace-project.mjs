// kernel/trace-project.mjs —— 演化环 P0 观测投影器（纯函数）
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md §4.1。
// 输入 = collectTranscriptFiles() 的 entry 流（每 entry 已注入 sessionId/project）；
// 输出 = TaskRecord[]（会话级）+ 窗口级汇总（失败热点/技能命中/纠正率基线数字）。
//
// 纪律：
//  · 纯函数（无 IO；时间由调用方注入）——便于单测与"空集合判红"。
//  · 不伪造：无证据的字段落 null / 'unknown'，不猜测（沿用 readonly.mjs 归属字段纪律）。
//  · 空输入 = 空输出（精确 0 条，不造数据）；聚合排序确定（同值按 id 升序）。
//  · 纠错模式**单一真源** = fidelity.mjs#detectUserCorrection（不另抄一份正则）。
//
// P1 增补字段（additive，v 仍 1；brief docs/superpowers/plans/2026-10-09-p1-opportunity-layer.md D1）：
//  · turnSeq：轮界条目 seq 列表（inject_snapshot 的 seq）——OPP-2 轮距换算用。
//  · skills.loads：每次**成功**加载的 {id,seq,ts}——技能加载发生在哪一轮可回跳。
//  · nearRepeatPairs：相邻真用户文本的 4-gram 相似对 {firstSeq,secondSeq,similarity}
//    ——只落 seq 与分值，**不落文本**（隐私口径）；系统注入不算"用户相邻"。
//  · guard.firstRef：首条 guard_turn 条目 ref——守卫热点证据锚点。
//  · tools.callsByTool：按工具统计**调用**次数（2026-10-10 加，additive）——错误率的分母。
//    为什么必须按工具分：既有的 tools.calls 只有**总数** ⇒ "Bash 失败 215 次"分不清
//    "调 300 次错 215"（真热点）与"调 5000 次错 215"（常态噪声）。P1 上线首日实测正是
//    后者被判成 0.996 直接 pin 档（与 spec §6"自举期候选应近零"相反）⇒ 判据需要错误率。
//    投影只提供**事实**（调用数），阈值与判定仍在 opportunity-mine（规则唯一真源）。
//  · tools.sequence：该会话工具名**升序去重** join('>')（A2/OPP-8，additive）——
//    "熟练模式"的指纹。投影只出**事实**（用了哪套工具），"是否已固化"的判定在挖掘期
//    （opts.existingPatterns 注入，见 opportunity-mine.mjs）。
import { detectUserCorrection } from './fidelity.mjs'
// 自愈阶梯级名 → 序数的**单一真源**（L0–L4；不另抄一份映射）
import { HEAL_LEVELS } from './heal-ladder.mjs'
// 归一化 + Jaccard 复用 gen-guards 的既有导出（不另抄一份）
import { nrNorm, nrJaccard } from './gen-guards.mjs'
// T4.1（2026-10-20）：token/成本事实——计价与 `/api/usage` 同源（model-prices 三级解析 + cost.mjs）。
// 两者都是纯函数（无 IO、无时钟）；`resolveModelPrices` 读 env 价表属"外部定价输入"，
// 需要严格可复现的调用方（单测）可经 `projectSession({ priceOf })` 注入固定价。
import { resolveModelPrices } from './model-prices.mjs'
import { costOf } from './cost.mjs'

/** 四位小数（成本口径与 readonly.mjs / cost.mjs 一致；避免浮点尾数进 JSON） */
const round4 = (n) => Number((Number(n) || 0).toFixed(4))

/**
 * TaskRecord schema 版本。
 * v1 → v2（2026-10-20，T4.1）：新增 `usage`（token/成本，缺证据 ⇒ **null**）与
 *   `compact:{count}`（压缩次数——一次压缩可能付 3–8 次模型调用，是历史面最大支出，
 *   演化必须看得见）。字段形状变了 ⇒ 按规矩 +1（同 `opportunity-mine.mjs#MINE_V` 的纪律：
 *   "任何改动候选行字段形状的提交都必须同时 +1"）。
 * v2 → v3（2026-10-19，OPP-10）：新增 `models:[{model,calls,errors}]`（按模型分段的调用/错误，
 *   排序确定）。为什么必须加：`usage.byModel` 只有 token/成本，**答不了**"这个模型是不是更容易
 *   把活干错"——那条判据要分母/分子（该模型下的工具调用数与失败数），而这两者在 transcript 里
 *   本来就可 join 得到（tool_use 带 model，tool_result 按 id 回指）。**这是字段形状变更** ⇒ +1。
 *   缺 model 的条目落 'unknown'（不造、不猜）。
 */
export const TASK_RECORD_V = 3

// 近重复对（OPP-3 投影期口径）：字符 4-gram；两侧归一化长度均 ≥ NR4_MIN_CHARS 才计算
// （短消息 gram 集过小会虚假高相似——如两条各 4 字的消息仅 1 个 gram，相同即 1.0）。
// 阈值（≥0.8）判定在 opportunity-mine（规则唯一真源），此处只算分值。
const NR4_K = 4
const NR4_MIN_CHARS = 8

function kGramsOf(s, k) {
  const set = new Set()
  for (let i = 0; i <= s.length - k; i++) set.add(s.slice(i, i + k))
  return set
}

/** 相邻真用户文本相似度（0..1；任一侧过短 ⇒ 0，不猜） */
function nearRepeatSimilarity(normA, normB) {
  if (normA.length < NR4_MIN_CHARS || normB.length < NR4_MIN_CHARS) return 0
  return Number(nrJaccard(kGramsOf(normA, NR4_K), kGramsOf(normB, NR4_K)).toFixed(4))
}

// transcript 里"引擎发起的单行注入"与真用户发言同为 user 条目（appendSystemUser 实现），
// 按展示前缀剔除——它们是系统注入，不是"用户纠正"。同族先例：server/transcript.mjs 展示过滤。
const SYSTEM_INJECT_PREFIXES = ['【系统】', '【提示】', '【主 Agent 消息】', '<compacted-summary>']

// 预留的取消证据 kind（现行写侧无此 kind；出现即认 aborted，不伪造"一定没有"）。
const ABORT_KINDS = new Set(['abort', 'aborted', 'cancel', 'cancelled'])

const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const tsOf = (e) => (typeof e?.timestamp === 'string' ? e.timestamp : '')
const isMeta = (e, kind) => e?.type === 'meta' && String(e.kind || '') === kind
const blocksOf = (e) => (Array.isArray(e?.message?.content) ? e.message.content : [])
const refOf = (e, sessionId) => ({ sessionId, seq: e?.seq ?? null, ts: tsOf(e) })

/** 失败聚合的空形状（sessions 字段只在窗口汇总层加，记录层不带） */
function freshFail() { return { tool: '', count: 0, commandNonZero: 0, toolFault: 0, firstRef: null } }

/**
 * tool_result 的失败类别（2026-10-17，EVO-08 修复）。
 *
 * ★ 为什么必须有这个分类：`is_error` 是**面向模型**的语义（"这条命令没成功"），
 *   而 OPP-1「工具失败热点」问的是**工具本身是否反复出问题**——两者不是一回事。
 *   Bash 的 is_error 定义是"退出码 ≠ 0"（`kernel/tools.mjs:146`），于是
 *   `grep` 无匹配（exit 1）、`diff` 有差异、`test` 不成立、**故意跑失败的测试** 全被算成工具故障
 *   ⇒ OPP-1 的错误率系统性虚高，产出假热点、淹没真问题（台账 EVO-08）。
 *
 * ★ 判别依据必须确定性、纯函数：Bash 的失败内容由本仓自己生成（`kernel/tools.mjs:143-146`）：
 *   · 命令非零  → `退出码 <N>\n…`      （Bash 前台，退出码可非零）
 *   · 命令超时  → `命令超时（<ms>ms）`  （tools.mjs 超时路径 / stream-runtime.withToolDeadline）
 *   · 启动失败  → `命令启动失败：…`
 *   只有第一种属"命令跑完了、答案是非零退出"，后两种才是**工具级异常**。
 *
 * ★ 耦合提醒：本判定依赖 `tools.mjs` 的错误文案前缀。改那条文案**必须**同步改这里
 *   （`kernel-tests/evo08-tool-fault-split.test.mjs` 把两者钉在一起，改一侧即红）。
 *
 * ★ 为什么不改 `tools.mjs` 的 isError：模型侧依赖它判断"命令是否成功"，
 *   为统计好看而改会让模型误判命令结果——那是更严重的破坏（台账 EVO-08 fix 已写明这条边界）。
 *
 * @param {string} tool 工具名
 * @param {unknown} content tool_result 的 content（投影期拿到的是字符串或块数组）
 * @returns {'command-nonzero'|'tool-fault'}
 */
export function classifyToolFailure(tool, content) {
  const name = String(tool || '')
  if (name !== 'Bash') return 'tool-fault'   // 其他工具没有"正常非零退出"这一说
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b === 'string' ? b : String(b?.text ?? ''))).join('\n')
      : ''
  // 只认**开头**的退出码行：Bash 前台结果恒以 `退出码 N` 起头（tools.mjs:143-146）。
  // 用 `/^\s*退出码\s+\d+/` 而不是全文搜索 —— 免得命令输出里恰好出现"退出码"字样被误分类。
  return /^\s*退出码\s+\d+/.test(text) ? 'command-nonzero' : 'tool-fault'
}

/**
 * 一个会话的 entry 序列 → TaskRecord（v1 schema，字段全部可溯源）。
 * @param {string} sessionId
 * @param {object[]} list 同一会话的 entries（写入顺序）
 */
export function projectSession(sessionId, list, { priceOf = null } = {}) {
  const arr = Array.isArray(list) ? list : []
  const project = String(arr[0]?.project || '')
  const startedAt = tsOf(arr[0]) || null
  const endedAt = tsOf(arr[arr.length - 1]) || null

  // ── 血缘（P-d subtask_meta；缺失 = main）────────────────────────────────────
  const subMeta = arr.find((e) => isMeta(e, 'subtask_meta'))
  const kind = subMeta ? 'subagent' : 'main'
  const parentTaskId = subMeta && typeof subMeta.parentTaskId === 'string' && subMeta.parentTaskId ? subMeta.parentTaskId : null

  // ── mode / model ────────────────────────────────────────────────────────────
  let mode = null
  for (const e of arr) {
    if (!isMeta(e, 'loop_mode')) continue
    const v = e.effective ?? e.value
    if (typeof v === 'string' && v) mode = v
  }
  let model = null
  for (const e of arr) {
    if (e?.type === 'assistant' && e.kind !== 'compaction' && typeof e.message?.model === 'string' && e.message.model) model = e.message.model
  }

  // ── turns：优先"轮末台账条数"（cli 每轮一条 inject_snapshot）；旧会话无台账则退化 = assistant 条目数
  // turnSeq（P1）：轮界条目 seq 列表（升序，与条目写入顺序一致）——OPP-2 轮距换算用。
  let snapshotCount = 0
  let assistantCount = 0
  const turnSeq = []
  for (const e of arr) {
    if (isMeta(e, 'inject_snapshot')) {
      snapshotCount++
      if (Number.isInteger(e.seq)) turnSeq.push(e.seq)
    } else if (e?.type === 'assistant' && e.kind !== 'compaction') assistantCount++
  }
  const turns = snapshotCount > 0 ? snapshotCount : assistantCount

  // ── T3.2（2026-10-20）：本轮生效的治理策略（A/B 分组键）──
  // 真源是 cli 每轮落下的 `meta kind='turn'.activeStrategies`。取**首次**出现的那条即可：
  // 环境变量在一个会话里是静态的（`resolveActiveStrategies` 读 env），故同一会话内各轮一致。
  // 会话没有该字段（旧会话 / chat / 嵌入场景）⇒ null（**不是空数组**：""没测到" ≠ "一条都没开""）。
  let activeStrategies = null
  for (const e of arr) {
    if (!isMeta(e, 'turn')) continue
    if (Array.isArray(e.activeStrategies)) { activeStrategies = e.activeStrategies.map(String); break }
  }

  // ── tools（tool_use/tool_result 按 id join；join 不到落 'unknown'，不伪造名字）──
  const toolNameById = new Map()
  // callsByTool（2026-10-10，additive）：按工具统计调用数 = 错误率的分母（见文件头）。
  const callAgg = new Map()
  // callOrder（2026-10-14，additive）：按**调用顺序**记录工具名 —— OPP-8 的序列指纹来源。
  // 为什么要顺序：`callsByTool` 只有计数，从它得不到"编排结构"；而 OPP-8 判的正是结构。
  const callOrder = []
  // ── models（2026-10-19，additive）：按模型分段的调用/错误事实 —— OPP-10 的判据来源 ──────
  // 为什么必须分段：`usage.byModel`（T4.1）只有 token/成本，答不了"这个模型是不是更容易把活干错"。
  // 判据要的是"该模型下的工具调用数（分母）与其中失败数（分子）"，而两者**本来就在 transcript 里**：
  // tool_use 所在条目自带 `message.model`，tool_result 按 `tool_use_id` 回指到那条 tool_use
  // ⇒ 一次 join 就能把"失败"归到产生它的模型上（不需要额外采集、也不引入第二套指纹）。
  // ★ 缺 model 的条目落 'unknown'（不猜）：老 transcript / 嵌入场景可能没有该字段；
  //   而只统计 tool_use 不统计"纯文本轮"是刻意的 —— 没有工具调用就没有可比的分母。
  const toolModelById = new Map()
  const modelCallAgg = new Map()
  let calls = 0
  for (const e of arr) {
    if (e?.type !== 'assistant' || e.kind === 'compaction') continue
    for (const b of blocksOf(e)) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        calls++
        const name = typeof b.name === 'string' && b.name ? b.name : 'unknown'
        const model = String(e.message?.model || '') || 'unknown'
        toolNameById.set(b.id, name)
        toolModelById.set(b.id, model)
        callAgg.set(name, (callAgg.get(name) || 0) + 1)
        modelCallAgg.set(model, (modelCallAgg.get(model) || 0) + 1)
        callOrder.push(name)
      }
    }
  }
  const errAgg = new Map()
  const modelErrAgg = new Map()
  for (const e of arr) {
    if (e?.type !== 'user') continue
    for (const b of blocksOf(e)) {
      if (b?.type !== 'tool_result' || b.is_error !== true) continue
      const tool = toolNameById.get(b.tool_use_id) || 'unknown'
      const model = toolModelById.get(b.tool_use_id) || 'unknown'
      modelErrAgg.set(model, (modelErrAgg.get(model) || 0) + 1)
      const cur = errAgg.get(tool) || { ...freshFail(), tool }
      cur.count++
      // EVO-08：按类别分流（count 保持"全部 is_error"语义不变，供既有消费方继续用）
      if (classifyToolFailure(tool, b.content) === 'command-nonzero') cur.commandNonZero++
      else cur.toolFault++
      if (!cur.firstRef) cur.firstRef = refOf(e, sessionId)
      errAgg.set(tool, cur)
    }
  }
  const errors = [...errAgg.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
  // 调用数按工具（降序；同值按名升序 —— 与 errors 同款确定性排序，便于比对与复现）
  const callsByTool = [...callAgg.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
  // 按模型分段的调用/错误事实（排序确定：模型名升序 —— 候选 id 与回执都必须可复现）。
  // ★ 并集而非只取有调用的那侧：某模型"有工具调用但零失败"必须出现（calls>0, errors=0），
  //   否则挖掘期会把它当成"没数据"而漏掉一条**好**基线；`errors` 里出现的 unknown 也保留。
  const models = [...new Set([...modelCallAgg.keys(), ...modelErrAgg.keys()])]
    .sort((a, b) => a.localeCompare(b))
    .map((m) => ({ model: m, calls: modelCallAgg.get(m) || 0, errors: modelErrAgg.get(m) || 0 }))
  const distinct = new Set([...toolNameById.values()]).size
  // 规范化工具序列（A2/OPP-8；**2026-10-14 加强：集合 → 保序序列**）。
  //
  // ★ 为什么必须改（用户实测反馈"一个工具调用链三次会话重复使用了，就要提议做工作流"）：
  //   原实现是 `[...callAgg.keys()].sort().join('>')` = **工具名集合**，丢掉了顺序与结构。
  //   后果：任何编码任务都会用到的 {Read, Edit, Grep} 塌缩成同一个指纹 ⇒ 三个会话就误报
  //   "可固化成技能/流程"，而且不同会话模式全塌缩成同一条 ⇒ 候选表述同质化。
  //
  // 新口径：按**调用顺序**收集 → 只去**连续**重复 → join('>')。
  //   · 为什么要保序：结构是"编排"的本体；`Read>Edit>Bash` 与 `Bash>Edit>Read` 是做事方式不同的两件事。
  //   · 为什么只去**连续**重复：同一工具连用多次只是重复劳动、不构成编排（`Read>Read>Read>Edit`
  //     → `Read>Edit`）；而**隔开**出现的同一工具是真实的结构差异（`Read>Edit>Read` 必须保留）。
  //   · 次数与种类信息在其他字段（callsByTool / calls），指纹不需要它们。
  //     判定所需的"体量/多样性"门槛由挖掘期用 calls 与序列去重数计算（见 opportunity-mine 的 OPP-8）。
  const sequence = callOrder.filter((n, i) => i === 0 || n !== callOrder[i - 1]).join('>')

  // ── usage / compact（T4.1，2026-10-20：演化看得见成本的地基）────────────────────
  // 为什么必须有：投影器此前**完全不读** usage（`TaskRecord` 无该字段），于是演化环里
  // "这个任务花了我多少钱"结构性不可见——6 条规则全是行为/质量信号，零成本维度。
  // 而数据**本来就在** transcript 里（`message.usage`，session.mjs:298-300）。
  //
  // ★ 缺 usage 必须产 null，不得产 0：lane transcript 的历史数据（T0.2 之前落的）与
  //   老投影都没有该字段。写成 `{input:0,…}` 会让"没有证据"看起来像"免费"——正是
  //   OPP-1 缺 `callsByTool` / OPP-7 缺 `skills` 面时踩过的同一类坑（缺省当零 = 造数据）。
  //
  // ★ 计价按**每条条目自己的 model**（混模型会话不能套同一组价，见 readonly.mjs 的 T0.4）：
  //   逐 model 分桶累加，再用 `resolveModelPrices(model)` 各自算——与 `/api/usage` 同源。
  //   `priceOf` 可注入（测试用；不注入即走真价表），保持"可复现"这条既有纪律。
  const byModelUsage = new Map()
  let compactCount = 0
  for (const e of arr) {
    if (e?.type === 'assistant' && e.kind === 'compaction') compactCount++
    if (e?.type !== 'assistant') continue
    const u = e.message?.usage
    // 与 stats.mjs 同判据：`input_tokens` 必须有限才算一笔有效 usage（缺字段的条目跳过不猜）
    if (!u || !Number.isFinite(Number(u.input_tokens))) continue
    const model = String(e.message?.model || '') || 'unknown'
    const b = byModelUsage.get(model) || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    b.input_tokens += Number(u.input_tokens) || 0
    b.output_tokens += Number(u.output_tokens) || 0
    b.cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0
    b.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0
    byModelUsage.set(model, b)
  }
  let usage = null
  if (byModelUsage.size > 0) {
    const t = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 }
    const byModel = {}
    let costUsd = 0
    for (const [model, b] of [...byModelUsage.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      const sub = b.input_tokens + b.output_tokens + b.cache_read_input_tokens + b.cache_creation_input_tokens
      t.input += b.input_tokens; t.output += b.output_tokens
      t.cacheRead += b.cache_read_input_tokens; t.cacheCreate += b.cache_creation_input_tokens
      t.total += sub
      byModel[model] = { tokens: sub, costUsd: round4(costOf(b, priceOf ? priceOf(model) : resolveModelPrices(model))) }
      costUsd += byModel[model].costUsd
    }
    usage = { ...t, costUsd: round4(costUsd), byModel }
  }

  // ── approvals（P-b approval_decision 聚合；timeout/cancel 现行写侧不产，数不出=0）──
  let asked = 0
  let allowed = 0
  let denied = 0
  let timeout = 0
  for (const e of arr) {
    if (!isMeta(e, 'approval_decision')) continue
    asked++
    if (e.behavior === 'allow') allowed++
    else if (e.behavior === 'deny') denied++
    else if (e.behavior === 'timeout') timeout++
  }

  // ── corrections（真用户文本 × fidelity 强信号；系统注入/tool_result 剔除）──
  // 同一次遍历收集"真用户文本"序列：corrections 与相邻近重复对（P1）共用同一过滤口径。
  const userTexts = []
  const corrections = []
  for (const e of arr) {
    if (e?.type !== 'user' || typeof e.message?.content !== 'string') continue
    const text = e.message.content
    if (!text || SYSTEM_INJECT_PREFIXES.some((p) => text.startsWith(p))) continue
    userTexts.push({ seq: Number.isInteger(e.seq) ? e.seq : null, norm: nrNorm(text) })
    const r = detectUserCorrection(text)
    if (r.corrected) corrections.push({ turnRef: refOf(e, sessionId), pattern: r.phrases.join(',') })
  }
  // 相邻真用户文本对的 4-gram 相似度（只落 seq 与分值，不落文本——隐私口径）
  const nearRepeatPairs = []
  for (let i = 1; i < userTexts.length; i++) {
    nearRepeatPairs.push({
      firstSeq: userTexts[i - 1].seq,
      secondSeq: userTexts[i].seq,
      similarity: nearRepeatSimilarity(userTexts[i - 1].norm, userTexts[i].norm),
    })
  }

  // ── skills（loaded：成功加载的 Skill 调用；triggerHits：P-c meta）──
  const skillCalls = []
  for (const e of arr) {
    if (e?.type !== 'assistant' || e.kind === 'compaction') continue
    for (const b of blocksOf(e)) {
      if (b?.type === 'tool_use' && b.name === 'Skill' && typeof b.input?.skill === 'string' && b.input.skill) {
        skillCalls.push({ id: b.id, skill: b.input.skill, seq: Number.isInteger(e.seq) ? e.seq : null, ts: tsOf(e) })
      }
    }
  }
  const resErrIds = new Set()
  const resOkIds = new Set()
  for (const e of arr) {
    if (e?.type !== 'user') continue
    for (const b of blocksOf(e)) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      if (b.is_error === true) resErrIds.add(b.tool_use_id)
      else resOkIds.add(b.tool_use_id)
    }
  }
  const loadedMap = new Map()
  const loads = [] // P1：每次成功加载带 {id,seq,ts}——技能加载发生在哪一轮可回跳
  for (const c of skillCalls) {
    // 失败加载不算"使用"；无结果（截断/未执行）同样不计——只认确凿的成功
    if (resErrIds.has(c.id) || !resOkIds.has(c.id)) continue
    loadedMap.set(c.skill, (loadedMap.get(c.skill) || 0) + 1)
    loads.push({ id: c.skill, seq: c.seq, ts: c.ts })
  }
  const hitMap = new Map()
  for (const e of arr) {
    if (isMeta(e, 'skill_trigger_hit') && typeof e.id === 'string' && e.id) hitMap.set(e.id, (hitMap.get(e.id) || 0) + 1)
  }
  const skillIds = new Set([...loadedMap.keys(), ...hitMap.keys()])
  const byCountDesc = (a, b) => b.count - a.count || a.id.localeCompare(b.id)
  const skills = {
    loaded: [...skillIds].map((id) => ({ id, count: loadedMap.get(id) || 0 })).filter((s) => s.count > 0).sort(byCountDesc),
    triggerHits: [...skillIds].map((id) => ({ id, count: hitMap.get(id) || 0 })).filter((s) => s.count > 0).sort(byCountDesc),
    loads,
  }

  // ── loop（loop_mode metas 派生；escalations = 生效模式变更次数，v1 口径）──
  const modeSeq = []
  for (const e of arr) {
    if (!isMeta(e, 'loop_mode')) continue
    const v = e.effective ?? e.value
    if (typeof v === 'string' && v) modeSeq.push(v)
  }
  const modes = modeSeq.filter((v, i) => i === 0 || v !== modeSeq[i - 1])
  const escalations = Math.max(0, modes.length - 1)

  // ── inject（取末条 inject_snapshot 的当前态；口径注：非跨轮求和）──
  let inject = null
  for (const e of arr) {
    if (!isMeta(e, 'inject_snapshot')) continue
    const bySource = {}
    for (const [k, v] of Object.entries(e.bySource && typeof e.bySource === 'object' ? e.bySource : {})) bySource[k] = num(v)
    inject = { totalBytes: num(e.totalBytes), bySource }
  }

  // ── guard（P-a guard_turn metas 取峰值；无记录 = null，不造 0 假）──
  // level 在 meta 里是字面级名（'L0'..'L4'，heal-ladder 单一真源）；投影转序数（0-4）。
  // firstRef（P1）：首条 guard_turn 条目 ref——守卫热点候选的证据锚点。
  let guard = null
  if (arr.some((e) => isMeta(e, 'guard_turn'))) {
    let worstLevel = -1
    let stallHeals = 0
    let errorStreakMax = 0
    let repeatStreakMax = 0
    let firstRef = null
    for (const e of arr) {
      if (!isMeta(e, 'guard_turn')) continue
      if (!firstRef) firstRef = refOf(e, sessionId)
      const lv = typeof e.level === 'string' && e.level in HEAL_LEVELS ? HEAL_LEVELS[e.level] : -1
      worstLevel = Math.max(worstLevel, lv)
      stallHeals = Math.max(stallHeals, num(e.stallHeals))
      errorStreakMax = Math.max(errorStreakMax, num(e.errorStreak))
      repeatStreakMax = Math.max(repeatStreakMax, num(e.repeatStreak))
    }
    guard = { worstLevel: worstLevel < 0 ? 0 : worstLevel, stallHeals, errorStreakMax, repeatStreakMax, firstRef }
  }

  // ── outcome（三态不退化：aborted 认显式证据；error 认尾轮证据；纯文本收束 = ok；其余 unknown）──
  let aborted = false
  for (const e of arr) {
    if (e?.type === 'meta' && ABORT_KINDS.has(String(e.kind || ''))) aborted = true
  }
  let lastAssistant = -1
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i]
    if (e?.type === 'assistant' && e.kind !== 'compaction') { lastAssistant = i; break }
  }
  let outcome
  if (aborted) {
    outcome = 'aborted'
  } else if (lastAssistant < 0) {
    outcome = 'unknown'
  } else {
    const hasToolUse = blocksOf(arr[lastAssistant]).some((b) => b?.type === 'tool_use')
    let tailResults = 0
    let tailErrors = 0
    let userTextAfter = false
    for (let i = lastAssistant + 1; i < arr.length; i++) {
      const e = arr[i]
      if (e?.type === 'meta' || e?.type === 'thinking' || e?.type === 'assistant') continue
      if (e?.type !== 'user') continue
      const trs = blocksOf(e).filter((b) => b?.type === 'tool_result')
      if (trs.length) {
        tailResults += trs.length
        tailErrors += trs.filter((b) => b.is_error === true).length
      } else if (typeof e.message?.content === 'string') {
        userTextAfter = true
      }
    }
    if (tailErrors > 0) outcome = 'error'
    else if (tailResults > 0) outcome = 'unknown' // 有工具轨迹但无收束（截断/进程终止）
    else if (hasToolUse) outcome = 'unknown' // 发了工具调用、结果未落盘
    else if (userTextAfter) outcome = 'unknown' // 用户又发言、模型未回应
    else outcome = 'ok' // 纯文本正常收束
  }

  return {
    v: TASK_RECORD_V,
    sessionId,
    taskId: sessionId,
    parentTaskId,
    kind,
    project,
    mode,
    model,
    startedAt,
    endedAt,
    turns,
    turnSeq,
    outcome,
    tools: { calls, distinct, errors, callsByTool, sequence },
    // OPP-10（2026-10-19）：按模型分段的调用/错误 —— 与 tools 并列而非嵌套（它答的是
    // "哪个模型出的活更容易出错"，不是"哪个工具不好用"，两者维度不同）
    models,
    approvals: { asked, allowed, denied, timeout },
    corrections,
    nearRepeatPairs,
    skills,
    loop: { modes, escalations },
    inject,
    guard,
    usage,
    compact: { count: compactCount },
    // T3.2：本会话生效的治理策略 id（缺字段 ⇒ null：""没测到" ≠ "一条都没开""）
    activeStrategies,
  }
}

/** entry 流 → TaskRecord[]（按 sessionId 分组；排序确定：startedAt → sessionId） */
export function projectRecords(entries, { priceOf = null } = {}) {
  const bySession = new Map()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue
    const sid = String(e.sessionId || '')
    if (!bySession.has(sid)) bySession.set(sid, [])
    bySession.get(sid).push(e)
  }
  const records = []
  for (const [sid, list] of bySession) records.push(projectSession(sid, list, { priceOf }))
  records.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')) || a.sessionId.localeCompare(b.sessionId))
  return records
}

/**
 * 窗口级汇总（基线数字：失败热点 failures / 技能命中 skills / 纠正率 corrections*）。
 * @param {object[]} records
 * @param {{window?: {from?: string, to?: string, days?: number}}} [opts]
 */
export function summarizeRecords(records, { window: win = {} } = {}) {
  const list = Array.isArray(records) ? records : []
  const totals = { sessions: list.length, main: 0, subagent: 0, turns: 0 }
  const outcomes = { ok: 0, error: 0, aborted: 0, unknown: 0 }
  const failAgg = new Map()
  const skillAgg = new Map()
  let correctionsTotal = 0
  let injectTotalBytes = 0
  const injectBySource = {}
  let guardSessions = 0
  let stallHealsTotal = 0
  let worstLevelMax = 0
  // ── T4.2（2026-10-20）：成本/质量**并列**汇总（不合成单一总分）──────────────
  // 为什么并列而不合成：spec D27（runtime-evolution-loop-design §491/534）明令
  // "OpportunityScore ≠ 性能分、Performance Evidence 禁跨域聚合"。成本与质量必须是两个
  // 各自可读的量，由**门（Soft Gate）**去比较，而不是先揉成一个数——揉了就分不清
  // "便宜了但变差了"和"真变好了"。
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, costUsd: 0 }
  let usageSessions = 0        // 有 usage 证据的会话数
  // ★ 分母口径（2026-10-20 修正，别退回去）：只有**同时**"有 usage 证据 + 成功"的会话
  // 才进分母。若分母取全部成功会话、分子只取有证据的，则缺证据的会话会把 C_success
  // **系统性压低**（看起来"任务很便宜"）——那是拿缺失当利好，与"缺省不当零"同一条纪律。
  let okWithUsage = 0
  let compactTotal = 0
  for (const r of list) {
    compactTotal += num(r.compact?.count)
  }
  for (const r of list) {
    if (!r.usage) continue      // usage === null ⇒ 无证据，跳过不猜（不得当 0）
    usageSessions++
    if (r.outcome === 'ok') okWithUsage++
    usageTotals.input += num(r.usage.input)
    usageTotals.output += num(r.usage.output)
    usageTotals.cacheRead += num(r.usage.cacheRead)
    usageTotals.cacheCreate += num(r.usage.cacheCreate)
    usageTotals.total += num(r.usage.total)
    usageTotals.costUsd += Number(r.usage.costUsd) || 0
  }
  usageTotals.costUsd = round4(usageTotals.costUsd)
  for (const r of list) {
    if (r.kind === 'main') totals.main++
    else if (r.kind === 'subagent') totals.subagent++
    totals.turns += num(r.turns)
    if (r.outcome && outcomes[r.outcome] !== undefined) outcomes[r.outcome]++
    for (const f of r.tools?.errors || []) {
      const cur = failAgg.get(f.tool) || { ...freshFail(), tool: f.tool, sessions: 0 }
      cur.count += num(f.count)
      cur.sessions += 1
      if (!cur.firstRef && f.firstRef) cur.firstRef = f.firstRef
      failAgg.set(f.tool, cur)
    }
    for (const s of r.skills?.loaded || []) {
      const cur = skillAgg.get(s.id) || { id: s.id, loaded: 0, triggerHits: 0 }
      cur.loaded += num(s.count)
      skillAgg.set(s.id, cur)
    }
    for (const s of r.skills?.triggerHits || []) {
      const cur = skillAgg.get(s.id) || { id: s.id, loaded: 0, triggerHits: 0 }
      cur.triggerHits += num(s.count)
      skillAgg.set(s.id, cur)
    }
    correctionsTotal += (r.corrections || []).length
    if (r.inject) {
      injectTotalBytes += num(r.inject.totalBytes)
      for (const [k, v] of Object.entries(r.inject.bySource || {})) injectBySource[k] = num(injectBySource[k]) + num(v)
    }
    if (r.guard) {
      guardSessions++
      stallHealsTotal += num(r.guard.stallHeals)
      worstLevelMax = Math.max(worstLevelMax, num(r.guard.worstLevel))
    }
  }
  return {
    totals,
    outcomes,
    failures: [...failAgg.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    skills: [...skillAgg.values()].sort((a, b) => b.loaded + b.triggerHits - (a.loaded + a.triggerHits) || a.id.localeCompare(b.id)),
    correctionsTotal,
    // 基线"纠正率"（v1 口径）：每会话平均纠正次数。分母为 0 时 = 0（不 NaN）。
    correctionsRate: list.length ? Number((correctionsTotal / list.length).toFixed(4)) : 0,
    inject: { totalBytes: injectTotalBytes, bySource: injectBySource },
    guard: { sessionsWithHeals: guardSessions, stallHealsTotal, worstLevelMax },
    // T4.2：成本侧车 + 质量侧车（**并列，不合成**）+ 唯一被认可的比值 C_success。
    usageTotals,
    usageSessions,
    compactTotal,
    // C_success = 成功任务的全部执行费用 ÷ 成功任务数（本计划 §2.1）。三条纪律：
    //  ① 分母 0 ⇒ null（不得 Infinity/NaN —— 那是"没有成功任务"，不是"成本无穷小"）；
    //  ② **分子与分母不同源，这是刻意的**：分子 = 所有**有 usage 证据**会话的费用（**含失败会话**），
    //     分母 = 有证据**且成功**的会话数。为什么失败的花费也必须进分子：C_success 的语义是
    //     "得到一个成功任务，平均要付多少钱"——失败任务烧掉的 token 也是为它付的代价。
    //     把失败成本剔出去，会让"失败越多显得越便宜"，正好与治理目标相反。
    //  ③ 与 qualityGuard 并列输出——成本下降但质量劣化时由门去否决，不在本层判。
    costPerSuccess: okWithUsage > 0 ? round4(usageTotals.costUsd / okWithUsage) : null,
    tokensPerSuccess: okWithUsage > 0 ? Math.round(usageTotals.total / okWithUsage) : null,
    okWithUsage,
    qualityGuard: {
      correctionsRate: list.length ? Number((correctionsTotal / list.length).toFixed(4)) : 0,
      // 错误会话占比（!= ok 的都算，但 aborted/unknown 单列在 outcomes 里可分辨）
      errorRate: list.length ? Number((num(outcomes.error) / list.length).toFixed(4)) : 0,
    },
    window: { from: win.from || null, to: win.to || null, days: num(win.days) },
  }
}

/**
 * 以某一时刻为界，把会话记录切成"前窗 / 后窗"（T4.6，2026-10-20）。
 *
 * 用途：一次改动（技能/工作流/策略上线）到底有没有让"每成功任务成本"变好？只有一个数字
 * 答不了——必须拿**改之前**与**改之后**的同类会话比。
 *
 * 三条写死的口径（都防"造结论"）：
 *  ① **时间不可解析的记录直接剔除**，两侧都不进（不猜它属于哪边）；
 *  ② 前窗取**最靠近边界**的 N 个（不是最早的 N 个）：越靠远端的会话受其他变化干扰越大，
 *     "改之前的状态"由紧邻边界那批会话代表；后窗同理取**最早**的 N 个（改完立刻的效果）；
 *  ③ 边界时刻本身归**后窗**（`>=` 判据）：装完后写的会话才算"见到新版"。这条写清楚，
 *     否则同一条记录可能被两边重复计入。
 *
 * 纯函数（无 IO、无时钟）：`boundaryIso` 由调用方给（技能 `.history` 时间戳 / 台账时刻）。
 *
 * @param {object[]} records TaskRecord[]
 * @param {{boundaryIso?: string, beforeN?: number, afterN?: number}} [opts]
 * @returns {{before: object[], after: object[], boundary: {iso: string|null, reason: string|null,
 *            beforeTotal: number, afterTotal: number, skippedNoTimestamp: number,
 *            beforeTruncated: boolean, afterTruncated: boolean}}}
 */
export function splitWindowAround(records, { boundaryIso = '', beforeN = 5, afterN = 5 } = {}) {
  const list = Array.isArray(records) ? records : []
  const bMs = Date.parse(String(boundaryIso || ''))
  const empty = { iso: null, reason: 'invalid-boundary', beforeTotal: 0, afterTotal: 0, skippedNoTimestamp: 0, beforeTruncated: false, afterTruncated: false }
  if (!Number.isFinite(bMs)) return { before: [], after: [], boundary: empty }
  const nb = Math.max(0, Math.floor(Number(beforeN) || 0))
  const na = Math.max(0, Math.floor(Number(afterN) || 0))
  const before = []
  const after = []
  let skipped = 0
  for (const r of list) {
    const t = Date.parse(String(r?.startedAt || ''))
    if (!Number.isFinite(t)) { skipped++; continue }   // ① 不猜归属
    if (t < bMs) before.push({ r, t })
    else after.push({ r, t })                          // ③ 边界本身归后窗
  }
  before.sort((x, y) => y.t - x.t)   // ② 前窗：最靠近边界的优先
  after.sort((x, y) => x.t - y.t)    // ② 后窗：最早（紧接改动）的优先
  return {
    before: before.slice(0, nb).map((x) => x.r),
    after: after.slice(0, na).map((x) => x.r),
    boundary: {
      iso: new Date(bMs).toISOString(),
      reason: null,
      beforeTotal: before.length,
      afterTotal: after.length,
      skippedNoTimestamp: skipped,
      beforeTruncated: before.length > nb,
      afterTruncated: after.length > na,
    },
  }
}

/** 报告产物（TaskRecord[] + 汇总，人可读；§4.1） */
export function buildEvolutionReport(entries, { window: win = {}, now = '' } = {}) {
  const records = projectRecords(entries)
  const summary = summarizeRecords(records, { window: win })
  return {
    v: TASK_RECORD_V,
    generatedAt: typeof now === 'string' && now ? now : null,
    window: summary.window,
    records,
    summary,
    // T3.2（2026-10-20）：按治理策略组合分组的成本视图 —— A/B 归因的**读侧落点**。
    // 加在这里（而不是只留一个导出函数）是因为：`--evolution-report` 是演化环唯一的数据源，
    // 报告里没有这一段的聚合，`turn.activeStrategies` 就只是"落了盘没人看"。
    // 语义见 `groupCostByStrategies` 头注（按组合分组、小样本不给结论）。
    strategyGroups: groupCostByStrategies(records),
  }
}

/**
 * 前后窗对照（T4.6）：把两侧各自汇总成 `cost-verdict` 所需的形状。
 *
 * ★ 本函数**不下结论**（不判 improved/regressed）：判定唯一真源是
 *   `server/evolution-ledger.mjs#computeCostVerdict`（样本门/证据门/质量否决都在那儿，
 *   且有可红断言）。这里只产出"双方的事实"，避免同一套判据两处实现——本仓已因口径分裂
 *   吃过亏（单价三处口径）。
 *
 * ★ `samples` 取 `okWithUsage`（**有成本证据且成功**的会话数），不是 `sessions`：
 *   拿全部会话当样本会让缺证据的老会话混进分母，把 C_success 压低（"拿缺失当利好"）。
 *
 * @param {object[]} records TaskRecord[]
 * @param {{boundaryIso?: string, beforeN?: number, afterN?: number}} [opts]
 * @returns {{boundary: object,
 *            base: {costPerSuccess: number|null, samples: number, quality: {correctionsRate:number, errorRate:number}},
 *            cand: {costPerSuccess: number|null, samples: number, quality: {correctionsRate:number, errorRate:number}},
 *            windows: {before: object, after: object}}}
 */
export function compareWindowCost(records, { boundaryIso = '', beforeN = 5, afterN = 5 } = {}) {
  const split = splitWindowAround(records, { boundaryIso, beforeN, afterN })
  const b = summarizeRecords(split.before, { window: {} })
  const a = summarizeRecords(split.after, { window: {} })
  const side = (s) => ({
    costPerSuccess: s.costPerSuccess,
    // 样本 = 有证据且成功（与 C_success 的分母同源）
    samples: num(s.okWithUsage),
    quality: { correctionsRate: num(s.qualityGuard?.correctionsRate * 10000) / 10000, errorRate: num(s.qualityGuard?.errorRate * 10000) / 10000 },
  })
  return {
    boundary: split.boundary,
    base: side(b),
    cand: side(a),
    windows: {
      before: { sessions: b.totals.sessions, okWithUsage: b.okWithUsage, costPerSuccess: b.costPerSuccess, usageTotals: b.usageTotals, quality: b.qualityGuard },
      after: { sessions: a.totals.sessions, okWithUsage: a.okWithUsage, costPerSuccess: a.costPerSuccess, usageTotals: a.usageTotals, quality: a.qualityGuard },
    },
  }
}

/**
 * 按治理策略分组聚合 `C_success`（T3.2 的读侧，2026-10-20）。
 *
 * 回答的问题：**"这次 C_success 变好，是因为开了哪几条策略？"**
 * 没有它，`turn.activeStrategies` 只是"落了盘但没人看"——归因仍然只能靠整体猜。
 *
 * ★ 归因口径（三条，都为防"把相关性说成因果"）：
 *  ① **按策略组合分组**，不按单条策略：几条策略总是一起开（同一份环境变量），
 *     把它们拆成单条只会得到"同一批会话被算进 N 组"的假样本量。组键 = 排序后的 id 拼接；
 *  ② 每组只在**有成本证据且成功**的会话上算 C_success（与 T4.2 分母同源）；
 *  ③ `sessions < minSessions` 的组把 `costPerSuccess` 置 **null** 并在 `note` 里说明——
 *     小样本上给数字会被误读成结论。样本量够了再放行。
 *
 * 纯函数（无 IO、无时钟）：`records` 由 `projectRecords` 产出。
 *
 * @param {object[]} records TaskRecord[]
 * @param {{minSessions?: number}} [opts]
 * @returns {{groups: Array<{key: string, strategies: string[]|null, sessions: number,
 *            okWithUsage: number, costPerSuccess: number|null, costPerSuccessRaw: number|null,
 *            usageTotals: object, note: string|null}>, ungrouped: number}}
 */
export function groupCostByStrategies(records, { minSessions = 3 } = {}) {
  const minN = Math.max(1, Math.floor(Number(minSessions) || 3))
  const byKey = new Map()
  let ungrouped = 0
  for (const r of Array.isArray(records) ? records : []) {
    const list = Array.isArray(r?.activeStrategies) ? r.activeStrategies : null
    // 没有策略字段（旧会话/chat/嵌入）⇒ 不进分组（无归因依据），单独计数
    if (!list) { ungrouped++; continue }
    // ① 组键 = 排序后拼接（同组合不同顺序视为同一组）
    const strategies = [...new Set(list.map(String))].sort()
    const key = strategies.length ? strategies.join('+') : '(none)'
    if (!byKey.has(key)) byKey.set(key, { key, strategies, records: [] })
    byKey.get(key).records.push(r)
  }
  const groups = [...byKey.values()].map(({ key, strategies, records: rs }) => {
    const s = summarizeRecords(rs, { window: {} })
    const okWithUsage = num(s.okWithUsage)
    // ③ 小样本只给"原始值"，正式字段置 null
    const raw = okWithUsage > 0 ? num(s.costPerSuccess) : null
    const enough = okWithUsage >= minN
    return {
      key,
      strategies,
      sessions: num(s.totals?.sessions),
      okWithUsage,
      costPerSuccess: enough ? raw : null,
      costPerSuccessRaw: raw,
      usageTotals: s.usageTotals,
      note: enough ? null : `样本不足（成功且有证据 ${okWithUsage} < ${minN}）⇒ 不给结论`,
    }
  })
  // 排序确定：会话多的在前，再按 key 字典序（可复现，不依赖 Map 插入顺序）
  groups.sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key))
  return { groups, ungrouped }
}
