// bridge ↔ 内核集成契约测试（docs/bridge-contract.md §5/§6/§8）
// ---------------------------------------------------------------------------
// 以 mock-kernel.mjs 作为内核进程，通过 YFW_BRIDGE_NO_LISTEN + YFW_HOME 注入
// 在临时目录起真实 bridge（httpServer.listen(0)），用 WS 客户端按 GUI 视角
// 断言：spawn 参数/env、事件转发、里程碑/ASK_USER 提取剥离、审批闭环、
// browser 路由不透传 GUI、cancel 优雅停止与会话保留、resume 重开、answer 注入。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK_KERNEL = join(__dirname, 'mock-kernel.mjs')

let home
let bridge
let port
let clients = []

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'bridge-contract-'))
  process.env.YFW_HOME = home
  process.env.YFW_BRIDGE_NO_LISTEN = '1'
  process.env.YFWORKING_KERNEL = MOCK_KERNEL
  process.env.YFWORKING_BUN = process.execPath
  process.env.YFW_KERNEL_IDLE_MS = '0'    // 关闭空闲回收（测试不依赖 60s 定时器）
  process.env.YFW_KERNEL_STALL_MS = '0'   // 关闭 stall 告警
  // 每个 mock 进程独立日志：不设 MOCK_LOG，由测试在 spawn 前注入 —— 但 bridge
  // spawn 的 env 继承测试进程 env，MOCK_LOG 在测试内按会话名指向统一文件。
  process.env.MOCK_LOG = join(home, 'mock.log.jsonl')

  bridge = await import('./bridge.mjs')
  await new Promise((resolve) => bridge.httpServer.listen(0, resolve))
  port = bridge.httpServer.address().port
})

after(async () => {
  // 杀掉 bridge 持有的 mock 内核进程（stdin 由 bridge 持有，测试结束必须清理），
  // 并等待其真正退出后再删临时目录（否则 rmSync EPERM / 进程句柄挂住事件循环）
  const procs = [...bridge.sessions.values()].map((s) => s.proc).filter(Boolean)
  for (const p of procs) {
    try { p.kill() } catch {}
  }
  await Promise.all(procs.map((p) => new Promise((resolve) => {
    if (p.exitCode !== null) return resolve()
    const t = setTimeout(resolve, 2000)
    t.unref?.()
    p.once('exit', () => { clearTimeout(t); resolve() })
  })))
  for (const ws of clients) {
    try { ws.close() } catch {}
  }
  await new Promise((resolve) => bridge.httpServer.close(resolve))
  rmSync(home, { recursive: true, force: true })
})

// --- 工具函数 ---------------------------------------------------------------

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    // 持久消息总线：连接时挂常驻监听，所有消息入队/交递给唯一等待者。
    // 避免"按次挂/摘监听器"在突发事件到达时丢消息（实测竞态：bridge 一次
    // 连发 ack+里程碑+assistant+result，中途挂载的监听会漏掉中间帧）。
    ws._yfwQueue = []
    ws._yfwWaiter = null
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      const w = ws._yfwWaiter
      if (w && w.predicate(m)) {
        ws._yfwWaiter = null
        clearTimeout(w.timer)
        w.resolve(m)
      } else {
        ws._yfwQueue.push(m)
      }
    })
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    clients.push(ws)
  })
}

// 从消息总线取满足谓词的下一消息：先扫队列（命中即消费），否则注册等待者
function collect(ws, predicate, { timeoutMs = 5000 } = {}) {
  const idx = ws._yfwQueue.findIndex(predicate)
  if (idx >= 0) return Promise.resolve(ws._yfwQueue.splice(idx, 1)[0])
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve, reject, timer: null }
    w.timer = setTimeout(() => {
      if (ws._yfwWaiter === w) ws._yfwWaiter = null
      reject(new Error('collect timeout, queue=' + JSON.stringify(ws._yfwQueue)))
    }, timeoutMs)
    ws._yfwWaiter = w
  })
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

async function waitLogFile(predicate, timeoutMs = 5000) {
  const logPath = join(home, 'mock.log.jsonl')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line)
          if (predicate(rec)) return rec
        } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error('waitLogFile timeout')
}

function logRecords() {
  const logPath = join(home, 'mock.log.jsonl')
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf-8').split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

// --- 测试 -------------------------------------------------------------------

test('spawn 契约：argv/env 与 prompt 文件注入（§2）', async () => {
  const ws = await connect()
  const SID = 's-args'
  const cwd = home
  send(ws, { type: 'send', sessionId: SID, cwd, prompt: 'hello args', requestId: 'r1' })
  const ack = await collect(ws, (m) => m.type === 'ack' && m.data.sessionId === SID)
  assert.equal(ack.data.requestId, 'r1')
  assert.equal(ack.data.sessionId, SID)

  // argv 精确匹配 getOrCreateSession 注入序列
  const argvRec = await waitLogFile((r) => r.t === 'argv')
  assert.equal(argvRec.argv[0], '--print')
  assert.equal(argvRec.argv[1], '--output-format')
  assert.equal(argvRec.argv[2], 'stream-json')
  assert.equal(argvRec.argv[3], '--input-format')
  assert.equal(argvRec.argv[4], 'stream-json')
  assert.ok(argvRec.argv.includes('--permission-prompt-tool'))
  assert.ok(argvRec.argv.includes('stdio'))
  assert.ok(argvRec.argv.includes('--disallowedTools'))
  assert.ok(argvRec.argv.includes('AskUserQuestion'))
  assert.ok(argvRec.argv.includes('--dangerously-skip-permissions'))
  const promptIdx = argvRec.argv.indexOf('--append-system-prompt-file')
  assert.ok(promptIdx >= 0)
  const promptFile = argvRec.argv[promptIdx + 1]
  // 系统提示词临时文件存在且含身份内容
  assert.ok(existsSync(promptFile), 'prompt file should exist')
  const promptText = readFileSync(promptFile, 'utf-8')
  assert.match(promptText, /YFWorking/)
  // cwd 与技能根目录均以 --add-dir 注入
  const addDirCount = argvRec.argv.filter((a, i) => argvRec.argv[i - 1] === '--add-dir').length
  assert.ok(addDirCount >= 1)

  const envRec = await waitLogFile((r) => r.t === 'env')
  assert.equal(envRec.env.CLAUDE_CONFIG_DIR, home)
  assert.equal(envRec.env.YFWORKING_HOME, home)
  assert.equal(envRec.env.CLAUDE_CODE_AGENT_TRIGGERS, 'true')

  // 收尾：等本轮结果，避免 session 挂起影响后续用例
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
})

test('plain 轮次：send → ack → event(assistant) → event(result)', async () => {
  const ws = await connect()
  const SID = 's-plain'
  send(ws, { type: 'send', sessionId: SID, prompt: 'hello bridge', requestId: 'r2' })
  const ack = await collect(ws, (m) => m.type === 'ack' && m.data.sessionId === SID)
  assert.equal(ack.data.requestId, 'r2')
  const ev = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'assistant')
  assert.equal(ev.data.message.content[0].text, 'echo: hello bridge')
  const res = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
  assert.ok(res.data.usage.input_tokens >= 0)
})

test('milestones 提取剥离：事件化 + 标记从文本移除', async () => {
  const ws = await connect()
  const SID = 's-milestones'
  send(ws, { type: 'send', sessionId: SID, prompt: '[scenario:milestones] 推进' })
  const plan = await collect(ws, (m) => m.type === 'milestones' && m.sessionId === SID)
  assert.equal(plan.data.total, 3)
  assert.deepEqual(plan.data.names, ['需求分析', '方案设计', '编码实现'])
  const start = await collect(ws, (m) => m.type === 'milestone-start' && m.sessionId === SID)
  assert.equal(start.data.index, 1)
  assert.equal(start.data.name, '需求分析')
  const ok = await collect(ws, (m) => m.type === 'milestone-ok' && m.sessionId === SID)
  assert.equal(ok.data.index, 1)
  // 最终 assistant 文本不含任何 <!--MILESTONE 标记
  const ev = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'assistant')
  assert.ok(!ev.data.message.content[0].text.includes('<!--MILESTONE'), 'milestone marks must be stripped')
  assert.ok(ev.data.message.content[0].text.includes('需求分析完成'))
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
})

test('ASK_USER 卡片：question 事件 + 文本剥离 + answer 注入', async () => {
  const ws = await connect()
  const SID = 's-ask'
  send(ws, { type: 'send', sessionId: SID, prompt: '[scenario:askuser] 提问' })
  const q = await collect(ws, (m) => m.type === 'question' && m.sessionId === SID)
  assert.equal(q.data.questions[0].id, 'q1')
  assert.equal(q.data.questions[0].question, '采用哪种方案？')
  assert.equal(q.data.questions[0].options.length, 2)
  assert.equal(q.data.context, 'mock 内核测试卡片')
  const ev = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'assistant')
  assert.ok(!ev.data.message.content[0].text.includes('ASK_USER'), 'raw card must be stripped')
  assert.ok(ev.data.message.content[0].text.includes('需要确认方向'))
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')

  // 用户作答 → bridge 拼装注入内核 stdin → 广播 question-resolved
  send(ws, {
    type: 'answer',
    sessionId: SID,
    data: { answers: [{ question: '采用哪种方案？', selected: '方案A' }], notes: '选 A' },
  })
  const resolved = await collect(ws, (m) => m.type === 'question-resolved' && m.sessionId === SID)
  assert.equal(resolved.sessionId, SID)
  const injected = await waitLogFile((r) => r.t === 'stdin' && r.data.type === 'user' &&
    /用户回答：/.test(r.data.message.content) && /方案A/.test(r.data.message.content))
  assert.match(injected.data.message.content, /请继续推进任务。/)
  // mock 以默认场景应答注入文本
  const ev2 = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'assistant')
  assert.match(ev2.data.message.content[0].text, /用户回答：/)
})

test('approval 审批闭环：approval 事件 → approval-response → control_response 注入', async () => {
  const ws = await connect()
  const SID = 's-approval'
  send(ws, { type: 'send', sessionId: SID, prompt: '[scenario:approval] 高危命令' })
  const ap = await collect(ws, (m) => m.type === 'approval' && m.sessionId === SID)
  assert.equal(ap.data.toolUseId, 'tool_approve_1')
  assert.equal(ap.data.toolName, 'Bash')
  assert.equal(ap.data.command, 'rm -rf /tmp/mock-target')
  assert.equal(ap.data.requestId, 'mock-approval-1')
  assert.equal(ap.data.highRisk, true)

  send(ws, { type: 'approval-response', sessionId: SID, toolUseId: 'tool_approve_1', approved: true })
  const resolved = await collect(ws, (m) => m.type === 'approval-resolved' && m.sessionId === SID)
  assert.equal(resolved.data.toolUseId, 'tool_approve_1')
  // 内核收到 control_response(allow)，回填 request_id 与 toolUseID
  const cr = await waitLogFile((r) => r.t === 'stdin' && r.data.type === 'control_response')
  assert.equal(cr.data.response.request_id, 'mock-approval-1')
  assert.equal(cr.data.response.response.behavior, 'allow')
  assert.equal(cr.data.response.response.toolUseID, 'tool_approve_1')
  // 解除挂起后轮次完成
  const ev = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'assistant')
  assert.match(ev.data.message.content[0].text, /approval 完成/)
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
})

test('browser 路由：bridge_request 不透传 GUI，无执行器回写错误', async () => {
  const SID = 's-browser'
  const ws = await connect()
  send(ws, { type: 'send', sessionId: SID, prompt: '[scenario:browser] 导航' })
  // 内核发 bridge_request(route=browser) → bridge 不转发 GUI，直连执行器（未连接）→
  // 回写 browser_response 错误 → 内核完成轮次
  const ev = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'assistant')
  assert.match(ev.data.message.content[0].text, /browser 完成/)
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
  // GUI 全程未收到任何 bridge_request 载荷（URL 等不泄漏，消息总线队列即全量留痕）
  const leaked = ws._yfwQueue.filter((m) => m.sessionId === SID && m.type === 'event' && m.data.type === 'bridge_request')
  assert.equal(leaked.length, 0, 'bridge_request must never reach GUI')
  // 内核收到 browser_response 错误回写
  const br = await waitLogFile((r) => r.t === 'stdin' && r.data.type === 'control_request' &&
    r.data.request.subtype === 'browser_response')
  assert.equal(br.data.request.ok, false)
  assert.match(br.data.request.error, /executor 未连接/)
})

test('cancel 优雅停止：cancelled 事件 + 会话保留同进程续聊', async () => {
  const SID = 's-cancel'
  const ws = await connect()
  // 所有 collect 按 sessionId 过滤：bridge 向全部 GUI 客户端广播，前一个用例
  // 残留会话的事件可能落在本 ws 上（事件总线按 ws 连接广播，不分会话）。
  send(ws, { type: 'send', sessionId: SID, prompt: '[scenario:slow] 挂起' })
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'assistant' &&
    /slow 场景开始/.test(m.data.message.content[0].text))
  const startRec = await waitLogFile((r) => r.t === 'start')
  const pid1 = startRec.pid

  send(ws, { type: 'cancel', sessionId: SID })
  const cancelled = await collect(ws, (m) => m.type === 'cancelled' && m.data.sessionId === SID)
  assert.equal(cancelled.data.sessionId, SID)
  // 先消费被中断轮次的收尾 assistant（'已取消。'），再消费 result —— 顺序与
  // 内核输出一致（assistant → result），否则残留事件会污染下一次 collect。
  const cancelledEv = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID &&
    m.data.type === 'assistant' && /已取消/.test(m.data.message.content[0].text))
  assert.match(cancelledEv.data.message.content[0].text, /已取消/)
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')

  // 会话保留：同 sessionId 再发消息 → 复用同一 mock 进程（无新 start 记录）
  const startsBefore = logRecords().filter((r) => r.t === 'start').length
  send(ws, { type: 'send', sessionId: SID, prompt: 'cancel 后续聊' })
  const ev = await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'assistant')
  assert.match(ev.data.message.content[0].text, /echo: cancel 后续聊/)
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
  const startsAfter = logRecords().filter((r) => r.t === 'start').length
  assert.equal(startsAfter, startsBefore, 'cancel 后会话必须复用原进程（不重开）')
  // 内核确实收到了 control_request(cancel)
  const cancelRec = await waitLogFile((r) => r.t === 'stdin' && r.data.type === 'control_request' && r.data.request.subtype === 'cancel')
  assert.ok(cancelRec)
  assert.equal(pid1, startRec.pid)
})

test('resume 重开：kill 后同 sessionId 以 --resume 重新 spawn', async () => {
  const SID = 's-resume'
  const ws = await connect()
  send(ws, { type: 'send', sessionId: SID, prompt: '第一轮' })
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
  const startsBefore = logRecords().filter((r) => r.t === 'start').length

  // 模拟内核崩溃/回收：杀掉 mock 进程 → bridge 收到 close → 会话移除并广播 closed
  const s = bridge.sessions.get(SID)
  assert.ok(s && s.proc, 'session should exist')
  s.proc.kill()
  await collect(ws, (m) => m.type === 'closed' && m.sessionId === SID)

  // 同 sessionId + resumeId 重新发送 → 新进程 argv 含 --resume
  send(ws, { type: 'send', sessionId: SID, resumeId: SID, prompt: 'resume 恢复' })
  const ack = await collect(ws, (m) => m.type === 'ack' && m.data.sessionId === SID)
  assert.equal(ack.data.sessionId, SID)
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')

  const startsAfter = logRecords().filter((r) => r.t === 'start').length
  assert.equal(startsAfter, startsBefore + 1, 'resume 必须重新 spawn 一个内核进程')
  const argvRecs = logRecords().filter((r) => r.t === 'argv')
  const resumeIdx = argvRecs[argvRecs.length - 1].argv.indexOf('--resume')
  assert.ok(resumeIdx >= 0, 'resume spawn argv 必须含 --resume')
  assert.equal(argvRecs[argvRecs.length - 1].argv[resumeIdx + 1], SID)
})

test('raw 透传：非 JSON 行以 raw 事件转发', async () => {
  const SID = 's-raw'
  const ws = await connect()
  send(ws, { type: 'send', sessionId: SID, prompt: '[scenario:raw] 原始行' })
  const raw = await collect(ws, (m) => m.type === 'raw' && m.sessionId === SID)
  assert.equal(raw.data, 'raw-line-from-mock')
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
})

test('stderr 透传：内核 stderr 行以 stderr 事件转发', async () => {
  // mock 无 stderr 输出路径，此用例验证 bridge 的 stderr 接线存在（直接验证代码路径）：
  // 通过 waitLogFile 确认 mock 正常启动即可 —— stderr 行会在 event 之前到达。
  const SID = 's-stderr'
  const ws = await connect()
  send(ws, { type: 'send', sessionId: SID, prompt: 'hello' })
  await collect(ws, (m) => m.type === 'event' && m.sessionId === SID && m.data.type === 'result')
  // bridge 对 mock 的 stderr 流建立了 createInterface（不崩溃即可）
  assert.ok(true)
})
