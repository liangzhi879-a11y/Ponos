// kernel-tests/review-prompt.test.mjs —— 评审意图拼装 + 结论解析（纯函数；演化 Step C，2026-10-14）
// 跑法：node --test kernel-tests/review-prompt.test.mjs
//
// ## 钉住什么（每条都对应一个"错了用户就会看出来"的失效）
//   ① ★ **白名单更窄**：REVIEW_TOOL_ALLOWLIST 是**独立常量**、不含任何写/执行/出网面，
//      且**不等于** DRAFT_TOOL_ALLOWLIST（防"顺手统一"把写权限带进评审会话 —— 那是**静默扩权**，
//      没有任何一处会因此变红，所以必须在这里钉死）。
//   ② 意图确定性 + 隐私口径（同输入逐字同；只有统计与引用，不含对话正文）+ 三态判据与
//      "只回一行 JSON"的输出要求真在消息里（否则解析侧必然长期 unparsable，白花钱）。
//   ③ ★ **解析不可信输出**：非 JSON / verdict 不在三态内 / 空 / 缺理由 ⇒ `unparsable`；
//      超长 ⇒ 截断到 200 + `…` + `truncated`（且恰好 200 时不截断 —— 防"永远截断"的恒真）；
//      从噪声（前言 + 代码围栏）里取最后那个 JSON，但**合法性一步不放**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEW_TOOL_ALLOWLIST, REVIEW_VERDICTS, REVIEW_REASON_MAX, REVIEW_REASON_ELLIPSIS,
  buildReviewIntent, parseReviewVerdict,
} from '../kernel/review-prompt.mjs'
// 反向对照件：起草白名单（评审**不得**复用/等它 —— 见下方 ①）
import { DRAFT_TOOL_ALLOWLIST } from '../kernel/draft-intent.mjs'

// ── ① 白名单更窄（本步最要害的一条）────────────────────────────────────────

test('★ 评审白名单 = **空**（不给任何工具）—— 评审是"只凭给定事实做判断"', () => {
  // ★★ 2026-10-14 语义变更（用户实测："评审拿不到可信结论，返回 unparsable"）：
  //   原为 ['Read','Grep','Glob']（只读三件套）。核实到的真因：给了三个只读工具却**没给任何可读路径**
  //   （隐私口径决定提示词只有统计与 会话id#seq 引用，不含正文/转录位置）⇒ 会话里的 agent 去"找证据"
  //   （Grep/Glob 乱翻），最后常回一段**散文**而不是那一行 JSON ⇒ 解析必然失败。
  //   ⇒ 改为**空**：事实全部由提示词给全（renderFacts），会话不做任何工具调用。
  //   这比"只读三件套"**更严**（不是放宽）：连读都不可用 ⇒ "评审一个字节都不落盘"从
  //   "靠白名单拦"升级为"结构上不可能"。
  assert.deepEqual([...REVIEW_TOOL_ALLOWLIST], [], '评审不给任何工具（理由见 kernel/review-prompt.mjs 常量注释）')
  for (const n of ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'SkillDraft', 'Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'TodoWrite', 'Workflow', 'Browser', 'Screen']) {
    assert.ok(!REVIEW_TOOL_ALLOWLIST.includes(n), `评审白名单不得含 ${n}`)
  }
})

test('★ 评审白名单 ≠ 起草白名单（不得复用/派生），且**严格更窄**（空集是任何集合的真子集）', () => {
  assert.notDeepEqual([...REVIEW_TOOL_ALLOWLIST], [...DRAFT_TOOL_ALLOWLIST],
    '★ 两处语义不同：起草要写草案（含 Write/Edit/SkillDraft），评审一个字节都不落盘 ⇒ 各自独立，不许统一')
  // 真子集判据（2026-10-14 起评审侧为空集）：起草有、评审没有的 = 起草全量
  const onlyDraft = DRAFT_TOOL_ALLOWLIST.filter((n) => !REVIEW_TOOL_ALLOWLIST.includes(n))
  assert.deepEqual([...onlyDraft].sort(), [...DRAFT_TOOL_ALLOWLIST].sort(),
    '评审必须比起草**严格更窄**（现在是一个工具都不给）—— 若这里少了谁，说明有人把评审白名单改宽了')
})

test('三态枚举封闭且有序（视图排序口径 = worth → doubtful → invalid）', () => {
  assert.deepEqual([...REVIEW_VERDICTS], ['worth', 'doubtful', 'invalid'], '三态顺序即降档严重度')
})

// ── ② 意图拼装（确定性 / 隐私 / 判据齐备）──────────────────────────────────

/** OPP-1 形态候选（含建议、证据引用与**实测事实** —— 事实行是 2026-10-14 加的关键输入）。 */
const CAND = {
  v: 1, id: 'c0000000001', ruleId: 'OPP-1', subject: 'Bash', score: 0.9667, count: 5,
  evidence: [{ sessionId: 's1', seq: 3, ts: '2026-10-08T00:00:00.000Z' }, { sessionId: 's2', seq: null }],
  firstAt: '2026-10-01T00:00:00.000Z', lastAt: '2026-10-08T00:00:00.000Z', state: 'new',
  // metrics 是"事实"的来源：没有它，模型判不动"成因假设站不站得住"（实测 unparsable 的根因之一）
  metrics: { sessions: 3, calls: 8, errRate: 0.3776, baselineRate: 0.0634, multiple: 6, needRate: 0.15 },
  advice: {
    hypoth: [{ code: 'site-unstable', args: { multiple: 3 } }],
    actions: [{ code: 'switch-to-bash', route: 'advice' }],
  },
}

test('意图确定性：同输入逐字同输出（可单测、可复现）；且带候选统计与证据**引用**', () => {
  const a = buildReviewIntent(CAND)
  const b = buildReviewIntent(CAND)
  assert.equal(a, b, '同输入必须逐字同输出（无时钟/无随机/无顺序依赖）')
  assert.match(a, /【演进评审】候选 c0000000001（OPP-1 · Bash）/)
  // ★ 2026-10-14：原来只有「命中 N 次；评分 S」——模型看不到任何实际数字 ⇒ 判不动 ⇒ 常给散文
  //   （用户实测 unparsable）。现在改为**事实行**（key=value，语言中立）。
  assert.match(a, /事实（系统实测到的，只有这些）/, '必须有事实行（否则模型只能含糊其辞）')
  assert.match(a, /rule=OPP-1/, '事实行要含规则')
  assert.match(a, /hits=5/, '事实行要含命中次数')
  assert.match(a, /score=0\.9667/, '事实行要含评分')
  assert.match(a, /errRate=37\.8%/, '★ 事实行要含**实测数字**（错误率）—— 这是本次修复的核心')
  assert.match(a, /baselineRate=6\.3%/, '★ 基线也要给（模型才能判"是不是异常"）')
  assert.match(a, /multiple=6/, '★ 倍数由内核算好给出（前端口径一致，不各自算一遍）')
  assert.match(a, /s1#3、s2/, '证据只以可回跳的引用形式出现（无正文）')
  assert.match(a, /site-unstable\(\{"multiple":3\}\)/, '成因假设（code+args）要进消息：评审判的就是它')
  assert.match(a, /switch-to-bash→advice/, '建议方向（code+route）要进消息：判"方向可不可行"要看 route')
  // 隐私口径：消息里不得出现对话正文类字段（候选行本就不该带，防御性钉住）
  for (const banned of ['text', 'content', 'messages', 'transcript']) {
    assert.ok(!new RegExp(`\\b${banned}\\s*[:=]`).test(a), `意图消息不得内联对话正文（${banned}）`)
  }
})

test('★ 事实行（renderFacts）：只给非空事实，无值时如实说"无可用事实"（不臆造）', () => {
  // 真·空候选（连 ruleId/subject 都没有）⇒ 只能如实说"没有事实"，不许编
  assert.match(buildReviewIntent({}), /（无可用事实）/, '没有任何字段 ⇒ 如实说，不编')
  // 只有 ruleId+subject（无 metrics）⇒ 事实行**短但不空**（这两项本身就是事实）
  const bare = buildReviewIntent({ id: 'x', ruleId: 'OPP-3', subject: 's' })
  assert.match(bare, /事实（系统实测到的，只有这些）\*\*：rule=OPP-3 subject=s/, '缺 metrics 时给已有的事实')
  const withFacts = buildReviewIntent(CAND)
  assert.ok(!/=\s*(null|undefined|NaN)/.test(withFacts), '事实行不得出现 null/undefined/NaN（读侧会当噪声）')
})

test('★ 与 A1「深度分析」的区别写进消息：问的是"值不值得"（不是"该怎么做"）', () => {
  const a = buildReviewIntent(CAND)
  assert.match(a, /值不值得落地/, '要判的是价值')
  assert.match(a, /不是"该怎么做"/, '必须点明与"怎么做"不是同一问（否则模型会去产方案 = 白花钱）')
  // 三条判据（成因假设 / 方向可行 / 会不会添乱）逐条在
  for (const kw of ['成因假设站得住吗', '建议方向可行吗', '落地会不会反而添乱']) {
    assert.ok(a.includes(kw), `判据缺失：${kw}`)
  }
})

test('★ 输出契约在消息里：**两种格式都给样例**（行式推荐 + JSON 备选）+ 中文结论词 + 不许写文件 + 明说没有工具', () => {
  const a = buildReviewIntent(CAND)
  // ★ 2026-10-14 第三次反馈后改：推荐格式从"一行 JSON"改为**行式**（第一行只写结论词）。
  //   理由：让模型"只写一个词"比"写合法 JSON"容易得多（不用转义、不用配括号）——
  //   前三轮一直没解决 unparsable，根因之一就是死守 JSON 这一种格式。
  assert.match(a, /第一行只写结论词/, '必须给出**行式**推荐格式（最不容易出错的形态）')
  assert.match(a, /也可以（一行 JSON）/, 'JSON 作为备选也要在提示里（两种都接受）')
  // 两个样例都要**逐字**给出（模型照抄样例的成功率远高于照搬模板）
  assert.match(a, /\{"verdict":"worth","reason":"≤200 字的理由"\}/, 'JSON 样例要逐字给出')
  assert.match(a, /worth\s*\n\s*错误率 37\.8% 远高于基线/, '行式样例要逐字给出（结论词 + 理由）')
  // 中文结论词**明确声明接受**：界面与提示词都是中文，模型回中文是正常写法（旧实现只认 ASCII ⇒ 必然失败）
  assert.match(a, /worth \/ 值得/, '必须明说中文写法同样接受')
  for (const v of REVIEW_VERDICTS) assert.ok(a.includes(`${v} /`), `三态缺 ${v}（含中文对照）`)
  assert.match(a, /不得写\/改任何文件/, '写禁令要在消息里（构造性防线之外的第二层）')
  assert.match(a, /你没有工具、也读不到任何会话记录/, '必须明说没有工具（否则模型会尝试调用并被拒）')
  assert.match(a, /只依据上面给出的事实/, '把模型的注意力钉在给定事实上')
  assert.match(a, /不得编造证据：事实不足时按"存疑"如实说/, '无事实不许编（与本仓"不臆造"一致）')
})

test('无建议 / 无证据 / 无既有件 ⇒ 如实说"（无）"，不臆造、不开天窗', () => {
  const bare = buildReviewIntent({ id: 'x', ruleId: 'OPP-3', subject: 's' })
  assert.match(bare, /会话引用（仅供你理解"发生在哪"）：（无）/)
  assert.match(bare, /系统的成因假设：（无）/)
  assert.match(bare, /系统的建议方向：（无）/)
  assert.match(bare, /既有相关件：（无）/)
  // 既有件（判"会不会重复/打架"用）只给 id/kind
  const withExisting = buildReviewIntent(CAND, { existingArtifacts: [{ id: 'demo-skill', kind: 'skill' }] })
  assert.match(withExisting, /既有相关件：skill:demo-skill/)
  // 坏输入不抛（缺字段/字符串/数组/undefined 都当空候选）
  for (const bad of [undefined, null, 'x', 7, []]) {
    assert.equal(typeof buildReviewIntent(bad), 'string', `输入 ${JSON.stringify(bad)} 必须回字符串而不是抛`)
  }
})

// ── ③ 解析：三条提取路径 + 拒绝边界（2026-10-14 第三次反馈后重做）────────────
// ★ 为什么重做（复盘）：前三轮都在"盲改解析器"——只在自己**假想**的 JSON 畸形里加容错，
//   从没见过模型的实际回复（原文落在用户 home，开发者读不到）。而界面与提示词都是中文，
//   模型回**中文结论词**或**散文**是最正常不过的写法，旧实现一律 unparsable。
//   新路径：① JSON（含容错）→ ② 行式协议 → ③ 散文里恰好一种结论词；并回传 `via` 留痕。

test('解析① JSON 路径：三态都认（含代码围栏 / 前言噪声）；reason 归一空白；via=json', () => {
  for (const v of REVIEW_VERDICTS) {
    const r = parseReviewVerdict(`{"verdict":"${v}","reason":"理由 A"}`)
    assert.deepEqual(r, { ok: true, review: { verdict: v, reason: '理由 A', via: 'json' } }, `${v} 必须被接受`)
  }
  // 注意 `\\n`：JSON 串里必须是**转义**换行（真换行会让这段 JSON 本身非法，那是夹具写错不是实现错）
  const noise = '我先看了一下证据：\n```json\n{"verdict":"doubtful","reason":"  证据  不足\\n时机未到 "}\n```'
  assert.deepEqual(parseReviewVerdict(noise), { ok: true, review: { verdict: 'doubtful', reason: '证据 不足 时机未到', via: 'json' } },
    '从噪声里取出 JSON 对象；空白归一成单空格（单行展示）')
})

test('解析② 行式协议（推荐格式）：首行只写结论词，其余行为理由；via=line', () => {
  // 为什么加它：让模型"只写一个词在一行"比"写合规 JSON"容易得多（无需转义、无需配括号）。
  assert.deepEqual(parseReviewVerdict('worth\n错误率 37.8% 远高于基线 4.0%，且横跨 5 个会话复现。'),
    { ok: true, review: { verdict: 'worth', reason: '错误率 37.8% 远高于基线 4.0%，且横跨 5 个会话复现。', via: 'line' } })
  // 允许多行的理由（合成一行展示）
  assert.equal(parseReviewVerdict('doubtful\n证据不足，\n时机未到').review.reason, '证据不足， 时机未到')
  // 允许首行带标签（`结论：worth`）
  assert.equal(parseReviewVerdict('结论：invalid\n一次性事故').review.verdict, 'invalid')
  // 首行就是结论词、但**没有理由行** ⇒ 理由回落为整段原文（比"只有结论无理由"更有用；via 留痕可追责）
  const noReason = parseReviewVerdict('worth')
  assert.equal(noReason.ok, true)
  assert.equal(noReason.review.reason, 'worth')
})

test('解析③ 散文兜底 + 中文对译（★ 本轮最可能的真因）：界面/提示词都是中文，模型回中文是正常写法', () => {
  // 这三条在旧实现里**全部 unparsable** —— 而它们恰恰是最可能一直在发生的形态。
  assert.deepEqual(parseReviewVerdict('{"verdict":"值得","reason":"跨 5 个会话复现"}'),
    { ok: true, review: { verdict: 'worth', reason: '跨 5 个会话复现', via: 'json' } }, '中文结论词也要认（json 路径）')
  assert.deepEqual(parseReviewVerdict('值得\n错误率显著高于基线').review,
    { verdict: 'worth', reason: '错误率显著高于基线', via: 'line' }, '中文首行也要认（行式）')
  const prose = parseReviewVerdict('我判断这条值得做，因为错误率是基线的 9 倍且跨 5 个会话复现。')
  assert.equal(prose.ok, true, '★ 纯中文散文里带唯一结论词 ⇒ 认（旧实现在这里必然失败）')
  assert.equal(prose.review.verdict, 'worth')
  assert.equal(prose.review.via, 'prose')
  // 英文散文同理
  assert.equal(parseReviewVerdict('This looks doubtful given a single session only.').review.verdict, 'doubtful')
})

test('★★ 拒绝边界（宁缺勿滥的核心）：无结论词 / 多种结论词 / 需猜的词 ⇒ 一律 unparsable', () => {
  // ① 多词歧义：散文里同时提到三个词，是在**讨论判据**而不是给结论 ⇒ 任何选择都是替模型下结论
  assert.deepEqual(parseReviewVerdict('如果跨会话复现就值得，只出现一次则存疑，若是一次性事故则不成立。'),
    { ok: false, reason: 'unparsable' }, '★ 恰好一种才认；三种同时出现必须拒绝')
  // ② 完全没有结论词
  for (const t of ['', '   ', '我无法判断这条是否有价值。', '理由里提到 { 这个符号但没给结论']) {
    assert.deepEqual(parseReviewVerdict(t), { ok: false, reason: 'unparsable' }, `无结论词 ⇒ unparsable：${JSON.stringify(t)}`)
  }
  // ③ 需要"猜"的近义词**不认**；连写的 `worthwhile` 也不认（那是**另一个词**，不是结论词）
  for (const near of ['maybe', 'possible', 'yes', 'worthwhile', '不确定', '看情况']) {
    assert.deepEqual(parseReviewVerdict(`这条 ${near}`), { ok: false, reason: 'unparsable' },
      `${near} 属"需要猜"的写法，不得被映射成三态`)
  }
  // ★ 边界说明（不是缺陷）：**空格分开**的 `worth while` 会让 `worth` 成为独立词 ⇒ 会被认成 worth。
  //   留这条断言是把该行为**钉住并说明**：我们认"模型自己写下的独立结论词"，
  //   但不认"需要解释意图的连写词"（worthwhile）。两者语义不同，别混。
  assert.equal(parseReviewVerdict('这条 worth while').review.verdict, 'worth',
    '空格分开 ⇒ worth 是独立词（认）；连写 worthwhile ⇒ 另一个词（不认）')
  // ④ 非字符串输入
  for (const t of [undefined, null, 7, {}, []]) {
    assert.deepEqual(parseReviewVerdict(t), { ok: false, reason: 'unparsable' }, `非字符串 ⇒ unparsable：${JSON.stringify(t)}`)
  }
})

test('★ 语义变更留痕：畸形 JSON 但**结论词唯一**⇒ 认（via=prose），不再一律失败', () => {
  // ★ 这是本轮的**行为变更**（不是放宽断言）：旧实现把这些一律 unparsable，于是用户白花一次评审钱。
  //   新判据：只要模型**自己说了**唯一一个结论词，就用它（理由回落为原文），`via:'prose'` 留痕可追责。
  //   ★ 真正的红线仍是"不许猜"：见上一条（多词歧义/需猜的词 一律拒绝）。
  const cases = [
    ["{'verdict':'worth','reason':'单引号'}", 'worth'],
    ['{"verdict":"worth","reason":"尾逗号",}', 'worth'],
    ['{"verdict":worth,"reason":"缺引号"}', 'worth'],
    ['{"verdict":"worth" "reason":"缺分隔"}', 'worth'],
    ['前言 {"verdict":"worth","reason":"被截', 'worth'],
    ['[{"verdict":"worth","reason":"x"}]', 'worth'],
    ['{"verdict":"worth"}', 'worth'],
  ]
  for (const [malformed, expected] of cases) {
    const r = parseReviewVerdict(malformed)
    assert.equal(r.ok, true, `${malformed} 里结论词唯一 ⇒ 应认（旧实现一律失败）`)
    assert.equal(r.review.verdict, expected)
    assert.equal(r.review.via, 'prose', '必须留痕：这是散文兜底取到的，不是结构化解析')
  }
})

test('★ 解析：多行 reason（JSON 里裸换行）可救回，但**只救这一种**结构畸形', () => {
  // 为什么救它：JSON 不允许字符串内有裸换行，而"reason 写成多行"是模型最常见的形态之一；
  // 不救 ⇒ 用户白花一次评审钱。为什么不救别的：其余畸形需要判断"模型想写什么"= 替模型改写输出。
  //   ★ 注意边界：其余畸形若含**唯一结论词**仍会被 ③ 兜底认下（见上一条），
  //   但那是"用模型自己说的词"，不是"替它改写结构" —— 两件事，别混。
  const multiLine = '{\n  "verdict": "worth",\n  "reason": "错误率 37.8%, 远高于基线\n且跨 5 个会话复现"\n}'
  assert.deepEqual(parseReviewVerdict(multiLine),
    { ok: true, review: { verdict: 'worth', reason: '错误率 37.8%, 远高于基线 且跨 5 个会话复现', via: 'json' } },
    '裸换行的 reason 要能救回（空白归一成单空格），且仍走 json 路径')
})

test('★ 解析：美化输出 / reason 内含花括号 / 前言 + 多行对象，都要能取出（via=json）', () => {
  const pretty = '判断如下：\n```json\n{\n  "verdict": "worth",\n  "reason": "错误率显著高于基线"\n}\n```'
  assert.equal(parseReviewVerdict(pretty).review.via, 'json', '美化输出（{ 单独一行）必须能取出')
  const nested = '结论：\n{"verdict":"doubtful","reason":"你要求的形如 {\\"verdict\\":\\"worth\\"} 的样例对这条不合适"}'
  assert.deepEqual(parseReviewVerdict(nested).review,
    { verdict: 'doubtful', reason: '你要求的形如 {"verdict":"worth"} 的样例对这条不合适', via: 'json' },
    'reason 内含花括号：必须跳到**字符串外**配对（否则会错取内层那个小对象）')
  const dirty = '我看了事实：\n\n- 错误率 37.8%\n\n{\n "verdict": "invalid",\n "reason": "这是一次性事故，\n不是可复用模式"\n}'
  assert.equal(parseReviewVerdict(dirty).review.verdict, 'invalid')
})

test('★ 解析超长理由：截断到 200 + 追加 …（并标记 truncated）；恰好 200 不截断（防恒真）', () => {
  const long = parseReviewVerdict(JSON.stringify({ verdict: 'worth', reason: 'x'.repeat(500) }))
  assert.equal(long.ok, true)
  assert.equal(long.review.truncated, true, '截断必须标记（读侧/界面要知道这不是全文）')
  assert.equal(long.review.reason, 'x'.repeat(REVIEW_REASON_MAX) + REVIEW_REASON_ELLIPSIS)
  assert.equal(long.review.reason.length, REVIEW_REASON_MAX + 1)
  // 边界反证：恰好 200 字符 ⇒ **不**截断、**不**带 truncated（防"永远截断"的恒真断言）
  const exact = parseReviewVerdict(JSON.stringify({ verdict: 'invalid', reason: 'y'.repeat(REVIEW_REASON_MAX) }))
  assert.equal(exact.review.reason, 'y'.repeat(REVIEW_REASON_MAX))
  assert.equal('truncated' in exact.review, false)
  // 201 字符 ⇒ 截断（边界另一侧）
  const over = parseReviewVerdict(JSON.stringify({ verdict: 'invalid', reason: 'y'.repeat(REVIEW_REASON_MAX + 1) }))
  assert.equal(over.review.truncated, true)
})

test('解析结果只含展示用字面量（verdict 在枚举内 + reason/via 是文本）—— 不产出任何路径/命令字段', () => {
  const r = parseReviewVerdict('{"verdict":"worth","reason":"可以落地","path":"/etc/passwd","cmd":"rm -rf /"}')
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.review).sort(), ['reason', 'verdict', 'via'],
    '★ 模型输出里的其它键**一律不进结论**（不把模型输出当代码/路径用）')
  assert.ok(REVIEW_VERDICTS.includes(r.review.verdict))
  assert.ok(['json', 'line', 'prose'].includes(r.review.via), 'via 必须来自受控枚举（诊断留痕用）')
})
