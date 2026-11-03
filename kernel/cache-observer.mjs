// Ponos-turbo 前缀缓存观测器（2026-09-18 spec：docs/superpowers/specs/2026-09-18-prefix-cache-observability-design.md §3.2/§5）
// ---------------------------------------------------------------------------
// 职责：把「每请求的 usage 快照」判成四态并累计统计，供 engine 落 stderr / 进 turnStats。
//   ok          命中正常
//   suspicious  可疑失效（**唯一值得深挖的态**）
//   compacted   预期性失效（紧跟压缩/收缩之后，不算异常）
//   unsupported 端点无缓存字段（静默）
//
// 为什么独立成文件而不进 context.mjs：后者头注锁定「零依赖纯函数、全部确定性」，
// 而本模块有状态（跨请求保持 prev、归因计数）——定位不同，分开也更好测。
//
// ★ 判定纪律（不误报优先于抓全）：三重约束缺一不可——
//   ① prev.read >= minRead（小请求无缓存可失，纯噪声）
//   ② cur.read < prev.read × (1 − dropRatio)（真骤降，非抖动）
//   ③ drop > 净收缩量 × (1 + sizeTol)（**read 断崖**：损失超出"少发内容"可解释的范围）
// 第 ③ 条最易漏：请求面大幅缩小是压缩/裁剪的**正常规模效应**，read 随之下降不是失效。
// 实测教训：首版探针用 ±30% 容差 + 轮级聚合口径，372 样本只命中 1 例失效。
//
// ★★ 第 ③ 条已于 2026-09-18（用户裁定 D）由「请求面相当」改造为「read 断崖」——
//   原判据是 `sizeSimilar`（|Δtotal|/prev.total <= sizeTol，即"请求面相当"），它与判据 ⑦
//   （收缩 > 30%）之间留出 **10%~30% 的无覆盖带**：落在该带的真失效被判 ⑥ ok/minor-drop。
//   实测（用户会话 302 行）漏掉 **195,456 tokens = 实测损失的 44%**（3 起，收缩比 11.5%/14.5%/22.5%，
//   命中率断崖至 0.25/0.54/0.64）。新形式的数学依据与实现见判据 ⑤ 处的注释；
//   `sizeTol` 的语义随之由"请求面容差"变为"**净收缩量的容忍系数**"
//   （**参数名 / env 名 / 默认值都不变**，接口兼容）。
//
// ★ 归因判据用 contentEpoch，而非「压缩后第几次请求」的调用点标记（v2 A1）：
//   compactCount / replaceGeneration 只在 **summary 落地**时 +1（session.mjs:146/:408），
//   而 aged/pruned 是改块内容不改数组结构（request-face.mjs:174）——调用点标记只能覆盖
//   手工挑中的两处，未来新增改写点必然漏报。`line contentEpoch` 按代码库自身设计「紧邻
//   改写点、可证无遗漏」（见 context.mjs:143-146 头注三条依据），故它才是正确的仪器。
//   语义切分：**epoch 决定"是否预期性失效"（可靠判据），causeHint 只决定"叫什么名字"
//   （尽力标签）**——二者解耦后，偶发漏标只让 cause 退化为 history-rewrite，不会把
//   预期性失效误报成 suspicious。
//
// ★★ summary 压缩需要**第二个独立信号**（2026-09-18 用户裁定，v2 绑定修订 C）：
//   上面那条"epoch 可证无遗漏"对**原地改写**成立，但对**摘要落地**不成立——摘要落地按设计
//   是"换对象而非改内容"（`appendCompactionSummary` 替换 surface 区间、**不**改块内容），
//   故它**不** bump contentEpoch。实测后果（评审给出的第一手结论）：
//     · 纯 summary 压缩后 epoch 不变 ⇒ cause=null ⇒ `noteCompaction()` 的标签被
//       observe **静默丢弃** ⇒ `cause=post-compaction` 在 epoch 语义下**不可达**，
//       spec §5 表格里这一命名无法验收；
//     · 反向错标：压缩**伴随** aged/pruned 原地老化时 epoch 会变，而 hint 若停在
//       `post-compaction`（调用点给的标签）就会把那次老化错标成 post-compaction。
//   ⇒ 判据改为「信号优先」：`summaryGen`（`replaceGeneration`/`compactCount`，二者**只在
//   摘要落地时 +1**）递增 ⇒ cause='post-compaction'（最具体，优先）；epoch 递增但 summary
//   信号未动 ⇒ 走原有 hint / history-rewrite。hint 因此**不再承重**（仅兼容既有接口）。
//   可见性边界：summaryGen 与 epoch 用**同一套双非空守卫** ⇒ 每轮观测器首请求
//   （`lastSummaryGen === null`）不误报，同时规避 session.mjs:145「加载恢复」处的 +1。
import { cacheStats } from './context.mjs'

// sizeTol：**净收缩量的容忍系数**（2026-09-18 用户裁定 D 起；此前语义为"请求面容差"）
const DEFAULTS = { minRead: 20_000, dropRatio: 0.5, sizeTol: 0.1 }

// ★ `sizeTol` 的上下界收敛（2026-09-18 Task 8 / 评审判定 Minor-m-3）：`Number.isFinite` 只挡
//   NaN / ±Infinity，**不设界** ⇒ 两个实测缺陷：
//     · `sizeTol = 1e9` ⇒ 判据⑤ 的阈值 = 净收缩量 × (1 + 1e9) ⇒ "超出"永不成立 ⇒ **判据整体失效**
//       （实测：盲区里那起真失效退化为 `ok`，即静默漏报）；
//     · `sizeTol` 为负 ⇒ 阈值 < 净收缩量（甚至为负）⇒ 门槛变严 ⇒ **放大误报**。
//   ⇒ 收敛到 [0, 1]：**调大 sizeTol 即钝化判据**（吸收更多"少发内容"可解释的损失，越不容易判
//   suspicious）、调小则越敏感（`0` = 严格：`drop > 净收缩量` 即判）。上界 1 = 最多容忍
//   2 倍净收缩量；再大就等价于"关掉判据⑤"，故不允许。
//   ★ 非法输入（`Number('abc') === NaN`、env 未设时的 `Number(undefined) === NaN`）的既有回落
//   行为**保持不变**：落到 `DEFAULTS.sizeTol = 0.1`。
//   ★ 收敛点就在**判据的读取处**（下方 classifyCache 与 createCacheObserver 各一次，后者把
//   已收敛的值经 `...cfg` 传给前者）——`kernel/engine.mjs` 只做 env → 参数的**透传**
//   （`Number(process.env.PONOS_CACHE_SIZE_TOL)`），不参与定界、也不该定界（两处定界会漂移）。
const clampTol = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const tolOf = (v) => clampTol(Number.isFinite(v) ? v : DEFAULTS.sizeTol)

// 纯判定（无状态，便于单测与复用）
// ★ 并入对账（2026-10-09 四条线合并）：参数须显式 JSDoc 声明 —— checkJs 对解构参数只从
//   默认值反推类型（prev/cause 有默认值才有类型，cur 等其余属性一律 TS2339 ⇒ T1/T3 红）。
//   纯注解，零运行时变化。
/**
 * @param {object} [cfg]
 * @param {any} [cfg.prev]
 * @param {any} [cfg.cur]
 * @param {any} [cfg.cause]
 * @param {any} [cfg.minRead]
 * @param {any} [cfg.dropRatio]
 * @param {any} [cfg.sizeTol]
 */
export function classifyCache({ prev = null, cur, cause = null, minRead, dropRatio, sizeTol } = {}) {
  const cfg = {
    minRead: Number.isFinite(minRead) ? minRead : DEFAULTS.minRead,
    dropRatio: Number.isFinite(dropRatio) ? dropRatio : DEFAULTS.dropRatio,
    sizeTol: tolOf(sizeTol),
  }
  const drop = prev ? Math.max(0, prev.read - cur.read) : 0
  // ① 端点本就不支持缓存（前后都不支持）→ unsupported；此处**优先于归因**：
  //    无缓存可言时，"压缩导致失效"是无意义的说法。
  if (!cur.supported && !prev?.supported) return { state: 'unsupported', reason: 'endpoint-no-cache', drop: 0 }
  // ② 归因命中 → compacted（预期性）。压过骤降判定——否则每次压缩/老化都误报一次。
  if (cause) return { state: 'compacted', reason: cause, drop }
  // ③ 上次支持、本次不支持：方向性变化——**端点中途停止上报缓存字段**（真实可得判据：
  //    `supported` 现在由 api.mjs 的 cache_fields_reported 存在性驱动，端点从"上报"变为
  //    "不上报"就是这里）。方向仍是"报出来"而非静默：端点能力退化可能让此后每轮缓存全部
  //    落空（通常是代理/网关改造或换了后端），静默会把它整个藏起来。
  //    ★ 历史说明：2026-09-18 之前本判据在观测器路径下**不可达**——当时 cacheStats.supported
  //    是请求级（read+create>0），观测器另有一层"端点级粘性"兜底把全零请求补成 supported，
  //    于是 ③ 永不被观测器走到。粘性已随 cacheStats 语义修正（存在性信号）删除，③ 恢复可达。
  if (!cur.supported) return { state: 'suspicious', reason: 'cache-fields-vanished', drop }
  // ④ 首个受支持请求：无基准，不判失效
  if (!prev?.supported) return { state: 'ok', reason: 'first-supported', drop: 0 }
  // ⑦ 服务端压缩兜底（v2 A2；按原文置于骤降判定之前）：请求面大幅收缩且 read 同向下降
  //    ⇒ 判预期性（非本地动作所致）。
  //    端点自带压缩（OpenAI /responses/compact、或任何代理层改写）时，本地既无 [compact]
  //    action 也无 epoch 变化，不兜底就会把服务端的正常收缩误报成 suspicious。
  //    ★ 与判据 ⑤ 的关系（2026-09-18 用户裁定 D 后**已重写**）：原注释称"与 ⑤ 的签名在默认
  //    容差（sizeTol ≤ 0.3）下互斥"，该说法**已失效**——⑤ 不再依赖请求面容差（改为 read 断崖，
  //    与请求面变化解耦），故 ⑤ 与 ⑦ **不再互斥**：本判据只对"收缩 > 30%"（= SHRINK_RATIO
  //    那一侧）先行兜底，收缩 ≤ 30% 时由 ⑤ 独立判定。二者由"更宽的一侧先行"变为
  //    "⑦ 只截住大幅收缩、⑤ 覆盖其余"，故 sizeTol 缩放**不再影响** ⑦ 与 ⑤ 的相互作用
  //    （旧注释里"sizeTol 放大到 > 0.3 会让 ⑦ 先于 ⑤ 截住真失效"的推理随之作废）。
  // 判据 ⑦（服务端压缩兜底）的请求面收缩比；env 可覆盖，便于不同端点分别校准。
  // **必须惰性读**：cli.mjs 的 settings.env 注入发生在所有 ESM 模块求值之后（同
  //    PONOS_DYNTOOLS_CACHE，见 cli.mjs:753 的 1:1 先例注释）——写成模块级常量会让经
  //    settings.json / legacy 别名设置的该旋钮被静默忽略、判据 ⑦ 恒用 0.7。
  const SHRINK_RATIO = Number(process.env.PONOS_CACHE_SERVER_SHRINK || 0.7)
  if (prev.supported && cur.supported && prev.total > 0
      && cur.total < prev.total * SHRINK_RATIO && cur.read <= prev.read) {
    return { state: 'compacted', reason: 'server-compact', drop }
  }
  // ⑤ read 断崖 —— 与请求面变化解耦（2026-09-18 用户裁定 D；改造自原三重约束的"请求面相当"）
  //    **数学依据**（注释里写明，便于后来者复核）：
  //      设 prev = (in0, read0)、cur = (in1, read1)，drop = max(0, read0 − read1)，
  //      净收缩量 = max(0, prev.total − cur.total)。
  //      · 若**只发生「删除」**（in1 ≤ in0 且 read1 ≤ read0），则 total 的跌幅 ≤ 单项最大跌幅
  //        ⇒ read 跌幅 ≤ total 跌幅 ⇒ **drop ≤ 净收缩量**；
  //      · **反之，drop > 净收缩量 ⇒ 必然发生了「新增/替换」** ⇒ 该损失无法由"少发内容"解释
  //        ⇒ 这正是"内容被换掉导致缓存未命中"的本质特征（真失效）。
  //    ⇒ 故本判据保留相对骤降（dropRatio，防抖）+ 用 `drop > 净收缩量 × (1 + sizeTol)` 取代
  //      原 `sizeSimilar`（|Δtotal|/prev.total ≤ sizeTol）：**与请求面变化量解耦**。
  //    为什么原判据有盲区：sizeSimilar 要求请求面相当（≤ 10%），判据 ⑦ 要求骤降（收缩 > 30%）
  //      ⇒ **10%~30% 的请求面变化两侧都不点火**，真失效落判据 ⑥ 被判 ok/minor-drop；
  //      实测（2026-09-18 用户会话 302 行）漏掉 195,456 tokens（= 实测损失的 44%，3 起，
  //      收缩比 11.5%/14.5%/22.5%，read 断崖至 0.25/0.54/0.64）。用户裁定改为本判据。
  //    边界语义：净收缩量为 0（请求面持平或增长）时**只有第 ③ 条约束**退化为 `drop > 0`
  //      （容忍系数乘数为 1，不再吸收任何损失）——第 ① 条（`prev.read >= minRead`）与第 ② 条
  //      （`dropRatio` 防抖）**仍然生效**。反证：净收缩量 0 + `read` 只跌 8%（净收缩 0、drop > 0）
  //      ⇒ **不判**（被第 ② 条拦下）。故"退化为单纯的 read 断崖"是**不精确**的旧措辞
  //      （2026-09-18 评审判定 Minor-m-4，已更正）。
  //    **位置不变**：仍在判据 ⑦ 之后（⑦ 只对"收缩 > 30%"先行兜底，二者**不再互斥**）。
  const shrinkAmount = Math.max(0, prev.total - cur.total)
  const shrinkExplainsDrop = drop <= shrinkAmount * (1 + cfg.sizeTol)
  if (prev.read >= cfg.minRead && cur.read < prev.read * (1 - cfg.dropRatio) && !shrinkExplainsDrop) {
    return { state: 'suspicious', reason: 'cache-drop', drop }
  }
  // ⑥ 命中稳定（允许小幅抖动）
  return { state: 'ok', reason: cur.read >= prev.read * 0.9 ? 'stable' : 'minor-drop', drop }
}

// 有状态观测器。**每次 observe 传"该请求最终 usage 快照"**，不是增量——
// api.mjs 的同值去重会让递增快照多次到达（见 spec §8.1 相邻风险），engine 侧已收敛为覆盖。
export function createCacheObserver(opts = {}) {
  const cfg = {
    minRead: Number.isFinite(opts.minRead) ? opts.minRead : DEFAULTS.minRead,
    dropRatio: Number.isFinite(opts.dropRatio) ? opts.dropRatio : DEFAULTS.dropRatio,
    sizeTol: tolOf(opts.sizeTol), // 收敛到 [0, 1]，见文件头 `clampTol` / `tolOf` 的说明
  }
  let prev = null
  let lastEpoch = null
  let lastSummaryGen = null // summary 独立信号（replaceGeneration/compactCount）上一轮取值
  let epochDelta = 0 // 归因过报度量（snapshot 暴露，Task 6 消费）
  // ★ hint 是**一次性**标签：用后置 null（见下方 observe 末尾）。
  //   若改成持久状态，noteShrink() 之后每个请求都会被标成 post-aged，把真实失效掩盖掉
  //   ——Task 5 的 noteShrink() 只在**紧邻的下一个请求**上生效才正确。
  //   ★ 2026-09-18 起 noteCompaction() 同样降级为 hint：summary 检测已自动化（见
  //   `summaryAdvanced`），本方法仅作命名兜底（接口与既有测试继续兼容）。
  let hint = null
  // compactions = `summaryAdvanced` 命中次数（摘要落地次数，**不是** hint 次数）——
  // 与 stats.compacted（判定为预期性失效的请求数）是两个不同口径，勿混用。
  const stats = { requests: 0, ok: 0, suspicious: 0, compacted: 0, unsupported: 0, readTotal: 0, inputTotal: 0, compactions: 0 }
  return {
    // ★ 兼容接口：summary 检测已自动化（observe 的 summaryGen 判据）⇒ 本方法只作
    //   "命名兜底"：仅当 epoch 变而 summary 信号未动时，才由它把 cause 命名得更具体。
    noteCompaction() { hint = 'post-compaction' },
    noteShrink() { hint = 'post-aged' },
    observe(rawUsage, { epoch = null, summaryGen = null, causeHint = null } = {}) {
      // ★ 2026-09-18：此处原有"端点级粘性 supported"（endpointCaching 状态 + judged 副本），
      //   已**删除**——它的存在理由是当时 cacheStats.supported 为请求级（read+create>0），
      //   无法区分"端点无字段"与"本轮真未命中"。根因现已从源头修复：api.mjs 的
      //   normalizeUsage 保留字段存在性（cache_fields_reported）⇒ cacheStats.supported
      //   本身就是"端点具备缓存计量"，无需在观测器里再造一份跨请求状态。
      //   删除后的行为变化（**这是要的效果**）：判据 ③ cache-fields-vanished 恢复可达
      //   （端点中途停止上报缓存字段），而"端点有缓存但本轮未命中"自然落到 ④/⑤/⑥/⑦。
      //   已知限制（随之删除）：原先"端点整体停报"会被粘性误归为 suspicious/cache-drop，
      //   现在会正确地报成 suspicious/cache-fields-vanished。
      const cur = cacheStats(rawUsage)
      // ★ 判据来自 epoch：任何原地改写（aged/pruned/未来新增）都会 +1
      const rewritten = epoch !== null && lastEpoch !== null && epoch !== lastEpoch
      // ★★ summary 专用信号（2026-09-18 用户裁定）：replaceGeneration / compactCount **只在
      //   「摘要落地」时递增**（session.mjs:407/:408；:145/:146 是加载恢复），而摘要落地按设计
      //   不改块内容 ⇒ **不** bump contentEpoch。故 epoch 看不见纯 summary 压缩，必须用独立计数
      //   判定。**双非空守卫**与 epoch 同法：首请求 lastSummaryGen 为 null ⇒ 不误报（同时规避
      //   加载恢复路径的 +1；且观测器每轮新建，首请求本就无 prev 基准，不构成信息损失）。
      const summaryAdvanced = summaryGen !== null && lastSummaryGen !== null && summaryGen !== lastSummaryGen
      // 优先级：summary 落地即压缩，命名最具体 ⇒ 压过通用 history-rewrite。
      let cause = null
      if (summaryAdvanced) cause = 'post-compaction'
      else if (rewritten) cause = causeHint || hint || 'history-rewrite'
      const r = classifyCache({ prev, cur, cause, ...cfg })
      stats.requests++
      stats[r.state] += 1
      stats.readTotal += cur.read
      stats.inputTotal += cur.input
      if (rewritten) { stats.rewrites = (stats.rewrites || 0) + 1; epochDelta += epoch - lastEpoch }
      if (summaryAdvanced) stats.compactions += 1
      // ★ 存基准用**浅拷贝**（Minor-3，零成本防御）：后面返回的 cur 是**同一个对象引用**——
      //   Task 3 若对 r.cur 做任何原地改写，比较基准会被连带污染（症状：下一次判定的
      //   prev.read 悄悄变了）。拷贝后基准与调用方视图彻底解耦（下游的原地改写打不到基准）。
      prev = { ...cur }
      if (epoch !== null) lastEpoch = epoch
      // summary 信号同法：仅当传入非 null 时更新（null = 未接线/无 session ⇒ 该判据整体关闭）
      if (summaryGen !== null) lastSummaryGen = summaryGen
      hint = null // 标签一次性：用在紧接着的第一个请求上
      // 返回的 cur 是 cacheStats 原样快照（存在性口径），**供调用方只读消费**：
      // 需要改写请自行拷贝（改它会让上面的统计口径漂移）。
      return { ...r, cur, seq: stats.requests }
    },
    // 供 Task 6 度量"改写频度 × 缓存损失"的联合指标。
    // ★ rewrites / epochDelta 也是过报的可观测出口：contentEpoch 是**进程级**模块变量
    //   （context.mjs:143），非按会话隔离 ⇒ lane / 子 Agent 的改写会让主会话的请求看起来
    //   "被改写"。误差方向偏保守（多报 compacted、少报 suspicious），即偏向静默而非假警，
    //   可接受；这两个字段用于事后识别这种过报有多少。
    // ★ compactions（2026-09-18 用户裁定重加）：summary 信号命中次数。与 rewrites 解耦——
    //   rewrites 看得见 aged/pruned 而看不见纯 summary 压缩，compactions 恰好相反，
    //   二者并置才能回答"哪一类动作打断了缓存"。口径：**次数**（非请求数），
    //   与 stats.compacted（判定为预期性的请求数）不同——同一信号命中只计一次。
    snapshot() {
      const denom = stats.inputTotal + stats.readTotal
      return { ...stats, rewrites: stats.rewrites || 0, epochDelta, hitRatio: denom > 0 ? stats.readTotal / denom : 0 }
    },
  }
}
