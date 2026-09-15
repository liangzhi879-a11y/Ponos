// 子 lane 技能目录（2026-09-12 AS2：「优化了却看不到效果」的子代理侧修复）
// ---------------------------------------------------------------------------
// 病灶：lane 的 system prompt 此前只有 agent 正文，**没有技能清单**；而 Skill 工具的
// schema 写着"技能名（与提示词【可用技能】清单中的 id 一致）"⇒ 子 Agent 无从得知合法
// id，只能猜，猜错还会被 allowedSkills 白名单拒绝（"清单存在但子代理不可用"）。
// 修复：engine 的 spawnSubAgent 经 withLaneSkillCatalog 补一行技能 id 目录；口径 =
// agent 自带的 skills 白名单优先（与拒绝闸同源），否则列 opts.skillIds（cli 发现的全表）。
//
// 断言口子：系统提示不落盘（transcript 只有 user/assistant），故用 PONOS_MOCK_SYS_PROBE
// 探针——mock 按"请求内 system 条目是否含 needle"回 SYS_PROBE:1/0。lane 的 system 由
// runLaneExecution 自拼进 messages（engine 的 msgs()），故对 mock 可见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'
import { withLaneSkillCatalog } from '../kernel/prompt.mjs'

process.env.PONOS_MOCK_API = '1'

const LANE_PROMPT = '[mock:sys-probe] 执行子任务'

function makeEnv({ agents = {}, skillIds = [] } = {}) {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-laneskills-'))
  const configDir = join(dir, 'home')
  mkdirSync(join(configDir, 'agents'), { recursive: true })
  for (const [id, body] of Object.entries(agents)) writeFileSync(join(configDir, 'agents', `${id}.md`), body)
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true, skillIds },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  return { events, engine, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// 用探针跑一次前台 lane，返回 mock 回显（SYS_PROBE:1 = 系统提示含 needle）。
// 注意：直接调 spawnSubAgent 返回的是**工具结果形状** { content, isError }（Agent 工具
// 的返回值），不是 task 形状 { status, text } —— 断言读 content。
async function probeLane(env, { type, needle }) {
  process.env.PONOS_MOCK_SYS_PROBE = needle
  try {
    const r = await env.engine.spawnSubAgent({ subagent_type: type, prompt: LANE_PROMPT }, { toolUseId: 'tool_use_lane_probe' })
    return String(r?.content ?? r?.text ?? '')
  } finally {
    delete process.env.PONOS_MOCK_SYS_PROBE
  }
}

test('lane 系统提示含技能目录：agent 未声明 skills → 列主会话全表 id', async () => {
  const env = makeEnv({ skillIds: ['alpha-skill', 'beta-skill'] })
  try {
    const text = await probeLane(env, { type: 'general-purpose', needle: '可用技能（Skill 工具，skill 参数填 id）：alpha-skill、beta-skill' })
    assert.match(text, /SYS_PROBE:1/, `lane 提示词必须带上技能 id 目录（实际回显 ${JSON.stringify(text)}）`)
  } finally { env.cleanup() }
})

test('lane 系统提示的技能目录以 agent 的 skills 白名单为准（与拒绝闸同源）', async () => {
  const env = makeEnv({
    skillIds: ['alpha-skill', 'beta-skill'],
    agents: {
      'scoped-agent': '---\nname: "scoped-agent"\ndescription: "只用 beta"\nskills: beta-skill\n---\n正文\n',
    },
  })
  try {
    // 白名单内 → 出现
    const hit = await probeLane(env, { type: 'scoped-agent', needle: '可用技能（Skill 工具，skill 参数填 id）：beta-skill' })
    assert.match(hit, /SYS_PROBE:1/, '白名单内的技能 id 必须出现在 lane 提示词')
    // 白名单外 → 不得出现（列出来必被 allowedSkills 拒，等于误导子 Agent）
    const miss = await probeLane(env, { type: 'scoped-agent', needle: 'alpha-skill' })
    assert.match(miss, /SYS_PROBE:0/, `声明了 skills 的 agent 不得列出白名单外的 id（实际 ${JSON.stringify(miss)}）`)
  } finally { env.cleanup() }
})

test('无技能可列时不产出空目录行（不引入空标题）', async () => {
  const env = makeEnv({ skillIds: [] })
  try {
    const text = await probeLane(env, { type: 'general-purpose', needle: '可用技能（Skill' })
    assert.match(text, /SYS_PROBE:0/, '无技能时不得出现技能目录行')
  } finally { env.cleanup() }
})

test('opts.skillIds 到位后，agent 引用未知技能的诊断才会触发（此前恒缺省 = 死诊断）', async () => {
  const env = makeEnv({
    skillIds: ['alpha-skill'],
    agents: { 'ghost-agent': '---\nname: "ghost-agent"\ndescription: "引用不存在的技能"\nskills: ghost-skill\n---\n正文\n' },
  })
  try {
    await probeLane(env, { type: 'ghost-agent', needle: '不存在的探针串' })
    const w = env.events.find((e) => e.type === 'ponos_warning' && e.level === 'agent_spec')
    assert.ok(w, `应产出 agent_spec 告警（实际事件：${env.events.map((e) => e.type).join(',')}）`)
    assert.match(String(w.message || ''), /ghost-skill/, '告警须点名悬空技能 id')
  } finally { env.cleanup() }
})

test('withLaneSkillCatalog 纯函数口径：白名单优先 / 全表回退 / 皆空原样返回', () => {
  const base = '你是子 Agent。'
  assert.equal(withLaneSkillCatalog(base, {}), base, '两者皆空 → 原样返回')
  assert.equal(withLaneSkillCatalog(base, { skillIds: [] }), base)
  assert.equal(
    withLaneSkillCatalog(base, { skillIds: ['a', 'b'] }),
    '你是子 Agent。\n可用技能（Skill 工具，skill 参数填 id）：a、b',
  )
  assert.equal(
    withLaneSkillCatalog(base, { agentSkills: ['b'], skillIds: ['a', 'b'] }),
    '你是子 Agent。\n可用技能（Skill 工具，skill 参数填 id）：b',
    '声明了白名单 → 只列白名单（与拒绝闸同源）',
  )
})
