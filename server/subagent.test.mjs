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
  // 等待第 nth 条完成通知（resume 后同一 taskId 有多条通知，find 只取首条会拿旧值）
  const waitNotif = async (taskId, timeoutMs = 8000, nth = 1) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ns = events.filter((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
      if (ns.length >= nth) return ns[nth - 1]
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
    assert.ok(mainEntries.some((e) => e.message && JSON.stringify(e.message.content).includes('工具执行完成')))
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

// —— S1 血缘登记 ——

test('S1 血缘：task_started 带 parent_task_id/depth；后台登记 lineage 正确；list 层级缩进', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_lineage_1' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId)
    const started = env.events.find((e) => e.type === 'system' && e.subtype === 'task_started' && e.task_id === taskId)
    assert.ok(started, 'task_started 应发出')
    // 主 agent 派发 → 血缘根：parent null / depth 0
    assert.equal(started.parent_task_id, null)
    assert.equal(started.depth, 0)
    const entry = env.engine.pendingSubAgents.get(taskId)
    assert.ok(entry, '后台任务应登记')
    assert.equal(entry.lineage.parentTaskId, null)
    assert.equal(entry.lineage.depth, 0)
    assert.deepEqual(entry.lineage.path, [taskId])
    // list 层级缩进：depth 0 无缩进，仍含任务 id
    assert.match(env.engine.taskSystem.list(), new RegExp(taskId.slice(0, 8)))
    await env.waitNotif(taskId)
  } finally { env.cleanup() }
})

// —— S2 可继续子 agent（resume）——

test('S2 resume：后台任务完成 → Task resume → task_resumed 事件 → 基于原 lane 续跑', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '第一轮任务', run_in_background: true },
      { toolUseId: 'tool_use_resume_1' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId)
    const n1 = await env.waitNotif(taskId)
    assert.ok(n1, '首轮通知应到达')
    assert.equal(n1.status, 'completed')
    assert.match(n1.summary, /第一轮任务/)
    // resume：续跑指令追加到既有 lane
    const resume = await env.engine.taskSystem.resume(taskId, '第二轮：继续')
    assert.equal(resume.isError, false)
    assert.match(resume.content, /已续跑/)
    const resumed = env.events.find((e) => e.type === 'system' && e.subtype === 'task_resumed' && e.task_id === taskId)
    assert.ok(resumed, 'task_resumed 事件应发出')
    assert.equal(resumed.prompt, '第二轮：继续')
    const n2 = await env.waitNotif(taskId, 8000, 2)
    assert.ok(n2, '续跑后通知应到达')
    assert.equal(n2.task_id, taskId)
    assert.match(n2.summary, /第二轮：继续/)
    // lane transcript 含两条 user 消息（原指令 + 续跑指令），历史未丢失
    const laneText = readFileSync(env.laneFile(taskId), 'utf-8')
    const laneEntries = laneText.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const userTexts = laneEntries.filter((e) => e.message?.role === 'user' && typeof e.message.content === 'string').map((e) => e.message.content)
    assert.ok(userTexts.includes('第一轮任务'), '原指令应保留')
    assert.ok(userTexts.includes('第二轮：继续'), '续跑指令应追加')
  } finally { env.cleanup() }
})

test('S2 resume 状态机：running 中拒绝；不存在任务报错；可重复续跑', async () => {
  const env = makeEnv()
  try {
    // running 中 resume → 拒绝
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:tool-safe]', run_in_background: true },
      { toolUseId: 'tool_use_resume_run_1' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId)
    // spawnSubAgent 同步返回时已登记 running，立即 resume 必命中 running
    const busy = await env.engine.taskSystem.resume(taskId, '再跑')
    assert.equal(busy.isError, true)
    assert.match(busy.content, /仍在运行/)
    // 不存在任务
    const ghost = await env.engine.taskSystem.resume('no-such-task', 'x')
    assert.equal(ghost.isError, true)
    assert.match(ghost.content, /任务不存在/)
    // 完成后可重复续跑（第二次续跑同样成功）
    await env.waitNotif(taskId)
    const again = await env.engine.taskSystem.resume(taskId, '第二轮')
    assert.equal(again.isError, false)
    assert.match(again.content, /已续跑/)
    await env.waitNotif(taskId)
  } finally { env.cleanup() }
})

// —— S3 结果承接（resume_task_id + outputs）——

test('S3 resume_task_id：Agent 工具基于既有后台任务会话续跑（等价 Task resume）', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '初始任务', run_in_background: true },
      { toolUseId: 'tool_use_rtid_1' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId)
    await env.waitNotif(taskId)
    // 直接经 spawnSubAgent（Agent 工具执行体）续跑
    const rtid = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '续跑指令：产出结果', resume_task_id: taskId },
      { toolUseId: 'tool_use_rtid_2' },
    )
    assert.equal(rtid.isError, false)
    assert.match(rtid.content, /已续跑/)
    const n2 = await env.waitNotif(taskId, 8000, 2)
    assert.ok(n2, '续跑完成通知应到达')
    assert.equal(n2.task_id, taskId)
    assert.match(n2.summary, /续跑指令：产出结果/)
    // resume_task_id 指向不存在任务 → 错误
    const ghost = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: 'x', resume_task_id: 'no-such-task' },
      {},
    )
    assert.equal(ghost.isError, true)
    assert.match(ghost.content, /任务不存在/)
  } finally { env.cleanup() }
})

test('S3 outputs：子 agent Write 产物路径全部进 task_notification.outputs，文件真实落盘', async () => {
  const env = makeEnv()
  const prev = process.env.YFW_MOCK_WRITE_DIR
  try {
    process.env.YFW_MOCK_WRITE_DIR = env.dir
    const r = await env.engine.spawnSubAgent(
      { subagent_type: 'general-purpose', prompt: '[mock:write]', run_in_background: true },
      { toolUseId: 'tool_use_outputs_1' },
    )
    const taskId = extractTaskId(r.content)
    assert.ok(taskId)
    const n = await env.waitNotif(taskId)
    assert.ok(n, '完成通知应到达')
    assert.equal(n.status, 'completed')
    // outputs 含两个 Write 路径（onTool 收集，与 mock 生成的正斜杠拼法一致）
    const outA = `${env.dir}/mock-a.txt`
    const outB = `${env.dir}/mock-b.txt`
    assert.deepEqual(n.outputs, [outA, outB])
    assert.equal(n.output_file, outB, 'output_file 为最后产物')
    // 文件真实落盘（Write 工具在共享工作区执行成功）
    assert.ok(existsSync(outA))
    assert.ok(existsSync(outB))
  } finally {
    if (prev === undefined) delete process.env.YFW_MOCK_WRITE_DIR
    else process.env.YFW_MOCK_WRITE_DIR = prev
    env.cleanup()
  }
})
