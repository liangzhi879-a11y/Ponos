// 实证验证内核高风险命令审批链路（spec §11.1 → §4.2 固化格式）
// 用法: node scripts/verify-permission-flow.mjs [allow|deny] [--dump]
//   - 用 stream-json 模式拉起 dev 内核，指示 agent 用 Bash 删除一个临时文件
//   - 观察 stdout 上 can_use_tool control_request（挂起）
//   - 注入 control_response（allow: 批准执行 / deny: 拒绝），观察 tool_result
//   - --dump 时把所有关键行完整打印（不截断），用于固化协议格式
// 退出码: 0 = 观察到 control_request 且收到符合预期的 tool_result；1 = 失败/超时
import { spawn, execSync } from 'child_process'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'fs'

const BUN = join(homedir(), '.bun', 'bin', 'bun.exe')
const KERNEL = join(process.cwd(), 'ponos-kernel', 'claude-code', 'dist', 'cli.mjs')
const PONOS_HOME = join(homedir(), '.ponos')

const mode = (process.argv[2] || 'allow').toLowerCase()
const dump = process.argv.includes('--dump')
if (mode !== 'allow' && mode !== 'deny') {
  console.error('用法: node scripts/verify-permission-flow.mjs [allow|deny] [--dump]')
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(join(PONOS_HOME, 'config.json'), 'utf-8'))
const provider = (cfg.providers || []).find(p => p.id === cfg.activeProvider) || (cfg.providers || [])[0]
if (!provider || !provider.apiBaseUrl || !provider.authToken) {
  console.error('config.json 缺少可用 provider')
  process.exit(1)
}
const model = provider.primaryModel || (provider.models && provider.models[0]) || ''

const tmpDir = process.env.TEMP || join(homedir(), 'AppData', 'Local', 'Temp')
const testFile = join(tmpDir, 'ponos-hr-test-' + Date.now() + '.txt')
writeFileSync(testFile, 'highrisk permission flow test', 'utf-8')
const posixFile = testFile.replace(/\\/g, '/')

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: PONOS_HOME,
  ANTHROPIC_BASE_URL: provider.apiBaseUrl,
  ANTHROPIC_AUTH_TOKEN: provider.authToken,
  ANTHROPIC_MODEL: model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  ANTHROPIC_DEFAULT_OPUS_MODEL: model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.subagentModel || model,
  CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: 'true',
}

// --permission-prompt-tool stdio: 让内核的 ask 决策走 can_use_tool
// control_request/control_response 协议（否则非交互 print 模式下 ask 会直接
// 退化为 deny，没有任何批准途径——实证发现，见 spec §11.1）
const args = [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--verbose', '--dangerously-skip-permissions', '--disallowedTools', 'AskUserQuestion',
  '--permission-prompt-tool', 'stdio',
  '--add-dir', tmpDir,
]

console.log(`[flow] mode=${mode} kernel=${KERNEL}`)
console.log(`[flow] testFile=${posixFile}`)
const proc = spawn(`"${BUN}" "${KERNEL}"`, args, {
  stdio: ['pipe', 'pipe', 'pipe'], env, cwd: tmpDir, shell: true,
})

let controlRequest = null
let toolResult = null
let resultMsg = null
let done = false

const finish = (code, msg) => {
  if (done) return
  done = true
  if (msg) console.log(msg)
  // shell:true 下 proc 是 cmd.exe，bun 内核是其子进程，proc.kill() 杀不干净——
  // Windows 统一用 taskkill 整树强杀，确保测试内核不残留。
  try {
    if (process.platform === 'win32' && proc.pid) {
      execSync(`taskkill -F -T -PID ${proc.pid}`, { timeout: 3000, stdio: 'ignore' })
    }
  } catch { try { proc.kill() } catch {} }
  try { rmSync(testFile, { force: true }) } catch {}
  process.exit(code)
}

const globalTimeout = setTimeout(() => {
  finish(1, `[flow] 超时（300s）: controlRequest=${!!controlRequest} toolResult=${!!toolResult}`)
}, 300000)

const logLine = (tag, line) => console.log(`[${tag}] ${line}`)

createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let parsed = null
  try { parsed = JSON.parse(t) } catch {}
  if (!parsed) return

  // 关键信号 1: can_use_tool control_request（内核挂起等待审批）
  if (parsed.type === 'control_request' && parsed.request?.subtype === 'can_use_tool') {
    controlRequest = parsed
    if (dump) logLine('CONTROL_REQUEST', t)
    else logLine('CONTROL_REQUEST', JSON.stringify({
      request_id: parsed.request_id,
      tool_name: parsed.request.tool_name,
      tool_use_id: parsed.request.tool_use_id,
      decision_reason: parsed.request.decision_reason,
      command: parsed.request.input?.command,
    }))
    const req = parsed.request
    const response = {
      type: 'control_response',
      response: {
        request_id: parsed.request_id,
        subtype: 'success',
        response: mode === 'allow'
          ? { behavior: 'allow', updatedInput: {}, toolUseID: req.tool_use_id, decisionClassification: 'user_temporary' }
          : { behavior: 'deny', message: 'User denied the high-risk operation', toolUseID: req.tool_use_id },
      },
    }
    const payload = JSON.stringify(response) + '\n'
    if (dump) logLine('INJECT', payload.trim())
    else logLine('INJECT', `control_response ${mode} request_id=${parsed.request_id}`)
    proc.stdin.write(payload)
    return
  }

  // 关键信号 2: Bash 工具结果（is_error=true 表示被拒绝）
  if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
    for (const b of parsed.message.content) {
      if (b.type === 'tool_result') {
        toolResult = b
        if (dump) logLine('TOOL_RESULT', JSON.stringify(b))
        else logLine('TOOL_RESULT', `is_error=${b.is_error ? 'true' : 'false'} content=${String(b.content).slice(0, 200)}`)
      }
    }
    return
  }

  if (parsed.type === 'result') {
    resultMsg = parsed
    logLine('RESULT', dump ? t : `is_error=${parsed.is_error} result=${String(parsed.result || '').slice(0, 200)}`)
    return
  }

  // 助手文本：提示 agent 是否直接执行了（未触发审批）
  if (parsed.type === 'assistant') {
    const txt = (parsed.message?.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join(' ')
    if (txt.trim() && /(删|删除|rm|del)/.test(txt)) {
      logLine('TEXT', txt.slice(0, 300))
    }
  }
})

createInterface({ input: proc.stderr, crlfDelay: Infinity }).on('line', (l) => {
  if (/error|Error|warn/i.test(l)) logLine('stderr', l.slice(0, 300))
})

proc.on('error', (e) => finish(1, `[flow] spawn error: ${e.message}`))
proc.on('close', (code) => {
  if (!done) finish(1, `[flow] 内核提前退出 code=${code} controlRequest=${!!controlRequest} toolResult=${!!toolResult}`)
})

// 等待 tool_result 或 result 出现后校验
const poll = setInterval(() => {
  if (!toolResult && !resultMsg) return
  clearInterval(poll)
  clearTimeout(globalTimeout)
  if (mode === 'allow') {
    if (toolResult && !toolResult.is_error) {
      finish(0, `[flow] PASS: 批准后命令执行，tool_result 非错误`)
    } else if (resultMsg) {
      finish(0, `[flow] PASS(结果级): 批准流程完整走通`)
    } else {
      finish(1, `[flow] FAIL: 批准后 tool_result 仍为 is_error`)
    }
  } else {
    if (toolResult && toolResult.is_error) {
      finish(0, `[flow] PASS: 拒绝后 tool_result 为 is_error（agent 收到拒绝）`)
    } else if (toolResult && !toolResult.is_error) {
      finish(1, `[flow] FAIL: 拒绝后命令仍执行成功`)
    } else if (resultMsg) {
      // 会话级 result 到达：拒绝的效果体现在文件是否被删除（代理收到的
      // 错误文本 / permission_denials 记录），不在 resultMsg.is_error 上。
      if (existsSync(testFile)) {
        finish(0, `[flow] PASS: 拒绝后文件未被删除（agent 收到拒绝）`)
      } else {
        finish(1, `[flow] FAIL: 拒绝后文件仍被删除`)
      }
    }
  }
}, 500)

// 提示词：明确授权删除，强制走 Bash 工具
const prompt = `请使用 Bash 工具执行一次文件删除操作。这是用户明确批准的一次性测试删除，请直接执行，不要再询问确认。

要删除的文件（Windows 路径，请转换为 bash 可用的形式）:
${posixFile}

要求：
1. 必须使用 Bash 工具执行，不要使用其它工具。
2. 直接执行删除，不要询问、不要犹豫。
3. 执行后简短报告结果（成功/失败）。`

proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
