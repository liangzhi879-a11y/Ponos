// 编排线 T4（2026-10-07，spec D21–D24）：runOrchestrationTurn 纯接线单测（假 wfEngine）
// + 真引擎钉：pre-aborted 轮信号 ⇒ schedule 轮首取消（零节点执行、reply 为空）。
// 判据面：run 调用形状（inputs.message 逐字 / grant=null / runId 预置）/ 合成三路 /
// 缺失回退四因 + orchestration_unavailable 事件 / wall_ms 硬停 / 轮信号透传。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOrchestrationTurn, composeOrchestrationReply, DEFAULT_ORCHESTRATION_WALL_MS } from '../kernel/orchestrate.mjs'
import { createWorkflowEngine } from '../kernel/workflow-engine.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

// ── 假 wfEngine：只实现 load/run/stop 三方法（恰是 orchestrate.mjs 的消费面） ──
function fakeEngine({ finalOutput, status = 'completed', steps = 3, unresolved, onRun, loadThrows = false } = {}) {
  const calls = { run: [], stop: [] }
  let wf = { name: 'wf', orchestrate: { display_name: '测试编排' } }
  const api = {
    load() { if (loadThrows) throw new Error('boom'); return wf },
    setWf(v) { wf = v },
    run(opts) {
      calls.run.push(opts)
      if (onRun) return onRun(opts, api)
      return Promise.resolve({ ok: status === 'completed', status, steps, finalOutput, unresolved, runId: opts.runId })
    },
    stop(runId) { calls.stop.push(runId); return { ok: true } },
  }
  return { api, calls }
}

test('run 调用形状：inputs.message 逐字注入、grant=null、runId 预置；未给轮信号不凭空挂 signal 键', async () => {
  const f = fakeEngine({ finalOutput: { answer: '你好' } })
  const r = await runOrchestrationTurn({ wfEngine: f.api, workflowId: 'gen-review', message: '  原样 消息\n第二行 ', cwd: 'D:/work', runId: 'r-fixed' })
  assert.deepEqual(r, { reply: '你好', status: 'completed', runId: 'r-fixed', steps: 3 })
  assert.equal(f.calls.run.length, 1)
  const o = f.calls.run[0]
  assert.equal(o.id, 'gen-review')
  assert.equal(o.inputs.message, '  原样 消息\n第二行 ', 'D22：消息逐字注入（不 trim、不解读）')
  assert.deepEqual(Object.keys(o.inputs), ['message'], 'inputs 恰为 {message}（固定注入面）')
  assert.equal(o.cwd, 'D:/work')
  assert.equal(o.runId, 'r-fixed', '预置 runId 必须随 run 传入（wall_ms 的 stop 靶点）')
  assert.equal(o.grant, null, 'D19：会话审批管线口径——无 grantToken')
  assert.ok(!('signal' in o), '未给轮信号时不得凭空挂 signal 键')
})

test('回复合成三路：orchestrate.reply 键 > answer > result；键序拼接兜底', async () => {
  // ① reply 指定键（与 answer 并存时优先）
  let f = fakeEngine({ finalOutput: { deliverable: '交付物', answer: '兜底' } })
  f.api.setWf({ name: 'w', orchestrate: { reply: 'deliverable' } })
  let r = await runOrchestrationTurn({ wfEngine: f.api, workflowId: 'w', message: 'm' })
  assert.equal(r.reply, '交付物', 'reply 指定键优先于 answer')
  // ② 无 reply 键命中 → answer
  f = fakeEngine({ finalOutput: { answer: '答案', result: '结果' } })
  r = await runOrchestrationTurn({ wfEngine: f.api, workflowId: 'w', message: 'm' })
  assert.equal(r.reply, '答案', 'answer 优先于 result')
  // ③ 无 answer → result
  f = fakeEngine({ finalOutput: { result: '结果', other: 'x' } })
  r = await runOrchestrationTurn({ wfEngine: f.api, workflowId: 'w', message: 'm' })
  assert.equal(r.reply, '结果', '无 answer 时取 result')
  // ④ 三键皆无 → 端出键序拼接（null 跳过）
  f = fakeEngine({ finalOutput: { first: '一', second: '二', third: null } })
  r = await runOrchestrationTurn({ wfEngine: f.api, workflowId: 'w', message: 'm' })
  assert.equal(r.reply, '一\n\n二', '按 end.outputs 键序拼接；null 跳过')
  // ⑤ reply 键声明了但端出里没有 → 回落 answer（不产空回复）
  f = fakeEngine({ finalOutput: { answer: 'A' } })
  f.api.setWf({ name: 'w', orchestrate: { reply: 'nope' } })
  r = await runOrchestrationTurn({ wfEngine: f.api, workflowId: 'w', message: 'm' })
  assert.equal(r.reply, 'A', 'reply 键未命中不得直接出空（回落链继续）')
})

test('composeOrchestrationReply：非字符串取值（.text / JSON 化）与 unresolved 附注', () => {
  assert.equal(composeOrchestrationReply({ answer: { text: '文本' } }, [], {}), '文本', '对象带 .text 字符串取之')
  assert.equal(composeOrchestrationReply({ answer: { a: 1 } }, [], {}), JSON.stringify({ a: 1 }, null, 2), '其余对象 JSON 化（缩进 2 可读）')
  assert.equal(composeOrchestrationReply(null, [], {}), '', '空端出 → 空回复（不抛）')
  assert.equal(composeOrchestrationReply({ answer: 'X' }, ['k ← {{t}}'], {}), 'X\n\n（注：1 个返回值未取到值：k ← {{t}}）', 'unresolved 必须附注（取值失败可见）')
  assert.equal(composeOrchestrationReply({}, ['a', 'b'], {}), '（注：2 个返回值未取到值：a；b）', '空文本时附注不落空行')
})

test('缺失回退四因：engine_unavailable / load_error / not_found / not_orchestrable + 事件恰一次', async () => {
  const seen = []
  const emit = (type, payload) => seen.push({ type, payload })

  // ① engine_unavailable：null 或 缺 run 方法的残缺对象
  let r = await runOrchestrationTurn({ wfEngine: null, workflowId: 'x', message: 'm', emit })
  assert.deepEqual(r, { fallback: true, reason: 'engine_unavailable' })
  r = await runOrchestrationTurn({ wfEngine: { load: () => ({}) }, workflowId: 'x', message: 'm', emit })
  assert.deepEqual(r, { fallback: true, reason: 'engine_unavailable' }, '缺 run 的引擎不得被当作可用')

  // ② load 抛 → load_error（带原因文本）
  const fThrow = fakeEngine({ loadThrows: true })
  r = await runOrchestrationTurn({ wfEngine: fThrow.api, workflowId: 'x', message: 'm', emit })
  assert.equal(r.fallback, true)
  assert.match(r.reason, /^load_error: boom$/)

  // ③ 不存在（load 返回 null）
  const fNull = fakeEngine(); fNull.api.setWf(null)
  r = await runOrchestrationTurn({ wfEngine: fNull.api, workflowId: 'ghost', message: 'm', emit })
  assert.deepEqual(r, { fallback: true, reason: 'not_found' })

  // ④ 存在但无 orchestrate 段（presence 判据，D16）
  const fPlain = fakeEngine(); fPlain.api.setWf({ name: 'plain' })
  r = await runOrchestrationTurn({ wfEngine: fPlain.api, workflowId: 'plain', message: 'm', emit })
  assert.deepEqual(r, { fallback: true, reason: 'not_orchestrable' })

  // 回退时零运行 + 事件逐因一项（含载荷形状）
  for (const f of [fThrow, fNull, fPlain]) assert.equal(f.calls.run.length, 0, '回退不得发起运行')
  assert.equal(seen.length, 5, '每个回退恰发一次事件（① 两项 + ② ③ ④）')
  for (const s of seen) {
    assert.equal(s.type, 'orchestration_unavailable')
    assert.ok('workflowId' in s.payload && 'reason' in s.payload, '载荷须含 {workflowId, reason}')
  }

  // 正向对照：裸 `orchestrate:`（空对象）是合法声明 → 照跑、零回退事件
  const fEmpty = fakeEngine({ finalOutput: { answer: 'ok' } })
  fEmpty.api.setWf({ name: 'w', orchestrate: {} })
  r = await runOrchestrationTurn({ wfEngine: fEmpty.api, workflowId: 'w', message: 'm', emit })
  assert.equal(r.fallback, undefined, '空编排段是声明（presence 判据），不得回退')
  assert.equal(r.reply, 'ok')
  assert.equal(fEmpty.calls.run.length, 1)
  assert.equal(seen.length, 5, '成功/声明路径不得发 unavailable 事件')
})

test('wall_ms 硬停：到点 stop(本轮 runId) → status=cancelled、reply 为空；正常收尾后计时器撤销', async () => {
  // ① 显式 wallMs：到点 → stop(runId) → 本轮以 cancelled 收尾
  let stopped = null
  const f = fakeEngine({ onRun: (opts, api) => new Promise((resolve) => { api._resolve = resolve }) })
  f.api.stop = (runId) => {
    stopped = runId
    f.api._resolve({ ok: false, status: 'cancelled', steps: 1, finalOutput: { answer: '半成品' }, runId })
    return { ok: true }
  }
  let r = await runOrchestrationTurn({ wfEngine: f.api, workflowId: 'w', message: 'm', wallMs: 40, runId: 'r-wall' })
  assert.equal(stopped, 'r-wall', 'stop 必须打在本轮预置 runId 上（不是别的运行）')
  assert.equal(r.status, 'cancelled')
  assert.equal(r.reply, '', '取消轮不得合成"半成品"回复（D24：无假成功）')

  // ② 未显式传 wallMs 时读定义 limits.wall_ms
  let stopped2 = null
  const f2 = fakeEngine({ onRun: (opts, api) => new Promise((resolve) => { api._resolve2 = resolve }) })
  f2.api.setWf({ name: 'w', orchestrate: { limits: { wall_ms: 40 } } })
  f2.api.stop = (runId) => { stopped2 = runId; f2.api._resolve2({ ok: false, status: 'cancelled', steps: 0, runId }); return { ok: true } }
  r = await runOrchestrationTurn({ wfEngine: f2.api, workflowId: 'w', message: 'm', runId: 'r-lim' })
  assert.equal(stopped2, 'r-lim', 'limits.wall_ms 必须生效（缺省 30 分钟）')
  assert.equal(r.status, 'cancelled')

  // ③ 正常收尾后计时器必须撤销（否则到点 stop 会打到早已结束的运行上）
  const f3 = fakeEngine({ finalOutput: { answer: 'x' } })
  await runOrchestrationTurn({ wfEngine: f3.api, workflowId: 'w', message: 'm', wallMs: 40 })
  await new Promise((res) => setTimeout(res, 90))
  assert.equal(f3.calls.stop.length, 0, '运行已结束 ⇒ 计时器撤销，不得再 stop')
  assert.equal(DEFAULT_ORCHESTRATION_WALL_MS, 1800000, '缺省 30 分钟（D24）')
})

test('轮信号：随 run 透传（对象同一）；真引擎 pre-aborted ⇒ 轮首取消、零节点执行', async () => {
  const sig = { aborted: false }
  const f = fakeEngine({ finalOutput: { answer: 'x' } })
  await runOrchestrationTurn({ wfEngine: f.api, workflowId: 'w', message: 'm', signal: sig })
  assert.equal(f.calls.run[0].signal, sig, '轮信号必须以对象同一透传给 run（三源合并在引擎侧）')

  // 真引擎：pre-aborted ⇒ schedule 轮首检查点即 cancelled，steps 0、无任何 node 事件
  const root = mkdtempSync(join(tmpdir(), 'orch-eng-'))
  try {
    mkdirSync(join(root, 'wf', 'gr'), { recursive: true })
    writeFileSync(join(root, 'wf', 'gr', 'workflow.yml'), [
      'name: gr',
      'version: 1.0.0',
      'orchestrate: { display_name: 生成-审查 }',
      'nodes:',
      '  - { id: start, type: start }',
      '  - { id: t, type: template, template: "不应执行" }',
      '  - { id: done, type: end, config: { outputs: [{ name: answer, selector: "{{t}}" }] } }',
      'edges:',
      '  - { id: e1, source: start, target: t }',
      '  - { id: e2, source: t, target: done }',
    ].join('\n'), 'utf-8')
    const events = []
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const engine = createWorkflowEngine({ configDir: root, registry, getModel: () => 'mock-model' })
    engine.setDeps({ onEvent: (ev) => events.push(ev) })
    engine.addRoot(join(root, 'wf'))
    const r = await runOrchestrationTurn({ wfEngine: engine, workflowId: 'gr', message: '原样', signal: { aborted: true } })
    assert.equal(r.status, 'cancelled')
    assert.equal(r.steps, 0, 'pre-aborted 不得执行任何节点')
    assert.equal(r.reply, '', '取消轮 reply 为空')
    assert.equal(events.filter((e) => e.type === 'node').length, 0, '零节点事件（未进入执行面）')
    assert.ok(events.some((e) => e.type === 'end' && e.status === 'cancelled'), '取消经 end 事件如实落账')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── T5：引擎轮首接管（真 createEngine + 真 wfEngine；template 节点工作流，无模型可判）──

const ORCH_WF = `name: gr
version: 1.0.0
orchestrate: { display_name: 编排测试 }
inputs:
  - { name: message, type: string, required: true }
nodes:
  - { id: start, type: start }
  - { id: t, type: template, template: "编排产物：{{inputs.message}}" }
  - { id: done, type: end, config: { outputs: [{ name: answer, selector: "{{t}}" }] } }
edges:
  - { id: e1, source: start, target: t }
  - { id: e2, source: t, target: done }
`

/** deriveMessages 的 assistant 条目 content 是 blocks 数组（user 条目是字符串）——取可读文本 */
const contentText = (m) => {
  const c = m?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => b?.text ?? '').join('')
  return String(c ?? '')
}

function makeOrchEnv({ loopMode = 'custom:gr', wfYml = ORCH_WF, wfDirName = 'gr', onWfEvent = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-turn-'))
  const home = join(dir, 'home')
  const wfRoot = join(dir, 'wfs')
  mkdirSync(join(wfRoot, wfDirName), { recursive: true })
  writeFileSync(join(wfRoot, wfDirName, 'workflow.yml'), wfYml, 'utf-8')
  const registry = createToolRegistry({ cwd: dir, addDirs: [dir], skipPermissions: true })
  const wfEvents = []
  const wfEngine = createWorkflowEngine({
    configDir: home, registry, getModel: () => 'mock-model',
    onEvent: (ev) => { wfEvents.push(ev); if (onWfEvent) onWfEvent(ev) },
  })
  wfEngine.addRoot(wfRoot)
  const wireEvents = []
  const wire = makeWire({ write(s) { wireEvents.push(JSON.parse(s)) } })
  const store = createSessionStore({ configDir: home, cwd: dir, sessionId: 'main' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir: home, addDirs: [dir], skipPermissions: true, loopMode, workflow: wfEngine },
    wire, session: store,
  })
  return { dir, home, wfEngine, engine, store, wireEvents, wfEvents, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('★ 引擎·轮首接管：custom 绑定 ⇒ 工作流接管该轮（主循环零进入），回复落 transcript + assistant 事件', async () => {
  const env = makeOrchEnv()
  try {
    const message = '把  两空格保留 与换行✅'
    await env.engine.runTurn({ content: message })
    // 回复 = 工作流产物，且逐字包含用户消息（D22 注入面证据）
    const msgs = env.store.deriveMessages()
    const last = msgs[msgs.length - 1]
    assert.equal(last.role, 'assistant')
    assert.equal(contentText(last), `编排产物：${message}`)
    // assistant 事件恰一次、内容同物（既有轮输出路径，v1 一次性落定）
    const asst = env.wireEvents.filter((e) => e.type === 'assistant')
    assert.equal(asst.length, 1)
    assert.deepEqual(asst[0].message.content, [{ type: 'text', text: `编排产物：${message}` }])
    // turnStats：orchestration 字段 + 主循环零进入（usage/lastUsage 均 null——mock 主循环轮必非空）
    const stats = env.engine.getTurnStats()
    const t = stats[stats.length - 1]
    assert.deepEqual(t.loopMode, {
      selected: 'custom:gr', effective: 'custom', router: null, governance: null,
      orchestration: { runId: t.loopMode.orchestration.runId, status: 'completed', steps: 3 },
    }, '钉住态：路由/治理不介入（D25）；orchestration 如实登记')
    assert.equal(typeof t.loopMode.orchestration.runId, 'string')
    assert.equal(t.usage, null, '主循环零进入：mock 主循环轮必有 usage')
    assert.equal(t.lastUsage, null)
    // 工作流事件链：end completed，runId 与 turnStats 同源
    const end = env.wfEvents.find((e) => e.type === 'end')
    assert.equal(end.status, 'completed')
    assert.equal(end.runId, t.loopMode.orchestration.runId)
    // 模式语境推进照常（spec §4.3-3）：事件恰一次且 effective='custom'；但零指令注入
    const applied = env.wireEvents.filter((e) => e.type === 'system' && e.subtype === 'loop_mode_applied')
    assert.equal(applied.length, 1)
    assert.deepEqual({ selected: applied[0].selected, effective: applied[0].effective, from: applied[0].from },
      { selected: 'custom:gr', effective: 'custom', from: 'react' })
    assert.ok(!msgs.some((m) => m.role === 'user' && String(m.content ?? '').includes('【循环模式·')),
      'custom 无指令文本——编排轮不得注入任何模式指令')
  } finally { env.cleanup() }
})

test('★ 引擎·custom → react 热切：下一轮恢复主循环 + 指令重注入恰一次（语境重建）', async () => {
  const env = makeOrchEnv()
  try {
    await env.engine.runTurn({ content: '编排一' })
    const r = env.engine.setLoopMode('react')
    assert.deepEqual(r, { ok: true, value: 'react', selected: 'react', effective: 'react' })
    await env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    const t = env.engine.getTurnStats().at(-1)
    assert.equal(t.loopMode.effective, 'react')
    assert.ok(t.usage, '切回 react 后主循环恢复（mock 轮 usage 非空）')
    const dirsIn = () => env.store.deriveMessages().filter(
      (m) => m.role === 'user' && String(m.content ?? '').includes('【循环模式·REACT】'))
    assert.equal(dirsIn().length, 1, '离开编排语境 → REACT 指令恰注入一次')
    const applied = env.wireEvents.filter((e) => e.type === 'system' && e.subtype === 'loop_mode_applied')
    assert.equal(applied.at(-1).from, 'custom', '事件链如实记录从 custom 语境离开')
    await env.engine.runTurn({ content: '继续' })
    assert.equal(dirsIn().length, 1, '语境未再变化 ⇒ 不重复注入')
  } finally { env.cleanup() }
})

test('★ 引擎·缺失回退（D23）：不存在 id ⇒ 落回 react 语义继续 + orchestration_unavailable；选择保留', async () => {
  const env = makeOrchEnv({ loopMode: 'custom:ghost' })
  try {
    await env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    const t = env.engine.getTurnStats().at(-1)
    assert.equal(t.loopMode.selected, 'custom:ghost', '选择保留（不静默清档）')
    assert.equal(t.loopMode.effective, 'react', '该轮落回 react 语义')
    assert.deepEqual(t.loopMode.orchestration, { runId: null, status: 'unavailable', steps: 0 })
    assert.ok(t.usage, '回退轮主循环真的继续跑了（mock 轮 usage 非空）')
    const unav = () => env.wireEvents.filter((e) => e.type === 'system' && e.subtype === 'orchestration_unavailable')
    assert.equal(unav().length, 1)
    assert.deepEqual({ workflowId: unav()[0].workflowId, reason: unav()[0].reason }, { workflowId: 'ghost', reason: 'not_found' })
    // 下轮重试解析（选择未清）：每轮一次运行尝试、一次可读事件
    await env.engine.runTurn({ content: '继续' })
    assert.equal(unav().length, 2, '选择保留 ⇒ 下一轮重试解析并再次如实上报')
    assert.equal(env.engine.getTurnStats().at(-1).loopMode.effective, 'react')
  } finally { env.cleanup() }
})

test('★ 引擎·编排轮用户停止：会话取消联动 ⇒ run 收 cancelled，本轮以 AbortError 收尾（「已取消」路径）', async () => {
  let engineRef = null
  const env = makeOrchEnv({ onWfEvent: (ev) => { if (ev.type === 'start' && engineRef) engineRef.abort() } })
  engineRef = env.engine
  try {
    await assert.rejects(env.engine.runTurn({ content: '长任务' }),
      (e) => e?.name === 'AbortError', '取消轮必须上抛 AbortError（cli「已取消。」+ result 收尾路径）')
    const end = env.wfEvents.find((e) => e.type === 'end')
    assert.equal(end.status, 'cancelled', '运行经 end{status:cancelled} 如实落账（D24）')
    assert.equal(end.steps, 0)
    assert.equal(env.wfEvents.filter((e) => e.type === 'node').length, 0, '取消发生在轮首检查点 ⇒ 零节点执行')
    assert.equal(env.wireEvents.filter((e) => e.type === 'assistant').length, 0, '不产生假成功回复')
    assert.equal(env.engine.getTurnStats().length, 0, 'AbortError 上抛 ⇒ 不达轮尾 turnStats（与既有取消路径同）')
  } finally { env.cleanup() }
})

test('★ 引擎·wall 硬停（非用户取消）：如实收尾通知，不产假成功回复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-wall-'))
  try {
    const home = join(dir, 'home')
    const wireEvents = []
    const wire = makeWire({ write(s) { wireEvents.push(JSON.parse(s)) } })
    const store = createSessionStore({ configDir: home, cwd: dir, sessionId: 'main' })
    // 假 wfEngine：run 直接以 cancelled 收尾且 **不动** 会话信号（= wall_ms 硬停形状，非用户取消）
    const fakeWf = {
      load: () => ({ name: 'gr', orchestrate: {} }),
      run: async (o) => ({ ok: false, status: 'cancelled', steps: 2, runId: o.runId, finalOutput: { answer: '半成品' } }),
      stop: () => ({ ok: true }),
    }
    const engine = createEngine({
      opts: { model: 'mock-model', configDir: home, addDirs: [dir], skipPermissions: true, loopMode: 'custom:gr', workflow: fakeWf },
      wire, session: store,
    })
    await engine.runTurn({ content: '任务' })
    const t = engine.getTurnStats().at(-1)
    assert.equal(t.loopMode.orchestration.status, 'cancelled')
    assert.equal(t.usage, null, '不进入主循环（cancelled 轮亦零模型调用）')
    const last = store.deriveMessages().at(-1)
    assert.equal(last.role, 'assistant')
    assert.match(contentText(last), /^【系统】编排运行已达墙钟上限/)
    assert.ok(!contentText(last).includes('半成品'), '取消不得合成半成品回复（D24：无假成功）')
    const asst = wireEvents.filter((e) => e.type === 'assistant')
    assert.equal(asst.length, 1)
    assert.match(asst[0].message.content[0].text, /^【系统】编排运行已达墙钟上限/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
