// 活性心跳（activity heartbeat）的**纯判定**（可单测：无 IO、无进程、无定时器）。
//
// ── 背景：要修的是哪一种"看不到" ──────────────────────────────────────────
// "内核活着且正在忙"与"内核已经死了"在 wire 上是**同一形态**——零输出。只看"有没有输出"
// 的判据必然两头都错：
//   · 把"在忙"读成"已死"：长前台工具执行期间内核按设计零输出（Bash 的 timeout_ms 已放宽到
//     30min，OCR / 子代理同量级），而进程级硬看门狗按"静默 > 900s"扣扳机 ⇒ 工具跑到一半
//     被 exit(7) 杀掉、会话留下半截工作。**这是本文件要修的那一头。**
//   · 把"在等"读成"已死"：大请求首字节宽限 600s（2026-09-21 事故：静默 901s 被 exit(7)）。
//     那一头已由 stream-runtime.mjs 的 upstream_wait 心跳修掉。
// 共同处方：让内核**自报**"此刻在忙什么、有多少活在飞"，把判据从"有没有输出"升级为
// "有没有在飞的工作"。
//
// ── ★ 三条不可让的纪律（否则"修误杀"会变成"放过真死"）────────────────────
// ① **心跳与实质输出分账**：心跳帧不推进 wire 的"最近实质输出"时刻（protocol.mjs 的
//    `opts.heartbeat`）。两者混为一谈，心跳就成了"续命"——2026-09-12 的 guard_heal 正是
//    这么把纯静默窗口一路延续到 2006s / 2911s 的（那条教训写在 writeLine 的头注里）。
// ② **续命必须有界**：自报"在飞"所能掩盖的静默有上限（`busyMaxMs`）。越过上限即**停发**
//    心跳 ⇒ 心跳过期 ⇒ 看门狗回落到"按静默判死"。这是对"续体丢失但定时器还活着"的唯一
//    兜底：那种形态下 in-flight 计数**永不归零**，只有上限能收敛（自报在飞的次数再多，
//    也不能把"计数泄漏"变成永久豁免）。
// ③ **只掩盖"已知在飞的工作"，不掩盖"不确定"**：`inflight === 0` 时一律不比旧行为宽松
//    —— 没有在飞工作的静默，就是可疑的静默。
//
// 本文件与 server 侧的 `server/kernel-heartbeat.mjs` 成对：这里管"我该不该说、说什么"，
// 那里管"听到了怎么信"。两侧的字段名一致性由 kernel-tests/heartbeat.test.mjs 对账钉住。

/** 心跳新鲜度窗口 = 3 个周期（容忍一次 tick 抖动/一次丢发，又不至于把真失活拖太久）。 */
export function heartbeatToleranceMs(periodMs) {
  const p = Number(periodMs)
  return Number.isFinite(p) && p > 0 ? p * 3 : 0
}

/**
 * 归一化"在飞工作"快照（容错：字段缺失/畸形一律按 0 计，绝不因自报畸形而误判"在忙"）。
 * @param {{inflight?: object}} snapshot
 */
export function normalizeInflight(snapshot) {
  const raw = snapshot && typeof snapshot.inflight === 'object' && snapshot.inflight ? snapshot.inflight : {}
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0)
  const tools = n(raw.tools)
  const lanes = n(raw.lanes)
  const bgBash = n(raw.bg_bash)
  // total 刻意**重算**而不采信自报值：它是"要不要放行豁免"的直接依据，
  // 让自报的一个错数字就能改变判定，等于把门禁交给了被守护者。
  return { tools, lanes, bg_bash: bgBash, total: tools + lanes + bgBash }
}

/**
 * 从"在飞工作"推当前相位（供人看，也供前端将来分相位提示）。
 * 优先级：等用户 > 工具 > 后台活 > 模型流。等用户排第一是因为那个相位下内核**本就该**零输出，
 * 而它另有展期窗口（cli 的 userGraceMs）负责边界，不该被读成"在忙"。
 */
export function activityPhase({ inflight, awaitingUser }) {
  if (awaitingUser) return 'waiting'
  if (inflight.tools > 0) return 'tool'
  if (inflight.lanes > 0 || inflight.bg_bash > 0) return 'background'
  return 'model'
}

/**
 * 该不该发这一帧心跳、发什么。
 *
 * @param {object}   o
 * @param {object}   o.snapshot          引擎的活性快照（engine.activitySnapshot()）
 * @param {number}   o.now               当前时刻
 * @param {number}   o.lastRealOutputAt  最近一次**实质** wire 输出（wireLastWriteAt()）
 * @param {number}   o.lastHeartbeatAt   上次心跳时刻（0 = 从未发过）
 * @param {number}   o.periodMs          心跳周期（0 = 关闭）
 * @param {number}   o.busyMaxMs         "在飞"可掩盖的静默上限（0 = 不设上限，仅调试用）
 * @param {boolean}  o.awaitingUser      是否在等用户（提问/审批挂起）
 * @returns {{emit:boolean, reason:string, busy:boolean, frame:object|null, inflight:object}}
 */
export function activityHeartbeat({ snapshot, now, lastRealOutputAt = 0, lastHeartbeatAt = 0, periodMs, busyMaxMs = 0, awaitingUser = false }) {
  const inflight = normalizeInflight(snapshot)
  const busy = inflight.total > 0
  const period = Number(periodMs)
  if (!Number.isFinite(period) || period <= 0) return { emit: false, reason: 'disabled', busy, frame: null, inflight }
  const at = Number(lastHeartbeatAt) > 0 ? Number(lastHeartbeatAt) : 0
  const t = Number(now)
  // 节流：未到周期不发（首个周期内 lastHeartbeatAt=0，故轮次开始后第一帧立即可见——
  // "看得见"优先于"省流量"：心跳的价值全在它出现在现场的时刻）。
  // 0.9 系数是给定时器抖动的余量：判定的周期与 setInterval 的周期同源，抖动 1ms 就会
  // 让 `t - at < period` 成立而白跳一整拍（心跳窗口随之出现一个空档，反而缩小了容忍）。
  if (at > 0 && t - at < period * 0.9) return { emit: false, reason: 'throttled', busy, frame: null, inflight }
  const outputSilenceMs = Number(lastRealOutputAt) > 0 ? Math.max(0, t - Number(lastRealOutputAt)) : 0
  const busyMax = Number(busyMaxMs)
  // 纪律②：在飞工作不得无限续命。静默已越过上限 ⇒ 停发心跳（让心跳过期、看门狗按静默收口）。
  if (busy && Number.isFinite(busyMax) && busyMax > 0 && outputSilenceMs > busyMax) {
    return { emit: false, reason: 'busy-cap', busy, frame: null, inflight }
  }
  const phase = activityPhase({ inflight, awaitingUser: awaitingUser === true })
  return {
    emit: true,
    reason: 'ok',
    busy,
    inflight,
    frame: {
      phase,
      // ★ 自报字段一律 snake_case（wire 惯例）；`inflight.total` 由收方**重算**，
      //   这里带上只为可读性与现场留痕。
      inflight,
      tool_name: String(snapshot?.tool_name || ''),
      tool_ms: Number.isFinite(Number(snapshot?.tool_ms)) ? Math.max(0, Math.floor(Number(snapshot.tool_ms))) : 0,
      turn_ms: Number.isFinite(Number(snapshot?.turn_ms)) ? Math.max(0, Math.floor(Number(snapshot.turn_ms))) : 0,
      output_silence_ms: outputSilenceMs,
      busy_max_ms: Number.isFinite(busyMax) && busyMax > 0 ? Math.floor(busyMax) : 0,
      awaiting_user: awaitingUser === true,
    },
  }
}

/**
 * 进程级硬看门狗的**放行判定**（纯函数：cli.mjs 只负责在 trip 时执行既有自杀流程）。
 *
 * 语义：只有当"轮次活跃 && 静默超限 && **没有**可信的在飞工作"时才扣扳机。
 *   · 心跳过期（toleranceMs 内没收到新心跳）⇒ 自报不可信，一律回落到按静默判死
 *     —— 这既覆盖"心跳关掉/老内核"，也覆盖"事件循环被同步调用冻住"（那种形态下
 *     心跳与看门狗定时器一起停摆，静默照样收敛）。
 *   · 心跳新鲜但 inflight=0 ⇒ **不比旧行为宽松**（纪律③：没有在飞工作的静默就是可疑的静默）。
 *
 * @returns {{trip:boolean, suppressedBy:string|null, hbFresh:boolean, inflight:number, toleranceMs:number}}
 */
export function judgeHardWatchdog({ turnActive, idleMs, limitMs, heartbeat, now, toleranceMs }) {
  const tol = Number(toleranceMs)
  const at = Number(heartbeat?.at) > 0 ? Number(heartbeat.at) : 0
  const hbFresh = Number.isFinite(tol) && tol > 0 && at > 0 && Number(now) - at <= tol
  const inflight = hbFresh ? (Number(heartbeat?.inflight) > 0 ? Math.floor(Number(heartbeat.inflight)) : 0) : 0
  const overLimit = turnActive === true && Number(idleMs) > Number(limitMs)
  if (!overLimit) return { trip: false, suppressedBy: null, hbFresh, inflight: 0, toleranceMs: Number.isFinite(tol) ? tol : 0 }
  if (inflight > 0) return { trip: false, suppressedBy: 'in-flight', hbFresh, inflight, toleranceMs: tol }
  return { trip: true, suppressedBy: null, hbFresh, inflight: 0, toleranceMs: Number.isFinite(tol) ? tol : 0 }
}
