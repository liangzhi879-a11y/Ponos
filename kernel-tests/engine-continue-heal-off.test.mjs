// PONOS_CONTINUE_HEAL_MAX=0 → 关闭输出截断自愈（旧行为：截断即收尾）。
// 必须独立成文件：CONTINUE_HEAL_MAX 是引擎模块级常量，须在 engine.mjs 求值前设 env。
// 内核辅助模块（compact.mjs）静态导入 engine.mjs 会提前触发模块求值——本文件
// 所有内核导入一律动态化（env 赋值之后），静态导入仅保留 node 内置。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_CONTINUE_HEAL_MAX = '0'
const [{ createEngine }, { createSessionStore }, { createCompactor }, { estimateMessage, estimateHistory }] = await Promise.all([
  import('../kernel/engine.mjs'),
  import('../kernel/session.mjs'),
  import('../kernel/compact.mjs'),
  import('../kernel/context.mjs'),
])
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('PONOS_CONTINUE_HEAL_MAX=0 → 截断即收尾（不续写、无事件）', async () => {
  process.env.PONOS_MOCK_TRUNCATE_CONT = '1'
  process.env.PONOS_MOCK_TRUNCATE_CONT_N = '0'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '16384'
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const dir = mkdtempSync(join(tmpdir(), 'continue-heal-off-'))
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'heal-off-session' })
  const context = {
    window: 1_000_000, thresholdRatio: 0.8, retainRatio: 0.16,
    estimate: () => ({ total: 100 }), estimateMessage, estimateHistory,
  }
  const compactor = createCompactor({
    session, context, model: 'mock-model', maxTokens: 16384, wire,
    health: undefined, signal: undefined, env: process.env, sessionMemoryPath: null,
  })
  const engine = createEngine({
    opts: { model: 'mock-model', addDirs: [dir], skipPermissions: true, systemPrompt: '', context },
    wire, session, compactor,
  })
  try {
    const result = await engine.runTurn({ content: '写长文' })
    assert.ok(String(result.text || '').includes('被截断的前半段'), '部分文本按正常回复收尾')
    assert.equal(events.filter((e) => e.subtype === 'output_continued').length, 0, '关闭后无升档事件')
    assert.equal(Number(process.env.PONOS_MOCK_TRUNCATE_CONT_N), 1, '仅 1 次 API 调用（不续写）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
