// P3 度量看板：CLI 接线（runReadonly 路由 + 与归因同源 + 无数据如实 null）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runReadonly } from '../kernel/readonly.mjs'

const NOW = Date.parse('2026-10-27T12:00:00.000Z')

function seed({ withFix = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ponos-metrics-'))
  mkdirSync(join(home, 'journal'), { recursive: true })
  mkdirSync(join(home, 'evolution'), { recursive: true })
  const detail = "命令超时（120000ms）：'bash -lc git status'"
  // detect 行要带 probeId：修复行（act）不带 fp，归因层靠 probeId → fp 的唯一映射来归属
  const lines = [JSON.stringify({ at: '2026-10-20T10:00:00.000Z', kind: 'detect', ok: false, detail, probeId: 'shell-timeout' })]
  if (withFix) {
    // 修复行（act/rollback 不带 fp，靠 probeId 归属）；再现行在 48h 内 ⇒ immediate
    lines.push(JSON.stringify({ at: '2026-10-20T11:00:00.000Z', kind: 'act', ok: true, actionId: 'shell-timeout', probeId: 'shell-timeout', detail: '已重启桥' }))
    lines.push(JSON.stringify({ at: '2026-10-21T10:00:00.000Z', kind: 'detect', ok: false, detail, probeId: 'shell-timeout' }))
  }
  writeFileSync(join(home, 'journal', '2026-10-20.ndjson'), lines.join('\n') + '\n')
  writeFileSync(join(home, 'evolution', 'candidates.jsonl'), [
    JSON.stringify({ id: 'c1', state: 'seen' }),
    JSON.stringify({ id: 'c2', state: 'dismissed' }),
  ].join('\n') + '\n')
  return home
}

test('runReadonly(evolution-metrics)：与归因同源，复发率/打扰率可算', () => {
  const home = seed()
  const { output, code } = runReadonly({ mode: 'evolution-metrics', args: { window: '30d' }, configDir: home, now: NOW })
  assert.equal(code, 0)
  assert.equal(output.v, 1)
  assert.equal(output.faults.fixed, 1, '有一条被修过的指纹')
  assert.equal(output.faults.recurring, 1)
  assert.equal(output.faults.recurringRate, 1)
  assert.equal(output.faults.immediate, 1, '48h 内再现 ⇒ immediate')
  assert.equal(output.interruption.surfaced, 2)
  assert.equal(output.interruption.rate, 0.5)
  assert.equal(output.interruption.verdict, 'watch', '恰好 50% 未超红线')
})

test('runReadonly(evolution-metrics)：空数据 ⇒ 比率一律 null（不谎报 0%）', () => {
  const home = seed({ withFix: false })
  const { output } = runReadonly({ mode: 'evolution-metrics', args: {}, configDir: home, now: NOW })
  assert.equal(output.faults.recurringRate, null)
  assert.equal(output.fixes.effectiveRate, null)
})
