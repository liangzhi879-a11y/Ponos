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
import { killActiveChildren } from './tools.mjs'
import { createLogger } from './log.mjs'
import { makeWire } from './protocol.mjs'
import { createSessionStore, newSessionId } from './session.mjs'
import { createHealth } from './health.mjs'
import { createCompactor } from './compact.mjs'
import { contextWindowFor, estimateRequest, estimateMessage, estimateHistory } from './context.mjs'
import { discoverAgentsMd, composeSystemPrompt } from './prompt.mjs'
import { YFW_VERSION } from '../version.mjs'

const REQUIRED_FORMAT = 'stream-json'

function usage() {
  console.error(
    'YFW-turbo kernel: --print --output-format stream-json --input-format stream-json ' +
    '[--verbose] [--dangerously-skip-permissions] [--auto-approve-high-risk] [--permission-prompt-tool stdio] ' +
    '[--disallowedTools <list>] [--resume <id>] [--append-system-prompt-file <file>] ' +
    '[--model <m>] [--add-dir <dir>]'
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
      case '--disallowedTools':
        out.disallowedTools.push(...String(next() ?? '').split(',').filter(Boolean)); break
      case '--resume': out.resume = next() ?? null; break
      case '--append-system-prompt-file': out.appendSystemPromptFile = next() ?? null; break
      case '--model': out.model = next() ?? null; break
      case '--add-dir': out.addDirs.push(next() ?? ''); break
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
  const configDir = process.env.CLAUDE_CONFIG_DIR || process.env.YFWORKING_HOME || join(homedir(), '.yfworking')
  const store = createSessionStore({ configDir, cwd: args.addDirs[0] || '', sessionId })
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
  const model = args.model || process.env.ANTHROPIC_MODEL || ''
  const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || 64000))
  const contextWindow = contextWindowFor(model)
  const context = {
    window: contextWindow,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage,
    estimateHistory,
  }
  const health = createHealth({ wire, model, contextWindow, env: process.env })
  const compactor = createCompactor({ session: store, context, model, maxTokens, wire, health, signal: undefined, env: process.env })

  const engine = createEngine({
    opts: {
      model: args.model,
      resumeId: args.resume,
      configDir,
      addDirs: args.addDirs,
      systemPrompt: '', // 占位，下面三层组装后覆盖
      verbose: args.verbose,
      skipPermissions: args.skipPermissions,
      autoApproveHighRisk: args.autoApproveHighRisk,
      disallowedTools: args.disallowedTools,
    },
    wire,
    session: store,
    health,
    compactor,
  })
  // 提示词组装：内核基础行为规范 + 可用子 Agent 区块（内置 ∪ 用户级）+ AGENTS.md
  // 项目指令 + GUI append 文件（最高优先级，后者覆盖前者）。cwd = addDirs[0]。
  engine.setSystemPrompt(composeSystemPrompt({
    toolNames: engine.toolNames,
    subagents: engine.agents,
    agents: discoverAgentsMd({ cwd: args.addDirs[0] || '', addDirs: args.addDirs }),
    append: readPromptFile(args.appendSystemPromptFile),
    cwd: args.addDirs[0] || '',
  }))
  // system(init)：spawn 即发。bridge /test-provider 判定 CLI 加载成功并读取
  // model/tools；GUI 从 session_id 绑定会话（useYFWCLI.ts handleMessage）。
  // name 字段标识 agent 身份（诊断用，GUI 不依赖）；version 为 yfwturbo dev 版本线
  // （version.mjs 单一数据源，与 GUI 发布版本相互独立）。
  log.info('kernel start', { model, resume: Boolean(args.resume), cwd: args.addDirs[0] || '' })
  wire.system('init', { model, tools: engine.toolNames, session_id: sessionId, name: 'YFWorking', version: YFW_VERSION })
  // --resume：从 transcript 恢复（load 为 async 流式；同文件即 GUI 读取的权威源）。
  // 历史由 session.deriveMessages() 派生，engine 无需 seedHistory（seedHistory 已随
  // Task 5 迁移移除）。
  if (args.resume) {
    await store.load()
  }

  const state = { turnActive: false, queue: [], cancelling: false }

  async function handleUser(msg) {
    const content = extractContent(msg)
    state.turnActive = true
    try {
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
      state.turnActive = false
      state.cancelling = false
      const nextMsg = state.queue.shift()
      if (nextMsg) void handleUser(nextMsg)
    }
  }

  function handleControlRequest(req) {
    const subtype = req?.request?.subtype
    if (subtype === 'cancel') {
      state.cancelling = true
      engine.abort()
      // 取消语义含丢弃排队输入（用户后续消息不再执行）
      state.queue = []
      // 无活跃轮次时的空转 cancel：直接完成（契约 §8，bridge 依赖 result
      // 复位 _cancelPending；mock 同语义）
      if (!state.turnActive) {
        wire.assistant('已取消。')
        wire.result()
        state.cancelling = false
      }
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
      if (state.turnActive) state.queue.push(parsed)
      else void handleUser(parsed)
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
