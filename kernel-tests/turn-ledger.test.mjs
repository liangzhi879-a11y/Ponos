// T0.3（治理计划 2026-10-20-token-context-governance）：轮级账本落盘。
//
// 问题（问0）：C_success 的分母是"成功任务数"，而成功性此前**只在引擎内存的 turnStats 里**
// （进程一退就没了）⇒ 分母不可从盘上算，"每成功任务费用"这条唯一验收指标根本算不出来。
//
// 改法：轮末（与 inject_snapshot / guard_turn 同点同守卫）落一条 `meta kind='turn'`：
//   { turnIndex, ok, errorKind, usage, model, costUsd, priceSource, compactCount, cache,
//     skillsUsed, toolCalls }
//
// 本文件钉住 5 条（前 3 条在改动前必红——盘上根本没有 turn 行）：
//   ① 每轮一条 turn 行，turnIndex 连续
//   ② ★ 成功轮 ok=true、失败轮 ok=false（只记成功轮会让失败次数永远为 0）
//   ③ ★ 费用随账落盘：costUsd = usage × 本轮模型单价，且 priceSource 可分辨
//   ④ ★ toolCalls 只记名字+次数（不记内容），skillsUsed 是工具调用入参里的技能 id
//   ⑤ 不重复记账：同一 turnIndex 只落一行（多轮会话里逐轮各一条）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeSegment } from '../kernel/session.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

function spawnKernel(env, dir) {
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], { env: { ...process.env, ...env }, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  let buf = ''
  let out = ''
  let err = ''
  proc.stdout.on('data', (d) => {
    const chunk = String(d)
    out += chunk
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行/脏行跳过 */ }
    }
  })
  proc.stderr.on('data', (d) => { err += String(d) })
  return { proc, events, get out() { return out }, get err() { return err } }
}

async function waitFor(k, pred, timeoutMs = 40_000, from = 0) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    for (let i = from; i < k.events.length; i++) if (pred(k.events[i])) return { ev: k.events[i], idx: i }
    if (k.proc.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

const readEntries = (file) => {
  try {
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

const allEntries = (configDir, cwd) => {
  const dir = join(configDir, 'projects', sanitizeSegment(cwd))
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { return [] }
  return files.flatMap((f) => readEntries(join(dir, f)))
}

async function waitForTurns(configDir, cwd, n, timeoutMs = 25_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const turns = allEntries(configDir, cwd).filter((e) => e?.type === 'meta' && e.kind === 'turn')
    if (turns.length >= n) return turns
    await new Promise((r) => setTimeout(r, 50))
  }
  return allEntries(configDir, cwd).filter((e) => e?.type === 'meta' && e.kind === 'turn')
}

async function stop(k) {
  try { if (!k.proc.stdin.writableEnded) k.proc.stdin.end() } catch { /* ignore */ }
  await new Promise((res) => {
    const t = setTimeout(() => { try { k.proc.kill() } catch { /* ignore */ } ; res() }, 5_000)
    k.proc.once('exit', () => { clearTimeout(t); res() })
  })
}

test('★ T0.3 轮级账本：每轮一条 turn 行，含 usage / 费用 / 工具计数 / 技能 id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-ledger-'))
  const k = spawnKernel({ PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: dir, PONOS_HOME: dir }, dir)
  try {
    const init = await waitFor(k, (e) => e.type === 'system' && e.subtype === 'init', 40_000)
    assert.ok(init, `内核未就绪\nstdout=${k.out.slice(-400)}\nstderr=${k.err.slice(-600)}`)

    // 第 1 轮：普通文本（成功）
    k.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '第一轮' } }) + '\n')
    assert.ok(await waitFor(k, (e) => e.type === 'result', 60_000, init.idx + 1), '第 1 轮未结束')

    const turns = await waitForTurns(dir, dir, 1)
    assert.ok(turns.length >= 1, '★ 盘上必须有 meta kind=turn 行（改动前一条都没有）')
    const t1 = turns[0]
    assert.equal(t1.turnIndex, 1)
    // ② 成功轮
    assert.equal(t1.ok, true, '★ 正常收束的轮 ok 必须为 true')
    assert.equal(t1.errorKind, null, '成功轮不得带 errorKind')
    // ③ 费用随账落盘（mock 每次请求 10 in / 20 out）
    assert.ok(t1.usage && Number(t1.usage.input_tokens) > 0, 'usage 必须随账落盘（C_success 的分子来源）')
    assert.ok(Number.isFinite(Number(t1.costUsd)) && Number(t1.costUsd) > 0,
      `★ costUsd 必须是有限正数（实测 ${t1.costUsd}）`)
    assert.ok(['provider', 'builtin', 'estimate'].includes(t1.priceSource),
      `★ priceSource 必须可分辨（实测 ${t1.priceSource}）—— estimate = 金额是估算`)
    assert.equal(typeof t1.compactCount, 'number', 'compactCount 必须是个数')
    // ④ 只记统计与引用
    assert.equal(typeof t1.toolCalls, 'object')
    assert.ok(Array.isArray(t1.skillsUsed), 'skillsUsed 必须是数组（T1.2b 的分组键）')
    // 隐私口径：不得把正文带进账（只允许 toolCalls 的名字/次数）
    const serialized = JSON.stringify(t1)
    assert.equal(serialized.includes('第一轮'), false, '账本不得复制用户正文')

    // 第 2 轮：验证 turnIndex 连续、不重复记
    k.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '第二轮' } }) + '\n')
    await waitFor(k, (e) => e.type === 'result', 60_000)
    const turns2 = await waitForTurns(dir, dir, 2)
    assert.equal(turns2.length, 2, '★ 两轮就必须两条（每轮一条，不多不少）')
    assert.deepEqual(turns2.map((x) => x.turnIndex), [1, 2], '★ turnIndex 必须连续且不重复（重记即红）')
  } finally {
    await stop(k)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ T0.3 失败轮：ok=false + errorKind（纯函数分支，确定性断言）', async () => {
  // ★ 为什么走纯函数而不 spawn：mock 没有"引擎内部抛错"的注入开关，端到端只能验证
  //   "有没有账"，无法确定地复现失败轮 —— 那是**空断言**（本仓禁）。故行构造收口成
  //   `buildTurnLedgerRow` 后在这里直接钉死两个分支。
  const { buildTurnLedgerRow } = await import('../kernel/turn-ledger.mjs')
  const priceOf = () => ({ pricePerMInput: 1, pricePerMOutput: 0, cacheReadRatio: 0.1, source: 'builtin' })
  const usage = { input_tokens: 1_000_000, output_tokens: 0 }

  // ① 失败轮：必须 ok=false 且带 errorKind，且**费用照样记**（钱已经花了）
  const fail = buildTurnLedgerRow({ usage, model: 'm', isError: true, errorKind: 'TimeoutError' }, { turnIndex: 3, priceOf })
  assert.equal(fail.ok, false, '★ 失败轮必须 ok=false（只记成功轮 = 失败次数永远为 0）')
  assert.equal(fail.errorKind, 'TimeoutError', '★ 失败原因必须落盘（下游按它分类）')
  assert.equal(fail.costUsd, 1, '失败轮的花费照样要记（钱花了才算 C_success 的分子）')
  assert.equal(fail.turnIndex, 3)

  // ② 成功轮：ok=true、errorKind=null
  const okRow = buildTurnLedgerRow({ usage, model: 'm' }, { turnIndex: 4, priceOf })
  assert.equal(okRow.ok, true)
  assert.equal(okRow.errorKind, null, '成功轮不得带 errorKind')

  // ③ 缺 usage（内部错误轮）：costUsd 必须 null，不得 0（"没测到"≠"免费"）
  const noUsage = buildTurnLedgerRow({ usage: null, model: 'm', isError: true, errorKind: 'internal' }, { turnIndex: 5, priceOf })
  assert.equal(noUsage.costUsd, null, '★ 无 usage ⇒ costUsd 必须是 null（写成 0 会把 C_success 压低）')
  assert.equal(noUsage.ok, false)
})

test('★ T0.3 行构造：只记统计与引用（不复制正文），工具/技能按名字与 id 计数', async () => {
  const { buildTurnLedgerRow } = await import('../kernel/turn-ledger.mjs')
  const priceOf = () => ({ pricePerMInput: 1, pricePerMOutput: 0, cacheReadRatio: 0.1, source: 'estimate' })
  const row = buildTurnLedgerRow(
    { usage: { input_tokens: 10, output_tokens: 20 }, model: 'deepseek-chat', compactCount: 2, cache: { state: 'hit' } },
    {
      turnIndex: 1,
      priceOf,
      toolDigest: [
        { name: 'Read', path: '/a.txt' },
        { name: 'Read', path: '/b.txt' },
        { name: 'Skill', skill: 'gxtz-suite' },
        { name: 'Skill', skill: 'gxtz-suite' },   // 同技能两次 ⇒ skillsUsed 去重
        { name: 'Skill', skill: 'code-review' },
        { name: '' },                              // 空名跳过不猜
      ],
    },
  )
  assert.deepEqual(row.toolCalls, { Read: 2, Skill: 3 }, '只记名字+次数（不记 path/内容）')
  assert.deepEqual(row.skillsUsed, ['gxtz-suite', 'code-review'], '技能 id 去重保序')
  assert.equal(row.compactCount, 2)
  assert.deepEqual(row.cache, { state: 'hit' })
  assert.equal(row.priceSource, 'estimate', '价源如实透传（estimate = 金额是估算）')
  // 隐私：行里不得出现任何正文/path
  const s = JSON.stringify(row)
  assert.equal(s.includes('/a.txt'), false, '★ 不得把 path 带进账本（工具计数只要名字）')
})

test('★ T0.3 端到端：盘上确有 turn 行（cli 接线未被纯函数重构改断）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-ledger-wire-'))
  const k = spawnKernel({ PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: dir, PONOS_HOME: dir }, dir)
  try {
    const init = await waitFor(k, (e) => e.type === 'system' && e.subtype === 'init', 40_000)
    assert.ok(init, `内核未就绪\nstderr=${k.err.slice(-600)}`)
    k.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '记一轮' } }) + '\n')
    await waitFor(k, (e) => e.type === 'result', 60_000, init.idx + 1)
    const turns = await waitForTurns(dir, dir, 1)
    assert.ok(turns.length >= 1, '★ cli 必须把 turn 行真的落盘（纯函数抽出来以后接线断了即红）')
    assert.equal(turns[0].turnIndex, 1)
  } finally {
    await stop(k)
    rmSync(dir, { recursive: true, force: true })
  }
})
