// Ponos-turbo Agent 循环（docs/bridge-contract.md §9 替换面）
// ---------------------------------------------------------------------------
// runTurn：user 消息入 session → 循环调用 api.streamMessages：
//   - 文本/思考块 → wire.assistant 流式转发
//   - tool_use 块 → 权限判定（高危 Bash → can_use_tool 挂起等 control_response）
//     → tools 执行 → tool_result 经 session.appendToolResult 落盘 → 再调 API，
//     直到模型输出纯文本
// 取消：cli 调 engine.abort()，流循环在检查点抛 AbortError → cli 输出
// '已取消。' + result（契约 §8，进程保留可续聊）。
// 消息源：transcript 是权威源——请求消息一律 session.deriveMessages() 派生；
// session 缺省时退化为内存数组（测试直连场景），无 seedHistory 机制。
// usage：chunk 逐次 addUsage 累计（input/output/cache 各字段），替代覆盖赋值。
// 观测：每轮尾部产出 turnStats（usage/durationMs/model/ts/compactCount），
// health/result/stats 三个消费者共用；result 事件由 engine 发出（cli 不再重复）。
import { streamMessages, classifyApiError, deadStreamError } from './api.mjs'
import { abortError, beginAwaitingUser, endAwaitingUser } from './protocol.mjs'
import { countCjk, estimateRequest, estimateMessage, clampOutputBudgetForWindow, requestTokens, DEFAULT_WINDOW, contentEpoch } from './context.mjs'
import { costOf } from './cost.mjs'
import { decideToolPermission } from './permissions.mjs'
// P0-3（2026-09-16）：同族重试硬拒需要族归因；族判定与"是否灾难"共用 blacklist 一份逻辑
import { catastrophicFamily } from './blacklist.mjs'
// P1-6（2026-09-16）：主循环与子 lane 的守卫判据/文案收敛到唯一实现——此前两侧各写一份
// （内注释自认「子 lane 镜像主循环」），是"同一逻辑两处维护"，改一处忘另一处即造成两侧漂移。
import {
  isRealProgress, allToolResultsFailed, nextHadToolError,
  shouldRemindRepeat, repeatRemindText, errorMeltdownText, hasMeltdownBudget,
  batchToolKey, isClosedOut, planTailText,
} from './guards.mjs'
import { normalizeApprovalMode, deriveApprovalMode } from './approval-mode.mjs'
import { withLaneSkillCatalog } from './prompt.mjs'
import { createToolRegistry, killActiveChildren, MUTATING_FILE_TOOLS } from './tools.mjs'
import { createSessionStore, newSessionId, sanitizeSegment } from './session.mjs'
import { resolveAgent, resolveAgents, resolveLaneTools } from './agents.mjs'
import { normalizeWhitelistHost } from '../shared/browser-whitelist-host.cjs'
import { getProvider } from './provider.mjs'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createCompactor } from './compact.mjs'
import { perfTime, perfTimeAsync, perfMark, perfSpan, perfStep, perfBegin, perfCount } from './perf.mjs'
import { CONTINUE_HEAL_MAX, FID_ANCHOR_MAX_CONSEC, FID_ANCHOR_REINJECT_EVERY, IDLE_DEAD_RETRY_BACKOFF_MS, IDLE_DEAD_RETRY_MAX, IDLE_HEAL_MAX, LANE_MAX_CONCURRENT, LANE_READS_MAX, LOOP_STALL_MS, MAX_ERROR_ITERATIONS, MAX_OVERFLOW_RETRIES, MAX_TOOL_ITERATIONS, MELTDOWN_HEAL_MAX, NEAR_REPEAT_AVG, NEAR_REPEAT_BACK, NEAR_REPEAT_CODE_SKIP, NEAR_REPEAT_RECENT, NEAR_REPEAT_SIM, OUTPUT_TIERS, REPEAT_HEAL_MAX, REPEAT_REMIND_AT, STALL_HEAL_MAX, STREAM_FIRST_BYTE_MS, STREAM_IDLE_MS, TURN_TIMEOUT_MS, UPSTREAM_DEAD_HEAL_BACKOFF_MS, UPSTREAM_DEAD_HEAL_MAX, adaptiveFirstByteMs, isFidAnchorOn, withAnchorTail } from './engine-config.mjs'
import { addUsage, applyAggregateResultBudget, hasUsage, makeIdleWatchdog, normalizeEffort, rawAbortSignal, retryStream, sleep, withToolDeadline } from './stream-runtime.mjs'
import { createRequestFace, fitRequestToWindow, messageTextOf, patchOrphanToolUses, trimOversizedRequestCopy } from './request-face.mjs'
import { canonicalToolCallKey, createNearRepeatDetector, detectGenerationRepeat, isPlanTail, isThinkOnly } from './gen-guards.mjs'

// P1-6 拆分：环境阈值层与模块级支撑函数已外提为下列模块，此处以 re-export 维持原导出面，
// 外部导入方（cli.mjs / compact.mjs / kernel-tests）无需任何改动。createEngine 闭包保持原样。
export { adaptiveFirstByteMs, withAnchorTail } from './engine-config.mjs'
export { applyAggregateResultBudget, makeIdleWatchdog, normalizeEffort, withToolDeadline } from './stream-runtime.mjs'
export { buildHistoryIndex, createRequestFace, fitRequestToWindow, patchOrphanToolUses, trimOversizedRequestCopy } from './request-face.mjs'
export { canonicalToolCallKey, createNearRepeatDetector, detectGenerationRepeat, isCodeLikeUnit, isPlanTail, isThinkOnly } from './gen-guards.mjs'

export function createEngine({ opts = {}, wire, session, compactor, health }) {
  // signal 是轮次级取消标志（aborted 每轮由 runTurn 重置）；rawSignal 暴露真正
  // 的 AbortSignal，供 api.mjs 中断底层 fetch（undici 要求 AbortSignal 实例）
  let abortController = new AbortController()
  const signal = {
    aborted: false,
    get rawSignal() { return abortController.signal },
  }
  // P4-5：model 每轮从 provider 注册表刷新（CLI --model 显式指定优先于 registry）；
  // 未激活时 getProvider 现读 env.PONOS_MODEL，与既有行为一致
  let model = opts.model || getProvider().model || ''
  const maxTokens = Math.max(1, Number(process.env.PONOS_MAX_OUTPUT_TOKENS || 64000))
  // P0-3 大结果落盘目录并入文件边界：persistToolResult 把 >20K 工具结果存到
  // <会话目录>/tool-results/ 并只回模型 stub（提示"可用 Read 读取"）。但会话目录
  // = configDir/projects/<cwd>，位于 GUI 挂载的 --add-dir（项目目录）之外——若不入
  // 边界，模型按 stub 指引补读会被 Read 拒绝，读大文件只见 stub 空转。仅并入本会话
  // 的 tool-results/ 子目录（内容 = 本会话落盘的临时产物），不放宽整棵 projects 树。
  const toolResultsDir = session?.file
    ? join(dirname(session.file), 'tool-results')
    : (opts.configDir && opts.addDirs?.[0])
      ? join(opts.configDir, 'projects', sanitizeSegment(opts.addDirs[0]), 'tool-results')
      : null
  const tools = createToolRegistry({ cwd: opts.addDirs?.[0], addDirs: toolResultsDir ? [...(opts.addDirs || []), toolResultsDir] : opts.addDirs, skillsDirs: opts.skillsDirs, flatSkillRoots: opts.flatSkillRoots, skipPermissions: opts.skipPermissions, allowOutsideDirs: opts.allowOutsideDirs, disallowedTools: opts.disallowedTools, workflow: opts.workflow, memoryRoot: opts.memoryRoot || null, projectMemoryRoot: opts.projectMemoryRoot || null, readAllowFiles: session?.file ? [session.file] : [], knowledgeSpaces: opts.knowledgeSpaces ?? null, disabledSkills: opts.disabledSkills ?? null })
  // 审批放行档位（2026-09-12 四档化）：闭包变量而非 opts 字段——运行中可经
  // setApprovalMode 热切换（cli control_request），下一轮工具调用即按新档判定。
  // 未传档位时按旧 flag 派生（= 今天的真实行为，见 approval-mode.mjs 文件头）。
  let approvalMode = normalizeApprovalMode(opts.approvalMode || deriveApprovalMode({ skipPermissions: opts.skipPermissions, autoApproveHighRisk: opts.autoApproveHighRisk }))
  // 审批门注入工作流引擎：wfEngine 内嵌 tool/document/agent 节点的工具调用须经
  // 与主 agent 会话同等的权限决策（gateToolUse 含 ask 审批挂起 / hook 否决），
  // 杜绝模型经 Workflow 工具旁路高危命令审批。cli 后续 setDeps（registry/事件）
  // 是合并语义，不影响本门。engine 直连测试无 opts.workflow 时跳过。
  if (opts.workflow && typeof opts.workflow.setDeps === 'function') {
    try {
      opts.workflow.setDeps({
        permissionGate: gateToolUse,
        // 2026-09-11 spec-dev：工作流 tool/agent 节点可派发子 agent（懒 getter——
        // spawnSubAgent/taskSystem 声明在下方，调用时才解析）
        getToolCtx: () => ({ spawnSubAgent, taskSystem }),
      })
    } catch { /* 注入失败不阻断主 loop */ }
  }
  // agent 表（内置 ∪ 用户级 $PONOS_HOME/agents/*.md）：Agent 工具路由依据
  const agents = resolveAgents({ configDir: opts.configDir })
  // 审批挂起队列：toolUseId → resolve（cli 的 control_response 解除）
  const approvalWaiters = new Map()
  // 浏览器桥挂起队列：requestId → resolve（bridge 回写 browser_response 解除；
  // 内核发 bridge_request(browser) → 主进程执行器 → 响应回写 stdin）
  const browserWaiters = new Map()
  // 应用桥挂起队列（Task 4.x「应用即工具」）：requestId → resolve（bridge 回写
  // app_response 解除）。与 browserWaiters 完全同构，只是路由不同——内核发
  // bridge_request(route=app) → bridge → 主进程执行器（复用 electron/app-ipc.cjs 的
  // app:run 执行逻辑）→ 响应经 stdin control_request(app_response) 回写。
  const appWaiters = new Map()
  // P8 排队插话（priority:'next'）：cli 吸收入队，引擎在工具调用边界注入当前轮；
  // 纯文本生成阶段不注入，轮末由 cli 作为新轮处理（前端方案 A 兜底语义）
  const pendingNext = []
  // ── ASK_USER 阻塞等待（2026-09-12）────────────────────────────────────────
  // 病灶：内核对提问标记**零感知**——模型写完问题即继续跑完整个回合，用户看到卡片
  // 时模型早已跑远，"审批/提问总是与会话进度不一致、消息已过期"的用户实证即此。
  // 语义与审批同构（用户选定方案）：挂起 → 作答经 cli 注入当前轮（queueNext 吸收，
  // 工具边界进模型上下文）→ 继续同一步；超时则收尾本轮（作答仍可在下一轮补答，
  // 与"审批超时=未执行但不阻塞后续"同待遇）。
  // 仅认**已闭合**的标记（与桥的提取口径一致，见 server/askuser.mjs）；写在本仓
  // 文档/代码里的"示例标记"若被模型原样复述会误触发，故留 kill switch：
  // PONOS_ASK_USER_BLOCK=0 关闭阻塞（默认开）。
  const ASK_USER_BLOCK = process.env.PONOS_ASK_USER_BLOCK !== '0'
  const ASK_USER_RE = /<!--\s*ASK_USER\b[\s\S]*?-->/
  const asksUser = (t) => ASK_USER_BLOCK && ASK_USER_RE.test(String(t ?? ''))
  let answerWaiter = null // (content) => void：cli 注入作答时唤醒
  let awaitingAnswer = false
  // R1-1 防重放（轮级）：已执行 tool_use id → 结果。runTurn 开头重置，
  // 同轮重复 id（重连重放）回填不重执行；跨轮自动失效（新轮新 map）
  let executedToolIds = new Map()
  // 后台子 agent 任务登记：taskId → { status, promise, laneStore, sysPrompt,
  // lineage, laneOptions, summary, outputFile, usage, stop }。S2 续跑复用
  // laneStore/sysPrompt（laneOptions 保白名单沿用）；S1 级联取消查
  // lineage.parentTaskId；进程退出即失（非持久化，spec 边界）
  const pendingSubAgents = new Map()
  // B3 排队任务 FIFO（2026-09-11）：{ taskId, start }——槽位释放时按派发顺序启动
  const pendingQueuedLanes = []
  // 前台子代理并发槽（第 10 项，2026-09-17）：与后台**共用** LANE_MAX_CONCURRENT 预算。
  // 为什么共用而非各给一份：预算代表同一份资源（模型 API 并发 + 本地 CPU），各给一份会让
  // 「最大并发子代理数」名不副实（实际可达 2N）。前台取不到槽时**等待**而不是被拒
  // （等待可被取消信号打断），后台排队任务仍走 FIFO、只补空位。
  let foregroundRunning = 0
  let slotWaiters = []
  function wakeSlotWaiters() {
    const ws = slotWaiters
    slotWaiters = []
    for (const w of ws) w()
  }
  /**
   * 前台子代理取槽：满则等待。返回释放函数（幂等；释放会唤醒等待者并补位后台队列）。
   * LANE_MAX_CONCURRENT <= 0 视为不限（与后台语义一致）。
   */
  async function acquireForegroundSlot(signal) {
    if (LANE_MAX_CONCURRENT <= 0) return () => {}
    let warned = false
    while (runningCount() >= LANE_MAX_CONCURRENT) {
      if (signal?.aborted) throw abortError()
      // 等待对用户是"主流程卡住"，必须可见（也让测试有确定性判据：上限 1 时必出现该告警）。
      if (!warned) {
        warned = true
        try { wire.warning({ level: 'subagent_concurrency', message: `子代理并发已满（上限 ${LANE_MAX_CONCURRENT}），本子任务排队等待槽位` }) } catch { /* 事件失败不影响主流程 */ }
      }
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError())
        if (signal?.aborted) { reject(abortError()); return }
        slotWaiters.push(() => { signal?.removeEventListener?.('abort', onAbort); resolve() })
        signal?.addEventListener?.('abort', onAbort, { once: true })
      })
    }
    foregroundRunning++
    let released = false
    return () => {
      if (released) return
      released = true
      foregroundRunning--
      wakeSlotWaiters()
      drainQueuedLanes()
    }
  }
  function runningCount() {
    // 前台在跑 + 后台在跑（queued 不计入，防自计数恒满——B3 的既有约定）
    let n = foregroundRunning
    for (const [, t] of pendingSubAgents) if (t.status === 'running') n++
    return n
  }
  // 槽位释放启动：任务终态（runLaneExecution 落 status 后）调用；FIFO 逐个补位
  function drainQueuedLanes() {
    if (LANE_MAX_CONCURRENT <= 0) return
    while (pendingQueuedLanes.length && runningCount() < LANE_MAX_CONCURRENT) {
      const q = pendingQueuedLanes.shift()
      const t = pendingSubAgents.get(q.taskId)
      if (!t || t.status !== 'queued') continue
      t.status = 'running'
      t.promise = q.start()
      try { wire.taskStarted({ taskId: q.taskId, toolUseId: '', prompt: '（排队任务启动）', parentTaskId: t.lineage?.parentTaskId ?? null, depth: t.lineage?.depth ?? 0 }) } catch { /* 事件失败不影响主流程 */ }
    }
  }
  // turnStats 记录器（内存 append-only）：health / result / stats 三个消费者共用
  const turnStats = []
  // P2-1③：lane 压缩可选开关 + 主会话 context（engineCtx.estimate 供 lane 压缩器阈值判定）
  const engineCtx = opts.context || null
  const LANE_COMPACT_ENABLED = process.env.PONOS_LANE_COMPACT === '1'
  // P2-2 预算护栏（热累计，进程内；跨会话/历史预算走 U1 文件聚合——两层互补）。
  // 单价 env：PONOS_PRICE_PER_M_INPUT/OUTPUT、PONOS_CACHE_READ_RATIO、
  // PONOS_PRICE_CACHE_WRITE_RATIO（P0-5：缓存写入溢价，默认 1.25 = Anthropic 5 分钟档；
  // 1 小时 TTL 传 2）；PONOS_BUDGET_USD >0 启用。告警不硬停（硬停决策交调用方/GUI）；
  // 进程重启护栏清零。
  const PRICES = {
    pricePerMInput: Number(process.env.PONOS_PRICE_PER_M_INPUT) || 0.2,
    pricePerMOutput: Number(process.env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
    cacheReadRatio: Number(process.env.PONOS_CACHE_READ_RATIO) || 0.1,
    cacheWriteRatio: Number(process.env.PONOS_PRICE_CACHE_WRITE_RATIO) || 1.25,
  }
  const BUDGET_USD = Number(process.env.PONOS_BUDGET_USD) || 0
  const sessionUsageAcc = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let budgetWarned = false

  // 历史优先走 session.deriveMessages()；无 session 时退化为内存数组（测试直连场景）
  const memoryHistory = []
  // K1.4 内存模式（无 session）的派生纪元：`memoryHistory.filter()` **每次新建数组**
  // （身份天然不稳），但记忆化要的是"内容变没变"，故用一枚与**唯一写入点**同址的计数器
  // 替代身份比较——计数器紧贴上面的数组声明，改历史而不 bump 在结构上不可能。
  let memoryRev = 0
  // systemPrompt 默认可变：cli 在 createEngine 后经 setSystemPrompt 注入三层组装
  // 提示词（基础行为规范 + AGENTS.md + append），直连测试可经 opts.systemPrompt 预置
  let systemPrompt = opts.systemPrompt || ''
  // 思考深度档位：null = auto（不注入，模型原生自适应）；off/low/high/max = 显式。
  // 初始来源：PONOS_REASONING_EFFORT（本内核自有命名）> auto
  let reasoningEffort = normalizeEffort(process.env.PONOS_REASONING_EFFORT || 'auto')
  function resolveEffort() { return reasoningEffort }
  function applyReasoningEffort(value) {
    const v = String(value ?? 'auto').trim().toLowerCase()
    reasoningEffort = normalizeEffort(v)
    return { value: v, effort: reasoningEffort ?? 'auto' }
  }

  function deriveHistory() {
    const base = session ? session.deriveMessages() : memoryHistory.filter((m) => m.role !== 'system')
    // loop --fresh：请求面跳过 fresh 之前的消息（transcript 继续记录，仅模型输入裁剪）
    return historySkip > 0 ? base.slice(historySkip) : base
  }
  // loop --fresh 窗口起点：记录当前消息条数，之后 deriveHistory 从该点起派生
  let historySkip = 0
  function setFreshWindow() {
    historySkip = session ? session.deriveMessages().length : memoryHistory.length
  }
  function pushMemory(m) {
    if (session) return
    memoryHistory.push(m)
    memoryRev++ // 与 push 同址：唯一写入点即唯一 bump 点（K1.4）
  }

  async function runTurnInternal({ content }) {
    // P0-3：轮起点清空"已拒灾难族"——语义严格对齐 spec 的「同一 turn 内」。
    // 跨轮重提属新的用户意图，应当重新询问（一次拒绝不该永久封禁该族命令）。
    deniedCatastrophicFamilies.clear()
    // P4-5：provider 热切换后每轮重解析模型（下一轮立即生效，无需重建 engine）
    model = opts.model || getProvider().model || ''
    let usage = {}
    // H2：当前迭代"单次请求" usage（health 水位信号）。usage 是轮级合计（本回合
    // 全部 API 调用之和，多工具步 agent 轮可达真实上下文的十几倍），不能代表
    // "当前上下文有多大"；最近一次单请求是其最接近的近似。每迭代 API 调用前
    // 重置，经 outcome.lastUsage → turnStats.lastUsage 供 health 消费。
    let callUsage = {}
    let textBuf = ''
    // 失真观测（2026-09-12 spec §4.2）：本轮"内容侧"证据。轮尾交给 health.recordTurnContent，
    // 供 fidelity 判定陈旧引用/矛盾/目标漂移。只留截断摘要，不留结果正文。
    const turnToolDigest = []
    const turnTexts = []
    let overflowRetries = 0
    // 溢出自愈可变输出预算：默认全量 maxTokens；上下文 400 揭示真实窗口后，把单次
    // 输出压到"当前 prompt 装得下"再重试（压缩无果时唯一可行解——vLLM 真实
    // max_model_len 低于配置窗口时，仅靠裁剪/摘要常无法腾出 64K 输出余量）
    let attemptMaxTokens = maxTokens
    // R3-1 本轮窗口预警已发标志（每轮至多一次）
    let contextWarned = false
    // R3-2 失败自愈/计划尾守卫：本轮存在 is_error 工具结果 → hadToolError；
    // guardInjections 记录本轮已注入的"继续执行"提示次数（防模型拒不配合时死循环）
    let hadToolError = false
    let guardInjections = 0
    let continueHeals = 0 // 输出截断自愈升档次数（本轮内累计，上限 CONTINUE_HEAL_MAX）
    const maxGuardInjections = Number(process.env.PONOS_GUARD_MAX || 3)
    // R1-1：每轮重置防重放集合（跨轮固定 id 不误判）
    executedToolIds = new Map()
    // 溢出自愈（上下文 400）不设硬计数中断：贴近端点真实窗口的长工具轮会因上下文
    // 渐进增长反复触发 400，按"是否产生实际进展"（压缩落地 / 输出预算还能收窄）
    // 决定继续与否——有进展就继续重试，直到无进展（压缩不可裁且预算已到 2048 下限）
    // 才终局发可见文本。硬计数 3 次会误杀第 4 次仍可收窄自愈的轮次（用户侧表现为
    // 发消息报"本轮执行出现内部错误"）。
    // —— agent loop 兜底状态（每轮重置）：守卫命中即优雅收尾（见文件头 PONOS_* 注释）——
    const turnT0 = Date.now()
    // 守卫⑥ 进展时间戳：成功且非只读测量的工具结果落地即刷新（见 LOOP_STALL_MS 注释）
    let lastProgressAt = turnT0
    let loopStop = null    // { reason, message }：重复/挂起/墙钟/熔断的收尾说明
    let iterCapHit = false // 单轮迭代硬上限耗尽（无文本时补说明）
    let errorStreak = 0    // 连续全部失败的工具迭代链
    let repeatStreak = 0   // 连续相同工具调用链（主调用规范键）
    let lastToolKey = ''   // 上一迭代主工具规范键
    let remindedAt = new Set() // 已注入提醒的重复次数（防同一阈值重复轰炸）
    let repeatHeals = 0    // ③/③b 命中后注入"推进指令"续跑次数（干净迭代清零，上限 REPEAT_HEAL_MAX）
    let healedLastIter = false // 上一迭代是否触发③/③b自愈注入（干净迭代后清零 repeatHeals 的判据）
    let stallHeals = 0     // ⑥ 命中后注入"推进指令"续跑次数（恢复实质进展即清零，上限 STALL_HEAL_MAX）
    let meltdownHeals = 0  // ④ 熔断前注入"排查失败原因"次数（工具成功即清零，上限 MELTDOWN_HEAL_MAX）
    let idleHeals = 0      // 空闲中断（已产出后停顿）续写注入次数（实质进展即清零，上限 IDLE_HEAL_MAX）
    let upstreamDeadHeals = 0 // 上游空流退避重试次数（收到任意块即清零，上限 UPSTREAM_DEAD_HEAL_MAX）
    let tinyLandings = 0     // 压缩"落地但释放过小"连续计数（≥3 熔断压缩循环，直走裁剪/索引适配，2026-09-11）
    let usageAnomalyWarned = false // D1 usage 对账：本轮已告警过异常放大（每轮至多一次）
    let overflowTrimmed = null  // 终局裁剪副本（2026-09-10）：压缩/预算均无解时请求面用裁剪版
    // 上游零数据挂起（首内容宽限耗尽仍无 chunk）自动重试计数：排队/瞬态负载一次重试
    // 常能恢复（2026-09-09 长任务挂起事故）。上限 IDLE_DEAD_RETRY_MAX，重试前小幅退避。
    let idleDeadRetries = 0
    // 请求消息 = system 前缀（api.mjs 抽顶层）+ 派生历史；session/memory 两模式一致。
    // 孤儿 tool_use 补丁（P1-8）在派生后执行（纯派生不入日志，请求面永远合法）
    // K1.4：按 (派生纪元, fresh 窗口, systemPrompt 引用, contentEpoch) 记忆化，一步内
    // 多次求值只构造一次（无 session 的直连测试走同址 bump 的 memoryRev）
    const requestFace = createRequestFace({
      getBase: deriveHistory,
      getRevision: () => (session ? session.revision() : memoryRev),
      getSkip: () => historySkip,
      getSystem: () => systemPrompt,
    })
    // 失真红线锚点注入（2026-09-15 闭环）：此前 anchorText 只经 ponos_health 事件发
    // GUI，等用户点"重新锚定"回传 anchor_applied 才置 resolved——**内核从不把锚点
    // 注入模型上下文**，检测到失真等于只报警不处置。此处把它并入请求面尾部
    // （withAnchorTail，纯派生，不改 requestFace 缓存对象）。
    // 缓存双键 = 「失真指纹 + 基准 face 对象身份」：
    //  · 必须缓存结果而不只是记指纹——估算(979/1140)、看门狗(1128) 会先于实际请求
    //    (1146) 调用 requestMessages，只记指纹会让估算"吃掉"那次注入，实际请求反而
    //    拿不到锚点（闭环静默失效）；缓存结果后它们看到同一份带锚点的消息。
    //  · 必须绑 face 身份——只按指纹缓存会在历史更新后继续返回基于旧 face 的数组
    //    （把过期内容发给模型）。face 内容变化时会重建对象，身份变化即自然失效。
    let anchorKey = null
    let anchorBase = null
    let anchorFace = null
    // 注入节流状态（2026-09-16 活跃度巡检，语义见 engine-config 的 FID_ANCHOR_* 注释）：
    // 注入缓存的键是「锚点指纹 + face 对象身份」，而 face 每步必变 ⇒ 旧实现等价于
    // "red 期间每个请求步都注入一次"（实测单会话 388 次 / 748 请求 = 52%）。
    let anchorInjectStreak = 0 // 同一指纹连续注入次数
    let anchorSkipFace = null  // 已判定"本次跳过"的 face——同一 face 会被估算/看门狗/实际
                               // 请求多次求值，不记身份就会把一次跳过重复计数成多次
    let anchorSkipStreak = 0   // 同一指纹连续跳过次数（达 REINJECT_EVERY 即补注一次）
    const requestFaceWithAnchor = () => {
      const face = requestFace()
      const resetAnchor = () => {
        anchorKey = null; anchorBase = null; anchorFace = null
        anchorSkipFace = null; anchorInjectStreak = 0; anchorSkipStreak = 0
      }
      if (!isFidAnchorOn()) { resetAnchor(); return face }
      let a = null
      try { a = health && typeof health.fidelityAnchor === 'function' ? health.fidelityAnchor() : null } catch { a = null }
      if (!a || !a.text) { resetAnchor(); return face }
      const key = a.ids && a.ids.length ? a.ids.slice().sort().join(',') : 'no-id'
      const sameKey = key === anchorKey
      // 上下文收缩（压缩/裁剪发生）＝旧锚点已被遮蔽 → 不受节流约束，立即重注
      const shrunk = Array.isArray(anchorBase) && face.length < anchorBase.length
      if (sameKey && anchorBase === face && anchorFace) return anchorFace
      if (sameKey && anchorSkipFace === face) return face
      if (FID_ANCHOR_MAX_CONSEC > 0 && FID_ANCHOR_REINJECT_EVERY > 0
        && sameKey && !shrunk
        && anchorInjectStreak >= FID_ANCHOR_MAX_CONSEC
        && anchorSkipStreak < FID_ANCHOR_REINJECT_EVERY) {
        anchorSkipFace = face
        anchorSkipStreak++
        return face
      }
      anchorKey = key
      anchorBase = face
      anchorFace = withAnchorTail(face, a.text)
      // D 断反馈环（2026-09-16）：把"本轮确实注入了锚点"回报 fidelity——该轮里复述锚点
      // 权威值的事实不再计入矛盾对（否则锚点要求的复述会被判成模型自相矛盾 → 失真分被
      // 自己抬高、窗口延长 → 更多锚定）。只在**确实注入**的分支回报：被节流跳过的那步
      // 模型根本没看到锚点，此时它复述旧记忆不算"权威更新"，不该豁免。
      try { if (health && typeof health.markFidelityAnchorInjected === 'function') health.markFidelityAnchorInjected(a.text) } catch { /* 标记失败不阻断请求 */ }
      anchorSkipFace = null
      if (sameKey && !shrunk) { anchorInjectStreak++; anchorSkipStreak = 0 }
      else { anchorInjectStreak = 1; anchorSkipStreak = 0 }
      try { console.error(`[fidelity] anchor injected: ${(a.ids && a.ids.length) || 0} issue(s)`) } catch { /* 日志失败不阻断请求 */ }
      return anchorFace
    }
    const requestMessages = () => perfTime('req', requestFaceWithAnchor)
    // pre-step 测压检查点：每轮请求前（工具结果/上轮产物已落日志之后）
    async function preStep() {
      if (!compactor || !session) return
      const msgs = session.deriveMessages()
      // outputBudget = 本轮输出预算：maybeCompact 据此把阈值收窄到 window−预算−余量，
      // 防"估算低于比例阈值、但请求 input+max_tokens 已超端点真实窗口"的溢出
      const r = await compactor.maybeCompact({ system: systemPrompt || '', messages: msgs, outputBudget: attemptMaxTokens })
      // 压缩决策显式落 stderr（2026-09-12 T1 诊断项）：此前"究竟有没有压缩、被哪条
      // 判据挡下"只能从 [api] POST 的 msgs 跳变反推（关键词 grep 全仓 0 命中）。
      // 只记非默认决策，避免每轮刷屏（常态 below-threshold 不落）。
      if (r?.action !== 'none' || (r?.reason && r.reason !== 'below-threshold')) {
        try { console.error(`[compact] action=${r?.action || '-'} reason=${r?.reason || '-'} msgs=${r?.msgs ?? msgs.length} est=${r?.est ?? '-'} maxMessages=${r?.maxMessages ?? '-'}`) } catch { /* 日志失败不影响主流程 */ }
      }
      // M2：摘要调用是一次完整 API 请求（prefill 含被遮蔽历史数万 token），
      // 其 usage 并入本轮（再进 turnStats/result/最终条目）
      if (r?.usage) usage = addUsage(usage, r.usage)
      // 本轮请求面估算（口径唯一：estimateRequest）。pre-step 里两个守卫都要它——
      // 一次算好复用，既避免同一份 1MB 历史被重复扫两遍，也保证两处判定同源
      //（历史教训：并行维护的第二个计数口径必然漂移，见 context.mjs estimateTokens 注释）
      const w = engineCtx?.window
      const needsWarn = r?.action === 'none' && !contextWarned
      const needsClamp = Number.isFinite(w) && w > 0
      let estIn = 0
      if (needsWarn || needsClamp) {
        try { estIn = estimateRequest({ system: systemPrompt, messages: requestMessages() }).total } catch { estIn = 0 }
      }
      // R3-1 窗口余量预警：未触发压缩但估算已达阈值线（默认 75% 窗口）时发
      // ponos_warning（每会话至多一次；GUI 渲染警示条，提醒长会话即将压缩）。
      // 2026-09-12 修：旧实现按**字符数**与 150_000 比较（≈4 万 token ≈ 20% 窗口），
      // 比注释宣称的 75% 早 4 倍误报，且与压缩判定用的是两套口径——本次卡顿事故中
      // 它一路显示"即将触发自动压缩"而压缩实际 0 次（估算漏计 tool_use.input）。
      // 现与压缩/钳制同源同单位（token），默认随窗口缩放；env 显式设置时按绝对 token 覆盖。
      const warnWindow = Number.isFinite(w) && w > 0 ? w : DEFAULT_WINDOW
      if (needsWarn) {
        const budget = Number(process.env.PONOS_CONTEXT_WARNING_BUDGET) || Math.floor(warnWindow * 0.75)
        if (estIn >= budget) {
          contextWarned = true
          wire.warning?.({ level: 'context', tokens: estIn, budget, message: '上下文接近压缩阈值，长会话即将触发自动压缩' })
        }
      }
      // —— 调用时输出预算钳制（2026-09-10 小窗口本地模型适配）——
      // 窗口在每次模型调用时生效：est(input) + max_tokens 超窗即收窄，保证请求恒可
      // 装下——本地小窗口模型（32K-64K）配大默认预算（64K/16K）不再必然撞 400。
      // resolveThreshold 对"预算近乎占满窗口"的异常配置退化回纯比例，本钳制补上
      // 该退化形态的缺口（est 低于比例阈值但请求 input+max_tokens 必 400）。
      if (Number.isFinite(w) && w > 0) {
        const clamped = clampOutputBudgetForWindow({ window: w, inputEst: estIn, budget: attemptMaxTokens })
        if (clamped !== null && clamped < attemptMaxTokens) {
          attemptMaxTokens = clamped
          try { wire?.system?.('output_budget_clamped', { window: w, estInputTokens: estIn, maxTokens: clamped }) } catch { /* 事件失败不影响主流程 */ }
        }
      }
    }
    // 本轮已写最后一条 assistant 条目（M1 空文本收尾轮把 usage 挂到它上面）
    let lastAssistantEntry = null
    // usage 只写在轮次最终 assistant 条目上（M1 修复）：中间工具轮条目不带 usage，
    // 仅带 model。空文本收尾轮（tool-only / 溢出后置分支）恰好一个带 usage 的
    // assistant 条目——把 usage 挂到本轮最后一条已写条目；无已写条目则跳过
    // （无用量可计，且不追加空内容条目以免破坏 API 消息流）。
    // 提问挂起：等 cli 把用户作答注入当前轮（queueNext）或超时。返回 true = 已作答。
    // 硬看门狗展期必须有配对的 begin/end——漏掉 end 会让等待窗口变成常态（见 protocol.mjs）。
    async function waitForAnswer() {
      const timeoutMs = Math.max(1000, Number(process.env.PONOS_ASK_USER_TIMEOUT_MS || process.env.PONOS_APPROVAL_TIMEOUT_MS || 600_000))
      awaitingAnswer = true
      beginAwaitingUser()
      try {
        const answered = await new Promise((resolvePromise) => {
          const timer = setTimeout(() => { answerWaiter = null; resolvePromise(false) }, timeoutMs)
          answerWaiter = (content) => { clearTimeout(timer); resolvePromise(true) }
        })
        // 超时无作答：不是错误，也不注入任何"没人回答"的合成消息——直接收尾本轮，
        // 用户稍后作答仍是同一上下文里的下一轮（避免在 transcript 里留假对话）
        if (!answered) {
          try { console.error(`[engine] ASK_USER 等待作答复超时（${timeoutMs}ms）→ 收尾本轮，作答可在下一轮补上`) } catch {}
        }
        // 取消/打断唤醒（rejectAllWaiters）后不得继续跑：抛 AbortError 走既有取消
        // 收尾路径（cli 输出「已取消。」+ result，Stop 按钮体验依赖该路径）。
        if (signal.aborted) throw abortError()
        return answered
      } finally {
        answerWaiter = null
        awaitingAnswer = false
        endAwaitingUser()
      }
    }

    const finalizeUsage = () => {
      if (!session) return
      if (textBuf.trim()) {
        // 最终 assistant 条目由 engine 写入（带 usage/model；cli 不再重复落盘）
        lastAssistantEntry = session.appendAssistant([{ type: 'text', text: textBuf }], { usage, model })
        return
      }
      if (hasUsage(usage) && lastAssistantEntry) {
        session.setEntryUsage(lastAssistantEntry, usage)
      }
    }
    // K0 观测：轮序号（turnStats 每轮尾 push 一条 ⇒ 本轮序号 = 已完成轮数 + 1）
    const perfTurn = turnStats.length + 1
    let perfIter = 0 // 末次迭代号（循环外结算最后一步用：迭代变量出不了 for 作用域）
    for (let iter = 0; ; iter++) {
      perfIter = iter
      // K0 观测：结算**上一步**。放迭代头而非各出口——continue 出口有十余处
      // （967/1345/1362/1382/1405/1414/1422/1433/1448…），此处一处覆盖全部出口。
      if (iter > 0) {
        perfSpan('tail', 'genEnd') // 生成结束 → 本迭代头
        perfStep(perfTurn, iter - 1)
      } else {
        perfBegin() // 首迭代只开账，无上一步可发
      }
      // 守卫①：轮次墙钟——默认关闭（2026-09-10 取消 30 分钟上限，见 TURN_TIMEOUT_MS
      // 注释）；显式设 PONOS_TURN_TIMEOUT_MS>0 时单轮累计时长超限即优雅收尾。
      if (TURN_TIMEOUT_MS > 0 && Date.now() - turnT0 >= TURN_TIMEOUT_MS) {
        loopStop = {
          reason: 'timeout',
          message: `【已达单轮时长上限（${Math.max(1, Math.round(TURN_TIMEOUT_MS / 60000))} 分钟），为防止挂起已自动收尾。任务可能未完——可发送「继续」让模型接续。】`,
        }
        break
      }
      // 守卫②：迭代硬上限——耗尽即收尾（无文本时补说明，见轮末 iterCapHit）
      if (MAX_TOOL_ITERATIONS > 0 && iter >= MAX_TOOL_ITERATIONS) { iterCapHit = true; break }
      // 守卫⑥：无进展停滞（自愈优先，2026-09-10）——距上次实质进展超限时先注入
      // "推进指令"续跑（用户无感知）；恢复实质进展即清零愈合计数；耗尽
      // STALL_HEAL_MAX 仍无进展才落可见收尾（硬停是最后防线，非默认路径）。
      if (LOOP_STALL_MS > 0 && Date.now() - lastProgressAt >= LOOP_STALL_MS) {
        if (stallHeals < STALL_HEAL_MAX) {
          stallHeals++
          lastProgressAt = Date.now() // 注入后重开一个完整观察窗
          const inject = '【系统】检测到你长时间没有实质进展（连续只读测量/重复调用、无新结果或文件变更）。请停止测量与重复尝试，直接执行下一步实质操作（修改文件/执行命令/完成剩余步骤），或向用户明确汇报当前卡点与结论。'
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
          try { wire?.system?.('guard_heal', { reason: 'loop-stall', attempt: stallHeals, max: STALL_HEAL_MAX }) } catch { /* 事件失败不影响主流程 */ }
          continue
        }
        loopStop = {
          reason: 'loop-stall',
          message: `【检测到长时间无实质进展（${Math.max(1, Math.round(LOOP_STALL_MS / 60000))} 分钟内只有只读测量/重复调用、无新结果或文件变更），已自动收尾以防循环。可发送「继续」让模型换一种方式推进，或补充更明确的指令。】`,
        }
        break
      }
      if (loopStop) break
      // ③/③b 愈合计数清零：上一迭代未触发自愈注入（干净迭代 = 已恢复）→ 重新获得
      // 完整愈合预算；真循环每轮必命中（healedLastIter 恒 true），预算照常耗尽。
      if (!healedLastIter) repeatHeals = 0
      healedLastIter = false
      await perfTimeAsync('pre', () => preStep())
      // P8 排队插话注入（工具边界）：每次 API 调用前吸收 pendingNext 进当前轮
      // （appendUser 落 transcript，请求面 deriveMessages 自动包含；模型下一轮
      // 请求即见补充信息）。started 确认已在 queueNext 吸收时经 command_lifecycle
      // 发出。轮次结束仍有残余（纯文本阶段）→ cli 轮末作为新轮处理。
      if (pendingNext.length) {
        const injects = pendingNext.splice(0)
        for (const inj of injects) {
          if (session) session.appendUser(inj.content)
          else pushMemory({ role: 'user', content: inj.content })
        }
      }
      const blocks = []
      let overflowed = false
      let stopReason = null
      // 生成重复检测窗：thinking+text 同窗累计（用户死循环形态在思考/生成打转），
      // 只留尾部 400 字符参与周期重复判定（长正常输出不误伤）。
      let genWindow = ''
      // 守卫③b 句级近重复检测器（同窗同生命周期：每次 API 调用一个实例，thinking+text
      // 均喂入）。关闭态（RECENT=0 / LOOP_GUARD=0）工厂返回 no-op，零额外开销。
      const nearRep = NEAR_REPEAT_RECENT > 0
        ? createNearRepeatDetector({ back: NEAR_REPEAT_BACK, sim: NEAR_REPEAT_SIM, recent: NEAR_REPEAT_RECENT, avg: NEAR_REPEAT_AVG, codeSkip: NEAR_REPEAT_CODE_SKIP })
        : null
      // 流式空闲看门狗：单次模型流内无块间隔超 STREAM_IDLE_MS 判挂起。挂起时 abort
      // 内部 controller → 下层 fetch 拒绝 → catch 分支按"内部挂起"优雅收尾（区别于
      // 用户取消；用户取消走外层 signal）。守卫关闭（STREAM_IDLE_MS=0）时全为 no-op。
      // K1.3：自适应窗口传**提供者**——首内容窗口只在"等到 STREAM_IDLE_MS 仍无数据"时
      // 才求值，正常首字节不再付那次 16.7ms 的 JSON.stringify（见 makeIdleWatchdog 头注）
      const watchdog = makeIdleWatchdog(STREAM_IDLE_MS, () => adaptiveFirstByteMs(requestMessages, STREAM_FIRST_BYTE_MS))
      // P1-11 本流是否产出过内容：区分"上游空转挂起（0 产出）"与"模型推理中途停顿
      // （已产出内容后卡住）"，给不同收尾提示；也用于 dead-stream 快速失败分支判定。
      let attemptData = false
      const outerSig = rawAbortSignal(signal)
      const combinedSignal = watchdog.controller && typeof AbortSignal.any === 'function'
        ? (outerSig ? AbortSignal.any([outerSig, watchdog.controller.signal]) : watchdog.controller.signal)
        : signal
      // D1 请求规模对账基线：启发式估算本请求输入 token（与压缩同口径）。
      // usage 到达时与服务端报告值比对——3 倍以上偏差说明请求组装层存在放大
      //（2026-09-09 曾出现 307 万 token 请求，正常应为 ~17 万）。
      let estInputTokens = 0
      try { estInputTokens = estimateRequest({ system: systemPrompt, messages: requestMessages() }).total } catch { estInputTokens = 0 }
      callUsage = {} // H2：本迭代单请求 usage 重置（retryStream 内部瞬时重试重发同请求，累加仍≈1 倍）
      // 请求面：优先用溢出分支瘦身后的副本重试，**取用即消费**（下一迭代无论成败都重新
      // 从 transcript 派生——失败时溢出分支会按最新历史重新瘦身，新落地的工具结果不丢）。
      // 2026-09-12 事故修复：副本原先在 continue 前被无条件清空 → 瘦身成功的副本从未被
      // 真正用上，同一个超窗请求被无限重发（长会话 UI 压缩条闪烁 + 400 风暴）。
      const reqFace = overflowTrimmed || requestMessages()
      overflowTrimmed = null
      perfMark('streamStart') // K0：TTFB 段起点（请求面组装完 → 首个 chunk）
      try {
        for await (const chunk of retryStream({
          model,
          messages: reqFace,
          maxTokens: attemptMaxTokens,
          signal: combinedSignal,
          tools: tools.toolSchemas(),
          reasoningEffort: resolveEffort(),
        })) {
          if (signal.aborted) throw abortError()
          watchdog.tick()
          if (!attemptData) { perfSpan('ttfb', 'streamStart'); perfMark('firstChunk') } // K0：首字节
          attemptData = true // 收到任意 chunk（含 thinking/usage）即视上游在产出
          upstreamDeadHeals = 0 // 上游活过来了 → 空流愈合计数清零
          if (chunk.type === 'text') {
            textBuf += chunk.text
            genWindow = (genWindow + chunk.text).slice(-400)
            wire.assistant([{ type: 'text', text: chunk.text }])
          } else if (chunk.type === 'thinking') {
            genWindow = (genWindow + chunk.text).slice(-400)
            wire.assistant([{ type: 'thinking', thinking: chunk.text }])
          } else if (chunk.type === 'tool_use') {
            // R1-1 同流防重放：重复 id 只保留首个（模型重发同工具时防 tool_result
            // 重复与 assistant 重复 id 触发 API 400）；跨 iteration 重放由轮级
            // executedToolIds 兜底
            if (blocks.some((b) => b.id === chunk.id)) continue
            blocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input })
            // 工具调用块随 assistant 事件转发 GUI（工具卡片展示）
            wire.assistant([{ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input }])
          } else if (chunk.type === 'usage') {
            usage = addUsage(usage, chunk.usage)
            callUsage = addUsage(callUsage, chunk.usage) // H2：单请求水位信号
            // D1 usage 对账：服务端报告 input_tokens 远超本端估算（3 倍且绝对量
            // 超 50 万）→ 请求组装疑似放大。落 stderr（kernel-stderr.log 诊断项
            // 可见）+ UI 告警条，供当场定位（每轮至多一次，防刷屏）。
            // 2026-09-12：对账口径改为 requestTokens（input + cache_read + cache_write）。
            // 旧实现只取 input_tokens，而 KV 前缀缓存端点上 input_tokens 只是"本轮新增
            // 的未缓存尾部"（实测本会话 ~5K，而整请求面 ~30 万），与"整请求估算"根本
            // 不可比 → 在 DeepSeek/Anthropic 这类端点上此守卫恒不触发、形同虚设
            //（恰是本次卡顿事故中该报警却全程沉默的原因之一）。
            const reported = requestTokens(chunk.usage)
            if (!usageAnomalyWarned && estInputTokens > 0 && reported > Math.max(estInputTokens * 3, 500_000)) {
              usageAnomalyWarned = true
              const msg = `内核：usage 对账异常——服务端报告请求面 ${reported}（input=${Number(chunk.usage?.input_tokens) || 0} + cache_read=${Number(chunk.usage?.cache_read_input_tokens) || 0}），本端估算 ${estInputTokens}（超 3 倍），疑似请求组装放大，请检查 compact/derive 管线`
              console.error(msg)
              wire.warning?.({ level: 'usage', message: msg })
            }
          } else if (chunk.type === 'stop_reason') {
            stopReason = chunk.reason
          }
          // 守卫①b：墙钟（流内版）——默认关闭（同守卫①，2026-09-10）；显式设
          // PONOS_TURN_TIMEOUT_MS>0 时覆盖"块持续流动但整体久拖不完"形态（iteration
          // 边界的墙钟检查拦不住单次超长生成）。命中即中断流，说明文本见轮末 finalize。
          if (!loopStop && TURN_TIMEOUT_MS > 0 && Date.now() - turnT0 >= TURN_TIMEOUT_MS) {
            loopStop = {
              reason: 'timeout',
              message: `【已达单轮时长上限（${Math.max(1, Math.round(TURN_TIMEOUT_MS / 60000))} 分钟），为防止挂起已自动收尾。任务可能未完——可发送「继续」让模型接续。】`,
            }
            watchdog.controller?.abort()
          }
          // 守卫③：生成重复检测（每块尾部滚动查一次）——同一片段连续重复 ≥3 次
          // 即判退化循环，abort 当前流并优雅收尾（防 thinking/文本死循环烧 token）。
          // genWindow 满 60 字符才可能触发（minPeriod×minRepeats），短输出不受影响。
          if (!loopStop) {
            const rep = detectGenerationRepeat(genWindow)
            if (rep) {
              loopStop = {
                reason: 'gen-repeat',
                message: `【检测到模型生成内容重复打转（同一片段连续重复 ${rep.repeats} 次、周期 ${rep.p} 字符），已自动收尾以防死循环。可发送「继续」让模型换一种方式接续，或补充更明确的指令。】`,
              }
              watchdog.controller?.abort() // 终止当前流，不再消费后续块
            }
          }
          // 守卫③b：句级近重复检测（每块把 text/thinking 喂入句指纹池）——编织变体
          // 循环（同一批内容措辞微变反复重述，无整段原样复制）由本守卫在句粒度识别：
          // 最近窗内新句的平均"旧句近邻数"超标即中止。精确周期检测（③）抓不到的形态。
          if (!loopStop && nearRep && (chunk.type === 'text' || chunk.type === 'thinking')) {
            const nrep = nearRep.push(chunk.text)
            if (nrep) {
              loopStop = {
                reason: 'near-repeat',
                message: `【检测到模型输出近似内容反复打转（同一批内容措辞微变重复重述，近期每句平均约 ${nrep.avgNeighbor} 句近似旧句），已自动收尾以防死循环。可发送「继续」让模型换一种方式接续，或补充更明确的指令。】`,
              }
              watchdog.controller?.abort() // 终止当前流，不再消费后续块
            }
          }
        }
        perfSpan('gen', 'firstChunk') // K0：首 chunk → 生成结束
        perfMark('genEnd')
      } catch (err) {
        perfMark('genEnd') // K0：异常出口同样打点（否则本步 tail 段缺失）
        // 用户取消永远优先于守卫收尾（同一时刻双触发时按取消语义上报）
        if (signal.aborted) { watchdog.stop(); throw abortError() }
        // 守卫自身 abort 引发的拒绝：墙钟/重复已在流内设 loopStop → 吞掉按守卫收尾
        if (loopStop) {
          // no-op：轮末 finalize 输出说明文本
        } else if (watchdog.tripped) {
          // 内部空闲看门狗触发：不是网络/API 错误，也不是用户取消。
          // P1-11 区分两种形态：全程 0 产出（上游空转/未就绪）vs 已产出后停顿
          // （疑似模型推理卡住）。2026-09-09：零数据形态优先自动重试——自建/共享
          // 服务 prefill 排队超时常见（首内容宽限耗尽≠服务已死），小幅退避后重发
          // 一次常能恢复；重试耗尽才按挂起收尾引导检查 provider。
          if (!attemptData && idleDeadRetries < IDLE_DEAD_RETRY_MAX) {
            idleDeadRetries++
            watchdog.stop() // 旧看门狗定时器回收（新迭代会重建）
            await sleep(IDLE_DEAD_RETRY_BACKOFF_MS)
            continue // 新迭代重建 watchdog（首内容窗口重新计时）
          }
          // 无感愈合（2026-09-10）：已产出后停顿（疑似推理中断）→ 保留已产出内容、
          // 注入续写指令静默续跑（用户看到无缝续写）；耗尽 IDLE_HEAL_MAX 才可见收尾。
          if (attemptData && (IDLE_HEAL_MAX < 0 || idleHeals < IDLE_HEAL_MAX)) {
            idleHeals++
            watchdog.stop()
            if (textBuf.trim()) {
              pushMemory({ role: 'assistant', content: [{ type: 'text', text: textBuf }] })
              if (session) session.appendAssistant([{ type: 'text', text: textBuf }], { model })
            }
            const inject = '【系统】检测到你的回复在中途停顿（疑似推理中断）。请从上一条回复的断点处直接继续输出剩余内容——不要从头复述，不要重新解释已完成的部分。'
            pushMemory({ role: 'user', content: inject })
            if (session) session.appendUser(inject)
            try { wire?.system?.('guard_heal', { reason: 'idle-interrupted', attempt: idleHeals, max: IDLE_HEAL_MAX }) } catch { /* 事件失败不影响主流程 */ }
            textBuf = ''
            continue
          }
          loopStop = attemptData
            ? {
                reason: 'idle',
                message: `【模型输出中断（${Math.max(1, Math.round(STREAM_IDLE_MS / 1000))} 秒无数据，此前已产出部分内容——疑似模型推理中途停顿），已按挂起自动收尾。可发送「继续」让模型重试。】`,
              }
            : {
                reason: 'upstream-dead',
                message: `【模型输出中断（连接建立后 ${Math.max(1, Math.round(STREAM_FIRST_BYTE_MS / 1000))} 秒未收到任何数据——上游疑似未就绪/空转），已按挂起自动收尾。可发送「继续」重试，或检查 provider 对应模型服务是否正常后换一种方式继续。】`,
              }
        } else if (classifyApiError(err).kind === 'model-not-found') {
          // 模型不存在/已下线（2026-09-11 改名适配）：配置级错误——引导用户重新探测
          // 模型清单（桥探测按服务端清单自动适配旧名），不盲目重试
          loopStop = {
            reason: 'model-not-found',
            message: `【当前模型「${model}」不存在（可能已被提供方下线或改名）。请到设置 → 模型 → 点「探测」重新获取可用模型清单（旧模型名会自动适配到新模型），或手动切换模型后继续。】`,
          }
        } else if (classifyApiError(err).kind === 'tools-unsupported') {
          // 工具能力未开启（2026-09-12）：vLLM 类端点收到 tools 后要求 tool_choice 可用，
          // 而服务未以 --enable-auto-tool-choice --tool-call-parser 启动 → 带工具的请求
          // 必 400（实测：该形态下只有"不带 tools"的请求能过）。配置级错误——重试、去缓存、
          // 收窄预算全是同一个 400，故在此落可操作引导，不做任何自动降级（本应用靠工具执行
          // 任务，静默去掉 tools 只会让模型空谈不干活，比报错更难排查）。
          // 注意文案含"先确认端口/代理指向"：实测存在服务端已开参数、但应用连的是另一个
          // 未开启的后端（代理/端口指向别的容器）的情形——只让用户改启动参数会白折腾。
          loopStop = {
            reason: 'tools-unsupported',
            message: `【当前 provider 未开启工具调用：服务端以"未启用 tool_choice"拒绝了带工具定义的请求。若服务端已用 --enable-auto-tool-choice --tool-call-parser <解析器>（Qwen3.x 常见 qwen3_xml / hermes，按模型族选）启动，请先确认本应用配置的 API 地址/端口确实指向该服务（代理或端口可能转到了另一个未开启工具调用的后端）；未开启时请补齐这两个启动参数后重启服务。也可到设置 → 模型换一个支持工具调用的 provider。本应用靠工具执行任务，未开启时无法工作。】`,
          }
        } else if (classifyApiError(err).kind === 'dead-stream') {
          // P1-11 空流：请求已受理（HTTP 200）但 0 事件即断/EOF（vLLM 引擎加载中/崩溃
          // 的典型形态）。无感愈合（2026-09-10）：引擎加载中常见，退避后静默重试
          // UPSTREAM_DEAD_HEAL_MAX 次才可见收尾（retryStream 的 1 次快重试仍保留，
          // 本层是更长的退避重试）。
          if (upstreamDeadHeals < UPSTREAM_DEAD_HEAL_MAX) {
            upstreamDeadHeals++
            try { wire?.system?.('guard_heal', { reason: 'upstream-dead', attempt: upstreamDeadHeals, max: UPSTREAM_DEAD_HEAL_MAX }) } catch { /* 事件失败不影响主流程 */ }
            await sleep(UPSTREAM_DEAD_HEAL_BACKOFF_MS)
            continue
          }
          loopStop = {
            reason: 'upstream-dead',
            message: `【上游服务空流：请求已被受理但未返回任何数据（疑似模型服务未就绪、加载中或已崩溃），已自动收尾。请检查 provider 对应服务是否正常，或切换 provider 后重试。】`,
          }
        } else if (classifyApiError(err).kind === 'context-window' && compactor && session) {
          // 溢出兜底：先压缩腾 prompt 空间；压缩落地 → 全量输出预算重试；压缩不可落地
          // （总量未达可裁阈值 / 配置窗口虚高致保留预算 > 整段对话 / 摘要熔断）→ 收窄
          // 输出预算再试。两条路只按"是否产生实际进展"继续，不再受溢出次数硬中断——
          // 贴近端点真实窗口的长工具轮会因上下文渐进增长反复 400，若第 3~4 次直接
          // throw，整轮会死在 runTurn 内部错误兜底（用户侧：发消息报内部错误、任务中断）。
          // 分类覆盖 Anthropic context_window_exceeded 与 vLLM/OpenAI "maximum context
          // length" 400（见 api.mjs classifyApiError）。limit：解析端点真实窗口传给压缩器，
          // 防摘要请求自身超限（配置窗口虚高于真实 max_model_len 时必现，否则压缩也不落地）。
          const genBefore = session.getSurface().replaceGeneration
          const realLimit = /maximum context length is (\d+)\s*tokens?/i.exec(err?.message || '')
          const promptN = /prompt contains (?:at least )?(\d+)\s*(?:input\s+)?tokens?/i.exec(err?.message || '')
          const limit = realLimit ? Number(realLimit[1]) : 0
          // —— 窗口真实化：400 揭示的端点真实 max_model_len 持久化进压缩器 context ——
          // 配置窗口虚高（GUI 256k vs vLLM 实际 131k）时 pre-step 阈值按虚高窗口算，
          // 主动压缩永不触发 → 每轮撞 400 被迫 forceCompact（"几乎跑完一两轮就压缩"）。
          // 采纳后阈值/保留/老化按真实窗口走，压缩转为到点主动触发。只下调不上调。
          if (limit > 0) {
            try {
              const adopted = compactor.adoptWindow(limit)
              if (adopted?.adopted) {
                // 输出预算封顶：真实窗口 ≤ 当前输出预算时任何请求都放不下
                // （input≥0 + max_tokens > window），直接压到半窗水平（大窗
                // 131k > 64k 预算的主场景不触发，仅小窗模型受惠）
                if (adopted.window < attemptMaxTokens) {
                  attemptMaxTokens = Math.max(2048, Math.floor(adopted.window * 0.5))
                }
                wire?.system?.('context_window_adopted', { window: adopted.window })
              }
            } catch { /* 窗口采纳失败不阻断自愈（仍走既有 forceCompact + 预算收窄） */ }
          }
          let r = null
          let compactErr = null
          // 重试预算耗尽标志：置位后本迭代不再付摘要成本（每次摘要都是一次完整 API
          // 请求，窗口装不下时必然失败），也不再瘦身/收窄——直落终局可见文案。
          const retryBudgetOut = MAX_OVERFLOW_RETRIES > 0 && overflowRetries >= MAX_OVERFLOW_RETRIES
          // 压缩空转熔断（2026-09-11 补）：连续 3 次"落地但释放过小"后跳过 forceCompact，
          // 直走预算收窄/裁剪/硬适配——否则每轮溢出仍付 70s+ 摘要成本空转（实测
          // 180K 会话循环形态：retainHint 过大 → covered 仅 1-2 条 → 摘要落地不释放）。
          if (!retryBudgetOut && tinyLandings < 3) {
            try {
              r = await compactor.forceCompact({
                system: systemPrompt,
                messages: session.deriveMessages(),
                limit: limit || undefined,
                // 输出预算已定时的保留预算上限：retain ≤ 真实窗口 − 当前输出预算 − 余量。
                // 配置窗口（GUI 设 256k/1M）虚高于端点真实 max_model_len 时，默认 retain
                // 预算 > 整段对话 → 压缩永无可裁切点；按真实窗口反推保留上限，才能让压缩
                // 在贴近端点硬限时真正落地（否则只能靠输出收窄，质量与耗时双损）。
                retainHint: limit > 0 ? Math.max(4096, limit - attemptMaxTokens - 32768) : undefined,
              })
            } catch (ce) { compactErr = ce } // 压缩请求自身失败：降级走输出预算收窄，不让压缩异常杀掉自愈
          }
          const genAfter = session.getSurface().replaceGeneration
          // M2：溢出路径的摘要调用同样是完整 API 请求，usage 并入本轮
          if (r?.usage) usage = addUsage(usage, r.usage)
          if (genAfter > genBefore) {
            // 压缩真实落地 → 上下文已变小，保持全量输出预算重试（不叠加收窄，避免浪费）。
            // 2026-09-10 压缩打转修复：落地但释放空间过小（超长消息在保留区裁不到，
            // 每次只摘走 1 条小消息 → 无限重压循环）→ 同轮立即尝试终局裁剪，
            // 一步到位（400 → 压缩 → 裁剪 → 重试成功），不再多轮打转。
            const freedEst = Number(r?.coveredTokens) || 0
            const reqEst = session ? estimateRequest({ system: systemPrompt, messages: session.deriveMessages() }).total : 0
            const freedFloor = Math.max(20_000, (reqEst || 0) * 0.05)
            if (freedEst > 0 && freedEst < freedFloor) {
              // 压缩空转熔断（2026-09-11）：retainHint 过大时 covered 只有 1-2 条消息，
              // 摘要落地但主请求几乎不缩——每次溢出都重压一遍（实测 70s/次空转循环）。
              // 连续 3 次"落地但释放 < floor"即跳过压缩，直走裁剪/预算收窄/索引适配。
              tinyLandings++
              if (tinyLandings >= 3) {
                try { wire?.system?.('compaction', { state: 'stalled', tinyLandings }) } catch { /* 事件失败不影响主流程 */ }
                overflowed = false
              } else {
                const trimmed = trimOversizedRequestCopy(requestMessages())
                if (trimmed) {
                  overflowTrimmed = trimmed
                  overflowRetries++
                  overflowed = true
                  try { wire?.system?.('request_trimmed', { reason: 'compaction-insufficient' }) } catch { /* 事件异常不影响主流程 */ }
                } else {
                  overflowed = false
                }
              }
            } else {
              tinyLandings = 0
              overflowRetries++
              overflowed = true
            }
          }
          if (!overflowed) {
            // 重试预算耗尽 → 跳过收窄/裁剪/硬适配（每次都只是再发一次超窗请求），
            // 直接落下方终局可见文案。
            if (!retryBudgetOut) {
              // 收窄输出预算到"当前 prompt 装得下"再试。prompt 优先取服务端实测数（精确，
              // 余量 2048 兜 tokenizer 偏差与 system 抖动）；解析不到时输出预算折半兜底
              // （半衰收敛，无需精确 prompt 数）。预算已到下限 2048 仍装不下且压缩不可裁
              // = 双路皆绝 → 终局可见文本（空结果会让 GUI 静默卡死，见下）。
              const nextBudget = limit > 0
                ? (promptN
                    ? Math.max(2048, Math.min(attemptMaxTokens, limit - Number(promptN[1]) - 2048))
                    : Math.max(2048, Math.floor(attemptMaxTokens / 2)))
                : attemptMaxTokens
              if (nextBudget < attemptMaxTokens) {
                attemptMaxTokens = nextBudget
                overflowRetries++
                overflowed = true
              } else if (!overflowTrimmed) {
                // 终局兜底（2026-09-10 长输出锁死修复）：单条超长消息（模型把成果
                // 直接写在输出里）逼近/超过窗口，压缩按轮次边界切不动、预算已到
                // 下限 → 请求面裁剪最长消息重试一次，保回合可继续。
                const trimmed = trimOversizedRequestCopy(requestMessages())
                if (trimmed) {
                  overflowTrimmed = trimmed
                  overflowRetries++
                  overflowed = true
                  try { wire?.system?.('request_trimmed', { reason: 'oversized-single-message' }) } catch { /* 事件异常不影响主流程 */ }
                }
              }
              if (!overflowed) {
                // 终局硬适配（2026-09-11 持续稳定运行）：压缩/收窄/裁剪均无解时，把请求面
                // 硬裁到窗口内（只留系统提示 + 最近一个完整 turn，transcript 不动）——
                // 轮次继续而非"放弃执行"；连末轮都放不下才落放弃文案（最终防线）。
                const fitted = fitRequestToWindow(requestMessages(), {
                  window: limit || (engineCtx?.window ?? 200_000),
                  outputBudget: attemptMaxTokens,
                  estimateMessage,
                  transcriptPath: session?.file || '',
                })
                if (fitted !== null) {
                  overflowTrimmed = fitted
                  overflowRetries++
                  overflowed = true
                  try { wire?.system?.('request_trimmed', { reason: 'hard-fit' }) } catch { /* 事件失败不影响主流程 */ }
                }
              }
            }
            if (!overflowed) {
              const errText = `【系统】上下文已超出模型窗口${limit ? `（端点上限 ${limit} tokens）` : ''}，自动压缩与输出预算收窄均无法腾出空间${compactErr ? `（压缩失败：${String(compactErr?.message || compactErr).slice(0, 120)}）` : ''}，本轮已放弃执行。可开新会话，或让我先清理上下文再继续。`
              pushMemory({ role: 'assistant', content: errText })
              if (session) lastAssistantEntry = session.appendAssistant([{ type: 'text', text: errText }], { model })
              try { wire.assistant([{ type: 'text', text: errText }]) } catch { /* 事件流异常不再掩盖原错误 */ }
              watchdog.stop()
              finalizeUsage()
              return { usage, model, text: errText, error: 'overflow-compact-failed', lastUsage: callUsage, toolDigest: turnToolDigest, assistantTexts: turnTexts }
            }
          }
        } else {
          watchdog.stop()
          throw err
        }
      }
      watchdog.stop()
      if (overflowed) {
        // 压缩落地/预算收窄/瘦身重试 → 重试同一轮。瘦身副本在请求面取用时已消费
        //（见上方 reqFace），此处**不得**再清空：2026-09-12 事故就是在这里无条件清空，
        // 让"硬适配成功但装不下"的形态退化成无限重发同一超窗请求。
        continue
      }
      // P1 生成重复守卫内部自愈：③/③b（gen-repeat/near-repeat）命中不直接收尾报给用户
      // ——先丢弃退化流，注入"推进指令"续跑（上限 REPEAT_HEAL_MAX）。一次性打转/探测器
      // 误判 → 一轮注入即恢复，用户无感（无收尾说明进会话、无报错体感）；真死循环模型
      // 持续复现 → 耗尽上限后走下方 break 收尾（说明文本仍兜底，不烧死 token）。
      if (loopStop && REPEAT_HEAL_MAX !== 0 && (REPEAT_HEAL_MAX < 0 || repeatHeals < REPEAT_HEAL_MAX) &&
          (loopStop.reason === 'gen-repeat' || loopStop.reason === 'near-repeat')) {
        repeatHeals++
        healedLastIter = true // 本迭代触发自愈注入（干净迭代清零的判据，见迭代起点）
        const healReason = loopStop.reason
        loopStop = null
        textBuf = '' // 退化部分内容不落模型输入（与收尾路径"不落退化内容"同哲学）
        const inject = '【系统】检测到你刚才的回复在反复复述近似内容（疑似陷入生成循环），该部分已被丢弃。请立即停止复述，直接推进当前任务——执行下一步具体行动或直接给出最终结论。'
        pushMemory({ role: 'user', content: inject })
        if (session) session.appendUser(inject)
        try { wire?.system?.('guard_heal', { reason: healReason, attempt: repeatHeals, max: REPEAT_HEAL_MAX }) } catch { /* 事件异常不影响主流程 */ }
        continue
      }
      if (loopStop) break // 生成重复/挂起已优雅收尾 → 本轮结束（说明文本见轮末 finalize）
      // P0-2：输出被 max_tokens 截断且已产出工具调用 → 不执行残缺参数，注入
      // 错误 tool_result 提示模型补全重发（消灭"执行参数残缺的调用"）
      // 【2026-09-11 适配】Anthropic/DeepSeek 官方语义用 'max_tokens'，旧判据只认
      // 'length'（mock 用法）→ 真端点截断时守卫不触发、残缺工具被当正常调用执行。
      if (blocks.length > 0 && (stopReason === 'length' || stopReason === 'max_tokens')) {
        const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
        pushMemory({ role: 'assistant', content: assistantBlocks })
        if (session) lastAssistantEntry = session.appendAssistant(assistantBlocks, { model })
        const errorResults = blocks.map((b) => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: '模型输出被 max_tokens 截断，工具调用参数可能不完整，未执行。请重新完整发起该工具调用。',
          is_error: true,
        }))
        pushMemory({ role: 'user', content: errorResults })
        if (session) session.appendToolResults(errorResults)
        textBuf = ''
        continue
      }
      // R3-2 失败自愈 + 计划尾守卫：模型无工具调用即收尾时，若本轮存在工具错误
      // 或文本带"计划/承诺"尾巴（先…/接下来…/开始…），注入引导继续执行——
      // 消灭"认错即停"与"只计划不执行"两类中断（注入 user 文本，保持 API 消息链合法）
      if (blocks.length === 0) {
        // 输出截断自愈（2026-09-12）：文本被 max_tokens 截断 → 内部升档续写，用户无感。
        // 部分文本先落盘为独立条目（不带 usage，M1 只写轮次最终条目），续写指令注入后
        // 重跑；续写文本仍经 wire.assistant 流式追加到同一回复（GUI 同轮块自动挂接）。
        // 放在计划尾/思考守卫之前——截断文本是有用产出，不得被这两个守卫丢弃。
        if ((stopReason === 'length' || stopReason === 'max_tokens') && textBuf.trim() && continueHeals < CONTINUE_HEAL_MAX) {
          const nextTier = OUTPUT_TIERS.find(t => t > attemptMaxTokens)
          if (nextTier) {
            continueHeals++
            const partial = textBuf
            textBuf = ''
            pushMemory({ role: 'assistant', content: [{ type: 'text', text: partial }] })
            if (session) lastAssistantEntry = session.appendAssistant([{ type: 'text', text: partial }], { model })
            const inject = '【系统】你的上一条回复因输出上限被截断。请直接从截断处继续输出剩余内容——不要重复已输出的部分，不要道歉，不要总结前文。'
            pushMemory({ role: 'user', content: inject })
            if (session) session.appendUser(inject)
            attemptMaxTokens = nextTier
            try { wire?.system?.('output_continued', { budget: nextTier, attempt: continueHeals }) } catch { /* 事件异常不影响主流程 */ }
            continue
          }
        }
        // R3-2 失败自愈（2026-09-16 口径修复）：注入文案自己就承诺了"或明确说明任务已完成
        // 并给出结果摘要"这条出路，判据也必须认这个出路——否则模型**照做**（给出结论/请示
        // 用户）仍被判"停留在文本说明"，形成"提示 → 照做 → 再提示"的循环（真实会话实测
        // 同一轮内 16 次注入）。误判面被 tools.mjs 放大：Bash 非零退出码一律记 is_error，
        // 日常 `grep -c` 无匹配返回 1 ⇒「工具报错 → 模型给结论收尾」本就是常态形态。
        // 文本已明确收尾时让位给正常收尾路径（判据见 guards.mjs isClosedOut）。
        if (hadToolError && guardInjections < maxGuardInjections && !isClosedOut(textBuf, isPlanTail)) {
          guardInjections++
          const inject = '【系统】检测到上一轮存在失败/被取消的工具调用，任务尚未完成。请立即重试或补发正确的工具调用，不要停留在文本说明。'
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
          textBuf = ''
          continue
        }
        if (textBuf.trim() && guardInjections < maxGuardInjections && isPlanTail(textBuf)) {
          guardInjections++
          const inject = planTailText()
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
          textBuf = ''
          continue
        }
        // 思考型模型早停自愈（2026-09-09 截断事故）：模型"想完即停"（文本只到
        // </think> 即 end_turn）时注入续写指令重跑，而不是把半截思考当答案收尾。
        // 与计划尾守卫同受 guardInjections 上限约束，防自愈本身失控。
        if (guardInjections < maxGuardInjections && isThinkOnly(textBuf)) {
          guardInjections++
          const inject = '【系统】检测到你的回复只包含思考过程、未输出回答正文就结束了。请直接、完整地输出对用户最新问题的回答正文，不要重复思考过程。'
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
          textBuf = ''
          continue
        }
        // ── ASK_USER 阻塞等待（2026-09-12）：提问即"停下来等" ─────────────────
        // 位置讲究：在全部自愈守卫之后、break 之前。纯文本步是提问的常见形态，
        // 若在此继续跑完回合，用户看到卡片时模型早已越过该步。
        if (asksUser(textBuf)) {
          const answered = await waitForAnswer()
          if (answered) {
            // 本步文本已定稿：先落盘为独立 assistant 条目再置空——否则下一轮（作答
            // 之后的回复）会与问题拼成同一条消息（截断续写路径同款处理，见上方
            // output_continued）。不带 usage：M1 约定 usage 只写轮次最终条目。
            const askText = textBuf
            textBuf = ''
            pushMemory({ role: 'assistant', content: [{ type: 'text', text: askText }] })
            if (session) lastAssistantEntry = session.appendAssistant([{ type: 'text', text: askText }], { model })
            continue // 作答已在 pendingNext，迭代起点吸收进模型上下文
          }
        }
        break
      }
      // 该轮 assistant 历史：文本块 + tool_use 块（Anthropic API 要求）
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      pushMemory({ role: 'assistant', content: assistantBlocks })
      // 中间 assistant 条目落盘（工具调用轮）：不带 usage（M1，usage 只写轮次最终条目）
      if (session) lastAssistantEntry = session.appendAssistant(assistantBlocks, { model })
      // P0-4：只读工具批并发、写/执行类串行，结果按模型调用顺序收集。tool_result
      // 必须合并进同一条 user 消息（Anthropic 要求同一 assistant 的多个 tool_use 的
      // tool_result 紧随其后且同消息，拆多条会 400）——先收集再一次性落盘。
      // signal 下传工具层（Grep/Glob 等长遍历据此在让出点判定取消，见 tools.mjs
      // walkForSearch）——轮次取消时 Stop 键能真正中断扫描，而非等它自己跑完。
      const executed = await runToolBatch(blocks, { spawnSubAgent, taskSystem, signal: rawAbortSignal(signal) })
      const toolResults = blocks.map((b, i) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: executed[i]?.content ?? '',
        is_error: executed[i]?.isError === true,
      }))
      // 失真观测（2026-09-12 spec §4.2）：工具结果摘要 = 陈旧引用检测的可信真值源。
      // 只保留"路径 + 是否失败 + 错误文本（截断）"，不复制结果正文（体积与隐私）。
      try {
        turnTexts.push(String(textBuf || '').slice(0, 4000))
        if (turnTexts.length > 16) turnTexts.shift()
        for (let i = 0; i < blocks.length; i++) {
          const inp = blocks[i]?.input || {}
          turnToolDigest.push({
            name: String(blocks[i]?.name || ''),
            path: String(inp.file_path ?? inp.path ?? inp.pattern ?? inp.notebook_path ?? '').slice(0, 300),
            isError: toolResults[i]?.is_error === true,
            errorText: String(typeof toolResults[i]?.content === 'string' ? toolResults[i].content : '').slice(0, 200),
          })
        }
        if (turnToolDigest.length > 40) turnToolDigest.splice(0, turnToolDigest.length - 40)
      } catch { /* 观测数据采集失败不影响工具主流程 */ }
      // P0-3b 单消息聚合预算（2026-09-12 对标：单消息 200K token 聚合 /
      // 双上限）：单条 20K 落盘挡不住"一轮几十次工具调用"的聚合膨胀（实测一轮
      // 67 次 → 请求面 317KB、292 条消息——长会话 DS 流反复中断的温床）。同一 user
      // 消息内 tool_result 合计超预算时，把最大的几条落盘替换为 preview+path
      // （Read 例外同 P0-3：模型显式索要的文件内容不 stub），直到合计低于预算。
      const aggBudget = Math.max(20_000, Number(process.env.PONOS_TOOL_RESULT_BATCH_BUDGET || 100_000))
      const aggResults = applyAggregateResultBudget(toolResults, blocks.map((b) => b.name), {
        budgetChars: aggBudget,
        persist: (content, idx) => persistToolResult(store || session, blocks[idx]?.id, content, 5000),
      })
      if (aggResults !== toolResults) {
        toolResults.length = 0
        toolResults.push(...aggResults)
      }
      // 工具结果 live 回传（2026-09-09 会话 UI 标准化）：wire 新增 tool_result 通道，
      // bridge 转发给 GUI 回填内联工具卡片的"完成/失败"状态与结果。事件失败静默——
      // 结果仍按 transcript 落盘（历史回放挂接），live 回传只是增量体验。
      if (wire && typeof wire.toolResult === 'function') {
        for (let i = 0; i < blocks.length; i++) {
          try { wire.toolResult({ toolUseId: blocks[i].id, content: toolResults[i].content, isError: toolResults[i].is_error }) } catch { /* 事件失败不阻断主流程 */ }
        }
      }
      // R3-2 失败自愈：记录本轮工具错误（模型下一轮若认错即停，守卫会强制重试）；
      // 工具成功执行后重置（错误已恢复，不再触发守卫）
      // P1-6：判据来自 guards.mjs（与子 lane 共用同一实现，防两侧漂移）
      hadToolError = nextHadToolError(hadToolError, toolResults)
      // 守卫④：连续工具失败熔断——连续"全部失败"迭代达上限即收尾止损（任一成功
      // 即复位）。与 R3-2 自愈互补：自愈引导"失败后重试"，熔断负责"重试救不回来"
      // 时的兜底，二者同源但用途相反。
      const allFailed = allToolResultsFailed(toolResults)
      if (allFailed) errorStreak++
      else if (toolResults.length) { errorStreak = 0; meltdownHeals = 0 } // 工具成功 → 熔断愈合计数清零
      if (toolResults.length) {
        pushMemory({ role: 'user', content: toolResults })
        if (session) session.appendToolResults(toolResults)
      }
      // 守卫⑥ 进展刷新：成功且非只读测量的工具结果 = 实质进展（Write/Edit/Read/
      // Grep/Bash/goto 等）；Browser js/snapshot（只读测量）与失败结果不刷新——
      // "测量打转"循环因此被 LOOP_STALL_MS 停滞守卫拦下（见常量注释）。
      // 恢复进展即清零愈合计数：自愈成功的轮次重新获得完整愈合预算。
      // P1-6：判据来自 guards.mjs（与子 lane 共用，防两侧漂移）
      const madeProgress = isRealProgress(blocks, toolResults)
      if (madeProgress) { lastProgressAt = Date.now(); stallHeals = 0 }
      // 守卫⑤：连续同工具提醒（仅提醒不否决，硬性
      // 由迭代上限兜底）。以每轮首个 tool_use 的规范键（name+参数深排序）为基准；
      // 键变化视为换了方向，链复位。到阈值把提示并入下一条 user 消息——顺序为
      // assistant(tool_use) → user(tool_result) → user(提醒)，与 R3-2 注入先例
      // 一致（连续 user 消息 API 接受）。
      if (!loopStop && REPEAT_REMIND_AT.length && blocks.length) {
        // 2026-09-16 口径收紧：链键取**整批**工具调用（原来只取 blocks[0]）——模型每轮以
        // 同一调用开头、后续调用完全不同时不再误判为"连续同工具"（实测该提示是最高频的
        // 循环守卫注入）。判据见 guards.mjs batchToolKey。
        const key = batchToolKey(blocks, canonicalToolCallKey)
        if (key && key === lastToolKey) {
          repeatStreak++
        } else {
          repeatStreak = 1
          lastToolKey = key
          remindedAt = new Set()
        }
        // P1-6：阈值命中判定与注入文案来自 guards.mjs（与子 lane 共用同一实现与同一文案，
        // 防两侧漂移——此前两份模板串字面相同却是两处维护）
        if (shouldRemindRepeat(repeatStreak, REPEAT_REMIND_AT, remindedAt)) {
          remindedAt.add(repeatStreak)
          const inject = repeatRemindText(repeatStreak, blocks[0].name)
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
        }
      }
      if (MAX_ERROR_ITERATIONS > 0 && errorStreak >= MAX_ERROR_ITERATIONS) {
        // 无感愈合（2026-09-10）：连续全败达阈值先注入"排查失败原因"指令静默续跑
        // （重开失败预算）；耗尽 MELTDOWN_HEAL_MAX 才落可见收尾。
        if (hasMeltdownBudget(meltdownHeals, MELTDOWN_HEAL_MAX)) {
          meltdownHeals++
          errorStreak = 0 // 重开失败预算（愈合窗口内再给一轮完整容错）
          const inject = errorMeltdownText('main')
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
          try { wire?.system?.('guard_heal', { reason: 'error-meltdown', attempt: meltdownHeals, max: MELTDOWN_HEAL_MAX }) } catch { /* 事件失败不影响主流程 */ }
          textBuf = ''
          continue
        }
        loopStop = {
          reason: 'error-meltdown',
          message: `【连续 ${errorStreak} 轮工具调用全部失败，已自动收尾停止重试。请检查失败原因（权限/环境/参数）后重新发起，或明确告知用户无法推进。】`,
        }
        break
      }
      // 继续下一轮 API 调用（模型看到 tool_result 后产出新回复）
      // 提问与工具调用同期（模型边问边做）：工具已执行，仍在下一轮 API 调用前挂起等待
      // ——不这么做就等于"问题还没被回答，模型已经基于工具结果继续推理"（原病灶）。
      // 超时不做特殊处理：继续跑（有人在等工具结果，收尾反而丢工作），与审批一致。
      if (asksUser(textBuf)) await waitForAnswer()
      textBuf = ''
    }
    perfStep(perfTurn, perfIter) // K0：轮末结算最后一步（break 与正常退出都要发）
    // 守卫收尾：命中任一守卫（迭代上限/重复打转/挂起/墙钟/熔断）时，用收尾说明
    // 取代残留的部分文本——部分流式内容 GUI 实时已见，但模型输入面不落退化内容，
    // 保持会话上下文干净可续聊（用户可发「继续」接续）。
    if (loopStop || iterCapHit) {
      const notice = loopStop?.message || `【已达单轮工具迭代上限（${MAX_TOOL_ITERATIONS} 轮），为防失控已自动收尾。任务可能未完——可发送「继续」让模型接续。】`
      textBuf = notice
      if (notice.trim()) wire.assistant([{ type: 'text', text: notice }])
    }
    if (textBuf.trim()) {
      pushMemory({ role: 'assistant', content: textBuf })
    }
    finalizeUsage()
    return { usage, model, text: textBuf, lastUsage: callUsage, toolDigest: turnToolDigest, assistantTexts: turnTexts }
  }

  // P0-3：大工具结果磁盘持久化 + 预览替换——超阈值全文落盘
  // <sessionDir>/tool-results/<toolUseId>.json，模型输入只留 <persisted-output>
  // 预览 + 路径（可 Read 补读，无损恢复）
  function persistToolResult(target, toolUseId, content, limitOverride) {
    if (!target || typeof content !== 'string') return content
    const limit = Number(limitOverride ?? process.env.PONOS_TOOL_RESULT_BUDGET_BYTES ?? 20000)
    if (content.length <= limit) return content
    try {
      const dir = join(dirname(target.file), 'tool-results')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${toolUseId}.json`)
      writeFileSync(file, JSON.stringify({ id: toolUseId, content, ts: new Date().toISOString() }), 'utf-8')
      const preview = content.slice(0, 2000).replace(/"/g, '&quot;')
      return `<persisted-output path="${file}" preview="${preview}">（完整内容 ${content.length} 字符已落盘，可用 Read 读取）</persisted-output>`
    } catch {
      return content // 落盘失败退回原文（不阻断工具结果）
    }
  }

  // P0-4：工具批执行——连续只读工具并发（Promise.all），写/执行类单独串行；
  // 结果按模型调用顺序收集（tool_result 与 toolCall 一一对应，Anthropic 要求）
  async function runToolBatch(blocks, ctx) {
    const results = []
    let pending = []
    const flush = async () => {
      if (!pending.length) return
      const batch = pending
      pending = []
      const settled = await Promise.all(
        batch.map((p) => p.promise.catch((e) => ({ content: `工具执行异常：${e?.message || String(e)}`, isError: true })))
      )
      settled.forEach((r, i) => { results[batch[i].index] = r })
    }
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      // R1-1 防重放：本轮内重复 tool_use id（重连后模型重放 / 同轮重复输出）→
      // 不重复执行，回填既有结果（幂等防副作用）。轮级集合 runTurn 开头重置，
      // 跨轮固定 id（mock 测试场景）不受影响。
      const replay = executedToolIds.get(b.id)
      if (replay) {
        results[i] = { content: replay.content ?? '', isError: replay.is_error === true }
        continue
      }
      if (tools.isConcurrencySafe(b.name)) {
        pending.push({
          index: i,
          promise: executeToolUse(b, ctx).then((x) => {
            executedToolIds.set(b.id, { content: x?.content ?? '', is_error: x?.isError === true })
            return x
          }),
        })
      } else {
        await flush()
        // 串行路径同样兜底：executeToolUse 抛异常（审批/执行器内部错误）不得中断
        // 整个 turn——回填错误结果并继续，模型下一轮看到 is_error 后自愈重试。
        try {
          results[i] = await executeToolUse(b, ctx)
        } catch (e) {
          results[i] = { content: `工具执行异常：${e?.message || String(e)}`, isError: true }
        }
        executedToolIds.set(b.id, { content: results[i]?.content ?? '', is_error: results[i]?.isError === true })
      }
    }
    await flush()
    return results
  }

  // P1-7：权限 denial 计数降级——连续拒绝 3 次 / 累计 20 次后，高危命令自动 deny
  // （不再打扰用户弹窗），tool_result 明示模型停止尝试（同类拒绝追踪）
  let denialStreak = 0
  let denialTotal = 0
  const DENIAL_STREAK_LIMIT = 3
  const DENIAL_TOTAL_LIMIT = 20

  // P0-3（2026-09-16）：灾难命令"同族重试硬拒"。用户在本轮明确拒绝某灾难族后，模型
  // 再发**同族**命令（含改写/升权变体：rm -rf / → rm -rf /* / sudo rm -rf /）不再弹窗，
  // 直接拒绝。理由：底线拦截若只作用于"判定"、不作用于"同一意图的重复尝试"，就会被
  // "重试"绕过；反复弹窗还会训练用户在第三、四次点击「允许」（审批疲劳）。
  // 族粒度是必要条件——字面比对挡不住改写。跨轮清空见 runTurnInternal 轮起点。
  const deniedCatastrophicFamilies = new Set()

  // 工具权限门（P1-7 权限决策 + ask 审批挂起 + hooks.preToolUse 否决）。主 agent
  // 会话 executeToolUse 与工作流内嵌工具调用共用同一道门——工作流 tool/document/
  // agent 节点经 registry 直接执行工具时不得旁路主会话审批（高危 Bash/越权操作须
  // 同样 ask/deny/hook 拦截），门返回 { allowed:true } 放行 / { allowed:false, message }。
  async function gateToolUse(toolUse) {
    // 被 --disallowedTools 禁用的工具（chat 模式清单等）直接放行给注册表：
    // 由注册表回自己的"工具已被禁用"错误，而不是在 manual/auto 档弹一个"批准了
    // 也用不了"的空窗（2026-09-12 档位化：档位越严，这种无意义弹窗越容易出现）。
    if (Array.isArray(opts.disallowedTools) && opts.disallowedTools.includes(toolUse.name)) {
      return { allowed: true }
    }
    const perm = decideToolPermission({ toolName: toolUse.name, input: toolUse.input, mode: approvalMode, skipPermissions: opts.skipPermissions, autoApproveHighRisk: opts.autoApproveHighRisk, rules: opts.permissionRules })
    if (perm.decision === 'deny') {
      denialStreak++
      denialTotal++
      return { allowed: false, message: '用户拒绝执行该操作' }
    }
    if (perm.decision === 'ask') {
      // P0-3：本轮已被拒的灾难族 → 不弹窗、直接硬拒。放在降级检查之前是有意的：
      // 两者是独立机制，若排在后面，连续拒绝 3 次后文案会退化成"连续拒绝 N 次"而
      // 掩盖真实原因（用户拒的是这一族命令本身，不是"高危操作"）。不计 streak：
      // 与硬黑名单首次拒绝同待遇——它不是"用户在拒绝高危操作"这一可学习信号。
      const hardFamily = perm.hard ? catastrophicFamily(String(toolUse.input?.command ?? '')) : null
      if (hardFamily && deniedCatastrophicFamilies.has(hardFamily)) {
        return {
          allowed: false,
          message: `该命令属于「${hardFamily}」灾难族，用户已于本轮拒绝过同族命令（含改写/升权变体）。请立即停止对该族的任何尝试，改用安全替代方案；换写法重试同样会被拒绝。`,
        }
      }
      // 降级检查：拒绝过多 → 直接 deny（不挂起弹窗）。**硬黑名单豁免**：灾难命令
      // 必须每次都问，否则用户连拒 3 次后再发普通高危命令会被连带自动拒绝（文案
      // 还会谎称"用户已连续拒绝"）。硬黑名单的拒绝也不计入 streak（见下）。
      if (!perm.hard && (denialStreak >= DENIAL_STREAK_LIMIT || denialTotal >= DENIAL_TOTAL_LIMIT)) {
        denialTotal++
        return {
          allowed: false,
          message: `用户已连续拒绝 ${denialStreak} 次高危操作（累计 ${denialTotal} 次）。请停止尝试危险命令，改用安全替代方案。`,
        }
      }
      // 发 can_use_tool control_request 挂起，等 cli 经 control_response 解除
      // 标记"正在等人"：硬看门狗等待期内展期（cli.mjs 消费）
      beginAwaitingUser()
      wire.controlRequest({
        requestId: 'req-' + toolUse.id,
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        input: toolUse.input,
        reason: perm.reason || '',
        mode: approvalMode,
        ...(perm.hard ? { hard: true } : {}),
      })
      // 审批等待 deadline（L0-a）：GUI 应答缺失（弹窗丢失/前端未响应）且无 cancel 信号时，
      // waiter 永不 resolve → 工具批挂死在权限边界（TURN_TIMEOUT 在迭代边界检查，进不了
      // 工具内部）。超时按"未授权"回填，模型转向安全替代；不计 denial 计数（非用户拒绝，
      // 否则 3 次超时会误触发"连续拒绝"降级）。map 里存包装函数：任何解除路径都先清 timer。
      const approvalTimeoutMs = Math.max(1000, Number(process.env.PONOS_APPROVAL_TIMEOUT_MS || 600_000))
      const decision = await new Promise((resolvePromise) => {
        const timer = setTimeout(() => {
          approvalWaiters.delete(toolUse.id)
          // 超时文案与可配时长一致（审计 #6 收尾）：整分钟走分钟、否则按秒动态，
          // 避免 PONOS_APPROVAL_TIMEOUT_MS 改小时仍硬编码"10 分钟"误导用户
          const mins = Math.round(approvalTimeoutMs / 60000)
          const label = approvalTimeoutMs % 60000 === 0 ? `${mins} 分钟` : `${Math.round(approvalTimeoutMs / 1000)} 秒`
          resolvePromise({ behavior: 'timeout', message: `审批等待超时（${label}未收到用户响应），未执行该操作` })
        }, approvalTimeoutMs)
        approvalWaiters.set(toolUse.id, (d) => { clearTimeout(timer); resolvePromise(d) })
      })
      // 等待结束（应答/拒绝/超时/取消四条路都经上面的 promise resolve）→ 撤销展期。
      // 必须成对：漏掉 end 会让硬看门狗被永久展期（等待窗口变成常态），反而更不设防。
      endAwaitingUser()
      if (decision?.behavior !== 'allow') {
        // 硬黑名单不计入拒绝计数（与超时同待遇）：它不是"用户在拒绝高危操作"这一
        // 可学习信号，而是底线拦截；计数会让后续普通请求被降级静默拒绝。
        if (decision?.behavior !== 'timeout' && !perm.hard) {
          denialStreak++
          denialTotal++
        }
        // P0-3：记住"用户明确拒绝了这一族"。超时**不记**——用户可能只是没看到弹窗，
        // 记了会让他永久失去放行该命令的能力（一次错过 ≠ 拒绝）。
        if (decision?.behavior !== 'timeout' && hardFamily) deniedCatastrophicFamilies.add(hardFamily)
        return { allowed: false, message: decision?.message || '用户拒绝执行该操作' }
      }
      denialStreak = 0
    }
    // hooks.preToolUse：可否决。deny → 工具不执行，错误回填给模型。
    const hooks = opts.hooks
    if (hooks) {
      const h = await hooks.run('preToolUse', { toolName: toolUse.name, toolUseId: toolUse.id, input: toolUse.input })
      if (h.deny) return { allowed: false, message: h.message || `PreToolUse hook 拒绝执行 ${toolUse.name}` }
    }
    return { allowed: true }
  }

  async function executeToolUse(toolUse, ctx = {}) {
    const gate = await gateToolUse(toolUse)
    if (!gate.allowed) return { content: gate.message, isError: true }
    // P2-1①/AS1：lane 白名单 deny gate——子 agent options 显式声明 tools/skills 时收窄。
    // 空数组/未定义跳过（全量）。仅当 mock/模型以名单外工具名发起时才拦截（第二道保险，
    // 第一道是 retryStream 的 tools 收窄让模型根本看不到名单外工具）。
    const lo = ctx?.laneOptions
    if (lo && Array.isArray(lo.allowedTools) && lo.allowedTools.length && !lo.allowedTools.includes(toolUse.name)) {
      return { content: `子 Agent 工具白名单不含 ${toolUse.name}（允许：${lo.allowedTools.join(', ')}），已拒绝执行`, isError: true }
    }
    if (toolUse.name === 'Skill' && Array.isArray(lo?.allowedSkills) && lo.allowedSkills.length
        && !lo.allowedSkills.includes(String(toolUse.input?.skill ?? ''))) {
      return { content: `子 Agent 技能白名单不含「${String(toolUse.input?.skill ?? '')}」（允许：${lo.allowedSkills.join(', ')}），已拒绝加载`, isError: true }
    }
    // ctx：工具执行上下文——主循环注入 spawnSubAgent/taskSystem/browserDriver
    // （Agent/Task/Browser 工具依赖）与 appRunner（应用工具 app_* 的执行能力，
    // Task 4.x），子 agent 循环注入 lane:true（禁嵌套分发）
    const { store, ...toolCtx } = ctx
    // P1-9：统一执行 deadline（兜"永不返回"的工具；各工具自身超时负责 kill）
    const toolDeadlineMs = Number(process.env.PONOS_TOOL_TIMEOUT_MS || 300_000)
    const r = await withToolDeadline(tools.run(toolUse, { ...toolCtx, toolUseId: toolUse.id, browserDriver: runBrowser, appRunner: runApp }), toolDeadlineMs)
    // P0-3：大结果落盘到目标会话目录（子 lane 独立 store）。Read 例外：Read 返回的
    // 就是模型显式索要的文件内容（≤2000 行/2MB，超界文件已由 Read 自身引导 offset/
    // limit），落盘替换成 stub 会让"读大源文件"只见预览 + 引导补读，模型被迫小段
    // offset/limit 重读（用户侧表现为工具"输出被落盘"、反复续读），且补读 stub 文件
    // 又触发二次落盘 → 迭代空转。故 Read 结果保持内联，其余工具（Bash 等）大输出
    // 照常落盘 + stub 补读（路径已并入边界，见 createEngine toolResultsDir）。
    if (r && typeof r === 'object' && typeof r.content === 'string') {
      if (toolUse.name === 'Read') { /* Read 结果内联，不落盘替换 */ }
      else r.content = persistToolResult(store || session, toolUse.id, r.content)
    }
    // hooks.postToolUse：工具结果后触发（output 截断 8KB；不阻塞主流程决策）
    const hooks = opts.hooks
    if (hooks) {
      try {
        await hooks.run('postToolUse', {
          toolName: toolUse.name,
          toolUseId: toolUse.id,
          input: toolUse.input,
          output: typeof r?.content === 'string' ? r.content.slice(0, 8192) : '',
        })
      } catch { /* post 钩子失败不影响工具结果 */ }
    }
    return r
  }

  // —— 内置浏览器驱动（bridge_request(browser) → 主进程执行器）——
  const BROWSER_TIMEOUT_MS = 120_000
  // 白名单审批（2026-09-10）：浏览器访问被域名白名单拦截（执行器回
  // code='whitelist-blocked' + data.domain）时，向用户请求批准把域名加入
  // 白名单——经既有 can_use_tool 审批通道（GUI 弹窗 / TUI y/n）。批准后
  // bridge 写入 browser-whitelist.json（执行器 mtime 热重载即时生效），
  // 本工具返回"请重试"引导；拒绝/超时返回明确引导，模型改用其他途径。
  async function requestWhitelistApproval(domain) {
    const toolUseId = 'whitelist:' + String(domain || '').toLowerCase()
    beginAwaitingUser()
    try {
      wire.controlRequest({
        requestId: 'req-' + toolUseId,
        toolName: 'browser_whitelist_add',
        toolUseId,
        input: { command: `加入浏览器白名单：${domain}` },
        reason: `浏览器访问 ${domain} 被域名白名单拦截。批准后该域名将写入白名单（即时生效），随后重试浏览器操作即可。`,
      })
    } catch { endAwaitingUser(); return { approved: false, reason: 'control-request-failed' } }
    const approvalTimeoutMs = Math.max(1000, Number(process.env.PONOS_APPROVAL_TIMEOUT_MS || 600_000))
    const decision = await new Promise((resolvePromise) => {
      const t = setTimeout(() => {
        approvalWaiters.delete(toolUseId)
        resolvePromise({ behavior: 'timeout' })
      }, approvalTimeoutMs)
      approvalWaiters.set(toolUseId, (d) => { clearTimeout(t); resolvePromise(d) })
    })
    endAwaitingUser()
    // whitelistWritten（2026-09-17）：bridge 把**真实写盘结果**随回执带回（true/false）。
    // 只在明确 false 时才改写文案——undefined 表示对端（旧 bridge）没带该字段，保持既有
    // 乐观行为不变，避免新旧版本组合下误报"写入失败"。
    return decision?.behavior === 'allow'
      ? { approved: true, whitelistWritten: decision?.whitelistWritten }
      : { approved: false, reason: decision?.behavior ?? 'unknown' }
  }

  async function runBrowser(action, params) {
    const requestId = 'br-' + randomUUID()
    let timer
    const resp = await new Promise((resolve) => {
      browserWaiters.set(requestId, resolve)
      timer = setTimeout(() => {
        browserWaiters.delete(requestId)
        resolve({ ok: false, error: `浏览器操作超时（${action}，${BROWSER_TIMEOUT_MS}ms）` })
      }, BROWSER_TIMEOUT_MS)
      if (timer.unref) timer.unref() // 超时 timer 不阻塞进程退出
      // 发 bridge_request(browser)：bridge browserRouter 转主进程执行器，
      // 完成后再经 stdin browser_response 回写解除挂起
      wire.bridgeRequest({ route: 'browser', requestId, payload: { action, params } })
    })
    clearTimeout(timer)
    // 白名单拦截 → 用户批准流（2026-09-10）：批准即提示重试，未批准给替代途径
    if (!resp?.ok && resp?.code === 'whitelist-blocked') {
      const domain = String(resp?.data?.domain || '').trim()
      const target = String(resp?.data?.url || '').trim()
      // 无法加入白名单的地址**不弹审批**（2026-09-17 修复）：弹了也白弹——写入端只接受
      // 合法主机名，用户点了"同意"写入必失败，而旧代码照样回模型"已批准，请重试"，于是
      // agent 重试 → 仍被拦 → 再弹审批 → 用户再同意，形成死循环（真实事故：agent 想用浏览器
      // 预览自己生成的 HTML，`file:///C:/...` 的 hostname 恒为空串，被顶替成中文占位符
      // 「该域名」去弹审批，用户反复点是却永远打不开）。此处直接给出可执行的替代途径。
      // 判据与写入端共用同一归一函数，两侧不会分叉。
      if (!normalizeWhitelistHost(domain)) {
        const what = target ? `“${target.length > 160 ? target.slice(0, 160) + '…' : target}”` : '该地址'
        const why = domain
          ? `主机名「${domain}」不是合法域名，无法写入白名单`
          : '该地址没有主机名（如 file:// 本地路径、data:/about: 等），域名白名单机制对它不适用'
        return {
          content: `浏览器访问 ${what} 被域名白名单拦截，且该地址**无法通过"加入域名白名单"放行**：${why}。请改用其他途径（WebFetch / WebSearch 获取网页内容；本地文件用 Read 或应用内文件查看能力打开），不要重复重试同一地址。`,
          isError: true,
        }
      }
      const d = domain
      const appr = await requestWhitelistApproval(d)
      // 批准但写入失败（2026-09-17）：如实告知，别让模型以为"重试就好"而空转
      if (appr.approved && appr.whitelistWritten === false) {
        return {
          content: `浏览器访问 ${d} 被域名白名单拦截，用户已批准，但「${d}」**写入白名单失败**（未写入 browser-whitelist.json），重试同一操作仍会被拦截。请改用其他途径（WebFetch / WebSearch），或请用户手动把该域名加入白名单文件后重试。`,
          isError: true,
        }
      }
      if (appr.approved) {
        return {
          content: `浏览器访问 ${d} 被域名白名单拦截，用户已批准将「${d}」加入白名单（即时生效）。请重试刚才的浏览器操作。`,
          isError: false,
        }
      }
      return {
        content: `浏览器访问 ${d} 被域名白名单拦截，且用户未批准加入白名单（${appr.reason === 'timeout' ? '审批等待超时' : '用户拒绝'}）。请改用其他途径（WebFetch / WebSearch），或向用户说明访问目的后重新发起浏览器操作。`,
        isError: true,
      }
    }
    if (resp?.ok) {
      const body = resp.snapshot ?? resp.data ?? { ok: true }
      return { content: typeof body === 'string' ? body : JSON.stringify(body), isError: false }
    }
    return { content: `浏览器操作失败：${resp?.error || '未知错误'}`, isError: true }
  }

  // —— 应用命令执行（Task 4.x「应用即工具」）：bridge_request(app) → 主进程执行器 ——
  // 与 runBrowser 同构（发起 + 挂起 + 超时 + 桥异常兜底），差别只在路由名与回执
  // 形状：应用命令的执行结果就是 electron/app-ipc.cjs 的 app:run 回执
  //（{ok,data,error,kind,durationMs}），内核**原样**交给 app-tools.mjs 渲染成工具结果。
  // 执行侧负责留痕（browser 路径 runCommand 内建 history；desktop 路径显式 appendHistory）。
  const APP_TIMEOUT_MS = Number(process.env.PONOS_APP_TIMEOUT_MS || 300_000)
  async function runApp({ appId, action, args = {}, sessionId = null } = {}) {
    const requestId = 'ap-' + randomUUID()
    let timer
    const resp = await new Promise((resolve) => {
      appWaiters.set(requestId, resolve)
      // 超时远大于 browser（120s）：desktop/process 命令可含多步 CLI（单步 30s 上限）
      timer = setTimeout(() => {
        appWaiters.delete(requestId)
        resolve({ ok: false, data: null, error: `应用命令超时（${appId || '?'}/${action || '?'}，${APP_TIMEOUT_MS}ms）`, kind: 'unknown', durationMs: APP_TIMEOUT_MS })
      }, APP_TIMEOUT_MS)
      if (timer.unref) timer.unref()
      try {
        wire.bridgeRequest({ route: 'app', requestId, payload: { appId, action, args: args || {}, sessionId } })
      } catch (e) {
        // 写 stdout 失败（桥已断）不得把挂起留到超时：立即以失败回执解除
        appWaiters.delete(requestId)
        clearTimeout(timer)
        resolve({ ok: false, data: null, error: `应用命令请求发送失败：${e?.message || String(e)}`, kind: 'unknown', durationMs: 0 })
      }
    })
    clearTimeout(timer)
    return resp || { ok: false, data: null, error: '应用命令无响应', kind: 'unknown', durationMs: 0 }
  }

  // —— 子 agent（subagent）执行：进程内 lane ——
  // 子 lane = 独立 session store（复用 createSessionStore，sessionId=taskId，
  // 独立 transcript 文件），主会话日志零污染（只有 Agent tool_use + 结果回填）。
  // 子循环与 runTurnInternal 语义对齐但简化：无健康（短会话）；无压缩器——上下文溢出
  // 仅靠输出预算收窄自愈（见下方 #5 catch），不引入主循环式压缩/窗口采纳。
  // signal 为轮次级取消：主 signal（用户 cancel 全中断）∨ 子 signal（Task stop）
  async function runSubAgentLoop({ store, sysPrompt, signal: subSignal, onTool, options = {}, taskId }) {
    let usage = {}
    let textBuf = ''
    let toolUses = 0
    const subT0 = Date.now()
    // 守卫⑥ 进展时间戳（子 lane 镜像主循环）：成功且非只读测量的工具结果落地即刷新
    let subLastProgressAt = subT0
    let subStallHeals = 0 // ⑥ 愈合计数（恢复实质进展即清零，上限 STALL_HEAL_MAX）
    let subMeltdownHeals = 0 // ④ 熔断愈合计数（工具成功即清零，上限 MELTDOWN_HEAL_MAX）
    // P2-1①/AS1：lane 级参数（model/tools/skills 白名单）。options 未定义/空 =
    // 全量（零回归锁①）。loopModel 在 retryStream 与落盘（appendAssistant）统一使用。
    const loopModel = options?.model || model
    const laneToolSchemas = (Array.isArray(options?.allowedTools) && options.allowedTools.length)
      ? tools.toolSchemas().filter((t) => options.allowedTools.includes(t.name))
      : null
    // 守卫命中时的收尾说明（resume 续跑提示；null = 正常运行）。stopped 标志让
    // runLaneExecution 把守卫停登记为 status='stopped'（同取消，可 resume 续跑）。
    const stopNotice = (reason, detail) =>
      `【子 Agent 任务已因${reason}自动中止：${detail}。可用 resume_task_id 让模型在既有会话上续跑。】`
    const guardStop = (text) => ({ usage, text, stopped: true })
    const msgs = () => {
      const m = patchOrphanToolUses(store.deriveMessages())
      return [{ role: 'system', content: sysPrompt }].filter((x) => x.content).concat(m)
    }
    // P1 ③/③b 内部自愈（同主 loop）：子 lane 重复命中先注入推进指令续跑；耗尽上限
    // （REPEAT_HEAL_MAX）才落回 guardStop 说明收尾
    let subHeals = 0
    let subErrorStreak = 0 // P1-守卫④（子 lane，审计 #4）：连续全部失败的工具迭代链（跨轮累计，任一成功即复位）
    let attemptMaxTokens = maxTokens   // P1-#5（子 lane，审计 #5）：溢出收窄的可变输出预算（初值同主循环 433）
    // 审计 #10（子 lane 镜像）：R3-2 失败自愈——本轮存在 is_error 工具结果 → hadToolError；
    // guardInjections 记录已注入的"继续执行"提示次数（上限同主循环 PONOS_GUARD_MAX，防
    // 模型拒不配合时死循环）；守卫⑤ 同工具提醒——连续相同工具调用链（canonicalToolCallKey
    // 基准，与③/③b 检文本重复不重叠；仅提醒不 veto）
    let hadToolError = false
    let guardInjections = 0
    const maxGuardInjections = Number(process.env.PONOS_GUARD_MAX || 3)
    let subRepeatStreak = 0
    let lastSubToolKey = ''
    let subRemindedAt = new Set()
    // 子 lane 上游零数据挂起自动重试计数（同主 loop 2026-09-09 长任务挂起修复）
    let subIdleDeadRetries = 0
    // P2-1③：lane 压缩（可选，PONOS_LANE_COMPACT=1 且主会话提供 context）。复用主
    // loop 压缩语义（compact.mjs 两阶段 + 熔断），摘要落地到 laneStore（独立 transcript，
    // 主会话零污染）。wire 摘要经 laneWire 转发为 system('lane_compaction') 事件带 taskId。
    // 零回归锁②：默认关（LANE_COMPACT_ENABLED=false → laneCompactor 恒 null，零开销）。
    let laneCompactor = null
    if (LANE_COMPACT_ENABLED && engineCtx?.estimate) {
      try {
        const laneWire = { summary: (text, count) => { try { wire.system?.('lane_compaction', { taskId, text: String(text ?? ''), compactCount: count }) } catch { /* 事件失败静默 */ } } }
        laneCompactor = createCompactor({
          session: store,
          context: engineCtx,
          model: loopModel,
          maxTokens,
          wire: laneWire,
          health: undefined,
          signal: subSignal,
          env: process.env,
          sessionMemoryPath: null,
        })
      } catch { laneCompactor = null } // lane 压缩器装配失败 → 该 lane 不压缩（静默降级）
    }
    for (let iter = 0; ; iter++) {
      // 守卫（子 lane 同主 loop）：墙钟默认关闭（2026-09-10，见 TURN_TIMEOUT_MS
      // 注释）+ 迭代上限——命中即附说明收尾（同主任务守卫共用同一组 PONOS_* 阈值）
      if (TURN_TIMEOUT_MS > 0 && Date.now() - subT0 >= TURN_TIMEOUT_MS) {
        return guardStop(stopNotice('运行超时', `超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟`))
      }
      // 守卫⑥ 无进展停滞（子 lane 镜像，自愈优先）：先注入推进指令续跑（后台
      // lane 无用户可见面，注入即唯一干预），耗尽 STALL_HEAL_MAX 才 guardStop。
      if (LOOP_STALL_MS > 0 && Date.now() - subLastProgressAt >= LOOP_STALL_MS) {
        if (subStallHeals < STALL_HEAL_MAX) {
          subStallHeals++
          subLastProgressAt = Date.now()
          store.appendUser('【系统】检测到你长时间没有实质进展（连续只读测量/重复调用、无新结果或文件变更）。请停止测量与重复尝试，直接执行下一步实质操作（修改文件/执行命令/完成剩余步骤），或输出最终结论。')
          continue
        }
        return guardStop(stopNotice(
          '长时间无实质进展',
          `超过 ${Math.max(1, Math.round(LOOP_STALL_MS / 60000))} 分钟只有只读测量/重复调用、无新结果或文件变更，疑似陷入循环`,
        ))
      }
      // B2 主 Agent 消息投递（2026-09-11）：Task send_message/followup 进 inbox，
      // 工具边界吸收（镜像主循环 P8 pendingNext）
      const laneInbox = options?.inbox
      if (Array.isArray(laneInbox) && laneInbox.length) {
        const msgs = laneInbox.splice(0)
        for (const m of msgs) store.appendUser(`【主 Agent 消息】${m}`)
      }
      if (MAX_TOOL_ITERATIONS > 0 && iter >= MAX_TOOL_ITERATIONS) {
        return guardStop(stopNotice('达到迭代上限', `连续 ${MAX_TOOL_ITERATIONS} 轮工具循环`))
      }
      // P2-1③：lane 压缩触发（turn 边界，阈值判定复用主循环阈值体系）。摘要调用
      // usage 并入 lane usage（与主循环 M2 语义一致）；outputBudget 透传本流 attemptMaxTokens
      //（同主循环 L485 compactor.maybeCompact 调用形态）。任何异常静默——压缩失败不阻断 lane。
      if (laneCompactor) {
        try {
          const laneMsgs = patchOrphanToolUses(store.deriveMessages())
          const cr = await laneCompactor.maybeCompact({ system: sysPrompt, messages: laneMsgs, outputBudget: attemptMaxTokens })
          if (cr?.usage) usage = addUsage(usage, cr.usage)
          if (cr?.action === 'summarized') textBuf = '' // 摘要落地后收尾文本已被遮蔽，置空防拼接
        } catch { /* lane 压缩异常静默 */ }
      }
      const blocks = []
      let subStopReason = null // P0-2（同主 loop）：流内 stop_reason 消费（length 截断判据）
      let genWindow = ''
      // 守卫③b 句级近重复检测器（同主 loop：每流一实例，thinking+text 同窗喂入）
      const nearRep = NEAR_REPEAT_RECENT > 0
        ? createNearRepeatDetector({ back: NEAR_REPEAT_BACK, sim: NEAR_REPEAT_SIM, recent: NEAR_REPEAT_RECENT, avg: NEAR_REPEAT_AVG, codeSkip: NEAR_REPEAT_CODE_SKIP })
        : null
      // K1.3：同主 loop，惰性提供者（lane 路径）
      const watchdog = makeIdleWatchdog(STREAM_IDLE_MS, () => adaptiveFirstByteMs(() => patchOrphanToolUses(store.deriveMessages()), STREAM_FIRST_BYTE_MS))
      const laneSig = rawAbortSignal(subSignal)
      const streamSignal = watchdog.controller && typeof AbortSignal.any === 'function'
        ? (laneSig ? AbortSignal.any([laneSig, watchdog.controller.signal]) : watchdog.controller.signal)
        : subSignal
      let subStop = null // ③/③b 命中（本流重复打转）→ abort 后走流外自愈/收尾（不进 catch 抛错）
      // P1-11（子 lane 镜像主循环 attemptData）：本流是否产出过内容——收到任意 chunk
      // （含 thinking/usage）即置位，等价"上游在产出"。#8 之后 textBuf 只收 text、thinking
      // 仅进 genWindow，不能作"上游是否产出"判据；看门狗措辞判别（watchdog.tripped 分支）
      // 须用本标志，否则"只产 thinking 后停"的 lane 会被误报"上游服务空流（未收到任何数据）"。
      let streamProduced = false
      try {
        for await (const chunk of retryStream({ model: loopModel, messages: msgs(), maxTokens: attemptMaxTokens, signal: streamSignal, tools: laneToolSchemas ?? tools.toolSchemas(), reasoningEffort: normalizeEffort(options?.effort || 'auto') })) {
          if (signal.aborted || subSignal.aborted) throw abortError()
          watchdog.tick()
          streamProduced = true
          if (chunk.type === 'text') {
            textBuf += chunk.text
            genWindow = (genWindow + chunk.text).slice(-400)
          } else if (chunk.type === 'thinking') {
            genWindow = (genWindow + chunk.text).slice(-400) // thinking 参与③检测窗，不入摘要
          } else if (chunk.type === 'tool_use' && !blocks.some((b) => b.id === chunk.id)) {
            blocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input })
          } else if (chunk.type === 'usage') {
            usage = addUsage(usage, chunk.usage)
          } else if (chunk.type === 'stop_reason') {
            subStopReason = chunk.reason
          }
          // 流内墙钟（同主 loop 守卫①b）：单次生成久拖不结（块持续流动）同样中断
          if (TURN_TIMEOUT_MS > 0 && Date.now() - subT0 >= TURN_TIMEOUT_MS) {
            watchdog.controller?.abort()
            watchdog.stop()
            return guardStop(`${textBuf.trim()} ${stopNotice('运行超时', `超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟`)}`.trim())
          }
          // 生成重复打转检测（同主 loop 守卫③）：命中中止当前流，流外统一内部自愈/收尾
          if (!subStop) {
            const rep = detectGenerationRepeat(genWindow)
            if (rep) {
              subStop = { reason: 'gen-repeat', detail: `同一片段连续重复 ${rep.repeats} 次` }
              watchdog.controller?.abort()
            }
          }
          // 守卫③b 句级近重复（编织变体循环；同主 loop）：同上
          if (!subStop && nearRep && (chunk.type === 'text' || chunk.type === 'thinking')) {
            const nrep = nearRep.push(chunk.text)
            if (nrep) {
              subStop = { reason: 'near-repeat', detail: `同一批内容措辞微变重复重述，近期每句平均约 ${nrep.avgNeighbor} 句近似旧句` }
              watchdog.controller?.abort()
            }
          }
        }
      } catch (err) {
        watchdog.stop()
        if (signal.aborted || subSignal.aborted) throw err // 用户取消（级联）原样上报
        if (subStop) { /* no-op：流外统一自愈/收尾 */ }
        else if (watchdog.tripped) {
          // P1-11（子 lane 镜像）：全程 0 产出 → 上游空转/未就绪提示（引导查 provider）；
          // 已产出后停顿 → 推理中途停顿语义（保留 resume 续跑提示）。判别用 streamProduced
          // （镜像主循环 attemptData，收到任意 chunk 即上游在产出）而非 textBuf.length——
          // #8 后 textBuf 仅 text，thinking 不入（thinking 只进 genWindow，见上方分流）。
          // 2026-09-09：零数据形态先自动重试（同主 loop 长任务挂起修复）。
          if (!streamProduced && subIdleDeadRetries < IDLE_DEAD_RETRY_MAX) {
            subIdleDeadRetries++
            await sleep(IDLE_DEAD_RETRY_BACKOFF_MS)
            continue
          }
          return guardStop(`${textBuf.trim()} ${streamProduced
            ? stopNotice('输出中断', `超过 ${Math.max(1, Math.round(STREAM_IDLE_MS / 1000))} 秒无数据（此前已产出部分内容——疑似推理中途停顿）`)
            : stopNotice('上游服务空流', `连接建立后 ${Math.max(1, Math.round(STREAM_FIRST_BYTE_MS / 1000))} 秒未收到任何数据——疑似模型服务未就绪/空转，请检查 provider`)}`.trim())
        }
        else if (classifyApiError(err).kind === 'tools-unsupported') {
          // 工具能力未开启（子 lane 镜像，2026-09-12）：子任务同样靠工具执行，服务端没开
          // 工具调用时重试无意义 —— 直接收尾并把可操作引导写进 lane 转录（同主循环文案）
          return guardStop(stopNotice(
            '上游未开启工具调用',
            '服务端以"未启用 tool_choice"拒绝了带工具的请求（需 --enable-auto-tool-choice --tool-call-parser <解析器>；若服务端已开，请确认应用配置的 API 地址/端口确实指向该服务），子任务靠工具执行、无法降级继续；请补齐启动参数或切换 provider',
          ))
        }
        else if (classifyApiError(err).kind === 'dead-stream') {
          // P1-11（子 lane 镜像）：HTTP 200 后 0 事件即断/EOF → 快速收尾（不空等不狂重试）
          return guardStop(stopNotice('上游服务空流', '请求已被受理但未返回任何数据——疑似模型服务未就绪、加载中或已崩溃，请检查 provider'))
        }
        else if (classifyApiError(err).kind === 'context-window') {
          // P1-#5（子 lane 镜像，审计 #5）：上下文溢出自愈——只做输出预算收窄重试（短会话
          // 无压缩器，见本函数头注释；正则 verbatim 镜像主循环 673-674，公式同主循环 720-724）。
          const m = String(err?.message || err)
          const limit = /maximum context length is (\d+)\s*tokens?/i.exec(m)
          const promptN = /prompt contains (?:at least )?(\d+)\s*(?:input\s+)?tokens?/i.exec(m)
          const limitN = limit ? Number(limit[1]) : 0
          const nextBudget = limitN > 0
            ? (promptN
                ? Math.max(2048, Math.min(attemptMaxTokens, limitN - Number(promptN[1]) - 2048))
                : Math.max(2048, Math.floor(attemptMaxTokens / 2)))
            : attemptMaxTokens
          if (nextBudget < attemptMaxTokens) {
            attemptMaxTokens = nextBudget
            continue // 收窄成功 → 同轮重试（受循环头墙钟/迭代上限守卫覆盖，无需额外防死循环）
          }
          return guardStop(stopNotice(
            '上下文窗口溢出',
            '子任务无压缩（短会话），输出预算收窄至下限仍无法腾出空间，本轮已放弃执行',
          ))
        }
        else throw err
      }
      watchdog.stop()
      // P1 ③/③b 内部自愈（同主 loop）：丢弃退化流 → 注入推进指令续跑；耗尽上限才收尾
      // 2026-09-16 与主循环对齐 `-1 = 不限次`：原判据 `REPEAT_HEAL_MAX > 0` 使默认值 -1
      // （持久无限自愈）在子 lane 变成"完全没有自愈"——两侧语义漂移正是 guards.mjs 头注
      // 要消除的形态（主循环等价判据见 `REPEAT_HEAL_MAX !== 0 && (<0 || < max)`）。
      if (subStop) {
        if (REPEAT_HEAL_MAX !== 0 && (REPEAT_HEAL_MAX < 0 || subHeals < REPEAT_HEAL_MAX)) {
          subHeals++
          textBuf = ''
          const inject = '【系统】检测到你刚才的回复在反复复述近似内容（疑似陷入生成循环），该部分已被丢弃。请立即停止复述，直接推进当前任务——执行下一步具体行动或直接给出最终结论。'
          store.appendUser(inject)
          continue
        }
        return guardStop(stopNotice(subStop.reason === 'gen-repeat' ? '生成内容重复打转' : '生成内容近似打转', subStop.detail))
      }
      // P0-2（子 lane 镜像）：输出被 max_tokens 截断且已产出工具调用 → 不执行残缺参数，
      // 注入 is_error tool_result 提示模型补全重发（主循环同款保护，防子 lane 复活缺陷）
      if (blocks.length > 0 && (subStopReason === 'length' || subStopReason === 'max_tokens')) {
        const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
        store.appendAssistant(assistantBlocks, { model: loopModel })
        const errorResults = blocks.map((b) => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: '模型输出被 max_tokens 截断，工具调用参数可能不完整，未执行。请重新完整发起该工具调用。',
          is_error: true,
        }))
        store.appendToolResults(errorResults)
        textBuf = ''
        continue
      }
      if (blocks.length === 0) {
        // 审计 #10 R3-2（子 lane 镜像）：模型无工具调用即收尾、且上一轮存在工具失败 → 注入
        // 续跑指令强制重试（镜像主循环 runTurnInternal blocks.length===0 分支的注入块；
        // 注入用 store.appendUser——lane 无 pushMemory/session 概念，同 subStop 自愈先例）。
        // 与守卫④熔断互补：R3-2 在失败轮后先给"重试机会"，熔断兜"重试救不回来"的底。
        // guardInjections 额度上限防模型拒不配合时无限注入续跑。
        // 2026-09-16 与主循环同款口径修复：文本已明确收尾（完成声明/交付结果/输出阻塞
        // 说明）时不再注入——注入文案要求"不要停留在文本说明"，但子任务给出最终结论
        // 就是合法收尾，反复拉回工具轮属于同一类"提示→照做→再提示"循环。
        if (hadToolError && guardInjections < maxGuardInjections && !isClosedOut(textBuf, isPlanTail)) {
          guardInjections++
          const inject = '【系统】检测到上一轮存在失败/被取消的工具调用，任务尚未完成。请立即重试或补发正确的工具调用，不要停留在文本说明。'
          store.appendUser(inject)
          textBuf = ''
          continue
        }
        // 计划尾守卫（2026-09-16 与主循环对齐）：子任务同样可能出现"只承诺后续动作、
        // 未执行工具调用就收尾"（子 lane 此前**无此守卫**——主循环有而子 lane 没有，
        // 与刚修的 REPEAT_HEAL_MAX `-1` 语义漂移同属"两侧不对称"）。不注入的话子任务
        // 会以一句"接下来我要…"直接收尾，被当作完成结果回传主线程。
        // 守卫顺序与主循环一致：R3-2（有工具错误）→ 计划尾 → 收尾 break；同受
        // guardInjections 上限约束。注入用 store.appendUser（lane 无 pushMemory/session）。
        if (textBuf.trim() && guardInjections < maxGuardInjections && isPlanTail(textBuf)) {
          guardInjections++
          const inject = planTailText()
          store.appendUser(inject)
          textBuf = ''
          continue
        }
        break
      }
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      store.appendAssistant(assistantBlocks, { model: loopModel })
      // P0-4：子 lane 同样走只读并发批；结果按模型顺序收集
      const executed = await runToolBatch(blocks, { lane: true, store, laneOptions: options, signal: rawAbortSignal(subSignal) || rawAbortSignal(signal) })
      const toolResults = blocks.map((b, i) => ({
        tool_use_id: b.id,
        content: executed[i]?.content ?? '',
        is_error: executed[i]?.isError === true,
      }))
      // 审计 #10 R3-2：记录本轮工具错误（模型下一轮若纯文本收尾，守卫会注入续跑）；
      // 工具成功执行后重置（错误已恢复，不再触发守卫）。
      // P1-6：判据改由 guards.mjs 提供（与主循环**同一实现**——此前两侧各写一份三态逻辑，
      // 改一处忘另一处即造成子 lane 守卫落后于主循环）。
      hadToolError = nextHadToolError(hadToolError, toolResults)
      for (let i = 0; i < blocks.length; i++) {
        toolUses++
        onTool?.(blocks[i], executed[i], toolUses)
      }
      store.appendToolResults(toolResults)
      // 守卫⑥ 进展刷新：成功且非只读测量的工具结果 = 实质进展；
      // 恢复进展即清零愈合计数（自愈成功重新获得完整愈合预算）。
      // P1-6：判据来自 guards.mjs（与主循环**同一实现**，防两侧口径漂移）
      const laneProgress = isRealProgress(blocks, toolResults)
      if (laneProgress) { subLastProgressAt = Date.now(); subStallHeals = 0 }
      // 审计 #10 守卫⑤（子 lane 镜像）：连续同工具提醒（
      // 仅提醒不 veto，硬性由迭代上限兜底）。以每轮首个 tool_use 的规范键（name+参数深排序）
      // 为基准；键变化视为换了方向，链复位。位置在工具结果落 store 后、守卫④熔断判定前，
      // 镜像主循环 836-851 的提醒块。注入经 store.appendUser，与③/③b 不重叠（③③b 检生成
      // 文本重复、⑤ 检重复同工具调用，信号与阶段皆异）。
      if (REPEAT_REMIND_AT.length && blocks.length) {
        // 2026-09-16 口径收紧：与主循环同步取整批键（见 guards.mjs batchToolKey）
        const key = batchToolKey(blocks, canonicalToolCallKey)
        if (key && key === lastSubToolKey) {
          subRepeatStreak++
        } else {
          subRepeatStreak = 1
          lastSubToolKey = key
          subRemindedAt = new Set()
        }
        // P1-6：阈值命中判定与注入文案由 guards.mjs 提供，与主循环**同一实现、同一文案**
        // （此前两份模板串字面相同却是两处维护；副作用仍留各自分支：lane 只落 store）
        if (shouldRemindRepeat(subRepeatStreak, REPEAT_REMIND_AT, subRemindedAt)) {
          subRemindedAt.add(subRepeatStreak)
          store.appendUser(repeatRemindText(subRepeatStreak, blocks[0].name))
        }
      }
      // 守卫④：连续"全部失败"迭代达上限即收尾止损（任一成功即复位），工具结果落 store 后
      // 判定，不改落 store 语义。与 R3-2 自愈互补：自愈引导失败后重试，熔断兜"重试救
      // 不回来"的底（审计 #4：子 lane 此前无此守卫，连续全败会一路空转到迭代上限）。
      // P1-6：判据与文案来自 guards.mjs（与主循环同一实现/同源文案，仅 variant 不同）
      const allLaneFailed = allToolResultsFailed(toolResults)
      if (allLaneFailed) subErrorStreak++
      else if (toolResults.length) { subErrorStreak = 0; subMeltdownHeals = 0 }
      if (MAX_ERROR_ITERATIONS > 0 && subErrorStreak >= MAX_ERROR_ITERATIONS) {
        // 无感愈合（2026-09-10）：先注入排查指令静默续跑，耗尽 MELTDOWN_HEAL_MAX 才 guardStop
        // （后台 lane 注入即唯一干预——无交互对象，故文案取 'lane' 变体）
        if (hasMeltdownBudget(subMeltdownHeals, MELTDOWN_HEAL_MAX)) {
          subMeltdownHeals++
          subErrorStreak = 0
          store.appendUser(errorMeltdownText('lane'))
          continue
        }
        const meltdownNotice = stopNotice(
          '连续工具调用全部失败',
          `连续 ${subErrorStreak} 轮工具调用全部失败，已自动收尾停止重试。请检查失败原因（权限/环境/参数）后重新发起。`,
        )
        // 收尾说明同主循环 loopStop 文案落会话：追加进子 lane 转录，resume_task_id 续跑
        // 时模型可见停止原因（r.text 亦带同文案，经 task_notification.summary 交付）
        store.appendAssistant([{ type: 'text', text: meltdownNotice }], { model: loopModel })
        return guardStop(meltdownNotice)
      }
      textBuf = ''
    }
    return { usage, text: textBuf }
  }

  // —— 子任务执行与登记（S1 血缘 / S2 可继续 / S3 结果承接）——
  // 子 lane 产物收集：会改文件的工具（MUTATING_FILE_TOOLS：Write/Edit）成功路径记文件路径
  // （outputs 交付 + 最后产物）；Read 路径另记 readPaths（证据面：读过的文件也是审计线索）。
  // 只认 Write 会让"小改走 Edit"的产物全部漏账，故改按集合判定（新工具须加进该集合）。
  function makeLaneOnTool({ taskId, writePaths, readPaths, t0 }) {
    return (b, r, count) => {
      if (!r.isError) {
        const p = String(b.input?.file_path || '')
        if (p) {
          if (MUTATING_FILE_TOOLS.has(b.name)) writePaths.push(p)
          else if (b.name === 'Read') readPaths.push(p)
        }
      }
      try {
        wire.taskProgress({
          taskId,
          lastToolName: b.name,
          description: r.isError ? `${b.name} 失败：${String(r.content || '').slice(0, 120)}` : `${b.name} 完成`,
          usage: { tool_uses: count, total_tokens: 0, duration_ms: Date.now() - t0 },
        })
      } catch { /* wire 缺 taskProgress 通道不影响 lane 执行 */ }
    }
  }

  // 子 lane 执行体（spawn 与 resume 共用）：跑完整子循环 → 登记更新 + 终态通知。
  // resume 复用同一 laneStore（历史经 deriveMessages 原样保留，无副作用重放）
  async function runLaneExecution({ taskId, laneStore, sysPrompt, signal: subSignal, writePaths, readPaths, t0, onTool, laneOptions, inbox }) {
    let text = ''
    let status = 'completed'
    let usage = {}
    try {
      const r = await runSubAgentLoop({ store: laneStore, sysPrompt, signal: subSignal, onTool, options: { ...(laneOptions || {}), inbox }, taskId })
      text = String(r.text || '').trim()
      usage = r.usage
      // 守卫停（防死循环自动中止）→ 与取消同态登记为 stopped（可 resume 续跑）
      if (r.stopped) status = 'stopped'
    } catch (err) {
      if (err?.name === 'AbortError') { status = 'stopped'; text = '（已取消）' }
      else { status = 'failed'; text = `执行出错：${err?.message || String(err)}` }
    }
    const totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    // notifUsage 带 in/out/cache 拆分字段（GUI 消费），total_tokens 为合计
    const notifUsage = {
      tool_uses: 0, total_tokens: totalTokens, duration_ms: Date.now() - t0,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    }
    // 产物与读面去重（同一文件可被多次 Edit / Read）：保序去重，避免回传给主 Agent
    // 的清单里出现重复路径。**去重只用于下面这两个新增字段（outputs / reads）。**
    // ⚠️ `outputs` 去重后**不能**拿来取"最后写入的产物"——保序去重取的是"最晚首次出现的
    // 互异产物"，与原 writePaths 末元素语义不同（`Write A → Write B → Edit A` 时两者分别为
    // B 与 A）。故 `output_file` 仍取自**原始** writePaths 末元素，保持既有 wire 语义逐字不变
    // （字段只增不改：output_file = 该 lane 最近写入/修改的那个文件）。改动前请先读
    // kernel-tests/subagent.test.mjs 的 `output_file 仍为"最后写入产物"…` 用例。
    const dedupe = (arr) => [...new Set((arr || []).filter(Boolean))]
    const outputs = dedupe(writePaths)
    const reads = dedupe(readPaths)
    const transcriptPath = String(laneStore?.file || '')
    const outputFile = writePaths[writePaths.length - 1] || ''
    const entry = pendingSubAgents.get(taskId)
    if (entry) Object.assign(entry, { status, summary: text, outputFile, outputs, reads, transcriptPath, usage: notifUsage })
    wire.taskNotification({ taskId, status, summary: text, outputFile, outputs, reads, transcriptPath, usage: notifUsage })
    drainQueuedLanes() // B3：槽位释放 → 启动最早排队任务
    return { status, text, usage, outputFile, outputs, reads, transcriptPath }
  }

  // AS1：agent tools/skills 引用未知项诊断（提示不拦截；skillIds 仅在 cli 提供时校验，
  // 缺省（cli 在 Task 6 前无需传）跳过技能校验）
  function warnUnknownAgentRefs(agent) {
    try {
      const knownTools = new Set(tools.toolNames)
      const unknownTools = (agent.tools || []).filter((t) => !knownTools.has(t))
      const knownSkills = opts.skillIds ? new Set(opts.skillIds) : null
      const unknownSkills = knownSkills ? (agent.skills || []).filter((s) => !knownSkills.has(s)) : []
      const unk = [...unknownTools.map((t) => `工具 ${t}`), ...unknownSkills.map((s) => `技能 ${s}`)]
      if (unk.length) wire.warning?.({ level: 'agent_spec', agent: agent.id, message: `子 Agent「${agent.id}」引用未知${unk.join('、')}（已忽略，不拦截执行）` })
    } catch { /* 诊断失败静默 */ }
  }

  // Agent 工具执行体：前台同步回填 / 后台异步 + task_notification 交付；
  // resume_task_id 复用既有后台任务会话续跑（S2/S3，无需新建 lane）
  async function spawnSubAgent(input, ctx = {}) {
    const type = String(input?.subagent_type || '')
    const prompt = String(input?.prompt || '').trim()
    const toolUseId = String(ctx?.toolUseId || '')
    // —— resume 模式：基于既有后台任务会话续跑（复用 laneStore/sysPrompt/血缘）——
    const resumeTaskId = String(input?.resume_task_id || '')
    if (resumeTaskId) {
      const target = pendingSubAgents.get(resumeTaskId)
      if (!target) return { content: `任务不存在：${resumeTaskId}`, isError: true }
      if (target.status === 'running') return { content: `任务 ${resumeTaskId} 仍在运行中，无法续跑`, isError: true }
      if (!target.laneStore) return { content: `任务 ${resumeTaskId} 无可恢复的会话`, isError: true }
      if (!prompt) return { content: 'prompt 缺失：请说明续跑指令', isError: true }
      // 续跑：追加 user 消息到既有 lane（子循环 deriveMessages 起点 = 原历史 + 续跑指令）
      target.laneStore.appendUser(prompt)
      const subController = new AbortController()
      target.stop = () => subController.abort()
      target.status = 'running'
      wire.taskResumed({ taskId: resumeTaskId, prompt })
      const t0 = Date.now()
      const writePaths = []
      const readPaths = []
      const onTool = makeLaneOnTool({ taskId: resumeTaskId, writePaths, readPaths, t0 })
      target.promise = runLaneExecution({
        taskId: resumeTaskId, laneStore: target.laneStore, sysPrompt: target.sysPrompt,
        signal: subController.signal, writePaths, readPaths, t0, onTool, laneOptions: target.laneOptions,
        inbox: target.inbox || [],
      })
      return { content: `子 Agent 任务已续跑（task_id: ${resumeTaskId}）。完成时收到通知，可用 Task 工具查询/中止。`, isError: false }
    }
    const agent = resolveAgent(agents, type)
    if (!agent) return { content: `未知子 Agent：${type}。可用：${agents.map((a) => a.id).join(', ')}`, isError: true }
    if (!prompt) return { content: 'prompt 缺失：请说明要委派给子 Agent 的任务', isError: true }
    // AS1：agent spec 字段接线（P2-1① 签名扩展的消费方）。tools/skills 引用未知项 →
    // wire.warning（level:'agent_spec'）提示不拦截；空/未定义 = 全量（零回归锁①）。
    // 2026-09-11：disallowedTools/effort 入 laneOptions（沿用 agent frontmatter）。
    const laneOptions = {
      model: agent.model || '',
      // 工具范围由纯函数算出（2026-09-15，A 条款；原逻辑内联在此，无法单测）：
      // 自然语言声明已被 parseToolsSpec 归一，这里只管"空白名单/全不认识/只禁不白"三个分支。
      allowedTools: resolveLaneTools({
        tools: agent.tools, disallowedTools: agent.disallowedTools, allToolNames: tools.toolNames,
      }),
      allowedSkills: Array.isArray(agent.skills) && agent.skills.length ? agent.skills : undefined,
      disallowedTools: Array.isArray(agent.disallowedTools) && agent.disallowedTools.length ? agent.disallowedTools : undefined,
      effort: agent.effort || '',
    }
    // 空 schema 守卫：tools 名单无一命中已注册工具名时，toolSchemas().filter 结果为空集
    // ——空集（非 null）会让 retryStream 收到 tools:[]（lane 无工具可用）。此时视为
    // "未收窄"（allowedTools 清空 → 全量 schema + deny gate 放行）。注册表名与
    // toolSchemas 的 name 同源（tools.mjs toolNames），此处判定等价于 schema 命中判定。
    if (Array.isArray(laneOptions.allowedTools) && laneOptions.allowedTools.length) {
      const knownToolNames = new Set(tools.toolNames)
      if (!laneOptions.allowedTools.some((t) => knownToolNames.has(t))) laneOptions.allowedTools = undefined
    }
    // disallowedTools → 白名单收窄（2026-09-11）：只禁不白的定义自动补齐白名单 =
    // 全量工具 − 禁用集（reviewer/planner 等只读 agent 用）
    if (Array.isArray(laneOptions.disallowedTools) && laneOptions.disallowedTools.length) {
      const disSet = new Set(laneOptions.disallowedTools)
      laneOptions.allowedTools = (laneOptions.allowedTools || tools.toolNames).filter((t) => !disSet.has(t))
    }
    warnUnknownAgentRefs(agent)
    // agent 定义 background:true 恒后台（frontmatter background 字段）
    const runInBackground = input?.run_in_background === true || agent.background === true
    const taskId = newSessionId()
    // S1 血缘：主 agent 派发 depth 0 / parent null；子 lane 派发（S4 预留）经 ctx.lane 透传
    const lineage = {
      parentTaskId: ctx?.lane?.taskId ?? null,
      depth: (ctx?.lane?.depth ?? -1) + 1,
      path: [...(ctx?.lane?.path || []), taskId],
    }
    wire.taskStarted({ taskId, toolUseId, prompt, parentTaskId: lineage.parentTaskId, depth: lineage.depth })
    const laneStore = createSessionStore({ configDir: opts.configDir, cwd: opts.addDirs?.[0] || '', sessionId: taskId })
    // B1 上下文继承档（2026-09-11）：none（默认，现状）| summary（压缩摘要 + 最近
    // 20 轮文本）| full（最近 200 条全量文本）。继承内容为纯文本投影（剥离
    // tool_use/tool_result 块，避免半截消息链破坏 API 合法性），先于任务指令入 lane。
    const inherit = String(input?.context || 'none')
    if (inherit !== 'none' && session) {
      const hist = session.deriveMessages()
      const src = inherit === 'full' ? hist.slice(-200) : hist.slice(-20)
      if (inherit === 'summary') {
        const last = compactor?.lastSummary?.()
        if (last) laneStore.appendUser(`<compacted-summary>${String(last).slice(0, 4000)}</compacted-summary>\n（主会话历史摘要；需要细节时向主 Agent 询问或 Read 相关文件）`)
      }
      for (const m of src) {
        const text = messageTextOf(m)
        if (!text) continue
        if (m.role === 'user') laneStore.appendUser(text)
        else laneStore.appendAssistant([{ type: 'text', text }], { model })
      }
    }
    // 子任务指令入子 lane（子循环 deriveMessages 的起点；与主 runTurn appendUser 对齐）
    laneStore.appendUser(prompt)
    // AS2（2026-09-12）：lane 提示词补齐技能目录——Skill 工具 schema 声明 id 与
    // 【可用技能】清单一致，而 lane 此前只有 agent 正文（子 Agent 只能猜 id）。
    const sysPrompt = withLaneSkillCatalog(
      agent.systemPrompt || `你是 Ponos 的子 Agent「${agent.name}」：${agent.description}。使用简体中文。`,
      { agentSkills: agent.skills, skillIds: opts.skillIds },
    )
    const subController = new AbortController()
    const t0 = Date.now()
    const writePaths = []
    const readPaths = []
    const inbox = [] // B2 主 Agent 消息投递队列（lane 工具边界吸收；后台/前台共用同一引用）
    const onTool = makeLaneOnTool({ taskId, writePaths, readPaths, t0 })
    const exec = () => runLaneExecution({
      taskId, laneStore, sysPrompt,
      signal: subController.signal, writePaths, readPaths, t0, onTool, laneOptions, inbox,
    })
    if (runInBackground) {
      // 登记含 sysPrompt/laneStore/lineage/laneOptions/inbox：resume 复用会话与血缘
      // （laneOptions 保证续跑沿用同一 tools/skills 白名单），级联取消查 parent；
      // inbox = B2 主 Agent 消息投递队列（lane 工具边界吸收）
      // B3 并发槽（2026-09-11）：初始 queued（不计入 runningCount，防自计数恒满），
      // 通过并发检查后置 running 启动；超限则入 FIFO 队列，槽位释放自动启动。
      const entry = {
        status: 'queued', promise: null, laneStore, sysPrompt, lineage, laneOptions,
        inbox, // B2 投递队列（与 exec 闭包同引用，resume 复用）
        stop: () => subController.abort(), // Task stop 中止该子任务（独立信号）
      }
      pendingSubAgents.set(taskId, entry)
      if (LANE_MAX_CONCURRENT <= 0 || runningCount() < LANE_MAX_CONCURRENT) {
        entry.status = 'running'
        entry.promise = exec()
        return { content: `子 Agent「${agent.id}」任务已后台启动（task_id: ${taskId}）。完成时收到通知，可用 Task 工具查询/中止/续跑/投递消息。`, isError: false }
      }
      pendingQueuedLanes.push({ taskId, start: () => exec() })
      return { content: `子 Agent「${agent.id}」任务已排队（task_id: ${taskId}，当前后台并发已满 ${LANE_MAX_CONCURRENT}，槽位释放后自动启动）。可用 Task 工具查询/取消。`, isError: false }
    }
    // 前台并发闸（第 10 项）：取槽后再跑；无论成功/失败/取消都必须释放，
    // 否则槽位泄漏会让后续子代理永久排队（故用 try/finally）。
    const releaseSlot = await acquireForegroundSlot(subController.signal)
    let r
    try {
      r = await exec()
    } finally {
      releaseSlot()
    }
    if (r.status === 'stopped') return { content: '子 Agent 任务已取消', isError: true }
    if (r.status === 'failed') return { content: r.text, isError: true }
    const totalTokens = (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0)
      + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0)
    // 证据面回传：产物**全量**（原只给 outputFile 一个，多产物任务会被主 Agent 漏接）、
    // 读面限量（读过的文件可能很多，全量会淹掉主上下文；上限内全列，超出给总数提示）、
    // 过程入口（transcript 路径，主 Agent 可 Read offset/limit 展开，替代原文复述）。
    const outs = Array.isArray(r.outputs) ? r.outputs : []
    const reads = Array.isArray(r.reads) ? r.reads : []
    // LANE_READS_MAX = 0 表示"不限"（与 LANE_MAX_CONCURRENT 的 0 语义一致）；
    // 不能直接 slice(0, 0)——那会返回空数组，把"不限"变成"不列"。
    const shownReads = LANE_READS_MAX > 0 ? reads.slice(0, LANE_READS_MAX) : reads
    const detail = [
      `子 Agent「${agent.id}」执行完成（${totalTokens} tokens）`,
      r.text,
      outs.length ? `产物（${outs.length}）：${outs.join('、')}` : '',
      shownReads.length
        ? `已读文件（${reads.length}）：${shownReads.join('、')}${reads.length > shownReads.length ? `\n（仅列前 ${LANE_READS_MAX} 个，其余见过程记录）` : ''}`
        : '',
      r.transcriptPath ? `过程记录：${r.transcriptPath}（需要细节用 Read offset/limit 展开，勿让子 Agent 复述）` : '',
    ].filter(Boolean).join('\n\n')
    return { content: detail, isError: false }
  }

  // Task 工具能力（后台任务查询/中止）
  // 级联取消：中止任务及其全部后代（子级优先释放，对齐 deepseek 所有权图语义；
  // 当前子 lane 禁嵌套无后代，结构为 S4 预留）
  function stopSubTree(taskId, seen = new Set()) {
    if (seen.has(taskId)) return
    seen.add(taskId)
    for (const [id, entry] of pendingSubAgents) {
      if (entry.lineage?.parentTaskId === taskId) stopSubTree(id, seen)
    }
    const t = pendingSubAgents.get(taskId)
    if (t && t.status === 'running' && typeof t.stop === 'function') t.stop()
  }

  // 全量中止所有后台子 agent（hardStop / cancel 用）：逐个 abort 子 lane 信号，
  // 子循环在检查点抛 AbortError → runLaneExecution 置 status='stopped' 并发
  // task_notification（"已取消"）。与 stopSubTree 的区别：不管血缘，全部停。
  function abortAllSubAgents() {
    for (const [id, t] of pendingSubAgents) {
      if (t.status === 'running' && typeof t.stop === 'function') t.stop()
    }
  }

  // 解除全部审批/浏览器挂起（abort / hardStop 共用）：挂起点在 await waiter，
  // 若不 resolve，取消后 runTurn 永远卡在工具边界（can_use_tool 审批或
  // browser_response）。审批按 deny 回执（模型侧表现为"用户拒绝/已取消"），
  // 浏览器按失败回执——随后流循环检查 signal.aborted 抛 AbortError 结束轮次。
  function rejectAllWaiters() {
    for (const [id, resolve] of [...approvalWaiters]) {
      approvalWaiters.delete(id)
      resolve({ behavior: 'deny', message: '已取消' })
    }
    for (const [id, resolve] of [...browserWaiters]) {
      browserWaiters.delete(id)
      resolve({ ok: false, error: '已取消' })
    }
    // 应用命令挂起同款处理：取消/打断必须立刻解除，否则模型侧工具边界要等到超时
    for (const [id, resolve] of [...appWaiters]) {
      appWaiters.delete(id)
      resolve({ ok: false, data: null, error: '已取消', kind: 'unknown', durationMs: 0 })
    }
    // 提问挂起同样要解除：漏掉这一步，取消/打断时 waitForAnswer 会一直挂到超时，
    // 表现为"按了停止键，内核却要等到提问超时才真的收尾"。
    if (answerWaiter) {
      const w = answerWaiter
      answerWaiter = null
      w('')
    }
  }

  const taskSystem = {
    list() {
      if (pendingSubAgents.size === 0) return '当前无后台子 Agent 任务'
      return [...pendingSubAgents.entries()]
        .map(([id, t]) => {
          const indent = '  '.repeat(t.lineage?.depth ?? 0)
          return `${indent}${id.slice(0, 8)} [${t.status}]${t.summary ? ' ' + String(t.summary).slice(0, 80) : ''}`
        })
        .join('\n')
    },
    status(taskId) {
      const t = pendingSubAgents.get(String(taskId || ''))
      return t ? `${taskId} [${t.status}]${t.summary ? '\n' + String(t.summary) : ''}` : `任务不存在：${taskId}`
    },
    output(taskId) {
      const t = pendingSubAgents.get(String(taskId || ''))
      if (!t) return { content: `任务不存在：${taskId}`, isError: true }
      if (t.status === 'running') return { content: '任务仍在运行中', isError: false }
      const parts = [
        String(t.summary || '(无输出)'),
        Array.isArray(t.outputs) && t.outputs.length ? `产物（${t.outputs.length}）：${t.outputs.join('、')}` : '',
        t.transcriptPath ? `过程记录：${t.transcriptPath}（用 Read offset/limit 展开）` : '',
      ].filter(Boolean)
      return { content: parts.join('\n\n'), isError: false }
    },
    stop(taskId) {
      const t = pendingSubAgents.get(String(taskId || ''))
      if (!t) return { content: `任务不存在：${taskId}`, isError: true }
      // B3：排队中任务直接出队取消（不进终态通知队列）
      if (t.status === 'queued') {
        const qi = pendingQueuedLanes.findIndex((q) => q.taskId === String(taskId))
        if (qi >= 0) pendingQueuedLanes.splice(qi, 1)
        t.status = 'stopped'
        try { wire.taskNotification({ taskId: String(taskId), status: 'stopped', summary: '（排队任务已取消）', outputFile: '', usage: {}, outputs: [] }) } catch { /* 事件失败不影响主流程 */ }
        return { content: `已取消排队任务 ${taskId}`, isError: false }
      }
      if (t.status !== 'running') return { content: `任务已结束（${t.status}）`, isError: false }
      stopSubTree(String(taskId || '')) // 级联中止（含后代；当前无嵌套场景等价单中止）
      return { content: `已请求中止任务 ${taskId}（含其后代）`, isError: false }
    },
    // B2 消息投递（2026-09-11）：运行中任务投递进 inbox（其当前工具轮结束后接收）；
    // followup 对已停止任务自动 resume 续跑（等价 resume_task_id 语义 + 消息）
    sendMessage(taskId, message) {
      const id = String(taskId || '')
      const t = pendingSubAgents.get(id)
      if (!t) return { content: `任务不存在：${id}`, isError: true }
      const msg = String(message || '').trim()
      if (!msg) return { content: 'message 缺失：请提供要投递的消息内容', isError: true }
      if (t.status !== 'running') return { content: `任务已结束（${t.status}）——用 followup 可自动续跑并投递消息`, isError: false }
      ;(t.inbox ||= []).push(msg)
      return { content: `已投递消息给任务 ${id}（将在其当前工具轮结束后被接收）`, isError: false }
    },
    async followup(taskId, message) {
      const id = String(taskId || '')
      const t = pendingSubAgents.get(id)
      if (!t) return { content: `任务不存在：${id}`, isError: true }
      const msg = String(message || '').trim()
      if (t.status === 'running') {
        if (msg) { (t.inbox ||= []).push(msg); return { content: `已投递消息给运行中的任务 ${id}`, isError: false } }
        return { content: `任务 ${id} 正在运行（消息将排队接收）`, isError: false }
      }
      if (!t.laneStore) return { content: `任务 ${id} 无可恢复的会话`, isError: true }
      // 已结束任务：自动 resume 续跑并追加消息（复用 spawnSubAgent resume 分支）
      return spawnSubAgent({ resume_task_id: id, prompt: msg || '（主 Agent 要求继续）' })
    },
    // S2 可继续：基于既有后台任务会话续跑（复用 laneStore；prompt 为续跑指令）
    async resume(taskId, prompt) {
      const id = String(taskId || '')
      const t = pendingSubAgents.get(id)
      if (!t) return { content: `任务不存在：${id}`, isError: true }
      if (t.status === 'running') return { content: `任务 ${id} 仍在运行中，无法续跑`, isError: true }
      if (!t.laneStore) return { content: `任务 ${id} 无可恢复的会话`, isError: true }
      // 复用 spawnSubAgent 的 resume 分支（同一语义：复用 lane + 追加续跑指令）
      return spawnSubAgent({ resume_task_id: id, prompt: String(prompt || '').trim() || '（任务继续）' })
    },
  }

  return {
    signal,
    toolNames: tools.toolNames,
    toolSchemas: () => tools.toolSchemas(),
    // workflow 引擎依赖注入：registry 暴露给工作流 tool/document 节点
    tools,
    // subagent 体系：Agent/Task 工具能力 + 后台任务登记
    spawnSubAgent,
    taskSystem,
    pendingSubAgents,
    // Agent 工具被禁用时（--disallowedTools Agent）子 Agent 区块不入提示词
    agents: opts.disallowedTools?.includes('Agent') ? [] : agents,
    setSystemPrompt(p) { systemPrompt = p || '' },
    // loop --fresh：请求面从当前消息条数起裁剪（transcript 继续记录）
    setFreshWindow,
    // loop --until 模型判定：小 maxTokens 无工具请求，判定目标是否达成
    // 返回 { done, reason, error }（error=true 时 done 恒 false，cli 据此停 loop）
    async judgeUntil({ target, maxTokens = 512, signal: s = signal }) {
      const history = deriveHistory().slice(-20)
      const judgeMsgs = [
        { role: 'system', content: '你是目标达成判定器。根据对话历史判断目标是否已达成。只输出一个 JSON 对象：{"done":true|false,"reason":"一句话理由"}' },
        ...history,
        { role: 'user', content: `目标：${target}\n请判定该目标在当前对话中是否已达成，只输出 JSON。` },
      ]
      let out = ''
      try {
        for await (const chunk of streamMessages({
          model: opts.model || getProvider().model || '',
          messages: judgeMsgs,
          maxTokens,
          signal: s?.rawSignal || s,
          tools: [],
        })) {
          if (chunk.type === 'text') out += chunk.text
        }
      } catch (err) {
        return { done: false, reason: `判定请求失败：${err?.message || String(err)}`, error: true }
      }
      const m = out.match(/\{[\s\S]*\}/)
      try {
        const j = JSON.parse(m ? m[0] : '{}')
        return { done: j.done === true, reason: String(j.reason || ''), raw: out.slice(0, 200) }
      } catch {
        return { done: /达成|完成|通过|已满足|success|done|yes|true/i.test(out), reason: out.slice(0, 120), raw: out.slice(0, 200) }
      }
    },
    // 思考深度热设置（cli control_request reasoning_effort）：返回规范化档位 + 生效 effort
    setReasoningEffort(value) { return applyReasoningEffort(value) },
    // 审批档位热设置（cli control_request approval_mode）：返回生效档位（非法值回落默认档）。
    // 下一轮工具调用的 gateToolUse 即读取新值；已挂起的审批不受影响。
    setApprovalMode(value) { approvalMode = normalizeApprovalMode(value); return approvalMode },
    getApprovalMode() { return approvalMode },
    abort() {
      rejectAllWaiters()
      signal.aborted = true
      abortController.abort()
    },
    // 停止按钮（cancel）全杀：kill 工具子进程（Bash/OCR，模块级 ACTIVE_CHILDREN）
    // + 中止全部后台子 agent + 中断当前 API 流 + 解除审批/浏览器挂起。与 abort()
    // （打断插入用，同样解除挂起）语义：any 取消路径都必须立刻结束等待——
    // 否则审批/浏览器 waiter 永不 resolve，runTurn 卡死在挂起点（取消不即时根因）。
    hardStop() {
      try { killActiveChildren() } catch {}
      abortAllSubAgents()
      rejectAllWaiters()
      signal.aborted = true
      abortController.abort()
    },
    // cli 的 control_response 路由：解除对应 tool_use 的审批挂起
    resolveApproval(toolUseId, inner) {
      const w = approvalWaiters.get(toolUseId)
      if (w) {
        approvalWaiters.delete(toolUseId)
        w(inner)
      }
    },
    // cli 的 browser_response 路由（bridge 回写）：解除浏览器挂起
    resolveBrowser(requestId, resp) {
      const w = browserWaiters.get(requestId)
      if (w) {
        browserWaiters.delete(requestId)
        w(resp)
      }
    },
    // cli 的 app_response 路由（bridge 回写）：解除应用命令挂起。回执形状 = app:run
    // 回执 {ok,data,error,kind,durationMs}，由 app-tools.mjs 渲染成工具结果
    resolveApp(requestId, resp) {
      const w = appWaiters.get(requestId)
      if (w) {
        appWaiters.delete(requestId)
        w(resp)
      }
    },
    // 应用命令执行能力对外暴露：kernel/cli.mjs 的 app-tools runner 需要它
    //（与 Browser 工具经 ctx.browserDriver 拿 runBrowser 同理，只是应用工具在
    //  cli 侧建表，故走引擎实例方法而不是工具 ctx）。
    runApp,
    // P8 排队插话：cli 在 turnActive 时吸收 next 消息入队并回发 command_lifecycle
    queueNext(content, uuid) {
      pendingNext.push({ content: String(content ?? ''), uuid })
      if (uuid) wire.commandLifecycle(uuid, 'started')
      // 提问挂起中收到作答 → 立即唤醒（内容同时留在 pendingNext，迭代起点吸收进
      // 当前轮上下文）。两条路都要走：唤醒只解除挂起，注入才让模型真的看到作答。
      if (answerWaiter) {
        const w = answerWaiter
        answerWaiter = null
        w(String(content ?? ''))
      }
      return pendingNext.length
    },
    // 是否正挂起等用户作答（cli 用：挂起期间的普通消息必须注入当前轮唤醒等待，
    // 而不是排队等下一轮——否则用户答了却像没答，内核一直挂到超时）
    isAwaitingAnswer() { return awaitingAnswer },
    pendingNextCount() { return pendingNext.length },
    drainNextPending() { return pendingNext.splice(0) },
    getTurnStats() { return turnStats },
    async runTurn({ content, msg }) {
      // 新轮次重置取消标志：abort() 只影响发出时正在进行的轮次
      signal.aborted = false
      abortController = new AbortController()
      const t0 = Date.now()
      if (session) session.appendUser(String(content ?? ''))
      else pushMemory({ role: 'user', content: String(content ?? '') })
      let outcome
      try {
        const { usage, model: turnModel, text, lastUsage, toolDigest, assistantTexts } = await runTurnInternal({ content })
        outcome = { usage, model: turnModel, text, lastUsage, toolDigest, assistantTexts }
      } catch (e) {
        // 用户取消（Stop 按钮/打断插入，契约 §8）原样上抛 → cli 输出「已取消。」+ result
        // 收尾、进程保留可续聊。不落入下方"内部错误"兜底——AbortError 是有意信号，
        // 吞掉会让取消轮只剩半截文本、UI 无收尾确认（Stop 按钮体验依赖此路径）。
        if (e?.name === 'AbortError') throw e
        // J1：内部错误（非取消）登记到 health failures——多次失败推高健康分/触发红档判定
        try { health?.recordFailure?.() } catch { /* 静默 */ }
        // 全局兜底：turn 内部任何未捕获异常（模型流/审批/压缩等）都不得中断会话。
        // 回填错误文本作为本轮结果，会话日志保留（transcript 权威源仍可回溯），
        // 后续轮次照常继续——消灭"失败后断"。错误文本必须 wire.assistant 发出：
        // session 模式下 pushMemory 是 no-op（不入 transcript），只发 result 会让
        // GUI 收到"无任何内容的结果"，界面表现为静默卡死（用户侧无法区分忙/死）。
        const errMsg = e?.message || String(e)
        const errText = `【系统】本轮执行出现内部错误：${errMsg}（会话已保留，可继续对话或重试）`
        pushMemory({ role: 'assistant', content: `【系统】本轮执行出现内部错误：${errMsg}` })
        try { wire.assistant([{ type: 'text', text: errText }]) } catch { /* 事件流异常不再掩盖原错误 */ }
        outcome = { usage: null, model: opts.model || process.env.PONOS_MODEL || '', text: errText }
      }
      const durationMs = Date.now() - t0
      // turnStats 每轮尾部产出（health/result/stats 共用）。lastUsage = 本轮最后一次
      // 单请求 usage（health 水位信号；usage 为轮级合计，仅成本/计费口径）
      turnStats.push({ usage: outcome.usage, lastUsage: outcome.lastUsage ?? null, durationMs, model: outcome.model, ts: new Date().toISOString(), compactCount: session ? session.compactCount() : 0 })
      // P2-2：会话级用量累计（四字段）→ costOf 单价 env → 跨 PONOS_BUDGET_USD 阈值
      // 发 budget 告警（每会话单次 crossing，防刷屏）。usage null（内部错误轮）不累计。
      if (outcome.usage) {
        for (const k of Object.keys(sessionUsageAcc)) sessionUsageAcc[k] += outcome.usage[k] ?? 0
      }
      if (BUDGET_USD > 0 && !budgetWarned) {
        try {
          const usd = costOf(sessionUsageAcc, PRICES)
          if (usd > BUDGET_USD) {
            budgetWarned = true
            wire.warning?.({ level: 'budget', usd: Number(usd.toFixed(4)), budgetUsd: BUDGET_USD })
          }
        } catch { /* 预算计算异常静默 */ }
      }
      health?.record(turnStats[turnStats.length - 1])
      // 失真观测上报（2026-09-12 spec §4.2）：轮尾把内容侧证据交给 health —— 必须
      // 在 health.record 之后（压力与失真是两个独立被测量）。异常静默：失真检测是
      // 侧路，绝不允许影响轮次结果。
      try {
        const assistantText = String(outcome.text ?? '') +
          (Array.isArray(outcome.assistantTexts) && outcome.assistantTexts.length
            ? '\n' + outcome.assistantTexts.join('\n') : '')
        health?.recordTurnContent?.({
          user: String(content ?? ''),
          assistant: assistantText,
          toolDigest: Array.isArray(outcome.toolDigest) ? outcome.toolDigest : [],
        })
      } catch { /* 失真观测失败不得影响轮次 */ }
      // J1：LLM-as-Judge 低频抽检（shouldRunJudge = 红档 + 冷却 300s；默认关零行为）。
      // judge 失败/抛异常一律静默——判定不得影响主流程（spec：Judge 为新增侧路）。
      // health.runJudge 为可选数据属性（cli 装配 engine.judgeUntil 包装，见 Task5 Step 3）
      try {
        if (health?.shouldRunJudge?.()) {
          const j = await health.runJudge?.(health.snapshotState?.() ?? null)
          if (j) health.recordJudge?.(j)
        }
      } catch { /* judge 异常静默：不影响本轮 result */ }
      // result 事件由 engine 发出（含 duration_ms；cli 不再重复 emit）
      wire.result(outcome.usage, { duration_ms: durationMs })
      // toolDigest（2026-09-14 loop 运行时接线，只增字段）：loop 控制器的轮次无进展
      // 指纹与 filesChanged/步数累计依赖本轮的"工具结果指纹"（outcome 内部已有）。
      // 非工具轮/内部错误轮可能没有该字段 → 统一归一为空数组，消费方无需再判类型。
      return {
        usage: outcome.usage, model: outcome.model, text: outcome.text, durationMs,
        toolDigest: Array.isArray(outcome.toolDigest) ? outcome.toolDigest : [],
      }
    },
  }
}

