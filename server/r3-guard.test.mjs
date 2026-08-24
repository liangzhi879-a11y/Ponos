// R3-2 守卫机制测试：失败自愈（工具错误→认错即停→强制重试）+ 计划尾拦截
// ---------------------------------------------------------------------------
// 场景：
//   1. [mock:guard-err] 首轮回失败 tool_use（Bash exit 1 → is_error），mock 回显轮
//      模拟"认错即停"（无工具）→ 守卫注入"【系统】失败/被取消" → mock 恢复轮
//      产出成功 tool_use（echo guard-recovered）→ 断言最终文本含 guard-recovered。
//   2. [mock:guard-tail] 首轮回纯文本"我先看一下结构，接下来开始处理"（计划尾，
//      无工具）→ 守卫注入"【系统】承诺了后续动作" → mock 恢复轮成功 → 断言。
// 依赖：api.mjs 的守卫恢复分支（历史含守卫注入 → echo guard-recovered）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'r3-guard-'))
  const events = []
  const wire = {
    assistant: (blocks) => events.push({ type: 'assistant', blocks }),
    result: (usage, extra) => events.push({ type: 'result', usage, extra }),
    controlRequest: () => {},
    system: () => {},
    summary: () => {},
    health: () => {},
    warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-00000000000a' })
  return { dir, events, session, wire }
}

test('失败自愈：工具错误后模型认错即停 → 守卫强制重试 → 恢复执行', async () => {
  const { dir, session, wire } = setup()
  try {
    process.env.PONOS_MOCK_API = '1'
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const result = await engine.runTurn({ content: '[mock:guard-err]' })
    // 最终文本必须含恢复成功的工具结果（守卫注入后 mock 补发了正确调用）
    assert.ok(result.text.includes('guard-recovered'), `最终文本应含恢复结果，实际: ${result.text.slice(0, 200)}`)
    // 会话里必须存在守卫注入的 user 消息（"失败/被取消"）
    const msgs = session.deriveMessages()
    const guardInjected = msgs.some(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('失败/被取消的工具调用')
    )
    assert.ok(guardInjected, '会话应含守卫注入消息（失败自愈）')
    delete process.env.PONOS_MOCK_API
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('计划尾拦截：模型纯文本承诺后结束回合 → 守卫注入 → 落实执行', async () => {
  const { dir, session, wire } = setup()
  try {
    process.env.PONOS_MOCK_API = '1'
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const result = await engine.runTurn({ content: '[mock:guard-tail]' })
    assert.ok(result.text.includes('guard-recovered'), `最终文本应含恢复结果，实际: ${result.text.slice(0, 200)}`)
    const msgs = session.deriveMessages()
    const guardInjected = msgs.some(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('承诺了后续动作')
    )
    assert.ok(guardInjected, '会话应含守卫注入消息（计划尾拦截）')
    delete process.env.PONOS_MOCK_API
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
