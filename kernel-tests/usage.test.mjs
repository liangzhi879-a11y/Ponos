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

test('runUsage：scope/sessionId/from/to 过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-usage-'))
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
