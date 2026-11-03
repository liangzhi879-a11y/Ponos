// T0.1 工具面真实入账（当前台账少记 99%）—— 计量口径棘轮 + cli 接线端到端
// ---------------------------------------------------------------------------
// 规格真源：docs/superpowers/plans/2026-10-20-token-context-governance.md
//           「#### T0.1 工具面真实入账（当前台账少记 99%）」
// 病灶：`inject_snapshot.segments` 的 `toolSchema` 段此前取
//   `getPromptSegmentMeters().toolSchemaBytes` —— 那是 system 文本里「可用工具：…」**那一行**
//   的字节（实测 ≈237 B）；真正随请求发出去的 `tools[]` schema 面（实测 ≈31 KB）**完全不进账**
//   ⇒ 少记 99%，一切"省了多少"的结论都没有基线。
// 断言分三层，每层都能红（不许恒真、不许 `|| true`）：
//   ① 注册表实测 ≥ 20 KB（棘轮）：台账口径若退化为"只记一行"必然红
//   ② 总账口径：`totalBytes` 必须把真实工具面算进去（拿旧口径 237 B 喂进去 ⇒ 与期望值不等）
//   ③ cli 端到端（真内核进程 + mock API + 真 stdin）：落盘的 `inject_snapshot` 里
//      `toolSchema ≈ 31 KB`、`toolListLineBytes` 是那 ≈237 B 的行、`toolSchemaCount` = 本轮 schema 条数
//      （cli 侧计量接线被回退 ⇒ 红）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToolRegistry } from '../kernel/tools.mjs'
import { summarizeInjection } from '../kernel/inject-ledger.mjs'
import { sanitizeSegment } from '../kernel/session.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
/** 旧口径实测值：system 文本「可用工具：…」那行的字节（≈237 B，见 plan §0/§1.2）。 */
const LEGACY_TOOL_LINE_BYTES = 237

const faceBytesOf = (reg) => Buffer.byteLength(JSON.stringify(reg.toolSchemas()), 'utf8')

// ── ① 注册表实测（棘轮）─────────────────────────────────────────────────────

test('① 工具面真实字节进账，且不再退化为 237B 级', () => {
  const reg = createToolRegistry({ cwd: process.cwd() })
  const schemas = reg.toolSchemas()
  const bytes = faceBytesOf(reg)
  assert.ok(bytes >= 20_000, `工具面实测 ${bytes} B，台账不得低于 20 KB`) // 回退到"只记一行"必然红
  assert.equal(schemas.length, reg.toolNames.length,
    'schema 条数必须与 toolNames 同源（cli 侧缓存签名 = toolNames 拼接，靠这条才成立）')
  assert.ok(bytes > LEGACY_TOOL_LINE_BYTES * 20,
    `真实工具面必须远大于「可用工具：…」那行（${LEGACY_TOOL_LINE_BYTES} B）：实测 ${bytes} B`)
})

// ── ② 总账口径：totalBytes 必须含真实工具面 ──────────────────────────────────

test('② 总账 totalBytes 含真实工具面；旧口径 237 B 喂进去与期望值不等（红）', () => {
  const faceBytes = faceBytesOf(createToolRegistry({ cwd: process.cwd() }))
  const others = [{ id: 'systemPrompt', bytes: 1000 }, { id: 'skill', bytes: 500 }, { id: 'injected', bytes: 100 }]
  const otherSum = 1600

  const rec = summarizeInjection({
    segments: [others[0], { id: 'toolSchema', bytes: faceBytes }, others[1], others[2]],
    toolListLineBytes: LEGACY_TOOL_LINE_BYTES,
    toolSchemaCount: 23,
  })
  assert.equal(rec.totalBytes, otherSum + faceBytes, 'totalBytes 必须把真实工具面算进去（不是那 237 B 的行）')
  assert.ok(rec.totalBytes >= 20_000, `总账实测 ${rec.totalBytes} B，不得低于 20 KB`)

  // 旧口径（toolSchema 段 = 「可用工具：…」那行）落出来的总数：
  const legacy = summarizeInjection({
    segments: [others[0], { id: 'toolSchema', bytes: LEGACY_TOOL_LINE_BYTES }, others[1], others[2]],
    toolListLineBytes: LEGACY_TOOL_LINE_BYTES,
    toolSchemaCount: 23,
  })
  assert.equal(legacy.totalBytes, otherSum + LEGACY_TOOL_LINE_BYTES)
  assert.ok(rec.totalBytes - legacy.totalBytes >= 20_000,
    `新旧口径差额即此前漏记的工具面：${rec.totalBytes} - ${legacy.totalBytes}`)

  // 两个新字段是**顶层观测字段**：不进 segments、不加进 totalBytes（否则重复计数）
  assert.deepEqual(rec.segments.map((s) => s.id), ['systemPrompt', 'toolSchema', 'skill', 'injected'],
    'SEGMENT_ORDER 仍 4 段（工具面就该占 toolSchema 段，段名不变、只修口径）')
  assert.equal(rec.toolListLineBytes, LEGACY_TOOL_LINE_BYTES, '那行名单字节必须原样进台账（旧口径留痕）')
  assert.equal(rec.toolSchemaCount, 23, 'schema 条数必须原样进台账')
})

// ── ③ cli 端到端：落盘的 inject_snapshot 里的工具面 ───────────────────────────

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

async function waitForEvent(k, pred, timeoutMs = 30_000, from = 0) {
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

/** 轮末 inject_snapshot（读**真转录**：<configDir>/projects/<sanitized cwd>/<sid>.jsonl） */
async function waitForSnapshot(configDir, cwd, timeoutMs = 20_000) {
  const projectsDir = join(configDir, 'projects', sanitizeSegment(cwd))
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    let files = []
    try { files = readdirSync(projectsDir).filter((f) => f.endsWith('.jsonl')) } catch { /* 目录还没建 */ }
    for (const f of files) {
      const snap = readEntries(join(projectsDir, f)).find((e) => e?.type === 'meta' && e.kind === 'inject_snapshot')
      if (snap) return snap
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

test('③ cli 端到端：inject_snapshot 的 toolSchema 计真实工具面（≥20 KB），旧口径那行进 toolListLineBytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolface-e2e-'))
  const k = spawnKernel({ PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: dir, PONOS_HOME: dir }, dir)
  try {
    const init = await waitForEvent(k, (e) => e.type === 'system' && e.subtype === 'init', 40_000)
    assert.ok(init, `内核未就绪\nstdout=${k.out.slice(-500)}\nstderr=${k.err.slice(-500)}`)
    const initTools = init.ev.tools
    assert.ok(Array.isArray(initTools) && initTools.length > 0, 'init 帧必须带工具名单（toolSchemaCount 的同源判据）')

    k.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '记账一轮' } }) + '\n')
    const done = await waitForEvent(k, (e) => e.type === 'result', 60_000, init.idx + 1)
    assert.ok(done, `本轮未结束\nstdout=${k.out.slice(-800)}\nstderr=${k.err.slice(-800)}`)

    // ★ result 帧先于轮末记账块 ⇒ 轮询等落盘（序无关、非放宽：下面的数值断言一个字不降）
    const snap = await waitForSnapshot(dir, dir)
    assert.ok(snap, '轮末必须落一条 inject_snapshot（S1+/O4：每轮一条）')

    const toolSeg = (snap.segments || []).find((s) => s.id === 'toolSchema')
    assert.ok(toolSeg, 'inject_snapshot 必须有 toolSchema 段（段名不变、只修口径）')
    assert.ok(toolSeg.bytes >= 20_000,
      `toolSchema 段实测 ${toolSeg.bytes} B —— 不得退化为「可用工具：…」那行（旧口径 ≈${LEGACY_TOOL_LINE_BYTES} B）`)
    assert.ok(toolSeg.bytes > Number(snap.toolListLineBytes) * 20,
      `真实工具面（${toolSeg.bytes} B）必须远大于那行名单（${snap.toolListLineBytes} B）`)

    assert.ok(Number(snap.toolListLineBytes) > 0 && Number(snap.toolListLineBytes) < 2_000,
      `toolListLineBytes 应是「可用工具：…」那行的量级（实测 ${snap.toolListLineBytes} B）`)
    assert.equal(Number(snap.toolSchemaCount), initTools.length,
      'toolSchemaCount = 本轮发出的 schema 条数（与 init 帧 tools 名单同源）')
    assert.ok(Number(snap.totalBytes) >= 20_000, `totalBytes 实测 ${snap.totalBytes} B，不得低于 20 KB`)
  } finally {
    try { if (!k.proc.stdin.writableEnded) k.proc.stdin.end() } catch { /* ignore */ }
    await new Promise((res) => {
      const t = setTimeout(() => { try { k.proc.kill() } catch { /* ignore */ } ; res() }, 5_000)
      k.proc.once('exit', () => { clearTimeout(t); res() })
    })
    rmSync(dir, { recursive: true, force: true })
  }
})
