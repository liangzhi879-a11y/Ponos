// kernel/loop.mjs —— loop 运行时控制器（spec 3.3/3.4/5.3）
// ---------------------------------------------------------------------------
// 职责：loop 状态机（次数/until/every/fresh）·预算硬停·无进展升级·状态持久化·指令族。
// 边界（安全短路序，spec 3.4）：预算/无进展**先于**验证器判定 —— 防止"验证器反复失败
// → 无限重试烧钱"。所有方法幂等 + 静默降级：任何异常都不得中断主 loop（沿用 health 风格）。
// 持久化：<configDir>/loop/<sessionId>.json（原子写 tmp+rename）；只存控制面，不存对话。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { costOf } from './cost.mjs'
import { formatLoopReplay, formatLoopStatus } from './loop-commands.mjs'
import { verifyDoneWhen } from './loop-verify.mjs'

const SCHEMA_VERSION = 1
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'budget_exceeded', 'no_progress', 'stalled'])
// wire `loop` 帧 end.reason 为封闭集合（零回归锁③：旧 GUI 按枚举解析）；自由文本原因只入 state.endReason
const END_REASONS = new Set(['completed', 'until_hit', 'cancelled', 'judge_error', 'verify_hit', 'budget_exceeded', 'no_progress', 'failed'])

export function createLoopController({ wire, engine, store = null, configDir = '', sessionId = '', cwd = '', env = process.env } = {}) {
  const file = join(configDir, 'loop', `${sessionId}.json`)
  const prices = {
    pricePerMInput: Number(env.PONOS_PRICE_PER_M_INPUT) || 0.2,
    pricePerMOutput: Number(env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
    cacheReadRatio: Number(env.PONOS_CACHE_READ_RATIO) || 0.1,
  }
  const noProgressN = Math.max(1, Number(env.PONOS_LOOP_NOPROGRESS_N) || 3)
  const onStall = String(env.PONOS_LOOP_ON_STALL || 'reflect_and_ask')
  let persistWarned = false
  let verifyImpl = (doneWhen, deps) => verifyDoneWhen(doneWhen, deps)

  let state = freshState()
  function freshState() {
    return {
      version: SCHEMA_VERSION, status: 'idle', goal: '', doneWhen: [], prompt: '',
      // until 参与持久化：--until 的判词达成即停由 cli 侧 judgeUntil 执行，但目标必须
      // 落盘，否则 --resume 恢复后停止条件丢失（会退化为按次数/预算收尾）。
      until: '',
      index: 0, count: null, everyMs: 0, fresh: false,
      budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
      usageAcc: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      costUsd: 0, steps: 0,
      noProgress: { streak: 0, lastFingerprint: '', threshold: noProgressN },
      onStall, injections: [],
      startedAt: '', updatedAt: '', endedAt: '', endReason: '',
      history: [], pendingApproval: null, snapshotRef: '',
    }
  }

  // —— 持久化（原子写；失败静默但提示一次，绝不阻断循环） ——
  function persist() {
    try {
      const dir = join(configDir, 'loop')
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      state.updatedAt = new Date().toISOString()
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
      renameSync(tmp, file)
      return true
    } catch {
      if (!persistWarned) {
        persistWarned = true
        try { wire?.warning?.({ level: 'loop_persist', message: 'loop 状态落盘失败（磁盘不可写？），断点续跑能力不可用' }) } catch { /* 静默 */ }
      }
      return false
    }
  }

  function emit(state_, data = {}) { try { wire?.loop?.(state_, data) } catch { /* 事件失败不阻断 */ } }

  function fingerprintOf(outcome) {
    const d = Array.isArray(outcome?.toolDigest) ? outcome.toolDigest : []
    const files = d.filter((t) => !t.isError && t.path).map((t) => `${t.name}:${t.path}`).sort().join(',')
    const errs = d.filter((t) => t.isError).map((t) => `${t.name}:${String(t.errorText || '').slice(0, 60)}`).sort().join(',')
    return `${files}|${errs}`
  }

  // —— 指令族 ——
  function start(opts = {}) {
    state = freshState()
    state.status = 'running'
    state.goal = String(opts.goal || '')
    state.until = String(opts.until || '')
    state.doneWhen = Array.isArray(opts.doneWhen) ? opts.doneWhen : []
    state.prompt = String(opts.prompt || opts.goal || '')
    state.count = opts.count === null || opts.count === undefined ? null : Math.max(1, Number(opts.count) || 1)
    state.everyMs = Number(opts.everyMs) || 0
    state.fresh = opts.fresh === true
    state.budget = {
      maxCostUsd: Number(opts.maxCostUsd) || 0,
      maxSteps: Number(opts.maxSteps) || 0,
      maxWallMs: Number(opts.maxWallMs) || 0,
    }
    state.startedAt = new Date().toISOString()
    persist()
    emit('start', {
      index: 0, total: state.count, until: String(opts.until || ''), fresh: state.fresh,
      goal: state.goal, everyMs: state.everyMs, budget: state.budget,
      // prompt 必须回传：GUI 排程卡发的是 `/loop --every 5m <任务>`（无 --goal），
      // 若只回传 goal，前端面板/胶囊的"目标"行会空白（看起来像没生效）。
      prompt: state.prompt,
      doneWhen: state.doneWhen.map((d) => d.run || d.text),
    })
    return state
  }

  function isActive() { return state.status === 'running' || state.status === 'pausing' || state.status === 'awaiting_approval' || state.status === 'verifying' }

  function stop(reason = 'cancelled') {
    const wasActive = isActive()
    const frameReason = END_REASONS.has(String(reason)) ? String(reason) : 'cancelled'
    state.status = reason === 'budget_exceeded' ? 'budget_exceeded' : 'cancelled'
    state.endReason = reason
    state.endedAt = new Date().toISOString()
    persist()
    if (wasActive || reason === 'budget_exceeded') emit('end', { reason: frameReason, index: state.index, total: state.count, goal: state.goal, costUsd: Number(state.costUsd.toFixed(4)) })
    return state
  }

  function pause() {
    if (!isActive()) return state
    state.status = 'pausing' // 当前轮跑完转 paused（轮次边界停，不打断进行中的轮）
    persist()
    emit('status', { status: state.status, index: state.index, total: state.count })
    return state
  }

  function resume() {
    if (TERMINAL.has(state.status)) return state
    // 人工介入即开新的计数窗口：awaiting_approval 状态下 streak 已达阈值，若不清零，
    // approve 后第一轮指纹照旧 → 立刻再次升级为 awaiting_approval（人工确认等于白点一次）。
    const wasAwaiting = state.status === 'awaiting_approval'
    state.status = 'running'
    state.pendingApproval = null
    if (wasAwaiting) { state.noProgress.streak = 0; state.noProgress.lastFingerprint = '' }
    persist()
    emit('status', { status: state.status, index: state.index, total: state.count })
    return state
  }

  function approve() { return resume() }

  function setBudget(patch = {}) {
    for (const k of ['maxCostUsd', 'maxSteps', 'maxWallMs']) {
      if (patch[k] !== undefined) state.budget[k] = Number(patch[k]) || 0
    }
    persist()
    emit('status', { status: state.status, budget: state.budget })
    return state
  }

  function inject(text) {
    const t = String(text ?? '').trim()
    if (!t) return state
    state.injections.push(t)
    persist()
    try { engine?.queueNext?.(t) } catch { /* 注入失败不阻断 */ }
    return state
  }

  function snapshot() {
    // 轻量检查点：记录 git HEAD（回滚目标）；非 git 仓库则跳过（静默）
    try {
      state.snapshotRef = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' })).trim()
      persist()
    } catch { /* 非 git / git 不可用：无快照可回滚 */ }
    return state.snapshotRef
  }

  function rollback() {
    if (!state.snapshotRef) return { ok: false, error: '无可回滚快照（非 git 仓库或尚未打点）' }
    state.pendingApproval = { kind: 'rollback', detail: state.snapshotRef }
    persist()
    emit('status', { status: 'awaiting_approval', pendingApproval: state.pendingApproval })
    return { ok: true, needApproval: true, ref: state.snapshotRef }
  }

  function status() { return { ...state } }
  function formatStatus() { return formatLoopStatus(state) }
  function replay(n = 10) { return formatLoopReplay(state.history, n) }
  function memory() {
    const fails = state.history.filter((h) => h.verify && h.verify.passed === false).length
    const rules = state.injections.length ? `\n人工补充：\n- ${state.injections.join('\n- ')}` : ''
    return `【loop 记忆】目标：${state.goal || state.prompt || '(未设定)'}\n验证失败轮次：${fails}/${state.history.length}\n无进展连续：${state.noProgress.streak}/${state.noProgress.threshold}${rules}`
  }

  /** 下一轮投递载荷（cli 直接入队） */
  function nextPayload(until = '') {
    const extra = state.injections.length ? `\n\n【loop 人工补充】\n- ${state.injections.join('\n- ')}` : ''
    return {
      message: { role: 'user', content: state.prompt + extra },
      loop: { count: state.count, until, fresh: state.fresh, index: state.index },
    }
  }

  async function runVerify() {
    const specs = state.doneWhen.length ? state.doneWhen : (state.goal ? [{ type: 'judge', text: state.goal }] : [])
    if (!specs.length) return null
    try {
      return await verifyImpl(specs, { tools: engine?.tools, judge: (o) => engine.judgeUntil(o), signal: engine?.signal })
    } catch (e) {
      return { passed: false, results: [], reason: `验证器异常：${e?.message || String(e)}` }
    }
  }

  /**
   * 轮末驱动（cli 在 finally 的 loop 推进处调用）。
   * @returns {Promise<{ action:'next'|'wait'|'stop', delayMs:number, rationale:string }>}
   */
  async function onTurnEnd({ outcome } = {}) {
    if (!isActive()) return { action: 'wait', delayMs: 0, rationale: `status=${state.status}` }
    // 1. 累计用量/成本/步数
    try {
      const u = outcome?.usage
      if (u) for (const k of Object.keys(state.usageAcc)) state.usageAcc[k] += Number(u[k]) || 0
      state.costUsd = costOf(state.usageAcc, prices)
    } catch { /* 成本计算失败不阻断 */ }
    const digest = Array.isArray(outcome?.toolDigest) ? outcome.toolDigest : []
    state.steps += digest.length
    const filesChanged = digest.filter((t) => !t.isError && t.path).length

    // 1.5 待人工审批（停滞升级 / 回滚登记）→ **不再自行推进，也不再重复注入**
    // 缺陷背景（2026-09-15 实测复现）：停滞分支会注入一条反思消息并把 status 置为
    // awaiting_approval，而 awaiting_approval 属于 isActive() ⇒ cli 在那条被注入消息的
    // 轮末又进 onTurnEnd（cli.mjs 的 `if (loop.isActive())`），指纹不变 ⇒ streak 继续
    // 增长 ⇒ 再注入一条反思 …… 形成"每轮一次 API 调用"的无限自续跑（管道 mock 下 60s
    // 内跑到第 19 轮仍未停）。设计意图是"停下来要人介入"，不是继续跑。
    // 只挡自动推进：人工确认（/loop approve → resume()）会把 status 拨回 running，
    // 之后照常推进。此处**不推进 index、不更新指纹、不写 history**——等待轮不是一次迭代
    //（否则轮次显示会从 3/3 一路涨到 13/3），停滞本身也已在升级那一刻记入 history。
    if (state.status === 'awaiting_approval') {
      persist()
      return { action: 'wait', delayMs: 0, rationale: 'awaiting_approval' }
    }

    // 1.6 轮次条目（后续全部分支共用；index 已在此推进——本函数只在"轮末"被调用一次）
    const historyEntry = {
      index: state.index + 1, ts: new Date().toISOString(),
      usage: outcome?.usage || null, costUsd: Number(state.costUsd.toFixed(4)),
      steps: digest.length, toolCount: digest.length, filesChanged,
      errors: digest.filter((t) => t.isError).length,
      verify: null, judged: false, note: '',
    }
    state.index += 1

    // 2. 无进展指纹（轮次维度，补既有时间维度 LOOP_STALL_MS 的空档）
    // 语义：连续相同指纹轮数。首次记录即算第 1 轮（第 1 轮不可能"与前一轮相同"），
    // 后续每轮指纹不变则 +1；达到阈值（默认 3，env PONOS_LOOP_NOPROGRESS_N）即升级。
    // 指纹为空（本轮无工具调用）→ 不计无进展（纯文本轮无法判定是否实质推进，保守不误停）。
    const fp = fingerprintOf(outcome)
    if (fp && fp === state.noProgress.lastFingerprint) state.noProgress.streak += 1
    else if (fp) state.noProgress.streak = 1
    else state.noProgress.streak = 0
    state.noProgress.lastFingerprint = fp

    // 3. 短路序：pausing → 预算 → 无进展 → 验证 → 次数
    if (state.status === 'pausing') {
      state.status = 'paused'
      state.history.push(historyEntry)
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak })
      emit('status', { status: 'paused', index: state.index, total: state.count })
      return { action: 'wait', delayMs: 0, rationale: 'paused' }
    }

    const overBudget = (state.budget.maxCostUsd > 0 && state.costUsd > state.budget.maxCostUsd)
      || (state.budget.maxSteps > 0 && state.steps > state.budget.maxSteps)
      || (state.budget.maxWallMs > 0 && Date.now() - Date.parse(state.startedAt) > state.budget.maxWallMs)
    if (overBudget) {
      state.history.push({ ...historyEntry, note: 'budget_exceeded' })
      stop('budget_exceeded')
      return { action: 'stop', delayMs: 0, rationale: 'budget_exceeded' }
    }

    if (state.noProgress.streak >= state.noProgress.threshold) {
      state.history.push({ ...historyEntry, note: 'no_progress' })
      if (onStall === 'stop') { stop('no_progress'); return { action: 'stop', delayMs: 0, rationale: 'no_progress' } }
      try {
        engine?.queueNext?.(`【loop 无进展预警】连续 ${state.noProgress.streak} 轮无实质进展（文件未变更/重复相同错误）。请换一种策略推进，或说明当前阻塞点与需要的帮助。`)
      } catch { /* 静默 */ }
      state.status = 'awaiting_approval'
      state.pendingApproval = { kind: 'no_progress', detail: `连续 ${state.noProgress.streak} 轮无进展` }
      state.endReason = 'stalled'
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), noProgressStreak: state.noProgress.streak })
      emit('status', { status: 'awaiting_approval', pendingApproval: state.pendingApproval, index: state.index, total: state.count })
      return { action: 'stop', delayMs: 0, rationale: 'no_progress' }
    }

    // 4. 完成条件（doneWhen 优先；否则 --until/goal 判词）
    if (state.doneWhen.length) {
      state.status = 'verifying'
      const v = await runVerify()
      historyEntry.verify = v ? { passed: v.passed, results: (v.results || []).map((r) => ({ run: r.run, type: r.type, ok: r.ok })) } : null
      historyEntry.note = v?.reason || ''
      state.status = 'running'
      state.history.push(historyEntry)
      if (v?.passed === true) {
        state.status = 'done'; state.endReason = 'verify_hit'; state.endedAt = new Date().toISOString()
        persist()
        emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak, verify: historyEntry.verify })
        emit('end', { reason: 'verify_hit', index: state.index, total: state.count, goal: state.goal, costUsd: Number(state.costUsd.toFixed(4)) })
        return { action: 'stop', delayMs: 0, rationale: 'verify_hit' }
      }
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak, verify: historyEntry.verify })
      // 次数耗尽 + done_when 未达成 → 失败收尾。
      // 修复前此处直接 return 'next'（不检查 count）→ `--done` 永不通过的 loop 无视次数上限
      // **无限跑**（只能靠预算/无进展/人工停），属"烧钱死循环"。语义上轮数用尽而目标未达成
      // 是失败而非完成，故用 'failed'（'completed' 保留给无 done_when 的"跑满 N 轮"）。
      if (state.count !== null && state.index >= state.count) {
        state.status = 'done'; state.endReason = 'failed'; state.endedAt = new Date().toISOString()
        persist()
        emit('end', { reason: 'failed', index: state.index, total: state.count, goal: state.goal, costUsd: Number(state.costUsd.toFixed(4)), verify: historyEntry.verify })
        return { action: 'stop', delayMs: 0, rationale: 'failed' }
      }
      return { action: 'next', delayMs: state.everyMs, rationale: `verify_failed: ${v?.reason || ''}` }
    }

    state.history.push(historyEntry)
    persist()
    emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak })
    if (state.count !== null && state.index >= state.count) {
      state.status = 'done'; state.endReason = 'completed'; state.endedAt = new Date().toISOString()
      persist()
      emit('end', { reason: 'completed', index: state.index, total: state.count, goal: state.goal, costUsd: Number(state.costUsd.toFixed(4)) })
      return { action: 'stop', delayMs: 0, rationale: 'completed' }
    }
    return { action: 'next', delayMs: state.everyMs, rationale: 'continue' }
  }

  function load() {
    try {
      if (!existsSync(file)) return false
      const parsed = JSON.parse(readFileSync(file, 'utf-8'))
      if (Number(parsed?.version) !== SCHEMA_VERSION) return false
      if (TERMINAL.has(String(parsed?.status))) return false // 已终结不重启
      state = { ...freshState(), ...parsed, budget: { ...freshState().budget, ...(parsed.budget || {}) }, noProgress: { ...freshState().noProgress, ...(parsed.noProgress || {}) } }
      emit('start', { index: state.index, total: state.count, until: state.until || '', fresh: state.fresh, goal: state.goal, everyMs: state.everyMs, budget: state.budget, prompt: state.prompt, resumed: true })
      return true
    } catch { return false }
  }

  return {
    start, onTurnEnd, status, formatStatus, pause, resume, stop, setBudget, approve, inject,
    snapshot, rollback, replay, memory, load, persist, isActive, nextPayload,
    engine, // 暴露注入的 engine（cli 与测试共用同一实例；测试改其 queueNext 可断言注入）
    // 测试注入点（生产代码不调用）
    __setVerifyForTest(fn) { verifyImpl = fn },
  }
}
