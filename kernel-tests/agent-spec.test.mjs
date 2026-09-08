// agent spec 三字段生效（AS1）：model/tools/skills 接线 + 白名单 deny + 零回归锁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'
import { parseAgentMarkdown } from '../kernel/agents.mjs'
import { runAgents } from '../kernel/readonly.mjs'

process.env.PONOS_MOCK_API = '1'

function makeEnv({ agentMd }) {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-agspec-'))
  const configDir = join(dir, 'home')
  mkdirSync(join(configDir, 'agents'), { recursive: true })
  if (agentMd) writeFileSync(join(configDir, 'agents', `${agentMd.id}.md`), agentMd.body)
  // demo 技能：Skill 工具 skillLoadRoots 回退 allowDirs=[dir]（createToolRegistry 无
  // skillsDirs 时），故放 <dir>/demo/SKILL.md 即可命中
  mkdirSync(join(dir, 'demo'), { recursive: true })
  writeFileSync(join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\n步骤一\n')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  const waitNotif = async (taskId, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const n = events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      if (n) return n
      await new Promise((res) => setTimeout(res, 10))
    }
    return null
  }
  return { events, engine, store, dir, laneFile, waitNotif, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('parseAgentMarkdown：skills 字段解析（逗号分隔 + 缺失容错）', () => {
  const md = '---\nname: "spec-agent"\ndescription: "技能限定代理"\nskills: demo, office-docs\n---\nbody'
  const a = parseAgentMarkdown(md)
  assert.deepEqual(a.skills, ['demo', 'office-docs'])
  assert.deepEqual(parseAgentMarkdown('---\nname: "x"\ndescription: "y"\n---\nb').skills, [])
})

test('tools 白名单生效：用户级 general-purpose tools=[Read] → lane 内 Bash 被 deny（transcript 留痕）', async () => {
  const env = makeEnv({ agentMd: { id: 'general-purpose', body: '---\nname: "general-purpose"\ndescription: "受限通用"\ntools: Read\nmodel: "lane-model"\n---\n受限 body\n' } })
  try {
    // 后台跑子任务触发 Bash —— allowedTools=['Read'] ⇒ Bash 被 deny gate 拦
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_ag_1' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    assert.ok(taskId)
    const notif = await env.waitNotif(taskId)
    assert.ok(notif)
    assert.equal(notif.status, 'completed') // deny 后 R3-2 注入耗尽 guardInjections 正常收尾，不是 failed
    // lane transcript：出现 deny 文案 + assistant model = agent.model
    const text = readFileSync(env.laneFile(taskId), 'utf-8')
    assert.match(text, /工具白名单不含 Bash/)
    const asst = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'assistant')
    assert.ok(asst.some((e) => e.message?.model === 'lane-model'), 'lane 落盘 model 应取 agent.model')
  } finally { env.cleanup() }
})

test('model 生效（对照组）：无用户级覆盖 → 内置 general-purpose 8 基础工具仍全量可用 + model=mock-model', async () => {
  const env = makeEnv({ agentMd: null })
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_ag_2' },
    )
    const taskId = String(r.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
    const notif = await env.waitNotif(taskId)
    assert.ok(notif)
    assert.equal(notif.status, 'completed')
    assert.match(String(notif.summary), /工具执行完成/) // Bash 属内置 8 工具 → 放行
  } finally { env.cleanup() }
})

test('skills 白名单生效（正向）：general-purpose skills=[demo] → Skill demo 可加载', async () => {
  const env = makeEnv({ agentMd: { id: 'general-purpose', body: '---\nname: "general-purpose"\ndescription: "技能代理"\ntools: Skill\ntype: "user"\nskills: demo\n---\n技能 body\n' } })
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-skill]' })
    assert.ok(String(r.text).includes('工具执行完成'), String(r.text))
    const notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification')
    assert.ok(notif)
    const text = readFileSync(env.laneFile(notif.task_id), 'utf-8')
    assert.match(text, /技能「demo」已加载/)
  } finally { env.cleanup() }
})

test('skills 白名单生效（deny）：skills=[other] → Skill demo 被拒（不落地加载）', async () => {
  const env = makeEnv({ agentMd: { id: 'general-purpose', body: '---\nname: "general-purpose"\ndescription: "受限技能"\ntools: Skill\nskills: other\n---\n受限技能 body\n' } })
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-skill]' })
    const notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification')
    assert.ok(notif)
    const text = readFileSync(env.laneFile(notif.task_id), 'utf-8')
    assert.match(text, /技能白名单不含「demo」/)
    assert.ok(!text.includes('技能「demo」已加载'))
  } finally { env.cleanup() }
})

test('--agents 输出 schema（runAgents 纯函数）：source 正确区分 builtin/user', async () => {
  const env = makeEnv({ agentMd: { id: 'custom-writer', body: '---\nname: "custom-writer"\ndescription: "自定义代理"\nskills: demo\n---\nc\n' } })
  try {
    const list = runAgents({ configDir: env.dir + '/home' })
    const gp = list.find((a) => a.id === 'general-purpose')
    assert.ok(gp)
    assert.equal(gp.source, 'builtin')
    assert.ok(Array.isArray(gp.tools) && gp.tools.length >= 1)
    const cw = list.find((a) => a.id === 'custom-writer')
    assert.equal(cw.source, 'user')
    assert.deepEqual(cw.skills, ['demo'])
  } finally { env.cleanup() }
})
