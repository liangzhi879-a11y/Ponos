// subagent 真实 API 冒烟（真实模型，S1 血缘 / S2 resume / S3 outputs 承接）
// ---------------------------------------------------------------------------
// 验证 mock 之外的真实链路：真实模型驱动的后台子 agent 执行（含真实 Write
// 产物落盘）→ task_notification.outputs 收集 → Task resume 续跑（真实模型
// 理解续跑指令）→ task_resumed 事件 → 第二条完成通知。
// 用法：
//   node zz-smoke/subagent-real-api.mjs
// 前置：benchmark/.env 提供 LLM_API_KEY/LLM_BASE_URL（进程 env 优先），
// 且未设 YFW_MOCK_API。脚本只打印 base/model，不打印密钥。
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDotEnv, buildAgentEnv, resolveModel, resolveBaseUrl, usageText } from '../benchmark/lib/llm-api.mjs'
import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

loadDotEnv() // 进程 env 优先，不覆盖已设置

if (process.env.YFW_MOCK_API === '1') {
  console.error('错误: YFW_MOCK_API=1 会走 mock，先清除再跑真实 API')
  process.exit(2)
}
const BASE = resolveBaseUrl()
if (!BASE) { console.error('错误: 需要 LLM_BASE_URL 或 ANTHROPIC_BASE_URL（benchmark/.env 或 env）'); process.exit(2) }
if (!process.env.LLM_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.DEEPSEEK_API_KEY) {
  console.error('错误: 缺少 API key（LLM_API_KEY / ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY）'); process.exit(2)
}
// 注入 yfw 内核需要的 API env（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL / ANTHROPIC_BASE_URL）
Object.assign(process.env, buildAgentEnv('yfw'))

const MODEL = resolveModel()
console.log(`模型=${MODEL} base=${BASE}（密钥不打印）`)

const events = []
const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
const dir = mkdtempSync(join(tmpdir(), 'yfw-sub-real-'))
const configDir = join(dir, 'home')
const store = createSessionStore({ configDir, cwd: dir, sessionId: 'main-session' })
const engine = createEngine({
  opts: { model: MODEL, configDir, addDirs: [dir], skipPermissions: true },
  wire,
  session: store,
})
engine.setSystemPrompt('你是 YFW-turbo 内核，负责派发与管理子 Agent。使用简体中文。')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const extractTaskId = (content) => String(content).match(/task_id: ([0-9a-f-]+)/)?.[1]
const waitNotif = async (taskId, nth = 1, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ns = events.filter((e) => e.type === 'system' && e.subtype === 'task_notification' && e.task_id === taskId)
    if (ns.length >= nth) return ns[nth - 1]
    await sleep(50)
  }
  return null
}

let ok = true
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) ok = false }

try {
  // ── 场景 1：真实模型后台子 agent（写真实文件 + 简短确认文本）──
  console.log('\n═══ 场景 1：后台子 agent 真实执行（Write 产物 + 文本）═══')
  const target = join(dir, 'report.txt')
  const r1 = await engine.spawnSubAgent(
    {
      subagent_type: 'general-purpose',
      prompt: `请用 Write 工具创建文件 ${target}，内容写「第一轮完成」。完成后只需回复一句话：第一轮OK。`,
      run_in_background: true,
    },
    { toolUseId: 'real_agent_1' },
  )
  const taskId = extractTaskId(r1.content)
  check('后台派发返回 task_id', typeof taskId === 'string' && !!taskId)
  const started = events.find((e) => e.type === 'system' && e.subtype === 'task_started' && e.task_id === taskId)
  check('task_started 血缘（parent null / depth 0）', started?.parent_task_id === null && started?.depth === 0)

  const n1 = await waitNotif(taskId, 1)
  check('首轮完成通知到达', !!n1 && n1.status === 'completed')
  if (n1) {
    console.log(`  首轮 summary: ${String(n1.summary).slice(0, 120)}`)
    console.log(`  首轮 outputs: ${JSON.stringify(n1.outputs)}`)
    // notifUsage 只含 total_tokens（无 in/out 拆分字段），usageText 读 in/out 会显示 0
    console.log(`  首轮 usage: ${JSON.stringify(n1.usage)}`)
  }
  check('outputs 含 report.txt（S3 承接）', n1?.outputs?.includes(target))
  check('report.txt 真实落盘', existsSync(target))
  if (existsSync(target)) console.log(`  report.txt 内容: ${JSON.stringify(readFileSync(target, 'utf-8'))}`)

  // ── 场景 2：真实模型 resume 续跑（真实理解续跑指令，写第二文件）──
  console.log('\n═══ 场景 2：Task resume 真实续跑 ═══')
  const target2 = join(dir, 'report2.txt')
  const resume = await engine.taskSystem.resume(taskId, `请再用 Write 工具创建文件 ${target2}，内容写「第二轮完成」。完成后回复：第二轮OK。`)
  check('resume 返回成功', resume.isError === false && /已续跑/.test(resume.content))
  const resumedEv = events.filter((e) => e.type === 'system' && e.subtype === 'task_resumed' && e.task_id === taskId)
  check('task_resumed 事件发出', resumedEv.length >= 1)
  const n2 = await waitNotif(taskId, 2)
  check('续跑第二条通知到达', !!n2 && n2.status === 'completed')
  if (n2) {
    console.log(`  续跑 summary: ${String(n2.summary).slice(0, 120)}`)
    console.log(`  续跑 outputs: ${JSON.stringify(n2.outputs)}`)
    console.log(`  续跑 usage: ${JSON.stringify(n2.usage)}`)
  }
  check('续跑 outputs 含 report2.txt（历史未丢，新产物追加）', n2?.outputs?.includes(target2))
  check('report2.txt 真实落盘', existsSync(target2))
  if (existsSync(target2)) console.log(`  report2.txt 内容: ${JSON.stringify(readFileSync(target2, 'utf-8'))}`)

  // ── 场景 3：血缘 / Task 工具状态 ──
  console.log('\n═══ 场景 3：Task 工具状态 ═══')
  const st = engine.taskSystem.status(taskId)
  check('Task status 显示 completed', /completed/.test(st))
  console.log(`  list:\n${engine.taskSystem.list()}`)

  console.log(`\n=== subagent 真实 API 冒烟 ${ok ? '全部 PASS' : '存在 FAIL'} ===`)
} catch (err) {
  ok = false
  console.error(`\n✗ subagent 真实 API 冒烟异常: ${err.message}`)
  console.error(err.stack)
} finally {
  rmSync(dir, { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
}
