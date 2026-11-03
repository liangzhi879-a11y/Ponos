// U1 纯函数（kernel/readonly.mjs）：fixture transcript → aggregateUsage/costOf 数值 + schema。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeSegment } from '../kernel/session.mjs'
import { runUsage, runAudit } from '../kernel/readonly.mjs'

const USAGE1 = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 }
function entry(type, { content, usage, model, role, seq } = {}) {
  const e = { type, seq, timestamp: '2026-09-08T10:00:00.000Z' }
  if (type === 'assistant') e.message = { role: 'assistant', content: content ?? [], usage, model: model || 'mock-model' }
  else e.message = { role: role || 'user', content }
  return e
}

test('runUsage：fixture 数值（totals/byModel/byTool/cacheRate/costUsd/budgetUsd）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    const sid = 'sess-1'
    const lines = [
      { type: 'meta', schemaVersion: 1 },
      entry('assistant', { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage: USAGE1 }),
      entry('user', { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }),
      entry('assistant', { content: [], usage: { input_tokens: 500, output_tokens: 100 }, model: 'other-model' }),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n'
    writeFileSync(join(projDir, `${sid}.jsonl`), lines)
    const out = runUsage({ configDir: join(dir, 'home') })
    assert.equal(out.totals.input_tokens, 1500)
    assert.equal(out.totals.output_tokens, 600)
    assert.equal(out.totals.turns, 2)
    assert.equal(out.byModel['mock-model'].input_tokens, 1000)
    assert.equal(out.byTool.Bash, 1)
    // cacheRate = cacheReadSum/(inputSum+cacheReadSum)，inputSum 跨全部 assistant usage 条目
    // （1000+500），cacheReadSum=200；runUsage 输出四舍五入到 4 位（0.1176）。
    assert.equal(out.cacheRate, Number((200 / (1000 + 500 + 200)).toFixed(4)))
    assert.ok(out.costUsd > 0)
    assert.equal(out.budgetUsd, 0)
    assert.equal(out.overBudget, false)
    assert.equal(out.byProject[Object.keys(out.byProject)[0]].turns, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ★ T0.4（2026-10-20 口径统一）：混模型会话的 byModelCostUsd 必须**各按各自单价**算。
// 旧实现取一组 env 价套给所有模型 ⇒ 下面两个模型的明细必然相等（本断言必红）。
// 价差取 10 倍以上（deepseek-v4-pro 的 builtin 输入价是 flash 的数倍）以保证判据不靠小数抖动。
test('★ T0.4：混模型会话按各自单价计费，明细不得被同一组 env 价抹平', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    const one = (model) => JSON.stringify({
      type: 'assistant', seq: 1, timestamp: '2026-09-08T10:00:00.000Z',
      message: { role: 'assistant', content: [], usage: { input_tokens: 1_000_000, output_tokens: 0 }, model },
    })
    // 两个**价表内**模型各 1M input（deepseek-chat 0.27 / gpt-4o-mini 0.15，
    // 见 kernel/model-prices.mjs 的 BUILTIN_PRICES）。刻意不用 deepseek-v4-flash/pro：
    // 它们**不在价表里**（见下方 test-plan 风险 R-T0.4），会双走 estimate 兜底 0.2 ⇒ 断言无区分力。
    writeFileSync(join(projDir, 's-mix.jsonl'), one('deepseek-chat') + '\n' + one('gpt-4o-mini') + '\n')
    const out = runUsage({ configDir: join(dir, 'home') })
    const a = out.byModelCostUsd['deepseek-chat']
    const b = out.byModelCostUsd['gpt-4o-mini']
    assert.ok(a > 0 && b > 0, `两个模型都应有成本，实际 ${a} / ${b}`)
    assert.notEqual(a, b, '★ 混模型明细不得相等（相等 = 又被同一组价抹平）')
    assert.equal(Number((a + b).toFixed(4)), out.costUsd, 'costUsd 必须 = 各模型明细之和')
    // 价源可追溯（UI 据此标注"估算"还是"价表"）
    assert.equal(out.priceSources['deepseek-chat'], 'builtin')
    assert.equal(out.priceSources['gpt-4o-mini'], 'builtin')
    // env 显式价只对**未知模型**生效（口径修正的边界，写死防回退）
    process.env.PONOS_PRICE_PER_M_INPUT = '7'
    try {
      const out2 = runUsage({ configDir: join(dir, 'home') })
      assert.equal(out2.byModelCostUsd['deepseek-chat'], a, '已知模型不受 env 价影响（走 builtin）')
      assert.equal(out2.priceSources['deepseek-chat'], 'builtin')
    } finally { delete process.env.PONOS_PRICE_PER_M_INPUT }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ★ T0.5b（2026-10-20）：provider 配置的价必须进聚合层（否则配了也白配——价表不含本仓主力模型），
// 且缺价必须可见（estimate ≠ 事实）。两条都写成可红断言。
test('★ T0.5b：provider 价的 ①②层生效，缺价可见（estimate 不得被当成真实成本）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    const mk = (model) => JSON.stringify({
      type: 'assistant', seq: 1, timestamp: '2026-09-08T10:00:00.000Z',
      message: { role: 'assistant', content: [], usage: { input_tokens: 1_000_000, output_tokens: 0 }, model },
    })
    // ① 无配置、价表未覆盖（deepseek-v4-flash 不在 BUILTIN_PRICES）⇒ estimate + 告警
    writeFileSync(join(projDir, 's-a.jsonl'), mk('deepseek-v4-flash') + '\n')
    const before = runUsage({ configDir: join(dir, 'home') })
    assert.equal(before.priceSources['deepseek-v4-flash'], 'estimate', '未配置时必须如实标 estimate')
    assert.ok(before.priceWarnings.some((w) => w.model === 'deepseek-v4-flash'), '★ 缺价必须可见（不得静默）')
    // ② 注入 provider 价（与 bridge 同一 env 契约）⇒ 按配置算，不再告警
    process.env.PONOS_MODEL_PRICES = JSON.stringify({ 'deepseek-v4-flash': { input: 0.5, output: 2 } })
    try {
      const after = runUsage({ configDir: join(dir, 'home') })
      assert.equal(after.priceSources['deepseek-v4-flash'], 'provider', '★ 配了 provider 价必须生效')
      assert.equal(after.byModelCostUsd['deepseek-v4-flash'], 0.5, '1M input × 配置价 0.5 = 0.5（不是 estimate 的 0.2）')
      assert.equal(after.priceWarnings.length, 0, '价源齐全时不得有告警')
    } finally { delete process.env.PONOS_MODEL_PRICES }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runUsage：scope/sessionId/from/to 过滤', () => {  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    const mk = (sid, day, inp) => JSON.stringify({ type: 'assistant', seq: 1, timestamp: `${day}T00:00:00.000Z`, message: { role: 'assistant', content: [], usage: { input_tokens: inp, output_tokens: 1 }, model: 'm' } })
    writeFileSync(join(projDir, 's-a.jsonl'), mk('s-a', '2026-09-01', 100) + '\n' + mk('s-a', '2026-09-05', 100) + '\n')
    writeFileSync(join(projDir, 's-b.jsonl'), mk('s-b', '2026-09-08', 50) + '\n')
    const base = join(dir, 'home')
    assert.equal(runUsage({ configDir: base, scope: 'session' }).totals.input_tokens, 250)
    assert.equal(runUsage({ configDir: base }).bySession === undefined, true)
    // bySession 仅在 scope='session' 时输出（默认 all 无 bySession，见上断言）
    const sess = runUsage({ configDir: base, sessionId: 's-b', scope: 'session' })
    assert.equal(sess.totals.input_tokens, 50)
    assert.ok(sess.bySession)
    assert.equal(sess.bySession['s-b'].input_tokens, 50)
    assert.equal(runUsage({ configDir: base, from: '2026-09-06', to: '2026-09-09' }).totals.input_tokens, 50)
    assert.equal(runUsage({ configDir: base, project: sanitizeSegment(cwd), to: '2026-09-02' }).totals.input_tokens, 100)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runUsage：lane transcript（sessionId=taskId + subtask_meta）同样收录，totals = 主 + lane 两笔之和', () => {
  // T0.2 口径守卫：子 Agent 的 lane 转录与主会话同 configDir、文件名 sessionId=taskId
  // ⇒ 一旦 lane 条目带上 usage（engine.mjs runSubAgentLoop 的 settleLaneUsage），
  // `/api/usage` 的 totals 就自动含子 Agent 成本，无需额外接线。本用例钉住"收录 + 求和"
  // 这一口径；"engine 真的把 usage 落进 lane 转录"的可红断言在
  // kernel-tests/lane-usage.test.mjs（落 usage 前必红）。
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const cwd = join(dir, 'proj-a')
    const projDir = join(dir, 'home', 'projects', sanitizeSegment(cwd))
    mkdirSync(projDir, { recursive: true })
    const line = (o) => JSON.stringify(o) + '\n'
    // 主会话：1 条带 usage 的 assistant
    writeFileSync(join(projDir, 'main-session.jsonl'), line({ type: 'meta', schemaVersion: 1 })
      + line(entry('assistant', { content: [], usage: { input_tokens: 100, output_tokens: 10 }, model: 'm' })))
    // 子 Agent lane：sessionId=taskId（UUID 形态），首行 subtask_meta 标血缘；末条 assistant 带 lane 累计
    writeFileSync(join(projDir, '00000000-0000-0000-0000-0000000000aa.jsonl'), line({ type: 'meta', kind: 'transcript', schemaVersion: 1 })
      + line({ type: 'meta', kind: 'subtask_meta', seq: 1, parentTaskId: null, depth: 0, path: ['00000000-0000-0000-0000-0000000000aa'] })
      + line(entry('assistant', { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], seq: 2 }))
      + line(entry('assistant', { content: [], usage: { input_tokens: 300, output_tokens: 30 }, seq: 3 })))
    const out = runUsage({ configDir: join(dir, 'home') })
    assert.equal(out.totals.input_tokens, 400, 'totals 应为主笔 100 + lane 笔 300')
    assert.equal(out.totals.output_tokens, 40, 'totals 应为主笔 10 + lane 笔 30')
    assert.equal(out.totals.turns, 2, '只有带 usage 的 assistant 计入 turns（lane 中间条目不计）')
    assert.equal(runUsage({ configDir: join(dir, 'home'), scope: 'session', sessionId: '00000000-0000-0000-0000-0000000000aa' }).totals.input_tokens, 300,
      'lane 会话可按 taskId 单独归集')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runAudit：rows 含 tool_use/tool_result、params 截断 200、from/to 过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
  try {
    const projDir = join(dir, 'home', 'projects', 'p')
    mkdirSync(projDir, { recursive: true })
    const big = JSON.stringify({ command: 'x'.repeat(500) })
    const lines = [
      { type: 'assistant', seq: 2, timestamp: '2026-09-08T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'x'.repeat(500) } }] } },
      { type: 'user', seq: 3, timestamp: '2026-09-08T00:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n'
    writeFileSync(join(projDir, 's.jsonl'), lines)
    const rows = runAudit({ configDir: join(dir, 'home'), sessionId: 's' })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].type, 'tool_use')
    assert.equal(rows[0].tool, 'Bash')
    assert.equal(rows[0].session, 's')
    assert.ok(rows[0].params.length <= 200 + 1, 'params 应截断到 ~200')
    assert.equal(rows[1].type, 'tool_result')
    assert.equal(rows[1].toolUseId, 'tu-1')
    assert.equal(runAudit({ configDir: join(dir, 'home'), from: '2026-09-09' }).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
