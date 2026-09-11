// Task 5 审查 I-2：`load`/`validate`/`stop` 三个新增 /wf 子命令零覆盖 → 经
// `workflow_command` 走真实进程端到端（spawn kernel/cli.mjs，stream-json 双向，
// 断言 wire 回发的 `workflow_result` 形状），不打桩内部函数。
// 覆盖：load 合法工作流 → ok:true（含 yml 原文 + validation）；validate 合法 → ok:true、
// 不存在 → errors[0].code === 'NOT_FOUND'；stop 空 runId → ok:false、有 runId → ok:true。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')
const FMT = ['--output-format', 'stream-json', '--input-format', 'stream-json']

// DSL v2 合法工作流（无 body/跨边界边）：start → template → end
const WF = `name: demo
version: 1.0.0
inputs:
  - { name: x, type: string, required: false }
nodes:
  - { id: start, type: start }
  - { id: t, type: template, template: "hi {{inputs.x}}" }
  - { id: done, type: end }
edges:
  - { id: e1, source: start, target: t }
  - { id: e2, source: t, target: done }
`

// 起内核进程 → 顺序发 workflow_command → 收齐 requestId 对应回执 → 关 stdin 收尾
function runCommands(root, commands) {
  return new Promise((resolve, reject) => {
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const env = { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: home, YFWORKING_HOME: home }
    delete env.PONOS_HOME // 防宿主演进内核解析链（cli-subcommands.test.mjs 同款隔离）
    // --skills-dir=工作流根：发现/加载走真实 resolveSkillRoots + loadWorkflow 路径
    const proc = spawn(process.execPath, [KERNEL_CLI, ...FMT, '--no-default-skills', '--skills-dir', join(root, 'wf')], { env })
    let out = ''
    let err = ''
    const results = new Map()
    const want = new Set(commands.map((c) => c.requestId))
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ results, out, err })
    }
    const timer = setTimeout(() => { proc.kill('SIGKILL'); done() }, 20000)
    proc.stdout.on('data', (d) => {
      out += d
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue
        let ev = null
        try { ev = JSON.parse(line) } catch { continue }
        if (ev?.subtype && want.has(ev.requestId) && !results.has(ev.requestId)) {
          results.set(ev.requestId, ev)
          if (results.size === want.size) { try { proc.stdin.end() } catch { /* ignore */ } }
        }
      }
    })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('error', reject)
    proc.on('close', () => done())
    for (const c of commands) proc.stdin.write(JSON.stringify({ type: 'workflow_command', ...c }) + '\n')
  })
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wf-cli-'))
  mkdirSync(join(root, 'wf', 'demo'), { recursive: true })
  writeFileSync(join(root, 'wf', 'demo', 'workflow.yml'), WF, 'utf-8')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('workflow_command：load 合法工作流 → ok:true（yml 原文 + validation.ok）', async () => {
  const { root, cleanup } = setup()
  try {
    const { results, err } = await runCommands(root, [{ subtype: 'load', requestId: 'load-1', payload: { id: 'demo' } }])
    const ev = results.get('load-1')
    assert.ok(ev, `未收到 load 回执；stderr=${err.slice(-500)}`)
    assert.equal(ev.subtype, 'load')
    assert.equal(ev.result.ok, true, JSON.stringify(ev.result))
    assert.equal(ev.result.id, 'demo')
    assert.match(ev.result.yml, /type: template/, 'yml 原文应逐字回读（依赖 loadWorkflow 的 path）')
    assert.equal(ev.result.validation.ok, true, JSON.stringify(ev.result.validation))
  } finally { cleanup() }
})

test('workflow_command：validate 合法 → ok:true；不存在 → errors[0].code === NOT_FOUND', async () => {
  const { root, cleanup } = setup()
  try {
    const { results, err } = await runCommands(root, [
      { subtype: 'validate', requestId: 'val-ok', payload: { id: 'demo' } },
      { subtype: 'validate', requestId: 'val-miss', payload: { id: 'no-such-wf' } },
    ])
    const ok = results.get('val-ok')
    assert.ok(ok, `未收到 validate 回执；stderr=${err.slice(-500)}`)
    assert.equal(ok.result.ok, true, JSON.stringify(ok.result))
    assert.deepEqual(ok.result.errors, [])
    const miss = results.get('val-miss')
    assert.ok(miss)
    assert.equal(miss.result.ok, false)
    assert.equal(miss.result.errors[0].code, 'NOT_FOUND', JSON.stringify(miss.result))
  } finally { cleanup() }
})

test('workflow_command：stop 空 runId → ok:false（必填）；有 runId → ok:true', async () => {
  const { root, cleanup } = setup()
  try {
    const { results, err } = await runCommands(root, [
      { subtype: 'stop', requestId: 'stop-empty', payload: {} },
      { subtype: 'stop', requestId: 'stop-1', payload: { runId: 'run-cli-1' } },
    ])
    const empty = results.get('stop-empty')
    assert.ok(empty, `未收到 stop 回执；stderr=${err.slice(-500)}`)
    assert.equal(empty.result.ok, false)
    assert.match(empty.result.error, /runId 必填/)
    const one = results.get('stop-1')
    assert.ok(one)
    assert.equal(one.result.ok, true, JSON.stringify(one.result))
  } finally { cleanup() }
})
