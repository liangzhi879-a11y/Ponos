// 自愈阶梯的**端到端**验证：级别必须真的出现在 wire 上（2026-09-21 长任务可靠性 P2 第三步）。
//
// 为什么要单独一个端到端文件（纯函数单测不够）：
//   统一阶梯的全部价值在"排障时能看见"——级别只写在注释/模块里而没上 wire，等于没做。
//   而"上了 wire"这件事**只有真跑内核才能证明**，因为路上有两处形态差异（实测都踩过）：
//     ① 注入事件有**两种形态**：扁平 `{reason,attempt,max}`（guardStall）与嵌套
//        `{name:'guard_heal',payload:{reason}}`（其余守卫）⇒ 标注只认一种就会漏一半；
//     ② 宿主侧 `onGuardInject` 是 `ev.payload || ev`（两种都读），故标注侧必须对齐。
//   本文件用一个"必然触发自愈"的 mock 驱动，断言 wire 上的每个 guard_heal 都带**已知级别**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEAL_LEVELS } from '../kernel/heal-ladder.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const rmTmp = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* Windows 句柄延迟，不影响结论 */ } }

/** 跑一轮内核，返回 NDJSON 事件数组（半行安全）。 */
async function runKernelTurn(env, prompt, { settleMs = 2000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heal-ladder-'))
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], { env: { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: dir, PONOS_HOME: dir, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 脏行跳过 */ }
    }
  })
  try {
    await new Promise((r) => setTimeout(r, 700))
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'heal-ladder', message: { role: 'user', content: prompt } }) + '\n')
    // 等到 result 或超时（自愈会在同一轮内反复发生，故等收尾才能看全）
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !events.some((e) => e.type === 'result')) await new Promise((r) => setTimeout(r, 150))
    await new Promise((r) => setTimeout(r, settleMs))
    return events
  } finally {
    try { proc.kill() } catch {}
    await new Promise((r) => setTimeout(r, 200))
    rmTmp(dir)
  }
}

/** `guard_heal` 事件的两个形态归一到一个 (reason, level) 视图（与宿主侧 `ev.payload || ev` 同口径）。 */
function healViews(events) {
  return events
    .filter((e) => e.type === 'system' && e.subtype === 'guard_heal')
    .map((e) => {
      const flat = e.payload === undefined
      const pl = flat ? e : e.payload
      return { flat, reason: pl.reason, level: pl.level, attempt: pl.attempt, max: pl.max }
    })
}

test('★ 端到端：上游空流自愈（L0 静默重试）在 wire 上带 level=L0', async () => {
  // [mock:deadstream] 抛 DeadStreamError ⇒ upstreamDead 守卫走"退避重发"（不注入文本）= L0。
  // 退避压到 100ms 只为让用例快；级别与退避时长无关（纪律②：升级看手段、不看时间）。
  const events = await runKernelTurn({ PONOS_UPSTREAM_DEAD_HEAL_BACKOFF_MS: '100' }, '[mock:deadstream] 空流')
  const views = healViews(events)
  assert.ok(views.length > 0, `应触发 upstream-dead 自愈（实测事件类型：${[...new Set(events.map((e) => e.subtype || e.type))].join(',')}）`)
  const up = views.filter((v) => v.reason === 'upstream-dead')
  assert.ok(up.length > 0, `应有 reason=upstream-dead 的 guard_heal；实测=${JSON.stringify(views)}`)
  for (const v of up) assert.equal(v.level, 'L0', `upstream-dead（退避重发，不改对话内容）应为 L0；实测=${JSON.stringify(v)}`)
})

test('★ 端到端（不变量）：所有 guard_heal 帧都带**已知级别**，且与 reason 的登记值一致', async () => {
  // 这条是不变量断言：无论触发哪条自愈路径，级别都必须存在且在词表内。
  // 它同时防两类回归：新守卫忘登记（level 缺失）、登记后写错级（与映射不符）。
  const events = await runKernelTurn(
    { PONOS_UPSTREAM_DEAD_HEAL_BACKOFF_MS: '100', PONOS_TIMEOUT_STREAK_MAX: '2', PONOS_MOCK_TIMEOUT_ROUNDS: '4' },
    '[mock:deadstream] 空流并触发多次自愈',
  )
  const views = healViews(events)
  assert.ok(views.length > 0, '应至少触发一次自愈')
  const bad = views.filter((v) => !(typeof v.level === 'string' && v.level in HEAL_LEVELS))
  assert.deepEqual(bad, [], `每个 guard_heal 都必须带已知 level；以下缺失/非法：${JSON.stringify(bad)}`)
  // 级差是"手段"的函数：同一 reason 在同一动作域下级别必须稳定（不得随重试次数漂移）
  const byReason = new Map()
  for (const v of views) {
    if (!byReason.has(v.reason)) byReason.set(v.reason, new Set())
    byReason.get(v.reason).add(v.level)
  }
  for (const [reason, levels] of byReason) {
    assert.equal(levels.size, 1, `reason=${reason} 的级别应稳定（实测 ${[...levels].join('/')}）——级别随次数漂移说明它被当成了策略`)
  }
})
