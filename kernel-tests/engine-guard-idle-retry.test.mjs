// agent loop 守卫——上游零数据挂起的自动重试（2026-09-09 长任务挂起修复）
// ---------------------------------------------------------------------------
// 背景：自建/共享服务（本地 vLLM Qwen）的 prefill 时长随上下文线性增长，排队时
// 首内容前"零数据"可持续数分钟——旧看门狗 120s 一刀切判死且不重试，长任务必中。
// 修复：① 首内容前用更宽窗口（PONOS_STREAM_FIRST_BYTE_MS）；② 零数据挂起触发
// 自动重试（PONOS_IDLE_DEAD_RETRIES，默认 2，小幅退避），重试耗尽才按挂起收尾。
// 本文件验证重试路径：mock 每次都被看门狗 abort（不产出任何块），引擎应重试满
// 上限后优雅收尾（上游空转提示），会话保留可续聊。
// 注意：PONOS_* 阈值在 engine 模块求值期冻结 → env 必须在 import 前设定。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_STREAM_IDLE_MS = '400'
process.env.PONOS_STREAM_FIRST_BYTE_MS = '400'
process.env.PONOS_IDLE_DEAD_RETRIES = '2'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'

test('[mock:stall0] 零数据挂起 → 自动重试满上限后优雅收尾（上游空转提示，会话可续聊）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-idle-retry-'))
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-0000000000f' })
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire, session })
    const t0 = Date.now()
    const result = await engine.runTurn({ content: '[mock:stall0]' })
    const elapsed = Date.now() - t0
    // 重试 2 次 ×（400ms 看门狗 + 3s 退避）+ 末次 400ms ≈ 7.2s；mock 1.5s 自断兜底不干扰
    //（看门狗 400ms 先 abort）。断言"确实重试过"（≥6s）且最终仍按上游空转收尾。
    assert.ok(elapsed >= 6000, `应经历 2 次退避重试（≥6s），实际耗时 ${elapsed}ms`)
    assert.ok(result.text.includes('未收到任何数据'), `应收上游空转提示，实际: ${result.text.slice(0, 200)}`)
    assert.ok(result.text.includes('自动收尾'), '应提示已按挂起自动收尾')
    // 会话保留可续聊（同其它守卫：优雅收尾不丢任务）
    const again = await engine.runTurn({ content: '继续' })
    assert.ok(typeof again.text === 'string' && again.text.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
