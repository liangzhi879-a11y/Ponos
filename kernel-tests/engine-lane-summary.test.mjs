// 子 lane 摘要只累 text（审计 #8）：thinking 不再混入任务通知/登记的摘要文本。
// 子 lane 流产出 thinking（子任务内部推理）与 text（正式回答）双块——摘要/通知只应
// 含 text 内容；thinking 仍参与 ③ 生成重复检测窗（genWindow），但不进 textBuf。
// 镜像 engine-lane-trunc.test.mjs harness（makeEnv/marker 结构以实测 mock 为准）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-lane-summary-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  return { events, engine, store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('子 lane：任务通知摘要含 text 不含 thinking', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-think]' })
    // 主线程返回文本只含正式回答
    assert.ok(String(r.text).includes('正式回答：应出现在摘要的文本Y'), `主线程文本应含 text，实际：${String(r.text).slice(-300)}`)
    assert.ok(!String(r.text).includes('不应出现在摘要的思考X'), '主线程文本不应含 thinking 内容')
    // 任务通知的摘要同样不含 thinking
    const notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification')
    assert.ok(notif, '应有 task_notification')
    const notifText = JSON.stringify(notif)
    assert.ok(!notifText.includes('不应出现在摘要的思考X'), `任务通知不应含 thinking，实际：${notifText.slice(-300)}`)
  } finally { env.cleanup() }
})
