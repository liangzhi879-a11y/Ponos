// kernel/readonly.mjs —— kernel 只读子命令（spec 2026-09-08 agentloop U1/AS1）
// ---------------------------------------------------------------------------
// --usage / --audit / --agents 的聚合实现。数据源 = kernel 自身 transcript
// （<configDir>/projects/<cwd-san>/<sessionId>.jsonl）。纯本地只读，由 cli.mjs
// 在进入 loop 前短路调用（stdout JSON）。bridge 只做 HTTP 薄转发，不做跨模块 import。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateUsage } from './stats.mjs'
import { buildAuditReport } from './audit.mjs'
import { costOf } from './cost.mjs'
import { resolveAgents, discoverUserAgents } from './agents.mjs'

// ── K2.2 文件级剪枝：把日期窗口下推成 **mtime 下界**（2026-09-13 系统性优化 Task 9）───────
// 病灶：下方循环是**先整文件 readFileSync + 逐行 JSON.parse，最后才按 ts 过滤**（原实现连
// statSync 都没有）。于是 `--scope today` 的代价 = 全量历史，实测真机 36.8MB/134 文件
// 520ms，而其中只有 10 个文件（5.7MB）沾今天——**92.5% 的字节是白读白解的**。
// 剪枝是**单边**的（只剪"早于窗口起点"的文件）：晚于窗口的文件**不能**剪——append-only 只
// 保证不重写，不保证按日期分文件，一个今天写过的文件完全可能包含上个月的条目。
//
// **可靠性论证**（为什么「mtime < 窗口起点 ⇒ 无合格条目」成立）：
//   1. transcript 是 append-only：`session.mjs` 只 append；`setEntryUsage` 的整文件重写
//      （writeFileSync(tmp)+renameSync）只会把 mtime 推**后**，不会提前。
//   2. 每行的 `timestamp` = 写入时刻的 `new Date().toISOString()` ⇒ ts ≈ 该行的写入时刻；
//      而 mtime = **最后一次**写入时刻 ≥ 任意一行的写入时刻。
//   3. 故「某行 ts 的日期 ≥ from」⇒ 该行写入时刻 ≥ from 的 UTC 零点。取逆否：mtime 早于
//      from 零点 ⇒ 每一行的写入时刻都早于 from 零点 ⇒（**在时钟单调的前提下**）无合格行。
//   4. 破坏第 3 条的唯一途径 = 在「取 ts」与「落盘」之间发生**时钟回跳**（NTP/手动校时）：
//      ts 落在窗口内、落盘却发生在窗口之前 ⇒ mtime 早于窗口起点，该行被漏掉。这个窗口只有
//      微秒级，且必须恰好跨过 UTC 零点。故再加 `MTIME_SAFETY_MS`（1 小时）边距，把"零点前后
//      一小时"整段排除在剪枝之外（这一段的文件一律照读）。代价可忽略（一天里 1/24 的文件）。
//   5. **残余风险（诚实标注）**：回跳幅度 > 1 小时且恰好跨零点 ⇒ 仍会**静默少算**。方向与
//      K2.0 修掉的「多算」相反，故保留一键开关 `PONOS_USAGE_MTIME_PRUNE=0`（默认开：真机
//      每次 520ms → 剪枝后约 2 倍收益，且只多付一次 stat，134 文件实测 8ms）。
//   **env 必须在此处惰性读**：cli.mjs 的 settings.env 注入发生在所有 ESM 模块求值之后
//   （同 perf.mjs 的坑），写成模块级常量会拿不到。
const MTIME_SAFETY_MS = 3_600_000

/** from（YYYY-MM-DD）→ mtime 下界（毫秒）；不可用/开关关闭时返回 0 = 不剪枝
 *  （导出给测试直接锁住"哪些输入才允许剪枝"——这是**安全关键**的判据，必须可单测） */
export function mtimeCutoff(from) {
  if (process.env.PONOS_USAGE_MTIME_PRUNE === '0') return 0
  // 严格日期格式才剪。实测 Date.parse 的宽松解析能吃掉 '2019' / '2020' 这类年份前缀
  // （→ 该年 1 月 1 日）；当前它们算出的 cutoff 恰好偏**早**（= 保守，行为不变），但把
  // 正确性寄托在"宽松解析的落点恰好更保守"上太脆 —— 故用正则把非严格日期整类挡在
  // 不剪枝的一侧（宁可多读，不可漏算）。见 readonly-mtime-prune.test.mjs 的直接断言。
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return 0
  const t = Date.parse(`${from}T00:00:00.000Z`)
  return Number.isNaN(t) ? 0 : t - MTIME_SAFETY_MS
}

// 遍历 <configDir>/projects/<dir>/*.jsonl，逐行读 transcript 并注入 e.sessionId
// （文件名去 .jsonl）与 e.project（子目录名）；from/to 按 entry.timestamp 前 10 位
// （YYYY-MM-DD）过滤；sessionId/project 过滤在调用方传入后于此处合并执行。
export function collectTranscriptFiles({ configDir = '', sessionId = '', project = '', from = '', to = '' } = {}) {
  const entries = []
  const root = join(configDir, 'projects')
  if (!existsSync(root)) return entries
  const cutoff = mtimeCutoff(from)
  let dirs = []
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return entries }
  for (const d of dirs) {
    const dirName = d.name
    if (project && dirName !== project) continue
    const dirPath = join(root, dirName)
    let files = []
    try { files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const sid = f.slice(0, -'.jsonl'.length)
      if (sessionId && sid !== sessionId) continue
      const abs = join(dirPath, f)
      if (cutoff) {
        // stat 失败一律**不剪**（退化为现状行为，绝不因剪枝而漏数据）
        let st = null
        try { st = statSync(abs) } catch { st = null }
        if (st && st.mtimeMs < cutoff) continue
      }
      let text = ''
      try { text = readFileSync(abs, 'utf-8') } catch { continue }
      // 【S2-D4 归属字段读取】meta 首行携带会话级 `authorId`/`workspaceId`（session.mjs 写入）。
      // 逐 entry 注入而非逐条读取：归属是**会话级**属性，且 meta 是该文件首行 ⇒ 单次解析即可覆盖
      // 整个文件，与既有 `sessionId`/`project` 的注入方式同层同模式，`aggregateUsage` 因此仍是纯函数。
      // 旧文件（D4 之前）没有这两个字段 ⇒ **不伪造默认值**，宁可在 byAuthor 里落 `unknown` 桶：
      // 伪造会让"从未记录过归属的历史数据"看起来像"已归属"，掩盖了需要迁移的那部分。
      let fileAttribution = null
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        let e = null
        try { e = JSON.parse(t) } catch { continue }
        // 会话级归属只认 meta 行；取到即固定，后续 entry 沿用（D4 之后每个文件首行都有）
        if (!fileAttribution && e && e.type === 'meta') {
          const a = {}
          if (e.authorId) a.authorId = e.authorId
          if (e.workspaceId) a.workspaceId = e.workspaceId
          fileAttribution = a
        }
        const ts = String(e.timestamp || '')
        if (from && ts.slice(0, 10) < from) continue
        if (to && ts.slice(0, 10) > to) continue
        entries.push({ ...e, sessionId: sid, project: dirName, ...(fileAttribution || {}) })
      }
    }
  }
  return entries
}

function readPriceEnv(env = process.env) {
  return {
    pricePerMInput: Number(env.PONOS_PRICE_PER_M_INPUT) || 0.2,
    pricePerMOutput: Number(env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
    cacheReadRatio: Number(env.PONOS_CACHE_READ_RATIO) || 0.1,
    // P0-5：缓存写入溢价（默认 1.25 = Anthropic 5 分钟档；1 小时 TTL 传 2）
    cacheWriteRatio: Number(env.PONOS_PRICE_CACHE_WRITE_RATIO) || 1.25,
  }
}

// 今日窗口的 UTC 日界（K2.0，2026-09-13 系统性优化）。**三处必须同源**：transcript 的
// timestamp 由 session.mjs 的 `new Date().toISOString()` 写入，stats.mjs byDate 按
// `ts.slice(0,10)` 分桶，日期过滤也按 `ts.slice(0,10)` 比较（见上）⇒ 同一个 UTC 日界。
// **不可改成本地日界**：本地 from 配 UTC 切片，会把「本地今天 00:00–08:00（UTC+8 的上午）」
// 的条目当成昨天而漏掉——错误方向是**静默少算**，比现在的多算更隐蔽。now 可注
// （测试用，避开跨零点抖动）。
export function todayFrom(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

export function runUsage({ configDir = '', sessionId = '', project = '', from = '', to = '', scope = 'all', now } = {}) {
  // K2.0 日期下推（现存 bug 修复）：`scope` 此前**只**驱动 bySession 开关（:58 的
  // `scope === 'session'`），from/to 恒取自 args ⇒ `scope='today'` 与 `'all'` 的计算量完全
  // 相同（都是全量历史聚合），而唯一的调用方把它当「今日」用：驾驶舱卡
  // （useCockpitOverview.ts:141 `fetchUsage({scope:'today'})`，每 5s 轮询、GUI 侧超时也正好
  // 5s）与卡片文案「今日 / requests=今日 turns」。故把 today 真正下推成日期过滤。
  // **收益边界（实测，勿高估）**：过滤发生在 collectTranscriptFiles 的**逐行 parse 之后**
  // （见上 `ts.slice(0,10)` 比较），故省掉的是**聚合**（48000 条 557.6ms → 477.3ms，14%），
  // **解析一分未省**（470.7ms，占绝对大头）。本改动的价值是**正确性**（数字与「今日」文案
  // 终于对得上），性能大头在 K2.2 的剪枝与水位线缓存（只解析当天文件 ≈ 14.2ms）。
  // scope 的两类语义（文档化的 2026-09-08 spec:65 只有 session|project|all，today 是 GUI 引入的）：
  //   session|project|all = **分组维度**（bySession 开关），过滤靠独立的 sessionId/project 参数；
  //   today               = **时间窗口**，是本函数新支持的语义。
  // 窗口取**闭区间** [今天, 今天]，from 与 to 都要推导——只给 from 会让窗口变成
  // `[今天, ∞)`，机器时钟回跳/NTP 校正写出的"未来条目"会被算进「今日」（静默多算，
  // 正是本次要修的病灶方向）。显式传入的 from/to 各自优先于推导值（它们是文档化契约里
  // 更具体的参数；实际没有调用方与 scope=today 同时传）。
  const isToday = scope === 'today'
  const day = isToday ? todayFrom(now) : ''
  const entries = collectTranscriptFiles({
    configDir, sessionId, project,
    from: from || day,
    to: to || day,
  })
  const agg = aggregateUsage(entries, { bySession: scope === 'session' })
  const prices = readPriceEnv()
  const byModelCostUsd = {}
  let costUsd = 0
  for (const [m, bucket] of Object.entries(agg.byModel)) {
    const c = costOf(bucket, prices)
    byModelCostUsd[m] = Number(c.toFixed(4))
    costUsd += c
  }
  const budgetUsd = Number(process.env.PONOS_BUDGET_USD) || 0
  return {
    totals: agg.totals,
    byModel: agg.byModel,
    byProject: agg.byProject,
    byDate: agg.byDate,
    byTool: agg.byTool,
    cacheRate: Number(agg.cacheRate.toFixed(4)),
    costUsd: Number(costUsd.toFixed(4)),
    byModelCostUsd,
    budgetUsd,
    overBudget: budgetUsd > 0 && costUsd > budgetUsd,
    ...(scope === 'session' ? { bySession: agg.bySession } : {}),
  }
}

export function runAudit({ configDir = '', sessionId = '', from = '', to = '' } = {}) {
  const entries = collectTranscriptFiles({ configDir, sessionId, from, to })
  return buildAuditReport(entries, { from, to, sessionId })
}

export function runAgents({ configDir = '' } = {}) {
  const userIds = new Set(discoverUserAgents({ configDir }).map((a) => a.id))
  return resolveAgents({ configDir }).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    model: a.model || '',
    tools: a.tools || [],
    skills: a.skills || [],
    source: userIds.has(a.id) ? 'user' : 'builtin',
  }))
}

// cli 只读子命令统一入口：返回 { output, code }（code 1 = 无数据之外的失败情形预留）
export function runReadonly({ mode = '', args = {}, configDir = '' }) {
  const common = { configDir, sessionId: args.sessionId || '', project: args.project || '', from: args.from || '', to: args.to || '' }
  if (mode === 'agents') return { output: runAgents({ configDir }), code: 0 }
  if (mode === 'usage') return { output: runUsage({ ...common, scope: args.scope || 'all' }), code: 0 }
  if (mode === 'audit') return { output: runAudit(common), code: 0 }
  return { output: { error: `未知只读子命令：${mode}` }, code: 1 }
}
