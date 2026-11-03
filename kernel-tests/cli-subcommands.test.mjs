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
    const env = { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: join(dir, 'home'), PONOS_HOME: join(dir, 'home') }
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

// ★ 回归钉子（2026-10-21）：格式门禁（`only stream-json I/O format is supported`）
// 原本排在子命令短路**之前**，于是「人/agent 直接敲 CLI」形如
// `node kernel/cli.mjs --knowledge append --theme … --text …` 一律被打回 —— 而这正是
// 内核自己注入的沉淀指令（kernel/memory.mjs#sedimentCommand 生成的是裸调用）⇒ 死指令。
// 上一条用例发现不了它：桥侧与既有夹具**总是**带那两个标志。
// 故这里用**不带** FMT 的裸调用钉住三件事：
// ① 一次性子命令裸调用可用；② 其结果与带标志时一致；③ 长驻 loop 缺标志仍被拒。
test('cli 子命令裸调用（不带 stream-json 标志）可用；loop 缺标志仍退出 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-clibare-'))
  try {
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const env = { ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: home }
    delete env.PONOS_HOME // 同上一用例：防宿主演进内核解析链

    const bare = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [KERNEL_CLI, '--knowledge', 'tags'], { env })
      let out = ''
      let err = ''
      proc.stdout.on('data', (d) => { out += d })
      proc.stderr.on('data', (d) => { err += d })
      proc.on('close', (code) => resolve({ code, out, err }))
      proc.on('error', reject)
    })
    assert.equal(bare.code, 0, `裸调用被拒（门禁位置回归）：${bare.err}`)
    assert.ok(!bare.err.includes('only stream-json'), '裸调用不应再报 stream-json 门禁')
    assert.ok(Array.isArray(JSON.parse(bare.out).tags), '裸调用应输出与带标志时同形的 JSON')

    const loop = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [KERNEL_CLI, '--print'], { env })
      let err = ''
      proc.stderr.on('data', (d) => { err += d })
      proc.on('close', (code) => resolve({ code, err }))
      proc.on('error', reject)
    })
    assert.equal(loop.code, 2, '长驻 loop 缺 stream-json 标志必须仍被拒（门禁不能整体失效）')
    assert.ok(loop.err.includes('only stream-json I/O format is supported'), loop.err)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
