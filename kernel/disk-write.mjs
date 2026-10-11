// 落盘写入包装：把 5 个落盘点纳入统一遥测，并在失败后按落盘域阶梯自愈（批 2）。
//
// 为什么要有这一层（而不是在各处直接调 telemetry.begin/end）：
//   ① 单点决策："写入失败后怎么办"只在这里演进（L0 重试 / L1 换策略 / L2 舍次要项 / L3 告警），
//      5 个调用点从不变动 ⇒ 改动面小、可单独回滚。
//   ② 语义守恒：包装必须让**成功路径逐字等价于直接调用**（返回值原样透传）、**失败路径不抛**
//      （落盘失败本就被各点静默 catch，包装不得把它变成异常打断主流程）。
//      注意"失败路径不抛"指本包装不主动抛：调用点若原本需要异常传播（如 session#append 靠
//      ENOENT 触发目录重建），由调用点**自己**按 `!w.ok` 重抛，语义逐字保留 —— L3 亦返回
//      `ok:false`，故那条重抛路径不受自愈影响。
//   ③ 观测不得成为延迟源：除一次 Date.now() 外无额外系统调用。
//   ④ 观测自身绝不外溢：遥测实现若抛错（病态/未来的自愈失败），一律就地吞掉——既不外泄成异常、
//      也不被误报成 {ok:false}（否则调用点会把"观测坏了"当成"盘坏了"去重抛/告警）。
//
// ── 阶梯判据（spec §4.1）：看**手段是否改变**，不看等了多久 ──────────────────────
//   L0 disk-write-retry           立即重试一次（Windows 上 EBUSY/EPERM 多为瞬时：AV 扫描、句柄竞争）
//   L1 disk-strategy-fallback     关键项才换写入策略（append → tmp+rename 等，由调用点给 `fallback`）
//   L2 disk-shed-secondary        非关键项降规模：舍掉（可重建），不试 fallback，不告警
//   L3 disk-critical-persist-fail 关键项持续失败 ⇒ 交回错误、由上层醒目告警（**唯一告警闸门**）
// ★ 纪律"多数问题自愈、严重才提醒"：L0/L1/L2 一律静默（onHeal 只是内部观测事件，本身不是告警）。
// ★ 关键判据唯一：`CRITICAL_DISK_SITES`（`opts.critical` 显式传入时以显式为准），不另立标准。
// ★ **终局级别 = 告警判据**（2026-09-23 批 2 口径修正）：遥测把"终局未愈合"只记在**到达 L3** 的那次
//   attempt 上（`unhealed`），`health` 据此判档 ⇒ 被 L0/L1 救回、被 L2 舍掉的失败都不产生红档。
//   故本模块有一条**不变式**：每次逻辑写的最后一次 attempt 失败时，交给埋点的级别必为
//   **L2（舍次）或 L3（未愈合）** —— 若哪天有路径漏传（如提前 return 掉第一段的 null 级失败），
//   告警会**静默消失**。该不变式由 disk-heal.test.mjs「终局失败必带 L2/L3」逐路径钉住。
// ★ 回滚：埋点关闭（PONOS_DISK_TELEMETRY=0）时自愈**一并关闭**，逐字回"直接调用一次"的旧行为。
//   关闭埋点却继续自愈会得到"没人看得见的重试"：既无观测、又无回滚开关，不可接受。
//
// ── 慢盘豁免声明的节流（Task 7 实施期补）──────────────────────────────────────
// 声明必须在**写之前**发（同步写期间主线程停摆 ⇒ 心跳发不出去，只能事前声明）。但最高频那个点
// 是**每条 entry 一次**的频率 ⇒ 慢盘下会退化成"每条 entry 一个声明"，而声明要经 stdout 往外发，
// 它本身就可能成为新的延迟源。故：同一 site 两次声明至少间隔 `windowMs/2`。
// ★ 冷却**不延长豁免窗口**：窗口仍由 `judgeDiskWait` 纯函数算出（P95×2，上限有界），冷却只回答
//   "这份同样的声明是否刚到过"。不变式 `max(1, round(windowMs/2)) ≤ windowMs`（windowMs ≥ 1）
//   ⇒ 相邻两次声明间隔不超过一个窗口 ⇒ 既不去重到"豁免过期"，也不叠加延长。
import { CRITICAL_DISK_SITES, DISK_SITES, createDiskTelemetry, judgeDiskWait, resolveDiskConfig } from './disk-telemetry.mjs'
import { reasonToLevel } from './heal-ladder.mjs'

let _shared = null

/** "慢盘豁免事前声明"出口（Task 8 接线到 wire.system('disk_wait')）；未接线时为 null ⇒ 零成本。 */
let _onDeclare = null

/**
 * 声明冷却状态：site → 上次声明时刻。**模块级**而非 telemetry 实例级，因为声明出口是模块级的；
 * 且"同一 site 的同一个声明"是跨写入的连续语义（按实例记会随实例切换而失效）。
 */
const _declareAt = new Map()
/** 冷却比例：windowMs/2（见文件头不变式）。 */
const DECLARE_COOLDOWN_RATIO = 0.5

/**
 * env 解析结果的**模块级缓存**（2026-09-23 复核补，边际开销）：`resolveDiskConfig(process.env)`
 * 原本**每条写**都跑一遍（`transcript-append` 是 per-entry 的高频点），而这三个开关在进程内不会变
 * ——它们是启动期注入的 env（`kernel/cli.mjs` 装配时读一次语义即定）。故"首次用时求值 + 缓存"。
 * ★ 失效点 = 测试改 env 的两个入口：`resetDiskTelemetry()` / `configureDiskWriter()`
 *   （生产代码不调前者；后者只在启动期接一次线）。这样"改 env 后必须显式重置"是**可预期**的，
 *   而不是靠"每次写都重读 env"来兜底。
 */
let _cfg = null
function diskConfig() {
  if (!_cfg) _cfg = resolveDiskConfig(process.env)
  return _cfg
}

/** 进程级共享遥测（懒建；读 env 一次，避免每处都读 process.env）。 */
export function getDiskTelemetry() {
  if (!_shared) _shared = createDiskTelemetry(diskConfig())
  return _shared
}

/** 测试用：重置单例 + 清空声明冷却状态 + 失效 env 缓存（生产代码不得调用）。 */
export function resetDiskTelemetry() {
  _shared = null
  _cfg = null
  _declareAt.clear()
}

/**
 * 注入"慢盘豁免事前声明"出口（Task 8 用）。
 * ★ 重设/清空都会重置冷却状态与 env 缓存：新出口不该被上一个出口的冷却记录挡下它的第一条声明。
 * @param {{ onDeclare?: Function }} [opts]
 */
export function configureDiskWriter({ onDeclare } = {}) {
  _onDeclare = typeof onDeclare === 'function' ? onDeclare : null
  _cfg = null
  _declareAt.clear()
}

/** 该 site 是否处于声明冷却期（只判"要不要重复发同一份声明"，不参与窗口计算）。 */
function declareCoolingDown(site, windowMs, now) {
  const last = _declareAt.get(site)
  if (typeof last !== 'number') return false
  const cooldown = Math.max(1, Math.round(windowMs * DECLARE_COOLDOWN_RATIO))
  return now - last < cooldown
}

/**
 * 包住一次同步落盘写，并按落盘域阶梯自愈（spec §4.1）。阶梯见文件头。
 * @param {object} telemetry `createDiskTelemetry()` 的实例（null ⇒ 用进程级单例）
 * @param {string} site 见 DISK_SITES
 * @param {() => any} fn 真正的写（同步）
 * @param {{critical?: boolean, fallback?: () => any, onHeal?: (reason: string) => void, exemptMaxMs?: number}} [opts]
 *   `critical` 省略时按 site 判定（CRITICAL_DISK_SITES）；`fallback` 只在关键项 + 重试仍败时被调用。
 * @returns {{ok: true, value: any, level: string|null, reason: string|null, error?: any}
 *          | {ok: false, error: any, shed: boolean, level: string|null, reason: string|null}}
 *   `level` = 实际到达的级别（成功且无需自愈 ⇒ null，与"没自愈"如实区分）。
 */
export function diskWrite(telemetry, site, fn, opts = {}) {
  const t = telemetry || getDiskTelemetry()
  const crit = opts.critical === true || CRITICAL_DISK_SITES.includes(site)
  const hasFallback = typeof opts.fallback === 'function'
  const onHeal = typeof opts.onHeal === 'function' ? opts.onHeal : null

  // 回滚语义：埋点关闭（PONOS_DISK_TELEMETRY=0）⇒ 逐字回"直接调用一次"的旧行为（不重试、不声明）。
  // ★ 禁用探测**不再多试一次 begin**（2026-09-23 复核补，边际开销）：真实遥测由 `createDiskTelemetry`
  //   暴露 `enabled` 与 `sites`，而 `begin` 的语义就是 `enabled && sites[site] ? token : null`
  //   ⇒ 用这两个字段即可判，省掉原先"探测一次 begin + attempt 里再 begin 一次"的**两倍**开销
  //   （`transcript-append` 是 per-entry 的高频点）。判据与旧写法逐字等价：
  //     · `enabled === false` ⇒ 旧写法 begin 恒 null ⇒ 关闭；
  //     · `sites[site]` 缺失（未登记 site）⇒ 旧写法 begin 恒 null ⇒ 关闭。
  //   只给 `begin`/`end` 的**测试替身**没有这两个字段 ⇒ 回落老的"试一次 begin"判据，语义不变。
  const disabled = !t || t.enabled === false || (t.sites ? !t.sites[site] : t.begin(site) === null)
  if (disabled) {
    try { return { ok: true, value: fn(), level: null, reason: null } }
    catch (error) { return { ok: false, error, shed: false, level: null, reason: null } }
  }

  // 慢盘豁免：**写之前**声明（同步写期间主线程停摆 ⇒ 心跳发不出，只能事前声明）。
  const cfg = diskConfig()
  const now = Date.now()
  const j = judgeDiskWait({
    telemetry: t, site, now,
    exemptMaxMs: opts.exemptMaxMs ?? cfg.exemptMaxMs,
    slowMs: cfg.slowMs,
  })
  if (j.declare && _onDeclare && !declareCoolingDown(site, j.windowMs, now)) {
    // 先记后发：出口自己抛错也算"声明过"，否则坏出口会让每次写都再试一遍（等于没有节流）。
    _declareAt.set(site, now)
    try { _onDeclare({ site, windowMs: j.windowMs, basis: j.basis, reason: j.reason }) } catch { /* 声明失败不得影响写入 */ }
  }

  // ★ 观测自身异常**绝不改变调用点语义**：`t.end` 若抛错，绝不允许被下面"写入失败"的 catch 捕获——
  //   那会 ① 二次调用 `t.end`（重复计数，观测面失真）② 把**遥测异常**包装成 {ok:false}，
  //   于是调用点当成"落盘失败"去重抛/告警/退回原文 ⇒ 观测把自己变成故障源。故一律就地吞掉。
  const safeEnd = (token, ok, err, level) => { try { t.end(token, ok, err, level) } catch { /* 观测失败不影响落盘结果 */ } }
  const emitHeal = (reason) => { if (onHeal) { try { onHeal(reason) } catch { /* 观测失败不得影响写入结果 */ } } }
  const heal = (reason) => { emitHeal(reason); return reasonToLevel(reason, 'disk') }

  /**
   * 一次尝试（含计时/记账）。`levelOf(ok)` 给出"这次尝试结束后**已到达**的级别"（尚不确定则 null）
   * ——交给埋点记进快照 `healLevel`，否则那个字段永远是 null（观测面是死的）。
   */
  const attempt = (levelOf) => {
    const token = t.begin(site)
    try {
      const value = fn()
      const level = levelOf(true)
      safeEnd(token, true, null, level)
      return { ok: true, value, level }
    } catch (error) {
      const level = levelOf(false)
      safeEnd(token, false, error, level)
      return { ok: false, error, level }
    }
  }

  // L0：先直接试一次（此刻级别未定 ⇒ null："能否自愈"要等重试的结果）
  let r = attempt(() => null)
  if (r.ok) return { ok: true, value: r.value, level: null, reason: null }
  const firstError = r.error

  // L0 自愈：立即重试一次。成功即 L0；再失败则按"下一步手段"定级（关键项还留着 fallback ⇒ 待定）
  r = attempt((ok) => (ok ? 'L0' : (!crit ? 'L2' : (hasFallback ? null : 'L3'))))
  if (r.ok) return { ok: true, value: r.value, level: heal('disk-write-retry'), reason: 'disk-write-retry' }

  // 两次尝试都失败 ⇒ L0 这一手段已用尽：登记事件（供阶梯观测），再决定下一步
  emitHeal('disk-write-retry')

  // L1 自愈：**关键项**才换策略（非关键项可重建，为它多花一次写不划算）
  if (crit && hasFallback) {
    const token = t.begin(site)
    try {
      const value = opts.fallback()
      safeEnd(token, true, null, reasonToLevel('disk-strategy-fallback', 'disk'))
      return { ok: true, value, level: heal('disk-strategy-fallback'), reason: 'disk-strategy-fallback' }
    } catch (error) { safeEnd(token, false, error, reasonToLevel('disk-critical-persist-fail', 'disk')) }
  }

  // L2 自愈：非关键项降规模 = 舍掉（可重建）。★ 只舍非关键项——关键项降规模等于丢数据。
  // ★ 终局级别 L2：舍次**不是**未愈合（可重建、且是既定 best-effort 语义）⇒ 不计 `unhealed`、不告警。
  if (!crit) {
    return { ok: false, error: firstError, shed: true, level: heal('disk-shed-secondary'), reason: 'disk-shed-secondary' }
  }

  // L3：关键项持续失败 ⇒ 交回错误（首次尝试的错误最贴近现场），由上层**唯一**的告警闸门处理
  // ★ 终局级别 L3：这是**唯一**会被记进 `unhealed`、并让 `health` 变 failing 的终局。
  return {
    ok: false, error: firstError, shed: false,
    level: heal('disk-critical-persist-fail'), reason: 'disk-critical-persist-fail',
  }
}

export { DISK_SITES }
