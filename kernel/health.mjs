// Ponos-turbo 健康监控（docs/superpowers/specs/2026-08-20-ponos-turbo-inner-core-design.md §6/§6.3）
// ---------------------------------------------------------------------------
// 两个**互相独立**的被测量（2026-09-12 spec：docs/superpowers/specs/2026-09-12-context-fidelity-health-design.md）：
//   压力（还能装多少）：多因子加权（压缩次数/链深度/剩余水位/剩余轮数/失败/冗余率）。
//     → 语义冻结，仅供血条当仪表；**不再是弹窗触发器**。
//   失真（还准不准）：由 fidelity.mjs 按 memory/coherence/goal 三轴判定。
//     → ponos_health.distortion 可选字段，是唯一的建议弹窗触发器。
//   两个 tier 含义不同，**严禁互相赋值**（血条只读 tier，弹窗只读 distortion.tier）。
// 全程 try/catch 静默降级，绝不影响主流程。LLM-as-Judge 默认关闭（可选调用）。

import { predictTurns, requestTokens } from './context.mjs'
import { createFidelity, fidelityConfigFromEnv } from './fidelity.mjs'

// 断崖点：flash 3 / pro[1m] 6
export function modelCap(model) {
  return /pro/i.test(String(model || '')) ? 6 : 3
}

// 水位基准 = 压缩触发阈值（context.thresholdRatio 默认 0.8）——上下文到此处
// pre-step 本应已触发压缩。（旧实现 Math.min(w*0.9, w*0.8) 恒等于 0.8w，0.9 分支
// 是死代码：注释意图"有效窗口×0.9"没有有效窗口入参来源。）
export function attentionCeiling(window = 200_000) {
  return Math.floor(window * 0.8)
}

export function computeHealthScore({
  compactCount = 0, chainDepth = 0, remainingPct = 100, remainingTurns = 99,
  failures = 0, redundancyRatio = 0, toolResultShare = 0, model = '',
} = {}) {
  const cap = modelCap(model)
  let score = 0
  let forceRed = false
  if (compactCount > 0) score = Math.max(40, Math.round((70 * compactCount) / cap))
  if (chainDepth >= 2) score += (chainDepth - 1) * 15
  if (remainingPct < 12) score += 70
  else if (remainingPct < 25) score += 45
  if (remainingTurns < 5) { score += 30; forceRed = true }
  else if (remainingTurns < 10) score += 20
  score += Math.min(3, failures) * 10
  if (redundancyRatio > 0.5) score += 10
  if (toolResultShare > 0.5) score += 10
  const tier = score >= 70 || forceRed ? 'red' : score >= 40 ? 'amber' : 'green'
  // 原因跟随实际计分的触发因子（旧红档模板固定"压缩 N 次 + 剩余 M 轮"：红档由
  // 水位/失败数触发时文案与事实脱节，出现"剩余 15811 轮仍建议新会话"类自相矛盾）
  const factors = []
  if (compactCount > 0) factors.push(`已连续压缩 ${compactCount} 次`)
  if (chainDepth >= 2) factors.push(`近 10 轮内压缩 ${chainDepth} 次`)
  if (remainingPct < 12) factors.push(`水位仅剩 ${Math.round(remainingPct)}%`)
  else if (remainingPct < 25) factors.push(`水位 ${Math.round(remainingPct)}%`)
  if (remainingTurns < 5) factors.push('距上限不足 5 轮')
  else if (remainingTurns < 10) factors.push(`距上限约 ${remainingTurns} 轮`)
  if (failures > 0) factors.push(`${failures} 次内部错误`)
  if (redundancyRatio > 0.5) factors.push('冗余率偏高')
  if (toolResultShare > 0.5) factors.push('工具结果占过半')
  const suffix = factors.length ? factors.join('，') : '多因子叠加'
  const reason =
    tier === 'red'
      ? `上下文压力过高（${suffix}），建议开启新会话`
      : tier === 'amber'
        ? `上下文接近压力区（${suffix}）`
        : '上下文健康'
  return { score, tier, compactCount, remainingPct: Math.round(remainingPct), remainingTurns, suggestNewSession: tier === 'red', reason }
}

// LLM-as-Judge 低频抽检判定：默认关闭；仅红档；冷却期内不重复
export function shouldJudge({ tier, judgeEnabled = false, lastJudgeAt = 0, now = Date.now(), cooldownMs = 300_000 }) {
  if (!judgeEnabled || tier !== 'red') return false
  return now - lastJudgeAt >= cooldownMs
}

/**
 * 装配 health 状态机（血条/档位/失真轴）。
 * @param {{ wire?: any, model?: string, contextWindow?: number, env?: any, getAnchorSource?: any, buildSnapshot?: any }} [opts]
 */
export function createHealth({ wire, model = '', contextWindow = 200_000, env = process.env, getAnchorSource, buildSnapshot } = {}) {
  // H3：窗口可变——compactor 经 400 溢出采纳端点真实窗口（adoptWindow）后同步过来，
  // 否则 health 仍按虚高配置窗口测水位，系统性低估压力（256K 配置 vs 131K 真实时
  // 压缩已触发、health 却显示充足）。
  let win = Math.max(0, Math.floor(Number(contextWindow) || 200_000))
  // PONOS_HEALTH_COMPACT_COUNT：bridge 空闲回收后 resume 时注入历史压缩次数
  // （进程内变量随回收清零，不恢复则 GUI 血条压缩史丢失回绿）。session 从
  // transcript 恢复的 compactCount 走 record() 取 max 兜底，env 为双保险 seed。
  // 兼容 YFW_ 前缀：bridge 曾注入 YFW_HEALTH_COMPACT_COUNT，与读取名不一致导致
  // seed 从未生效（2026-09-12 发现）；双名读取可兼容已装旧桥。
  // seed 双名取 max：compactCount 单调递增，"取大"语义安全（两个名字同时存在时
  // 不因较小的一方而丢掉历史压缩次数）；非法值一律回落 0。
  const seedCount = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  let compactCount = Math.max(
    seedCount(env.PONOS_HEALTH_COMPACT_COUNT),
    seedCount(env.YFW_HEALTH_COMPACT_COUNT),
  )
  let lastSummary = ''
  // 初始即绿 + 轮末每轮必发（2026-10-08 口径变更）：record() 一律 force 发帧，GUI 血条
  // 由此获得实时水位读数；旧语义"green 档不发、档位变化才发"在长窗口配置（实测
  // PONOS_AUTO_COMPACT_WINDOW=1M ⇒ 800K 基准）下档位长期停在绿档 ⇒ 血条永久无数据
  // （实测 1100+ 消息的会话零 ponos_health 帧）。lastTier 仍记录已发档位——其余
  // 非轮末入口（recordFailure/失真轴/压缩审计）保持"变化才发"，靠它与失真档差分。
  let lastTier = 'green'
  let lastJudgeAt = 0
  const recent = [] // 近 10 轮 turnStats
  const failures = { count: 0 }
  const judgeEnabled = env.PONOS_LLM_JUDGE === '1'
  // J1：Judge 结论暂存——仅随 force 发（recordJudge → emitIfChanged(true)）的
  // ponos_health 一次性带出（judge 字段；发完即清，不残留到后续事件）
  let pendingJudge = null
  // 失真轴（2026-09-12）：独立于压力计分；总开关关闭时完全不参与判定与事件触发
  const fidCfg = fidelityConfigFromEnv(env)
  const fidEnabled = fidCfg.enabled !== false
  const fid = createFidelity({ config: fidCfg, getAnchorSource })
  let lastDistortionTier = 'green'
  // 会话健康快照 provider（2026-09-23 spec §5.1；契约 §4.4）：**可选**、**晚绑定**。
  // 为什么需要晚绑定：health 实例在 cli.mjs 装配期创建，而快照的 cost/guard 两段来源在
  //   engine 的闭包里（`sessionUsageAcc`/`turnStats`），engine 又在 health **之后**创建
  //   ⇒ 只能事后注入（`setSnapshotProvider`）。构造参数 `buildSnapshot` 供直连/测试用。
  // 语义：provider 是**只读者**——不参与 changed 判定、返回值只挂在帧上（搭车字段）。
  let snapshotProvider = typeof buildSnapshot === 'function' ? buildSnapshot : null

  function snapshot() {
    // 剩余水位：最近一次"单请求"完整规模（lastUsage，含缓存字段）相对
    // attentionCeiling 的近似。注意不能用 turnStats.usage（轮级 API 调用合计，
    // 多工具步 agent 轮可达真实上下文的十几倍，水位恒 0% → 红档常态）；旧数据
    // 无 lastUsage 时回退轮级合计（仅兼容）。
    const last = recent.length ? recent[recent.length - 1] : null
    const prev = recent.length > 1 ? recent[recent.length - 2] : null
    // 压缩去旧：last 是"压缩前完成的轮"（count 落后当前，差 ≤3 防 seed 错位误判）
    // 或"压缩落在该轮"（count 领先上一轮——该轮 usage = 压缩前大输入 + 摘要调用
    // + 压缩后小输入之和，失真）→ 水位按中性处理，下一轮 turnStats 恢复实测。
    // 否则压缩刚落地的瞬间 recordCompaction 重估会用压缩前数据打出假红档
    // （"已连续压缩 1 次…建议开启新会话"恰在此刻弹出）。
    const stale = !!last && (
      (last.compactCount < compactCount && compactCount - last.compactCount <= 3) ||
      (prev && last.compactCount > prev.compactCount)
    )
    const ceiling = attentionCeiling(win)
    const lastInput = last ? requestTokens(last.lastUsage ?? last.usage) : 0
    const remainingPct = stale ? 100 : (ceiling > 0 ? Math.max(0, 100 - (lastInput / ceiling) * 100) : 100)
    // L4-1：增长速率预测（替代原 avgPerTurn 估算）
    const pred = stale
      ? { growthPerTurn: 0, predictedTurns: 99, threshold: 0, lastInput: 0 }
      : predictTurns({ recent, window: win, thresholdRatio: 0.8 })
    const remainingTurns = pred.predictedTurns
    const chainDepth = recent.reduce(
      (s, t, i) => s + (i > 0 && t.compactCount > recent[i - 1].compactCount ? 1 : 0),
      0,
    )
    const h = computeHealthScore({
      compactCount, chainDepth, remainingPct, remainingTurns,
      failures: failures.count, redundancyRatio: 0, toolResultShare: 0, model,
    })
    // 提前预警：预计 5~14 轮后达阈值（红档 reason 已含剩余轮数，不重复）
    if (pred.predictedTurns >= 5 && pred.predictedTurns < 15 && h.tier !== 'red') {
      h.reason = `预计约 ${pred.predictedTurns} 轮后接近上下文上限，建议关注压缩`
    }
    return {
      ...h,
      // 水位基准（= 上面 remainingPct 的**分母**）：对外暴露的**唯一**理由是可排障——只报
      // "剩 40%" 而不给基准，看的人无法判断分母是 160K 还是 104K（窗口被 adoptWindow 下调后
      // 两者差别很大）。与 remainingPct **同源**（同一个 ceiling，不在此处另算一遍）。
      // `ceiling <= 0` 即无有效窗口（win 被钳为 0 的那条退化路径，与上面 remainingPct 的
      // `ceiling > 0 ? … : 100` 是同一个判据）⇒ 如实 null（缺项不填 0）。
      attentionCeiling: ceiling > 0 ? ceiling : null,
      growthPerTurn: pred.growthPerTurn,
      predictedTurns: pred.predictedTurns,
      // 失真档：与压力档并列，互不影响（anchorText 仅在 red 时生成，避免每次事件带 4KB 文本）
      distortion: (fidEnabled ? fid.snapshot() : null) ?? {
        score: 0, tier: 'green', axes: { memory: 0, coherence: 0, goal: 0 },
        issues: [], trigger: null, observeUntilTurn: null, anchorAvailable: false,
      },
    }
  }

  function emitIfChanged(force = false) {
    const h = snapshot()
    const distTier = h.distortion.tier
    const changed = force || h.tier !== lastTier || distTier !== lastDistortionTier
    if (changed) {
      lastTier = h.tier
      lastDistortionTier = distTier
      const base = { score: h.score, tier: h.tier, compactCount, remainingPct: h.remainingPct, remainingTurns: h.remainingTurns, suggestNewSession: h.suggestNewSession, reason: h.reason, growthPerTurn: h.growthPerTurn, predictedTurns: h.predictedTurns }
      // distortion 为纯增量可选字段：老 GUI 忽略；anchorText 仅 red 时附带
      const distortion = distTier === 'red'
        ? h.distortion
        : { score: h.distortion.score, tier: distTier, axes: h.distortion.axes, issues: h.distortion.issues, trigger: h.distortion.trigger, observeUntilTurn: h.distortion.observeUntilTurn, anchorAvailable: h.distortion.anchorAvailable }
      wire.health?.({ ...base, distortion, ...snapshotField(), ...(pendingJudge ? { judge: pendingJudge } : {}) })
    }
    if (force) pendingJudge = null // force 发完即清：judge 只随当次事件带出
  }

  // 快照**捎带**字段（契约 §4.4）：只在**真的要发帧**时求值（不参与 changed 判定 ⇒ 不产生新帧、
  // 不为档位未变的轮次买单）；无 provider / provider 抛错 ⇒ 返回 `{}`（该次**省略**该键，
  // **不是**输出 `null`：老内核/老 GUI 逐字兼容，且"不输出半个快照"）。
  // ★ provider 抛错必须吞掉：观测失败不得升级为功能失败（否则加了观测反而让健康上报变脆弱）。
  function snapshotField() {
    if (!snapshotProvider) return {}
    try {
      const snap = snapshotProvider()
      return snap ? { snapshot: snap } : {}
    } catch { return {} }
  }

  return {
    record(turnStats) {
      try {
        recent.push(turnStats)
        if (recent.length > 10) recent.shift()
        if (turnStats.compactCount > compactCount) compactCount = turnStats.compactCount
        // 2026-10-08 口径：**每轮结束必发一帧**（force）。旧语义"档位变化才发、初始即绿
        // 不发"在长窗口配置下档位长期停在绿档 ⇒ GUI 血条永久无数据（实测 1100+ 消息的
        // 会话零 ponos_health 帧）。轮末是唯一的固定节奏点，force 后绿档轮次也逐轮刷新
        // 读数（帧体数百字节）；其余入口（recordFailure/失真轴/压缩审计）保持"变化才发"
        // —— 它们不是轮末节奏，不该改变已定的音量。
        emitIfChanged(true)
      } catch { /* 静默降级 */ }
    },
    recordCompaction(summary, count) {
      try {
        compactCount = count
        lastSummary = summary
        wire.summary?.(summary, count)
        lastTier = null // 强制下一轮重估（档位可能因压缩变化）
        emitIfChanged()
      } catch { /* 静默降级 */ }
    },
    // 红档 Judge 判定（默认关；engine 装配时可注入 runJudge 回调）
    shouldRunJudge() {
      const h = snapshot()
      if (!shouldJudge({ tier: h.tier, judgeEnabled, lastJudgeAt })) return false
      lastJudgeAt = Date.now()
      return true
    },
    // J1：内部错误兜底登记（engine runTurn 非 Abort 异常路径调用）——即时重估，
    // failures 计分进 snapshot（上限 +30），档位变化即发 ponos_health
    recordFailure() {
      try {
        failures.count += 1
        emitIfChanged()
      } catch { /* 静默降级 */ }
    },
    // J1：Judge 结论暂存 + 强制带出（done/reason 进 wire.health.judge，一次性）
    /**
     * @param {{ done?: any, reason?: any }} [opts]
     */
    recordJudge({ done, reason } = {}) {
      try {
        pendingJudge = { done: done === true, reason: String(reason || '') }
        emitIfChanged(true)
      } catch { /* 静默降级 */ }
    },
    snapshotState() {
      try { return snapshot() } catch { return null }
    },
    // 快照 provider 的**晚绑定**注入位（2026-09-23 spec §5.1）：engine 在 health 之后创建，
    // 而 cost/guard 两段的真源在 engine 的闭包里 ⇒ 由 engine 在装配时注入自己的读取闭包。
    // 传非函数（含 null）等同"撤回注入"⇒ 帧里不再出现 `snapshot` 键（逐字回旧行为，不报错）。
    setSnapshotProvider(fn) { snapshotProvider = typeof fn === 'function' ? fn : null },
    // 主动重估（幂等）：非强制时仅在档位变化时发帧。既有 7 处内部调用点不变，此处只是把闭包
    // 暴露给调用方/测试——"发不发生帧"的判据仍**只在**上面一处（不得由调用方旁路）。
    emitIfChanged,
    // ---- 失真轴（2026-09-12 spec §6.2）：三个入口，均静默降级 ----
    // 引擎轮尾喂"内容侧观测"：本轮 user/assistant 文本 + 工具结果摘要
    recordTurnContent(input) {
      try {
        if (!fidEnabled) return []
        const out = fid.recordTurn(input)
        emitIfChanged()
        return out
      } catch { return [] }
    },
    // 压缩点保真审计：确定性实体覆盖（+ 可选 LLM 改写检测，最高只计 medium）
    recordCompactionAudit(audit) {
      try {
        if (!fidEnabled) return []
        const out = fid.recordCompactionAudit(audit)
        emitIfChanged()
        return out
      } catch { return [] }
    },
    // 重新锚定生效：证据置 resolved（退出计分）→ 立即回绿；返回命中数
    markFidelityResolved(ids) {
      try {
        if (!fidEnabled) return 0
        const n = fid.markResolved(ids)
        emitIfChanged()
        return n
      } catch { return 0 }
    },
    fidelityEvidence() {
      try { return fid.evidenceLog() } catch { return { active: [], resolved: [] } }
    },
    // 失真红线锚点（2026-09-15 闭环）：tier=red 时把"已丢失什么"的锚点文本与证据 id
    // 交给 engine 注入请求面尾部——此前 anchorText 只进 ponos_health 事件发 GUI，等
    // 用户点"重新锚定"回传 anchor_applied 才 markResolved，**内核从不注入模型上下文**，
    // 检测等于只报警不处置。只读：不改变任何证据状态（置 resolved 仍只走
    // markFidelityResolved，保持 GUI 回传为唯一人工确认路径）。
    fidelityAnchor() {
      try {
        if (!fidEnabled) return null
        const s = fid.snapshot()
        if (!s || !s.anchorAvailable || !s.anchorText) return null
        const ids = (Array.isArray(s.issues) ? s.issues : []).map((i) => i && i.id).filter(Boolean)
        return { text: String(s.anchorText), ids }
      } catch { return null }
    },
    fidelityEnabled() { return fidEnabled },
    // 锚点**确实注入到请求面**时由 engine 回调（2026-09-16 断反馈环）：把锚点原文交给
    // fidelity，使"注入锚点的那一轮中复述锚点权威值"的事实不计入矛盾对——否则锚点自己
    // 要求的复述会被判成模型自相矛盾，抬高失真分、延长窗口、招致更多锚定（自维持反馈环）。
    // 与 fidelityAnchor 的分工：那个是"读锚点"，这个是"报告已注入"（只写一个受值约束的
    // 标记，**不改变任何证据的 resolved 状态**，人工确认路径仍只走 markFidelityResolved）。
    markFidelityAnchorInjected(text) {
      try {
        if (!fidEnabled) return 0
        return fid.markAnchorInjected(text)
      } catch { return 0 }
    },
    // H3：真实窗口同步（compactor.adoptWindow 采纳端点 max_model_len 后调用，只下调
    // 场景）。同步后水位/预测立即按真实窗口重估。
    setWindow(w) {
      try {
        const n = Math.floor(Number(w))
        if (Number.isFinite(n) && n > 0) win = n
      } catch { /* 静默降级 */ }
    },
    getState() { return { compactCount, lastSummary, tier: lastTier, judgeEnabled, distortionTier: lastDistortionTier, fidelityEnabled: fidEnabled } },
  }
}

/**
 * O2-1 运维健康归一：输入由调用方采集（内核测自身进程，bridge 测全局会话）。
 * 纯函数保证可测性——采集与展示分离。
 * @param {{ memory?: { rss?: number, heapUsed?: number }, lastApi?: { ok?: any, ms?: any }, pendingTurns?: number, diskBytes?: number }} [opts]
 */
export function getOpsHealth({ memory = {}, lastApi = {}, pendingTurns = 0, diskBytes = 0 } = {}) {
  return {
    rssMB: Math.round((memory.rss || 0) / 1024 / 1024),
    heapMB: Math.round((memory.heapUsed || 0) / 1024 / 1024),
    lastApiOk: lastApi.ok ?? null,
    lastApiMs: lastApi.ms ?? null,
    pendingTurns: pendingTurns || 0,
    diskMB: Math.round((diskBytes || 0) / 1024 / 1024),
  }
}
