// server/graceful-exit.test.mjs —— 优雅退出 + 崩溃自愈（docs/production/reliability.md R2-1/R3-1）
// Windows 无 POSIX 信号语义：child.kill('SIGTERM') 走 TerminateProcess 不触发 JS
// handler。故 R2-1 在 Windows 上经 stdin EOF（rl close）触发同一 shutdown 路径
// （killActiveChildren → 清 marker → exit 0）；POSIX 上用真 SIGTERM。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

function spawnKernel(home, sid, extraEnv = {}) {
  const proc = spawn(process.execPath, [KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions', '--resume', sid], {
    cwd: home,
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: home, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim(); if (!t) return
    try { events.push(JSON.parse(t)) } catch {}
  })
  return { proc, events }
}
async function waitFor(pred, ms = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 30))
  }
  return pred()
}
const markerPath = (home, sid) => join(home, 'runs', sid + '.running')

// 终止并等待进程退出（清理前必须，否则 Windows 管道句柄占用目录导致 rmSync EPERM）
async function killAndWait(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const done = new Promise((r) => proc.once('exit', r))
  try { proc.kill() } catch {}
  await Promise.race([done, new Promise((r) => setTimeout(r, 1000))])
}

test('R2-1 优雅退出：marker 被清除 + 进程 exit 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'graceful-'))
  const sid = 'g1'
  const { proc } = spawnKernel(home, sid)
  try {
    assert.ok(await waitFor(() => existsSync(markerPath(home, sid))), '启动后应写 running marker')
    if (process.platform === 'win32') proc.stdin.end()
    else proc.kill('SIGTERM')
    const code = await new Promise((r) => proc.on('exit', r))
    assert.equal(code, 0)
    assert.ok(!existsSync(markerPath(home, sid)), '优雅退出应清除 marker')
  } finally {
    await killAndWait(proc)
    rmSync(home, { recursive: true, force: true })
  }
})

test('R3-1 崩溃检测：SIGKILL 后 marker 残留 → 下次启动发 crash_recovered', async () => {
  const home = mkdtempSync(join(tmpdir(), 'graceful-'))
  const sid = 'g2'
  const p1 = spawnKernel(home, sid)
  assert.ok(await waitFor(() => existsSync(markerPath(home, sid))))
  p1.proc.kill('SIGKILL')            // 模拟崩溃：不触发 handler，marker 残留
  await waitFor(() => p1.proc.exitCode !== null || p1.proc.signalCode !== null, 3000)
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(existsSync(markerPath(home, sid)), '崩溃后 marker 应残留')
  const p2 = spawnKernel(home, sid)
  try {
    assert.ok(await waitFor(() => p2.events.some((e) => e.type === 'system' && e.subtype === 'crash_recovered')), '下次启动应发 crash_recovered')
    // 启动后 marker 被新进程接管（重写），正常流程仍可用
    assert.ok(existsSync(markerPath(home, sid)))
  } finally {
    await killAndWait(p2.proc)
    rmSync(home, { recursive: true, force: true })
  }
})
