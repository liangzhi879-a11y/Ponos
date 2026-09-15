// agent loop 守卫——流式空闲看门狗（挂起兜底）+ 无感愈合（2026-09-10）集成测试
// ---------------------------------------------------------------------------
// 场景：mock 模型输出开头后不再产生任何块（fetch 连接挂着、服务器不回数据——本地
// vLLM 偶发卡死形态）。引擎应在 STREAM_IDLE_MS 内检测"无新块"→ abort 内部信号。
// 2026-09-10 无感愈合：已产出后停顿不再直接可见收尾——保留已产出内容、注入续写
// 指令静默续跑（guard_heal: idle-interrupted），耗尽 IDLE_HEAL_MAX 才可见收尾。
// 测试把 STREAM_IDLE_MS 压到 400ms 加速。
// 注意：STREAM_IDLE_MS 在 engine 模块求值期冻结 → env 必须在 import 前设定。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_STREAM_IDLE_MS = '400'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-idle-'))
  const events = []
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {},
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-00000000000a' })
  return { dir, session, wire, events }
}

test('流式挂起（已产出后停顿）→ 无感愈合：保留已产出内容 + 续写注入 → 正常收尾（无可见挂起说明）', async () => {
  const { dir, session, wire, events } = setup()
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const t0 = Date.now()
    const result = await engine.runTurn({ content: '[mock:stall]' })
    const elapsed = Date.now() - t0
    // 愈合后 mock 走普通回显正常收尾：不得出现可见挂起说明
    assert.ok(!result.text.includes('自动收尾'), `无感愈合不应落可见收尾，实际: ${result.text.slice(0, 200)}`)
    assert.ok(result.text.includes('mock:'), `愈合后应正常收尾（回显），实际: ${result.text.slice(0, 200)}`)
    const heals = events.filter((e) => e.subtype === 'guard_heal' && e.reason === 'idle-interrupted')
    assert.equal(heals.length, 1, '应注入 1 次续写指令')
    // 已产出内容保留进 transcript（断点续写的上下文基础）
    const transcript = readFileSync(session.file, 'utf-8')
    assert.ok(transcript.includes('停顿测试开始'), '已产出部分应落 transcript')
    assert.ok(transcript.includes('检测到你的回复在中途停顿'), '续写注入应落 transcript')
    // 应在可接受窗口内返回（~400ms 看门狗 + 愈合注入 + 回显收尾）
    assert.ok(elapsed < 1500, `应 ~400ms 中止 + 愈合续跑，实际耗时 ${elapsed}ms`)
    // 会话保留可续聊：发「继续」能正常起新一轮（本文件 mock 下走普通回显）
    const again = await engine.runTurn({ content: '继续' })
    assert.ok(typeof again.text === 'string' && again.text.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
