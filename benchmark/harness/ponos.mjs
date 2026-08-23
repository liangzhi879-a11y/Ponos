// Ponos-turbo 内核适配器（预留接口，独立模块）
// ---------------------------------------------------------------------------
// 驱动方式：stdin NDJSON 契约（docs/bridge-contract.md）
//   1. spawn kernel/cli.mjs --print --output-format stream-json --input-format stream-json
//      --dangerously-skip-permissions --model <m> --add-dir <ws>
//   2. 等 stdout 出现 system/init → 写 user 消息
//   3. 收集 assistant / result；result 出现即本轮完成 → 关闭 stdin 优雅退出
//
// 【内核完善后如何同步进来跑】
//   - 工具面扩展（Read 的 offset/limit、Grep/Glob 等）：本适配器无需改动，
//     自动随 kernel/tools.mjs 生效；仅当 wire 契约变化时才需要更新本文件。
//   - 新的 CLI 参数：在下方 args 数组追加即可。
//   - 子代理/定时任务等外围能力：评测任务暂不依赖，后续任务集扩展时在
//     tasks/ 新增任务即可，无需改动本文件。
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveModel, buildAgentEnv } from '../lib/llm-api.mjs'

// Node 24 兼容垫片：剥离内核传给 fetch 的非 AbortSignal 信号（见 ponos-fetch-shim.mjs）
const shimUrl = pathToFileURL(fileURLToPath(new URL('./ponos-fetch-shim.mjs', import.meta.url))).href
// ponos 内核自身不带系统提示（需调用方经 --append-system-prompt-file 注入），
// 评测注入一份标准 agent 系统提示，与 claude/pi/deepseek 自带提示对齐，
// 使对比聚焦于内核工具循环能力而非缺失提示词（见 ponos-system-prompt.md）
const systemPromptFile = fileURLToPath(new URL('./ponos-system-prompt.md', import.meta.url))

export async function runPonos({ ws, prompt, timeoutMs, onLog, kernelDir }) {
  // 内核入口始终从内核仓库启动（kernel/cli.mjs 相对路径依赖 kernelDir），
  // --add-dir ws 让内核工具面（Read/Grep/Bash 等）作用于任务工作区。
  // 普通任务 ws 就是内核仓库的 worktree（kernelDir 缺省回退 ws，行为不变）；
  // SWE-bench 任务 ws 是外部仓库 worktree，kernelDir 必须显式传内核仓库。
  const kernelRoot = kernelDir || ws
  const args = [
    '--import', shimUrl,
    'kernel/cli.mjs',
    '--append-system-prompt-file', systemPromptFile,
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--auto-approve-high-risk',
    // 评测任务不依赖子代理分发：禁用 Agent/Task，避免模型分发 subagent 引入
    // 额外变量（内核 --disallowedTools 过滤，2026-08-21 使其真正生效）
    '--disallowedTools', 'Agent,Task',
    '--model', resolveModel(),
    '--add-dir', ws,
  ]
  return new Promise((resolve) => {
    // buildAgentEnv('ponos')：统一注入 ANTHROPIC_AUTH_TOKEN + baseUrl（DeepSeek 兼容端点）
    // PONOS_PROMPT_CACHE=1：显式启用 system prompt cache（内核侧带回退，端点拒绝缓存
    // 字段时自动去掉重发），多任务间共享系统提示缓存、压低成本
    const child = spawn(process.execPath, args, { cwd: kernelRoot, env: { ...buildAgentEnv('ponos'), PONOS_PROMPT_CACHE: '1' }, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let initSeen = false
    let userSent = false
    let done = false
    // usage 累加 input/output/cache_read/cache_creation：内核 result 事件在
    // usage 字段含全部四类（原始 stream 事件的 cache_read_input_tokens 仅在
    // message_start 单独出现，result 已汇总），此处全量累加便于成本/缓存分析
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    let toolCalls = 0

    // result 事件只记账（usage/toolCalls）并 end stdin 请求内核退出，但
    // 不 resolve——内核发出 result 后进程尚未退出（会话落盘/记忆捕获等收尾
    // 仍在进行，agent 最后一批文件写入可能恰在 result 之后），立即 resolve
    // 会让 run.mjs 的 verify 读到过期文件产生"假 FAIL"（实测 T002：agent
    // 修复正确但 verify 读到旧 cli.mjs）。统一等 child close（进程真正退出）
    // 再 resolve，保证 verify 面 = 最终文件态。
    let resultSeen = false
    const finish = (exitCode) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut, usage, toolCalls })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { }
      finish(-1)
    }, timeoutMs)

    // 逐行解析 NDJSON 事件
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      stdout += line + '\n'
      onLog?.('out', line)
      if (!line.trim().startsWith('{')) return
      let ev
      try { ev = JSON.parse(line) } catch { return }
      if (ev.type === 'system' && ev.subtype === 'init' && !userSent) {
        // init 即内核就绪：发首条 user；工具循环的后续 user（tool_result）
        // 由内核内部处理，不再经过 stdin
        userSent = true
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
        return
      }
      if (ev.type === 'assistant') {
        const blocks = ev.message?.content
        if (Array.isArray(blocks)) toolCalls += blocks.filter((b) => b.type === 'tool_use').length
      }
      if (ev.type === 'result' && userSent) {
        resultSeen = true
        const u = ev.usage
        if (u) {
          usage.input_tokens += u.input_tokens || 0
          usage.output_tokens += u.output_tokens || 0
          usage.cache_read_input_tokens += u.cache_read_input_tokens || 0
          usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0
        }
        // 请求内核优雅退出（stdin EOF → exit 0）；resolve 留到 close
        try { child.stdin.end() } catch { }
      }
    })
    const rle = createInterface({ input: child.stderr, crlfDelay: Infinity })
    rle.on('line', (l) => { stderr += l + '\n'; onLog?.('err', l) })
    child.on('error', (e) => { stderr += 'SPAWN_ERROR: ' + e.message + '\n'; finish(-2) })
    child.on('close', (code) => finish(code ?? 0))
  })
}
