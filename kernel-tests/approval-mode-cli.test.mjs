// cli 审批档位接线：--approval-mode 解析 → 三级优先级 → system/init 回显 → stdin 热切换
// ---------------------------------------------------------------------------
// 优先级（刻意的顺序，见 cli.mjs opts 组装处的注释）：
//   显式 --approval-mode > 内核 settings.json 的 approvalMode > 旧 flag 派生
// 放在 settings 之上是因为旧 settings.json 可能残留 autoApproveHighRisk:true——它不得把
// 用户选定的 manual/auto 悄悄放宽成 bypass。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../kernel/cli.mjs'
import { deriveApprovalMode, DEFAULT_APPROVAL_MODE } from '../kernel/approval-mode.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')

test('parseArgs：--approval-mode 取值；缺省 null（不预设档位，交由派生/设置决定）', () => {
  assert.equal(parseArgs(['--approval-mode', 'manual']).approvalMode, 'manual')
  assert.equal(parseArgs(['--approval-mode', 'bypass']).approvalMode, 'bypass')
  assert.equal(parseArgs([]).approvalMode, null)
  // flag 后无值（argv 用尽）→ null，不得变成 undefined 而被 `||` 链跳过
  assert.equal(parseArgs(['--approval-mode']).approvalMode, null)
  // 非法值原样带出，由 opts 组装的 normalizeApprovalMode 回落默认档（不在解析层抛）
  assert.equal(parseArgs(['--approval-mode', 'plan']).approvalMode, 'plan')
  assert.equal(parseArgs(['--approval-mode', 'plan', '--verbose']).verbose, true, '后续参数仍应正常解析')
})

test('派生护栏：旧 flag 组合的档位（默认档 = loose = 今天的真实行为）', () => {
  assert.equal(deriveApprovalMode({ skipPermissions: true, autoApproveHighRisk: false }), 'loose')
  assert.equal(deriveApprovalMode({ skipPermissions: true, autoApproveHighRisk: true }), 'bypass')
  // 两个都无 → loose（**不是** manual：裸内核今天对非 Bash 工具是无条件放行的）
  assert.equal(deriveApprovalMode({ skipPermissions: false, autoApproveHighRisk: false }), 'loose')
  assert.equal(DEFAULT_APPROVAL_MODE, 'loose')
})

// —— 进程级：init 回显 + 优先级 + 热切换 ——
function spawnCli({ home, workDir, args = [] }) {
  const env = { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: home, YFWORKING_HOME: home }
  delete env.PONOS_HOME
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--permission-prompt-tool', 'stdio', '--add-dir', workDir, ...args,
  ], { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  let buf = ''
  const waiters = new Set()
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 非 NDJSON 行忽略 */ }
      for (const w of [...waiters]) w()
    }
  })
  const collect = (pred, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiters.delete(scan); reject(new Error(`collect timeout; events=${JSON.stringify(events.slice(0, 6))}`)) }, timeoutMs)
    const scan = () => {
      const i = events.findIndex(pred)
      if (i >= 0) { waiters.delete(scan); clearTimeout(t); resolve(events.splice(i, 1)[0]) }
    }
    waiters.add(scan)
    scan()
  })
  const send = (obj) => new Promise((res) => proc.stdin.write(JSON.stringify(obj) + '\n', res))
  const stop = async () => {
    try { if (!proc.stdin.writableEnded) proc.stdin.end() } catch { /* ignore */ }
    await new Promise((res) => { const t = setTimeout(() => { try { proc.kill() } catch {} ; res() }, 5000); proc.once('exit', () => { clearTimeout(t); res() }) })
  }
  return { proc, collect, send, stop }
}

async function withCli({ args = [], settings } = {}, fn) {
  const home = mkdtempSync(join(tmpdir(), 'yfw-amode-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-amode-work-'))
  // settings.json 必须在 spawn **之前**落盘：内核启动即读（loadSettings），spawn 后写会竞态
  if (settings) writeFileSync(join(home, 'settings.json'), JSON.stringify(settings, null, 2))
  const k = spawnCli({ home, workDir, args })
  try { return await fn(k) }
  finally { await k.stop(); rmSync(workDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
}

test('优先级：显式 flag > settings.json > 旧 flag 派生（init 逐一回显）', async () => {
  // ① 显式 flag 压过 settings.json（settings 写 manual，flag 给 bypass → bypass）
  await withCli({ args: ['--approval-mode', 'bypass'], settings: { approvalMode: 'manual' } }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.approval_mode, 'bypass', '显式 flag 优先级最高')
  })
  // ② settings.json 压过旧 flag（settings 写 manual，带 skip flag → manual）
  await withCli({ args: ['--dangerously-skip-permissions'], settings: { approvalMode: 'manual' } }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.approval_mode, 'manual', 'settings.json 残留的旧 flag 不得放宽用户选定档位')
  })
  // ③ 只有旧 flag → 派生 loose（今天的行为）
  await withCli({ args: ['--dangerously-skip-permissions'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.approval_mode, 'loose')
  })
  // ④ 什么都不给 → 也是 loose（裸内核：非 Bash 工具今天无条件放行，不能收紧成 manual）
  await withCli({}, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.approval_mode, DEFAULT_APPROVAL_MODE)
  })
  // ⑤ 非法 flag → 回落默认档（不放大、不崩）
  await withCli({ args: ['--approval-mode', 'plan'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.approval_mode, DEFAULT_APPROVAL_MODE)
  })
})

test('stdin 热切换：approval_mode → updated / 非法值 → rejected（回落默认档）', async () => {
  await withCli({ args: ['--approval-mode', 'loose'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.approval_mode, 'loose')
    await k.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'approval_mode', payload: { value: 'manual' } } })
    const upd = await k.collect((m) => m.type === 'system' && m.subtype === 'approval_mode_updated')
    assert.equal(upd.value, 'manual', '更新事件应回带新生效档位')
    // 大小写/空白容错：' MANUAL ' 仍视为合法（不落到 rejected 分支）
    await k.send({ type: 'control_request', request_id: 'r2', request: { subtype: 'approval_mode', payload: { value: ' BYPASS ' } } })
    const upd2 = await k.collect((m) => m.type === 'system' && m.subtype === 'approval_mode_updated')
    assert.equal(upd2.value, 'bypass')
    // 非法值：拒绝 + 明确回落值（不是静默忽略，否则 GUI 会显示假档位）
    await k.send({ type: 'control_request', request_id: 'r3', request: { subtype: 'approval_mode', payload: { value: 'plan' } } })
    const rej = await k.collect((m) => m.type === 'system' && m.subtype === 'approval_mode_rejected')
    assert.equal(rej.value, DEFAULT_APPROVAL_MODE, '非法档位应回落到默认档')
    assert.match(String(rej.reason), /非法档位/)
  })
})
