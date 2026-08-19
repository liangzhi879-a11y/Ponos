// 契约参考 mock 内核（净室测试套件 fixture，见 docs/bridge-contract.md）
// ---------------------------------------------------------------------------
// 实现 bridge-contract §2/§3/§4 的内核侧 wire 协议：
//   - 启动：node mock-kernel.mjs --print --output-format stream-json ...（argv 原样记录）
//   - stdin  ：NDJSON（user / control_request / control_response）
//   - stdout ：NDJSON（assistant / result / control_request / bridge_request）+ 可 raw 行
// 用途：
//   1) kernel-contract.test.mjs 直连断言 wire 语义（净室引擎重建的对照基线）；
//   2) bridge-contract.test.mjs 以 mock 为内核做 GUI↔bridge 集成回归。
// 环境变量：
//   MOCK_LOG         JSONL 输出路径：记录 argv/env/stdin 输入/退出（测试断言数据源）
//   MOCK_SCENARIO    默认场景名（可被用户消息内 [scenario:X] 标签覆盖）
// 场景（用户消息内容含 [scenario:X] 或 MOCK_SCENARIO 指定）：
//   plain        默认：assistant(text=echo: <content>) + result
//   milestones   输出 <!--MILESTONES/START/OK--> 标记文本 → bridge 提取/剥离
//   askuser      输出 <!--ASK_USER...--> 卡片 → bridge 解析为 question 事件
//   approval     输出 can_use_tool control_request 挂起，等 control_response 后完成
//   browser      输出 bridge_request(route=browser)，等 browser_response 后完成
//   slow         立即 assistant，延迟 5s 才 result（cancel 场景：收到 cancel 立即 result）
//   raw          先输出一行非 JSON 行（bridge 以 raw 事件转发），再 assistant + result
//   stream       连续输出 3 个 assistant 事件后 result（流式转发回归）

import { createInterface } from 'node:readline'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MOCK_LOG = process.env.MOCK_LOG
const SCENARIO_RE = /\[scenario:(\w+)\]/

function log(record) {
  if (!MOCK_LOG) return
  try {
    mkdirSync(dirname(MOCK_LOG), { recursive: true })
    appendFileSync(MOCK_LOG, JSON.stringify(record) + '\n', 'utf-8')
  } catch {}
}

function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch {}
}

// --- 启动记录：argv（§2 spawn 契约）与关键 env（§2 buildChildEnv 契约）---
log({ t: 'start', pid: process.pid })
log({ t: 'argv', argv: process.argv.slice(2) })
log({
  t: 'env',
  env: Object.fromEntries(
    ['CLAUDE_CONFIG_DIR', 'YFWORKING_HOME', 'CLAUDE_CODE_AGENT_TRIGGERS',
     'ANTHROPIC_MODEL', 'YFW_HEALTH_COMPACT_COUNT', 'MOCK_SCENARIO', 'MOCK_LOG']
      .filter(k => process.env[k] !== undefined)
      .map(k => [k, process.env[k]])
  ),
})

const state = {
  defaultScenario: process.env.MOCK_SCENARIO || 'plain',
  waitingApproval: false,
  waitingBrowser: false,
  slowTimer: null,
}

function currentScenario(content) {
  const m = String(content || '').match(SCENARIO_RE)
  return m ? m[1] : state.defaultScenario
}

function finishTurn() {
  emit({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 10, output_tokens: 20 },
    session_id: 'mock',
  })
}

function emitAssistant(text, extraBlocks = []) {
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }, ...extraBlocks],
    },
    uuid: 'mock-uuid-' + Date.now(),
  })
}

function handleUser(msg) {
  const content = (msg && msg.message && msg.message.content) || ''
  const scenario = currentScenario(content)
  switch (scenario) {
    case 'milestones':
      emitAssistant([
        '<!--MILESTONES 3 需求分析|方案设计|编码实现-->',
        '<!--MILESTONE-START 1/3 需求分析-->',
        '正在做需求分析。',
        '<!--MILESTONE-OK 1/3 需求分析-->',
        '需求分析完成。',
      ].join('\n'))
      finishTurn()
      break
    case 'askuser':
      emitAssistant(
        '需要确认方向：\n\n<!--ASK_USER\n{\n  "questions": [{\n    "id": "q1",\n    "header": "确认",\n    "question": "采用哪种方案？",\n    "options": [\n      {"label": "方案A", "description": "快速实现"},\n      {"label": "方案B", "description": "稳健优先"}\n    ],\n    "multiSelect": false\n  }],\n  "context": "mock 内核测试卡片"\n}\n-->\n\n（等待用户回答）'
      )
      finishTurn()
      break
    case 'approval':
      state.waitingApproval = true
      emit({
        type: 'control_request',
        request_id: 'mock-approval-1',
        request: {
          subtype: 'can_use_tool',
          tool_use_id: 'tool_approve_1',
          tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/mock-target', description: 'mock 高危命令' },
          decision_reason: '命令为高危操作，需要用户批准',
        },
      })
      // 挂起等待 control_response —— 不在此处 result
      break
    case 'browser':
      state.waitingBrowser = true
      emit({
        type: 'bridge_request',
        route: 'browser',
        requestId: 'mock-browser-1',
        payload: { method: 'navigate', url: 'https://example.com/mock', sessionId: 'mock-session' },
      })
      // 挂起等待 browser_response control_request —— 不在此处 result
      break
    case 'slow':
      state.slowTimer = setTimeout(() => {
        state.slowTimer = null
        emitAssistant('slow 场景完成。')
        finishTurn()
      }, 5000)
      state.slowTimer.unref?.()
      emitAssistant('slow 场景开始，请稍候…')
      break
    case 'raw':
      try { process.stdout.write('raw-line-from-mock\n') } catch {}
      emitAssistant('raw 场景完成。')
      finishTurn()
      break
    case 'stream':
      for (let i = 1; i <= 3; i++) emitAssistant(`流式块 ${i}/3`)
      finishTurn()
      break
    default: // plain
      emitAssistant('echo: ' + content.slice(0, 120))
      finishTurn()
  }
}

function handleControlRequest(req) {
  const subtype = req && req.request && req.request.subtype
  if (subtype === 'cancel') {
    // 契约 §8：cancel 后内核完成被中断轮次（发 result）且进程保持存活可续聊
    if (state.slowTimer) { clearTimeout(state.slowTimer); state.slowTimer = null }
    if (state.waitingApproval) state.waitingApproval = false
    if (state.waitingBrowser) state.waitingBrowser = false
    emitAssistant('已取消。')
    finishTurn()
    return
  }
  if (subtype === 'browser_response') {
    if (state.waitingBrowser) {
      state.waitingBrowser = false
      emitAssistant('browser 完成: ' + JSON.stringify(req.request.response || {}).slice(0, 80))
      finishTurn()
    }
    return
  }
  // 未知 control_request（如 interrupt）：仅记录
}

function handleControlResponse(resp) {
  const inner = resp && resp.response && resp.response.response
  if (state.waitingApproval && inner && inner.toolUseID) {
    state.waitingApproval = false
    emitAssistant('approval 完成: behavior=' + (inner.behavior || 'unknown'))
    finishTurn()
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let parsed = null
  try { parsed = JSON.parse(t) } catch {}
  if (!parsed) { log({ t: 'stdin-nonjson', raw: t }); return }
  log({ t: 'stdin', data: parsed })
  if (parsed.type === 'user') handleUser(parsed)
  else if (parsed.type === 'control_request') handleControlRequest(parsed)
  else if (parsed.type === 'control_response') handleControlResponse(parsed)
})
rl.on('close', () => {
  log({ t: 'stdin-close' })
  if (state.slowTimer) clearTimeout(state.slowTimer)
  process.exit(0)
})
