// subagent 体系 mock 冒烟：主 agent [mock:agent] → Agent tool_use → 子 lane 执行
// → task_started/progress/notification 事件 + tool_result 回填 + 子 transcript 独立
// 用法：node zz-smoke/subagent-smoke.mjs（PONOS_MOCK_API=1 已内建）
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

process.env.PONOS_MOCK_API = '1'

const events = []
const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
const dir = mkdtempSync(join(tmpdir(), 'ponos-sub-smoke-'))
const configDir = join(dir, 'home')
const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
const engine = createEngine({
  opts: { model: 'mock-model', configDir, addDirs: [dir], skipPermissions: true },
  wire,
  session: store,
})
engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')

const t0 = Date.now()
const r = await engine.runTurn({ content: '[mock:agent]' })
const ms = Date.now() - t0

const sys = events.filter((e) => e.type === 'system')
const started = sys.filter((e) => e.subtype === 'task_started')
const notif = sys.filter((e) => e.subtype === 'task_notification')
const taskId = started[0]?.task_id

let ok = true
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) ok = false }
check('task_started 事件发出', started.length === 1 && typeof taskId === 'string' && started[0].prompt.includes('测试子任务'))
check('tool_use_id 关联', started[0]?.tool_use_id === 'tool_use_mock_agent')
check('task_notification completed', notif.length === 1 && notif[0]?.status === 'completed' && notif[0]?.task_id === taskId)
check('最终文本非空', typeof r.text === 'string' && r.text.includes('工具执行完成'))
check('result 事件', events.some((e) => e.type === 'result'))
// 子 lane transcript 独立文件存在；主 transcript 无子 agent 内容
const laneFile = join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${taskId}.jsonl`)
check('子 lane transcript 独立文件', existsSync(laneFile))
const mainFile = store.file
const mainText = existsSync(mainFile) ? readFileSync(mainFile, 'utf-8') : ''
const mainEntries = mainText.split('\n').filter(Boolean).map((l) => JSON.parse(l))
// 零污染：子指令未作为独立 user 消息出现在主日志（子文本只经 tool_result 回填）
const hasDirectSubEntry = mainEntries.some(
  (e) => e.message?.role === 'user' && e.message.content === '测试子任务：请输出一句确认'
)
check('主 transcript 无子 agent 独立条目（仅 tool_result 回填）', !hasDirectSubEntry)
check('主 transcript 含 Agent tool_use', mainText.includes('tool_use_mock_agent'))
check('主 transcript 含 tool_result 回填', mainEntries.some((e) => e.message && JSON.stringify(e.message.content).includes('工具执行完成')))
check('后台登记表可查询', engine.taskSystem.list().length > 0)

// —— S1/S2/S3 冒烟：血缘字段 + 后台任务续跑（resume 复用 lane）——
const bg = await engine.spawnSubAgent(
  { subagent_type: 'general-purpose', prompt: '冒烟第一轮', run_in_background: true },
  { toolUseId: 'tool_use_smoke_bg' },
)
const bgTaskId = String(bg.content).match(/task_id: ([0-9a-f-]+)/)?.[1]
check('后台任务启动返回 task_id', typeof bgTaskId === 'string' && !!bgTaskId)
const bgStarted = events.filter((e) => e.type === 'system' && e.subtype === 'task_started' && e.task_id === bgTaskId)[0]
check('task_started 带血缘字段（parent null / depth 0）', bgStarted?.parent_task_id === null && bgStarted?.depth === 0)
const waitBgNotifs = (n, timeoutMs = 4000) => new Promise((resolve) => {
  const iv = setInterval(() => {
    if (events.filter((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === bgTaskId).length >= n) { clearInterval(iv); resolve() }
  }, 10)
  setTimeout(() => { clearInterval(iv); resolve() }, timeoutMs)
})
await waitBgNotifs(1)
const resumeR = await engine.taskSystem.resume(bgTaskId, '冒烟第二轮')
check('Task resume 续跑', resumeR.isError === false && /已续跑/.test(resumeR.content))
check('task_resumed 事件发出', events.some((e) => e.type === 'system' && e.subtype === 'task_resumed' && e.task_id === bgTaskId))
await waitBgNotifs(2)
const bgNotifs = events.filter((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === bgTaskId)
check('续跑后第二条完成通知（含续跑指令回显）', bgNotifs.length >= 2 && /冒烟第二轮/.test(bgNotifs[bgNotifs.length - 1].summary || ''))

console.log(`\n耗时 ${ms}ms；事件序：${events.map((e) => e.type + (e.subtype ? '/' + e.subtype : '')).join(' → ')}`)
rmSync(dir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
