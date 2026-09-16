// 上下文失真的「锚定生效」链路——进程级端到端（2026-09-12）：
// 真内核进程 + 真 mock API + 真 stdin。覆盖单测覆盖不到的三段接线：
//   ① 引擎轮尾喂内容侧观测 → fidelity 判定（陈旧引用跨 2 轮升 strong → red）
//   ② ponos_health 事件随 stdout 下发 distortion（含 issues/trigger/anchorText）
//   ③ stdin {type:'anchor_applied'} → health.markFidelityResolved → 回绿事件
// 压力档全程不得被失真判定影响（两轴独立）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
/** 与被删/不存在的路径同名：Read 必然失败，且回显文本会带上该路径 */
const MISSING = '__yfw_fidelity_missing__.md'

function spawnKernel(env, dir) {
  const proc = spawn(process.execPath, [KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--add-dir', dir], {
    env: { ...process.env, ...env },
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = [] // NDJSON 行解析（数据块可能把一行切两半）
  let buf = ''
  let out = ''
  let err = ''
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

/** 轮询等待事件：pred 命中即返回该事件（找不到返回 null） */
async function waitForEvent(k, pred, timeoutMs = 15_000, from = 0) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    for (let i = from; i < k.events.length; i++) {
      if (pred(k.events[i])) return { ev: k.events[i], idx: i }
    }
    if (k.proc.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

test('锚定生效链路：失真红档 → stdin anchor_applied → 回绿（真内核）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-e2e-'))
  const k = spawnKernel({ PONOS_MOCK_API: '1', PONOS_FIDELITY: '1', PONOS_CONFIG_DIR: dir, YFW_HOME: dir }, dir)
  try {
    const init = await waitForEvent(k, (e) => e.type === 'system' && e.subtype === 'init', 20_000)
    assert.ok(init, `内核未就绪\nstdout=${k.out.slice(-500)}\nstderr=${k.err.slice(-500)}`)

    // 两轮"引用一个工具已报不存在的路径"：第 1 轮 medium，第 2 轮跨轮升级 strong → red
    let from = 0
    for (let i = 0; i < 2; i++) {
      k.proc.stdin.write(JSON.stringify({
        type: 'user', session_id: 'anchor-e2e',
        message: { role: 'user', content: `[mock:fidelity-read-fail] 请核对 ${MISSING} 里的配置` },
      }) + '\n')
      const done = await waitForEvent(k, (e) => e.type === 'result', 30_000, from)
      assert.ok(done, `第 ${i + 1} 轮未结束\nstdout=${k.out.slice(-800)}`)
      from = done.idx + 1
    }
    const found = await waitForEvent(k, (e) => e.type === 'ponos_health' && e.distortion?.tier === 'red', 15_000, 0)
    assert.ok(found, `应下发 distortion.tier=red 的 ponos_health\nstdout=${k.out.slice(-1500)}`)
    const red = found

    const d = red.ev.distortion
    assert.equal(d.tier, 'red')
    assert.ok(d.issues.length >= 1, '红档必须带证据清单')
    assert.ok(String(d.trigger || '').length > 0, '红档必须带去抖键 trigger')
    assert.ok(String(d.anchorText || '').length > 0, '红档必须带可发送的 anchorText（否则重新锚定按钮点了没反应）')
    assert.equal(d.anchorAvailable, true)
    assert.ok(d.issues.some((it) => it.kind === 'stale-reference'), '证据应为陈旧引用：' + JSON.stringify(d.issues))
    // 压力档独立：失真红不得把压力档顶成 red（两轴严禁互相赋值）
    assert.notEqual(red.ev.tier, 'red', '压力档不应被失真判定影响')

    // 上报锚定已生效（用户在 GUI 点了「重新锚定」）→ 内核标记证据 resolved → 回绿
    const fromIdx = red.idx
    k.proc.stdin.write(JSON.stringify({ type: 'anchor_applied', issueIds: d.issues.map((it) => it.id) }) + '\n')
    const green = await waitForEvent(k, (e) => e.type === 'ponos_health' && e.distortion?.tier === 'green', 15_000, fromIdx)
    assert.ok(green, `应下发回绿事件（stdin anchor_applied 未生效？）\nstdout=${k.out.slice(-1500)}`)
    assert.equal(green.ev.distortion.score, 0)
    assert.deepEqual(green.ev.distortion.issues, [], '回绿即无活跃证据')
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    // Windows：刚 kill 的进程仍持有 runs/ 句柄，清理需容忍短暂占用（失败不影响结论）
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }) } catch { /* 临时目录残留可接受 */ }
  }
})
