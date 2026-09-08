// kernel-readonly 冒烟：真实 spawn kernel 只读子命令（PONOS_MOCK_API=1 + 临时 home，
// 与 kernel-bridge.test.mjs 同款隔离）。npm test server/*.test.mjs glob 收录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kernelReadonlySync, resolveKernelCli } from './kernel-readonly.mjs'

test('resolveKernelCli：能定位 kernel cli.mjs', () => {
  const p = resolveKernelCli()
  assert.ok(p.endsWith('cli.mjs'), p)
})

test('kernelReadonlySync：--agents / --usage 真实 spawn 返回 JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kr-home-'))
  try {
    const env = { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: home, YFWORKING_HOME: home }
    delete env.PONOS_HOME // 防宿主演进内核解析链（kernel-bridge.test.mjs 同款隔离）
    const agents = JSON.parse(kernelReadonlySync(['--agents'], { env, cwd: process.cwd() }))
    assert.ok(Array.isArray(agents) && agents.length >= 2)
    const usage = JSON.parse(kernelReadonlySync(['--usage'], { env, cwd: process.cwd() }))
    assert.equal(typeof usage.totals.input_tokens, 'number')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
