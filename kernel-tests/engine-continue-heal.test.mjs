// 输出截断自愈（2026-09-12 四家对标：CC 8K 撞顶升档重试 / pi 可恢复截断重试）
// ---------------------------------------------------------------------------
// 背景：主对话输出预算下调（云端 16K）后，长文本回复会被 max_tokens 截断；旧行为
// 要求用户发「继续」——现改为内部升档续写（8K/16K/32K/64K 档位，最多升 2 档），
// 部分文本先落盘、续写拼接进同一回复，用户无感。64K 再截断才按普通收尾。
process.env.PONOS_MOCK_API = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { createCompactor } from '../kernel/compact.mjs'
import { estimateMessage, estimateHistory } from '../kernel/context.mjs'

function makeEnv({ outputTokens }) {
  process.env.PONOS_MOCK_TRUNCATE_CONT = '1'
  process.env.PONOS_MOCK_TRUNCATE_CONT_N = '0'
  process.env.PONOS_MAX_OUTPUT_TOKENS = String(outputTokens)
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const dir = mkdtempSync(join(tmpdir(), 'continue-heal-'))
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'heal-session' })
  const context = {
    window: 1_000_000,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    estimate: () => ({ total: 100 }), // 恒低于阈值 → maybeCompact 恒 none
    estimateMessage,
    estimateHistory,
  }
  const compactor = createCompactor({
    session, context, model: 'mock-model', maxTokens: outputTokens, wire,
    health: undefined, signal: undefined, env: process.env, sessionMemoryPath: null,
  })
  const engine = createEngine({
    opts: { model: 'mock-model', addDirs: [dir], skipPermissions: true, systemPrompt: '', context },
    wire, session, compactor,
  })
  return {
    events, engine, dir, session,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('16K 截断 → 升档 32K 续写，拼接进同一回复（用户无感）', async () => {
  const env = makeEnv({ outputTokens: 16384 })
  try {
    const result = await env.engine.runTurn({ content: '写长文' })
    assert.ok(String(result.text || '').includes('这是续写的后半段'), '续写文本应进入最终回复')
    const healEvts = env.events.filter((e) => e.subtype === 'output_continued')
    assert.equal(healEvts.length, 1, '恰好一次升档自愈')
    assert.equal(healEvts[0].budget, 32768, '16K → 下一档 32K')
    assert.equal(healEvts[0].attempt, 1)
    // 部分文本落盘为独立条目（不带 usage），续写为最终条目
    const msgs = env.session.deriveMessages()
    const truncated = msgs.find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('被截断的前半段'))
      || msgs.find((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && String(b.text).includes('被截断的前半段')))
    assert.ok(truncated, '部分文本应落盘为独立条目')
    const inject = msgs.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('【系统】你的上一条回复因输出上限被截断'))
    assert.ok(inject, '续写指令应注入会话')
    assert.equal(Number(process.env.PONOS_MOCK_TRUNCATE_CONT_N), 2, '共 2 次 API 调用（截断 + 续写）')
  } finally { env.cleanup() }
})

test('64K（顶档）再截断 → 不再自愈，按普通收尾（旧行为兜底）', async () => {
  const env = makeEnv({ outputTokens: 65536 })
  try {
    const result = await env.engine.runTurn({ content: '写长文' })
    assert.ok(String(result.text || '').includes('被截断的前半段'), '无档可升 → 部分文本按正常回复收尾')
    const healEvts = env.events.filter((e) => e.subtype === 'output_continued')
    assert.equal(healEvts.length, 0, '顶档截断不得触发升档自愈')
    assert.equal(Number(process.env.PONOS_MOCK_TRUNCATE_CONT_N), 1, '仅 1 次 API 调用')
  } finally { env.cleanup() }
})
