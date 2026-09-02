'use strict'

const readline = require('node:readline')

/**
 * agent-core 会话宿主（纯逻辑，可单测）：
 * 宿主 envelope（session.send/cancel/status）↔ kernel/cli.mjs NDJSON 契约（零改造）。
 * 内部维护单一 kernel 子进程：spawn/崩溃 respawn/会话状态（sessionId/busy/firstTokenAt）。
 * kernel 事件全部透传 onEvent；session_id 取自 system(init) 事件。
 * P3 单默认会话：sessionId 参数仅记录不分支（多会话/--resume 属 P5 bridge 迁移语义）。
 */
function createSessionHost({ spawnImpl, readlineImpl, kernelPath, nodePath, args }) {
  let proc = null
  let rl = null
  let sessionId = ''
  let busy = false
  let firstTokenAt = null
  let respawnTimer = null
  const listeners = new Set()

  function onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb) }
  function emitEvent(event) { for (const cb of listeners) { try { cb(event) } catch {} } }

  function spawnKernel() {
    proc = (spawnImpl)(nodePath, [kernelPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    sessionId = ''  // 新 kernel 的 session_id 待 init 事件
    busy = false
    firstTokenAt = null
    // readlineImpl 注入（测试）接收 proc 返回其 rl；缺省（main.cjs 实跑）用真实 readline({input: proc.stdout})
    rl = readlineImpl ? readlineImpl(proc) : readline.createInterface({ input: proc.stdout })
    rl.on('line', line => {
      let parsed
      try { parsed = JSON.parse(line) } catch { return }  // kernel raw 行忽略（P3 无 raw 消费者）
      if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) sessionId = parsed.session_id
      if (parsed.type === 'assistant') { busy = true; if (firstTokenAt === null) firstTokenAt = Date.now() }
      if (parsed.type === 'result') busy = false
      emitEvent(parsed)
    })
    // 崩溃 respawn（500ms）：'error'（spawn 失败）与 exit 非零码（真实 node 子进程崩溃形态）
    // 都重建；exit 0（优雅收尾）→ 清理引用不重建。守卫：proc 仍指向本进程（未被 stop/替换）。
    function scheduleRespawn() {
      clearTimeout(respawnTimer)
      respawnTimer = setTimeout(() => { if (proc && !proc.killed) spawnKernel() }, 500)
    }
    proc.on('error', () => scheduleRespawn())
    proc.on('exit', (code) => {
      if (code === 0) { proc = null; rl = null; return }
      scheduleRespawn()
    })
    return proc
  }

  function sendText(text) {
    if (!proc) return { ok: false, error: 'NOT_RUNNING' }
    // user 行契约（bridge-contract §3）：{ type:'user', message:{role:'user',content} }——与 bridge.mjs:2295 同款
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    return { ok: true }
  }

  function cancel() {
    if (!proc) return { ok: false, error: 'NOT_RUNNING' }
    // cancel 与 P1 agent-bridge.cjs 同款（契约 §3 control_request；request_id 可选，不加）
    proc.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
    return { ok: true }
  }

  function status() { return { busy, firstTokenAt, sessionId } }

  function handleRequest(method, params = {}) {
    switch (method) {
      case 'session.send': {
        const r = sendText(String(params.text || ''))
        if (!r.ok) return r
        return { ok: true, sessionId }
      }
      case 'session.cancel': return cancel()
      case 'session.status': return status()
      default: return { ok: false, error: 'METHOD_NOT_FOUND' }
    }
  }

  return { spawnKernel, sendText, cancel, status, handleRequest, onEvent }
}

module.exports = { createSessionHost }
