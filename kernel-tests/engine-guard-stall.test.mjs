// 守卫⑥ 无进展停滞（2026-09-10 循环未拦截事故；同月改自愈优先）
// ---------------------------------------------------------------------------
// 背景：实测"测量打转"循环——模型每轮用微变参数做 Browser js 只读测量 + 注释
// 文本，文本近重复（③b，措辞每轮不同）与同工具键窗口（⑤，表达式每轮不同）都
// 抓不到；轮次墙钟默认关闭（2026-09-10 取消 30 分钟上限）后无任何守卫能停。
// 守卫⑥：迭代边界检查"距上次实质进展的时长"（默认 600s）——进展 = 成功且非
// 只读测量的工具结果（Write/Edit/Read/goto 等）；Browser js/snapshot 与失败
// 结果不刷新。**自愈优先**：命中先注入推进指令续跑（用户无感知），恢复实质
// 进展即清零愈合计数；耗尽 STALL_HEAL_MAX 仍无进展才落可见收尾（硬停是最后
// 防线，非默认路径）。本文件用 mock [mock:loop-measure]（注释文本 + 微变
// Browser js）驱动循环：① 纯循环 → 两次自愈注入后收尾；② 自愈后恢复实质
// 工作（Bash）→ 无收尾、正常完成（用户无感知）。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_STALL_MS = '2000'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-stall-'))
  const events = []
  let engineRef = null
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
    // Browser js 工具执行 → 立即回 ok 快照（测量成功但非进展信号）
    bridgeRequest: (r) => {
      setTimeout(() => {
        try {
          engineRef?.resolveBrowser(r.requestId, {
            ok: true,
            snapshot: { page: { url: 'http://mock/', title: 'mock-page' }, interactives: [], info: [] },
          })
        } catch { /* 引擎已收尾时静默 */ }
      }, 0)
    },
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'stall-session' })
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
    wire, session,
  })
  engineRef = engine
  return { engine, events, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('纯测量循环 → 两次自愈注入（guard_heal）后收尾（硬停是最后防线）', async () => {
  process.env.PONOS_MOCK_MEASURE_N = '0'
  const env = makeEnv()
  try {
    const t0 = Date.now()
    const result = await env.engine.runTurn({ content: '[mock:loop-measure]' })
    const elapsed = Date.now() - t0
    assert.ok(result.text.includes('无实质进展'), `应收停滞守卫文案，实际: ${result.text.slice(0, 200)}`)
    assert.ok(result.text.includes('自动收尾'), '应提示已自动收尾')
    const heals = env.events.filter((e) => e.subtype === 'guard_heal' && e.reason === 'loop-stall')
    assert.equal(heals.length, 2, '应先注入 2 次推进指令（STALL_HEAL_MAX=2）')
    assert.equal(heals[0].attempt, 1)
    assert.equal(heals[1].attempt, 2)
    assert.ok(elapsed >= 5900, `3 个观察窗（2s×3）+ 迭代 ≈ ≥5.9s（实际 ${elapsed}ms）`)
    assert.ok(elapsed < 20000, `不得无限循环（实际 ${elapsed}ms）`)
    // 会话保留可续聊（优雅收尾不丢任务）
    const again = await env.engine.runTurn({ content: '继续' })
    assert.ok(typeof again.text === 'string' && again.text.length > 0)
  } finally { env.cleanup() }
})

test('自愈恢复：注入推进指令后模型改做实质工作 → 无收尾、正常完成（用户无感知）', async () => {
  process.env.PONOS_MOCK_MEASURE_N = '0'
  process.env.PONOS_MOCK_STALL_HEAL = '1'
  process.env.PONOS_MOCK_STALL_HEAL_CONSUMED = '0'
  const env = makeEnv()
  try {
    const t0 = Date.now()
    const result = await env.engine.runTurn({ content: '[mock:loop-measure]' })
    const elapsed = Date.now() - t0
    // mock：收到"推进指令"后改产成功 Bash（实质进展）→ 守卫愈合计数清零 → 正常收尾
    assert.ok(!result.text.includes('无实质进展'), `自愈成功不得停摆，实际: ${result.text.slice(0, 200)}`)
    assert.ok(result.text.includes('[mock:stall-healed-done]'), '应走恢复完成正常收尾')
    const heals = env.events.filter((e) => e.subtype === 'guard_heal' && e.reason === 'loop-stall')
    assert.ok(heals.length >= 1, '应至少注入 1 次推进指令（内部消化）')
    assert.ok(elapsed < 20000, `应快速恢复（实际 ${elapsed}ms）`)
  } finally { env.cleanup() }
})
