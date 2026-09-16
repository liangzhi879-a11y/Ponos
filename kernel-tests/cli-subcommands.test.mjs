// U1/AS1 cli 只读子命令冒烟：spawn `node kernel/cli.mjs --usage/--audit/--agents`
// （PONOS_CONFIG_DIR 指向 fixture 临时目录，PONOS_MOCK_API=1 免网络）→ stdout JSON。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeSegment } from '../kernel/session.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')
const FMT = ['--output-format', 'stream-json', '--input-format', 'stream-json']

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [KERNEL_CLI, ...FMT, ...args], { env })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('close', (code) => resolve({ code, out, err }))
    proc.on('error', reject)
  })
}

test('cli --usage / --audit / --agents：stdout JSON 输出 schema（fixture transcript）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-clisub-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, 's1.jsonl'),
      JSON.stringify({ type: 'assistant', seq: 1, timestamp: '2026-09-08T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 100, output_tokens: 50 }, model: 'm' } }) + '\n')
    const env = { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: join(dir, 'home'), YFWORKING_HOME: join(dir, 'home') }
    delete env.PONOS_HOME // 防宿主演进内核解析链（kernel-bridge.test.mjs 同款隔离）
    const usage = await runCli(['--usage'], env)
    assert.equal(usage.code, 0, usage.err)
    const u = JSON.parse(usage.out)
    assert.equal(u.totals.input_tokens, 100)
    assert.equal(u.totals.output_tokens, 50)
    assert.equal(u.byTool.Bash, 1)
    assert.equal(typeof u.costUsd, 'number')
    assert.equal(u.overBudget, false)
    const audit = await runCli(['--audit'], env)
    assert.equal(audit.code, 0, audit.err)
    const rows = JSON.parse(audit.out)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].tool, 'Bash')
    const agents = await runCli(['--agents'], env)
    assert.equal(agents.code, 0, agents.err)
    const list = JSON.parse(agents.out)
    assert.ok(Array.isArray(list) && list.some((a) => a.id === 'general-purpose'))
    assert.ok(list.every((a) => ['builtin', 'user'].includes(a.source)))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
