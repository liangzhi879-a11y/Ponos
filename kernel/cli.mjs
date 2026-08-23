#!/usr/bin/env node
// YFW-turbo 内核入口（docs/bridge-contract.md §2 spawn 契约 + §3/§4 wire 语义）
// ---------------------------------------------------------------------------
// 净室重建的原创内核（代号 YFW-turbo），由 bridge 经 bun 运行时以 stream-json
// 模式 spawn（findYFWorking 候选 #1：<repo>/kernel/cli.mjs），也可直接
// node kernel/cli.mjs 运行/测试。
// 职责：
//   - 解析契约参数（--print --output-format stream-json --input-format
//     stream-json --verbose --dangerously-skip-permissions
//     --permission-prompt-tool stdio --disallowedTools AskUserQuestion
//     [--resume id] [--append-system-prompt-file f] [--model m] [--add-dir d]）
//   - spawn 时发出 system(init)（/test-provider 依赖，见 bridge.mjs verifyProvider）
//   - readline 逐行路由 stdin：user → engine.runTurn 轮次；control_request(cancel)
//     → engine.abort() 后 '已取消。' + result；control_response → 暂存待里程碑 4
//   - 轮次队列：turnActive 时后续 user 排队，result 后处理
//   - stdin 关闭 → exit 0（bridge 侧 kill 或 EOF 均优雅退出）

import { createInterface } from 'node:readline'
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from './engine.mjs'
import { resolveConfigDir, sharedDirFor } from './config.mjs'
import { killActiveChildren } from './tools.mjs'
import { createLogger } from './log.mjs'
import { makeWire } from './protocol.mjs'
import { createSessionStore, newSessionId } from './session.mjs'
import { createHealth } from './health.mjs'
import { createCompactor, extractKeyInfo, buildSessionMemoryText } from './compact.mjs'
import { contextWindowFor, estimateRequest, estimateMessage, estimateHistory } from './context.mjs'
import { resolveCompactSettings } from './compact.mjs'
import { memoryRoot, buildMemoryIndex, captureMemoryCandidates, appendMemoryEntry } from './memory.mjs'
import { getProvider, setProvider, providerVersion, seedFromFile, visionFromEnv } from './provider.mjs'
import { discoverSkills } from './skills.mjs'
import { loadSettings } from './settings.mjs'
import { createHooks } from './hooks.mjs'
import { discoverAgentsMd, composeSystemPrompt } from './prompt.mjs'
import { KERNEL_VERSION, SCHEMA_VERSION, buildId } from '../version.mjs'

const REQUIRED_FORMAT = 'stream-json'

function usage() {
  console.error(
    'YFW-turbo kernel: --print --output-format stream-json --input-format stream-json ' +
    '[--verbose] [--dangerously-skip-permissions] [--auto-approve-high-risk] [--permission-prompt-tool stdio] ' +
    '[--disallowedTools <list>] [--resume <id>] [--append-system-prompt-file <file>] ' +
    '[--model <m>] [--add-dir <dir>] [--allow-outside-dirs]'
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
    permissionPromptTool: null,
    disallowedTools: [],
    resume: null,
    appendSystemPromptFile: null,
    model: null,
    addDirs: [],
    allowOutsideDirs: false,
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
      case '--permission-prompt-tool': out.permissionPromptTool = next(); break
      case '--permission-rules-file': out.permissionRulesFile = next() ?? null; break
      case '--disallowedTools':
        out.disallowedTools.push(...String(next() ?? '').split(',').filter(Boolean)); break
      case '--resume': out.resume = next() ?? null; break
      case '--append-system-prompt-file': out.appendSystemPromptFile = next() ?? null; break
      case '--model': out.model = next() ?? null; break
      case '--add-dir': out.addDirs.push(next() ?? ''); break
      case '--allow-outside-dirs': out.allowOutsideDirs = true; break
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

  const wire = makeWire()
  // 会话身份：--resume 恢复既有会话，否则新建（session_id 供 GUI 从 init 事件
  // 记录 conversation.sessionId，transcript 文件名 = 该 id，契约 §7/§8）
  const sessionId = args.resume || newSessionId()
  // S5-1 配置目录解析纯函数（CLAUDE_CONFIG_DIR > YFWORKING_HOME > ~/.yfworking）
  const configDir = resolveConfigDir(process.env, homedir)
  // S5-1 共享目录只读挂载：shared 存在时追加进 addDirs（tools withinBoundary 按
  // 白名单 dir 放行；共享技能/配置多人共用，个人 configDir 保持隔离）
  const sharedDir = sharedDirFor(configDir)
  if (existsSync(sharedDir)) args.addDirs.push(sharedDir)
  const store = createSessionStore({ configDir, cwd: args.addDirs[0] || '', sessionId })
  // P4-1：bridge 落盘的 providers.json → 注册表播种（未激活时生效；激活后固定）
  seedFromFile(join(configDir, 'providers.json'))
  // P4-3 分层 settings：user（configDir/settings.json）< project（cwd/.yfworking/settings.json）< local。
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
      log.warn('previous run crashed', { pid: prev.pid, ts: prev.ts })
      wire.system('crash_recovered', { sessionId })
    }
    mkdirSync(runDir, { recursive: true })
    writeFileSync(marker, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf-8')
  } catch { /* marker 不可写不致命 */ }
  // 统一退出：杀活跃子进程 → 清 marker → 退出
  function shutdown(code) {
    try { killActiveChildren() } catch {}
    try { rmSync(marker, { force: true }) } catch {}
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  // 生产链路一次接齐：context（token 启发式）+ health（健康监控）+ compactor（两阶段压缩）。
  // compactor 装配 health → 压缩成功后 yfw_summary 走 health.recordCompaction 单通道
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
  const health = createHealth({ wire, model, contextWindow, env: process.env })
  // P9-3：会话工作记忆文件路径（<configDir>/memory/session/<sessionId>.md）。
  // 轮末写入关键状态，压缩时 compactor 读文件注入摘要请求（可选能力，读失败静默降级）
  const sessionMemoryPath = join(configDir, 'memory', 'session', sessionId + '.md')
  const compactor = createCompactor({ session: store, context, model, maxTokens, wire, health, signal: undefined, env: process.env, sessionMemoryPath })

  // P4-2 hooks：settings.hooks 规则装配（无规则 = count 0，run 恒 matched=false）
  const hooks = createHooks({ rules: settings.merged.hooks || [] })

  const engine = createEngine({
    opts: {
      model: args.model,
      resumeId: args.resume,
      configDir,
      addDirs: args.addDirs,
      systemPrompt: '', // 占位，下面三层组装后覆盖
      verbose: args.verbose,
      skipPermissions: args.skipPermissions,
      autoApproveHighRisk: args.autoApproveHighRisk === true || settings.merged.autoApproveHighRisk === true,
      disallowedTools: [...args.disallowedTools, ...(settings.merged.disallowedTools || [])],
      permissionRules,
      hooks,
    },
    wire,
    session: store,
    health,
    compactor,
  })
  // P4-4：技能发现内核化——每个 --add-dir 扫描（技能根目录命中 SKILL.md；项目目录为空集）
  const skills = []
  const seenSkillIds = new Set()
  for (const dir of args.addDirs) {
    for (const s of discoverSkills({ root: dir })) {
      if (!seenSkillIds.has(s.id)) { seenSkillIds.add(s.id); skills.push(s) }
    }
  }
  // L3-2：记忆索引注入（与 GUI 经验面板同一数据源；settings.memory.inject=false 逃生阀）
  const memoryRootDir = memoryRoot(configDir)
  const memoryBlock = settings.merged.memory?.inject === false ? '' : buildMemoryIndex({ root: memoryRootDir })
  // 提示词组装：内核基础行为规范 + 可用子 Agent 区块（内置 ∪ 用户级）+ AGENTS.md
  // 项目指令 + 技能区块 + 记忆索引 + GUI append 文件（最高优先级，后者覆盖前者）。cwd = addDirs[0]。
  engine.setSystemPrompt(composeSystemPrompt({
    toolNames: engine.toolNames,
    subagents: engine.agents,
    agents: discoverAgentsMd({ cwd: args.addDirs[0] || '', addDirs: args.addDirs }),
    append: readPromptFile(args.appendSystemPromptFile),
    cwd: args.addDirs[0] || '',
    skills,
    memory: memoryBlock,
  }))
  // system(init)：spawn 即发。bridge /test-provider 判定 CLI 加载成功并读取
  // model/tools；GUI 从 session_id 绑定会话（useYFWCLI.ts handleMessage）。
  // name 字段标识 agent 身份（诊断用，GUI 不依赖）；version 为 yfwturbo dev 版本线
  // （version.mjs 单一数据源，与 GUI 发布版本相互独立）。
  log.info('kernel start', { model, resume: Boolean(args.resume), cwd: args.addDirs[0] || '' })
  // R4-1 并发会话上限策略内核化：capacity 由内核决定（env 兜底），bridge 只执行
  // 拒绝（单进程内核无法感知其他会话，执行必须在会话管理方）
  const capacity = Math.max(1, Number(process.env.YFW_MAX_CONCURRENT_SESSIONS || 10))
  // init 概览扩展（P4-4，只增字段）：provider 注册表激活态 / 视觉透传 / 技能数 / hooks 规则数
  const prov = getProvider()
  const vision = visionFromEnv()
  wire.system('init', {
    model, tools: engine.toolNames, session_id: sessionId, name: 'YFWorking', version: KERNEL_VERSION, capacity,
    schemaVersion: SCHEMA_VERSION,
    buildId: buildId(),
    provider: prov ? { model: prov.model, version: providerVersion() } : null,
    vision: vision ? { model: vision.model } : null,
    skills: skills.length,
    settings: { hooks: hooks.count },
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

  async function handleUser(msg) {
    const content = extractContent(msg)
    const priority = msg?.priority
    const uuid = msg?.uuid
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
            appendMemoryEntry({ root: memoryRootDir, theme: c.theme, tag: c.tag, summary: c.summary, full: c.full })
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

  function handleControlRequest(req) {
    const subtype = req?.request?.subtype
    if (subtype === 'cancel') {
      state.cancelling = true
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
        context.window = contextWindowFor(provider.model)   // 上下文窗口随模型重算
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
    } else if (parsed.type === 'control_response') {
      // 权限审批回执：解除对应 tool_use 的挂起（engine 继续执行工具）
      const inner = parsed.response?.response
      if (inner?.toolUseID) engine.resolveApproval(inner.toolUseID, inner)
    }
  })
  rl.on('close', () => shutdown(0))
  return 0
}

// 直接执行（import 时跳过，测试可复用 parseArgs/main）。main 为 async，
// Promise 落地 exitCode；load 失败（流式读错误）时以 1 退出并报错，避免悬空。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
    .catch((err) => { console.error('kernel:', err); process.exitCode = 1 })
}
