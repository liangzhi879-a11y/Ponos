// 实证验证内核高风险命令审批链路（spec §11.1 → §4.2 固化格式）
// 用法: node scripts/verify-permission-flow.mjs [allow|deny] [--dump] [--mode=<档位>]
//   - 用 stream-json 模式拉起 dev 内核，指示 agent 用 Bash 删除一个临时文件
//   - 观察 stdout 上 can_use_tool control_request（挂起）
//   - 注入 control_response（allow: 批准执行 / deny: 拒绝），观察 tool_result
//   - --dump 时把所有关键行完整打印（不截断），用于固化协议格式
//   - --mode=manual|auto|loose|bypass：按**桥的真实 spawn 参数**拉起内核
//     （server/approval-mode.mjs 的 approvalSpawnArgs），用于观察四档下谁弹窗。
//     不传 --mode= 时保持历史行为：固定 --dangerously-skip-permissions（= loose）。
//     ⚠ 注意 `--mode=` 指的是**审批档位**；位置参数 [allow|deny] 是**本次回答**。
//       manual 档下即使"删单个文件"（无 -rf）也会弹窗（普通 Bash 属 ask 类）；
//       bypass 档下不弹窗、agent 直接删掉临时文件 → 走 PASS(结果级)。
// 退出码: 0 = 观察到 control_request 且收到符合预期的 tool_result；1 = 失败/超时
import { spawn, execSync } from 'child_process'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolveYfwHome } from '../server/yfw-home.cjs'
import { APPROVAL_MODES, approvalSpawnArgs } from '../server/approval-mode.mjs'

// 运行时 = node（D1）：与 bridge 实际 spawn 方式一致——净室零 bun（D1 不随包）。
const RUNTIME = process.execPath
// 内核 = kernel-dist/cli.mjs（bundle 形态：scripts/build-kernel.mjs 的
// --target=node 单文件 ESM 产物，node 直跑）；bundle 缺失时先构建该文件。
const KERNEL = join(process.cwd(), 'kernel-dist', 'cli.mjs')
const YFW_HOME = resolveYfwHome()

// 先分离 flag 与位置参数：`--mode=manual` 若当位置参数解析会误判成非法决策值
const USAGE = '用法: node scripts/verify-permission-flow.mjs [allow|deny] [--dump] [--mode=manual|auto|loose|bypass]'
const argv = process.argv.slice(2)
const flags = argv.filter(a => a.startsWith('--'))
const positional = argv.filter(a => !a.startsWith('--'))
const decision = (positional[0] || 'allow').toLowerCase()
const dump = flags.includes('--dump')
if (decision !== 'allow' && decision !== 'deny') {
  console.error(USAGE)
  process.exit(1)
}
// 未传 = null = 历史行为（固定 skip flag），传了就必须是合法档位（不静默回退）
const modeFlag = flags.find(a => a.startsWith('--mode='))
const approvalMode = modeFlag ? modeFlag.slice('--mode='.length).toLowerCase() : null
if (approvalMode !== null && !APPROVAL_MODES.includes(approvalMode)) {
  console.error(`${USAGE}\n  非法档位: ${approvalMode}（可选 ${APPROVAL_MODES.join('/')}）`)
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(join(YFW_HOME, 'config.json'), 'utf-8'))
const provider = (cfg.providers || []).find(p => p.id === cfg.activeProvider) || (cfg.providers || [])[0]
if (!provider || !provider.apiBaseUrl || !provider.authToken) {
  console.error('config.json 缺少可用 provider')
  process.exit(1)
}
const model = provider.primaryModel || (provider.models && provider.models[0]) || ''

const tmpDir = process.env.TEMP || join(homedir(), 'AppData', 'Local', 'Temp')
const testFile = join(tmpDir, 'yfw-hr-test-' + Date.now() + '.txt')
writeFileSync(testFile, 'highrisk permission flow test', 'utf-8')
const posixFile = testFile.replace(/\\/g, '/')

const env = {
  ...process.env,
  PONOS_CONFIG_DIR: YFW_HOME,
  PONOS_BASE_URL: provider.apiBaseUrl,
  PONOS_AUTH_TOKEN: provider.authToken,
  PONOS_MODEL: model,
  PONOS_DEFAULT_SONNET_MODEL: model,
  PONOS_DEFAULT_OPUS_MODEL: model,
  PONOS_DEFAULT_HAIKU_MODEL: provider.subagentModel || model,
}

// --permission-prompt-tool stdio: 让内核的 ask 决策走 can_use_tool
// control_request/control_response 协议（否则非交互 print 模式下 ask 会直接
// 退化为 deny，没有任何批准途径——实证发现，见 spec §11.1）
const args = [
  '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--verbose',
  // 档位 flag 与桥**同一实现**（approvalSpawnArgs）：loose/bypass 带 skip flag，
  // manual/auto 不带 —— 若在这里手写一份，脚本验证的就不是桥真正发出的东西了。
  ...(approvalMode ? approvalSpawnArgs(approvalMode) : ['--dangerously-skip-permissions']),
  '--disallowedTools', 'AskUserQuestion',
  '--permission-prompt-tool', 'stdio',
  '--add-dir', tmpDir,
]

console.log(`[flow] decision=${decision} approvalMode=${approvalMode ?? '(未传 → 历史 skip flag = loose)'} kernel=${KERNEL}`)
console.log(`[flow] spawn args: ${args.join(' ')}`)
console.log(`[flow] testFile=${posixFile}`)
const proc = spawn(`"${RUNTIME}" "${KERNEL}"`, args, {
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
  // shell:true 下 proc 是 cmd.exe，node 内核是其子进程，proc.kill() 杀不干净——
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
      // hard/mode 是 2026-09-12 新增字段（硬黑名单 / 生效档位），一并固化进摘要
      hard: parsed.request.hard === true,
      mode: parsed.request.mode,
      command: parsed.request.input?.command,
    }))
    const req = parsed.request
    const response = {
      type: 'control_response',
      response: {
        request_id: parsed.request_id,
        subtype: 'success',
        response: decision === 'allow'
          ? { behavior: 'allow', updatedInput: {}, toolUseID: req.tool_use_id, decisionClassification: 'user_temporary' }
          : { behavior: 'deny', message: 'User denied the high-risk operation', toolUseID: req.tool_use_id },
      },
    }
    const payload = JSON.stringify(response) + '\n'
    if (dump) logLine('INJECT', payload.trim())
    else logLine('INJECT', `control_response ${decision} request_id=${parsed.request_id}`)
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
  if (decision === 'allow') {
    if (toolResult && !toolResult.is_error) {
      finish(0, `[flow] PASS: 批准后命令执行，tool_result 非错误`)
    } else if (resultMsg) {
      // bypass 档到这里是正常路径：压根没弹窗、没有 tool_result 事件，
      // agent 直接执行完收尾（此时文件已被删除，见下方 else 分支的对照）。
      finish(0, `[flow] PASS(结果级): 批准流程完整走通${approvalMode === 'bypass' && !controlRequest ? '（bypass 未弹窗，符合预期）' : ''}`)
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
