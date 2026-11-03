// SESS-08 修复验证（P1）：后台子代理任务登记在**进程内 Map**，内核一退即不可达。
//
// 【缺陷】`kernel/engine.mjs` 的 `pendingSubAgents` 是进程内 Map：
//   内核一退（崩溃 / 被 kill / 重启），子代理任务就从世界上消失了 —— 既查不到、也无法续跑。
//   而子代理的**会话文件（lane transcript）其实还在磁盘上**（`createSessionStore` 按 taskId 落盘）
//   ⇒ 缺的只是"索引"：没人记得有哪些任务在跑、对应哪个 lane 文件。
//
// 【修法（用户拍板：自动拉起 + 并发上限）】
//   ① `shared/subagent-registry.cjs`：把任务登记落成 `subagents/registry.json`
//      （原子写、损坏容错、五态 status）
//   ② engine 在派发/完成/失败时维护登记
//   ③ 启动时 `claimInterruptedTasks()` 认领上次遗留的任务并**自动拉起**：
//      · 受 `LANE_MAX_CONCURRENT` 约束（复用既有并发槽，不新造一套）
//      · **attempts 上限**：达上限的任务标 failed，不再拉起 —— 否则"崩溃→拉起→再崩溃"
//        会被无限放大（这是自动拉起最危险的失败模式）
//      · 拉起前先把 running/queued 改写为 interrupted（再崩时 attempts 已累积）
//
// 【必须说清的风险（已写进注释）】自动拉起是**重新提交同一任务**，不是恢复执行现场。
//   子代理若在崩溃前已产生副作用（写了文件、发了请求），重跑会**再来一次**。
//   ⇒ 故 attempts 默认只 1 次；且登记里保留 prompt/cwd 供用户核对"它当时在做什么"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REG = require('../shared/subagent-registry.cjs')
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const RESUME = readFileSync(new URL('../kernel/subagent-resume.mjs', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const STORE_CLI = readFileSync(new URL('../kernel/cli.mjs', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const ENGINE = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// 每次用独立临时目录，避免互相污染
const { mkdtempSync, rmSync, writeFileSync, readFileSync: rf, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const mkHome = () => mkdtempSync(join(tmpdir(), 'ponos-sess08-'))

test('★ SESS-08：登记必须落盘（原子写），且五态合法', () => {
  const home = mkHome()
  try {
    assert.equal(REG.upsertTask(home, 't1', { agentId: 'a', prompt: 'p', status: 'running' }), true)
    const p = REG.registryPath(home)
    assert.ok(existsSync(p), '登记必须真的写进 registry.json')
    const { tasks } = REG.readRegistry(home)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].status, 'running')
    assert.deepEqual([...REG.STATUSES].sort(),
      ['done', 'failed', 'interrupted', 'queued', 'running'], '状态集合必须恰是这五态')
    // 非法状态被规整（脏数据不能永久污染索引）
    REG.upsertTask(home, 't2', { status: 'weird-status' })
    assert.equal(REG.readRegistry(home).tasks.find((t) => t.taskId === 't2').status, 'interrupted')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('★ SESS-08：索引损坏不得抛异常（宁可丢恢复机会，不能让内核起不来）', () => {
  const home = mkHome()
  try {
    const p = REG.registryPath(home)
    require('node:fs').mkdirSync(require('node:path').dirname(p), { recursive: true })
    writeFileSync(p, '{ this is not json', 'utf-8')
    const r = REG.readRegistry(home)   // 不得 throw
    assert.deepEqual(r.tasks, [])
    // ★ 存储形态已改为**追加式 JSONL**（避开 Windows 上 rename 独占与读-改-写竞态），
    //   故"坏行"的处置从"整文件报废（corrupted）"升级为**逐行跳过**（badLines）——
    //   这比原期望更好：一行坏了不该让**其它任务**也恢复不了。
    //   断言保留原意（不抛 + 读不出任务），并额外要求"能报出坏了多少行"。
    assert.equal(r.badLines, 1, `坏行应被计数（实得 ${JSON.stringify(r)}），而不是抛异常或整文件报废`)
    assert.ok(!r.corrupted, '单行损坏不应把整个文件判为 corrupted —— 其余任务仍应可恢复')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('★ SESS-08：部分行损坏时，**好行仍必须能读出来**（JSONL 的核心好处）', () => {
  const home = mkHome()
  try {
    REG.upsertTask(home, 'good', { status: 'running' })
    const p = REG.registryPath(home)
    require('node:fs').appendFileSync(p, 'BROKEN LINE\n', 'utf-8')
    REG.upsertTask(home, 'also-good', { status: 'queued' })
    const r = REG.readRegistry(home)
    assert.equal(r.tasks.length, 2,
      '两行好记录必须仍能读出 —— 这是"追加式 JSONL 优于整文件 JSON"的关键点'
      + '（一行坏了不该让所有任务都恢复不了）')
    assert.equal(r.badLines, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('★ SESS-08：启动时必须认领上次遗留的 running/queued 并转为 interrupted', () => {
  const home = mkHome()
  try {
    REG.upsertTask(home, 'r1', { status: 'running', prompt: 'p1' })
    REG.upsertTask(home, 'q1', { status: 'queued', prompt: 'p2' })
    REG.upsertTask(home, 'd1', { status: 'done', prompt: 'p3' })
    const claimed = REG.claimInterruptedTasks(home, { maxAttempts: 1 })
    assert.equal(claimed.length, 2, 'running 与 queued 都应被认领（done 不应）')
    assert.ok(claimed.every((t) => t.attempts === 1), '认领时 attempts 自增')
    const after = REG.readRegistry(home).tasks
    assert.equal(after.find((t) => t.taskId === 'r1').status, 'interrupted')
    assert.equal(after.find((t) => t.taskId === 'd1').status, 'done', 'done 不得被改')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('★ SESS-08：达 attempts 上限必须标 failed 且不再拉起（防崩溃循环放大）', () => {
  const home = mkHome()
  try {
    // 模拟"上次已被拉起过 1 次，这次又崩了" ⇒ attempts 已为 1
    REG.upsertTask(home, 'x1', { status: 'running', attempts: 1 })
    const claimed = REG.claimInterruptedTasks(home, { maxAttempts: 1 })
    assert.equal(claimed.length, 0, '达上限不得再认领（否则崩溃→拉起→再崩溃无限放大）')
    const t = REG.readRegistry(home).tasks.find((x) => x.taskId === 'x1')
    assert.equal(t.status, 'failed')
    assert.match(String(t.failureReason), /max-resume-attempts/,
      '必须留下"为什么不再拉起"的原因，便于用户排查')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('★ SESS-08：登记与恢复**都在 engine 之外**（热路径不得加 IO —— 这条返工过一次）', () => {
  // ★ 第一版把登记直接写进 engine 的派发/终态热路径，实测让 subagent.test.mjs 的
  //   「主 cancel」用例在 Windows 上**稳定 EPERM**（多出的磁盘 IO 改变了 cleanup 与子代理收尾
  //   的相对时序；改 setImmediate 也仍回归，因为调度本身已进事件循环）。
  //   还原 engine 后 20/20 ⇒ 结论：**热路径上不要加任何 IO 或额外调度**。
  //   ⇒ 断言方向反过来了：engine 里**不应有** upsertTask，落盘/恢复都在 kernel/subagent-resume.mjs。
  assert.ok(!/upsertTask\(/.test(ENGINE),
    'engine 热路径上不得出现 upsertTask —— 那会引入 Windows 句柄时序回归'
    + '（subagent.test.mjs 的 cancel 用例稳定 EPERM）')

  const cli = STORE_CLI
  assert.match(cli, /subagent-resume\.mjs/,
    'CLI 必须引入 subagent-resume.mjs（落盘与恢复的唯一入口）')
  assert.match(cli, /snapshotActiveSubAgents\(/,
    'CLI 必须做快照落盘（周期 + 退出），否则崩溃时索引为空、无从恢复')
  assert.match(cli, /resumeOrphanedSubAgents\(/,
    'CLI 必须在启动时恢复遗留任务')
})

test('★ SESS-08：恢复必须受并发上限约束，且开关可关', () => {
  assert.match(RESUME, /maxConcurrent/,
    '恢复必须受并发上限约束（复用 engine 的 LANE_MAX_CONCURRENT，不新造一套）')
  assert.match(RESUME, /PONOS_SUBAGENT_AUTO_RESUME/,
    '必须有开关 —— 自动重新执行可能在崩溃前已产生副作用，用户要能关掉')
  assert.match(RESUME, /resume_task_id/,
    '恢复必须走 resume 分支（复用同一 lane + 追加续跑指令），不得重发完整 prompt')
})

test('★ SESS-08：engine 只暴露**纯读**快照（不得有副作用）', () => {
  const i = ENGINE.indexOf('snapshotActiveSubAgents')
  assert.ok(i > -1, 'engine 必须导出 snapshotActiveSubAgents（供 CLI 取快照）')
  const block = ENGINE.slice(Math.max(0, i - 800), i + 1200)
  // 纯读：不得出现写文件 / appendFile / upsertTask 等
  for (const bad of ['appendFileSync', 'writeFileSync', 'upsertTask(', 'renameSync']) {
    assert.ok(!block.includes(bad),
      `engine 的快照路径不得出现 ${bad} —— 快照必须是纯读（见本文件第一条测试的返工记录）`)
  }
})
