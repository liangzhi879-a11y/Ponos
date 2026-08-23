// server/provider-switch.test.mjs —— 内核原生 provider 热切换（docs/production/platform.md P4-5）
// spawn 真内核（kernel/cli.mjs + PONOS_MOCK_API=1），按契约注入 NDJSON 断言 stdout 事件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')
const HOME = mkdtempSync(join(tmpdir(), 'provider-switch-'))
test.after(() => { try { rmSync(HOME, { recursive: true, force: true }) } catch {} })

function spawnKernel(extraEnv = {}) {
  const proc = spawn(process.execPath, [KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio'], {
    cwd: HOME,
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: HOME, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const line = l.trim()
    if (!line) return
    if (waiters.length) waiters.shift()(line)
    else lines.push(line)
  })
  const reader = {
    next(timeoutMs = 8000) {
      if (lines.length) return Promise.resolve(lines.shift())
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('read timeout, queue=' + JSON.stringify(lines))), timeoutMs)
        waiters.push((l) => { clearTimeout(t); resolve(l) })
      })
    },
    async nextEvent() { return JSON.parse(await this.next()) },
  }
  return { proc, reader }
}

test('switch_provider：空闲切换成功 → provider_switched 回执 + 后续轮次正常', async () => {
  const { proc, reader } = spawnKernel({ ANTHROPIC_BASE_URL: 'http://orig', ANTHROPIC_AUTH_TOKEN: 'k1', ANTHROPIC_MODEL: 'm1' })
  try {
    const init = await reader.nextEvent()
    assert.equal(init.type, 'system')
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
    for (;;) { const e = await reader.nextEvent(); if (e.type === 'result') break }
    // 空闲 → 下发热切换
    proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request: { subtype: 'switch_provider', payload: { baseUrl: 'http://hot', authToken: 'k2', model: 'm2' } },
    }) + '\n')
    let switched = null
    for (let i = 0; i < 5; i++) {
      const e = await reader.nextEvent()
      if (e.type === 'system' && e.subtype === 'provider_switched') { switched = e; break }
    }
    assert.ok(switched, '应收到 provider_switched 回执')
    assert.equal(switched.model, 'm2')
    assert.equal(switched.baseUrl, 'http://hot')
    assert.ok(switched.version >= 1)
    // 切换后轮次仍正常（mock API 不回显 baseUrl，断言轮次闭环即可）
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'after switch' } }) + '\n')
    let ok = false
    for (let i = 0; i < 10; i++) { const e = await reader.nextEvent(); if (e.type === 'result') { ok = true; break } }
    assert.ok(ok, '切换后轮次应正常完成')
  } finally {
    proc.kill()
  }
})

test('switch_provider：busy 轮次中拒绝（provider_switch_rejected busy）', async () => {
  const { proc, reader } = spawnKernel({ ANTHROPIC_BASE_URL: 'http://orig', ANTHROPIC_AUTH_TOKEN: 'k1', ANTHROPIC_MODEL: 'm1' })
  try {
    await reader.nextEvent()  // init
    // 发一条 user 立即下发切换（turnActive 期间）
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '[mock:big]' } }) + '\n')
    proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request: { subtype: 'switch_provider', payload: { baseUrl: 'http://hot', authToken: 'k2', model: 'm2' } },
    }) + '\n')
    let rejected = null
    for (let i = 0; i < 12; i++) {
      const e = await reader.nextEvent()
      if (e.type === 'system' && e.subtype === 'provider_switch_rejected') { rejected = e; break }
    }
    assert.ok(rejected, 'busy 时应收到 provider_switch_rejected')
    assert.match(String(rejected.reason || ''), /busy/)
    // 本轮结果仍正常落地
    for (let i = 0; i < 8; i++) { const e = await reader.nextEvent(); if (e.type === 'result') break }
  } finally {
    proc.kill()
  }
})

test('switch_provider：非法 payload 拒绝（校验失败回执）', async () => {
  const { proc, reader } = spawnKernel({})
  try {
    await reader.nextEvent()
    proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request: { subtype: 'switch_provider', payload: { baseUrl: 'not-a-url', authToken: '', model: '' } },
    }) + '\n')
    let rejected = null
    for (let i = 0; i < 5; i++) {
      const e = await reader.nextEvent()
      if (e.type === 'system' && e.subtype === 'provider_switch_rejected') { rejected = e; break }
    }
    assert.ok(rejected, '非法 payload 应收到 rejected 回执')
    assert.match(String(rejected.reason || ''), /http/)
  } finally {
    proc.kill()
  }
})
