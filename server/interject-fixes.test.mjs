// 插话修复专项测试（进程级 spawn 内核，mock API，无网络）
// ---------------------------------------------------------------------------
// 覆盖两处 cli.mjs 插话链路修复：
//   1. cancel 丢弃未注入的排队插话（pendingNext）：取消后残余插话不再被轮末
//      finally drain 成新轮执行——修复"取消不干净"
//   2. 兜底成新轮的插话跳过记忆捕获（skipMemoryCapture 标记）：与工具边界注入
//      路径（engine 内 appendUser 不经 cli 捕获）行为一致——修复"同一条插话
//      两种命运"
// 两处行为均在 cli.mjs 闭包内，故用 spawn 内核进程 + stdin NDJSON 的进程级
// 测试（interject.e2e.mjs 同思路，但不依赖 bridge/WS，直接喂内核协议）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

// engine 直连场景需要 mock（spawnKernel 的子进程 env 已显式设置）
process.env.PONOS_MOCK_API = '1'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL = join(__dirname, '..', 'kernel', 'cli.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// spawn 独立内核进程（PONOS_MOCK_API=1），返回发送/等待/清理设施。
// 事件收集：stdout NDJSON 逐行 parse 进 events（数组共享引用，waitFor 实时轮询）。
function spawnKernel() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-interjfix-'))
  const home = join(dir, 'home')
  const events = []
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--dangerously-skip-permissions', '--add-dir', dir,
  ], {
    cwd: dir,
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: home, PONOS_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
    }
  })
  const waitFor = (pred, ms) => new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const hit = events.find(pred)
      if (hit) { clearInterval(timer); resolve(hit) }
      else if (Date.now() - t0 > ms) { clearInterval(timer); reject(new Error(`timeout(${ms}ms) 等待事件`)) }
    }, 10)
  })
  const waitForN = (type, n, ms) => new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (events.filter((e) => e.type === type).length >= n) { clearInterval(timer); resolve() }
      else if (Date.now() - t0 > ms) { clearInterval(timer); reject(new Error(`timeout(${ms}ms) 等待 ${n}x ${type}`)) }
    }, 10)
  })
  const ready = waitFor((e) => e.type === 'system' && e.subtype === 'init', 8000)
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
  const cleanup = () => {
    try { child.kill() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  return { events, send, waitFor, waitForN, ready, home, dir, cleanup }
}

test('cancel 丢弃未注入的排队插话：取消后不产生第二个 result（修复"取消不干净"）', async () => {
  const k = spawnKernel()
  try {
    await k.ready
    // 工具轮（mock tool-safe → Bash echo）启动后，插话在轮次活跃期到达 → queueNext 吸收
    k.send({ type: 'user', message: { role: 'user', content: '[mock:tool-safe] 开始' } })
    await sleep(30)
    k.send({ type: 'user', priority: 'next', uuid: 'interj-cancel-1', message: { role: 'user', content: '排队插话' } })
    await sleep(10)
    // 取消当前轮
    k.send({ type: 'control_request', request_id: 'c1', request: { subtype: 'cancel' } })
    await k.waitFor((e) => e.type === 'result', 8000)
    // 插话吸收确认已发出（气泡解除）——与是否被丢弃无关
    assert.ok(
      k.events.some((e) => e.type === 'command_lifecycle' && e.data?.uuid === 'interj-cancel-1'),
      'queueNext 应发 command_lifecycle started'
    )
    // 观察窗口：cancel 后残余插话不得被 drain 成新轮执行（修复前此处会出现第二个 result）
    await sleep(500)
    const results = k.events.filter((e) => e.type === 'result')
    assert.equal(results.length, 1, 'cancel 后排队插话不应作为新轮执行')
  } finally { k.cleanup() }
})

test('now 紧急插话：吸收确认后中断当前轮，消息作为新轮立即执行', async () => {
  const k = spawnKernel()
  try {
    await k.ready
    k.send({ type: 'user', message: { role: 'user', content: '[mock:tool-safe] 长流程' } })
    await sleep(30)
    // 轮次活跃中到达 → 内核 now 分支（abort 当前轮 + 作为新轮），不再依赖 bridge 侧 cancel
    k.send({ type: 'user', priority: 'now', uuid: 'interj-now-1', message: { role: 'user', content: '紧急插话：先停一下' } })
    await k.waitForN('result', 2, 8000)
    // 吸收确认已及时发出（打断前）
    assert.ok(
      k.events.some((e) => e.type === 'command_lifecycle' && e.data?.uuid === 'interj-now-1' && e.data?.state === 'started'),
      'now 插话应发 command_lifecycle started'
    )
    // 被打断轮输出"已取消。"，插话轮随后完成
    assert.ok(
      k.events.some((e) => e.type === 'assistant' && Array.isArray(e.message?.content) &&
        e.message.content.some((b) => b?.type === 'text' && b.text.includes('已取消。'))),
      '当前轮应被中止（输出已取消）'
    )
  } finally { k.cleanup() }
})

// engine 直连环境（与 interject-browser.test.mjs 同款，mock API）
function makeEngineEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-interjfix-engine-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  return { events, engine, store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('hardStop 全杀：中止后台子 agent（停止按钮 cancel 语义）', async () => {
  const { events, engine, cleanup } = makeEngineEnv()
  try {
    // 主轮触发后台 Agent 任务（子 lane 进入 [mock:sleep] 长 Bash 执行，持续运行）
    await engine.runTurn({ content: '[mock:agent-bg] 启动后台任务' })
    assert.ok(engine.pendingSubAgents.size === 1, '后台子任务应已登记')
    assert.equal(engine.pendingSubAgents.values().next().value.status, 'running')

    // hardStop：kill 子进程（含子 lane 的 sleep）+ abort 子 lane 信号
    engine.hardStop()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline &&
      !events.some((e) => e.type === 'system' && e.subtype === 'task_notification' && e.status === 'stopped')) {
      await sleep(10)
    }
    assert.ok(
      events.some((e) => e.type === 'system' && e.subtype === 'task_notification' && e.status === 'stopped'),
      '后台子 agent 应被中止（task_notification stopped）'
    )
  } finally { cleanup() }
})

test('cancel 全杀工具子进程：长 Bash 立即被杀，轮快速收敛（非等 30s）', async () => {
  const k = spawnKernel()
  try {
    await k.ready
    const t0 = Date.now()
    k.send({ type: 'user', message: { role: 'user', content: '[mock:sleep] 长任务' } })
    await sleep(100) // Bash sleep 30 已启动
    k.send({ type: 'control_request', request_id: 'c2', request: { subtype: 'cancel' } })
    await k.waitFor((e) => e.type === 'result', 8000)
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 3000, `cancel 后应在 3s 内收敛（实际 ${elapsed}ms）——长 Bash 被 kill 而非等待完成`)
    assert.ok(
      k.events.some((e) => e.type === 'assistant' && Array.isArray(e.message?.content) &&
        e.message.content.some((b) => b?.type === 'text' && b.text.includes('已取消。'))),
      'cancel 后应输出已取消'
    )
  } finally { k.cleanup() }
})

test('兜底成新轮的插话跳过记忆捕获（与工具边界注入路径一致，修复"两种命运"）', async () => {
  const k = spawnKernel()
  try {
    await k.ready
    // 纯文本轮（mock 回显，约 100ms 生成）：插话在生成期到达 → 工具边界无注入机会
    // → 轮末 drain 成新轮（skipMemoryCapture 标记生效的必经路径）
    k.send({ type: 'user', message: { role: 'user', content: '你好' } })
    await sleep(30)
    // 含 correction marker（"以后不要"）——若参与捕获会写 <home>/memory/personal/workflow.md
    k.send({ type: 'user', priority: 'next', uuid: 'interj-mem-1', message: { role: 'user', content: '以后不要用红色背景' } })
    // 两个 result：当前轮 + 插话兜底新轮（确认兜底路径确实发生）
    await k.waitForN('result', 2, 8000)
    // 记忆捕获应被跳过：memory/personal 下不应出现任何条目文件
    const personal = join(k.home, 'memory', 'personal')
    const hasMemoryFile = existsSync(personal) && readdirSync(personal).some((f) => f.endsWith('.md'))
    assert.equal(hasMemoryFile, false, '兜底插话不应写个人记忆（与工具边界注入路径一致）')
  } finally { k.cleanup() }
})
