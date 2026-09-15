// 审批档位 × 引擎闸门（kernel/engine.mjs gateToolUse）
// ---------------------------------------------------------------------------
// 纯判定表已由 permissions-modes.test.mjs 覆盖；本文件钉"接线"层面的事实：
//   ① 档位真的决定是否发 can_use_tool（不是只改了判定函数）；
//   ② 硬黑名单在 bypass 档仍然挂起，且带 hard 标记；
//   ③ 硬黑名单的拒绝不污染度降级计数（连拒 3 次后普通 ask 仍要问）；
//   ④ 被 --disallowedTools 禁用的工具不弹窗（走注册表自己的错误）。
// mock 形态见 api.mjs：[mock:write]/[mock:tool-safe]/[mock:tool]/[mock:tool-catastrophic]
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { createToolRegistry } from '../kernel/tools.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

const MOCK_ENVS = ['PONOS_MOCK_WRITE_DIR']
function clearMock() { for (const k of MOCK_ENVS) delete process.env[k] }
// 夹具目录统一在套件结束时清理：用例需要断言"文件真的落盘"，不能在 runAndClean 里提前删
const TMP_DIRS = []
after(() => { for (const d of TMP_DIRS.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

// 夹具：mock API + 空系统提示；approve 决定"用户是否放行"（默认全部放行）。
// approve 也可传函数 (request) => boolean：区分工具（如"只拒灾难命令、放行自愈探针"）。
function setup({ mode, approve = true, disallowedTools } = {}) {
  const events = []
  const dir = mkdtempSync(join(tmpdir(), 'gate-mode-'))
  // [mock:write] 的落盘目录（不设则写 process.cwd()，会被路径边界拒绝 → 假失败）
  process.env.PONOS_MOCK_WRITE_DIR = dir
  const configDir = join(dir, 'home')
  const session = createSessionStore({ configDir, cwd: dir, sessionId: '00000000-0000-0000-0000-0000000000bb' })
  let engine
  const wire = makeWire({
    write(s) {
      const e = JSON.parse(s)
      events.push(e)
      // 审批请求：真实 GUI 的"本次放行/拒绝"按钮；同步注册 waiter 已完成，故延到下一个宏任务
      if (e.type === 'control_request' && e.request?.subtype === 'can_use_tool') {
        const id = e.request.tool_use_id
        const ok = typeof approve === 'function' ? approve(e.request) : approve
        setImmediate(() => engine.resolveApproval(id, ok ? { behavior: 'allow' } : { behavior: 'deny' }))
      }
    },
  })
  const context = { window: 200000, thresholdRatio: 0.8, retainRatio: 0.16, estimate: () => 1000, estimateMessage: () => 10, estimateHistory: () => 10 }
  engine = createEngine({
    opts: { model: 'm', configDir, addDirs: [dir], approvalMode: mode, disallowedTools, systemPrompt: '', context },
    wire, session, compactor: null,
  })
  return { dir, events, session, engine }
}
const askEvents = (events) => events.filter((e) => e.type === 'control_request' && e.request?.subtype === 'can_use_tool')
const toolNamesAsked = (events) => askEvents(events).map((e) => e.request.tool_name)

async function runAndClean(setupArg, content) {
  clearMock()
  const { dir, events, session, engine } = setup(setupArg)
  TMP_DIRS.push(dir)
  const result = await engine.runTurn({ content })
  return { dir, events, session, result, text: String(result?.text || '') }
}

test('manual：写文件与普通命令都挂起审批', async () => {
  const { events } = await runAndClean({ mode: 'manual' }, '[mock:write]')
  assert.ok(toolNamesAsked(events).includes('Write'), `manual 档写文件应弹窗，实际：${JSON.stringify(toolNamesAsked(events))}`)
  const safe = await runAndClean({ mode: 'manual' }, '[mock:tool-safe]')
  assert.ok(toolNamesAsked(safe.events).includes('Bash'), 'manual 档普通命令应弹窗')
})

test('auto：写文件挂起、普通命令不挂起', async () => {
  const w = await runAndClean({ mode: 'auto' }, '[mock:write]')
  assert.ok(toolNamesAsked(w.events).includes('Write'), 'auto 档写文件应弹窗')
  const b = await runAndClean({ mode: 'auto' }, '[mock:tool-safe]')
  assert.equal(askEvents(b.events).length, 0, 'auto 档普通命令不应弹窗')
  assert.match(b.text, /mock-safe/, '命令应真实执行（不弹窗 ≠ 不执行）')
})

test('loose（默认档）：写文件与普通命令都不挂起，且真的落盘', async () => {
  const { dir, events } = await runAndClean({ mode: 'loose' }, '[mock:write]')
  assert.equal(askEvents(events).length, 0, 'loose 档写文件不应弹窗')
  assert.ok(existsSync(join(dir, 'mock-a.txt')) && existsSync(join(dir, 'mock-b.txt')), '两个写入都应真实执行')
})

test('loose：高危命令仍挂起（= 今天的真实行为，回归护栏）', async () => {
  const { events } = await runAndClean({ mode: 'loose' }, '[mock:tool]')
  assert.ok(toolNamesAsked(events).includes('Bash'), 'loose 档高危命令应弹窗')
})

test('bypass：高危命令不挂起', async () => {
  const { events } = await runAndClean({ mode: 'bypass' }, '[mock:tool]')
  assert.equal(askEvents(events).length, 0, 'bypass 档高危命令不应弹窗')
})

test('硬黑名单：四档都挂起，且带 hard 标记（bypass 也不例外）', async () => {
  // 注意：一律 deny——灾难命令在测试里绝不能被放行（approve:true 会真的执行 rm -rf /）
  for (const mode of ['manual', 'auto', 'loose', 'bypass']) {
    const { events } = await runAndClean({ mode, approve: false }, '[mock:tool-catastrophic]')
    const asks = askEvents(events)
    assert.ok(asks.length >= 1, `${mode} 档 rm -rf / 应挂起，实际 ${asks.length}`)
    // 只看灾难命令那几条：同轮还会有引擎自愈探针的普通 Bash（echo guard-recovered），
    // 它是真的普通 ask，不该带 hard。
    const catastrophic = asks.filter((a) => /rm\s+-rf\s+\//.test(String(a.request?.input?.command || '')))
    assert.ok(catastrophic.length >= 1, `${mode} 档应挂起灾难命令，实际 asks：${JSON.stringify(asks.map((a) => [a.request.tool_name, a.request.input?.command]))}`)
    for (const a of catastrophic) {
      assert.equal(a.request.hard, true, `${mode} 档 rm -rf / 应带 hard 标记`)
      assert.match(String(a.request.decision_reason || ''), /硬黑名单/, '原因应指明硬黑名单')
      assert.equal(a.request.mode, mode, '载荷应回带发起询问时的档位')
    }
    for (const a of asks.filter((x) => !catastrophic.includes(x))) {
      assert.notEqual(a.request.hard, true, '普通命令不应带 hard 标记')
    }
  }
})

test('硬黑名单：拒绝不计入降级计数（连拒 3 次后普通 ask 仍要问）', async () => {
  clearMock()
  // 每轮灾难命令都可能重发（mock 每轮都吐同一 tool_use），故断言"每轮都至少挂起一次"而不是
  // 总数——被降级计数污染时，第 2 轮起会静默拒绝（0 次挂起）。
  // 只拒灾难命令、放行其余：引擎在拒绝后会自愈探针一次普通 Bash（echo guard-recovered），
  // 那是**真实**的普通 ask，用户拒绝它理会计数（本用例要隔离的是"hard 到底计不计"，
  // 若一律拒绝则 streak 由探针合法累到 3，测的就不是黑名单了）。
  const CATASTROPHIC = /rm\s+-rf\s+\//
  const { dir, events, engine } = setup({
    mode: 'manual',
    approve: (req) => !CATASTROPHIC.test(String(req?.input?.command || '')),
  })
  try {
    const perTurn = []
    for (let i = 0; i < 3; i++) {
      const before = askEvents(events).length
      await engine.runTurn({ content: '[mock:tool-catastrophic]' })
      perTurn.push(askEvents(events).length - before)
    }
    assert.ok(perTurn.every((n) => n >= 1), `每轮灾难命令都应挂起（降级计数不得污染硬黑名单），实际 ${JSON.stringify(perTurn)}`)
    const before = askEvents(events).length
    const safe = await engine.runTurn({ content: '[mock:tool-safe]' })
    assert.equal(askEvents(events).length, before + 1, '普通命令的 ask 不得被硬黑名单的拒绝连累降级')
    assert.doesNotMatch(String(safe?.text || ''), /连续拒绝/, '不应出现降级文案')
  } finally {
    clearMock()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--disallowedTools：禁用工具不弹窗（走注册表自身的错误）', async () => {
  const { events, session } = await runAndClean({ mode: 'manual', disallowedTools: ['Write'], approve: false }, '[mock:write]')
  assert.ok(!toolNamesAsked(events).includes('Write'), `被禁工具不应弹审批窗，实际：${JSON.stringify(toolNamesAsked(events))}`)
  // 注册表自身的禁用错误回填给模型（不是"用户拒绝"）
  const results = session.deriveMessages()
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((c) => c.type === 'tool_result').map((c) => String(c.content)))
  assert.ok(results.some((t) => t.includes('工具已被禁用：Write')), `应回禁用错误，实际：${JSON.stringify(results.slice(0, 3))}`)
  // 说明：manual 档下引擎自愈用的 guard 探针（Bash echo）仍会弹窗——它是真实的 Bash
  // 执行，弹窗是正确的（与模型主动调用同待遇）。
})

test('档位热切换：setApprovalMode 立即生效于下一轮', async () => {
  clearMock()
  const { dir, events, engine } = setup({ mode: 'manual' })
  try {
    assert.equal(engine.getApprovalMode(), 'manual')
    await engine.runTurn({ content: '[mock:tool-safe]' })
    assert.equal(askEvents(events).length, 1, 'manual 下应先弹窗')
    engine.setApprovalMode('bypass')
    assert.equal(engine.getApprovalMode(), 'bypass')
    await engine.runTurn({ content: '[mock:tool-safe]' })
    assert.equal(askEvents(events).length, 1, '切到 bypass 后不应再弹窗')
    // 非法值回落默认档，且不放大权限
    assert.equal(engine.setApprovalMode('plan'), 'loose')
  } finally {
    clearMock()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未传档位：按旧 flag 派生（approvalMode 缺省 = loose）', async () => {
  clearMock()
  const dir = mkdtempSync(join(tmpdir(), 'gate-mode-'))
  const configDir = join(dir, 'home')
  // 同 setup()：不设则 [mock:write] 写 process.cwd()，被路径边界拒绝 → 假失败
  process.env.PONOS_MOCK_WRITE_DIR = dir
  const session = createSessionStore({ configDir, cwd: dir, sessionId: '00000000-0000-0000-0000-0000000000cc' })
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const context = { window: 200000, thresholdRatio: 0.8, retainRatio: 0.16, estimate: () => 1000, estimateMessage: () => 10, estimateHistory: () => 10 }
  const engine = createEngine({ opts: { model: 'm', configDir, addDirs: [dir], systemPrompt: '', context }, wire, session, compactor: null })
  try {
    assert.equal(engine.getApprovalMode(), 'loose', '缺省应派生 loose（非 manual）')
    const r = await engine.runTurn({ content: '[mock:write]' })
    assert.equal(askEvents(events).length, 0, '缺省档下写文件不弹窗（与今天一致）')
    assert.ok(existsSync(join(dir, 'mock-a.txt')), '写文件应真实执行')
    assert.ok(String(r?.text || '').length >= 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
