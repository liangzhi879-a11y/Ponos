// 子 lane 思考落盘：lane transcript 也须含 thinking 条目，且排在该迭代 assistant 条目之前
// （用户裁定"主 + 子都落"，spec §1）。为什么钉顺序而不是只钉"有落盘"：回放按磁盘行序还原
// 展示顺序，思考若排在该迭代内容之后，"思考"就出现在它本该解释的那段输出下面——与主循环
// kernel-tests/engine-thinking-persist.test.mjs 同一失真形态，子 lane 侧必须同口径。
//
// 夹具同 kernel-tests/agent-orchestration.test.mjs 的 lane 用例（mock API + configDir/cwd
// 同指临时目录 + 登记表取 laneStore.file）。PONOS_MOCK_THINKING_TOOL=1 让子 lane 首个请求
// 产出一个工具轮：子 lane 的 assistant 落盘点全在工具迭代，没有工具轮就没有 assistant 条目，
// "思考先于该迭代 assistant"便无从断言（见 kernel/api.mjs 该门注释）。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_MOCK_THINKING = '1'
process.env.PONOS_MOCK_THINKING_TOOL = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await sleep(20)
  }
  return null
}

test('子 lane：思考条目落盘且在该迭代 assistant 之前', async () => {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'yfw-lanethink-'))
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'lane-think-main' })
  try {
    const engine = createEngine({
      opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
      wire, session,
    })
    // lane transcript 路径直接取自登记表 laneStore.file（不经文件名推断）。前台 spawn 在收口
    // finally 里 pendingSubAgents.delete(taskId)，登记项只在飞行中可见；后台 spawn 保留终态
    // 条目，故用后台 + await 同一 promise（promise 结算即代表 lane 已跑完、transcript 已落盘）。
    const spawned = await engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '做个小事', run_in_background: true },
      { toolUseId: 'tool_use_lanethink_1' },
    )
    const taskId = await waitFor(() => [...engine.pendingSubAgents.keys()][0])
    assert.ok(taskId, `子任务应登记到 pendingSubAgents：${String(spawned.content).slice(0, 200)}`)
    const entry = engine.pendingSubAgents.get(taskId)
    const laneFile = entry.laneStore.file
    assert.ok(laneFile, '登记项应带 laneStore.file')
    await entry.promise

    const lines = readFileSync(laneFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const types = lines.map((e) => e.type).join(',')
    const thinkRows = lines.filter((e) => e.type === 'thinking')
    const thinkIdx = lines.findIndex((e) => e.type === 'thinking')
    const asstIdx = lines.findIndex((e) => e.type === 'assistant')
    assert.ok(asstIdx >= 0, `lane transcript 应含 assistant 条目（工具迭代写入点），实际行型：${types}`)
    assert.ok(thinkIdx >= 0, `lane transcript 应含 thinking 条目，实际行型：${types}`)
    assert.ok(thinkIdx < asstIdx, `lane 思考必须先于该迭代 assistant：think@${thinkIdx} asst@${asstIdx}（行型 ${types}）`)
    assert.equal(thinkIdx + 1, asstIdx, `lane 思考与该迭代 assistant 相邻（落盘先思考后内容）：行型 ${types}`)
    // 两次请求各累积一条（同迭代多段合并成一条，不是每 delta 一条）
    assert.equal(thinkRows.length, 2, `两次迭代各一条 thinking，实际行型：${types}`)
    assert.deepEqual(thinkRows.map((e) => e.message.content[0].thinking), ['思考甲思考乙', '思考甲思考乙'])
    assert.equal(typeof lines[thinkIdx].message.model, 'string', 'thinking 条目的 model 落在 message 层（既有约定）')
    // 思考回放（2026-10-22）：子 lane 的工具轮同样把思考并入 assistant content 头部
    // （DeepSeek /anthropic 缺块直接 400）；仍**不单独成帧**（派生消息里没有独立的思考条）。
    const derived = entry.laneStore.deriveMessages()
    const toolTurns = derived.filter((m) => m.role === 'assistant' && Array.isArray(m.content)
      && m.content.some((b) => b?.type === 'tool_use'))
    assert.ok(toolTurns.length >= 1, '子 lane 应有带 tool_use 的派生 assistant 消息')
    for (const m of toolTurns) {
      assert.equal(m.content[0]?.type, 'thinking', '工具轮必须把思考放在 content 头部（回放形态）')
      assert.equal(m.content[0].thinking, '思考甲思考乙')
    }
    assert.ok(!derived.some((m) => Array.isArray(m.content)
      && m.content.length === 1 && m.content[0]?.type === 'thinking'), '思考不得单独成帧')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
