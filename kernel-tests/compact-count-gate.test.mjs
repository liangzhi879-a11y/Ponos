// T1 条数触发口（2026-09-12）
// ---------------------------------------------------------------------------
// 背景：压缩此前只有 token 比例一条判据。长会话若由大量小消息构成（工具结果碎片），
// 条数单调上涨而估算长期低于阈值——实测单会话 767 条派生消息 vs 阈值 120，全窗口
// 0 次压缩，请求面涨到 445KB→478KB，每轮 prefill 越来越慢。
// 本文件钉死四件事：① 条数过线即进入压缩链路；② **条数单独过线时只做零模型成本的
// 免费收缩**，绝不触发 480–600s 级的摘要请求（为"条数多"付一次完整请求是净亏）；
// ③ 0 = 关闭；④ 配置优先级 settings > env > 默认 120。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCompactor, resolveCompactSettings } from '../kernel/compact.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { estimateRequest, estimateMessage, estimateHistory } from '../kernel/context.mjs'

// —— ① 配置解析：settings > env > 默认 ——
test('resolveCompactSettings：maxMessages 默认 120，settings/env 可覆盖，0 = 关闭', () => {
  assert.equal(resolveCompactSettings({ window: 200_000, settings: {}, env: {} }).maxMessages, 120)
  assert.equal(resolveCompactSettings({ window: 200_000, settings: { compact: { maxMessages: 50 } }, env: {} }).maxMessages, 50)
  assert.equal(resolveCompactSettings({ window: 200_000, settings: { compact: { maxMessages: 0 } }, env: {} }).maxMessages, 0)
  assert.equal(
    resolveCompactSettings({ window: 200_000, settings: {}, env: { PONOS_COMPACT_MAX_MESSAGES: '7' } }).maxMessages,
    7,
  )
  assert.equal(
    resolveCompactSettings({ window: 200_000, settings: { compact: { maxMessages: 50 } }, env: { PONOS_COMPACT_MAX_MESSAGES: '7' } }).maxMessages,
    50,
    'settings 显式配置时压过 env',
  )
})

// —— ②/③/④ 判定行为 ——
// 夹具：多条极小的 user/assistant 消息 ⇒ 条数够多但 token 远低于 200K×0.8 阈值
function harness({ maxMessages = 5, turns = 10 } = {}) {
  const wire = { system: () => {}, summary: () => {} }
  const dir = mkdtempSync(join(tmpdir(), 'ponos-count-gate-'))
  const store = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'count-gate' })
  for (let i = 0; i < turns; i++) {
    store.appendUser(`第 ${i} 轮：小动作`)
    store.appendAssistant([{ type: 'text', text: `收到 ${i}` }])
  }
  const context = {
    window: 200_000,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    maxMessages,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage,
    estimateHistory,
  }
  const compactor = createCompactor({
    session: store, context, model: 'mock-model', maxTokens: 8192, wire,
    health: undefined, signal: undefined, env: process.env, sessionMemoryPath: null,
  })
  return { store, compactor, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('maybeCompact：条数过线但 token 远低于阈值 → 免费收缩收口，不得调模型摘要', async () => {
  const h = harness({ maxMessages: 5, turns: 10 })
  try {
    const msgs = h.store.deriveMessages()
    assert.ok(msgs.length > 5, `夹具应产生 >5 条派生消息（实际 ${msgs.length}）`)
    const r = await h.compactor.maybeCompact({ system: 'sys', messages: msgs, outputBudget: 64_000 })
    assert.equal(r.action, 'none', `条数单独过线不得进入摘要（实际 action=${r.action}）`)
    assert.ok(
      ['count-shrink-only', 'count-over-no-shrink'].includes(r.reason),
      `reason 应标明是条数触发（实际 ${r.reason}）`,
    )
    assert.equal(r.msgs, msgs.length)
    assert.equal(r.usage, undefined, '未调模型 ⇒ 不得有 usage')
  } finally { h.cleanup() }
})

test('maybeCompact：maxMessages=0（关闭）→ 判定回到 below-threshold', async () => {
  const h = harness({ maxMessages: 0, turns: 10 })
  try {
    const msgs = h.store.deriveMessages()
    const r = await h.compactor.maybeCompact({ system: 'sys', messages: msgs, outputBudget: 64_000 })
    assert.equal(r.reason, 'below-threshold')
  } finally { h.cleanup() }
})

test('maybeCompact：阈值远大于条数 → 不误伤（below-threshold）', async () => {
  const h = harness({ maxMessages: 10_000, turns: 10 })
  try {
    const msgs = h.store.deriveMessages()
    const r = await h.compactor.maybeCompact({ system: 'sys', messages: msgs, outputBudget: 64_000 })
    assert.equal(r.reason, 'below-threshold')
  } finally { h.cleanup() }
})
