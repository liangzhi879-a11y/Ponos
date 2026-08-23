// Agent 适配器层：把 4 个被测内核统一成 runTask(ws, prompt) → 运行记录
// ---------------------------------------------------------------------------
// 契约：
//   runTask(ctx) → { exitCode, output, stderr, durationMs, usageTokens, toolCalls }
//   ctx = { ws, prompt, model, timeoutMs, onLog }
// 每个适配器独立模块（ponos 单独文件），内核完善后仅需更新 ponos.mjs 即可重跑。
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveModel, buildAgentEnv, apiKeyFor } from '../lib/llm-api.mjs'

// ── 通用小工具 ────────────────────────────────────────────────────────────────

/** 按行收集子进程 stdout/stderr 并逐行回调；返回 exit 信息 */
export function runProcess({ cmd, args, cwd, env, timeoutMs, stdin, onLine, onErr }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolve({ exitCode: -1, stdout, stderr, timedOut: true })
      }
    }, timeoutMs)
    const done = (rc) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: rc, stdout, stderr, timedOut: false })
    }
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
      rl.on('line', (l) => { stdout += l + '\n'; onLine?.(l) })
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr, crlfDelay: Infinity })
      rl.on('line', (l) => { stderr += l + '\n'; onErr?.(l) })
    }
    child.on('error', (e) => { stderr += 'SPAWN_ERROR: ' + e.message + '\n'; done(-2) })
    child.on('close', (code) => done(code ?? 0))
    // stdin 未传时也立即 EOF（child.stdin.end()）：pi 等 stdin 的子进程
    // 若 pipe 保持打开会一直挂起等待输入（-p 非交互模式同样如此）
    if (child.stdin) {
      child.stdin.on('error', () => {})
      if (stdin !== undefined) child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

// ── Claude Code（全局 CLI，非交互 -p 模式，jsonl 输出）────────────────────────
// Windows 下 npm 全局 bin 是原生 exe（bin/claude.exe），spawn 需用真实路径
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const candidates = [
    'C:/Users/T203-15/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    'claude',
  ]
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch { /* 继续 */ }
  }
  return 'claude'
}

export async function runClaude({ ws, prompt, timeoutMs, onLog }) {
  const bin = resolveClaudeBin()
  const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']
  const r = await runProcess({
    cmd: bin, args, cwd: ws, env: buildAgentEnv('claude'), timeoutMs,
    onLine: (l) => onLog?.('out', l),
    onErr: (l) => onLog?.('err', l),
  })
  // stream-json 事件里提取 usage：
  //  - assistant 事件的 usage 是「每轮请求增量」（实测 input_tokens=584、183…），
  //    覆盖取末值会把整轮用量压到最后一轮增量 → 用量/成本严重低估
  //    （claude-T001 全程累计 input_tokens=39602，旧逻辑只记到 183）
  //  - 最终 result 事件（含 is_error 布尔字段）才携带全程累计 usage，优先采用；
  //    未找到时回退累加各 assistant 增量
  let usage = null
  let acc = { input_tokens: 0, output_tokens: 0 }
  let toolCalls = 0
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'assistant' && ev.message?.usage) {
        acc.input_tokens += ev.message.usage.input_tokens || 0
        acc.output_tokens += ev.message.usage.output_tokens || 0
      }
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        toolCalls += ev.message.content.filter((b) => b.type === 'tool_use').length
      }
      if (typeof ev.is_error === 'boolean' && ev.usage) {
        usage = { input_tokens: ev.usage.input_tokens || 0, output_tokens: ev.usage.output_tokens || 0 }
      }
    } catch { /* 忽略非 json 行 */ }
  }
  return { ...r, usage: usage || acc, toolCalls }
}

// ── pi coding-agent（需先构建；vendors/pi-src/pi-main/packages/coding-agent/dist/cli.js）
// 运行要点：
//  - 默认 provider 是 google，不打 DeepSeek 端点 → 403；须显式 --provider deepseek --model
//  - DeepSeek 认证走 DEEPSEEK_API_KEY（pi 无 ANTHROPIC_BASE_URL 概念，只认 provider 内置 baseUrl）
//  - -p 非交互模式；verbose 不开（普通输出即可）
export async function runPi({ ws, prompt, timeoutMs, onLog }) {
  const piCli = process.env.PI_CLI_PATH || join(process.cwd(), 'benchmark', 'vendors', 'pi-src', 'pi-main', 'packages', 'coding-agent', 'dist', 'cli.js')
  if (!existsSync(piCli)) {
    return { exitCode: -3, stdout: '', stderr: `pi CLI not built: ${piCli}（先构建：npm install + build）`, usage: null, toolCalls: 0 }
  }
  const model = process.env.PI_MODEL || resolveModel()
  const r = await runProcess({
    cmd: process.execPath,
    args: [piCli, '-p', '--provider', 'deepseek', '--model', model, prompt],
    cwd: ws,
    env: buildAgentEnv('pi'),
    timeoutMs,
    onLine: (l) => onLog?.('out', l),
    onErr: (l) => onLog?.('err', l),
  })
  return { ...r, usage: null, toolCalls: countPiTools(r.stdout) }
}

function countPiTools(stdout) {
  // pi 的 stderr/日志中工具事件形如 [tool:bash] 或 tool_use —— 宽松统计
  return (stdout.match(/\[tool:[a-z_-]+\]/gi) || []).length
}

// ── deepseek-harness（tsx 直接跑，无需构建）───────────────────────────────────
export async function runDeepseek({ ws, prompt, timeoutMs, onLog }) {
  const dshBin = process.env.DSH_BIN_PATH || join(process.cwd(), 'benchmark', 'vendors', 'deepseek-src', 'deepseek-harness-master', 'apps', 'cli', 'src', 'bin.ts')
  if (!existsSync(dshBin)) {
    return { exitCode: -3, stdout: '', stderr: `dsh bin not found: ${dshBin}`, usage: null, toolCalls: 0 }
  }
  // tsx 装在 vendor 根 node_modules，--import tsx/esm 须用绝对路径（cwd 是任务工作区，
  // 模块解析不到 vendor 依赖；包 exports 映射 './esm' → dist/esm/index.mjs）
  const tsxEsm = join(process.cwd(), 'benchmark', 'vendors', 'deepseek-src', 'deepseek-harness-master', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
  if (!existsSync(tsxEsm)) {
    return { exitCode: -3, stdout: '', stderr: `tsx esm not found: ${tsxEsm}`, usage: null, toolCalls: 0 }
  }
  const r = await runProcess({
    cmd: process.execPath,
    args: ['--import', pathToFileURL(tsxEsm).href, dshBin, '--profile', 'headless', prompt],
    // DEEPSEEK_API_KEY 由 llm-api 统一注入；FORCE_COLOR=0 关闭彩色输出便于解析
    cwd: ws, env: { ...buildAgentEnv('deepseek'), FORCE_COLOR: '0' }, timeoutMs,
    onLine: (l) => onLog?.('out', l),
    onErr: (l) => onLog?.('err', l),
  })
  return { ...r, usage: null, toolCalls: countDeepseekTools(r.stdout) }
}

function countDeepseekTools(stdout) {
  return (stdout.match(/tool[_:\s]+(?:call|use)/gi) || []).length
}
