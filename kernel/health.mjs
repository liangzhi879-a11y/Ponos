// Ponos-turbo 健康监控（docs/superpowers/specs/2026-08-20-ponos-turbo-inner-core-design.md §6/§6.3）
// ---------------------------------------------------------------------------
// 两个**互相独立**的被测量（2026-09-12 spec：docs/superpowers/specs/2026-09-12-context-fidelity-health-design.md）：
//   压力（还能装多少）：多因子加权（压缩次数/链深度/剩余水位/剩余轮数/失败）。
//     → 语义冻结，仅供血条当仪表；**不再是弹窗触发器**。
//   失真（还准不准）：由 fidelity.mjs 按 memory/coherence/goal 三轴判定。
//     → ponos_health.distortion 可选字段，是唯一的建议弹窗触发器。
//   两个 tier 含义不同，**严禁互相赋值**（血条只读 tier，弹窗只读 distortion.tier）。
// 全程 try/catch 静默降级，绝不影响主流程。LLM-as-Judge 默认关闭（可选调用）。

import { predictTurns } from './context.mjs'
import { createFidelity, fidelityConfigFromEnv } from './fidelity.mjs'

// 断崖点：flash 3 / pro[1m] 6
export function modelCap(model) {
  return /pro/i.test(String(model || '')) ? 6 : 3
}

// 模型自适应归一化：attentionCeiling = min(有效窗口×0.9, 名义窗口×0.8)
export function attentionCeiling(window = 200_000) {
  return Math.min(window * 0.9, window * 0.8)
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
  const reason =
    tier === 'red'
      ? `已连续压缩 ${compactCount} 次，剩余约 ${remainingTurns} 轮，建议开启新会话`
      : tier === 'amber'
        ? `上下文接近压力区（压缩 ${compactCount} 次，剩余 ${Math.round(remainingPct)}% 水位）`
        : '上下文健康'
  return { score, tier, compactCount, remainingPct: Math.round(remainingPct), remainingTurns, suggestNewSession: tier === 'red', reason }
}

// LLM-as-Judge 低频抽检判定：默认关闭；仅红档；冷却期内不重复
export function shouldJudge({ tier, judgeEnabled = false, lastJudgeAt = 0, now = Date.now(), cooldownMs = 300_000 }) {
  if (!judgeEnabled || tier !== 'red') return false
  return now - lastJudgeAt >= cooldownMs
}

export function createHealth({ wire, model = '', contextWindow = 200_000, env = process.env, getAnchorSource } = {}) {
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
  // 初始即绿：green 档不发 ponos_health（首轮即绿不打扰；档位转黄/红时才通知）
  let lastTier = 'green'
  let lastJudgeAt = 0
  const recent = [] // 近 10 轮 turnStats
  const failures = { count: 0 }
  const judgeEnabled = env.PONOS_LLM_JUDGE === '1' || env.CLAUDE_CODE_LLM_JUDGE === '1'
  // J1：Judge 结论暂存——仅随 force 发（recordJudge → emitIfChanged(true)）的
  // ponos_health 一次性带出（judge 字段；发完即清，不残留到后续事件）
  let pendingJudge = null
  // 失真轴（2026-09-12）：独立于压力计分；总开关关闭时完全不参与判定与事件触发
  const fidCfg = fidelityConfigFromEnv(env)
  const fidEnabled = fidCfg.enabled !== false
  const fid = createFidelity({ config: fidCfg, getAnchorSource })
  let lastDistortionTier = 'green'

  function snapshot() {
    // 剩余水位：最近一轮 usage.input 与 attentionCeiling 的近似（engine 侧可传入精确值，
    // 此处以最近一轮 input_tokens 相对 ceiling 估算）
    const ceiling = attentionCeiling(contextWindow)
    const lastInput = recent.length ? (recent[recent.length - 1].usage?.input_tokens ?? 0) : 0
    const remainingPct = ceiling > 0 ? Math.max(0, 100 - (lastInput / ceiling) * 100) : 100
    // L4-1：增长速率预测（替代原 avgPerTurn 估算）
    const pred = predictTurns({ recent, window: contextWindow, thresholdRatio: 0.8 })
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
      wire.health?.({ ...base, distortion, ...(pendingJudge ? { judge: pendingJudge } : {}) })
    }
    if (force) pendingJudge = null // force 发完即清：judge 只随当次事件带出
  }

  return {
    record(turnStats) {
      try {
        recent.push(turnStats)
        if (recent.length > 10) recent.shift()
        if (turnStats.compactCount > compactCount) compactCount = turnStats.compactCount
        emitIfChanged()
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
    recordJudge({ done, reason } = {}) {
      try {
        pendingJudge = { done: done === true, reason: String(reason || '') }
        emitIfChanged(true)
      } catch { /* 静默降级 */ }
    },
    snapshotState() {
      try { return snapshot() } catch { return null }
    },
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
    fidelityEnabled() { return fidEnabled },
    getState() { return { compactCount, lastSummary, tier: lastTier, judgeEnabled, distortionTier: lastDistortionTier, fidelityEnabled: fidEnabled } },
  }
}

// O2-1 运维健康归一：输入由调用方采集（内核测自身进程，bridge 测全局会话）。
// 纯函数保证可测性——采集与展示分离。
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
