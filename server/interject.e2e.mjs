// 生成中插话 E2E：spawn 独立 bridge（固定测试端口 52319）→ WS 两个场景 →
// 通过则 exit 0。运行：node server/interject.e2e.mjs
import { spawn, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 52319
const bridge = spawn(process.execPath, [join(__dirname, 'bridge.mjs')], {
  env: { ...process.env, YFW_BRIDGE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
bridge.stderr.on('data', d => process.stdout.write('[bridge-err] ' + String(d).slice(0, 120) + '\n'))
// 退出时强杀自身 spawn 的 bridge 及其子进程树：Windows 下父进程 process.exit 不会
// 连带终止子进程，残留 bridge + 内核 CLI 会继续占住 52319 端口，导致下次运行新
// bridge 因 EADDRINUSE 退出、而脚本 WS 却连上上一次运行的残留 bridge。
let bridgeCleaned = false
function cleanupBridge() {
  if (bridgeCleaned || bridge.pid == null) return
  bridgeCleaned = true
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${bridge.pid}`, { stdio: 'ignore' })
    } else {
      try { process.kill(-bridge.pid, 'SIGKILL') } catch { process.kill(bridge.pid, 'SIGKILL') }
    }
  } catch {}
}
process.on('exit', cleanupBridge)
// 等待本次 spawn 的 bridge 真正绑定端口（stdout 打印监听就绪行）。若它在该行之前
// 退出（典型：端口被残留进程占用 EADDRINUSE），直接报错中止，绝不连到残留实例。
const bridgeReady = new Promise((res, rej) => {
  const onOut = d => {
    if (String(d).includes(`http+ws://localhost:${PORT}`)) {
      bridge.stdout.off('data', onOut)
      bridge.off('exit', onExit)
      res()
    }
  }
  const onExit = code => {
    bridge.stdout.off('data', onOut)
    rej(new Error(
      `bridge exited with code ${code} before binding port ${PORT} —— ` +
      `端口 ${PORT} 可能被残留 bridge/内核进程占用，请先结束占用该端口的进程后重试`
    ))
  }
  bridge.stdout.on('data', onOut)
  bridge.on('exit', onExit)
  if (bridge.exitCode !== null) onExit(bridge.exitCode)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.log(`+${Date.now() - t0}ms`, ...a)

async function connectWS() {
  await bridgeReady // 先确认连接的是本次 spawn 的 bridge（已成功绑定端口），而非残留实例
  for (let i = 0; i < 40; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no bridge')) })
      return ws
    } catch { await sleep(500) }
  }
  throw new Error('bridge did not start')
}

// 场景A：紧急插话（priority:'now'）—— 长生成中注入，期望当前轮快速中止 + 插话轮完成
async function scenarioA() {
  const sid = 'e2e-a-' + Date.now()
  const ws = await connectWS()
  let results = 0
  let passedFirst = false
  let sawInterject = false
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'event' && m.data?.type === 'result') {
      results++
      if (results === 1) passedFirst = true
      log(`[A] result#${results} is_error=${m.data.is_error} subtype=${m.data.subtype}`)
    }
    if (m.type === 'event' && m.data?.type === 'assistant' && Array.isArray(m.data.message?.content)) {
      for (const b of m.data.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && passedFirst && b.text.includes('珊瑚礁')) sawInterject = true
      }
    }
  }
  ws.send(JSON.stringify({ type: 'send', prompt: '请写一篇关于海洋生态的科普长文，至少3000字，不要使用任何工具。', requestId: 'a1', sessionId: sid, cwd: __dirname }))
  await sleep(8000)
  ws.send(JSON.stringify({ type: 'send', prompt: '【插话成功】请改为只写 500 字，主题改为珊瑚礁。', requestId: 'a2', sessionId: sid, cwd: __dirname, priority: 'now' }))
  await sleep(15000)
  log(`[A] results=${results} sawInterject=${sawInterject}`)
  ws.close()
  if (results < 2) throw new Error('A FAIL: 未产生两个 result（中止+插话轮）')
  if (!sawInterject) throw new Error('A FAIL: 插话轮未输出插话内容')
  log('[A] PASS')
}

// 场景B：排队插话（无 priority，纯文本长轮）—— 排队消息立即发送后由内核处理：
// 若在查询迭代前到达则注入当前轮（1 个 result、内容被吸收）；若在最后迭代后到达
// 则作为新轮（2 个 result）。两种路径均为方案A预期行为，只断言"不打断 + 内容被吸收"。
// 用"海马"作关键词（海洋生态长文自发提到海马概率低，避免假阳性）。
async function scenarioB() {
  const sid = 'e2e-b-' + Date.now()
  const ws = await connectWS()
  let results = 0
  let cancelled = 0
  let errors = 0
  let sawSeahorse = false
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'event' && m.data?.type === 'result') {
      results++
      log(`[B] result#${results} is_error=${m.data.is_error}`)
    }
    if (m.type === 'cancelled') { cancelled++; log('[B] cancelled') }
    if (m.type === 'error') { errors++; log('[B] error') }
    if (m.type === 'event' && m.data?.type === 'assistant' && Array.isArray(m.data.message?.content)) {
      for (const b of m.data.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('海马')) sawSeahorse = true
      }
    }
  }
  ws.send(JSON.stringify({ type: 'send', prompt: '请写一篇关于海洋生态的科普长文，至少1500字，不要使用任何工具。', requestId: 'b1', sessionId: sid, cwd: __dirname }))
  await sleep(3000)
  ws.send(JSON.stringify({ type: 'send', prompt: '排队插话：请务必补充关于海马栖息地保护的内容。', requestId: 'b2', sessionId: sid, cwd: __dirname }))
  await sleep(75000)
  log(`[B] results=${results} cancelled=${cancelled} errors=${errors} sawSeahorse=${sawSeahorse}`)
  ws.close()
  if (cancelled > 0 || errors > 0) throw new Error('B FAIL: 排队插话不应打断当前轮（出现取消/报错）')
  if (!sawSeahorse) throw new Error('B FAIL: 插话内容未被模型吸收（注入当前轮或作为新轮均须出现）')
  if (results < 1) throw new Error('B FAIL: 未产生 result')
  log('[B] PASS')
}

// 场景C：排队插话工具边界注入（方案A核心）—— 长工具执行中发 next，期望
// 不打断当前轮，且插话内容被模型吸收（注入当前轮或作为新轮，均视为通过）
async function scenarioC() {
  const sid = 'e2e-c-' + Date.now()
  const ws = await connectWS()
  let results = 0
  let cancelled = 0
  let errors = 0
  let sawSeahorse = false
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'event' && m.data?.type === 'result') {
      results++
      log(`[C] result#${results} is_error=${m.data.is_error}`)
    }
    if (m.type === 'cancelled') { cancelled++; log('[C] cancelled') }
    if (m.type === 'error') { errors++; log('[C] error') }
    if (m.type === 'event' && m.data?.type === 'assistant' && Array.isArray(m.data.message?.content)) {
      for (const b of m.data.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('海马')) sawSeahorse = true
      }
    }
  }
  ws.send(JSON.stringify({ type: 'send', prompt: '调用 Bash 工具执行命令 sleep 8（等待8秒），然后写一篇关于海洋生态的短文，200字。', requestId: 'c1', sessionId: sid, cwd: __dirname }))
  await sleep(4000)
  ws.send(JSON.stringify({ type: 'send', prompt: '排队插话：请务必补充关于海马栖息地保护的内容。', requestId: 'c2', sessionId: sid, cwd: __dirname }))
  await sleep(40000)
  log(`[C] results=${results} cancelled=${cancelled} errors=${errors} sawSeahorse=${sawSeahorse}`)
  ws.close()
  if (cancelled > 0 || errors > 0) throw new Error('C FAIL: 排队插话不应打断当前轮（出现取消/报错）')
  if (!sawSeahorse) throw new Error('C FAIL: 插话内容未被模型吸收')
  if (results < 1) throw new Error('C FAIL: 未产生 result')
  log('[C] PASS')
}

try {
  await scenarioA()
  await scenarioB()
  await scenarioC()
  log('ALL PASS')
  process.exit(0)
} catch (e) {
  log('FAIL:', e.message)
  process.exit(1)
}
