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
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from './engine.mjs'
import { makeWire } from './protocol.mjs'
import { createSessionStore, newSessionId } from './session.mjs'

const REQUIRED_FORMAT = 'stream-json'

function usage() {
  console.error(
    'YFW-turbo kernel: --print --output-format stream-json --input-format stream-json ' +
    '[--verbose] [--dangerously-skip-permissions] [--permission-prompt-tool stdio] ' +
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

  const engine = createEngine({
    opts: {
      model: args.model,
      resumeId: args.resume,
      addDirs: args.addDirs,
      systemPrompt: readPromptFile(args.appendSystemPromptFile),
      verbose: args.verbose,
      skipPermissions: args.skipPermissions,
    },
    wire,
  })
  // system(init)：spawn 即发。bridge /test-provider 判定 CLI 加载成功并读取
  // model/tools；GUI 从 session_id 绑定会话（useYFWCLI.ts handleMessage）。
  // name 字段标识净室引擎代号（诊断用，GUI 不依赖）。
  const model = args.model || process.env.ANTHROPIC_MODEL || ''
  wire.system('init', { model, tools: engine.toolNames, session_id: sessionId, name: 'YFW-turbo' })
  // --resume：从 transcript 恢复历史（load 为 async 流式；同文件即 GUI 读取的
  // 权威源）。本任务 engine 仍走内存 seedHistory（engine 迁移到 session 派生在
  // Task 5 完成，届时此处简化为仅 await store.load()）
  if (args.resume) {
    const { entries } = await store.load()
    const history = entries.filter((e) => e?.type === 'user' || e?.type === 'assistant')
    engine.seedHistory(history.map((e) => e.message))
  }

  const state = { turnActive: false, queue: [], cancelling: false }

  async function handleUser(msg) {
    const content = extractContent(msg)
    const userEntry = store.userEntry(content)
    store.append(userEntry)
    state.turnActive = true
    try {
      const { usage, text, model: turnModel } = await engine.runTurn({ content, msg })
      wire.result(usage)
      // 轮次落盘（transcript 权威源；assistant content 为块数组，含 usage/model）
      store.append(store.assistantEntry([{ type: 'text', text }], { usage, model: turnModel }))
    } catch (err) {
      if (err?.name === 'AbortError' || state.cancelling) {
        wire.assistant('已取消。')
        wire.result()
        store.append(store.assistantEntry([{ type: 'text', text: '已取消。' }]))
      } else {
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
  rl.on('close', () => process.exit(0))
  return 0
}

// 直接执行（import 时跳过，测试可复用 parseArgs/main）。main 为 async，
// Promise 落地 exitCode；load 失败（流式读错误）时以 1 退出并报错，避免悬空。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
    .catch((err) => { console.error('kernel:', err); process.exitCode = 1 })
}
