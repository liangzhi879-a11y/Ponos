// 落盘遥测（纯函数）：5 个落盘点的耗时/慢写/失败记录 + 滚动 P95 + "慢盘豁免"判定。
//
// ── 为什么需要它（不是"指标好看"）────────────────────────────────────────────
// ① 同步落盘会击穿心跳豁免 ⇒ 内核"越等磁盘越被判死"：长前台工具是**异步**的（主线程空闲、心跳照发、
//    in-flight 豁免有效），而 5 个落盘点全是**同步** fs 写（appendFileSync/writeFileSync）。同步写阻塞
//    期间主线程完全停摆 ⇒ 心跳定时器也不跑 ⇒ 心跳停发 ⇒ 过期 ⇒ 按静默判死。慢盘/网络盘/AV 扫描
//    会让内核被误杀，而现场没有任何线索指向磁盘。
//    ⇒ 推论（本模块的形态由此决定）：落盘豁免**不能**复用心跳，只能是**事前声明**（写之前发，
//    那时主线程还空闲）。故 judgeDiskWait 是**纯函数**、由调用方在写之前问一次。
// ② 落盘失败是静默的：5 处全被 `catch { /* 磁盘不可写不致命 */ }` 吞掉 ⇒ 磁盘满/只读时用户以为
//    正常，实际什么都没写。"被强杀后能恢复多少"这个问题目前无法回答。
//
// ── 三条纪律（与心跳同源，逐条对应）──────────────────────────────────────────
//   ① 分账：遥测只记"写"的耗时与成败，不推进"最近实质输出"（那是内核输出侧的账）。
//   ② 有界：豁免窗口 = min(P95×2, 上限)，上限默认 120s（远低于失速告警 420s ⇒ 不掩盖真死）。
//   ③ 只掩盖"已知在写"：judgeDiskWait 只在**真有即将发生的写**时被调用；未在写的静默不受豁免。
//   另：窗口**不因多次声明而叠加**——判定是纯函数，同一 P95 恒得同一窗口（见测试）。
//
// ── 两个失败计数 + `health` 判档（2026-09-23 批 2 口径修正，Task 7 复核实测）──────────────
// 现场：L0"立即重试一次"让**一次逻辑写 = 最多 2～3 次 attempt**。若 `health` 仍按"有任何失败"
// 判档，则"被 L0 救回的瞬时 EBUSY"也会报 `failing` ⇒ GUI 红徽标 ⇒ 自愈成功却打扰用户，
// 与总原则（多数问题自愈、单次失败绝不打扰）直接冲突。故把**隐患热度**与**用户可见口径**
// 分成两个计数，`health` 只由后者判档：
//   · `failures`（attempt 级）：每一次失败尝试都记（L0 重试失败 ⇒ 一次逻辑写 +2）。
//     这是"隐患热度"——排障要能看到"这个点反复在失败、只是都被救回来了"。
//   · `unhealed`（逻辑写级）：只记**终局未愈合**的失败，即到达 L3（`disk-critical-persist-fail`、
//     已无手段可用、由上层唯一告警闸门处理）的那一次。
//     L0/L1 救回、L2 舍次（非关键项，可重建）都算"处理掉了" ⇒ 不计 unhealed ⇒ 不产生用户可见告警。
//   · `health`：`unhealed > 0 ⇒ 'failing'`；否则 `slow > 0 ⇒ 'slow'`；否则 `'ok'`。
// ★ 判据是**到达的级别**（`note`/`end` 的 `level` 实参），不是失败次数：级别是"手段是否改变/还有
//   没有手段"的事实，与"试了几次"无关（与自愈阶梯同一判别标准）。
// ★ 裸 `note(site, ms, ok=false)`（不带 level）**不**判 failing：它没有表达"这次写最终有没有落地"，
//   而 health 是**用户可见档位**、不是"发生过失败"。生产代码里不存在这种调用（5 个落盘点全部经
//   `disk-write.mjs#diskWrite` 的 `begin/end`，终局级别恒为 L2 或 L3，有测试钉住）。

/** 5 个落盘点。★ 名称是**契约**：与 kernel-tests/disk-sites-wiring.test.mjs 的静态对账绑定，改名即红。 */
export const DISK_SITES = Object.freeze([
  'transcript-append', // kernel/session.mjs#writeEntry（appendFileSync，高频）
  'transcript-usage',  // kernel/session.mjs#setEntryUsage（writeFileSync(tmp)+renameSync）
  'session-memory',    // kernel/cli.mjs 会话工作记忆（writeFileSync 覆盖，轮末一次）
  'loop-state',        // kernel/loop.mjs#persist（tmp+rename，状态变化时偶发）
  'tool-result',       // kernel/engine.mjs#persistToolResult（writeFileSync，>20K 结果时）
])

/**
 * 关键项：丢了就真丢。其余项可重建（tool-result 可退回原文、session-memory 可从 transcript 重建、
 * loop-state 是可再生的运行态）⇒ L2"降规模"时只舍非关键项（spec §4.1）。
 */
export const CRITICAL_DISK_SITES = Object.freeze(['transcript-append'])

export const DEFAULT_DISK_SLOW_MS = 1000
export const DEFAULT_DISK_EXEMPT_MAX_MS = 120000

/**
 * "未愈合"的级别：L3 = `disk-critical-persist-fail`（落盘域已无手段可用 ⇒ 由上层告警）。
 * ★ 与 `heal-ladder.mjs#DISK_REASON_LEVEL` 的这条登记是**同一个事实**（该表 `'disk-critical-persist-fail': 'L3'`）；
 *   本模块不 import 判定模块（保持零依赖纯记账），一致性由测试对账（disk-heal「终局失败必带 L2/L3」）。
 */
const UNHEALED_LEVEL = 'L3'

const LEVEL_RANK = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 })

/**
 * 读环境变量。★ 两个开关的 `0` **语义不同**，不可混为一谈：
 * - `PONOS_KERNEL_DISK_EXEMPT_MS=0` 是**关闭语义** ⇒ `exemptMaxMs=0`（逐字回旧行为：永不声明豁免）。
 *   容忍写法差异（`'0 '`/`' 0'`/`'0.0'`/`'00'`/`'0e0'` 都算关）——回滚开关必须 fail-safe：
 *   把 `'0 '` 当成"非法 ⇒ 回落默认 120000"等于**豁免全开**，方向正好反了。
 * - `PONOS_DISK_SLOW_MS` **没有**关闭语义（`0` 不是"关慢写判定"）⇒ 非法/非正一律回落默认。
 * 两者都绝不产生 NaN。
 */
export function resolveDiskConfig(env = {}) {
  const e = env || {}
  const slowRaw = Number(e.PONOS_DISK_SLOW_MS)
  const exStr = String(e.PONOS_KERNEL_DISK_EXEMPT_MS ?? '').trim()
  const exRaw = Number(exStr)
  const exOff = exStr !== '' && (exStr === '0' || exRaw === 0)
  return {
    enabled: e.PONOS_DISK_TELEMETRY !== '0',
    slowMs: Number.isFinite(slowRaw) && slowRaw > 0 ? slowRaw : DEFAULT_DISK_SLOW_MS,
    exemptMaxMs: exOff
      ? 0
      : (Number.isFinite(exRaw) && exRaw > 0 ? exRaw : DEFAULT_DISK_EXEMPT_MAX_MS),
  }
}

/** p 分位（最近秩法，不插值：小样本下保守取实际观测值，不造出没发生过的耗时）。 */
export function percentile(values, p = 0.95) {
  if (!Array.isArray(values) || values.length === 0) return null
  if (!Number.isFinite(p)) return null // 非法 p ⇒ null（不返回 undefined：下游用 `=== null` 判"不知道"）
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/**
 * 建一个落盘遥测记账器。`now` 可注入（测试用假时钟，不依赖真实时间）。
 * 纪律：`begin/end` 是**常数开销**（无对象分配外的系统调用；`transcript-append` 是高频路径，
 * 观测不得成为延迟源）。关闭时 `begin` 返回 null、`end` 立即返回、`note` 不记账（零开销）。
 */
export function createDiskTelemetry({
  slowMs = DEFAULT_DISK_SLOW_MS, enabled = true, p95MinSamples = 5, window = 64, now = Date.now,
} = {}) {
  const sites = Object.create(null)
  for (const s of DISK_SITES) {
    sites[s] = { count: 0, totalMs: 0, maxMs: 0, slow: 0, failures: 0, unhealed: 0, lastError: '', samples: [], _level: null }
  }
  let maxLevel = null

  const note = (site, ms, ok = true, err = null, level = null) => {
    if (!enabled) return null // 关闭埋点 ⇒ 不记账（与 begin/end 同口径；回滚开关不得被 note 绕过）
    const st = sites[site]
    if (!st) return null // 未登记 site：静默忽略（不虚增统计，也不抛错打断写入路径）
    const v = Number.isFinite(ms) && ms >= 0 ? ms : 0
    st.count += 1
    st.totalMs += v
    if (v > st.maxMs) st.maxMs = v
    if (v >= slowMs) st.slow += 1
    if (st.samples.length >= window) st.samples.shift()
    st.samples.push(v)
    if (ok !== true) {
      st.failures += 1
      // ★ 分账（见文件头"两个失败计数"）：`failures` 记每一次失败 attempt（隐患热度）；
      //   `unhealed` 只记终局未愈合的那一次（到达 L3）——它是**用户可见**口径，`health` 据此判档。
      //   被 L0/L1 救回、被 L2 舍次都算"处理掉了"⇒ 不计（自愈成功不该惊动用户）。
      if (level === UNHEALED_LEVEL) st.unhealed += 1
      // 失败但没带 err ⇒ **不动** lastError：排障时要的是"最近一条有内容"的错误，
      // 而不是被某次无信息的失败抹成空串（五处写入路径的错误信息质量不均）。
      const msg = err ? String(err && err.message ? err.message : err).slice(0, 200) : ''
      if (msg) st.lastError = msg
    }
    // ★ 必须用**自有属性**判定：`level in LEVEL_RANK` 会把原型链上的 'toString'/'constructor'/
    //   'valueOf'/'hasOwnProperty'/'__proto__' 当成合法级别；且 LEVEL_RANK['toString'] 是函数，
    //   与数字比较恒 false ⇒ 一旦先记成 'toString'，后续真实级别再也升不上去（伪级永久卡住）。
    if (typeof level === 'string' && Object.hasOwn(LEVEL_RANK, level) && (maxLevel === null || LEVEL_RANK[level] > LEVEL_RANK[maxLevel])) {
      maxLevel = level
    }
    return { site, ms: v, ok: ok === true, level: typeof level === 'string' ? level : null }
  }

  const begin = (site) => (enabled && sites[site] ? { site, t0: now() } : null)
  const end = (token, ok = true, err = null, level = null) => {
    if (!token || !enabled) return null
    return note(token.site, now() - token.t0, ok, err, level)
  }

  const p95Ms = (site) => {
    const st = sites[site]
    if (!st || st.samples.length < p95MinSamples) return null // 样本不足 ⇒ null（不拿三两个样本宣称"慢盘"）
    return percentile(st.samples, 0.95)
  }

  const snapshot = () => {
    const out = {}
    let count = 0
    let ms = 0
    let slow = 0
    let failures = 0
    let unhealed = 0
    let maxMs = 0
    let slowestSite = null
    for (const s of DISK_SITES) {
      const st = sites[s]
      out[s] = { count: st.count, totalMs: st.totalMs, maxMs: st.maxMs, slow: st.slow, failures: st.failures, unhealed: st.unhealed, lastError: st.lastError }
      count += st.count
      ms += st.totalMs
      slow += st.slow
      failures += st.failures
      unhealed += st.unhealed
      if (st.maxMs > maxMs) { maxMs = st.maxMs; slowestSite = s }
    }
    const worstP95 = DISK_SITES.reduce((acc, s) => {
      const p = p95Ms(s)
      return p !== null && (acc === null || p > acc) ? p : acc
    }, null)
    return {
      sites: out,
      total: { count, ms, slow, failures, unhealed },
      maxMs,
      slowestSite,
      p95Ms: worstP95,
      // ★ 用户可见档位：只有"终局没落盘的逻辑写"（`unhealed`）才 failing。被 L0 重试救回、被 L1 换策略
      //   救回、被 L2 舍掉的失败都**不**进这一档 —— 自愈成功却给红徽标，就是"自愈反而打扰用户"。
      //   热度不丢：`failures`（attempt 级）与 `healLevel`（最高到达级）仍在快照里，排障看得到。
      health: unhealed > 0 ? 'failing' : (slow > 0 ? 'slow' : 'ok'),
      // 无自愈发生 ⇒ null（不虚报级别）。批 2 起由埋点传入实际到达的级别。
      healLevel: maxLevel,
    }
  }

  // ★ `enabled` / `sites` 对外暴露（2026-09-23 复核补）：`diskWrite` 需要它们做"埋点是否禁用"的
  //   **零开销探测** —— 旧写法是"先试着 `begin` 一次，拿到 null 才知道关了"，而 `transcript-append`
  //   是 per-entry 的高频点 ⇒ 每条 entry 白付一次 `begin`（对象分配 + 时钟读）。`begin` 的语义本来
  //   就是 `enabled && sites[site] ? token : null`，故这两个字段与 `begin` 的判据**同源**、不新增事实。
  return { begin, end, note, p95Ms, snapshot, sites, enabled }
}

/**
 * 慢盘豁免判定（**事前**询问；纯函数、无副作用）。
 *
 * 只在**该 site 的滚动 P95 ≥ 慢写阈值**时才声明 ⇒ 正常磁盘**零额外帧**（不产生噪音），慢盘自动豁免。
 * 窗口 `min(round(P95×2), exemptMaxMs)`，且**必须 ≥ 1ms** 才声明：亚毫秒窗口是实质空操作，
 * 却会向调用方宣称"已豁免"（假安心）⇒ 一律 `zero-window`。
 * `exemptMaxMs=0` ⇒ 永不声明（回滚开关）。
 *
 * `reason` 五态：`disabled`（回滚开关）/ `unknown-site`（site 不在 `DISK_SITES`，调用方 bug，
 * 与"不慢"分开以便定位）/ `not-slow` / `zero-window` / `p95-slow`。
 *
 * @param {{ telemetry?: any, site?: string, now?: any, exemptMaxMs?: number, slowMs?: number }} [opts]
 * @returns {{declare: boolean, windowMs: number, reason: string, basis: number|null}}
 */
export function judgeDiskWait({ telemetry, site, now, exemptMaxMs = DEFAULT_DISK_EXEMPT_MAX_MS, slowMs = DEFAULT_DISK_SLOW_MS } = {}) {
  void now // 判定不依赖调用时刻（纯函数 ⇒ 同一 P95 恒得同一窗口，不因反复调用而叠加延长）
  if (!(exemptMaxMs > 0)) return { declare: false, windowMs: 0, reason: 'disabled', basis: null }
  // 未知 site 单独一态：否则它和"这个点确实不慢"共用 not-slow，埋点漏登记会被观测面洗成"正常"。
  if (typeof site !== 'string' || !DISK_SITES.includes(site)) {
    return { declare: false, windowMs: 0, reason: 'unknown-site', basis: null }
  }
  const p95 = telemetry && typeof telemetry.p95Ms === 'function' ? telemetry.p95Ms(site) : null
  if (typeof p95 !== 'number' || p95 < slowMs) return { declare: false, windowMs: 0, reason: 'not-slow', basis: p95 }
  const windowMs = Math.min(Math.round(p95 * 2), exemptMaxMs)
  if (!(windowMs >= 1)) return { declare: false, windowMs: 0, reason: 'zero-window', basis: p95 }
  return { declare: true, windowMs, reason: 'p95-slow', basis: p95 }
}
