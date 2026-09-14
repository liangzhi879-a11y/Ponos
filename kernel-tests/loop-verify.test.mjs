// 双层验证器：命令式（经 Bash 工具门）+ LLM 判词兜底；短路省预算。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyDoneWhen } from '../kernel/loop-verify.mjs'

function fakeTools(map) {
  const calls = []
  return {
    calls,
    async run({ name, input }) {
      calls.push({ name, input })
      const r = map[input.command]
      if (r === undefined) return { content: 'not found', isError: true }
      return { content: r.content ?? 'ok', isError: r.exit !== 0 }
    },
  }
}

test('命令式全过 → passed（且不调模型）', async () => {
  let judgeCalls = 0
  const tools = fakeTools({ 'pytest x': { exit: 0 }, 'ruff check .': { exit: 0 } })
  const r = await verifyDoneWhen([{ type: 'cmd', run: 'pytest x' }, { type: 'cmd', run: 'ruff check .' }], {
    tools, judge: async () => { judgeCalls++; return { done: true, reason: '' } },
  })
  assert.equal(r.passed, true)
  assert.equal(r.results.length, 2)
  assert.ok(r.results.every((x) => x.ok))
  assert.equal(judgeCalls, 0, '命令层已全过，无需判词')
})

test('命令式失败 → passed false 且短路（不再执行后续命令、不调模型）', async () => {
  let judgeCalls = 0
  const tools = fakeTools({ 'pytest x': { exit: 1, content: '1 failed' }, 'ruff check .': { exit: 0 } })
  const r = await verifyDoneWhen([{ type: 'cmd', run: 'pytest x' }, { type: 'cmd', run: 'ruff check .' }], {
    tools, judge: async () => { judgeCalls++; return { done: true, reason: '' } },
  })
  assert.equal(r.passed, false)
  assert.equal(r.results.length, 1, '首条失败即短路')
  assert.equal(tools.calls.length, 1)
  assert.equal(judgeCalls, 0)
  assert.match(r.reason, /pytest x/)
})

test('命令经 Bash 工具门执行（断言工具名 Bash，不绕审批自建 spawn）', async () => {
  const tools = fakeTools({ 'echo hi': { exit: 0 } })
  await verifyDoneWhen([{ type: 'cmd', run: 'echo hi' }], { tools, judge: async () => ({ done: false }) })
  assert.equal(tools.calls[0].name, 'Bash', '必须经 Bash 工具（受审批/黑名单/审计）')
  assert.equal(tools.calls[0].input.command, 'echo hi')
})

test('命令层全过后判词层失败 → passed false', async () => {
  const tools = fakeTools({ 'pytest x': { exit: 0 } })
  const r = await verifyDoneWhen(
    [{ type: 'cmd', run: 'pytest x' }, { type: 'judge', text: '文档已写完' }],
    { tools, judge: async () => ({ done: false, reason: '还缺第 3 章' }) },
  )
  assert.equal(r.passed, false)
  assert.equal(r.results.at(-1).type, 'judge')
  assert.equal(r.results.at(-1).ok, false)
})

test('仅判词条件（无命令）→ 只调模型', async () => {
  const tools = fakeTools({})
  const r = await verifyDoneWhen([{ type: 'judge', text: '目标达成' }], { tools, judge: async () => ({ done: true, reason: '已满足' }) })
  assert.equal(r.passed, true)
  assert.equal(tools.calls.length, 0)
})

test('doneWhen 为空 → passed null（调用方回落 --until/--goal 判定）', async () => {
  const r = await verifyDoneWhen([], { tools: fakeTools({}), judge: async () => ({ done: true }) })
  assert.equal(r.passed, null)
  assert.deepEqual(r.results, [])
})

test('工具抛异常 → 该条不通过且不影响其它判定（静默降级）', async () => {
  const tools = { calls: [], async run() { throw new Error('boom') } }
  const r = await verifyDoneWhen([{ type: 'cmd', run: 'x' }], { tools, judge: async () => ({ done: true }) })
  assert.equal(r.passed, false)
  assert.equal(r.results[0].ok, false)
  assert.match(String(r.results[0].reason), /boom/)
})

test('judge 抛异常 → 视为未通过（不误判为达成）', async () => {
  const r = await verifyDoneWhen([{ type: 'judge', text: 'x' }], {
    tools: fakeTools({}), judge: async () => { throw new Error('judge down') },
  })
  assert.equal(r.passed, false)
  assert.match(String(r.results[0].reason), /judge down/)
})

test('expect 非 0 → fail-closed（Bash 工具仅暴露 0/非 0，不支持自定义退出码）', async () => {
  // 命令实际成功（exit 0），但条件要求 expect=1 —— 无法判定，不得当通过
  const tools = fakeTools({ 'grep -q x file': { exit: 0 } })
  const r = await verifyDoneWhen([{ type: 'cmd', run: 'grep -q x file', expect: 1 }], {
    tools, judge: async () => ({ done: true }),
  })
  assert.equal(r.passed, false)
  assert.equal(r.results[0].ok, false)
  assert.match(String(r.reason), /不支持自定义退出码/)
})
