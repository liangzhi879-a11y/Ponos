// T0.2（治理计划 2026-10-20-token-context-governance）子 Agent 用量落进 lane transcript。
//
// 问题（问0）：子 lane 的 usage 此前只进 taskNotification（GUI 任务卡）与内存，
// **不进 lane transcript** ⇒ `/api/usage`、`stats.mjs aggregateUsage`、
// `trace-project.projectRecords`（kind='subagent'）里子 Agent 成本恒为 0。
// 改法（engine.mjs runSubAgentLoop）：subPersistAssistant 记末条条目 → 收尾（guardStop /
// 最终 return）经 settleLaneUsage 一次性把**累计** usage 后挂到末条 assistant 上。
//
// 本文件钉住四条（前三条为"可红"断言，落 usage 前必红）：
//   ① 单次收尾只落一次，且数值 = lane 累计（不重复计）
//   ② ★ 多迭代 lane 的**中间** assistant 条目不得带 usage（否则聚合求和重复计）
//   ③ ★ guardStop 分支（此处命中"达到迭代上限"）同样落 usage
//   ④ ★ 聚合口径：runUsage totals = 主 transcript + lane transcript 之和
//
// env 冻结须先于 engine 求值（镜像 engine-lane-heal 的动态 import 布局）：
// PONOS_LOOP_MAX_ITERATIONS 是模块级常量，只能靠 import 前的 env 设定（③ 需要可命中的
// 迭代上限；② 的 [mock:lane-iter] 需 6 轮 ⇒ 上限取 8，两者不互相抢答）。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_MAX_ITERATIONS = '8'

const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore, sanitizeSegment } = await import('../kernel/session.mjs')
const { makeWire } = await import('../kernel/protocol.mjs')
const { runUsage } = await import('../kernel/readonly.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// mock 每次请求上报的 usage（kernel/api.mjs MOCK_USAGE）——期望值按"请求数 × 本常量"算
const IN = 10
const OUT = 20

function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-lane-usage-'))
  const configDir = join(dir, 'home')
  // cwd 必须是**已存在的绝对目录**：lane 里的 Bash 工具以它为 spawn cwd（相对/不存在
  // ⇒ 工具结果恒 is_error ⇒ R3-2 续跑注入把用例带成"失败循环"，断言全失真）
  const cwd = join(dir, 'proj')
  mkdirSync(cwd, { recursive: true })
  const store = createSessionStore({ configDir, cwd, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [cwd], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  // lane transcript 路径（createSessionStore 规则：projects/<sanitizeSegment(cwd)>/<taskId>.jsonl）
  const laneFile = (taskId) => join(configDir, 'projects', sanitizeSegment(cwd), `${taskId}.jsonl`)
  const startedId = () => events.find((e) => e.type === 'system' && e.subtype === 'task_started')?.task_id
  const notifOf = (taskId) => events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
  return { events, engine, store, dir, configDir, laneFile, startedId, notifOf, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

const readEntries = (file) => readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
const assistantsOf = (file) => readEntries(file).filter((e) => e.type === 'assistant')
const withUsage = (entries) => entries.filter((e) => e.message?.usage !== undefined)

test('① lane 收尾把累计 usage 落在末条 assistant 上，且只落一次（不重复计）', async () => {
  const env = makeEnv()
  try {
    // [mock:tool-safe]：第 1 次请求产 Bash 工具轮、第 2 次（tool_result 回显）产文本收尾
    // ⇒ lane 正常收尾（非 guardStop），共 2 次请求、1 条 assistant（工具轮）。
    await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:tool-safe] 执行确认' }, {})
    const taskId = env.startedId()
    assert.ok(taskId, '应有 task_started（子 lane 已起）')
    assert.equal(env.notifOf(taskId)?.status, 'completed', '本用例走正常收尾（非守卫停）')
    const assistants = assistantsOf(env.laneFile(taskId))
    assert.equal(assistants.length, 1, '工具轮 + 文本收尾应只落 1 条 assistant')
    const u = assistants[0].message.usage
    assert.ok(u, '★ 末条 assistant 必须带 usage（落 usage 前必红：lane 成本恒为 0）')
    assert.equal(u.input_tokens, 2 * IN, 'lane 累计 input 应为 2 次请求之和')
    assert.equal(u.output_tokens, 2 * OUT, 'lane 累计 output 应为 2 次请求之和')
    assert.equal(withUsage(assistants).length, 1, 'usage 只能落一条（多条 = 聚合时重复计）')
  } finally { env.cleanup() }
})

test('★ ② 多迭代 lane：中间 assistant 条目不得带 usage（否则求和重复）', async () => {
  const env = makeEnv()
  try {
    process.env.PONOS_MOCK_LANE_ITER_N = '0' // [mock:lane-iter] 的按轮次计数器（进程级）
    // [mock:lane-iter]：前 5 轮产出工具调用（第 6 轮纯文本收尾）⇒ 5 条 assistant，
    // 累计 usage 须只挂最后一条。上限 8 ⇒ 不撞迭代上限（本用例走正常收尾）。
    await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-iter] 执行确认' }, {})
    const taskId = env.startedId()
    assert.equal(env.notifOf(taskId)?.status, 'completed', '本用例走正常收尾（非守卫停）')
    const assistants = assistantsOf(env.laneFile(taskId))
    assert.equal(assistants.length, 5, `应有 5 条工具轮 assistant，实际 ${assistants.length}`)
    const tails = withUsage(assistants)
    assert.equal(tails.length, 1, '★ 只有末条可带 usage（中间条目带 = 聚合求和重复计）')
    assert.equal(tails[0].seq, assistants[assistants.length - 1].seq, '带 usage 的必须是末条 assistant')
    for (const e of assistants.slice(0, -1)) {
      assert.equal(e.message.usage, undefined, `seq=${e.seq} 是中间条目，不得带 usage`)
    }
    const u = assistants[assistants.length - 1].message.usage
    assert.equal(u.input_tokens, 6 * IN, '末条 usage = 6 次请求累计 input')
    assert.equal(u.output_tokens, 6 * OUT, '末条 usage = 6 次请求累计 output')
  } finally {
    delete process.env.PONOS_MOCK_LANE_ITER_N
    env.cleanup()
  }
})

test('③ guardStop 分支（命中迭代上限）同样落 usage，且中间条目不**带** usage', async () => {
  const env = makeEnv()
  try {
    // PONOS_MOCK_LOOP=ok：每次请求都产出 Bash 工具轮（无视历史）⇒ 8 轮后命中
    // guardStop('达到迭代上限')。env 在 mockStream 内逐请求读取，故运行期设定即可。
    process.env.PONOS_MOCK_LOOP = 'ok'
    try {
      await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '子任务：循环执行确认' }, {})
    } finally { delete process.env.PONOS_MOCK_LOOP }
    const taskId = env.startedId()
    const notif = env.notifOf(taskId)
    assert.equal(notif?.status, 'stopped', '守卫停应登记为 stopped（可 resume）')
    assert.ok(String(notif?.summary || '').includes('达到迭代上限'), `收尾说明应来自 guardStop，实际：${String(notif?.summary).slice(0, 120)}`)
    const assistants = assistantsOf(env.laneFile(taskId))
    assert.equal(assistants.length, 8, `迭代上限 8 ⇒ 8 条工具轮 assistant，实际 ${assistants.length}`)
    const tails = withUsage(assistants)
    assert.equal(tails.length, 1, '★ guardStop 出口只落一次 usage')
    assert.equal(tails[0].seq, assistants[assistants.length - 1].seq, '★ guardStop 分支的 usage 必须落末条')
    assert.equal(tails[0].message.usage.input_tokens, 8 * IN, 'guardStop 分支 usage = 8 次请求累计')
    for (const e of assistants.slice(0, -1)) {
      assert.equal(e.message.usage, undefined, `seq=${e.seq} 是中间条目，不得带 usage`)
    }
  } finally { env.cleanup() }
})

test('★ ④ 聚合口径：runUsage totals = 主 transcript + lane transcript 两笔之和', async () => {
  const env = makeEnv()
  try {
    await env.engine.runTurn({ content: '你好' }) // 主笔：1 次请求
    await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:tool-safe] 执行确认' }, {}) // lane 笔：2 次请求
    const out = runUsage({ configDir: env.configDir })
    // 落 usage 前 lane 笔缺席 ⇒ totals 只有主笔（10/20）⇒ 本断言必红
    assert.equal(out.totals.input_tokens, 3 * IN, `totals.input 应含 lane，实际 ${out.totals.input_tokens}`)
    assert.equal(out.totals.output_tokens, 3 * OUT, `totals.output 应含 lane，实际 ${out.totals.output_tokens}`)
    assert.equal(out.totals.turns, 2, '有 usage 的 assistant 条目应为 2 条（主 1 + lane 1）')
    // 分账核对：lane 会话（sessionId=taskId）在 bySession 口径下也可见
    const sess = runUsage({ configDir: env.configDir, scope: 'session', sessionId: env.startedId() })
    assert.equal(sess.totals.input_tokens, 2 * IN, 'lane 会话用量应可单独归集')
  } finally { env.cleanup() }
})

// ★ ⑤ 纯文本收尾的 lane（不发工具、直接回答）——只读研究型子代理（explorer/researcher）
// 的常态路径。这类 lane 原来**不落任何 assistant 条目**（用例① 的 `assistants.length === 1`
// 已钉住"文本收尾不落条目"这一既有行为）⇒ usage 无处可挂 ⇒ 成本恒为 0。
// 若"落 usage"漏了它们，等于最常见的子代理类型完全没治理（本用例即为该缺口的守卫）。
test('★ ⑤ 纯文本 lane（无工具迭代）也必须落 assistant 条目并带 usage', async () => {
  const env = makeEnv()
  try {
    // 不含任何 mock 标记 ⇒ mockStream 走默认分支：纯文本 + 一次 usage
    await env.engine.spawnSubAgent({ subagent_type: 'explorer', prompt: '子任务：只做只读勘察并给出结论' }, {})
    const taskId = env.startedId()
    assert.ok(taskId, '应有 task_started（子 lane 已起）')
    assert.equal(env.notifOf(taskId)?.status, 'completed', '纯文本收尾属正常完成')
    const assistants = assistantsOf(env.laneFile(taskId))
    assert.equal(assistants.length, 1, '★ 纯文本 lane 必须有 1 条 assistant（否则 usage 无处挂）')
    const u = assistants[0].message.usage
    assert.ok(u, '★ 该条必须带 usage（不落即成本恒 0）')
    assert.equal(u.input_tokens, IN, '纯文本 lane 只 1 次请求')
    assert.equal(u.output_tokens, OUT)
    // 内容也要在（否则 resume 时模型看不到自己的上次回答）
    assert.match(JSON.stringify(assistants[0].message.content), /子任务|勘察|结论|完成|你好/, '落盘条目应含最终回答文本')
    // 聚合层：主笔 + lane 笔
    await env.engine.runTurn({ content: '你好' })
    const out = runUsage({ configDir: env.configDir })
    assert.equal(out.totals.input_tokens, 2 * IN, `totals.input 应含纯文本 lane，实际 ${out.totals.input_tokens}`)
  } finally { env.cleanup() }
})
