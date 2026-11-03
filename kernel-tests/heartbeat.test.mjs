// 活性心跳（2026-09-21 长任务可靠性 P2）——判定纯函数 + 端到端两件套。
//
// 修的事故：长前台工具（Bash 的 timeout_ms 已放宽到 30min、OCR、子代理）执行期间内核按设计
// **零 wire 输出**，而进程级硬看门狗按"静默 > 900s"扣扳机 ⇒ 工具跑到一半被 exit(7) 杀掉，
// 会话留下半截工作（工具 deadline 1800s 与看门狗 900s 本来就是一处理论矛盾）。
//
// 本文件钉住四件，缺一都不算修好：
//   ① 心跳真的出现在 wire 上（否则外围看不见"在忙"，修法等于没接线）；
//   ② 心跳**不**削弱兜底：真失活（零在飞工作）照样被硬看门狗 exit(7)——顺带反证"心跳没有
//      被算成实质输出"（若算成输出，下条的 idle 永远不会超限，②就必然失败）；
//   ③ 在飞工作期间不被误杀：工具跑得比看门狗阈值久，轮次仍正常收尾；
//   ④ 纪律②有界：自报"在飞"所能掩盖的静默越过上限即停发（纯函数层钉住）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activityHeartbeat, activityPhase, heartbeatToleranceMs, judgeHardWatchdog, normalizeInflight } from '../kernel/heartbeat.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
// Windows 上工具子进程（如长工具用的 `node -e setTimeout`）可能仍持有 tmp 目录的 cwd，
// 立即 rm 会 EPERM ⇒ 带重试的清理（不值得为清理失败而把一个通过的用例判红）。
const rmTmp = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* 清理失败不影响结论 */ } }

function spawnKernel(env, dir) {
  const proc = spawn(process.execPath, [KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--add-dir', dir], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const events = [] // 按 NDJSON 行解析（数据块可能把一行切两半，不能用 includes）
  let buf = ''
  proc.stdout.on('data', (d) => {
    out += d
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行/脏行跳过 */ }
    }
  })
  proc.stderr.on('data', (d) => err += d)
  return { proc, events, get out() { return out }, get err() { return err } }
}
const heartbeatFrames = (events) => events.filter((e) => e.type === 'system' && e.subtype === 'activity')

// ── ① 纯函数：何时发、发什么 ────────────────────────────────────────────────
test('有在飞工具 ⇒ 发心跳，且相位为 tool（这是"在忙"的可证伪证据）', () => {
  const v = activityHeartbeat({
    snapshot: { inflight: { tools: 2, lanes: 0, bg_bash: 0 }, tool_name: 'Bash', tool_ms: 1200, turn_ms: 5000 },
    now: 10_000, lastRealOutputAt: 9_000, lastHeartbeatAt: 0, periodMs: 15_000, busyMaxMs: 1_800_000,
  })
  assert.equal(v.emit, true)
  assert.equal(v.busy, true)
  assert.equal(v.frame.phase, 'tool')
  assert.equal(v.frame.inflight.total, 2)
  assert.equal(v.frame.tool_name, 'Bash')
  assert.equal(v.frame.output_silence_ms, 1000)
})

test('等用户相位优先于工具相位（那个相位本就该零输出，另有展期窗口负责边界）', () => {
  const v = activityHeartbeat({
    snapshot: { inflight: { tools: 1, lanes: 1, bg_bash: 1 } },
    now: 1000, lastRealOutputAt: 900, lastHeartbeatAt: 0, periodMs: 1000, awaitingUser: true,
  })
  assert.equal(v.frame.phase, 'waiting')
  assert.equal(v.frame.awaiting_user, true)
})

test('周期未到 ⇒ 不发（throttled）；关掉（0）⇒ 不发（disabled，回到旧行为）', () => {
  const base = { snapshot: { inflight: { tools: 1 } }, now: 10_000, lastRealOutputAt: 9_000, busyMaxMs: 0 }
  assert.equal(activityHeartbeat({ ...base, periodMs: 15_000, lastHeartbeatAt: 9_500 }).reason, 'throttled')
  assert.equal(activityHeartbeat({ ...base, periodMs: 0 }).reason, 'disabled')
})

test('★ 纪律②：在飞工作所能掩盖的静默有上限，越过即停发（busy-cap）', () => {
  const v = activityHeartbeat({
    snapshot: { inflight: { tools: 1 } },
    now: 100_000, lastRealOutputAt: 0, lastHeartbeatAt: 0, periodMs: 1000, busyMaxMs: 30_000,
  })
  // lastRealOutputAt=0 ⇒ 静默无法度量 ⇒ 不按上限停发（避免把"还没产出过"误当"静默超限"）
  assert.equal(v.emit, true)
  const capped = activityHeartbeat({
    snapshot: { inflight: { tools: 1 } },
    now: 100_000, lastRealOutputAt: 10_000, lastHeartbeatAt: 0, periodMs: 1000, busyMaxMs: 30_000,
  })
  assert.equal(capped.emit, false, '静默 90s > 上限 30s：在飞工作不得无限续命')
  assert.equal(capped.reason, 'busy-cap')
})

test('畸形/缺失的在飞快照一律按 0 计（绝不因自报畸形而误判"在忙"）', () => {
  assert.deepEqual(normalizeInflight(undefined), { tools: 0, lanes: 0, bg_bash: 0, total: 0 })
  assert.deepEqual(normalizeInflight({ inflight: { tools: -3, lanes: 'x', bg_bash: null } }), { tools: 0, lanes: 0, bg_bash: 0, total: 0 })
  assert.equal(activityPhase({ inflight: normalizeInflight({}), awaitingUser: false }), 'model')
})

test('新鲜度窗口 = 3 个周期；周期关闭则窗口为 0（不识别心跳）', () => {
  assert.equal(heartbeatToleranceMs(15_000), 45_000)
  assert.equal(heartbeatToleranceMs(0), 0)
})

// ── ② 纯函数：硬看门狗的放行判定 ────────────────────────────────────────────
test('★ 放行只认"心跳新鲜 + 有在飞工作"：其余一概不比旧行为宽松', () => {
  const over = { turnActive: true, idleMs: 900_001, limitMs: 900_000 }
  // 心跳新鲜 + 在飞 ⇒ 放行
  assert.equal(judgeHardWatchdog({ ...over, heartbeat: { at: 899_000, inflight: 1 }, now: 900_000, toleranceMs: 45_000 }).trip, false)
  assert.equal(judgeHardWatchdog({ ...over, heartbeat: { at: 899_000, inflight: 1 }, now: 900_000, toleranceMs: 45_000 }).suppressedBy, 'in-flight')
  // 心跳新鲜但**零在飞** ⇒ 照杀（心跳只证明进程在跑，不证明它还在干活）
  assert.equal(judgeHardWatchdog({ ...over, heartbeat: { at: 899_000, inflight: 0 }, now: 900_000, toleranceMs: 45_000 }).trip, true)
  // 心跳过期 ⇒ 自报作废，回落按静默判死
  const stale = judgeHardWatchdog({ ...over, heartbeat: { at: 800_000, inflight: 3 }, now: 900_000, toleranceMs: 45_000 })
  assert.equal(stale.trip, true)
  assert.equal(stale.hbFresh, false)
  assert.equal(stale.inflight, 0, '过期自报不得再被采信')
  // 从未发过心跳 / 识别关闭（tolerance 0）⇒ 旧行为
  assert.equal(judgeHardWatchdog({ ...over, heartbeat: { at: 0, inflight: 0 }, now: 900_000, toleranceMs: 45_000 }).trip, true)
  assert.equal(judgeHardWatchdog({ ...over, heartbeat: { at: 899_000, inflight: 5 }, now: 900_000, toleranceMs: 0 }).trip, true)
  // 未超限 ⇒ 不杀
  assert.equal(judgeHardWatchdog({ turnActive: true, idleMs: 100, limitMs: 900_000, heartbeat: { at: 0, inflight: 0 }, now: 900_000, toleranceMs: 45_000 }).trip, false)
  // 轮次未激活（轮间空闲）⇒ 不杀
  assert.equal(judgeHardWatchdog({ turnActive: false, idleMs: 9_999_999, limitMs: 1000, heartbeat: { at: 0, inflight: 0 }, now: 900_000, toleranceMs: 45_000 }).trip, false)
})

// ── ③ 端到端：心跳可见 + 兜底不被削弱（互为反证）────────────────────────────
test('★ 心跳出现在 wire 上，且真失活（零在飞）仍被硬看门狗兜住 —— 同时反证心跳未被算作实质输出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-wd-'))
  const { proc, events, out } = spawnKernel({
    PONOS_MOCK_API: '1',
    PONOS_ACTIVITY_HB_MS: '500',
    PONOS_KERNEL_HARD_TIMEOUT_MS: '2500',
    PONOS_CONFIG_DIR: dir,
    PONOS_HOME: dir,
  }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'hb-wd', message: { role: 'user', content: '[mock:hang-forever] 上游永不回块' } }) + '\n')
    const code = await new Promise((res) => { proc.on('close', res) })
    const frames = heartbeatFrames(events)
    assert.ok(frames.length > 0, `等待期应产出 system/activity 心跳\nstdout=${out.slice(-400)}`)
    assert.ok(frames.some((f) => f.phase === 'model'), '等待上游期间相位应为 model（没有在飞工作）')
    assert.ok(frames.every((f) => typeof f.inflight === 'object'), '心跳应自报在飞工作（外围判据的直接输入）')
    // ★ 互为反证：若心跳推进了 lastWireWriteAt（=被算成实质输出），idle 永远不会超限，
    //   下面的 exit(7) 就必然失败。故这条同时钉住"纪律①分账"。
    assert.equal(code, 7, `零在飞的真失活必须仍被兜住（心跳不得削弱兜底），实际 code=${code}`)
    assert.ok(events.some((e) => e.type === 'result'), '自杀前仍须写可见收尾 result')
  } finally {
    try { proc.kill() } catch {}
    rmTmp(dir)
  }
})

test('★ 长前台工具在跑（在飞工作）期间不被硬看门狗误杀：轮次正常收尾、无 marker.err', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-busy-'))
  // 工具 6s ≫ 看门狗阈值 2.5s：旧行为下必在工具跑到一半时 exit(7)
  const { proc, events, out } = spawnKernel({
    PONOS_MOCK_API: '1',
    PONOS_ACTIVITY_HB_MS: '500',
    PONOS_KERNEL_HARD_TIMEOUT_MS: '2500',
    PONOS_MOCK_TOOL_LONG_MS: '6000',
    PONOS_CONFIG_DIR: dir,
    PONOS_HOME: dir,
  }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'hb-busy', message: { role: 'user', content: '[mock:tool-long] 跑一个长任务' } }) + '\n')
    for (let i = 0; i < 100; i++) {
      if (events.some((e) => e.type === 'result')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const frames = heartbeatFrames(events)
    const busy = frames.filter((f) => f.phase === 'tool' && f.inflight.tools > 0)
    assert.ok(busy.length > 0, `长工具期间应产出"在飞工具"心跳（phase=tool, inflight.tools>0）\nstdout=${out.slice(-500)}`)
    assert.ok(events.some((e) => e.type === 'result'), '长工具轮次必须能正常收尾（未被中途杀掉）')
    assert.equal(proc.exitCode, null, '轮次收尾后进程应存活（不是被硬看门狗 exit(7) 收掉）')
    const errs = existsSync(join(dir, 'runs')) ? readdirSync(join(dir, 'runs')).filter((f) => f.endsWith('.err')) : []
    assert.deepEqual(errs, [], '在飞工作期间不得触发硬看门狗（marker.err 是它的自杀凭据）')
  } finally {
    try { proc.kill() } catch {}
    rmTmp(dir)
  }
})
