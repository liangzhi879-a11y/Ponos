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
// 观测：每轮尾部产出 turnStats（usage/durationMs/model/ts/compactCount/cache），
// health/result/stats 三个消费者共用；result 事件由 engine 发出（cli 不再重复）。
import { classifyEmptyCompletion, emptyCompletionError, planEmptyCompletionRecovery, streamMessages, classifyApiError, deadStreamError } from './api.mjs'
// 空回复降级（Task 6）需要知道"当前生效协议"与"备用协议"是否不同：判定真源是 wire/url.mjs
// 的 resolveApiFormat（唯一决策点），engine 不另起一套判定。
import { resolveApiFormat } from './wire/url.mjs'
import { abortError, beginAwaitingUser, endAwaitingUser } from './protocol.mjs'
import { countCjk, estimateRequest, estimateMessage, clampOutputBudgetForWindow, requestTokens, DEFAULT_WINDOW, contentEpoch } from './context.mjs'
import { costOf } from './cost.mjs'
import { sampleToolOutput } from './result-sample.mjs'
import { decideToolPermission } from './permissions.mjs'
// P0-3（2026-09-16）：同族重试硬拒需要族归因；族判定与"是否灾难"共用 blacklist 一份逻辑
import { catastrophicFamily } from './blacklist.mjs'
// P1-6（2026-09-16）：主循环与子 lane 的守卫判据/文案收敛到唯一实现——此前两侧各写一份
// （内注释自认「子 lane 镜像主循环」），是"同一逻辑两处维护"，改一处忘另一处即造成两侧漂移。
import {
  isRealProgress, allToolResultsFailed, nextHadToolError,
  shouldRemindRepeat, repeatRemindText, errorMeltdownText, hasMeltdownBudget,
  batchToolKey, isClosedOut, planTailText, SYSTEM_INJECT_EXTRA, systemInjectExtra,
  hasActiveWait, allToolsTimedOut,
} from './guards.mjs'
import { normalizeApprovalMode, deriveApprovalMode } from './approval-mode.mjs'
import { withLaneSkillCatalog, withLaneAtlasPrompt } from './prompt.mjs'
import { createToolRegistry, killActiveChildren, MUTATING_FILE_TOOLS } from './tools.mjs'
import { hardenToolResult } from './untrusted.mjs'
import { createSessionStore, newSessionId, sanitizeSegment } from './session.mjs'
import { resolveAgent, resolveAgents, resolveLaneTools } from './agents.mjs'
import { normalizeWhitelistHost } from '../shared/browser-whitelist-host.cjs'
// ★ P2b（2026-10-15）：输入 act 的判据取自**契约真源** —— 本文件不另写一份 act 名单
//   （本仓两次踩过"同一份名单抄两遍"）。用于"显式授权证据"的构成（见 screenInputAuthorized）。
import { isInputAct } from '../shared/screen-contract.cjs'
import { getProvider } from './provider.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { diskWrite, getDiskTelemetry } from './disk-write.mjs'
import { createCompactor } from './compact.mjs'
import { perfTime, perfTimeAsync, perfMark, perfSpan, perfStep, perfBegin, perfCount } from './perf.mjs'
import { createCacheObserver } from './cache-observer.mjs'
import { CONTINUE_HEAL_MAX, deadlineForTool, FID_ANCHOR_MAX_CONSEC, FID_ANCHOR_REINJECT_EVERY, IDLE_DEAD_RETRY_BACKOFF_MS, IDLE_DEAD_RETRY_MAX, IDLE_HEAL_MAX, LANE_MAX_CONCURRENT, LANE_READS_MAX, LOOP_STALL_MS, MAX_ERROR_ITERATIONS, MAX_OVERFLOW_RETRIES, MAX_TOOL_ITERATIONS, MELTDOWN_HEAL_MAX, NEAR_REPEAT_AVG, NEAR_REPEAT_BACK, NEAR_REPEAT_CODE_SKIP, NEAR_REPEAT_RECENT, NEAR_REPEAT_SIM, OUTPUT_TIERS, REPEAT_HEAL_MAX, REPEAT_REMIND_AT, STALL_HEAL_MAX, STREAM_FIRST_BYTE_MS, STREAM_IDLE_MS, TIMEOUT_STREAK_MAX, TURN_TIMEOUT_MS, UPSTREAM_DEAD_HEAL_BACKOFF_MS, UPSTREAM_DEAD_HEAL_MAX, adaptiveFirstByteMs, isFidAnchorOn, withAnchorTail } from './engine-config.mjs'
import { addUsage, applyAggregateResultBudget, hasUsage, makeIdleWatchdog, normalizeEffort, rawAbortSignal, retryStream, sleep, withToolDeadline } from './stream-runtime.mjs'
import { createRequestFace, fitRequestToWindow, messageTextOf, patchOrphanToolUses, trimOversizedRequestCopy } from './request-face.mjs'
import { canonicalToolCallKey, createNearRepeatDetector, detectGenerationRepeat, isPlanTail, isThinkOnly } from './gen-guards.mjs'
// S2/B1 Task 2：迭代头守卫体已搬入 loop-core（profile 驱动守卫序）；此处只保留宿主接线。
// 无循环依赖：loop-core 只依赖 loop-profile（纯数据 + 纯函数），不反向引用 engine。
import { runIterHeadGuards, runInStreamGuards, runAfterStreamGuards } from './loop-core.mjs'
// 演化P0（规格 §4.2「台账」行）：guard 渠道活动登记（接在自愈注入唯一出口 pushInjection 处）。
// knowledge-inject.mjs 不反向依赖 engine（knowledge/memory/inject-ledger 均为纯模块）⇒ 无循环。
import { recordChannel } from './knowledge-inject.mjs'
// 2026-10-06 三层升级（执行层）：模式 → profile 的映射在 loop-modes（纯模块；
// react 与 MAIN_PROFILE 同身份 ⇒ 默认轮零回归）。此处不再直接引 MAIN_PROFILE。
import { DEFAULT_EFFECTIVE_MODE, DEFAULT_LOOP_MODE, customLoopModeId, isEffectiveLoopMode, modeDirective, normalizeLoopMode, parseCustomLoopMode, profileForMode } from './loop-modes.mjs'
// ★ 2026-10-18 ENG-04：循环任务放行白名单（纯函数；判定在 gateToolUse，详见该模块注释）
import { normalizeLoopAllowlist, canLoopAutoApprove } from './loop-approval.mjs'
// ★ 2026-10-18 ENG-03：判词消息组装抽成纯函数（判词必须读**全量**历史，不受 --fresh 裁剪）
import { buildJudgeMessages, parseJudgeOutput } from './loop-judge.mjs'
// 2026-10-07 编排扩展（T5）：custom:<id> 钉住态的轮首接管调度（纯接线层：load/run/stop +
// 回复合成 + wall_ms；可单测——kernel-tests/loop-orchestrate.test.mjs）。
import { runOrchestrationTurn } from './orchestrate.mjs'
// 2026-10-06 三层升级（路由层/治理层）：判定与裁决都在纯模块里（可单测），engine 只做
// 「轮首调用一次 + 按裁决应用」。路由失败绝不抛错（mode-router 自带兜底返回）。
import { classifyLoopMode, harvestModeHint, resolveRouterModel } from './mode-router.mjs'
import { buildEscalationPayload, evaluateRouteGovernance, interpretEscalationAnswer } from './governance-router.mjs'
// 会话健康快照聚合（2026-09-23 spec §3.1/Task 5）：纯读取聚合器（无 IO、无判定）——本文件
// 只**提供来源**（cost/guard/disk），不在 engine 侧自己拼结构（拼结构会变成第二套真相）。
import { buildHealthSnapshot } from './health-snapshot.mjs'

// P1-6 拆分：环境阈值层与模块级支撑函数已外提为下列模块，此处以 re-export 维持原导出面，
// 外部导入方（cli.mjs / compact.mjs / kernel-tests）无需任何改动。createEngine 闭包保持原样。
export { adaptiveFirstByteMs, withAnchorTail } from './engine-config.mjs'
export { applyAggregateResultBudget, makeIdleWatchdog, normalizeEffort, withToolDeadline } from './stream-runtime.mjs'
export { buildHistoryIndex, createRequestFace, fitRequestToWindow, patchOrphanToolUses, trimOversizedRequestCopy } from './request-face.mjs'
export { canonicalToolCallKey, createNearRepeatDetector, detectGenerationRepeat, isCodeLikeUnit, isPlanTail, isThinkOnly } from './gen-guards.mjs'
// 自愈阶梯汇总（2026-09-21 长任务可靠性 P2 第三步）：本文件只**消费**它做观测视图，
// 判定的单一真源在 kernel/heal-ladder.mjs（纯函数、可单测；守卫侧不各自判级）。
import { summarizeLadder } from './heal-ladder.mjs'

// ── S1/O2 观测：守卫可观测契约（只读，不参与控制流）────────────────────────
/**
 * 全部守卫 id（11 个）。顺序 = 主循环里"可能命中"的语义顺序，供测试与面板对齐。
 * ★ 单一真源：本常量 + GUARD_INJECT_IDS；改动守卫集必须同步这里（与批 2 的 profile 对齐）。
 */
export const GUARD_IDS = [
  'wallClock',       // ① 轮次墙钟超时（置 loopStop.reason='timeout'；不发事件、无注入）
  'iterCap',         // ② 单轮迭代硬上限（置 iterCapHit=true；不发事件、无注入）
  'stall',           // ⑥ 无进展停滞（自愈注入 / 硬停）
  'streamWallClock', // ①b 流内墙钟超时（无注入）
  'genRepeat',       // ③ 生成重复（检测；自愈注入记在 repeatHeal）
  'nearRepeat',      // ③b 句级近重复（检测；自愈注入记在 repeatHeal）
  'idleWatchdog',    // 流空闲看门狗（自愈注入 / 硬停）
  'upstreamDead',    // 上游死亡（只发事件、无注入 —— 如实登记，不粉饰）
  'repeatHeal',      // R3-2 重复自愈（注入"推进模板"）
  'meltdown',        // ④ 连续全工具失败熔断（自愈注入 / 硬停）
  'repeatReminder',  // ⑤ 同工具重复提醒（注入）
]

/** 会**真的产生注入**的守卫 id（5 个）。GUARD_INJECT_IDS ⊆ GUARD_IDS 由单测守护。 */
export const GUARD_INJECT_IDS = ['stall', 'idleWatchdog', 'repeatHeal', 'meltdown', 'repeatReminder']

/**
 * 归一化一轮的守卫状态（纯函数；O2 的 `turnStats[i].guard` 形状）。
 * 只做"如实登记"：缺失按 0/null/false —— 不做推断、不做美化。
 */
export function collectGuardState(input = {}) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  const { hits, injections, iterCapHit, loopStopReason, stallHeals, errorStreak, repeatStreak } = input || {}
  const flatHits = Array.isArray(hits) ? hits.map(String) : []
  const injected = n(injections)
  // 自愈阶梯汇总（2026-09-21 长任务可靠性 P2 第三步）：把"本轮救到第几级"变成可读事实。
  // 排障时这一句替代翻三层日志——原先级差只存在于注释里，答不出"还能再救吗"。
  // 真源判定 kernel/heal-ladder.mjs（纯函数）；此处只如实传入已知量，**不做推断**。
  const ladder = summarizeLadder({
    hits: flatHits,
    injections: injected,
    stops: typeof loopStopReason === 'string' && loopStopReason ? [loopStopReason] : [],
    signals: [],
  })
  return {
    hits: flatHits,
    injections: injected,
    iterCapHit: iterCapHit === true,
    loopStopReason: typeof loopStopReason === 'string' && loopStopReason ? loopStopReason : null,
    stallHeals: n(stallHeals),
    errorStreak: n(errorStreak),
    repeatStreak: n(repeatStreak),
    // 派生视图（非新事实，可由上面六项重算）：highest=最高自愈级别、exhausted=是否已收尾交还用户、
    // counts=各级计数、line=给人看的一句话。刻意**不**含时间维度（纪律②：升级看手段、不看时间）。
    ladder: {
      highest: ladder.highest,
      highestName: ladder.highestName,
      exhausted: ladder.exhausted,
      counts: ladder.counts,
      unknown: ladder.unknown,
      line: ladder.line,
    },
  }
}

/**
 * 思考缓冲区（2026-09-23）：累积 reasoning 流的 thinking chunk，在该迭代的内容落盘前
 * 一次性取出落盘，使磁盘行序 = 真实时间顺序（回放据此还原展示顺序）。
 * 主循环与子循环共用本工厂，避免两份逐字重复的缓冲逻辑。
 */
function makeThinkBuffer() {
  let buf = ''
  // 原始思考块（含 signature，2026-10-22 思考回放）：wire 上屏的 buf 是分段后的帧，
  // 不能拿来回传（签名端点校验原文）；解析器在 content_block_stop 另发一条
  // `thinking_block` 完整块，这里原样攒着，flushThinking 落盘时优先用它。
  let blocks = []
  return {
    push(text) { buf += text },
    pushBlock(block) {
      if (block && typeof block.thinking === 'string') blocks.push(block)
    },
    take() {
      const t = buf
      const b = blocks
      buf = ''
      blocks = []
      return { text: t, blocks: b }
    },
    // Task 6：只取长度供"空回复分类"用（第三态判据需要"有思考内容"，而 take() 会消费缓冲，
    // 不能为判定而清空——落盘顺序依赖它）
    len() { return buf.length },
  }
}

/**
 * runAfterStreamGuards 的**实际**返回面（S2.1 类型面补登记）。
 *
 * 病灶：loop-core.mjs 的 runAfterStreamGuards / runPhaseGuards 的 JSDoc 返回值只登记了
 * `{ stop, state?, action }`，而实现（runPhaseGuards 的 `extra`）在命中自愈时**还会返回**
 * 宿主专属动作载荷 `signal` / `flushText` / `backoffMs` —— 宿主正是靠这三个字段决定
 * "回收看门狗 / 落盘已产出内容 / 退避多久"。JSDoc 未登记 ⇒ 宿主读取时被判 TS2339。
 * 故在宿主调用点按**实际返回**补全并断言；callee 的登记缺口正式补全归
 * kernel/loop-core.mjs 所属任务（本任务文件约束内不改 callee）。
 *
 * `state` 用 `any` 的理由：它是 loop-core 守卫体之间流转的**逐守卫增量状态包**
 * （守卫各自读写自己的计数/时间戳，键集合由 profile 决定），形状不收敛于一张表；
 * 本文件只做「键存在才回写」的搬运（见调用点三处 `!== undefined` 守卫），不解析其内容
 * ⇒ 用 `?`/union 都要穷举全守卫键（既写不完也必然漂移）。正式收口：随 kernel/loop-core.mjs
 * 的守卫 state 表登记（该文件所属任务）。
 * @typedef {{ state?: any, stop?: { reason: string, message?: string }|null, action?: 'break'|'continue'|null, signal?: string, flushText?: string, backoffMs?: number }} AfterStreamResult
 */

/**
 * createEngine 选项（S2.1 类型面补登记，2026-09-28）。
 *
 * 为什么是 `@typedef` 而不是逐字段内联：本对象被**读写 22 个字段**（见下方 @property 表），
 * 两个消费方（createEngine 内的判定 + createToolRegistry 的转发）必须同一口径——同一形状
 * 抄两遍必然漂移（M4）。
 * 为什么放在本文件而不是 shared/：目前**只有** createEngine 读它（cli 是唯一传入口），
 * 出现第二个消费者时应上移；先就地登记，避免为一个消费者新建共享模块。
 *
 * ★ 字段**全部可选**（不传 = 默认/关闭语义）。这是刻意的：把"不传"标成必填会把正确的
 *   调用方判成错的（F2 R2 那 82 个错正是这么来的）。
 * ★ 四类宿主注入项（workflow / hooks / context / onBackgroundFinished）只登记"引擎实际
 *   用到的形状"：引擎对它们只做鸭子类型调用（setDeps / run / estimate / 回调），完整形状
 *   属各自所属模块（kernel/workflow-engine.mjs / hooks.mjs / compact.mjs），不在此重复登记
 *   ——重复登记 = 第二份定义，改一处必漂移一处。
 *
 * ★ 本文件（及本 typedef）新增 `any` 的**统一理由与收口**：只出现在「跨模块不透明句柄」的
 *   位置——即引擎**只做搬运、不解析内容**的依赖（`wire` 帧出口、`session` transcript store、
 *   `compactor`、`health` 对象、权限规则条目、tool input/ctx）。这类形状的真源在各自模块
 *   （kernel/protocol.mjs / knowledge-store.mjs / compact.mjs / health.mjs / permissions.mjs），
 *   在 engine 侧穷举只会产出**第二份定义**（必然漂移）⇒ 用 `?`/union 都不成立。正式收口：
 *   各句柄所属模块的逐文件清零任务（S2.1 其余任务）把自己的形状登记进 JSDoc 后，engine 侧
 *   改为 `import('./x.mjs').X` 引用，届时这些 `any` 随之回收。
 *
 * @typedef {Object} EngineOpts
 * @property {string} [model] CLI --model 显式指定；优先于 provider 注册表
 * @property {string} [configDir] 配置根（<configDir>/projects/<cwd> = 会话目录口径）
 * @property {string[]} [addDirs] 文件边界；addDirs[0] = 会话cwd（用户项目根）
 * @property {string|null} [sessionId] 会话 id（过程物归集的 phase 前缀）
 * @property {boolean} [processHygiene] 阶段收尾归集开关（chat 模式由 cli 传 false）
 * @property {string[]} [skillsDirs] 技能发现根（不并入 addDirs，避免扩大文件边界）
 * @property {string[]} [skillIds] 可用技能 id 清单（子 Agent 引用校验的口径）
 * @property {string[]|null} [flatSkillRoots] 平铺 <id>.md 的技能根白名单
 * @property {string} [systemPrompt] 初始系统提示词（cli 构造后经 setSystemPrompt 覆盖）
 * @property {boolean} [verbose] 详细日志（宿主传入口径，引擎不另读取）
 * @property {boolean} [skipPermissions] 旧 flag：跳过权限判定
 * @property {boolean} [autoApproveHighRisk] 旧 flag：高危自动放行
 * @property {string} [approvalMode] 审批档位（显式档优先于旧 flag 派生）
 * @property {string|string[]} [loopAllowlist] 循环任务**放行白名单**（ENG-04）：
 *   白名单内的工具在循环运行期把 `ask` 降级为 `allow`（`app_*` / 高危 Bash 也能自动过），
 *   白名单外仍逐次审批。**默认空 = 不放行**；灾难命令（`perm.hard`）**永不**因白名单放行。
 * @property {string} [loopMode] 循环模式选择态：'auto'|'react'|'plan'|'reflect'|'subagent' 或 'custom:<workflowId>' 编排形态（缺省透传 undefined = auto = 交还路由；engine 侧还读 env PONOS_LOOP_MODE 补位）
 * @property {string} [routerModel] 路由决策模型（缺省空 = routerModel > PONOS_ROUTER_MODEL > 当前激活模型）
 * @property {string[]} [disallowedTools] 禁用工具名（注册表视图与门共用一份）
 * @property {{ deny?: any[], ask?: any[], allow?: any[] }} [permissionRules] 权限规则表（deny > ask > allow；形状真源 = kernel/permissions.mjs 的 matchList 入参）
 * @property {{ setDeps?: (deps: object) => void, load?: (id: string) => any, run?: (opts: object) => Promise<any>, stop?: (runId: string) => any }} [workflow] 工作流引擎实例（setDeps 注入审批门；编排面 load/run/stop 供轮首接管）
 * @property {{ run: (event: string, payload?: object) => Promise<{ deny?: boolean, stop?: boolean, message?: string, exitCode?: number, output?: string, stderr?: string, durationMs?: number, matched?: boolean }|null> }} [hooks] hooks 执行器（preToolUse 可否决）
 * @property {{ window?: number, maxMessages?: number, estimate?: (x: any) => { total: number } }} [context] 主会话上下文（lane 压缩阈值判定用）
 * @property {string|null} [memoryRoot] MemorySearch 个人经验根
 * @property {string|null} [projectMemoryRoot] 项目级记忆根（当前无写入方，cli 不传）
 * @property {string[]|null} [knowledgeSpaces] 会话知识范围（null = 不限；空数组 = fail-closed）
 * @property {boolean} [allowOutsideDirs] 解锁文件工具的目录限制
 * @property {string[]|null} [disabledSkills] 全局停用技能清单（null = 未停用任何技能；空数组与之等价）
 * @property {(info: object) => void} [onBackgroundFinished] 后台任务收口回调（宿主决定是否唤醒）
 * @property {(() => string)|string} [atlasLanePrompt] 子代理 lane 的项目地图区块（P1.1）：
 *   函数形式每次 spawn 求值（内部自带 TTL/缓存），字符串形式为固定区块；空串 = 不注入。
 */
// 工具摘要内容签名（spec P1-4）：修正 loop 无进展指纹的误判。
// 约束：必须是**纯函数输入派生**，不做任何文件系统 I/O —— 否则每一步工具调用都会附带磁盘开销。
// 语义：
//   · 写类工具 → sha1(稳定序列化的输入)：内容不同即不同签名（"反复改进同一文件"算进展）
//   · 读类工具 → 结果正文长度：重复读同一文件得同一签名（仍算无进展，符合直觉）
//   · 其余工具（Bash/Agent/Workflow/Skill/MCP…）→ sha1(输入)：它们**没有文件路径**，
//     靠 path 判进步只会得到空串 ⇒ 改前这些轮次整轮被滤掉，"连续三轮只跑 Bash"与
//     "三轮空转"得到同一个指纹，3 轮后被挂起等人工审批（真 bug，2026-11-01 修）。
//     用输入哈希后：换命令 = 换了签名（算进展），重复同一条命令 = 同签名（如实判无进展）。
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ProjectAtlas'])
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}
function toolSig(name, input, result) {
  try {
    if (WRITE_TOOLS.has(name)) {
      const h = createHash('sha1').update(stableStringify(input ?? {})).digest('hex')
      return `w:${h.slice(0, 12)}`
    }
    if (READ_TOOLS.has(name)) {
      const body = typeof result?.content === 'string' ? result.content : ''
      return `r:${body.length}`
    }
    const h = createHash('sha1').update(stableStringify(input ?? {})).digest('hex')
    return `x:${h.slice(0, 12)}`
  } catch { /* 观测签名失败不影响主流程 */ }
  return ''
}

/**
 * 交给用户钩子（postToolUse）的入参副本：Vault 的 `password` 一律脱敏。
 * 钩子常做通知/上报，原样交出去等于给密码明文开一条出站通道；其余字段保留可观测性。
 */
function hookInputOf(name, input) {
  if (name !== 'Vault' || !input || typeof input !== 'object') return input
  const params = input.params && typeof input.params === 'object' ? { ...input.params } : null
  if (params && Object.prototype.hasOwnProperty.call(params, 'password')) params.password = '[redacted]'
  return params ? { ...input, params } : input
}

/**
 * @param {{ opts?: EngineOpts, wire?: any, session?: any, compactor?: any, health?: any }} args
 *   参数整体可省（`createEngine()` = 全默认）；★ 不能写成 `[args]`——解构形参带可选标记
 *   会报 TS2463（binding pattern parameter cannot be optional）。
 */
export function createEngine({ opts = {}, wire, session, compactor, health }) {
  // ── 活性快照（2026-09-21 长任务可靠性 P2）──────────────────────────────────
  // 内核自报"此刻在忙什么"的唯一状态源：`activitySnapshot()` 供 cli 的活性心跳读取，
  // 外围看门狗据此把"在忙"与"真失活"分开（判定纯函数 kernel/heartbeat.mjs）。
  // ★ 只记**可证伪的事实**（有几次工具进出），不记"感觉还在跑"——自报必须比静默更硬，
  //   否则"修误杀"就直接变成"放过真死"。
  const activityState = { toolsInFlight: 0, toolNames: [], toolStartedAt: 0, turnStartedAt: 0 }
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
  // 2026-09-21（长任务可靠性 P1 Task 7）：后台命令的日志目录与存活计数。
  // 目录沿用 cli 的 runDir 口径（<configDir>/runs），不新增 opts 传递项；计数供 cli 的
  // 退出判据使用（EOF 时若仍有存活后台命令就不退，否则后台会被退出清理一起杀掉，
  // "完成 → 唤醒"就永远等不到 —— 与 P0 的后台子任务同理）。
  const bgRunDir = opts.configDir ? join(opts.configDir, 'runs') : null
  let bgBashAliveN = 0
  const tools = createToolRegistry({ cwd: opts.addDirs?.[0], addDirs: toolResultsDir ? [...(opts.addDirs || []), toolResultsDir] : opts.addDirs, skillsDirs: opts.skillsDirs, flatSkillRoots: opts.flatSkillRoots, skipPermissions: opts.skipPermissions, allowOutsideDirs: opts.allowOutsideDirs, disallowedTools: opts.disallowedTools, workflow: opts.workflow, memoryRoot: opts.memoryRoot || null, projectMemoryRoot: opts.projectMemoryRoot || null, readAllowFiles: session?.file ? [session.file] : [], knowledgeSpaces: opts.knowledgeSpaces ?? null, disabledSkills: opts.disabledSkills ?? null, runDir: bgRunDir, onBackgroundChange: (d) => { bgBashAliveN = Math.max(0, bgBashAliveN + d) }, notifyBackgroundDone: (info) => { try { opts.onBackgroundFinished?.({ ...info, kind: 'bash' }) } catch { /* 通知失败不影响收尾 */ } } })
  // ── 阶段收尾的过程文件归集（待办 860）───────────────────────────────────────
  // 病灶：agent 的过程物（诊断脚本/探针/中间产物/日志）散落在**用户的项目根**，与交付物
  // 混在一起，用户分不清哪个能删。约定与判据在 shared/process-artifacts.mjs（唯一真源），
  // 磁盘执行在 kernel/process-hygiene.mjs（**只移动、从不删除**）。引擎只负责"何时触发"。
  //
  // 目标 = `opts.addDirs[0]`（用户项目根，与 cwd 同口径——工具的相对路径都相对它解析）。
  // 三个闸门缺一不可：① 有项目根；② 本实例允许（chat 模式由 cli 传 false —— chat 没有任何
  // 本地工具，不该动磁盘；测试可传 PONOS_PROCESS_HYGIENE=0 关掉）；③ 见 runTurn 的收尾判定。
  const processHygieneRoot = opts.addDirs?.[0] || null
  const processHygieneEnabled = opts.processHygiene !== false && process.env.PONOS_PROCESS_HYGIENE !== '0' && Boolean(processHygieneRoot)
  // 阶段名 = 会话 id 前 8 位："哪个会话/哪次任务产出的过程物"是最小但够用的溯源粒度
  // （人工归集可经 `--process collect --phase <语义名>` 换成"阶段1-勘察"这类可读名）。
  const processHygienePhase = `session-${String(opts.sessionId || (session?.file ? basename(session.file, '.jsonl') : '') || 'unknown').slice(0, 8)}`
  // 审批放行档位（2026-09-12 四档化）：闭包变量而非 opts 字段——运行中可经
  // setApprovalMode 热切换（cli control_request），下一轮工具调用即按新档判定。
  // 未传档位时按旧 flag 派生（= 今天的真实行为，见 approval-mode.mjs 文件头）。
  let approvalMode = normalizeApprovalMode(opts.approvalMode || deriveApprovalMode({ skipPermissions: opts.skipPermissions, autoApproveHighRisk: opts.autoApproveHighRisk }))
  // ★★ 2026-10-18 ENG-04：循环任务**放行白名单**（闭包变量，热可设）。
  //
  // 为什么需要：循环任务是**无人值守**的，而审批是**逐次**挂起等应答。默认档 `loose` 下
  //   `appTool`（app_*）与 `highRiskBash` 的来源档是 bypass ⇒ 每次都要 ask
  //   ⇒ 自动化任务卡在第一个 app_* 或高危命令上，"近乎不可用"。
  //
  // 为什么不是把档位调到 bypass：bypass 会连**灾难命令黑名单**一起放宽，而 AI-02 刚把
  //   "高危判定"提到 allow 之前 —— 全局放宽是倒退，不能用来换可用性。
  //   ⇒ 改为"白名单内自动放行、白名单外照旧"，且**灾难命令永不放行**（见 loop-approval.mjs）。
  //
  // 默认**空数组 = 不放行**：不显式声明就维持原行为（最小惊讶 + 最小权限）。
  let loopAllowlist = normalizeLoopAllowlist(opts.loopAllowlist)
  /** 热设置循环放行白名单（循环控制器在轮次开始启用、结束时清空）。返回归一化后的值。 */
  function setLoopAllowlist(v) {
    loopAllowlist = normalizeLoopAllowlist(v)
    return loopAllowlist
  }
  function getLoopAllowlist() {
    return loopAllowlist.slice()
  }
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
  // 像素层挂起队列（P2 computeruse 像素层，P2a）：requestId → resolve。
  // 与 browserWaiters/appWaiters **同构但独立**——两条 route 的响应可能交错，
  // 共用一张表会让回执投错 waiter（表现为"拿到的结果属于另一个请求"）。
  const screenWaiters = new Map()
  const SCREEN_TIMEOUT_MS = Number(process.env.PONOS_SCREEN_TIMEOUT_MS || 120_000)
  // 用户密码库挂起队列（2026-10-22）：requestId → resolve（bridge 回写 vault_response 解除）。
  // 与上面三张表**同构但独立**：route 不同、回执形状不同，不能共用（否则回执投错 waiter）。
  // ★ 超时必须**大于主进程审批弹窗的等待上限**（vault-agent-approval.cjs DEFAULT_PROMPT_MS
  //   = 90s），否则用户还在看弹窗，内核这边先超时 —— 用户点了允许也什么都不会发生。
  const vaultWaiters = new Map()
  const VAULT_TIMEOUT_MS = Number(process.env.PONOS_VAULT_TIMEOUT_MS || 120_000)
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
    // 2026-09-21（长任务可靠性 P1）：跳过 _foreground 条目 —— 前台任务已由
    // foregroundRunning 计过一次，若再计入 map 里的登记条目就会**双重计数**，
    // 使后台并发预算凭空减半（前台登记见下方前台分支的注释）。
    let n = foregroundRunning
    for (const [, t] of pendingSubAgents) if (t.status === 'running' && !t._foreground) n++
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
  // ★ 2026-10-26（本地小模型「首轮就撑爆」修复）：工具面 schema 的**唯一求值点**。
  //
  // 为什么必须收口成一个函数（而不是在需求处各调一次 `tools.toolSchemas()`）：
  //   ① **口径必须同源**：估算（estimateRequest）与实际请求要靠同一份 schema 才是同一个数；
  //      两边各调一次会各自重建数组 ⇒ context.mjs#toolsTokens 的引用缓存恒 miss，
  //      且"估算按裁过的算、请求按没裁的发"这类漂移从这个缝里长出来就是必然的；
  //   ② **按窗口裁剪只在这里生效一次**：`window` 只在这一处传给 toolSchemas ⇒
  //      B 层的预算裁剪对估算与请求同时成立（传 null 时退回既有不裁行为）。
  //   失效判据 = (窗口, 工具名集合)：MCP / 工作流等动态工具就绪后名字集合变化即重算，
  //   不会让新工具"晚几轮才可见"（而名字集合本身是 getter，读它比重建整个 schema 便宜得多）。
  let _toolFaceCache = null
  function toolSchemasNow() {
    const w = Number(engineCtx?.window) > 0 ? Number(engineCtx.window) : null
    let namesKey = ''
    try {
      namesKey = (tools.toolNames || []).join(',')
      // ★ 2026-10-26（deferred tools）：解锁状态会改变**投递面**，却不改变注册表的名字集合
      //   ⇒ 必须并入缓存键，否则 ToolSearch 取回后这里仍命中旧数组，表现为"工具加载了但
      //   模型看不到"（最隐蔽的一类 bug：日志有 ToolSearch 成功、请求体里却没有它）。
      const loaded = typeof tools.loadedDeferredNames === 'function' ? tools.loadedDeferredNames() : []
      if (loaded.length) namesKey += '|L:' + [...loaded].sort().join(',')
    } catch { namesKey = '' }
    const key = `${w || 0}|${namesKey}`
    if (_toolFaceCache && _toolFaceCache.key === key) return _toolFaceCache.schemas
    const schemas = tools.toolSchemas({ window: w })
    _toolFaceCache = { key, schemas }
    return schemas
  }
  // **不裁剪**的工具面（`window: null` ⇒ 不按窗口推导预算 = 既有默认行为）。
  // 专供"明确圈定的工具子集"使用（子 agent 的 allowedTools）：那里裁掉一个就等于
  // 那次任务少一项能力，而预算的目的是"整体别撑爆前缀"，不是"逐个子集都要省"。
  // `includeDeferred: true` 同理 —— 子 agent 声明的可能是未走 ToolSearch 的 MCP 工具
  // （子 agent 没有主会话的检索历史）；调用方随后 `.filter(allowedTools)` 收窄 ⇒ 不会撑大。
  // 单槽缓存键 = 工具名集合（与 toolSchemasNow 同思路，省掉每次 26KB 的重复构造）。
  let _toolFaceUncapped = null
  function toolSchemasUncapped() {
    let namesKey = ''
    try { namesKey = (tools.toolNames || []).join(',') } catch { namesKey = '' }
    if (_toolFaceUncapped && _toolFaceUncapped.key === namesKey) return _toolFaceUncapped.schemas
    const schemas = tools.toolSchemas({ includeDeferred: true })
    _toolFaceUncapped = { key: namesKey, schemas }
    return schemas
  }
  // T2.4（2026-10-20）：lane 压缩**默认开**（`PONOS_LANE_COMPACT=0` 关）。
  // 为什么反转默认：lane 一旦超窗，**不压缩就是直接报错**（上下文溢出）——那比"多一次压缩调用"
  // 严重得多（用户看到的是子 Agent 失败）。压缩是超窗时的**唯一出路**，不该要用户先想起开开关。
  // 仍留一行回退：设 `PONOS_LANE_COMPACT=0` 即回到旧行为（并行扇出、压延迟敏感的场景可用）。
  const LANE_COMPACT_ENABLED = process.env.PONOS_LANE_COMPACT !== '0'
  // ── 固定前缀 preflight（2026-10-26，只报一次）────────────────────────────────
  // 为什么需要它：本次事故的完整链条是"固定前缀吃掉窗口 → 一两次工具调用就撞限 →
  // 用户只看到'又爆了'"，而**中间没有任何一处告诉过他固定前缀有多大**。压缩日志只报
  // messages 的 est，从不报 system/tools 这两个真正的重量级选手。
  // 判据：system + tools 占窗口 ≥ 50% 就该出声（此时留给对话+输出+工具结果的余量
  // 已不足半个窗口，任何稍长的任务都会撞限）。阈值刻意放在 50%：再高就来不及处置。
  // 只报一次（每会话），避免每轮刷屏；不改控制流、失败静默（纯观测）。
  let prefixPreflightDone = false
  function prefixPreflight() {
    if (prefixPreflightDone) return
    prefixPreflightDone = true
    try {
      const w = Number(engineCtx?.window) || 0
      if (!(w > 0)) return
      const est = estimateRequest({ system: systemPrompt || '', messages: [], tools: toolSchemasNow() })
      const ratio = est.total / w
      if (ratio < 0.5) return
      const msg = `内核：固定前缀已占上下文窗口 ${(ratio * 100).toFixed(0)}%`
        + `（system ${est.sections.system} + 工具面 ${est.sections.tools} = ${est.total} / ${w} token），`
        + `留给对话与工具结果的余量约 ${Math.max(0, w - est.total)} token。`
        + '这会让稍长的任务很快撞上下文上限（压缩只能裁历史、编不掉前缀）。处置：'
        + '减少 MCP 服务器/启用工具数、精简技能清单，或换更大窗口的模型；'
        + '也可用 PONOS_DYNAMIC_TOOL_BUDGET_BYTES 显式收紧工具面。'
      console.error(msg)
      wire.warning?.({ level: 'context', message: msg, tokens: est.total, budget: w })
    } catch { /* 观测失败不影响请求 */ }
  }
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

  // ── 会话健康快照 provider 装配（2026-09-23 spec §5.1；契约 §4.4）──────────────
  // 为什么接线点在这里（而不是 cli 创建 health 处）：engine 在 health **之后**创建，而五段里
  //   两段的真源是本闭包的私有状态——cost←`sessionUsageAcc`/`PRICES`/`BUDGET_USD`（会话用量累计）、
  //   guard←`turnStats` 最新一轮的 `collectGuardState` 产物。cli 侧读不到（除非 engine 再暴露
  //   一组访问器，那是凭空多一层接口），故由 engine 把自己的**只读闭包**注入 health
  //   （`setSnapshotProvider`）。pressure 段读 health 自身的对外快照（单源），disk 段读进程级
  //   遥测单例；fidelity 段**刻意 null**（既有失真三轴走自己的通道与 UI，本快照不重复采集）。
  // 纪律：provider 是纯读取——不改任何状态、返回值不影响控制流（唯一消费者 = health 帧的
  //   可选字段，且只在"真的要发帧"时求值）；抛错由 health 侧吞掉，最多使该帧省略 `snapshot`。
  if (health && typeof health.setSnapshotProvider === 'function') {
    health.setSnapshotProvider(() => {
      const lastTurn = turnStats.length ? turnStats[turnStats.length - 1] : null
      const acc = sessionUsageAcc
      const usd = costOf(acc, PRICES)
      return buildHealthSnapshot({
        // pressure：health 自己算出来的对外快照（**不**在 engine 侧重算水位）。四项齐备：
        //   `remainingPct`/`remainingTurns`/`compactCount`/`attentionCeiling`——末者由任务 5 的
        //   修复接通（`snapshotState()` 已暴露该数值水位基准）；无有效窗口时聚合器如实输出 null。
        health: health.snapshotState?.() ?? null,
        fidelity: null, // 三轴失真由既有失真通道负责，本快照勿重复采集（缺项如实 null，不填 0）
        cost: {
          // tokens = 会话累计（四个 usage 字段求和，口径同 result 事件里的 total_tokens）
          tokens: acc.input_tokens + acc.output_tokens + acc.cache_read_input_tokens + acc.cache_creation_input_tokens,
          // requests：无"API 请求数"计数真源（`turnStats.length` 是**轮数**、一轮可含多请求，
          //   拿它充数就是把"不知道"报成具体数字）⇒ 如实 null。
          requests: null,
          costUsd: usd,
          budgetUsd: BUDGET_USD > 0 ? BUDGET_USD : null, // 未设预算 ⇒ null（不猜）；与既有告警门槛同口径
          overBudget: BUDGET_USD > 0 ? usd > BUDGET_USD : null,
        },
        // guard：最新一轮的守卫状态（含既有 ladder 派生视图）；本轮还没跑过 ⇒ null（不虚报"零命中"）
        guard: lastTurn?.guard ?? null,
        // disk：进程级单例（本会话一次都没写过时 count=0，由聚合器收口为 null——"没观测 ≠ 磁盘好"）
        disk: getDiskTelemetry().snapshot(),
      })
    })
  }

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

  // ── 三层升级（路由/执行层）：循环模式（2026-10-06 spec loop-3layer-upgrade §1）────
  // 两个层级分开放：
  //   loopMode（选择态 auto|react|plan|reflect）—— 用户可钉住/热切换；auto = 交还路由
  //   effectiveMode（实际模式 react|plan|reflect）—— 本轮真正生效者；轮首由钉住或路由决定
  // appliedMode = 模型侧"当前模式语境"：指令注入只在它变化时发生一次；起步 react
  // ⇒ 默认（auto→react）会话零注入、零行为变更（零回归基线）。
  // 选择态初始来源：opts.loopMode（CLI --loop-mode / spawn）> PONOS_LOOP_MODE（env）> auto。
  // 与 approval_mode 同序（显式 flag 优先于环境残留）；非法值归一为 null 后被下一级接管。
  // custom:<id>（2026-10-07 编排扩展）与三模式同链并入：形态校验在此，**存在性在轮首解析**（D23）。
  let loopMode = normalizeLoopMode(opts.loopMode) || parseCustomLoopMode(opts.loopMode)
    || normalizeLoopMode(process.env.PONOS_LOOP_MODE) || parseCustomLoopMode(process.env.PONOS_LOOP_MODE)
    || DEFAULT_LOOP_MODE
  // custom 钉住态的有效态字面量（spec §4.3-2：selected 带 id、effective 压成 'custom'）——
  // 带 ':' 的形态永不进 effective，防止误走指令注入/守卫 profile 分支（D25：路由治理不介入）。
  const CUSTOM_EFFECTIVE_MODE = 'custom'
  let effectiveMode = loopMode === 'auto' ? DEFAULT_EFFECTIVE_MODE : (customLoopModeId(loopMode) ? CUSTOM_EFFECTIVE_MODE : loopMode)
  let appliedMode = DEFAULT_EFFECTIVE_MODE
  // 路由模型（决策 LLM 单独可配）：初始 opts.routerModel > PONOS_ROUTER_MODEL > 当前激活模型
  // （最后一级在轮首 classifyLoopMode 里解析）。control_request('router_model') 可热切换。
  let routerModel = String(opts.routerModel || process.env.PONOS_ROUTER_MODEL || '')
  // 模型主动切换标记（D11）：只作**下一次**路由判定的提示，一次性；由流文本采集。
  let pendingModeHint = null
  const MODE_MARKER_ON = process.env.PONOS_LOOP_MODE_MARKER !== '0'
  function getLoopModeState() { return { selected: loopMode, effective: effectiveMode } }
  function applyLoopMode(value) {
    // custom:<id> 是并列形态，不是第四个枚举值（spec §4.2）：形态校验统一走
    // normalizeLoopMode ?? parseCustomLoopMode；存在性不在热切时判（零状态纪律，轮首解析）。
    const sel = normalizeLoopMode(value) || parseCustomLoopMode(value)
    // 非法值**不改档**（由调用方上报 rejected）；返回 selected/effective 供回执
    if (!sel) return { ok: false, value: String(value ?? ''), ...getLoopModeState() }
    loopMode = sel
    // 钉住（react/plan/reflect/custom:<id>）立即改 effective：下一轮轮首直接用；
    // auto 不改 effective（留给下一次路由判定；路由失败沿现值 = D14 连续性）
    if (sel !== 'auto') effectiveMode = customLoopModeId(sel) ? CUSTOM_EFFECTIVE_MODE : sel
    return { ok: true, value: sel, ...getLoopModeState() }
  }
  function applyRouterModel(value) {
    routerModel = String(value ?? '').trim()
    // 回执的 effective 走**路由模型的唯一解析实现**（mode-router#resolveRouterModel：
    // routerModel → PONOS_ROUTER_MODEL → 当前激活模型）。
    // ★ 2026-10-10 修：此处原先自带一份 `opts.model || getProvider().model || ''` —— 那是
    //   **第二真源**，且比权威实现少一级（漏 PONOS_ROUTER_MODEL）⇒ 实测（注入 PONOS_ROUTER_MODEL
    //   后清空热切换）回执 effective 为空串，GUI 据此显示"生效模型为空"（用户只配了路由模型时
    //   明明在用）。同时它与轮首 classifyLoopMode 传入的解析口径也不一致（同一件事两种算法）。
    //   兜底链里**没有**、也不该有默认模型名：内核不编造模型（provider 未激活且 env 无值 ⇒ 空串，
    //   如实反映"没有可回落的目标"，而不是编一个名字出来）。
    return { ok: true, value: routerModel, effective: resolveRouterModel({ routerModel, model }) }
  }
  // 模型主动提示采集（每迭代文本定稿处调用；kill switch 只关采集、不关解析——剥离口径统一）。
  function harvestHint(text) {
    const r = harvestModeHint(text)
    if (MODE_MARKER_ON && r.hint) pendingModeHint = r.hint
    return r
  }

  /**
   * **全量**对话历史（不受 `--fresh` 裁剪）—— ENG-03，2026-10-18。
   *
   * 为什么必须与 `deriveHistory()` 分开：
   *   `--fresh` 的语义是「**请求面**跳过 fresh 之前的消息」（省 token）。
   *   但判词器（`judgeUntil`）复用它就有害：第 2 轮起看不到上一轮目标与产出
   *   ⇒ 目标已达成也判"未达成" ⇒ **无限循环烧预算**；或误判已达成提前收口。
   *
   * ⇒ 主对话仍走 `deriveHistory()`（保留 fresh 语义），**判词走本函数**。
   */
  function deriveFullHistory() {
    return session ? session.deriveMessages() : memoryHistory.filter((m) => m.role !== 'system')
  }

  function deriveHistory() {
    const base = deriveFullHistory()
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

  // ── 系统提示唯一落盘出口（待办「所有系统提示…静默运行」）─────────────────────────
  // 一切**非用户发言**的注入（守卫自愈/停滞推进/输出截断续写/主 Agent 消息…）都必须经
  // 这两个出口落 transcript，由它们打上统一机读标记 SYSTEM_INJECT_MARK；GUI 展示层
  // （src/lib/transcriptAdapter.ts）据此单点滤除，不再靠文案正则猜。
  // ★ 标记只加在 **transcript entry** 上，不动 entry.message：模型上下文（deriveMessages）
  //   与 transcript 原文逐字不变（planTailText 首句仍是 api.mjs 的恢复锚点）。
  // ★ 静态门禁（kernel-tests/system-inject-mark.test.mjs）扫 engine.mjs：凡把系统文案
  //   （【系统】/【提示】/【主 Agent 消息】/guards 文案工厂）交给 appendUser 的调用，
  //   必须带标记——防以后新增守卫时绕过出口。
  /** 主循环：注入 user 文本（pushMemory + session 打标落盘，等价原两步）。 */
  function appendSystemUser(text) {
    pushMemory({ role: 'user', content: text })
    if (session) session.appendUser(text, SYSTEM_INJECT_EXTRA)
  }

  /** 子 lane：注入 user 文本（lane 无 pushMemory/session，只有 laneStore）。 */
  function appendLaneSystemUser(store, text) {
    store.appendUser(text, SYSTEM_INJECT_EXTRA)
  }

  async function runTurnInternal({ content }) {
    // P0-3：轮起点清空"已拒灾难族"——语义严格对齐 spec 的「同一 turn 内」。
    // 跨轮重提属新的用户意图，应当重新询问（一次拒绝不该永久封禁该族命令）。
    deniedCatastrophicFamilies.clear()
    // P2b（2026-10-15）：输入动作的"一次运行只问一次"记忆也在轮起点清零。
    // ★ "一次运行" = 一次 `runTurnInternal`（处理一个用户请求的全过程，内部可能含多次
    //   模型调用与工具动作）。用户说"继续"是新的一次运行 ⇒ **重新询问**；一轮之内批准过
    //   一次后，同类输入动作不再打扰（用户裁决：每批次运行只询问一次，不要每个动作都问）。
    screenInputApprovedThisRun = false
    // 轮起点时刻（活性心跳的 turn_ms：让"这一轮跑了多久"成为现场可见的事实）
    activityState.turnStartedAt = Date.now()
    // P4-5：provider 热切换后每轮重解析模型（下一轮立即生效，无需重建 engine）
    model = opts.model || getProvider().model || ''
    // ── 三层升级·轮首模式结算（路由/执行层，spec 2026-10-06 §1.1/§1.3）────────────
    // 一处结算、全轮生效：headGuardCtx 稍后按 turnMeta.effective 解析 profile（本函数内
    // 唯一解析点 ⇒ "每轮恰好解析一次 profile"由结构保证，静态测试钉死）。
    // 结算是**纯内存**的（不注入、不发事件）——注入只在"模式语境变化"时发生（下方）。
    const turnMeta = { selected: loopMode, effective: effectiveMode, router: null, governance: null }
    if (loopMode !== 'auto') {
      // 用户钉住：选择态即生效态（完全不调用路由 = 杀开关）；custom 压成字面量 'custom'
      turnMeta.effective = customLoopModeId(loopMode) ? CUSTOM_EFFECTIVE_MODE : loopMode
    } else {
      // ── 路由层（2026-10-06 三层升级 §1.2）：每用户轮恰一次、短超时、绝不阻塞轮 ──
      // 失败/超时/坏 JSON ⇒ ok:false，沿用当前 effectiveMode（D14 连续性优先），
      // 并如实登记 error/fallback——绝不因"判定失败"剥掉在途模式。
      // 外部信号（D13）：上一轮守卫留痕（停滞自愈/错误链/重复链/迭代上限/有界收尾）
      // 即"有失败证据"；首轮无历史 ⇒ 无信号。turnStats 末条正是上一轮产物。
      const prevGuard = turnStats.length ? turnStats[turnStats.length - 1]?.guard : null
      const externalSignal = !!(prevGuard && ((prevGuard.stallHeals ?? 0) > 0 || (prevGuard.errorStreak ?? 0) > 0
        || (prevGuard.repeatStreak ?? 0) > 0 || prevGuard.iterCapHit === true || !!prevGuard.loopStopReason))
      let route
      try {
        route = await classifyLoopMode({ messages: deriveHistory(), model, routerModel, signal, hint: pendingModeHint })
      } catch (e) {
        // 防御性兜底（classifyLoopMode 设计上不抛）：路由绝不允许拖垮轮
        route = { ok: false, mode: null, confidence: 0, reason: '', fallback: true, attempts: 0, error: `路由异常：${e?.message || e}`, ms: 0 }
      }
      pendingModeHint = null // 提示一次性：合并进本次判定后即清（成败都清，防陈旧提示反复影响）
      const gov = evaluateRouteGovernance({ router: route, currentMode: turnMeta.effective, externalSignal })
      turnMeta.router = { mode: route.mode, confidence: route.confidence, fallback: route.fallback === true, reason: route.reason || '', error: route.error ?? null, ms: route.ms, attempts: route.attempts }
      turnMeta.governance = gov
      try { wire?.system?.('router_decision', { mode: route.mode, confidence: route.confidence, fallback: route.fallback === true, action: gov.action, impact: gov.impact, externalSignal, ms: route.ms }) } catch { /* 事件失败不阻断 */ }
      // 收窄走 isEffectiveLoopMode（白名单谓词）而不是裸 `route.mode`：路由 JSON 的 mode
      // 在类型上是 string，运行期才是白名单内值——谓词让"编译期收窄"与"运行期校验"同一判据；
      // 万一上游违约（未来改动），这里保持当前模式而不是把一个非模式字符串写进轮 meta。
      const routeMode = route.mode
      if (gov.action === 'auto' && route.ok && isEffectiveLoopMode(routeMode)) {
        turnMeta.effective = routeMode
      } else if (gov.action === 'escalate') {
        turnMeta.effective = await escalateModeSwitch({ route, currentMode: turnMeta.effective })
      }
      // stay：保持 turnMeta.effective（安全默认；低置信不切）
    }
    effectiveMode = turnMeta.effective
    // 模式指令注入：只在**模式语境变化**时注入一次（appliedMode 起步 react ⇒ 默认轮零注入）。
    // 打标出口 = 模型可见 / GUI 静默 / transcript 留痕；不切 system 前缀（KV 缓存友好，
    // ai-agent-book「稳定前缀 + 追加轨迹 + 尾部状态」）。指令文本由代码维护，非 LLM 生成。
    if (effectiveMode !== appliedMode) {
      const dir = modeDirective(effectiveMode)
      if (dir) appendSystemUser(dir)
      try { wire?.system?.('loop_mode_applied', { selected: turnMeta.selected, effective: effectiveMode, from: appliedMode }) } catch { /* 事件失败不阻断 */ }
      appliedMode = effectiveMode
    }
    let usage = {}
    // H2：当前迭代"单次请求" usage（health 水位信号）。usage 是轮级合计（本回合
    // 全部 API 调用之和，多工具步 agent 轮可达真实上下文的十几倍），不能代表
    // "当前上下文有多大"；最近一次单请求是其最接近的近似。每迭代 API 调用前
    // 重置，经 outcome.lastUsage → turnStats.lastUsage 供 health 消费。
    let callUsage = {}
    // 前缀缓存观测（2026-09-18 spec §4）：per-request 记录——**覆盖语义**，不是累加。
    // ★ 相邻风险（spec §8.1）：api.mjs 只在"同值快照"层面去重（见 mergeCumulativeUsage
    // 注释），递增快照（流式 output_tokens 增长）会多次 push；而 callUsage 走 addUsage
    // 累加语义。观测若沿用累加会把同一请求记成多次 → pendingCacheUsage 只留最后一次。
    // 默认**开**（T0.5，2026-10-20）：`PONOS_CACHE_OBS !== '0'` 才观测 —— 反转为默认开。
    // 为什么反转：这是**纯观测**（只读 usage 帧做四态分类，不发请求、不改请求体），此前默认关
    // 导致"缓存命中率到底多少"在真实会话里长期没有数据，而它正是判断"前缀削减值不值"的唯一依据。
    // 仍惰性读（同 perf.mjs 头注 1 的坑——cli.mjs 的 settings.env 注入发生在所有 ESM 模块
    // 求值之后，写成模块级常量必然读不到）；要关掉（省那点分类开销）设 `PONOS_CACHE_OBS=0`。
    const cacheObsOn = () => process.env.PONOS_CACHE_OBS !== '0'
    // ★ sizeTol 此处只做 **env → 参数的透传**（不做定界）：
    //   `Number(process.env.PONOS_CACHE_SIZE_TOL)` 在 env 未设 / 非数字时得到 NaN，由
    //   观测器回落默认 0.1；而上下界（[0, 1]）的**收敛点**在 `kernel/cache-observer.mjs` 的
    //   `tolOf()`（classifyCache 与 createCacheObserver 各读一次）——为什么不在本处 clamp：
    //   `createCacheObserver` 的**直接调用方**不止这里（单测、嵌入方），把界写两处必然漂移。
    //   方向记牢：**调大 sizeTol 即钝化判据⑤**（1e9 会让"超出净收缩量"永不成立 ⇒ 判据失效）。
    const cacheObs = createCacheObserver({
      minRead: Number(process.env.PONOS_CACHE_MIN_READ),
      dropRatio: Number(process.env.PONOS_CACHE_DROP_RATIO),
      sizeTol: Number(process.env.PONOS_CACHE_SIZE_TOL),
    })
    let pendingCacheUsage = null
    // 请求级结算：与 perfStep 同位置调用（迭代头 + 轮末补），一处覆盖十余处 continue 出口。
    // 引用 perfTurn（下方 const，运行时求值）——调用点必在声明之后。
    function flushCacheObs() {
      if (!pendingCacheUsage) return
      const u = pendingCacheUsage
      pendingCacheUsage = null
      let r
      // ★ v2 A1：判据交给 contentEpoch（判定层用 epoch 变化判"预期性失效"），
      // Task 5 的 noteCompaction / noteShrink 只负责给这次失效"起名字"。
      // ★★ 2026-09-18 用户裁定（v2 绑定修订 C）：再加一路**独立**的 summary 信号。
      //   为什么必须有：摘要落地（`session.appendCompactionSummary`）按设计是"换对象而非改内容"
      //   ⇒ **不** bump contentEpoch ⇒ epoch 看不见纯 summary 压缩 ⇒ `cause=post-compaction`
      //   在 epoch 语义下不可达；反向地，压缩伴随 aged/pruned 原地老化时 epoch 变化会被
      //   调用点标签错标成 post-compaction。summaryGen 专治这两点。
      //   取值选择：`session.compactCount()`（等价候选是 `session.getSurface().replaceGeneration`）。
      //   **选 compactCount 的唯一理由（2026-09-18 评审收敛，勿再写"语义更纯"）**：
      //   `compactCount()` 只返回一个数字（session.mjs:416），而 `getSurface()` 每次都要构造
      //   `{ nodes: [...nodes], replaceGeneration }` = **O(n) 数组拷贝**（session.mjs:415）；
      //   本调用点**每请求**都执行 ⇒ 不能有 O(n) 开销或对象构造。
      //   ★ 曾写的"① 语义更纯"已被评审**证伪**：两者的自增点**同址 +1**（摘要落地
      //   session.mjs:407-408，加载恢复 :145-146——加载时逐条 summary 各 +1），
      //   `cli.mjs` resume 后 `compactCount == K ≠ 0` ⇒ 在**加载轴**上 compactCount 并不更纯，
      //   该说法不成立，已删。`compactCount` 仍是对外公共口径（engine.mjs:2433 的 turnStats、
      //   health/bridge 均在消费），故取它无兼容风险。
      //   双非空守卫在观测器侧：session 为 null（内存模式/直连测试）时传 null ⇒ 该判据整体关闭，
      //   与「默认关零副作用」一致（本调用点与既有 contentEpoch() 同址同频，不引入额外分支）。
      //   ★ 函数性守卫（2026-09-18 评审 Minor-5）：`session` 是本函数的闭包形参，形状不受
      //   编译期约束。若传入的 session 没有 `compactCount`（第三方/测试夹具形状），直接调用会在
      //   本 try 内抛 `TypeError`，被 `catch { return }` **静默吞掉** ⇒ 该 engine **整体停止落
      //   `[cache]` 行**（比"少一路判据"严重得多：整条观测链消失且无任何提示）。
      //   `typeof ... === 'function'` 守卫把它降级为"该判据关闭"（summaryGen=null），与上面的
      //   双非空守卫语义一致。当前全仓无此形参（属防御性改进，行为不变）。
      const summaryGen = typeof session?.compactCount === 'function' ? session.compactCount() : null
      try { r = cacheObs.observe(u, { epoch: contentEpoch(), summaryGen }) } catch { return /* 观测失败不得影响主流程 */ }
      if (!cacheObsOn()) return
      // ★ T0.5 补充（2026-10-20）：**只在"有观测数据"时写行**，不再每请求都写一行。
      //   为什么：默认开之后实测发现，对"不带缓存字段的端点/模型"（本地 vLLM、mock、部分代理）
      //   每个请求都会写一行 `st=unsupported` —— 那是纯噪声：它不携带任何观测数据，却按请求量
      //   往 stderr 灌 I/O（实测让一条 busy-spin 的时序用例从绿变红，纯属负载副作用）。
      //   判据：`unsupported`（模型根本没报缓存字段 ⇒ 没有数据可观测）默认**不写**；
      //   要看它请显式 `PONOS_CACHE_OBS=1` 或 `=verbose`（显式开启 = 要看全部，含"没数据"那种）。
      //   其余状态（ok/hit/miss/compacted/aged…）一律照旧逐请求记录 —— 那才是真数据。
      const rawObs = process.env.PONOS_CACHE_OBS
      const verbose = rawObs === 'verbose' || rawObs === '1'
      if (r.state === 'unsupported' && !verbose) return
      try {
        const cause = r.state === 'compacted' ? ` cause=${r.reason}` : ''
        const drop = r.drop > 0 ? ` drop=${r.drop}` : ''
        console.error(
          `[cache] turn=${perfTurn} req=${r.seq} in=${r.cur.input} read=${r.cur.read} new=${r.cur.create} ` +
          `total=${r.cur.total} hit=${r.cur.hitRatio.toFixed(3)} st=${r.state}${cause}${drop}`,
        )
      } catch { /* 埋点不得影响主流程 */ }
    }
    let textBuf = ''
    // 本迭代累积的思考（thinking chunk 此前只 wire 直发，无累积）。落盘见 flushThinking。
    const thinkBuf = makeThinkBuffer()
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
    // Task 6：空回复第三态（只有思考、无正文、无工具、stop=max_tokens/length）的降级状态。
    // emptyDowngrades 保证**每回合最多一次降级**；forcedApiFormat 是降级后本回合固定的协议
    // （只作用于本回合：只要求出一轮结果，就不会再切回那个必然空回复的协议）。
    let emptyDowngrades = 0
    let forcedApiFormat = null
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
    // 2026-09-21（长任务可靠性 P1 Task 9）：双计时器之二 —— "在忙"（工具有超时等待）的
    // 最近时刻。与 lastProgressAt（实质进展）一起构成停滞判据的两个输入（见 guardStall）。
    let lastActivityAt = turnT0
    let timeoutStreak = 0 // 连续"整批全部超时"的次数（超时连击，见 TIMEOUT_STREAK_MAX）
    let loopStop = null    // { reason, message }：重复/挂起/墙钟/熔断的收尾说明
    let iterCapHit = false // 单轮迭代硬上限耗尽（无文本时补说明）
    let errorStreak = 0    // 连续全部失败的工具迭代链
    let repeatStreak = 0   // 连续相同工具调用链（主调用规范键）
    let lastToolKey = ''   // 上一迭代主工具规范键
    let remindedAt = new Set() // 已注入提醒的重复次数（防同一阈值重复轰炸）
    let repeatHeals = 0    // ③/③b 命中后注入"推进指令"续跑次数（干净迭代清零，上限 REPEAT_HEAL_MAX）
    let healedLastIter = false // 上一迭代是否触发③/③b自愈注入（干净迭代后清零 repeatHeals 的判据）
    let stallHeals = 0     // ⑥ 命中后注入"推进指令"续跑次数（恢复实质进展即清零，上限 STALL_HEAL_MAX）
    // S1/O2 观测：本轮守卫命中登记（★ 只观测，不参与控制流；登记本身绝不影响守卫语义）
    const turnGuardHits = []    // 命中的守卫 id（顺序即实际命中顺序；同一 id 可重复）
    let turnGuardInjections = 0 // 命中并**真的产生注入**的次数（无注入守卫不计，见 GUARD_INJECT_IDS）
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
      // 固定前缀体检必须在 compactor/session 判空**之前**：没有压缩器时同样需要它（纯只读观测）
      prefixPreflight()
      if (!compactor || !session) return
      const msgs = session.deriveMessages()
      // outputBudget = 本轮输出预算：maybeCompact 据此把阈值收窄到 window−预算−余量，
      // 防"估算低于比例阈值、但请求 input+max_tokens 已超端点真实窗口"的溢出
      // 2026-10-26：`tools` 必传 —— 请求体真实构成是 system + **tools** + messages。
      // 漏传的后果不是"估得偏低"，而是压缩结构性失明：128K 本地模型上固定前缀已占 79% 窗口，
      // 而 est 看不见 tools ⇒ 恒低于阈值 ⇒ maybeCompact 永不触发（真实会话实测压缩 0 次）。
      const r = await compactor.maybeCompact({ system: systemPrompt || '', messages: msgs, outputBudget: attemptMaxTokens, tools: toolSchemasNow() })
      // 压缩决策显式落 stderr（2026-09-12 T1 诊断项）：此前"究竟有没有压缩、被哪条
      // 判据挡下"只能从 [api] POST 的 msgs 跳变反推（关键词 grep 全仓 0 命中）。
      // 只记非默认决策，避免每轮刷屏（常态 below-threshold 不落）。
      if (r?.action !== 'none' || (r?.reason && r.reason !== 'below-threshold')) {
        // ★ 2026-10-19：`inputs=` 单独一格（2026-10-19 起 Write/Edit 的大 payload 也会被老化）。
        //   为什么必须单独可见：排查膨胀时"清了几条工具结果"与"省略了几个大 payload"是**两个
        //   不同的动作**，混在一个数字里就答不出"到底哪一半在起作用"（用户实测现场正是这一点）。
        //   缺省 '-'（没发生就不占位）；additive，不改既有字段顺序与含义。
        try { console.error(`[compact] action=${r?.action || '-'} reason=${r?.reason || '-'} msgs=${r?.msgs ?? msgs.length} est=${r?.est ?? '-'} maxMessages=${r?.maxMessages ?? '-'}${r?.agedInputs > 0 ? ` inputs=${r.agedInputs}` : ''}`) } catch { /* 日志失败不影响主流程 */ }
      }
      // 归因标记（2026-09-18 spec §5 / v2 A1 + 2026-09-18 用户裁定 C）：本标记**只负责命名**——
      // 判据有两路，都在观测器侧：① `contentEpoch` 变化（原地改写：aged/pruned/未来新增）；
      // ② `summaryGen`（`session.compactCount()`）变化（**摘要落地**——它不改块内容、不 bump
      // epoch，必须走独立信号，见 flushCacheObs 处的详注）。标签**不是免报凭证**：epoch 未变
      // 时标签不产生 compacted（见 cache-observer.test.mjs 的 epoch 单测），只在 epoch 变化时
      // 把 cause 命名得更准（无标签则退化为 history-rewrite）。
      // ★ 降级说明（裁定 C）：`noteCompaction()` 已不再承重——纯 summary 压缩由 ② 自动识别，
      //   本调用点保留为命名兜底（兼容既有接口与测试）。
      // action 值域见 compact.mjs：summarized（模型摘要，全量替换历史 → 前缀必然全失效）、
      // aged / pruned（免费收缩，原地改写历史 → 改写点之后失效）。标签是一次性的——只用在
      // 紧随其后的第一个请求上（cache-observer.mjs 的 observe 末尾置 null）。
      // ★ 两道防御（默认关零副作用 + 埋点异常不伤主流程）：stderr 行只在开关打开时输出，
      //   故开关关闭时**不调用**标记（否则会给 cacheObs 留一份永不被输出的状态）；
      //   调用点全部包在 try/catch 里（与相邻的 [compact] 日志同纪律）。
      if (cacheObsOn()) {
        try {
          if (r?.action === 'summarized') cacheObs.noteCompaction()
          // ★ 2026-10-19：判据从"action 是不是 aged/pruned"扩到"**这轮到底有没有原地改写**"
          //   （r.shrunk）。原因：`maybeCompact` 现在只在**两个维度都解决**时才报 aged
          //   （条数仍超门时改报 count-over-no-shrink，见 compact.mjs 的 2026-10-19 注释）——
          //   那种情形下内容**确实**被清过（contentEpoch 已 bump），若这里仍只认 aged，
          //   这次缓存失效就会被错标成 history-rewrite（实测：两条端到端归因用例当场变红）。
          //   两个条件都保留：`shrunk` 是新增的精确信号，旧的 action 判据覆盖老路径。
          else if (r?.action === 'aged' || r?.action === 'pruned' || r?.shrunk === true) cacheObs.noteShrink()
        } catch { /* 埋点失败不影响主流程 */ }
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
        try { estIn = estimateRequest({ system: systemPrompt, messages: requestMessages(), tools: toolSchemasNow() }).total } catch { estIn = 0 }
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

    // 治理层升级通道（D12）：引擎自撰 ASK_USER 兼容卡 → 桥提取为 question 帧 →
    // FloatingQuestionCard（GUI 零改动）；作答走 waitForAnswer 同一通道。
    // 批准 ⇒ 切换；拒绝/超时 ⇒ 保持当前模式（升级只削减自主权，绝不改变任务推进）。
    async function escalateModeSwitch({ route, currentMode }) {
      const payload = buildEscalationPayload({ mode: route.mode, confidence: route.confidence, reason: route.reason, currentMode })
      const card = `<!--ASK_USER ${JSON.stringify(payload)}-->`
      try { wire.assistant([{ type: 'text', text: card }]) } catch { /* 事件流异常仍照常等待 */ }
      if (session) session.appendAssistant([{ type: 'text', text: card }], { model })
      const answered = await waitForAnswer()
      if (answered) {
        // 作答内容由 cli 经 queueNext 注入 pendingNext（唤醒与注入两条路，见 queueNext）。
        // 只读**本次**注入的末条；批准需显式肯定（否定词优先，安全默认=不切）。
        const last = pendingNext.length ? String(pendingNext[pendingNext.length - 1]?.content ?? '') : ''
        if (interpretEscalationAnswer(last)) return route.mode
      }
      return currentMode
    }

    // 思考落盘（2026-09-23）：本迭代累积的 thinking 必须先于该迭代的 assistant 条目落盘，
    // 磁盘行序才等于真实时间顺序（回放据此还原展示顺序）。
    // 收口成 persistAssistant 而非在 7 个收尾分支各写一行：散写必然漏一处，漏了就是
    // "思考排在该迭代内容之后"，回放顺序仍然失真。take() 无论 session 有无都取出
    // （清空缓冲），避免残留串到下一迭代。
    const flushThinking = () => {
      // blocks 优先（原始未分段文本 + signature，供下一轮工具回放）；text 只作兜底
      const { text: t, blocks } = thinkBuf.take()
      if ((t || blocks.length) && session) session.appendThinking(t, { model, blocks })
    }
    const persistAssistant = (blocks, opts = {}) => {
      flushThinking()
      return session.appendAssistant(blocks, opts)
    }

    const finalizeUsage = () => {
      flushThinking() // 轮末兜底：末迭代只产思考未产文本时，思考仍须落盘
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
    // ── 编排面轮首接管（2026-10-07 编排扩展 D18/D23/D25；spec §4.3）────────────────
    // custom 是钉住态（selected='custom:<id>'、effective='custom'）：解析+运行成功则**整体
    // 接管该轮**——不再进入下方迭代主循环（主循环让位），产物合成该轮助手回复（v1 一次性
    // 落定）。解析失败落回 react 语义继续（选择保留，下轮重试——D23 与 D14 连续性同族）。
    // mode-gated：auto 与三模式路径永不进入本分支（零回归的落点）。
    // 位置约束：在 profileForMode/headGuardCtx/迭代 for 之前、persistAssistant 等轮内
    // 出口助手（:853 起）之后——早返回路径可直接复用既有落盘出口，无 TDZ。
    const customSelId = customLoopModeId(turnMeta.selected)
    if (customSelId) {
      const orch = await runOrchestrationTurn({
        // D17：会话自身 wfEngine（cli 以 opts.workflow 注入；chat/直连测试为 null ⇒ 回退）。
        // 断言桥接（S2.1 同款）：opts.workflow 的 JSDoc 是收窄视图，运行期实参一字未动。
        wfEngine: /** @type {any} */ (opts.workflow || null),
        workflowId: customSelId,
        message: String(content ?? ''), // D22：固定注入 inputs.message（逐字，不 trim）
        cwd: opts.addDirs?.[0] || process.cwd(), // 会话工作目录（与工具相对路径同口径）
        signal, // 轮级取消：会话停止联动（D24）——run 侧与全局/stop 三源合并
        // 回退事件出口（D23）：复用 wire.system 既有通道（零新事件面；bridge 任意会话转发）
        emit: (type, payload) => { try { wire?.system?.(type, payload) } catch { /* 事件失败不阻断 */ } },
      })
      // 收窄必须用 `'reply' in`（不能写 !orch.fallback）：tsconfig.backend.json 是 strict:false，
      // 可选判别键（回退分支 fallback:true vs 成功分支 fallback?:false）在非 strict 下不做联合收窄
      // ⇒ ts-baseline 棘轮 T1/T3 会以 5 条 TS2339 报红（engine.mjs 5/0）。运行期语义等价：
      // 成功对象恒有 reply 键、回退对象恒无（kernel-tests/loop-orchestrate.test.mjs 两形都钉死）。
      if ('reply' in orch) {
        turnMeta.orchestration = { runId: orch.runId, status: orch.status, steps: orch.steps }
        let text = String(orch.reply ?? '')
        if (orch.status === 'cancelled') {
          if (signal.aborted) {
            // 用户停止/打断（会话停止联动取消）：与既有取消路径同终点——cli 收
            // 「已取消。」+ result 收尾（AbortError 是有意信号，runTurn 不吞）
            const e = new Error('已取消')
            e.name = 'AbortError'
            throw e
          }
          // wall_ms 硬停（D24）：非用户取消——如实收尾，不产生假成功回复（过程在编排卡内）
          text = '【系统】编排运行已达墙钟上限（wall_ms），本轮已停止；过程见编排运行卡。'
        }
        if (text.trim()) {
          // 最终回复经既有轮输出路径（spec §4.3d）：assistant 事件 + transcript 一次性落定
          //（节点过程在编排卡内看，token 级流式 v1 不做——D20）
          try { wire?.assistant?.([{ type: 'text', text }]) } catch { /* 事件流异常不阻断收尾 */ }
          if (session) persistAssistant([{ type: 'text', text }], { model })
          else pushMemory({ role: 'assistant', content: text })
        }
        // usage 不聚合工作流节点消耗（节点自记审计——P2）：null = 如实"本轮无会话侧计量"
        return { usage: null, model, text, lastUsage: null, toolDigest: [], guard: collectGuardState(), loopMode: turnMeta, assistantTexts: [] }
      }
      // 回退（D23）：orchestration_unavailable 已由 runOrchestrationTurn 经 emit 发出；
      // 本轮继续走下方主循环（react 语义）。effective 改回但**不重注指令**：appliedMode 已在
      // 上面按 'custom' 推进过——若这里再注一次 react 指令，每个失败轮都会往上下文加噪声；
      // "离开编排语境"的指令重建统一发生在用户真正切回三模式的那一轮（appliedMode 判定）。
      turnMeta.effective = DEFAULT_EFFECTIVE_MODE
      turnMeta.orchestration = { runId: null, status: 'unavailable', steps: 0 }
      effectiveMode = turnMeta.effective
    }
    // K0 观测：轮序号（turnStats 每轮尾 push 一条 ⇒ 本轮序号 = 已完成轮数 + 1）
    const perfTurn = turnStats.length + 1
    let perfIter = 0 // 末次迭代号（循环外结算最后一步用：迭代变量出不了 for 作用域）
    // ── S2/B1 Task 2：迭代头守卫的宿主侧接线（等价搬移，守卫体见 loop-core.runIterHeadGuards）──
    // 契约：守卫体不引用 engine 闭包，阈值/计数器由 state 传入、注入走唯一出口。
    //  · pushInjection —— 唯一出口的宿主实现：persist ⇒ 落 memory + transcript（原
    //    pushMemory + session.appendUser 两步，逐字保留）
    //  · onGuardInject —— 出口事件面：guard_heal（原 try/catch 包裹的 wire?.system 调用）
    // ★ 不改控制流：命中/自愈/收尾语义全在 loop-core，此处只做状态与副作用接线。
    const headInjections = [] // 本轮迭代头的自愈注入记账（只记账，不参与判定）
    const headGuardCtx = {
      // 唯一 profile 解析点（轮首 turnMeta.effective 已结算）：react → MAIN_PROFILE 同身份
      profile: profileForMode(turnMeta.effective),
      turnGuardHits,
      turnGuardInjections: { bump() { turnGuardInjections += 1 } },
      pushInjection(text, meta) {
        headInjections.push({ text, persist: meta?.persist === true })
        if (meta?.persist !== true) return
        appendSystemUser(text) // 打标出口（原 pushMemory + session.appendUser 两步）
        // 演化P0·台账（D3）：本出口是 loop-core **全部**自愈注入的唯一落点
        // （guards 经 ctx.pushInjection 注入，见 loop-core emitInjection）。
        // 已知边界（v1，不假装全覆盖）：引擎主循环 4 处直呼 appendSystemUser 的
        // 自愈与 lane 自愈不在此出口 ⇒ 不计入 guard 渠道（口径见 P0 brief D3）。
        try { recordChannel('guard', { calls: 1, hits: 1, injectedBytes: Buffer.byteLength(String(text), 'utf8') }) } catch { /* 记账失败不阻断注入 */ }
      },
      onGuardInject(inj) {
        // 事件形状容两种：`{name, payload}`（契约侧规范形状，守卫统一用它）与扁平
        // `{reason, attempt, max}`（早期手写）。**必须在宿主侧归一**，理由：守卫体不知道
        // `wire` 长什么样（那是宿主专属），而宿主不能强求所有守卫记住同一嵌套层数 ——
        // 实测踩过：Task 4 首个发事件的守卫传 `{name,payload}`，宿主只读 `ev.reason`
        // ⇒ 事件被静默丢弃（注入照常、事件消失），单测才发现。
        const ev = inj?.event
        if (!ev) return
        const pl = ev.payload || ev
        if (typeof pl?.reason !== 'string') return
        // 2026-09-21（P1 Task 9）：除三要素外**透传扩展字段**（如连击分支的 streak）。
        // 原先只透传 {reason, attempt, max} ⇒ 守卫新加的字段被静默丢弃（与本注释上半段
        // 记载的"宿主只读 ev.reason，事件被静默丢弃"同族 —— 实测又踩一次：连击事件
        // 带的 streak 在 wire 上消失，单测才发现）。扩展字段都是守卫自造的小对象。
        const { reason, attempt, max, ...extra } = pl
        try { wire?.system?.(ev.name || 'guard_heal', { reason, attempt, max, ...extra }) } catch { /* 事件失败不影响主流程 */ }
      },
    }
    const loopCtx = () => headGuardCtx
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
      flushCacheObs() // 前缀缓存观测：结算上一迭代的请求（与 perfStep 同位置，覆盖全部出口）
      // ── 迭代头守卫（① 轮次墙钟 / ② 迭代硬上限 / ⑥ 无进展停滞）────────────────
      // S2/B1 Task 2（等价搬移）：三段守卫体已移入 kernel/loop-core.mjs 的
      // runIterHeadGuards，守卫**集合与顺序**由 resolveGuards(MAIN_PROFILE,'iterHead')
      // 驱动（= wallClock → iterCap → stall，与搬移前逐行等价）。此处只保留
      // 宿主状态与副作用接线，命中语义（stop / break / continue）不变。
      const headResult = await runIterHeadGuards({
        TURN_TIMEOUT_MS, turnT0, MAX_TOOL_ITERATIONS, iter, LOOP_STALL_MS,
        lastProgressAt, lastActivityAt, stallHeals, STALL_HEAL_MAX, iterCapHit,
        timeoutStreak, TIMEOUT_STREAK_MAX,
      }, loopCtx())
      if (headResult.state !== undefined) {
        // 反向同步被守卫更新的宿主状态（iterCapHit / stallHeals / lastProgressAt / 活跃时刻 / 连击）
        if (headResult.state.iterCapHit !== undefined) iterCapHit = headResult.state.iterCapHit
        if (headResult.state.stallHeals !== undefined) stallHeals = headResult.state.stallHeals
        if (headResult.state.lastProgressAt !== undefined) lastProgressAt = headResult.state.lastProgressAt
        if (headResult.state.lastActivityAt !== undefined) lastActivityAt = headResult.state.lastActivityAt
        if (headResult.state.timeoutStreak !== undefined) timeoutStreak = headResult.state.timeoutStreak
      }
      // 控制动作**照原样**（不统一）：⑥ 自愈 = continue；①/②/⑥硬停 = break。
      // ★ ② 是 `break` 但**不置 loopStop**（只有 iterCapHit=true）——原来的 break 语义
      //   保留在此处，loopStop 仍为 null，轮末按 iterCapHit 补收尾说明（:1204 附近）。
      if (headResult.action === 'continue') continue
      if (headResult.stop) loopStop = headResult.stop
      if (headResult.stop || headResult.action === 'break') break
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
          // 打标分流：真用户插话（priority:'next' / 提问作答）保持用户可读；
          // 系统来源（cli 自动触发工作流结果等，queueNext 第三参标 system）打标静默。
          // ⚠️ 两路都必须落 transcript（模型下一轮请求即见），差别只在**展示层标记**。
          if (session) session.appendUser(inj.content, inj.system === true ? SYSTEM_INJECT_EXTRA : {})
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
      // 上游等待心跳（2026-09-21 失速误杀修复）：首字节长等待期周期发帧，让桥的失速
      // 判据与进程硬看门狗能区分"正在等上游"与"真的失活"（详见
      // stream-runtime.mjs#makeIdleWatchdog）。只发帧、不改任何守卫语义——真失活
      // （连回调都跑不起来）仍由各层看门狗照旧兜底。
      const watchdog = makeIdleWatchdog(STREAM_IDLE_MS, () => adaptiveFirstByteMs(requestMessages, STREAM_FIRST_BYTE_MS), {
        onWait: ({ elapsedMs, windowMs }) => { try { wire.system('upstream_wait', { elapsed_ms: elapsedMs, window_ms: windowMs }) } catch { /* 心跳失败不影响请求 */ } },
      })
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
      try { estInputTokens = estimateRequest({ system: systemPrompt, messages: requestMessages(), tools: toolSchemasNow() }).total } catch { estInputTokens = 0 }
      callUsage = {} // H2：本迭代单请求 usage 重置（retryStream 内部瞬时重试重发同请求，累加仍≈1 倍）
      pendingCacheUsage = null // 前缀缓存观测：请求边界清空（上一请求已在迭代头结算）
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
          // Task 6：空回复降级后本回合固定走备用协议（null = 走既有判定链，零回归）
          apiFormat: forcedApiFormat,
          signal: combinedSignal,
          tools: toolSchemasNow(),
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
            thinkBuf.push(chunk.text)
            genWindow = (genWindow + chunk.text).slice(-400)
            wire.assistant([{ type: 'thinking', thinking: chunk.text }])
          } else if (chunk.type === 'thinking_block') {
            // 完整思考块（原始文本 + signature）：只供落盘/下一轮工具回放，不再上 wire
            // （实时帧已由上面的 thinking 分支发过；重复发会让 GUI 思考区双写）
            thinkBuf.pushBlock({ type: 'thinking', thinking: chunk.thinking, signature: chunk.signature })
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
            // ★ 覆盖而非累加：同一请求的递增快照只保留最后一次（见声明区相邻风险注）
            pendingCacheUsage = chunk.usage ?? pendingCacheUsage
            // D1 usage 对账：服务端报告 input_tokens 远超本端估算（3 倍且绝对量
            // 超 50 万）→ 请求组装疑似放大。落 stderr（kernel-stderr.log 诊断项
            // 可见）+ UI 告警条，供当场定位（每轮至多一次，防刷屏）。
            // 2026-09-12：对账口径改为 requestTokens（input + cache_read + cache_write）。
            // 旧实现只取 input_tokens，而 KV 前缀缓存端点上 input_tokens 只是"本轮新增
            // 的未缓存尾部"（实测本会话 ~5K，而整请求面 ~30 万），与"整请求估算"根本
            // 不可比 → 在 DeepSeek/Anthropic 这类端点上此守卫恒不触发、形同虚设
            //（恰是本次卡顿事故中该报警却全程沉默的原因之一）。
            const reported = requestTokens(chunk.usage)
            // ★ 2026-10-26：原判据是 `reported > Math.max(est*3, 500_000)` —— 那个 500_000
            //   是**绝对地板**，在 128K 窗口上永远够不着（这种请求根本发不出去）⇒ 唯一能发现
            //   "请求组装放大"的探测器在小窗口模型上**永久沉默**，正是本次事故潜伏的前提之一。
            //   改为**按窗口缩放**的地板（25% 窗口，另有 8000 绝对下限防小数抖动）：
            //   128K 窗口下地板 32,768 ⇒ 固定前缀吃掉 79% 窗口这件事第一次会被自己报出来。
            //   注意：修好估算（tools 计入）之后 est 本身变准，这条告警回到它原本的语义
            //   ——"估算与实际仍差 3 倍以上"，而不是"总是报"或"永远不报"。
            const anomalyFloor = Math.max(8_000, Math.floor((Number(engineCtx?.window) || 0) * 0.25))
            if (!usageAnomalyWarned && estInputTokens > 0 && reported > estInputTokens * 3 && reported > anomalyFloor) {
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
          // 守卫①b / ③ / ③b（流内相位）：守卫体与守卫序已搬到 kernel/loop-core.mjs，
          // 由 ctx.profile 驱动（S2：顺序可配置、改一处生效）。宿主只负责接线：
          // 传入本块（chunk）与流内累积态，并把返回的 stop 写回 loopStop + 中断流。
          // ★ 本相位不 break —— 与搬移前逐字等价：原实现在流内设完 loopStop 后，
          //   流仍会自然结束或被 abort，控制流从不在此处 break（break 在迭代头）。
          if (!loopStop) {
            const inR = await runInStreamGuards(
              { TURN_TIMEOUT_MS, turnT0, genWindow, nearRep, chunk, loopStop },
              // ★ ctx 必须复用 loopCtx()（含 profile：守卫序真源），只叠加 abort ——
              //   自造 ctx 会漏掉 profile ⇒ 驱动器按"空守卫序"判为未实现而抛错（实测踩过）。
              { ...loopCtx(), abort: () => watchdog.controller?.abort() },
            )
            if (inR?.stop) loopStop = inR.stop
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
          //
          // S2/B1 Task 4（等价搬移）：三态判定与文案已移入 loop-core 的 guardIdleWatchdog
          // （afterStream 相位，timing='onError'）。此处只承担宿主专属动作：
          // 回收看门狗定时器、退避 sleep、把已产出内容落 memory/transcript、中断迭代。
          // 断言见文件上方 @typedef AfterStreamResult：signal/flushText/backoffMs 是 callee
          // 运行时**实际返回**的宿主动作载荷，其 JSDoc 未登记（callee 缺口，正式补全在
          // kernel/loop-core.mjs 所属任务）。
          const idleR = /** @type {AfterStreamResult} */ (await runAfterStreamGuards({
            timing: 'onErrorIdle', watchdogTripped: true, attemptData, loopStop,
            IDLE_DEAD_RETRY_MAX, idleDeadRetries, IDLE_DEAD_RETRY_BACKOFF_MS,
            IDLE_HEAL_MAX, idleHeals, STREAM_IDLE_MS, STREAM_FIRST_BYTE_MS, textBuf,
          }, loopCtx()))
          if (idleR.state !== undefined) {
            if (idleR.state.idleDeadRetries !== undefined) idleDeadRetries = idleR.state.idleDeadRetries
            if (idleR.state.idleHeals !== undefined) idleHeals = idleR.state.idleHeals
            if (idleR.state.textBuf !== undefined) textBuf = idleR.state.textBuf
          }
          if (idleR.stop) {
            loopStop = idleR.stop
          } else if (idleR.action === 'continue') {
            if (idleR.signal === 'idle-dead-retry' || idleR.signal === 'idle-heal') {
              watchdog.stop() // 旧看门狗定时器回收（新迭代会重建）
            }
            if (idleR.signal === 'idle-heal' && idleR.flushText?.trim()) {
              // 保留已产出内容（用户看到无缝续写的前提；未落库的续写会丢上下文）
              pushMemory({ role: 'assistant', content: [{ type: 'text', text: idleR.flushText }] })
              if (session) persistAssistant([{ type: 'text', text: idleR.flushText }], { model })
            }
            if (idleR.backoffMs) await sleep(idleR.backoffMs)
            continue
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
          // S2/B1 Task 4（等价搬移）：预算判定、事件与两条文案已移入 loop-core 的
          // guardUpstreamDead（afterStream 相位，timing='onError'）；宿主只承担 sleep 与中断迭代。
          {
            // 断言理由同上方 idleR（backoffMs 为 callee 运行时实际返回项，其 JSDoc 未登记）。
            const deadR = /** @type {AfterStreamResult} */ (await runAfterStreamGuards({
              timing: 'onErrorDeadStream', upstreamDeadHeals, UPSTREAM_DEAD_HEAL_MAX, UPSTREAM_DEAD_HEAL_BACKOFF_MS, loopStop,
            }, loopCtx()))
            if (deadR.state?.upstreamDeadHeals !== undefined) upstreamDeadHeals = deadR.state.upstreamDeadHeals
            if (deadR.stop) loopStop = deadR.stop
            else if (deadR.action === 'continue') {
              if (deadR.backoffMs) await sleep(deadR.backoffMs)
              continue
            }
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
          // 归因标记（溢出兜底的压缩路径，同 preStep 处）：溢出路径的压缩同样是全量摘要。
          // 语义与上面一处完全一致——**只负责命名**（判据是 contentEpoch 变化 + summaryGen 变化），
          // 且本处已**降级为命名兜底**：摘要落地由 `session.compactCount()` 的独立信号自动识别
          // （裁定 C），不依赖本调用点。开关关闭时不调用（默认态零副作用），埋点异常不伤主流程。
          // 已知限制：本处只标 summarized（保持简报给定形态，未扩到 aged/pruned）；若 forceCompact
          // 返回 aged/pruned，标签缺位只会让 cause 在 epoch 变化时退化为 history-rewrite，**不会**
          // 把预期性失效误报成 suspicious（A1 的推论，方向是漏标而非假警）。
          if (cacheObsOn()) {
            try { if (r?.action === 'summarized') cacheObs.noteCompaction() } catch { /* 埋点失败不影响主流程 */ }
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
              if (session) lastAssistantEntry = persistAssistant([{ type: 'text', text: errText }], { model })
              try { wire.assistant([{ type: 'text', text: errText }]) } catch { /* 事件流异常不再掩盖原错误 */ }
              watchdog.stop()
              finalizeUsage()
              // 前缀缓存观测（评审 Minor-1）：本出口是**提前 return**，绕过迭代头与轮末
              // 两处 flushCacheObs —— 而这一轮恰是刚吃 400 上下文溢出的那一个（最需要观测
              // 的场景）。不补这一步的后果：该轮 turnStats.cache 退化为 null（runTurn 的
              // ?? null），pendingCacheUsage 永不 flush、[cache] 行缺失。故此处按轮末同法
              // 先结算、再带 cache 快照上抛（cacheObs 是本函数局部量，经 outcome 通路到
              // turnStats）。
              flushCacheObs()
              // ★ 必须带 `isError: true`（2026-11-01）：runTurn 只认 `isError`，不认 `error` 字段
              //   （`error` 全仓无消费者）。原来这轮被判成**正常轮** ⇒ turnStats 不带 isError、
              //   health.recordFailure 不触发、loop 控制器与演进环把"什么都没答出来"记成成功。
              //   同文件其它失败轮早已按 AI-04 口径补过 isError，这里补同一口径。
              return { usage, model, text: errText, isError: true, errorKind: 'overflow-compact-failed', lastUsage: callUsage, cache: cacheObs.snapshot(), toolDigest: turnToolDigest,
            guard: collectGuardState({ hits: turnGuardHits, injections: turnGuardInjections, iterCapHit, loopStopReason: loopStop ? loopStop.reason : null, stallHeals, errorStreak, repeatStreak }), loopMode: turnMeta, assistantTexts: turnTexts }
            }
          }
        } else {
          watchdog.stop()
          throw err
        }
      }
      watchdog.stop()
      // 模型主动模式提示（D11）：从本迭代完整文本采集一次（只认闭合标记；见 mode-router）。
      // 只作**下一次**路由判定的提示（一次性），不当轮即时切换——引擎发起才是权威。
      // 文本保持原样落盘：展示剥离口径与 ASK_USER 一致，在桥侧做（server/bridge.mjs）。
      harvestHint(textBuf)
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
      // S2/B1 Task 4（等价搬移）：R3-2 重复自愈已移入 loop-core 的 guardRepeatHeal，
      // 由 afterStream 相位（timing='postStream'）驱动。此处只保留宿主状态接线。
      {
        const healResult = await runAfterStreamGuards({
          timing: 'postStream', loopStop, REPEAT_HEAL_MAX, repeatHeals, textBuf,
        }, loopCtx())
        if (healResult.state !== undefined) {
          if (healResult.state.repeatHeals !== undefined) repeatHeals = healResult.state.repeatHeals
          if (healResult.state.healedLastIter !== undefined) healedLastIter = healResult.state.healedLastIter
          if (healResult.state.loopStop !== undefined) loopStop = healResult.state.loopStop
          if (healResult.state.textBuf !== undefined) textBuf = healResult.state.textBuf
        }
        // 自愈 = 丢弃退化内容后继续下一迭代（原 `continue`，照原样）
        if (healResult.action === 'continue') continue
      }
      if (loopStop) break // 生成重复/挂起已优雅收尾 → 本轮结束（说明文本见轮末 finalize）
      // ── 空回复第三态（Task 6 / spec §3.6 类型 Ⅱ）──────────────────────────────
      // 上方两条既有 max_tokens 分支**都要"有产出"**（① 有工具调用 → 注入错误 tool_result；
      // ② 有正文 → 按 OUTPUT_TIERS 升档续写）⇒ 恰好漏掉第三态：只有思考、textBuf 空、blocks
      // 空、stop_reason ∈ {max_tokens, length}。此前它会一路走到下方 `if (blocks.length === 0)`
      // 的 break ⇒ 本轮零 assistant 正文、result.text=''、无错误、无诊断 —— "HTTP 200 + 流正常
      // 收尾却零产出"的**静默假成功**（本机实测复现，见 .yfworking/process/openai-wire-task6/
      // repro-third-state.mjs；真端点形态见 spec §1.3：max_tokens=512 被思考吃满）。
      // 判据只认这一态，**绝不误伤**：textBuf 非空（截断/正常输出）、blocks 非空（工具链）、
      // stop_reason 为正常结束（end_turn/tool_use）都不进入本分支。
      // 处置按 spec §3.6 L3：上报事件 + 落诊断（只记长度 / stop_reason / usage，**不记正文**）；
      // 有备用协议则切换一次，否则抛出带 kind/hint 的错误（绝不静默）。
      if (blocks.length === 0 && !textBuf.trim()
        && (stopReason === 'max_tokens' || stopReason === 'length') && thinkBuf.len() > 0) {
        const thinkingLen = thinkBuf.len()
        const classified = classifyEmptyCompletion({ stopReason, textLen: 0, toolCount: 0, thinkingLen })
        const provider = getProvider()
        const currentFormat = forcedApiFormat || resolveApiFormat({ baseUrl: provider.baseUrl, env: process.env })
        // 诊断面：**只记长度 / stop_reason / usage**（与 title-gen、注入留痕同口径，绝不记正文与思考）
        const diag = {
          kind: classified?.kind, stopReason, textLen: textBuf.length, thinkingLen,
          outputTokens: Number(usage?.output_tokens) || 0,
        }
        try {
          console.error(`[engine] 空回复（${diag.kind}）：stop_reason=${stopReason} 正文=${diag.textLen} 字符`
            + ` 思考=${diag.thinkingLen} 字符 输出 token=${diag.outputTokens}`)
        } catch { /* 日志失败不影响处置 */ }
        try { wire?.system?.('empty_completion', { ...diag, retryable: classified?.retryable === true }) } catch { /* 事件失败不阻断 */ }
        try { wire?.warning?.({ level: 'empty_completion', message: `${diag.kind}：${classified?.hint || ''}` }) } catch { /* 提示失败不阻断 */ }
        finalizeUsage() // 本迭代的思考照旧落盘（flushThinking），落盘口径不变
        // 调用点断言：`classified`（无默认值的绑定）整体缺席于 callee 的推断参数类型，
        // 但它是 callee 运行时**实际接收项**（三条分支都读它）。其 JSDoc 未登记
        // （callee 缺口，正式补全在 kernel/api.mjs 所属任务）。
        const plan = planEmptyCompletionRecovery(/** @type {Parameters<typeof planEmptyCompletionRecovery>[0] & { classified?: ReturnType<typeof classifyEmptyCompletion> }} */ ({
          classified, currentFormat,
          fallbackApiFormat: provider.fallbackApiFormat,
          fallbackProviderId: provider.fallbackProviderId,
          downgraded: emptyDowngrades > 0,
        }))
        if (plan.action === 'switch-format') {
          emptyDowngrades++
          forcedApiFormat = plan.to
          try { wire?.system?.('empty_completion_switched', { from: currentFormat, to: plan.to, attempt: emptyDowngrades }) } catch { /* 事件失败不阻断 */ }
          try { console.error(`[engine] 空回复降级：改用备用协议 ${plan.to}（from=${currentFormat}）重发一次`) } catch { /* 同上 */ }
          continue
        }
        // 断言理由同上方 planEmptyCompletionRecovery（`classified` 为 callee 运行时实际接收项，
        // 其 JSDoc 未登记 —— callee 缺口，正式补全在 kernel/api.mjs 所属任务）。
        throw emptyCompletionError(/** @type {Parameters<typeof emptyCompletionError>[0] & { classified?: ReturnType<typeof classifyEmptyCompletion> }} */ ({ classified, fallbackProviderId: provider.fallbackProviderId }))
      }
      // P0-2：输出被 max_tokens 截断且已产出工具调用 → 不执行残缺参数，注入
      // 错误 tool_result 提示模型补全重发（消灭"执行参数残缺的调用"）
      // 【2026-09-11 适配】Anthropic/DeepSeek 官方语义用 'max_tokens'，旧判据只认
      // 'length'（mock 用法）→ 真端点截断时守卫不触发、残缺工具被当正常调用执行。
      if (blocks.length > 0 && (stopReason === 'length' || stopReason === 'max_tokens')) {
        const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
        pushMemory({ role: 'assistant', content: assistantBlocks })
        if (session) lastAssistantEntry = persistAssistant(assistantBlocks, { model })
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
            if (session) lastAssistantEntry = persistAssistant([{ type: 'text', text: partial }], { model })
            const inject = '【系统】你的上一条回复因输出上限被截断。请直接从截断处继续输出剩余内容——不要重复已输出的部分，不要道歉，不要总结前文。'
            appendSystemUser(inject)
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
          appendSystemUser(inject)
          textBuf = ''
          continue
        }
        if (textBuf.trim() && guardInjections < maxGuardInjections && isPlanTail(textBuf)) {
          guardInjections++
          const inject = planTailText()
          appendSystemUser(inject)
          textBuf = ''
          continue
        }
        // 思考型模型早停自愈（2026-09-09 截断事故）：模型"想完即停"（文本只到
        // </think> 即 end_turn）时注入续写指令重跑，而不是把半截思考当答案收尾。
        // 与计划尾守卫同受 guardInjections 上限约束，防自愈本身失控。
        if (guardInjections < maxGuardInjections && isThinkOnly(textBuf)) {
          guardInjections++
          const inject = '【系统】检测到你的回复只包含思考过程、未输出回答正文就结束了。请直接、完整地输出对用户最新问题的回答正文，不要重复思考过程。'
          appendSystemUser(inject)
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
            if (session) lastAssistantEntry = persistAssistant([{ type: 'text', text: askText }], { model })
            continue // 作答已在 pendingNext，迭代起点吸收进模型上下文
          }
        }
        break
      }
      // 该轮 assistant 历史：文本块 + tool_use 块（Anthropic API 要求）
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      pushMemory({ role: 'assistant', content: assistantBlocks })
      // 中间 assistant 条目落盘（工具调用轮）：不带 usage（M1，usage 只写轮次最终条目）
      if (session) lastAssistantEntry = persistAssistant(assistantBlocks, { model })
      // P0-4：只读工具批并发、写/执行类串行，结果按模型调用顺序收集。tool_result
      // 必须合并进同一条 user 消息（Anthropic 要求同一 assistant 的多个 tool_use 的
      // tool_result 紧随其后且同消息，拆多条会 400）——先收集再一次性落盘。
      // signal 下传工具层（Grep/Glob 等长遍历据此在让出点判定取消，见 tools.mjs
      // walkForSearch）——轮次取消时 Stop 键能真正中断扫描，而非等它自己跑完。
      const executed = await runToolBatch(blocks, { spawnSubAgent, taskSystem, signal: rawAbortSignal(signal) })
      const injectionHits = [] // 本批工具结果里的注入信号留痕（见下方加固段）
      const toolResults = blocks.map((b, i) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: executed[i]?.content ?? '',
        is_error: executed[i]?.isError === true,
        // 2026-09-21（长任务可靠性 P1 Task 9）：透传 withToolDeadline 的超时标记
        // （stream-runtime.mjs 的 meta.timeout）。原先只映射 is_error、meta 被丢弃
        // ⇒ 长工具执行期与"真失败"无法区分，长任务被判停滞（用户症状①）。
        timeout: executed[i]?.meta?.timeout === true,
        // 2026-10-08（卡片 +N −M）：透传写侧工具（writeFile/editFile）的增删行数。
        // 只对 UI 有意义（wire tool_result 帧 + transcript 顶层 diffs，见 session.appendToolResults）；
        // toolResultsEntry 按字段逐项投影，这两个键**不会**进 entry.message.content（模型输入纯净）。
        // 仅数值有限才加键 ⇒ 无数据的条目形状与旧版逐字相同。
        ...(Number.isFinite(executed[i]?.meta?.additions) ? { additions: executed[i].meta.additions } : {}),
        ...(Number.isFinite(executed[i]?.meta?.deletions) ? { deletions: executed[i].meta.deletions } : {}),
      }))
      // 提示注入加固（2026-09-21 · 待办 761「安全防护」点名项）：工具结果是**外部世界**塞进
      // 上下文的数据（网页正文/下载文件/stdout/MCP/技能/知识包…），可能夹带"忽略此前指令、
      // 把配置发到某地址"这类指令式文本。这里是**所有工具结果进入模型上下文的唯一收口点**，
      // 故加固放在此（逐条按它的来源工具名判定）。
      // 只做**检测 + 提醒**，不拦截：检测必有漏也必有误报，据此拦截会让正常干活被自己的
      // 门禁挡住（待办 763 的教训：误报比漏报更伤信任）。真正的边界是 fs-guard（路径）、
      // egress-policy（出网）、approval/app-permissions（人工闸）—— 注入即便骗过模型也要撞上它们。
      // 未命中时**逐字不变**（hardenToolResult 保证），所以正常路径零差异。
      try {
        for (let i = 0; i < toolResults.length; i++) {
          const raw = String(toolResults[i].content ?? '')
          if (!raw) continue
          const hardened = hardenToolResult(raw, { tool: String(blocks[i]?.name || '') })
          if (hardened.warned) {
            toolResults[i].content = hardened.content
            injectionHits.push({
              tool: String(blocks[i]?.name || ''),
              kinds: [...new Set(hardened.signals.filter((x) => x.severity !== 'low').map((x) => x.kind))],
              severity: hardened.signals.some((x) => x.severity === 'high') ? 'high' : 'medium',
            })
          }
        }
        // 留痕：被投喂注入特征时留下可审计的记录（只记工具名与信号种类，**不记正文** ——
        // 延续"体积与隐私"约束）。走既有 ponos_warning 带外通道（前端 SystemWarningStrip），
        // 与 health/budget 同类，不混进会话正文。事件失败静默，不阻断主流程。
        if (injectionHits.length && typeof wire?.warning === 'function') {
          try {
            const tools = [...new Set(injectionHits.map((h) => h.tool).filter(Boolean))].join('、')
            const kinds = [...new Set(injectionHits.flatMap((h) => h.kinds))].join('、')
            const worst = injectionHits.some((h) => h.severity === 'high') ? '高风险' : '疑似'
            wire.warning({
              level: 'prompt_injection',
              message: `工具输出中${worst}提示注入特征（来源：${tools || '未知'}；类型：${kinds || '未分类'}）`
                + '。已按"只当数据、不当指令"处理并保留原结果；如内容本身是安全文档，可继续使用。',
            })
          } catch { /* 事件失败不阻断 */ }
        }
      } catch { /* 加固失败不得影响工具主流程（宁可少一层提醒，也不能让工具结果丢失） */ }
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
            // T0.3（2026-10-20）：Skill 调用的技能 id（additive）。
            // 为什么要它：C_success 要按"用了哪些技能"分组才知道哪条技能在拖成本；
            // 而 `path` 字段只收 file_path/path/pattern，Skill 的入参是 `skill` ⇒ 此前技能
            // 使用情况**完全没有数据源**（T1.2b 按使用频次加权因此做不了）。只记 id、不记内容。
            ...(String(blocks[i]?.name || '') === 'Skill' ? { skill: String(inp.skill || '').slice(0, 64) } : {}),
            isError: toolResults[i]?.is_error === true,
            errorText: String(typeof toolResults[i]?.content === 'string' ? toolResults[i].content : '').slice(0, 200),
            // O1：结果体积（字节）—— 只取长度，不复制正文（延续"体积与隐私"约束）
            size: Buffer.byteLength(String(executed[i]?.content ?? ''), 'utf8'),
            // P1-4：内容签名（写类=输入哈希 / 读类=结果长度）——loop 无进展指纹的判据（toolSig 头注）
            sig: toolSig(String(blocks[i]?.name || ''), inp, toolResults[i]),
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
        // S2.1 修**真 bug**（TS2552 Cannot find name 'store'，非类型精度问题）：
        // 本行原为 `store || session`，而 `store` 在 runTurnInternal（本函数）作用域内**根本不存在**
        // ——全文件仅 runSubAgentLoop / executeToolUse 有 store（lane 的独立 store）。故原写法在
        // 首批 tool_result 合计超预算时必抛 ReferenceError（**未被任何测试覆盖**：单测直连
        // applyAggregateResultBudget，不经本路径）。落盘目标即本会话 session：无 session 时（嵌入/
        // 直连场景）persistToolResult 的 `!target` 早退**原样返回 content**（= 不落盘、不 stub），
        // 与"超预算才走这里"的既有语义一致。行为变化仅限"原本必炸 ⇒ 现在按 session 落盘"。
        persist: (content, idx) => persistToolResult(session, blocks[idx]?.id, content, 5000),
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
          try {
            // 增删行数（2026-10-08）：从 executed[i].meta 直读 —— applyAggregateResultBudget
            // 只会替换超预算条目的 content（`{ ...r }` 保字段），meta 真源在 executed 上不受影响。
            // 无数据不加键（帧形状与旧版逐字相同）。
            const m = executed[i]?.meta
            wire.toolResult({
              toolUseId: blocks[i].id,
              content: toolResults[i].content,
              isError: toolResults[i].is_error,
              ...(Number.isFinite(m?.additions) ? { additions: m.additions } : {}),
              ...(Number.isFinite(m?.deletions) ? { deletions: m.deletions } : {}),
            })
            // 文件改动帧：与 tool_result 同源（同一份 meta.additions/deletions/diffHunk），
            // 只在写工具上发；op 第一版恒 'modify'（spec §5.1 允许）。
            if (MUTATING_FILE_TOOLS.has(blocks[i].name)) {
              const input = blocks[i].input || {}
              wire.fileChange({
                toolUseId: blocks[i].id,
                tool: blocks[i].name,
                op: 'modify',
                path: String(input.file_path ?? input.path ?? ''),
                additions: Number.isFinite(m?.additions) ? m.additions : 0,
                deletions: Number.isFinite(m?.deletions) ? m.deletions : 0,
                diffHunk: String(m?.diffHunk ?? ''),
              })
            }
          } catch { /* 事件失败不阻断主流程 */ }
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
      // S2/B1 Task 4（等价搬移）：工具后的三类守卫（progressRefresh / repeatReminder /
      // meltdown）已移入 loop-core，由 afterStream 相位（timing='postTools'）驱动。
      // 判据函数（isRealProgress / batchToolKey / shouldRemindRepeat / repeatRemindText /
      // errorMeltdownText / hasMeltdownBudget）经 state 显式传入——它们本就是
      // guards.mjs 的纯函数（主循环与 lane 共用），搬移后共享关系不变。
      // 2026-09-21（长任务可靠性 P1 Task 9）：本批的进展 / 活跃 / 超时连击判定。
      // 双计时器：实质进展 → 计时器都续；"在忙"（有工具超时结束）→ 只续活跃计时器。
      // 连击：整批**全部**超时才累计（一批里有一个成功结果就是进展）；有实质进展即清零。
      const batchProgress = isRealProgress(blocks, toolResults)
      const batchActivity = hasActiveWait(toolResults)
      if (allToolsTimedOut(toolResults)) timeoutStreak += 1
      else if (batchProgress) timeoutStreak = 0
      const postToolResult = await runAfterStreamGuards({
        timing: 'postTools',
        loopStop, madeProgress: batchProgress, madeActivity: batchActivity, blocks, toolResults,
        timeoutStreak,
        REPEAT_REMIND_AT, batchToolKey, canonicalToolCallKey, shouldRemindRepeat, repeatRemindText,
        repeatStreak, lastToolKey, remindedAt,
        MAX_ERROR_ITERATIONS, errorStreak, MELTDOWN_HEAL_MAX, meltdownHeals,
        hasMeltdownBudget, errorMeltdownText, textBuf,
      }, loopCtx())
      if (postToolResult.state !== undefined) {
        const st = postToolResult.state
        if (st.lastProgressAt !== undefined) lastProgressAt = st.lastProgressAt
        if (st.lastActivityAt !== undefined) lastActivityAt = st.lastActivityAt
        if (st.timeoutStreak !== undefined) timeoutStreak = st.timeoutStreak
        if (st.stallHeals !== undefined) stallHeals = st.stallHeals
        if (st.repeatStreak !== undefined) repeatStreak = st.repeatStreak
        if (st.lastToolKey !== undefined) lastToolKey = st.lastToolKey
        if (st.remindedAt !== undefined) remindedAt = st.remindedAt
        if (st.meltdownHeals !== undefined) meltdownHeals = st.meltdownHeals
        if (st.errorStreak !== undefined) errorStreak = st.errorStreak
        if (st.textBuf !== undefined) textBuf = st.textBuf
      }
      if (postToolResult.action === 'continue') continue // ④ 熔断自愈（原 `continue`，照原样）
      if (postToolResult.stop) { loopStop = postToolResult.stop; break } // ④ 硬停（原 `break`）
      // 继续下一轮 API 调用（模型看到 tool_result 后产出新回复）
      // 提问与工具调用同期（模型边问边做）：工具已执行，仍在下一轮 API 调用前挂起等待
      // ——不这么做就等于"问题还没被回答，模型已经基于工具结果继续推理"（原病灶）。
      // 超时不做特殊处理：继续跑（有人在等工具结果，收尾反而丢工作），与审批一致。
      if (asksUser(textBuf)) await waitForAnswer()
      textBuf = ''
    }
    perfStep(perfTurn, perfIter) // K0：轮末结算最后一步（break 与正常退出都要发）
    flushCacheObs() // 前缀缓存观测：结算最后一个迭代（未被下一迭代头覆盖）
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
    // 前缀缓存观测快照（2026-09-18 spec §6）：cacheObs 是本轮内部的局部量，turnStats
    // 由外层 runTurn 产出 ⇒ 复用 lastUsage 既有的"经 outcome 上抛"通路（而不是把观测器
    // 提到引擎作用域：观测器必须**每轮新建**，跨轮复用会让 req 序号与 prev 基准串轮）。
    return { usage, model, text: textBuf, lastUsage: callUsage, cache: cacheObs.snapshot(), toolDigest: turnToolDigest,
            guard: collectGuardState({ hits: turnGuardHits, injections: turnGuardInjections, iterCapHit, loopStopReason: loopStop ? loopStop.reason : null, stallHeals, errorStreak, repeatStreak }), loopMode: turnMeta, assistantTexts: turnTexts }
  }

  // P0-3：大工具结果磁盘持久化 + 预览替换——超阈值全文落盘
  // <sessionDir>/tool-results/<toolUseId>.json，模型输入只留 <persisted-output>
  // 预览 + 路径（可 Read 补读，无损恢复）
  function persistToolResult(target, toolUseId, content, limitOverride) {
    if (!target || typeof content !== 'string') return content
    // T2.1（2026-10-20）：内联阈值默认 20,000 → **8,000** 字符。理由：全文仍然落盘（无损），
    // 而 20,000 字符 ≈5–7 K token 的全额价驻留到下一次压缩才是真成本。
    // `PONOS_TOOL_RESULT_BUDGET_BYTES=20000` 一行回到旧行为。
    const limit = Number(limitOverride ?? process.env.PONOS_TOOL_RESULT_BUDGET_BYTES ?? 8000)
    if (content.length <= limit) return content
    // disk-site: tool-result —— 大结果全文落盘（仅超阈值才走这里）。
    // 失败语义**守恒**：原实现 catch 后退回原文（不阻断工具结果）⇒ 这里 !ok 同样退回原文。
    // 【为何把 mkdir 包进来】：原 try 覆盖 mkdir ⇒ mkdir 失败也走"退回原文"，包进来才等价。
    const w = diskWrite(getDiskTelemetry(), 'tool-result', () => {
      const dir = join(dirname(target.file), 'tool-results')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${toolUseId}.json`)
      writeFileSync(file, JSON.stringify({ id: toolUseId, content, ts: new Date().toISOString() }), 'utf-8')
      return file
    })
    if (!w.ok) return content // 落盘失败退回原文（既有行为，不阻断工具结果）
    // ★ 返回形态守恒：本函数真实返回的是**字符串**（preview 文案 / 原文），并非 {path,persisted}
    //   对象——调用点（本文件的 `persist:` 桥接与工具结果回收处）直接把它当 content 用
    //   ⇒ 这里按真实形态返回。
    //   preview 计算移出包装（String.slice/replace 不可能抛 ⇒ 与原 try 内计算等价），
    //   以免把纯字符串处理算成"落盘失败"污染遥测判据。
    // ★ T2.1：预览从"只留开头 2,000"改为**头 2,000 + 尾 4,000**（`kernel/result-sample.mjs`）。
    //   只留开头会把 Bash/测试/构建的报错全丢掉（它们都在尾部），模型于是要么重跑命令、
    //   要么盲读文件 —— 那才是真正的成本与质量双输。
    const sampled = sampleToolOutput(content, { headChars: 2000, tailChars: 4000 })
    const preview = sampled.text.replace(/"/g, '&quot;')
    return `<persisted-output path="${w.value}" preview="${preview}">（完整内容 ${content.length} 字符已落盘，可用 Read 读取${sampled.sampled ? '；上面预览只含开头与结尾，中段请用 Grep 或 Read offset 定位' : ''}）</persisted-output>`
  }

  // P0-4：工具批执行——连续只读工具并发（Promise.all），写/执行类单独串行；
  // 结果按模型调用顺序收集（tool_result 与 toolCall 一一对应，Anthropic 要求）
  async function runToolBatchInner(blocks, ctx) {
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

  // 工具批执行的**唯一入口**（主循环与子 lane 都走它）：在飞登记 + 转调上面那个纯执行体。
  // 为什么在这里登记而不是在 tools.mjs：这是"一次工具调用"的句柄——进出成对、且覆盖
  // 全部工具（含并发批次），比按工具类型各记一份更难漏。心跳据此自报在飞工作数。
  // 释放放 finally：`executeToolUse` 内部抛错不会中断轮次（已就地兜底），但真有未知
  // 异常时计数必须回卷——否则计数泄漏会让心跳永远自报"在忙"（虽然那条路另有
  // ACTIVITY_BUSY_MAX_MS 兜底，但计数本身先要诚实）。
  async function runToolBatch(blocks, ctx) {
    const n = Array.isArray(blocks) ? blocks.length : 0
    if (n > 0) {
      activityState.toolsInFlight += n
      activityState.toolNames = blocks.map((b) => b?.name).filter(Boolean)
      activityState.toolStartedAt = Date.now()
    }
    try {
      return await runToolBatchInner(blocks, ctx)
    } finally {
      if (n > 0) {
        activityState.toolsInFlight = Math.max(0, activityState.toolsInFlight - n)
        if (activityState.toolsInFlight === 0) activityState.toolNames = []
      }
    }
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

  // ★ P2b（2026-10-15，用户裁决 1+3）：输入动作（Screen 的真实键鼠）的**运行级授权记忆**。
  //   与 `deniedCatastrophicFamilies` 同处声明/重置（不新造生命周期）：一次运行 = 一次
  //   `runTurnInternal`，跨运行清零 ⇒ 每次运行都会重新询问一次。
  //   语义：**只有用户真的批准过**才为 true（见 gateToolUse 的 allow 路径）；拒绝/超时保持 false。
  let screenInputApprovedThisRun = false

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
    // ★ P2b（2026-10-15）：输入类动作"一次运行只问一次"——本次运行内**用户已批准过** ⇒ 把这条
    //   `ask` 降级成 `allow` 继续走（不再打扰用户；裁决 3："每批次运行只询问一次，不要每个动作都问"）。
    //   ★ 只在 `screenInputApprovedThisRun` 为真时降级，而它**只在用户批准后**置位（见下方 ask 分支）
    //     ⇒ 拒绝/超时不会走到这里 —— 拒绝不会被当成放行。
    //   ★ **不能 `return { allowed: true }`**：那会跳过下方 `hooks.preToolUse`，于是"本次运行内
    //     第二次以后的输入动作"绕过 hook 否决 —— 第二次之后反而比第一次更宽松，与"只减少询问
    //     次数、不降低约束"的意图相反。故这里只改 `decision`，让流程继续往下走。
    //   ★ 不复用 `hard`：hard 每次都问且弹灾难级警示条，与"一次运行一次"冲突。
    if (perm.decision === 'ask' && perm.askOncePerRun && screenInputApprovedThisRun) perm.decision = 'allow'
    // ★★ 2026-10-18 ENG-04：**循环任务放行白名单** —— 把 ask 降级为 allow。
    //
    // 场景：循环任务无人值守跑几十个工具，而审批逐次挂起等应答 ⇒ 卡在第一个 `app_*`
    // 或高危命令上。白名单内（由循环任务显式声明）直接放行，白名单外照旧逐次审批。
    //
    // ★ 必须排除 `perm.hard`：灾难命令（硬黑名单）**永不**自动放行 —— 否则一个"自动化可用性"
    //   开关就把 AI-02/AI-03 建的安全闸门整片关掉。（`canLoopAutoApprove` 内部也再判一次，双保险。）
    // ★ 用 `perm.decision = 'allow'` 而**不是** `return { allowed: true }`：后者会跳过下方
    //   `hooks.preToolUse`，使白名单内工具**绕过 hook 否决** —— 与上方 askOncePerRun 同一理由。
    if (perm.decision === 'ask' && canLoopAutoApprove({ allowlist: loopAllowlist, toolName: toolUse.name, hard: perm.hard })) {
      perm.decision = 'allow'
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
      // ★ P2b（2026-10-15）：**用户真的批准了**才置位运行级记忆（位置要紧）。
      //   上面的 `if (decision?.behavior !== 'allow')` 已经吃掉了拒绝/超时两条路
      //   ⇒ 走到这里只可能是 `behavior === 'allow'`。拒绝不得置位，否则"拒绝"会被
      //   当成"放行"（下一次同类输入就静默发出去了）—— 这正是本行必须放在此处而非
      //   放在 ask 分支入口的原因。
      if (perm.askOncePerRun) screenInputApprovedThisRun = true
    }
    // hooks.preToolUse：可否决。deny → 工具不执行，错误回填给模型。
    const hooks = opts.hooks
    if (hooks) {
      const h = await hooks.run('preToolUse', { toolName: toolUse.name, toolUseId: toolUse.id, input: toolUse.input })
      if (h.deny) return { allowed: false, message: h.message || `PreToolUse hook 拒绝执行 ${toolUse.name}` }
    }
    return { allowed: true }
  }

  /**
   * 工具执行上下文（S2.1 类型面补登记）：主循环注入 spawnSubAgent/taskSystem/browserDriver，
   * 子 lane 循环注入 lane/store/laneOptions（禁嵌套分发）。全部可选——两侧各自只传自己那组。
   * @typedef {{ spawnSubAgent?: any, taskSystem?: any, browserDriver?: any, appRunner?: any, lane?: any, store?: any, laneOptions?: any, toolUseId?: string, signal?: any }} ToolExecCtx
   */
  // wire 帧序号：每 tool_use_id 从 1 递增（合帧器的 seq 是"合帧序号"，
  // 一次合帧可能拆成 2 帧，不能直接当 wire seq —— review-01 建议 7）
  const wireSeqByTool = new Map()
  const nextWireSeq = (id) => {
    const n = (wireSeqByTool.get(id) ?? 0) + 1
    wireSeqByTool.set(id, n)
    return n
  }
  /** 命令首行（终端段的标题用）：多行命令只取首行，超长截断。空/非字符串 ⇒ ''（帧里就不带该键）。 */
  const firstLineOf = (v) => {
    const s = String(v ?? '').trim().split('\n')[0].trim()
    return s.length > 120 ? `${s.slice(0, 117)}…` : s
  }
  /** @param {any} toolUse @param {ToolExecCtx} [ctx] */
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
    // 2026-09-21（长任务可靠性 P1 Task 8）：
    // ① 分级：Agent/OCR/Workflow 走长档；Bash 显式声明 timeout_ms 时 deadline 让位于它
    //    （否则 Task 6 让 timeout_ms 可到 30min 也白配 —— deadline 会先砍）。
    // ② 超时**真取消**：本次调用独占 controller，超时只 abort 它；**不能**用整批共享的
    //    signal（那会连坐同批其它工具）。父 signal 的取消照常向下传播。
    const toolDeadlineMs = deadlineForTool(toolUse.name, toolUse.input)
    const toolCtl = new AbortController()
    const parentSignal = toolCtx.signal
    const onParentAbort = () => toolCtl.abort()
    if (parentSignal) {
      if (parentSignal.aborted) toolCtl.abort()
      else parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }
    let r
    try {
      r = await withToolDeadline(
        tools.run(toolUse, { ...toolCtx, signal: toolCtl.signal, toolUseId: toolUse.id, browserDriver: runBrowser, screenDriver: runScreen, appRunner: runApp, vaultDriver: runVault,
          // ★ 终端增量通道（2026-10-28 Task 4b）：工具的 UI 增量输出只经 wire 发出，
          //   **不参与** tool_result 的 content（上下文/transcript 零变化）。
          // ★ 2026-10-29：多带 `tool` / 首行 `command` 两个**可选**字段 —— GUI 靠它们把
          //   同一会话的多条命令拼成一条流并画段分隔。它们只进 wire，不进 transcript。
          onToolOutput: (f) => {
            const id = toolUse.id
            const seq = nextWireSeq(id)          // ★ wire 帧序号，不是合帧器的 f.seq
            const tag = { tool: String(toolUse.name || ''), command: firstLineOf(toolUse.input?.command) }
            if (f.stdout) wire.toolOutputDelta({ toolUseId: id, seq, stdout: f.stdout, truncated: f.truncated === true, ...tag })
            if (f.stderr) wire.toolOutputDelta({ toolUseId: id, seq, stderr: f.stderr, truncated: f.truncated === true, ...tag })
            // 空截断帧（用户裁定保留）：字段全空但 truncated ⇒ 唯一信号，必须发
            if (!f.stdout && !f.stderr && f.truncated) wire.toolOutputDelta({ toolUseId: id, seq, truncated: true, ...tag })
          },
          // ★ P2b（2026-10-15）：**显式授权证据**（不是"要不要问"的派生）。
          //   executor 闸据此决定是否构造输入命令 —— 于是它检查的是"内核是否为这次调用
          //   给出了授权"，而 ps1 闸检查"命令是否带授权标记且未被强制拒绝"，两者**不同**。
          //   `isInputAct` 用契约真源（只读 act 恒为 false）；记忆为假（未批准/被拒/超时）也恒为 false。
          screenInputAuthorized: isInputAct(toolUse.input?.action) && screenInputApprovedThisRun }),
        toolDeadlineMs,
        () => toolCtl.abort(),
      )
    } finally {
      parentSignal?.removeEventListener?.('abort', onParentAbort)
    }
    // P0-3：大结果落盘到目标会话目录（子 lane 独立 store）。Read 例外：Read 返回的
    // 就是模型显式索要的文件内容（≤2000 行/2MB，超界文件已由 Read 自身引导 offset/
    // limit），落盘替换成 stub 会让"读大源文件"只见预览 + 引导补读，模型被迫小段
    // offset/limit 重读（用户侧表现为工具"输出被落盘"、反复续读），且补读 stub 文件
    // 又触发二次落盘 → 迭代空转。故 Read 结果保持内联，其余工具（Bash 等）大输出
    // 照常落盘 + stub 补读（路径已并入边界，见 createEngine toolResultsDir）。
    if (r && typeof r === 'object' && typeof r.content === 'string') {
      if (toolUse.name === 'Read') { /* Read 结果内联，不落盘替换 */ }
      // ★ 2026-10-22：Vault 的 get 回执含密码明文 ⇒ **绝不落盘**（persistToolResult 会把
      //   超阈值正文写进 <sessionDir>/tool-results/ 并只留预览）。宁可让超大结果内联进
      //   上下文，也不能把明文密码落成文件（"明文不写盘"是密码库的核心承诺）。
      else if (toolUse.name === 'Vault') { /* 密码库结果内联，不落盘替换 */ }
      else r.content = persistToolResult(store || session, toolUse.id, r.content)
    }
    // hooks.postToolUse：工具结果后触发（output 截断 8KB；不阻塞主流程决策）
    const hooks = opts.hooks
    if (hooks) {
      try {
        await hooks.run('postToolUse', {
          toolName: toolUse.name,
          toolUseId: toolUse.id,
          input: hookInputOf(toolUse.name, toolUse.input),
          // ★ 2026-10-22：Vault 结果可能含明文，不交给用户钩子（钩子常做通知/上报，
          //   等于给密码开一条出站通道）。钩子仍能看到"调用了 Vault"与入参。
          output: toolUse.name === 'Vault' ? '' : (typeof r?.content === 'string' ? r.content.slice(0, 8192) : ''),
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
      // ★ 必须包 try/catch（2026-11-01）：stdout/桥已断时 bridgeRequest 会抛，异常从 Promise
      //   executor 冒出 ⇒ ① 这条 requestId 留在 browserWaiters 里直到 120s 超时才删；
      //   ② clearTimeout 执行不到、timer 白挂；③ 工具层拿到的是异常而不是结构化回执
      //   （文案退化成"工具执行异常：…"）。同族 runScreen/runApp/runVault 三处都已有这层，
      //   只有 browser 漏了 —— 属契约漂移，照它们的写法补齐。
      try {
        wire.bridgeRequest({ route: 'browser', requestId, payload: { action, params } })
      } catch (e) {
        browserWaiters.delete(requestId)
        clearTimeout(timer)
        resolve({ ok: false, error: `浏览器请求发送失败：${e?.message || String(e)}` })
      }
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

  // —— 像素层（P2 computeruse）：bridge_request(screen) → 主进程执行器 ——
  // 与 runBrowser 同构（发起 + 挂起 + 超时 + 桥异常兜底），差别只在路由名与回执形状。
  // 授权闸门（全屏截图需授权）与排除清单在**执行侧**（electron/main.cjs），内核只做路由。
  // ★ P2b（2026-10-15）：第三参 `opts.inputAuthorized` 是**显式授权证据**（缺省 false，
  //   **fail-closed**：拿不到证据就是没授权）——主进程据此决定是否构造输入命令。
  //   ★ 证据的**唯一来源**是引擎的运行级批准记忆（见 gateToolUse 的 allow 路径），
  //     不是 act 名字的派生 —— 那会让 executor 闸与 ps1 闸检查同一件事（同义反复）。
  /**
   * @param {any} action
   * @param {any} [params]
   * @param {{ inputAuthorized?: boolean }} [opts]
   */
  async function runScreen(action, params, opts = {}) {
    const requestId = 'sc-' + randomUUID()
    let timer
    const resp = await new Promise((resolve) => {
      screenWaiters.set(requestId, resolve)
      timer = setTimeout(() => {
        screenWaiters.delete(requestId)
        resolve({ ok: false, error: `像素层操作超时（${action}，${SCREEN_TIMEOUT_MS}ms）` })
      }, SCREEN_TIMEOUT_MS)
      if (timer.unref) timer.unref() // 超时 timer 不阻塞进程退出
      try {
        wire.bridgeRequest({ route: 'screen', requestId, payload: { action, params, inputAuthorized: opts.inputAuthorized === true } })
      } catch (e) {
        // 写 stdout 失败（桥已断）不得把挂起留到超时：立即以失败回执解除
        screenWaiters.delete(requestId)
        clearTimeout(timer)
        resolve({ ok: false, error: `像素层请求发送失败：${e?.message || String(e)}` })
      }
    })
    clearTimeout(timer)
    if (resp?.ok) {
      const body = resp.snapshot ?? resp.data ?? { ok: true }
      return { content: typeof body === 'string' ? body : JSON.stringify(body), isError: false }
    }
    // ★ 失败时把**诊断信息**一并交给模型（2026-10-15 演示中发现的真实缺陷）：
    //   `look` 找不到目标时会回吐 `seen`（实际识别到的文字）。只回 error 文本时，模型
    //   既不知道该不该重试、也不知道该换成什么词 —— "自我纠正"就无从谈起。
    //   `code` 同理：`ambiguous-window` / `element-offscreen` / `area-too-large-for-ocr`
    //   各自对应完全不同的下一步动作。
    const diag = []
    if (resp?.code) diag.push(`code=${resp.code}`)
    if (Array.isArray(resp?.seen) && resp.seen.length > 0) {
      diag.push(`识别到的文字：${resp.seen.slice(0, 15).map((t) => String(t)).join(' / ')}`)
    }
    const tail = diag.length ? `
（${diag.join('；')}）` : ''
    return { content: `像素层操作失败：${resp?.error || '未知错误'}${tail}`, isError: true }
  }

  // —— 用户密码库（2026-10-22）：bridge_request(vault) → 主进程 vault agent ——
  // 与 runBrowser/runScreen 同构（发起 + 挂起 + 超时 + 桥异常兜底），差别在路由名与回执：
  // `{ok, data, error}`，data 形如 `{entries}`（list）/ `{entry}`（get/set）。
  // ★ 审批在**主进程**（electron/vault-agent-approval.cjs），内核只负责路由与把失败
  //   如实转成工具结果。`denied` 是用户拒绝/审批超时，**不要**让模型自动重试。
  async function runVault(action, params) {
    const requestId = 'va-' + randomUUID()
    let timer
    const resp = await new Promise((resolve) => {
      vaultWaiters.set(requestId, resolve)
      timer = setTimeout(() => {
        vaultWaiters.delete(requestId)
        resolve({ ok: false, error: `timeout：密码库操作超时（${action}，${VAULT_TIMEOUT_MS}ms）` })
      }, VAULT_TIMEOUT_MS)
      if (timer.unref) timer.unref() // 超时 timer 不阻塞进程退出
      try {
        wire.bridgeRequest({ route: 'vault', requestId, payload: { action, params } })
      } catch (e) {
        // 写 stdout 失败（桥已断）不得把挂起留到超时：立即以失败回执解除
        vaultWaiters.delete(requestId)
        clearTimeout(timer)
        resolve({ ok: false, error: `密码库请求发送失败：${e?.message || String(e)}` })
      }
    })
    clearTimeout(timer)
    if (resp?.ok) {
      const body = resp.data ?? { ok: true }
      return { content: typeof body === 'string' ? body : JSON.stringify(body), isError: false }
    }
    // 错误码直接沿用主进程的枚举（denied/not_found/ambiguous/invalid/unavailable/corrupt/io），
    // 并给模型一条**可执行**的下一步 —— 只说 "error" 会让它原地重试同一个动作。
    const code = String(resp?.error || 'unknown')
    const hint = code === 'denied'
      ? '用户拒绝或未及时批准。不要重复重试；先向用户说明需要哪条凭据、为什么需要。'
      : code === 'not_found'
        ? '未找到该条目。可先用 action=list 查看现有条目。'
        : code === 'ambiguous'
          ? '同名条目不止一条。请改用 params.id 指定。'
          : code === 'invalid'
            ? '参数不合法：get 需 name 或 id；set 需 name（更新时给 id）。'
            : code === 'timeout'
              ? '审批或执行超时。可向用户确认后再试一次。'
              : ''
    return { content: `密码库操作失败：${code}${hint ? `。${hint}` : ''}`, isError: true }
  }

  // —— 应用命令执行（Task 4.x「应用即工具」）：bridge_request(app) → 主进程执行器 ——
  // 与 runBrowser 同构（发起 + 挂起 + 超时 + 桥异常兜底），差别只在路由名与回执
  // 形状：应用命令的执行结果就是 electron/app-ipc.cjs 的 app:run 回执
  //（{ok,data,error,kind,durationMs}），内核**原样**交给 app-tools.mjs 渲染成工具结果。
  // 执行侧负责留痕（browser 路径 runCommand 内建 history；desktop 路径显式 appendHistory）。
  const APP_TIMEOUT_MS = Number(process.env.PONOS_APP_TIMEOUT_MS || 300_000)
  /**
   * 入参形状与 app-tools.mjs 的 runner 契约同源（`{appId, action, args, sessionId}`）——
   * 那里有登记，此处原为**无注解的解构参数** ⇒ appId/action（无默认值的绑定）整体缺席于
   * 推断类型（TS2339）。补登记即修，无断言。
   * @param {{ appId?: string, action?: string, args?: Record<string, any>, sessionId?: string|null }} [params]
   */
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
  /**
   * 子 lane 级参数（S2.1 类型面补登记）：由 agent frontmatter 经 spawnSubAgent 归一后传入
   * （见下方 laneOptions 构造）。全部可选——未定义/空 = 全量（零回归锁①）。
   * @typedef {{ model?: string, allowedTools?: string[], allowedSkills?: string[], disallowedTools?: string[], effort?: string, inbox?: string[] }} LaneOptions
   */
  /**
   * @param {{ store?: any, sysPrompt?: string, signal?: any, onTool?: any, options?: LaneOptions, taskId?: string }} args
   *   `store` 是**必传**的独立 lane session store（子 lane 无主会话 session 概念），
   *   此处标可选仅为满足"解构形参整体可省"的写法；运行时缺失即早失败（同原语义）。
   */
  async function runSubAgentLoop({ store, sysPrompt, signal: subSignal, onTool, options = {}, taskId }) {
    let usage = {}
    let textBuf = ''
    // T0.2：lane usage 落盘锚点——本 lane **最近一条**已落 assistant 条目。子循环的
    // 多条 assistant（工具迭代轮）都**不带** usage（否则汇总求和会重复计）；usage 只在
    // 收尾（settleLaneUsage）一次性后挂到末条，与主循环 finalizeUsage 同口径
    //（engine.mjs:1048-1057）。
    let lastLaneAssistant = null
    // 本迭代累积的思考（子 lane 同口径，工厂与主循环共用 → 只有一份缓冲逻辑）。
    // 子 lane 的 thinking chunk 不上 wire（子 lane 从无实时透传），故此处只累积。
    const thinkBuf = makeThinkBuffer()
    let toolUses = 0
    const subT0 = Date.now()
    // 守卫⑥ 进展时间戳（子 lane 镜像主循环）：成功且非只读测量的工具结果落地即刷新
    let subLastProgressAt = subT0
    // 2026-09-21（P1 Task 9）：lane 与主循环同集 —— 双计时器之二（"在忙"）与超时连击
    let subLastActivityAt = subT0
    let subTimeoutStreak = 0
    let subStallHeals = 0 // ⑥ 愈合计数（恢复实质进展即清零，上限 STALL_HEAL_MAX）
    let subMeltdownHeals = 0 // ④ 熔断愈合计数（工具成功即清零，上限 MELTDOWN_HEAL_MAX）
    // P2-1①/AS1：lane 级参数（model/tools/skills 白名单）。options 未定义/空 =
    // 全量（零回归锁①）。loopModel 在 retryStream 与落盘（appendAssistant）统一使用。
    const loopModel = options?.model || model
    // 子 lane 思考落盘（2026-09-23，同主循环口径）：本迭代累积的 thinking 必须先于该迭代的
    // assistant 条目落盘，磁盘行序才等于真实时间顺序（回放据此还原展示顺序）。收口成
    // subPersistAssistant，避免 3 个收尾分支（max_tokens / 工具迭代 / 熔断）漏写——散写必然
    // 漏一处。store 是 runSubAgentLoop 的**必传参数**，故无需主循环那样的 if (store) 守卫。
    const subFlushThinking = () => {
      const { text: t, blocks } = thinkBuf.take()
      if (t || blocks.length) store.appendThinking(t, { model: loopModel, blocks })
    }
    const subPersistAssistant = (blocks, opts = {}) => {
      subFlushThinking()
      const entry = store.appendAssistant(blocks, opts)
      lastLaneAssistant = entry // T0.2：收尾 usage 的落点（见 settleLaneUsage）
      return entry
    }
    // ★ 2026-10-26：lane 的 allowedTools 是**明确圈定的刚需**，不能走按窗口裁剪的全量面。
    //   故障形态（若不这样改）：子 agent 声明 allowedTools=['mcp__x__update_slider']，而该工具
    //   恰好被全局预算裁掉 ⇒ `toolSchemasNow().filter(...)` 得到**空集** ⇒ retryStream 收到
    //   `tools: []` ⇒ 子 agent **静默失去全部工具**（下方 3238 的空集守卫也兜不住：它判的是
    //   `tools.toolNames` 全量名册，被裁的工具在那里仍然"存在"）。
    //   用不裁剪的面过滤：既保证非空（只要名字真在注册表里），也不扩大子 agent 的权限范围
    //   （仍是它自己声明的那个子集）。代价只是每个 lane 一次全量 schema 构造，且有单槽缓存。
    const laneToolSchemas = (Array.isArray(options?.allowedTools) && options.allowedTools.length)
      ? toolSchemasUncapped().filter((t) => options.allowedTools.includes(t.name))
      : null
    // 守卫命中时的收尾说明（resume 续跑提示；null = 正常运行）。stopped 标志让
    // runLaneExecution 把守卫停登记为 status='stopped'（同取消，可 resume 续跑）。
    const stopNotice = (reason, detail) =>
      `【子 Agent 任务已因${reason}自动中止：${detail}。可用 resume_task_id 让模型在既有会话上续跑。】`
    // T0.2：lane 用量收口（问0）——lane 的 usage 此前只进 taskNotification 与内存，
    // **不进 lane transcript** ⇒ `/api/usage`、`stats.mjs aggregateUsage`、
    // `trace-project.projectRecords`（kind='subagent'）里子 Agent 成本恒为 0（C_success
    // 系统性低估）。laneStore 与主会话同一 configDir、sessionId=taskId ⇒ 落盘即被
    // collectTranscriptFiles 收录，三条消费者自动正确，故**不动 sessionUsageAcc**（那是
    // 进程内轮级预算账，不是全史账）、不新增 meta kind。
    // 只挂末条 assistant（子循环的中间迭代条目**不带** usage——求和会重复计），语义同主
    // 循环 finalizeUsage 的 setEntryUsage 分支。无 assistant 条目（纯文本 lane）时 no-op。
    const settleLaneUsage = () => {
      if (!hasUsage(usage)) return
      if (lastLaneAssistant) { store.setEntryUsage(lastLaneAssistant, usage); return }
      // ★ 无 assistant 条目时的兜底（2026-10-20，T0.2 补完）：**纯文本收尾的 lane**
      //（不发工具、直接回答——"只读研究型子代理"正是这一类，explorer/researcher 常态路径）
      // 原来不落任何 assistant 条目 ⇒ usage 无处可挂 ⇒ 这类 lane 的成本在 `/api/usage` 与
      // 演化投影里**恒为 0**，而它们恰恰是子代理里最常见的一类，"落 usage"若漏了它们等于没做。
      // 做法照主循环 finalizeUsage 的文本兜底分支（engine.mjs:1048-1053）：把最终文本落盘并
      // 带上 usage。副作用是 lane transcript 从此也留最终答案（resume 时模型可见自己的上次
      // 回答）——与主会话同语义，是行为改进而非污染。
      const tail = String(textBuf || '').trim()
      if (tail) store.appendAssistant([{ type: 'text', text: tail }], { usage, model: loopModel })
    }
    const guardStop = (text) => {
      // guardStop 是 10 处守卫收尾分支（超时/停滞×2/迭代上限/空流/截断/打转/熔断…）的
      // 统一出口——收口在这里才不会漏分支。
      settleLaneUsage()
      return { usage, text, stopped: true }
    }
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
      // 2026-09-21（P1 Task 9）：lane 与主循环**同集同步**（loop-profile 要求两侧守卫逐项同集）。
      // ① 超时连击：连续多批全超时 ⇒ 不是"在忙"，而是病态循环 ⇒ 提示换策略/降规模
      if (TIMEOUT_STREAK_MAX > 0 && subTimeoutStreak >= TIMEOUT_STREAK_MAX && subStallHeals < STALL_HEAL_MAX) {
        subStallHeals++
        subTimeoutStreak = 0
        subLastProgressAt = Date.now(); subLastActivityAt = Date.now()
        appendLaneSystemUser(store, '【系统】检测到你已连续多批工具执行超时（等待无果）。这不算"在忙"：请停止继续重试同类调用，改用更小规模/更短耗时的做法（分段处理、缩小范围、调小 timeout_ms，或对长任务改用 run_in_background 后台执行），或直接输出当前进展与卡点。')
        continue
      }
      // ② 双计时器：取"实质进展"与"在忙"两者中较近的活动（原判据只看 subLastProgressAt，
      //    长工具执行期会被误判停滞；真死循环两个计时器都不刷新，仍抓得住）
      if (LOOP_STALL_MS > 0 && Date.now() - Math.max(subLastProgressAt, subLastActivityAt) >= LOOP_STALL_MS) {
        if (subStallHeals < STALL_HEAL_MAX) {
          subStallHeals++
          subLastProgressAt = Date.now()
          subLastActivityAt = Date.now()
          appendLaneSystemUser(store, '【系统】检测到你长时间没有实质进展（连续只读测量/重复调用、无新结果或文件变更）。请停止测量与重复尝试，直接执行下一步实质操作（修改文件/执行命令/完成剩余步骤），或输出最终结论。')
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
        for (const m of msgs) appendLaneSystemUser(store, `【主 Agent 消息】${m}`)
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
          const cr = await laneCompactor.maybeCompact({ system: sysPrompt, messages: laneMsgs, outputBudget: attemptMaxTokens, tools: laneToolSchemas ?? toolSchemasNow() })
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
      // K1.3：同主 loop，惰性提供者（lane 路径）。K1.3b：同主 loop 补上游等待心跳——
      // 子 lane 的长静默同样会让桥把整个会话判成失速（静默是 session 级判据）。
      const watchdog = makeIdleWatchdog(STREAM_IDLE_MS, () => adaptiveFirstByteMs(() => patchOrphanToolUses(store.deriveMessages()), STREAM_FIRST_BYTE_MS), {
        onWait: ({ elapsedMs, windowMs }) => { try { wire.system('upstream_wait', { elapsed_ms: elapsedMs, window_ms: windowMs }) } catch { /* 心跳失败不影响请求 */ } },
      })
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
        for await (const chunk of retryStream({ model: loopModel, messages: msgs(), maxTokens: attemptMaxTokens, signal: streamSignal, tools: laneToolSchemas ?? toolSchemasNow(), reasoningEffort: normalizeEffort(options?.effort || 'auto') })) {
          if (signal.aborted || subSignal.aborted) throw abortError()
          watchdog.tick()
          streamProduced = true
          if (chunk.type === 'text') {
            textBuf += chunk.text
            genWindow = (genWindow + chunk.text).slice(-400)
          } else if (chunk.type === 'thinking') {
            thinkBuf.push(chunk.text)
            genWindow = (genWindow + chunk.text).slice(-400) // thinking 参与③检测窗，不入摘要
          } else if (chunk.type === 'thinking_block') {
            // 完整思考块（含 signature）：落盘/回放用（主循环同款，见 flushThinking）
            thinkBuf.pushBlock({ type: 'thinking', thinking: chunk.thinking, signature: chunk.signature })
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
          appendLaneSystemUser(store, inject)
          continue
        }
        return guardStop(stopNotice(subStop.reason === 'gen-repeat' ? '生成内容重复打转' : '生成内容近似打转', subStop.detail))
      }
      // P0-2（子 lane 镜像）：输出被 max_tokens 截断且已产出工具调用 → 不执行残缺参数，
      // 注入 is_error tool_result 提示模型补全重发（主循环同款保护，防子 lane 复活缺陷）
      if (blocks.length > 0 && (subStopReason === 'length' || subStopReason === 'max_tokens')) {
        const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
        subPersistAssistant(assistantBlocks, { model: loopModel })
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
          appendLaneSystemUser(store, inject)
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
          appendLaneSystemUser(store, inject)
          textBuf = ''
          continue
        }
        break
      }
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      subPersistAssistant(assistantBlocks, { model: loopModel })
      // P0-4：子 lane 同样走只读并发批；结果按模型顺序收集
      const executed = await runToolBatch(blocks, { lane: true, store, laneOptions: options, signal: rawAbortSignal(subSignal) || rawAbortSignal(signal) })
      const toolResults = blocks.map((b, i) => ({
        tool_use_id: b.id,
        content: executed[i]?.content ?? '',
        is_error: executed[i]?.isError === true,
        // 2026-09-21（P1 Task 9）：与主循环同口径透传超时标记（子 lane 守卫同步进化）
        timeout: executed[i]?.meta?.timeout === true,
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
      // 2026-09-21（P1 Task 9）：双计时器与超时连击（口径与主循环完全一致）
      const laneActivity = hasActiveWait(toolResults)
      if (allToolsTimedOut(toolResults)) subTimeoutStreak += 1
      else if (laneProgress) subTimeoutStreak = 0
      if (laneProgress) { subLastProgressAt = Date.now(); subLastActivityAt = Date.now(); subStallHeals = 0 }
      // "在忙"（有工具超时结束）只续活跃计时器，**不清** subStallHeals（口径同主循环）
      else if (laneActivity) subLastActivityAt = Date.now()
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
          appendLaneSystemUser(store, repeatRemindText(subRepeatStreak, blocks[0].name))
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
          appendLaneSystemUser(store, errorMeltdownText('lane'))
          continue
        }
        const meltdownNotice = stopNotice(
          '连续工具调用全部失败',
          `连续 ${subErrorStreak} 轮工具调用全部失败，已自动收尾停止重试。请检查失败原因（权限/环境/参数）后重新发起。`,
        )
        // 收尾说明同主循环 loopStop 文案落会话：追加进子 lane 转录，resume_task_id 续跑
        // 时模型可见停止原因（r.text 亦带同文案，经 task_notification.summary 交付）
        subPersistAssistant([{ type: 'text', text: meltdownNotice }], { model: loopModel })
        return guardStop(meltdownNotice)
      }
      textBuf = ''
    }
    subFlushThinking() // 子 lane 轮末兜底（末迭代只产思考未产文本时仍须落盘）
    settleLaneUsage() // T0.2：正常收尾（文本迭代不落 assistant 条目 ⇒ 挂末条工具轮）
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
    // 2026-09-21（长任务可靠性 P0）：子任务收口 → 通知宿主，由宿主决定是否唤醒主 agent。
    // 为什么单独给宿主回调、而不是复用 taskNotification：那只是 wire 帧（喂 UI 的任务卡片），
    // 唤醒需要宿主掌握 state.turnActive 才能判断"该不该拉起新一轮"（见 kernel/auto-wake.mjs）。
    // 前台子任务收口同样会走到这里 —— 由宿主侧 shouldAutoWake 按 turnActive 过滤（轮内不唤醒）。
    try { opts.onBackgroundFinished?.({ taskId, status, summary: text, outputFile, kind: 'subagent' }) } catch { /* 通知失败不得影响收口 */ }
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
      // 证据面接线（Task 3）：resume 也要让该 lane 的 transcript 可读——resume 是唯一
      // 能再次触达既有 lane 的入口（spawn 分支的登记只覆盖新建 lane）。Set 去重，
      // 同一 lane 反复 resume 无副作用。
      tools.addReadAllowFiles([target.laneStore.file])
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
    // 演化P0·P-d 血缘埋点：lane 转录落一条 subtask_meta（与内存 lineage 同源，字段逐字
    // 一致）——投影器据此判 kind='subagent' 与 parentTaskId（主转录不写）。放在
    // addReadAllowFiles 之前、开跑前，保证"lane 有转录 = 有血缘行"。
    try { laneStore.appendMeta('subtask_meta', { parentTaskId: lineage.parentTaskId, depth: lineage.depth, path: lineage.path }) } catch { /* 血缘埋点失败不阻断派发 */ }
    // 证据面接线（Task 3）：lane transcript 纳入 Read 只读白名单——主 Agent 可据
    // task_notification.transcript_path 用 Read offset/limit 精确展开子 Agent 过程，
    // 不必让子 Agent 把细节"说"一遍（低带宽有损编码 → 无损引用）。
    // 登记在 lane 落盘路径建立之后、开跑之前；resume 分支同样登记（见上）。
    tools.addReadAllowFiles([laneStore.file])
    // B1 上下文继承档（2026-09-11）：none（默认，现状）| summary（压缩摘要 + 最近
    // 20 轮文本）| full（最近 200 条全量文本）。继承内容为纯文本投影（剥离
    // tool_use/tool_result 块，避免半截消息链破坏 API 合法性），先于任务指令入 lane。
    const inherit = String(input?.context || 'none')
    if (inherit !== 'none' && session) {
      const hist = session.deriveMessages()
      const src = inherit === 'full' ? hist.slice(-200) : hist.slice(-20)
      if (inherit === 'summary') {
        const last = compactor?.lastSummary?.()
        if (last) appendLaneSystemUser(laneStore, `<compacted-summary>${String(last).slice(0, 4000)}</compacted-summary>\n（主会话历史摘要；需要细节时向主 Agent 询问或 Read 相关文件）`)
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
    let sysPrompt = withLaneSkillCatalog(
      agent.systemPrompt || `你是 Ponos 的子 Agent「${agent.name}」：${agent.description}。使用简体中文。`,
      { agentSkills: agent.skills, skillIds: opts.skillIds },
    )
    // P1.1：子代理 lane 追加项目地图（L0+L1，独立预算）。由 cli 经 opts.atlasLanePrompt
    // 注入；求值失败/空串一律不阻断 lane（Atlas 是增强面，不是 spawn 的前置条件）。
    try {
      const atlasText = typeof opts.atlasLanePrompt === 'function' ? opts.atlasLanePrompt() : opts.atlasLanePrompt
      sysPrompt = withLaneAtlasPrompt(sysPrompt, atlasText)
    } catch { /* Atlas 注入失败不影响子代理启动 */ }
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
    // 2026-09-21（长任务可靠性 P1）：前台任务同样登记 —— 否则外层工具 deadline
    // （PONOS_TOOL_TIMEOUT_MS=300s）抢答返回后，子 lane 仍在跑却查不到/停不了/续不了
    // （taskSystem 全部方法都走 pendingSubAgents.get），槽位还要等 exec() 真正结束才释放。
    // ★ status 必须 'running'：taskSystem 的 stop/output/sendMessage/resume 都以它为前提；
    // ★ 必须带 _foreground：runningCount() 已用 foregroundRunning 计过前台任务，
    //   不标记会双重计数（后台并发预算减半）。登记点放在取槽后，与 foregroundRunning 对齐。
    const fgEntry = {
      status: 'running',
      promise: null,
      laneStore,
      sysPrompt,
      lineage,
      laneOptions,
      inbox,
      stop: () => subController.abort(),
      _foreground: true,
    }
    pendingSubAgents.set(taskId, fgEntry)
    let r
    try {
      fgEntry.promise = exec()
      r = await fgEntry.promise
    } finally {
      // 前台是同步语义：收口即清出（后台保留终态条目，供 output/resume 复用）
      pendingSubAgents.delete(taskId)
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
    // 像素层挂起同款处理（P2a）：取消/打断必须立刻解除，否则模型侧工具边界要等到超时
    for (const [id, resolve] of [...screenWaiters]) {
      screenWaiters.delete(id)
      resolve({ ok: false, data: null, error: '已取消' })
    }
    // 密码库挂起同款处理（2026-10-22）：取消/打断必须立刻解除
    for (const [id, resolve] of [...vaultWaiters]) {
      vaultWaiters.delete(id)
      resolve({ ok: false, data: null, error: '已取消' })
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
    toolSchemas: () => toolSchemasNow(),
    // deferred（按需加载）工具名 —— **提示词必须投递这份名单**：不投名字，模型永远不知道
    // 有这些工具可用（等于真删掉）；投 schema，前缀又被撑满。名字是唯一正确的粒度。
    deferredToolNames: () => (typeof tools.deferredToolNames === 'function' ? tools.deferredToolNames() : []),
    // workflow 引擎依赖注入：registry 暴露给工作流 tool/document 节点
    tools,
    // subagent 体系：Agent/Task 工具能力 + 后台任务登记
    spawnSubAgent,
    /**
     * 当前活跃的后台子代理任务快照（SESS-08）—— **纯读、零副作用**。
     *
     * ★ 为什么只提供"读"、不在这里写盘：
     *   第一版把登记（appendFileSync）直接放在派发/终态热路径上，实测让
     *   `subagent.test.mjs` 的「主 cancel」用例在 Windows 上**稳定 EPERM**
     *   （多出的磁盘 IO 改变了 cleanup 与子代理收尾的相对时序；改 setImmediate 也仍回归）。
     *   还原 engine 后该用例 20/20 通过 ⇒ 结论是**热路径上不要加任何 IO 或额外调度**。
     *   ⇒ 由 CLI 侧定时/退出时取这份快照再落盘（见 `kernel/subagent-resume.mjs`）。
     *
     * @returns {{taskId: string, status: string, laneOptions?: object}[]}
     */
    snapshotActiveSubAgents: () => {
      const out = []
      try {
        for (const [taskId, e] of pendingSubAgents.entries()) {
          if (!e || (e.status !== 'running' && e.status !== 'queued')) continue
          out.push({
            taskId,
            status: e.status,
            ...(e.laneOptions ? { laneOptions: e.laneOptions } : {}),
          })
        }
      } catch { /* 纯读，失败即返回空（绝不影响调用方） */ }
      return out
    },
    // 并发上限（供恢复侧复用同一套槽位，不新造参数）
    laneMaxConcurrent: LANE_MAX_CONCURRENT,
    /** 当前正在跑的后台任务数（供恢复侧判断并发）—— 纯读 */
    runningSubAgentCount: () => {
      try { return runningCount() } catch { return 0 }
    },
    taskSystem,
    pendingSubAgents,
    // 2026-09-21（长任务可靠性 P0）：后台子任务活跃数 —— 供 cli 的 EOF 退出判据使用。
    // 不暴露它的话，stdin 关闭时会把仍在跑的后台子任务一起清掉，
    // "任务完成 → 自动唤醒内核"的链路就永远等不到（spec §4.4b-1）。
    pendingSubAgentsRunningCount: runningCount,
    // 2026-09-21（P1 Task 7）：存活的后台 Bash 数 —— 同理，供 cli 的 EOF 退出判据使用
    // （否则退出会把后台命令一起杀掉，"完成 → 唤醒"链路永远等不到）。
    pendingBackgroundBashCount: () => bgBashAliveN,
    // 2026-09-21（长任务可靠性 P2）：活性快照 —— 供 cli 的 `system/activity` 心跳读取，
    // 让外围看门狗把"在忙（有活在飞）"与"真失活（零输出且零在飞）"分开。
    // 只报**可证伪的计数**：phase 由 cli 推（它手上才有 isAwaitingUser），本处不下"我还活着"
    // 这类自评——自评不可证伪，等于把门禁交给被守护者。
    activitySnapshot() {
      const nowMs = Date.now()
      const tools = activityState.toolsInFlight
      const lanes = runningCount()
      const bgBash = bgBashAliveN
      return {
        inflight: { tools, lanes, bg_bash: bgBash, total: tools + lanes + bgBash },
        tool_name: activityState.toolNames[0] || '',
        tool_ms: tools > 0 && activityState.toolStartedAt > 0 ? nowMs - activityState.toolStartedAt : 0,
        turn_ms: activityState.turnStartedAt > 0 ? nowMs - activityState.turnStartedAt : 0,
      }
    },
    // Agent 工具被禁用时（--disallowedTools Agent）子 Agent 区块不入提示词
    agents: opts.disallowedTools?.includes('Agent') ? [] : agents,
    setSystemPrompt(p) { systemPrompt = p || '' },
    // loop --fresh：请求面从当前消息条数起裁剪（transcript 继续记录）
    setFreshWindow,
    // loop --until 模型判定：小 maxTokens 无工具请求，判定目标是否达成
    // 返回 { done, reason, error }（error=true 时 done 恒 false，cli 据此停 loop）
    async judgeUntil({ target, maxTokens = 512, signal: s = signal }) {
      // ★★ 2026-10-18 ENG-03 修复：判词改用**全量历史**（`deriveFullHistory()`），不再用
      //   `deriveHistory()` —— 后者会应用 `--fresh` 的 `historySkip` 裁剪，导致第 2 轮起
      //   判词看不到上一轮目标与产出：
      //     · 目标其实已达成 → 判"未达成" → **无限循环烧预算**
      //     · 或误判"已达成" → 提前收口
      //   组装逻辑抽到 `kernel/loop-judge.mjs`（纯函数，可做真行为测试而非扫源码）。
      const judgeMsgs = buildJudgeMessages({ history: deriveFullHistory(), target })
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
        // ★ 错误分支也要带 `raw`：`cli.mjs` 的健康判定会读 `j?.raw`（`reason || raw`），
        //   两个分支返回形状不一致会让 tsc 报联合类型上不存在 `raw`（TS2339）。
        //   统一形状比在各消费方加 `'raw' in j` 判断更稳。
        return { done: false, reason: `判定请求失败：${err?.message || String(err)}`, error: true, raw: '' }
      }
      return parseJudgeOutput(out)
    },
    // 思考深度热设置（cli control_request reasoning_effort）：返回规范化档位 + 生效 effort
    setReasoningEffort(value) { return applyReasoningEffort(value) },
    // 循环模式（2026-10-06 三层升级）热设置（cli control_request loop_mode）：
    // 返回 { ok, value, selected, effective }——非法值 ok:false 且**不改档**（rejected
    // 由 cli 上报）；生效点 = 下一轮 runTurnInternal 轮首（钉住立即改 effective）。
    setLoopMode(value) { return applyLoopMode(value) },
    getLoopMode() { return getLoopModeState() },
    // 路由模型热切换（cli control_request router_model）：空串 = 回落当前激活模型
    setRouterModel(value) { return applyRouterModel(value) },
    getRouterModel() { return routerModel },
    // 审批档位热设置（cli control_request approval_mode）：返回生效档位（非法值回落默认档）。
    // 下一轮工具调用的 gateToolUse 即读取新值；已挂起的审批不受影响。
    setApprovalMode(value) { approvalMode = normalizeApprovalMode(value); return approvalMode },
    getApprovalMode() { return approvalMode },
    // ★ 2026-10-18 ENG-04：循环任务放行白名单的启停（循环控制器在轮次开始启用、结束时清空）。
    //   默认空 = 不放行；灾难命令（perm.hard）永不因白名单放行（见 loop-approval.mjs）。
    setLoopAllowlist,
    getLoopAllowlist,
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
    // cli 的 screen_response 路由（bridge 回写）：解除像素层挂起（P2a）
    resolveScreen(requestId, resp) {
      const w = screenWaiters.get(requestId)
      if (w) {
        screenWaiters.delete(requestId)
        w(resp)
      }
    },
    // cli 的 vault_response 路由（bridge 回写）：解除密码库挂起（2026-10-22）
    resolveVault(requestId, resp) {
      const w = vaultWaiters.get(requestId)
      if (w) {
        vaultWaiters.delete(requestId)
        w(resp)
      }
    },
    // 应用命令执行能力对外暴露：kernel/cli.mjs 的 app-tools runner 需要它
    //（与 Browser 工具经 ctx.browserDriver 拿 runBrowser 同理，只是应用工具在
    //  cli 侧建表，故走引擎实例方法而不是工具 ctx）。
    runApp,
    // P8 排队插话：cli 在 turnActive 时吸收 next 消息入队并回发 command_lifecycle
    // `system`：内容非用户发言（cli 自动触发工作流结果等）→ transcript entry 打系统提示
    // 标记（展示层静默，模型上下文不变）。缺省 false = 真用户插话（照旧用户可见）。
    queueNext(content, uuid, { system = false } = {}) {
      pendingNext.push({ content: String(content ?? ''), uuid, system: system === true })
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
      // 轮起点 user 条目：msg.systemInjection（cli 兜底 drain 的系统来源插话，见 cli.mjs
      // pendingNext 兜底）→ 打系统提示标记；真用户轮照旧不打标。
      // ★ 2026-10-30：kind（如 'resume' = 用户点「继续」）决定展示层是否白名单显示——模型侧语义不变。
      if (session) session.appendUser(String(content ?? ''), msg?.systemInjection === true ? systemInjectExtra(msg?.systemInjectionKind) : {})
      else pushMemory({ role: 'user', content: String(content ?? '') })
      let outcome
      try {
        const { usage, model: turnModel, text, lastUsage, cache, toolDigest, assistantTexts, guard: turnGuard, loopMode: turnLoopMode } = await runTurnInternal({ content })
        outcome = { usage, model: turnModel, text, lastUsage, cache, toolDigest, assistantTexts, guard: turnGuard, loopMode: turnLoopMode }
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
        // ★★ 2026-10-18 AI-04 修复（两处）：
        //
        // ① **不再 pushMemory 错误文本**。
        //    原来这里 `pushMemory({ role:'assistant', content:'【系统】本轮执行出现内部错误…' })`
        //    —— 在**非 session 模式**下 pushMemory 会把这条错误串写进对话记忆，
        //    于是下一轮模型会把它当成"自己刚才说过的话"，越错越偏（错误自我强化）。
        //    错误是**事件**，不是**内容**：只需要 wire.assistant 让 GUI 看见，
        //    不应进入上下文。transcript 权威源仍可通过 health/日志回溯。
        //
        // ② **outcome 必须带 isError / errorKind**。
        //    原来故障轮的 outcome 与正常轮结构相同（只多了段错误文本），下游
        //    （GUI 状态、用量统计、诊断、OPP 演进环）无法区分"模型回答了"与"本轮崩了"。
        //    实测后果：演进环把故障轮当成正常轮参与统计，错误率被稀释。
        //    ⇒ 显式打标，且 `text` 仍保留错误文本（既有消费方按文本展示的行为不变）。
        try { wire.assistant([{ type: 'text', text: errText }]) } catch { /* 事件流异常不再掩盖原错误 */ }
        outcome = {
          usage: null,
          model: opts.model || process.env.PONOS_MODEL || '',
          text: errText,
          // ★ 故障标记：下游据此区分"正常回答"与"本轮失败"
          isError: true,
          errorKind: e?.name === 'TimeoutError' ? 'timeout' : (e?.name || 'internal'),
          errorMessage: errMsg.slice(0, 500),
        }
      }
      const durationMs = Date.now() - t0
      // turnStats 每轮尾部产出（health/result/stats 共用）。lastUsage = 本轮最后一次
      // 单请求 usage（health 水位信号；usage 为轮级合计，仅成本/计费口径）
      // loopMode（2026-10-06 三层升级）：本轮模式结算快照（selected/effective/router/governance）。
      // 内部错误轮无 outcome.loopMode ⇒ 用闭包现值兜底（如实快照，不是造数）。
      // cache = 本轮 per-request 前缀缓存观测快照（内部错误轮为 null）。
      turnStats.push({ usage: outcome.usage, lastUsage: outcome.lastUsage ?? null, durationMs, model: outcome.model, ts: new Date().toISOString(), compactCount: session ? session.compactCount() : 0, guard: outcome.guard ?? collectGuardState(), cache: outcome.cache ?? null, loopMode: outcome.loopMode ?? { ...getLoopModeState(), router: null, governance: null },
        // ★ AI-04：把故障标记带进轮次统计 —— 否则用量/健康度/演进环会把"本轮崩了"
        //   当成"模型正常回答"计入，错误率被稀释（真实故障看起来像正常波动）。
        ...(outcome.isError ? { isError: true, errorKind: outcome.errorKind ?? 'internal' } : {}),
      })
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
      // ── 阶段收尾的过程文件归集（待办 860）─────────────────────────────────
      // 位置刻意选在 `wire.result` **之前**：这样"收到 result 事件 ⇒ 归集已完成"成为
      // 可断言的时序（集成测试无需 sleep/轮询撞运气），且归集不会与结果事件交错。
      //
      // 三条闸门同时成立才动（**宁可少清理，不可误删**）：
      //   ① 本轮真的干了活（有工具调用）——纯问答轮次里出现"已完成"三个字不该触发文件搬动；
      //   ② 模型文本是**收尾语**——复用守卫的 isClosedOut（已完成/以下是…/请确认…），
      //      不另写一套"什么算收尾"的判据（两份判据必然漂移）；判据本身含"收尾语之后
      //      不再出现计划尾巴"，故"打算收尾但还在计划"的轮次不会被误判；
      //   ③ 本实例允许 + 有项目根（见 createEngine 的 processHygieneEnabled）。
      // 失败只打一行 stderr（与 [el1] 同款：结构化日志，不碰 stdout 协议面），
      // 归集是收尾的副作用，绝不允许它影响本轮结果或阻断会话。
      if (processHygieneEnabled && Array.isArray(outcome.toolDigest) && outcome.toolDigest.length > 0) {
        // 只取**本轮最终文本**（`outcome.text`），不拼 assistantTexts（本轮的中间文本）：
        // `isClosedOut` 看的是**末尾 300 字符**里有没有收尾语，而 assistantTexts 是**更早**
        // 的中间文本——把它接在后面会把窗口挪离真正的收尾声明，结论变成"看中间话说了什么"。
        // 收尾 = "本轮最后说的话是收尾语"，语义上就该只看最终文本。
        if (isClosedOut(String(outcome.text ?? ''), isPlanTail)) {
          try {
            const { collectProcessArtifacts } = await import('./process-hygiene.mjs')
            // 调用点断言：projectRoot / phase（无默认值的绑定）整体缺席于 callee 的推断参数类型，
            // 但二者都是 callee 运行时**实际接收项**（它就以 projectRoot 判 `!projectRoot`）。
            // 其 JSDoc 未登记（callee 缺口，正式补全归 kernel/process-hygiene.mjs 的逐文件清零任务）。
            const h = await collectProcessArtifacts(/** @type {Parameters<typeof collectProcessArtifacts>[0] & { projectRoot?: string|null, phase?: string }} */ ({ projectRoot: processHygieneRoot, phase: processHygienePhase, source: 'kernel-closeout' }))
            if (h?.collected?.length) {
              try { process.stderr.write(`[process-hygiene] ${JSON.stringify({ phase: h.phase, dir: h.dir, collected: h.collected.map((c) => c.from) })}\n`) } catch { /* 日志失败不阻断 */ }
            }
          } catch (e) {
            try { process.stderr.write(`[process-hygiene] collect failed: ${e?.message || String(e)}\n`) } catch { /* 同上 */ }
          }
        }
      }
      // result 事件由 engine 发出（含 duration_ms；cli 不再重复 emit）
      wire.result(outcome.usage, { duration_ms: durationMs })
      // toolDigest（2026-09-14 loop 运行时接线，只增字段）：loop 控制器的轮次无进展
      // 指纹与 filesChanged/步数累计依赖本轮的"工具结果指纹"（outcome 内部已有）。
      // 非工具轮/内部错误轮可能没有该字段 → 统一归一为空数组，消费方无需再判类型。
      return {
        usage: outcome.usage, model: outcome.model, text: outcome.text, durationMs,
        toolDigest: Array.isArray(outcome.toolDigest) ? outcome.toolDigest : [],
        // ★ AI-04：把故障标记透出到 runTurn 返回值。
        //   下游（loop 控制器 / CLI / 演进环）据此判断"本轮是否失败"，
        //   而不是靠匹配错误文本（文本会变、且中英文都可能）。
        ...(outcome.isError ? { isError: true, errorKind: outcome.errorKind ?? 'internal' } : {}),
      }
    },
  }
}

