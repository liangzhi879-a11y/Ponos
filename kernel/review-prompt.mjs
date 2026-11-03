// kernel/review-prompt.mjs —— 候选**价值评审**的意图拼装与结论解析（纯函数；演化 Step C，2026-10-14）
// ---------------------------------------------------------------------------
// 定位：把**候选证据**变成一条可交给受控会话的评审意图消息，并把模型回的那行判断解析成三态结论。
// 纪律（与 kernel/draft-intent.mjs 同款）：纯函数、零 IO、无时钟、无随机（同输入逐字同输出
// ⇒ 可单测、可复现）；**只出"要判断什么"，不出"怎么改"**。
// 隐私口径同起草侧：消息里只有统计与**引用**（ruleId/subject/count/score/会话 id/建议 code），
// **不含任何对话正文**。
//
// ★★ 与 A1「深度分析」**不是同一件事** —— 本仓两处问的是不同问题，别合并、别互相顶替：
//   · **A1 深度分析**（已实现）：问「**该怎么做**」——产出更具体的成因假设与落地方案（面向"怎么办"）；
//   · **本模块（Step C 评审）**：问「**值不值得做**」——产出一行价值判断（面向"要不要做"），
//     判的是三件具体的事：① 成因假设站不站得住（例如 OPP-1 报"站点变了"，实际可能是那次网络断了）；
//     ② 建议方向可不可行（例如"把用法纪律写进技能"，但该用法本来是临时的）；
//     ③ 落地会不会反而添乱（例如该模式只在这个季度存在，固化成技能很快过时）。
//   两者**可以都跑**，但**评审在前、且更便宜**：评审只读证据、不产草案（白名单里没有任何写面），
//   把"不成立/存疑"的候选挡在**花钱产方案**之前 —— 先判值不值得，再谈怎么做。
//
// ★ 为什么评审的白名单**必须比起草更窄**（独立常量，**不得**复用 `DRAFT_TOOL_ALLOWLIST`）：
//   评审阶段**一个字节都不该落盘**（产物只是一行判断文本），故写类工具（Write/Edit/SkillDraft）
//   以及任何执行/出网面都**不注册**。若"顺手统一"成起草白名单，权限会**静默扩大**三个写面，
//   而后果不在本模块内（变成"评审会话能改盘"），没有一处断言会因此变红 —— 所以这里：
//     ① 常量独立声明；② **不 import** draft-intent（派生必然漂移，且漂移方向恰好是扩大权限那侧）；
//     ③ 更窄这件事由独立断言钉住（kernel-tests/review-prompt.test.mjs 第 ① 组）。
//
// 三态语义（**写死，别加第四态**；判据的消费方是 server/review-engine.mjs 与前端视图层）：
//   · `worth`（值得）：成因假设站得住、方向可行 ⇒ **保持原分档**（不额外提权 —— 否则"评审"会变成刷分手段）；
//   · `doubtful`（存疑）：可能成立但证据不足 / 时机未到 ⇒ **降一档**（pin→list、list→collapsed）；
//   · `invalid`（不成立）：成因假设明显不成立（如证据指向一次性事故）⇒ **降到 collapsed 且默认隐藏**。
//   ★ 三态都**不删候选、不改 state**：用户要能回看"为什么系统觉得这条不值得"（可追溯 > 干净）。

/** 评审会话的工具白名单：**空 = 不给任何工具**（评审是"只凭给定事实做判断"的任务）。
 *
 *  ★ 2026-10-14 从 `['Read','Grep','Glob']` 改为**空**（用户实测反馈：评审拿不到可信结论，
 *    返回 `unparsable`）。核实到的问题：给了三个只读工具，但**没有给任何可读的路径**
 *    （隐私口径决定提示词里只有统计与 `会话id#seq` 引用，不含正文，也不含转录文件位置）
 *    ⇒ 会话里的 agent 会去"找证据"（Grep/Glob 乱翻），既浪费轮次，又常在最后给一段**散文**
 *    （"我无法访问会话记录…"）而不是那一行 JSON ⇒ 解析必然失败（unparsable）。
 *    ⇒ 正解是**不给工具**：评审所需的一切事实都由提示词给全（见 `renderFacts`），
 *    会话只做判断。这同时让"评审一个字节都不落盘"从"靠白名单"升级为"结构上不可能"。
 *
 *  ★ 仍然是**独立常量**、**不派生自** `DRAFT_TOOL_ALLOWLIST`：派生会在有人改动起草白名单时
 *    静默把写面带进评审（方向恰好是扩权）。 */
export const REVIEW_TOOL_ALLOWLIST = Object.freeze([])

/** 评审结论三态（顺序 = 视图排序口径：worth → doubtful → invalid）。**封闭枚举**，不许加第四态。 */
export const REVIEW_VERDICTS = Object.freeze(['worth', 'doubtful', 'invalid'])

/** `reason` 上限（字符）：超过即截断 + 追加 `REVIEW_REASON_ELLIPSIS` 并标记 `truncated`。
 *  理由：候选行是 JSONL、reason 会进 tooltip 与列表 —— 不设上限时一行判断可能带进来整篇分析
 *  （评审只该给判断与理由，长篇分析是 A1 深度分析的事）。 */
export const REVIEW_REASON_MAX = 200
/** 截断标记（单独导出：测试与读侧都不许各自硬编一个字面量）。 */
export const REVIEW_REASON_ELLIPSIS = '…'

/** 建议渲染：`code` +（有 route 时）`→route` +（有 args 时）`(紧凑 JSON)` —— 纯展示，不参与判定。
 *  route 必须给：判"方向可不可行"要看它是"只给建议"还是"要起草/要动设置"。 */
function renderAdvice(item, { withRoute = false } = {}) {
  const code = typeof item?.code === 'string' ? item.code : ''
  if (!code) return ''
  const route = withRoute && typeof item?.route === 'string' && item.route ? `→${item.route}` : ''
  const args = item?.args
  const argText = args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length
    ? `(${JSON.stringify(args)})`
    : ''
  return `${code}${route}${argText}`
}

// 事实行的实现**收在 `kernel/candidate-facts.mjs`**（起草侧与评审侧共用同一份）。
// 为什么抽走：起草消息此前只给"命中 N 次"，agent 只能自己去扫转录重算（实测一个起草任务 82 步）；
// 同一份事实两处各算一遍必然漂移 ⇒ 单一实现。本模块**再导出**它，既有调用方/测试不用改。
import { renderFacts } from './candidate-facts.mjs'

export { renderFacts }

/** 证据引用（`sessionId#seq`；与起草侧同口径 —— 用户可回跳原会话核对，但不带正文）。 */
function renderEvidence(candidate) {
  const ev = Array.isArray(candidate?.evidence) ? candidate.evidence : []
  return ev
    .map((e) => {
      const sid = typeof e?.sessionId === 'string' ? e.sessionId : ''
      if (!sid) return ''
      return Number.isInteger(e?.seq) ? `${sid}#${e.seq}` : sid
    })
    .filter(Boolean)
    .join('、')
}

/**
 * 组装评审意图消息（确定性：同输入 ⇒ 逐字同输出）。
 *
 * ★ 输出面**只有判断**：消息里明确要求"只回一行 JSON"，并给出三态判据 —— 判定与解析的
 *   单一真源都在本模块（引擎只负责起会话与把文本交给 `parseReviewVerdict`）。
 * ★ 硬约束三条：不得写任何文件（本会话也没有写工具）、不得执行外部动作、不得把候选当成
 *   待办去"补证据"（没有证据就如实说存疑 —— 与本仓"不臆造"一致）。
 *
 * @param {object} candidate 候选行（至少含 id/ruleId/subject/count/score/advice/evidence）
 * @param {{existingArtifacts?: {id: string, kind: string}[]}} [opts] 既有件清单（判"会不会重复/打架"用；
 *        只给 id 与 kind，不给正文）
 * @returns {string} 评审意图消息（可直接作为对话输入）
 */
export function buildReviewIntent(candidate, opts = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {}
  const existing = Array.isArray(opts.existingArtifacts) ? opts.existingArtifacts : []
  const hypoth = (Array.isArray(c?.advice?.hypoth) ? c.advice.hypoth : []).map(renderAdvice).filter(Boolean)
  const actions = (Array.isArray(c?.advice?.actions) ? c.advice.actions : []).map((a) => renderAdvice(a, { withRoute: true })).filter(Boolean)
  const ev = renderEvidence(c)
  const facts = renderFacts(c)

  return [
    `【演进评审】候选 ${String(c.id || '')}（${String(c.ruleId || '')} · ${String(c.subject || '')}）`,
    `**事实（系统实测到的，只有这些）**：${facts}`,
    `会话引用（仅供你理解"发生在哪"）：${ev || '（无）'}`,
    `系统的成因假设：${hypoth.length ? hypoth.join('、') : '（无）'}`,
    `系统的建议方向：${actions.length ? actions.join('、') : '（无）'}`,
    `既有相关件：${existing.length ? existing.map((a) => `${String(a?.kind || '?')}:${String(a?.id || '?')}`).join('、') : '（无）'}`,
    '',
    '要你判断的是「**值不值得落地**」（不是"该怎么做"——那一步在评审通过之后）：',
    '  ① 成因假设站得住吗（证据会不会其实指向一次性事故/环境抖动，而不是可复用的模式）？',
    '  ② 建议方向可行吗（这套做法是不是临时的、一次性的，固化下来没有复用价值）？',
    '  ③ 落地会不会反而添乱（很快过时、与既有件重复或打架、把偶发当规律）？',
    '',
    '判据（三态，**只回这三者之一**；大小写不敏感，但请照下面写）：',
    '  · worth    = 值得：成因假设站得住、方向可行 ⇒ 保持原分档（不会因此被额外提权）',
    '  · doubtful = 存疑：可能成立但证据不足 / 时机未到 ⇒ 降一档',
    '  · invalid  = 不成立：成因假设明显不成立（如证据指向一次性事故）⇒ 降档并默认隐藏',
    '',
    '输出格式（★ 二选一，两种我都会读；**不要写别的**）：',
    '',
    '  推荐（最不容易出错）：**第一行只写结论词**，从第二行起写理由，例如',
    '      worth',
    '      错误率 37.8% 远高于基线 4.0%，且横跨 5 个会话复现，说明是稳定模式而非偶发事故。',
    '',
    '  也可以（一行 JSON）：',
    '      {"verdict":"worth","reason":"≤200 字的理由"}',
    '',
    '  结论词只从这三个里选（中文写法同样接受）：',
    '      worth / 值得      doubtful / 存疑      invalid / 不成立',
    '',
    '硬约束：',
    '  · ★ **你没有工具、也读不到任何会话记录**：不要试图查找/读取文件，**只依据上面给出的事实**判断',
    '  · 不得写/改任何文件；不得执行外部副作用（登录/填表/发送）',
    '  · 不得编造证据：事实不足时按"存疑"如实说，不要替候选补一个理由',
    '  · 解析不了那一行 JSON 就视为本次无效（宁缺勿滥），所以除了那一行不要写别的',
  ].join('\n')
}

/** 尝试把一段文本当 JSON 对象解析（不是对象/解析失败 ⇒ null）。 */
function tryParseObject(s) {
  const t = typeof s === 'string' ? s.trim() : ''
  if (!t || t[0] !== '{' || t[t.length - 1] !== '}') return null
  try {
    const o = JSON.parse(t)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    // ★ 2026-10-14：解析失败时再试一次**唯一一种**安全修复 —— 字符串字面量里的**裸换行/制表符**。
    //   为什么只修这一种、且必须修：JSON 不允许字符串内有裸换行，而"reason 写成多行"是模型最常见的
    //   畸形之一（本仓实测：期望能取出的多行 reason 直接落 unparsable ⇒ 用户的评审白花钱）。
    //   这个修复**不改变语义**（只把裸控制字符转义成合法写法，不新增/删除/改写任何内容），
    //   与"猜一个 verdict"有本质区别。其余畸形（缺引号、尾逗号、单引号…）**一律不修**：
    //   那些修复需要判断"模型想写什么"，属于替模型改写输出，本模块的纪律不允许。
    try {
      const o = JSON.parse(escapeRawControlCharsInStrings(t))
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null
    } catch { return null }
  }
}

/**
 * 把 **JSON 字符串字面量内**的裸换行/回车/制表符转义掉（其余字符原样）。
 * 逐字符走一遍、跟踪"是否在字符串内"与转义状态；不改任何其它内容。
 */
function escapeRawControlCharsInStrings(src) {
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of src) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue }
      if (ch === '\\') { out += ch; esc = true; continue }
      if (ch === '"') { out += ch; inStr = false; continue }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      out += ch
      continue
    }
    if (ch === '"') inStr = true
    out += ch
  }
  return out
}

/**
 * 从模型输出里取出那个扁平 JSON 对象（**只找对象，不做任何语义解释**）。
 *
 * 顺序：① 整段先试（模型严格照做时的主路径）→ ② 逐行**从后往前**试（代码围栏/前言是常见噪声）
 * → ③ 文本内联的 `{...}`（扁平 schema：不处理嵌套对象；从后往前 = 取最后那个 = 模型的结论）。
 * ★ 容错**只到"把 JSON 找出来"为止**：verdict 与 reason 的合法性判定在 parseReviewVerdict 里
 *   一步不放（找得出来 != 可信）。
 */
function extractJsonObject(text) {
  const raw = typeof text === 'string' ? text : ''
  const t = raw.trim()
  if (t) {
    try {
      const whole = JSON.parse(t)
      // ★ 整段是**合法 JSON 但不是那个对象**（数组/字符串/数字/true/null）⇒ 直接判**不是**要的形状，
      //   不再往下钻（`[{"verdict":"worth",...}]` 这种"包了一层"的回复一律 unparsable）——
      //   我们要的是"只回一行 JSON 对象"这个契约；宽容只给**非 JSON 的散文噪声**，不给"形状换了"。
      return (whole && typeof whole === 'object' && !Array.isArray(whole)) ? whole : null
    } catch { /* 不是整段 JSON（散文/围栏）：继续找 */ }
  }
  // 逐行（模型只加了一行前言时最省事；从后往前：结论通常在最后）
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = tryParseObject(lines[i])
    if (o) return o
  }

  // ★ 2026-10-14 增强（用户实测仍报 unparsable）：穷举"每个 `{` 的配对区间"，而不是用正则。
  //   ★ 两个必须写对的点（都踩过）：
  //   ① `lastIndexOf('{', -1)` 在 fromIndex<0 时**按 0 处理** ⇒ 若 body 以 `{` 开头会返回 0
  //      ⇒ 朴素 for 循环会**死循环**（本仓实测：测试文件挂到超时）。故显式在 start===0 收口。
  //   ② **取"跨度最大"的那个对象，而不是"最后一个"**：`reason` 里内联一个示例 JSON 是模型的
  //      常见写法（"你要求的形如 {\"verdict\":\"worth\"} 的样例"），从后往前会先命中那个**内层小对象**
  //      ⇒ verdict 被解析成示例里的值（本仓实测：期望 doubtful 实得 worth）＝**解析出错答案**，
  //      比 unparsable 更危险（错答案会被落盘、被当结论用）。外层对象的跨度必然更大 ⇒ 取最长。
  const scanLimit = 64 * 1024
  const body = raw.length > scanLimit ? raw.slice(-scanLimit) : raw
  let best = null
  let bestLen = 0
  let start = body.lastIndexOf('{')
  while (start >= 0) {
    const end = matchClosingBrace(body, start)
    if (end >= 0) {
      const src = body.slice(start, end + 1)
      if (src.length > bestLen) {
        const o = tryParseObject(src)
        if (o) { best = o; bestLen = src.length }
      }
    }
    if (start === 0) break
    start = body.lastIndexOf('{', start - 1)
  }
  return best
}

/**
 * 找与 `s[i]`（必须是 `{`）配对的 `}`；**跳过字符串内的花括号**并处理转义（`\"` / `\\`）。
 * 返回配对位置；找不到（被截断或未闭合）返回 -1。
 *
 * 为什么要手写而不是正则：旧实现的 `\{[^{}]*\}` 前提是"扁平、内部无花括号"，
 * 而模型两种常见写法恰好违反它 —— ① **美化输出**（`{` 单独一行）；
 * ② `reason` 里**引用了那个 JSON 格式本身**（内部带花括号）。两者都会让正则失配 ⇒ unparsable。
 */
function matchClosingBrace(s, i) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let k = i; k < s.length; k++) {
    const ch = s[k]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return k
    }
  }
  return -1
}

/**
 * 结论词的**别名表**：把模型可能写出的等价写法归一到三态。
 *
 * ★★ 2026-10-14（用户第三次反馈后重做；这是"评审机制修不好"的最可能主因）：
 *   此前只认**精确 ASCII**（`"worth"` 小写）。而本应用界面是中文、提示词也是中文，
 *   模型完全可能回 `值得` / `{"verdict":"值得"}` / 「我判断为存疑」——
 *   那些在旧实现里**一律 unparsable**，而且**无从察觉**（我拿到诊断文件也没看，只在自己假想的
 *   JSON 畸形里加容错 ⇒ 三轮返工）。
 *
 * ★ 这**不是**"近义词映射/替模型下结论"：表里每一项都是三态词本身的**中英对译**
 *   （worth=值得、doubtful=存疑、invalid=不成立），语义一一对应。
 *   真正需要"猜"的词（maybe/可能/看情况）**仍然一律 unparsable**。
 */
export const VERDICT_ALIASES = Object.freeze({
  worth: 'worth', '值得': 'worth',
  doubtful: 'doubtful', '存疑': 'doubtful', '可疑': 'doubtful',
  invalid: 'invalid', '不成立': 'invalid', '无效': 'invalid',
})

/** 把任意写法归一成三态；认不出 ⇒ null（**不猜**）。 */
function normalizeVerdict(v) {
  if (typeof v !== 'string') return null
  // 去掉强调/标点包装：`**worth**` / `"worth"` / `worth:` / `结论：worth`
  const cleaned = v.trim().toLowerCase()
    .replace(/^[*_`"'“”「『【\s]+/, '')
    .replace(/[*_`"'“”」』】\s:：。．,，、]+$/, '')
  return VERDICT_ALIASES[cleaned] ?? null
}

/** 行式协议：**第一行只写结论词**，其余行写理由（比 JSON 更容易被模型照做）。
 *  返回归一后的三态；第一行认不出 ⇒ null。 */
function verdictFromFirstLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  // 允许首行形如 `结论：worth`（冒号前的标签一并去掉）
  const head = lines[0].replace(/^[^:：]{0,8}[:：]\s*/, '')
  return normalizeVerdict(head)
}

/**
 * 散文兜底：正文里**恰好出现一种**结论词 ⇒ 认它；出现多种 ⇒ **拒绝**（宁缺勿滥）。
 *
 * 为什么要求"恰好一种"：散文里同时提到三个词很常见（"如果…就值得，若…则存疑，一次性则不成立"
 * 是在讨论判据，不是在给结论）。那时任何选择都是替模型下结论 ⇒ 老实判 unparsable。
 */
function verdictFromProse(text) {
  const s = String(text || '').toLowerCase()
  if (!s.trim()) return null
  const found = new Set()
  // ASCII 词要词边界（避免 'worthless'/'doubtfully' 误命中）；中文词直接包含即可
  for (const [alias, canonical] of Object.entries(VERDICT_ALIASES)) {
    const hit = /^[a-z]+$/.test(alias)
      ? new RegExp(`(?<![a-z])${alias}(?![a-z])`).test(s)
      : s.includes(alias)
    if (hit) found.add(canonical)
  }
  return found.size === 1 ? [...found][0] : null
}

/**
 * 解析模型输出 → 评审结论（**模型输出不可信**，故这里全是硬判定）。
 *
 * 提取顺序（①②③ 覆盖"格式没照做"的真实空间，④ 才是放弃）：
 *   ① **JSON 对象**（容错：代码围栏 / 前言 / 美化多行 / 裸换行 / `reason` 内联花括号）
 *   ② **行式协议**：首行只有结论词（推荐格式，见提示词）
 *   ③ **散文兜底**：正文里**恰好出现一种**结论词 ⇒ 认它；出现多种 ⇒ 拒绝
 *   ④ 都取不到 ⇒ `unparsable`
 * ★ 返回值带 `via`（'json'|'line'|'prose'）：**诊断用** —— 下次失败一眼看出命中/未命中哪条路径，
 *   不必再来回猜（前三轮"盲改解析器"的教训）。
 *
 * 纪律（宁缺勿滥：解析不了就**不落 review 字段**，而不是猜一个）：
 *   · verdict 认不出（含 `maybe`/`可能`/`看情况` 这类需要"猜"的词）⇒ `{ok:false, reason:'unparsable'}`；
 *   · 但**中英对译**是认的（`值得`=worth 等，见 VERDICT_ALIASES）—— 界面与提示词都是中文，
 *     模型回中文结论是**正常写法**，不是"不守格式"；
 *   · reason 缺失或空白 ⇒ 同样 `unparsable`（只有结论没有理由 = 用户无法据它决策，等于没评）；
 *   · reason 超 200 字符 ⇒ 截断到 200 + 追加 `…`，并标 `truncated:true`；
 *   · 空白（含换行）归一成单空格：面向前端的单行展示（tooltip），不改变语义。
 * ★ **不把模型输出当代码/路径用**：返回值只有 `verdict`（枚举内的字面量）+ `reason`（纯展示文本），
 *   没有任何字段会被当作路径、命令或配置值消费（下游只做展示与分档）。
 *
 * @param {string} text 模型输出的原文
 * @returns {{ok:true, review:{verdict:string, reason:string, via:string, truncated?:true}}|{ok:false, reason:string}}
 */
export function parseReviewVerdict(text) {
  const raw = typeof text === 'string' ? text : ''
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const bound = (reason) => {
    const truncated = reason.length > REVIEW_REASON_MAX
    return { reason: truncated ? reason.slice(0, REVIEW_REASON_MAX) + REVIEW_REASON_ELLIPSIS : reason, truncated }
  }
  /**
   * 拼成功返回值。
   * ★ 必须写 JSDoc 标 `ok: true`（字面量）：否则 TS 把 `ok` 推断成 `boolean` ⇒ 与
   *   `parseReviewVerdict` 声明的联合返回类型不兼容 ⇒ `tsconfig.backend.json` 域报 3 个错
   *   （T1/T3 棘轮门当场拦下，本仓实测）。
   * @param {string} verdict
   * @param {string} reason
   * @param {'json'|'line'|'prose'} via
   * @returns {{ok: true, review: {verdict: string, reason: string, via: string, truncated?: true}}}
   */
  const ok = (verdict, reason, via) => {
    const b = bound(reason)
    return b.truncated
      ? { ok: true, review: { verdict, reason: b.reason, via, truncated: /** @type {true} */ (true) } }
      : { ok: true, review: { verdict, reason: b.reason, via } }
  }

  // ① JSON 对象（含容错）
  const obj = extractJsonObject(raw)
  const fromJson = normalizeVerdict(obj?.verdict)
  if (fromJson) {
    const reason = clean(obj?.reason)
    if (reason) return ok(fromJson, reason, 'json')
  }

  // ② 行式协议：首行结论词 + 其余为理由
  const fromLine = verdictFromFirstLine(raw)
  if (fromLine) {
    const rest = clean(String(raw).split('\n').slice(1).join(' '))
    // 理由缺失时用**整段**原文当理由（含结论词那行）：总比"只有结论没有理由"有用，
    // 且这是**展示**用途、不是解析用途 ⇒ 不算放宽判定（结论词本身仍是硬判出来的）。
    const reason = rest || clean(raw)
    if (reason) return ok(fromLine, reason, 'line')
  }

  // ③ 散文兜底：恰好一种结论词
  const fromProse = verdictFromProse(raw)
  if (fromProse) {
    const reason = clean(raw)
    if (reason) return ok(fromProse, reason, 'prose')
  }

  return { ok: false, reason: 'unparsable' }
}
