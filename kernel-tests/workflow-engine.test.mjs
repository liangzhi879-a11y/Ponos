// 引擎装配（Task 5）：DAG 运行 + 审计落盘 + 事件 + 校验进生产路径 + run 级 stop + cron
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowEngine, verifyRun } from '../kernel/workflow-engine.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { matchAutoTrigger } from '../kernel/workflow.mjs'

const WF = `name: demo
version: 1.0.0
inputs:
  - { name: n, type: number, required: true }
nodes:
  - { id: start, type: start }
  - { id: g, type: if, conditions: [{ var: "inputs.n", op: ">", value: 3 }] }
  - { id: big, type: template, template: "大 {{inputs.n}}" }
  - { id: small, type: template, template: "小 {{inputs.n}}" }
  - { id: done, type: end, config: { outputs: [{ name: result, selector: "{{big}}" }] } }
edges:
  - { id: e1, source: start, target: g }
  - { id: e2, source: g, target: big, sourceHandle: "true" }
  - { id: e3, source: g, target: small, sourceHandle: "false" }
  - { id: e4, source: big, target: done }
  - { id: e5, source: small, target: done }
`

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wf-eng-'))
  mkdirSync(join(root, 'wf', 'demo'), { recursive: true })
  writeFileSync(join(root, 'wf', 'demo', 'workflow.yml'), WF, 'utf-8')
  const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
  const engine = createWorkflowEngine({ configDir: root, registry, getModel: () => 'mock-model' })
  engine.addRoot(join(root, 'wf'))
  return { root, engine, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('DAG 运行：条件分支 + end 输出聚合 + 审计落盘可校验', async () => {
  const { engine, cleanup } = setup()
  try {
    const events = []
    engine.setDeps({ onEvent: (ev) => events.push(ev) })
    const r = await engine.run({ id: 'demo', inputs: { n: 5 } })
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300))
    assert.equal(r.outputs.done.output.result, '大 5')
    const skipped = events.filter((e) => e.type === 'node' && e.status === 'skipped').map((e) => e.node)
    assert.ok(skipped.includes('small'), `small 应被跳过：${JSON.stringify(events.map((e) => [e.type, e.node, e.status]))}`)
    assert.ok(events.some((e) => e.type === 'edge_taken'), 'edge_taken 事件缺失')
    assert.ok(r.auditPath && readFileSync(r.auditPath, 'utf-8').trim().split('\n').length >= 4, '审计应逐节点落盘')
    assert.equal(verifyRun(r.auditPath).ok, true, '哈希链应可校验')
  } finally { cleanup() }
})

test('非法工作流：校验失败即拒绝运行并给出 code', async () => {
  const { root, engine, cleanup } = setup()
  try {
    mkdirSync(join(root, 'wf', 'bad'), { recursive: true })
    writeFileSync(join(root, 'wf', 'bad', 'workflow.yml'), 'name: bad\nnodes:\n  - { id: a, type: start }\n', 'utf-8')
    const r = await engine.run({ id: 'bad', inputs: {} })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'LEGACY_DSL')
  } finally { cleanup() }
})

test('stop：运行中取消 → status=cancelled 且发 end(cancelled)', async () => {
  const { engine, cleanup } = setup()
  try {
    const events = []
    engine.setDeps({ onEvent: (e) => events.push(e) })
    const p = engine.run({ id: 'demo', inputs: { n: 1 }, runId: 'run-x' })
    engine.stop('run-x')
    const r = await p
    assert.equal(r.status, 'cancelled')
    assert.ok(events.some((e) => e.type === 'end' && e.status === 'cancelled'))
  } finally { cleanup() }
})

test('cron 匹配与调度器回调（不依赖真实定时器）', async () => {
  const { engine, cleanup } = setup()
  try {
    assert.equal(engine.cronMatches('0 18 * * 5', new Date('2026-09-11T18:00:00')), true)
    assert.equal(engine.cronMatches('0 18 * * 5', new Date('2026-09-11T19:00:00')), false)
  } finally { cleanup() }
})

// ============ 终审修复（M1/M2/M5） ============

// start → t(template) → done(end 无 outputs)：C2 场景
const NO_OUTPUTS = `name: plain
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

// confirm 三态路由：c 的三条条件边 handle = approved/rejected/timeout
const confirmWf = (id, timeoutMs) => `name: ${id}
version: 1.0.0
nodes:
  - { id: start, type: start }
  - { id: c, type: confirm, message: "批准？", timeout_ms: ${timeoutMs} }
  - { id: appr, type: template, template: "approved" }
  - { id: rej, type: template, template: "rejected" }
  - { id: tmo, type: template, template: "timeout" }
  - { id: done, type: end }
edges:
  - { id: e1, source: start, target: c }
  - { id: e2, source: c, target: appr, sourceHandle: "approved" }
  - { id: e3, source: c, target: rej, sourceHandle: "rejected" }
  - { id: e4, source: c, target: tmo, sourceHandle: "timeout" }
  - { id: e5, source: appr, target: done }
  - { id: e6, source: rej, target: done }
  - { id: e7, source: tmo, target: done }
`

test('输出合成兜底：无 end.outputs 时 finalOutput.result 取最后一个非终端节点输出（M2/C2）', async () => {
  const { root, engine, cleanup } = setup()
  try {
    mkdirSync(join(root, 'wf', 'plain'), { recursive: true })
    writeFileSync(join(root, 'wf', 'plain', 'workflow.yml'), NO_OUTPUTS, 'utf-8')
    const r = await engine.run({ id: 'plain', inputs: { x: '周' } })
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300))
    assert.deepEqual(r.outputs.done.output, {}, 'end 无 outputs 时其输出就是 {}')
    assert.equal(r.finalOutput.result, 'hi 周', `兜底必须排除 end 自身：${JSON.stringify(r.finalOutput)}`)
  } finally { cleanup() }
})

// 触发配置读取（M1/C1）：schedule/auto_trigger 的权威位置是 trigger_config，
// 顶层平铺字段是旧格式回退。startScheduler 与 CLI matchAutoTrigger 都消费 discover 条目。
test('触发配置：discover 优先读 trigger_config.schedule/auto_trigger，顶层旧字段回退（M1/C1）', async () => {
  const { root, engine, cleanup } = setup()
  try {
    const wfRoot = join(root, 'wf')
    mkdirSync(join(wfRoot, 'cfg'), { recursive: true })
    writeFileSync(join(wfRoot, 'cfg', 'workflow.yml'), `name: cfg
version: 1.0.0
triggers: [周报, 日报]
trigger_config:
  manual: true
  auto_trigger: true
  schedule: "0 18 * * 5"
nodes:
  - { id: start, type: start }
  - { id: done, type: end }
edges:
  - { id: e1, source: start, target: done }
`, 'utf-8')
    mkdirSync(join(wfRoot, 'flat'), { recursive: true })
    writeFileSync(join(wfRoot, 'flat', 'workflow.yml'), `name: flat
version: 1.0.0
triggers: 周报, 日报
schedule: "0 9 * * 1"
auto_trigger: true
nodes:
  - { id: start, type: start }
  - { id: done, type: end }
edges:
  - { id: e1, source: start, target: done }
`, 'utf-8')
    const byId = Object.fromEntries(engine.discover(wfRoot).map((w) => [w.id, w]))
    assert.equal(byId.cfg.schedule, '0 18 * * 5', `scheduler 消费的 schedule 必须来自 trigger_config：${JSON.stringify(byId.cfg)}`)
    assert.equal(byId.cfg.autoTrigger, true, JSON.stringify(byId.cfg))
    assert.deepEqual(byId.cfg.triggers, ['周报', '日报'], `triggers 逗号标量/数组都要解析：${JSON.stringify(byId.cfg.triggers)}`)
    assert.equal(byId.flat.schedule, '0 9 * * 1', '旧顶层字段须回退可读')
    assert.equal(byId.flat.autoTrigger, true)
    assert.deepEqual(byId.flat.triggers, ['周报', '日报'], '逗号标量 triggers 需解析（Minor-1）')
    // CLI 自动触发的消费路径（matchAutoTrigger）：trigger_config.auto_trigger=true 必须能命中
    assert.equal(matchAutoTrigger(engine.discover(wfRoot), '帮我写周报')?.id, 'cfg', 'auto_trigger 应经 trigger_config 生效')
    assert.equal(matchAutoTrigger(engine.discover(wfRoot), '无关文本'), null)
  } finally { cleanup() }
})

async function runWithResolve(engine, id, action) {
  const events = []
  let ready
  const got = new Promise((res) => { ready = res })
  engine.setDeps({ onEvent: (e) => { events.push(e); if (e.type === 'confirm_request') ready(e) } })
  const p = engine.run({ id, inputs: {}, runId: `run-${id}` })
  await got
  engine.resolveConfirm(`run-${id}`, 'c', { action })
  return { r: await p, events }
}

test('confirm 三态路由：approved/rejected/timeout 各激活对应 handle 分支（M5）', async () => {
  const { root, engine, cleanup } = setup()
  try {
    const mk = (id, timeoutMs) => { mkdirSync(join(root, 'wf', id), { recursive: true }); writeFileSync(join(root, 'wf', id, 'workflow.yml'), confirmWf(id, timeoutMs), 'utf-8') }
    mk('conf-a', 5000); mk('conf-r', 5000); mk('conf-t', 30)
    // 批准 → appr 分支
    const a = await runWithResolve(engine, 'conf-a', 'approved')
    assert.equal(a.r.ok, true, JSON.stringify(a.r).slice(0, 300))
    assert.equal(a.r.outputs.appr.output, 'approved')
    assert.ok(a.events.some((e) => e.type === 'confirm_request'), 'confirm_request 事件缺失')
    assert.ok(a.events.some((e) => e.type === 'node' && e.node === 'rej' && e.status === 'skipped'), 'rejected 分支应被跳过')
    assert.ok(a.events.some((e) => e.type === 'node' && e.node === 'tmo' && e.status === 'skipped'), 'timeout 分支应被跳过')
    assert.equal(a.r.finalOutput.result, 'approved', '兜底取分支节点输出（M2 同源）')
    // 驳回 → rej 分支
    const rj = await runWithResolve(engine, 'conf-r', 'rejected')
    assert.equal(rj.r.outputs.rej.output, 'rejected')
    assert.ok(rj.events.some((e) => e.type === 'node' && e.node === 'appr' && e.status === 'skipped'), 'approved 分支应被跳过')
    // 超时（不 resolve）→ tmo 分支
    engine.setDeps({ onEvent: () => {} })
    const t = await engine.run({ id: 'conf-t', inputs: {}, runId: 'run-conf-t' })
    assert.equal(t.ok, true, JSON.stringify(t).slice(0, 300))
    assert.equal(t.outputs.tmo.output, 'timeout')
    assert.ok(t.outputs.appr.skipped === true && t.outputs.rej.skipped === true, '其余两态应被跳过')
  } finally { cleanup() }
})
