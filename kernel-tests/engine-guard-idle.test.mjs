// agent loop 守卫——流式空闲看门狗（挂起兜底）集成测试
// ---------------------------------------------------------------------------
// 场景：mock 模型输出开头后不再产生任何块（fetch 连接挂着、服务器不回数据——本地
// vLLM 偶发卡死形态）。引擎应在 STREAM_IDLE_MS 内检测"无新块"→ abort 内部信号 →
// 按挂起优雅收尾。测试把 STREAM_IDLE_MS 压到 400ms 加速。
// 注意：STREAM_IDLE_MS 在 engine 模块求值期冻结 → env 必须在 import 前设定。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_STREAM_IDLE_MS = '400'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-idle-'))
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-00000000000a' })
  return { dir, session, wire }
}

test('流式挂起：模型流中断 >400ms 无块 → 空闲看门狗中止并附说明收尾', async () => {
  const { dir, session, wire } = setup()
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const t0 = Date.now()
    const result = await engine.runTurn({ content: '[mock:stall]' })
    const elapsed = Date.now() - t0
    assert.ok(result.text.includes('无数据'), `应收挂起说明，实际: ${result.text.slice(0, 200)}`)
    assert.ok(result.text.includes('自动收尾'), '应提示已按挂起自动收尾')
    // 应在可接受窗口内返回（远小于 mock 兜底 1.5s：兜底时间点早已被 400ms 看门狗覆盖）
    assert.ok(elapsed < 1200, `应 ~400ms 被看门狗中止，实际耗时 ${elapsed}ms`)
    // 会话保留可续聊：发「继续」能正常起新一轮（本文件 mock 下走普通回显）
    const again = await engine.runTurn({ content: '继续' })
    assert.ok(typeof again.text === 'string' && again.text.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
