// /worktrees 与 /branches 的端到端契约（P1 批次 1 新增）
// ---------------------------------------------------------------------------
// 为什么需要它：`server/git-async.test.mjs` 测的是**解析与异步语义**（不起桥），
// 覆盖不到"改 bridge.mjs 调度后端点还通不通"——把同步调用换成 `await` 的过程中，
// 一旦 await 位置/层级写错，单元测试全绿而端点在真跑时挂住或 500。
//
// 本文件锁两条：
//   1. **契约**：GET /worktrees、/branches 返回 200 且结构正确；
//   2. **分支名不被截断**：以 git 自身输出为基准比对（回归旧的 `slice(21)` off-by-3，
//      它让工作树面板一直显示 `ture/...`、`wledge-...` 这类错名）。
//
// 运行：node --test server/git-endpoints.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { TEST_BRIDGE_TOKEN, authHeaders } from './test-bridge-auth.mjs'
import { gitOut } from './git-async.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')
const READY_TIMEOUT_MS = 20_000

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function rmSyncRetry(path, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100) }
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
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    PONOS_CONFIG_DIR: home,
    YFWORKING_HOME: home,
    YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
  }
  delete env.PONOS_HOME
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const state = { exitInfo: null }
  const out = []
  const err = []
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => out.push(String(d)))
  proc.stderr.on('data', (d) => err.push(String(d)))
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })
  return { proc, state, stdoutText: () => out.join(''), stderrText: () => err.join('') }
}

async function waitReady(b, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (b.stdoutText().includes(`http+ws://localhost:${port}`)) return
    if (b.state.exitInfo) throw new Error(`bridge 未就绪即退出：${JSON.stringify(b.state.exitInfo)}\n${b.stderrText().slice(-800)}`)
    await sleep(50)
  }
  throw new Error('bridge 就绪超时；stderr: ' + b.stderrText().slice(-800))
}

/** 起一次桥，跑完断言后收摊（两个用例共用同一桥，避免重复 spawn 的秒级开销） */
async function withBridge(fn) {
  const home = mkdtempSync(join(tmpdir(), 'yfw-git-ep-'))
  const port = await freePort()
  const b = spawnBridge(home, port)
  try {
    await waitReady(b, port)
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    try { b.proc.kill() } catch { /* 已退出 */ }
    await sleep(120)
    rmSyncRetry(home)
  }
}

test('GET /worktrees：200 且分支名与 git 自身输出一致（回归 slice(21) 截断）', async () => {
  // 基准：直接问 git（不经过端点），避免"用被测实现验证被测实现"
  const groundTruth = await gitOut(['worktree', 'list', '--porcelain'], { cwd: REPO_ROOT })
  const expected = groundTruth.split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).replace(/\\/g, '/'))
  assert.ok(expected.length >= 1, '前置条件：本仓库至少有 1 个工作树')

  await withBridge(async (base) => {
    const res = await fetch(`${base}/worktrees?path=${encodeURIComponent(REPO_ROOT)}`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data.worktrees))
    assert.deepEqual(data.worktrees.map((w) => w.path), expected)

    // 分支名：逐个与 git 的 refs/heads/ 实况比对（旧实现每个名字少 3 个字符）
    const refsOut = await gitOut(['worktree', 'list', '--porcelain'], { cwd: REPO_ROOT })
    const realBranches = refsOut.split('\n').filter((l) => l.startsWith('branch ')).map((l) => l.slice('branch '.length).trim().replace(/^refs\/heads\//, ''))
    for (const real of realBranches) {
      assert.ok(
        data.worktrees.some((w) => w.branch === real),
        `端点返回的分支名里找不到 git 实况的 ${real}（实际：${data.worktrees.map((w) => w.branch).join(', ')}）`,
      )
    }
  })
})

test('GET /branches：200，含当前分支，且不含被截断的短名', async () => {
  const current = (await gitOut(['branch', '--show-current'], { cwd: REPO_ROOT })).trim()
  assert.ok(current, '前置条件：当前处于某个分支（非 detached）')

  await withBridge(async (base) => {
    const res = await fetch(`${base}/branches?path=${encodeURIComponent(REPO_ROOT)}`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(Array.isArray(data.branches))
    assert.ok(data.branches.includes(current), `分支列表应含当前分支 ${current}`)
    assert.ok(data.branches.every((b) => b === b.trim() && b.length > 0), '不应有空行或未 trim 的项')
  })
})
