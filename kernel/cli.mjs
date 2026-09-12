#!/usr/bin/env node
// Ponos-turbo 内核入口（docs/bridge-contract.md §2 spawn 契约 + §3/§4 wire 语义）
// ---------------------------------------------------------------------------
// 净室重建的原创内核（代号 Ponos-turbo），由 bridge 经 node 运行时以 stream-json
// 模式 spawn（YFWORKING_KERNEL 逃生口候选 #1：<repo>/kernel/cli.mjs），也可直接
// node kernel/cli.mjs 运行/测试。
// 职责：
//   - 解析契约参数（--print --output-format stream-json --input-format
//     stream-json --verbose --dangerously-skip-permissions
//     --permission-prompt-tool stdio --disallowedTools AskUserQuestion
//     [--resume id] [--append-system-prompt-file f] [--model m] [--add-dir d] [--agent id]）
//   - spawn 时发出 system(init)（/test-provider 依赖，见 bridge.mjs verifyProvider）
//   - readline 逐行路由 stdin：user → engine.runTurn 轮次；control_request(cancel)
//     → engine.abort() 后 '已取消。' + result；control_response → 暂存待里程碑 4
//   - 轮次队列：turnActive 时后续 user 排队，result 后处理
//   - stdin 关闭 → exit 0（bridge 侧 kill 或 EOF 均优雅退出）

import { createInterface } from 'node:readline'
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createEngine } from './engine.mjs'
import { resolveConfigDir, sharedDirFor } from './config.mjs'
import { killActiveChildren } from './tools.mjs'
import { createLogger } from './log.mjs'
import { makeWire, wireLastWriteAt, setTurnActive, isTurnActive, isAwaitingUser, wireWriteStats } from './protocol.mjs'
import { createSessionStore, newSessionId } from './session.mjs'
import { createHealth } from './health.mjs'
import { createCompactor, extractKeyInfo, buildSessionMemoryText } from './compact.mjs'
import { contextWindowFor, estimateRequest, estimateMessage, estimateHistory } from './context.mjs'
import { resolveCompactSettings } from './compact.mjs'
import { extractConstraints } from './fidelity.mjs'
import { memoryRoot, buildMemoryIndex, captureMemoryCandidates, appendMemoryEntry } from './memory.mjs'
import { createGraphStore } from './graph.mjs'
import { getProvider, setProvider, providerVersion, seedFromFile, visionFromEnv } from './provider.mjs'
import { discoverSkills, verifySkillVersions } from './skills.mjs'
import { createWorkflowEngine, discoverWorkflowsAll, matchAutoTrigger, validateWorkflow } from './workflow.mjs'
// 画布模型 ↔ YAML 序列化（UI Task 9）：workflow_command 的 save/save-raw 子命令用
// （workflow.mjs 兼容层未 re-export serializeWorkflow；直接取 DSL 实现，勿重复实现）。
import { serializeWorkflow, normalizeWorkflow, parseYaml, toModel } from './workflow-dsl.mjs'
// Task 6：工作流即工具——工作流按 expose 三态注册为具名工具（run_<slug>）注入工具池
import { buildWorkflowTools, listVisibleWorkflows } from './dyntools.mjs'
import { loadSettings } from './settings.mjs'
import { createHooks } from './hooks.mjs'
import { normalizeApprovalMode, deriveApprovalMode } from './approval-mode.mjs'
import { discoverAgentsMd, composeSystemPrompt } from './prompt.mjs'
import { runReadonly } from './readonly.mjs'
import { KERNEL_VERSION, SCHEMA_VERSION, buildId } from '../version.mjs'

const REQUIRED_FORMAT = 'stream-json'

function usage() {
  console.error(
    'Ponos-turbo kernel: --print --output-format stream-json --input-format stream-json ' +
    '[--verbose] [--dangerously-skip-permissions] [--auto-approve-high-risk] [--approval-mode <manual|auto|loose|bypass>] [--permission-prompt-tool stdio] ' +
    '[--disallowedTools <list>] [--resume <id>] [--append-system-prompt-file <file>] ' +
    '[--model <m>] [--add-dir <dir>] [--allow-outside-dirs] [--agent <id>]'
  )
}

// 解析契约参数。未知 -- 参数容忍（真实内核接受更多参数，未知项忽略）。
export function parseArgs(argv) {
  const out = {
    print: false,
    outputFormat: null,
    inputFormat: null,
    verbose: false,
    skipPermissions: false,
    autoApproveHighRisk: false,
    approvalMode: null,
    permissionPromptTool: null,
    disallowedTools: [],
    resume: null,
    appendSystemPromptFile: null,
    model: null,
    agent: null,
    addDirs: [],
    skillsDirs: [],
    noDefaultSkills: false,
    allowOutsideDirs: false,
    agents: false,
    usage: false,
    audit: false,
    scope: null,
    sessionId: null,
    project: null,
    from: null,
    to: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--print': out.print = true; break
      case '--output-format': out.outputFormat = next(); break
      case '--input-format': out.inputFormat = next(); break
      case '--verbose': out.verbose = true; break
      case '--dangerously-skip-permissions': out.skipPermissions = true; break
      case '--auto-approve-high-risk': out.autoApproveHighRisk = true; break
      case '--approval-mode': out.approvalMode = next() ?? null; break
      case '--permission-prompt-tool': out.permissionPromptTool = next(); break
      case '--permission-rules-file': out.permissionRulesFile = next() ?? null; break
      case '--disallowedTools':
        out.disallowedTools.push(...String(next() ?? '').split(',').filter(Boolean)); break
      case '--resume': out.resume = next() ?? null; break
      case '--append-system-prompt-file': out.appendSystemPromptFile = next() ?? null; break
      case '--model': out.model = next() ?? null; break
      // Task 7：当前会话的 agent 身份——用于 bound 工作流可见性过滤（缺省 null →
      // 只有 public 工作流入池，bound 工作流对主会话不可见）
      case '--agent': out.agent = next() ?? null; break
      case '--add-dir': out.addDirs.push(next() ?? ''); break
      case '--skills-dir': out.skillsDirs.push(next() ?? ''); break
      case '--no-default-skills': out.noDefaultSkills = true; break
      case '--allow-outside-dirs': out.allowOutsideDirs = true; break
      case '--agents': out.agents = true; break
      case '--usage': out.usage = true; break
      case '--audit': out.audit = true; break
      case '--scope': out.scope = next() ?? null; break
      case '--sessionId': out.sessionId = next() ?? null; break
      case '--project': out.project = next() ?? null; break
      case '--from': out.from = next() ?? null; break
      case '--to': out.to = next() ?? null; break
      case '--help': case '-h': usage(); process.exit(0); break
      default:
        if (a && !a.startsWith('--')) out.positional = a
        // 未知 -- 参数：静默忽略（向后兼容）
    }
  }
  return out
}

function readPromptFile(path) {
  if (!path || !existsSync(path)) return ''
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

// P10-A：技能/工作流发现根解析——前端（bridge）负责下载/转化/安装/注册到技能根
// （~/.ponos/skills），内核只负责发现与使用。优先显式 --skills-dir；否则 addDirs
// （含 bridge 注入的技能根）之上叠加默认根 <configDir>/skills（CLI/benchmark 直跑
// 无 addDirs 技能时内核仍可用）。--no-default-skills / PONOS_NO_DEFAULT_SKILLS=1
// 禁用默认根（benchmark 横向对比需零外部污染）。结果去重（addDirs 已含默认根时不重复）。
export function resolveSkillRoots(args, configDir, env = process.env) {
  if (args.skillsDirs?.length) return [...new Set(args.skillsDirs.filter(Boolean))]
  const roots = new Set((args.addDirs || []).filter(Boolean))
  const noDefault = args.noDefaultSkills === true || env.PONOS_NO_DEFAULT_SKILLS === '1'
  if (!noDefault) {
    const def = join(configDir, 'skills')
    if (existsSync(def)) roots.add(def)
  }
  return [...roots]
}

function extractContent(msg) {
  const c = msg?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => b?.text ?? b?.content ?? '').join('\n')
  return ''
}

export async function main(argv) {
  const args = parseArgs(argv)
  if (args.outputFormat !== REQUIRED_FORMAT || args.inputFormat !== REQUIRED_FORMAT) {
    console.error(`kernel: only ${REQUIRED_FORMAT} I/O format is supported`)
    return 2
  }
  // U1/AS1 只读子命令：--usage / --audit / --agents（stdout JSON，不进 loop）。
  // 聚合实现 kernel/readonly.mjs（kernel 自读 transcript）；bridge 只薄转发。
  if (args.agents || args.usage || args.audit) {
    const mode = args.agents ? 'agents' : args.usage ? 'usage' : 'audit'
    const configDir = resolveConfigDir(process.env, homedir)
    try {
      const { output, code } = runReadonly({ mode, args, configDir })
      console.log(JSON.stringify(output))
      return code
    } catch (e) {
      console.log(JSON.stringify({ error: e?.message || String(e) }))
      return 1
    }
  }

  const wire = makeWire()
  // 会话身份：--resume 恢复既有会话，否则新建（session_id 供 GUI 从 init 事件
  // 记录 conversation.sessionId，transcript 文件名 = 该 id，契约 §7/§8）
  const sessionId = args.resume || newSessionId()
  // S5-1 配置目录解析纯函数（CLAUDE_CONFIG_DIR > PONOS_HOME > ~/.ponos）
  const configDir = resolveConfigDir(process.env, homedir)
  // P10-A：技能/工作流发现根——前端（bridge）负责安装注册到技能根，内核只发现使用。
  // 显式 --skills-dir 优先；否则 addDirs（含 bridge 注入技能根）叠加默认根 <configDir>/skills，
  // CLI/benchmark 直跑无 addDirs 技能时内核仍可用（--no-default-skills 可禁用）。
  const skillRoots = resolveSkillRoots(args, configDir, process.env)
  // S5-1 共享目录只读挂载：shared 存在时追加进 addDirs（tools withinBoundary 按
  // 白名单 dir 放行；共享技能/配置多人共用，个人 configDir 保持隔离）
  const sharedDir = sharedDirFor(configDir)
  if (existsSync(sharedDir)) args.addDirs.push(sharedDir)
  const store = createSessionStore({ configDir, cwd: args.addDirs[0] || '', sessionId })
  // P4-1：bridge 落盘的 providers.json → 注册表播种（未激活时生效；激活后固定）
  seedFromFile(join(configDir, 'providers.json'))
  // P4-3 分层 settings：user（configDir/settings.json）< project（cwd/.ponos/settings.json）< local。
  // settings.env 仅兜底（spawn env 快照仍权威）：缺失键才写入 process.env。
  const settings = loadSettings({ configDir, cwd: args.addDirs[0] || '', local: {} })
  for (const [k, v] of Object.entries(settings.merged.env || {})) {
    if (v !== undefined && process.env[k] === undefined) process.env[k] = String(v)
  }
  // 内核结构化日志（R5-1）：stderr JSON 行，级别过滤经 CLAUDE_CODE_LOG_LEVEL
  const log = createLogger({ level: process.env.CLAUDE_CODE_LOG_LEVEL || 'info', sid: sessionId })

  // R2-1/R3-1：运行 marker（<configDir>/runs/<sid>.running，{pid,ts} JSON）。
  // 启动时存在 → 上次非优雅退出（崩溃）→ 发 crash_recovered 事件提示恢复；
  // 正常流程随后重写 marker 接管。SIGINT/TERM 优雅退出时删除。
  const runDir = join(configDir, 'runs')
  const marker = join(runDir, sessionId + '.running')
  try {
    if (existsSync(marker)) {
      const prev = JSON.parse(readFileSync(marker, 'utf-8') || '{}')
      // E1 崩溃原因捕获（2026-09-09 事故修复）：旧日志只有 pid/ts，崩溃根因不可见。
      // 上次进程退出时把 uncaughtException 原文与退出码落进 marker(.err)，本次
      // resume 读回并写入结构化日志——下次崩溃当场可定位，不再靠猜。
      let lastErr = null
      const errFile = marker + '.err'
      try { if (existsSync(errFile)) { lastErr = readFileSync(errFile, 'utf-8').slice(0, 4000); rmSync(errFile, { force: true }) } } catch {}
      // 字段名用 prevTs 而非 ts：logger 的核心字段 ts 是本次日志时间，同名会被覆盖，
      // 上次崩溃时刻就丢了（两者都要留——排障要对比"上次何时崩、这次何时发现"）。
      log.warn('previous run crashed', { pid: prev.pid, prevTs: prev.ts, exitCode: prev.exitCode ?? null, err: lastErr })
      wire.system('crash_recovered', { sessionId })
    }
    mkdirSync(runDir, { recursive: true })
    writeFileSync(marker, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf-8')
    // 崩溃自描述：未捕获异常原文 + 退出码落盘（供下次 resume 读回日志）。
    // 优雅退出（shutdown）先删 marker 再 exit，exit 钩子里 marker 已不存在 → 不写。
    process.on('uncaughtException', (e) => {
      try {
        writeFileSync(marker + '.err', JSON.stringify({ message: String(e?.message || e), stack: String(e?.stack || '').slice(0, 4000), ts: new Date().toISOString() }), 'utf-8')
      } catch {}
    })
    // stdout/stderr 管道断裂兜底（2026-09-12 EPIPE 事故）：bridge 侧关闭管道后，
    // 流上的异步 'error' 事件无监听者会以未处理异常杀死进程（writeLine 的 try/catch
    // 只覆盖同步写异常）。EPIPE = 上游已离开、输出无意义 → 优雅退出（exit 钩子把
    // exitCode 写进 marker；bridge 的 close 事件广播 closed，GUI 收口解锁）。
    process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0) })
    process.stderr.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0) })
    // 进程级硬看门狗（2026-09-12 异步链失活事故）：请求层空闲看门狗随迭代创建/
    // 清理——请求异常终止（fetch 套接字消失、定时器清零、续体永不被调度）时，
    // 内核会"活着但永远空等"（inspector 实证：仅剩 stdio 三句柄、零定时器）。
    // 本看门狗独立于请求生命周期：wire 无输出超过阈值即硬退出（bridge 收 close
    // → 广播 closed → GUI 解锁），把不可观测的永久挂起变成可恢复的可见失败。
    // 默认 15 分钟（2026-09-12 调整）：必须严格大于"自适应首字节上限 600s"
    // （engine.mjs 大请求恒取 600s）加一个自愈周期——旧默认同为 600s，大请求健康
    // 慢 prefill 恰好在同一秒与看门狗撞车，谁先到看 tick 相位（见下）。600s→
    // 900s 的分离让"健康慢"与"真失活"不再共用一个数。
    // 不设下限钳制——env 显式值权威（测试用小值），与其它守卫 env 语义一致。
    const hardTimeoutMs = Math.max(1, Number(process.env.PONOS_KERNEL_HARD_TIMEOUT_MS) || 900_000)
    // 等待用户期间的展期窗口（2026-09-12）：审批/提问挂起时内核本来就零 wire 输出，
    // 等的是人。旧行为下用户思考超过 hardTimeoutMs 就被 exit(7) 杀掉，而且自杀前
    // **不写 result/error 帧**——桥只看到 close，用户的作答落空（GUI 甚至还在等弹窗回执）。
    // 展期而非"暂停判定"：GUI 永不回执时窗口也有界（超出审批上限后照杀）。
    const approvalGraceMs = Math.max(0, Number(process.env.PONOS_APPROVAL_TIMEOUT_MS) || 600_000)
    const hardTimer = setInterval(() => {
      const idle = Date.now() - wireLastWriteAt()
      const awaiting = isAwaitingUser()
      const limit = hardTimeoutMs + (awaiting ? approvalGraceMs : 0)
      if (isTurnActive() && idle > limit) {
        try {
          // 现场指纹（2026-09-12 异步链失活排查）：失活形态无 JS 栈可抓，句柄清单是
          // 唯一现场证据——"stdio-only + 零定时器"即失活签名；下次复发无需外部
          // inspector attach，marker.err 自带指纹。另记 wire 写失败计数：写失败=stdout
          // 实际已断，"静默时长"不再可信（那种情形该由桥侧 close 处理）。
          let fingerprint = {}
          try {
            const hs = (process._getActiveHandles() || []).map((h) => h?.constructor?.name || '?')
            fingerprint = { handles: hs.reduce((a, c) => ((a[c] = (a[c] || 0) + 1), a), {}), idleMs: idle, awaitingUser: awaiting, wireWrite: wireWriteStats() }
          } catch {}
          writeFileSync(marker + '.err', JSON.stringify({ message: `硬看门狗：wire 无输出 ${Math.round(idle / 1000)}s（>${Math.round(limit / 1000)}s${awaiting ? '，含等待用户展期' : ''}），疑似异步链失活`, stack: '(hard-watchdog, no JS stack)', fingerprint, ts: new Date().toISOString() }), 'utf-8')
        } catch {}
        process.exit(7)
      }
    }, Math.min(30_000, hardTimeoutMs))
    if (hardTimer.unref) hardTimer.unref()
    process.on('exit', (code) => {
      try {
        if (!existsSync(marker)) return
        const cur = JSON.parse(readFileSync(marker, 'utf-8') || '{}')
        writeFileSync(marker, JSON.stringify({ ...cur, exitCode: code }), 'utf-8')
      } catch {}
    })
  } catch { /* marker 不可写不致命 */ }
  // 统一退出：杀活跃子进程 → 清 marker → 退出
  function shutdown(code) {
    try { killActiveChildren() } catch {}
    try { if (wfSchedulerStop) wfSchedulerStop() } catch {}
    try { if (wfHttpServer) wfHttpServer.close() } catch {}
    try { rmSync(marker, { force: true }) } catch {}
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  // 生产链路一次接齐：context（token 启发式）+ health（健康监控）+ compactor（两阶段压缩）。
  // compactor 装配 health → 压缩成功后 ponos_summary 走 health.recordCompaction 单通道
  // （代发 + 记录 lastSummary），不再由 compactor 直接 wire.summary（FIX R1，杜绝双发）。
  // compactor 的 signal 传 undefined——cancel 不中断进行中的压缩摘要调用为已知限制
  // （deferred minor，勿改）。
  // S3-1 权限规则文件：--permission-rules-file → JSON { permissions: { allow, deny, ask } }
  let permissionRules = {}
  if (args.permissionRulesFile) {
    if (!existsSync(args.permissionRulesFile)) log.warn('permission rules 文件不存在', new Error(args.permissionRulesFile))
    else {
      try { permissionRules = JSON.parse(readFileSync(args.permissionRulesFile, 'utf-8')).permissions || {} } catch (e) { log.warn('permission rules 解析失败', e) }
    }
  }
  // P4-5：model 热切换后可变（init/回执用最新值；未激活时 getProvider 现读 env）
  // P4-3：settings.merged.model 三级兜底（args > env > settings）
  let model = args.model || getProvider().model || settings.merged.model || ''
  const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || settings.merged.maxOutputTokens || 64000))
  const contextWindow = contextWindowFor(model)
  // L2-1：settings.compact 预算配置化——threshold/reserve ratio + 工具结果预算。
  // 仅当 settings 显式配置 maxToolResults 且 env 未设置时才兜底填 env（不覆盖 spawn env）。
  const compactCfg = resolveCompactSettings({ window: contextWindow, settings: settings.merged, env: process.env })
  const maxToolResults = Number(settings.merged.compact?.maxToolResults)
  if (Number.isFinite(maxToolResults) && maxToolResults > 0 && !process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES) {
    process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES = String(maxToolResults)
  }
  const context = {
    window: contextWindow,
    thresholdRatio: compactCfg.thresholdRatio,
    retainRatio: compactCfg.retainRatio,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage,
    estimateHistory,
  }
  // 失真轴锚点源（2026-09-12 spec §5.1）：重新锚定所需的权威事实必须**确定性拼接**，
  // 不做额外模型调用——首条真实 user 任务（目标真值）+ 会话工作记忆（任务清单/文件
  // 变更/最近决策）+ 记忆里的硬约束。读取失败一律静默（锚点缺失不影响健康主流程）。
  const anchorMemoryPath = join(configDir, 'memory', 'session', sessionId + '.md')
  const getAnchorSource = () => {
    let task = ''
    try {
      const first = store.deriveMessages().find((m) => m?.role === 'user' &&
        !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')))
      if (typeof first?.content === 'string') task = first.content.slice(0, 1000)
    } catch { /* 静默 */ }
    let memoryText = ''
    try { memoryText = readFileSync(anchorMemoryPath, 'utf-8').slice(0, 4000) } catch { /* 无记忆文件 */ }
    return { task, memoryText, constraints: extractConstraints(memoryText) }
  }
  const health = createHealth({ wire, model, contextWindow, env: process.env, getAnchorSource })
  // P9-3：会话工作记忆文件路径（<configDir>/memory/session/<sessionId>.md）。
  // 轮末写入关键状态，压缩时 compactor 读文件注入摘要请求（可选能力，读失败静默降级）
  const sessionMemoryPath = join(configDir, 'memory', 'session', sessionId + '.md')
  const compactor = createCompactor({ session: store, context, model, maxTokens, wire, health, signal: undefined, env: process.env, sessionMemoryPath, onCompactionAudit: (a) => { try { health.recordCompactionAudit?.(a) } catch { /* 静默 */ } } })

  // P4-2 hooks：settings.hooks 规则装配（无规则 = count 0，run 恒 matched=false）
  const hooks = createHooks({ rules: settings.merged.hooks || [] })

  // workflow 引擎：与 skill 平权（同一发现/触发机制）。先创建实例（configDir 已知），
  // engine 创建后注入 registry/事件/模型/根目录（setDeps）。
  const wfEngine = createWorkflowEngine({ configDir })
  // 工作流发现根：技能根（与技能平权，同一发现机制）+ 独立工作流根 <configDir>/workflows
  // （与 bridge 侧 ~/.yfworking/workflows 安装目录对应；Task 8 把市场工作流装到这里）。
  const workflowRoots = [...skillRoots, join(configDir, 'workflows')]
  // I-2：public 工作流入池上限——settings.workflow.publicLimit（设置项不存在/非法 → 缺省 20，
  // 与 dyntools 内 LIMIT_DEFAULT 一致；不为此扩设置系统）。
  const wfPublicLimitN = Number(settings.merged.workflow?.publicLimit)
  const wfPublicLimit = Number.isFinite(wfPublicLimitN) && wfPublicLimitN > 0 ? Math.floor(wfPublicLimitN) : 20
  // P3 webhook 服务 / cron 调度器句柄（幂等启动，shutdown 清理）
  let wfHttpServer = null
  let wfSchedulerStop = null
  // workflow 命令执行中标志：stdin EOF 时等待其完成（真实 API llm 调用耗时秒级）
  let wfBusy = 0

  const engine = createEngine({
    opts: {
      model: args.model,
      configDir,
      addDirs: args.addDirs,
      skillsDirs: skillRoots,
      systemPrompt: '', // 占位，下面三层组装后覆盖
      verbose: args.verbose,
      skipPermissions: args.skipPermissions,
      autoApproveHighRisk: args.autoApproveHighRisk === true || settings.merged.autoApproveHighRisk === true,
      // 审批档位优先级：显式 --approval-mode > 内核 settings.json > 旧 flag 派生。
      // 放在 settings 之上是刻意的——settings.json 里残留的 autoApproveHighRisk:true
      // 不得把用户选定的 manual/auto 档悄悄放宽（engine 侧缺省才回落派生）。
      approvalMode: normalizeApprovalMode(args.approvalMode || settings.merged.approvalMode
        || deriveApprovalMode({ skipPermissions: args.skipPermissions, autoApproveHighRisk: args.autoApproveHighRisk === true || settings.merged.autoApproveHighRisk === true })),
      disallowedTools: [...args.disallowedTools, ...(settings.merged.disallowedTools || [])],
      permissionRules,
      hooks,
      // workflow 引擎实例：engine 内部 createToolRegistry 时注入（Workflow 工具）
      workflow: wfEngine,
      // MS1：MemorySearch 个人经验根（<configDir>/memory/personal，memoryRoot(configDir)）。
      // projectMemoryRoot 当前无项目记忆写入方，cli 不传 —— tools 侧 null → project scope 0 命中。
      memoryRoot: memoryRoot(configDir),
      // P2-1③：主会话 context（estimate 闭包）透传——lane 压缩器阈值判定复用
      context,
    },
    wire,
    session: store,
    health,
    compactor,
  })
  // Task 6：动态工具注入——工作流按 expose 三态成为具名工具（run_<slug>），随磁盘增删即时
  // 生效（视图函数每次求值）。engine.mjs 的 createToolRegistry 调用点不转发 dynamicTools，
  // 故此处经 registry 的 setDynamicTools 挂钩注入（与构造参数等价，后设覆盖先设）；agentId
  // 取 --agent（主会话缺省 null → bound 工作流对主会话不可见，仅 public 入池）。
  engine.tools.setDynamicTools(() => buildWorkflowTools({ roots: workflowRoots, engine: wfEngine, agentId: args.agent || null, publicLimit: wfPublicLimit }))
  // J1：health Judge 注入位——包装 engine.judgeUntil 作健康判定（目标 = 当前会话
  // 健康状态判定：是否建议重置/继续/压缩后继续）。默认关（PONOS_LLM_JUDGE /
  // CLAUDE_CODE_LLM_JUDGE），开时仅红档 + 冷却 300s 触发；异常由 health 侧静默。
  try {
    health.runJudge = async () => {
      const j = await engine.judgeUntil({
        target: '判定当前会话健康状态：是否建议重置会话 / 继续当前会话 / 压缩上下文后继续',
        maxTokens: 512,
      })
      return { done: j?.done === true, reason: j?.reason || j?.raw || '' }
    }
  } catch { /* 注入失败不阻断启动（judge 可选能力） */ }
  // workflow 引擎依赖注入：registry（tool/document 节点）、事件（wire 转发）、
  // 模型（provider 热切换同源）、根目录（addDirs 技能/工作流同域）
  wfEngine.setDeps({
    configDir,
    registry: engine.tools,
    onEvent: (ev) => { try { wire.system('workflow', ev) } catch { /* 事件失败不阻断 */ } },
    getModel: () => getProvider().model || model || process.env.ANTHROPIC_MODEL || '',
    memoryRoot: memoryRoot(configDir),
    // M3：bound 可见性判定用（与 dyntools 工具池同源，同为 --agent）
    agentId: args.agent || null,
  })
  for (const dir of workflowRoots) wfEngine.addRoot(dir)
  // P4-4：技能发现内核化——每个技能根扫描（技能根目录命中 SKILL.md；项目目录为空集）。
  // P10-A：roots = skillRoots（显式 --skills-dir > addDirs 叠加默认 <configDir>/skills）
  const skills = []
  const seenSkillIds = new Set()
  for (const dir of skillRoots) {
    for (const s of discoverSkills({ root: dir })) {
      if (!seenSkillIds.has(s.id)) { seenSkillIds.add(s.id); skills.push(s) }
    }
  }
  // SV1 技能版本守卫：<configDir>/skills.lock.json 存在时校验当前技能表 id/version。
  // outdated 非空 → wire.warning(level:'skill_version')，不阻断启动（lock 当前无写入
  // 者，文件不存在即零激活——天然零回归）。
  try {
    const lockPath = join(configDir, 'skills.lock.json')
    if (existsSync(lockPath)) {
      const { outdated } = verifySkillVersions({ lockPath, skills })
      if (outdated.length) wire.warning?.({ level: 'skill_version', outdated })
    }
  } catch { /* 版本校验失败不阻断启动 */ }
  // workflow 与 skill 平权：同一技能根发现（workflow.yml / .yml），
  // 共享 triggers 触发词；发现结果入【可用工作流】独立区块（严格输出定位）
  const workflows = discoverWorkflowsAll({ roots: workflowRoots })
  // I-3：提示词【可用工作流】清单改用与工具池同一可见性口径（private / bound 未命中 /
  // 超限 public / legacy 不注入名字与描述）。注意 workflows（未过滤）仍供 auto_trigger
  // 与 init 计数使用 —— 可见性与自动触发是两件事，本处只收窄注入面。
  const visibleWorkflows = listVisibleWorkflows({ roots: workflowRoots, agentId: args.agent || null, publicLimit: wfPublicLimit })
  // L3-2：记忆注入（与 GUI 经验面板同一数据源；settings.memory.inject=false 逃生阀）。
  // 两级注入：graph.search 按当前任务上下文关键词（余弦+关键词混合）从神经图谱抽调
  // 相关经验全文（模型直接可用），buildMemoryIndex 给全量索引指针（模型按需 Read）。
  // 任务关键词 = cwd/addDirs 目录名 + 显式任务标签（settings.memory.taskTag / env
  // PONOS_MEMORY_KEYWORDS，逗号分隔可追加）。PONOS_MEMORY_INJECT=index-only 时仅索引（旧行为）。
  const memoryRootDir = memoryRoot(configDir)
  // 神经图谱：图谱存储（markdown 权威，图谱派生索引；缺失/版本旧/markdown 更新自动重建）
  const graph = createGraphStore({ root: join(configDir, 'memory', 'graph') })
  try { await graph.load({ memoryRoot: memoryRootDir }) } catch { /* 图谱故障不影响主流程 */ }
  const injectMode = process.env.PONOS_MEMORY_INJECT || 'both'
  let memoryBlock = ''
  if (settings.merged.memory?.inject !== false) {
    if (injectMode !== 'index-only') {
      const kw = [
        ...(args.addDirs || []).map((d) => basename(d)).filter(Boolean),
        ...(settings.merged.memory?.taskTag || '').split(',').map((s) => s.trim()).filter(Boolean),
        ...(process.env.PONOS_MEMORY_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean),
      ]
      memoryBlock += graph.search({ query: kw.join(' '), keywords: kw })
    }
    memoryBlock += buildMemoryIndex({ root: memoryRootDir })
  }
  // 提示词组装：内核基础行为规范 + 可用子 Agent 区块（内置 ∪ 用户级）+ AGENTS.md
  // 项目指令 + 技能区块 + 记忆索引 + GUI append 文件（最高优先级，后者覆盖前者）。cwd = addDirs[0]。
  engine.setSystemPrompt(composeSystemPrompt({
    toolNames: engine.tools.toolNames,
    subagents: engine.agents,
    agents: discoverAgentsMd({ cwd: args.addDirs[0] || '', addDirs: args.addDirs }),
    append: readPromptFile(args.appendSystemPromptFile),
    cwd: args.addDirs[0] || '',
    skills,
    workflows: visibleWorkflows,
    memory: memoryBlock,
    // 本地弱模型精简纪律段（2026-09-09 适配）：桥按 provider 画像注入
    // PONOS_PROMPT_TIER=lean；未设=full（云端现状，零变化）。
    tier: process.env.PONOS_PROMPT_TIER === 'lean' ? 'lean' : 'full',
  }))
  // system(init)：spawn 即发。bridge /test-provider 判定 CLI 加载成功并读取
  // model/tools；GUI 从 session_id 绑定会话（usePonosCLI.ts handleMessage）。
  // name 字段标识 agent 身份（诊断用，GUI 不依赖）；version 为 ponos-turbo dev 版本线
  // （version.mjs 单一数据源，与 GUI 发布版本相互独立）。
  log.info('kernel start', { model, resume: Boolean(args.resume), cwd: args.addDirs[0] || '' })
  // R4-1 并发会话上限策略内核化：capacity 由内核决定（env 兜底），bridge 只执行
  // 拒绝（单进程内核无法感知其他会话，执行必须在会话管理方）
  const capacity = Math.max(1, Number(process.env.PONOS_MAX_CONCURRENT_SESSIONS || 10))
  // init 概览扩展（P4-4，只增字段）：provider 注册表激活态 / 视觉透传 / 技能数 / hooks 规则数
  const prov = getProvider()
  const vision = visionFromEnv()
  wire.system('init', {
    model, tools: engine.tools.toolNames, session_id: sessionId, name: 'Ponos', version: KERNEL_VERSION, capacity,
    schemaVersion: SCHEMA_VERSION,
    buildId: buildId(),
    provider: prov ? { model: prov.model, version: providerVersion() } : null,
    vision: vision ? { model: vision.model } : null,
    skills: skills.length,
    workflows: workflows.length,
    settings: { hooks: hooks.count },
    // 生效审批档位回显（2026-09-12 四档化）：桥据此校准状态栏徽标；也是"跑的是旧内核
    // （不认 --approval-mode）"的检测点——旧内核不会带这个字段。
    approval_mode: engine.getApprovalMode(),
  })
  // --resume：从 transcript 恢复（load 为 async 流式；同文件即 GUI 读取的权威源）。
  // 历史由 session.deriveMessages() 派生，engine 无需 seedHistory（seedHistory 已随
  // Task 5 迁移移除）。
  if (args.resume) {
    await store.load()
  }
  // hooks.sessionStart：spawn 就绪后 fire-and-forget（不阻塞 init 事件）
  if (hooks.count) {
    try { await hooks.run('sessionStart', { sessionId, cwd: args.addDirs[0] || '' }) } catch {}
  }

  const state = { turnActive: false, queue: [], cancelling: false }
  // loop 迭代状态（顶层 msg.loop 字段驱动；cancel / until 命中 / 次数耗尽结束）
  const loopState = { active: false, total: 0, until: '', content: '', index: 0, fresh: false }

  // workflow 自动触发：普通用户消息命中 auto_trigger 工作流的触发词 →
  // 后台 run（wfBusy 防 EOF 提前退出），完成后结果经 engine.queueNext 注入
  // 当前轮（工具边界）或下一轮，模型综合后继续；wire 回发 auto_triggered 事件。
  function maybeAutoTriggerWorkflow(content) {
    const hit = matchAutoTrigger(workflows, content)
    if (!hit) return
    const summarize = (o) => {
      try { return JSON.stringify(o?.end?.output ?? o).slice(0, 400) } catch { return String(o) }
    }
    wfBusy++
    void wfEngine.run({ id: hit.id, inputs: { user_message: content } }).then((r) => {
      wfBusy--
      const line = r.ok
        ? `【自动触发工作流 ${hit.id} 完成】状态：${r.status}（${r.steps} 步，${r.runId}）。输出：${summarize(r.outputs)}`
        : `【自动触发工作流 ${hit.id} 失败】${r.error}`
      try { engine.queueNext(line) } catch { /* 注入失败不阻断 */ }
      try { wire.system('workflow_result', { subtype: 'auto_triggered', workflow: hit.id, ok: r.ok, status: r.status, steps: r.steps, runId: r.runId, error: r.error }) } catch { /* ignore */ }
    }).catch((err) => {
      wfBusy--
      log.error('auto-trigger workflow failed', err)
    })
  }

  async function handleUser(msg) {
    setTurnActive(true) // 硬看门狗武装（result 事件经 writeLine 自动解除）
    const content = extractContent(msg)
    const priority = msg?.priority
    const uuid = msg?.uuid
    // loop 初始化：首个带 loop 字段的消息进入时登记（内部推进消息 loopState 已 active，跳过）
    const loop = msg?.loop
    if (loop && !loopState.active) {
      loopState.active = true
      loopState.total = Math.max(1, Number(loop.count) || 1)
      loopState.until = String(loop.until || '')
      loopState.content = content
      loopState.index = 0
      loopState.fresh = !!loop.fresh
      wire.loop('start', { index: 0, total: loopState.total, until: loopState.until, fresh: loopState.fresh })
    }
    // P8 排队插话（priority:'next'）：当前轮活跃时吸收进 engine 待注入队列，
    // 工具边界注入当前轮（模型尽快看到补充信息）；立即回发 command_lifecycle
    // started 解除前端气泡悬浮。纯文本阶段轮次结束仍未注入 → finally 兜底作为
    // 新轮处理（前端方案 A 语义）。turnActive=false（轮次间隙到达）时作为新轮
    // 直接执行，同样先发 started 确认——否则前端气泡悬浮 30s 兜底落位。
    if (priority === 'next') {
      if (state.turnActive) {
        engine.queueNext(content, uuid) // 内部含 command_lifecycle started
        return
      }
      if (uuid) wire.commandLifecycle(uuid, 'started')
      // fallthrough：作为新轮执行
    }
    // 紧急插话（priority:'now'）：吸收确认后中断当前轮，消息作为新轮立即执行。
    // 流程与前端 pendingInterject 对齐：被打断轮 result 到达 → GUI 建插话轮
    // 占位 → 本消息作为新轮输出归属到插话轮。
    if (state.turnActive && priority === 'now') {
      if (uuid) wire.commandLifecycle(uuid, 'started')
      state.cancelling = true
      engine.abort()
      state.queue = [] // 丢弃排队消息（紧急插话优先）
      state.queue.push({ ...msg, priority: undefined, uuid: undefined })
      return
    }
    state.turnActive = true
    // workflow 自动触发（普通新消息；插话/loop 消息不触发，避免批处理重复执行）
    try { maybeAutoTriggerWorkflow(content) } catch { /* 触发失败不影响主流程 */ }
    // 早退路径（hook 拦截 / 竞态取消）统一落在外层 try 内，确保 finally 复位
    // turnActive——否则后续消息会永远排队不处理。
    try {
      // hooks.userPromptSubmit：可拦截。stop → 直接 assistant + result，不进轮次
      try {
        const intercept = await hooks.run('userPromptSubmit', { prompt: content })
        if (intercept.stop) {
          wire.assistant(intercept.message || '已由 hook 拦截。')
          wire.result()
          return
        }
      } catch { /* 钩子失败不拦截输入 */ }
      // 竞态防护：hook await 期间 cancel 到达 → engine.runTurn 起始会重置 abort
      // 标志（abort 只影响进行中的轮次），未开始就 abort 会被吞掉。在此兑现取消。
      if (state.cancelling) {
        wire.assistant('已取消。')
        wire.result()
        // 与 abort 路径一致的会话语义：user 入日志 + assistant 落盘
        store.appendUser(content)
        store.appendAssistant([{ type: 'text', text: '已取消。' }])
        return
      }
      // engine 全权负责本轮：user 入 session、中间/最终 assistant 落盘、
      // result 事件（含 duration_ms）——cli 不再重复 emit/append
      await engine.runTurn({ content, msg })
    } catch (err) {
      if (err?.name === 'AbortError' || state.cancelling) {
        log.info('turn cancelled')
        wire.assistant('已取消。')
        wire.result()
        store.appendAssistant([{ type: 'text', text: '已取消。' }])
      } else {
        log.error('turn failed', err)
        wire.assistant('处理出错：' + (err?.message || String(err)))
        wire.result()
      }
    } finally {
      // L3-1 轮末捕获：命中纠错/偏好模式 → 落盘记忆（默认开，settings.memory.capture=false 关闭）。
      // skipMemoryCapture：插话统一不捕获——工具边界注入路径（engine 内 appendUser）
      // 本就不经 cli 捕获，兜底成新轮的插话带标记跳过，两条路径行为一致。
      try {
        if (settings.merged.memory?.capture !== false && content.trim() && !msg?.skipMemoryCapture) {
          for (const c of captureMemoryCandidates({ userText: content, tag: settings.merged.memory?.taskTag || null, markers: settings.merged.memory?.markers || null })) {
            appendMemoryEntry({ root: memoryRootDir, theme: c.theme, tag: c.tag, summary: c.summary, full: c.full, graphStore: graph })
          }
        }
      } catch { /* 记忆捕获失败不影响主流程 */ }
      // P9-3：轮末写会话工作记忆（todo/文件变更/最近决策）——压缩时作为摘要事实来源
      try {
        if (sessionMemoryPath) {
          const key = extractKeyInfo(store.deriveMessages())
          if (key.todos.length || key.files.length || key.decisions.length) {
            mkdirSync(join(configDir, 'memory', 'session'), { recursive: true })
            writeFileSync(sessionMemoryPath, buildSessionMemoryText(key), 'utf-8')
          }
        }
      } catch { /* 工作记忆写失败不影响主流程 */ }
      state.turnActive = false
      state.cancelling = false
      // loop 推进（轮次已完成）：until 模型判定 / 次数检查 → 下一轮 unshift 入队
      // （插话消息排在 loop 之后公平执行；cancel 已清 loopState.active 自然停止）
      if (loopState.active) {
        const nextIndex = loopState.index + 1
        const endLoop = (reason) => {
          wire.loop('end', { reason, index: nextIndex, total: loopState.total })
          loopState.active = false
        }
        if (loopState.until) {
          let j = null
          try { j = await engine.judgeUntil({ target: loopState.until }) } catch { j = { done: false, error: true } }
          wire.loop('iter', { index: nextIndex, total: loopState.total, judged: j?.done === true, reason: j?.reason || '', error: !!j?.error })
          if (j?.done) endLoop('until_hit')
          else if (j?.error || nextIndex >= loopState.total) endLoop(j?.error ? 'judge_error' : 'completed')
          else {
            // fresh：第 1 轮完成后设窗口起点，第 2 轮请求面只含本轮之后内容
            if (loopState.fresh && nextIndex === 1) engine.setFreshWindow()
            loopState.index = nextIndex
            state.queue.unshift({ message: { role: 'user', content: loopState.content }, loop: { count: loopState.total, until: loopState.until, index: nextIndex }, skipMemoryCapture: true })
          }
        } else if (nextIndex >= loopState.total) {
          endLoop('completed')
        } else {
          // fresh：第 1 轮完成后设窗口起点，第 2 轮请求面只含本轮之后内容
          if (loopState.fresh && nextIndex === 1) engine.setFreshWindow()
          loopState.index = nextIndex
          wire.loop('iter', { index: nextIndex, total: loopState.total })
          state.queue.unshift({ message: { role: 'user', content: loopState.content }, loop: { count: loopState.total, index: nextIndex }, skipMemoryCapture: true })
        }
      }
      // 插话残余兜底：next 消息在纯文本阶段未被工具边界吸收 → 作为新轮处理。
      // skipMemoryCapture 标记：插话不参与记忆捕获（与工具边界注入路径一致，
      // 见 finally 捕获处注释）
      if (engine.pendingNextCount() > 0) {
        for (const inj of engine.drainNextPending()) {
          state.queue.push({ message: { role: 'user', content: inj.content }, skipMemoryCapture: true })
        }
      }
      const nextMsg = state.queue.shift()
      if (nextMsg) void handleUser(nextMsg)
    }
  }

  // /wf 命令执行：list/run/verify → 工作流引擎，结果 wire.system('workflow_result') 回发
  async function handleWorkflowCommand(msg) {
    const subtype = msg?.subtype
    try {
      if (subtype === 'list') {
        const wfs = discoverWorkflowsAll({ roots: workflowRoots })
        // 回执补 legacy/expose/dslVersion（M7）：宿主/GUI 需要「需升级」「暴露态」标记；
        // requestId 全子命令齐备（M6）——宿主 send() 严格按 msg.requestId 配对，缺一个即超时。
        wire.system('workflow_result', {
          subtype: 'list', requestId: msg?.requestId,
          workflows: wfs.map((w) => ({
            id: w.id, nodes: w.nodes, triggers: w.triggers, description: w.description,
            legacy: w.legacy === true, expose: w.expose || {}, dslVersion: w.dslVersion,
            version: w.version || '', schedule: w.schedule || '', autoTrigger: w.autoTrigger === true,
          })),
        })
      } else if (subtype === 'run') {
        // runId/grant/cwd 必须转发：宿主用 runId 作为 grant 键与 stop/confirm 的目标；
        // 不转发时引擎自生 runId，宿主拿到的 id 与真实运行错位 → stop 打空、审计无法关联。
        const r = await wfEngine.run({
          id: msg?.payload?.workflow || msg?.payload?.id || '',
          inputs: msg?.payload?.inputs || {},
          runId: msg?.payload?.runId || undefined,
          grant: msg?.payload?.grant || null,
          cwd: msg?.payload?.cwd || '',
        })
        // 回执补 code/errors（审查 I-3）：宿主只看 ok/error 时无法把"旧 DSL 需迁移"与其他
        // 失败区分开；LEGACY_DSL 另附可操作提示（Task 8 迁移前的唯一自带工作流正走此路径）。
        const legacy = r.code === 'LEGACY_DSL'
        const error = legacy && r.error ? `${r.error}（该工作流为旧 DSL 格式（无 edges），请先迁移）` : r.error
        wire.system('workflow_result', { subtype: 'run', requestId: msg?.requestId, ok: r.ok, status: r.status, steps: r.steps, outputs: r.outputs, finalOutput: r.finalOutput, error, ...(r.code ? { code: r.code } : {}), errors: r.errors, node: r.node, runId: r.runId, auditPath: r.auditPath, ...(r.unresolved ? { unresolved: r.unresolved } : {}) })
      } else if (subtype === 'verify') {
        const r = wfEngine.verify(msg?.payload?.auditPath || msg?.payload?.path || '')
        wire.system('workflow_result', { subtype: 'verify', requestId: msg?.requestId, ok: r.ok, lines: r.lines, tampered: r.tampered, error: r.error })
      } else if (subtype === 'webhook') {
        // 启动 webhook 服务（幂等）：POST /wf/run/<id>（JSON body=inputs），GET /wf/list
        const port = Number(process.env.PONOS_WF_WEBHOOK_PORT || 51312)
        if (!wfHttpServer) {
          wfHttpServer = wfEngine.createWebhookServer()
          wfHttpServer.listen(port, () => {
            wire.system('workflow_result', { subtype: 'webhook', ok: true, port, url: `http://localhost:${port}/wf/run/<id>` })
          })
          wfHttpServer.on('error', (err) => wire.system('workflow_result', { subtype: 'webhook', ok: false, error: err?.message || String(err) }))
        } else {
          wire.system('workflow_result', { subtype: 'webhook', ok: true, port, url: `http://localhost:${port}/wf/run/<id>`, note: 'already running' })
        }
      } else if (subtype === 'scheduler') {
        // 启动 cron 调度器（幂等）：扫描 workflows 带 schedule 字段，到点自动 run
        if (!wfSchedulerStop) {
          wfSchedulerStop = wfEngine.startScheduler({ onRun: (id, res) => wire.system('workflow_result', { subtype: 'scheduled_run', workflow: id, ok: res.ok, status: res.status, runId: res.runId, auditPath: res.auditPath }) })
          wire.system('workflow_result', { subtype: 'scheduler', requestId: msg?.requestId, ok: true, note: 'started (60s tick)' })
        } else {
          wire.system('workflow_result', { subtype: 'scheduler', requestId: msg?.requestId, ok: true, note: 'already running' })
        }
      } else if (subtype === 'migrate') {
        // 旧格式一键迁移 + 备份（M7，spec §2.7）：迁移是**唯一的内核写用户工作流目录**动作，
        // 只在显式收到本子命令时发生（理由与写盘两步见 workflow-engine.migrate 注释）。
        // payload.id 缺省 = 全部 legacy 工作流；回执三段 migrated/skipped/errors。
        const info = wfEngine.migrate({ id: String(msg?.payload?.id || msg?.payload?.workflow || '').trim() || null })
        wire.system('workflow_result', { subtype: 'migrate', requestId: msg?.requestId, ...info })
      } else if (subtype === 'load') {
        // 取工作流原文 + 校验结果（只读，不落盘）
        const id = msg?.payload?.id || ''
        const wf = wfEngine.load(id)
        if (!wf) wire.system('workflow_result', { subtype: 'load', requestId: msg?.requestId, result: { ok: false, error: `工作流不存在: ${id}` } })
        else wire.system('workflow_result', {
          subtype: 'load', requestId: msg?.requestId,
          // model：画布模型（toModel 收拢 config）——GUI 打开工作流直接落画布，
          // 不必在前端重做 DSL 解析（UI Task 13「选中项经 /workflows/:id 取 model」）。
          result: { ok: true, id: wf.id || id, model: toModel(wf), yml: wf.path ? readFileSync(wf.path, 'utf-8') : '', validation: validateWorkflow(wf) },
        })
      } else if (subtype === 'validate') {
        const wf = wfEngine.load(msg?.payload?.id || '')
        const v = wf ? validateWorkflow(wf) : { ok: false, errors: [{ code: 'NOT_FOUND', message: '工作流不存在' }], warnings: [] }
        wire.system('workflow_result', { subtype: 'validate', requestId: msg?.requestId, result: v })
      } else if (subtype === 'stop') {
        wire.system('workflow_result', { subtype: 'stop', requestId: msg?.requestId, result: wfEngine.stop(msg?.payload?.runId || '') })
      } else if (subtype === 'save' || subtype === 'save-raw') {
        // 画布保存（UI Task 9/12）：序列化 → 解析归一 → 校验 → 回传 yml 文本。
        // **不写用户工作流目录**（单一写者）：落盘由 bridge 侧存储层完成——内核并发多会话，
        // 多写者会让版本快照与备份互相覆盖；写盘动作只保留 migrate（显式迁移）。
        //   save      ：payload.model（画布模型）→ serializeWorkflow → yml
        //   save-raw  ：payload.yaml 原文回传（保留用户排版/注释），缺 yaml 时回退 model
        // 两种载荷都容忍：宿主 save() 统一发 save-raw，带 model 时以 model 序列化。
        const saveId = String(msg?.payload?.id || '').trim()
        const raw = typeof msg?.payload?.yaml === 'string' ? msg.payload.yaml : ''
        const yml = raw.trim() ? raw : serializeWorkflow(msg?.payload?.model || {})
        const validation = validateWorkflow(normalizeWorkflow(parseYaml(yml)))
        if (!validation.ok) {
          wire.system('workflow_result', {
            subtype, requestId: msg?.requestId,
            result: { ok: false, id: saveId, error: '校验失败', errors: validation.errors, warnings: validation.warnings },
          })
        } else {
          wire.system('workflow_result', { subtype, requestId: msg?.requestId, result: { ok: true, id: saveId, yml, validation } })
        }
      } else {
        // 必须带 requestId：宿主按 requestId 严格配对；无 requestId 的错误只能靠启发式
        // 兜底（曾导致"无关错误误杀在途 run"，Task 11 审查 I-1/N-3），根治办法是错误回执
        // 也带上请求标识。
        wire.system('workflow_result', { subtype: 'error', requestId: msg?.requestId, error: `未知 /wf 子命令: ${subtype}` })
      }
    } catch (err) {
      wire.system('workflow_result', { subtype: 'error', requestId: msg?.requestId, error: err?.message || String(err) })
    }
  }

  function handleControlRequest(req) {
    const subtype = req?.request?.subtype
    if (subtype === 'cancel') {
      state.cancelling = true
      // loop 立即终止：清 active（后续轮次不再推进），结束事件发出
      if (loopState.active) {
        loopState.active = false
        wire.loop('end', { reason: 'cancelled', index: loopState.index + 1, total: loopState.total })
      }
      // 停止按钮全杀语义（engine.hardStop）：kill 工具子进程（Bash/OCR）+ 中止
      // 全部后台子 agent + 中断当前 API 流。与打断插入（now，engine.abort()，
      // 保持审批/浏览器挂起让模型理解新指令后继续）区分。
      engine.hardStop()
      // 取消语义含丢弃排队输入（用户后续消息不再执行）
      state.queue = []
      // P8 修复：一并丢弃尚未注入当前轮的排队插话（pendingNext）——否则轮末
      // finally 会把残余插话 drain 成新轮执行，取消"取消不干净"。drain 返回值
      // 即丢弃；空转 cancel（turnActive=false）时 pendingNext 必为空，无副作用。
      engine.drainNextPending()
      // 无活跃轮次时的空转 cancel：直接完成（契约 §8，bridge 依赖 result
      // 复位 _cancelPending；mock 同语义）
      if (!state.turnActive) {
        wire.assistant('已取消。')
        wire.result()
        state.cancelling = false
      }
      return
    }
    // 浏览器桥响应（bridge 回写，browser-routing.mjs）：解除 engine 浏览器挂起
    if (subtype === 'browser_response') {
      engine.resolveBrowser(req?.request?.requestId, req?.request)
      return
    }
    // P4-5 热切换：空闲切换 / busy 拒绝 / 校验失败拒绝；成功落审计 meta 条目
    if (subtype === 'switch_provider') {
      const payload = req?.request?.payload || {}
      if (state.turnActive) {
        wire.system('provider_switch_rejected', { reason: 'busy' })
        return
      }
      try {
        const { provider, version } = setProvider(payload)
        model = provider.model
        // 上下文窗口：bridge 显式下发 contextWindow（setProvider 已持久化）则尊重之，
        // 自定义窗口在热切换时不丢失；未下发（0）才按模型表/画像默认重算。
        // 切换后窗口重定向（2026-09-10 小窗口模型切换适配）：立即上行事件供
        // TUI/GUI 提示；压缩阈值与每轮请求的预算钳制（engine preStep）都现读
        // context.window——云端大窗口切本地小窗口后，下一轮请求即按新窗口规划，
        // covered 超单块容量时走分块摘要（compact.mjs 阶段②b）。
        context.window = provider.contextWindow > 0 ? provider.contextWindow : contextWindowFor(provider.model)
        wire.system('context_window_retargeted', { model: provider.model, window: context.window })
        // 顺带同步思考深度档位（bridge 下发 payload.effortLevel；空值不动）
        if (payload.effortLevel) {
          const r = engine.setReasoningEffort(payload.effortLevel)
          store.appendMeta('reasoning_effort', { value: r.value, effort: r.effort, source: 'provider_switch' })
        }
        store.appendMeta('provider_switched', { provider: { baseUrl: provider.baseUrl, model: provider.model }, version })
        wire.system('provider_switched', { model: provider.model, baseUrl: provider.baseUrl, version })
      } catch (err) {
        wire.system('provider_switch_rejected', { reason: err?.message || String(err) })
      }
      return
    }
    // 思考深度热切换：校验失败拒绝 / 生效于下一轮 API 请求；成功落审计 meta 条目
    if (subtype === 'reasoning_effort') {
      const value = req?.request?.payload?.value
      if (value == null || String(value).trim() === '') {
        wire.system('reasoning_effort_rejected', { reason: '缺少 value（off|low|medium|high|max|auto）' })
        return
      }
      const r = engine.setReasoningEffort(String(value).trim())
      store.appendMeta('reasoning_effort', { value: r.value, effort: r.effort })
      wire.system('reasoning_effort_updated', { value: r.value, effort: r.effort })
      return
    }
    // 审批档位热切换（2026-09-12）：四档 manual|auto|loose|bypass，下一轮工具调用生效。
    // 非法值不静默放宽——回落默认档（loose）并上行 rejected 事件，桥/GUI 可提示用户。
    if (subtype === 'approval_mode') {
      const raw = req?.request?.payload?.value
      const mode = engine.setApprovalMode(raw)
      const valid = normalizeApprovalMode(raw) === String(raw ?? '').trim().toLowerCase()
      store.appendMeta('approval_mode', { value: mode, source: valid ? 'user' : 'fallback' })
      if (valid) wire.system('approval_mode_updated', { value: mode })
      else wire.system('approval_mode_rejected', { reason: `非法档位 ${JSON.stringify(raw)}，已回落默认档`, value: mode })
      return
    }
    // 其余 control_request（interrupt 等）骨架阶段忽略
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    let parsed = null
    try { parsed = JSON.parse(t) } catch { return }
    if (parsed.type === 'user') {
      // P8 插话消息（priority:'next'/'now'）在轮次活跃时必须进 handleUser——其
      // priority 分支负责 queueNext 吸收（工具边界注入当前轮）或 now 打断；普通
      // 消息才直接排队。修复：此前 turnActive 一律 queue.push 绕过了 handleUser，
      // 使 next 的注入路径与 now 的打断路径在 cli 进程从未生效（dead code），
      // 插话实际退化为"排队等新轮"（方案 A 兜底语义），command_lifecycle 也因此
      // 滞后到轮末才发出（前端气泡 30s 兜底落位）。
      if (state.turnActive && parsed.priority !== 'next' && parsed.priority !== 'now') {
        state.queue.push(parsed)
      } else {
        void handleUser(parsed)
      }
    } else if (parsed.type === 'control_request') {
      handleControlRequest(parsed)
    } else if (parsed.type === 'anchor_applied') {
      // 上下文失真：用户在 GUI 点了「重新锚定」并已发送锚点 → 把这些证据标记为
      // 已解决（失真档立即回绿 + 进入观察期）。静默降级：上报失败不得影响轮次。
      try { health.markFidelityResolved(Array.isArray(parsed.issueIds) ? parsed.issueIds : []) } catch { /* 静默 */ }
    } else if (parsed.type === 'control_response') {
      // 权限审批回执：解除对应 tool_use 的挂起（engine 继续执行工具）
      const inner = parsed.response?.response
      if (inner?.toolUseID) engine.resolveApproval(inner.toolUseID, inner)
    } else if (parsed.type === 'workflow_command') {
      // /wf 命令（TUI/协议层）：list/run/verify/approve/reject → 调工作流引擎，结果 wire 回发
      wfBusy++
      handleWorkflowCommand(parsed).finally(() => { wfBusy-- })
    } else if (parsed.type === 'workflow_confirm') {
      // 人工审批回传（TUI /wf approve|reject / 协议层）：解除 confirm 节点挂起
      const { runId, node, action, comment } = parsed.payload || {}
      const r = wfEngine.resolveConfirm(runId, node, { action: action || 'approved', comment: comment || '' })
      wire.system('workflow_result', { subtype: 'confirm', ok: r.ok, error: r.error })
    }
  })
  rl.on('close', () => {
    // stdin EOF：若仍有活跃轮次 / 排队消息 / 进行中 loop / workflow 命令，延迟到完成后退出
    // （管道测试与 bridge 优雅退出两全；30s 兜底防挂起）
    if (state.turnActive || state.queue.length || loopState.active || wfBusy > 0) {
      const timer = setInterval(() => {
        if (!state.turnActive && !state.queue.length && !loopState.active && wfBusy <= 0) {
          clearInterval(timer)
          shutdown(0)
        }
      }, 50)
      setTimeout(() => { clearInterval(timer); shutdown(0) }, 30000)
    } else {
      shutdown(0)
    }
  })
  return 0
}

// 直接执行（import 时跳过，测试可复用 parseArgs/main）。main 为 async，
// Promise 落地 exitCode；load 失败（流式读错误）时以 1 退出并报错，避免悬空。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
    .catch((err) => { console.error('kernel:', err); process.exitCode = 1 })
}
