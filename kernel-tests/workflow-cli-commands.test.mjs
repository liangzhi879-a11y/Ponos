// Task 5 审查 I-2：`load`/`validate`/`stop` 三个新增 /wf 子命令零覆盖 → 经
// `workflow_command` 走真实进程端到端（spawn kernel/cli.mjs，stream-json 双向，
// 断言 wire 回发的 `workflow_result` 形状），不打桩内部函数。
// 覆盖：load 合法工作流 → ok:true（含 yml 原文 + validation）；validate 合法 → ok:true、
// 不存在 → errors[0].code === 'NOT_FOUND'；stop 空 runId → ok:false、有 runId → ok:true。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
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

// 旧格式（DSL v1）工作流：数组顺序 + next + 平铺 schedule/auto_trigger + 逗号标量 triggers
const LEGACY_WF = `name: legacy-demo
version: 1.0.0
description: 旧格式工作流
triggers: 旧日报, 旧周报
schedule: "0 18 * * 5"
auto_trigger: false
nodes:
  - { id: start, type: start, next: t }
  - { id: t, type: template, template: "hi {{inputs.x}}" }
  - { id: done, type: end }
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
  mkdirSync(join(root, 'wf', 'legacy-demo'), { recursive: true })
  writeFileSync(join(root, 'wf', 'legacy-demo', 'workflow.yml'), LEGACY_WF, 'utf-8')
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

// ============ 终审修复（M6/M7） ============

test('workflow_command：list/run/verify/scheduler 回执带 requestId + list 补 legacy/expose/dslVersion（M6/M7）', async () => {
  const { root, cleanup } = setup()
  try {
    const { results, err } = await runCommands(root, [
      { subtype: 'list', requestId: 'list-1' },
      { subtype: 'run', requestId: 'run-1', payload: { workflow: 'demo', inputs: { x: 1 } } },
      { subtype: 'scheduler', requestId: 'sched-1' },
    ])
    const list = results.get('list-1')
    assert.ok(list, `list 回执缺 requestId（宿主 send() 按 requestId 配对会超时）；stderr=${err.slice(-300)}`)
    const demo = list.workflows.find((w) => w.id === 'demo')
    assert.equal(demo.legacy, false)
    assert.equal(demo.dslVersion, 2)
    assert.deepEqual(demo.expose, {})
    const leg = list.workflows.find((w) => w.id === 'legacy-demo')
    assert.equal(leg.legacy, true, '旧格式必须带 legacy 标记（需升级通道）')
    assert.deepEqual(leg.triggers, ['旧日报', '旧周报'], `逗号标量 triggers 应解析：${JSON.stringify(leg.triggers)}`)
    assert.equal(leg.schedule, '0 18 * * 5', '旧顶层 schedule 需回退读取（C1）')
    const run = results.get('run-1')
    assert.ok(run, 'run 回执缺 requestId')
    assert.equal(run.ok, true, JSON.stringify(run).slice(0, 300))
    assert.equal(run.finalOutput.result, 'hi 1', `无 end.outputs 的兜底输出（C2）：${JSON.stringify(run.finalOutput)}`)
    const sched = results.get('sched-1')
    assert.ok(sched, 'scheduler 回执缺 requestId')
    assert.equal(sched.ok, true, JSON.stringify(sched))
    // verify 需真实 auditPath（run 回执给出）
    const { results: r2, err: e2 } = await runCommands(root, [{ subtype: 'verify', requestId: 'ver-1', payload: { auditPath: run.auditPath } }])
    const ver = r2.get('ver-1')
    assert.ok(ver, `verify 回执缺 requestId；stderr=${e2.slice(-300)}`)
    assert.equal(ver.ok, true, JSON.stringify(ver))
  } finally { cleanup() }
})

test('workflow_command：migrate 落盘 + versions 备份 + 幂等（M7）', async () => {
  const { root, cleanup } = setup()
  try {
    const before = readFileSync(join(root, 'wf', 'legacy-demo', 'workflow.yml'), 'utf-8')
    const { results, err } = await runCommands(root, [{ subtype: 'migrate', requestId: 'mig-1', payload: { id: 'legacy-demo' } }])
    const m = results.get('mig-1')
    assert.ok(m, `migrate 回执缺失；stderr=${err.slice(-400)}`)
    assert.equal(m.ok, true, JSON.stringify(m).slice(0, 400))
    assert.deepEqual(m.errors, [])
    assert.deepEqual(m.skipped, [])
    assert.equal(m.migrated.length, 1, JSON.stringify(m).slice(0, 300))
    const [one] = m.migrated
    assert.equal(one.id, 'legacy-demo')
    assert.match(one.backup.split('\\').join('/'), /\/versions\/legacy-.*\.yml$/, `备份路径：${one.backup}`)
    assert.equal(readFileSync(one.backup, 'utf-8'), before, '备份必须是原文逐字')
    const after = readFileSync(one.path, 'utf-8')
    assert.match(after, /^edges:/m, '迁移产物应含顶层 edges 块')
    assert.ok(one.edges >= 2, `迁移应生成边：${one.edges}`)

    const { results: r2 } = await runCommands(root, [
      { subtype: 'run', requestId: 'run-after', payload: { workflow: 'legacy-demo', inputs: { x: 'ok' } } },
      { subtype: 'migrate', requestId: 'mig-2' },
      { subtype: 'list', requestId: 'list-after' },
    ])
    const run = r2.get('run-after')
    assert.equal(run.ok, true, `迁移后应可运行：${JSON.stringify(run).slice(0, 300)}`)
    assert.equal(run.finalOutput.result, 'hi ok')
    const m2 = r2.get('mig-2')
    assert.deepEqual(m2.errors, [])
    assert.equal(m2.migrated.length, 0, '二次迁移必须幂等（不重复写盘）')
    assert.ok(m2.skipped.some((s) => s.id === 'legacy-demo'), JSON.stringify(m2))
    const list = r2.get('list-after')
    assert.equal(list.workflows.find((w) => w.id === 'legacy-demo').legacy, false, '迁移后不再是 legacy')
  } finally { cleanup() }
})
