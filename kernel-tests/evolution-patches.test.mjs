// 演化 P0 四补丁 + guard 台账接线（P-a/P-b/P-c/P-d）—— 引擎直调 + cli 短跑两级驱动
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md §4.2；
// 施工 brief：docs/superpowers/plans/2026-10-09-p0-observation-layer.md（测试②）。
// 纪律：断言钉"派生源"（哪条 meta / 哪个渠道计数决定该字段），不钉"看起来对"；
// 模型面一律 PONOS_MOCK_API=1（无网）。
// ★ 引擎直调级（E1/E2）的动态 import 必须在 env 设置**之后**：engine-config 在 import 期
//   读一遍 env（REPEAT_REMIND/MAX_ITER 是导入期常量），静态 import 会被提升到 env 赋值之前。
//   ★ 约束覆盖**整条可达链**，不只看直接 import：readonly.mjs →（trace-project → gen-guards）
//   → engine-config——静态 import readonly 同样会把常量冻结成默认值（MAX_TOOL_ITERATIONS=0
//   不限 / REPEAT_REMIND=[3,5]）⇒ mock 循环永不收敛，E1 表现为 100s+ 挂起而非失败
//   （2026-10-09 实测；护栏 = E1 开头的 engine-config 断言）。故 readonly 与 engine 同待遇。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_REPEAT_REMIND = '1' // 重复提醒阈值 [1]：同工具第 1 次重复即自愈注入
process.env.PONOS_LOOP_MAX_ITERATIONS = '6' // 迭代硬上限：mock 循环 6 步内收敛（测试要快）
const { createEngine } = await import('../kernel/engine.mjs')
const { getInjectStats, resetInjectStats } = await import('../kernel/knowledge-inject.mjs')
const { parseWindowDays, runEvolutionReport } = await import('../kernel/readonly.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionStore } from '../kernel/session.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')
// 与 session.mjs#sanitizeSegment 同算法：非字母数字 → '-'（转录目录名）
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9]/g, '-')
const readEntries = (file) => {
  try {
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
const metasOf = (entries, kind) => entries.filter((e) => e?.type === 'meta' && e.kind === kind)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  return null
}

// ── 引擎直调夹具（agent-orchestration.test.mjs:29 样式）─────────────────────────
function makeEngineEnv(prefix, sessionId) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const wire = {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {},
    taskStarted: () => {}, taskResumed: () => {}, taskNotification: () => {},
  }
  const session = createSessionStore({ configDir: dir, cwd: dir, sessionId })
  const engine = createEngine({
    opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '', configDir: dir },
    wire, session,
  })
  return { engine, session, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── E1 guard 台账接线（D3）────────────────────────────────────────────────────

test('guard 台账（D3）：loop-core 自愈经唯一出口 pushInjection ⇒ guard 渠道非零且注入落转录', async () => {
  process.env.PONOS_MOCK_LOOP = 'ok' // 每次请求恒产同一 Bash ⇒ 触发 repeatReminder（REPEAT_REMIND=1）
  // 前置护栏（见文件头）：engine-config 是导入期常量。env 若在它首次求值后才设置，值冻结成默认
  // （MAX=0 不限）⇒ runTurn 永不收敛 → 100s+ 挂起（不是干净失败）。此断言把静默挂起变成秒级
  // 显式失败，失败信息直接指向病灶（import 顺序），不再靠考古。
  const cfg = await import('../kernel/engine-config.mjs')
  assert.equal(cfg.MAX_TOOL_ITERATIONS, 6, 'env 须在 engine-config 首次求值前设置（import 顺序陷阱，见文件头注释）')
  assert.deepEqual(cfg.REPEAT_REMIND_AT, [1], 'env 须在 engine-config 首次求值前设置（import 顺序陷阱，见文件头注释）')
  const env = makeEngineEnv('evo-ledger-', 'evo-ledger-session')
  try {
    resetInjectStats()
    assert.equal(getInjectStats().channels.guard.calls, 0, '前置负控：清零后 guard 渠道为 0')
    await env.engine.runTurn({ content: '[mock:loop]' })
    const g = getInjectStats().channels.guard
    assert.ok(g.calls >= 1, `guard 渠道 calls 应 ≥1（自愈注入经 pushInjection 记账），实际 ${g.calls}`)
    assert.ok(g.hits >= 1, 'hits 应计（persist:true 注入）')
    assert.ok(g.injectedBytes >= 1, 'injectedBytes 应记真实注入字节')
    const text = readFileSync(env.session.file, 'utf-8')
    assert.ok(text.includes('次调用同一工具'), '自愈注入必须落转录（persist 分支与记账同一处）')
  } finally {
    delete process.env.PONOS_MOCK_LOOP
    env.cleanup()
  }
})

// ── E2 P-d 血缘埋点 ───────────────────────────────────────────────────────────

test('P-d：spawnSubAgent 在 lane 转录落 subtask_meta（与内存 lineage 同源）；主转录不写', async () => {
  const env = makeEngineEnv('evo-pd-', 'evo-pd-session')
  try {
    env.session.appendUser('主任务背景（让主转录文件存在）')
    const r = await env.engine.spawnSubAgent({ subagent_type: 'general-purpose', prompt: '血缘埋点子任务' }, { toolUseId: 't-pd' })
    assert.ok(String(r.content).includes('执行完成'), '前台子任务应完成')
    const projectsDir = join(env.dir, 'projects', sanitize(env.dir))
    const lanes = readdirSync(projectsDir).filter((f) => f.endsWith('.jsonl') && f !== 'evo-pd-session.jsonl')
    assert.equal(lanes.length, 1, '应恰好一个 lane 转录')
    const taskId = lanes[0].slice(0, -'.jsonl'.length)
    const lane = readEntries(join(projectsDir, lanes[0]))
    const meta = lane.find((e) => e?.type === 'meta' && e.kind === 'subtask_meta')
    assert.ok(meta, 'lane 转录应有 subtask_meta（P-d 写点）')
    assert.deepEqual(
      { parentTaskId: meta.parentTaskId, depth: meta.depth, path: meta.path },
      { parentTaskId: null, depth: 0, path: [taskId] },
      '血缘字段须与内存 lineage 同源（主派发 depth 0 / parent null / path=[taskId]）',
    )
    const metaAt = lane.findIndex((e) => e?.type === 'meta' && e.kind === 'subtask_meta')
    const firstTalk = lane.findIndex((e) => e?.type === 'user' || e?.type === 'assistant')
    assert.ok(firstTalk === -1 || metaAt < firstTalk, 'subtask_meta 须在开跑前落盘（先于任何对话条目）')
    const main = readFileSync(join(projectsDir, 'evo-pd-session.jsonl'), 'utf-8')
    assert.ok(!main.includes('subtask_meta'), '主转录不得有 subtask_meta（血缘只属 lane）')
  } finally { env.cleanup() }
})

// ── T3：--evolution-report 共享实现（readonly.mjs）────────────────────────────

test('parseWindowDays（D7 白名单）：<N>d 合法；非法/0/空/无 d 一律回默认（不倒挂窗口）', () => {
  assert.equal(parseWindowDays('30d'), 30)
  assert.equal(parseWindowDays('7d'), 7)
  assert.equal(parseWindowDays('365d'), 365)
  assert.equal(parseWindowDays('0d'), 30, '0 天 = 倒挂窗口 ⇒ 回默认')
  assert.equal(parseWindowDays('9999d'), 30, '超 3 位数字不合法')
  assert.equal(parseWindowDays('30'), 30, '缺 d 后缀不合法')
  assert.equal(parseWindowDays(''), 30)
  assert.equal(parseWindowDays(null), 30)
  assert.equal(parseWindowDays('30h'), 30)
})

test('runEvolutionReport：闭区间窗口（from 缺省 = to−(days−1)）；投影产物形状齐', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-rep-'))
  try {
    const cwd = join(dir, 'proj')
    mkdirSync(cwd, { recursive: true })
    const projDir = join(dir, 'home', 'projects', sanitize(cwd))
    mkdirSync(projDir, { recursive: true })
    const at = (d) => `2026-09-${d}T00:00:00.000Z`
    writeFileSync(join(projDir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', seq: 1, timestamp: at('05'), message: { role: 'user', content: '问' } }),
      JSON.stringify({ type: 'assistant', seq: 2, timestamp: at('05'), message: { role: 'assistant', content: [{ type: 'text', text: '答' }], model: 'm' } }),
    ].join('\n') + '\n')
    const rep = runEvolutionReport({ configDir: join(dir, 'home'), from: '2026-09-01', to: '2026-09-30', now: '2026-09-30T12:00:00.000Z' })
    assert.deepEqual(rep.window, { from: '2026-09-01', to: '2026-09-30', days: 30 })
    assert.equal(rep.summary.totals.sessions, 1)
    assert.equal(rep.records[0].outcome, 'ok')
    // from 缺省：30d 窗口 = [now−29, now]（对 2026-10-09 即 09-10..10-09，与真机首份报告同口径）
    const rep2 = runEvolutionReport({ configDir: join(dir, 'home'), windowDays: 30, now: '2026-10-09T00:00:00.000Z' })
    assert.deepEqual(rep2.window, { from: '2026-09-10', to: '2026-10-09', days: 30 })
    assert.equal(rep2.summary.totals.sessions, 0, '窗口外会话不入选（无数据 = 精确 0）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── cli 短跑驱动（approval-mode-cli.test.mjs:41 样式）──────────────────────────
function spawnCli({ home, workDir, args = [], env = {} }) {
  const e = { ...process.env, PONOS_MOCK_API: '1' }
  // 剥宿主残留：场景 env 显式声明才生效（防本文件顶部的引擎级常量泄进子进程改变场景语义）
  for (const k of ['PONOS_HOME', 'PONOS_MOCK_LOOP', 'PONOS_MOCK_SYS_PROBE', 'PONOS_APPROVAL_TIMEOUT_MS',
    'PONOS_LOOP_MAX_ITERATIONS', 'PONOS_LOOP_REPEAT_REMIND']) delete e[k]
  e.PONOS_CONFIG_DIR = home
  Object.assign(e, env)
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--permission-prompt-tool', 'stdio', '--add-dir', workDir, ...args,
  ], { cwd: workDir, env: e, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  const waiters = new Set()
  const frameHandlers = []
  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m = null
      try { m = JSON.parse(line) } catch { continue }
      events.push(m)
      for (const h of frameHandlers) { try { h(m) } catch { /* 处理器异常不影响收集 */ } }
      for (const w of [...waiters]) w()
    }
  })
  const collect = (pred, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiters.delete(scan); reject(new Error(`collect timeout; events=${JSON.stringify(events.slice(0, 6))}`)) }, timeoutMs)
    const scan = () => {
      const i = events.findIndex(pred)
      if (i >= 0) { waiters.delete(scan); clearTimeout(t); resolve(events.splice(i, 1)[0]) }
    }
    waiters.add(scan)
    scan()
  })
  const send = (obj) => new Promise((res) => proc.stdin.write(JSON.stringify(obj) + '\n', res))
  const onFrame = (h) => { frameHandlers.push(h) }
  const stop = async () => {
    try { if (!proc.stdin.writableEnded) proc.stdin.end() } catch { /* ignore */ }
    await new Promise((res) => { const t = setTimeout(() => { try { proc.kill() } catch {} ; res() }, 5000); proc.once('exit', () => { clearTimeout(t); res() }) })
  }
  return { proc, collect, send, onFrame, stop }
}

async function withCliHome(prefix, args, env, fn) {
  const home = mkdtempSync(join(tmpdir(), prefix + '-home-'))
  const workDir = mkdtempSync(join(tmpdir(), prefix + '-work-'))
  const k = spawnCli({ home, workDir, args, env })
  try { return await fn(k, { home, workDir }) }
  finally { await k.stop(); rmSync(workDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
}

const singleTranscript = (home, workDir) => {
  const projectsDir = join(home, 'projects', sanitize(workDir))
  const files = readdirSync(projectsDir).filter((f) => f.endsWith('.jsonl'))
  assert.equal(files.length, 1, '单会话应恰一个转录文件')
  return join(projectsDir, files[0])
}

// ── P-a（cli 端到端）：两轮两记 + 端到端台账 ──────────────────────────────────

test('P-a（cli 短跑）：两轮两记 guard_turn（turnIndex 递增去重）；inject_snapshot.channels.guard 非零', async () => {
  await withCliHome('evo-pa', ['--approval-mode', 'bypass'],
    { PONOS_MOCK_LOOP: 'ok', PONOS_LOOP_REPEAT_REMIND: '1', PONOS_LOOP_MAX_ITERATIONS: '6' },
    async (k, { home, workDir }) => {
      await k.collect((m) => m.type === 'system' && m.subtype === 'init')
      await k.send({ type: 'user', message: { role: 'user', content: '第一轮' } })
      await k.collect((m) => m.type === 'result')
      await k.send({ type: 'user', message: { role: 'user', content: '第二轮' } })
      await k.collect((m) => m.type === 'result')
      // ★ result 帧先于轮末记账块（inject_snapshot/guard_turn）发出 ⇒ 轮询等落盘（序无关、非放宽：
      //   计数断言不降，只是容忍写序）
      const transcript = singleTranscript(home, workDir)
      const entries = await waitFor(() => {
        const e = readEntries(transcript)
        return metasOf(e, 'guard_turn').length >= 2 ? e : null
      })
      assert.ok(entries, '两轮 guard_turn 应在限时内落盘')
      const snaps = metasOf(entries, 'inject_snapshot')
      const guards = metasOf(entries, 'guard_turn')
      assert.equal(snaps.length, 2, '两轮两记 inject_snapshot')
      assert.equal(guards.length, 2, '两轮两记 guard_turn（P-a 写点与 inject_snapshot 同点）')
      assert.deepEqual(guards.map((g) => g.turnIndex), [1, 2], 'turnIndex = 已完成轮数，递增且不重记')
      assert.ok(guards.every((g) => g.level === 'L1'),
        'repeatReminder 命中 ⇒ 阶梯最高 L1（level 取 ladder.highest，heal-ladder 单一真源）')
      const withGuard = snaps.filter((s) => Number(s.channels?.guard?.calls || 0) > 0 && Number(s.channels?.guard?.injectedBytes || 0) > 0)
      assert.equal(withGuard.length, 2, '每轮 inject_snapshot 的 channels.guard 均非零（端到端台账：注入经唯一出口）')
    })
})

// ── P-b（cli 端到端）：审批决策逐条落转录 ─────────────────────────────────────

test('P-b（cli 短跑）：control_response allow/deny 一答一记 approval_decision（字面精确）', async () => {
  const answered = []
  await withCliHome('evo-pb', ['--approval-mode', 'manual'],
    { PONOS_MOCK_LOOP: 'ok', PONOS_LOOP_MAX_ITERATIONS: '6' },
    async (k, { home, workDir }) => {
      // 事件驱动应答：第 1 次 allow，其后 deny（走真实 control_response 通道，非直调 resolveApproval）
      k.onFrame((m) => {
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          const toolUseId = m.request.tool_use_id
          answered.push(toolUseId)
          const behavior = answered.length === 1 ? 'allow' : 'deny'
          k.send({ type: 'control_response', response: { response: { toolUseID: toolUseId, behavior } } })
        }
      })
      await k.collect((m) => m.type === 'system' && m.subtype === 'init')
      await k.send({ type: 'user', message: { role: 'user', content: '需要审批' } })
      await k.collect((m) => m.type === 'result')
      assert.ok(answered.length >= 2, `应至少两次审批询问（allow+deny），实际 ${answered.length}`)
      const transcript = singleTranscript(home, workDir)
      const appros = await waitFor(() => {
        const a = metasOf(readEntries(transcript), 'approval_decision')
        return a.length >= answered.length ? a : null
      })
      assert.ok(appros, '审批应答应在限时内逐条落盘')
      assert.deepEqual(appros.map((a) => a.toolUseId), answered, '一答一记：每个被应答的 toolUseId 恰一条（含顺序）')
      assert.equal(appros[0].behavior, 'allow', '首答 allow 字面落记')
      assert.ok(appros.slice(1).every((a) => a.behavior === 'deny'), '其余应答按 deny 字面落记')
      assert.ok(appros.every((a) => a.behavior === 'allow' || a.behavior === 'deny'),
        'D1 边界：timeout/cancel 不经本写点 ⇒ 只可能落 allow/deny')
    })
})

// ── P-c（cli 端到端）：技能命中埋点（缺失场景不写）────────────────────────────

test('P-c（cli 短跑）：技能触发词命中 ⇒ skill_trigger_hit + guard 渠道；未命中不写', async () => {
  const skillsDir = mkdtempSync(join(tmpdir(), 'evo-pc-skills-'))
  writeFileSync(join(skillsDir, 'evo-skill.md'),
    '---\nname: EvoSkill\ndescription: 演化测试技能\ntriggers: 演化触发词\n---\n正文（测试用，不加载）\n')
  try {
    await withCliHome('evo-pc', ['--skills-dir', skillsDir], {},
      async (k, { home, workDir }) => {
        await k.collect((m) => m.type === 'system' && m.subtype === 'init')
        await k.send({ type: 'user', message: { role: 'user', content: '请用演化触发词试试' } })
        await k.collect((m) => m.type === 'result')
        await k.send({ type: 'user', message: { role: 'user', content: '普通消息' } })
        await k.collect((m) => m.type === 'result')
        const entries = readEntries(singleTranscript(home, workDir))
        const hits = metasOf(entries, 'skill_trigger_hit')
        assert.equal(hits.length, 1, '恰一条命中埋点（第二条消息未命中不得写）')
        assert.equal(hits[0].id, 'evo-skill', 'id 取技能 id（前端技能根口径）')
        const snaps = metasOf(entries, 'inject_snapshot')
        assert.ok(Number(snaps[0]?.channels?.guard?.calls || 0) >= 1,
          'P-c 命中同时记 guard 渠道（引擎发起的单行提示；首轮快照应可见）')
      })
  } finally { rmSync(skillsDir, { recursive: true, force: true }) }
})
