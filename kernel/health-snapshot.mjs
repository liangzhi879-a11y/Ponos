// 会话健康快照：把四处既有观测面 + 一处新落盘遥测聚合成**一个**结构体。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// 勘察发现四个维度里三个已有实现（压力与失真连 GUI 都完整、成本已有 /cost 与 usage 标签页），
// 但它们分散在四处：排障时要换四个地方看，且没人能回答"这个会话整体健康吗"。
// 本模块只做一件事：**读四处、拼一个**。
//
// ── 三条结构纪律 ─────────────────────────────────────────────────────────────
//   ① 派生视图，不是新事实：每段都有唯一权威来源（pressure←压力水位、fidelity←失真三轴、
//      cost←引擎会话用量累计、guard←既有守卫状态采集、disk←落盘遥测）。消费方若发现本快照与
//      单源不符，**以单源为准**。
//   ② 缺项一律 null，**绝不填 0**（填 0 会把"不知道"读成"很好"，比没有更糟）。
//   ③ 纯读取：不 import 判定模块、读时钟、写文件、返回任何影响控制流的值（有静态断言钉住）。
//      ★ 刻意**不含时间戳**：快照经既有 health 帧传输，帧本身的时序就是它的时间；加时间戳会让
//      纪律①出现"唯一不可重算的例外"，而例外正是漂移的起点（自愈阶梯的 line 亦同此约定）。
//
// ── 为什么聚合器"不认识来源"（只收普通对象，不 import 各来源模块）─────────────
// 一旦聚合器 import 判定模块，它就会长出"自己算一遍"的诱惑 ⇒ 变成第二套真相（违反纪律①）。
// 收普通对象还让本模块可被完全离线测试（不必启动会话/真的落盘），且来源演进不会波及聚合口径。

export const SNAPSHOT_KEYS = Object.freeze(['pressure', 'fidelity', 'cost', 'guard', 'disk'])

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v) => (typeof v === 'string' && v ? v : null)
const bool = (v) => (typeof v === 'boolean' ? v : null)
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)

function pressureOf(health) {
  const h = obj(health)
  if (!h) return null
  return {
    remainingPct: num(h.remainingPct),
    remainingTurns: num(h.remainingTurns),
    compactCount: num(h.compactCount),
    // 水位基准是**数字**（`attentionCeiling = floor(窗口 × 0.8)`，health 侧已对外暴露）：
    // 用 num 收，字符串/缺项如实 null —— 此前用 str() 收 ⇒ 与 health 的实际类型不符，
    // 该字段在 wire 上**永不出现真值**（值已知却没接线，不是"真不知道"）。
    attentionCeiling: num(h.attentionCeiling),
  }
}

function fidelityOf(fidelity) {
  const f = obj(fidelity)
  if (!f) return null
  return {
    memory: num(f.memory),
    coherence: num(f.coherence),
    goal: num(f.goal),
    // 无 issues ⇒ 空数组：与"没有该段"（null）语义不同 —— 空数组表示"确实没发现问题"。
    issues: Array.isArray(f.issues) ? f.issues.slice() : [],
  }
}

function costOf(cost) {
  const c = obj(cost)
  if (!c) return null
  const budget = num(c.budgetUsd)
  return {
    tokens: num(c.tokens),
    requests: num(c.requests),
    costUsd: num(c.costUsd),
    budgetUsd: budget,
    // 无预算 ⇒ null，**不推断 false**（false 会被读成"没超预算"，而实际是"不知道"）
    overBudget: budget === null ? null : bool(c.overBudget),
  }
}

function guardOf(guard) {
  const g = obj(guard)
  if (!g) return null
  return {
    hits: Array.isArray(g.hits) ? g.hits.slice() : [],
    // 与 hits/issues 同口径：**缺项一律 null**（2026-09-25 复审 ⑤）。
    // 原先写 `num(g.injections) ?? 0`：真源（collectGuardState）恒有该字段 ⇒ 实际无影响，
    // 但那是纪律②的**唯一例外**，而例外正是漂移的起点——排障时"0 次注入"与"不知道"会被
    // 读成同一件事（填 0 把"不知道"读成"没发生过"）。此处选择如实 null 而非注释豁免：
    // 0 在真源里有确定语义（确实一次没注入过），让两者在 wire 上可区分才有信息量。
    injections: num(g.injections),
    // ladder 是既有派生视图（已含 highest/highestName/exhausted/counts/unknown/line）：**原样引用**，
    // 不改写、不重算 —— 重算就会出现"快照里的阶梯"与"界面上的阶梯"不一致。
    ladder: obj(g.ladder) ? g.ladder : null,
  }
}

/**
 * 落盘段。★ 这里多一道**收口**（不是照抄透传），判据与理由如下：
 *
 * 落盘遥测在两种情况下会返回「count 全 0 + health:'ok' + healLevel:null」：
 *   ① 埋点被关闭（PONOS_DISK_TELEMETRY=0）；② 本会话对该站点**一次都没写过**。
 * 这两种情况的共同语义是「**没有观测**」，而 `health:'ok'` 的语义是「观察过且没问题」。
 * 若原样透传，health 帧就会把"没观测"上报成"磁盘很好" —— 与"缺项一律 null、绝不填 0"
 * 是同一条错误（填 0 把"不知道"读成"很好"）的另一个面：排障时会被引向"磁盘没事"的错误结论，
 * 比没有这段更糟。
 *
 * **判据**：`total` 必须是对象，且 `total.count` 是**正数**（遥测的 count 即样本数）。不满足
 * ⇒ 判为"无观测" ⇒ 整段 null。
 * **有样本时照常透传**（含 `health:'ok'`）：此时的 `ok` 表示"观察过且没问题"，是有信息量的结论，
 * 不得抹成 null（否则正常会话永远看不到落盘健康度，观测面反而失效）。
 * ★ 收口只在**聚合器的读取口径**内完成：不改落盘遥测自身的输出（它的 ok/count 是对它自己准确的）。
 */
function diskOf(disk) {
  const d = obj(disk)
  if (!d) return null
  const total = obj(d.total)
  if (!total || !(typeof total.count === 'number' && Number.isFinite(total.count) && total.count > 0)) return null
  return {
    sites: obj(d.sites) ? d.sites : {},
    total,
    maxMs: num(d.maxMs),
    slowestSite: str(d.slowestSite),
    p95Ms: num(d.p95Ms),
    health: str(d.health),
    healLevel: str(d.healLevel),
  }
}

/**
 * 五段聚合。纯函数、无副作用；缺项如实 null。
 *
 * @param {{health?: object, fidelity?: object, cost?: object, guard?: object, disk?: object}} [parts]
 *   各来源的**普通对象**（不要求任何类/模块类型）
 * @returns {{pressure: object|null, fidelity: object|null, cost: object|null, guard: object|null, disk: object|null}}
 */
export function buildHealthSnapshot({ health, cost, guard, disk, fidelity } = {}) {
  return {
    pressure: pressureOf(health),
    fidelity: fidelityOf(fidelity),
    cost: costOf(cost),
    guard: guardOf(guard),
    disk: diskOf(disk),
  }
}
