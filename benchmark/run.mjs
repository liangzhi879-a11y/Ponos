#!/usr/bin/env node
// YFW-turbo 内核横向评估平台 —— 评测主入口
// ---------------------------------------------------------------------------
// 用法：
//   node benchmark/run.mjs                    # 全量：4 agents × 全部任务
//   node benchmark/run.mjs --agents yfw,claude # 指定被测对象
//   node benchmark/run.mjs --tasks T001,T003   # 指定任务
//   node benchmark/run.mjs --limit 1           # 每 agent 只跑前 N 个任务（冒烟）
//   node benchmark/run.mjs --smoke             # 冒烟：每 agent 1 个任务验证链路
// 输出：results/<timestamp>/（每 agent×task 一条 JSON + summary.json + 日志）
// 报告：node benchmark/report.mjs results/<timestamp>
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFIG } from './config.mjs'
import { ensureWorkspace, collectDiff } from './lib/workspace.mjs'
import { applyBasePatch, EXCLUDED_PATCH_FILES } from './lib/base-patches.mjs'
import { runYFW } from './harness/yfw.mjs'
import { runClaude, runPi, runDeepseek } from './harness/adapters.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = CONFIG.root

// ── 参数解析 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function argVal(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const agents = (argVal('--agents') || CONFIG.agents.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
const tasksFilter = argVal('--tasks')?.split(',').map((s) => s.trim()).filter(Boolean) || null
const limit = argVal('--limit') ? Number(argVal('--limit')) : CONFIG.maxTasksPerAgent
const smoke = argv.includes('--smoke')
// dashboard 控制文件：JSON { cmd: 'pause'|'resume'|'abort', by }。任务边界检查，
// 收到 pause 阻塞等待、abort 抛出中断（评测由 dashboard 子进程拉起时使用）
const controlFile = argVal('--control-file')

// ── 控制检查点（任务之间）────────────────────────────────────────────────────
// 在单个任务开始前调用：pause 时循环等待（不打断正在跑的任务），abort 抛错。
// control 文件由 dashboard 写入 { cmd }，run 侧只在读到非 pause/abort 时放行。
async function checkControl(label) {
  if (!controlFile) return
  for (;;) {
    let cmd = null
    try {
      cmd = JSON.parse(readFileSync(controlFile, 'utf8')).cmd
    } catch { /* 文件不存在/损坏 → 放行 */ }
    if (cmd === 'abort') {
      throw new Error(`[control] ${label} 收到 abort，评测中断`)
    }
    if (cmd === 'pause') {
      console.log(`[control] ${label} 暂停中（等待 dashboard 继续/终止）...`)
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    return
  }
}

// ── 任务集加载 ────────────────────────────────────────────────────────────────
function loadTasks() {
  const tasksDir = join(root, 'tasks')
  const tasks = []
  for (const name of readdirSync(tasksDir).sort()) {
    const dir = join(tasksDir, name)
    const metaFile = join(dir, 'task.json')
    if (!existsSync(metaFile)) continue
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
    const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8')
    const verifyFile = join(dir, 'verify.mjs')
    if (!existsSync(verifyFile)) throw new Error(`task ${meta.id}: verify.mjs missing`)
    tasks.push({ ...meta, dir, prompt, verifyFile, name })
  }
  return tasks
}

// ── agent 调度表（内核完善后在此注册新适配器）──────────────────────────────
const AGENT_RUNNERS = {
  yfw: runYFW,
  claude: runClaude,
  pi: runPi,
  deepseek: runDeepseek,
}

// ── 单任务执行 ────────────────────────────────────────────────────────────────
async function runOne({ agent, task, ts, onLog }) {
  const branch = `bench-${agent}-${task.id}`
  const wsRoot = join(root, CONFIG.dirs.workspace)
  mkdirSync(wsRoot, { recursive: true })

  // 1. 隔离工作区（git worktree，checkout 到任务 base commit）
  let ws
  try {
    ws = ensureWorkspace({ repo: CONFIG.repo, wsRoot, branch, base: task.base })
  } catch (e) {
    return { agent, task: task.id, status: 'workspace-error', error: String(e) }
  }

  // 2. yfw 专属：任务 base 的历史内核兼容补丁（如 T001/T002 工具透传缺陷），
  //    运行前应用，不影响 agent 改动统计（diff 中排除，basePatched 单独记录）
  const basePatched = agent === 'yfw' ? applyBasePatch(task.id, ws) : null

  // 3. 跑 agent（同一提示词）
  const runner = AGENT_RUNNERS[agent]
  const started = Date.now()
  let run
  try {
    run = await runner({ ws, prompt: task.prompt, timeoutMs: CONFIG.timeoutMs, onLog })
  } catch (e) {
    run = { exitCode: -9, stdout: '', stderr: String(e), usage: null, toolCalls: 0, timedOut: false }
  }
  const durationMs = Date.now() - started

  // 4. 运行验收脚本（verify.mjs <ws>）
  const verify = await verifyTask(task, ws, onLog)

  // 5. 采集改动（仅排除纯环境补丁文件 engine.mjs/permissions.mjs；
  //    api.mjs 虽也打补丁但可能是任务合法目标，必须计入 agent 改动）
  const diff = collectDiff(CONFIG.repo, ws, basePatched ? EXCLUDED_PATCH_FILES : [])

  // 5. 指标汇总
  const cost = costOf(run.usage)
  const selfTested = /(node --test|npm test|run test|verify)/i.test(run.stdout + '\n' + run.stderr)

  return {
    agent, task: task.id, base: task.base,
    status: verify.ok ? 'pass' : 'fail',
    durationMs,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    usage: run.usage,
    toolCalls: run.toolCalls,
    cost,
    selfTested,
    basePatched,
    verify: { ok: verify.ok, stdout: verify.stdout.slice(0, 2000), stderr: verify.stderr.slice(0, 2000) },
    diff: { stat: diff.stat.slice(0, 2000), nameStatus: diff.nameStatus.slice(0, 2000), untracked: diff.untracked.slice(0, 1000) },
    stdoutTail: run.stdout.slice(-3000),
    stderrTail: run.stderr.slice(-1500),
  }
}

/** 在任务工作区上运行验收脚本 */
async function verifyTask(task, ws, onLog) {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(process.execPath, [task.verifyFile, ws], { cwd: ws, timeout: 120000, env: process.env },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || '', stderr: (stderr || '') + (err ? '\nEXIT:' + err.code : '') })
      })
  })
}

function costOf(usage) {
  if (!usage) return null
  const p = CONFIG.pricePerMInput, o = CONFIG.pricePerMOutput
  return (usage.input_tokens || 0) / 1e6 * p + (usage.output_tokens || 0) / 1e6 * o
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  const tasks = loadTasks()
  const picked = tasksFilter
    ? tasks.filter((t) => tasksFilter.includes(t.id))
    : tasks
  if (smoke) {
    // 冒烟：每 agent 只跑第一个任务（验证链路通）
    const first = picked[0]
    for (const agent of agents) {
      const resultsDir = join(root, CONFIG.dirs.results, `smoke-${Date.now()}`)
      mkdirSync(resultsDir, { recursive: true })
      const log = []
      const r = await runOne({ agent, task: first, ts: Date.now(), onLog: (k, l) => log.push(`[${k}] ${l}`) })
      r.log = log.join('\n').slice(-8000)
      writeFileSync(join(resultsDir, `${agent}-${first.id}.json`), JSON.stringify(r, null, 2))
      console.log(`[smoke] ${agent} × ${first.id}: ${r.status} (${r.durationMs}ms)`)
    }
    console.log('冒烟完成。结果见 benchmark/results/')
    return
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const resultsDir = join(root, CONFIG.dirs.results, ts)
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, 'meta.json'), JSON.stringify({
    ts, agents, tasks: picked.map((t) => t.id), model: CONFIG.model, repo: CONFIG.repo,
  }, null, 2))

  const summary = []
  // active.json 心跳：dashboard 据此显示"评测中 + 已耗时"（每任务开始写、结束删）
  const activeFile = join(resultsDir, 'active.json')
  const writeActive = (agent, task) => writeFileSync(activeFile, JSON.stringify({ agent, task, since: Date.now() }, null, 2))
  const clearActive = () => { try { rmSync(activeFile, { force: true }) } catch { /* 忽略 */ } }
  try {
    for (const agent of agents) {
      const tasksForAgent = limit ? picked.slice(0, limit) : picked
      for (const task of tasksForAgent) {
        const log = []
        const label = `${agent} × ${task.id}`
        await checkControl(label) // 控制检查点：pause 等待 / abort 中断
        console.log(`[run] ${label} ...`)
        writeActive(agent, task.id)
        const r = await runOne({ agent, task, ts, onLog: (k, l) => log.push(`[${k}] ${l}`) })
        r.log = log.join('\n').slice(-12000)
        writeFileSync(join(resultsDir, `${agent}-${task.id}.json`), JSON.stringify(r, null, 2))
        summary.push(r)
        console.log(`[run] ${label}: ${r.status} (${r.durationMs}ms)`)
      }
    }
  } finally {
    clearActive() // 评测结束（含异常中断）清理心跳
    // 中断（abort/异常）时也写部分 summary，便于 dashboard/report 读取已完成的轮次
    if (summary.length && !existsSync(join(resultsDir, 'summary.json'))) {
      writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2))
    }
  }
  writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(`\n评测完成：${summary.filter((s) => s.status === 'pass').length}/${summary.length} 通过`)
  console.log(`结果目录：benchmark/results/${ts}`)
  console.log('生成报告：node benchmark/report.mjs results/' + ts)
}

main().catch((e) => { console.error(e); process.exit(1) })
