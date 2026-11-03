// 慢盘豁免声明帧的**内核侧出口**（2026-09-23 会话健康快照 批 3）。
//
// 为什么必须有这一层：豁免的机制价值全在"帧真的发出去了"——纯函数测试证明不了这条链路。
// Task 1/7 已把"要不要声明 / 窗口怎么算 / 节流"钉在纯函数与 disk-write 层，本文件只钉：
//   ① **接线真的接上了**（cli.mjs 调用 configureDiskWriter 并把出口接到 wire.diskWait）；
//   ② **慢盘 ⇒ 帧上 wire**（真实链路：diskWrite → 声明出口 → protocol.makeWire → stdout NDJSON）；
//   ③ **正常盘 ⇒ 零额外帧**（不产生噪音：慢盘声明只在确判"慢"时发）；
//   ④ **节流生效**（慢盘下连续写只发出极少数帧——声明本身也是延迟源，不得退化成"每次写一帧"）。
// ★ 慢写用**同步忙等**注入：要复现的正是"同步写阻塞主线程"这一事实（用 `await` 睡眠测不出本问题）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const cliSrc = readFileSync(join(REPO, 'kernel', 'cli.mjs'), 'utf8')
const protoSrc = readFileSync(join(REPO, 'kernel', 'protocol.mjs'), 'utf8')

/** 子进程 harness 源码：用**真实模块**跑真实链路（接线与 kernel/cli.mjs 逐字同形）。 */
function harnessSrc() {
  const u = (rel) => pathToFileURL(join(REPO, rel)).href
  return `
import { configureDiskWriter, diskWrite } from ${JSON.stringify(u('kernel/disk-write.mjs'))}
import { createDiskTelemetry } from ${JSON.stringify(u('kernel/disk-telemetry.mjs'))}
import { makeWire, writeLine } from ${JSON.stringify(u('kernel/protocol.mjs'))}

const mode = process.env.HARNESS_MODE || 'slow'
const slowMs = Number(process.env.HARNESS_SLOW_MS || 0)
const writes = Number(process.env.HARNESS_WRITES || 12)

// ★ 与 kernel/cli.mjs 的接线逐字同形：声明出口 = wire.diskWait
const wire = makeWire()
configureDiskWriter({ onDeclare: (d) => wire.diskWait(d) })

// 同步忙等：复现"同步落盘阻塞主线程"（写期间主线程停摆、心跳发不出去）
const busy = (ms) => { const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } }

let tel = null
if (mode === 'throttle') {
  // 慢判定已在样本里（P95=1000ms）：随后 100 次**快写**都落在同一个"慢盘"现场 ⇒ 只该发极少数帧
  tel = createDiskTelemetry({ slowMs: 1000, p95MinSamples: 5, window: 512 })
  for (let i = 0; i < 200; i++) tel.note('transcript-append', 1000, true)
}
for (let i = 0; i < writes; i++) {
  const r = diskWrite(tel, 'transcript-append', () => { if (slowMs > 0) busy(slowMs); return 'ok' })
  if (!r.ok) throw new Error('harness 写入不应失败: ' + String(r.error && r.error.message))
}
writeLine(process.stdout, { type: 'system', subtype: 'harness_done', mode, writes })
`
}

/** 跑一次 harness，返回它 stdout 上真实出现的帧序列。 */
async function runHarness(env, timeoutMs = 60000) {
  const dir = mkdtempSync(join(tmpdir(), 'disk-wait-wire-'))
  const file = join(dir, 'harness.mjs')
  writeFileSync(file, harnessSrc(), 'utf8')
  const p = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  p.stdout.setEncoding('utf8')
  p.stderr.setEncoding('utf8')
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { err += d })
  const done = new Promise((resolve) => p.once('close', (code) => resolve(code)))
  // ★ 超时定时器必须可清：留着它会让 node:test 等事件循环空转到超时（实测把 1.5s 的用例
  //   拖成 60s 的整文件时长——不是被测代码慢，是测试自己挂着一个 pending timer）。
  let timer = null
  const guard = new Promise((r) => { timer = setTimeout(() => { try { p.kill() } catch {} ; r('timeout') }, timeoutMs) })
  const code = await Promise.race([done, guard])
  if (timer) clearTimeout(timer)
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* Windows 句柄延迟 */ }
  const frames = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  return { code, frames, out, err }
}

const waitFrames = (frames) => frames.filter((f) => f.type === 'system' && f.subtype === 'disk_wait')

test('接线对账：cli 把 disk-write 的声明出口接到 wire.diskWait（帧形只由 protocol 定义）', () => {
  assert.match(cliSrc, /import \{[^}]*configureDiskWriter[^}]*\} from '\.\/disk-write\.mjs'/, 'cli.mjs 应引入 configureDiskWriter')
  assert.match(cliSrc, /configureDiskWriter\(\{\s*onDeclare:[^}]*\}\)/,
    'cli.mjs 应接线 onDeclare（否则 disk-write 的声明出口永远是 null ⇒ 豁免静默失效）')
  assert.match(cliSrc, /onDeclare: \(d\) => wire\.diskWait\(d\)/,
    '出口应走 protocol 的 wire.diskWait（帧形单一真源；cli 不自己拼 {type,subtype}）')
  assert.match(protoSrc, /diskWait\(fields = \{\}\)\s*\{\s*writeLine\(stream, \{ type: 'system', subtype: 'disk_wait', \.\.\.fields \}\)/,
    'protocol.mjs 应提供 diskWait()，写 {type:"system",subtype:"disk_wait",…}')
})

test('★ 慢盘：帧真的上 wire，且字段可用（site/windowMs/basis/reason）', async () => {
  const { code, frames } = await runHarness({
    HARNESS_MODE: 'slow', HARNESS_SLOW_MS: '120', HARNESS_WRITES: '12',
    PONOS_DISK_SLOW_MS: '50', PONOS_MOCK_API: '1',
  })
  assert.equal(code, 0, 'harness 应正常退出')
  assert.ok(frames.some((f) => f.subtype === 'harness_done'), 'harness 应跑完（否则下面的"零帧"断言是空转）')
  const dw = waitFrames(frames)
  assert.ok(dw.length > 0, `慢盘（每次写 ~120ms ≥ 阈值 50ms）必须发出 disk_wait 声明帧，实测帧序列：${JSON.stringify(frames.map((f) => f.subtype || f.type))}`)
  for (const f of dw) {
    assert.equal(f.type, 'system')
    assert.equal(f.site, 'transcript-append', '须带 site（排障要知道哪个落盘点慢）')
    assert.ok(Number.isFinite(f.basis) && f.basis >= 50, `须带依据（该点滚动 P95 实测值），实测 basis=${f.basis}`)
    assert.equal(f.reason, 'p95-slow', '唯一 declare 的一态')
    assert.equal(f.windowMs, Math.min(Math.round(f.basis * 2), 120_000), '★ 窗口 = min(round(P95×2), 120s 上限)（有界）')
    assert.ok(f.windowMs > 0 && f.windowMs <= 120_000)
  }
})

test('★ 正常盘：零额外帧（不产生噪音——快盘上声明豁免是纯负担）', async () => {
  const { code, frames } = await runHarness({
    HARNESS_MODE: 'fast', HARNESS_SLOW_MS: '0', HARNESS_WRITES: '12',
    PONOS_DISK_SLOW_MS: '50', PONOS_MOCK_API: '1',
  })
  assert.equal(code, 0)
  assert.ok(frames.some((f) => f.subtype === 'harness_done'), 'harness 应跑完')
  assert.deepEqual(waitFrames(frames), [], '快盘上不得发 disk_wait（P95 < 阈值 ⇒ reason=not-slow）')
})

test('★ 节流：慢判定在场时，连续 100 次写只发出极少数帧（帧数 ≪ 写次数，且窗口恒等不叠加）', async () => {
  const { code, frames } = await runHarness({
    HARNESS_MODE: 'throttle', HARNESS_SLOW_MS: '0', HARNESS_WRITES: '100',
    PONOS_DISK_SLOW_MS: '1000', PONOS_MOCK_API: '1',
  })
  assert.equal(code, 0)
  const dw = waitFrames(frames)
  assert.ok(dw.length >= 1, '慢判定在场 ⇒ 至少要声明一次（否则豁免失效）')
  assert.ok(dw.length < 10, `★ 100 次写的声明帧数必须远小于 100，实测 ${dw.length} 帧 — 无节流时会恰好 100 帧`)
  for (const f of dw) {
    assert.equal(f.windowMs, Math.min(Math.round(f.basis * 2), 120_000), '反复声明不得延长窗口（冷却只去重、不续期）')
  }
})

// ★ 回滚开关的**真链路**对账（2026-09-23 复核补）：桥侧那条回滚对账（`server/kernel-disk-exempt.test.mjs`
// 的"同一种 mock 帧照发、`=0` 照旧判死"）只覆盖**桥侧**；内核侧此前只有 `resolveDiskConfig` /
// `judgeDiskWait` 的**纯函数级**用例 —— 纯函数对不等于"真链路真的零帧"（接线漏了、或埋点绕过了
// 判定，纯函数用例都是绿的）。本用例跑**同一份 harness 输入**、只换这一个开关，做 A/B 对照：
//   · 慢盘阈值刻意压到极小（`PONOS_DISK_SLOW_MS=1`，每次写 ~120ms ⇒ 必判"慢"）⇒ "零帧"不可能
//     是"没判成慢"造成的；
//   · 开关开的那一次必须真的发帧（否则下面的"零帧"是空转：harness 没跑完/没进判定都长得像零帧）。
test('★ 回滚开关真链路：PONOS_KERNEL_DISK_EXEMPT_MS=0 ⇒ disk_wait 帧数 === 0（同输入对照，阈值压到极小）', async () => {
  const input = {
    HARNESS_MODE: 'slow', HARNESS_SLOW_MS: '120', HARNESS_WRITES: '12',
    PONOS_DISK_SLOW_MS: '1', PONOS_MOCK_API: '1', // 阈值 1ms：慢写（~120ms）必判"慢"
  }
  const on = await runHarness({ ...input, PONOS_KERNEL_DISK_EXEMPT_MS: '120000' })
  const off = await runHarness({ ...input, PONOS_KERNEL_DISK_EXEMPT_MS: '0' })
  assert.equal(on.code, 0, `开关开：harness 应正常退出（stderr: ${on.err.slice(-300)}）`)
  assert.equal(off.code, 0, `开关=0：harness 应正常退出（stderr: ${off.err.slice(-300)}）`)
  for (const [tag, r] of [['开', on], ['0', off]]) {
    assert.ok(r.frames.some((f) => f.subtype === 'harness_done'), `开关${tag}：harness 应跑完（否则帧数断言是空转）`)
  }
  const onFrames = waitFrames(on.frames)
  assert.ok(onFrames.length > 0,
    `前提：同一份输入在开关打开时**真的发帧**（实测 ${onFrames.length} 帧）——否则"零帧"不可归因于开关`)
  assert.deepEqual(waitFrames(off.frames), [],
    `★ 开关=0 ⇒ 真链路零帧（实测 ${waitFrames(off.frames).length} 帧）：reason='disabled' 时连一次 writeLine 都不该发生`)
})
