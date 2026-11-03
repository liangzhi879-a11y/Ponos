// 引擎主循环思考落盘：thinking 必须在**该迭代的 assistant 条目之前**落盘。
// 为什么钉顺序而不是只钉"有落盘"：回放按磁盘行序还原展示顺序，思考若排在该迭代内容
// 之后，回放里"思考"就出现在它本该解释的那段输出下面——正是本次要修的失真形态。
// 夹具与 kernel-tests/api-tools-unsupported.test.mjs 一致（makeWire + createEngine）。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_MOCK_THINKING = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

test('主循环：思考条目落盘，且排在该迭代 assistant 条目之前', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'yfw-thinkpersist-'))
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'think-main' })
  try {
    const engine = createEngine({
      opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
      wire, session,
    })
    await engine.runTurn({ content: '你好' })

    const lines = readFileSync(session.file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const thinkIdx = lines.findIndex((e) => e.type === 'thinking')
    const asstIdx = lines.findIndex((e) => e.type === 'assistant')
    assert.ok(thinkIdx >= 0, `应落盘 thinking 条目，实际行型：${lines.map((e) => e.type).join(',')}`)
    assert.ok(asstIdx >= 0, '应落盘 assistant 条目')
    assert.ok(thinkIdx < asstIdx, `思考必须排在该迭代 assistant 之前：think@${thinkIdx} asst@${asstIdx}`)
    // 累积成一条（两段 thinking 合成一份条目），不是每 delta 一条
    assert.equal(lines.filter((e) => e.type === 'thinking').length, 1, '同迭代的多段思考应合并为一条')
    assert.equal(lines[thinkIdx].message.content[0].thinking, '思考甲思考乙')
    // 纯文本轮回放策略（2026-10-22）：thinking 只并入**带 tool_use 的 assistant 轮**，
    // 本用例的收尾 assistant 无工具 ⇒ 仍不得进模型输入（白涨 prompt）。
    assert.ok(!JSON.stringify(session.deriveMessages()).includes('思考甲'), '纯文本轮不得回放思考')
    // wire 直发保持不变：思考既要**落盘**（本次新增），也要**实时逐段上屏**（既有能力，
    // 不得因新增落盘而被掐掉）。逐段透传与落盘的"合并成一条"是两回事——落盘为回放，
    // 透传为实时视图；此处同时钉住，避免将来重构只保留落盘而静默丢掉实时思考。
    const wireThink = events.filter(
      (e) => e.type === 'assistant' && e.message?.content?.some((b) => b.type === 'thinking'),
    )
    assert.equal(wireThink.length, 2, '两段思考应逐段实时透传')
    assert.deepEqual(
      wireThink.map((e) => e.message.content[0].thinking),
      ['思考甲', '思考乙'],
      'wire 透传的文本必须逐段原样',
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
