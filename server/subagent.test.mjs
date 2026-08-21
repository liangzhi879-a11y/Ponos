// subagent 体系正式测试（mock API，无网络）
// ---------------------------------------------------------------------------
// 覆盖：agents.mjs（frontmatter 解析/扫描合并/容错/路由）、Agent 前台链路、
// 后台任务 + Task 工具、子 lane 隔离（独立 transcript + 主日志零污染）、
// 嵌套禁止、Task stop 中止、主 cancel 中断前台子循环。
// 依赖内核 mock 流：[mock:agent] 触发 Agent tool_use；子 lane prompt 走
// '[mock:tool-safe]' 时触发非高危 Bash 工具调用（task_progress 事件 + 慢速窗口）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { parseAgentMarkdown, discoverUserAgents, resolveAgents, resolveAgent, BUILTIN_AGENTS } from '../kernel/agents.mjs'

process.env.YFW_MOCK_API = '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// taskId 为 UUID（含连字符），不能用 \w+ 截取
const extractTaskId = (content) => String(content).match(/task_id: ([0-9a-f-]+)/)?.[1]

// 直连 engine 测试环境：事件收集 wire + 临时会话目录
function makeEnv() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'yfw-sub-test-'))
  const configDir = join(dir, 'home')
  const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
    wire,
    session: store,
  })
  engine.setSystemPrompt('你是 YFW-turbo 测试内核。')
  const laneFile = (taskId) => join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
  const waitNotif = async (taskId, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const n = events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      if (n) return n
      await sleep(10)
    }
    return null
  }
  return { events, engine, store, dir, laneFile, waitNotif, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// —— agents.mjs ——

test('parseAgentMarkdown：合法 frontmatter（含 YAML 转义）→ 字段齐全', () => {
  const md = [
    '---',
    'name: "material-writer"',
    'description: "撰写申报材料正文\\n专业正式、数据可溯源"',
    'tools: Bash, Read, Write',
    'model: "deepseek-v4-flash"',
    '---',
    '你是申报材料撰写专员。',
  ].join('\n')
  const a = parseAgentMarkdown(md)
  assert.equal(a.id, 'material-writer')
  assert.equal(a.description, '撰写申报材料正文\n专业正式、数据可溯源')
  assert.deepEqual(a.tools, ['Bash', 'Read', 'Write'])
  assert.equal(a.model, 'deepseek-v4-flash')
  assert.equal(a.systemPrompt, '你是申报材料撰写专员。')
})

test('parseAgentMarkdown：非法输入（无 frontmatter / 缺 name）→ null 容错', () => {
  assert.equal(parseAgentMarkdown('plain text no frontmatter'), null)
  assert.equal(parseAgentMarkdown('---\ndescription: 缺 name\n---\nbody'), null)
  assert.equal(parseAgentMarkdown(''), null)
  assert.equal(parseAgentMarkdown('---\nname: "x"\n---\n无 description'), null)
})

test('resolveAgents：内置 ∪ 扫描合并；用户级同名覆盖内置；非法/隐藏文件容错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-agents-'))
  try {
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(join(dir, 'agents', 'general-purpose.md'),
      '---\nname: "general-purpose"\ndescription: "自定义通用代理"\ntools: Read\n---\ncustom body\n')
    writeFileSync(join(dir, 'agents', 'broken.md'), 'no frontmatter here\n') // 非法容错
    writeFileSync(join(dir, 'agents', '.hidden.md'), '---\nname: "h"\ndescription: "x"\n---\ny\n') // 隐藏跳过
    writeFileSync(join(dir, 'agents', 'note.txt'), '---\nname: "t"\ndescription: "x"\n---\ny\n') // 非 .md 跳过
    const agents = resolveAgents({ configDir: dir })
    // 同名覆盖不增加数量；broken/.hidden/note.txt 不计入
    assert.equal(agents.length, BUILTIN_AGENTS.length)
    const gp = resolveAgent(agents, 'general-purpose')
    assert.equal(gp.description, '自定义通用代理')
    assert.deepEqual(gp.tools, ['Read'])
    assert.equal(gp.systemPrompt, 'custom body')
    // 目录不存在容错
    assert.equal(resolveAgents({ configDir: join(dir, 'nope') }).length, BUILTIN_AGENTS.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('discoverUserAgents：多 agent 扫描（含新增业务 agent）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-agents-'))
  try {
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(join(dir, 'agents', 'a.md'), '---\nname: "alpha"\ndescription: "A 代理"\n---\nbody a\n')
    writeFileSync(join(dir, 'agents', 'b.md'), '---\nname: "beta"\ndescription: "B 代理"\ntools: Grep, Read\n---\nbody b\n')
    const list = discoverUserAgents({ configDir: dir })
    assert.deepEqual(list.map((a) => a.id).sort(), ['alpha', 'beta'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveAgent：按 id/name 查找；未知类型 → null', () => {
  const agents = resolveAgents({ configDir: '/nonexistent' })
  assert.equal(resolveAgent(agents, 'researcher').id, 'researcher')
  assert.equal(resolveAgent(agents, 'general-purpose').id, 'general-purpose')
  assert.equal(resolveAgent(agents, 'ghost-agent'), null)
})

// —— Agent 工具链路 ——

test('Agent 前台：task_started → task_notification(completed) → tool_result 回填，主日志零污染', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent]' })
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.filter((e) => e.subtype === 'task_started')
    const notif = sys.filter((e) => e.subtype === 'task_notification')
    assert.equal(started.length, 1)
    assert.equal(started[0].tool_use_id, 'tool_use_mock_agent')
    assert.equal(started[0].prompt, '测试子任务：请输出一句确认')
    assert.equal(notif.length, 1)
    assert.equal(notif[0].status, 'completed')
    assert.equal(notif[0].task_id, started[0].task_id)
    assert.ok(notif[0].usage.total_tokens > 0)
    assert.ok(String(r.text).includes('工具执行完成'))
    // 子 lane 独立 transcript 文件存在
    assert.ok(existsSync(env.laneFile(started[0].task_id)), '子 lane transcript 应独立存在')
    // 主 transcript：Agent tool_use + tool_result 回填；无子指令独立 user 条目
    const mainText = readFileSync(env.store.file, 'utf-8')
    assert.ok(mainText.includes('tool_use_mock_agent'))
    const mainEntries = mainText.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.ok(!mainEntries.some((e) => e.message?.role === 'user' && e.message.content === '测试子任务：请输出一句确认'))
    assert.ok(mainEntries.some((e) => JSON.stringify(e.message.content).includes('工具执行完成')))
  } finally { env.cleanup() }
})

test('Agent 后台：立即返回 task_id → task_progress 事件 → 完成通知 → Task 工具 list/status/output', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_bg_1' },
    )
    assert.match(String(r.content), /task_id: [0-9a-f-]{8,}/)
    const taskId = extractTaskId(r.content)
    assert.ok(taskId, '应能提取完整 task_id')
    // 子 lane 内工具调用 → task_progress 事件
    const deadline = Date.now() + 3000
    let progress = false
    while (Date.now() < deadline) {
      if (env.events.some((e) => e.type === 'system' && e.subtype === 'task_progress' && e.task_id === taskId)) { progress = true; break }
      await sleep(10)
    }
    assert.ok(progress, 'task_progress 应随子工具调用发出')
    const notif = await env.waitNotif(taskId)
    assert.ok(notif, 'task_notification 应到达')
    assert.equal(notif.status, 'completed')
    // Task 工具（经 taskSystem）
    assert.match(env.engine.taskSystem.list(), new RegExp(taskId.slice(0, 8)))
    assert.match(env.engine.taskSystem.status(taskId), /completed/)
    const out = env.engine.taskSystem.output(taskId)
    assert.equal(out.isError, false)
    assert.match(String(out.content), /工具执行完成/)
  } finally { env.cleanup() }
})

test('嵌套禁止：子 lane 上下文内 Agent 工具返回错误', async () => {
  const env = makeEnv()
  try {
    const reg = createToolRegistry({ cwd: env.dir, addDirs: [env.dir], skipPermissions: true })
    const r = await reg.run({ name: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'x' } }, { lane: true })
    assert.equal(r.isError, true)
    assert.match(r.content, /不支持嵌套/)
    // 未知类型路由（经 engine.spawnSubAgent 直接调用）
    const ghost = await env.engine.spawnSubAgent({ subagent_type: 'ghost-agent', prompt: 'x' })
    assert.equal(ghost.isError, true)
    assert.match(ghost.content, /未知子 Agent/)
  } finally { env.cleanup() }
})

test('Task stop：中止后台子 Agent，通知 status=stopped', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_stop_1' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId, '应能提取完整 task_id')
    // 立即中止（mock 流 30ms 段延迟 + Bash 执行窗口，stop 落在运行期）
    const stop = env.engine.taskSystem.stop(taskId)
    assert.equal(stop.isError, false)
    assert.match(stop.content, /已请求中止/)
    const notif = await env.waitNotif(taskId)
    assert.ok(notif, '中止后应仍有终态通知')
    assert.equal(notif.status, 'stopped')
    // 已结束任务再 stop → 提示已结束
    const again = env.engine.taskSystem.stop(taskId)
    assert.match(again.content, /已结束/)
    // 未知任务
    assert.match(env.engine.taskSystem.status('no-such-task'), /任务不存在/)
    assert.equal(env.engine.taskSystem.output('no-such-task').isError, true)
  } finally { env.cleanup() }
})

test('主 cancel：signal.aborted 中断前台子循环 → 子 Agent 任务已取消', async () => {
  const env = makeEnv()
  try {
    // 前台 spawnSubAgent（'[mock:tool-safe]' 含真实 Bash 执行窗口）；50ms 后置主 signal
    const p = env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]' },
      { toolUseId: 'tool_use_cancel_1' },
    )
    await sleep(50)
    env.engine.signal.aborted = true
    const r = await p
    assert.match(String(r.content), /已取消/)
    // 前台任务不登记 pendingSubAgents，通知事件仍发出（exec 内 wire）
    const stoppedNotif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification' && e.status === 'stopped')
    assert.ok(stoppedNotif, '中止前台子任务应发出 stopped 通知')
  } finally { env.cleanup() }
})
