// P0-4（2026-09-16）：审批档「新装默认 = auto」且「存量用户零影响」的端到端证据。
// ---------------------------------------------------------------------------
// 设计背景（为何不是改一个常量那么简单）：
//   `DEFAULT_APPROVAL_MODE`（= 'loose'）是**兜底/回落值**，它同时被内核旧 flag 兼容推导
//   （kernel/approval-mode.mjs 的 deriveApprovalMode）复用、且被 approval-mode.test.mjs 与
//   内核值做一致性断言。**改它**会让"裸内核 / 旧 flag"路径把写文件从 allow 变 ask ——
//   属内核文件头明确禁止的行为回归。故方案 A 的实现是把"新装写入值"独立出来：
//   `NEW_INSTALL_APPROVAL_MODE = 'auto'`，仅用于 bridge 首次生成 config.json。
//
// 本文件用**真进程真端口**验证两件事（这是方案 A 的核心承诺）：
//   ① 新装（home 里无 config.json）→ 桥生成的 config.json 与运行时上报的档位都是 auto；
//   ② 存量（config.json 已显式持久化 loose，模拟老用户）→ 重启后**仍是 loose**（零行为变化）。
// 之所以不起 bridge 就断言常量：常量正确 ≠ 装配正确（DEFAULT_CONFIG 是否真引用了新常量、
// loadConfig 合并是否真被 cfg 覆盖，都只有起一次桥才能证）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('./bridge.mjs', import.meta.url))
const HOMES = []
const PROCS = []

after(() => {
  for (const p of PROCS.splice(0)) { try { p.kill('SIGKILL') } catch {} }
  for (const d of HOMES.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-p04-'))
  HOMES.push(dir)
  return dir
}

async function startBridge(home, port) {
  const proc = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, YFW_BRIDGE_PORT: String(port), YFW_HOME: home, YFWORKING_HOME: home },
    stdio: 'ignore',
  })
  PROCS.push(proc)
  return proc
}

/** 轮询等待某条件成立（默认 15s），返回条件是否满足 */
async function waitFor(fn, { timeoutMs = 15000, stepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await fn()) return true } catch { /* 未就绪，继续等 */ }
    await sleep(stepMs)
  }
  return false
}

/** 桥的运行时上报值（GET /config 无鉴权，与 GUI 设置页取档同一通道） */
async function fetchEffectiveMode(port) {
  const res = await fetch(`http://127.0.0.1:${port}/config`, { signal: AbortSignal.timeout(3000) })
  assert.ok(res.ok, `GET /config 应 200，实得 ${res.status}`)
  return (await res.json()).approvalMode
}

test('P0-4：新装默认档 = auto，且存量用户的 loose 档位零影响（真进程端到端）', async () => {
  const home = freshHome()
  const cfgPath = join(home, 'config.json')
  assert.equal(existsSync(cfgPath), false, '前置：新装 home 不应已有 config.json')

  // ---------- ① 新装：桥首次生成 config.json，运行时上报同向 ----------
  const port1 = 52301
  await startBridge(home, port1)
  assert.ok(await waitFor(() => existsSync(cfgPath)), '桥启动后应生成 config.json（15s 内未生成）')

  assert.equal(
    JSON.parse(readFileSync(cfgPath, 'utf-8')).approvalMode, 'auto',
    '新装写入的档位应为 auto（P0-4 新装默认）',
  )
  // 运行时生效值同向 —— 证明装配正确（DEFAULT_CONFIG 真引用了新常量），而非常量对、装配错
  assert.ok(await waitFor(async () => (await fetchEffectiveMode(port1)) === 'auto'), '桥上报的生效档位应为 auto')

  // ---------- ② 存量：预置 loose（模拟老用户盘上状态）后重启 ----------
  for (const p of PROCS) { try { p.kill('SIGKILL') } catch {} }
  await sleep(1200)
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf-8')), approvalMode: 'loose' }, null, 2), 'utf-8')

  const port2 = 52302
  await startBridge(home, port2)
  assert.ok(await waitFor(async () => (await fetchEffectiveMode(port2)) === 'loose'), '存量用户的档位必须保持 loose（方案 A 承诺老用户零行为变化）')
  assert.equal(
    JSON.parse(readFileSync(cfgPath, 'utf-8')).approvalMode, 'loose',
    '桥不得回写覆盖存量用户的档位（若被改成 auto，说明 DEFAULT_CONFIG 影响了存量路径，方案 A 失效）',
  )
})
