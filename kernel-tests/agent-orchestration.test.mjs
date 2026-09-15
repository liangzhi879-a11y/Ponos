// 子 agent 协同升级 B1-B4（2026-09-11 系统化升级 Phase 1/2）
// ---------------------------------------------------------------------------
// B4 内置 agent（implementer/reviewer/explorer/planner + frontmatter 扩展字段）
// B1 Agent 工具 context 继承档（none/summary/full 文本投影注入 lane）
// B2 Task 工具 send_message/followup（lane inbox 工具边界吸收）
// B3 子 agent 并发槽 + FIFO 排队（PONOS_LANE_MAX_CONCURRENT）
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LANE_MAX_CONCURRENT = '1'
const { createEngine } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../kernel/session.mjs'
import { BUILTIN_AGENTS, parseAgentMarkdown } from '../kernel/agents.mjs'

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

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-orch-'))
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
    taskStarted: () => {}, taskResumed: () => {}, taskNotification: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'orch-session' })
  session.appendUser('主任务历史 A：背景信息')
  session.appendAssistant([{ type: 'text', text: '主任务历史 B：已确认的结论' }])
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
    wire, session,
  })
  return { engine, session, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// —— B4 内置 agent 定义 ——

test('B4：内置 implementer/reviewer/explorer/planner 齐全且白名单正确', () => {
  const ids = new Set(BUILTIN_AGENTS.map((a) => a.id))
  for (const id of ['implementer', 'reviewer', 'explorer', 'planner']) assert.ok(ids.has(id), `应有 ${id}`)
  const impl = BUILTIN_AGENTS.find((a) => a.id === 'implementer')
  assert.ok(impl.tools.includes('Write') && impl.tools.includes('Edit'), '实现者可写')
  assert.ok(impl.disallowedTools.includes('Agent'), '实现者禁嵌套派发')
  const rev = BUILTIN_AGENTS.find((a) => a.id === 'reviewer')
  assert.ok(!rev.tools.includes('Write'), '审查者无写工具')
  assert.ok(rev.disallowedTools.includes('Write') && rev.disallowedTools.includes('Edit'), '审查者禁写')
})

test('B4：frontmatter 扩展字段（disallowedTools/effort/background）解析', () => {
  const md = `---
name: custom-agent
description: 测试
tools: Read, Grep
disallowedTools: Write, Edit
model: m1
effort: low
background: true
---
系统提示正文`
  const a = parseAgentMarkdown(md)
  assert.equal(a.id, 'custom-agent')
  assert.deepEqual(a.disallowedTools, ['Write', 'Edit'])
  assert.equal(a.effort, 'low')
  assert.equal(a.background, true)
})

// —— B1 context 继承档 ——

test('B1：context=full → lane 继承主会话历史文本；none → 不继承', async () => {
  const env = makeEnv()
  try {
    const rFull = await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '子任务指令', context: 'full' }, { toolUseId: 't1' })
    assert.ok(String(rFull.content).includes('执行完成'), '前台子任务应完成')
    const rNone = await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '子任务指令二', context: 'none' }, { toolUseId: 't2' })
    assert.ok(String(rNone.content).includes('执行完成'))
    // lane transcript 文件：projects/<cwd>/<taskId>.jsonl——按内容断言继承与否
    const laneDir = join(env.dir, 'projects', env.dir.replace(/[^a-zA-Z0-9]/g, '-'))
    const files = readdirSync(laneDir).filter((f) => f.endsWith('.jsonl') && f !== 'orch-session.jsonl')
    assert.equal(files.length, 2, '两次 spawn 各一个 lane transcript')
    const contents = files.map((f) => readFileSync(join(laneDir, f), 'utf-8'))
    const fullLane = contents.find((c) => c.includes('子任务指令') && c.includes('主任务历史 A'))
    const noneLane = contents.find((c) => c.includes('子任务指令二'))
    assert.ok(fullLane, 'full 档应继承主会话历史文本')
    assert.ok(fullLane.includes('主任务历史 B：已确认的结论'), 'assistant 文本同样投影继承')
    assert.ok(!noneLane.includes('主任务历史 A'), 'none 档不得继承')
  } finally { env.cleanup() }
})

test('B1：context=summary → lane 带最近轮次文本（无摘要时降级为最近轮次）', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '摘要档子任务', context: 'summary' }, { toolUseId: 't3' })
    assert.ok(String(r.content).includes('执行完成'))
    const laneDir = join(env.dir, 'projects', env.dir.replace(/[^a-zA-Z0-9]/g, '-'))
    const files = readdirSync(laneDir).filter((f) => f.endsWith('.jsonl') && f !== 'orch-session.jsonl')
    const text = files.map((f) => readFileSync(join(laneDir, f), 'utf-8')).join('\n')
    assert.ok(text.includes('主任务历史 A'), 'summary 档（无已落摘要时）继承最近轮次文本')
  } finally { env.cleanup() }
})

// —— B2 消息投递 ——

test('B2：后台任务运行中 send_message → lane 工具边界吸收（transcript 含【主 Agent 消息】）', async () => {
  process.env.PONOS_MOCK_LOOP = 'ok' // lane 每轮产 Bash echo（循环运行中，供投递窗口）
  const env = makeEnv()
  try {
    const r = await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '[mock:loop]', run_in_background: true }, { toolUseId: 't4' })
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    assert.ok(taskId, '应返回 task_id')
    const entry = env.engine.pendingSubAgents.get(taskId)
    assert.ok(entry && entry.status === 'running')
    const sm = await env.engine.taskSystem.sendMessage(taskId, '补充要求：改用方案 X')
    assert.ok(String(sm.content).includes('已投递'), '运行中任务应接受投递')
    const got = await waitFor(() => {
      try { return readFileSync(entry.laneStore.file, 'utf-8').includes('【主 Agent 消息】补充要求：改用方案 X') ? true : null } catch { return null }
    }, 8000)
    assert.ok(got, 'lane 应在工具边界吸收投递消息')
    // 已结束任务：send_message 引导 followup；followup 自动 resume
    env.engine.taskSystem.stop(taskId)
    await waitFor(() => env.engine.pendingSubAgents.get(taskId)?.status === 'stopped', 5000)
    const sm2 = await env.engine.taskSystem.sendMessage(taskId, '再来一条')
    assert.match(String(sm2.content), /用 followup/, '已结束任务引导 followup')
    const fu = await env.engine.taskSystem.followup(taskId, '继续执行并汇报')
    assert.match(String(fu.content), /已续跑|仍在运行/, 'followup 对已停止任务自动 resume')
  } finally {
    delete process.env.PONOS_MOCK_LOOP
    env.cleanup()
  }
})

// —— B3 并发槽 ——

test('B3：并发槽=1 → 第二个后台任务排队；首个停止后 FIFO 自动启动', async () => {
  process.env.PONOS_MOCK_LOOP = 'ok'
  const env = makeEnv()
  try {
    const r1 = await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '[mock:loop]', run_in_background: true }, { toolUseId: 't5' })
    const id1 = String(r1.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    const r2 = await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '[mock:loop]', run_in_background: true }, { toolUseId: 't6' })
    const id2 = String(r2.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    assert.match(String(r2.content), /已排队/, '并发满时应排队')
    assert.equal(env.engine.pendingSubAgents.get(id2).status, 'queued')
    env.engine.taskSystem.stop(id1)
    const started = await waitFor(() => env.engine.pendingSubAgents.get(id2)?.status === 'running' ? true : null, 5000)
    assert.ok(started, '槽位释放后排队任务应自动启动')
  } finally {
    delete process.env.PONOS_MOCK_LOOP
    env.cleanup()
  }
})
