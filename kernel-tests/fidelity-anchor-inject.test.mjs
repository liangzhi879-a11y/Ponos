// 失真红线锚点注入闭环（2026-09-15）
//
// 背景：health/fidelity 早已能检出失真（tier=red）并生成 anchorText，但该文本只经
// ponos_health 事件发给 GUI；内核**从不把它注入模型上下文**，等用户点"重新锚定"回传
// anchor_applied 才置 resolved —— 检测等于只报警不处置。本测试锁住新闭环：
// red 时锚点必须真的出现在**发给模型的请求消息**里。
//
// 判定口子说明：锚点是纯派生（不落盘、不发消息事件），所以"事件里有 anchorText"证明
// 不了注入。这里用 PONOS_MOCK_ANCHOR_PROBE 让 mock 直接扫请求体内非 system 条目，
// 并在对照组（PONOS_FIDELITY_ANCHOR=0）断言探针为 0，排除"提示词本来就有该字样"的假阳性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withAnchorTail } from '../kernel/engine.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
/** 必须与 mock 硬编码的失败路径一致（kernel/api.mjs 的 [mock:fidelity-read-fail] 分支
 *  固定 Read '__yfw_fidelity_missing__.md'）：fidelity 的 stale-reference 证据要求
 *  「文本引用的路径」与「工具报该路径不存在」相匹配，测试侧换名会让证据建不起来。 */
const MISSING = '__yfw_fidelity_missing__.md'
const ANCHOR_MARK = '【系统提醒 · 上下文失真告警】'

// ── 单元：消息形状（角色交替合法性 / 不改原数组）────────────────────────────

test('withAnchorTail: 末条为 assistant 时追加 user 消息', () => {
  const face = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
  ]
  const out = withAnchorTail(face, 'LOST: f1.md')
  assert.equal(out.length, 4)
  assert.equal(out[3].role, 'user')
  assert.ok(out[3].content.includes(ANCHOR_MARK))
  assert.ok(out[3].content.includes('LOST: f1.md'))
})

test('withAnchorTail: 末条为 user(string) 时并入而非新起一条（避免连续两条 user）', () => {
  const face = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }]
  const out = withAnchorTail(face, 'X')
  assert.equal(out.length, 2, '不应新增消息')
  assert.equal(out[1].role, 'user')
  assert.ok(out[1].content.startsWith('u1'), '原内容保留在前')
  assert.ok(out[1].content.includes(ANCHOR_MARK))
})

test('withAnchorTail: 末条为 user(blocks) 时追加 text block（tool_result 配对不被破坏）', () => {
  const blocks = [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }]
  const face = [{ role: 'system', content: 'S' }, { role: 'user', content: blocks }]
  const out = withAnchorTail(face, 'X')
  assert.equal(out.length, 2)
  assert.equal(out[1].content.length, 2)
  assert.equal(out[1].content[0].type, 'tool_result', '原有 tool_result 必须在首位且未被改动')
  assert.equal(out[1].content[1].type, 'text')
  assert.ok(out[1].content[1].text.includes(ANCHOR_MARK))
})

test('withAnchorTail: 不修改入参数组（requestFace 缓存对象不可污染）', () => {
  const face = [{ role: 'system', content: 'S' }, { role: 'assistant', content: 'a1' }]
  const snapshot = JSON.stringify(face)
  const out = withAnchorTail(face, 'X')
  assert.equal(JSON.stringify(face), snapshot, '原数组必须逐字节不变')
  assert.notEqual(out, face, '必须返回新数组')
})

test('withAnchorTail: 空面/仅 system 时追加 user（不产生非法序列）', () => {
  const onlySys = withAnchorTail([{ role: 'system', content: 'S' }], 'X')
  assert.equal(onlySys.length, 2)
  assert.equal(onlySys[1].role, 'user')
  const empty = withAnchorTail([], 'X')
  assert.equal(empty.length, 1)
  assert.equal(empty[0].role, 'user')
})

// ── 端到端：red 之后锚点必须进入发给模型的请求 ──────────────────────────────

function spawnKernel(env, dir) {
  const proc = spawn(process.execPath, [KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--add-dir', dir], {
    env: { ...process.env, ...env },
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const st = { proc, events: [], buf: '', out: '', err: '' }
  proc.stdout.on('data', (d) => {
    st.out += d
    st.buf += d
    let i
    while ((i = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, i).trim()
      st.buf = st.buf.slice(i + 1)
      if (!line) continue
      try { st.events.push({ ...JSON.parse(line), idx: st.events.length }) } catch { /* 非 JSON 行忽略 */ }
    }
  })
  proc.stderr.on('data', (d) => { st.err += d })
  return st
}

async function waitForEvent(k, pred, timeoutMs, from = 0) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    for (let i = from; i < k.events.length; i++) if (pred(k.events[i])) return k.events[i]
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

const isRed = (e) => e.type === 'ponos_health' && (e.distortion?.tier === 'red' || e.ev?.distortion?.tier === 'red')

/** 跑两轮"引用不存在路径"把失真推到 red，然后第 3 轮用探针检查请求体 */
async function runAnchorScenario(extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-anchor-'))
  const k = spawnKernel({
    PONOS_MOCK_API: '1',
    PONOS_FIDELITY: '1',
    CLAUDE_CONFIG_DIR: dir,
    YFW_HOME: dir,
    ...extraEnv,
  }, dir)
  try {
    const init = await waitForEvent(k, (e) => e.type === 'system' && e.subtype === 'init', 20_000)
    if (!init) return { k, dir, ready: false, red: null, probes: [] }

    let from = 0
    for (let i = 0; i < 2; i++) {
      k.proc.stdin.write(JSON.stringify({
        type: 'user',
        session_id: 'anchor-inject-e2e',
        message: { role: 'user', content: `[mock:fidelity-read-fail] 请核对 ${MISSING} 里的配置` },
      }) + '\n')
      const done = await waitForEvent(k, (e) => e.type === 'result', 30_000, from)
      if (!done) return { k, dir, ready: true, red: null, probes: [] }
      from = done.idx + 1
    }
    const red = await waitForEvent(k, isRed, 15_000, 0)

    // 第 3 轮：mock 收到请求时扫非 system 条目
    k.proc.stdin.write(JSON.stringify({
      type: 'user',
      session_id: 'anchor-inject-e2e',
      message: { role: 'user', content: `再核对一次 ${MISSING}` },
    }) + '\n')
    await waitForEvent(k, (e) => e.type === 'result', 30_000, from)
    // 探针走 stderr 旁路（见 kernel/api.mjs）：每轮一次，取值 = 该轮请求体是否含锚点标记
    const probes = [...k.err.matchAll(/ANCHOR_PROBE:(\d+)/g)].map((m) => m[1])
    return { k, dir, ready: true, red, probes }
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    // 等进程真正退出再交还控制权：Windows 上未释放的句柄会让上层 rmSync 报 EPERM
    await new Promise((r) => setTimeout(r, 400))
  }
}

test('e2e: 失真 red 后，锚点真的进入发给模型的请求（默认开启）', { timeout: 120_000 }, async (t) => {
  const { k, dir, ready, red, probes } = await runAnchorScenario({ PONOS_MOCK_ANCHOR_PROBE: ANCHOR_MARK })
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 下内核句柄可能未释放，清理失败不影响断言结论 */ } })
  assert.ok(ready, `内核未就绪\nstdout=${k.out.slice(-600)}\nstderr=${k.err.slice(-600)}`)
  assert.ok(red, `两轮后应出现 distortion.tier=red\nstdout=${k.out.slice(-1500)}`)
  assert.ok(probes.length >= 3, `探针应至少记录 3 轮请求，实际 ${probes.length} 轮\nstderr=${k.err.slice(-800)}`)
  assert.ok(probes.includes('1'), `red 之后的请求应含锚点标记，实际探针序列=[${probes.join(',')}]\nstderr=${k.err.slice(-800)}`)
})

test('e2e: 对照组 PONOS_FIDELITY_ANCHOR=0 时锚点不注入（排除假阳性）', { timeout: 120_000 }, async (t) => {
  const { k, dir, ready, red, probes } = await runAnchorScenario({
    PONOS_MOCK_ANCHOR_PROBE: ANCHOR_MARK,
    PONOS_FIDELITY_ANCHOR: '0',
  })
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 下内核句柄可能未释放，清理失败不影响断言结论 */ } })
  assert.ok(ready, `内核未就绪\nstderr=${k.err.slice(-600)}`)
  // 失真仍应被检出（关的只是注入，不是检测）——确保对照组与实验组的差异只在注入
  assert.ok(red, `失真检测不应被注入开关关掉\nstdout=${k.out.slice(-1500)}`)
  assert.ok(probes.length >= 3, `探针应至少记录 3 轮请求，实际 ${probes.length} 轮\nstderr=${k.err.slice(-800)}`)
  assert.ok(!probes.includes('1'), `关闭注入后任何一轮请求都不应含锚点，实际探针序列=[${probes.join(',')}]\nstderr=${k.err.slice(-800)}`)
})
