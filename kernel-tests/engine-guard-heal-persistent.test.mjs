// 持久自愈（2026-09-11）：模型异常愈合默认无限预算（-1）——不再因"愈合次数耗尽"
// 落可见收尾；安全网 = 守卫⑥ 无进展停滞（纯循环无工具进展，10 分钟接管）。
// ---------------------------------------------------------------------------
// 本文件验证熔断（④）持久愈合链：连续全败 → 无限次注入排查指令（meltdown 愈合
// 计数永不耗尽）→ 失败结果不刷新⑥进展 → 停滞守卫（压到 2s 加速）自愈 2 次后
// 落最终收尾。断言：error-meltdown 愈合事件 ≥2（持久）、最终文案为停滞收尾
// （⑥安全网）而非熔断收尾。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_STALL_MS = '2000'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

test('熔断持久愈合：无限次排查注入，最终由守卫⑥（无进展停滞）兜底收尾', async () => {
  process.env.PONOS_MOCK_LOOP = 'fail'
  const dir = mkdtempSync(join(tmpdir(), 'guard-heal-persist-'))
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'persist-session' })
  try {
    const engine = createEngine({
      opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
      wire, session,
    })
    const t0 = Date.now()
    const result = await engine.runTurn({ content: '[mock:loop]' })
    const elapsed = Date.now() - t0
    // 熔断愈合持续注入（预算 -1 永不耗尽），不停在"全部失败"可见收尾
    assert.ok(!result.text.includes('全部失败'), `熔断不应落可见收尾，实际: ${result.text.slice(0, 200)}`)
    const meltdownHeals = events.filter((e) => e.subtype === 'guard_heal' && e.reason === 'error-meltdown')
    assert.ok(meltdownHeals.length >= 2, `持久愈合应多次注入排查指令（实际 ${meltdownHeals.length} 次）`)
    // 安全网：失败不刷新进展 → 停滞守卫接管收尾
    assert.ok(result.text.includes('无实质进展'), `应由守卫⑥兜底收尾，实际: ${result.text.slice(0, 200)}`)
    const stallHeals = events.filter((e) => e.subtype === 'guard_heal' && e.reason === 'loop-stall')
    assert.equal(stallHeals.length, 2, '停滞守卫先自愈 2 次（STALL_HEAL_MAX=2 有限预算=安全网）')
    assert.ok(elapsed >= 5900, `3 个停滞观察窗（2s×3）（实际 ${elapsed}ms）`)
    assert.ok(elapsed < 30000, `不得无限运行（实际 ${elapsed}ms）`)
  } finally {
    delete process.env.PONOS_MOCK_LOOP
    rmSync(dir, { recursive: true, force: true })
  }
})
