// 上下文失真「锚定生效」HTTP 路由接线测试（2026-09-12）
// ---------------------------------------------------------------------------
// 锁 bridge 侧接线：GUI 点「重新锚定」→ POST /session/anchor-applied →
// 校验后 writeControlRequest 转发内核 stdin。纯函数清洗逻辑见 health-anchor.test.mjs，
// 此处只验"路由真的在、校验真的拦、正常请求真的 200"（spawn 真桥，随机口 + 临时 home；
// 不 spawn 内核：unknown sessionId 时 writeControlRequest 按既有语义静默 no-op）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { TEST_BRIDGE_TOKEN, authHeaders } from './test-bridge-auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 15000

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Windows 并发下子进程句柄释放有延迟，rmSync 会偶发 EPERM——重试兜底
function rmSyncRetry(path, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) return // 测试结论不依赖临时目录清理
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function spawnBridge(home, port) {
  const env = { ...process.env, PONOS_MOCK_API: '1', YFW_BRIDGE_PORT: String(port), PONOS_CONFIG_DIR: home, YFWORKING_HOME: home, YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN }
  delete env.PONOS_HOME
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  let errTail = ''
  const state = { exitInfo: null }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => { out.push(String(d)) })
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })
  return { proc, state, stdoutText: () => out.join(''), stderrTail: () => errTail }
}

async function waitReady(b, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (b.stdoutText().includes(`http+ws://localhost:${port}`)) return
    if (b.state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(b.state.exitInfo)}; stderr: ${b.stderrTail()}`)
    await sleep(50)
  }
  throw new Error(`bridge ready timeout; stdout: ${b.stdoutText().slice(-400)}; stderr: ${b.stderrTail()}`)
}

const URL_PATH = '/session/anchor-applied'

test('锚定上报路由：缺 sessionId → 400；正常请求 → 200（真桥）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-anchor-home-'))
  const port = await freePort()
  const b = spawnBridge(home, port)
  try {
    await waitReady(b, port)
    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}${URL_PATH}`, {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
      })
      return { status: res.status, json: await res.json().catch(() => null) }
    }

    // ① 缺 sessionId：必须 400（不允许把无主消息写进某个会话）
    const bad = await post({ issueIds: ['a'] })
    assert.equal(bad.status, 400, JSON.stringify(bad))
    assert.equal(bad.json?.ok, false)

    // ② 空串/空白 sessionId 同样拦下
    assert.equal((await post({ sessionId: '   ', issueIds: ['a'] })).status, 400)

    // ③ 合法请求：200（sessionId 未知时 writeControlRequest 静默 no-op，不 500）
    const ok = await post({ sessionId: 'no-such-session', issueIds: ['a', 'b'] })
    assert.equal(ok.status, 200, JSON.stringify(ok))
    assert.equal(ok.json?.ok, true)

    // ④ 脏 body（issueIds 非数组）不得 500：清洗为空数组后照常 200
    const dirty = await post({ sessionId: 'no-such-session', issueIds: 'not-an-array' })
    assert.equal(dirty.status, 200, JSON.stringify(dirty))
  } finally {
    try { b.proc.kill() } catch { /* 已退出 */ }
    rmSyncRetry(home)
  }
})
